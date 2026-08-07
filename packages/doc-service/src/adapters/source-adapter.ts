import type { DocumentationCorpus } from "../ir/types.js";

/** Restricts extraction to a time window. Both bounds are inclusive ISO dates. */
export interface ExtractOptions {
  since?: string;
  until?: string;
}

/**
 * Pluggable contract between a source system (hive, plain git, Jira, ...)
 * and the normalized IR. This is the ONLY place source-system knowledge is
 * allowed to live. An adapter implementation may import whatever client
 * library it needs internally; it must never re-export source-system types.
 *
 * Implementations MUST NOT write source-system internal vocabulary (queue/
 * coordination terminology, agent/session/worker identifiers, etc.) into
 * any IR field — see the Provenance.author contract in ir/types.ts.
 */
export interface SourceAdapter {
  /** Stable identifier for this adapter, e.g. "hive", "git", "jira". */
  readonly id: string;
  /** Human-readable name for config/logging. */
  readonly displayName: string;
  /**
   * Read from the source system and return a fully normalized corpus.
   * Adapters own all pagination, filtering, and translation internally.
   */
  extract(options?: ExtractOptions): Promise<DocumentationCorpus>;
}
