import { describe, expect, test } from "bun:test";
import type {
  Decision,
  DocumentationCorpus,
  Incident,
  Procedure,
  Provenance,
  WorkItem,
} from "../ir/types.js";
import { createEmptyCorpus } from "../ir/corpus.js";
import {
  assertSanitized,
  runSanitizationGate,
  SanitizationGateError,
} from "./sanitization-gate.js";

const project = { name: "test-project" };

function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    sourceSystem: "hive",
    sourceRef: "katas--w5hg2-test",
    extractedAt: "2026-08-07T00:00:00.000Z",
    confidence: "verified",
    ...overrides,
  };
}

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "hive:test",
    title: "Test item",
    type: "task",
    status: "closed",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    childIds: [],
    labels: [],
    provenance: provenance(),
    ...overrides,
  };
}

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "hive-incident:test",
    title: "Test incident",
    severity: "high",
    symptom: "",
    rootCause: "",
    fix: "",
    verification: "",
    occurredAt: "2026-08-01T00:00:00.000Z",
    relatedWorkItemIds: [],
    provenance: provenance(),
    ...overrides,
  };
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "hive-decision:test",
    title: "Test decision",
    outcome: "adopted",
    summary: "",
    optionsConsidered: [],
    evidence: [],
    decidedAt: "2026-08-01T00:00:00.000Z",
    relatedWorkItemIds: [],
    provenance: provenance(),
    ...overrides,
  };
}

function procedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    id: "hive-procedure:test",
    title: "Test procedure",
    category: "other",
    steps: [],
    verified: true,
    gotchas: [],
    relatedWorkItemIds: [],
    provenance: provenance(),
    ...overrides,
  };
}

function corpusWith(
  partial: Partial<DocumentationCorpus>,
): DocumentationCorpus {
  return { ...createEmptyCorpus(project), ...partial };
}

// ============================================================================
// Real leakage — literal excerpts pulled directly from actual hive cells in
// the live swarm.db (katas--w5hg2-msibq790p0r, katas--w5hg2-msj0nhchrv2).
// These are exactly the "cell"/"hive"/"bead" occurrences register.ts (the
// extraction-layer translator) deliberately leaves untouched, per its own
// README: "that's the sanitization gate's job, with the full corpus and the
// full denylist policy in view." Not invented strings.
// ============================================================================

