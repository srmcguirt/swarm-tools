import { describe, expect, test } from "bun:test";
import { createEmptyCorpus, mergeCorpus } from "./corpus.js";
import type { DocumentationCorpus, WorkItem } from "./types.js";

const identity = { name: "test-project" };

function workItem(id: string): WorkItem {
  return {
    id,
    title: `Item ${id}`,
    type: "task",
    status: "closed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    childIds: [],
    labels: [],
    provenance: {
      sourceSystem: "manual",
      sourceRef: id,
      extractedAt: "2026-01-02T00:00:00.000Z",
      confidence: "verified",
    },
  };
}

describe("createEmptyCorpus", () => {
  test("produces a corpus with all collections empty", () => {
    const corpus = createEmptyCorpus(identity);
    expect(corpus.project).toEqual(identity);
    expect(corpus.workItems).toEqual([]);
    expect(corpus.decisions).toEqual([]);
    expect(corpus.incidents).toEqual([]);
    expect(corpus.procedures).toEqual([]);
    expect(corpus.timeline).toEqual([]);
    expect(typeof corpus.generatedAt).toBe("string");
  });

  test("generatedAt is a valid ISO timestamp", () => {
    const corpus = createEmptyCorpus(identity);
    expect(Number.isNaN(Date.parse(corpus.generatedAt))).toBe(false);
  });
});

describe("mergeCorpus", () => {
  test("concatenates collections from multiple corpora produced by different adapters", () => {
    const a: DocumentationCorpus = {
      ...createEmptyCorpus(identity),
      workItems: [workItem("a")],
    };
    const b: DocumentationCorpus = {
      ...createEmptyCorpus(identity),
      workItems: [workItem("b")],
    };

    const merged = mergeCorpus(identity, [a, b]);

    expect(merged.workItems.map((w) => w.id)).toEqual(["a", "b"]);
  });

  test("de-duplicates work items by id, keeping the first occurrence", () => {
    const a: DocumentationCorpus = {
      ...createEmptyCorpus(identity),
      workItems: [workItem("dup")],
    };
    const b: DocumentationCorpus = {
      ...createEmptyCorpus(identity),
      workItems: [workItem("dup")],
    };

    const merged = mergeCorpus(identity, [a, b]);

    expect(merged.workItems).toHaveLength(1);
  });

  test("returns an empty corpus when given no inputs", () => {
    const merged = mergeCorpus(identity, []);
    expect(merged.workItems).toEqual([]);
    expect(merged.project).toEqual(identity);
  });
});
