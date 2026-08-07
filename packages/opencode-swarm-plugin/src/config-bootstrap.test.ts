/**
 * config-bootstrap tests - TDD first
 *
 * Covers:
 * - bootstrapProjectConfig(): AGENTS.md/CLAUDE.md/MEMORY.md short-circuit,
 *   untracked opencode.json creation pointing at hive-data memories files,
 *   idempotency, and non-destructive handling of a pre-existing
 *   opencode.json (both foreign and bootstrap-managed).
 * - ensureOpencodeJsonGloballyIgnored(): global excludesFile creation vs.
 *   reuse, non-destructive append, idempotency.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootstrapProjectConfig,
  ensureOpencodeJsonGloballyIgnored,
} from "./config-bootstrap.js";

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

async function initGitRepo(dir: string, remote?: string): Promise<void> {
  await runGit(["init", "-q"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "test\n");
  await runGit(["add", "."], dir);
  await runGit(["commit", "-q", "-m", "init"], dir);
  if (remote) {
    await runGit(["remote", "add", "origin", remote], dir);
  }
}

/** Build a scratch hive-data root with global/ and repos/<slug>/ populated. */
function makeHiveDataRoot(opts: {
  global?: boolean;
  projectSlugDir?: string;
}): string {
  const root = scratchDir("hive-data-");
  if (opts.global) {
    mkdirSync(join(root, "global"), { recursive: true });
    writeFileSync(join(root, "global", "memories.jsonl"), "");
  }
  if (opts.projectSlugDir) {
    const dir = join(root, "repos", opts.projectSlugDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "memories.jsonl"), "");
  }
  return root;
}

