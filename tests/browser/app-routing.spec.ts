import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { SavedInstancePublic } from '../../src/services/opsConsole';

const PASSPHRASE = 'browser routing test passphrase';
const ROUTE_CONTEXT_QUERY = 'filter=first&filter=second&fleetView=exceptions&fleetInstances=east&fleetInstances=west';
const ROUTE_CONTEXT_HASH = '#fleet-drilldown';

interface SeededConnection {
  baseUrl: string;
  apiKey: string;
  status: 'success';
  connectionMode: 'vault';
  instanceId: string;
  instanceLabel: string;
  apiKeyMasked: string;
}

type SavedInstanceFixture = SavedInstancePublic;

const pageErrorsByPage = new WeakMap<Page, Error[]>();

test.beforeEach(async ({ page }) => {
  const pageErrors: Error[] = [];
  pageErrorsByPage.set(page, pageErrors);
  page.on('pageerror', (error) => pageErrors.push(error));
});

test.afterEach(async ({ page }) => {
  expect((pageErrorsByPage.get(page) || []).map((error) => error.message)).toEqual([]);
});

async function resetVault(request: APIRequestContext) {
  await request.delete('/api/vault/reset');
}

async function seedConnection(request: APIRequestContext): Promise<SeededConnection> {
  await resetVault(request);
  expect((await request.post('/api/vault/unlock', { data: { passphrase: PASSPHRASE } })).ok()).toBeTruthy();

  const response = await request.post('/api/instances', {
    data: {
      label: 'Example Omni workspace',
      role: 'both',
      baseUrl: 'https://example.omniapp.co',
      apiKey: 'omni-routing-test-key-not-real',
    },
  });
  expect(response.ok()).toBeTruthy();
  const instance = (await response.json()).instance as {
    id: string;
    label: string;
    baseUrl: string;
    apiKeyMasked: string;
  };

  return {
    baseUrl: instance.baseUrl,
    apiKey: `__omnikit_vault_instance__:${instance.id}`,
    status: 'success',
    connectionMode: 'vault',
    instanceId: instance.id,
    instanceLabel: instance.label,
    apiKeyMasked: instance.apiKeyMasked,
  };
}

async function seedLockedVaultWithInstances(request: APIRequestContext): Promise<SavedInstanceFixture[]> {
  await resetVault(request);
  expect((await request.post('/api/vault/unlock', { data: { passphrase: PASSPHRASE } })).ok()).toBeTruthy();

  const instances: SavedInstanceFixture[] = [];
  for (const input of [
    {
      label: 'First saved workspace',
      baseUrl: 'https://first-saved-workspace.invalid',
      apiKey: 'omni-first-saved-workspace-key-not-real',
    },
    {
      label: 'Second saved workspace',
      baseUrl: 'https://second-saved-workspace.invalid',
      apiKey: 'omni-second-saved-workspace-key-not-real',
    },
  ]) {
    const response = await request.post('/api/instances', {
      data: { ...input, role: 'both' },
    });
    expect(response.ok()).toBeTruthy();
    instances.push((await response.json()).instance as SavedInstanceFixture);
  }

  expect((await request.post('/api/vault/lock')).ok()).toBeTruthy();
  return instances;
}

async function useConnection(page: Page, connection: SeededConnection) {
  await page.addInitScript((savedConnection) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify(savedConnection));
  }, connection);
}

async function stabilizeSeededConnectionCatalog(page: Page, connection: SeededConnection) {
  const fixtureTimestamp = '2026-08-16T12:00:00.000Z';
  const instance: SavedInstanceFixture = {
    id: connection.instanceId,
    label: connection.instanceLabel,
    role: 'both',
    baseUrl: connection.baseUrl,
    apiKeyMasked: connection.apiKeyMasked,
    metricFilter: {
      connectionDatabaseContains: [],
      connectionDatabaseExact: [],
      embedExternalIdContains: [],
      embedExternalIdExact: [],
    },
    postMigrationActions: [],
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
    lastValidatedAt: fixtureTimestamp,
  };

  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instances: [instance] }),
    });
  });
}

