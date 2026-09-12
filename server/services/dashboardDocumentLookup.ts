import { OmniClient, type OmniDocumentRecord, type OmniModelRecord } from './omniClient';

export class DashboardLookupError extends Error {
  readonly code = 'DASHBOARD_LOOKUP_UNVERIFIED';
}

/** Extract an identifier only; never forward credentials to a pasted URL. */
export function dashboardReferenceIdentifier(reference: string, baseUrl: string): string {
  const value = reference.trim();
  if (/^[a-zA-Z0-9_-]{1,256}$/.test(value)) return value;
  let parsed: URL;
  try { parsed = new URL(value); } catch {
    throw new DashboardLookupError('Paste a dashboard link or identifier from the selected source instance.');
  }
  const path = /^\/dashboards\/([a-zA-Z0-9_-]{1,256})\/?$/.exec(parsed.pathname);
  if (parsed.protocol !== 'https:' || parsed.origin !== new URL(baseUrl).origin
    || parsed.username || parsed.password || !path) {
    throw new DashboardLookupError('Use a dashboard link from the selected source instance, or its identifier.');
  }
  return path[1];
}

export async function lookupDashboardDocument(
  client: OmniClient,
  identifier: string,
  connectionId: string,
  signal: AbortSignal,
  findModels: (modelId: string, signal: AbortSignal) => Promise<OmniModelRecord[]>,
): Promise<OmniDocumentRecord> {
  const state = await client.getDocumentStateV2(identifier, signal);
  // Documents v2 omits containers for workbook-only documents. Do not infer a
  // dashboard from a URL, name, or the existence of workbook queries.
  if (!Array.isArray(state.containers) || typeof state.name !== 'string' || !state.name.trim()
    || typeof state.modelId !== 'string' || !state.modelId.trim()) {
    throw new DashboardLookupError('Omni did not return a dashboard layout and shared-model binding. Use Browse all dashboards to locate this document.');
  }
  const models = await findModels(state.modelId, signal);
  const matches = models.filter((model) => model.id === state.modelId
    && model.connectionId === connectionId && !model.deletedAt);
  if (matches.length !== 1) {
    throw new DashboardLookupError('The dashboard could not be verified on the selected connection. Check the source connection and dashboard link.');
  }
  if (signal.aborted) throw signal.reason;
  return {
    id: identifier,
    identifier,
    name: state.name,
    connectionId: matches[0].connectionId,
    baseModelId: matches[0].id,
    baseModelName: matches[0].name,
    hasDashboard: true,
    description: typeof state.description === 'string' ? state.description : undefined,
  };
}
