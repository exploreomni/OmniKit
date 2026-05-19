import type { BrandConfig, DeckRecipe, FilterOverride, SlideOverride, TileVisualSource } from './types';
import { DEFAULT_BRAND } from './types';

export function buildRecipe(input: {
  dashboardUrl: string;
  selectedTileIds: string[];
  insights: Record<string, string>;
  brand: BrandConfig;
  includeAppendix: boolean;
  generatedFrom?: string;
  filterOverrides?: Record<string, FilterOverride>;
  batch?: { filterField: string; values: string[] };
  templateId?: string;
  tileVisualSources?: Record<string, TileVisualSource>;
  slideOverrides?: Record<string, SlideOverride>;
}): DeckRecipe {
  return {
    version: 1,
    dashboardUrl: input.dashboardUrl,
    selectedTileIds: input.selectedTileIds,
    insights: input.insights,
    brand: input.brand,
    includeAppendix: input.includeAppendix,
    generatedFrom: input.generatedFrom,
    filterOverrides: input.filterOverrides,
    batch: input.batch,
    templateId: input.templateId,
    tileVisualSources: input.tileVisualSources,
    slideOverrides: input.slideOverrides,
  };
}

export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 250);
}

export async function readJsonFile<T = unknown>(file: File): Promise<T> {
  const text = await file.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('That file is not valid JSON.');
  }
}

export function validateRecipe(payload: unknown): DeckRecipe {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Deck recipe is empty or malformed.');
  }
  const obj = payload as Partial<DeckRecipe>;
  if (obj.version !== 1) {
    throw new Error('Unsupported deck recipe version.');
  }
  if (typeof obj.dashboardUrl !== 'string' || !Array.isArray(obj.selectedTileIds)) {
    throw new Error('Recipe is missing required fields.');
  }
  const filterOverrides = obj.filterOverrides && typeof obj.filterOverrides === 'object'
    ? sanitizeFilterOverrides(obj.filterOverrides as Record<string, unknown>)
    : undefined;
  const batch =
    obj.batch && typeof obj.batch === 'object' && typeof (obj.batch as { filterField?: unknown }).filterField === 'string'
      ? {
          filterField: String((obj.batch as { filterField: string }).filterField),
          values: Array.isArray((obj.batch as { values?: unknown }).values)
            ? ((obj.batch as { values: unknown[] }).values).map(String)
            : [],
        }
      : undefined;
  const tileVisualSources: Record<string, TileVisualSource> | undefined =
    obj.tileVisualSources && typeof obj.tileVisualSources === 'object'
      ? Object.fromEntries(
          Object.entries(obj.tileVisualSources as Record<string, unknown>)
            .filter(([, v]) => v === 'native' || v === 'tile-image' || v === 'full-dashboard' || v === 'skip')
            .map(([k, v]) => [k, v as TileVisualSource])
        )
      : undefined;
  const slideOverrides: Record<string, SlideOverride> | undefined =
    obj.slideOverrides && typeof obj.slideOverrides === 'object'
      ? Object.fromEntries(
          Object.entries(obj.slideOverrides as Record<string, unknown>)
            .map(([tileId, value]) => [tileId, sanitizeSlideOverride(value)] as const)
            .filter(([, value]) => value !== null)
        ) as Record<string, SlideOverride>
      : undefined;
  return {
    version: 1,
    dashboardUrl: obj.dashboardUrl,
    selectedTileIds: obj.selectedTileIds.map(String),
    insights: (obj.insights && typeof obj.insights === 'object') ? obj.insights as Record<string, string> : {},
    brand: validateBrand(obj.brand) || DEFAULT_BRAND,
    includeAppendix: Boolean(obj.includeAppendix),
    generatedFrom: typeof obj.generatedFrom === 'string' ? obj.generatedFrom : undefined,
    filterOverrides,
    batch,
    templateId: typeof obj.templateId === 'string' ? obj.templateId : undefined,
    tileVisualSources,
    slideOverrides,
  };
}

