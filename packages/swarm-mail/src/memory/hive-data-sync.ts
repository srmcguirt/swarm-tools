/**
 * Memory sync targeting the hive-data repo's global/project split.
 *
 * The hive DB's `memories` table has no scope column (global vs
 * project-scoped) — adding one is a separate, not-yet-shipped cell. Until
 * it lands, scope is tracked entirely by which git-tracked file a memory's
 * id already appears in:
 *
 *   hive-data/global/memories.jsonl        <- cross-project learnings
 *   hive-data/repos/<slug>/memories.jsonl  <- this project's learnings
 *
 * Interim rule (deliberately simple, must never lose or duplicate a
 * memory): a project sync exports every DB memory whose id is **not**
 * already claimed by the global file. That covers both "still in the
 * project file" and "brand new, never synced anywhere" — new memories
 * default to project-scoped. Reclassifying a memory to global is a manual
 * edit (move the JSONL line to global/memories.jsonl) that this sync then
 * respects on the next run, since the id becomes globally-claimed and
 * drops out of the project export automatically.
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
  const { globalMemoriesPath, projectMemoriesPath } = options;

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
  const projectScoped = allMemories.filter((m) => !globalIds.has(m.id));

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
