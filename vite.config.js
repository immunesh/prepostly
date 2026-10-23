import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = `http://127.0.0.1:${process.env.PORT || 4100}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5174,
    proxy: Object.fromEntries(['/api', '/v1', '/media', '/uploads', '/outbox', '/mcp', '/oauth', '/healthz'].map((p) => [p, target])),
  },
});
