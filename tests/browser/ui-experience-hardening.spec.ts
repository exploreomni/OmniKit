import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSPHRASE = 'browser UI experience hardening passphrase';

interface PrimaryRoute {
  path: string;
  heading: string;
  requiresSavedInstance?: boolean;
}

const PRIMARY_ROUTES: PrimaryRoute[] = [
  { path: '/', heading: 'Your Omni command center.' },
  { path: '/content/ai-studio', heading: 'Choose an instance to unlock AI Content Studio', requiresSavedInstance: true },
  { path: '/dashboards/migrate', heading: 'Choose an instance to unlock Dashboard Migrator', requiresSavedInstance: true },
  { path: '/dashboards/operations', heading: 'Choose an instance to unlock Dashboard Operations', requiresSavedInstance: true },
  { path: '/dashboards/downloads', heading: 'Choose an instance to unlock Dashboard Downloads', requiresSavedInstance: true },
  { path: '/deck-builder', heading: 'Choose an instance to unlock Deck Builder', requiresSavedInstance: true },
  { path: '/models/migrate', heading: 'Choose an instance to unlock Model Migrator', requiresSavedInstance: true },
  { path: '/models', heading: 'Choose an instance to unlock Model & Topic Health', requiresSavedInstance: true },
  { path: '/topics', heading: 'Choose an instance to unlock AI Semantic Studio', requiresSavedInstance: true },
  { path: '/admin/fleet/instances', heading: 'Instance Manager' },
  { path: '/admin/fleet/connections', heading: 'Choose an instance to unlock Connection Health', requiresSavedInstance: true },
  { path: '/admin/content/uploads', heading: 'Choose an instance to unlock Upload Governance', requiresSavedInstance: true },
  { path: '/admin/content/health', heading: 'Choose an instance to unlock Content Health', requiresSavedInstance: true },
  { path: '/admin/content/labels', heading: 'Choose an instance to unlock Labels', requiresSavedInstance: true },
  { path: '/admin/content/schedules', heading: 'Choose an instance to unlock Schedules', requiresSavedInstance: true },
  { path: '/admin/identity/users', heading: 'Choose an instance to unlock User Management', requiresSavedInstance: true },
  { path: '/admin/developer/embeds', heading: 'Choose an instance to unlock Embed URLs', requiresSavedInstance: true },
  { path: '/history', heading: 'Operation History' },
  { path: '/data-privacy', heading: 'Data & Privacy' },
];

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: '768px', width: 768, height: 1024 },
  { label: '390px', width: 390, height: 844 },
  { label: '320px', width: 320, height: 720 },
] as const;

async function resetVault(request: APIRequestContext) {
  const response = await request.delete('/api/vault/reset');
  expect(response.ok()).toBeTruthy();
}

async function unlockVault(request: APIRequestContext) {
  const response = await request.post('/api/vault/unlock', { data: { passphrase: PASSPHRASE } });
  expect(response.ok()).toBeTruthy();
}

interface SwitcherInstance {
  id: string;
  label: string;
  role: 'source' | 'destination' | 'both';
  baseUrl: string;
  apiKeyMasked: string;
  lastValidatedAt?: string;
}

async function addSwitcherInstance(
  request: APIRequestContext,
  input: { label: string; baseUrl: string; apiKey: string },
): Promise<SwitcherInstance> {
  const response = await request.post('/api/instances', {
    data: { ...input, role: 'both' },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).instance as SwitcherInstance;
}

async function closeWalkthrough(page: Page) {
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

interface MockAIContentAction {
  type: string;
  message: string;
  timestamp: string;
  documentId?: string;
}

interface MockAIContentState {
  createCalls: number;
  cancelCalls: number;
  resultCalls: number;
  verifyCalls: number;
  verifiedDocumentIds: string[];
  trashCalls: number;
  createPayload: Record<string, unknown> | null;
  lifecycleRequests: Array<{ action: string; responseContract?: string }>;
  instances: SwitcherInstance[];
  releaseResultRead: () => void;
}

function octetStreamReviewNarrative(): string {
  const requiredReview = [
    '## Evidence reviewed',
    'The captured fictional dashboard render and bounded structural evidence were reviewed.',
    '## Supported findings',
    '### Visual hierarchy',
    '- Observed: the **primary decision tile** needs stronger visual priority for executive scanning and a governed `executive_priority` label.',
    '## Unknowns',
    'Query correctness, permissions, responsive behavior, and unseen interaction states are not assessable.',
    '## Recommended next steps',
    '- Promote the primary decision tile, then verify the revised hierarchy in Omni Chat.',
  ].join('\n');
  const boundedDetail = '\n- Observed evidence remains tied to the supplied fictional render and structure.';
  return `${requiredReview}${boundedDetail.repeat(120)}`.slice(0, 7_493);
}

const OCTET_STREAM_REVIEW_METRICS = {
  durationMs: 40_278,
  llmMs: 39_910,
  queryCount: 0,
  queryDurationMs: 0,
  tokenBuckets: {
    default: {
      tokensByModel: {
        'fictional-review-model': {
          modelProvider: 'example-provider',
          tokens: {
            cacheReadTokens: 0,
            cacheWriteTokens: 48_816,
            inputTokens: 8_823,
            outputTokens: 2_679,
          },
        },
      },
    },
  },
  toolBreakdown: {},
  toolCallCount: 0,
  toolErrorCount: 0,
};

async function installMockAIContentStudio(
  page: Page,
  request: APIRequestContext,
  options: {
    slug: string;
    resultMessage: string;
    actions: MockAIContentAction[];
    holdJobOpen?: boolean;
    includeAlternateInstance?: boolean;
    holdResultRead?: boolean;
    resultFailuresBeforeSuccess?: number;
    resultFailureStatus?: number;
    resultFailureCode?: string;
    resultField?: 'message' | 'resultSummary';
    mirrorResultNarrativeFields?: boolean;
    resultContentType?: string;
    resultExtraFields?: Record<string, unknown>;
    modelName?: string;
  },
): Promise<MockAIContentState> {
  await unlockVault(request);
  const instance = await addSwitcherInstance(request, {
    label: `Fictional ${options.slug} instance`,
    baseUrl: `https://${options.slug}.invalid`,
    apiKey: `${options.slug}-fixture-key-not-real`,
  });
  instance.lastValidatedAt = new Date().toISOString();
  const instances = [instance];
  if (options.includeAlternateInstance) {
    const alternate = await addSwitcherInstance(request, {
      label: `Fictional ${options.slug} alternate`,
      baseUrl: `https://${options.slug}-alternate.invalid`,
      apiKey: `${options.slug}-alternate-fixture-key-not-real`,
    });
    alternate.lastValidatedAt = new Date().toISOString();
    instances.push(alternate);
  }

  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instances }),
    });
  });
  await page.route('**/api/instances/*/connect', async (route) => {
    const instanceId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || '');
    const selected = instances.find((candidate) => candidate.id === instanceId);
    if (!selected) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Fictional instance not found.' }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instance: selected,
        connection: {
          baseUrl: selected.baseUrl,
          apiKey: `__omnikit_vault_instance__:${selected.id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: selected.id,
          instanceLabel: selected.label,
          apiKeyMasked: selected.apiKeyMasked,
        },
      }),
    });
  });
  await page.addInitScript((saved) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify({
      baseUrl: saved.baseUrl,
      apiKey: `__omnikit_vault_instance__:${saved.id}`,
      status: 'success',
      errorMessage: '',
      connectionMode: 'vault',
      instanceId: saved.id,
      instanceLabel: saved.label,
      apiKeyMasked: saved.apiKeyMasked,
    }));
  }, instance);

  await page.route('**/api/list-models', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const modelKind = String(body.model_kind || '');
    const selectedModelId = String(body.model_id || '');
    const models = modelKind === 'SHARED' || selectedModelId === 'model-ai-content'
      ? [{ id: 'model-ai-content', name: options.modelName ?? 'Fictional governed model', kind: 'SHARED' }]
      : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models,
        complete: true,
        loadedResults: models.length,
        totalResults: models.length,
        pagesFetched: 1,
        pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: models.length },
      }),
    });
  });
  await page.route('**/api/manage-topics', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ topics: [{ name: 'example_topic', label: 'Fictional example topic' }] }),
    });
  });
  let releaseResultRead: () => void = () => undefined;
  const resultReadGate = options.holdResultRead
    ? new Promise<void>((resolve) => { releaseResultRead = resolve; })
    : Promise.resolve();
  const state: MockAIContentState = {
    createCalls: 0,
    cancelCalls: 0,
    resultCalls: 0,
    verifyCalls: 0,
    verifiedDocumentIds: [],
    trashCalls: 0,
    createPayload: null,
    lifecycleRequests: [],
    instances,
    releaseResultRead: () => releaseResultRead(),
  };
  await page.route('**/api/manage-ai', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const action = String(body.action || '');
    const responseContract = typeof body.response_contract === 'string' ? body.response_contract : undefined;
    state.lifecycleRequests.push({ action, responseContract });
    const requiresResponseContract = action === 'create-job' || action === 'get-job' || action === 'cancel-job';
    if ((requiresResponseContract && responseContract !== 'ai-content-studio-v1')
      || (action === 'get-content-studio-job-result' && responseContract !== undefined)) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Incorrect fictional response contract.' }) });
      return;
    }
    if (action === 'create-job') {
      state.createCalls += 1;
      state.createPayload = body;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: `${options.slug}-job-1`,
          state: 'QUEUED',
          conversationId: `${options.slug}-conversation-1`,
          omniChatUrl: `https://${options.slug}.invalid/chat/${options.slug}-conversation-1`,
        }),
      });
      return;
    }
    if (action === 'get-job') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: `${options.slug}-job-1`,
          state: options.holdJobOpen ? 'RUNNING' : 'COMPLETE',
          conversationId: `${options.slug}-conversation-1`,
          omniChatUrl: `https://${options.slug}.invalid/chat/${options.slug}-conversation-1`,
        }),
      });
      return;
    }
    if (action === 'get-content-studio-job-result') {
      state.resultCalls += 1;
      await resultReadGate;
      if (state.resultCalls <= (options.resultFailuresBeforeSuccess || 0)) {
        try {
          await route.fulfill({
            status: options.resultFailureStatus || 400,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'Fictional completed-result read failure.',
              ...(options.resultFailureCode ? { code: options.resultFailureCode } : {}),
            }),
          });
        } catch {
          // A deliberately held result read may be abandoned by an instance switch.
        }
        return;
      }
      try {
        const narrative = options.mirrorResultNarrativeFields
          ? { message: options.resultMessage, resultSummary: options.resultMessage }
          : options.resultField === 'resultSummary'
            ? { resultSummary: options.resultMessage }
            : { message: options.resultMessage };
        await route.fulfill({
          status: 200,
          contentType: options.resultContentType || 'application/json',
          body: JSON.stringify({
            ...narrative,
            actions: options.actions,
            ...options.resultExtraFields,
            omniChatUrl: `https://${options.slug}.invalid/chat/${options.slug}-conversation-1?secret=removed`,
          }),
        });
      } catch {
        // A deliberately held result read may be abandoned by an instance switch.
      }
      return;
    }
    if (action === 'cancel-job') {
      state.cancelCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: `${options.slug}-job-1`, state: 'CANCELLED' }),
      });
      return;
    }
    if (action === 'verify-content-document') {
      state.verifyCalls += 1;
      const identifier = String(body.document_id || '');
      state.verifiedDocumentIds.push(identifier);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          identifier,
          name: 'Fictional governed activity dashboard',
          modelId: 'model-ai-content',
          queryCount: 1,
          queries: [{ id: 'query-1', name: 'Fictional governed activity', modelIds: ['model-ai-content'] }],
          queryPresentationCount: 1,
          queryPresentationTypes: [{ type: 'query', count: 1 }],
          layoutContainerCount: 1,
          filterCount: 1,
          controlCount: 1,
          accessGrantCount: 3,
          directAccessGrantCount: 1,
          inheritedAccessGrantCount: 1,
          ownerGrantCount: 1,
          accessListComplete: true,
          contentValidationIssues: [],
          verifiedAt: '2026-08-13T12:05:00.000Z',
        }),
      });
      return;
    }
    if (action === 'trash-content-document') {
      state.trashCalls += 1;
      const identifier = String(body.document_id || '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ identifier, trashed: true, trashedAt: '2026-08-13T12:06:00.000Z' }),
      });
      return;
    }
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected fictional AI action.' }) });
  });

  await page.route('**/api/omni-proxy', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const endpoint = String(body.endpoint || '');
    if (endpoint === '/v1/models/model-ai-content/yaml') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          files: { model: 'name: Fictional governed model' },
          checksums: { model: 'fictional-checksum' },
        }),
      });
      return;
    }
    if (endpoint.endsWith('/download') && body.method === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ job_id: 'fictional-png-job' }) });
      return;
    }
    if (endpoint.endsWith('/fictional-png-job/status')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'complete' }) });
      return;
    }
    if (endpoint.endsWith('/fictional-png-job') && body.raw_response === true) {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      });
      return;
    }
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected fictional proxy endpoint.' }) });
  });

  return state;
}

async function expectNoHorizontalPageOverflow(page: Page, context: string) {
  await expect.poll(
    () => page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      return Math.max(
        root.scrollWidth - root.clientWidth,
        body.scrollWidth - body.clientWidth,
      );
    }),
    { message: `${context} introduced horizontal page overflow` },
  ).toBeLessThanOrEqual(0);
}

