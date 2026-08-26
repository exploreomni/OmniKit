import { getModelYaml, listModels } from '@/services/omniApi';
import { parseVerifiedModelInventory } from '@/services/topicsRequestState';
import { sha256Text } from '@/services/contentHash';
import type { OmniModel } from '@/types';

export interface AIContentModelSnapshot {
  modelId: string;
  contentHash: string;
  activeBranchIds: string[];
  capturedAt: string;
}

export interface AIContentModelMutationCheck {
  status: 'unchanged' | 'changed' | 'unavailable';
  issues: string[];
  checkedAt: string;
}

function canonicalRecord(record: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(record || {}).sort(([left], [right]) => left.localeCompare(right));
}

export function fingerprintModelSnapshot(
  modelId: string,
  yaml: { files?: Record<string, string>; checksums?: Record<string, string> },
  models: OmniModel[],
): AIContentModelSnapshot {
  const files = canonicalRecord(yaml.files);
  const checksums = canonicalRecord(yaml.checksums);
  if (files.length === 0 && checksums.length === 0) {
    throw new Error('Omni did not return model YAML files or checksums for the mutation baseline.');
  }
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error('The selected model was absent from the refreshed model inventory.');
  const activeBranchIds = (model.branches || [])
    .map((branch) => branch.id?.trim() || '')
    .filter(Boolean)
    .sort();
  return {
    modelId,
    contentHash: sha256Text(JSON.stringify({ files, checksums })),
    activeBranchIds,
    capturedAt: new Date().toISOString(),
  };
}

export async function captureAIContentModelSnapshot(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  modelKind: 'SHARED' | 'SHARED_EXTENSION',
): Promise<AIContentModelSnapshot> {
  const [yaml, inventory] = await Promise.all([
    getModelYaml(baseUrl, apiKey, modelId, { includeChecksums: true, fresh: true }),
    listModels(baseUrl, apiKey, {
      modelId,
      modelKind,
      allPages: true,
      pageSize: 100,
      include: 'activeBranches',
      forceRefresh: true,
    }),
  ]);
  return fingerprintModelSnapshot(
    modelId,
    yaml,
    parseVerifiedModelInventory<OmniModel>(inventory, ['SHARED', 'SHARED_EXTENSION']),
  );
}

export function compareAIContentModelSnapshots(
  before: AIContentModelSnapshot,
  after: AIContentModelSnapshot,
): AIContentModelMutationCheck {
  const issues: string[] = [];
  if (before.modelId !== after.modelId) {
    issues.push('MODEL_SCOPE_CHANGED: the post-run snapshot does not match the selected model.');
  }
  if (before.contentHash !== after.contentHash) {
    issues.push('MODEL_CONTENT_CHANGED: the selected main-model YAML or checksums changed during the Agent run.');
  }
  const priorBranches = new Set(before.activeBranchIds);
  const currentBranches = new Set(after.activeBranchIds);
  const added = after.activeBranchIds.filter((branchId) => !priorBranches.has(branchId));
  const removed = before.activeBranchIds.filter((branchId) => !currentBranches.has(branchId));
  if (added.length > 0) {
    issues.push(`NEW_MODEL_BRANCHES: ${added.join(', ')} appeared during the Agent run.`);
  }
  if (removed.length > 0) {
    issues.push(`MODEL_BRANCHES_REMOVED: ${removed.join(', ')} disappeared during the Agent run.`);
  }
  return {
    status: issues.length > 0 ? 'changed' : 'unchanged',
    issues,
    checkedAt: after.capturedAt,
  };
}

export function unavailableModelMutationCheck(message: string): AIContentModelMutationCheck {
  return {
    status: 'unavailable',
    issues: [`MODEL_POSTCONDITION_UNAVAILABLE: ${message}`],
    checkedAt: new Date().toISOString(),
  };
}
