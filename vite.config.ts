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
  },
  server: {
    host: '127.0.0.1',
    open: true,
  },
  preview: {
    host: '127.0.0.1',
  },
});
