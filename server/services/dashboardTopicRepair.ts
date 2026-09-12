import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import type { DashboardDeploymentPlan } from '../../shared/dashboardDeploymentPlan';
import type { DashboardTopicRelationEvidence, DashboardTopicRepairPreview } from '../../shared/dashboardTopicRepair';
import { DashboardSafeCopyError } from '../../shared/dashboardSafeCopyContract';
import { buildDashboardTopicRepairDraft } from './dashboardTopicRepairDraft';
import { getDashboardDeploymentPlan, withDashboardTopicRepairSubmission } from './dashboardDeploymentPlans';
import { assertDashboardRepairYamlPreservesTarget } from './dashboardRepairYaml';
import { dashboardSafeCopyStateHash } from './dashboardSafeCopyRuntime';
import { assertDashboardSafeCopyInstanceRoles } from './dashboardSafeCopyJobs';
import { createModelMigrationJob } from './migrationJobs';
import { getInstance } from './nativeVault';
import { OmniClient } from './omniClient';
import { readDashboardTopicRelationInventory, dashboardTopicInventoryDiagnostics, dashboardTopicRelationEvidence } from './dashboardTopicRelationInventory';

const TTL = 15 * 60_000;
const previews = new Map<string, { preview: DashboardTopicRepairPreview; planId: string; sourceModelId: string;
  sourceHash: string; targetHash: string; credentialsHash: string; documentHashes: Record<string, string>; workbookHashes: Record<string, string>; checksums: Record<string, string>; relationEvidence: DashboardTopicRelationEvidence }>();
