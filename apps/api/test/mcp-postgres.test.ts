import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { type Config, connect, hash, withConnection } from '../src/core.js';

// These tests use the real maintained SDK, a real TCP listener and PostgreSQL, not mocked JSON-RPC.
test('MCP SDK: initialize, scoped discovery, owned reads, immutable principals, token invalidation and secure failures', { skip: !process.env.TEST_DATABASE_URL, timeout: 180000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'feedink-mcp-test-'));
  const config: Config = { databaseUrl: process.env.TEST_DATABASE_URL!, dataDir, appUrl: 'http://127.0.0.1:3000', sessionSecret: 'synthetic-mcp-test-secret-at-least-32-bytes', host: '127.0.0.1', port: 0, registration: true, fetchAllowHosts: [], webDir: join(dataDir, 'no-web'), worker: false };
  const db = connect(config), context = await createApp(config, db), { app, annotations, store } = context;
  config.appUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const users: string[] = [], clients: Client[] = [];
  const register = async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `mcp-${randomUUID()}@example.invalid`, password: 'synthetic-password-long', name: 'Synthetic reader' } });
    assert.equal(response.statusCode, 201); const json = response.json(); users.push(json.user.id);
    return { id: json.user.id as string, headers: { cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': json.csrfToken as string } };
  };
  type Account = Awaited<ReturnType<typeof register>>;
  const issue = async (account: Account, scopes: string[]) => {
    const response = await app.inject({ method: 'POST', url: '/api/mcp-tokens', headers: account.headers, payload: { name: 'Synthetic SDK token', scopes } });
    assert.equal(response.statusCode, 201); return response.json() as { token: string; access: { id: string; expiresAt: string } };
  };
  const client = async (token: string) => {
    const sdk = new Client({ name: 'FeedInk synthetic acceptance client', version: '1.0.0' });
    clients.push(sdk);
    await sdk.connect(new StreamableHTTPClientTransport(new URL(`${config.appUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return sdk;
  };
  const value = (result: any) => {
    assert.ok(!result.isError);
    const text = result.content.find((c: any) => c.type === 'text');
    assert.deepEqual(result.structuredContent, JSON.parse(text.text));
    return result.structuredContent;
  };
  try {
    const a = await register(), b = await register();
    const records: Array<{ articleId: string; imageId: string; user: Account }> = [];
    for (const [account, label] of [[a, 'alpha'], [b, 'beta']] as const) {
      const articleId = randomUUID(), imageId = randomUUID(), url = `https://example.invalid/${label}`;
      await withConnection(db, sql => store.writeTransaction(sql, async put => {
        await sql`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash,summary) VALUES(${articleId},${account.id},${articleId},'Synthetic feed',now(),${label},${url},${`<p>${label} synthetic article</p>`},${`${label} synthetic article`},${hash(label)},${label})`;
        const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#663399' } }).png().toBuffer(), key = await put(png);
        await sql`INSERT INTO images(id,article_id,original_url,status,file_key,content_hash,content_type) VALUES(${imageId},${articleId},${`https://example.invalid/${label}.png`},'cached',${key},${key},'image/png')`;
      }));
      const doc = await annotations.get(account.id, articleId, 'feed');
      await annotations.save(account.id, articleId, 'feed', { schemaVersion: 1, contentHash: doc.contentHash, marks: Array.from({ length: 3 }, (_, i) => ({ id: `${label}-${i}`, kind: 'note', color: 'yellow', anchor: null, text: `${label} synthetic note ${i}`, createdAt: 1, updatedAt: 1 })), ink: { version: 1, url, title: label, updatedAt: 1, layoutWidth: 800, strokes: [{ id: 'stroke', tool: 'pen', color: '#123456', opacity: 1, width: 4, points: [{ x: 20, y: 20, p: 1 }] }] } }, 0);
      records.push({ articleId, imageId, user: account });
    }
    const [ar, br] = records;
    const both = await issue(a, ['articles:read', 'notes:read']), articles = await issue(a, ['articles:read']), notes = await issue(a, ['notes:read']), other = await issue(b, ['articles:read', 'notes:read']);
    const full = await client(both.token), articleClient = await client(articles.token), noteClient = await client(notes.token), otherClient = await client(other.token);
    await t.test('real initialize exposes read-only schemas while calls enforce token scopes', async () => {
      assert.equal(full.getServerVersion()?.name, 'FeedInk');
      const tools = (await full.listTools()).tools;
      assert.deepEqual(tools.map(t => t.name).sort(), ['get_article', 'get_article_image', 'get_note_preview', 'get_notes', 'list_notes', 'search_articles', 'search_notes']);
      assert.ok(tools.every(t => t.annotations?.readOnlyHint && !t.annotations?.destructiveHint));
      assert.deepEqual((await articleClient.listTools()).tools.map(t => t.name).sort(), tools.map(t => t.name).sort());
      assert.deepEqual((await noteClient.listTools()).tools.map(t => t.name).sort(), tools.map(t => t.name).sort());
      const denied = await articleClient.callTool({ name: 'get_notes', arguments: { articleId: ar.articleId } });
      assert.equal(denied.isError, true);
      assert.equal((denied.structuredContent as any).error.code, 'FORBIDDEN');
      const noArticles = await noteClient.callTool({ name: 'get_article', arguments: { articleId: ar.articleId } });
      assert.equal(noArticles.isError, true);
      assert.equal((noArticles.structuredContent as any).error.code, 'FORBIDDEN');
    });
    await t.test('source search, paginated marks, owned image and preview output shapes', async () => {
      const search = value(await full.callTool({ name: 'search_articles', arguments: { query: 'example.invalid/alpha', limit: 1 } }));
      assert.equal(search.total, 1); assert.equal(search.items[0].articleId, ar.articleId);
      const article = value(await full.callTool({ name: 'get_article', arguments: { articleId: ar.articleId, limit: 5 } }));
      assert.equal(article.text, 'alpha'); assert.equal(article.nextOffset, 5);
      const first = value(await full.callTool({ name: 'get_notes', arguments: { articleId: ar.articleId, limit: 2 } }));
      assert.equal(first.document.articleId, ar.articleId); assert.equal(first.document.revision, 1);
      assert.equal(first.ink.strokeCount, 1); assert.equal(first.totalMarks, 3); assert.equal(first.nextOffset, 2);
      assert.equal(first.marks.length, 2); assert.ok(!JSON.stringify(first).includes('contentHtml'));
      const last = value(await full.callTool({ name: 'get_notes', arguments: { articleId: ar.articleId, offset: 2, limit: 2 } }));
      assert.equal(last.marks.length, 1); assert.equal(last.nextOffset, null);
      assert.equal(value(await full.callTool({ name: 'search_notes', arguments: { query: 'alpha synthetic' } })).total, 1);
      assert.equal(value(await full.callTool({ name: 'list_notes', arguments: {} })).total, 1);
      for (const [name, args] of [['get_article_image', { imageId: ar.imageId }], ['get_note_preview', { articleId: ar.articleId }]] as const) {
        const result: any = await full.callTool({ name, arguments: args });
        const metadata = value(result), image = result.content.find((c: any) => c.type === 'image');
        assert.equal(metadata.articleId, ar.articleId); assert.equal(image.mimeType, 'image/png');
        const decoded = await sharp(Buffer.from(image.data, 'base64')).metadata();
        assert.equal(metadata.width, decoded.width); assert.equal(metadata.height, decoded.height);
        if (name === 'get_note_preview') { assert.equal(metadata.raw, true); assert.equal(metadata.revision, 1); }
      }
      for (const [name, args] of [['get_article', { articleId: br.articleId }], ['get_notes', { articleId: br.articleId }], ['get_article_image', { imageId: br.imageId }], ['get_note_preview', { articleId: br.articleId }]] as const) {
        const result = await full.callTool({ name, arguments: args });
        assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes('beta synthetic'));
      }
    });
    await t.test('read-only MCP does not create editor context snapshots for unannotated articles', async () => {
      const untouched = randomUUID();
      await db`INSERT INTO articles(id,user_id,guid,feed_title,published_at,title,url,content_html,content_text,content_hash) VALUES(${untouched},${a.id},${untouched},'Fixture',now(),'No notes','https://example.invalid/no-notes','<p>No notes</p>','No notes',${hash('no-notes')})`;
      const result = value(await full.callTool({ name: 'get_notes', arguments: { articleId: untouched } }));
      assert.equal(result.document.revision, 0);
      assert.equal((await db`SELECT 1 FROM annotation_contexts WHERE article_id=${untouched}`).length, 0);
      assert.equal((await db`SELECT 1 FROM annotations WHERE article_id=${untouched}`).length, 0);
    });
    await t.test('concurrent stateless requests never share a mutable current user', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? full : otherClient).callTool({ name: 'list_notes', arguments: {} })));
      for (let i = 0; i < results.length; i++) {
        const result = value(results[i]);
        assert.equal(result.total, 1); assert.equal(result.items[0].articleId, i % 2 ? ar.articleId : br.articleId);
      }
    });
    await t.test('token management is CSRF/session only, hash-only at rest, owned and demo restricted', async () => {
      assert.equal(/^fi_mcp_[A-Za-z0-9_-]{43}$/.test(both.token), true);
      const [stored] = await db`SELECT token_hash FROM mcp_tokens WHERE id=${both.access.id}`;
      assert.equal(stored.token_hash === hash(both.token), true); assert.equal(stored.token_hash === both.token, false);
      assert.ok(Date.parse(both.access.expiresAt) > Date.now());
      const listed = await app.inject({ url: '/api/mcp-tokens', headers: a.headers });
      assert.ok(!listed.body.includes(both.token)); assert.ok(!listed.body.includes(stored.token_hash));
      assert.ok(!listed.body.includes('token_hash'));
      const noCsrf = await app.inject({ method: 'POST', url: '/api/mcp-tokens', headers: { cookie: a.headers.cookie }, payload: { name: 'rejected', scopes: ['notes:read'] } });
      assert.equal(noCsrf.statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url: '/api/mcp-tokens', headers: a.headers, payload: { name: 'rejected', scopes: ['notes:write'] } })).statusCode, 400);
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/mcp-tokens/${both.access.id}`, headers: b.headers })).statusCode, 404);
      assert.equal((await app.inject({ url: '/api/annotations', headers: { authorization: `Bearer ${both.token}` } })).statusCode, 401);
      await db`UPDATE users SET is_demo=true WHERE id=${b.id}`;
      assert.equal((await app.inject({ method: 'POST', url: '/api/mcp-tokens', headers: b.headers, payload: { name: 'no demo token', scopes: ['notes:read'] } })).statusCode, 403);
      await assert.rejects(() => otherClient.listTools());
      await db`UPDATE users SET is_demo=false WHERE id=${b.id}`;
    });
    await t.test('revoked, expired and disabled-user tokens fail on the next SDK call', async () => {
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/mcp-tokens/${articles.access.id}`, headers: a.headers })).statusCode, 204);
      await assert.rejects(() => articleClient.listTools());
      await db`UPDATE mcp_tokens SET expires_at=now()-interval '1 second' WHERE id=${notes.access.id}`;
      await assert.rejects(() => noteClient.listTools());
      await db`UPDATE users SET disabled=true WHERE id=${b.id}`;
      await assert.rejects(() => otherClient.callTool({ name: 'list_notes', arguments: {} }));
      await db`UPDATE users SET disabled=false WHERE id=${b.id}`;
    });
    await t.test('Origin/Host, HTTP loopback, URL credentials, bounded bodies and safe failures', async () => {
      const headers = { host: new URL(config.appUrl).host, authorization: `Bearer ${both.token}`, accept: 'application/json, text/event-stream' };
      for (const [url, extra, expected] of [
        ['/mcp', { origin: 'https://foreign.example.invalid' }, 403],
        ['/mcp', { host: 'rebind.example.invalid' }, 403],
        [`/mcp?token=${both.token}`, {}, 401],
        ['/mcp?unsupported=1', { authorization: `Bearer ${both.token}` }, 400],
        ['/mcp', { authorization: 'Bearer fi_mcp_invalid' }, 401],
      ] as const) {
        const response = await app.inject({ method: 'POST', url, headers: { ...headers, ...extra }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
        assert.equal(response.statusCode, expected); assert.ok(!response.body.includes(both.token)); assert.ok(!response.body.includes(a.headers.cookie));
      }
      assert.equal((await app.inject({ method: 'POST', url: '/mcp', remoteAddress: '192.0.2.5', headers, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url: '/mcp', headers, payload: { excessive: 'x'.repeat(70000) } })).statusCode, 413);
      const unauth = await app.inject({ method: 'POST', url: '/mcp', headers: { host: headers.host }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      assert.equal(unauth.statusCode, 401); assert.match(String(unauth.headers['www-authenticate']), /Bearer/);
      const proxyConfig = { ...config, appUrl: 'https://reader.example.invalid', trustProxy: ['127.0.0.1'] };
      const trusted = await createApp(proxyConfig, db), untrusted = await createApp({ ...proxyConfig, trustProxy: [] }, db);
      const proxyHeaders = { host: 'internal.example.invalid', 'x-forwarded-host': 'reader.example.invalid', 'x-forwarded-proto': 'https', authorization: headers.authorization };
      try {
        // A valid token reaches the stateless GET=405 only through the explicitly trusted proxy.
        assert.equal((await trusted.app.inject({ url: '/mcp', remoteAddress: '127.0.0.1', headers: proxyHeaders })).statusCode, 405);
        assert.equal((await untrusted.app.inject({ url: '/mcp', remoteAddress: '127.0.0.1', headers: proxyHeaders })).statusCode, 403);
        assert.equal((await trusted.app.inject({ url: '/mcp', remoteAddress: '192.0.2.5', headers: proxyHeaders })).statusCode, 403);
      } finally { await trusted.app.close(); await untrusted.app.close(); }
    });
  } finally {
    await Promise.all(clients.map(c => c.close().catch(() => {})));
    await app.close();
    if (users.length) await db`DELETE FROM users WHERE id IN ${db(users)}`;
    await db.end(); await rm(dataDir, { recursive: true, force: true });
  }
});
