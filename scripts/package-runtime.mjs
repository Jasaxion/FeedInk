import { access, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectPublicText } from './check-public-content.mjs';

const root = process.cwd();
const output = resolve('.artifacts/runtime');
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0'));
const extensions = new Set(['.js', '.mjs', '.cjs', '.map', '.json', '.ts', '.css', '.html', '.webmanifest', '.svg', '.png', '.webp', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.txt', '.sql']);
const secretValues = Object.entries(process.env)
  .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL/.test(key) && value && value.length >= 12)
  .map(([, value]) => value);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
async function copy(source, target) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error('Runtime package refuses source symlinks');
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source)) await copy(join(source, name), join(target, name));
    return;
  }
  if (!info.isFile()) throw new Error('Runtime package accepts only regular files');
  const logical = relative(root, source).split('\\').join('/');
  if (logical.startsWith('apps/api/migrations/') && extname(source) !== '.sql') throw new Error('Unexpected migration artifact');
  if (!['LICENSE', 'NOTICE'].includes(basename(source)) && (!extensions.has(extname(source)) || extname(source) === '.ts' && !source.endsWith('.d.ts'))) throw new Error(`Unexpected runtime artifact type: ${logical}`);
  const bytes = await readFile(source);
  if (!bytes.includes(0)) {
    const text = bytes.toString('utf8');
    if (inspectPublicText(relative(root, source), text).length || secretValues.some(value => text.includes(value))) throw new Error(`Runtime publication check rejected ${relative(root, source)}; inspect privately`);
  }
  await cp(source, target);
}
for (const file of ['package.json', 'package-lock.json', 'LICENSE']) await copy(file, join(output, file));
if (tracked.has('NOTICE')) await copy('NOTICE', join(output, 'NOTICE'));
for (const directory of ['apps', 'packages']) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workspace = join(directory, entry.name);
    if (!tracked.has(join(workspace, 'package.json').split('\\').join('/'))) continue;
    await access(join(workspace, 'package.json'));
    await mkdir(join(output, workspace), { recursive: true });
    await copy(join(workspace, 'package.json'), join(output, workspace, 'package.json'));
    for (const legal of ['LICENSE', 'NOTICE']) if (tracked.has(join(workspace, legal).split('\\').join('/'))) await copy(join(workspace, legal), join(output, workspace, legal));
    await copy(join(workspace, 'dist'), join(output, workspace, 'dist'));
    if (workspace === 'apps/api') await copy(join(workspace, 'migrations'), join(output, workspace, 'migrations'));
  }
}
const files = [];
async function inventory(directory) {
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) await inventory(path);
    else {
      const data = await readFile(path);
      files.push({ path: relative(output, path).split('\\').join('/'), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
}
await inventory(output);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await writeFile(join(output, 'runtime-manifest.json'), JSON.stringify({ version: 1, commit, files }, null, 2) + '\n');
console.log(`Prepared ${files.length} reviewed runtime files; no data, dependencies or environment files included.`);
