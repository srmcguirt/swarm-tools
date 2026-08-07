/**
 * Test preload script - runs before each test file
 *
 * 1. Clears module mocks to prevent pollution between test files.
 * 2. Forces SWARM_DB_PATH to a temp DB before any test file loads.
 * 3. Forces HIVE_DATA_REPO to a temp (non-git) path before any test file
 *    loads.
 *
 * getSwarmMailLibSQL()/getDatabasePath() in the swarm-mail package always
 * resolve to the real production database (~/.config/swarm-tools/swarm.db)
 * unless SWARM_DB_PATH is set. Setting it here, before any test file loads,
 * means no test in this package can ever touch production data by default
 * or by omission. Mirrors packages/swarm-mail/test-preload.ts.
 *
 * resolveHiveDataRepoRoot() falls back to ~/hive-data — a real, git-tracked,
 * pushed-to-GitHub repo — when HIVE_DATA_REPO is unset. An earlier version
 * of hive.integration.test.ts's hive_sync tests didn't set it, and actually
 * committed-and-pushed test-junk commits to the real srmcguirt/hive-data
 * remote (caught and cleaned up manually). Defaulting to a bogus, non-git
 * temp path here means any test that forgets to set up its own isolated
 * hive-data repo fails loudly via assertHiveDataRepoReady() instead of
 * silently writing to (or worse, pushing) the real one.
 */
import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Clear any existing mocks before running tests
mock.restore();

if (!process.env.SWARM_DB_PATH) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-swarm-plugin-test-"));
  process.env.SWARM_DB_PATH = join(dir, "swarm-test.db");
}

if (!process.env.HIVE_DATA_REPO) {
  const dir = mkdtempSync(
    join(tmpdir(), "opencode-swarm-plugin-test-hive-data-"),
  );
  // Deliberately NOT a git repo — any test that actually exercises
  // hive_sync must explicitly point HIVE_DATA_REPO at its own isolated
  // git fixture. This default exists only to make "forgot to isolate"
  // fail loudly (HiveDataRepoError) rather than fall through to ~/hive-data.
  process.env.HIVE_DATA_REPO = join(dir, "not-a-real-hive-data-repo");
}
