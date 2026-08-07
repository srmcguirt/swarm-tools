import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectConfig } from "../config/schema.js";

/**
 * Canonical directory layout, relative to `config.paths.root`.
 *
 * - runbooks/  operational procedures — flat, one file per procedure
 * - wiki/      Diataxis-structured: tutorials, how-to, reference, explanation
 * - blog/      narrative posts, one per work arc
 * - policy/    hardline rules derived from incidents
 *
 * wiki/reference holds generated code docs; wiki/explanation holds the
 * plain-language material. Splitting them lets the wiki generator and the
 * (separate, future) code-doc extraction disagree on cadence without
 * fighting over the same directory.
 */
export const WIKI_SUBDIRECTORIES = [
  "tutorials",
  "how-to",
  "reference",
  "explanation",
] as const;

/** Returns the list of directories (relative to cwd) this project's docs need. */
export function templateDirectories(config: ProjectConfig): string[] {
  const dirs = [config.paths.runbooks, config.paths.blog, config.paths.policy];
  for (const sub of WIKI_SUBDIRECTORIES) {
    dirs.push(join(config.paths.wiki, sub));
  }
  return dirs;
}

/** Creates the canonical directory layout under `cwd`. Idempotent. */
export async function scaffoldTemplateStructure(
  config: ProjectConfig,
  options: { cwd?: string } = {},
): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd();
  const dirs = templateDirectories(config);
  for (const dir of dirs) {
    await mkdir(join(cwd, dir), { recursive: true });
  }
  return dirs;
}
