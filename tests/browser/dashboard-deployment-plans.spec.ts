import { expect, test, type Page, type Route } from '@playwright/test';
import type { DashboardDeploymentPlan } from '../../shared/dashboardDeploymentPlan';
import type { DashboardSafeCopyIntent } from '../../shared/dashboardSafeCopyContract';
import type { MigrationJob } from '../../src/services/opsConsole';
import { WALKTHROUGH_STORAGE_KEY, WALKTHROUGH_VERSION } from '../../src/services/walkthrough';

const planId = '33333333-3333-4333-8333-333333333333';
const jobId = '22222222-2222-4222-8222-222222222222';
const api = '/api/migration-jobs/deployment-plans';
const instances = ['source', 'target'].map((id) => ({
  id, label: id === 'source' ? 'Source instance' : 'Target instance', role: id === 'source' ? 'source' : 'destination',
  baseUrl: `https://${id}.example.test`, apiKeyMasked: 'omni_••••test', defaultModelId: `${id}-model`,
  defaultFolderPath: '/Default folder', metricFilter: { mode: 'all', values: [] }, postMigrationActions: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastValidatedAt: '2026-01-01T00:00:00.000Z',
}));

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setup(page: Page, options: { mixed?: boolean; planGate?: Promise<void> } = {}) {
  let plan: DashboardDeploymentPlan | undefined;
  let job: MigrationJob | undefined;
  let rechecks = 0;
  let reads = 0;
  const creates: DashboardSafeCopyIntent[] = [];
  const deployments: Array<{ revision: number; targetIds: string[]; requestId: string }> = [];
  const unexpectedWrites: string[] = [];
  await page.addInitScript(({ walkthroughKey, walkthroughVersion }) => {
    sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify({ baseUrl: 'https://source.example.test', apiKey: '__omnikit_vault_instance__:source', status: 'success', connectionMode: 'vault', instanceId: 'source', instanceLabel: 'Source instance', apiKeyMasked: 'omni_••••test' }));
    localStorage.setItem(walkthroughKey, JSON.stringify({ version: walkthroughVersion, dismissedAt: '2026-01-01T00:00:00.000Z' }));
  }, { walkthroughKey: WALKTHROUGH_STORAGE_KEY, walkthroughVersion: WALKTHROUGH_VERSION });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === '/api/vault/status') return json(route, { unlocked: true, exists: true, path: '/isolated/test-vault', instanceCount: 2 });
    if (path === '/api/instances') return json(route, { instances });
    if (/^\/api\/instances\/[^/]+\/folder-inventory$/.test(path)) return json(route, {
      folders: ['Default', 'First', 'Second', 'Changed'].map((name) => ({ id: `folder-${name.toLowerCase()}`, name: `${name} folder`, path: `/${name} folder` })),
      pagination: { complete: true }, cache: { status: 'miss', fresh: true },
    });
    const catalog = path.match(/^\/api\/model-migrator\/([^/]+)\/(connections|models)$/);
    if (catalog) return json(route, catalog[2] === 'connections'
      ? { connections: [{ id: `${catalog[1]}-connection`, name: 'Warehouse', database: catalog[1], dialect: 'postgres' }] }
      : { models: [{ id: `${catalog[1]}-model`, name: 'Shared model', kind: 'SHARED', connectionId: `${catalog[1]}-connection` }, { id: `${catalog[1]}-alternate`, name: 'Alternate model', kind: 'SHARED', connectionId: `${catalog[1]}-connection` }] });
    if (path === '/api/instances/source/documents') return json(route, {
      documents: [{ id: 'source-document', identifier: 'source-dashboard', name: 'Selected dashboard', connectionId: 'source-connection', baseModelId: 'source-model' }],
      inventory: {
        complete: true, scope: url.searchParams.has('documentIds') ? 'explicit_documents' : 'credential', matchedRecordCount: 1, sourceRecordCount: 1,
        excluded: { missingConnectionId: 0, otherConnection: 0, missingDashboardEvidence: 0 }, pagination: { pages: 1, pageSize: 100, returnedRecords: 1, reportedTotalRecords: 1 },
        cache: { status: 'miss', fetchedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:15:00.000Z', ageMs: 0, fresh: true },
      },
    });
    if (path === api && method === 'POST') {
      const intent = request.postDataJSON() as DashboardSafeCopyIntent;
      creates.push(intent);
      plan = { version: 2, id: planId, revision: creates.length, createdAt: 1, updatedAt: 1, intent, sourceHashes: {}, sourceModelHashes: {}, targets: intent.destinations.map((row, index) => ({
        targetId: row.targetId, status: options.mixed && index === 1 ? 'model_changes_required' : 'ready', checkedAt: Date.UTC(2026, 0, 1), sourceModelIds: ['source-model'], requiredFiles: ['base.view'], requiredFilesByModelId: { 'source-model': ['base.view'] },
        findings: options.mixed && index === 1 ? [{ id: 'missing-field', kind: 'field', reference: 'base.total', message: 'Required field is absent from the destination model.', documentIds: ['source-dashboard'] }] : [],
      })) };
      if (options.planGate) await options.planGate;
      return json(route, { plan });
    }
    if (path === `${api}/${planId}` && method === 'GET') { reads += 1; return json(route, { plan }); }
    if (path === `${api}/${planId}/recheck`) { rechecks += 1; return json(route, { plan }); }
    if (path === `${api}/${planId}/deploy`) {
      const body = request.postDataJSON() as { revision: number; targetIds: string[]; requestId: string };
      deployments.push(body);
      const selected = plan!.intent.destinations.filter((row) => body.targetIds.includes(row.targetId));
      job = {
        id: jobId, workflow: 'dashboard', sourceId: 'source', sourceConnectionId: 'source-connection', sourceLabel: 'Source instance',
        destinationIds: ['target'], targets: selected.map((row) => ({ id: row.targetId, destinationInstanceId: row.instanceId, destinationLabel: 'Target instance', targetConnectionId: row.connectionId, targetModelId: row.modelId, targetFolderPath: row.folderPath })),
        documentIds: ['source-dashboard'], emptyFirst: false, replaceSameNamed: false, deleteSourceOnSuccess: false, postMigrationActions: [], status: 'pending', createdAt: Date.UTC(2026, 0, 1), items: [],
        details: { safeCopyProfile: 'safe_copy_v1', operationMode: 'safe_copy', safeCopyRequestId: body.requestId },
      };
      return json(route, { job, plan });
    }
    if (path === '/api/migration-jobs' && method === 'GET') return json(route, { jobs: job ? [job] : [] });
    if (path === `/api/migration-jobs/${jobId}`) return json(route, { job });
    if (path === `/api/migration-jobs/${jobId}/events`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    if (method !== 'GET') unexpectedWrites.push(path);
    return json(route, {});
  });
  return { creates, deployments, unexpectedWrites, plan: () => plan, reads: () => reads, rechecks: () => rechecks };
}

