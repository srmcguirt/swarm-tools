/**
 * `swarm docs check` - the pre-push gate.
 *
 * Fast and zero model calls: no adapter, no extraction, no classifier, no
 * Ollama. Just resolveDocsConfig() (filesystem, no DB) plus one cheap
 * indexed SQL query (fingerprint.computeCorpusFingerprint) compared against
 * the last-written stamp.
 *
 * Exits zero (never blocks a push) for a repo with no docsmith.json or no
 * beads yet - opting into the gate is explicit, and an empty corpus has
 * nothing to be stale about.
 */
import type { Client } from '@libsql/client';

import { resolveDocsConfig } from './config.js';
import { checkStaleness, openHiveDbClient } from './fingerprint.js';

export type CheckDocsStatus = 'unconfigured' | 'empty' | 'fresh' | 'stale';

export interface CheckDocsResult {
  status: CheckDocsStatus;
  exitCode: 0 | 1;
  message: string;
}

export interface CheckDocsOptions {
  repoPath: string;
  /** Testing hook - defaults to a real @libsql/client against the resolved dbPath. */
  client?: Client;
}

export async function checkDocs(
  options: CheckDocsOptions,
): Promise<CheckDocsResult> {
  const resolved = resolveDocsConfig(options.repoPath);

  if (!resolved.hasConfigFile) {
    return {
      status: 'unconfigured',
      exitCode: 0,
      message: `No ${resolved.configPath.split('/').pop()} found - docs staleness gate not enabled for this repo.`,
    };
  }

  const client = options.client ?? openHiveDbClient(resolved.dbPath);
  const staleness = await checkStaleness({
    client,
    projectKey: resolved.projectKey,
    repoPath: resolved.repoPath,
  });

  if (staleness.current.rowCount === 0) {
    return {
      status: 'empty',
      exitCode: 0,
      message: `No hive cells found for project_key "${resolved.projectKey}" - nothing to be stale.`,
    };
  }

  if (!staleness.stale) {
    return {
      status: 'fresh',
      exitCode: 0,
      message: 'Docs are up to date with the current corpus.',
    };
  }

  const reasonText =
    staleness.reason === 'no-stamp'
      ? 'docs have never been generated'
      : 'the hive corpus has changed since the last generate';
  return {
    status: 'stale',
    exitCode: 1,
    message: `Docs are stale (${reasonText}). Run \`swarm docs generate\` before pushing.`,
  };
}
