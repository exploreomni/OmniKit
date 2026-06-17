import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  BookOpen,
  Clock,
  Database,
  Download,
  FileJson,
  FolderInput,
  GitMerge,
  Link2,
  Loader2,
  PlayCircle,
  RefreshCw,
  Shield,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  UserCog,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { useOperationLog } from '@/contexts/OperationLogContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusChip } from '@/components/ui/StatusChip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Blobby } from '@/components/ui/Blobby';
import { clearMigrationJobs, listMigrationJobs, type JobStatus, type MigrationJob } from '@/services/opsConsole';
import { sanitizeHistoryExportPayload } from '@/services/historyExport';
import type { OperationLogEntry, OperationType } from '@/types';

const TYPE_CONFIG: Record<OperationType, { icon: typeof Clock; label: string; color: string }> = {
  migration: { icon: ArrowRightLeft, label: 'Dashboard Migrator', color: 'text-blue-600 bg-blue-50' },
  bulk_move: { icon: FolderInput, label: 'Dashboard Move', color: 'text-sky-600 bg-sky-50' },
  bulk_delete: { icon: Trash2, label: 'Dashboard Delete', color: 'text-red-600 bg-red-50' },
  download: { icon: Download, label: 'Download', color: 'text-sky-600 bg-sky-50' },
  label_change: { icon: Tag, label: 'Label Change', color: 'text-amber-600 bg-amber-50' },
  user_import: { icon: Upload, label: 'User Import', color: 'text-green-600 bg-green-50' },
  query_run: { icon: PlayCircle, label: 'Query', color: 'text-cyan-600 bg-cyan-50' },
  ai_query: { icon: Sparkles, label: 'AI Query', color: 'text-rose-600 bg-rose-50' },
  user_create: { icon: UserPlus, label: 'User Created', color: 'text-green-600 bg-green-50' },
  user_update: { icon: UserCog, label: 'User Updated', color: 'text-blue-600 bg-blue-50' },
  user_delete: { icon: UserMinus, label: 'User Deleted', color: 'text-red-600 bg-red-50' },
  group_update: { icon: Shield, label: 'Group Updated', color: 'text-blue-600 bg-blue-50' },
  model_create: { icon: Database, label: 'Model Created', color: 'text-green-600 bg-green-50' },
  model_migration: { icon: Database, label: 'Model Migration', color: 'text-purple-600 bg-purple-50' },
  topic_create: { icon: BookOpen, label: 'Topic Created', color: 'text-green-600 bg-green-50' },
  topic_update: { icon: BookOpen, label: 'Topic Updated', color: 'text-blue-600 bg-blue-50' },
  topic_delete: { icon: BookOpen, label: 'Topic Deleted', color: 'text-red-600 bg-red-50' },
  branch_merge: { icon: GitMerge, label: 'Branch Merged', color: 'text-sky-600 bg-sky-50' },
  embed_generate: { icon: Link2, label: 'Embed Generated', color: 'text-sky-600 bg-sky-50' },
};

type TimelineFilter = 'all' | 'operations' | 'migration_jobs' | OperationType;

interface OperationTimelineItem {
  kind: 'operation';
  id: string;
  timestamp: number;
  entry: OperationLogEntry;
}

interface JobTimelineItem {
  kind: 'migration_job';
  id: string;
  timestamp: number;
  job: MigrationJob;
}

