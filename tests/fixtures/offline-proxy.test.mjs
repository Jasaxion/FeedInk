import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createOfflineProxy } from './offline-proxy.mjs';

async function fixture(t, handler = (req, res) => {
  req.resume();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ path: req.url, origin: req.headers.origin || null }));
}) {
  const upstream = http.createServer(handler).listen(0, '127.0.0.1');
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

const savePath = '/api/articles/00000000-0000-4000-8000-000000000001/annotations?mode=feed';
async function saveCommand(proxy, action, path) {
  const response = await fetch(proxy.saveControlUrl, {
    method: 'POST', headers: { Authorization: `Bearer ${proxy.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(path ? { path } : {}) }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function waitForHeld(proxy, count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await saveCommand(proxy, 'status')).held === count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Owned proxy did not observe the expected held saves');
}

test('held annotation PUT preserves its body and auth headers; direct winner bypasses hold and release receives real 412', async t => {
  let revision = 0, text = '', attemptedBody, attemptedHeaders;
  const { proxy, origin } = await fixture(t, async (req, res) => {
    let status = 200;
    if (req.method === 'PUT') {
      let body = ''; for await (const chunk of req) body += chunk;
      attemptedBody = body; attemptedHeaders = req.headers;
      if (req.headers['if-match'] !== `"${revision}"`) status = 412;
      else { revision++; text = body; }
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revision, text }));
  });
  await saveCommand(proxy, 'hold', savePath);
  const browserSave = fetch(`${proxy.publicUrl}${savePath}`, {
    method: 'PUT', headers: { 'If-Match': '"0"', Cookie: 'session=owned-synthetic', 'X-CSRF-Token': 'owned-csrf', Origin: proxy.publicUrl }, body: 'local draft',
  });
  try {
    await waitForHeld(proxy, 1);
    assert.deepEqual(await (await fetch(`${origin}${savePath}`)).json(), { revision: 0, text: '' });
    assert.equal((await fetch(`${origin}${savePath}`, { method: 'PUT', headers: { 'If-Match': '"0"' }, body: 'server winner' })).status, 200);
    assert.equal((await saveCommand(proxy, 'status')).held, 1);
    await saveCommand(proxy, 'release');
    assert.equal((await browserSave).status, 412);
    assert.equal(attemptedBody, 'local draft');
    assert.equal(attemptedHeaders.cookie, 'session=owned-synthetic');
    assert.equal(attemptedHeaders['x-csrf-token'], 'owned-csrf');
    assert.equal(attemptedHeaders.origin, proxy.publicUrl);
    assert.deepEqual(await (await fetch(`${origin}${savePath}`)).json(), { revision: 1, text: 'server winner' });
    assert.deepEqual(await saveCommand(proxy, 'status'), { mode: 'pass', attempted: 1, held: 0, failed: 0, completed: 1, lastStatus: 412 });
  } finally { await saveCommand(proxy, 'reset'); await browserSave; }
});

test('503 save fault is scoped to the exact PUT and resets without changing the upstream', async t => {
  const { proxy } = await fixture(t);
  await saveCommand(proxy, 'fail', savePath);
  try {
    const failed = await fetch(`${proxy.publicUrl}${savePath}`, { method: 'PUT', body: 'unsynchronized draft' });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error.code, 'UNAVAILABLE');
    assert.equal((await fetch(`${proxy.publicUrl}${savePath}`)).status, 200);
    assert.equal((await fetch(`${proxy.publicUrl}${savePath.replace('mode=feed', 'mode=fulltext')}`, { method: 'PUT' })).status, 200);
    assert.equal((await fetch(`${proxy.publicUrl}/api/auth/logout`, { method: 'POST' })).status, 200);
    assert.deepEqual(await saveCommand(proxy, 'status'), { mode: 'fail', attempted: 1, held: 0, failed: 1, completed: 0, lastStatus: null });
  } finally { await saveCommand(proxy, 'reset'); }
  assert.equal((await fetch(`${proxy.publicUrl}${savePath}`, { method: 'PUT' })).status, 200);
});

test('save control rejects missing/wrong capabilities, unbounded shapes, and non-annotation targets', async t => {
  const { proxy } = await fixture(t);
  for (const token of ['', 'wrong-token']) {
    assert.equal((await fetch(proxy.saveControlUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'hold', path: savePath }) })).status, 401);
  }
  for (const input of [
    { action: 'hold', path: '/api/auth/logout' }, { action: 'hold', path: `http://elsewhere${savePath}` },
    { action: 'fail', path: savePath, status: 401 }, { action: 'reset', extra: true },
    { action: 'hold', path: `${savePath}&extra=true` }, { action: 'unknown' }, null,
    { action: 'hold', path: 'x'.repeat(2048) },
  ]) {
    assert.equal((await fetch(proxy.saveControlUrl, { method: 'POST', headers: { Authorization: `Bearer ${proxy.token}` }, body: JSON.stringify(input) })).status, 400);
  }
  // The public application listener never exposes the private controller.
  const publicResponse = await fetch(`${proxy.publicUrl}/annotation-save`, { method: 'POST', body: JSON.stringify({ action: 'hold', path: savePath }) });
  assert.equal((await publicResponse.json()).path, '/annotation-save');
  assert.equal((await saveCommand(proxy, 'status')).mode, 'pass');
});

test('held saves have a fixed concurrency bound and reset cancels every pending write', async t => {
  let upstreamWrites = 0;
  const { proxy } = await fixture(t, (req, res) => { if (req.method === 'PUT') upstreamWrites++; req.resume(); res.writeHead(200).end(); });
  await saveCommand(proxy, 'hold', savePath);
  const saves = Array.from({ length: 8 }, () => fetch(`${proxy.publicUrl}${savePath}`, { method: 'PUT', body: 'owned draft' }));
  try {
    await waitForHeld(proxy, 8);
    assert.equal((await fetch(`${proxy.publicUrl}${savePath}`, { method: 'PUT', body: 'overflow' })).status, 503);
    assert.equal((await saveCommand(proxy, 'status')).held, 8);
    await saveCommand(proxy, 'reset');
    assert.deepEqual((await Promise.all(saves)).map(response => response.status), Array(8).fill(503));
    assert.equal((await saveCommand(proxy, 'status')).held, 0);
    assert.equal(upstreamWrites, 0);
  } finally { await saveCommand(proxy, 'reset'); await Promise.all(saves); }
});
