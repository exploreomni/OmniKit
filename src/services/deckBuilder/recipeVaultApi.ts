import type { RecipeRecord, SaveRecipeInput } from './recipeStore';

interface RecipeListResponse {
  recipes?: RecipeRecord[];
}

interface RecipeResponse {
  recipe?: RecipeRecord;
}

interface RecipeImportResponse {
  imported?: RecipeRecord[];
  count?: number;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/deck-recipes${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : 'Deck recipe request failed.';
    throw Object.assign(new Error(message), { statusCode: response.status });
  }
  return data as T;
}

export function isVaultLockedError(error: unknown): boolean {
  return typeof (error as { statusCode?: unknown })?.statusCode === 'number'
    && (error as { statusCode: number }).statusCode === 423;
}

export async function listVaultRecipes(): Promise<RecipeRecord[]> {
  const data = await requestJson<RecipeListResponse>('');
  return Array.isArray(data.recipes) ? data.recipes : [];
}

export async function getVaultRecipe(id: string): Promise<RecipeRecord | null> {
  const data = await requestJson<RecipeResponse>(`/${encodeURIComponent(id)}`);
  return data.recipe || null;
}

export async function saveVaultRecipe(input: SaveRecipeInput): Promise<RecipeRecord> {
  const data = await requestJson<RecipeResponse>('', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!data.recipe) throw new Error('Deck recipe save did not return a recipe.');
  return data.recipe;
}

export async function renameVaultRecipe(id: string, name: string): Promise<RecipeRecord | null> {
  const data = await requestJson<RecipeResponse>(`/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
  return data.recipe || null;
}

export async function duplicateVaultRecipe(id: string): Promise<RecipeRecord | null> {
  const data = await requestJson<RecipeResponse>(`/${encodeURIComponent(id)}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return data.recipe || null;
}

export async function deleteVaultRecipe(id: string): Promise<void> {
  await requestJson<{ ok?: boolean }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function importLocalRecipesToVault(records: RecipeRecord[]): Promise<RecipeRecord[]> {
  const data = await requestJson<RecipeImportResponse>('/import-local', {
    method: 'POST',
    body: JSON.stringify({ records }),
  });
  return Array.isArray(data.imported) ? data.imported : [];
}
