/**
 * Per-project opencode.json config bootstrap.
 *
 * Points a project's opencode agent config at its hive-data mirror
 * (`~/hive-data/repos/<slug>/AGENTS.md` and `memories.jsonl`, plus
 * `~/hive-data/global/memories.jsonl`) without ever writing agentic
 * content (prose, process vocabulary) into the project itself.
 *
 * Policy:
 * - A project with its own AGENTS.md/CLAUDE.md/MEMORY.md is left alone —
 *   that file already wins over anything opencode.json's `instructions`
 *   would add, so bootstrapping would be redundant at best.
 * - A project with none gets an **untracked** opencode.json whose only
 *   content is `{ $schema, instructions }` pointing at real files in
 *   hive-data. Nothing is ever written into the project's own history —
 *   see `ensureOpencodeJsonGloballyIgnored` for the global-gitignore half
 *   of that guarantee.
 * - A pre-existing opencode.json is never merged into blindly: only a
 *   file matching this module's own shallow shape (`{$schema,
 *   instructions}` and nothing else) is treated as bootstrap-managed and
 *   safe to refresh. Anything else is left untouched and reported.
 *
 * @module config-bootstrap
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  resolveHiveDataRepoRoot,
  resolveHiveDataSlug,
  hiveDataProjectDir,
  type ResolveHiveDataRepoRootOptions,
} from "swarm-mail";

// ============================================================================
// Project config bootstrap
// ============================================================================

const AGENT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md", "MEMORY.md"] as const;

const OPENCODE_JSON_SCHEMA = "https://opencode.ai/config.json";

export type BootstrapAction =
  | "skipped-has-agent-file"
  | "skipped-foreign-opencode-json"
  | "skipped-no-hive-data"
  | "created"
  | "updated"
  | "unchanged";

export interface BootstrapProjectConfigOptions {
  /** Passed through to resolveHiveDataRepoRoot() - testability hook. */
  hiveDataRepoOptions?: ResolveHiveDataRepoRootOptions;
}

export interface BootstrapProjectConfigResult {
  action: BootstrapAction;
  detail: string;
  opencodeJsonPath: string;
  instructions?: string[];
}

interface BootstrapManagedShape {
  $schema?: unknown;
  instructions?: unknown;
}

/** True only for `{$schema, instructions}` and nothing else - our own shape. */
function isBootstrapManaged(parsed: unknown): parsed is BootstrapManagedShape {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const keys = Object.keys(parsed).sort();
  return (
    keys.length > 0 &&
    keys.every((k) => k === "$schema" || k === "instructions")
  );
}

function findExistingAgentFile(projectPath: string): string | null {
  for (const name of AGENT_FILE_NAMES) {
    if (existsSync(join(projectPath, name))) return name;
  }
  return null;
}

/** Real hive-data instruction files that currently exist for this project. */
async function computeInstructions(
  projectPath: string,
  hiveDataRepoOptions?: ResolveHiveDataRepoRootOptions,
): Promise<string[]> {
  const hiveDataRoot = resolveHiveDataRepoRoot(hiveDataRepoOptions);
  const instructions: string[] = [];

  const globalMemoriesPath = join(hiveDataRoot, "global", "memories.jsonl");
  if (existsSync(globalMemoriesPath)) {
    instructions.push(globalMemoriesPath);
  }

  const slug = await resolveHiveDataSlug(projectPath);
  const projectDir = hiveDataProjectDir(hiveDataRoot, slug);

  const projectAgentsPath = join(projectDir, "AGENTS.md");
  if (existsSync(projectAgentsPath)) {
    instructions.push(projectAgentsPath);
  }

  const projectMemoriesPath = join(projectDir, "memories.jsonl");
  if (existsSync(projectMemoriesPath)) {
    instructions.push(projectMemoriesPath);
  }

  return instructions;
}

function writeBootstrapConfig(
  opencodeJsonPath: string,
  instructions: string[],
): void {
  const config = { $schema: OPENCODE_JSON_SCHEMA, instructions };
  writeFileSync(opencodeJsonPath, `${JSON.stringify(config, null, 2)}\n`);
}

