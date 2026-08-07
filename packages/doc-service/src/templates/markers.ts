/**
 * Generated-vs-authored marker convention.
 *
 * Every file this service writes carries YAML front-matter with
 * `generated: true`. A file WITHOUT that exact field is treated as
 * hand-authored and must never be overwritten by a regeneration run.
 *
 * This is a safe-by-default design: the absence of a marker (a human
 * writing a new file, or stripping the marker deliberately to "adopt" a
 * generated file as hand-maintained) is what protects it. A generator bug
 * that fails to add front-matter fails toward "human content copied
 * ineffectually, marked ignorable" not "human content silently deleted."
 *
 * Front-matter shape:
 *
 * ---
 * generated: true
 * generator: doc-service
 * sourceIds:
 *   - "work-item:abc123"
 *   - "decision:def456"
 * generatedAt: "2026-08-07T12:00:00.000Z"
 * contentHash: "sha256:...."
 * ---
 *
 * `sourceIds` lists the IR record ids that fed this file, for traceability
 * back to the corpus. `contentHash` is a hash of the generator's rendered
 * output (before any hand-edits) — the drift-detection sibling cell diffs
 * this against a freshly-rendered hash to decide whether the file still
 * matches what the generator would produce today, and whether a human has
 * since edited it out from under the marker.
 */
export interface GeneratedFrontMatter {
  generated: true;
  generator: string;
  sourceIds: string[];
  generatedAt: string;
  contentHash: string;
}

/** Front-matter shape for any file, generated or not — only `generated` is load-bearing. */
export type FrontMatter = Partial<GeneratedFrontMatter> &
  Record<string, unknown>;

/** True only when the marker is present and exactly `true` — never inferred. */
export function isGeneratedContent(
  frontMatter: FrontMatter | undefined | null,
): boolean {
  return frontMatter?.generated === true;
}

/** Serializes generator metadata into a YAML front-matter block, ready to prepend to a file. */
export function renderFrontMatter(meta: GeneratedFrontMatter): string {
  const sourceIdsBlock = meta.sourceIds.length
    ? `sourceIds:\n${meta.sourceIds.map((id) => `  - "${id}"`).join("\n")}`
    : "sourceIds: []";

  return [
    "---",
    "generated: true",
    `generator: ${meta.generator}`,
    sourceIdsBlock,
    `generatedAt: "${meta.generatedAt}"`,
    `contentHash: "${meta.contentHash}"`,
    "---",
    "",
  ].join("\n");
}
