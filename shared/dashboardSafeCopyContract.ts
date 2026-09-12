export const DASHBOARD_SAFE_COPY_PROFILE = 'safe_copy_v1' as const;
export const DASHBOARD_SAFE_COPY_RESOLVER_VERSION = 'safe-copy-resolver-v1' as const;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DOCUMENTS = 500;
const MAX_DESTINATIONS = 100;
export const DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS = 1_000;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_FOLDER_PATH_LENGTH = 1_024;

export interface DashboardSafeCopySource {
  instanceId: string;
  connectionId: string;
  documentIds: string[];
}

export interface DashboardSafeCopyTopicMapping {
  sourceTopicName: string;
  action: 'map_existing' | 'copy_source';
  targetTopicName: string;
}

export interface DashboardSafeCopyQueryViewMapping {
  sourceQueryViewName: string;
  action: 'map_existing' | 'copy_source';
  targetQueryViewName: string;
}

export interface DashboardSafeCopyOptions {
  emptyFirst?: boolean;
  deleteSourceOnSuccess?: boolean;
  refreshSchemaOnComplete?: boolean;
}

export interface DashboardSafeCopyWorkbookCopy {
  stagingFolderId: string;
}

/** Hashes of authored extension YAML only; never resolved or shared model definitions. */
export interface DashboardSafeCopyWorkbookEvidence {
  sourceWorkbookModelId: string;
  sourceSharedModelId: string;
  authoredFileHashes: Record<string, string>;
  authoredModelHash: string;
}

/** Immutable read-only preflight evidence approved for deployment. */
export interface DashboardSafeCopyDeployment {
  version: 2;
  planId: string;
  sourceHashes: Record<string, string>;
  modelHashes: Record<string, string>;
  sourceModelHashes?: Record<string, string>;
  workbookCopies?: Record<string, DashboardSafeCopyWorkbookEvidence>;
}

export interface DashboardSafeCopyDestination {
  targetId: string;
  instanceId: string;
  connectionId: string;
  modelId: string;
  folderId?: string;
  folderPath?: string;
  topicMappings?: DashboardSafeCopyTopicMapping[];
  queryViewMappings?: DashboardSafeCopyQueryViewMapping[];
  workbookCopy?: DashboardSafeCopyWorkbookCopy;
}

export interface DashboardSafeCopyIntent {
  profile: typeof DASHBOARD_SAFE_COPY_PROFILE;
  requestId: string;
  source: DashboardSafeCopySource;
  destinations: DashboardSafeCopyDestination[];
  options?: DashboardSafeCopyOptions;
  deployment?: DashboardSafeCopyDeployment;
}

export type DashboardSafeCopyErrorCode =
  | 'SAFE_COPY_INVALID_BODY'
  | 'SAFE_COPY_UNKNOWN_FIELD'
  | 'SAFE_COPY_INVALID_PROFILE'
  | 'SAFE_COPY_INVALID_REQUEST_ID'
  | 'SAFE_COPY_INVALID_SOURCE'
  | 'SAFE_COPY_INVALID_DESTINATION'
  | 'SAFE_COPY_INVALID_DEPLOYMENT'
  | 'SAFE_COPY_UNSUPPORTED_OPTIONS'
  | 'SAFE_COPY_DUPLICATE_TARGET'
  | 'SAFE_COPY_LIMIT_EXCEEDED'
  | 'SAFE_COPY_IDEMPOTENCY_CONFLICT'
  | 'SAFE_COPY_SCOPE_CONFLICT'
  | 'SAFE_COPY_INSTANCE_NOT_FOUND';

export class DashboardSafeCopyError extends Error {
  readonly code: DashboardSafeCopyErrorCode;
  readonly statusCode: number;

  constructor(code: DashboardSafeCopyErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'DashboardSafeCopyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new DashboardSafeCopyError(
      'SAFE_COPY_UNKNOWN_FIELD',
      `${location} contains ${unknown.length} unsupported field${unknown.length === 1 ? '' : 's'}.`,
    );
  }
}

function requiredIdentifier(
  value: unknown,
  label: string,
  code: DashboardSafeCopyErrorCode,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DashboardSafeCopyError(code, `${label} is required.`);
  }
  const normalized = value.trim();
  if (hasAsciiControl(normalized)) {
    throw new DashboardSafeCopyError(code, `${label} contains unsupported control characters.`);
  }
  if (normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new DashboardSafeCopyError('SAFE_COPY_LIMIT_EXCEEDED', `${label} exceeds the bounded identifier length.`);
  }
  return normalized;
}

function optionalIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredIdentifier(value, label, 'SAFE_COPY_INVALID_DESTINATION');
}

function optionalFolderPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', 'Destination folderPath must be a non-empty string when provided.');
  }
  const normalized = value.trim();
  if (hasAsciiControl(normalized)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', 'Destination folderPath contains unsupported control characters.');
  }
  if (normalized.length > MAX_FOLDER_PATH_LENGTH) {
    throw new DashboardSafeCopyError('SAFE_COPY_LIMIT_EXCEEDED', 'Destination folderPath exceeds the bounded length.');
  }
  return normalized;
}

function parseSource(value: unknown): DashboardSafeCopySource {
  if (!isRecord(value)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_SOURCE', 'source must be an object.');
  }
  assertOnlyKeys(value, ['instanceId', 'connectionId', 'documentIds'], 'source');
  if (!Array.isArray(value.documentIds) || value.documentIds.length === 0) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_SOURCE', 'Select at least one source dashboard.');
  }
  if (value.documentIds.length > MAX_DOCUMENTS) {
    throw new DashboardSafeCopyError('SAFE_COPY_LIMIT_EXCEEDED', `A safe-copy request supports at most ${MAX_DOCUMENTS} dashboards.`);
  }
  const documentIds = [...new Set(value.documentIds.map((item, index) => (
    requiredIdentifier(item, `source.documentIds[${index}]`, 'SAFE_COPY_INVALID_SOURCE')
  )))].sort(compareCanonicalStrings);
  return {
    instanceId: requiredIdentifier(value.instanceId, 'source.instanceId', 'SAFE_COPY_INVALID_SOURCE'),
    connectionId: requiredIdentifier(value.connectionId, 'source.connectionId', 'SAFE_COPY_INVALID_SOURCE'),
    documentIds,
  };
}

function parseDestination(value: unknown, index: number, contentOnly = false): DashboardSafeCopyDestination {
  if (!isRecord(value)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', `destinations[${index}] must be an object.`);
  }
  assertOnlyKeys(
    value,
    ['targetId', 'instanceId', 'connectionId', 'modelId', 'folderId', 'folderPath', 'topicMappings', 'queryViewMappings', 'workbookCopy'],
    `destinations[${index}]`,
  );
  const destination: DashboardSafeCopyDestination = {
    targetId: requiredIdentifier(value.targetId, `destinations[${index}].targetId`, 'SAFE_COPY_INVALID_DESTINATION'),
    instanceId: requiredIdentifier(value.instanceId, `destinations[${index}].instanceId`, 'SAFE_COPY_INVALID_DESTINATION'),
    connectionId: requiredIdentifier(value.connectionId, `destinations[${index}].connectionId`, 'SAFE_COPY_INVALID_DESTINATION'),
    modelId: requiredIdentifier(value.modelId, `destinations[${index}].modelId`, 'SAFE_COPY_INVALID_DESTINATION'),
  };
  const folderId = optionalIdentifier(value.folderId, `destinations[${index}].folderId`);
  const folderPath = optionalFolderPath(value.folderPath);
  if (folderId) destination.folderId = folderId;
  if (folderPath) destination.folderPath = folderPath;
  if (value.workbookCopy !== undefined) {
    if (!contentOnly || !isRecord(value.workbookCopy)) {
      throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', 'Workbook-local copy requires a reviewed deployment plan and an explicit staging folder.');
    }
    assertOnlyKeys(value.workbookCopy, ['stagingFolderId'], 'workbookCopy');
    const stagingFolderId = requiredIdentifier(value.workbookCopy.stagingFolderId, 'workbookCopy.stagingFolderId', 'SAFE_COPY_INVALID_DESTINATION');
    if (stagingFolderId === folderId) {
      throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', 'The staging folder must differ from the final delivery folder.');
    }
    destination.workbookCopy = { stagingFolderId };
  }
  if (contentOnly) {
    for (const [key, sourceKey, targetKey] of [
      ['topicMappings', 'sourceTopicName', 'targetTopicName'],
      ['queryViewMappings', 'sourceQueryViewName', 'targetQueryViewName'],
    ]) {
      const mappings = value[key];
      if (mappings === undefined) continue;
      if (!Array.isArray(mappings) || mappings.length > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS) {
        throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', `${key} must be a bounded mapping list.`);
      }
      const sources = new Set<string>();
      for (const mapping of mappings) {
        if (!isRecord(mapping)) throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', `${key} entries must be objects.`);
        assertOnlyKeys(mapping, [sourceKey, targetKey, 'action'], key);
        const sourceName = requiredIdentifier(mapping[sourceKey], sourceKey, 'SAFE_COPY_INVALID_DESTINATION');
        requiredIdentifier(mapping[targetKey], targetKey, 'SAFE_COPY_INVALID_DESTINATION');
        if (!['map_existing', 'copy_source'].includes(String(mapping.action)) || sources.has(sourceName)) {
          throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', `${key} contains an unsupported or duplicate mapping.`);
        }
        sources.add(sourceName);
      }
    }
  }
  if (Array.isArray(value.topicMappings) && value.topicMappings.length > 0) {
    destination.topicMappings = value.topicMappings.map((item: unknown) => {
      if (!isRecord(item)) throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', 'topicMappings entries must be objects.');
      return {
        sourceTopicName: String(item.sourceTopicName || ''),
        action: item.action === 'map_existing' ? 'map_existing' as const : 'copy_source' as const,
        targetTopicName: String(item.targetTopicName || item.sourceTopicName || ''),
      };
    });
  }
  if (Array.isArray(value.queryViewMappings) && value.queryViewMappings.length > 0) {
    destination.queryViewMappings = value.queryViewMappings.map((item: unknown) => {
      if (!isRecord(item)) throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', 'queryViewMappings entries must be objects.');
      return {
        sourceQueryViewName: String(item.sourceQueryViewName || ''),
        action: item.action === 'map_existing' ? 'map_existing' as const : 'copy_source' as const,
        targetQueryViewName: String(item.targetQueryViewName || item.sourceQueryViewName || ''),
      };
    });
  }
  return destination;
}

