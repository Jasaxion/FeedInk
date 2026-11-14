// Creates a first-party demo account. Use only on an isolated test deployment.
// STATE_FILE contains a live test session and must never be committed or published.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
  const registration = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'closed-registration@example.invalid', password: 'not-a-production-password', name: 'Closed test' }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(registration.status, 403, 'registration remains closed after bootstrap');
  console.log('PASS bootstrap: administrator login/access works with public registration closed');
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
  state = { cookie, user: session.user.id, article: article.id, contentHash: hash(article.contentHtml), image: image.url, imageHash: hash(bytes), total: articles.total };
  await writeFile(stateFile, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
} else {
  state = JSON.parse(await readFile(stateFile, 'utf8'));
  const article = await (await get('/api/articles/' + state.article, state.cookie)).json();
  assert.equal(hash(article.contentHtml), state.contentHash);
  assert.equal(hash(Buffer.from(await (await get(state.image, state.cookie)).arrayBuffer())), state.imageHash);
  assert.equal((await (await get('/api/articles?scope=archive', state.cookie)).json()).total, state.total);
}
assert.equal((await fetch(base + state.image)).status, 401, 'asset denies unauthenticated access');
console.log(`PASS ${process.argv[2]}: health, SPA, manifest, service worker, ${state.total} original demo articles, stored body/image SHA256 and unauthenticated asset denial`);