async function closeWalkthrough(page: Page) {
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

test('guarded workflows explain how to return home when no saved instance is active', async ({ page, request }) => {
  await resetVault(request);
  await page.goto('/dashboards/migrate');
  await closeWalkthrough(page);

  await expect(page.getByRole('heading', { name: 'Choose an instance to unlock Dashboard Migrator' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to Home' }).click();
  await expect(page).toHaveURL('/');
});

test('connected Dashboard Migrator defaults to safe-copy source selection before any destination exists', async ({ page, request }) => {
  const connection = await seedConnection(request);
  const validatedAt = '2026-08-15T18:00:00.000Z';
  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instances: [{
          id: connection.instanceId,
          label: connection.instanceLabel,
          role: 'both',
          baseUrl: connection.baseUrl,
          apiKeyMasked: connection.apiKeyMasked,
          lastValidatedAt: validatedAt,
        }],
      }),
    });
  });
  await page.route('**/api/migration-jobs', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [] }),
    });
  });
  await page.route('**/api/model-migrator/*/connections', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        connections: [{
          id: 'routing-connection',
          name: 'Routing connection',
          dialect: 'postgres',
          database: 'routing',
        }],
      }),
    });
  });
  await page.route('**/api/instances/*/documents?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        documents: [],
        inventory: {
          complete: true,
          scope: 'credential',
          cache: {
            status: 'miss',
            fetchedAt: '2026-08-16T00:00:00.000Z',
            expiresAt: '2026-08-16T00:05:00.000Z',
            ageMs: 0,
            fresh: true,
          },
          pagination: {
            pages: 1,
            pageSize: 100,
            returnedRecords: 0,
            reportedTotalRecords: 0,
          },
          sourceRecordCount: 0,
          matchedRecordCount: 0,
          excluded: {
            missingConnectionId: 0,
            otherConnection: 0,
            missingDashboardEvidence: 0,
          },
        },
      }),
    });
  });
  await useConnection(page, connection);

  await page.goto('/dashboards/migrate');
  await closeWalkthrough(page);

  await expect(page.getByRole('heading', { name: 'Dashboard Migrator', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose dashboards', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Source instance', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Source connection', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose destinations', exact: true })).toHaveCount(0);
  await expect(page.getByText('Internal rollback mode', { exact: false })).toHaveCount(0);
});

