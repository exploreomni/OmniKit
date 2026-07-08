import { useEffect, useRef } from 'react';
import {
  BarChart3,
  FileImage,
  Gauge,
  ImageIcon,
  LayoutDashboard,
  LineChart,
  Loader2,
  PieChart,
  PlayCircle,
  RotateCcw,
  SkipForward,
  Table2,
} from 'lucide-react';
import { StatusChip } from '@/components/ui/StatusChip';
import {
  NATIVE_VISUAL_OPTIONS,
  applyNativeVisualOverride,
  isNumericColumn,
  nativeVisualCompatibility,
  nativeVisualLabel,
  resolveEffectiveRenderKind,
} from '@/services/deckBuilder/nativeVisuals';
import {
  deckOutputDetailsCopy,
  deckOutputContinueLabel,
  deckOutputReadiness,
  deckOutputSourceLabel,
  deckOutputSummary,
  deckRenderButtonLabel,
  type OutputReadinessTone,
} from '@/services/deckBuilder/outputStatus';
import { summarizeTileQuery } from '@/services/deckBuilder/querySummary';
import { mergeVisualSpec, resolveTileVisualSpec, resolveVisualMapping } from '@/services/deckBuilder/visualSpec';
import type {
  DashboardTile,
  NativeVisualOverride,
  RenderStrategy,
  TileColumn,
  TileExportState,
  TileVisualNumberFormat,
  TileVisualSpec,
  TileVisualSource,
} from '@/services/deckBuilder/types';
import { ActualResultPreview } from './SlideLayoutPreview';

type SourceOption = {
  id: TileVisualSource;
  label: string;
  description: string;
  icon: typeof ImageIcon;
};

const TILE_VISUAL_SOURCE_OPTIONS: SourceOption[] = [
  {
    id: 'native',
    label: 'Editable PowerPoint',
    description: 'Editable chart, table, or KPI seeded from Omni metadata when possible.',
    icon: BarChart3,
  },
  {
    id: 'tile-image',
    label: 'Omni PNG',
    description: "Omni's exact rendered tile image.",
    icon: ImageIcon,
  },
  {
    id: 'full-dashboard',
    label: 'Dashboard PNG',
    description: 'Full dashboard screenshot fallback.',
    icon: LayoutDashboard,
  },
  {
    id: 'skip',
    label: 'Skip',
    description: 'Leave this slide out.',
    icon: SkipForward,
  },
];

const NATIVE_VISUAL_ICONS: Record<NativeVisualOverride, typeof BarChart3> = {
  auto: FileImage,
  table: Table2,
  bar: BarChart3,
  stacked_bar: BarChart3,
  line: LineChart,
  area: LineChart,
  pie: PieChart,
  kpi: Gauge,
};

interface DeckOutputStepProps {
  selectedTiles: DashboardTile[];
  activeTileId: string | null;
  onActiveTileChange: (tileId: string) => void;
  renderStrategy: RenderStrategy;
  tileVisualSources: Record<string, TileVisualSource>;
  nativeVisualOverrides: Record<string, NativeVisualOverride>;
  tileVisualSpecs: Record<string, TileVisualSpec>;
  previewStates: Record<string, TileExportState>;
  previewing: boolean;
  previewError: string;
  onRenderTile: (tileId?: string) => void;
  onTileVisualSourceChange: (tileId: string, source: TileVisualSource) => void;
  onNativeVisualOverrideChange: (tileId: string, value: NativeVisualOverride) => void;
  onTileVisualSpecChange: (tileId: string, value: TileVisualSpec | undefined) => void;
  onBack: () => void;
  onContinue: () => void;
}

function resolveTileVisualSource(
  renderStrategy: RenderStrategy,
  tileVisualSources: Record<string, TileVisualSource>,
  tileId: string,
): TileVisualSource {
  return tileVisualSources[tileId] || (
    renderStrategy === 'full-dashboard'
      ? 'full-dashboard'
      : renderStrategy === 'tile-image'
      ? 'tile-image'
      : 'native'
  );
}

function OutputStatusBadge({ readiness }: { readiness: ReturnType<typeof deckOutputReadiness> }) {
  return <StatusChip status={statusForTone(readiness.tone)} label={readiness.label} title={readiness.title || readiness.label} className="max-w-[260px]" />;
}

