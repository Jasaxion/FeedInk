# Exact search: migration 010 and a hosted 10k comparison

**Unreleased, source-only implementation. Goal inactive; upgrade-review-hold remains.** This change has not been executed against PostgreSQL or benchmarked during implementation. Nothing here authorizes installation in preview, deployment, a 100k/1M run, or a speedup/capacity claim. Parent owns hosted execution, dependencies, CI integration and deployment. Do not run these workloads locally or against corporate/private/real-data services.

## Why these three indexes, without a query rewrite

The authorized 10k observation ([run 43832902441](https://github.com/Jasaxion/FeedInk/actions/runs/43832902441), benchmark SHA `4a5b73ac82f6c7204c789f131c0a412f26e6c934`) measured roughly 3–5ms non-search paging but 2.12–2.17s rare/absent search service calls. None of 150 plans used the existing `articles_search` FTS index. Rare/absent selection filtered roughly the entire 10k owner set. That run failed its API acceptance gate; its completed synthetic benchmark is diagnostic evidence, not accepted release/scale capacity.

API search is `owner AND (simple FTS OR title ILIKE literal OR content_text ILIKE literal)`. MCP is `owner AND (empty query OR title ILIKE literal OR url ILIKE literal OR content_text ILIKE literal)` and does **not** promise FTS. Migration `010_search_indexes.sql` adds:

- `articles_title_trgm`: GIN on the existing title column with `pg_trgm.gin_trgm_ops`.
- `articles_content_text_trgm`: GIN on the existing content text column.
- `articles_url_trgm`: GIN on the existing URL column, covering MCP's additional OR branch.

Every text-matching OR branch then has an available index; the planner can choose bitmap OR, optionally combined with owner indexes. This is eligibility, **not** a promise that any specific query will use a bitmap plan or get faster. MCP also binds an empty-query OR: a generic prepared plan may not simplify that branch and may still filter owner rows. The repeated actual SDK calls capture default-planner behavior; no speculative empty-query rewrite is bundled before hosted evidence. `articles_search` is retained unchanged. There is no stored vector, body relocation/table rewrite, normalization, minimum query length, approximate count, OR removal, external service or new application query. All exact totals, snapshots, owner/source filters, escaped `%`/`_`/backslash, multilingual and short queries, keysets, MCP's existing offset/tie order, and state/CAS code are unchanged.

Trigram indexes are not index-only reads: heap rechecks/TOAST decompression and FTS evaluation may remain. Queries without extractable trigrams (many one/two-character or punctuation patterns), common substrings and broad FTS terms can still examine much of the archive. An exact total cannot stop after one result page. GIN build scans, index bytes, WAL, disk space, content/URL write amplification and pending-list cleanup are costs, not free acceleration. Do not extrapolate realistic TOAST/media capacity from the highly compressible synthetic bodies.

## Extension and maintenance contract

`pg_trgm` files must exist on the PostgreSQL server, not merely on the client. Standard hosted PostgreSQL distributions normally ship them, but availability and permissions must be checked in the approved target. Preview has **not** been provisioned by this task.

Read-only operator preflight SQL (run only under separately approved access):

```sql
SELECT name, default_version, installed_version
FROM pg_available_extensions WHERE name = 'pg_trgm';
SELECT e.extversion, n.nspname AS extension_schema,
       has_schema_privilege(current_user, n.oid, 'USAGE') AS can_use
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname = 'pg_trgm';
SELECT current_user, current_schema(),
       has_database_privilege(current_user, current_database(), 'CREATE') AS can_create;
```

- If absent, 010 attempts `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`. Missing files/unsupported extension, missing public schema and insufficient privilege fail with actionable errors; there is no silent unindexed fallback. Trusted-extension support/CREATE permission varies with the server; a DBA may preinstall it instead.
- If already installed, 010 discovers its namespace through `pg_extension`, checks schema USAGE and the extension-owned GIN operator class, and quotes that namespace in index DDL. It does **not** move/update/drop the extension or change `search_path`. A non-public extension schema, including quoted names, is supported. The migration role must own the article table (or have equivalent DDL authority), and need not have CREATE EXTENSION permission if pg_trgm is already installed and usable.
- A DBA may preinstall into an existing trusted schema, e.g. `CREATE EXTENSION pg_trgm WITH SCHEMA approved_extensions;` and `GRANT USAGE ON SCHEMA approved_extensions TO migration_role;` using the actual approved identifiers. Do not grant untrusted users CREATE there; do not relocate an existing extension. These are instructions for a separately authorized operator, not commands executed by this change.
- Stop competing API/startup/worker/import writers; reserve a maintenance window and the separately approved backup/recovery boundary. The checksum runner in `apps/api/src/core.ts:migrate` applies 010 in one transaction, with `lock_timeout=5s`, `statement_timeout=15min` and a SHARE table lock. The three ordinary GIN builds share one DO-statement time budget and block writes. Other maintenance/DDL locks can delay acquisition; ordinary SELECT reads remain allowed. There is **no CONCURRENTLY** inside this transaction and no unconditional table rewrite.
- On failure, all three indexes and the 010 checksum roll back together; an extension newly created by that attempt rolls back too. A preexisting extension is untouched. Investigate blockers/space/privileges; do not repeatedly force the migration against live writers or fabricate checksum entries. An index-name collision fails rather than trusting an unknown preexisting definition.
- After success, run bounded `ANALYZE articles`, validate all four search indexes (`indisvalid`/`indisready`), inspect the plans and bytes, and retain additive indexes when rolling back compatible app code. Do not drop pg_trgm used by other schemas. Removal of indexes after committed installation requires a separately reviewed forward migration, not editing 010 or deleting checksum history.

The runner's outer advisory lock precedes 010's local settings. Use stopped competing migrations plus a process deadline/session statement timeout, not an assumption that 010 bounds that outer wait. For an **approved disposable hosted rehearsal** already migrated through 009, the existing runner can be invoked without starting HTTP/storage workers:

```bash
# TEST_DATABASE_URL and SEARCH_SCHEMA must identify the approved synthetic fixture.
# No credentials in command output; run only on the approved GitHub-hosted job.
timeout --signal=TERM 20m node --input-type=module <<'JS'
import postgres from 'postgres';
import { migrate } from './apps/api/dist/core.js';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || !process.env.TEST_DATABASE_URL || !process.env.SEARCH_SCHEMA) throw new Error('Require hosted synthetic fixture');
const db = postgres(process.env.TEST_DATABASE_URL, { max: 1, connection: {
  search_path: process.env.SEARCH_SCHEMA, statement_timeout: '30s', lock_timeout: '5s',
} });
try { await migrate(db); await db.unsafe('ANALYZE articles'); }
finally { await db.end({ timeout: 5 }); }
JS
```

## Exact regression hook (not run here)

`apps/api/test/search-indexes-postgres.test.ts` is additionally opt-in with `SEARCH_INDEXES_TEST=1`; without the flag, the approved hosted markers and `TEST_DATABASE_URL`, it skips. The hosted fixture account needs **CREATE DATABASE and CREATEROLE** (the existing disposable PostgreSQL service account is suitable), not production credentials. The test creates/drops two disposable databases and a NOLOGIN restricted role. It never moves/drops an extension in the supplied database.

Coverage authored:

- Seed through 009, snapshot populated API/MCP results before 010, invoke the real checksum runner, repeat the complete ordered paginated responses/totals for both owners. API walks both cursor directions with microsecond/tied timestamps; MCP uses its actual SDK callback via in-memory transport, not duplicated SQL.
- Empty/whitespace, case variants, FTS-only separated tokens, multilingual/one-character, `%`, `_`, backslash, compound escaped/decoy and absent patterns; URL-only MCP hits must remain absent from API search. Hand-checked escaped/FTS cases supplement before/after parity.
- Scope, feed/subscription, folder, tags/foreign tags, date bounds and cross-owner denial; full tuple/source JSON, `ctid`, `xmin`, heap relfilenode preservation; state/CAS/bulk exactness and counter audit.
- Fresh extension installation in public and an already-installed quoted non-public schema, with isolated app `search_path` excluding both. Restricted-role failure, real writer-lock timeout and a third-index name collision with no partial new indexes/checksum, valid four-index presence and checksum-runner idempotence.
- Forced **individual-branch indexability** plans on the tiny fixture. These are explicitly not default-planner or performance evidence. Missing server extension files are handled in migration SQL/preflight, not simulated by altering a hosted server installation.

After the parent-approved dependency install/build, use the hosted job only:

```bash
# No manifest/normal CI edit is part of this lane.
SEARCH_INDEXES_TEST=1 node --import tsx --test --test-timeout=180000 \
  apps/api/test/search-indexes-postgres.test.ts
# Also retain all existing integrated API/typecheck/browser/etc. gates separately.
```

## Same 10k benchmark first (not run here)

Keep the existing `scripts/scale-benchmark.mjs` fixture, hardware/container limits and budgets. Default `SCALE_SEARCH_INDEXES=before` retains the through-007 benchmark baseline; an application/public-schema migration does not install 010 into its fresh isolated benchmark schema. The intentionally historical benchmark schema still omits unrelated 009 AI tables; the regression test above covers integration through 009. No workflow or manifest changed here.

Parent integration hook for the existing manual `.github/workflows/scale.yml` **10k only** job:

```bash
# The existing approved GitHub-hosted environment supplies TEST_DATABASE_URL and RUNNER_TEMP.
SCALE_ARTICLES=10000 SCALE_SEARCH_INDEXES=compare \
  node --max-old-space-size=512 scripts/scale-benchmark.mjs
```

`compare` rejects other tiers. A normal workflow dispatch with no parent wiring of `SCALE_SEARCH_INDEXES=compare` will still run the old baseline, **not** the search comparison. Set `SEARCH_INDEXES_TEST=1` on a dedicated correctness step or API test step as appropriate. Keep the existing required API acceptance gate and 35-minute benchmark step timeout; publish only the allowlisted synthetic `report.json` under the existing explicit evidence opt-in. No automatic run or workflow approval is implied.

Report v2 retains the original 44 API read shapes/samples, with `stage=before/after`; comparison adds backslash/short ASCII probes and actual MCP common/rare/multilingual/short/literal/absent/URL searches for two owners. It runs before reads, a bounded rolled-back write probe, 010, ANALYZE, then the same reads on the same committed corpus. No new article content or state is committed between read stages.

Inspect:

- `reads[].stage`, latency, reference-count time and response size; `plans` carries actual captured SQL and default-planner `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. API before labels retain their original names; after labels start `after/`; MCP labels start `before/mcp/` or `after/mcp/`. No planner switches are forced in the benchmark. Count and page plans both matter. Check whether the three trigram indexes and existing FTS occur, bitmap combinations, rows removed/rechecked, heap blocks, buffers/temp I/O and execution time; retain no-use/slow plans as evidence.
- `searchIndexes.parity`: exact expected/actual totals, page lengths and SHA256 of the **whole ordered response**, including cursor/offset and item metadata, for every compared key. Any mismatch fails. This is bounded-page parity, not a million-row ordered traversal proof; the small regression fixture supplies complete traversal. MCP adds independent literal `strpos(lower(...))` reference counts and owned-item checks. API retains authoritative-count assertions and isolation tests.
- `phases.migration010IndexesMs`, `searchIndexes.before/afterBuild/afterWriteProbe/afterConcurrentWrites`: heap/index/TOAST and per-index bytes, plus database bytes. Sizes after the rollback probe can include dead-tuple/index work; they are not a clean index-only delta or a long-term bloat estimate.
- `beforeWriteCost/afterWriteCost`: 20 matching-shape INSERT/content+URL UPDATE/DELETE samples in a rolled-back transaction. Bodies are 95% ~2KiB / 5% ~32KiB compressible text. This measures bounded index/DML work, **not committed ingestion throughput**. `concurrent` separately reports committed ingestion rows/timings plus existing state/read samples and bulk timing, now with indexes present. No WAL/replication, realistic entropy/TOAST, cold-cache or sustained GIN pending-list/bloat/maintenance cost is measured.

Require completed workload evidence, all parity assertions, plans for rare **and** absent cases, no timeout/lock errors, acceptable measured write/index costs, and the independent hosted acceptance gates. Three-sample p95 and warm cache after the build are descriptive only. Do not infer that FTS/trigram coverage guarantees speedup: broad/short searches remain unavoidable scaling risks. If the 10k index-only remedy is insufficient, stop and return the measured evidence to the parent for a decision; do not add a stored vector/full rewrite or move on to 100k/1M without approval.
