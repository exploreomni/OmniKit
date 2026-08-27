import { useEffect, useRef, useState } from 'react';
import { Download, Upload, Trash2, HardDrive, RefreshCw, GraduationCap, RotateCcw, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusChip } from '@/components/ui/StatusChip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/services/toast';
import { Blobby } from '@/components/ui/Blobby';
import { useWalkthrough } from '@/hooks/useWalkthrough';
import { WALKTHROUGH_STORAGE_KEY } from '@/services/walkthrough';
import { OMNIKIT_BUILD_INFO } from '@/services/buildInfo';
import {
  clearMigrationJobs,
  getVaultStatus,
  purgeRetiredBiMigrationCredentials,
  resetNativeVault,
  type VaultStatus,
} from '@/services/opsConsole';
import {
  clearOmniKitLocalStorage,
  clearOmniKitSessionStorage,
  clearStore,
  exportAll,
  exportOmniKitLocalStorage,
  importAll,
  importOmniKitLocalStorage,
  localStorageSummary,
  sessionStorageSummary,
  storageSummary,
  type StoreName,
} from '@/services/localStore';

const STORE_LABELS: Record<StoreName, string> = {
  operations_log: 'Operation history',
  content_validation_runs: 'Content health scans',
  permission_snapshots: 'Permission snapshots',
  permission_audit: 'Permission audit log',
  branch_activity: 'Branch activity',
  schedule_run_history: 'Schedule run history',
  ai_conversations: 'AI conversations',
  ai_messages: 'AI messages',
  embed_templates: 'Embed templates',
  dashboard_filter_presets: 'Dashboard filter presets',
  deck_filter_defaults: 'Deck filter defaults',
  saved_views: 'Saved views',
  notifications: 'Notifications',
  settings: 'App settings',
};

function formatDuration(ms: number | undefined): string {
  if (!ms) return 'disabled';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return `${ms} ms`;
  if (minutes === 1) return '1 minute';
  return `${minutes} minutes`;
}

