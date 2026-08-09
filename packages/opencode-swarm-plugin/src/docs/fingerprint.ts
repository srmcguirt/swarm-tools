/**
 * Corpus fingerprint - the fast, zero-model-call basis for `swarm docs
 * check`.
 *
 * The fingerprint is deliberately NOT git HEAD. HEAD changes on every
 * commit, so a HEAD-keyed stamp would report drift on literally every
 * push regardless of whether anything doc-relevant changed, and the gate
 * would become noise everyone disables. Instead this keys on what actually
 * changes the corpus a `docs generate` run would produce: row count and
 * `MAX(updated_at)` over `beads` for the resolved `project_key`. Both come
 * from one query against `idx_beads_project` (see
 * swarm-mail/src/hive/migrations.ts) - cheap and indexed, no full-table
 * scan, no extraction, no classifier, no Ollama call.
 *
 * Read-only throughout: every exported function here only ever SELECTs.
 */
import { type Client, createClient } from '@libsql/client';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CorpusFingerprint {
  rowCount: number;
  maxUpdatedAt: number | null;
}

/** One cheap indexed query: COUNT(id) + MAX(updated_at) over beads for project_key, excluding soft-deleted rows. */
export async function computeCorpusFingerprint(
  client: Client,
  projectKey: string,
): Promise<CorpusFingerprint> {
  const result = await client.execute({
    sql: `SELECT COUNT(id) AS row_count, MAX(updated_at) AS max_updated_at
          FROM beads
          WHERE project_key = ? AND deleted_at IS NULL`,
    args: [projectKey],
  });
  const row = result.rows[0];
  const rowCount = Number(row?.row_count ?? 0);
  const maxUpdatedAtRaw = row?.max_updated_at;
  return {
    rowCount,
    maxUpdatedAt: maxUpdatedAtRaw == null ? null : Number(maxUpdatedAtRaw),
  };
}

/** Opens a real @libsql/client against the given swarm.db path. Never sqlite3 - see hive-doc-adapter's hive-reader.ts doc comment on why that mis-reads this schema's vector-indexed tables. */
export function openHiveDbClient(dbPath: string): Client {
  const url = dbPath.startsWith('file:') ? dbPath : `file:${dbPath}`;
  return createClient({ url });
}

export interface DocsStamp extends CorpusFingerprint {
  projectKey: string;
  /** ISO timestamp of the generate run that produced this stamp - informational only, never compared. */
  generatedAt: string;
}

/**
 * Stamp lives under `.git/docsmith/stamp.json` - inside `.git/`, which is
 * never committed and always per-clone. Deliberately NOT committed to the
 * tracked tree:
 *
 * - The stamp reflects local `~/.config/swarm-tools/swarm.db` state, which
 *   is itself per-machine (not shared, not committed). A committed stamp
 *   pointing at one contributor's local DB snapshot would misreport
 *   staleness for every other contributor whose local DB has a different
 *   corpus (different closed-cell history, different memory rows) -
 *   actively misleading rather than merely stale.
 * - `docs generate` is an on-demand, human/agent-invoked action (it can
 *   take minutes with the classifier on), not something CI runs per
 *   commit. Each contributor's local check answering "did *I* just grow
 *   the corpus without regenerating" is exactly the right scope for a
 *   pre-push gate that's supposed to nag the person about to push, not
 *   assert a shared team-wide fact.
 * - A committed stamp file would also become a routine merge-conflict
 *   surface (every generate run touches it) for a file with zero
 *   human-readable value once merged.
 */
export function stampPath(repoPath: string): string {
  return join(repoPath, '.git', 'docsmith', 'stamp.json');
}

export function readStamp(repoPath: string): DocsStamp | null {
  const path = stampPath(repoPath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DocsStamp;
  } catch {
    return null;
  }
}

export function writeStamp(repoPath: string, stamp: DocsStamp): void {
  const path = stampPath(repoPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(stamp, null, 2));
}

export type StalenessReason =
  | 'no-stamp'
  | 'corpus-changed'
  | 'project-key-changed'
  | 'fresh';

export interface StalenessResult {
  stale: boolean;
  reason: StalenessReason;
  current: CorpusFingerprint;
  stamp: DocsStamp | null;
}

export interface CheckStalenessOptions {
  client: Client;
  projectKey: string;
  repoPath: string;
}

/** Compares the current corpus fingerprint against the last-written stamp. Never touches git. */
export async function checkStaleness(
  options: CheckStalenessOptions,
): Promise<StalenessResult> {
  const current = await computeCorpusFingerprint(
    options.client,
    options.projectKey,
  );
  const stamp = readStamp(options.repoPath);

  if (!stamp) {
    return { stale: true, reason: 'no-stamp', current, stamp: null };
  }
  if (stamp.projectKey !== options.projectKey) {
    return { stale: true, reason: 'project-key-changed', current, stamp };
  }
  if (
    stamp.rowCount !== current.rowCount ||
    stamp.maxUpdatedAt !== current.maxUpdatedAt
  ) {
    return { stale: true, reason: 'corpus-changed', current, stamp };
  }
  return { stale: false, reason: 'fresh', current, stamp };
}
