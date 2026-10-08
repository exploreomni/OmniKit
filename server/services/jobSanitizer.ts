import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { TopicMigrationExecutionBinding } from '../../shared/topicMigration';
import type { PostMigrationAction } from './nativeVault';
import type { MigrationJob, MigrationJobItem, MigrationRouteGroup, MigrationTarget, ModelMigrationAcceptedFile } from './migrationJobs';
import { parseDashboardSafeCopyDeploymentEvidence } from '../../shared/dashboardSafeCopyContract';
import { topicMigrationDestinationPath } from './topicMigrationVerification';
import { isTopicMigrationBranchName, isTopicMigrationBranchNameForPlan } from '../../shared/topicMigrationBranchNames';
import { isDashboardPackageBindingMapping } from '../../shared/dashboardPackageBindings';

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
const TOPIC_SNAPSHOT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
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

export function sanitizeJobItem(item: MigrationJobItem, job?: Pick<MigrationJob, 'id' | 'details'>): MigrationJobItem {
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
  const approved = job && item.jobId === job.id && item.kind === 'model_yaml_write' ? approvedTopicFileContext(job.details) : undefined;
  if (approved && details && item.targetModelId === approved.request.targetModelId && item.destinationId === approved.request.targetInstanceId
    && item.details?.sourceModelId === approved.request.sourceModelId && item.details?.targetConnectionId === approved.request.targetConnectionId
    && item.details?.branchName === approved.branchName && isDeepStrictEqual(item.details?.files, approved.files)) {
    preserveTopicFileNames(approved.files, details.files, approved.binding);
  }
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
    // Typed, snapshot-bound identities must remain exact for execution recovery.
    // Never pass through unvalidated mapping objects or arbitrary extra fields.
    bindingMappings: Array.isArray(target.bindingMappings) && target.bindingMappings.length <= 500
      && target.bindingMappings.every(mapping => isDashboardPackageBindingMapping(mapping))
      ? structuredClone(target.bindingMappings) : undefined,
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
    details: sanitizeDetails(job.details, job.id, job),
    items: job.items.map(item => sanitizeJobItem(item, job)),
  };
}

export function sanitizeJobHistory(jobs: MigrationJob[]): MigrationJob[] {
  return jobs.map(sanitizeJob);
}

/** Probe the actual job-history paths before a one-use topic approval is offered. */
export function canPreserveTopicMigrationJobEvidence(binding: TopicMigrationExecutionBinding, files: ModelMigrationAcceptedFile[], branchName: string): boolean {
  const model = { sourceModelId: binding.request.sourceModelId, targetModelId: binding.request.targetModelId,
    targetConnectionId: binding.request.targetConnectionId, branchName };
  const details = { branchPreparation: { profile: 'branch_preparation_v1' }, topicMigration: binding, retryInput: { topicMigration: binding, models: [{ ...model, acceptedFiles: files }] } };
  const writeDetails = { ...model, files };
  const safeWrite = sanitizeJobItemDetails(writeDetails)!;
  const validatedBinding = preserveTopicBindingDigests(binding, true);
  if (validatedBinding) preserveTopicFileNames(files, safeWrite.files, validatedBinding);
  return isDeepStrictEqual(sanitizeDetails(details), details) && isDeepStrictEqual(safeWrite, writeDetails);
}

