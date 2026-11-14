import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pack, unpack, validatePath, createManifest, validateManifest } from './data-archive.mjs';

async function packed(root) {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', chunk => chunks.push(chunk));
  await pack(root, output);
  return Buffer.concat(chunks);
}
function archive(records, suffix = '') {
  return Readable.from([Buffer.from('FEEDINK-DATA-1\n' + records + suffix)]);
}
function record(name, data = '') { return `${JSON.stringify({ path: name, size: Buffer.byteLength(data) })}\n${data}`; }
const END = '{"end":true}\n';

test('data archive round-trips nested binary files and ignores empty directories', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'feedink-source-'));
  const target = await mkdtemp(path.join(tmpdir(), 'feedink-target-'));
  await mkdir(path.join(source, 'images', 'nested'), { recursive: true });
  const image = Buffer.from([0, 10, 255, 42]);
  await writeFile(path.join(source, 'images', 'nested', '图像.png'), image);
  await writeFile(path.join(source, 'empty'), '');
  const bytes = await packed(source);
  // Deliberately split headers and file bodies across arbitrary network chunks.
  await unpack(Readable.from(Array.from(bytes, byte => Buffer.from([byte]))), target);
  assert.deepEqual(await readFile(path.join(target, 'images', 'nested', '图像.png')), image);
  assert.equal((await readFile(path.join(target, 'empty'))).length, 0);
});

test('data archive rejects traversal, absolute paths and special path spellings', () => {
  for (const value of ['../outside', '/absolute', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'C:thing', 'x\u0000y', 'x\ny', '']) {
    assert.throws(() => validatePath(value), /Invalid archive path/);
  }
});

test('data archive rejects duplicates, conflicting parents and unsupported metadata', async () => {
  for (const records of [record('a') + record('a'), record('a') + record('a/b'), record('a/b') + record('a'),
    '{"path":"link","size":0,"symlink":"/etc/passwd"}\n']) {
    await assert.rejects(unpack(archive(records + END)));
  }
});

test('data archive rejects truncation, trailing bytes, bad headers and excessive sizes', async () => {
  for (const content of ['no magic', 'FEEDINK-DATA-1\n', 'FEEDINK-DATA-1\n' + record('a', 'foo').slice(0, -1),
    'FEEDINK-DATA-1\n' + END + 'extra', 'FEEDINK-DATA-1\n' + 'x'.repeat(9000),
    'FEEDINK-DATA-1\n{"path":"a","size":-1}\n', 'FEEDINK-DATA-1\n{"path":"a","size":999999999999999}\n']) {
    await assert.rejects(unpack(Readable.from([Buffer.from(content)])));
  }
});

test('data archive refuses symlinks on export and a nonempty restore target without deleting files', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'feedink-links-'));
  await symlink('/etc/passwd', path.join(source, 'link'));
  await assert.rejects(packed(source), /link or non-regular/);
  await assert.rejects(unpack(archive(END), source), /empty DATA_DIR/);
  assert.deepEqual(await readdir(source), ['link']);
});

test('data archive validates before creating a traversal path', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'feedink-safe-'));
  await assert.rejects(unpack(archive(record('../outside') + END), target), /Invalid archive path/);
  assert.deepEqual(await readdir(target), []);
});

test('backup manifest requires the exact version and two SHA-256 checksums', () => {
  const first = 'a'.repeat(64), second = 'b'.repeat(64);
  const info = createManifest(first, second);
  assert.equal(validateManifest(info), `${first} ${second}`);
  for (const invalid of [null, {}, { ...info, version: 2 }, { ...info, files: { ...info.files, extra: first } },
    { ...info, files: { 'postgres.dump': '../file', 'data.archive': second } }]) assert.throws(() => validateManifest(invalid));
  assert.throws(() => createManifest('oops', second));
});
