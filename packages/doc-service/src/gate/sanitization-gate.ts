/**
 * The sanitization gate: authoritative policy enforcement over an assembled
 * `DocumentationCorpus`, run as the last step before any generator sees it
 * (see doc-service/README.md "Sanitization boundary"). Fails the build on
 * leakage rather than warning — see module-level rationale in the design
 * brief this shipped against: a warning gets ignored, and this is the last
 * line of defense before content becomes public under a real name.
 *
 * Four categories, three enforcement tiers:
 *
 * 1. Internal process vocabulary (swarm/worker/coordinator/subtask/agent/
 *    bead hard-fail; cell/hive contextual) — error.
 * 2. Agent-identifying information (codenames, known agent names, model/
 *    product self-identification phrases) — error.
 * 3. AI attribution trailers (Co-Authored-By: <bot>, "Generated with", 🤖)
 *    — error.
 * 4. AI-slop prose markers (delve, leverage-as-verb, seamless, robust-as-
 *    filler, "it's worth noting", furthermore chains, tricolon padding) —
 *    warn by default, configurable to error per project. These markers
 *    cannot be reliably separated from legitimate usage by regex (a
 *    "robust type system" and empty "robust" filler look identical to a
 *    pattern matcher); the brief is explicit that an unreliable check
 *    should stay a warning rather than a hard failure that eventually gets
 *    disabled out of frustration. See matcher.ts `findSlopMarkers` for the
 *    per-marker heuristics and their known blind spots.
 *
 * See matcher.ts for why this isn't naive substring matching (word
 * boundaries, code-block/span exemption, allowlist, sentence-context
 * matching for ambiguous terms).
 */

import type { SanitizationConfig } from "../config/schema.js";
import type { DocumentationCorpus } from "../ir/types.js";
import {
  buildAllowlistMask,
  buildCodeMask,
  findContextualMatches,
  findPhraseMatches,
  findSlopMarkers,
  findWordMatches,
  snippet,
} from "./matcher.js";
import {
  DEFAULT_AGENT_CODENAME_PATTERN,
  DEFAULT_ALLOWLIST,
  DEFAULT_CONTEXTUAL_TERMS,
  DEFAULT_ID_SHAPE_PATTERN,
  DEFAULT_MODEL_NAME_PHRASES,
  DEFAULT_PROCESS_TERMS,
} from "./terms.js";
import { type CorpusField, walkCorpusText } from "./walk-corpus.js";

export type GateCategory =
  | "process-vocabulary"
  | "agent-identity"
  | "ai-attribution"
  | "ai-slop";

export type GateSeverity = "error" | "warn";

export interface GateViolation {
  category: GateCategory;
  severity: GateSeverity;
  term: string;
  recordType: CorpusField["recordType"];
  recordId: string;
  field: string;
  snippet: string;
}

export interface GateResult {
  passed: boolean;
  errors: GateViolation[];
  warnings: GateViolation[];
}

export class SanitizationGateError extends Error {
  constructor(public readonly violations: GateViolation[]) {
    super(
      `Sanitization gate failed with ${violations.length} violation(s):\n${violations
        .map(
          (v) =>
            `  - [${v.category}] ${v.recordType} ${v.recordId} (${v.field}): "${v.term}" — ${v.snippet}`,
        )
        .join("\n")}`,
    );
    this.name = "SanitizationGateError";
  }
}