test('unlocking a saved vault automatically activates the first instance for guarded workflows', async ({ page, request }) => {
  const instances = await seedLockedVaultWithInstances(request);
  const connectRequests: string[] = [];

  await page.route('**/api/instances/*/connect', async (route) => {
    const instanceId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || '');
    connectRequests.push(instanceId);
    const instance = instances.find((candidate) => candidate.id === instanceId);
    if (!instance) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Saved instance not found.' }),
      });
      return;
    }
    const connectedInstance = { ...instance, lastValidatedAt: new Date().toISOString() };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instance: connectedInstance,
        connection: {
          baseUrl: connectedInstance.baseUrl,
          apiKey: `__omnikit_vault_instance__:${connectedInstance.id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: connectedInstance.id,
          instanceLabel: connectedInstance.label,
          apiKeyMasked: connectedInstance.apiKeyMasked,
        },
      }),
    });
  });
  await page.route('**/api/list-models', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      models: [],
      complete: true,
      loadedResults: 0,
      totalResults: 0,
      pagesFetched: 1,
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
    }),
  }));

  await page.goto('/content/ai-studio');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Choose an instance to unlock AI Content Studio', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('omnikit:activeConnection:v1'))).toBeNull();

  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  await sidebar.getByRole('button', { name: /Switch Omni instance.*Vault locked/ }).click();
  await sidebar.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await sidebar.getByRole('button', { name: 'Unlock vault', exact: true }).click();

  await expect(sidebar.getByRole('button', {
    name: `Switch Omni instance. Current: ${instances[0].label}. Connected.`,
    exact: true,
  })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI Content Studio', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose an instance to unlock AI Content Studio', exact: true })).toHaveCount(0);
  await expect.poll(() => connectRequests).toEqual([instances[0].id]);
  await expect.poll(() => page.evaluate(() => {
    const raw = window.sessionStorage.getItem('omnikit:activeConnection:v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { instanceId?: string; status?: string };
    return { instanceId: parsed.instanceId, status: parsed.status };
  })).toEqual({ instanceId: instances[0].id, status: 'success' });
});

test('Home passphrase unlock survives ConnectPage unmount and activates the first instance once', async ({ page, request }) => {
  const instances = await seedLockedVaultWithInstances(request);
  const connectRequests: string[] = [];
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
    connectRequests.push(instanceId);
    const instance = instances.find((candidate) => candidate.id === instanceId);
    if (!instance) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Saved instance not found.' }),
      });
      return;
    }
    const connectedInstance = { ...instance, lastValidatedAt: new Date().toISOString() };
    Object.assign(instance, connectedInstance);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instance: connectedInstance,
        connection: {
          baseUrl: connectedInstance.baseUrl,
          apiKey: `__omnikit_vault_instance__:${connectedInstance.id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: connectedInstance.id,
          instanceLabel: connectedInstance.label,
          apiKeyMasked: connectedInstance.apiKeyMasked,
        },
      }),
    });
  });
  await page.route('**/api/portfolio-overview**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Portfolio data is outside this routing regression.' }),
  }));
  await page.route('**/api/list-models', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      models: [],
      complete: true,
      loadedResults: 0,
      totalResults: 0,
      pagesFetched: 1,
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
    }),
  }));

  await page.goto('/');
  await closeWalkthrough(page);
  await page.getByLabel('Vault passphrase').last().fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock vault', exact: true }).last().click();

  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  await expect(sidebar.getByRole('button', {
    name: `Switch Omni instance. Current: ${instances[0].label}. Connected.`,
    exact: true,
  })).toBeVisible();
  await expect.poll(() => connectRequests).toEqual([instances[0].id]);
  await expect(page.getByRole('heading', { name: 'Vault access', exact: true })).toHaveCount(0);

  await sidebar.getByRole('link', { name: 'AI Content Studio', exact: true }).click();
  await expect(page).toHaveURL('/content/ai-studio');
  await expect(page.getByRole('heading', { name: 'AI Content Studio', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose an instance to unlock AI Content Studio', exact: true })).toHaveCount(0);
  expect(connectRequests).toEqual([instances[0].id]);
});

test('unlocking resumes the persisted saved instance instead of replacing it with the first instance', async ({ page, request }) => {
  const instances = await seedLockedVaultWithInstances(request);
  const persisted = instances[1];
  const connectRequests: string[] = [];
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
  }, persisted);
  await page.route('**/api/instances/*/connect', async (route) => {
    const instanceId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || '');
    connectRequests.push(instanceId);
    const instance = instances.find((candidate) => candidate.id === instanceId);
    if (!instance) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Saved instance not found.' }),
      });
      return;
    }
    const connectedInstance = { ...instance, lastValidatedAt: new Date().toISOString() };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instance: connectedInstance,
        connection: {
          baseUrl: connectedInstance.baseUrl,
          apiKey: `__omnikit_vault_instance__:${connectedInstance.id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: connectedInstance.id,
          instanceLabel: connectedInstance.label,
          apiKeyMasked: connectedInstance.apiKeyMasked,
        },
      }),
    });
  });
  await page.route('**/api/list-models', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      models: [],
      complete: true,
      loadedResults: 0,
      totalResults: 0,
      pagesFetched: 1,
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
    }),
  }));

  await page.goto('/content/ai-studio');
  await closeWalkthrough(page);
  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  await sidebar.getByRole('button', { name: /Switch Omni instance.*Vault locked/ }).click();
  await sidebar.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await sidebar.getByRole('button', { name: 'Unlock and resume', exact: true }).click();

  await expect(sidebar.getByRole('button', {
    name: `Switch Omni instance. Current: ${persisted.label}. Connected.`,
    exact: true,
  })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI Content Studio', exact: true })).toBeVisible();
  await expect.poll(() => connectRequests).toEqual([persisted.id]);
});

test('a mismatched persisted vault reference is discarded and cannot unlock a guarded workflow', async ({ page, request }) => {
  const instances = await seedLockedVaultWithInstances(request);
  const connectRequests: string[] = [];
  await page.route('**/api/instances/*/connect', async (route) => {
    connectRequests.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || ''));
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'A locked vault must not attempt to connect.' }),
    });
  });
  await page.addInitScript(({ instanceId, credentialInstanceId, baseUrl, label, apiKeyMasked }) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify({
      baseUrl,
      apiKey: `__omnikit_vault_instance__:${credentialInstanceId}`,
      status: 'success',
      errorMessage: '',
      connectionMode: 'vault',
      instanceId,
      instanceLabel: label,
      apiKeyMasked,
    }));
  }, {
    instanceId: instances[0].id,
    credentialInstanceId: instances[1].id,
    baseUrl: instances[0].baseUrl,
    label: instances[0].label,
    apiKeyMasked: instances[0].apiKeyMasked,
  });

  await page.goto('/content/ai-studio');
  await closeWalkthrough(page);

  await expect(page.getByRole('heading', { name: 'Choose an instance to unlock AI Content Studio', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI Content Studio', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('omnikit:activeConnection:v1'))).toBeNull();
  expect(connectRequests).toEqual([]);
});

test('failed first-instance bootstrap stays guarded and never falls through to another tenant', async ({ page, request }) => {
  const instances = await seedLockedVaultWithInstances(request);
  const connectRequests: string[] = [];
  await page.route('**/api/instances/*/connect', async (route) => {
    const instanceId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || '');
    connectRequests.push(instanceId);
    if (instanceId === instances[0].id) {
      await route.fulfill({
        status: 504,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The first saved workspace did not respond.' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instance: { ...instances[1], lastValidatedAt: new Date().toISOString() },
        connection: {
          baseUrl: instances[1].baseUrl,
          apiKey: `__omnikit_vault_instance__:${instances[1].id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: instances[1].id,
          instanceLabel: instances[1].label,
          apiKeyMasked: instances[1].apiKeyMasked,
        },
      }),
    });
  });

  await page.goto('/content/ai-studio');
  await closeWalkthrough(page);
  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  await sidebar.getByRole('button', { name: /Switch Omni instance.*Vault locked/ }).click();
  await sidebar.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await sidebar.getByRole('button', { name: 'Unlock vault', exact: true }).click();

  await expect.poll(() => connectRequests).toEqual([instances[0].id]);
  await expect.poll(() => page.evaluate(() => {
    const raw = window.sessionStorage.getItem('omnikit:activeConnection:v1');
    if (!raw) return true;
    return (JSON.parse(raw) as { status?: string }).status !== 'testing';
  })).toBe(true);
  expect(connectRequests).toEqual([instances[0].id]);
  await expect(page.getByRole('heading', { name: 'Choose an instance to unlock AI Content Studio', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI Content Studio', exact: true })).toHaveCount(0);
  const persisted = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem('omnikit:activeConnection:v1');
    if (!raw) return { instanceId: null, status: null };
    const parsed = JSON.parse(raw) as { instanceId?: string; status?: string };
    return { instanceId: parsed.instanceId || null, status: parsed.status || null };
  });
  expect([null, instances[0].id]).toContain(persisted.instanceId);
  expect(persisted.status).not.toBe('success');
});

