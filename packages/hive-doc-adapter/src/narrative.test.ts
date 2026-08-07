import { describe, expect, test } from "bun:test";
import {
  detectDecision,
  detectIncident,
  detectProcedure,
  extractMeasurements,
  parseStructuredSections,
} from "./narrative.js";

describe("parseStructuredSections", () => {
  test("splits ROOT CAUSE:/Fix:/Acceptance gate: sections", () => {
    const text =
      "Fixed the isolation bug. Root cause: getDatabasePath() only honored SWARM_DB_PATH via env " +
      "var. Fix: bunfig.toml + test-preload.ts forces SWARM_DB_PATH. Acceptance gate: verified 14 " +
      "memories/14 embeddings pre and post.";
    const { lead, sections } = parseStructuredSections(text);
    expect(lead).toBe("Fixed the isolation bug");
    expect(sections.get("root cause")).toContain("getDatabasePath()");
    expect(sections.get("fix")).toContain("bunfig.toml");
    expect(sections.get("acceptance gate")).toContain(
      "14 memories/14 embeddings",
    );
  });

  test("no labeled sections -> everything is lead", () => {
    const { lead, sections } = parseStructuredSections(
      "Just plain text, no labels.",
    );
    expect(lead).toBe("Just plain text, no labels.");
    expect(sections.size).toBe(0);
  });
});

describe("detectDecision — real fixture (fork-maintenance, katas--w5hg2-msibq790p0r)", () => {
  const narrative =
    "User decision: stop hand-patching the global install and instead run from a maintained fork. " +
    "Upstream appears stale (PR #206 has no maintainer engagement).\n\n" +
    "RATIONALE: every fix so far is a patch to compiled output, silently reverted by the next " +
    "`bun install -g`. Running from a fork makes fixes persist.";

  test("detects as a decision with adopted outcome", () => {
    const d = detectDecision(
      "User decision: stop hand-patching the global install and instead run from a maintained fork.",
      narrative,
    );
    expect(d).not.toBeNull();
    expect(d?.outcome).toBe("adopted");
    expect(d?.rationale).toContain("bun install -g");
  });
});

describe("detectDecision — rejection with benchmark evidence (constructed per brief's stated example)", () => {
  // The task brief describes a real embedding-runtime migration rejected twice on measured
  // benchmarks (23.79ms vs 38.64ms warm medians, n=20) but this exact text was not found verbatim
  // in the current swarm.db snapshot searched during extraction (see EXTRACTION_REPORT.md). This
  // fixture reproduces the brief's stated shape to prove the detector handles it; it is not lifted
  // verbatim from a queried row.
  const narrative =
    "Proposal to migrate the embedding runtime was rejected. Benchmark showed the proposed runtime " +
    "was slower: warm median 38.64ms vs current 23.79ms (n=20 runs each). Rationale: current runtime " +
    "already meets latency budget; migration adds a new dependency for a regression, not a gain.";

  test("detects rejection and extracts benchmark evidence", () => {
    const d = detectDecision("Embedding runtime migration", narrative);
    expect(d).not.toBeNull();
    expect(d?.outcome).toBe("rejected");

    const measurements = extractMeasurements(narrative);
    const values = measurements.map((m) => m.value);
    expect(values).toContain(38.64);
    expect(values).toContain(23.79);
    expect(values).toContain(20);
  });
});

describe("detectIncident — real fixture (DB destruction, katas--w5hg2-msie1245wre result field)", () => {
  const result =
    "Fixed swarm-mail test/production DB isolation. Root cause: getDatabasePath() only honored " +
    "SWARM_DB_PATH via env var, but no preload set it, so tests without an explicit dbOverride " +
    "silently hit ~/.config/swarm-tools/swarm.db. Confirmed two live writers plus one that deleted " +
    "the prod file every afterEach. Fix: bunfig.toml + test-preload.ts forces SWARM_DB_PATH to a " +
    "temp file before any test loads; added a throw-loud runtime guard in getDatabasePath(). " +
    "Acceptance gate: backed up prod DB, verified 14 memories/14 embeddings pre and post, " +
    "byte-identical md5+mtime across 3 full suite runs.";

  test("extracts rootCause, fix, and verification with facts intact", () => {
    const incident = detectIncident(result);
    expect(incident).not.toBeNull();
    expect(incident?.rootCause).toContain("getDatabasePath()");
    expect(incident?.rootCause).toContain("afterEach");
    expect(incident?.fix).toContain("bunfig.toml");
    expect(incident?.fix).toContain("test-preload.ts");
    expect(incident?.verification).toContain("14 memories/14 embeddings");
    expect(incident?.verification).toContain("byte-identical md5+mtime");
  });

  test("narrative without a Root cause: label is not detected as an incident", () => {
    expect(
      detectIncident("Just closed this, nothing structured here."),
    ).toBeNull();
  });
});

describe("detectProcedure — real fixture (rebuild/reinstall, fork-maintenance STEP markers)", () => {
  const result =
    "STEP 1 - REBUILD/REINSTALL: Rebuilt clean in dependency order " +
    "(swarm-queue -> swarm-mail -> opencode-swarm-plugin), packed fresh tarballs. " +
    "`swarm doctor` reports healthy.\n" +
    "STEP 2 - MCP HOST RESTART: Could not kill/restart that process without terminating execution.\n" +
    "STEP 3 - DB PURGE: Backed up swarm.db before touching anything; verified sizes matched.\n" +
    "STEP 4 - VERIFICATION: hivemind_stats confirmed 14 memories / 14 embeddings.";

  test("extracts ordered steps with build-order fact intact", () => {
    const proc = detectProcedure(result);
    expect(proc).not.toBeNull();
    expect(proc?.steps).toHaveLength(4);
    expect(proc?.steps[0].order).toBe(1);
    expect(proc?.steps[0].body).toContain(
      "swarm-queue -> swarm-mail -> opencode-swarm-plugin",
    );
    expect(proc?.steps[0].command).toBe("swarm doctor");
    expect(proc?.verified).toBe(true);
  });

  test("narrative without STEP markers is not detected as a procedure", () => {
    expect(detectProcedure("Did the thing, it worked.")).toBeNull();
  });
});
