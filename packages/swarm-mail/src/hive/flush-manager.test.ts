/**
 * FlushManager Tests
 *
 * Tests for the debounced JSONL export functionality.
 * Critical: Tests the merge behavior that prevents data loss.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, type Client } from "@libsql/client";

import { convertPlaceholders, type DatabaseAdapter } from "../libsql.js";
import { createHiveAdapter } from "./adapter.js";
import { FlushManager } from "./flush-manager.js";
import { parseJSONL } from "./jsonl.js";
import {
  beadsMigrationLibSQL,
  cellsViewMigrationLibSQL,
  beadsResultColumnsMigrationLibSQL,
} from "./migrations.js";

/**
 * Wrap libSQL client with DatabaseAdapter interface
 * Uses executeMultiple for exec() to handle multi-statement migrations
 *
 * IMPORTANT: Includes getClient() method so toDrizzleDb() recognizes this
 * as a LibSQL adapter (not PGlite).
 */
function wrapLibSQL(
  client: Client,
): DatabaseAdapter & { getClient: () => Client } {
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const converted = convertPlaceholders(sql, params);
      const result = await client.execute({
        sql: converted.sql,
        args: converted.params,
      });
      return { rows: result.rows as T[] };
    },
    exec: async (sql: string) => {
      const converted = convertPlaceholders(sql);
      await client.executeMultiple(converted.sql);
    },
    close: () => client.close(),
    // Required for toDrizzleDb() to recognize this as LibSQL (not PGlite)
    getClient: () => client,
  };
}

