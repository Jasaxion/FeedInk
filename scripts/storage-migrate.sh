#!/bin/sh
# Configure DATA_DIR/STORAGE_* for source and TARGET_DATA_DIR/TARGET_STORAGE_* for destination in Compose.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/backup-common.sh"
[ "$#" -eq 2 ] || fail 'Usage: scripts/storage-migrate.sh PERSISTENT_CONTAINER_CHECKPOINT_PATH --confirm-maintenance=PROJECT'
[ "$2" = "--confirm-maintenance=$COMPOSE_PROJECT_NAME" ] || fail 'Migration requires exact project confirmation'
require_stopped
storage copy "$1"
printf '%s\n' 'Copy and full reference verification complete. Source retained. Keep writers stopped; switch deployment explicitly, verify destination, then resume.'
