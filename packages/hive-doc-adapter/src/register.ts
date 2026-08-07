/**
 * Register translation: internal coordination vocabulary -> external prose.
 *
 * Hive cell text (descriptions, closure narratives, comments) is written by
 * and for AI coordination agents. It is full of process vocabulary — swarm,
 * worker, coordinator, cell, subtask, agent, session — plus generated agent
 * codenames (e.g. "DarkOcean", "WarmFire"). None of that has a field in the
 * IR (see ir/types.ts) and none of it should reach a generated doc: a reader
 * must not be able to tell how the work was organized.
 *
 * Approach: deterministic term-stripping + a curated set of structural
 * rewrite templates, NOT an LLM pass. Justification:
 *
 * - Testability: this runs at extraction/build time and must be assertable
 *   in a unit test with a fixed input/output pair. An LLM rewrite is not
 *   reproducible across runs, which breaks the sibling drift-detection cell
 *   (regeneration has to be idempotent against the same source data).
 * - Fact preservation: the hard constraint is "losing '23.79ms vs 38.64ms'
 *   is not fine." A generative rewrite can silently paraphrase or drop a
 *   number, a flag name, or a file path. A term-substitution pass structurally
 *   cannot touch anything it doesn't match — numbers, commands, and paths are
 *   never in the pattern set, so they pass through untouched by construction.
 * - Cost/latency: this can run over hundreds of records; a regex pass is
 *   effectively free, an LLM call per record is not.
 *
 * Honest limitation: this is NOT a general-purpose passivizer. It handles
 * the sentence shapes actually observed in this corpus (mined from real
 * hive data, see register.test.ts) plus the shapes given in the extraction
 * brief. A subject-led sentence with a verb outside the known list falls
 * through to the generic subject-drop rule, which is leakage-safe (no
 * process noun survives) but may read as a sentence fragment rather than
 * polished prose. If that turns out to be common on a larger corpus, the
 * fix is to grow the verb table, not to reach for an LLM — growing the
 * table keeps the transform deterministic and testable; an LLM pass would
 * trade that guarantee away for prose polish this extraction layer doesn't
 * need (generators are free to do further light editing downstream).
 */

// ============================================================================
// Agent identity stripping
// ============================================================================

/**
 * Agent codenames in this system follow an Adjective+Noun compound pattern
 * (e.g. DarkOcean, WarmFire, QuickWolf, BlueStone) — confirmed against the
 * live `agents` table. Static role words (coordinator, worker) are handled
 * separately below since they're common nouns, not proper-noun codenames.
 */
const AGENT_CODENAME_PATTERN =
  /\b(?:Dark|Warm|Cold|Blue|Red|Green|Silver|Gold|Quick|Slow|Bright|Calm|Wild|Swift)(?:Ocean|Fire|Wind|Wave|Cloud|Wolf|Hawk|Fox|Bear|Sky|Star|Moon|Sun|Frost|Shadow|Ember|Blaze|Peak|Stone|Storm|Dusk|Mountain|Falcon)\b/g;

/** Build a denylist regex from live agent names (e.g. from the `agents` table). */
export function buildAgentNamePattern(knownNames: string[]): RegExp | null {
  const escaped = knownNames
    .filter((n) => n && n.length > 1)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return null;
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "g");
}

// ============================================================================
// Process-noun matching (word-boundary, code/identifier-safe)
// ============================================================================

/**
 * Matches process nouns as English words only — never as part of a
 * hyphenated package/file name (swarm-mail, swarm-tools, swarm.db), a
 * snake_case tool/function identifier (swarm_adversarial_review,
 * swarm_complete), or an inline code span (`cell_id`, `bead_comments`).
 * This is what makes "swarm-mail test suite" survive untouched while
 * "the swarm ran the test suite" gets rewritten.
 */
const PROCESS_NOUNS = [
  "swarm",
  "worker",
  "workers",
  "coordinator",
  "coordinators",
  "subtask",
  "subtasks",
  "agent",
  "agents",
] as const;

function isCodeAdjacent(
  text: string,
  index: number,
  matchLength: number,
): boolean {
  const before = text[index - 1];
  const after = text[index + matchLength];
  // hyphenated/underscored/dotted compound identifier
  if (before === "-" || before === "_" || before === "." || before === "`")
    return true;
  if (after === "-" || after === "_" || after === "." || after === "`")
    return true;
  return false;
}

