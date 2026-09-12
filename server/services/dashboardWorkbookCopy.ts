import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { getDashboardWorkbookCopyCapability } from '../../shared/dashboardWorkbookCopyCapability';

export { getDashboardWorkbookCopyCapability } from '../../shared/dashboardWorkbookCopyCapability';

/** Only a provably empty YAML root is ignorable; unfamiliar or invalid content blocks. */
export function dashboardWorkbookHasAuthoredDefinitions(files: Record<string, string>): boolean {
  return Object.values(files).some((yaml) => {
    if (typeof yaml !== 'string' || yaml.length > 5_000_000) return true;
    try {
      const document = parseDocument(yaml);
      if (document.errors.length) return true;
      const root: unknown = document.toJS({ maxAliasCount: 100 });
      return root !== null && root !== undefined && !(typeof root === 'object' && !Array.isArray(root) && Object.keys(root).length === 0);
    } catch {
      return true;
    }
  });
}

export class DashboardWorkbookCopyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DashboardWorkbookCopyError';
  }
}

export function assertDashboardWorkbookCopyCapability(): never {
  const capability = getDashboardWorkbookCopyCapability();
  throw new DashboardWorkbookCopyError(capability.code, capability.message);
}

function hash(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => [key, stable(val)]))
      : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export type DashboardWorkbookCopyStage = 'placeholder_create' | 'draft_create' | 'workbook_write' | 'draft_patch' | 'publish' | 'deliver';
export interface DashboardWorkbookCopyArtifact {
  documentId: string;
  draftId?: string;
  workbookModelId?: string;
}

/** Persist only IDs/hashes and operation state, never source YAML or dashboard content. */
export interface DashboardWorkbookCopyAttempt {
  version: 1;
  copyId: string;
  planFingerprint: string;
  operationKey: string;
  stage: DashboardWorkbookCopyStage;
  state: 'dispatched' | 'verified' | 'uncertain';
  requestHash: string;
  artifact?: DashboardWorkbookCopyArtifact;
  fileName?: string;
  previousChecksum?: string;
}

export interface DashboardWorkbookCopyLifecycleInput {
  copyId: string;
  planFingerprint: string;
  sourceDocumentId: string;
  sourceWorkbookModelId: string;
  sourceSharedModelId: string;
  targetSharedModelId: string;
  stagingFolderId: string;
  finalFolderId: string;
  placeholderName: string;
  authoredFiles: Record<string, string>;
  authoredModelHash: string;
  expectedTargetSharedHash: string;
  content: Record<string, unknown>;
  expectedContentHash: string;
  publishPolicyHash: string;
}

export interface DashboardWorkbookCopyReadback extends DashboardWorkbookCopyArtifact {
  sharedModelId: string;
  folderId: string;
  /** A fresh named-draft read, not a published-document read, supplies this identity. */
  workbookModelId: string;
  authoredFiles: Record<string, string>;
  checksums: Record<string, string>;
  contentHash: string;
  published: boolean;
}

export type DashboardWorkbookCopyWrite =
  | { stage: 'placeholder_create'; modelId: string; folderId: string; name: string; queryPresentations: { data: Record<string, never>; order: never[] }; containers: never[] }
  | { stage: 'draft_create'; documentId: string; patch: Record<string, never> }
  | { stage: 'workbook_write'; documentId: string; draftId: string; modelId: string; mode: 'extension'; fileName: string; yaml: string; previousChecksum: string }
  | { stage: 'draft_patch'; documentId: string; draftId: string; content: Record<string, unknown> }
  | { stage: 'publish'; documentId: string; draftId: string; policyHash: string }
  | { stage: 'deliver'; documentId: string; folderId: string };

/**
 * Server-internal adapter contract. No production adapter is enabled. A caller or UI
 * boolean is not an ACL proof. The adapter must own an exclusive copy lease and must
 * implement every check with fresh authoritative reads; mocks prove sequencing only.
 */