async function openPrimaryRoute(page: Page, route: PrimaryRoute) {
  const response = await page.goto(route.path);
  expect(response?.ok(), `${route.path} did not return a successful document response`).toBeTruthy();
  await closeWalkthrough(page);

  await expect(page).toHaveURL(route.path);
  await expect(page.getByRole('heading', { name: route.heading, exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#main-content')).not.toBeEmpty();
  await expect(page.locator('#root')).not.toContainText(
    /Unexpected Application Error|Application error|Cannot GET|404 Not Found|Internal Server Error/i,
  );

  if (route.requiresSavedInstance) {
    await expect(page.getByText('Saved instance required', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go to Home' })).toBeVisible();
  }
}

test.beforeEach(async ({ request }) => {
  await resetVault(request);
});

test.afterEach(async ({ request }) => {
  await resetVault(request);
});

for (const viewport of VIEWPORTS) {
  test(`primary routes render without blank, error, or overflow surfaces at ${viewport.label}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));

    for (const route of PRIMARY_ROUTES) {
      await openPrimaryRoute(page, route);
      await expectNoHorizontalPageOverflow(page, `${route.path} at ${viewport.width}px`);
      expect(pageErrors, `page errors while opening ${route.path} at ${viewport.width}px`).toEqual([]);
    }
  });
}

test('Dashboard Migrator keeps long duplicate destination connections readable and keyboard-distinct', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await unlockVault(request);
  const instance = await addSwitcherInstance(request, {
    label: 'Fictional dashboard migration instance',
    baseUrl: 'https://dashboard-migration.invalid',
    apiKey: 'dashboard-migration-fixture-key-not-real',
  });
  instance.lastValidatedAt = '2026-08-13T12:00:00.000Z';
  await page.addInitScript((saved) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify({
      baseUrl: saved.baseUrl,
      apiKey: `__omnikit_vault_instance__:${saved.id}`,
      status: 'success',
      errorMessage: '',
      connectionMode: 'vault',
      instanceId: saved.id,
      instanceLabel: saved.label,
      apiKeyMasked: saved.apiKeyMasked,
    }));
  }, instance);
  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instances: [instance] }),
    });
  });

  const duplicateConnectionName = 'Example governed analytics warehouse connection for a deliberately long destination catalog';
  const duplicateConnectionMetadata = 'fictional_operations_reporting_database_with_a_long_name';
  const firstConnectionId = 'fixture-connection-east-with-a-long-audit-identifier';
  const secondConnectionId = 'fixture-connection-west-with-a-long-audit-identifier';
  const connections = [
    {
      id: firstConnectionId,
      name: duplicateConnectionName,
      database: duplicateConnectionMetadata,
      dialect: 'motherduck',
      defaultSchema: 'fictional_curated_reporting_schema',
    },
    {
      id: secondConnectionId,
      name: duplicateConnectionName,
      database: duplicateConnectionMetadata,
      dialect: 'motherduck',
      defaultSchema: 'fictional_curated_reporting_schema',
    },
  ];
  const sourceModel = {
    id: 'fixture-source-model',
    name: 'Example source model',
    identifier: 'example-source-model',
    connectionId: firstConnectionId,
    connectionName: duplicateConnectionName,
    kind: 'SHARED',
  };

  await page.route('**/api/model-migrator/*/connections', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ connections }),
    });
  });
  await page.route('**/api/model-migrator/*/models?*', async (route) => {
    const connectionId = new URL(route.request().url()).searchParams.get('connectionId');
    // The unscoped catalog must span both connections. The shipping flow
    // auto-resolves a destination connection whenever the model catalog implies
    // only one, so a single-connection catalog would hide the very picker this
    // test is about.
    const models = connectionId === secondConnectionId
      ? [
        { ...sourceModel, id: 'fixture-target-model-one', connectionId: secondConnectionId },
        { ...sourceModel, id: 'fixture-target-model-two', name: 'Example alternate target model', connectionId: secondConnectionId },
      ]
      : connectionId === firstConnectionId
        ? [sourceModel]
        : [
          sourceModel,
          { ...sourceModel, id: 'fixture-target-model-one', connectionId: secondConnectionId },
        ];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models }),
    });
  });
  const dashboardInventoryRequests: URL[] = [];
  await page.route('**/api/instances/*/documents*', async (route) => {
    dashboardInventoryRequests.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        documents: [{
          id: 'fixture-document',
          identifier: 'fixture-source-dashboard',
          name: 'Example source dashboard',
          connectionId: firstConnectionId,
          hasDashboard: true,
          folderPath: 'Example folder',
          baseModelId: sourceModel.id,
          baseModelName: sourceModel.name,
          topicNames: ['example_topic'],
          topicIds: ['example_topic'],
        }],
        inventory: {
          complete: true,
          scope: 'credential',
          cache: {
            status: 'miss',
            fetchedAt: '2026-08-13T15:00:00.000Z',
            expiresAt: '2026-08-13T15:03:00.000Z',
            ageMs: 0,
            fresh: true,
          },
          pagination: {
            pages: 1,
            pageSize: 100,
            returnedRecords: 1,
            reportedTotalRecords: 1,
          },
          sourceRecordCount: 1,
          matchedRecordCount: 1,
          excluded: {
            missingConnectionId: 0,
            otherConnection: 0,
            missingDashboardEvidence: 0,
          },
        },
      }),
    });
  });

  await page.goto('/dashboards/migrate');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Dashboard Migrator', exact: true })).toBeVisible();

  const sourceInstance = page.getByRole('combobox', { name: 'Source instance' });
  await sourceInstance.click();
  await page.getByRole('option', { name: /Fictional dashboard migration instance/ }).click();

  const sourceConnection = page.getByRole('combobox', { name: 'Source connection' });
  await sourceConnection.click();
  await page.getByRole('listbox', { name: 'Source connection options' })
    .getByRole('option', { name: new RegExp(firstConnectionId) })
    .click();
  // The shipping flow (DashboardSafeCopyFlow) loads the inventory as soon as a
  // source connection is chosen and refreshes through "Refresh"; the explicit
  // "Load dashboards" / "Refresh from Omni" controls belong to the legacy
  // wizard, which is only reachable as an internal rollback surface.
  await expect.poll(() => dashboardInventoryRequests.length).toBe(1);
  expect(dashboardInventoryRequests[0].searchParams.has('forceRefresh')).toBe(false);
  const refreshDashboards = page.getByRole('button', { name: 'Refresh', exact: true });
  await expect(refreshDashboards).toBeEnabled();
  await refreshDashboards.click();
  await expect.poll(() => dashboardInventoryRequests.length).toBe(2);
  expect(dashboardInventoryRequests[1].searchParams.get('forceRefresh')).toBe('true');
  await expect(refreshDashboards).toBeEnabled();

  const sourceDashboard = page.getByRole('checkbox', { name: /Example source dashboard/ });
  await expect(sourceDashboard).toBeEnabled();
  await sourceDashboard.check();
  // Exact: the step rail also exposes a "Step 2 Choose destinations" button.
  await page.getByRole('button', { name: 'Choose destinations', exact: true }).click();
  await page.getByRole('checkbox', { name: /Fictional dashboard migration instance/ }).check();

  const destinationC1 = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Fictional dashboard migration instance' }) }).first();
  const destinationConnection = page.getByRole('combobox', { name: 'Destination 1 connection' });
  await expect(destinationConnection).toBeEnabled();
  await destinationConnection.focus();
  await destinationConnection.press('ArrowDown');
  const listbox = page.getByRole('listbox', { name: 'Destination 1 connection options' });
  await expect(listbox).toBeVisible();

  const firstOption = listbox.getByRole('option', { name: new RegExp(firstConnectionId) });
  const secondOption = listbox.getByRole('option', { name: new RegExp(secondConnectionId) });
  await expect(firstOption).toHaveCount(1);
  await expect(secondOption).toHaveCount(1);

  const expectedMetadata = `Database: ${duplicateConnectionMetadata} · Dialect: motherduck · Schema: fictional_curated_reporting_schema`;
  for (const option of [firstOption, secondOption]) {
    const labelMetrics = await option.getByText(duplicateConnectionName, { exact: true }).evaluate((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const lineHeight = Number.parseFloat(style.lineHeight);
      return {
        whiteSpace: style.whiteSpace,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        height: rect.height,
        lineHeight,
      };
    });
    expect(labelMetrics.whiteSpace).toBe('normal');
    expect(labelMetrics.scrollWidth).toBeLessThanOrEqual(labelMetrics.clientWidth + 1);
    expect(labelMetrics.height).toBeGreaterThan(labelMetrics.lineHeight * 1.5);

    const metadataMetrics = await option.getByText(expectedMetadata, { exact: true }).evaluate((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        whiteSpace: style.whiteSpace,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        left: rect.left,
        right: rect.right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(metadataMetrics.whiteSpace).toBe('normal');
    expect(metadataMetrics.scrollWidth).toBeLessThanOrEqual(metadataMetrics.clientWidth + 1);
    expect(metadataMetrics.left).toBeGreaterThanOrEqual(0);
    expect(metadataMetrics.right).toBeLessThanOrEqual(metadataMetrics.viewportWidth);
  }

  const listboxMetrics = await listbox.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(listboxMetrics.left).toBeGreaterThanOrEqual(0);
  expect(listboxMetrics.right).toBeLessThanOrEqual(listboxMetrics.viewportWidth);
  expect(listboxMetrics.scrollWidth).toBeLessThanOrEqual(listboxMetrics.clientWidth + 1);
  await expectNoHorizontalPageOverflow(page, 'open Dashboard Migrator destination connection menu');

  await destinationConnection.press('ArrowDown');
  await destinationConnection.press('Enter');
  await expect(listbox).toBeHidden();

  // The shipping flow replaces a resolved picker with a summary. That summary
  // must still identify which of the two identically-named connections was
  // chosen, so it carries the database and the connection id.
  const resolvedConnection = destinationC1.getByText(duplicateConnectionMetadata, { exact: true });
  await expect(resolvedConnection).toBeVisible();
  await expect(destinationC1.getByText(secondConnectionId, { exact: true })).toBeVisible();
  await expectNoHorizontalPageOverflow(page, 'selected Dashboard Migrator destination connection');
});

test('AI Content Studio uses its canonical route and preserves the legacy dashboard URL query', async ({ page }) => {
  await page.goto('/dashboards/ai-studio?mode=apps');
  await closeWalkthrough(page);

  await expect(page).toHaveURL(/\/content\/ai-studio\?mode=apps$/);
  await expect(page.getByRole('heading', { name: 'Choose an instance to unlock AI Content Studio', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'AI Content Studio', exact: true })).toHaveAttribute('href', '/content/ai-studio');
});

test('AI Content Studio preserves a failed picker inventory through form edits and force-refreshes portable SHARED models', async ({ page, request }) => {
  await installMockAIContentStudio(page, request, {
    slug: 'ai-content-model-inventory-browser',
    resultMessage: 'Unused model inventory fixture result.',
    actions: [],
  });
  await page.unroute('**/api/list-models');

  const inventoryRequests: Array<{
    modelKind: string;
    hasExplorable: boolean;
    modelId: unknown;
    allPages: unknown;
    pageSize: unknown;
  }> = [];
  let allowRecovery = false;
  await page.route('**/api/list-models', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const modelKind = String(body.model_kind || '');
    inventoryRequests.push({
      modelKind,
      hasExplorable: Object.prototype.hasOwnProperty.call(body, 'explorable'),
      modelId: body.model_id,
      allPages: body.all_pages,
      pageSize: body.page_size,
    });

    // React may cancel an initial development-mode request before its response
    // reaches the page. Keep the shared inventory incomplete until the user
    // explicitly retries so an aborted setup request cannot consume the only
    // failure fixture and accidentally make the UI look recovered.
    if (modelKind === 'SHARED' && !allowRecovery) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: [{ id: 'model-incomplete', name: 'Incomplete shared model', kind: 'SHARED' }],
          complete: false,
          loadedResults: 1,
          totalResults: 2,
          pagesFetched: 1,
          reasonCode: 'PAGINATION_SAFETY_LIMIT_REACHED',
          pageInfo: { hasNextPage: true, nextCursor: 'cursor-2', pageSize: 100, totalRecords: 2 },
        }),
      });
      return;
    }

    const models = modelKind === 'SHARED'
      ? [{ id: 'model-ai-content', name: 'Recovered shared model', kind: 'SHARED' }]
      : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models,
        complete: true,
        loadedResults: models.length,
        totalResults: models.length,
        pagesFetched: 1,
        pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: models.length },
      }),
    });
  });

  await page.goto('/content/ai-studio?mode=report');
  await closeWalkthrough(page);
  const inventoryAlert = page.getByRole('alert').filter({ hasText: 'The shared Omni model inventory could not be verified.' });
  const retryInventory = page.getByRole('button', { name: 'Retry inventory' });
  await expect(inventoryAlert).toBeVisible();
  await expect(retryInventory).toBeVisible();
  await expect.poll(() => new Set(inventoryRequests.map((entry) => entry.modelKind))).toEqual(new Set(['SHARED']));
  const initialRequestCount = inventoryRequests.length;
  for (const requestEntry of inventoryRequests) {
    expect(requestEntry).toEqual(expect.objectContaining({
      hasExplorable: false,
      modelId: undefined,
      allPages: true,
      pageSize: 100,
    }));
  }

  await page.getByLabel('Outcome or decision (required)').fill('Preserve this form edit while the model inventory remains unavailable.');
  await expect(inventoryAlert).toBeVisible();
  await expect(retryInventory).toBeVisible();

  allowRecovery = true;
  await retryInventory.click();
  await expect.poll(() => new Set(inventoryRequests
    .slice(initialRequestCount)
    .map((entry) => entry.modelKind))).toEqual(new Set(['SHARED']));
  for (const requestEntry of inventoryRequests.slice(initialRequestCount)) {
    expect(requestEntry).toEqual(expect.objectContaining({
      hasExplorable: false,
      modelId: undefined,
      allPages: true,
      pageSize: 100,
    }));
  }
  await expect(retryInventory).toHaveCount(0);

  const baseModel = page.getByLabel('Base model');
  await expect(baseModel.locator('option')).toHaveText([
    'Choose a base model',
    'Recovered shared model',
  ]);
  await baseModel.selectOption('model-ai-content');
  await expect(baseModel).toHaveValue('model-ai-content');
});

test('AI Content Studio does not let abandoned instance inventory block the new instance and ignores stale responses', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-inventory-scope-browser',
    resultMessage: 'Unused inventory scope fixture result.',
    actions: [],
    includeAlternateInstance: true,
  });
  const [primary, alternate] = state.instances;
  await page.unroute('**/api/list-models');

  let releasePrimaryInventory!: () => void;
  const primaryInventoryGate = new Promise<void>((resolve) => { releasePrimaryInventory = resolve; });
  let pendingPrimaryRequests = 0;
  let settledPrimaryRequests = 0;
  const inventoryRequests: Array<{ baseUrl: string; modelKind: string }> = [];
  await page.route('**/api/list-models', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const baseUrl = String(body.base_url || '');
    const modelKind = String(body.model_kind || '');
    inventoryRequests.push({ baseUrl, modelKind });

    if (baseUrl === primary.baseUrl) {
      pendingPrimaryRequests += 1;
      await primaryInventoryGate;
      const staleModels = modelKind === 'SHARED'
        ? [{ id: 'stale-primary-model', name: 'Stale primary model', kind: 'SHARED' }]
        : [];
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            models: staleModels,
            complete: true,
            loadedResults: staleModels.length,
            totalResults: staleModels.length,
            pagesFetched: 1,
            pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: staleModels.length },
          }),
        });
      } catch {
        // An explicitly aborted obsolete request may already be gone in the browser.
      } finally {
        settledPrimaryRequests += 1;
      }
      return;
    }

    const currentModels = baseUrl === alternate.baseUrl && modelKind === 'SHARED'
      ? [{ id: 'current-alternate-model', name: 'Current alternate model', kind: 'SHARED' }]
      : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: currentModels,
        complete: true,
        loadedResults: currentModels.length,
        totalResults: currentModels.length,
        pagesFetched: 1,
        pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: currentModels.length },
      }),
    });
  });

  try {
    await page.goto('/content/ai-studio?mode=report');
    await closeWalkthrough(page);
    // React's development StrictMode may start and cancel one setup request
    // before the stable SHARED request. At least one request must reach the
    // deliberately stalled old-instance boundary.
    await expect.poll(() => pendingPrimaryRequests).toBeGreaterThanOrEqual(1);
    await expect.poll(() => new Set(inventoryRequests
      .filter((entry) => entry.baseUrl === primary.baseUrl)
      .map((entry) => entry.modelKind))).toEqual(new Set(['SHARED']));

    const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
    await sidebar.getByRole('button', {
      name: `Switch Omni instance. Current: ${primary.label}. Connected.`,
      exact: true,
    }).click();
    await sidebar.getByRole('group', { name: 'Saved Omni instances' })
      .getByRole('button', { name: new RegExp(alternate.label) })
      .click();

    await expect(sidebar.getByRole('button', {
      name: `Switch Omni instance. Current: ${alternate.label}. Connected.`,
      exact: true,
    })).toBeVisible();
    await expect.poll(() => new Set(inventoryRequests
      .filter((entry) => entry.baseUrl === alternate.baseUrl)
      .map((entry) => entry.modelKind)), { timeout: 5_000 }).toEqual(new Set(['SHARED']));
    await expect(page.getByLabel('Base model').locator('option')).toHaveText([
      'Choose a base model',
      'Current alternate model',
    ]);

    releasePrimaryInventory();
    await expect.poll(() => settledPrimaryRequests).toBe(pendingPrimaryRequests);
    await expect(page.getByLabel('Base model').locator('option')).toHaveText([
      'Choose a base model',
      'Current alternate model',
    ]);
    await expect(page.getByText('Stale primary model', { exact: true })).toHaveCount(0);
  } finally {
    releasePrimaryInventory();
  }
});

test('AI Content Studio sends one screenshot-grounded report job through the full workflow', async ({ page, request }) => {
  await unlockVault(request);
  const instance = await addSwitcherInstance(request, {
    label: 'AI Content browser instance',
    baseUrl: 'https://ai-content-browser.invalid',
    apiKey: 'ai-content-browser-key-not-real',
  });
  instance.lastValidatedAt = new Date().toISOString();

  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instances: [instance] }),
    });
  });
  await page.addInitScript((saved) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify({
      baseUrl: saved.baseUrl,
      apiKey: `__omnikit_vault_instance__:${saved.id}`,
      status: 'success',
      errorMessage: '',
      connectionMode: 'vault',
      instanceId: saved.id,
      instanceLabel: saved.label,
      apiKeyMasked: saved.apiKeyMasked,
    }));
  }, instance);

  await page.route('**/api/list-models', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const modelKind = String(body.model_kind || '');
    const selectedModelId = String(body.model_id || '');
    const models = modelKind === 'SHARED' || selectedModelId === 'model-ai-content'
      ? [{ id: 'model-ai-content', name: 'Example model', kind: 'SHARED' }]
      : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models,
        complete: true,
        loadedResults: models.length,
        totalResults: models.length,
        pagesFetched: 1,
        pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: models.length },
      }),
    });
  });
  await page.route('**/api/manage-topics', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ topics: [{ name: 'example_topic', label: 'Example topic' }] }),
    });
  });
  await page.route('**/api/omni-proxy', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (String(body.endpoint || '') === '/v1/models/model-ai-content/yaml') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          files: { model: 'name: Example model' },
          checksums: { model: 'example-checksum' },
        }),
      });
      return;
    }
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected report proxy endpoint.' }) });
  });

  let createCalls = 0;
  let createPayload: Record<string, unknown> | null = null;
  await page.route('**/api/manage-ai', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === 'create-job') {
      createCalls += 1;
      createPayload = body;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'ai-content-job-1', state: 'QUEUED', conversationId: 'conversation-1' }),
      });
      return;
    }
    if (body.action === 'get-job') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'ai-content-job-1', state: 'COMPLETE', conversationId: 'conversation-1' }),
      });
      return;
    }
    if (body.action === 'get-job-result' || body.action === 'get-content-studio-job-result') {
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: JSON.stringify({
          message: [
            '## Report',
            '### Executive summary',
            'A **bounded narrative** using `governed_metric` with a *qualified* interpretation.',
            '### Query evidence',
            '| Metric | Value |',
            '| :--- | ---: |',
            '| `governed_metric` | **42** |',
            '## Evidence limits',
            'Only supplied evidence was used.',
            '## Follow-ups',
            '1. Review the exact result in Omni.',
            '2. Continue in Omni Chat.',
          ].join('\n'),
          actions: [{ type: 'generate_query', message: 'Read governed fields', timestamp: '2026-08-13T12:00:00.000Z' }],
          omniChatUrl: 'https://ai-content-browser.invalid/chat/conversation-1?secret=removed',
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/content/ai-studio?mode=report');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'AI Content Studio', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Narrative report/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Topic (optional)').selectOption('example_topic');
  await page.getByLabel('Audience').fill('Executive readers reviewing the supplied visual evidence.');
  await page.getByLabel('Outcome or decision (required)').fill('Summarize the supplied visual requirements and identify the minimum follow-up evidence.');
  await page.getByLabel('Acceptance criteria').fill('Separate supported observations, evidence limits, and follow-ups.');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  });
  await expect(page.getByText('reference.png', { exact: true })).toBeVisible();
  const reportApproval = page.getByRole('checkbox', { name: /approve one no-write narrative request/i });
  await expect(reportApproval).toHaveAccessibleName(/scoped to model Example model/i);
  await expect(reportApproval).not.toHaveAccessibleName(/model-ai-content/i);
  await reportApproval.check();

  await page.getByRole('button', { name: 'Generate report' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Narrative report returned — verify findings' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Report', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Executive summary', exact: true })).toBeVisible();
  await expect(page.locator('strong').filter({ hasText: 'bounded narrative' })).toBeVisible();
  await expect(page.locator('code').filter({ hasText: 'governed_metric' }).first()).toBeVisible();
  await expect(page.locator('em').filter({ hasText: 'qualified' })).toBeVisible();
  const reportTable = page.getByRole('table');
  await expect(reportTable).toHaveCount(1);
  await expect(reportTable.getByRole('columnheader', { name: 'Metric', exact: true })).toBeVisible();
  await expect(reportTable.getByRole('cell', { name: '42', exact: true })).toBeVisible();
  await expect(page.getByText('| :--- | ---: |', { exact: true })).toHaveCount(0);
  await expect(page.locator('ol li')).toHaveCount(2);
  expect(createCalls).toBe(1);
  expect(createPayload?.model_id).toBe('model-ai-content');
  expect(createPayload?.topic_name).toBe('example_topic');
  expect(createPayload?.attachments).toEqual([expect.objectContaining({
    name: 'reference.png',
    mimeType: 'image/png',
  })]);
  const continueReportInChat = page.getByRole('link', { name: 'Continue in Omni Chat', exact: true });
  await expect(continueReportInChat).toHaveClass(/btn-primary/);
  await expect(continueReportInChat).toHaveAttribute(
    'href',
    'https://ai-content-browser.invalid/chat/conversation-1',
  );
  await page.getByText('Omni action summary (1)', { exact: true }).click();
  await expect(page.getByText('generate_query: Read governed fields')).toBeVisible();
});

test('AI Content Studio approval copy uses a neutral verified-model fallback when the inventory name is blank', async ({ page, request }) => {
  await installMockAIContentStudio(page, request, {
    slug: 'ai-content-blank-model-name',
    modelName: '   ',
    resultMessage: '## Report\nA fictional bounded report.\n## Evidence limits\nOnly supplied evidence.\n## Follow-ups\nContinue in Omni Chat.',
    actions: [{
      type: 'summarize',
      message: 'Summarized fictional evidence.',
      timestamp: '2026-08-14T18:03:00.000Z',
    }],
  });

  await page.goto('/content/ai-studio?mode=report');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Outcome or decision (required)').fill('Return one evidence-bounded fictional narrative.');

  const approval = page.getByRole('checkbox', { name: /approve one no-write narrative request/i });
  const approvalLabel = approval.locator('..');
  await expect(approval).toBeEnabled();
  await expect(approval).toHaveAccessibleName(/scoped to model selected verified model/i);
  await expect(approval).not.toHaveAccessibleName(/model-ai-content/i);
  await expect(approvalLabel).toContainText('selected verified model');
  await expect(approvalLabel).not.toContainText('model-ai-content');
});

test('AI Content Studio keeps an unsafe Narrative Report response locked across reload', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-report-response-review',
    resultMessage: '## Report\n### Executive summary\nA bounded report was returned.\n## Evidence limits\nOnly supplied fictional evidence was used.\n## Follow-ups\nInspect the exact response in Omni Chat.',
    actions: [{
      type: 'create_dashboard_from_chat',
      message: 'Unexpectedly reported a dashboard creation while generating a no-write narrative report.',
      timestamp: '2026-08-14T18:04:00.000Z',
      documentId: 'fictional-unexpected-report-document-1',
    }],
  });

  await page.goto('/content/ai-studio?mode=report');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Audience').fill('Fictional executive readers.');
  await page.getByLabel('Outcome or decision (required)').fill('Return one evidence-bounded no-write narrative report.');
  await page.getByLabel('Acceptance criteria').fill('Unexpected actions or document references remain locked for exact reconciliation.');
  await page.getByRole('checkbox', { name: /approve one no-write narrative request/i }).check();

  const generateReport = page.getByRole('button', { name: 'Generate report' });
  await generateReport.click();

  await expect(page.getByRole('heading', { name: 'Narrative report returned — verify findings', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Action review required:|Response review required:/)).toBeVisible();
  await expect(page.getByText(/UNEXPECTED_ACTION_FOR_MODE: create_dashboard_from_chat/)).toBeVisible();
  await expect(page.getByText('REPORT_UNEXPECTED_DOCUMENT_REFERENCE: 1 document reference returned for a no-write narrative report.', { exact: true })).toBeVisible();
  await expect(page.getByText('Response evidence requires reconciliation before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-content-reconciliation-job-id')).toHaveText('ai-content-report-response-review-job-1');
  const continueReportInChat = page.getByRole('link', { name: 'Continue in Omni Chat', exact: true });
  await expect(continueReportInChat).toHaveClass(/btn-primary/);
  await expect(generateReport).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);

  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) => candidate.startsWith('omnikit:ai-content-reconciliation:v1:'));
    if (!key) return '';
    return String((JSON.parse(window.sessionStorage.getItem(key) || '{}') as { reasonCode?: unknown }).reasonCode || '');
  })).toBe('response-review-required');

  const lifecycleCountBeforeReload = state.lifecycleRequests.length;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Narrative report returned — verify findings', exact: true })).toBeVisible();
  await expect(page.getByText('Response evidence requires reconciliation before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByText(/RESPONSE_EVIDENCE_REQUIRES_REVIEW:/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate report' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests).toHaveLength(lifecycleCountBeforeReload);
});

test('AI Content Studio renders one completed Blobby review from Omni octet-stream JSON without a false recovery hold', async ({ page, request }) => {
  const reviewNarrative = octetStreamReviewNarrative();
  expect(reviewNarrative).toHaveLength(7_493);
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-review-browser',
    resultMessage: reviewNarrative,
    actions: [{
      type: 'summarize',
      message: reviewNarrative,
      timestamp: '2026-08-13T12:00:00.000Z',
    }],
    mirrorResultNarrativeFields: true,
    resultContentType: 'application/octet-stream',
    resultExtraFields: { metrics: OCTET_STREAM_REVIEW_METRICS },
  });

  let dashboardExportStarts = 0;
  let dashboardExportStatusReads = 0;
  let dashboardExportFileReads = 0;

  await page.route('**/api/list-documents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        documents: [{
          id: 'fictional-review-dashboard-1',
          name: 'Fictional governed dashboard',
          folderPath: 'Fictional fixtures',
        }],
        complete: true,
      }),
    });
  });
  await page.route('**/api/omni-proxy', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const endpoint = String(body.endpoint || '');
    if (endpoint.endsWith('/queries')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'Fictional governed dashboard',
          queries: [{
            id: 'fictional-tile-1',
            displayTitle: 'Fictional governed activity',
            type: 'table',
            query: {
              modelId: 'model-ai-content',
              topicName: 'example_topic',
              fields: ['events.fictional_id'],
            },
          }],
          topics: ['example_topic'],
        }),
      });
      return;
    }
    if (endpoint.endsWith('/filters')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ filters: [] }) });
      return;
    }
    if (endpoint.endsWith('/download') && body.method === 'POST') dashboardExportStarts += 1;
    if (endpoint.endsWith('/fictional-png-job/status')) dashboardExportStatusReads += 1;
    if (endpoint.endsWith('/fictional-png-job') && body.raw_response === true) dashboardExportFileReads += 1;
    await route.fallback();
  });

  await page.goto('/content/ai-studio?mode=review');
  await closeWalkthrough(page);
  await expect(page.getByRole('tab', { name: /Review dashboard/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('button', { name: /Fictional governed dashboard/ }).click();
  await expect(page.getByText('Detected model IDs: model-ai-content', { exact: true })).toBeVisible();
  await expect(page.getByText('Verified SHARED scope: model-ai-content', { exact: true })).toBeVisible();
  await expect(page.getByText(/1 tiles? · 0 filters? · 1 detected topics?/i)).toBeVisible();
  await page.getByLabel('Detected topic scope (optional)').selectOption('example_topic');

  const runReview = page.getByRole('button', { name: 'Run Blobby review' });
  await expect(runReview).toBeDisabled();
  await page.getByRole('checkbox', { name: /approve sending.*dashboard render.*Omni Agent/i }).check();
  await expect(runReview).toBeEnabled();
  await runReview.dblclick();

  await expect(page.getByRole('heading', { name: 'Blobby dashboard review' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Evidence reviewed', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Supported findings', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Visual hierarchy', exact: true })).toBeVisible();
  await expect(page.locator('strong').filter({ hasText: 'primary decision tile' })).toBeVisible();
  await expect(page.locator('code').filter({ hasText: 'executive_priority' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unknowns', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recommended next steps', exact: true })).toBeVisible();
  await expect(page.getByLabel('Recommended next steps').getByText(/promote the primary decision tile/i)).toBeVisible();
  const continueReviewInChat = page.getByRole('link', { name: 'Continue in Omni Chat', exact: true });
  await expect(continueReviewInChat).toHaveClass(/btn-primary/);
  await expect(continueReviewInChat).toHaveAttribute(
    'href',
    'https://ai-content-review-browser.invalid/chat/ai-content-review-browser-conversation-1',
  );
  await expect(page.getByText('Response evidence requires reconciliation before another AI job', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  await expect(page.getByText(/could not read its structured result/i)).toHaveCount(0);

  expect(dashboardExportStarts).toBe(1);
  expect(dashboardExportStatusReads).toBe(1);
  expect(dashboardExportFileReads).toBe(1);
  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests.map(({ action }) => action)).toEqual([
    'create-job',
    'get-job',
    'get-content-studio-job-result',
  ]);
  expect(state.createPayload?.model_id).toBe('model-ai-content');
  expect(state.createPayload?.topic_name).toBe('example_topic');
  expect(state.createPayload?.attachments).toEqual([expect.objectContaining({
    mimeType: 'image/png',
    name: expect.stringMatching(/\.png$/i),
    data: expect.any(String),
  })]);
  const reviewPrompt = String(state.createPayload?.prompt || '');
  expect(reviewPrompt).toContain('Prompt contract: ai-content-studio/v4');
  expect(reviewPrompt).toMatch(/review one existing Omni dashboard.*exactly one/i);
  expect(reviewPrompt).toContain('## Evidence reviewed');
  expect(reviewPrompt).toContain('## Supported findings');
  expect(reviewPrompt).toContain('## Unknowns');
  expect(reviewPrompt).toContain('## Recommended next steps');
  expect(reviewPrompt).toContain('Fictional governed activity');
  expect(reviewPrompt).not.toContain(String((state.createPayload?.attachments as Array<{ data?: string }> | undefined)?.[0]?.data || 'missing-attachment-data'));
  await expect(page.getByText(/Local dashboard evidence audit|Run read-only audit|no Omni Agent job submitted/i)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    Object.keys(window.sessionStorage).filter((key) => key.startsWith('omnikit:ai-content-reconciliation:v1:')).length
  ))).toBe(0);
});

test('AI Content Studio keeps unsafe Review Dashboard action evidence locked across reload', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-review-response-review',
    resultMessage: '## Evidence reviewed\nThe fictional dashboard render was reviewed.\n## Supported findings\n### Visual hierarchy\nThe visible hierarchy needs review.\n## Unknowns\nUnseen behavior remains unknown.\n## Recommended next steps\nInspect the exact response in Omni Chat.',
    actions: [{
      type: 'create_app',
      message: 'Unexpectedly reported an App creation during a no-write dashboard review.',
      timestamp: '2026-08-14T18:05:00.000Z',
      documentId: 'fictional-unexpected-review-document-1',
    }],
  });

  await page.route('**/api/list-documents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        documents: [{
          id: 'fictional-response-review-dashboard-1',
          name: 'Fictional response-review dashboard',
          folderPath: 'Fictional fixtures',
        }],
        complete: true,
      }),
    });
  });
  await page.route('**/api/omni-proxy', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const endpoint = String(body.endpoint || '');
    if (endpoint.endsWith('/queries')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'Fictional response-review dashboard',
          queries: [{
            id: 'fictional-response-review-tile-1',
            displayTitle: 'Fictional governed activity',
            type: 'table',
            query: {
              modelId: 'model-ai-content',
              topicName: 'example_topic',
              fields: ['events.fictional_id'],
            },
          }],
          topics: ['example_topic'],
        }),
      });
      return;
    }
    if (endpoint.endsWith('/filters')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ filters: [] }) });
      return;
    }
    await route.fallback();
  });

  await page.goto('/content/ai-studio?mode=review');
  await closeWalkthrough(page);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('button', { name: /Fictional response-review dashboard/ }).click();
  await page.getByLabel('Detected topic scope (optional)').selectOption('example_topic');
  await page.getByRole('checkbox', { name: /approve sending.*dashboard render.*Omni Agent/i }).check();

  const runReview = page.getByRole('button', { name: 'Run Blobby review' });
  await runReview.click();

  await expect(page.getByRole('heading', { name: 'Blobby dashboard review', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Action review required:|Response review required:/)).toBeVisible();
  await expect(page.getByText(/UNEXPECTED_ACTION_FOR_MODE: create_app/)).toBeVisible();
  await expect(page.getByText('REVIEW_UNEXPECTED_DOCUMENT_REFERENCE: 1 document reference returned for a zero-write review.', { exact: true })).toBeVisible();
  await expect(page.getByText('Response evidence requires reconciliation before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-content-reconciliation-job-id')).toHaveText('ai-content-review-response-review-job-1');
  const continueReviewInChat = page.getByRole('link', { name: 'Continue in Omni Chat', exact: true });
  await expect(continueReviewInChat).toHaveClass(/btn-primary/);
  await expect(runReview).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);

  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) => candidate.startsWith('omnikit:ai-content-reconciliation:v1:'));
    if (!key) return '';
    return String((JSON.parse(window.sessionStorage.getItem(key) || '{}') as { reasonCode?: unknown }).reasonCode || '');
  })).toBe('response-review-required');

  const lifecycleCountBeforeReload = state.lifecycleRequests.length;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Blobby dashboard review', exact: true })).toBeVisible();
  await expect(page.getByText('Response evidence requires reconciliation before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByText(/RESPONSE_EVIDENCE_REQUIRES_REVIEW:/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run Blobby review' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests).toHaveLength(lifecycleCountBeforeReload);
});

test('AI Content Studio recovers an existing completed review with one octet-stream result read and no create or cancel', async ({ page, request }) => {
  const reviewNarrative = octetStreamReviewNarrative();
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-review-octet-recovery',
    resultMessage: reviewNarrative,
    actions: [{
      type: 'summarize',
      message: reviewNarrative,
      timestamp: '2026-08-14T16:11:06.115Z',
    }],
    mirrorResultNarrativeFields: true,
    resultContentType: 'application/octet-stream',
    resultExtraFields: { metrics: OCTET_STREAM_REVIEW_METRICS },
    resultFailuresBeforeSuccess: 1,
    resultFailureStatus: 422,
    resultFailureCode: 'AI_RESULT_CONTRACT_MISMATCH',
  });

  await page.route('**/api/list-documents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        documents: [{
          id: 'fictional-review-recovery-dashboard-1',
          name: 'Fictional review recovery dashboard',
          folderPath: 'Fictional fixtures',
        }],
        complete: true,
      }),
    });
  });
  await page.route('**/api/omni-proxy', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const endpoint = String(body.endpoint || '');
    if (endpoint.endsWith('/queries')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'Fictional review recovery dashboard',
          queries: [{
            id: 'fictional-recovery-tile-1',
            displayTitle: 'Fictional recovery activity',
            type: 'table',
            query: {
              modelId: 'model-ai-content',
              topicName: 'example_topic',
              fields: ['events.fictional_id'],
            },
          }],
          topics: ['example_topic'],
        }),
      });
      return;
    }
    if (endpoint.endsWith('/filters')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ filters: [] }) });
      return;
    }
    await route.fallback();
  });

  await page.goto('/content/ai-studio?mode=review');
  await closeWalkthrough(page);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('button', { name: /Fictional review recovery dashboard/ }).click();
  await page.getByLabel('Detected topic scope (optional)').selectOption('example_topic');
  await page.getByRole('checkbox', { name: /approve sending.*dashboard render.*Omni Agent/i }).check();
  await page.getByRole('button', { name: 'Run Blobby review' }).click();

  await expect(page.getByText('Reconciliation required before another AI job', { exact: true })).toBeVisible({ timeout: 15_000 });
  const retryResult = page.getByRole('button', { name: 'Retry result read', exact: true });
  await expect(retryResult).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests.map(({ action }) => action)).toEqual([
    'create-job',
    'get-job',
    'get-content-studio-job-result',
  ]);
  await expect.poll(() => page.evaluate(() => (
    Object.keys(window.sessionStorage).filter((key) => key.startsWith('omnikit:ai-content-reconciliation:v1:')).length
  ))).toBe(1);

  const lifecycleCountBeforeRecovery = state.lifecycleRequests.length;
  await retryResult.click();
  await expect(page.getByRole('heading', { name: 'Blobby dashboard review', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Evidence reviewed', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Supported findings', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unknowns', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recommended next steps', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue in Omni Chat', exact: true })).toHaveAttribute(
    'href',
    'https://ai-content-review-octet-recovery.invalid/chat/ai-content-review-octet-recovery-conversation-1',
  );
  await expect(page.getByText('Response evidence requires reconciliation before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByText(/could not read its structured result/i)).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(2);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests.slice(lifecycleCountBeforeRecovery).map(({ action }) => action)).toEqual([
    'get-content-studio-job-result',
  ]);
  await expect.poll(() => page.evaluate(() => (
    Object.keys(window.sessionStorage).filter((key) => key.startsWith('omnikit:ai-content-reconciliation:v1:')).length
  ))).toBe(1);
});

test('AI Content Studio groups duplicate dashboard names by authoritative connection, keeps one selected state, and resolves exact SHARED model lineage', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-review-connection-picker',
    resultMessage: [
      '## Evidence reviewed',
      'One selected fictional dashboard render and its bounded structure.',
      '## Supported findings',
      'The selected dashboard remained bound to its canonical SHARED model.',
      '## Unknowns',
      'No claims are made about data correctness or permissions.',
      '## Recommended next steps',
      'Continue the visual review in Omni Chat.',
    ].join('\n'),
    actions: [{
      type: 'summarize',
      message: 'Reviewed the selected fictional dashboard only.',
      timestamp: '2026-08-14T12:00:00.000Z',
    }],
  });

  const targetedModelLookups: string[] = [];
  await page.route('**/api/list-models', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const selectedModelId = String(body.model_id || '');
    const modelKind = String(body.model_kind || '');
    if (selectedModelId) targetedModelLookups.push(selectedModelId);
    const models = selectedModelId === 'workbook-model-west'
      ? [{
          id: 'workbook-model-west',
          identifier: 'workbook-model-west-identifier',
          name: 'Different workbook model display name',
          kind: 'WORKBOOK',
          baseModelId: 'model-ai-content',
          connectionId: 'connection-west',
        }]
      : modelKind === 'SHARED'
        ? [
            {
              id: 'model-ai-content-east',
              identifier: 'fictional-governed-model-east',
              name: 'Fictional governed model east',
              kind: 'SHARED',
              connectionId: 'connection-east',
              connectionName: 'Untrusted model-provided east label',
            },
            {
              id: 'model-ai-content',
              identifier: 'fictional-governed-model',
              name: 'Fictional governed model',
              kind: 'SHARED',
              connectionId: 'connection-west',
              connectionName: 'Untrusted model-provided west label',
            },
          ]
        : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models,
        complete: true,
        loadedResults: models.length,
        totalResults: models.length,
        pagesFetched: 1,
        pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: models.length },
      }),
    });
  });
  await page.route('**/api/list-documents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        documents: [
          {
            id: 'duplicate-dashboard-east',
            name: 'Shared operational dashboard',
            folderPath: 'Shared review folder',
            connectionId: 'connection-east',
            connectionName: 'Untrusted document-provided east label',
            baseModelName: 'Stale picker model name',
          },
          {
            id: 'duplicate-dashboard-west',
            name: 'Shared operational dashboard',
            folderPath: 'Shared review folder',
            connectionId: 'connection-west',
            connectionName: 'Untrusted document-provided west label',
            baseModelName: 'Stale picker model name',
          },
          {
            id: 'distinct-dashboard-west',
            name: 'Distinct operational dashboard',
            folderPath: 'Other review folder',
            connectionId: 'connection-west',
            connectionName: 'Untrusted document-provided west label',
          },
        ],
        complete: true,
      }),
    });
  });

  const inspectedDashboardIds: string[] = [];
  const documentStateReads: string[] = [];
  await page.route('**/api/omni-proxy', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const endpoint = String(body.endpoint || '');
    if (endpoint === '/v1/connections') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connections: [
            { id: 'connection-east', name: 'Authoritative east connection' },
            { id: 'connection-west', name: 'Authoritative west connection' },
          ],
        }),
      });
      return;
    }
    const documentStateMatch = endpoint.match(/\/v2\/documents\/(duplicate-dashboard-(?:east|west))$/);
    if (documentStateMatch) {
      documentStateReads.push(documentStateMatch[1]);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: documentStateMatch[1],
          name: 'Authoritative document state name differs from the picker label',
          modelId: documentStateMatch[1] === 'duplicate-dashboard-west'
            ? 'model-ai-content'
            : 'model-ai-content-east',
          workbookModelId: documentStateMatch[1] === 'duplicate-dashboard-west'
            ? 'workbook-model-west'
            : 'workbook-model-east',
          queryPresentations: {},
          containers: [],
          controls: [],
        }),
      });
      return;
    }
    const dashboardQueryMatch = endpoint.match(/\/documents\/(duplicate-dashboard-(?:east|west))\/queries$/);
    const dashboardFilterMatch = endpoint.match(/\/dashboards\/(duplicate-dashboard-(?:east|west))\/filters$/);
    const dashboardId = dashboardQueryMatch?.[1] || dashboardFilterMatch?.[1];
    const resource = dashboardQueryMatch ? 'queries' : dashboardFilterMatch ? 'filters' : '';
    if (!dashboardId || !resource) {
      await route.fallback();
      return;
    }
    inspectedDashboardIds.push(`${dashboardId}:${resource}`);
    if (resource === 'filters') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ filters: [] }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Shared operational dashboard',
        queries: [{
          id: 'tile-from-workbook-model',
          displayTitle: 'Workbook model evidence',
          type: 'table',
          query: {
            modelId: dashboardId === 'duplicate-dashboard-east'
              ? 'workbook-model-east'
              : 'workbook-model-west',
            fields: ['events.fictional_id'],
          },
        }],
        topics: [],
      }),
    });
  });

  await page.goto('/content/ai-studio?mode=review');
  await closeWalkthrough(page);
  await page.getByRole('button', { name: 'Refresh' }).click();

  const eastGroup = page.getByRole('group', {
    name: /^Authoritative east connection dashboards.*connection-east/i,
  });
  const westGroup = page.getByRole('group', {
    name: /^Authoritative west connection dashboards.*connection-west/i,
  });
  await expect(eastGroup).toBeVisible();
  await expect(westGroup).toBeVisible();
  await expect(eastGroup.getByText('Authoritative east connection', { exact: true })).toBeVisible();
  await expect(westGroup.getByText('Authoritative west connection', { exact: true })).toBeVisible();
  await expect(eastGroup).toHaveAttribute('title', 'connection-east');
  await expect(westGroup).toHaveAttribute('title', 'connection-west');
  await expect(page.getByText(/Untrusted (?:model|document)-provided (?:east|west) label/i)).toHaveCount(0);
  await expect(page.getByText('connectio', { exact: true })).toHaveCount(0);

  const eastDuplicate = eastGroup.getByRole('button', {
    name: /^Select dashboard Shared operational dashboard in Shared review folder on Authoritative east connection.*connection-east/i,
  });
  const westDuplicate = westGroup.getByRole('button', {
    name: /^Select dashboard Shared operational dashboard in Shared review folder on Authoritative west connection.*connection-west/i,
  });
  await expect(eastDuplicate).toHaveCount(1);
  await expect(westDuplicate).toHaveCount(1);

  const selectedOptions = page.locator('section[role="group"] button[data-dashboard-selected="true"]');
  const pressedOptions = page.locator('section[role="group"] button[aria-pressed="true"]');
  const activeOptions = page.locator('section[role="group"] button[data-dashboard-active="true"]');
  const selectedBadges = page.locator('section[role="group"]').getByText('Selected', { exact: true });
  const selectedPinkMarkers = page.locator('section[role="group"] button[class~="border-l-omni-500"]');

  await eastDuplicate.click();
  await expect(eastDuplicate).toHaveAttribute('aria-pressed', 'true');
  await expect(eastDuplicate).toHaveAttribute('data-dashboard-selected', 'true');
  await expect(eastDuplicate).toHaveAttribute('data-dashboard-active', 'true');
  await expect(westDuplicate).toHaveAttribute('aria-pressed', 'false');
  await expect(westDuplicate).toHaveAttribute('data-dashboard-selected', 'false');
  await expect(selectedOptions).toHaveCount(1);
  await expect(pressedOptions).toHaveCount(1);
  await expect(activeOptions).toHaveCount(1);
  await expect(selectedBadges).toHaveCount(1);
  await expect(selectedPinkMarkers).toHaveCount(1);
  await expect(page.getByText('Verified SHARED scope: model-ai-content-east', { exact: true })).toBeVisible();

  await westDuplicate.click();
  await expect(westDuplicate).toHaveAttribute('aria-pressed', 'true');
  await expect(westDuplicate).toHaveAttribute('data-dashboard-selected', 'true');
  await expect(westDuplicate).toHaveAttribute('data-dashboard-active', 'true');
  await expect(eastDuplicate).toHaveAttribute('aria-pressed', 'false');
  await expect(eastDuplicate).toHaveAttribute('data-dashboard-selected', 'false');
  await expect(selectedOptions).toHaveCount(1);
  await expect(pressedOptions).toHaveCount(1);
  await expect(activeOptions).toHaveCount(1);
  await expect(selectedBadges).toHaveCount(1);
  await expect(selectedPinkMarkers).toHaveCount(1);
  await expect(page.getByText('Verified SHARED scope: model-ai-content', { exact: true })).toBeVisible();

  await eastDuplicate.hover();
  await expect(eastDuplicate).toHaveAttribute('data-dashboard-active', 'true');
  await expect(eastDuplicate).toHaveAttribute('aria-pressed', 'false');
  await expect(eastDuplicate).toHaveClass(/bg-surface-secondary/);
  await expect(eastDuplicate).toHaveClass(/border-l-border-strong/);
  await expect(eastDuplicate).toHaveClass(/ring-border-strong/);
  await expect(eastDuplicate).not.toHaveClass(/bg-omni-50/);
  await expect(eastDuplicate).not.toHaveClass(/border-l-omni-500/);
  await expect(westDuplicate).toHaveAttribute('data-dashboard-active', 'false');
  await expect(westDuplicate).toHaveAttribute('aria-pressed', 'true');
  await expect(westDuplicate).toHaveClass(/bg-omni-50/);
  await expect(westDuplicate).toHaveClass(/border-l-omni-500/);
  await expect(selectedOptions).toHaveCount(1);
  await expect(pressedOptions).toHaveCount(1);
  await expect(activeOptions).toHaveCount(1);
  await expect(selectedBadges).toHaveCount(1);
  await expect(selectedPinkMarkers).toHaveCount(1);
  await expect(page.getByText(/selected dashboard model is not available as a verified SHARED model/i)).toHaveCount(0);
  await expect(page.getByText(/No model association was detected/i)).toHaveCount(0);

  const approval = page.getByRole('checkbox', { name: /approve sending.*dashboard render.*Omni Agent/i });
  await expect(approval).toHaveAccessibleName(/scoped to model Fictional governed model/i);
  await expect(approval).not.toHaveAccessibleName(/model-ai-content/i);
  await expect(approval).toBeEnabled();
  await approval.check();
  const runReview = page.getByRole('button', { name: 'Run Blobby review' });
  await expect(runReview).toBeEnabled();
  await runReview.click();
  await expect(page.getByRole('heading', { name: 'Blobby dashboard review', exact: true })).toBeVisible({ timeout: 15_000 });

  expect(inspectedDashboardIds.sort()).toEqual([
    'duplicate-dashboard-east:filters',
    'duplicate-dashboard-east:queries',
    'duplicate-dashboard-west:filters',
    'duplicate-dashboard-west:queries',
  ]);
  expect(documentStateReads).toEqual([
    'duplicate-dashboard-east',
    'duplicate-dashboard-west',
  ]);
  expect(targetedModelLookups).not.toContain('workbook-model-east');
  expect(targetedModelLookups).not.toContain('workbook-model-west');
  expect(state.createCalls).toBe(1);
  expect(state.createPayload?.model_id).toBe('model-ai-content');
});

test('AI Content Studio fails before AI submission when dashboard render capture fails and then uses an uploaded screenshot fallback once', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-review-fallback-browser',
    resultMessage: [
      '## Evidence reviewed',
      'The uploaded fictional dashboard screenshot and bounded metadata were supplied after automatic capture failed.',
      '## Supported findings',
      '- [P1] The primary decision is visually buried — scanning is slower — establish a dominant KPI band.',
      '## Unknowns',
      'Interactive behavior and unsupplied responsive states remain unknown.',
      '## Recommended next steps',
      '- [P1] Promote the primary decision and reduce secondary visual weight.',
    ].join('\n'),
    actions: [{
      type: 'summarize',
      message: 'Reviewed only the uploaded fictional screenshot and bounded evidence.',
      timestamp: '2026-08-13T12:00:00.000Z',
    }],
  });

  let failedDashboardExportStarts = 0;
  await page.route('**/api/list-documents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        documents: [{
          id: 'fictional-review-fallback-dashboard-1',
          name: 'Fictional fallback dashboard',
          folderPath: 'Fictional fixtures',
        }],
        complete: true,
      }),
    });
  });
  await page.route('**/api/omni-proxy', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const endpoint = String(body.endpoint || '');
    if (endpoint.endsWith('/queries')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'Fictional fallback dashboard',
          queries: [{
            id: 'fictional-fallback-tile-1',
            displayTitle: 'Fictional fallback activity',
            type: 'bar',
            query: {
              modelId: 'model-ai-content',
              topicName: 'example_topic',
              fields: ['events.fictional_id'],
            },
          }],
          topics: ['example_topic'],
        }),
      });
      return;
    }
    if (endpoint.endsWith('/filters')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ filters: [] }) });
      return;
    }
    if (endpoint.endsWith('/download') && body.method === 'POST') {
      failedDashboardExportStarts += 1;
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Fictional dashboard render capture failed.' }),
      });
      return;
    }
    await route.fallback();
  });

  await page.goto('/content/ai-studio?mode=review');
  await closeWalkthrough(page);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('button', { name: /Fictional fallback dashboard/ }).click();
  await page.getByLabel('Detected topic scope (optional)').selectOption('example_topic');

  const approval = page.getByRole('checkbox', { name: /approve sending.*dashboard render.*Omni Agent/i });
  const runReview = page.getByRole('button', { name: 'Run Blobby review' });
  await approval.check();
  await runReview.click();

  await expect(page.getByRole('alert')).toContainText(
    'Automatic dashboard render could not be captured. Add a screenshot image, then run Blobby review again.',
  );
  expect(failedDashboardExportStarts).toBe(1);
  expect(state.createCalls).toBe(0);
  expect(state.lifecycleRequests).toEqual([]);

  await expect(page.getByRole('button', { name: 'Add screenshot or PDF visual references' })).toBeVisible();
  const fallbackPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: 'fictional-review-fallback.png',
    mimeType: 'image/png',
    buffer: fallbackPng,
  });
  if (!await approval.isChecked()) await approval.check();
  await runReview.click();

  await expect(page.getByText(
    'Automatic dashboard render could not be captured, so the uploaded screenshot was used as visual evidence.',
    { exact: true },
  )).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Blobby dashboard review' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/establish a dominant KPI band/i)).toBeVisible();
  expect(failedDashboardExportStarts).toBe(2);
  expect(state.createCalls).toBe(1);
  expect(state.lifecycleRequests.map(({ action }) => action)).toEqual([
    'create-job',
    'get-job',
    'get-content-studio-job-result',
  ]);
  expect(state.createPayload?.attachments).toEqual([expect.objectContaining({
    name: 'fictional-review-fallback.png',
    mimeType: 'image/png',
    data: fallbackPng.toString('base64'),
  })]);
});

test('AI Content Studio requires dashboard publication inputs, submits once, and authoritatively reconciles cleanup', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-dashboard-browser',
    resultMessage: 'Omni returned a fictional dashboard workflow response for human verification.',
    actions: [{
      type: 'create_dashboard',
      message: 'Returned a fictional dashboard document reference',
      timestamp: '2026-08-13T12:00:00.000Z',
      documentId: 'fictional-dashboard-doc-1',
    }],
  });

  await page.goto('/content/ai-studio?mode=dashboard');
  await closeWalkthrough(page);
  await expect(page.getByRole('tab', { name: /Dashboard creation/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Topic (optional)').selectOption('example_topic');
  const audience = page.getByLabel('Audience');
  const objective = page.getByLabel('Outcome or decision (required)');
  await audience.fill('Internal reviewers of the fictional governed activity.');
  await objective.fill('Decide whether governed activity is ready for a bounded human review.');
  await page.getByLabel('Required metrics, dimensions, and content').fill('Use only the governed activity fields available in the selected semantic scope.');
  await page.getByLabel('Acceptance criteria').fill('Return one cohesive dashboard with an explicit verification handoff.');

  const publishButton = page.getByRole('button', { name: 'Request dashboard' });
  await expect(publishButton).toBeDisabled();
  await page.getByLabel('Content name (required)').fill('Fictional governed activity dashboard');
  await expect(publishButton).toBeDisabled();
  const approval = page.getByRole('checkbox', { name: /approve one controlled-write.*dashboard named/i });
  await expect(approval).toHaveAccessibleName(/scoped to model Fictional governed model/i);
  await expect(approval).not.toHaveAccessibleName(/model-ai-content/i);
  await approval.check();
  await expect(publishButton).toBeEnabled();

  await audience.fill('Changed internal review audience.');
  await expect(publishButton).toBeDisabled();
  await audience.fill('Internal reviewers of the fictional governed activity.');
  await approval.check();
  await expect(publishButton).toBeEnabled();

  await publishButton.dblclick();
  await expect(page.getByRole('heading', { name: 'Dashboard job completed — verify in Omni' })).toBeVisible({ timeout: 15_000 });
  expect(state.createCalls).toBe(1);
  expect(state.createPayload?.model_id).toBe('model-ai-content');
  expect(state.createPayload?.topic_name).toBe('example_topic');
  const dashboardPrompt = String(state.createPayload?.prompt);
  expect(dashboardPrompt).toContain('Prompt contract: ai-content-studio/v4');
  expect(dashboardPrompt).toContain('Attempt creation of exactly one dashboard named by requestedName.');
  expect(dashboardPrompt).toContain('Do not claim a destination, owner, publication state, or verified artifact.');
  const contextStart = dashboardPrompt.indexOf('<UNTRUSTED_CONTEXT_JSON>') + '<UNTRUSTED_CONTEXT_JSON>'.length;
  const contextEnd = dashboardPrompt.indexOf('</UNTRUSTED_CONTEXT_JSON>');
  const promptContext = JSON.parse(dashboardPrompt.slice(contextStart, contextEnd)) as Record<string, unknown>;
  expect(promptContext).toEqual(expect.objectContaining({
    requestedName: 'Fictional governed activity dashboard',
    brief: expect.objectContaining({
      audience: 'Internal reviewers of the fictional governed activity.',
      objective: 'Decide whether governed activity is ready for a bounded human review.',
      requiredContent: 'Use only the governed activity fields available in the selected semantic scope.',
      acceptanceCriteria: 'Return one cohesive dashboard with an explicit verification handoff.',
    }),
  }));
  expect(promptContext).not.toHaveProperty('semanticScope');
  expect(dashboardPrompt).not.toContain('model-ai-content');
  expect(dashboardPrompt).not.toContain('example_topic');
  await expect(page.getByText(/Agent response alone does not prove/)).toBeVisible();
  await expect(page.getByText(/Action review required:/)).toBeVisible();
  await expect(page.getByText('Unverified returned document references', { exact: true })).toBeVisible();
  await expect(page.getByText('create_dashboard: fictional-dashboard-doc-1', { exact: true })).toBeVisible();
  await expect(page.getByText('Dashboard verified', { exact: true })).toBeVisible();
  await expect(page.getByText(/1 query presentations across 1 layout containers/)).toBeVisible();
  await expect(page.getByText(/complete 3-grant access list/)).toBeVisible();
  expect(state.verifyCalls).toBe(1);
  await expect(page.getByText(/Render transport verified:/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole('checkbox', { name: /exact verified test artifact/i }).check();
  await page.getByLabel('Type the exact identifier to confirm').fill('fictional-dashboard-doc-1');
  await page.getByRole('button', { name: 'Move fictional-dashboard-doc-1 to Trash' }).click();
  await expect(page.getByText(/moved to recoverable Trash/)).toBeVisible();
  expect(state.trashCalls).toBe(1);
});

test('AI Content Studio keeps dashboard-from-chat creation unverified until a human supplies the exact document identifier', async ({ page, request }) => {
  const buildMessage = 'Building **Coffee Orders** with 13 queries...';
  const finalNarrative = [
    '### Status',
    'Dashboard creation completed in Omni Chat; inspect the **exact artifact** before relying on it.',
    '### Material gaps',
    '- **Current-state behavior remains unknown.** Verify the saved dashboard in Omni.',
    '### Most useful continuation',
    'Continue in the existing Omni Chat to refine the result.',
  ].join('\n\n');
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-dashboard-chat-action',
    resultMessage: finalNarrative,
    actions: [{
      type: 'create_dashboard_from_chat',
      message: buildMessage,
      timestamp: '2026-08-14T18:01:00.000Z',
    }],
  });

  await page.goto('/content/ai-studio?mode=dashboard');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Content name (required)').fill('Fictional governed activity dashboard');
  await page.getByLabel('Audience').fill('Internal reviewers of a fictional governed workflow.');
  await page.getByLabel('Outcome or decision (required)').fill('Create one bounded dashboard for exact-ID reconciliation.');
  await page.getByLabel('Required metrics, dimensions, and content').fill('Use only governed fields from the selected fictional scope.');
  await page.getByLabel('Acceptance criteria').fill('Keep creation unverified until the exact returned document is authoritatively reread.');
  await page.getByRole('checkbox', { name: /approve one controlled-write.*dashboard named/i }).check();
  const requestDashboard = page.getByRole('button', { name: 'Request dashboard' });
  await requestDashboard.dblclick();

  await expect(page.getByRole('heading', { name: 'Dashboard job completed — artifact verification required', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Status', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Material gaps', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Most useful continuation', exact: true })).toBeVisible();
  await expect(page.getByText('### Status', { exact: true })).toHaveCount(0);
  await expect(page.getByText('exact artifact', { exact: true })).toHaveCount(1);
  await expect(page.getByText(/expected creation action without a verifiable artifact identifier/)).toBeVisible();
  await expect(page.getByText('Unverified returned document references', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Action review required:/)).toHaveCount(0);
  await expect(page.getByText(/UNRECOGNIZED_ACTION_TYPE: create_dashboard_from_chat/)).toHaveCount(0);
  await expect(page.getByText(/POTENTIAL_MUTATION: create_dashboard_from_chat/)).toHaveCount(0);

  const actionSummary = page.getByText(`create_dashboard_from_chat: ${buildMessage}`, { exact: true });
  await expect(actionSummary).toHaveCount(1);
  await page.getByText('Omni action summary (1)', { exact: true }).click();
  await expect(actionSummary).toBeVisible();
  // Poll: the click above may still be in flight. A bare expect here races the
  // request and fails under CPU contention (reproduced locally, and the cause of
  // the CI failure at this assertion).
  await expect.poll(() => state.createCalls).toBe(1);
  expect(state.verifyCalls).toBe(0);
  expect(state.verifiedDocumentIds).toEqual([]);

  await expect(page.getByText('Artifact verification required before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-content-reconciliation-job-id')).toHaveText('ai-content-dashboard-chat-action-job-1');
  await expect(page.getByRole('link', { name: 'Continue in Omni Chat', exact: true })).toHaveAttribute(
    'href',
    'https://ai-content-dashboard-chat-action.invalid/chat/ai-content-dashboard-chat-action-conversation-1',
  );
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  await expect(requestDashboard).toBeDisabled();

  await expect(page.getByRole('heading', { name: 'Authoritative artifact reconciliation', exact: true })).toBeVisible();
  await expect(page.getByText('Local verification is unavailable after session restore.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/No returned candidate passed authoritative reconciliation/)).toBeVisible();
  const manualIdentifier = page.getByLabel('Exact document identifier');
  const verifyExactIdentifier = page.getByRole('button', { name: 'Verify exact identifier' });
  await expect(verifyExactIdentifier).toBeDisabled();
  await manualIdentifier.fill('fictional-dashboard-manual-id-1');
  await expect(verifyExactIdentifier).toBeEnabled();
  await verifyExactIdentifier.click();

  await expect(page.getByText('Dashboard verified', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Authoritative artifact reconciliation' })
    .getByText('fictional-dashboard-manual-id-1', { exact: true }).first()).toBeVisible();
  expect(state.verifyCalls).toBe(1);
  expect(state.verifiedDocumentIds).toEqual(['fictional-dashboard-manual-id-1']);
  expect(state.createCalls).toBe(1);

  await expect(page.getByText('Artifact verification required before another AI job', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    Object.keys(window.sessionStorage).filter((key) => key.startsWith('omnikit:ai-content-reconciliation:v1:')).length
  ))).toBe(1);

  await page.reload();
  await expect(page.getByText('Artifact verification required before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-content-reconciliation-job-id')).toHaveText('ai-content-dashboard-chat-action-job-1');
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request dashboard' })).toBeDisabled();
  await expect(page.getByText('Local verification is unavailable after session restore.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Authoritative artifact reconciliation', exact: true })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);

  await page.getByRole('checkbox', { name: /inspected this exact completed dashboard job.*starting another job may create a duplicate/i }).check();
  const clearHold = page.getByRole('button', { name: 'Clear hold after reconciliation', exact: true });
  await expect(clearHold).toBeEnabled();
  await clearHold.click();
  await expect(page.getByText('Artifact verification required before another AI job', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    Object.keys(window.sessionStorage).filter((key) => key.startsWith('omnikit:ai-content-reconciliation:v1:')).length
  ))).toBe(0);
  expect(state.createCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);
});

test('AI Content Studio keeps malformed dashboard creation evidence locked and reviewable across reload', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-dashboard-creation-status-unverified',
    resultMessage: 'The dashboard job completed with malformed creation evidence that requires reconciliation.',
    actions: [{
      type: 'create_dashboard_from_chat',
      message: 'Building the bounded dashboard from governed evidence.',
      timestamp: '',
    }],
  });

  await page.goto('/content/ai-studio?mode=dashboard');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Content name (required)').fill('Fictional malformed creation dashboard');
  await page.getByLabel('Audience').fill('Internal reviewers of a fictional governed workflow.');
  await page.getByLabel('Outcome or decision (required)').fill('Create one bounded dashboard only when action evidence is complete.');
  await page.getByLabel('Required metrics, dimensions, and content').fill('Use only governed fields from the selected fictional scope.');
  await page.getByLabel('Acceptance criteria').fill('Incomplete creation action evidence blocks another request until reconciliation.');
  await page.getByRole('checkbox', { name: /approve one controlled-write.*dashboard named/i }).check();

  const requestDashboard = page.getByRole('button', { name: 'Request dashboard' });
  await requestDashboard.click();

  await expect(page.getByRole('heading', { name: 'Dashboard job completed — creation status unverified', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Action review required:/)).toBeVisible();
  await expect(page.getByText(/MALFORMED_ACTION:/)).toBeVisible();
  await expect(page.getByText('Unverified returned document references', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Creation status requires reconciliation before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-content-reconciliation-job-id')).toHaveText('ai-content-dashboard-creation-status-unverified-job-1');
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  await expect(requestDashboard).toBeDisabled();
  expect(state.createCalls).toBe(1);
  expect(state.verifyCalls).toBe(0);
  expect(state.verifiedDocumentIds).toEqual([]);

  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) => candidate.startsWith('omnikit:ai-content-reconciliation:v1:'));
    if (!key) return '';
    return String((JSON.parse(window.sessionStorage.getItem(key) || '{}') as { reasonCode?: unknown }).reasonCode || '');
  })).toBe('creation-status-unverified');

  const lifecycleCountBeforeReload = state.lifecycleRequests.length;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard job completed — creation status unverified', exact: true })).toBeVisible();
  await expect(page.getByText('Creation status requires reconciliation before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByText(/ACTION_EVIDENCE_REQUIRES_REVIEW:/)).toBeVisible();
  await expect(page.getByText('Unverified returned document references', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request dashboard' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests).toHaveLength(lifecycleCountBeforeReload);
});

test('AI Content Studio treats a COMPLETE dashboard with an unreadable result as a Chat handoff and retries only the result read', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-dashboard-result-handoff',
    resultMessage: 'Omni returned the existing fictional dashboard during read-only result recovery.',
    resultFailuresBeforeSuccess: 1,
    resultFailureStatus: 422,
    resultFailureCode: 'AI_RESULT_CONTRACT_MISMATCH',
    actions: [{
      type: 'create_dashboard',
      message: 'Returned the existing fictional dashboard reference',
      timestamp: '2026-08-14T12:00:00.000Z',
      documentId: 'fictional-dashboard-result-handoff-1',
    }],
  });

  await page.goto('/content/ai-studio?mode=dashboard');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Content name (required)').fill('Fictional dashboard result handoff');
  await page.getByLabel('Audience').fill('Internal reviewers of a fictional governed workflow.');
  await page.getByLabel('Outcome or decision (required)').fill('Create one bounded dashboard and continue refinement in Omni Chat.');
  await page.getByLabel('Required metrics, dimensions, and content').fill('Use only governed fields from the selected fictional scope.');
  await page.getByLabel('Acceptance criteria').fill('Omni reports the job terminal state and provides a safe Chat continuation.');
  await page.getByRole('checkbox', { name: /approve one controlled-write.*dashboard named/i }).check();

  const requestDashboard = page.getByRole('button', { name: 'Request dashboard' });
  await requestDashboard.dblclick();

  await expect(page.getByRole('heading', { name: 'Dashboard job completed — continue in Omni Chat', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Omni confirmed this dashboard job as COMPLETE/)).toBeVisible();
  await expect(page.getByText('Omni completed the job, but its structured result could not be read. Check the job in Omni before retrying.', { exact: true })).toHaveCount(0);
  const continueInChat = page.getByRole('link', { name: 'Continue in Omni Chat', exact: true });
  await expect(continueInChat).toHaveCount(1);
  await expect(continueInChat).toBeVisible();
  await expect(continueInChat).toHaveClass(/btn-primary/);
  await expect(continueInChat).toHaveAttribute(
    'href',
    'https://ai-content-dashboard-result-handoff.invalid/chat/ai-content-dashboard-result-handoff-conversation-1',
  );
  const retryResult = page.getByRole('button', { name: 'Retry result read', exact: true });
  await expect(retryResult).toBeVisible();
  await expect(retryResult).toHaveClass(/btn-secondary/);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni' })).toHaveCount(0);
  await expect(requestDashboard).toBeDisabled();
  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);

  await expect.poll(() => page.evaluate(() => (
    Object.keys(window.sessionStorage).filter((key) => key.startsWith('omnikit:ai-content-reconciliation:v1:')).length
  ))).toBe(1);
  const lifecycleCountBeforeReload = state.lifecycleRequests.length;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard job completed — continue in Omni Chat', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue in Omni Chat', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel job in Omni' })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests).toHaveLength(lifecycleCountBeforeReload);

  const lifecycleCountBeforeRecovery = state.lifecycleRequests.length;
  await page.getByRole('button', { name: 'Retry result read', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard job completed — verify in Omni', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('create_dashboard: fictional-dashboard-result-handoff-1', { exact: true })).toBeVisible();
  await expect(page.getByText('Local verification is unavailable after session restore.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Authoritative artifact reconciliation', exact: true })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(2);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests.slice(lifecycleCountBeforeRecovery).map((requestEntry) => requestEntry.action)).toEqual([
    'get-content-studio-job-result',
  ]);
  await expect.poll(() => page.evaluate(() => (
    Object.keys(window.sessionStorage).filter((key) => key.startsWith('omnikit:ai-content-reconciliation:v1:')).length
  ))).toBe(0);
});

test('AI Content Studio requires App build inputs, submits once, and keeps returned App references unverified', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-app-browser',
    resultMessage: '### Status\nOmni returned a **fictional App workflow** using `governed_selector` for human verification.',
    actions: [{
      type: 'create_app',
      message: 'Returned a fictional App document reference',
      timestamp: '2026-08-13T12:00:00.000Z',
      documentId: 'fictional-app-doc-1',
    }],
  });

  await page.goto('/content/ai-studio?mode=app');
  await closeWalkthrough(page);
  await expect(page.getByRole('tab', { name: /Apps \(Beta\)/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/Apps must be enabled in Settings > General/)).toBeVisible();
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Content name (required)').fill('Fictional governed activity App');
  await page.getByLabel('Outcome or decision (required)').fill('Create a fictional workbook-backed App for an internal reviewer.');

  const buildButton = page.getByRole('button', { name: 'Start App build' });
  const approval = page.getByRole('checkbox', { name: /approve one controlled-write.*App named/i });
  await expect(approval).toHaveAccessibleName(/scoped to model Fictional governed model/i);
  await expect(approval).not.toHaveAccessibleName(/model-ai-content/i);
  await expect(buildButton).toBeDisabled();
  await expect(approval).toBeDisabled();
  await expect(page.getByText(/Complete before approval: required data and content, layout and interactions, acceptance criteria/)).toBeVisible();
  await page.getByLabel('Required metrics, dimensions, and content').fill('Use governed team, player, play, frame, coordinate, and speed fields with stable aliases and non-empty replay rows.');
  await page.getByLabel('Acceptance criteria').fill('Selectors populate and filter frames; playback renders finite values without undefined, null, or NaN.');
  await page.getByLabel('Layout and interactions').fill('Populate Team, Player, and Play selectors, then wire Play and speed controls to the filtered frame sequence.');
  await expect(approval).toBeEnabled();
  await approval.check();
  await expect(buildButton).toBeEnabled();

  await buildButton.dblclick();
  await expect(page.getByRole('heading', { name: 'App request completed — functional verification required' })).toBeVisible({ timeout: 15_000 });
  expect(state.createCalls).toBe(1);
  expect(state.createPayload?.model_id).toBe('model-ai-content');
  const appPrompt = String(state.createPayload?.prompt);
  expect(appPrompt).toContain('Prompt contract: ai-content-studio/v4');
  expect(appPrompt).toContain('Build exactly one usable workbook-backed Omni App (Beta) named by requestedName');
  expect(appPrompt).toContain('do not create a placeholder App');
  expect(appPrompt).toContain('never undefined, null, or NaN');
  expect(appPrompt).toContain('Do not claim the App editor opened or the App was saved, published, or verified.');
  expect(appPrompt).not.toContain('then open the App editor');
  expect(appPrompt).toContain('Fictional governed activity App');
  await expect(page.getByText(/Agent response alone does not prove/)).toBeVisible();
  await expect(page.getByText('Omni-reported — not independently verified', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Status', exact: true })).toBeVisible();
  await expect(page.locator('strong').filter({ hasText: 'fictional App workflow' })).toBeVisible();
  await expect(page.locator('code').filter({ hasText: 'governed_selector' })).toBeVisible();
  const continueAppInChat = page.getByRole('link', { name: 'Continue in Omni Chat', exact: true });
  await expect(continueAppInChat).toHaveClass(/btn-primary/);
  await expect(continueAppInChat).toHaveAttribute(
    'href',
    'https://ai-content-app-browser.invalid/chat/ai-content-app-browser-conversation-1',
  );
  await expect(page.getByText(/Action review required:/)).toHaveCount(0);
  await expect(page.getByText('Unverified returned document references', { exact: true })).toBeVisible();
  await expect(page.getByText('create_app: fictional-app-doc-1', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'App verification handoff', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Authoritative artifact reconciliation', exact: true })).toHaveCount(0);
  await expect(page.getByText('Manual App functional verification — not API verification', { exact: true })).toBeVisible();
  const appHandoff = page.getByRole('heading', { name: 'App verification handoff', exact: true })
    .locator('xpath=ancestor::section[1]');
  const appChecklist = page.getByRole('group', { name: 'Manual App functional verification checklist' });
  const locatedApp = page.getByRole('checkbox', { name: /I located the exact App.*Fictional governed activity App.*opened its paired workbook/i });
  await expect(appChecklist).toBeVisible();
  await expect(appChecklist).toHaveAttribute('disabled', '');
  await expect(appChecklist.getByRole('checkbox').first()).toBeDisabled();
  await expect(page.getByText('0 of 8 checks marked in this browser session.', { exact: true })).toBeVisible();
  await expect(appHandoff).not.toContainText('Team, Player, and Play');
  await expect(appHandoff).not.toContainText('Play, speed');
  await expect(appHandoff).not.toContainText('Frame, range');
  await locatedApp.check();
  await expect(appChecklist).not.toHaveAttribute('disabled', '');
  const firstManualCheck = appChecklist.getByRole('checkbox').first();
  await expect(firstManualCheck).toBeEnabled();
  await firstManualCheck.check();
  await expect(page.getByText('1 of 8 checks marked in this browser session.', { exact: true })).toBeVisible();
  await locatedApp.uncheck();
  await expect(appChecklist).toHaveAttribute('disabled', '');
  await expect(firstManualCheck).toBeDisabled();
  await expect(page.getByText('0 of 8 checks marked in this browser session.', { exact: true })).toBeVisible();
  expect(state.verifyCalls).toBe(0);
});

test('AI Content Studio keeps a valid App creation report without a document ID locked across reload', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-app-reported-created',
    resultMessage: '### Status\nOmni reports the **fictional App** is built with `governed_selector`, but returned no document identifier.',
    actions: [{
      type: 'create_app',
      message: 'Built the requested fictional App without a document identifier.',
      timestamp: '2026-08-14T18:02:00.000Z',
    }],
  });

  await page.goto('/content/ai-studio?mode=app');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Content name (required)').fill('Fictional reported-created App');
  await page.getByLabel('Outcome or decision (required)').fill('Build one bounded fictional App and return authoritative creation evidence.');
  await page.getByLabel('Required metrics, dimensions, and content').fill('Use governed selector and frame fields with stable aliases and non-empty results.');
  await page.getByLabel('Acceptance criteria').fill('A completed creation without a document identifier remains locked for exact reconciliation.');
  await page.getByLabel('Layout and interactions').fill('Wire bounded selectors, loading, empty, error, and finite playback states.');
  await page.getByRole('checkbox', { name: /approve one controlled-write.*App named/i }).check();

  const startAppBuild = page.getByRole('button', { name: 'Start App build' });
  await startAppBuild.click();

  await expect(page.getByRole('heading', { name: 'App build completed — functional verification required', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Status', exact: true })).toBeVisible();
  await expect(page.locator('strong').filter({ hasText: 'fictional App' })).toBeVisible();
  await expect(page.locator('code').filter({ hasText: 'governed_selector' })).toBeVisible();
  await expect(page.getByText('Artifact verification required before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-content-reconciliation-job-id')).toHaveText('ai-content-app-reported-created-job-1');
  const continueAppInChat = page.getByRole('link', { name: 'Continue in Omni Chat', exact: true });
  await expect(continueAppInChat).toHaveClass(/btn-primary/);
  await expect(continueAppInChat).toHaveAttribute(
    'href',
    'https://ai-content-app-reported-created.invalid/chat/ai-content-app-reported-created-conversation-1',
  );
  await expect(startAppBuild).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);

  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) => candidate.startsWith('omnikit:ai-content-reconciliation:v1:'));
    if (!key) return '';
    return String((JSON.parse(window.sessionStorage.getItem(key) || '{}') as { reasonCode?: unknown }).reasonCode || '');
  })).toBe('artifact-unverified');

  const lifecycleCountBeforeReload = state.lifecycleRequests.length;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'App build completed — functional verification required', exact: true })).toBeVisible();
  await expect(page.getByText('Artifact verification required before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start App build' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests).toHaveLength(lifecycleCountBeforeReload);
});

test('AI Content Studio keeps unknown and server-truncated App creation evidence locked across reload', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-app-creation-status-unverified',
    resultMessage: 'The App job completed with unknown and server-truncated action evidence.',
    actions: [{
      type: 'delete_unknown_content',
      message: 'Deleted and replaced an unknown content artifact.',
      timestamp: '2026-08-14T18:03:00.000Z',
    }],
    resultExtraFields: {
      projectionIssues: ['ACTION_DROPPED', 'ACTIONS_TRUNCATED'],
    },
  });

  await page.goto('/content/ai-studio?mode=app');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Content name (required)').fill('Fictional uncertain creation App');
  await page.getByLabel('Outcome or decision (required)').fill('Build one bounded App only when action evidence can be reconciled.');
  await page.getByLabel('Required metrics, dimensions, and content').fill('Use governed team, player, play, frame, coordinate, and speed fields with stable aliases.');
  await page.getByLabel('Acceptance criteria').fill('Incomplete or mutating action evidence blocks another build until reconciliation.');
  await page.getByLabel('Layout and interactions').fill('Wire bounded selectors and explicit loading, empty, and error states.');
  await page.getByRole('checkbox', { name: /approve one controlled-write.*App named/i }).check();

  const startAppBuild = page.getByRole('button', { name: 'Start App build' });
  await startAppBuild.click();

  await expect(page.getByRole('heading', { name: 'App job completed — creation status unverified', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Action review required:/)).toBeVisible();
  await expect(page.getByText(/UNRECOGNIZED_ACTION_TYPE: delete_unknown_content/)).toBeVisible();
  await expect(page.getByText(/POTENTIAL_MUTATION: delete_unknown_content/)).toBeVisible();
  await expect(page.getByText('ACTION_DROPPED', { exact: true })).toBeVisible();
  await expect(page.getByText('ACTIONS_TRUNCATED', { exact: true })).toBeVisible();
  await expect(page.getByText('Unverified returned document references', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Creation status requires reconciliation before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-content-reconciliation-job-id')).toHaveText('ai-content-app-creation-status-unverified-job-1');
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  await expect(startAppBuild).toBeDisabled();
  expect(state.createCalls).toBe(1);
  expect(state.verifyCalls).toBe(0);
  expect(state.verifiedDocumentIds).toEqual([]);

  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) => candidate.startsWith('omnikit:ai-content-reconciliation:v1:'));
    if (!key) return '';
    return String((JSON.parse(window.sessionStorage.getItem(key) || '{}') as { reasonCode?: unknown }).reasonCode || '');
  })).toBe('creation-status-unverified');

  const lifecycleCountBeforeReload = state.lifecycleRequests.length;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'App job completed — creation status unverified', exact: true })).toBeVisible();
  await expect(page.getByText('Creation status requires reconciliation before another AI job', { exact: true })).toBeVisible();
  await expect(page.getByText(/ACTION_EVIDENCE_REQUIRES_REVIEW:/)).toBeVisible();
  await expect(page.getByText('Unverified returned document references', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start App build' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry result read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni', exact: true })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests).toHaveLength(lifecycleCountBeforeReload);
});

test('AI Content Studio presents an App preflight stop as a completed no-artifact outcome', async ({ page, request }) => {
  const narrative = [
    'Verification stopped because the governed model does not expose the required effective-date and ownership fields.',
    'No App, workbook, document, or placeholder was created, saved, published, or verified.',
    'Inspect this completed outcome in Omni Chat and add the missing governed fields before starting a new build.',
  ].join('\n');
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-app-preflight-stop',
    resultMessage: narrative,
    resultField: 'resultSummary',
    actions: [],
  });

  await page.goto('/content/ai-studio?mode=app');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Content name (required)').fill('Fictional governed preflight App');
  await page.getByLabel('Outcome or decision (required)').fill('Assess whether one bounded fictional App can be created from governed evidence.');
  await page.getByLabel('Required metrics, dimensions, and content').fill('Require governed effective-date and ownership fields before creating any App or placeholder.');
  await page.getByLabel('Acceptance criteria').fill('Stop safely without creating an artifact when the required governed fields are unavailable.');
  await page.getByLabel('Layout and interactions').fill('If preflight passes, wire bounded selectors and explicit loading, empty, and error states.');
  await page.getByRole('checkbox', { name: /approve one controlled-write.*App named/i }).check();
  await page.getByRole('button', { name: 'Start App build' }).dblclick();

  await expect(page.getByRole('heading', { name: 'App request completed — no artifact reference returned', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(narrative.split('\n')[0], { exact: true })).toBeVisible();
  await expect(page.getByText(narrative.split('\n')[1], { exact: true })).toBeVisible();
  await expect(page.getByText(narrative.split('\n')[2], { exact: true })).toBeVisible();
  await expect(page.getByText('Omni returned no artifact reference.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Read the outcome and Omni chat before changing the governed scope or submitting another request/i)).toBeVisible();

  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);
  await expect(page.getByRole('button', { name: 'Retry result read' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job in Omni' })).toHaveCount(0);
  await expect(page.getByText(/Reconciliation required before another AI job/i)).toHaveCount(0);
  await expect(page.getByText(/MISSING_DOCUMENT_REFERENCE/i)).toHaveCount(0);
  await expect(page.getByText(/Action review required:/i)).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Manual App functional verification checklist' })).toHaveCount(0);
});

test('AI Content Studio preserves a completed App hold and rereads only the existing result', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-app-result-recovery',
    resultMessage: 'Omni returned the existing fictional App after a result-only recovery.',
    resultFailuresBeforeSuccess: 1,
    resultFailureStatus: 400,
    actions: [{
      type: 'create_app',
      message: 'Returned the existing fictional App reference',
      timestamp: '2026-08-13T12:00:00.000Z',
      documentId: 'fictional-recovered-app-1',
    }],
  });

  await page.goto('/content/ai-studio?mode=app');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Content name (required)').fill('Fictional recoverable App');
  await page.getByLabel('Outcome or decision (required)').fill('Build one bounded fictional App for result recovery testing.');
  await page.getByLabel('Required metrics, dimensions, and content').fill('Use governed selector and frame fields with stable aliases and non-empty results.');
  await page.getByLabel('Acceptance criteria').fill('Selectors populate, filters change frames, and no undefined, null, or NaN values render.');
  await page.getByLabel('Layout and interactions').fill('Wire selectors, playback, speed, loading, empty, and error states to real query results.');
  await page.getByRole('checkbox', { name: /approve one controlled-write.*App named/i }).check();
  await page.getByRole('button', { name: 'Start App build' }).click();

  await expect(page.getByText(/Omni confirmed this App job as COMPLETE/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ai-content-reconciliation-job-id')).toHaveText('ai-content-app-result-recovery-job-1');
  await expect(page.getByRole('button', { name: 'Copy job ID' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry result read' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel job in Omni' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start App build' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Continue in Omni Chat', exact: true })).toHaveAttribute(
    'href',
    'https://ai-content-app-result-recovery.invalid/chat/ai-content-app-result-recovery-conversation-1',
  );
  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);

  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) => candidate.startsWith('omnikit:ai-content-reconciliation:v1:'));
    return key ? window.sessionStorage.getItem(key) : null;
  })).not.toBeNull();
  const storedHoldMetadata = await page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) => candidate.startsWith('omnikit:ai-content-reconciliation:v1:'));
    return key ? window.sessionStorage.getItem(key) : null;
  });
  expect(storedHoldMetadata).not.toBeNull();
  expect(Object.keys(JSON.parse(storedHoldMetadata || '{}')).sort()).toEqual([
    'chatUrl',
    'instanceId',
    'jobId',
    'mode',
    'reasonCode',
    'startedAt',
    'terminalState',
    'version',
  ]);
  expect(storedHoldMetadata).not.toContain('fixture-key-not-real');
  expect(storedHoldMetadata).not.toContain('Fictional recoverable App');
  const lifecycleCountBeforeReload = state.lifecycleRequests.length;
  await page.reload();
  await expect(page.getByText(/Omni confirmed this App job as COMPLETE/)).toBeVisible();
  await expect(page.getByTestId('ai-content-reconciliation-job-id')).toHaveText('ai-content-app-result-recovery-job-1');
  await expect(page.getByRole('button', { name: 'Cancel job in Omni' })).toHaveCount(0);
  expect(state.createCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests).toHaveLength(lifecycleCountBeforeReload);

  const lifecycleCountBeforeRecovery = state.lifecycleRequests.length;
  await page.getByRole('button', { name: 'Retry result read' }).click();
  await expect(page.getByRole('heading', { name: 'App request completed — functional verification required' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('create_app: fictional-recovered-app-1', { exact: true })).toBeVisible();
  // Poll: the click above may still be in flight. A bare expect here races the
  // request and fails under CPU contention (reproduced locally, and the cause of
  // the CI failure at this assertion).
  await expect.poll(() => state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(2);
  expect(state.cancelCalls).toBe(0);
  expect(state.lifecycleRequests.slice(lifecycleCountBeforeRecovery).map((requestEntry) => requestEntry.action)).toEqual([
    'get-content-studio-job-result',
  ]);
  await expect.poll(() => page.evaluate(() => (
    Object.keys(window.sessionStorage).filter((key) => key.startsWith('omnikit:ai-content-reconciliation:v1:')).length
  ))).toBe(0);
});

test('AI Content Studio keeps COMPLETE locked when the existing App result fails local validation', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-app-local-validation',
    resultMessage: 'null',
    actions: [],
  });

  await page.goto('/content/ai-studio?mode=app');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Content name (required)').fill('Fictional locally invalid App');
  await page.getByLabel('Outcome or decision (required)').fill('Build one fictional App with a deliberately invalid result fixture.');
  await page.getByLabel('Required metrics, dimensions, and content').fill('Use governed selector and frame fields with stable aliases and non-empty results.');
  await page.getByLabel('Acceptance criteria').fill('Selectors populate, filters change frames, and no undefined, null, or NaN values render.');
  await page.getByLabel('Layout and interactions').fill('Wire selectors, playback, speed, loading, empty, and error states to query results.');
  await page.getByRole('checkbox', { name: /approve one controlled-write.*App named/i }).check();
  await page.getByRole('button', { name: 'Start App build' }).click();

  await expect(page.getByText(/Its separate structured result is unavailable in OmniKit/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Omni confirmed this App job as COMPLETE/)).toBeVisible();
  await expect(page.getByTestId('ai-content-reconciliation-job-id')).toHaveText('ai-content-app-local-validation-job-1');
  await expect(page.getByRole('button', { name: 'Retry result read' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel job in Omni' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start App build' })).toBeDisabled();
  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(1);
  expect(state.cancelCalls).toBe(0);

  const storedReasonCode = await page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) => candidate.startsWith('omnikit:ai-content-reconciliation:v1:'));
    if (!key) return '';
    return String((JSON.parse(window.sessionStorage.getItem(key) || '{}') as { reasonCode?: unknown }).reasonCode || '');
  });
  expect(storedReasonCode).toBe('completed-result-validation');

  await page.getByRole('button', { name: 'Retry result read' }).click();
  await expect(page.getByText(/Its separate structured result is unavailable in OmniKit/).first()).toBeVisible();
  // Poll: the click above may still be in flight. A bare expect here races the
  // request and fails under CPU contention (reproduced locally, and the cause of
  // the CI failure at this assertion).
  await expect.poll(() => state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(2);
  expect(state.cancelCalls).toBe(0);
});

test('AI Content Studio preserves COMPLETE without cancellation when the instance changes during the result read', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-app-terminal-switch',
    resultMessage: 'This deliberately held fictional App result must not be applied after an instance switch.',
    actions: [{
      type: 'create_app',
      message: 'Returned a deliberately held fictional App reference',
      timestamp: '2026-08-13T12:00:00.000Z',
      documentId: 'fictional-held-app-1',
    }],
    holdResultRead: true,
    includeAlternateInstance: true,
  });
  const [primary, alternate] = state.instances;

  try {
    await page.goto('/content/ai-studio?mode=app');
    await closeWalkthrough(page);
    await page.getByLabel('Base model').selectOption('model-ai-content');
    await page.getByLabel('Content name (required)').fill('Fictional terminal-switch App');
    await page.getByLabel('Outcome or decision (required)').fill('Build one fictional App while the result read is deliberately held.');
    await page.getByLabel('Required metrics, dimensions, and content').fill('Use governed selector and frame fields with stable aliases and non-empty results.');
    await page.getByLabel('Acceptance criteria').fill('Selectors populate, filters change frames, and no undefined, null, or NaN values render.');
    await page.getByLabel('Layout and interactions').fill('Wire selectors, playback, speed, loading, empty, and error states to query results.');
    await page.getByRole('checkbox', { name: /approve one controlled-write.*App named/i }).check();
    await page.getByRole('button', { name: 'Start App build' }).click();

    await expect.poll(() => state.resultCalls).toBe(1);
    await expect.poll(() => page.evaluate(() => (
      Object.keys(window.sessionStorage).filter((key) => key.startsWith('omnikit:ai-content-reconciliation:v1:')).length
    ))).toBe(1);
    expect(state.createCalls).toBe(1);
    expect(state.cancelCalls).toBe(0);

    const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
    await sidebar.getByRole('button', {
      name: `Switch Omni instance. Current: ${primary.label}. Connected.`,
      exact: true,
    }).click();
    await sidebar.getByRole('group', { name: 'Saved Omni instances' })
      .getByRole('button', { name: new RegExp(alternate.label) })
      .click();
    await expect(sidebar.getByRole('button', {
      name: `Switch Omni instance. Current: ${alternate.label}. Connected.`,
      exact: true,
    })).toBeVisible();
    expect(state.cancelCalls).toBe(0);

    state.releaseResultRead();
    await sidebar.getByRole('button', {
      name: `Switch Omni instance. Current: ${alternate.label}. Connected.`,
      exact: true,
    }).click();
    await sidebar.getByRole('group', { name: 'Saved Omni instances' })
      .getByRole('button', { name: new RegExp(primary.label) })
      .click();

    await expect(page.getByText(/Omni confirmed this App job as COMPLETE/)).toBeVisible();
    await expect(page.getByTestId('ai-content-reconciliation-job-id')).toHaveText('ai-content-app-terminal-switch-job-1');
    await expect(page.getByRole('button', { name: 'Retry result read' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel job in Omni' })).toHaveCount(0);
    await expect(page.getByText('This deliberately held fictional App result must not be applied after an instance switch.', { exact: true })).toHaveCount(0);
    expect(state.createCalls).toBe(1);
    expect(state.resultCalls).toBe(1);
    expect(state.cancelCalls).toBe(0);
  } finally {
    state.releaseResultRead();
  }
});

test('AI Content Studio cancels an in-flight job on instance scope change and ignores any stale result', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-scope-browser',
    resultMessage: '## Report\nThis stale result must never render.\n## Evidence limits\nIt belongs to the prior fictional instance.\n## Follow-ups\nDo not use it.',
    actions: [{
      type: 'summarize',
      message: 'A stale fictional summary',
      timestamp: '2026-08-13T12:00:00.000Z',
    }],
    holdJobOpen: true,
    includeAlternateInstance: true,
  });
  const [primary, alternate] = state.instances;

  await page.goto('/content/ai-studio?mode=report');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Outcome or decision (required)').fill('Create a fictional bounded report for cancellation testing.');
  await page.getByRole('checkbox', { name: /approve one no-write narrative request/i }).check();
  await page.getByRole('button', { name: 'Generate report' }).click();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect.poll(() => state.createCalls).toBe(1);
  await expect.poll(() => state.lifecycleRequests.some((request) => request.action === 'get-job')).toBe(true);

  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  await sidebar.getByRole('button', {
    name: `Switch Omni instance. Current: ${primary.label}. Connected.`,
    exact: true,
  }).click();
  await sidebar.getByRole('group', { name: 'Saved Omni instances' })
    .getByRole('button', { name: new RegExp(alternate.label) })
    .click();

  await expect(sidebar.getByRole('button', {
    name: `Switch Omni instance. Current: ${alternate.label}. Connected.`,
    exact: true,
  })).toBeVisible();
  await expect.poll(() => state.cancelCalls).toBe(1);
  await expect(page.getByText('The prior instance job was cancelled.', { exact: true })).toBeVisible();
  expect(state.createCalls).toBe(1);
  expect(state.resultCalls).toBe(0);
  expect(state.lifecycleRequests).toEqual(expect.arrayContaining([
    { action: 'create-job', responseContract: 'ai-content-studio-v1' },
    { action: 'get-job', responseContract: 'ai-content-studio-v1' },
    { action: 'cancel-job', responseContract: 'ai-content-studio-v1' },
  ]));
  await expect(page.getByText('This stale result must never render.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Narrative report returned — verify findings' })).toHaveCount(0);
});

test('AI Content Studio sends exactly one confirmed cancellation for a manual cancel', async ({ page, request }) => {
  const state = await installMockAIContentStudio(page, request, {
    slug: 'ai-content-manual-cancel-browser',
    resultMessage: '## Report\nUnused.\n## Evidence limits\nUnused.\n## Follow-ups\nUnused.',
    actions: [],
    holdJobOpen: true,
  });

  await page.goto('/content/ai-studio?mode=report');
  await closeWalkthrough(page);
  await page.getByLabel('Base model').selectOption('model-ai-content');
  await page.getByLabel('Outcome or decision (required)').fill('Create a bounded fictional report for manual cancellation testing.');
  await page.getByRole('checkbox', { name: /approve one no-write narrative request/i }).check();
  await page.getByRole('button', { name: 'Generate report' }).click();
  await expect.poll(() => state.createCalls).toBe(1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('Cancellation confirmed by Omni.', { exact: true })).toBeVisible();
  // Poll: the click above may still be in flight. A bare expect here races the
  // request and fails under CPU contention (reproduced locally, and the cause of
  // the CI failure at this assertion).
  await expect.poll(() => state.cancelCalls).toBe(1);
  expect(state.resultCalls).toBe(0);
});

test('mobile navigation supports keyboard toggling, focus containment, Escape, and route-close', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Your Omni command center.', exact: true })).toBeVisible();

  const toggle = page.locator('button[aria-controls="mobile-navigation-drawer"]');
  const drawer = page.locator('#mobile-navigation-drawer');
  const focusable = drawer.locator('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');

  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await expect(drawer).toHaveAttribute('aria-hidden', 'false');
  await expect(focusable.first()).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(focusable.last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(focusable.first()).toBeFocused();

  await toggle.focus();
  await toggle.press('Enter');
  await expect(drawer).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();

  await toggle.press('Space');
  await expect(drawer).toBeVisible();
  await expect(focusable.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  await expect(toggle).toBeFocused();

  await toggle.press('Enter');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Administration', exact: true }).click();
  await drawer.getByRole('link', { name: 'Fleet & Readiness', exact: true }).click();
  await expect(page).toHaveURL('/admin/fleet/instances');
  await expect(page.getByRole('heading', { name: 'Instance Manager', exact: true })).toBeVisible();
  await expect(drawer).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('Omni instance switcher is truthful, keyboard-safe, and keeps credentials server-side', async ({ page, request }) => {
  await unlockVault(request);
  const primaryKey = 'omni-primary-switcher-key-not-real';
  const secondaryKey = 'omni-secondary-switcher-key-not-real';
  const primary = await addSwitcherInstance(request, {
    label: 'Primary UI instance',
    baseUrl: 'https://primary-switcher.invalid',
    apiKey: primaryKey,
  });
  const secondary = await addSwitcherInstance(request, {
    label: 'Secondary UI instance',
    baseUrl: 'https://secondary-switcher.invalid',
    apiKey: secondaryKey,
  });
  const validatedAt = new Date().toISOString();
  primary.lastValidatedAt = validatedAt;
  secondary.lastValidatedAt = validatedAt;
  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instances: [primary, secondary] }),
    });
  });
  await page.addInitScript((instance) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify({
      baseUrl: instance.baseUrl,
      apiKey: `__omnikit_vault_instance__:${instance.id}`,
      status: 'success',
      errorMessage: '',
      connectionMode: 'vault',
      instanceId: instance.id,
      instanceLabel: instance.label,
      apiKeyMasked: instance.apiKeyMasked,
    }));
  }, primary);

  const connectRequests: string[] = [];
  let releaseConnect!: () => void;
  const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
  await page.route('**/api/instances/*/connect', async (route) => {
    const instanceId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || '');
    connectRequests.push(instanceId);
    const instance = instanceId === primary.id ? primary : instanceId === secondary.id ? secondary : null;
    if (!instance) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Instance not found.' }) });
      return;
    }
    await connectGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instance: { ...instance, lastValidatedAt: new Date().toISOString() },
        connection: {
          baseUrl: instance.baseUrl,
          apiKey: `__omnikit_vault_instance__:${instance.id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: instance.id,
          instanceLabel: instance.label,
          apiKeyMasked: instance.apiKeyMasked,
        },
      }),
    });
  });
  await page.goto('/models');
  await closeWalkthrough(page);
  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  const trigger = sidebar.getByRole('button', {
    name: 'Switch Omni instance. Current: Primary UI instance. Connected.',
    exact: true,
  });
  const options = sidebar.getByRole('region', { name: 'Omni instance options' });

  await expect(sidebar.getByText('Connected', { exact: true })).toBeVisible();
  await expect(trigger).toContainText('primary-switcher.invalid');
  await expect(trigger).not.toContainText(primary.apiKeyMasked);
  await trigger.focus();
  await trigger.press('Enter');
  await expect(options).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar.getByRole('group', { name: 'Saved Omni instances' })).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .include('aside[aria-label="Main navigation"]')
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(options).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();

  await trigger.press('Space');
  await expect(options).toBeVisible();
  await page.getByRole('heading', { name: 'Model & Topic Health', exact: true }).click();
  await expect(options).toBeHidden();

  await trigger.click();
  const savedInstances = sidebar.getByRole('group', { name: 'Saved Omni instances' });
  const primaryOption = savedInstances.getByRole('button', { name: /Primary UI instance/ });
  const secondaryOption = savedInstances.getByRole('button', { name: /Secondary UI instance/ });
  await secondaryOption.click();
  await expect.poll(() => connectRequests).toEqual([secondary.id]);
  await expect(secondaryOption).toBeDisabled();
  await expect(primaryOption).toBeEnabled();
  await expect(secondaryOption.locator('svg.animate-spin')).toHaveCount(1);
  await expect(primaryOption.locator('svg.animate-spin')).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-busy', 'true');

  // The in-flight target remains disabled to prevent a duplicate health check;
  // other targets remain available so a newer human choice can supersede it.
  await secondaryOption.evaluate((button: HTMLButtonElement) => button.click());
  expect(connectRequests).toEqual([secondary.id]);

  releaseConnect();
  await expect(sidebar.getByRole('button', {
    name: 'Switch Omni instance. Current: Secondary UI instance. Connected.',
    exact: true,
  })).toBeFocused();
  await expect(options).toBeHidden();
  expect(connectRequests).toEqual([secondary.id]);

  const browserConnection = await page.evaluate(() => window.sessionStorage.getItem('omnikit:activeConnection:v1') || '');
  expect(browserConnection).toContain(`__omnikit_vault_instance__:${secondary.id}`);
  expect(browserConnection).not.toContain(primaryKey);
  expect(browserConnection).not.toContain(secondaryKey);
});

