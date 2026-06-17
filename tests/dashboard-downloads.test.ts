import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import dashboardDownloadsHandler from '../server/handlers/dashboard-downloads';
import {
  lockVault,
  resetVault,
  unlockVault,
  upsertInstance,
} from '../server/services/nativeVault';
import { OmniClient, OmniClientError } from '../server/services/omniClient';
import {
  availableDashboardDownloadFormats,
  buildDashboardDownloadFilterConfig,
  buildDashboardDownloadFilename,
  buildDashboardDownloadRequest,
  cleanDashboardDownloadFilename,
  parseDashboardDownloadJobId,
  summarizeDashboardDownloadFilters,
  type DashboardDownloadDetails,
  type DashboardDownloadOptions,
} from '../src/services/dashboardDownloads';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'omnikit-downloads-'));
  process.env.OMNIKIT_VAULT_PATH = path.join(tempDir, 'vault.enc');
  process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS = String(30 * 60 * 1000);
  lockVault();
});

afterEach(() => {
  mock.restoreAll();
  resetVault();
  lockVault();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.OMNIKIT_VAULT_PATH;
  delete process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS;
});

const detailsA: DashboardDownloadDetails = {
  id: 'dash-a',
  name: 'Dashboard A',
  filters: [
    { field: 'orders.region', label: 'Region', kind: 'EQUALS', type: 'string', values: [], isNegative: false },
  ],
  tiles: [
    { id: 'tile-a', name: 'Revenue', order: 1, queryIdentifierMapKey: 'query-map-a' },
  ],
};

const detailsB: DashboardDownloadDetails = {
  id: 'dash-b',
  name: 'Dashboard B',
  filters: [
    { field: 'orders.segment', label: 'Segment', kind: 'EQUALS', type: 'string', values: [], isNegative: false },
  ],
  tiles: [
    { id: 'tile-b', name: 'Margin', order: 1, queryIdentifierMapKey: 'query-map-b' },
  ],
};

function options(patch: Partial<DashboardDownloadOptions> = {}): DashboardDownloadOptions {
  return {
    format: 'pdf',
    scope: 'dashboard',
    paperFormat: 'fit_page',
    orientation: 'landscape',
    hideTitle: false,
    showFilters: true,
    expandTables: false,
    singleColumnLayout: false,
    enableFormatting: true,
    hideHiddenFields: false,
    overrideRowLimit: false,
    maxRowLimit: '',
    customFilename: '',
    ...patch,
  };
}

