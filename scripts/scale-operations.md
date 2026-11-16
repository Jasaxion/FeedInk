# Exact counter cutover and hosted scale rehearsal

Unreleased source-level design. No benchmark or PostgreSQL validation was executed during implementation. This is not a million-article performance guarantee. Parent integration and hosted review gates must pass before deployment.

## Exactness and query contract

Migration `007_scale_queries.sql` installs `article_counts`, a transactionally maintained projection of article membership/state. Keys are `(user_id, tag_key, feed_key)`: empty tag means all articles, UUID tag means that tag; `*` feed means all feeds, empty feed means feedless, UUID feed means that feed. UUIDs cannot collide with the markers. Each populated dimension stores total, unread and saved. Zero buckets may remain; reconciliation treats missing and zero buckets equivalently. Storage grows with populated owner/feed/tag combinations, not a row per article.

The account/archive/saved total and sidebar tag totals read aggregate buckets. All/unread totals, feed/folder and tag intersections sum only feed buckets joined to current owned subscriptions. Unsubscription does not delete history, and subscription moves, metadata changes, new subscriptions, OPML and folder deletion need no archive recount or counter delta. This design deliberately avoids maintaining a separately cached subscribed-total that could race subscription changes. Metadata work can still grow with the number of feeds and populated tag/feed combinations.

All list responses retain an exact `total`, independent of the cursor. Literal/FTS search and date-bound counts keep the original authoritative predicate and exact aggregate. Literal wildcard escaping and multilingual fallback are unchanged. Valid tag UUID inputs are lowercased only for the text counter key; uppercase/mixed-case request spellings retain PostgreSQL UUID equality semantics, and the empty base-dimension marker stays empty. No trigram extension or speculative search index is installed: common-term exact substring searches can still require archive-sized work.

List/state projections omit body/fulltext/content-text columns. Detail still reads bodies. Tag hydration joins a stored tag aggregate rather than counting a tag population for every article. Maps avoid repeated in-process row searches. Count-backed page/sidebar/detail reads use repeatable-read read-only transactions, including hydration, on the same reserved transaction connection. An in-flight response is exact at its snapshot; this is not a promise of the latest commit after the response started.

Bulk state writes remain one atomic UPDATE with the same selection/cursor and version semantics. Matching already-equal states still increment versions and contribute to `updated`; the driver command count replaces archive-sized `RETURNING id` arrays. This bounds application acknowledgement memory, **not PostgreSQL write/WAL/lock work**. No hidden chunking or asynchronous job contract was introduced.

## Mutation coverage and supported boundary

Database triggers cover supported application INSERT/UPDATE/DELETE paths, including ingest, save URL, demo seeding, portable archive imports, conflict-skipped duplicates, tag replacement, article deletion, user cascades and bulk writes. Before deleting articles/tags, memberships are removed while their parent context still exists, so FK cascade ordering cannot lose the old owner/feed/state. Membership writers lock the article before changing its counters; their deltas run AFTER the write, so `ON CONFLICT DO NOTHING` does not count skipped rows. Feed deletion removes empty feed slices; a missing/deleted owner is never recreated by a cascade. Read/saved/feed/owner changes update the relevant dimensions. Progress, body/fulltext and metadata-only article changes do not touch counter tuples. Tag ownership mismatches are rejected for membership writes and article-owner transfers with retained foreign tags.

Counts are exact for supported transactional application DML. Arbitrary privileged changes that disable triggers, modify counter tables, change ownership metadata outside supported APIs, or restore only some tables cannot be detected without an authoritative scan. Every owner requires a validity marker; missing/invalid markers fail count-backed reads with `503 COUNTS_UNAVAILABLE`. Body ownership and annotation/content paths not requiring counters remain available; the existing detail DTO includes tag counts, so detail is count-backed. Constraints reject negative/impossible counts. Positive corruption is detected by the authoritative audit, not by scanning every ordinary response. Never treat a privileged trigger-bypassing restore as an ordinary application write.