describe("runSanitizationGate — real leakage from live hive cells", () => {
  test("catches 'beads' as standalone process vocabulary (katas--w5hg2-msibq790p0r)", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative:
            "For beads: confirmed FK CASCADE + `PRAGMA foreign_keys=1` already correct, " +
            "so a single scoped DELETE was safe. Deleted 568 beads across 172 scratch " +
            "project_keys: 696 -> 128.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(false);
    const beadHits = result.errors.filter(
      (v) => v.term.toLowerCase() === "beads",
    );
    expect(beadHits.length).toBeGreaterThanOrEqual(2);
    expect(beadHits.every((v) => v.category === "process-vocabulary")).toBe(
      true,
    );
  });

  test("does not flag 'swarm' inside the real hyphenated package name swarm-tools", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative:
            "katas (8 beads, kept) and swarm-tools/packages/opencode-swarm-plugin " +
            "(120 beads - sampled titles confirmed real historical work), left untouched.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    const swarmHits = result.errors.filter(
      (v) => v.term.toLowerCase() === "swarm",
    );
    expect(swarmHits).toHaveLength(0);
    // the two bare "beads" occurrences still fire
    expect(
      result.errors.filter((v) => v.term.toLowerCase() === "beads").length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("catches the 'hive data (cells, ...)' bigram+co-occurrence, and lists the policy terms themselves as leakage (katas--w5hg2-msj0nhchrv2)", () => {
    const corpus = corpusWith({
      decisions: [
        decision({
          summary:
            "Build a portable documentation service that reads hive data (cells, memories, " +
            "outcomes) plus git history and generates a structured documentation set.",
        }),
      ],
      incidents: [
        incident({
          rootCause:
            "Everything emitted must pass the external-code sanitization policy: no internal " +
            "process vocabulary (swarm/worker/coordinator/cell/hive/subtask) in " +
            "externally-visible artifacts.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(false);
    expect(result.errors.some((v) => v.term.toLowerCase() === "hive")).toBe(
      true,
    );
    expect(
      result.errors.some(
        (v) =>
          v.term.toLowerCase() === "cells" || v.term.toLowerCase() === "cell",
      ),
    ).toBe(true);
    // the meta-list sentence itself names the exact denylisted words
    const rootCauseHits = result.errors.filter(
      (v) => v.recordId === "hive-incident:test",
    );
    expect(rootCauseHits.some((v) => v.term.toLowerCase() === "swarm")).toBe(
      true,
    );
    expect(
      rootCauseHits.some((v) => v.term.toLowerCase() === "coordinator"),
    ).toBe(true);
    expect(rootCauseHits.some((v) => v.term.toLowerCase() === "subtask")).toBe(
      true,
    );
  });

  test("catches 'sibling cells sent via swarm mail' (katas--w5hg2-msj0nhcm75v)", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative:
            "Handoff with per-file contracts for all 8 sibling cells sent via swarm mail " +
            "(message 113) and documented in packages/doc-service/README.md.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(false);
    expect(result.errors.some((v) => v.term.toLowerCase() === "swarm")).toBe(
      true,
    );
    expect(result.errors.some((v) => v.term.toLowerCase() === "cells")).toBe(
      true,
    );
  });

  test("honest limitation: an ambiguous term with no process-context in the same sentence is NOT caught", () => {
    // Real excerpt: "...the production memory/cell corpus is clean." — no
    // co-occurring process word, no id-shaped token, in that sentence. This
    // is the documented blind spot of the sentence-context heuristic: it
    // trades this kind of miss for not flagging every spreadsheet doc.
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative:
            "This closes out the fork-maintenance epic: fixes are built, installed, " +
            "verified live, and the production memory/cell corpus is clean.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(
      result.errors.some((v) => v.term.toLowerCase().includes("cell")),
    ).toBe(false);
  });
});

// ============================================================================
// False positives — the tests that matter more than the leakage tests. Every
// one of these is a legitimate technical sentence that must survive.
// ============================================================================

describe("runSanitizationGate — false-positive avoidance (the hard part)", () => {
  test("a doc about web workers, worker threads, and user agents passes clean", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative:
            "Implemented a worker pool backed by web workers for CPU-bound parsing. Each " +
            "worker thread reports progress via postMessage. The server also logs the " +
            "user agent string of every incoming request for analytics.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("a code block referencing swarm_complete is a factual API reference, not a leak", () => {
    const corpus = corpusWith({
      procedures: [
        procedure({
          steps: [
            {
              order: 1,
              action:
                "Call the completion API once the task is done:\n\n```\nawait swarm_complete({ bead_id, agent_name, summary });\n```",
            },
          ],
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(true);
  });

  test("bare snake_case identifiers (no backticks) survive as code-adjacent", () => {
    const corpus = corpusWith({
      incidents: [
        incident({
          rootCause: "swarm_complete succeeded without start_time being set.",
          symptom: "n/a",
          fix: "n/a",
          verification: "n/a",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(true);
  });

  test("swarm-mail, swarm.db, and swarm-tools package/file names survive untouched", () => {
    const corpus = corpusWith({
      incidents: [
        incident({
          rootCause:
            "getDatabasePath() in packages/swarm-mail/src/streams/index.ts always resolves " +
            "to ~/.config/swarm-tools/swarm.db unless SWARM_DB_PATH is set.",
          symptom: "n/a",
          fix: "n/a",
          verification: "n/a",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(true);
  });

  test("a sentence correctly using 'robust' in a known-good technical collocation does not warn", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative:
            "Added robust error handling around the retry loop and a robust type system " +
            "check in CI.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(
      result.warnings.filter((v) => v.category === "ai-slop"),
    ).toHaveLength(0);
  });

  test("'leverage' used as a noun (financial sense) does not warn", () => {
    const corpus = corpusWith({
      decisions: [
        decision({
          summary:
            "The company reduced its financial leverage ratio after the acquisition closed.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(
      result.warnings.filter((v) => v.category === "ai-slop"),
    ).toHaveLength(0);
  });

  test("spreadsheet/table/prison/battery cell senses are never flagged", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative:
            "Fixed a bug where the spreadsheet cell formula didn't recalculate. Also " +
            "replaced the battery cell in the sensor and relabeled the prison cell " +
            "capacity report's table cell borders.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.errors).toHaveLength(0);
  });

  test("a real human named Claude reviewing a PR is not flagged as model self-identification", () => {
    const corpus = corpusWith({
      timeline: [
        {
          id: "git:abc123",
          kind: "milestone",
          occurredAt: "2026-08-01T00:00:00.000Z",
          title: "Merged the retry-logic fix",
          description: "Claude Smith approved and merged the PR after review.",
          relatedIds: [],
          provenance: provenance({
            sourceSystem: "git",
            sourceRef: "abc123",
            author: "Claude Smith",
          }),
        },
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.errors).toHaveLength(0);
  });

  test("a real git commit author name in provenance is never flagged", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          provenance: provenance({
            sourceSystem: "git",
            author: "Shane McGuirt",
          }),
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.errors).toHaveLength(0);
  });
});

// ============================================================================
// Agent identity, AI attribution, and slop — synthetic-but-realistic, since
// (as expected) none of the terse real engineering notes in this corpus
// contain AI attribution trailers or slop prose. Proves the categories the
// real data can't exercise.
// ============================================================================

describe("runSanitizationGate — agent identity and AI attribution", () => {
  test("catches an agent codename", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative: "WarmStorm reserved the file before editing it.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(false);
    expect(result.errors.some((v) => v.category === "agent-identity")).toBe(
      true,
    );
  });

  test("catches a configured known agent name", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({ closureNarrative: "QuickLake paired on this fix." }),
      ],
    });
    const result = runSanitizationGate(corpus, { agentNames: ["QuickLake"] });
    expect(result.passed).toBe(false);
  });

  test("catches a Co-Authored-By trailer naming an assistant", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative:
            "Fixed the bug.\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(false);
    expect(result.errors.some((v) => v.category === "ai-attribution")).toBe(
      true,
    );
  });

  test("catches 'Generated with' and the robot emoji", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({ closureNarrative: "Generated with Claude Code 🤖" }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(false);
    expect(
      result.errors.filter((v) => v.category === "ai-attribution").length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("catches first-person assistant self-reference", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative:
            "As an AI, I don't have the ability to run this locally.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(false);
  });

  test("catches multi-word model self-identification but not bare product-adjacent words", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative: "Drafted with GPT-4 based on the incident notes.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(false);
    expect(result.errors.some((v) => v.category === "agent-identity")).toBe(
      true,
    );
  });
});

describe("runSanitizationGate — AI slop is warn-tier, not build-failing", () => {
  test("'delve' and 'seamlessly' warn but do not fail the gate", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative:
            "Let's delve into the details. The migration integrates seamlessly with the " +
            "existing pipeline.",
        }),
      ],
    });
    const result = runSanitizationGate(corpus);
    expect(result.passed).toBe(true);
    expect(result.warnings.some((v) => v.term === "delve")).toBe(true);
    expect(result.warnings.some((v) => v.term === "seamless")).toBe(true);
  });

  test("slop severity is configurable to error", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({ closureNarrative: "Let's delve into the details." }),
      ],
    });
    const result = runSanitizationGate(corpus, { slopSeverity: "error" });
    expect(result.passed).toBe(false);
    expect(result.errors.some((v) => v.category === "ai-slop")).toBe(true);
  });
});

// ============================================================================
// assertSanitized / SanitizationGateError — proves the gate fails the build
// ============================================================================

describe("assertSanitized", () => {
  test("throws SanitizationGateError on a real leak, carrying structured violations", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative:
            "The coordinator spawned a worker to fix it.\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
        }),
      ],
    });
    expect(() => assertSanitized(corpus)).toThrow(SanitizationGateError);
    try {
      assertSanitized(corpus);
      throw new Error("expected assertSanitized to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SanitizationGateError);
      const gateErr = err as SanitizationGateError;
      expect(gateErr.violations.length).toBeGreaterThan(0);
      expect(
        gateErr.violations.some((v) => v.category === "process-vocabulary"),
      ).toBe(true);
      expect(
        gateErr.violations.some((v) => v.category === "ai-attribution"),
      ).toBe(true);
      expect(gateErr.message).toContain("Sanitization gate failed");
    }
  });

  test("does not throw on a clean corpus", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative: "Fixed the memory leak in the retry loop.",
        }),
      ],
    });
    expect(() => assertSanitized(corpus)).not.toThrow();
  });
});

