// Hosted-only fixture regressions. No real credentials, S3 service or production storage mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { createOwnedResponseCut, createInterruptionProxy, isExactFixturePartialArchive } from './storage-s3-interruption-proxy.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Approved GitHub-hosted runner required');

const bytes = Buffer.from([0, 10, 255, 42]);
const key = createHash('sha256').update(bytes).digest('hex');
const objectPath = `/synthetic/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}?x-id=GetObject`;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function eventCut() {
  let writeCallback, scheduled;
  const outgoing = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    destroy() { this.destroyed = true; },
    writeHead() {},
    write(value, callback) { assert.equal(value.length, 1); writeCallback = callback; },
  });
  const upstream = Object.assign(new EventEmitter(), { destroy() {} });
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200, headers: { 'content-length': '4' }, complete: false,
    pause() {}, destroy() {},
  });
  const cut = createOwnedResponseCut(outgoing, upstream, callback => { scheduled = callback; });
  cut.receive(response);
  response.emit('data', bytes);
  return { cut, outgoing, upstream, response, acknowledge: error => writeCallback(error), scheduled: () => scheduled };
}

test('createOwnedResponseCut: write acknowledgement and observed scheduled close are both required', () => {
  const fixture = eventCut();
  assert.equal(fixture.cut.complete, false);
  assert.equal(fixture.scheduled(), undefined);
  fixture.acknowledge();
  assert.equal(fixture.cut.complete, false);
  fixture.scheduled()();
  assert.equal(fixture.outgoing.destroyed, true);
  assert.equal(fixture.cut.complete, false, 'destroy intent is not a close witness');
  fixture.outgoing.emit('close');
  assert.equal(fixture.cut.complete, true);
});

test('createOwnedResponseCut: clean upstream EOF/close racing the timer is not the owned cut', () => {
  const fixture = eventCut();
  fixture.acknowledge();
  fixture.response.complete = true;
  fixture.response.emit('end');
  fixture.response.emit('close');
  fixture.upstream.emit('close');
  assert.equal(fixture.cut.failed, false);
  assert.equal(fixture.cut.complete, false);
  fixture.scheduled()();
  assert.equal(fixture.cut.complete, false);
  fixture.outgoing.emit('close');
  assert.equal(fixture.cut.complete, true);
});

test('createOwnedResponseCut: request close during upstream end dispatch waits for observed EOF, not recovery', async () => {
  const fixture = eventCut();
  fixture.acknowledge();
  fixture.response.complete = true; fixture.response.readableEnded = true;
  fixture.upstream.emit('close');
  fixture.response.emit('end');
  await Promise.resolve();
  assert.equal(fixture.cut.failed, false);
  assert.equal(fixture.cut.complete, false);
  fixture.scheduled()(); fixture.outgoing.emit('close');
  assert.equal(fixture.cut.complete, true);
});

test('createOwnedResponseCut: pending upstream EOF check cannot authorize recovery from flags alone', async () => {
  const fixture = eventCut();
  fixture.acknowledge();
  fixture.response.complete = true; fixture.response.readableEnded = true;
  fixture.upstream.emit('close');
  fixture.scheduled()(); fixture.outgoing.emit('close');
  assert.equal(fixture.cut.complete, false);
  await Promise.resolve();
  assert.equal(fixture.cut.failed, true);
  assert.equal(fixture.cut.complete, false);
});

for (const [name, disrupt] of [
  ['early downstream close', fixture => fixture.outgoing.emit('close')],
  ['downstream error', fixture => fixture.outgoing.emit('error', new Error('synthetic'))],
  ['upstream request error', fixture => fixture.upstream.emit('error', new Error('synthetic'))],
  ['upstream response error', fixture => fixture.response.emit('error', new Error('synthetic'))],
  ['upstream abort', fixture => fixture.response.emit('aborted')],
  ['incomplete upstream close', fixture => fixture.response.emit('close')],
  ['incomplete upstream request close', fixture => fixture.upstream.emit('close')],
  ['upstream complete flag without observed EOF', fixture => { fixture.response.complete = true; fixture.response.emit('close'); }],
]) {
  test(`createOwnedResponseCut: ${name} cannot be repaired by a late write callback/timer`, () => {
    const fixture = eventCut();
    disrupt(fixture);
    fixture.acknowledge();
    fixture.scheduled()?.();
    fixture.outgoing.emit('close');
    assert.equal(fixture.cut.failed, true);
    assert.equal(fixture.cut.complete, false);
  });
}

