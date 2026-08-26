import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';

const guardPath = path.resolve('scripts/check-retired-document-endpoints.mjs');
const tempRoots: string[] = [];

function makeSourceTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'omnikit-documents-contract-'));
  tempRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, 'utf8');
  }
  return root;
}

function runGuard(root: string) {
  return spawnSync(process.execPath, [guardPath, '--root', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() || '', { recursive: true, force: true });
  }
});

test('guard rejects each of the five exact retired Documents V1 contracts', () => {
  const root = makeSourceTree({
    'server/retired.ts': `
      const documentId = 'doc-1';
      const retiredRead = \`/api/v1/documents/\${documentId}\`;
      client.request('POST', '/api/v1/documents');
      client.request('POST', \`/api/v1/documents/\${documentId}/draft\`);
      client.request('PUT', \`/api/v1/documents/\${documentId}\`);
      omniProxy(baseUrl, apiKey, 'PATCH', \`/v1/documents/\${documentId}\`);
      client.request('GET', retiredRead);
    `,
  });

  const result = runGuard(root);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /POST \/v1\/documents\b/);
  assert.match(output, /POST \/v1\/documents\/:documentId\/draft/);
  assert.match(output, /PUT \/v1\/documents\/:documentId/);
  assert.match(output, /PATCH \/v1\/documents\/:documentId/);
  assert.match(output, /GET \/v1\/documents\/:documentId/);
});

test('guard allows current Documents V1 reads and subresources, including queries', () => {
  const root = makeSourceTree({
    'src/current.ts': `
      const id = 'doc-1';
      client.request('GET', '/api/v1/documents?include=labels');
      client.request('GET', \`/api/v1/documents/\${id}/queries\`);
      client.request('PUT', \`/api/v1/documents/\${id}/move\`);
      client.request('DELETE', \`/api/v1/documents/\${id}\`);
      client.request('PATCH', \`/api/v1/documents/\${id}/labels\`);
      client.request('POST', \`/api/v1/documents/\${id}/permissions\`);
      client.request('GET', \`/api/v1/documents/\${id}/downloads\`);
      client.request('GET', \`/api/v1/dashboards/\${id}/filters\`);
    `,
  });

  const result = runGuard(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /guard passed/);
});

test('guard is method-aware for exact document paths', () => {
  const root = makeSourceTree({
    'server/methods.ts': `
      const id = 'doc-1';
      client.request('GET', '/api/v1/documents');
      client.request('DELETE', \`/api/v1/documents/\${id}\`);
      client.request('POST', \`/api/v1/documents/\${id}\`);
      client.request('PUT', \`/api/v1/documents/\${id}/labels\`);
    `,
  });

  const result = runGuard(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('guard scans production source only and ignores tests, docs, and fixtures', () => {
  const retired = "client.request('POST', '/api/v1/documents');";
  const root = makeSourceTree({
    'server/live.ts': "client.request('GET', '/api/v1/documents');",
    'server/fixtures/retired.ts': retired,
    'src/component.test.ts': retired,
    'tests/retired.test.ts': retired,
    'docs/example.ts': retired,
  });

  const result = runGuard(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('Deck Builder keeps the supported document-query loader while AI Content Studio uses the governed AI job contract', () => {
  const loader = readFileSync(path.resolve('src/services/deckBuilder/omniDeckApi.ts'), 'utf8');
  const deckBuilder = readFileSync(path.resolve('src/pages/DeckBuilderPage.tsx'), 'utf8');
  const app = readFileSync(path.resolve('src/App.tsx'), 'utf8');
  const contracts = readFileSync(path.resolve('server/services/omniApiContracts.ts'), 'utf8');

  assert.match(loader, /\/v1\/documents\/\$\{encodeURIComponent\(dashboardId\)\}\/queries/);
  assert.match(loader, /fetchDashboardList\(baseUrl, apiKey\)/);
  assert.match(deckBuilder, /fetchDashboardSummary/);
  assert.match(app, /path="\/content\/ai-studio"/);
  assert.match(app, /QueryPreservingRedirect to="\/content\/ai-studio"/);
  assert.match(contracts, /workflows: \['semantic_studio', 'ai_content_studio'\]/);
  assert.match(contracts, /narrative output is not registered as a persistent Omni report artifact/);
  assert.doesNotMatch(contracts, /ai_dashboard_studio/);
});
