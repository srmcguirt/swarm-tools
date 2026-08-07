/**
 * Sanitization for git-tracked export artifacts (.hive/issues.jsonl,
 * .hive/memories.jsonl).
 *
 * These files are committed and pushed to a public remote. Cell
 * descriptions and memory content accumulate internal coordination
 * vocabulary (swarm, worker, coordinator, subtask, agent) as sessions run.
 * This module strips that register at the git-write boundary only.
 *
 * Reuses hive-doc-adapter's `translateRegister`, which shares its
 * allowlist/denylist with doc-service's sanitization gate — see
 * hive-doc-adapter/src/register.ts. Not reimplemented here: a second
 * hand-rolled transform would drift from the gate's definition of leakage.
 *
 * Boundary: only called from the two actual git-write sites
 * (FlushManager.flush() for issues.jsonl, syncMemories() for
 * memories.jsonl) — never from the read/query paths that hydrate the
 * local database, so local DB rows always keep full-fidelity text.
 *
 * @module export-sanitize
 */

import { translateRegister } from "hive-doc-adapter";

/**
 * Sanitize a single text field for the git-tracked export. Idempotent —
 * running it twice on already-sanitized text is a no-op (guaranteed by
 * translateRegister's own idempotency).
 */
export function sanitizeForGitExport(
  text: string | undefined,
): string | undefined {
  if (!text) return text;
  return translateRegister(text);
}
