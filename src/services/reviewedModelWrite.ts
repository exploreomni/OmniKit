import type { ConnectionConfig, OmniModel } from '../types';
import {
  ApiError,
  createModelBranch,
  createOrUpdateModelBranchPullRequest,
  deleteModelBranch,
  deleteModelYamlFile,
  getModelYaml,
  getModelGitConfiguration,
  updateModelYamlFile,
  validateModel,
  validateModelContent,
  type OmniModelGitConfiguration,
} from './omniApi';
import { verifyStagedTopicYaml } from './topicYamlGovernance';

export interface ModelWriteCapability {
  editable: boolean;
  reason?: string;
  gitConfigured: boolean;
  gitConfigurationKnown: boolean;
  gitFollower: boolean;
  pullRequestRequired: boolean;
  webUrl?: string;
  raw?: OmniModelGitConfiguration;
}

export interface ReviewedModelBranch {
  modelId: string;
  branchId: string;
  branchName: string;
  capability: ModelWriteCapability;
}

export interface ReviewedValidation {
  modelIssues: Array<{ message?: string; is_warning?: boolean; yaml_path?: string }>;
  contentResult: Record<string, unknown> | null;
  contentIssueCount: number;
  newContentIssueCount: number;
  contentError?: string;
  blocking: boolean;
}

export interface ReviewedValidationOptions {
  baselineContentResult?: Record<string, unknown> | null;
}

export interface ReviewedHandoffResult {
  mode: 'manual_handoff' | 'pull_request';
  message: string;
  url?: string;
  commitRef?: string;
  inSync?: boolean;
  didSync?: boolean;
  raw: Record<string, unknown>;
}

export class ReviewedPullRequestVerificationError extends Error {
  readonly mutationMayHaveSucceeded = true;
  readonly reviewUrl?: string;
  readonly commitRef?: string;

  constructor(message: string, evidence: { reviewUrl?: string; commitRef?: string } = {}) {
    super(message);
    this.name = 'ReviewedPullRequestVerificationError';
    this.reviewUrl = evidence.reviewUrl;
    this.commitRef = evidence.commitRef;
  }
}

export type GovernedTopicMutationAction = 'create' | 'update' | 'delete';
export type GovernedTopicMutationStatus = 'review_ready' | 'validation_blocked';

export interface GovernedTopicFileEvidence {
  exists: boolean;
  fileName?: `${string}.topic`;
  yaml?: string;
  checksum?: string;
}

export interface GovernedTopicMutationReconciliation {
  attempted: boolean;
  outcome: 'not_needed' | 'confirmed_applied' | 'confirmed_absent';
  error?: string;
}

export type GovernedTopicDeleteReconciliation = GovernedTopicMutationReconciliation;

export interface GovernedTopicMutationDiff {
  fileName: `${string}.topic`;
  beforeYaml: string;
  afterYaml: string;
  changed: boolean;
}

export interface GovernedTopicMutationInput {
  action: GovernedTopicMutationAction;
  fileName: `${string}.topic`;
  yaml?: string;
  mode?: 'combined' | 'extension';
  commitMessage?: string;
  expectedPreWriteSnapshot?: GovernedTopicFileEvidence;
}

export interface GovernedTopicMutationEvidence {
  status: GovernedTopicMutationStatus;
  action: GovernedTopicMutationAction;
  topicName: string;
  fileName: `${string}.topic`;
  modelId: string;
  branchId: string;
  branchName: string;
  mode: 'combined' | 'extension';
  before: GovernedTopicFileEvidence;
  after: GovernedTopicFileEvidence;
  diff: GovernedTopicMutationDiff;
  validation: ReviewedValidation;
  reconciliation: GovernedTopicMutationReconciliation;
  writeResult?: unknown;
  requiresHumanReview: true;
  published: false;
}

export interface GovernedTopicWriteApi {
  getModelYaml: typeof getModelYaml;
  updateModelYamlFile: typeof updateModelYamlFile;
  deleteModelYamlFile: typeof deleteModelYamlFile;
  validateModel: typeof validateModel;
  validateModelContent: typeof validateModelContent;
}

