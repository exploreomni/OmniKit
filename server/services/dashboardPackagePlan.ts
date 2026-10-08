import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml';
import type { DashboardSafeCopyIntent, DashboardSafeCopyDestination } from '../../shared/dashboardSafeCopyContract';
import type { DashboardDeploymentPlan, DashboardDeploymentTargetReadiness } from '../../shared/dashboardDeploymentPlan';
import { DASHBOARD_READINESS_EVIDENCE_VERSION } from '../../shared/dashboardDeploymentPlan';
import type { DashboardPackagePreview, DashboardPackageIssue } from '../../shared/dashboardPackage';
import type { DashboardReadinessRunContext } from './dashboardReadinessControl';
import { getInstance } from './nativeVault';
import { assertDashboardSafeCopyInstanceRoles } from './dashboardSafeCopyJobs';
import { OmniClient, type OmniModelRecord, type OmniModelYamlResponse } from './omniClient';
import { loadDashboardPackage, listDashboardPackageTiles, type DashboardPackage } from './dashboardPackageTransport';
import { planDashboardPackageDependencies } from './dashboardPackageDependencies';
import { dashboardSourceFieldReferences } from './dashboardSourceEvidence';
import { previewDashboardRepairYaml } from './dashboardRepairYaml';
import { redactSensitiveText } from './jobSanitizer';

export function packageHash(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function packageClient(instanceId: string, signal?: AbortSignal): OmniClient {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('A selected instance is unavailable. Unlock the vault and reconnect.');
  return new OmniClient(instance, { signal });
}
export function packageBoundary(intent: DashboardSafeCopyIntent): string {
  return packageHash([...new Set([intent.source.instanceId, ...intent.destinations.map(row => row.instanceId)])].sort().map(id => {
    const instance = getInstance(id);
    if (!instance) throw new Error('The selected instance is unavailable.');
    return { id, baseUrl: instance.baseUrl, credential: instance.apiKey, role: instance.role };
  }));
}
async function exactModel(client: OmniClient, modelId: string, connectionId: string): Promise<OmniModelRecord> {
  let models = await client.listModels({ modelId, connectionId, modelKind: 'SHARED' });
  if (!models.some(row => row.id === modelId)) models = await client.listModels({ modelId, connectionId, modelKind: 'SHARED_EXTENSION' });
  const matches = models.filter(row => row.id === modelId && row.connectionId === connectionId && !row.deletedAt
    && ['SHARED', 'SHARED_EXTENSION'].includes(row.kind || ''));
  if (matches.length !== 1) throw new Error('The selected model does not resolve to this connection. Choose it again.');
  return matches[0];
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safePath = (value: string) => !!value && value.length <= 512 && !value.includes('\\')
  && value.split('/').every(part => !!part && part !== '.' && part !== '..')
  && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export function authoredSnapshot(snapshot: OmniModelYamlResponse): OmniModelYamlResponse {
  // The client deliberately normalizes malformed maps. That normalization is not
  // evidence of an empty model and must never authorize new destination files.
  if (!record(snapshot.raw) || !record(snapshot.raw.files) || !isDeepStrictEqual(snapshot.raw.files, snapshot.files)) {
    throw new Error('Complete authored model YAML evidence is unavailable. Recheck the selected model.');
  }
  const entries = Object.entries(snapshot.files);
  let bytes = 0;
  if (entries.length > 5_000 || entries.some(([name, text]) => !safePath(name) || typeof text !== 'string'
    || Buffer.byteLength(text) > 2_000_000 || (bytes += Buffer.byteLength(text)) > 20_000_000)) {
    throw new Error('Authored model YAML exceeds the bounded package inventory.');
  }
  if ((snapshot.raw.checksums !== undefined || snapshot.checksums !== undefined) && (!record(snapshot.raw.checksums)
    || !isDeepStrictEqual(snapshot.raw.checksums, snapshot.checksums))) {
    throw new Error('Complete authored model checksum evidence is unavailable.');
  }
  if (snapshot.checksums !== undefined && (!record(snapshot.checksums) || Object.keys(snapshot.checksums).length > 5_000
    || Object.entries(snapshot.checksums).some(([name, value]) => !safePath(name) || typeof value !== 'string'
      || !value || value.length > 1_024 || !Object.hasOwn(snapshot.files, name)))) {
    throw new Error('Authored model checksum evidence has an unsupported shape.');
  }
  return snapshot;
}

function localValue(text: string): unknown {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2_000_000) throw new Error('Local YAML exceeds the bounded package scope.');
  const document = parseDocument(text, { strict: true, uniqueKeys: true, prettyErrors: false, intAsBigInt: true });
  if (document.errors.length || document.warnings.length) throw new Error('Local YAML is not safely readable.');
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (++nodes > 50_000 || path.length > 64 || isAlias(node) || isNode(node) && (node.tag || 'anchor' in node && node.anchor)) {
      throw new Error('Local YAML contains unsupported structure.');
    }
    if (isMap(node)) for (const pair of node.items) if (!isScalar(pair.key) || typeof pair.key.value !== 'string'
      || ['__proto__', 'prototype', 'constructor', '<<'].includes(pair.key.value)) throw new Error('Local YAML contains unsafe keys.');
  });
  return document.toJS({ maxAliasCount: 0 });
}
const emptyLocal = (value: unknown) => value == null || record(value) && !Object.keys(value).length || Array.isArray(value) && !value.length;

