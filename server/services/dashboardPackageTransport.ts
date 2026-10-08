import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml';
import { dashboardSourceFieldReferences } from './dashboardSourceEvidence';
import type { OmniClient, OmniModelYamlResponse, OmniWriteDispatchGuard } from './omniClient';

export interface DashboardPackageLocalModel {
  sourceModelId: string;
  scope: 'workbook' | 'query';
  files: Record<string, string>;
}
export interface DashboardPackage {
  documentId: string;
  name: string;
  sharedModelId: string;
  connectionId: string;
  exportPayload: Record<string, unknown>;
  workbookModelId?: string;
  localModels: DashboardPackageLocalModel[];
  topicNames: string[];
  fieldRefs: string[];
  fingerprint: string;
}
export interface DashboardPackageTarget {
  modelId: string; connectionId: string; name: string; identifier: string; folderPath?: string;
}
export interface DashboardPackageTile {
  miniUuid: string; name: string; modelExtensionId?: string; topicName?: string; query: Record<string, unknown>;
}
export interface DashboardPackageLocalReceipt {
  sourceModelId: string; targetModelId: string; scope: 'workbook' | 'query';
  files: string[]; fingerprint: string; filesWritten: number;
}
export interface DashboardPackageContentVerification {
  verified: boolean; findings: string[]; sourceHash: string; destinationHash: string;
  checkedTiles: number;
  /** Content equivalence does not claim successful warehouse queries or local YAML restoration. */
  queriesVerified: false;
  localModelsVerified: false;
}
export class DashboardPackageTransportError extends Error {
  readonly code = 'DASHBOARD_PACKAGE_REQUIRES_REVIEW';
}
function fail(message: string): never { throw new DashboardPackageTransportError(message); }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const safePath = (value: string) => value.length > 0 && value.length <= 512 && !value.includes('\\')
  && !value.split('/').some(part => !part || part === '.' || part === '..')
  && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = (value: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

function bounded(value: unknown): void {
  let nodes = 0;
  const walk = (item: unknown, depth: number) => {
    if (++nodes > 250_000 || depth > 64) fail('Dashboard package exceeds its bounded structure.');
    if (Array.isArray(item)) item.forEach(child => walk(child, depth + 1));
    else if (record(item)) for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Dashboard package has unsupported object keys.');
      walk(child, depth + 1);
    }
    else if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) fail('Dashboard package is not JSON data.');
  };
  walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024) fail('Dashboard package exceeds its byte limit.');
}
function payload(value: unknown): Record<string, unknown> {
  bounded(value);
  if (!record(value) || value.exportVersion !== '0.1' || !record(value.document) || typeof value.document.name !== 'string'
    || !value.document.name.trim() || !record(value.dashboard) || !record(value.queryModels) || !record(value.workbookModel)) {
    return fail('A complete native dashboard export with workbook and query-model evidence is required.');
  }
  if (Object.keys(value.queryModels).length > 200) fail('Too many local query models in one dashboard package.');
  return value;
}
function modelIdentity(value: unknown): string {
  if (!record(value)) return fail('Local model identity is unavailable.');
  const values = [value.id, value.modelId, value.model_id].filter(entry => entry !== undefined);
  if (!values.length || values.some(entry => !id(entry) || entry !== values[0])) return fail('Local model identity is missing or conflicting.');
  return values[0] as string;
}
function propertyIdentity(value: Record<string, unknown>, keys: string[]): string | undefined {
  const values = keys.map(key => value[key]).filter(entry => entry !== undefined && entry !== null);
  if (!values.length) return undefined;
  if (values.some(entry => !id(entry) || entry !== values[0])) fail('Model binding identities conflict.');
  return values[0] as string;
}
/** Only declarations on this tile's own known wrappers establish its topic. */
function tileTopicName(...layers: Record<string, unknown>[]): string | undefined {
  const values = layers.flatMap(layer => ['topic', 'topicName', 'topic_name'].map(key => layer[key]))
    .filter(value => value !== undefined && value !== null);
  if (!values.length) return undefined;
  if (values.some(value => typeof value !== 'string' || value !== value.trim() || !safePath(value))) {
    return fail('A tile topic declaration must be one bounded exact authored name or path.');
  }
  if (new Set(values).size !== 1) return fail('The same tile declares conflicting topic identities across its presentation or query.');
  return values[0] as string;
}
function memberships(value: Record<string, unknown>): Record<string, unknown>[] {
  const dashboard = value.dashboard;
  const collection = record(dashboard) ? dashboard.queryPresentationCollection : undefined;
  const rows = record(collection) ? collection.queryPresentationCollectionMemberships : undefined;
  if (!Array.isArray(rows) || rows.length > 500 || rows.some(row => !record(row) || !record(row.queryPresentation))) {
    return fail('The complete native dashboard tile collection is unavailable.');
  }
  return rows as Record<string, unknown>[];
}
/** Exact native tile IDs are pairing evidence; names are never a fallback. */
export function listDashboardPackageTiles(value: Record<string, unknown>): DashboardPackageTile[] {
  bounded(value);
  const seen = new Set<string>();
  const tiles: DashboardPackageTile[] = [];
  for (const row of memberships(value)) {
    const qp = row.queryPresentation as Record<string, unknown>;
    if (!id(qp.miniUuid) || seen.has(qp.miniUuid)) fail('Dashboard tile identities are missing or duplicated.');
    seen.add(qp.miniUuid);
    if (qp.query === undefined || qp.query === null) continue; // Text/layout-only tiles are preserved by whole-content comparison.
    if (!record(qp.query) || !record(qp.query.queryJson)) fail('A dashboard query has an unsupported native shape.');
    const query = qp.query.queryJson;
    const extension = propertyIdentity(query, ['model_extension_id', 'modelExtensionId']);
    const topicName = tileTopicName(qp, qp.query, query);
    tiles.push({ miniUuid: qp.miniUuid, name: typeof qp.name === 'string' ? qp.name : '', query,
      ...(topicName ? { topicName } : {}),
      ...(extension ? { modelExtensionId: extension } : {}) });
  }
  return tiles;
}
function yamlValue(text: string): unknown {
  const doc = parseDocument(text, { strict: true, uniqueKeys: true, prettyErrors: false, intAsBigInt: true });
  if (doc.errors.length || doc.warnings.length) fail('Local YAML cannot be interpreted safely.');
  let nodes = 0;
  visit(doc, (_key, node, path) => {
    if (++nodes > 50_000 || path.length > 64 || isAlias(node) || (isNode(node) && (node.tag || ('anchor' in node && node.anchor)))) fail('Local YAML contains unsupported structure.');
    if (isMap(node)) for (const pair of node.items) if (!isScalar(pair.key) || typeof pair.key.value !== 'string'
      || ['__proto__', 'prototype', 'constructor', '<<'].includes(pair.key.value)) fail('Local YAML has unsupported mapping keys.');
  });
  return doc.toJS({ maxAliasCount: 0 });
}
function files(snapshot: OmniModelYamlResponse): Record<string, string> {
  // getModelYaml normalizes malformed responses to {}; raw evidence must corroborate every byte.
  if (!record(snapshot.raw) || !record(snapshot.raw.files) || !isDeepStrictEqual(snapshot.raw.files, snapshot.files)) {
    return fail('Complete authored local YAML evidence is unavailable.');
  }
  let bytes = 0;
  const entries = Object.entries(snapshot.raw.files);
  if (entries.length > 5_000) fail('Too many authored local YAML files.');
  for (const [name, text] of entries) {
    if (!safePath(name) || typeof text !== 'string' || Buffer.byteLength(text) > 2_000_000
      || (bytes += Buffer.byteLength(text)) > 20_000_000) fail('Authored local YAML exceeds the bounded file contract.');
    yamlValue(text);
  }
  return snapshot.files;
}
function empty(value: string): boolean {
  const parsed = yamlValue(value);
  return parsed === null || parsed === undefined || (record(parsed) && Object.keys(parsed).length === 0)
    || Array.isArray(parsed) && parsed.length === 0;
}
async function boundModel(client: OmniClient, modelId: string, kind: string, baseModelId?: string, connectionId?: string, signal?: AbortSignal) {
  const found = (await client.listModels({ modelId, modelKind: kind }, signal)).filter(row => row.id === modelId);
  if (found.length !== 1 || found[0].deletedAt || found[0].kind !== kind || !id(found[0].connectionId)
    || baseModelId && found[0].baseModelId !== baseModelId || connectionId && found[0].connectionId !== connectionId) {
    return fail('The exact local model kind, parent, and connection could not be verified.');
  }
  return found[0];
}

