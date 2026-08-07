/**
 * Test preload script - runs before each test file
 *
 * 1. Clears module mocks to prevent pollution between test files.
 * 2. Forces SWARM_DB_PATH to a temp DB before any test file loads.
 *
 * getSwarmMailLibSQL()/getDatabasePath() in the swarm-mail package always
 * resolve to the real production database (~/.config/swarm-tools/swarm.db)
 * unless SWARM_DB_PATH is set. Setting it here, before any test file loads,
 * means no test in this package can ever touch production data by default
 * or by omission. Mirrors packages/swarm-mail/test-preload.ts.
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