function saveInstance(id = 'download-instance') {
  unlockVault('download passphrase');
  return upsertInstance({
    id,
    label: 'Download Instance',
    role: 'both',
    baseUrl: 'https://downloads.example.omniapp.co',
    apiKey: 'omni_live_download_secret_123456',
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
  });
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const parsed = await response.json();
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

test('builds filter config from dashboard-local values', () => {
  const config = buildDashboardDownloadFilterConfig(detailsA.filters, {
    'orders.region': 'West, East',
    'orders.segment': 'Enterprise',
  });

  assert.deepEqual(config, {
    'orders.region': {
      field: 'orders.region',
      kind: 'EQUALS',
      type: 'string',
      values: ['West', 'East'],
      isNegative: false,
    },
  });
});

test('per-dashboard request building does not leak active dashboard filters into another dashboard', () => {
  const requestA = buildDashboardDownloadRequest({
    dashboardId: 'dash-a',
    dashboardName: 'Dashboard A',
    details: detailsA,
    filterValues: { 'orders.region': 'West' },
    options: options(),
    total: 2,
  });
  const requestB = buildDashboardDownloadRequest({
    dashboardId: 'dash-b',
    dashboardName: 'Dashboard B',
    details: detailsB,
    filterValues: { 'orders.segment': 'Enterprise' },
    options: options(),
    total: 2,
  });

  assert.deepEqual(requestA.body.filterConfig, {
    'orders.region': {
      field: 'orders.region',
      kind: 'EQUALS',
      type: 'string',
      values: ['West'],
      isNegative: false,
    },
  });
  assert.deepEqual(requestB.body.filterConfig, {
    'orders.segment': {
      field: 'orders.segment',
      kind: 'EQUALS',
      type: 'string',
      values: ['Enterprise'],
      isNegative: false,
    },
  });
});

test('single-tile json requires queryIdentifierMapKey and whole-dashboard json is blocked', () => {
  assert.deepEqual(availableDashboardDownloadFormats('dashboard'), ['pdf', 'png', 'csv', 'xlsx']);
  assert.deepEqual(availableDashboardDownloadFormats('tile'), ['pdf', 'png', 'csv', 'xlsx', 'json']);

  const request = buildDashboardDownloadRequest({
    dashboardId: 'dash-a',
    dashboardName: 'Dashboard A',
    details: detailsA,
    filterValues: {},
    options: options({ format: 'json', scope: 'tile', selectedTileKey: 'query-map-a' }),
    total: 1,
  });
  assert.equal(request.body.queryIdentifierMapKey, 'query-map-a');
  assert.equal(request.tileName, 'Revenue');

  assert.throws(() => buildDashboardDownloadRequest({
    dashboardId: 'dash-a',
    dashboardName: 'Dashboard A',
    details: detailsA,
    filterValues: {},
    options: options({ format: 'json', scope: 'dashboard' }),
    total: 1,
  }), /JSON downloads require single-tile mode/);
});

test('row limit override only sends max rows when the override is enabled', () => {
  const withoutOverride = buildDashboardDownloadRequest({
    dashboardId: 'dash-a',
    dashboardName: 'Dashboard A',
    details: detailsA,
    filterValues: {},
    options: options({ format: 'csv', maxRowLimit: '500000', overrideRowLimit: false }),
    total: 1,
  });
  assert.equal(withoutOverride.body.maxRowLimit, undefined);
  assert.equal(withoutOverride.body.overrideRowLimit, undefined);

  const withOverride = buildDashboardDownloadRequest({
    dashboardId: 'dash-a',
    dashboardName: 'Dashboard A',
    details: detailsA,
    filterValues: {},
    options: options({ format: 'csv', maxRowLimit: '500000', overrideRowLimit: true }),
    total: 1,
  });
  assert.equal(withOverride.body.maxRowLimit, 500000);
  assert.equal(withOverride.body.overrideRowLimit, true);
});

test('xlsx row limit override requires single-tile mode', () => {
  assert.throws(() => buildDashboardDownloadRequest({
    dashboardId: 'dash-a',
    dashboardName: 'Dashboard A',
    details: detailsA,
    filterValues: {},
    options: options({ format: 'xlsx', scope: 'dashboard', maxRowLimit: '500000', overrideRowLimit: true }),
    total: 1,
  }), /XLSX row-limit overrides require single-tile mode/);

  const singleTile = buildDashboardDownloadRequest({
    dashboardId: 'dash-a',
    dashboardName: 'Dashboard A',
    details: detailsA,
    filterValues: {},
    options: options({
      format: 'xlsx',
      scope: 'tile',
      selectedTileKey: 'query-map-a',
      maxRowLimit: '500000',
      overrideRowLimit: true,
    }),
    total: 1,
  });

  assert.equal(singleTile.body.queryIdentifierMapKey, 'query-map-a');
  assert.equal(singleTile.body.maxRowLimit, 500000);
  assert.equal(singleTile.body.overrideRowLimit, true);
});

test('filename cleanup and custom filename limits are deterministic', () => {
  assert.equal(cleanDashboardDownloadFilename(' Revenue / West: Q4 * '), 'Revenue - West- Q4 -');
  assert.equal(buildDashboardDownloadFilename('Dashboard/One', 'pdf', '', 1), 'Dashboard-One.pdf');
  assert.equal(buildDashboardDownloadFilename('Dashboard One', 'xlsx', 'Executive Export', 3), 'Executive Export - Dashboard One.xlsx');
});

test('filter summaries are concise and derived from the stored request body', () => {
  assert.equal(summarizeDashboardDownloadFilters({
    filterConfig: {
      'orders.region': { field: 'orders.region', values: ['West', 'East'] },
      'orders.segment': { field: 'orders.segment', values: ['Enterprise'] },
    },
  }), 'Region: West, East; Segment: Enterprise');
  assert.equal(summarizeDashboardDownloadFilters({}), '');
});

test('png request discloses the filter caveat when overrides are present', () => {
  const request = buildDashboardDownloadRequest({
    dashboardId: 'dash-a',
    dashboardName: 'Dashboard A',
    details: detailsA,
    filterValues: { 'orders.region': 'West' },
    options: options({ format: 'png' }),
    total: 1,
  });
  assert.equal(request.body.showFilters, true);
  assert.match(request.warnings.join(' '), /PNG exports may ignore filter overrides/);
});

test('parses existing download job ids from common 409 shapes', () => {
  assert.equal(parseDashboardDownloadJobId({ job_id: 'job-a' }), 'job-a');
  assert.equal(parseDashboardDownloadJobId('{"download_job_id":"job-b"}'), 'job-b');
  assert.equal(parseDashboardDownloadJobId('already running jobId="job-c"'), 'job-c');
});

test('dashboard downloads handler requires an unlocked vault and saved instance id', async () => {
  const locked = await dashboardDownloadsHandler(new Request('http://localhost/api/dashboard-downloads/download-instance/dashboards/dash-a/details'));
  assert.equal(locked.status, 423);

  unlockVault('download passphrase');
  const missing = await dashboardDownloadsHandler(new Request('http://localhost/api/dashboard-downloads/missing/dashboards/dash-a/details'));
  assert.equal(missing.status, 404);
});

test('dashboard downloads details response is sanitized and does not expose plaintext keys', async () => {
  const saved = saveInstance();
  mock.method(OmniClient.prototype, 'getDashboardDownloadDetails', async () => detailsA);

  const response = await dashboardDownloadsHandler(new Request(`http://localhost/api/dashboard-downloads/${saved.id}/dashboards/dash-a/details`));
  const body = await jsonBody(response);

  assert.equal(response.status, 200);
  assert.deepEqual(body.details, detailsA);
  assert.equal(JSON.stringify(body).includes('omni_live_download_secret_123456'), false);
});

test('dashboard downloads handler rejects invalid tile selections before starting a job', async () => {
  const saved = saveInstance();
  const startMock = mock.method(OmniClient.prototype, 'startDashboardDownload', async () => ({ jobId: 'should-not-run', raw: {} }));
  mock.method(OmniClient.prototype, 'getDashboardDownloadDetails', async () => detailsA);

  const response = await dashboardDownloadsHandler(new Request(`http://localhost/api/dashboard-downloads/${saved.id}/dashboards/dash-a/jobs`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'tile',
      request: {
        format: 'json',
        queryIdentifierMapKey: 'missing-tile',
      },
    }),
  }));
  const body = await jsonBody(response);

  assert.equal(response.status, 400);
  assert.match(String(body.error), /Selected tile/);
  assert.equal(startMock.mock.callCount(), 0);
});

