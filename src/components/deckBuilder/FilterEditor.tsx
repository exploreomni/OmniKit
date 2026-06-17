import { useMemo, useState } from 'react';
import { Save, RotateCcw, Plus, X, Link2, Eraser } from 'lucide-react';
import type { DashboardFilter, DashboardTile, FilterOverride, TopicFieldRef } from '@/services/deckBuilder/types';
import type { SavedFilterSet } from '@/services/deckBuilder/localCache';
import { normalizeFilterType } from '@/services/deckBuilder/queryRunner';
import { MultiSelectCombo } from './MultiSelectCombo';

interface Props {
  filters: DashboardFilter[];
  topicFields: TopicFieldRef[];
  overrides: Record<string, FilterOverride>;
  dashboardDefaults?: Record<string, FilterOverride>;
  selectedTiles?: DashboardTile[];
  onChange: (next: Record<string, FilterOverride>) => void;
  savedSets: SavedFilterSet[];
  onSaveSet: (name: string) => void;
  onLoadSet: (set: SavedFilterSet) => void;
  onReset: () => void;
  onClearAll?: () => void;
  loadFieldOptions: (field: string) => Promise<string[]>;
  refreshFieldOptions: (field: string) => Promise<string[]>;
}

function valuesEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  const sa = a.map((v) => String(v)).sort();
  const sb = b.map((v) => String(v)).sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function valuesToStrings(values: unknown[]): string[] {
  return values.map((v) => (v == null ? '' : String(v))).filter((v) => v !== '');
}

function tileMentionsField(tile: DashboardTile, field: string): boolean {
  if (!tile.rawQuery) return false;
  const candidates = new Set([
    field,
    field.split('.').pop() || field,
    field.replace(/\./g, '_'),
  ].filter(Boolean));
  const raw = JSON.stringify(tile.rawQuery).toLowerCase();
  return Array.from(candidates).some((candidate) => raw.includes(candidate.toLowerCase()));
}

function impactLabel(filter: DashboardFilter, selectedTiles: DashboardTile[] | undefined): string {
  const total = selectedTiles?.length || 0;
  if (total === 0) return 'No selected slide exports yet';
  const exactMatches = selectedTiles?.filter((tile) => tileMentionsField(tile, filter.field)).length || 0;
  if (exactMatches > 0) {
    return `Affects ${exactMatches}/${total} selected slide export${total === 1 ? '' : 's'}`;
  }
  if (filter.source === 'topic' || filter.source === 'tile' || filter.topic || filter.view) {
    return `May affect up to ${total} selected slide export${total === 1 ? '' : 's'}`;
  }
  return `Applies to ${total} selected slide export${total === 1 ? '' : 's'}`;
}