function sameInstructions(a: string[], b: unknown): boolean {
  if (!Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((p, i) => b[i] === p);
}

/**
 * Bootstrap a project's opencode.json to point at its hive-data mirror.
 *
 * Idempotent and non-destructive: safe to call on every plugin init.
 */
export async function bootstrapProjectConfig(
  projectPath: string,
  options: BootstrapProjectConfigOptions = {},
): Promise<BootstrapProjectConfigResult> {
  const opencodeJsonPath = join(projectPath, "opencode.json");

  const existingAgentFile = findExistingAgentFile(projectPath);
  if (existingAgentFile) {
    return {
      action: "skipped-has-agent-file",
      detail: `${existingAgentFile} already present - honoring it, bootstrap is a no-op.`,
      opencodeJsonPath,
    };
  }

  const instructions = await computeInstructions(
    projectPath,
    options.hiveDataRepoOptions,
  );

  if (existsSync(opencodeJsonPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"));
    } catch {
      return {
        action: "skipped-foreign-opencode-json",
        detail:
          "Existing opencode.json is not valid JSON - leaving it untouched to avoid clobbering.",
        opencodeJsonPath,
      };
    }

    if (!isBootstrapManaged(parsed)) {
      return {
        action: "skipped-foreign-opencode-json",
        detail:
          "Existing opencode.json has fields beyond {$schema, instructions} - assumed hand-authored for unrelated reasons. Left untouched.",
        opencodeJsonPath,
      };
    }

    if (
      sameInstructions(
        instructions,
        (parsed as BootstrapManagedShape).instructions,
      )
    ) {
      return {
        action: "unchanged",
        detail: "opencode.json already points at the current hive-data files.",
        opencodeJsonPath,
        instructions,
      };
    }

    if (instructions.length === 0) {
      return {
        action: "skipped-no-hive-data",
        detail:
          "No hive-data memories files exist anymore - leaving the existing bootstrap-managed opencode.json as-is rather than emptying it.",
        opencodeJsonPath,
      };
    }

    writeBootstrapConfig(opencodeJsonPath, instructions);
    return {
      action: "updated",
      detail: `Updated bootstrap-managed opencode.json (${instructions.length} instruction file(s)).`,
      opencodeJsonPath,
      instructions,
    };
  }

  if (instructions.length === 0) {
    return {
      action: "skipped-no-hive-data",
      detail:
        "Neither global nor project hive-data memories.jsonl exist yet - nothing to point at.",
      opencodeJsonPath,
    };
  }

  writeBootstrapConfig(opencodeJsonPath, instructions);
  return {
    action: "created",
    detail: `Created untracked opencode.json pointing at ${instructions.length} hive-data instruction file(s).`,
    opencodeJsonPath,
    instructions,
  };
}

// ============================================================================
// Global gitignore for opencode.json
// ============================================================================

export type GlobalGitignoreAction =
  | "created-excludes-file"
  | "appended"
  | "already-ignored";

export interface EnsureGlobalGitignoreOptions {
  /** Override for testing - avoids real `git config --global` reads. */
  getExcludesFile?: () => string | null;
  /** Override for testing - avoids real `git config --global` writes. */
  setExcludesFile?: (path: string) => void;
  homeDir?: string;
}

export interface EnsureGlobalGitignoreResult {
  action: GlobalGitignoreAction;
  excludesFile: string;
}

const IGNORE_ENTRY = "opencode.json";

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function defaultGetExcludesFile(): string | null {
  const proc = Bun.spawnSync([
    "git",
    "config",
    "--global",
    "core.excludesFile",
  ]);
  if (proc.exitCode !== 0) return null;
  const out = proc.stdout.toString("utf-8").trim();
  return out === "" ? null : out;
}

function defaultSetExcludesFile(path: string): void {
  Bun.spawnSync(["git", "config", "--global", "core.excludesFile", path]);
}

/**
 * Ensure `opencode.json` is ignored by every git repo on this machine.
 *
 * Reuses `core.excludesFile` if already configured (appending our entry
 * without touching anything else in it); otherwise creates
 * `~/.config/git/ignore` and points `core.excludesFile` there. Never
 * overwrites an existing excludes file, and never duplicates the entry
 * on repeated calls.
 */
export function ensureOpencodeJsonGloballyIgnored(
  options: EnsureGlobalGitignoreOptions = {},
): EnsureGlobalGitignoreResult {
  const home = options.homeDir ?? homedir();
  const getExcludesFile = options.getExcludesFile ?? defaultGetExcludesFile;
  const setExcludesFile = options.setExcludesFile ?? defaultSetExcludesFile;

  const configured = getExcludesFile();
  let excludesFile: string;
  let action: GlobalGitignoreAction;

  if (configured) {
    excludesFile = expandHome(configured, home);
    action = "appended";
  } else {
    excludesFile = join(home, ".config", "git", "ignore");
    mkdirSync(dirname(excludesFile), { recursive: true });
    if (!existsSync(excludesFile)) {
      writeFileSync(excludesFile, "");
    }
    setExcludesFile(excludesFile);
    action = "created-excludes-file";
  }

  const content = existsSync(excludesFile)
    ? readFileSync(excludesFile, "utf-8")
    : "";
  const alreadyPresent = content
    .split("\n")
    .some((line) => line.trim() === IGNORE_ENTRY);

  if (alreadyPresent) {
    return { action: "already-ignored", excludesFile };
  }

  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  appendFileSync(excludesFile, `${prefix}${IGNORE_ENTRY}\n`);

  return { action, excludesFile };
}

// ============================================================================
// Combined entrypoint
// ============================================================================

export interface RunConfigBootstrapResult {
  project: BootstrapProjectConfigResult;
  gitignore: EnsureGlobalGitignoreResult;
}

/**
 * Full bootstrap: ensure the global gitignore rule exists, then bootstrap
 * this project's opencode.json. Called once per plugin init in
 * `SwarmPlugin` with the project's working directory.
 */
export async function runConfigBootstrap(
  projectPath: string,
): Promise<RunConfigBootstrapResult> {
  const gitignore = ensureOpencodeJsonGloballyIgnored();
  const project = await bootstrapProjectConfig(projectPath);
  return { project, gitignore };
}
