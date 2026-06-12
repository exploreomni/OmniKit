import { FANOUT_DRAFT_STORAGE_KEY, type FanoutDraft } from './fanoutTypes';

const FORBIDDEN_DRAFT_KEYS = new Set([
  'apiKey',
  'api_key',
  'token',
  'secret',
  'password',
  'passphrase',
  'authorization',
  'headers',
  'body',
  'url',
  'baseUrl',
]);

export function sanitizeFanoutDraftForStorage(input: FanoutDraft): FanoutDraft {
  return {
    step: input.step,
    sourceId: input.sourceId,
    sourceModelId: input.sourceModelId,
    selectedDocumentIds: [...new Set(input.selectedDocumentIds.filter(Boolean))],
    emptyFirst: input.emptyFirst,
    metadataOnly: input.metadataOnly,
    refreshSchemaAfterImport: input.refreshSchemaAfterImport,
    targets: input.targets.map((target) => ({
      id: target.id,
      destinationInstanceId: target.destinationInstanceId,
      targetModelId: target.targetModelId,
      targetModelName: target.targetModelName,
      targetFolderPath: target.targetFolderPath,
      targetFolderId: target.targetFolderId,
      selectedActionIndexes: target.selectedActionIndexes.filter((index) => Number.isInteger(index) && index >= 0),
    })),
  };
}

export function draftContainsForbiddenKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(draftContainsForbiddenKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => (
    FORBIDDEN_DRAFT_KEYS.has(key) || draftContainsForbiddenKeys(item)
  ));
}

export function loadFanoutDraft(): FanoutDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(FANOUT_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FanoutDraft;
    if (draftContainsForbiddenKeys(parsed)) return null;
    return sanitizeFanoutDraftForStorage(parsed);
  } catch {
    return null;
  }
}

export function saveFanoutDraft(input: FanoutDraft): void {
  if (typeof window === 'undefined') return;
  const sanitized = sanitizeFanoutDraftForStorage(input);
  if (draftContainsForbiddenKeys(sanitized)) return;
  try {
    window.sessionStorage.setItem(FANOUT_DRAFT_STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // Draft recovery is best-effort only.
  }
}

export function clearFanoutDraft(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(FANOUT_DRAFT_STORAGE_KEY);
}