const ASSISTANT_IDENTITY_PATTERNS: RegExp[] = [
  /\bas an ai\b/gi,
  /\bas a large language model\b/gi,
  /\bi(?:'m| am) an ai\b/gi,
  /\bi(?:'m| am) claude\b/gi,
  /\bas claude\b/gi,
  /\bi don'?t have (?:personal|the ability to)\b/gi,
  /\bthis (?:response|summary|document) was (?:generated|written) by (?:an? )?(?:ai|llm|language model|assistant)\b/gi,
];

const ATTRIBUTION_PATTERNS: RegExp[] = [
  /co-authored-by:.*(?:claude|gpt|copilot|chatgpt|openai|anthropic|\bai\b|\bbot\b|assistant)/gi,
  /generated with \[?(?:claude|gpt|copilot|chatgpt|cursor|opencode|ai)/gi,
  /🤖/g,
];

function findRegexMatches(
  text: string,
  patterns: RegExp[],
): { matchedText: string; index: number; length: number }[] {
  const out: { matchedText: string; index: number; length: number }[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
    while ((m = pattern.exec(text))) {
      out.push({ matchedText: m[0], index: m.index, length: m[0].length });
      if (m[0].length === 0) pattern.lastIndex++;
    }
  }
  return out;
}

function resolveList(
  defaults: readonly string[],
  extra: string[],
  disableDefault: boolean,
): string[] {
  return disableDefault ? extra : [...defaults, ...extra];
}

/**
 * Merge a project's `SanitizationConfig` (from `parseProjectConfig`, already
 * zod-defaulted) with an optional caller override — lets tests/callers pass
 * a bare partial config without round-tripping through zod.
 */
export function resolveSanitizationConfig(
  config?: Partial<SanitizationConfig>,
): SanitizationConfig {
  return {
    enabled: config?.enabled ?? true,
    processTerms: config?.processTerms ?? [],
    contextualTerms: config?.contextualTerms ?? [],
    allowlist: config?.allowlist ?? [],
    agentNames: config?.agentNames ?? [],
    modelNamePhrases: config?.modelNamePhrases ?? [],
    disableDefaultProcessTerms: config?.disableDefaultProcessTerms ?? false,
    disableDefaultContextualTerms:
      config?.disableDefaultContextualTerms ?? false,
    disableDefaultAllowlist: config?.disableDefaultAllowlist ?? false,
    disableDefaultModelNamePhrases:
      config?.disableDefaultModelNamePhrases ?? false,
    slopEnabled: config?.slopEnabled ?? true,
    slopSeverity: config?.slopSeverity ?? "warn",
  };
}

function checkField(
  field: CorpusField,
  resolved: SanitizationConfig,
  agentNamePattern: RegExp | null,
  idShapePattern: RegExp,
): GateViolation[] {
  const { text } = field;
  if (!text) return [];

  const violations: GateViolation[] = [];
  const codeMask = buildCodeMask(text);
  const allowlist = resolveList(
    DEFAULT_ALLOWLIST,
    resolved.allowlist,
    resolved.disableDefaultAllowlist,
  );
  const allowlistMask = buildAllowlistMask(text, allowlist);

  const push = (
    category: GateCategory,
    severity: GateSeverity,
    term: string,
    index: number,
    length: number,
  ) => {
    violations.push({
      category,
      severity,
      term,
      recordType: field.recordType,
      recordId: field.recordId,
      field: field.field,
      snippet: snippet(text, index, length),
    });
  };

  // 1. Process vocabulary — hard-fail word terms.
  const processTerms = resolveList(
    DEFAULT_PROCESS_TERMS,
    resolved.processTerms,
    resolved.disableDefaultProcessTerms,
  );
  for (const term of processTerms) {
    for (const m of findWordMatches(text, term, codeMask, allowlistMask)) {
      push("process-vocabulary", "error", m.term, m.index, m.length);
    }
  }

  // 1b. Process vocabulary — contextual (ambiguous) terms. Contextual terms
  // also count as context signals *for each other*: "the hive's cells" has
  // no unambiguous process word in it, but "hive" and "cell" co-occurring
  // in one sentence is itself a strong signal neither word alone provides.
  const contextualDefs = resolved.disableDefaultContextualTerms
    ? []
    : DEFAULT_CONTEXTUAL_TERMS;
  const extraContextualDefs = resolved.contextualTerms.map((term) => ({
    term,
    alwaysLeakPhrases: [] as string[],
  }));
  const allContextualDefs = [...contextualDefs, ...extraContextualDefs];
  const contextualTermWords = allContextualDefs.map((d) => d.term);
  for (const def of allContextualDefs) {
    const contextSignals = [
      ...processTerms,
      ...contextualTermWords.filter((t) => t !== def.term),
    ];
    for (const m of findContextualMatches(
      text,
      def,
      codeMask,
      allowlistMask,
      contextSignals,
      idShapePattern,
    )) {
      push("process-vocabulary", "error", m.term, m.index, m.length);
    }
  }

  // 2. Agent identity — codenames, known agent names, model self-identification.
  if (agentNamePattern) {
    for (const m of findRegexMatches(text, [agentNamePattern])) {
      if (!rangeMaskedLocal(codeMask, m.index, m.index + m.length))
        push("agent-identity", "error", m.matchedText, m.index, m.length);
    }
  }
  const modelPhrases = resolveList(
    DEFAULT_MODEL_NAME_PHRASES,
    resolved.modelNamePhrases,
    resolved.disableDefaultModelNamePhrases,
  );
  for (const m of findPhraseMatches(text, modelPhrases, codeMask)) {
    push("agent-identity", "error", m.term, m.index, m.length);
  }

  // 3. AI attribution trailers.
  for (const m of findRegexMatches(text, ASSISTANT_IDENTITY_PATTERNS)) {
    if (!rangeMaskedLocal(codeMask, m.index, m.index + m.length))
      push("agent-identity", "error", m.matchedText, m.index, m.length);
  }
  for (const m of findRegexMatches(text, ATTRIBUTION_PATTERNS)) {
    if (!rangeMaskedLocal(codeMask, m.index, m.index + m.length))
      push("ai-attribution", "error", m.matchedText, m.index, m.length);
  }

  // 4. AI-slop prose markers — warn by default.
  if (resolved.slopEnabled) {
    for (const finding of findSlopMarkers(text, codeMask)) {
      push(
        "ai-slop",
        resolved.slopSeverity,
        finding.marker,
        finding.index,
        finding.length,
      );
    }
  }

  return violations;
}

function rangeMaskedLocal(
  mask: boolean[],
  start: number,
  end: number,
): boolean {
  for (let i = start; i < end; i++) if (mask[i]) return true;
  return false;
}

/**
 * Run the sanitization gate over a corpus. Never throws — returns a
 * structured result. Use `assertSanitized` to fail the build.
 */
export function runSanitizationGate(
  corpus: DocumentationCorpus,
  config?: Partial<SanitizationConfig>,
): GateResult {
  const resolved = resolveSanitizationConfig(config);
  if (!resolved.enabled) {
    return { passed: true, errors: [], warnings: [] };
  }

  const agentNames = [...resolved.agentNames];
  const agentNamePattern = buildCombinedAgentPattern(agentNames);
  const idShapePattern = new RegExp(DEFAULT_ID_SHAPE_PATTERN, "gi");

  const errors: GateViolation[] = [];
  const warnings: GateViolation[] = [];

  for (const field of walkCorpusText(corpus)) {
    const violations = checkField(
      field,
      resolved,
      agentNamePattern,
      idShapePattern,
    );
    for (const v of violations) {
      if (v.severity === "error") errors.push(v);
      else warnings.push(v);
    }
  }

  return { passed: errors.length === 0, errors, warnings };
}

function buildCombinedAgentPattern(knownNames: string[]): RegExp {
  const escaped = knownNames
    .filter((n) => n && n.length > 1)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = [
    DEFAULT_AGENT_CODENAME_PATTERN.replace(/^\\b|\\b$/g, ""),
    ...escaped,
  ];
  return new RegExp(`\\b(?:${parts.join("|")})\\b`, "gi");
}

/** Run the gate and throw `SanitizationGateError` if any error-severity violation is found. Warnings are attached to the thrown-free return path only — callers that want to surface warnings on a passing run should call `runSanitizationGate` directly. */
export function assertSanitized(
  corpus: DocumentationCorpus,
  config?: Partial<SanitizationConfig>,
): GateResult {
  const result = runSanitizationGate(corpus, config);
  if (!result.passed) {
    throw new SanitizationGateError(result.errors);
  }
  return result;
}
