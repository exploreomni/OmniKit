import { readdirSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isFileLoadingAllowed, normalizePath, type Connect, type Plugin, type ResolvedConfig } from 'vite';

// Setting fs.deny replaces Vite's defaults. Keep its private-file rules as well
// as OmniKit's, including named .enc backups made by the backup utility.
const denyDefaults = ['.env', '.env.*', '*.{crt,pem}', '**/.git/**',
  '.npmrc', '.yarnrc.yml', '*.{key,p12,pfx,cer,der}', '*.enc', '*.enc.*'];

const missing = (err: unknown) => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException)?.code ?? '');

// The path may not exist until the first save. Resolve existing parent links
// too, without ever opening a vault, backup, or history file.
function canonical(file: string): string {
  try { return realpathSync.native(file); } catch (err) {
    const parent = path.dirname(file);
    if (!missing(err) || parent === file) throw err;
    return path.join(canonical(parent), path.basename(file));
  }
}

function variants(files: string[]): string[] {
  return [...new Set(files.flatMap(file => [path.resolve(file), canonical(path.resolve(file))]))];
}

function literalGlob(file: string): string {
  return normalizePath(file).replace(/[\\*?[\]{}()!+@|]/g, '\\$&');
}

function within(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// Vite copies public/ verbatim into dist, including the contents of symlinks.
// Validate before the copy: once bytes have been copied they lose their private path.
function checkPublicBuildInputs(config: ResolvedConfig, dir: string): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) {
    if (dir === config.publicDir && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if ((!entry.isFile() && !entry.isDirectory()) || !isFileLoadingAllowed(config, normalizePath(file))) {
      throw new Error('OmniKit public build assets must be ordinary files or directories, not symlinks or private files.');
    }
    if (entry.isDirectory()) checkPublicBuildInputs(config, file);
  }
}

// Vite's public asset handler doesn't enforce fs.deny; a symlink can also
// give a private file an innocent URL. Apply Vite's policy to its real target.
function guardStatic(config: ResolvedConfig, roots: string[]): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (req.url?.startsWith('/api/')) return next();
    const deny = () => { res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); };
    try {
      const url = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
      const files = url.startsWith('/@fs/')
        ? [path.resolve(path.parse(config.root).root, url.slice(5))]
        : roots.map(root => path.resolve(root, '.' + url));
      for (const file of files) {
        // Do not require a file to exist before denying a private URL.
        if (!isFileLoadingAllowed(config, normalizePath(file))) return deny();
        try {
          if (!isFileLoadingAllowed(config, normalizePath(await realpath(file)))) return deny();
        } catch (err) { if (!missing(err)) return deny(); }
      }
    } catch { return deny(); }
    next();
  };
}

export function localStateBoundary(): Plugin {
  return {
    name: 'omnikit-local-state-boundary',
    enforce: 'pre',
    config(config) {
      const root = path.resolve(config.root || '.');
      const dirs = variants([path.join(root, 'data'), path.resolve('data')]);
      const files = variants([
        process.env.OMNIKIT_VAULT_PATH, process.env.OMNIKIT_JOB_HISTORY_PATH,
        process.env.OMNIKIT_DB_PATH, process.env.OMNIKIT_JOBS_PATH,
      ].filter((file): file is string => Boolean(file)));
      const served = variants([
        ...(config.publicDir === false || config.publicDir === '' ? [] : [path.resolve(root, config.publicDir || 'public')]),
        path.resolve(root, config.build?.outDir || 'dist'),
      ]);
      if (served.some(dir => dirs.some(state => within(state, dir) || within(dir, state))
          || files.some(file => within(file, dir)))) {
        throw new Error('OmniKit private state must not overlap the public assets or build output directory.');
      }
      return { server: { fs: { strict: true, deny: [
        ...denyDefaults,
        ...dirs.flatMap(dir => [literalGlob(dir), literalGlob(dir) + '/**']),
        ...files.flatMap(file => [literalGlob(file), literalGlob(file) + '.*']),
      ] } } };
    },
    configResolved(config) {
      if (config.command === 'build' && config.build.copyPublicDir && config.publicDir) {
        checkPublicBuildInputs(config, config.publicDir);
      }
    },
    configureServer(server) {
      server.middlewares.use(guardStatic(server.config, [server.config.root, server.config.publicDir].filter(Boolean)));
    },
    configurePreviewServer(server) {
      server.middlewares.use(guardStatic(server.config, [path.resolve(server.config.root, server.config.build.outDir)]));
    },
  };
}