function approvedTopicFileContext(details: Record<string, unknown> | undefined) {
  const profile = details?.branchPreparation as Record<string, unknown> | undefined;
  if (!profile || profile.profile !== 'branch_preparation_v1' || Object.keys(profile).length !== 1) return;
  const binding = preserveTopicBindingDigests(details?.topicMigration, true);
  const retry = details?.retryInput as Record<string, unknown> | undefined;
  if (!binding || !retry || !isDeepStrictEqual(retry.topicMigration, details?.topicMigration) || !Array.isArray(retry.models) || retry.models.length !== 1) return;
  const model = retry.models[0] as Record<string, unknown>, request = binding.request as Record<string, unknown>;
  if (!model || model.sourceModelId !== request.sourceModelId || model.targetModelId !== request.targetModelId
    || model.targetConnectionId !== request.targetConnectionId || !isTopicMigrationBranchNameForPlan(model.branchName, binding.planId)
    || !Array.isArray(model.acceptedFiles) || model.acceptedFiles.length > 200
    || createHash('sha256').update(JSON.stringify(model.acceptedFiles)).digest('hex') !== binding.filesHash) return;
  return { binding, request, files: model.acceptedFiles, branchName: model.branchName };
}

/** Restore filename identity only; YAML, free text, and checksums still follow their existing protections. */
function preserveTopicFileNames(files: unknown, sanitized: unknown, binding: Record<string, unknown>): void {
  const request = binding.request as Record<string, unknown>;
  if (!Array.isArray(files) || !Array.isArray(sanitized) || files.length !== sanitized.length || files.length > 200
    || !canonicalNamespaceMap(request.schemaMapText)
    || createHash('sha256').update(JSON.stringify(files)).digest('hex') !== binding.filesHash) return;
  const rules = (request.schemaMapText as string).split('\n').filter(Boolean).map(line => line.split(' -> '));
  files.forEach((file: unknown, index) => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || !sanitized[index] || typeof sanitized[index] !== 'object') return;
    const row = file as Record<string, unknown>;
    if (Object.keys(row).some(key => !['fileName', 'yaml', 'previousChecksum'].includes(key))
      || typeof row.fileName !== 'string' || typeof row.yaml !== 'string' || row.yaml.length > 2_000_000
      || !row.fileName.endsWith('.view') || row.fileName.length > 512 || row.fileName.includes('\\')) return;
    const slash = row.fileName.lastIndexOf('/'), folder = row.fileName.slice(0, slash), leaf = row.fileName.slice(slash + 1);
    if (slash <= 0 || !safeNamespace(folder, 1, 3) || !leaf || redactSensitiveText(leaf) !== leaf) return;
    for (const [source, target] of rules.filter(([, target]) => target === folder)) {
      try {
        if (topicMigrationDestinationPath({ sourceFileName: source + '/' + leaf, fileName: row.fileName,
          kind: 'view', proposed: row.yaml }, source + ' -> ' + target) === row.fileName) {
          (sanitized[index] as Record<string, unknown>).fileName = row.fileName;
          return;
        }
      } catch { /* A filename without exact authored namespace proof stays scrubbed. */ }
    }
  });
}

function sanitizeDetails(value: Record<string, unknown> | undefined, jobId?: string, job?: MigrationJob): Record<string, unknown> | undefined {
  if (!value) return value;
  const sanitized = sanitizeUnknown(value) as Record<string, unknown>;
  const profile = value.branchPreparation as Record<string, unknown> | undefined;
  const branchOnly = profile?.profile === 'branch_preparation_v1' && Object.keys(profile).length === 1;
  const topicBinding = preserveTopicBindingDigests(value.topicMigration, branchOnly);
  if (topicBinding) {
    sanitized.topicMigration = topicBinding;
    const retry = value.retryInput;
    const safeRetry = sanitized.retryInput;
    if (retry && typeof retry === 'object' && !Array.isArray(retry)
      && safeRetry && typeof safeRetry === 'object' && !Array.isArray(safeRetry)
      && JSON.stringify((retry as Record<string, unknown>).topicMigration) === JSON.stringify(value.topicMigration)) {
      (safeRetry as Record<string, unknown>).topicMigration = topicBinding;
      const approved = approvedTopicFileContext(value);
      const safeModels = (safeRetry as Record<string, unknown>).models;
      if (approved && Array.isArray(safeModels) && safeModels.length === 1 && safeModels[0] && typeof safeModels[0] === 'object') {
        preserveTopicFileNames(approved.files, (safeModels[0] as Record<string, unknown>).acceptedFiles, approved.binding);
      }
    }
    const dashboardRepair = branchOnly ? preserveBranchRepairDigests(value.dashboardRepair) : undefined;
    if (dashboardRepair) {
      sanitized.dashboardRepair = dashboardRepair;
      if (retry && typeof retry === 'object' && !Array.isArray(retry) && safeRetry && typeof safeRetry === 'object' && !Array.isArray(safeRetry)
        && JSON.stringify((retry as Record<string, unknown>).dashboardRepair) === JSON.stringify(value.dashboardRepair)
        && JSON.stringify((retry as Record<string, unknown>).topicMigration) === JSON.stringify(value.topicMigration)) {
        (safeRetry as Record<string, unknown>).dashboardRepair = dashboardRepair;
      }
    }
    if (branchOnly && jobId) {
      const audits = preserveBranchVerifications(value.branchVerifications, topicBinding, jobId);
      if (audits) sanitized.branchVerifications = audits;
    }
  }
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
  if (job) preserveDashboardPackageEvidence(value, sanitized, job);
  return sanitized;
}

