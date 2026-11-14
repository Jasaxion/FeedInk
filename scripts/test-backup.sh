#!/bin/sh
# All drill targets use new, named projects. No existing deployment is selected or deleted.
set -eu
umask 077
: "${TEST_IMAGE:?Set TEST_IMAGE to a locally built FeedInk image}"
export TEST_IMAGE
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export COMPOSE_FILE="$SCRIPT_DIR/backup-test.compose.yaml"
CONTAINER_ENGINE=${CONTAINER_ENGINE:-docker}
export CONTAINER_ENGINE
case "$CONTAINER_ENGINE" in docker|podman) ;; *) exit 1;; esac
WORK=$(mktemp -d "${TMPDIR:-/tmp}/feedink-backup-drill.XXXXXXXX")
export ENV_FILE="$WORK/drill.env"
printf 'POSTGRES_PASSWORD=%s\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" > "$ENV_FILE"
SOURCE="feedink-drill-$(date +%s)-$$"
TARGET="$SOURCE-restore"
GUARD="$SOURCE-function"
COLLATION="$SOURCE-collation"
CATALOG="$SOURCE-catalog"
CHECKSUM="$SOURCE-checksum"
export COMPOSE_PROJECT_NAME="$SOURCE"
compose() { "$CONTAINER_ENGINE" compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
finish() {
  for project in "$SOURCE" "$TARGET" "$GUARD" "$COLLATION" "$CATALOG" "$CHECKSUM"; do
    COMPOSE_PROJECT_NAME="$project" compose stop >/dev/null 2>&1 || :
  done
  printf 'Drill evidence retained at %s; stopped projects: %s, %s, %s, %s, %s, %s\n' "$WORK" "$SOURCE" "$TARGET" "$GUARD" "$COLLATION" "$CATALOG" "$CHECKSUM"
}
trap finish EXIT
wait_database() {
  count=0
  until compose exec -T postgres psql -X -U feedink_drill -d feedink_drill -Atc 'select 1' >/dev/null 2>&1; do
    count=$((count + 1)); [ "$count" -lt 90 ] || { echo 'Database failed to start' >&2; exit 1; }
    sleep 2
  done
}
expect_failure() {
  label=$1; message=$2; shift 2
  if "$@" > "$WORK/$label.log" 2>&1; then echo "FAIL: $label unexpectedly succeeded" >&2; exit 1; fi
  grep -F "$message" "$WORK/$label.log" >/dev/null || { echo "FAIL: $label failed for the wrong reason" >&2; exit 1; }
  printf 'PASS: %s rejected with expected diagnostic\n' "$label"
}
object_count() { compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -At -U feedink_drill -d feedink_drill < "$SCRIPT_DIR/empty-database.sql"; }
assert_no_restored_data() {
  present=$(compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -At -U feedink_drill -d feedink_drill -c "SELECT to_regclass('public.archive_drill') IS NOT NULL")
  [ "$present" = f ] || { echo 'FAIL: application table was restored after refusal' >&2; exit 1; }
  compose run --rm --no-deps -T --entrypoint node app scripts/data-archive.mjs empty /data
}
assert_empty() {
  [ "$(object_count)" = 0 ] || { echo 'FAIL: target database is not empty' >&2; exit 1; }
  assert_no_restored_data
}
reject_nonempty_database() {
  label=$1
  before=$(object_count)
  [ "$before" -gt 0 ] || { echo 'FAIL: nonempty fixture not detected' >&2; exit 1; }
  expect_failure "$label" 'Restore requires an empty database' "$SCRIPT_DIR/restore.sh" "$WORK/backup" "--confirm-restore=$COMPOSE_PROJECT_NAME"
  [ "$(object_count)" = "$before" ] || { echo 'FAIL: refusal changed database objects' >&2; exit 1; }
  assert_no_restored_data
}
compose up -d postgres
wait_database
compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U feedink_drill -d feedink_drill -c "CREATE TABLE archive_drill (id integer PRIMARY KEY, body text NOT NULL); INSERT INTO archive_drill VALUES (1, 'durable body 中文');" >/dev/null
compose run --rm --no-deps -T --entrypoint node app -e "const f=require('node:fs');f.mkdirSync('/data/images',{recursive:true});f.writeFileSync('/data/images/sample.bin',Buffer.from([0,10,255,42]));"
compose up -d app
expect_failure running-app 'Stop every app instance' "$SCRIPT_DIR/backup.sh" "$WORK/live"
compose stop app
"$SCRIPT_DIR/backup.sh" "$WORK/backup"
expect_failure existing-backup 'Backup destination already exists' "$SCRIPT_DIR/backup.sh" "$WORK/backup"

export COMPOSE_PROJECT_NAME="$GUARD"
compose up -d postgres
wait_database
compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U feedink_drill -d feedink_drill -c "CREATE FUNCTION guard_routine() RETURNS integer LANGUAGE sql AS 'SELECT 1';" >/dev/null
reject_nonempty_database function-only-database
export COMPOSE_PROJECT_NAME="$COLLATION"
compose up -d postgres
wait_database
compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U feedink_drill -d feedink_drill -c 'CREATE COLLATION public.restore_guard FROM pg_catalog."C";' >/dev/null
reject_nonempty_database collation-only-database
export COMPOSE_PROJECT_NAME="$CATALOG"
compose up -d postgres
wait_database
# No user relation, type or function is needed for these database-scoped objects.
compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U feedink_drill -d feedink_drill -c 'CREATE FOREIGN DATA WRAPPER guard_wrapper;' >/dev/null
reject_nonempty_database foreign-data-wrapper-database
compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U feedink_drill -d feedink_drill -c 'CREATE CAST (text AS integer) WITH INOUT;' >/dev/null
[ "$(object_count)" = 2 ] || { echo 'FAIL: built-in-type cast not counted' >&2; exit 1; }
compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U feedink_drill -d feedink_drill -c 'SELECT lo_create(42);' >/dev/null
[ "$(object_count)" = 3 ] || { echo 'FAIL: explicitly low-OID large object not counted' >&2; exit 1; }
reject_nonempty_database catalog-objects-database

export COMPOSE_PROJECT_NAME="$TARGET"
compose up -d postgres
wait_database
expect_failure missing-confirmation 'Restore requires exact target project confirmation' "$SCRIPT_DIR/restore.sh" "$WORK/backup" --confirm-restore=wrong-project
ln -s "$WORK/backup" "$WORK/alias"
expect_failure symlink-bundle 'Backup directory must not be a symlink' "$SCRIPT_DIR/restore.sh" "$WORK/alias" "--confirm-restore=$TARGET"
expect_failure symlink-trailing-slash 'Backup directory must not be a symlink' "$SCRIPT_DIR/restore.sh" "$WORK/alias/" "--confirm-restore=$TARGET"
expect_failure symlink-trailing-slashes 'Backup directory must not be a symlink' "$SCRIPT_DIR/restore.sh" "$WORK/alias///" "--confirm-restore=$TARGET"
assert_empty
"$SCRIPT_DIR/restore.sh" "$WORK/backup" "--confirm-restore=$TARGET"
body=$(compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U feedink_drill -d feedink_drill -Atc 'SELECT body FROM archive_drill WHERE id=1')
[ "$body" = 'durable body 中文' ] || { echo 'FAIL: database body mismatch' >&2; exit 1; }
compose run --rm --no-deps -T --entrypoint node app -e "const f=require('node:fs');if(!f.readFileSync('/data/images/sample.bin').equals(Buffer.from([0,10,255,42])))process.exit(1);"
echo 'PASS: PostgreSQL body and binary archive restored exactly'
expect_failure nonempty-target 'Archive operation failed' "$SCRIPT_DIR/restore.sh" "$WORK/backup" "--confirm-restore=$TARGET"

export COMPOSE_PROJECT_NAME="$CHECKSUM"
compose up -d postgres
wait_database
assert_empty
# This fixture contains one four-byte file. Flip its first payload byte (0 -> 1)
# after the two newline-terminated headers; leave all framing and sizes unchanged.
payload_offset=$(head -n 2 "$WORK/backup/data.archive" | wc -c | tr -d ' ')
size_before=$(wc -c < "$WORK/backup/data.archive")
printf '\001' | dd of="$WORK/backup/data.archive" bs=1 seek="$payload_offset" conv=notrunc 2>/dev/null
[ "$(wc -c < "$WORK/backup/data.archive")" = "$size_before" ] || { echo 'FAIL: corruption changed archive length' >&2; exit 1; }
compose run --rm --no-deps -T --entrypoint node app scripts/data-archive.mjs check < "$WORK/backup/data.archive"
expect_failure corrupted-payload 'Backup checksum mismatch' "$SCRIPT_DIR/restore.sh" "$WORK/backup" "--confirm-restore=$CHECKSUM"
assert_empty
echo 'PASS: framing-valid corruption rejected by checksum; new target database and files remain empty'
export COMPOSE_PROJECT_NAME="$TARGET"
compose run --rm --no-deps -T --entrypoint node app -e "const f=require('node:fs');if(!f.readFileSync('/data/images/sample.bin').equals(Buffer.from([0,10,255,42])))process.exit(1);"
echo 'PASS: failed restores preserved existing data; no resources deleted'
