import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOfflineProxy } from './fixtures/offline-proxy.mjs';

const project = process.argv[2];
if (!['api', 'desktop', 'mobile', 'tablet', 'webkit', 'workflows', 'annotations', 'annotations-mobile', 'mcp'].includes(project)) throw new Error('Choose a configured test project');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL must identify a disposable test database; production DATABASE_URL is never reused implicitly');
await access('apps/api/dist/server.js');
const directory = await mkdtemp(join(tmpdir(), 'feedink-test-'));
const port = Number(process.env.FEEDINK_TEST_PORT || 3000);
const upstreamUrl = `http://127.0.0.1:${port}`;
let proxy;
let api;
let runner;
let log;
let success = false;
let interrupted = false;

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
const cancel = () => { interrupted = true; runner?.kill('SIGTERM'); api?.kill('SIGTERM'); };
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  if (project === 'webkit') proxy = await createOfflineProxy(upstreamUrl);
  const origin = proxy?.publicUrl || upstreamUrl;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    SESSION_SECRET: randomBytes(32).toString('hex'),
    DATA_DIR: join(directory, 'data'),
    HOST: '127.0.0.1', PORT: String(port), APP_URL: origin, BASE_URL: origin,
    WORKER_ENABLED: 'false', REGISTRATION_ENABLED: 'true', FETCH_ALLOW_HOSTS: '127.0.0.1',
    FEEDINK_TEST_WEBKIT: project === 'webkit' ? '1' : process.env.FEEDINK_TEST_WEBKIT || '0',
    FEEDINK_API_WITNESS_URL: upstreamUrl,
  };
  if (proxy) {
    const path = join(directory, 'network-control.json');
    await writeFile(path, JSON.stringify(proxy), { mode: 0o600, flag: 'wx' });
    env.FEEDINK_NETWORK_CONTROL_FILE = path;
  } else delete env.FEEDINK_NETWORK_CONTROL_FILE;
  log = createWriteStream(join(directory, 'api.log'), { mode: 0o600 });
  api = spawn(process.execPath, ['apps/api/dist/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.pipe(log, { end: false });
  api.stderr.pipe(log, { end: false });
  let spawnError;
  api.on('error', error => { spawnError = error; });
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (!ready && Date.now() < deadline && !interrupted) {
    if (spawnError || api.exitCode !== null || api.signalCode !== null) throw new Error('Test API failed before readiness; private diagnostics were not published');
    try { ready = (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup may still be opening its database */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Test API did not become ready before its deadline');
  runner = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', `--project=${project}`, '--global-timeout=360000', `--output=test-results/${project}`], { env, stdio: 'inherit' });
  const timeout = setTimeout(() => runner.kill('SIGTERM'), 390_000);
  let code;
  try { [code] = await once(runner, 'exit'); } finally { clearTimeout(timeout); }
  success = code === 0 && !interrupted;
  process.exitCode = success ? 0 : 1;
} finally {
  await stop(runner);
  await stop(api);
  await proxy?.close();
  if (log) await new Promise(resolve => log.end(resolve));
  // The temporary control capability and all synthetic test files are never release artifacts.
  await rm(directory, { recursive: true, force: true });
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
