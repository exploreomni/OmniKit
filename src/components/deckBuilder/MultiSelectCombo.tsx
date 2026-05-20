import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, X, Search, Loader2, RefreshCcw, AlertTriangle, Plus } from 'lucide-react';
import { selectedRowClass, unselectedRowClass } from '@/components/ui/selectionStyles';

interface Props {
  selected: string[];
  onChange: (next: string[]) => void;
  loadOptions: () => Promise<string[]>;
  refreshOptions?: () => Promise<string[]>;
  placeholder?: string;
  emptyOptionsHint?: string;
  disabled?: boolean;
  allowFreeText?: boolean;
  onPasteBulk?: (values: string[]) => void;
}

export function MultiSelectCombo({
  selected,
  onChange,
  loadOptions,
  refreshOptions,
  placeholder = 'Search values...',
  emptyOptionsHint = 'No values available.',
  disabled,
  allowFreeText = true,
  onPasteBulk,
}: Props) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const ensureLoaded = async (force = false) => {
    if (loading) return;
    if (!force && options !== null) return;
    setLoading(true);
    setError(null);
    try {
      const fn = force && refreshOptions ? refreshOptions : loadOptions;
      const next = await fn();
      setOptions(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load values.');
      setOptions([]);
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = () => {
    if (disabled) return;
    setOpen(true);
    void ensureLoaded(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const filtered = useMemo(() => {
    const opts = options ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return opts.slice(0, 500);
    return opts.filter((v) => v.toLowerCase().includes(q)).slice(0, 500);
  }, [options, query]);

  const toggleValue = (v: string) => {
    if (selected.includes(v)) {
      onChange(selected.filter((s) => s !== v));
    } else {
      onChange([...selected, v]);
    }
  };

  const removeValue = (v: string) => {
    onChange(selected.filter((s) => s !== v));
  };

  const addFreeText = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (selected.includes(v)) return;
    onChange([...selected, v]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlight]) {
        toggleValue(filtered[highlight]);
        setQuery('');
      } else if (allowFreeText && query.trim()) {
        addFreeText(query);
        setQuery('');
      }
    } else if (e.key === 'Backspace' && query === '' && selected.length > 0) {
      onChange(selected.slice(0, -1));
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === ',') {
      if (allowFreeText && query.trim()) {
        e.preventDefault();
        addFreeText(query);
        setQuery('');
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    if (text.includes(',') || text.includes('\n') || text.includes('\t')) {
      e.preventDefault();
      const parts = text
        .split(/[\n,\t]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length === 0) return;
      if (onPasteBulk) {
        onPasteBulk(parts);
      } else {
        const merged = Array.from(new Set([...selected, ...parts]));
        onChange(merged);
      }
      setQuery('');
    }
  };

  const visibleOptions = filtered;

  return (
    <div ref={containerRef} className="relative">
      <div
        onClick={handleOpen}
        className={`min-h-[38px] w-full rounded-button border px-2 py-1.5 bg-white flex flex-wrap items-center gap-1.5 cursor-text transition ${
          open ? 'border-omni-500 ring-2 ring-omni-200' : 'border-border hover:border-omni-300'
        } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        {selected.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-omni-100 text-omni-700 max-w-[220px]"
          >
            <span className="truncate">{v}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeValue(v);
              }}
              className="hover:bg-omni-200 rounded-full p-0.5 flex-shrink-0"
              aria-label={`Remove ${v}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onFocus={handleOpen}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={selected.length === 0 ? placeholder : ''}
          disabled={disabled}
          className="flex-1 min-w-[120px] outline-none border-0 bg-transparent text-[13px] text-content-primary placeholder:text-content-tertiary"
        />
        <ChevronDown
          size={14}
          className={`text-content-tertiary flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </div>

      {open && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-border rounded-card shadow-dropdown overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-surface-secondary">
            <div className="flex items-center gap-1.5 text-[11px] text-content-tertiary">
              <Search size={11} />
              <span>
                {options === null
                  ? 'Loading values…'
                  : `${visibleOptions.length} of ${options.length} option${options.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {options && options.length > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const merged = Array.from(new Set([...selected, ...visibleOptions]));
                    onChange(merged);
                  }}
                  className="text-[11px] text-omni-700 hover:underline"
                >
                  Select all in view
                </button>
              )}
              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange([]);
                  }}
                  className="text-[11px] text-content-tertiary hover:text-content-primary"
                >
                  Clear
                </button>
              )}
              {refreshOptions && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void ensureLoaded(true);
                  }}
                  disabled={loading}
                  className="text-content-tertiary hover:text-content-primary disabled:opacity-50"
                  title="Refresh values from Omni"
                >
                  {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCcw size={11} />}
                </button>
              )}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto">
            {loading && options === null && (
              <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-content-tertiary">
                <Loader2 size={12} className="animate-spin" /> Loading values from Omni…
              </div>
            )}
            {error && (
              <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-amber-700 bg-amber-50 border-b border-amber-200">
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <div className="font-medium mb-0.5">Couldn&apos;t load values</div>
                  <div className="leading-snug">{error}</div>
                  {allowFreeText && (
                    <div className="text-[10px] text-amber-600 mt-1">
                      You can still type values manually below.
                    </div>
                  )}
                </div>
              </div>
            )}
            {!loading && options !== null && options.length === 0 && !error && (
              <div className="px-3 py-4 text-[12px] text-content-tertiary">{emptyOptionsHint}</div>
            )}
            {visibleOptions.map((v, idx) => {
              const checked = selected.includes(v);
              const active = idx === highlight;
              return (
                <button
                  key={v}
                  type="button"
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleValue(v);
                  }}
                  aria-pressed={checked}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] border-b border-border/40 last:border-0 transition-all ${
                    checked ? selectedRowClass : active ? 'border-l-4 border-l-omni-300 bg-omni-50' : unselectedRowClass
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                      checked ? 'bg-omni-500 border-omni-500' : 'border-border-strong bg-white'
                    }`}
                  >
                    {checked && (
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 6.5L5 9L9.5 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="truncate text-content-primary">{v}</span>
                  {checked && <CheckCircle2 size={13} className="ml-auto shrink-0 text-omni-700" />}
                </button>
              );
            })}
            {allowFreeText && query.trim() && options !== null && !options.includes(query.trim()) && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  addFreeText(query);
                  setQuery('');
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] text-omni-700 hover:bg-omni-50 border-t border-border"
              >
                <Plus size={12} />
                Use &quot;{query.trim()}&quot; as a custom value
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
