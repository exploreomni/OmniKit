import type { InstanceDocument } from '../../services/opsConsole';
import { ApiError } from '../../services/omniApi';

export function sourceConnectionLoadError(error: unknown): string {
  if (error instanceof ApiError && (error.code === 'MODEL_MIGRATOR_READINESS_TIMEOUT'
    || error.code === 'MODEL_MIGRATOR_UPSTREAM_TIMEOUT')) {
    return 'Loading source connections timed out. The request may have been waiting for API capacity or a response from Omni. Retry source connections; this does not require a page refresh.';
  }
  return error instanceof Error ? error.message : 'Could not load source connections.';
}

export function sourceConnectionEmptyLabel(catalog: { error: string; loaded: boolean }): string {
  if (catalog.error) return 'Connections could not be loaded — retry below';
  return catalog.loaded ? 'No active source connections found' : 'Source connections have not been loaded yet';
}

/** A lookup verifies individual choices, never completeness of the source catalog. */
export function mergeVerifiedDashboardDocuments(existing: InstanceDocument[], incoming: InstanceDocument[], connectionId: string): InstanceDocument[] {
  if (incoming.some((document) => !document?.id || !document.identifier || document.connectionId !== connectionId)) {
    throw new Error('The returned dashboards did not match the selected source connection. Nothing was added.');
  }
  const documents = new Map(existing.filter((document) => document.connectionId === connectionId).map((document) => [document.identifier, document]));
  for (const document of incoming) documents.set(document.identifier, { ...documents.get(document.identifier), ...document });
  return [...documents.values()];
}

export function hasVerifiedDashboardSelection(documents: InstanceDocument[], selectedIds: string[], connectionId: string): boolean {
  const verifiedIds = new Set(documents.filter((document) => document.connectionId === connectionId).map((document) => document.identifier));
  return selectedIds.length > 0 && selectedIds.every((id) => verifiedIds.has(id));
}
