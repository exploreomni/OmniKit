import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';

import deckRecipesHandler from '../server/handlers/deck-recipes';
import {
  deleteDeckRecipe,
  duplicateDeckRecipe,
  listDeckRecipes,
  lockVault,
  normalizeVaultPayload,
  renameDeckRecipe,
  resetVault,
  unlockVault,
  upsertDeckRecipe,
} from '../server/services/nativeVault';
import {
  previewModeForTileExportState,
  previewModeForTileResult,
} from '../src/services/deckBuilder/previewMode';
import { summarizeTileQuery } from '../src/services/deckBuilder/querySummary';
import { buildInsightDigest } from '../src/services/deckBuilder/querySummary';
import {
  buildDeckInsightPrompt,
  cleanDeckInsightText,
  DECK_INSIGHT_MAX_CHARS,
  DECK_INSIGHT_PROMPT_VERSION,
  isDeckInsightRefusal,
} from '../src/services/deckBuilder/prompts';
import {
  applyNativeVisualOverride,
  nativeVisualCompatibility,
  resolveEffectiveRenderKind,
} from '../src/services/deckBuilder/nativeVisuals';
import {
  deckOutputContinueLabel,
  deckOutputDetailsCopy,
  deckOutputReadiness,
  deckOutputSummary,
  deckRenderButtonLabel,
} from '../src/services/deckBuilder/outputStatus';
import {
  extractTileVisualSpecFromRaw,
  inferTileVisualSpec,
  resolveVisualMapping,
} from '../src/services/deckBuilder/visualSpec';
import { buildRecipe, validateRecipe } from '../src/services/deckBuilder/deckRecipe';
import {
  clearDeckDraft,
  deckDraftContainsForbiddenKeys,
  loadDeckDraft,
  saveDeckDraft,
} from '../src/services/deckBuilder/deckDraftStorage';
import { buildDeck, TRANSPARENT_PPTX_FILL } from '../src/services/deckBuilder/pptxBuilder';
import { makeLayoutKit } from '../src/services/deckBuilder/templateStore';
import {
  deleteRecipe,
  duplicateRecipe,
  listRecipes,
  RECIPE_STORAGE_KEY,
  recipeRecordContainsForbiddenKeys,
  renameRecipe,
  saveRecipe,
} from '../src/services/deckBuilder/recipeStore';
import { DEFAULT_BRAND } from '../src/services/deckBuilder/types';
import type { DeckRecipe, LayoutKit, TileResult, TileVisualSpec } from '../src/services/deckBuilder/types';
import {
  buildRecipeLoadFeedback,
  generationFailureMessage,
  insightSourceAfterUserEdit,
  shouldGenerateAiInsightForAll,
  stepAfterRecipeLoad,
  summarizeMissingTileLabels,
} from '../src/services/deckBuilder/workflowFlow';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function installLocalStorage(): MemoryStorage {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  (globalThis as typeof globalThis & { window: { localStorage: MemoryStorage; sessionStorage: MemoryStorage } }).window = {
    localStorage,
    sessionStorage,
  };
  return localStorage;
}

function makeRecipe(patch: Partial<DeckRecipe> = {}): DeckRecipe {
  return {
    ...buildRecipe({
      dashboardUrl: 'https://example.omniapp.co/dashboards/dash-1',
      dashboardId: 'dash-1',
      dashboardName: 'Executive Dashboard',
      selectedTileIds: ['tile-1', 'tile-2'],
      insights: { 'tile-1': 'Use this in the opening story.' },
      brand: DEFAULT_BRAND,
      includeAppendix: true,
      generatedFrom: 'https://example.omniapp.co',
      filterOverrides: {
        'orders.region': {
          field: 'orders.region',
          kind: 'EQUALS',
          type: 'string',
          values: ['West'],
        },
      },
    }),
    ...patch,
  };
}

function makeTileResult(patch: Partial<TileResult> = {}): TileResult {
  return {
    columns: [
      { name: 'hour', label: 'Hour', type: 'string' },
      { name: 'sales', label: 'Sales', type: 'number' },
      { name: 'orders', label: 'Orders', type: 'number' },
      { name: 'daypart', label: 'Daypart', type: 'string' },
    ],
    rows: [
      { hour: '6', sales: 21900, orders: 4594, daypart: 'Morning Rush' },
      { hour: '7', sales: 63526, orders: 13428, daypart: 'Morning Rush' },
    ],
    rowCount: 2,
    truncated: false,
    renderKind: 'bar',
    ...patch,
  };
}

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  delete (globalThis as typeof globalThis & { window?: unknown }).window;
  if (process.env.OMNIKIT_VAULT_PATH?.includes('omnikit-deck-builder-test-vault')) {
    resetVault();
    delete process.env.OMNIKIT_VAULT_PATH;
  }
});

function useTempVault(slug: string): void {
  process.env.OMNIKIT_VAULT_PATH = join(tmpdir(), `omnikit-deck-builder-test-vault-${process.pid}-${slug}-${Date.now()}.enc`);
  resetVault();
}

