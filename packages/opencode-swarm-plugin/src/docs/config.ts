/**
 * Per-repo docsmith config resolution.
 *
 * Config lives in a dedicated `docsmith.json` at repo root, not inside
 * opencode.json: config-bootstrap.ts treats opencode.json as exclusively
 * `{$schema, instructions}` (see isBootstrapManaged there) and only ever
 * refreshes a file matching that exact shape. Adding a `docs` key would
 * make every bootstrap-managed project's opencode.json "foreign" from
 * config-bootstrap's point of view, or force docsmith config to live
 * alongside agent-instruction config it has nothing to do with. A
 * dedicated file also maps ~1:1 onto doc-service's own
 * `ProjectConfigSchema` shape, so there's no extra nesting to invent.
 *
 * A repo with no docsmith.json still works: every field defaults (project
 * name falls back to the repo directory's basename, all four outputs
 * default on, classifier defaults on).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ProjectConfigValidationError,
  parseProjectConfig,
  type ProjectConfig,
} from '@srmcguirt/doc-service';
import { z } from 'zod';

export const DOCS_CONFIG_FILENAME = 'docsmith.json';

/**
 * This package's own schema for what a repo may declare in docsmith.json.
 * Mirrors doc-service's `ProjectConfigSchema`, minus `source` (hardcoded
 * to the hive adapter - this driver doesn't support swapping it) and plus
 * `classifier` (hive-doc-adapter's concern, not doc-service's - doc-service
 * has no idea the classifier exists).
 */
const RepoDocsConfigSchema = z.object({
  project: z
    .object({
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      homepage: z.string().url().optional(),
      repository: z.string().optional(),
    })
    .optional(),
  outputs: z
    .object({
      runbooks: z.boolean().optional(),
      wiki: z.boolean().optional(),
      blog: z.boolean().optional(),
      policy: z.boolean().optional(),
    })
    .optional(),
  style: z.record(z.string(), z.unknown()).optional(),
  paths: z
    .object({
      root: z.string().optional(),
      runbooks: z.string().optional(),
      wiki: z.string().optional(),
      blog: z.string().optional(),
      policy: z.string().optional(),
    })
    .optional(),
  sanitization: z.record(z.string(), z.unknown()).optional(),
  /**
   * hive-doc-adapter's classifier gate. Deliberately NOT left to
   * `resolveClassifierEnabled`'s NODE_ENV-based default (see that
   * function's doc comment in hive-doc-adapter) - `resolveDocsConfig`
   * always resolves this to an explicit boolean so generation behavior
   * never depends on an ambient env var. Absent here and no
   * `classifierOverride` resolves to `true` - full fidelity by default.
   */
  classifier: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
});

export type RepoDocsConfig = z.infer<typeof RepoDocsConfigSchema>;

export class DocsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocsConfigError';
  }
}

export interface ResolvedDocsConfig {
  /** Absolute repo path this config was resolved for. */
  repoPath: string;
  /** Whether a docsmith.json file was found (vs. all defaults). */
  hasConfigFile: boolean;
  /** Absolute path docsmith.json would live at, whether or not it exists. */
  configPath: string;
  /** doc-service's validated ProjectConfig - the shape emitters/paths/outputs actually consume. */
  projectConfig: ProjectConfig;
  /** hive-doc-adapter's classifier gate, resolved with an explicit default (see RepoDocsConfigSchema.classifier's doc comment). Never left to hive-doc-adapter's own NODE_ENV fallback. */
  classifierEnabled: boolean;
  /** Hive project_key this repo's cells are scoped under - the repo's resolved absolute path, matching how every other hive tool derives it (see src/hive.ts). */
  projectKey: string;
  /** Path to the shared swarm.db, e.g. ~/.config/swarm-tools/swarm.db. */
  dbPath: string;
}

/** Matches how hive scopes cells: project_key is the repo's absolute filesystem path. */
export function deriveProjectKey(repoPath: string): string {
  return resolve(repoPath);
}

/** The standard hive DB location every swarm tool reads/writes. */
export function deriveDbPath(): string {
  return join(homedir(), '.config', 'swarm-tools', 'swarm.db');
}

export interface ResolveDocsConfigOptions {
  /** CLI --classifier/--no-classifier override; wins over docsmith.json's classifier.enabled, which wins over the true (on) default. */
  classifierOverride?: boolean;
}

/** Read, validate, and resolve a repo's docsmith config, filling in every default a config-free repo needs. Throws DocsConfigError on malformed JSON or a schema violation. */
export function resolveDocsConfig(
  repoPath: string,
  options: ResolveDocsConfigOptions = {},
): ResolvedDocsConfig {
  const absoluteRepoPath = resolve(repoPath);
  const configPath = join(absoluteRepoPath, DOCS_CONFIG_FILENAME);
  const hasConfigFile = existsSync(configPath);

  let raw: RepoDocsConfig = {};
  if (hasConfigFile) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new DocsConfigError(
        `${DOCS_CONFIG_FILENAME} is not valid JSON: ${(err as Error).message}`,
      );
    }
    const result = RepoDocsConfigSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new DocsConfigError(
        `Invalid ${DOCS_CONFIG_FILENAME}:\n${result.error.issues
          .map(
            (issue) =>
              `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
          )
          .join('\n')}`,
      );
    }
    raw = result.data;
  }

  let projectConfig: ProjectConfig;
  try {
    projectConfig = parseProjectConfig({
      project: {
        name: raw.project?.name ?? basename(absoluteRepoPath),
        description: raw.project?.description,
        homepage: raw.project?.homepage,
        repository: raw.project?.repository,
      },
      outputs: raw.outputs ?? {},
      source: { adapter: 'hive' },
      style: raw.style ?? {},
      paths: raw.paths ?? {},
      sanitization: raw.sanitization ?? {},
    });
  } catch (err) {
    if (err instanceof ProjectConfigValidationError) {
      throw new DocsConfigError(err.message);
    }
    throw err;
  }

  const classifierEnabled =
    options.classifierOverride ?? raw.classifier?.enabled ?? true;

  return {
    repoPath: absoluteRepoPath,
    hasConfigFile,
    configPath,
    projectConfig,
    classifierEnabled,
    projectKey: deriveProjectKey(absoluteRepoPath),
    dbPath: deriveDbPath(),
  };
}
