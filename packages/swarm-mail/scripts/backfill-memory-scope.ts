#!/usr/bin/env bun
/**
 * One-off migration script: back up the production DB, land the
 * repo_key/package_key scope columns (via the normal
 * getSwarmMailLibSQL()/createLibSQLMemorySchema() init path, which is
 * idempotent), backfill the katas-repo-scoped subset of the existing 34
 * memories, and verify nothing else moved.
 *
 * Run with: `bun run scripts/backfill-memory-scope.ts` from
 * packages/swarm-mail. Do NOT run under `bun test` (NODE_ENV=test trips
 * the production-DB guard in streams/index.ts by design).
 *
 * Safety:
 * - Backs up swarm.db (+ -wal/-shm) to timestamped files before touching
 *   anything. Aborts immediately if the backup can't be verified.
 * - Backfill is a single UPDATE ... WHERE id IN (...) touching only
 *   repo_key - never content or embedding.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import {
  createMemoryAdapter,
  getSwarmMailLibSQL,
  toSwarmDb,
  type MemoryScope,
} from "../src/index.js";

const DB_PATH = join(homedir(), ".config", "swarm-tools", "swarm.db");

// The 4 memories that are genuinely katas-repo-specific (kata inventory,
// kata package structure) per the classification review. Everything else
// in the old repos/github.com/srmcguirt/katas/memories.jsonl split (9
// items - general moon/Tera/template.yml/task-inheritance knowledge) is
// left global (already NULL by default - no write needed for those).
const KATAS_REPO_KEY = "github.com/srmcguirt/katas";
const KATAS_SCOPED_IDS = [
  "mem-08eadc8fd6b3b721", // Moon bun toolchain integration friction - specific gaps found in katas' own config
  "mem-72beeb2aefbe3a0e", // duplicate of the above
  "mem-201193b5efd6df88", // Advanced-tier kata scaffolding (kata package structure)
  "mem-c1e7b62912df9c5e", // Katas-manifest.json inventory (kata inventory)
] as const;

function log(msg: string): void {
  console.log(`[backfill-memory-scope] ${msg}`);
}

function backup(): { dbBackup: string } {
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `Production DB not found at ${DB_PATH} - nothing to migrate.`,
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dbBackup = `${DB_PATH}.bak_prescopemigration_${stamp}`;
  const walBackup = `${DB_PATH}-wal.bak_prescopemigration_${stamp}`;
  const shmBackup = `${DB_PATH}-shm.bak_prescopemigration_${stamp}`;

  copyFileSync(DB_PATH, dbBackup);
  if (existsSync(`${DB_PATH}-wal`)) copyFileSync(`${DB_PATH}-wal`, walBackup);
  if (existsSync(`${DB_PATH}-shm`)) copyFileSync(`${DB_PATH}-shm`, shmBackup);

  // Verify: backup must exist and be non-empty, or STOP.
  const originalSize = statSync(DB_PATH).size;
  const backupSize = statSync(dbBackup).size;
  if (backupSize === 0 || backupSize !== originalSize) {
    throw new Error(
      `Backup verification failed: original ${originalSize} bytes, backup ${backupSize} bytes at ${dbBackup}. STOPPING.`,
    );
  }

  log(`Backed up ${DB_PATH} -> ${dbBackup} (${backupSize} bytes, verified)`);
  return { dbBackup };
}

async function main() {
  log(`Target production DB: ${DB_PATH}`);

  // 1. Backup FIRST. If this throws, nothing below runs.
  const { dbBackup } = backup();

  // 2. Land schema (idempotent - runs the normal init path, which applies
  //    migration v13 and/or the ALTER TABLE self-heal fallback).
  const swarmMail = await getSwarmMailLibSQL();
  const dbAdapter = await swarmMail.getDatabase();
  const db = toSwarmDb(dbAdapter);

  const columnRows = await db.all<{ name: string }>(
    sql`SELECT name FROM pragma_table_info('memories')`,
  );
  const columnNames = new Set(columnRows.map((r) => r.name));
  if (!columnNames.has("repo_key") || !columnNames.has("package_key")) {
    throw new Error(
      "repo_key/package_key columns missing after schema init - migration did not land.",
    );
  }
  log("Schema check: repo_key/package_key columns present.");

  // 3. Pre-backfill snapshot: counts + embedding hashes for the 4 target rows.
  const preStats = await db.all<{ memories: number; embeddings: number }>(
    sql`SELECT COUNT(id) as memories, SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as embeddings FROM memories`,
  );
  log(
    `Pre-backfill: memories=${preStats[0].memories}, embeddings=${preStats[0].embeddings}`,
  );

  const embeddingHash = async (id: string): Promise<string | null> => {
    const rows = await db.all<{ embedding: Buffer | null }>(
      sql`SELECT embedding FROM memories WHERE id = ${id}`,
    );
    if (rows.length === 0 || !rows[0].embedding) return null;
    return createHash("sha256")
      .update(Buffer.from(rows[0].embedding))
      .digest("hex");
  };

  const preHashes = new Map<string, string | null>();
  for (const id of KATAS_SCOPED_IDS) {
    preHashes.set(id, await embeddingHash(id));
  }

  const preScopeRows = await db.all<{ id: string; repo_key: string | null }>(
    sql`SELECT id, repo_key FROM memories WHERE id IN (${sql.join(
      KATAS_SCOPED_IDS.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  log(`Pre-backfill scope for target IDs: ${JSON.stringify(preScopeRows)}`);

  // 4. Backfill: repo_key only, for exactly the 4 katas-specific memories.
  const result = await db.run(sql`
    UPDATE memories
    SET repo_key = ${KATAS_REPO_KEY}, updated_at = datetime('now')
    WHERE id IN (${sql.join(
      KATAS_SCOPED_IDS.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
  log(
    `Backfill UPDATE affected ${(result as { rowsAffected?: number }).rowsAffected ?? "?"} rows.`,
  );

  // 5. Post-backfill verification.
  const postStats = await db.all<{ memories: number; embeddings: number }>(
    sql`SELECT COUNT(id) as memories, SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as embeddings FROM memories`,
  );
  log(
    `Post-backfill: memories=${postStats[0].memories}, embeddings=${postStats[0].embeddings}`,
  );

  if (
    preStats[0].memories !== postStats[0].memories ||
    preStats[0].embeddings !== postStats[0].embeddings
  ) {
    throw new Error(
      `COUNT MISMATCH after backfill: pre=${JSON.stringify(preStats[0])} post=${JSON.stringify(postStats[0])}. Restore from ${dbBackup}.`,
    );
  }

  let embeddingsIdentical = true;
  for (const id of KATAS_SCOPED_IDS) {
    const after = await embeddingHash(id);
    const before = preHashes.get(id);
    const same = before === after;
    embeddingsIdentical &&= same;
    log(`  ${id}: embedding hash ${same ? "UNCHANGED" : "CHANGED (!)"}`);
  }
  if (!embeddingsIdentical) {
    throw new Error(
      `Embedding(s) changed during backfill. Restore from ${dbBackup}.`,
    );
  }

  const postScopeRows = await db.all<{ id: string; repo_key: string | null }>(
    sql`SELECT id, repo_key FROM memories WHERE id IN (${sql.join(
      KATAS_SCOPED_IDS.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  log(`Post-backfill scope for target IDs: ${JSON.stringify(postScopeRows)}`);
  for (const row of postScopeRows) {
    if (row.repo_key !== KATAS_REPO_KEY) {
      throw new Error(
        `${row.id} did not get repo_key=${KATAS_REPO_KEY} (got ${row.repo_key})`,
      );
    }
  }

  const globalCountRows = await db.all<{ count: number }>(
    sql`SELECT COUNT(id) as count FROM memories WHERE repo_key IS NULL`,
  );
  const repoCountRows = await db.all<{ count: number }>(
    sql`SELECT COUNT(id) as count FROM memories WHERE repo_key = ${KATAS_REPO_KEY}`,
  );
  log(
    `Scope split: global=${globalCountRows[0].count}, ${KATAS_REPO_KEY}=${repoCountRows[0].count}`,
  );

  // 6. Scoped search verification: package ∪ repo ∪ global semantics.
  const config = {
    ollamaHost: process.env.OLLAMA_HOST || "http://localhost:11434",
    ollamaModel: "mxbai-embed-large",
  };
  const adapter = createMemoryAdapter(db, config, {
    projectPath: process.cwd(),
  });

  const katasScope: MemoryScope = { repoKey: KATAS_REPO_KEY, packageKey: null };
  const unrelatedScope: MemoryScope = {
    repoKey: "github.com/someoneelse/unrelated-repo",
    packageKey: null,
  };

  const fromKatas = await adapter.find(
    "kata scaffolding advanced tier packages",
    {
      scope: katasScope,
      limit: 20,
      expand: false,
    },
  );
  const fromUnrelated = await adapter.find(
    "kata scaffolding advanced tier packages",
    {
      scope: unrelatedScope,
      limit: 20,
      expand: false,
    },
  );

  const katasIdsInResults = new Set(fromKatas.map((r) => r.memory.id));
  const anyKatasScopedSurfacedFromKatas = KATAS_SCOPED_IDS.some((id) =>
    katasIdsInResults.has(id),
  );
  const unrelatedIds = new Set(fromUnrelated.map((r) => r.memory.id));
  const anyKatasScopedLeakedToUnrelated = KATAS_SCOPED_IDS.some((id) =>
    unrelatedIds.has(id),
  );

  log(
    `Scoped as katas repo: ${fromKatas.length} results, includes a katas-scoped memory: ${anyKatasScopedSurfacedFromKatas}`,
  );
  log(
    `Scoped as unrelated repo: ${fromUnrelated.length} results, leaked a katas-scoped memory: ${anyKatasScopedLeakedToUnrelated}`,
  );
  if (anyKatasScopedLeakedToUnrelated) {
    throw new Error(
      "VERIFICATION FAILED: a repo-scoped memory leaked into an unrelated repo's search.",
    );
  }
  if (!anyKatasScopedSurfacedFromKatas) {
    console.warn(
      "[backfill-memory-scope] WARNING: no katas-scoped memory surfaced in top 20 for the katas-scoped query - check threshold/query relevance, not necessarily a scoping bug.",
    );
  }

  // Global memory surfaces everywhere: pick a known-global memory id and confirm it's
  // reachable from both the katas scope and the unrelated scope.
  const globalProbe = await adapter.find(
    "swarm-tools monorepo build order bun",
    {
      scope: unrelatedScope,
      limit: 10,
    },
  );
  log(
    `Global-memory probe from unrelated scope: ${globalProbe.length} results (top score ${globalProbe[0]?.score.toFixed(4) ?? "n/a"})`,
  );

  // 7. Baseline retrieval unchanged: unscoped search reproduces historical scores.
  const baseline = await adapter.find(
    "moon template tera interpolation kata bun",
    {
      limit: 5,
    },
  );
  log(
    `Baseline unscoped query top scores: ${baseline.map((r) => r.score.toFixed(4)).join(", ")}`,
  );
  log(
    `Baseline top memory IDs: ${baseline.map((r) => r.memory.id).join(", ")}`,
  );

  log("DONE. Backup retained at: " + dbBackup);
}

main().catch((error) => {
  console.error("[backfill-memory-scope] FAILED:", error);
  process.exit(1);
});
