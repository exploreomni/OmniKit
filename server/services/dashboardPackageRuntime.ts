import { randomUUID } from 'node:crypto';
import type { DashboardSafeCopyIntent, DashboardSafeCopyDestination } from '../../shared/dashboardSafeCopyContract';
import { DashboardSafeCopyError } from '../../shared/dashboardSafeCopyContract';
import type { DashboardPackageTargetResult } from '../../shared/dashboardPackage';
import type { MigrationJob, MigrationJobItem } from './migrationJobs';
import { getJob, listJobs, updateJobAtomically } from './jobStore';
import { publishMigrationJobEvent } from './jobEvents';
import { assertDashboardSafeCopyInstanceRoles, dashboardSafeCopyIntentHash } from './dashboardSafeCopyJobs';
import { authoredSnapshot, collectDashboardPackages, packageBoundary, packageClient, packageHash, prepareDashboardPackageTarget } from './dashboardPackagePlan';
import { listDashboardPackageTiles, restoreDashboardPackageLocals, retargetDashboardPackage, verifyDashboardPackageContent, type DashboardPackage } from './dashboardPackageTransport';
import { allocateDashboardSafeCopyName } from './dashboardSafeCopyProvenance';
import { hasUnresolvedMigrationDestinationModelMutation, reserveMigrationDestinationModels } from './migrationScopeReservation';
import { compareTopicMigrationBranch } from './topicMigrationVerification';
import { validateTopicCorrectionBranch } from './topicBranchValidation';
import { type OmniClient, type OmniWriteDispatchGuard } from './omniClient';
import { getInstance, listInstances } from './nativeVault';
import { redactSensitiveText, sanitizeJob } from './jobSanitizer';

interface ImportReceipt {
  sourceDocumentId: string; identifier: string; name: string; nameHash?: string; documentId?: string;
  miniUuidMap?: Record<string, string>; imported?: boolean; localsVerified?: boolean;
  contentVerified?: boolean; queriesVerified?: boolean; verified?: boolean;
}
interface TargetReceipt {
  fingerprint: string; baselineHash: string; expectedHash?: string;
  branchId?: string; branchName?: string; branchVerified?: boolean; modelReady?: boolean;
  imports: Record<string, ImportReceipt>;
}
type ReceiptMap = Record<string, TargetReceipt>;
const active = new Set<string>();
interface ImportRecoveryRequest { targetId: string; sourceDocumentId: string; requestId: string }
const recoveryError = () => new DashboardSafeCopyError('PACKAGE_IMPORT_RECONCILIATION_REQUIRED',
  'This retained import cannot be safely verified automatically. Inspect the existing copy; do not repeat the import.', 409);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
async function readYaml(client: OmniClient, modelId: string, options?: Parameters<OmniClient['getModelYaml']>[1]) {
  return authoredSnapshot(await client.getModelYaml(modelId, options));
}
const writes = (job: MigrationJob) => job.items.filter(item => item.details?.dashboardPackageWrite === true);
const receiptMap = (job: MigrationJob): ReceiptMap => (job.details?.dashboardPackageReceipts || {}) as ReceiptMap;
const targetResults = (job: MigrationJob): DashboardPackageTargetResult[] => (job.details?.dashboardPackageResults || []) as DashboardPackageTargetResult[];
function current(jobId: string): MigrationJob {
  const job = getJob(jobId);
  if (!job) throw new Error('Dashboard deployment history is unavailable.');
  return job;
}
function save(jobId: string, change: (job: MigrationJob) => MigrationJob): MigrationJob {
  const job = updateJobAtomically(jobId, change);
  if (!job) throw new Error('Dashboard deployment history could not be saved.');
  publishMigrationJobEvent({ type: 'job', jobId, status: job.status, at: Date.now(), job });
  return job;
}
function receipt(jobId: string, targetId: string, change: (row: TargetReceipt) => TargetReceipt) {
  save(jobId, job => ({ ...job, details: { ...job.details, dashboardPackageReceipts: {
    ...receiptMap(job), [targetId]: change(receiptMap(job)[targetId]),
  } } }));
}
function result(jobId: string, destination: DashboardSafeCopyDestination, change: Partial<DashboardPackageTargetResult>) {
  save(jobId, job => {
    const previous = targetResults(job).find(row => row.targetId === destination.targetId);
    const next: DashboardPackageTargetResult = { targetId: destination.targetId, status: 'needs_review', stage: 'Preparing package', documents: [], ...previous, ...change };
    return { ...job, details: { ...job.details, dashboardPackageResults: [
      ...targetResults(job).filter(row => row.targetId !== destination.targetId), next,
    ] } };
  });
}
function documentResult(jobId: string, destination: DashboardSafeCopyDestination, row: DashboardPackageTargetResult['documents'][number]) {
  const previous = targetResults(current(jobId)).find(item => item.targetId === destination.targetId);
  result(jobId, destination, { documents: [...(previous?.documents || []).filter(item => item.sourceDocumentId !== row.sourceDocumentId), row] });
}
function assertAuthority(jobId: string, intent: DashboardSafeCopyIntent, boundary: string) {
  if (current(jobId).status === 'canceled') throw new Error('Deployment was canceled. No further writes will be sent.');
  if (current(jobId).details?.safeCopyIntentHash !== dashboardSafeCopyIntentHash(intent)) throw recoveryError();
  assertDashboardSafeCopyInstanceRoles(intent);
  if (packageBoundary(intent) !== boundary) throw new Error('A selected saved connection changed. Reconnect and review before continuing.');
}
function destinationScopes(destination: DashboardSafeCopyDestination) {
  const selected = getInstance(destination.instanceId);
  if (!selected) throw new Error('The selected instance is unavailable.');
  const origin = new URL(selected.baseUrl).origin;
  return listInstances().filter(instance => new URL(instance.baseUrl).origin === origin)
    .map(instance => ({ destinationInstanceId: instance.id, targetModelId: destination.modelId }));
}
function auditedImport(job: MigrationJob, intent: DashboardSafeCopyIntent, item: MigrationJobItem): boolean {
  const audits = job.details?.dashboardPackageImportRecoveries;
  return Array.isArray(audits) && audits.some(audit => {
    if (!audit || typeof audit !== 'object') return false;
    const saved = receiptMap(job)[audit.targetId]?.imports?.[audit.sourceDocumentId];
    return audit.version === 1 && audit.outcome === 'verified_existing_import' && audit.previousState === 'uncertain'
      && audit.jobId === job.id && audit.itemId === item.id && audit.targetId === item.targetId
      && audit.destinationInstanceId === item.destinationId && audit.modelId === item.targetModelId
      && audit.sourceHash === intent.deployment?.sourceHashes[audit.sourceDocumentId]
      && audit.mainHash === receiptMap(job)[audit.targetId]?.expectedHash
      && saved?.imported === true && saved.documentId === audit.documentId && saved.identifier === audit.identifier
      && item.details?.packageOperation === `import:${audit.sourceDocumentId}`
      && item.status === 'failed' && item.details?.safeCopyAttemptState === 'verified';
  });
}

