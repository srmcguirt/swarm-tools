/**
 * docs/hook tests - TDD first.
 *
 * Covers pre-push hook installation: idempotent re-install, never
 * clobbering a pre-existing user hook, and clean removal that preserves
 * anything the hook owner didn't put there.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installPrePushHook,
  prePushHookPath,
  uninstallPrePushHook,
} from './hook.js';

const scratchDirs: string[] = [];

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docsmith-hook-test-'));
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

describe('installPrePushHook', () => {
  test('creates an executable pre-push hook when none exists', () => {
    const dir = makeGitRepo();
    const result = installPrePushHook(dir);

    expect(result.action).toBe('created');
    const hookPath = prePushHookPath(dir);
    expect(existsSync(hookPath)).toBe(true);
    expect(readFileSync(hookPath, 'utf8')).toContain('swarm docs check');
    const mode = statSync(hookPath).mode;
    expect((mode & 0o111) !== 0).toBe(true); // executable by someone
  });

  test('is idempotent - re-running does not duplicate the block', () => {
    const dir = makeGitRepo();
    installPrePushHook(dir);
    const second = installPrePushHook(dir);

    expect(second.action).toBe('unchanged');
    const content = readFileSync(prePushHookPath(dir), 'utf8');
    const occurrences = content.split('swarm docs check').length - 1;
    expect(occurrences).toBe(1);
  });

  test('appends to (never clobbers) a pre-existing foreign pre-push hook', () => {
    const dir = makeGitRepo();
    const hookPath = prePushHookPath(dir);
    writeFileSync(hookPath, "#!/bin/sh\necho 'my custom hook'\n", {
      mode: 0o755,
    });

    const result = installPrePushHook(dir);

    expect(result.action).toBe('appended');
    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('my custom hook');
    expect(content).toContain('swarm docs check');
  });

  test('throws when the target is not a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docsmith-hook-nogit-'));
    scratchDirs.push(dir);
    expect(() => installPrePushHook(dir)).toThrow();
  });
});

describe('uninstallPrePushHook', () => {
  test('no-ops when no pre-push hook exists', () => {
    const dir = makeGitRepo();
    const result = uninstallPrePushHook(dir);
    expect(result.action).toBe('unchanged');
  });

  test('removes the file entirely when it contained only our block', () => {
    const dir = makeGitRepo();
    installPrePushHook(dir);
    uninstallPrePushHook(dir);
    expect(existsSync(prePushHookPath(dir))).toBe(false);
  });

  test('preserves foreign content when removing our block from a shared hook', () => {
    const dir = makeGitRepo();
    const hookPath = prePushHookPath(dir);
    writeFileSync(hookPath, "#!/bin/sh\necho 'my custom hook'\n", {
      mode: 0o755,
    });
    installPrePushHook(dir);

    uninstallPrePushHook(dir);

    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('my custom hook');
    expect(content).not.toContain('swarm docs check');
  });

  test('leaves a foreign-only hook (no marker) untouched', () => {
    const dir = makeGitRepo();
    const hookPath = prePushHookPath(dir);
    writeFileSync(hookPath, "#!/bin/sh\necho 'not ours'\n", { mode: 0o755 });

    const result = uninstallPrePushHook(dir);

    expect(result.action).toBe('skipped-foreign');
    expect(readFileSync(hookPath, 'utf8')).toContain('not ours');
  });
});
