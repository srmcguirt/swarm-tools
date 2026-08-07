import type {
  Decision,
  DocumentationCorpus,
  Evidence,
  Incident,
  Procedure,
  ProjectIdentity,
  Provenance,
  TimelineEvent,
  Timestamp,
  WorkItem,
  WorkItemStatus,
  WorkItemType,
} from "doc-service";
import type { RawCommit } from "./git-reader.js";
import type { RawCell } from "./hive-reader.js";
import {
  detectDecision,
  detectIncident,
  detectProcedure,
  extractMeasurements,
} from "./narrative.js";
import { translateRegister } from "./register.js";

const WORK_ITEM_TYPES = new Set<WorkItemType>([
  "epic",
  "task",
  "bug",
  "feature",
  "chore",
]);
const WORK_ITEM_STATUSES = new Set<WorkItemStatus>([
  "open",
  "in_progress",
  "blocked",
  "closed",
]);

function toIso(ms: number): Timestamp {
  return new Date(ms).toISOString();
}

function hiveProvenance(
  cell: RawCell,
  extractedAt: Timestamp,
  confidence: Provenance["confidence"],
): Provenance {
  return {
    sourceSystem: "hive",
    sourceRef: cell.id,
    extractedAt,
    confidence,
    // Deliberately no `author`: hive has no reliable real-human-identity field
    // for a cell (assignee/created_by in this system are agent identifiers,
    // not real people — see ir/types.ts Provenance contract). Git provenance
    // below is where real authorship comes from.
  };
}

/**
 * `result` (implementation summary) and `closed_reason` are both post-hoc,
 * written-on-completion fields in this hive; `description` is the original
 * pre-work ticket text. Ordering result/closed_reason before description
 * means structured-section detection (ROOT CAUSE:, Fix:, ...) prefers the
 * verified-after-the-fact narrative over any pre-close speculative text
 * when both happen to use the same section labels.
 */
function combinedNarrative(cell: RawCell): string {
  return [cell.result, cell.closed_reason, cell.description]
    .filter(Boolean)
    .join("\n\n");
}

export interface MapperContext {
  knownAgentNames: string[];
  extractedAt: Timestamp;
}

function t(text: string | undefined | null, ctx: MapperContext): string {
  if (!text) return "";
  return translateRegister(text, { knownAgentNames: ctx.knownAgentNames });
}

export function mapWorkItems(cells: RawCell[], ctx: MapperContext): WorkItem[] {
  const childIdsByParent = new Map<string, string[]>();
  for (const cell of cells) {
    if (!cell.parent_id) continue;
    const existing = childIdsByParent.get(cell.parent_id) ?? [];
    existing.push(`hive:${cell.id}`);
    childIdsByParent.set(cell.parent_id, existing);
  }

  const items: WorkItem[] = [];
  for (const cell of cells) {
    const type = cell.type as WorkItemType;
    const status = cell.status as WorkItemStatus;
    if (!WORK_ITEM_TYPES.has(type) || !WORK_ITEM_STATUSES.has(status)) continue;

    const narrativeSource =
      cell.result ?? cell.closed_reason ?? cell.description ?? undefined;
    const closureNarrative =
      status === "closed" && narrativeSource
        ? t(narrativeSource, ctx)
        : undefined;

    items.push({
      id: `hive:${cell.id}`,
      title: t(cell.title, ctx),
      type,
      status,
      createdAt: toIso(cell.created_at),
      updatedAt: toIso(cell.updated_at),
      closedAt: cell.closed_at ? toIso(cell.closed_at) : undefined,
      priority: cell.priority,
      parentId: cell.parent_id ? `hive:${cell.parent_id}` : undefined,
      childIds: childIdsByParent.get(cell.id) ?? [],
      closureNarrative,
      labels: [],
      provenance: hiveProvenance(
        cell,
        ctx.extractedAt,
        closureNarrative ? "inferred" : "verified",
      ),
    });
  }
  return items;
}

export function mapDecisions(cells: RawCell[], ctx: MapperContext): Decision[] {
  const decisions: Decision[] = [];
  for (const cell of cells) {
    // A decision has to have actually been decided: `decidedAt` is only
    // meaningful against a real closure timestamp, and requiring `closed`
    // also rules out cells that merely *discuss* decisions/rejections as
    // prose (e.g. an open planning epic describing what a decision record
    // should look like) without any closure narrative to have decided in.
    if (cell.status !== "closed") continue;

    const narrative = combinedNarrative(cell);
    const detected = detectDecision(cell.title, narrative);
    if (!detected) continue;

    const measurements = extractMeasurements(narrative);
    const evidence: Evidence[] = [];
    if (measurements.length > 0) {
      const data: Record<string, string | number> = {};
      for (const m of measurements) data[m.label] = m.value;
      evidence.push({
        kind: "benchmark",
        description: t("Measured values cited in the decision narrative.", ctx),
        data,
      });
    }

    decisions.push({
      id: `hive-decision:${cell.id}`,
      title: t(cell.title, ctx),
      outcome: detected.outcome,
      summary: t(detected.summary, ctx),
      optionsConsidered: [],
      evidence,
      decidedAt: toIso(cell.closed_at ?? cell.updated_at),
      relatedWorkItemIds: [`hive:${cell.id}`],
      provenance: hiveProvenance(cell, ctx.extractedAt, "inferred"),
    });
  }
  return decisions;
}