const defaultGovernedTopicWriteApi: GovernedTopicWriteApi = {
  getModelYaml,
  updateModelYamlFile,
  deleteModelYamlFile,
  validateModel,
  validateModelContent,
};

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function reviewedPullRequestResult(raw: Record<string, unknown>): ReviewedHandoffResult {
  const documentedUrl = firstString(raw.pr_url);
  const url = (() => {
    if (!documentedUrl) return undefined;
    try {
      const parsed = new URL(documentedUrl);
      return parsed.protocol === 'https:' ? parsed.toString() : undefined;
    } catch {
      return undefined;
    }
  })();
  const commitRef = firstString(raw.git_sha);
  const inSync = raw.in_sync === true;
  const didSync = typeof raw.did_sync === 'boolean' ? raw.did_sync : undefined;
  const validCommitRef = Boolean(commitRef && /^[a-f0-9]{7,64}$/i.test(commitRef));
  if (!url || !validCommitRef || !inSync || didSync === undefined) {
    throw new ReviewedPullRequestVerificationError(
      'Omni accepted the pull-request request without complete, in-sync review evidence. The branch may have been committed; inspect the model in Omni before retrying.',
      { reviewUrl: url, commitRef },
    );
  }
  if (didSync) {
    throw new ReviewedPullRequestVerificationError(
      'Omni returned a pull-request URL but also reported that model synchronization occurred. The outcome is quarantined until a person reconciles the branch and shared model in Omni.',
      { reviewUrl: url, commitRef },
    );
  }
  return {
    mode: 'pull_request',
    message: 'Omni returned an HTTPS pull-request URL with in-sync commit evidence and reported did_sync=false. Review and merge the change in Omni.',
    url,
    commitRef,
    inSync,
    didSync,
    raw,
  };
}

export function countContentValidationIssues(value: unknown): number {
  const root = record(value);
  const content = Array.isArray(root?.content) ? root.content : [];
  let count = 0;
  for (const item of content) {
    const row = record(item);
    if (!row) continue;
    if (Array.isArray(row.dashboard_filter_issues)) count += row.dashboard_filter_issues.length;
    const queries = Array.isArray(row.queries_and_issues) ? row.queries_and_issues : [];
    for (const query of queries) {
      const queryRow = record(query);
      if (Array.isArray(queryRow?.issues)) count += queryRow.issues.length;
    }
  }
  return count;
}

