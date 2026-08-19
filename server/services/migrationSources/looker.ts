import { createHash } from 'node:crypto';
import type {
  MigrationDashboardEvidence,
  MigrationExplore,
  MigrationField,
  MigrationInventory,
  MigrationMeasure,
  MigrationRelationship,
  MigrationSourceArtifactProvenance,
  MigrationSourceDependencyEvidence,
  MigrationView,
} from '../../../src/services/semanticMigration/types';
import type {
  MigrationPreparedEvidenceResult,
  MigrationSourceCollectorContext,
  MigrationSourceEvidenceCollector,
} from './contracts';

const LOOKER_LOGIN_DOCUMENTATION = 'https://cloud.google.com/looker/docs/reference/looker-api/latest/methods/ApiAuth/login';
const LOOKER_EXPLORE_DOCUMENTATION = 'https://cloud.google.com/looker/docs/reference/looker-api/latest/methods/LookmlModel/lookml_model_explore';
const LOOKER_DASHBOARD_DOCUMENTATION = 'https://cloud.google.com/looker/docs/reference/looker-api/latest/methods/Dashboard/dashboard';
const LOOKER_LOOK_DOCUMENTATION = 'https://cloud.google.com/looker/docs/reference/looker-api/latest/methods/Look/look';
const MAX_SELECTED_ROOTS = 200;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 30_000;
const DISCOVERY_DEADLINE_MS = 90_000;
const DISCOVERY_PAGE_SIZE = 50;
const MAX_DISCOVERY_ITEMS_PER_KIND = 1_000;
// Five data pages plus one terminal probe prove an exact 1,000-item boundary.
const MAX_DISCOVERY_PAGES_PER_KIND = Math.ceil(MAX_DISCOVERY_ITEMS_PER_KIND / DISCOVERY_PAGE_SIZE) + 1;

type JsonRecord = Record<string, unknown>;

interface CollectionStats {
  requestsMade: number;
  bytesRead: number;
  itemsObserved: number;
  permissionGaps: string[];
  warnings: string[];
  errors: string[];
}

export interface LookerDiscoveryInventoryResult {
  inventory: MigrationInventory;
  items: Array<{
    id: string;
    name: string;
    kind: 'project' | 'semantic_model' | 'dashboard' | 'report' | 'explore';
    parentId?: string;
    updatedAt?: string;
    usageCount?: number;
  }>;
  diagnostics: { requestsMade: number; pagesFetched: number; bytesRead: number; truncated: boolean; warnings: string[] };
}

interface LookerRootScope {
  dashboardIds: string[];
  lookIds: string[];
  explorePairs: Array<{ model: string; explore: string }>;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}

function stringValue(...values: unknown[]): string {
  const value = values.find((item) => typeof item === 'string' && item.trim());
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function canonicalize(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item as JsonRecord).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalize(child)]));
  };
  return JSON.stringify(normalize(value));
}

function fingerprint(value: unknown): { sha256: string; sizeBytes: number } {
  const encoded = canonicalize(value);
  const sizeBytes = Buffer.byteLength(encoded, 'utf8');
  if (sizeBytes > MAX_ARTIFACT_BYTES) throw Object.assign(new Error('A selected Looker definition exceeded the 10 MB normalized evidence limit.'), { statusCode: 413 });
  return { sha256: createHash('sha256').update(encoded).digest('hex'), sizeBytes };
}

function lookerApiBase(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  url.search = '';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/api\/4\.0$/i.test(path) ? path : `${path}/api/4.0`;
  return url.toString().replace(/\/+$/, '');
}

function parseRootScope(selectedRootIds: readonly string[]): LookerRootScope {
  if (selectedRootIds.length === 0) throw Object.assign(new Error('Select at least one Looker dashboard, Look, or compiled Explore.'), { statusCode: 400 });
  if (selectedRootIds.length > MAX_SELECTED_ROOTS) throw Object.assign(new Error(`Select ${MAX_SELECTED_ROOTS} or fewer Looker roots.`), { statusCode: 400 });
  const scope: LookerRootScope = { dashboardIds: [], lookIds: [], explorePairs: [] };
  selectedRootIds.forEach((raw) => {
    const value = raw.trim();
    if (!value) return;
    if (value.startsWith('dashboard:')) {
      scope.dashboardIds.push(value.slice('dashboard:'.length));
      return;
    }
    if (value.startsWith('look:')) {
      scope.lookIds.push(value.slice('look:'.length));
      return;
    }
    const explore = value.startsWith('explore:') ? value.slice('explore:'.length) : '';
    if (explore.includes('/')) {
      const [model, ...rest] = explore.split('/');
      const exploreName = rest.join('/');
      if (model && exploreName) scope.explorePairs.push({ model, explore: exploreName });
      return;
    }
    // Dashboard inventory historically exposed native IDs without a kind prefix.
    scope.dashboardIds.push(value);
  });
  scope.dashboardIds = Array.from(new Set(scope.dashboardIds.filter(Boolean))).sort();
  scope.lookIds = Array.from(new Set(scope.lookIds.filter(Boolean))).sort();
  scope.explorePairs = Array.from(new Map(scope.explorePairs.map((pair) => [`${pair.model}/${pair.explore}`, pair])).values()).sort((left, right) => `${left.model}/${left.explore}`.localeCompare(`${right.model}/${right.explore}`));
  return scope;
}

