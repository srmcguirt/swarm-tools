import { describe, expect, test } from "bun:test";
import { hasLeakage, translateRegister } from "./register.js";

describe("translateRegister — brief examples", () => {
  test("worker fixed X -> X was fixed", () => {
    const out = translateRegister("The worker fixed the memory leak.");
    expect(out).toBe("The memory leak was fixed.");
    expect(hasLeakage(out)).toBe(false);
  });

  test("the swarm scaffolded 61 packages -> 61 packages were scaffolded", () => {
    const out = translateRegister("The swarm scaffolded 61 packages.");
    expect(out).toBe("61 packages were scaffolded.");
    expect(hasLeakage(out)).toBe(false);
  });

  test("coordinator spawned a subtask to X -> keeps outcome, drops mechanism", () => {
    const out = translateRegister(
      "The coordinator spawned a subtask to fix the SQL injection in cursor.ts.",
    );
    expect(out).toBe("Fix the SQL injection in cursor.ts.");
    expect(hasLeakage(out)).toBe(false);
  });

  test("agent codenames are removed entirely", () => {
    const out = translateRegister(
      "DarkOcean reserved packages/hive-doc-adapter before editing.",
    );
    expect(out).not.toMatch(/DarkOcean/);
    expect(hasLeakage(out)).toBe(false);
  });

  test("known live agent names are removed via denylist", () => {
    const out = translateRegister(
      "QuickWolf and TestWorker paired on this fix.",
      {
        knownAgentNames: ["QuickWolf", "TestWorker"],
      },
    );
    expect(out).not.toMatch(/QuickWolf|TestWorker/);
  });
});

describe("translateRegister — code spans and package names survive untouched", () => {
  test("swarm-mail, swarm.db, swarm-tools package/file names are preserved", () => {
    const input =
      "getDatabasePath() in packages/swarm-mail/src/streams/index.ts always resolves to " +
      "~/.config/swarm-tools/swarm.db unless SWARM_DB_PATH is set.";
    const out = translateRegister(input);
    expect(out).toContain("packages/swarm-mail/src/streams/index.ts");
    expect(out).toContain("swarm-tools/swarm.db");
    expect(out).toContain("SWARM_DB_PATH");
  });

  test("snake_case tool identifiers in code spans survive", () => {
    const input =
      "Ran `swarm_adversarial_review` separately: it returned a fabricated critique.";
    const out = translateRegister(input);
    expect(out).toContain("`swarm_adversarial_review`");
  });

  test("bare snake_case tool identifiers (no backticks) survive", () => {
    const input = "swarm_complete succeeded without start_time.";
    const out = translateRegister(input);
    expect(out).toContain("swarm_complete");
  });

  test("sentence-initial filenames are not capitalized into fictional casing", () => {
    // Regression: capitalizeSentences must not turn "bunfig.toml" into "Bunfig.toml"
    // when it lands at a sentence start after subject-drop or a section split.
    const out = translateRegister(
      "bunfig.toml forces SWARM_DB_PATH to a temp file.",
    );
    expect(out).toContain("bunfig.toml");
    expect(out).not.toContain("Bunfig.toml");
  });
});

describe("translateRegister — real fixtures (DB-destruction incident, katas--w5hg2-msie1245wre)", () => {
  const symptom =
    "None of the swarm-mail test files that call getSwarmMailLibSQL()/getDatabasePath() " +
    "(libsql.convenience.test.ts, streams/index.test.ts, streams/store-auto-adapter.test.ts, " +
    "streams/swarm-mail.test.ts, streams/events.test.ts) set SWARM_DB_PATH for isolation. " +
    "Running bun test in packages/swarm-mail therefore opens real connections against, and can " +
    "mutate/wipe, the live shared production database that every project's hivemind/CASS memory " +
    "system depends on.\n\n" +
    "Reproduced twice in one session: running the swarm-mail test suite (bun test, full 1352-test " +
    "run) coincided with the live ~/.config/swarm-tools/swarm.db memories table dropping from 14 " +
    "rows to 0 rows, both times. Confirmed via direct @libsql/client inspection (COUNT(id), not the " +
    "vector-index-broken COUNT(*) via stock sqlite3) before and after.";

  const fix =
    "Fixed swarm-mail test/production DB isolation. Root cause: getDatabasePath() only honored " +
    "SWARM_DB_PATH via env var, but no preload set it, so tests without an explicit dbOverride/" +
    "in-memory helper silently hit ~/.config/swarm-tools/swarm.db. Confirmed two live writers " +
    "(store-auto-adapter.test.ts, events.test.ts) plus one that deleted the prod file every " +
    "afterEach, and three auto-migration tests in index.test.ts that ran real migrations against " +
    "the real global DB. Fix: bunfig.toml + test-preload.ts (matches sibling packages' convention) " +
    "forces SWARM_DB_PATH to a temp file before any test loads; added a throw-loud runtime guard in " +
    "getDatabasePath() that fires if NODE_ENV=test and the resolved path equals the real production " +
    "path. Acceptance gate: backed up prod DB, verified 14 memories/14 embeddings pre and post, " +
    "byte-identical md5+mtime across 3 full suite runs (1238 pass/0 fail/29 skip, one unrelated " +
    "pre-existing flake elsewhere confirmed by rerun). Negative test proved the guard throws, then " +
    "deleted. Committed 6cc0ac2 to integration/local-build, pushed to origin (srmcguirt/swarm-tools).";

  test("no process vocabulary leaks in symptom text", () => {
    const out = translateRegister(symptom);
    expect(hasLeakage(out)).toBe(false);
  });

  test("no process vocabulary leaks in fix text", () => {
    const out = translateRegister(fix);
    expect(hasLeakage(out)).toBe(false);
  });

  test("technical facts survive translation: paths, env vars, counts, commit sha", () => {
    const out = translateRegister(fix);
    expect(out).toContain("getDatabasePath()");
    expect(out).toContain("SWARM_DB_PATH");
    expect(out).toContain("bunfig.toml");
    expect(out).toContain("test-preload.ts");
    expect(out).toContain("14 memories/14 embeddings");
    expect(out).toContain("1238 pass/0 fail/29 skip");
    expect(out).toContain("6cc0ac2");
    expect(out).toContain("afterEach");
  });

  test("technical facts survive translation: file list, row counts", () => {
    const out = translateRegister(symptom);
    expect(out).toContain("libsql.convenience.test.ts");
    expect(out).toContain("14 rows to 0 rows");
    expect(out).toContain("COUNT(id)");
    expect(out).toContain("stock sqlite3");
  });
});