function destinationCanonicalKey(destination: DashboardSafeCopyDestination): string {
  return JSON.stringify({
    targetId: destination.targetId,
    instanceId: destination.instanceId,
    connectionId: destination.connectionId,
    modelId: destination.modelId,
    folderId: destination.folderId || '',
    folderPath: destination.folderPath || '',
    ...(destination.topicMappings ? { topicMappings: destination.topicMappings } : {}),
    ...(destination.queryViewMappings ? { queryViewMappings: destination.queryViewMappings } : {}),
    ...(destination.workbookCopy ? { workbookCopy: destination.workbookCopy } : {}),
  });
}

function parseDestinations(value: unknown, contentOnly = false): DashboardSafeCopyDestination[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DESTINATION', 'Select at least one destination.');
  }
  if (value.length > MAX_DESTINATIONS) {
    throw new DashboardSafeCopyError('SAFE_COPY_LIMIT_EXCEEDED', `A safe-copy request supports at most ${MAX_DESTINATIONS} destinations.`);
  }
  const byTargetId = new Map<string, DashboardSafeCopyDestination>();
  for (const [index, item] of value.entries()) {
    const destination = parseDestination(item, index, contentOnly);
    const existing = byTargetId.get(destination.targetId);
    if (!existing) {
      byTargetId.set(destination.targetId, destination);
      continue;
    }
    if (destinationCanonicalKey(existing) !== destinationCanonicalKey(destination)) {
      throw new DashboardSafeCopyError(
        'SAFE_COPY_DUPLICATE_TARGET',
        'A destination targetId was supplied with conflicting values.',
      );
    }
  }
  const destinations = [...byTargetId.values()];
  const destinationModelScopes = new Set<string>();
  for (const destination of destinations) {
    const scope = JSON.stringify({
      instanceId: destination.instanceId,
      modelId: destination.modelId,
      ...(contentOnly ? {
        folder: destination.folderId || destination.folderPath?.normalize('NFKC').trim().toLocaleLowerCase('en-US') || '',
      } : {}),
    });
    if (destinationModelScopes.has(scope)) {
      throw new DashboardSafeCopyError(
        'SAFE_COPY_DUPLICATE_TARGET',
        contentOnly
          ? 'Select distinct folders for repeated destination models.'
          : 'A safe-copy request supports only one destination target per destination model.',
      );
    }
    destinationModelScopes.add(scope);
  }
  return destinations.sort((left, right) => (
    compareCanonicalStrings(left.targetId, right.targetId)
      || compareCanonicalStrings(left.instanceId, right.instanceId)
      || compareCanonicalStrings(left.connectionId, right.connectionId)
      || compareCanonicalStrings(left.modelId, right.modelId)
  ));
}

