import type { DeckRecipe, InsightSource } from './types';

export type DeckBuilderStepId = 'inspect' | 'select' | 'visuals' | 'filters' | 'brand' | 'layout' | 'generate';

export interface LoadedDeckNotice {
  title: string;
  message: string;
}

export interface RecipeLoadFeedback {
  libraryMessage: string;
  loadedNotice: LoadedDeckNotice | null;
  nextStep: DeckBuilderStepId;
  missingSummary: string;
}

export function stepAfterRecipeLoad(validTileCount: number): DeckBuilderStepId {
  return validTileCount === 0 ? 'select' : 'visuals';
}

export function recipeTileLabel(recipe: Pick<DeckRecipe, 'slideOverrides'>, tileId: string): string {
  return recipe.slideOverrides?.[tileId]?.title?.trim() || tileId;
}

export function summarizeMissingTileLabels(labels: string[]): string {
  if (labels.length === 0) return '';
  const visible = labels.slice(0, 4).join(', ');
  return labels.length > 4 ? `${visible}, +${labels.length - 4} more` : visible;
}

export function buildRecipeLoadFeedback({
  recipe,
  label,
  loadedCount,
  savedCount,
  missingTileIds,
}: {
  recipe: DeckRecipe;
  label: string;
  loadedCount: number;
  savedCount: number;
  missingTileIds: string[];
}): RecipeLoadFeedback {
  const missingSummary = summarizeMissingTileLabels(missingTileIds.map((id) => recipeTileLabel(recipe, id)));
  const slideSuffix = savedCount === 1 ? '' : 's';

  if (loadedCount === 0) {
    return {
      libraryMessage: `Loaded "${label}", but its saved tiles were not found on this dashboard${missingSummary ? `: ${missingSummary}` : ''}.`,
      loadedNotice: null,
      nextStep: stepAfterRecipeLoad(loadedCount),
      missingSummary,
    };
  }

  const hasMissingTiles = missingTileIds.length > 0;
  return {
    libraryMessage: hasMissingTiles
      ? `Loaded "${label}" with ${loadedCount} of ${savedCount} saved slide${slideSuffix}. Missing: ${missingSummary}.`
      : `Loaded "${label}". Review output choices before previewing the deck.`,
    loadedNotice: {
      title: hasMissingTiles
        ? `Loaded ${loadedCount} of ${savedCount} slides from "${label}"`
        : `Loaded "${label}"`,
      message: hasMissingTiles
        ? `This recipe still restored the matching slides, branding, notes, and output preferences. Missing saved slides: ${missingSummary}.`
        : 'Recipes restore slide choices, branding, notes, and output preferences. Review the output choices first, then continue to deck preview when the slides are ready.',
    },
    nextStep: stepAfterRecipeLoad(loadedCount),
    missingSummary,
  };
}

export function generationFailureMessage(kind: 'single' | 'batch', cancelled: boolean, error: unknown): string {
  if (cancelled) {
    return kind === 'batch'
      ? 'Batch generation cancelled before download.'
      : 'Deck generation cancelled before download.';
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return kind === 'batch' ? 'Batch generation failed.' : 'Deck generation failed.';
}

export function insightSourceAfterUserEdit(previous: InsightSource | undefined, nextText: string): InsightSource | undefined {
  if (!nextText.trim()) return undefined;
  return previous === 'ai' ? 'ai_edited' : previous === 'ai_edited' ? 'ai_edited' : 'user';
}

export function shouldGenerateAiInsightForAll(insightText: string | undefined, source: InsightSource | undefined): boolean {
  if ((insightText || '').trim()) return false;
  return source !== 'user' && source !== 'ai_edited';
}
