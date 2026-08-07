// IR — the normalized contract every generator consumes.
export type {
  Timestamp,
  Provenance,
  WorkItem,
  WorkItemType,
  WorkItemStatus,
  Decision,
  DecisionOutcome,
  DecisionOption,
  Evidence,
  EvidenceKind,
  Incident,
  IncidentSeverity,
  Procedure,
  ProcedureCategory,
  ProcedureStep,
  TimelineEvent,
  TimelineEventKind,
  ProjectIdentity,
  DocumentationCorpus,
} from "./ir/types.js";
export { createEmptyCorpus, mergeCorpus } from "./ir/corpus.js";

// Source adapters — the pluggable extraction boundary.
export type {
  SourceAdapter,
  ExtractOptions,
} from "./adapters/source-adapter.js";
export { createNullAdapter } from "./adapters/null-adapter.js";

// Project config.
export {
  ProjectConfigSchema,
  ProjectConfigValidationError,
  parseProjectConfig,
  DOC_OUTPUT_KINDS,
} from "./config/schema.js";
export type {
  ProjectConfig,
  DocOutputKind,
  SanitizationConfig,
} from "./config/schema.js";

// Sanitization gate — authoritative policy check over an assembled corpus,
// run before any generator. Fails the build on leakage.
export {
  runSanitizationGate,
  assertSanitized,
  resolveSanitizationConfig,
  SanitizationGateError,
} from "./gate/sanitization-gate.js";
export type {
  GateCategory,
  GateSeverity,
  GateViolation,
  GateResult,
} from "./gate/sanitization-gate.js";

// Template structure & generated-vs-authored markers.
export {
  WIKI_SUBDIRECTORIES,
  templateDirectories,
  scaffoldTemplateStructure,
} from "./templates/structure.js";
export type { GeneratedFrontMatter, FrontMatter } from "./templates/markers.js";
export { isGeneratedContent, renderFrontMatter } from "./templates/markers.js";