/** Eligibility is a UI hint only; fresh authority and artifact evidence are required below. */
function importRecoveryCandidate(job: MigrationJob, intent: DashboardSafeCopyIntent, targetId: string, sourceDocumentId: string) {
  const destination = intent.destinations.find(row => row.targetId === targetId);
  const target = receiptMap(job)[targetId];
  const imported = target?.imports?.[sourceDocumentId];
  const items = writes(job).filter(item => item.targetId === targetId);
  const pending = items.filter(item => ['dispatched', 'uncertain'].includes(String(item.details?.safeCopyAttemptState)));
  const item = pending[0];
  if (!destination || !['failed', 'partial'].includes(job.status) || !job.endedAt || active.has(job.id)
    || job.details?.safeCopyIntentHash !== dashboardSafeCopyIntentHash(intent)
    || !intent.deployment?.packageCopy || !intent.source.documentIds.includes(sourceDocumentId)
    || !target?.modelReady || !digest(target.expectedHash) || target.fingerprint !== intent.deployment.packageCopy.targetFingerprints[targetId]
    || target.baselineHash !== intent.deployment.modelHashes[targetId]
    || !imported || imported.sourceDocumentId !== sourceDocumentId || imported.imported !== true
    || !identity(imported.documentId) || !/^[a-f0-9]{12}$/.test(imported.identifier) || !digest(imported.nameHash)
    || imported.localsVerified || imported.contentVerified || imported.queriesVerified || imported.verified
    || Object.values(target.imports).filter(row => row.imported && (row.documentId === imported.documentId || row.identifier === imported.identifier)).length !== 1
    || pending.length !== 1 || !item || item.kind !== 'document_verify' || item.status !== 'failed' || !item.endedAt
    || !item.startedAt || item.endedAt < item.startedAt || item.endedAt > job.endedAt
    || item.jobId !== job.id || item.destinationId !== destination.instanceId || item.targetModelId !== destination.modelId
    || item.details?.safeCopyAttempt !== true || item.details.safeCopyAttemptState !== 'uncertain'
    || item.details.packageOperation !== `import:${sourceDocumentId}`
    || item.details.safeCopyDestinationInstanceId !== destination.instanceId || item.details.safeCopyModelId !== destination.modelId
    || items.some(other => other !== item && !(other.status === 'succeeded' && other.details?.safeCopyAttemptState === 'verified')
      && !auditedImport(job, intent, other))
    || job.items.some(other => other.targetId === targetId && other.status === 'running')
    || job.items.filter(other => other.id === item.id).length !== 1) return undefined;
  return { destination, target, imported, item };
}

export function withDashboardPackageRecoveryEvidence(job: MigrationJob, intent: DashboardSafeCopyIntent): MigrationJob {
  return { ...job, details: { ...job.details, dashboardPackageResults: targetResults(job).map(target => ({ ...target,
    documents: target.documents.map(document => {
      const saved = receiptMap(job)[target.targetId]?.imports?.[document.sourceDocumentId];
      const destination = intent.destinations.find(row => row.targetId === target.targetId);
      const created = saved?.imported === true && identity(saved.documentId) && /^[a-f0-9]{12}$/.test(saved.identifier);
      const instance = destination && getInstance(destination.instanceId);
      const safeDocument = { ...document };
      delete safeDocument.documentId; delete safeDocument.identifier; delete safeDocument.url;
      return { ...safeDocument, created, canVerifyExistingCopy: Boolean(importRecoveryCandidate(job, intent, target.targetId, document.sourceDocumentId)),
        ...(created ? { documentId: saved.documentId, identifier: saved.identifier,
          ...(instance ? { url: new URL(`/dashboards/${encodeURIComponent(saved.identifier)}`, instance.baseUrl).toString() } : {}) } : {}) };
    }),
  })) } };
}

