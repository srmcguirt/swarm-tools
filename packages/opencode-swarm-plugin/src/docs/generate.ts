/**
 * `swarm docs generate` driver.
 *
 * Config-driven wiring of hive-doc-adapter -> doc-service, replacing the
 * hardcoded projectKey/dbPath constants in hive-doc-adapter's own
 * scripts/generate-*.ts reference scripts with resolveDocsConfig(). Call
 * order mirrors those scripts exactly: createHiveAdapter -> extract() ->
 * emit{Runbook,Policy,WikiPages,BlogPosts}() in "skip-invalid" mode, gated
 * by each repo's `outputs` toggles.
 *
 * Before any of that: a cheap row-count query against the resolved
 * project_key. Zero beads means skip entirely - no adapter call, no
 * extraction, no four files full of "No procedures recorded."
 */
import type { Client } from '@libsql/client';
import {
  emitBlogPosts,
  emitPolicy,
  emitRunbook,
  emitWikiPages,
} from '@srmcguirt/doc-service';
import {
  createHiveAdapter,
  type HiveAdapter,
  type HiveAdapterConfig,
} from '@srmcguirt/hive-doc-adapter';
import { join } from 'node:path';

import { resolveDocsConfig } from './config.js';
import {
  computeCorpusFingerprint,
  openHiveDbClient,
  writeStamp,
} from './fingerprint.js';

export interface DeliverableResult {
  written: number;
  excluded: number;
  outputPath: string;
}

export interface GenerateDocsResult {
  skipped: boolean;
  skipReason?: string;
  projectKey: string;
  repoPath: string;
  deliverables: Partial<
    Record<'runbooks' | 'wiki' | 'blog' | 'policy', DeliverableResult>
  >;
}

export interface GenerateDocsOptions {
  repoPath: string;
  /** CLI --classifier/--no-classifier override, see resolveDocsConfig. */
  classifierOverride?: boolean;
  onProgress?: (message: string) => void;
  /** Testing hook - defaults to the real @srmcguirt/hive-doc-adapter. */
  createAdapter?: (config: HiveAdapterConfig) => HiveAdapter;
  /** Testing hook - defaults to a real @libsql/client against the resolved dbPath. */
  client?: Client;
}

export async function generateDocs(
  options: GenerateDocsOptions,
): Promise<GenerateDocsResult> {
  const resolved = resolveDocsConfig(options.repoPath, {
    classifierOverride: options.classifierOverride,
  });
  const progress = options.onProgress ?? ((): void => {});
  const client = options.client ?? openHiveDbClient(resolved.dbPath);

  const fingerprint = await computeCorpusFingerprint(
    client,
    resolved.projectKey,
  );
  if (fingerprint.rowCount === 0) {
    return {
      skipped: true,
      skipReason: `No hive cells found for project_key "${resolved.projectKey}" - nothing to document. Skipping generation.`,
      projectKey: resolved.projectKey,
      repoPath: resolved.repoPath,
      deliverables: {},
    };
  }

  const createAdapter = options.createAdapter ?? createHiveAdapter;
  const adapter = createAdapter({
    dbPath: resolved.dbPath,
    projectKey: resolved.projectKey,
    gitRepoPath: resolved.repoPath,
    project: {
      name: resolved.projectConfig.project.name,
      description: resolved.projectConfig.project.description,
    },
    // Cross-project memories only - see hive-doc-adapter's
    // HiveAdapterConfig.memoryScope doc comment for why that's the scope
    // with actual runbook-shaped content today.
    memoryScope: { repoKey: null },
    classifier: { enabled: resolved.classifierEnabled },
  });

  progress(
    resolved.classifierEnabled
      ? 'Extracting corpus (classifier on - local Ollama calls, one per unclassified closed cell; can take 20s-2min+)...'
      : 'Extracting corpus (classifier off - heuristics only)...',
  );
  const corpus = await adapter.extract();
  progress(
    `Extracted ${corpus.workItems.length} work item(s), ${corpus.procedures.length} procedure(s), ${corpus.incidents.length} incident(s), ${corpus.decisions.length} decision(s).`,
  );

  const { outputs, paths, sanitization } = resolved.projectConfig;
  const deliverables: GenerateDocsResult['deliverables'] = {};

  if (outputs.runbooks) {
    progress('Writing runbooks...');
    const outputPath = join(resolved.repoPath, paths.runbooks, 'index.md');
    const result = await emitRunbook(
      corpus.procedures,
      outputPath,
      sanitization,
      'skip-invalid',
    );
    deliverables.runbooks = {
      written: corpus.procedures.length - (result.excluded?.length ?? 0),
      excluded: result.excluded?.length ?? 0,
      outputPath,
    };
  }

  if (outputs.policy) {
    progress('Writing policy...');
    const outputPath = join(resolved.repoPath, paths.policy, 'index.md');
    const result = await emitPolicy(
      corpus.incidents,
      outputPath,
      sanitization,
      'skip-invalid',
    );
    deliverables.policy = {
      // Upper bound: emitPolicy also silently drops incidents with no
      // preventionRule, which isn't reflected in `excluded` (gate
      // failures only) - see policy-emitter.ts.
      written: corpus.incidents.length - (result.excluded?.length ?? 0),
      excluded: result.excluded?.length ?? 0,
      outputPath,
    };
  }

  if (outputs.wiki) {
    progress('Writing wiki...');
    const outputPath = join(resolved.repoPath, paths.wiki);
    const result = await emitWikiPages(
      corpus.procedures,
      corpus.incidents,
      corpus.decisions,
      outputPath,
      sanitization,
      'skip-invalid',
    );
    deliverables.wiki = {
      written: result.results.length,
      excluded: result.excluded?.length ?? 0,
      outputPath,
    };
  }

  if (outputs.blog) {
    progress('Writing blog...');
    const outputPath = join(resolved.repoPath, paths.blog);
    const result = await emitBlogPosts(
      corpus.workItems,
      corpus.decisions,
      corpus.timeline,
      outputPath,
      sanitization,
      'skip-invalid',
    );
    deliverables.blog = {
      written: result.results.length,
      excluded: result.excluded?.length ?? 0,
      outputPath,
    };
  }

  // Extraction is read-only, so the corpus can't have changed the beads
  // table - but re-querying (rather than reusing `fingerprint`) keeps this
  // correct even if a future extractor gains a write path.
  const freshFingerprint = await computeCorpusFingerprint(
    client,
    resolved.projectKey,
  );
  writeStamp(resolved.repoPath, {
    projectKey: resolved.projectKey,
    rowCount: freshFingerprint.rowCount,
    maxUpdatedAt: freshFingerprint.maxUpdatedAt,
    generatedAt: new Date().toISOString(),
  });
  progress('Wrote fingerprint stamp.');

  return {
    skipped: false,
    projectKey: resolved.projectKey,
    repoPath: resolved.repoPath,
    deliverables,
  };
}
