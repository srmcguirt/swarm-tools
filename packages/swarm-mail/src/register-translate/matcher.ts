/**
 * Vendored from doc-service's gate/matcher.ts (srmcguirt/docsmith). Trimmed
 * to only the pieces translate-register.ts actually uses —
 * `buildAllowlistMask` and its two helpers. doc-service and hive-doc-adapter
 * were extracted to a private external repo; this is the zero-dependency
 * subset swarm-mail's export-sanitization boundary needs, kept local rather
 * than pulled via a git dependency (bun has no subdirectory git-dep
 * support) or an npm publish (would make previously-private code public —
 * a call left to a human, not made silently here). See
 * export-sanitize.ts for the consumer and translate-register.ts for the
 * caller.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markRanges(text: string, re: RegExp, mask: boolean[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = re.exec(text))) {
    for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = true;
    if (m[0].length === 0) re.lastIndex++;
  }
}

/** True for every character position covered by an allowlisted phrase. */
export function buildAllowlistMask(
  text: string,
  allowlist: string[],
): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  for (const phrase of allowlist) {
    const trimmed = phrase.trim();
    if (!trimmed) continue;
    const pattern = escapeRegExp(trimmed).replace(/\s+/g, "\\s+");
    markRanges(text, new RegExp(`\\b${pattern}\\b`, "gi"), mask);
  }
  return mask;
}
