import { randomUUID } from 'node:crypto';

import { jsonHeaders } from '../security';
import { createModelMigrationJob, mergeModelMigrationJob, type ModelMigrationAcceptedFile, type ModelMigrationContentInput, type ModelMigrationContentRepairAction, type ModelMigrationModelInput, type ModelMigrationSemanticDecision } from '../services/migrationJobs';
import { getInstance, isVaultUnlocked, type PostMigrationAction, type SavedInstance } from '../services/nativeVault';
import { OmniClient, type OmniDocumentRecord, type OmniModelRecord } from '../services/omniClient';
import {
  createModelMigratorReadClient,
  loadModelMigratorConnections,
  loadModelMigratorDocumentInventory,
  loadModelMigratorInstanceCatalogs,
  loadModelMigratorSchemaLists,
  loadModelMigratorSchemaModels,
  loadModelMigratorSharedModels,
  ModelMigratorRequestError,
  normalizeModelMigratorRequestError,
  runModelMigratorInteractiveOperation,
  type ModelMigratorInstanceCatalog,
} from '../services/modelMigratorCatalog';
import {
  buildFieldUniverseFromYaml,
  buildSemanticDifferenceDecisions,
  buildTranslatedYamlFiles,
  parseSchemaMap,
  preflightWorkbookQueryFields,
  promptForYamlFile,
  rewriteQueryModelReferences,
} from '../services/modelMigration/helpers';
import { runAiDialectPass, shouldRunAiDialectPass } from '../services/modelMigration/aiTranslation';
import { redactSensitiveText } from '../services/jobSanitizer';
import { resolveDashboardRepairScope, validateDashboardRepairModels, withDashboardRepairSubmission } from '../services/dashboardDeploymentPlans';
import { dashboardSafeCopyStateHash } from '../services/dashboardSafeCopyRuntime';
import { assertDashboardRepairYamlPreservesTarget, mergeDashboardRepairYaml } from '../services/dashboardRepairYaml';
import { issueDashboardRepairApproval, verifyDashboardRepairApproval } from '../services/dashboardRepairApproval';
import { dashboardRepairInstanceBoundaryHash, readDashboardRepairSourceBinding, type DashboardRepairSourceBinding } from '../services/dashboardRepairRuntime';

export type ModelMigratorDocumentKind = 'dashboard' | 'workbook' | 'unknown';

export interface ModelMigratorInventoryDocument {
  id: string;
  identifier: string;
  name: string;
  folderId?: string;
  folderPath?: string;
  baseModelId?: string;
  type?: string;
  kind: ModelMigratorDocumentKind;
  description?: string | null;
  labels?: string[];
  updatedAt?: string;
}

export interface ModelMigratorInventoryRow {
  modelId: string;
  dashboardCount: number;
  workbookCount: number;
  unknownCount: number;
  documents: ModelMigratorInventoryDocument[];
}

interface ModelMigratorReadinessCheck {
  id: string;
  label: string;
  status: 'ready' | 'warning' | 'blocked' | 'unknown';
  message: string;
  detail?: string;
}

interface ModelMigratorReadinessInstance {
  instanceId: string;
  label: string;
  baseUrlHost: string;
  role: string;
  reachable: boolean;
  connections: number;
  sharedModels: number;
  schemaModels: number;
  checks: ModelMigratorReadinessCheck[];
}

interface ModelMigratorReadinessPair {
  sourceModelId: string;
  targetModelId?: string;
  status: 'ready' | 'warning' | 'blocked' | 'unknown';
  recommendedPath: 'fast' | 'translate' | 'impact_report';
  releaseMode: 'direct' | 'pr' | 'validate_only';
  autoMigrationCapability?: 'confirmed' | 'requires_confirmation' | 'blocked' | 'unknown';
  schemaOverlap?: {
    sourceSchemas: string[];
    targetSchemas: string[];
    overlappingSchemas: string[];
  };
  checks: ModelMigratorReadinessCheck[];
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function repairConflict(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 409 });
}

function assertActionableRepairScope(scope: ReturnType<typeof resolveDashboardRepairScope>) {
  if (scope.target.status !== 'model_changes_required' || scope.target.repairJobId) {
    repairConflict('Return to dashboard deployment and recheck this destination before starting another dependency repair.');
  }
  const names = scope.target.sourceModelIds.flatMap((modelId) => scope.target.requiredFilesByModelId[modelId] || []);
  if (scope.target.sourceModelIds.some((modelId) => !scope.target.requiredFilesByModelId[modelId]?.length)
    || new Set(names).size !== names.length || names.length !== scope.target.requiredFiles.length
    || names.some((name) => !scope.target.requiredFiles.includes(name))) {
    repairConflict('The required dependency files have incomplete or conflicting source model ownership.');
  }
  dashboardRepairInstanceBoundaryHash(scope.plan.intent.source.instanceId, scope.destination.instanceId,
    scope.destination.modelId, Object.keys(scope.plan.sourceModelHashes));
}

function repairSourceBindingInput(scope: ReturnType<typeof resolveDashboardRepairScope>, instanceBoundaryHash: string) {
  const documentIds = scope.plan.intent.source.documentIds;
  if (!documentIds.length || documentIds.some((id) => !Object.hasOwn(scope.plan.sourceHashes, id))
    || scope.target.sourceModelIds.some((id) => !Object.hasOwn(scope.plan.sourceModelHashes, id))) {
    repairConflict('The repair plan is missing selected source evidence. Recheck dashboard readiness.');
  }
  return { sourceId: scope.plan.intent.source.instanceId, targetId: scope.destination.instanceId,
    targetModelId: scope.destination.modelId, sourceModelIds: Object.keys(scope.plan.sourceModelHashes), instanceBoundaryHash,
    sourceDocumentHashes: Object.fromEntries(documentIds.map((id) => [id, scope.plan.sourceHashes[id]])),
    reviewedWorkbookCopies: scope.plan.workbookCopies || {} };
}

