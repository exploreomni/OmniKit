import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DashboardDeploymentPlan, DashboardDeploymentTargetReadiness, DashboardDependencyFinding } from '../../shared/dashboardDeploymentPlan';
import { DashboardSafeCopyError, parseDashboardSafeCopyIntent, parseDashboardDeploymentPlanIntent, type DashboardSafeCopyIntent } from '../../shared/dashboardSafeCopyContract';
import { assertDashboardSafeCopyInstanceRoles, createDashboardSafeCopyJob, type DashboardSafeCopyPreparationRunner } from './dashboardSafeCopyJobs';
import { dashboardSafeCopyDocumentModelBinding, dashboardSafeCopyStateHash } from './dashboardSafeCopyRuntime';
import { buildMigrationPlan, type MigrationTarget, type ModelMigrationModelInput } from './migrationJobs';
import { resolveDashboardSafeCopyTarget } from './dashboardSafeCopyResolver';
import { inspectDashboardDependencyReadiness } from './dashboardDependencyReadiness';
import { getJob, getJobsDbPath, listJobs } from './jobStore';
import { getInstance } from './nativeVault';
import { OmniClient, type OmniDocumentRecord, type OmniModelYamlResponse } from './omniClient';
import { redactSensitiveText } from './jobSanitizer';
import { parse } from 'yaml';
import { readDashboardSourceEvidence } from './dashboardSourceEvidence';
import { dashboardWorkbookHasAuthoredDefinitions, getDashboardWorkbookCopyCapability } from './dashboardWorkbookCopy';
import { createDashboardReadinessContext, type DashboardReadinessRunContext } from './dashboardReadinessControl';
import { readReviewedReconstructedTopics } from './dashboardTopicRepairEvidence';

const busy = new Set<string>();
const MAX_PLANS = 500;
const EVIDENCE_VERSION = 4;
const storePath = () => `${getJobsDbPath()}.deployment-plans.json`;
function readPlans(): DashboardDeploymentPlan[] {
  if (!existsSync(storePath())) return [];
  const value: unknown = JSON.parse(readFileSync(storePath(), 'utf8'));
  if (!Array.isArray(value)) throw new Error('Deployment plan storage is invalid.');
  return value as DashboardDeploymentPlan[];
}
function savePlan(plan: DashboardDeploymentPlan): DashboardDeploymentPlan {
  const plans = readPlans();
  const index = plans.findIndex((candidate) => candidate.id === plan.id);
  if (index >= 0) plans[index] = plan;
  else {
    if (plans.length >= MAX_PLANS) throw new DashboardSafeCopyError('SAFE_COPY_LIMIT_EXCEEDED', 'Deployment plan history is full; retain or archive existing plans before creating more.', 409);
    plans.push(plan);
  }
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(plans), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  return plan;
}
function conflict(message: string): never { throw new DashboardSafeCopyError('SAFE_COPY_SCOPE_CONFLICT', message, 409); }
export function getDashboardDeploymentPlan(id: string): DashboardDeploymentPlan {
  const plan = readPlans().find((candidate) => candidate.id === id);
  if (!plan) throw new DashboardSafeCopyError('SAFE_COPY_INVALID_BODY', 'Deployment plan not found.', 404);
  if (plan.readinessRun && plan.readinessRun.status !== 'complete') return { ...plan,
    targets: plan.targets.map((target) => ({ ...target, status: 'needs_recheck' as const })) };
  if (plan.evidenceVersion !== EVIDENCE_VERSION) return { ...plan, targets: plan.targets.map((target) => ({ ...target,
    status: target.status === 'ready' ? 'needs_recheck' as const : target.status,
    findings: mergeFindings([...target.findings, { ...finding('document', 'readiness_version',
      'This saved plan needs a workbook-aware readiness check before repair or deployment.', plan.intent.source.documentIds), category: 'cannot_verify' }]),
  })) };
  return plan;
}
async function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (busy.has(id)) conflict('This plan is already being checked or submitted. Wait for that operation to finish.');
  busy.add(id);
  try { return await work(); } finally { busy.delete(id); }
}

