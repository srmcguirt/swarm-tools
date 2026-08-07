# doc-service

Portable documentation service. Reads project progress data and generates +
maintains four output types: runbooks, wiki/doc-site, blog, policy.

## Architecture boundary

```
source system (hive / git / jira / ...)
        │
        ▼
  SourceAdapter.extract()  ← the ONLY layer that knows where data came from
        │
        ▼
  DocumentationCorpus (normalized IR)  ← src/ir/types.ts
        │
        ▼
  generators (runbook / wiki / blog / policy)  ← sibling cells, not in this package
        │
        ▼
  docs/{runbooks,wiki,blog,policy}/**  ← front-matter marks generated vs authored
```

Generators, templates, and styling only ever import from `src/ir/types.ts`.
They never import a `SourceAdapter` implementation or a source-system client.

## Package location & portability

This lives inside the `swarm-tools` monorepo for build/test/publish
infrastructure that already exists here (turborepo, bun, changesets, the
`shared-types` / `swarm-mail` package conventions this package mirrors).

It has exactly one runtime dependency: `zod`. Nothing in `dependencies`
references any other package in this monorepo. That's deliberate — the
package can be `bun pm pack`ed and dropped into a standalone repo later
with no import surgery. The portability boundary is enforced by what's
*not* imported, not by directory location.

The real hive adapter (a sibling cell) lives in a package that depends on
`swarm-mail`; `doc-service` does not and must not depend on `swarm-mail`.

## Sanitization boundary

Internal coordination vocabulary (queue/coordination terminology, agent,
session, worker identifiers) has no field to occupy in the IR. `Provenance`
has one optional `author` field, and its contract (see `src/ir/types.ts`)
restricts it to real human/organization identities. The enforcement gate
(a sibling cell) is expected to plug in as a validation pass over a
`DocumentationCorpus` before it reaches any generator — reject or strip any
record whose `Provenance.author` or narrative text fields match a
denylist, rather than trying to scrub already-rendered markdown after the
fact.

## Generated-vs-authored files

See `src/templates/markers.ts`. A file is generator-owned if and only if
its YAML front-matter has `generated: true`. No marker = never touch.

## What's here vs. what isn't

Here: IR types, `SourceAdapter` interface + a no-op stub, project config
schema + validation, template directory scaffolding, the marker
convention.

Not here (sibling cells): the hive extraction adapter, the sanitization
gate, all four generators, tastemaker styling integration, regeneration
and drift detection.
