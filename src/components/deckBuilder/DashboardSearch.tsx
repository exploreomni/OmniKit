import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Search, RefreshCcw, Loader2, Folder } from 'lucide-react';
import { selectedBadgeClass, selectedRowClass, unselectedRowClass } from '@/components/ui/selectionStyles';
import type { CachedDashboard } from '@/services/deckBuilder/localCache';

interface Props {
  dashboards: CachedDashboard[];
  loading: boolean;
  lastSyncedAt: number | null;
  onRefresh: () => void;
  onPick: (d: CachedDashboard) => void;
  selectedDashboardId?: string;
  disabled?: boolean;
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'never synced';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function DashboardSearch({ dashboards, loading, lastSyncedAt, onRefresh, onPick, selectedDashboardId, disabled }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const totalMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return dashboards.length;
    return dashboards
      .filter((d) => d.name.toLowerCase().includes(q) || (d.folderPath || '').toLowerCase().includes(q))
      .length;
  }, [dashboards, query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return dashboards.slice(0, 100);
    return dashboards
      .filter((d) => d.name.toLowerCase().includes(q) || (d.folderPath || '').toLowerCase().includes(q))
      .slice(0, 100);
  }, [dashboards, query]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter' && filtered[highlight]) {
      e.preventDefault();
      onPick(filtered[highlight]);
      setOpen(false);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-content-tertiary" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKey}
            placeholder={loading ? 'Loading dashboards…' : `Search ${dashboards.length} dashboard${dashboards.length === 1 ? '' : 's'}…`}
            disabled={disabled || loading}
            className="input-field pl-9"
          />
        </div>
        <button
          onClick={onRefresh}
          disabled={loading || disabled}
          className="btn-ghost btn-sm"
          type="button"
          title="Refresh dashboard list from Omni"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCcw size={13} />}
          Refresh
        </button>
      </div>
      <div className="text-[11px] text-content-tertiary mt-1.5 flex items-center gap-2">
        <span>
          {dashboards.length} fetched · cached locally · last synced {timeAgo(lastSyncedAt)}
          {totalMatches > filtered.length ? ` · showing first ${filtered.length} matches` : ''}
        </span>
      </div>

      {open && filtered.length > 0 && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-border rounded-card shadow-dropdown max-h-80 overflow-y-auto">
          {filtered.map((d, idx) => {
            const selected = selectedDashboardId === d.id;
            return (
              <button
                key={d.id}
                type="button"
                onMouseEnter={() => setHighlight(idx)}
                onClick={() => {
                  onPick(d);
                  setOpen(false);
                }}
                aria-pressed={selected}
                className={`w-full text-left px-3 py-2.5 border-b border-border/40 last:border-0 transition-all ${
                  selected ? selectedRowClass : idx === highlight ? 'border-l-4 border-l-omni-300 bg-omni-50' : unselectedRowClass
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-content-primary truncate">{d.name}</div>
                    {d.folderPath && (
                      <div className="text-[11px] text-content-tertiary truncate flex items-center gap-1 mt-0.5">
                        <Folder size={10} />
                        {d.folderPath}
                      </div>
                    )}
                  </div>
                  {selected && (
                    <span className={selectedBadgeClass}>
                      <CheckCircle2 size={12} />
                      Selected
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {open && !loading && filtered.length === 0 && dashboards.length > 0 && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-border rounded-card shadow-dropdown px-3 py-3 text-sm text-content-tertiary">
          No dashboards match.
        </div>
      )}
    </div>
  );
}
