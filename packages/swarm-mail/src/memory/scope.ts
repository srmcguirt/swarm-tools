/**
 * Memory Scope Resolution
 *
 * Resolves a working directory to a repo/package scope for memories, so
 * search can default to package ∪ repo ∪ global instead of one
 * undifferentiated "default" collection.
 *
 * ## The model
 * - **package**: e.g. `packages/swarm-mail` inside a monorepo. Enables
 *   per-package docs and isolation.
 * - **repo**: e.g. `github.com/srmcguirt/swarm-tools`. Uses the exact same
 *   slug scheme as `hive/hive-data-repo.ts`'s `resolveHiveDataSlug()` -
 *   deliberately not a second, independently-drifting scheme.
 * - **global**: cross-project learnings. Both scope fields null.
 *
 * ## Resolution
 * `resolveMemoryScope(cwd)` walks up from `cwd` to the git repo root (via
 * `git rev-parse --show-toplevel`) and:
 * - Not inside a git repo at all -> global. Bias toward global when
 *   ambiguous: a global memory that fails to surface is worse than one
 *   that surfaces unnecessarily.
 * - Inside a git repo -> repoKey via `resolveHiveDataSlug(repoRoot)`.
 *   If `cwd` sits under a nested `package.json` (relative to the repo
 *   root), packageKey is that repo-root-relative path; otherwise null
 *   (repo-level scope covers single-package repos).
 *
 * `resolveStoreScope(cwd, input)` layers an explicit write-time decision
 * on top of that inference, so an agent can say "this is global"
 * regardless of cwd.
 *
 * @module memory/scope
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { resolveHiveDataSlug } from "../hive/hive-data-repo.js";

// ============================================================================
// Types
// ============================================================================

/** Resolved repo/package scope for a memory. Null fields = global. */
export interface MemoryScope {
  readonly repoKey: string | null;
  readonly packageKey: string | null;
}

/** The global scope: both fields null. */
export const GLOBAL_SCOPE: MemoryScope = { repoKey: null, packageKey: null };

/**
 * Explicit scope decision at write/search time.
 *
 * - `"auto"` (default): infer from cwd via `resolveMemoryScope()`.
 * - `"global"`: force global regardless of cwd.
 * - `"repo"`: force repo-level scope (drops any inferred package scope).
 * - A concrete `MemoryScope` object: use exactly as given (e.g. to
 *   rehydrate a previously-resolved scope without re-running git).
 */
export type ScopeInput = "auto" | "global" | "repo" | MemoryScope;

// ============================================================================
// Git helpers
// ============================================================================

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout };
  } finally {
    proc.kill();
  }
}

/**
 * Find the git repo root containing `cwd`, resolved to a real path
 * (symlinks resolved) so it can be safely compared against other
 * realpath'd directories.
 *
 * Returns null if `cwd` isn't inside a git working tree, or git isn't
 * available at all.
 */
async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const { exitCode, stdout } = await runGit(
      ["rev-parse", "--show-toplevel"],
      cwd,
    );
    if (exitCode !== 0) return null;
    const root = stdout.trim();
    if (root === "") return null;
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  } catch {
    return null;
  }
}

// ============================================================================
// Package detection
// ============================================================================

/**
 * Walk up from `startDir` (inclusive) looking for the nearest ancestor
 * directory containing a `package.json`, stopping at (and including)
 * `stopAtDir`. Returns null if none is found by the time `stopAtDir` is
 * reached, or if the filesystem root is hit first (shouldn't happen when
 * `stopAtDir` is a real ancestor of `startDir`).
 */
function findNearestPackageDir(
  startDir: string,
  stopAtDir: string,
): string | null {
  let dir = startDir;
  // Safety bound in case stopAtDir isn't actually an ancestor of startDir
  // (e.g. realpath drift) - never loop more than the path is deep.
  const maxHops = startDir.split(sep).length + 1;
  for (let i = 0; i < maxHops; i++) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    if (dir === stopAtDir) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function toRepoRelativePackageKey(repoRoot: string, pkgDir: string): string {
  return relative(repoRoot, pkgDir).split(sep).join("/");
}

// ============================================================================
// Resolution
// ============================================================================

/**
 * Infer the memory scope for a working directory.
 *
 * Never throws - falls back to `GLOBAL_SCOPE` on any resolution failure
 * (no git, git not installed, filesystem errors), per "bias toward
 * global when ambiguous."
 */
export async function resolveMemoryScope(cwd: string): Promise<MemoryScope> {
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    return GLOBAL_SCOPE;
  }

  const repoKey = await resolveHiveDataSlug(repoRoot);

  let resolvedCwd: string;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    resolvedCwd = cwd;
  }

  const pkgDir = findNearestPackageDir(resolvedCwd, repoRoot);
  const packageKey =
    pkgDir && pkgDir !== repoRoot
      ? toRepoRelativePackageKey(repoRoot, pkgDir)
      : null;

  return { repoKey, packageKey };
}

/**
 * Resolve the scope to store/search with, given an explicit write-time
 * decision (`ScopeInput`). Defaults to `"auto"` (cwd inference).
 */
export async function resolveStoreScope(
  cwd: string,
  input: ScopeInput = "auto",
): Promise<MemoryScope> {
  if (input === "global") return GLOBAL_SCOPE;

  if (input === "auto") return resolveMemoryScope(cwd);

  if (input === "repo") {
    const auto = await resolveMemoryScope(cwd);
    return { repoKey: auto.repoKey, packageKey: null };
  }

  // Concrete MemoryScope object - use as given.
  return input;
}