/** An explicit read-only reconciliation precedes any continuation; import itself is never replayed. */
export async function verifyDashboardPackageImport(jobId: string, intent: DashboardSafeCopyIntent, targetId: string,
  sourceDocumentId: string, requestId: string): Promise<{ job: MigrationJob }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
    || !identity(sourceDocumentId) || active.has(jobId)) throw recoveryError();
  assertAuthority(jobId, intent, packageBoundary(intent));
  const audits = current(jobId).details?.dashboardPackageImportRecoveries;
  if (Array.isArray(audits)) {
    const prior = audits.find(audit => audit && typeof audit === 'object' && audit.requestId === requestId);
    if (prior) {
      if (prior.targetId !== targetId || prior.sourceDocumentId !== sourceDocumentId || prior.jobId !== jobId) throw recoveryError();
      return { job: current(jobId) };
    }
  }
  const candidate = importRecoveryCandidate(current(jobId), intent, targetId, sourceDocumentId);
  if (!candidate) throw recoveryError();
  active.add(jobId);
  try { await reconcileRetainedImport(jobId, intent, { targetId, sourceDocumentId, requestId }, candidate); }
  finally { active.delete(jobId); }
  return runDashboardPackageJob(jobId, intent, targetId);
}

/** Exact identity/placement plus authoritative model chain; optional list fields are corroboration, not authority. */
async function verifyImportedPlacement(client: OmniClient, destination: DashboardSafeCopyDestination, saved: ImportReceipt) {
  if (!identity(saved.documentId) || !identity(saved.identifier)) throw recoveryError();
  const folders = await client.listFolderInventory();
  const folder = folders.folders.filter(item => item.id === destination.folderId && item.path === destination.folderPath);
  if (!folders.pagination.complete || folder.length !== 1) throw new Error('The approved destination folder changed.');
  const observed = await client.listDocumentInventory({ folderId: destination.folderId });
  const matches = observed.documents.filter(document => document.identifier === saved.identifier || document.documentId === saved.documentId);
  const document = matches[0];
  if (!observed.pagination.complete || matches.length !== 1 || document.identifier !== saved.identifier || document.documentId !== saved.documentId
    || document.deleted || document.folderId !== destination.folderId
    || (saved.nameHash ? packageHash(document.name) !== saved.nameHash : document.name !== saved.name)
    || document.baseModelId !== undefined && document.baseModelId !== destination.modelId
    || document.connectionId !== undefined && document.connectionId !== destination.connectionId) {
    throw new Error('The imported document placement or model binding is not verified.');
  }
  const state = await client.getDocumentStateV2(saved.identifier);
  const exported = await client.exportDocument(saved.identifier);
  const workbook = exported.workbookModel as Record<string, unknown> | undefined;
  const exactIdentity = (values: unknown[]): string | undefined => {
    const present = values.filter(value => value !== undefined && value !== null);
    return present.length && present.every(value => identity(value) && value === present[0]) ? present[0] as string : undefined;
  };
  const workbookId = workbook && exactIdentity([workbook.id, workbook.modelId, workbook.model_id]);
  const shared = [state.modelId, state.baseModelId].filter(value => value !== undefined);
  if (state.name !== document.name || !shared.length || shared.some(value => value !== destination.modelId)
    || !workbook || typeof workbook !== 'object' || Array.isArray(workbook) || !workbookId
    || state.workbookModelId !== workbookId || workbookId === destination.modelId
    || exactIdentity([workbook.base_model_id, workbook.baseModelId]) !== destination.modelId
    || exactIdentity([workbook.connection_id, workbook.connectionId]) !== destination.connectionId) throw recoveryError();
  let models = await client.listModels({ modelId: destination.modelId, modelKind: 'SHARED' });
  if (!models.some(model => model.id === destination.modelId)) models = await client.listModels({ modelId: destination.modelId, modelKind: 'SHARED_EXTENSION' });
  const sharedModels = models.filter(model => model.id === destination.modelId && !model.deletedAt
    && ['SHARED', 'SHARED_EXTENSION'].includes(model.kind || '') && model.connectionId === destination.connectionId);
  const locals = (await client.listModels({ modelId: workbookId, modelKind: 'WORKBOOK' }))
    .filter(model => model.id === workbookId && model.kind === 'WORKBOOK' && !model.deletedAt
      && model.baseModelId === destination.modelId && model.connectionId === destination.connectionId);
  if (sharedModels.length !== 1 || locals.length !== 1) throw recoveryError();
  return { row: { ...saved, name: document.name }, exported };
}

