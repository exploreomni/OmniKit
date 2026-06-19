import {
  DASHBOARD_MIGRATION_DRAFT_STORAGE_KEY,
  type DashboardMigrationDraft,
  type DashboardMigrationTopicMappingDraft,
} from './dashboardMigrationTypes';

const FORBIDDEN_DRAFT_KEYS = new Set(['apiKey', 'api_key', 'token', 'secret', 'passphrase', 'baseUrl', 'base_url']);

export function dashboardMigrationDraftContainsForbiddenKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(dashboardMigrationDraftContainsForbiddenKeys);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => (
    FORBIDDEN_DRAFT_KEYS.has(key) || dashboardMigrationDraftContainsForbiddenKeys(item)
  ));
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
    : [];
}

function sanitizeTopicMappings(value: unknown): DashboardMigrationTopicMappingDraft[] {
  return Array.isArray(value) ? value.map((mapping) => ({
    sourceTopicName: mapping.sourceTopicName || '',
    sourceTopicId: mapping.sourceTopicId || undefined,
    action: mapping.action === 'copy_source' ? 'copy_source' as const : mapping.action === 'map_existing' ? 'map_existing' as const : 'unresolved' as const,
    targetTopicName: mapping.targetTopicName || '',
    targetTopicLabel: mapping.targetTopicLabel || undefined,
    status: mapping.status,
    warnings: uniqueStrings(mapping.warnings),
  })).filter((mapping) => mapping.sourceTopicName) : [];
}

export function sanitizeDashboardMigrationDraftForStorage(input: DashboardMigrationDraft): DashboardMigrationDraft {
  return {
    step: input.step,
    sourceId: input.sourceId || '',
    sourceConnectionId: input.sourceConnectionId || '',
    sourceFolderId: input.sourceFolderId || '',
    sourceFolderPath: input.sourceFolderPath || '',
    selectedDocumentIds: uniqueStrings(input.selectedDocumentIds),
    targets: Array.isArray(input.targets) ? input.targets.map((target) => ({
      id: target.id || '',
      destinationInstanceId: target.destinationInstanceId || '',
      targetConnectionId: target.targetConnectionId || '',
      targetModelId: target.targetModelId || '',
      targetModelName: target.targetModelName || '',
      targetFolderPath: target.targetFolderPath || '',
      targetFolderId: target.targetFolderId || '',
      topicMappings: sanitizeTopicMappings(target.topicMappings),
    })) : [],
    routeGroups: Array.isArray(input.routeGroups) ? input.routeGroups.map((group, index) => {
      const topicMappingsByTargetId = Object.fromEntries(
        Object.entries(group.topicMappingsByTargetId || {})
          .map(([targetRowId, mappings]) => [targetRowId, sanitizeTopicMappings(mappings)] as const)
          .filter(([, mappings]) => mappings.length > 0),
      );
      return {
        id: group.id || `route-group-${index + 1}`,
        name: group.name || `Route group ${index + 1}`,
        documentIds: uniqueStrings(group.documentIds),
        targetRowIds: uniqueStrings(group.targetRowIds),
        topicMappingsByTargetId,
      };
    }).filter((group) => group.documentIds.length > 0 && group.targetRowIds.length > 0) : [],
    replaceSameNamed: input.replaceSameNamed !== false,
    emptyFirst: input.emptyFirst === true,
    refreshSchemaOnComplete: input.refreshSchemaOnComplete === true,
    deleteSourceOnSuccess: input.deleteSourceOnSuccess === true,
  };
}

export function loadDashboardMigrationDraft(): DashboardMigrationDraft | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(DASHBOARD_MIGRATION_DRAFT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DashboardMigrationDraft;
    return sanitizeDashboardMigrationDraftForStorage(parsed);
  } catch {
    return null;
  }
}

export function saveDashboardMigrationDraft(input: DashboardMigrationDraft): void {
  if (typeof window === 'undefined') return;
  const sanitized = sanitizeDashboardMigrationDraftForStorage(input);
  window.localStorage.setItem(DASHBOARD_MIGRATION_DRAFT_STORAGE_KEY, JSON.stringify(sanitized));
}

export function clearDashboardMigrationDraft(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(DASHBOARD_MIGRATION_DRAFT_STORAGE_KEY);
}
