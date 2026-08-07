/**
 * Memory sync targeting the hive-data repo's global/project split.
 *
 * Scope is now backed by the `repo_key`/`package_key` columns on
 * `memories` (see memory/scope.ts) as well as by which git-tracked file
 * a memory's id already appears in:
 *
 *   hive-data/global/memories.jsonl        <- cross-project learnings
 *   hive-data/repos/<slug>/memories.jsonl  <- this project's learnings
 *
 * Export rule: a project sync exports every DB memory whose id is **not**
 * already claimed by the global file, restricted to memories whose
 * `repo_key` matches this project's `repoKey` (package-scoped memories
 * under the same repo are included too - this file covers the whole
 * repo, not a single package). Without this restriction every repo's
 * repo-scoped memories would land in every other repo's memories.jsonl.
 *
 * If the `memories` table predates the `repo_key`/`package_key` columns
 * (older schema), the repo_key filter is skipped and the sync falls back
 * to the pre-scoping heuristic: every non-globally-claimed memory is
 * treated as this project's. New memories default to project-scoped.
 * Reclassifying a memory to global is a manual edit (move the JSONL line
 * to global/memories.jsonl) that this sync then respects on the next
 * run, since the id becomes globally-claimed and drops out of the
 * project export automatically.
 *
 * This module never writes to the global file — only a project's own
 * memories.jsonl. Global curation is out of scope for `hive_sync`.
 *
 * @module memory/hive-data-sync
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sanitizeForGitExport } from "../export-sanitize.js";
import type { DatabaseAdapter } from "../types/database.js";
import {
  exportMemories,
  importMemories,
  parseMemoryJSONL,
  serializeMemoryToJSONL,
  type MemoryImportResult,
} from "./sync.js";

export interface HiveDataMemorySyncOptions {
  /** Absolute path to hive-data/global/memories.jsonl */
  globalMemoriesPath: string;
  /** Absolute path to hive-data/repos/<slug>/memories.jsonl */
  projectMemoriesPath: string;
  /**
   * This project's repo scope key - same slug scheme as
   * `hive/hive-data-repo.ts`'s `resolveHiveDataSlug()` (and
   * `memory/scope.ts`'s `resolveMemoryScope()`). Used to restrict the
   * export to this project's repo-scoped memories. Required even when
   * the DB predates the scope columns (in which case it's unused) so
   * callers always pass the value they already have on hand.
   */
  repoKey: string;
}

/**
 * Whether the `memories` table has the repo_key/package_key scope
 * columns. Older databases (pre-scoping) won't, and the export falls
 * back to the pre-scoping heuristic in that case.
 */
async function hasScopeColumns(db: DatabaseAdapter): Promise<boolean> {
  try {
    const result = await db.query<{ name: string }>(
      `SELECT name FROM pragma_table_info('memories')`,
    );
    const names = new Set(result.rows.map((r) => r.name));
    return names.has("repo_key") && names.has("package_key");
  } catch {
    return false;
  }
}

export interface HiveDataMemorySyncResult {
  imported: MemoryImportResult;
  projectExported: number;
}

function mergeImportResults(
  a: MemoryImportResult,
  b: MemoryImportResult,
): MemoryImportResult {
  return {
    created: a.created + b.created,
    skipped: a.skipped + b.skipped,
    errors: [...a.errors, ...b.errors],
  };
}

/**
 * Sync a project's slice of memories with the hive-data repo.
 *
 * 1. Import from both the global and project JSONL files (recovery path —
 *    same dedup-by-id/content-hash guarantees as `importMemories`).
 * 2. Export every DB memory not already claimed by the global file to the
 *    project file. The global file itself is never written.
 */
export async function syncProjectMemoriesToHiveData(
  db: DatabaseAdapter,
  options: HiveDataMemorySyncOptions,
): Promise<HiveDataMemorySyncResult> {
  const { globalMemoriesPath, projectMemoriesPath, repoKey } = options;

  // 1. Import (recovery path) from both files.
  let imported: MemoryImportResult = { created: 0, skipped: 0, errors: [] };

  if (existsSync(globalMemoriesPath)) {
    const globalContent = readFileSync(globalMemoriesPath, "utf-8");
    imported = mergeImportResults(
      imported,
      await importMemories(db, globalContent),
    );
  }

  if (existsSync(projectMemoriesPath)) {
    const projectContent = readFileSync(projectMemoriesPath, "utf-8");
    imported = mergeImportResults(
      imported,
      await importMemories(db, projectContent),
    );
  }

  // 2. Determine which ids are already claimed by the global file, so the
  // project export never duplicates them.
  const globalIds = new Set(
    existsSync(globalMemoriesPath)
      ? parseMemoryJSONL(readFileSync(globalMemoriesPath, "utf-8")).map(
          (m) => m.id,
        )
      : [],
  );

  const rawExport = await exportMemories(db);
  const allMemories = parseMemoryJSONL(rawExport);
  let projectScoped = allMemories.filter((m) => !globalIds.has(m.id));

  // Restrict to this project's repo scope when the DB has scope columns.
  // Without this, every repo-scoped memory in the DB (including other
  // repos') gets written into every project's memories.jsonl.
  if (await hasScopeColumns(db)) {
    const scopeRows = await db.query<{ id: string; repo_key: string | null }>(
      `SELECT id, repo_key FROM memories`,
    );
    const idsInRepo = new Set(
      scopeRows.rows.filter((r) => r.repo_key === repoKey).map((r) => r.id),
    );
    projectScoped = projectScoped.filter((m) => idsInRepo.has(m.id));
  }

  if (projectScoped.length === 0 && !existsSync(projectMemoriesPath)) {
    return { imported, projectExported: 0 };
  }

  const sanitizedLines = projectScoped.map((m) =>
    serializeMemoryToJSONL({
      ...m,
      information: sanitizeForGitExport(m.information) ?? m.information,
    }),
  );
  writeFileSync(projectMemoriesPath, sanitizedLines.join("\n"));

  return { imported, projectExported: projectScoped.length };
}