test('dashboard downloads handler attaches to existing 409 download jobs', async () => {
  const saved = saveInstance();
  mock.method(OmniClient.prototype, 'startDashboardDownload', async () => {
    throw new OmniClientError(409, 'https://downloads.example.omniapp.co/api/v1/dashboards/dash-a/download', '{"job_id":"existing-job"}');
  });

  const response = await dashboardDownloadsHandler(new Request(`http://localhost/api/dashboard-downloads/${saved.id}/dashboards/dash-a/jobs`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'dashboard',
      request: { format: 'pdf', filename: 'Dashboard A.pdf' },
    }),
  }));
  const body = await jsonBody(response);

  assert.equal(response.status, 200);
  assert.equal(body.jobId, 'existing-job');
  assert.equal(body.attached, true);
});

test('dashboard downloads handler redacts Omni errors', async () => {
  const saved = saveInstance();
  mock.method(OmniClient.prototype, 'startDashboardDownload', async () => {
    throw new OmniClientError(500, 'https://downloads.example.omniapp.co/api/v1/dashboards/dash-a/download', 'failed with omni_live_download_secret_123456');
  });

  const response = await dashboardDownloadsHandler(new Request(`http://localhost/api/dashboard-downloads/${saved.id}/dashboards/dash-a/jobs`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'dashboard',
      request: { format: 'pdf', filename: 'Dashboard A.pdf' },
    }),
  }));
  const body = await jsonBody(response);

  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(body).includes('omni_live_download_secret_123456'), false);
  assert.match(String(body.error), /REDACTED|redacted|secret/i);
});

test('dashboard downloads handler normalizes status polling and redacts status errors', async () => {
  const saved = saveInstance();
  mock.method(OmniClient.prototype, 'getDashboardDownloadStatus', async (_dashboardId: string, jobId: string) => {
    if (jobId === 'complete-job') return { status: 'succeeded', raw: {} };
    if (jobId === 'failed-job') return { status: 'FAILED', error: 'bad token omni_live_download_secret_123456', raw: {} };
    return { status: 'running', raw: {} };
  });

  const processing = await jsonBody(await dashboardDownloadsHandler(new Request(`http://localhost/api/dashboard-downloads/${saved.id}/dashboards/dash-a/jobs/running-job/status`)));
  const complete = await jsonBody(await dashboardDownloadsHandler(new Request(`http://localhost/api/dashboard-downloads/${saved.id}/dashboards/dash-a/jobs/complete-job/status`)));
  const failed = await jsonBody(await dashboardDownloadsHandler(new Request(`http://localhost/api/dashboard-downloads/${saved.id}/dashboards/dash-a/jobs/failed-job/status`)));

  assert.equal(processing.status, 'processing');
  assert.equal(complete.status, 'complete');
  assert.equal(failed.status, 'error');
  assert.equal(JSON.stringify(failed).includes('omni_live_download_secret_123456'), false);
  assert.match(String(failed.error), /redacted/);
});

test('dashboard downloads handler streams blob responses with safe metadata headers', async () => {
  const saved = saveInstance();
  mock.method(OmniClient.prototype, 'getDashboardDownloadFile', async () => new Response('pdf-bytes', {
    headers: { 'content-type': 'application/pdf' },
  }));

  const response = await dashboardDownloadsHandler(new Request(`http://localhost/api/dashboard-downloads/${saved.id}/dashboards/dash-a/jobs/job-a/file?filename=Revenue%20Export.pdf`));
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.match(response.headers.get('content-disposition') || '', /Revenue Export\.pdf/);
  assert.equal(text, 'pdf-bytes');
});
