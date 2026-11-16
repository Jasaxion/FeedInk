import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { buildShell } from './build/shell';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

export default defineConfig({
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
  plugins: [react(), { name: 'feedink-offline-shell', closeBundle: () => buildShell() }],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: { sourcemap: false, target: 'es2022' },
});