/** Package recovery identities are data, but only inside an exact, approved package scope. */
function preserveDashboardPackageEvidence(value: Record<string, unknown>, sanitized: Record<string, unknown>, job: MigrationJob): void {
  if (job.workflow !== 'dashboard' || value.safeCopyProfile !== 'safe_copy_v1' || value.operationMode !== 'safe_copy') return;
  const object = (entry: unknown): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry));
  const identity = (entry: unknown): entry is string => typeof entry === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(entry) && !SENSITIVE_KEY_PATTERN.test(entry)
    && entry.replace(OMNI_TOKEN_PATTERN, REDACTED) === entry && entry.replace(SECRET_ASSIGNMENT_PATTERN, REDACTED) === entry
    && !['__proto__', 'prototype', 'constructor'].includes(entry);
  const digest = (entry: unknown): entry is string => typeof entry === 'string' && CANONICAL_SAFE_COPY_DIGEST_PATTERN.test(entry);
  const identifier = (entry: unknown): entry is string => typeof entry === 'string' && /^[a-f0-9]{12}$/.test(entry);
  const branchName = (entry: unknown): entry is string => typeof entry === 'string'
    && /^omnikit-dashboard-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(entry);
  const only = (entry: Record<string, unknown>, keys: string[]) => Object.keys(entry).every(key => keys.includes(key));
  const optional = (entry: Record<string, unknown>, key: string, check: (candidate: unknown) => boolean) => entry[key] === undefined || check(entry[key]);
  const text = (entry: unknown) => typeof entry === 'string' && entry.length <= 16_384;
  const boolean = (entry: unknown) => typeof entry === 'boolean';
  let approval: ReturnType<typeof parseDashboardSafeCopyDeploymentEvidence>;
  try {
    if (!job.targets?.length || job.targets.length > 100 || !job.documentIds.length || job.documentIds.length > 500
      || !job.targets.every(target => identity(target.id)) || !job.documentIds.every(identity)) return;
    approval = parseDashboardSafeCopyDeploymentEvidence(value.safeCopyDeployment,
      { documentIds: job.documentIds }, job.targets.map(target => ({ targetId: target.id })));
  } catch { return; }
  if (!approval.packageCopy) return;
  const targets = new Set(job.targets.map(target => target.id));
  const documents = new Set(job.documentIds);
  let mappingBudget = 50_000;
  const validMap = (entry: unknown) => {
    if (!object(entry)) return false;
    const pairs = Object.entries(entry);
    mappingBudget -= pairs.length;
    return mappingBudget >= 0 && pairs.length <= 10_000 && new Set(pairs.map(([, to]) => to)).size === pairs.length
      && pairs.every(([from, to]) => identity(from) && identity(to) && /^[A-Za-z0-9_-]+$/.test(from) && /^[A-Za-z0-9_-]+$/.test(to));
  };
  const receipts = value.dashboardPackageReceipts;
  delete sanitized.dashboardPackageImportRecoveries;
  if (object(receipts) && Object.keys(receipts).length <= targets.size && Object.entries(receipts).every(([targetId, row]) =>
    targets.has(targetId) && object(row)
    && only(row, ['fingerprint', 'baselineHash', 'expectedHash', 'branchId', 'branchName', 'branchVerified', 'modelReady', 'imports'])
    && digest(row.fingerprint) && row.fingerprint === approval.packageCopy!.targetFingerprints[targetId]
    && digest(row.baselineHash) && optional(row, 'expectedHash', digest)
    && optional(row, 'branchId', identity) && optional(row, 'branchName', branchName)
    && optional(row, 'branchVerified', boolean) && optional(row, 'modelReady', boolean)
    && object(row.imports) && Object.keys(row.imports).length <= documents.size
    && Object.entries(row.imports).every(([sourceId, imported]) => documents.has(sourceId) && object(imported)
      && only(imported, ['sourceDocumentId', 'identifier', 'name', 'nameHash', 'documentId', 'miniUuidMap', 'imported', 'localsVerified', 'contentVerified', 'queriesVerified', 'verified'])
      && imported.sourceDocumentId === sourceId && identifier(imported.identifier) && text(imported.name)
      && optional(imported, 'nameHash', digest) && optional(imported, 'documentId', identity) && optional(imported, 'miniUuidMap', validMap)
      && ['imported', 'localsVerified', 'contentVerified', 'queriesVerified', 'verified'].every(key => optional(imported, key, boolean))))) {
    sanitized.dashboardPackageReceipts = Object.fromEntries(Object.entries(receipts).map(([targetId, entry]) => {
      const row = entry as Record<string, unknown>;
      return [targetId, { ...row, imports: Object.fromEntries(Object.entries(row.imports as Record<string, Record<string, unknown>>)
        .map(([sourceId, imported]) => [sourceId, { ...imported, name: redactSensitiveText(imported.name as string) }])) }];
    }));
    const audits = value.dashboardPackageImportRecoveries;
    if (Array.isArray(audits) && audits.length <= 100 && new Set(audits.map(audit => object(audit) ? audit.requestId : undefined)).size === audits.length
      && audits.every(audit => {
        if (!object(audit) || !only(audit, ['version', 'requestId', 'jobId', 'targetId', 'sourceDocumentId', 'itemId',
          'destinationInstanceId', 'modelId', 'documentId', 'identifier', 'verifiedAt', 'previousState', 'outcome',
          'sourceHash', 'mainHash', 'contentHash', 'jobEvidenceHash']) || audit.version !== 1
          || typeof audit.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(audit.requestId)
          || audit.jobId !== job.id || !identity(audit.targetId) || !documents.has(audit.sourceDocumentId as string)
          || !identity(audit.itemId) || !identity(audit.destinationInstanceId) || !identity(audit.modelId)
          || !identity(audit.documentId) || !identifier(audit.identifier)
          || audit.previousState !== 'uncertain' || audit.outcome !== 'verified_existing_import'
          || typeof audit.verifiedAt !== 'number' || !Number.isSafeInteger(audit.verifiedAt) || audit.verifiedAt <= 0
          || !['sourceHash', 'mainHash', 'contentHash', 'jobEvidenceHash'].every(key => digest(audit[key]))) return false;
        const target = job.targets!.find(row => row.id === audit.targetId);
        const receipt = receipts[audit.targetId];
        const imported = object(receipt) && object(receipt.imports) ? receipt.imports[audit.sourceDocumentId as string] : undefined;
        const items = job.items.filter(item => item.id === audit.itemId);
        const item = items[0];
        return target?.destinationInstanceId === audit.destinationInstanceId && target.targetModelId === audit.modelId
          && object(imported) && imported.imported === true && imported.documentId === audit.documentId && imported.identifier === audit.identifier
          && audit.sourceHash === approval.sourceHashes[audit.sourceDocumentId as string] && object(receipt) && audit.mainHash === receipt.expectedHash
          && items.length === 1 && item.jobId === job.id && item.targetId === audit.targetId && item.destinationId === audit.destinationInstanceId
          && item.targetModelId === audit.modelId && item.kind === 'document_verify' && item.status === 'failed'
          && typeof item.endedAt === 'number' && item.endedAt <= audit.verifiedAt
          && item.details?.dashboardPackageWrite === true && item.details.safeCopyAttempt === true
          && item.details.safeCopyAttemptState === 'verified' && item.details.packageOperation === `import:${audit.sourceDocumentId}`;
      })) sanitized.dashboardPackageImportRecoveries = structuredClone(audits);
  }
  const results = value.dashboardPackageResults;
  const documentStatuses = ['verified', 'needs_review', 'uncertain', 'failed'];
  if (Array.isArray(results) && results.length <= targets.size && new Set(results.map(row => object(row) ? row.targetId : undefined)).size === results.length
    && results.every(row => object(row) && only(row, ['targetId', 'status', 'stage', 'message', 'branchId', 'branchName', 'documents'])
      && targets.has(row.targetId as string) && [...documentStatuses, 'waiting_approval'].includes(row.status as string)
      && text(row.stage) && optional(row, 'message', text) && optional(row, 'branchId', identity) && optional(row, 'branchName', branchName)
      && Array.isArray(row.documents) && row.documents.length <= documents.size
      && new Set(row.documents.map(document => object(document) ? document.sourceDocumentId : undefined)).size === row.documents.length
      && row.documents.every(document => object(document)
        && only(document, ['sourceDocumentId', 'name', 'documentId', 'identifier', 'url', 'status', 'message'])
        && documents.has(document.sourceDocumentId as string) && text(document.name) && documentStatuses.includes(document.status as string)
        && optional(document, 'documentId', identity) && optional(document, 'identifier', identifier)
        && optional(document, 'url', text) && optional(document, 'message', text)))) {
    sanitized.dashboardPackageResults = results.map(row => ({ ...row, stage: redactSensitiveText(row.stage),
      ...(row.message === undefined ? {} : { message: redactSensitiveText(row.message) }),
      documents: row.documents.map((document: Record<string, unknown>) => ({ ...document, name: redactSensitiveText(document.name as string),
        ...(document.message === undefined ? {} : { message: redactSensitiveText(document.message as string) }),
        ...(document.url === undefined ? {} : { url: redactSensitiveText(document.url as string) }) })) }));
  }
}

