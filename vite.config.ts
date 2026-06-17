import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { omniApiPlugin } from './server/vitePlugin';

export default defineConfig({
  plugins: [react(), omniApiPlugin()],
  build: {
    target: 'esnext',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: true,
  },
  preview: {
    host: '127.0.0.1',
  },
});