test('uses an explicit transparent PPTX fill for border-only shapes', () => {
  assert.deepEqual(TRANSPARENT_PPTX_FILL, {
    color: 'FFFFFF',
    transparency: 100,
  });
});

test('native preview trusts renderKind for chart-like results with more than three columns', () => {
  assert.equal(previewModeForTileResult(makeTileResult({ renderKind: 'bar' })), 'chart');
  assert.equal(previewModeForTileResult(makeTileResult({ renderKind: 'stacked_bar' })), 'chart');
  assert.equal(previewModeForTileResult(makeTileResult({ renderKind: 'line' })), 'chart');
  assert.equal(previewModeForTileResult(makeTileResult({ renderKind: 'area' })), 'chart');
  assert.equal(previewModeForTileResult(makeTileResult({ renderKind: 'pie' })), 'chart');
});

test('native preview keeps table and image override decisions explicit', () => {
  const tableResult = makeTileResult({ renderKind: 'table' });
  assert.equal(previewModeForTileResult(tableResult), 'table');
  assert.equal(previewModeForTileExportState({
    tileId: 'tile-1',
    status: 'done',
    pngDataUrl: 'data:image/png;base64,preview',
    result: tableResult,
  }), 'image');
});

test('summarizes tile query metadata without exposing secret-shaped keys', () => {
  const summary = summarizeTileQuery({
    id: 'tile-1',
    name: 'Sales by Hour',
    order: 1,
    rawQuery: {
      query: {
        modelId: 'model-1',
        topicName: 'coffee_shop',
        fields: ['orders.hour', 'orders.sales'],
        filters: {
          'orders.region': { kind: 'EQUALS', values: ['West'] },
        },
        sorts: [{ field: 'orders.hour', direction: 'asc' }],
        limit: 200,
        apiKey: 'should-redact',
      },
    },
  });

  assert.equal(summary.kind, 'query');
  assert.equal(summary.modelId, 'model-1');
  assert.equal(summary.topic, 'coffee_shop');
  assert.deepEqual(summary.fields, ['orders.hour', 'orders.sales']);
  assert.equal(summary.filters[0], 'orders.region EQUALS ["West"]');
  assert.equal(summary.sorts[0], 'orders.hour asc');
  assert.equal(summary.limit, 200);
  assert.equal((summary.advancedJson || '').includes('"apiKey": "[redacted]"'), true);
});

test('builds AI insight digests with sampling, aggregates, filters, and redaction', () => {
  const rows = Array.from({ length: 1200 }, (_, index) => ({
    hour: `${index % 24}:00`,
    sales: index + 1,
    orders: (index % 10) + 1,
    api_token: `secret-${index}`,
  }));
  const result = makeTileResult({
    columns: [
      { name: 'hour', label: 'Hour', type: 'string' },
      { name: 'sales', label: 'Sales', type: 'number' },
      { name: 'orders', label: 'Orders', type: 'number' },
      { name: 'api_token', label: 'API Token', type: 'string' },
    ],
    rows,
    rowCount: rows.length,
  });
  const digest = buildInsightDigest({
    dashboardName: 'Coffee Shop Demo',
    tile: {
      id: 'tile-1',
      name: 'Sales by Hour',
      order: 1,
      rawQuery: {
        query: {
          modelId: 'model-1',
          topicName: 'orders',
          fields: ['orders.hour', 'orders.sales'],
        },
      },
    },
    result,
    filters: {
      'orders.region': { field: 'orders.region', kind: 'EQUALS', type: 'string', values: ['West'] },
    },
    visualKind: 'Bar',
  });

  assert.equal(digest.rowCount, 1200);
  assert.equal(digest.sampledRowCount, 30);
  assert.equal(digest.truncated, true);
  assert.equal(digest.samplingNote, 'Showing 30 evenly sampled rows of 1200.');
  assert.equal(digest.aggregates.find((item) => item.field === 'sales')?.sum, 720600);
  assert.equal(digest.text.includes('orders.region EQUALS ["West"]'), true);
  assert.equal(digest.text.includes('secret-'), false);
  assert.equal(digest.text.includes('api_token'), false);

  const budgeted = buildInsightDigest({
    tile: { id: 'wide', name: 'Wide Tile', order: 1 },
    result: makeTileResult({
      columns: Array.from({ length: 12 }, (_, index) => ({ name: `field_${index}`, type: 'string' })),
      rows: Array.from({ length: 100 }, (_, rowIndex) => Object.fromEntries(
        Array.from({ length: 12 }, (_, colIndex) => [`field_${colIndex}`, `value-${rowIndex}-${colIndex}-${'x'.repeat(40)}`])
      )),
    }),
    maxDigestChars: 1200,
  });
  assert.equal(budgeted.budgetTruncated, true);
  assert.equal(budgeted.text.length <= 1200, true);
  assert.equal(budgeted.text.includes('Digest truncated to stay within Omni AI prompt budget.'), true);
});