/** Serialize an explicitly approved additive topic repair with other plan writes. */
export async function withDashboardTopicRepairSubmission<T extends { job: { id: string }; receipt: NonNullable<DashboardDeploymentPlan['topicRepairReceipts']>[number] }>(
  id: string, revision: number, targetId: string, work: (plan: DashboardDeploymentPlan) => Promise<T>,
): Promise<T & { plan: DashboardDeploymentPlan }> {
  return exclusive(id, async () => {
    const plan = getDashboardDeploymentPlan(id);
    if (plan.revision !== revision) conflict('The topic review is stale. Prepare the differences again.');
    const target = plan.targets.find((row) => row.targetId === targetId);
    if (!target || target.deploymentJobId || target.repairJobId) conflict('This destination already has a submitted job. Resume it before starting another repair.');
    const existingJob = listJobs(Number.MAX_SAFE_INTEGER).find((job) => {
      const repair = job.details?.dashboardRepair as { planId?: string; targetId?: string } | undefined;
      return repair?.planId === id && repair.targetId === targetId;
    });
    if (existingJob) conflict(`A repair was already submitted for this destination (${existingJob.id}). Resume it; no duplicate branch was created.`);
    const result = await work(plan);
    target.repairJobId = result.job.id;
    target.status = 'needs_recheck';
    const destination = plan.intent.destinations.find((row) => row.targetId === targetId)!;
    destination.topicMappings = [...(destination.topicMappings || []).filter((row) => row.sourceTopicName !== result.receipt.sourceTopicName),
      { sourceTopicName: result.receipt.sourceTopicName, targetTopicName: result.receipt.targetTopicName, action: 'map_existing' }];
    const updated = savePlan({ ...plan, revision: plan.revision + 1, updatedAt: Date.now(),
      topicRepairReceipts: [...(plan.topicRepairReceipts || []), result.receipt] });
    return { ...result, plan: updated };
  });
}
async function mapLimited<T, R>(values: T[], work: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await work(values[index]); }
  }));
  return results;
}
function targetInput(destination: DashboardSafeCopyIntent['destinations'][number]): MigrationTarget {
  return { id: destination.targetId, exactFolder: true, destinationInstanceId: destination.instanceId, targetConnectionId: destination.connectionId,
    targetModelId: destination.modelId, targetFolderId: destination.folderId, targetFolderPath: destination.folderPath,
    topicMappings: destination.topicMappings, queryViewMappings: destination.queryViewMappings, workbookCopy: destination.workbookCopy };
}
function finding(kind: DashboardDependencyFinding['kind'], reference: string, message: string, documentIds: string[], file?: string): DashboardDependencyFinding {
  return { id: dashboardSafeCopyStateHash({ kind, reference, message }).slice(0, 20), kind,
    reference: redactSensitiveText(reference), message: redactSensitiveText(message), documentIds,
    sourceFileName: file, targetFileName: file };
}
function collectFiles(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectFiles);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    ['sourceFileName', 'fileName'].includes(key) && typeof child === 'string' ? [child] : collectFiles(child));
}
function topicCatalog(files: Record<string, string>) {
  return Object.entries(files).filter(([file]) => file.endsWith('.topic')).map(([fileName, text]) => {
    const value: unknown = parse(text, { maxAliasCount: 50 });
    const label = value && typeof value === 'object' && !Array.isArray(value) && 'label' in value && typeof value.label === 'string' ? value.label : undefined;
    return { name: fileName.split('/').pop()!.replace(/\.topic$/, ''), fileName, ...(label ? { label } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function sourceTopicReferences(steps: Awaited<ReturnType<typeof buildMigrationPlan>>['steps']) {
  const topics = new Map<string, Set<string>>();
  for (const step of steps) {
    const refs = step.details?.sourceTopics;
    if (!Array.isArray(refs) || !step.documentId) continue;
    for (const ref of refs) if (ref && typeof ref === 'object' && typeof ref.name === 'string' && ref.name.trim()) {
      if (!topics.has(ref.name)) topics.set(ref.name, new Set());
      topics.get(ref.name)!.add(step.documentId);
    }
  }
  return topics;
}
function localField(evidence: Awaited<ReturnType<typeof readDashboardSourceEvidence>> | undefined, reference: string) {
  return evidence?.fields.find((field) => field.reference === reference.toLowerCase()
    && ['workbook_local', 'workbook_override'].includes(field.provenance) && field.definition !== undefined && field.sourceFileName);
}
export function mergeDashboardReadinessFindings(findings: DashboardDependencyFinding[]): DashboardDependencyFinding[] {
  const merged = new Map<string, DashboardDependencyFinding>();
  const specificCauses = new Set(['SOURCE_DEFINITION_UNAVAILABLE', 'SOURCE_FILE_UNAVAILABLE', 'DESTINATION_FIELD_DIFFERS',
    'DESTINATION_VIEW_MISSING', 'VIEW_SETTING_DIFFERS', 'SECURITY_SETTING_DIFFERS', 'WORKBOOK_FIELD_IDENTIFIED', 'WORKBOOK_COPY_PREREQUISITE']);
  for (const item of findings) {
    // Never collapse different scopes or independent security findings because
    // they mention the same field. Only known diagnostic causes share identity.
    const key = item.causeCode && specificCauses.has(item.causeCode)
      ? JSON.stringify([item.kind, item.reference.toLowerCase(), item.sourceScope, item.category, item.causeCode, item.sourceFileName, item.targetFileName])
      : item.id;
    const previous = merged.get(key);
    merged.set(key, previous ? { ...previous, documentIds: [...new Set([...previous.documentIds, ...item.documentIds])] } : item);
  }
  return [...merged.values()];
}
const mergeFindings = mergeDashboardReadinessFindings;

/** Read-only: no job, scope reservation, branch, YAML write, or query execution. */
async function inspectPlan(plan: DashboardDeploymentPlan, run: DashboardReadinessRunContext): Promise<DashboardDeploymentPlan> {
  run.throwIfAborted();
  run.report('source_dashboard', { completed: 0, total: plan.intent.source.documentIds.length });
  assertDashboardSafeCopyInstanceRoles(plan.intent);
  const credentialBoundaries = new Map([...new Set([plan.intent.source.instanceId, ...plan.intent.destinations.map((destination) => destination.instanceId)])]
    .map((id) => {
      const instance = getInstance(id);
      if (!instance) conflict('A selected instance is unavailable.');
      return [id, dashboardSafeCopyStateHash({ baseUrl: instance.baseUrl, apiKey: instance.apiKey })] as const;
    }));
  const sourceSecret = getInstance(plan.intent.source.instanceId)!;
  const sourceClient = new OmniClient(sourceSecret, { signal: run.signal });
  const states = new Map<string, Record<string, unknown>>();
  const documents = new Map<string, OmniDocumentRecord>();
  const sourceHashes: Record<string, string> = {};
  const sourceModelHashes: Record<string, string> = {};
  const workbookCopies: NonNullable<DashboardDeploymentPlan['workbookCopies']> = {};
  let documentsRead = 0;
  await mapLimited(plan.intent.source.documentIds, async (id) => {
    run.throwIfAborted();
    const state = await sourceClient.getDocumentStateV2(id);
    if (!Array.isArray(state.containers) || typeof state.name !== 'string' || !state.name.trim()
      || typeof state.modelId !== 'string' || !state.modelId.trim()) {
      throw new Error('The selected dashboard layout or shared-model binding could not be verified.');
    }
    states.set(id, state);
    sourceHashes[id] = dashboardSafeCopyStateHash(state);
    run.report('source_dashboard', { completed: ++documentsRead, total: plan.intent.source.documentIds.length });
  });
  const yamlCache = new Map<string, Promise<OmniModelYamlResponse>>();
  const modelReads = new Map<string, ReturnType<OmniClient['listModels']>>();
  const verifyModelConnection = async (instanceId: string, modelId: string, connectionId: string) => {
    const key = `${instanceId}:${modelId}:${connectionId}`;
    if (!modelReads.has(key)) modelReads.set(key, (async () => {
      const client = new OmniClient(getInstance(instanceId)!, { signal: run.signal });
      const shared = await client.listModels({ modelId, connectionId, modelKind: 'SHARED' });
      return shared.some((model) => model.id === modelId) ? shared : client.listModels({ modelId, connectionId, modelKind: 'SHARED_EXTENSION' });
    })());
    const matches = (await modelReads.get(key)!).filter((model) => model.id === modelId || model.identifier === modelId);
    if (matches.length !== 1 || matches[0].connectionId !== connectionId || matches[0].deletedAt) throw new Error('Model connection binding is unavailable or changed.');
    return matches[0];
  };
  const yamlSnapshot = (instanceId: string, modelId: string, mode?: 'extension') => {
    const key = `${instanceId}:${modelId}:${mode || 'combined'}`;
    if (!yamlCache.has(key)) yamlCache.set(key, Promise.resolve().then(async () => {
      const secret = getInstance(instanceId);
      if (!secret) throw new Error('Instance unavailable.');
      run.throwIfAborted();
      return new OmniClient(secret, { signal: run.signal }).getModelYaml(modelId, { includeChecksums: true, fullyResolved: false, mode });
    }));
    return yamlCache.get(key)!;
  };
  const yaml = async (instanceId: string, modelId: string, mode?: 'extension') => (await yamlSnapshot(instanceId, modelId, mode)).files;
  run.report('source_models', { completed: 0, total: plan.intent.source.documentIds.length });
  let sourcesRead = 0;
  const documentEvidence = new Map<string, Awaited<ReturnType<typeof readDashboardSourceEvidence>>>();
  await mapLimited(plan.intent.source.documentIds, async (documentId) => {
    const state = states.get(documentId);
    if (!state || typeof state.modelId !== 'string') return;
    run.throwIfAborted();
    const model = await verifyModelConnection(plan.intent.source.instanceId, state.modelId, plan.intent.source.connectionId);
    documents.set(documentId, { id: documentId, identifier: documentId, name: String(state.name),
      connectionId: model.connectionId, baseModelId: model.id, baseModelName: model.name, hasDashboard: true });
    try {
      const workbookModelId = typeof state.workbookModelId === 'string' ? state.workbookModelId : undefined;
      if (!workbookModelId?.trim()) throw new Error('Workbook identity unavailable.');
      const evidence = await readDashboardSourceEvidence({ sharedModelId: state.modelId, workbookModelId, states: [state],
        loadYaml: (modelId, options) => yaml(plan.intent.source.instanceId, modelId, options.mode) });
      documentEvidence.set(documentId, evidence);
      if (workbookModelId && dashboardWorkbookHasAuthoredDefinitions(evidence.workbookFiles)) workbookCopies[documentId] = {
        sourceWorkbookModelId: workbookModelId, sourceSharedModelId: state.modelId,
        authoredModelHash: dashboardSafeCopyStateHash(evidence.workbookFiles),
        authoredFileHashes: Object.fromEntries(Object.entries(evidence.workbookFiles).map(([file, content]) => [file, dashboardSafeCopyStateHash(content)])),
      };
    } catch { run.throwIfAborted(); /* Retained as explicit per-document unavailable evidence below. */ }
    run.report('source_models', { completed: ++sourcesRead, total: plan.intent.source.documentIds.length });
  });
  run.report('destination_evidence', { completed: 0, total: plan.intent.destinations.length });
  const folderReads = new Map<string, ReturnType<OmniClient['listFolderInventory']>>();
  const folderErrors = new Set<string>();
  const destinations = await mapLimited(plan.intent.destinations, async (destination) => {
    run.throwIfAborted();
    if (!destination.folderId && !destination.folderPath) return destination;
    try {
      if (!folderReads.has(destination.instanceId)) folderReads.set(destination.instanceId,
        new OmniClient(getInstance(destination.instanceId)!, { signal: run.signal }).listFolderInventory());
      const inventory = await folderReads.get(destination.instanceId)!;
      if (!inventory.pagination.complete) throw new Error('Incomplete folder inventory.');
      const normalize = (path: string | undefined) => (path || '').trim().replace(/^\/+|\/+$/g, '');
      const folders = inventory.folders.filter((folder) => (!destination.folderId || folder.id === destination.folderId)
        && (!destination.folderPath || normalize(folder.path || folder.identifier || folder.name) === normalize(destination.folderPath)));
      if (folders.length !== 1) throw new Error('Folder did not resolve exactly.');
      const folder = folders[0];
      return { ...destination, folderId: folder.id, folderPath: folder.path || folder.identifier || destination.folderPath };
    } catch { run.throwIfAborted(); folderErrors.add(destination.targetId); return destination; }
  });
  plan = { ...plan, intent: parseDashboardDeploymentPlanIntent({ ...plan.intent, destinations }) };
  const inspectionInput = { sourceId: plan.intent.source.instanceId, sourceConnectionId: plan.intent.source.connectionId,
    targets: plan.intent.destinations.map(targetInput), documentIds: plan.intent.source.documentIds, emptyFirst: false, replaceSameNamed: false,
    deleteSourceOnSuccess: false, sourceAllFolders: true, documentAccessPolicy: 'destination_defaults' as const, usePreviewCache: false,
    prepareDependencyPatchCandidates: true };
  const reconstructedTopics = await readReviewedReconstructedTopics({ ...plan, sourceHashes },
    (modelId) => yaml(plan.intent.source.instanceId, modelId), (instanceId, modelId) => yaml(instanceId, modelId),
    (modelId) => yaml(plan.intent.source.instanceId, modelId, 'extension'),
    async (instanceId, modelId) => (await yamlSnapshot(instanceId, modelId)).raw);
  // One inspection with trusted, selected-document evidence. A failed read is
  // never retried by rebuilding the entire plan separately for each target.
  const evidenceContext = { signal: run.signal, sourceDocumentStates: states, sourceDocuments: documents, reconstructedTopics,
    loadDestinationYaml: (instanceId: string, modelId: string) => yamlSnapshot(instanceId, modelId),
    loadSourceYaml: (modelId: string, options: { fullyResolved: false; mode?: 'extension' }) => yaml(plan.intent.source.instanceId, modelId, options.mode) };
  const sharedInspection = await buildMigrationPlan(inspectionInput, evidenceContext);
  run.throwIfAborted();
  run.report('comparison', { completed: 0, total: plan.intent.destinations.length });
  let compared = 0;
  const targets = await mapLimited(plan.intent.destinations, async (destination): Promise<DashboardDeploymentTargetReadiness> => {
    const old = plan.targets.find((target) => target.targetId === destination.targetId);
    const result: DashboardDeploymentTargetReadiness = { targetId: destination.targetId, status: 'unverified', findings: [],
      sourceModelIds: [], requiredFiles: [], requiredFilesByModelId: {}, checkedAt: Date.now(), repairJobId: old?.repairJobId, deploymentJobId: old?.deploymentJobId };
    let unverified = false;
    try {
      run.throwIfAborted();
      if (folderErrors.has(destination.targetId)) throw new Error('Folder evidence unavailable.');
      if (states.size !== plan.intent.source.documentIds.length) throw new Error('Source state unavailable.');
      await verifyModelConnection(destination.instanceId, destination.modelId, destination.connectionId);
      const targetFiles = await yaml(destination.instanceId, destination.modelId);
      result.modelHash = dashboardSafeCopyStateHash(targetFiles);
      const input = targetInput(destination);
      const inspection = { ...sharedInspection, targets: sharedInspection.targets.filter((target) => target.id === input.id),
        destinationIds: [destination.instanceId], steps: sharedInspection.steps.filter((step) => step.targetId === input.id) };
      const allDestinationTopics = topicCatalog(targetFiles);
      // Duplicate semantic names cannot be disambiguated by the name-based API contract.
      const destinationTopics = allDestinationTopics.filter((candidate) => allDestinationTopics.filter(
        (other) => other.name.toLowerCase() === candidate.name.toLowerCase(),
      ).length === 1);
      result.topicChoices = [...sourceTopicReferences(inspection.steps)].map(([sourceTopicName, ids]) => ({
        sourceTopicName, candidates: destinationTopics, documentIds: [...ids],
        sourceCandidates: [...new Map([...ids].flatMap((documentId) => topicCatalog(documentEvidence.get(documentId)?.sharedFiles || {})).map((candidate) => [candidate.fileName, candidate])).values()],
      }));
      const resolved = resolveDashboardSafeCopyTarget(inspection, input, { mode: 'readiness' });
      if (resolved.status === 'exception') {
        for (const issue of resolved.exceptions) {
          // A workbook-local field is not a missing shared-model field. Keep
          // independent security/ambiguity errors, and keep other documents'
          // shared dependencies even when one workbook overrides that name.
          const affectedDocuments = issue.sourceDocumentIds?.length
            ? issue.sourceDocumentIds.filter((id) => inspection.documentIds.includes(id)) : inspection.documentIds;
          if (issue.reference === 'source_evidence' && affectedDocuments.length > 0 && affectedDocuments.every((documentId) => {
            const evidence = documentEvidence.get(documentId);
            return evidence?.unverified && evidence.findings.some((entry) => !localField(evidence, entry.reference));
          })) continue; // The precise source prerequisites are retained below.
          const issueDocumentIds = issue.artifact === 'field'
            && ['MISSING_EVIDENCE', 'BLOCKED_DEPENDENCY', 'MANUAL_REVIEW_REQUIRED'].includes(issue.code)
            ? affectedDocuments.filter((documentId) => !localField(documentEvidence.get(documentId), issue.reference))
            : affectedDocuments;
          if (!issueDocumentIds.length) continue;
          const kind = issue.artifact === 'permission' ? 'security' : issue.artifact === 'target' || issue.artifact === 'semantic_patch' ? 'model' : issue.artifact;
          unverified ||= ['MISSING_EVIDENCE', 'SECURITY_REVIEW_REQUIRED', 'TARGET_SCOPE_MISMATCH', 'UNSAFE_TARGET_CONFIGURATION', 'MANUAL_REVIEW_REQUIRED'].includes(issue.code);
          const message = issue.code === 'DESTRUCTIVE_CHANGE' && issue.artifact === 'semantic_patch'
            ? 'The proposed model update would replace an existing definition and needs explicit Model Migrator review. No model changes were made by this readiness check.'
            : issue.message;
          result.findings.push({ ...finding(kind, issue.reference, message, issueDocumentIds, issue.sourceFileName), causeCode: issue.code,
            sourceScope: issue.sourceProvenance === 'workbook_local' || issue.sourceProvenance === 'workbook_override' ? 'workbook'
              : issue.sourceProvenance === 'shared_authored' ? 'shared' : undefined,
            category: issue.artifact === 'topic' ? (issue.code === 'MISSING_EVIDENCE' ? 'cannot_verify' : 'topic_mapping_required')
              : ['MISSING_EVIDENCE', 'SECURITY_REVIEW_REQUIRED', 'MANUAL_REVIEW_REQUIRED'].includes(issue.code) ? 'cannot_verify' : 'model_migrator' });
        }
      } else {
        for (const patch of (resolved.target.semanticPatches || []).filter((patch) => patch.resolution !== 'keep_target')) {
          result.findings.push(finding('model', patch.targetFileName, 'This dependency requires a reviewed Model Migrator change before dashboard deployment.', inspection.documentIds, patch.sourceFileName || patch.targetFileName));
        }
        // Field renames are not represented by the content-only v2 contract.
        if ((resolved.target.fieldMappings || []).some((mapping) => mapping.action === 'ignore'
          || (mapping.targetFieldRef && mapping.sourceFieldRef !== mapping.targetFieldRef))) {
          unverified = true;
          result.findings.push(finding('field', 'field_mapping', 'A field rewrite needs explicit review; automatic semantic substitutions are not supported by this deployment.', inspection.documentIds));
        }
      }
      const documentsByModel = new Map<string, string[]>();
      for (const documentId of inspection.documentIds) {
        const steps = inspection.steps.filter((step) => step.documentId === documentId);
        const fromPlan = steps.map((step) => step.details?.sourceModelId).find((id): id is string => typeof id === 'string' && Boolean(id));
        const state = states.get(documentId)!;
        const modelId = typeof state.modelId === 'string' ? state.modelId : dashboardSafeCopyDocumentModelBinding(state);
        if (fromPlan && fromPlan !== modelId) {
          unverified = true;
          result.findings.push({ ...finding('model', 'source_binding_changed', 'The dashboard and exported model binding disagree. Recheck the source before copying.', [documentId]), category: 'cannot_verify' });
          continue;
        }
        if (!modelId) { unverified = true; result.findings.push(finding('model', 'source_binding', 'The source shared-model binding could not be established.', [documentId])); continue; }
        documentsByModel.set(modelId, [...(documentsByModel.get(modelId) || []), documentId]);
      }
      for (const [modelId, documentIds] of documentsByModel) {
        result.sourceModelIds.push(modelId);
        await verifyModelConnection(plan.intent.source.instanceId, modelId, plan.intent.source.connectionId);
        const sourceFiles = await yaml(plan.intent.source.instanceId, modelId);
        sourceModelHashes[modelId] = dashboardSafeCopyStateHash(sourceFiles);
        const relevantSteps = inspection.steps.filter((step) => step.documentId && documentIds.includes(step.documentId));
        const requiredFiles = [...new Set(collectFiles(relevantSteps.map((step) => step.details)))];
        const requiredShared = new Set<string>();
        for (const documentId of documentIds) {
          const evidence = documentEvidence.get(documentId);
          if (!evidence) {
            unverified = true;
            result.findings.push({ ...finding('document', 'source_layers_unavailable', 'The complete shared and workbook source layers could not be verified.', [documentId]), category: 'cannot_verify' });
          }
          for (const issue of evidence?.findings || []) {
            if (localField(evidence, issue.reference)) continue;
            unverified = true;
            const overlay = issue.reference.startsWith('workbook_overlay');
            result.findings.push({ ...finding(overlay ? 'document' : 'field', issue.reference, issue.message, [documentId], issue.sourceFileName),
              category: 'cannot_verify', sourceScope: overlay ? 'workbook' : undefined,
              causeCode: overlay ? 'WORKBOOK_OVERLAY_UNVERIFIED' : 'SOURCE_DEFINITION_UNAVAILABLE',
              rootCauseId: overlay ? `workbook_overlay:${documentId}` : `source_field_unavailable:${issue.reference}` });
          }
          if (workbookCopies[documentId]) {
            const capability = getDashboardWorkbookCopyCapability();
            if (!capability.supported || !destination.workbookCopy) {
              unverified = true;
              result.findings.push({ ...finding('document', capability.supported ? 'workbook_copy_staging' : 'workbook_copy_capability',
                capability.supported ? 'Select an eligible staging folder for the verified workbook-copy workflow.' : capability.message,
                [documentId]), category: 'cannot_verify', sourceScope: 'workbook', causeCode: 'WORKBOOK_COPY_PREREQUISITE',
                rootCauseId: 'workbook_copy_capability' });
            }
          }
          const workbookFields = Object.fromEntries((evidence?.fields || []).filter((field) => localField(evidence, field.reference))
            .map((field) => [field.reference, { sourceFileName: field.sourceFileName!, definition: field.definition }]));
          const reconstructed = (reconstructedTopics[destination.targetId] || []).filter((row) => row.sourceModelId === modelId && row.documentIds.includes(documentId));
          const closure = inspectDashboardDependencyReadiness({
          sourceFiles: { ...sourceFiles, ...Object.fromEntries(reconstructed.map((row) => [row.sourceFileName, row.yaml])) }, targetFiles, workbookFields,
          fieldDependencies: Object.fromEntries((evidence?.fields || []).map((field) => [field.reference, field.dependencies])),
          states: [states.get(documentId)], documentIds: [documentId],
          // A destination choice cannot establish a stale source topic's identity.
          // Always require its exact authored name, independently of legacy label matching.
          seedFiles: [...new Set([
            ...(evidence?.requiredSharedFiles || []),
            ...requiredFiles.filter((file) => !Object.hasOwn(evidence?.workbookFiles || {}, file) || Object.hasOwn(sourceFiles, file)),
            ...[...sourceTopicReferences(relevantSteps)].filter(([, ids]) => ids.has(documentId)).map(([name]) => `${name}.topic`),
          ])],
          fileMappings: Object.fromEntries([
            ...reconstructed.map((row) => [row.sourceFileName, row.targetFileName]),
            ...(destination.topicMappings || []).map((mapping) => [`${mapping.sourceTopicName}.topic`, `${mapping.targetTopicName}.topic`]),
            ...(destination.queryViewMappings || []).map((mapping) => [`${mapping.sourceQueryViewName}.query.view`, `${mapping.targetQueryViewName}.query.view`]),
          ]),
          });
          unverified ||= closure.unverified;
          result.findings.push(...closure.findings.map((issue) => ({ ...issue, category: issue.category || (closure.unverified ? 'cannot_verify' as const : 'model_migrator' as const) })));
          closure.requiredFiles.forEach((file) => requiredShared.add(file));
        }
        result.requiredFilesByModelId[modelId] = [...requiredShared].filter((file) => Object.hasOwn(sourceFiles, file)).sort();
      }
      result.requiredFiles = [...new Set(Object.values(result.requiredFilesByModelId).flat())].sort();
      const remappedFiles = (destination.topicMappings || []).some((mapping) => mapping.sourceTopicName !== mapping.targetTopicName
        && !(reconstructedTopics[destination.targetId] || []).some((row) => row.sourceTopicName === mapping.sourceTopicName && row.targetTopicName === mapping.targetTopicName))
        || (destination.queryViewMappings || []).some((mapping) => mapping.sourceQueryViewName !== mapping.targetQueryViewName);
      if (result.findings.some((issue) => issue.category !== 'included_with_dashboard') && remappedFiles) {
        unverified = true;
        result.findings.push(finding('model', 'mapped_repair_scope', 'A renamed dependency needs manual model review before its repair scope can be established safely.', inspection.documentIds));
      }
      result.findings = mergeFindings(result.findings);
      result.status = unverified ? 'unverified' : result.findings.some((issue) => issue.category !== 'included_with_dashboard') ? 'model_changes_required' : 'ready';
    } catch {
      run.throwIfAborted();
      result.status = 'unverified';
      result.findings.push(finding('connection', 'readiness_unavailable', 'Required source or destination evidence could not be read. Reconnect, verify access, then recheck this destination.', plan.intent.source.documentIds));
    }
    run.report('comparison', { completed: ++compared, total: plan.intent.destinations.length, targetId: destination.targetId });
    return result;
  });
  run.throwIfAborted();
  assertDashboardSafeCopyInstanceRoles(plan.intent);
  for (const [id, expected] of credentialBoundaries) {
    const instance = getInstance(id);
    if (!instance || dashboardSafeCopyStateHash({ baseUrl: instance.baseUrl, apiKey: instance.apiKey }) !== expected) {
      conflict('A saved instance changed during readiness. Select it again and recheck before approving.');
    }
  }
  return { ...plan, evidenceVersion: EVIDENCE_VERSION, sourceHashes, sourceModelHashes, workbookCopies, targets, revision: plan.revision + 1, updatedAt: Date.now() };
}

export async function createDashboardDeploymentPlan(value: unknown, context?: DashboardReadinessRunContext): Promise<DashboardDeploymentPlan> {
  context?.throwIfAborted();
  const intent = parseDashboardDeploymentPlanIntent(value);
  if (intent.deployment) conflict('Deployment evidence is generated by the server, not supplied when creating a plan.');
  if (intent.options && Object.values(intent.options).some(Boolean)) conflict('Reviewed dashboard deployment supports copy only, without delete, empty-folder, or schema-refresh actions.');
  const existing = readPlans().find((plan) => plan.intent.requestId === intent.requestId);
  if (existing) {
    if ((existing.requestIntentHash || dashboardSafeCopyStateHash(existing.intent)) !== dashboardSafeCopyStateHash(intent)) conflict('This request identity already belongs to a different plan.');
    context?.throwIfAborted();
    return getDashboardDeploymentPlan(existing.id);
  }
  const run = context || createDashboardReadinessContext();
  try {
    return await exclusive(intent.requestId, async () => {
      run.throwIfAborted();
      const now = Date.now();
      const result = await inspectPlan({ version: 2, id: randomUUID(), revision: 0, createdAt: now, updatedAt: now, intent, requestIntentHash: dashboardSafeCopyStateHash(intent),
        targets: [], sourceHashes: {}, sourceModelHashes: {} }, run);
      run.throwIfAborted();
      return savePlan({ ...result, readinessRun: { id: run.runId, status: 'complete', startedAt: now,
        finishedAt: Date.now(), elapsedMs: run.elapsedMs(), stage: 'complete' } });
    });
  } finally { if (!context) run.dispose(); }
}
export async function recheckDashboardDeploymentPlan(id: string, context?: DashboardReadinessRunContext) {
  const run = context || createDashboardReadinessContext();
  try {
    return await exclusive(id, async () => {
      run.throwIfAborted();
      const previous = getDashboardDeploymentPlan(id);
      // Rechecking revokes the old authorization immediately, even if the
      // connection closes or the process exits before another result exists.
      const pending = savePlan({ ...previous, revision: previous.revision + 1, updatedAt: Date.now(),
        targets: previous.targets.map((target) => ({ ...target, status: 'needs_recheck' as const })),
        readinessRun: { id: run.runId, status: 'running', startedAt: Date.now() } });
      try {
        const result = await inspectPlan(pending, run);
        run.throwIfAborted();
        const current = getDashboardDeploymentPlan(id);
        if (current.revision !== pending.revision || current.readinessRun?.id !== run.runId) {
          conflict('The plan changed while readiness was running. Recheck its current choices.');
        }
        return savePlan({ ...result, readinessRun: { ...pending.readinessRun!, status: 'complete',
          finishedAt: Date.now(), elapsedMs: run.elapsedMs(), stage: 'complete' } });
      } catch (error) {
        const current = getDashboardDeploymentPlan(id);
        if (current.revision === pending.revision && current.readinessRun?.id === run.runId) {
          const reason: unknown = run.signal.aborted ? run.signal.reason : error;
          const code = reason && typeof reason === 'object' && 'code' in reason ? reason.code : undefined;
          savePlan({ ...pending, updatedAt: Date.now(), readinessRun: { ...pending.readinessRun!,
            status: code === 'DASHBOARD_READINESS_DEADLINE_EXCEEDED' ? 'timed_out' : run.signal.aborted ? 'canceled' : 'failed',
            finishedAt: Date.now(), elapsedMs: run.elapsedMs(), stage: run.stage } });
        }
        throw error;
      }
    });
  } finally { if (!context) run.dispose(); }
}
/** Change review choices only; never recheck, reserve a scope, or dispatch a write implicitly. */
export async function updateDashboardDeploymentPlan(id: string, value: unknown): Promise<DashboardDeploymentPlan> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) conflict('A plan update must be an object.');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['revision', 'targetId', 'topicMappings', 'workbookCopy'].includes(key))) conflict('The plan update contains unsupported fields.');
  return exclusive(id, async () => {
    const plan = getDashboardDeploymentPlan(id);
    if (body.revision !== plan.revision) conflict('The plan changed. Reload its latest review before saving choices.');
    const target = plan.targets.find((candidate) => candidate.targetId === body.targetId);
    const destination = plan.intent.destinations.find((candidate) => candidate.targetId === body.targetId);
    if (!target || !destination) conflict('Choose a destination in this plan.');
    if (target.deploymentJobId || target.repairJobId || listJobs(Number.MAX_SAFE_INTEGER).some((job) =>
      (job.details?.safeCopyDeployment as { planId?: string } | undefined)?.planId === id
      && job.targets?.some((route) => route.id === target.targetId))) conflict('This destination has a submitted job. Review that job before creating a new plan with different choices.');
    if (body.topicMappings !== undefined) {
      if (!Array.isArray(body.topicMappings)) conflict('Topic mappings must be a list.');
      for (const item of body.topicMappings) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) conflict('A topic mapping must be an object.');
        const mapping = item as Record<string, unknown>;
        const choice = target.topicChoices?.find((candidate) => candidate.sourceTopicName === mapping.sourceTopicName);
        const unchangedCopy = mapping.action === 'copy_source' && destination.topicMappings?.some((existing) =>
          existing.action === 'copy_source' && existing.sourceTopicName === mapping.sourceTopicName
          && existing.targetTopicName === mapping.targetTopicName);
        if (unchangedCopy) continue;
        if (mapping.action !== 'map_existing' || !choice?.candidates.some((candidate) => candidate.name === mapping.targetTopicName)) {
          conflict('Choose a source topic and destination candidate from the latest readiness review.');
        }
      }
    }
    const updated = { ...destination, ...(body.topicMappings !== undefined ? { topicMappings: body.topicMappings } : {}),
      ...(body.workbookCopy !== undefined ? { workbookCopy: body.workbookCopy } : {}) };
    if (body.workbookCopy === null) delete updated.workbookCopy;
    const intent = parseDashboardDeploymentPlanIntent({ ...plan.intent,
      destinations: plan.intent.destinations.map((candidate) => candidate.targetId === target.targetId ? updated : candidate) });
    if (dashboardSafeCopyStateHash(intent) === dashboardSafeCopyStateHash(plan.intent)) return plan;
    return savePlan({ ...plan, intent, revision: plan.revision + 1, updatedAt: Date.now(),
      targets: plan.targets.map((candidate) => candidate.targetId === target.targetId ? { ...candidate, status: 'needs_recheck' as const } : candidate) });
  });
}
export async function deployDashboardDeploymentPlan(id: string, input: { revision: number; targetIds: string[]; requestId: string }, prepare: DashboardSafeCopyPreparationRunner | null, signal?: AbortSignal) {
  const run = createDashboardReadinessContext({ signal });
  try { return await exclusive(id, async () => {
    run.throwIfAborted();
    const plan = getDashboardDeploymentPlan(id);
    if (!Array.isArray(input.targetIds) || !input.targetIds.length || new Set(input.targetIds).size !== input.targetIds.length || input.targetIds.some((targetId) => !plan.targets.some((target) => target.targetId === targetId))) conflict('Choose one or more distinct destinations from this plan.');
    const destinations = plan.intent.destinations.filter((destination) => input.targetIds.includes(destination.targetId));
    const existingJob = listJobs(Number.MAX_SAFE_INTEGER).find((job) => job.details?.safeCopyRequestId === input.requestId && (job.details?.safeCopyDeployment as { planId?: string } | undefined)?.planId === id);
    if (existingJob) {
      if (JSON.stringify((existingJob.targets || []).map((target) => target.id).sort()) !== JSON.stringify([...input.targetIds].sort())) conflict('This request identity belongs to a different destination selection.');
      for (const target of plan.targets) if (input.targetIds.includes(target.targetId)) target.deploymentJobId = existingJob.id;
      return { job: existingJob, plan: savePlan(plan) };
    }
    // The job ledger is authoritative if a crash interrupted the subsequent
    // plan write. A fresh request identity must never duplicate that dispatch.
    if (listJobs(Number.MAX_SAFE_INTEGER).some((job) => (job.details?.safeCopyDeployment as { planId?: string } | undefined)?.planId === id
      && job.targets?.some((target) => input.targetIds.includes(target.id)))) conflict('A deployment job already exists for these plan destinations. Resume that job instead of creating another copy.');
    if (plan.revision !== input.revision) conflict('The plan changed. Review its latest readiness before deploying.');
    if (plan.evidenceVersion !== EVIDENCE_VERSION) conflict('This plan predates workbook-aware readiness. Recheck it before deployment.');
    if (input.targetIds.some((targetId) => plan.targets.find((target) => target.targetId === targetId)?.status !== 'ready')) conflict('Only ready destinations can be deployed. Repair or recheck the held destinations.');
    if (input.targetIds.some((targetId) => plan.targets.find((target) => target.targetId === targetId)?.deploymentJobId)) conflict('These destinations already have a deployment job. Use that job’s retry or create a new reviewed copy plan.');
    const refreshed = await inspectPlan(plan, run);
    run.throwIfAborted();
    const changed = dashboardSafeCopyStateHash(plan.sourceHashes) !== dashboardSafeCopyStateHash(refreshed.sourceHashes)
      || dashboardSafeCopyStateHash(plan.sourceModelHashes) !== dashboardSafeCopyStateHash(refreshed.sourceModelHashes)
      || dashboardSafeCopyStateHash(plan.workbookCopies || {}) !== dashboardSafeCopyStateHash(refreshed.workbookCopies || {})
      || input.targetIds.some((targetId) => {
        const before = plan.targets.find((target) => target.targetId === targetId)!;
        const after = refreshed.targets.find((target) => target.targetId === targetId)!;
        return after.status !== 'ready' || before.modelHash !== after.modelHash;
      });
    if (changed) {
      for (const target of refreshed.targets) if (input.targetIds.includes(target.targetId) && target.status === 'ready') target.status = 'needs_recheck';
      savePlan(refreshed);
      conflict('Source or destination evidence changed. Recheck and approve the refreshed plan before deployment.');
    }
    const intent = parseDashboardSafeCopyIntent({ ...plan.intent, requestId: input.requestId, destinations,
      deployment: { version: 2, planId: id, sourceHashes: refreshed.sourceHashes, sourceModelHashes: refreshed.sourceModelHashes,
        ...(Object.keys(refreshed.workbookCopies || {}).length ? { workbookCopies: refreshed.workbookCopies } : {}),
        modelHashes: Object.fromEntries(refreshed.targets.filter((target) => input.targetIds.includes(target.targetId)).map((target) => [target.targetId, target.modelHash])) } });
    // Cancellation applies to the read-only preflight. Once the durable job is
    // created its existing job lifecycle, not a browser disconnect, owns writes.
    run.throwIfAborted();
    const { job } = createDashboardSafeCopyJob(intent, { prepare: prepare || undefined });
    for (const target of refreshed.targets) if (input.targetIds.includes(target.targetId)) target.deploymentJobId = job.id;
    return { job, plan: savePlan(refreshed) };
  }); } finally { run.dispose(); }
}

