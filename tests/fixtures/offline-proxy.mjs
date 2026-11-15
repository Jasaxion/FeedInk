import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const loopback = host => ['127.0.0.1', 'localhost', '[::1]'].includes(host);
const annotationPath = /^\/api\/articles\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/annotations\?mode=(?:feed|fulltext)$/;
const maxHeldSaves = 8;
const holdTimeoutMs = 30_000;
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
});
const close = server => new Promise((resolve, reject) => {
  if (!server.listening) return resolve();
  server.closeAllConnections();
  server.close(error => error ? reject(error) : resolve());
});

/** Owned loopback transport faults, including worker-owned requests; never a production API bypass. */
export async function createOfflineProxy(upstream, port = 0) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !loopback(target.hostname) || target.username || target.password) throw new Error('Test proxy requires a loopback HTTP upstream');
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  let publicPort = port;
  let transition = Promise.resolve();
  let saveFault;
  const heldSaves = new Set();
  const saveStatus = () => ({
    mode: saveFault?.mode || 'pass', attempted: saveFault?.attempted || 0,
    held: heldSaves.size, failed: saveFault?.failed || 0,
    completed: saveFault?.completed || 0, lastStatus: saveFault?.lastStatus ?? null,
  });
  const resetSaves = () => {
    for (const held of [...heldSaves]) held.finish(false);
    saveFault = undefined;
  };
  const proxy = http.createServer((request, response) => {
    let destination;
    try {
      destination = new URL(request.url || '/', target);
      if (!request.url?.startsWith('/') || destination.origin !== target.origin) throw new Error();
    } catch { response.writeHead(400).end(); return; }
    const fault = request.method === 'PUT' && request.url === saveFault?.path ? saveFault : undefined;
    if (fault) fault.attempted++;
    const fail = () => {
      if (fault) fault.failed++;
      request.resume();
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Controlled test save failure' } }));
      }
    };
    const forward = () => {
      if (response.destroyed) return;
      const outgoing = http.request(destination, { method: request.method, headers: request.headers }, incoming => {
        if (fault) { fault.completed++; fault.lastStatus = incoming.statusCode || 502; }
        response.writeHead(incoming.statusCode || 502, incoming.headers);
        incoming.pipe(response);
      });
      outgoing.on('error', () => { if (response.destroyed || response.writableEnded) return; if (!response.headersSent) response.writeHead(502); response.end('Test upstream unavailable'); });
      response.on('close', () => outgoing.destroy());
      request.pipe(outgoing);
    };
    if (fault?.mode === 'fail') { fail(); return; }
    if (fault?.mode !== 'hold') { forward(); return; }
    if (heldSaves.size >= maxHeldSaves) { fail(); return; }
    // Pause rather than buffering note bodies; every held socket has a finite lease.
    request.pause();
    const held = { finish: released => {
      if (!heldSaves.delete(held)) return;
      clearTimeout(timer);
      if (released) forward(); else fail();
    } };
    const timer = setTimeout(() => held.finish(false), holdTimeoutMs);
    heldSaves.add(held);
    response.on('close', () => { heldSaves.delete(held); clearTimeout(timer); });
  });
  const setOffline = offline => {
    const operation = transition.then(async () => {
      if (offline) { resetSaves(); await close(proxy); }
      else if (!proxy.listening) await listen(proxy, publicPort);
    });
    transition = operation.catch(() => {});
    return operation;
  };
  const control = http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (request, response) => {
    const supplied = Buffer.from(String(request.headers.authorization || ''));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(401).end(); return; }
    if (request.method !== 'POST' || !['/state', '/annotation-save'].includes(request.url)) { response.writeHead(404).end(); return; }
    try {
      // Drain oversized commands without retaining them or destroying the socket before the 400.
      const input = await new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on('data', chunk => {
          size += chunk.length;
          if (size > 1024) { chunks.length = 0; reject(new Error()); }
          else chunks.push(chunk);
        });
        request.once('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error()); }
        });
        request.once('error', reject);
      });
      let output;
      if (request.url === '/state') {
        if (Object.keys(input).length !== 1 || typeof input.offline !== 'boolean') throw new Error();
        await setOffline(input.offline);
        output = { offline: !proxy.listening };
      } else {
        if (['hold', 'fail'].includes(input.action)) {
          if (Object.keys(input).length !== 2 || typeof input.path !== 'string' || !annotationPath.test(input.path) || !proxy.listening || saveFault) throw new Error();
          saveFault = { path: input.path, mode: input.action, attempted: 0, failed: 0, completed: 0, lastStatus: null };
        } else {
          if (Object.keys(input).length !== 1 || !['status', 'release', 'reset'].includes(input.action)) throw new Error();
          if (input.action === 'reset') resetSaves();
          if (input.action === 'release') {
            if (saveFault) saveFault.mode = 'pass';
            for (const held of [...heldSaves]) held.finish(true);
          }
        }
        output = saveStatus();
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(output));
    } catch { response.writeHead(400, { Connection: 'close' }).end('Invalid test control request'); }
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
    saveControlUrl: `http://127.0.0.1:${control.address().port}/annotation-save`,
    token,
    async close() { await transition; resetSaves(); await close(proxy); await close(control); },
  };
}
