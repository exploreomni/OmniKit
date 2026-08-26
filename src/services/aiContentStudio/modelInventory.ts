import { ApiError, listModels } from '../omniApi';
import { parseVerifiedModelInventory } from '../topicsRequestState';
import type { OmniModel } from '@/types';

export type AIContentModelInventoryLoader = (
  kind: 'SHARED',
  forceRefresh: boolean,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface AIContentDashboardModelEvidence {
  /** Authoritative model association from GET /v2/documents/{documentId}. */
  documentModelId?: string;
  /** Document-specific WORKBOOK model from the current document state. */
  workbookModelId?: string;
  /** Model associations present on the dashboard's saved queries. */
  queryModelIds: readonly string[];
  /** Connection carried by the selected document-list record, when present. */
  connectionId?: string;
  /** Connection carried by the current document state, when present. */
  documentConnectionId?: string;
  /** Safe local explanation when the current document state could not be read. */
  documentModelReadError?: string;
}

export interface AIContentDashboardModelResolution {
  /** Raw IDs retained in evidence order: document, workbook, then queries. */
  detectedModelIds: string[];
  /** Exact verified SHARED IDs that may be selected for the review. */
  eligibleModelIds: string[];
  /** Auditable raw-ID to canonical-SHARED-ID lineage. */
  canonicalModelIdByDetectedId: Record<string, string>;
  /** A fail-closed reason that must prevent review submission. */
  blockedReason?: string;
  /** Non-blocking provenance note, typically when exact fallback lineage was used. */
  notice?: string;
}

export type AIContentExactModelLoader = (
  modelId: string,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface ResolveAIContentDashboardModelsInput {
  baseUrl: string;
  apiKey: string;
  verifiedSharedModels: readonly OmniModel[];
  evidence: AIContentDashboardModelEvidence;
  loadExactModel?: AIContentExactModelLoader;
  signal?: AbortSignal;
}

const WORKBOOK_MODEL_KIND = 'WORKBOOK';
const UNSUPPORTED_LINEAGE_KINDS = new Set(['SHARED_EXTENSION', 'BRANCH']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function uniqueNonBlank(values: readonly unknown[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = nonBlank(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function modelLabel(modelId: string): string {
  const bounded = modelId.length > 96 ? `${modelId.slice(0, 93)}...` : modelId;
  return `"${bounded}"`;
}

function parseExactModelEnvelope(value: unknown, expectedModelId: string): OmniModel | null {
  if (!isRecord(value) || value.complete !== true || !Array.isArray(value.models)) {
    throw new Error('The exact model lookup returned an incomplete response.');
  }
  if (
    !Number.isSafeInteger(value.pagesFetched)
    || Number(value.pagesFetched) < 1
    || !Number.isSafeInteger(value.loadedResults)
    || !Number.isSafeInteger(value.totalResults)
    || Number(value.loadedResults) !== value.models.length
    || Number(value.totalResults) !== value.models.length
    || value.models.length > 1
    || !isRecord(value.pageInfo)
    || value.pageInfo.hasNextPage !== false
    || (value.pageInfo.nextCursor !== undefined && value.pageInfo.nextCursor !== null)
    || !Number.isSafeInteger(value.pageInfo.pageSize)
    || Number(value.pageInfo.pageSize) < 1
    || !Number.isSafeInteger(value.pageInfo.totalRecords)
    || Number(value.pageInfo.totalRecords) !== value.models.length
  ) {
    throw new Error('The exact model lookup returned an invalid response.');
  }
  if (value.models.length === 0) return null;

  const candidate = value.models[0];
  if (!isRecord(candidate)) throw new Error('The exact model lookup returned an invalid record.');
  const id = nonBlank(candidate.id);
  const kind = nonBlank(candidate.kind);
  if (id !== expectedModelId || !kind) {
    throw new Error('The exact model lookup did not return the requested model.');
  }
  for (const key of ['baseModelId', 'connectionId'] as const) {
    if (candidate[key] !== undefined && candidate[key] !== null && !nonBlank(candidate[key])) {
      throw new Error('The exact model lookup returned invalid lineage metadata.');
    }
  }

  return {
    id,
    name: nonBlank(candidate.name) || id,
    kind,
    baseModelId: nonBlank(candidate.baseModelId),
    connectionId: nonBlank(candidate.connectionId),
  };
}

function connectionConflict(values: ReadonlyArray<string | undefined>): boolean {
  return new Set(uniqueNonBlank(values)).size > 1;
}

function summarizeIssues(issues: readonly string[]): string | undefined {
  if (issues.length === 0) return undefined;
  const visible = issues.slice(0, 3);
  const remaining = issues.length - visible.length;
  return `${visible.join(' ')}${remaining > 0 ? ` ${remaining} additional model evidence issue${remaining === 1 ? '' : 's'} must also be resolved.` : ''}`;
}

export async function loadAIContentModelInventory(
  baseUrl: string,
  apiKey: string,
  forceRefresh = false,
  loadKind?: AIContentModelInventoryLoader,
  signal?: AbortSignal,
): Promise<OmniModel[]> {
  const loader = loadKind || ((kind, refresh) => listModels(baseUrl, apiKey, {
    modelKind: kind,
    allPages: true,
    pageSize: 100,
    forceRefresh: refresh,
    signal,
  }));

  const models = parseVerifiedModelInventory<OmniModel>(
    await loader('SHARED', forceRefresh, signal),
    ['SHARED'],
  );
  if (models.some((model) => model.kind !== 'SHARED')) {
    throw new Error('Destination model inventory response was invalid.');
  }
  return models;
}

export async function resolveAIContentDashboardModels(
  input: ResolveAIContentDashboardModelsInput,
): Promise<AIContentDashboardModelResolution> {
  const {
    baseUrl,
    apiKey,
    verifiedSharedModels,
    evidence,
    signal,
  } = input;
  const documentModelId = nonBlank(evidence.documentModelId);
  const workbookModelId = nonBlank(evidence.workbookModelId);
  const queryModelIds = uniqueNonBlank(evidence.queryModelIds);
  const detectedModelIds = uniqueNonBlank([
    documentModelId,
    workbookModelId,
    ...queryModelIds,
  ]);
  const documentConnectionId = nonBlank(evidence.documentConnectionId);
  const listConnectionId = nonBlank(evidence.connectionId);
  const verifiedById = new Map<string, OmniModel>();

  for (const model of verifiedSharedModels) {
    if (
      nonBlank(model.id) !== model.id
      || model.kind !== 'SHARED'
      || verifiedById.has(model.id)
    ) {
      throw new Error('Verified shared model inventory was invalid.');
    }
    verifiedById.set(model.id, model);
  }

  const exactLoader = input.loadExactModel || ((modelId, requestSignal) => listModels(
    baseUrl,
    apiKey,
    {
      modelId,
      allPages: true,
      pageSize: 100,
      forceRefresh: true,
      signal: requestSignal,
    },
  ));
  const mapping: Record<string, string> = {};
  const issues: string[] = [];
  let usedWorkbookFallback = false;

  if (connectionConflict([listConnectionId, documentConnectionId])) {
    issues.push('The selected dashboard list record and current document state point to different Omni connections. Refresh the dashboard catalog and select the dashboard again.');
  }

  const resolveDetectedId = async (
    detectedId: string,
    role: 'authoritative' | 'fallback',
  ): Promise<string | undefined> => {
    const exactVerified = verifiedById.get(detectedId);
    if (exactVerified) {
      if (connectionConflict([
        listConnectionId,
        documentConnectionId,
        nonBlank(exactVerified.connectionId),
      ])) {
        issues.push(`Detected model ${modelLabel(detectedId)} belongs to a different Omni connection than the selected dashboard. Reopen the dashboard from the correct connection.`);
        return undefined;
      }
      mapping[detectedId] = exactVerified.id;
      return exactVerified.id;
    }

    let detectedModel: OmniModel | null;
    try {
      detectedModel = parseExactModelEnvelope(
        await exactLoader(detectedId, signal),
        detectedId,
      );
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      issues.push(`Detected model ${modelLabel(detectedId)} could not be verified by an exact model lookup. Retry the model inventory or request access to that model.`);
      return undefined;
    }
    if (!detectedModel) {
      issues.push(`Detected model ${modelLabel(detectedId)} is not available through an exact model lookup. Refresh the dashboard evidence or request access to that model.`);
      return undefined;
    }

    if (detectedModel.kind === 'SHARED') {
      const verified = verifiedById.get(detectedModel.id);
      if (!verified) {
        issues.push(`Detected SHARED model ${modelLabel(detectedId)} is not present in the verified shared-model inventory. Retry the inventory or request model access.`);
        return undefined;
      }
      if (connectionConflict([
        listConnectionId,
        documentConnectionId,
        nonBlank(detectedModel.connectionId),
        nonBlank(verified.connectionId),
      ])) {
        issues.push(`Detected model ${modelLabel(detectedId)} has conflicting Omni connection evidence. Reopen the dashboard from the correct connection.`);
        return undefined;
      }
      mapping[detectedId] = verified.id;
      return verified.id;
    }

    if (detectedModel.kind === WORKBOOK_MODEL_KIND) {
      if (role === 'authoritative') {
        issues.push(`The current document returned WORKBOOK model ${modelLabel(detectedId)} as its authoritative model association. Refresh the dashboard evidence; OmniKit will not reinterpret an invalid top-level model kind.`);
        return undefined;
      }
      const baseModelId = nonBlank(detectedModel.baseModelId);
      if (!baseModelId) {
        issues.push(`Detected WORKBOOK model ${modelLabel(detectedId)} has no exact baseModelId. Open the dashboard in Omni and repair its model association before review.`);
        return undefined;
      }
      const verifiedBase = verifiedById.get(baseModelId);
      if (!verifiedBase) {
        issues.push(`Detected WORKBOOK model ${modelLabel(detectedId)} points to base model ${modelLabel(baseModelId)}, which is not in the verified SHARED inventory. Retry the inventory or request access to that base model.`);
        return undefined;
      }
      if (connectionConflict([
        listConnectionId,
        documentConnectionId,
        nonBlank(detectedModel.connectionId),
        nonBlank(verifiedBase.connectionId),
      ])) {
        issues.push(`Detected WORKBOOK model ${modelLabel(detectedId)} and verified base model ${modelLabel(baseModelId)} have conflicting Omni connection evidence. Reopen the dashboard from the correct connection.`);
        return undefined;
      }
      mapping[detectedId] = verifiedBase.id;
      usedWorkbookFallback = true;
      return verifiedBase.id;
    }

    if (UNSUPPORTED_LINEAGE_KINDS.has(detectedModel.kind || '')) {
      issues.push(`Detected model ${modelLabel(detectedId)} is ${detectedModel.kind}. AI dashboard review requires an exact verified SHARED model; OmniKit does not infer compatible lineage for ${detectedModel.kind}.`);
      return undefined;
    }

    issues.push(`Detected model ${modelLabel(detectedId)} has unsupported kind ${modelLabel(detectedModel.kind || 'unknown')}. AI dashboard review requires an exact verified SHARED model.`);
    return undefined;
  };

  const resolvedCanonicalIds: string[] = [];
  const addCanonical = (modelId: string | undefined) => {
    if (modelId && !resolvedCanonicalIds.includes(modelId)) resolvedCanonicalIds.push(modelId);
  };

  if (documentModelId) {
    const authoritativeCanonicalId = await resolveDetectedId(documentModelId, 'authoritative');
    addCanonical(authoritativeCanonicalId);

    const corroboratingIds = uniqueNonBlank([workbookModelId, ...queryModelIds])
      .filter((modelId) => modelId !== documentModelId);
    const corroboratingCanonicalIds: string[] = [];
    for (const detectedId of corroboratingIds) {
      let canonicalId: string | undefined;
      if (detectedId === workbookModelId && authoritativeCanonicalId) {
        // The current document state explicitly pairs its document-specific
        // WORKBOOK ID with the authoritative modelId.
        canonicalId = authoritativeCanonicalId;
        mapping[detectedId] = canonicalId;
      } else if (authoritativeCanonicalId) {
        // Query IDs are corroborating raw evidence in the normal v2 path. Do
        // not manufacture lineage reads for child IDs. The only provable
        // conflict here is a query ID that is itself another verified SHARED
        // model.
        const exactVerifiedQueryModel = verifiedById.get(detectedId);
        if (exactVerifiedQueryModel) {
          if (connectionConflict([
            listConnectionId,
            documentConnectionId,
            nonBlank(exactVerifiedQueryModel.connectionId),
          ])) {
            issues.push(`Query model ${modelLabel(detectedId)} has conflicting Omni connection evidence. Reopen the dashboard from the correct connection.`);
          } else {
            canonicalId = exactVerifiedQueryModel.id;
            mapping[detectedId] = canonicalId;
          }
        }
      }
      if (canonicalId && !corroboratingCanonicalIds.includes(canonicalId)) {
        corroboratingCanonicalIds.push(canonicalId);
      }
      addCanonical(canonicalId);
    }

    if (
      authoritativeCanonicalId
      && corroboratingCanonicalIds.some((modelId) => modelId !== authoritativeCanonicalId)
    ) {
      issues.push(`Dashboard model evidence conflicts: authoritative document model ${modelLabel(documentModelId)} resolves to ${modelLabel(authoritativeCanonicalId)}, but workbook or query evidence resolves to a different SHARED model. Refresh or repair the dashboard model associations before review.`);
    }
  } else {
    const fallbackIds = uniqueNonBlank([workbookModelId, ...queryModelIds]);
    for (const detectedId of fallbackIds) {
      addCanonical(await resolveDetectedId(detectedId, 'fallback'));
    }
  }

  if (detectedModelIds.length === 0) {
    issues.push('No model association was detected for this dashboard. Refresh the dashboard evidence or open the dashboard in Omni and select a governed model before review.');
  }

  const blockedReason = summarizeIssues(issues);
  const noticeParts: string[] = [];
  if (!documentModelId && evidence.documentModelReadError && !blockedReason) {
    noticeParts.push('The authoritative document model association was unavailable, so OmniKit used exact workbook or query lineage as fallback evidence.');
  }
  if (usedWorkbookFallback && !blockedReason) {
    noticeParts.push('Document-specific WORKBOOK model IDs were resolved through exact baseModelId lineage to verified SHARED models.');
  }

  return {
    detectedModelIds,
    eligibleModelIds: resolvedCanonicalIds,
    canonicalModelIdByDetectedId: mapping,
    ...(blockedReason ? { blockedReason } : {}),
    ...(noticeParts.length > 0 ? { notice: noticeParts.join(' ') } : {}),
  };
}

export function aiContentModelInventoryError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'The saved Omni credential is no longer valid. Reconnect or rotate the instance credential, then retry the model inventory.';
    }
    if (error.status === 403) {
      return 'The saved Omni credential cannot list shared models. Grant model-list access or use a credential with the required scope, then retry.';
    }
    if (error.status === 404) {
      return 'The model inventory endpoint was not found for this instance. Verify the saved Omni instance URL, reconnect it, and retry.';
    }
    if (error.status === 423) {
      return 'Unlock the native vault, then retry the model inventory.';
    }
    if (error.status === 429) {
      return 'Omni is rate-limiting model inventory requests. Wait a moment, then retry.';
    }
    if (error.status === 408 || error.status >= 500 || error.status === 0) {
      return 'The shared Omni model inventory was incomplete or temporarily unavailable. Retry the inventory; if it persists, re-test the saved instance.';
    }
  }

  return 'The shared Omni model inventory could not be verified. Retry the inventory; if it persists, re-test the saved instance.';
}
