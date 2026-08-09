/**
 * docs/config tests - TDD first.
 *
 * Covers config-file-absent defaults, docsmith.json parsing via
 * doc-service's ProjectConfigSchema, the classifier override precedence
 * chain, and projectKey/dbPath derivation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DocsConfigError,
  deriveDbPath,
  deriveProjectKey,
  resolveDocsConfig,
} from './config.js';

const scratchDirs: string[] = [];

function makeScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docsmith-config-test-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('deriveProjectKey', () => {
  test('resolves to an absolute path', () => {
    const dir = makeScratchRepo();
    expect(deriveProjectKey(dir)).toBe(dir);
  });
});

describe('deriveDbPath', () => {
  test('points at the standard hive location', () => {
    expect(deriveDbPath()).toBe(
      join(homedir(), '.config', 'swarm-tools', 'swarm.db'),
    );
  });
});

describe('resolveDocsConfig - no config file', () => {
  test('defaults project.name to the repo directory basename', () => {
    const dir = makeScratchRepo();
    const resolved = resolveDocsConfig(dir);
    expect(resolved.hasConfigFile).toBe(false);
    expect(resolved.projectConfig.project.name).toBe(basename(dir));
  });

  test('defaults all four outputs to enabled', () => {
    const dir = makeScratchRepo();
    const resolved = resolveDocsConfig(dir);
    expect(resolved.projectConfig.outputs).toEqual({
      runbooks: true,
      wiki: true,
      blog: true,
      policy: true,
    });
  });

  test('defaults classifier to enabled - never relies on NODE_ENV', () => {
    const dir = makeScratchRepo();
    const resolved = resolveDocsConfig(dir);
    expect(resolved.classifierEnabled).toBe(true);
  });

  test('derives projectKey and dbPath even with no config file', () => {
    const dir = makeScratchRepo();
    const resolved = resolveDocsConfig(dir);
    expect(resolved.projectKey).toBe(deriveProjectKey(dir));
    expect(resolved.dbPath).toBe(deriveDbPath());
  });
});

describe('resolveDocsConfig - with docsmith.json', () => {
  test('honors an overridden project name and description', () => {
    const dir = makeScratchRepo();
    writeFileSync(
      join(dir, 'docsmith.json'),
      JSON.stringify({
        project: { name: 'my-repo', description: 'A test repo' },
      }),
    );
    const resolved = resolveDocsConfig(dir);
    expect(resolved.hasConfigFile).toBe(true);
    expect(resolved.projectConfig.project.name).toBe('my-repo');
    expect(resolved.projectConfig.project.description).toBe('A test repo');
  });

  test('honors output toggles', () => {
    const dir = makeScratchRepo();
    writeFileSync(
      join(dir, 'docsmith.json'),
      JSON.stringify({ outputs: { blog: false, policy: false } }),
    );
    const resolved = resolveDocsConfig(dir);
    expect(resolved.projectConfig.outputs).toEqual({
      runbooks: true,
      wiki: true,
      blog: false,
      policy: false,
    });
  });

  test('honors classifier.enabled: false from config', () => {
    const dir = makeScratchRepo();
    writeFileSync(
      join(dir, 'docsmith.json'),
      JSON.stringify({ classifier: { enabled: false } }),
    );
    const resolved = resolveDocsConfig(dir);
    expect(resolved.classifierEnabled).toBe(false);
  });

  test('CLI classifierOverride wins over docsmith.json', () => {
    const dir = makeScratchRepo();
    writeFileSync(
      join(dir, 'docsmith.json'),
      JSON.stringify({ classifier: { enabled: false } }),
    );
    const resolved = resolveDocsConfig(dir, { classifierOverride: true });
    expect(resolved.classifierEnabled).toBe(true);
  });

  test('throws DocsConfigError on invalid JSON', () => {
    const dir = makeScratchRepo();
    writeFileSync(join(dir, 'docsmith.json'), '{ not valid json');
    expect(() => resolveDocsConfig(dir)).toThrow(DocsConfigError);
  });

  test('throws DocsConfigError on a schema violation', () => {
    const dir = makeScratchRepo();
    writeFileSync(
      join(dir, 'docsmith.json'),
      JSON.stringify({ outputs: { runbooks: 'yes' } }),
    );
    expect(() => resolveDocsConfig(dir)).toThrow(DocsConfigError);
  });

  test("custom paths pass through to doc-service's validated config", () => {
    const dir = makeScratchRepo();
    writeFileSync(
      join(dir, 'docsmith.json'),
      JSON.stringify({ paths: { root: 'documentation' } }),
    );
    const resolved = resolveDocsConfig(dir);
    expect(resolved.projectConfig.paths.root).toBe('documentation');
    // Unset path fields keep doc-service's own defaults.
    expect(resolved.projectConfig.paths.wiki).toBe('docs/generated/wiki');
  });
});
