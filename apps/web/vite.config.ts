import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export default defineConfig({
  plugins: [react(), {
    name: 'feedink-offline-shell',
    async closeBundle() {
      const assets = (await readdir('dist/assets')).map(name => `/assets/${name}`);
      const shell = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', ...assets];
      const version = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 12);
      const source = await readFile('public/sw.js', 'utf8');
      await writeFile('dist/sw.js', source.replace('/* SHELL_ASSETS */ []', JSON.stringify(shell)).replace('SHELL_VERSION', version));
    },
  }],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: { sourcemap: false, target: 'es2022' },
});
