import type { TileExportState, TileResult } from './types';

export type ActualPreviewMode = 'kpi' | 'chart' | 'table' | 'markdown' | 'empty' | 'unsupported';
export type TilePreviewContentMode = ActualPreviewMode | 'image' | 'failed' | 'rendering' | 'mock';

export function previewModeForTileResult(result: TileResult): ActualPreviewMode {
  if (result.rows.length === 0 || result.renderKind === 'empty') return 'empty';
  if (result.renderKind === 'kpi') return 'kpi';
  if (result.renderKind === 'bar' || result.renderKind === 'line' || result.renderKind === 'pie') return 'chart';
  if (result.renderKind === 'markdown') return 'markdown';
  if (result.renderKind === 'unsupported') return 'unsupported';
  return 'table';
}

export function previewModeForTileExportState(preview?: TileExportState): TilePreviewContentMode {
  if (preview?.pngDataUrl) return 'image';
  if (preview?.result) return previewModeForTileResult(preview.result);
  if (preview?.status === 'failed') return 'failed';
  if (preview?.status && preview.status !== 'pending') return 'rendering';
  return 'mock';
}
