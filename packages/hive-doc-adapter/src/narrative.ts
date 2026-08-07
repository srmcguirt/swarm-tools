/**
 * Structural parsing of hive closure narratives into Decision / Incident /
 * Procedure shapes. These are heuristic detectors over free text, not a
 * classifier — they match the labeled-section conventions actually used in
 * this corpus (ROOT CAUSE:, Fix:, STEP N -, User decision:, RATIONALE:).
 * A cell that doesn't match any detector still becomes a WorkItem; nothing
 * is lost, it just isn't also promoted to a richer record type.
 */

export interface StructuredSections {
  /** Free text before the first labeled section. */
  lead: string;
  /** Lowercased label -> section body. */
  sections: Map<string, string>;
}

const SECTION_LABEL =
  /(?:^|\n|\.\s+)[ \t]*(root cause|fix|verification|acceptance gate|prevention|rationale|scope of damage|symptom)[ \t]*:[ \t]*/gi;

/** Split narrative text into a leading paragraph and labeled sections (ROOT CAUSE:, Fix:, ...). */
export function parseStructuredSections(text: string): StructuredSections {
  const sections = new Map<string, string>();
  const matches = [...text.matchAll(SECTION_LABEL)];
  if (matches.length === 0) {
    return { lead: text.trim(), sections };
  }
  const lead = text.slice(0, matches[0].index).trim();
  for (let i = 0; i < matches.length; i++) {
    const label = matches[i][1].toLowerCase();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end).trim();
    // First occurrence wins if a label repeats.
    if (!sections.has(label)) sections.set(label, body);
  }
  return { lead, sections };
}

// ============================================================================
// Decision detection
// ============================================================================

export interface DetectedDecision {
  outcome: "adopted" | "rejected" | "deferred" | "superseded";
  summary: string;
  rationale: string;
}

const DECISION_MARKER = /^\s*(?:user\s+)?decision\s*:/i;

/** Numeric measurement pairs, e.g. "23.79ms vs 38.64ms" or "n=20". */
export interface ExtractedMeasurement {
  label: string;
  value: number;
  unit?: string;
}

export function extractMeasurements(text: string): ExtractedMeasurement[] {
  const out: ExtractedMeasurement[] = [];
  const msPattern = /(\d+(?:\.\d+)?)\s*ms\b/gi;
  for (const m of text.matchAll(msPattern)) {
    out.push({ label: `${m[1]}ms`, value: Number(m[1]), unit: "ms" });
  }
  const nPattern = /\bn\s*=\s*(\d+)\b/gi;
  for (const m of text.matchAll(nPattern)) {
    out.push({ label: `n=${m[1]}`, value: Number(m[1]) });
  }
  return out;
}

function inferOutcome(text: string): DetectedDecision["outcome"] {
  if (/\brejected\b/i.test(text)) return "rejected";
  if (/\bdeferred\b|\bpostponed\b/i.test(text)) return "deferred";
  if (/\bsuperseded\b|\breplaced by\b/i.test(text)) return "superseded";
  return "adopted";
}

/** Returns a DetectedDecision if the narrative reads as a decision record, else null. */
export function detectDecision(
  title: string,
  narrative: string,
): DetectedDecision | null {
  const isMarked =
    DECISION_MARKER.test(title) || DECISION_MARKER.test(narrative);
  const hasRejection =
    /\brejected\b.{0,80}(benchmark|measured|ms\b|test)/i.test(narrative);
  if (!isMarked && !hasRejection) return null;

  const { lead, sections } = parseStructuredSections(narrative);
  const rationale = sections.get("rationale") ?? "";
  const summary = lead || narrative.split("\n")[0] || title;

  return {
    outcome: inferOutcome(narrative),
    summary,
    rationale,
  };
}

// ============================================================================
// Incident detection
// ============================================================================

export interface DetectedIncident {
  symptom: string;
  rootCause: string;
  fix: string;
  verification: string;
  preventionRule?: string;
}

/** Returns a DetectedIncident if the narrative has a root-cause/fix shape, else null. */
export function detectIncident(narrative: string): DetectedIncident | null {
  const { lead, sections } = parseStructuredSections(narrative);
  const rootCause = sections.get("root cause");
  if (!rootCause) return null;

  const fix = sections.get("fix") ?? "";
  const verification =
    sections.get("verification") ?? sections.get("acceptance gate") ?? "";
  const symptom = sections.get("symptom") ?? lead;
  const preventionRule = sections.get("prevention");

  return { symptom, rootCause, fix, verification, preventionRule };
}

// ============================================================================
// Procedure detection
// ============================================================================

export interface DetectedProcedureStep {
  order: number;
  /** Short step label as written, e.g. "REBUILD/REINSTALL". */
  label: string;
  /** Full body text for this step (untranslated). */
  body: string;
  command?: string;
}

export interface DetectedProcedure {
  steps: DetectedProcedureStep[];
  verified: boolean;
}

const STEP_MARKER = /(?:^|\n)[ \t]*STEP\s+(\d+)\s*-\s*([^\n:]+):/gi;

/** A backtick or bare shell-looking command inside a step body, if any. */
function extractCommand(body: string): string | undefined {
  const backtick = body.match(/`([^`]+)`/);
  if (backtick) return backtick[1];
  return undefined;
}

/** Returns a DetectedProcedure if the narrative has STEP N - markers, else null. */
export function detectProcedure(narrative: string): DetectedProcedure | null {
  const matches = [...narrative.matchAll(STEP_MARKER)];
  if (matches.length === 0) return null;

  const steps: DetectedProcedureStep[] = matches.map((m, i) => {
    const order = Number(m[1]);
    const label = m[2].trim();
    const start = m.index + m[0].length;
    const end =
      i + 1 < matches.length ? matches[i + 1].index : narrative.length;
    const body = narrative.slice(start, end).trim();
    return {
      order,
      label,
      body,
      command: extractCommand(body),
    };
  });

  const verified =
    /\bverif(?:y|ied|ication)\b|\bacceptance gate\b|\bconfirmed\b/i.test(
      narrative,
    );

  return { steps, verified };
}
