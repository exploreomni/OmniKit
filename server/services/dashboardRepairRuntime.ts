import type { MigrationJob, ModelMigrationJobInput } from './migrationJobs';
import type { OmniClient } from './omniClient';
import { dashboardRepairSnapshotHash } from './dashboardRepairApproval';
import { assertDashboardRepairYamlPreservesTarget } from './dashboardRepairYaml';
import { getInstance } from './nativeVault';
import { assertDashboardTopicRelationInventory, readDashboardTopicRelationInventory } from './dashboardTopicRelationInventory';
import type { DashboardDeploymentPlan } from '../../shared/dashboardDeploymentPlan';
import { dashboardWorkbookHasAuthoredDefinitions } from './dashboardWorkbookCopy';

export interface DashboardRepairSourceBinding {
  instanceBoundaryHash: string;
  sourceDocumentHashes: Record<string, string>;
  sourceWorkbookHashes: Record<string, string>;
}

function reviewRequired(message: string): never {
  throw Object.assign(new Error(`${message} Prepare and approve fresh differences.`), { statusCode: 409 });
}

function validHashes(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length
    && Object.entries(value).every(([id, hash]) => id.trim() === id && Boolean(id) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)));
}

/** Saved aliases do not make a source model a safe write destination. */
export function dashboardRepairInstanceBoundaryHash(sourceId: string, targetId: string, targetModelId: string, sourceModelIds: string[]): string {
  const from = getInstance(sourceId);
  const to = getInstance(targetId);
  if (!from || !to || !['source', 'both'].includes(from.role) || !['destination', 'both'].includes(to.role)) {
    reviewRequired('The saved repair instances are unavailable or no longer authorized.');
  }
  let sameOrigin: boolean;
  try { sameOrigin = new URL(from.baseUrl).origin === new URL(to.baseUrl).origin; }
  catch { return reviewRequired('The saved repair instance origins could not be verified.'); }
  if (!targetModelId || !sourceModelIds.length || (sameOrigin && sourceModelIds.includes(targetModelId))) {
    reviewRequired('A dependency repair must not modify a source model, including through another saved instance alias.');
  }
  return dashboardRepairSnapshotHash([from.id, from.baseUrl, from.apiKey, from.role, to.id, to.baseUrl, to.apiKey, to.role]);
}

/** Fresh authoritative reads shared by ordinary preview/submit and every repair dispatch. */
export async function readDashboardRepairSourceBinding(input: {
  sourceId: string; targetId: string; targetModelId: string; sourceModelIds: string[];
  instanceBoundaryHash: string; sourceDocumentHashes: Record<string, string>;
  sourceWorkbookHashes?: Record<string, string>;
  reviewedWorkbookCopies?: DashboardDeploymentPlan['workbookCopies'];
}, source: Pick<OmniClient, 'getDocumentStateV2' | 'getModelYaml'>): Promise<DashboardRepairSourceBinding> {
  const checkBoundary = () => {
    if (dashboardRepairInstanceBoundaryHash(input.sourceId, input.targetId, input.targetModelId, input.sourceModelIds) !== input.instanceBoundaryHash) {
      reviewRequired('A saved instance changed after approval.');
    }
  };
  checkBoundary();
  if (!validHashes(input.sourceDocumentHashes) || (input.sourceWorkbookHashes !== undefined && !validHashes(input.sourceWorkbookHashes))) {
    reviewRequired('The repair is missing verified dashboard or workbook binding evidence.');
  }
  const sourceWorkbookHashes: Record<string, string> = {};
  const workbookFiles = new Map<string, Record<string, string>>();
  for (const [id, expected] of Object.entries(input.sourceDocumentHashes)) {
    const state = await source.getDocumentStateV2(id);
    if (dashboardRepairSnapshotHash(state) !== expected) reviewRequired('The source dashboard changed after approval.');
    if (typeof state.modelId !== 'string' || !input.sourceModelIds.includes(state.modelId)
      || typeof state.workbookModelId !== 'string' || !state.workbookModelId.trim() || state.workbookModelId === state.modelId) {
      reviewRequired('The source dashboard shared-model or workbook binding is unavailable.');
    }
    const workbookId = state.workbookModelId;
    if (!workbookFiles.has(workbookId)) {
      const current = await source.getModelYaml(workbookId, { mode: 'extension', fullyResolved: false });
      workbookFiles.set(workbookId, current.files);
      sourceWorkbookHashes[workbookId] = dashboardRepairSnapshotHash(current.files);
    }
    if (input.reviewedWorkbookCopies !== undefined) {
      const reviewed = input.reviewedWorkbookCopies[id];
      if (reviewed ? reviewed.sourceWorkbookModelId !== workbookId || reviewed.sourceSharedModelId !== state.modelId
        || reviewed.authoredModelHash !== sourceWorkbookHashes[workbookId]
        : dashboardWorkbookHasAuthoredDefinitions(workbookFiles.get(workbookId)!)) {
        reviewRequired('The source workbook changed since dashboard readiness. Recheck the dashboard plan.');
      }
    }
  }
  if (input.sourceWorkbookHashes !== undefined
    && dashboardRepairSnapshotHash(input.sourceWorkbookHashes) !== dashboardRepairSnapshotHash(sourceWorkbookHashes)) {
    reviewRequired('The source workbook changed after approval or its binding evidence is incomplete.');
  }
  checkBoundary();
  return { instanceBoundaryHash: input.instanceBoundaryHash, sourceDocumentHashes: { ...input.sourceDocumentHashes }, sourceWorkbookHashes };
}

