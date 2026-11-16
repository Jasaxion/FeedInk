#!/bin/sh
# Synthetic only. Do not execute this service drill locally or on a corporate/self-hosted runner.
set -eu
umask 077
[ "${GITHUB_ACTIONS:-}" = true ] && [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || { echo 'Approved GitHub-hosted runner required' >&2; exit 1; }
: "${TEST_IMAGE:?Set TEST_IMAGE to the hosted-built application image}"
export TEST_IMAGE
SOURCE_BACKEND=${STORAGE_SOURCE_BACKEND:-filesystem}
RESTORE_BACKEND=${STORAGE_RESTORE_BACKEND:-filesystem}
INTERRUPTION=${STORAGE_S3_INTERRUPTION:-false}
case "$INTERRUPTION" in true|false) ;; *) exit 1;; esac
for backend in "$SOURCE_BACKEND" "$RESTORE_BACKEND"; do
  case "$backend" in filesystem) ;; s3) : "${TEST_STORAGE_S3_BUCKET:?Synthetic S3 bucket required}"; : "${TEST_STORAGE_S3_ENDPOINT:?S3 endpoint reachable inside the utility container required}";; *) exit 1;; esac
done
if [ "$INTERRUPTION" = true ]; then
  [ "$SOURCE_BACKEND" = s3 ] && [ "${TEST_STORAGE_S3_ENDPOINT:-}" = http://host.docker.internal:19000 ] &&
    [ "${TEST_STORAGE_S3_ALLOW_HTTP:-}" = true ] || { echo 'Interruption requires the explicit synthetic S3 source on host.docker.internal:19000' >&2; exit 1; }
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/feedink-storage-drill.XXXXXXXX")
export ENV_FILE="$WORK/synthetic.env" COMPOSE_FILE="$SCRIPT_DIR/storage-test.compose.yaml"
export CONTAINER_ENGINE=docker
printf 'POSTGRES_PASSWORD=%s\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" > "$ENV_FILE"
# Random per-run project/prefix names; never reuse another drill's database, volume or objects.
nonce=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
SOURCE="feedink-storage-$nonce"; TARGET="$SOURCE-restored"; CORRUPT="$SOURCE-corrupt"
SOURCE_PREFIX="${TEST_STORAGE_S3_PREFIX:-}paired-$SOURCE/source/"
SOURCE_ENDPOINT=${TEST_STORAGE_S3_ENDPOINT:-}
if [ "$INTERRUPTION" = true ]; then SOURCE_ENDPOINT=http://s3-interruption-proxy:9000; fi
select_source() {
  export COMPOSE_PROJECT_NAME="$SOURCE" DRILL_STORAGE_BACKEND="$SOURCE_BACKEND"
  export DRILL_STORAGE_PREFIX="$SOURCE_PREFIX" DRILL_STORAGE_ENDPOINT="$SOURCE_ENDPOINT"
}
select_target() {
  export COMPOSE_PROJECT_NAME="$1" DRILL_STORAGE_BACKEND="$RESTORE_BACKEND"
  export DRILL_STORAGE_PREFIX="${TEST_STORAGE_S3_PREFIX:-}paired-$SOURCE/$2/" DRILL_STORAGE_ENDPOINT="${TEST_STORAGE_S3_ENDPOINT:-}"
}
select_source
compose() { docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
finish() {
  for project in "$SOURCE" "$TARGET" "$CORRUPT"; do COMPOSE_PROJECT_NAME="$project" compose --profile interruption stop >/dev/null 2>&1 || :; done
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
proxy() { compose exec -T s3-interruption-proxy node /fixture/proxy.mjs "$@"; }
assert_safe_failure() {
  # Inspect privately; never echo raw SDK errors, object keys, credentials or SQL fixture content.
  node --input-type=module - "$1" "$2" <<'JS'
import { readFileSync } from 'node:fs';
const text=readFileSync(process.argv[2],'utf8');
const privateValues=['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','TEST_STORAGE_S3_BUCKET','TEST_STORAGE_S3_ENDPOINT','DRILL_STORAGE_ENDPOINT','DRILL_STORAGE_PREFIX'].map(name=>process.env[name]).filter(Boolean);
for(const name of ['TEST_STORAGE_S3_ENDPOINT','DRILL_STORAGE_ENDPOINT']) {
  if(process.env[name]) privateValues.push(new URL(process.env[name]).hostname);
}
privateValues.push(readFileSync(process.env.ENV_FILE,'utf8').split('\n').find(line=>line.startsWith('POSTGRES_PASSWORD=')).slice('POSTGRES_PASSWORD='.length));
if(!text.includes(process.argv[3]) || privateValues.some(value=>text.includes(value)) || /\b[a-f0-9]{64}\b/.test(text) || /Preserved 中文|Retained offline draft|example\.invalid|Credential=|X-Amz-Signature/i.test(text)) {
  console.error('Unsafe or unexpected synthetic failure output'); process.exit(1);
}
JS
}
if [ "$INTERRUPTION" = true ]; then
  # Hosted-only event/socket regressions; the existing parent interruption hook runs these too.
  node --test --test-concurrency=1 "$SCRIPT_DIR/storage-s3-interruption-proxy.test.mjs"
fi
compose up -d postgres; wait_database
if [ "$INTERRUPTION" = true ]; then
  compose --profile interruption up -d s3-interruption-proxy
  tries=0
  until proxy ready >/dev/null 2>&1; do
    tries=$((tries + 1)); [ "$tries" -lt 30 ] || exit 1; sleep 1
  done
fi
# Both /data (image-owned volume) and /storage-full (test tmpfs) are provisioned roots.
operator empty
compose run --rm --no-deps -T --entrypoint node app --input-type=module <<'JS'
import postgres from 'postgres';
import { Store, migrate, hash, id } from './apps/api/dist/core.js';
import { storageConfigFromEnv } from './apps/api/dist/storage/config.js';
import { writeFile, readFile, readdir, access } from 'node:fs/promises';
import assert from 'node:assert/strict';
assert.notEqual(process.getuid(),0);
const status=await readFile('/proc/self/status','utf8');
assert.match(status,/^CapEff:\s+0+$/m); assert.match(status,/^NoNewPrivs:\s+1$/m);
const rootMount=(await readFile('/proc/mounts','utf8')).split('\n').map(line=>line.split(' ')).find(fields=>fields[1]==='/');
assert.ok(rootMount?.[3].split(',').includes('ro'),'runtime root mount must be read-only');
const config=storageConfigFromEnv();
assert.equal(config?.backend,process.env.STORAGE_BACKEND);
const db=postgres(process.env.DATABASE_URL), store=new Store('/data',config);
assert.deepEqual(store.config,config);
// Private fixture record binds later source checks to the same selected backend and prefix.
await writeFile('/data/storage-drill-source-config.json',JSON.stringify(store.config),{flag:'wx',mode:0o600});
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
  assert.deepEqual(await store.get(key),bytes);
  if(config.backend==='s3') {
    // A passing S3-source pack cannot accidentally read a seeded local fallback object.
    for(const path of [`/data/${key}`,`/data/${key.slice(0,2)}/${key.slice(2,4)}/${key}`])
      await assert.rejects(access(path),error=>error.code==='ENOENT');
  }
} finally { sql.release(); await db.end(); }
await writeFile('/data/unreferenced-volume-file', 'not part of referenced-blob recovery');
JS
before=$(operator fingerprint)
before_objects=$(operator verify)
if [ "$INTERRUPTION" = true ]; then
  proxy arm
  # GNU timeout is available on the approved Ubuntu runner. Timeout is a failed witness, not success.
  result=0
  timeout --signal=TERM --kill-after=10s 90s sh "$SCRIPT_DIR/storage-backup.sh" "$WORK/interrupted" > "$WORK/interrupted.txt" 2>&1 || result=$?
  [ "$result" -ne 0 ] && [ "$result" -ne 124 ] && [ "$result" -ne 137 ] || exit 1
  assert_safe_failure "$WORK/interrupted.txt" 'Storage operation failed'
  [ -s "$WORK/interrupted/postgres.dump" ] && [ -s "$WORK/interrupted/blobs.archive" ] && [ ! -e "$WORK/interrupted/manifest.json" ] || exit 1
  partial_hashes=$(sha256sum "$WORK/interrupted/postgres.dump" "$WORK/interrupted/blobs.archive")
  node --input-type=module - "$SCRIPT_DIR/storage-s3-interruption-proxy.mjs" "$WORK/interrupted/blobs.archive" <<'JS'
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
try {
  const { isExactFixturePartialArchive }=await import(pathToFileURL(process.argv[2]).href);
  if((await stat(process.argv[3])).size>512 || !isExactFixturePartialArchive(await readFile(process.argv[3]))) throw new Error();
  console.log('Witness: partial archive has exact source framing and one actual payload byte only');
} catch { console.error('Exact partial archive witness failed'); process.exitCode=1; }
JS
  proxy assert-interrupted
  # Explicitly test refusal, NOT a retry into or cleanup of a nonempty failed output.
  if sh "$SCRIPT_DIR/storage-backup.sh" "$WORK/interrupted" > "$WORK/interrupted-reuse.txt" 2>&1; then exit 1; fi
  assert_safe_failure "$WORK/interrupted-reuse.txt" 'Backup destination already exists'
  if operator check "$before" < "$WORK/interrupted/blobs.archive" > "$WORK/partial-check.txt" 2>&1; then exit 1; fi
  assert_safe_failure "$WORK/partial-check.txt" 'Storage operation failed'
  # Streaming SDK errors need not retry: make both real signed refusal requests explicitly.
  compose run --rm --no-deps -T --entrypoint node app --input-type=module <<'JS'
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { storageConfigFromEnv } from './apps/api/dist/storage/config.js';
import { fanoutKey } from './apps/api/dist/storage/backend.js';
import { hash } from './apps/api/dist/core.js';
const config=storageConfigFromEnv();
const client=new S3Client({region:config.region,endpoint:config.endpoint,forcePathStyle:config.forcePathStyle,maxAttempts:1,
  requestHandler:{connectionTimeout:2000,requestTimeout:5000},logger:{debug(){},info(){},warn(){},error(){}}});
try {
  const address={Bucket:config.bucket,Key:config.prefix+fanoutKey(hash(Buffer.from([0,10,255,42])))};
  for(const Command of [HeadObjectCommand,GetObjectCommand]) {
    let refused=false;
    try { const result=await client.send(new Command(address)); result.Body?.destroy(); }
    catch(error) { refused=error?.$metadata?.httpStatusCode===503; }
    if(!refused) throw new Error();
  }
} catch { console.error('Blocked source HEAD/GET witness failed'); process.exitCode=1; }
finally { client.destroy(); }
JS
  proxy assert-blocked
  proxy recover
  [ "$(operator fingerprint)" = "$before" ] && [ "$(operator verify)" = "$before_objects" ] || exit 1
  compose run --rm --no-deps -T --entrypoint node app --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Store, hash } from './apps/api/dist/core.js';
import { storageConfigFromEnv } from './apps/api/dist/storage/config.js';
const saved=JSON.parse(await readFile('/data/storage-drill-source-config.json','utf8'));
assert.deepEqual(saved,storageConfigFromEnv());
const bytes=Buffer.from([0,10,255,42]);
assert.deepEqual(await new Store('/data',saved).get(hash(bytes)),bytes);
JS
  select_target "$CORRUPT" corrupt
  compose up -d postgres; wait_database
  if sh "$SCRIPT_DIR/restore.sh" "$WORK/interrupted" "--confirm-restore=$CORRUPT" > "$WORK/partial-restore.txt" 2>&1; then exit 1; fi
  assert_safe_failure "$WORK/partial-restore.txt" 'Bundle must contain regular, non-symlink files'
  [ "$(compose exec -T postgres psql -X -At -U feedink_drill -d feedink_drill < "$SCRIPT_DIR/empty-database.sql")" = 0 ] || exit 1
  operator empty
  [ "$(sha256sum "$WORK/interrupted/postgres.dump" "$WORK/interrupted/blobs.archive")" = "$partial_hashes" ] && [ ! -e "$WORK/interrupted/manifest.json" ] || exit 1
  select_source
fi
# Recovery always packs to a NEW output directory, then restores into a NEW project/prefix.
sh "$SCRIPT_DIR/storage-backup.sh" "$WORK/bundle"
# Backup must refuse existing destinations without deleting evidence.
if sh "$SCRIPT_DIR/storage-backup.sh" "$WORK/bundle" >/dev/null 2>&1; then exit 1; fi
select_target "$TARGET" restored
compose up -d postgres; wait_database
sh "$SCRIPT_DIR/restore.sh" "$WORK/bundle" "--confirm-restore=$TARGET"
[ "$(operator fingerprint)" = "$before" ] || exit 1
operator verify
compose run --rm --no-deps -T --entrypoint node app --input-type=module <<'JS'
import { access } from 'node:fs/promises';
for(const path of ['/data/unreferenced-volume-file','/data/storage-drill-source-config.json']) {
  try { await access(path); process.exit(1); } catch (error) { if(error.code!=='ENOENT') throw error; }
}
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
select_target "$CORRUPT" corrupt
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
# The source remains available and byte/reference-identical after recovery and refusal checks.
select_source
[ "$(operator fingerprint)" = "$before" ] && [ "$(operator verify)" = "$before_objects" ] || exit 1
if [ "$INTERRUPTION" = true ]; then
  [ "$(sha256sum "$WORK/interrupted/postgres.dump" "$WORK/interrupted/blobs.archive")" = "$partial_hashes" ] || exit 1
  printf '%s\n' 'PASS: genuine S3 GET interrupted after one forwarded byte; bounded backup failure, safe error, retained partial-output refusal, unchanged source and fresh-output/target recovery.'
fi
printf '%s\n' "PASS: paired $SOURCE_BACKEND -> $RESTORE_BACKEND PG/context fingerprints restored under read-only/capability restrictions; surplus excluded; malformed-valid-checksum/corrupt/nonempty targets refused."