function conflict(message: string): never { throw new DashboardSafeCopyError('SAFE_COPY_SCOPE_CONFLICT', message, 409); }
function text(value: unknown, label: string): string {
  // eslint-disable-next-line no-control-regex -- Deliberately reject ASCII control characters in approval identifiers.
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) conflict(`${label} is required.`);
  return value;
}
function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) conflict('The topic review request is invalid.');
  return value as Record<string, unknown>;
}
export function dashboardTopicDefinitionHash(yaml: string): string {
  const doc = parseDocument(yaml, { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) conflict('Topic YAML could not be verified.');
  return dashboardSafeCopyStateHash(doc.toJS({ maxAliasCount: 0 }));
}
function scope(plan: DashboardDeploymentPlan, revision: unknown, targetId: string) {
  if (!Number.isSafeInteger(revision) || plan.revision !== revision) conflict('The plan changed. Prepare the topic differences again.');
  if (plan.readinessRun?.status !== 'complete') conflict('Complete a readiness check before preparing a topic repair.');
  assertDashboardSafeCopyInstanceRoles(plan.intent);
  const target = plan.targets.find((row) => row.targetId === targetId);
  const destination = plan.intent.destinations.find((row) => row.targetId === targetId);
  if (!target || !destination || !target.modelHash || target.repairJobId || target.deploymentJobId) conflict('This destination is unavailable or already has a submitted job.');
  const source = getInstance(plan.intent.source.instanceId)!;
  const dest = getInstance(destination.instanceId)!;
  return { target, destination, source, dest, credentialsHash: dashboardSafeCopyStateHash([
    source.id, source.baseUrl, source.apiKey, source.role, dest.id, dest.baseUrl, dest.apiKey, dest.role,
  ]) };
}
async function readEvidence(plan: DashboardDeploymentPlan, revision: unknown, targetId: string, sourceTopicName: string, signal?: AbortSignal) {
  const selected = scope(plan, revision, targetId);
  const choice = selected.target.topicChoices?.find((row) => row.sourceTopicName === sourceTopicName);
  if (!choice?.documentIds.length || choice.documentIds.some((id) => !plan.intent.source.documentIds.includes(id))) conflict('Choose a missing topic from the current dashboard review.');
  const sourceClient = new OmniClient(selected.source, { signal });
  const targetClient = new OmniClient(selected.dest, { signal });
  const states: Record<string, unknown>[] = [];
  const documentHashes: Record<string, string> = {};
  for (const id of choice.documentIds) {
    const state = await sourceClient.getDocumentStateV2(id);
    if (dashboardSafeCopyStateHash(state) !== plan.sourceHashes[id]) conflict('The source dashboard changed. Recheck readiness before preparing this repair.');
    states.push({ ...state });
    documentHashes[id] = plan.sourceHashes[id];
  }
  const modelIds = [...new Set(states.map((state) => state.modelId).filter((id): id is string => typeof id === 'string' && Boolean(id)))];
  if (modelIds.length !== 1 || states.some((state) => state.modelId !== modelIds[0]) || !selected.target.sourceModelIds.includes(modelIds[0])) conflict('This topic spans unavailable or conflicting source models. Review each source independently.');
  const sourceModelId = modelIds[0];
  if (new URL(selected.source.baseUrl).origin === new URL(selected.dest.baseUrl).origin
    && sourceModelId === selected.destination.modelId) conflict('A topic repair must not modify the source model, including through another saved connection.');
  const verifyModel = async (client: OmniClient, modelId: string, connectionId: string) => {
    let models = await client.listModels({ modelId, connectionId, modelKind: 'SHARED' });
    if (!models.some((model) => model.id === modelId)) models = await client.listModels({ modelId, connectionId, modelKind: 'SHARED_EXTENSION' });
    const matches = models.filter((model) => model.id === modelId);
    if (matches.length !== 1 || matches[0].connectionId !== connectionId || matches[0].deletedAt) conflict('The model connection binding is unavailable or changed. Recheck readiness.');
    return matches[0];
  };
  const [, targetModel] = await Promise.all([
    verifyModel(sourceClient, sourceModelId, plan.intent.source.connectionId),
    verifyModel(targetClient, selected.destination.modelId, selected.destination.connectionId),
  ]);
  const [sourceYaml, targetYaml] = await Promise.all([
    sourceClient.getModelYaml(sourceModelId, { includeChecksums: true, fullyResolved: false }),
    targetClient.getModelYaml(selected.destination.modelId, { includeChecksums: true, fullyResolved: false }),
  ]);
  const sourceHash = dashboardSafeCopyStateHash(sourceYaml.files);
  const targetHash = dashboardSafeCopyStateHash(targetYaml.files);
  if (sourceHash !== plan.sourceModelHashes[sourceModelId] || targetHash !== selected.target.modelHash) conflict('A source or destination model changed. Recheck readiness and review fresh differences.');
  // The workbook extension is read separately; never promote local definitions into the shared model.
  const workbookHashes: Record<string, string> = {};
  for (const state of states) {
    if (typeof state.workbookModelId !== 'string' || !state.workbookModelId) conflict('The source workbook scope is unavailable.');
    const workbook = await sourceClient.getModelYaml(state.workbookModelId, { mode: 'extension', fullyResolved: false });
    state.__topicRepairWorkbookFiles = workbook.files;
    workbookHashes[state.workbookModelId] = dashboardSafeCopyStateHash(workbook.files);
  }
  signal?.throwIfAborted();
  if (scope(getDashboardDeploymentPlan(plan.id), revision, targetId).credentialsHash !== selected.credentialsHash) conflict('A saved instance changed. Prepare a fresh review.');
  return { ...selected, sourceModelId, targetModel, sourceYaml, targetYaml, sourceHash, targetHash, states, documentHashes, workbookHashes,
    sourceRelations: readDashboardTopicRelationInventory(sourceYaml.raw), targetRelations: readDashboardTopicRelationInventory(targetYaml.raw) };
}

function inventoryDraftOptions(evidence: Awaited<ReturnType<typeof readEvidence>>) {
  return { sourceRelationNames: Object.keys(evidence.sourceRelations.fingerprints), targetRelationNames: Object.keys(evidence.targetRelations.fingerprints),
    sourceObservedRelationNames: evidence.sourceRelations.observedNames, targetObservedRelationNames: evidence.targetRelations.observedNames,
    sourceViewFileNames: evidence.sourceRelations.fileNames, targetViewFileNames: evidence.targetRelations.fileNames };
}
function attachInventoryDiagnostics(draft: ReturnType<typeof buildDashboardTopicRepairDraft>, evidence: Awaited<ReturnType<typeof readEvidence>>) {
  const names = [...draft.requiredViews, ...(draft.requiredInventoryNames || []), ...(draft.reusedRelations || [])];
  draft.inventoryDiagnostics = [...dashboardTopicInventoryDiagnostics(evidence.sourceRelations, names, 'source'),
    ...dashboardTopicInventoryDiagnostics(evidence.targetRelations, names, 'destination')];
  // The server enforces the same blockers even if a client omits the diagnostic UI.
  for (const side of ['source', 'destination'] as const) if (draft.inventoryDiagnostics.some((row) => row.side === side && row.severity === 'blocker')) {
    draft.blockers.push(`${side === 'source' ? 'Source' : 'Destination'} view inventory needs review. Resolve the blocking inventory diagnostics before approval.`);
  }
}

/** Read-only, bounded and ephemeral. No branch, job, or YAML write occurs here. */
export async function previewDashboardTopicRepair(planId: string, value: unknown, signal?: AbortSignal): Promise<DashboardTopicRepairPreview> {
  const input = body(value, ['revision', 'targetId', 'sourceTopicName', 'targetTopicName', 'baseView', 'selectedJoinPaths']);
  const targetId = text(input.targetId, 'Destination');
  const sourceTopicName = text(input.sourceTopicName, 'Source topic');
  const targetTopicName = text(input.targetTopicName, 'New topic name');
  const baseView = input.baseView === undefined ? undefined : text(input.baseView, 'Base view');
  let selectedJoinPaths: Record<string, string> | undefined;
  if (input.selectedJoinPaths !== undefined) {
    const selections = input.selectedJoinPaths;
    if (!selections || typeof selections !== 'object' || Array.isArray(selections) || Object.keys(selections).length > 100
      || Object.entries(selections).some(([view, id]) => !/^[A-Za-z_][\w/-]*$/.test(view) || view.length > 256
        || view.split('/').some((part) => !part || ['__proto__', 'constructor', 'prototype'].includes(part))
        || typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id))) conflict('Join-path selections must use bounded exact view names and IDs from the preview.');
    selectedJoinPaths = { ...selections } as Record<string, string>;
  }
  const plan = getDashboardDeploymentPlan(planId);
  const evidence = await readEvidence(plan, input.revision, targetId, sourceTopicName, signal);
  const draft = buildDashboardTopicRepairDraft({ sourceTopicName, targetTopicName, baseView, selectedJoinPaths,
    states: evidence.states, sourceFiles: evidence.sourceYaml.files, targetFiles: evidence.targetYaml.files,
    ...inventoryDraftOptions(evidence) });
  attachInventoryDiagnostics(draft, evidence);
  const relationEvidence = dashboardTopicRelationEvidence(draft.reusedRelations || [], evidence.sourceRelations.fingerprints, evidence.targetRelations.fingerprints);
  for (const file of draft.files) {
    if (file.original !== null && file.status !== 'unchanged' && !evidence.targetYaml.checksums?.[file.fileName]) draft.blockers.push(`No destination checksum is available for ${file.fileName}.`);
  }
  if (draft.files.length > 100 || JSON.stringify(draft).length > 2_000_000) conflict('The repair exceeds the bounded review size. Split this migration before reviewing.');
  const reviewId = randomUUID();
  const preview: DashboardTopicRepairPreview = { ...draft, reviewId, reviewHash: '', revision: plan.revision, targetId, expiresAt: Date.now() + TTL };
  preview.reviewHash = dashboardSafeCopyStateHash(preview);
  for (const [id, row] of previews) if (row.preview.expiresAt < Date.now()) previews.delete(id);
  if (previews.size >= 8) previews.delete(previews.keys().next().value!);
  previews.set(reviewId, { preview, planId, sourceModelId: evidence.sourceModelId, sourceHash: evidence.sourceHash,
    targetHash: evidence.targetHash, credentialsHash: evidence.credentialsHash, documentHashes: evidence.documentHashes,
    workbookHashes: evidence.workbookHashes,
    relationEvidence,
    checksums: evidence.targetYaml.checksums || {} });
  return structuredClone(preview);
}

