import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowUpRight,
  BarChart3,
  CaseSensitive,
  Image as ImageIcon,
  Maximize2,
  Minus,
  Move,
  RotateCcw,
  Shapes,
  Square,
  StickyNote,
  Table2,
  Type,
} from 'lucide-react';
import { layoutForRole } from '@/services/deckBuilder/templateStore';
import type {
  BrandConfig,
  DashboardTile,
  LayoutKit,
  SlideBox,
  SlideFitMode,
  SlideOverlay,
  SlideOverlayType,
  SlideOverride,
  TileExportState,
  TileResult,
  TileVisualSource,
} from '@/services/deckBuilder/types';

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const GRID = 0.05;

interface Props {
  tiles: DashboardTile[];
  template: LayoutKit;
  brand: BrandConfig;
  overrides: Record<string, SlideOverride>;
  onChange: (next: Record<string, SlideOverride>) => void;
  insights: Record<string, string>;
  onInsightsChange: (next: Record<string, string>) => void;
  includeAppendix: boolean;
  onIncludeAppendixChange: (value: boolean) => void;
  tileVisualSources: Record<string, TileVisualSource>;
  renderStrategy: 'native' | 'tile-image' | 'full-dashboard';
  onApplyVisualSourceToAll: (strategy: 'native' | 'tile-image' | 'full-dashboard') => void;
  onTileVisualSourceChange: (tileId: string, source: TileVisualSource) => void;
  previewStates: Record<string, TileExportState>;
  previewing: boolean;
  previewError: string;
  previewSampleLabel?: string;
  onRenderPreview: (tileId: string) => void;
}

type DragMode = 'move' | 'resize';

interface DragState {
  tileId: string;
  target: 'body' | 'insight' | 'overlay';
  overlayId?: string;
  mode: DragMode;
  pointerId: number;
  startX: number;
  startY: number;
  startBox: SlideBox;
}

function hex(input: string | undefined): string {
  return `#${(input || 'FFFFFF').replace(/^#/, '')}`;
}

function round(n: number): number {
  return Math.round(n / GRID) * GRID;
}

function clampBox(box: SlideBox): SlideBox {
  const minW = 1;
  const minH = 0.8;
  const w = Math.min(SLIDE_W, Math.max(minW, round(box.w)));
  const h = Math.min(SLIDE_H, Math.max(minH, round(box.h)));
  const x = Math.min(SLIDE_W - w, Math.max(0, round(box.x)));
  const y = Math.min(SLIDE_H - h, Math.max(0, round(box.y)));
  return { x, y, w, h };
}

function sameBox(a: SlideBox | undefined, b: SlideBox): boolean {
  if (!a) return false;
  return ['x', 'y', 'w', 'h'].every((key) => Math.abs(a[key as keyof SlideBox] - b[key as keyof SlideBox]) < 0.001);
}

function boxStyle(box: SlideBox): CSSProperties {
  return {
    left: `${(box.x / SLIDE_W) * 100}%`,
    top: `${(box.y / SLIDE_H) * 100}%`,
    width: `${(box.w / SLIDE_W) * 100}%`,
    height: `${(box.h / SLIDE_H) * 100}%`,
  };
}

function overlayRotation(overlay: SlideOverlay): number {
  return Number.isFinite(overlay.rotation) ? overlay.rotation || 0 : 0;
}

function upsertOverride(
  overrides: Record<string, SlideOverride>,
  tileId: string,
  patch: Partial<SlideOverride>,
): Record<string, SlideOverride> {
  const next = { ...overrides, [tileId]: { ...(overrides[tileId] || {}), ...patch } };
  const value = next[tileId];
  if (
    !value.title &&
    !value.bodyBox &&
    !value.insightBox &&
    !value.insightFormat &&
    !value.fit &&
    !value.speakerNotes &&
    !value.speakerNotesFormat &&
    (!value.overlays || value.overlays.length === 0)
  ) {
    delete next[tileId];
  }
  return next;
}

function insightDefaultBox(body: SlideBox, layoutHasPanel: boolean): SlideBox {
  if (layoutHasPanel) {
    const x = body.x + body.w + 0.3;
    if (x < SLIDE_W - 1.9) {
      return clampBox({ x, y: body.y, w: Math.max(1.6, SLIDE_W - x - 0.5), h: body.h });
    }
  }
  return clampBox({ x: 0.6, y: SLIDE_H - 1.8, w: SLIDE_W - 1.2, h: 1.25 });
}

function normalizeInsightLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^[•*-]\s*/, '').trim())
    .filter(Boolean);
}

function estimateWrappedLineCount(text: string, widthIn: number, fontSize: number): number {
  const charsPerLine = Math.max(10, Math.floor((Math.max(0.4, widthIn) * 144) / Math.max(1, fontSize)));
  return text
    .split('\n')
    .map((line) => Math.max(1, Math.ceil(Math.max(1, line.trim().length) / charsPerLine)))
    .reduce((sum, lines) => sum + lines, 0);
}

function fitInsightFontSize(text: string, widthIn: number, heightIn: number): number {
  if (!text.trim()) return 9;
  for (let fontSize = 10; fontSize >= 7; fontSize -= 0.5) {
    const lines = estimateWrappedLineCount(text, widthIn, fontSize);
    const neededPoints = lines * fontSize * 1.18;
    if (neededPoints <= Math.max(0.2, heightIn) * 72) return fontSize;
  }
  return 7;
}

