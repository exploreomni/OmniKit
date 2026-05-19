import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  AlertCircle,
  CheckCircle,
  Search,
  ArrowUp,
  ArrowDown,
  Trash2,
  Download,
  Upload,
  Save,
  RefreshCcw,
  ImagePlus,
  XCircle,
  PlayCircle,
  ChevronDown,
  Eraser,
  History,
} from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { useLogOperation } from '@/contexts/OperationLogContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { Vehicle } from '@/components/ui/Vehicle';
import { parseDashboardUrl } from '@/services/deckBuilder/dashboardUrlParser';
import {
  fetchDashboardSummary,
  fetchDashboardList,
  exportFullDashboardAsPng,
  blobToDataUrl,
  fetchFilterValueOptions,
  fetchTopicCatalog,
  getDashboardModelId,
  pickTileTemplateBody,
  seedOverridesFromDashboardFilters,
} from '@/services/deckBuilder/omniDeckApi';
import { fetchDeckFilterDefaults, upsertDeckFilterDefaults } from '@/services/omniApi';
import { runTileExports } from '@/services/deckBuilder/tileExporter';
import { deckLog } from '@/services/deckBuilder/log';
import { buildDeck, deckFileName } from '@/services/deckBuilder/pptxBuilder';
import {
  buildRecipe,
  downloadJson,
  readJsonFile,
  validateRecipe,
  validateBrand,
  fileToDataUrl,
} from '@/services/deckBuilder/deckRecipe';
import {
  dashboardCache,
  filterSetCache,
  batchHistoryCache,
  filterValuesCache,
  topicCatalogCache,
  clearAllDeckCache,
  type CachedDashboard,
  type SavedFilterSet,
  type BatchHistoryEntry,
} from '@/services/deckBuilder/localCache';
import { runBatchDecks, bundleAsZip, type BatchClientStatus } from '@/services/deckBuilder/batchRunner';
import type {
  BrandConfig,
  DashboardFilter,
  DashboardTile,
  FilterOverride,
  LayoutKit,
  RenderStrategy,
  SlideOverride,
  TileExportState,
  TileVisualSource,
  TopicFieldRef,
} from '@/services/deckBuilder/types';
import { DEFAULT_BRAND } from '@/services/deckBuilder/types';
import {
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  getDefaultTemplateId,
  setDefaultTemplateId,
  isBuiltin,
  makeLayoutKit,
} from '@/services/deckBuilder/templateStore';
import { ingestPptxTemplate } from '@/services/deckBuilder/pptxTemplateIngest';
import { DashboardSearch } from '@/components/deckBuilder/DashboardSearch';
import { FilterEditor } from '@/components/deckBuilder/FilterEditor';
import { BatchSetup } from '@/components/deckBuilder/BatchSetup';
import { SlideLayoutPreview } from '@/components/deckBuilder/SlideLayoutPreview';

type StepId = 'inspect' | 'select' | 'filters' | 'brand' | 'layout' | 'generate';

const STEPS: Array<{ id: StepId; label: string; description: string }> = [
  { id: 'inspect', label: 'Inspect', description: 'Pick a dashboard' },
  { id: 'select', label: 'Tiles', description: 'Pick & order tiles' },
  { id: 'filters', label: 'Filters', description: 'Override values' },
  { id: 'brand', label: 'Branding', description: 'Theme & template' },
  { id: 'layout', label: 'Preview', description: 'Layout, insights & notes' },
  { id: 'generate', label: 'Generate', description: 'Export to PowerPoint' },
];

interface InspectedDashboard {
  url: string;
  id: string;
  name: string;
  tiles: DashboardTile[];
  filters: DashboardFilter[];
  topics: string[];
  modelId?: string;
}

