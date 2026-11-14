import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { buildShell } from './build/shell';

export default defineConfig({
  plugins: [react(), { name: 'feedink-offline-shell', closeBundle: () => buildShell() }],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: { sourcemap: false, target: 'es2022' },
});
