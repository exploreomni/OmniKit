import { validateRecipe } from './deckRecipe';
import { hostFromBaseUrl } from './recipeStore';
import type {
  BrandConfig,
  DashboardFilter,
  DashboardTile,
  DeckRecipe,
  FilterOverride,
  RenderStrategy,
  SlideOverride,
  TileVisualSource,
} from './types';

const PREFIX = 'omnikit:deck:draft:v1';
const FORBIDDEN_STORAGE_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'passphrase',
]);

export type DeckDraftStep = 'inspect' | 'select' | 'filters' | 'brand' | 'layout' | 'generate';

export interface DeckDraftDashboard {
  url: string;
  id: string;
  name: string;
  tiles: DashboardTile[];
  filters: DashboardFilter[];
  topics: string[];
  modelId?: string;
}

export interface DeckBuilderDraft {
  version: 1;
  savedAt: number;
  host?: string;
  step: DeckDraftStep;
  dashboard?: DeckDraftDashboard;
  recipe: DeckRecipe;
  dashboardDefaults?: Record<string, FilterOverride>;
  renderStrategy: RenderStrategy;
}

export interface DeckDraftInput {
  step: DeckDraftStep;
  dashboard?: DeckDraftDashboard | null;
  dashboardUrl: string;
  selectedTileIds: string[];
  insights: Record<string, string>;
  brand: BrandConfig;
  includeAppendix: boolean;
  generatedFrom?: string;
  filterOverrides?: Record<string, FilterOverride>;
  dashboardDefaults?: Record<string, FilterOverride>;
  batch?: { filterField: string; values: string[] };
  templateId?: string;
  tileVisualSources?: Record<string, TileVisualSource>;
  slideOverrides?: Record<string, SlideOverride>;
  renderStrategy: RenderStrategy;
}

function storageKey(baseUrl: string): string {
  return `${PREFIX}:${hostFromBaseUrl(baseUrl) || 'unknown'}`;
}

function sanitizeStep(value: unknown): DeckDraftStep {
  return value === 'select' ||
    value === 'filters' ||
    value === 'brand' ||
    value === 'layout' ||
    value === 'generate'
    ? value
    : 'inspect';
}

function sanitizeDashboard(value: unknown): DeckDraftDashboard | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<DeckDraftDashboard>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.url !== 'string') return undefined;
  return {
    id: raw.id,
    name: raw.name,
    url: raw.url,
    tiles: Array.isArray(raw.tiles) ? raw.tiles.map(sanitizeTile).filter(Boolean) as DashboardTile[] : [],
    filters: Array.isArray(raw.filters) ? raw.filters.map(sanitizeFilter).filter(Boolean) as DashboardFilter[] : [],
    topics: Array.isArray(raw.topics) ? raw.topics.map(String) : [],
    modelId: typeof raw.modelId === 'string' ? raw.modelId : undefined,
  };
}

function sanitizeTile(value: unknown): DashboardTile | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<DashboardTile>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  return {
    id: raw.id,
    name: raw.name,
    queryId: typeof raw.queryId === 'string' ? raw.queryId : undefined,
    queryIdentifierMapKey: typeof raw.queryIdentifierMapKey === 'string' ? raw.queryIdentifierMapKey : undefined,
    section: typeof raw.section === 'string' ? raw.section : undefined,
    order: Number.isFinite(raw.order) ? Number(raw.order) : 0,
    tileType: typeof raw.tileType === 'string' ? raw.tileType : undefined,
    markdown: typeof raw.markdown === 'string' ? raw.markdown : undefined,
  };
}

function sanitizeFilter(value: unknown): DashboardFilter | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<DashboardFilter>;
  if (typeof raw.field !== 'string') return null;
  return {
    field: raw.field,
    label: typeof raw.label === 'string' ? raw.label : undefined,
    kind: typeof raw.kind === 'string' ? raw.kind : undefined,
    type: typeof raw.type === 'string' ? raw.type : undefined,
    values: Array.isArray(raw.values) ? raw.values : [],
    isNegative: Boolean(raw.isNegative),
    modelId: typeof raw.modelId === 'string' ? raw.modelId : undefined,
    topic: typeof raw.topic === 'string' ? raw.topic : undefined,
    view: typeof raw.view === 'string' ? raw.view : undefined,
    dataType: typeof raw.dataType === 'string' ? raw.dataType : undefined,
    source: raw.source === 'dashboard-picker' || raw.source === 'tile' || raw.source === 'topic' ? raw.source : undefined,
  };
}

function sanitizeRenderStrategy(value: unknown): RenderStrategy {
  return value === 'tile-image' || value === 'full-dashboard' ? value : 'native';
}

export function sanitizeDeckDraftForStorage(baseUrl: string, input: DeckDraftInput): DeckBuilderDraft {
  const dashboard = sanitizeDashboard(input.dashboard);
  const recipe = validateRecipe({
    version: 1,
    dashboardUrl: input.dashboardUrl || dashboard?.url || '',
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
  });
  return {
    version: 1,
    savedAt: Date.now(),
    host: hostFromBaseUrl(baseUrl),
    step: sanitizeStep(input.step),
    dashboard,
    recipe,
    dashboardDefaults: input.dashboardDefaults,
    renderStrategy: sanitizeRenderStrategy(input.renderStrategy),
  };
}

export function saveDeckDraft(baseUrl: string, input: DeckDraftInput): DeckBuilderDraft | null {
  if (typeof window === 'undefined' || !baseUrl.trim()) return null;
  const draft = sanitizeDeckDraftForStorage(baseUrl, input);
  window.sessionStorage.setItem(storageKey(baseUrl), JSON.stringify(draft));
  return draft;
}

export function loadDeckDraft(baseUrl: string): DeckBuilderDraft | null {
  if (typeof window === 'undefined' || !baseUrl.trim()) return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(baseUrl));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeckBuilderDraft>;
    if (parsed.version !== 1 || !parsed.recipe) return null;
    const recipe = validateRecipe(parsed.recipe);
    return {
      version: 1,
      savedAt: Number.isFinite(parsed.savedAt) ? Number(parsed.savedAt) : Date.now(),
      host: typeof parsed.host === 'string' ? parsed.host : hostFromBaseUrl(baseUrl),
      step: sanitizeStep(parsed.step),
      dashboard: sanitizeDashboard(parsed.dashboard),
      recipe,
      dashboardDefaults: parsed.dashboardDefaults && typeof parsed.dashboardDefaults === 'object'
        ? parsed.dashboardDefaults as Record<string, FilterOverride>
        : undefined,
      renderStrategy: sanitizeRenderStrategy(parsed.renderStrategy),
    };
  } catch {
    return null;
  }
}

export function clearDeckDraft(baseUrl: string): void {
  if (typeof window === 'undefined' || !baseUrl.trim()) return;
  window.sessionStorage.removeItem(storageKey(baseUrl));
}

export function deckDraftContainsForbiddenKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => deckDraftContainsForbiddenKeys(entry));
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_STORAGE_KEYS.has(key.toLowerCase())) return true;
    if (deckDraftContainsForbiddenKeys(child)) return true;
  }
  return false;
}