test('overlapping Omni instance switches keep the latest human intent when an older response finishes last', async ({ page, request }) => {
  await unlockVault(request);
  const primary = await addSwitcherInstance(request, {
    label: 'Current race instance',
    baseUrl: 'https://current-race.invalid',
    apiKey: 'omni-current-race-key-not-real',
  });
  const olderTarget = await addSwitcherInstance(request, {
    label: 'Older race target',
    baseUrl: 'https://older-race.invalid',
    apiKey: 'omni-older-race-key-not-real',
  });
  const latestTarget = await addSwitcherInstance(request, {
    label: 'Latest race target',
    baseUrl: 'https://latest-race.invalid',
    apiKey: 'omni-latest-race-key-not-real',
  });
  const validatedAt = new Date().toISOString();
  primary.lastValidatedAt = validatedAt;
  olderTarget.lastValidatedAt = validatedAt;
  latestTarget.lastValidatedAt = validatedAt;
  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instances: [primary, olderTarget, latestTarget] }),
    });
  });
  await page.addInitScript((instance) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify({
      baseUrl: instance.baseUrl,
      apiKey: `__omnikit_vault_instance__:${instance.id}`,
      status: 'success',
      errorMessage: '',
      connectionMode: 'vault',
      instanceId: instance.id,
      instanceLabel: instance.label,
      apiKeyMasked: instance.apiKeyMasked,
    }));
  }, primary);

  const connectRequests: string[] = [];
  let releaseOlder!: () => void;
  const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
  await page.route('**/api/instances/*/connect', async (route) => {
    const instanceId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || '');
    connectRequests.push(instanceId);
    const instance = instanceId === olderTarget.id
      ? olderTarget
      : instanceId === latestTarget.id
        ? latestTarget
        : null;
    if (!instance) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Instance not found.' }) });
      return;
    }
    if (instanceId === olderTarget.id) await olderGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instance: { ...instance, lastValidatedAt: new Date().toISOString() },
        connection: {
          baseUrl: instance.baseUrl,
          apiKey: `__omnikit_vault_instance__:${instance.id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: instance.id,
          instanceLabel: instance.label,
          apiKeyMasked: instance.apiKeyMasked,
        },
      }),
    }).catch(() => undefined);
  });

  await page.goto('/models');
  await closeWalkthrough(page);
  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  await sidebar.getByRole('button', { name: /Switch Omni instance.*Current race instance/ }).click();
  const savedInstances = sidebar.getByRole('group', { name: 'Saved Omni instances' });
  const olderOption = savedInstances.getByRole('button', { name: /Older race target/ });
  const latestOption = savedInstances.getByRole('button', { name: /Latest race target/ });

  await olderOption.click();
  await expect.poll(() => connectRequests).toEqual([olderTarget.id]);
  await expect(olderOption).toBeDisabled();
  await expect(latestOption).toBeEnabled();
  await latestOption.click();
  await expect.poll(() => connectRequests).toEqual([olderTarget.id, latestTarget.id]);
  await expect(sidebar.getByRole('button', {
    name: 'Switch Omni instance. Current: Latest race target. Connected.',
    exact: true,
  })).toBeVisible();

  releaseOlder();
  await page.waitForTimeout(150);
  await expect(sidebar.getByRole('button', {
    name: 'Switch Omni instance. Current: Latest race target. Connected.',
    exact: true,
  })).toBeVisible();
  await expect(sidebar.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const raw = window.sessionStorage.getItem('omnikit:activeConnection:v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { instanceId?: string; status?: string };
    return { instanceId: parsed.instanceId, status: parsed.status };
  })).toEqual({ instanceId: latestTarget.id, status: 'success' });
});

test('Omni instance switcher surfaces one delayed failure and retries only after an explicit second action', async ({ page, request }) => {
  await unlockVault(request);
  const primary = await addSwitcherInstance(request, {
    label: 'Primary retry instance',
    baseUrl: 'https://primary-retry.invalid',
    apiKey: 'omni-primary-retry-key-not-real',
  });
  const secondary = await addSwitcherInstance(request, {
    label: 'Secondary retry instance',
    baseUrl: 'https://secondary-retry.invalid',
    apiKey: 'omni-secondary-retry-key-not-real',
  });
  const validatedAt = new Date().toISOString();
  primary.lastValidatedAt = validatedAt;
  secondary.lastValidatedAt = validatedAt;
  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instances: [primary, secondary] }),
    });
  });
  await page.addInitScript((instance) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify({
      baseUrl: instance.baseUrl,
      apiKey: `__omnikit_vault_instance__:${instance.id}`,
      status: 'success',
      errorMessage: '',
      connectionMode: 'vault',
      instanceId: instance.id,
      instanceLabel: instance.label,
      apiKeyMasked: instance.apiKeyMasked,
    }));
  }, primary);

  const connectRequests: string[] = [];
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  await page.route('**/api/instances/*/connect', async (route) => {
    const instanceId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || '');
    connectRequests.push(instanceId);
    if (connectRequests.length === 1) {
      await failureGate;
      await route.fulfill({
        status: 504,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The Omni connection check timed out.' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instance: { ...secondary, lastValidatedAt: new Date().toISOString() },
        connection: {
          baseUrl: secondary.baseUrl,
          apiKey: `__omnikit_vault_instance__:${secondary.id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: secondary.id,
          instanceLabel: secondary.label,
          apiKeyMasked: secondary.apiKeyMasked,
        },
      }),
    });
  });

  const inventoryCredentialRefs: string[] = [];
  await page.route('**/api/list-models', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    inventoryCredentialRefs.push(String(body.api_key || ''));
    const modelKind = String(body.model_kind || '');
    const models = modelKind === 'SHARED'
      ? [{ id: 'retry-model', name: 'Fictional retry model', kind: 'SHARED' }]
      : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models,
        complete: true,
        loadedResults: models.length,
        totalResults: models.length,
        pagesFetched: 1,
        pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: models.length },
      }),
    });
  });

  await page.goto('/content/ai-studio?mode=app');
  await closeWalkthrough(page);
  await expect(page.getByLabel('Base model')).toContainText('Fictional retry model');
  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  await sidebar.getByRole('button', { name: /Switch Omni instance.*Primary retry instance/ }).click();
  const secondaryOption = sidebar.getByRole('group', { name: 'Saved Omni instances' })
    .getByRole('button', { name: /Secondary retry instance/ });
  await secondaryOption.click();
  await expect.poll(() => connectRequests).toEqual([secondary.id]);
  await expect(secondaryOption.locator('svg.animate-spin')).toHaveCount(1);
  releaseFailure();

  await expect(sidebar.getByRole('alert')).toHaveText('The Omni connection check timed out.');
  await expect(sidebar.getByRole('button', {
    name: 'Switch Omni instance. Current: Primary retry instance. Connected.',
    exact: true,
  })).toBeVisible();
  await expect(secondaryOption).not.toContainText('Active');
  await expect(page.getByLabel('Base model')).toContainText('Fictional retry model');
  await expect.poll(() => page.evaluate(() => {
    const raw = window.sessionStorage.getItem('omnikit:activeConnection:v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { instanceId?: string; status?: string };
    return { instanceId: parsed.instanceId, status: parsed.status };
  })).toEqual({ instanceId: primary.id, status: 'success' });
  expect(inventoryCredentialRefs).not.toContain(`__omnikit_vault_instance__:${secondary.id}`);
  expect(connectRequests).toEqual([secondary.id]);

  await secondaryOption.click();
  await expect(sidebar.getByRole('button', {
    name: 'Switch Omni instance. Current: Secondary retry instance. Connected.',
    exact: true,
  })).toBeVisible();
  await expect(page.getByLabel('Base model')).toContainText('Fictional retry model');
  expect(inventoryCredentialRefs).toContain(`__omnikit_vault_instance__:${secondary.id}`);
  expect(connectRequests).toEqual([secondary.id, secondary.id]);
});