Count-changing application transactions share `coordinateArticleWrites`: a transaction advisory lock derived from the canonical owner UUID (hash seed 71244005). It exists even for an empty owner with no counter bucket and normalizes UUID spelling before hashing. The required order is **global blob lock, if needed → owner coordination → metadata/existing article/membership locks → trigger counter rows**. The callback acquires coordination inside the transaction, not in a preflight that releases early. Compatible mixed writers must finish without deadlocks; rollback safety alone is not acceptance. No transparent API retry policy is introduced.

Connected writer audit:

- State/tag patches and atomic bulk updates coordinate before row locks; progress-only patches remain exempt because their trigger delta is empty and hydration is read-only.
- Portable import coordinates FIRST inside `Store.writeTransaction`, after the global blob lock and before folder/feed/tag upserts or duplicate/source probes. Existing duplicate/article/image/source locks and insert-only annotation revision checks are retained. Mixed duplicate/new imports remain atomic.
- Demo seeding uses the same first-in-blob-callback order. Failed-demo cleanup in auth remains unchanged: it deletes an unpublished account after the blob transaction has unwound, before any session is published.
- Feed subscription metadata is committed under coordination before refresh acquires per-feed locks or later blob locks. Each ingest transaction coordinates before its duplicate/quota probe and insert; it commits before icon/image blob work. OPML folder creation coordinates in its own existing bounded unit.
- App subscription/folder/tag mutations, including tag deletion cascades, coordinate before their metadata write. Save-URL duplicate/quota/insert work is one coordinated transaction that commits BEFORE extraction or later blob capture. There is no `Content.save` count writer in this source snapshot.
- Content/fulltext-only and image-cache paths do not change article membership/read/saved counters and gain no unnecessary owner lock. Annotation editor/source locks are unchanged. Standalone feed-status/icon updates never retain a metadata row lock while acquiring owner coordination later.
- Auth admin disable updates no article counters and takes no article locks; unpublished demo cleanup is the only application user deletion in the inspected source. Operator/raw-SQL deletes, bypass writes, and maintenance require their documented fence and are not substitutes for supported application race coverage.

Counter rows still serialize owner/tag changes, and metadata coordination also serializes these application writers per owner. Throughput/write amplification need hosted measurements. Deadlock/serialization errors from privileged raw DML, maintenance overlap, or incompatible source deletion must roll back completely; supported compatible application operations are tested without accepting `40P01`. AI parent-lock compatibility is a separate integrated worker change, not supplied by this lane.


## Maintenance-window deployment / backfill

1. Validate the integrated branch on approved GitHub-hosted infrastructure, including existing API/annotation/archive acceptance and new scale tests. Rehearse the target tier; inspect migration duration, index/counter bytes, locks and plans. The existing checksum migration runner must apply 007; never edit applied migrations.
2. Take the separately approved consistent database/blob backup and preserve the original. Schedule downtime; stop API, workers, imports and other writers. The normal startup migration is **not** an online zero-downtime index deployment.
3. Apply 007 through the existing migration runner. It uses `lock_timeout=5s`, `statement_timeout=15min`, and ACCESS EXCLUSIVE maintenance locks, installs triggers, reconciles the existing corpus, and builds ordinary transactional indexes. There is no `CREATE INDEX CONCURRENTLY` inside the runner. Backfill and schema changes commit together; timeout, invalid ownership data or any error rolls back the complete migration. Investigate blockers rather than repeatedly forcing it against live traffic. A 15-minute bound is a cap, not a predicted duration; a larger deployment window requires a reviewed deployment plan, not editing a migration already applied elsewhere.
4. Before reopening traffic, run the audit in a new bounded maintenance transaction and require zero affected owners. Keep all new triggers and validity rows intact. The manual hosted benchmark rehearses the full 006→007 backfill/index SQL against synthetic populated data; it is not the production migration runner or a private-data migration tool.
5. For rollback after a successful cutover, keep additive tables/triggers/indexes and roll back compatible application code only after review. Do not drop counters while new code is serving. Existing old code writes still execute DB triggers. Roll back a failed migration by its transaction; do not fabricate migration checksums. Backups remain the recovery boundary for a destructive operator action.

