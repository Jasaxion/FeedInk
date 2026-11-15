import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const script = resolve('scripts/package-runtime.mjs');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'feedink-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': '{"name":"fixture","version":"0.0.0","private":true}',
    'package-lock.json': '{}', LICENSE: 'Fixture license',
    'apps/api/package.json': '{"name":"@fixture/api"}',
    'apps/api/dist/server.js': 'export const ready = true;',
    'apps/api/migrations/001.sql': 'SELECT 1;',
    'apps/web/package.json': '{"name":"@fixture/web"}',
    'apps/web/dist/index.html': '<!doctype html><title>Fixture</title>',
    'apps/web/dist/manifest.webmanifest': '{"name":"Fixture","display":"standalone"}',
    'packages/shared/package.json': '{"name":"@fixture/shared"}',
    'packages/shared/dist/index.js': 'export const version = 1;',
  };
  for (const [name, content] of Object.entries(files)) { await mkdir(join(root, name, '..'), { recursive: true }); await writeFile(join(root, name), content); }
  const git = args => { const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'fixture']);
  return root;
}
const run = (root, env = {}) => spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });

test('runtime bundle includes only declared build inputs and verified hashes', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.env'), 'PRIVATE=not-for-publication');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(root, '.artifacts/runtime/runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.files.some(file => file.path === '.env'), false);
  assert.equal(manifest.files.some(file => file.path === 'apps/web/dist/manifest.webmanifest'), true);
  for (const file of manifest.files) {
    const bytes = await readFile(join(root, '.artifacts/runtime', file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(bytes.length, file.bytes);
  }
});

test('embedded environment secrets are rejected without echoing values', async t => {
  const root = await fixture(t);
  const secret = randomBytes(24).toString('hex');
  await writeFile(join(root, 'apps/api/dist/server.js'), `export const wrong = '${secret}';`);
  const result = run(root, { SESSION_SECRET: secret });
  assert.notEqual(result.status, 0);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
});

test('source symlinks and unexpected migration files are rejected', async t => {
  const root = await fixture(t);
  await symlink(join(root, 'LICENSE'), join(root, 'apps/api/dist/link.js'));
  assert.notEqual(run(root).status, 0);
  await rm(join(root, 'apps/api/dist/link.js'));
  await writeFile(join(root, 'apps/api/migrations/private.json'), '{}');
  assert.notEqual(run(root).status, 0);
});
