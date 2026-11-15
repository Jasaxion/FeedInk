import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { type Config, hash, withConnection } from '../src/core.js';
import { makeZip, readZip } from '../src/zip.js';
import { Annotations, canonicalAnnotationHash } from '../src/annotations.js';

// CI owns an isolated PostgreSQL database. One connection exposes accidental pool re-entry.
test('PostgreSQL annotations: CAS, history, tenant binding, portable archives and atomic insert-only restore', { skip: !process.env.TEST_DATABASE_URL, timeout: 180000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'feedink-notes-test-'));
  const config: Config = { databaseUrl: process.env.TEST_DATABASE_URL!, dataDir, appUrl: 'http://localhost:3000', sessionSecret: 'synthetic-annotation-test-secret-at-least-32', host: '127.0.0.1', port: 0, registration: true, fetchAllowHosts: [], webDir: join(dataDir, 'no-web'), worker: false };
  const db = postgres(config.databaseUrl, { max: 1 });
  const { app, annotations, archives, store } = await createApp(config, db);
  const users: string[] = [];
  const register = async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `notes-${randomUUID()}@example.invalid`, password: 'synthetic-password-long', name: 'Synthetic reader' } });
    assert.equal(response.statusCode, 201);
    const body = response.json(); users.push(body.user.id);
    return { id: body.user.id as string, cookie: String(response.headers['set-cookie']).split(';')[0], csrf: body.csrfToken as string };
  };
  type Account = Awaited<ReturnType<typeof register>>;
  const request = (account: Account, method: string, path: string, payload?: any, revision?: number, headers: Record<string, string> = {}) => app.inject({ method: method as any, url: `/api${path}`, payload, headers: { cookie: account.cookie, 'x-csrf-token': account.csrf, ...(revision === undefined ? {} : { 'if-match': `"${revision}"` }), ...headers } });
  try {
    const a = await register(), b = await register(), c = await register();
    const articleId = randomUUID(), imageId = randomUUID(), otherId = randomUUID(), url = 'https://example.invalid/notes-source';
    const html = `<p>Synthetic first snapshot</p><img src="/api/assets/${imageId}" />`;
    await withConnection(db, sql => store.writeTransaction(sql, async put => {
      await sql`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${articleId},${a.id},${articleId},'Synthetic feed',now(),'Synthetic title',${url},${html},'Synthetic first snapshot',${hash(html)})`;
      const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } }).png().toBuffer(), key = await put(png);
      await sql`INSERT INTO images(id,article_id,original_url,status,file_key,content_type,content_hash) VALUES(${imageId},${articleId},'https://example.invalid/picture.png','cached',${key},'image/png',${key})`;
      await sql`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${otherId},${b.id},${otherId},'Synthetic feed',now(),'Other tenant','https://example.invalid/other','<p>Other content</p>','Other content',${hash('other')})`;
    }));
    const initial = (await request(a, 'GET', `/articles/${articleId}/annotations?mode=feed`)).json();
    const payload = { schemaVersion: 1, contentHash: initial.contentHash, ink: { version: 1, url, title: 'Synthetic title', layoutWidth: 800, updatedAt: 1, strokes: [{ id: 'stroke', tool: 'pen', color: '#123456', width: 2, opacity: 1, points: [{ x: 10, y: 10, p: 0.5 }], anchor: { kind: 'unrecognized-fixture', identity: 'retained' } }] }, marks: [{ id: 'note', kind: 'note', color: 'yellow', anchor: null, text: 'Searchable synthetic remark', createdAt: 1, updatedAt: 1 }] };
    const path = `/articles/${articleId}/annotations?mode=feed`;
    let oldBackup: any;
    await t.test('owned absent contexts, mandatory CSRF/CAS and concurrent first saves', async () => {
      assert.equal(initial.id, null); assert.equal(initial.revision, 0);
      assert.equal((await request(b, 'GET', path)).statusCode, 404);
      assert.equal((await request(a, 'PUT', path, payload)).statusCode, 428);
      assert.equal((await request(a, 'PUT', path, payload, 0, { 'x-csrf-token': '' })).statusCode, 403);
      const raced = await Promise.all([request(a, 'PUT', path, payload, 0), request(a, 'PUT', path, payload, 0)]);
      assert.deepEqual(raced.map(r => r.statusCode).sort(), [200, 412]);
      const current = (await request(a, 'GET', path)).json();
      assert.equal(current.revision, 1); assert.deepEqual(current.ink, payload.ink);
      assert.equal(current.context.contentHtml, html);
      const malformed = structuredClone(payload); malformed.ink.url += '/wrong';
      assert.equal((await request(a, 'PUT', path, malformed, 1)).statusCode, 422);
      assert.equal((await request(a, 'GET', path)).json().revision, 1);
      const brokenUtf8 = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
      assert.equal((await request(a, 'PUT', path, brokenUtf8, 1, { 'content-type': 'application/json' })).statusCode, 400);
      assert.equal((await request(a, 'GET', path)).json().revision, 1);
      assert.equal((await request(b, 'PUT', path, payload, 1)).statusCode, 404);
      const search = (await request(a, 'GET', '/annotations?q=synthetic')).json();
      assert.equal(search.total, 1); assert.equal(search.items[0].articleId, articleId);
      assert.equal((await request(b, 'GET', '/annotations?q=synthetic')).json().total, 0);
      const json = await request(a, 'GET', `/articles/${articleId}/annotations/export?format=json`);
      oldBackup = json.json();
      assert.deepEqual(oldBackup.ink, payload.ink);
      assert.ok(!json.body.includes(a.cookie)); assert.ok(!json.body.includes(a.id));
      const zip = await request(a, 'GET', `/articles/${articleId}/annotations/export?format=markdown`);
      const files = await readZip(zip.rawPayload);
      assert.ok(files.has('ink/group-0.png')); assert.ok(files.has('notes.json'));
      const preview = await request(a, 'GET', `/articles/${articleId}/annotations/preview?group=0`);
      assert.equal(preview.statusCode, 200); assert.equal(preview.headers['x-ink-placement'], 'raw-unlocated');
      assert.equal((await sharp(preview.rawPayload).metadata()).format, 'png');
    });
    await t.test('new content retains old snapshots, revisions and deletion tombstones', async () => {
      await db`UPDATE articles SET content_html='<p>Second snapshot</p>',content_text='Second snapshot',content_hash=${hash('second')} WHERE id=${articleId}`;
      const current = (await request(a, 'GET', path)).json();
      assert.notEqual(current.contentHash, initial.contentHash); assert.equal(current.revision, 0);
      assert.equal((await request(a, 'PUT', path, { ...payload, contentHash: current.contentHash }, 0)).statusCode, 200);
      const historical = (await request(a, 'GET', `${path}&contentHash=${initial.contentHash}`)).json();
      assert.equal(historical.context.contentHtml, html); assert.equal(historical.revision, 1);
      const versions = (await request(a, 'GET', `/articles/${articleId}/annotation-versions?limit=1`)).json();
      assert.equal(versions.total, 2); assert.equal(versions.nextOffset, 1);
      assert.equal((await request(a, 'GET', '/annotations?limit=1')).json().nextOffset, 1);
      const deleted = await request(a, 'DELETE', `${path}&contentHash=${initial.contentHash}`, undefined, 1);
      assert.equal(deleted.statusCode, 200); assert.equal(deleted.json().revision, 2); assert.deepEqual(deleted.json().marks, []);
      assert.equal((await request(a, 'PUT', path, payload, 1)).statusCode, 412);
      const restored = await request(a, 'POST', `/articles/${articleId}/annotations/import`, oldBackup, 2);
      assert.equal(restored.statusCode, 200); assert.equal(restored.json().revision, 3); assert.deepEqual(restored.json().ink, payload.ink);
      assert.equal((await request(a, 'POST', `/articles/${articleId}/annotations/import`, { ...oldBackup, source: { ...oldBackup.source, url: url + '/wrong' } }, 3)).statusCode, 422); // internally inconsistent source/ink URLs
      const wrongSource = { ...oldBackup, source: { ...oldBackup.source, url: url + '/wrong' }, ink: { ...oldBackup.ink, url: url + '/wrong' } };
      assert.equal((await request(a, 'POST', `/articles/${articleId}/annotations/import`, wrongSource, 3)).statusCode, 409);
      assert.equal((await request(b, 'POST', `/articles/${otherId}/annotations/import`, oldBackup, 0)).statusCode, 409);
      assert.equal((await request(a, 'PUT', path, { ...payload, contentHash: 'b'.repeat(64) }, 0)).statusCode, 409);
    });
    await t.test('feed and fulltext are isolated even when their HTML is identical', async () => {
      assert.equal((await request(b, 'GET', `/articles/${otherId}/annotations?mode=fulltext`)).statusCode, 409);
      await db`UPDATE articles SET fulltext_html=content_html,fulltext_hash=content_hash WHERE id=${otherId}`;
      const feed = await annotations.get(b.id, otherId, 'feed'), full = await annotations.get(b.id, otherId, 'fulltext');
      assert.notEqual(feed.contentHash, full.contentHash);
      const value = { schemaVersion: 1, contentHash: feed.contentHash, ink: null, marks: payload.marks };
      await annotations.save(b.id, otherId, 'feed', value, 0);
      await assert.rejects(() => annotations.save(b.id, otherId, 'fulltext', value, 0), (e: any) => e.code === 'ANNOTATION_CONTEXT');
      await annotations.save(b.id, otherId, 'fulltext', { ...value, contentHash: full.contentHash }, 0);
      assert.equal((await annotations.versions(b.id, otherId, 'feed', 0, 20)).total, 1);
      assert.equal((await annotations.versions(b.id, otherId, 'fulltext', 0, 20)).total, 1);
    });
    await t.test('v3 archive restores snapshots under new IDs, idempotent duplicate notes, and rolls back conflicts', async () => {
      const archive = await archives.export(a.id), files = await readZip(archive), manifest = JSON.parse(files.get('manifest.json')!.toString());
      assert.equal(manifest.version, 3); assert.equal(manifest.articles[0].annotations.length, 2);
      assert.equal((await archives.import(c.id, archive)).imported, 1);
      const [mapped] = await db`SELECT id FROM articles WHERE user_id=${c.id}`;
      assert.notEqual(mapped.id, articleId);
      const doc = await annotations.get(c.id, mapped.id, 'feed', initial.contentHash);
      assert.equal(doc.revision, 3); assert.deepEqual(doc.ink, payload.ink);
      assert.ok(!doc.context.contentHtml.includes(imageId));
      assert.equal((await annotations.get(c.id, mapped.id, 'feed')).contentHash, manifest.articles[0].annotations.find((n: any) => n.backup.source.contentHash !== initial.contentHash).backup.source.contentHash);
      assert.equal((await archives.import(c.id, archive)).skipped, 1);
      const changed = { ...payload, marks: [{ ...payload.marks[0], text: 'Destination edit' }] };
      await annotations.save(c.id, mapped.id, 'feed', changed, 3);
      const before = (await readdir(dataDir)).sort();
      await assert.rejects(() => archives.import(c.id, archive), (e: any) => e.code === 'ANNOTATION_CONFLICT');
      assert.equal((await annotations.get(c.id, mapped.id, 'feed', initial.contentHash)).marks[0].text, 'Destination edit');
      assert.deepEqual((await readdir(dataDir)).sort(), before);
      // A pre-existing article with absent note contexts must restore, not silently skip.
      await db`DELETE FROM annotations WHERE user_id=${c.id}`;
      const [unavailableImage] = await db`SELECT id FROM images WHERE article_id=${mapped.id}`;
      await db`UPDATE images SET status='failed',file_key=null,content_hash=null WHERE id=${unavailableImage.id}`;
      await archives.import(c.id, archive);
      assert.equal((await annotations.versions(c.id, mapped.id, 'feed', 0, 20)).total, 2);
      const restoredImage = await request(c, 'GET', `/assets/${unavailableImage.id}`);
      assert.equal(restoredImage.statusCode, 200);
      const restoredDimensions = await sharp(restoredImage.rawPayload).metadata();
      assert.equal(restoredDimensions.width, 20); assert.equal(restoredDimensions.height, 20);
      for (const version of [1, 2]) {
        const legacy = structuredClone(manifest); legacy.version = version;
        for (const article of legacy.articles) delete article.annotations;
        const userId = randomUUID(); users.push(userId);
        await db`INSERT INTO users(id,email,name,password_hash) VALUES(${userId},${`${userId}@example.invalid`},'Legacy reader','disabled')`;
        const bytes = await makeZip([...files].map(([name, data]) => ({ name, data: name === 'manifest.json' ? Buffer.from(JSON.stringify(legacy)) : data })));
        assert.equal((await archives.import(userId, bytes)).imported, 1);
      }
      const tampered = structuredClone(manifest); tampered.articles[0].annotations[0].contentHtml = '<p>Unrelated replacement</p>';
      const bad = await makeZip([...files].map(([name, data]) => ({ name, data: name === 'manifest.json' ? Buffer.from(JSON.stringify(tampered)) : data })));
      await assert.rejects(() => archives.import(c.id, bad), (e: any) => e.code === 'INVALID_ARCHIVE');
      const invalidUnicode = structuredClone(manifest);
      const record = invalidUnicode.articles[0].annotations[0];
      record.contentHtml = '<p>\ud800</p>';
      record.backup.source.contentHash = canonicalAnnotationHash(record.contentHtml, url, record.backup.source.mode, new Map());
      const invalidBytes = await makeZip([...files].map(([name, data]) => ({ name, data: name === 'manifest.json' ? Buffer.from(JSON.stringify(invalidUnicode)) : data })));
      const countBefore = (await db`SELECT id FROM annotations WHERE user_id=${c.id}`).length;
      await assert.rejects(() => archives.import(c.id, invalidBytes), (e: any) => e.code === 'INVALID_ANNOTATIONS');
      assert.equal((await db`SELECT id FROM annotations WHERE user_id=${c.id}`).length, countBefore);
    });
    await t.test('a verified revision-zero context remains saveable after the current article changes', async () => {
      const owner = await register(), retainedId = randomUUID();
      await db`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${retainedId},${owner.id},${retainedId},'Fixture',now(),'Offline context','https://example.invalid/offline-context','<p>Original context</p>','Original context',${hash('original-context')})`;
      const concurrentDb = postgres(config.databaseUrl, { max: 2 });
      const concurrentNotes = new Annotations(concurrentDb);
      const opened = await Promise.all(Array.from({ length: 4 }, () => concurrentNotes.get(owner.id, retainedId, 'feed'))).finally(() => concurrentDb.end());
      const original = opened[0];
      assert.ok(opened.every(doc => doc.revision === 0 && doc.contentHash === original.contentHash));
      await db`UPDATE articles SET content_html='<p>Changed context</p>',content_text='Changed context',content_hash=${hash('changed-context')} WHERE id=${retainedId}`;
      const historical = await annotations.get(owner.id, retainedId, 'feed', original.contentHash);
      assert.equal(historical.context.contentHtml, '<p>Original context</p>');
      const saved = await annotations.save(owner.id, retainedId, 'feed', { schemaVersion: 1, contentHash: original.contentHash, ink: null, marks: payload.marks }, 0);
      assert.equal(saved.revision, 1);
      const current = await annotations.get(owner.id, retainedId, 'feed');
      assert.notEqual(current.contentHash, saved.contentHash);
      assert.equal(current.revision, 0);
    });
    await t.test('large valid notes retain full late-term search beyond the bounded FTS prefix', async () => {
      const owner = await register(), largeId = randomUUID();
      await db`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${largeId},${owner.id},${largeId},'Fixture',now(),'Large notes','https://example.invalid/large-notes','<p>Large notes</p>','Large notes',${hash('large-notes')})`;
      const context = await annotations.get(owner.id, largeId, 'feed');
      const marks = Array.from({ length: 100 }, (_, index) => ({ id: `large-${index}`, kind: 'note', color: 'yellow', anchor: null, text: Array.from({ length: 2500 }, (_, word) => `word${index}_${word}`).join(' '), createdAt: 1, updatedAt: 1 }));
      marks[99].text += ' latealpha 尾部词 lateomega 100% value_under';
      await annotations.save(owner.id, largeId, 'feed', { schemaVersion: 1, contentHash: context.contentHash, ink: null, marks }, 0);
      for (const query of ['尾部词', 'latealpha lateomega', '100% value_under']) {
        const found = await annotations.list(owner.id, { q: query });
        assert.equal(found.total, 1); assert.equal(found.items[0].articleId, largeId);
        assert.equal((await annotations.list(b.id, { q: query })).total, 0);
      }
    });
  } finally {
    await app.close();
    if (users.length) await db`DELETE FROM users WHERE id IN ${db(users)}`;
    await db.end(); await rm(dataDir, { recursive: true, force: true });
  }
});