/** Only this bounded, approval-bound audit shape may preserve typed hashes and mapped path identities. */
function preserveBranchVerifications(value: unknown, binding: Record<string, unknown>, jobId: string): unknown[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return;
  const request = binding.request as Record<string, unknown>;
  const object = (entry: unknown): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry));
  const keys = ['version', 'policy', 'verified', 'expectedHash', 'actualHash', 'files', 'findings', 'requestId', 'planId', 'planRevision',
    'jobId', 'targetInstanceId', 'modelId', 'branchId', 'branchName', 'verifiedAt', 'sourceHash', 'mainHash', 'jobEvidenceHash'];
  const digest = (entry: unknown): entry is string => typeof entry === 'string' && TOPIC_SNAPSHOT_HASH_PATTERN.test(entry);
  const identity = (entry: unknown): entry is string => typeof entry === 'string' && isBoundedSafeCopyStructuredIdentity(entry)
    && (CANONICAL_UUID_PATTERN.test(entry) || redactSensitiveText(entry) === entry);
  const namespaces = new Set(canonicalNamespaceMap(request.schemaMapText)
    ? (request.schemaMapText as string).split('\n').filter(Boolean).flatMap(line => line.split(' -> ')) : []);
  const safePath = (entry: unknown): entry is string => {
    if (typeof entry !== 'string' || !entry || entry.length > 512 || entry.includes('\\') || entry.startsWith('/')
      || entry.split('/').some(part => !part || part === '.' || part === '..') || !/^[A-Za-z0-9_ ./$-]+$/.test(entry)) return false;
    if (redactSensitiveText(entry) === entry) return true;
    const slash = entry.lastIndexOf('/'), namespace = entry.slice(0, slash), leaf = entry.slice(slash + 1);
    return slash > 0 && namespaces.has(namespace) && safeNamespace(namespace, 1, 3) && redactSensitiveText(leaf) === leaf;
  };
  const result: unknown[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!object(entry) || Object.keys(entry).length !== keys.length || Object.keys(entry).some(key => !keys.includes(key))
      || entry.version !== 1 || entry.policy !== 'topic_branch_readback_v1' || typeof entry.verified !== 'boolean'
      || entry.planId !== binding.planId || entry.planRevision !== binding.revision || entry.jobId !== jobId
      || entry.targetInstanceId !== request.targetInstanceId || entry.modelId !== request.targetModelId
      || entry.sourceHash !== binding.sourceHash || entry.mainHash !== binding.targetHash
      || !identity(entry.branchId) || !isTopicMigrationBranchNameForPlan(entry.branchName, binding.planId)
      || typeof entry.requestId !== 'string' || !CANONICAL_UUID_PATTERN.test(entry.requestId) || ids.has(entry.requestId)
      || !Number.isSafeInteger(entry.verifiedAt) || Number(entry.verifiedAt) <= 0
      || !digest(entry.expectedHash) || !digest(entry.jobEvidenceHash) || (entry.actualHash !== null && !digest(entry.actualHash))
      || (entry.verified && entry.actualHash === null) || !Array.isArray(entry.files) || entry.files.length > 500
      || !Array.isArray(entry.findings) || entry.findings.length > 1000) return;
    if (entry.files.some(file => !object(file) || Object.keys(file).length !== 4
      || !['sourceFileName', 'submittedFileName', 'destinationFileName'].every(key => safePath(file[key]))
      || !['exact', 'mapped_path', 'formatting_only', 'mapped_path_and_formatting', 'mismatch'].includes(String(file.classification))
      || (entry.verified && file.classification === 'mismatch'))) return;
    if (entry.findings.some(finding => !object(finding) || Object.keys(finding).some(key => !['code', 'fileName', 'message'].includes(key))
      || typeof finding.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(finding.code)
      || typeof finding.message !== 'string' || finding.message.length > 2000
      || (finding.fileName !== undefined && !safePath(finding.fileName)))) return;
    const sanitized = sanitizeUnknown(entry) as Record<string, unknown>;
    for (const key of ['planRevision', 'expectedHash', 'actualHash', 'sourceHash', 'mainHash', 'jobEvidenceHash']) sanitized[key] = entry[key];
    sanitized.files = entry.files.map(file => ({ ...(file as Record<string, unknown>) }));
    sanitized.findings = entry.findings.map(finding => ({ ...(sanitizeUnknown(finding) as Record<string, unknown>),
      ...((finding as Record<string, unknown>).fileName !== undefined ? { fileName: (finding as Record<string, unknown>).fileName } : {}) }));
    result.push(sanitized); ids.add(entry.requestId);
  }
  return result;
}

