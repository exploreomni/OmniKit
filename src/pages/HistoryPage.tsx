import { useState } from 'react';
import {
  ArrowRightLeft, Trash2, FolderInput, Download, Tag, Upload,
  PlayCircle, Sparkles, UserPlus, UserMinus, UserCog, Shield,
  Database, BookOpen, GitMerge, Link2, Clock
} from 'lucide-react';
import { useOperationLog } from '@/contexts/OperationLogContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusChip } from '@/components/ui/StatusChip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Blobby } from '@/components/ui/Blobby';
import type { OperationType } from '@/types';

const TYPE_CONFIG: Record<OperationType, { icon: typeof Clock; label: string; color: string }> = {
  migration: { icon: ArrowRightLeft, label: 'Model Migrator', color: 'text-blue-600 bg-blue-50' },
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
  topic_create: { icon: BookOpen, label: 'Topic Created', color: 'text-green-600 bg-green-50' },
  topic_update: { icon: BookOpen, label: 'Topic Updated', color: 'text-blue-600 bg-blue-50' },
  topic_delete: { icon: BookOpen, label: 'Topic Deleted', color: 'text-red-600 bg-red-50' },
  branch_merge: { icon: GitMerge, label: 'Branch Merged', color: 'text-sky-600 bg-sky-50' },
  embed_generate: { icon: Link2, label: 'Embed Generated', color: 'text-sky-600 bg-sky-50' },
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function HistoryPage() {
  const { entries, clearLog } = useOperationLog();
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const types = [...new Set(entries.map((e) => e.type))];
  const filtered = typeFilter ? entries.filter((e) => e.type === typeFilter) : entries;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Operation History"
        description="All operations performed on this device. Stored locally in your browser and survives refresh."
        icon={<Blobby mood="thinking" size={58} className="animate-float" style={{ animationDuration: '3.7s' }} />}
        actions={
          <div className="flex gap-2 items-center">
            <StatusChip status="success" label="Stored Locally" />
            {entries.length > 0 && (
              <button onClick={() => setShowClearConfirm(true)} className="btn-secondary text-sm">
                <Trash2 size={14} />
                Clear
              </button>
            )}
          </div>
        }
      />

      {entries.length > 0 && types.length >= 1 && (
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setTypeFilter('')}
            className={`px-2.5 py-1 rounded-chip text-xs font-medium transition-colors border ${
              !typeFilter ? 'bg-omni-700 text-white border-omni-700' : 'bg-white border-border text-content-secondary hover:border-omni-500'
            }`}
          >
            All ({entries.length})
          </button>
          {types.map((t) => {
            const config = TYPE_CONFIG[t];
            const count = entries.filter((e) => e.type === t).length;
            return (
              <button
                key={t}
                onClick={() => setTypeFilter(typeFilter === t ? '' : t)}
                className={`px-2.5 py-1 rounded-chip text-xs font-medium transition-colors border ${
                  typeFilter === t ? 'bg-omni-700 text-white border-omni-700' : 'bg-white border-border text-content-secondary hover:border-omni-500'
                }`}
              >
                {config?.label || t} ({count})
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 animate-fadeIn">
          <img
            src={typeFilter ? '/blobby-empty.png' : '/blobby-thinking.webp'}
            alt={typeFilter ? 'Blobby investigating' : 'Blobby thinking'}
            className="w-24 h-24 object-contain animate-float mb-4"
            style={{ animationDuration: '3.5s' }}
          />
          <h3 className="text-base font-semibold text-content-primary mb-2">
            {typeFilter ? 'No Matching Operations' : 'No Operations Yet'}
          </h3>
          <p className="text-sm text-content-secondary text-center max-w-md">
            {typeFilter
              ? 'No operations of this type have been performed. Try a different filter.'
              : 'Operations you perform (queries, downloads, migrations, label changes, and more) will appear here and persist across refreshes on this device.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((entry) => {
            const config = TYPE_CONFIG[entry.type] || { icon: Clock, label: entry.type, color: 'text-gray-600 bg-gray-50' };
            const Icon = config.icon;

            return (
              <div key={entry.id} className="card p-4 flex items-center gap-4 animate-fadeIn">
                <div className={`p-2 rounded-button ${config.color} flex-shrink-0`}>
                  <Icon size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-content-primary truncate">{entry.description}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-[10px] text-content-secondary tabular-nums">
                    <span>{formatTime(entry.timestamp)}</span>
                    {entry.itemCount > 0 && <span>{entry.itemCount} items</span>}
                    {entry.durationMs > 0 && <span>{formatDuration(entry.durationMs)}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {entry.successCount > 0 && (
                    <StatusChip status="success" label={`${entry.successCount} ok`} />
                  )}
                  {entry.failureCount > 0 && (
                    <StatusChip status="error" label={`${entry.failureCount} failed`} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={showClearConfirm}
        title="Clear History"
        message="Are you sure you want to clear all operation history? This cannot be undone."
        confirmLabel="Clear All"
        variant="danger"
        itemCount={entries.length}
        onConfirm={() => { clearLog(); setShowClearConfirm(false); }}
        onCancel={() => setShowClearConfirm(false)}
      />
    </div>
  );
}