function stripCodeSpans(text: string): { stripped: string; spans: string[] } {
  const spans: string[] = [];
  const stripped = text.replace(/`[^`]*`/g, (m) => {
    spans.push(m);
    return `\u0000${spans.length - 1}\u0000`;
  });
  return { stripped, spans };
}

function restoreCodeSpans(text: string, spans: string[]): string {
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => spans[Number(i)] ?? "");
}

// ============================================================================
// Structural rewrite templates
// ============================================================================

/**
 * Irregular past-tense -> participle map. Regular -ed verbs need no entry
 * (past tense === participle for them, which covers most verbs actually
 * observed in this corpus: scaffolded, fixed, verified, confirmed, deleted,
 * matched, reproduced, resolved, implemented, closed, opened, patched...).
 */
const IRREGULAR_PARTICIPLES: Record<string, string> = {
  ran: "run",
  wrote: "written",
  did: "done",
  found: "found",
  gave: "given",
  took: "taken",
  built: "built",
  made: "made",
  sent: "sent",
  kept: "kept",
  left: "left",
  chose: "chosen",
  broke: "broken",
  spoke: "spoken",
  saw: "seen",
  spent: "spent",
  bought: "bought",
  brought: "brought",
  thought: "thought",
  caught: "caught",
  drove: "driven",
  began: "begun",
  went: "gone",
  came: "came",
  knew: "known",
};

function toParticiple(verbPast: string): string {
  return IRREGULAR_PARTICIPLES[verbPast.toLowerCase()] ?? verbPast;
}

/** Heuristic: does this object clause read as plural? */
function wasWere(objectClause: string): "was" | "were" {
  const trimmed = objectClause.trim();
  const leadingNumber = trimmed.match(/^([\d,]+)\s+([a-zA-Z-]+)/);
  if (leadingNumber) {
    const n = Number(leadingNumber[1].replace(/,/g, ""));
    if (!Number.isNaN(n) && n !== 1) return "were";
    if (!Number.isNaN(n) && n === 1) return "was";
  }
  const firstWord = trimmed.match(/^([a-zA-Z-]+)/)?.[1];
  if (firstWord && /s$/i.test(firstWord) && !/(ss|us|is)$/i.test(firstWord)) {
    return "were";
  }
  return "was";
}

const ACTOR =
  "(?:the |a |an |this |that )?(?:swarm|worker|workers|coordinator|agent|agents)";

/**
 * "<actor> <verb-past> <object clause up to . ; or end>" -> "<object> was/were <participle>"
 * Covers: "worker fixed X" -> "X was fixed"; "the swarm scaffolded 61 packages" -> "61 packages were scaffolded"
 */
const ACTOR_VERB_OBJECT = new RegExp(
  `\\b${ACTOR}\\s+([a-z]+ed|ran|wrote|did|found|gave|took|built|made|sent|kept|left|chose|broke|spoke|saw|spent|bought|brought|thought|caught|drove|began|went|came|knew)\\s+([^.;\\n]+?)([.;]|$)`,
  "gi",
);

/**
 * Mechanism-only clauses that describe *how coordination happened* rather
 * than *what happened*. Per the brief: "coordinator spawned a subtask to
 * do X" -> drop the mechanism, keep the outcome "X". These are dropped
 * entirely rather than rewritten, since there is no externally-meaningful
 * fact in "who dispatched work to whom."
 */
const MECHANISM_CLAUSES: RegExp[] = [
  // "coordinator spawned a subtask to <outcome>" -> "<outcome>"
  new RegExp(
    `\\b${ACTOR}\\s+spawned\\s+(?:a |an )?(?:subtask|worker|agent)s?\\s+to\\s+`,
    "gi",
  ),
  // "sent via swarm mail (message N)" / "documented in swarm mail" -> dropped
  /\bsent\s+via\s+swarm\s+mail(?:\s*\(message\s+\d+\))?/gi,
  /\bvia\s+swarm\s+mail(?:\s*\(message\s+\d+\))?/gi,
  // bare "swarm mail (message N)" mention
  /\bswarm\s+mail\s*\(message\s+\d+\)/gi,
];

/**
 * Generic fallback: an actor-led clause with a verb outside the known list.
 * Drops the actor phrase and leaves the verb active. Leakage-safe (no
 * process noun survives) even though it isn't full passive voice.
 * e.g. "the swarm verified the fix" -> "Verified the fix"
 */
const ACTOR_LEADING = new RegExp(`\\b${ACTOR}\\s+`, "gi");

function applyStructuralRules(text: string): string {
  let out = text;

  for (const clause of MECHANISM_CLAUSES) {
    out = out.replace(clause, "");
  }

  out = out.replace(
    ACTOR_VERB_OBJECT,
    (_m, verb: string, object: string, terminator: string) => {
      const obj = object.trim();
      const participle = toParticiple(verb.toLowerCase());
      const copula = wasWere(obj);
      return `${obj} ${copula} ${participle}${terminator}`;
    },
  );

  out = out.replace(ACTOR_LEADING, "");

  return out;
}

/** Strip standalone (non-code-adjacent) process nouns not caught by structural rules. */
function stripResidualProcessNouns(text: string): string {
  let out = text;
  for (const noun of PROCESS_NOUNS) {
    const re = new RegExp(`\\b${noun}\\b`, "gi");
    out = out.replace(re, (match, offset: number) => {
      if (isCodeAdjacent(out, offset, match.length)) return match;
      return "";
    });
  }
  // collapse whitespace left behind by removals
  out = out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;])/g, "$1");
  return out;
}

function stripAgentNames(
  text: string,
  agentNamePattern: RegExp | null,
): string {
  let out = text.replace(AGENT_CODENAME_PATTERN, "");
  if (agentNamePattern) {
    out = out.replace(agentNamePattern, "");
  }
  return out;
}

/**
 * Capitalizes the first letter of each sentence after subject-drop leaves a
 * lowercase opener (e.g. "fix the SQL injection..." -> "Fix the SQL
 * injection..."). Skips anything that looks like a code identifier
 * (camelCase, or followed by "_" or "(") so getDatabasePath() and
 * swarm_complete never get mangled into GetDatabasePath()/Swarm_complete.
 */
function capitalizeSentences(text: string): string {
  return text.replace(
    /(^|[.!?]\s+)([a-z])/g,
    (match, prefix: string, letter: string, offset: number, full: string) => {
      const rest = full.slice(offset + prefix.length);
      const word = rest.match(/^[a-zA-Z]+/)?.[0] ?? letter;
      const afterWord = rest.slice(word.length);
      // followed by "_" or "(" -> identifier (swarm_complete, getDatabasePath());
      // followed by "." + non-space -> filename/version (bunfig.toml, cursor.ts, v1.2)
      const followedByIdentifierChar =
        /^[_(]/.test(afterWord) || /^\.\S/.test(afterWord);
      const isCamelCase = /[A-Z]/.test(word);
      if (isCamelCase || followedByIdentifierChar) return match;
      return prefix + letter.toUpperCase();
    },
  );
}

function cleanupWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([.,;:!?])/g, "$1")
        .replace(/^[ \t]+/g, "")
        .replace(/[ \t]+$/g, ""),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface TranslateOptions {
  /** Live agent names (from the `agents` table) to strip in addition to the codename pattern. */
  knownAgentNames?: string[];
}

/**
 * Translate internal coordination-register text into external prose.
 * Preserves code spans (backtick-fenced) verbatim — technical identifiers
 * inside them (cell_id, bead_comments, swarm_complete) are facts, not
 * process-vocabulary leakage.
 */
export function translateRegister(
  text: string,
  options: TranslateOptions = {},
): string {
  if (!text) return text;

  const { stripped, spans } = stripCodeSpans(text);

  let out = stripAgentNames(
    stripped,
    buildAgentNamePattern(options.knownAgentNames ?? []),
  );
  out = applyStructuralRules(out);
  out = stripResidualProcessNouns(out);
  out = capitalizeSentences(out);
  out = cleanupWhitespace(out);

  return restoreCodeSpans(out, spans);
}

/**
 * Denylist used by both this module's own tests and (optionally) by
 * callers who want a cheap leakage check without re-running translation.
 * Deliberately excludes generic English words that happen to overlap with
 * schema/table names (e.g. "cell", "bead") — those are ambiguous between
 * "SQLite table" (a technical fact, fine in provenance sourceRef) and
 * "work item" (process vocabulary, not fine in narrative prose). The
 * sibling sanitization gate is the authoritative enforcement point for
 * the full policy; this list covers the unambiguous actor/mechanism nouns.
 */
export const LEAKAGE_DENYLIST = [
  "swarm",
  "worker",
  "coordinator",
  "subtask",
  "agent",
] as const;

/** True if any denylisted term appears as a standalone word outside code spans. */
export function hasLeakage(text: string, extraTerms: string[] = []): boolean {
  const { stripped } = stripCodeSpans(text);
  const terms = [...LEAKAGE_DENYLIST, ...extraTerms];
  for (const term of terms) {
    const re = new RegExp(`\\b${term}\\b`, "i");
    const match = re.exec(stripped);
    if (match && !isCodeAdjacent(stripped, match.index, match[0].length)) {
      return true;
    }
  }
  return false;
}
