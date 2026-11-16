#!/bin/sh
# Synthetic only. Do not execute this service drill locally or on a corporate/self-hosted runner.
set -eu
umask 077
[ "${GITHUB_ACTIONS:-}" = true ] && [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || { echo 'Approved GitHub-hosted runner required' >&2; exit 1; }
: "${TEST_IMAGE:?Set TEST_IMAGE to the hosted-built application image}"
export TEST_IMAGE
RESTORE_BACKEND=${STORAGE_RESTORE_BACKEND:-filesystem}
case "$RESTORE_BACKEND" in filesystem) ;; s3) : "${TEST_STORAGE_S3_BUCKET:?Synthetic S3 bucket required}"; : "${TEST_STORAGE_S3_ENDPOINT:?S3 endpoint reachable inside the utility container required}";; *) exit 1;; esac
export DRILL_STORAGE_BACKEND=filesystem DRILL_STORAGE_PREFIX=
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
import { writeFile, readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
assert.notEqual(process.getuid(),0);
const status=await readFile('/proc/self/status','utf8');
assert.match(status,/^CapEff:\s+0+$/m); assert.match(status,/^NoNewPrivs:\s+1$/m);
const rootMount=(await readFile('/proc/mounts','utf8')).split('\n').map(line=>line.split(' ')).find(fields=>fields[1]==='/');
assert.ok(rootMount?.[3].split(',').includes('ro'),'runtime root mount must be read-only');
const db=postgres(process.env.DATABASE_URL), store=new Store('/data');
await migrate(db); await store.init();
const owner=id(), article=id(), image=id(), bytes=Buffer.from([0,10,255,42]), key=hash(bytes);
await db`INSERT INTO users(id,email,name,password_hash) VALUES(${owner},'synthetic@example.invalid','Synthetic','disabled')`;
const sql=await db.reserve();
try {
  const full=new Store('/storage-full'), failed=id(); await full.init();
  await assert.rejects(full.writeTransaction(sql,async put=>{
    await sql`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${failed},${owner},${failed},'Synthetic',now(),'Disk full','https://example.invalid/full','<p>Rollback</p>','Rollback',${hash('rollback')})`;
    await put(Buffer.alloc(2*1024*1024,42));
  }),error=>error.code==='ENOSPC');
  assert.equal((await sql`SELECT id FROM articles WHERE id=${failed}`).length,0,'real ENOSPC must roll back the owned row');
  assert.deepEqual(await readdir(full.stagingDirectory),[]);
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
export COMPOSE_PROJECT_NAME="$TARGET" DRILL_STORAGE_BACKEND="$RESTORE_BACKEND"
export DRILL_STORAGE_PREFIX="${TEST_STORAGE_S3_PREFIX:-}paired-$SOURCE/restored/"
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
# Derive a second synthetic bundle with a malformed part sequence but valid outer checksums.
mkdir -m 700 "$WORK/malformed"
cp -f "$WORK/bundle/postgres.dump" "$WORK/malformed/postgres.dump"
compose run --rm --no-deps -T --entrypoint node app --input-type=module -e '
const chunks=[]; let size=0;
for await (const chunk of process.stdin) { size+=chunk.length; if(size>8192) throw new Error("Synthetic fixture bound exceeded"); chunks.push(chunk); }
const input=Buffer.concat(chunks), from=Buffer.from("\"number\":0"), to=Buffer.from("\"number\":1"), offset=input.indexOf(from);
if(offset<0) throw new Error("Part fixture missing"); to.copy(input,offset); process.stdout.write(input);
' < "$WORK/bundle/blobs.archive" > "$WORK/malformed/blobs.archive"
pg_hash=$(sha256sum < "$WORK/malformed/postgres.dump" | cut -d ' ' -f 1)
blob_hash=$(sha256sum < "$WORK/malformed/blobs.archive" | cut -d ' ' -f 1)
operator manifest "$pg_hash" "$blob_hash" "$before" > "$WORK/malformed/manifest.json"
[ "$(operator verify-manifest < "$WORK/malformed/manifest.json")" = "$pg_hash $blob_hash $before" ] || exit 1
export COMPOSE_PROJECT_NAME="$CORRUPT"
export DRILL_STORAGE_PREFIX="${TEST_STORAGE_S3_PREFIX:-}paired-$SOURCE/corrupt/"
compose up -d postgres; wait_database
if sh "$SCRIPT_DIR/restore.sh" "$WORK/malformed" "--confirm-restore=$CORRUPT" > "$WORK/malformed-refusal.txt" 2>&1; then exit 1; fi
grep -F 'Storage operation failed' "$WORK/malformed-refusal.txt" >/dev/null
if grep -F 'Backup checksum mismatch' "$WORK/malformed-refusal.txt" >/dev/null; then exit 1; fi
[ "$(compose exec -T postgres psql -X -At -U feedink_drill -d feedink_drill < "$SCRIPT_DIR/empty-database.sql")" = 0 ] || exit 1
operator empty
# Change a framed blob payload without changing the file size; manifest checksum must reject before DB/files restore.
offset=$(head -n 2 "$WORK/bundle/blobs.archive" | wc -c | tr -d ' ')
printf '\001' | dd of="$WORK/bundle/blobs.archive" bs=1 seek="$offset" conv=notrunc 2>/dev/null
if sh "$SCRIPT_DIR/restore.sh" "$WORK/bundle" "--confirm-restore=$CORRUPT" > "$WORK/refusal.txt" 2>&1; then exit 1; fi
grep -F 'Backup checksum mismatch' "$WORK/refusal.txt" >/dev/null
[ "$(compose exec -T postgres psql -X -At -U feedink_drill -d feedink_drill < "$SCRIPT_DIR/empty-database.sql")" = 0 ] || exit 1
operator empty
printf '%s\n' "PASS: paired PG/context fingerprints restored to $RESTORE_BACKEND under read-only/capability restrictions; surplus excluded; malformed-valid-checksum/corrupt/nonempty targets refused."
