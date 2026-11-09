import assert from 'node:assert/strict';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createServer, preview } from 'vite';

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const privateMarker = 'synthetic-private-omnikit-state';
const publicMarker = 'synthetic-public-asset';

async function prepareFixture(t, vaultFile = 'custom/profile[1].enc') {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'omnikit-vite-boundary-'));
  const previousCwd = process.cwd();
  const environment = {
    OMNIKIT_BUILD_SHA: 'synthetic',
    OMNIKIT_NO_BROWSER: 'true',
    OMNIKIT_VAULT_PATH: path.join(root, vaultFile),
    OMNIKIT_JOB_HISTORY_PATH: path.join(root, 'custom/history.json'),
    OMNIKIT_DB_PATH: path.join(root, 'custom/previous-db.json'),
    OMNIKIT_JOBS_PATH: path.join(root, 'custom/legacy.json'),
  };
  const previousEnv = new Map(
    [...Object.keys(environment), 'NODE_ENV'].map((key) => [key, process.env[key]]),
  );
  let vite;
  t.after(async () => {
    try {
      await vite?.close();
    } finally {
      process.chdir(previousCwd);
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  process.chdir(root);
  Object.assign(process.env, environment);

  return {
    root,
    async write(relativePath, content) {
      const file = path.join(root, relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    async start() {
      vite = await createServer({
        configFile,
        root,
        logLevel: 'silent',
        server: { open: false, watch: null, hmr: false },
      });
      // Binding the underlying HTTP server to 0 lets the OS choose an unused port.
      const listening = once(vite.httpServer, 'listening');
      vite.httpServer.listen(0, '127.0.0.1');
      await listening;
      return `http://127.0.0.1:${vite.httpServer.address().port}`;
    },
  };
}

function fsUrl(root, relativePath) {
  return `/@fs${pathToFileURL(path.join(root, relativePath)).pathname}`;
}

test('the Vite dev server rejects anonymous requests for local state and its sidecars', async (t) => {
  const fixture = await prepareFixture(t);
  const privateFiles = [
    'data/vault.enc',
    'data/vault.enc.bak',
    'data/omnikit-jobs.json',
    'data/jobs.json',
    'custom/profile[1].enc',
    'custom/profile[1].enc.bak',
    'custom/profile[1].enc.bak.123.purge.tmp',
    'custom/history.json',
    'custom/history.json.123.456.tmp',
    'custom/previous-db.json',
    'custom/legacy.json',
    'custom/legacy.json.bak',
    'archives/operator-backup-2026.enc',
    '.git/config',
    '.env',
  ];
  for (const name of privateFiles) {
    const content = name === '.env' ? `PRIVATE_FIXTURE=${privateMarker}\n` : JSON.stringify(privateMarker);
    await fixture.write(name, content);
  }
  await fixture.write('safe.txt', publicMarker);
  await fixture.write('public/safe-public.txt', publicMarker);
  await symlink(path.join(fixture.root, 'custom/history.json'), path.join(fixture.root, 'notes.txt'), 'file');
  await symlink(path.join(fixture.root, 'custom/history.json'), path.join(fixture.root, 'public/report.txt'), 'file');
  const origin = await fixture.start();

  for (const url of ['/safe.txt', '/safe-public.txt', fsUrl(fixture.root, 'safe.txt')]) {
    const response = await fetch(origin + url);
    assert.equal(response.status, 200, url);
    assert.equal(await response.text(), publicMarker, url);
  }
  const transformed = await fetch(origin + '/safe.txt?raw');
  assert.equal(transformed.status, 200);
  assert.ok((await transformed.text()).includes(publicMarker));
  // Public assets can be addressed without their public/ prefix.
  const privateUrls = ['/report.txt', '/report.txt?raw', '/report.txt?inline'];
  for (const name of [...privateFiles, 'notes.txt', 'public/report.txt']) {
    const directUrl = '/' + name.split('/').map(encodeURIComponent).join('/');
    const absoluteUrl = fsUrl(fixture.root, name);
    privateUrls.push(directUrl, absoluteUrl, `${directUrl}?raw`, `${absoluteUrl}?inline`);
  }
  for (const url of privateUrls) {
    const response = await fetch(origin + url, { redirect: 'manual' });
    const body = await response.text();
    assert.ok(!body.includes(privateMarker), `Disclosed fixture bytes through ${url}`);
    assert.ok([403, 404].includes(response.status), `Expected denial for ${url}, received ${response.status}`);
  }
});

test('Vite refuses to start when a state file is inside the public asset directory', async (t) => {
  const fixture = await prepareFixture(t, 'public/private-vault.enc');
  await fixture.write('public/private-vault.enc', privateMarker);
  await assert.rejects(fixture.start(), /public|build output/i);
});

test('preview serves the UI and local API but not backup files or aliased private state', async (t) => {
  const fixture = await prepareFixture(t);
  await fixture.write('dist/safe.txt', publicMarker);
  await fixture.write('dist/operator.enc.bak', privateMarker);
  await fixture.write('custom/history.json', privateMarker);
  await symlink(path.join(fixture.root, 'custom/history.json'), path.join(fixture.root, 'dist/report.txt'), 'file');
  const server = await preview({ root: fixture.root, configFile, logLevel: 'silent',
    preview: { host: '127.0.0.1', port: 0, open: false, strictPort: true } });
  try {
    const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
    assert.equal(await (await fetch(origin + '/safe.txt')).text(), publicMarker);
    assert.equal((await (await fetch(origin + '/api/healthz')).json()).ok, true);
    for (const url of ['/operator.enc.bak', '/report.txt']) {
      const response = await fetch(origin + url);
      assert.equal(response.status, 403);
      assert.ok(!(await response.text()).includes(privateMarker));
    }
  } finally { await server.close(); }
});

test('the Vite build rejects private public assets before they reach the output', async (t) => {
  const fixture = await prepareFixture(t);
  const options = { configFile, root: fixture.root, logLevel: 'silent' };
  await fixture.write('index.html', '<!doctype html><title>Fixture</title>');
  await fixture.write('public/safe.txt', publicMarker);
  await fixture.write('custom/history.json', JSON.stringify(privateMarker));

  const report = path.join(fixture.root, 'public/report.txt');
  await symlink(path.join(fixture.root, 'custom/history.json'), report, 'file');
  await assert.rejects(build(options), /public|private state/i);
  await assert.rejects(lstat(path.join(fixture.root, 'dist/report.txt')), { code: 'ENOENT' });
  await rm(report);

  const backup = 'operator-backup-2026.enc';
  await fixture.write(`public/${backup}`, privateMarker);
  await assert.rejects(build(options), /public|private state/i);
  await assert.rejects(lstat(path.join(fixture.root, 'dist', backup)), { code: 'ENOENT' });
  await rm(path.join(fixture.root, 'public', backup));

  await build(options);
  assert.equal(await readFile(path.join(fixture.root, 'dist/safe.txt'), 'utf8'), publicMarker);
});