test('createOwnedResponseCut: write error, close while timer pending and error before owned close fail', () => {
  const writeFailure = eventCut();
  writeFailure.acknowledge(new Error('synthetic'));
  assert.equal(writeFailure.cut.failed, true);
  assert.equal(writeFailure.scheduled(), undefined);
  const earlyClose = eventCut();
  earlyClose.acknowledge();
  earlyClose.outgoing.emit('close');
  earlyClose.scheduled()();
  assert.equal(earlyClose.cut.complete, false);
  const closingFailure = eventCut();
  closingFailure.acknowledge();
  closingFailure.scheduled()();
  closingFailure.response.emit('error', new Error('synthetic'));
  closingFailure.outgoing.emit('close');
  assert.equal(closingFailure.cut.complete, false);
});

test('createOwnedResponseCut: a late error revokes completion rather than reviving a recovered cut', () => {
  const fixture = eventCut();
  fixture.acknowledge(); fixture.scheduled()(); fixture.outgoing.emit('close');
  assert.equal(fixture.cut.complete, true);
  fixture.response.emit('error', new Error('synthetic'));
  assert.equal(fixture.cut.complete, false);
  assert.equal(fixture.cut.failed, true);
});

test('isExactFixturePartialArchive: exact framing/key/length and one payload byte, never headers or footer', () => {
  const header = Buffer.from(`FEEDINK-REFERENCED-BLOBS-2\n${JSON.stringify({ type: 'blob', key, size: 4 })}\n`);
  const valid = Buffer.concat([header, bytes.subarray(0, 1)]);
  assert.equal(isExactFixturePartialArchive(valid), true);
  for (const invalid of [
    Buffer.alloc(0), header, Buffer.concat([header, bytes]), Buffer.concat([header, Buffer.from([1])]),
    Buffer.concat([valid, Buffer.from('\n{"type":"end"}\n')]),
    Buffer.from(valid.toString('binary').replace(key, 'f'.repeat(64)), 'binary'),
    Buffer.from(valid.toString('binary').replace('"size":4', '"size":3'), 'binary'),
    Buffer.from(valid.toString('binary').replace('BLOBS-2', 'BLOBS-1'), 'binary'),
  ]) assert.equal(isExactFixturePartialArchive(invalid), false);
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function readHttp(url, { method = 'GET', headers = {} } = {}) {
  const firstByte = deferred();
  let response;
  const done = new Promise((resolve, reject) => {
    const client = request(url, { method, headers, agent: false }, incoming => {
      response = incoming;
      const chunks = [];
      let ended = false, aborted = false;
      incoming.on('data', chunk => { chunks.push(chunk); firstByte.resolve(); });
      incoming.on('end', () => { ended = true; });
      incoming.on('aborted', () => { aborted = true; });
      incoming.on('error', () => {});
      incoming.on('close', () => resolve({ status: incoming.statusCode, headers: incoming.headers,
        body: Buffer.concat(chunks), complete: incoming.complete, ended, aborted }));
    });
    client.setTimeout(3000, () => client.destroy());
    client.on('error', () => reject(new Error('Synthetic HTTP request failed')));
    client.end();
  });
  return { done, firstByte: firstByte.promise, abort: () => response?.destroy() };
}

async function socketFixture(t, holdUpstream = false) {
  const scheduled = deferred();
  let runCut, heldResponse;
  const forwarded = [];
  const upstream = createServer((incoming, outgoing) => {
    forwarded.push({ method: incoming.method, host: incoming.headers.host, path: incoming.url });
    outgoing.writeHead(200, { 'content-length': bytes.length });
    if (holdUpstream && forwarded.length > 1) {
      heldResponse = outgoing; outgoing.write(bytes.subarray(0, 2));
    } else outgoing.end(bytes);
  });
  const servers = [upstream];
  t.after(async () => {
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  const upstreamOrigin = await listen(upstream);
  const { proxy, control } = createInterruptionProxy({ upstreamOrigin, scheduleCut: callback => {
    runCut = callback; scheduled.resolve();
  } });
  servers.push(proxy, control);
  const dataUrl = await listen(proxy), controlUrl = await listen(control);
  const command = action => readHttp(`${controlUrl}/${action}`, { method: 'POST' }).done;
  const blocked = async () => {
    for (const method of ['HEAD', 'GET']) assert.equal((await readHttp(dataUrl + objectPath, { method }).done).status, 503);
  };
  const seeded = await readHttp(dataUrl + objectPath, { headers: { host: 'signed-fixture.invalid' } }).done;
  assert.equal(seeded.complete, true); assert.equal(seeded.body.equals(bytes), true);
  assert.equal(forwarded[0].method === 'GET' && forwarded[0].host === 'signed-fixture.invalid' && forwarded[0].path === objectPath, true,
    'signed host and request target must be forwarded unchanged');
  assert.equal((await command('arm')).status, 200);
  return { proxy, dataUrl, command, blocked, scheduled: scheduled.promise, cut: () => runCut(),
    abortUpstream: () => heldResponse.destroy(), forwarded };
}

test('createInterruptionProxy: pending controls reject, retries gate, normal owned cut is incomplete 200/one byte', { timeout: 10_000 }, async t => {
  const fixture = await socketFixture(t);
  const partial = readHttp(fixture.dataUrl + objectPath);
  await Promise.all([fixture.scheduled, partial.firstByte]);
  assert.equal((await fixture.command('assert-interrupted')).status, 409);
  assert.equal((await fixture.command('recover')).status, 409);
  await fixture.blocked();
  assert.equal(fixture.forwarded.length, 2, 'gated HEAD/GET must never reach upstream');
  fixture.cut();
  const result = await partial.done;
  assert.equal(result.status, 200); assert.equal(result.headers['content-length'], '4');
  assert.equal(result.body.equals(bytes.subarray(0, 1)), true);
  assert.equal(result.ended, false); assert.equal(result.aborted, true); assert.equal(result.complete, false);
  assert.equal((await fixture.command('assert-interrupted')).status, 200);
  assert.equal((await fixture.command('assert-blocked')).status, 200);
  assert.equal((await fixture.command('recover')).status, 200);
  const recovered = await readHttp(fixture.dataUrl + objectPath).done;
  assert.equal(recovered.complete, true); assert.equal(recovered.body.equals(bytes), true);
});

test('createInterruptionProxy: early downstream close remains failed after the scheduled callback', { timeout: 10_000 }, async t => {
  const fixture = await socketFixture(t);
  const closed = deferred();
  fixture.proxy.once('connection', socket => socket.once('close', closed.resolve));
  const partial = readHttp(fixture.dataUrl + objectPath);
  await Promise.all([fixture.scheduled, partial.firstByte]);
  partial.abort();
  await Promise.all([partial.done, closed.promise]);
  fixture.cut();
  assert.equal((await fixture.command('assert-interrupted')).status, 409);
  await fixture.blocked();
  assert.equal((await fixture.command('recover')).status, 409);
});

test('createInterruptionProxy: incomplete upstream close fails rather than impersonating the owned cut', { timeout: 10_000 }, async t => {
  const fixture = await socketFixture(t, true);
  const partial = readHttp(fixture.dataUrl + objectPath);
  await Promise.all([fixture.scheduled, partial.firstByte]);
  fixture.abortUpstream();
  await partial.done;
  fixture.cut();
  assert.equal((await fixture.command('assert-interrupted')).status, 409);
  await fixture.blocked();
  assert.equal((await fixture.command('recover')).status, 409);
});
