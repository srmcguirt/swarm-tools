import { createEmptyCorpus } from "../ir/corpus.js";
import type { ProjectIdentity } from "../ir/types.js";
import type { SourceAdapter } from "./source-adapter.js";

/**
 * A SourceAdapter that always returns an empty corpus. Proves the
 * interface shape, unblocks generator/template development against a real
 * (if empty) DocumentationCorpus, and gives integration tests a
 * zero-dependency baseline. Not meant to ship data — real adapters (hive,
 * git, ...) are separate implementations of SourceAdapter.
 */
export function createNullAdapter(project: ProjectIdentity): SourceAdapter {
  return {
    id: "null",
    displayName: "Null Adapter (no source data)",
    async extract(): Promise<ReturnType<typeof createEmptyCorpus>> {
      return createEmptyCorpus(project);
    },
  };
}
