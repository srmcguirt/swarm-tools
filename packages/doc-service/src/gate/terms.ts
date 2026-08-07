/**
 * Default term sets for the sanitization gate. Two tiers, chosen because a
 * single denylist can't serve both "swarm" and "cell" without either
 * missing real leakage or flagging every spreadsheet doc in existence:
 *
 * - `DEFAULT_PROCESS_TERMS`: nouns that are unambiguous process vocabulary
 *   in the vast majority of English technical prose — a false positive
 *   requires a genuinely unusual sentence ("the bead necklace" is the kind
 *   of edge case that exists, but is rare enough in project documentation
 *   to accept). Matched as standalone words anywhere outside code
 *   spans/blocks and outside an allowlisted phrase (see matcher.ts).
 * - `DEFAULT_CONTEXTUAL_TERMS`: nouns that collide heavily with ordinary
 *   English/technical vocabulary (spreadsheet cell, table cell, prison
 *   cell, cell biology, Apache Hive, beehive...) and are therefore matched
 *   only when either (a) they appear in a short bigram that is essentially
 *   never innocent ("hive cell"), or (b) they co-occur in the same
 *   sentence with an unambiguous process term or an id-shaped token (the
 *   `<project>--<slug>` / `hive:<id>` pattern hive-style trackers emit).
 *   See matcher.ts `findContextualMatches`.
 *
 * "worker" and "agent" are extremely common in web/systems programming
 * (web worker, service worker, user agent) but are kept in the hard-fail
 * tier rather than moved to contextual: the collision is with a *specific,
 * enumerable* set of compound phrases, which the allowlist below covers
 * directly, rather than an open-ended set of ordinary-English senses the
 * way "cell" and "hive" are. If a project's docs are legitimately full of
 * "worker" in senses not covered by `DEFAULT_ALLOWLIST`, extend the
 * allowlist — that is the intended per-project escape hatch, not disabling
 * the term.
 */
export const DEFAULT_PROCESS_TERMS = [
  "swarm",
  "worker",
  "workers",
  "coordinator",
  "coordinators",
  "subtask",
  "subtasks",
  "agent",
  "agents",
  "bead",
  "beads",
] as const;

export interface ContextualTermDef {
  term: string;
  /** Short phrases containing this term that are leakage on their own, no sentence context needed. */
  alwaysLeakPhrases: string[];
}

export const DEFAULT_CONTEXTUAL_TERMS: ContextualTermDef[] = [
  { term: "cell", alwaysLeakPhrases: ["hive cell", "hive cells"] },
  { term: "cells", alwaysLeakPhrases: ["hive cell", "hive cells"] },
  {
    term: "hive",
    alwaysLeakPhrases: [
      "hive cell",
      "hive cells",
      "hive data",
      "hive database",
      "hive db",
    ],
  },
];

/**
 * Default id-shape pattern for the contextual sentence-context rule:
 * hive-style trackers emit ids like "katas--w5hg2-msj0nhchrv2" or
 * "hive:katas--w5hg2-msj0nhchrv2". Matching the *shape* of that id scheme
 * (not this project's literal ids) is what keeps the rule general across
 * projects and corpus scale rather than overfit to one dataset — any
 * hive-based project's ids follow this same `<project>--<slug>` shape.
 */
export const DEFAULT_ID_SHAPE_PATTERN =
  "\\b(?:hive|git):[a-z0-9._-]+\\b|\\b[a-z][a-z0-9]*--[a-z0-9]+(?:-[a-z0-9]+)*\\b";

/**
 * Phrases that are legitimate technical usage of a word that also appears
 * in `DEFAULT_PROCESS_TERMS`/`DEFAULT_CONTEXTUAL_TERMS`. Covers the
 * concrete examples called out in the design brief (web workers, user
 * agent, swarm-mail as a real package name) plus the common English senses
 * of "cell" that would otherwise false-positive relentlessly in any doc
 * corpus that isn't 100% about this coordination system.
 */
export const DEFAULT_ALLOWLIST = [
  "web worker",
  "web workers",
  "worker thread",
  "worker threads",
  "worker pool",
  "worker pools",
  "service worker",
  "service workers",
  "user agent",
  "user agents",
  "spreadsheet cell",
  "spreadsheet cells",
  "table cell",
  "table cells",
  "fuel cell",
  "fuel cells",
  "stem cell",
  "stem cells",
  "prison cell",
  "battery cell",
  "battery cells",
  "cell phone",
  "cell tower",
  "cell biology",
  "swarm-mail",
  "swarm-tools",
  "swarm-queue",
  "swarm.db",
];

/**
 * Phrases that indicate a model/product is naming itself in the text. Kept
 * to multi-word product names deliberately: bare "Claude" or "Gemini" are
 * plausible human first names / other-product names and are excluded from
 * the default set to avoid flagging real attribution (e.g. a person named
 * Claude reviewed the PR). Projects with a closed set of known bot/agent
 * accounts should add exact names via `agentNames`, not loosen this list.
 *
 * "opencode" is deliberately absent even as a bare word: it's a real CLI
 * tool name that gets referenced constantly and factually in engineering
 * narratives ("the opencode server process", "opencode-swarm-plugin") —
 * exactly the false-positive shape this gate is designed to avoid. The
 * "Generated with opencode" attribution pattern is still caught separately
 * by the narrower, prefix-anchored `ATTRIBUTION_PATTERNS` in
 * sanitization-gate.ts, which only fires on the actual trailer phrase.
 */
export const DEFAULT_MODEL_NAME_PHRASES = [
  "gpt-4",
  "gpt-3.5",
  "gpt-3",
  "chatgpt",
  "claude sonnet",
  "claude opus",
  "claude haiku",
  "claude code",
  "gemini pro",
  "gemini flash",
  "gemini ultra",
  "github copilot",
  "copilot chat",
  "llama 2",
  "llama 3",
  "mistral large",
];

/**
 * Adjective+Noun agent codename pattern. Mirrors the pattern
 * hive-doc-adapter's register.ts uses at extraction time — duplicated
 * rather than imported, since doc-service must not depend on
 * hive-doc-adapter (portability boundary: doc-service has exactly one
 * runtime dependency, zod). This is the gate's final backstop in case a
 * codename survives extraction-time stripping (e.g. a hand-authored doc
 * that never went through the adapter).
 */
export const DEFAULT_AGENT_CODENAME_PATTERN =
  "\\b(?:Dark|Warm|Cold|Blue|Red|Green|Silver|Gold|Quick|Slow|Bright|Calm|Wild|Swift)(?:Ocean|Fire|Wind|Wave|Cloud|Wolf|Hawk|Fox|Bear|Sky|Star|Moon|Sun|Frost|Shadow|Ember|Blaze|Peak|Stone|Storm|Dusk|Mountain|Falcon|Lake)\\b";