function queryFromElement(element: JsonRecord): JsonRecord | undefined {
  const direct = asRecord(element.query);
  if (Object.keys(direct).length > 0) return direct;
  const resultMaker = asRecord(element.result_maker);
  const resultQuery = asRecord(resultMaker.query);
  if (Object.keys(resultQuery).length > 0) return resultQuery;
  const look = asRecord(element.look);
  const lookQuery = asRecord(look.query);
  return Object.keys(lookQuery).length > 0 ? lookQuery : undefined;
}

function isTextDashboardElement(element: JsonRecord): boolean {
  return stringValue(element.type).toLowerCase() === 'text'
    || Boolean(stringValue(element.body_text, element.bodyText));
}

function queryExplorePair(query: JsonRecord): { model: string; explore: string } | undefined {
  const model = stringValue(query.model, query.model_name);
  const explore = stringValue(query.view, query.explore);
  return model && explore ? { model, explore } : undefined;
}

function normalizedField(raw: JsonRecord): MigrationField {
  const qualifiedName = stringValue(raw.name, raw.id);
  const name = qualifiedName.includes('.') ? qualifiedName.split('.').slice(1).join('.') : qualifiedName;
  return {
    sourceId: qualifiedName || undefined,
    sourceLocator: qualifiedName ? `compiled-field:${qualifiedName}` : undefined,
    name: name || 'unnamed_field',
    type: stringValue(raw.type) || undefined,
    sql: stringValue(raw.sql) || undefined,
    description: stringValue(raw.description) || undefined,
    label: stringValue(raw.label, raw.label_short) || undefined,
    groupLabel: stringValue(raw.group_label) || undefined,
    hidden: raw.hidden === true,
    primaryKey: raw.primary_key === true,
  };
}