test('a mismatched successful connect envelope is rejected without activating another tenant', async ({ page, request }) => {
  const instances = await seedLockedVaultWithInstances(request);
  const connectRequests: string[] = [];
  await page.route('**/api/instances/*/connect', async (route) => {
    const instanceId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || '');
    connectRequests.push(instanceId);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instance: { ...instances[0], lastValidatedAt: new Date().toISOString() },
        connection: {
          baseUrl: instances[0].baseUrl,
          apiKey: `__omnikit_vault_instance__:${instances[1].id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: instances[1].id,
          instanceLabel: instances[0].label,
          apiKeyMasked: instances[0].apiKeyMasked,
        },
      }),
    });
  });

  await page.goto('/content/ai-studio');
  await closeWalkthrough(page);
  const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
  await sidebar.getByRole('button', { name: /Switch Omni instance.*Vault locked/ }).click();
  await sidebar.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await sidebar.getByRole('button', { name: 'Unlock vault', exact: true }).click();

  await expect.poll(() => connectRequests).toEqual([instances[0].id]);
  await expect.poll(() => page.evaluate(() => {
    const raw = window.sessionStorage.getItem('omnikit:activeConnection:v1');
    if (!raw) return true;
    return (JSON.parse(raw) as { status?: string }).status !== 'testing';
  })).toBe(true);
  expect(connectRequests).toEqual([instances[0].id]);
  await expect(page.getByRole('heading', { name: 'Choose an instance to unlock AI Content Studio', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI Content Studio', exact: true })).toHaveCount(0);
  const persisted = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem('omnikit:activeConnection:v1');
    if (!raw) return { instanceId: null, status: null };
    const parsed = JSON.parse(raw) as { instanceId?: string; status?: string };
    return { instanceId: parsed.instanceId || null, status: parsed.status || null };
  });
  expect([null, instances[0].id]).toContain(persisted.instanceId);
  expect(persisted.status).not.toBe('success');
});

test('explicit instance B supersedes delayed automatic A even when A resolves last', async ({ page, request }) => {
  const instances = await seedLockedVaultWithInstances(request);
  expect((await request.post('/api/vault/unlock', { data: { passphrase: PASSPHRASE } })).ok()).toBeTruthy();
  await page.addInitScript(() => {
    window.sessionStorage.removeItem('omnikit:activeConnection:v1');
  });

  const connectRequests: string[] = [];
  let releaseAutomatic!: () => void;
  const automaticGate = new Promise<void>((resolve) => { releaseAutomatic = resolve; });
  await page.route('**/api/instances/*/connect', async (route) => {
    const instanceId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || '');
    connectRequests.push(instanceId);
    const instance = instances.find((candidate) => candidate.id === instanceId);
    if (!instance) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Saved instance not found.' }),
      });
      return;
    }
    if (instanceId === instances[0].id) await automaticGate;
    const connectedInstance = { ...instance, lastValidatedAt: new Date().toISOString() };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instance: connectedInstance,
        connection: {
          baseUrl: connectedInstance.baseUrl,
          apiKey: `__omnikit_vault_instance__:${connectedInstance.id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: connectedInstance.id,
          instanceLabel: connectedInstance.label,
          apiKeyMasked: connectedInstance.apiKeyMasked,
        },
      }),
    }).catch(() => undefined);
  });
  await page.route('**/api/list-models', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      models: [],
      complete: true,
      loadedResults: 0,
      totalResults: 0,
      pagesFetched: 1,
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
    }),
  }));

  try {
    await page.goto('/content/ai-studio');
    await closeWalkthrough(page);
    await expect.poll(() => connectRequests).toEqual([instances[0].id]);

    const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
    await sidebar.getByRole('button', {
      name: `Switch Omni instance. Current: ${instances[0].label}. Vault unlocked.`,
      exact: true,
    }).click();
    await sidebar.getByRole('group', { name: 'Saved Omni instances' })
      .getByRole('button', { name: new RegExp(instances[1].label) })
      .click();

    await expect(sidebar.getByRole('button', {
      name: `Switch Omni instance. Current: ${instances[1].label}. Connected.`,
      exact: true,
    })).toBeVisible();
    await expect.poll(() => connectRequests).toEqual([instances[0].id, instances[1].id]);

    releaseAutomatic();
    await page.waitForTimeout(150);
    await expect(sidebar.getByRole('button', {
      name: `Switch Omni instance. Current: ${instances[1].label}. Connected.`,
      exact: true,
    })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const raw = window.sessionStorage.getItem('omnikit:activeConnection:v1');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { instanceId?: string; status?: string };
      return { instanceId: parsed.instanceId, status: parsed.status };
    })).toEqual({ instanceId: instances[1].id, status: 'success' });
  } finally {
    releaseAutomatic();
  }
});