async function reconcileRetainedImport(jobId: string, intent: DashboardSafeCopyIntent, request: ImportRecoveryRequest,
  candidate: NonNullable<ReturnType<typeof importRecoveryCandidate>>) {
  const before = current(jobId), evidenceHash = packageHash(before);
  const boundary = packageBoundary(intent), scopes = destinationScopes(candidate.destination);
  const assertFresh = () => {
    assertAuthority(jobId, intent, boundary);
    if (packageHash(current(jobId)) !== evidenceHash || hasUnresolvedMigrationDestinationModelMutation(listJobs(Number.MAX_SAFE_INTEGER), scopes,
      { excludeItemIds: new Set([candidate.item.id]) })) throw recoveryError();
  };
  assertFresh();
  const release = reserveMigrationDestinationModels(`dashboard-package-recovery:${jobId}`, scopes);
  try {
    const sources = await collectDashboardPackages(intent); expectedSource(intent, sources); assertFresh();
    const pkg = sources.packages.find(value => value.documentId === request.sourceDocumentId);
    if (!pkg) throw recoveryError();
    const client = packageClient(candidate.destination.instanceId);
    const observed = await verifyImportedPlacement(client, candidate.destination, candidate.imported); assertFresh();
    const binding = { modelId: candidate.destination.modelId, connectionId: candidate.destination.connectionId,
      name: observed.row.name, identifier: observed.row.identifier, folderPath: candidate.destination.folderPath };
    const content = verifyDashboardPackageContent(pkg, observed.exported, observed.row.miniUuidMap, binding);
    if (!content.verified) throw new Error(`The retained imported content requires review: ${content.findings.join(' ')}`);
    const main = await readYaml(client, candidate.destination.modelId, { mode: 'combined', fullyResolved: false }); assertFresh();
    if (packageHash(main.files) !== candidate.target.expectedHash) throw recoveryError();
    // Repeat the exact artifact read after awaited model checks. Never authorize recovery from stale placement/content.
    const final = await verifyImportedPlacement(client, candidate.destination, candidate.imported); assertFresh();
    if (packageHash(final.exported) !== packageHash(observed.exported)) throw recoveryError();
    const audit = { version: 1, requestId: request.requestId, jobId, targetId: request.targetId, sourceDocumentId: request.sourceDocumentId,
      itemId: candidate.item.id, destinationInstanceId: candidate.destination.instanceId, modelId: candidate.destination.modelId,
      documentId: observed.row.documentId!, identifier: observed.row.identifier, verifiedAt: Date.now(),
      previousState: 'uncertain', outcome: 'verified_existing_import', sourceHash: intent.deployment!.sourceHashes[request.sourceDocumentId],
      mainHash: candidate.target.expectedHash!, contentHash: packageHash(final.exported), jobEvidenceHash: evidenceHash };
    save(jobId, job => {
      if (packageHash(job) !== evidenceHash) throw recoveryError();
      const audits = job.details?.dashboardPackageImportRecoveries;
      if (audits !== undefined && !Array.isArray(audits) || Array.isArray(audits) && audits.length >= 100) throw recoveryError();
      const next = { ...job, details: { ...job.details, dashboardPackageImportRecoveries: [...(Array.isArray(audits) ? audits : []), audit] },
        items: job.items.map(item => item.id === candidate.item.id ? { ...item,
          details: { ...item.details, safeCopyAttemptState: 'verified' } } : item) };
      const preserved = sanitizeJob(next).details?.dashboardPackageImportRecoveries;
      if (!Array.isArray(preserved) || packageHash(preserved) !== packageHash(next.details.dashboardPackageImportRecoveries)) throw recoveryError();
      return next;
    });
  } finally { release(); }
}
/** Each actual dispatch has a durable intent. Unknown outcomes never become retryable writes. */
async function write<T>(jobId: string, intent: DashboardSafeCopyIntent, destination: DashboardSafeCopyDestination,
  boundary: string, operation: string, work: (guard: OmniWriteDispatchGuard) => Promise<T>): Promise<T> {
  assertAuthority(jobId, intent, boundary);
  const itemId = randomUUID();
  const item: MigrationJobItem = { id: itemId, jobId, targetId: destination.targetId, destinationId: destination.instanceId,
    destinationLabel: destination.instanceId, targetModelId: destination.modelId, kind: 'document_verify', status: 'running', startedAt: Date.now(),
    details: { dashboardPackageWrite: true, packageOperation: operation, safeCopyAttempt: true, safeCopyAttemptState: 'allocated',
      safeCopyDestinationInstanceId: destination.instanceId, safeCopyModelId: destination.modelId } };
  save(jobId, job => ({ ...job, items: [...job.items, item] }));
  let dispatched = false;
  const guard: OmniWriteDispatchGuard = { assertCanDispatch() {
    assertAuthority(jobId, intent, boundary);
    if (dispatched) return;
    // This is called inside the client after asynchronous dispatch prerequisites.
    save(jobId, job => ({ ...job, items: job.items.map(row => row.id === itemId ? { ...row,
      details: { ...row.details, safeCopyAttemptState: 'dispatched' } } : row) }));
    dispatched = true;
  } };
  try {
    const value = await work(guard);
    assertAuthority(jobId, intent, boundary);
    save(jobId, job => ({ ...job, items: job.items.map(row => row.id === itemId ? { ...row, status: 'succeeded', endedAt: Date.now(),
      details: { ...row.details, safeCopyAttemptState: 'verified' } } : row) }));
    return value;
  } catch (error) {
    const uncertain = dispatched;
    save(jobId, job => ({ ...job, items: job.items.map(row => row.id === itemId ? { ...row, status: 'failed', endedAt: Date.now(),
      error: uncertain ? 'The dispatched operation requires reconciliation. Do not repeat it.' : 'The operation stopped before dispatch.',
      details: { ...row.details, safeCopyAttemptState: uncertain ? 'uncertain' : 'failed_prewrite' } } : row) }));
    throw error;
  }
}
function unresolved(job: MigrationJob, targetId: string) {
  return writes(job).some(item => item.targetId === targetId && ['dispatched', 'uncertain'].includes(String(item.details?.safeCopyAttemptState)));
}
function importRow(jobId: string, targetId: string, sourceDocumentId: string) {
  return receiptMap(current(jobId))[targetId].imports[sourceDocumentId];
}
function saveImport(jobId: string, targetId: string, value: ImportReceipt) {
  receipt(jobId, targetId, row => ({ ...row, imports: { ...row.imports, [value.sourceDocumentId]: value } }));
}
function expectedSource(intent: DashboardSafeCopyIntent, sources: Awaited<ReturnType<typeof collectDashboardPackages>>) {
  if (packageHash(sources.sourceHashes) !== packageHash(intent.deployment!.sourceHashes)
    || packageHash(sources.sourceModelHashes) !== packageHash(intent.deployment!.sourceModelHashes)) {
    throw new Error('The approved source package changed. Create a fresh review; no source changes will be copied silently.');
  }
}
function branchFiles(prepared: Awaited<ReturnType<typeof prepareDashboardPackageTarget>>) {
  return prepared.preview.files.filter(file => file.action === 'create' || file.action === 'add').map(file => ({
    sourceFileName: file.fileName, fileName: file.fileName, before: file.action === 'create' ? null : file.before,
    proposed: file.after, status: file.action as 'create' | 'add', topicIds: [],
    kind: (file.fileName.endsWith('.topic') ? 'topic' : file.fileName.endsWith('.view') ? 'view'
      : file.fileName.split('/').at(-1) === 'relationships' ? 'relationships' : 'model') as 'topic' | 'view' | 'relationships' | 'model',
  }));
}
async function ensureSharedModel(jobId: string, intent: DashboardSafeCopyIntent, destination: DashboardSafeCopyDestination,
  sources: Awaited<ReturnType<typeof collectDashboardPackages>>) {
  let saved = receiptMap(current(jobId))[destination.targetId];
  const client = packageClient(destination.instanceId);
  const snapshot = await readYaml(client, destination.modelId, { mode: 'combined', fullyResolved: false, includeChecksums: true });
  // Several folders may share one destination model. Reuse this job's exact
  // verified additions, not a fresh unreviewed rebase or a second model merge.
  if (!saved) {
    const sibling = intent.destinations.find(peer => peer.targetId !== destination.targetId
      && peer.instanceId === destination.instanceId && peer.connectionId === destination.connectionId && peer.modelId === destination.modelId
      && receiptMap(current(jobId))[peer.targetId]?.modelReady
      && receiptMap(current(jobId))[peer.targetId]?.baselineHash === intent.deployment!.modelHashes[destination.targetId]
      && receiptMap(current(jobId))[peer.targetId]?.expectedHash === packageHash(snapshot.files));
    if (sibling) {
      const shared = receiptMap(current(jobId))[sibling.targetId];
      receipt(jobId, destination.targetId, () => ({ fingerprint: intent.deployment!.packageCopy!.targetFingerprints[destination.targetId],
        baselineHash: shared.baselineHash, expectedHash: shared.expectedHash, modelReady: true, imports: {} }));
      saved = receiptMap(current(jobId))[destination.targetId];
    }
  }
  if (saved?.modelReady || saved?.branchVerified) {
    if (saved.expectedHash && packageHash(snapshot.files) === saved.expectedHash) {
      receipt(jobId, destination.targetId, row => ({ ...row, modelReady: true }));
      return client;
    }
    if (saved.branchVerified && !saved.modelReady) {
      result(jobId, destination, { status: 'waiting_approval', stage: 'Waiting for the reviewed model additions',
        branchId: saved.branchId, branchName: saved.branchName,
        message: 'Review and merge this exact branch in Omni, then choose Recheck / continue. No dashboard has been imported.' });
      return null;
    }
    throw new Error('The verified destination model changed. Stop and review before resuming this package.');
  }
  const prepared = await prepareDashboardPackageTarget(intent, destination, sources);
  if (prepared.preview.issues.length || prepared.preview.fingerprint !== intent.deployment!.packageCopy!.targetFingerprints[destination.targetId]) {
    throw new Error('The destination package changed after approval. Recheck its differences before deploying.');
  }
  if (!saved) {
    receipt(jobId, destination.targetId, () => ({ fingerprint: prepared.preview.fingerprint,
      baselineHash: packageHash(prepared.snapshot.files), imports: {} }));
    saved = receiptMap(current(jobId))[destination.targetId];
  }
  const files = branchFiles(prepared);
  if (!files.length) {
    receipt(jobId, destination.targetId, row => ({ ...row, modelReady: true, expectedHash: packageHash(snapshot.files) }));
    return client;
  }
  result(jobId, destination, { stage: 'Preparing reviewed dependency additions' });
  // A previously started but incomplete branch is retained for inspection, never restarted blindly.
  if (saved.branchId) throw new Error('A partial dependency branch already exists. Review that retained branch before starting another copy.');
  const branchName = `omnikit-dashboard-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  receipt(jobId, destination.targetId, row => ({ ...row, branchName }));
  const branch = await write(jobId, intent, destination, sources.boundary, 'create_dependency_branch', async guard => {
    const created = await client.createModelBranch({ connectionId: destination.connectionId, baseModelId: destination.modelId, branchName }, guard);
    receipt(jobId, destination.targetId, row => ({ ...row, branchId: created.id, branchName: created.name }));
    const fresh = await readYaml(client, destination.modelId, { branchId: created.id, mode: 'combined', fullyResolved: false, includeChecksums: true });
    if (packageHash(fresh.files) !== saved.baselineHash) throw new Error('The new review branch differs from the approved baseline.');
    return created;
  });
  result(jobId, destination, { branchId: branch.id, branchName: branch.name });
  const expected = { ...prepared.snapshot.files };
  const writtenFiles: ReturnType<typeof branchFiles> = [];
  // The branch is isolated; existing files always use the freshest server checksum.
  for (const file of files) {
    const fresh = await readYaml(client, destination.modelId, { branchId: branch.id, mode: 'combined', fullyResolved: false, includeChecksums: true });
    if (packageHash(fresh.files) !== packageHash(expected)) throw new Error('The review branch changed concurrently.');
    if (file.before !== null && !fresh.checksums?.[file.fileName]) throw new Error('An existing dependency file has no conflict checksum.');
    await write(jobId, intent, destination, sources.boundary, `write_dependency:${file.fileName}`, async guard => {
      await client.updateModelYamlFile({ modelId: destination.modelId, branchId: branch.id, fileName: file.fileName,
        yaml: file.proposed, previousChecksum: fresh.checksums?.[file.fileName], commitMessage: 'Reviewed dashboard dependency additions' }, guard);
      expected[file.fileName] = file.proposed;
      writtenFiles.push(file);
      const readback = await readYaml(client, destination.modelId, { branchId: branch.id, mode: 'combined', fullyResolved: false, includeChecksums: true });
      const comparison = compareTopicMigrationBranch({ files: writtenFiles, schemaMapText: '', baseline: prepared.snapshot.files, actual: readback.files });
      if (!comparison.verified) throw new Error('A dependency write differs from the reviewed additions. Inspect the retained branch.');
      Object.assign(expected, readback.files);
    });
  }
  result(jobId, destination, { stage: 'Validating dependency branch' });
  const finalBranch = await readYaml(client, destination.modelId, { branchId: branch.id, mode: 'combined', fullyResolved: false, includeChecksums: true });
  const comparison = compareTopicMigrationBranch({ files, schemaMapText: '', baseline: prepared.snapshot.files, actual: finalBranch.files });
  if (!comparison.verified) throw new Error('The branch includes changes beyond the approved additions.');
  const expectedHash = packageHash(finalBranch.files);
  const validation = await validateTopicCorrectionBranch(client, destination.modelId, branch.id, `sha256:${expectedHash}`, 'model');
  if (validation.status !== 'passed' || validation.issues.length) throw new Error('The dependency branch did not pass native model validation. Review it in Omni; no dashboard was imported.');
  const afterValidation = await readYaml(client, destination.modelId, { branchId: branch.id, mode: 'combined', fullyResolved: false, includeChecksums: true });
  if (packageHash(afterValidation.files) !== expectedHash) throw new Error('The review branch changed during validation.');
  receipt(jobId, destination.targetId, row => ({ ...row, expectedHash, branchVerified: true }));
  if (prepared.preview.requiresPr) {
    result(jobId, destination, { status: 'waiting_approval', stage: 'Repository approval required',
      message: 'The reviewed additions are saved on the branch. Complete its normal approval and merge in Omni, then Recheck / continue.' });
    return null;
  }
  result(jobId, destination, { stage: 'Publishing reviewed dependency additions' });
  const live = await readYaml(client, destination.modelId, { mode: 'combined', fullyResolved: false, includeChecksums: true });
  if (packageHash(live.files) !== saved.baselineHash) throw new Error('The destination changed before merge. Review the branch in Omni.');
  await write(jobId, intent, destination, sources.boundary, 'merge_dependency_branch', async guard => {
    await client.mergeModelBranch(destination.modelId, branch.name, { deleteBranch: false, publishDrafts: false, forceOverrideGitSettings: false }, guard);
    const merged = await readYaml(client, destination.modelId, { mode: 'combined', fullyResolved: false, includeChecksums: true });
    if (packageHash(merged.files) !== expectedHash) throw new Error('The branch merge is not verified. Reconcile it before continuing.');
    receipt(jobId, destination.targetId, row => ({ ...row, modelReady: true }));
  });
  return client;
}
async function copyDocument(jobId: string, intent: DashboardSafeCopyIntent, destination: DashboardSafeCopyDestination,
  sources: Awaited<ReturnType<typeof collectDashboardPackages>>, pkg: DashboardPackage, client: OmniClient) {
  const targetId = destination.targetId;
  let row = importRow(jobId, targetId, pkg.documentId);
  if (row?.verified) return;
  const inventory = await client.listDocumentInventory({ folderId: destination.folderId });
  if (!inventory.pagination.complete) throw new Error('The destination document inventory is incomplete.');
  if (!row) {
    row = { sourceDocumentId: pkg.documentId, identifier: randomUUID().replace(/-/g, '').slice(0, 12),
      name: allocateDashboardSafeCopyName(pkg.name, inventory.documents.map(document => document.name)) };
    row.nameHash = packageHash(row.name);
    saveImport(jobId, targetId, row);
  } else {
    const observedName = row.imported
      ? inventory.documents.find(document => document.identifier === row.identifier && document.documentId === row.documentId)?.name
      : allocateDashboardSafeCopyName(pkg.name, inventory.documents.map(document => document.name));
    if (!observedName || (row.nameHash ? packageHash(observedName) !== row.nameHash : observedName !== row.name)) {
      throw new Error('The retained copy name changed. Review the existing document before continuing.');
    }
    // Recover exact display text only from a fresh artifact matched to its typed
    // digest; the durable human-readable name remains privacy-redacted.
    row = { ...row, name: observedName };
  }
  const binding = { modelId: destination.modelId, connectionId: destination.connectionId,
    name: row.name, identifier: row.identifier, folderPath: destination.folderPath };
  const verifyPlacement = async () => {
    await verifyImportedPlacement(client, destination, row);
  };
  if (!row.imported) {
    if (inventory.documents.some(document => document.identifier === row.identifier)) throw new Error('The intended document identifier already exists. Reconcile it instead of importing again.');
    result(jobId, destination, { stage: `Copying ${pkg.name}` });
    const payload = retargetDashboardPackage(pkg, binding);
    await write(jobId, intent, destination, sources.boundary, `import:${pkg.documentId}`, async guard => {
      const imported = await client.importDocument({ exportPayload: payload, baseModelId: destination.modelId,
        folderPath: destination.folderPath, documentName: row.name, identifier: row.identifier }, guard);
      if (imported.identifier !== row.identifier || !imported.documentId) throw new Error('Import returned an unexpected document identity.');
      row = { ...row, imported: true, documentId: imported.documentId, miniUuidMap: imported.miniUuidMap || {} };
      saveImport(jobId, targetId, row);
      // The receipt is durable before verification; never repeat this import after a crash.
      await verifyPlacement();
    });
  }
  await verifyPlacement();
  const imported = await client.exportDocument(row.identifier) as Record<string, unknown>;
  const content = verifyDashboardPackageContent(pkg, imported, row.miniUuidMap, binding);
  if (!content.verified) throw new Error(`The imported content requires review: ${content.findings.join(' ')}`);
  if (!row.localsVerified) {
    result(jobId, destination, { stage: `Restoring local definitions: ${pkg.name}` });
    const localReceipts = await restoreDashboardPackageLocals(pkg, imported, row.miniUuidMap || {}, client,
      { assertCanDispatch: () => assertAuthority(jobId, intent, sources.boundary) }, input =>
        write(jobId, intent, destination, sources.boundary, `restore_local:${input.modelId}:${input.fileName}`, async guard => {
          await client.updateModelYamlFile(input, guard);
          const observed = await readYaml(client, input.modelId, { mode: 'extension', fullyResolved: false, includeChecksums: true });
          if (observed.files[input.fileName] !== input.yaml) throw new Error('The local-file write is not verified.');
        }));
    if (localReceipts.length !== pkg.localModels.length) throw new Error('Local definition coverage is incomplete.');
    row = { ...row, localsVerified: true, contentVerified: true };
    saveImport(jobId, targetId, row);
  }
  result(jobId, destination, { stage: `Checking dashboard queries: ${pkg.name}` });
  const tiles = listDashboardPackageTiles(imported);
  // Every query is checked once with bounded waiting. Never store warehouse rows.
  for (const tile of tiles) {
    assertAuthority(jobId, intent, sources.boundary);
    await client.runQuery(tile.query, { maxWaitAttempts: 2, requireExplicitTerminalStatus: true });
  }
  const readback = await client.exportDocument(row.identifier) as Record<string, unknown>;
  const verified = verifyDashboardPackageContent(pkg, readback, row.miniUuidMap, binding);
  if (!verified.verified) throw new Error('The dashboard changed while its queries were checked.');
  // Omitting the write guard makes this a strictly read-only exact local check.
  const finalLocals = await restoreDashboardPackageLocals(pkg, readback, row.miniUuidMap || {}, client);
  if (finalLocals.length !== pkg.localModels.length) throw new Error('Final local-model verification is incomplete.');
  await verifyPlacement();
  const model = await readYaml(client, destination.modelId, { mode: 'combined', fullyResolved: false });
  if (packageHash(model.files) !== receiptMap(current(jobId))[targetId].expectedHash) throw new Error('The destination model changed during dashboard verification.');
  row = { ...row, queriesVerified: true, verified: true };
  saveImport(jobId, targetId, row);
  documentResult(jobId, destination, { sourceDocumentId: pkg.documentId, name: row.name,
    documentId: row.documentId, identifier: row.identifier, status: 'verified',
    url: new URL(`/dashboards/${encodeURIComponent(row.identifier)}`, getInstance(destination.instanceId)!.baseUrl).toString(),
    message: 'Content, local definitions, folder/model binding, and dashboard queries verified. Review the dashboard as its intended audience before sign-off.' });
}

/** Adapter on the existing dashboard job lifecycle, not a separate job engine. */
export async function runDashboardPackageJob(jobId: string, intent: DashboardSafeCopyIntent, onlyTargetId?: string): Promise<{ job: MigrationJob }> {
  if (active.has(jobId)) return { job: current(jobId) };
  const approval = intent.deployment?.packageCopy;
  if (!approval || approval.version !== 1 || !approval.confirmDependencies || !approval.confirmDestinationAudience) throw new Error('A reviewed dashboard package approval is required.');
  if (current(jobId).status === 'canceled') return { job: current(jobId) };
  active.add(jobId);
  try {
    save(jobId, job => ({ ...job, status: 'running', startedAt: job.startedAt || Date.now(), endedAt: undefined,
      details: { ...job.details, safeCopyPreparationState: 'ready', dashboardPackageResults: targetResults(job) } }));
    const sources = await collectDashboardPackages(intent);
    expectedSource(intent, sources);
    for (const destination of intent.destinations.filter(row => !onlyTargetId || row.targetId === onlyTargetId)) {
      const previous = targetResults(current(jobId)).find(row => row.targetId === destination.targetId);
      if (previous?.status === 'verified') continue;
      let release: (() => void) | undefined;
      try {
        assertAuthority(jobId, intent, sources.boundary);
        if (unresolved(current(jobId), destination.targetId)) {
          result(jobId, destination, { status: 'uncertain', stage: 'Reconciliation required',
            message: 'A previous dispatched write has an unknown outcome. Inspect the retained branch/document before attempting another copy. No write was repeated.' });
          continue;
        }
        const scopes = destinationScopes(destination);
        if (hasUnresolvedMigrationDestinationModelMutation(listJobs(Number.MAX_SAFE_INTEGER), scopes)) throw new Error('Another migration has an unresolved write for this model. Reconcile it first.');
        release = reserveMigrationDestinationModels(`dashboard-package:${jobId}`, scopes);
        result(jobId, destination, { status: 'needs_review', stage: 'Rechecking approved package', message: undefined });
        const client = await ensureSharedModel(jobId, intent, destination, sources);
        if (!client) continue;
        for (const pkg of sources.packages) {
          try { await copyDocument(jobId, intent, destination, sources, pkg, client); }
          catch (error) {
            const imported = importRow(jobId, destination.targetId, pkg.documentId);
            documentResult(jobId, destination, { sourceDocumentId: pkg.documentId, name: imported?.name || pkg.name,
              identifier: imported?.identifier, documentId: imported?.documentId,
              status: unresolved(current(jobId), destination.targetId) ? 'uncertain' : imported?.imported ? 'needs_review' : 'failed',
              message: redactSensitiveText(error instanceof Error ? error.message : 'Dashboard verification stopped.') });
            throw error;
          }
        }
        result(jobId, destination, { status: 'verified', stage: 'Copy verified', message: 'All selected dashboards and their dependencies were verified. Audience acceptance remains a human review.' });
      } catch (error) {
        result(jobId, destination, { status: unresolved(current(jobId), destination.targetId) ? 'uncertain' : 'needs_review', stage: 'Review required',
          message: redactSensitiveText(error instanceof Error ? error.message : 'Dashboard deployment stopped safely.') });
      } finally { release?.(); }
    }
    return { job: save(jobId, job => {
      if (job.status === 'canceled') return job;
      const results = targetResults(job);
      const complete = results.length === intent.destinations.length && results.every(row => row.status === 'verified'
        && row.documents.length === intent.source.documentIds.length && row.documents.every(document => document.status === 'verified'));
      return { ...job, status: complete ? 'succeeded' : results.some(row => row.documents.some(document => document.status === 'verified')) ? 'partial' : 'failed',
        endedAt: Date.now(), details: { ...job.details, safeCopyExecutionState: complete ? 'complete' : 'review_required' } };
    }) };
  } catch (error) {
    for (const destination of intent.destinations.filter(row => !onlyTargetId || row.targetId === onlyTargetId)) {
      if (targetResults(current(jobId)).find(row => row.targetId === destination.targetId)?.status === 'verified') continue;
      result(jobId, destination, { status: 'needs_review', stage: 'Preflight stopped', message: redactSensitiveText(error instanceof Error ? error.message : 'The approved package is unavailable.') });
    }
    return { job: save(jobId, job => job.status === 'canceled' ? job : { ...job, status: 'failed', endedAt: Date.now() }) };
  } finally { active.delete(jobId); }
}
