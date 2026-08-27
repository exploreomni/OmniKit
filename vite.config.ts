import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'path';
import { omniApiPlugin } from './server/vitePlugin';

function normalizedBuildToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned && /^[A-Za-z0-9._+-]{1,80}$/.test(cleaned) ? cleaned : undefined;
}

function resolvePackageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version?: unknown };
    return normalizedBuildToken(parsed.version) || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function resolveBuildSha(): string {
  for (const candidate of [
    process.env.OMNIKIT_BUILD_SHA,
    process.env.GITHUB_SHA,
    process.env.SOURCE_VERSION,
  ]) {
    const normalized = normalizedBuildToken(candidate);
    if (normalized) return normalized.slice(0, 12);
  }
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const normalized = normalizedBuildToken(sha);
    if (!normalized) return 'development';
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
    return dirty ? `${normalized}-dirty` : normalized;
  } catch {
    return 'development';
  }
}

const omniKitVersion = resolvePackageVersion();
const omniKitBuildSha = resolveBuildSha();

export default defineConfig({
  plugins: [react(), omniApiPlugin()],
  define: {
    __OMNIKIT_VERSION__: JSON.stringify(omniKitVersion),
    __OMNIKIT_BUILD_SHA__: JSON.stringify(omniKitBuildSha),
  },
  build: {
    target: 'esnext',
    manifest: true,
    chunkSizeWarningLimit: 800,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: process.env.OMNIKIT_NO_BROWSER !== 'true',
  },
  preview: {
    host: '127.0.0.1',
  },
});
