#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/backup-common.sh"
[ "$#" -eq 1 ] || fail 'Usage: scripts/backup.sh NEW_BUNDLE_DIRECTORY'
bundle_path "$1"
[ ! -e "$BUNDLE" ] || fail 'Backup destination already exists; choose a new directory'
require_stopped
mkdir -m 700 -- "$BUNDLE"
# Failure leaves an incomplete bundle WITHOUT a manifest; no cleanup deletes evidence.
trap 'printf "%s\n" "Backup interrupted. App remains stopped; incomplete bundle retained." >&2' HUP INT TERM
compose exec -T postgres sh -c 'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$BUNDLE/postgres.dump"
archive pack /data > "$BUNDLE/data.archive"
# Stream metadata; no host Node installation, privileged helper or host-volume ownership changes.
archive manifest "$(checksum "$BUNDLE/postgres.dump")" "$(checksum "$BUNDLE/data.archive")" > "$BUNDLE/manifest.json"
printf '%s\n' 'Backup complete. Keep the bundle private and encrypted off-host. App remains stopped.'
