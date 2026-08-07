import { describe, expect, test } from "bun:test";
import { isGeneratedContent, renderFrontMatter } from "./markers.js";

describe("isGeneratedContent", () => {
  test("is true when generated is exactly true", () => {
    expect(isGeneratedContent({ generated: true })).toBe(true);
  });

  test("is false when front-matter is missing entirely", () => {
    expect(isGeneratedContent(undefined)).toBe(false);
    expect(isGeneratedContent(null)).toBe(false);
  });

  test("is false when the generated field is absent", () => {
    expect(isGeneratedContent({ title: "Hand-written notes" })).toBe(false);
  });

  test("is false for truthy-but-not-boolean-true values (no coercion)", () => {
    expect(isGeneratedContent({ generated: "true" as unknown as true })).toBe(
      false,
    );
    expect(isGeneratedContent({ generated: 1 as unknown as true })).toBe(false);
  });

  test("is false when generated is explicitly false", () => {
    expect(isGeneratedContent({ generated: false as unknown as true })).toBe(
      false,
    );
  });
});

describe("renderFrontMatter", () => {
  test("renders a complete front-matter block", () => {
    const block = renderFrontMatter({
      generated: true,
      generator: "doc-service",
      sourceIds: ["work-item:abc123", "decision:def456"],
      generatedAt: "2026-08-07T12:00:00.000Z",
      contentHash: "sha256:deadbeef",
    });

    expect(block).toContain("generated: true");
    expect(block).toContain("generator: doc-service");
    expect(block).toContain('- "work-item:abc123"');
    expect(block).toContain('- "decision:def456"');
    expect(block).toContain('generatedAt: "2026-08-07T12:00:00.000Z"');
    expect(block).toContain('contentHash: "sha256:deadbeef"');
    expect(block.startsWith("---\n")).toBe(true);
    expect(block.trimEnd().endsWith("---")).toBe(true);
  });

  test("renders an empty sourceIds array explicitly", () => {
    const block = renderFrontMatter({
      generated: true,
      generator: "doc-service",
      sourceIds: [],
      generatedAt: "2026-08-07T12:00:00.000Z",
      contentHash: "sha256:deadbeef",
    });
    expect(block).toContain("sourceIds: []");
  });
});
