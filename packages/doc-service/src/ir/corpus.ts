import type {
  Decision,
  DocumentationCorpus,
  Incident,
  Procedure,
  ProjectIdentity,
  TimelineEvent,
  WorkItem,
} from "./types.js";

/** An empty corpus for a project, ready for an adapter to fill in. */
export function createEmptyCorpus(
  project: ProjectIdentity,
): DocumentationCorpus {
  return {
    project,
    workItems: [],
    decisions: [],
    incidents: [],
    procedures: [],
    timeline: [],
    generatedAt: new Date().toISOString(),
  };
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

/**
 * Combine corpora from multiple source adapters into one. Later adapters
 * lose ties on id collisions — the extraction layer should namespace ids
 * (e.g. "git:<sha>" vs "tracker:<id>") to avoid unintended collisions
 * rather than relying on this ordering.
 */
export function mergeCorpus(
  project: ProjectIdentity,
  corpora: DocumentationCorpus[],
): DocumentationCorpus {
  const workItems: WorkItem[] = [];
  const decisions: Decision[] = [];
  const incidents: Incident[] = [];
  const procedures: Procedure[] = [];
  const timeline: TimelineEvent[] = [];

  for (const corpus of corpora) {
    workItems.push(...corpus.workItems);
    decisions.push(...corpus.decisions);
    incidents.push(...corpus.incidents);
    procedures.push(...corpus.procedures);
    timeline.push(...corpus.timeline);
  }

  return {
    project,
    workItems: dedupeById(workItems),
    decisions: dedupeById(decisions),
    incidents: dedupeById(incidents),
    procedures: dedupeById(procedures),
    timeline: dedupeById(timeline),
    generatedAt: new Date().toISOString(),
  };
}
