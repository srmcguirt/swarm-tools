/**
 * Memory Scope Resolution Tests
 *
 * Covers cwd -> {repoKey, packageKey} inference and the explicit
 * write-time override (`resolveStoreScope`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GLOBAL_SCOPE,
  resolveMemoryScope,
  resolveStoreScope,
} from "./scope.js";

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

async function initGitRepo(dir: string, remoteUrl?: string): Promise<void> {
  await runGit(["init", "-q"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "Test"], dir);
  if (remoteUrl) {
    await runGit(["remote", "add", "origin", remoteUrl], dir);
  }
}

describe("resolveMemoryScope", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "scope-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("not inside a git repo -> global (bias toward global when ambiguous)", async () => {
    const scope = await resolveMemoryScope(tmpRoot);
    expect(scope).toEqual(GLOBAL_SCOPE);
  });

  test("inside a git repo with a remote -> repoKey from the remote, no packageKey at repo root", async () => {
    await initGitRepo(tmpRoot, "git@github.com:acme/widgets.git");

    const scope = await resolveMemoryScope(tmpRoot);

    expect(scope.repoKey).toBe("github.com/acme/widgets");
    expect(scope.packageKey).toBeNull();
  });

  test("inside a git repo with no remote -> hash-fallback repoKey (still repo-scoped, not global)", async () => {
    await initGitRepo(tmpRoot);

    const scope = await resolveMemoryScope(tmpRoot);

    expect(scope.repoKey).not.toBeNull();
    expect(scope.packageKey).toBeNull();
  });

  test("cwd nested under a package.json in a monorepo -> packageKey is the repo-relative path", async () => {
    await initGitRepo(tmpRoot, "git@github.com:acme/monorepo.git");

    const pkgDir = join(tmpRoot, "packages", "swarm-mail");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "swarm-mail" }),
    );

    const scope = await resolveMemoryScope(join(pkgDir, "src"));

    expect(scope.repoKey).toBe("github.com/acme/monorepo");
    expect(scope.packageKey).toBe("packages/swarm-mail");
  });

  test("cwd nested under a directory with no package.json before the repo root -> packageKey null", async () => {
    await initGitRepo(tmpRoot, "git@github.com:acme/widgets.git");

    const nested = join(tmpRoot, "src", "deep", "nested");
    mkdirSync(nested, { recursive: true });

    const scope = await resolveMemoryScope(nested);

    expect(scope.repoKey).toBe("github.com/acme/widgets");
    expect(scope.packageKey).toBeNull();
  });

  test("cwd at the repo root itself (single-package repo) -> packageKey null even with package.json at root", async () => {
    await initGitRepo(tmpRoot, "git@github.com:acme/widgets.git");
    writeFileSync(
      join(tmpRoot, "package.json"),
      JSON.stringify({ name: "widgets" }),
    );

    const scope = await resolveMemoryScope(tmpRoot);

    expect(scope.repoKey).toBe("github.com/acme/widgets");
    expect(scope.packageKey).toBeNull();
  });
});

describe("resolveStoreScope", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "scope-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("default ('auto') matches resolveMemoryScope", async () => {
    await initGitRepo(tmpRoot, "git@github.com:acme/widgets.git");

    const auto = await resolveStoreScope(tmpRoot);
    const direct = await resolveMemoryScope(tmpRoot);

    expect(auto).toEqual(direct);
  });

  test("'global' override forces global regardless of cwd", async () => {
    await initGitRepo(tmpRoot, "git@github.com:acme/widgets.git");

    const scope = await resolveStoreScope(tmpRoot, "global");

    expect(scope).toEqual(GLOBAL_SCOPE);
  });

  test("'repo' override drops any inferred package scope", async () => {
    await initGitRepo(tmpRoot, "git@github.com:acme/monorepo.git");
    const pkgDir = join(tmpRoot, "packages", "swarm-mail");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "swarm-mail" }),
    );

    const scope = await resolveStoreScope(pkgDir, "repo");

    expect(scope.repoKey).toBe("github.com/acme/monorepo");
    expect(scope.packageKey).toBeNull();
  });

  test("a concrete MemoryScope object is passed through unchanged", async () => {
    const explicit = {
      repoKey: "github.com/acme/other",
      packageKey: "packages/x",
    };

    const scope = await resolveStoreScope(tmpRoot, explicit);

    expect(scope).toEqual(explicit);
  });
});