describe("FlushManager", () => {
  const testDir = join(tmpdir(), `flush-manager-test-${Date.now()}`);
  const projectKey = testDir;
  const outputPath = join(testDir, ".hive", "issues.jsonl");

  let client: Client;
  let db: DatabaseAdapter;
  let adapter: ReturnType<typeof createHiveAdapter>;

  beforeAll(async () => {
    // Create test directory structure
    await mkdir(join(testDir, ".hive"), { recursive: true });

    // Create in-memory libSQL database
    client = createClient({ url: ":memory:" });
    db = wrapLibSQL(client);

    // Create base schema (events table, schema_version) - required before migrations
    await client.execute(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sequence INTEGER,
        type TEXT NOT NULL,
        project_key TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT
      )
    `);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      )
    `);

    // Run hive migrations directly (beads tables, cells view)
    await db.exec(beadsMigrationLibSQL.up);
    await db.exec(cellsViewMigrationLibSQL.up);
    await db.exec(beadsResultColumnsMigrationLibSQL.up);

    adapter = createHiveAdapter(db, projectKey);
  });

  afterAll(async () => {
    // Clean up
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("flush() should merge with existing JSONL, not overwrite", async () => {
    // ARRANGE: Create an existing cell and write it to JSONL
    const existingCell = await adapter.createCell(projectKey, {
      title: "Existing Cell",
      type: "task",
      priority: 2,
    });

    // Manually write existing cell to JSONL (simulating previous session)
    const existingJsonl = `${JSON.stringify({
      id: existingCell.id,
      title: "Existing Cell",
      description: "",
      status: "open",
      priority: 2,
      issue_type: "task",
      created_at: new Date(Number(existingCell.created_at)).toISOString(),
      updated_at: new Date(Number(existingCell.updated_at)).toISOString(),
      dependencies: [],
      labels: [],
      comments: [],
    })}\n`;

    await writeFile(outputPath, existingJsonl, "utf-8");

    // Clear dirty flag for existing cell (simulating it was already synced)
    await adapter.clearDirty(projectKey, existingCell.id);

    // ACT: Create a NEW cell and mark it dirty
    const newCell = await adapter.createCell(projectKey, {
      title: "New Cell",
      type: "bug",
      priority: 1,
    });
    await adapter.markDirty(projectKey, newCell.id);

    // Flush the dirty cell
    const flushManager = new FlushManager({
      adapter,
      projectKey,
      outputPath,
    });

    const result = await flushManager.flush();

    // ASSERT: Both cells should be in the JSONL file
    expect(result.cellsExported).toBe(1); // Only the new cell was dirty

    const finalJsonl = await readFile(outputPath, "utf-8");
    const cells = parseJSONL(finalJsonl);

    // THIS IS THE BUG: Currently only 1 cell (the new one) is in the file
    // It should have BOTH cells
    expect(cells.length).toBe(2);
    expect(cells.map((c) => c.id).sort()).toEqual(
      [existingCell.id, newCell.id].sort(),
    );
  });

  test("flush() should update existing cells when they are dirty", async () => {
    // Create fresh test file
    const testOutputPath = join(testDir, ".hive", "issues-update.jsonl");

    // ARRANGE: Create a cell
    const cell = await adapter.createCell(projectKey, {
      title: "Original Title",
      type: "task",
      priority: 2,
    });

    // Write initial state to JSONL
    const initialJsonl = `${JSON.stringify({
      id: cell.id,
      title: "Original Title",
      description: "",
      status: "open",
      priority: 2,
      issue_type: "task",
      created_at: new Date(Number(cell.created_at)).toISOString(),
      updated_at: new Date(Number(cell.updated_at)).toISOString(),
      dependencies: [],
      labels: [],
      comments: [],
    })}\n`;

    await writeFile(testOutputPath, initialJsonl, "utf-8");
    await adapter.clearDirty(projectKey, cell.id);

    // ACT: Update the cell and mark dirty
    await adapter.updateCell(projectKey, cell.id, {
      title: "Updated Title",
    });
    await adapter.markDirty(projectKey, cell.id);

    // Flush
    const flushManager = new FlushManager({
      adapter,
      projectKey,
      outputPath: testOutputPath,
    });

    await flushManager.flush();

    // ASSERT: Cell should have updated title
    const finalJsonl = await readFile(testOutputPath, "utf-8");
    const cells = parseJSONL(finalJsonl);

    expect(cells.length).toBe(1);
    expect(cells[0].title).toBe("Updated Title");
  });

  test("flush() with empty dirty set should not modify existing file", async () => {
    const testOutputPath = join(testDir, ".hive", "issues-empty.jsonl");

    // ARRANGE: Write existing content
    const existingContent = `${JSON.stringify({
      id: "test-cell-123",
      title: "Existing",
      description: "",
      status: "open",
      priority: 2,
      issue_type: "task",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      dependencies: [],
      labels: [],
      comments: [],
    })}\n`;

    await writeFile(testOutputPath, existingContent, "utf-8");

    // ACT: Flush with no dirty cells
    const flushManager = new FlushManager({
      adapter,
      projectKey,
      outputPath: testOutputPath,
    });

    const result = await flushManager.flush();

    // ASSERT: File should be unchanged
    expect(result.cellsExported).toBe(0);

    const finalContent = await readFile(testOutputPath, "utf-8");
    expect(finalContent).toBe(existingContent);
  });

  test("scheduleFlush() should track errors from failed flushes", async () => {
    const testOutputPath = "/invalid/path/that/does/not/exist/issues.jsonl";

    // ARRANGE: Create a cell and mark it dirty
    const cell = await adapter.createCell(projectKey, {
      title: "Test Cell",
      type: "task",
      priority: 1,
    });
    await adapter.markDirty(projectKey, cell.id);

    // ACT: Schedule a flush that will fail due to invalid path
    let errorCaught = false;
    const flushManager = new FlushManager({
      adapter,
      projectKey,
      outputPath: testOutputPath,
      debounceMs: 10, // Short delay for testing
      onError: (err) => {
        errorCaught = true;
      },
    });

    flushManager.scheduleFlush();

    // Wait for scheduled flush to execute and fail
    await new Promise((resolve) => setTimeout(resolve, 100));

    // ASSERT: Error should be tracked
    expect(flushManager.hasError()).toBe(true);
    expect(flushManager.getLastError()).toBeInstanceOf(Error);
    expect(errorCaught).toBe(true);

    // Cleanup
    flushManager.stop();
  });

  test("clearError() should reset error state", async () => {
    const testOutputPath = "/invalid/path/that/does/not/exist/issues.jsonl";

    // ARRANGE: Create a cell and mark it dirty
    const cell = await adapter.createCell(projectKey, {
      title: "Test Cell",
      type: "task",
      priority: 1,
    });
    await adapter.markDirty(projectKey, cell.id);

    // ACT: Schedule a flush that will fail
    const flushManager = new FlushManager({
      adapter,
      projectKey,
      outputPath: testOutputPath,
      debounceMs: 10,
    });

    flushManager.scheduleFlush();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify error is tracked
    expect(flushManager.hasError()).toBe(true);

    // Clear the error
    flushManager.clearError();

    // ASSERT: Error state should be cleared
    expect(flushManager.hasError()).toBe(false);
    expect(flushManager.getLastError()).toBe(null);

    // Cleanup
    flushManager.stop();
  });

  test("onError callback should be invoked when scheduled flush fails", async () => {
    const testOutputPath = "/invalid/path/that/does/not/exist/issues.jsonl";

    // ARRANGE: Create a cell and mark it dirty
    const cell = await adapter.createCell(projectKey, {
      title: "Test Cell",
      type: "task",
      priority: 1,
    });
    await adapter.markDirty(projectKey, cell.id);

    // ACT: Schedule a flush with error callback
    let capturedError: Error | null = null;
    const flushManager = new FlushManager({
      adapter,
      projectKey,
      outputPath: testOutputPath,
      debounceMs: 10,
      onError: (err) => {
        capturedError = err;
      },
    });

    flushManager.scheduleFlush();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // ASSERT: Callback should have been invoked with error
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError?.message).toContain("ENOENT");

    // Cleanup
    flushManager.stop();
  });

  describe("flush() — export sanitization", () => {
    test("strips internal process vocabulary while keeping technical facts", async () => {
      const testOutputPath = join(testDir, ".hive", "issues-sanitize-1.jsonl");

      const cell = await adapter.createCell(projectKey, {
        title: "swarm_complete tool rejects call",
        type: "bug",
        priority: 1,
        description:
          "The coordinator spawned a subtask to fix the SQL injection in packages/swarm-mail/src/hive/jsonl.ts. Reproduced in 4.2s. See `swarm_complete` for details.",
      });
      await adapter.markDirty(projectKey, cell.id);

      const flushManager = new FlushManager({
        adapter,
        projectKey,
        outputPath: testOutputPath,
      });
      await flushManager.flush();

      const finalJsonl = await readFile(testOutputPath, "utf-8");
      const cells = parseJSONL(finalJsonl);
      const written = cells.find((c) => c.id === cell.id);

      expect(written?.description).not.toMatch(/\bcoordinator\b/i);
      expect(written?.description).not.toMatch(/\bsubtask\b/i);
      // technical facts survive
      expect(written?.description).toContain(
        "packages/swarm-mail/src/hive/jsonl.ts",
      );
      expect(written?.description).toContain("4.2s");
      expect(written?.description).toContain("swarm_complete");
    });

    test("running flush twice produces the same sanitized output (idempotent)", async () => {
      const testOutputPath = join(testDir, ".hive", "issues-sanitize-2.jsonl");

      const cell = await adapter.createCell(projectKey, {
        title: "Worker agent bug",
        type: "bug",
        priority: 2,
        description:
          "The worker agent fixed the bug. The swarm coordinator verified it.",
      });
      await adapter.markDirty(projectKey, cell.id);

      const flushManager = new FlushManager({
        adapter,
        projectKey,
        outputPath: testOutputPath,
      });
      await flushManager.flush();
      const firstPass = await readFile(testOutputPath, "utf-8");

      // Nothing dirty now, but re-flushing after marking dirty again should
      // re-sanitize to the same stable output.
      await adapter.markDirty(projectKey, cell.id);
      await flushManager.flush();
      const secondPass = await readFile(testOutputPath, "utf-8");

      expect(secondPass).toBe(firstPass);
    });

    test("local DB row (title/description) is never mutated by export sanitization", async () => {
      const testOutputPath = join(testDir, ".hive", "issues-sanitize-3.jsonl");

      const rawTitle = "Worker agent bug in swarm coordinator";
      const rawDescription =
        "The worker agent fixed the bug. The swarm coordinator verified it via swarm_complete.";

      const cell = await adapter.createCell(projectKey, {
        title: rawTitle,
        type: "bug",
        priority: 2,
        description: rawDescription,
      });
      await adapter.markDirty(projectKey, cell.id);

      const flushManager = new FlushManager({
        adapter,
        projectKey,
        outputPath: testOutputPath,
      });
      await flushManager.flush();

      const dbCell = await adapter.getCell(projectKey, cell.id);
      expect(dbCell?.title).toBe(rawTitle);
      expect(dbCell?.description).toBe(rawDescription);

      // Meanwhile the exported file *is* sanitized.
      const finalJsonl = await readFile(testOutputPath, "utf-8");
      const cells = parseJSONL(finalJsonl);
      const written = cells.find((c) => c.id === cell.id);
      expect(written?.title).not.toMatch(/\bworker\b/i);
      expect(written?.description).not.toMatch(/\bcoordinator\b/i);
    });
  });
});
