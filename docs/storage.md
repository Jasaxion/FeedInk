# Immutable blob storage and maintenance migration

This is an unreleased implementation/verification contract, **not measured million-article capacity**. Bodies, ownership, notes, tombstones, retained-only annotation contexts and auth state remain in PostgreSQL. Storage contains immutable image/icon/EPUB bytes, not a replacement body database. The small reader/user ZIP formats and limits are unchanged.

## Deployment and API integration

`Config.storage` is optional. `new Store(directory)` remains filesystem-default; the application constructs `new Store(config.dataDir, config.storage)`. DATA_DIR, filesystem backend roots, S3 local scratch roots and checkpoint parent directories must already be provisioned as real directories. A missing root fails clearly rather than recursively creating unrelated ancestors. The operator/volume provisioner owns persistence of each root's mount/link and writable permissions. The application re-syncs only owned descendants through that explicit root, never its parent (which can be the container's read-only `/`). New keys remain lowercase SHA256 and are published to `ab/cd/<full-key>`. Reads try fanout first, then legacy `<directory>/<full-key>`. Existing DB keys and authenticated asset URLs do not change. Verification reports a corrupt fanout object as an error, rather than silently selecting an older flat copy. Normal streaming reads do not perform a second full hash pass; use maintenance verification to detect out-of-band corruption.

For optional S3-compatible storage, use private **deployment** settings, never user/account/request parameters:

| Setting | Meaning |
| --- | --- |
| `STORAGE_BACKEND` | `filesystem` (default) or `s3` |
| `STORAGE_S3_BUCKET` | Existing private bucket |
| `STORAGE_S3_REGION` | Signing region; default `us-east-1` |
| `STORAGE_S3_ENDPOINT` | Optional HTTPS origin for a private S3-compatible service |
| `STORAGE_S3_PREFIX` | Optional relative directory prefix ending in `/` |
| `STORAGE_S3_FORCE_PATH_STYLE` | `true` for services that require it |
| `STORAGE_S3_ALLOW_HTTP` | Explicit `true` only for a deliberately configured private/test endpoint |
| `DATA_DIR` | Durable, private, writable local journal/scratch directory, **also required for S3** |

