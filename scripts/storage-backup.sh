#!/bin/sh
# Version2 paired PostgreSQL + referenced-blob bundle. No full-volume or online-snapshot claim.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/backup-common.sh"
[ "$#" -eq 1 ] || fail 'Usage: scripts/storage-backup.sh NEW_BUNDLE_DIRECTORY'
bundle_path "$1"
[ ! -e "$BUNDLE" ] || fail 'Backup destination already exists; choose a new directory'
require_stopped
mkdir -m 700 -- "$BUNDLE"
trap 'printf "%s\n" "Backup interrupted. Writers must remain stopped; incomplete evidence retained." >&2' HUP INT TERM
fingerprint=$(storage fingerprint)
compose exec -T postgres sh -c 'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$BUNDLE/postgres.dump"
storage pack "$fingerprint" > "$BUNDLE/blobs.archive"
[ "$(storage check "$fingerprint" < "$BUNDLE/blobs.archive")" = "$fingerprint" ] || fail 'Bundle fingerprint mismatch'
[ "$(storage fingerprint)" = "$fingerprint" ] || fail 'Database changed during backup'
storage manifest "$(checksum "$BUNDLE/postgres.dump")" "$(checksum "$BUNDLE/blobs.archive")" "$fingerprint" > "$BUNDLE/manifest.json"
printf '%s\n' 'Referenced-blob backup complete. Unreferenced volume objects/journals are NOT included. Keep private; writers remain stopped.'
