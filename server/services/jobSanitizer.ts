import type { PostMigrationAction } from './nativeVault';
import type { MigrationJob, MigrationJobItem, MigrationRouteGroup, MigrationTarget } from './migrationJobs';

const REDACTED = '[redacted]';
const EMAIL_PATTERN = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?=[^A-Z0-9.]|$)/gi;
const TOKEN_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+\b/gi;
const OMNI_TOKEN_PATTERN = /\bomni_[A-Za-z0-9._~+/=-]{8,}\b/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|authorization|token|secret|password|passphrase)(["'\s:=]+)([^"',\s}]+)/gi;
const URL_USERINFO_PATTERN = /(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const SENSITIVE_KEY_PATTERN = /^(api[_-]?key|authorization|token|secret|password|passphrase)$/i;
const PHONE_PATTERN = /(?<!\d)(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}(?!\d)/g;
const PAN_CANDIDATE_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

function isLuhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(URL_USERINFO_PATTERN, '$1[redacted]:[redacted]@')
    .replace(TOKEN_PATTERN, `$1${REDACTED}`)
    .replace(OMNI_TOKEN_PATTERN, REDACTED)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1$2${REDACTED}`)
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(PHONE_PATTERN, '[redacted-phone]')
    .replace(PAN_CANDIDATE_PATTERN, (candidate) => (isLuhnValid(candidate) ? '[redacted-pan]' : candidate));
}

export function sanitizePostMigrationAction(action: PostMigrationAction): PostMigrationAction {
  return {
    kind: action.kind,
    name: redactSensitiveText(action.name),
    method: action.method,
    url: redactSensitiveText(action.url),
    headers: Object.fromEntries(
      Object.keys(action.headers || {}).map((key) => [redactSensitiveText(key), REDACTED]),
    ),
    body: action.body ? REDACTED : '',
    destinationInstanceId: action.destinationInstanceId,
    targetModelId: action.targetModelId,
    targetModelName: action.targetModelName ? redactSensitiveText(action.targetModelName) : action.targetModelName,
  };
}

function sanitizeTargetSemanticPatches(
  patches: MigrationTarget['semanticPatches'],
): MigrationTarget['semanticPatches'] {
  if (!Array.isArray(patches)) return patches;
  return patches.map((patch) => ({
    id: redactSensitiveText(patch.id),
    artifactType: patch.artifactType,
    sourceName: patch.sourceName ? redactSensitiveText(patch.sourceName) : undefined,
    sourceFileName: patch.sourceFileName ? redactSensitiveText(patch.sourceFileName) : undefined,
    targetFileName: redactSensitiveText(patch.targetFileName),
    targetModelId: patch.targetModelId ? redactSensitiveText(patch.targetModelId) : undefined,
    previousChecksum: patch.previousChecksum ? redactSensitiveText(patch.previousChecksum) : undefined,
    latestChecksum: patch.latestChecksum ? redactSensitiveText(patch.latestChecksum) : undefined,
    checksumStale: patch.checksumStale === true,
    resolution: patch.resolution,
    destructive: patch.destructive === true,
    confirmedDestructive: patch.confirmedDestructive === true,
    status: patch.status,
    safetyCategory: patch.safetyCategory,
    recommendedAction: patch.recommendedAction ? redactSensitiveText(patch.recommendedAction) : undefined,
    dependencyPath: patch.dependencyPath?.map((node) => ({
      kind: node.kind,
      label: redactSensitiveText(node.label),
      ref: node.ref ? redactSensitiveText(node.ref) : undefined,
      detail: node.detail ? redactSensitiveText(node.detail) : undefined,
    })),
    warnings: patch.warnings?.map(redactSensitiveText),
  }));
}

export function sanitizeJobItem(item: MigrationJobItem): MigrationJobItem {
  const details = sanitizeJobItemDetails(item.details);
  return {
    ...item,
    destinationLabel: redactSensitiveText(item.destinationLabel),
    targetModelName: item.targetModelName ? redactSensitiveText(item.targetModelName) : item.targetModelName,
    targetFolderPath: item.targetFolderPath ? redactSensitiveText(item.targetFolderPath) : item.targetFolderPath,
    documentName: item.documentName ? redactSensitiveText(item.documentName) : item.documentName,
    error: item.error ? redactSensitiveText(item.error) : item.error,
    warnings: item.warnings?.map(redactSensitiveText),
    notices: item.notices?.map(redactSensitiveText),
    importedIdentifier: item.importedIdentifier ? redactSensitiveText(item.importedIdentifier) : item.importedIdentifier,
    importedDocumentId: item.importedDocumentId ? redactSensitiveText(item.importedDocumentId) : item.importedDocumentId,
    details,
  };
}

export function sanitizeMigrationTarget(target: MigrationTarget): MigrationTarget {
  return {
    ...target,
    destinationLabel: target.destinationLabel ? redactSensitiveText(target.destinationLabel) : target.destinationLabel,
    targetModelName: target.targetModelName ? redactSensitiveText(target.targetModelName) : target.targetModelName,
    targetFolderPath: target.targetFolderPath ? redactSensitiveText(target.targetFolderPath) : target.targetFolderPath,
    topicMappings: target.topicMappings?.map((mapping) => ({
      ...mapping,
      sourceTopicName: redactSensitiveText(mapping.sourceTopicName),
      sourceTopicId: mapping.sourceTopicId ? redactSensitiveText(mapping.sourceTopicId) : mapping.sourceTopicId,
      targetTopicName: redactSensitiveText(mapping.targetTopicName),
      targetTopicLabel: mapping.targetTopicLabel ? redactSensitiveText(mapping.targetTopicLabel) : mapping.targetTopicLabel,
    })),
    queryViewMappings: target.queryViewMappings?.map((mapping) => ({
      ...mapping,
      sourceQueryViewName: redactSensitiveText(mapping.sourceQueryViewName),
      sourceFileName: mapping.sourceFileName ? redactSensitiveText(mapping.sourceFileName) : mapping.sourceFileName,
      targetQueryViewName: redactSensitiveText(mapping.targetQueryViewName),
      targetFileName: mapping.targetFileName ? redactSensitiveText(mapping.targetFileName) : mapping.targetFileName,
      targetQueryViewLabel: mapping.targetQueryViewLabel ? redactSensitiveText(mapping.targetQueryViewLabel) : mapping.targetQueryViewLabel,
    })),
    semanticPatches: sanitizeTargetSemanticPatches(target.semanticPatches),
    queryValidationWaivers: target.queryValidationWaivers?.map((waiver) => ({
      documentId: redactSensitiveText(waiver.documentId),
      queryId: redactSensitiveText(waiver.queryId),
      reason: redactSensitiveText(waiver.reason),
      acknowledgedAt: waiver.acknowledgedAt ? redactSensitiveText(waiver.acknowledgedAt) : undefined,
    })),
  };
}

export function sanitizeMigrationRouteGroup(group: MigrationRouteGroup): MigrationRouteGroup {
  return {
    ...group,
    name: redactSensitiveText(group.name),
    targets: group.targets.map(sanitizeMigrationTarget),
  };
}

export function sanitizeJob(job: MigrationJob): MigrationJob {
  return {
    ...job,
    sourceLabel: redactSensitiveText(job.sourceLabel),
    sourceFolderPath: job.sourceFolderPath ? redactSensitiveText(job.sourceFolderPath) : job.sourceFolderPath,
    targets: job.targets?.map(sanitizeMigrationTarget),
    routeGroups: job.routeGroups?.map(sanitizeMigrationRouteGroup),
    postMigrationActions: job.postMigrationActions.map(sanitizePostMigrationAction),
    details: sanitizeDetails(job.details),
    items: job.items.map(sanitizeJobItem),
  };
}

export function sanitizeJobHistory(jobs: MigrationJob[]): MigrationJob[] {
  return jobs.map(sanitizeJob);
}

function sanitizeDetails(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return value;
  return sanitizeUnknown(value) as Record<string, unknown>;
}

function sanitizeJobItemDetails(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const details = sanitizeDetails(value);
  if (!details) return details;
  const next = { ...details };
  for (const key of ['relationshipEdges', 'addedRelationshipEdges', 'existingRelationshipEdges']) {
    if (Array.isArray(next[key])) {
      next[key] = next[key].map(sanitizeRelationshipEdgeReference).filter(Boolean);
    }
  }
  if (Array.isArray(next.semanticPatches)) {
    next.semanticPatches = next.semanticPatches
      .filter((patch): patch is Record<string, unknown> => Boolean(patch) && typeof patch === 'object' && !Array.isArray(patch))
      .map((patch) => ({
        id: typeof patch.id === 'string' ? redactSensitiveText(patch.id) : '',
        artifactType: typeof patch.artifactType === 'string' ? patch.artifactType : 'field',
        sourceName: typeof patch.sourceName === 'string' ? redactSensitiveText(patch.sourceName) : undefined,
        sourceFileName: typeof patch.sourceFileName === 'string' ? redactSensitiveText(patch.sourceFileName) : undefined,
        targetFileName: typeof patch.targetFileName === 'string' ? redactSensitiveText(patch.targetFileName) : '',
        targetModelId: typeof patch.targetModelId === 'string' ? redactSensitiveText(patch.targetModelId) : undefined,
        previousChecksum: typeof patch.previousChecksum === 'string' ? redactSensitiveText(patch.previousChecksum) : undefined,
        latestChecksum: typeof patch.latestChecksum === 'string' ? redactSensitiveText(patch.latestChecksum) : undefined,
        checksumStale: patch.checksumStale === true,
        resolution: typeof patch.resolution === 'string' ? patch.resolution : 'recommended',
        destructive: patch.destructive === true,
	        confirmedDestructive: patch.confirmedDestructive === true,
	        status: typeof patch.status === 'string' ? patch.status : undefined,
	        safetyCategory: typeof patch.safetyCategory === 'string' ? patch.safetyCategory : undefined,
	        recommendedAction: typeof patch.recommendedAction === 'string' ? redactSensitiveText(patch.recommendedAction) : undefined,
	        dependencyPath: Array.isArray(patch.dependencyPath)
	          ? patch.dependencyPath
	            .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object' && !Array.isArray(node))
	            .map((node) => ({
	              kind: typeof node.kind === 'string' ? node.kind : 'model_file',
	              label: typeof node.label === 'string' ? redactSensitiveText(node.label) : '',
	              ref: typeof node.ref === 'string' ? redactSensitiveText(node.ref) : undefined,
	              detail: typeof node.detail === 'string' ? redactSensitiveText(node.detail) : undefined,
	            }))
	            .filter((node) => node.label)
	          : undefined,
	        warnings: Array.isArray(patch.warnings) ? patch.warnings.filter((warning): warning is string => typeof warning === 'string').map(redactSensitiveText) : undefined,
	      }))
      .filter((patch) => patch.id && patch.targetFileName);
  }
  return next;
}

function sanitizeRelationshipEdgeReference(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const edge = value as Record<string, unknown>;
  const joinFromView = typeof edge.joinFromView === 'string' ? edge.joinFromView : '';
  const joinToView = typeof edge.joinToView === 'string' ? edge.joinToView : '';
  if (!joinFromView || !joinToView) return null;
  return {
    joinFromView,
    joinToView,
    ...(typeof edge.joinType === 'string' ? { joinType: edge.joinType } : {}),
    ...(typeof edge.relationshipType === 'string' ? { relationshipType: edge.relationshipType } : {}),
  };
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      redactSensitiveText(key),
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeUnknown(item),
    ]),
  );
}
