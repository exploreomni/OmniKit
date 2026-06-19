import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusChip } from '@/components/ui/StatusChip';
import {
  getCachedConnectionMetrics,
  getCachedEmbedUserMetrics,
  loadConnectionMetrics,
  loadEmbedUserMetrics,
  type InstanceConnectionStats,
  type InstanceEmbedUserStats,
} from '@/services/opsConsole';
import {
  buildUserHealth,
  readExpectedInactiveEntityKeys,
  writeExpectedInactiveEntityKeys,
  type UserHealthEntityRow,
  type UserHealthFinding,
  type UserHealthInactiveUserRow,
} from '@/services/userHealth';

type EntityFilter = 'all' | 'action_needed' | 'no_users' | 'no_active_users' | 'healthy' | 'expected_inactive' | 'unmapped';
type UserFilter = 'all' | 'inactive' | 'never_logged_in' | 'inactive_never_logged_in' | 'unmapped';

const ENTITY_FILTER_OPTIONS: Array<{ value: EntityFilter; label: string }> = [
  { value: 'all', label: 'All entities' },
  { value: 'action_needed', label: 'Action needed' },
  { value: 'no_users', label: 'No users' },
  { value: 'no_active_users', label: 'No active users' },
  { value: 'healthy', label: 'Healthy' },
  { value: 'expected_inactive', label: 'Expected inactive' },
  { value: 'unmapped', label: 'Unmapped users' },
];

const USER_FILTER_OPTIONS: Array<{ value: UserFilter; label: string }> = [
  { value: 'all', label: 'All reviews' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'never_logged_in', label: 'Never logged in' },
  { value: 'inactive_never_logged_in', label: 'Inactive + never' },
  { value: 'unmapped', label: 'Unmapped users' },
];

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value?: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleDateString();
}

function findingLabel(finding: UserHealthFinding) {
  if (finding === 'no_users') return 'No users';
  if (finding === 'no_active_users') return 'No active users';
  return 'Healthy';
}

function findingStatus(row: UserHealthEntityRow) {
  if (row.expectedInactive) return { status: 'skipped', label: 'Expected inactive' };
  if (row.finding === 'healthy') return { status: 'success', label: 'Healthy' };
  if (row.finding === 'no_users') return { status: 'failed', label: 'No users' };
  return { status: 'warning', label: 'No active users' };
}

function userReasonLabel(row: UserHealthInactiveUserRow) {
  if (row.reason === 'inactive_never_logged_in') return 'Inactive, never logged in';
  if (row.reason === 'inactive') return 'Inactive';
  return 'Never logged in';
}

