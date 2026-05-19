import { runTileExports } from './tileExporter';
import { exportFullDashboardAsPng, blobToDataUrl } from './omniDeckApi';
import { buildDeck, deckFileName } from './pptxBuilder';
import { deckLog } from './log';
import type {
  BrandConfig,
  DashboardTile,
  FilterOverride,
  LayoutKit,
  RenderStrategy,
  SlideOverride,
  TileExportState,
  TileVisualSource,
} from './types';

export interface BatchClientStatus {
  value: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  succeededTiles: number;
  failedTiles: number;
  message?: string;
  error?: string;
  pptxBlob?: Blob;
  fileName?: string;
}

export interface BatchRunOptions {
  baseUrl: string;
  apiKey: string;
  dashboardId: string;
  dashboardName: string;
  dashboardUrl: string;
  tiles: DashboardTile[];
  brand: BrandConfig;
  template?: LayoutKit;
  insights: Record<string, string>;
  includeAppendix: boolean;
  baseFilterOverrides: Record<string, FilterOverride>;
  batchField: string;
  batchFieldKind?: string;
  batchFieldType?: string;
  values: string[];
  strategy: RenderStrategy;
  perTileSource?: Record<string, TileVisualSource>;
  slideOverrides?: Record<string, SlideOverride>;
  allowFullDashboardFallback: boolean;
  signal?: AbortSignal;
  onClientUpdate: (status: BatchClientStatus) => void;
}

export interface BatchRunResult {
  files: Array<{ fileName: string; blob: Blob; clientValue: string }>;
  succeeded: number;
  failed: number;
}

function resolveSource(
  strategy: RenderStrategy,
  perTileSource: Record<string, TileVisualSource> | undefined,
  tileId: string,
): TileVisualSource {
  return perTileSource?.[tileId] || (
    strategy === 'full-dashboard'
      ? 'full-dashboard'
      : strategy === 'tile-image'
      ? 'tile-image'
      : 'native'
  );
}

function strategyForTileExports(strategy: RenderStrategy): RenderStrategy {
  return strategy === 'full-dashboard' ? 'native' : strategy;
}

export async function runBatchDecks(opts: BatchRunOptions): Promise<BatchRunResult> {
  const files: BatchRunResult['files'] = [];
  let succeeded = 0;
  let failed = 0;

  for (const value of opts.values) {
    if (opts.signal?.aborted) {
      opts.onClientUpdate({ value, status: 'failed', succeededTiles: 0, failedTiles: 0, error: 'Cancelled' });
      failed += 1;
      continue;
    }

    opts.onClientUpdate({ value, status: 'running', succeededTiles: 0, failedTiles: 0, message: 'Running tile queries' });

    const overrides: Record<string, FilterOverride> = {
      ...opts.baseFilterOverrides,
      [opts.batchField]: {
        field: opts.batchField,
        kind: opts.batchFieldKind ?? 'EQUALS',
        type: opts.batchFieldType ?? 'string',
        values: [value],
      },
    };

    const tileStates: Record<string, TileExportState> = {};
    let usedFallback = false;
    let usedFullDashboardImage = false;

    try {
      const sourceFor = (tile: DashboardTile) => resolveSource(opts.strategy, opts.perTileSource, tile.id);
      const fullDashboardTiles = opts.tiles.filter((tile) => sourceFor(tile) === 'full-dashboard');
      const exportTiles = opts.tiles.filter((tile) => sourceFor(tile) !== 'full-dashboard');

      if (fullDashboardTiles.length > 0) {
        deckLog.step('batch', `[${value}] full-dashboard strategy`);
        const blob = await exportFullDashboardAsPng(
          opts.baseUrl,
          opts.apiKey,
          opts.dashboardId,
          opts.signal,
          (m) => deckLog.info('batch', `[${value}] ${m}`)
        );
        const dataUrl = await blobToDataUrl(blob);
        for (const tile of fullDashboardTiles) {
          tileStates[tile.id] = {
            tileId: tile.id,
            status: 'done',
            pngDataUrl: dataUrl,
            pngSize: blob.size,
          };
        }
        usedFullDashboardImage = true;
      }

      if (exportTiles.length > 0) {
        const perTileSource = Object.fromEntries(
          exportTiles.map((tile) => [tile.id, sourceFor(tile)] as const)
        ) as Record<string, TileVisualSource>;
        const { states } = await runTileExports({
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          dashboardId: opts.dashboardId,
          tiles: exportTiles,
          strategy: strategyForTileExports(opts.strategy),
          perTileSource,
          signal: opts.signal,
          filterOverrides: overrides,
          onUpdate: () => undefined,
        });
        Object.assign(tileStates, states);

        const okCount = Object.values(states).filter((s) => s.status === 'done').length;
        if (okCount === 0 && fullDashboardTiles.length === 0 && opts.allowFullDashboardFallback) {
          deckLog.warn('batch', `[${value}] all tiles failed, full-dashboard fallback`);
          const blob = await exportFullDashboardAsPng(
            opts.baseUrl,
            opts.apiKey,
            opts.dashboardId,
            opts.signal
          );
          const dataUrl = await blobToDataUrl(blob);
          for (const tile of opts.tiles) {
            tileStates[tile.id] = {
              tileId: tile.id,
              status: 'done',
              pngDataUrl: dataUrl,
              pngSize: blob.size,
            };
          }
          usedFallback = true;
        }
      }

      const successful = opts.tiles.filter((t) => {
        const s = tileStates[t.id];
        return s?.status === 'done' && (s.pngDataUrl || s.result);
      });
      const skippedCount = opts.tiles.filter((t) => tileStates[t.id]?.status === 'skipped').length;
      const failedTiles = opts.tiles.length - successful.length - skippedCount;

      if (successful.length === 0) {
        throw new Error('No tiles produced output for this client.');
      }

      const generatedAt = new Date();
      const pptxBlob = await buildDeck({
        dashboardName: `${opts.dashboardName} — ${value}`,
        dashboardUrl: opts.dashboardUrl,
        generatedAt,
        brand: opts.brand,
        template: opts.template,
        tiles: successful.map((tile) => {
          const s = tileStates[tile.id];
          const resolvedSource = sourceFor(tile);
          return {
            tile,
            pngDataUrl: s.pngDataUrl,
            result: s.result,
            insight: opts.insights[tile.id],
            forceImage: resolvedSource === 'tile-image' || resolvedSource === 'full-dashboard',
            slideOverride: opts.slideOverrides?.[tile.id],
          };
        }),
        includeAppendix: opts.includeAppendix,
      });

      const fileName = deckFileName(`${opts.dashboardName} - ${value}`, generatedAt);
      files.push({ fileName, blob: pptxBlob, clientValue: value });
      succeeded += 1;
      opts.onClientUpdate({
        value,
        status: 'done',
        succeededTiles: successful.length,
        failedTiles,
        pptxBlob,
        fileName,
        message: usedFallback ? 'Done (fallback image)' : usedFullDashboardImage ? 'Done (full dashboard image)' : 'Ready',
      });
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : 'Failed';
      deckLog.error('batch', `[${value}] failed`, { error: msg });
      opts.onClientUpdate({
        value,
        status: 'failed',
        succeededTiles: 0,
        failedTiles: opts.tiles.length,
        error: msg,
      });
    }
  }

  return { files, succeeded, failed };
}

export async function bundleAsZip(
  files: Array<{ fileName: string; blob: Blob; clientValue: string }>,
  manifest: Record<string, unknown>
): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const f of files) {
    const buf = await f.blob.arrayBuffer();
    zip.file(f.fileName, buf);
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  return zip.generateAsync({ type: 'blob' });
}
