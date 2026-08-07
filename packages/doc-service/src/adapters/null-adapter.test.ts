import { describe, expect, test } from "bun:test";
import { createNullAdapter } from "./null-adapter.js";

describe("createNullAdapter", () => {
  test("satisfies the SourceAdapter contract and returns an empty corpus", async () => {
    const adapter = createNullAdapter({ name: "sample-project" });
    expect(adapter.id).toBe("null");

    const corpus = await adapter.extract();

    expect(corpus.project).toEqual({ name: "sample-project" });
    expect(corpus.workItems).toEqual([]);
    expect(corpus.decisions).toEqual([]);
    expect(corpus.incidents).toEqual([]);
    expect(corpus.procedures).toEqual([]);
    expect(corpus.timeline).toEqual([]);
  });

  test("ignores extract options without error", async () => {
    const adapter = createNullAdapter({ name: "sample-project" });
    const corpus = await adapter.extract({
      since: "2026-01-01",
      until: "2026-02-01",
    });
    expect(corpus.workItems).toEqual([]);
  });
});