function buildDashboardUrl(baseUrl: string, dashboardId: string): string {
  try {
    const u = new URL(baseUrl);
    u.pathname = `/dashboards/${dashboardId}`;
    return u.toString();
  } catch {
    return `${baseUrl.replace(/\/$/, '')}/dashboards/${dashboardId}`;
  }
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

function strategyForTileExports(renderStrategy: RenderStrategy): RenderStrategy {
  return renderStrategy === 'full-dashboard' ? 'native' : renderStrategy;
}

export function DeckBuilderPage() {
  const { connection } = useConnection();
  const logOp = useLogOperation();

  const [step, setStep] = useState<StepId>('inspect');
  const [showUrlPaste, setShowUrlPaste] = useState(false);
  const [url, setUrl] = useState('');
  const [inspectError, setInspectError] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [dashboard, setDashboard] = useState<InspectedDashboard | null>(null);

  const [dashboards, setDashboards] = useState<CachedDashboard[]>([]);
  const [dashboardsSyncedAt, setDashboardsSyncedAt] = useState<number | null>(null);
  const [loadingDashboards, setLoadingDashboards] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tileFilter, setTileFilter] = useState('');

  const [filterOverrides, setFilterOverrides] = useState<Record<string, FilterOverride>>({});
  const [dashboardDefaults, setDashboardDefaults] = useState<Record<string, FilterOverride>>({});
  const [savedSets, setSavedSets] = useState<SavedFilterSet[]>([]);

  const [batchEnabled, setBatchEnabled] = useState(false);
  const [batchField, setBatchField] = useState<string | null>(null);
  const [batchValues, setBatchValues] = useState<string[]>([]);
  const [batchHistory, setBatchHistory] = useState<BatchHistoryEntry[]>([]);
  const [batchClientStates, setBatchClientStates] = useState<Record<string, BatchClientStatus>>({});

  const [topicFields, setTopicFields] = useState<TopicFieldRef[]>([]);
  const [topicCatalogLoading, setTopicCatalogLoading] = useState(false);
  const [topicCatalogError, setTopicCatalogError] = useState<string | null>(null);

  const [templates, setTemplates] = useState<LayoutKit[]>(() => listTemplates());
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(() => getDefaultTemplateId());
  const currentTemplate: LayoutKit = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) || templates[0],
    [templates, selectedTemplateId]
  );
  const [brand, setBrand] = useState<BrandConfig>({ ...DEFAULT_BRAND });

  useEffect(() => {
    if (currentTemplate) setBrand({ ...currentTemplate.brand });
  }, [currentTemplate]);

  const [tileVisualSources, setTileVisualSources] = useState<Record<string, TileVisualSource>>({});
  const [slideOverrides, setSlideOverrides] = useState<Record<string, SlideOverride>>({});
  const [templateImportError, setTemplateImportError] = useState<string | null>(null);
  const [templateImportWarnings, setTemplateImportWarnings] = useState<string[]>([]);
  const [templateImporting, setTemplateImporting] = useState(false);
  const [splitMastersOnImport, setSplitMastersOnImport] = useState(true);

  const [insights, setInsights] = useState<Record<string, string>>({});
  const [includeAppendix, setIncludeAppendix] = useState(true);

  const [exportStates, setExportStates] = useState<Record<string, TileExportState>>({});
  const [previewStates, setPreviewStates] = useState<Record<string, TileExportState>>({});
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [generationSuccess, setGenerationSuccess] = useState('');
  const skipFailed = true;
  const allowFullDashboardFallback = false;
  const [renderStrategy, setRenderStrategy] = useState<'native' | 'tile-image' | 'full-dashboard'>('native');
  const [expandedErrors, setExpandedErrors] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);

  const recipeFileInput = useRef<HTMLInputElement | null>(null);
  const brandFileInput = useRef<HTMLInputElement | null>(null);
  const logoFileInput = useRef<HTMLInputElement | null>(null);
  const pptxTemplateInput = useRef<HTMLInputElement | null>(null);

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const isWorkspaceStep = step === 'layout' || step === 'generate';

  const selectedTiles = useMemo(() => {
    if (!dashboard) return [];
    const lookup = new Map(dashboard.tiles.map((t) => [t.id, t]));
    return selectedIds.map((id) => lookup.get(id)).filter(Boolean) as DashboardTile[];
  }, [dashboard, selectedIds]);

  const filteredTiles = useMemo(() => {
    if (!dashboard) return [];
    const f = tileFilter.trim().toLowerCase();
    if (!f) return dashboard.tiles;
    return dashboard.tiles.filter((t) => t.name.toLowerCase().includes(f));
  }, [dashboard, tileFilter]);

  const exportReadiness = useMemo(() => {
    const sourceCounts = { native: 0, image: 0, skipped: 0, fullDashboard: 0 };
    let customizedSlides = 0;
    let insightCount = 0;
    let speakerNotesCount = 0;
    let overlayCount = 0;
    let titleOverrideCount = 0;
    let layoutOverrideCount = 0;

    for (const tile of selectedTiles) {
      const override = slideOverrides[tile.id];
      const insight = insights[tile.id]?.trim();
      const notes = override?.speakerNotes?.trim();
      const explicitSource = tileVisualSources[tile.id];
      const source = resolveTileVisualSource(renderStrategy, tileVisualSources, tile.id);

      if (source === 'full-dashboard') sourceCounts.fullDashboard += 1;
      else if (source === 'tile-image') sourceCounts.image += 1;
      else if (source === 'skip') sourceCounts.skipped += 1;
      else sourceCounts.native += 1;

      if (insight) insightCount += 1;
      if (notes) speakerNotesCount += 1;
      if (override?.overlays?.length) overlayCount += override.overlays.length;
      if (override?.title) titleOverrideCount += 1;
      if (override?.bodyBox || override?.insightBox || override?.fit) layoutOverrideCount += 1;

      if (
        insight ||
        explicitSource ||
        override?.title ||
        override?.bodyBox ||
        override?.insightBox ||
        override?.insightFormat ||
        override?.fit ||
        override?.speakerNotes ||
        override?.speakerNotesFormat ||
        (override?.overlays?.length || 0) > 0
      ) {
        customizedSlides += 1;
      }
    }

    return {
      selectedCount: selectedTiles.length,
      exportableCount: Math.max(0, selectedTiles.length - sourceCounts.skipped),
      sourceCounts,
      customizedSlides,
      insightCount,
      speakerNotesCount,
      overlayCount,
      titleOverrideCount,
      layoutOverrideCount,
      batchCount: batchEnabled && batchField && batchValues.length > 0 ? batchValues.length : 0,
    };
  }, [selectedTiles, slideOverrides, insights, tileVisualSources, renderStrategy, batchEnabled, batchField, batchValues.length]);

  const renderModeLabel = useMemo(() => {
    const activeSourceCount = [
      exportReadiness.sourceCounts.native,
      exportReadiness.sourceCounts.image,
      exportReadiness.sourceCounts.fullDashboard,
    ].filter((count) => count > 0).length;
    if (activeSourceCount > 1) return 'Mixed sources';
    if (exportReadiness.sourceCounts.fullDashboard > 0) return 'Full dashboard image';
    if (exportReadiness.sourceCounts.image > 0) return 'Omni tile images';
    if (exportReadiness.sourceCounts.native > 0) return 'Native data';
    return renderStrategy === 'full-dashboard'
      ? 'Full dashboard image'
      : renderStrategy === 'tile-image'
      ? 'Omni tile images'
      : 'Native data';
  }, [exportReadiness.sourceCounts, renderStrategy]);

  useEffect(() => {
    if (!connection.baseUrl) return;
    const cached = dashboardCache.load(connection.baseUrl);
    if (cached) {
      setDashboards(cached.data);
      setDashboardsSyncedAt(cached.savedAt);
    } else {
      setDashboards([]);
      setDashboardsSyncedAt(null);
    }
    setBatchHistory(batchHistoryCache.load(connection.baseUrl));
  }, [connection.baseUrl]);

  const refreshDashboardList = useCallback(async () => {
    if (!connection.baseUrl || !connection.apiKey) return;
    setLoadingDashboards(true);
    try {
      const list = await fetchDashboardList(connection.baseUrl, connection.apiKey);
      setDashboards(list);
      setDashboardsSyncedAt(Date.now());
      dashboardCache.save(connection.baseUrl, list);
    } catch (err) {
      deckLog.warn('inspect', 'Failed to fetch dashboard list', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoadingDashboards(false);
    }
  }, [connection.baseUrl, connection.apiKey]);

  useEffect(() => {
    if (!connection.baseUrl || !connection.apiKey) return;
    if (dashboards.length > 0) return;
    if (loadingDashboards) return;
    void refreshDashboardList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.baseUrl, connection.apiKey]);

  const loadSavedFilterSets = useCallback((dashboardId: string) => {
    if (!connection.baseUrl) return;
    setSavedSets(filterSetCache.load(connection.baseUrl, dashboardId));
  }, [connection.baseUrl]);

  const resolveFieldContext = useCallback(
    (field: string): { modelId?: string; topic?: string; candidateTopics: string[]; templateBody?: Record<string, unknown> } => {
      if (!dashboard) return { candidateTopics: [] };
      const filterMeta = dashboard.filters.find((f) => f.field === field);
      const catalogMeta = topicFields.find((f) => f.field === field);
      const modelId =
        filterMeta?.modelId ||
        catalogMeta?.modelId ||
        dashboard.modelId ||
        getDashboardModelId(dashboard.tiles);
      const topic = filterMeta?.topic || catalogMeta?.topic;
      const candidateTopics = Array.from(
        new Set([
          ...(topic ? [topic] : []),
          ...dashboard.topics,
          ...topicFields.map((f) => f.topic),
        ])
      );
      const view = filterMeta?.view || catalogMeta?.view || (field.includes('.') ? field.split('.')[0] : undefined);
      const templateBody = pickTileTemplateBody(dashboard.tiles, view);
      return { modelId, topic, candidateTopics, templateBody };
    },
    [dashboard, topicFields]
  );

  const loadFieldOptions = useCallback(
    async (field: string): Promise<string[]> => {
      if (!dashboard || !connection.baseUrl || !connection.apiKey) return [];
      const cached = filterValuesCache.load(connection.baseUrl, dashboard.id, field);
      if (filterValuesCache.isFresh(cached) && cached) return cached.values;
      const ctx = resolveFieldContext(field);
      if (!ctx.modelId) {
        if (cached) return cached.values;
        throw new Error('Could not determine the model for this filter.');
      }
      try {
        const { values } = await fetchFilterValueOptions(connection.baseUrl, connection.apiKey, {
          modelId: ctx.modelId,
          field,
          topic: ctx.topic,
          candidateTopics: ctx.candidateTopics,
          templateBody: ctx.templateBody,
        });
        filterValuesCache.save(connection.baseUrl, dashboard.id, field, values);
        return values;
      } catch (err) {
        if (cached) return cached.values;
        throw err;
      }
    },
    [dashboard, connection.baseUrl, connection.apiKey, resolveFieldContext]
  );

  const refreshFieldOptions = useCallback(
    async (field: string): Promise<string[]> => {
      if (!dashboard || !connection.baseUrl || !connection.apiKey) return [];
      const ctx = resolveFieldContext(field);
      if (!ctx.modelId) throw new Error('Could not determine the model for this filter.');
      const { values } = await fetchFilterValueOptions(connection.baseUrl, connection.apiKey, {
        modelId: ctx.modelId,
        field,
        topic: ctx.topic,
        candidateTopics: ctx.candidateTopics,
        templateBody: ctx.templateBody,
      });
      filterValuesCache.save(connection.baseUrl, dashboard.id, field, values);
      return values;
    },
    [dashboard, connection.baseUrl, connection.apiKey, resolveFieldContext]
  );

  const loadTopicCatalog = useCallback(
    async (force = false): Promise<void> => {
      if (!dashboard || !connection.baseUrl || !connection.apiKey) return;
      const modelId = dashboard.modelId || getDashboardModelId(dashboard.tiles);
      if (!modelId) {
        setTopicCatalogError('No model id detected on this dashboard.');
        return;
      }
      const cached = topicCatalogCache.load(connection.baseUrl, modelId);
      if (!force && topicCatalogCache.isFresh(cached) && cached) {
        setTopicFields(cached.fields);
        return;
      }
      setTopicCatalogLoading(true);
      setTopicCatalogError(null);
      try {
        const result = await fetchTopicCatalog(
          connection.baseUrl,
          connection.apiKey,
          modelId,
          dashboard.topics.length > 0 ? dashboard.topics : undefined
        );
        setTopicFields(result.fields);
        topicCatalogCache.save(connection.baseUrl, modelId, {
          modelId: result.modelId,
          topics: result.topics,
          fields: result.fields,
        });
        if (result.fields.length === 0 && result.errors.length > 0) {
          setTopicCatalogError(result.errors.map((e) => `${e.topic}: ${e.message}`).join(' · '));
        }
      } catch (err) {
        if (cached) {
          setTopicFields(cached.fields);
        }
        setTopicCatalogError(err instanceof Error ? err.message : 'Failed to load topic schema.');
      } finally {
        setTopicCatalogLoading(false);
      }
    },
    [dashboard, connection.baseUrl, connection.apiKey]
  );

  useEffect(() => {
    if (!dashboard) {
      setTopicFields([]);
      setTopicCatalogError(null);
      return;
    }
    void loadTopicCatalog(false);
  }, [dashboard, loadTopicCatalog]);

  const inspectByIdAndName = useCallback(async (dashboardId: string, dashboardUrl: string) => {
    setInspectError('');
    setInspecting(true);
    try {
      const summary = await fetchDashboardSummary(connection.baseUrl, connection.apiKey, dashboardId);
      if (summary.tiles.length === 0) {
        throw new Error('No tiles were found on this dashboard.');
      }
      const next: InspectedDashboard = {
        url: dashboardUrl,
        id: dashboardId,
        name: summary.name,
        tiles: summary.tiles,
        filters: summary.filters,
        topics: summary.topics,
        modelId: summary.modelId,
      };
      setDashboard(next);
      setSelectedIds(next.tiles.map((t) => t.id));
      const liveSeed = seedOverridesFromDashboardFilters(next.filters);
      let resolvedSeed = liveSeed;
      if (Object.keys(liveSeed).length === 0) {
        const remote = await fetchDeckFilterDefaults(connection.baseUrl, dashboardId);
        if (remote && remote.defaults && typeof remote.defaults === 'object') {
          resolvedSeed = remote.defaults as Record<string, FilterOverride>;
        }
      } else {
        void upsertDeckFilterDefaults(connection.baseUrl, dashboardId, summary.name, liveSeed);
      }
      setDashboardDefaults(resolvedSeed);
      setFilterOverrides(resolvedSeed);
      setBatchEnabled(false);
      setBatchField(null);
      setBatchValues([]);
      setSlideOverrides({});
      setPreviewStates({});
      setPreviewError('');
      loadSavedFilterSets(dashboardId);
      setStep('select');
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : 'Failed to inspect dashboard.');
    } finally {
      setInspecting(false);
    }
  }, [connection.baseUrl, connection.apiKey, loadSavedFilterSets]);

  const handlePickDashboard = useCallback(
    (d: CachedDashboard) => {
      const dashUrl = buildDashboardUrl(connection.baseUrl, d.id);
      setUrl(dashUrl);
      void inspectByIdAndName(d.id, dashUrl);
    },
    [connection.baseUrl, inspectByIdAndName]
  );

  const handleInspectFromUrl = useCallback(async () => {
    setInspectError('');
    try {
      const parsed = parseDashboardUrl(url, connection.baseUrl);
      await inspectByIdAndName(parsed.dashboardId, url);
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : 'Failed to inspect dashboard.');
    }
  }, [url, connection.baseUrl, inspectByIdAndName]);

  const toggleTile = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const moveSelected = useCallback((id: string, dir: -1 | 1) => {
    setSelectedIds((prev) => {
      const idx = prev.indexOf(id);
      if (idx === -1) return prev;
      const next = [...prev];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  }, []);

  const handleLogoUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Logo must be an image file.');
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    setBrand((b) => ({ ...b, logoDataUrl: dataUrl }));
  }, []);

  const handleBrandImport = useCallback(async (file: File) => {
    try {
      const data = await readJsonFile(file);
      const next = validateBrand(data);
      if (!next) throw new Error('Brand JSON is missing required fields.');
      setBrand(next);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to import brand JSON.');
    }
  }, []);

  const refreshTemplates = useCallback(() => {
    setTemplates(listTemplates());
  }, []);

  const handlePptxTemplateUpload = useCallback(async (file: File) => {
    setTemplateImportError(null);
    setTemplateImportWarnings([]);
    setTemplateImporting(true);
    try {
      const { kits, warnings } = await ingestPptxTemplate(file, { splitMasters: splitMastersOnImport });
      for (const kit of kits) {
        saveTemplate(kit);
      }
      refreshTemplates();
      if (kits[0]) {
        setSelectedTemplateId(kits[0].id);
        setBrand({ ...kits[0].brand });
      }
      setTemplateImportWarnings(warnings);
    } catch (err) {
      setTemplateImportError(err instanceof Error ? err.message : 'Failed to ingest .pptx');
    } finally {
      setTemplateImporting(false);
    }
  }, [refreshTemplates, splitMastersOnImport]);

  const handleSaveAsTemplate = useCallback(() => {
    const name = window.prompt('Template name?', brand.name || 'My template');
    if (!name) return;
    const kit = makeLayoutKit(`user-${Date.now()}`, name, brand, 'json');
    saveTemplate(kit);
    refreshTemplates();
    setSelectedTemplateId(kit.id);
  }, [brand, refreshTemplates]);

  const handleUpdateTemplate = useCallback(() => {
    if (!currentTemplate || isBuiltin(currentTemplate.id)) return;
    const updated: LayoutKit = { ...currentTemplate, brand: { ...brand }, importedAt: Date.now() };
    saveTemplate(updated);
    refreshTemplates();
  }, [currentTemplate, brand, refreshTemplates]);

  const handleDeleteTemplate = useCallback(() => {
    if (!currentTemplate || isBuiltin(currentTemplate.id)) return;
    if (!window.confirm(`Delete template "${currentTemplate.name}"?`)) return;
    deleteTemplate(currentTemplate.id);
    refreshTemplates();
    setSelectedTemplateId('builtin-omnikit');
  }, [currentTemplate, refreshTemplates]);

  const handleSetDefaultTemplate = useCallback(() => {
    setDefaultTemplateId(selectedTemplateId);
  }, [selectedTemplateId]);

  const setTileVisualSource = useCallback((tileId: string, src: TileVisualSource) => {
    setTileVisualSources((prev) => ({ ...prev, [tileId]: src }));
  }, []);

  const applyVisualSourceToAll = useCallback((strategy: RenderStrategy) => {
    setRenderStrategy(strategy);
    setTileVisualSources({});
    setPreviewStates({});
    setExportStates({});
  }, []);

  useEffect(() => {
    setPreviewStates({});
    setPreviewError('');
  }, [renderStrategy, tileVisualSources, filterOverrides, batchEnabled, batchField, batchValues]);

  const handleRecipeImport = useCallback(async (file: File) => {
    try {
      const data = await readJsonFile(file);
      const recipe = validateRecipe(data);
      setUrl(recipe.dashboardUrl);
      setBrand(recipe.brand);
      setInsights(recipe.insights);
      setIncludeAppendix(recipe.includeAppendix);
      if (recipe.templateId) {
        const kit = getTemplate(recipe.templateId);
        if (kit) setSelectedTemplateId(kit.id);
      }
      if (recipe.tileVisualSources) {
        setTileVisualSources(recipe.tileVisualSources);
      } else {
        setTileVisualSources({});
      }
      setSlideOverrides(recipe.slideOverrides || {});
      setInspectError('');
      setInspecting(true);
      try {
        const parsed = parseDashboardUrl(recipe.dashboardUrl, connection.baseUrl);
        const summary = await fetchDashboardSummary(connection.baseUrl, connection.apiKey, parsed.dashboardId);
        const next: InspectedDashboard = {
          url: recipe.dashboardUrl,
          id: parsed.dashboardId,
          name: summary.name,
          tiles: summary.tiles,
          filters: summary.filters,
          topics: summary.topics,
          modelId: summary.modelId,
        };
        setDashboard(next);
        const validIds = new Set(summary.tiles.map((t) => t.id));
        setSelectedIds(recipe.selectedTileIds.filter((id) => validIds.has(id)));
        const liveSeed = seedOverridesFromDashboardFilters(next.filters);
        setDashboardDefaults(liveSeed);
        setFilterOverrides(
          recipe.filterOverrides && Object.keys(recipe.filterOverrides).length > 0
            ? recipe.filterOverrides
            : liveSeed,
        );
        if (recipe.batch) {
          setBatchEnabled(true);
          setBatchField(recipe.batch.filterField);
          setBatchValues(recipe.batch.values);
        } else {
          setBatchEnabled(false);
          setBatchField(null);
          setBatchValues([]);
        }
        loadSavedFilterSets(parsed.dashboardId);
        setStep('select');
      } finally {
        setInspecting(false);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to load deck recipe.');
    }
  }, [connection.baseUrl, connection.apiKey, loadSavedFilterSets]);

  const handleSaveFilterSet = useCallback((name: string) => {
    if (!dashboard || !connection.baseUrl) return;
    const set: SavedFilterSet = {
      id: `set_${Date.now()}`,
      name,
      savedAt: Date.now(),
      overrides: filterOverrides,
    };
    const next = [set, ...savedSets].slice(0, 20);
    setSavedSets(next);
    filterSetCache.save(connection.baseUrl, dashboard.id, next);
  }, [dashboard, connection.baseUrl, filterOverrides, savedSets]);

  const handleSingleGenerate = useCallback(async () => {
    if (!dashboard || selectedTiles.length === 0) return;
    setGenerating(true);
    setGenerationError('');
    setGenerationSuccess('');
    setExportStates({});
    abortRef.current = new AbortController();
    const start = Date.now();

    try {
      let workingStates: Record<string, TileExportState> = {};
      let usedFallback = false;
      let usedFullDashboardImage = false;
      const sourceFor = (tile: DashboardTile) => resolveTileVisualSource(renderStrategy, tileVisualSources, tile.id);
      const fullDashboardTiles = selectedTiles.filter((tile) => sourceFor(tile) === 'full-dashboard');
      const exportTiles = selectedTiles.filter((tile) => sourceFor(tile) !== 'full-dashboard');

      if (fullDashboardTiles.length > 0) {
        for (const tile of fullDashboardTiles) {
          workingStates[tile.id] = { tileId: tile.id, status: 'exporting', message: 'Awaiting full dashboard' };
          setExportStates((prev) => ({ ...prev, [tile.id]: workingStates[tile.id] }));
        }
        const fallbackBlob = await exportFullDashboardAsPng(
          connection.baseUrl,
          connection.apiKey,
          dashboard.id,
          abortRef.current.signal
        );
        const dataUrl = await blobToDataUrl(fallbackBlob);
        for (const tile of fullDashboardTiles) {
          workingStates[tile.id] = {
            tileId: tile.id,
            status: 'done',
            message: 'Full-dashboard image',
            pngDataUrl: dataUrl,
            pngSize: fallbackBlob.size,
          };
          setExportStates((prev) => ({ ...prev, [tile.id]: workingStates[tile.id] }));
        }
        usedFullDashboardImage = true;
      }

      if (exportTiles.length > 0) {
        const perTileSource = Object.fromEntries(
          exportTiles.map((tile) => [tile.id, sourceFor(tile)] as const)
        ) as Record<string, TileVisualSource>;
        const { states } = await runTileExports({
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey,
          dashboardId: dashboard.id,
          tiles: exportTiles,
          strategy: strategyForTileExports(renderStrategy),
          perTileSource,
          signal: abortRef.current.signal,
          filterOverrides,
          onUpdate: (state) => setExportStates((prev) => ({ ...prev, [state.tileId]: state })),
        });
        workingStates = { ...workingStates, ...states };

        const initialSuccess = exportTiles.filter((t) => states[t.id]?.status === 'done');
        if (initialSuccess.length === 0 && fullDashboardTiles.length === 0 && allowFullDashboardFallback) {
          const fallbackBlob = await exportFullDashboardAsPng(
            connection.baseUrl,
            connection.apiKey,
            dashboard.id,
            abortRef.current.signal
          );
          const dataUrl = await blobToDataUrl(fallbackBlob);
          workingStates = { ...states };
          for (const tile of selectedTiles) {
            workingStates[tile.id] = {
              tileId: tile.id,
              status: 'done',
              message: 'Full-dashboard fallback',
              pngDataUrl: dataUrl,
              pngSize: fallbackBlob.size,
            };
            setExportStates((prev) => ({ ...prev, [tile.id]: workingStates[tile.id] }));
          }
          usedFallback = true;
        }
      }

      const successful = selectedTiles.filter((t) => {
        const s = workingStates[t.id];
        return s?.status === 'done' && (s.pngDataUrl || s.result);
      });
      const skippedCount = selectedTiles.filter((t) => workingStates[t.id]?.status === 'skipped').length;
      const failedCount = selectedTiles.length - successful.length - skippedCount;

      if (successful.length === 0) {
        throw new Error('No tiles produced output. Review the tile export status below, then retry with fewer tiles or a different render mode.');
      }
      if (failedCount > 0 && !skipFailed) {
        throw new Error(`${failedCount} tile(s) failed. Enable "skip failed tiles" to continue.`);
      }

      const generatedAt = new Date();
      const blob = await buildDeck({
        dashboardName: dashboard.name,
        dashboardUrl: dashboard.url,
        generatedAt,
        brand,
        template: currentTemplate,
        tiles: successful.map((tile) => {
          const s = workingStates[tile.id];
          const src = sourceFor(tile);
          return {
            tile,
            pngDataUrl: s.pngDataUrl,
            result: s.result,
            insight: insights[tile.id],
            forceImage: src === 'tile-image' || src === 'full-dashboard',
            slideOverride: slideOverrides[tile.id],
          };
        }),
        includeAppendix,
      });

      const fileName = deckFileName(dashboard.name, generatedAt);
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 500);

      setGenerationSuccess(
        usedFallback
          ? `Deck downloaded as "${fileName}" using full-dashboard fallback.`
          : usedFullDashboardImage
          ? `Deck downloaded as "${fileName}" with full-dashboard image slide(s).`
          : failedCount > 0
          ? `Deck downloaded as "${fileName}". ${failedCount} tile(s) skipped.`
          : `Deck downloaded as "${fileName}".`
      );
      logOp('download', `Deck "${dashboard.name}" with ${successful.length} tiles`, {
        durationMs: Date.now() - start,
        itemCount: selectedTiles.length,
        successCount: successful.length,
        failureCount: failedCount,
      });
    } catch (err) {
      setGenerationError(err instanceof Error ? err.message : 'Deck generation failed.');
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }, [dashboard, selectedTiles, connection, brand, currentTemplate, insights, includeAppendix, skipFailed, allowFullDashboardFallback, renderStrategy, filterOverrides, tileVisualSources, slideOverrides, logOp]);

  const handleBatchGenerate = useCallback(async () => {
    if (!dashboard || selectedTiles.length === 0 || !batchField || batchValues.length === 0) return;
    setGenerating(true);
    setGenerationError('');
    setGenerationSuccess('');
    setBatchClientStates({});
    abortRef.current = new AbortController();
    const start = Date.now();

    const initialStates: Record<string, BatchClientStatus> = {};
    for (const v of batchValues) {
      initialStates[v] = { value: v, status: 'pending', succeededTiles: 0, failedTiles: 0 };
    }
    setBatchClientStates(initialStates);

    try {
      const filterMeta = dashboard.filters.find((f) => f.field === batchField);
      const result = await runBatchDecks({
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        dashboardId: dashboard.id,
        dashboardName: dashboard.name,
        dashboardUrl: dashboard.url,
        tiles: selectedTiles,
        brand,
        insights,
        includeAppendix,
        baseFilterOverrides: filterOverrides,
        batchField,
        batchFieldKind: filterMeta?.kind,
        batchFieldType: filterMeta?.type,
        values: batchValues,
        strategy: renderStrategy,
        perTileSource: tileVisualSources,
        slideOverrides,
        template: currentTemplate,
        allowFullDashboardFallback,
        signal: abortRef.current.signal,
        onClientUpdate: (status) => setBatchClientStates((prev) => ({ ...prev, [status.value]: status })),
      });

      if (result.files.length === 0) {
        throw new Error('No client decks were generated.');
      }

      const generatedAt = new Date();
      const zipBlob = await bundleAsZip(result.files, {
        dashboard: dashboard.name,
        dashboardUrl: dashboard.url,
        filterField: batchField,
        clientCount: batchValues.length,
        succeeded: result.succeeded,
        failed: result.failed,
        generatedAt: generatedAt.toISOString(),
      });

      const zipName = `${dashboard.name.replace(/[^a-z0-9-]+/gi, '_')}_batch_${generatedAt.toISOString().slice(0, 10)}.zip`;
      const downloadUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 500);

      const summary = `Batch zip "${zipName}" downloaded · ${result.succeeded}/${batchValues.length} decks succeeded.`;
      setGenerationSuccess(summary);

      const entry: BatchHistoryEntry = {
        id: `batch_${Date.now()}`,
        dashboardId: dashboard.id,
        dashboardName: dashboard.name,
        filterField: batchField,
        values: batchValues,
        generatedAt: Date.now(),
        succeeded: result.succeeded,
        failed: result.failed,
      };
      batchHistoryCache.push(connection.baseUrl, entry);
      setBatchHistory(batchHistoryCache.load(connection.baseUrl));

      logOp('download', `Batch deck "${dashboard.name}" × ${batchValues.length}`, {
        durationMs: Date.now() - start,
        itemCount: batchValues.length,
        successCount: result.succeeded,
        failureCount: result.failed,
      });
    } catch (err) {
      setGenerationError(err instanceof Error ? err.message : 'Batch generation failed.');
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }, [dashboard, selectedTiles, batchField, batchValues, connection, brand, currentTemplate, insights, includeAppendix, filterOverrides, renderStrategy, tileVisualSources, slideOverrides, allowFullDashboardFallback, logOp]);

  const handleGenerate = batchEnabled && batchField && batchValues.length > 0
    ? handleBatchGenerate
    : handleSingleGenerate;

  const cancelGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const previewSampleLabel = batchEnabled && batchField && batchValues.length > 0
    ? `${batchField} = ${batchValues[0]}`
    : undefined;

  const handleRenderPreview = useCallback(async (tileId?: string) => {
    if (!dashboard || selectedTiles.length === 0) return;
    const previewTiles = tileId
      ? selectedTiles.filter((tile) => tile.id === tileId)
      : selectedTiles;
    if (previewTiles.length === 0) return;
    setPreviewing(true);
    setPreviewError('');
    setPreviewStates((prev) => {
      const next = { ...prev };
      for (const tile of previewTiles) delete next[tile.id];
      return next;
    });
    const controller = new AbortController();
    const previewOverrides: Record<string, FilterOverride> = { ...filterOverrides };
    if (batchEnabled && batchField && batchValues.length > 0) {
      const filterMeta = dashboard.filters.find((f) => f.field === batchField);
      previewOverrides[batchField] = {
        field: batchField,
        kind: filterMeta?.kind ?? 'EQUALS',
        type: filterMeta?.type ?? 'string',
        values: [batchValues[0]],
      };
    }

    try {
      const sourceFor = (tile: DashboardTile) => resolveTileVisualSource(renderStrategy, tileVisualSources, tile.id);
      const fullDashboardTiles = previewTiles.filter((tile) => sourceFor(tile) === 'full-dashboard');
      const exportTiles = previewTiles.filter((tile) => sourceFor(tile) !== 'full-dashboard');

      if (fullDashboardTiles.length > 0) {
        const blob = await exportFullDashboardAsPng(
          connection.baseUrl,
          connection.apiKey,
          dashboard.id,
          controller.signal,
        );
        const dataUrl = await blobToDataUrl(blob);
        const next = Object.fromEntries(
          fullDashboardTiles.map((tile) => [
            tile.id,
            {
              tileId: tile.id,
              status: 'done' as const,
              message: 'Full dashboard preview',
              pngDataUrl: dataUrl,
              pngSize: blob.size,
            },
          ]),
        );
        setPreviewStates((prev) => ({ ...prev, ...next }));
      }

      if (exportTiles.length > 0) {
        const perTileSource = Object.fromEntries(
          exportTiles.map((tile) => [tile.id, sourceFor(tile)] as const)
        ) as Record<string, TileVisualSource>;
        const { states } = await runTileExports({
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey,
          dashboardId: dashboard.id,
          tiles: exportTiles,
          strategy: strategyForTileExports(renderStrategy),
          perTileSource,
          signal: controller.signal,
          filterOverrides: previewOverrides,
          onUpdate: (state) => setPreviewStates((prev) => ({ ...prev, [state.tileId]: state })),
        });
        setPreviewStates((prev) => ({ ...prev, ...states }));
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Preview rendering failed.');
    } finally {
      setPreviewing(false);
    }
  }, [
    dashboard,
    selectedTiles,
    filterOverrides,
    batchEnabled,
    batchField,
    batchValues,
    renderStrategy,
    connection.baseUrl,
    connection.apiKey,
    tileVisualSources,
  ]);

  const handleSaveRecipe = useCallback(() => {
    if (!dashboard) return;
    const recipe = buildRecipe({
      dashboardUrl: dashboard.url,
      selectedTileIds: selectedIds,
      insights,
      brand,
      includeAppendix,
      generatedFrom: connection.baseUrl,
      filterOverrides: Object.keys(filterOverrides).length > 0 ? filterOverrides : undefined,
      batch: batchEnabled && batchField ? { filterField: batchField, values: batchValues } : undefined,
      templateId: currentTemplate?.id,
      tileVisualSources: Object.keys(tileVisualSources).length > 0 ? tileVisualSources : undefined,
      slideOverrides: Object.keys(slideOverrides).length > 0 ? slideOverrides : undefined,
    });
    const filename = `${deckFileName(dashboard.name, new Date()).replace(/\.pptx$/, '')}.recipe.json`;
    downloadJson(filename, recipe);
  }, [dashboard, selectedIds, insights, brand, includeAppendix, connection.baseUrl, filterOverrides, batchEnabled, batchField, batchValues, currentTemplate, tileVisualSources, slideOverrides]);

  const handleSaveBrand = useCallback(() => {
    const filename = `${(brand.name || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.brand.json`;
    downloadJson(filename, brand);
  }, [brand]);

  const handleClearLocalCache = useCallback(() => {
    if (!connection.baseUrl) return;
    if (!window.confirm('Clear all locally cached dashboards, filter sets, and batch history for this Omni instance?')) return;
    clearAllDeckCache(connection.baseUrl);
    setDashboards([]);
    setDashboardsSyncedAt(null);
    setSavedSets([]);
    setBatchHistory([]);
  }, [connection.baseUrl]);

  function gotoStep(target: StepId) {
    const targetIdx = STEPS.findIndex((s) => s.id === target);
    if (targetIdx <= stepIndex || dashboard) {
      setStep(target);
    }
  }

  return (
    <div className={isWorkspaceStep ? 'space-y-5' : 'space-y-6'}>
      <PageHeader
        title="Deck Builder"
        description="Turn an Omni dashboard into a branded PowerPoint deck."
        icon={<Blobby mood="deck-package" size={58} className="animate-float" style={{ animationDuration: '3.5s' }} />}
        actions={
          <button
            onClick={handleClearLocalCache}
            className="btn-ghost btn-sm"
            type="button"
            title="Clear locally cached dashboards, filter sets, and batch history"
          >
            <Eraser size={12} /> Clear local cache
          </button>
        }
      />

      <div className={`card ${isWorkspaceStep ? 'p-3' : ''}`}>
        <div className={`flex items-center justify-between overflow-x-auto ${isWorkspaceStep ? 'gap-1.5' : 'gap-2'}`}>
          {STEPS.map((s, idx) => {
            const isActive = idx === stepIndex;
            const isDone = idx < stepIndex;
            const reachable = idx <= stepIndex || dashboard;
            return (
              <button
                key={s.id}
                disabled={!reachable}
                onClick={() => gotoStep(s.id)}
                className={`${isWorkspaceStep ? 'min-w-[92px] px-2 py-1' : 'min-w-[120px]'} flex-1 text-left disabled:cursor-not-allowed rounded-button transition-colors hover:bg-surface-secondary`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`${isWorkspaceStep ? 'w-6 h-6 text-[11px]' : 'w-7 h-7 text-xs'} rounded-full flex items-center justify-center font-bold flex-shrink-0`}
                    style={
                      isActive
                        ? { background: '#C8186A', color: '#fff', boxShadow: '0 0 0 4px rgba(255,71,148,0.18)' }
                        : isDone
                        ? { background: '#FF4794', color: '#fff' }
                        : { background: 'rgba(255,71,148,0.12)', color: '#9B3065' }
                    }
                  >
                    {isDone ? <CheckCircle size={isWorkspaceStep ? 12 : 14} /> : idx + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold tracking-tight" style={{ color: isActive ? '#C8186A' : '#1A0818' }}>
                      {s.label}
                    </div>
                    <div className={`${isWorkspaceStep ? 'hidden 2xl:block' : ''} text-[10px] text-content-tertiary`}>
                      {s.description}
                    </div>
                  </div>
                </div>
                {!isWorkspaceStep && idx < STEPS.length - 1 && (
                  <div
                    className="h-px mt-2 ml-9"
                    style={{ background: idx < stepIndex ? '#FF4794' : 'rgba(255,71,148,0.18)' }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {step === 'inspect' && (
        <div className="card space-y-4">
          <div>
            <label className="block text-xs font-medium text-content-secondary mb-1.5">
              Search your dashboards
            </label>
            <DashboardSearch
              dashboards={dashboards}
              loading={loadingDashboards || inspecting}
              lastSyncedAt={dashboardsSyncedAt}
              onRefresh={refreshDashboardList}
              onPick={handlePickDashboard}
              disabled={inspecting}
            />
          </div>

          <button
            type="button"
            onClick={() => setShowUrlPaste((s) => !s)}
            className="text-[11px] text-omni-700 hover:underline"
          >
            {showUrlPaste ? 'Hide URL input' : 'Or paste a dashboard URL instead'}
          </button>

          {showUrlPaste && (
            <div>
              <div className="flex gap-2">
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={`${connection.baseUrl || 'https://your-omni.com'}/dashboards/<id>`}
                  className="input-field flex-1"
                  onKeyDown={(e) => e.key === 'Enter' && handleInspectFromUrl()}
                />
                <button
                  onClick={handleInspectFromUrl}
                  disabled={inspecting || !url.trim()}
                  className="btn-primary"
                >
                  {inspecting ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                  Inspect
                </button>
              </div>
            </div>
          )}

          {inspectError && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">
              <AlertCircle size={16} />
              {inspectError}
            </div>
          )}

          <div className="flex items-center gap-3 pt-3 border-t border-border">
            <button onClick={() => recipeFileInput.current?.click()} className="btn-secondary" type="button">
              <Upload size={14} />
              Load deck recipe
            </button>
            <input
              ref={recipeFileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleRecipeImport(f);
                e.target.value = '';
              }}
            />
            <span className="text-[11px] text-content-tertiary">
              Or import a previously saved JSON recipe to skip ahead.
            </span>
          </div>

          {batchHistory.length > 0 && (
            <div className="pt-3 border-t border-border">
              <div className="flex items-center gap-2 text-[11px] font-medium text-content-secondary mb-2">
                <History size={12} /> Recent batch runs (local)
              </div>
              <div className="space-y-1.5">
                {batchHistory.slice(0, 5).map((h) => (
                  <div
                    key={h.id}
                    className="flex items-center justify-between p-2 rounded-card border border-border bg-white"
                  >
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium text-content-primary truncate">
                        {h.dashboardName}
                      </div>
                      <div className="text-[10px] text-content-tertiary truncate">
                        {h.filterField || 'no filter'} · {h.values.length} client(s) · {h.succeeded} ok / {h.failed} failed
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {step === 'select' && dashboard && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="card space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-content-primary">{dashboard.name}</h2>
                <p className="text-[11px] text-content-tertiary">{dashboard.tiles.length} tile(s) available</p>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => setSelectedIds(dashboard.tiles.map((t) => t.id))}
                  className="btn-ghost btn-sm"
                  type="button"
                >
                  All
                </button>
                <button onClick={() => setSelectedIds([])} className="btn-ghost btn-sm" type="button">
                  None
                </button>
              </div>
            </div>
            <div className="relative">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-content-tertiary" />
              <input
                value={tileFilter}
                onChange={(e) => setTileFilter(e.target.value)}
                placeholder="Filter tiles..."
                className="input-field pl-8"
              />
            </div>
            <div className="max-h-[420px] overflow-y-auto space-y-1.5">
              {filteredTiles.map((tile) => {
                const checked = selectedIds.includes(tile.id);
                return (
                  <label
                    key={tile.id}
                    className="flex items-start gap-2.5 p-2.5 rounded-card border border-border hover:border-omni-500/40 cursor-pointer"
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleTile(tile.id)} />
                    <div className="min-w-0">
                      <div className="text-[13px] text-content-primary truncate">{tile.name}</div>
                      {tile.section && (
                        <div className="text-[10px] text-content-tertiary truncate">{tile.section}</div>
                      )}
                    </div>
                  </label>
                );
              })}
              {filteredTiles.length === 0 && (
                <p className="text-xs text-content-tertiary py-4 text-center">No tiles match.</p>
              )}
            </div>
          </div>

          <div className="card space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-content-primary">
                Slide order ({selectedTiles.length})
              </h2>
              <span className="text-[11px] text-content-tertiary">One tile per slide</span>
            </div>
            <div className="max-h-[420px] overflow-y-auto space-y-1.5">
              {selectedTiles.length === 0 && (
                <p className="text-xs text-content-tertiary py-6 text-center">
                  Select tiles to see them here.
                </p>
              )}
              {selectedTiles.map((tile, idx) => (
                <div
                  key={tile.id}
                  className="flex items-center gap-2 p-2.5 rounded-card border border-border bg-white"
                >
                  <span
	                    className="w-6 h-6 rounded-full bg-surface-secondary text-[11px] flex items-center justify-center font-semibold"
                    style={{ color: '#C8186A' }}
                  >
                    {idx + 1}
                  </span>
                  <span className="flex-1 text-[13px] text-content-primary truncate">{tile.name}</span>
                  <button
                    onClick={() => moveSelected(tile.id, -1)}
                    disabled={idx === 0}
                    className="btn-ghost btn-sm p-1.5"
                    type="button"
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    onClick={() => moveSelected(tile.id, 1)}
                    disabled={idx === selectedTiles.length - 1}
                    className="btn-ghost btn-sm p-1.5"
                    type="button"
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    onClick={() => toggleTile(tile.id)}
                    className="btn-ghost btn-sm p-1.5 text-red-500 hover:text-red-600"
                    type="button"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex justify-between items-center pt-3 border-t border-border">
              <button onClick={() => setStep('inspect')} className="btn-ghost btn-sm">
                Back
              </button>
              <button
                onClick={() => setStep('filters')}
                disabled={selectedTiles.length === 0}
                className="btn-primary"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'filters' && dashboard && (
        <div className="card space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-content-primary">Filters</h2>
            <p className="text-[11px] text-content-tertiary">
              Override the values used when running each tile&apos;s query. Saved sets stay in your browser only.
            </p>
          </div>

          <FilterEditor
            filters={dashboard.filters}
            topicFields={topicFields}
            overrides={filterOverrides}
            dashboardDefaults={dashboardDefaults}
            onChange={setFilterOverrides}
            savedSets={savedSets}
            onSaveSet={handleSaveFilterSet}
            onLoadSet={(set) => setFilterOverrides(set.overrides)}
            onReset={() => setFilterOverrides(dashboardDefaults)}
            onClearAll={() => setFilterOverrides({})}
            loadFieldOptions={loadFieldOptions}
            refreshFieldOptions={refreshFieldOptions}
          />

          <BatchSetup
            filters={dashboard.filters}
            topicFields={topicFields}
            topicCatalogLoading={topicCatalogLoading}
            topicCatalogError={topicCatalogError}
            onRefreshCatalog={() => void loadTopicCatalog(true)}
            enabled={batchEnabled}
            onEnabledChange={setBatchEnabled}
            filterField={batchField}
            onFilterFieldChange={setBatchField}
            values={batchValues}
            onValuesChange={setBatchValues}
            loadFieldOptions={loadFieldOptions}
            refreshFieldOptions={refreshFieldOptions}
          />

          <div className="flex justify-between items-center pt-3 border-t border-border">
            <button onClick={() => setStep('select')} className="btn-ghost btn-sm">
              Back
            </button>
            <button onClick={() => setStep('brand')} className="btn-primary">
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'brand' && (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
          <div className="card space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-content-primary">Templates</h3>
              <button onClick={refreshTemplates} className="btn-ghost btn-sm" type="button" title="Refresh library">
                <RefreshCcw size={12} />
              </button>
            </div>
            <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
              {templates.map((kit) => {
                const isCurrent = kit.id === selectedTemplateId;
                const builtin = isBuiltin(kit.id);
                return (
                  <button
                    key={kit.id}
                    type="button"
                    onClick={() => setSelectedTemplateId(kit.id)}
                    className={`w-full text-left p-2.5 rounded-card border transition ${
	                      isCurrent ? 'border-omni-500 bg-surface-secondary' : 'border-border bg-white hover:border-omni-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[12px] font-semibold text-content-primary truncate">{kit.name}</span>
                      <span
                        className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
                        style={{
                          background: builtin ? 'rgba(107,114,128,0.12)' : 'rgba(255,71,148,0.15)',
                          color: builtin ? '#4B5563' : '#C8186A',
                        }}
                      >
                        {kit.source}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded border border-border" style={{ background: `#${kit.brand.primaryColor.replace(/^#/, '')}` }} />
                      <span className="w-3 h-3 rounded border border-border" style={{ background: `#${kit.brand.accentColor.replace(/^#/, '')}` }} />
                      <span className="text-[10px] text-content-tertiary truncate">{kit.brand.fontFamily}</span>
                    </div>
                    {(() => {
                      const decoCount = kit.layouts.reduce((sum, l) => sum + (l.decorations?.length || 0), 0);
                      if (kit.source !== 'pptx') return null;
                      return (
                        <div className="text-[10px] text-content-tertiary mt-1">
                          {decoCount > 0
                            ? `${decoCount} decoration${decoCount === 1 ? '' : 's'} captured`
                            : 'No decorations captured — using defaults'}
                        </div>
                      );
                    })()}
                  </button>
                );
              })}
            </div>
            <div className="pt-3 border-t border-border space-y-2">
              <button
                onClick={() => pptxTemplateInput.current?.click()}
                className="btn-secondary w-full justify-center"
                type="button"
                disabled={templateImporting}
              >
                <Upload size={13} /> {templateImporting ? 'Parsing…' : 'Upload .pptx template'}
              </button>
              <label className="flex items-center gap-2 text-[11px] text-content-secondary">
                <input
                  type="checkbox"
                  checked={splitMastersOnImport}
                  onChange={(e) => setSplitMastersOnImport(e.target.checked)}
                />
                Split masters into separate kits
              </label>
              <input
                ref={pptxTemplateInput}
                type="file"
                accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handlePptxTemplateUpload(f);
                  e.target.value = '';
                }}
              />
              <button onClick={() => brandFileInput.current?.click()} className="btn-ghost btn-sm w-full justify-center" type="button">
                <Upload size={12} /> Import brand JSON
              </button>
              <input
                ref={brandFileInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleBrandImport(f);
                  e.target.value = '';
                }}
              />
              <button onClick={handleSetDefaultTemplate} className="btn-ghost btn-sm w-full justify-center" type="button">
                Set as default
              </button>
            </div>
            {templateImportError && (
              <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-card p-2">
                {templateImportError}
              </div>
            )}
            {templateImportWarnings.length > 0 && (
              <div className="text-[11px] text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-card p-2 space-y-0.5">
                {templateImportWarnings.map((w, i) => <div key={i}>{w}</div>)}
              </div>
            )}
          </div>

          <div className="card space-y-5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-content-primary truncate">{currentTemplate?.name || 'Branding'}</h2>
                <p className="text-[11px] text-content-tertiary truncate">
                  {currentTemplate?.source === 'pptx' && currentTemplate.sourceFileName
                    ? `Imported from ${currentTemplate.sourceFileName} · ${currentTemplate.layouts.length} layout(s)`
                    : `${currentTemplate?.layouts.length ?? 0} layout(s)`}
                </p>
              </div>
              <div className="flex gap-2">
                {!isBuiltin(currentTemplate?.id || '') && (
                  <>
                    <button onClick={handleUpdateTemplate} className="btn-ghost btn-sm" type="button">
                      <Save size={12} /> Update template
                    </button>
                    <button onClick={handleDeleteTemplate} className="btn-ghost btn-sm text-red-600 hover:text-red-700" type="button">
                      <Trash2 size={12} /> Delete
                    </button>
                  </>
                )}
                <button onClick={handleSaveAsTemplate} className="btn-ghost btn-sm" type="button">
                  <Save size={12} /> Save as new
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-content-secondary mb-1">Theme name</label>
                <input value={brand.name} onChange={(e) => setBrand({ ...brand, name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block text-xs font-medium text-content-secondary mb-1">Font family</label>
                <input value={brand.fontFamily} onChange={(e) => setBrand({ ...brand, fontFamily: e.target.value })} className="input-field" />
              </div>
              <ColorField label="Primary" value={brand.primaryColor} onChange={(v) => setBrand({ ...brand, primaryColor: v })} />
              <ColorField label="Accent" value={brand.accentColor} onChange={(v) => setBrand({ ...brand, accentColor: v })} />
              <ColorField label="Title text" value={brand.titleColor} onChange={(v) => setBrand({ ...brand, titleColor: v })} />
              <ColorField label="Background" value={brand.backgroundColor} onChange={(v) => setBrand({ ...brand, backgroundColor: v })} />
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-content-secondary mb-1">Footer text</label>
                <input value={brand.footerText} onChange={(e) => setBrand({ ...brand, footerText: e.target.value })} className="input-field" />
              </div>
            </div>

            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-content-tertiary mb-2">Table header style</div>
              <div className="flex gap-2">
                {([
                  { id: 'brand', label: 'Brand primary' },
                  { id: 'neutral', label: 'Neutral slate' },
                ] as const).map((opt) => {
                  const active = (brand.tableHeaderMode || 'brand') === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setBrand({ ...brand, tableHeaderMode: opt.id })}
                      className={`px-3 py-1.5 rounded-button text-[12px] font-medium border transition-colors ${
                        active
                          ? 'bg-omni-50 border-omni-300 text-omni-700'
                          : 'bg-white border-border text-content-secondary hover:border-omni-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-content-tertiary mt-1.5">
                Applies to native table slides. Neutral slate avoids branded fills when tables already have their own styling.
              </p>
            </div>

            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-content-tertiary mb-2">Chart palette</div>
              <div className="flex items-center gap-2 flex-wrap">
                {(brand.chartPalette || []).map((c, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <input
                      type="color"
                      value={`#${c.replace(/^#/, '')}`}
                      onChange={(e) => {
                        const next = [...(brand.chartPalette || [])];
                        next[i] = e.target.value.replace(/^#/, '').toUpperCase();
                        setBrand({ ...brand, chartPalette: next });
                      }}
                      className="h-8 w-8 rounded-button border border-border cursor-pointer bg-white"
                    />
                  </div>
                ))}
                <button
                  onClick={() => setBrand({ ...brand, chartPalette: [...(brand.chartPalette || []), '6B7280'] })}
                  className="btn-ghost btn-sm"
                  type="button"
                >
                  + Add
                </button>
                {(brand.chartPalette || []).length > 0 && (
                  <button
                    onClick={() => setBrand({ ...brand, chartPalette: (brand.chartPalette || []).slice(0, -1) })}
                    className="btn-ghost btn-sm"
                    type="button"
                  >
                    − Remove
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={() => logoFileInput.current?.click()} className="btn-secondary" type="button">
                <ImagePlus size={13} />
                {brand.logoDataUrl ? 'Replace logo' : 'Upload logo'}
              </button>
              {brand.logoDataUrl && (
                <>
                  <img src={brand.logoDataUrl} alt="Brand logo preview" className="h-10 w-auto rounded border border-border bg-white p-1" />
                  <button onClick={() => setBrand({ ...brand, logoDataUrl: undefined })} className="btn-ghost btn-sm" type="button">
                    <XCircle size={12} /> Remove
                  </button>
                </>
              )}
              <input
                ref={logoFileInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleLogoUpload(f);
                  e.target.value = '';
                }}
              />
              <button onClick={handleSaveBrand} className="btn-ghost btn-sm" type="button">
                <Save size={12} /> Export brand JSON
              </button>
            </div>

            {currentTemplate && currentTemplate.layouts.length > 0 && (
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-content-tertiary mb-2">
                  Layouts in this kit
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {currentTemplate.layouts.map((l) => (
                    <div key={l.id} className="border border-border rounded-card p-2 bg-white">
                      <div className="text-[12px] font-medium text-content-primary truncate">{l.name}</div>
                      <div className="text-[10px] text-content-tertiary uppercase tracking-wider">{l.role}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-between items-center pt-3 border-t border-border">
              <button onClick={() => setStep('filters')} className="btn-ghost btn-sm">
                Back
              </button>
              <button onClick={() => setStep('layout')} className="btn-primary">
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'layout' && dashboard && currentTemplate && (
        <div className="card space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-content-primary">Deck preview</h2>
            <p className="text-[11px] text-content-tertiary">
              Adjust tile placement, insight text, and speaker notes before generating. These settings are saved in deck recipes.
            </p>
          </div>

          <SlideLayoutPreview
            tiles={selectedTiles}
            template={currentTemplate}
            brand={brand}
            overrides={slideOverrides}
            onChange={setSlideOverrides}
            insights={insights}
            onInsightsChange={setInsights}
            includeAppendix={includeAppendix}
            onIncludeAppendixChange={setIncludeAppendix}
            tileVisualSources={tileVisualSources}
            renderStrategy={renderStrategy}
            onTileVisualSourceChange={setTileVisualSource}
            previewStates={previewStates}
            previewing={previewing}
            previewError={previewError}
            previewSampleLabel={previewSampleLabel}
            onRenderPreview={handleRenderPreview}
            onApplyVisualSourceToAll={applyVisualSourceToAll}
          />

          <div className="flex justify-between items-center pt-3 border-t border-border">
            <button onClick={() => setStep('brand')} className="btn-ghost btn-sm">
              Back
            </button>
            <button onClick={() => setStep('generate')} className="btn-primary">
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'generate' && dashboard && (
        <div className="card space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-content-primary">Ready to export</h2>
              <p className="text-[11px] text-content-tertiary">
                {batchEnabled && batchField && batchValues.length > 0
                  ? `Generate ${batchValues.length} deck(s), varying ${batchField}. Preview formatting will be applied to every output.`
                  : 'Generate a PowerPoint deck using the formatting, notes, and callouts from Preview.'}
              </p>
            </div>
            <button
              onClick={handleGenerate}
              disabled={generating || selectedTiles.length === 0 || (batchEnabled && (!batchField || batchValues.length === 0))}
              className="btn-primary flex-shrink-0"
            >
              {generating ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
              {generating
                ? 'Generating…'
                : batchEnabled && batchValues.length > 0
                ? `Generate ${batchValues.length} decks (.zip)`
                : 'Generate & download .pptx'}
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {[
              { label: 'Slides', value: `${exportReadiness.exportableCount}/${exportReadiness.selectedCount}` },
              { label: 'Customized', value: exportReadiness.customizedSlides },
              { label: 'Insights', value: exportReadiness.insightCount },
              { label: 'Callouts', value: exportReadiness.overlayCount },
            ].map((item) => (
              <div key={item.label} className="rounded-card border border-border bg-white px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-content-tertiary">{item.label}</div>
                <div className="text-lg font-semibold text-content-primary">{item.value}</div>
              </div>
            ))}
          </div>

          {generating && (
            <div
              className="relative overflow-hidden rounded-card border p-4"
              style={{
                borderColor: 'rgba(255,87,137,0.22)',
                background: 'linear-gradient(135deg, #FFFFFF 0%, #FFF6F9 52%, #F8F9FD 100%)',
              }}
              aria-live="polite"
            >
              <div className="flex items-center gap-4">
                <div className="relative flex-shrink-0 w-28 h-20 flex items-center justify-center">
                  <div className="absolute left-3 right-3 bottom-4 h-1 rounded-full bg-omni-100" />
                  <Vehicle kind="f1" width={104} height={76} className="relative z-10" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-content-primary">
                    Blobby is building the deck package
                  </div>
                  <div className="text-xs text-content-secondary mt-1 leading-5">
                    Exporting tiles, assembling slides, applying your template, and packaging the final PowerPoint.
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-card border border-border bg-white p-3 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-content-tertiary">Dashboard</span>
                  <span className="font-medium text-content-primary truncate">{dashboard.name}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-content-tertiary">Output</span>
                  <span className="font-medium text-content-primary">
                    {batchEnabled && batchField && batchValues.length > 0 ? `${batchValues.length} deck ZIP` : 'Single PPTX'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-content-tertiary">Render mode</span>
                  <span className="font-medium text-content-primary">{renderModeLabel}</span>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-content-tertiary">Speaker notes</span>
                  <span className="font-medium text-content-primary">{exportReadiness.speakerNotesCount}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-content-tertiary">Layout edits</span>
                  <span className="font-medium text-content-primary">{exportReadiness.layoutOverrideCount}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-content-tertiary">Appendix</span>
                  <span className="font-medium text-content-primary">{includeAppendix ? 'Included' : 'Off'}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 border-t border-border pt-3 text-[11px]">
              {[
                { label: 'Deck structure', value: `${exportReadiness.exportableCount} slide${exportReadiness.exportableCount === 1 ? '' : 's'} ready` },
                { label: 'Narration', value: `${exportReadiness.insightCount} insight${exportReadiness.insightCount === 1 ? '' : 's'} · ${exportReadiness.speakerNotesCount} note${exportReadiness.speakerNotesCount === 1 ? '' : 's'}` },
                { label: 'Visual strategy', value: renderModeLabel },
              ].map((item) => (
                <div key={item.label} className="rounded-card bg-surface-secondary px-3 py-2">
                  <div className="font-medium text-content-primary">{item.value}</div>
                  <div className="text-content-tertiary">{item.label}</div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-content-tertiary uppercase tracking-wider font-medium">Slide sources:</span>
              <span className="px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(16,110,62,0.12)', color: '#106E3E' }}>
                {exportReadiness.sourceCounts.native} native
              </span>
              <span className="px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(255,71,148,0.15)', color: '#C8186A' }}>
                {exportReadiness.sourceCounts.image} image
              </span>
              {exportReadiness.sourceCounts.fullDashboard > 0 && (
                <span className="px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(255,71,148,0.15)', color: '#C8186A' }}>
                  {exportReadiness.sourceCounts.fullDashboard} full dashboard
                </span>
              )}
              <span className="px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(107,114,128,0.15)', color: '#4B5563' }}>
                {exportReadiness.sourceCounts.skipped} skipped
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {generating && (
              <button onClick={cancelGeneration} className="btn-ghost btn-sm" type="button">
                <XCircle size={12} /> Cancel
              </button>
            )}
            <button onClick={handleSaveRecipe} className="btn-secondary" type="button" disabled={!dashboard}>
              <Download size={13} /> Save deck recipe
            </button>
          </div>

          {generationError && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">
              <AlertCircle size={16} />
              {generationError}
            </div>
          )}
          {generationSuccess && (
            <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-card">
              <CheckCircle size={16} />
              {generationSuccess}
            </div>
          )}

          {batchEnabled && batchField && batchValues.length > 0 && (generating || Object.keys(batchClientStates).length > 0) ? (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wider text-content-tertiary">
                Per-client status
              </div>
              {batchValues.map((value) => {
                const s = batchClientStates[value];
                const status = s?.status || 'pending';
                return (
                  <div key={value} className="flex items-center gap-2 p-2.5 rounded-card border border-border bg-white">
                    <span className="flex-1 text-[13px] text-content-primary truncate">{value}</span>
                    <span
                      className="text-[11px] text-content-tertiary"
                      title={s?.error || s?.message}
                    >
                      {s ? `${s.succeededTiles}/${selectedTiles.length} tiles` : ''}
                    </span>
                    <BatchStatusBadge status={status} message={s?.message} error={s?.error} />
                  </div>
                );
              })}
            </div>
          ) : (generating || Object.keys(exportStates).length > 0) ? (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wider text-content-tertiary">
                Slide export status
              </div>
              {selectedTiles.map((tile, idx) => {
                const state = exportStates[tile.id];
                const status = state?.status || 'pending';
                const isFailed = status === 'failed';
                const expanded = Boolean(expandedErrors[tile.id]);
                const resolvedSource = resolveTileVisualSource(renderStrategy, tileVisualSources, tile.id);
                const source = resolvedSource === 'full-dashboard'
                  ? 'Full dashboard'
                  : resolvedSource === 'tile-image'
                  ? 'Omni image'
                  : resolvedSource === 'skip'
                  ? 'Skipped'
                  : 'Native';
                return (
                  <div key={tile.id} className="rounded-card border border-border bg-white">
                    <div className="flex items-center gap-2 p-2.5">
                      <span
	                        className="w-6 h-6 rounded-full bg-surface-secondary text-[11px] flex items-center justify-center font-semibold flex-shrink-0"
                        style={{ color: '#C8186A' }}
                      >
                        {idx + 1}
                      </span>
                      <span className="flex-1 text-[13px] text-content-primary truncate">{tile.name}</span>
                      <span className="text-[11px] text-content-tertiary flex-shrink-0">{source}</span>
                      {state?.renderKind && (
                        <span
                          className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold flex-shrink-0"
                          style={{ background: 'rgba(255,71,148,0.12)', color: '#C8186A' }}
                        >
                          {state.renderKind}
                          {state.result?.columns ? ` ${state.result.rows.length}×${state.result.columns.length}` : ''}
                        </span>
                      )}
                      <StatusBadge status={status} message={state?.message} error={state?.error} />
                      {isFailed && state?.error && (
                        <button
                          onClick={() => setExpandedErrors((p) => ({ ...p, [tile.id]: !p[tile.id] }))}
                          className="btn-ghost btn-sm p-1.5"
                          type="button"
                        >
                          <ChevronDown
                            size={13}
                            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
                          />
                        </button>
                      )}
                    </div>
                    {isFailed && expanded && state?.error && (
                      <pre className="mx-2.5 mb-2.5 px-3 py-2 text-[11px] leading-snug whitespace-pre-wrap break-words rounded bg-red-50 border border-red-200 text-red-800 font-mono">
                        {state.error}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="flex justify-between items-center pt-3 border-t border-border">
            <button onClick={() => setStep('layout')} className="btn-ghost btn-sm" disabled={generating}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const normalized = value.startsWith('#') ? value : `#${value}`;
  return (
    <div>
      <label className="block text-xs font-medium text-content-secondary mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={normalized}
          onChange={(e) => onChange(e.target.value.replace(/^#/, '').toUpperCase())}
          className="h-10 w-12 rounded-button border border-border cursor-pointer bg-white"
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/^#/, '').toUpperCase())}
          className="input-field font-mono"
        />
      </div>
    </div>
  );
}

function StatusBadge({ status, message, error }: { status: string; message?: string; error?: string }) {
  const map: Record<string, { color: string; bg: string; label: string }> = {
    pending: { color: '#9B3065', bg: 'rgba(255,71,148,0.10)', label: 'Pending' },
    queued: { color: '#9B3065', bg: 'rgba(255,71,148,0.10)', label: 'Queued' },
    exporting: { color: '#C8186A', bg: 'rgba(255,71,148,0.18)', label: message || 'Exporting' },
    polling: { color: '#C8186A', bg: 'rgba(255,71,148,0.18)', label: message || 'Polling' },
    fetching: { color: '#C8186A', bg: 'rgba(255,71,148,0.18)', label: message || 'Fetching' },
    done: { color: '#106E3E', bg: 'rgba(52,211,153,0.18)', label: 'Ready' },
    failed: { color: '#B91C1C', bg: 'rgba(220,38,38,0.12)', label: error || 'Failed' },
    skipped: { color: '#4B5563', bg: 'rgba(107,114,128,0.15)', label: 'Skipped' },
  };
  const conf = map[status] || map.pending;
  const animated = ['exporting', 'polling', 'fetching'].includes(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium max-w-[260px] truncate"
      style={{ color: conf.color, background: conf.bg }}
      title={error || message}
    >
      {animated && <Loader2 size={11} className="animate-spin flex-shrink-0" />}
      {status === 'done' && <CheckCircle size={11} className="flex-shrink-0" />}
      {status === 'failed' && <AlertCircle size={11} className="flex-shrink-0" />}
      <span className="truncate">{conf.label}</span>
    </span>
  );
}

function BatchStatusBadge({ status, message, error }: { status: string; message?: string; error?: string }) {
  const map: Record<string, { color: string; bg: string; label: string }> = {
    pending: { color: '#9B3065', bg: 'rgba(255,71,148,0.10)', label: 'Waiting' },
    running: { color: '#C8186A', bg: 'rgba(255,71,148,0.18)', label: message || 'Running' },
    done: { color: '#106E3E', bg: 'rgba(52,211,153,0.18)', label: message || 'Ready' },
    failed: { color: '#B91C1C', bg: 'rgba(220,38,38,0.12)', label: error || 'Failed' },
  };
  const conf = map[status] || map.pending;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium max-w-[260px] truncate"
      style={{ color: conf.color, background: conf.bg }}
      title={error || message}
    >
      {status === 'running' && <Loader2 size={11} className="animate-spin flex-shrink-0" />}
      {status === 'done' && <CheckCircle size={11} className="flex-shrink-0" />}
      {status === 'failed' && <AlertCircle size={11} className="flex-shrink-0" />}
      <span className="truncate">{conf.label}</span>
    </span>
  );
}
