/**
 * Pre-push hook install/uninstall for `swarm docs check`.
 *
 * Opt-in (never installed silently - only via `swarm docs install-hook` or
 * an explicit prompt inside `swarm setup`), idempotent, and never clobbers
 * a pre-existing user pre-push hook: our block is appended behind a marker
 * pair, and uninstall only ever removes what's between those markers,
 * leaving anything else in the file exactly as it was.
 */
import { execSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const MARKER_BEGIN = '# >>> swarm-docs-check >>>';
const MARKER_END = '# <<< swarm-docs-check <<<';

function hookBlock(): string {
  return [
    MARKER_BEGIN,
    '# Installed by `swarm docs install-hook`. Do not hand-edit between markers -',
    '# `swarm docs uninstall-hook` removes exactly this block and leaves the rest',
    '# of the file alone. Gates pushes on documentation staleness; never blocks',
    '# an unconfigured repo or one with no hive cells yet.',
    'swarm docs check || exit 1',
    MARKER_END,
  ].join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function gitHooksDir(repoPath: string): string {
  return join(repoPath, '.git', 'hooks');
}

export function prePushHookPath(repoPath: string): string {
  return join(gitHooksDir(repoPath), 'pre-push');
}

export type HookAction =
  | 'created'
  | 'appended'
  | 'unchanged'
  | 'skipped-foreign';

export interface HookResult {
  action: HookAction;
  hookPath: string;
  detail: string;
}

/** Installs (or refreshes) the pre-push hook. Idempotent; appends to, never overwrites, a pre-existing foreign hook. Throws if repoPath has no .git/hooks directory. */
export function installPrePushHook(repoPath: string): HookResult {
  const hooksDir = gitHooksDir(repoPath);
  if (!existsSync(hooksDir)) {
    throw new Error(
      `${repoPath} has no .git/hooks directory - is this a git repository?`,
    );
  }
  const hookPath = prePushHookPath(repoPath);

  if (!existsSync(hookPath)) {
    writeFileSync(hookPath, `#!/bin/sh\n${hookBlock()}\n`);
    execSync(`chmod +x ${JSON.stringify(hookPath)}`);
    return {
      action: 'created',
      hookPath,
      detail: 'Created a new pre-push hook.',
    };
  }

  const existing = readFileSync(hookPath, 'utf8');
  if (existing.includes(MARKER_BEGIN)) {
    return {
      action: 'unchanged',
      hookPath,
      detail: 'swarm docs check is already installed in this hook.',
    };
  }

  const updated = `${existing.trimEnd()}\n\n${hookBlock()}\n`;
  writeFileSync(hookPath, updated);
  execSync(`chmod +x ${JSON.stringify(hookPath)}`);
  return {
    action: 'appended',
    hookPath,
    detail: 'Appended to your existing pre-push hook (nothing removed).',
  };
}

/** Removes exactly the swarm-installed block. Leaves a foreign (unmarked) hook untouched, and preserves any other content around the block. */
export function uninstallPrePushHook(repoPath: string): HookResult {
  const hookPath = prePushHookPath(repoPath);
  if (!existsSync(hookPath)) {
    return {
      action: 'unchanged',
      hookPath,
      detail: 'No pre-push hook present - nothing to remove.',
    };
  }

  const existing = readFileSync(hookPath, 'utf8');
  if (!existing.includes(MARKER_BEGIN)) {
    return {
      action: 'skipped-foreign',
      hookPath,
      detail:
        "Pre-push hook exists but wasn't installed by swarm - leaving it alone.",
    };
  }

  const blockRegex = new RegExp(
    `\\n?${escapeRegExp(MARKER_BEGIN)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n?`,
    'g',
  );
  const stripped = existing.replace(blockRegex, '').trim();

  if (stripped === '' || stripped === '#!/bin/sh') {
    rmSync(hookPath);
    return {
      action: 'unchanged',
      hookPath,
      detail:
        "Removed the pre-push hook file (it contained nothing but swarm's block).",
    };
  }

  writeFileSync(hookPath, `${stripped}\n`);
  const mode = statSync(hookPath).mode;
  if ((mode & 0o111) === 0) {
    execSync(`chmod +x ${JSON.stringify(hookPath)}`);
  }
  return {
    action: 'unchanged',
    hookPath,
    detail: "Removed swarm's block; the rest of your hook is unchanged.",
  };
}
