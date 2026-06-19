import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  PlayCircle,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  UnlockKeyhole,
  Users,
  X,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { SearchInput } from '@/components/ui/SearchInput';
import { useMigrationTargetCatalog } from '@/components/dashboardMigration/useMigrationTargetCatalog';
import {
  changeNativeVaultPassphrase,
  deleteSavedInstance,
  getCachedConnectionMetrics,
  getCachedEmbedUserMetrics,
  getVaultStatus,
  importLegacyVault,
  listSavedInstances,
  loadConnectionMetrics,
  loadEmbedUserMetrics,
  lockNativeVault,
  refreshInstanceSchemaModel,
  resetNativeVault,
  runPostMigrationActions,
  saveSavedInstance,
  testSavedInstance,
  unlockNativeVault,
  type EmbedUserMetricRecord,
  type InstanceFolder,
  type InstanceModel,
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

type Tab = 'instances' | 'connections' | 'users';

const LEGACY_BROWSER_VAULT_KEY = 'omnikit:instanceVault:v1';

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
      kind: 'webhook' as const,
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

function modelDisplay(model: InstanceModel) {
  return model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;
}

function folderDisplay(folder: InstanceFolder) {
  const label = folder.path || folder.name || folder.identifier || folder.id;
  return label !== folder.id ? `${label} (${folder.id})` : folder.id;
}

function hasLegacyBrowserVault(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage.getItem(LEGACY_BROWSER_VAULT_KEY));
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

function TagListEditor({
  label,
  helper,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  helper: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const tags = splitList(value);

  function write(next: string[]) {
    onChange(joinList([...new Set(next.map((item) => item.trim()).filter(Boolean))]));
  }

  function add() {
    const next = draft.trim();
    if (!next) return;
    write([...tags, next]);
    setDraft('');
  }

  return (
    <div className="rounded-card border border-border-subtle bg-white p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-content-secondary">{label}</div>
      <p className="mt-1 text-xs text-content-secondary">{helper}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => write(tags.filter((item) => item !== tag))}
            className="inline-flex items-center gap-1 rounded-chip bg-omni-50 px-2 py-1 text-xs font-semibold text-omni-700"
            title="Remove filter"
          >
            {tag}
            <X size={12} />
          </button>
        ))}
        {tags.length === 0 && <span className="text-xs text-content-tertiary">No filters configured</span>}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          className="input-field"
          placeholder={placeholder}
        />
        <button type="button" onClick={add} disabled={!draft.trim()} className="btn-secondary inline-flex items-center justify-center gap-1">
          <Plus size={14} />
          Add
        </button>
      </div>
    </div>
  );
}