function compiledExploreInventory(modelName: string, exploreName: string, definition: JsonRecord): {
  views: MigrationView[];
  explore: MigrationExplore;
  relationships: MigrationRelationship[];
  dependencies: MigrationSourceDependencyEvidence[];
} {
  const fieldGroups = asRecord(definition.fields);
  const rawDimensions = records(fieldGroups.dimensions);
  const rawMeasures = records(fieldGroups.measures);
  const rawParameters = records(fieldGroups.parameters);
  const views = new Map<string, { fields: MigrationField[]; measures: MigrationMeasure[] }>();
  const add = (raw: JsonRecord, measure: boolean): void => {
    const qualifiedName = stringValue(raw.name, raw.id);
    const viewName = stringValue(raw.view, raw.view_name) || (qualifiedName.includes('.') ? qualifiedName.split('.')[0]! : 'compiled_explore');
    const target = views.get(viewName) || { fields: [], measures: [] };
    const field = normalizedField(raw);
    if (measure) target.measures.push({ ...field, aggregateType: stringValue(raw.type) || undefined });
    else target.fields.push(field);
    views.set(viewName, target);
  };
  rawDimensions.forEach((item) => add(item, false));
  rawParameters.forEach((item) => add(item, false));
  rawMeasures.forEach((item) => add(item, true));

  const baseView = stringValue(definition.view_name, definition.viewName, definition.from, exploreName);
  const rawJoins = records(definition.joins);
  const relationships: MigrationRelationship[] = rawJoins.flatMap((join) => {
    const target = stringValue(join.view_name, join.viewName, join.from, join.name);
    if (!target) return [];
    return [{
      sourceId: `looker:compiled-join:${modelName}/${exploreName}/${target}`,
      sourceLocator: `compiled-explore:${modelName}/${exploreName}/join:${target}`,
      from: baseView,
      to: target,
      joinType: stringValue(join.type) || undefined,
      relationshipType: stringValue(join.relationship) || undefined,
      sql: stringValue(join.sql_on, join.sqlOn) || undefined,
      sourceArtifact: `${modelName}/${exploreName}`,
    }];
  });
  const normalizedViews = Array.from(views.entries()).map(([name, fields]) => ({
    sourceId: `looker:compiled-view:${modelName}/${exploreName}/${name}`,
    sourceLocator: `compiled-explore:${modelName}/${exploreName}/view:${name}`,
    name,
    label: name,
    kind: 'dataset' as const,
    fields: fields.fields,
    measures: fields.measures,
    warnings: ['This view was normalized from a compiled Explore definition; raw LookML inheritance and include order require Git or Manual Files.'],
    sourceArtifact: `${modelName}/${exploreName}`,
  }));
  const dependencies: MigrationSourceDependencyEvidence[] = [
    {
      sourceId: `looker:compiled-explore:${modelName}/${exploreName}`,
      category: 'semantic_model',
      required: true,
      status: 'resolved',
      reason: 'The compiled Explore definition was acquired from the documented Looker API endpoint.',
    },
    {
      sourceId: `looker:compiled-explore:${modelName}/${exploreName}`,
      category: 'content',
      required: true,
      status: 'manual_required',
      reason: 'Raw LookML, includes, refinements, Liquid, PDT SQL, manifests, and tests require the selected Git or Manual Files closure.',
    },
  ];
  return {
    views: normalizedViews,
    explore: {
      sourceId: `looker:compiled-explore:${modelName}/${exploreName}`,
      sourceLocator: `compiled-explore:${modelName}/${exploreName}`,
      name: exploreName,
      baseView,
      joins: relationships,
      fields: [...rawDimensions, ...rawMeasures, ...rawParameters].map((field) => stringValue(field.name, field.id)).filter(Boolean),
      filters: [
        ...records(definition.always_filter).map((filter) => {
          const name = stringValue(filter.name);
          const value = stringValue(filter.value);
          return name && value ? `${name}: ${value}` : name;
        }).filter(Boolean),
        ...records(definition.access_filters).map((filter) => stringValue(filter.field)).filter(Boolean),
      ],
      sourceArtifact: `${modelName}/${exploreName}`,
    },
    relationships,
    dependencies,
  };
}

function dashboardInventory(dashboard: JsonRecord): MigrationDashboardEvidence {
  const dashboardId = stringValue(dashboard.id);
  const elements = records(dashboard.dashboard_elements);
  const queries = elements.map(queryFromElement).filter((item): item is JsonRecord => Boolean(item));
  const fields = Array.from(new Set(queries.flatMap((query) => stringList(query.fields)))).sort();
  const filters = Array.from(new Set([
    ...records(dashboard.dashboard_filters).map((filter) => stringValue(filter.dimension, filter.name)).filter(Boolean),
    ...queries.flatMap((query) => Object.keys(asRecord(query.filters))),
  ])).sort();
  return {
    sourceId: `looker:dashboard:${dashboardId}`,
    sourceLocator: `dashboard:${dashboardId}`,
    name: stringValue(dashboard.title, dashboard.name) || `Dashboard ${dashboardId}`,
    fields,
    filters,
    assetKind: 'dashboard',
    path: stringValue(asRecord(dashboard.folder).name, dashboard.folder_path) || undefined,
    owner: stringValue(dashboard.user_name, asRecord(dashboard.user).display_name) || undefined,
    updatedAt: stringValue(dashboard.updated_at) || undefined,
    usageCount: typeof dashboard.view_count === 'number' ? dashboard.view_count : undefined,
    dependencyIds: Array.from(new Set(queries.flatMap((query) => {
      const pair = queryExplorePair(query);
      return pair ? [`looker:compiled-explore:${pair.model}/${pair.explore}`] : [];
    }))).sort(),
    sourceArtifact: `dashboard:${dashboardId}`,
  };
}

