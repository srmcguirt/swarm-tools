/**
 * Scope filtering on the query path - regression tests
 *
 * repo_key/package_key are populated correctly on write (store()/upsert()),
 * but until this fix the query path (find()) ignored scope entirely,
 * letting one repo's memories leak into another repo's search results.
 * These tests exercise the real swarm-mail adapter's find() directly with
 * concrete (non-"auto") scopes, so they don't depend on git/cwd state.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Client } from "@libsql/client";
import type { SwarmDb } from "../db/client.js";
import { createMemoryAdapter, type MemoryConfig } from "./adapter.js";
import { createTestMemoryDb } from "./test-utils.js";

function mockEmbedding(seed = 0): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < 1024; i++) {
    embedding.push(Math.sin(seed + i * 0.1) * 0.5 + 0.5);
  }
  return embedding;
}

const mockConfig: MemoryConfig = {
  ollamaHost: "http://localhost:11434",
  ollamaModel: "mxbai-embed-large",
};

const mockSuccessResponse = (embedding: number[]) =>
  Promise.resolve({
    ok: true,
    json: async () => ({ embedding }),
  } as Response);

const KATAS_SCOPE = { repoKey: "github.com/example/katas", packageKey: null };
const DOCSMITH_SCOPE = {
  repoKey: "github.com/example/docsmith",
  packageKey: null,
};

describe("memory scope filtering on the query path", () => {
  let client: Client;
  let db: SwarmDb;
  let cleanup: () => Promise<void>;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = global.fetch;
    const testDb = await createTestMemoryDb();
    client = testDb.client;
    db = testDb.db;
    cleanup = testDb.cleanup;

    const mockFetch = mock(() => mockSuccessResponse(mockEmbedding(1)));
    global.fetch = mockFetch as typeof fetch;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await cleanup();
  });

  test("a repo-scoped memory does not surface from a different repo", async () => {
    const adapter = createMemoryAdapter(db, mockConfig);

    await adapter.store("katas-only pattern: use bun test runner", {
      scope: KATAS_SCOPE,
    });

    const fromDocsmith = await adapter.find("pattern bun test runner", {
      scope: DOCSMITH_SCOPE,
    });
    expect(
      fromDocsmith.some((r) => r.memory.content.includes("katas-only")),
    ).toBe(false);

    const fromKatas = await adapter.find("pattern bun test runner", {
      scope: KATAS_SCOPE,
    });
    expect(fromKatas.some((r) => r.memory.content.includes("katas-only"))).toBe(
      true,
    );
  });

  test("a repo-scoped memory does not surface via fts from a different repo", async () => {
    const adapter = createMemoryAdapter(db, mockConfig);

    await adapter.store("katasFTSMARKER only visible in its own repo", {
      scope: KATAS_SCOPE,
    });

    const fromDocsmith = await adapter.find("katasFTSMARKER", {
      scope: DOCSMITH_SCOPE,
      fts: true,
    });
    expect(fromDocsmith.length).toBe(0);

    const fromKatas = await adapter.find("katasFTSMARKER", {
      scope: KATAS_SCOPE,
      fts: true,
    });
    expect(fromKatas.length).toBeGreaterThan(0);
  });

  test("a global memory surfaces everywhere", async () => {
    const adapter = createMemoryAdapter(db, mockConfig);

    await adapter.store("cross-project gotcha: always check content-type", {
      scope: "global",
    });

    const fromKatas = await adapter.find("gotcha content-type", {
      scope: KATAS_SCOPE,
    });
    const fromDocsmith = await adapter.find("gotcha content-type", {
      scope: DOCSMITH_SCOPE,
    });

    expect(
      fromKatas.some((r) => r.memory.content.includes("cross-project")),
    ).toBe(true);
    expect(
      fromDocsmith.some((r) => r.memory.content.includes("cross-project")),
    ).toBe(true);
  });

  test("omitting scope entirely searches unscoped (backward compatible)", async () => {
    const adapter = createMemoryAdapter(db, mockConfig);

    await adapter.store("katas-only unscoped-search-check memory", {
      scope: KATAS_SCOPE,
    });

    const results = await adapter.find("unscoped-search-check");
    expect(
      results.some((r) => r.memory.content.includes("unscoped-search-check")),
    ).toBe(true);
  });
});
