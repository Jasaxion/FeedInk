import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';

export function shellVersion(worker: string, resources: [string, Uint8Array][]): string {
  const hash = createHash('sha256').update(worker);
  for (const [path, bytes] of [...resources].sort(([a], [b]) => a.localeCompare(b))) hash.update(path).update('\0').update(bytes).update('\0');
  return hash.digest('hex').slice(0, 20);
}
export async function buildShell(directory = 'dist', workerPath = 'public/sw.js') {
  const assets = (await readdir(`${directory}/assets`)).map(name => `/assets/${name}`);
  const shell = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', ...assets];
  const worker = await readFile(workerPath, 'utf8');
  const resources = await Promise.all(shell.map(async path => [path, await readFile(`${directory}${path === '/' ? '/index.html' : path}`)] as [string, Uint8Array]));
  await writeFile(`${directory}/sw.js`, worker.replace('/* SHELL_ASSETS */ []', JSON.stringify(shell)).replace('SHELL_VERSION', shellVersion(worker, resources)));
}