export function parseDashboardSafeCopyDeploymentEvidence(
  value: unknown,
  source: Pick<DashboardSafeCopySource, 'documentIds'>,
  destinations: Array<Pick<DashboardSafeCopyDestination, 'targetId' | 'workbookCopy'>>,
): DashboardSafeCopyDeployment {
  if (!isRecord(value) || value.version !== 2) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DEPLOYMENT', 'Deployment must contain version 2 preflight evidence.');
  }
  assertOnlyKeys(value, ['version', 'planId', 'sourceHashes', 'modelHashes', 'sourceModelHashes', 'workbookCopies'], 'deployment');
  const hashes = (input: unknown, expectedIds: string[], label: string): Record<string, string> => {
    if (!isRecord(input) || Object.keys(input).length !== expectedIds.length) {
      throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DEPLOYMENT', `${label} must cover the exact approved scope.`);
    }
    return Object.fromEntries([...expectedIds].sort(compareCanonicalStrings).map((id) => {
      const hash = Object.prototype.hasOwnProperty.call(input, id) ? input[id] : undefined;
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
        throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DEPLOYMENT', `${label} contains missing or invalid snapshot evidence.`);
      }
      return [id, hash];
    }));
  };
  let sourceModelHashes: Record<string, string> | undefined;
  if (value.sourceModelHashes !== undefined) {
    if (!isRecord(value.sourceModelHashes) || !Object.keys(value.sourceModelHashes).length || Object.keys(value.sourceModelHashes).length > MAX_DOCUMENTS) {
      throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DEPLOYMENT', 'sourceModelHashes must contain bounded source model evidence.');
    }
    const ids = Object.keys(value.sourceModelHashes);
    for (const id of ids) {
      if (requiredIdentifier(id, 'sourceModelHashes model ID', 'SAFE_COPY_INVALID_DEPLOYMENT') !== id) {
        throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DEPLOYMENT', 'Source model evidence must use canonical model identifiers.');
      }
    }
    sourceModelHashes = hashes(value.sourceModelHashes, ids, 'sourceModelHashes');
  }
  let workbookCopies: Record<string, DashboardSafeCopyWorkbookEvidence> | undefined;
  if (value.workbookCopies !== undefined) {
    if (!isRecord(value.workbookCopies) || Object.keys(value.workbookCopies).length > source.documentIds.length) {
      throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DEPLOYMENT', 'workbookCopies must contain bounded selected-document evidence.');
    }
    workbookCopies = Object.fromEntries(Object.entries(value.workbookCopies).sort(([a], [b]) => compareCanonicalStrings(a, b)).map(([documentId, evidence]) => {
      if (!source.documentIds.includes(documentId) || !isRecord(evidence)) {
        throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DEPLOYMENT', 'Workbook evidence is outside the selected source scope.');
      }
      assertOnlyKeys(evidence, ['sourceWorkbookModelId', 'sourceSharedModelId', 'authoredFileHashes', 'authoredModelHash'], 'workbookCopies evidence');
      const sourceWorkbookModelId = requiredIdentifier(evidence.sourceWorkbookModelId, 'sourceWorkbookModelId', 'SAFE_COPY_INVALID_DEPLOYMENT');
      const sourceSharedModelId = requiredIdentifier(evidence.sourceSharedModelId, 'sourceSharedModelId', 'SAFE_COPY_INVALID_DEPLOYMENT');
      if (sourceWorkbookModelId === sourceSharedModelId || !isRecord(evidence.authoredFileHashes)) {
        throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DEPLOYMENT', 'Workbook evidence must identify a separate workbook model and authored file hashes.');
      }
      const fileNames = Object.keys(evidence.authoredFileHashes);
      if (fileNames.length > 2_000 || fileNames.some((fileName) => (
        !fileName || fileName.length > MAX_FOLDER_PATH_LENGTH || hasAsciiControl(fileName)
        || fileName !== fileName.trim() || fileName.includes('\\') || fileName.startsWith('/')
        || fileName.split('/').some((part) => ['', '.', '..'].includes(part))
      ))) {
        throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DEPLOYMENT', 'Workbook evidence contains an unsafe or unbounded authored file path.');
      }
      return [documentId, {
        sourceWorkbookModelId,
        sourceSharedModelId,
        authoredFileHashes: hashes(evidence.authoredFileHashes, fileNames, 'authoredFileHashes'),
        authoredModelHash: hashes({ model: evidence.authoredModelHash }, ['model'], 'authoredModelHash').model,
      }];
    }));
  }
  if (destinations.some((destination) => destination.workbookCopy) && !Object.keys(workbookCopies || {}).length) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DEPLOYMENT', 'Workbook-local copy requires immutable authored workbook evidence.');
  }
  return {
    version: 2,
    planId: requiredIdentifier(value.planId, 'deployment.planId', 'SAFE_COPY_INVALID_DEPLOYMENT'),
    sourceHashes: hashes(value.sourceHashes, source.documentIds, 'sourceHashes'),
    modelHashes: hashes(value.modelHashes, destinations.map((destination) => destination.targetId), 'modelHashes'),
    ...(sourceModelHashes ? { sourceModelHashes } : {}),
    ...(workbookCopies ? { workbookCopies } : {}),
  };
}