const SEVERITY_BY_PRIORITY = ["critical", "high", "medium", "low"] as const;

export function mapIncidents(cells: RawCell[], ctx: MapperContext): Incident[] {
  const incidents: Incident[] = [];
  for (const cell of cells) {
    const narrative = combinedNarrative(cell);
    const detected = detectIncident(narrative);
    if (!detected) continue;

    incidents.push({
      id: `hive-incident:${cell.id}`,
      title: t(cell.title, ctx),
      severity: SEVERITY_BY_PRIORITY[Math.min(cell.priority, 3)] ?? "medium",
      symptom: t(detected.symptom || cell.title, ctx),
      rootCause: t(detected.rootCause, ctx),
      fix: t(detected.fix, ctx),
      verification: t(detected.verification, ctx),
      preventionRule: detected.preventionRule
        ? t(detected.preventionRule, ctx)
        : undefined,
      occurredAt: toIso(cell.created_at),
      resolvedAt: cell.closed_at ? toIso(cell.closed_at) : undefined,
      relatedWorkItemIds: [`hive:${cell.id}`],
      provenance: hiveProvenance(cell, ctx.extractedAt, "inferred"),
    });
  }
  return incidents;
}

export function mapProcedures(
  cells: RawCell[],
  ctx: MapperContext,
): Procedure[] {
  const procedures: Procedure[] = [];
  for (const cell of cells) {
    const narrative = combinedNarrative(cell);
    const detected = detectProcedure(narrative);
    if (!detected) continue;

    procedures.push({
      id: `hive-procedure:${cell.id}`,
      title: t(cell.title, ctx),
      category: "other",
      steps: detected.steps.map((s) => ({
        order: s.order,
        action: t(`${s.label}: ${s.body}`, ctx),
        command: s.command,
      })),
      verified: detected.verified,
      verifiedAt:
        detected.verified && cell.closed_at ? toIso(cell.closed_at) : undefined,
      gotchas: [],
      relatedWorkItemIds: [`hive:${cell.id}`],
      provenance: hiveProvenance(cell, ctx.extractedAt, "inferred"),
    });
  }
  return procedures;
}

export function mapHiveTimeline(
  cells: RawCell[],
  ctx: MapperContext,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const cell of cells) {
    const type = cell.type as WorkItemType;
    if (!WORK_ITEM_TYPES.has(type)) continue;

    events.push({
      id: `hive-timeline:${cell.id}:opened`,
      kind: "work-item-opened",
      occurredAt: toIso(cell.created_at),
      title: t(cell.title, ctx),
      relatedIds: [`hive:${cell.id}`],
      provenance: hiveProvenance(cell, ctx.extractedAt, "verified"),
    });

    if (cell.closed_at) {
      events.push({
        id: `hive-timeline:${cell.id}:closed`,
        kind: "work-item-closed",
        occurredAt: toIso(cell.closed_at),
        title: t(cell.title, ctx),
        relatedIds: [`hive:${cell.id}`],
        provenance: hiveProvenance(cell, ctx.extractedAt, "verified"),
      });
    }
  }
  return events;
}

export function mapGitTimeline(
  commits: RawCommit[],
  ctx: MapperContext,
): TimelineEvent[] {
  return commits
    .filter((c) => c.sha && c.authoredAt)
    .map((commit) => ({
      id: `git:${commit.sha}`,
      kind: "milestone" as const,
      occurredAt: commit.authoredAt,
      title: t(commit.subject, ctx),
      relatedIds: [],
      provenance: {
        sourceSystem: "git",
        sourceRef: commit.sha,
        extractedAt: ctx.extractedAt,
        confidence: "verified",
        author: commit.authorName || undefined,
      },
    }));
}

export function buildCorpus(
  project: ProjectIdentity,
  cells: RawCell[],
  commits: RawCommit[],
  ctx: MapperContext,
): DocumentationCorpus {
  return {
    project,
    workItems: mapWorkItems(cells, ctx),
    decisions: mapDecisions(cells, ctx),
    incidents: mapIncidents(cells, ctx),
    procedures: mapProcedures(cells, ctx),
    timeline: [...mapHiveTimeline(cells, ctx), ...mapGitTimeline(commits, ctx)],
    generatedAt: ctx.extractedAt,
  };
}
