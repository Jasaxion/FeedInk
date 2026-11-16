import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PinnedAiProvider } from '../src/ai-provider.js';
import { hostedAiTests, syntheticAiKey } from './ai-fixture.js';

test('ai-provider HTTPS: pinned DNS preserves Host/SNI and enforces certificate hostname before authorization', { skip: !hostedAiTests, timeout: 30000 }, async () => {
  // mkdtemp pre-provisions the real owned filesystem root; no Store/createApp is involved.
  const root = await mkdtemp(join(tmpdir(), 'feedink-ai-tls-'));
  const keyPath = join(root, 'synthetic-key.pem'), certPath = join(root, 'synthetic-cert.pem');
  const originalCAs = tls.getCACertificates('default');
  const requests: { host: string | undefined; authorization: string | undefined }[] = [], names: string[] = [];
  let server: https.Server | undefined;
  try {
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=provider.example.invalid',
      '-addext', 'subjectAltName=DNS:provider.example.invalid', '-keyout', keyPath, '-out', certPath]);
    const key = await readFile(keyPath), cert = await readFile(certPath), context = tls.createSecureContext({ key, cert });
    // Trust this fresh synthetic certificate, not arbitrary certificates or a disabled verifier.
    tls.setDefaultCACertificates([...originalCAs, cert.toString('utf8')]);
    server = https.createServer({ key, cert, SNICallback(name, callback) { names.push(name); callback(null, context); } }, async (request, response) => {
      for await (const _chunk of request) { /* Drain the small synthetic request. */ }
      requests.push({ host: request.headers.host, authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
    });
    // A failed client-side hostname check must not become a raw TLS log/error payload.
    server.on('tlsClientError', () => {});
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port, lookups: string[] = [];
    const provider = new PinnedAiProvider({ allowHosts: ['provider.example.invalid', 'wrong.example.invalid'] }, async host => {
      lookups.push(host); return [{ address: '127.0.0.1', family: 4 }];
    });
    const config = { baseUrl: `https://provider.example.invalid:${port}/v1`, model: 'synthetic', apiKey: syntheticAiKey };
    assert.equal(await provider.complete(config, [], new AbortController().signal), '{"ok":true}');
    assert.deepEqual(lookups, ['provider.example.invalid']);
    assert.deepEqual(names, ['provider.example.invalid']);
    assert.deepEqual(requests, [{ host: `provider.example.invalid:${port}`, authorization: `Bearer ${syntheticAiKey}` }]);
    await assert.rejects(() => provider.complete({ ...config, baseUrl: `https://wrong.example.invalid:${port}/v1` }, [], new AbortController().signal), (error: any) => {
      assert.equal(error.code, 'AI_INTERRUPTED'); assert.ok(!error.message.includes(syntheticAiKey));
      assert.ok(!error.message.includes('certificate')); return true;
    });
    assert.deepEqual(lookups, ['provider.example.invalid', 'wrong.example.invalid']);
    assert.deepEqual(names, ['provider.example.invalid', 'wrong.example.invalid']);
    assert.equal(requests.length, 1, 'mismatched certificate must fail before an authenticated HTTP request and never replay');
  } finally {
    tls.setDefaultCACertificates(originalCAs);
    if (server?.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
    await rm(root, { recursive: true, force: true });
  }
});