test('explicit B wins while the original unlock catalog read is delayed and resolves last', async ({ page, request }) => {
  const instances = await seedLockedVaultWithInstances(request);
  const connectRequests: string[] = [];
  let instanceCatalogReads = 0;
  let markUnlockCatalogStarted!: () => void;
  const unlockCatalogStarted = new Promise<void>((resolve) => { markUnlockCatalogStarted = resolve; });
  let releaseUnlockCatalog!: () => void;
  const unlockCatalogGate = new Promise<void>((resolve) => { releaseUnlockCatalog = resolve; });
  let releaseExplicitConnect!: () => void;
  const explicitConnectGate = new Promise<void>((resolve) => { releaseExplicitConnect = resolve; });

  await page.route('**/api/instances', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    instanceCatalogReads += 1;
    if (instanceCatalogReads === 1) {
      markUnlockCatalogStarted();
      await unlockCatalogGate;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instances }),
    }).catch(() => undefined);
  });
  await page.route('**/api/instances/*/connect', async (route) => {
    const instanceId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] || '');
    connectRequests.push(instanceId);
    const instance = instances.find((candidate) => candidate.id === instanceId);
    if (!instance) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Saved instance not found.' }),
      });
      return;
    }
    if (instanceId === instances[1].id) await explicitConnectGate;
    const connectedInstance = { ...instance, lastValidatedAt: new Date().toISOString() };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instance: connectedInstance,
        connection: {
          baseUrl: connectedInstance.baseUrl,
          apiKey: `__omnikit_vault_instance__:${connectedInstance.id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: connectedInstance.id,
          instanceLabel: connectedInstance.label,
          apiKeyMasked: connectedInstance.apiKeyMasked,
        },
      }),
    });
  });
  await page.route('**/api/list-models', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      models: [],
      complete: true,
      loadedResults: 0,
      totalResults: 0,
      pagesFetched: 1,
      pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
    }),
  }));

  try {
    await page.goto('/content/ai-studio');
    await closeWalkthrough(page);
    const sidebar = page.getByRole('complementary', { name: 'Main navigation' });
    await sidebar.getByRole('button', { name: /Switch Omni instance.*Vault locked/ }).click();
    await sidebar.getByLabel('Vault passphrase').fill(PASSPHRASE);
    await sidebar.getByRole('button', { name: 'Unlock vault', exact: true }).click();
    await unlockCatalogStarted;
    expect(instanceCatalogReads).toBe(1);

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => instanceCatalogReads).toBe(2);
    const savedInstances = sidebar.getByRole('group', { name: 'Saved Omni instances' });
    await expect(savedInstances).toBeVisible();
    await savedInstances.getByRole('button', { name: new RegExp(instances[1].label) }).click();

    await expect(sidebar.getByRole('button', {
      name: `Switch Omni instance. Current: ${instances[1].label}. Vault unlocked.`,
      exact: true,
    })).toBeVisible();
    await expect.poll(() => connectRequests).toEqual([instances[1].id]);

    releaseUnlockCatalog();
    await page.waitForTimeout(150);
    expect(connectRequests).toEqual([instances[1].id]);
    await expect(sidebar.getByRole('button', {
      name: `Switch Omni instance. Current: ${instances[1].label}. Vault unlocked.`,
      exact: true,
    })).toBeVisible();

    releaseExplicitConnect();
    await expect(sidebar.getByRole('button', {
      name: `Switch Omni instance. Current: ${instances[1].label}. Connected.`,
      exact: true,
    })).toBeVisible();
    expect(connectRequests).toEqual([instances[1].id]);
    await expect.poll(() => page.evaluate(() => {
      const raw = window.sessionStorage.getItem('omnikit:activeConnection:v1');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { instanceId?: string; status?: string };
      return { instanceId: parsed.instanceId, status: parsed.status };
    })).toEqual({ instanceId: instances[1].id, status: 'success' });
    await expect(page.getByRole('heading', { name: 'AI Content Studio', exact: true })).toBeVisible();
  } finally {
    releaseUnlockCatalog();
    releaseExplicitConnect();
  }
});

test('admin workspace landings preserve repeated route context and hashes', async ({ page, request }) => {
  await resetVault(request);

  const landings = [
    { source: '/admin', destination: '/admin/fleet/instances' },
    { source: '/admin/fleet', destination: '/admin/fleet/instances' },
    { source: '/admin/identity', destination: '/admin/identity/users' },
    { source: '/admin/content', destination: '/admin/content/health' },
    { source: '/admin/developer', destination: '/admin/developer/embeds' },
  ];

  for (const landing of landings) {
    await page.goto(`${landing.source}?${ROUTE_CONTEXT_QUERY}${ROUTE_CONTEXT_HASH}`);
    await closeWalkthrough(page);
    await expect(page).toHaveURL(`${landing.destination}?${ROUTE_CONTEXT_QUERY}${ROUTE_CONTEXT_HASH}`);
  }
});

test('all legacy admin aliases preserve repeated context and force groups exactly once', async ({ page, request }) => {
  await resetVault(request);

  const legacyQuery = `${ROUTE_CONTEXT_QUERY}&tab=users&tab=health`;
  const aliases = [
    { source: '/instances', destination: '/admin/fleet/instances', query: legacyQuery },
    { source: '/connections', destination: '/admin/fleet/connections', query: legacyQuery },
    { source: '/users', destination: '/admin/identity/users', query: legacyQuery },
    { source: '/groups', destination: '/admin/identity/users', query: `${ROUTE_CONTEXT_QUERY}&tab=groups` },
    { source: '/uploads', destination: '/admin/content/uploads', query: legacyQuery },
    { source: '/content-health', destination: '/admin/content/health', query: legacyQuery },
    { source: '/labels', destination: '/admin/content/labels', query: legacyQuery },
    { source: '/schedules', destination: '/admin/content/schedules', query: legacyQuery },
    { source: '/embeds', destination: '/admin/developer/embeds', query: legacyQuery },
  ];

  for (const alias of aliases) {
    const sourceQuery = alias.source === '/groups' ? legacyQuery : alias.query;
    await page.goto(`${alias.source}?${sourceQuery}${ROUTE_CONTEXT_HASH}`);
    await closeWalkthrough(page);
    await expect(page).toHaveURL(`${alias.destination}?${alias.query}${ROUTE_CONTEXT_HASH}`);

    const currentUrl = new URL(page.url());
    expect(currentUrl.searchParams.getAll('filter')).toEqual(['first', 'second']);
    expect(currentUrl.searchParams.getAll('fleetInstances')).toEqual(['east', 'west']);
    if (alias.source === '/groups') expect(currentUrl.searchParams.getAll('tab')).toEqual(['groups']);
  }

  await page.goto('/connect');
  await expect(page).toHaveURL('/');
});

test('groups alias replaces its history entry and remains canonical through Back and Forward', async ({ page, request }) => {
  await resetVault(request);

  await page.goto('/');
  await closeWalkthrough(page);
  await page.goto(`/groups?${ROUTE_CONTEXT_QUERY}&tab=users&tab=health${ROUTE_CONTEXT_HASH}`);
  const canonicalGroupsUrl = `/admin/identity/users?${ROUTE_CONTEXT_QUERY}&tab=groups${ROUTE_CONTEXT_HASH}`;
  await expect(page).toHaveURL(canonicalGroupsUrl);
  expect(new URL(page.url()).searchParams.getAll('tab')).toEqual(['groups']);

  await page.goBack();
  await expect(page).toHaveURL('/');

  await page.goForward();
  await expect(page).toHaveURL(canonicalGroupsUrl);
  expect(new URL(page.url()).searchParams.getAll('tab')).toEqual(['groups']);
});

test('canonical admin guards are exact while Instance Manager remains unguarded', async ({ page, request }) => {
  await resetVault(request);

  await page.goto('/admin/fleet/instances');
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'Instance Manager', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /Choose an instance to unlock/ })).toHaveCount(0);

  const guardedLeaves = [
    { path: '/admin/fleet/connections', tool: 'Connection Health' },
    { path: '/admin/identity/users', tool: 'User Management' },
    { path: '/admin/content/health', tool: 'Content Health' },
    { path: '/admin/content/schedules', tool: 'Schedules' },
    { path: '/admin/content/uploads', tool: 'Upload Governance' },
    { path: '/admin/content/labels', tool: 'Labels' },
    { path: '/admin/developer/embeds', tool: 'Embed URLs' },
  ];

  for (const leaf of guardedLeaves) {
    await page.goto(`${leaf.path}?fleetView=overview#guarded-leaf`);
    await expect(page.getByRole('heading', {
      name: `Choose an instance to unlock ${leaf.tool}`,
      exact: true,
    })).toBeVisible({ timeout: 30_000 });
  }
});