The runner's existing outer migration advisory lock is unchanged and can still wait independently of 007's table-lock timeout. Stop competing startup/migration processes first and use an operator process deadline. This lane did not change `core.ts` or its locking contract.

## Reconciliation and privileged maintenance

These functions are operator SQL, not unauthenticated HTTP endpoints. Commands below describe an approved maintenance operation; this task authorizes **no production execution**. Hosted synthetic wrappers are `node scripts/scale-counters.mjs audit|rebuild|invalidate`, which reject non-GitHub-hosted environments and use only `TEST_DATABASE_URL`.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SELECT scale_audit_counts();
COMMIT;
```

The return value is the number of affected owners, not counter rows. Audit locks source/counter/validity tables before comparing both sides and invalidating, so legitimate concurrent commits cannot cause false drift and rebuild cannot race it. **Commit the audit even if it reports drift** so invalidation is durable. Do not throw inside and roll back the audit transaction merely because its returned value is nonzero. The wrapper sets a failing exit status only after committing. It intentionally never repairs silently.

Repair in the stopped-writer window:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SELECT scale_rebuild_counts();
SELECT scale_audit_counts(); -- must return 0 before reopening traffic
COMMIT;
```

Rebuild takes the same locks, rejects foreign-owner tag memberships, replaces counters from authoritative aggregates, and recreates/revalidates every owner marker atomically. The source rows/bodies/images/annotations are not rewritten. A timeout rolls back, retaining the previous counters/invalid markers. Audit/backfill intentionally scan the archive and may spill aggregate work to PostgreSQL temp storage; provision and monitor the maintenance window.

Before **any** deliberately trigger-bypassing load, partial restore or privileged repair: stop writers/readers, lock the same source tables, mark affected owners invalid and commit that fence before bypassing triggers. Preserve invalidation throughout the operation; restore triggers, rebuild and audit before reopening count-backed reads. An empty target restore must also restore/create validity rows consistently. `TRUNCATE articles/article_tags` invalidates surviving owner markers, but arbitrary direct counter manipulation still requires the operator fence. Full physical PostgreSQL restore includes counter tables and triggers; partial logical restore must follow this protocol.

## Added index rationale

- `articles(user_id,feed_id,published_at,id)`: feed timeline keysets; existing owner timeline retained.
- Owner timestamp/id partial indexes for unread and saved: selective common timelines; state changes pay index maintenance cost.
- `article_tags(tag_id,article_id)`: reverse membership lookup and tag deletion.
- `images(article_id,id) WHERE status='pending'`: sparse/empty global and feed-scoped queue probes with stable ordering. No new worker concurrency or durability lock changes.
- Non-null image/ebook file keys and feed icon keys: blob-reference existence probes, including recovery misses. No storage lifecycle redesign.
- Session expiry: worker cleanup avoids unindexed expiry filtering at larger session counts.

No index is claimed universally beneficial from inspection. Hosted EXPLAIN/BUFFERS and index/TOAST bytes must justify write amplification, particularly read/saved transitions. No archive ZIP bounds were removed. Portable export now performs a same-snapshot count over at most 1001 rows before serializing any article body, retaining the 1000-article cap and original ARCHIVE_LIMIT error. Remaining MCP/annotation offset paths, large atomic bulk jobs, global worker/blob locks and connection reservation remain separate measured/reviewed work.

## Hosted-only bounded benchmark and integration