export async function loadDashboardPackage(client: OmniClient, documentId: string, signal?: AbortSignal): Promise<DashboardPackage> {
  if (!id(documentId)) fail('A selected dashboard identity is required.');
  const state = await client.getDocumentStateV2(documentId, signal);
  const native = payload(await client.exportDocument(documentId, signal));
  const workbook = native.workbookModel as Record<string, unknown>;
  const sharedModelId = propertyIdentity(state, ['modelId', 'baseModelId']);
  const workbookModelId = modelIdentity(workbook);
  if (!sharedModelId || state.workbookModelId !== workbookModelId || workbookModelId === sharedModelId
    || propertyIdentity(workbook, ['base_model_id', 'baseModelId']) !== sharedModelId) fail('Dashboard shared and workbook bindings disagree.');
  let shared = (await client.listModels({ modelId: sharedModelId, modelKind: 'SHARED' }, signal)).filter(row => row.id === sharedModelId);
  if (!shared.length) shared = (await client.listModels({ modelId: sharedModelId, modelKind: 'SHARED_EXTENSION' }, signal)).filter(row => row.id === sharedModelId);
  if (shared.length !== 1 || shared[0].deletedAt || !['SHARED', 'SHARED_EXTENSION'].includes(shared[0].kind || '') || !id(shared[0].connectionId)) fail('The dashboard shared-model connection is unavailable.');
  const connectionId = shared[0].connectionId;
  if (propertyIdentity(workbook, ['connection_id', 'connectionId']) !== connectionId) fail('Exported workbook connection differs from its shared model.');
  const queryModels = native.queryModels as Record<string, unknown>;
  const queryIds = Object.keys(queryModels);
  if (queryIds.some(key => !id(key) || key === sharedModelId || key === workbookModelId || modelIdentity(queryModels[key]) !== key)) fail('Exported query-model identities are invalid.');
  const tiles = listDashboardPackageTiles(native);
  const referenced = new Set(tiles.flatMap(tile => tile.modelExtensionId && tile.modelExtensionId !== workbookModelId ? [tile.modelExtensionId] : []));
  if (queryIds.some(key => !referenced.has(key)) || [...referenced].some(key => !Object.hasOwn(queryModels, key))) fail('Query models are not completely bound to selected dashboard tiles.');
  const localModels: DashboardPackageLocalModel[] = [];
  for (const local of [{ modelId: workbookModelId, scope: 'workbook' as const }, ...queryIds.sort().map(modelId => ({ modelId, scope: 'query' as const }))]) {
    await boundModel(client, local.modelId, local.scope === 'workbook' ? 'WORKBOOK' : 'QUERY', local.scope === 'workbook' ? sharedModelId : workbookModelId, connectionId, signal);
    const snapshot = await client.getModelYaml(local.modelId, { mode: 'extension', fullyResolved: false, includeChecksums: true, signal });
    localModels.push({ sourceModelId: local.modelId, scope: local.scope, files: files(snapshot) });
  }
  const topics = new Set(tiles.flatMap(tile => tile.topicName ? [tile.topicName] : []));
  const name = (native.document as Record<string, unknown>).name as string;
  if (typeof state.name !== 'string' || state.name !== name) fail('The dashboard changed while its package was being read.');
  const result = { documentId, name, sharedModelId, connectionId, exportPayload: structuredClone(native), workbookModelId,
    localModels, topicNames: [...topics].sort(), fieldRefs: dashboardSourceFieldReferences(tiles.map(tile => tile.query)) };
  bounded(result);
  signal?.throwIfAborted();
  return { ...result, fingerprint: hash(result) };
}