test('same-instance reconnect failure remains unverified and does not start AI model inventory', async ({ page, request }) => {
  await unlockVault(request);
  const instance = await addSwitcherInstance(request, {
    label: 'Unverified retry instance',
    baseUrl: 'https://same-retry.invalid',
    apiKey: 'omni-same-retry-key-not-real',
  });
  instance.lastValidatedAt = new Date().toISOString();
  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instances: [instance] }),
    });
  });
  await page.addInitScript((saved) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify({
      baseUrl: saved.baseUrl,
      apiKey: `__omnikit_vault_instance__:${saved.id}`,
      status: 'untested',
      errorMessage: '',
      connectionMode: 'vault',
      instanceId: saved.id,
      instanceLabel: saved.label,
      apiKeyMasked: saved.apiKeyMasked,
    }));
  }, instance);

  let connectCalls = 0;
  let inventoryCalls = 0;
  await page.route('**/api/instances/*/connect', async (route) => {
    connectCalls += 1;
    await route.fulfill({
      status: 504,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Omni did not respond within 8 seconds.' }),
    });
  });
  await page.route('**/api/list-models', async (route) => {
    inventoryCalls += 1;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'This inventory request must not run.' }),
    });
  });

  await page.goto('/content/ai-studio?mode=app');
  await closeWalkthrough(page);
  await expect(page.getByText('Choose an instance to unlock AI Content Studio')).toBeVisible();

  // An untested session with a validated saved instance is auto-resumed on load,
  // which is deliberate (see the "Could not resume saved instance" path in
  // useVaultSession). Let that attempt settle first so the assertions below
  // measure the manual retry rather than racing the resume.
  await expect.poll(() => connectCalls).toBe(1);
  const connectCallsAfterResume = connectCalls;

  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  await sidebar.getByRole('button', {
    name: 'Switch Omni instance. Current: Unverified retry instance. Vault unlocked.',
    exact: true,
  }).click();
  await sidebar.getByRole('group', { name: 'Saved Omni instances' })
    .getByRole('button', { name: /Unverified retry instance/ })
    .click();

  await expect(sidebar.getByRole('alert')).toHaveText('Omni did not respond within 8 seconds.');
  await expect(page.getByText('Choose an instance to unlock AI Content Studio')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const raw = window.sessionStorage.getItem('omnikit:activeConnection:v1');
    return raw ? (JSON.parse(raw) as { status?: string }).status : null;
  })).toBe('error');
  // Exactly one further attempt: the manual reconnect retries, and a failed
  // retry must not cascade into more connect attempts.
  expect(connectCalls).toBe(connectCallsAfterResume + 1);
  expect(inventoryCalls).toBe(0);
});