function assertRepairYamlHash(files: Record<string, string>, expected: string | undefined, side: string) {
  if (!expected || dashboardSafeCopyStateHash(files) !== expected) {
    repairConflict(`${side} model changed or could not be verified against the reviewed plan. Return to dashboard deployment and recheck.`);
  }
}

function canUseModelMigratorInstance(instance: SavedInstance, usage: 'source' | 'destination'): boolean {
  return instance.role === 'both' || instance.role === usage;
}

function modelMigratorRoleError(usage: 'source' | 'destination'): Response {
  return json({
    error: `The saved instance is not authorized for Model Migrator ${usage} operations.`,
    code: usage === 'source' ? 'MODEL_MIGRATOR_SOURCE_ROLE_REQUIRED' : 'MODEL_MIGRATOR_DESTINATION_ROLE_REQUIRED',
  }, 403);
}

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseCsv(value: string | null): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isActiveModel(model: OmniModelRecord): boolean {
  return !model.deletedAt;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function parseStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
      .map(([key, row]) => [key, row.trim()]),
  );
}

function hostLabel(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

function check(
  id: string,
  label: string,
  status: ModelMigratorReadinessCheck['status'],
  message: string,
  detail?: string,
): ModelMigratorReadinessCheck {
  return {
    id,
    label,
    status,
    message,
    ...(detail ? { detail: redactSensitiveText(detail) } : {}),
  };
}

function worstStatus(checks: ModelMigratorReadinessCheck[]): ModelMigratorReadinessCheck['status'] {
  if (checks.some((row) => row.status === 'blocked')) return 'blocked';
  if (checks.some((row) => row.status === 'warning')) return 'warning';
  if (checks.some((row) => row.status === 'unknown')) return 'unknown';
  return 'ready';
}

function inspectReadinessInstance(
  secret: SavedInstance,
  catalog: ModelMigratorInstanceCatalog,
): {
  instance: ModelMigratorReadinessInstance;
  connections: ModelMigratorInstanceCatalog['connections'];
  models: OmniModelRecord[];
} {
  const checks: ModelMigratorReadinessCheck[] = [];
  const connections = catalog.connections.filter((connection) => !connection.deletedAt);
  const models = catalog.sharedModels.filter(isActiveModel);
  const schemaModels = catalog.schemaModels.filter(isActiveModel).length;
  checks.push(check('connectivity', 'API connectivity', 'ready', 'OmniKit can reach this Omni instance.'));
  checks.push(connections.length > 0
    ? check('connections', 'Connections', 'ready', `${connections.length} active connection${connections.length === 1 ? '' : 's'} available.`)
    : check('connections', 'Connections', 'blocked', 'No active connections were returned for this instance.'));
  checks.push(models.length > 0
    ? check('shared-models', 'Shared models', 'ready', `${models.length} active shared model${models.length === 1 ? '' : 's'} available.`)
    : check('shared-models', 'Shared models', 'warning', 'No active shared models were returned for this instance.'));
  return {
    instance: {
      instanceId: secret.id,
      label: secret.label,
      baseUrlHost: hostLabel(secret.baseUrl),
      role: secret.role,
      reachable: true,
      connections: connections.length,
      sharedModels: models.length,
      schemaModels,
      checks,
    },
    connections,
    models,
  };
}

function modelMigratorRequestErrorResponse(error: unknown, signal?: AbortSignal): Response {
  const normalized = normalizeModelMigratorRequestError(error, signal);
  return json({
    error: normalized.message,
    code: normalized.code,
    retryable: normalized.retryable,
  }, normalized.statusCode);
}

async function runModelMigratorReadResponse(
  req: Request,
  operation: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  try {
    return await runModelMigratorInteractiveOperation(operation, { signal: req.signal });
  } catch (error) {
    return modelMigratorRequestErrorResponse(error, req.signal);
  }
}

function buildReadinessPairs(input: {
  sourceModelIds: string[];
  targetModelBySourceId: Record<string, string>;
  sourceModels: OmniModelRecord[];
  targetModels: OmniModelRecord[];
  sourceSchemasByModel?: Record<string, string[]>;
  targetSchemasByModel?: Record<string, string[]>;
}): ModelMigratorReadinessPair[] {
  const sourceById = new Map(input.sourceModels.map((model) => [model.id, model]));
  const targetById = new Map(input.targetModels.map((model) => [model.id, model]));
  return input.sourceModelIds.map((sourceModelId) => {
    const source = sourceById.get(sourceModelId);
    const targetModelId = input.targetModelBySourceId[sourceModelId];
    const target = targetModelId ? targetById.get(targetModelId) : undefined;
    const sourceSchemas = input.sourceSchemasByModel?.[sourceModelId] || [];
    const targetSchemas = targetModelId ? input.targetSchemasByModel?.[targetModelId] || [] : [];
    const targetSchemaSet = new Set(targetSchemas.map((schema) => schema.toLowerCase()));
    const overlappingSchemas = sourceSchemas.filter((schema) => targetSchemaSet.has(schema.toLowerCase()));
    const checks: ModelMigratorReadinessCheck[] = [];
    if (!source) {
      checks.push(check('source-model', 'Source model', 'blocked', 'The selected source model was not returned by Omni.'));
    } else {
      checks.push(check('source-model', 'Source model', 'ready', `${source.name || source.id} is available for migration planning.`));
    }
    if (!targetModelId) {
      checks.push(check('target-model', 'Target model', 'warning', 'Choose a target model to get a publish recommendation.'));
    } else if (!target) {
      checks.push(check('target-model', 'Target model', 'blocked', 'The selected target model was not returned by Omni.'));
    } else {
      checks.push(check('target-model', 'Target model', 'ready', `${target.name || target.id} is available as the destination.`));
    }
    if (target?.pullRequestRequired || target?.gitProtected) {
      checks.push(check('release-mode', 'Release mode', 'warning', 'Target model appears PR/protected. OmniKit should stage changes and hand off review instead of direct merge.'));
    } else if (target) {
      checks.push(check('release-mode', 'Release mode', 'ready', 'Target model appears eligible for direct publish after validation.'));
    }
    if (source?.gitConfigured) {
      checks.push(check('native-migrate', 'Native model migration', 'warning', 'Automatic copy may be available, but OmniKit needs explicit confirmation that the saved credential is an Organization API key.'));
    } else if (source) {
      checks.push(check('native-migrate', 'Native model migration', 'blocked', 'Source model is not confirmed git-backed; review/adapt YAML is the safer default.'));
    }
    if (sourceSchemas.length || targetSchemas.length) {
      checks.push(overlappingSchemas.length > 0
        ? check('schema-overlap', 'Schema overlap', 'ready', `${overlappingSchemas.length} overlapping schema${overlappingSchemas.length === 1 ? '' : 's'} detected.`)
        : check('schema-overlap', 'Schema overlap', 'warning', 'No overlapping schema names were detected. Review data-location mappings before publishing.'));
    }
    const releaseMode = target?.pullRequestRequired || target?.gitProtected ? 'pr' : target ? 'direct' : 'validate_only';
    const autoMigrationCapability = source?.gitConfigured && target && releaseMode === 'direct' ? 'requires_confirmation' : source ? 'blocked' : 'unknown';
    const recommendedPath = target ? 'translate' : 'impact_report';
    return {
      sourceModelId,
      ...(targetModelId ? { targetModelId } : {}),
      status: worstStatus(checks),
      recommendedPath,
      releaseMode,
      autoMigrationCapability,
      schemaOverlap: {
        sourceSchemas,
        targetSchemas,
        overlappingSchemas,
      },
      checks,
    };
  });
}

function parseAcceptedFiles(value: unknown): ModelMigrationAcceptedFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      fileName: cleanString(item.fileName) || '',
      yaml: typeof item.yaml === 'string' ? item.yaml : '',
      previousChecksum: cleanString(item.previousChecksum),
      reviewToken: cleanString(item.reviewToken),
    }))
    .filter((file) => file.fileName && file.yaml);
}