/** Rebind only native model/connection properties, never SQL, labels, filter literals, or arbitrary equal strings. */
export function retargetDashboardPackage(pkg: DashboardPackage, target: DashboardPackageTarget): Record<string, unknown> {
  if (![target.modelId, target.connectionId, target.identifier].every(id) || !target.name.trim() || target.name.length > 254
    || target.folderPath !== undefined && (!target.folderPath.trim() || target.folderPath.length > 2_000)) fail('The target dashboard binding is invalid.');
  const copy = structuredClone(payload(pkg.exportPayload));
  const models = [copy.workbookModel, ...Object.values(copy.queryModels as Record<string, unknown>)];
  const connections = new Set([pkg.connectionId, ...models.flatMap(model => record(model)
    ? ['connection_id', 'connectionId', 'environment_connection_id', 'environmentConnectionId'].flatMap(key => typeof model[key] === 'string' ? [model[key] as string] : []) : [])]);
  const rewrite = (value: Record<string, unknown>) => {
    for (const key of ['model_id', 'modelId', 'base_model_id', 'baseModelId']) if (value[key] === pkg.sharedModelId) value[key] = target.modelId;
    for (const key of ['connection_id', 'connectionId', 'environment_connection_id', 'environmentConnectionId']) {
      if (typeof value[key] === 'string' && connections.has(value[key] as string)) value[key] = target.connectionId;
    }
  };
  for (const model of models) { if (!record(model)) fail('Local model metadata is unavailable.'); rewrite(model); }
  for (const tile of listDashboardPackageTiles(copy)) rewrite(tile.query);
  copy.baseModelId = target.modelId; copy.identifier = target.identifier;
  (copy.document as Record<string, unknown>).name = target.name;
  delete copy.folderPath;
  if (target.folderPath !== undefined) copy.folderPath = target.folderPath;
  return copy;
}