function overlayDefaults(type: SlideOverlayType, brand: BrandConfig): SlideOverlay {
  const id = `overlay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  if (type === 'arrow') {
    return { id, type, x: 7.0, y: 3.1, w: 1.0, h: 1.0, rotation: -25, color: brand.accentColor };
  }
  if (type === 'line') {
    return { id, type, x: 6.9, y: 3.3, w: 1.5, h: 0.12, rotation: 0, color: brand.accentColor };
  }
  if (type === 'box') {
    return { id, type, x: 6.6, y: 1.35, w: 2.2, h: 0.85, color: brand.accentColor };
  }
  if (type === 'symbol') {
    return { id, type, x: 8.35, y: 1.4, w: 0.65, h: 0.65, text: '!', color: brand.accentColor };
  }
  return { id, type, x: 6.7, y: 1.4, w: 2.2, h: 0.7, text: 'Key takeaway', color: brand.primaryColor };
}

function visualSourceFor(
  tile: DashboardTile,
  tileVisualSources: Record<string, TileVisualSource>,
  renderStrategy: Props['renderStrategy'],
): TileVisualSource {
  return tileVisualSources[tile.id] || (renderStrategy === 'full-dashboard' ? 'full-dashboard' : renderStrategy === 'tile-image' ? 'tile-image' : 'native');
}

function sourceLabel(source: TileVisualSource): string {
  if (source === 'tile-image') return 'Omni image';
  if (source === 'full-dashboard') return 'Dashboard';
  if (source === 'skip') return 'Skipped';
  return 'Native';
}

function tileKindLabel(tile: DashboardTile): string {
  const raw = tile.tileType || '';
  if (/table/i.test(raw)) return 'Table';
  if (/markdown|text/i.test(raw)) return 'Text';
  if (/map/i.test(raw)) return 'Map';
  if (/single|kpi|score/i.test(raw)) return 'KPI';
  if (/bar|line|area|pie|scatter|chart|vis/i.test(raw)) return 'Chart';
  return 'Visualization';
}

function TileMock({
  tile,
  source,
  fit,
}: {
  tile: DashboardTile;
  source: TileVisualSource;
  fit: SlideFitMode;
}) {
  const label = source === 'native' ? tileKindLabel(tile) : source === 'full-dashboard' ? 'Full dashboard image' : 'Omni image';
  if (source === 'skip') {
    return (
      <div className="w-full h-full grid place-items-center rounded-[4px] border border-slate-300 bg-slate-50 p-3 text-center text-[10px] text-slate-500">
        Skipped in output
      </div>
    );
  }
  const isImage = source === 'tile-image' || source === 'full-dashboard';
  const isTable = source === 'native' && label === 'Table';

  if (isTable) {
    return (
      <div className="w-full h-full bg-white rounded-[4px] border border-slate-300 overflow-hidden">
        <div className="h-[16%] bg-slate-700 flex items-center px-2 text-white text-[9px] font-semibold">
          <Table2 size={12} className="mr-1.5" /> {tile.name}
        </div>
        {Array.from({ length: 5 }).map((_, row) => (
          <div key={row} className={`grid grid-cols-4 h-[16.8%] ${row % 2 ? 'bg-slate-50' : 'bg-white'}`}>
            {Array.from({ length: 4 }).map((__, col) => (
              <div key={col} className="border-r border-b border-slate-200 px-1 py-0.5">
                <div className="h-1.5 rounded bg-slate-300" style={{ width: `${45 + ((row + col) % 4) * 13}%` }} />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (isImage) {
    const objectFit = fit === 'stretch' ? 'fill' : fit;
    return (
      <div className="relative w-full h-full bg-slate-100 rounded-[4px] border border-slate-300 overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(135deg, rgba(200,24,106,0.22) 0%, rgba(255,71,148,0.14) 35%, rgba(16,185,129,0.16) 100%)',
            objectFit,
          }}
        />
        <div className={`absolute ${fit === 'contain' ? 'inset-[12%]' : 'inset-0'} border border-white bg-white`} />
        <div className="absolute inset-0 grid place-items-center text-center px-2">
          <div className="text-[10px] font-semibold text-slate-700 bg-white border border-white rounded px-2 py-1">
            <ImageIcon size={13} className="inline mr-1" /> {label} · {fit}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-white rounded-[4px] border border-slate-300 overflow-hidden p-2">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[10px] font-semibold text-slate-700 truncate">{label}</div>
        <BarChart3 size={14} className="text-omni-600 flex-shrink-0" />
      </div>
      <div className="h-[74%] flex items-end gap-[4%] px-[4%] border-l border-b border-slate-300">
        {[58, 34, 72, 46, 88, 63].map((height, idx) => (
          <div
            key={idx}
            className="flex-1 rounded-t"
            style={{
              height: `${height}%`,
              background: idx % 2 ? 'rgba(255,71,148,0.72)' : 'rgba(200,24,106,0.82)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

function formatPreviewCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : String(Number(value.toFixed(2)));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value);
  return s.length > 28 ? `${s.slice(0, 25)}...` : s;
}

function ActualResultPreview({ result }: { result: TileResult }) {
  if (result.rows.length === 0 || result.renderKind === 'empty') {
    return (
      <div className="w-full h-full grid place-items-center rounded-[4px] border border-slate-300 bg-white text-[11px] text-slate-500">
        No data returned
      </div>
    );
  }

  if (result.renderKind === 'table' || result.columns.length > 3) {
    const cols = result.columns.slice(0, 4);
    const rows = result.rows.slice(0, 5);
    return (
      <div className="w-full h-full bg-white rounded-[4px] border border-slate-300 overflow-hidden text-[8px]">
        <div className="grid" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
          {cols.map((col) => (
            <div key={col.name} className="bg-slate-700 text-white font-semibold px-1 py-1 truncate">
              {col.label || col.name}
            </div>
          ))}
          {rows.map((row, rowIdx) =>
            cols.map((col) => (
              <div key={`${rowIdx}-${col.name}`} className={`px-1 py-1 border-t border-slate-200 truncate ${rowIdx % 2 ? 'bg-slate-50' : 'bg-white'}`}>
                {formatPreviewCell(row[col.name])}
              </div>
            )),
          )}
        </div>
      </div>
    );
  }

  const dimCol = result.columns.find((col) => !['number', 'integer', 'float', 'double', 'decimal', 'numeric'].includes(col.type || '')) || result.columns[0];
  const measure = result.columns.find((col) => col.name !== dimCol.name) || result.columns[0];
  const values = result.rows.slice(0, 8).map((row) => Number(row[measure.name]) || 0);
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);

  return (
    <div className="w-full h-full bg-white rounded-[4px] border border-slate-300 overflow-hidden p-2">
      <div className="text-[9px] font-semibold text-slate-700 truncate mb-2">
        {measure.label || measure.name}
      </div>
      <div className="h-[75%] flex items-end gap-[3%] px-[3%] border-l border-b border-slate-300">
        {values.map((value, idx) => (
          <div
            key={idx}
            className="flex-1 rounded-t"
            title={String(value)}
            style={{
              height: `${Math.max(4, (Math.abs(value) / max) * 100)}%`,
              background: idx % 2 ? 'rgba(255,71,148,0.72)' : 'rgba(200,24,106,0.82)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

function TilePreview({
  tile,
  source,
  fit,
  preview,
}: {
  tile: DashboardTile;
  source: TileVisualSource;
  fit: SlideFitMode;
  preview?: TileExportState;
}) {
  if (preview?.pngDataUrl) {
    return (
      <img
        src={preview.pngDataUrl}
        alt=""
        className="w-full h-full rounded-[4px] border border-slate-300 bg-white"
        style={{ objectFit: fit === 'stretch' ? 'fill' : fit }}
      />
    );
  }
  if (preview?.result) {
    return <ActualResultPreview result={preview.result} />;
  }
  if (preview?.status === 'failed') {
    return (
      <div className="w-full h-full grid place-items-center rounded-[4px] border border-red-200 bg-red-50 p-3 text-center text-[10px] text-red-700">
        Preview failed: {preview.error || 'Unknown error'}
      </div>
    );
  }
  if (preview?.status && preview.status !== 'pending') {
    return (
      <div className="w-full h-full grid place-items-center rounded-[4px] border border-omni-200 bg-omni-50 p-3 text-center text-[10px] text-omni-700">
        Rendering preview...
      </div>
    );
  }
  return <TileMock tile={tile} source={source} fit={fit} />;
}

export function SlideLayoutPreview({
  tiles,
  template,
  brand,
  overrides,
  onChange,
  insights,
  onInsightsChange,
  includeAppendix,
  onIncludeAppendixChange,
  tileVisualSources,
  renderStrategy,
  onApplyVisualSourceToAll,
  onTileVisualSourceChange,
  previewStates,
  previewing,
  previewError,
  previewSampleLabel,
  onRenderPreview,
}: Props) {
  const [activeId, setActiveId] = useState(() => tiles[0]?.id || '');
  const [slideRailHeight, setSlideRailHeight] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const previewColumnRef = useRef<HTMLDivElement>(null);
  const contentLayout = useMemo(() => layoutForRole(template, 'content'), [template]);
  const defaultBox = contentLayout.bodyBox || { x: 0.5, y: 1.1, w: 8.6, h: 5.6 };
  const activeTile = tiles.find((tile) => tile.id === activeId) || tiles[0];
  const activeOverride = activeTile ? overrides[activeTile.id] || {} : {};
  const activeBox = clampBox(activeOverride.bodyBox || defaultBox);
  const activeTitle = activeOverride.title || activeTile?.name || '';
  const activeInsightBox = clampBox(activeOverride.insightBox || insightDefaultBox(activeBox, Boolean(contentLayout.insightPanel)));
  const activeInsightFormat = activeOverride.insightFormat || 'paragraph';
  const activeFit: SlideFitMode = activeOverride.fit || 'contain';
  const activeNotes = activeOverride.speakerNotes || '';
  const activeNotesFormat = activeOverride.speakerNotesFormat || 'paragraph';
  const activeInsight = activeTile ? insights[activeTile.id] || '' : '';
  const activeInsightDisplayText =
    activeInsightFormat === 'bullets'
      ? normalizeInsightLines(activeInsight).map((line) => `• ${line}`).join('\n')
      : activeInsight;
  const activeInsightFontSize = fitInsightFontSize(
    activeInsightDisplayText || 'Add insight here...',
    Math.max(0.3, activeInsightBox.w - 0.4),
    Math.max(0.3, activeInsightBox.h - 0.7),
  );
  const activeSource = activeTile ? visualSourceFor(activeTile, tileVisualSources, renderStrategy) : 'native';
  const activePreview = activeTile ? previewStates[activeTile.id] : undefined;
  const activeOverlays = activeOverride.overlays || [];
  const selectedSourceCounts = useMemo(() => {
    return tiles.reduce<Record<TileVisualSource, number>>(
      (acc, tile) => {
        acc[visualSourceFor(tile, tileVisualSources, renderStrategy)] += 1;
        return acc;
      },
      { native: 0, 'tile-image': 0, 'full-dashboard': 0, skip: 0 },
    );
  }, [tiles, tileVisualSources, renderStrategy]);
  const previewStatus =
    activePreview?.status === 'done'
      ? 'Rendered preview'
      : activePreview?.status === 'failed'
      ? 'Preview failed'
      : activePreview?.status && activePreview.status !== 'pending'
      ? 'Rendering preview'
      : 'Preview not rendered';
  const previewStatusClass =
    activePreview?.status === 'done'
      ? 'bg-green-50 text-green-700 border-green-200'
      : activePreview?.status === 'failed'
      ? 'bg-red-50 text-red-700 border-red-200'
      : activePreview?.status && activePreview.status !== 'pending'
      ? 'bg-omni-50 text-omni-700 border-omni-200'
      : 'bg-surface-secondary text-content-tertiary border-border';

  useEffect(() => {
    const column = previewColumnRef.current;
    const canvas = canvasRef.current;
    if (!column || !canvas) return undefined;
    const update = () => {
      const columnTop = column.getBoundingClientRect().top;
      const canvasBottom = canvas.getBoundingClientRect().bottom;
      setSlideRailHeight(Math.ceil(canvasBottom - columnTop));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(column);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [activeTile?.id, previewError]);

  function setBox(tileId: string, box: SlideBox) {
    const clean = clampBox(box);
    const bodyBox = sameBox(clean, defaultBox) ? undefined : clean;
    onChange(upsertOverride(overrides, tileId, { bodyBox }));
  }

  function setTitle(tileId: string, title: string) {
    const original = tiles.find((tile) => tile.id === tileId)?.name || '';
    onChange(upsertOverride(overrides, tileId, { title: title.trim() && title !== original ? title : undefined }));
  }

  function setInsightBox(tileId: string, box: SlideBox) {
    const clean = clampBox(box);
    const defaultInsight = insightDefaultBox(activeBox, Boolean(contentLayout.insightPanel));
    const insightBox = sameBox(clean, defaultInsight) ? undefined : clean;
    onChange(upsertOverride(overrides, tileId, { insightBox }));
  }

  function setInsightFormat(tileId: string, insightFormat: SlideOverride['insightFormat']) {
    onChange(upsertOverride(overrides, tileId, { insightFormat }));
  }

  function setFit(tileId: string, fit: SlideFitMode) {
    onChange(upsertOverride(overrides, tileId, { fit: fit === 'contain' ? undefined : fit }));
  }

  function setNotes(tileId: string, speakerNotes: string) {
    onChange(upsertOverride(overrides, tileId, { speakerNotes: speakerNotes.trim() ? speakerNotes : undefined }));
  }

  function setNotesFormat(tileId: string, speakerNotesFormat: SlideOverride['speakerNotesFormat']) {
    onChange(upsertOverride(overrides, tileId, { speakerNotesFormat: speakerNotesFormat === 'paragraph' ? undefined : speakerNotesFormat }));
  }

  function setInsight(tileId: string, text: string) {
    const next = { ...insights };
    if (text.trim()) next[tileId] = text;
    else delete next[tileId];
    onInsightsChange(next);
  }

  function resetLayout(tileId: string) {
    onChange(upsertOverride(overrides, tileId, { bodyBox: undefined, insightBox: undefined, fit: undefined }));
  }

  function resetAllLayouts() {
    const next = { ...overrides };
    for (const tile of tiles) {
      if (!next[tile.id]) continue;
      next[tile.id] = { ...next[tile.id], bodyBox: undefined, insightBox: undefined, fit: undefined };
      if (
        !next[tile.id].title &&
        !next[tile.id].speakerNotes &&
        !next[tile.id].speakerNotesFormat &&
        !next[tile.id].insightFormat &&
        (!next[tile.id].overlays || next[tile.id].overlays?.length === 0)
      ) delete next[tile.id];
    }
    onChange(next);
  }

  function updateOverlay(tileId: string, overlayId: string, patch: Partial<SlideOverlay>) {
    const current = overrides[tileId]?.overlays || [];
    const overlays = current.map((overlay) => overlay.id === overlayId ? { ...overlay, ...patch } : overlay);
    onChange(upsertOverride(overrides, tileId, { overlays }));
  }

  function addOverlay(tileId: string, type: SlideOverlayType) {
    const current = overrides[tileId]?.overlays || [];
    onChange(upsertOverride(overrides, tileId, { overlays: [...current, overlayDefaults(type, brand)] }));
  }

  function removeOverlay(tileId: string, overlayId: string) {
    const overlays = (overrides[tileId]?.overlays || []).filter((overlay) => overlay.id !== overlayId);
    onChange(upsertOverride(overrides, tileId, { overlays: overlays.length > 0 ? overlays : undefined }));
  }

  function beginDrag(e: React.PointerEvent<HTMLDivElement>, tileId: string, target: DragState['target'], mode: DragMode, overlayId?: string) {
    e.preventDefault();
    e.stopPropagation();
    setActiveId(tileId);
    const current =
      target === 'insight'
        ? clampBox(overrides[tileId]?.insightBox || activeInsightBox)
        : target === 'overlay'
          ? clampBox((overrides[tileId]?.overlays || []).find((overlay) => overlay.id === overlayId) || { x: 0, y: 0, w: 1, h: 1 })
          : clampBox(overrides[tileId]?.bodyBox || defaultBox);
    dragRef.current = {
      tileId,
      target,
      overlayId,
      mode,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startBox: current,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function updateDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / SLIDE_W;
    const dx = (e.clientX - drag.startX) / scale;
    const dy = (e.clientY - drag.startY) / scale;
    const next =
      drag.mode === 'move'
        ? { ...drag.startBox, x: drag.startBox.x + dx, y: drag.startBox.y + dy }
        : { ...drag.startBox, w: drag.startBox.w + dx, h: drag.startBox.h + dy };
    if (drag.target === 'insight') setInsightBox(drag.tileId, next);
    else if (drag.target === 'overlay' && drag.overlayId) updateOverlay(drag.tileId, drag.overlayId, clampBox(next));
    else setBox(drag.tileId, next);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
    }
  }

  if (!activeTile) {
    return (
      <div className="text-xs text-content-tertiary p-4 bg-surface-secondary rounded-card">
        Select at least one tile before adjusting slide layouts.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[176px_minmax(0,1fr)] gap-3 items-stretch rounded-card border border-border bg-surface-secondary p-3">
      <div
        className="flex min-h-0 flex-col space-y-2 overflow-hidden rounded-card border border-border bg-white p-3 xl:h-[var(--slide-rail-height)] xl:max-h-[var(--slide-rail-height)] min-w-0"
        data-omnikit-slide-rail
        style={slideRailHeight ? ({ '--slide-rail-height': `${slideRailHeight}px` } as CSSProperties) : undefined}
      >
        <div className="flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-wider text-content-tertiary">
          <span>Slides</span>
          <span>{tiles.length}</span>
        </div>
        <div className="relative flex-1 min-h-0">
          <div className="space-y-1.5 h-full overflow-y-auto pr-0.5">
            {tiles.map((tile, idx) => {
              const active = tile.id === activeTile.id;
              const source = visualSourceFor(tile, tileVisualSources, renderStrategy);
              const customized = Boolean(
                overrides[tile.id]?.title ||
                overrides[tile.id]?.bodyBox ||
                overrides[tile.id]?.insightBox ||
                overrides[tile.id]?.insightFormat ||
                overrides[tile.id]?.fit ||
                overrides[tile.id]?.speakerNotes ||
                overrides[tile.id]?.overlays?.length ||
                insights[tile.id]
              );
              return (
                <button
                  key={tile.id}
                  type="button"
                  onClick={() => setActiveId(tile.id)}
                  className={`w-full text-left px-2 py-2 rounded-card border transition ${
                    active ? 'border-omni-500 bg-surface-secondary' : 'border-border bg-white hover:border-omni-300'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-5 h-5 rounded-full bg-surface-secondary text-[10px] flex items-center justify-center font-semibold flex-shrink-0"
                      style={{ color: '#C8186A' }}
                    >
                      {idx + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium text-content-primary truncate">{tile.name}</span>
                      <span className="block text-[9px] uppercase tracking-wider text-content-tertiary truncate">
                        {sourceLabel(source)}
                      </span>
                    </span>
                    {customized && (
                      <span className="ml-auto h-2 w-2 rounded-full bg-omni-500 flex-shrink-0" title="Customized" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3 bg-gradient-to-t from-white/85 to-transparent" />
        </div>
      </div>

      <div ref={previewColumnRef} className="space-y-3 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-sm font-semibold text-content-primary truncate">{activeTitle}</h3>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium flex-shrink-0 ${previewStatusClass}`}>
                {previewStatus}
              </span>
            </div>
            <p className="text-[11px] text-content-tertiary">
              Drag or resize the tile region. Render a preview to inspect the actual first-pass output.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {previewSampleLabel && (
              <span className="text-[10px] text-content-tertiary max-w-[160px] truncate" title={previewSampleLabel}>
                Preview: {previewSampleLabel}
              </span>
            )}
            <button type="button" onClick={() => onRenderPreview(activeTile.id)} disabled={previewing} className="btn-secondary btn-sm">
              {previewing ? 'Rendering...' : 'Render this slide'}
            </button>
            <button type="button" onClick={resetAllLayouts} className="btn-ghost btn-sm">
              <RotateCcw size={12} /> Reset all
            </button>
          </div>
        </div>
        {previewError && (
          <div className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            {previewError}
          </div>
        )}

        <div
          ref={canvasRef}
          data-omnikit-slide-canvas
          className="relative w-full overflow-hidden rounded-card border border-border bg-white shadow-sm select-none"
          style={{
            aspectRatio: `${SLIDE_W} / ${SLIDE_H}`,
            background: contentLayout.backgroundImageDataUrl
              ? `url(${contentLayout.backgroundImageDataUrl}) center / cover`
              : hex(contentLayout.backgroundColor || brand.backgroundColor),
          }}
          onPointerMove={updateDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            className="absolute left-0 right-0"
            style={{
              top: 0,
              height: `${(((contentLayout.headerBarHeight || 0) / SLIDE_H) * 100)}%`,
              background: contentLayout.headerBarColor ? hex(contentLayout.headerBarColor) : 'transparent',
            }}
          />
          {contentLayout.titleBox && (
            <div
              className="absolute truncate font-semibold pointer-events-none"
              style={{
                ...boxStyle({
                  x: contentLayout.titleBox.x,
                  y: contentLayout.titleBox.y,
                  w: contentLayout.titleBox.w,
                  h: contentLayout.titleBox.h,
                }),
                color: hex(contentLayout.titleBox.color || brand.titleColor),
                fontSize: 'clamp(10px, 2.1vw, 22px)',
              }}
            >
              {activeTitle}
            </div>
          )}
          {contentLayout.logoBox && brand.logoDataUrl && (
            <img
              src={brand.logoDataUrl}
              alt=""
              className="absolute object-contain pointer-events-none"
              style={boxStyle(contentLayout.logoBox)}
            />
          )}
          <div
            className="absolute rounded-[6px] border-2 border-omni-500 bg-surface-secondary cursor-move"
            style={boxStyle(activeBox)}
            onPointerDown={(e) => beginDrag(e, activeTile.id, 'body', 'move')}
          >
            <div className="absolute inset-0 p-2 pointer-events-none">
              <TilePreview tile={activeTile} source={activeSource} fit={activeFit} preview={activePreview} />
              <div className="absolute left-2 bottom-2 text-[10px] text-omni-800 bg-white rounded px-1.5 py-0.5 border border-white">
                {activeBox.x.toFixed(2)}, {activeBox.y.toFixed(2)} · {activeBox.w.toFixed(2)} x {activeBox.h.toFixed(2)}
              </div>
              <Move size={14} className="absolute right-2 top-2 text-omni-700 bg-white rounded border border-white p-0.5" />
            </div>
            <div
              className="absolute -right-2 -bottom-2 w-5 h-5 rounded-full bg-omni-600 border-2 border-white shadow cursor-nwse-resize"
              onPointerDown={(e) => beginDrag(e, activeTile.id, 'body', 'resize')}
              title="Resize"
            />
          </div>
          {(contentLayout.insightPanel || activeInsight || activeOverride.insightBox || activeOverride.insightFormat) && (
            <div
              className="absolute rounded-[6px] border-2 border-omni-300 bg-white shadow-sm cursor-move overflow-hidden"
              style={boxStyle(activeInsightBox)}
              onPointerDown={(e) => beginDrag(e, activeTile.id, 'insight', 'move')}
            >
              <div className="h-[20%] min-h-[18px] bg-omni-50 px-2 flex items-center text-[10px] font-semibold text-omni-700 pointer-events-none">
                Insights
              </div>
              <div
                className="p-2 text-slate-700 leading-tight pointer-events-none overflow-hidden"
                style={{ fontSize: `${activeInsightFontSize}px` }}
              >
                {activeInsight ? (
                  activeInsightFormat === 'bullets' ? (
                    <ul className="list-disc pl-4 space-y-1">
                      {normalizeInsightLines(activeInsight).map((line, idx) => <li key={idx}>{line}</li>)}
                    </ul>
                  ) : (
                    <div className="whitespace-pre-wrap">{activeInsight}</div>
                  )
                ) : (
                  <span className="text-slate-400">Add insight here...</span>
                )}
              </div>
              <div
                className="absolute -right-2 -bottom-2 w-5 h-5 rounded-full bg-omni-400 border-2 border-white shadow cursor-nwse-resize"
                onPointerDown={(e) => beginDrag(e, activeTile.id, 'insight', 'resize')}
                title="Resize insights"
              />
            </div>
          )}
          {activeOverlays.map((overlay) => (
            <div
              key={overlay.id}
              className="absolute cursor-move"
              style={{ ...boxStyle(clampBox(overlay)), color: hex(overlay.color || brand.accentColor) }}
              onPointerDown={(e) => beginDrag(e, activeTile.id, 'overlay', 'move', overlay.id)}
            >
              {overlay.type === 'arrow' || overlay.type === 'line' ? (
                <svg
                  className="w-full h-full overflow-visible"
                  viewBox="0 0 100 100"
                  preserveAspectRatio={overlay.type === 'arrow' ? 'xMidYMid meet' : 'none'}
                  style={{ transform: `rotate(${overlayRotation(overlay)}deg)` }}
                >
                  <defs>
                    <marker
                      id={`arrowhead-${overlay.id}`}
                      markerWidth="8"
                      markerHeight="8"
                      refX="7"
                      refY="4"
                      orient="auto"
                      markerUnits="strokeWidth"
                    >
                      <path d="M 0 0 L 8 4 L 0 8 z" fill={hex(overlay.color || brand.accentColor)} />
                    </marker>
                  </defs>
                  <line
                    x1="12"
                    y1="50"
                    x2="88"
                    y2="50"
                    stroke={hex(overlay.color || brand.accentColor)}
                    strokeWidth={overlay.type === 'arrow' ? '6' : '4'}
                    strokeLinecap="round"
                    markerEnd={overlay.type === 'arrow' ? `url(#arrowhead-${overlay.id})` : undefined}
                  />
                </svg>
              ) : overlay.type === 'box' ? (
                <div
                  className="w-full h-full rounded-[4px] border-2 bg-transparent"
                  style={{
                    borderColor: hex(overlay.color || brand.accentColor),
                    transform: `rotate(${overlayRotation(overlay)}deg)`,
                  }}
                />
              ) : overlay.type === 'symbol' ? (
                <div
                  className="w-full h-full rounded-full border-2 bg-white grid place-items-center font-bold text-[18px]"
                  style={{
                    borderColor: hex(overlay.color || brand.accentColor),
                    transform: `rotate(${overlayRotation(overlay)}deg)`,
                  }}
                >
                  {overlay.text || '!'}
                </div>
              ) : (
                <div
                  className="w-full h-full rounded-[4px] border bg-white px-2 py-1 text-[10px] font-semibold leading-tight"
                  style={{
                    borderColor: hex(overlay.color || brand.accentColor),
                    transform: `rotate(${overlayRotation(overlay)}deg)`,
                  }}
                >
                  {overlay.text || 'Key takeaway'}
                </div>
              )}
              <div
                className="absolute -right-1.5 -bottom-1.5 w-4 h-4 rounded-full bg-slate-700 border-2 border-white cursor-nwse-resize"
                onPointerDown={(e) => beginDrag(e, activeTile.id, 'overlay', 'resize', overlay.id)}
                title="Resize overlay"
              />
            </div>
          ))}
          {contentLayout.footerBox && (
            <div
              className="absolute truncate text-[9px] pointer-events-none"
              style={{ ...boxStyle(contentLayout.footerBox), color: '#888888' }}
            >
              {brand.footerText}
            </div>
          )}
        </div>

      </div>

      <div className="xl:col-span-2 grid grid-cols-1 lg:grid-cols-[minmax(240px,0.8fr)_minmax(0,2.2fr)] gap-3 items-stretch min-w-0">
        <div className="rounded-card border border-border bg-white p-3 space-y-3 min-w-0 h-full">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-content-primary">
            <Maximize2 size={13} /> Slide setup
          </div>
          <label className="block text-[11px] font-medium text-content-secondary">
            Title
            <input
              type="text"
              value={activeTitle}
              onChange={(e) => setTitle(activeTile.id, e.target.value)}
              className="input-field mt-1 text-xs"
            />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 2xl:grid-cols-1 gap-2">
            <div className="sm:col-span-2 2xl:col-span-1">
              <div className="text-[11px] font-medium text-content-secondary mb-1">All slides</div>
              <div className="grid grid-cols-3 gap-1.5">
                {([
                  ['native', 'Native'],
                  ['tile-image', 'Omni image'],
                  ['full-dashboard', 'Dashboard'],
                ] as const).map(([source, label]) => (
                  <button
                    key={source}
                    type="button"
                    onClick={() => onApplyVisualSourceToAll(source)}
                    className={`btn-sm justify-center ${tiles.length > 0 && selectedSourceCounts[source] === tiles.length ? 'btn-secondary' : 'btn-ghost'}`}
                    title={`Apply ${label} to every selected slide`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="block text-[11px] text-content-secondary">
              This slide
              <select
                value={activeSource}
                onChange={(e) => onTileVisualSourceChange(activeTile.id, e.target.value as TileVisualSource)}
                className="input-field mt-1 text-xs"
              >
                <option value="native">Native</option>
                <option value="tile-image">Omni image</option>
                <option value="full-dashboard">Full dashboard</option>
                <option value="skip">Skip</option>
              </select>
            </label>
            <label className="block text-[11px] text-content-secondary">
              Image fit
              <select
                value={activeFit}
                onChange={(e) => setFit(activeTile.id, e.target.value as SlideFitMode)}
                className="input-field mt-1 text-xs"
              >
                <option value="contain">Contain</option>
                <option value="cover">Cover</option>
                <option value="stretch">Stretch</option>
              </select>
            </label>
          </div>
          <div className="border-t border-border pt-3 space-y-2">
            <div className="text-[11px] font-medium text-content-secondary">Visual position</div>
            <div className="grid grid-cols-4 2xl:grid-cols-2 gap-2">
              {(['x', 'y', 'w', 'h'] as const).map((key) => (
                <label key={key} className="text-[11px] text-content-secondary">
                  {key.toUpperCase()}
                  <input
                    type="number"
                    min={key === 'w' ? 1 : 0}
                    max={key === 'x' || key === 'w' ? SLIDE_W : SLIDE_H}
                    step={0.1}
                    value={Number(activeBox[key].toFixed(2))}
                    onChange={(e) => setBox(activeTile.id, { ...activeBox, [key]: Number(e.target.value) })}
                    className="input-field mt-1 text-xs"
                  />
                </label>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" className="btn-ghost btn-sm flex-1 justify-center" onClick={() => setBox(activeTile.id, { ...activeBox, x: defaultBox.x })}>
                <AlignLeft size={12} />
              </button>
              <button type="button" className="btn-ghost btn-sm flex-1 justify-center" onClick={() => setBox(activeTile.id, { ...activeBox, x: (SLIDE_W - activeBox.w) / 2 })}>
                <AlignCenter size={12} />
              </button>
              <button type="button" className="btn-ghost btn-sm flex-1 justify-center" onClick={() => setBox(activeTile.id, { ...activeBox, x: SLIDE_W - defaultBox.x - activeBox.w })}>
                <AlignRight size={12} />
              </button>
            </div>
            <button type="button" onClick={() => resetLayout(activeTile.id)} className="btn-ghost btn-sm w-full justify-center">
              <RotateCcw size={12} /> Reset layout
            </button>
          </div>
        </div>

        <div className="space-y-3 min-w-0 h-full">
        <div className="rounded-card border border-border bg-white p-3 space-y-3 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-content-primary">
              <StickyNote size={13} /> Narration
            </div>
            <label className="flex items-center gap-2 text-[11px] text-content-secondary">
              <input
                type="checkbox"
                checked={includeAppendix}
                onChange={(e) => onIncludeAppendixChange(e.target.checked)}
              />
              Appendix
            </label>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
            <div className="grid grid-rows-[24px_32px_auto] gap-2">
              <div className="flex h-6 items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[11px] font-medium text-content-secondary">
                  <StickyNote size={12} /> Insight panel
                </label>
                {activeInsight && (
                  <button type="button" onClick={() => setInsight(activeTile.id, '')} className="btn-ghost btn-sm">
                    Clear
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setInsightFormat(activeTile.id, 'paragraph')}
                  className={`btn-sm justify-center ${activeInsightFormat === 'paragraph' ? 'btn-secondary' : 'btn-ghost'}`}
                >
                  <Type size={12} /> Paragraph
                </button>
                <button
                  type="button"
                  onClick={() => setInsightFormat(activeTile.id, 'bullets')}
                  className={`btn-sm justify-center ${activeInsightFormat === 'bullets' ? 'btn-secondary' : 'btn-ghost'}`}
                >
                  <CaseSensitive size={12} /> Bullets
                </button>
              </div>
              <textarea
                value={activeInsight}
                onChange={(e) => setInsight(activeTile.id, e.target.value)}
                rows={5}
                placeholder="Add insight here..."
                className="input-field text-sm min-h-[128px] h-full"
              />
            </div>
            <div className="grid grid-rows-[24px_32px_auto] gap-2">
              <div className="flex h-6 items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[11px] font-medium text-content-secondary">
                  <StickyNote size={12} /> Speaker notes
                </label>
                {activeNotes && (
                  <button type="button" onClick={() => setNotes(activeTile.id, '')} className="btn-ghost btn-sm">
                    Clear
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setNotesFormat(activeTile.id, 'paragraph')}
                  className={`btn-sm justify-center ${activeNotesFormat === 'paragraph' ? 'btn-secondary' : 'btn-ghost'}`}
                >
                  <Type size={12} /> Paragraph
                </button>
                <button
                  type="button"
                  onClick={() => setNotesFormat(activeTile.id, 'bullets')}
                  className={`btn-sm justify-center ${activeNotesFormat === 'bullets' ? 'btn-secondary' : 'btn-ghost'}`}
                >
                  <CaseSensitive size={12} /> Bullets
                </button>
              </div>
              <textarea
                value={activeNotes}
                onChange={(e) => setNotes(activeTile.id, e.target.value)}
                rows={5}
                placeholder="Optional presenter notes for this slide..."
                className="input-field text-sm min-h-[128px] h-full"
              />
            </div>
          </div>
        </div>

        <div className="rounded-card border border-border bg-white p-3 space-y-3 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-content-primary">
              <Shapes size={13} /> Callouts
            </div>
            <span className="text-[10px] text-content-tertiary">{activeOverlays.length}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
            <button type="button" className="btn-ghost btn-sm justify-center" onClick={() => addOverlay(activeTile.id, 'text')}>
              <Type size={12} /> Text
            </button>
            <button type="button" className="btn-ghost btn-sm justify-center" onClick={() => addOverlay(activeTile.id, 'arrow')}>
              <ArrowUpRight size={12} /> Arrow
            </button>
            <button type="button" className="btn-ghost btn-sm justify-center" onClick={() => addOverlay(activeTile.id, 'line')}>
              <Minus size={12} /> Line
            </button>
            <button type="button" className="btn-ghost btn-sm justify-center" onClick={() => addOverlay(activeTile.id, 'box')}>
              <Square size={12} /> Box
            </button>
            <button type="button" className="btn-ghost btn-sm justify-center" onClick={() => addOverlay(activeTile.id, 'symbol')}>
              <Shapes size={12} /> Mark
            </button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 max-h-72 overflow-y-auto">
            {activeOverlays.length === 0 && (
              <div className="text-[10px] text-content-tertiary">
                Add callouts to highlight key points on this slide.
              </div>
            )}
            {activeOverlays.map((overlay) => (
              <div key={overlay.id} className="rounded border border-border p-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium capitalize text-content-secondary">{overlay.type}</span>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => removeOverlay(activeTile.id, overlay.id)}>
                    Remove
                  </button>
                </div>
                <input
                  type="color"
                  value={hex(overlay.color || brand.accentColor)}
                  onChange={(e) => updateOverlay(activeTile.id, overlay.id, { color: e.target.value.replace(/^#/, '') })}
                  className="h-8 w-full rounded border border-border bg-white"
                  title="Overlay color"
                />
                {(overlay.type === 'text' || overlay.type === 'symbol') && (
                  <input
                    type="text"
                    value={overlay.text || ''}
                    onChange={(e) => updateOverlay(activeTile.id, overlay.id, { text: e.target.value })}
                    placeholder={overlay.type === 'symbol' ? '!' : 'Key takeaway'}
                    className="input-field text-xs"
                  />
                )}
                <label className="block text-[10px] text-content-tertiary">
                  <span className="mb-1 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1">
                      <RotateCcw size={10} /> Rotation
                    </span>
                    <input
                      type="number"
                      min={-180}
                      max={180}
                      step={5}
                      value={overlayRotation(overlay)}
                      onChange={(e) => updateOverlay(activeTile.id, overlay.id, { rotation: Number(e.target.value) })}
                      className="h-7 w-16 appearance-none rounded border border-border bg-white px-1.5 text-center text-[11px] text-content-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  </span>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={5}
                    value={overlayRotation(overlay)}
                    onChange={(e) => updateOverlay(activeTile.id, overlay.id, { rotation: Number(e.target.value) })}
                    className="w-full"
                  />
                </label>
              </div>
            ))}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