function parseSemanticDecisions(value: unknown): ModelMigrationSemanticDecision[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const action = cleanString(item.action);
      const kind = cleanString(item.kind);
      return {
        id: cleanString(item.id) || `${kind || 'semantic'}:${cleanString(item.sourceName) || randomUUID()}`,
        kind: kind === 'field' || kind === 'topic' || kind === 'relationship' || kind === 'file' ? kind : 'view',
        sourceName: cleanString(item.sourceName) || '',
        targetName: cleanString(item.targetName),
        sourceFileName: cleanString(item.sourceFileName),
        targetFileName: cleanString(item.targetFileName),
        action: action === 'map_existing' || action === 'create_from_source' || action === 'keep_target' || action === 'ignore' || action === 'custom_edit'
          ? action
          : 'ignore',
        required: item.required === true,
        acceptedYaml: typeof item.acceptedYaml === 'string' ? item.acceptedYaml : undefined,
      } satisfies ModelMigrationSemanticDecision;
    })
    .filter((item) => item.sourceName);
}

function parseContentRepairActions(value: unknown): ModelMigrationContentRepairAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const kind = cleanString(item.kind);
      return {
        id: cleanString(item.id) || `${kind || 'repair'}:${cleanString(item.find) || ''}`,
        kind: kind === 'view' || kind === 'topic' ? kind : 'field',
        find: cleanString(item.find) || '',
        replacement: cleanString(item.replacement) || '',
        approved: item.approved === true,
        includePersonalFolders: item.includePersonalFolders === true,
      } satisfies ModelMigrationContentRepairAction;
    })
    .filter((item) => item.find && item.replacement);
}

function parseModelInputs(value: unknown): ModelMigrationModelInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      sourceModelId: cleanString(item.sourceModelId) || '',
      sourceModelName: cleanString(item.sourceModelName),
      targetModelId: cleanString(item.targetModelId) || '',
      targetModelName: cleanString(item.targetModelName),
      targetConnectionId: cleanString(item.targetConnectionId) || '',
      mode: item.mode === 'fast' ? 'fast' as const : item.mode === 'impact_report' ? 'impact_report' as const : 'translate' as const,
      branchName: cleanString(item.branchName) || '',
      gitRef: cleanString(item.gitRef),
      fastPathSchemaConfirmed: item.fastPathSchemaConfirmed === true,
      orgApiKeyConfirmed: item.orgApiKeyConfirmed === true,
      mergeHandoffRequired: item.mergeHandoffRequired === true,
      acceptedFiles: parseAcceptedFiles(item.acceptedFiles),
      semanticDecisions: parseSemanticDecisions(item.semanticDecisions),
      contentRepairActions: parseContentRepairActions(item.contentRepairActions),
    }))
    .filter((item) => item.sourceModelId && item.targetModelId && item.targetConnectionId && item.branchName);
}

function parsePostMigrationActions(value: unknown): PostMigrationAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const method = cleanString(item.method);
      return {
        kind: item.kind === 'refresh-schema' ? 'refresh-schema' as const : 'webhook' as const,
        name: cleanString(item.name) || 'Post-migration action',
        method: method && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method as PostMigrationAction['method'] : 'POST',
        url: cleanString(item.url) || '',
        headers: item.headers && typeof item.headers === 'object' && !Array.isArray(item.headers)
          ? Object.fromEntries(Object.entries(item.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
          : {},
        body: typeof item.body === 'string' ? item.body : '',
        destinationInstanceId: cleanString(item.destinationInstanceId),
        targetModelId: cleanString(item.targetModelId),
        targetModelName: cleanString(item.targetModelName),
      };
    })
    .filter((action) => action.kind === 'refresh-schema' ? Boolean(action.destinationInstanceId && action.targetModelId) : Boolean(action.url));
}