/** A query sees its own extension over the workbook, never a sibling query's files. */
function tileScopes(pkg: DashboardPackage, issues: DashboardPackageIssue[]) {
  const scopes: Array<{ reference: string; localFiles: Record<string, string>; topicNames: string[]; fieldRefs: string[] }> = [];
  const workbooks = pkg.localModels.filter(local => local.scope === 'workbook' && local.sourceModelId === pkg.workbookModelId);
  if (workbooks.length !== 1 || new Set(pkg.localModels.map(local => local.sourceModelId)).size !== pkg.localModels.length) {
    issues.push({ code: 'LOCAL_MODEL_SCOPE_UNAVAILABLE', reference: pkg.documentId, message: 'The exact workbook and query-model scopes could not be bound. Recheck this dashboard.' });
    return scopes;
  }
  for (const tile of listDashboardPackageTiles(pkg.exportPayload).sort((a, b) => a.miniUuid.localeCompare(b.miniUuid))) {
    const reference = pkg.documentId + '/' + tile.miniUuid;
    const layers = [workbooks[0]];
    if (tile.modelExtensionId && tile.modelExtensionId !== pkg.workbookModelId) {
      const query = pkg.localModels.filter(local => local.scope === 'query' && local.sourceModelId === tile.modelExtensionId);
      if (query.length !== 1) {
        issues.push({ code: 'LOCAL_MODEL_SCOPE_UNAVAILABLE', reference, message: 'This tile has no exact query-local model. No sibling model can supply its definitions.' });
        continue;
      }
      layers.push(query[0]);
    }
    const localFiles: Record<string, string> = {};
    let blocked = false;
    for (const layer of layers) for (const [fileName, text] of Object.entries(layer.files).sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const value = localValue(text);
        if (emptyLocal(value)) continue;
        if (!fileName.endsWith('.view') || !record(value)) {
          issues.push({ code: 'LOCAL_DEPENDENCY_SCOPE_UNSUPPORTED', reference: reference + '/' + fileName,
            message: 'This local topic, relationship, model setting, or unsupported definition requires explicit scoped dependency/security review; it is not a shared definition.' });
          blocked = true; continue;
        }
        // This composition is dependency evidence only. Native local restoration
        // retains each original model and its authored bytes independently.
        const before = localFiles[fileName];
        localFiles[fileName] = before === undefined ? text : isDeepStrictEqual(localValue(before), value) ? before
          : previewDashboardRepairYaml(before, text).yaml;
      } catch {
        issues.push({ code: 'LOCAL_LAYER_CONFLICT', reference: reference + '/' + fileName,
          message: 'Workbook and query-local definitions cannot be safely composed as complete additive definitions. Resolve this tile’s local override without promoting it to the shared model.' });
        blocked = true;
      }
    }
    if (!blocked) scopes.push({ reference, localFiles, topicNames: tile.topicName ? [tile.topicName] : [],
      fieldRefs: dashboardSourceFieldReferences(tile.query) });
  }
  return scopes;
}
export interface DashboardPackageCollection {
  packages: DashboardPackage[];
  shared: Map<string, OmniModelYamlResponse>;
  sourceHashes: Record<string, string>;
  sourceModelHashes: Record<string, string>;
  dialect: string;
  boundary: string;
}
export async function collectDashboardPackages(intent: DashboardSafeCopyIntent, signal?: AbortSignal): Promise<DashboardPackageCollection> {
  assertDashboardSafeCopyInstanceRoles(intent);
  const boundary = packageBoundary(intent);
  const client = packageClient(intent.source.instanceId, signal);
  const connections = await client.listConnections();
  const connection = connections.find(row => row.id === intent.source.connectionId && !row.deletedAt);
  if (!connection?.dialect) throw new Error('The source connection dialect could not be read.');
  const result: DashboardPackageCollection = { packages: [], shared: new Map(), sourceHashes: {}, sourceModelHashes: {}, dialect: connection.dialect, boundary };
  for (const id of [...intent.source.documentIds].sort()) {
    signal?.throwIfAborted();
    const pkg = await loadDashboardPackage(client, id, signal);
    if (pkg.connectionId !== intent.source.connectionId) throw new Error('A selected dashboard belongs to a different source connection.');
    await exactModel(client, pkg.sharedModelId, intent.source.connectionId);
    if (!result.shared.has(pkg.sharedModelId)) result.shared.set(pkg.sharedModelId,
      authoredSnapshot(await client.getModelYaml(pkg.sharedModelId, { mode: 'combined', fullyResolved: false, includeChecksums: true })));
    result.packages.push(pkg);
    result.sourceHashes[id] = packageHash(pkg.fingerprint);
    result.sourceModelHashes[pkg.sharedModelId] = packageHash(result.shared.get(pkg.sharedModelId)!.files);
  }
  if (packageBoundary(intent) !== boundary) throw new Error('A saved connection changed while the package was being read.');
  return result;
}

