/**
 * Memory Scope Rename & Orphan Detection Tests
 *
 * Covers the update path required when a repo's remote changes or a
 * package is renamed/moved, and the detection path that proves orphaned
 * scope keys are never silent.
 */

import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SwarmDb } from "../db/client.js";
import { createDrizzleClient } from "../db/drizzle.js";
import { createLibSQLMemorySchema } from "./libsql-schema.js";
import {
  findOrphanedPackageKeys,
  findOrphanedRepoKeys,
  renamePackageKey,
  renameRepoKey,
} from "./rename-scope.js";
import { createMemoryStore, type Memory } from "./store.js";

function mockEmbedding(seed = 0): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < 1024; i++) {
    embedding.push(Math.sin(seed + i * 0.1) * 0.5 + 0.5);
  }
  return embedding;
}

async function seedMemory(
  store: ReturnType<typeof createMemoryStore>,
  overrides: Partial<Memory> & Pick<Memory, "id" | "content">,
): Promise<void> {
  const memory: Memory = {
    metadata: {},
    collection: "default",
    createdAt: new Date(),
    repoKey: null,
    packageKey: null,
    ...overrides,
  };
  await store.store(memory, mockEmbedding(overrides.id.length));
}

describe("Memory Scope Rename & Orphan Detection", () => {
  let client: Client;
  let db: SwarmDb;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await createLibSQLMemorySchema(client);
    db = createDrizzleClient(client);
    store = createMemoryStore(db);
  });

  afterEach(() => {
    client.close();
  });

  describe("renameRepoKey (repo remote changed)", () => {
    test("rewrites repo_key for every memory under the old key, preserving content", async () => {
      await seedMemory(store, {
        id: "mem-1",
        content: "Uses old remote slug",
        repoKey: "github.com/acme/old-name",
      });
      await seedMemory(store, {
        id: "mem-2",
        content: "Also uses old remote slug",
        repoKey: "github.com/acme/old-name",
      });
      await seedMemory(store, {
        id: "mem-3",
        content: "Different repo, untouched",
        repoKey: "github.com/acme/unrelated",
      });

      const result = await renameRepoKey(
        db,
        "github.com/acme/old-name",
        "github.com/acme/new-name",
      );

      expect(result.updated).toBe(2);

      const renamed1 = await store.get("mem-1");
      const renamed2 = await store.get("mem-2");
      const untouched = await store.get("mem-3");

      expect(renamed1?.repoKey).toBe("github.com/acme/new-name");
      expect(renamed1?.content).toBe("Uses old remote slug");
      expect(renamed2?.repoKey).toBe("github.com/acme/new-name");
      expect(untouched?.repoKey).toBe("github.com/acme/unrelated");
    });

    test("preserves the embedding byte-for-byte across a rename (metadata-only update)", async () => {
      const embedding = mockEmbedding(42);
      await store.store(
        {
          id: "mem-embed",
          content: "content with an embedding",
          metadata: {},
          collection: "default",
          createdAt: new Date(),
          repoKey: "github.com/acme/old-name",
          packageKey: null,
        },
        embedding,
      );

      const before = await client.execute(
        "SELECT embedding FROM memories WHERE id = 'mem-embed'",
      );

      await renameRepoKey(
        db,
        "github.com/acme/old-name",
        "github.com/acme/new-name",
      );

      const after = await client.execute(
        "SELECT embedding FROM memories WHERE id = 'mem-embed'",
      );

      expect(
        Buffer.from(after.rows[0].embedding as ArrayBuffer).equals(
          Buffer.from(before.rows[0].embedding as ArrayBuffer),
        ),
      ).toBe(true);
    });

    test("no-op when fromRepoKey equals toRepoKey", async () => {
      const result = await renameRepoKey(db, "same", "same");
      expect(result.updated).toBe(0);
    });

    test("no matching rows -> updated: 0, no error", async () => {
      const result = await renameRepoKey(
        db,
        "github.com/nobody/nothing",
        "github.com/nobody/something",
      );
      expect(result.updated).toBe(0);
    });
  });

  describe("renamePackageKey (package renamed or moved to a different path)", () => {
    test("package renamed within the same repo", async () => {
      await seedMemory(store, {
        id: "mem-pkg-1",
        content: "Package-specific note",
        repoKey: "github.com/acme/monorepo",
        packageKey: "packages/swarm-mail",
      });
      await seedMemory(store, {
        id: "mem-pkg-2",
        content: "Different package, untouched",
        repoKey: "github.com/acme/monorepo",
        packageKey: "packages/other",
      });

      const result = await renamePackageKey(
        db,
        "github.com/acme/monorepo",
        "packages/swarm-mail",
        "packages/mail-core",
      );

      expect(result.updated).toBe(1);

      const renamed = await store.get("mem-pkg-1");
      const untouched = await store.get("mem-pkg-2");

      expect(renamed?.packageKey).toBe("packages/mail-core");
      expect(renamed?.repoKey).toBe("github.com/acme/monorepo");
      expect(untouched?.packageKey).toBe("packages/other");
    });

    test("package moved to a different path (same rewrite mechanism as rename)", async () => {
      await seedMemory(store, {
        id: "mem-moved",
        content: "Package moved from packages/ to libs/",
        repoKey: "github.com/acme/monorepo",
        packageKey: "packages/swarm-mail",
      });

      const result = await renamePackageKey(
        db,
        "github.com/acme/monorepo",
        "packages/swarm-mail",
        "libs/swarm-mail",
      );

      expect(result.updated).toBe(1);
      const moved = await store.get("mem-moved");
      expect(moved?.packageKey).toBe("libs/swarm-mail");
    });

    test("only rewrites within the given repo (same package path in a different repo is untouched)", async () => {
      await seedMemory(store, {
        id: "mem-repo-a",
        content: "repo A's copy",
        repoKey: "github.com/acme/repo-a",
        packageKey: "packages/shared",
      });
      await seedMemory(store, {
        id: "mem-repo-b",
        content: "repo B's copy",
        repoKey: "github.com/acme/repo-b",
        packageKey: "packages/shared",
      });

      await renamePackageKey(
        db,
        "github.com/acme/repo-a",
        "packages/shared",
        "packages/shared-renamed",
      );

      const a = await store.get("mem-repo-a");
      const b = await store.get("mem-repo-b");
      expect(a?.packageKey).toBe("packages/shared-renamed");
      expect(b?.packageKey).toBe("packages/shared");
    });
  });

  describe("findOrphanedRepoKeys (a scope key that no longer matches anything)", () => {
    test("detects a repo key present in the DB but absent from the known-projects set - proves orphaning is not silent", async () => {
      await seedMemory(store, {
        id: "mem-stale",
        content: "Scoped to a repo that has since been renamed upstream",
        repoKey: "github.com/acme/renamed-away",
      });
      await seedMemory(store, {
        id: "mem-current",
        content: "Scoped to a repo that's still known",
        repoKey: "github.com/acme/still-here",
      });

      const orphans = await findOrphanedRepoKeys(db, [
        "github.com/acme/still-here",
      ]);

      expect(orphans).toHaveLength(1);
      expect(orphans[0].repoKey).toBe("github.com/acme/renamed-away");
      expect(orphans[0].count).toBe(1);
    });

    test("no orphans when every stored repo key is in the known set", async () => {
      await seedMemory(store, {
        id: "mem-a",
        content: "a",
        repoKey: "github.com/acme/a",
      });

      const orphans = await findOrphanedRepoKeys(db, ["github.com/acme/a"]);

      expect(orphans).toHaveLength(0);
    });

    test("global memories (repo_key NULL) are never reported as orphaned", async () => {
      await seedMemory(store, { id: "mem-global", content: "global note" });

      const orphans = await findOrphanedRepoKeys(db, []);

      expect(orphans).toHaveLength(0);
    });

    test("after renameRepoKey, the old key no longer appears as an orphan and the new key isn't orphaned either", async () => {
      await seedMemory(store, {
        id: "mem-x",
        content: "x",
        repoKey: "github.com/acme/old",
      });

      await renameRepoKey(db, "github.com/acme/old", "github.com/acme/new");

      const orphans = await findOrphanedRepoKeys(db, ["github.com/acme/new"]);
      expect(orphans).toHaveLength(0);
    });
  });

  describe("findOrphanedPackageKeys", () => {
    test("detects a stale package key within a repo after a move/rename", async () => {
      await seedMemory(store, {
        id: "mem-pkg-stale",
        content: "Old package path",
        repoKey: "github.com/acme/monorepo",
        packageKey: "packages/old-name",
      });
      await seedMemory(store, {
        id: "mem-pkg-live",
        content: "Current package path",
        repoKey: "github.com/acme/monorepo",
        packageKey: "packages/live",
      });

      const orphans = await findOrphanedPackageKeys(
        db,
        "github.com/acme/monorepo",
        ["packages/live"],
      );

      expect(orphans).toHaveLength(1);
      expect(orphans[0].packageKey).toBe("packages/old-name");
      expect(orphans[0].repoKey).toBe("github.com/acme/monorepo");
      expect(orphans[0].count).toBe(1);
    });

    test("scoped to the given repo only - a matching package path in another repo doesn't mask an orphan", async () => {
      await seedMemory(store, {
        id: "mem-a",
        content: "a",
        repoKey: "github.com/acme/repo-a",
        packageKey: "packages/shared",
      });
      await seedMemory(store, {
        id: "mem-b",
        content: "b",
        repoKey: "github.com/acme/repo-b",
        packageKey: "packages/shared",
      });

      // repo-b's "packages/shared" no longer exists there, but repo-a's does.
      const orphans = await findOrphanedPackageKeys(
        db,
        "github.com/acme/repo-b",
        [],
      );

      expect(orphans).toHaveLength(1);
      expect(orphans[0].repoKey).toBe("github.com/acme/repo-b");
    });
  });
});
