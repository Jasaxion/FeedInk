import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { crc32 } from 'node:zlib';
import { createUpstream, PNG, WAV } from './upstream.mjs';

async function fixture(t) {
  const server = createUpstream().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('RSS conditional fetch, window changes and offline failures are deterministic', async t => {
  const base = await fixture(t);
  const first = await fetch(`${base}/feed.xml`);
  assert.equal(first.status, 200);
  const xml = await first.text();
  assert.match(xml, /墨水屏上的安静阅读/);
  assert.match(xml, /data-src=/);
  const unchanged = await fetch(`${base}/feed.xml`, { headers: { 'If-None-Match': first.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
  await fetch(`${base}/__control`, { method: 'POST', body: JSON.stringify({ version: 2 }) });
  const next = await (await fetch(`${base}/feed.xml`)).text();
  assert.match(next, /新一期的订阅/);
  assert.doesNotMatch(next, /quiet-reading-1/);
  await fetch(`${base}/__control`, { method: 'POST', body: JSON.stringify({ offline: true }) });
  assert.equal((await fetch(`${base}/article/one`)).status, 503);
  assert.equal((await fetch(`${base}/image.png`)).status, 503);
  assert.equal((await fetch(`${base}/__health`)).status, 200);
});

test('anti-hotlink image requires exact source referer and returns real PNG bytes', async t => {
  const base = await fixture(t);
  assert.equal((await fetch(`${base}/protected-image.png`)).status, 403);
  const allowed = await fetch(`${base}/protected-image.png`, { headers: { Referer: `${base}/article/one`, 'User-Agent': 'FeedInk-Test' } });
  assert.equal(allowed.status, 200);
  assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), PNG);
  for (let offset = 8; offset < PNG.length;) {
    const length = PNG.readUInt32BE(offset);
    assert.equal(crc32(PNG.subarray(offset + 4, offset + 8 + length)), PNG.readUInt32BE(offset + 8 + length));
    offset += length + 12;
  }
});

test('Atom, JSON Feed, discovery and valid WAV are available without third-party services', async t => {
  const base = await fixture(t);
  assert.match(await (await fetch(`${base}/atom.xml`)).text(), /http:\/\/www.w3.org\/2005\/Atom/);
  assert.equal((await (await fetch(`${base}/feed.json`)).json()).items[0].id, 'json-1');
  assert.match(await (await fetch(`${base}/discover`)).text(), /rel="alternate"/);
  const audio = Buffer.from(await (await fetch(`${base}/podcast.wav`)).arrayBuffer());
  assert.deepEqual(audio, WAV);
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.readUInt32LE(40), audio.length - 44);
});
