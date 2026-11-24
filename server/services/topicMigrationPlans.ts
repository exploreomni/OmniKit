import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TopicMigrationAnalysis, TopicMigrationExecutionBinding, TopicMigrationPlan, TopicMigrationRequest, BranchPreparationBinding, BranchVerificationRecord, TopicBranchComparison, TopicBranchVerificationFinding } from '../../shared/topicMigration';
import type { MigrationJob, ModelMigrationAcceptedFile, ModelMigrationJobInput } from './migrationJobs';
import { assertMigrationJobIdle } from './migrationJobs';
import { getJob, getJobsDbPath, listJobs, updateJobAtomically, JobHistoryUnavailableError } from './jobStore';
import { canPreserveTopicMigrationJobEvidence, redactSensitiveText, sanitizeJob } from './jobSanitizer';
import { getInstance, isVaultUnlocked, listInstances, type SavedInstance } from './nativeVault';
import { OmniClient, type OmniModelYamlResponse } from './omniClient';
import { getDashboardDeploymentPlan, resolveDashboardRepairScope, withDashboardRepairSubmission } from './dashboardDeploymentPlans';
import { assertAdditiveDashboardRepairDispatch, dashboardRepairInstanceBoundaryHash, readDashboardRepairSourceBinding } from './dashboardRepairRuntime';
import { assertDashboardRepairYamlPreservesTarget } from './dashboardRepairYaml';
import { dashboardSafeCopyStateHash } from './dashboardSafeCopyRuntime';
import { readDashboardTopicRelationInventory } from './dashboardTopicRelationInventory';
import { buildTopicMigrationAnalysis, inventoryMigrationTopics, topicMigrationSnapshotHash } from './topicMigrationPlanner';
import { migrationDestinationModelMutationLease, reserveMigrationDestinationModels, type MigrationDestinationModelScope } from './migrationScopeReservation';
import { dashboardSafeCopyHasUnresolvedDestinationModelOverlap } from './dashboardSafeCopyJobs';
import { compareTopicMigrationBranch } from './topicMigrationVerification';
import { createTopicMigrationBranchName } from '../../shared/topicMigrationBranchNames';
import { readTopicMigrationTableNameEvidence } from './topicMigrationTableNameEvidence';
import { canonicalKeepDestinationDefinitions } from './topicMigrationPreservation';

const PLAN_TTL_MS = 15 * 60_000;
const busy = new Set<string>();
const submissions = new WeakSet<ModelMigrationJobInput>();
const requestKeys = ['sourceInstanceId', 'sourceConnectionId', 'sourceModelId', 'targetInstanceId', 'targetConnectionId', 'targetModelId', 'topicIds', 'schemaMapText', 'fileMappings', 'reviewedSqlFiles', 'tableMappings', 'keepDestinationDefinitions'];
type StoredPlan = {
  plan: TopicMigrationPlan;
  boundaryHash: string;
  targetFiles: Record<string, string>;
  sourceSchemaHash?: string;
  targetSchemaHash?: string;
  sourceSchemaEvidenceHash?: string;
  targetSchemaEvidenceHash?: string;
  tableMappingsHash?: string;
  requiresPr: boolean;
  branchName: string;
  claim?: string;
  supersedes?: Array<{ planId: string; jobId: string }>;
  dashboardRepair?: ModelMigrationJobInput['dashboardRepair'];
};
const storePath = () => getJobsDbPath() + '.topic-plans.json';