function parseActionsForEditor(value: string): PostMigrationAction[] {
  try {
    const parsed = JSON.parse(value || '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((raw): raw is Record<string, unknown> => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw))
      .map((row) => {
        const method = typeof row.method === 'string' ? row.method.toUpperCase() : 'POST';
        const allowed: PostMigrationMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        return {
          kind: 'webhook',
          name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Post-migration action',
          method: allowed.includes(method as PostMigrationMethod) ? method as PostMigrationMethod : 'POST',
          url: typeof row.url === 'string' ? row.url : '',
          headers: row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)
            ? Object.fromEntries(Object.entries(row.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
            : {},
          body: typeof row.body === 'string' ? row.body : '',
        };
      });
  } catch {
    return [];
  }
}

function ActionEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const actions = useMemo(() => parseActionsForEditor(value), [value]);
  const [testIndex, setTestIndex] = useState<number | null>(null);
  const [testMessages, setTestMessages] = useState<Record<number, { ok: boolean; text: string }>>({});

  function write(next: PostMigrationAction[]) {
    onChange(JSON.stringify(next, null, 2));
  }

  function update(index: number, patch: Partial<PostMigrationAction>) {
    write(actions.map((action, rowIndex) => rowIndex === index ? { ...action, ...patch } : action));
  }

  function updateHeader(index: number, oldKey: string, nextKey: string, nextValue: string) {
    const action = actions[index];
    const headers = { ...action.headers };
    delete headers[oldKey];
    if (nextKey.trim()) headers[nextKey.trim()] = nextValue;
    update(index, { headers });
  }

  async function test(action: PostMigrationAction, index: number) {
    if (!action.url.trim()) {
      setTestMessages((prev) => ({ ...prev, [index]: { ok: false, text: 'Add an HTTPS URL before testing.' } }));
      return;
    }
    setTestIndex(index);
    setTestMessages((prev) => ({ ...prev, [index]: { ok: true, text: 'Testing action...' } }));
    try {
      const res = await runPostMigrationActions([action]);
      const result = res.results[0];
      setTestMessages((prev) => ({
        ...prev,
        [index]: {
          ok: Boolean(result?.ok),
          text: result?.ok ? result.warning || 'Action succeeded.' : result?.error || 'Action failed.',
        },
      }));
    } catch (err) {
      setTestMessages((prev) => ({ ...prev, [index]: { ok: false, text: errorText(err, 'Action test failed.') } }));
    } finally {
      setTestIndex(null);
    }
  }

  return (
    <div className="rounded-card border border-border-subtle bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-content-primary">Post-migration webhook actions</div>
          <p className="mt-1 text-xs text-content-secondary">
            Optional HTTPS callbacks to run after a migration job. The server validates URL safety and redacts stored results.
          </p>
        </div>
        <button
          type="button"
          onClick={() => write([...actions, { kind: 'webhook', name: 'Post-migration action', method: 'POST', url: '', headers: {}, body: '' }])}
          className="btn-secondary inline-flex items-center gap-1 text-xs"
        >
          <Plus size={13} />
          Add
        </button>
      </div>

      <div className="mt-3 space-y-3">
        {actions.length === 0 && (
          <div className="rounded-card border border-dashed border-border-subtle p-4 text-xs text-content-secondary">
            No webhook actions configured for this instance.
          </div>
        )}
        {actions.map((action, index) => {
          const headers = Object.entries(action.headers || {});
          const testMessage = testMessages[index];
          return (
            <div key={`${index}:${action.name}`} className="rounded-card border border-border-subtle bg-surface-subtle p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_120px_auto]">
                <input value={action.name} onChange={(event) => update(index, { name: event.target.value })} className="input-field" placeholder="Action name" />
                <select value={action.method} onChange={(event) => update(index, { method: event.target.value as PostMigrationMethod })} className="input-field">
                  {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => <option key={method} value={method}>{method}</option>)}
                </select>
                <button type="button" onClick={() => write(actions.filter((_, rowIndex) => rowIndex !== index))} className="btn-secondary inline-flex items-center justify-center text-red-700" title="Remove action">
                  <Trash2 size={15} />
                </button>
              </div>
              <input value={action.url} onChange={(event) => update(index, { url: event.target.value })} className="input-field mt-2" placeholder="https://hooks.example.com/refresh-cache" />
              <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-content-secondary">Headers</div>
              <div className="mt-2 space-y-2">
                {headers.map(([key, headerValue], headerIndex) => (
                  <div key={`${key}:${headerIndex}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <input value={key} onChange={(event) => updateHeader(index, key, event.target.value, headerValue)} className="input-field" placeholder="Header name" />
                    <input value={headerValue} onChange={(event) => updateHeader(index, key, key, event.target.value)} className="input-field" placeholder="Header value" />
                    <button type="button" onClick={() => updateHeader(index, key, '', '')} className="btn-secondary inline-flex items-center justify-center" title="Remove header">
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button type="button" onClick={() => update(index, { headers: { ...action.headers, 'X-OmniKit-Job': '' } })} className="btn-secondary inline-flex items-center gap-1 text-xs">
                  <Plus size={13} />
                  Add header
                </button>
              </div>
              <textarea value={action.body} onChange={(event) => update(index, { body: event.target.value })} className="input-field mt-3 min-h-[92px] font-mono text-xs" placeholder='{"job": "completed"}' />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void test(action, index)} disabled={testIndex === index} className="btn-secondary inline-flex items-center gap-1 text-xs">
                  {testIndex === index ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
                  Test action
                </button>
                {testMessage && (
                  <span className={`rounded-chip px-2 py-1 text-xs font-semibold ${testMessage.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {testMessage.text}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniBarChart({
  label,
  rows,
  getLabel,
}: {
  label: string;
  rows: Array<{ count: number }>;
  getLabel: (index: number) => string;
}) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <div className="rounded-card border border-border-subtle bg-white p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-secondary">{label}</div>
      <div className="flex h-24 items-end gap-1">
        {rows.map((row, index) => (
          <div key={`${label}:${getLabel(index)}`} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <div
              className="w-full rounded-t-button bg-omni-500"
              style={{ height: `${Math.max(4, Math.round((row.count / max) * 76))}px` }}
              title={`${getLabel(index)}: ${row.count}`}
            />
            <span className="max-w-full truncate text-[9px] text-content-tertiary">{getLabel(index).slice(-5)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function entityRows(instance: InstanceEmbedUserStats) {
  const rows = new Map<string, { entity: string; total: number; active: number; inactive: number }>();
  for (const user of instance.users) {
    if (user.filtered || !user.entityName) continue;
    const current = rows.get(user.entityName) || { entity: user.entityName, total: 0, active: 0, inactive: 0 };
    current.total += 1;
    if (user.active) current.active += 1;
    else current.inactive += 1;
    rows.set(user.entityName, current);
  }
  return [...rows.values()].sort((a, b) => b.active - a.active || b.total - a.total || a.entity.localeCompare(b.entity)).slice(0, 12);
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
  const [legacyPath, setLegacyPath] = useState('./data/vault.enc');
  const [legacyPassphrase, setLegacyPassphrase] = useState('');
  const [legacyConfirmAbsolutePath, setLegacyConfirmAbsolutePath] = useState(false);
  const [legacyImportResult, setLegacyImportResult] = useState<Awaited<ReturnType<typeof importLegacyVault>> | null>(null);
  const [legacyBrowserVaultFound, setLegacyBrowserVaultFound] = useState(() => hasLegacyBrowserVault());
  const [busy, setBusy] = useState(false);
  const [legacyBusy, setLegacyBusy] = useState(false);
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

  function dismissLegacyBrowserVault() {
    if (!window.confirm('Delete the old encrypted browser-vault cache from localStorage? Re-add any needed instances to the native vault first.')) return;
    window.localStorage.removeItem(LEGACY_BROWSER_VAULT_KEY);
    setLegacyBrowserVaultFound(false);
    setMessage('Legacy browser-vault cache removed from localStorage.');
  }

  async function runLegacyImport(dryRun: boolean) {
    setLegacyBusy(true);
    setError('');
    setMessage('');
    setLegacyImportResult(null);
    try {
      const result = await importLegacyVault({
        path: legacyPath,
        passphrase: legacyPassphrase,
        dryRun,
        confirmAbsolutePath: legacyConfirmAbsolutePath,
      });
      setLegacyImportResult(result);
      if (!dryRun) {
        setLegacyPassphrase('');
        await onUnlocked();
      }
      setMessage(dryRun ? 'Legacy vault dry run complete.' : `Legacy vault import complete. Imported ${result.imported} instance${result.imported === 1 ? '' : 's'}.`);
    } catch (err) {
      setError(errorText(err, dryRun ? 'Legacy vault dry run failed.' : 'Legacy vault import failed.'));
    } finally {
      setLegacyBusy(false);
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
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
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
          <p className="text-xs leading-5 text-content-secondary">
            Unlock the vault to manage saved instances, test profiles, and run the one-time legacy multi-instance vault import.
          </p>
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
            <div className="text-sm font-semibold text-content-primary">Legacy browser-vault cleanup</div>
            {legacyBrowserVaultFound ? (
              <p className="mt-1 text-xs text-content-secondary">
                An old encrypted browser-vault cache was found in localStorage. Re-add any needed profiles to the native vault below, then dismiss this cache so credentials no longer live in browser storage.
              </p>
            ) : (
              <p className="mt-1 text-xs text-content-secondary">
                No legacy browser-vault cache was found. New saved instances use the native encrypted vault only.
              </p>
            )}
            <div className="mt-3 grid gap-3">
              {legacyBrowserVaultFound && (
                <button type="button" onClick={dismissLegacyBrowserVault} disabled={busy} className="btn-secondary inline-flex items-center justify-center gap-2">
                  <Trash2 size={15} />
                  Dismiss legacy browser cache
                </button>
              )}
              <button type="button" onClick={reset} disabled={busy} className="btn-danger inline-flex items-center justify-center gap-2">
                <Trash2 size={15} />
                Reset native vault
              </button>
            </div>
          </div>
          <div className="rounded-card border border-border-subtle p-4 xl:col-span-2">
            <div className="text-sm font-semibold text-content-primary">Import legacy multi-instance vault</div>
            <p className="mt-1 text-xs text-content-secondary">
              Use this once when moving from the old multi-instance tool. OmniKit reads one local <span className="font-mono">.enc</span> file, imports valid saved instances, skips duplicate base URLs, and drops unsupported legacy-only fields.
            </p>
            <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_260px]">
              <input
                value={legacyPath}
                onChange={(event) => setLegacyPath(event.target.value)}
                className="input-field"
                placeholder="/path/to/omni-multi-instance-tools/data/vault.enc"
              />
              <input
                type="password"
                value={legacyPassphrase}
                onChange={(event) => setLegacyPassphrase(event.target.value)}
                className="input-field"
                placeholder="Legacy vault passphrase"
              />
            </div>
            <label className="mt-3 flex items-start gap-2 text-xs text-content-secondary">
              <input
                type="checkbox"
                checked={legacyConfirmAbsolutePath}
                onChange={(event) => setLegacyConfirmAbsolutePath(event.target.checked)}
                className="mt-0.5 accent-omni-600"
              />
              <span>
                Confirm this local absolute path should be read by OmniKit. Relative paths are limited to the OmniKit workspace.
              </span>
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runLegacyImport(true)}
                disabled={legacyBusy || !legacyPath.trim() || !legacyPassphrase}
                className="btn-secondary inline-flex items-center justify-center gap-2"
              >
                {legacyBusy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                Dry run import
              </button>
              <button
                type="button"
                onClick={() => void runLegacyImport(false)}
                disabled={legacyBusy || !legacyPath.trim() || !legacyPassphrase}
                className="btn-primary inline-flex items-center justify-center gap-2"
              >
                {legacyBusy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                Import legacy vault
              </button>
            </div>
            {legacyImportResult && (
              <div className="mt-3 rounded-card border border-border-subtle bg-surface-subtle p-3 text-xs">
                <div className="font-semibold text-content-primary">
                  {legacyImportResult.dryRun ? 'Dry run summary' : 'Import summary'}: {legacyImportResult.dryRun ? legacyImportResult.wouldImport : legacyImportResult.imported} ready, {legacyImportResult.skipped.length} skipped, {legacyImportResult.warnings.length} warning{legacyImportResult.warnings.length === 1 ? '' : 's'}.
                </div>
                {legacyImportResult.skipped.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {legacyImportResult.skipped.slice(0, 6).map((row) => (
                      <div key={`${row.label}:${row.reason}`} className="text-yellow-800">
                        <span className="font-semibold">{row.label}</span>: {row.reason}
                      </div>
                    ))}
                  </div>
                )}
                {legacyImportResult.warnings.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {legacyImportResult.warnings.slice(0, 6).map((warning) => (
                      <div key={warning} className="text-content-secondary">{warning}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [form, setForm] = useState<InstanceForm>(EMPTY_FORM);
  const [busyId, setBusyId] = useState('');
  const [bulkTestingIds, setBulkTestingIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const { catalogs, loadCatalog } = useMigrationTargetCatalog();
  const formCatalog = form.id ? catalogs[form.id] : undefined;
  const formModels = useMemo(() => formCatalog?.models || [], [formCatalog?.models]);
  const formFolders = useMemo(() => formCatalog?.folders || [], [formCatalog?.folders]);
  const selectedDefaultFolderOptionId = useMemo(() => (
    formFolders.find((row) => row.id === form.defaultFolderId || row.path === form.defaultFolderPath)?.id || ''
  ), [form.defaultFolderId, form.defaultFolderPath, formFolders]);

  const describeDefaultModel = useCallback((instance: SavedInstancePublic) => {
    if (!instance.defaultModelId) return '';
    const catalog = catalogs[instance.id];
    const model = catalog?.models.find((row) => row.id === instance.defaultModelId);
    return model ? modelDisplay(model) : instance.defaultModelId;
  }, [catalogs]);

  const describeDefaultFolder = useCallback((instance: SavedInstancePublic) => {
    const folderValue = instance.defaultFolderPath || instance.defaultFolderId || '';
    if (!folderValue) return '';
    const catalog = catalogs[instance.id];
    const folder = catalog?.folders.find((row) => row.id === instance.defaultFolderId || row.path === instance.defaultFolderPath);
    return folder ? folderDisplay(folder) : folderValue;
  }, [catalogs]);

  useEffect(() => {
    const baseUrl = searchParams.get('baseUrl');
    const label = searchParams.get('label');
    if (!baseUrl && !label) return;
    setForm((prev) => ({
      ...EMPTY_FORM,
      ...prev,
      id: undefined,
      label: label || prev.label,
      baseUrl: baseUrl || prev.baseUrl,
      apiKey: '',
    }));
    const next = new URLSearchParams(searchParams);
    next.delete('baseUrl');
    next.delete('label');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    instances
      .filter((instance) => instance.defaultModelId || instance.defaultFolderId || instance.defaultFolderPath)
      .forEach((instance) => {
        void loadCatalog(instance.id);
      });
  }, [instances, loadCatalog]);

  useEffect(() => {
    if (!form.id) return;
    void loadCatalog(form.id);
  }, [form.id, loadCatalog]);

  function update<K extends keyof InstanceForm>(key: K, value: InstanceForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function selectDefaultFolder(value: string) {
    const folder = formFolders.find((row) => row.id === value || row.path === value);
    if (!folder) {
      setForm((prev) => ({ ...prev, defaultFolderId: value, defaultFolderPath: '' }));
      return;
    }
    setForm((prev) => ({
      ...prev,
      defaultFolderId: folder.id,
      defaultFolderPath: folder.path || prev.defaultFolderPath,
    }));
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

  async function testAll() {
    if (instances.length === 0) return;
    setError('');
    setMessage('');
    setBulkTestingIds(new Set(instances.map((instance) => instance.id)));
    let passed = 0;
    let failed = 0;

    await Promise.all(instances.map(async (instance) => {
      try {
        await testSavedInstance(instance.id);
        passed += 1;
      } catch {
        failed += 1;
      } finally {
        setBulkTestingIds((current) => {
          const next = new Set(current);
          next.delete(instance.id);
          return next;
        });
      }
    }));

    await onSaved();
    if (failed > 0) {
      setError(`Tested ${instances.length} instance${instances.length === 1 ? '' : 's'}: ${passed} passed, ${failed} failed.`);
    } else {
      setMessage(`All ${passed} saved instance${passed === 1 ? '' : 's'} tested successfully.`);
    }
  }

  const testingAll = bulkTestingIds.size > 0;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
      <div className="card p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-content-primary">Saved Omni instances</h2>
            <p className="mt-1 text-sm text-content-secondary">
              Store each instance once with its URL and API key, then choose exact models and folders during each migration.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void testAll()} disabled={instances.length === 0 || testingAll} className="btn-secondary inline-flex items-center gap-2">
              {testingAll ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Test all
            </button>
            <button type="button" onClick={() => setForm(EMPTY_FORM)} className="btn-secondary inline-flex items-center gap-2">
              <Plus size={15} />
              New
            </button>
          </div>
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
                    {bulkTestingIds.has(instance.id) && (
                      <span className="rounded-chip bg-yellow-100 px-2 py-0.5 text-xs font-semibold text-yellow-800">Testing</span>
                    )}
                    {instance.lastValidatedAt && (
                      <span className="rounded-chip bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">Tested</span>
                    )}
                  </div>
                  <div className="mt-1 truncate text-sm text-content-secondary">{instance.baseUrl}</div>
                  <div className="mt-1 text-xs font-mono text-content-tertiary">{instance.apiKeyMasked}</div>
                  <div className="mt-2 grid gap-1 text-xs text-content-secondary sm:grid-cols-2">
                    <div>Credential: Saved in native vault</div>
                    <div>
                      Migration defaults:{' '}
                      {instance.defaultModelId || instance.defaultFolderPath || instance.defaultFolderId
                        ? 'Configured'
                        : 'Choose per migration'}
                    </div>
                    {instance.defaultModelId && <div>Default model: {describeDefaultModel(instance)}</div>}
                    {(instance.defaultFolderPath || instance.defaultFolderId) && (
                      <div>Default folder: {describeDefaultFolder(instance)}</div>
                    )}
                    <div>Last tested: {formatDate(instance.lastValidatedAt)}</div>
                    <div>Post-actions: {instance.postMigrationActions.length}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  <button type="button" onClick={() => setForm(formFromInstance(instance))} className="btn-secondary text-xs">Edit</button>
                  <button type="button" onClick={() => test(instance.id)} disabled={busyId === instance.id || bulkTestingIds.has(instance.id)} className="btn-secondary inline-flex items-center gap-1 text-xs">
                    {busyId === instance.id || bulkTestingIds.has(instance.id) ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
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
          Label, role, URL, and API key are enough to save and test an instance. Models, folders, filters, and actions are optional helpers for repeat jobs.
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
                <div className="grid gap-2">
                  <label className="text-xs font-semibold text-content-secondary">Default model</label>
                  <select
                    value={formModels.some((model) => model.id === form.defaultModelId) ? form.defaultModelId : ''}
                    onChange={(event) => update('defaultModelId', event.target.value)}
                    disabled={!form.id || formCatalog?.loading}
                    className="input-field"
                  >
                    <option value="">{form.id ? 'Choose a model' : 'Save this instance before loading models'}</option>
                    {formModels.map((model) => (
                      <option key={model.id} value={model.id}>{modelDisplay(model)}</option>
                    ))}
                  </select>
                  {formCatalog?.loading && <div className="flex items-center gap-1 text-xs text-content-secondary"><Loader2 size={12} className="animate-spin" /> Loading models and folders</div>}
                  {formCatalog?.error && <div className="text-xs text-yellow-700">{formCatalog.error}</div>}
                  <input value={form.defaultModelId} onChange={(event) => update('defaultModelId', event.target.value)} className="input-field" placeholder="Paste model ID manually" />
                </div>
                <div className="grid gap-2">
                  <label className="text-xs font-semibold text-content-secondary">Default folder</label>
                  <select
                    value={selectedDefaultFolderOptionId}
                    onChange={(event) => selectDefaultFolder(event.target.value)}
                    disabled={!form.id || formCatalog?.loading}
                    className="input-field"
                  >
                    <option value="">{form.id ? 'Choose a folder' : 'Save this instance before loading folders'}</option>
                    {formFolders.map((folder) => (
                      <option key={folder.id} value={folder.id}>{folderDisplay(folder)}</option>
                    ))}
                  </select>
                  <input value={form.defaultFolderId} onChange={(event) => update('defaultFolderId', event.target.value)} className="input-field" placeholder="Paste folder ID manually" />
                </div>
              </div>
              <input value={form.defaultFolderPath} onChange={(event) => update('defaultFolderPath', event.target.value)} className="input-field" placeholder="Default folder path, e.g. Shared/Migrations" />
              <input value={form.entityGroupSeparator} onChange={(event) => update('entityGroupSeparator', event.target.value)} className="input-field" placeholder="Embed user group separator, optional" />

              <div className="rounded-card border border-border-subtle bg-white p-3">
                <div className="text-sm font-semibold text-content-primary">Metric filters</div>
                <p className="mt-1 text-xs text-content-secondary">Matching rows stay visible for review but are excluded from fleet totals.</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <TagListEditor
                    label="Connection database contains"
                    helper="Exclude internal or test connections by partial database/name match."
                    value={form.connectionDatabaseContains}
                    onChange={(next) => update('connectionDatabaseContains', next)}
                    placeholder="internal, staging, test"
                  />
                  <TagListEditor
                    label="Connection database exact"
                    helper="Exclude connections by exact database/name match."
                    value={form.connectionDatabaseExact}
                    onChange={(next) => update('connectionDatabaseExact', next)}
                    placeholder="internal_analytics"
                  />
                  <TagListEditor
                    label="Embed external ID contains"
                    helper="Exclude internal/test embed users by partial external ID match."
                    value={form.embedExternalIdContains}
                    onChange={(next) => update('embedExternalIdContains', next)}
                    placeholder="@omni.co, internal"
                  />
                  <TagListEditor
                    label="Embed external ID exact"
                    helper="Exclude embed users by exact external ID match."
                    value={form.embedExternalIdExact}
                    onChange={(next) => update('embedExternalIdExact', next)}
                    placeholder="test-user-123"
                  />
                </div>
              </div>

              <ActionEditor
                value={form.postMigrationActionsJson}
                onChange={(next) => update('postMigrationActionsJson', next)}
              />
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
  const [refreshingSchemaKey, setRefreshingSchemaKey] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    setMessage('');
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

  async function refreshSchema(instanceId: string, modelId: string) {
    const key = `${instanceId}:${modelId}`;
    setRefreshingSchemaKey(key);
    setError('');
    setMessage('');
    try {
      const res = await refreshInstanceSchemaModel(instanceId, modelId);
      await load();
      setMessage(res.jobId ? `Schema refresh queued for model ${modelId}. Omni job: ${res.jobId}` : `Schema refresh queued for model ${modelId}.`);
    } catch (err) {
      setError(errorText(err, 'Could not queue schema model refresh.'));
    } finally {
      setRefreshingSchemaKey('');
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
        {message && <div className="mt-4 rounded-card border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{message}</div>}
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
                <div className="mt-3 max-h-[420px] overflow-auto rounded-card border border-border-subtle">
                  {rows.map((connection) => (
                    <div key={connection.id} className="grid gap-2 border-b border-border-subtle px-3 py-2 text-sm last:border-b-0 md:grid-cols-[1.4fr_0.9fr_0.7fr_1.35fr_auto] md:items-center">
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
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-content-primary">
                            {connection.readiness === 'ready'
                              ? 'Schema model ready'
                              : connection.readiness === 'schema_model_stuck'
                                ? 'Appears unbuilt'
                                : 'Missing schema model'}
                          </div>
                          <div className="truncate text-[10px] text-content-secondary">
                            {connection.schemaModelId ? `Model ${connection.schemaModelId}` : 'No schema model ID'}
                          </div>
                        </div>
                      </div>
                      <div className="flex justify-start md:justify-end">
                        {connection.schemaModelId ? (
                          <button
                            type="button"
                            onClick={() => void refreshSchema(instance.instanceId, connection.schemaModelId || '')}
                            disabled={refreshingSchemaKey === `${instance.instanceId}:${connection.schemaModelId}`}
                            className="btn-secondary inline-flex items-center gap-1 text-xs"
                          >
                            {refreshingSchemaKey === `${instance.instanceId}:${connection.schemaModelId}` ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                            Refresh
                          </button>
                        ) : (
                          <span className="text-xs text-content-tertiary">No refresh target</span>
                        )}
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
    active7d: stats.reduce((sum, instance) => sum + (instance.activity?.active7d || 0), 0),
    active30d: stats.reduce((sum, instance) => sum + (instance.activity?.active30d || 0), 0),
    active90d: stats.reduce((sum, instance) => sum + (instance.activity?.active90d || 0), 0),
    neverLoggedIn: stats.reduce((sum, instance) => sum + (instance.activity?.neverLoggedIn || 0), 0),
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
        <StatCard label="Active 30d" value={totals.active30d} note={`${totals.active7d} active in 7d · ${totals.active90d} active in 90d`} />
        <StatCard label="Never logged in" value={totals.neverLoggedIn} note={`${totals.inactive} inactive users counted`} />
        <StatCard label="Instances" value={stats.length} note={`${totals.active} active profiles scanned`} />
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
            const entities = entityRows(instance);
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
                    <span className="rounded-chip bg-omni-50 px-2 py-1 text-omni-700">{instance.activity?.active30d || 0} active 30d</span>
                    <span className="rounded-chip bg-yellow-100 px-2 py-1 text-yellow-800">{instance.activity?.neverLoggedIn || 0} never logged in</span>
                    <span className="rounded-chip bg-omni-50 px-2 py-1 text-omni-700">{instance.entityCount} entities</span>
                  </div>
                </div>
                {instance.error && <div className="mt-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{instance.error}</div>}
                {instance.activity && (
                  <div className="mt-3 grid gap-3 xl:grid-cols-2">
                    <MiniBarChart
                      label="Weekly logins"
                      rows={instance.activity.weeklyLogins}
                      getLabel={(index) => instance.activity.weeklyLogins[index]?.weekStart || ''}
                    />
                    <MiniBarChart
                      label="Monthly signups"
                      rows={instance.activity.monthlySignups}
                      getLabel={(index) => instance.activity.monthlySignups[index]?.month || ''}
                    />
                  </div>
                )}
                {entities.length > 0 && (
                  <div className="mt-3 rounded-card border border-border-subtle bg-white p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-secondary">Entity rollups</div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {entities.map((entity) => (
                        <div key={entity.entity} className="flex items-center justify-between gap-3 rounded-card bg-surface-secondary px-3 py-2 text-xs">
                          <span className="truncate font-semibold text-content-primary">{entity.entity}</span>
                          <span className="shrink-0 text-content-secondary">{entity.active} active · {entity.total} total</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
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
            <StatCard label="Destinations" value={destinationCount} note="Available for dashboard import" />
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
