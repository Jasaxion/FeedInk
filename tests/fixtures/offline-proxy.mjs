import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const loopback = host => ['127.0.0.1', 'localhost', '[::1]'].includes(host);
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
});
const close = server => new Promise((resolve, reject) => {
  if (!server.listening) return resolve();
  server.closeAllConnections();
  server.close(error => error ? reject(error) : resolve());
});

/** Test-only loopback proxy. Stop its listener to exercise a genuine unreachable origin. */
export async function createOfflineProxy(upstream, port = 0) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !loopback(target.hostname) || target.username || target.password) throw new Error('Test proxy requires a loopback HTTP upstream');
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  let publicPort = port;
  let transition = Promise.resolve();
  const proxy = http.createServer((request, response) => {
    let destination;
    try {
      destination = new URL(request.url || '/', target);
      if (!request.url?.startsWith('/') || destination.origin !== target.origin) throw new Error();
    } catch { response.writeHead(400).end(); return; }
    const outgoing = http.request(destination, { method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(response);
    });
    outgoing.on('error', () => { if (response.destroyed || response.writableEnded) return; if (!response.headersSent) response.writeHead(502); response.end('Test upstream unavailable'); });
    response.on('close', () => outgoing.destroy());
    request.pipe(outgoing);
  });
  const setOffline = offline => {
    const operation = transition.then(async () => {
      if (offline) await close(proxy);
      else if (!proxy.listening) await listen(proxy, publicPort);
    });
    transition = operation.catch(() => {});
    return operation;
  };
  const control = http.createServer(async (request, response) => {
    const supplied = Buffer.from(String(request.headers.authorization || ''));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(401).end(); return; }
    if (request.method !== 'POST' || request.url !== '/state') { response.writeHead(404).end(); return; }
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 1024) throw new Error(); }
      const input = JSON.parse(body);
      if (Object.keys(input).length !== 1 || typeof input.offline !== 'boolean') throw new Error();
      await setOffline(input.offline);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ offline: !proxy.listening }));
    } catch { response.writeHead(400).end('Invalid test control request'); }
  });
  try {
    await listen(proxy, port);
    publicPort = proxy.address().port;
    await listen(control, 0);
  } catch (error) { await close(proxy); await close(control); throw error; }
  return {
    publicUrl: `http://127.0.0.1:${publicPort}`,
    upstreamUrl: target.origin,
    controlUrl: `http://127.0.0.1:${control.address().port}/state`,
    token,
    async close() { await transition; await close(proxy); await close(control); },
  };
}