describe("bootstrapProjectConfig", () => {
  for (const name of ["AGENTS.md", "CLAUDE.md", "MEMORY.md"]) {
    test(`skips (honors existing config) when project has ${name}`, async () => {
      const project = scratchDir("project-");
      await initGitRepo(project);
      writeFileSync(join(project, name), "# project rules\n");
      const hiveDataRoot = makeHiveDataRoot({ global: true });

      const result = await bootstrapProjectConfig(project, {
        hiveDataRepoOptions: { env: { HIVE_DATA_REPO: hiveDataRoot } },
      });

      expect(result.action).toBe("skipped-has-agent-file");
      expect(existsSync(join(project, "opencode.json"))).toBe(false);
    });
  }

  test("creates untracked opencode.json pointing at global + project hive-data memories", async () => {
    const project = scratchDir("project-");
    await initGitRepo(project, "git@github.com:acme/widgets.git");
    const hiveDataRoot = makeHiveDataRoot({
      global: true,
      projectSlugDir: "github.com/acme/widgets",
    });

    const result = await bootstrapProjectConfig(project, {
      hiveDataRepoOptions: { env: { HIVE_DATA_REPO: hiveDataRoot } },
    });

    expect(result.action).toBe("created");
    const opencodeJsonPath = join(project, "opencode.json");
    expect(existsSync(opencodeJsonPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"));
    expect(Array.isArray(parsed.instructions)).toBe(true);
    expect(parsed.instructions).toContain(
      join(hiveDataRoot, "global", "memories.jsonl"),
    );
    expect(parsed.instructions).toContain(
      join(hiveDataRoot, "repos", "github.com/acme/widgets", "memories.jsonl"),
    );

    // Every generated instruction path must actually resolve to a real file.
    for (const p of parsed.instructions) {
      expect(existsSync(p)).toBe(true);
    }

    // No agentic prose - only pointer config.
    expect(Object.keys(parsed).sort()).toEqual(["$schema", "instructions"]);
  });

  test("points only at global/ when the project's hive-data folder doesn't exist yet", async () => {
    const project = scratchDir("project-");
    await initGitRepo(project, "git@github.com:acme/brand-new.git");
    const hiveDataRoot = makeHiveDataRoot({ global: true }); // no repos/ dir at all

    const result = await bootstrapProjectConfig(project, {
      hiveDataRepoOptions: { env: { HIVE_DATA_REPO: hiveDataRoot } },
    });

    expect(result.action).toBe("created");
    const parsed = JSON.parse(
      readFileSync(join(project, "opencode.json"), "utf-8"),
    );
    expect(parsed.instructions).toEqual([
      join(hiveDataRoot, "global", "memories.jsonl"),
    ]);
  });

  test("skips entirely when neither global nor project hive-data files exist", async () => {
    const project = scratchDir("project-");
    await initGitRepo(project);
    const hiveDataRoot = scratchDir("hive-data-empty-"); // repo root exists, nothing in it

    const result = await bootstrapProjectConfig(project, {
      hiveDataRepoOptions: { env: { HIVE_DATA_REPO: hiveDataRoot } },
    });

    expect(result.action).toBe("skipped-no-hive-data");
    expect(existsSync(join(project, "opencode.json"))).toBe(false);
  });

  test("is idempotent - running twice does not rewrite an unchanged file", async () => {
    const project = scratchDir("project-");
    await initGitRepo(project, "git@github.com:acme/widgets.git");
    const hiveDataRoot = makeHiveDataRoot({
      global: true,
      projectSlugDir: "github.com/acme/widgets",
    });
    const opts = {
      hiveDataRepoOptions: { env: { HIVE_DATA_REPO: hiveDataRoot } },
    };

    const first = await bootstrapProjectConfig(project, opts);
    expect(first.action).toBe("created");
    const contentAfterFirst = readFileSync(
      join(project, "opencode.json"),
      "utf-8",
    );

    const second = await bootstrapProjectConfig(project, opts);
    expect(second.action).toBe("unchanged");
    const contentAfterSecond = readFileSync(
      join(project, "opencode.json"),
      "utf-8",
    );
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  test("does not clobber a pre-existing foreign opencode.json", async () => {
    const project = scratchDir("project-");
    await initGitRepo(project, "git@github.com:acme/widgets.git");
    const hiveDataRoot = makeHiveDataRoot({
      global: true,
      projectSlugDir: "github.com/acme/widgets",
    });
    const foreignConfig = {
      mcp: { someServer: { command: ["foo"] } },
      instructions: ["./docs/CONVENTIONS.md"],
    };
    writeFileSync(
      join(project, "opencode.json"),
      JSON.stringify(foreignConfig, null, 2),
    );

    const result = await bootstrapProjectConfig(project, {
      hiveDataRepoOptions: { env: { HIVE_DATA_REPO: hiveDataRoot } },
    });

    expect(result.action).toBe("skipped-foreign-opencode-json");
    const stillThere = JSON.parse(
      readFileSync(join(project, "opencode.json"), "utf-8"),
    );
    expect(stillThere).toEqual(foreignConfig);
  });

  test("updates a bootstrap-managed opencode.json when hive-data instructions change", async () => {
    const project = scratchDir("project-");
    await initGitRepo(project, "git@github.com:acme/widgets.git");
    const hiveDataRoot = makeHiveDataRoot({ global: true }); // no project dir yet

    const first = await bootstrapProjectConfig(project, {
      hiveDataRepoOptions: { env: { HIVE_DATA_REPO: hiveDataRoot } },
    });
    expect(first.action).toBe("created");
    expect(first.instructions).toEqual([
      join(hiveDataRoot, "global", "memories.jsonl"),
    ]);

    // Project's hive-data folder appears later (e.g. after a hive_sync).
    const projectDir = join(hiveDataRoot, "repos", "github.com/acme/widgets");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "memories.jsonl"), "");

    const second = await bootstrapProjectConfig(project, {
      hiveDataRepoOptions: { env: { HIVE_DATA_REPO: hiveDataRoot } },
    });
    expect(second.action).toBe("updated");
    expect(second.instructions).toContain(join(projectDir, "memories.jsonl"));
  });
});

describe("ensureOpencodeJsonGloballyIgnored", () => {
  test("creates ~/.config/git/ignore and points core.excludesFile at it when unset", () => {
    const home = scratchDir("home-");
    let configuredPath: string | null = null;

    const result = ensureOpencodeJsonGloballyIgnored({
      homeDir: home,
      getExcludesFile: () => null,
      setExcludesFile: (path) => {
        configuredPath = path;
      },
    });

    const expectedPath = join(home, ".config", "git", "ignore");
    expect(result.action).toBe("created-excludes-file");
    expect(result.excludesFile).toBe(expectedPath);
    expect(configuredPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf-8")).toContain("opencode.json");
  });

  test("appends to an existing excludesFile without clobbering existing entries", () => {
    const home = scratchDir("home-");
    const existing = join(home, "my-global-ignore");
    writeFileSync(existing, "*.log\n.DS_Store\n");

    const result = ensureOpencodeJsonGloballyIgnored({
      homeDir: home,
      getExcludesFile: () => existing,
      setExcludesFile: () => {
        throw new Error("should not reconfigure an already-set excludesFile");
      },
    });

    expect(result.action).toBe("appended");
    const content = readFileSync(existing, "utf-8");
    expect(content).toContain("*.log");
    expect(content).toContain(".DS_Store");
    expect(content).toContain("opencode.json");
  });

  test("expands ~ in an existing excludesFile path against homeDir", () => {
    const home = scratchDir("home-");
    mkdirSync(join(home, "gitcfg"), { recursive: true });
    writeFileSync(join(home, "gitcfg", "ignore"), "node_modules\n");

    const result = ensureOpencodeJsonGloballyIgnored({
      homeDir: home,
      getExcludesFile: () => "~/gitcfg/ignore",
      setExcludesFile: () => {
        throw new Error("should not reconfigure an already-set excludesFile");
      },
    });

    expect(result.excludesFile).toBe(join(home, "gitcfg", "ignore"));
    expect(result.action).toBe("appended");
  });

  test("is idempotent - does not duplicate the entry on a second run", () => {
    const home = scratchDir("home-");
    const existing = join(home, "ignore");
    writeFileSync(existing, "opencode.json\n");

    const result = ensureOpencodeJsonGloballyIgnored({
      homeDir: home,
      getExcludesFile: () => existing,
      setExcludesFile: () => {
        throw new Error("should not reconfigure an already-set excludesFile");
      },
    });

    expect(result.action).toBe("already-ignored");
    const content = readFileSync(existing, "utf-8");
    expect(content.match(/^opencode\.json$/gm)?.length).toBe(1);
  });
});
