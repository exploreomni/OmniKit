import {
  nativeVisualLabel,
  resolveEffectiveRenderKind,
} from './nativeVisuals';
import type {
  NativeVisualOverride,
  TileExportState,
  TileVisualSource,
} from './types';

export type OutputReadinessTone = 'pending' | 'ready' | 'running' | 'failed' | 'skipped';

export interface OutputReadiness {
  label: string;
  tone: OutputReadinessTone;
  title?: string;
}

export function deckOutputSourceLabel(source: TileVisualSource): string {
  if (source === 'tile-image') return 'Omni PNG';
  if (source === 'full-dashboard') return 'Dashboard PNG';
  if (source === 'skip') return 'Skip';
  return 'Native editable';
}

export function deckOutputSummary(
  source: TileVisualSource,
  previewState: TileExportState | undefined,
  override: NativeVisualOverride,
): string {
  if (source === 'skip') return 'Skipped';
  if (source === 'tile-image') return previewState?.pngDataUrl ? 'Omni PNG ready' : 'Omni PNG selected';
  if (source === 'full-dashboard') return previewState?.pngDataUrl ? 'Dashboard PNG ready' : 'Dashboard PNG selected';

  const result = previewState?.result;
  if (!result) return 'Native editable selected';

  const effective = resolveEffectiveRenderKind(result, override);
  const columns = result.columns.length === 1 ? '1 field' : `${result.columns.length} fields`;
  const rows = result.rows.length === 1 ? '1 row' : `${result.rows.length} rows`;
  const detected = result.renderKind !== effective.kind ? ` · detected ${nativeVisualLabel(result.renderKind)}` : '';
  return `Native ${nativeVisualLabel(effective.kind)} · ${rows} · ${columns}${detected}`;
}

export function deckOutputReadiness(
  source: TileVisualSource,
  previewState: TileExportState | undefined,
  override: NativeVisualOverride,
): OutputReadiness {
  if (source === 'skip') {
    return { label: 'Skipped', tone: 'skipped' };
  }

  if (!previewState) {
    return { label: 'Needs render', tone: 'pending' };
  }

  if (previewState.status === 'failed') {
    return {
      label: previewState.error || 'Failed',
      tone: 'failed',
      title: previewState.error,
    };
  }

  if (previewState.status === 'skipped') {
    return { label: 'Skipped', tone: 'skipped', title: previewState.message };
  }

  if (previewState.status !== 'done') {
    return { label: previewState.message || 'Rendering', tone: 'running', title: previewState.message };
  }

  if (source === 'tile-image') return { label: 'Omni PNG ready', tone: 'ready', title: previewState.message };
  if (source === 'full-dashboard') return { label: 'Dashboard PNG ready', tone: 'ready', title: previewState.message };

  return {
    label: deckOutputSummary(source, previewState, override),
    tone: 'ready',
    title: previewState.message,
  };
}

export function deckRenderButtonLabel(source: TileVisualSource): string {
  if (source === 'tile-image') return 'Render Omni PNG';
  if (source === 'full-dashboard') return 'Render dashboard PNG';
  if (source === 'skip') return 'Skipped';
  return 'Render native visual';
}

export function deckOutputContinueLabel({
  hasNextSlide,
  actionableCount,
}: {
  hasNextSlide: boolean;
  actionableCount: number;
}): string {
  if (hasNextSlide) return 'Next slide';
  if (actionableCount > 0) return `Continue with ${actionableCount} not ready`;
  return 'Continue to preview';
}

export function deckOutputDetailsCopy(source: TileVisualSource): { eyebrow: string; title: string; helper: string } {
  if (source === 'tile-image') {
    return {
      eyebrow: 'Omni image source details',
      title: "Omni's exact rendered tile image",
      helper: 'Query metadata is shown for context, but this slide will use Omni\'s PNG export.',
    };
  }
  if (source === 'full-dashboard') {
    return {
      eyebrow: 'Dashboard screenshot source',
      title: 'Full dashboard screenshot',
      helper: 'Tile query metadata is shown for context, but this slide will use the full dashboard screenshot source.',
    };
  }
  if (source === 'skip') {
    return {
      eyebrow: 'Skipped slide details',
      title: 'This tile will not be included',
      helper: 'Query metadata remains available in case you want to switch this slide back into the deck.',
    };
  }
  return {
    eyebrow: 'Native query preview',
    title: 'Editable PowerPoint output',
    helper: 'OmniKit will translate this reusable query into an editable PowerPoint visual when possible.',
  };
}