function csvEscape(value: string | number | boolean | null | undefined) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function exportEntityCsv(rows: UserHealthEntityRow[]) {
  const header = [
    'instance',
    'entity',
    'connections',
    'total_users',
    'active_users',
    'inactive_users',
    'never_logged_in_users',
    'last_login',
    'finding',
    'expected_inactive',
    'action_needed',
  ];
  const body = rows.map((row) => [
    row.instanceLabel,
    row.entityName,
    row.connectionNames.join('; '),
    row.totalUsers,
    row.activeUsers,
    row.inactiveUsers,
    row.neverLoggedInUsers,
    row.lastLogin || '',
    row.finding,
    row.expectedInactive,
    row.actionNeeded,
  ]);
  const csv = [header, ...body].map((line) => line.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `omnikit-user-health-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function rowMatchesSearch(row: UserHealthEntityRow, search: string) {
  const value = search.trim().toLowerCase();
  if (!value) return true;
  return [
    row.instanceLabel,
    row.baseUrl,
    row.entityName,
    row.connectionNames.join(' '),
    findingLabel(row.finding),
  ].some((part) => part.toLowerCase().includes(value));
}

function rowMatchesEntityFilter(row: UserHealthEntityRow, filter: EntityFilter) {
  if (filter === 'all') return true;
  if (filter === 'action_needed') return row.actionNeeded;
  if (filter === 'expected_inactive') return row.expectedInactive;
  if (filter === 'unmapped') return row.entityName === 'Unassigned';
  return row.finding === filter;
}

function userMatchesSearch(row: UserHealthInactiveUserRow, search: string) {
  const value = search.trim().toLowerCase();
  if (!value) return true;
  return [
    row.instanceLabel,
    row.entityName,
    row.displayName,
    row.userName,
    userReasonLabel(row),
  ].some((part) => part.toLowerCase().includes(value));
}

function userMatchesFilter(row: UserHealthInactiveUserRow, filter: UserFilter) {
  if (filter === 'all') return true;
  if (filter === 'inactive') return !row.active;
  if (filter === 'never_logged_in') return !row.lastLogin;
  if (filter === 'unmapped') return row.entityName === 'Unassigned';
  return row.reason === filter;
}

export function UserHealthPage() {
  const cachedConnections = getCachedConnectionMetrics();
  const cachedUsers = getCachedEmbedUserMetrics();
  const [connectionStats, setConnectionStats] = useState<InstanceConnectionStats[]>(() => cachedConnections?.instances ?? []);
  const [embedUserStats, setEmbedUserStats] = useState<InstanceEmbedUserStats[]>(() => cachedUsers?.instances ?? []);
  const [cachedAt, setCachedAt] = useState(() => cachedUsers?.savedAt || cachedConnections?.savedAt || '');
  const [expectedInactiveKeys, setExpectedInactiveKeys] = useState(() => readExpectedInactiveEntityKeys());
  const [search, setSearch] = useState('');
  const [instanceFilter, setInstanceFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState<EntityFilter>('all');
  const [userFilter, setUserFilter] = useState<UserFilter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [connections, users] = await Promise.all([
        loadConnectionMetrics(),
        loadEmbedUserMetrics(),
      ]);
      setConnectionStats(connections.instances);
      setEmbedUserStats(users.instances);
      setCachedAt(new Date().toISOString());
    } catch (err) {
      setError(errorText(err, 'Could not load user health metrics.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const health = useMemo(
    () => buildUserHealth(connectionStats, embedUserStats, expectedInactiveKeys),
    [connectionStats, embedUserStats, expectedInactiveKeys],
  );
  const instanceOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const row of health.entities) options.set(row.instanceId, row.instanceLabel);
    for (const row of health.inactiveUsers) options.set(row.instanceId, row.instanceLabel);
    return [...options.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [health.entities, health.inactiveUsers]);
  const visibleEntities = useMemo(
    () => health.entities.filter((row) => (
      (!instanceFilter || row.instanceId === instanceFilter)
      && rowMatchesEntityFilter(row, entityFilter)
      && rowMatchesSearch(row, search)
    )),
    [entityFilter, health.entities, instanceFilter, search],
  );
  const visibleUsers = useMemo(
    () => health.inactiveUsers.filter((row) => (
      (!instanceFilter || row.instanceId === instanceFilter)
      && userMatchesFilter(row, userFilter)
      && userMatchesSearch(row, search)
    )).slice(0, 80),
    [health.inactiveUsers, instanceFilter, search, userFilter],
  );

  function toggleExpected(row: UserHealthEntityRow) {
    setExpectedInactiveKeys((current) => {
      const next = new Set(current);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      writeExpectedInactiveEntityKeys(next);
      return next;
    });
  }

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-base font-semibold text-content-primary">User Health</h2>
            <p className="mt-1 text-sm text-content-secondary">
              Review inactive users and entity access gaps across saved Omni instances.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => exportEntityCsv(health.entities)} disabled={health.entities.length === 0} className="btn-secondary inline-flex items-center gap-2">
              <Download size={15} />
              Export CSV
            </button>
            <button type="button" onClick={() => void refresh()} disabled={loading} className="btn-primary inline-flex items-center gap-2">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Refresh
            </button>
          </div>
        </div>
        {cachedAt && <div className="mt-3 text-xs text-content-secondary">Last scan: {formatDate(cachedAt)}</div>}
        {error && (
          <div className="mt-4 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertTriangle size={14} className="mr-1 inline-block" />
            {error}
          </div>
        )}
        {!error && connectionStats.length === 0 && embedUserStats.length === 0 && (
          <div className="mt-4 rounded-card border border-dashed border-border-subtle p-4 text-sm text-content-secondary">
            Refresh to load saved instance user-health metrics from the native vault.
          </div>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <AlertTriangle size={14} />
            Action needed
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{health.summary.actionNeededEntities}</div>
        </div>
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <Users size={14} />
            No users
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{health.summary.noUserEntities}</div>
        </div>
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <ShieldCheck size={14} />
            No active users
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{health.summary.noActiveUserEntities}</div>
        </div>
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <CheckCircle2 size={14} />
            Expected inactive
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{health.summary.expectedInactiveEntities}</div>
        </div>
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <Users size={14} />
            Inactive users
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{health.summary.inactiveUsers}</div>
        </div>
        <div className="rounded-card border border-border-subtle bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
            <Users size={14} />
            Unmapped users
          </div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{health.summary.unmappedUsers}</div>
        </div>
      </div>

      <div className="card p-5">
        <h3 className="text-base font-semibold text-content-primary">Last-login aging</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-card bg-surface-secondary p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Last 30 days</div>
            <div className="mt-2 text-xl font-semibold text-content-primary">{health.summary.lastLoginBuckets.last30d}</div>
          </div>
          <div className="rounded-card bg-surface-secondary p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">31-90 days</div>
            <div className="mt-2 text-xl font-semibold text-content-primary">{health.summary.lastLoginBuckets.last31To90d}</div>
          </div>
          <div className="rounded-card bg-surface-secondary p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Over 90 days</div>
            <div className="mt-2 text-xl font-semibold text-content-primary">{health.summary.lastLoginBuckets.olderThan90d}</div>
          </div>
          <div className="rounded-card bg-surface-secondary p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">Never</div>
            <div className="mt-2 text-xl font-semibold text-content-primary">{health.summary.lastLoginBuckets.neverLoggedIn}</div>
          </div>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h3 className="text-base font-semibold text-content-primary">Entity access</h3>
          <div className="w-full md:max-w-sm">
            <SearchInput value={search} onChange={setSearch} placeholder="Search entities, instances, users..." />
          </div>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <select value={instanceFilter} onChange={(event) => setInstanceFilter(event.target.value)} className="input-field text-sm">
            <option value="">All instances</option>
            {instanceOptions.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
          <select value={entityFilter} onChange={(event) => setEntityFilter(event.target.value as EntityFilter)} className="input-field text-sm">
            {ENTITY_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-border-subtle text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
                <th className="px-3 py-2">Instance</th>
                <th className="px-3 py-2">Entity</th>
                <th className="px-3 py-2">Users</th>
                <th className="px-3 py-2">Last login</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Marker</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {visibleEntities.map((row) => {
                const status = findingStatus(row);
                return (
                  <tr key={row.key} className={row.actionNeeded ? 'bg-red-50/30' : ''}>
                    <td className="px-3 py-3 align-top">
                      <div className="font-semibold text-content-primary">{row.instanceLabel}</div>
                      <div className="max-w-[220px] truncate text-xs text-content-secondary">{row.baseUrl}</div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="font-semibold text-content-primary">{row.entityName}</div>
                      <div className="max-w-[280px] truncate text-xs text-content-secondary">
                        {row.connectionNames.length ? row.connectionNames.join(', ') : 'No matching connection'}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top text-content-secondary">
                      <span className="font-semibold text-content-primary">{row.activeUsers}</span> active / {row.totalUsers} total
                      <div className="text-xs">{row.inactiveUsers} inactive · {row.neverLoggedInUsers} never logged in</div>
                    </td>
                    <td className="px-3 py-3 align-top text-content-secondary">{formatDate(row.lastLogin)}</td>
                    <td className="px-3 py-3 align-top"><StatusChip status={status.status} label={status.label} /></td>
                    <td className="px-3 py-3 align-top text-right">
                      <button type="button" onClick={() => toggleExpected(row)} className="btn-secondary text-xs">
                        {row.expectedInactive ? 'Unmark' : 'Expected inactive'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {visibleEntities.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-content-secondary">No entity health rows match this view.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <h3 className="text-base font-semibold text-content-primary">Inactive and never-seen users</h3>
          <div className="flex items-center gap-3">
            <select value={userFilter} onChange={(event) => setUserFilter(event.target.value as UserFilter)} className="input-field text-sm">
              {USER_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <span className="text-xs text-content-secondary">{visibleUsers.length}/{health.inactiveUsers.length}</span>
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-border-subtle text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-[0.14em] text-content-secondary">
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Instance</th>
                <th className="px-3 py-2">Entity</th>
                <th className="px-3 py-2">Last login</th>
                <th className="px-3 py-2">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {visibleUsers.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-3">
                    <div className="font-semibold text-content-primary">{row.displayName || row.userName}</div>
                    <div className="text-xs text-content-secondary">{row.userName}</div>
                  </td>
                  <td className="px-3 py-3 text-content-secondary">{row.instanceLabel}</td>
                  <td className="px-3 py-3 text-content-secondary">{row.entityName}</td>
                  <td className="px-3 py-3 text-content-secondary">{formatDate(row.lastLogin)}</td>
                  <td className="px-3 py-3"><StatusChip status={row.expectedInactive ? 'skipped' : 'warning'} label={userReasonLabel(row)} /></td>
                </tr>
              ))}
              {visibleUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-sm text-content-secondary">No inactive or never-seen users match this view.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