/** Only exact typed approval digests are exempt from free-text redaction, never YAML or credentials. */
function preserveBranchRepairDigests(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const scalarKeys = ['targetModelHash', 'approvedFilesHash', 'instanceBoundaryHash', 'targetRelationInventoryHash'];
  const mapKeys = ['sourceModelHashes', 'sourceDocumentHashes', 'sourceWorkbookHashes', 'targetRelationEvidence', 'sourceRelationInventoryHashes'];
  const allowed = ['planId', 'targetId', 'revision', 'additiveOnly', ...scalarKeys, ...mapKeys, 'sourceRelationEvidence'];
  const identity = (item: unknown): item is string => typeof item === 'string' && item.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(item) && (CANONICAL_UUID_PATTERN.test(item) || redactSensitiveText(item) === item);
  const digest = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item);
  const digestMap = (item: unknown): item is Record<string, string> => Boolean(item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length <= 5000 && Object.entries(item).every(([key, hash]) => identity(key) && digest(hash)));
  if (Object.keys(row).some((key) => !allowed.includes(key)) || row.additiveOnly !== true || !identity(row.planId) || !identity(row.targetId)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || ['targetModelHash', 'approvedFilesHash', 'instanceBoundaryHash'].some((key) => !digest(row[key]))
    || ['sourceModelHashes', 'sourceDocumentHashes', 'sourceWorkbookHashes'].some((key) => !digestMap(row[key]) || !Object.keys(row[key] as object).length)
    || scalarKeys.some((key) => row[key] !== undefined && !digest(row[key]))
    || mapKeys.some((key) => row[key] !== undefined && !digestMap(row[key]))) return;
  if (row.sourceRelationEvidence !== undefined && (!row.sourceRelationEvidence || typeof row.sourceRelationEvidence !== 'object'
    || Array.isArray(row.sourceRelationEvidence) || Object.keys(row.sourceRelationEvidence).length > 500
    || Object.entries(row.sourceRelationEvidence).some(([key, hashes]) => !identity(key) || !digestMap(hashes)))) return;
  const result = sanitizeUnknown(row) as Record<string, unknown>;
  for (const key of [...scalarKeys, ...mapKeys, 'sourceRelationEvidence']) if (row[key] !== undefined) result[key] = row[key];
  return result;
}