async function destinations(page: Page) {
  await page.goto('/dashboards/migrate');
  await page.getByRole('button', { name: 'Browse all dashboards', exact: true }).click();
  await page.getByRole('checkbox', { name: /Selected dashboard/ }).check();
  await page.getByRole('button', { name: 'Choose destinations', exact: true }).click();
  await page.getByRole('combobox', { name: 'Instance to add as a destination', exact: true }).click();
  await page.getByRole('option', { name: /^Target instance/ }).click();
  await page.getByRole('button', { name: 'Add destination', exact: true }).click();
  await page.getByRole('combobox', { name: 'Instance to add as a destination', exact: true }).click();
  await page.getByRole('option', { name: /^Target instance/ }).click();
  await page.getByRole('button', { name: 'Add destination', exact: true }).click();
  await editDestination(page, 2);
  await expect(page.getByRole('combobox', { name: 'Destination 2 model', exact: true })).toHaveValue('Shared model');
  await chooseFolder(page, 1, '/First folder');
  await chooseFolder(page, 2, '/Second folder');
}

async function editDestination(page: Page, index: number) {
  const edit = page.getByRole('button', { name: `Edit destination ${index}`, exact: true });
  if (await edit.getAttribute('aria-expanded') !== 'true') await edit.click();
}

async function chooseFolder(page: Page, index: number, path: string) {
  await editDestination(page, index);
  await page.getByRole('combobox', { name: `Destination ${index} folder`, exact: true }).click();
  await page.getByRole('option', { name: new RegExp(`^${path}`) }).click();
}

