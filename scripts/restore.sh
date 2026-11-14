#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/backup-common.sh"
[ "$#" -eq 2 ] || fail 'Usage: scripts/restore.sh BUNDLE_DIRECTORY --confirm-restore=PROJECT'
[ "$2" = "--confirm-restore=$COMPOSE_PROJECT_NAME" ] || fail 'Restore requires exact target project confirmation'
bundle_path "$1"
[ -d "$BUNDLE" ] || fail 'Backup directory not found'
require_stopped
# Verify the entire archive before touching the target; neither input links nor archive paths are trusted.
for name in manifest.json postgres.dump data.archive; do
  [ -f "$BUNDLE/$name" ] && [ ! -L "$BUNDLE/$name" ] || fail 'Bundle must contain regular, non-symlink files'
done
expected=$(archive verify-manifest < "$BUNDLE/manifest.json")
actual="$(checksum "$BUNDLE/postgres.dump") $(checksum "$BUNDLE/data.archive")"
[ "$actual" = "$expected" ] || fail 'Backup checksum mismatch'
archive check < "$BUNDLE/data.archive"
archive empty /data
objects=$(compose exec -T postgres sh -c 'psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$SCRIPT_DIR/empty-database.sql")
[ "$objects" = 0 ] || fail 'Restore requires an empty database; use a fresh project, never delete live data'
# No --clean, DROP DATABASE, rm, or automatic target cleanup. An unsuccessful restore leaves the app stopped.
compose exec -T postgres sh -c 'pg_restore --single-transaction --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$BUNDLE/postgres.dump"
archive unpack /data < "$BUNDLE/data.archive"
printf '%s\n' 'Restore complete. App remains stopped. Start it deliberately and verify health, users, bodies and images.'
