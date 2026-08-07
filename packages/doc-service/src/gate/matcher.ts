/**
 * Text-matching primitives for the sanitization gate. Independent of the
 * corpus shape — everything here operates on a plain string and returns
 * character-offset matches, which the gate module maps back onto corpus
 * fields.
 *
 * Design note on why this isn't naive substring matching: several denylist
 * words are also common English/technical vocabulary ("worker", "agent",
 * "cell"). Three layers keep false positives down without hand-tuning to
 * any one corpus:
 *
 * 1. Word-boundary + code-adjacency: `\bswarm\b` never matches inside
 *    `swarm-mail`, `swarm_complete`, or `swarm.db` (checked structurally —
 *    hyphen/underscore/dot/backtick-adjacent — not via a hardcoded list of
 *    package names).
 * 2. Code exemption: fenced code blocks and inline code spans are masked
 *    out entirely before matching. A code sample referencing
 *    `swarm_complete` is a factual API reference, not a leak.
 * 3. Allowlist + contextual matching: an explicit phrase allowlist
 *    (`swarm-mail`, `web worker`, `user agent`, ...) exempts known-good
 *    compounds; a small set of highly-ambiguous terms ("cell", "hive")
 *    additionally require sentence-level process context before matching
 *    at all, rather than firing on every occurrence.
 */

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Code masking — fenced blocks and inline spans are never inspected
// ============================================================================

function markRanges(text: string, re: RegExp, mask: boolean[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = re.exec(text))) {
    for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = true;
    if (m[0].length === 0) re.lastIndex++;
  }
}

/** True for every character position inside a fenced code block or inline code span. */
export function buildCodeMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  markRanges(text, /```[\s\S]*?```/g, mask);
  markRanges(text, /`[^`]*`/g, mask);
  return mask;
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

function rangeMasked(mask: boolean[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (mask[i]) return true;
  return false;
}

/**
 * A hyphen/underscore/dot/backtick immediately before or after a match means
 * it's part of a compound identifier (swarm-mail, swarm_complete, swarm.db),
 * not a standalone word — even outside an actual code span. Mirrors
 * hive-doc-adapter's register.ts `isCodeAdjacent`.
 */
export function isCodeAdjacent(
  text: string,
  index: number,
  matchLength: number,
): boolean {
  const before = text[index - 1];
  const after = text[index + matchLength];
  if (before === "-" || before === "_" || before === "." || before === "`")
    return true;
  if (after === "-" || after === "_" || after === "." || after === "`")
    return true;
  return false;
}

// ============================================================================
// Matches
// ============================================================================

export interface RawMatch {
  term: string;
  index: number;
  length: number;
  matchedText: string;
}

/** Standalone-word match: word-boundary, not code-masked, not code-adjacent, not allowlisted. */
export function findWordMatches(
  text: string,
  term: string,
  codeMask: boolean[],
  allowlistMask: boolean[],
): RawMatch[] {
  const out: RawMatch[] = [];
  const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi");
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (
      !rangeMasked(codeMask, start, end) &&
      !rangeMasked(allowlistMask, start, end) &&
      !isCodeAdjacent(text, start, m[0].length)
    ) {
      out.push({ term, index: start, length: m[0].length, matchedText: m[0] });
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** Fixed-phrase match (multi-word bigrams etc.), code-masked but not allowlist-checked (phrases are themselves the strong signal). */
export function findPhraseMatches(
  text: string,
  phrases: string[],
  codeMask: boolean[],
): RawMatch[] {
  const out: RawMatch[] = [];
  for (const phrase of phrases) {
    const trimmed = phrase.trim();
    if (!trimmed) continue;
    const pattern = escapeRegExp(trimmed).replace(/\s+/g, "\\s+");
    const re = new RegExp(`\\b${pattern}\\b`, "gi");
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!rangeMasked(codeMask, start, end)) {
        out.push({
          term: trimmed,
          index: start,
          length: m[0].length,
          matchedText: m[0],
        });
      }
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out;
}

interface Sentence {
  start: number;
  end: number;
  text: string;
}

function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  const re = /[^.!?\n]+(?:[.!?]+|\n+|$)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = re.exec(text))) {
    if (m[0].trim().length === 0) continue;
    sentences.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return sentences;
}

export interface ContextualTermDef {
  term: string;
  alwaysLeakPhrases: string[];
}

/**
 * Matches an ambiguous term two ways:
 *  1. Always-leak bigrams ("hive cell") — unambiguous on their own.
 *  2. Sentence-context: a standalone occurrence of the term co-occurring,
 *     in the same sentence, with either an unambiguous process word or an
 *     id-shaped token. A bare "cell" with neither signal present is left
 *     alone (spreadsheet/table/prison/battery cell and friends).
 *
 * This is deliberately structural (sentence co-occurrence + id shape) and
 * not a memorized phrase list, so it generalizes past the sample corpus a
 * given project's gate was first tuned against.
 */
