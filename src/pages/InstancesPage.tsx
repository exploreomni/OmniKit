import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  UnlockKeyhole,
  Users,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { SearchInput } from '@/components/ui/SearchInput';
import {
  changeNativeVaultPassphrase,
  deleteSavedInstance,
  getCachedConnectionMetrics,
  getCachedEmbedUserMetrics,
  getVaultStatus,
  importBrowserVaultInstances,
  listSavedInstances,
  loadConnectionMetrics,
  loadEmbedUserMetrics,
  lockNativeVault,
  resetNativeVault,
  saveSavedInstance,
  testSavedInstance,
  unlockNativeVault,
  type EmbedUserMetricRecord,
  type InstanceConnectionStats,
  type InstanceEmbedUserStats,
  type InstanceMetricFilter,
  type InstanceRole,
  type PostMigrationAction,
  type PostMigrationMethod,
  type SavedInstancePublic,
  type SaveInstanceInput,
  type VaultStatus,
} from '@/services/opsConsole';
import {
  getUnlockedInstanceVault,
  hasInstanceVault,
  isInstanceVaultUnlocked,
  unlockInstanceVault,
} from '@/services/instanceVault';

type Tab = 'instances' | 'connections' | 'users';

interface InstanceForm {
  id?: string;
  label: string;
  role: InstanceRole;
  baseUrl: string;
  apiKey: string;
  defaultModelId: string;
  defaultFolderId: string;
  defaultFolderPath: string;
  entityGroupSeparator: string;
  connectionDatabaseContains: string;
  connectionDatabaseExact: string;
  embedExternalIdContains: string;
  embedExternalIdExact: string;
  postMigrationActionsJson: string;
}

const EMPTY_FORM: InstanceForm = {
  label: '',
  role: 'both',
  baseUrl: '',
  apiKey: '',
  defaultModelId: '',
  defaultFolderId: '',
  defaultFolderPath: '',
  entityGroupSeparator: '',
  connectionDatabaseContains: '',
  connectionDatabaseExact: '',
  embedExternalIdContains: '',
  embedExternalIdExact: '',
  postMigrationActionsJson: '[]',
};

function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(value: string[] | undefined): string {
  return (value || []).join('\n');
}

function formatDate(value?: string | number): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString();
}

function metricFilterFromForm(form: InstanceForm): InstanceMetricFilter {
  return {
    connectionDatabaseContains: splitList(form.connectionDatabaseContains),
    connectionDatabaseExact: splitList(form.connectionDatabaseExact),
    embedExternalIdContains: splitList(form.embedExternalIdContains),
    embedExternalIdExact: splitList(form.embedExternalIdExact),
  };
}

