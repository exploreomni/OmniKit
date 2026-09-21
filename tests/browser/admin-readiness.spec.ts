import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import type { SavedInstancePublic } from '../../src/services/opsConsole';

const PASSPHRASE = 'admin readiness browser test passphrase';
const TENANT_ORIGIN = 'https://admin-readiness.invalid';
const SECOND_TENANT_ORIGIN = 'https://second-admin-readiness.invalid';
const CHECKED_AT = '2026-08-09T12:00:00.000Z';
const RAW_COLLECTION_MARKER = 'RAW_ADMIN_COLLECTION_ERROR_MUST_NOT_RENDER';

type AdminCollectionFixtureMode = 'malformed' | 'empty' | 'populated';
type EvidenceFailureFixtureMode = 'unauthorized' | 'unsupported' | 'unavailable';
type TopLevelReadFailureMode = EvidenceFailureFixtureMode | 'failed';
type DetailEvidenceFailureFixtureMode = EvidenceFailureFixtureMode | 'failed';
type ConnectionFixtureMode = AdminCollectionFixtureMode | 'active_and_deleted' | TopLevelReadFailureMode;
type DbtFixtureMode = 'configured' | 'not_configured' | 'not_supported' | 'malformed' | DetailEvidenceFailureFixtureMode;
type RefreshScheduleFixtureMode = 'populated' | 'multiple' | 'empty' | 'malformed' | DetailEvidenceFailureFixtureMode;
type ScheduleFixtureMode = AdminCollectionFixtureMode | 'offset_pages' | 'offset_terminal_mismatch' | 'offset_bad_cursor' | TopLevelReadFailureMode;
type SchemaModelFixtureMode = AdminCollectionFixtureMode | 'wrong_attribution' | EvidenceFailureFixtureMode;
type UploadFixtureMode = AdminCollectionFixtureMode | 'cursor_pages' | 'cursor_terminal_mismatch' | TopLevelReadFailureMode;

interface AdminCollectionFixtureModes {
  connections: ConnectionFixtureMode;
  dbt: DbtFixtureMode;
  refreshSchedules: RefreshScheduleFixtureMode;
  scheduleDocuments: AdminCollectionFixtureMode;
  schedules: ScheduleFixtureMode;
  schemaModels: SchemaModelFixtureMode;
  uploads: UploadFixtureMode;
}

interface IsolationEvidence {
  adminCollectionModes: AdminCollectionFixtureModes;
  adminReadinessRequests: string[];
  delayedDetailBaseUrl: string | null;
  delayedDetailPromise: Promise<void> | null;
  delayedInventoryBaseUrl: string | null;
  delayedInventoryPromise: Promise<void> | null;
  delayedScheduleBaseUrl: string | null;
  delayedSchedulePromise: Promise<void> | null;
  delayedUploadBaseUrl: string | null;
  delayedUploadCursor: string | null;
  delayedUploadPromise: Promise<void> | null;
  embedGenerationBodies: Record<string, unknown>[];
  embedGenerationMode: 'success' | 'pending' | 'error';
  escapedTenantRequests: string[];
  groupListStartIndices: number[];
  localConnectFixtures: Record<string, SavedInstancePublic>;
  pageErrors: string[];
  pendingDetailRequests: number;
  pendingInventoryRequests: number;
  pendingScheduleRequests: number;
  pendingUploadRequests: number;
  pendingWriteAction: 'user_create' | 'group_patch' | null;
  releaseDelayedDetails: (() => void) | null;
  releaseDelayedInventory: (() => void) | null;
  releaseDelayedSchedule: (() => void) | null;
  releaseDelayedUpload: (() => void) | null;
  releaseEmbedGeneration: (() => void) | null;
  releasePendingWrite: (() => void) | null;
  tenantWrites: string[];
  userUpdateBodies: Record<string, unknown>[];
}

interface ReadinessFixtureOptions {
  adminCollections?: Partial<AdminCollectionFixtureModes>;
  contentDocuments?: 'error' | 'malformed' | 'empty';
  groupPagination?: 'short_complete' | 'later_failure' | 'missing_members' | 'unresolved_member';
  userPagination?: 'attributes_complete' | 'later_failure';
}

function capability(overrides: Record<string, unknown>) {
  return {
    id: 'fleet.folder_read',
    label: 'Folder inventory',
    evidenceState: 'available',
    readinessState: 'ready',
    reason: { code: 'ok', message: 'Documented read evidence is available.' },
    source: { kind: 'omni_api', scope: 'collection', method: 'GET', path: '/api/v1/folders' },
    checkedAt: CHECKED_AT,
    coverage: { included: 1, total: 1, complete: true, unit: 'endpoints' },
    exclusions: [],
    documentation: [],
    ...overrides,
  };
}

function readinessReport(
  workspace: string,
  instanceId = 'instance-neutral',
  posture?: {
    principalType: 'user' | 'group';
    principalId: string;
    modelId?: string;
    connectionId?: string;
  },
) {
  const capabilities: Record<string, unknown>[] = workspace === 'fleet'
    ? [
      capability({
        id: 'fleet.folder_read',
        label: 'Folder read visibility',
        data: { readable: true, visibleFoldersLowerBound: 0 },
        coverage: { included: 0, total: null, complete: false, unit: 'visible_folders' },
        exclusions: ['lower_bound_probe_only', 'credential_permission_filtered_visibility'],
      }),
      capability({
        id: 'fleet.api_tokens',
        label: 'API token inventory',
        evidenceState: 'unauthorized',
        readinessState: 'action_required',
        reason: { code: 'authentication_required', message: 'The saved credential was not accepted.' },
        data: undefined,
      }),
      capability({
        id: 'fleet.organization_api_key_confirmation',
        label: 'Organization API key confirmation',
        evidenceState: 'not_checked',
        readinessState: 'unknown',
        reason: { code: 'operator_confirmation_missing', message: 'Operator confirmation is required.' },
        source: { kind: 'operator_confirmation', scope: 'saved_setting' },
        coverage: { included: 0, total: 1, complete: false, unit: 'confirmations' },
      }),
      capability({
        id: 'fleet.current_token_introspection',
        label: 'Current token introspection',
        evidenceState: 'unavailable',
        readinessState: 'unknown',
        reason: { code: 'resource_not_found', message: 'The resource was not found.' },
        source: { kind: 'omni_api', scope: 'resource', method: 'GET', path: '/api/v1/current-token' },
        data: undefined,
      }),
    ]
    : workspace === 'identity'
      ? [
        capability({
          id: 'identity.scim_users',
          label: 'SCIM users',
          evidenceState: 'partial',
          readinessState: 'action_required',
          reason: { code: 'partial_coverage', message: '250 of 300 users were collected.' },
          source: { kind: 'omni_api', scope: 'collection', method: 'GET', path: '/api/scim/v2/users' },
          data: { total: 250, active: 200, inactive: 40, statusUnknown: 10 },
          coverage: { included: 250, total: 300, complete: false, unit: 'users' },
          exclusions: ['50 users were not returned within the bounded collection.'],
        }),
        capability({
          id: 'identity.scim_groups',
          label: 'SCIM groups',
          source: { kind: 'omni_api', scope: 'collection', method: 'GET', path: '/api/scim/v2/groups' },
          data: { total: 100 },
          coverage: { included: 100, total: 100, complete: true, unit: 'groups' },
        }),
        capability({
          id: 'identity.user_attributes',
          label: 'User attributes',
          evidenceState: 'unauthorized',
          readinessState: 'action_required',
          reason: { code: 'permission_denied', message: 'The credential cannot read user attributes.' },
          source: { kind: 'omni_api', scope: 'collection', method: 'GET', path: '/api/v1/user-attributes' },
          data: undefined,
        }),
      ]
      : workspace === 'content'
        ? [capability({
          id: 'content.schedules',
          label: 'Schedule evidence',
          evidenceState: 'failed',
          readinessState: 'unknown',
          reason: { code: 'invalid_json', message: 'The schedule response was malformed.' },
          source: { kind: 'omni_api', scope: 'collection', method: 'GET', path: '/api/v1/schedules' },
          data: undefined,
        })]
        : [
          capability({
            id: 'developer.embed_users',
            label: 'Embed users',
            evidenceState: 'stale',
            readinessState: 'unknown',
            reason: { code: 'cached_refresh_failed', message: 'Retained evidence could not be refreshed.' },
            source: { kind: 'omni_api', scope: 'collection', method: 'GET', path: '/api/scim/v2/embed/users' },
            checkedAt: '2026-08-01T08:30:00.000Z',
            data: { total: 250, active: 200, inactive: 40, statusUnknown: 10 },
            coverage: { included: 250, total: 250, complete: true, unit: 'users' },
          }),
          capability({
            id: 'developer.sso_configuration',
            label: 'SSO configuration',
            evidenceState: 'unsupported',
            readinessState: 'not_configured',
            reason: { code: 'no_documented_read_api', message: 'No documented read API is available.' },
            source: { kind: 'official_documentation', scope: 'manual_action' },
            coverage: { included: 0, total: 0, complete: true, unit: 'endpoints' },
          }),
          capability({
            id: 'developer.audit_configuration',
            label: 'Audit configuration',
            evidenceState: 'unsupported',
            readinessState: 'not_configured',
            reason: { code: 'no_documented_read_api', message: 'No documented read API is available.' },
            source: { kind: 'official_documentation', scope: 'manual_action' },
            coverage: { included: 0, total: 0, complete: true, unit: 'endpoints' },
          }),
          capability({
            id: 'developer.api_explorer',
            label: 'API Explorer',
            evidenceState: 'available',
            readinessState: 'ready',
            reason: { code: 'manual_action_only', message: 'Open the documented tenant tool.' },
            source: { kind: 'official_documentation', scope: 'manual_action' },
            coverage: { included: 1, total: 1, complete: true, unit: 'links' },
            documentation: [{ label: 'API Explorer documentation', url: 'https://docs.omni.co/api/api-explorer' }],
            actions: [{ kind: 'tenant_deep_link', label: 'Open API Explorer', url: `${TENANT_ORIGIN}/api-explorer` }],
          }),
        ];

  return {
    schemaVersion: 1,
    instanceId,
    workspace,
    checkedAt: CHECKED_AT,
    servedFromCache: false,
    capabilities: workspace === 'identity' && posture ? [] : capabilities,
    ...(workspace === 'identity' && posture ? {
      accessPosture: {
        id: posture.principalType === 'user' ? 'identity.user_model_roles' : 'identity.group_model_roles',
        principalType: posture.principalType,
        requestScope: {
          principalId: posture.principalId,
          ...(posture.modelId ? { modelId: posture.modelId } : {}),
          ...(posture.connectionId ? { connectionId: posture.connectionId } : {}),
        },
        evidenceState: 'available',
        readinessState: 'ready',
        reason: { code: 'ok', message: 'One explicit principal role read completed.' },
        source: {
          kind: 'omni_api',
          scope: 'resource',
          method: 'GET',
          path: posture.principalType === 'user'
            ? '/api/v1/users/:userId/model-roles'
            : '/api/v1/user-groups/:userGroupId/model-roles',
        },
        checkedAt: CHECKED_AT,
        coverage: { included: 1, total: 1, complete: true, unit: 'model_roles' },
        exclusions: ['membership_id'],
        documentation: [],
        roles: [{ roleName: 'Viewer', modelId: 'model-safe', connectionId: 'connection-safe', resolved: true }],
      },
    } : {}),
  };
}

function metric(value: number) {
  return {
    value,
    status: 'available',
    asOf: CHECKED_AT,
    coverage: { included: 1, total: 1, unit: 'instances', ratio: 1 },
    exclusions: [],
    reasonCode: null,
    source: 'derived_instance_aggregate',
  };
}

