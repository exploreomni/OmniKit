import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildModelMigratorInventory,
  classifyModelMigratorDocument,
} from '../server/handlers/model-migrator';
import {
  applySchemaMapToYaml,
  buildFieldUniverseFromYaml,
  buildWorkbookTabResultDetails,
  detectConnectionSettingWarnings,
  normalizeBranchName,
  normalizeContentValidationIssues,
  parseSchemaMap,
  preflightWorkbookQueryFields,
  promptForYamlFile,
  rewriteQueryModelReferences,
  buildTranslatedYamlFiles,
} from '../server/services/modelMigration/helpers';
import {
  extractYamlFromAiResult,
  isAiRefusalText,
  shouldRunAiDialectPass,
} from '../server/services/modelMigration/aiTranslation';
import { OmniClient, type OmniDocumentRecord } from '../server/services/omniClient';

function document(id: string, patch: Partial<OmniDocumentRecord>): OmniDocumentRecord {
  return {
    id,
    identifier: id,
    name: id,
    baseModelId: 'model-a',
    ...patch,
  };
}

test('classifies dashboard and workbook-only documents from Omni metadata', () => {
  assert.equal(classifyModelMigratorDocument({ hasDashboard: true }), 'dashboard');
  assert.equal(classifyModelMigratorDocument({ type: 'dashboard' }), 'dashboard');
  assert.equal(classifyModelMigratorDocument({ hasDashboard: false }), 'workbook');
  assert.equal(classifyModelMigratorDocument({ type: 'workbook' }), 'workbook');
  assert.equal(classifyModelMigratorDocument({ type: 'analysis' }), 'workbook');
  assert.equal(classifyModelMigratorDocument({}), 'unknown');
});

test('builds per-model inventory without dropping workbook-only documents', () => {
  const rows = buildModelMigratorInventory([
    document('dash-1', { hasDashboard: true, description: 'Executive dashboard', labels: ['exec'] }),
    document('workbook-1', { hasDashboard: false }),
    document('unknown-1', {}),
    document('other-model', { baseModelId: 'model-b', hasDashboard: true }),
  ], ['model-a', 'model-c']);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    modelId: 'model-a',
    dashboardCount: 1,
    workbookCount: 1,
    unknownCount: 1,
    documents: [
      {
        id: 'dash-1',
        identifier: 'dash-1',
        name: 'dash-1',
        baseModelId: 'model-a',
        kind: 'dashboard',
        description: 'Executive dashboard',
        labels: ['exec'],
      },
      {
        id: 'unknown-1',
        identifier: 'unknown-1',
        name: 'unknown-1',
        baseModelId: 'model-a',
        kind: 'unknown',
      },
      {
        id: 'workbook-1',
        identifier: 'workbook-1',
        name: 'workbook-1',
        baseModelId: 'model-a',
        kind: 'workbook',
      },
    ],
  });
  assert.deepEqual(rows[1], {
    modelId: 'model-c',
    dashboardCount: 0,
    workbookCount: 0,
    unknownCount: 0,
    documents: [],
  });
});

