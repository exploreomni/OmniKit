import type { Plugin } from 'vite';
import { apiMiddleware } from './apiMiddleware';

export function omniApiPlugin(): Plugin {
  return {
    name: 'omnikit-local-api',
    configureServer(server) {
      server.middlewares.use(apiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(apiMiddleware());
    },
  };
}