/** Approves exactly the previously displayed diff; request payloads cannot supply replacement YAML. */
export async function approveDashboardTopicRepair(planId: string, value: unknown, dependencies: { createJob?: typeof createModelMigrationJob } = {}) {
  const input = body(value, ['revision', 'targetId', 'reviewId', 'reviewHash', 'confirmAdditiveOnly', 'confirmNewTopicSemantics']);
  const targetId = text(input.targetId, 'Destination');
  const reviewId = text(input.reviewId, 'Review');
  const cached = previews.get(reviewId);
  if (!cached || cached.planId !== planId || cached.preview.targetId !== targetId || cached.preview.revision !== input.revision
    || cached.preview.expiresAt < Date.now() || cached.preview.reviewHash !== input.reviewHash
    || input.confirmAdditiveOnly !== true || input.confirmNewTopicSemantics !== true) conflict('This approval is missing, expired, or does not match the reviewed differences. Prepare them again.');
  const preview = cached.preview;
  if (preview.blockers.length || preview.files.some((file) => file.status === 'conflict')) conflict('Resolve the displayed conflicts before approving additions.');
  const writes = preview.files.filter((file) => file.status === 'new' || file.status === 'additive');
  if (!writes.length) conflict('All definitions already exist. Recheck readiness instead.');
  return withDashboardTopicRepairSubmission(planId, preview.revision, targetId, async (plan) => {
    const evidence = await readEvidence(plan, preview.revision, targetId, preview.sourceTopicName);
    if (evidence.credentialsHash !== cached.credentialsHash || evidence.sourceHash !== cached.sourceHash || evidence.targetHash !== cached.targetHash
      || dashboardSafeCopyStateHash(evidence.documentHashes) !== dashboardSafeCopyStateHash(cached.documentHashes)
      || dashboardSafeCopyStateHash(evidence.workbookHashes) !== dashboardSafeCopyStateHash(cached.workbookHashes)) conflict('The reviewed evidence changed. Prepare fresh differences.');
    const refreshed = buildDashboardTopicRepairDraft({ sourceTopicName: preview.sourceTopicName, targetTopicName: preview.targetTopicName,
      baseView: preview.baseView, selectedJoinPaths: preview.selectedJoinPaths, states: evidence.states, sourceFiles: evidence.sourceYaml.files, targetFiles: evidence.targetYaml.files,
      ...inventoryDraftOptions(evidence) });
    attachInventoryDiagnostics(refreshed, evidence);
    if (refreshed.blockers.length || dashboardSafeCopyStateHash(refreshed.files) !== dashboardSafeCopyStateHash(preview.files)
      || dashboardSafeCopyStateHash(refreshed.joinPathChoices) !== dashboardSafeCopyStateHash(preview.joinPathChoices)
      || dashboardSafeCopyStateHash(refreshed.selectedJoinPaths) !== dashboardSafeCopyStateHash(preview.selectedJoinPaths)) conflict('The draft or selected join paths changed after review. Review them again before approval.');
    if (dashboardSafeCopyStateHash(dashboardTopicRelationEvidence(refreshed.reusedRelations || [], evidence.sourceRelations.fingerprints, evidence.targetRelations.fingerprints)) !== dashboardSafeCopyStateHash(cached.relationEvidence)) conflict('Inherited view evidence changed after review. Prepare fresh differences.');
    for (const file of writes) {
      if (evidence.targetYaml.files[file.fileName] !== (file.original ?? undefined)
        || evidence.targetYaml.checksums?.[file.fileName] !== cached.checksums[file.fileName]) conflict('A reviewed file changed. Prepare fresh differences.');
      assertDashboardRepairYamlPreservesTarget({ sourceYaml: file.proposed, targetYaml: file.original ?? undefined, acceptedYaml: file.proposed });
    }
    const topic = writes.find((file) => file.kind === 'topic');
    if (!topic) conflict('No new topic is included in this approval.');
    if (preview.expiresAt < Date.now()) conflict('The diff review expired while verifying current evidence. Prepare a fresh review.');
    // Consume before dispatch; an ambiguous request must not create duplicate branches/jobs.
    previews.delete(reviewId);
    const job = await (dependencies.createJob || createModelMigrationJob)({ sourceId: plan.intent.source.instanceId, targetId: evidence.destination.instanceId,
      models: [{ sourceModelId: evidence.sourceModelId, targetModelId: evidence.destination.modelId,
        targetConnectionId: evidence.destination.connectionId, mode: 'translate', branchName: `omnikit-topic-${reviewId.slice(0, 12)}`,
        mergeHandoffRequired: Boolean(evidence.targetModel.pullRequestRequired || evidence.targetModel.gitProtected || evidence.targetModel.gitFollower),
        acceptedFiles: writes.map((file) => ({ fileName: file.fileName, yaml: file.proposed, previousChecksum: cached.checksums[file.fileName] })) }],
      content: [], replaceSameNamed: false, mergeAfterValidation: false, publishDrafts: false, deleteBranch: false, postMigrationActions: [],
      dashboardRepair: { planId, targetId, revision: preview.revision, additiveOnly: true, targetModelHash: cached.targetHash,
        sourceDocumentHashes: cached.documentHashes, sourceWorkbookHashes: cached.workbookHashes, instanceBoundaryHash: cached.credentialsHash,
        sourceRelationEvidence: { [evidence.sourceModelId]: cached.relationEvidence.source }, targetRelationEvidence: cached.relationEvidence.target,
        targetRelationInventoryHash: evidence.targetRelations.snapshotHash,
        sourceRelationInventoryHashes: { [evidence.sourceModelId]: evidence.sourceRelations.snapshotHash },
        sourceModelHashes: { [evidence.sourceModelId]: cached.sourceHash }, approvedFilesHash: dashboardSafeCopyStateHash(writes.map((file) => ({ fileName: file.fileName, yaml: file.proposed, previousChecksum: cached.checksums[file.fileName] }))) },
    });
    return { job: { id: job.id }, receipt: { targetId, sourceModelId: evidence.sourceModelId,
      sourceTopicName: preview.sourceTopicName, targetTopicName: preview.targetTopicName, targetFileName: topic.fileName,
      topicHash: dashboardTopicDefinitionHash(topic.proposed), sourceModelHash: cached.sourceHash, sourceHashes: cached.documentHashes,
      sourceWorkbookHashes: cached.workbookHashes, relationEvidence: cached.relationEvidence,
      sourceRelationInventoryHash: evidence.sourceRelations.snapshotHash, targetViewBindings: preview.targetViewBindings, jobId: job.id } };
  });
}
