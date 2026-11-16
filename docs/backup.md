# Consistent backup and non-destructive restore

An OPML export is **not** an archive backup. PostgreSQL contains article bodies, accounts, sessions and metadata; by default `/data` contains cached image bytes and generated files. Optional private S3 deployments instead keep final blobs in S3 and still require durable local DATA_DIR journals (see [storage.md](storage.md)). Preserve a consistent pair, plus operator configuration/secrets stored separately and securely. A user ZIP export is not a complete multi-user disaster-recovery backup.

The supplied scripts require Docker+Compose, a POSIX shell and either `sha256sum` or `shasum` on the host. They run the small Node archive utility **inside the application image**, not on the host. The image must already exist. No Docker socket is mounted into the application. Run from the deployment directory; `COMPOSE_FILE`, `ENV_FILE`, `COMPOSE_PROJECT_NAME` and `CONTAINER_ENGINE=docker|podman` select the target explicitly. `.env` is read by Compose, never evaluated as shell code.

## Back up (existing filesystem version1)

For a scalable referenced-blob bundle or **any S3 deployment**, use the version2 workflow below. `backup.sh` explicitly refuses S3: archiving its local journal directory would not back up its objects. Existing version1 files/limits/readers are unchanged.

Use a dedicated database; stop **all** API replicas, pollers, ebook jobs, ad-hoc SQL and other external writers. Scripts verify the selected project's `app` is stopped, but cannot detect applications in other projects, manual SQL sessions or external mounts. An active writer invalidates consistency. There is deliberate downtime; this is not a hot snapshot mechanism.

```sh
export COMPOSE_PROJECT_NAME=feedink
# Keep postgres running.
docker compose stop app
mkdir -p /secure/backups
scripts/backup.sh /secure/backups/feedink-2026-11-14
# Restart only after checking the exit code and complete manifest.
docker compose up -d app
curl --fail http://127.0.0.1:3000/api/health
```

The backup destination must not exist and its parent must already exist. The private mode0700 bundle contains:

- `postgres.dump`: custom-format `pg_dump`, no role ownership or privileges.
- `data.archive`: version1 framed file archive of the entire `/data` directory, including images/ebooks. It is not a tar or ZIP file.
- `manifest.json`: versioned SHA-256 checksums. Written last; a missing/invalid manifest means incomplete backup.

Regular files only: symlinks, devices, sockets, traversal and ambiguous paths are refused. Bounds: one million files, 20GiB per file, 1TiB total and 8KiB headers. Empty directories and Unix ownership/modes are not preserved; restored files are mode0600 owned by the application user. These bounds apply to this recovery format, not to an assertion about per-user product quotas.

Scripts never delete or overwrite an existing bundle. Failure leaves the app stopped and the incomplete output for inspection. Keep sufficient space for both dumps; do not store backups inside `/data`. Encrypt bundles at rest and copy off-host. Checksums detect accidental corruption, **not malicious replacement**: protect/authenticate your backup storage. A database dump includes private article text, password hashes and active-session records even though `.env` is not included. Do not upload it as a public test artifact.

## Restore into a fresh project

Restore does not erase an existing database or volume. It requires an empty target, exact confirmation of the Compose project name, a stopped app and a running healthy PostgreSQL. Make a separate private env file with a **different project name**, unused application port, the intended restored public origin, and your securely escrowed configuration. Retain the exact source/image version that produced the backup. The examples use `recovery.env`, which must stay private and must not be committed.

```sh
export COMPOSE_PROJECT_NAME=feedink-recovery
export ENV_FILE=/secure/recovery.env
# Set FEEDINK_IMAGE in that file to the retained compatible image.
docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" up -d postgres
# Wait until postgres is healthy. Do NOT start app yet: migrations make the DB nonempty.
scripts/restore.sh /secure/backups/feedink-2026-11-14 --confirm-restore=feedink-recovery
```

The scripts reject bundle directory links even with trailing slashes, and validate both checksums and all archive paths/records before modifying the target. The PostgreSQL17 emptiness guard checks database-scoped catalog objects (including collations, casts, foreign-data wrappers and text-search objects), not just tables; it distinguishes bootstrap OIDs from user-created objects and separately counts large objects, whose IDs can be explicitly chosen below the normal OID range. Cluster-wide roles/databases/tablespaces are outside this application-database check. A database with custom default privileges or an extra extension is not an empty restore target. Database restore uses `pg_restore --single-transaction --exit-on-error`; no `--clean`, database drop, archive cleanup or volume deletion is performed. File restore refuses pre-existing entries. Restore only trusted backups: SQL dumps are executable database input, not a safe import format for untrusted users. Keep every writer stopped for the whole operation.

If restore fails, leave the failed project stopped. It may contain a restored database and partially written files. Preserve it for diagnosis and choose another empty recovery project after correcting the cause. **Do not rerun blindly into partially populated targets** and do not remove unrelated resources.