test('AI insight prompt is versioned, data-grounded, and output is cleaned for slides', () => {
  const digest = buildInsightDigest({
    dashboardName: 'Coffee Shop Demo',
    tile: { id: 'tile-1', name: 'Sales by Hour', order: 1 },
    result: makeTileResult(),
    visualKind: 'Bar',
  });
  const prompt = buildDeckInsightPrompt({
    dashboardName: 'Coffee Shop Demo',
    tileName: 'Sales by Hour',
    digest,
  });

  assert.equal(prompt.includes(DECK_INSIGHT_PROMPT_VERSION), true);
  assert.equal(prompt.includes('Use the provided tile digest as the source of truth.'), true);
  assert.equal(prompt.includes('<tile_digest>'), true);
  const cleaned = cleanDeckInsightText(`- ${'Revenue grew quickly. '.repeat(30)}`);
  assert.equal(cleaned.truncated, true);
  assert.equal(cleaned.text.startsWith('Revenue grew quickly.'), true);
  assert.equal(cleaned.text.length <= DECK_INSIGHT_MAX_CHARS, true);
  assert.equal(isDeckInsightRefusal("I'm sorry, I cannot summarize this data."), true);
  assert.equal(isDeckInsightRefusal('Morning rush contributed the highest sales total.'), false);
});

test('AI insight provenance flips safely on user edits and generate-all skips written text', () => {
  assert.equal(insightSourceAfterUserEdit(undefined, 'Manual note'), 'user');
  assert.equal(insightSourceAfterUserEdit('ai', 'Edited AI note'), 'ai_edited');
  assert.equal(insightSourceAfterUserEdit('ai_edited', 'Edited again'), 'ai_edited');
  assert.equal(insightSourceAfterUserEdit('ai', ''), undefined);
  assert.equal(shouldGenerateAiInsightForAll('', undefined), true);
  assert.equal(shouldGenerateAiInsightForAll('Manual note', 'user'), false);
  assert.equal(shouldGenerateAiInsightForAll('Edited AI note', 'ai_edited'), false);
});

test('native visual compatibility and effective render kind honor compatible overrides', () => {
  const result = makeTileResult({ renderKind: 'table' });
  const compatibility = nativeVisualCompatibility(result);
  assert.equal(compatibility.bar.supported, true);
  assert.equal(compatibility.stacked_bar.supported, true);
  assert.equal(compatibility.area.supported, true);
  assert.equal(compatibility.kpi.supported, false);
  assert.equal(resolveEffectiveRenderKind(result, 'bar').kind, 'bar');
  assert.equal(resolveEffectiveRenderKind(result, 'stacked_bar').kind, 'stacked_bar');
  assert.equal(resolveEffectiveRenderKind(result, 'area').kind, 'area');
  assert.equal(resolveEffectiveRenderKind(result, 'kpi').kind, 'table');
  assert.equal(applyNativeVisualOverride(result, 'bar').renderKind, 'bar');
  assert.equal(applyNativeVisualOverride(result, 'auto').renderKind, 'table');
});

test('extracts Omni visual metadata into a durable tile visual spec', () => {
  const spec = extractTileVisualSpecFromRaw({
    queryPresentation: {
      chartType: 'column',
      encoding: {
        x: { field: 'orders.hour' },
        y: [{ field: 'orders.sales' }, { field: 'orders.count' }],
        color: { field: 'orders.daypart' },
      },
      sort: { field: 'orders.sales', direction: 'desc' },
      topN: 12,
      numberFormat: 'currency',
      palette: ['#ff4794', '64748b'],
    },
  });

  assert.ok(spec);
  assert.equal(spec.source, 'omni');
  assert.equal(spec.confidence, 'high');
  assert.equal(spec.renderKind, 'bar');
  assert.equal(spec.categoryField, 'orders.hour');
  assert.deepEqual(spec.measureFields, ['orders.sales', 'orders.count']);
  assert.equal(spec.seriesField, 'orders.daypart');
  assert.deepEqual(spec.sort, { field: 'orders.sales', direction: 'desc' });
  assert.equal(spec.limit, 12);
  assert.equal(spec.numberFormat, 'currency');
  assert.deepEqual(spec.colors, ['ff4794', '64748b']);
});

test('infers editable visual mapping and applies user sort and limit', () => {
  const result = makeTileResult({ renderKind: 'table' });
  const spec = inferTileVisualSpec(result, 'bar');
  const mapping = resolveVisualMapping(result, {
    ...spec,
    categoryField: 'daypart',
    measureFields: ['orders'],
    sort: { field: 'orders', direction: 'desc' },
    limit: 1,
  });

  assert.equal(spec.source, 'inferred');
  assert.equal(spec.renderKind, 'bar');
  assert.equal(mapping.kind, 'bar');
  assert.equal(mapping.categoryColumn?.name, 'daypart');
  assert.deepEqual(mapping.measureColumns.map((column) => column.name), ['orders']);
  assert.equal(mapping.rows.length, 1);
  assert.equal(mapping.rows[0].orders, 13428);
});