describe("translateRegister — real fixture (fork-maintenance decision, katas--w5hg2-msibq790p0r)", () => {
  const decision =
    "User decision: stop hand-patching the global install and instead run from a maintained fork. " +
    "Upstream appears stale (PR #206 has no maintainer engagement, CI stuck at action_required " +
    "pending first-time-contributor approval).\n\n" +
    "RATIONALE: every fix so far is a patch to compiled output in " +
    "~/.bun/install/global/node_modules/opencode-swarm-plugin/dist/bin/swarm.js, silently reverted " +
    "by the next `bun install -g`. This tooling is load-bearing for daily work and is broken in " +
    "several significant ways. Running from a fork makes fixes persist.";

  test("no process vocabulary leaks (this fixture has none to begin with — regression guard)", () => {
    const out = translateRegister(decision);
    expect(hasLeakage(out)).toBe(false);
  });

  test("evidence-bearing facts survive: PR number, path, install command", () => {
    const out = translateRegister(decision);
    expect(out).toContain("PR #206");
    expect(out).toContain("opencode-swarm-plugin/dist/bin/swarm.js");
    expect(out).toContain("bun install -g");
  });
});

describe("translateRegister — real fixture (rebuild procedure, fork-maintenance result)", () => {
  const procedure =
    "STEP 1 - REBUILD/REINSTALL: Confirmed the previously-packed tarballs (built Aug 6 23:09) " +
    "predated the branch HEAD commit 40349dd. Rebuilt clean in dependency order " +
    "(swarm-queue -> swarm-mail -> opencode-swarm-plugin), packed fresh tarballs, backed up the " +
    "global install, reinstalled swarm-mail then opencode-swarm-plugin globally. " +
    "`swarm doctor` reports healthy. Rollback: bun remove -g opencode-swarm-plugin swarm-mail && " +
    "bun add -g opencode-swarm-plugin@0.63.2.";

  test("no process vocabulary leaks", () => {
    const out = translateRegister(procedure);
    expect(hasLeakage(out)).toBe(false);
  });

  test("build order and rollback command survive verbatim", () => {
    const out = translateRegister(procedure);
    expect(out).toContain("swarm-queue -> swarm-mail -> opencode-swarm-plugin");
    expect(out).toContain(
      "bun remove -g opencode-swarm-plugin swarm-mail && bun add -g opencode-swarm-plugin@0.63.2",
    );
    expect(out).toContain("40349dd");
  });
});

describe("hasLeakage", () => {
  test("flags standalone process nouns", () => {
    expect(hasLeakage("The worker fixed it.")).toBe(true);
    expect(hasLeakage("The swarm did it.")).toBe(true);
    expect(hasLeakage("A coordinator spawned a subtask.")).toBe(true);
    expect(hasLeakage("An agent ran the tests.")).toBe(true);
  });

  test("does not flag code-adjacent or package-name occurrences", () => {
    expect(hasLeakage("swarm-mail is a package in this monorepo.")).toBe(false);
    expect(hasLeakage("See `swarm_complete` for details.")).toBe(false);
    expect(hasLeakage("~/.config/swarm-tools/swarm.db")).toBe(false);
  });
});