export function DataPrivacyPage() {
  const { openWalkthrough, resetWalkthrough, currentVersion } = useWalkthrough();
  const [summary, setSummary] = useState<Array<{ store: StoreName; count: number }>>([]);
  const [localSummary, setLocalSummary] = useState<Array<{ key: string; bytes: number }>>([]);
  const [sessionSummary, setSessionSummary] = useState<Array<{ key: string; bytes: number }>>([]);
  const [nativeVaultStatus, setNativeVaultStatus] = useState<VaultStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingClear, setPendingClear] = useState<StoreName | 'all' | null>(null);
  const [pendingRetiredCredentialPurge, setPendingRetiredCredentialPurge] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    setLoading(true);
    try {
      const [indexedDbSummary, vaultStatus] = await Promise.all([
        storageSummary(),
        getVaultStatus().catch(() => null),
      ]);
      setSummary(indexedDbSummary);
      setLocalSummary(localStorageSummary());
      setSessionSummary(sessionStorageSummary());
      setNativeVaultStatus(vaultStatus);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const totalRecords = summary.reduce((a, b) => a + b.count, 0);
  const totalLocalBytes = localSummary.reduce((a, b) => a + b.bytes, 0);
  const totalSessionBytes = sessionSummary.reduce((a, b) => a + b.bytes, 0);
  const walkthroughEntry = localSummary.find((row) => row.key === WALKTHROUGH_STORAGE_KEY);

  const handleExport = async () => {
    try {
      const data = await exportAll();
      const payload = {
        app: 'OmniKit',
        exportedAt: new Date().toISOString(),
        version: 1,
        data,
        localStorage: exportOmniKitLocalStorage(),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `omnikit-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ type: 'success', title: 'Backup downloaded' });
    } catch {
      toast({ type: 'error', title: 'Export failed' });
    }
  };

  const handleImportFile = async (file: File, mode: 'merge' | 'replace') => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const data = parsed?.data ?? parsed;
      if (!data || typeof data !== 'object') throw new Error('Invalid backup file');
      await importAll(data, mode);
      importOmniKitLocalStorage(parsed?.localStorage, mode);
      await refresh();
      toast({ type: 'success', title: `Backup ${mode === 'replace' ? 'restored' : 'merged'}` });
    } catch (err) {
      toast({ type: 'error', title: 'Import failed', detail: err instanceof Error ? err.message : undefined });
    }
  };

  const onFileSelected = (mode: 'merge' | 'replace') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) handleImportFile(file, mode);
  };

  const performClear = async () => {
    if (!pendingClear) return;
    try {
      if (pendingClear === 'all') {
        for (const row of summary) {
          await clearStore(row.store);
        }
        clearOmniKitLocalStorage();
        clearOmniKitSessionStorage();
        toast({ type: 'success', title: 'All local data cleared' });
      } else {
        await clearStore(pendingClear);
        toast({ type: 'success', title: `${STORE_LABELS[pendingClear]} cleared` });
      }
      await refresh();
    } catch {
      toast({ type: 'error', title: 'Failed to clear data' });
    } finally {
      setPendingClear(null);
    }
  };

  const handleNativeVaultReset = async () => {
    try {
      await resetNativeVault();
      await refresh();
      toast({ type: 'success', title: 'Native vault reset' });
    } catch (err) {
      toast({ type: 'error', title: 'Native vault reset failed', detail: err instanceof Error ? err.message : undefined });
    }
  };

  const handleRetiredCredentialPurge = async () => {
    try {
      const result = await purgeRetiredBiMigrationCredentials();
      setNativeVaultStatus(result.status);
      const removedCount = result.removed.removedProviderProfiles + result.removed.removedSourceConnections;
      toast({
        type: 'success',
        title: 'Retired BI Migration credentials removed',
        detail: removedCount > 0
          ? `${removedCount} encrypted profile${removedCount === 1 ? '' : 's'} deleted; active and backup vault generations were sanitized.`
          : 'Active and backup vault generations were sanitized; no active retired profiles remained.',
      });
    } catch (err) {
      toast({
        type: 'error',
        title: 'Retired credential purge failed',
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setPendingRetiredCredentialPurge(false);
    }
  };

  const handleBrowserCacheClear = async () => {
    clearOmniKitLocalStorage();
    await refresh();
    toast({ type: 'success', title: 'Browser cache cleared' });
  };

  const handleSessionClear = async () => {
    clearOmniKitSessionStorage();
    await refresh();
    toast({ type: 'success', title: 'Active session cleared' });
  };

  const handleJobHistoryClear = async () => {
    try {
      await clearMigrationJobs();
      toast({ type: 'success', title: 'Migration job history cleared' });
    } catch (err) {
      toast({ type: 'error', title: 'Job history clear failed', detail: err instanceof Error ? err.message : undefined });
    }
  };

  const mergeInput = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Data & Privacy"
        description="Review the browser cache and local native files OmniKit uses on this machine. Export, import, or clear them here."
        icon={<Blobby mood="governance" size={58} className="animate-float" style={{ animationDuration: '3.6s' }} />}
        actions={<StatusChip status="success" label={`${totalRecords} records stored locally`} />}
      />

      <div className="card border-omni-100 bg-white p-5">
        <div className="flex items-start gap-3">
          <HardDrive size={17} className="mt-0.5 text-omni-700" aria-hidden="true" />
          <div>
            <h2 className="text-base font-semibold text-content-primary">OmniKit build identity</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-content-secondary">
              Include this non-secret identifier with tester screenshots so the running code can be matched to a repository revision.
            </p>
            <div className="mt-2 font-mono text-[11px] text-content-tertiary">
              {OMNIKIT_BUILD_INFO.label}
            </div>
          </div>
        </div>
      </div>

      <div className="card p-5 border-omni-100 bg-white">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3">
            <ShieldCheck size={17} className="mt-0.5 text-omni-700" />
            <div>
              <h2 className="text-base font-semibold text-content-primary">Native encrypted instance vault</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-content-secondary">
                Instance Manager stores reusable Omni instance API keys in an AES-256-GCM encrypted local file managed by the OmniKit Node server. The default location is <span className="font-mono">./data/vault.enc</span>, or <span className="font-mono">OMNIKIT_VAULT_PATH</span> when configured. The decrypted vault and derived key live in server memory only while unlocked, and the server auto-locks the vault after idle time. Locking also clears cached Omni content from server memory.
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-content-secondary">
                Each save writes the vault atomically and keeps the previous encrypted copy alongside it as <span className="font-mono">vault.enc.bak</span>, so an interrupted write cannot destroy your saved credentials. That backup is still encrypted with the passphrase it was written under. Resetting the vault deletes the backup together with the vault.
              </p>
              <div className="mt-2 font-mono text-[11px] text-content-tertiary">
                {nativeVaultStatus?.path || './data/vault.enc'} · {nativeVaultStatus?.exists ? 'file exists' : 'not created'} · {nativeVaultStatus?.unlocked ? 'unlocked' : 'locked'}
              </div>
              <div className="mt-1 font-mono text-[11px] text-content-tertiary">
                idle auto-lock: {formatDuration(nativeVaultStatus?.idleTimeoutMs)}
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-content-secondary">
                Non-secret multi-instance migration job history is stored only on this device in <span className="font-mono">./data/omnikit-jobs.json</span>, or <span className="font-mono">OMNIKIT_JOB_HISTORY_PATH</span> when configured. Job records include status, warnings, retry lineage, imported document IDs, and post-action results. OmniKit redacts API keys, bearer tokens, card-like numbers, emails, and phone numbers before writing job history.
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-content-secondary">
                Post-migration action templates stay in the encrypted vault. Job history stores redacted action metadata only. Actions are HTTPS-only, block private-network targets by default, and can be restricted with <span className="font-mono">OMNIKIT_POST_ACTION_ALLOWLIST</span>.
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-content-secondary">
                Instance Manager can import a compatible legacy <span className="font-mono">omni-multi-instance-tools</span> vault file after this native vault is unlocked. The legacy passphrase is used only for that local import request, imported API keys are re-encrypted into the native vault, and plaintext keys are never returned to the browser.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleNativeVaultReset}
            disabled={!nativeVaultStatus?.exists && (nativeVaultStatus?.instanceCount ?? 0) === 0}
            className="btn-danger shrink-0 text-sm"
          >
            <Trash2 size={14} />
            Reset native vault
          </button>
          <button
            type="button"
            onClick={handleJobHistoryClear}
            className="btn-secondary shrink-0 text-sm"
          >
            <Trash2 size={14} />
            Clear job history
          </button>
        </div>
      </div>

      <div className="card p-5 border-amber-200 bg-amber-50/40">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3">
            <ShieldCheck size={17} className="mt-0.5 text-amber-700" />
            <div>
              <h2 className="text-base font-semibold text-content-primary">Retired BI Migration Studio credentials</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-content-secondary">
                Upgrading does not silently discard saved BI source connections or AI-provider credentials.
                Existing entries remain encrypted and inaccessible to product workflows until an operator
                explicitly removes them here. This purge preserves saved Omni instances, deck recipes, and
                Dashboard or Model Migrator job history.
              </p>
              <p className="mt-2 font-mono text-[11px] text-content-tertiary">
                {nativeVaultStatus?.unlocked
                  ? `${nativeVaultStatus.retiredBiMigrationProviderCount ?? 0} provider profile(s) · ${nativeVaultStatus.retiredBiMigrationSourceCount ?? 0} source connection(s)`
                  : 'Unlock the native vault to inspect or purge retired credentials.'}
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-content-secondary">
                Sanitized legacy job, audit, and run records are not loaded by OmniKit after retirement and
                are not deleted automatically. Their default local paths are{' '}
                <span className="font-mono">./data/semantic-migration-jobs.json</span>,{' '}
                <span className="font-mono">./data/semantic-migration-audit.json</span>, and{' '}
                <span className="font-mono">./data/bi-migration-runs.jsonl</span> (plus its snapshot).
                Keep or remove those files according to the operator&apos;s audit-retention policy; configured
                environments may override each path.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setPendingRetiredCredentialPurge(true)}
            disabled={!nativeVaultStatus?.unlocked}
            className="btn-danger shrink-0 text-sm"
          >
            <Trash2 size={14} />
            Purge retired credentials
          </button>
        </div>
      </div>

      <div className="card p-5 border-omni-100 bg-white">
        <div className="flex items-start gap-3">
          <ShieldCheck size={17} className="mt-0.5 text-omni-700" />
          <div>
            <h2 className="text-base font-semibold text-content-primary">Browser vault compatibility bridge</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-content-secondary">
              Older Dashboard Migrator target credentials may still exist in <span className="font-mono">localStorage</span> as an AES-GCM encrypted browser vault. OmniKit no longer decrypts or imports that browser-side vault. Re-add any still-needed browser profiles to the native vault manually, then dismiss the legacy cache from Instance Manager or clear browser cache here. This is separate from the server-side legacy multi-instance <span className="font-mono">.enc</span> vault import available in Instance Manager.
            </p>
            <div className="mt-2 font-mono text-[11px] text-content-tertiary">
              omnikit:instanceVault:v1 · encrypted browser cache compatibility path
            </div>
          </div>
        </div>
      </div>

      <div className="card p-5 border-omni-100 bg-white">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3">
            <GraduationCap size={17} className="mt-0.5 text-omni-700" />
            <div>
              <h2 className="text-base font-semibold text-content-primary">Learning walkthrough</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-content-secondary">
                OmniKit stores a small walkthrough progress flag so returning users are not interrupted repeatedly. When the local app is updated and the guide version changes, the walkthrough can appear again for the new version.
              </p>
              <div className="mt-2 font-mono text-[11px] text-content-tertiary">
                {WALKTHROUGH_STORAGE_KEY} · {walkthroughEntry ? `${(walkthroughEntry.bytes / 1024).toFixed(1)} KB stored` : 'not stored yet'} · version {currentVersion}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button type="button" onClick={() => openWalkthrough('manual')} className="btn-secondary text-sm">
              <GraduationCap size={14} />
              Replay guide
            </button>
            <button
              type="button"
              onClick={() => {
                resetWalkthrough();
                refresh();
              }}
              className="btn-secondary text-sm"
            >
              <RotateCcw size={14} />
              Reset prompt
            </button>
          </div>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-3 mb-4">
          <HardDrive size={16} className="text-omni-700" />
          <h2 className="text-base font-semibold text-content-primary">Local storage</h2>
          <button
            onClick={refresh}
            className="btn-secondary text-xs ml-auto"
            disabled={loading}
            aria-label="Refresh storage summary"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
        <div className="divide-y divide-border">
          {summary.map((row) => (
            <div key={row.store} className="flex items-center justify-between py-2.5">
              <div>
                <div className="text-sm font-medium text-content-primary">{STORE_LABELS[row.store]}</div>
                <div className="text-[11px] text-content-secondary font-mono">{row.store}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs tabular-nums text-content-secondary">{row.count} records</span>
                <button
                  onClick={() => setPendingClear(row.store)}
                  disabled={row.count === 0}
                  className="text-xs px-2 py-1 rounded-button border border-border text-content-secondary hover:text-red-600 hover:border-red-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-3 mb-4">
          <HardDrive size={16} className="text-omni-700" />
          <h2 className="text-base font-semibold text-content-primary">Browser cache</h2>
          <span className="text-xs text-content-secondary ml-auto">
            {(totalLocalBytes / 1024).toFixed(1)} KB
          </span>
          <button
            type="button"
            onClick={handleBrowserCacheClear}
            disabled={localSummary.length === 0}
            className="btn-secondary text-xs"
          >
            <Trash2 size={12} />
            Clear cache
          </button>
        </div>
        {localSummary.length === 0 ? (
          <p className="text-sm text-content-secondary">No OmniKit localStorage entries found.</p>
        ) : (
          <div className="divide-y divide-border">
            {localSummary.map((row) => (
              <div key={row.key} className="flex items-center justify-between py-2.5">
                <div className="text-[11px] text-content-secondary font-mono truncate pr-4">{row.key}</div>
                <span className="text-xs tabular-nums text-content-secondary">{(row.bytes / 1024).toFixed(1)} KB</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-3 mb-4">
          <HardDrive size={16} className="text-omni-700" />
          <h2 className="text-base font-semibold text-content-primary">Session storage</h2>
          <span className="text-xs text-content-secondary ml-auto">
            {(totalSessionBytes / 1024).toFixed(1)} KB
          </span>
          <button
            type="button"
            onClick={handleSessionClear}
            disabled={sessionSummary.length === 0}
            className="btn-secondary text-xs"
          >
            <Trash2 size={12} />
            Clear session
          </button>
        </div>
        {sessionSummary.length === 0 ? (
          <p className="text-sm text-content-secondary">No OmniKit sessionStorage entries found.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-[13px] text-content-secondary leading-relaxed">
              Session storage can include the active saved-instance reference for this browser tab. It stores masked metadata and a non-secret vault reference, not plaintext API keys, and is cleared by Clear all local data.
            </p>
            <div className="divide-y divide-border">
              {sessionSummary.map((row) => (
                <div key={row.key} className="flex items-center justify-between py-2.5">
                  <div className="text-[11px] text-content-secondary font-mono truncate pr-4">{row.key}</div>
                  <span className="text-xs tabular-nums text-content-secondary">{(row.bytes / 1024).toFixed(1)} KB</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-2">
            <Download size={16} className="text-omni-700" />
            <h3 className="text-base font-semibold text-content-primary">Export backup</h3>
          </div>
          <p className="text-[13px] text-content-secondary mb-4 leading-relaxed">
            Download a single JSON file containing OmniKit's IndexedDB records and browser cache entries. Useful for moving between machines or keeping a local snapshot.
          </p>
          <button onClick={handleExport} className="btn-primary text-sm">
            <Download size={14} />
            Download backup
          </button>
        </div>

        <div className="card p-5">
          <div className="flex items-center gap-2 mb-2">
            <Upload size={16} className="text-omni-700" />
            <h3 className="text-base font-semibold text-content-primary">Import backup</h3>
          </div>
          <p className="text-[13px] text-content-secondary mb-4 leading-relaxed">
            Merge adds records from the file to what's already here. Replace wipes existing data first.
          </p>
          <div className="flex gap-2">
            <input ref={mergeInput} type="file" accept="application/json" className="hidden" onChange={onFileSelected('merge')} />
            <input ref={fileInput} type="file" accept="application/json" className="hidden" onChange={onFileSelected('replace')} />
            <button onClick={() => mergeInput.current?.click()} className="btn-secondary text-sm">
              <Upload size={14} />
              Merge
            </button>
            <button onClick={() => fileInput.current?.click()} className="btn-secondary text-sm">
              <Upload size={14} />
              Replace
            </button>
          </div>
        </div>
      </div>

      <div className="card p-5 border-red-200">
        <div className="flex items-center gap-2 mb-2">
          <Trash2 size={16} className="text-red-600" />
          <h3 className="text-base font-semibold text-content-primary">Danger zone</h3>
        </div>
        <p className="text-[13px] text-content-secondary mb-4 leading-relaxed">
          Permanently delete OmniKit browser data on this device. Use Reset native vault above for encrypted instance profiles and migration job history.
        </p>
        <button
          onClick={() => setPendingClear('all')}
          disabled={totalRecords === 0 && localSummary.length === 0 && sessionSummary.length === 0}
          className="px-4 py-2 rounded-button text-sm font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
        >
          <Trash2 size={14} />
          Clear all local data
        </button>
      </div>

      <ConfirmDialog
        open={pendingClear !== null}
        title={pendingClear === 'all' ? 'Clear all local data?' : 'Clear data?'}
        message={
          pendingClear === 'all'
            ? 'OmniKit browser data on this device will be permanently deleted. The native vault is managed separately above. This cannot be undone.'
            : pendingClear
            ? `Permanently delete all "${STORE_LABELS[pendingClear]}" records from this device?`
            : ''
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={performClear}
        onCancel={() => setPendingClear(null)}
      />
      <ConfirmDialog
        open={pendingRetiredCredentialPurge}
        title="Purge retired BI Migration credentials?"
        message="This permanently removes every saved BI source connection and external AI-provider credential retained from BI Migration Studio. Saved Omni instances and current migration job history are preserved. This cannot be undone."
        confirmLabel="Purge credentials"
        variant="danger"
        onConfirm={handleRetiredCredentialPurge}
        onCancel={() => setPendingRetiredCredentialPurge(false)}
      />
    </div>
  );
}
