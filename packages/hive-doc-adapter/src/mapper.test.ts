import { describe, expect, test } from "bun:test";
import { mapDecisions, mapIncidents, type MapperContext } from "./mapper.js";
import type { RawCell } from "./hive-reader.js";

const ctx: MapperContext = {
  knownAgentNames: [],
  extractedAt: "2026-08-07T00:00:00.000Z",
};

function cell(overrides: Partial<RawCell>): RawCell {
  return {
    id: "test-1",
    project_key: "test",
    type: "task",
    status: "closed",
    title: "Test cell",
    description: null,
    priority: 2,
    parent_id: null,
    created_at: 1000,
    updated_at: 2000,
    closed_at: 3000,
    closed_reason: null,
    created_by: null,
    result: null,
    ...overrides,
  };
}

describe("mapDecisions", () => {
  test("regression: an open cell that merely discusses decisions/rejections in prose is not extracted as a Decision", () => {
    // Real false positive found during extraction: the epic describing this
    // very task (open, not closed) mentions "an embedding migration
    // rejected on benchmark evidence" as an *example of desired output*,
    // not as an actual decision this cell made. decidedAt has no real
    // closure timestamp to be meaningful against, so this must not extract.
    const c = cell({
      status: "open",
      closed_at: null,
      title: "Documentation service: structured, styled, auto-generating docs",
      description:
        "Real examples from this session: an embedding migration rejected on benchmark evidence, " +
        "a bug found and PR'd to a public package.",
    });
    expect(mapDecisions([c], ctx)).toHaveLength(0);
  });

  test("a closed cell with a real decision marker is extracted", () => {
    const c = cell({
      status: "closed",
      title: "User decision: stop hand-patching the global install",
      description:
        "User decision: stop hand-patching the global install and run from a fork.",
    });
    const decisions = mapDecisions([c], ctx);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].outcome).toBe("adopted");
  });

  test("a closed rejection with benchmark evidence extracts measurements into Evidence", () => {
    const c = cell({
      status: "closed",
      title: "Embedding runtime migration",
      description:
        "Proposal rejected. Benchmark showed the proposed runtime was slower: warm median 38.64ms " +
        "vs current 23.79ms (n=20 runs each).",
    });
    const decisions = mapDecisions([c], ctx);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].outcome).toBe("rejected");
    expect(decisions[0].evidence).toHaveLength(1);
    expect(decisions[0].evidence[0].data).toMatchObject({
      "38.64ms": 38.64,
      "23.79ms": 23.79,
    });
  });
});

describe("mapIncidents", () => {
  test("an open cell without a Root cause: label is not extracted as an Incident", () => {
    const c = cell({
      status: "open",
      closed_at: null,
      description:
        "Real examples: three independent DB destroyers with measured root causes.",
    });
    expect(mapIncidents([c], ctx)).toHaveLength(0);
  });
});
