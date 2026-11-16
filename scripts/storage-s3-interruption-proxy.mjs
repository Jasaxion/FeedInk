#!/usr/bin/env node
// Hosted synthetic fixture only. Forward real signed SDK traffic; never log headers, paths or errors.
import { createServer, request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Packer-side receipt, checked privately: headers alone must never satisfy the cut witness.
export function isExactFixturePartialArchive(archive) {
  const bytes = Buffer.from([0, 10, 255, 42]);
  const key = createHash('sha256').update(bytes).digest('hex');
  const header = `FEEDINK-REFERENCED-BLOBS-2\n${JSON.stringify({ type: 'blob', key, size: bytes.length })}\n`;
  return archive.equals(Buffer.concat([Buffer.from(header), bytes.subarray(0, 1)]));
}

// Exported only for the hosted fixture's event/socket regressions, not application storage.
export function createOwnedResponseCut(outgoing, upstream, scheduleCut = callback => setTimeout(callback, 100)) {
  let response, firstByte, upstreamBytes = 0, writeStarted = false, writeCompleted = false, ownedDestroyStarted = false;
  let ownedCloseObserved = false, failed = false, cleaningUp = false, cleanUpstreamEnd = false, upstreamEndPending = false, timer;
  const cleanup = () => {
    cleaningUp = true;
    response?.destroy(); upstream.destroy();
  };
  const fail = () => {
    failed = true; clearTimeout(timer);
    outgoing.destroy(); cleanup();
  };
  // Error callbacks never advance the witness, including callbacks delivered after cleanup/recovery.
  outgoing.on('error', fail);
  upstream.on('error', fail);
  upstream.on('close', () => {
    if (cleaningUp || (cleanUpstreamEnd && response?.complete)) return;
    // ClientRequest can emit close inside Node's response-end listener before our end listener runs.
    if (response?.complete && response.readableEnded) {
      upstreamEndPending = true;
      queueMicrotask(() => {
        upstreamEndPending = false;
        if (!cleanUpstreamEnd || !response.complete) fail();
      });
    } else fail();
  });
  outgoing.on('close', () => {
    if (!ownedDestroyStarted || !writeCompleted || failed) failed = true;
    else ownedCloseObserved = true;
    clearTimeout(timer); cleanup();
  });
  return {
    get complete() { return writeCompleted && ownedCloseObserved && !failed && !upstreamEndPending; },
    get failed() { return failed; },
    fail,
    receive(incoming) {
      response = incoming;
      response.on('error', fail);
      response.on('aborted', () => { if (!cleaningUp) fail(); });
      response.on('end', () => {
        if (!response.complete) fail();
        else cleanUpstreamEnd = true;
      });
      response.on('close', () => {
        // A fully observed natural EOF can precede the timer. It is NOT our downstream cut.
        if (!cleaningUp && !(cleanUpstreamEnd && response.complete)) fail();
      });
      const size = Number(response.headers['content-length']);
      if (failed || response.statusCode !== 200 || !Number.isSafeInteger(size) || size < 2) { fail(); return; }
      outgoing.writeHead(response.statusCode, response.headers);
      response.on('data', chunk => {
        if (failed || writeStarted || !chunk.length) return;
        if (!firstByte) firstByte = Buffer.from(chunk.subarray(0, 1));
        upstreamBytes += chunk.length;
        if (upstreamBytes < 2) return;
        response.pause(); writeStarted = true;
        outgoing.write(firstByte, error => {
          if (error) { fail(); return; }
          if (failed) return;
          writeCompleted = true;
          timer = scheduleCut(() => {
            if (failed) return;
            if (outgoing.destroyed || outgoing.writableEnded) { fail(); return; }
            ownedDestroyStarted = true;
            // Completion requires the resulting close event, not this call's intent.
            outgoing.destroy();
          });
        });
      });
    },
  };
}

// The CLI pins the approved upstream; hosted tests supply only their owned loopback server/timer.
export function createInterruptionProxy({ upstreamOrigin, scheduleCut } = {}) {
  let mode = 'pass', sourceGetResponses = 0, cut;
  let blockedHeads = 0, blockedGets = 0;
  const reject = (response, status = 503) => {
    response.writeHead(status, { 'content-type': 'application/xml' });
    response.end('<Error><Code>ServiceUnavailable</Code><Message>Synthetic storage fixture unavailable</Message></Error>');
  };
  const proxy = createServer((incoming, outgoing) => {
    const objectPath = /\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(new URL(incoming.url, 'http://fixture').pathname);
    // Close the retry gate before making the selected upstream request; pending/failed cuts stay gated.
    if (!['GET', 'HEAD', 'PUT'].includes(incoming.method) || mode === 'gated' || cut?.failed) {
      if (objectPath && incoming.method === 'HEAD') blockedHeads++;
      if (objectPath && incoming.method === 'GET') blockedGets++;
      reject(outgoing); incoming.resume(); return;
    }
    const objectGet = incoming.method === 'GET' && objectPath;
    const interrupt = mode === 'armed' && objectGet;
    if (interrupt) mode = 'gated';
    // The connection destination changes, never the signed Host, path, query or body.
    const upstream = request(upstreamOrigin, { method: incoming.method, path: incoming.url, headers: incoming.headers });
    if (interrupt) cut = createOwnedResponseCut(outgoing, upstream, scheduleCut);
    upstream.setTimeout(10_000, () => { if (interrupt) cut.fail(); else upstream.destroy(); });
    incoming.on('aborted', () => { if (interrupt) cut.fail(); else upstream.destroy(); });
    incoming.on('error', () => { if (interrupt) cut.fail(); else upstream.destroy(); });
    if (!interrupt) upstream.on('error', () => {
      if (outgoing.headersSent) outgoing.destroy(); else reject(outgoing, 502);
    });
    upstream.on('response', response => {
      if (objectGet && response.statusCode === 200) sourceGetResponses++;
      if (interrupt) { cut.receive(response); return; }
      outgoing.on('close', () => { response.destroy(); upstream.destroy(); });
      response.on('error', () => outgoing.destroy());
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    incoming.pipe(upstream);
  });
  const control = createServer((incoming, outgoing) => {
    incoming.resume();
    if (incoming.method !== 'POST') { reject(outgoing, 405); return; }
    const completed = mode === 'gated' && cut?.complete;
    let message;
    if (incoming.url === '/ready') message = 'Synthetic proxy ready';
    else if (incoming.url === '/arm' && mode === 'pass' && sourceGetResponses > 0 && !cut) {
      mode = 'armed'; message = 'Synthetic source-read interruption armed';
    } else if (incoming.url === '/assert-interrupted' && completed) {
      message = 'Witness: one-byte write completed and scheduled owned downstream close observed';
    } else if (incoming.url === '/assert-blocked' && completed && blockedHeads > 0 && blockedGets > 0) {
      message = 'Witness: source HEAD and GET refused while gated';
    } else if (incoming.url === '/recover' && completed && blockedHeads > 0 && blockedGets > 0) {
      mode = 'pass'; message = 'Synthetic proxy forwarding restored';
    } else { reject(outgoing, 409); return; }
    outgoing.writeHead(200, { 'content-type': 'text/plain' });
    outgoing.end(message + '\n');
  });
  return { proxy, control };
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error('Hosted fixture required');
  const action = process.argv[2];
  if (['ready', 'arm', 'assert-interrupted', 'assert-blocked', 'recover'].includes(action)) {
    const response = await fetch(`http://127.0.0.1:9001/${action}`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Fixture control failed');
    process.stdout.write(await response.text());
    return;
  }
  if (action !== 'serve' || process.env.STORAGE_DRILL_PROXY_UPSTREAM !== 'http://host.docker.internal:19000')
    throw new Error('Only the explicit owned synthetic upstream is allowed');
  const { proxy, control } = createInterruptionProxy({ upstreamOrigin: 'http://host.docker.internal:19000' });
  // Control is only reachable via exec in this owned container; data port is not host-published.
  proxy.listen(9000, '0.0.0.0');
  control.listen(9001, '127.0.0.1');
  for (const server of [proxy, control]) {
    server.on('error', () => { console.error('Synthetic storage proxy failed'); process.exit(1); });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('Synthetic storage proxy failed'); process.exitCode = 1; });