type TimelineItem = OperationTimelineItem | JobTimelineItem;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(ms: number): string {
  if (ms <= 0) return 'Not timed';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function statusForChip(status: JobStatus): 'success' | 'warning' | 'error' | 'info' | 'in_progress' {
  if (status === 'succeeded') return 'success';
  if (status === 'partial' || status === 'canceled') return 'warning';
  if (status === 'failed') return 'error';
  if (status === 'running' || status === 'pending') return 'in_progress';
  return 'info';
}

function jobCounts(job: MigrationJob) {
  return {
    succeeded: job.items.filter((item) => item.status === 'succeeded' || item.status === 'warning').length,
    failed: job.items.filter((item) => item.status === 'failed').length,
    warning: job.items.filter((item) => item.status === 'warning').length,
    pending: job.items.filter((item) => item.status === 'pending' || item.status === 'running').length,
  };
}

function numberDetail(job: MigrationJob, key: string): number {
  const value = job.details?.[key];
  return typeof value === 'number' ? value : 0;
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function JobDetail({ job }: { job: MigrationJob }) {
  const counts = jobCounts(job);
  const isModelJob = job.workflow === 'model';
  const modelCount = numberDetail(job, 'modelCount') || job.targets?.length || 0;
  const workbookCount = numberDetail(job, 'workbookCount');
  return (
    <div className="card p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-base font-semibold text-content-primary">{isModelJob ? 'Model migration job detail' : 'Migration job detail'}</h2>
          <p className="mt-1 text-sm text-content-secondary">
            {job.sourceLabel} · {isModelJob ? `${modelCount} model${modelCount === 1 ? '' : 's'} · ${workbookCount} workbook${workbookCount === 1 ? '' : 's'}` : `${job.documentIds.length} dashboard${job.documentIds.length === 1 ? '' : 's'}`} · {job.targets?.length || job.destinationIds.length} target{(job.targets?.length || job.destinationIds.length) === 1 ? '' : 's'}
          </p>
          {job.parentJobId && <p className="mt-1 text-xs text-content-secondary">Retry of {job.parentJobId}</p>}
        </div>
        <StatusChip status={statusForChip(job.status)} label={job.status} />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <div className="rounded-card bg-surface-secondary p-3 text-sm"><span className="font-semibold">{job.items.length}</span><br />Total steps</div>
        <div className="rounded-card bg-surface-secondary p-3 text-sm"><span className="font-semibold">{counts.succeeded}</span><br />Succeeded</div>
        <div className="rounded-card bg-surface-secondary p-3 text-sm"><span className="font-semibold">{counts.failed}</span><br />Failed</div>
        <div className="rounded-card bg-surface-secondary p-3 text-sm"><span className="font-semibold">{counts.pending}</span><br />Pending/running</div>
      </div>
      <div className="mt-4 max-h-[440px] overflow-auto rounded-card border border-border-subtle">
        {job.items.map((item) => (
          <div key={item.id} className="border-b border-border-subtle px-3 py-2 text-xs last:border-b-0">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="font-semibold uppercase tracking-wide text-content-primary">{item.kind}</div>
                <div className="mt-0.5 truncate text-content-secondary">
                  {item.documentName || item.documentId || item.targetModelName || item.targetModelId || 'Job step'}
                </div>
                <div className="mt-0.5 truncate text-content-tertiary">
                  {item.destinationLabel} · {item.targetModelName || item.targetModelId || 'No target model'} · {item.targetFolderPath || 'Default folder'}
                </div>
              </div>
              <span className={`rounded-chip px-2 py-0.5 font-semibold ${item.status === 'succeeded' ? 'bg-green-100 text-green-700' : item.status === 'failed' ? 'bg-red-100 text-red-700' : item.status === 'warning' ? 'bg-yellow-100 text-yellow-800' : 'bg-surface-secondary text-content-secondary'}`}>
                {item.status}
              </span>
            </div>
            {item.importedDocumentId && <div className="mt-1 text-content-secondary">Imported document: {item.importedDocumentId}</div>}
            {item.importedIdentifier && <div className="mt-1 text-content-secondary">Imported identifier: {item.importedIdentifier}</div>}
            {typeof item.details?.url === 'string' && (
              <a href={item.details.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-omni-700 underline">
                Open imported document
              </a>
            )}
            {item.warnings?.map((warning) => <div key={warning} className="mt-1 text-yellow-700">{warning}</div>)}
            {item.error && <div className="mt-1 text-red-700">{item.error}</div>}
            {item.kind === 'workbook_create' && Array.isArray(item.details?.tabs) && (
              <div className="mt-2 rounded-card border border-border-subtle bg-surface-secondary p-2">
                <div className="mb-1 font-semibold text-content-primary">Workbook tabs</div>
                {(item.details.tabs as Array<{ name?: string; status?: string; carried?: string[]; retryBoundary?: string }>).map((tab, tabIndex) => (
                  <div key={`${item.id}:history-tab:${tabIndex}`} className="flex items-center justify-between gap-2 py-0.5 text-content-secondary">
                    <span>{tab.name || `Tab ${tabIndex + 1}`}</span>
                    <span>{tab.status || 'created'} · {(tab.carried || []).join(', ') || 'query'}{tab.retryBoundary ? ` · retry: ${tab.retryBoundary}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function HistoryPage() {
  const { entries, clearLog } = useOperationLog();
  const [jobs, setJobs] = useState<MigrationJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [typeFilter, setTypeFilter] = useState<TimelineFilter>('all');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [error, setError] = useState('');

  async function loadJobs() {
    setLoadingJobs(true);
    setError('');
    try {
      const res = await listMigrationJobs();
      setJobs(res.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load migration job history.');
    } finally {
      setLoadingJobs(false);
    }
  }

  useEffect(() => {
    void loadJobs();
  }, []);

  const childJobsByParent = useMemo(() => {
    const rows = new Map<string, MigrationJob[]>();
    for (const job of jobs) {
      if (!job.parentJobId) continue;
      rows.set(job.parentJobId, [...(rows.get(job.parentJobId) || []), job]);
    }
    return rows;
  }, [jobs]);

  const rootJobs = jobs.filter((job) => !job.parentJobId);
  const operationTypes = [...new Set(entries.map((entry) => entry.type))];
  const timeline = useMemo<TimelineItem[]>(() => {
    const rows: TimelineItem[] = [
      ...entries.map((entry): OperationTimelineItem => ({ kind: 'operation', id: entry.id, timestamp: entry.timestamp, entry })),
      ...rootJobs.map((job): JobTimelineItem => ({ kind: 'migration_job', id: job.id, timestamp: job.createdAt, job })),
    ];
    return rows.sort((a, b) => b.timestamp - a.timestamp);
  }, [entries, rootJobs]);

  const filtered = timeline.filter((item) => {
    if (typeFilter === 'all') return true;
    if (typeFilter === 'operations') return item.kind === 'operation';
    if (typeFilter === 'migration_jobs') return item.kind === 'migration_job';
    return item.kind === 'operation' && item.entry.type === typeFilter;
  });
  const selectedJob = jobs.find((job) => job.id === selectedJobId) || null;
  const totalItems = entries.length + jobs.length;

  async function clearAll() {
    clearLog();
    await clearMigrationJobs();
    setJobs([]);
    setSelectedJobId('');
    setShowClearConfirm(false);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Operation History"
        description="Local browser operations and redacted migration jobs from this OmniKit install."
        icon={<Blobby mood="thinking" size={58} className="animate-float" style={{ animationDuration: '3.7s' }} />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status="success" label="Stored locally" />
            <button onClick={() => void loadJobs()} disabled={loadingJobs} className="btn-secondary inline-flex items-center gap-2 text-sm">
              {loadingJobs ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </button>
            {totalItems > 0 && (
              <>
                <button
                  onClick={() => downloadJson(
                    `omnikit-history-${new Date().toISOString().slice(0, 10)}.json`,
                    sanitizeHistoryExportPayload({ operations: entries, migrationJobs: jobs }),
                  )}
                  className="btn-secondary inline-flex items-center gap-2 text-sm"
                >
                  <FileJson size={14} />
                  Export JSON
                </button>
                <button onClick={() => setShowClearConfirm(true)} className="btn-secondary text-sm">
                  <Trash2 size={14} />
                  Clear
                </button>
              </>
            )}
          </div>
        }
      />

      {error && <div className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {totalItems > 0 && (
        <div className="flex flex-wrap gap-2">
          {([
            ['all', `All (${totalItems})`],
            ['operations', `Operations (${entries.length})`],
            ['migration_jobs', `Migration jobs (${jobs.length})`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setTypeFilter(value)}
              className={`rounded-chip border px-2.5 py-1 text-xs font-medium transition-colors ${
                typeFilter === value ? 'border-omni-700 bg-omni-700 text-white' : 'border-border bg-white text-content-secondary hover:border-omni-500'
              }`}
            >
              {label}
            </button>
          ))}
          {operationTypes.map((type) => {
            const config = TYPE_CONFIG[type];
            const count = entries.filter((entry) => entry.type === type).length;
            return (
              <button
                key={type}
                onClick={() => setTypeFilter(type)}
                className={`rounded-chip border px-2.5 py-1 text-xs font-medium transition-colors ${
                  typeFilter === type ? 'border-omni-700 bg-omni-700 text-white' : 'border-border bg-white text-content-secondary hover:border-omni-500'
                }`}
              >
                {config?.label || type} ({count})
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 animate-fadeIn">
          <img
            src={typeFilter === 'all' ? '/blobby-thinking.webp' : '/blobby-empty.png'}
            alt="Blobby reviewing local history"
            className="mb-4 h-24 w-24 object-contain animate-float"
            style={{ animationDuration: '3.5s' }}
          />
          <h3 className="mb-2 text-base font-semibold text-content-primary">
            {typeFilter === 'all' ? 'No History Yet' : 'No Matching History'}
          </h3>
          <p className="max-w-md text-center text-sm text-content-secondary">
            Operations, fan-out migrations, retries, and post-migration actions will appear here after they run on this device.
          </p>
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-2">
            {filtered.map((item) => {
              if (item.kind === 'operation') {
                const config = TYPE_CONFIG[item.entry.type] || { icon: Clock, label: item.entry.type, color: 'text-gray-600 bg-gray-50' };
                const Icon = config.icon;
                return (
                  <div key={item.id} className="card flex items-center gap-4 p-4 animate-fadeIn">
                    <div className={`flex-shrink-0 rounded-button p-2 ${config.color}`}>
                      <Icon size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-content-primary">{item.entry.description}</div>
                      <div className="mt-0.5 flex items-center gap-3 text-[10px] text-content-secondary tabular-nums">
                        <span>{formatTime(item.entry.timestamp)}</span>
                        {item.entry.itemCount > 0 && <span>{item.entry.itemCount} items</span>}
                        {item.entry.durationMs > 0 && <span>{formatDuration(item.entry.durationMs)}</span>}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      {item.entry.successCount > 0 && <StatusChip status="success" label={`${item.entry.successCount} ok`} />}
                      {item.entry.failureCount > 0 && <StatusChip status="error" label={`${item.entry.failureCount} failed`} />}
                    </div>
                  </div>
                );
              }

              const counts = jobCounts(item.job);
              const children = childJobsByParent.get(item.job.id) || [];
              const isModelJob = item.job.workflow === 'model';
              const modelCount = numberDetail(item.job, 'modelCount') || item.job.targets?.length || 0;
              const workbookCount = numberDetail(item.job, 'workbookCount');
              const dashboardCount = numberDetail(item.job, 'dashboardCount') || item.job.documentIds.length;
              return (
                <div key={item.id} className="card p-4 animate-fadeIn">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ArrowRightLeft size={16} className="text-omni-600" />
                        <span className="truncate text-sm font-semibold text-content-primary">{isModelJob ? 'Model migration' : 'Fan-out migration'} from {item.job.sourceLabel}</span>
                      </div>
                      <div className="mt-1 text-xs text-content-secondary">
                        {formatTime(item.job.createdAt)} · {isModelJob ? `${modelCount} model${modelCount === 1 ? '' : 's'} · ${dashboardCount} dashboard${dashboardCount === 1 ? '' : 's'} · ${workbookCount} workbook${workbookCount === 1 ? '' : 's'}` : `${item.job.documentIds.length} dashboard${item.job.documentIds.length === 1 ? '' : 's'}`} · {item.job.targets?.length || item.job.destinationIds.length} target{(item.job.targets?.length || item.job.destinationIds.length) === 1 ? '' : 's'} · {formatDuration((item.job.endedAt || Date.now()) - (item.job.startedAt || item.job.createdAt))}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip status={statusForChip(item.job.status)} label={item.job.status} />
                      <button type="button" onClick={() => setSelectedJobId(item.job.id)} className="btn-secondary text-xs">Details</button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
                    <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{item.job.items.length}</span><br />Steps</div>
                    <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{counts.succeeded}</span><br />Succeeded</div>
                    <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{counts.failed}</span><br />Failed</div>
                    <div className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{children.length}</span><br />Retries</div>
                  </div>
                  {children.length > 0 && (
                    <div className="mt-3 space-y-2 border-l-2 border-omni-100 pl-3">
                      {children.map((child) => (
                        <button
                          key={child.id}
                          type="button"
                          onClick={() => setSelectedJobId(child.id)}
                          className="block w-full rounded-card border border-border-subtle bg-surface-secondary px-3 py-2 text-left text-xs hover:border-omni-300"
                        >
                          <span className="font-semibold text-content-primary">Retry job</span>
                          <span className="ml-2 text-content-secondary">{formatTime(child.createdAt)} · {child.status}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="space-y-4">
            {selectedJob ? (
              <JobDetail job={selectedJob} />
            ) : (
              <div className="card p-5 text-sm text-content-secondary">
                Select a migration job to inspect its redacted step history, retry lineage, import IDs, warnings, and post-action results.
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={showClearConfirm}
        title="Clear Local History"
        message="Clear browser operation history and local migration job history on this device? This does not change anything in Omni."
        confirmLabel="Clear All"
        variant="danger"
        itemCount={totalItems}
        onConfirm={() => { void clearAll(); }}
        onCancel={() => setShowClearConfirm(false)}
      />
    </div>
  );
}
