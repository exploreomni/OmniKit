import type { ConnectionConfig, OmniModel } from '../types';
import { parseConnectionDbtConfig } from './collectionContracts';
import { sha256Text } from './contentHash';
import {
  ApiError,
  getModelGitConfiguration,
  getModelYaml,
  omniProxy,
  validateModel,
  validateModelContent,
  type OmniModelGitConfiguration,
  type OmniModelYamlResponse,
} from './omniApi';
import { normalizeContentReferences, type SemanticContentReference } from './modelGovernance';
import {
  countContentValidationIssues,
  contentValidationIssueSignatures,
  normalizeModelGitCapability,
  type ReviewedModelBranch,
  type ReviewedValidation,
} from './reviewedModelWrite';

export type ReleaseGateStatus = 'blocked' | 'ready_for_pull_request' | 'ready_for_manual_handoff';
export type ReleaseGateCheckStatus = 'ready' | 'blocked' | 'unavailable';
export type ReleaseGateHandoffStatus = 'not_started' | 'pull_request_ready' | 'manual_handoff_ready';

export interface ReleaseGateCheck {
  id: 'connection' | 'caller' | 'dbt' | 'dbt_environments' | 'git' | 'branch' | 'checksums' | 'model_validation' | 'content_validation' | 'affected_content' | 'diff' | 'handoff';
  label: string;
  status: ReleaseGateCheckStatus;
  detail: string;
}

export interface ReleaseGateFileDiff {
  fileName: string;
  change: 'added' | 'updated' | 'deleted';
  beforeYaml: string;
  afterYaml: string;
  beforeChecksum?: string;
  afterChecksum?: string;
}

export interface ReleaseGateDbtMetadata {
  state: 'configured' | 'not_configured' | 'not_supported';
  supportsDbt?: boolean;
  branch?: string;
  dbtVersion?: string;
  autogenRelationships?: boolean;
  enableSemanticLayer?: boolean;
  enableVirtualSchemas?: boolean;
  projectRootPath?: string | null;
}

export interface ReleaseGateDbtEnvironmentMetadata {
  state: 'verified' | 'not_applicable';
  environmentCount?: number;
  defaultEnvironmentCount?: number;
}

export type ReleaseGateAffectedContentTargetType = 'TOPIC' | 'VIEW' | 'FIELD' | 'FIELD_GROUP';

export interface ReleaseGateAffectedContentTarget {
  type: ReleaseGateAffectedContentTargetType;
  name: string;
}

export interface ReleaseGateAffectedContentScope {
  state: 'verified' | 'metadata_only' | 'unavailable';
  basis: 'targeted_content_validator' | 'metadata_only_label_change' | 'not_collected';
  targets: ReleaseGateAffectedContentTarget[];
  reason?: string;
}

export interface ReleaseGateAffectedContentCollection {
  affectedContent?: SemanticContentReference[];
  affectedContentScope: ReleaseGateAffectedContentScope;
}

export interface ReleaseGateCallerEvidence {
  keyScope: 'user' | 'organization';
  orgRole: 'MEMBER' | 'ORG_ADMIN';
  identityScopeFingerprint: `caller-sha256:${string}`;
  modelScoped: true;
  targetModelAccessObserved: boolean;
  targetModelPermissionCount: number;
  rolesByModelTruncated: boolean;
}

export interface ReleaseGateEvidence {
  version: 2;
  collectedAt: string;
  status: ReleaseGateStatus;
  fingerprint: string;
  connection: {
    instanceId?: string;
    instanceLabel?: string;
    origin: string;
    connectionId: string;
    connectionName?: string;
  };
  caller: ReleaseGateCallerEvidence | null;
  dbt: ReleaseGateDbtMetadata | null;
  dbtEnvironments: ReleaseGateDbtEnvironmentMetadata | null;
  git: {
    configured: boolean;
    follower: boolean;
    pullRequestRequired: boolean;
    baseBranch?: string;
    webUrl?: string;
  } | null;
  branch: {
    modelId: string;
    modelName: string;
    branchId: string;
    branchName: string;
    verified: boolean;
  };
  validation: ReviewedValidation;
  affectedContent: SemanticContentReference[];
  affectedContentScope: ReleaseGateAffectedContentScope;
  diff: ReleaseGateFileDiff[];
  handoff: {
    mode: 'pull_request' | 'manual';
    status: ReleaseGateHandoffStatus;
    url?: string;
    commitRef?: string;
  };
  checks: ReleaseGateCheck[];
  blockers: string[];
}

export interface ReleaseGateApproval {
  fingerprint: string;
  approvedAt: string;
  status: Exclude<ReleaseGateStatus, 'blocked'>;
}