After successful restore, start deliberately:

```sh
docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" up -d app
curl --fail http://127.0.0.1:3001/api/health  # example recovery port; match your env
```

Verify the correct users and counts, old body hashes, a sample archived image byte hash, login/logout, ownership isolation, OPML and ebook access. Temporarily make a source fixture unavailable and confirm the stored body/image still load. Only then switch the reverse proxy. Recovery testing must not send real scheduled emails: use empty SMTP settings or a local mail sink before first startup. Decide whether previously valid sessions should remain valid and perform explicit session revocation if needed; changing secrets is not a substitute for checking session invalidation semantics.

## Recovery drills and limitations

Run `node --test scripts/data-archive.test.mjs` where Node24 is available and the container round-trip drill from [testing.md](testing.md). The drill verifies SQL+binary-byte restoration and diagnostic-specific rejection of live, nonempty, unconfirmed and symlink targets. Its corruption case flips a payload byte without breaking framing, targets a new empty database/volume, requires a checksum-specific failure, and verifies neither store was populated. Exercise this on your actual volume driver/storage, restore hardware and PostgreSQL version before depending on it.

All builds, database/container/S3 drills and performance measurements for this change must run only on approved GitHub-hosted infrastructure with synthetic fixtures; the commands above are operator documentation, not evidence they were executed in the implementation lane.

Archive checksums and PostgreSQL transactional snapshots cannot compensate for an operator leaving external writers running. Dumps do not preserve cluster roles/extensions outside the application database, encryption keys or proxy/DNS configuration. This is application backup, not a physical PostgreSQL cluster backup or automatic retention service. See [deployment.md](deployment.md) for migration/upgrade rollback.

## Scalable PostgreSQL + referenced-blob bundle (version2)

Use `sh scripts/storage-backup.sh NEW_BUNDLE_DIRECTORY` with the same stopped-project/env selection and private bundle-path rules as version1. It supports filesystem legacy/fanout reads and private S3. It does **not** enumerate arbitrary `/data` contents or bucket keys. The compiled operator CLI lives in `apps/api/dist/storage/operator.js`; the image must contain the new storage modules and official S3 dependency before running these scripts. Source PostgreSQL must have the application's tables. No startup migrations run in backup/restore helpers.

The mode0700 bundle contains:

- `postgres.dump`: complete custom-format PostgreSQL application-database dump, including bodies, accounts, auth state, all note revisions/tombstones **currently stored**, and retained-only contexts.
- `blobs.archive`: `FEEDINK-REFERENCED-BLOBS-2` stream. Distinct current keys from **all** `images.file_key`, `ebooks.file_key` and `feeds.icon_file_key` references appear in increasing order with exact bytes. Each framed part has at most 1,024 objects and 512MiB of payload, a count, sequence number, byte total and SHA256 digest. Per-object bound is 256MiB and header bound is 8KiB. Large streams contain many bounded parts **inside one sequential file**, not a giant ZIP or a giant in-memory manifest. The final footer is constant-size. There is no million-name array/Set, recursive directory-name list or one-million-file cap in this new format; checked safe-integer totals still bound representable sizes. These are format bounds, not capacity/latency guarantees.
- `manifest.json`: version2 scope `postgres-and-referenced-blobs`, SHA256 checksums for both files and the complete-row PostgreSQL fingerprint. It is written only after dump, streaming pack, complete archive integrity check and a final unchanged database fingerprint. No manifest means incomplete backup.

Database rows/column metadata are fingerprinted in primary-key order using bounded server cursors; blob reads are streamed with backpressure. SQL keyset pages are bounded to 256; archive checks hold only the current record, part hash and last key. Output size, database fingerprint scans, checksum rereads and server-side work still scale with the archive. Allow enough disk for the dump + all referenced bytes and enough downtime for multiple full passes. This is **not** an online/exported-snapshot protocol: every writer, including external SQL, must remain stopped from the first fingerprint through completion. No verification can prove absence of an external writer that changes and reverts data during an allegedly quiescent dump.

### Scope: referenced bytes, not arbitrary full volume

Version2 includes only immutable **currently database-referenced** bytes. Unreferenced/surplus legacy files, unknown published objects after aborted/ambiguous writes, abandoned copy scratch, local transaction journals and arbitrary operator files are **outside the bundle**. Their source is retained, not deleted. Take a separate volume/provider-version backup if those contents must also be recoverable. Version1 remains the bounded full-directory file archive for filesystem installations. Neither format captures file modes/empty directories, a physical PG cluster, per-node configuration, browser-local unsynchronized drafts, earlier revisions no longer stored in PostgreSQL, or arbitrary deleted S3 versions.