/** Enforce the review again at dispatch, not just in the browser or HTTP handler. */
export async function assertAdditiveDashboardRepairDispatch(job: MigrationJob, targetModelId: string, source: OmniClient, target: OmniClient,
  options: { branchId?: string; beforeMerge?: boolean } = {}): Promise<void> {
  const repair = job.details?.dashboardRepair as ModelMigrationJobInput['dashboardRepair'];
  if (!repair) return;
  if (repair.additiveOnly !== true || !repair.targetModelHash || !repair.approvedFilesHash || !validHashes(repair.sourceModelHashes)
    || !repair.instanceBoundaryHash || !validHashes(repair.sourceDocumentHashes) || !validHashes(repair.sourceWorkbookHashes)) {
    reviewRequired('This repair predates complete source and instance-bound diff approval.');
  }
  if (job.destinationIds.length !== 1 || dashboardRepairInstanceBoundaryHash(job.sourceId, job.destinationIds[0], targetModelId, Object.keys(repair.sourceModelHashes)) !== repair.instanceBoundaryHash) {
    reviewRequired('A saved instance changed after approval.');
  }
  const writes = job.items.filter((item) => item.kind === 'model_yaml_write').flatMap((item) => {
    if (!Array.isArray(item.details?.files)) throw new Error('Approved repair files are unavailable.');
    return item.details.files.map((value) => {
      const row = value as { fileName: string; yaml: string; previousChecksum?: string };
      return { fileName: row.fileName, yaml: row.yaml, previousChecksum: row.previousChecksum };
    });
  });
  if (dashboardRepairSnapshotHash(writes) !== repair.approvedFilesHash || writes.length !== new Set(writes.map((file) => file.fileName)).size) {
    throw new Error('The staged file set differs from the exact approved diff. A fresh review is required.');
  }
  const main = await target.getModelYaml(targetModelId, { includeChecksums: true, fullyResolved: false });
  if (dashboardRepairSnapshotHash(main.files) !== repair.targetModelHash) throw new Error('The destination changed after approval. No repair write or merge was authorized.');
  assertDashboardTopicRelationInventory(main.raw, repair.targetRelationEvidence || {}, 'Destination');
  // A previously absent view may appear only in the inherited index. Recheck
  // occupancy even when there were no inherited dependencies to reuse.
  if (repair.targetRelationInventoryHash
    && readDashboardTopicRelationInventory(main.raw).snapshotHash !== repair.targetRelationInventoryHash) {
    throw new Error('The destination view inventory changed after approval. Review fresh differences before adding views.');
  }
  if (Object.keys(repair.sourceRelationEvidence || {}).some((id) => !Object.hasOwn(repair.sourceModelHashes!, id))) {
    throw new Error('Inherited view evidence does not match an approved source model.');
  }
  for (const [modelId, expected] of Object.entries(repair.sourceModelHashes)) {
    const current = await source.getModelYaml(modelId, { includeChecksums: true, fullyResolved: false });
    if (dashboardRepairSnapshotHash(current.files) !== expected) throw new Error('The source changed after approval. Prepare a fresh repair review.');
    assertDashboardTopicRelationInventory(current.raw, repair.sourceRelationEvidence?.[modelId] || {}, 'Source');
    if (repair.sourceRelationInventoryHashes?.[modelId]
      && readDashboardTopicRelationInventory(current.raw).snapshotHash !== repair.sourceRelationInventoryHashes[modelId]) {
      throw new Error('The source view inventory changed after approval. Prepare fresh differences.');
    }
  }
  await readDashboardRepairSourceBinding({ sourceId: job.sourceId, targetId: job.destinationIds[0], targetModelId,
    sourceModelIds: Object.keys(repair.sourceModelHashes), instanceBoundaryHash: repair.instanceBoundaryHash,
    sourceDocumentHashes: repair.sourceDocumentHashes, sourceWorkbookHashes: repair.sourceWorkbookHashes }, source);
  for (const file of writes) {
    if (file.previousChecksum !== main.checksums?.[file.fileName]
      || (main.files[file.fileName] !== undefined && !file.previousChecksum)) throw new Error('The approved destination checksum is unavailable or changed.');
    assertDashboardRepairYamlPreservesTarget({ sourceYaml: file.yaml, targetYaml: main.files[file.fileName], acceptedYaml: file.yaml });
  }
  if (options.branchId) {
    const branch = await target.getModelYaml(targetModelId, { branchId: options.branchId, includeChecksums: true, fullyResolved: false });
    const expected = options.beforeMerge ? { ...main.files, ...Object.fromEntries(writes.map((file) => [file.fileName, file.yaml])) } : main.files;
    if (dashboardRepairSnapshotHash(branch.files) !== dashboardRepairSnapshotHash(expected)) throw new Error('The working branch does not match the approved additive diff. Review it before proceeding.');
  }
  if (dashboardRepairInstanceBoundaryHash(job.sourceId, job.destinationIds[0], targetModelId, Object.keys(repair.sourceModelHashes)) !== repair.instanceBoundaryHash) {
    reviewRequired('A saved instance changed after approval.');
  }
}
