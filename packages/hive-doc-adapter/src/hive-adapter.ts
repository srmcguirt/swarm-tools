import type {
  DocumentationCorpus,
  ExtractOptions,
  ProjectIdentity,
  SourceAdapter,
} from "doc-service";
import { readGitCommits } from "./git-reader.js";
import { createHiveReader, type RawCell } from "./hive-reader.js";
import { buildCorpus } from "./mapper.js";

export interface HiveAdapterConfig {
  /** Path to the swarm.db file. */
  dbPath: string;
  /** Hive project_key this corpus is scoped to. */
  projectKey: string;
  /** Local git repo path to pull commit history from (optional). */
  gitRepoPath?: string;
  project: ProjectIdentity;
}

/**
 * SourceAdapter that reads hive cells (work items, closure narratives) and
 * git history (commits) and emits a normalized DocumentationCorpus. This is
 * the ONLY module in this package that knows hive's or git's shape — see
 * doc-service's README architecture boundary. Read-only: no cell, comment,
 * label, or memory row is ever written, updated, or deleted.
 */
export function createHiveAdapter(config: HiveAdapterConfig): SourceAdapter {
  return {
    id: "hive",
    displayName: "Hive + Git",
    async extract(options?: ExtractOptions): Promise<DocumentationCorpus> {
      const extractedAt = new Date().toISOString();
      const reader = createHiveReader({
        dbPath: config.dbPath,
        projectKey: config.projectKey,
      });
      try {
        const [cells, agentNames, commits] = await Promise.all([
          reader.getCells(),
          reader.getAgentNames(),
          config.gitRepoPath
            ? readGitCommits({
                repoPath: config.gitRepoPath,
                since: options?.since,
                until: options?.until,
              })
            : Promise.resolve([]),
        ]);

        const filteredCells = filterByWindow(cells, options);

        return buildCorpus(config.project, filteredCells, commits, {
          knownAgentNames: agentNames,
          extractedAt,
        });
      } finally {
        await reader.close();
      }
    },
  };
}

function filterByWindow(cells: RawCell[], options?: ExtractOptions): RawCell[] {
  if (!options?.since && !options?.until) return cells;
  const sinceMs = options.since ? Date.parse(options.since) : -Infinity;
  const untilMs = options.until ? Date.parse(options.until) : Infinity;
  return cells.filter(
    (c) => c.created_at >= sinceMs && c.created_at <= untilMs,
  );
}
