import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createHiveAdapter } from "./hive-adapter.js";
import { hasLeakage } from "./register.js";

const DB_PATH = join(homedir(), ".config/swarm-tools/swarm.db");
const KATAS_PROJECT_KEY = "/Users/smcguirt/Development/personal/katas";
const KATAS_REPO_PATH = "/Users/smcguirt/Development/personal/katas";

/**
 * Real end-to-end extraction against the live hive database. Read-only:
 * exercises the same code path production use would (createHiveAdapter ->
 * extract()), never writes. Skipped automatically if the DB isn't present
 * at this path (e.g. CI, a different machine).
 */
describe.skipIf(!existsSync(DB_PATH))(
  "createHiveAdapter — real katas epics",
  () => {
    test("extracts the doc-service epic (katas--w5hg2-msj0nhchrv2) with translated, leakage-free text", async () => {
      const adapter = createHiveAdapter({
        dbPath: DB_PATH,
        projectKey: KATAS_PROJECT_KEY,
        gitRepoPath: KATAS_REPO_PATH,
        project: { name: "katas", description: "Coding kata monorepo" },
      });

      const corpus = await adapter.extract();

      expect(corpus.workItems.length).toBeGreaterThan(0);

      const epic = corpus.workItems.find(
        (w) => w.id === "hive:katas--w5hg2-msj0nhchrv2",
      );
      expect(epic).toBeDefined();
      expect(epic?.type).toBe("epic");

      const foundationTask = corpus.workItems.find(
        (w) => w.id === "hive:katas--w5hg2-msj0nhcm75v",
      );
      expect(foundationTask).toBeDefined();
      expect(foundationTask?.status).toBe("closed");
      expect(foundationTask?.closureNarrative).toBeTruthy();

      // No process vocabulary anywhere in the corpus's free text.
      for (const item of corpus.workItems) {
        expect(hasLeakage(item.title)).toBe(false);
        if (item.closureNarrative)
          expect(hasLeakage(item.closureNarrative)).toBe(false);
      }
      for (const d of corpus.decisions) {
        expect(hasLeakage(d.summary)).toBe(false);
      }
      for (const i of corpus.incidents) {
        expect(hasLeakage(i.symptom)).toBe(false);
        expect(hasLeakage(i.rootCause)).toBe(false);
        expect(hasLeakage(i.fix)).toBe(false);
      }
      for (const p of corpus.procedures) {
        for (const step of p.steps) expect(hasLeakage(step.action)).toBe(false);
      }

      // Technical facts must survive: the foundation task narrative mentions the real commit sha.
      expect(foundationTask?.closureNarrative).toContain("b9ab4f4");

      // Regression: the open doc-service epic's own description discusses
      // "an embedding migration rejected on benchmark evidence" as an example
      // of desired output, not as an actual decision. Must not be extracted.
      expect(
        corpus.decisions.find(
          (d) => d.id === "hive-decision:katas--w5hg2-msj0nhchrv2",
        ),
      ).toBeUndefined();

      // Every record carries provenance traceable to a real hive cell id.
      for (const item of corpus.workItems) {
        expect(item.provenance.sourceSystem).toBe("hive");
        expect(item.provenance.sourceRef.length).toBeGreaterThan(0);
        expect(item.id).toBe(`hive:${item.provenance.sourceRef}`);
        expect(item.provenance.author).toBeUndefined();
      }
    });

    test("extracts the fork-maintenance epic (katas--w5hg2-msibq790p0r) as both a Decision and a Procedure", async () => {
      const adapter = createHiveAdapter({
        dbPath: DB_PATH,
        projectKey: KATAS_PROJECT_KEY,
        project: { name: "katas" },
      });
      const corpus = await adapter.extract();

      const decision = corpus.decisions.find(
        (d) => d.id === "hive-decision:katas--w5hg2-msibq790p0r",
      );
      expect(decision).toBeDefined();
      expect(decision?.outcome).toBe("adopted");
      expect(hasLeakage(decision?.summary ?? "")).toBe(false);
      expect(decision?.summary).toContain("PR #206");

      const procedure = corpus.procedures.find(
        (p) => p.id === "hive-procedure:katas--w5hg2-msibq790p0r",
      );
      expect(procedure).toBeDefined();
      expect(procedure?.verified).toBe(true);
      expect(procedure?.steps.length).toBeGreaterThanOrEqual(4);
      // Build-order fact survives.
      const rebuildStep = procedure?.steps.find((s) =>
        s.action.includes("swarm-queue"),
      );
      expect(rebuildStep?.action).toContain(
        "swarm-queue -> swarm-mail -> opencode-swarm-plugin",
      );
    });

    test("extracts the DB-isolation incident (katas--w5hg2-msie1245wre) with root cause/fix/verification intact", async () => {
      const adapter = createHiveAdapter({
        dbPath: DB_PATH,
        projectKey: KATAS_PROJECT_KEY,
        project: { name: "katas" },
      });
      const corpus = await adapter.extract();

      const incident = corpus.incidents.find(
        (i) => i.id === "hive-incident:katas--w5hg2-msie1245wre",
      );
      expect(incident).toBeDefined();
      expect(incident?.rootCause).toContain("getDatabasePath()");
      expect(incident?.rootCause).toContain("afterEach");
      expect(incident?.fix).toContain("bunfig.toml");
      expect(incident?.verification).toContain("14 memories/14 embeddings");
      expect(hasLeakage(incident?.rootCause ?? "")).toBe(false);
      expect(hasLeakage(incident?.fix ?? "")).toBe(false);
      expect(hasLeakage(incident?.verification ?? "")).toBe(false);
    });

    test("git timeline events are present when a repo path is given", async () => {
      const adapter = createHiveAdapter({
        dbPath: DB_PATH,
        projectKey: KATAS_PROJECT_KEY,
        gitRepoPath: KATAS_REPO_PATH,
        project: { name: "katas" },
      });
      const corpus = await adapter.extract();
      const gitEvents = corpus.timeline.filter(
        (e) => e.provenance.sourceSystem === "git",
      );
      expect(gitEvents.length).toBeGreaterThan(0);
      expect(gitEvents[0].provenance.author).toBeTruthy();
    });
  },
);