test('active saved sessions support every canonical admin leaf and identity tab directly', async ({ page, request }) => {
  const connection = await seedConnection(request);
  await stabilizeSeededConnectionCatalog(page, connection);
  await useConnection(page, connection);

  const canonicalRoutes = [
    { path: '/admin/fleet/instances', heading: 'Instance Manager', workspace: 'fleet' },
    { path: '/admin/fleet/connections', heading: 'Connection Readiness', workspace: 'fleet' },
    { path: '/admin/identity/users', heading: 'User Management', workspace: 'identity' },
    { path: '/admin/identity/users?tab=groups', heading: 'User Management', workspace: 'identity' },
    { path: '/admin/identity/users?tab=import', heading: 'User Management', workspace: 'identity' },
    { path: '/admin/identity/users?tab=health', heading: 'User Management', workspace: 'identity' },
    { path: '/admin/content/health', heading: 'Content Health', workspace: 'content' },
    { path: '/admin/content/schedules', heading: 'Schedule Management', workspace: 'content' },
    { path: '/admin/content/uploads', heading: 'Upload Governance', workspace: 'content' },
    { path: '/admin/content/labels', heading: 'Bulk Label Governance', workspace: 'content' },
    { path: '/admin/developer/embeds', heading: 'Embed URL Generator', workspace: 'developer' },
  ];

  for (const route of canonicalRoutes) {
    await page.goto(route.path);
    await closeWalkthrough(page);
    await expect(page.getByTestId('admin-workspace-shell')).toHaveAttribute('data-admin-workspace', route.workspace);
    await expect(page.getByRole('heading', { name: route.heading, exact: true })).toBeVisible({ timeout: 30_000 });
  }
});

