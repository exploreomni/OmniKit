export const FLEET_CONTEXT_QUERY_KEYS = [
  'fleetView',
  'fleetInstances',
  'fleetConnection',
  'fleetState',
  'fleetFreshness',
  'fleetWindow',
  'fleetSearch',
] as const;

export type FleetContextQueryKey = typeof FLEET_CONTEXT_QUERY_KEYS[number];
export type AdminWorkspaceId = 'fleet' | 'identity' | 'content' | 'developer';
export type IdentityWorkspaceTab = 'groups' | 'import' | 'health';

export interface AdminWorkspaceNavigationItem {
  id: string;
  label: string;
  path: string;
  tab?: IdentityWorkspaceTab;
}

export interface AdminWorkspaceDefinition {
  id: AdminWorkspaceId;
  label: string;
  basePath: string;
  defaultPath: string;
  navigation: readonly AdminWorkspaceNavigationItem[];
}

export const ADMIN_WORKSPACES = [
  {
    id: 'fleet',
    label: 'Fleet & Readiness',
    basePath: '/admin/fleet',
    defaultPath: '/admin/fleet/instances',
    navigation: [
      { id: 'instances', label: 'Instances', path: '/admin/fleet/instances' },
      { id: 'connections', label: 'Connections', path: '/admin/fleet/connections' },
      { id: 'ai-governance', label: 'AI Governance', path: '/admin/fleet/ai-governance' },
    ],
  },
  {
    id: 'identity',
    label: 'Identity & Access',
    basePath: '/admin/identity',
    defaultPath: '/admin/identity/users',
    navigation: [
      { id: 'users', label: 'Users', path: '/admin/identity/users' },
      { id: 'groups', label: 'Groups', path: '/admin/identity/users', tab: 'groups' },
      { id: 'import', label: 'Bulk Import', path: '/admin/identity/users', tab: 'import' },
      { id: 'health', label: 'User Health', path: '/admin/identity/users', tab: 'health' },
    ],
  },
  {
    id: 'content',
    label: 'Content Operations',
    basePath: '/admin/content',
    defaultPath: '/admin/content/health',
    navigation: [
      { id: 'health', label: 'Content Health', path: '/admin/content/health' },
      { id: 'schedules', label: 'Schedules', path: '/admin/content/schedules' },
      { id: 'uploads', label: 'Uploads', path: '/admin/content/uploads' },
      { id: 'labels', label: 'Labels', path: '/admin/content/labels' },
    ],
  },
  {
    id: 'developer',
    label: 'Embed & Developer Tools',
    basePath: '/admin/developer',
    defaultPath: '/admin/developer/embeds',
    navigation: [
      { id: 'embeds', label: 'Embed URLs', path: '/admin/developer/embeds' },
      { id: 'api-contract', label: 'API Contract', path: '/admin/developer/api-contract' },
      { id: 'enablement', label: 'Role Enablement', path: '/admin/developer/enablement' },
    ],
  },
] as const satisfies readonly AdminWorkspaceDefinition[];

export const ADMIN_WORKSPACE_BY_ID: Record<AdminWorkspaceId, AdminWorkspaceDefinition> = {
  fleet: ADMIN_WORKSPACES[0],
  identity: ADMIN_WORKSPACES[1],
  content: ADMIN_WORKSPACES[2],
  developer: ADMIN_WORKSPACES[3],
};

const FLEET_CONTEXT_QUERY_KEY_SET = new Set<string>(FLEET_CONTEXT_QUERY_KEYS);

function asSearchParams(search: string | URLSearchParams): URLSearchParams {
  return typeof search === 'string' ? new URLSearchParams(search) : search;
}

function hrefWithSearch(path: string, searchParams: URLSearchParams): string {
  const search = searchParams.toString();
  return search ? `${path}?${search}` : path;
}

export function fleetContextSearchParams(search: string | URLSearchParams): URLSearchParams {
  const source = asSearchParams(search);
  const context = new URLSearchParams();

  for (const [key, value] of source) {
    if (FLEET_CONTEXT_QUERY_KEY_SET.has(key)) context.append(key, value);
  }

  return context;
}

export function adminWorkspaceHref(
  path: string,
  search: string | URLSearchParams,
  tab?: IdentityWorkspaceTab,
): string {
  const context = fleetContextSearchParams(search);
  if (tab) context.set('tab', tab);
  return hrefWithSearch(path, context);
}

export function identityWorkspaceTabHref(
  path: string,
  search: string | URLSearchParams,
  hash: string,
  tab?: IdentityWorkspaceTab,
): string {
  const nextSearch = new URLSearchParams(asSearchParams(search));
  nextSearch.delete('tab');
  if (tab) nextSearch.set('tab', tab);
  return `${hrefWithSearch(path, nextSearch)}${hash}`;
}

const FLEET_CONTEXT_TO_COMMAND_CENTER = [
  ['fleetView', 'view'],
  ['fleetInstances', 'instances'],
  ['fleetConnection', 'connection'],
  ['fleetState', 'state'],
  ['fleetFreshness', 'freshness'],
  ['fleetWindow', 'window'],
  ['fleetSearch', 'q'],
] as const satisfies readonly [FleetContextQueryKey, string][];

export function fleetCommandCenterHref(search: string | URLSearchParams): string {
  const source = asSearchParams(search);
  const fleetSearch = new URLSearchParams();

  for (const [sourceKey, destinationKey] of FLEET_CONTEXT_TO_COMMAND_CENTER) {
    for (const value of source.getAll(sourceKey)) fleetSearch.append(destinationKey, value);
  }

  return hrefWithSearch('/', fleetSearch);
}
