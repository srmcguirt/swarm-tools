/**
 * docs/check tests - TDD first.
 *
 * `checkDocs` is the pre-push gate: fast, zero model calls, must never
 * block a push for a repo that hasn't opted in (no docsmith.json) or has
 * no beads yet. Otherwise it's a thin wrapper over fingerprint.checkStaleness
 * that turns the result into an exit code + message.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type Client, createClient } from '@libsql/client';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkDocs } from './check.js';
import { writeStamp } from './fingerprint.js';

async function seedBeadsDb(): Promise<Client> {
  const client = createClient({ url: ':memory:' });
  await client.execute(`
    CREATE TABLE beads (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      deleted_at BIGINT
    )
  `);
  return client;
}

const scratchDirs: string[] = [];

function makeScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docsmith-check-test-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('checkDocs - unconfigured repo', () => {
  test('exits zero (never blocks) when there is no docsmith.json', async () => {
    const dir = makeScratchRepo();
    const client = await seedBeadsDb();

    const result = await checkDocs({ repoPath: dir, client });

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('unconfigured');
  });
});

describe('checkDocs - configured but empty corpus', () => {
  test('exits zero when the project has zero beads', async () => {
    const dir = makeScratchRepo();
    writeFileSync(join(dir, 'docsmith.json'), '{}');
    const client = await seedBeadsDb();

    const result = await checkDocs({ repoPath: dir, client });

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('empty');
  });
});

describe('checkDocs - configured with beads', () => {
  test('exits non-zero and names the fix when stale (no stamp yet)', async () => {
    const dir = makeScratchRepo();
    writeFileSync(join(dir, 'docsmith.json'), '{}');
    const client = await seedBeadsDb();
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', dir, 100],
    });

    const result = await checkDocs({ repoPath: dir, client });

    expect(result.exitCode).not.toBe(0);
    expect(result.status).toBe('stale');
    expect(result.message).toContain('swarm docs generate');
  });

  test('exits zero when the stamp is fresh', async () => {
    const dir = makeScratchRepo();
    writeFileSync(join(dir, 'docsmith.json'), '{}');
    const client = await seedBeadsDb();
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', dir, 100],
    });
    writeStamp(dir, {
      projectKey: dir,
      rowCount: 1,
      maxUpdatedAt: 100,
      generatedAt: '2026-08-09T00:00:00.000Z',
    });

    const result = await checkDocs({ repoPath: dir, client });

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('fresh');
  });

  test('exits non-zero when new beads were added after the stamp', async () => {
    const dir = makeScratchRepo();
    writeFileSync(join(dir, 'docsmith.json'), '{}');
    const client = await seedBeadsDb();
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', dir, 100],
    });
    writeStamp(dir, {
      projectKey: dir,
      rowCount: 1,
      maxUpdatedAt: 100,
      generatedAt: '2026-08-09T00:00:00.000Z',
    });
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['b', dir, 200],
    });

    const result = await checkDocs({ repoPath: dir, client });

    expect(result.exitCode).not.toBe(0);
    expect(result.status).toBe('stale');
  });
});