export function FilterEditor({
  filters,
  topicFields,
  overrides,
  dashboardDefaults,
  selectedTiles,
  onChange,
  savedSets,
  onSaveSet,
  onLoadSet,
  onReset,
  onClearAll,
  loadFieldOptions,
  refreshFieldOptions,
}: Props) {
  const defaults = dashboardDefaults ?? {};
  const inheritedActiveCount = Object.keys(defaults).filter((field) => {
    const cur = overrides[field];
    if (!cur) return false;
    return valuesEqual(cur.values ?? [], defaults[field].values ?? []);
  }).length;
  const [newSetName, setNewSetName] = useState('');
  const [extraFields, setExtraFields] = useState<DashboardFilter[]>([]);
  const [addPickerOpen, setAddPickerOpen] = useState(false);

  const visibleFilters = useMemo<DashboardFilter[]>(() => {
    const seen = new Set(filters.map((f) => f.field));
    const merged = [...filters];
    for (const ef of extraFields) {
      if (!seen.has(ef.field)) {
        merged.push(ef);
        seen.add(ef.field);
      }
    }
    return merged;
  }, [filters, extraFields]);

  const availableTopicAdditions = useMemo(() => {
    const present = new Set(visibleFilters.map((f) => f.field));
    return topicFields.filter((f) => !present.has(f.field));
  }, [topicFields, visibleFilters]);

  const noFilters = visibleFilters.length === 0 && availableTopicAdditions.length === 0;

  if (noFilters) {
    return (
      <div className="text-xs text-content-tertiary p-4 bg-surface-secondary rounded-card">
        This dashboard has no filters that we can detect. Tile queries will run with their default filter values.
      </div>
    );
  }

  const updateField = (filter: DashboardFilter, override: FilterOverride | null) => {
    const next = { ...overrides };
    if (override === null) {
      delete next[filter.field];
    } else {
      next[filter.field] = override;
    }
    onChange(next);
  };

  const setValuesFor = (filter: DashboardFilter, values: string[]) => {
    if (values.length === 0 && !overrides[filter.field]) return;
    updateField(filter, {
      field: filter.field,
      kind: filter.kind,
      type: normalizeFilterType(filter.type),
      values,
      isNegative: overrides[filter.field]?.isNegative ?? filter.isNegative,
    });
  };

  return (
    <div className="space-y-4">
      {inheritedActiveCount > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-card border border-border bg-surface-secondary">
          <Link2 size={14} className="mt-0.5 text-omni-700 flex-shrink-0" />
          <div className="flex-1 text-[12px] text-content-secondary leading-snug">
            <span className="font-medium text-content-primary">{inheritedActiveCount}</span> filter
            {inheritedActiveCount === 1 ? '' : 's'} inherited from the source dashboard. Tiles will
            run with the same values you see live unless you change them below.
          </div>
          {onClearAll && (
            <button
              type="button"
              onClick={onClearAll}
              className="btn-ghost btn-sm flex-shrink-0"
              title="Remove all filter overrides (run tiles with their built-in defaults)"
            >
              <Eraser size={11} /> Clear
            </button>
          )}
        </div>
      )}

      {savedSets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-card bg-surface-secondary border border-border">
          <span className="text-[11px] font-medium text-content-secondary">Saved sets:</span>
          {savedSets.map((set) => (
            <button
              key={set.id}
              type="button"
              onClick={() => onLoadSet(set)}
              className="btn-ghost btn-sm"
            >
              {set.name}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2.5">
        {visibleFilters.map((filter) => {
          const current = overrides[filter.field] ?? null;
          const values = current
            ? valuesToStrings(current.values)
            : valuesToStrings(filter.values);
          const inherited = defaults[filter.field];
          const matchesInherited = Boolean(
            current && inherited && valuesEqual(current.values ?? [], inherited.values ?? []),
          );
          const isUserEdited = Boolean(current) && !matchesInherited;
          const label = filter.label || filter.field;
          return (
            <div
              key={filter.field}
              className={`p-3 rounded-card border bg-white ${
                isUserEdited ? 'border-omni-400' : matchesInherited ? 'border-omni-200/70' : 'border-border'
              }`}
            >
              <div className="flex items-center justify-between mb-2 gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="text-[13px] font-semibold text-content-primary truncate" title={filter.field}>
                      {label}
                    </div>
                    {matchesInherited && (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0"
                        style={{ background: 'rgba(255,71,148,0.12)', color: '#9B3065' }}
                        title="Value inherited from the source dashboard"
                      >
                        <Link2 size={9} /> from dashboard
                      </span>
                    )}
                    {isUserEdited && (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0"
                        style={{ background: 'rgba(200,24,106,0.14)', color: '#C8186A' }}
                      >
                        edited
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-content-tertiary uppercase tracking-wider truncate">
                    {filter.field} · {filter.kind || 'EQUALS'} · {filter.type || 'string'}
                  </div>
                  <div className="text-[10px] text-content-tertiary truncate">
                    {impactLabel(filter, selectedTiles)}
                  </div>
                </div>
                {isUserEdited && inherited && (
                  <button
                    type="button"
                    onClick={() => updateField(filter, inherited)}
                    className="btn-ghost btn-sm text-[11px] flex-shrink-0"
                    title="Restore the value used on the source dashboard"
                  >
                    <RotateCcw size={11} /> Restore
                  </button>
                )}
                {isUserEdited && !inherited && (
                  <button
                    type="button"
                    onClick={() => updateField(filter, null)}
                    className="btn-ghost btn-sm text-[11px] flex-shrink-0"
                    title="Clear override"
                  >
                    <RotateCcw size={11} /> Clear
                  </button>
                )}
              </div>

              <MultiSelectCombo
                selected={values}
                onChange={(next) => setValuesFor(filter, next)}
                loadOptions={() => loadFieldOptions(filter.field)}
                refreshOptions={() => refreshFieldOptions(filter.field)}
                placeholder={`Search values for ${label}…`}
                emptyOptionsHint="No values available — type to add manually."
              />
            </div>
          );
        })}
      </div>

      {availableTopicAdditions.length > 0 && (
        <div className="pt-3 border-t border-border">
          {!addPickerOpen ? (
            <button
              type="button"
              onClick={() => setAddPickerOpen(true)}
              className="btn-ghost btn-sm"
            >
              <Plus size={12} /> Add filter from topic ({availableTopicAdditions.length} field{availableTopicAdditions.length === 1 ? '' : 's'})
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <select
                onChange={(e) => {
                  const field = e.target.value;
                  if (!field) return;
                  const meta = availableTopicAdditions.find((f) => f.field === field);
                  if (!meta) return;
                  setExtraFields((prev) => [
                    ...prev,
                    {
                      field: meta.field,
                      label: `${meta.view} · ${meta.label}`,
                      kind: 'EQUALS',
                      type: normalizeFilterType(meta.dataType),
                      values: [],
                      modelId: meta.modelId,
                      topic: meta.topic,
                      view: meta.view,
                      dataType: meta.dataType,
                      source: 'topic',
                    },
                  ]);
                  setAddPickerOpen(false);
                  e.currentTarget.value = '';
                }}
                className="input-field flex-1"
                defaultValue=""
              >
                <option value="">Select a field…</option>
                {Object.entries(
                  availableTopicAdditions.reduce<Record<string, TopicFieldRef[]>>((acc, f) => {
                    const key = `${f.topic} · ${f.view}`;
                    (acc[key] ||= []).push(f);
                    return acc;
                  }, {})
                ).map(([groupLabel, items]) => (
                  <optgroup key={groupLabel} label={groupLabel}>
                    {items.map((f) => (
                      <option key={f.field} value={f.field}>
                        {f.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setAddPickerOpen(false)}
                className="btn-ghost btn-sm"
              >
                <X size={12} /> Cancel
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-border">
        <input
          value={newSetName}
          onChange={(e) => setNewSetName(e.target.value)}
          placeholder="Name this filter set…"
          className="input-field flex-1 min-w-0"
        />
        <button
          type="button"
          onClick={() => {
            if (newSetName.trim()) {
              onSaveSet(newSetName.trim());
              setNewSetName('');
            }
          }}
          disabled={!newSetName.trim() || Object.keys(overrides).length === 0}
          className="btn-secondary"
        >
          <Save size={13} /> Save set
        </button>
        <button
          type="button"
          onClick={onReset}
          className="btn-ghost btn-sm"
          title={
            Object.keys(defaults).length > 0
              ? 'Restore the dashboard defaults'
              : 'Clear all overrides'
          }
        >
          <RotateCcw size={12} />
          {Object.keys(defaults).length > 0 ? 'Restore defaults' : 'Reset all'}
        </button>
      </div>
    </div>
  );
}