test('OmniClient listModels sends connection-scoped model filters to Omni', async (t) => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer test-token');
    return new Response(JSON.stringify({
      records: [{
        id: 'model-a',
        name: 'Model A',
        connectionId: 'connection-a',
        modelKind: 'SHARED',
      }],
      pageInfo: { hasNextPage: false },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const client = new OmniClient({
    label: 'Test',
    baseUrl: 'https://example.omniapp.co',
    apiKey: 'test-token',
  });
  const models = await client.listModels({ modelKind: 'SHARED', connectionId: 'connection-a' });
  const url = new URL(requestedUrl);

  assert.equal(url.pathname, '/api/v1/models');
  assert.equal(url.searchParams.get('modelKind'), 'SHARED');
  assert.equal(url.searchParams.get('connectionId'), 'connection-a');
  assert.deepEqual(models.map((model) => model.connectionId), ['connection-a']);
});

test('OmniClient listFolderDocuments preserves document connection metadata', async (t) => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      records: [{
        identifier: 'coffee-shop-demo',
        name: 'Coffee Shop Demo',
        connectionId: 'coffee-connection',
        folder: { id: 'folder-1', path: 'omni-training' },
        labels: ['training'],
      }],
      pageInfo: { hasNextPage: false },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const client = new OmniClient({
    label: 'Test',
    baseUrl: 'https://example.omniapp.co',
    apiKey: 'document-test-token',
  });
  const documents = await client.listFolderDocuments('folder-1', true);
  const url = new URL(requestedUrl);

  assert.equal(url.pathname, '/api/v1/documents');
  assert.equal(url.searchParams.get('folderId'), 'folder-1');
  assert.equal(url.searchParams.get('include'), 'labels');
  assert.equal(documents[0].connectionId, 'coffee-connection');
  assert.equal(documents[0].folderPath, 'omni-training');
});

test('schema-map rewrite and branch normalization are deterministic', () => {
  const rules = parseSchemaMap('ANALYTICS.PUBLIC -> main.analytics\nRAW.EVENTS, bronze.events');
  assert.deepEqual(rules, [
    { source: 'ANALYTICS.PUBLIC', target: 'main.analytics' },
    { source: 'RAW.EVENTS', target: 'bronze.events' },
  ]);
  const rewritten = applySchemaMapToYaml('sql: SELECT * FROM ANALYTICS.PUBLIC.orders JOIN RAW.EVENTS.clicks', rules);
  assert.equal(rewritten.yaml, 'sql: SELECT * FROM main.analytics.orders JOIN bronze.events.clicks');
  assert.equal(rewritten.replacements, 2);
  const quoted = applySchemaMapToYaml('sql: SELECT * FROM "ANALYTICS"."PUBLIC"."orders"', rules);
  assert.equal(quoted.yaml, 'sql: SELECT * FROM main.analytics."orders"');
  assert.equal(quoted.replacements, 1);
  assert.equal(normalizeBranchName(' OmniKit Model Migration: Revenue! '), 'omnikit-model-migration-revenue');
});

test('deterministic translation flags connection settings that require review', () => {
  const translated = buildTranslatedYamlFiles({
    files: { 'orders.view': 'connection: snowflake_prod\nsql: SELECT * FROM ANALYTICS.PUBLIC.orders' },
    schemaMap: [{ source: 'ANALYTICS.PUBLIC', target: 'main.analytics' }],
    sourceDialect: 'snowflake',
    targetDialect: 'databricks',
  })[0];
  assert.equal(translated.deterministic, 'connection: snowflake_prod\nsql: SELECT * FROM main.analytics.orders');
  assert.equal(translated.translated, translated.deterministic);
  const warnings = detectConnectionSettingWarnings([
    'connection: snowflake_prod',
    'warehouse: TRANSFORMING',
    'query_timezone: America/Chicago',
  ].join('\n'));
  assert.deepEqual(warnings, [
    'connection may not transfer across connections; review the target model settings before merge.',
    'warehouse may not transfer across connections; review the target model settings before merge.',
    'query_timezone may not transfer across connections; review the target model settings before merge.',
  ]);
});

test('dialect prompt includes guardrails and complete file context', () => {
  const prompt = promptForYamlFile({
    sourceDialect: 'snowflake',
    targetDialect: 'databricks',
    fileName: 'orders.view',
    schemaMap: [{ source: 'ANALYTICS.PUBLIC', target: 'main.analytics' }],
    yaml: 'sql: SELECT COUNT(*) FROM main.analytics.orders',
  });
  assert.match(prompt, /Never invent views, fields, joins/);
  assert.match(prompt, /snowflake to databricks/i);
  assert.match(prompt, /orders\.view/);
});

test('AI dialect helpers extract YAML and scope AI to SQL-bearing files', () => {
  const yaml = extractYamlFromAiResult({
    result: {
      content: [
        'Here is the file:',
        '```yaml',
        'sql: SELECT 1',
        '```',
      ].join('\n'),
    },
  });
  assert.equal(yaml, 'sql: SELECT 1');
  assert.equal(extractYamlFromAiResult({ text: 'I cannot rewrite this file.' }), '');
  assert.equal(isAiRefusalText('I cannot rewrite this file.'), true);
  assert.equal(shouldRunAiDialectPass('orders.view', 'dimensions:\n  id:\n    sql: ${TABLE}.id'), true);
  assert.equal(shouldRunAiDialectPass('orders.view', 'dimensions:\n  id:\n    label: ID'), false);
  assert.equal(shouldRunAiDialectPass('notes.txt', 'sql: SELECT 1'), false);
});

test('workbook query rewrite swaps model references and blocks absent fields', () => {
  const rewrite = rewriteQueryModelReferences({
    modelId: 'source-model',
    fields: ['orders.count', 'orders.missing'],
    filters: [{ field: 'orders.count' }],
  }, 'source-model', 'target-model');
  assert.equal(rewrite.query.modelId, 'target-model');
  assert.equal(rewrite.replacements, 1);
  assert.deepEqual(rewrite.fieldReferences, ['orders.count', 'orders.missing']);

  const universe = buildFieldUniverseFromYaml({
    'orders.view': [
      'dimensions:',
      '  count:',
      '    sql: count(*)',
    ].join('\n'),
  });
  const preflight = preflightWorkbookQueryFields(rewrite, universe);
  assert.deepEqual(preflight.blockers, ['Field is not available on the target model: orders.missing']);
});

test('workbook tab result details disclose carried fields and document retry boundary', () => {
  const tabs = buildWorkbookTabResultDetails([
    { name: 'Revenue', description: 'Executive view', visConfig: { type: 'bar' } },
    { name: 'Detail' },
  ], 'not_created');

  assert.deepEqual(tabs, [
    {
      name: 'Revenue',
      status: 'not_created',
      retryBoundary: 'document',
      carried: ['query', 'visConfig', 'description'],
    },
    {
      name: 'Detail',
      status: 'not_created',
      retryBoundary: 'document',
      carried: ['query'],
    },
  ]);
});

test('content validation responses normalize into punch-list issues', () => {
  const issues = normalizeContentValidationIssues({
    issues: [{
      severity: 'warning',
      message: 'Field moved',
      documentId: 'doc-1',
      field: 'orders.count',
      validationStatus: 'pre-existing',
    }],
    errors: [{
      error: 'Missing field',
      documentName: 'Executive Dashboard',
      view: 'orders',
      targetUrl: 'https://target.example/doc',
      blocking: true,
    }],
  });
  assert.deepEqual(issues.map((issue) => ({
    severity: issue.severity,
    status: issue.status,
    message: issue.message,
    document: issue.documentName || issue.documentId,
    field: issue.field,
    view: issue.view,
    targetUrl: issue.targetUrl,
  })), [
    { severity: 'warning', status: 'pre_existing', message: 'Field moved', document: 'doc-1', field: 'orders.count', view: undefined, targetUrl: undefined },
    { severity: 'error', status: 'blocking', message: 'Missing field', document: 'Executive Dashboard', field: undefined, view: 'orders', targetUrl: 'https://target.example/doc' },
  ]);
});
