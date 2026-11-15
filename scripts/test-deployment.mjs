// Creates a first-party demo account. Use only on an isolated test deployment.
// STATE_FILE contains a live test session and must never be committed or published.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
const base = process.env.BASE_URL;
const stateFile = process.env.STATE_FILE;
const mode = process.argv[2];
assert.ok(base && ['seed', 'verify', 'bootstrap'].includes(mode) && (mode === 'bootstrap' || stateFile),
  'Usage: BASE_URL=http://localhost:3000 node scripts/test-deployment.mjs seed|verify (STATE_FILE required) or bootstrap (ADMIN_EMAIL and ADMIN_PASSWORD_FILE required)');
assert.ok(['http:', 'https:'].includes(new URL(base).protocol), 'BASE_URL must be HTTP(S)');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function get(url, cookie) {
  const response = await fetch(base + url, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `GET ${url} status`);
  return response;
}
const health = await (await get('/api/health')).json();
assert.equal(health.database, 'ok');
assert.match(await (await get('/')).text(), /FeedInk/);
assert.equal((await (await get('/manifest.webmanifest')).json()).display, 'standalone');
assert.match(await (await get('/sw.js')).text(), /addEventListener/);
if (mode === 'bootstrap') {
  assert.ok(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD_FILE, 'Bootstrap test requires private credential file');
  const password = (await readFile(process.env.ADMIN_PASSWORD_FILE, 'utf8')).replace(/\r?\n$/, '');
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password }), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, 'operator-created administrator can log in');
  const session = await response.json();
  assert.equal(session.user.isAdmin, true);
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  await get('/api/admin/users', cookie);
  if (process.env.MCP_STATE_FILE) {
    let token;
    try { ({ token } = JSON.parse(await readFile(process.env.MCP_STATE_FILE, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!token) {
      const created = await fetch(base + '/api/mcp-tokens', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ name: 'Deployment persistence test', scopes: ['notes:read'], expiresInDays: 1 }), signal: AbortSignal.timeout(15000) });
      assert.equal(created.status, 201, 'administrator token creation');
      ({ token } = await created.json());
      assert.equal(typeof token, 'string');
      await writeFile(process.env.MCP_STATE_FILE, JSON.stringify({ token }), { flag: 'wx', mode: 0o600 });
    }
    const rpc = async (method, params, id) => {
      const reply = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) }), signal: AbortSignal.timeout(15000) });
      assert.equal(reply.status, id === undefined ? 202 : 200, 'persisted MCP token remains usable');
      return id === undefined ? null : reply.json();
    };
    const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deployment-check', version: '1' } }, 1);
    assert.equal(initialized.result.serverInfo.name, 'FeedInk');
    await rpc('notifications/initialized', {}, undefined);
    const listed = await rpc('tools/list', {}, 2);
    assert.equal(listed.result.tools.length, 7);
    assert.ok(listed.result.tools.every(tool => tool.annotations.readOnlyHint));
    for (const deniedHeaders of [{ Host: 'wrong.example.invalid' }, { Origin: 'https://wrong.example.invalid' }]) {
      const target = new URL('/mcp', base), request = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const status = await new Promise((resolve, reject) => {
        // Keep TLS certificate verification bound to the URL, independently of the hostile HTTP Host.
        const outgoing = request(target, { method: 'POST', servername: target.hostname, timeout: 15000, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...deniedHeaders } }, incoming => { incoming.resume(); incoming.once('end', () => resolve(incoming.statusCode)); });
        outgoing.on('error', () => reject(new Error('MCP negative-origin transport failed; credentials withheld')));
        outgoing.on('timeout', () => outgoing.destroy(new Error('MCP boundary check timed out')));
        outgoing.end(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }));
      });
      assert.equal(status, 403, 'external Host/Origin mismatch is rejected through the configured proxy');
    }
  }
  const registration = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'closed-registration@example.invalid', password: 'not-a-production-password', name: 'Closed test' }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(registration.status, 403, 'registration remains closed after bootstrap');
  console.log('PASS bootstrap: administrator access, configured MCP persistence check and closed registration');
  process.exit(0);
}
let state;
if (mode === 'seed') {
  const response = await fetch(base + '/api/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 201, 'demo creation');
  const session = await response.json();
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  const articles = await (await get('/api/articles?scope=archive', cookie)).json();
  assert.ok(articles.total >= 20);
  const article = await (await get('/api/articles/' + articles.items[0].id, cookie)).json();
  const image = article.images.find(image => image.status === 'cached');
  assert.ok(image, 'demo image captured');
  const bytes = Buffer.from(await (await get(image.url, cookie)).arrayBuffer());
  const annotationPath = `/api/articles/${article.id}/annotations?mode=feed`;
  const context = await (await get(annotationPath, cookie)).json();
  const now = Date.now();
  const payload = { schemaVersion: 1, contentHash: context.contentHash, ink: { version: 1, url: article.url, title: article.title, layoutWidth: 800, updatedAt: now, strokes: [{ id: 'deployment-stroke', tool: 'pen', color: '#123456', width: 2, opacity: 1, points: [{ x: 10, y: 10, p: 0.2 }, { x: 20, y: 15, p: 0.8 }], anchor: { kind: 'deployment-fixture' } }] }, marks: [{ id: 'deployment-note', kind: 'note', color: 'yellow', anchor: null, text: 'Durable deployment note', createdAt: now, updatedAt: now }] };
  const saved = await fetch(base + annotationPath, { method: 'PUT', headers: { cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'If-Match': '"0"' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  assert.equal(saved.status, 200, 'deployment annotation save');
  const document = await saved.json();
  state = { cookie, user: session.user.id, article: article.id, contentHash: hash(article.contentHtml), image: image.url, imageHash: hash(bytes), total: articles.total, annotationPath: `${annotationPath}&contentHash=${document.contentHash}`, annotationRevision: document.revision, annotationHash: hash(JSON.stringify({ ink: document.ink, marks: document.marks })) };
  await writeFile(stateFile, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
} else {
  state = JSON.parse(await readFile(stateFile, 'utf8'));
  const article = await (await get('/api/articles/' + state.article, state.cookie)).json();
  assert.equal(hash(article.contentHtml), state.contentHash);
  assert.equal(hash(Buffer.from(await (await get(state.image, state.cookie)).arrayBuffer())), state.imageHash);
  assert.equal((await (await get('/api/articles?scope=archive', state.cookie)).json()).total, state.total);
  const document = await (await get(state.annotationPath, state.cookie)).json();
  assert.equal(document.revision, state.annotationRevision);
  assert.equal(hash(JSON.stringify({ ink: document.ink, marks: document.marks })), state.annotationHash, 'original text notes and pressure strokes survive restart/recovery');
}
assert.equal((await fetch(base + state.image)).status, 401, 'asset denies unauthenticated access');
console.log(`PASS ${process.argv[2]}: health, SPA, manifest, service worker, ${state.total} original demo articles, stored body/image SHA256, raw annotations and unauthenticated asset denial`);
