/**
 * hive-data-repo tests - TDD first
 *
 * Covers:
 * - resolveHiveDataRepoRoot(): env var > config file > default
 * - assertHiveDataRepoReady(): loud failure when repo missing/not git
 * - assertHiveDataRepoNotMidMerge(): loud failure on unresolved merge/rebase
 * - normalizeGitRemoteUrl(): remote URL -> slug string
 * - resolveHiveDataSlug(): real git repos (origin/upstream/no-remote/non-git)
 * - hiveDataProjectDir(): slug -> nested path under repos/
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveHiveDataRepoRoot,
  assertHiveDataRepoReady,
  assertHiveDataRepoNotMidMerge,
  HiveDataRepoError,
  normalizeGitRemoteUrl,
  resolveHiveDataSlug,
  hiveDataProjectDir,
} from "./hive-data-repo.js";
import { hashProjectPath } from "../libsql.convenience.js";

const scratchDirs: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function runGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

async function initGitRepo(dir: string): Promise<void> {
  await runGit(["init", "-q"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "test\n");
  await runGit(["add", "."], dir);
  await runGit(["commit", "-q", "-m", "init"], dir);
}

describe("resolveHiveDataRepoRoot", () => {
  test("prefers HIVE_DATA_REPO env var", () => {
    const home = scratchDir("home-");
    const root = resolveHiveDataRepoRoot({
      env: { HIVE_DATA_REPO: "/custom/hive-data" },
      homeDir: home,
    });
    expect(root).toBe("/custom/hive-data");
  });

  test("expands ~ in env var against homeDir", () => {
    const home = scratchDir("home-");
    const root = resolveHiveDataRepoRoot({
      env: { HIVE_DATA_REPO: "~/somewhere/hive-data" },
      homeDir: home,
    });
    expect(root).toBe(join(home, "somewhere", "hive-data"));
  });

  test("falls back to config file when env var absent", () => {
    const home = scratchDir("home-");
    const configDir = join(home, ".config", "swarm-tools");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ hiveDataRepo: "/configured/hive-data" }),
    );

    const root = resolveHiveDataRepoRoot({
      env: {},
      homeDir: home,
      configPath,
    });
    expect(root).toBe("/configured/hive-data");
  });

  test("falls back to default ~/hive-data when neither env nor config set", () => {
    const home = scratchDir("home-");
    const root = resolveHiveDataRepoRoot({
      env: {},
      homeDir: home,
      configPath: join(home, "nonexistent.json"),
    });
    expect(root).toBe(join(home, "hive-data"));
  });

  test("ignores malformed config file and falls back to default", () => {
    const home = scratchDir("home-");
    const configDir = join(home, ".config", "swarm-tools");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(configPath, "{ not valid json");

    const root = resolveHiveDataRepoRoot({
      env: {},
      homeDir: home,
      configPath,
    });
    expect(root).toBe(join(home, "hive-data"));
  });
});

describe("assertHiveDataRepoReady", () => {
  test("throws HiveDataRepoError when path does not exist", () => {
    const home = scratchDir("home-");
    const missing = join(home, "does-not-exist");
    expect(() => assertHiveDataRepoReady(missing)).toThrow(HiveDataRepoError);
  });

  test("throws HiveDataRepoError when path exists but is not a git repo", () => {
    const dir = scratchDir("not-git-");
    expect(() => assertHiveDataRepoReady(dir)).toThrow(HiveDataRepoError);
  });

  test("error message is actionable (mentions the path and how to fix it)", () => {
    const home = scratchDir("home-");
    const missing = join(home, "does-not-exist");
    try {
      assertHiveDataRepoReady(missing);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HiveDataRepoError);
      const message = (err as Error).message;
      expect(message).toContain(missing);
      expect(message.toLowerCase()).toContain("clone");
    }
  });

  test("does not throw when path exists and is a git repo", async () => {
    const dir = scratchDir("git-repo-");
    await initGitRepo(dir);
    expect(() => assertHiveDataRepoReady(dir)).not.toThrow();
  });
});

describe("assertHiveDataRepoNotMidMerge", () => {
  test("does not throw for a clean repo", async () => {
    const dir = scratchDir("clean-repo-");
    await initGitRepo(dir);
    expect(() => assertHiveDataRepoNotMidMerge(dir)).not.toThrow();
  });

  test("throws HiveDataRepoError when MERGE_HEAD is present (unresolved merge)", async () => {
    const dir = scratchDir("merge-repo-");
    await initGitRepo(dir);
    writeFileSync(join(dir, ".git", "MERGE_HEAD"), "deadbeef\n");
    expect(() => assertHiveDataRepoNotMidMerge(dir)).toThrow(HiveDataRepoError);
  });

  test("throws HiveDataRepoError when rebase-merge is present (unresolved rebase)", async () => {
    const dir = scratchDir("rebase-repo-");
    await initGitRepo(dir);
    mkdirSync(join(dir, ".git", "rebase-merge"), { recursive: true });
    expect(() => assertHiveDataRepoNotMidMerge(dir)).toThrow(HiveDataRepoError);
  });
});

describe("normalizeGitRemoteUrl", () => {
  test("normalizes scp-style ssh URL", () => {
    expect(normalizeGitRemoteUrl("git@github.com:srmcguirt/katas.git")).toBe(
      "github.com/srmcguirt/katas",
    );
  });

  test("normalizes https URL with .git suffix", () => {
    expect(
      normalizeGitRemoteUrl("https://github.com/srmcguirt/katas.git"),
    ).toBe("github.com/srmcguirt/katas");
  });

  test("normalizes https URL without .git suffix", () => {
    expect(normalizeGitRemoteUrl("https://github.com/srmcguirt/katas")).toBe(
      "github.com/srmcguirt/katas",
    );
  });

  test("strips embedded credentials from https URL", () => {
    expect(
      normalizeGitRemoteUrl(
        "https://user:token@github.com/srmcguirt/katas.git",
      ),
    ).toBe("github.com/srmcguirt/katas");
  });

  test("normalizes ssh:// protocol form", () => {
    expect(
      normalizeGitRemoteUrl("ssh://git@github.com/srmcguirt/katas.git"),
    ).toBe("github.com/srmcguirt/katas");
  });

  test("lowercases the host", () => {
    expect(normalizeGitRemoteUrl("git@GitHub.com:srmcguirt/katas.git")).toBe(
      "github.com/srmcguirt/katas",
    );
  });

  test("handles nested group paths (e.g. GitLab subgroups)", () => {
    expect(
      normalizeGitRemoteUrl("git@gitlab.com:group/subgroup/project.git"),
    ).toBe("gitlab.com/group/subgroup/project");
  });
});

describe("resolveHiveDataSlug", () => {
  test("resolves to normalized origin remote when present", async () => {
    const dir = scratchDir("origin-repo-");
    await initGitRepo(dir);
    await runGit(
      ["remote", "add", "origin", "git@github.com:srmcguirt/katas.git"],
      dir,
    );

    const slug = await resolveHiveDataSlug(dir);
    expect(slug).toBe("github.com/srmcguirt/katas");
  });

  test("prefers origin over upstream (fork scenario)", async () => {
    const dir = scratchDir("fork-repo-");
    await initGitRepo(dir);
    await runGit(
      [
        "remote",
        "add",
        "upstream",
        "https://github.com/joelhooks/swarm-tools.git",
      ],
      dir,
    );
    await runGit(
      ["remote", "add", "origin", "git@github.com:srmcguirt/swarm-tools.git"],
      dir,
    );

    const slug = await resolveHiveDataSlug(dir);
    expect(slug).toBe("github.com/srmcguirt/swarm-tools");
  });

  test("falls back to first remote alphabetically when no origin", async () => {
    const dir = scratchDir("no-origin-repo-");
    await initGitRepo(dir);
    await runGit(
      ["remote", "add", "zremote", "git@github.com:someone/z.git"],
      dir,
    );
    await runGit(
      ["remote", "add", "aremote", "git@github.com:someone/a.git"],
      dir,
    );

    const slug = await resolveHiveDataSlug(dir);
    expect(slug).toBe("github.com/someone/a");
  });

  test("falls back to hash scheme when repo has no remote", async () => {
    const dir = scratchDir("no-remote-repo-");
    await initGitRepo(dir);

    const slug = await resolveHiveDataSlug(dir);
    const base = dir.split("/").pop();
    expect(slug).toBe(`${base}-${hashProjectPath(dir)}`);
  });

  test("falls back to hash scheme for a non-git directory", async () => {
    const dir = scratchDir("plain-dir-");

    const slug = await resolveHiveDataSlug(dir);
    const base = dir.split("/").pop();
    expect(slug).toBe(`${base}-${hashProjectPath(dir)}`);
  });

  test("same remote URL from two different clones/worktrees resolves to the same slug", async () => {
    const dirA = scratchDir("worktree-a-");
    const dirB = scratchDir("worktree-b-");
    await initGitRepo(dirA);
    await initGitRepo(dirB);
    await runGit(
      ["remote", "add", "origin", "git@github.com:srmcguirt/shared.git"],
      dirA,
    );
    await runGit(
      ["remote", "add", "origin", "git@github.com:srmcguirt/shared.git"],
      dirB,
    );

    const slugA = await resolveHiveDataSlug(dirA);
    const slugB = await resolveHiveDataSlug(dirB);
    expect(slugA).toBe(slugB);
  });
});

describe("hiveDataProjectDir", () => {
  test("nests remote-based slugs under repos/", () => {
    const result = hiveDataProjectDir(
      "/home/user/hive-data",
      "github.com/srmcguirt/katas",
    );
    expect(result).toBe(
      join("/home/user/hive-data", "repos", "github.com", "srmcguirt", "katas"),
    );
  });

  test("keeps hash-fallback slugs flat under repos/", () => {
    const result = hiveDataProjectDir("/home/user/hive-data", "katas-a1b2c3d4");
    expect(result).toBe(
      join("/home/user/hive-data", "repos", "katas-a1b2c3d4"),
    );
  });
});
