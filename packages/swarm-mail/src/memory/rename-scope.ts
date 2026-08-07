/**
 * Memory Scope Rename & Orphan Detection
 *
 * Remotes change, repos get renamed, packages move or get renamed. The
 * `repo_key`/`package_key` columns on `memories` are computed values
 * (see memory/scope.ts) - when the thing they were computed from changes,
 * every memory stored under the old key becomes silently unreachable by
 * scoped search (the key is still present in the DB, just never matched
 * again). This module provides the update path for that, plus detection
 * so orphaning can never be *silent*.
 *
 * All operations here are plain metadata UPDATEs on `repo_key`/
 * `package_key` - they never touch `content` or `embedding`, so
 * embeddings are preserved byte-for-byte.
 *
 * @module memory/rename-scope
 */

import { sql } from "drizzle-orm";
import type { SwarmDb } from "../db/client.js";

// ============================================================================
// Rename / update path
// ============================================================================

export interface RenameResult {
  /** Number of memory rows whose scope key was rewritten. */
  readonly updated: number;
}

function rowsAffected(result: unknown): number {
  if (result && typeof result === "object" && "rowsAffected" in result) {
    const value = (result as { rowsAffected?: unknown }).rowsAffected;
    return typeof value === "number" ? value : Number(value ?? 0);
  }
  return 0;
}

/**
 * Rewrite every memory scoped to `fromRepoKey` to `toRepoKey`.
 *
 * Use when a repo's git remote changes (rename, transfer, re-host) and
 * `resolveHiveDataSlug()` now produces a different slug for the same
 * project. Content and embeddings are untouched.
 *
 * @param db - Drizzle database instance
 * @param fromRepoKey - The stale repo key (e.g. old remote-derived slug)
 * @param toRepoKey - The new repo key memories should be found under
 */
export async function renameRepoKey(
  db: SwarmDb,
  fromRepoKey: string,
  toRepoKey: string,
): Promise<RenameResult> {
  if (fromRepoKey === toRepoKey) return { updated: 0 };

  const result = await db.run(sql`
    UPDATE memories
    SET repo_key = ${toRepoKey}, updated_at = datetime('now')
    WHERE repo_key = ${fromRepoKey}
  `);

  return { updated: rowsAffected(result) };
}

/**
 * Rewrite every memory scoped to `(repoKey, fromPackageKey)` to
 * `(repoKey, toPackageKey)`.
 *
 * Use when a package is renamed or moved to a different path within the
 * same repo (`packages/swarm-mail` -> `packages/mail-core`, or moved to
 * `libs/swarm-mail`). Content and embeddings are untouched.
 *
 * @param db - Drizzle database instance
 * @param repoKey - The repo these packages belong to
 * @param fromPackageKey - The stale package key (old repo-relative path)
 * @param toPackageKey - The new package key
 */
export async function renamePackageKey(
  db: SwarmDb,
  repoKey: string,
  fromPackageKey: string,
  toPackageKey: string,
): Promise<RenameResult> {
  if (fromPackageKey === toPackageKey) return { updated: 0 };

  const result = await db.run(sql`
    UPDATE memories
    SET package_key = ${toPackageKey}, updated_at = datetime('now')
    WHERE repo_key = ${repoKey} AND package_key = ${fromPackageKey}
  `);

  return { updated: rowsAffected(result) };
}

// ============================================================================
// Orphan detection
// ============================================================================

export interface OrphanedRepoKey {
  readonly repoKey: string;
  /** Number of memories currently stranded under this stale repo key. */
  readonly count: number;
}

/**
 * Find distinct repo_key values present in the memories table that don't
 * match any repo key the caller currently considers valid.
 *
 * This is the detection half of the rename path: after a rename lands
 * upstream (or is suspected), pass the set of repo keys you'd currently
 * resolve for your known projects (e.g. via `resolveMemoryScope()` for
 * each project you track) and this surfaces anything left behind -
 * proving orphaning is detectable rather than silent.
 *
 * @param db - Drizzle database instance
 * @param knownRepoKeys - Repo keys that currently resolve to a real project
 * @returns Repo keys present in the DB that aren't in `knownRepoKeys`, with counts
 */
export async function findOrphanedRepoKeys(
  db: SwarmDb,
  knownRepoKeys: readonly string[],
): Promise<OrphanedRepoKey[]> {
  const rows = await db.all<{ repo_key: string; count: number }>(sql`
    SELECT repo_key, COUNT(id) as count
    FROM memories
    WHERE repo_key IS NOT NULL
    GROUP BY repo_key
  `);

  const known = new Set(knownRepoKeys);
  return rows
    .filter((r) => !known.has(r.repo_key))
    .map((r) => ({ repoKey: r.repo_key, count: Number(r.count) }));
}

export interface OrphanedPackageKey {
  readonly repoKey: string;
  readonly packageKey: string;
  /** Number of memories currently stranded under this stale package key. */
  readonly count: number;
}

/**
 * Find distinct package_key values (within a given repo) present in the
 * memories table that don't match any package key the caller currently
 * considers valid.
 *
 * Pass the set of package keys you'd currently resolve for the repo's
 * live packages (e.g. by scanning `packages/*∕package.json`) to surface
 * anything left behind after a rename or move.
 *
 * @param db - Drizzle database instance
 * @param repoKey - The repo to check package keys within
 * @param knownPackageKeys - Package keys that currently resolve to a real package
 * @returns Package keys present in the DB that aren't in `knownPackageKeys`, with counts
 */
export async function findOrphanedPackageKeys(
  db: SwarmDb,
  repoKey: string,
  knownPackageKeys: readonly string[],
): Promise<OrphanedPackageKey[]> {
  const rows = await db.all<{ package_key: string; count: number }>(sql`
    SELECT package_key, COUNT(id) as count
    FROM memories
    WHERE repo_key = ${repoKey} AND package_key IS NOT NULL
    GROUP BY package_key
  `);

  const known = new Set(knownPackageKeys);
  return rows
    .filter((r) => !known.has(r.package_key))
    .map((r) => ({
      repoKey,
      packageKey: r.package_key,
      count: Number(r.count),
    }));
}