function parseIntent(value: unknown, contentOnlyPreflight = false): DashboardSafeCopyIntent {
  if (!isRecord(value)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_BODY', 'Safe-copy request body must be a JSON object.');
  }
  assertOnlyKeys(value, ['profile', 'requestId', 'source', 'destinations', 'options', 'deployment'], 'request');
  if (value.profile !== DASHBOARD_SAFE_COPY_PROFILE) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_PROFILE', `profile must be ${DASHBOARD_SAFE_COPY_PROFILE}.`);
  }
  const requestId = requiredIdentifier(value.requestId, 'requestId', 'SAFE_COPY_INVALID_REQUEST_ID').toLowerCase();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_REQUEST_ID', 'requestId must be a canonical UUID.');
  }
  const source = parseSource(value.source);
  const destinations = parseDestinations(value.destinations, contentOnlyPreflight || value.deployment !== undefined);
  const deployment = value.deployment === undefined ? undefined : parseDashboardSafeCopyDeploymentEvidence(value.deployment, source, destinations);
  if ((deployment || contentOnlyPreflight) && value.options !== undefined) {
    if (!isRecord(value.options) || Object.entries(value.options).some(([key, option]) => (
      !['emptyFirst', 'deleteSourceOnSuccess', 'refreshSchemaOnComplete'].includes(key) || option !== false
    ))) {
      throw new DashboardSafeCopyError('SAFE_COPY_UNSUPPORTED_OPTIONS', 'Content-only deployment does not support destructive or schema-refresh options.');
    }
  }
  if (source.documentIds.length * destinations.length > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS) {
    throw new DashboardSafeCopyError(
      'SAFE_COPY_LIMIT_EXCEEDED',
      `A safe-copy request supports at most ${DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS} dashboard-destination copies.`,
    );
  }
  return {
    profile: DASHBOARD_SAFE_COPY_PROFILE,
    requestId,
    source,
    destinations,
    ...(deployment ? { deployment } : {}),
    ...(!deployment && !contentOnlyPreflight && isRecord(value.options) ? {
      options: {
        ...(value.options.emptyFirst === true ? { emptyFirst: true } : {}),
        ...(value.options.deleteSourceOnSuccess === true ? { deleteSourceOnSuccess: true } : {}),
        ...(value.options.refreshSchemaOnComplete === true ? { refreshSchemaOnComplete: true } : {}),
      },
    } : {}),
  };
}

export function parseDashboardSafeCopyIntent(value: unknown): DashboardSafeCopyIntent {
  return parseIntent(value);
}

/** Read-only plan input supports v2 routes before server-owned snapshot evidence exists. */
export function parseDashboardDeploymentPlanIntent(value: unknown): DashboardSafeCopyIntent {
  if (isRecord(value) && value.deployment !== undefined) {
    throw new DashboardSafeCopyError('SAFE_COPY_INVALID_DEPLOYMENT', 'Deployment evidence is generated by the server after preflight.');
  }
  return parseIntent(value, true);
}

export function canonicalDashboardSafeCopyIntent(intent: DashboardSafeCopyIntent): DashboardSafeCopyIntent {
  return parseDashboardSafeCopyIntent(intent);
}

/** Narrow a preflight/deployment without retaining evidence for unrelated destinations. */
export function scopeDashboardSafeCopyIntent(
  intent: DashboardSafeCopyIntent,
  targetIds: ReadonlySet<string>,
): DashboardSafeCopyIntent {
  const destinations = intent.destinations.filter((destination) => targetIds.has(destination.targetId));
  return {
    ...intent,
    destinations,
    ...(intent.deployment ? { deployment: {
      ...intent.deployment,
      modelHashes: Object.fromEntries(destinations.map((destination) => [
        destination.targetId, intent.deployment!.modelHashes[destination.targetId],
      ])),
    } } : {}),
  };
}

export function dashboardSafeCopyCanonicalJson(intent: DashboardSafeCopyIntent): string {
  const canonical = canonicalDashboardSafeCopyIntent(intent);
  return JSON.stringify({
    profile: canonical.profile,
    requestId: canonical.requestId,
    source: canonical.source,
    destinations: canonical.destinations,
    ...(canonical.deployment ? { deployment: canonical.deployment } : {}),
  });
}

export function isDashboardSafeCopyError(error: unknown): error is DashboardSafeCopyError {
  return error instanceof DashboardSafeCopyError;
}