export interface CollectReleaseGateEvidenceInput {
  connection: ConnectionConfig;
  model: OmniModel;
  branch: ReviewedModelBranch;
  affectedFiles?: string[];
  affectedContent?: SemanticContentReference[];
  affectedContentScope?: ReleaseGateAffectedContentScope;
  handoff?: ReleaseGateEvidence['handoff'];
}

export interface ReleaseGateEvidenceApi {
  getModelYaml: typeof getModelYaml;
  getModelGitConfiguration: typeof getModelGitConfiguration;
  validateModel: typeof validateModel;
  validateModelContent: typeof validateModelContent;
  getCurrentCaller: (baseUrl: string, apiKey: string, modelId: string) => Promise<unknown>;
  getConnectionDbt: (baseUrl: string, apiKey: string, connectionId: string) => Promise<unknown>;
  getConnectionDbtEnvironments: (baseUrl: string, apiKey: string, connectionId: string) => Promise<unknown>;
}

const defaultApi: ReleaseGateEvidenceApi = {
  getModelYaml,
  getModelGitConfiguration,
  validateModel,
  validateModelContent,
  getCurrentCaller: (baseUrl, apiKey, modelId) => omniProxy(
    baseUrl,
    apiKey,
    'GET',
    '/v1/whoami',
    { queryParams: { modelId } },
  ),
  getConnectionDbt: (baseUrl, apiKey, connectionId) => omniProxy(
    baseUrl,
    apiKey,
    'GET',
    `/v1/connections/${encodeURIComponent(connectionId)}/dbt`,
  ),
  getConnectionDbtEnvironments: (baseUrl, apiKey, connectionId) => omniProxy(
    baseUrl,
    apiKey,
    'GET',
    `/v1/connections/${encodeURIComponent(connectionId)}/dbt/environments`,
  ),
};

const MAX_TARGETED_AFFECTED_CONTENT_LOOKUPS = 25;

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function originFor(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return 'invalid-instance-origin';
  }
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

type ModelValidationIssue = Awaited<ReturnType<typeof validateModel>>[number];

function hasErrorEnvelope(value: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'error')
    || Object.prototype.hasOwnProperty.call(value, 'errors')
    || value.ok === false
    || value.success === false;
}

function parseModelValidationIssues(value: unknown): ModelValidationIssue[] | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const issue = recordValue(item);
    if (
      !issue
      || (issue.message !== undefined && typeof issue.message !== 'string')
      || (issue.yaml_path !== undefined && typeof issue.yaml_path !== 'string')
      || (issue.is_warning !== undefined && typeof issue.is_warning !== 'boolean')
      || !firstString(issue.message, issue.yaml_path)
    ) {
      return null;
    }
  }
  return value as ModelValidationIssue[];
}

function validIssueMessages(value: unknown): boolean {
  return Array.isArray(value)
    && value.every((message) => typeof message === 'string' && message.trim().length > 0);
}

function parseContentValidationResult(value: unknown): Record<string, unknown> | null {
  const root = recordValue(value);
  if (!root || hasErrorEnvelope(root) || !Array.isArray(root.content)) return null;

  for (const item of root.content) {
    const content = recordValue(item);
    if (!content) return null;

    if (content.dashboard_filter_issues !== undefined) {
      if (!Array.isArray(content.dashboard_filter_issues)) return null;
      for (const issue of content.dashboard_filter_issues) {
        if (typeof issue === 'string') {
          if (!issue.trim()) return null;
          continue;
        }
        const issueRow = recordValue(issue);
        if (!issueRow || (issueRow.issues !== undefined && !validIssueMessages(issueRow.issues))) return null;
      }
    }

    if (content.queries_and_issues !== undefined) {
      if (!Array.isArray(content.queries_and_issues)) return null;
      for (const query of content.queries_and_issues) {
        const queryRow = recordValue(query);
        if (!queryRow || (queryRow.issues !== undefined && !validIssueMessages(queryRow.issues))) return null;
      }
    }
  }
  return root;
}

function parseDbtEnvironmentInventory(value: unknown): ReleaseGateDbtEnvironmentMetadata | null {
  if (!Array.isArray(value) || value.length > 10_000) return null;
  let defaultEnvironmentCount = 0;
  for (const item of value) {
    const environment = recordValue(item);
    if (
      !environment
      || !firstString(environment.id)
      || !firstString(environment.name)
      || typeof environment.isDefaultEnvironment !== 'boolean'
    ) {
      return null;
    }
    if (environment.isDefaultEnvironment) defaultEnvironmentCount += 1;
  }
  return {
    state: 'verified',
    environmentCount: value.length,
    defaultEnvironmentCount,
  };
}