function parseContentInputs(value: unknown): ModelMigrationContentInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      documentId: cleanString(item.documentId) || '',
      documentName: cleanString(item.documentName) || 'Migrated document',
      kind: item.kind === 'dashboard' ? 'dashboard' as const : 'workbook' as const,
      sourceModelId: cleanString(item.sourceModelId) || '',
      targetModelId: cleanString(item.targetModelId) || '',
      targetModelName: cleanString(item.targetModelName),
      targetFolderId: cleanString(item.targetFolderId),
      targetFolderPath: cleanString(item.targetFolderPath),
    }))
    .filter((item) => item.documentId && item.sourceModelId && item.targetModelId);
}

export function classifyModelMigratorDocument(document: Pick<OmniDocumentRecord, 'hasDashboard' | 'type'>): ModelMigratorDocumentKind {
  const type = (document.type || '').toLowerCase();
  if (document.hasDashboard === true) return 'dashboard';
  if (document.hasDashboard === false) return 'workbook';
  if (type.includes('dashboard')) return 'dashboard';
  if (type.includes('workbook') || type.includes('analysis')) return 'workbook';
  return 'unknown';
}

export function buildModelMigratorInventory(
  documents: OmniDocumentRecord[],
  modelIds: string[],
): ModelMigratorInventoryRow[] {
  const selected = new Set(modelIds);
  const grouped = new Map<string, ModelMigratorInventoryDocument[]>();

  for (const document of documents) {
    if (!document.baseModelId || !selected.has(document.baseModelId)) continue;
    const kind = classifyModelMigratorDocument(document);
    const row: ModelMigratorInventoryDocument = {
      id: document.id,
      identifier: document.identifier,
      name: document.name,
      baseModelId: document.baseModelId,
      kind,
      ...(document.folderId ? { folderId: document.folderId } : {}),
      ...(document.folderPath ? { folderPath: document.folderPath } : {}),
      ...(document.type ? { type: document.type } : {}),
      ...(document.description ? { description: document.description } : {}),
      ...(document.labels?.length ? { labels: document.labels } : {}),
      ...(document.updatedAt ? { updatedAt: document.updatedAt } : {}),
    };
    grouped.set(document.baseModelId, [...(grouped.get(document.baseModelId) || []), row]);
  }

  return modelIds.map((modelId) => {
    const rows = grouped.get(modelId) || [];
    return {
      modelId,
      dashboardCount: rows.filter((row) => row.kind === 'dashboard').length,
      workbookCount: rows.filter((row) => row.kind === 'workbook').length,
      unknownCount: rows.filter((row) => row.kind === 'unknown').length,
      documents: rows.sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

export default async function handler(req: Request, dependencies: { createJob?: typeof createModelMigrationJob } = {}): Promise<Response> {
  try {
    const locked = requireUnlocked();
    if (locked) return locked;

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/model-migrator\/?/, '');
    const parts = path.split('/').filter(Boolean);

    if (req.method === 'POST' && parts[0] === 'readiness') {
      const body = await bodyJson(req);
      const sourceInstanceId = cleanString(body.sourceInstanceId);
      const targetInstanceId = cleanString(body.targetInstanceId);
      if (!sourceInstanceId) return json({ error: 'sourceInstanceId is required.' }, 400);
      const sourceModelIds = parseStringArray(body.sourceModelIds);
      const targetModelBySourceId = parseStringMap(body.targetModelBySourceId);
      const sourceSecret = getInstance(sourceInstanceId);
      const targetSecret = targetInstanceId ? getInstance(targetInstanceId) : undefined;
      if (!sourceSecret) return json({ error: 'Source instance not found.' }, 404);
      if (targetInstanceId && !targetSecret) return json({ error: 'Target instance not found.' }, 404);
      if (!canUseModelMigratorInstance(sourceSecret, 'source')) return modelMigratorRoleError('source');
      if (targetSecret && !canUseModelMigratorInstance(targetSecret, 'destination')) return modelMigratorRoleError('destination');
      const forceRefresh = body.forceRefresh === true;

      try {
        return await runModelMigratorInteractiveOperation(async (signal) => {
          const catalogs = await loadModelMigratorInstanceCatalogs(
            targetSecret ? [sourceSecret, targetSecret] : [sourceSecret],
            { signal, forceRefresh },
          );
          const sourceCatalog = catalogs.get(sourceSecret.id);
          const targetCatalog = targetSecret ? catalogs.get(targetSecret.id) : undefined;
          if (!sourceCatalog || (targetSecret && !targetCatalog)) {
            throw new ModelMigratorRequestError(
              'MODEL_MIGRATOR_CATALOG_INCOMPLETE',
              502,
              'OmniKit could not assemble a complete Model Migrator readiness catalog.',
              true,
            );
          }

          const source = inspectReadinessInstance(sourceSecret, sourceCatalog);
          const target = targetSecret && targetCatalog
            ? inspectReadinessInstance(targetSecret, targetCatalog)
            : undefined;
          const sourceCatalogModelIds = new Set(source.models.map((model) => model.id));
          const targetCatalogModelIds = new Set((target?.models || []).map((model) => model.id));
          const sourceSchemaModelIds = [...new Set(sourceModelIds)]
            .filter((modelId) => sourceCatalogModelIds.has(modelId))
            .slice(0, 10);
          const targetSchemaModelIds = [...new Set(Object.values(targetModelBySourceId))]
            .filter((modelId) => targetCatalogModelIds.has(modelId))
            .slice(0, 10);
          const schemaResults = await loadModelMigratorSchemaLists([
            ...sourceSchemaModelIds.map((modelId) => ({ instance: sourceSecret, modelId })),
            ...(targetSecret
              ? targetSchemaModelIds.map((modelId) => ({ instance: targetSecret, modelId }))
              : []),
          ], { signal, forceRefresh });
          const schemaLookup = new Map(schemaResults.map((result) => [
            `${result.instanceId}:${result.modelId}`,
            result.schemas,
          ]));
          const sourceSchemasByModel = Object.fromEntries(sourceSchemaModelIds.map((modelId) => [
            modelId,
            schemaLookup.get(`${sourceSecret.id}:${modelId}`) || [],
          ]));
          const targetSchemasByModel = targetSecret
            ? Object.fromEntries(targetSchemaModelIds.map((modelId) => [
              modelId,
              schemaLookup.get(`${targetSecret.id}:${modelId}`) || [],
            ]))
            : {};
          const pairs = buildReadinessPairs({
            sourceModelIds,
            targetModelBySourceId,
            sourceModels: source.models,
            targetModels: target?.models || [],
            sourceSchemasByModel,
            targetSchemasByModel,
          });
          const allChecks = [
            ...source.instance.checks,
            ...(target?.instance.checks || []),
            ...pairs.flatMap((pair) => pair.checks),
          ];
          const blockers = allChecks.filter((row) => row.status === 'blocked').length;
          const warnings = allChecks.filter((row) => row.status === 'warning').length;
          const status = blockers > 0 ? 'blocked' : warnings > 0 ? 'warning' : 'ready';
          return json({
            readiness: {
              source: source.instance,
              ...(target ? { target: target.instance } : {}),
              pairs,
              summary: {
                status,
                label: status === 'ready'
                  ? 'Ready for guided migration planning'
                  : status === 'warning'
                    ? 'Ready with review items'
                    : 'Blocked until readiness issues are fixed',
                blockers,
                warnings,
              },
            },
          });
        }, { signal: req.signal });
      } catch (error) {
        return modelMigratorRequestErrorResponse(error, req.signal);
      }
    }

    if (req.method === 'POST' && parts[0] === 'translate') {
      const body = await bodyJson(req);
      const sourceInstanceId = cleanString(body.sourceInstanceId);
      const targetInstanceId = cleanString(body.targetInstanceId);
      const modelId = cleanString(body.modelId);
      const targetModelId = cleanString(body.targetModelId);
      if (!sourceInstanceId || !modelId) return json({ error: 'sourceInstanceId and modelId are required.' }, 400);
      const repairScope = body.dashboardRepair !== undefined ? resolveDashboardRepairScope(body.dashboardRepair) : null;
      if (repairScope) {
        assertActionableRepairScope(repairScope);
        if (sourceInstanceId !== repairScope.plan.intent.source.instanceId
          || targetInstanceId !== repairScope.destination.instanceId
          || targetModelId !== repairScope.destination.modelId
          || !repairScope.target.sourceModelIds.includes(modelId)) {
          repairConflict('The requested model translation does not match the saved dashboard dependency scope.');
        }
      }
      const secret = getInstance(sourceInstanceId);
      if (!secret) return json({ error: 'Source instance not found.' }, 404);
      if (!canUseModelMigratorInstance(secret, 'source')) return modelMigratorRoleError('source');
      let targetSecret: ReturnType<typeof getInstance>;
      if (targetInstanceId && targetModelId) {
        targetSecret = getInstance(targetInstanceId);
        if (!targetSecret) return json({ error: 'Target instance not found.' }, 404);
        if (!canUseModelMigratorInstance(targetSecret, 'destination')) return modelMigratorRoleError('destination');
      }
      const schemaMap = parseSchemaMap(typeof body.schemaMapText === 'string' ? body.schemaMapText : '');
      const sourceDialect = cleanString(body.sourceDialect) || 'source';
      const targetDialect = cleanString(body.targetDialect) || 'target';
      const client = new OmniClient(secret, { signal: req.signal });
      const repairBinding = repairScope ? await readDashboardRepairSourceBinding(repairSourceBindingInput(repairScope,
        dashboardRepairInstanceBoundaryHash(sourceInstanceId, targetInstanceId!, targetModelId!, Object.keys(repairScope.plan.sourceModelHashes))), client) : undefined;
      const yaml = await client.getModelYaml(modelId, { includeChecksums: true });
      if (repairScope) assertRepairYamlHash(yaml.files, repairScope.plan.sourceModelHashes[modelId], 'Source');
      let targetYamlFiles: Record<string, string> = {};
      let targetChecksums: Record<string, string> = {};
      if (targetSecret && targetModelId) {
        try {
          const targetYaml = await new OmniClient(targetSecret, { signal: req.signal }).getModelYaml(targetModelId, { includeChecksums: true });
          targetYamlFiles = targetYaml.files;
          targetChecksums = targetYaml.checksums || {};
        } catch {
          if (repairScope) repairConflict('The destination model could not be read. Dependency repair requires its authored YAML and checksums.');
          targetYamlFiles = {};
        }
      }
      if (repairScope) {
        assertRepairYamlHash(targetYamlFiles, repairScope.target.modelHash, 'Destination');
        if (dashboardRepairInstanceBoundaryHash(sourceInstanceId, targetInstanceId!, targetModelId!, Object.keys(repairScope.plan.sourceModelHashes)) !== repairBinding!.instanceBoundaryHash) {
          repairConflict('A saved instance changed while preparing the repair. Prepare fresh differences.');
        }
      }
      const requiredFiles = repairScope?.target.requiredFilesByModelId[modelId];
      const sourceFiles = requiredFiles ? Object.fromEntries(requiredFiles.map((fileName) => {
        if (typeof yaml.files[fileName] !== 'string') repairConflict('A required dependency file is missing from the source model. Recheck dashboard deployment.');
        if (targetYamlFiles[fileName] !== undefined && !targetChecksums[fileName]) repairConflict('A required destination file has no checksum. Recheck dashboard deployment before repairing.');
        return [fileName, yaml.files[fileName]];
      })) : yaml.files;
      const files = buildTranslatedYamlFiles({
        files: sourceFiles,
        schemaMap,
        sourceDialect,
        targetDialect,
      });
      if (repairScope) for (const file of files) {
        file.targetOriginal = targetYamlFiles[file.fileName] ?? null;
        try {
          file.deterministic = mergeDashboardRepairYaml(targetYamlFiles[file.fileName], file.deterministic || file.translated);
          file.translated = file.deterministic;
          file.additiveStatus = file.targetOriginal === null ? 'new' : file.targetOriginal === file.deterministic ? 'unchanged' : 'additive';
          if (file.additiveStatus !== 'unchanged') file.reviewToken = issueDashboardRepairApproval({
            ...repairBinding!,
            planId: repairScope.plan.id, revision: repairScope.plan.revision, targetId: repairScope.target.targetId,
            sourceModelId: modelId, sourceModelHash: repairScope.plan.sourceModelHashes[modelId], targetModelHash: repairScope.target.modelHash!,
            fileName: file.fileName, yaml: file.deterministic, previousChecksum: targetChecksums[file.fileName],
          });
        } catch (error) {
          file.blocked = true;
          file.additiveStatus = 'conflict';
          file.warnings.push(error instanceof Error ? error.message : 'This proposal changes an existing definition.');
        }
        file.changed = file.targetOriginal !== file.deterministic;
        file.reviewRequired = true;
        file.warnings.push('Additive-only repair: existing definitions cannot be changed or deleted. Review the destination diff before accepting. Conflicts cannot be overridden.');
      }
      if (body.runAi === true && !repairScope) {
        for (const file of files) {
          if (!shouldRunAiDialectPass(file.fileName, file.translated)) {
            file.warnings.push('No SQL-bearing section detected; AI dialect pass was skipped for this file.');
            continue;
          }
          const prompt = promptForYamlFile({ sourceDialect, targetDialect, fileName: file.fileName, schemaMap, yaml: file.translated });
          try {
            const result = await runAiDialectPass(client, modelId, prompt);
            if (result.yaml) {
              const aiDraft = repairScope ? mergeDashboardRepairYaml(targetYamlFiles[file.fileName], result.yaml) : result.yaml;
              if (repairScope) assertDashboardRepairYamlPreservesTarget({ sourceYaml: sourceFiles[file.fileName], targetYaml: targetYamlFiles[file.fileName], acceptedYaml: aiDraft });
              file.aiDraft = aiDraft;
              file.aiJobId = result.jobId;
              file.translated = aiDraft;
              file.changed = file.original !== aiDraft;
              file.reviewRequired = true;
              file.warnings.push(`AI dialect pass applied from Omni AI job ${result.jobId || 'unknown'}. Review before accepting.`);
            }
            if (result.refusal) {
              file.aiJobId = result.jobId;
              file.aiRefusal = redactSensitiveText(result.refusal);
              file.warnings.push(file.aiRefusal);
            }
            if (result.warning) file.warnings.push(redactSensitiveText(result.warning));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            file.aiRefusal = 'Omni AI dialect pass failed for this file; deterministic translation remains available for review.';
            file.warnings.push(`${file.aiRefusal} ${redactSensitiveText(message)}`);
          }
        }
      }
      return json({
        files,
        checksums: repairScope ? Object.fromEntries((requiredFiles || []).filter((name) => targetChecksums[name]).map((name) => [name, targetChecksums[name]])) : yaml.checksums || {},
        semanticDecisions: buildSemanticDifferenceDecisions({ sourceFiles, targetFiles: targetYamlFiles }).filter((decision) => !repairScope
          || Boolean(decision.sourceFileName && requiredFiles?.includes(decision.sourceFileName)
            && (!decision.targetFileName || requiredFiles?.includes(decision.targetFileName)))),
        prompts: files.map((file) => ({
          fileName: file.fileName,
          prompt: promptForYamlFile({ sourceDialect, targetDialect, fileName: file.fileName, schemaMap, yaml: file.translated }),
        })),
      });
    }

    if (req.method === 'POST' && parts[0] === 'preflight') {
      const body = await bodyJson(req);
      const sourceInstanceId = cleanString(body.sourceInstanceId);
      const targetInstanceId = cleanString(body.targetInstanceId);
      const sourceModelId = cleanString(body.sourceModelId);
      const targetModelId = cleanString(body.targetModelId);
      const documentIds = parseStringArray(body.documentIds);
      if (!sourceInstanceId || !targetInstanceId || !sourceModelId || !targetModelId) {
        return json({ error: 'sourceInstanceId, targetInstanceId, sourceModelId, and targetModelId are required.' }, 400);
      }
      const source = getInstance(sourceInstanceId);
      const target = getInstance(targetInstanceId);
      if (!source || !target) return json({ error: 'Source or target instance not found.' }, 404);
      if (!canUseModelMigratorInstance(source, 'source')) return modelMigratorRoleError('source');
      if (!canUseModelMigratorInstance(target, 'destination')) return modelMigratorRoleError('destination');
      return runModelMigratorReadResponse(req, async (signal) => {
        const sourceClient = createModelMigratorReadClient(source);
        const targetClient = createModelMigratorReadClient(target);
        const targetYaml = await targetClient.getModelYaml(targetModelId, {
          includeChecksums: true,
          signal,
        });
        const universe = buildFieldUniverseFromYaml(targetYaml.files);
        const workbooks = [];
        for (const documentId of documentIds) {
          const queries = await sourceClient.getDocumentQueries(documentId, signal);
          const tabs = queries.map((query) => {
            const rewritten = rewriteQueryModelReferences(query.query, sourceModelId, targetModelId);
            const preflight = preflightWorkbookQueryFields(rewritten, universe);
            return {
              id: query.id,
              name: query.name,
              fieldReferences: preflight.fieldReferences,
              blockers: preflight.blockers,
              replacementCount: preflight.replacements,
            };
          });
          workbooks.push({
            documentId,
            tabCount: tabs.length,
            blockerCount: tabs.reduce((sum, tab) => sum + tab.blockers.length, 0),
            tabs,
          });
        }
        return json({ workbooks });
      });
    }

    if (req.method === 'POST' && parts[0] === 'jobs') {
      if (parts[2] === 'merge') {
        const body = await bodyJson(req);
        const job = await mergeModelMigrationJob(parts[1], {
          publishDrafts: body.publishDrafts === true,
          deleteBranch: body.deleteBranch !== false,
        });
        return json({ job });
      }

      const body = await bodyJson(req);
      const sourceId = cleanString(body.sourceId);
      const targetId = cleanString(body.targetId);
      if (!sourceId || !targetId) return json({ error: 'sourceId and targetId are required.' }, 400);
      const models = parseModelInputs(body.models);
      if (models.length === 0) return json({ error: 'At least one model migration target is required.' }, 400);
      if (models.some((model) => model.mode === 'fast' && (model.fastPathSchemaConfirmed !== true || model.orgApiKeyConfirmed !== true))) {
        return json({ error: 'Automatic copy requires explicit data-location compatibility and Organization API key confirmation for every selected model.' }, 400);
      }
      if (models.some((model) => model.mode === 'translate' && (model.acceptedFiles?.length || 0) === 0)) {
        return json({ error: 'Review/adapt models require at least one accepted YAML file.' }, 400);
      }
      const sourceInstance = getInstance(sourceId);
      const targetInstance = getInstance(targetId);
      if (!sourceInstance || !targetInstance) return json({ error: 'Source or target instance not found.' }, 404);
      if (!canUseModelMigratorInstance(sourceInstance, 'source')) return modelMigratorRoleError('source');
      if (!canUseModelMigratorInstance(targetInstance, 'destination')) return modelMigratorRoleError('destination');
      const initialRepairScope = body.dashboardRepair !== undefined ? resolveDashboardRepairScope(body.dashboardRepair) : null;
      const repairBoundaryHash = initialRepairScope ? dashboardRepairInstanceBoundaryHash(sourceId, targetId,
        initialRepairScope.destination.modelId, Object.keys(initialRepairScope.plan.sourceModelHashes)) : undefined;
      const submit = async (linkRepair?: (jobId: string) => unknown): Promise<Response> => {
        const repairScope = body.dashboardRepair !== undefined
          ? await validateDashboardRepairModels(body.dashboardRepair, sourceId, targetId, models) : null;
        let jobModels = models;
        let repairBinding: DashboardRepairSourceBinding | undefined;
        if (repairScope) {
          assertActionableRepairScope(repairScope);
          const selectedModelIds = models.map((model) => model.sourceModelId);
          if (new Set(selectedModelIds).size !== selectedModelIds.length
            || selectedModelIds.some((id) => !repairScope.target.sourceModelIds.includes(id))
            || models.some((model) => model.mode !== 'translate' || model.contentRepairActions?.length
              || model.semanticDecisions?.some((decision) => decision.acceptedYaml || !decision.sourceFileName
                || !repairScope.target.requiredFilesByModelId[model.sourceModelId].includes(decision.sourceFileName)
                || (decision.targetFileName && !repairScope.target.requiredFilesByModelId[model.sourceModelId].includes(decision.targetFileName))))
            || (body.content !== undefined && (!Array.isArray(body.content) || body.content.length > 0))
            || (body.postMigrationActions !== undefined && (!Array.isArray(body.postMigrationActions) || body.postMigrationActions.length > 0))
            || body.mergeAfterValidation === true || body.publishDrafts === true || body.deleteBranch === true) {
            repairConflict('Dashboard dependency repair permits only reviewed scoped YAML on working branches, without content migration, automatic publish, or post-actions.');
          }
          const sourceClient = new OmniClient(sourceInstance, { signal: req.signal });
          repairBinding = await readDashboardRepairSourceBinding(repairSourceBindingInput(repairScope, repairBoundaryHash!), sourceClient);
          const targetYaml = await new OmniClient(targetInstance, { signal: req.signal }).getModelYaml(repairScope.destination.modelId, { includeChecksums: true, fullyResolved: false });
          assertRepairYamlHash(targetYaml.files, repairScope.target.modelHash, 'Destination');
          for (const sourceModelId of Object.keys(repairScope.plan.sourceModelHashes)) {
            const sourceYaml = await sourceClient.getModelYaml(sourceModelId, { includeChecksums: true, fullyResolved: false });
            assertRepairYamlHash(sourceYaml.files, repairScope.plan.sourceModelHashes[sourceModelId], 'Source');
            if (!repairScope.target.sourceModelIds.includes(sourceModelId)) continue;
            const model = models.find((candidate) => candidate.sourceModelId === sourceModelId);
            if (!model) {
              // A browser's unchanged label is not proof: independently verify every omitted dependency.
              for (const fileName of repairScope.target.requiredFilesByModelId[sourceModelId]) {
                const sourceFile = sourceYaml.files[fileName];
                const targetFile = targetYaml.files[fileName];
                if (typeof sourceFile !== 'string' || typeof targetFile !== 'string'
                  || mergeDashboardRepairYaml(targetFile, sourceFile) !== targetFile) {
                  repairConflict('An omitted source model still requires dependency changes. Review and accept its additions before staging this repair.');
                }
              }
              continue;
            }
            const names = (model.acceptedFiles || []).map((file) => file.fileName);
            if (names.length !== new Set(names).size) repairConflict('A dependency repair cannot write the same file more than once.');
            for (const file of model.acceptedFiles || []) {
              if (typeof sourceYaml.files[file.fileName] !== 'string') repairConflict('A required source dependency file is unavailable. Recheck dashboard deployment.');
              const previousChecksum = targetYaml.checksums?.[file.fileName];
              if ((targetYaml.files[file.fileName] !== undefined && !previousChecksum) || file.previousChecksum !== previousChecksum) {
                repairConflict('Accepted dependency YAML does not carry the reviewed destination checksum. Prepare differences again.');
              }
              assertDashboardRepairYamlPreservesTarget({
                sourceYaml: sourceYaml.files[file.fileName], targetYaml: targetYaml.files[file.fileName], acceptedYaml: file.yaml,
              });
              verifyDashboardRepairApproval(file.reviewToken, { ...repairBinding, planId: repairScope.plan.id, revision: repairScope.plan.revision,
                targetId: repairScope.target.targetId, sourceModelId: model.sourceModelId,
                sourceModelHash: repairScope.plan.sourceModelHashes[model.sourceModelId], targetModelHash: repairScope.target.modelHash!,
                fileName: file.fileName, yaml: file.yaml, previousChecksum: file.previousChecksum });
            }
          }
          // All reviewed additions target one shared model, so stage their union on one branch.
          // Per-source approval checks above remain separate; hashes retain every source, including no-ops.
          const acceptedFiles = new Map<string, ModelMigrationAcceptedFile>();
          for (const model of models) for (const file of model.acceptedFiles || []) {
            const existing = acceptedFiles.get(file.fileName);
            if (existing && (existing.yaml !== file.yaml || existing.previousChecksum !== file.previousChecksum)) {
              repairConflict('Source models propose conflicting changes to the same destination file. Review that dependency explicitly.');
            }
            if (file.yaml !== targetYaml.files[file.fileName]) acceptedFiles.set(file.fileName, file);
          }
          if (!acceptedFiles.size) repairConflict('All reviewed definitions already exist. Recheck readiness instead of creating a repair job.');
          jobModels = [{ ...models[0], acceptedFiles: [...acceptedFiles.values()],
            semanticDecisions: models.flatMap((model) => model.semanticDecisions || []),
            contentRepairActions: [], mergeHandoffRequired: models.some((model) => model.mergeHandoffRequired === true) }];
          // Reread the local plan after remote checks; another review may have replaced this revision.
          resolveDashboardRepairScope(body.dashboardRepair);
          if (dashboardRepairInstanceBoundaryHash(sourceId, targetId, repairScope.destination.modelId,
            Object.keys(repairScope.plan.sourceModelHashes)) !== repairBinding.instanceBoundaryHash) {
            repairConflict('A saved instance changed while verifying the repair. Prepare fresh differences.');
          }
          req.signal.throwIfAborted();
        }
        const job = await (dependencies.createJob || createModelMigrationJob)({
          sourceId,
          targetId,
          targetLabel: cleanString(body.targetLabel),
          models: jobModels,
          content: parseContentInputs(body.content),
          replaceSameNamed: repairScope ? false : body.replaceSameNamed !== false,
          mergeAfterValidation: body.mergeAfterValidation === true,
          publishDrafts: body.publishDrafts === true,
          deleteBranch: body.deleteBranch === true,
          postMigrationActions: parsePostMigrationActions(body.postMigrationActions),
          ...(repairScope ? { dashboardRepair: {
            ...repairBinding!,
            planId: repairScope.plan.id, targetId: repairScope.target.targetId, revision: repairScope.plan.revision,
            additiveOnly: true, targetModelHash: repairScope.target.modelHash,
            sourceModelHashes: repairScope.plan.sourceModelHashes,
            approvedFilesHash: dashboardSafeCopyStateHash(jobModels.flatMap((model) => (model.acceptedFiles || []).map(({ fileName, yaml, previousChecksum }) => ({ fileName, yaml, previousChecksum })))),
          } } : {}),
        });
        if (repairScope && linkRepair) {
          try {
            linkRepair(job.id);
          } catch {
            return json({ job, warning: 'The repair job was created, but its plan link could not be saved. Keep this job identity and recheck the deployment plan before starting another repair.' });
          }
        }
        return json({ job });
      };
      return await (body.dashboardRepair !== undefined ? withDashboardRepairSubmission(body.dashboardRepair, submit) : submit());
    }

    const instanceId = parts[0];
    const action = parts[1];
    if (!instanceId) return json({ error: 'Instance id required.' }, 400);

    const secret = getInstance(instanceId);
    if (!secret) return json({ error: 'Instance not found.' }, 404);
    const forceRefresh = url.searchParams.get('forceRefresh') === 'true';

    if (req.method === 'GET' && action === 'connections') {
      return runModelMigratorReadResponse(req, async (signal) => {
        const connections = (await loadModelMigratorConnections(secret, { signal, forceRefresh }))
          .filter((connection) => !connection.deletedAt);
        return json({ connections });
      });
    }

    if (req.method === 'GET' && action === 'models') {
      const connectionId = cleanString(url.searchParams.get('connectionId'));
      const modelKind = cleanString(url.searchParams.get('modelKind')) || 'SHARED';
      return runModelMigratorReadResponse(req, async (signal) => {
        const models = (modelKind === 'SHARED'
          ? await loadModelMigratorSharedModels(secret, undefined, { signal, forceRefresh })
          : modelKind === 'SCHEMA'
            ? await loadModelMigratorSchemaModels(secret, { signal, forceRefresh })
            : await createModelMigratorReadClient(secret).listModels({ modelKind, connectionId }, signal))
          .filter(isActiveModel)
          .filter((model) => !connectionId || model.connectionId === connectionId);
        return json({ models });
      });
    }

    if (req.method === 'GET' && action === 'inventory') {
      if (!canUseModelMigratorInstance(secret, 'source')) return modelMigratorRoleError('source');
      const modelIds = parseCsv(url.searchParams.get('modelIds'));
      if (modelIds.length === 0) return json({ models: [] });
      return runModelMigratorReadResponse(req, async (signal) => {
        const documents = await loadModelMigratorDocumentInventory(secret, {
          signal,
          forceRefresh,
        });
        return json({ models: buildModelMigratorInventory(documents, modelIds) });
      });
    }

    return json({ error: `Unknown model migrator route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: redactSensitiveText(error instanceof Error ? error.message : 'Model migrator request failed.') }, statusCode);
  }
}