function statusForTone(tone: OutputReadinessTone): string {
  if (tone === 'ready') return 'success';
  if (tone === 'failed') return 'error';
  if (tone === 'skipped') return 'skipped';
  if (tone === 'running') return 'in_progress';
  return 'pending';
}

type ReadinessBucket = {
  tone: OutputReadinessTone;
  label: string;
  count: number;
  firstTileId?: string;
};

function buildReadinessBuckets({
  selectedTiles,
  renderStrategy,
  tileVisualSources,
  nativeVisualOverrides,
  previewStates,
}: {
  selectedTiles: DashboardTile[];
  renderStrategy: RenderStrategy;
  tileVisualSources: Record<string, TileVisualSource>;
  nativeVisualOverrides: Record<string, NativeVisualOverride>;
  previewStates: Record<string, TileExportState>;
}): ReadinessBucket[] {
  const buckets: ReadinessBucket[] = [
    { tone: 'ready', label: 'ready', count: 0 },
    { tone: 'pending', label: 'needs render', count: 0 },
    { tone: 'failed', label: 'failed', count: 0 },
    { tone: 'running', label: 'rendering', count: 0 },
    { tone: 'skipped', label: 'skipped', count: 0 },
  ];
  const byTone = new Map(buckets.map((bucket) => [bucket.tone, bucket]));

  for (const tile of selectedTiles) {
    const source = resolveTileVisualSource(renderStrategy, tileVisualSources, tile.id);
    const override = nativeVisualOverrides[tile.id] || 'auto';
    const readiness = deckOutputReadiness(source, previewStates[tile.id], override);
    const bucket = byTone.get(readiness.tone);
    if (!bucket) continue;
    bucket.count += 1;
    bucket.firstTileId ||= tile.id;
  }

  return buckets;
}

function RenderedOutput({
  tile,
  source,
  selectedOverride,
  visualSpec,
  previewState,
}: {
  tile: DashboardTile;
  source: TileVisualSource;
  selectedOverride: NativeVisualOverride;
  visualSpec?: TileVisualSpec;
  previewState?: TileExportState;
}) {
  const result = previewState?.result;

  if (previewState?.status === 'failed') {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div>
          <div className="text-sm font-semibold text-red-700">This slide did not render.</div>
          <p className="mt-1 text-xs text-red-600">
            {previewState.error || 'Try another output source or render again.'}
          </p>
        </div>
      </div>
    );
  }

  if (source === 'skip') {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-content-tertiary">
        This tile is skipped and will not appear in the generated deck.
      </div>
    );
  }

  if (source === 'native' && result) {
    const effectiveResult = applyNativeVisualOverride(result, selectedOverride);
    const resolvedSpec = resolveTileVisualSpec(tile, effectiveResult, selectedOverride, visualSpec || effectiveResult.visualSpec);
    return <ActualResultPreview result={effectiveResult} visualSpec={resolvedSpec} />;
  }

  if (previewState?.pngDataUrl) {
    return (
      <img
        src={previewState.pngDataUrl}
        alt={`${tile.name} rendered output`}
        className="h-full w-full rounded object-contain"
      />
    );
  }

  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div>
        <PlayCircle size={28} className="mx-auto text-content-tertiary" />
        <div className="mt-3 text-sm font-semibold text-content-primary">This slide needs a render.</div>
        <p className="mt-1 max-w-sm text-xs text-content-tertiary">
          Choose the output source, render it here, then use Preview for layout, notes, and callouts.
        </p>
      </div>
    </div>
  );
}

function fieldLabel(column: TileColumn): string {
  return column.label || column.name;
}

function SpecConfidenceBadge({ spec }: { spec?: TileVisualSpec }) {
  if (!spec) {
    return <StatusChip status="pending" label="Awaiting render" size="xs" showDot={false} />;
  }
  const status =
    spec.source === 'user'
      ? 'info'
      : spec.source === 'omni' && spec.confidence === 'high'
      ? 'success'
      : spec.confidence === 'unsupported'
      ? 'error'
      : 'warning';
  const label =
    spec.source === 'user'
      ? 'User customized'
      : spec.source === 'omni'
      ? 'Seeded from Omni'
      : spec.confidence === 'unsupported'
      ? 'Unsupported'
      : 'Inferred';
  return <StatusChip status={status} label={label} size="xs" showDot={false} />;
}

