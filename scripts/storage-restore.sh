#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/backup-common.sh"
[ "$#" -eq 2 ] || fail 'Usage: scripts/storage-restore.sh BUNDLE_DIRECTORY --confirm-restore=PROJECT'
[ "$2" = "--confirm-restore=$COMPOSE_PROJECT_NAME" ] || fail 'Restore requires exact target project confirmation'
bundle_path "$1"
[ -d "$BUNDLE" ] || fail 'Backup directory not found'
require_stopped
for name in manifest.json postgres.dump blobs.archive; do
  [ -f "$BUNDLE/$name" ] && [ ! -L "$BUNDLE/$name" ] || fail 'Bundle must contain regular, non-symlink files'
done
expected=$(storage verify-manifest < "$BUNDLE/manifest.json")
# verify-manifest returns only three validated lowercase hex digests, never shell code.
fingerprint=${expected##* }
actual="$(checksum "$BUNDLE/postgres.dump") $(checksum "$BUNDLE/blobs.archive") $fingerprint"
[ "$actual" = "$expected" ] || fail 'Backup checksum mismatch'
[ "$(storage check "$fingerprint" < "$BUNDLE/blobs.archive")" = "$fingerprint" ] || fail 'Bundle fingerprint mismatch'
storage empty
objects=$(compose exec -T postgres sh -c 'psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$SCRIPT_DIR/empty-database.sql")
[ "$objects" = 0 ] || fail 'Restore requires an empty database; use a fresh project'
# SQL and blob restore are not atomic together. Never clean or retry a populated failed target.
compose exec -T postgres sh -c 'pg_restore --single-transaction --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$BUNDLE/postgres.dump"
[ "$(storage fingerprint)" = "$fingerprint" ] || fail 'Restored database fingerprint mismatch; preserve failed target'
[ "$(storage unpack "$fingerprint" < "$BUNDLE/blobs.archive")" = "$fingerprint" ] || fail 'Restored blob fingerprint mismatch; preserve failed target'
storage verify
printf '%s\n' 'Referenced-blob restore complete. Writers remain stopped; verify owner isolation and retained note contexts before startup.'
