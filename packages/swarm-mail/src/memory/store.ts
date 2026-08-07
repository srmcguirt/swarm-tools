/**
 * Memory Store - Drizzle-based memory operations
 *
 * Provides CRUD operations and semantic search for memories using Drizzle ORM.
 * Replaces raw SQL adapter detection with Drizzle's unified query interface.
 *
 * ## Design Pattern
 * - Uses Drizzle query builder for all operations (except vector search)
 * - Vector similarity search uses sql`` template for vector_distance_cos()
 * - No adapter type detection needed - Drizzle handles PGlite/libSQL differences
 *
 * ## Key Operations
 * - store: Insert or update memory with embedding (UPSERT via onConflictDoUpdate)
 * - search: Vector similarity search with threshold/limit/collection filters
 * - ftsSearch: Full-text search (uses raw SQL - FTS5 not yet in Drizzle)
 * - list: List all memories, optionally filtered by collection
 * - get: Retrieve single memory by ID
 * - delete: Remove memory and its embedding
 * - getStats: Memory and embedding counts
 *
 * ## Migration Notes
 * - Removed detectAdapterType() - Drizzle abstracts this
 * - Removed PGlite-specific code (separate memory_embeddings table)
 * - libSQL schema has embedding inline in memories table
 * - JSON columns (metadata, tags) stored as TEXT, need JSON.parse/stringify
 * - Timestamps are TEXT (ISO strings)
 */

import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { SwarmDb } from "../db/client.js";
import { memories } from "../db/schema/memory.js";
import { EMBEDDING_DIM } from "./ollama.js";
import type { MemoryScope } from "./scope.js";

/**
 * Cache of whether a given db instance's `memories` table has the
 * repo_key/package_key scope columns. Avoids checking on every store()
 * call while still working correctly against test fixtures that
 * hand-roll a pre-scoping `memories` table (no columns).
 */
const scopeColumnsCache = new WeakMap<SwarmDb, boolean>();