test('infers low-cardinality series for grouped native charts', () => {
  const result = makeTileResult({
    columns: [
      { name: 'hour', label: 'Hour', type: 'string' },
      { name: 'daypart', label: 'Daypart', type: 'string' },
      { name: 'sales', label: 'Sales', type: 'number' },
    ],
    rows: [
      { hour: '6', daypart: 'Morning', sales: 10 },
      { hour: '7', daypart: 'Morning', sales: 12 },
      { hour: '12', daypart: 'Midday', sales: 8 },
    ],
    renderKind: 'bar',
  });
  const spec = inferTileVisualSpec(result, 'stacked_bar');
  const mapping = resolveVisualMapping(result, spec);

  assert.equal(spec.renderKind, 'stacked_bar');
  assert.equal(spec.seriesField, 'daypart');
  assert.equal(mapping.seriesColumn?.name, 'daypart');
});

test('recipe validation preserves area and stacked bar native visual choices', () => {
  const recipe = validateRecipe({
    ...makeRecipe(),
    nativeVisualOverrides: {
      'tile-1': 'area',
      'tile-2': 'stacked_bar',
    },
    tileVisualSpecs: {
      'tile-1': { source: 'user', confidence: 'manual', renderKind: 'area' },
      'tile-2': { source: 'user', confidence: 'manual', renderKind: 'stacked_bar' },
    },
  });

  assert.equal(recipe.nativeVisualOverrides?.['tile-1'], 'area');
  assert.equal(recipe.nativeVisualOverrides?.['tile-2'], 'stacked_bar');
  assert.equal(recipe.tileVisualSpecs?.['tile-1']?.renderKind, 'area');
  assert.equal(recipe.tileVisualSpecs?.['tile-2']?.renderKind, 'stacked_bar');
});

test('recipe validation preserves AI insight provenance without prompt or digest payloads', () => {
  const recipe = validateRecipe({
    ...makeRecipe({
      insights: {
        'tile-1': 'Morning rush leads sales.',
        'tile-2': 'Manual note.',
      },
      insightSources: {
        'tile-1': 'ai',
        'tile-2': 'user',
        'tile-3': 'not-real' as never,
      },
    }),
    prompt: 'should-not-persist',
    digest: 'should-not-persist',
  } as unknown);

  assert.deepEqual(recipe.insightSources, {
    'tile-1': 'ai',
    'tile-2': 'user',
  });
  assert.equal(JSON.stringify(recipe).includes('should-not-persist'), false);
});

test('deck output labels are source-aware and user friendly', () => {
  assert.deepEqual(deckOutputReadiness('native', undefined, 'auto'), {
    label: 'Needs render',
    tone: 'pending',
  });
  assert.equal(
    deckOutputSummary('native', {
      tileId: 'tile-1',
      status: 'done',
      result: makeTileResult({ renderKind: 'bar' }),
    }, 'auto'),
    'Native Bar · 2 rows · 4 fields',
  );
  assert.equal(deckRenderButtonLabel('native'), 'Render native visual');
  assert.equal(deckRenderButtonLabel('tile-image'), 'Render Omni PNG');
  assert.equal(deckRenderButtonLabel('full-dashboard'), 'Render dashboard PNG');
  assert.equal(deckRenderButtonLabel('skip'), 'Skipped');
  assert.equal(deckOutputDetailsCopy('tile-image').eyebrow, 'Omni image source details');
  assert.equal(deckOutputDetailsCopy('full-dashboard').eyebrow, 'Dashboard screenshot source');
  assert.equal(deckOutputContinueLabel({ hasNextSlide: true, actionableCount: 2 }), 'Next slide');
  assert.equal(deckOutputContinueLabel({ hasNextSlide: false, actionableCount: 2 }), 'Continue with 2 not ready');
  assert.equal(deckOutputContinueLabel({ hasNextSlide: false, actionableCount: 0 }), 'Continue to preview');
});

test('recipe load feedback routes users to output review and explains missing slides', () => {
  const recipe = makeRecipe({
    selectedTileIds: ['tile-1', 'tile-2', 'missing-3', 'missing-4', 'missing-5', 'missing-6', 'missing-7'],
    slideOverrides: {
      'missing-3': { title: 'Old revenue view' },
      'missing-4': { title: 'Old margin view' },
      'missing-5': { title: 'Old client view' },
      'missing-6': { title: 'Old churn view' },
      'missing-7': { title: 'Old forecast view' },
    },
  });

  const feedback = buildRecipeLoadFeedback({
    recipe,
    label: 'QBR deck',
    loadedCount: 2,
    savedCount: recipe.selectedTileIds.length,
    missingTileIds: recipe.selectedTileIds.slice(2),
  });

  assert.equal(stepAfterRecipeLoad(2), 'visuals');
  assert.equal(feedback.nextStep, 'visuals');
  assert.equal(feedback.loadedNotice?.title, 'Loaded 2 of 7 slides from "QBR deck"');
  assert.equal(feedback.libraryMessage.includes('Loaded "QBR deck" with 2 of 7 saved slides.'), true);
  assert.equal(feedback.missingSummary, 'Old revenue view, Old margin view, Old client view, Old churn view, +1 more');
  assert.equal(
    summarizeMissingTileLabels(['a', 'b', 'c', 'd', 'e']),
    'a, b, c, d, +1 more',
  );
});