Manual workflow `.github/workflows/scale.yml` targets `ubuntu-24.04` GitHub-hosted runners only. Parent must approve execution. Tiers are 10k/100k/1M articles **in one owner**, plus ten isolation owners (up to 10k each). Fixed synthetic seed, RFC-format custom UUIDv8 article/image IDs from the shared `scale-seed-ids.sql` mapping, skewed feeds/tags, feedless/unsubscribed rows, timestamp groups with microsecond subgroups, common/rare/short/multilingual/literal/no-hit searches, date filters, first/deep-90% keysets, state writes, bounded inserts, CAS correctness tests and counter audits are authored. Bodies are deliberately compressible; there are no real blobs/annotation contexts, so storage durability/backup performance is not measured here.

Before expensive seeding, the benchmark validates sampled mapped article/image/metadata UUIDs and both cursor directions with the actual request validator. Article-tag and image references reuse exactly the same mapping; deep boundaries are validated again. `completed-with-limits` remains incomplete workload evidence, not acceptance.

The benchmark calls the article service directly; its latency samples are not end-to-end HTTP timings. Separate API route tests cover HTTP integration. The script records migration/backfill+index time, plans from actual count/page/hydration SQL using `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, reference exact-count cost, response bytes, table/index/TOAST and database sizes, warm p50/p95 descriptions (only three samples), concurrent read/state timing, transient retries, CPU/RSS usage, hardware/PostgreSQL settings and per-case limits. Ten isolation owners get exact-total, foreign-tag/subscription and foreign-detail denial probes. Sparse/empty pending queues and blob-reference misses are explained. It never explains a mutating UPDATE as if it were read-only.

Budgets: 30-minute script wall guard (35-minute workflow step hard cap), 10-second ordinary statements, 120-second seed batches, 15-minute maintenance statement, 16GiB schema size, sampled 768MiB Node RSS with 512MiB V8 old-space cap, PostgreSQL container 6GiB/2 CPU, 120-second contention phase with at most 200 state writes, 100 inserts, 100 reads and one <=10k-row atomic bulk call. Client seed batches hold no article arrays. There is one warmup and three samples per selected case; statement-limit failures remain in the report, never silently counted as passes. No cold-cache claim, universal latency target, full production workload or million-scale success is inferred.

Structured synthetic evidence is written only to the hosted runner temp directory. Publishing that allowlisted JSON artifact requires the explicit manual `publish_evidence` input (default false). No raw logs, credentials, deployment data, source captures or private paths are written to the repository.

No new npm dependencies or manifest edits are required. Existing `postgres`, `tsx` and TypeScript suffice. Parent may add optional root scripts:

- `scale:benchmark`: `node --max-old-space-size=512 scripts/scale-benchmark.mjs`
- `scale:counters`: `node scripts/scale-counters.mjs`

The existing API test glob already discovers the `scale-*-postgres.test.ts` files; they additionally refuse execution outside approved hosted CI. Build the integrated workspace first. `app.ts` now calls `new Store(config.dataDir, config.storage)` as assigned; storage lane must supply `Config.storage` and the constructor before the build. AI app wiring remains parent-owned. Normal `ci.yml`, manifests, DTOs, storage, annotations and archive source are unchanged.

Review-followup coverage is authored in `scale-writer-order-postgres.test.ts`: actual atomic mixed [duplicate A,new B] imports with/without annotated A versus state/bulk, plus actual tag-delete routes versus state/tag patches. Two worker connections use explicit query barriers and PostgreSQL lock-state observation, not scheduling sleeps or a deadlock whitelist; import barriers retain the production duplicate lock and verify blob-before-owner order. Tag barriers hold the tag/member-article prefix of the deletion trigger before its counter delta. Both requests must complete, then counters, CAS versions, source bytes/identity and annotation revisions are checked. The same file covers early archive eligibility and seed UUID/cursor mapping. Uppercase/mixed-case tag scope/intersection/cursor parity and a real trigger-bypass audit/rebuild test extend `scale-queries-postgres.test.ts`. All new coverage still requires approved hosted execution and fresh independent review.