export async function prepareDashboardPackageTarget(intent: DashboardSafeCopyIntent, destination: DashboardSafeCopyDestination,
  collection: DashboardPackageCollection, signal?: AbortSignal) {
  const client = packageClient(destination.instanceId, signal);
  signal?.throwIfAborted();
  if (packageBoundary(intent) !== collection.boundary) throw new Error('A saved connection changed. Recheck the package.');
  const model = await exactModel(client, destination.modelId, destination.connectionId);
  const connections = await client.listConnections();
  const connection = connections.find(row => row.id === destination.connectionId && !row.deletedAt);
  const issues: DashboardPackageIssue[] = [];
  const normalizeDialect = (value: string) => value.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (!connection?.dialect || normalizeDialect(connection.dialect) !== normalizeDialect(collection.dialect)) issues.push({
    code: 'DIALECT_TRANSFORMATION_REQUIRED', reference: destination.modelId,
    message: 'These connections use different SQL dialects. Transform the model in Model Migrator first, then resume this dashboard plan.' });
  if ((destination.topicMappings || []).some(row => row.sourceTopicName !== row.targetTopicName)
    || (destination.queryViewMappings || []).some(row => row.sourceQueryViewName !== row.targetQueryViewName)) issues.push({
    code: 'REFERENCE_RENAME_REQUIRES_REVIEW', reference: destination.targetId,
    message: 'This copy preserves authored topic and view names. Remove the old rename mapping or prepare the renamed model first.' });
  if (!destination.folderId && !destination.folderPath) issues.push({ code: 'DESTINATION_FOLDER_REQUIRED', reference: destination.targetId,
    message: 'Choose an explicit destination folder. The native import default is not treated as a verified top-level placement.' });
  let folderId = destination.folderId;
  let folderPath = destination.folderPath;
  if (folderId || folderPath) {
    const inventory = await client.listFolderInventory(signal);
    const norm = (text: string | undefined) => (text || '').replace(/^\/+|\/+$/g, '');
    const matches = inventory.folders.filter(folder => (!folderId || folder.id === folderId)
      && (!folderPath || norm(folder.path) === norm(folderPath)));
    const path = matches[0]?.path;
    if (!inventory.pagination.complete || matches.length !== 1 || !path || !safePath(norm(path))
      || inventory.folders.filter(folder => norm(folder.path) === norm(path)).length !== 1) {
      throw new Error('The destination folder could not be resolved to one exact, unique native path.');
    }
    folderId = matches[0].id; folderPath = matches[0].path;
  }
  const snapshot = authoredSnapshot(await client.getModelYaml(destination.modelId, { mode: 'combined', fullyResolved: false, includeChecksums: true }));
  const files = new Map<string, DashboardPackagePreview['files'][number]>();
  const bindings = new Map<string, NonNullable<DashboardPackagePreview['bindingMappings']>[number]>();
  const ambiguousBindings = new Set<string>();
  // Each source model contributes to the same destination package. Do not let
  // one source overwrite another source's definition during aggregation.
  const projected = { ...snapshot.files };
  for (const pkg of [...collection.packages].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
    const sourceFiles = authoredSnapshot(collection.shared.get(pkg.sharedModelId)!).files;
    for (const scope of tileScopes(pkg, issues)) {
      signal?.throwIfAborted();
      const planned = planDashboardPackageDependencies({ sourceFiles,
        targetFiles: projected, topicNames: scope.topicNames, fieldRefs: scope.fieldRefs, localFiles: scope.localFiles,
        bindingMappings: destination.bindingMappings });
      for (const mapping of planned.bindingMappings || []) {
        // Only existing destination views are eligible, never another tile's proposed new file.
        if (!Object.hasOwn(snapshot.files, mapping.targetFileName)) continue;
        const key = JSON.stringify([mapping.sourceFileName, mapping.targetFileName]);
        const previous = bindings.get(key);
        if (previous && packageHash(previous) !== packageHash(mapping)) ambiguousBindings.add(key);
        else bindings.set(key, mapping);
      }
      issues.push(...planned.issues.map(issue => ({ ...issue, reference: scope.reference + '/' + issue.reference })));
      for (const file of planned.files) {
        const previous = files.get(file.fileName);
        const conflict = previous?.action === 'conflict' ? previous : file.action === 'conflict' ? file : undefined;
        const next = previous ? { ...file, before: previous.before,
          ...(conflict ? { sourceFileName: conflict.sourceFileName, reason: conflict.reason,
            sourceComparison: conflict.sourceComparison, after: conflict.after } : {}),
          action: file.action === 'conflict' || previous.action === 'conflict' ? 'conflict' as const
            : previous.before === file.after ? 'reuse' as const : Object.hasOwn(snapshot.files, file.fileName) ? 'add' as const : 'create' as const } : file;
        files.set(file.fileName, next);
        if (next.action !== 'conflict') projected[file.fileName] = next.after;
      }
    }
  }
  for (const key of ambiguousBindings) {
    bindings.delete(key);
    issues.push({ code: 'DATABASE_SCHEMA_MAPPING_AMBIGUOUS', reference: destination.targetId,
      message: 'Selected source models require different database/schema mappings for the same view. Separate their migration plans.' });
  }
  const bindingMappings = [...bindings.values()].sort((a, b) => a.sourceFileName.localeCompare(b.sourceFileName) || a.targetFileName.localeCompare(b.targetFileName));
  for (const approved of destination.bindingMappings || []) if (!bindingMappings.some(mapping => packageHash(mapping) === packageHash(approved))) {
    issues.push({ code: 'DATABASE_SCHEMA_MAPPING_STALE', reference: approved.sourceFileName,
      message: 'An approved database/schema choice no longer matches the current source and destination. Clear the saved choices, recheck, and review the new bindings.' });
  }
  for (const file of files.values()) if (file.action === 'add' && !snapshot.checksums?.[file.fileName]) issues.push({
    code: 'DESTINATION_CHECKSUM_UNAVAILABLE', reference: file.fileName,
    message: 'The existing destination file has no authoritative checksum. Recheck before preparing any additive write.' });
  for (const file of files.values()) if (file.action === 'conflict') issues.push({ code: 'DEPENDENCY_CONFLICT', reference: file.fileName,
    message: file.reason || 'An existing definition differs. Review the exact difference; it will not be overwritten.' });
  const requiresPr = model.pullRequestRequired === true || model.gitProtected === true || model.gitFollower === true;
  const preview: DashboardPackagePreview = { version: 1, fingerprint: '', requiresPr, bindingMappings,
    documents: collection.packages.map(pkg => ({ sourceDocumentId: pkg.documentId, name: pkg.name, localModelCount: pkg.localModels.length }))
      .sort((a, b) => a.sourceDocumentId.localeCompare(b.sourceDocumentId)),
    files: [...files.values()].sort((a, b) => a.fileName.localeCompare(b.fileName)),
    issues: [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()]
      .sort((a, b) => a.reference.localeCompare(b.reference) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message)) };
  preview.fingerprint = packageHash({ sourceHashes: collection.sourceHashes, sourceModelHashes: collection.sourceModelHashes,
    boundary: packageBoundary({ ...intent, destinations: [destination] }), targetFiles: snapshot.files, targetChecksums: snapshot.checksums || {},
    sourceDialect: collection.dialect, targetDialect: connection?.dialect,
    model: { id: model.id, kind: model.kind, connectionId: model.connectionId, baseModelId: model.baseModelId,
      pullRequestRequired: model.pullRequestRequired, gitProtected: model.gitProtected, gitFollower: model.gitFollower },
    destination: { ...destination, folderId, folderPath }, requiresPr, files: preview.files, issues: preview.issues, bindingMappings });
  signal?.throwIfAborted();
  if (packageBoundary(intent) !== collection.boundary) throw new Error('A saved connection changed. Recheck the package.');
  return { client, model, snapshot, preview, destination: { ...destination, folderId, folderPath } };
}

