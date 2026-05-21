import { useEffect, useRef, useState } from 'react';
import { Download, Upload, Trash2, HardDrive, RefreshCw, GraduationCap, RotateCcw } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusChip } from '@/components/ui/StatusChip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { Blobby } from '@/components/ui/Blobby';
import { useWalkthrough } from '@/hooks/useWalkthrough';
import { WALKTHROUGH_STORAGE_KEY } from '@/services/walkthrough';
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

export function DataPrivacyPage() {
  const { openWalkthrough, resetWalkthrough, currentVersion } = useWalkthrough();
  const [summary, setSummary] = useState<Array<{ store: StoreName; count: number }>>([]);
  const [localSummary, setLocalSummary] = useState<Array<{ key: string; bytes: number }>>([]);
  const [sessionSummary, setSessionSummary] = useState<Array<{ key: string; bytes: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [pendingClear, setPendingClear] = useState<StoreName | 'all' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    setLoading(true);
    try {
      const [indexedDbSummary] = await Promise.all([storageSummary()]);
      setSummary(indexedDbSummary);
      setLocalSummary(localStorageSummary());
      setSessionSummary(sessionStorageSummary());
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

  const mergeInput = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Data & Privacy"
        description="Everything OmniKit stores lives in your browser. Export, import, or clear it here."
        icon={<Blobby mood="governance" size={58} className="animate-float" style={{ animationDuration: '3.6s' }} />}
        actions={<StatusChip status="success" label={`${totalRecords} records stored locally`} />}
      />

      <div className="card p-5 border-omni-100 bg-omni-50">
        <div className="flex items-start gap-3">
          <HardDrive size={16} className="mt-0.5 text-omni-700" />
          <div>
            <h2 className="text-base font-semibold text-content-primary">AI source handling</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-omni-700">
              AI Semantic Studio can parse dbt, Looker, Power BI, Tableau, and Domo source artifacts in the browser for migration planning. AI Dashboard Studio can parse Excel workbooks for guarded dashboard draft planning and model follow-up discovery. Raw uploaded files and pasted source text stay in page memory by default and are not written to IndexedDB or localStorage. Generated YAML, Blobby responses, dashboard handoffs, branch validation results, and normal operation metadata follow the storage rules listed below.
            </p>
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
        </div>
        {sessionSummary.length === 0 ? (
          <p className="text-sm text-content-secondary">No OmniKit sessionStorage entries found.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-[13px] text-content-secondary leading-relaxed">
              Session storage can include the active connection for this browser tab. It is excluded from backups and cleared by Clear all local data.
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
          Permanently delete every record OmniKit has stored on this device. This cannot be undone.
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
            ? 'Every record OmniKit has stored on this device will be permanently deleted. This cannot be undone.'
            : pendingClear
            ? `Permanently delete all "${STORE_LABELS[pendingClear]}" records from this device?`
            : ''
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={performClear}
        onCancel={() => setPendingClear(null)}
      />
    </div>
  );
}
