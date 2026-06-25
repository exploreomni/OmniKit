import type { DeckRecipe } from './types';
import { validateRecipe } from './deckRecipe';

export const RECIPE_STORAGE_KEY = 'omnikit:deck:recipes:v1';

const FORBIDDEN_STORAGE_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'passphrase',
]);

export interface RecipeRecord {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  savedForInstanceId?: string;
  savedForHost?: string;
  savedForInstanceLabel?: string;
  savedForBaseUrlHost?: string;
  recipe: DeckRecipe;
}

export interface SaveRecipeInput {
  id?: string;
  name: string;
  description?: string;
  savedForInstanceId?: string;
  savedForHost?: string;
  savedForInstanceLabel?: string;
  savedForBaseUrlHost?: string;
  recipe: DeckRecipe;
}

function clampText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function createRecipeId(): string {
  return `recipe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function hostFromBaseUrl(baseUrl: string): string | undefined {
  if (!baseUrl.trim()) return undefined;
  try {
    return new URL(baseUrl).host || undefined;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '').trim() || undefined;
  }
}

function readRawRecords(): unknown[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECIPE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRecords(records: RecipeRecord[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(RECIPE_STORAGE_KEY, JSON.stringify(records));
}

function normalizeRecord(value: unknown): RecipeRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RecipeRecord>;
  try {
    const recipe = validateRecipe(raw.recipe);
    const now = Date.now();
    const name = clampText(raw.name, 100) || 'Untitled recipe';
    return {
      id: clampText(raw.id, 120) || createRecipeId(),
      name,
      description: clampText(raw.description, 240),
      createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : now,
      updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : now,
      savedForInstanceId: clampText(raw.savedForInstanceId, 120),
      savedForHost: clampText(raw.savedForHost, 160),
      savedForInstanceLabel: clampText(raw.savedForInstanceLabel, 120),
      savedForBaseUrlHost: clampText(raw.savedForBaseUrlHost, 160),
      recipe,
    };
  } catch {
    return null;
  }
}

function loadRecords(): RecipeRecord[] {
  return readRawRecords()
    .map(normalizeRecord)
    .filter((record): record is RecipeRecord => Boolean(record))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listRecipes(): RecipeRecord[] {
  return loadRecords();
}

export function getRecipe(id: string): RecipeRecord | null {
  return loadRecords().find((record) => record.id === id) || null;
}

export function saveRecipe(input: SaveRecipeInput): RecipeRecord {
  const now = Date.now();
  const existing = loadRecords();
  const idx = input.id ? existing.findIndex((record) => record.id === input.id) : -1;
  const previous = idx >= 0 ? existing[idx] : null;
  const record: RecipeRecord = {
    id: previous?.id || input.id || createRecipeId(),
    name: clampText(input.name, 100) || previous?.name || 'Untitled recipe',
    description: clampText(input.description, 240),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    savedForInstanceId: clampText(input.savedForInstanceId, 120),
    savedForHost: clampText(input.savedForHost, 160),
    savedForInstanceLabel: clampText(input.savedForInstanceLabel, 120),
    savedForBaseUrlHost: clampText(input.savedForBaseUrlHost, 160),
    recipe: validateRecipe(input.recipe),
  };
  const next = idx >= 0 ? [...existing] : [record, ...existing];
  if (idx >= 0) next[idx] = record;
  writeRecords(next.sort((a, b) => b.updatedAt - a.updatedAt));
  return record;
}

export function renameRecipe(id: string, name: string): RecipeRecord | null {
  const existing = loadRecords();
  const target = existing.find((record) => record.id === id);
  if (!target) return null;
  return saveRecipe({
    ...target,
    name,
  });
}

export function duplicateRecipe(id: string): RecipeRecord | null {
  const target = getRecipe(id);
  if (!target) return null;
  return saveRecipe({
    name: `Copy of ${target.name}`.slice(0, 100),
    description: target.description,
    savedForInstanceId: target.savedForInstanceId,
    savedForHost: target.savedForHost,
    savedForInstanceLabel: target.savedForInstanceLabel,
    savedForBaseUrlHost: target.savedForBaseUrlHost,
    recipe: target.recipe,
  });
}

export function deleteRecipe(id: string): void {
  writeRecords(loadRecords().filter((record) => record.id !== id));
}

export function recipeRecordContainsForbiddenKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((entry) => recipeRecordContainsForbiddenKeys(entry));
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_STORAGE_KEYS.has(key.toLowerCase())) return true;
    if (recipeRecordContainsForbiddenKeys(child)) return true;
  }
  return false;
}