export interface DashboardWorkbookCopyLifecycleAdapter {
  loadAttempts(copyId: string): Promise<DashboardWorkbookCopyAttempt[]>;
  persistAttempt(attempt: DashboardWorkbookCopyAttempt): Promise<void>;
  /** Reconcile exact IDs and request postconditions; an absent object is not proof of no write. */
  reconcile(attempt: DashboardWorkbookCopyAttempt): Promise<DashboardWorkbookCopyArtifact | undefined>;
  revalidateApproval(input: DashboardWorkbookCopyLifecycleInput, signal?: AbortSignal): Promise<void>;
  proveStagingAccess(folderId: string, signal?: AbortSignal): Promise<{
    folderId: string; complete: true; restriction: 'migration_operator_only'; effectiveAclHash: string;
  }>;
  readSharedModelHash(modelId: string, signal?: AbortSignal): Promise<string>;
  readArtifact(artifact: DashboardWorkbookCopyArtifact, signal?: AbortSignal): Promise<DashboardWorkbookCopyReadback>;
  /** The implementation must check the guard immediately before its actual network write. */
  dispatch(write: DashboardWorkbookCopyWrite, guard: { assertCanDispatch(): void; signal?: AbortSignal }): Promise<DashboardWorkbookCopyArtifact>;
  /** Run local queries in the bound draft workbook, and compare full content + authored files. */
  verifyDraft(artifact: Required<DashboardWorkbookCopyArtifact>, input: DashboardWorkbookCopyLifecycleInput, signal?: AbortSignal): Promise<{
    workbookModelId: string; contentHash: string; authoredModelHash: string; queriesPassed: boolean;
  }>;
  /** Must prove which draft will publish and that no unexpected user draft will be chosen. */
  provePublishPolicy(artifact: Required<DashboardWorkbookCopyArtifact>, signal?: AbortSignal): Promise<string>;
  verifyDelivered(artifact: DashboardWorkbookCopyArtifact, input: DashboardWorkbookCopyLifecycleInput, signal?: AbortSignal): Promise<boolean>;
}

/**
 * Guarded lifecycle primitive for a future reviewed server adapter. It is intentionally
 * NOT wired into the production safe-copy executor while the capability gate is closed.
 * Initial create is already published, but only final reread can return `verified`.
 */