test('recipe load feedback sends fully missing recipes back to tile selection', () => {
  const recipe = makeRecipe({ selectedTileIds: ['missing-1'], slideOverrides: { 'missing-1': { title: 'Removed tile' } } });
  const feedback = buildRecipeLoadFeedback({
    recipe,
    label: 'Legacy recipe',
    loadedCount: 0,
    savedCount: 1,
    missingTileIds: ['missing-1'],
  });

  assert.equal(feedback.nextStep, 'select');
  assert.equal(feedback.loadedNotice, null);
  assert.equal(feedback.libraryMessage, 'Loaded "Legacy recipe", but its saved tiles were not found on this dashboard: Removed tile.');
});

test('generation failure messages distinguish cancellation from hard failures', () => {
  assert.equal(
    generationFailureMessage('single', true, new Error('network failed')),
    'Deck generation cancelled before download.',
  );
  assert.equal(
    generationFailureMessage('batch', true, new Error('network failed')),
    'Batch generation cancelled before download.',
  );
  assert.equal(generationFailureMessage('single', false, new Error('network failed')), 'network failed');
  assert.equal(generationFailureMessage('batch', false, 'unknown'), 'Batch generation failed.');
});

test('generated PPTX keeps overlay and decoration border boxes transparent', async () => {
  const template: LayoutKit = makeLayoutKit('transparent-fixture', 'Transparent fixture', DEFAULT_BRAND, 'json');
  template.layouts = template.layouts.map((layout) =>
    layout.role === 'content'
      ? {
          ...layout,
          decorations: [
            {
              type: 'rect',
              x: 0.25,
              y: 0.25,
              w: 1.25,
              h: 0.75,
              line: '3366FF',
            },
          ],
        }
      : layout,
  );

  const blob = await buildDeck({
    dashboardName: 'Transparent Overlay Fixture',
    dashboardUrl: 'https://example.omniapp.co/dashboards/dash-1',
    generatedAt: new Date('2026-06-15T12:00:00.000Z'),
    brand: DEFAULT_BRAND,
    template,
    includeAppendix: false,
    tiles: [
      {
        tile: { id: 'tile-1', name: 'Revenue by Region', order: 1 },
        result: {
          columns: [
            { name: 'region', label: 'Region', type: 'string' },
            { name: 'revenue', label: 'Revenue', type: 'number' },
          ],
          rows: [
            { region: 'West', revenue: 125000 },
            { region: 'East', revenue: 98000 },
          ],
          rowCount: 2,
          truncated: false,
          renderKind: 'table',
        },
        slideOverride: {
          overlays: [
            {
              id: 'highlight-box',
              type: 'box',
              x: 1.5,
              y: 1.8,
              w: 3.5,
              h: 1.2,
              color: 'FF4794',
            },
          ],
        },
      },
    ],
  });

  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const slideXml = await zip.file('ppt/slides/slide2.xml')?.async('string');
  assert.ok(slideXml);
  const transparentFillMatches = slideXml.match(/<a:solidFill>\s*<a:srgbClr val="FFFFFF">\s*<a:alpha val="0"\/>\s*<\/a:srgbClr>\s*<\/a:solidFill>/g) || [];
  assert.ok(transparentFillMatches.length >= 2, slideXml);
  assert.match(slideXml, /<a:srgbClr val="FF4794"/);
  assert.match(slideXml, /<a:srgbClr val="3366FF"/);
  const tableContentIndex = slideXml.indexOf('West');
  const highlightIndex = slideXml.lastIndexOf('FF4794');
  assert.ok(tableContentIndex > -1, 'fixture should include underlying table content');
  assert.ok(highlightIndex > tableContentIndex, 'highlight overlay should be layered after underlying content');
});

test('generated PPTX uses native visual override instead of detected render kind', async () => {
  const blob = await buildDeck({
    dashboardName: 'Native Override Fixture',
    dashboardUrl: 'https://example.omniapp.co/dashboards/dash-1',
    generatedAt: new Date('2026-06-15T12:00:00.000Z'),
    brand: DEFAULT_BRAND,
    includeAppendix: false,
    tiles: [
      {
        tile: { id: 'tile-1', name: 'Sales by Hour', order: 1 },
        result: makeTileResult({ renderKind: 'table' }),
        nativeVisualOverride: 'bar',
      },
    ],
  });

  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const chartFiles = Object.keys(zip.files).filter((name) => name.startsWith('ppt/charts/chart'));
  assert.ok(chartFiles.length > 0, 'override should generate a chart part');
  const chartXml = await zip.file(chartFiles[0])?.async('string');
  assert.ok(chartXml);
  assert.match(chartXml, /<c:barChart>/);
});

