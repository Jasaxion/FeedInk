import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Exercise production request logging in a separate process; capture no real account data.
test('production logs and failure bodies omit rejected URL/header credentials and note bodies', { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 }, async () => {
  const script = `
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createApp } from ${JSON.stringify(new URL('../src/app.ts', import.meta.url).href)};
    const dataDir = await mkdtemp(join(tmpdir(), 'feedink-log-test-'));
    const { app } = await createApp({ databaseUrl: process.env.TEST_DATABASE_URL, dataDir, appUrl: 'http://localhost:3000', sessionSecret: 'synthetic-log-test-secret-at-least-32-bytes', host: '127.0.0.1', port: 0, registration: false, fetchAllowHosts: [], webDir: join(dataDir, 'no-web'), worker: false });
    try {
      const sentinel = 'synthetic-credential-sentinel';
      const response = await app.inject({ method: 'POST', url: '/mcp?token=' + sentinel, headers: { host: 'localhost:3000', authorization: 'Bearer ' + sentinel, cookie: 'feedink_session=' + sentinel, 'x-csrf-token': sentinel }, payload: { text: 'synthetic-note-body-sentinel' } });
      if (response.statusCode !== 400 || response.body.includes(sentinel)) throw new Error('Unsafe credential failure');
      const api = await app.inject({ method: 'POST', url: '/api/mcp-tokens?token=' + sentinel, headers: { cookie: 'feedink_session=' + sentinel }, payload: { name: 'synthetic-note-body-sentinel' } });
      if (api.statusCode !== 401 || api.body.includes(sentinel)) throw new Error('Unsafe API failure');
    } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; if (output.length > 128 * 1024) child.kill(); });
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, 'Production logging subprocess must finish without error');
  assert.match(output, /incoming request/);
  assert.doesNotMatch(output, /synthetic-credential-sentinel|synthetic-note-body-sentinel|feedink_session=/);
});
