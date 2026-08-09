/**
 * MemoryAdapter Chunk Threshold Tests
 *
 * Verifies MAX_CHARS_PER_CHUNK is derived from the model's context length
 * (not hardcoded) and that the chunk-and-average path actually fires for
 * text over that threshold, while text under it takes the single-embed
 * path unchanged.
 *
 * Uses createLibSQLMemorySchema (the real, migration-based schema) rather
 * than a hand-written CREATE TABLE, since the model context length derives
 * a threshold (~1536 chars for mxbai-embed-large) far below the old 24000
 * char constant - these tests need long text (1500-2000+ chars) to exercise
 * both code paths, which a truncated/stale test schema shouldn't gate.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createLibSQLAdapter } from '../libsql.js';
import { createLibSQLMemorySchema } from './libsql-schema.js';
import { toDrizzleDb } from '../libsql.convenience.js';
import type { SwarmDb } from '../db/client.js';
import { createMemoryAdapter, type MemoryConfig } from './adapter.js';
import { getContextLength } from './ollama.js';

const CHARS_PER_TOKEN = 3;
const mockConfig: MemoryConfig = {
  ollamaHost: 'http://localhost:11434',
  ollamaModel: 'mxbai-embed-large',
};
const threshold = getContextLength(mockConfig.ollamaModel) * CHARS_PER_TOKEN;

function mockEmbedding(seed: number): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < 1024; i++) {
    embedding.push(Math.sin(seed + i * 0.1) * 0.5 + 0.5);
  }
  return embedding;
}

describe('MemoryAdapter - Chunk Threshold Derivation', () => {
  let db: SwarmDb;
  let adapter: ReturnType<typeof createMemoryAdapter>;
  let originalFetch: typeof fetch;
  let embedCallCount: number;

  beforeEach(async () => {
    originalFetch = global.fetch;
    const dbAdapter = await createLibSQLAdapter({ url: ':memory:' });
    // biome-ignore lint/suspicious/noExplicitAny: internal client access for schema setup
    await createLibSQLMemorySchema((dbAdapter as any).getClient());
    db = toDrizzleDb(dbAdapter);

    embedCallCount = 0;
    const mockFetch = mock((url: string) => {
      if (typeof url === 'string' && url.includes('/api/embeddings')) {
        embedCallCount++;
        return Promise.resolve({
          ok: true,
          json: async () => ({ embedding: mockEmbedding(embedCallCount) }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ models: [{ name: mockConfig.ollamaModel }] }),
      } as Response);
    });
    global.fetch = mockFetch as typeof fetch;

    adapter = createMemoryAdapter(db, mockConfig);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('threshold derives from model context length (512 tokens * 3 chars/token)', () => {
    expect(threshold).toBe(1536);
  });

  test('text over the derived threshold triggers chunk-and-average (multiple embed calls)', async () => {
    const longText = 'A'.repeat(threshold + 500);

    await adapter.store(longText);

    expect(embedCallCount).toBeGreaterThan(1);
  });

  test('text under the derived threshold uses the single-embedding path (exactly one call)', async () => {
    const shortText = 'B'.repeat(threshold - 200);

    await adapter.store(shortText);

    expect(embedCallCount).toBe(1);
  });

  test('chunked (averaged) embedding is still 1024-dim and searchable', async () => {
    const longText = 'C'.repeat(threshold + 500);

    const result = await adapter.store(longText);

    // biome-ignore lint/suspicious/noExplicitAny: internal client access to inspect raw vector
    const client = (db as any).$client;
    const rows = await client.execute({
      sql: 'SELECT vector_extract(embedding) as emb FROM memories WHERE id = ?',
      args: [result.id],
    });
    const storedVec = JSON.parse(rows.rows[0].emb as string);

    expect(storedVec.length).toBe(1024);

    const results = await adapter.find('C');
    expect(results.some((r) => r.memory.id === result.id)).toBe(true);
  });

  test('single-embed path still produces a 1024-dim embedding', async () => {
    const shortText = 'D'.repeat(threshold - 200);

    const result = await adapter.store(shortText);

    // biome-ignore lint/suspicious/noExplicitAny: internal client access to inspect raw vector
    const client = (db as any).$client;
    const rows = await client.execute({
      sql: 'SELECT vector_extract(embedding) as emb FROM memories WHERE id = ?',
      args: [result.id],
    });
    const storedVec = JSON.parse(rows.rows[0].emb as string);

    expect(storedVec.length).toBe(1024);
  });
});