function normalizeContentIssueSignature(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function contentValidationIssueSignatures(value: unknown): string[] {
  const root = record(value);
  const content = Array.isArray(root?.content) ? root.content : [];
  const signatures: string[] = [];
  for (const item of content) {
    const row = record(item);
    if (!row) continue;
    const documentName = firstString(row.name) || 'Untitled content';
    const filters = Array.isArray(row.dashboard_filter_issues) ? row.dashboard_filter_issues : [];
    for (const filter of filters) {
      const filterRow = record(filter);
      if (!filterRow) continue;
      const filterName = firstString(filterRow.filter_name, filterRow.filterName, filterRow.name, filterRow.field, filterRow.field_name, filterRow.fieldName) || 'Dashboard filter';
      const messages = Array.isArray(filterRow.issues) ? filterRow.issues : [];
      for (const message of messages) {
        if (typeof message === 'string' && message.trim()) {
          signatures.push(normalizeContentIssueSignature(`${documentName} / ${filterName}: ${message}`));
        }
      }
    }
    const queries = Array.isArray(row.queries_and_issues) ? row.queries_and_issues : [];
    for (const query of queries) {
      const queryRow = record(query);
      if (!queryRow) continue;
      const queryName = firstString(queryRow.query_name) || 'Query';
      const messages = Array.isArray(queryRow.issues) ? queryRow.issues : [];
      for (const message of messages) {
        if (typeof message === 'string' && message.trim()) {
          signatures.push(normalizeContentIssueSignature(`${documentName} / ${queryName}: ${message}`));
        }
      }
    }
  }
  return [...new Set(signatures)];
}

export function isSchemaModel(model: OmniModel): boolean {
  return model.kind?.toUpperCase() === 'SCHEMA';
}

export function isGovernanceEditableModel(model: OmniModel): boolean {
  const kind = model.kind?.toUpperCase();
  return !model.deletedAt && (kind === 'SHARED' || kind === 'SHARED_EXTENSION');
}

export function normalizeModelGitCapability(
  model: OmniModel,
  raw?: OmniModelGitConfiguration,
  known = true,
): ModelWriteCapability {
  if (!isGovernanceEditableModel(model)) {
    return {
      editable: false,
      reason: model.kind?.toUpperCase() === 'SCHEMA'
        ? 'Schema models cannot be edited or branched through the model YAML API.'
        : `${model.kind || 'Unknown'} models are not supported for reviewed governance writes.`,
      gitConfigured: Boolean(raw),
      gitConfigurationKnown: known,
      gitFollower: false,
      pullRequestRequired: false,
      raw,
    };
  }

  const gitFollower = raw?.gitFollower === true || raw?.git_follower === true;
  const requirePullRequest = firstString(raw?.requirePullRequest, raw?.require_pull_request)?.toLowerCase();
  const pullRequestRequired = requirePullRequest === 'always' || requirePullRequest === 'users-only';
  const gitConfigured = Boolean(raw && Object.keys(raw).length > 0);
  return {
    editable: known && !gitFollower,
    reason: !known
      ? 'OmniKit could not verify this model’s git settings, so writes are blocked.'
      : gitFollower
        ? 'Git follower models are read-only. Apply this change to the leader model instead.'
        : undefined,
    gitConfigured,
    gitConfigurationKnown: known,
    gitFollower,
    pullRequestRequired,
    webUrl: firstString(raw?.webUrl, raw?.web_url),
    raw,
  };
}

export async function inspectModelWriteCapability(
  connection: ConnectionConfig,
  model: OmniModel,
): Promise<ModelWriteCapability> {
  if (!isGovernanceEditableModel(model)) return normalizeModelGitCapability(model);
  try {
    const raw = await getModelGitConfiguration(connection.baseUrl, connection.apiKey, model.id);
    return normalizeModelGitCapability(model, raw, true);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return normalizeModelGitCapability(model, undefined, true);
    }
    return normalizeModelGitCapability(model, undefined, false);
  }
}

export async function startReviewedModelBranch(
  connection: ConnectionConfig,
  model: OmniModel,
  branchPrefix: string,
): Promise<ReviewedModelBranch> {
  const capability = await inspectModelWriteCapability(connection, model);
  if (!capability.editable) throw new Error(capability.reason || 'This model is not editable.');
  if (!model.connectionId) throw new Error('This model is missing a connection ID.');
  const branchName = `${branchPrefix}-${Date.now()}`;
  const branch = await createModelBranch(connection.baseUrl, connection.apiKey, {
    connectionId: model.connectionId,
    baseModelId: model.id,
    branchName,
  });
  const branchId = String(branch.id || '');
  if (!branchId) throw new Error('Omni did not return a branch model ID.');
  return {
    modelId: model.id,
    branchId,
    branchName: String(branch.name || branchName),
    capability,
  };
}

export async function validateReviewedModelBranch(
  connection: ConnectionConfig,
  branch: ReviewedModelBranch,
  options: ReviewedValidationOptions = {},
): Promise<ReviewedValidation> {
  return validateReviewedModelBranchWithApi(connection, branch, defaultGovernedTopicWriteApi, options);
}

