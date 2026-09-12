import type { PostMigrationAction } from './nativeVault';
import type { MigrationJob, MigrationJobItem, MigrationRouteGroup, MigrationTarget } from './migrationJobs';
import { parseDashboardSafeCopyDeploymentEvidence } from '../../shared/dashboardSafeCopyContract';

const REDACTED = '[redacted]';
const EMAIL_PATTERN = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?=[^A-Z0-9]|$)/gi;
const TOKEN_PATTERN = /\b((?:Bearer|token)\s+)[A-Za-z0-9._~+/=-]+\b/gi;
const OMNI_TOKEN_PATTERN = /\bomni_[A-Za-z0-9._~+/=-]{8,}\b/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|authorization|token|secret|password|passphrase)(["'\s:=]+)([^"',\s}]+)/gi;
const URL_USERINFO_PATTERN = /(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const SENSITIVE_KEY_PATTERN = /^(api[_-]?key|authorization|token|secret|password|passphrase)$/i;
const PHONE_PATTERN = /(?<!\d)(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}(?!\d)/g;
const PAN_CANDIDATE_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_KEY_PATTERN = /(?:^|_)(?:id|ids)$|(?:Id|Ids)$/;
const CANONICAL_SAFE_COPY_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
const CANONICAL_SCRATCH_BRANCH_PATTERN = /^omnikit-validate-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_COPY_DIGEST_KEYS = new Set([
  'safeCopyIntentHash',
  'safeCopyDecisionFingerprint',
  'safeCopyPlanFingerprint',
  'safeCopyAttemptFingerprint',
  'safeCopySourceExportHash',
  'safeCopyExpectedPayloadHash',
  'safeCopyPreviousChecksum',
  'safeCopyExpectedYamlHash',
  'safeCopySemanticProofHash',
  'safeCopyPublishedFingerprint',
  'migrationMutationDispatchFingerprint',
  'migrationMutationResolutionRequestHash',
  'requestHash',
  'dispatchFingerprint',
  'sourceExportHash',
  'expectedPayloadHash',
  'publishedFingerprint',
]);
const SAFE_COPY_STRUCTURED_IDENTITY_KEYS = new Set([
  'safeCopyAttemptId',
  'safeCopyDestinationInstanceId',
  'safeCopyConnectionId',
  'safeCopyModelId',
  'safeCopyFolderId',
  'safeCopySourceDocumentId',
  'safeCopyPreexistingDocumentIds',
  'safeCopyImportedDocumentId',
  'safeCopyImportedIdentifier',
  'safeCopyFileName',
  'jobId',
  'attemptId',
  'targetId',
  'sourceInstanceId',
  'sourceConnectionId',
  'sourceDocumentId',
  'destinationInstanceId',
  'connectionId',
  'modelId',
  'folderId',
  'importedDocumentId',
  'importedIdentifier',
  'migrationMutationExternalJobId',
  'migrationMutationBranchId',
  'migrationMutationDispatchItemId',
  'migrationMutationResolutionRequestId',
  'requestId',
  'leaseItemId',
  'dispatchItemId',
]);
const MAX_SAFE_COPY_STRUCTURED_IDENTITY_CHARACTERS = 1_024;

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
  const safeCopyEvidence = (
    item.id.startsWith('safe-copy-attempt:')
    && item.details?.safeCopyAttempt === true
  ) || (
    item.id.startsWith('safe-copy-verification:')
    && Boolean(item.details?.safeCopyDocumentProvenance)
    && typeof item.details?.safeCopyDocumentProvenance === 'object'
    && !Array.isArray(item.details?.safeCopyDocumentProvenance)
  ) || (
    item.id.startsWith('safe-copy-target-result:')
    && item.details?.safeCopyTargetExecutionSummary === true
  ) || (
    item.id.startsWith('destination-model-mutation:')
    && item.details?.migrationDestinationModelMutation === true
  );
  const details = sanitizeJobItemDetails(item.details, safeCopyEvidence);
  return {
    ...item,
    destinationLabel: redactSensitiveText(item.destinationLabel),
    targetModelName: item.targetModelName ? redactSensitiveText(item.targetModelName) : item.targetModelName,
    targetFolderPath: item.targetFolderPath ? redactSensitiveText(item.targetFolderPath) : item.targetFolderPath,
    documentName: item.documentName ? redactSensitiveText(item.documentName) : item.documentName,
    error: item.error ? redactSensitiveText(item.error) : item.error,
    warnings: item.warnings?.map(redactSensitiveText),
    notices: item.notices?.map(redactSensitiveText),
    importedIdentifier: item.importedIdentifier
      ? safeCopyEvidence && isBoundedSafeCopyStructuredIdentity(item.importedIdentifier)
        ? item.importedIdentifier
        : redactSensitiveText(item.importedIdentifier)
      : item.importedIdentifier,
    importedDocumentId: item.importedDocumentId
      ? safeCopyEvidence && isBoundedSafeCopyStructuredIdentity(item.importedDocumentId)
        ? item.importedDocumentId
        : redactSensitiveText(item.importedDocumentId)
      : item.importedDocumentId,
    details,
  };
}

export function sanitizeMigrationTarget(target: MigrationTarget): MigrationTarget {
  return {
    ...target,
    destinationLabel: target.destinationLabel ? redactSensitiveText(target.destinationLabel) : target.destinationLabel,
    targetModelName: target.targetModelName ? redactSensitiveText(target.targetModelName) : target.targetModelName,
    targetFolderPath: target.targetFolderPath ? redactSensitiveText(target.targetFolderPath) : target.targetFolderPath,
    ...(target.workbookCopy ? { workbookCopy: {
      stagingFolderId: isBoundedSafeCopyStructuredIdentity(target.workbookCopy.stagingFolderId)
        ? target.workbookCopy.stagingFolderId : redactSensitiveText(target.workbookCopy.stagingFolderId),
    } } : {}),
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
  const sanitized = sanitizeUnknown(value) as Record<string, unknown>;
  const deployment = value.safeCopyDeployment;
  if (deployment && typeof deployment === 'object' && !Array.isArray(deployment)) {
    const evidence = deployment as Record<string, unknown>;
    const hashMap = (candidate: unknown, limit: number): candidate is Record<string, string> => candidate !== null
      && typeof candidate === 'object' && !Array.isArray(candidate)
      && Object.keys(candidate).length > 0 && Object.keys(candidate).length <= limit
      && Object.entries(candidate).every(([key, hash]) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(key)
        && typeof hash === 'string' && CANONICAL_SAFE_COPY_DIGEST_PATTERN.test(hash));
    if (evidence.version === 2 && typeof evidence.planId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(evidence.planId)
      && hashMap(evidence.sourceHashes, 500) && hashMap(evidence.modelHashes, 100)
      && (evidence.sourceModelHashes === undefined || hashMap(evidence.sourceModelHashes, 500))) {
      // Digests are not human text; redaction must not corrupt authorization.
      try {
        sanitized.safeCopyDeployment = parseDashboardSafeCopyDeploymentEvidence(evidence,
          { documentIds: Object.keys(evidence.sourceHashes) },
          Object.keys(evidence.modelHashes).map((targetId) => ({ targetId })));
      } catch {
        delete sanitized.safeCopyDeployment;
      }
    } else delete sanitized.safeCopyDeployment;
  }
  return sanitized;
}

function sanitizeJobItemDetails(
  value: Record<string, unknown> | undefined,
  safeCopyStructuredEvidence = false,
): Record<string, unknown> | undefined {
  const details = value
    ? sanitizeUnknown(value, undefined, safeCopyStructuredEvidence) as Record<string, unknown>
    : value;
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

function isBoundedSafeCopyStructuredIdentity(value: string): boolean {
  return Boolean(
    value
    && value === value.trim()
    && value.length <= MAX_SAFE_COPY_STRUCTURED_IDENTITY_CHARACTERS
    && ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }),
  );
}

function preserveStructuredIdentifier(
  key: string | undefined,
  value: string,
  safeCopyStructuredEvidence = false,
): boolean {
  return Boolean(
    key
    && (
      (IDENTIFIER_KEY_PATTERN.test(key) && CANONICAL_UUID_PATTERN.test(value))
      || (SAFE_COPY_DIGEST_KEYS.has(key) && CANONICAL_SAFE_COPY_DIGEST_PATTERN.test(value))
      || (key === 'migrationMutationBranchName' && CANONICAL_SCRATCH_BRANCH_PATTERN.test(value))
      || (
        safeCopyStructuredEvidence
        && SAFE_COPY_STRUCTURED_IDENTITY_KEYS.has(key)
        && isBoundedSafeCopyStructuredIdentity(value)
      )
    ),
  );
}

function sanitizeUnknown(
  value: unknown,
  parentKey?: string,
  safeCopyStructuredEvidence = false,
): unknown {
  if (typeof value === 'string') {
    return preserveStructuredIdentifier(parentKey, value, safeCopyStructuredEvidence)
      ? value
      : redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, parentKey, safeCopyStructuredEvidence));
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      preserveStructuredIdentifier(parentKey, key, safeCopyStructuredEvidence)
        ? key
        : redactSensitiveText(key),
      SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : sanitizeUnknown(item, key, safeCopyStructuredEvidence),
    ]),
  );
}
