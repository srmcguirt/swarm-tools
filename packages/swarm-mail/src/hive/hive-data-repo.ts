/**
 * hive-data repo resolution
 *
 * Locates the private `hive-data` repo (per-project JSONL mirrors + agent
 * config, externalized out of individual working repos — see
 * `hive-data-repo-design.md`) and computes the slug used to name a given
 * project's folder under `repos/` in that repo.
 *
 * This module intentionally never touches the hive DB's `project_key`
 * (the absolute working-directory path used to partition rows inside the
 * one global `~/.config/swarm-tools/swarm.db`). The slug computed here is
 * a second, independent identity used purely for hive-data folder naming.
 *
 * @module hive/hive-data-repo
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";
import { hashProjectPath } from "../libsql.convenience.js";

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown when the hive-data repo can't be located or is in a state that
 * makes it unsafe to write to (missing, not a git repo, mid-merge/rebase).
 *
 * Always thrown with an actionable message — hive_sync must fail loudly
 * here rather than silently falling back to writing the working repo.
 */
export class HiveDataRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HiveDataRepoError";
  }
}

// ============================================================================
// Repo root resolution
// ============================================================================

export interface ResolveHiveDataRepoRootOptions {
  /** Override for process.env (testability). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Override for the config file path (testability). */
  configPath?: string;
  /** Override for the home directory (testability). Defaults to os.homedir(). */
  homeDir?: string;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/**
 * Resolve the local path to the hive-data repo.
 *
 * Precedence:
 * 1. `HIVE_DATA_REPO` env var
 * 2. `hiveDataRepo` key in `~/.config/swarm-tools/config.json`
 * 3. Default: `~/hive-data`
 *
 * This only resolves a path — it does not check that the path exists or
 * is a valid git repo. Call `assertHiveDataRepoReady()` for that.
 */
export function resolveHiveDataRepoRoot(
  options: ResolveHiveDataRepoRootOptions = {},
): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const configPath =
    options.configPath ?? join(home, ".config", "swarm-tools", "config.json");

  const fromEnv = env.HIVE_DATA_REPO;
  if (fromEnv && fromEnv.trim() !== "") {
    return expandHome(fromEnv.trim(), home);
  }

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as { hiveDataRepo?: unknown };
      if (
        typeof parsed.hiveDataRepo === "string" &&
        parsed.hiveDataRepo.trim() !== ""
      ) {
        return expandHome(parsed.hiveDataRepo.trim(), home);
      }
    } catch {
      // Malformed config file — fall through to the default rather than
      // crash resolution. hive_sync will still fail loudly downstream if
      // the resulting default path isn't a real hive-data repo.
    }
  }

  return join(home, "hive-data");
}

// ============================================================================
// Repo state guards
// ============================================================================

/**
 * Verify the hive-data repo exists and is a real git repository.
 *
 * Throws `HiveDataRepoError` with an actionable message if not — never
 * silently falls back to writing somewhere else.
 */
export function assertHiveDataRepoReady(root: string): void {
  if (!existsSync(root)) {
    throw new HiveDataRepoError(
      `hive-data repo not found at ${root}. Clone it (e.g. \`git clone <hive-data-remote-url> ${root}\`) ` +
        `or point at the correct location via the HIVE_DATA_REPO env var or ` +
        `"hiveDataRepo" in ~/.config/swarm-tools/config.json.`,
    );
  }

  if (!existsSync(join(root, ".git"))) {
    throw new HiveDataRepoError(
      `${root} exists but is not a git repository (no .git/ found). Refusing to write hive sync data there.`,
    );
  }
}

/**
 * Verify the hive-data repo isn't mid-merge or mid-rebase.
 *
 * Throws `HiveDataRepoError` if so — hive_sync must not stash/commit/pull
 * on top of an unresolved conflict.
 */