test('Identity workspace links preserve repeated non-tab context, hash, and tab history', async ({ page, request }) => {
  const connection = await seedConnection(request);
  await stabilizeSeededConnectionCatalog(page, connection);
  await useConnection(page, connection);

  const identityQuery = 'filter=first&filter=second&fleetView=adoption&fleetInstances=east&fleetInstances=west';
  const identityHash = '#identity-context';
  const identityUrl = (tab?: string) => (
    `/admin/identity/users?${identityQuery}${tab ? `&tab=${tab}` : ''}${identityHash}`
  );

  await page.goto(identityUrl());
  await closeWalkthrough(page);
  await expect(page.getByRole('heading', { name: 'User Management', exact: true })).toBeVisible({ timeout: 30_000 });

  const identityNavigation = page.getByRole('navigation', { name: 'Identity & Access pages' });
  const links = {
    Users: identityNavigation.getByRole('link', { name: 'Users', exact: true }),
    Groups: identityNavigation.getByRole('link', { name: 'Groups', exact: true }),
    'Bulk Import': identityNavigation.getByRole('link', { name: 'Bulk Import', exact: true }),
    'User Health': identityNavigation.getByRole('link', { name: 'User Health', exact: true }),
  };

  await expect(links.Users).toHaveAttribute('href', identityUrl());
  await expect(links.Groups).toHaveAttribute('href', identityUrl('groups'));
  await expect(links['Bulk Import']).toHaveAttribute('href', identityUrl('import'));
  await expect(links['User Health']).toHaveAttribute('href', identityUrl('health'));

  await links.Groups.click();
  await expect(page).toHaveURL(identityUrl('groups'));
  await expect(links.Groups).toHaveAttribute('aria-current', 'page');

  await links['Bulk Import'].click();
  await expect(page).toHaveURL(identityUrl('import'));
  await expect(links['Bulk Import']).toHaveAttribute('aria-current', 'page');

  await links['User Health'].click();
  await expect(page).toHaveURL(identityUrl('health'));
  await expect(links['User Health']).toHaveAttribute('aria-current', 'page');

  const history = [
    { direction: 'back' as const, url: identityUrl('import'), active: links['Bulk Import'] },
    { direction: 'back' as const, url: identityUrl('groups'), active: links.Groups },
    { direction: 'back' as const, url: identityUrl(), active: links.Users },
    { direction: 'forward' as const, url: identityUrl('groups'), active: links.Groups },
    { direction: 'forward' as const, url: identityUrl('import'), active: links['Bulk Import'] },
    { direction: 'forward' as const, url: identityUrl('health'), active: links['User Health'] },
  ];

  for (const step of history) {
    if (step.direction === 'back') await page.goBack();
    else await page.goForward();
    await expect(page).toHaveURL(step.url);
    await expect(step.active).toHaveAttribute('aria-current', 'page');
  }
});