function portfolioFixture() {
  const metrics = {
    reportingInstances: metric(1),
    internalMemberships: metric(0),
    estimatedUniquePeople: metric(0),
    embedUsers: metric(0),
    embedEntities: metric(0),
    active7d: metric(0),
    active30d: metric(0),
    active90d: metric(0),
    staleUsers90d: metric(0),
    neverLoggedInUsers: metric(0),
    dashboards: metric(0),
    models: metric(0),
    topics: metric(0),
    aiChats: metric(0),
    apps: metric(0),
  };
  return {
    schemaVersion: 1,
    generatedAt: CHECKED_AT,
    servedAt: CHECKED_AT,
    cache: { state: 'fresh', cachedAt: CHECKED_AT },
    refresh: { state: 'idle', completedInstances: 1, totalInstances: 1, completedAt: CHECKED_AT },
    coverage: {
      totalInstances: 1,
      reportingInstances: 1,
      partialInstances: 0,
      staleInstances: 0,
      unavailableInstances: 0,
      savedInstances: 1,
      duplicateSavedOrigins: 0,
    },
    metrics,
    instances: [],
    connections: [],
    attention: [],
    failures: [],
    duplicateSavedOrigins: [],
    warnings: [],
    partial: false,
    stale: false,
  };
}

function terminalCollectionPage(totalRecords: number, pageSize = 25) {
  return { hasNextPage: false, nextCursor: null, pageSize, totalRecords };
}

function tenantConnection(baseUrl: unknown) {
  return baseUrl === SECOND_TENANT_ORIGIN
    ? { id: 'connection-second', name: 'Second Warehouse' }
    : { id: 'connection-qa', name: 'QA Warehouse' };
}

function connectionCollectionFixture(mode: ConnectionFixtureMode, baseUrl: unknown) {
  if (mode === 'malformed') {
    return { error: `${RAW_COLLECTION_MARKER}: connections`, connections: [] };
  }
  if (mode === 'empty') return { connections: [] };
  const scope = tenantConnection(baseUrl);
  const connections = [{
      id: scope.id,
      name: scope.name,
      dialect: 'snowflake',
      database: 'analytics',
      defaultSchema: 'public',
      baseRole: 'NO_ACCESS',
      deletedAt: null as string | null,
    }];
  if (mode === 'active_and_deleted') {
    connections.push({
      id: 'connection-retired',
      name: 'Retired Warehouse',
      dialect: 'snowflake',
      database: 'archive',
      defaultSchema: 'retired',
      baseRole: 'NO_ACCESS',
      deletedAt: '2026-07-01T10:00:00.000Z',
    });
  }
  return { connections };
}

function dbtFixture(mode: DbtFixtureMode, connectionId = 'connection-qa') {
  if (mode === 'malformed') return { supportsDbt: true, branch: 'main' };
  if (mode === 'not_configured') {
    return { supportsDbt: true, message: 'dbt not configured for this connection' };
  }
  if (mode === 'not_supported') {
    return {
      supportsDbt: false,
      autogenRelationships: false,
      branch: 'main',
      dbtVersion: 'Auto',
      enableSemanticLayer: false,
      enableVirtualSchemas: false,
      projectRootPath: null,
      sshUrl: 'git@github.com:example/analytics.git',
    };
  }
  return {
    supportsDbt: true,
    autogenRelationships: true,
    branch: connectionId === 'connection-second' ? 'second-current-branch' : 'qa-stale-branch',
    dbtVersion: 'Auto',
    enableSemanticLayer: false,
    enableVirtualSchemas: true,
    projectRootPath: 'dbt_project',
    sshUrl: 'git@github.com:example/analytics.git',
  };
}

function refreshScheduleFixture(mode: RefreshScheduleFixtureMode, connectionId = 'connection-qa') {
  if (mode === 'malformed') return { records: [] };
  if (mode === 'empty') return { schedules: [] };
  const schedules = [{
    scheduleId: `refresh-${connectionId}`,
    connectionId,
    schedule: '0 6 * * *',
    timezone: 'UTC',
    description: 'Daily refresh',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
    disabledAt: null,
  }];
  if (mode === 'multiple') {
    schedules.push({
      scheduleId: `refresh-${connectionId}-secondary`,
      connectionId,
      schedule: '0 18 * * *',
      timezone: 'UTC',
      description: 'Evening refresh',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-02T10:00:00.000Z',
      disabledAt: null,
    });
  }
  return {
    schedules,
  };
}

function evidenceFailureStatus(mode: EvidenceFailureFixtureMode): number {
  if (mode === 'unauthorized') return 403;
  if (mode === 'unsupported') return 404;
  return 503;
}

function isEvidenceFailureMode(mode: string): mode is EvidenceFailureFixtureMode {
  return mode === 'unauthorized' || mode === 'unsupported' || mode === 'unavailable';
}

function isTopLevelReadFailureMode(mode: string): mode is TopLevelReadFailureMode {
  return isEvidenceFailureMode(mode) || mode === 'failed';
}

function topLevelReadFailureStatus(mode: TopLevelReadFailureMode): number {
  return mode === 'failed' ? 400 : evidenceFailureStatus(mode);
}

function isDetailEvidenceFailureMode(mode: string): mode is DetailEvidenceFailureFixtureMode {
  return isEvidenceFailureMode(mode) || mode === 'failed';
}

function detailEvidenceFailureStatus(mode: DetailEvidenceFailureFixtureMode): number {
  return mode === 'failed' ? 400 : evidenceFailureStatus(mode);
}

function scheduleRecordFixture(ordinal: number, baseUrl: unknown = TENANT_ORIGIN) {
  const secondTenant = baseUrl === SECOND_TENANT_ORIGIN;
  const scope = secondTenant ? 'second' : 'qa';
  return {
    id: `schedule-${scope}-${ordinal}`,
    schedule: '0 9 * * *',
    disabledAt: null,
    name: ordinal === 1
      ? secondTenant ? 'Second tenant schedule' : 'Daily executive schedule'
      : `${secondTenant ? 'Second schedule fixture' : 'Schedule fixture'} ${ordinal}`,
    timezone: 'UTC',
    identifier: `dashboard-${scope}-${ordinal}`,
    dashboardName: ordinal === 1
      ? secondTenant ? 'Second tenant overview' : 'Executive overview'
      : `${secondTenant ? 'Second fixture dashboard' : 'Fixture dashboard'} ${ordinal}`,
    ownerId: 'owner-qa',
    ownerName: 'Example owner',
    lastCompletedAt: '2026-08-08T12:00:00.000Z',
    lastStatus: 'success',
    destinationType: 'email',
    format: 'pdf',
    recipientCount: 1,
    content: 'dashboard',
    systemDisabledAt: null,
    systemDisabledReason: null,
    alert: null,
  };
}

function scheduleCollectionFixture(mode: ScheduleFixtureMode, pageNumber = 1, baseUrl: unknown = TENANT_ORIGIN) {
  if (mode === 'malformed') {
    return {
      error: `${RAW_COLLECTION_MARKER}: schedules`,
      records: [],
      pageInfo: terminalCollectionPage(0),
    };
  }
  if (mode === 'empty') return { records: [], pageInfo: terminalCollectionPage(0) };
  if (mode === 'offset_pages' || mode === 'offset_terminal_mismatch' || mode === 'offset_bad_cursor') {
    if (pageNumber === 1) {
      return {
        records: Array.from({ length: 25 }, (_, index) => scheduleRecordFixture(index + 1, baseUrl)),
        pageInfo: { hasNextPage: true, nextCursor: mode === 'offset_bad_cursor' ? '999' : '2', pageSize: 25, totalRecords: 26 },
      };
    }
    if (pageNumber !== 2) return { error: `${RAW_COLLECTION_MARKER}: unexpected schedule page` };
    return {
      records: mode === 'offset_pages' ? [scheduleRecordFixture(26, baseUrl)] : [],
      pageInfo: terminalCollectionPage(26),
    };
  }
  return {
    records: [scheduleRecordFixture(1, baseUrl)],
    pageInfo: terminalCollectionPage(1),
  };
}

function uploadRecord(ordinal: number, baseUrl: unknown = TENANT_ORIGIN) {
  const secondTenant = baseUrl === SECOND_TENANT_ORIGIN;
  const scope = secondTenant ? 'second' : 'qa';
  return {
    id: `upload-${scope}-${ordinal}`,
    file_name: ordinal === 1
      ? secondTenant ? 'second-tenant-upload.csv' : 'example-upload.csv'
      : `${secondTenant ? 'second-upload' : 'example-upload'}-${ordinal}.csv`,
    view_name: `${secondTenant ? 'second_upload' : 'example_upload'}_${ordinal}`,
    connection_id: `connection-${scope}`,
    in_db_as_table_name: `${secondTenant ? 'second_upload_table' : 'example_upload_table'}_${ordinal}`,
    model_id: `model-${scope}`,
    size_bytes: 1024 * ordinal,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-02T10:00:00.000Z',
    uploaded_by_user: { id: 'user-qa', name: 'Example uploader' },
  };
}

function uploadCollectionFixture(mode: UploadFixtureMode, cursor?: string, baseUrl: unknown = TENANT_ORIGIN) {
  if (mode === 'malformed') {
    return {
      error: `${RAW_COLLECTION_MARKER}: uploads`,
      records: [],
      pageInfo: terminalCollectionPage(0),
    };
  }
  if (mode === 'empty') return { records: [], pageInfo: terminalCollectionPage(0) };
  if (mode === 'cursor_pages' || mode === 'cursor_terminal_mismatch') {
    if (!cursor) {
      return {
        records: [uploadRecord(1, baseUrl), uploadRecord(2, baseUrl)],
        pageInfo: { hasNextPage: true, nextCursor: 'upload-cursor-2', pageSize: 25, totalRecords: 5 },
      };
    }
    if (cursor !== 'upload-cursor-2') {
      return { error: `${RAW_COLLECTION_MARKER}: unexpected upload cursor` };
    }
    return {
      records: mode === 'cursor_pages'
        ? [uploadRecord(3, baseUrl), uploadRecord(4, baseUrl), uploadRecord(5, baseUrl)]
        : [uploadRecord(3, baseUrl)],
      pageInfo: terminalCollectionPage(5),
    };
  }
  return {
    records: [uploadRecord(1, baseUrl)],
    pageInfo: terminalCollectionPage(1),
  };
}

function scheduleDocumentFixture(mode: AdminCollectionFixtureMode) {
  if (mode === 'malformed') {
    return {
      error: `${RAW_COLLECTION_MARKER}: schedule documents`,
      documents: [],
      pageInfo: terminalCollectionPage(0, 100),
      pagesFetched: 1,
      complete: true,
      loadedResults: 0,
      totalResults: 0,
    };
  }
  if (mode === 'empty') {
    return {
      documents: [],
      pageInfo: terminalCollectionPage(0, 100),
      pagesFetched: 1,
      complete: true,
      loadedResults: 0,
      totalResults: 0,
    };
  }
  return {
    documents: [{
      id: 'dashboard-qa',
      identifier: 'dashboard-qa',
      name: 'Executive overview',
      type: 'dashboard',
      folderPath: 'Shared / Executive',
      baseModelName: 'Analytics model',
    }],
    pageInfo: terminalCollectionPage(1, 100),
    pagesFetched: 1,
    complete: true,
    loadedResults: 1,
    totalResults: 1,
  };
}

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * These suites assert readiness evidence for an operator who has already
 * tested the saved instance, so the fixture must present it as validated.
 * `lastValidatedAt` is deliberately not settable through `POST /api/instances`
 * — only a real folder probe records it — and the probe cannot run against the
 * unroutable `.invalid` tenant this suite uses for escape detection. So the
 * timestamp is stamped onto the browser-visible instance instead, exactly as
 * the other browser suites do. Without it, `useVaultSession` correctly
 * downgrades the session to `untested` and every protected admin route renders
 * the "Saved instance required" gate.
 */
function asValidatedInstance(instance: SavedInstancePublic): SavedInstancePublic {
  return { ...instance, lastValidatedAt: new Date().toISOString() };
}

async function seedConnection(request: APIRequestContext) {
  await request.delete('/api/vault/reset');
  expect((await request.post('/api/vault/unlock', { data: { passphrase: PASSPHRASE } })).ok()).toBeTruthy();
  const response = await request.post('/api/instances', {
    data: {
      label: 'Neutral admin readiness',
      role: 'both',
      baseUrl: TENANT_ORIGIN,
      apiKey: 'omni-admin-readiness-test-key-not-real',
    },
  });
  expect(response.ok()).toBeTruthy();
  return asValidatedInstance((await response.json()).instance as SavedInstancePublic);
}

async function addSavedInstance(request: APIRequestContext, label: string, baseUrl: string) {
  const response = await request.post('/api/instances', {
    data: {
      label,
      role: 'both',
      baseUrl,
      apiKey: `omni-${label.toLowerCase().replaceAll(' ', '-')}-test-key-not-real`,
    },
  });
  expect(response.ok()).toBeTruthy();
  return asValidatedInstance((await response.json()).instance as SavedInstancePublic);
}

