---
"opencode-swarm-plugin": patch
"swarm-mail": patch
---

fix(swarm-mail): derive embedding chunk threshold from model context length

`MAX_CHARS_PER_CHUNK` was a hardcoded `24000`, roughly 12x the real 512-token
context window of `mxbai-embed-large`. Since the chunk-and-average fallback
only kicks in above that threshold, memories longer than the model's actual
window never triggered it — Ollama silently truncated them at embed time with
no error, no warning, and no way to tell from the API response. The tail of
any long memory was simply unsearchable.

`packages/swarm-mail/src/memory/ollama.ts` adds `MODEL_CONTEXT_LENGTHS` and
`getContextLength()` (mirroring the existing `MODEL_DIMENSIONS` /
`getEmbeddingDimension()` pattern), with an `OLLAMA_CONTEXT_LENGTH` env
override for custom models. `adapter.ts` now computes
`maxCharsPerChunk = getContextLength(model) * 3` per-model instead of using
the fixed constant, so the threshold stays correct if the embedding model
changes.

Also drops `total_chunks` from `SessionStats` in `session-indexer.ts` — it
was just `stats.memories` under a name implying chunk-level coverage that
doesn't exist (there's no chunks table).

`opencode-swarm-plugin` bundles `swarm-mail` into its CLI and marketplace
builds, so it needs a patch to ship the fix to those consumers.