test('instance disclosure preserves entered form state when collapsed and reopened', async ({ page, request }) => {
  await unlockVault(request);
  await page.goto('/admin/fleet/instances');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Add instance', exact: true })).toBeVisible();

  const disclosure = page.locator('details').filter({ hasText: 'Optional defaults, filters, and actions' });
  const summary = disclosure.locator('summary');
  const modelId = page.getByPlaceholder('Paste model ID manually');
  const folderPath = page.getByPlaceholder('Default folder path, e.g. Shared/Migrations');
  const appLabel = page.getByLabel('Legacy App label fallback (optional)');

  await summary.click();
  await expect(disclosure).toHaveJSProperty('open', true);
  await modelId.fill('model-ui-hardening-fixture');
  await folderPath.fill('Shared/UI Hardening Fixture');
  await appLabel.fill('ui-hardening-fixture');

  await summary.click();
  await expect(disclosure).toHaveJSProperty('open', false);
  await expect(modelId).toBeHidden();
  await summary.click();
  await expect(disclosure).toHaveJSProperty('open', true);

  await expect(modelId).toHaveValue('model-ui-hardening-fixture');
  await expect(folderPath).toHaveValue('Shared/UI Hardening Fixture');
  await expect(appLabel).toHaveValue('ui-hardening-fixture');
});

