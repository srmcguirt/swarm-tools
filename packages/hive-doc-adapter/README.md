# hive-doc-adapter

`SourceAdapter` implementation (see `doc-service`) that reads hive cells and
git history and emits a normalized `DocumentationCorpus`. This is the only
package allowed to know hive's or git's shape — see
[`doc-service`'s architecture boundary](../doc-service/README.md).

Separate package from `doc-service` on purpose: `doc-service` has exactly
one runtime dependency (`zod`) so it can be lifted out standalone later.
This package depends on `@libsql/client` (to read hive) and `doc-service`
(for the IR types + `SourceAdapter` contract) — never on `swarm-mail`. The
real `swarm-mail` `HiveAdapter` interface pulls in drizzle-orm, effect,
ai-sdk, and chokidar; none of that is needed to read cells, so this package
talks to the known `beads`/`bead_*` schema directly with raw SQL and stays
read-only by construction (grep the codebase: no INSERT/UPDATE/DELETE
statement exists anywhere in `src/`).

## Modules

- `hive-reader.ts` — raw, read-only `@libsql/client` queries against the
  hive schema. Never stock `sqlite3`: the `memories` table has a native
  libSQL vector index, and a plain sqlite3 driver's `COUNT(*)` against it
  silently returns 0 (this already produced one false total-data-loss
  report in this project's history — see the DB-isolation incident
  extracted in `src/e2e.test.ts`). `getMemoryCount()` uses `COUNT(id)`.
- `git-reader.ts` — shells out to `git log` for commit history. No git
  library dependency.
- `narrative.ts` — structural parsing of closure narratives into
  Decision/Incident/Procedure shapes (`ROOT CAUSE:`/`Fix:`/`Acceptance
  gate:` sections, `STEP N -` markers, `User decision:` markers). Heuristic
  detectors, not a classifier: a cell that matches none of them still
  becomes a plain `WorkItem`.
- `register.ts` — internal coordination vocabulary → external prose. See
  the module doc comment for the full approach and its justification
  (deterministic term-stripping + curated structural rewrite templates,
  not an LLM pass — testability and fact-preservation over prose polish).
- `mapper.ts` — raw cell/commit rows → IR records, applying `register.ts`
  translation to every free-text field that reaches the corpus.
- `hive-adapter.ts` — `createHiveAdapter(config): SourceAdapter`, the
  public entry point.

## Register translation: the approach, and why not an LLM

Hive cell text is written by and for AI coordination agents — swarm,
worker, coordinator, cell, subtask, agent, session, plus generated agent
codenames (DarkOcean, WarmFire, ...). None of that has a field in the IR
and none of it should reach generated output.

**Chosen approach: deterministic term-stripping + a small curated set of
structural rewrite templates.** Not an LLM rewrite pass. Reasons:

1. **Testability.** This has to be assertable with a fixed input/output
   pair in CI. An LLM call is not reproducible run-to-run, which breaks
   the sibling drift-detection cell — regeneration against the same
   source data has to be idempotent.
2. **Fact preservation is the hard constraint, not prose quality.** The
   brief is explicit: losing "23.79ms vs 38.64ms" is not acceptable. A
   generative rewrite can silently paraphrase or drop a number, a flag, a
   path. A substitution/regex pass structurally cannot touch anything
   outside its pattern set — numbers, commands, paths, commit shas are
   never in the pattern set, so they survive by construction, not by
   hoping the model behaves.
3. **Cost/latency at extraction-layer scale.** This runs over every cell
   in a hive project on every extraction. A regex pass is free; an LLM
   call per record is not, and doesn't need to be for this problem.

**Honest limitation:** this is not a general-purpose passivizer. It
handles the verb/sentence shapes actually observed in this corpus (see
`register.test.ts`, all fixtures pulled from real cells) plus the shapes
given in the extraction brief. An actor-led sentence with a verb outside
the known list falls through to a generic subject-drop rule — leakage-safe
(no process noun survives; verified by `hasLeakage()` against every
extracted field in `e2e.test.ts`) but may read as a sentence fragment
rather than polished prose. If that turns out to be common at larger
corpus scale, the fix is to grow the verb/template table (keeps the
transform deterministic and testable), not to reach for an LLM. Generators
downstream are free to do further light editing; extraction's job is
"never leak, never lose a fact," not "publication-ready prose."

The genuinely hard part of this translation is disambiguating the process
noun "swarm" (an actor: "the swarm scaffolded X") from the literal package/
file names that legitimately contain the substring ("swarm-mail",
"swarm.db", "swarm_complete"). `register.ts` handles this with code-adjacency
checks (hyphen/underscore/dot/backtick-adjacent occurrences are left alone)
plus explicit preservation of inline code spans (`` `like this` ``).

## Sanitization boundary

This package's job is register translation at the point where a fact
enters the IR — not final enforcement. The sibling sanitization-gate cell
is the authoritative policy check over an assembled `DocumentationCorpus`
before it reaches any generator. `register.ts` exports `hasLeakage()` as a
cheap self-check (used throughout this package's own tests) covering the
unambiguous actor/mechanism nouns (swarm, worker, coordinator, subtask,
agent); it does not attempt to resolve every ambiguous case (e.g. "cell"/
"bead" as schema-table-name-in-a-code-span vs. work-item-noun-in-prose) —
that's the sanitization gate's job, with the full corpus and the full
denylist policy in view.

## Verified against real data

`src/e2e.test.ts` runs the real adapter against the live hive database
(read-only, skipped automatically if the DB isn't present) and asserts:

- the doc-service epic (`katas--w5hg2-msj0nhchrv2`) and its closed
  foundation task extract with a translated, leakage-free closure
  narrative that still contains the real commit sha (`b9ab4f4`)
- the fork-maintenance epic (`katas--w5hg2-msibq790p0r`) is extracted as
  *both* a `Decision` (adopted, evidence-free — no numeric benchmark was
  cited in that particular decision) *and* a `Procedure` (4 verified
  steps, including the literal build-order fact `swarm-queue ->
  swarm-mail -> opencode-swarm-plugin`)
- the DB-isolation incident (`katas--w5hg2-msie1245wre`) extracts a
  root cause, fix, and verification with `getDatabasePath()`,
  `bunfig.toml`, `afterEach`, and the `14 memories/14 embeddings`
  verification count all intact and leakage-free
- git commit history populates `TimelineEvent`s with real author names in
  `Provenance.author` (the one place a real human identity is legitimate)

No test, script, or code path in this package performs a write against
`swarm.db`. Confirmed via direct `COUNT(id)` + md5 before/after running the
full test suite (see extraction report).