Credentials use the official AWS SDK deployment credential chain (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`, or the deployment's credential provider). Do not commit configuration, credentials, bucket contents or fingerprints from real deployments. Do not expose bucket credentials/URLs to users or return signed URLs. Block public bucket access and disable object expiry/lifecycle deletion. Grant only the intended prefix's GetObject/PutObject and ListBucket for nonempty-target checks; the application has no DeleteObject implementation. Prefixes must be private to this installation. Versioned buckets should use a fresh dedicated prefix/bucket for recovery; current-key emptiness is not proof that historical versions never existed.

The SDK uses conditional `If-None-Match: *`, SHA256 checksums and a **full GET/hash verification** after publishing, including an existing-key collision. ETags are not integrity hashes. The provider must support atomic conditional PUT, read-after-write visibility and the checksum protocol. No unconditional overwrite or alternate transport fallback exists. Single PUT is limited to 5GiB; existing bounded image/EPUB producers are much smaller. There is no speculative multipart upload/garbage collector. S3 connections have a 10s connection and 120s request timeout, with at most three SDK attempts; complete transfer/recovery duration remains dependent on service latency and bandwidth.

`Store.stream(key)` returns a Node readable that masks backend error metadata and destroys its owned source on error, completion or HTTP cancellation, including cancellation before the first read. Application asset/icon/EPUB routes return that stream **after the unchanged owner joins/session checks**. Do not accept a hash as authorization. Cross-account rows can legitimately share the same physical bytes; deleting/changing one owner's reference cannot authorize or delete another owner's object. Buffer-based `get()` remains for bounded archive/image processing callers.

The runtime dependency lock pins `@aws-sdk/client-s3` to `3.1169.0`. The application passes storage configuration into Store, streams the three owner-checked download routes, and forwards deployment variables through Compose. No other SDK package is required. The compiled operator is included in the runtime image; shell tools run `node apps/api/dist/storage/operator.js`.

## Publish, failures and bounded startup recovery

All production blob transactions still take PostgreSQL advisory lock **71244004** on their existing reserved connection. Removing it requires separate concurrency/crash evidence; this patch makes no lock-throughput claim. Never reserve another pool connection while holding it.

1. Create `.storage-staging/txn-*/intent.json` with a version and deployment-identity digest, fsync file/directory/parent before starting the SQL transaction.
2. Stage each hash-keyed byte file, fsync it and the staging directory before `put()` returns. Key enumeration is on disk, not an archive-wide Set.
3. Publish every staged object immutably, and verify bytes. Filesystem uses same-filesystem hard links and re-fsyncs the complete fanout chain leaf→parent→explicit storage root on **every** publication, including existing directories after a failed earlier mkdir/fsync; it then fsyncs the published leaf entry. Existence or EEXIST is never treated as proof that an earlier parent barrier completed. S3 uses conditional PUT + GET verification. Only then attempt PostgreSQL COMMIT.
4. On an acknowledged commit, remove only the transaction's own staging. On a known pre-COMMIT rollback, staging can be removed; published objects are conservatively retained. A failed COMMIT is **ambiguous even if a later ROLLBACK succeeds**: retain the durable intent for authoritative recovery.
5. Recovery takes the same lock, checks current PostgreSQL references, re-publishes/verifies referenced staged objects, then removes processed staging. It never deletes final objects. Corrupt staging/collisions, missing permissions or S3 outages fail closed and retain evidence. Cleanup failures still release the writer lock.

Startup enumerates only `.storage-staging`, at most 256 journal/key entries per call (operator calls may choose 1–10,000). It never enumerates the fanout or legacy blob root. Remaining entries are safe to retain because publication precedes reference commit; run maintenance recovery to drain them. This bounds entry work/memory, **not a universal startup-time bound**: a slow backend or large staged file still costs I/O. Incomplete/corrupt intent metadata requires private operator inspection; it is not silently discarded. Each writer host's durable journal must be preserved and recovered using the original deployment identity before switching its backend/path. Do not use disposable `/tmp` for DATA_DIR. S3 bytes can outlive a lost journal; those unknown objects must remain, not be guessed away.

### Existing interrupted writes

Legacy `.stage-*` directories are not discoverable without traversing the old flat root. Before cutover, stop every writer and run:

```sh
sh scripts/storage-recover.sh legacy --confirm-maintenance=PROJECT
sh scripts/storage-recover.sh journal --confirm-maintenance=PROJECT
```

Use the original filesystem DATA_DIR for the legacy command. It streams directory entries with bounded memory and processes stage contents in batches of 256; discovery can traverse the **entire old root during explicit maintenance**. It is not a bounded-time startup scan or a persisted filesystem directory cursor. If interrupted, rerun: processed staging is durable, immutable finals are retained, and discovery restarts. It restores/verifies committed/shared keys and conservatively keeps unreferenced legacy finals. New startup intentionally does not promise to discover every old root-stage directory. Old code must not be restarted after fanout writes: it cannot read fanout keys.

## Copy and verify, never move

The migration utility uses PostgreSQL reference-key keyset pages of 256, one streamed object scratch file at a time, and a constant-size JSON checkpoint every 128 completed copies. It never lists a bucket or accumulates all filenames. It scans `images.file_key`, `ebooks.file_key` and `feeds.icon_file_key`, regardless of owning account/status. Existing exact keys and bytes are retained without image normalization, HTML sanitation, ID rewriting or annotation import.

For efficient keysets/reference checks, coordinate non-null blob-reference indexes with the query/index migration. On an installation without equivalent indexes, an operator may create `images(file_key) WHERE file_key IS NOT NULL`, `ebooks(file_key) WHERE file_key IS NOT NULL`, and `feeds(icon_file_key) WHERE icon_file_key IS NOT NULL` **CONCURRENTLY outside startup's transactional migration runner**. Review deployed index names/definitions first. Do not add duplicate indexes or run concurrent DDL inside a transaction. These scans and fingerprints require hosted plans/timing evidence.

All public tables are fingerprinted in primary-key order with server-side cursor batches of 32; exact PostgreSQL JSONB text includes bodies, owner relations, auth epochs, full note payloads/revisions/tombstones and retained-only contexts. Column metadata also participates. Every public table must have a primary key or the operation refuses. Fingerprints do not emit row contents. Match PostgreSQL version/collation and use the same code/schema for comparison; this is not a portable cross-engine semantic hash. Large rows still impose a per-row/batch memory cost. Fingerprints are full scans, not fast counter checks, and PG dump preserves additional catalog/sequence state beyond this row fingerprint.

Stop **all** API replicas, workers, external SQL, mail delivery and other source/target writers for the entire operation. The shared lock is not a substitute for stopping non-blob database writers. Source settings are `DATA_DIR`/`STORAGE_*`. Destination settings are `TARGET_DATA_DIR`/`TARGET_STORAGE_*` with the same suffixes as the source table. Mount an already-provisioned durable target root and checkpoint parent inside the utility container. The utility deliberately refuses to auto-create these durability boundaries. For filesystem destinations scratch must be on that filesystem; for S3 it remains local. Do not put a checkpoint inside a blob key namespace or use an ephemeral container filesystem. The shell does not mount arbitrary paths or chown host directories for you.

```sh
# Set deployment-specific source/target env and mounts privately in Compose; no credentials on CLI.
sh scripts/storage-migrate.sh /operator-state/copy.json --confirm-maintenance=PROJECT
# Direct image commands for explicit verification (writers remain stopped):
# STORAGE_MAINTENANCE=stopped node apps/api/dist/storage/operator.js verify
```

Filesystem→fanout in the same directory, filesystem→S3 and S3→filesystem use the same protocol. The checkpoint binds source/destination identities and the initial complete-row fingerprint. Resume refuses a different deployment or changed database. After copying the tail it **re-reads and hashes every referenced destination**, including previously checkpointed keys, and fingerprints the database again. A complete checkpoint is not permission to skip final verification. Disk-full, interrupted copy or ambiguous object acknowledgement leaves source and partial scratch/target intact; repeating from the checkpoint is idempotent. Source and destination must not alias through unreviewed mounts/symlinks; a changed identity requires a new checkpoint.

Cutover is explicit: preserve an independently verified paired backup; drain every host's journal; stop all writers; complete copy/verification; save private PG/object fingerprints; change deployment config; verify the destination with the same database; then deliberately resume. Source removal/garbage collection is **not** implemented or authorized. Unreferenced legacy/fanout objects and abandoned scratch are retained and are not counted as migrated referenced data.

Rollback before new writes can switch back to the retained source using a fanout-capable release. After new writes, a plain configuration switch is **not lossless**: copy/verify the reverse delta while stopped (new checkpoint) or restore a matching PostgreSQL/blob backup pair. Neither a blob migration nor a ZIP reconstructs historical content already overwritten before this release, nor browser-local unsynchronized drafts that were never sent to the server. Preserving their retained contexts makes existing offline drafts syncable; it does not back up browser storage.

## Hosted acceptance gates

No local service/build/typecheck/performance runs establish this feature. Run on approved GitHub-hosted infrastructure with synthetic data only:

- API build/typecheck and full existing tests (including adapted legacy recovery, post-commit cleanup-lock and annotation race coverage).
- `storage.test.ts`, `storage-s3.test.ts`, and `storage-bundle.test.ts` cover unit/protocol behavior; the release CI records actual execution.
- `storage-postgres.test.ts` with a **dedicated empty** `TEST_STORAGE_DATABASE_URL`; S3 additionally needs `TEST_STORAGE_BACKEND=s3` and `TEST_STORAGE_S3_*` deployment fields plus synthetic SDK credentials. Do not point it at the shared integration database: migration validates **every** DB reference against its fixture's backend. Synthetic S3 prefixes are retained for diagnosis until the hosted environment is disposed.
- `TEST_IMAGE=... sh scripts/test-storage-backup.sh` for paired restore, retained-only fingerprint preservation, corruption/nonempty refusal and intentional surplus exclusion; run unchanged `scripts/test-backup.sh` and data-archive tests for version1 compatibility.
- Real filesystem disk-full/kill-at-fsync, process/connection death around publish/COMMIT, multi-host journal recovery, S3 conditional/outage behavior, corrupt/missing objects, interrupted migrations and fresh-target restores. Unit-injected failures are not substitutes for these service/volume-driver tests.
- 10k/100k/1M synthetic references/articles, bounded process memory, exact plans, bytes/inodes, global-lock wait time, object requests, migration/backup/restore duration and fingerprint equality. No measured result or million-scale performance guarantee is claimed here.

See [backup.md](backup.md) for paired referenced-blob recovery and the different scope of old full-volume archives.

### Independent storage audit follow-up (hosted validation still required)

The directory helper takes an explicit pre-provisioned durability root. Each invocation validates real directories, creates only descendants, and syncs the entire leaf-to-root chain even if all entries already exist. Initialization, retry publication, recovery, migration scratch and checkpoint handling use that boundary. This corrects a source-level defect where a visible directory left by a failed parent fsync could be trusted on retry. It does not certify a filesystem's power-loss behavior.

Additional authored acceptance fixtures (not locally executed):

- `storage-durability.test.ts`: deterministic one-time parent/root fsync failures, surviving mkdir entries, exact retry barriers before COMMIT, recovery/copy revalidation, missing-root refusal and no root-parent fsync.
- `storage-postgres.test.ts`: **271 distinct keys** across both 128-checkpoint and 256-inventory boundaries, image/ebook/icon references including pending/failed images with retained keys, interruption after object 130, checkpoint replay and complete post-resume verification.
- `storage-http.test.ts` plus its owned child fixture: real HTTP image/icon/ebook success and cross-owner denial; failures before opening/first byte and after a received body chunk; client cancellation; underlying close witnesses; production logger capture with synthetic raw error markers absent from responses/logs. `storage-stream.test.ts` also checks cancellation before consumption.
- `storage-process.test.ts` plus its owned writer fixture: bounded actual SIGKILL before COMMIT and after server COMMIT but before Store cleanup, an independent committed-reference/lock observer, and a **new recovery process** verifying bytes and journal cleanup. These process kills are not power-loss or volume-driver certification and do not cover every possible lost COMMIT packet timing.
- Paired restore drill: production-equivalent read-only runtime root, 64MiB `/tmp`, dropped capabilities/no-new-privileges; a separate 1MiB test-only tmpfs exercises real ENOSPC rollback. A malformed part sequence with **recomputed valid outer checksums** must fail before DB mutation or target population.

Hosted command for the storage tests (dedicated synthetic DB; retain serial execution):

```sh
NODE_ENV=test npm exec -w @feedink/api -- tsx --test --test-concurrency=1 test/storage.test.ts test/storage-durability.test.ts test/storage-stream.test.ts test/storage-s3.test.ts test/storage-bundle.test.ts test/storage-postgres.test.ts test/storage-http.test.ts test/storage-process.test.ts
```

### Paired source/target and real-service interruption hooks

Development CI **43830557345** passed the existing storage/container jobs, including 271-key migration, HTTP/process-close checks, ENOSPC and **filesystem-source → S3 restore**, and that CI **43835630740** passed the S3-source/interruption jobs. The latter establishes the earlier fixture's backup failure, incomplete-output refusal, preserved referenced source state and fresh-target recovery—not the precise one-byte/scheduled-close claim, whose earlier counters recorded intent. The strengthened event/receipt assertions below are required by the release pipeline. Inspect the final release evidence rather than inferring acceptance from their source or from an earlier development run.

On an approved GitHub-hosted Ubuntu runner, the existing filesystem-source invocations remain unchanged (`STORAGE_SOURCE_BACKEND` defaults to `filesystem`):

```sh
STORAGE_RESTORE_BACKEND=filesystem TEST_IMAGE=HOSTED_BUILT_IMAGE sh scripts/test-storage-backup.sh
# Existing synthetic SDK credentials, TEST_STORAGE_S3_BUCKET and region are supplied by the job, not source.
STORAGE_RESTORE_BACKEND=s3 TEST_STORAGE_S3_ENDPOINT=http://host.docker.internal:19000 \
  TEST_STORAGE_S3_ALLOW_HTTP=true TEST_STORAGE_S3_FORCE_PATH_STYLE=true \
  TEST_IMAGE=HOSTED_BUILT_IMAGE sh scripts/test-storage-backup.sh
```

The storage CI job runs both explicit S3-source hooks after its runtime image build and synthetic bucket setup, sequentially before fixture teardown:

```sh
# Official SDK-backed S3 seed, source verification and referenced-blob pack; fresh filesystem target.
STORAGE_SOURCE_BACKEND=s3 STORAGE_RESTORE_BACKEND=filesystem \
  TEST_STORAGE_S3_ENDPOINT=http://host.docker.internal:19000 \
  TEST_STORAGE_S3_ALLOW_HTTP=true TEST_STORAGE_S3_FORCE_PATH_STYLE=true \
  TEST_IMAGE=HOSTED_BUILT_IMAGE sh scripts/test-storage-backup.sh

# Same source path, plus an opt-in bounded interrupted GET and recovery into a fresh S3 target.
# STORAGE_RESTORE_BACKEND=filesystem is also supported with this witness.
STORAGE_SOURCE_BACKEND=s3 STORAGE_RESTORE_BACKEND=s3 STORAGE_S3_INTERRUPTION=true \
  TEST_STORAGE_S3_ENDPOINT=http://host.docker.internal:19000 \
  TEST_STORAGE_S3_ALLOW_HTTP=true TEST_STORAGE_S3_FORCE_PATH_STYLE=true \
  TEST_IMAGE=HOSTED_BUILT_IMAGE sh scripts/test-storage-backup.sh
```

The bucket must already be private and synthetic. CI builds the isolated S3 protocol fixture from public commit `0d7408fc9969caf07de6a8c3a84f9fbb10a6739e` via `scripts/build-s3-fixture.sh`; retired public MinIO image/binary downloads are not used. Keep the current host-loopback **and Docker bridge** port 19000 publication. The utility container maps `host.docker.internal` to the Docker gateway, not its own loopback. Production deployment manifests are unchanged; the storage CI job has been extended to invoke both cases.

`STORAGE_SOURCE_BACKEND` and `STORAGE_RESTORE_BACKEND` independently accept `filesystem`/`s3`. Every invocation generates random project names and fresh source/restored/corrupt prefixes beneath optional `TEST_STORAGE_S3_PREFIX`; it refuses a nonempty source. Seeding passes validated environment config into **Store**, records that source config privately on `/data`, and checks S3-backed bytes without a local blob fallback. The seed and production operator receive the same selected endpoint/prefix through Compose. `/data` remains an image-owned, pre-provisioned volume; S3 does not bypass the local journal-root requirement. The separate 1MiB ENOSPC tmpfs stays filesystem-backed regardless of source selection. Source config and surplus files are not part of the referenced-blob restore.

`STORAGE_S3_INTERRUPTION=true` requires an S3 source and exactly the synthetic upstream `http://host.docker.internal:19000`. It starts only the owned project's opt-in `s3-interruption-proxy` service, with no host-published ports, credentials, Docker socket or privileges. Its control listener is container-loopback-only. The source SDK uses the proxy endpoint throughout seeding/packing/recovery; the proxy preserves signed Host/path/query and forwards to the real service. After successful source reads, it is explicitly armed to receive a successful object GET, forward one actual byte, then close **only its owned response/socket**. The retry gate closes immediately when that GET starts, but assertion/recovery remain ineligible until the one-byte write callback succeeds and the scheduled downstream destroy produces an observed close. Clean upstream EOF followed by close with `complete === true` may precede the timer; it never counts as the owned cut. An upstream error/abort/incomplete close, downstream premature close, or write error permanently fails the witness. Late error callbacks cannot reopen the gate, and pending control requests are rejected rather than queued for recovery. Subsequent requests receive 503 until explicit recovery, so SDK retries cannot silently complete that backup. The script does not stop MinIO or alter host networking/arbitrary services.

The witness requires all of the following, or fails:

- A real upstream 200 object response and partial-byte interruption, followed by backup failure within a **90-second command deadline** (plus at most 10 seconds to kill an unresponsive command). A timeout is failure, never a passing interruption result. Use a finite job/step timeout; that command deadline is not a bound for the whole PG/drill workflow.
- A nonempty PG dump and partial archive with no completion manifest. The archive must privately equal the exact fixture magic, blob header with the expected source SHA256/declared four-byte length, and exactly the first actual payload byte—with no remaining body, part/footer, or other bytes. Headers alone fail. Same-directory backup reuse, complete-frame validation and incomplete-bundle restore must all refuse before populating the empty target.
- Explicit signed official-SDK HEAD and GET requests both return 503 while gated, with single attempts and bounded request timeouts. Proxy-side counters independently require both refusals before recovery, rather than assuming that a failed streaming GET will retry.
- Generic operator errors with no synthetic credentials, endpoint/bucket/prefix, object keys or fixture rows in the captured failure messages. Failure logs remain private; publish only the fixed `Witness:`/`PASS:` summaries after assertions succeed.
- Unchanged database/reference fingerprints and verified source bytes after proxy recovery, including exact seeded bytes read through the saved S3 config. Partial-output checksums remain unchanged through refusal and recovery.
- A **new** backup output directory and fresh target project/prefix for recovery, followed by the existing full PG/context/byte verification, nonempty refusal and malformed/checksum preflight checks. Failed output is neither deleted nor overwritten.

The interruption drill now runs `scripts/storage-s3-interruption-proxy.test.mjs` before provisioning services, so the interruption CI hook includes its focused regressions without another workflow edit. Standalone hosted hook (also no local execution):

```sh
node --test --test-concurrency=1 scripts/storage-s3-interruption-proxy.test.mjs
```

These hosted-only tests cover pending/missing/failed write acknowledgement, scheduled-destroy intent versus observed close, clean upstream EOF/close racing the timer, early/incomplete upstream and downstream termination, late error callbacks, exact partial-archive validation, actual loopback 200/original-length/one-byte/incomplete-close observation, pending assertion/recovery refusal, real gated HEAD/GET responses, and normal forwarding after recovery. Event-order tests are deterministic fixture checks; their owned loopback socket tests are not a replacement for the paired drill's official SDK/real S3 service reads.

The exit trap stops only the drill's own projects, including the proxy. Volumes, source objects/prefixes, private config and failed output are retained until the hosted environment is disposed; do not upload raw bundles, configuration, credentials or failure logs. If its new hosted assertions pass, this four-byte fixture establishes a genuine SDK/S3 interrupted-read witness, **not** an S3 server crash, ambiguous PUT/COMMIT acknowledgement, long/stalled-body cancellation, power-loss/volume-driver test, multi-host recovery proof, benchmark, or production-provider certification. Preservation checks cover fingerprinted public-table data/column descriptions and referenced object bytes, not every PostgreSQL catalog object, unreferenced S3 object, or the entire source volume. Hosted results and independent review remain required before expanding acceptance claims.

Outside this seam, `tests/run-project.mjs` must provision and persist its owned `join(directory, 'data')` child before spawning the API; creating only its outer `mkdtemp` directory is insufficient. Any direct server launch using the normal CI `.data/ci` setting likewise needs a provisioning step. Other helpers that construct missing `Config.dataDir` values must do the same before `createApp`/`Store.init`. Existing inspected API fixtures use `mkdtemp` roots; normal Docker `/data` is a pre-provisioned volume. The shipped runner and workflow provision these owned roots. Custom helpers must do the same; do not weaken the root boundary to accommodate an unprepared helper.