export function assertHiveDataRepoNotMidMerge(root: string): void {
  const gitDir = join(root, ".git");
  if (existsSync(join(gitDir, "MERGE_HEAD"))) {
    throw new HiveDataRepoError(
      `hive-data repo at ${root} has an unresolved merge in progress (MERGE_HEAD present). ` +
        `Resolve it manually (git status, git merge --continue/--abort) before syncing.`,
    );
  }
  if (
    existsSync(join(gitDir, "rebase-merge")) ||
    existsSync(join(gitDir, "rebase-apply"))
  ) {
    throw new HiveDataRepoError(
      `hive-data repo at ${root} has an unresolved rebase in progress. ` +
        `Resolve it manually (git status, git rebase --continue/--abort) before syncing.`,
    );
  }
}

// ============================================================================
// Remote URL normalization
// ============================================================================

/**
 * Normalize a git remote URL to a `<host>/<owner>/<repo>` slug.
 *
 * Strips protocol/scheme, embedded credentials, and a trailing `.git`;
 * lowercases the host. Handles both scp-style (`git@host:owner/repo.git`)
 * and URL-style (`https://host/owner/repo.git`) remotes.
 */
export function normalizeGitRemoteUrl(url: string): string {
  let s = url.trim();

  // Strip scheme (https://, http://, ssh://, git://)
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");

  // Strip embedded credentials / scp-style user (user@ or user:token@)
  s = s.replace(/^[^@/]+@/, "");

  // scp-style host:path -> host/path (only the first colon, which
  // separates host from path in scp syntax)
  s = s.replace(":", "/");

  // Strip trailing .git and trailing slashes
  s = s.replace(/\.git\/?$/i, "");
  s = s.replace(/\/+$/, "");

  // Lowercase only the host segment (owner/repo casing is preserved)
  const parts = s.split("/");
  if (parts.length > 0) {
    parts[0] = parts[0].toLowerCase();
  }

  return parts.join("/");
}

// ============================================================================
// Slug resolution (per working-repo identity for hive-data folder naming)
// ============================================================================

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } finally {
    proc.kill();
  }
}

async function getPreferredRemoteUrl(
  projectPath: string,
): Promise<string | null> {
  const remotesResult = await runGit(["remote"], projectPath);
  if (remotesResult.exitCode !== 0) return null;

  const names = remotesResult.stdout
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);

  if (names.length === 0) return null;

  const preferred = names.includes("origin") ? "origin" : [...names].sort()[0];

  const urlResult = await runGit(["remote", "get-url", preferred], projectPath);
  if (urlResult.exitCode !== 0) return null;

  const url = urlResult.stdout.trim();
  return url === "" ? null : url;
}

function hashFallbackSlug(projectPath: string): string {
  const base = basename(projectPath);
  return `${base}-${hashProjectPath(projectPath)}`;
}

/**
 * Resolve the hive-data folder slug for a working repo.
 *
 * 1. If the repo has a git remote: prefer `origin`, else the first remote
 *    alphabetically, and normalize its URL to `<host>/<owner>/<repo>`.
 * 2. Otherwise (no remote, or not a git repo at all): fall back to
 *    `<basename>-<8-char sha256 hash of the absolute path>`, reusing the
 *    existing `hashProjectPath()` helper.
 *
 * Independent of the hive DB's `project_key` — used only to name folders
 * under `hive-data/repos/`.
 */
export async function resolveHiveDataSlug(
  projectPath: string,
): Promise<string> {
  try {
    const remoteUrl = await getPreferredRemoteUrl(projectPath);
    if (remoteUrl) {
      const normalized = normalizeGitRemoteUrl(remoteUrl);
      if (normalized) return normalized;
    }
  } catch {
    // git not available / not a repo / spawn failure — fall through to hash
  }

  return hashFallbackSlug(projectPath);
}

// ============================================================================
// Path helpers
// ============================================================================

/**
 * Compute the per-project directory under a hive-data repo for a given
 * slug. Remote-based slugs (containing `/`) nest into
 * `repos/<host>/<owner>/<repo>/`; hash-fallback slugs sit flat directly
 * under `repos/<slug>/`.
 */
export function hiveDataProjectDir(hiveDataRoot: string, slug: string): string {
  const segments = slug.split("/").filter(Boolean);
  return join(hiveDataRoot, "repos", ...segments);
}
