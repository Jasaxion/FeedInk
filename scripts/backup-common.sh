#!/bin/sh
# Sourced by backup/restore. Never source .env or evaluate operator-supplied commands.
set -eu
umask 077
fail() { printf '%s\n' "$1" >&2; exit 1; }
: "${COMPOSE_PROJECT_NAME:?Set COMPOSE_PROJECT_NAME to the deployment project name}"
case "$COMPOSE_PROJECT_NAME" in ''|*[!a-z0-9_-]*|[-_]*) fail 'Invalid Compose project name';; esac
COMPOSE_FILE=${COMPOSE_FILE:-compose.yaml}
ENV_FILE=${ENV_FILE:-.env}
CONTAINER_ENGINE=${CONTAINER_ENGINE:-docker}
case "$CONTAINER_ENGINE" in docker|podman) ;; *) fail 'CONTAINER_ENGINE must be docker or podman';; esac
[ -f "$COMPOSE_FILE" ] || fail 'Compose file not found'
[ -f "$ENV_FILE" ] || fail 'Environment file not found'
compose() { "$CONTAINER_ENGINE" compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
require_stopped() {
  app_ids=$(compose ps --all --quiet app) || fail 'Cannot inspect Compose app instances'
  for container in $app_ids; do
    status=$("$CONTAINER_ENGINE" inspect --format '{{.State.Status}}' "$container") || fail 'Cannot inspect app state'
    case "$status" in created|exited) ;; *) fail 'Stop every app instance and external writer before backup or restore';; esac
  done
  running=$(compose ps --status running --services) || fail 'Cannot inspect Compose services'
  printf '%s\n' "$running" | grep -qx postgres || fail 'Start postgres (only) and wait for readiness first'
  compose exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null || fail 'PostgreSQL is not ready'
}
# Refuse ambiguous bind syntax, symlink destinations and root. Parent must already exist.
bundle_path() {
  case "$1" in ''|/|*:*|*,*) fail 'Use a non-root backup path without colon or comma';; esac
  [ ! -L "$1" ] || fail 'Backup directory must not be a symlink'
  parent=$(CDPATH= cd -- "$(dirname -- "$1")" && pwd -P) || fail 'Backup parent does not exist'
  name=$(basename -- "$1")
  case "$name" in .|..|''|*[!a-zA-Z0-9._-]*) fail 'Use a simple backup directory name';; esac
  BUNDLE="$parent/$name"
  # A trailing slash makes test -L follow a directory link; recheck its slash-free spelling.
  [ ! -L "$BUNDLE" ] || fail 'Backup directory must not be a symlink'
}
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | cut -d ' ' -f 1
  else fail 'Install sha256sum or shasum'; fi
}
archive() {
  # Runtime image owns /data as uid1000. Utility mounts do not need root or a Docker socket.
  compose run --rm --no-deps -T --entrypoint node app scripts/data-archive.mjs "$@"
}