function preserveTopicBindingDigests(value: unknown, branchOnly = false): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const binding = value as Record<string, unknown>;
  const keys = ['planId', 'revision', 'request', 'sourceHash', 'targetHash', 'filesHash', 'instanceBoundaryHash', 'topicIds'];
  if (Object.keys(binding).length !== keys.length || Object.keys(binding).some((key) => !keys.includes(key))
    || typeof binding.planId !== 'string' || !CANONICAL_UUID_PATTERN.test(binding.planId)
    || !binding.request || typeof binding.request !== 'object' || Array.isArray(binding.request)
    || !Array.isArray(binding.topicIds) || (!binding.topicIds.length && !branchOnly) || binding.topicIds.length > 100
    || binding.topicIds.some((id) => typeof id !== 'string' || !isBoundedSafeCopyStructuredIdentity(id))
    || ['revision', 'filesHash', 'instanceBoundaryHash'].some((key) => typeof binding[key] !== 'string' || !/^[0-9a-f]{64}$/.test(binding[key] as string))
    || ['sourceHash', 'targetHash'].some((key) => typeof binding[key] !== 'string' || !TOPIC_SNAPSHOT_HASH_PATTERN.test(binding[key] as string))) return undefined;
  const sanitized = sanitizeUnknown(binding) as Record<string, unknown>;
  // Typed authorization digests are not prose. Namespace mapping preservation
  // below is confined to this validated binding's request, never general text/YAML.
  for (const key of ['revision', 'sourceHash', 'targetHash', 'filesHash', 'instanceBoundaryHash']) sanitized[key] = binding[key];
  const request = binding.request as Record<string, unknown>;
  const safeRequest = sanitized.request as Record<string, unknown>;
  if (canonicalNamespaceMap(request.schemaMapText)) safeRequest.schemaMapText = request.schemaMapText;
  if (safePhysicalMappings(request.tableMappings)) safeRequest.tableMappings = request.tableMappings;
  if (branchOnly && safeDestinationPreservation(request.keepDestinationDefinitions, request.schemaMapText, binding)) {
    safeRequest.keepDestinationDefinitions = request.keepDestinationDefinitions;
  }
  return sanitized;
}