test('locked Home uses the inline Omni wordmark and loads every required visible image', async ({ page }) => {
  const imageFailures: string[] = [];
  const legacyLogoRequests: string[] = [];
  const externalFontRequests: string[] = [];

  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/omni-logo.webp') legacyLogoRequests.push(request.url());
    if (request.resourceType() === 'font' && new URL(request.url()).origin !== new URL(page.url()).origin) {
      externalFontRequests.push(request.url());
    }
  });
  page.on('requestfailed', (request) => {
    if (request.resourceType() === 'image') {
      imageFailures.push(`${request.url()}: ${request.failure()?.errorText || 'request failed'}`);
    }
  });
  page.on('response', (response) => {
    if (response.request().resourceType() === 'image' && response.status() >= 400) {
      imageFailures.push(`${response.url()}: HTTP ${response.status()}`);
    }
  });

  await page.goto('/');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Your Omni command center.', exact: true })).toBeVisible();

  const homeLogo = page.getByRole('img', { name: 'Omni Kit, Home', exact: true });
  const wordmark = homeLogo.locator('svg');
  await expect(homeLogo).toBeVisible();
  await expect(wordmark).toHaveAttribute('viewBox', '0 0 88 36');
  await expect(homeLogo.locator('img')).toHaveCount(0);

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([
      document.fonts.load('400 24px "Cal Sans"'),
      document.fonts.load('400 14px "IBM Plex Sans"'),
      document.fonts.load('500 12px "IBM Plex Mono"'),
    ]);
    return {
      heading: getComputedStyle(document.querySelector('h1')!).fontFamily,
      body: getComputedStyle(document.body).fontFamily,
      calSansReady: document.fonts.check('400 24px "Cal Sans"'),
      plexSansReady: document.fonts.check('400 14px "IBM Plex Sans"'),
      plexMonoReady: document.fonts.check('500 12px "IBM Plex Mono"'),
    };
  });
  expect(fonts.heading).toContain('Cal Sans');
  expect(fonts.body).toContain('IBM Plex Sans');
  expect(fonts.calSansReady).toBe(true);
  expect(fonts.plexSansReady).toBe(true);
  expect(fonts.plexMonoReady).toBe(true);

  const visibleHomeImages = page.locator('#main-content img:visible');
  await expect.poll(() => visibleHomeImages.count()).toBeGreaterThan(0);
  await expect.poll(() => visibleHomeImages.evaluateAll((images) => images.every((image) => {
    const element = image as HTMLImageElement;
    return element.complete && element.naturalWidth > 0;
  }))).toBe(true);
  await page.waitForLoadState('networkidle');

  expect(legacyLogoRequests).toEqual([]);
  expect(externalFontRequests).toEqual([]);
  expect(imageFailures).toEqual([]);
});
