/**
 * libSQL Memory Schema - FTS5 and Vector Extensions
 *
 * Provides FTS5 full-text search and vector indexes for memories table.
 *
 * ## Schema Source of Truth
 * - **Table structure**: db/schema/memory.ts (Drizzle schema)
 * - **FTS5/vector DDL**: This file (raw SQL - Drizzle can't create these)
 *
 * ## Synchronization
 * The memories table definition MUST match db/schema/memory.ts exactly.
 * Changes to table structure should be made in db/schema/memory.ts first,
 * then reflected here.
 *
 * ## Key Differences from PGlite
 *
 * | PGlite (pgvector)        | libSQL                               |
 * |--------------------------|--------------------------------------|
 * | `vector(768)`            | `F32_BLOB(768)`                      |
 * | `$1::vector`             | `vector(?)`                          |
 * | `embedding <=> $1`       | `vector_distance_cos(embedding, vector(?))` |
 * | `CREATE EXTENSION vector`| Not needed (native support)          |
 * | GIN FTS index            | FTS5 virtual table                   |
 * | JSONB                    | TEXT (JSON stored as string)         |
 * | TIMESTAMPTZ              | TEXT (ISO 8601 string)               |
 *
 * ## Vector Search Notes
 * - libSQL returns distance (0 = identical, 2 = opposite)
 * - To get similarity score: similarity = 1 - distance
 * - Lower distance = higher similarity (opposite of pgvector score)
 *
 * @module memory/libsql-schema
 */

import type { Client } from "@libsql/client";

/** Embedding dimension for mxbai-embed-large (matches PGlite schema) */
export const EMBEDDING_DIM = 1024;

/**
 * Create libSQL memory schema with FTS5 and vector support
 *
 * Creates:
 * - memories table (structure from db/schema/memory.ts)
 * - FTS5 virtual table for full-text search (Drizzle can't create this)
 * - Vector index (Drizzle can't create this)
 * - Standard indexes for performance
 *
 * Idempotent - safe to call multiple times.
 *
 * @param db - libSQL client instance
 * @throws Error if schema creation fails
 *
 * @example
 * ```typescript
 * import { createClient } from "@libsql/client";
 * import { createLibSQLMemorySchema } from "./libsql-schema.js";
 *
 * const db = createClient({ url: ":memory:" });
 * await createLibSQLMemorySchema(db);
 * ```
 */
