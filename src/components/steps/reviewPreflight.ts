import type { MigrationResult } from '@/types';

export function canApplyModelRemapAfterPreflight(
  selectedDashboards: Array<{ id: string }>,
  dryRunResults: MigrationResult[] | null,
): boolean {
  if (selectedDashboards.length === 0 || !dryRunResults || dryRunResults.length === 0) return false;
  const resultsById = new Map(dryRunResults.map((result) => [result.id, result]));
  return selectedDashboards.every((dashboard) => {
    const result = resultsById.get(dashboard.id);
    return result?.status === 'ready' || result?.status === 'warning';
  });
}