function localPairs(pkg: DashboardPackage, imported: Record<string, unknown>, miniUuidMap: Record<string, string>): Map<string, string> {
  payload(imported); bounded(miniUuidMap);
  if (!record(miniUuidMap) || Object.entries(miniUuidMap).some(([from, to]) => !id(from) || !id(to))
    || new Set(Object.values(miniUuidMap)).size !== Object.keys(miniUuidMap).length) fail('Imported tile identity mapping is invalid or ambiguous.');
  const targetWorkbook = modelIdentity(imported.workbookModel);
  if (!pkg.workbookModelId) fail('Source workbook identity is unavailable.');
  const pairs = new Map([[pkg.workbookModelId, targetWorkbook]]);
  const destination = new Map(listDashboardPackageTiles(imported).map(tile => [tile.miniUuid, tile]));
  for (const source of listDashboardPackageTiles(pkg.exportPayload)) {
    if (!source.modelExtensionId || source.modelExtensionId === pkg.workbookModelId) continue;
    const mapped = miniUuidMap[source.miniUuid];
    const target = mapped ? destination.get(mapped) : undefined;
    if (!target?.modelExtensionId || !record(imported.queryModels) || !Object.hasOwn(imported.queryModels, target.modelExtensionId)
      || modelIdentity(imported.queryModels[target.modelExtensionId]) !== target.modelExtensionId) fail('A source query model has no exact imported tile/model pair.');
    const previous = pairs.get(source.modelExtensionId);
    if (previous && previous !== target.modelExtensionId) fail('One source query model maps to multiple imported models.');
    pairs.set(source.modelExtensionId, target.modelExtensionId);
  }
  const sourceIds = new Set([pkg.sharedModelId, ...pkg.localModels.map(local => local.sourceModelId)]);
  if (pairs.size !== pkg.localModels.length || new Set(pairs.values()).size !== pairs.size
    || [...pairs.values()].some(value => sourceIds.has(value))
    || pkg.localModels.some(local => !pairs.has(local.sourceModelId))
    || Object.keys(imported.queryModels as object).some(key => ![...pairs.values()].includes(key))) fail('Imported local-model identities are incomplete, reused, or conflicting.');
  return pairs;
}
function orderedFiles(source: Record<string, string>): string[] {
  const names = Object.keys(source).sort();
  const views = new Map<string, string[]>();
  for (const name of names.filter(name => name.endsWith('.view'))) {
    const path = name.replace(/\.(query\.view|view)$/, '');
    for (const alias of new Set([path, path.split('/').at(-1)!])) views.set(alias, [...(views.get(alias) || []), name]);
  }
  const deps = new Map<string, Set<string>>();
  for (const name of names) {
    const required = new Set<string>();
    const walk = (value: unknown, key = '') => {
      if (typeof value === 'string') {
        const references = [...value.matchAll(/\$\{([A-Za-z_][\w/]*)\.[^}]+\}/g)].map(match => match[1]);
        if (['base_view', 'base_view_name', 'join_from_view', 'join_to_view'].includes(key)) references.push(value);
        for (const reference of references) {
          const matches = views.get(reference) || [];
          if (matches.length > 1) fail('A local file dependency has an ambiguous view identity.');
          if (matches[0] && matches[0] !== name) required.add(matches[0]);
        }
      } else if (Array.isArray(value)) value.forEach(child => walk(child, key));
      else if (record(value)) for (const [childKey, child] of Object.entries(value)) {
        if (key === 'fields' && childKey.includes('.')) walk('${' + childKey + '}');
        walk(child, childKey);
      }
    };
    walk(yamlValue(source[name]));
    if (name.endsWith('.topic')) for (const file of names) if (file === 'relationships' || file.endsWith('.view')) required.add(file);
    if (name === 'relationships') for (const file of names) if (file.endsWith('.view')) required.add(file);
    if (name !== 'model' && Object.hasOwn(source, 'model')) required.add('model');
    deps.set(name, required);
  }
  const output: string[] = [], active = new Set<string>(), done = new Set<string>();
  const visitFile = (name: string) => {
    if (done.has(name)) return;
    if (active.has(name)) fail('Local YAML dependencies contain a cycle requiring review.');
    active.add(name); for (const dependency of deps.get(name) || []) visitFile(dependency);
    active.delete(name); done.add(name); output.push(name);
  };
  names.forEach(visitFile); return output;
}

