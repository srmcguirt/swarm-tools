import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runSanitizationGate } from "doc-service";
import { createHiveAdapter } from "./hive-adapter.js";

const DB_PATH = join(homedir(), ".config/swarm-tools/swarm.db");
const KATAS_PROJECT_KEY = "/Users/smcguirt/Development/personal/katas";

/**
 * Proves doc-service's sanitization gate composes with the real extraction
 * pipeline against the live hive database (read-only). This is the division
 * of labor documented in both packages' READMEs: register.ts (extraction
 * time) deliberately does NOT strip "cell"/"hive"/"bead" — its own README
 * says that's the gate's job "with the full corpus and the full denylist
 * policy in view." This test proves that job actually gets done when the
 * two packages are wired together, not just in isolated unit tests.
 *
 * Skipped automatically if the DB isn't present (matches e2e.test.ts).
 */
describe.skipIf(!existsSync(DB_PATH))(
  "runSanitizationGate — composed with the real hive adapter",
  () => {
    test("catches real 'cell'/'hive'/'bead' leakage that register.ts intentionally leaves for the gate", async () => {
      const adapter = createHiveAdapter({
        dbPath: DB_PATH,
        projectKey: KATAS_PROJECT_KEY,
        project: { name: "katas", description: "Coding kata monorepo" },
      });
      const corpus = await adapter.extract();

      const result = runSanitizationGate(corpus);

      // The fork-maintenance closure narrative (katas--w5hg2-msibq790p0r) is
      // real, extracted, register-translated text that still contains bare
      // "beads"/"cell" occurrences register.ts's PROCESS_NOUNS list omits by
      // design. The gate must be the one to catch it.
      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      const forkMaintenanceViolations = result.errors.filter(
        (v) => v.recordId === "hive:katas--w5hg2-msibq790p0r",
      );
      expect(forkMaintenanceViolations.length).toBeGreaterThan(0);
      expect(
        forkMaintenanceViolations.some((v) => v.term.toLowerCase() === "beads"),
      ).toBe(true);

      // Every real violation category is process-vocabulary here — this
      // corpus's actual narrative text (terse engineering notes) has no AI
      // attribution trailers or agent codenames to find, which is itself a
      // useful negative result: the gate isn't crying wolf on categories
      // that genuinely have nothing to catch.
      expect(
        result.errors.every((v) => v.category === "process-vocabulary"),
      ).toBe(true);
    });

    test("technical facts in the same closure narrative are untouched by the gate (it only flags, never rewrites)", async () => {
      const adapter = createHiveAdapter({
        dbPath: DB_PATH,
        projectKey: KATAS_PROJECT_KEY,
        project: { name: "katas" },
      });
      const corpus = await adapter.extract();

      const forkMaintenance = corpus.workItems.find(
        (w) => w.id === "hive:katas--w5hg2-msibq790p0r",
      );
      expect(forkMaintenance?.closureNarrative).toContain("40349dd");
      expect(forkMaintenance?.closureNarrative).toContain("FK CASCADE");
      expect(forkMaintenance?.closureNarrative).toContain("14 memories");

      // Gate is read-only over the corpus: running it doesn't mutate fields.
      runSanitizationGate(corpus);
      expect(forkMaintenance?.closureNarrative).toContain("40349dd");
      expect(forkMaintenance?.closureNarrative).toContain("FK CASCADE");
    });

    test("the hive-doc-adapter epic's own closed task (katas--w5hg2-msj0nhcnhtz) is flagged for 'hive cells'/'hive data' throughout title, decision, and timeline", async () => {
      const adapter = createHiveAdapter({
        dbPath: DB_PATH,
        projectKey: KATAS_PROJECT_KEY,
        project: { name: "katas" },
      });
      const corpus = await adapter.extract();
      const result = runSanitizationGate(corpus);

      const violations = result.errors.filter((v) =>
        v.recordId.includes("katas--w5hg2-msj0nhcnhtz"),
      );
      expect(violations.length).toBeGreaterThan(0);
      expect(
        violations.some((v) => v.term.toLowerCase() === "hive cells"),
      ).toBe(true);
      expect(violations.some((v) => v.term.toLowerCase() === "hive data")).toBe(
        true,
      );
    });

    test("honest miss, documented: register.ts's mechanism-clause stripping removes the process context the gate's sentence-context rule needed", async () => {
      // Real fixture: katas--w5hg2-msj0nhcm75v's raw hive text reads "...for
      // all 8 sibling cells sent via swarm mail (message 113)...". register.ts
      // strips "sent via swarm mail (message N)" as a pure coordination
      // mechanism clause (see register.ts MECHANISM_CLAUSES) *before* the
      // gate ever sees the text — which is correct extraction-time behavior,
      // but it also removes the "swarm" co-occurrence the gate's sentence-
      // context rule would have used to flag the surviving bare "cells".
      // Net effect: this specific occurrence reaches the corpus unflagged.
      // Not a bug in either layer — a real seam between two independently
      // justified deterministic passes, documented here rather than papered
      // over with a passing assertion that doesn't reflect what the pipeline
      // actually does.
      const adapter = createHiveAdapter({
        dbPath: DB_PATH,
        projectKey: KATAS_PROJECT_KEY,
        project: { name: "katas" },
      });
      const corpus = await adapter.extract();

      const foundation = corpus.workItems.find(
        (w) => w.id === "hive:katas--w5hg2-msj0nhcm75v",
      );
      expect(foundation?.closureNarrative).toContain("sibling cells");
      expect(foundation?.closureNarrative).not.toContain("swarm mail");

      const result = runSanitizationGate(corpus);
      const violations = result.errors.filter(
        (v) => v.recordId === "hive:katas--w5hg2-msj0nhcm75v",
      );
      expect(
        violations.some((v) => v.term.toLowerCase().includes("cell")),
      ).toBe(false);
    });
  },
);