export async function runDashboardWorkbookCopyLifecycle(
  input: DashboardWorkbookCopyLifecycleInput,
  adapter: DashboardWorkbookCopyLifecycleAdapter,
  guard: { assertCanDispatch(): void; signal?: AbortSignal },
): Promise<{ status: 'verified'; artifact: DashboardWorkbookCopyArtifact }> {
  function stop(message: string): never { throw new DashboardWorkbookCopyError('WORKBOOK_COPY_REQUIRES_REVIEW', message); }
  const assertGuard = () => {
    if (guard.signal?.aborted) stop('Workbook copy was canceled. Retain any staging artifact for reconciliation.');
    guard.assertCanDispatch();
  };
  if (!input.copyId || !input.planFingerprint || input.stagingFolderId === input.finalFolderId
    || input.sourceWorkbookModelId === input.sourceSharedModelId
    || input.sourceWorkbookModelId === input.targetSharedModelId
    || hash(input.authoredFiles) !== input.authoredModelHash || hash(input.content) !== input.expectedContentHash) {
    stop('The immutable workbook copy scope or authored evidence is invalid.');
  }
  if (!Object.keys(input.authoredFiles).length || Object.entries(input.authoredFiles).some(([fileName, yaml]) => (
    !fileName || fileName.includes('\\') || fileName.startsWith('/') || fileName.split('/').some((part) => ['', '.', '..'].includes(part))
    || typeof yaml !== 'string' || !yaml.trim()
  ))) stop('Workbook copy requires non-empty authored files; deletion and shared promotion are not supported.');
  const planFingerprint = hash(input);
  const loaded = await adapter.loadAttempts(input.copyId);
  if (loaded.length > Object.keys(input.authoredFiles).length + 5
    || loaded.some((attempt) => attempt.version !== 1 || attempt.copyId !== input.copyId || attempt.planFingerprint !== planFingerprint)
    || new Set(loaded.map((attempt) => attempt.operationKey)).size !== loaded.length) {
    stop('Persisted workbook copy evidence no longer matches this approved scope.');
  }
  const attempts = new Map(loaded.map((attempt) => [attempt.operationKey, attempt]));
  const expectedOrder = ['placeholder_create:', 'draft_create:',
    ...Object.keys(input.authoredFiles).sort().map((name) => `workbook_write:${name}`),
    'draft_patch:', 'publish:', 'deliver:'];
  if (loaded.some((attempt, index) => attempt.operationKey !== expectedOrder[index]
    || (index < loaded.length - 1 && attempt.state !== 'verified'))) {
    stop('Persisted stage evidence is not an ordered, verified prefix of this workbook copy.');
  }
  const freshBoundary = async () => {
    assertGuard();
    await adapter.revalidateApproval(input, guard.signal);
    const acl = await adapter.proveStagingAccess(input.stagingFolderId, guard.signal);
    if (acl.folderId !== input.stagingFolderId || acl.complete !== true
      || acl.restriction !== 'migration_operator_only' || !/^[a-f0-9]{64}$/.test(acl.effectiveAclHash)) {
      stop('The full effective staging-folder ACL is not proven access-restricted. No further writes are allowed.');
    }
    if (await adapter.readSharedModelHash(input.targetSharedModelId, guard.signal) !== input.expectedTargetSharedHash) {
      stop('The shared target model changed. Retain the staged artifact and rerun compatibility checks.');
    }
    assertGuard();
  };
  const write = async (request: DashboardWorkbookCopyWrite, known?: DashboardWorkbookCopyArtifact): Promise<DashboardWorkbookCopyArtifact> => {
    const operationKey = `${request.stage}:${request.stage === 'workbook_write' ? request.fileName : ''}`;
    const requestHash = hash(request);
    const previous = attempts.get(operationKey);
    const assertIdentity = (artifact: DashboardWorkbookCopyArtifact, expected = known) => {
      if (!artifact.documentId || (expected && artifact.documentId !== expected.documentId)
        || (expected?.draftId && artifact.draftId !== expected.draftId)
        || (request.stage !== 'draft_create' && expected?.workbookModelId && artifact.workbookModelId !== expected.workbookModelId)) {
        stop('The write response changed the exact staged artifact identity.');
      }
    };
    await freshBoundary();
    if (previous) {
      if (previous.requestHash !== requestHash) stop('The staged operation changed after its durable dispatch record.');
      const reconciled = await adapter.reconcile(previous);
      if (!reconciled) stop('A previous staged write is uncertain. Reconcile the exact artifact; never create a replacement or delete it automatically.');
      assertIdentity(reconciled, previous.artifact || known);
      await adapter.persistAttempt({ ...previous, artifact: reconciled, state: 'verified' });
      attempts.set(operationKey, { ...previous, artifact: reconciled, state: 'verified' });
      return reconciled;
    }
    let attempt: DashboardWorkbookCopyAttempt = {
      version: 1, copyId: input.copyId, planFingerprint, operationKey, stage: request.stage,
      state: 'dispatched', requestHash, ...(known ? { artifact: known } : {}),
      ...(request.stage === 'workbook_write' ? { fileName: request.fileName, previousChecksum: request.previousChecksum } : {}),
    };
    await adapter.persistAttempt(attempt);
    attempts.set(operationKey, attempt);
    // A canceled/deadlined operation stays recorded and is reconciled, never blindly retried.
    assertGuard();
    try {
      const result = await adapter.dispatch(request, { ...guard, assertCanDispatch: assertGuard });
      const artifact = { ...known, ...result };
      attempt = { ...attempt, artifact };
      await adapter.persistAttempt(attempt); // Retain returned IDs even if verification fails.
      assertIdentity(artifact);
      const reconciled = await adapter.reconcile(attempt);
      if (!reconciled) stop('The staged write returned without a verified postcondition. Retain the artifact for review.');
      assertIdentity(reconciled, artifact);
      await adapter.persistAttempt({ ...attempt, artifact: reconciled, state: 'verified' });
      attempts.set(operationKey, { ...attempt, artifact: reconciled, state: 'verified' });
      return reconciled;
    } catch (error) {
      await adapter.persistAttempt({ ...attempt, state: 'uncertain' });
      throw error;
    }
  };
  const checkBinding = (state: DashboardWorkbookCopyReadback, artifact: DashboardWorkbookCopyArtifact, draft: boolean, folderId = input.stagingFolderId) => {
    if (state.documentId !== artifact.documentId || (draft && state.draftId !== artifact.draftId)
      || state.sharedModelId !== input.targetSharedModelId || state.folderId !== folderId
      || !state.workbookModelId || [input.targetSharedModelId, input.sourceSharedModelId, input.sourceWorkbookModelId].includes(state.workbookModelId)
      || (artifact.workbookModelId && state.workbookModelId !== artifact.workbookModelId)
      || (draft && state.published)) stop('The staged document or draft workbook binding could not be verified.');
  };
  const verifyFinal = async (artifact: DashboardWorkbookCopyArtifact) => {
    assertGuard();
    await adapter.revalidateApproval(input, guard.signal);
    const final = await adapter.readArtifact({ documentId: artifact.documentId }, guard.signal);
    checkBinding(final, { documentId: artifact.documentId }, false, input.finalFolderId);
    if (!final.published || final.contentHash !== input.expectedContentHash || hash(final.authoredFiles) !== input.authoredModelHash
      || !await adapter.verifyDelivered(artifact, input, guard.signal)
      || await adapter.readSharedModelHash(input.targetSharedModelId, guard.signal) !== input.expectedTargetSharedHash) {
      stop('Final delivery did not pass content, local query, access, and shared-model verification. Retain the artifact for review.');
    }
  };
  // Publishing can retire a draft; delivery changes its folder. Resume from the latest
  // exact late-stage receipt instead of pretending the earlier placeholder is unchanged.
  const late = attempts.get('deliver:') || attempts.get('publish:');
  if (late) {
    await freshBoundary();
    const artifact = await adapter.reconcile(late);
    if (!artifact?.documentId || artifact.documentId !== attempts.get('placeholder_create:')?.artifact?.documentId) {
      stop('The published or delivered artifact is uncertain. Retain it for exact reconciliation.');
    }
    const draftArtifact = attempts.get('draft_patch:')?.artifact;
    if (!draftArtifact?.draftId || !draftArtifact.workbookModelId) stop('The published draft binding is missing.');
    // Check immutable request hashes even for earlier stages that cannot be reread after publish.
    const requests: DashboardWorkbookCopyWrite[] = [
      { stage: 'placeholder_create', modelId: input.targetSharedModelId, folderId: input.stagingFolderId,
        name: input.placeholderName, queryPresentations: { data: {}, order: [] }, containers: [] },
      { stage: 'draft_create', documentId: artifact.documentId, patch: {} },
      ...Object.keys(input.authoredFiles).sort().map((fileName): DashboardWorkbookCopyWrite => ({
        stage: 'workbook_write', documentId: artifact.documentId, draftId: draftArtifact.draftId!,
        modelId: draftArtifact.workbookModelId!, mode: 'extension', fileName, yaml: input.authoredFiles[fileName],
        previousChecksum: attempts.get(`workbook_write:${fileName}`)?.previousChecksum || '',
      })),
      { stage: 'draft_patch', documentId: artifact.documentId, draftId: draftArtifact.draftId, content: input.content },
      { stage: 'publish', documentId: artifact.documentId, draftId: draftArtifact.draftId, policyHash: input.publishPolicyHash },
      { stage: 'deliver', documentId: artifact.documentId, folderId: input.finalFolderId },
    ];
    if (loaded.some((attempt, index) => attempt.requestHash !== hash(requests[index])
      || attempt.artifact?.documentId !== artifact.documentId)) stop('The resumed request or artifact IDs conflict with immutable evidence.');
    await adapter.persistAttempt({ ...late, artifact, state: 'verified' });
    if (late.stage === 'deliver') {
      await verifyFinal(artifact);
      return { status: 'verified', artifact };
    }
    const published = await adapter.readArtifact({ documentId: artifact.documentId }, guard.signal);
    checkBinding(published, { documentId: artifact.documentId }, false);
    if (!published.published || published.contentHash !== input.expectedContentHash
      || hash(published.authoredFiles) !== input.authoredModelHash) stop('Published staging content changed before final delivery.');
    const delivered = await write({ stage: 'deliver', documentId: artifact.documentId, folderId: input.finalFolderId }, artifact);
    await verifyFinal(delivered);
    return { status: 'verified', artifact: delivered };
  }
  let artifact = await write({
    stage: 'placeholder_create', modelId: input.targetSharedModelId, folderId: input.stagingFolderId,
    name: input.placeholderName, queryPresentations: { data: {}, order: [] }, containers: [],
  });
  const published = await adapter.readArtifact(artifact, guard.signal);
  checkBinding(published, artifact, false);
  artifact = await write({ stage: 'draft_create', documentId: artifact.documentId, patch: {} }, artifact);
  if (!artifact.draftId) stop('The draft create did not yield an exact draft ID.');
  let draft = await adapter.readArtifact(artifact, guard.signal);
  checkBinding(draft, artifact, true);
  if (draft.workbookModelId === published.workbookModelId) stop('The draft workbook must be distinct from the published workbook.');
  artifact = { documentId: artifact.documentId, draftId: artifact.draftId, workbookModelId: draft.workbookModelId };
  for (const fileName of Object.keys(input.authoredFiles).sort()) {
    const previous = attempts.get(`workbook_write:${fileName}`);
    // A restart uses the original checksum, not the checksum produced by its own write.
    const previousChecksum = previous?.previousChecksum || draft.checksums[fileName];
    if (!previousChecksum) stop('A checksum for the destination workbook file is unavailable; unprotected new-file writes are blocked.');
    artifact = await write({
      stage: 'workbook_write', documentId: artifact.documentId, draftId: artifact.draftId!,
      modelId: artifact.workbookModelId!, mode: 'extension', fileName,
      yaml: input.authoredFiles[fileName], previousChecksum,
    }, artifact);
    draft = await adapter.readArtifact(artifact, guard.signal);
    checkBinding(draft, artifact, true);
    if (draft.authoredFiles[fileName] !== input.authoredFiles[fileName]) stop('Authored workbook YAML did not round-trip exactly.');
  }
  if (hash(draft.authoredFiles) !== input.authoredModelHash) stop('The destination workbook has missing or unexpected authored definitions.');
  artifact = await write({ stage: 'draft_patch', documentId: artifact.documentId, draftId: artifact.draftId!, content: input.content }, artifact);
  const boundArtifact = artifact as Required<DashboardWorkbookCopyArtifact>;
  const proof = await adapter.verifyDraft(boundArtifact, input, guard.signal);
  if (!proof.queriesPassed || proof.workbookModelId !== artifact.workbookModelId
    || proof.contentHash !== input.expectedContentHash || proof.authoredModelHash !== input.authoredModelHash) {
    stop('Draft local queries, content, or authored YAML failed verification. The staging artifact is retained.');
  }
  await freshBoundary();
  if (await adapter.provePublishPolicy(boundArtifact, guard.signal) !== input.publishPolicyHash) stop('The named draft or publish policy changed.');
  artifact = await write({ stage: 'publish', documentId: artifact.documentId, draftId: artifact.draftId!, policyHash: input.publishPolicyHash }, artifact);
  const publishedCopy = await adapter.readArtifact({ documentId: artifact.documentId }, guard.signal);
  checkBinding(publishedCopy, { documentId: artifact.documentId }, false);
  if (!publishedCopy.published || publishedCopy.contentHash !== input.expectedContentHash
    || hash(publishedCopy.authoredFiles) !== input.authoredModelHash) stop('Published staging content failed reread. Final delivery is blocked.');
  artifact = await write({ stage: 'deliver', documentId: artifact.documentId, folderId: input.finalFolderId }, artifact);
  await verifyFinal(artifact);
  return { status: 'verified', artifact };
}
