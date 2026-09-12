import type { DashboardSafeCopyTopicMapping } from '../../../shared/dashboardSafeCopyContract';

/** Preserve unrelated mappings and require exact candidate membership, never a name similarity match. */
export function reviewedExistingTopicMapping(
  current: DashboardSafeCopyTopicMapping[] | undefined,
  sourceTopicName: string,
  targetTopicName: string,
  candidateNames: string[],
): DashboardSafeCopyTopicMapping[] {
  if (targetTopicName && !candidateNames.includes(targetTopicName)) throw new Error('Choose an exact topic returned for this destination.');
  const mappings = (current || []).filter((mapping) => mapping.sourceTopicName !== sourceTopicName);
  return targetTopicName ? [...mappings, { sourceTopicName, action: 'map_existing', targetTopicName }] : mappings;
}
