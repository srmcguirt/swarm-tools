---
"opencode-swarm-plugin": patch
"swarm-mail": patch
---

## 🐝 Six More Rooms With No Door

**What changed** (`packages/swarm-mail/src/db/schema/memory.ts`), same mechanism as the earlier `status` fix — Drizzle's SQLite dialect binds `.default()` as a client-side insert parameter whenever a column is omitted from `.values()`, ignoring the table's real DDL default:

- **Class A (literal quote characters):** `metadata` (`.default("'{}'")`), `collection` (`.default("'default'")`), `tags` (`.default("'[]'")`) all had the surrounding SQL quote marks baked into the JS default string itself, so omitted columns got the quotes written in as literal data.
- **Class B (unwrapped raw SQL, worse):** `created_at`, `updated_at`, `last_accessed` defaulted to the *string* `"(datetime('now'))"` instead of `` sql`(datetime('now'))` ``. Drizzle only inlines a column default as a raw SQL expression when it recognizes the value as a Drizzle `SQL` object (confirmed by reading `sqlite-core/dialect.cjs` in the installed `drizzle-orm@0.41.0`); a plain string gets bound as a literal parameter instead. Every omitted-column insert wrote the 18-character text `(datetime('now'))` into a timestamp column — not a date at all.

**Verified against live data, not just the compiled bundle this was originally inferred from:** all 14 rows in the real production DB confirm the predicted risk ranking exactly. `store()` explicitly sets `metadata`/`collection`/`created_at` on every call, so those three defaults are dead code under current usage — never actually fired, all 14 rows are clean. `tags`/`updated_at`/`last_accessed` are omitted by `store()` on every call, so all 14 rows carry the corrupted `'[]'` / `(datetime('now'))` literal values.

**Functional impact today:**
- `tags` (the top-level `memories.tags` column, distinct from `metadata.tags`): corrupted on every row, but nothing in the current codebase reads this column directly — `sync.ts` exports/imports via `metadata.tags`, not this one. Cosmetic today; a trap for any future code that reads it.
- `updated_at`: corrupted at creation, only ever rewritten by `supersede()`. Nothing currently sorts/filters on it (only `created_at` is used for ordering) — cosmetic today, but stays wrong forever for any row that's never superseded.
- `last_accessed`: corrupted at creation, but self-heals — `trackAccess()` does a raw SQL `UPDATE`. Until first tracked access, decay-tier filtering (`datetime(m.last_accessed) >= datetime('now','-7 days')`) evaluates `datetime()` on the literal string, which SQLite returns `NULL` for, so never-accessed memories silently drop out of `hot`/`warm` tier queries and only surface under `decayTier: "all"`. This is the one bug class with live, verified functional impact right now.

**Migration: recommended, not implemented.** Existing rows written by pre-fix installs carry the corrupted literals. A one-time normalization backfill would be simple and idempotent:
```sql
UPDATE memories SET tags = '[]' WHERE tags = '''[]''';
UPDATE memories SET updated_at = created_at WHERE updated_at = '(datetime(''now''))';
UPDATE memories SET last_accessed = created_at WHERE last_accessed = '(datetime(''now''))';
```
Priority: low for `tags`/`updated_at` (dead columns today), worth doing for `last_accessed` if `hot`/`warm` decay-tier queries matter for pre-fix rows. Left as a follow-up decision rather than bundled into this patch, since it touches live data and this fix's own regression tests already cover the write-side behavior going forward.

**Backward compatible:** yes. New writes are correct going forward; old corrupted rows are untouched unless the backfill above is run separately.

```
    ,-.__,-.
   ( o     o )   six columns, same trick: quote the default,
    \   ^   /    or forget to wrap it in sql``.
     `-----'     store() only ever exercised half of them.
```
