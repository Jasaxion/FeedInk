# Exact search: migration 010, query shapes and hosted measurement

**Runtime and deployment-specific validation remain required.** Source authoring does not establish PostgreSQL or benchmark acceptance. Do not deploy or claim higher-tier capacity without reviewed results. Run the synthetic validation only on approved GitHub-hosted infrastructure, never against a real library.

## Index coverage and query-only follow-up

The authorized 10k observation ([run 43832902441](https://github.com/Jasaxion/FeedInk/actions/runs/43832902441), benchmark SHA `4a5b73ac82f6c7204c789f131c0a412f26e6c934`) measured roughly 3–5ms non-search paging but 2.12–2.17s rare/absent search service calls. None of 150 plans used the existing `articles_search` FTS index. Rare/absent selection filtered roughly the entire 10k owner set. That run failed its API acceptance gate; its completed synthetic benchmark is diagnostic evidence, not accepted release/scale capacity.

API search retains the union `owner AND (title ILIKE literal OR content_text ILIKE literal OR simple FTS)`. MCP uses `owner` for an empty query, otherwise `owner AND (title ILIKE literal OR url ILIKE literal OR content_text ILIKE literal)`; it does **not** promise FTS. Whitespace is a nonempty literal for MCP. Migration `010_search_indexes.sql` adds:

- `articles_title_trgm`: GIN on the existing title column with `pg_trgm.gin_trgm_ops`.
- `articles_content_text_trgm`: GIN on the existing content text column.
- `articles_url_trgm`: GIN on the existing URL column, covering MCP's additional OR branch.

Every text-matching OR branch has an available index; the planner can choose bitmap OR, optionally combined with owner indexes. This is eligibility, **not** a promise that a query will use a bitmap plan or get faster. `articles_search` is retained unchanged.

The subsequent [10k comparison, run 43839381661](https://github.com/Jasaxion/FeedInk/actions/runs/43839381661) matched all 66 bounded-page parity keys. Rare/absent API calls fell to roughly 1–7ms, but broad/short/literal calls reached 3–4.4s. Actual rare/absent MCP callbacks still took roughly 0.53–0.55s despite sub-millisecond unprepared replays. Its unrelated API/browser acceptance gates failed. That evidence justifies two small query-only changes, not a release or capacity claim:

- Put title/content literal predicates before per-row `to_tsvector` evaluation, keeping the same FTS union and indexable OR. A literal hit can avoid vector construction in a filter, but SQL does not guarantee evaluation order and the chosen plan still needs measurement. No CASE wrapper or FTS-only semantics loss.
- Separate MCP empty/browse and nonempty statement shapes; remove the bound `query=''` OR that cannot be eliminated by a generic nonempty plan. MCP does not force a custom plan. Article search requests use transaction-local `plan_cache_mode=force_custom_plan` after a measured warm-query sequence regressed rare searches despite indexed replay plans; the setting resets at transaction end and does not affect non-search or MCP requests. No global `prepare:false` is used. Measure actual callbacks rather than inferring their plans from a separate replay.

There is no stored vector, table rewrite, normalization, minimum query length, approximate total, external engine or data migration in this follow-up. Exact totals, API snapshots, owner/source filters, escaped `%`/`_`/backslash, multilingual/short/FTS-only semantics, microsecond keysets, MCP's existing offset/tie order and state/CAS code remain unchanged. Prepared diagnostics below distinguish actual callback executions from separately replayed plans.

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
- One additional `articles.selection`/`mcp.search_articles` subtest (public-extension fixture only): five focused API witnesses compare the new shape to the original FTS-first predicate; eleven actual SDK callbacks compare exact ordered DTOs, totals and offsets to the original MCP predicate. Six repeated common calls cross the initial custom-plan sampling window; empty and whitespace remain distinct. Emitted count/page shapes and same-backend prepared execution counts are asserted, not latency or planner choice. No new traversal matrix.

After the approved dependency install/build, use the hosted job only:

```bash
# The hosted verify/scale jobs set this opt-in for the disposable database tests.
SEARCH_INDEXES_TEST=1 node --import tsx --test --test-timeout=180000 \
  apps/api/test/search-indexes-postgres.test.ts
# Also retain all existing integrated API/typecheck/browser/etc. gates separately.
```

## Benchmark modes and workflow inputs

Keep the existing `scripts/scale-benchmark.mjs` fixture, hardware/container limits and budgets. Default `SCALE_SEARCH_INDEXES=before` retains the through-007 benchmark baseline; an application/public-schema migration does not install 010 into its fresh isolated benchmark schema. The intentionally historical benchmark schema still omits unrelated 009 AI tables; the regression test above covers integration through 009. All modes run the checked-out application query code: **before means pre-010 indexes, not a historical query implementation**. Reports add `queryVariant=literal-first-mcp-split-v1`; compare fixed-SHA artifacts to evaluate the query change rather than calling the within-run index comparison a query A/B test.

| Environment | Meaning |
| --- | --- |
| `SCALE_ARTICLES=10000\|100000\|1000000` | Primary-owner size; isolation owners and original budgets retained. |
| `SCALE_SEARCH_INDEXES=before` (default) | Historical unindexed mode, no MCP matrix by default. |
| `SCALE_SEARCH_INDEXES=compare` | Historical same-corpus pre/post-010 comparison, **10k only**, including 66 exact API/MCP parity keys. |
| `SCALE_SEARCH_INDEXES=indexed` | Install 010 and ANALYZE **before reads** at any allowed tier, including 100k/1M. API and two-owner MCP reads, independent counts/isolation and existing concurrency/bulk/audits retained. `stage=indexed`; parity array is empty, not an invented before/after comparison. |
| `SCALE_MCP_PREPARED=1` (default off) | Small opt-in reserved-backend callback/plan diagnosis in the selected stage(s). Only `0`/`1` accepted when set. |

Both `scale.yml` entry points accept `search_mode` (`indexed`, `compare`, or `before`, default `indexed`) and `mcp_prepared` (default false). `ci.yml` forwards `scale_search_mode` and `scale_mcp_prepared`; the legacy `compare_search_indexes` flag still selects comparison and takes precedence. Keep the separate evidence-publication opt-in. `compare` is 10k only; use `indexed` for larger tiers or `all`. These workflow inputs are already wired; no operator source edits are needed.

The manual `.github/workflows/scale.yml` **10k-only comparison** executes:

```bash
# The existing approved GitHub-hosted environment supplies TEST_DATABASE_URL and RUNNER_TEMP.
SCALE_ARTICLES=10000 SCALE_SEARCH_INDEXES=compare \
  node --max-old-space-size=512 scripts/scale-benchmark.mjs
```

`compare` rejects other tiers. Existing dispatches remain `ci.yml` with `scale_tier=10000,compare_search_indexes=true`, or `scale.yml` with `tier=10000,search_indexes=true`. The workflows set `SEARCH_INDEXES_TEST=1`, retain the required API acceptance gate and 35-minute benchmark deadline, and publish only the allowlisted synthetic `report.json` when evidence publication is explicitly selected. A published diagnostic report is not release approval.

The larger-tier invocation is `tier=100000` (then `1000000`), `search_mode=indexed`, `search_indexes=false`; opt into `mcp_prepared=true` if needed. Equivalent hosted step:

```bash
SCALE_ARTICLES=100000 SCALE_SEARCH_INDEXES=indexed SCALE_MCP_PREPARED=1 \
  node --max-old-space-size=512 scripts/scale-benchmark.mjs
```

No local or larger-tier workload was run by this author. Existing 10s statements, 120s ANALYZE, 15min migration, 30min wall and memory/database budgets are not silently raised for 1M. A timeout/failed MCP callback/incomplete report is a limit to report, never capacity acceptance.

Report v2 retains the original 44 API read shapes/samples, with `stage=before/after`; comparison adds backslash/short ASCII probes and actual MCP common/rare/multilingual/short/literal/absent/URL searches for two owners. It runs before reads, a bounded rolled-back write probe, 010, ANALYZE, then the same reads on the same committed corpus. No new article content or state is committed between read stages.

Inspect:

- `reads[].stage`, latency, reference-count time and response size; `plans` carries captured SQL and `provenance=unprepared-replay` for separate `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` executions with `prepare:false`, not the prepared plan used by the timed callback. API before labels retain their original names; after labels start `after/`; MCP labels start `before/mcp/` or `after/mcp/`. No planner switches are forced in the benchmark. Count and page plans both matter. Check whether the three trigram indexes and existing FTS occur, bitmap combinations, rows removed/rechecked, heap blocks, buffers/temp I/O and execution time; retain no-use/slow plans as evidence.
- `searchIndexes.parity`: exact expected/actual totals, page lengths and SHA256 of the **whole ordered response**, including cursor/offset and item metadata, for every compared key. Any mismatch fails. This is bounded-page parity, not a million-row ordered traversal proof; the small regression fixture supplies complete traversal. MCP adds independent literal `strpos(lower(...))` reference counts and owned-item checks. API retains authoritative-count assertions and isolation tests.
- `phases.migration010IndexesMs`, `searchIndexes.before/afterBuild/afterWriteProbe/afterConcurrentWrites`: heap/index/TOAST and per-index bytes, plus database bytes. Sizes after the rollback probe can include dead-tuple/index work; they are not a clean index-only delta or a long-term bloat estimate.
- `beforeWriteCost/afterWriteCost`: 20 matching-shape INSERT/content+URL UPDATE/DELETE samples in a rolled-back transaction. Bodies are 95% ~2KiB / 5% ~32KiB compressible text. This measures bounded index/DML work, **not committed ingestion throughput**. `concurrent` separately reports committed ingestion rows/timings plus existing state/read samples and bulk timing, now with indexes present. No WAL/replication, realistic entropy/TOAST, cold-cache or sustained GIN pending-list/bloat/maintenance cost is measured.

### Prepared diagnostic provenance

With `SCALE_MCP_PREPARED=1`, `mcpPrepared[]` records a reserved PostgreSQL backend PID, `planCacheMode`, inherited `initialStatements`, eleven timed actual SDK callbacks (empty, six common, two rare, absent, empty), response digest parity, and `pg_prepared_statements` generic/custom counts before/after **each** callback. Count and page statements must each increment exactly once on that backend. Inherited cache history is explicit; no DEALLOCATE or planner override is used. Timings exclude counter/plan inspection and are in-memory SDK service timings, not HTTP/auth/network.

After all timed callbacks, four `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE` probes (rare/absent × count/page) use the **actual named callback statements on the same reserved backend**. `mcpPrepared[].explains[].provenance=same-connection-explain-execute`; each probe has its own bracketing counters. They are extra executions that may advance plan history, **not** retroactive captures of timed callback plans. All existing `plans[]` remain labelled `unprepared-replay`. Compare actual counter deltas, named EXECUTE plans and separately labelled replays before proposing targeted custom planning; generic counts alone do not prove a harmful plan. The optional diagnostics add time and warm-cache work; record the flag when comparing runs.

Require completed workload evidence, all applicable parity/count assertions, plans for rare **and** absent cases, no timeout/lock errors, acceptable measured write/index costs, and the independent hosted acceptance gates. Three-sample p95 and warm cache after the build are descriptive only. **Short/broad searches retain intrinsic exact-count costs**: neither predicate ordering nor the MCP shape split avoids visiting every matching row for an exact search total, and no-extractable-trigram/FTS-only cases may still inspect body/TOAST data across the owner set. These changes are not a measured speedup until approved hosted evidence says so. Return limits to the parent; do not respond with a speculative stored vector/full rewrite, approximate totals or external engine.