function fail(message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { statusCode, code: 'TOPIC_MIGRATION_REVIEW_REQUIRED' });
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
}
function assertKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key))) fail('The topic migration request contains unsupported fields.', 400);
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 256 || [...value].some((character) => character.charCodeAt(0) < 32)) fail('Choose an exact saved instance, connection, model, and topic identity.', 400);
  return value;
}
function fileName(value: string): boolean {
  return value.length <= 512 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((part) => !part || part === '.' || part === '..')
    && (value === 'model' || value === 'relationships' || /\.(?:view|topic|model|relationships?)$/.test(value));
}
function stringMap(value: unknown, yaml: boolean): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).length > 200) fail('File mappings must be a bounded object of explicit file identities.', 400);
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  if (entries.some(([key, entry]) => !fileName(key) || typeof entry !== 'string' || !entry || entry.length > 2_000_000 || (!yaml && !fileName(entry)))
    || entries.reduce((sum, [, entry]) => sum + String(entry).length, 0) > 16_000_000) fail('File mappings or reviewed SQL files are invalid.', 400);
  if (!yaml && new Set(entries.map(([, entry]) => entry)).size !== entries.length) fail('Multiple source files cannot map to the same destination file.', 400);
  return Object.fromEntries(entries) as Record<string, string>;
}
function physicalIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z_][A-Za-z0-9_$-]*$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}
function tableMappings(value: unknown): TopicMigrationRequest['tableMappings'] {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).length > 200 || JSON.stringify(value).length > 2_000_000) fail('Physical mappings must be a bounded object of source view identities.', 400);
  let columns = 0;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([file, mapping]) => {
    if (!fileName(file) || !file.endsWith('.view')) fail('Physical mappings must use exact source authored view paths.', 400);
    assertKeys(mapping, ['targetTable', 'columnMappings']);
    if (typeof mapping.targetTable !== 'string') fail('Choose an exact destination schema.table or catalog.schema.table.', 400);
    const parts = mapping.targetTable.split('.');
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !physicalIdentifier(part))) fail('Choose an exact supported schema.table or catalog.schema.table identity.', 400);
    let columnMappings: Record<string, string> | undefined;
    if (mapping.columnMappings !== undefined) {
      if (!record(mapping.columnMappings) || Object.keys(mapping.columnMappings).length > 500) fail('Column mappings must be a bounded object of exact column names.', 400);
      const entries = Object.entries(mapping.columnMappings).sort(([a], [b]) => a.localeCompare(b));
      columns += entries.length;
      if (columns > 10_000 || entries.some(([source, target]) => !physicalIdentifier(source) || !physicalIdentifier(target))
        || new Set(entries.map(([, target]) => target)).size !== entries.length) fail('Use distinct exact destination columns; expressions and ambiguous column mappings are not accepted.', 400);
      columnMappings = Object.fromEntries(entries) as Record<string, string>;
    }
    return [file, { targetTable: mapping.targetTable, ...(columnMappings && Object.keys(columnMappings).length ? { columnMappings } : {}) }];
  }));
}
export function canonicalTopicMigrationRequest(value: unknown): TopicMigrationRequest {
  assertKeys(value, requestKeys);
  const pair = Object.fromEntries(requestKeys.slice(0, 6).map((key) => [key, identifier(value[key])]));
  if (!Array.isArray(value.topicIds) || !value.topicIds.length || value.topicIds.length > 100) fail('Select one or more bounded source topics.', 400);
  const topicIds = value.topicIds.map(identifier).sort();
  if (new Set(topicIds).size !== topicIds.length) fail('Selected topics must be distinct.', 400);
  if (typeof value.schemaMapText !== 'string' || value.schemaMapText.length > 50_000) fail('An explicit schema-map string is required.', 400);
  const mappings = value.schemaMapText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s*(?:->|=>|,)\s*/);
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_$-]*(?:\.[A-Za-z_][A-Za-z0-9_$-]*){0,2}$/.test(part))) fail('Use an explicit source namespace -> target namespace for every schema mapping.', 400);
    return parts;
  });
  if (new Set(mappings.map(([source]) => source.toLowerCase())).size !== mappings.length) fail('Each source namespace must have exactly one mapping.', 400);
  const fileMappings = stringMap(value.fileMappings, false);
  const reviewedSqlFiles = stringMap(value.reviewedSqlFiles, true);
  const physicalMappings = tableMappings(value.tableMappings);
  let keepDestinationDefinitions: TopicMigrationRequest['keepDestinationDefinitions'];
  try { keepDestinationDefinitions = canonicalKeepDestinationDefinitions(value.keepDestinationDefinitions); }
  catch (error) { fail(error instanceof Error ? error.message : 'Invalid destination-preservation choices.', 400); }
  return { ...pair, topicIds, schemaMapText: mappings.sort(([a], [b]) => a.localeCompare(b)).map(([source, target]) => source + ' -> ' + target).join('\n'),
    ...(fileMappings ? { fileMappings } : {}), ...(reviewedSqlFiles ? { reviewedSqlFiles } : {}),
    ...(physicalMappings && Object.keys(physicalMappings).length ? { tableMappings: physicalMappings } : {}),
    ...(keepDestinationDefinitions ? { keepDestinationDefinitions } : {}) } as TopicMigrationRequest;
}
function proof(row: StoredPlan): string {
  const plan = Object.fromEntries(Object.entries(row.plan).filter(([key]) => !['revision', 'status', 'jobId', ...(row.plan.version === 2 ? ['branchReceipt'] : [])].includes(key)));
  return hash({ plan, boundaryHash: row.boundaryHash, targetFiles: row.targetFiles,
    sourceSchemaHash: row.sourceSchemaHash, targetSchemaHash: row.targetSchemaHash,
    sourceSchemaEvidenceHash: row.sourceSchemaEvidenceHash, targetSchemaEvidenceHash: row.targetSchemaEvidenceHash,
    tableMappingsHash: row.tableMappingsHash, requiresPr: row.requiresPr, branchName: row.branchName,
    ...(row.plan.version === 2 ? { dashboardRepair: row.dashboardRepair } : {}),
    ...(row.supersedes ? { supersedes: row.supersedes } : {}) });
}
function readPlans(): StoredPlan[] {
  if (!existsSync(storePath())) return [];
  let rows: unknown;
  try { rows = JSON.parse(readFileSync(storePath(), 'utf8')); }
  catch { return fail('Topic plan history is unavailable. Restore or reconcile it before proceeding.', 503); }
  if (!Array.isArray(rows) || rows.length > 500 || rows.some((row) => !record(row) || !record(row.plan))) fail('Topic plan history is invalid.', 503);
  for (const row of rows as StoredPlan[]) {
    if (![1, 2].includes(row.plan.version) || typeof row.plan.id !== 'string' || row.plan.revision !== proof(row)) fail('Topic plan evidence changed or is incomplete. Restore the saved plan history.', 503);
  }
  if (new Set(rows.map((row) => row.plan.id)).size !== rows.length) fail('Topic plan history contains duplicate identities.', 503);
  return rows as StoredPlan[];
}
function save(row: StoredPlan): void {
  const rows = readPlans();
  const index = rows.findIndex((candidate) => candidate.plan.id === row.plan.id);
  if (index >= 0) rows[index] = row;
  else {
    if (rows.length >= 500) fail('Topic plan history is full; archive reviewed history before creating more.');
    rows.push(row);
  }
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(rows), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
function load(id: string): StoredPlan {
  const found = readPlans().find((row) => row.plan.id === id);
  if (!found) fail('Topic migration plan not found.', 404);
  return found;
}
function instances(request: Pick<TopicMigrationRequest, 'sourceInstanceId' | 'targetInstanceId' | 'sourceModelId' | 'targetModelId'>) {
  if (!isVaultUnlocked()) fail('Unlock the vault before using a topic migration plan.', 423);
  const source = getInstance(request.sourceInstanceId);
  const target = getInstance(request.targetInstanceId);
  if (!source || !target || !['source', 'both'].includes(source.role) || !['destination', 'both'].includes(target.role)) fail('The saved instances no longer authorize this source/destination pair.', 403);
  if (new URL(source.baseUrl).origin === new URL(target.baseUrl).origin && request.sourceModelId === request.targetModelId) fail('Topic migration cannot write to its own source model through any saved instance alias.');
  return { source, target };
}
function boundary(request: TopicMigrationRequest): string {
  const { source, target } = instances(request);
  // Only the irreversible digest is persisted; instance settings and credentials never enter a plan.
  return hash([source.id, source.baseUrl, source.apiKey, source.role, target.id, target.baseUrl, target.apiKey, target.role]);
}
function readClient(instance: SavedInstance, signal?: AbortSignal): OmniClient {
  return new OmniClient(instance, { signal, requestTimeoutMs: 10_000, maxReadRetries: 1 });
}
async function ownedModel(instance: SavedInstance, connectionId: string, modelId: string, signal?: AbortSignal) {
  const client = readClient(instance, signal);
  const [connections, models] = await Promise.all([
    client.listConnections(signal), client.listModels({ modelKind: 'SHARED', connectionId }, signal),
  ]);
  const connection = connections.filter((row) => row.id === connectionId && !row.deletedAt);
  const model = models.filter((row) => row.id === modelId && row.connectionId === connectionId && !row.deletedAt);
  if (connection.length !== 1 || model.length !== 1) fail('Live catalog evidence does not uniquely bind the selected shared model to the selected connection.');
  return { client, connection: connection[0], model: model[0] };
}
function confirmedYaml(response: OmniModelYamlResponse): OmniModelYamlResponse {
  // The general client tolerates malformed entries by normalizing them away.
  // Approval evidence must instead distinguish an explicit empty inventory from an unavailable one.
  if (!record(response.raw) || !record(response.raw.files)
    || Object.values(response.raw.files).some((value) => typeof value !== 'string')
    || topicMigrationSnapshotHash(response.raw.files as Record<string, string>) !== topicMigrationSnapshotHash(response.files)) {
    fail('The model YAML response is incomplete or malformed. Refresh its evidence before reviewing a topic migration.');
  }
  return response;
}
const REVIEW_YAML_OPTIONS = { mode: 'combined', fullyResolved: false, includeChecksums: true } as const;
class TopicEvidenceReadError extends Error {
  constructor(readonly finding: TopicBranchVerificationFinding) { super(finding.message); }
}
/** Two sequential reads, not polling. Discovery must finish before the approval baseline is captured. */
async function stableReviewYaml(client: OmniClient, modelId: string, label: 'Source' | 'Destination' | 'Branch', signal?: AbortSignal, branchId?: string) {
  const read = async () => {
    signal?.throwIfAborted();
    return confirmedYaml(await client.getModelYaml(modelId, { ...REVIEW_YAML_OPTIONS, ...(branchId ? { branchId } : {}), signal }));
  };
  const first = await read(), second = await read();
  if (topicMigrationSnapshotHash(first.files) !== topicMigrationSnapshotHash(second.files)
    || topicMigrationSnapshotHash(first.checksums || {}) !== topicMigrationSnapshotHash(second.checksums || {})) {
    throw Object.assign(new TopicEvidenceReadError({ code: `${label.toUpperCase()}_SNAPSHOT_UNSTABLE`,
      message: `${label} model files or checksums changed while being read. Wait for model or schema activity to finish, then recheck. If a branch already exists, review that branch without repeating its writes.` }),
    { statusCode: 409, code: 'TOPIC_MIGRATION_REVIEW_REQUIRED' });
  }
  return second;
}
function diagnosticFileName(name: string): { fileName?: string } {
  // New, unapproved paths are diagnostic text, never a reason to relax secret redaction.
  return fileName(name) && /^[A-Za-z0-9_ ./$-]+$/.test(name) && redactSensitiveText(name) === name ? { fileName: name } : {};
}
function destinationChanges(before: Record<string, string>, after: Record<string, string>): TopicBranchVerificationFinding[] {
  const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(name => {
    const kind = !Object.hasOwn(before, name) ? 'ADDED' : !Object.hasOwn(after, name) ? 'REMOVED'
      : before[name] !== after[name] ? 'CHANGED' : undefined;
    return kind ? [{ code: `DESTINATION_FILE_${kind}`, ...diagnosticFileName(name),
      message: `A destination shared-model file was ${kind.toLowerCase()} after the original review. This does not establish who or what changed it.` }] : [];
  });
  return [...changes.slice(0, 50), ...(changes.length > 50 ? [{ code: 'DESTINATION_CHANGES_TRUNCATED',
    message: `${changes.length - 50} additional destination file changes are not listed. Review the full model in Omni.` }] : [])];
}
async function namespaceSuggestions(client: OmniClient, modelId: string, signal?: AbortSignal): Promise<string[] | undefined> {
  try {
    // Native namespace names are optional review hints, not table/column proof.
    // Physical mapping and validation are deliberately finalized in Omni.
    return await client.listModelSchemas(modelId, undefined, signal);
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}
const BRANCH_PROFILE: BranchPreparationBinding = { profile: 'branch_preparation_v1' };
function flagNonWritableTarget(analysis: TopicMigrationAnalysis, gitFollower: boolean | undefined, topicIds: string[]): void {
  // The documented create/update YAML contract prohibits editing follower models.
  // PR requirements and branch protection alone do not imply the same restriction.
  if (gitFollower === true && !analysis.issues.some((issue) => issue.id === 'git-follower-read-only')) {
    analysis.issues = [...analysis.issues, { id: 'git-follower-read-only', kind: 'validation', severity: 'blocker',
      title: 'Destination model is a Git follower', message: 'This destination is marked as a Git follower and cannot accept YAML edits.',
      nextAction: 'Choose an editable destination model or manage this change through its upstream Git workflow in Omni.', topicIds }];
  }
}
function currentRequest(value: unknown): TopicMigrationRequest {
  assertKeys(value, requestKeys);
  if (['fileMappings', 'reviewedSqlFiles', 'tableMappings'].some((key) => value[key] !== undefined)) {
    fail('File, SQL, and physical-table corrections are finalized manually in Omni. Prepare an additive review branch instead.', 400);
  }
  return canonicalTopicMigrationRequest({ ...value, schemaMapText: value.schemaMapText ?? '' });
}
async function evidence(request: TopicMigrationRequest, signal?: AbortSignal, saved?: StoredPlan, reconcileTableNames = true) {
  signal?.throwIfAborted();
  const expectedBoundary = boundary(request);
  const pair = instances(request);
  const [source, target] = await Promise.all([
    ownedModel(pair.source, request.sourceConnectionId, request.sourceModelId, signal),
    ownedModel(pair.target, request.targetConnectionId, request.targetModelId, signal),
  ]);
  const [sourceLocations, targetLocations] = await Promise.all([
    saved ? undefined : namespaceSuggestions(source.client, request.sourceModelId, signal),
    saved ? undefined : namespaceSuggestions(target.client, request.targetModelId, signal),
  ]);
  const [sourceYaml, targetYaml] = await Promise.all([
    stableReviewYaml(source.client, request.sourceModelId, 'Source', signal),
    stableReviewYaml(target.client, request.targetModelId, 'Destination', signal),
  ]);
  signal?.throwIfAborted();
  if (boundary(request) !== expectedBoundary) fail('A saved instance changed while topic evidence was being read.');
  let analysis: TopicMigrationAnalysis = saved?.dashboardRepair
    ? { topics: saved.plan.topics, dependencies: saved.plan.dependencies, files: saved.plan.files, issues: saved.plan.issues,
      sourceHash: topicMigrationSnapshotHash(sourceYaml.files), targetHash: topicMigrationSnapshotHash(targetYaml.files) }
    : buildTopicMigrationAnalysis({ request, sourceFiles: sourceYaml.files, targetFiles: targetYaml.files,
      targetChecksums: targetYaml.checksums, sourceDialect: source.connection.dialect, targetDialect: target.connection.dialect });
  // Reconstruct legacy approvals with the rules and evidence they actually reviewed.
  // New packages only copy authored definitions and explicit namespace mappings;
  // compatibility repair is a separate, branch-bound Blobby operation.
  if (reconcileTableNames && saved && !saved.dashboardRepair && saved.plan.tableNameEvidenceHash !== undefined) {
    const enableSqlDialectReview = saved.plan.sqlDialectPolicy !== undefined;
    const inventories = await readTopicMigrationTableNameEvidence(analysis.files, async (namespace, readSignal) => {
      const response = await target.client.getModelYaml(request.targetModelId,
        { includeSchemas: namespace, fullyResolved: true, signal: readSignal });
      return confirmedYaml(response);
    }, signal, { includeColumns: enableSqlDialectReview });
    analysis = { ...buildTopicMigrationAnalysis({ request, sourceFiles: sourceYaml.files, targetFiles: targetYaml.files,
      targetChecksums: targetYaml.checksums, sourceDialect: source.connection.dialect, targetDialect: target.connection.dialect,
      targetTableNames: inventories, enableSqlDialectReview }), tableNameEvidenceHash: 'sha256:' + hash(inventories) };
    signal?.throwIfAborted();
    if (boundary(request) !== expectedBoundary) fail('A saved instance changed while destination table names were being read.');
  }
  flagNonWritableTarget(analysis, target.model.gitFollower, request.topicIds);
  if (saved?.dashboardRepair) {
    await assertAdditiveDashboardRepairDispatch({ sourceId: request.sourceInstanceId, destinationIds: [request.targetInstanceId],
      details: { dashboardRepair: saved.dashboardRepair }, items: [{ kind: 'model_yaml_write', details: { files: approvedFiles(saved) } }],
    } as unknown as MigrationJob, request.targetModelId, source.client, target.client);
  }
  const files = approvedAnalysisFiles(analysis);
  const planId = randomUUID();
  const integrityBinding: TopicMigrationExecutionBinding = { planId, revision: hash(analysis), request,
    sourceHash: analysis.sourceHash, targetHash: analysis.targetHash, filesHash: hash(files),
    instanceBoundaryHash: expectedBoundary, topicIds: request.topicIds };
  if (!canPreserveTopicMigrationJobEvidence(integrityBinding, files)) {
    analysis.issues = [...analysis.issues, { id: 'history-redaction-integrity', kind: 'validation', severity: 'blocker',
      title: 'Exact migration evidence cannot be preserved',
      message: 'The reviewed request or model definitions contain protected text.',
      nextAction: 'Review sensitive literals in the source before preparing this migration again.',
      topicIds: request.topicIds }];
  }
  return { analysis, source, target, sourceYaml, targetYaml, sourceLocations, targetLocations, boundaryHash: expectedBoundary,
    requiresPr: target.model.pullRequestRequired === true || target.model.gitProtected === true || target.model.gitFollower === true };
}
function verifiedStandalonePrewriteFailure(row: StoredPlan, jobs: MigrationJob[]): boolean {
  if (row.plan.version !== 2 || row.plan.executionProfile !== BRANCH_PROFILE.profile || row.dashboardRepair
    || row.plan.dashboardRepair || !row.claim || row.plan.status !== 'submitted' || !row.plan.jobId || row.plan.branchReceipt !== undefined) return false;
  const linked = jobs.filter(job => job.id === row.plan.jobId
    || (job.details?.topicMigration as TopicMigrationExecutionBinding | undefined)?.planId === row.plan.id);
  if (linked.length !== 1) return false;
  const job = linked[0];
  if (job.id !== row.plan.jobId || hash(job.details?.topicMigration) !== hash(binding(row))
    || job.workflow !== 'model' || !['failed', 'partial', 'canceled'].includes(job.status)
    || !Number.isSafeInteger(job.endedAt) || !job.endedAt || job.endedAt <= 0
    || job.details?.branchReceipt !== undefined || job.details?.branchId !== undefined) return false;
  try { assertTopicMigrationWriteAuthority(job); } catch { return false; }
  const owners = job.items.filter(item => item.kind === 'destination_model_mutation'
    || Object.hasOwn(item.details || {}, 'migrationDestinationModelMutation'));
  if (owners.length !== 1) return false;
  const owner = owners[0];
  const lease = migrationDestinationModelMutationLease(owner);
  if (owner.kind !== 'destination_model_mutation' || !lease || lease.jobId !== job.id || lease.state !== 'failed_prewrite' || lease.operation !== 'model_job'
    || lease.destinationInstanceId !== row.plan.request.targetInstanceId || lease.targetModelId !== row.plan.request.targetModelId
    || owner.status !== 'failed' || !lease.revision || lease.revision < 2) return false;
  // Even malformed dispatch evidence is not absence of evidence. Never let a
  // resolved/uncertain remote write be reclassified merely by changing its state.
  const hasRemoteEvidence = (details: Record<string, unknown> | undefined) => Object.keys(details || {}).some(key =>
    key === 'branchId' || key === 'branchReceipt' || /^migrationMutation(?:External|Dispatch|Resolution|Adjudication|Branch)/.test(key));
  if (hasRemoteEvidence(job.details)) return false;
  return job.items.every(item => item.jobId === job.id
    && !hasRemoteEvidence(item.details)
    && (item.kind === 'model_translate' ? ['succeeded', 'failed', 'skipped'].includes(item.status)
      : ['failed', 'skipped'].includes(item.status)));
}

/** A resolved lock alone is not proof that no YAML arrived. Require its exact audited outcome. */
function reconciledStandaloneNoWrite(row: StoredPlan, jobs: MigrationJob[]): { job: MigrationJob; branchId: string } | null {
  if (row.plan.version !== 2 || row.plan.executionProfile !== BRANCH_PROFILE.profile || row.dashboardRepair || row.plan.dashboardRepair
    || !row.claim || row.plan.status !== 'submitted' || !row.plan.jobId || row.plan.branchReceipt !== undefined) return null;
  const linked = jobs.filter(job => job.id === row.plan.jobId
    || (job.details?.topicMigration as TopicMigrationExecutionBinding | undefined)?.planId === row.plan.id);
  if (linked.length !== 1) return null;
  const job = linked[0];
  const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (job.id !== row.plan.jobId || job.workflow !== 'model' || hash(job.details?.topicMigration) !== hash(binding(row))
    || !['failed', 'partial', 'canceled'].includes(job.status) || !positive(job.endedAt)
    || job.details?.branchReceipt !== undefined || job.items.some(item => ['pending', 'running'].includes(item.status))) return null;
  try { assertTopicMigrationWriteAuthority(job); } catch { return null; }
  const owners = job.items.filter(item => item.kind === 'destination_model_mutation' || Object.hasOwn(item.details || {}, 'migrationDestinationModelMutation'));
  if (owners.length !== 1 || owners[0].kind !== 'destination_model_mutation') return null;
  const owner = owners[0], details = owner.details!;
  const lease = migrationDestinationModelMutationLease(owner);
  const create = job.items.find(item => item.kind === 'model_branch_create')!;
  const write = job.items.find(item => item.kind === 'model_yaml_write')!;
  const verify = job.items.find(item => item.kind === 'model_branch_verify')!;
  const branchId = create.details?.branchId;
  if (!lease || lease.jobId !== job.id || lease.state !== 'resolved' || lease.operation !== 'model_job' || owner.status !== 'succeeded'
    || owner.error || owner.endedAt !== lease.updatedAt || lease.destinationInstanceId !== row.plan.request.targetInstanceId
    || lease.targetModelId !== row.plan.request.targetModelId || !positive(lease.revision) || !positive(lease.dispatchedAt)
    || Object.hasOwn(details, 'migrationMutationExternalJobId') || lease.dispatchItemId !== write.id || lease.dispatchItemKind !== write.kind
    || !/^[a-f0-9]{64}$/.test(lease.dispatchFingerprint || '') || write.status !== 'failed'
    || !['failed', 'skipped'].includes(verify.status) || create.status !== 'succeeded' || create.error
    || typeof branchId !== 'string' || !branchId.trim() || branchId !== branchId.trim()
    || create.details?.branchName !== row.branchName || job.items.some(item => item.jobId !== job.id)) return null;
  const audits = job.details?.migrationMutationAdjudications;
  if (!Array.isArray(audits)) return null;
  const matching = audits.filter(audit => record(audit) && (audit.leaseItemId === owner.id || audit.requestId === details.migrationMutationResolutionRequestId));
  if (matching.length !== 1 || !record(matching[0])) return null;
  const audit = matching[0];
  if (details.migrationMutationResolutionKind !== 'operator_adjudication' || details.migrationMutationResolutionActor !== 'local_unlocked_operator'
    || details.migrationMutationResolutionOutcome !== 'verified_not_applied' || audit.outcome !== 'verified_not_applied'
    || !['omni_api', 'omni_ui', 'external_system'].includes(String(audit.evidenceSource))
    || audit.evidenceSource !== details.migrationMutationResolutionEvidenceSource || audit.actor !== 'local_unlocked_operator'
    || typeof audit.requestId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(audit.requestId)
    || audit.requestId !== details.migrationMutationResolutionRequestId || typeof audit.requestHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(audit.requestHash) || audit.requestHash !== details.migrationMutationResolutionRequestHash
    || audit.leaseItemId !== owner.id || audit.destinationInstanceId !== lease.destinationInstanceId || audit.targetModelId !== lease.targetModelId
    || audit.operation !== lease.operation || audit.dispatchItemId !== lease.dispatchItemId || audit.dispatchItemKind !== lease.dispatchItemKind
    || audit.dispatchFingerprint !== lease.dispatchFingerprint || !positive(audit.priorRevision) || audit.priorRevision + 1 !== lease.revision
    || audit.priorRevision !== details.migrationMutationResolutionExpectedRevision || audit.resolvedRevision !== lease.revision
    || !positive(audit.priorUpdatedAt) || audit.priorUpdatedAt !== details.migrationMutationResolutionExpectedUpdatedAt
    || audit.priorUpdatedAt < lease.dispatchedAt || audit.priorUpdatedAt > lease.updatedAt
    || audit.adjudicatedAt !== lease.updatedAt || audit.adjudicatedAt !== details.migrationMutationResolutionConfirmedAt
    || audit.adjudicatedAt < job.endedAt) return null;
  return { job, branchId };
}

async function persistPlan(request: TopicMigrationRequest, current: Awaited<ReturnType<typeof evidence>>,
  dashboardRepair?: ModelMigrationJobInput['dashboardRepair'], context?: TopicMigrationPlan['dashboardRepair'], signal?: AbortSignal, comparisonOfPlanId?: string): Promise<TopicMigrationPlan> {
  flagNonWritableTarget(current.analysis, current.target.model.gitFollower, request.topicIds);
  let history = readPlans();
  // An explicit comparison has no write authority. It can show current evidence
  // without resetting a claim, borrowing a receipt, or bypassing recovery gates.
  const comparisonOnly = comparisonOfPlanId ? readOnlyComparison(comparisonOfPlanId, request, history) : undefined;
  // Keep old approvals consumed. Only fully bound no-write evidence allows an
  // independently approved NEW plan, never a replay or reset of the old claim.
  const candidatesFor = (rows: StoredPlan[]) => comparisonOnly ? [] : rows.filter((row) => (row.claim || row.plan.status === 'submitted')
    && (dashboardRepair ? row.dashboardRepair?.planId === dashboardRepair.planId && row.dashboardRepair.targetId === dashboardRepair.targetId
      : !row.dashboardRepair && hash(requestKeys.slice(0, 6).map((key) => row.plan.request[key as keyof TopicMigrationRequest])) === hash(requestKeys.slice(0, 6).map((key) => request[key as keyof TopicMigrationRequest]))
        && hash([...row.plan.request.topicIds].sort()) === hash([...request.topicIds].sort())) && row.boundaryHash === current.boundaryHash
    && (!row.plan.jobId || row.plan.sourceHash === current.analysis.sourceHash && row.plan.targetHash === current.analysis.targetHash));
  let candidates = candidatesFor(history);
  let jobs = candidates.length ? listJobs(Number.MAX_SAFE_INTEGER) : [];
  const reconciled = new Map<string, string>();
  for (const row of candidates) {
    if (verifiedStandalonePrewriteFailure(row, jobs)) continue;
    const prior = reconciledStandaloneNoWrite(row, jobs);
    if (!prior) return getTopicMigrationPlan(row.plan.id);
    signal?.throwIfAborted();
    const branch = await current.target.client.findModelBranch(row.plan.request.targetModelId, row.branchName);
    if (branch?.id !== prior.branchId || branch.name !== row.branchName) fail('The reconciled review branch could not be identified. Inspect it in Omni before starting another review.');
    const yaml = await stableReviewYaml(current.target.client, row.plan.request.targetModelId, 'Branch', signal, prior.branchId);
    if (topicMigrationSnapshotHash(yaml.files) !== topicMigrationSnapshotHash(row.targetFiles)) {
      fail('The retained branch has changes after reconciliation. Inspect it in Omni before starting another review.');
    }
    reconciled.set(row.plan.id, hash({ row, job: prior.job }));
  }
  // Reads above can yield. Recheck durable claims before deciding to save a new
  // plan; a concurrent submission or altered audit must never be superseded.
  signal?.throwIfAborted();
  if (boundary(request) !== current.boundaryHash) fail('A saved instance changed during recovery verification.');
  history = readPlans(); candidates = candidatesFor(history);
  jobs = candidates.length ? listJobs(Number.MAX_SAFE_INTEGER) : [];
  const claimed = candidates.find(row => {
    if (verifiedStandalonePrewriteFailure(row, jobs)) return false;
    const prior = reconciledStandaloneNoWrite(row, jobs);
    return !prior || reconciled.get(row.plan.id) !== hash({ row, job: prior.job });
  });
  if (claimed) return getTopicMigrationPlan(claimed.plan.id);
  const existing = history.find((row) => row.plan.version === 2 && row.plan.executionProfile === BRANCH_PROFILE.profile
    && !row.claim && row.plan.expiresAt > Date.now() && hash(row.plan.request) === hash(request)
    && hash(row.plan.comparisonOnly) === hash(comparisonOnly)
    && hash(row.dashboardRepair) === hash(dashboardRepair) && row.boundaryHash === current.boundaryHash
    && hash({ files: row.plan.files, issues: row.plan.issues, sourceHash: row.plan.sourceHash, targetHash: row.plan.targetHash, tableNameEvidenceHash: row.plan.tableNameEvidenceHash, sqlDialectPolicy: row.plan.sqlDialectPolicy })
      === hash({ files: current.analysis.files, issues: current.analysis.issues, sourceHash: current.analysis.sourceHash, targetHash: current.analysis.targetHash, tableNameEvidenceHash: current.analysis.tableNameEvidenceHash, sqlDialectPolicy: current.analysis.sqlDialectPolicy }));
  if (existing) return getTopicMigrationPlan(existing.plan.id);
  const now = Date.now();
  const id = randomUUID();
  const plan: TopicMigrationPlan = { ...current.analysis, version: 2, executionProfile: BRANCH_PROFILE.profile,
    id, revision: '', request, createdAt: now, expiresAt: now + PLAN_TTL_MS,
    ...(comparisonOnly ? { comparisonOnly } : {}),
    ...(context ? { dashboardRepair: context } : {}),
    status: comparisonOnly || current.analysis.issues.some((issue) => issue.severity === 'blocker') || current.analysis.files.some((file) => file.status === 'blocked') ? 'blocked'
      : current.analysis.files.some((file) => file.status === 'create' || file.status === 'add') ? 'ready' : 'unchanged',
    dataLocations: { ...(current.sourceLocations !== undefined ? { source: current.sourceLocations } : {}),
      ...(current.targetLocations !== undefined ? { target: current.targetLocations } : {}) } };
  const supersedes = candidates.filter(row => reconciled.has(row.plan.id)).map(row => ({ planId: row.plan.id, jobId: row.plan.jobId! }));
  const row: StoredPlan = { plan, boundaryHash: current.boundaryHash, targetFiles: current.targetYaml.files,
    requiresPr: current.requiresPr, branchName: createTopicMigrationBranchName(now, history.map(prior => prior.branchName)), ...(dashboardRepair ? { dashboardRepair } : {}),
    ...(supersedes.length ? { supersedes } : {}) };
  plan.revision = proof(row);
  const details = { branchPreparation: BRANCH_PROFILE, topicMigration: binding(row),
    ...(dashboardRepair ? { dashboardRepair } : {}) };
  const sanitized = sanitizeJob({ sourceLabel: 'Branch review', postMigrationActions: [], items: [], details } as unknown as MigrationJob);
  if (!isDeepStrictEqual(sanitized.details, details)) {
    plan.status = 'blocked';
    plan.issues.push({ id: 'history-redaction-integrity', kind: 'validation', severity: 'blocker', title: 'Exact review evidence cannot be retained',
      message: 'History protection would change part of the approved package or provenance.', nextAction: 'Resolve exact-evidence storage before preparing this branch.', topicIds: request.topicIds });
    plan.revision = proof(row);
  }
  save(row);
  return plan;
}
function readOnlyComparison(id: string, request: TopicMigrationRequest, rows = readPlans()): NonNullable<TopicMigrationPlan['comparisonOnly']> {
  const prior = rows.find(row => row.plan.id === id);
  const sameScope = (row: StoredPlan) => !row.dashboardRepair && !row.plan.dashboardRepair
    && requestKeys.slice(0, 6).every(key => row.plan.request[key as keyof TopicMigrationRequest] === request[key as keyof TopicMigrationRequest])
    && hash([...row.plan.request.topicIds].sort()) === hash([...request.topicIds].sort());
  const currentBoundary = boundary(request);
  if (!prior || prior.plan.version !== 2 || prior.plan.executionProfile !== BRANCH_PROFILE.profile
    || (!prior.claim && prior.plan.status !== 'submitted') || !sameScope(prior) || prior.boundaryHash !== currentBoundary) {
    fail('A fresh comparison must reference a submitted standalone run for these exact instances, connections, models, and topics.');
  }
  // Fail closed on unavailable job history. No job status or verification receipt
  // is interpreted as permission to repeat a write, including missing jobs.
  listJobs(Number.MAX_SAFE_INTEGER);
  return { ofPlanId: id, priorRuns: rows.filter(row => sameScope(row) && row.boundaryHash === currentBoundary
    && (row.claim || row.plan.status === 'submitted')).map(row => ({ planId: row.plan.id,
      ...(row.plan.jobId ? { jobId: row.plan.jobId } : {}), branchName: row.branchName })).sort((a, b) => a.planId.localeCompare(b.planId)) };
}
export async function listTopicMigrationTopics(value: unknown, signal?: AbortSignal) {
  assertKeys(value, ['sourceInstanceId', 'sourceConnectionId', 'sourceModelId']);
  const instanceId = identifier(value.sourceInstanceId);
  const instance = getInstance(instanceId);
  if (!isVaultUnlocked() || !instance || !['source', 'both'].includes(instance.role)) fail('The saved source instance is unavailable or unauthorized.', 403);
  const connectionId = identifier(value.sourceConnectionId);
  const modelId = identifier(value.sourceModelId);
  const source = await ownedModel(instance, connectionId, modelId, signal);
  const yaml = confirmedYaml(await source.client.getModelYaml(modelId, { ...REVIEW_YAML_OPTIONS, signal }));
  signal?.throwIfAborted();
  return { topics: inventoryMigrationTopics(yaml.files), sourceHash: topicMigrationSnapshotHash(yaml.files) };
}
export async function createTopicMigrationPlan(value: unknown, signal?: AbortSignal): Promise<TopicMigrationPlan> {
  assertKeys(value, [...requestKeys, 'comparisonOfPlanId']);
  const { comparisonOfPlanId: rawComparison, ...input } = value;
  const comparisonOfPlanId = rawComparison === undefined ? undefined : identifier(rawComparison);
  const request = currentRequest(input);
  if (comparisonOfPlanId) readOnlyComparison(comparisonOfPlanId, request);
  const current = await evidence(request, signal);
  signal?.throwIfAborted();
  return persistPlan(request, current, undefined, undefined, signal, comparisonOfPlanId);
}

function approvedPackageAnalysis(request: TopicMigrationRequest, sourceFiles: Record<string, string>, targetYaml: OmniModelYamlResponse,
  accepted: ModelMigrationAcceptedFile[]): TopicMigrationAnalysis {
  const names = accepted.map((file) => file.fileName);
  if (!names.length || names.length > 200 || names.length !== new Set(names).size || names.some((name) => !fileName(name))) {
    fail('The dashboard handoff must contain a bounded, uniquely owned authored file package.');
  }
  const issues: TopicMigrationAnalysis['issues'] = [{ id: 'manual-omni-review', kind: 'validation', severity: 'review',
    title: 'Finalize this branch in Omni', message: 'SQL, physical table mappings, validation, and deployment are not performed by OmniKit.',
    nextAction: 'Review the prepared branch in Omni before deploying it.', topicIds: request.topicIds }];
  const files: TopicMigrationAnalysis['files'] = names.sort().map((name) => {
    const kind = name.endsWith('.topic') ? 'topic' : name.endsWith('.view') ? 'view' : /relationships?$/.test(name) ? 'relationships' : 'model';
    const before = targetYaml.files[name] ?? null;
    const supplied = accepted.find((file) => file.fileName === name)!;
    const proposed = supplied.yaml;
    let status: TopicMigrationAnalysis['files'][number]['status'] = 'blocked';
    try {
      if (before !== null && !targetYaml.checksums?.[name]) fail('An existing destination file has no authoritative checksum.');
      if (!proposed || proposed.length > 2_000_000) fail('A reviewed YAML file is unavailable or exceeds the bounded package limit.');
      if (supplied.previousChecksum !== targetYaml.checksums?.[name]) fail('An approved destination checksum changed.');
      assertDashboardRepairYamlPreservesTarget({ sourceYaml: proposed, targetYaml: before ?? undefined, acceptedYaml: proposed });
      status = before === proposed ? 'reuse' : before === null ? 'create' : 'add';
    } catch (error) {
      issues.push({ id: 'dashboard-file:' + name, kind: 'conflict', severity: 'blocker', title: 'Resolve the additive file conflict',
        message: error instanceof Error ? error.message : 'The file cannot be safely prepared.', nextAction: 'Recheck dashboard readiness or resolve this definition in Omni.',
        topicIds: request.topicIds, fileName: name });
    }
    return { sourceFileName: name, fileName: name, kind, topicIds: request.topicIds, before, proposed, status,
      ...(targetYaml.checksums?.[name] ? { previousChecksum: targetYaml.checksums[name] } : {}) };
  });
  if (JSON.stringify(files).length > 16_000_000) fail('The branch package exceeds the bounded review size. Split the dashboard scope.');
  return { topics: inventoryMigrationTopics(sourceFiles).filter((topic) => request.topicIds.includes(topic.id)), files, issues,
    dependencies: files.map((file) => ({ fileName: file.fileName, kind: file.kind, topicIds: request.topicIds, reasons: ['Required by the saved dashboard review.'] })),
    sourceHash: topicMigrationSnapshotHash(sourceFiles), targetHash: topicMigrationSnapshotHash(targetYaml.files) };
}

/** Read-only dashboard handoff: exact server-scoped additions use the same v2 review and stage contract. */
export async function createDashboardBranchPreparationPlan(value: unknown, signal?: AbortSignal): Promise<TopicMigrationPlan> {
  assertKeys(value, ['planId', 'targetId']);
  const planId = identifier(value.planId);
  const targetId = identifier(value.targetId);
  const deployment = getDashboardDeploymentPlan(planId);
  const context = { planId, targetId, revision: deployment.revision };
  const scope = resolveDashboardRepairScope(context);
  if (scope.target.repairJobId) fail('A repair job is already linked. Open that branch and recheck dashboard readiness.');
  if (scope.target.sourceModelIds.length !== 1) fail('This dashboard repair spans multiple source models. Split the dashboard scope or prepare its dependencies manually in Omni.');
  const sourceModelId = scope.target.sourceModelIds[0];
  const names = scope.target.requiredFilesByModelId[sourceModelId];
  if (!names?.length || names.length > 200 || new Set(names).size !== names.length || names.some((name) => !fileName(name))
    || hash([...names].sort()) !== hash([...scope.target.requiredFiles].sort())) fail('Required dependency file ownership is incomplete. Recheck dashboard readiness.');
  let topicIds = names.filter((name) => name.endsWith('.topic')).sort();
  if (!topicIds.length) {
    // A field-only repair can omit an already-present topic from requiredFiles.
    // Readiness records exact source candidates, but not per-candidate model ownership:
    // only a single verified source-model snapshot can disambiguate this fallback.
    const sourceModels = Object.keys(deployment.sourceModelHashes);
    const choices = scope.target.topicChoices;
    const cannotResolve = () => fail('Readiness does not prove the exact authored source topics for this field-only repair. Recheck dashboard readiness or select the exact topics in branch review.');
    if (sourceModels.length !== 1 || sourceModels[0] !== sourceModelId || !choices?.length) cannotResolve();
    topicIds = [...new Set(choices!.map((choice) => {
      if (!choice.documentIds.length || choice.documentIds.some((id) => !deployment.intent.source.documentIds.includes(id))) cannotResolve();
      const candidates = choice.sourceCandidates?.filter((candidate) => candidate.name === choice.sourceTopicName
        && candidate.fileName && fileName(candidate.fileName) && candidate.fileName.endsWith('.topic')) || [];
      if (candidates.length !== 1) cannotResolve();
      return candidates[0].fileName!;
    }))].sort();
  }
  const request: TopicMigrationRequest = { sourceInstanceId: deployment.intent.source.instanceId,
    sourceConnectionId: deployment.intent.source.connectionId, sourceModelId,
    targetInstanceId: scope.destination.instanceId, targetConnectionId: scope.destination.connectionId, targetModelId: scope.destination.modelId,
    topicIds, schemaMapText: '' };
  const current = await evidence(request, signal, undefined, false);
  if (dashboardSafeCopyStateHash(current.sourceYaml.files) !== deployment.sourceModelHashes[sourceModelId]
    || dashboardSafeCopyStateHash(current.targetYaml.files) !== scope.target.modelHash) fail('Source or destination YAML changed after dashboard readiness. Recheck the dashboard plan.');
  const binding = await readDashboardRepairSourceBinding({ sourceId: request.sourceInstanceId, targetId: request.targetInstanceId,
    targetModelId: request.targetModelId, sourceModelIds: Object.keys(deployment.sourceModelHashes),
    instanceBoundaryHash: dashboardRepairInstanceBoundaryHash(request.sourceInstanceId, request.targetInstanceId, request.targetModelId, Object.keys(deployment.sourceModelHashes)),
    sourceDocumentHashes: Object.fromEntries(deployment.intent.source.documentIds.map((id) => [id, deployment.sourceHashes[id]])),
    reviewedWorkbookCopies: deployment.workbookCopies || {} }, current.source.client);
  // The topic planner scopes relationship edges and shared fields and never transfers
  // model-global settings. Dashboard readiness is an additional write boundary,
  // not permission to copy the complete contents of every required source file.
  if (current.analysis.files.some((file) => ['create', 'add'].includes(file.status) && !names.includes(file.fileName))) {
    fail('Selected topic dependencies require changes outside the saved dashboard readiness scope. Recheck dashboard readiness or prepare the exact topics separately.');
  }
  const repair: NonNullable<ModelMigrationJobInput['dashboardRepair']> = { ...binding, ...context, additiveOnly: true,
    targetModelHash: scope.target.modelHash, sourceModelHashes: deployment.sourceModelHashes,
    sourceRelationInventoryHashes: { [sourceModelId]: readDashboardTopicRelationInventory(current.sourceYaml.raw).snapshotHash },
    targetRelationInventoryHash: readDashboardTopicRelationInventory(current.targetYaml.raw).snapshotHash,
    approvedFilesHash: dashboardSafeCopyStateHash(approvedAnalysisFiles(current.analysis)) };
  signal?.throwIfAborted();
  return persistPlan(request, current, repair, context, signal);
}

/** Called only after the proposed-topic service has verified its human-approved, server-cached diff. */
export async function stageApprovedDashboardBranchPreparation(input: ModelMigrationJobInput,
  createJob: (input: ModelMigrationJobInput) => Promise<MigrationJob>): Promise<MigrationJob> {
  if (!input.dashboardRepair || input.models.length !== 1 || input.content.length || input.postMigrationActions.length
    || input.replaceSameNamed || input.mergeAfterValidation || input.publishDrafts || input.deleteBranch || input.parentJobId) fail('The reviewed dashboard package contains unsupported operations.');
  const model = input.models[0];
  if (model.mode !== 'translate' || !model.acceptedFiles?.length || model.contentRepairActions?.length || model.semanticDecisions?.length) fail('The dashboard package must contain exact additive YAML only.');
  const source = getInstance(input.sourceId);
  if (!source) fail('The reviewed source instance is unavailable.');
  const models = (await readClient(source).listModels({ modelKind: 'SHARED' })).filter((candidate) => candidate.id === model.sourceModelId && !candidate.deletedAt);
  if (models.length !== 1 || !models[0].connectionId) fail('The reviewed source model does not have a unique connection binding.');
  const request: TopicMigrationRequest = { sourceInstanceId: input.sourceId, sourceConnectionId: models[0].connectionId, sourceModelId: model.sourceModelId,
    targetInstanceId: input.targetId, targetConnectionId: model.targetConnectionId, targetModelId: model.targetModelId,
    topicIds: model.acceptedFiles.filter((file) => file.fileName.endsWith('.topic')).map((file) => file.fileName).sort(), schemaMapText: '' };
  const current = await evidence(request, undefined, undefined, false);
  current.analysis = approvedPackageAnalysis(request, current.sourceYaml.files, current.targetYaml, model.acceptedFiles);
  flagNonWritableTarget(current.analysis, current.target.model.gitFollower, request.topicIds);
  if (dashboardSafeCopyStateHash(model.acceptedFiles.map(({ fileName, yaml, previousChecksum }) => ({ fileName, yaml, previousChecksum }))) !== input.dashboardRepair.approvedFilesHash) fail('The proposed-topic files differ from the exact reviewed package.');
  const plan = await persistPlan(request, current, { ...input.dashboardRepair, approvedFilesHash: dashboardSafeCopyStateHash(approvedAnalysisFiles(current.analysis)) });
  const result = await stageTopicMigrationPlan(plan.id, { revision: plan.revision, approve: true }, createJob);
  return result.job;
}
export function getTopicMigrationPlan(id: string): TopicMigrationPlan {
  const row = load(id);
  if (boundary(row.plan.request) !== row.boundaryHash) fail('The saved authority for this topic plan changed. Prepare a fresh review before accessing its evidence.');
  if (row.plan.version !== 2 || row.plan.executionProfile !== BRANCH_PROFILE.profile) return { ...row.plan,
    status: row.claim || row.plan.status === 'submitted' ? 'submitted' : 'blocked', issues: [...row.plan.issues,
      { id: 'legacy-read-only', kind: 'validation', severity: 'blocker', title: 'Historical plan — read only',
        message: 'This plan cannot create, publish, or replay migration work.', nextAction: row.claim || row.plan.status === 'submitted'
          ? 'Inspect the existing branch and reconcile its result in Omni.' : 'Prepare a fresh branch-only review.',
        topicIds: row.plan.request.topicIds }] };
  const receipt = row.plan.jobId ? getJob(row.plan.jobId)?.details?.branchReceipt as TopicMigrationPlan['branchReceipt'] : undefined;
  if (receipt) row.plan = { ...row.plan, branchReceipt: receipt };
  if (row.claim && row.plan.status !== 'submitted') return { ...row.plan, status: 'submitted', issues: [...row.plan.issues,
    { id: 'submission-reconciliation', kind: 'validation', severity: 'blocker', title: 'Submission needs reconciliation', message: 'A one-use submission started without a linked job receipt.', nextAction: 'Reconcile the job history before authorizing another submission.', topicIds: row.plan.request.topicIds }] };
  if (row.plan.expiresAt <= Date.now() && row.plan.status !== 'submitted') return { ...row.plan, status: 'blocked', issues: [...row.plan.issues,
    { id: 'expired', kind: 'validation', severity: 'blocker', title: row.plan.comparisonOnly ? 'Comparison expired' : 'Review expired', message: 'This review is older than 15 minutes.', nextAction: row.plan.comparisonOnly ? 'Recheck comparison. This comparison cannot authorize writes.' : 'Prepare and approve a fresh plan.', topicIds: row.plan.request.topicIds }] };
  return row.plan;
}
function approvedFiles(row: StoredPlan): ModelMigrationAcceptedFile[] {
  return approvedAnalysisFiles(row.plan);
}
function approvedAnalysisFiles(analysis: Pick<TopicMigrationAnalysis, 'files'>): ModelMigrationAcceptedFile[] {
  return analysis.files.filter((file) => file.status === 'create' || file.status === 'add').map((file) => ({ fileName: file.fileName, yaml: file.proposed,
    ...(file.previousChecksum ? { previousChecksum: file.previousChecksum } : {}) })).sort((a, b) => a.fileName.localeCompare(b.fileName));
}
function binding(row: StoredPlan): TopicMigrationExecutionBinding {
  return { planId: row.plan.id, revision: row.plan.revision, request: row.plan.request, sourceHash: row.plan.sourceHash,
    targetHash: row.plan.targetHash, filesHash: hash(approvedFiles(row)), instanceBoundaryHash: row.boundaryHash, topicIds: row.plan.request.topicIds };
}
function executionInput(row: StoredPlan): ModelMigrationJobInput {
  const request = row.plan.request;
  return { branchPreparation: BRANCH_PROFILE, ...(row.dashboardRepair ? { dashboardRepair: row.dashboardRepair } : {}), topicMigration: binding(row),
    sourceId: request.sourceInstanceId, targetId: request.targetInstanceId,
    models: [{ sourceModelId: request.sourceModelId, targetModelId: request.targetModelId, targetConnectionId: request.targetConnectionId,
      mode: 'translate', branchName: row.branchName, acceptedFiles: approvedFiles(row), mergeHandoffRequired: row.requiresPr }],
    content: [], postMigrationActions: [], replaceSameNamed: false, mergeAfterValidation: false, publishDrafts: false, deleteBranch: false };
}
function assertFresh(row: StoredPlan): void {
  if (row.plan.comparisonOnly) fail('This fresh comparison is read-only. It cannot create a branch, replay, or replace the prior run. Open the saved run to review its outcome.');
  if (row.plan.version !== 2 || row.plan.executionProfile !== BRANCH_PROFILE.profile) fail('Historical migration plans are read-only. Prepare a fresh branch-only review.');
  // Expiry bounds a new approval. An already-linked job retains its authority,
  // subject to fresh source/main/branch evidence before every actual mutation.
  if (row.plan.status !== 'submitted' && row.plan.expiresAt <= Date.now()) fail('This topic approval expired. Prepare and approve a fresh plan.');
  if (boundary(row.plan.request) !== row.boundaryHash) fail('The saved source/destination authority changed after topic review.');
}
function assertInput(row: StoredPlan, input: ModelMigrationJobInput): void {
  const request = row.plan.request;
  if (!input || !Array.isArray(input.models)) fail('The approved model job binding is missing.');
  const model = input.models[0];
  if (hash(input.topicMigration) !== hash(binding(row)) || input.sourceId !== request.sourceInstanceId || input.targetId !== request.targetInstanceId
    || input.models.length !== 1 || !model || model.sourceModelId !== request.sourceModelId || model.targetModelId !== request.targetModelId
    || model.targetConnectionId !== request.targetConnectionId || model.branchName !== row.branchName || model.mode !== 'translate'
    || model.mergeHandoffRequired !== row.requiresPr || hash(model.acceptedFiles) !== hash(approvedFiles(row))
    || model.contentRepairActions?.length || model.semanticDecisions?.length || input.content.length || input.postMigrationActions.length
    || input.replaceSameNamed !== false || input.mergeAfterValidation !== false || input.publishDrafts !== false || input.deleteBranch !== false
    || hash(input.dashboardRepair) !== hash(row.dashboardRepair) || hash(input.branchPreparation) !== hash(BRANCH_PROFILE) || input.parentJobId) fail('The topic job differs from its exact server-approved files, model pair, or permitted operations.');
}
export function consumeTopicMigrationSubmission(input: ModelMigrationJobInput): void {
  if (!input.topicMigration) return;
  if (!submissions.delete(input)) fail('Topic jobs must be submitted through their saved one-use plan approval.');
  const row = load(input.topicMigration.planId);
  assertFresh(row);
  if (!row.claim || row.plan.status !== 'ready' || row.plan.jobId) fail('This topic approval has already been used.');
  assertInput(row, input);
}
export function linkSubmittedTopicMigrationJob(job: MigrationJob, input: ModelMigrationJobInput): void {
  const authority = job.details?.topicMigration as TopicMigrationExecutionBinding | undefined;
  if (!authority) return;
  const row = load(authority.planId);
  if (row.plan.comparisonOnly) fail('A read-only comparison cannot authorize a migration job.');
  if (!row.claim || row.plan.status !== 'ready' || row.plan.jobId || hash(authority) !== hash(binding(row))) fail('The topic plan cannot authorize another staging job.');
  assertInput(row, input);
  row.plan.status = 'submitted';
  row.plan.jobId = job.id;
  save(row);
}
export async function stageTopicMigrationPlan(id: string, value: unknown, createJob: (input: ModelMigrationJobInput) => Promise<MigrationJob>, signal?: AbortSignal) {
  assertKeys(value, ['revision', 'approve']);
  if (value.approve !== true || typeof value.revision !== 'string') fail('Approve the exact reviewed plan revision before staging.', 400);
  if (busy.has(id)) fail('This topic plan is already being submitted. Wait for its existing job.');
  busy.add(id);
  try {
    const row = load(id);
    if (row.plan.revision !== value.revision) fail('The topic review revision changed. Reopen the current plan.');
    assertFresh(row);
    const existing = listJobs(Number.MAX_SAFE_INTEGER).filter((job) => (job.details?.topicMigration as TopicMigrationExecutionBinding | undefined)?.planId === id);
    if (row.plan.status === 'submitted' && row.plan.jobId && existing.length === 1 && existing[0].id === row.plan.jobId) {
      assertTopicMigrationWriteAuthority(existing[0]);
      return { plan: row.plan, job: existing[0] };
    }
    if (row.claim || existing.length) fail('This plan has a prior or uncertain submission. Reconcile the existing job; another branch will not be created.');
    if (row.plan.status !== 'ready') fail('Resolve all topic blockers and review a changed file set before staging.');
    const current = await evidence(row.plan.request, signal, row);
    assertEvidence(row, current);
    const input = executionInput(row);
    signal?.throwIfAborted();
    row.claim = randomUUID();
    save(row); // Persist the one-use claim before a job or tenant mutation can exist.
    submissions.add(input);
    try {
      const submit = async (link?: (jobId: string) => unknown) => {
        const job = await createJob(input);
        if (link) link(job.id);
        return job;
      };
      const job = row.plan.dashboardRepair
        ? await withDashboardRepairSubmission(row.plan.dashboardRepair, (link) => submit(link)) : await submit();
      const linked = load(id);
      if (linked.plan.status !== 'submitted' || linked.plan.jobId !== job.id) fail('The topic job outcome needs reconciliation. No further submission is authorized.');
      return { job, plan: linked.plan };
    } finally { submissions.delete(input); }
  } finally { busy.delete(id); }
}

function branchVerificationCandidate(row: StoredPlan, jobs: MigrationJob[]) {
  assertFresh(row);
  if (row.dashboardRepair || row.plan.dashboardRepair) fail('Read-only branch recovery currently supports standalone topic plans only. Recheck dashboard provenance through its reviewed workflow.');
  const linked = jobs.filter(job => job.id === row.plan.jobId
    || (job.details?.topicMigration as TopicMigrationExecutionBinding | undefined)?.planId === row.plan.id);
  if (row.plan.status !== 'submitted' || !row.claim || !row.plan.jobId || linked.length !== 1 || linked[0].id !== row.plan.jobId) {
    fail('An exact submitted plan and unique saved job are required to check this branch.');
  }
  const job = linked[0];
  assertMigrationJobIdle(job.id);
  assertTopicMigrationWriteAuthority(job);
  const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (job.workflow !== 'model' || !['partial', 'failed'].includes(job.status) || !positive(job.endedAt)
    || job.details?.branchReceipt !== undefined || row.plan.branchReceipt !== undefined
    || new Set(job.items.map(item => item.id)).size !== job.items.length
    || job.items.some(item => item.jobId !== job.id || ['pending', 'running', 'warning'].includes(item.status)
      || item.details?.branchReceipt !== undefined)
    || Object.hasOwn(job.details || {}, 'migrationMutationAdjudications')) fail('This run is not eligible for read-only completed-write verification. Reconcile unfinished or uncertain writes first.');
  const create = job.items.find(item => item.kind === 'model_branch_create')!;
  const write = job.items.find(item => item.kind === 'model_yaml_write')!;
  const verify = job.items.find(item => item.kind === 'model_branch_verify')!;
  const owners = job.items.filter(item => item.kind === 'destination_model_mutation' || Object.hasOwn(item.details || {}, 'migrationDestinationModelMutation'));
  if (owners.length !== 1 || owners[0].kind !== 'destination_model_mutation') fail('A unique resolved destination lease is required.');
  const owner = owners[0], lease = migrationDestinationModelMutationLease(owner);
  const branchId = create.details?.branchId;
  if (create.status !== 'succeeded' || create.error || write.status !== 'succeeded' || write.error || verify.status !== 'failed'
    || typeof branchId !== 'string' || !branchId || branchId !== branchId.trim() || branchId.length > 1024
    || [...branchId].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || write.details?.branchId !== branchId || create.details?.branchName !== row.branchName || write.details?.branchName !== row.branchName
    || !positive(write.endedAt) || write.endedAt > job.endedAt
    || !lease || lease.jobId !== job.id || lease.state !== 'resolved' || lease.operation !== 'model_job'
    || owner.status !== 'succeeded' || owner.error || owner.endedAt !== lease.updatedAt
    || lease.destinationInstanceId !== row.plan.request.targetInstanceId || lease.targetModelId !== row.plan.request.targetModelId
    || !positive(lease.revision) || !positive(lease.dispatchedAt) || lease.dispatchedAt > write.endedAt
    || lease.updatedAt < write.endedAt || lease.updatedAt > job.endedAt
    || lease.dispatchItemId !== write.id || lease.dispatchItemKind !== 'model_yaml_write' || !/^[a-f0-9]{64}$/.test(lease.dispatchFingerprint || '')
    || Object.keys(owner.details || {}).some(key => /^migrationMutation(?:External|Resolution|Adjudication)/.test(key))) {
    fail('Successful branch creation and file copying with a normally resolved matching lease are required. This operation cannot clear uncertain writes.');
  }
  if (job.items.find(item => item.kind === 'model_translate')?.status !== 'succeeded') fail('The original approved scope was not completed.');
  return { job, branchId };
}

function verificationScopes(row: StoredPlan): MigrationDestinationModelScope[] {
  const target = instances(row.plan.request).target;
  const origin = new URL(target.baseUrl).origin;
  return listInstances().filter(instance => new URL(instance.baseUrl).origin === origin)
    .map(instance => ({ destinationInstanceId: instance.id, targetModelId: row.plan.request.targetModelId }))
    .sort((a, b) => a.destinationInstanceId.localeCompare(b.destinationInstanceId));
}

/** Identity/provenance seam only. A correction requires its own live review and approval. */
export function getTopicBranchCorrectionOrigin(id: string) {
  const row = load(id);
  assertFresh(row);
  if (row.dashboardRepair || row.plan.dashboardRepair || row.plan.status !== 'submitted' || !row.claim || !row.plan.jobId) {
    fail('Open a submitted standalone topic migration before reviewing branch corrections.');
  }
  const matches = listJobs(Number.MAX_SAFE_INTEGER).filter(job => job.id === row.plan.jobId
    || (job.details?.topicMigration as TopicMigrationExecutionBinding | undefined)?.planId === id);
  if (matches.length !== 1 || matches[0].id !== row.plan.jobId) fail('The original migration history is ambiguous.');
  const job = matches[0];
  assertMigrationJobIdle(job.id);
  assertTopicMigrationWriteAuthority(job);
  const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const creates = job.items.filter(item => item.kind === 'model_branch_create');
  const writes = job.items.filter(item => item.kind === 'model_yaml_write');
  const create = creates[0], write = writes[0];
  const verify = job.items.find(item => item.kind === 'model_branch_verify');
  const branchId = create?.details?.branchId;
  if (creates.length !== 1 || writes.length !== 1 || create.status !== 'succeeded' || write.status !== 'succeeded'
    || create.error || write.error || !verify || !positive(job.endedAt) || !positive(write.endedAt) || write.endedAt > job.endedAt
    || typeof branchId !== 'string' || !branchId || branchId !== branchId.trim() || branchId.length > 1024
    || [...branchId].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || create.details?.branchName !== row.branchName
    || write.details?.branchId !== branchId || write.details?.branchName !== row.branchName
    || new Set(job.items.map(item => item.id)).size !== job.items.length
    || job.items.some(item => item.jobId !== job.id || ['pending', 'running', 'warning'].includes(item.status))
    || Object.hasOwn(job.details || {}, 'migrationMutationAdjudications')) fail('The original branch and completed file writes are not uniquely established.');
  const owners = job.items.filter(item => item.kind === 'destination_model_mutation' || Object.hasOwn(item.details || {}, 'migrationDestinationModelMutation'));
  const owner = owners[0], lease = owner && migrationDestinationModelMutationLease(owner);
  if (owners.length !== 1 || owner.kind !== 'destination_model_mutation' || !lease || lease.state !== 'resolved'
    || lease.jobId !== job.id || lease.operation !== 'model_job' || owner.status !== 'succeeded' || owner.error
    || owner.endedAt !== lease.updatedAt || lease.destinationInstanceId !== row.plan.request.targetInstanceId
    || lease.targetModelId !== row.plan.request.targetModelId || !positive(lease.revision) || !positive(lease.dispatchedAt)
    || lease.dispatchedAt > write.endedAt || lease.updatedAt < write.endedAt || lease.updatedAt > job.endedAt
    || lease.dispatchItemId !== write.id || lease.dispatchItemKind !== 'model_yaml_write' || !/^[a-f0-9]{64}$/.test(lease.dispatchFingerprint || '')
    || Object.keys(owner.details || {}).some(key => /^migrationMutation(?:External|Resolution|Adjudication)/.test(key))) {
    fail('The original successful YAML write and normally resolved matching lease must be established first.');
  }
  if (job.status === 'succeeded') {
    const receipt = job.details?.branchReceipt;
    if (job.items.some(item => item.status !== 'succeeded' || item.error) || !record(receipt)
      || receipt.modelId !== row.plan.request.targetModelId || receipt.branchId !== branchId || receipt.branchName !== row.branchName
      || verify.details?.modelId !== row.plan.request.targetModelId || verify.details?.branchId !== branchId
      || verify.details?.branchName !== row.branchName || !positive(verify.details?.verifiedAt)
      || verify.details.verifiedAt > job.endedAt) fail('The original prepared-branch receipt is incomplete.');
  } else {
    branchVerificationCandidate(row, [job]);
    const audits = job.details?.branchVerifications;
    if (!Array.isArray(audits) || !audits.length || audits.length > 100 || audits.some(audit => !record(audit))
      || new Set(audits.map(audit => audit.requestId)).size !== audits.length) fail('Verify the original copied files before reviewing corrections.');
    const audit = audits[audits.length - 1] as BranchVerificationRecord;
    const expected = compareTopicMigrationBranch({ files: row.plan.files, schemaMapText: row.plan.request.schemaMapText,
      baseline: row.targetFiles, actual: {} });
    const evidenceJob = { ...job, details: Object.fromEntries(Object.entries(job.details || {}).filter(([key]) => key !== 'branchVerifications')) };
    const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
    if (audit.version !== 1 || audit.policy !== expected.policy || audit.verified !== true
      || typeof audit.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(audit.requestId)
      || audit.planId !== id || audit.planRevision !== row.plan.revision || audit.jobId !== job.id
      || audit.targetInstanceId !== row.plan.request.targetInstanceId || audit.modelId !== row.plan.request.targetModelId
      || audit.branchId !== branchId || audit.branchName !== row.branchName || !positive(audit.verifiedAt) || audit.verifiedAt < job.endedAt
      || audit.sourceHash !== row.plan.sourceHash || audit.mainHash !== row.plan.targetHash
      || audit.expectedHash !== expected.expectedHash || audit.jobEvidenceHash !== 'sha256:' + hash(evidenceJob) || !digest(audit.actualHash)
      || !Array.isArray(audit.findings) || audit.findings.length || !Array.isArray(audit.files) || !audit.files.length
      || audit.files.length !== expected.files.length || audit.files.some((file, index) => !record(file)
        || file.sourceFileName !== expected.files[index].sourceFileName || file.submittedFileName !== expected.files[index].submittedFileName
        || file.destinationFileName !== expected.files[index].destinationFileName
        || !['exact', 'mapped_path', 'formatting_only', 'mapped_path_and_formatting'].includes(file.classification))) {
      fail('The latest original branch verification is missing, failed, or no longer exactly bound. Verify it before reviewing corrections.');
    }
    // This audit proves the original write only. Later approved corrections do
    // not rewrite it; the correction service must independently read the current branch.
  }
  return { plan: row.plan, jobId: job.id, boundaryHash: row.boundaryHash,
    branch: { modelId: row.plan.request.targetModelId, branchId, branchName: row.branchName },
    scopes: verificationScopes(row) };
}

function assertVerificationScopeIdle(scopes: MigrationDestinationModelScope[], jobs: MigrationJob[], verifiedJobId: string): void {
  const aliases = new Set(scopes.map(scope => scope.destinationInstanceId)), modelId = scopes[0]?.targetModelId;
  if (!modelId || !aliases.size) fail('The destination model authority is unavailable.');
  const knownInstances = new Set(listInstances().map(instance => instance.id));
  for (const alias of aliases) {
    if (dashboardSafeCopyHasUnresolvedDestinationModelOverlap(alias, [modelId], jobs)) fail('Another destination write still requires reconciliation.');
  }
  for (const job of jobs) {
    const matches = (instanceId: string | undefined, targetModelId: string | undefined) =>
      (!instanceId || aliases.has(instanceId) || !knownInstances.has(instanceId)) && (!targetModelId || targetModelId === modelId);
    const scopedItems = job.items.filter(item => matches(item.destinationId, item.targetModelId));
    const scoped = scopedItems.length || job.targets?.some(target => matches(target.destinationInstanceId, target.targetModelId));
    if (!scoped) continue;
    assertMigrationJobIdle(job.id);
    if (job.id !== verifiedJobId && (['pending', 'running'].includes(job.status) || scopedItems.some(item => ['pending', 'running'].includes(item.status)))) {
      fail('Another operation is active in this destination model. Wait before checking the branch.');
    }
    for (const item of scopedItems) {
      if (item.kind !== 'destination_model_mutation' && !Object.hasOwn(item.details || {}, 'migrationDestinationModelMutation')) continue;
      const lease = migrationDestinationModelMutationLease(item);
      if (!lease || !['resolved', 'failed_prewrite'].includes(lease.state)) fail('A destination write is unresolved or its lease evidence is incomplete.');
    }
  }
}

async function readBranchVerificationEvidence(row: StoredPlan, signal?: AbortSignal) {
  if (topicMigrationSnapshotHash(row.targetFiles) !== row.plan.targetHash) {
    throw new TopicEvidenceReadError({ code: 'APPROVED_BASELINE_INVALID',
      message: 'The original destination snapshot does not match its recorded approval hash. Restore the saved evidence before checking the branch.' });
  }
  const request = row.plan.request, pair = instances(request);
  const [source, target] = await Promise.all([
    ownedModel(pair.source, request.sourceConnectionId, request.sourceModelId, signal),
    ownedModel(pair.target, request.targetConnectionId, request.targetModelId, signal),
  ]);
  const requiresPr = target.model.pullRequestRequired === true || target.model.gitProtected === true || target.model.gitFollower === true;
  if (boundary(request) !== row.boundaryHash || requiresPr !== row.requiresPr) {
    throw new TopicEvidenceReadError({ code: 'APPROVED_AUTHORITY_CHANGED',
      message: 'The saved instance or protected-model authority changed. Restore or review that authority before checking the recorded branch.' });
  }
  const [sourceYaml, targetYaml] = await Promise.all([
    stableReviewYaml(source.client, request.sourceModelId, 'Source', signal),
    stableReviewYaml(target.client, request.targetModelId, 'Destination', signal),
  ]);
  const findings = destinationChanges(row.targetFiles, targetYaml.files);
  if (topicMigrationSnapshotHash(sourceYaml.files) !== row.plan.sourceHash) findings.unshift({ code: 'SOURCE_MODEL_CHANGED',
    message: 'The source model changed after the original review. Copied files are compared against the original approved package, not the new source.' });
  for (const file of approvedFiles(row)) {
    if (file.previousChecksum !== targetYaml.checksums?.[file.fileName]
      || (targetYaml.files[file.fileName] !== undefined && !file.previousChecksum)) findings.push({ code: 'DESTINATION_CHECKSUM_CHANGED',
      ...diagnosticFileName(file.fileName), message: 'An approved destination checksum changed or is missing. The original approval has not been updated.' });
  }
  // Do not rebuild historical approvals with a newer planner; their original
  // bytes remain the comparison authority. Drift permits observation, not a
  // verified receipt, reapproval, correction dispatch, or replay of any writes.
  return { target, findings };
}

/** Read tenant evidence only. Never enter the executor, replay a write, or alter original job/step outcomes. */
export async function verifyTopicMigrationBranch(id: string, value: unknown, signal?: AbortSignal): Promise<{
  plan: TopicMigrationPlan; job: MigrationJob; verification: BranchVerificationRecord;
}> {
  assertKeys(value, ['revision', 'requestId']);
  if (typeof value.revision !== 'string' || typeof value.requestId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId)) fail('An exact plan revision and new canonical verification request ID are required.', 400);
  if (busy.has(id)) fail('This plan already has an active request. Wait for its saved result.');
  busy.add(id);
  let release: (() => void) | undefined;
  try {
    const row = load(id);
    if (row.plan.revision !== value.revision) fail('The reviewed plan revision changed. Reopen the saved plan.');
    const jobs = listJobs(Number.MAX_SAFE_INTEGER);
    const { job, branchId } = branchVerificationCandidate(row, jobs);
    const scopes = verificationScopes(row);
    assertVerificationScopeIdle(scopes, jobs, job.id);
    const prior = job.details?.branchVerifications;
    if (prior !== undefined && (!Array.isArray(prior) || prior.length > 100 || prior.some(audit => !record(audit)
      || audit.version !== 1 || audit.planId !== row.plan.id || audit.planRevision !== row.plan.revision || audit.jobId !== job.id))) {
      fail('Saved branch-verification history is malformed. Preserve it for review.');
    }
    const audits = (prior || []) as BranchVerificationRecord[];
    if (new Set(audits.map(audit => audit.requestId)).size !== audits.length) fail('Saved verification request identities are ambiguous.');
    const existing = audits.find(audit => audit.requestId === value.requestId);
    if (existing) return { plan: getTopicMigrationPlan(id), job, verification: existing };
    if (audits.length >= 100) fail('This run has reached its bounded verification-history capacity.');
    release = reserveMigrationDestinationModels('topic-branch-verification:' + value.requestId, scopes);
    const originalRowHash = hash(row), originalJobHash = hash(job);
    const originalScopesHash = hash(scopes);
    const evidenceJob = { ...job, details: Object.fromEntries(Object.entries(job.details || {}).filter(([key]) => key !== 'branchVerifications')) };
    const initial = compareTopicMigrationBranch({ files: row.plan.files, schemaMapText: row.plan.request.schemaMapText, baseline: row.targetFiles, actual: {} });
    let comparison: TopicBranchComparison = { ...initial, verified: false, actualHash: null,
      files: [],
      findings: [{ code: 'VERIFICATION_READ_FAILED', message: 'Authoritative source, destination, or branch evidence could not be verified. No tenant writes were attempted.' }] };
    try {
      signal?.throwIfAborted();
      const { target, findings } = await readBranchVerificationEvidence(row, signal);
      comparison.findings = [...findings, ...comparison.findings];
      const branch = await target.client.findModelBranch(row.plan.request.targetModelId, row.branchName);
      if (branch?.id !== branchId || branch.name !== row.branchName) {
        comparison.findings = [...findings, { code: 'BRANCH_IDENTITY_CHANGED', message: 'The recorded branch identity is missing or changed. Inspect it in Omni.' }];
      } else {
        const actual = await stableReviewYaml(target.client, row.plan.request.targetModelId, 'Branch', signal, branchId);
        const readback = compareTopicMigrationBranch({ files: row.plan.files, schemaMapText: row.plan.request.schemaMapText,
          baseline: row.targetFiles, actual: actual.files });
        comparison = { ...readback, verified: readback.verified && findings.length === 0,
          findings: [...findings, ...readback.findings] };
      }
    } catch (error) {
      if (error instanceof JobHistoryUnavailableError) throw error;
      signal?.throwIfAborted();
      if (error instanceof TopicEvidenceReadError) comparison.findings = [
        ...comparison.findings.filter(finding => finding.code !== 'VERIFICATION_READ_FAILED'), error.finding,
      ];
      // Untrusted read errors are not persisted as authoritative findings or leaked tenant payloads.
    }
    signal?.throwIfAborted();
    const latestRow = load(id), latestJobs = listJobs(Number.MAX_SAFE_INTEGER);
    const latest = branchVerificationCandidate(latestRow, latestJobs);
    if (hash(latestRow) !== originalRowHash || hash(latest.job) !== originalJobHash || hash(verificationScopes(latestRow)) !== originalScopesHash
      || boundary(row.plan.request) !== row.boundaryHash) {
      fail('The plan, job, or destination authority changed during verification. Check the saved run again.');
    }
    assertVerificationScopeIdle(scopes, latestJobs, job.id);
    const verification: BranchVerificationRecord = { ...comparison,
      findings: comparison.findings.map(finding => ({ ...finding, message: redactSensitiveText(finding.message) })), version: 1, requestId: value.requestId,
      planId: row.plan.id, planRevision: row.plan.revision, jobId: job.id, targetInstanceId: row.plan.request.targetInstanceId,
      modelId: row.plan.request.targetModelId, branchId, branchName: row.branchName, verifiedAt: Date.now(),
      sourceHash: row.plan.sourceHash, mainHash: row.plan.targetHash, jobEvidenceHash: 'sha256:' + hash(evidenceJob) };
    const updated = updateJobAtomically(job.id, current => {
      if (hash(current) !== originalJobHash) fail('The saved job changed before verification could be recorded.');
      const next = { ...current, details: { ...current.details, branchVerifications: [...audits, verification] } };
      if (!isDeepStrictEqual(sanitizeJob(next).details?.branchVerifications, next.details.branchVerifications)) {
        fail('Exact branch-verification evidence cannot be retained safely. No receipt was recorded.');
      }
      return next;
    });
    if (!updated) fail('The saved job disappeared before verification could be recorded.');
    return { plan: getTopicMigrationPlan(id), job: updated, verification };
  } finally { release?.(); busy.delete(id); }
}

function assertEvidence(row: StoredPlan, current: Awaited<ReturnType<typeof evidence>>): void {
  const next = 'Recheck differences before a new approval. If this run already created a branch, review that existing branch without repeating its writes.';
  if (current.boundaryHash !== row.boundaryHash || current.requiresPr !== row.requiresPr) {
    fail('Saved instance or protected-model authority changed after review. ' + next);
  }
  if (current.analysis.sourceHash !== row.plan.sourceHash) fail('Source model definitions changed after review. ' + next);
  if (current.analysis.targetHash !== row.plan.targetHash) {
    const changes = destinationChanges(row.targetFiles, current.targetYaml.files);
    const details = changes.slice(0, 8).map(change => `${change.code}${change.fileName ? `: ${change.fileName}` : ''}`).join('; ');
    fail('Destination model definitions changed after review. ' + details + '. ' + next);
  }
  if (current.analysis.tableNameEvidenceHash !== row.plan.tableNameEvidenceHash
    || hash(current.analysis.sqlDialectPolicy) !== hash(row.plan.sqlDialectPolicy)
    || hash(current.analysis.files) !== hash(row.plan.files) || current.analysis.issues.some((issue) => issue.severity === 'blocker')) {
    fail('Reviewed file, compatibility, or dependency evidence changed after review. ' + next);
  }
  for (const file of approvedFiles(row)) {
    if (file.previousChecksum !== current.targetYaml.checksums?.[file.fileName]
      || (current.targetYaml.files[file.fileName] !== undefined && !file.previousChecksum)) fail('A destination checksum changed or is unavailable. ' + next);
  }
}
export function assertTopicMigrationWriteAuthority(job: MigrationJob): StoredPlan | undefined {
  const authority = job.details?.topicMigration as TopicMigrationExecutionBinding | undefined;
  if (!authority) {
    if (job.workflow !== 'model') return undefined;
    fail('Model execution requires a saved branch-preparation approval.');
  }
  const row = load(authority.planId);
  assertFresh(row);
  if (row.plan.status !== 'submitted' || row.plan.jobId !== job.id || hash(authority) !== hash(binding(row))) fail('The durable topic approval does not authorize this job.');
  const compact = job.details?.fileEvidence === 'reviewed_plan_v1';
  if (compact && job.details?.retryInput !== undefined) fail('Unexpected executable payload in topic job history.');
  if (!compact) assertInput(row, job.details?.retryInput as ModelMigrationJobInput);
  const allowed = new Set(['model_translate', 'model_branch_create', 'model_yaml_write', 'model_branch_verify', 'destination_model_mutation']);
  if (hash(job.details?.branchPreparation) !== hash(BRANCH_PROFILE) || hash(job.details?.dashboardRepair) !== hash(row.dashboardRepair)
    || job.sourceId !== row.plan.request.sourceInstanceId || job.destinationIds.length !== 1 || job.destinationIds[0] !== row.plan.request.targetInstanceId
    || job.emptyFirst || job.replaceSameNamed || job.deleteSourceOnSuccess || job.documentIds.length || job.postMigrationActions.length
    || job.items.some((item) => !allowed.has(item.kind) || item.destinationId !== row.plan.request.targetInstanceId || item.targetModelId !== row.plan.request.targetModelId)) fail('The topic job contains an unauthorized operation or destination.');
  for (const item of job.items.filter((candidate) => candidate.kind !== 'destination_model_mutation')) {
    if (item.details?.sourceModelId !== row.plan.request.sourceModelId || item.details?.targetModelId !== row.plan.request.targetModelId
      || item.details?.branchName !== row.branchName
      || (item.kind === 'model_branch_create' && item.details?.targetConnectionId !== row.plan.request.targetConnectionId)) {
      fail('A topic job step no longer matches its approved model pair and working branch.');
    }
  }
  const writes = job.items.filter((item) => item.kind === 'model_yaml_write');
  if (['model_translate', 'model_branch_create', 'model_yaml_write', 'model_branch_verify'].some((kind) => job.items.filter((item) => item.kind === kind).length !== 1)) fail('The branch preparation has missing or duplicated execution steps.');
  const write = writes[0].details;
  const files = approvedFiles(row);
  const matchesApproval = compact
    ? write?.files === undefined && write?.acceptedFileCount === files.length
    : hash(write?.files) === hash(files);
  if (!matchesApproval) fail('The staged file evidence differs from the exact approved topic files.');
  return row;
}
/** Rehydrate execution bytes from the revision-checked private review, never from a history entry. */
export function reviewedTopicMigrationWrite(job: MigrationJob) {
  const row = assertTopicMigrationWriteAuthority(job);
  if (!row) fail('The reviewed destination baseline is unavailable.');
  return { model: row.plan.request, branchName: row.branchName, files: approvedFiles(row), destinationFiles: row.targetFiles };
}
export async function assertTopicMigrationDispatch(job: MigrationJob, targetModelId: string, target: OmniClient, options: { branchId?: string; afterWrite?: boolean } = {}): Promise<void> {
  const row = assertTopicMigrationWriteAuthority(job);
  if (!row) return;
  if (targetModelId !== row.plan.request.targetModelId) fail('The topic write is bound to a different target model.');
  const current = await evidence(row.plan.request, undefined, row);
  assertEvidence(row, current);
  if (options.branchId) {
    const branch = await stableReviewYaml(target, targetModelId, 'Branch', undefined, options.branchId);
    const verified = options.afterWrite ? compareTopicMigrationBranch({ files: row.plan.files, schemaMapText: row.plan.request.schemaMapText,
      baseline: row.targetFiles, actual: branch.files }).verified : topicMigrationSnapshotHash(branch.files) === topicMigrationSnapshotHash(row.targetFiles);
    if (!verified) fail('The working branch contains missing, altered, or unrelated files. Reconcile it before completing branch preparation.');
  }
  const currentJob = getJob(job.id);
  if (!currentJob || currentJob.status !== 'running') fail('The topic job stopped during evidence verification.');
  assertTopicMigrationWriteAuthority(currentJob);
}
