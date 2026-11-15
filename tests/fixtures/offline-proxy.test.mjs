import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createOfflineProxy } from './offline-proxy.mjs';

async function fixture(t) {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, origin: req.headers.origin || null }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = await createOfflineProxy(origin);
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  return { origin, proxy };
}

test('real listener shutdown blocks proxy traffic while upstream remains readable, then resumes', async t => {
  const { origin, proxy } = await fixture(t);
  const initial = await fetch(`${proxy.publicUrl}/article?q=test`, { headers: { Origin: proxy.publicUrl } });
  assert.deepEqual(await initial.json(), { path: '/article?q=test', origin: proxy.publicUrl });
  const change = offline => fetch(proxy.controlUrl, { method: 'POST', headers: { Authorization: `Bearer ${proxy.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ offline }) });
  assert.equal((await change(true)).status, 200);
  await assert.rejects(fetch(`${proxy.publicUrl}/article`));
  assert.equal((await fetch(`${origin}/article`)).status, 200);
  assert.equal((await change(false)).status, 200);
  assert.equal((await fetch(`${proxy.publicUrl}/article`)).status, 200);
});

test('control requires its private token and validates the small command shape', async t => {
  const { proxy } = await fixture(t);
  assert.equal((await fetch(proxy.controlUrl, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(proxy.controlUrl, { method: 'POST', headers: { Authorization: `Bearer ${proxy.token}` }, body: JSON.stringify({ offline: true, target: 'elsewhere' }) })).status, 400);
  assert.equal((await fetch(`${proxy.publicUrl}/`)).status, 200);
});

test('non-loopback upstreams are not accepted', async () => {
  await assert.rejects(createOfflineProxy('https://example.com'));
  await assert.rejects(createOfflineProxy('http://user:pass@127.0.0.1:3000'));
});