export function DeckOutputStep({
  selectedTiles,
  activeTileId,
  onActiveTileChange,
  renderStrategy,
  tileVisualSources,
  nativeVisualOverrides,
  tileVisualSpecs,
  previewStates,
  previewing,
  previewError,
  onRenderTile,
  onTileVisualSourceChange,
  onNativeVisualOverrideChange,
  onTileVisualSpecChange,
  onBack,
  onContinue,
}: DeckOutputStepProps) {
  const slideButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activeTile = selectedTiles.find((tile) => tile.id === activeTileId) || selectedTiles[0];
  const activeIndex = activeTile ? selectedTiles.findIndex((tile) => tile.id === activeTile.id) : -1;
  const largeDeck = selectedTiles.length > 30;
  const source = activeTile
    ? resolveTileVisualSource(renderStrategy, tileVisualSources, activeTile.id)
    : 'native';
  const lastNonNativeSourceRef = useRef<Record<string, TileVisualSource>>({});

  useEffect(() => {
    if (!activeTile?.id) return;
    slideButtonRefs.current[activeTile.id]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTile?.id]);

  useEffect(() => {
    if (!activeTile?.id) return;
    if (source !== 'native' && source !== 'skip') {
      lastNonNativeSourceRef.current[activeTile.id] = source;
    }
  }, [activeTile?.id, source]);

  if (!activeTile) {
    return (
      <div className="card space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-content-primary">Choose and render each tile&apos;s output</h2>
          <p className="text-[11px] text-content-tertiary">Select at least one tile before configuring output.</p>
        </div>
        <button type="button" onClick={onBack} className="btn-ghost btn-sm">
          Back
        </button>
      </div>
    );
  }

  const querySummary = summarizeTileQuery(activeTile);
  const previewState = previewStates[activeTile.id];
  const result = previewState?.result;
  const compatibility = nativeVisualCompatibility(result);
  const selectedOverride = nativeVisualOverrides[activeTile.id] || 'auto';
  const effectiveResult = result ? applyNativeVisualOverride(result, selectedOverride) : null;
  const selectedVisualSpec = tileVisualSpecs[activeTile.id];
  const resolvedSpec = effectiveResult
    ? resolveTileVisualSpec(activeTile, effectiveResult, selectedOverride, selectedVisualSpec || effectiveResult.visualSpec)
    : selectedVisualSpec;
  const visualMapping = effectiveResult ? resolveVisualMapping(effectiveResult, resolvedSpec) : null;
  const effective = result ? resolveEffectiveRenderKind(result, selectedOverride) : null;
  const summary = deckOutputSummary(source, previewState, selectedOverride);
  const readiness = deckOutputReadiness(source, previewState, selectedOverride);
  const renderButtonLabel = deckRenderButtonLabel(source);
  const detailsCopy = deckOutputDetailsCopy(source);
  const previousNonNativeSource = lastNonNativeSourceRef.current[activeTile.id];
  const hasPreviousSlide = activeIndex > 0;
  const hasNextSlide = activeIndex >= 0 && activeIndex < selectedTiles.length - 1;
  const numericColumns = result?.columns.filter(isNumericColumn) || [];
  const dimensionColumns = result?.columns.filter((column) => !isNumericColumn(column)) || [];
  const readinessBuckets = buildReadinessBuckets({
    selectedTiles,
    renderStrategy,
    tileVisualSources,
    nativeVisualOverrides,
    previewStates,
  });
  const readyCount = readinessBuckets.find((bucket) => bucket.tone === 'ready')?.count || 0;
  const actionableCount = readinessBuckets
    .filter((bucket) => bucket.tone === 'pending' || bucket.tone === 'failed' || bucket.tone === 'running')
    .reduce((sum, bucket) => sum + bucket.count, 0);
  const continueLabel = deckOutputContinueLabel({ hasNextSlide, actionableCount });

  function updateVisualSpec(patch: Partial<TileVisualSpec>) {
    if (!effectiveResult) return;
    const base = resolvedSpec || resolveTileVisualSpec(activeTile, effectiveResult, selectedOverride);
    onTileVisualSpecChange(activeTile.id, mergeVisualSpec(base, {
      ...patch,
      source: 'user',
      confidence: 'manual',
    }));
  }

  function resetVisualSpec() {
    onNativeVisualOverrideChange(activeTile.id, 'auto');
    onTileVisualSpecChange(activeTile.id, undefined);
  }

  function focusRailIndex(index: number) {
    const next = selectedTiles[Math.max(0, Math.min(selectedTiles.length - 1, index))];
    if (!next) return;
    onActiveTileChange(next.id);
    window.requestAnimationFrame(() => slideButtonRefs.current[next.id]?.focus());
  }

  return (
    <div className="card space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-content-primary">Choose and render each tile&apos;s output</h2>
          <p className="text-[11px] text-content-tertiary max-w-3xl">
            Pick a slide, choose Native or PNG output, render it here, then use Preview later to review the full deck layout.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onRenderTile()}
          disabled={previewing || selectedTiles.length === 0}
          className="btn-secondary btn-sm flex-shrink-0"
        >
          {previewing ? <Loader2 size={12} className="animate-spin" /> : <PlayCircle size={12} />}
          Render all outputs
        </button>
      </div>

      {previewError && (
        <div className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          {previewError}
        </div>
      )}

      <div className="rounded-card border border-border bg-surface-secondary p-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-tertiary">Output readiness</div>
            <div className="text-sm font-semibold text-content-primary">
              {readyCount} of {selectedTiles.length} slide{selectedTiles.length === 1 ? '' : 's'} ready
            </div>
            <p className="text-[11px] text-content-secondary">
              Jump to a slide state below, render what is missing, then continue to preview the full deck.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {readinessBuckets.map((bucket) => {
              const clickable = Boolean(bucket.firstTileId);
              return (
                <button
                  key={bucket.tone}
                  type="button"
                  onClick={() => bucket.firstTileId && onActiveTileChange(bucket.firstTileId)}
                  disabled={!clickable}
                  className="rounded-full transition disabled:cursor-default disabled:opacity-45"
                  title={clickable ? `Jump to first ${bucket.label} slide` : undefined}
                >
                  <StatusChip status={statusForTone(bucket.tone)} label={`${bucket.count} ${bucket.label}`} size="xs" />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="rounded-card border border-border bg-surface-secondary p-2">
          <div className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wider text-content-tertiary">
            Slides
          </div>
          <div className="space-y-1.5">
            {selectedTiles.map((tile, index) => {
              const rowSource = resolveTileVisualSource(renderStrategy, tileVisualSources, tile.id);
              const rowPreview = previewStates[tile.id];
              const rowOverride = nativeVisualOverrides[tile.id] || 'auto';
              const rowReadiness = deckOutputReadiness(rowSource, rowPreview, rowOverride);
              const selected = tile.id === activeTile.id;
              return (
                <button
                  key={tile.id}
                  ref={(node) => { slideButtonRefs.current[tile.id] = node; }}
                  type="button"
                  onClick={() => onActiveTileChange(tile.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                      event.preventDefault();
                      focusRailIndex(index + 1);
                    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                      event.preventDefault();
                      focusRailIndex(index - 1);
                    } else if (event.key === 'Home') {
                      event.preventDefault();
                      focusRailIndex(0);
                    } else if (event.key === 'End') {
                      event.preventDefault();
                      focusRailIndex(selectedTiles.length - 1);
                    }
                  }}
                  aria-current={selected ? 'step' : undefined}
                  className={`w-full rounded-card border p-2 text-left transition ${
                    selected
                      ? 'border-omni-300 bg-white shadow-sm'
                      : 'border-transparent bg-transparent hover:border-border hover:bg-white'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                        selected ? 'bg-omni-100 text-omni-700' : 'bg-white text-content-tertiary'
                      }`}
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-semibold text-content-primary">{tile.name}</span>
                      {(!largeDeck || selected) && tile.section && <span className="block truncate text-[10px] text-content-tertiary">{tile.section}</span>}
                      {(!largeDeck || selected || rowReadiness.tone !== 'ready') && (
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          <StatusChip status={statusForTone(rowReadiness.tone)} label={rowReadiness.label} title={rowReadiness.title || rowReadiness.label} size="xs" className="max-w-full" />
                        </span>
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-w-0 rounded-card border border-border bg-white p-3 space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-omni-50 text-xs font-semibold text-omni-700">
                  {activeIndex + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-content-primary">{activeTile.name}</h3>
                  <p className="truncate text-xs text-content-tertiary">{summary}</p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {source === 'native' && (
                <label className="flex items-center gap-1.5 text-[11px] font-medium text-content-secondary">
                  Visual
                  <select
                    value={selectedOverride}
                    onChange={(event) => {
                      const next = event.target.value as NativeVisualOverride;
                      onNativeVisualOverrideChange(activeTile.id, next);
                      if (next === 'auto') {
                        onTileVisualSpecChange(activeTile.id, undefined);
                      } else if (effectiveResult) {
                        updateVisualSpec({ renderKind: next });
                      }
                    }}
                    className="input h-8 min-w-[136px] text-[12px]"
                  >
                    {NATIVE_VISUAL_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.shortLabel}</option>
                    ))}
                  </select>
                </label>
              )}
              {source === 'native' && selectedOverride !== 'auto' && (
                <button type="button" onClick={resetVisualSpec} className="btn-ghost btn-sm">
                  <RotateCcw size={12} />
                  Reset to Auto
                </button>
              )}
              {source === 'native' && previousNonNativeSource && (
                <button
                  type="button"
                  onClick={() => onTileVisualSourceChange(activeTile.id, previousNonNativeSource)}
                  className="btn-ghost btn-sm"
                  title={`Return this slide to ${deckOutputSourceLabel(previousNonNativeSource)}.`}
                >
                  <RotateCcw size={12} />
                  Back to {deckOutputSourceLabel(previousNonNativeSource)}
                </button>
              )}
              <OutputStatusBadge readiness={readiness} />
              <button
                type="button"
                onClick={() => onRenderTile(activeTile.id)}
                disabled={previewing || source === 'skip'}
                className="btn-primary btn-sm"
              >
                {previewing ? <Loader2 size={12} className="animate-spin" /> : <PlayCircle size={12} />}
                {renderButtonLabel}
              </button>
            </div>
          </div>

          <div className="rounded-card border border-border bg-surface-secondary p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-content-tertiary">Output preview</div>
                <div className="text-sm font-semibold text-content-primary">{summary}</div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {source !== 'native' && source !== 'skip' && (
                  <button
                    type="button"
                    onClick={() => onTileVisualSourceChange(activeTile.id, 'native')}
                    className="btn-secondary btn-sm"
                    title="Try an editable PowerPoint chart, table, or KPI for this tile."
                  >
                    <BarChart3 size={12} />
                    Try Native editable
                  </button>
                )}
                {source !== 'tile-image' && source !== 'skip' && (
                  <button
                    type="button"
                    onClick={() => onTileVisualSourceChange(activeTile.id, 'tile-image')}
                    className="btn-secondary btn-sm"
                  >
                    <ImageIcon size={12} />
                    Use Omni PNG instead
                  </button>
                )}
              </div>
            </div>
            <div className="h-[360px] overflow-hidden rounded-card border border-border bg-white p-2">
              <RenderedOutput
                tile={activeTile}
                source={source}
                selectedOverride={selectedOverride}
                visualSpec={resolvedSpec}
                previewState={previewState}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-3">
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-content-tertiary">
                  Output source
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-2">
                  {TILE_VISUAL_SOURCE_OPTIONS.map((option) => {
                    const Icon = option.icon;
                    const selected = source === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => onTileVisualSourceChange(activeTile.id, option.id)}
                        className={`rounded-card border p-3 text-left transition ${
                          selected
                            ? 'border-omni-300 bg-omni-50 text-omni-800 shadow-sm'
                            : 'border-border bg-white text-content-secondary hover:border-omni-200'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className={`flex h-8 w-8 items-center justify-center rounded-button ${
                              selected ? 'bg-white text-omni-700' : 'bg-surface-secondary text-content-secondary'
                            }`}
                          >
                            <Icon size={15} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[12px] font-semibold">{option.label}</span>
                            <span className="mt-0.5 block text-[10px] leading-snug text-content-tertiary">
                              {option.description}
                            </span>
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {source === 'native' ? (
                <div className="rounded-card border border-border bg-white p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-content-tertiary">
                        Native visual type
                      </div>
                      <div className="text-[11px] text-content-secondary">
                        Choose an editable PowerPoint shape and render again if you want to compare.
                      </div>
                    </div>
                    {selectedOverride !== 'auto' && (
                      <button
                        type="button"
                        onClick={resetVisualSpec}
                        className="btn-ghost btn-sm"
                      >
                        <RotateCcw size={12} />
                        Reset to Auto
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    {NATIVE_VISUAL_OPTIONS.map((option) => {
                      const state = compatibility[option.id];
                      const selected = selectedOverride === option.id;
                      const incompatible = Boolean(result && !state.supported);
                      const Icon = NATIVE_VISUAL_ICONS[option.id];
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => {
                            onNativeVisualOverrideChange(activeTile.id, option.id);
                            if (option.id === 'auto') {
                              onTileVisualSpecChange(activeTile.id, undefined);
                            } else if (effectiveResult) {
                              updateVisualSpec({ renderKind: option.id });
                            }
                          }}
                          title={state.reason || option.description}
                          className={`rounded-button border px-2.5 py-2 text-left text-[11px] font-medium transition ${
                            selected
                              ? 'border-omni-400 bg-omni-50 text-omni-700'
                              : incompatible
                              ? 'border-border bg-white text-content-tertiary hover:border-amber-200 hover:text-amber-800'
                              : 'border-border bg-white text-content-secondary hover:border-omni-200'
                          }`}
                        >
                          <span className="flex items-center gap-1.5">
                            <Icon size={13} />
                            {option.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {selectedOverride !== 'auto' && effective && !effective.supported && (
                    <p className="mt-2 rounded-card border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800">
                      {effective.reason || 'This visual type is not compatible with the rendered result.'} OmniKit will use {nativeVisualLabel(effective.kind)} for now.
                    </p>
                  )}
                  <div className="mt-3 rounded-card border border-border bg-surface-secondary p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-content-tertiary">
                          Editable visual mapping
                        </div>
                        <div className="text-[11px] text-content-secondary">
                          Tune how OmniKit turns query data into a PowerPoint visual.
                        </div>
                      </div>
                      <SpecConfidenceBadge spec={resolvedSpec} />
                    </div>
                    {!effectiveResult ? (
                      <p className="rounded-card bg-white px-2 py-1.5 text-[11px] text-content-secondary">
                        Render this slide to inspect fields and tune the editable mapping.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {(effective?.kind === 'bar' || effective?.kind === 'stacked_bar' || effective?.kind === 'line' || effective?.kind === 'area' || effective?.kind === 'pie') && (
                          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                            <label className="text-[11px] font-medium text-content-secondary">
                              Category field
                              <select
                                value={resolvedSpec?.categoryField || visualMapping?.categoryColumn?.name || ''}
                                onChange={(event) => updateVisualSpec({ categoryField: event.target.value || undefined })}
                                className="mt-1 input text-[12px]"
                              >
                                {dimensionColumns.concat(numericColumns).map((column) => (
                                  <option key={column.name} value={column.name}>{fieldLabel(column)}</option>
                                ))}
                              </select>
                            </label>
                            <label className="text-[11px] font-medium text-content-secondary">
                              Series field
                              <select
                                value={resolvedSpec?.seriesField || ''}
                                onChange={(event) => updateVisualSpec({ seriesField: event.target.value || undefined })}
                                className="mt-1 input text-[12px]"
                              >
                                <option value="">No series grouping</option>
                                {dimensionColumns.map((column) => (
                                  <option key={column.name} value={column.name}>{fieldLabel(column)}</option>
                                ))}
                              </select>
                            </label>
                          </div>
                        )}
                        {(effective?.kind === 'bar' || effective?.kind === 'stacked_bar' || effective?.kind === 'line' || effective?.kind === 'area' || effective?.kind === 'pie' || effective?.kind === 'kpi') && (
                          <div>
                            <div className="text-[11px] font-medium text-content-secondary">Measure fields</div>
                            <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
                              {numericColumns.map((column) => {
                                const selectedMeasures = resolvedSpec?.measureFields || visualMapping?.measureColumns.map((measure) => measure.name) || [];
                                const checked = selectedMeasures.includes(column.name);
                                return (
                                  <label key={column.name} className="flex items-center gap-2 rounded-card border border-border bg-white px-2 py-1.5 text-[11px] text-content-secondary">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(event) => {
                                        const next = event.target.checked
                                          ? Array.from(new Set([...selectedMeasures, column.name]))
                                          : selectedMeasures.filter((field) => field !== column.name);
                                        updateVisualSpec({ measureFields: next.length > 0 ? next : undefined });
                                      }}
                                      className="rounded border-border text-omni-600 focus:ring-omni-500"
                                    />
                                    <span className="truncate">{fieldLabel(column)}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
                          <label className="text-[11px] font-medium text-content-secondary">
                            Sort by
                            <select
                              value={resolvedSpec?.sort?.field || ''}
                              onChange={(event) => updateVisualSpec({
                                sort: event.target.value
                                  ? { field: event.target.value, direction: resolvedSpec?.sort?.direction || 'desc' }
                                  : undefined,
                              })}
                              className="mt-1 input text-[12px]"
                            >
                              <option value="">Keep query order</option>
                              {(result?.columns || []).map((column) => (
                                <option key={column.name} value={column.name}>{fieldLabel(column)}</option>
                              ))}
                            </select>
                          </label>
                          <label className="text-[11px] font-medium text-content-secondary">
                            Direction
                            <select
                              value={resolvedSpec?.sort?.direction || 'desc'}
                              onChange={(event) => {
                                const field = resolvedSpec?.sort?.field || visualMapping?.measureColumns[0]?.name || '';
                                updateVisualSpec({
                                  sort: field
                                    ? { field, direction: event.target.value === 'asc' ? 'asc' : 'desc' }
                                    : undefined,
                                });
                              }}
                              className="mt-1 input text-[12px]"
                            >
                              <option value="desc">Descending</option>
                              <option value="asc">Ascending</option>
                            </select>
                          </label>
                          <label className="text-[11px] font-medium text-content-secondary">
                            Top N
                            <input
                              type="number"
                              min={1}
                              max={500}
                              value={resolvedSpec?.limit || ''}
                              onChange={(event) => updateVisualSpec({ limit: event.target.value ? Number(event.target.value) : undefined })}
                              placeholder="All rows"
                              className="mt-1 input text-[12px]"
                            />
                          </label>
                        </div>
                        <label className="block text-[11px] font-medium text-content-secondary">
                          Number format
                          <select
                            value={resolvedSpec?.numberFormat || 'auto'}
                            onChange={(event) => updateVisualSpec({ numberFormat: event.target.value as TileVisualNumberFormat })}
                            className="mt-1 input text-[12px]"
                          >
                            <option value="auto">Auto</option>
                            <option value="currency">Currency</option>
                            <option value="percent">Percent</option>
                            <option value="integer">Integer</option>
                            <option value="decimal">Decimal</option>
                          </select>
                        </label>
                        {visualMapping?.warnings.length ? (
                          <div className="space-y-1">
                            {visualMapping.warnings.slice(0, 3).map((warning) => (
                              <p key={warning} className="rounded-card border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800">
                                {warning}
                              </p>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="rounded-card border border-blue-100 bg-blue-50 px-3 py-2 text-[11px] text-blue-800">
                  <div className="font-semibold">Editable Native output may be available for this tile.</div>
                  <p className="mt-0.5">
                    This slide currently uses {deckOutputSourceLabel(source)}. Try Native editable to compare an editable PowerPoint visual, then switch back if the PNG is a better fit.
                  </p>
                  {source !== 'skip' && (
                    <button
                      type="button"
                      onClick={() => onTileVisualSourceChange(activeTile.id, 'native')}
                      className="btn-ghost btn-sm mt-2"
                    >
                      <BarChart3 size={12} />
                      Try editable Native output
                    </button>
                  )}
                </div>
              )}
            </div>

            <details className="rounded-card border border-border bg-surface-secondary p-3 text-[11px]">
              <summary className="cursor-pointer font-semibold text-content-secondary">
                Query details
              </summary>
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">{detailsCopy.eyebrow}</div>
                    <div className="text-[12px] font-semibold text-content-primary">
                      {querySummary.kind === 'query' ? detailsCopy.title : querySummary.kind === 'markdown' ? 'Text tile' : 'No reusable query detected'}
                    </div>
                  </div>
                  {querySummary.queryPath && (
                    <span className="rounded-full bg-white px-2 py-1 text-[10px] font-medium text-content-secondary">
                      {querySummary.queryPath}
                    </span>
                  )}
                </div>

                {querySummary.message ? (
                  <p className="text-[12px] text-content-secondary">{querySummary.message}</p>
                ) : (
                  <div className="grid grid-cols-1 gap-2">
                    <p className="rounded-card bg-white px-2 py-1.5 text-[11px] text-content-secondary">
                      {detailsCopy.helper}
                    </p>
                    <div className="rounded-card bg-white p-2">
                      <span className="font-medium text-content-secondary">Model</span>
                      <div className="mt-0.5 break-all text-content-primary">{querySummary.modelId || 'Not listed in query'}</div>
                    </div>
                    <div className="rounded-card bg-white p-2">
                      <span className="font-medium text-content-secondary">Topic</span>
                      <div className="mt-0.5 break-all text-content-primary">{querySummary.topic || 'Not listed in query'}</div>
                    </div>
                    <div className="rounded-card bg-white p-2">
                      <span className="font-medium text-content-secondary">Fields</span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {querySummary.fields.length > 0
                          ? querySummary.fields.slice(0, 12).map((field) => (
                              <span key={field} className="rounded-full bg-surface-secondary px-2 py-0.5 text-content-secondary">
                                {field}
                              </span>
                            ))
                          : <span className="text-content-tertiary">No fields listed</span>}
                        {querySummary.fields.length > 12 && (
                          <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-content-tertiary">
                            +{querySummary.fields.length - 12} more
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-1">
                      <div className="rounded-card bg-white p-2">
                        <span className="font-medium text-content-secondary">Filters</span>
                        <div className="mt-1 space-y-0.5 text-content-primary">
                          {querySummary.filters.length > 0 ? querySummary.filters.slice(0, 4).map((filter) => <div key={filter} className="truncate">{filter}</div>) : <span className="text-content-tertiary">None</span>}
                        </div>
                      </div>
                      <div className="rounded-card bg-white p-2">
                        <span className="font-medium text-content-secondary">Sorts / limit</span>
                        <div className="mt-1 space-y-0.5 text-content-primary">
                          {querySummary.sorts.length > 0 ? querySummary.sorts.slice(0, 4).map((sort) => <div key={sort} className="truncate">{sort}</div>) : <span className="text-content-tertiary">No sorts</span>}
                          {querySummary.limit && <div className="text-content-tertiary">Limit {querySummary.limit}</div>}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {querySummary.advancedJson && (
                  <details className="rounded-card border border-border bg-white p-2">
                    <summary className="cursor-pointer font-medium text-content-secondary">Technical details</summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-3 font-mono text-[10px] leading-snug text-slate-100">
                      {querySummary.advancedJson}
                    </pre>
                  </details>
                )}
              </div>
            </details>
          </div>
        </section>
      </div>

      <div className="flex justify-between items-center pt-3 border-t border-border">
        <button onClick={onBack} className="btn-ghost btn-sm">
          {hasPreviousSlide ? 'Previous slide' : 'Back to branding'}
        </button>
        <button
          onClick={onContinue}
          className="btn-primary"
          title={!hasNextSlide && actionableCount > 0 ? 'You can still preview, but some slides may need render attention.' : undefined}
        >
          {continueLabel}
        </button>
      </div>
    </div>
  );
}