async function validateReviewedModelBranchWithApi(
  connection: ConnectionConfig,
  branch: ReviewedModelBranch,
  api: Pick<GovernedTopicWriteApi, 'validateModel' | 'validateModelContent'>,
  options: ReviewedValidationOptions = {},
): Promise<ReviewedValidation> {
  const modelIssues = await api.validateModel(
    connection.baseUrl,
    connection.apiKey,
    branch.modelId,
    branch.branchId,
  ).catch((error) => [{
    message: error instanceof Error ? error.message : 'Branch validation failed.',
    is_warning: false,
  }]);
  let contentResult: Record<string, unknown> | null = null;
  let contentError: string | undefined;
  try {
    contentResult = await api.validateModelContent(
      connection.baseUrl,
      connection.apiKey,
      branch.modelId,
      { branchId: branch.branchId, includePersonalFolders: true },
    );
  } catch (error) {
    contentError = error instanceof Error ? error.message : 'Content validation failed.';
  }
  const contentIssueCount = countContentValidationIssues(contentResult);
  const baselineSignatures = new Set(contentValidationIssueSignatures(options.baselineContentResult));
  const currentSignatures = contentValidationIssueSignatures(contentResult);
  const newContentIssueCount = options.baselineContentResult === undefined
    ? contentIssueCount
    : currentSignatures.filter((signature) => !baselineSignatures.has(signature)).length;
  return {
    modelIssues: Array.isArray(modelIssues) ? modelIssues : [],
    contentResult,
    contentIssueCount,
    newContentIssueCount,
    contentError,
    blocking: !Array.isArray(modelIssues)
      || modelIssues.some((issue) => issue.is_warning !== true)
      || newContentIssueCount > 0
      || Boolean(contentError),
  };
}

function governedTopicFileName(fileName: string): `${string}.topic` {
  const normalized = fileName.trim();
  const segments = normalized.split('/');
  const leaf = segments.at(-1) || '';
  const folders = segments.slice(0, -1);
  const safeFolderSegment = (segment: string) => (
    /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(segment)
    && segment !== '.'
    && segment !== '..'
  );
  if (
    normalized.startsWith('/')
    || normalized.includes('\\')
    || !/^[A-Za-z0-9_-]+\.topic$/.test(leaf)
    || folders.some((segment) => !safeFolderSegment(segment))
  ) {
    throw new Error('Topic file names must use a safe relative <topic>.topic path.');
  }
  return normalized as `${string}.topic`;
}

function topicFileSnapshot(
  yaml: { files?: Record<string, string>; checksums?: Record<string, string> },
  fileName: `${string}.topic`,
): GovernedTopicFileEvidence {
  const files = yaml.files || {};
  const exactMatch = Object.prototype.hasOwnProperty.call(files, fileName) ? fileName : undefined;
  const requestedLeaf = fileName.split('/').at(-1)?.toLowerCase();
  const canonicalMatches = exactMatch || !requestedLeaf
    ? []
    : Object.keys(files).filter((candidate) => (
      candidate.endsWith('.topic')
      && candidate.split('/').at(-1)?.toLowerCase() === requestedLeaf
    ));
  const resolvedFileName = exactMatch || (canonicalMatches.length === 1 ? canonicalMatches[0] : undefined);
  const exists = Boolean(resolvedFileName);
  return {
    exists,
    fileName: resolvedFileName as `${string}.topic` | undefined,
    yaml: resolvedFileName ? files[resolvedFileName] : undefined,
    checksum: resolvedFileName ? yaml.checksums?.[resolvedFileName] : undefined,
  };
}

function assertExpectedTopicSnapshot(
  fileName: `${string}.topic`,
  expected: GovernedTopicFileEvidence | undefined,
  current: GovernedTopicFileEvidence,
) {
  if (!expected) return;
  const differs = expected.exists !== current.exists
    || (expected.checksum !== undefined && expected.checksum !== current.checksum)
    || (expected.yaml !== undefined && expected.yaml !== current.yaml);
  if (differs) {
    throw new Error(`Stale or concurrent edit detected for ${fileName}; refresh the branch snapshot before retrying.`);
  }
}

function mutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The topic mutation outcome was not confirmed.';
}

function isAmbiguousMutationFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0
    || error.status === 404
    || error.status === 408
    || error.status === 429
    || error.status >= 500;
}

