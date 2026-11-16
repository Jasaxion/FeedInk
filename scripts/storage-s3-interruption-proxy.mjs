#!/usr/bin/env node
// Hosted synthetic fixture only. Forward real signed SDK traffic; never log headers, paths or errors.
import { createServer, request } from 'node:http';

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error('Hosted fixture required');
  const action = process.argv[2];
  const actions = ['ready', 'arm', 'assert-interrupted', 'recover'];
  if (actions.includes(action)) {
    const response = await fetch(`http://127.0.0.1:9001/${action}`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Fixture control failed');
    process.stdout.write(await response.text());
    return;
  }
  if (action !== 'serve' || process.env.STORAGE_DRILL_PROXY_UPSTREAM !== 'http://host.docker.internal:19000')
    throw new Error('Only the explicit owned synthetic upstream is allowed');

  let mode = 'pass', sourceGetResponses = 0, interruptions = 0, upstreamBytes = 0, forwardedBytes = 0;
  const reject = (response, status = 503) => {
    response.writeHead(status, { 'content-type': 'text/plain' });
    response.end('Synthetic storage fixture unavailable\n');
  };
  const proxy = createServer((incoming, outgoing) => {
    if (!['GET', 'HEAD', 'PUT'].includes(incoming.method) || mode === 'blocked' || mode === 'cutting') {
      reject(outgoing); incoming.resume(); return;
    }
    // ListBucket is not an object read. The fixture never changes signed paths, query or Host.
    const objectGet = incoming.method === 'GET' && /\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(new URL(incoming.url, 'http://fixture').pathname);
    const interrupt = mode === 'armed' && objectGet;
    if (interrupt) mode = 'cutting';
    const upstream = request('http://host.docker.internal:19000', {
      method: incoming.method, path: incoming.url, headers: incoming.headers,
    });
    upstream.setTimeout(10_000, () => upstream.destroy());
    incoming.on('aborted', () => upstream.destroy());
    incoming.on('error', () => upstream.destroy());
    upstream.on('error', () => {
      if (outgoing.headersSent) outgoing.destroy(); else reject(outgoing, 502);
    });
    upstream.on('response', response => {
      outgoing.on('close', () => { response.destroy(); upstream.destroy(); });
      response.on('error', () => outgoing.destroy());
      if (objectGet && response.statusCode === 200) sourceGetResponses++;
      if (!interrupt) {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
        return;
      }
      // Require an actual successful object response, not a fabricated SDK failure or connection refusal.
      const size = Number(response.headers['content-length']);
      if (response.statusCode !== 200 || !Number.isSafeInteger(size) || size < 2) {
        response.destroy(); reject(outgoing, 502); return;
      }
      outgoing.writeHead(response.statusCode, response.headers);
      let firstByte;
      response.on('data', chunk => {
        if (!firstByte) firstByte = chunk.subarray(0, 1);
        upstreamBytes += chunk.length;
        if (upstreamBytes < 2) return;
        response.pause();
        forwardedBytes = 1;
        interruptions++;
        mode = 'blocked'; // SDK retries cannot turn this failed backup into success.
        outgoing.write(firstByte);
        // Allow the genuine first byte through, then sever only this proxy-owned response/socket.
        setTimeout(() => { outgoing.destroy(); response.destroy(); upstream.destroy(); }, 100);
      });
    });
    incoming.pipe(upstream);
  });
  const control = createServer((incoming, outgoing) => {
    incoming.resume();
    if (incoming.method !== 'POST') { reject(outgoing, 405); return; }
    let message;
    if (incoming.url === '/ready') message = 'Synthetic proxy ready';
    else if (incoming.url === '/arm' && mode === 'pass' && sourceGetResponses > 0 && interruptions === 0) {
      mode = 'armed'; message = 'Synthetic source-read interruption armed';
    } else if (incoming.url === '/assert-interrupted' && mode === 'blocked' && interruptions === 1 && upstreamBytes > forwardedBytes && forwardedBytes === 1) {
      message = 'Witness: genuine upstream object GET, one byte forwarded, owned response interrupted';
    } else if (incoming.url === '/recover' && mode === 'blocked' && interruptions === 1) {
      mode = 'pass'; message = 'Synthetic proxy forwarding restored';
    } else { reject(outgoing, 409); return; }
    outgoing.writeHead(200, { 'content-type': 'text/plain' });
    outgoing.end(message + '\n');
  });
  // Control is only reachable via an exec in this owned container; data port is not host-published.
  proxy.listen(9000, '0.0.0.0');
  control.listen(9001, '127.0.0.1');
  for (const server of [proxy, control]) {
    server.on('error', () => { console.error('Synthetic storage proxy failed'); process.exit(1); });
  }
}
main().catch(() => { console.error('Synthetic storage proxy failed'); process.exitCode = 1; });
