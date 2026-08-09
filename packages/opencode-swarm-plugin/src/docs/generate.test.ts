/**
 * docs/generate tests - TDD first.
 *
 * Covers the empty-corpus guard (the exact failure mode that made this
 * feature useless for mlh - zero beads must skip generation entirely, not
 * emit four "No procedures recorded." files) and that a non-empty corpus
 * drives extraction, honors output toggles, and writes a fingerprint
 * stamp on success.
 *
 * The real hive-doc-adapter (Ollama classifier) and the real hive DB are
 * never touched: `client` is an in-memory libsql instance seeded per test,
 * and `createAdapter` is a fake that returns a canned DocumentationCorpus.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type Client, createClient } from '@libsql/client';
import type { DocumentationCorpus } from '@srmcguirt/doc-service';
import type {
  HiveAdapter,
  HiveAdapterConfig,
} from '@srmcguirt/hive-doc-adapter';
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateDocs } from './generate.js';
import { readStamp } from './fingerprint.js';

async function seedBeadsDb(rows: number): Promise<Client> {
  const client = createClient({ url: ':memory:' });
  await client.execute(`
    CREATE TABLE beads (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      deleted_at BIGINT
    )
  `);
  for (let i = 0; i < rows; i++) {
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: [`bead-${i}`, 'PLACEHOLDER', 1000 + i],
    });
  }
  return client;
}

const scratchDirs: string[] = [];

function makeScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docsmith-generate-test-'));
  scratchDirs.push(dir);
  execSync('git init -q', { cwd: dir });
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function emptyCorpus(
  overrides: Partial<DocumentationCorpus> = {},
): DocumentationCorpus {
  return {
    project: { name: 'test', generatedAt: new Date().toISOString() } as never,
    workItems: [],
    decisions: [],
    incidents: [],
    procedures: [],
    timeline: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeAdapter(
  corpus: DocumentationCorpus,
): (config: HiveAdapterConfig) => HiveAdapter {
  return (_config: HiveAdapterConfig) => ({
    id: 'fake',
    displayName: 'Fake',
    getLastClassificationReport: () => undefined,
    extract: async () => corpus,
  });
}

describe('generateDocs - empty corpus guard', () => {
  test('skips entirely when the project has zero beads, never calls the adapter', async () => {
    const dir = makeScratchRepo();
    const client = await seedBeadsDb(0);
    let adapterCalled = false;

    const result = await generateDocs({
      repoPath: dir,
      client,
      createAdapter: () => {
        adapterCalled = true;
        throw new Error('should not be called');
      },
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('No hive cells found');
    expect(adapterCalled).toBe(false);
  });

  test('does not write any deliverable files when skipped', async () => {
    const dir = makeScratchRepo();
    const client = await seedBeadsDb(0);

    await generateDocs({ repoPath: dir, client });

    expect(existsSync(join(dir, 'docs'))).toBe(false);
  });

  test('does not write a fingerprint stamp when skipped', async () => {
    const dir = makeScratchRepo();
    const client = await seedBeadsDb(0);

    await generateDocs({ repoPath: dir, client });

    expect(readStamp(dir)).toBeNull();
  });
});

describe('generateDocs - non-empty corpus', () => {
  test('extracts and writes only the toggled-on deliverables', async () => {
    const dir = makeScratchRepo();
    writeFileSync(
      join(dir, 'docsmith.json'),
      JSON.stringify({ outputs: { wiki: false, blog: false, policy: false } }),
    );
    // Seed with the project's own resolved key so the guard passes.
    const client = createClient({ url: ':memory:' });
    await client.execute(`
      CREATE TABLE beads (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
        updated_at BIGINT NOT NULL, deleted_at BIGINT
      )
    `);
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', dir, 100],
    });

    const corpus = emptyCorpus({
      procedures: [
        {
          id: 'p1',
          title: 'Do the thing',
          category: 'operational',
          steps: [{ order: 1, instruction: 'Do it' }],
          verified: true,
          gotchas: [],
          relatedWorkItemIds: [],
          provenance: { sourceSystem: 'hive', sourceRef: 'a' },
        } as never,
      ],
    });

    const result = await generateDocs({
      repoPath: dir,
      client,
      createAdapter: fakeAdapter(corpus),
    });

    expect(result.skipped).toBe(false);
    expect(result.deliverables.runbooks).toBeDefined();
    expect(result.deliverables.wiki).toBeUndefined();
    expect(result.deliverables.blog).toBeUndefined();
    expect(result.deliverables.policy).toBeUndefined();
    expect(
      existsSync(join(dir, 'docs', 'generated', 'runbooks', 'index.md')),
    ).toBe(true);
  });

  test('writes a fingerprint stamp matching the post-extract corpus state', async () => {
    const dir = makeScratchRepo();
    const client = createClient({ url: ':memory:' });
    await client.execute(`
      CREATE TABLE beads (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
        updated_at BIGINT NOT NULL, deleted_at BIGINT
      )
    `);
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', dir, 500],
    });

    await generateDocs({
      repoPath: dir,
      client,
      createAdapter: fakeAdapter(emptyCorpus()),
    });

    const stamp = readStamp(dir);
    expect(stamp).not.toBeNull();
    expect(stamp?.rowCount).toBe(1);
    expect(stamp?.maxUpdatedAt).toBe(500);
    expect(stamp?.projectKey).toBe(dir);
  });

  test('passes classifierEnabled through to the adapter config', async () => {
    const dir = makeScratchRepo();
    const client = createClient({ url: ':memory:' });
    await client.execute(`
      CREATE TABLE beads (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
        updated_at BIGINT NOT NULL, deleted_at BIGINT
      )
    `);
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', dir, 100],
    });

    let capturedConfig: HiveAdapterConfig | undefined;
    await generateDocs({
      repoPath: dir,
      client,
      classifierOverride: false,
      createAdapter: (config) => {
        capturedConfig = config;
        return {
          id: 'fake',
          displayName: 'Fake',
          getLastClassificationReport: () => undefined,
          extract: async () => emptyCorpus(),
        };
      },
    });

    expect(capturedConfig?.classifier?.enabled).toBe(false);
  });

  test('reports progress messages via onProgress', async () => {
    const dir = makeScratchRepo();
    const client = createClient({ url: ':memory:' });
    await client.execute(`
      CREATE TABLE beads (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
        updated_at BIGINT NOT NULL, deleted_at BIGINT
      )
    `);
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', dir, 100],
    });

    const messages: string[] = [];
    await generateDocs({
      repoPath: dir,
      client,
      createAdapter: fakeAdapter(emptyCorpus()),
      onProgress: (msg) => messages.push(msg),
    });

    expect(messages.length).toBeGreaterThan(0);
  });
});
