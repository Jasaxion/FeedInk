#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/backup-common.sh"
[ "$#" -eq 2 ] || fail 'Usage: scripts/storage-recover.sh journal|legacy --confirm-maintenance=PROJECT'
[ "$2" = "--confirm-maintenance=$COMPOSE_PROJECT_NAME" ] || fail 'Recovery requires exact project confirmation'
require_stopped
case "$1" in
  journal) storage recover ;;
  legacy) storage recover-legacy ;;
  *) fail 'Choose journal or legacy recovery' ;;
esac
printf '%s\n' 'Staging recovery complete. Published objects were not deleted. Writers remain stopped.'
