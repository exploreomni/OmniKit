import { jsonHeaders } from '../security';
import { redactSensitiveText } from '../services/jobSanitizer';
import {
  deleteDeckRecipe,
  duplicateDeckRecipe,
  getDeckRecipe,
  importDeckRecipes,
  isVaultUnlocked,
  listDeckRecipes,
  renameDeckRecipe,
  upsertDeckRecipe,
} from '../services/nativeVault';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const locked = requireUnlocked();
    if (locked) return locked;

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/deck-recipes\/?/, '');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);

    if (req.method === 'GET' && parts.length === 0) {
      return json({ recipes: listDeckRecipes() });
    }

    if (req.method === 'GET' && parts.length === 1) {
      const recipe = getDeckRecipe(parts[0]);
      return recipe ? json({ recipe }) : json({ error: 'Recipe not found.' }, 404);
    }

    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'export') {
      const recipe = getDeckRecipe(parts[0]);
      return recipe
        ? json({
            recipe: recipe.recipe,
            metadata: {
              id: recipe.id,
              name: recipe.name,
              description: recipe.description,
              savedForInstanceId: recipe.savedForInstanceId,
              savedForInstanceLabel: recipe.savedForInstanceLabel,
              savedForBaseUrlHost: recipe.savedForBaseUrlHost,
              createdAt: recipe.createdAt,
              updatedAt: recipe.updatedAt,
            },
          })
        : json({ error: 'Recipe not found.' }, 404);
    }

    if (req.method === 'POST' && parts.length === 0) {
      const body = await bodyJson(req);
      return json({ recipe: upsertDeckRecipe(body as unknown as Parameters<typeof upsertDeckRecipe>[0]) });
    }

    if (req.method === 'POST' && parts[0] === 'import-local') {
      const body = await bodyJson(req);
      const records = Array.isArray(body.records) ? body.records : [];
      const imported = importDeckRecipes(records);
      return json({ imported, count: imported.length });
    }

    if (req.method === 'PATCH' && parts.length === 1) {
      const body = await bodyJson(req);
      const name = typeof body.name === 'string' ? body.name : '';
      const recipe = renameDeckRecipe(parts[0], name);
      return recipe ? json({ recipe }) : json({ error: 'Recipe not found.' }, 404);
    }

    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'duplicate') {
      const recipe = duplicateDeckRecipe(parts[0]);
      return recipe ? json({ recipe }) : json({ error: 'Recipe not found.' }, 404);
    }

    if (req.method === 'DELETE' && parts.length === 1) {
      deleteDeckRecipe(parts[0]);
      return json({ ok: true });
    }

    return json({ error: `Unknown deck recipe route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: error instanceof Error ? redactSensitiveText(error.message) : 'Deck recipe operation failed.' }, statusCode);
  }
}