export async function createLibSQLMemorySchema(db: Client): Promise<void> {
  // ========================================================================
  // Memories Table
  // ========================================================================
  // IMPORTANT: This table structure MUST match db/schema/memory.ts (Drizzle schema)
  // Source of truth: db/schema/memory.ts
  // Reason for duplication: Convenience for tests and migrations
  await db.execute(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      collection TEXT DEFAULT 'default',
      tags TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      decay_factor REAL DEFAULT 1.0,
      embedding F32_BLOB(${EMBEDDING_DIM}),
      valid_from TEXT,
      valid_until TEXT,
      superseded_by TEXT REFERENCES memories(id),
      auto_tags TEXT,
      keywords TEXT,
      access_count TEXT DEFAULT '0',
      last_accessed TEXT DEFAULT (datetime('now')),
      category TEXT,
      status TEXT DEFAULT 'active',
      repo_key TEXT,
      package_key TEXT,
      deleted_at TEXT
    )
  `);

  // ========================================================================
  // Auto-Migration: Add new columns to existing databases
  // ========================================================================
  // These ALTER TABLE statements are idempotent - they silently fail if column exists
  try {
    await db.execute(
      `ALTER TABLE memories ADD COLUMN access_count TEXT DEFAULT '0'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    await db.execute(
      `ALTER TABLE memories ADD COLUMN last_accessed TEXT DEFAULT (datetime('now'))`,
    );
  } catch {
    /* column already exists */
  }
  try {
    await db.execute(`ALTER TABLE memories ADD COLUMN category TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    await db.execute(
      `ALTER TABLE memories ADD COLUMN status TEXT DEFAULT 'active'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    await db.execute(`ALTER TABLE memories ADD COLUMN repo_key TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    await db.execute(`ALTER TABLE memories ADD COLUMN package_key TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    await db.execute(`ALTER TABLE memories ADD COLUMN deleted_at TEXT`);
  } catch {
    /* column already exists */
  }

  // SKOS Taxonomy fields for entities table
  try {
    await db.execute(`ALTER TABLE entities ADD COLUMN pref_label TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    await db.execute(`ALTER TABLE entities ADD COLUMN alt_labels TEXT`);
  } catch {
    /* column already exists */
  }

  // ========================================================================
  // Memory Links Table (Zettelkasten-style bidirectional connections)
  // ========================================================================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS memory_links (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL,
      strength REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, link_type)
    )
  `);

  // ========================================================================
  // Entities Table (Named entities extracted from memories)
  // ========================================================================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      canonical_name TEXT,
      pref_label TEXT,
      alt_labels TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(name, entity_type)
    )
  `);

  // ========================================================================
  // Relationships Table (Entity-entity triples)
  // ========================================================================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      predicate TEXT NOT NULL,
      object_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
      confidence REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(subject_id, predicate, object_id)
    )
  `);

  // ========================================================================
  // Memory-Entities Junction Table
  // ========================================================================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS memory_entities (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      role TEXT,
      PRIMARY KEY(memory_id, entity_id)
    )
  `);

  // ========================================================================
  // Entity Taxonomy Table (SKOS-based relationships)
  // ========================================================================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS entity_taxonomy (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      related_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relationship_type TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(entity_id, related_entity_id, relationship_type)
    )
  `);

  // ========================================================================
  // Indexes (Drizzle doesn't auto-create these)
  // ========================================================================

  // Collection filtering index
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_memories_collection 
    ON memories(collection)
  `);

  // Scope filtering indexes (repo/package scoping - see memory/scope.ts)
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_memories_repo_key
    ON memories(repo_key)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_memories_scope
    ON memories(repo_key, package_key)
  `);

  // Memory links indexes
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_memory_links_source 
    ON memory_links(source_id)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_memory_links_target 
    ON memory_links(target_id)
  `);

  // Entities indexes
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_entities_type 
    ON entities(entity_type)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_entities_name 
    ON entities(name)
  `);

  // Relationships indexes
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_relationships_subject 
    ON relationships(subject_id)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_relationships_object 
    ON relationships(object_id)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_relationships_predicate
    ON relationships(predicate)
  `);

  // Entity taxonomy indexes
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_entity_taxonomy_entity
    ON entity_taxonomy(entity_id)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_entity_taxonomy_related
    ON entity_taxonomy(related_entity_id)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_entity_taxonomy_type
    ON entity_taxonomy(relationship_type)
  `);

  // Vector index for cosine similarity search
  // libSQL requires explicit index creation for vector_top_k() queries
  // MUST be raw SQL - Drizzle doesn't support libsql_vector_idx() function
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_memories_embedding 
    ON memories(libsql_vector_idx(embedding))
  `);

  // ========================================================================
  // FTS5 Virtual Table (raw SQL - Drizzle can't create virtual tables)
  // ========================================================================

  // FTS5 virtual table for full-text search
  await db.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts 
    USING fts5(id UNINDEXED, content, content=memories, content_rowid=rowid)
  `);

  // Triggers to keep FTS5 table in sync with memories table
  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_insert 
    AFTER INSERT ON memories 
    BEGIN
      INSERT INTO memories_fts(rowid, id, content) 
      VALUES (new.rowid, new.id, new.content);
    END
  `);

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_delete 
    AFTER DELETE ON memories 
    BEGIN
      DELETE FROM memories_fts WHERE rowid = old.rowid;
    END
  `);

  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_update 
    AFTER UPDATE ON memories 
    BEGIN
      UPDATE memories_fts 
      SET id = new.id, content = new.content 
      WHERE rowid = new.rowid;
    END
  `);
}

/**
 * Drop libSQL memory schema
 *
 * Removes all tables, indexes, and triggers created by createLibSQLMemorySchema.
 * Useful for tests and cleanup.
 *
 * @param db - libSQL client instance
 */
export async function dropLibSQLMemorySchema(db: Client): Promise<void> {
  // Temporarily disable foreign keys to allow table drops in any order
  await db.execute("PRAGMA foreign_keys = OFF");

  // Drop triggers first
  await db.execute("DROP TRIGGER IF EXISTS memories_fts_update");
  await db.execute("DROP TRIGGER IF EXISTS memories_fts_delete");
  await db.execute("DROP TRIGGER IF EXISTS memories_fts_insert");

  // Drop FTS5 table
  await db.execute("DROP TABLE IF EXISTS memories_fts");

  // Drop indexes (some may be dropped automatically with tables)
  await db.execute("DROP INDEX IF EXISTS idx_memories_scope");
  await db.execute("DROP INDEX IF EXISTS idx_memories_repo_key");
  await db.execute("DROP INDEX IF EXISTS idx_memories_collection");
  await db.execute("DROP INDEX IF EXISTS idx_memory_links_source");
  await db.execute("DROP INDEX IF EXISTS idx_memory_links_target");
  await db.execute("DROP INDEX IF EXISTS idx_entities_type");
  await db.execute("DROP INDEX IF EXISTS idx_entities_name");
  await db.execute("DROP INDEX IF EXISTS idx_relationships_subject");
  await db.execute("DROP INDEX IF EXISTS idx_relationships_object");
  await db.execute("DROP INDEX IF EXISTS idx_relationships_predicate");

  // Drop tables in dependency order (children first, then parents)
  await db.execute("DROP TABLE IF EXISTS memory_entities");
  await db.execute("DROP TABLE IF EXISTS relationships");
  await db.execute("DROP TABLE IF EXISTS entity_taxonomy");
  await db.execute("DROP TABLE IF EXISTS memory_links");
  await db.execute("DROP TABLE IF EXISTS entities");
  await db.execute("DROP TABLE IF EXISTS memories");

  // Re-enable foreign keys
  await db.execute("PRAGMA foreign_keys = ON");
}

/**
 * Verify libSQL memory schema exists and is valid
 *
 * Checks for:
 * - memories table with required columns
 * - FTS5 virtual table
 * - Required indexes
 * - Required triggers
 *
 * @param db - libSQL client instance
 * @returns True if schema is valid, false otherwise
 */
export async function validateLibSQLMemorySchema(db: Client): Promise<boolean> {
  try {
    // Check memories table exists
    const tables = await db.execute(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='memories'
    `);
    if (tables.rows.length === 0) return false;

    // Check FTS5 table exists
    const fts = await db.execute(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='memories_fts'
    `);
    if (fts.rows.length === 0) return false;

    // Check required columns exist
    const columns = await db.execute(`
      SELECT name FROM pragma_table_info('memories')
    `);
    const columnNames = columns.rows.map((r) => r.name);
    const required = [
      "id",
      "content",
      "metadata",
      "collection",
      "tags",
      "created_at",
      "updated_at",
      "decay_factor",
      "embedding",
      "valid_from",
      "valid_until",
      "superseded_by",
      "auto_tags",
      "keywords",
      "access_count",
      "last_accessed",
      "category",
      "status",
      "repo_key",
      "package_key",
    ];

    for (const col of required) {
      if (!columnNames.includes(col)) return false;
    }

    // Check new tables exist
    const newTables = await db.execute(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('memory_links', 'entities', 'relationships', 'memory_entities', 'entity_taxonomy')
    `);
    if (newTables.rows.length !== 5) return false;

    return true;
  } catch {
    return false;
  }
}
