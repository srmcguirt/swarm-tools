/**
 * docs/fingerprint tests - TDD first.
 *
 * Covers the cheap corpus fingerprint query (row count + MAX(updated_at)
 * over `beads`, scoped by project_key - never anything git-derived), stamp
 * read/write round-tripping, and staleness detection: fresh, stale (rows
 * added/updated), no-stamp, and - the critical trap this whole module
 * exists to avoid - fingerprint stability when only git HEAD moves.
 *
 * Uses an in-memory libsql client seeded with a minimal `beads` table
 * (never the real ~/.config/swarm-tools/swarm.db) - see hive-doc-adapter's
 * hive-reader.ts doc comment for why @libsql/client specifically (plain
 * sqlite3 mis-reads this schema's vector-indexed tables; irrelevant here
 * since this table has none, but matching the convention).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type Client, createClient } from '@libsql/client';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkStaleness,
  computeCorpusFingerprint,
  readStamp,
  stampPath,
  writeStamp,
} from './fingerprint.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'docsmith-fingerprint-test-'));
  scratchDirs.push(dir);
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name Test', { cwd: dir });
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('computeCorpusFingerprint', () => {
  test('counts rows and finds MAX(updated_at) scoped to project_key', async () => {
    const client = await seedBeadsDb();
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', '/repo/one', 100],
    });
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['b', '/repo/one', 200],
    });
    // Different project - must not affect the count/max for /repo/one.
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['c', '/repo/two', 999],
    });

    const fp = await computeCorpusFingerprint(client, '/repo/one');
    expect(fp.rowCount).toBe(2);
    expect(fp.maxUpdatedAt).toBe(200);
  });

  test('excludes soft-deleted rows', async () => {
    const client = await seedBeadsDb();
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at, deleted_at) VALUES (?, ?, ?, ?)',
      args: ['a', '/repo/one', 100, 500],
    });

    const fp = await computeCorpusFingerprint(client, '/repo/one');
    expect(fp.rowCount).toBe(0);
    expect(fp.maxUpdatedAt).toBeNull();
  });

  test('returns rowCount 0 and null maxUpdatedAt for an unknown project_key', async () => {
    const client = await seedBeadsDb();
    const fp = await computeCorpusFingerprint(client, '/nowhere');
    expect(fp.rowCount).toBe(0);
    expect(fp.maxUpdatedAt).toBeNull();
  });
});

describe('stamp read/write', () => {
  test('readStamp returns null when no stamp has been written', () => {
    const dir = makeScratchRepo();
    expect(readStamp(dir)).toBeNull();
  });

  test('writeStamp then readStamp round-trips', () => {
    const dir = makeScratchRepo();
    writeStamp(dir, {
      projectKey: '/repo/one',
      rowCount: 5,
      maxUpdatedAt: 12345,
      generatedAt: '2026-08-09T00:00:00.000Z',
    });
    const stamp = readStamp(dir);
    expect(stamp).toEqual({
      projectKey: '/repo/one',
      rowCount: 5,
      maxUpdatedAt: 12345,
      generatedAt: '2026-08-09T00:00:00.000Z',
    });
  });

  test('stamp lives under .git/, never in the tracked tree', () => {
    const dir = makeScratchRepo();
    expect(stampPath(dir).startsWith(join(dir, '.git'))).toBe(true);
  });
});

describe('checkStaleness', () => {
  test('stale (reason: no-stamp) when generate has never run', async () => {
    const dir = makeScratchRepo();
    const client = await seedBeadsDb();
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', '/repo/one', 100],
    });

    const result = await checkStaleness({
      client,
      projectKey: '/repo/one',
      repoPath: dir,
    });
    expect(result.stale).toBe(true);
    expect(result.reason).toBe('no-stamp');
  });

  test('fresh when the stamp matches current corpus state', async () => {
    const dir = makeScratchRepo();
    const client = await seedBeadsDb();
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', '/repo/one', 100],
    });
    writeStamp(dir, {
      projectKey: '/repo/one',
      rowCount: 1,
      maxUpdatedAt: 100,
      generatedAt: '2026-08-09T00:00:00.000Z',
    });

    const result = await checkStaleness({
      client,
      projectKey: '/repo/one',
      repoPath: dir,
    });
    expect(result.stale).toBe(false);
  });

  test('stale when a row is added after the stamp', async () => {
    const dir = makeScratchRepo();
    const client = await seedBeadsDb();
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', '/repo/one', 100],
    });
    writeStamp(dir, {
      projectKey: '/repo/one',
      rowCount: 1,
      maxUpdatedAt: 100,
      generatedAt: '2026-08-09T00:00:00.000Z',
    });
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['b', '/repo/one', 150],
    });

    const result = await checkStaleness({
      client,
      projectKey: '/repo/one',
      repoPath: dir,
    });
    expect(result.stale).toBe(true);
    expect(result.reason).toBe('corpus-changed');
  });

  test('stale when an existing row is updated (row count unchanged, updated_at moves)', async () => {
    const dir = makeScratchRepo();
    const client = await seedBeadsDb();
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', '/repo/one', 100],
    });
    writeStamp(dir, {
      projectKey: '/repo/one',
      rowCount: 1,
      maxUpdatedAt: 100,
      generatedAt: '2026-08-09T00:00:00.000Z',
    });
    await client.execute({
      sql: 'UPDATE beads SET updated_at = ? WHERE id = ?',
      args: [999, 'a'],
    });

    const result = await checkStaleness({
      client,
      projectKey: '/repo/one',
      repoPath: dir,
    });
    expect(result.stale).toBe(true);
  });

  test('does NOT go stale when only git HEAD moves - the critical trap', async () => {
    const dir = makeScratchRepo();
    const client = await seedBeadsDb();
    await client.execute({
      sql: 'INSERT INTO beads (id, project_key, updated_at) VALUES (?, ?, ?)',
      args: ['a', '/repo/one', 100],
    });
    writeStamp(dir, {
      projectKey: '/repo/one',
      rowCount: 1,
      maxUpdatedAt: 100,
      generatedAt: '2026-08-09T00:00:00.000Z',
    });

    const before = await checkStaleness({
      client,
      projectKey: '/repo/one',
      repoPath: dir,
    });
    expect(before.stale).toBe(false);

    // Move HEAD without touching the corpus at all.
    execSync('git commit -q --allow-empty -m one', { cwd: dir });
    execSync('git commit -q --allow-empty -m two', { cwd: dir });

    const after = await checkStaleness({
      client,
      projectKey: '/repo/one',
      repoPath: dir,
    });
    expect(after.stale).toBe(false);
  });
});