// ============================================================================
// Config: additive term/allowlist extension, disable flags, enabled toggle
// ============================================================================

describe("runSanitizationGate — per-project config", () => {
  test("extra processTerms are additive to the built-in list", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({ closureNarrative: "The pod reviewed the change." }),
      ],
    });
    const clean = runSanitizationGate(corpus);
    expect(clean.passed).toBe(true);

    const withCustomTerm = runSanitizationGate(corpus, {
      processTerms: ["pod"],
    });
    expect(withCustomTerm.passed).toBe(false);
  });

  test("extra allowlist phrases exempt a project-specific compound", () => {
    const corpus = corpusWith({
      workItems: [
        workItem({
          closureNarrative: "Deployed via the swarm-widget dashboard.",
        }),
      ],
    });
    // "swarm-widget" is code-adjacent (hyphenated) so it already passes by
    // construction — use a non-hyphenated compound to prove allowlist config works.
    const corpus2 = corpusWith({
      workItems: [
        workItem({
          closureNarrative: "Deployed via the Swarm Widget dashboard.",
        }),
      ],
    });
    const withoutAllowlist = runSanitizationGate(corpus2);
    expect(withoutAllowlist.passed).toBe(false);

    const withAllowlist = runSanitizationGate(corpus2, {
      allowlist: ["swarm widget"],
    });
    expect(withAllowlist.passed).toBe(true);
    void corpus;
  });

  test("enabled: false short-circuits the gate entirely", () => {
    const corpus = corpusWith({
      workItems: [workItem({ closureNarrative: "The swarm did everything." })],
    });
    const result = runSanitizationGate(corpus, { enabled: false });
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("disableDefaultProcessTerms clears built-ins, keeping only project-supplied terms", () => {
    const corpus = corpusWith({
      workItems: [workItem({ closureNarrative: "The swarm did everything." })],
    });
    const result = runSanitizationGate(corpus, {
      disableDefaultProcessTerms: true,
      processTerms: ["frobnicate"],
    });
    expect(result.passed).toBe(true);
  });
});
