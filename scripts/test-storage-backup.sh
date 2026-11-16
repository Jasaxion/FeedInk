#!/bin/sh
# Synthetic only. Do not execute this service drill locally or on a corporate/self-hosted runner.
set -eu
umask 077
[ "${GITHUB_ACTIONS:-}" = true ] && [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || { echo 'Approved GitHub-hosted runner required' >&2; exit 1; }
: "${TEST_IMAGE:?Set TEST_IMAGE to the hosted-built application image}"
export TEST_IMAGE
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/feedink-storage-drill.XXXXXXXX")
export ENV_FILE="$WORK/synthetic.env" COMPOSE_FILE="$SCRIPT_DIR/storage-test.compose.yaml"
export CONTAINER_ENGINE=docker
printf 'POSTGRES_PASSWORD=%s\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" > "$ENV_FILE"
SOURCE="feedink-storage-$(date +%s)-$$"; TARGET="$SOURCE-restored"; CORRUPT="$SOURCE-corrupt"
export COMPOSE_PROJECT_NAME="$SOURCE"
compose() { docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
finish() {
  for project in "$SOURCE" "$TARGET" "$CORRUPT"; do COMPOSE_PROJECT_NAME="$project" compose stop >/dev/null 2>&1 || :; done
  printf '%s\n' 'Synthetic drill targets stopped, not deleted. Retain only sanitized summaries as CI evidence.'
}
trap finish EXIT
wait_database() {
  tries=0
  until compose exec -T postgres pg_isready -U feedink_drill -d feedink_drill >/dev/null 2>&1; do
    tries=$((tries + 1)); [ "$tries" -lt 90 ] || exit 1; sleep 2
  done
}
operator() { compose run --rm --no-deps -T -e STORAGE_MAINTENANCE=stopped --entrypoint node app apps/api/dist/storage/operator.js "$@"; }
compose up -d postgres; wait_database
compose run --rm --no-deps -T --entrypoint node app --input-type=module <<'JS'
import postgres from 'postgres';
import { Store, migrate, hash, id } from './apps/api/dist/core.js';
import { writeFile } from 'node:fs/promises';
const db=postgres(process.env.DATABASE_URL), store=new Store('/data');
await migrate(db); await store.init();
const owner=id(), article=id(), image=id(), bytes=Buffer.from([0,10,255,42]), key=hash(bytes);
await db`INSERT INTO users(id,email,name,password_hash) VALUES(${owner},'synthetic@example.invalid','Synthetic','disabled')`;
const sql=await db.reserve();
try {
  await store.writeTransaction(sql, async put => {
    await put(bytes);
    await sql`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${article},${owner},'synthetic','Synthetic',now(),'Body','https://example.invalid/body','<p>Preserved 中文</p>','Preserved 中文',${hash('<p>Preserved 中文</p>')})`;
    await sql`INSERT INTO images(id,article_id,original_url,status,file_key,content_hash,content_type) VALUES(${image},${article},'https://example.invalid/image','cached',${key},${key},'image/png')`;
    await sql`INSERT INTO annotation_contexts(user_id,article_id,mode,content_hash,source_url,title,content_html) VALUES(${owner},${article},'feed',${hash('old retained-only')},'https://example.invalid/old','Retained offline draft','<p>Old context</p>')`;
  });
} finally { sql.release(); await db.end(); }
await writeFile('/data/unreferenced-volume-file', 'not part of referenced-blob recovery');
JS
before=$(operator fingerprint)
sh "$SCRIPT_DIR/storage-backup.sh" "$WORK/bundle"
# Backup must refuse existing destinations without deleting evidence.
if sh "$SCRIPT_DIR/storage-backup.sh" "$WORK/bundle" >/dev/null 2>&1; then exit 1; fi
export COMPOSE_PROJECT_NAME="$TARGET"
compose up -d postgres; wait_database
sh "$SCRIPT_DIR/restore.sh" "$WORK/bundle" "--confirm-restore=$TARGET"
[ "$(operator fingerprint)" = "$before" ] || exit 1
operator verify
compose run --rm --no-deps -T --entrypoint node app --input-type=module <<'JS'
import { access } from 'node:fs/promises';
try { await access('/data/unreferenced-volume-file'); process.exit(1); } catch (error) { if(error.code!=='ENOENT') throw error; }
JS
if sh "$SCRIPT_DIR/restore.sh" "$WORK/bundle" "--confirm-restore=$TARGET" >/dev/null 2>&1; then exit 1; fi
[ "$(operator fingerprint)" = "$before" ] || exit 1
export COMPOSE_PROJECT_NAME="$CORRUPT"
compose up -d postgres; wait_database
# Change a framed blob payload without changing the file size; manifest checksum must reject before DB/files restore.
offset=$(head -n 2 "$WORK/bundle/blobs.archive" | wc -c | tr -d ' ')
printf '\001' | dd of="$WORK/bundle/blobs.archive" bs=1 seek="$offset" conv=notrunc 2>/dev/null
if sh "$SCRIPT_DIR/restore.sh" "$WORK/bundle" "--confirm-restore=$CORRUPT" > "$WORK/refusal.txt" 2>&1; then exit 1; fi
grep -F 'Backup checksum mismatch' "$WORK/refusal.txt" >/dev/null
[ "$(compose exec -T postgres psql -X -At -U feedink_drill -d feedink_drill < "$SCRIPT_DIR/empty-database.sql")" = 0 ] || exit 1
operator empty
printf '%s\n' 'PASS: paired PG/context fingerprints and exact referenced bytes restored; source surplus excluded; corrupt/nonempty targets refused.'