async function requestLookerJson(
  context: MigrationSourceCollectorContext,
  stats: CollectionStats,
  url: string,
  accessToken: string | undefined,
  label: string,
  options: { method?: 'GET' | 'POST'; body?: string; allowStatuses?: readonly number[]; deadlineMs?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await context.transport.request({
    url,
    method: options.method,
    headers: {
      Accept: 'application/json',
      ...(accessToken ? { Authorization: `token ${accessToken}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: options.body,
    responseType: 'json',
    label,
    allowStatuses: options.allowStatuses,
    maxResponseBytes: MAX_ARTIFACT_BYTES,
    deadlineMs: options.deadlineMs ?? REQUEST_DEADLINE_MS,
    signal: context.signal,
  });
  stats.requestsMade += response.requestCount;
  stats.bytesRead += response.bytesRead;
  return { status: response.status, body: response.body };
}

async function lookerAccessToken(context: MigrationSourceCollectorContext, stats: CollectionStats, base: string): Promise<string> {
  const { connection } = context;
  if (connection.authMode !== 'api_client_credentials' || !connection.clientId || !connection.credential) {
    throw Object.assign(new Error('Looker Saved API requires a Looker API client ID and client secret.'), { statusCode: 409 });
  }
  const login = await requestLookerJson(
    context,
    stats,
    `${base}/login`,
    undefined,
    'Looker API login',
    {
      method: 'POST',
      body: new URLSearchParams({ client_id: connection.clientId, client_secret: connection.credential }).toString(),
    },
  );
  const accessToken = stringValue(asRecord(login.body).access_token);
  if (!accessToken) throw Object.assign(new Error('Looker API login did not return an access token.'), { statusCode: 502 });
  context.registerSensitiveValue?.(accessToken, 'Looker API login');
  return accessToken;
}

interface LookerDiscoveryPageResult {
  rows: JsonRecord[];
  pagesFetched: number;
  truncated: boolean;
}

function lookerDiscoveryRows(payload: unknown, key: 'dashboards' | 'looks'): { recognized: boolean; rows: JsonRecord[] } {
  const rawRows = Array.isArray(payload) ? payload : asRecord(payload)[key];
  if (!Array.isArray(rawRows)) return { recognized: false, rows: [] };
  const normalized = records(rawRows);
  return normalized.length === rawRows.length
    ? { recognized: true, rows: normalized }
    : { recognized: false, rows: [] };
}

async function listLookerDiscoveryPages(
  context: MigrationSourceCollectorContext,
  stats: CollectionStats,
  base: string,
  accessToken: string,
  resource: 'dashboards' | 'looks',
): Promise<LookerDiscoveryPageResult> {
  const collected = new Map<string, JsonRecord>();
  let offset = 0;
  let pagesFetched = 0;
  let terminalPageObserved = false;
  let truncated = false;
  let previousPageSignature = '';

  for (let page = 0; page < MAX_DISCOVERY_PAGES_PER_KIND; page += 1) {
    const discoveryFields = resource === 'dashboards'
      ? '&fields=id,title,name,folder(name),folder_path,user_name,updated_at,view_count,dashboard_elements(query(model,view,fields,filters)),dashboard_filters(dimension,name)'
      : '&fields=id,title,name,folder(name),folder_path,user_name,updated_at';
    const response = await requestLookerJson(
      context,
      stats,
      `${base}/${resource}/search?deleted=false&limit=${DISCOVERY_PAGE_SIZE}&offset=${offset}&sorts=id${discoveryFields}`,
      accessToken,
      `Looker ${resource === 'dashboards' ? 'dashboard' : 'Look'} discovery page ${page + 1}`,
      { deadlineMs: DISCOVERY_DEADLINE_MS },
    );
    pagesFetched += 1;
    const parsed = lookerDiscoveryRows(response.body, resource);
    if (!parsed.recognized) {
      truncated = true;
      stats.warnings.push(`Looker ${resource} discovery returned an unrecognized page shape; the catalog is incomplete.`);
      break;
    }
    if (parsed.rows.length > DISCOVERY_PAGE_SIZE) {
      truncated = true;
      stats.warnings.push(`Looker ${resource} search returned more rows than the requested page size; the catalog is incomplete.`);
      break;
    }
    if (parsed.rows.length === 0) {
      terminalPageObserved = true;
      break;
    }

    const identified = parsed.rows.map((row) => ({ id: stringValue(row.id), row }));
    if (identified.some((item) => !item.id)) {
      truncated = true;
      stats.warnings.push(`Looker ${resource} discovery returned a row without an ID; the catalog is incomplete.`);
      break;
    }
    const pageSignature = identified.map((item) => item.id).join('\u0000');
    if (pageSignature === previousPageSignature) {
      truncated = true;
      stats.warnings.push(`Looker ${resource} discovery repeated a page without advancing; narrow the source scope before planning.`);
      break;
    }
    previousPageSignature = pageSignature;

    const uniquePage = new Map<string, JsonRecord>();
    identified.forEach((item) => uniquePage.set(item.id, item.row));
    const newRows = Array.from(uniquePage.entries()).filter(([id]) => !collected.has(id));
    const duplicateCount = identified.length - newRows.length;
    if (newRows.length === 0) {
      truncated = true;
      stats.warnings.push(`Looker ${resource} discovery made no ID progress; narrow the source scope before planning.`);
      break;
    }

    const remaining = MAX_DISCOVERY_ITEMS_PER_KIND - collected.size;
    newRows.slice(0, Math.max(0, remaining)).forEach(([id, row]) => collected.set(id, row));
    if (duplicateCount > 0) {
      truncated = true;
      stats.warnings.push(`Looker ${resource} discovery returned overlapping IDs across a page boundary; the deduplicated catalog is incomplete.`);
      break;
    }
    if (newRows.length > remaining || (remaining === 0 && newRows.length > 0)) {
      truncated = true;
      stats.warnings.push(`Looker ${resource} discovery exceeded the ${MAX_DISCOVERY_ITEMS_PER_KIND}-item safety bound; narrow the source scope before planning.`);
      break;
    }
    if (parsed.rows.length < DISCOVERY_PAGE_SIZE) {
      terminalPageObserved = true;
      break;
    }
    offset += parsed.rows.length;
  }

  if (!terminalPageObserved && !truncated) {
    truncated = true;
    stats.warnings.push(`Looker ${resource} discovery reached the ${MAX_DISCOVERY_PAGES_PER_KIND}-page safety bound without terminal evidence.`);
  }
  return { rows: Array.from(collected.values()), pagesFetched, truncated };
}

export async function listLookerDiscoveryInventory(context: MigrationSourceCollectorContext): Promise<LookerDiscoveryInventoryResult> {
  const { connection } = context;
  if (connection.platform !== 'looker') throw Object.assign(new Error('The Looker discovery helper requires a Looker connection.'), { statusCode: 400 });
  const stats: CollectionStats = { requestsMade: 0, bytesRead: 0, itemsObserved: 0, permissionGaps: [], warnings: [], errors: [] };
  const base = lookerApiBase(connection.baseUrl);
  const accessToken = await lookerAccessToken(context, stats, base);
  const [projectsResponse, modelsResponse, dashboardPages, lookPages] = await Promise.all([
    requestLookerJson(context, stats, `${base}/projects`, accessToken, 'Looker project discovery'),
    requestLookerJson(context, stats, `${base}/lookml_models`, accessToken, 'Looker model discovery'),
    listLookerDiscoveryPages(context, stats, base, accessToken, 'dashboards'),
    listLookerDiscoveryPages(context, stats, base, accessToken, 'looks'),
  ]);
  const fromPayload = (payload: unknown, key: string): JsonRecord[] => {
    if (Array.isArray(payload)) return records(payload);
    return records(asRecord(payload)[key]);
  };
  const projects = fromPayload(projectsResponse.body, 'projects');
  const models = fromPayload(modelsResponse.body, 'lookml_models');
  const dashboards = dashboardPages.rows;
  const looks = lookPages.rows;
  const items: LookerDiscoveryInventoryResult['items'] = [
    ...projects.map((item) => ({ id: stringValue(item.id, item.name), name: stringValue(item.name, item.id), kind: 'project' as const })),
    ...models.map((item) => ({ id: stringValue(item.name, item.id), name: stringValue(item.name, item.label, item.id), kind: 'semantic_model' as const, parentId: stringValue(item.project_name, item.project_id) || undefined })),
    ...models.flatMap((model) => records(model.explores).flatMap((explore) => {
      const modelName = stringValue(model.name, model.id);
      const exploreName = stringValue(explore.name, explore.id);
      return modelName && exploreName ? [{ id: `explore:${modelName}/${exploreName}`, name: exploreName, kind: 'explore' as const, parentId: modelName }] : [];
    })),
    ...dashboards.map((item) => ({ id: stringValue(item.id), name: stringValue(item.title, item.name, item.id), kind: 'dashboard' as const, updatedAt: stringValue(item.updated_at) || undefined, usageCount: typeof item.view_count === 'number' ? item.view_count : undefined })),
    ...looks.map((item) => ({ id: `look:${stringValue(item.id)}`, name: stringValue(item.title, item.name, item.id), kind: 'report' as const, updatedAt: stringValue(item.updated_at) || undefined })),
  ].filter((item) => item.id && item.name);
  const truncated = dashboardPages.truncated || lookPages.truncated;
  const inventory: MigrationInventory = {
    sourceTool: 'looker', artifactCount: 0, artifacts: [], views: [], explores: [], relationships: [], dashboards: dashboards.map(dashboardInventory), metrics: [],
    warnings: ['This is discovery metadata only. Prepare selected compiled evidence before Analyze.', ...stats.warnings],
    summary: `${projects.length} project${projects.length === 1 ? '' : 's'} · ${models.length} model${models.length === 1 ? '' : 's'} · ${dashboards.length} dashboard${dashboards.length === 1 ? '' : 's'} · discovery only`,
  };
  stats.itemsObserved = items.length;
  return {
    inventory,
    items,
    diagnostics: {
      requestsMade: stats.requestsMade,
      pagesFetched: 2 + dashboardPages.pagesFetched + lookPages.pagesFetched,
      bytesRead: stats.bytesRead,
      truncated,
      warnings: Array.from(new Set(stats.warnings)).sort(),
    },
  };
}

export async function prepareLookerEvidence(context: MigrationSourceCollectorContext): Promise<MigrationPreparedEvidenceResult> {
  const { connection } = context;
  if (connection.platform !== 'looker') throw Object.assign(new Error('The Looker collector requires a Looker connection.'), { statusCode: 400 });
  if (connection.authMode !== 'api_client_credentials' || !connection.clientId || !connection.credential) {
    throw Object.assign(new Error('Looker Saved API requires a Looker API client ID and client secret.'), { statusCode: 409 });
  }
  const scope = parseRootScope(context.selectedRootIds);
  const stats: CollectionStats = { requestsMade: 0, bytesRead: 0, itemsObserved: 0, permissionGaps: [], warnings: [], errors: [] };
  const base = lookerApiBase(connection.baseUrl);
  const accessToken = await lookerAccessToken(context, stats, base);

  const rawDashboards: JsonRecord[] = [];
  const rawLooks: JsonRecord[] = [];
  const unresolvedDashboardTileDependencies: MigrationSourceDependencyEvidence[] = [];
  const explorePairs = new Map(scope.explorePairs.map((pair) => [`${pair.model}/${pair.explore}`, pair]));
  for (const dashboardId of scope.dashboardIds) {
    const detail = await requestLookerJson(context, stats, `${base}/dashboards/${encodeURIComponent(dashboardId)}`, accessToken, 'Looker dashboard definition');
    const dashboard = asRecord(detail.body);
    if (Object.keys(dashboard).length === 0) throw Object.assign(new Error(`Looker dashboard ${dashboardId} returned an empty definition.`), { statusCode: 502 });
    if (!Array.isArray(dashboard.dashboard_elements)) {
      const elements = await requestLookerJson(context, stats, `${base}/dashboards/${encodeURIComponent(dashboardId)}/dashboard_elements`, accessToken, 'Looker dashboard elements');
      dashboard.dashboard_elements = records(elements.body);
    }
    if (!Array.isArray(dashboard.dashboard_filters)) {
      const filters = await requestLookerJson(context, stats, `${base}/dashboards/${encodeURIComponent(dashboardId)}/dashboard_filters`, accessToken, 'Looker dashboard filters');
      dashboard.dashboard_filters = records(filters.body);
    }
    for (const [elementIndex, element] of records(dashboard.dashboard_elements).entries()) {
      if (isTextDashboardElement(element)) continue;
      const embeddedLook = asRecord(element.look);
      const lookId = stringValue(element.look_id, embeddedLook.id);
      const elementId = stringValue(element.id) || `index-${elementIndex + 1}`;
      let query = queryFromElement(element);
      if (!query && lookId) {
        const lookResponse = await requestLookerJson(context, stats, `${base}/looks/${encodeURIComponent(lookId)}`, accessToken, 'Looker saved Look definition', { allowStatuses: [200, 403, 404] });
        if (lookResponse.status === 200) {
          const look = asRecord(lookResponse.body);
          rawLooks.push(look);
          query = asRecord(look.query);
          element.look = look;
        } else {
          stats.permissionGaps.push(`Saved Look ${lookId} could not be read for dashboard ${dashboardId}.`);
        }
      }
      const pair = query ? queryExplorePair(query) : undefined;
      if (pair) explorePairs.set(`${pair.model}/${pair.explore}`, pair);
      else {
        const reason = lookId
          ? `Dashboard ${dashboardId} element ${elementId} depends on saved Look ${lookId}, but no readable model/Explore query was resolved. Restore API access or provide the exact tile query through Manual Files.`
          : `Dashboard ${dashboardId} element ${elementId} has no embedded model/Explore query or saved Look reference. Provide the exact tile query through Manual Files.`;
        stats.warnings.push(reason);
        unresolvedDashboardTileDependencies.push({
          sourceId: `looker:dashboard:${dashboardId}`,
          dependencySourceId: lookId
            ? `looker:look:${lookId}`
            : `looker:dashboard-element-query:${dashboardId}/${elementId}`,
          category: 'content',
          required: true,
          status: lookId ? 'missing' : 'manual_required',
          reason,
        });
      }
    }
    rawDashboards.push(dashboard);
  }
  for (const lookId of scope.lookIds) {
    const response = await requestLookerJson(context, stats, `${base}/looks/${encodeURIComponent(lookId)}`, accessToken, 'Looker saved Look definition');
    const look = asRecord(response.body);
    rawLooks.push(look);
    const pair = queryExplorePair(asRecord(look.query));
    if (pair) explorePairs.set(`${pair.model}/${pair.explore}`, pair);
  }
  if (explorePairs.size === 0 && scope.dashboardIds.length === 0) throw Object.assign(new Error('The selected Looker scope resolved no compiled Explore definitions. Use Manual Files if the source queries are inaccessible.'), { statusCode: 409 });
  if (explorePairs.size > MAX_SELECTED_ROOTS) throw Object.assign(new Error(`The selected dashboards resolve more than ${MAX_SELECTED_ROOTS} compiled Explores. Narrow the scope.`), { statusCode: 413 });

  const rawExplores: Array<{ model: string; explore: string; definition: JsonRecord }> = [];
  for (const pair of explorePairs.values()) {
    const response = await requestLookerJson(context, stats, `${base}/lookml_models/${encodeURIComponent(pair.model)}/explores/${encodeURIComponent(pair.explore)}`, accessToken, 'Looker compiled Explore definition', { allowStatuses: [200, 403, 404] });
    if (response.status !== 200) {
      stats.permissionGaps.push(`Compiled Explore ${pair.model}/${pair.explore} was not accessible.`);
      continue;
    }
    const definition = asRecord(response.body);
    if (Object.keys(definition).length === 0) {
      stats.errors.push(`Compiled Explore ${pair.model}/${pair.explore} returned an empty definition.`);
      continue;
    }
    rawExplores.push({ ...pair, definition });
  }

  const artifacts: MigrationSourceArtifactProvenance[] = [];
  const dependencies: MigrationSourceDependencyEvidence[] = [...unresolvedDashboardTileDependencies];
  const views: MigrationView[] = [];
  const explores: MigrationExplore[] = [];
  const relationships: MigrationRelationship[] = [];
  rawExplores.forEach(({ model, explore, definition }) => {
    const id = `looker:compiled-explore:${model}/${explore}`;
    const digest = fingerprint(definition);
    artifacts.push({ id, name: `${model}/${explore}`, sourceId: id, locator: `compiled-explore:${model}/${explore}`, mediaType: 'application/json', evidenceClass: 'compiled_definition', ...digest, documentationIds: [LOOKER_EXPLORE_DOCUMENTATION], rawContentIncluded: false });
    const normalized = compiledExploreInventory(model, explore, definition);
    views.push(...normalized.views);
    explores.push(normalized.explore);
    relationships.push(...normalized.relationships);
    dependencies.push(...normalized.dependencies);
  });
  rawDashboards.forEach((dashboard) => {
    const id = stringValue(dashboard.id);
    const digest = fingerprint(dashboard);
    artifacts.push({ id: `looker:dashboard:${id}`, name: stringValue(dashboard.title) || `Dashboard ${id}`, sourceId: `looker:dashboard:${id}`, locator: `dashboard:${id}`, mediaType: 'application/json', evidenceClass: 'compiled_definition', ...digest, documentationIds: [LOOKER_DASHBOARD_DOCUMENTATION], rawContentIncluded: false });
  });
  rawLooks.forEach((look) => {
    const id = stringValue(look.id);
    if (!id || artifacts.some((artifact) => artifact.id === `looker:look:${id}`)) return;
    const digest = fingerprint(look);
    artifacts.push({ id: `looker:look:${id}`, name: stringValue(look.title) || `Look ${id}`, sourceId: `looker:look:${id}`, locator: `look:${id}`, mediaType: 'application/json', evidenceClass: 'compiled_definition', ...digest, documentationIds: [LOOKER_LOOK_DOCUMENTATION], rawContentIncluded: false });
  });
  stats.itemsObserved = artifacts.length;
  const manualRequirements = ['Provide the selected raw .lkml dependency closure from Git or Manual Files before Apply to Dev or release validation.'];
  const warnings = Array.from(new Set([...stats.warnings, ...manualRequirements]));
  const inventory: MigrationInventory = {
    sourceTool: 'looker',
    artifactCount: artifacts.length,
    artifacts: [],
    views,
    explores,
    relationships,
    dashboards: rawDashboards.map(dashboardInventory),
    metrics: views.flatMap((view) => view.measures),
    warnings,
    summary: `${rawExplores.length} compiled Explore definition${rawExplores.length === 1 ? '' : 's'} · ${rawDashboards.length} dashboard${rawDashboards.length === 1 ? '' : 's'} · raw LookML manual closure required`,
  };
  const resolvedCount = dependencies.filter((dependency) => dependency.status === 'resolved').length;
  const missingCount = dependencies.filter((dependency) => dependency.status === 'missing').length + stats.permissionGaps.length;
  const reviewCount = dependencies.filter((dependency) => dependency.status === 'review_required' || dependency.status === 'manual_required').length;
  const expectedSelectedDefinitions = scope.dashboardIds.length + scope.lookIds.length + explorePairs.size;
  const selectedDefinitionsAcquired = rawDashboards.length + rawLooks.filter((look) => scope.lookIds.includes(stringValue(look.id))).length + rawExplores.length;
  const collectionComplete = stats.permissionGaps.length === 0
    && stats.errors.length === 0
    && unresolvedDashboardTileDependencies.length === 0
    && selectedDefinitionsAcquired >= expectedSelectedDefinitions;
  const status: MigrationPreparedEvidenceResult['status'] = collectionComplete ? 'partial' : missingCount > 0 && selectedDefinitionsAcquired > 0 ? 'partial' : 'failed';
  const evidenceContract: MigrationPreparedEvidenceResult['evidenceContract'] = {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool: 'looker',
    parser: { name: 'OmniKit Looker compiled API normalizer', version: '1' },
    acquisition: { mode: 'api', runId: context.scopeFingerprint, selectedScopeIds: [...context.selectedRootIds].sort() },
    collection: { expectedArtifactCount: expectedSelectedDefinitions, observedArtifactCount: selectedDefinitionsAcquired, complete: collectionComplete, truncated: false, permissionGaps: Array.from(new Set(stats.permissionGaps)).sort() },
    dependencyClosure: { status: missingCount > 0 ? 'blocked' : 'partial', resolvedCount, missingCount, reviewCount },
    artifactFingerprints: artifacts.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes })),
    documentationIds: [LOOKER_LOGIN_DOCUMENTATION, LOOKER_EXPLORE_DOCUMENTATION, LOOKER_DASHBOARD_DOCUMENTATION, LOOKER_LOOK_DOCUMENTATION],
    diagnostics: Array.from(new Set([...stats.errors, ...warnings, ...stats.permissionGaps])).sort(),
  };
  inventory.sourceEvidence = evidenceContract;
  return {
    schemaVersion: 'omnikit.prepared-source-evidence.v1',
    platform: 'looker',
    connectionId: connection.id,
    connectionUpdatedAt: connection.updatedAt,
    selectedRootIds: [...context.selectedRootIds].sort(),
    scopeFingerprint: context.scopeFingerprint,
    preparedAt: new Date().toISOString(),
    status,
    evidenceContract,
    inventory,
    artifacts,
    dependencies,
    diagnostics: {
      complete: collectionComplete,
      verifiedEmpty: false,
      truncated: false,
      requestsMade: stats.requestsMade,
      pagesFetched: stats.requestsMade,
      itemsObserved: stats.itemsObserved,
      bytesRead: stats.bytesRead,
      limits: { maxRequests: 1 + (MAX_SELECTED_ROOTS * 5), maxPages: 1 + (MAX_SELECTED_ROOTS * 5), maxItems: MAX_SELECTED_ROOTS, maxBytes: MAX_ARTIFACT_BYTES },
      permissionGaps: Array.from(new Set(stats.permissionGaps)).sort(),
      manualRequirements,
      errors: Array.from(new Set(stats.errors)).sort(),
      warnings: Array.from(new Set(stats.warnings)).sort(),
    },
  };
}

export const lookerEvidenceCollector: MigrationSourceEvidenceCollector = {
  platform: 'looker',
  prepareEvidence: prepareLookerEvidence,
};