export function findContextualMatches(
  text: string,
  def: ContextualTermDef,
  codeMask: boolean[],
  allowlistMask: boolean[],
  processTerms: readonly string[],
  idShapePattern: RegExp,
): RawMatch[] {
  const out: RawMatch[] = [];

  if (def.alwaysLeakPhrases.length > 0) {
    out.push(...findPhraseMatches(text, def.alwaysLeakPhrases, codeMask));
  }

  const standalone = findWordMatches(text, def.term, codeMask, allowlistMask);
  if (standalone.length === 0) return out;

  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    const inSentence = standalone.filter(
      (m) => m.index >= sentence.start && m.index < sentence.end,
    );
    if (inSentence.length === 0) continue;

    const hasProcessContext = processTerms.some((term) => {
      const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
      const m = re.exec(sentence.text);
      if (!m) return false;
      return !isCodeAdjacent(sentence.text, m.index, m[0].length);
    });

    idShapePattern.lastIndex = 0;
    const hasIdContext = idShapePattern.test(sentence.text);

    if (hasProcessContext || hasIdContext) {
      out.push(...inSentence);
    }
  }

  return out;
}

// ============================================================================
// AI-slop prose markers — heuristic, intentionally warn-tier (see gate README)
// ============================================================================

export interface SlopFinding {
  marker: string;
  index: number;
  length: number;
}

function collectSlop(
  text: string,
  codeMask: boolean[],
  re: RegExp,
  label: string,
  out: SlopFinding[],
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (!rangeMasked(codeMask, start, end)) {
      out.push({ marker: label, index: start, length: m[0].length });
    }
    if (m[0].length === 0) re.lastIndex++;
  }
}

/**
 * Detects the AI-slop prose markers from the brief. All heuristic: "leverage"
 * and "robust" have legitimate technical senses that can't be reliably told
 * apart from filler usage by regex, so both use a narrow trigger pattern
 * biased toward precision over recall, and the whole category defaults to
 * warn severity (see sanitization-gate.ts) rather than failing the build.
 */
export function findSlopMarkers(
  text: string,
  codeMask: boolean[],
): SlopFinding[] {
  const out: SlopFinding[] = [];

  collectSlop(text, codeMask, /\bdelv(?:e|es|ed|ing)\b/gi, "delve", out);
  collectSlop(text, codeMask, /\bseamlessly?\b/gi, "seamless", out);
  collectSlop(
    text,
    codeMask,
    /\bit'?s\s+worth\s+noting\b/gi,
    "it's worth noting",
    out,
  );
  collectSlop(
    text,
    codeMask,
    /\bin\s+today'?s\s+(?:fast-paced|ever-evolving|rapidly[\s-]evolving)\s+\w+/gi,
    "in today's fast-paced X",
    out,
  );
  // "leverage" as a verb: followed by a determiner + object, the classic
  // "leverage the power of X" slop shape. "financial leverage" / "leverage
  // ratio" (noun usage) don't match this pattern and pass through.
  collectSlop(
    text,
    codeMask,
    /\bleverag(?:e|es|ed|ing)\s+(?:the|a|an|our|its|your|their)\b/gi,
    "leverage (as verb)",
    out,
  );
  // "robust" as filler: flagged unless immediately followed by one of a
  // small set of concrete technical collocations where it's doing real
  // work ("robust error handling", "robust type system", ...).
  collectSlop(
    text,
    codeMask,
    /\brobust\b(?!\s+(?:error[\s-]handling|testing|type(?:[\s-](?:system|checking|safety))?|validation|retry(?:\s+logic)?|logging|authentication|input\s+handling|api))/gi,
    "robust (filler)",
    out,
  );

  // furthermore/moreover/additionally chain: 2+ occurrences in one field.
  const chainMatches: RawMatch[] = [];
  const chainRe = /\b(?:furthermore|moreover|additionally)\b/gi;
  let cm: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((cm = chainRe.exec(text))) {
    if (!rangeMasked(codeMask, cm.index, cm.index + cm[0].length)) {
      chainMatches.push({
        term: cm[0],
        index: cm.index,
        length: cm[0].length,
        matchedText: cm[0],
      });
    }
    if (cm[0].length === 0) chainRe.lastIndex++;
  }
  if (chainMatches.length >= 2) {
    for (const match of chainMatches) {
      out.push({
        marker: "furthermore/moreover chain",
        index: match.index,
        length: match.length,
      });
    }
  }

  // Tricolon padding: "X, Y, and Z" of short adjective-shaped words. Low
  // confidence — a real enumerated list ("supports Node, Deno, and Bun")
  // has the identical shape. Excluded when preceded by an enumeration cue
  // (e.g., such as/including/like/e.g.) to cut the worst false positives;
  // still likely to both over- and under-fire on any given corpus, which is
  // why this stays warn-tier rather than becoming a hard failure.
  const tricolonRe =
    /\b([a-z][a-z-]{2,14}),\s+([a-z][a-z-]{2,14}),?\s+and\s+([a-z][a-z-]{2,14})\b/gi;
  let tm: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((tm = tricolonRe.exec(text))) {
    const before = text.slice(Math.max(0, tm.index - 24), tm.index);
    if (/(?:e\.g\.|such as|including|like)\s*$/i.test(before)) continue;
    const start = tm.index;
    const end = start + tm[0].length;
    if (!rangeMasked(codeMask, start, end)) {
      out.push({
        marker: "tricolon padding (heuristic, low confidence)",
        index: start,
        length: tm[0].length,
      });
    }
    if (tm[0].length === 0) tricolonRe.lastIndex++;
  }

  return out;
}

export function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}
