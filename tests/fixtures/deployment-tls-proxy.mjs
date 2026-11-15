// Isolated CI reverse proxy. Never logs authenticated requests or response bodies.
import https from 'node:https';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const [cert, key] = await Promise.all([readFile(process.env.TEST_TLS_CERT), readFile(process.env.TEST_TLS_KEY)]);
const servers = [];
for (const [port, upstreamPort] of [[3443, 3000], [3444, 3001]]) {
  const server = https.createServer({ cert, key }, (request, response) => {
    if (request.headers.host?.toLowerCase() !== `localhost:${port}`) { response.writeHead(403); response.end(); return; }
    const headers = { ...request.headers, host: `localhost:${port}`, 'x-forwarded-host': `localhost:${port}`, 'x-forwarded-proto': 'https', 'x-forwarded-for': request.socket.remoteAddress };
    delete headers.forwarded;
    const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: request.method, path: request.url, headers }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.setTimeout(30000, () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('error', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  servers.push(server);
}
console.log('Isolated deployment TLS proxies ready');
const close = () => { for (const server of servers) { server.closeAllConnections(); server.close(); } };
process.once('SIGINT', close); process.once('SIGTERM', close);