/** Caller owns proof these are NEW imported artifacts and an exclusive durable job lease. Never use for an existing document. */
export async function restoreDashboardPackageLocals(pkg: DashboardPackage, importedExport: Record<string, unknown>, miniUuidMap: Record<string, string>,
  destinationClient: OmniClient, guard?: OmniWriteDispatchGuard,
  writeFile?: (input: Parameters<OmniClient['updateModelYamlFile']>[0]) => Promise<unknown>): Promise<DashboardPackageLocalReceipt[]> {
  const pairs = localPairs(pkg, importedExport, miniUuidMap);
  const workbook = importedExport.workbookModel as Record<string, unknown>;
  const targetShared = propertyIdentity(workbook, ['base_model_id', 'baseModelId']);
  const targetConnection = propertyIdentity(workbook, ['connection_id', 'connectionId']);
  if (!targetShared || !targetConnection || [...pairs.values()].includes(targetShared)) fail('Imported target model binding is unavailable.');
  const receipts: DashboardPackageLocalReceipt[] = [];
  const models = [...pkg.localModels].sort((a, b) => Number(a.scope === 'query') - Number(b.scope === 'query'));
  // Validate every local target before dispatching the first write.
  const expected = new Map<string, Record<string, string>>();
  for (const local of models) {
    guard?.signal?.throwIfAborted();
    const targetId = pairs.get(local.sourceModelId)!;
    await boundModel(destinationClient, targetId, local.scope === 'workbook' ? 'WORKBOOK' : 'QUERY',
      local.scope === 'workbook' ? targetShared : modelIdentity(workbook), targetConnection, guard?.signal);
    const initial = files(await destinationClient.getModelYaml(targetId, { mode: 'extension', fullyResolved: false, includeChecksums: true, signal: guard?.signal }));
    for (const [name, text] of Object.entries(initial)) if (!empty(text) && (!Object.hasOwn(local.files, name) || text !== local.files[name])) fail('An imported local model already contains differing authored definitions.');
    expected.set(targetId, { ...initial }); orderedFiles(local.files);
  }
  for (const local of models) {
    const targetId = pairs.get(local.sourceModelId)!;
    let filesWritten = 0;
    for (const name of orderedFiles(local.files)) {
      const before = await destinationClient.getModelYaml(targetId, { mode: 'extension', fullyResolved: false, includeChecksums: true, signal: guard?.signal });
      if (!isDeepStrictEqual(files(before), expected.get(targetId))) fail('The imported local model changed concurrently. No further local writes are allowed.');
      if (before.files[name] === local.files[name]) continue;
      if (!guard) fail('Local restoration requires new-artifact and exclusive-job write authority.');
      const previousChecksum = before.checksums?.[name];
      if (Object.hasOwn(before.files, name) && !previousChecksum) fail('An existing local file has no conflict checksum.');
      const input: Parameters<OmniClient['updateModelYamlFile']>[0] = { modelId: targetId, fileName: name, yaml: local.files[name], mode: 'extension',
        ...(previousChecksum ? { previousChecksum } : {}) };
      if (writeFile) await writeFile(input);
      else await destinationClient.updateModelYamlFile(input, guard);
      filesWritten++;
      expected.get(targetId)![name] = local.files[name];
      const after = await destinationClient.getModelYaml(targetId, { mode: 'extension', fullyResolved: false, includeChecksums: true, signal: guard.signal });
      if (!isDeepStrictEqual(files(after), expected.get(targetId))) fail('Local YAML write was not verified exactly. Reconcile the retained imported document; do not repeat the import.');
      guard.signal?.throwIfAborted();
    }
    const final = files(await destinationClient.getModelYaml(targetId, { mode: 'extension', fullyResolved: false, includeChecksums: true, signal: guard?.signal }));
    if (!isDeepStrictEqual(final, expected.get(targetId))) fail('The imported local model changed before verification completed.');
    receipts.push({ sourceModelId: local.sourceModelId, targetModelId: targetId, scope: local.scope,
      files: Object.keys(local.files).sort(), fingerprint: hash(final), filesWritten });
  }
  guard?.signal?.throwIfAborted();
  return receipts;
}