function sanitizeSlideOverride(raw: unknown): SlideOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<SlideOverride>;
  const out: SlideOverride = {};
  if (typeof value.title === 'string' && value.title.trim()) {
    out.title = value.title;
  }
  if (value.bodyBox && typeof value.bodyBox === 'object') {
    out.bodyBox = sanitizeSlideBox(value.bodyBox);
  }
  if (value.insightBox && typeof value.insightBox === 'object') {
    out.insightBox = sanitizeSlideBox(value.insightBox);
  }
  if (value.insightFormat === 'paragraph' || value.insightFormat === 'bullets') {
    out.insightFormat = value.insightFormat;
  }
  if (value.fit === 'contain' || value.fit === 'cover' || value.fit === 'stretch') {
    out.fit = value.fit;
  }
  if (typeof value.speakerNotes === 'string') {
    out.speakerNotes = value.speakerNotes;
  }
  if (value.speakerNotesFormat === 'paragraph' || value.speakerNotesFormat === 'bullets') {
    out.speakerNotesFormat = value.speakerNotesFormat;
  }
  if (Array.isArray(value.overlays)) {
    const overlays = value.overlays.map(sanitizeOverlay).filter(Boolean) as NonNullable<SlideOverride['overlays']>;
    if (overlays.length > 0) out.overlays = overlays;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeSlideBox(raw: unknown): SlideOverride['bodyBox'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const box = raw as Record<string, unknown>;
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
    return { x, y, w, h };
  }
  return undefined;
}

function sanitizeOverlay(raw: unknown): NonNullable<SlideOverride['overlays']>[number] | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const type =
    v.type === 'text' ||
    v.type === 'arrow' ||
    v.type === 'line' ||
    v.type === 'box' ||
    v.type === 'symbol'
      ? v.type
      : null;
  const x = Number(v.x);
  const y = Number(v.y);
  const w = Number(v.w);
  const h = Number(v.h);
  if (!type || ![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return {
    id: typeof v.id === 'string' && v.id ? v.id : `overlay_${Date.now()}`,
    type,
    x,
    y,
    w,
    h,
    rotation: Number.isFinite(Number(v.rotation)) ? Number(v.rotation) : undefined,
    text: typeof v.text === 'string' ? v.text : undefined,
    color: typeof v.color === 'string' ? v.color : undefined,
  };
}

function sanitizeFilterOverrides(raw: Record<string, unknown>): Record<string, FilterOverride> {
  const out: Record<string, FilterOverride> = {};
  for (const [field, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object') continue;
    const v = val as Partial<FilterOverride>;
    if (!Array.isArray(v.values)) continue;
    out[field] = {
      field,
      kind: typeof v.kind === 'string' ? v.kind : undefined,
      type: typeof v.type === 'string' ? v.type : undefined,
      values: v.values,
      isNegative: Boolean(v.isNegative),
    };
  }
  return out;
}

export function validateBrand(payload: unknown): BrandConfig | null {
  if (!payload || typeof payload !== 'object') return null;
  const b = payload as Partial<BrandConfig>;
  if (typeof b.name !== 'string') return null;
  return {
    name: b.name,
    primaryColor: b.primaryColor || DEFAULT_BRAND.primaryColor,
    accentColor: b.accentColor || DEFAULT_BRAND.accentColor,
    fontFamily: b.fontFamily || DEFAULT_BRAND.fontFamily,
    footerText: b.footerText ?? DEFAULT_BRAND.footerText,
    logoDataUrl: typeof b.logoDataUrl === 'string' ? b.logoDataUrl : undefined,
    titleColor: b.titleColor || DEFAULT_BRAND.titleColor,
    backgroundColor: b.backgroundColor || DEFAULT_BRAND.backgroundColor,
    chartPalette: Array.isArray(b.chartPalette) ? b.chartPalette.map(String) : DEFAULT_BRAND.chartPalette,
    tableHeaderColor: typeof b.tableHeaderColor === 'string' ? b.tableHeaderColor : DEFAULT_BRAND.tableHeaderColor,
    tableZebraColor: typeof b.tableZebraColor === 'string' ? b.tableZebraColor : DEFAULT_BRAND.tableZebraColor,
    bodyTextColor: typeof b.bodyTextColor === 'string' ? b.bodyTextColor : DEFAULT_BRAND.bodyTextColor,
    tableHeaderMode: b.tableHeaderMode === 'neutral' ? 'neutral' : b.tableHeaderMode === 'brand' ? 'brand' : undefined,
  };
}

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}