async function fetchGovernedTopicSnapshot(
  connection: ConnectionConfig,
  branch: ReviewedModelBranch,
  fileName: `${string}.topic`,
  mode: 'combined' | 'extension',
  api: Pick<GovernedTopicWriteApi, 'getModelYaml'>,
): Promise<GovernedTopicFileEvidence> {
  const yaml = await api.getModelYaml(connection.baseUrl, connection.apiKey, branch.modelId, {
    branchId: branch.branchId,
    fileName,
    mode,
    includeChecksums: true,
    fullyResolved: false,
    fresh: true,
  });
  return topicFileSnapshot(yaml, fileName);
}

export async function stageGovernedTopicMutation(
  connection: ConnectionConfig,
  branch: ReviewedModelBranch,
  input: GovernedTopicMutationInput,
  api: GovernedTopicWriteApi = defaultGovernedTopicWriteApi,
): Promise<GovernedTopicMutationEvidence> {
  if (!branch.capability.editable) {
    throw new Error(branch.capability.reason || 'This reviewed branch is not editable.');
  }
  if (!branch.modelId.trim() || !branch.branchId.trim() || !branch.branchName.trim()) {
    throw new Error('Governed topic mutations require an existing reviewed model branch.');
  }

  const fileName = governedTopicFileName(input.fileName);
  const topicName = fileName.split('/').at(-1)?.replace(/\.topic$/, '') || fileName;
  const mode = input.mode || 'combined';
  const commitMessage = input.commitMessage?.trim() || `Stage ${input.action} for ${fileName}`;
  const before = await fetchGovernedTopicSnapshot(connection, branch, fileName, mode, api);
  const writeFileName = before.fileName || fileName;
  assertExpectedTopicSnapshot(fileName, input.expectedPreWriteSnapshot, before);

  if (input.action === 'create' && before.exists) {
    throw new Error(`${fileName} already exists on the reviewed branch.`);
  }
  if (input.action !== 'create' && !before.exists) {
    throw new Error(`${fileName} does not exist on the reviewed branch.`);
  }
  if (input.action !== 'create' && !before.checksum) {
    throw new Error(`Omni did not return a checksum for ${fileName}; the governed mutation was blocked.`);
  }
  if (input.action !== 'delete' && !input.yaml?.trim()) {
    throw new Error(`A complete ${fileName} YAML document is required.`);
  }

  // Narrow the create/update race window immediately before the full-file write.
  const preWrite = await fetchGovernedTopicSnapshot(connection, branch, writeFileName, mode, api);
  assertExpectedTopicSnapshot(fileName, before, preWrite);
  if (input.action === 'create' && preWrite.exists) {
    throw new Error(`${fileName} was created on the reviewed branch before this write could begin.`);
  }

  let writeResult: unknown;
  let after: GovernedTopicFileEvidence;
  let reconciliation: GovernedTopicMutationReconciliation = {
    attempted: false,
    outcome: 'not_needed',
  };

  if (input.action === 'delete') {
    let ambiguousDeleteError: unknown;
    try {
      writeResult = await api.deleteModelYamlFile(connection.baseUrl, connection.apiKey, {
        modelId: branch.modelId,
        fileName: writeFileName,
        branchId: branch.branchId,
        mode,
        commitMessage,
      });
    } catch (error) {
      if (!isAmbiguousMutationFailure(error)) throw error;
      ambiguousDeleteError = error;
    }
    after = await fetchGovernedTopicSnapshot(connection, branch, writeFileName, mode, api);
    if (ambiguousDeleteError) {
      if (after.exists) throw new Error(`The delete outcome for ${fileName} is ambiguous and the file is still present on the reviewed branch.`);
      reconciliation = {
        attempted: true,
        outcome: 'confirmed_absent',
        error: mutationErrorMessage(ambiguousDeleteError),
      };
    }
    if (after.exists) {
      throw new Error(`Omni reported that ${fileName} was deleted, but the file is still present on the reviewed branch.`);
    }
  } else {
    const yaml = input.yaml as string;
    let ambiguousWriteError: unknown;
    try {
      writeResult = await api.updateModelYamlFile(connection.baseUrl, connection.apiKey, {
        modelId: branch.modelId,
        fileName: writeFileName,
        yaml,
        mode,
        branchId: branch.branchId,
        commitMessage,
        previousChecksum: input.action === 'update' ? preWrite.checksum : undefined,
        fullyResolved: false,
      });
    } catch (error) {
      if (!isAmbiguousMutationFailure(error)) throw error;
      ambiguousWriteError = error;
    }
    after = await fetchGovernedTopicSnapshot(connection, branch, writeFileName, mode, api);
    const verification = after.yaml ? verifyStagedTopicYaml(yaml, after.yaml, { topicName }) : null;
    if (!after.exists || !verification?.matches) {
      const detail = verification?.reason ? ` (${verification.reason})` : '';
      if (ambiguousWriteError) {
        throw new Error(`The ${input.action} outcome for ${fileName} is ambiguous and the branch file does not exactly match or safely structurally preserve the intended YAML${detail}.`);
      }
      throw new Error(`Omni did not return complete staged YAML that can be safely verified for ${fileName}${detail}; review is blocked.`);
    }
    if (ambiguousWriteError) {
      reconciliation = {
        attempted: true,
        outcome: 'confirmed_applied',
        error: mutationErrorMessage(ambiguousWriteError),
      };
    }
  }

  const validation = await validateReviewedModelBranchWithApi(connection, branch, api);
  const resolvedFileName = after.fileName || before.fileName || fileName;
  return {
    status: validation.blocking ? 'validation_blocked' : 'review_ready',
    action: input.action,
    topicName,
    fileName: resolvedFileName,
    modelId: branch.modelId,
    branchId: branch.branchId,
    branchName: branch.branchName,
    mode,
    before,
    after,
    diff: {
      fileName: resolvedFileName,
      beforeYaml: before.yaml || '',
      afterYaml: after.yaml || '',
      changed: (before.yaml || '') !== (after.yaml || ''),
    },
    validation,
    reconciliation,
    writeResult,
    requiresHumanReview: true,
    published: false,
  };
}