export function resolveDashboardRepairScope(value: unknown) {
  if (!value || typeof value !== 'object') conflict('A saved dashboard repair scope is required.');
  const context = value as { planId: string; targetId: string; revision: number };
  const plan = getDashboardDeploymentPlan(context.planId);
  if (plan.evidenceVersion !== EVIDENCE_VERSION) conflict('This repair plan predates workbook-aware readiness. Recheck the dashboard plan first.');
  if (plan.revision !== context.revision) conflict('This repair context is stale. Return to the dashboard plan and recheck.');
  const target = plan.targets.find((candidate) => candidate.targetId === context.targetId);
  const destination = plan.intent.destinations.find((candidate) => candidate.targetId === context.targetId);
  if (!target || !destination || !target.requiredFiles.length || !target.sourceModelIds.length) conflict('The plan does not contain a complete scoped model repair.');
  if (target.deploymentJobId) conflict('This destination already has a deployment job. Create a new plan for further changes.');
  if (target.status !== 'model_changes_required') conflict('Model repair is not verified for this destination. Review the missing evidence and recheck the dashboard plan before preparing changes.');
  return { plan, target, destination };
}
export async function withDashboardRepairSubmission<T>(value: unknown, work: (link: (jobId: string) => DashboardDeploymentPlan) => Promise<T>): Promise<T> {
  const scope = resolveDashboardRepairScope(value);
  return exclusive(scope.plan.id, async () => {
    const existing = listJobs(Number.MAX_SAFE_INTEGER).find((job) => {
      const repair = job.details?.dashboardRepair as { planId?: string; targetId?: string } | undefined;
      return repair?.planId === scope.plan.id && repair.targetId === scope.target.targetId;
    });
    if (existing) {
      linkRepair(scope.plan.id, scope.target.targetId, existing.id);
      conflict(`A repair job already exists for this destination (${existing.id}). Resume that job from the plan.`);
    }
    return work((jobId) => linkRepair(scope.plan.id, scope.target.targetId, jobId));
  });
}
export async function validateDashboardRepairModels(value: unknown, sourceId: string, targetId: string, models: ModelMigrationModelInput[]) {
  const scope = resolveDashboardRepairScope(value);
  if (sourceId !== scope.plan.intent.source.instanceId || targetId !== scope.destination.instanceId) conflict('Model repair instances do not match the saved dashboard plan.');
  for (const model of models) {
    const files = scope.target.requiredFilesByModelId[model.sourceModelId];
    if (!files?.length || model.targetModelId !== scope.destination.modelId || model.targetConnectionId !== scope.destination.connectionId || model.mode !== 'translate'
      || model.contentRepairActions?.length || model.semanticDecisions?.some((decision) => decision.acceptedYaml && (!decision.targetFileName || !files.includes(decision.targetFileName)))
      || model.acceptedFiles?.some((file) => !files.includes(file.fileName))) conflict('A model repair attempted to change files or operations outside its reviewed scope.');
  }
  const secret = getInstance(targetId);
  if (!secret) conflict('The repair destination is unavailable.');
  const current = await new OmniClient(secret).getModelYaml(scope.destination.modelId, { includeChecksums: true });
  if (dashboardSafeCopyStateHash(current.files) !== scope.target.modelHash) conflict('Destination model changed after review. Recheck the dashboard plan before repairing.');
  return scope;
}
export function linkDashboardModelRepair(id: string, targetId: string, jobId: string) {
  if (busy.has(id)) conflict('Wait for the current plan operation to finish.');
  return linkRepair(id, targetId, jobId);
}
function linkRepair(id: string, targetId: string, jobId: string) {
  const plan = getDashboardDeploymentPlan(id);
  const destination = plan.intent.destinations.find((target) => target.targetId === targetId);
  const target = plan.targets.find((candidate) => candidate.targetId === targetId);
  const job = getJob(jobId);
  if (!target || !destination || !job || job.workflow !== 'model' || job.sourceId !== plan.intent.source.instanceId
    || !job.targets?.length || job.targets.some((route) => route.destinationInstanceId !== destination.instanceId || route.targetModelId !== destination.modelId)) conflict('The repair job does not match this plan destination.');
  if (target.repairJobId === jobId) return plan;
  if (target.repairJobId) conflict('This destination already has a linked repair job. Resume that repair before creating another.');
  target.repairJobId = jobId;
  target.status = 'needs_recheck';
  return savePlan({ ...plan, revision: plan.revision + 1, updatedAt: Date.now() });
}
