export {
  DOCS_CONFIG_FILENAME,
  DocsConfigError,
  deriveDbPath,
  deriveProjectKey,
  resolveDocsConfig,
} from './config.js';
export type {
  RepoDocsConfig,
  ResolveDocsConfigOptions,
  ResolvedDocsConfig,
} from './config.js';

export {
  checkStaleness,
  computeCorpusFingerprint,
  openHiveDbClient,
  readStamp,
  stampPath,
  writeStamp,
} from './fingerprint.js';
export type {
  CheckStalenessOptions,
  CorpusFingerprint,
  DocsStamp,
  StalenessReason,
  StalenessResult,
} from './fingerprint.js';

export { generateDocs } from './generate.js';
export type {
  DeliverableResult,
  GenerateDocsOptions,
  GenerateDocsResult,
} from './generate.js';

export { checkDocs } from './check.js';
export type {
  CheckDocsOptions,
  CheckDocsResult,
  CheckDocsStatus,
} from './check.js';

export {
  installPrePushHook,
  prePushHookPath,
  uninstallPrePushHook,
} from './hook.js';
export type { HookAction, HookResult } from './hook.js';

export {
  docs_check,
  docs_generate,
  docsTools,
  getDocsWorkingDirectory,
  setDocsWorkingDirectory,
} from './tools.js';
