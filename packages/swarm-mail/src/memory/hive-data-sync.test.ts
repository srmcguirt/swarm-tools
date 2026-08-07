/**
 * syncProjectMemoriesToHiveData tests - TDD first
 *
 * The hive DB has no per-memory scope column yet (separate cell) — memories
 * are split across two git-tracked files instead: hive-data/global/memories.jsonl
 * and hive-data/repos/<slug>/memories.jsonl. This module syncs a project's
 * slice without ever duplicating a memory that's already tracked globally,
 * and without inventing a scope column.
 *
 * Interim rule: any DB memory whose id isn't already claimed by the global
 * file is exported to the project file (new memories default to
 * project-scoped; reclassify to global manually).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestLibSQLDb } from "../test-libsql.js";
import type { DatabaseAdapter } from "../types/database.js";
import {
  parseMemoryJSONL,
  serializeMemoryToJSONL,
  type MemoryExport,
} from "./sync.js";
import { syncProjectMemoriesToHiveData } from "./hive-data-sync.js";

async function insertMemory(
  db: DatabaseAdapter,
  id: string,
  content: string,
  createdAt = new Date().toISOString(),
): Promise<void> {
  await db.query(
    `INSERT INTO memories (id, content, metadata, collection, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, content, "{}", "default", createdAt],
  );
}

describe("syncProjectMemoriesToHiveData", () => {
  let db: DatabaseAdapter;
  let testDir: string;
  let globalPath: string;
  let projectPath: string;

  beforeEach(async () => {
    const { adapter } = await createTestLibSQLDb();
    db = adapter;
    testDir = mkdtempSync(join(tmpdir(), "hive-data-memory-sync-"));
    mkdirSync(join(testDir, "global"), { recursive: true });
    mkdirSync(join(testDir, "repos", "proj"), { recursive: true });
    globalPath = join(testDir, "global", "memories.jsonl");
    projectPath = join(testDir, "repos", "proj", "memories.jsonl");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("new memories (not in either file) default to project-scoped", async () => {
    await insertMemory(db, "mem-new-1", "A brand new project learning");

    const result = await syncProjectMemoriesToHiveData(db, {
      globalMemoriesPath: globalPath,
      projectMemoriesPath: projectPath,
    });

    expect(result.projectExported).toBe(1);
    const written = parseMemoryJSONL(readFileSync(projectPath, "utf-8"));
    expect(written.map((m) => m.id)).toEqual(["mem-new-1"]);
  });

  test("memories already claimed by the global file are excluded from the project export", async () => {
    // Simulate a memory that's already been classified as global.
    writeFileSync(
      globalPath,
      serializeMemoryToJSONL({
        id: "mem-global-1",
        information: "A cross-project tool gotcha",
        created_at: new Date().toISOString(),
      }) + "\n",
    );
    await insertMemory(db, "mem-global-1", "A cross-project tool gotcha");
    await insertMemory(db, "mem-project-1", "A project-specific detail");

    const result = await syncProjectMemoriesToHiveData(db, {
      globalMemoriesPath: globalPath,
      projectMemoriesPath: projectPath,
    });

    expect(result.projectExported).toBe(1);
    const written = parseMemoryJSONL(readFileSync(projectPath, "utf-8"));
    expect(written.map((m) => m.id)).toEqual(["mem-project-1"]);
  });

  test("does not touch the global file", async () => {
    writeFileSync(
      globalPath,
      serializeMemoryToJSONL({
        id: "mem-global-1",
        information: "Untouched global entry",
        created_at: new Date().toISOString(),
      }) + "\n",
    );
    const beforeGlobal = readFileSync(globalPath, "utf-8");
    await insertMemory(db, "mem-global-1", "Untouched global entry");
    await insertMemory(db, "mem-project-1", "Something project-scoped");

    await syncProjectMemoriesToHiveData(db, {
      globalMemoriesPath: globalPath,
      projectMemoriesPath: projectPath,
    });

    const afterGlobal = readFileSync(globalPath, "utf-8");
    expect(afterGlobal).toBe(beforeGlobal);
  });

  test("existing project-file memories are preserved across sync", async () => {
    writeFileSync(
      projectPath,
      serializeMemoryToJSONL({
        id: "mem-project-existing",
        information: "Already-known project memory",
        created_at: new Date().toISOString(),
      }) + "\n",
    );
    await insertMemory(
      db,
      "mem-project-existing",
      "Already-known project memory",
    );

    const result = await syncProjectMemoriesToHiveData(db, {
      globalMemoriesPath: globalPath,
      projectMemoriesPath: projectPath,
    });

    expect(result.projectExported).toBe(1);
    const written = parseMemoryJSONL(readFileSync(projectPath, "utf-8"));
    expect(written.map((m) => m.id)).toEqual(["mem-project-existing"]);
  });

  test("imports memories from both project and global files into the DB (recovery path)", async () => {
    writeFileSync(
      globalPath,
      serializeMemoryToJSONL({
        id: "mem-recover-global",
        information: "Recovered global memory",
        created_at: new Date().toISOString(),
      }) + "\n",
    );
    writeFileSync(
      projectPath,
      serializeMemoryToJSONL({
        id: "mem-recover-project",
        information: "Recovered project memory",
        created_at: new Date().toISOString(),
      }) + "\n",
    );

    const result = await syncProjectMemoriesToHiveData(db, {
      globalMemoriesPath: globalPath,
      projectMemoriesPath: projectPath,
    });

    expect(result.imported.created).toBe(2);
    const dbResult = await db.query<{ id: string }>(
      "SELECT id FROM memories ORDER BY id",
    );
    expect(dbResult.rows.map((r) => r.id).sort()).toEqual([
      "mem-recover-global",
      "mem-recover-project",
    ]);
  });

  test("is idempotent: two consecutive syncs produce identical output, no growth or duplication", async () => {
    await insertMemory(db, "mem-a", "Memory A");
    await insertMemory(db, "mem-b", "Memory B");

    const first = await syncProjectMemoriesToHiveData(db, {
      globalMemoriesPath: globalPath,
      projectMemoriesPath: projectPath,
    });
    const contentAfterFirst = readFileSync(projectPath, "utf-8");

    const second = await syncProjectMemoriesToHiveData(db, {
      globalMemoriesPath: globalPath,
      projectMemoriesPath: projectPath,
    });
    const contentAfterSecond = readFileSync(projectPath, "utf-8");

    expect(second.projectExported).toBe(first.projectExported);
    expect(contentAfterSecond).toBe(contentAfterFirst);

    const dbResult = await db.query<{ id: string }>(
      "SELECT id FROM memories ORDER BY id",
    );
    expect(dbResult.rows.length).toBe(2);
  });

  test("does not create the project file when there are zero memories anywhere and no pre-existing file", async () => {
    const result = await syncProjectMemoriesToHiveData(db, {
      globalMemoriesPath: globalPath,
      projectMemoriesPath: projectPath,
    });

    expect(result.projectExported).toBe(0);
  });

  test("sanitizes information field written to the project file", async () => {
    await insertMemory(
      db,
      "mem-sanitize-1",
      "The worker coordinator subtask agent pattern needs review",
    );

    await syncProjectMemoriesToHiveData(db, {
      globalMemoriesPath: globalPath,
      projectMemoriesPath: projectPath,
    });

    const content = readFileSync(projectPath, "utf-8");
    expect(content).not.toMatch(/\bworker\b/i);
    expect(content).not.toMatch(/\bcoordinator\b/i);
  });

  test("total DB memory count reconciles with global + project file counts after sync", async () => {
    writeFileSync(
      globalPath,
      serializeMemoryToJSONL({
        id: "mem-g1",
        information: "Global one",
        created_at: new Date().toISOString(),
      }) + "\n",
    );
    await insertMemory(db, "mem-g1", "Global one");
    await insertMemory(db, "mem-p1", "Project one");
    await insertMemory(db, "mem-p2", "Project two");

    await syncProjectMemoriesToHiveData(db, {
      globalMemoriesPath: globalPath,
      projectMemoriesPath: projectPath,
    });

    const dbCount = (await db.query<{ id: string }>("SELECT id FROM memories"))
      .rows.length;
    const globalCount = parseMemoryJSONL(
      readFileSync(globalPath, "utf-8"),
    ).length;
    const projectCount = parseMemoryJSONL(
      readFileSync(projectPath, "utf-8"),
    ).length;

    expect(dbCount).toBe(3);
    expect(globalCount + projectCount).toBe(3);
  });
});