async function prepareReadiness(
  page: Page,
  request: APIRequestContext,
  options: ReadinessFixtureOptions = {},
): Promise<IsolationEvidence> {
  const instance = await seedConnection(request);
  await page.addInitScript((saved) => {
    window.sessionStorage.setItem('omnikit:activeConnection:v1', JSON.stringify(saved));
  }, {
    baseUrl: instance.baseUrl,
    apiKey: `__omnikit_vault_instance__:${instance.id}`,
    status: 'success',
    connectionMode: 'vault',
    instanceId: instance.id,
    instanceLabel: instance.label,
    apiKeyMasked: instance.apiKeyMasked,
  });

  const evidence: IsolationEvidence = {
    adminCollectionModes: {
      connections: options.adminCollections?.connections || 'empty',
      dbt: options.adminCollections?.dbt || 'configured',
      refreshSchedules: options.adminCollections?.refreshSchedules || 'populated',
      scheduleDocuments: options.adminCollections?.scheduleDocuments || 'empty',
      schedules: options.adminCollections?.schedules || 'empty',
      schemaModels: options.adminCollections?.schemaModels
        || (options.adminCollections?.connections === 'malformed'
          || options.adminCollections?.connections === 'empty'
          || options.adminCollections?.connections === 'populated'
          ? options.adminCollections.connections
          : 'empty'),
      uploads: options.adminCollections?.uploads || 'empty',
    },
    adminReadinessRequests: [],
    delayedDetailBaseUrl: null,
    delayedDetailPromise: null,
    delayedInventoryBaseUrl: null,
    delayedInventoryPromise: null,
    delayedScheduleBaseUrl: null,
    delayedSchedulePromise: null,
    delayedUploadBaseUrl: null,
    delayedUploadCursor: null,
    delayedUploadPromise: null,
    embedGenerationBodies: [],
    embedGenerationMode: 'success',
    escapedTenantRequests: [],
    groupListStartIndices: [],
    localConnectFixtures: { [instance.id]: instance },
    pageErrors: [],
    pendingDetailRequests: 0,
    pendingInventoryRequests: 0,
    pendingScheduleRequests: 0,
    pendingUploadRequests: 0,
    pendingWriteAction: null,
    releaseDelayedDetails: null,
    releaseDelayedInventory: null,
    releaseDelayedSchedule: null,
    releaseDelayedUpload: null,
    releaseEmbedGeneration: null,
    releasePendingWrite: null,
    tenantWrites: [],
    userUpdateBodies: [],
  };
  page.on('pageerror', (error) => evidence.pageErrors.push(`${page.url()}: ${error.message}`));
  page.on('request', (browserRequest) => {
    if (new URL(browserRequest.url()).hostname.endsWith('.invalid')) {
      evidence.escapedTenantRequests.push(browserRequest.url());
    }
  });

  await page.route('**/api/**', async (route) => {
    const browserRequest = route.request();
    const url = new URL(browserRequest.url());
    const localInstanceConnect = browserRequest.method() === 'POST'
      && /^\/api\/instances\/[^/]+\/connect$/.test(url.pathname);
    if (localInstanceConnect) {
      const instanceId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const saved = evidence.localConnectFixtures[instanceId];
      if (!saved) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Instance not found.' }) });
      }
      return json(route, {
        instance: saved,
        connection: {
          baseUrl: saved.baseUrl,
          apiKey: `__omnikit_vault_instance__:${saved.id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: saved.id,
          instanceLabel: saved.label,
          apiKeyMasked: saved.apiKeyMasked,
        },
      });
    }
    // The saved-instance list is served by the real vault, then stamped as
    // validated so the session stays active. See asValidatedInstance.
    if (url.pathname === '/api/instances' && browserRequest.method() === 'GET') {
      const upstream = await route.fetch();
      if (!upstream.ok()) return route.fulfill({ response: upstream });
      const payload = await upstream.json() as { instances?: SavedInstancePublic[] };
      return route.fulfill({
        response: upstream,
        json: {
          ...payload,
          instances: (payload.instances || []).map(asValidatedInstance),
        },
      });
    }

    const localRead = url.pathname === '/api/vault/status'
      || url.pathname === '/api/vault/touch';
    if (localRead) return route.continue();

    let body: Record<string, unknown> = {};
    try {
      body = browserRequest.postDataJSON() as Record<string, unknown>;
    } catch {
      body = {};
    }
    const nonMutatingPostEndpoints = new Set([
      '/api/enrich-documents',
      '/api/generate-embed-url',
      '/api/list-documents',
      '/api/list-folders',
      '/api/list-models',
    ]);
    const readOnlyUserAction = url.pathname === '/api/manage-users'
      && ['find', 'list', 'list_attributes'].includes(String(body.action || ''));
    const readOnlyGroupAction = url.pathname === '/api/manage-groups'
      && ['get', 'list'].includes(String(body.action || ''));
    const effectiveMethod = url.pathname === '/api/omni-proxy'
      ? String(body.method || 'GET').toUpperCase()
      : nonMutatingPostEndpoints.has(url.pathname) || readOnlyUserAction || readOnlyGroupAction
        ? 'GET'
        : browserRequest.method().toUpperCase();
    if (!['GET', 'HEAD'].includes(effectiveMethod)) {
      evidence.tenantWrites.push(`${effectiveMethod} ${url.pathname}`);
    }

    if (url.pathname === '/api/admin-readiness') {
      evidence.adminReadinessRequests.push(url.toString());
      const workspace = url.searchParams.get('workspace') || 'fleet';
      const principalType = url.searchParams.get('principalType');
      const principalId = url.searchParams.get('principalId');
      const modelId = url.searchParams.get('modelId') || undefined;
      const connectionId = url.searchParams.get('connectionId') || undefined;
      return json(route, readinessReport(
        workspace,
        url.searchParams.get('instanceId') || 'instance-neutral',
        (principalType === 'user' || principalType === 'group') && principalId
          ? { principalType, principalId, modelId, connectionId }
          : undefined,
      ));
    }
    if (url.pathname === '/api/omni-proxy') {
      const endpoint = String(body.endpoint || '');
      if (endpoint === '/v1/connections') {
        if (evidence.delayedInventoryBaseUrl === body.base_url) {
          evidence.pendingInventoryRequests += 1;
          if (!evidence.delayedInventoryPromise) {
            evidence.delayedInventoryPromise = new Promise<void>((resolve) => {
              evidence.releaseDelayedInventory = resolve;
            });
          }
          await evidence.delayedInventoryPromise;
        }
        const mode = evidence.adminCollectionModes.connections;
        if (isTopLevelReadFailureMode(mode)) {
          return route.fulfill({
            status: topLevelReadFailureStatus(mode),
            contentType: 'application/json',
            body: JSON.stringify({ error: `${RAW_COLLECTION_MARKER}:connections:${mode}` }),
          });
        }
        return json(route, connectionCollectionFixture(mode, body.base_url));
      }
      if (endpoint === '/v1/schedules') {
        if (evidence.delayedScheduleBaseUrl === body.base_url) {
          evidence.pendingScheduleRequests += 1;
          if (!evidence.delayedSchedulePromise) {
            evidence.delayedSchedulePromise = new Promise<void>((resolve) => {
              evidence.releaseDelayedSchedule = resolve;
            });
          }
          await evidence.delayedSchedulePromise;
        }
        const queryParams = body.query_params && typeof body.query_params === 'object'
          ? body.query_params as Record<string, unknown>
          : {};
        const pageNumber = Number(queryParams.cursor || 1);
        const mode = evidence.adminCollectionModes.schedules;
        if (isTopLevelReadFailureMode(mode)) {
          return route.fulfill({
            status: topLevelReadFailureStatus(mode),
            contentType: 'application/json',
            body: JSON.stringify({ error: `${RAW_COLLECTION_MARKER}:schedules:${mode}` }),
          });
        }
        return json(route, scheduleCollectionFixture(
          mode,
          Number.isSafeInteger(pageNumber) ? pageNumber : 1,
          body.base_url,
        ));
      }
      if (endpoint === '/v1/uploads') {
        const queryParams = body.query_params && typeof body.query_params === 'object'
          ? body.query_params as Record<string, unknown>
          : {};
        const uploadCursor = typeof queryParams.cursor === 'string' ? queryParams.cursor : undefined;
        if (
          evidence.delayedUploadBaseUrl === body.base_url
          || (uploadCursor && evidence.delayedUploadCursor === uploadCursor)
        ) {
          evidence.pendingUploadRequests += 1;
          if (!evidence.delayedUploadPromise) {
            evidence.delayedUploadPromise = new Promise<void>((resolve) => {
              evidence.releaseDelayedUpload = resolve;
            });
          }
          await evidence.delayedUploadPromise;
        }
        const mode = evidence.adminCollectionModes.uploads;
        if (isTopLevelReadFailureMode(mode)) {
          return route.fulfill({
            status: topLevelReadFailureStatus(mode),
            contentType: 'application/json',
            body: JSON.stringify({ error: `${RAW_COLLECTION_MARKER}:uploads:${mode}` }),
          });
        }
        return json(route, uploadCollectionFixture(
          mode,
          uploadCursor,
          body.base_url,
        ));
      }
      const dbtMatch = endpoint.match(/^\/v1\/connections\/([^/]+)\/dbt$/);
      if (dbtMatch) {
        if (evidence.delayedDetailBaseUrl === body.base_url) {
          evidence.pendingDetailRequests += 1;
          if (!evidence.delayedDetailPromise) {
            evidence.delayedDetailPromise = new Promise<void>((resolve) => {
              evidence.releaseDelayedDetails = resolve;
            });
          }
          await evidence.delayedDetailPromise;
        }
        const mode = evidence.adminCollectionModes.dbt;
        if (isDetailEvidenceFailureMode(mode)) {
          return route.fulfill({
            status: detailEvidenceFailureStatus(mode),
            contentType: 'application/json',
            body: JSON.stringify({ error: `${RAW_COLLECTION_MARKER}:dbt:${mode}` }),
          });
        }
        return json(route, dbtFixture(mode, dbtMatch[1]));
      }
      const refreshMatch = endpoint.match(/^\/v1\/connections\/([^/]+)\/schedules$/);
      if (refreshMatch) {
        if (evidence.delayedDetailBaseUrl === body.base_url) {
          evidence.pendingDetailRequests += 1;
          if (!evidence.delayedDetailPromise) {
            evidence.delayedDetailPromise = new Promise<void>((resolve) => {
              evidence.releaseDelayedDetails = resolve;
            });
          }
          await evidence.delayedDetailPromise;
        }
        const mode = evidence.adminCollectionModes.refreshSchedules;
        if (isDetailEvidenceFailureMode(mode)) {
          return route.fulfill({
            status: detailEvidenceFailureStatus(mode),
            contentType: 'application/json',
            body: JSON.stringify({ error: `${RAW_COLLECTION_MARKER}:refresh:${mode}` }),
          });
        }
        return json(route, refreshScheduleFixture(mode, refreshMatch[1]));
      }
    }
    if (url.pathname === '/api/generate-embed-url') {
      evidence.embedGenerationBodies.push(body);
      const mode = evidence.embedGenerationMode;
      if (mode === 'pending') {
        await new Promise<void>((resolve) => {
          evidence.releaseEmbedGeneration = resolve;
        });
        evidence.releaseEmbedGeneration = null;
      }
      if (mode === 'error') {
        return route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Fixture signing failed safely.' }),
        });
      }
      return json(route, {
        url: `${TENANT_ORIGIN}/embed/login?contentPath=%2Fdashboards%2Fqa&externalId=fixture&name=Fixture&nonce=fixtureNonceValue1&signature=fixtureSignatureValueThatIsLongEnough12345`,
      });
    }
    if (url.pathname === '/api/manage-users' && body.action === 'list') {
      const startIndex = Number(body.start_index || 1);
      if (options.userPagination === 'later_failure') {
        if (startIndex === 1) {
          return json(route, {
            Resources: [{
              id: 'user-partial-1',
              userName: 'user-partial-1@example.invalid',
              displayName: 'Partial Fixture User',
              active: true,
            }],
            totalResults: 2,
            itemsPerPage: 1,
            startIndex: 1,
          });
        }
        return json(route, {
          totalResults: 2,
          itemsPerPage: 1,
          startIndex,
          diagnostic: RAW_COLLECTION_MARKER,
        });
      }
      if (options.userPagination === 'attributes_complete') {
        return json(route, {
          Resources: [{
            id: 'user-attributes-1',
            userName: 'attributes.user@example.invalid',
            displayName: 'Attribute Fixture User',
            active: true,
            'urn:omni:params:1.0:UserAttribute': {
              department: 'Architecture',
              quota: 12.5,
              regions: ['Central', 'West', 'Central'],
              thresholds: [2, 1.5, 2],
              unassigned: [],
            },
          }],
          totalResults: 1,
          itemsPerPage: 1,
          startIndex: 1,
        });
      }
      const requested = Number(body.count || 100);
      const count = Math.min(requested, Math.max(0, 250 - startIndex + 1));
      return json(route, {
        Resources: Array.from({ length: count }, (_, index) => ({
          id: `user-${startIndex + index}`,
          userName: `user-${startIndex + index}@example.invalid`,
          displayName: `Fixture User ${startIndex + index}`,
          active: true,
        })),
        totalResults: 250,
        itemsPerPage: count,
        startIndex,
      });
    }
    if (url.pathname === '/api/manage-users' && body.action === 'update') {
      const userData = body.user_data && typeof body.user_data === 'object'
        ? body.user_data as Record<string, unknown>
        : {};
      evidence.userUpdateBodies.push(userData);
      return json(route, { id: String(body.user_id || 'updated-user'), ...userData });
    }
    if (url.pathname === '/api/manage-users' && body.action === 'create') {
      if (evidence.pendingWriteAction === 'user_create') {
        await new Promise<void>((resolve) => {
          evidence.releasePendingWrite = resolve;
        });
        evidence.releasePendingWrite = null;
      }
      const userData = body.user_data && typeof body.user_data === 'object'
        ? body.user_data as Record<string, unknown>
        : {};
      return json(route, { id: 'created-user', ...userData });
    }
    if (url.pathname === '/api/manage-groups' && body.action === 'list' && options.groupPagination) {
      const startIndex = Number(body.start_index || 1);
      evidence.groupListStartIndices.push(startIndex);
      if (options.groupPagination === 'missing_members') {
        return json(route, {
          Resources: [{ id: 'group-missing-members', displayName: 'Missing Membership Group' }],
          totalResults: 1,
          itemsPerPage: 1,
          startIndex: 1,
        });
      }
      if (options.groupPagination === 'unresolved_member') {
        return json(route, {
          Resources: [{
            id: 'group-unresolved',
            displayName: 'Unresolved Group',
            members: [{ value: 'missing-user-id', display: 'looks.resolved@example.invalid' }],
          }],
          totalResults: 1,
          itemsPerPage: 1,
          startIndex: 1,
        });
      }
      if (options.groupPagination === 'later_failure' && startIndex > 1) {
        return json(route, {
          totalResults: 5,
          itemsPerPage: 2,
          startIndex,
          diagnostic: RAW_COLLECTION_MARKER,
        });
      }
      const count = Math.min(2, Math.max(0, 5 - startIndex + 1));
      return json(route, {
        Resources: Array.from({ length: count }, (_, index) => ({
          id: `group-${startIndex + index}`,
          displayName: `Group ${startIndex + index}`,
          members: [],
        })),
        totalResults: 5,
        itemsPerPage: count,
        startIndex,
      });
    }
    if (url.pathname === '/api/manage-groups' && body.action === 'get' && options.groupPagination) {
      const groupId = String(body.group_id || 'group-1');
      const ordinal = groupId.replace(/^group-/, '');
      if (options.groupPagination === 'missing_members') {
        return json(route, { id: groupId, displayName: 'Missing Membership Group' });
      }
      if (options.groupPagination === 'unresolved_member') {
        return json(route, {
          id: groupId,
          displayName: 'Unresolved Group',
          members: [{ value: 'missing-user-id', display: 'looks.resolved@example.invalid' }],
        });
      }
      return json(route, { id: groupId, displayName: `Group ${ordinal}`, members: [] });
    }
    if (url.pathname === '/api/manage-groups' && body.action === 'patch' && options.groupPagination) {
      if (evidence.pendingWriteAction === 'group_patch') {
        await new Promise<void>((resolve) => {
          evidence.releasePendingWrite = resolve;
        });
        evidence.releasePendingWrite = null;
      }
      return json(route, { id: String(body.group_id || 'group-1') });
    }
    if (url.pathname === '/api/list-models') {
      const mode = evidence.adminCollectionModes.schemaModels;
      if (isEvidenceFailureMode(mode)) {
        return route.fulfill({
          status: evidenceFailureStatus(mode),
          contentType: 'application/json',
          body: JSON.stringify({ error: `${RAW_COLLECTION_MARKER}:schema-models:${mode}` }),
        });
      }
      if (mode === 'malformed') {
        return json(route, {
          error: `${RAW_COLLECTION_MARKER}:schema-models`,
          models: [],
          pageInfo: terminalCollectionPage(0, 100),
          pagesFetched: 1,
          complete: true,
          loadedResults: 0,
          totalResults: 0,
        });
      }
      const scope = tenantConnection(body.base_url);
      const models = mode === 'populated'
        ? [{ id: `model-${scope.id}`, name: `${scope.name} schema`, kind: 'SCHEMA', connectionId: scope.id, deletedAt: null }]
        : mode === 'wrong_attribution'
          ? [{ id: 'model-wrong-kind', name: 'Wrongly attributed model', kind: 'WORKBOOK', connectionId: scope.id, deletedAt: null }]
          : [];
      return json(route, {
        models,
        pageInfo: terminalCollectionPage(models.length, 100),
        pagesFetched: 1,
        complete: true,
        loadedResults: models.length,
        totalResults: models.length,
      });
    }
    if (url.pathname === '/api/list-folders' && options.contentDocuments) {
      return json(route, {
        folders: [{ id: 'folder-qa', name: 'QA Folder', path: 'QA Folder', children: [] }],
        pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 1 },
        pagesFetched: 1,
        complete: true,
        loadedResults: 1,
        totalResults: 1,
      });
    }
    if (url.pathname === '/api/list-documents' && options.contentDocuments) {
      if (options.contentDocuments === 'error') {
        return json(route, { error: 'RAW_UPSTREAM_ERROR_MUST_NOT_BECOME_ZERO', documents: [] });
      }
      if (options.contentDocuments === 'malformed') {
        return json(route, {
          documents: 'not-a-collection',
          pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
          pagesFetched: 1,
          complete: true,
          loadedResults: 0,
          totalResults: 0,
        });
      }
      return json(route, {
        documents: [],
        pageInfo: { hasNextPage: false, nextCursor: null, pageSize: 100, totalRecords: 0 },
        pagesFetched: 1,
        complete: true,
        loadedResults: 0,
        totalResults: 0,
      });
    }
    if (url.pathname === '/api/list-documents') {
      return json(route, scheduleDocumentFixture(evidence.adminCollectionModes.scheduleDocuments));
    }
    if (url.pathname === '/api/portfolio-overview') return json(route, portfolioFixture());
    if (url.pathname.startsWith('/api/instance-dashboard/')) return json(route, { instances: [] });
    return json(route, {
      Resources: [],
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
      records: [],
      pageInfo: { totalRecords: 0, pageSize: 50, currentPage: 1 },
      folders: [],
      labels: [],
      documents: [],
      connections: [],
      schedules: [],
      dashboards: [],
      models: [],
      items: [],
    });
  });

  return evidence;
}

async function closeWalkthrough(page: Page) {
  const close = page.getByRole('button', { name: 'Close walkthrough' });
  if (await close.isVisible().catch(() => false)) await close.click();
}

function assertIsolated(evidence: IsolationEvidence, expectedTenantWrites: string[] = []) {
  expect(evidence.escapedTenantRequests, 'a browser request escaped to the neutral .invalid tenant').toEqual([]);
  expect(evidence.tenantWrites, 'only explicitly controlled and intercepted tenant writes may be attempted').toEqual(expectedTenantWrites);
  expect(evidence.pageErrors, 'admin readiness page errors').toEqual([]);
}

async function verifyReadiness(page: Page, testId: string) {
  await closeWalkthrough(page);
  if (testId === 'admin-readiness-fleet' && await page.getByTestId(testId).count() === 0) {
    await page.getByRole('button', { name: 'Readiness', exact: true }).first().click();
  }
  const surface = page.getByTestId(testId);
  await expect(surface.getByRole('heading', { name: 'Read-only readiness', exact: true })).toBeVisible();
  await surface.getByRole('button', { name: 'Verify read capabilities', exact: true }).click();
  return surface;
}

async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return Math.max(root.scrollWidth - root.clientWidth, body.scrollWidth - body.clientWidth);
  })).toBeLessThanOrEqual(0);
}

async function expectDialogFitsViewport(page: Page, dialog: ReturnType<Page['getByRole']>) {
  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      clientWidth: element.clientWidth,
      left: rect.left,
      right: rect.right,
      scrollWidth: element.scrollWidth,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + 1);
  expect(bounds.top).toBeGreaterThanOrEqual(-1);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight + 1);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  await expectNoDocumentOverflow(page);
}

async function expectDialogAxeClear(page: Page, selector: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .include(selector)
    .analyze();
  const blocking = results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact || ''));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test.afterEach(async ({ request }) => {
  await request.delete('/api/vault/reset');
});

test('all four workspaces render exact evidence/readiness states without false zero', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request);
  const workspaces = [
    {
      path: '/admin/fleet/instances',
      testId: 'admin-readiness-fleet',
      assertions: [
        ['fleet.folder_read', 'Available', 'Ready'],
        ['fleet.api_tokens', 'Unauthorized', 'Action required'],
        ['fleet.organization_api_key_confirmation', 'Not checked', 'Unknown'],
        ['fleet.current_token_introspection', 'Unavailable', 'Unknown'],
      ],
    },
    {
      path: '/admin/identity/users',
      testId: 'admin-readiness-identity',
      assertions: [
        ['identity.scim_users', 'Partial', 'Action required'],
        ['identity.scim_groups', 'Available', 'Ready'],
        ['identity.user_attributes', 'Unauthorized', 'Action required'],
      ],
    },
    {
      path: '/admin/content/health',
      testId: 'admin-readiness-content',
      assertions: [['content.schedules', 'Failed', 'Unknown']],
    },
    {
      path: '/admin/developer/embeds',
      testId: 'admin-readiness-developer',
      assertions: [
        ['developer.embed_users', 'Stale', 'Unknown'],
        ['developer.sso_configuration', 'Unsupported', 'Not configured'],
        ['developer.audit_configuration', 'Unsupported', 'Not configured'],
        ['developer.api_explorer', 'Available', 'Ready'],
      ],
    },
  ] as const;

  for (const workspace of workspaces) {
    await page.goto(workspace.path);
    await closeWalkthrough(page);
    const surface = await verifyReadiness(page, workspace.testId);
    for (const [capabilityId, evidenceState, readinessState] of workspace.assertions) {
      const row = surface.locator(`[data-capability-id="${capabilityId}"]`);
      await expect(row).toContainText(evidenceState);
      await expect(row).toContainText(readinessState);
    }
  }

  const availableZero = page.getByTestId('admin-readiness-fleet').locator('[data-capability-id="fleet.folder_read"]');
  await page.goto('/admin/fleet/instances');
  await verifyReadiness(page, 'admin-readiness-fleet');
  await expect(availableZero).toContainText('0');
  for (const id of ['fleet.api_tokens', 'fleet.current_token_introspection']) {
    await expect(page.locator(`[data-capability-id="${id}"]`)).not.toContainText(/\b0\b/);
  }

  const readinessUrls = evidence.adminReadinessRequests.map((value) => new URL(value));
  expect(readinessUrls.length).toBe(workspaces.length + 1);
  expect(readinessUrls.every((url) => url.pathname === '/api/admin-readiness')).toBeTruthy();
  expect(readinessUrls.every((url) => !url.searchParams.has('api_key') && !url.searchParams.has('base_url'))).toBeTruthy();
  assertIsolated(evidence);
});

test('large identity summaries stay bounded and access posture is one explicit lazy read rather than N+1', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request);
  await page.goto('/admin/identity/users');
  await closeWalkthrough(page);
  const surface = await verifyReadiness(page, 'admin-readiness-identity');

  await expect(surface.locator('[data-capability-id="identity.scim_users"]')).toContainText('250 of 300');
  await expect(surface.locator('[data-capability-id="identity.scim_groups"]')).toContainText('100 of 100');
  const identityRequests = evidence.adminReadinessRequests
    .map((value) => new URL(value))
    .filter((url) => url.searchParams.get('workspace') === 'identity');
  expect(identityRequests).toHaveLength(1);
  expect(identityRequests[0].searchParams.has('principalType')).toBeFalsy();
  expect(identityRequests[0].searchParams.has('principalId')).toBeFalsy();

  await page.getByRole('button', { name: 'Expand user-1@example.invalid', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect model-role assignments', exact: true }).click();
  await expect(page.locator('[data-access-posture-id="identity.user_model_roles"]')).toBeVisible();
  const afterInspection = evidence.adminReadinessRequests
    .map((value) => new URL(value))
    .filter((url) => url.searchParams.get('workspace') === 'identity');
  expect(afterInspection).toHaveLength(2);
  const postureRequests = afterInspection.filter((url) => url.searchParams.has('principalType'));
  expect(postureRequests).toHaveLength(1);
  expect(postureRequests[0].searchParams.get('principalType')).toBe('user');
  expect(postureRequests[0].searchParams.get('principalId')).toBe('user-1');
  assertIsolated(evidence);
});

test('safe actions and existing administration workflows remain reachable', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request);

  await page.goto('/admin/fleet/instances');
  await verifyReadiness(page, 'admin-readiness-fleet');
  await expect(page.getByRole('heading', { name: 'Instance Manager', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connections', exact: true })).toBeVisible();

  await page.goto('/admin/identity/users');
  await verifyReadiness(page, 'admin-readiness-identity');
  await expect(page.getByRole('button', { name: 'Create User', exact: true })).toBeVisible();

  await page.goto('/admin/content/health');
  await verifyReadiness(page, 'admin-readiness-content');
  await expect(page.getByLabel('Content folder')).toBeVisible();
  await page.goto('/admin/content/schedules');
  await expect(page.getByRole('button', { name: 'Create Schedule', exact: true })).toBeVisible();
  await expect(page.getByLabel('Schedule status')).toBeVisible();

  await page.goto('/admin/developer/embeds');
  const developer = await verifyReadiness(page, 'admin-readiness-developer');
  await expect(page.getByPlaceholder('/dashboards/my-dashboard')).toBeVisible();
  const apiExplorer = developer.getByRole('link', { name: 'Open API Explorer', exact: true });
  await expect(apiExplorer).toHaveAttribute('href', `${TENANT_ORIGIN}/api-explorer`);
  await expect(developer.locator('a[href*="attacker"]')).toHaveCount(0);
  assertIsolated(evidence);
});

test('Developer embed signing invalidates stale output, locks pending claims, omits a URL ledger, and announces errors', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request);
  await page.goto('/admin/developer/embeds');
  await closeWalkthrough(page);

  const contentPath = page.getByLabel('Content Path *', { exact: true });
  const externalId = page.getByLabel('External ID *', { exact: true });
  const name = page.getByLabel('Name *', { exact: true });
  const embedSecret = page.getByLabel('Embed Secret *', { exact: true });
  const email = page.getByLabel('Email', { exact: true });
  const groups = page.getByLabel('Groups (comma-separated)', { exact: true });
  const generate = page.getByRole('button', { name: 'Generate Embed URL', exact: true });
  const generatedHeading = page.getByRole('heading', { name: 'Generated URL', exact: true });

  await contentPath.fill('/dashboards/qa');
  await externalId.fill('fixture-identity-1');
  await name.fill('Fixture Identity');
  await email.fill('fixture.identity@example.invalid');
  await groups.fill('Analysts, Operators');

  const identityMutations = [
    { input: externalId, value: 'fixture-identity-2' },
    { input: name, value: 'Updated Fixture Identity' },
    { input: email, value: 'updated.fixture@example.invalid' },
    { input: groups, value: 'Analysts, Reviewers' },
  ];
  for (const mutation of identityMutations) {
    await embedSecret.fill('request-only-secret-not-real');
    await generate.click();
    await expect(generatedHeading).toBeVisible();
    await expect(page.getByText('Recent URLs', { exact: true })).toHaveCount(0);
    await mutation.input.fill(mutation.value);
    await expect(generatedHeading).toHaveCount(0);
  }

  await embedSecret.fill('pending-request-secret-not-real');
  evidence.embedGenerationMode = 'pending';
  await generate.click();
  await expect.poll(() => evidence.releaseEmbedGeneration !== null).toBeTruthy();
  await expect(generate).toHaveAttribute('aria-busy', 'true');
  for (const input of [contentPath, externalId, name, embedSecret, email, groups]) {
    await expect(input).toBeDisabled();
  }
  evidence.releaseEmbedGeneration?.();
  await expect(generatedHeading).toBeVisible();

  evidence.embedGenerationMode = 'error';
  await embedSecret.fill('error-request-secret-not-real');
  await generate.click();
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/Failed to generate embed URL|Fixture signing failed safely/);
  await expect(generatedHeading).toHaveCount(0);
  await expect(embedSecret).toHaveValue('');
  await expect(page.getByText('Recent URLs', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/request-only-secret-not-real|pending-request-secret-not-real|error-request-secret-not-real/)).toHaveCount(0);

  expect(evidence.embedGenerationBodies).toHaveLength(identityMutations.length + 2);
  assertIsolated(evidence);
});

test('readiness verification is keyboard operable, Axe-clean, and overflow-safe at 320px', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/admin/developer/embeds');
  await closeWalkthrough(page);

  const surface = page.getByTestId('admin-readiness-developer');
  const verify = surface.getByRole('button', { name: 'Verify read capabilities', exact: true });
  await verify.focus();
  await verify.press('Enter');
  await expect(surface.locator('[data-capability-id="developer.sso_configuration"]')).toContainText('Unsupported');
  await expectNoDocumentOverflow(page);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .include('[data-testid="admin-readiness-developer"]')
    .analyze();
  const blocking = results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact || ''));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  assertIsolated(evidence);
});

test('multi-valued SCIM attributes render explicitly and user edits preserve untouched typed values', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { userPagination: 'attributes_complete' });
  const attributeUrn = 'urn:omni:params:1.0:UserAttribute';
  await page.goto('/admin/identity/users');
  await closeWalkthrough(page);

  await page.getByRole('button', { name: 'Expand attributes.user@example.invalid', exact: true }).click();
  await expect(page.getByRole('list', { name: 'regions values', exact: true }).first().getByRole('listitem')).toHaveText([
    'Central',
    'West',
    'Central',
  ]);
  await expect(page.getByText('Central,West,Central', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Edit attributes.user@example.invalid', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Edit User', exact: true });
  await expect(dialog.getByRole('list', { name: 'thresholds values', exact: true }).getByRole('listitem')).toHaveText([
    '2',
    '1.5',
    '2',
  ]);
  await expect(dialog.getByText('No assigned values', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Read-only in OmniKit. Saving other changes preserves this value exactly.', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove regions attribute', exact: true })).toHaveCount(0);
  await dialog.getByLabel('Display Name', { exact: true }).fill('Renamed Attribute Fixture');
  await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await expect.poll(() => evidence.userUpdateBodies.length).toBe(1);
  expect(Object.prototype.hasOwnProperty.call(evidence.userUpdateBodies[0], attributeUrn)).toBe(false);

  await page.getByRole('button', { name: 'Edit attributes.user@example.invalid', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit User', exact: true });
  await dialog.getByLabel('Attribute key', { exact: true }).fill('__PrOtO__');
  await dialog.getByLabel('Attribute value', { exact: true }).fill('must-not-be-sent');
  await dialog.getByRole('button', { name: 'Add custom attribute', exact: true }).click();
  await expect(dialog.getByText(/cannot use reserved prototype names/i)).toBeVisible();
  expect(evidence.userUpdateBodies).toHaveLength(1);
  await dialog.getByLabel('Attribute key', { exact: true }).fill('department');
  await dialog.getByLabel('Attribute value', { exact: true }).fill('Product');
  await dialog.getByRole('button', { name: 'Add custom attribute', exact: true }).click();
  await expect(dialog.getByRole('list', { name: 'regions values', exact: true }).getByRole('listitem')).toHaveText([
    'Central', 'West', 'Central',
  ]);
  await expect(dialog.getByRole('list', { name: 'thresholds values', exact: true }).getByRole('listitem')).toHaveText([
    '2', '1.5', '2',
  ]);
  await expect(dialog.getByText('No assigned values', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await expect.poll(() => evidence.userUpdateBodies.length).toBe(2);
  // An attribute edit patches only the changed value; untouched typed values are not echoed or replaced.
  expect(evidence.userUpdateBodies[1][attributeUrn]).toEqual({
    department: 'Product',
  });

  assertIsolated(evidence, ['POST /api/manage-users', 'POST /api/manage-users']);
});

test('partial SCIM user coverage stays exact and blocks user export', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { userPagination: 'later_failure' });
  await page.goto('/admin/identity/users');
  await closeWalkthrough(page);

  await expect(page.getByText('User collection is partial: 1 of 2 records were loaded.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Omni reports 2 total users; 1 (?:is|are) loaded\./).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export Users', exact: true })).toBeDisabled();
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  assertIsolated(evidence);
});

test('partial SCIM group coverage disables export, group targeting, and every membership mutation control', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { groupPagination: 'later_failure' });
  await page.goto('/admin/identity/users?tab=groups');
  await closeWalkthrough(page);

  await expect(page.getByText('Group collection is incomplete: 2 of 5 records were loaded. Export and membership changes are blocked.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export Memberships', exact: true })).toBeDisabled();
  const assignment = page.locator('fieldset').filter({ hasText: 'Add multiple users to a group' });
  await expect(assignment.locator('select')).toBeDisabled();
  await expect(assignment.getByRole('button', { name: 'Load Users', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /Group 1/ }).first().click();
  await expect(page.getByRole('button', { name: 'Add member to Group 1', exact: true })).toBeDisabled();
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  assertIsolated(evidence);
});

test('partial assignment-user coverage clears the picker and cannot produce a membership write or export', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    groupPagination: 'short_complete',
    userPagination: 'later_failure',
  });
  await page.goto('/admin/identity/users?tab=groups');
  await closeWalkthrough(page);

  const assignment = page.locator('fieldset').filter({ hasText: 'Add multiple users to a group' });
  await assignment.locator('select').selectOption('group-1');
  await assignment.getByRole('button', { name: 'Load Users', exact: true }).click();
  await expect(page.getByText('User collection is incomplete: 1 of 2 records were loaded. Export and membership changes are blocked.', { exact: true })).toBeVisible();
  await expect(assignment.getByText('Load users to assign group membership from the UI.', { exact: true })).toBeVisible();
  await expect(assignment.getByRole('checkbox')).toHaveCount(0);
  await expect(assignment.getByRole('button', { name: 'Add Selected to Group 1', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'Export Memberships', exact: true }).click();
  await expect(page.getByText('User collection is incomplete: 1 of 2 records were loaded. Export and membership changes are blocked.', { exact: true })).toBeVisible();
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  assertIsolated(evidence);
});

test('membership export aborts when a complete read contains an unresolved member identity', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { groupPagination: 'unresolved_member' });
  await page.goto('/admin/identity/users?tab=groups');
  await closeWalkthrough(page);

  await page.getByRole('button', { name: 'Export Memberships', exact: true }).click();
  await expect(page.getByText('Membership export was blocked because 1 member identity is unresolved. No partial CSV was created.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Group membership export started/)).toHaveCount(0);
  assertIsolated(evidence);
});

test('missing membership detail cannot be cached as empty or authorize export and bulk assignment', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { groupPagination: 'missing_members' });
  await page.goto('/admin/identity/users?tab=groups');
  await closeWalkthrough(page);

  await page.getByRole('button', { name: /Missing Membership Group/ }).first().click();
  await expect(page.getByText('Membership detail has not been verified. No member count is claimed.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Export Memberships', exact: true }).click();
  await expect(page.getByText('Group membership evidence is unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Group membership export started/)).toHaveCount(0);

  const assignment = page.locator('fieldset').filter({ hasText: 'Add multiple users to a group' });
  await assignment.getByRole('button', { name: 'Load Users', exact: true }).click();
  await expect(assignment.getByRole('checkbox').first()).toBeVisible();
  await assignment.getByRole('checkbox').first().check();
  await assignment.getByRole('button', { name: 'Add Selected to Missing Membership Group', exact: true }).click();
  await expect(page.getByText('Group membership evidence is unavailable.', { exact: true })).toBeVisible();
  expect(evidence.tenantWrites).toEqual([]);
  assertIsolated(evidence);
});

test('Create User and Add Member dialogs are labeled, focus-safe, Axe-clean, and overflow-safe at 320px', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { groupPagination: 'short_complete' });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/admin/identity/users');
  await closeWalkthrough(page);

  const createOpener = page.getByRole('button', { name: 'Create User', exact: true }).first();
  await createOpener.focus();
  await createOpener.press('Enter');
  const createDialog = page.getByRole('dialog', { name: 'Create User', exact: true });
  await expect(createDialog).toBeVisible();
  const email = createDialog.getByLabel('Email', { exact: true });
  const displayName = createDialog.getByLabel('Display Name', { exact: true });
  await expect(email).toBeFocused();
  await expect(displayName).toBeVisible();
  await expect(createDialog.getByLabel('Attribute key', { exact: true })).toBeVisible();
  await expect(createDialog.getByLabel('Attribute value', { exact: true })).toBeVisible();
  await expect(createDialog.getByRole('button', { name: 'Add custom attribute', exact: true })).toBeVisible();
  const createClose = createDialog.getByRole('button', { name: 'Close user form', exact: true });
  await expect(createClose).toBeVisible();
  await email.fill('fixture.user@example.invalid');
  await displayName.fill('Fixture User');
  const createSubmit = createDialog.getByRole('button', { name: 'Create User', exact: true });
  await createSubmit.scrollIntoViewIfNeeded();
  await expect(createSubmit).toBeVisible();
  await createSubmit.focus();
  await createSubmit.press('Tab');
  await expect(createClose).toBeFocused();
  await createClose.press('Shift+Tab');
  await expect(createSubmit).toBeFocused();
  await expectDialogFitsViewport(page, createDialog);
  await expectDialogAxeClear(page, '[role="dialog"][aria-labelledby="user-form-title"]');
  await page.keyboard.press('Escape');
  await expect(createDialog).toBeHidden();
  await expect(createOpener).toBeFocused();

  await page.goto('/admin/identity/users?tab=groups');
  await closeWalkthrough(page);
  const groupRow = page.getByRole('button', { name: /Group 1/ }).first();
  await groupRow.click();
  const memberOpener = page.getByRole('button', { name: 'Add member to Group 1', exact: true });
  await expect(memberOpener).toBeVisible();
  await memberOpener.focus();
  await memberOpener.press('Enter');
  const memberDialog = page.getByRole('dialog', { name: 'Add Member', exact: true });
  await expect(memberDialog).toBeVisible();
  await expect(memberDialog).toHaveAccessibleDescription('Add a user to "Group 1" by email.');
  const memberEmail = memberDialog.getByLabel('Member email', { exact: true });
  await expect(memberEmail).toBeFocused();
  const memberClose = memberDialog.getByRole('button', { name: 'Close add member dialog', exact: true });
  await expect(memberClose).toBeVisible();
  await memberEmail.fill('new.member@example.invalid');
  const memberSubmit = memberDialog.getByRole('button', { name: 'Add Member', exact: true });
  await memberSubmit.scrollIntoViewIfNeeded();
  await expect(memberSubmit).toBeVisible();
  await memberSubmit.focus();
  await memberSubmit.press('Tab');
  await expect(memberClose).toBeFocused();
  await memberClose.press('Shift+Tab');
  await expect(memberSubmit).toBeFocused();
  await expectDialogFitsViewport(page, memberDialog);
  await expectDialogAxeClear(page, '[role="dialog"][aria-labelledby="add-member-title"]');
  await page.keyboard.press('Escape');
  await expect(memberDialog).toBeHidden();
  await expect(memberOpener).toBeFocused();
  assertIsolated(evidence);
});

test('bulk user and group assignment editors stay immutable while intercepted writes are pending', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { groupPagination: 'short_complete' });
  await page.goto('/admin/identity/users');
  await closeWalkthrough(page);

  await page.getByRole('button', { name: 'Add User Row', exact: true }).click();
  const bulkEmail = page.getByPlaceholder('new.user@example.com', { exact: true });
  const bulkName = page.getByPlaceholder('New User', { exact: true });
  const bulkDepartment = page.getByPlaceholder('Sales', { exact: true });
  const bulkRole = page.getByPlaceholder('Optional attribute', { exact: true });
  await bulkEmail.fill('pending.user@example.invalid');
  await bulkName.fill('Pending User');
  await bulkDepartment.fill('Architecture');
  await bulkRole.fill('viewer');
  const createMany = page.getByRole('button', { name: 'Create 1 User', exact: true });

  evidence.pendingWriteAction = 'user_create';
  await createMany.click();
  await expect.poll(() => evidence.releasePendingWrite !== null).toBeTruthy();
  for (const input of [bulkEmail, bulkName, bulkDepartment, bulkRole]) {
    await expect(input).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: 'Add User Row', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
  await expect(createMany).toBeDisabled();
  await expect(bulkEmail).toHaveValue('pending.user@example.invalid');
  await expect(bulkName).toHaveValue('Pending User');
  evidence.releasePendingWrite?.();
  await expect(page.getByText(/User creation complete 1\/1/)).toBeVisible();

  await page.goto('/admin/identity/users?tab=groups');
  await closeWalkthrough(page);
  const assignmentFieldset = page.locator('fieldset').filter({ hasText: 'Add multiple users to a group' });
  const targetGroup = assignmentFieldset.locator('select');
  await targetGroup.selectOption('group-1');
  await assignmentFieldset.getByRole('button', { name: 'Load Users', exact: true }).click();
  const selectedUser = assignmentFieldset.getByRole('checkbox').first();
  await expect(selectedUser).toBeVisible();
  await selectedUser.check();
  const assign = assignmentFieldset.getByRole('button', { name: 'Add Selected to Group 1', exact: true });

  evidence.pendingWriteAction = 'group_patch';
  await assign.click();
  await expect.poll(() => evidence.releasePendingWrite !== null).toBeTruthy();
  await expect(targetGroup).toBeDisabled();
  await expect(selectedUser).toBeDisabled();
  await expect(assignmentFieldset.getByPlaceholder('Filter users by email or name...', { exact: true })).toBeDisabled();
  await expect(assignmentFieldset.getByRole('button', { name: 'Refresh Users', exact: true })).toBeDisabled();
  await expect(assign).toBeDisabled();
  await expect(targetGroup).toHaveValue('group-1');
  await expect(selectedUser).toBeChecked();
  evidence.releasePendingWrite?.();
  await expect(assignmentFieldset.getByText('Added 1 user to Group 1.', { exact: true })).toBeVisible();

  assertIsolated(evidence, ['POST /api/manage-users', 'POST /api/manage-groups']);
});

test('Content Health treats an HTTP-200 error envelope as unavailable, never zero or all-clear', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { contentDocuments: 'error' });
  await page.goto('/admin/content/health');
  await closeWalkthrough(page);
  await expect(page.getByLabel('Content folder')).toHaveValue('folder-qa');
  await page.getByRole('button', { name: 'Scan Folder', exact: true }).click();

  await expect(page.getByText('Content collection is unavailable for this folder.', { exact: true })).toBeVisible();
  await expect(page.getByText('RAW_UPSTREAM_ERROR_MUST_NOT_BECOME_ZERO')).toHaveCount(0);
  const collectedCard = page.getByText('Collected Content', { exact: true }).locator('..');
  const reviewCard = page.getByText('Review Queue', { exact: true }).locator('..');
  await expect(collectedCard.getByText('-', { exact: true })).toBeVisible();
  await expect(reviewCard.getByText('-', { exact: true })).toBeVisible();
  await expect(page.getByText('Mapped', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No dashboard or workbook content was found in this folder.', { exact: true })).toHaveCount(0);
  assertIsolated(evidence);
});

test('Content Health preserves a verified complete empty collection as truthful zero', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { contentDocuments: 'empty' });
  await page.goto('/admin/content/health');
  await closeWalkthrough(page);
  await expect(page.getByLabel('Content folder')).toHaveValue('folder-qa');
  await page.getByRole('button', { name: 'Scan Folder', exact: true }).click();

  await expect(page.getByText('No dashboard or workbook content was found in this folder.', { exact: true })).toBeVisible();
  await expect(page.getByText('Content collection is unavailable for this folder.', { exact: true })).toHaveCount(0);
  const collectedCard = page.getByText('Collected Content', { exact: true }).locator('..');
  const reviewCard = page.getByText('Review Queue', { exact: true }).locator('..');
  await expect(collectedCard.getByText('0', { exact: true })).toBeVisible();
  await expect(reviewCard.getByText('0', { exact: true })).toBeVisible();
  assertIsolated(evidence);
});

test('strict short-page group pagination loads every record before presenting complete results', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { groupPagination: 'short_complete' });
  await page.goto('/admin/identity/users?tab=groups');
  await closeWalkthrough(page);

  for (let index = 1; index <= 5; index += 1) {
    await expect(page.getByRole('button', { name: `Group ${index} 0 members`, exact: true })).toBeVisible();
  }
  await expect.poll(() => evidence.groupListStartIndices).toEqual([1, 3, 5]);
  await expect(page.getByText(/Group collection is partial/)).toHaveCount(0);
  await expect(page.getByText('Group records were not loaded', { exact: true })).toHaveCount(0);
  await page.getByPlaceholder('Filter groups...', { exact: true }).fill('no-loaded-group-matches');
  await expect(page.getByText('No loaded groups match this filter', { exact: true })).toBeVisible();
  await expect(page.getByText('No groups found', { exact: true })).toHaveCount(0);
  assertIsolated(evidence);
});

test('Connection Readiness fails closed on malformed success and preserves verified empty and populated evidence', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: { connections: 'malformed' },
  });
  await page.goto('/admin/fleet/connections');
  await closeWalkthrough(page);

  await expect(page.getByText('Connection inventory is unavailable because the response could not be verified.', { exact: true })).toBeVisible();
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  await expect(page.getByText('Connection inventory is unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByText('No connections found.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Active Connections', { exact: true }).locator('..')).toContainText('Inventory unavailable');

  evidence.adminCollectionModes.connections = 'empty';
  evidence.adminCollectionModes.schemaModels = 'empty';
  await page.reload();
  await expect(page.getByText('No connections found.', { exact: true })).toBeVisible();
  await expect(page.getByText('Active Connections', { exact: true }).locator('..')).toContainText('0');
  await expect(page.getByText('Connection inventory is unavailable.', { exact: true })).toHaveCount(0);

  evidence.adminCollectionModes.connections = 'populated';
  evidence.adminCollectionModes.schemaModels = 'populated';
  await page.reload();
  const connectionRow = page.getByRole('button', { name: 'Expand configuration evidence for QA Warehouse', exact: true });
  await expect(connectionRow).toBeVisible();
  await expect(page.getByText('Active Connections', { exact: true }).locator('..')).toContainText('1');
  const reviewCard = page.getByText('Review Queue', { exact: true }).locator('..');
  await expect(reviewCard.getByText('-', { exact: true })).toBeVisible();
  await expect(reviewCard.getByText('0', { exact: true })).toHaveCount(0);
  await connectionRow.click();
  await expect(page.getByText('qa-stale-branch', { exact: true })).toBeVisible();
  await expect(page.getByText('dbt Configured', { exact: true }).locator('..')).toContainText('1 configured · 1 of 1 active connections checked');
  await page.getByRole('button', { name: 'Schema Refresh', exact: true }).click();
  await expect(page.getByText('Daily at 6:00 UTC', { exact: true })).toBeVisible();
  await expect(page.getByText('Configured', { exact: true })).toBeVisible();
  await expect(reviewCard.getByText('0', { exact: true })).toBeVisible();
  assertIsolated(evidence);
});

test('Connection Readiness keeps malformed schema-model and detail evidence unavailable instead of implying missing configuration', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: {
      dbt: 'malformed',
      connections: 'populated',
      refreshSchedules: 'malformed',
      schemaModels: 'wrong_attribution',
    },
  });
  await page.goto('/admin/fleet/connections');
  await closeWalkthrough(page);

  const schemaCard = page.getByText('Schema Models', { exact: true }).locator('..');
  await expect(schemaCard).toContainText('Failed schema evidence');
  await expect(schemaCard).not.toContainText('0/1');
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);

  const connectionRow = page.getByRole('button', { name: 'Expand configuration evidence for QA Warehouse', exact: true });
  await expect(connectionRow).toBeVisible();
  await connectionRow.click();
  await expect(page.getByText(
    'dbt evidence failed. The evidence read failed.',
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText('dbt not configured for this connection.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No dbt', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Schema Refresh', exact: true }).click();
  await expect(page.getByText(
    'Refresh schedule evidence failed. The evidence read failed.',
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText('No schema refresh schedules configured.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No refresh', { exact: true })).toHaveCount(0);
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);

  const reviewCard = page.getByText('Review Queue', { exact: true }).locator('..');
  await expect(reviewCard.getByText('-', { exact: true })).toBeVisible();
  await expect(reviewCard.getByText('0', { exact: true })).toHaveCount(0);
  await expect(reviewCard).toContainText('2 detail checks unavailable');
  assertIsolated(evidence);
});

test('Connection Readiness distinguishes official dbt configured, not-configured, and unsupported evidence', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: {
      connections: 'populated',
      dbt: 'not_configured',
      refreshSchedules: 'multiple',
      schemaModels: 'populated',
    },
  });
  await page.goto('/admin/fleet/connections');
  await closeWalkthrough(page);

  let connectionRow = page.getByRole('button', { name: 'Expand configuration evidence for QA Warehouse', exact: true });
  await connectionRow.click();
  await expect(page.getByText('Omni reports no dbt configuration for this connection.', { exact: true })).toBeVisible();
  await expect(page.getByText('dbt not configured for this connection', { exact: true })).toHaveCount(0);
  await expect(page.getByText('dbt Configured', { exact: true }).locator('..')).toContainText('0 configured · 1 of 1 active connections checked');
  await expect(page.getByText('Connections with Refresh', { exact: true }).locator('..')).toContainText('1 with refresh · 1 of 1 active connections checked');
  await expect(page.getByText('Review Queue', { exact: true }).locator('..')).toContainText('1');
  await expect(page.getByRole('button', { name: 'Collapse configuration evidence for QA Warehouse', exact: true })).toContainText('No dbt');
  await page.getByRole('button', { name: 'Schema Refresh', exact: true }).click();
  await expect(page.getByText('Daily at 6:00 UTC', { exact: true })).toBeVisible();
  await expect(page.getByText('Daily at 18:00 UTC', { exact: true })).toBeVisible();

  evidence.adminCollectionModes.dbt = 'not_supported';
  evidence.adminCollectionModes.refreshSchedules = 'empty';
  await page.reload();
  connectionRow = page.getByRole('button', { name: 'Expand configuration evidence for QA Warehouse', exact: true });
  await connectionRow.click();
  await expect(page.getByText('This connection dialect does not support dbt.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse configuration evidence for QA Warehouse', exact: true })).toContainText('No dbt config or refresh schedule');
  await expect(page.getByText('dbt Configured', { exact: true }).locator('..')).toContainText('0 configured · 1 of 1 active connections checked');
  await expect(page.getByText('Connections with Refresh', { exact: true }).locator('..')).toContainText('0 with refresh · 1 of 1 active connections checked');
  await expect(page.getByText('autogenRelationships:', { exact: true })).toHaveCount(0);
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  assertIsolated(evidence);
});

test('inactive connection details never complete active connection evidence coverage', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: {
      connections: 'active_and_deleted',
      dbt: 'configured',
      refreshSchedules: 'populated',
      schemaModels: 'populated',
    },
  });
  await page.goto('/admin/fleet/connections');
  await closeWalkthrough(page);

  const retiredRow = page.getByRole('button', { name: 'Expand configuration evidence for Retired Warehouse', exact: true });
  await retiredRow.click();
  await expect(page.getByText('qa-stale-branch', { exact: true })).toBeVisible();
  const dbtCard = page.getByText('dbt Configured', { exact: true }).locator('..');
  const refreshCard = page.getByText('Connections with Refresh', { exact: true }).locator('..');
  const reviewCard = page.getByText('Review Queue', { exact: true }).locator('..');
  await expect(dbtCard.getByText('-', { exact: true })).toBeVisible();
  await expect(dbtCard).toContainText('No active connections checked');
  await expect(refreshCard.getByText('-', { exact: true })).toBeVisible();
  await expect(reviewCard.getByText('-', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand configuration evidence for QA Warehouse', exact: true })).toContainText('Not inspected');
  assertIsolated(evidence);
});

test('Connection Readiness distinguishes unauthorized, unsupported, and unavailable collection evidence without false zeros', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: { connections: 'populated', schemaModels: 'unauthorized', dbt: 'unauthorized', refreshSchedules: 'unauthorized' },
  });
  const expectations = [
    ['unauthorized', 'Unauthorized', 'The saved credential is not authorized to read this evidence.'],
    ['unsupported', 'Unsupported', 'This evidence read is not supported by the connected instance.'],
    ['unavailable', 'Unavailable', 'This evidence is temporarily unavailable.'],
  ] as const;

  for (const [mode, label, message] of expectations) {
    evidence.adminCollectionModes.schemaModels = mode;
    evidence.adminCollectionModes.dbt = mode;
    evidence.adminCollectionModes.refreshSchedules = mode;
    await page.goto('/admin/fleet/connections');
    await closeWalkthrough(page);

    const schemaCard = page.getByText('Schema Models', { exact: true }).locator('..');
    await expect(schemaCard).toContainText(`${label} schema evidence`);
    await expect(schemaCard.getByText('-', { exact: true })).toBeVisible();
    const connectionRow = page.getByRole('button', { name: 'Expand configuration evidence for QA Warehouse', exact: true });
    await connectionRow.click();
    await expect(page.getByText(`dbt evidence ${label.toLowerCase()}. ${message}`, { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Schema Refresh', exact: true }).click();
    await expect(page.getByText(`Refresh schedule evidence ${label.toLowerCase()}. ${message}`, { exact: true })).toBeVisible({ timeout: 15_000 });
    for (const cardLabel of ['dbt Configured', 'Connections with Refresh', 'Review Queue']) {
      await expect(page.getByText(cardLabel, { exact: true }).locator('..').getByText('-', { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Needs schema model', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No dbt', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No refresh', { exact: true })).toHaveCount(0);
    await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  }

  evidence.adminCollectionModes.schemaModels = 'populated';
  evidence.adminCollectionModes.dbt = 'failed';
  evidence.adminCollectionModes.refreshSchedules = 'failed';
  await page.goto('/admin/fleet/connections');
  await closeWalkthrough(page);

  const failedRow = page.getByRole('button', { name: 'Expand configuration evidence for QA Warehouse', exact: true });
  await failedRow.click();
  await expect(page.getByText('dbt evidence failed. The evidence read failed.', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Schema Refresh', exact: true }).click();
  await expect(page.getByText('Refresh schedule evidence failed. The evidence read failed.', { exact: true })).toBeVisible({ timeout: 15_000 });
  for (const cardLabel of ['dbt Configured', 'Connections with Refresh', 'Review Queue']) {
    const card = page.getByText(cardLabel, { exact: true }).locator('..');
    await expect(card.getByText('-', { exact: true })).toBeVisible();
    await expect(card.getByText('0', { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText('No dbt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No refresh', { exact: true })).toHaveCount(0);
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  assertIsolated(evidence);
});

test('Connection Readiness clears populated and in-flight evidence before a saved instance replacement renders', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: { connections: 'populated', schemaModels: 'populated', dbt: 'configured', refreshSchedules: 'populated' },
  });
  const secondInstance = await addSavedInstance(request, 'Second readiness', SECOND_TENANT_ORIGIN);
  evidence.localConnectFixtures[secondInstance.id] = secondInstance;
  evidence.delayedDetailBaseUrl = TENANT_ORIGIN;
  evidence.delayedInventoryBaseUrl = SECOND_TENANT_ORIGIN;

  try {
    await page.goto('/admin/fleet/connections');
    await closeWalkthrough(page);
    const qaRow = page.getByRole('button', { name: 'Expand configuration evidence for QA Warehouse', exact: true });
    await expect(qaRow).toBeVisible();
    await qaRow.click();
    await expect.poll(() => evidence.pendingDetailRequests).toBe(2);

    await page.getByRole('button', { name: /Neutral admin readiness/ }).click();
    const savedInstances = page.getByRole('group', { name: 'Saved Omni instances' });
    await savedInstances.getByRole('button', { name: /Second readiness/ }).click();
    await expect(qaRow).toHaveCount(0);
    await expect(page.getByText('qa-stale-branch', { exact: true })).toHaveCount(0);

    evidence.releaseDelayedDetails?.();
    evidence.releaseDelayedDetails = null;
    evidence.delayedDetailBaseUrl = null;
    await expect.poll(() => evidence.pendingInventoryRequests).toBe(1);
    await expect(page.getByText('QA Warehouse', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Second Warehouse', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Active Connections', { exact: true }).locator('..').getByText('-', { exact: true })).toBeVisible();

    evidence.releaseDelayedInventory?.();
    evidence.releaseDelayedInventory = null;
    evidence.delayedInventoryBaseUrl = null;
    const secondRow = page.getByRole('button', { name: 'Expand configuration evidence for Second Warehouse', exact: true });
    await expect(secondRow).toBeVisible();
    await secondRow.click();
    await expect(page.getByText('second-current-branch', { exact: true })).toBeVisible();
    await expect(page.getByText('qa-stale-branch', { exact: true })).toHaveCount(0);
    await expect(page.getByText('QA Warehouse', { exact: true })).toHaveCount(0);
    assertIsolated(evidence);
  } finally {
    evidence.releaseDelayedDetails?.();
    evidence.releaseDelayedInventory?.();
  }
});

test('Schedule Management clears delayed old-tenant evidence and only renders the newly active saved instance', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { adminCollections: { schedules: 'populated' } });
  const secondInstance = await addSavedInstance(request, 'Second readiness', SECOND_TENANT_ORIGIN);
  evidence.localConnectFixtures[secondInstance.id] = secondInstance;

  await page.goto('/admin/content/schedules');
  await closeWalkthrough(page);
  await expect(page.getByText('Daily executive schedule', { exact: true })).toBeVisible();
  evidence.delayedScheduleBaseUrl = TENANT_ORIGIN;
  try {
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect.poll(() => evidence.pendingScheduleRequests).toBe(1);
    await expect(page.getByText('Loading schedules', { exact: true })).toBeVisible();
    await expect(page.getByText('Daily executive schedule', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: /Neutral admin readiness/ }).click();
    await page.getByRole('group', { name: 'Saved Omni instances' }).getByRole('button', { name: /Second readiness/ }).click();
    await expect(page.getByText('Second tenant schedule', { exact: true })).toBeVisible();
    await expect(page.getByText('Daily executive schedule', { exact: true })).toHaveCount(0);

    const staleResponse = page.waitForResponse((response) => {
      if (!response.url().endsWith('/api/omni-proxy')) return false;
      try {
        const body = response.request().postDataJSON() as Record<string, unknown>;
        return body.base_url === TENANT_ORIGIN && body.endpoint === '/v1/schedules';
      } catch {
        return false;
      }
    });
    evidence.releaseDelayedSchedule?.();
    await staleResponse;
    evidence.releaseDelayedSchedule = null;
    evidence.delayedSchedulePromise = null;
    evidence.delayedScheduleBaseUrl = null;
    await expect(page.getByText('Second tenant schedule', { exact: true })).toBeVisible();
    await expect(page.getByText('Daily executive schedule', { exact: true })).toHaveCount(0);
    assertIsolated(evidence);
  } finally {
    evidence.releaseDelayedSchedule?.();
  }
});

test('Upload Governance clears delayed old-tenant rows and cursor state before rendering the newly active saved instance', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, { adminCollections: { uploads: 'cursor_pages' } });
  const secondInstance = await addSavedInstance(request, 'Second readiness', SECOND_TENANT_ORIGIN);
  evidence.localConnectFixtures[secondInstance.id] = secondInstance;

  await page.goto('/admin/content/uploads');
  await closeWalkthrough(page);
  await expect(page.getByText('example-upload.csv', { exact: true })).toBeVisible();
  await expect(page.getByText('Page 1 · 2 of 5 loaded', { exact: true })).toBeVisible();
  evidence.delayedUploadBaseUrl = TENANT_ORIGIN;
  try {
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect.poll(() => evidence.pendingUploadRequests).toBe(1);
    await expect(page.getByText('Loading upload governance', { exact: true })).toBeVisible();
    await expect(page.getByText('example-upload.csv', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Page 1 · .* loaded/)).toHaveCount(0);

    await page.getByRole('button', { name: /Neutral admin readiness/ }).click();
    await page.getByRole('group', { name: 'Saved Omni instances' }).getByRole('button', { name: /Second readiness/ }).click();
    await expect(page.getByText('second-tenant-upload.csv', { exact: true })).toBeVisible();
    await expect(page.getByText('Page 1 · 2 of 5 loaded', { exact: true })).toBeVisible();
    await expect(page.getByText('example-upload.csv', { exact: true })).toHaveCount(0);

    const staleResponse = page.waitForResponse((response) => {
      if (!response.url().endsWith('/api/omni-proxy')) return false;
      try {
        const body = response.request().postDataJSON() as Record<string, unknown>;
        return body.base_url === TENANT_ORIGIN && body.endpoint === '/v1/uploads';
      } catch {
        return false;
      }
    });
    evidence.releaseDelayedUpload?.();
    await staleResponse;
    evidence.releaseDelayedUpload = null;
    evidence.delayedUploadPromise = null;
    evidence.delayedUploadBaseUrl = null;
    await expect(page.getByText('second-tenant-upload.csv', { exact: true })).toBeVisible();
    await expect(page.getByText('Page 1 · 2 of 5 loaded', { exact: true })).toBeVisible();
    await expect(page.getByText('example-upload.csv', { exact: true })).toHaveCount(0);
    assertIsolated(evidence);
  } finally {
    evidence.releaseDelayedUpload?.();
  }
});

test('top-level administration reads sanitize unauthorized, unsupported, unavailable, and failed responses without false zeros', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request);
  const cases = [
    ['unauthorized', (label: string) => `${label} is unavailable: the saved credential is unauthorized for this read.`],
    ['unsupported', (label: string) => `${label} is unavailable: this read is unsupported by the connected instance.`],
    ['unavailable', (label: string) => `${label} is temporarily unavailable.`],
    ['failed', (label: string) => `${label} is unavailable because the response could not be verified.`],
  ] as const;

  for (const [mode, message] of cases) {
    evidence.adminCollectionModes.connections = mode;
    await page.goto('/admin/fleet/connections');
    await closeWalkthrough(page);
    await expect(page.getByText(message('Connection inventory'), { exact: true })).toBeVisible({ timeout: 15_000 });
    const activeCard = page.getByText('Active Connections', { exact: true }).locator('..');
    await expect(activeCard.getByText('-', { exact: true })).toBeVisible();
    await expect(activeCard.getByText('0', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No connections found.', { exact: true })).toHaveCount(0);
    await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  }

  evidence.adminCollectionModes.connections = 'empty';
  for (const [mode, message] of cases) {
    evidence.adminCollectionModes.schedules = mode;
    await page.goto('/admin/content/schedules');
    await closeWalkthrough(page);
    await expect(page.getByText(message('Schedule evidence'), { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('No schedules found.', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/0 scheduled deliveries found/)).toHaveCount(0);
    await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  }

  evidence.adminCollectionModes.schedules = 'empty';
  for (const [mode, message] of cases) {
    evidence.adminCollectionModes.uploads = mode;
    await page.goto('/admin/content/uploads');
    await closeWalkthrough(page);
    await expect(page.getByText(message('Upload inventory'), { exact: true })).toBeVisible({ timeout: 15_000 });
    const uploadsCard = page.getByText('Matching Uploads', { exact: true }).locator('..');
    await expect(uploadsCard.getByText('-', { exact: true })).toBeVisible();
    await expect(uploadsCard.getByText('0', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No uploads found.', { exact: true })).toHaveCount(0);
    await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  }
  assertIsolated(evidence);
});

test('Schedule Management fails closed on malformed success and preserves verified empty and populated pages', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: { schedules: 'malformed' },
  });
  await page.goto('/admin/content/schedules');
  await closeWalkthrough(page);

  await expect(page.getByText('Schedule evidence is unavailable because the response could not be verified.', { exact: true })).toBeVisible();
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  await expect(page.getByText('Schedule evidence is unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByText('No schedules found.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/0 scheduled deliveries found/)).toHaveCount(0);

  evidence.adminCollectionModes.schedules = 'empty';
  await page.reload();
  await expect(page.getByText('No schedules found.', { exact: true })).toBeVisible();
  await expect(page.getByText(/0 scheduled deliveries found/)).toBeVisible();
  await expect(page.getByText('Schedule evidence is unavailable.', { exact: true })).toHaveCount(0);

  evidence.adminCollectionModes.schedules = 'populated';
  await page.reload();
  await expect(page.getByText('Daily executive schedule', { exact: true })).toBeVisible();
  await expect(page.getByText(/1 scheduled delivery found/)).toBeVisible();
  await expect(page.getByText('No schedules found.', { exact: true })).toHaveCount(0);
  assertIsolated(evidence);
});

test('Schedule Management binds offset pages to the requested page size and recovers from a contradictory later page', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: { schedules: 'offset_bad_cursor' },
  });
  await page.goto('/admin/content/schedules');
  await closeWalkthrough(page);

  await expect(page.getByText('Schedule evidence is unavailable because the response could not be verified.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Page 1 of/)).toHaveCount(0);
  await expect(page.getByText('No schedules found.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);

  evidence.adminCollectionModes.schedules = 'offset_pages';
  await page.reload();
  await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Schedule fixture 26', { exact: true })).toBeVisible();

  evidence.adminCollectionModes.schedules = 'offset_terminal_mismatch';
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Schedule evidence is unavailable because the response could not be verified.', { exact: true })).toBeVisible();
  await expect(page.getByText('No schedules found.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Page 2 of/)).toHaveCount(0);
  const recover = page.getByRole('button', { name: 'Return to first page', exact: true });
  await expect(recover).toBeVisible();
  await recover.click();
  await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
  assertIsolated(evidence);
});

test('Upload Governance fails closed on malformed success and preserves verified empty and populated pages', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: { uploads: 'malformed' },
  });
  await page.goto('/admin/content/uploads');
  await closeWalkthrough(page);

  await expect(page.getByText('Upload inventory is unavailable because the response could not be verified.', { exact: true })).toBeVisible();
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  await expect(page.getByText('Upload inventory is unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByText('No uploads found.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Matching Uploads', { exact: true }).locator('..')).toContainText('Upload inventory unavailable');

  evidence.adminCollectionModes.uploads = 'empty';
  await page.reload();
  await expect(page.getByText('No uploads found.', { exact: true })).toBeVisible();
  await expect(page.getByText('Matching Uploads', { exact: true }).locator('..')).toContainText('0');
  await expect(page.getByText('Upload inventory is unavailable.', { exact: true })).toHaveCount(0);

  evidence.adminCollectionModes.uploads = 'populated';
  await page.reload();
  await expect(page.getByText('example-upload.csv', { exact: true })).toBeVisible();
  await expect(page.getByText('Matching Uploads', { exact: true }).locator('..')).toContainText('1');
  await expect(page.getByText('No uploads found.', { exact: true })).toHaveCount(0);
  assertIsolated(evidence);
});

test('Upload Governance navigates short cursor pages with cumulative truth and recovers from a contradictory terminal page', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: { uploads: 'cursor_pages' },
  });
  await page.goto('/admin/content/uploads');
  await closeWalkthrough(page);

  await expect(page.getByText('Page 1 · 2 of 5 loaded', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  evidence.delayedUploadCursor = 'upload-cursor-2';
  try {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect.poll(() => evidence.pendingUploadRequests).toBe(1);
    await expect(page.getByText('Loading upload governance', { exact: true })).toBeVisible();
    await expect(page.getByText('example-upload.csv', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Page 1 · 2 of 5 loaded', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Page 2 · .* loaded/)).toHaveCount(0);
    evidence.releaseDelayedUpload?.();
    evidence.releaseDelayedUpload = null;
    evidence.delayedUploadCursor = null;
    await expect(page.getByText('Page 2 · 5 of 5 loaded', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();

    evidence.adminCollectionModes.uploads = 'cursor_terminal_mismatch';
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await expect(page.getByText('Page 1 · 2 of 5 loaded', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Upload inventory is unavailable because the response could not be verified.', { exact: true })).toBeVisible();
    await expect(page.getByText('Upload inventory is unavailable.', { exact: true })).toBeVisible();
    await expect(page.getByText('No uploads found.', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Page 2 · .* loaded/)).toHaveCount(0);
    const recover = page.getByRole('button', { name: 'Return to first page', exact: true });
    await expect(recover).toBeVisible();
    await recover.click();
    await expect(page.getByText('Page 1 · 2 of 5 loaded', { exact: true })).toBeVisible();
    assertIsolated(evidence);
  } finally {
    evidence.releaseDelayedUpload?.();
  }
});

test('Schedule editor dashboard inventory requires a complete normalized handler response', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: { scheduleDocuments: 'malformed', schedules: 'empty' },
  });
  await page.goto('/admin/content/schedules');
  await closeWalkthrough(page);
  await page.getByRole('button', { name: 'Create Schedule', exact: true }).click();

  let dialog = page.getByRole('dialog', { name: 'Create Schedule', exact: true });
  await expect(dialog.getByText('Dashboard inventory is unavailable because the response could not be verified.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Dashboard inventory is unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByText(RAW_COLLECTION_MARKER, { exact: false })).toHaveCount(0);
  await expect(dialog.getByText('No dashboards or reports were returned from Omni.', { exact: true })).toHaveCount(0);

  evidence.adminCollectionModes.scheduleDocuments = 'empty';
  await page.reload();
  await page.getByRole('button', { name: 'Create Schedule', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Create Schedule', exact: true });
  await expect(dialog.getByText('No dashboards or reports were returned from Omni.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Dashboard inventory is unavailable.', { exact: true })).toHaveCount(0);

  evidence.adminCollectionModes.scheduleDocuments = 'populated';
  await page.reload();
  await page.getByRole('button', { name: 'Create Schedule', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Create Schedule', exact: true });
  const dashboard = dialog.getByRole('button', { name: /Executive overview/ });
  await expect(dashboard).toBeVisible();
  await dashboard.click();
  await expect(dialog.getByText('Selected:')).toBeVisible();
  await expect(dashboard).toHaveAttribute('aria-pressed', 'true');
  assertIsolated(evidence);
});

test('Schedule editor names every control, traps focus, closes with Escape, and restores its opener', async ({ page, request }) => {
  const evidence = await prepareReadiness(page, request, {
    adminCollections: { scheduleDocuments: 'empty', schedules: 'empty' },
  });
  await page.goto('/admin/content/schedules');
  await closeWalkthrough(page);

  const opener = page.getByRole('button', { name: 'Create Schedule', exact: true });
  await opener.focus();
  await opener.click();

  const dialog = page.getByRole('dialog', { name: 'Create Schedule', exact: true });
  const scheduleName = dialog.getByLabel('Schedule Name', { exact: true });
  await expect(dialog).toHaveAttribute('aria-describedby', 'schedule-form-description');
  await expect(scheduleName).toBeFocused();
  for (const label of [
    'Dashboard or report',
    'Cron Schedule',
    'Timezone',
    'Format',
    'Destination',
    'Recipients',
    'Subject',
    'Trigger a test delivery after creating the schedule.',
  ]) {
    await expect(dialog.getByLabel(label, { exact: true })).toBeVisible();
  }

  await scheduleName.fill('Accessibility regression schedule');
  await dialog.getByRole('button', { name: 'Create Schedule', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Select a dashboard or report for this schedule.');

  const closeButton = dialog.getByRole('button', { name: 'Close schedule editor', exact: true });
  const submitButton = dialog.getByRole('button', { name: 'Create Schedule', exact: true });
  await closeButton.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(submitButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  assertIsolated(evidence);
});
