/**
 * Normalized Intermediate Representation (IR)
 *
 * This is the ONLY shape that generators, templates, and styling ever see.
 * No source-system vocabulary (issue trackers, VCS internals, coordination
 * tooling) may leak past this boundary. Extraction layer adapters translate
 * from whatever the source system calls things into these types; generators
 * never import from an adapter or a source-system client.
 *
 * Deliberate omission: there is no per-record "assignee" or agent/session
 * identity field anywhere in this file. Attribution that reaches generated
 * output must be a real human or organization name, carried (optionally) in
 * `Provenance.author`. Extraction adapters are responsible for never writing
 * a synthetic identifier into that field. See Provenance below.
 */

/** ISO 8601 timestamp string. Always UTC. */
export type Timestamp = string;

// ============================================================================
// Provenance — traceability for every fact that can reach generated output
// ============================================================================

/**
 * Where a fact came from and how sure we are of it.
 *
 * Every IR record carries one. Generators may cite `sourceRef` in footnotes
 * or omit it entirely, but it must exist so a claim can always be traced
 * back to something real instead of becoming confident fiction.
 */
export interface Provenance {
  /** Adapter-declared source system id, e.g. "git", "issue-tracker", "manual". */
  sourceSystem: string;
  /** Opaque locator within that system: commit sha, issue url, file path+line. */
  sourceRef: string;
  /** When the extraction that produced this record ran. */
  extractedAt: Timestamp;
  /**
   * "verified" = read directly from the source with no interpretation.
   * "inferred" = summarized/derived by the extraction layer (e.g. a
   * closure narrative synthesized from several raw fields).
   */
  confidence: "verified" | "inferred";
  /**
   * Real human or organization identity ONLY (e.g. a git commit author,
   * a named reporter). Never an agent, session, worker, or bot identifier.
   * Leave unset rather than fabricate or launder one of those in.
   */
  author?: string;
}

// ============================================================================
// Work items
// ============================================================================

export type WorkItemType = "epic" | "task" | "bug" | "feature" | "chore";
export type WorkItemStatus = "open" | "in_progress" | "blocked" | "closed";

/**
 * A unit of work. Generic enough to come from an issue tracker, a plain-git
 * commit-message convention, or a spreadsheet — the extraction layer decides
 * how to populate it.
 */
export interface WorkItem {
  /** Stable, adapter-namespaced id (e.g. "git:<sha>", "tracker:<id>"). */
  id: string;
  title: string;
  type: WorkItemType;
  status: WorkItemStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  closedAt?: Timestamp;
  /** Optional priority; lower is more urgent. Omit if the source has no concept of it. */
  priority?: number;
  parentId?: string;
  childIds: string[];
  /**
   * Plain-language summary of what was actually done, written for an
   * external reader — not a raw "closed_reason" field dump. This is the
   * primary material for blog/wiki narrative generation.
   */
  closureNarrative?: string;
  labels: string[];
  provenance: Provenance;
}

// ============================================================================
// Decisions — the rejection (with evidence) is as valuable as the outcome
// ============================================================================

export type DecisionOutcome =
  | "adopted"
  | "rejected"
  | "deferred"
  | "superseded";

/** One option that was on the table, and why it did or didn't win. */
export interface DecisionOption {
  label: string;
  chosen: boolean;
  rationale: string;
}

export type EvidenceKind =
  | "benchmark"
  | "test-result"
  | "observation"
  | "external-reference";

/** A concrete, checkable fact backing a decision — not an assertion. */
export interface Evidence {
  kind: EvidenceKind;
  description: string;
  /** Structured measurements, e.g. { proposed_ms: 38.64, baseline_ms: 23.79 }. */
  data?: Record<string, string | number>;
  /** Link or path to the underlying artifact, if any. */
  source?: string;
}

export interface Decision {
  id: string;
  title: string;
  outcome: DecisionOutcome;
  /** One-paragraph plain-language explanation of the decision. */
  summary: string;
  optionsConsidered: DecisionOption[];
  evidence: Evidence[];
  decidedAt: Timestamp;
  relatedWorkItemIds: string[];
  provenance: Provenance;
}

// ============================================================================
// Incidents — symptom -> root cause -> fix -> verification -> prevention
// ============================================================================

export type IncidentSeverity = "critical" | "high" | "medium" | "low";

export interface Incident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  /** What was observed. */
  symptom: string;
  /** The actual mechanism, not a symptom restated. */
  rootCause: string;
  /** What changed to resolve it. */
  fix: string;
  /** How the fix was confirmed to work. */
  verification: string;
  /**
   * The hardline rule this incident produces, if any. Policy generator
   * consumes this field directly.
   */
  preventionRule?: string;
  occurredAt: Timestamp;
  resolvedAt?: Timestamp;
  relatedWorkItemIds: string[];
  provenance: Provenance;
}

// ============================================================================
// Procedures — verified operational steps only
// ============================================================================

export type ProcedureCategory =
  | "build"
  | "deploy"
  | "rollback"
  | "maintenance"
  | "recovery"
  | "other";

export interface ProcedureStep {
  order: number;
  /** Imperative, e.g. "Build package B before package A". */
  action: string;
  /** Literal command, if applicable. */
  command?: string;
  expectedResult?: string;
}

export interface Procedure {
  id: string;
  title: string;
  category: ProcedureCategory;
  steps: ProcedureStep[];
  /**
   * Whether this procedure has actually been carried out and confirmed to
   * work, as opposed to a speculative plan. The runbook generator should
   * refuse to publish steps where this is false.
   */
  verified: boolean;
  verifiedAt?: Timestamp;
  /** Sharp edges: things that will bite you if skipped. */
  gotchas: string[];
  relatedWorkItemIds: string[];
  provenance: Provenance;
}

// ============================================================================
// Timeline — ordered events for narrative reconstruction
// ============================================================================

export type TimelineEventKind =
  | "work-item-opened"
  | "work-item-closed"
  | "decision-made"
  | "incident-occurred"
  | "incident-resolved"
  | "procedure-verified"
  | "milestone";

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  occurredAt: Timestamp;
  title: string;
  description?: string;
  /** IDs of WorkItem/Decision/Incident/Procedure records this event references. */
  relatedIds: string[];
  provenance: Provenance;
}

// ============================================================================
// Project identity & the corpus root
// ============================================================================

/** What a project calls itself. No coordination-tooling vocabulary here. */
export interface ProjectIdentity {
  name: string;
  description?: string;
  homepage?: string;
  repository?: string;
}

/**
 * The complete normalized dataset for one generation run. This is what a
 * SourceAdapter produces and what every generator consumes. Nothing in this
 * type, or anything it references, may carry source-system-specific shape.
 */
export interface DocumentationCorpus {
  project: ProjectIdentity;
  workItems: WorkItem[];
  decisions: Decision[];
  incidents: Incident[];
  procedures: Procedure[];
  timeline: TimelineEvent[];
  /** When this corpus was assembled. */
  generatedAt: Timestamp;
}