/** Verifies the content envelope/tile semantics only. Pair with local YAML receipts and separate query results. */
export function verifyDashboardPackageContent(pkg: DashboardPackage, importedExport: Record<string, unknown>, miniUuidMap: Record<string, string> = {},
  target?: DashboardPackageTarget): DashboardPackageContentVerification {
  let sourceHash = '', destinationHash = '';
  try {
    bounded(pkg.exportPayload); bounded(importedExport);
    sourceHash = hash(pkg.exportPayload); destinationHash = hash(importedExport);
    const pairs = localPairs(pkg, importedExport, miniUuidMap);
    const importedWorkbook = importedExport.workbookModel as Record<string, unknown>;
    const modelId = propertyIdentity(importedWorkbook, ['base_model_id', 'baseModelId']);
    const connectionId = propertyIdentity(importedWorkbook, ['connection_id', 'connectionId']);
    if (!modelId || !connectionId || target && (modelId !== target.modelId || connectionId !== target.connectionId)) fail('Imported destination binding differs from approval.');
    const expected = retargetDashboardPackage(pkg, target || { modelId, connectionId, name: pkg.name, identifier: 'comparison-only' });
    const mappings = new Map<string, string>(pairs);
    const bind = (from: string, to: string) => {
      if (mappings.has(from) && mappings.get(from) !== to
        || [...mappings].some(([key, value]) => key !== from && value === to)) fail('Imported content identity mapping is ambiguous.');
      mappings.set(from, to);
    };
    const a = memberships(expected), b = memberships(importedExport);
    const targetRows = new Map(b.map(row => [(row.queryPresentation as Record<string, unknown>).miniUuid, row]));
    if (a.length !== b.length) fail('Imported dashboard has missing or additional tiles.');
    const addIds = (left: unknown, right: unknown) => {
      if (!record(left) || !record(right)) return;
      if (id(left.id) && id(right.id)) bind(left.id, right.id);
    };
    addIds(expected.document, importedExport.document); addIds(expected.dashboard, importedExport.dashboard);
    addIds((expected.dashboard as Record<string, unknown>).queryPresentationCollection, (importedExport.dashboard as Record<string, unknown>).queryPresentationCollection);
    for (const row of a) {
      const sourceTile = row.queryPresentation as Record<string, unknown>;
      const mapped = miniUuidMap[sourceTile.miniUuid as string];
      const destinationRow = mapped ? targetRows.get(mapped) : undefined;
      if (!destinationRow) fail('Imported tile pairing is unavailable; tile names do not authorize a match.');
      const destinationTile = destinationRow.queryPresentation as Record<string, unknown>;
      bind(sourceTile.miniUuid as string, mapped);
      addIds(row, destinationRow); addIds(sourceTile, destinationTile); addIds(sourceTile.query, destinationTile.query);
    }
    const identityKeys = new Set(['id', 'miniUuid', 'queryPresentationId', 'queryPresentationCollectionId', 'queryId', 'workbookModelId', 'model_extension_id', 'modelExtensionId']);
    const membershipPath = 'dashboard.queryPresentationCollection.queryPresentationCollectionMemberships.[]';
    const metadataPaths = new Set(['document', 'dashboard', 'dashboard.queryPresentationCollection', membershipPath,
      membershipPath + '.queryPresentation', membershipPath + '.queryPresentation.query']);
    const normalize = (value: unknown, fromSource: boolean, path: string[] = []): unknown => {
      if (Array.isArray(value)) return value.map(child => normalize(child, fromSource, [...path, '[]']));
      if (!record(value)) return value;
      const metadata = metadataPaths.has(path.join('.'));
      const queryRoot = path.join('.') === membershipPath + '.queryPresentation.query.queryJson';
      return Object.fromEntries(Object.entries(value).filter(([key]) => !(metadata && ['createdAt', 'updatedAt', 'created_at', 'updated_at'].includes(key)))
        .map(([key, child]) => [key, fromSource && (metadata || queryRoot && ['model_extension_id', 'modelExtensionId'].includes(key))
          && identityKeys.has(key) && typeof child === 'string' && mappings.has(child)
          ? mappings.get(child) : normalize(child, fromSource, [...path, key])]));
    };
    const content = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['workbookModel', 'queryModels', 'baseModelId', 'identifier', 'folderPath'].includes(key)));
    if (!isDeepStrictEqual(normalize(content(expected), true), normalize(content(importedExport), false))) fail('Imported dashboard content or tile semantics differ from the approved package.');
    return { verified: true, findings: [], sourceHash, destinationHash, checkedTiles: listDashboardPackageTiles(importedExport).length,
      queriesVerified: false, localModelsVerified: false };
  } catch (error) {
    return { verified: false, findings: [error instanceof DashboardPackageTransportError ? error.message : 'Dashboard content could not be safely compared.'],
      sourceHash, destinationHash, checkedTiles: 0, queriesVerified: false, localModelsVerified: false };
  }
}