/** Preserve typed choices only within the exact snapshot-bound branch approval. */
function safeDestinationPreservation(value: unknown, schemaMap: unknown, binding: Record<string, unknown>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 200
    || !canonicalNamespaceMap(schemaMap)) return false;
  const namespaces = new Set(schemaMap.split('\n').filter(Boolean).flatMap(line => line.split(' -> ')));
  const safeView = (file: unknown): file is string => {
    if (typeof file !== 'string' || !file.endsWith('.view') || file.length > 512 || file.startsWith('/') || file.includes('\\')
      || !/^[A-Za-z0-9_ ./$-]+$/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) return false;
    if (redactSensitiveText(file) === file) return true;
    const slash = file.lastIndexOf('/'), folder = file.slice(0, slash), leaf = file.slice(slash + 1);
    return slash > 0 && namespaces.has(folder) && safeNamespace(folder, 1, 3) && redactSensitiveText(leaf) === leaf;
  };
  return Object.entries(value).every(([source, raw]) => {
    if (!safeView(source) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const choice = raw as Record<string, unknown>;
    return Object.keys(choice).length === 3 && Object.keys(choice).every(key => ['destinationFileName', 'sourceHash', 'targetHash'].includes(key))
      && safeView(choice.destinationFileName) && choice.sourceHash === binding.sourceHash && choice.targetHash === binding.targetHash;
  });
}