Always preserve per-node journals and private deployment configuration separately, including the stable **AI_ENCRYPTION_KEY**, session/auth configuration, S3 credentials/policies/version retention, and origin/network settings. A dump containing encrypted AI credentials cannot decrypt them without its original independent encryption key; rotating a session key is unrelated. Do not put these secrets, real dump fingerprints, raw logs or real content in Git or public CI artifacts.

### Non-destructive version2 restore

`sh scripts/restore.sh BUNDLE_DIRECTORY --confirm-restore=PROJECT` continues reading version1 and dispatches version2 to `storage-restore.sh`. Version1 restore requires filesystem storage; it is never silently treated as an S3 restore. To move an old installation to S3, restore its old paired bundle into a fresh filesystem project, then perform the separate stopped copy/verify migration.

For version2, configure an empty database, a fresh DATA_DIR and either an empty filesystem blob directory or a private fresh S3 prefix. All current S3 keys count as nonempty, not just referenced keys. Retained historical versions/delete markers are not listed by this guard: use a fresh dedicated prefix/bucket. The helper never creates buckets or clears targets. Keep all target writers stopped; an emptiness check is not a distributed write lock for external tools.

Before restoring anything the script validates both complete-file SHA256 checksums, every object SHA256, sorted/unique keys, bounded part structure/digests and the final fingerprint. It then checks empty blob/journal targets and the unchanged comprehensive PostgreSQL17 emptiness guard. PostgreSQL restores with `--single-transaction --exit-on-error`, followed by exact database-fingerprint comparison. Blob payloads are staged, fsynced, published without overwrite and verified; the complete reference inventory is verified again against restored PostgreSQL. S3 can therefore be restored to filesystem and vice versa without changing DB keys/owners/contexts.

PG + blobs are **not one transaction**. A failure after SQL restore or after some object publishes leaves a nonempty failed target and retained evidence. Do not rerun blindly, delete objects, overwrite a collision, or start the app; use another fresh target after correcting the cause. The input bundle is not modified by restoration. Protect it against concurrent/malicious edits; checksums are not signatures. No arbitrary SQL dump from an untrusted party is safe to restore.

Keep the original source, bundle and release while validating login/logout, ownership denial despite shared physical keys, exact historical bodies, saved/tombstoned notes, retained-only context identities, images and ebooks. Restore drills must disable real scheduled mail/provider work. A rollback after new writes needs a matching pair or stopped reverse-copy/reconciliation, not just changing STORAGE_BACKEND.

### Hosted verification status

Authored tests cover bounded parts/headers, exact binary keys/bytes, corrupted/missing/truncated records, duplicate keys, full-row fingerprint substitution, nonempty refusal, existing-key collision, ownership and checkpoint replay. The new synthetic container drill is:

```sh
# Approved GitHub-hosted runner only; TEST_IMAGE must already be built by the parent gate.
TEST_IMAGE=HOSTED_BUILT_IMAGE sh scripts/test-storage-backup.sh
```

It compares PostgreSQL/retained-only fingerprints, restored reference bytes, deliberate unreferenced-volume exclusion, nonempty refusal and pre-write rejection of framing-preserving payload corruption. Also rerun the existing `scripts/test-backup.sh`, `node --test scripts/data-archive.test.mjs`, and new API storage tests from [storage.md](storage.md). These tests and real S3/process-kill/disk-full/large-scale drills were **not executed** in the implementation lane. No restored 1M corpus, memory figure, throughput or recovery time is asserted from source inspection.

### Audit follow-up: durability boundaries and stronger hosted drills

DATA_DIR, destination backend roots and checkpoint parents must be pre-provisioned, durable real directories. Their mount/link persistence is the operator/volume provisioner's responsibility. Application fsync barriers stop at the configured root, not at read-only/unrelated ancestors. Existing directories no longer bypass fanout/journal edge fsync on retry after an earlier failed mkdir/fsync.

The version2 synthetic drill now uses the production read-only root, 64MiB `/tmp`, dropped capabilities and no-new-privileges, and verifies those restrictions inside the container. A separate test-only 1MiB tmpfs exercises actual ENOSPC with SQL rollback and staged cleanup; it is not a substitute for the persistent volume's crash certification. The drill also recomputes outer checksums after making a structurally invalid framed part: complete archive validation must still reject before either target is populated.

Set `STORAGE_RESTORE_BACKEND=filesystem` or `s3` and run both variants on approved hosted infrastructure. S3 requires the job's synthetic SDK credentials, a provisioned bucket and `TEST_STORAGE_S3_ENDPOINT` reachable **inside the utility container**; see the exact hosted commands and host-gateway caveat in [storage.md](storage.md). Each target uses a new S3 prefix; the input PostgreSQL dump and archive are the same paired recovery format, not an S3-only copy test. These new fixtures and the actual owned writer-process/HTTP failure witnesses are authored acceptance work, **not executed or reviewed runtime success**.
