# Consistent backup and non-destructive restore

An OPML export is **not** an archive backup. PostgreSQL contains article bodies, accounts, sessions and metadata; `/data` contains cached image bytes and generated files. Preserve a consistent pair, plus operator configuration/secrets stored separately and securely. A user ZIP export is not a complete multi-user disaster-recovery backup.

The supplied scripts require Docker+Compose, a POSIX shell and either `sha256sum` or `shasum` on the host. They run the small Node archive utility **inside the application image**, not on the host. The image must already exist. No Docker socket is mounted into the application. Run from the deployment directory; `COMPOSE_FILE`, `ENV_FILE`, `COMPOSE_PROJECT_NAME` and `CONTAINER_ENGINE=docker|podman` select the target explicitly. `.env` is read by Compose, never evaluated as shell code.

## Back up

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

Archive checksums and PostgreSQL transactional snapshots cannot compensate for an operator leaving external writers running. Dumps do not preserve cluster roles/extensions outside the application database, encryption keys or proxy/DNS configuration. This is application backup, not a physical PostgreSQL cluster backup or automatic retention service. See [deployment.md](deployment.md) for migration/upgrade rollback.