async function hasScopeColumns(db: SwarmDb): Promise<boolean> {
  const cached = scopeColumnsCache.get(db);
  if (cached !== undefined) return cached;

  let result = false;
  try {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('memories')`,
    );
    const names = new Set(rows.map((r) => r.name));
    result = names.has("repo_key") && names.has("package_key");
  } catch {
    result = false;
  }

  scopeColumnsCache.set(db, result);
  return result;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Embedding dimension for configured Ollama model.
 * Auto-detected from OLLAMA_MODEL env var or defaults to 1024 (mxbai-embed-large).
 * Can be overridden via OLLAMA_EMBED_DIM env var.
 */
export { EMBEDDING_DIM };

/** Memory data structure */
export interface Memory {
  readonly id: string;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly collection: string;
  readonly createdAt: Date;
  /** Confidence level (0.0-1.0) affecting decay rate. Higher = slower decay. Default 0.7 */
  readonly confidence?: number;
  /** Repo scope key (see memory/scope.ts). Undefined = not written (legacy schema); null = global. */
  readonly repoKey?: string | null;
  /** Package scope key, repo-relative (see memory/scope.ts). Undefined = not written; null = repo-level/global. */
  readonly packageKey?: string | null;
}

/** Search result with similarity score */
export interface SearchResult {
  readonly memory: Memory;
  readonly score: number;
  readonly matchType: "vector" | "fts";
}

/** Search options for queries */
export interface SearchOptions {
  readonly limit?: number;
  readonly threshold?: number;
  readonly collection?: string;
  /** Track access for returned memories (updates last_accessed, increments access_count) */
  readonly trackAccess?: boolean;
  /** Filter by decay tier: 'hot' (7d), 'warm' (30d), 'all' (default) */
  readonly decayTier?: "hot" | "warm" | "all";
  /**
   * Restrict results to package ∪ repo ∪ global for this scope. Omitted
   * (default): no scope filtering - matches pre-scoping behavior exactly.
   */
  readonly scope?: MemoryScope;
}

/** Decay tier thresholds (in days) */
const DECAY_TIERS = {
  hot: 7, // Accessed in last 7 days
  warm: 30, // Accessed in last 30 days
  cold: 90, // Accessed more than 30 days ago
} as const;

/** Calculate decay tier based on last_accessed and access_count */
export function getDecayTier(
  lastAccessed: Date | null,
  accessCount: number,
): "hot" | "warm" | "cold" {
  if (!lastAccessed) return "cold";

  const now = new Date();
  const daysSinceAccess =
    (now.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24);

  // High frequency (10+ accesses) resists decay - add 7 days buffer
  const frequencyBonus = accessCount >= 10 ? 7 : accessCount >= 5 ? 3 : 0;
  const effectiveDays = daysSinceAccess - frequencyBonus;

  if (effectiveDays <= DECAY_TIERS.hot) return "hot";
  if (effectiveDays <= DECAY_TIERS.warm) return "warm";
  return "cold";
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a memory store using Drizzle ORM
 *
 * Uses Drizzle query builder for all operations except vector search
 * (vector_distance_cos requires raw SQL template).
 *
 * @param db - Drizzle database instance (libSQL)
 * @returns Memory store operations
 *
 * @example
 * ```typescript
 * import { createInMemoryDb } from '../db/client.js';
 * const db = await createInMemoryDb();
 * const store = createMemoryStore(db);
 *
 * await store.store(memory, embedding);
 * const results = await store.search(queryEmbedding);
 * ```
 */
export function createMemoryStore(db: SwarmDb) {
  /**
   * Helper to parse memory row from database
   * Handles TEXT storage of JSON (metadata) and timestamps
   */
  const parseMemoryRow = (row: typeof memories.$inferSelect): Memory => {
    // libSQL stores metadata as TEXT (JSON string)
    const metadata =
      typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : (row.metadata ?? {});

    // Parse created_at, falling back to current time if null/undefined/invalid
    //  row.created_at can be: null, undefined, valid ISO string, or malformed string
    // Only use row.created_at if it's a non-empty string that creates a valid Date
    let createdAt: Date;
    if (row.created_at && typeof row.created_at === "string") {
      const parsed = new Date(row.created_at);
      createdAt = isNaN(parsed.getTime()) ? new Date() : parsed;
    } else {
      createdAt = new Date();
    }

    return {
      id: row.id,
      content: row.content,
      metadata,
      collection: row.collection ?? "default",
      createdAt,
      confidence: row.decay_factor ?? 0.7,
      repoKey: (row as { repo_key?: string | null }).repo_key ?? null,
      packageKey: (row as { package_key?: string | null }).package_key ?? null,
    };
  };

  return {
    /**
     * Store a memory with its embedding
     *
     * Uses Drizzle's onConflictDoUpdate for UPSERT behavior.
     * Vector embedding stored via sql`` template with vector() function.
     *
     * Note: Drizzle's insert builder always emits every column defined on
     * the `memories` schema (db/schema/memory.ts), regardless of which
     * keys are passed to `.values()` - so any physical table used with
     * this function must have repo_key/package_key. Test fixtures that
     * hand-roll a `memories` table must include them too (see
     * memory/libsql-schema.ts's createLibSQLMemorySchema for the
     * canonical column set).
     *
     * @param memory - Memory to store
     * @param embedding - 1024-dimensional vector
     * @throws Error if database operation fails
     */
    async store(memory: Memory, embedding: number[]): Promise<void> {
      const vectorStr = JSON.stringify(embedding);
      const scopeValues = {
        repo_key: memory.repoKey ?? null,
        package_key: memory.packageKey ?? null,
      };

      await db
        .insert(memories)
        .values({
          id: memory.id,
          content: memory.content,
          metadata: JSON.stringify(memory.metadata),
          collection: memory.collection,
          created_at: memory.createdAt.toISOString(),
          decay_factor: memory.confidence ?? 0.7,
          embedding: sql`vector(${vectorStr})`,
          ...scopeValues,
        })
        .onConflictDoUpdate({
          target: memories.id,
          set: {
            content: memory.content,
            metadata: JSON.stringify(memory.metadata),
            collection: memory.collection,
            decay_factor: memory.confidence ?? 0.7,
            embedding: sql`vector(${vectorStr})`,
            ...scopeValues,
          },
        });
    },

    /**
     * Vector similarity search
     *
     * Uses vector_top_k() function with libsql_vector_idx for efficient ANN search.
     * Returns results sorted by similarity (highest first).
     *
     * libSQL vector search requires:
     * 1. A vector index: CREATE INDEX ... ON table(libsql_vector_idx(column))
     * 2. Using vector_top_k() which returns a virtual table with just (id) - the rowid
     * 3. Joining the virtual table back to get full rows
     * 4. Calculating distance separately with vector_distance_cos()
     *
     * @param queryEmbedding - 1024-dimensional query vector
     * @param options - Search options (limit, threshold, collection, trackAccess, decayTier)
     * @returns Array of search results sorted by similarity (highest first)
     */
    async search(
      queryEmbedding: number[],
      options: SearchOptions = {},
    ): Promise<SearchResult[]> {
      const {
        limit = 10,
        threshold = 0.3,
        collection,
        trackAccess: shouldTrack = false,
        decayTier = "all",
        scope,
      } = options;
      const vectorStr = JSON.stringify(queryEmbedding);

      // Use vector_top_k for efficient ANN search via the vector index
      // vector_top_k returns a virtual table with just (id) column - the rowid
      // Results are already ordered by distance (nearest first)
      // We calculate distance separately with vector_distance_cos()
      //
      // Note: cosine distance (0 = identical, 2 = opposite)
      // Score = 1 - distance (so 1 = identical, -1 = opposite)
      const collectionFilter = collection
        ? sql`AND m.collection = ${collection}`
        : sql``;

      // Decay tier filter based on last_accessed
      const decayFilter =
        decayTier === "hot"
          ? sql`AND datetime(m.last_accessed) >= datetime('now', '-7 days')`
          : decayTier === "warm"
            ? sql`AND datetime(m.last_accessed) >= datetime('now', '-30 days')`
            : sql``;

      // Only return active memories (not superseded)
      const statusFilter = sql`AND (m.status IS NULL OR m.status = 'active' OR m.status = '''active''')`;

      // Scope filtering (package ∪ repo ∪ global) - only applied when the
      // caller explicitly passes a scope AND the table has the columns
      // (keeps this backward compatible with pre-scoping test fixtures).
      const scopeColumns = await hasScopeColumns(db);
      const scopeSelect = scopeColumns
        ? sql`, m.repo_key, m.package_key`
        : sql``;
      const scopeFilter =
        scopeColumns && scope
          ? sql`AND (
              m.repo_key IS NULL
              OR (m.repo_key = ${scope.repoKey} AND m.package_key IS NULL)
              OR (m.repo_key = ${scope.repoKey} AND m.package_key = ${scope.packageKey})
            )`
          : sql``;

      let results = await db.all<{
        id: string;
        content: string;
        metadata: string;
        collection: string;
        created_at: string;
        decay_factor: number;
        distance: number;
        access_count: string;
        last_accessed: string;
      }>(sql`
        SELECT
          m.id,
          m.content,
          m.metadata,
          m.collection,
          m.created_at,
          m.decay_factor,
          m.access_count,
          m.last_accessed
          ${scopeSelect},
          vector_distance_cos(m.embedding, vector(${vectorStr})) as distance
        FROM vector_top_k('idx_memories_embedding', vector(${vectorStr}), ${limit * 2}) AS v
        JOIN memories m ON m.rowid = v.id
        WHERE (1 - vector_distance_cos(m.embedding, vector(${vectorStr}))) >= ${threshold}
          ${collectionFilter}
          ${decayFilter}
          ${statusFilter}
          ${scopeFilter}
        ORDER BY distance ASC
        LIMIT ${limit}
      `);

      // libSQL's vector index can be eventually populated for freshly inserted rows
      // in in-memory/test databases. If ANN returns no rows, fall back to an exact
      // scan so recent writes remain searchable and higher layers can degrade
      // gracefully instead of behaving as if memory is empty.
      if (results.length === 0) {
        results = await db.all<{
          id: string;
          content: string;
          metadata: string;
          collection: string;
          created_at: string;
          decay_factor: number;
          distance: number;
          access_count: string;
          last_accessed: string;
        }>(sql`
          SELECT
            m.id,
            m.content,
            m.metadata,
            m.collection,
            m.created_at,
            m.decay_factor,
            m.access_count,
            m.last_accessed
            ${scopeSelect},
            vector_distance_cos(m.embedding, vector(${vectorStr})) as distance
          FROM memories m
          WHERE m.embedding IS NOT NULL
            AND (1 - vector_distance_cos(m.embedding, vector(${vectorStr}))) >= ${threshold}
            ${collectionFilter}
            ${decayFilter}
            ${statusFilter}
            ${scopeFilter}
          ORDER BY distance ASC
          LIMIT ${limit}
        `);
      }

      // Track access for returned memories
      if (shouldTrack && results.length > 0) {
        await this.trackAccess(results.map((r) => r.id));
      }

      return results.map((row) => ({
        memory: parseMemoryRow(row as unknown as typeof memories.$inferSelect),
        score: 1 - row.distance, // Convert distance to similarity score
        matchType: "vector" as const,
      }));
    },

    /**
     * Full-text search
     *
     * Uses FTS5 virtual table (memories_fts) for text search.
     * Falls back to raw SQL since FTS5 isn't yet in Drizzle.
     *
     * @param searchQuery - Text query string
     * @param options - Search options (limit, collection, trackAccess, decayTier)
     * @returns Array of search results ranked by relevance
     */
    async ftsSearch(
      searchQuery: string,
      options: SearchOptions = {},
    ): Promise<SearchResult[]> {
      const {
        limit = 10,
        collection,
        trackAccess: shouldTrack = false,
        decayTier = "all",
        scope,
      } = options;

      // Defense in depth: graceful degradation at store layer
      if (!searchQuery || typeof searchQuery !== "string") {
        console.warn(
          "[store] ftsSearch called with invalid query, returning empty results",
        );
        return [];
      }

      // FTS5 requires raw SQL - not yet in Drizzle's type-safe API
      // Quote search query to escape FTS5 operators (hyphens, etc.)
      // Without quotes, "unique-keyword-12345" → "unique" MINUS "keyword" → error
      const quotedQuery = `"${searchQuery.replace(/"/g, '""')}"`;

      // Build filters
      const collectionFilter = collection
        ? sql`AND m.collection = ${collection}`
        : sql``;
      const decayFilter =
        decayTier === "hot"
          ? sql`AND datetime(m.last_accessed) >= datetime('now', '-7 days')`
          : decayTier === "warm"
            ? sql`AND datetime(m.last_accessed) >= datetime('now', '-30 days')`
            : sql``;
      const statusFilter = sql`AND (m.status IS NULL OR m.status = 'active' OR m.status = '''active''')`;

      const scopeColumns = await hasScopeColumns(db);
      const scopeSelect = scopeColumns
        ? sql`, m.repo_key, m.package_key`
        : sql``;
      const scopeFilter =
        scopeColumns && scope
          ? sql`AND (
              m.repo_key IS NULL
              OR (m.repo_key = ${scope.repoKey} AND m.package_key IS NULL)
              OR (m.repo_key = ${scope.repoKey} AND m.package_key = ${scope.packageKey})
            )`
          : sql``;

      const results = await db.all<{
        id: string;
        content: string;
        metadata: string;
        collection: string;
        created_at: string;
        decay_factor: number;
        score: number;
      }>(sql`
        SELECT
          m.id,
          m.content,
          m.metadata,
          m.collection,
          m.created_at,
          m.decay_factor
          ${scopeSelect},
          fts.rank as score
        FROM memories_fts fts
        JOIN memories m ON m.rowid = fts.rowid
        WHERE fts.content MATCH ${quotedQuery}
          ${collectionFilter}
          ${decayFilter}
          ${statusFilter}
          ${scopeFilter}
        ORDER BY fts.rank
        LIMIT ${limit}
      `);

      // Track access for returned memories
      if (shouldTrack && results.length > 0) {
        await this.trackAccess(results.map((r) => r.id));
      }

      return results.map((row) => ({
        memory: parseMemoryRow(row as unknown as typeof memories.$inferSelect),
        score: Math.abs(row.score), // FTS5 rank is negative, normalize
        matchType: "fts" as const,
      }));
    },

    /**
     * Supersede a memory (no deletion - mark as superseded and link to new memory)
     *
     * Instead of deleting, marks the old memory as superseded and creates
     * a chain to the new memory via superseded_by pointer.
     *
     * @param oldId - Memory ID to supersede
     * @param newId - New memory ID that replaces it
     */
    async supersede(oldId: string, newId: string): Promise<void> {
      await db.run(sql`
        UPDATE memories
        SET
          status = 'superseded',
          superseded_by = ${newId},
          updated_at = datetime('now')
        WHERE id = ${oldId}
      `);
    },

    /**
     * List memories
     *
     * @param collection - Optional collection filter
     * @returns Array of memories sorted by created_at DESC
     */
    async list(collection?: string): Promise<Memory[]> {
      const results = collection
        ? await db
            .select()
            .from(memories)
            .where(eq(memories.collection, collection))
            .orderBy(desc(memories.created_at))
        : await db.select().from(memories).orderBy(desc(memories.created_at));

      return results.map(parseMemoryRow);
    },

    /**
     * Track memory access (update last_accessed, increment access_count)
     *
     * @param ids - Memory ID(s) to track
     */
    async trackAccess(ids: string | string[]): Promise<void> {
      const idArray = Array.isArray(ids) ? ids : [ids];
      if (idArray.length === 0) return;

      // Use raw SQL for efficient batch update
      // Note: access_count stored as TEXT, need to cast for arithmetic
      await db.run(sql`
        UPDATE memories
        SET
          access_count = CAST(COALESCE(CAST(access_count AS INTEGER), 0) + 1 AS TEXT),
          last_accessed = datetime('now')
        WHERE id IN (${sql.join(
          idArray.map((id) => sql`${id}`),
          sql`, `,
        )})
      `);
    },

    /**
     * Get a single memory by ID
     *
     * @param id - Memory ID
     * @param trackAccess - Whether to track this access (default: false)
     * @returns Memory or null if not found
     */
    async get(id: string, trackAccess = false): Promise<Memory | null> {
      const results = await db
        .select()
        .from(memories)
        .where(eq(memories.id, id));

      if (results.length === 0) return null;

      // Track access if requested
      if (trackAccess) {
        await this.trackAccess(id);
      }

      return parseMemoryRow(results[0]);
    },

    /**
     * Delete a memory
     *
     * Embedding stored inline in same table, single DELETE works.
     *
     * @param id - Memory ID
     */
    async delete(id: string): Promise<void> {
      await db.delete(memories).where(eq(memories.id, id));
    },

    /**
     * Get database statistics
     *
     * Counts memories and embeddings (embeddings in same table).
     *
     * @returns Memory and embedding counts
     */
    async getStats(): Promise<{ memories: number; embeddings: number }> {
      // libSQL bug: COUNT(*) returns 0 on tables with F32_BLOB vector columns.
      // Workaround: use COUNT(id) which skips the vector column scan.
      const memoryCount = await db
        .select({ count: sql<number>`COUNT(id)` })
        .from(memories);

      const embeddingCount = await db
        .select({ count: sql<number>`COUNT(id)` })
        .from(memories)
        .where(sql`embedding IS NOT NULL`);

      return {
        memories: Number(memoryCount[0].count),
        embeddings: Number(embeddingCount[0].count),
      };
    },
  };
}
