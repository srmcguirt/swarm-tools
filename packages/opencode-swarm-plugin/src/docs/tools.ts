/**
 * MCP tools: docs_generate, docs_check.
 *
 * Follows the same working-directory convention as hive.ts/skills.ts -
 * setDocsWorkingDirectory() is called from plugin init with the project
 * directory so these tools run against the right repo, not process.cwd().
 */
import { tool } from '@opencode-ai/plugin';

import { checkDocs } from './check.js';
import { generateDocs } from './generate.js';

let docsWorkingDirectory: string | null = null;

/** Call from plugin initialization with the project directory. */
export function setDocsWorkingDirectory(directory: string): void {
  docsWorkingDirectory = directory;
}

export function getDocsWorkingDirectory(): string {
  return docsWorkingDirectory || process.cwd();
}

export const docs_generate = tool({
  description: `Generate documentation (runbooks, wiki, blog, policy) for this repo from its hive corpus.

Skips entirely (no files written) when the repo has zero hive cells - never
emits placeholder "No procedures recorded." files. Can take 20s-2min+ with
the classifier on (default), since it makes one local Ollama call per
unclassified closed cell.

Honors docsmith.json's \`outputs\` toggles - a repo can opt out of any of
the four deliverables. Writes a fingerprint stamp on success, consumed by
docs_check / \`swarm docs check\`.`,
  args: {
    classifier: tool.schema
      .boolean()
      .optional()
      .describe(
        "Override the classifier on/off (default: docsmith.json's classifier.enabled, or true if unset)",
      ),
  },
  async execute(args) {
    const repoPath = getDocsWorkingDirectory();
    const result = await generateDocs({
      repoPath,
      classifierOverride: args.classifier,
    });

    if (result.skipped) {
      return `Skipped: ${result.skipReason}`;
    }

    const lines = [`Generated docs for ${result.projectKey}:`];
    for (const [kind, deliverable] of Object.entries(result.deliverables)) {
      lines.push(
        `  - ${kind}: ${deliverable.written} written, ${deliverable.excluded} excluded (${deliverable.outputPath})`,
      );
    }
    if (Object.keys(result.deliverables).length === 0) {
      lines.push('  (no deliverables enabled in docsmith.json)');
    }
    return lines.join('\n');
  },
});

export const docs_check = tool({
  description: `Fast documentation-staleness check for this repo. Makes zero model calls and never runs extraction - one cheap indexed SQL query (row count + MAX(updated_at) over hive cells) compared against the stamp from the last docs_generate run.

Returns "unconfigured" (no docsmith.json) or "empty" (no hive cells) as
non-blocking statuses - only "stale" signals a real problem, fixed by
running docs_generate.`,
  args: {},
  async execute() {
    const repoPath = getDocsWorkingDirectory();
    const result = await checkDocs({ repoPath });
    return `[${result.status}] ${result.message}`;
  },
});

export const docsTools = {
  docs_generate,
  docs_check,
};