function parseActions(value: string): PostMigrationAction[] {
  const parsed = JSON.parse(value || '[]') as unknown;
  if (!Array.isArray(parsed)) throw new Error('Post-migration actions must be a JSON array.');
  return parsed.map((raw) => {
    const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const method = typeof row.method === 'string' ? row.method.toUpperCase() : 'POST';
    const allowed: PostMigrationMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    return {
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Post-migration action',
      method: allowed.includes(method as PostMigrationMethod) ? method as PostMigrationMethod : 'POST',
      url: typeof row.url === 'string' ? row.url.trim() : '',
      headers: row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)
        ? Object.fromEntries(Object.entries(row.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      body: typeof row.body === 'string' ? row.body : '',
    };
  }).filter((action) => action.url);
}

function formFromInstance(instance: SavedInstancePublic): InstanceForm {
  return {
    id: instance.id,
    label: instance.label,
    role: instance.role,
    baseUrl: instance.baseUrl,
    apiKey: '',
    defaultModelId: instance.defaultModelId || '',
    defaultFolderId: instance.defaultFolderId || '',
    defaultFolderPath: instance.defaultFolderPath || '',
    entityGroupSeparator: instance.entityGroupSeparator || '',
    connectionDatabaseContains: joinList(instance.metricFilter.connectionDatabaseContains),
    connectionDatabaseExact: joinList(instance.metricFilter.connectionDatabaseExact),
    embedExternalIdContains: joinList(instance.metricFilter.embedExternalIdContains),
    embedExternalIdExact: joinList(instance.metricFilter.embedExternalIdExact),
    postMigrationActionsJson: JSON.stringify(instance.postMigrationActions || [], null, 2),
  };
}

function roleBadge(role: InstanceRole) {
  if (role === 'both') return 'Source + destination';
  return role === 'source' ? 'Source' : 'Destination';
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function StatCard({ label, value, note }: { label: string; value: string | number; note: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-content-primary">{value}</div>
      <div className="mt-1 text-xs text-content-secondary">{note}</div>
    </div>
  );
}

function VaultPanel({
  status,
  onStatus,
  onUnlocked,
}: {
  status: VaultStatus | null;
  onStatus: (status: VaultStatus) => void;
  onUnlocked: () => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [currentPassphrase, setCurrentPassphrase] = useState('');
  const [nextPassphrase, setNextPassphrase] = useState('');
  const [browserPassphrase, setBrowserPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function unlock() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await unlockNativeVault(passphrase);
      onStatus(res.status);
      await onUnlocked();
      setPassphrase('');
      setMessage(res.status.exists ? 'Vault unlocked.' : 'Vault created and unlocked.');
    } catch (err) {
      setError(errorText(err, 'Could not unlock vault.'));
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await lockNativeVault();
      onStatus(res.status);
      setMessage('Vault locked.');
    } catch (err) {
      setError(errorText(err, 'Could not lock vault.'));
    } finally {
      setBusy(false);
    }
  }

  async function changePassphrase() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await changeNativeVaultPassphrase(currentPassphrase, nextPassphrase);
      onStatus(res.status);
      setCurrentPassphrase('');
      setNextPassphrase('');
      setMessage('Vault passphrase updated.');
    } catch (err) {
      setError(errorText(err, 'Could not change passphrase.'));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm('Reset the native vault and clear local job history? Saved instance profiles will be removed.')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await resetNativeVault();
      onStatus(res.status);
      setMessage('Vault reset. Create a new vault to continue.');
    } catch (err) {
      setError(errorText(err, 'Could not reset vault.'));
    } finally {
      setBusy(false);
    }
  }

  async function importBrowserVault() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (hasInstanceVault() && !isInstanceVaultUnlocked()) {
        await unlockInstanceVault(browserPassphrase);
      }
      const browserVault = getUnlockedInstanceVault();
      if (!browserVault || browserVault.instances.length === 0) {
        throw new Error('No unlocked browser-vault instances are available to import.');
      }
      const res = await importBrowserVaultInstances(browserVault.instances);
      await onUnlocked();
      setMessage(`Imported ${res.imported.length} browser-vault instance profile${res.imported.length === 1 ? '' : 's'}.`);
      setBrowserPassphrase('');
    } catch (err) {
      setError(errorText(err, 'Could not import browser vault.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-base font-semibold text-content-primary">
            <ShieldCheck size={18} className="text-omni-600" />
            Native encrypted vault
          </div>
          <p className="mt-1 text-sm text-content-secondary">
            Secrets are encrypted in a local file, unlocked only in this server session, and never returned to the browser as plaintext.
          </p>
          <div className="mt-2 text-xs font-mono text-content-secondary">
            {status?.path || './data/vault.enc'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-chip px-2.5 py-1 text-xs font-semibold ${status?.unlocked ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-800'}`}>
            {status?.unlocked ? 'Unlocked' : status?.exists ? 'Locked' : 'Not created'}
          </span>
          {status?.unlocked && (
            <button type="button" onClick={lock} disabled={busy} className="btn-secondary inline-flex items-center gap-2">
              <Lock size={15} />
              Lock
            </button>
          )}
        </div>
      </div>

      {error && <div className="mt-4 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {message && <div className="mt-4 rounded-card border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{message}</div>}

      {!status?.unlocked ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto]">
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void unlock();
            }}
            className="input-field"
            placeholder={status?.exists ? 'Enter vault passphrase' : 'Create vault passphrase'}
          />
          <button type="button" onClick={unlock} disabled={busy || !passphrase.trim()} className="btn-primary inline-flex items-center justify-center gap-2">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <UnlockKeyhole size={16} />}
            {status?.exists ? 'Unlock vault' : 'Create vault'}
          </button>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <div className="rounded-card border border-border-subtle p-4">
            <div className="text-sm font-semibold text-content-primary">Change passphrase</div>
            <div className="mt-3 grid gap-3">
              <input type="password" value={currentPassphrase} onChange={(event) => setCurrentPassphrase(event.target.value)} className="input-field" placeholder="Current passphrase" />
              <input type="password" value={nextPassphrase} onChange={(event) => setNextPassphrase(event.target.value)} className="input-field" placeholder="New passphrase" />
              <button type="button" onClick={changePassphrase} disabled={busy || !currentPassphrase || !nextPassphrase} className="btn-secondary inline-flex items-center justify-center gap-2">
                <KeyRound size={15} />
                Update passphrase
              </button>
            </div>
          </div>
          <div className="rounded-card border border-border-subtle p-4">
            <div className="text-sm font-semibold text-content-primary">Compatibility import</div>
            <p className="mt-1 text-xs text-content-secondary">
              Import unlocked browser-vault profiles into the native vault once, then manage them here.
            </p>
            <div className="mt-3 grid gap-3">
              {hasInstanceVault() && !isInstanceVaultUnlocked() && (
                <input type="password" value={browserPassphrase} onChange={(event) => setBrowserPassphrase(event.target.value)} className="input-field" placeholder="Browser vault password" />
              )}
              <button type="button" onClick={importBrowserVault} disabled={busy || !hasInstanceVault()} className="btn-secondary inline-flex items-center justify-center gap-2">
                <Save size={15} />
                Import browser vault
              </button>
              <button type="button" onClick={reset} disabled={busy} className="btn-danger inline-flex items-center justify-center gap-2">
                <Trash2 size={15} />
                Reset native vault
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InstanceEditor({
  instances,
  onSaved,
}: {
  instances: SavedInstancePublic[];
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<InstanceForm>(EMPTY_FORM);
  const [busyId, setBusyId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function update<K extends keyof InstanceForm>(key: K, value: InstanceForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const input: SaveInstanceInput = {
        id: form.id,
        label: form.label,
        role: form.role,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey || undefined,
        defaultModelId: form.defaultModelId || undefined,
        defaultFolderId: form.defaultFolderId || undefined,
        defaultFolderPath: form.defaultFolderPath || undefined,
        entityGroupSeparator: form.entityGroupSeparator || undefined,
        metricFilter: metricFilterFromForm(form),
        postMigrationActions: parseActions(form.postMigrationActionsJson),
      };
      const res = await saveSavedInstance(input);
      setForm(formFromInstance(res.instance));
      await onSaved();
      setMessage('Instance profile saved.');
    } catch (err) {
      setError(errorText(err, 'Could not save instance.'));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this saved instance profile?')) return;
    setBusyId(id);
    setError('');
    setMessage('');
    try {
      await deleteSavedInstance(id);
      if (form.id === id) setForm(EMPTY_FORM);
      await onSaved();
      setMessage('Instance profile deleted.');
    } catch (err) {
      setError(errorText(err, 'Could not delete instance.'));
    } finally {
      setBusyId('');
    }
  }

  async function test(id: string) {
    setBusyId(id);
    setError('');
    setMessage('');
    try {
      await testSavedInstance(id);
      await onSaved();
      setMessage('Connection test passed.');
    } catch (err) {
      setError(errorText(err, 'Connection test failed.'));
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
      <div className="card p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-content-primary">Saved Omni instances</h2>
            <p className="mt-1 text-sm text-content-secondary">
              Store source and destination profiles once, then reuse them for metrics and dashboard migration.
            </p>
          </div>
          <button type="button" onClick={() => setForm(EMPTY_FORM)} className="btn-secondary inline-flex items-center gap-2">
            <Plus size={15} />
            New
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {instances.length === 0 ? (
            <div className="rounded-card border border-dashed border-border-subtle p-6 text-sm text-content-secondary">
              No saved instances yet. Add your first source or destination profile to begin.
            </div>
          ) : instances.map((instance) => (
            <div key={instance.id} className="rounded-card border border-border-subtle p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-content-primary">{instance.label}</span>
                    <span className="rounded-chip bg-omni-50 px-2 py-0.5 text-xs font-semibold text-omni-700">{roleBadge(instance.role)}</span>
                    {instance.lastValidatedAt && (
                      <span className="rounded-chip bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">Tested</span>
                    )}
                  </div>
                  <div className="mt-1 truncate text-sm text-content-secondary">{instance.baseUrl}</div>
                  <div className="mt-1 text-xs font-mono text-content-tertiary">{instance.apiKeyMasked}</div>
                  <div className="mt-2 grid gap-1 text-xs text-content-secondary sm:grid-cols-2">
                    <div>Model: {instance.defaultModelId || 'Not set'}</div>
                    <div>Folder: {instance.defaultFolderPath || instance.defaultFolderId || 'My Documents/default'}</div>
                    <div>Validated: {formatDate(instance.lastValidatedAt)}</div>
                    <div>Actions: {instance.postMigrationActions.length}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  <button type="button" onClick={() => setForm(formFromInstance(instance))} className="btn-secondary text-xs">Edit</button>
                  <button type="button" onClick={() => test(instance.id)} disabled={busyId === instance.id} className="btn-secondary inline-flex items-center gap-1 text-xs">
                    {busyId === instance.id ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                    Test
                  </button>
                  <button type="button" onClick={() => remove(instance.id)} disabled={busyId === instance.id} className="btn-danger text-xs">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-5">
        <h2 className="text-base font-semibold text-content-primary">{form.id ? 'Edit instance' : 'Add instance'}</h2>
        <p className="mt-1 text-sm text-content-secondary">
          Start with the Omni URL and API key. Defaults, filters, folders, and actions are optional and can be selected later.
        </p>
        {error && <div className="mt-4 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {message && <div className="mt-4 rounded-card border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{message}</div>}

        <div className="mt-4 grid gap-3">
          <input value={form.label} onChange={(event) => update('label', event.target.value)} className="input-field" placeholder="Instance label" />
          <select value={form.role} onChange={(event) => update('role', event.target.value as InstanceRole)} className="input-field">
            <option value="both">Source + destination</option>
            <option value="source">Source only</option>
            <option value="destination">Destination only</option>
          </select>
          <input value={form.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} className="input-field" placeholder="https://your-instance.exploreomni.com" />
          <input type="password" value={form.apiKey} onChange={(event) => update('apiKey', event.target.value)} className="input-field" placeholder={form.id ? 'Leave blank to keep saved API key' : 'API key'} />

          <details className="rounded-card border border-border-subtle bg-surface-subtle p-3">
            <summary className="cursor-pointer text-sm font-semibold text-content-primary">
              Optional defaults, filters, and actions
            </summary>
            <p className="mt-2 text-xs text-content-secondary">
              These settings help repeated migrations and fleet metrics, but they are not required to connect or test the instance.
            </p>
            <div className="mt-3 grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <input value={form.defaultModelId} onChange={(event) => update('defaultModelId', event.target.value)} className="input-field" placeholder="Default model ID, optional" />
                <input value={form.defaultFolderId} onChange={(event) => update('defaultFolderId', event.target.value)} className="input-field" placeholder="Default folder ID, optional" />
              </div>
              <input value={form.defaultFolderPath} onChange={(event) => update('defaultFolderPath', event.target.value)} className="input-field" placeholder="Default folder path, e.g. Shared/Migrations" />
              <input value={form.entityGroupSeparator} onChange={(event) => update('entityGroupSeparator', event.target.value)} className="input-field" placeholder="Embed user group separator, optional" />

              <div className="rounded-card border border-border-subtle bg-white p-3">
                <div className="text-sm font-semibold text-content-primary">Metric filters</div>
                <p className="mt-1 text-xs text-content-secondary">Comma-separated or one value per line. Matching rows stay visible but are excluded from totals.</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <textarea value={form.connectionDatabaseContains} onChange={(event) => update('connectionDatabaseContains', event.target.value)} className="input-field min-h-[76px]" placeholder="Connection database contains" />
                  <textarea value={form.connectionDatabaseExact} onChange={(event) => update('connectionDatabaseExact', event.target.value)} className="input-field min-h-[76px]" placeholder="Connection database exact" />
                  <textarea value={form.embedExternalIdContains} onChange={(event) => update('embedExternalIdContains', event.target.value)} className="input-field min-h-[76px]" placeholder="Embed external ID contains" />
                  <textarea value={form.embedExternalIdExact} onChange={(event) => update('embedExternalIdExact', event.target.value)} className="input-field min-h-[76px]" placeholder="Embed external ID exact" />
                </div>
              </div>

              <div className="rounded-card border border-border-subtle bg-white p-3">
                <div className="text-sm font-semibold text-content-primary">Post-migration actions</div>
                <p className="mt-1 text-xs text-content-secondary">
                  JSON array of HTTPS action templates. Local/private URLs are blocked unless the local server allows them.
                </p>
                <textarea
                  value={form.postMigrationActionsJson}
                  onChange={(event) => update('postMigrationActionsJson', event.target.value)}
                  className="input-field mt-3 min-h-[140px] font-mono text-xs"
                  spellCheck={false}
                />
              </div>
            </div>
          </details>

          <button type="button" onClick={save} disabled={saving} className="btn-primary inline-flex items-center justify-center gap-2">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save instance
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectionsMetricsTab() {
  const [stats, setStats] = useState<InstanceConnectionStats[]>(() => getCachedConnectionMetrics()?.instances ?? []);
  const [cachedAt, setCachedAt] = useState(() => getCachedConnectionMetrics()?.savedAt ?? '');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await loadConnectionMetrics();
      setStats(res.instances);
      setCachedAt(new Date().toISOString());
    } catch (err) {
      setError(errorText(err, 'Could not load connection metrics.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const totals = useMemo(() => ({
    connections: stats.reduce((sum, instance) => sum + instance.totalConnections, 0),
    filtered: stats.reduce((sum, instance) => sum + instance.filteredCount, 0),
    missing: stats.reduce((sum, instance) => sum + instance.missingSchemaModelCount, 0),
    stuck: stats.reduce((sum, instance) => sum + instance.stuckSchemaModelCount, 0),
  }), [stats]);

  const normalizedSearch = search.toLowerCase();

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Connections" value={totals.connections} note={`${totals.filtered} internal/test filtered`} />
        <StatCard label="Missing schema models" value={totals.missing} note="Mapped by connection ID, not default schema" />
        <StatCard label="Stuck schema models" value={totals.stuck} note="Schema model exists but appears unrefreshed" />
        <StatCard label="Instances" value={stats.length} note="Saved profiles scanned" />
      </div>
      <div className="card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <SearchInput value={search} onChange={setSearch} placeholder="Search instances, connections, dialects, or databases" />
          <div className="flex flex-col gap-2 sm:items-end">
            {cachedAt && <span className="text-xs text-content-secondary">Last cached scan: {formatDate(cachedAt)}</span>}
            <button type="button" onClick={load} disabled={loading} className="btn-secondary inline-flex items-center justify-center gap-2">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Refresh
            </button>
          </div>
        </div>
        {error && <div className="mt-4 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="mt-4 space-y-3">
          {stats.map((instance) => {
            const rows = instance.connections.filter((connection) => {
              if (!normalizedSearch) return true;
              return [
                instance.instanceLabel,
                connection.name,
                connection.database,
                connection.dialect,
                connection.readiness,
              ].some((value) => value?.toLowerCase().includes(normalizedSearch));
            });
            if (rows.length === 0 && normalizedSearch) return null;
            return (
              <div key={instance.instanceId} className="rounded-card border border-border-subtle p-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="font-semibold text-content-primary">{instance.instanceLabel}</div>
                    <div className="text-xs text-content-secondary">{instance.baseUrl}</div>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-chip bg-surface-secondary px-2 py-1">{instance.totalConnections} counted</span>
                    <span className="rounded-chip bg-yellow-100 px-2 py-1 text-yellow-800">{instance.missingSchemaModelCount} missing</span>
                    <span className="rounded-chip bg-orange-100 px-2 py-1 text-orange-800">{instance.stuckSchemaModelCount} stuck</span>
                  </div>
                </div>
                {instance.error && <div className="mt-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{instance.error}</div>}
                <div className="mt-3 max-h-[360px] overflow-auto rounded-card border border-border-subtle">
                  {rows.map((connection) => (
                    <div key={connection.id} className="grid gap-2 border-b border-border-subtle px-3 py-2 text-sm last:border-b-0 md:grid-cols-[1.4fr_1fr_0.8fr_1fr] md:items-center">
                      <div>
                        <div className="font-medium text-content-primary">{connection.name || connection.id}</div>
                        <div className="text-xs text-content-secondary">{connection.database || 'No database shown'}</div>
                      </div>
                      <div className="text-content-secondary">{connection.dialect || 'Unknown dialect'}</div>
                      <div className={connection.filtered ? 'text-content-tertiary line-through' : 'text-content-secondary'}>
                        {connection.filtered ? 'Filtered' : 'Counted'}
                      </div>
                      <div className="flex items-center gap-2">
                        {connection.readiness === 'ready' ? <CheckCircle2 size={15} className="text-green-600" /> : <AlertTriangle size={15} className="text-yellow-600" />}
                        <span className="text-xs text-content-secondary">
                          {connection.readiness === 'ready'
                            ? 'Schema model ready'
                            : connection.readiness === 'schema_model_stuck'
                              ? 'Schema model unrefreshed'
                              : 'Missing schema model'}
                        </span>
                      </div>
                    </div>
                  ))}
                  {rows.length === 0 && <div className="p-4 text-sm text-content-secondary">No connection rows found.</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function UsersMetricsTab() {
  const [stats, setStats] = useState<InstanceEmbedUserStats[]>(() => getCachedEmbedUserMetrics()?.instances ?? []);
  const [cachedAt, setCachedAt] = useState(() => getCachedEmbedUserMetrics()?.savedAt ?? '');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await loadEmbedUserMetrics();
      setStats(res.instances);
      setCachedAt(new Date().toISOString());
    } catch (err) {
      setError(errorText(err, 'Could not load embed user metrics.'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const totals = useMemo(() => ({
    users: stats.reduce((sum, instance) => sum + instance.totalUsers, 0),
    active: stats.reduce((sum, instance) => sum + instance.activeUsers, 0),
    inactive: stats.reduce((sum, instance) => sum + instance.inactiveUsers, 0),
    filtered: stats.reduce((sum, instance) => sum + instance.filteredCount, 0),
  }), [stats]);
  const normalizedSearch = search.toLowerCase();

  function rowMatches(instance: InstanceEmbedUserStats, user: EmbedUserMetricRecord) {
    if (!normalizedSearch) return true;
    return [
      instance.instanceLabel,
      user.displayName,
      user.userName,
      user.embedExternalId,
      user.entityName,
    ].some((value) => value?.toLowerCase().includes(normalizedSearch));
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Embed users" value={totals.users} note={`${totals.filtered} internal/test filtered`} />
        <StatCard label="Active" value={totals.active} note="Counted active embed users" />
        <StatCard label="Inactive" value={totals.inactive} note="Counted inactive embed users" />
        <StatCard label="Instances" value={stats.length} note="Saved profiles scanned" />
      </div>
      <div className="card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <SearchInput value={search} onChange={setSearch} placeholder="Search users, external IDs, groups, or instances" />
          <div className="flex flex-col gap-2 sm:items-end">
            {cachedAt && <span className="text-xs text-content-secondary">Last cached scan: {formatDate(cachedAt)}</span>}
            <button type="button" onClick={load} disabled={loading} className="btn-secondary inline-flex items-center justify-center gap-2">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Refresh
            </button>
          </div>
        </div>
        {error && <div className="mt-4 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="mt-4 space-y-3">
          {stats.map((instance) => {
            const rows = instance.users.filter((user) => rowMatches(instance, user));
            if (rows.length === 0 && normalizedSearch) return null;
            return (
              <div key={instance.instanceId} className="rounded-card border border-border-subtle p-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="font-semibold text-content-primary">{instance.instanceLabel}</div>
                    <div className="text-xs text-content-secondary">{instance.baseUrl}</div>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-chip bg-surface-secondary px-2 py-1">{instance.totalUsers} counted</span>
                    <span className="rounded-chip bg-green-100 px-2 py-1 text-green-700">{instance.activeUsers} active</span>
                    <span className="rounded-chip bg-omni-50 px-2 py-1 text-omni-700">{instance.entityCount} entities</span>
                  </div>
                </div>
                {instance.error && <div className="mt-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{instance.error}</div>}
                <div className="mt-3 max-h-[360px] overflow-auto rounded-card border border-border-subtle">
                  {rows.map((user) => (
                    <div key={user.id} className="grid gap-2 border-b border-border-subtle px-3 py-2 text-sm last:border-b-0 md:grid-cols-[1.2fr_1.1fr_0.8fr_0.7fr] md:items-center">
                      <div>
                        <div className="font-medium text-content-primary">{user.displayName || user.userName || user.id}</div>
                        <div className="text-xs text-content-secondary">{user.userName}</div>
                      </div>
                      <div className={user.filtered ? 'text-content-tertiary line-through' : 'text-content-secondary'}>
                        {user.embedExternalId || 'No external ID'}
                      </div>
                      <div className="text-content-secondary">{user.entityName || 'No group rollup'}</div>
                      <div className="flex items-center gap-2">
                        {user.active ? <CheckCircle2 size={15} className="text-green-600" /> : <AlertTriangle size={15} className="text-yellow-600" />}
                        <span className="text-xs text-content-secondary">{user.filtered ? 'Filtered' : user.active ? 'Active' : 'Inactive'}</span>
                      </div>
                    </div>
                  ))}
                  {rows.length === 0 && <div className="p-4 text-sm text-content-secondary">No embed user rows found.</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function InstancesPage() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [instances, setInstances] = useState<SavedInstancePublic[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('instances');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refreshStatus = useCallback(async () => {
    const next = await getVaultStatus();
    setStatus(next);
    return next;
  }, []);

  const refreshInstances = useCallback(async () => {
    const next = await refreshStatus();
    if (next.unlocked) {
      const res = await listSavedInstances();
      setInstances(res.instances);
    } else {
      setInstances([]);
    }
  }, [refreshStatus]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError('');
      try {
        await refreshInstances();
      } catch (err) {
        setError(errorText(err, 'Could not load native vault status.'));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [refreshInstances]);

  const sourceCount = instances.filter((instance) => instance.role === 'source' || instance.role === 'both').length;
  const destinationCount = instances.filter((instance) => instance.role === 'destination' || instance.role === 'both').length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Instance Manager"
        description="Manage encrypted local Omni instance profiles, cross-instance migration targets, connection metrics, and embed-user counts."
        icon={<Blobby mood="connections" size={58} className="animate-float" style={{ animationDuration: '3.5s' }} />}
      />

      {error && <div className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <VaultPanel status={status} onStatus={setStatus} onUnlocked={refreshInstances} />

      {loading ? (
        <div className="card flex items-center justify-center gap-2 p-8 text-content-secondary">
          <Loader2 size={18} className="animate-spin" />
          Loading instance manager...
        </div>
      ) : status?.unlocked ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Saved instances" value={instances.length} note="Stored in native encrypted vault" />
            <StatCard label="Sources" value={sourceCount} note="Available for metrics and dashboard export" />
            <StatCard label="Destinations" value={destinationCount} note="Available for dashboard import/fan-out" />
          </div>

          <div className="card p-2">
            <div className="grid gap-2 sm:grid-cols-3">
              {([
                ['instances', Server, 'Instance profiles'],
                ['connections', Database, 'Connections'],
                ['users', Users, 'Embed users'],
              ] as const).map(([tab, Icon, label]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center justify-center gap-2 rounded-button px-3 py-2 text-sm font-semibold transition ${
                    activeTab === tab ? 'bg-omni-600 text-white shadow-sm' : 'text-content-secondary hover:bg-surface-secondary'
                  }`}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {activeTab === 'instances' && <InstanceEditor instances={instances} onSaved={refreshInstances} />}
          {activeTab === 'connections' && <ConnectionsMetricsTab />}
          {activeTab === 'users' && <UsersMetricsTab />}
        </>
      ) : (
        <div className="card p-6 text-sm text-content-secondary">
          Unlock or create the native vault above to manage saved instances and scan multi-instance metrics.
        </div>
      )}
    </div>
  );
}