test('repeated destinations have independent editable models and folders; mixed readiness requires explicit selection', async ({ page }) => {
  const fixture = await setup(page, { mixed: true });
  await destinations(page);
  await editDestination(page, 1);
  await page.getByRole('combobox', { name: 'Destination 1 model', exact: true }).click();
  await page.getByRole('option', { name: /Alternate model/ }).click();
  await editDestination(page, 2);
  await expect(page.getByRole('combobox', { name: 'Destination 2 model', exact: true })).toHaveValue('Shared model');
  await page.getByRole('button', { name: 'Review readiness', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review readiness', exact: true })).toBeFocused();
  await expect(page.getByText('1 of 2 destinations ready', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review deployment (0)', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Resolve in Model Migrator' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Deploy destination 2: Target instance' })).toBeDisabled();
  expect(fixture.creates[0].destinations.map((row) => row.folderPath)).toEqual(['/First folder', '/Second folder']);
  expect(new Set(fixture.creates[0].destinations.map((row) => row.targetId)).size).toBe(2);
  expect(fixture.deployments).toHaveLength(0);
  await page.getByRole('checkbox', { name: 'Deploy destination 1: Target instance' }).check();
  await page.getByRole('button', { name: 'Review deployment (1)', exact: true }).click();
  await expect(page.getByText(/1 destination is held/)).toBeVisible();
  await page.getByRole('button', { name: 'Deploy to 1 destination', exact: true }).click();
  await expect.poll(() => fixture.deployments.length).toBe(1);
  expect(fixture.deployments[0].targetIds).toEqual([fixture.creates[0].destinations[0].targetId]);
  expect(fixture.unexpectedWrites).toEqual([]);
});

test('reopening a plan restores its exact folders without an automatic recheck', async ({ page }) => {
  const fixture = await setup(page);
  await destinations(page);
  await page.getByRole('button', { name: 'Review readiness', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`planId=${planId}`));
  expect(fixture.rechecks()).toBe(0);
  await page.reload();
  await expect(page.getByText('2 of 2 destinations ready', { exact: true })).toBeVisible();
  expect(fixture.reads()).toBe(1);
  expect(fixture.rechecks()).toBe(0);
  await page.getByRole('button', { name: 'Back to destinations', exact: true }).click();
  await editDestination(page, 1);
  await expect(page.getByRole('combobox', { name: 'Destination 1 folder', exact: true })).toHaveValue('/First folder');
  await editDestination(page, 2);
  await expect(page.getByRole('combobox', { name: 'Destination 2 folder', exact: true })).toHaveValue('/Second folder');
  await page.getByRole('button', { name: 'Review readiness', exact: true }).click();
  expect(fixture.rechecks()).toBe(0);
  await page.getByRole('button', { name: 'Recheck readiness', exact: true }).click();
  await expect(page.getByText('2 of 2 destinations ready', { exact: true })).toBeVisible();
  expect(fixture.rechecks()).toBe(1);
  expect(fixture.deployments).toHaveLength(0);
});

test('canceling readiness before editing a destination invalidates its late result', async ({ page }) => {
  let release!: () => void;
  const planGate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = await setup(page, { planGate });
  await destinations(page);
  await page.getByRole('button', { name: 'Review readiness', exact: true }).click();
  await expect.poll(() => fixture.creates.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Back to destinations', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel check', exact: true }).click();
  await page.getByRole('button', { name: 'Back to destinations', exact: true }).click();
  await chooseFolder(page, 1, '/Changed folder');
  release();
  await expect(page).toHaveURL(/\/dashboards\/migrate$/);
  await expect(page.getByRole('combobox', { name: 'Destination 1 folder', exact: true })).toHaveValue('/Changed folder');
  await expect(page.getByRole('navigation', { name: 'Dashboard move steps' }).getByRole('button').nth(3)).toBeDisabled();
  expect(fixture.deployments).toHaveLength(0);
});