test('generated PPTX uses explicit visual spec mapping for native charts', async () => {
  const visualSpec: TileVisualSpec = {
    source: 'user',
    confidence: 'manual',
    renderKind: 'bar',
    categoryField: 'daypart',
    measureFields: ['orders'],
    sort: { field: 'orders', direction: 'desc' },
    colors: ['112233', 'ff4794'],
  };
  const blob = await buildDeck({
    dashboardName: 'Native Mapping Fixture',
    dashboardUrl: 'https://example.omniapp.co/dashboards/dash-1',
    generatedAt: new Date('2026-06-15T12:00:00.000Z'),
    brand: DEFAULT_BRAND,
    includeAppendix: true,
    tiles: [
      {
        tile: { id: 'tile-1', name: 'Sales by Hour', order: 1 },
        result: makeTileResult({ renderKind: 'table' }),
        visualSpec,
      },
    ],
  });

  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const chartFiles = Object.keys(zip.files).filter((name) => name.startsWith('ppt/charts/chart'));
  assert.ok(chartFiles.length > 0, 'visual spec should generate a chart part');
  const chartXml = await zip.file(chartFiles[0])?.async('string');
  assert.ok(chartXml);
  assert.match(chartXml, /<c:barChart>/);
  assert.match(chartXml, /Morning Rush/);
  const appendixXml = await zip.file('ppt/slides/slide3.xml')?.async('string');
  assert.ok(appendixXml);
  assert.match(appendixXml, /Sales by Hour \(bar, user\)/);
});

