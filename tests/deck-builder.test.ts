import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import JSZip from 'jszip';

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
import type { DeckRecipe, LayoutKit } from '../src/services/deckBuilder/types';

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

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  delete (globalThis as typeof globalThis & { window?: unknown }).window;
});

test('uses an explicit transparent PPTX fill for border-only shapes', () => {
  assert.deepEqual(TRANSPARENT_PPTX_FILL, {
    color: 'FFFFFF',
    transparency: 100,
  });
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
  assert.equal(deckDraftContainsForbiddenKeys(JSON.parse(raw)), false);

  const loaded = loadDeckDraft('https://example.omniapp.co');
  assert.equal(loaded?.step, 'layout');
  assert.equal(loaded?.dashboard?.name, 'Executive Dashboard');
  assert.equal(loaded?.recipe.slideOverrides?.['tile-1']?.speakerNotes, 'Talk track');

  clearDeckDraft('https://example.omniapp.co');
  assert.equal(loadDeckDraft('https://example.omniapp.co'), null);
});