export async function prepareReviewedModelHandoff(
  connection: ConnectionConfig,
  branch: ReviewedModelBranch,
  commitMessage: string,
): Promise<ReviewedHandoffResult> {
  if (branch.capability.pullRequestRequired) {
    const raw = await createOrUpdateModelBranchPullRequest(connection.baseUrl, connection.apiKey, {
      modelId: branch.modelId,
      branchId: branch.branchId,
      commitMessage,
      allowBranchExists: true,
      requireBranchExists: false,
    });
    return reviewedPullRequestResult(raw);
  }
  return {
    mode: 'manual_handoff',
    message: 'The validated development branch remains unchanged for final sign-off in Omni. OmniKit did not merge or publish it.',
    url: branch.capability.webUrl || connection.baseUrl,
    raw: {
      handoff: 'manual',
      model_id: branch.modelId,
      branch_id: branch.branchId,
      branch_name: branch.branchName,
    },
  };
}

export async function createReviewedModelPullRequestHandoff(
  connection: ConnectionConfig,
  branch: ReviewedModelBranch,
  commitMessage: string,
): Promise<ReviewedHandoffResult> {
  if (!branch.capability.pullRequestRequired) {
    throw new Error('This handoff helper is PR-only. No merge was attempted; complete sign-off in Omni.');
  }
  const raw = await createOrUpdateModelBranchPullRequest(connection.baseUrl, connection.apiKey, {
    modelId: branch.modelId,
    branchId: branch.branchId,
    commitMessage,
    allowBranchExists: true,
    requireBranchExists: false,
  });
  return reviewedPullRequestResult(raw);
}

export async function discardReviewedModelBranch(
  connection: ConnectionConfig,
  branch: Pick<ReviewedModelBranch, 'modelId' | 'branchName'>,
) {
  return deleteModelBranch(connection.baseUrl, connection.apiKey, branch.modelId, branch.branchName);
}