test('preview and generated PPTX stay aligned for area and stacked bar native visuals', async () => {
  const result = makeTileResult({
    columns: [
      { name: 'hour', label: 'Hour', type: 'string' },
      { name: 'daypart', label: 'Daypart', type: 'string' },
      { name: 'sales', label: 'Sales', type: 'number' },
    ],
    rows: [
      { hour: '6', daypart: 'Morning', sales: 10 },
      { hour: '7', daypart: 'Morning', sales: 12 },
      { hour: '12', daypart: 'Midday', sales: 8 },
      { hour: '13', daypart: 'Midday', sales: 9 },
    ],
    rowCount: 4,
    renderKind: 'bar',
  });
  const fixtures: Array<{
    kind: 'area' | 'stacked_bar';
    expectedChartTag: RegExp;
    expectedDetail?: RegExp;
  }> = [
    { kind: 'area', expectedChartTag: /<c:areaChart>/ },
    { kind: 'stacked_bar', expectedChartTag: /<c:barChart>/, expectedDetail: /<c:grouping val="stacked"\/>/ },
  ];

  for (const fixture of fixtures) {
    const visualSpec: TileVisualSpec = {
      source: 'user',
      confidence: 'manual',
      renderKind: fixture.kind,
      categoryField: 'hour',
      seriesField: fixture.kind === 'stacked_bar' ? 'daypart' : undefined,
      measureFields: ['sales'],
    };
    const previewResult = applyNativeVisualOverride(result, fixture.kind);
    assert.equal(previewModeForTileResult(previewResult), 'chart');
    assert.equal(resolveVisualMapping(previewResult, visualSpec).kind, fixture.kind);

    const blob = await buildDeck({
      dashboardName: `${fixture.kind} parity fixture`,
      dashboardUrl: 'https://example.omniapp.co/dashboards/dash-1',
      generatedAt: new Date('2026-06-15T12:00:00.000Z'),
      brand: DEFAULT_BRAND,
      includeAppendix: false,
      tiles: [
        {
          tile: { id: `tile-${fixture.kind}`, name: fixture.kind, order: 1 },
          result,
          nativeVisualOverride: fixture.kind,
          visualSpec,
        },
      ],
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const chartFiles = Object.keys(zip.files).filter((name) => name.startsWith('ppt/charts/chart'));
    assert.equal(chartFiles.length, 1);
    const chartXml = await zip.file(chartFiles[0])?.async('string');
    assert.ok(chartXml);
    assert.match(chartXml, fixture.expectedChartTag);
    if (fixture.expectedDetail) assert.match(chartXml, fixture.expectedDetail);
  }
});

test('saves and validates local deck recipes without persisting secret-shaped keys', () => {
  const dirtyRecipe = {
    ...makeRecipe(),
    apiKey: 'omni_live_should_not_store',
    token: 'session-token',
    brand: {
      ...DEFAULT_BRAND,
      apiKey: 'brand-secret',
    },
  } as DeckRecipe;

  const saved = saveRecipe({
    name: 'Pipeline review',
    description: 'Executive dashboard',
    savedForHost: 'Example Omni (example.omniapp.co)',
    savedForInstanceLabel: 'Example Omni',
    savedForBaseUrlHost: 'example.omniapp.co',
    recipe: dirtyRecipe,
  });

  assert.equal(saved.name, 'Pipeline review');
  assert.equal(saved.recipe.dashboardName, 'Executive Dashboard');
  assert.equal(saved.recipe.dashboardId, 'dash-1');
  assert.equal(saved.recipe.selectedTileIds.length, 2);
  assert.equal(saved.recipe.generatedFrom, 'https://example.omniapp.co');

  const raw = window.localStorage.getItem(RECIPE_STORAGE_KEY);
  assert.ok(raw);
  assert.equal(raw.includes('apiKey'), false);
  assert.equal(raw.includes('token'), false);
  assert.equal(raw.includes('omni_live_should_not_store'), false);
  assert.equal(recipeRecordContainsForbiddenKeys(JSON.parse(raw)), false);

  const [record] = listRecipes();
  assert.equal(record.id, saved.id);
  assert.equal(record.savedForHost, 'Example Omni (example.omniapp.co)');
  assert.equal(record.savedForInstanceLabel, 'Example Omni');
  assert.equal(record.savedForBaseUrlHost, 'example.omniapp.co');
});

test('vault payloads without deck recipes normalize with an empty recipe library', () => {
  const payload = normalizeVaultPayload({ version: 1, instances: [] });
  assert.deepEqual(payload.deckRecipes, []);
});

test('vault deck recipe operations persist encrypted recipe metadata', async () => {
  useTempVault('crud');
  unlockVault('deck-passphrase');

  const saved = upsertDeckRecipe({
    name: 'Executive recipe',
    description: 'Board deck',
    savedForInstanceId: 'instance-1',
    savedForInstanceLabel: 'Example Omni',
    savedForBaseUrlHost: 'example.omniapp.co',
    recipe: makeRecipe(),
  });
  assert.equal(saved.name, 'Executive recipe');
  assert.equal(saved.savedForInstanceId, 'instance-1');
  assert.equal(listDeckRecipes().length, 1);

  const exportResponse = await deckRecipesHandler(new Request(`http://localhost/api/deck-recipes/${saved.id}/export`));
  assert.equal(exportResponse.status, 200);
  const exportBody = await exportResponse.json() as { recipe?: DeckRecipe; metadata?: { name?: string } };
  assert.equal(exportBody.recipe?.dashboardName, 'Executive Dashboard');
  assert.equal(exportBody.metadata?.name, 'Executive recipe');

  lockVault();
  unlockVault('deck-passphrase');
  assert.equal(listDeckRecipes()[0]?.name, 'Executive recipe');

  const renamed = renameDeckRecipe(saved.id, 'Renamed recipe');
  assert.equal(renamed?.name, 'Renamed recipe');
  const duplicated = duplicateDeckRecipe(saved.id);
  assert.equal(duplicated?.name, 'Copy of Renamed recipe');
  assert.equal(listDeckRecipes().length, 2);

  deleteDeckRecipe(saved.id);
  assert.deepEqual(listDeckRecipes().map((record) => record.name), ['Copy of Renamed recipe']);
});

test('vault deck recipes strip secret-shaped recipe data before persistence', () => {
  useTempVault('secrets');
  unlockVault('deck-passphrase');

  const dirtyRecipe = {
    ...makeRecipe(),
    apiKey: 'omni_live_should_not_store',
    token: 'session-token',
    brand: {
      ...DEFAULT_BRAND,
      token: 'brand-token',
    },
  } as DeckRecipe;

  const saved = upsertDeckRecipe({
    name: 'Dirty recipe',
    recipe: dirtyRecipe,
  });
  const serialized = JSON.stringify(saved);
  assert.equal(serialized.includes('apiKey'), false);
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('omni_live_should_not_store'), false);
});

test('deck recipe API requires an unlocked vault', async () => {
  useTempVault('locked-api');
  const response = await deckRecipesHandler(new Request('http://localhost/api/deck-recipes'));
  assert.equal(response.status, 423);
  const body = await response.json() as { error?: string };
  assert.equal(body.error, 'vault locked');
});

test('validates legacy recipes without dashboard metadata', () => {
  const legacy = {
    version: 1,
    dashboardUrl: 'https://example.omniapp.co/dashboards/legacy-dash',
    selectedTileIds: ['tile-1'],
    insights: {},
    brand: DEFAULT_BRAND,
    includeAppendix: true,
  };
  const recipe = validateRecipe(legacy);
  assert.equal(recipe.dashboardUrl, legacy.dashboardUrl);
  assert.equal(recipe.dashboardName, undefined);
  assert.equal(recipe.dashboardId, undefined);
});

test('deck recipes preserve native visual overrides', () => {
  const recipe = validateRecipe({
    ...makeRecipe(),
    nativeVisualOverrides: {
      'tile-1': 'bar',
      'tile-2': 'auto',
      'tile-3': 'not-real',
    },
  });

  assert.deepEqual(recipe.nativeVisualOverrides, {
    'tile-1': 'bar',
    'tile-2': 'auto',
  });
});

test('deck recipes preserve sanitized tile visual specs', () => {
  const recipe = validateRecipe({
    ...makeRecipe(),
    tileVisualSpecs: {
      'tile-1': {
        source: 'user',
        confidence: 'manual',
        renderKind: 'bar',
        categoryField: 'orders.hour',
        measureFields: ['orders.sales'],
        sort: { field: 'orders.sales', direction: 'desc' },
        numberFormat: 'currency',
        colors: ['#ff4794'],
        token: 'should-not-persist',
      },
    },
  } as unknown);

  const spec = recipe.tileVisualSpecs?.['tile-1'];
  assert.equal(spec?.source, 'user');
  assert.equal(spec?.confidence, 'manual');
  assert.equal(spec?.renderKind, 'bar');
  assert.equal(spec?.categoryField, 'orders.hour');
  assert.deepEqual(spec?.measureFields, ['orders.sales']);
  assert.deepEqual(spec?.sort, { field: 'orders.sales', direction: 'desc' });
  assert.equal(spec?.numberFormat, 'currency');
  assert.deepEqual(spec?.colors, ['#ff4794']);
  assert.equal(JSON.stringify(recipe).includes('should-not-persist'), false);
});

test('drops corrupt recipe records and supports rename, duplicate, and delete', () => {
  const localStorage = window.localStorage;
  const valid = saveRecipe({
    name: 'Valid recipe',
    recipe: makeRecipe(),
  });
  localStorage.setItem(RECIPE_STORAGE_KEY, JSON.stringify([
    { id: 'bad', name: 'Bad recipe', recipe: { version: 99 } },
    valid,
  ]));

  assert.deepEqual(listRecipes().map((record) => record.name), ['Valid recipe']);

  const renamed = renameRecipe(valid.id, 'Renamed recipe');
  assert.equal(renamed?.name, 'Renamed recipe');

  const duplicated = duplicateRecipe(valid.id);
  assert.equal(duplicated?.name, 'Copy of Renamed recipe');
  assert.equal(listRecipes().length, 2);

  deleteRecipe(valid.id);
  assert.equal(listRecipes().length, 1);
  assert.equal(listRecipes()[0].name, 'Copy of Renamed recipe');
});

test('autosave draft storage keeps resumable deck state without secrets', () => {
  const draft = saveDeckDraft('https://example.omniapp.co', {
    step: 'layout',
    dashboardUrl: 'https://example.omniapp.co/dashboards/dash-1',
    dashboard: {
      id: 'dash-1',
      name: 'Executive Dashboard',
      url: 'https://example.omniapp.co/dashboards/dash-1',
      tiles: [
        {
          id: 'tile-1',
          name: 'Revenue',
          order: 1,
          rawQuery: {
            apiKey: 'raw-query-secret',
            fields: ['orders.revenue'],
          },
        },
      ],
      filters: [
        {
          field: 'orders.region',
          label: 'Region',
          values: ['West'],
          apiKey: 'filter-secret',
        } as never,
      ],
      topics: ['orders'],
      modelId: 'model-1',
      apiKey: 'dashboard-secret',
    } as never,
    selectedTileIds: ['tile-1'],
    insights: { 'tile-1': 'Revenue improved.' },
    insightSources: { 'tile-1': 'ai' },
    brand: {
      ...DEFAULT_BRAND,
      token: 'brand-token',
    } as never,
    includeAppendix: false,
    generatedFrom: 'https://example.omniapp.co',
    filterOverrides: {
      'orders.region': {
        field: 'orders.region',
        kind: 'EQUALS',
        type: 'string',
        values: ['West'],
        token: 'override-token',
      } as never,
    },
    dashboardDefaults: {
      'orders.region': {
        field: 'orders.region',
        values: ['West'],
      },
    },
    batch: { filterField: 'orders.client', values: ['Acme'] },
    templateId: 'builtin-omnikit',
    tileVisualSources: { 'tile-1': 'native' },
    nativeVisualOverrides: { 'tile-1': 'bar' },
    tileVisualSpecs: {
      'tile-1': {
        source: 'user',
        confidence: 'manual',
        renderKind: 'bar',
        categoryField: 'orders.hour',
        measureFields: ['orders.revenue'],
      },
    },
    slideOverrides: {
      'tile-1': {
        speakerNotes: 'Talk track',
        secret: 'slide-secret',
      } as never,
    },
    renderStrategy: 'native',
  });

  assert.ok(draft);
  const raw = window.sessionStorage.getItem('omnikit:deck:draft:v1:example.omniapp.co');
  assert.ok(raw);
  assert.equal(raw.includes('apiKey'), false);
  assert.equal(raw.includes('token'), false);
  assert.equal(raw.includes('secret'), false);
  assert.equal(raw.includes('tile_digest'), false);
  assert.equal(raw.includes('Prompt version'), false);
  assert.equal(deckDraftContainsForbiddenKeys(JSON.parse(raw)), false);

  const loaded = loadDeckDraft('https://example.omniapp.co');
  assert.equal(loaded?.step, 'layout');
  assert.equal(loaded?.dashboard?.name, 'Executive Dashboard');
  assert.equal(loaded?.recipe.insightSources?.['tile-1'], 'ai');
  assert.equal(loaded?.recipe.nativeVisualOverrides?.['tile-1'], 'bar');
  assert.equal(loaded?.recipe.tileVisualSpecs?.['tile-1']?.categoryField, 'orders.hour');
  assert.equal(loaded?.recipe.slideOverrides?.['tile-1']?.speakerNotes, 'Talk track');

  clearDeckDraft('https://example.omniapp.co');
  assert.equal(loadDeckDraft('https://example.omniapp.co'), null);
});
