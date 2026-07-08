import { Layers, Loader2, RefreshCcw, AlertTriangle } from 'lucide-react';
import { useMemo } from 'react';
import type { DashboardFilter, TopicFieldRef } from '@/services/deckBuilder/types';
import { MultiSelectCombo } from './MultiSelectCombo';

interface FieldOption {
  field: string;
  label: string;
  groupKey: string;
  groupLabel: string;
  caption?: string;
}

interface Props {
  filters: DashboardFilter[];
  topicFields: TopicFieldRef[];
  topicCatalogLoading: boolean;
  topicCatalogError: string | null;
  onRefreshCatalog: () => void;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  filterField: string | null;
  onFilterFieldChange: (field: string | null) => void;
  values: string[];
  onValuesChange: (vals: string[]) => void;
  loadFieldOptions: (field: string) => Promise<string[]>;
  refreshFieldOptions: (field: string) => Promise<string[]>;
}

export function BatchSetup({
  filters,
  topicFields,
  topicCatalogLoading,
  topicCatalogError,
  onRefreshCatalog,
  enabled,
  onEnabledChange,
  filterField,
  onFilterFieldChange,
  values,
  onValuesChange,
  loadFieldOptions,
  refreshFieldOptions,
}: Props) {
  const groupedOptions = useMemo<FieldOption[]>(() => {
    const seen = new Set<string>();
    const out: FieldOption[] = [];
    for (const f of filters) {
      if (seen.has(f.field)) continue;
      seen.add(f.field);
      out.push({
        field: f.field,
        label: f.label || f.field,
        groupKey: 'dashboard',
        groupLabel: 'Dashboard filters',
        caption: f.field,
      });
    }
    for (const f of topicFields) {
      if (seen.has(f.field)) continue;
      seen.add(f.field);
      out.push({
        field: f.field,
        label: f.label,
        groupKey: `topic:${f.topic}:${f.view}`,
        groupLabel: `${f.topic} · ${f.view}`,
        caption: f.field,
      });
    }
    return out;
  }, [filters, topicFields]);

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; items: FieldOption[] }>();
    for (const opt of groupedOptions) {
      const existing = map.get(opt.groupKey);
      if (existing) existing.items.push(opt);
      else map.set(opt.groupKey, { label: opt.groupLabel, items: [opt] });
    }
    return Array.from(map.entries()).map(([key, v]) => ({ key, ...v }));
  }, [groupedOptions]);

  const activeOption = groupedOptions.find((g) => g.field === filterField) || null;
  const activeLabel = activeOption?.label || filterField || 'value';

  return (
    <div className="rounded-card border border-border bg-white p-4 space-y-3">
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
          className="mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Layers size={14} className="text-omni-600" />
            <span className="text-[13px] font-semibold text-content-primary">
              Batch mode: one deck per client
            </span>
          </div>
	          <p className="text-[11px] text-content-tertiary mt-0.5">
	            Pick a filter (e.g. Account Name) and a list of values. We&apos;ll generate one deck per
	            value and bundle them in a zip.
	          </p>
	          {enabled && (
	            <p className="mt-1 text-[10px] text-content-tertiary">
	              AI insights reflect the preview filter values, not each generated batch value.
	            </p>
	          )}
	        </div>
	      </label>

      {enabled && (
        <div className="space-y-3 pl-7">
          {groupedOptions.length === 0 && !topicCatalogLoading ? (
            <div className="text-[11px] text-content-tertiary p-3 bg-surface-secondary rounded-card">
              No filterable fields detected on this dashboard or its topic. Try refreshing the schema.
              <button
                type="button"
                onClick={onRefreshCatalog}
                className="ml-2 text-omni-700 hover:underline"
              >
                Refresh schema
              </button>
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="block text-[11px] font-medium text-content-secondary">
                    Batch dimension
                  </label>
                  <button
                    type="button"
                    onClick={onRefreshCatalog}
                    disabled={topicCatalogLoading}
                    className="text-[10px] text-content-tertiary hover:text-content-primary inline-flex items-center gap-1"
                    title="Refresh topic schema"
                  >
                    {topicCatalogLoading ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <RefreshCcw size={10} />
                    )}
                    Refresh schema
                  </button>
                </div>
                <select
                  value={filterField ?? ''}
                  onChange={(e) => {
                    const next = e.target.value || null;
                    if (next !== filterField) {
                      onValuesChange([]);
                    }
                    onFilterFieldChange(next);
                  }}
                  className="input-field"
                >
                  <option value="">
                    {topicCatalogLoading
                      ? 'Loading topic fields…'
                      : `Select a field… (${groupedOptions.length} available)`}
                  </option>
                  {groups.map((g) => (
                    <optgroup key={g.key} label={g.label}>
                      {g.items.map((opt) => (
                        <option key={opt.field} value={opt.field}>
                          {opt.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {activeOption && activeOption.caption && (
                  <div className="text-[10px] text-content-tertiary mt-1 truncate">
                    Field: <code>{activeOption.caption}</code> · {activeOption.groupLabel}
                  </div>
                )}
                {topicCatalogError && (
                  <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                    <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                    <span>Topic schema warning: {topicCatalogError}</span>
                  </div>
                )}
              </div>

              {filterField && (
                <div>
                  <label className="block text-[11px] font-medium text-content-secondary mb-1">
                    Values ({values.length})
                  </label>
                  <MultiSelectCombo
                    key={filterField}
                    selected={values}
                    onChange={onValuesChange}
                    loadOptions={() => loadFieldOptions(filterField)}
                    refreshOptions={() => refreshFieldOptions(filterField)}
                    placeholder={`Search ${activeLabel} values…`}
                    emptyOptionsHint="No values returned — paste or type clients manually."
                    onPasteBulk={(parts) => {
                      const merged = Array.from(new Set([...values, ...parts]));
                      onValuesChange(merged);
                    }}
                  />
                  <p className="text-[10px] text-content-tertiary mt-1.5">
                    {values.length === 0
                      ? 'Pick from the dropdown or paste a comma- / newline-separated list.'
                      : `${values.length} deck${values.length === 1 ? '' : 's'} will be generated.`}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