function normalizeAffectedContentTargets(value: unknown): ReleaseGateAffectedContentTarget[] | null {
  if (!Array.isArray(value) || value.length > 10_000) return null;
  const allowedTypes = new Set<ReleaseGateAffectedContentTargetType>(['TOPIC', 'VIEW', 'FIELD', 'FIELD_GROUP']);
  const targets: ReleaseGateAffectedContentTarget[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const target = recordValue(item);
    const name = firstString(target?.name);
    const type = target?.type;
    if (!name || typeof type !== 'string' || !allowedTypes.has(type as ReleaseGateAffectedContentTargetType)) return null;
    const key = `${type}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ type: type as ReleaseGateAffectedContentTargetType, name });
  }
  return targets.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
}

function parseAffectedContentScope(value: unknown): ReleaseGateAffectedContentScope | null {
  const scope = recordValue(value);
  const targets = normalizeAffectedContentTargets(scope?.targets);
  if (
    !scope
    || !targets
    || (scope.state !== 'verified' && scope.state !== 'metadata_only' && scope.state !== 'unavailable')
    || (scope.basis !== 'targeted_content_validator' && scope.basis !== 'metadata_only_label_change' && scope.basis !== 'not_collected')
  ) return null;

  if (scope.state === 'verified' && (
    scope.basis !== 'targeted_content_validator'
    || targets.length === 0
    || targets.length > MAX_TARGETED_AFFECTED_CONTENT_LOOKUPS
    || targets.some((target) => target.type === 'FIELD_GROUP')
  )) return null;
  if (scope.state === 'metadata_only' && (scope.basis !== 'metadata_only_label_change' || targets.length === 0)) return null;
  if (scope.state === 'unavailable' && !firstString(scope.reason)) return null;

  return {
    state: scope.state,
    basis: scope.basis,
    targets,
    ...(scope.state === 'unavailable' ? { reason: firstString(scope.reason) } : {}),
  };
}

function parseAffectedContentInventory(value: unknown): SemanticContentReference[] | null {
  if (!Array.isArray(value) || value.length > 100_000) return null;
  for (const item of value) {
    const row = recordValue(item);
    if (
      !row
      || typeof row.documentId !== 'string'
      || typeof row.identifier !== 'string'
      || !firstString(row.name)
      || !firstString(row.type)
      || !Array.isArray(row.queryNames)
      || row.queryNames.some((queryName) => typeof queryName !== 'string' || !queryName.trim())
      || (row.updatedAt !== undefined && typeof row.updatedAt !== 'string')
      || (row.folderPath !== undefined && typeof row.folderPath !== 'string')
      || (row.ownerName !== undefined && typeof row.ownerName !== 'string')
    ) return null;
  }
  return value as SemanticContentReference[];
}

export async function collectTargetedAffectedContent(
  connection: ConnectionConfig,
  modelId: string,
  targets: ReleaseGateAffectedContentTarget[],
  api: Pick<ReleaseGateEvidenceApi, 'validateModelContent'> = defaultApi,
): Promise<ReleaseGateAffectedContentCollection> {
  const normalizedTargets = normalizeAffectedContentTargets(targets);
  if (!normalizedTargets || normalizedTargets.length === 0) {
    return {
      affectedContentScope: {
        state: 'unavailable',
        basis: 'not_collected',
        targets: [],
        reason: 'No exact semantic targets were available for a bounded affected-content lookup.',
      },
    };
  }
  if (normalizedTargets.length > MAX_TARGETED_AFFECTED_CONTENT_LOOKUPS) {
    return {
      affectedContentScope: {
        state: 'unavailable',
        basis: 'targeted_content_validator',
        targets: normalizedTargets,
        reason: `Affected-content scope contains ${normalizedTargets.length} targets, above the bounded ${MAX_TARGETED_AFFECTED_CONTENT_LOOKUPS}-lookup limit. Narrow the scope before handoff.`,
      },
    };
  }
  if (normalizedTargets.some((target) => target.type === 'FIELD_GROUP')) {
    return {
      affectedContentScope: {
        state: 'unavailable',
        basis: 'targeted_content_validator',
        targets: normalizedTargets,
        reason: 'The Content Validator does not expose a FIELD_GROUP lookup contract.',
      },
    };
  }

  const inventory: SemanticContentReference[] = [];
  for (const target of normalizedTargets) {
    try {
      const raw = await api.validateModelContent(connection.baseUrl, connection.apiKey, modelId, {
        find: target.name,
        findType: target.type as 'TOPIC' | 'VIEW' | 'FIELD',
        includePersonalFolders: true,
      });
      const parsed = parseContentValidationResult(raw);
      if (!parsed) {
        return {
          affectedContentScope: {
            state: 'unavailable',
            basis: 'targeted_content_validator',
            targets: normalizedTargets,
            reason: `The targeted Content Validator response for ${target.type} ${target.name} did not match the expected contract.`,
          },
        };
      }
      inventory.push(...normalizeContentReferences(parsed));
    } catch {
      return {
        affectedContentScope: {
          state: 'unavailable',
          basis: 'targeted_content_validator',
          targets: normalizedTargets,
          reason: `The targeted Content Validator lookup for ${target.type} ${target.name} could not be completed.`,
        },
      };
    }
  }
  return {
    affectedContent: uniqueContent(inventory),
    affectedContentScope: {
      state: 'verified',
      basis: 'targeted_content_validator',
      targets: normalizedTargets,
    },
  };
}

function parseCallerEvidence(
  value: unknown,
  origin: string,
  modelId: string,
): ReleaseGateCallerEvidence | null {
  const root = recordValue(value);
  const rolesByModel = recordValue(root?.rolesByModel);
  const user = recordValue(root?.user);
  const userId = firstString(user?.id);
  const membershipId = firstString(user?.membershipId);
  if (
    !root
    || !rolesByModel
    || !userId
    || !membershipId
    || (root.keyScope !== 'user' && root.keyScope !== 'organization')
    || (root.orgRole !== 'MEMBER' && root.orgRole !== 'ORG_ADMIN')
    || (root.rolesByModelTruncated !== undefined && typeof root.rolesByModelTruncated !== 'boolean')
    || Object.keys(rolesByModel).some((returnedModelId) => returnedModelId !== modelId)
  ) return null;

  const targetRole = recordValue(rolesByModel[modelId]);
  const permissions = targetRole?.permissions;
  if (targetRole && (
    !Array.isArray(permissions)
    || permissions.length > 10_000
    || permissions.some((permission) => typeof permission !== 'string' || !permission.trim())
  )) {
    return null;
  }
  return {
    keyScope: root.keyScope,
    orgRole: root.orgRole,
    identityScopeFingerprint: `caller-sha256:${sha256Text(`${origin}\u0000${modelId}\u0000${userId}\u0000${membershipId}`)}`,
    modelScoped: true,
    targetModelAccessObserved: Boolean(targetRole),
    targetModelPermissionCount: Array.isArray(permissions) ? permissions.length : 0,
    rolesByModelTruncated: root.rolesByModelTruncated === true,
  };
}

function buildFileDiff(
  mainYaml: OmniModelYamlResponse | null,
  branchYaml: OmniModelYamlResponse | null,
  affectedFiles: string[] | undefined,
): ReleaseGateFileDiff[] {
  if (!mainYaml || !branchYaml) return [];
  const mainFiles = mainYaml.files || {};
  const branchFiles = branchYaml.files || {};
  const requested = affectedFiles?.length
    ? affectedFiles
    : [...new Set([...Object.keys(mainFiles), ...Object.keys(branchFiles)])];
  return [...new Set(requested)]
    .sort()
    .flatMap((fileName): ReleaseGateFileDiff[] => {
      const before = mainFiles[fileName];
      const after = branchFiles[fileName];
      if (before === after) return [];
      return [{
        fileName,
        change: before === undefined ? 'added' : after === undefined ? 'deleted' : 'updated',
        beforeYaml: before || '',
        afterYaml: after || '',
        beforeChecksum: mainYaml.checksums?.[fileName],
        afterChecksum: branchYaml.checksums?.[fileName],
      }];
    });
}

function uniqueContent(rows: SemanticContentReference[]): SemanticContentReference[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.documentId}|${row.identifier}|${row.name}|${row.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => (
    left.type.localeCompare(right.type)
    || left.name.localeCompare(right.name)
    || left.documentId.localeCompare(right.documentId)
  ));
}

function releaseFingerprint(value: Omit<ReleaseGateEvidence, 'fingerprint' | 'collectedAt'>): string {
  const stable = {
    version: value.version,
    status: value.status,
    connection: value.connection,
    caller: value.caller,
    dbt: value.dbt,
    dbtEnvironments: value.dbtEnvironments,
    git: value.git,
    branch: value.branch,
    validation: {
      modelIssues: value.validation.modelIssues
        .map((issue) => ({
          message: issue.message || '',
          warning: issue.is_warning === true,
          path: issue.yaml_path || '',
        }))
        .sort((left, right) => (
          left.path.localeCompare(right.path)
          || left.message.localeCompare(right.message)
          || Number(left.warning) - Number(right.warning)
        )),
      contentIssueCount: value.validation.contentIssueCount,
      newContentIssueCount: value.validation.newContentIssueCount,
      contentError: value.validation.contentError || '',
      blocking: value.validation.blocking,
      contentSignatures: contentValidationIssueSignatures(value.validation.contentResult).sort(),
    },
    affectedContent: value.affectedContent.map((row) => ({
      documentId: row.documentId,
      identifier: row.identifier,
      name: row.name,
      type: row.type,
      queryNames: [...row.queryNames].sort(),
    })),
    affectedContentScope: value.affectedContentScope,
    diff: value.diff.map((row) => ({
      fileName: row.fileName,
      change: row.change,
      beforeChecksum: row.beforeChecksum || '',
      afterChecksum: row.afterChecksum || '',
      beforeDigest: sha256Text(row.beforeYaml),
      afterDigest: sha256Text(row.afterYaml),
    })),
    handoff: value.handoff,
    checks: value.checks,
    blockers: value.blockers,
  };
  return `release-gate-sha256:${sha256Text(JSON.stringify(stable))}`;
}

export async function collectReleaseGateEvidence(
  input: CollectReleaseGateEvidenceInput,
  api: ReleaseGateEvidenceApi = defaultApi,
): Promise<ReleaseGateEvidence> {
  const connectionId = input.model.connectionId?.trim() || '';
  const [mainResult, branchResult, gitResult, callerResult, dbtResult, dbtEnvironmentsResult, modelValidationResult, mainContentResult, branchContentResult] = await Promise.allSettled([
    api.getModelYaml(input.connection.baseUrl, input.connection.apiKey, input.model.id, {
      includeChecksums: true,
      fullyResolved: false,
      fresh: true,
    }),
    api.getModelYaml(input.connection.baseUrl, input.connection.apiKey, input.model.id, {
      branchId: input.branch.branchId,
      includeChecksums: true,
      fullyResolved: false,
      fresh: true,
    }),
    api.getModelGitConfiguration(input.connection.baseUrl, input.connection.apiKey, input.model.id),
    api.getCurrentCaller(input.connection.baseUrl, input.connection.apiKey, input.model.id),
    connectionId
      ? api.getConnectionDbt(input.connection.baseUrl, input.connection.apiKey, connectionId)
      : Promise.reject(new Error('missing connection id')),
    connectionId
      ? api.getConnectionDbtEnvironments(input.connection.baseUrl, input.connection.apiKey, connectionId)
      : Promise.reject(new Error('missing connection id')),
    api.validateModel(input.connection.baseUrl, input.connection.apiKey, input.model.id, input.branch.branchId),
    api.validateModelContent(input.connection.baseUrl, input.connection.apiKey, input.model.id, {
      includePersonalFolders: true,
    }),
    api.validateModelContent(input.connection.baseUrl, input.connection.apiKey, input.model.id, {
      branchId: input.branch.branchId,
      includePersonalFolders: true,
    }),
  ] as const);

  const mainYaml = settledValue(mainResult);
  const branchYaml = settledValue(branchResult);
  const rawGit = settledValue(gitResult) as OmniModelGitConfiguration | null;
  const connectionOrigin = originFor(input.connection.baseUrl);
  const caller = parseCallerEvidence(settledValue(callerResult), connectionOrigin, input.model.id);
  const gitVerifiedNotConfigured = gitResult.status === 'rejected'
    && gitResult.reason instanceof ApiError
    && gitResult.reason.status === 404;
  const rawDbt = settledValue(dbtResult);
  const rawDbtEnvironments = settledValue(dbtEnvironmentsResult);
  const parsedModelIssues = modelValidationResult.status === 'fulfilled'
    ? parseModelValidationIssues(modelValidationResult.value)
    : null;
  const mainContent = mainContentResult.status === 'fulfilled'
    ? parseContentValidationResult(mainContentResult.value)
    : null;
  const branchContent = branchContentResult.status === 'fulfilled'
    ? parseContentValidationResult(branchContentResult.value)
    : null;
  const diff = buildFileDiff(mainYaml, branchYaml, undefined);
  const reviewedScope = input.affectedFiles?.length ? new Set(input.affectedFiles) : null;
  const unexpectedFiles = reviewedScope
    ? diff.filter((row) => !reviewedScope.has(row.fileName)).map((row) => row.fileName)
    : [];
  const baselineContentSignatures = new Set(contentValidationIssueSignatures(mainContent));
  const branchContentSignatures = contentValidationIssueSignatures(branchContent);
  const mainContentIssueCount = countContentValidationIssues(mainContent);
  const branchContentIssueCount = countContentValidationIssues(branchContent);
  const newContentIssueCount = Math.max(
    branchContentSignatures.filter((signature) => !baselineContentSignatures.has(signature)).length,
    branchContentIssueCount - mainContentIssueCount,
  );
  const modelIssues = parsedModelIssues || [];
  const blockingModelIssueCount = modelIssues.filter((issue) => issue.is_warning !== true).length;
  const contentValidationContractValid = Boolean(mainContent && branchContent);
  const validation: ReviewedValidation = {
    modelIssues,
    contentResult: branchContent,
    contentIssueCount: branchContentIssueCount,
    newContentIssueCount,
    contentError: !contentValidationContractValid
      ? 'Fresh Content Validator evidence was unavailable or invalid.'
      : undefined,
    blocking: parsedModelIssues === null
      || blockingModelIssueCount > 0
      || newContentIssueCount > 0
      || !contentValidationContractValid,
  };

  let dbt: ReleaseGateDbtMetadata | null = null;
  if (rawDbt !== null) {
    try {
      const parsed = parseConnectionDbtConfig(rawDbt);
      dbt = parsed.state === 'configured'
        ? {
            state: parsed.state,
            supportsDbt: parsed.supportsDbt,
            branch: parsed.branch,
            dbtVersion: parsed.dbtVersion,
            autogenRelationships: parsed.autogenRelationships,
            enableSemanticLayer: parsed.enableSemanticLayer,
            enableVirtualSchemas: parsed.enableVirtualSchemas,
            projectRootPath: parsed.projectRootPath,
          }
        : {
            state: parsed.state,
            supportsDbt: parsed.supportsDbt,
          };
    } catch {
      dbt = null;
    }
  }
  const dbtEnvironments: ReleaseGateDbtEnvironmentMetadata | null = dbt?.state === 'configured'
    ? parseDbtEnvironmentInventory(rawDbtEnvironments)
    : dbt
      ? { state: 'not_applicable' }
      : null;
  const gitCapability = rawGit
    ? normalizeModelGitCapability(input.model, rawGit, true)
    : gitVerifiedNotConfigured
      ? normalizeModelGitCapability(input.model, undefined, true)
      : null;
  const git = gitCapability ? {
    configured: gitCapability.gitConfigured,
    follower: gitCapability.gitFollower,
    pullRequestRequired: gitCapability.pullRequestRequired,
    baseBranch: firstString(rawGit?.baseBranch, rawGit?.base_branch),
    webUrl: gitCapability.webUrl,
  } : null;
  const gitStateChanged = Boolean(gitCapability && (
    gitCapability.editable !== input.branch.capability.editable
    || gitCapability.gitConfigured !== input.branch.capability.gitConfigured
    || gitCapability.gitFollower !== input.branch.capability.gitFollower
    || gitCapability.pullRequestRequired !== input.branch.capability.pullRequestRequired
  ));
  const missingChecksums = diff.filter((row) => (
    (row.change !== 'added' && !row.beforeChecksum)
    || (row.change !== 'deleted' && !row.afterChecksum)
  )).map((row) => row.fileName);
  const parsedAffectedContentScope = parseAffectedContentScope(input.affectedContentScope);
  const parsedAffectedContent = parseAffectedContentInventory(input.affectedContent);
  const affectedContentScope: ReleaseGateAffectedContentScope = !parsedAffectedContentScope
    ? {
        state: 'unavailable',
        basis: 'not_collected',
        targets: [],
        reason: Array.isArray(input.affectedContent)
          ? 'The caller-supplied inventory did not include a valid independent scope and basis.'
          : 'No independent affected-content inventory or impact-scope evidence was supplied.',
      }
    : parsedAffectedContentScope.state === 'verified' && parsedAffectedContent === null
      ? {
          state: 'unavailable',
          basis: parsedAffectedContentScope.basis,
          targets: parsedAffectedContentScope.targets,
          reason: 'The caller-supplied affected-content inventory did not match the expected contract.',
        }
      : parsedAffectedContentScope;
  const affectedContent = affectedContentScope.state === 'verified' && parsedAffectedContent
    ? uniqueContent(parsedAffectedContent)
    : [];
  const handoff = input.handoff || {
    mode: input.branch.capability.pullRequestRequired ? 'pull_request' : 'manual',
    status: 'not_started' as const,
  };

  const checks: ReleaseGateCheck[] = [
    {
      id: 'connection',
      label: 'Connection scope',
      status: connectionId ? 'ready' : 'blocked',
      detail: connectionId
        ? `${input.model.connectionName || connectionId} is bound to the selected instance.`
        : 'The model does not expose a connection ID.',
    },
    {
      id: 'caller',
      label: 'Caller scope evidence',
      status: !caller || caller.rolesByModelTruncated
        ? 'unavailable'
        : caller.targetModelAccessObserved && caller.targetModelPermissionCount > 0
          ? 'ready'
          : 'blocked',
      detail: !caller
        ? 'The authenticated caller could not be verified with the documented whoami contract.'
        : caller.rolesByModelTruncated
          ? 'The model-scoped whoami response reported truncated evidence and cannot authorize this handoff.'
          : caller.targetModelAccessObserved && caller.targetModelPermissionCount > 0
          ? `${caller.keyScope === 'organization' ? 'Organization key' : 'Personal access token'} returned ${caller.targetModelPermissionCount} effective permission${caller.targetModelPermissionCount === 1 ? '' : 's'} for this model.`
          : caller.targetModelAccessObserved
            ? 'The model-scoped whoami response returned the model without any effective permissions.'
            : 'The model-scoped whoami response did not return effective permissions for this model.',
    },
    {
      id: 'dbt',
      label: 'dbt metadata',
      status: dbt ? 'ready' : 'unavailable',
      detail: dbt
        ? dbt.state === 'configured'
          ? `Configured on ${dbt.branch} with dbt ${dbt.dbtVersion}.`
          : dbt.state === 'not_supported'
            ? 'This connection reports that dbt is not supported.'
            : 'This connection reports that dbt is not configured.'
        : 'Fresh dbt metadata could not be verified.',
    },
    {
      id: 'dbt_environments',
      label: 'dbt environments',
      status: !dbt
        ? 'unavailable'
        : dbt.state !== 'configured'
          ? 'ready'
          : dbtEnvironments?.state === 'verified' && dbtEnvironments.defaultEnvironmentCount === 1
            ? 'ready'
            : 'blocked',
      detail: !dbt
        ? 'dbt configuration could not be verified, so environment applicability is unknown.'
        : dbt.state !== 'configured'
          ? `Not applicable because dbt is ${dbt.state === 'not_supported' ? 'not supported' : 'not configured'} for this connection.`
          : dbtEnvironments?.state !== 'verified'
            ? 'The documented dbt-environment inventory was unavailable or did not match the expected array contract.'
            : dbtEnvironments.defaultEnvironmentCount !== 1
              ? `${dbtEnvironments.environmentCount} dbt environment${dbtEnvironments.environmentCount === 1 ? '' : 's'} returned with ${dbtEnvironments.defaultEnvironmentCount} defaults; exactly one default is required.`
              : `${dbtEnvironments.environmentCount} dbt environment${dbtEnvironments.environmentCount === 1 ? '' : 's'} returned with exactly one default.`,
    },
    {
      id: 'git',
      label: 'Git policy',
      status: git && !gitStateChanged && !git.follower ? 'ready' : 'blocked',
      detail: !git
        ? 'Fresh Git/model policy could not be verified.'
        : gitStateChanged
          ? 'Git protection or editability changed after the branch was reviewed.'
          : git.follower
            ? 'The model is now a read-only Git follower.'
            : git.pullRequestRequired ? 'Protected model: pull-request handoff only.' : 'Unprotected model: manual Omni sign-off only.',
    },
    {
      id: 'branch',
      label: 'Reviewed branch',
      status: branchYaml ? 'ready' : 'blocked',
      detail: branchYaml
        ? `${input.branch.branchName} (${input.branch.branchId}) was re-read from Omni.`
        : 'The exact reviewed branch could not be re-read.',
    },
    {
      id: 'checksums',
      label: 'Fresh checksums',
      status: mainYaml && branchYaml && missingChecksums.length === 0 ? 'ready' : 'blocked',
      detail: !mainYaml || !branchYaml
        ? 'Main and branch checksums are incomplete.'
        : missingChecksums.length > 0
          ? `Checksums are missing for ${missingChecksums.join(', ')}.`
          : `${diff.length} changed file${diff.length === 1 ? '' : 's'} has fresh main/branch checksum evidence.`,
    },
    {
      id: 'model_validation',
      label: 'Model validation',
      status: parsedModelIssues !== null && blockingModelIssueCount === 0 ? 'ready' : 'blocked',
      detail: modelValidationResult.status === 'rejected'
        ? 'Fresh model validation could not be completed.'
        : parsedModelIssues === null
          ? 'The successful model-validation response did not match the expected issue-array contract.'
          : blockingModelIssueCount > 0
          ? `${blockingModelIssueCount} blocking model issue${blockingModelIssueCount === 1 ? '' : 's'} found.`
          : 'Fresh model validation has no blocking issues.',
    },
    {
      id: 'content_validation',
      label: 'Content Validator GET',
      status: contentValidationContractValid && newContentIssueCount === 0 ? 'ready' : 'blocked',
      detail: !contentValidationContractValid
        ? mainContentResult.status === 'rejected' || branchContentResult.status === 'rejected'
          ? 'Fresh main and branch Content Validator requests could not both be completed.'
          : 'A successful Content Validator response did not match the expected content-array contract or included an error envelope.'
        : newContentIssueCount > 0
          ? `${newContentIssueCount} new downstream content issue${newContentIssueCount === 1 ? '' : 's'} found.`
          : 'No new downstream content issues were introduced.',
    },
    {
      id: 'affected_content',
      label: 'Affected content / scope',
      status: affectedContentScope.state === 'unavailable' ? 'unavailable' : 'ready',
      detail: affectedContentScope.state === 'unavailable'
        ? affectedContentScope.reason || 'Affected-content scope could not be verified.'
        : affectedContentScope.state === 'metadata_only'
          ? `${affectedContentScope.targets.length} exact semantic label target${affectedContentScope.targets.length === 1 ? '' : 's'} declared as metadata-only scope. Consumer content was not inventoried, and no zero-impact claim is made.`
          : affectedContent.length > 0
            ? `Targeted Content Validator inventory captured ${affectedContent.length} content item${affectedContent.length === 1 ? '' : 's'} across ${affectedContentScope.targets.length} exact semantic target${affectedContentScope.targets.length === 1 ? '' : 's'}.`
            : `Targeted Content Validator inventory verified zero matching content items across ${affectedContentScope.targets.length} exact semantic target${affectedContentScope.targets.length === 1 ? '' : 's'}; this is not a model-wide zero-impact claim.`,
    },
    {
      id: 'diff',
      label: 'Reviewed diff',
      status: diff.length > 0 && unexpectedFiles.length === 0 ? 'ready' : 'blocked',
      detail: diff.length > 0
        ? unexpectedFiles.length > 0
          ? `The branch also changed outside the reviewed scope: ${unexpectedFiles.join(', ')}.`
          : `${diff.length} changed file${diff.length === 1 ? '' : 's'}: ${diff.map((row) => `${row.change} ${row.fileName}`).join(', ')}.`
        : 'No branch change was found in the reviewed scope.',
    },
    {
      id: 'handoff',
      label: 'Release handoff',
      status: 'ready',
      detail: handoff.mode === 'pull_request'
        ? handoff.status === 'pull_request_ready' ? 'Verified pull-request evidence is ready.' : 'A protected-model pull request may be created after approval.'
        : handoff.status === 'manual_handoff_ready' ? 'Manual Omni handoff is ready.' : 'The validated branch will remain for manual Omni sign-off. No merge will be attempted.',
    },
  ];
  const blockers = checks
    .filter((check) => check.status !== 'ready')
    .map((check) => `${check.label}: ${check.detail}`);
  const status: ReleaseGateStatus = blockers.length > 0
    ? 'blocked'
    : input.branch.capability.pullRequestRequired
      ? 'ready_for_pull_request'
      : 'ready_for_manual_handoff';
  const withoutFingerprint: Omit<ReleaseGateEvidence, 'fingerprint' | 'collectedAt'> = {
    version: 2,
    status,
    connection: {
      instanceId: input.connection.instanceId,
      instanceLabel: input.connection.instanceLabel,
      origin: connectionOrigin,
      connectionId,
      connectionName: input.model.connectionName,
    },
    caller,
    dbt,
    dbtEnvironments,
    git,
    branch: {
      modelId: input.model.id,
      modelName: input.model.name,
      branchId: input.branch.branchId,
      branchName: input.branch.branchName,
      verified: Boolean(branchYaml),
    },
    validation,
    affectedContent,
    affectedContentScope,
    diff,
    handoff,
    checks,
    blockers,
  };
  return {
    ...withoutFingerprint,
    collectedAt: new Date().toISOString(),
    fingerprint: releaseFingerprint(withoutFingerprint),
  };
}

export function approveReleaseGate(evidence: ReleaseGateEvidence): ReleaseGateApproval | null {
  if (evidence.status === 'blocked') return null;
  return {
    fingerprint: evidence.fingerprint,
    approvedAt: new Date().toISOString(),
    status: evidence.status,
  };
}

export function reconcileReleaseGateApproval(
  approval: ReleaseGateApproval | null,
  evidence: ReleaseGateEvidence,
): ReleaseGateApproval | null {
  if (!approval || evidence.status === 'blocked') return null;
  if (approval.fingerprint !== evidence.fingerprint || approval.status !== evidence.status) return null;
  return approval;
}