function safeNamespace(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== 'string' || value.length > 389) return false;
  const parts = value.split('.');
  return parts.length >= minimum && parts.length <= maximum && parts.every((part) => part.length <= 128
    && /^[A-Za-z_][A-Za-z0-9_$-]*$/.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part)
    // A dotted namespace may resemble an omni_ token as a whole; no individual
    // segment may itself resemble a credential or other protected text.
    && redactSensitiveText(part) === part);
}
function canonicalNamespaceMap(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 50_000) return false;
  if (value === '') return true;
  const rows = value.split('\n').map((line) => line.split(' -> '));
  if (rows.some((row) => row.length !== 2 || row.some((entry) => !safeNamespace(entry, 1, 3)))
    || new Set(rows.map(([source]) => source.toLowerCase())).size !== rows.length) return false;
  return rows.sort(([a], [b]) => a.localeCompare(b)).map(([source, target]) => source + ' -> ' + target).join('\n') === value;
}
function safePhysicalMappings(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 200 || JSON.stringify(value).length > 2_000_000) return false;
  let count = 0;
  return Object.entries(value).every(([file, raw]) => {
    if (file.length > 512 || !file.endsWith('.view') || file.startsWith('/') || file.includes('\\')
      || file.split('/').some((part) => !part || part === '.' || part === '..') || redactSensitiveText(file) !== file
      || !raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const mapping = raw as Record<string, unknown>;
    if (Object.keys(mapping).some((key) => !['targetTable', 'columnMappings'].includes(key)) || !safeNamespace(mapping.targetTable, 2, 3)) return false;
    if (mapping.columnMappings === undefined) return true;
    if (!mapping.columnMappings || typeof mapping.columnMappings !== 'object' || Array.isArray(mapping.columnMappings)) return false;
    const columns = Object.entries(mapping.columnMappings);
    count += columns.length;
    return columns.length <= 500 && count <= 10_000 && columns.every(([source, target]) => !SENSITIVE_KEY_PATTERN.test(source)
      && safeNamespace(source, 1, 1) && safeNamespace(target, 1, 1))
      && new Set(columns.map(([, target]) => target)).size === columns.length;
  });
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
      || (key === 'branchName' && isTopicMigrationBranchName(value))
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
