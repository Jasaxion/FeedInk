#!/usr/bin/env node
// Private backup format: magic, then newline-delimited JSON headers and exact-length file bytes.
// Only regular files are accepted; there are no link, mode, ownership or executable records.
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const MAGIC = 'FEEDINK-DATA-1\n';
const MAX_HEADER = 8192;
const MAX_FILES = 1_000_000;
const MAX_FILE_BYTES = 20 * 1024 ** 3;
const MAX_TOTAL_BYTES = 1024 ** 4;

export function validatePath(name) {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 4096 ||
      name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..') ||
      /^[A-Za-z]:/.test(name)) throw new Error('Invalid archive path');
  return name;
}

async function write(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, 'drain');
}
async function checkDirectory(root) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('DATA_DIR must be a real directory');
  return realpath(root);
}
async function* files(root, relative = '') {
  for (const entry of (await readdir(path.join(root, relative))).sort()) {
    const name = validatePath(relative ? `${relative}/${entry}` : entry);
    const info = await lstat(path.join(root, name));
    if (info.isDirectory() && !info.isSymbolicLink()) yield* files(root, name);
    else if (info.isFile() && !info.isSymbolicLink()) yield { path: name, size: info.size };
    else throw new Error('DATA_DIR contains a link or non-regular file');
  }
}

export async function pack(root, output) {
  root = await checkDirectory(root);
  await write(output, MAGIC);
  let count = 0, total = 0;
  for await (const header of files(root)) {
    total += header.size;
    if (++count > MAX_FILES || header.size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error('Archive exceeds supported limits');
    await write(output, `${JSON.stringify(header)}\n`);
    let copied = 0;
    for await (const chunk of createReadStream(path.join(root, header.path))) {
      copied += chunk.length;
      if (copied > header.size) throw new Error('File changed during backup; stop every writer');
      await write(output, chunk);
    }
    if (copied !== header.size) throw new Error('File changed during backup; stop every writer');
  }
  await write(output, '{"end":true}\n');
}

class Reader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); }
  async fill() {
    const next = await this.iterator.next();
    if (next.done) return false;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : next.value;
    return true;
  }
  async line() {
    while (true) {
      const index = this.buffer.indexOf(10);
      if (index >= 0) {
        if (index > MAX_HEADER) throw new Error('Archive header too large');
        const line = this.buffer.subarray(0, index).toString('utf8');
        this.buffer = this.buffer.subarray(index + 1);
        return line;
      }
      if (this.buffer.length > MAX_HEADER) throw new Error('Archive header too large');
      if (!await this.fill()) throw new Error('Truncated archive');
    }
  }
  async copy(size, handle) {
    while (size > 0) {
      if (!this.buffer.length && !await this.fill()) throw new Error('Truncated archive file');
      const length = Math.min(size, this.buffer.length);
      if (handle) {
        let offset = 0;
        while (offset < length) {
          const result = await handle.write(this.buffer, offset, length - offset);
          offset += result.bytesWritten;
        }
      }
      this.buffer = this.buffer.subarray(length);
      size -= length;
    }
  }
}

export async function unpack(input, root) {
  if (root) {
    root = await checkDirectory(root);
    if ((await readdir(root)).length) throw new Error('Restore requires an empty DATA_DIR');
  }
  const reader = new Reader(input);
  if (await reader.line() !== MAGIC.trimEnd()) throw new Error('Unsupported data archive');
  const seen = new Set();
  const directories = new Set();
  let total = 0;
  while (true) {
    const header = JSON.parse(await reader.line());
    if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('Invalid archive header');
    if (header.end === true && Object.keys(header).length === 1) {
      if (reader.buffer.length || await reader.fill()) throw new Error('Unexpected trailing archive bytes');
      break;
    }
    if (Object.keys(header).sort().join(',') !== 'path,size') throw new Error('Invalid archive header');
    const name = validatePath(header.path);
    if (!Number.isSafeInteger(header.size) || header.size < 0 || header.size > MAX_FILE_BYTES ||
        (total += header.size) > MAX_TOTAL_BYTES || seen.size >= MAX_FILES || seen.has(name)) throw new Error('Invalid archive size or duplicate path');
    // A file cannot also be another file's parent, regardless of record order.
    const parts = name.split('/');
    if (directories.has(name)) throw new Error('Conflicting archive paths');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (seen.has(parent)) throw new Error('Conflicting archive paths');
      directories.add(parent);
    }
    seen.add(name);
    let handle;
    try {
      if (root) {
        const target = path.join(root, name);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        handle = await open(target, 'wx', 0o600);
      }
      await reader.copy(header.size, handle);
      if (handle) await handle.sync();
    } finally { await handle?.close(); }
  }
}

export function createManifest(databaseHash, dataHash) {
  if (![databaseHash, dataHash].every(hash => /^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid checksum');
  return { format: 'feedink-backup', version: 1, createdAt: new Date().toISOString(),
    files: { 'postgres.dump': databaseHash, 'data.archive': dataHash } };
}
export function validateManifest(info) {
  if (!info || info.format !== 'feedink-backup' || info.version !== 1 || !info.files ||
      Object.keys(info.files).sort().join(',') !== 'data.archive,postgres.dump' ||
      !Object.values(info.files).every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) throw new Error('Unsupported backup manifest');
  return `${info.files['postgres.dump']} ${info.files['data.archive']}`;
}

async function main() {
  const [command, directory] = process.argv.slice(2);
  if (command === 'pack') await pack(directory, process.stdout);
  else if (command === 'unpack') await unpack(process.stdin, directory);
  else if (command === 'manifest') process.stdout.write(JSON.stringify(createManifest(directory, process.argv[4]), null, 2) + '\n');
  else if (command === 'verify-manifest') {
    let bytes = Buffer.alloc(0);
    for await (const chunk of process.stdin) {
      if (bytes.length + chunk.length > MAX_HEADER) throw new Error('Manifest too large');
      bytes = Buffer.concat([bytes, chunk]);
    }
    process.stdout.write(validateManifest(JSON.parse(bytes.toString('utf8'))) + '\n');
  } else if (command === 'check') await unpack(process.stdin);
  else if (command === 'empty') {
    await checkDirectory(directory);
    if ((await readdir(directory)).length) throw new Error('Restore requires an empty DATA_DIR');
  } else throw new Error('Unknown archive command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Archive operation failed; check input, permissions, free space and archive limits. No files were removed.'); process.exitCode = 1; });
}
