/**
 * Test preload script - forces all tests onto an isolated temp database.
 *
 * getDatabasePath() in src/streams/index.ts always resolves to the real
 * production database (~/.config/swarm-tools/swarm.db) unless SWARM_DB_PATH
 * is set. Setting it here, before any test file loads, means no test can
 * ever touch production data by default or by omission.
 *
 * A single temp path is reused for the whole test run (not per-file) so
 * tests that share the adapter cache keep working as before.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.SWARM_DB_PATH) {
  const dir = mkdtempSync(join(tmpdir(), "swarm-mail-test-"));
  process.env.SWARM_DB_PATH = join(dir, "swarm-test.db");
}
