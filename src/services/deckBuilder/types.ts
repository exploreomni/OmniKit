export interface DashboardTile {
  id: string;
  name: string;
  queryId?: string;
  queryIdentifierMapKey?: string;
  section?: string;
  order: number;
  rawQuery?: Record<string, unknown>;
  tileType?: string;
  markdown?: string;
}

export interface DashboardSummary {
  id: string;
  name: string;
  url: string;
  tiles: DashboardTile[];
  filters?: DashboardFilter[];
  topics?: string[];
  modelId?: string;
}

export interface DashboardFilter {
  field: string;
  label?: string;
  kind?: string;
  type?: string;
  values: unknown[];
  isNegative?: boolean;
  modelId?: string;
  topic?: string;
  view?: string;
  dataType?: string;
  source?: 'dashboard-picker' | 'tile' | 'topic';
}

export interface TopicFieldRef {
  field: string;
  label: string;
  view: string;
  topic: string;
  modelId: string;
  dataType?: string;
}

export interface DashboardTopicCatalog {
  modelId: string;
  topics: string[];
  fields: TopicFieldRef[];
  fetchedAt: number;
}

export interface FilterOverride {
  field: string;
  kind?: string;
  type?: string;
  values: unknown[];
  isNegative?: boolean;
}

export type TileExportStatus =
  | 'pending'
  | 'queued'
  | 'exporting'
  | 'polling'
  | 'fetching'
  | 'done'
  | 'failed'
  | 'skipped';

export type RenderStrategy = 'native' | 'tile-image' | 'full-dashboard';

export type TileVisualSource = 'native' | 'tile-image' | 'full-dashboard' | 'skip';

export type SlideFitMode = 'contain' | 'cover' | 'stretch';

export type InsightFormat = 'paragraph' | 'bullets';

export type SlideOverlayType = 'text' | 'arrow' | 'line' | 'box' | 'symbol';

export interface SlideBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SlideOverride {
  title?: string;
  bodyBox?: SlideBox;
  insightBox?: SlideBox;
  insightFormat?: InsightFormat;
  fit?: SlideFitMode;
  speakerNotes?: string;
  speakerNotesFormat?: InsightFormat;
  overlays?: SlideOverlay[];
}

export interface SlideOverlay {
  id: string;
  type: SlideOverlayType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  text?: string;
  color?: string;
}

export type TileRenderKind = 'kpi' | 'bar' | 'line' | 'pie' | 'table' | 'empty' | 'markdown' | 'unsupported';

export interface TileColumn {
  name: string;
  label?: string;
  type?: string;
}

export interface TileResult {
  columns: TileColumn[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  renderKind: TileRenderKind;
}

export interface TileExportState {
  tileId: string;
  status: TileExportStatus;
  message?: string;
  error?: string;
  pngDataUrl?: string;
  pngSize?: number;
  result?: TileResult;
  renderKind?: TileRenderKind;
  strategy?: RenderStrategy;
}

export interface BrandConfig {
  name: string;
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
  footerText: string;
  logoDataUrl?: string;
  titleColor: string;
  backgroundColor: string;
  chartPalette?: string[];
  tableHeaderColor?: string;
  tableZebraColor?: string;
  bodyTextColor?: string;
  tableHeaderMode?: 'brand' | 'neutral';
}

export type SlideRole = 'title' | 'content' | 'section' | 'closing' | 'appendix';

export type LayoutDecoration =
  | {
      type: 'pic';
      x: number;
      y: number;
      w: number;
      h: number;
      data: string;
    }
  | {
      type: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: string;
      line?: string;
    }
  | {
      type: 'text';
      x: number;
      y: number;
      w: number;
      h: number;
      text: string;
      color?: string;
      fontSize?: number;
      bold?: boolean;
      fontFamily?: string;
    };

export interface SlideLayout {
  id: string;
  role: SlideRole;
  name: string;
  backgroundColor?: string;
  backgroundImageDataUrl?: string;
  headerBarColor?: string;
  headerBarHeight?: number;
  titleBox?: { x: number; y: number; w: number; h: number; fontSize?: number; color?: string; bold?: boolean };
  bodyBox?: { x: number; y: number; w: number; h: number };
  footerBox?: { x: number; y: number; w: number; h: number; fontSize?: number; color?: string };
  logoBox?: { x: number; y: number; w: number; h: number };
  insightPanel?: boolean;
  decorations?: LayoutDecoration[];
}

export interface LayoutKit {
  id: string;
  name: string;
  source: 'builtin' | 'json' | 'pptx';
  sourceFileName?: string;
  brand: BrandConfig;
  layouts: SlideLayout[];
  thumbnailDataUrl?: string;
  importedAt: number;
}

export interface SlideInsight {
  tileId: string;
  text: string;
}

export interface DeckRecipe {
  version: 1;
  dashboardUrl: string;
  dashboardId?: string;
  dashboardName?: string;
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
}

export const DEFAULT_BRAND: BrandConfig = {
  name: 'OmniKit Default',
  primaryColor: 'C8186A',
  accentColor: 'FF4794',
  fontFamily: 'Inter',
  footerText: 'Generated with OmniKit',
  titleColor: '1A0818',
  backgroundColor: 'FFFFFF',
  chartPalette: ['C8186A', 'FF4794', '6B7280', '10B981', 'F59E0B', 'EF4444'],
  tableHeaderColor: 'C8186A',
  tableZebraColor: 'F8F1F5',
  bodyTextColor: '1F2937',
};

export const NEUTRAL_BRAND: BrandConfig = {
  name: 'Neutral Corporate',
  primaryColor: '1F2937',
  accentColor: '3B82F6',
  fontFamily: 'Calibri',
  footerText: 'Confidential',
  titleColor: '111827',
  backgroundColor: 'FFFFFF',
  chartPalette: ['1F2937', '3B82F6', '6B7280', '10B981', 'F59E0B', 'EF4444'],
  tableHeaderColor: '1F2937',
  tableZebraColor: 'F3F4F6',
  bodyTextColor: '1F2937',
};

export const EXECUTIVE_BRAND: BrandConfig = {
  name: 'Executive Mono',
  primaryColor: '111827',
  accentColor: 'B45309',
  fontFamily: 'Georgia',
  footerText: 'Prepared for internal use',
  titleColor: '111827',
  backgroundColor: 'FAFAF9',
  chartPalette: ['111827', 'B45309', '57534E', '047857', 'A16207', '9F1239'],
  tableHeaderColor: '111827',
  tableZebraColor: 'F5F5F4',
  bodyTextColor: '292524',
};