test('high-risk workflows support direct navigation and browser history', async ({ page, request }) => {
  const connection = await seedConnection(request);
  await stabilizeSeededConnectionCatalog(page, connection);
  await useConnection(page, connection);

  const routes = [
    { path: '/dashboards/migrate', heading: 'Dashboard Migrator' },
    { path: '/models/migrate', heading: 'Model Migrator' },
    { path: '/deck-builder', heading: 'Deck Builder' },
    { path: '/users?tab=groups', heading: 'User Management' },
  ];

  for (const route of routes) {
    await page.goto(route.path);
    await closeWalkthrough(page);
    await expect(page.getByRole('heading', { name: route.heading, exact: true })).toBeVisible({ timeout: 30_000 });
  }

  await page.goto('/dashboards/migrate');
  await expect(page.getByRole('heading', { name: 'Dashboard Migrator', exact: true })).toBeVisible();
  await page.goto('/models/migrate');
  await expect(page.getByRole('heading', { name: 'Model Migrator', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/dashboards/migrate');
  await expect(page.getByRole('heading', { name: 'Dashboard Migrator', exact: true })).toBeVisible();
});

test('legacy BI Migration Studio bookmarks explain retirement without loading the removed API', async ({ page }) => {
  const migrationApiRequests: string[] = [];
  await page.route('**/api/migration-studio**', async (route) => {
    migrationApiRequests.push(route.request().url());
    await route.abort();
  });

  await page.goto('/semantic-migrations');
  await closeWalkthrough(page);

  await expect(page.getByRole('heading', { name: 'BI Migration Studio retired', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Omni-to-Omni Model Migrator', exact: true }))
    .toHaveAttribute('href', '/models/migrate');
  expect(migrationApiRequests).toEqual([]);
});