export async function inspectDashboardPackagePlan(plan: DashboardDeploymentPlan, run: DashboardReadinessRunContext): Promise<DashboardDeploymentPlan> {
  run.report('source_dashboard', { completed: 0, total: plan.intent.source.documentIds.length });
  const collection = await collectDashboardPackages(plan.intent, run.signal);
  run.report('source_dashboard', { completed: plan.intent.source.documentIds.length, total: plan.intent.source.documentIds.length });
  const destinations: DashboardSafeCopyDestination[] = [];
  const targets: DashboardDeploymentTargetReadiness[] = [];
  for (const destination of plan.intent.destinations) {
    run.throwIfAborted();
    const previous = plan.targets.find(row => row.targetId === destination.targetId);
    const target: DashboardDeploymentTargetReadiness = { targetId: destination.targetId, status: 'unverified', checkedAt: Date.now(),
      findings: [], sourceModelIds: [...collection.shared.keys()], requiredFiles: [], requiredFilesByModelId: {},
      ...(previous?.deploymentJobId ? { deploymentJobId: previous.deploymentJobId } : {}) };
    try {
      const prepared = await prepareDashboardPackageTarget(plan.intent, destination, collection, run.signal);
      destinations.push(prepared.destination);
      const { files, ...summary } = prepared.preview;
      target.package = { ...summary, files: files.map(file => ({ fileName: file.fileName, sourceFileName: file.sourceFileName,
        action: file.action, ...(file.reason ? { reason: file.reason } : {}) })) };
      target.modelHash = packageHash(prepared.snapshot.files);
      target.requiredFiles = files.map(file => file.fileName);
      target.status = summary.issues.length ? 'unverified' : 'ready';
      target.findings = summary.issues.map(issue => ({ id: packageHash(issue).slice(0, 20), kind: 'model', reference: issue.reference,
        message: issue.message, documentIds: plan.intent.source.documentIds, causeCode: issue.code, category: 'cannot_verify' }));
    } catch (error) {
      run.throwIfAborted();
      destinations.push(destination);
      target.findings = [{ id: 'package_evidence_unavailable', kind: 'connection', reference: destination.targetId,
        message: redactSensitiveText(error instanceof Error ? error.message : 'Package evidence could not be read.'),
        documentIds: plan.intent.source.documentIds, category: 'cannot_verify' }];
    }
    targets.push(target);
    run.report('comparison', { completed: targets.length, total: plan.intent.destinations.length, targetId: destination.targetId });
  }
  if (packageBoundary(plan.intent) !== collection.boundary) throw new Error('A saved connection changed. Recheck the package.');
  return { ...plan, packageVersion: 1, intent: { ...plan.intent, destinations }, targets,
    sourceHashes: collection.sourceHashes, sourceModelHashes: collection.sourceModelHashes, workbookCopies: undefined,
    evidenceVersion: DASHBOARD_READINESS_EVIDENCE_VERSION, revision: plan.revision + 1, updatedAt: Date.now() };
}
