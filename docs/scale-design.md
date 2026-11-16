# Million-article development contract

Unreleased implementation/verification contract, not a measured capacity claim.

The target is **one account with one million articles**, with independent multi-account isolation checks. Every list response must retain an **exact current total**; approximate, omitted and stale cached totals were explicitly rejected. A short operator-managed maintenance window is allowed for final schema/storage cutover. Existing article bodies, image identity/bytes, note contexts (including retained-only contexts), revisions/tombstones and unsynchronized drafts must be preserved. Migration copies and verifies; removing the source is a separate operator decision.

## Query path

Retain the existing microsecond-safe keyset article cursor and exact DTO semantics. Fetch summary columns rather than discarded HTML/body columns. Remove repeated per-row hydration/count work, return bounded bulk acknowledgements, and keep all state-version/CAS and ownership guarantees.

Common exact totals/unread/saved/sidebar/tag counts may use transactionally maintained PostgreSQL counters, not TTL caches. Counter migration/backfill and every mutation path—including ingest, import, user/feed/article cascades, subscription changes, tags, bulk transitions and progress-only writes—must be tested against authoritative aggregates. Counters and rows must be read from a consistent snapshot. Provide an operator reconciliation path; do not silently return corrupt or stale counters as exact. Complex search/date/intersection counts remain exact queries and must be measured honestly.

Evaluate additive indexes for tenant/feed timelines, unread/saved filters, reverse tag membership, pending images and blob references. Preserve full literal/multilingual search semantics; any trigram indexes need extension/deployment and index-size documentation. Do not edit applied migrations, place concurrent-index SQL inside a transaction, remove the blob durability lock casually, or hide archive-wide writes behind an allegedly atomic chunked API.

## Storage

PostgreSQL remains authoritative for bodies, ownership and annotations. Filesystem storage stays the default. New immutable blobs use SHA256 fanout paths without changing stored file keys or authenticated asset URLs, with legacy flat-path reads supported. New staging/recovery must not enumerate every blob at startup. Data/backend roots and checkpoint parents must be pre-provisioned by the operator or volume manager; missing roots fail clearly. The application re-establishes every owned directory edge through this explicit root on retry, without syncing unrelated/read-only ancestors. Root provisioning/durability outside that boundary belongs to the deployment environment. Preserve fsync, same-filesystem publish, rollback and unknown-commit recovery guarantees.

Add an optional operator-configured private S3-compatible backend. The bucket/endpoint/prefix/credentials are deployment settings, not arbitrary per-request inputs. Use the official protocol/client, private access and authenticated owner checks; a hash is never an access credential. Object upload and PostgreSQL commit are not atomic: retain durable intent/recovery state and safe idempotency, and never delete unknown objects automatically. Do not publicly expose signed bucket URLs. Filesystem archives must remain usable without S3 dependencies/services configured.

Use a resumable, bounded-memory copy/verification tool for filesystem fanout and filesystem↔S3 migration. Preserve exact bytes and keys; do not normalize old images or sanitize old bodies again. Verify every referenced object and owner/context fingerprint before cutover. Keep originals and explain rollback after new writes, partial objects, outage and disk-full handling.

The existing small portable ZIP remains bounded. It is not the operator migration path. Add a scalable paired operator recovery path rather than raising buffer/entry limits blindly: stream immutable referenced blobs, use bounded parts/manifests, preserve the PostgreSQL snapshot and all retained-only contexts, check integrity before restore, and never restore over a nonempty target. Document which retained/unreferenced source files remain outside a referenced-blob bundle; do not call such a bundle an exact copy of arbitrary volume contents. Preserve existing backup readers and old bundles. The separate AI encryption key remains part of private deployment configuration and must be preserved independently.

## Verification

Heavy builds, browsers, PostgreSQL/S3 integration tests and synthetic benchmarks run on approved GitHub-hosted infrastructure, not local or corporate hosts. Use no real notes, articles, credentials or upstream calls. Benchmark at 10k/100k/1M articles, timestamp ties, skewed feeds/tags, common and rare searches, multiple owners, deep keysets, selective image queues, concurrent state writes and drift checks. Capture query plans, table/index/TOAST sizes, dataset/hardware description, read latency distributions, bounded memory and migration/restore fingerprints. Include storage interruption/recovery and cross-owner denial.

Report measured limitations, especially common-term exact search costs, write-counter contention, export duration and backup volume. No universal latency or million-article guarantee is established by existing small-fixture correctness tests.
