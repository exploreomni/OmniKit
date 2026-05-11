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
  allowFullDashboardFallback: boolean;
  signal?: AbortSignal;
  onClientUpdate: (status: BatchClientStatus) => void;
}

export interface BatchRunResult {
  files: Array<{ fileName: string; blob: Blob; clientValue: string }>;
  succeeded: number;
  failed: number;
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

    try {
      if (opts.strategy === 'full-dashboard') {
        deckLog.step('batch', `[${value}] full-dashboard strategy`);
        const blob = await exportFullDashboardAsPng(
          opts.baseUrl,
          opts.apiKey,
          opts.dashboardId,
          opts.signal,
          (m) => deckLog.info('batch', `[${value}] ${m}`)
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
      } else {
        const { states } = await runTileExports({
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          dashboardId: opts.dashboardId,
          tiles: opts.tiles,
          strategy: opts.strategy,
          perTileSource: opts.perTileSource,
          signal: opts.signal,
          filterOverrides: overrides,
          onUpdate: () => undefined,
        });
        Object.assign(tileStates, states);

        const okCount = Object.values(states).filter((s) => s.status === 'done').length;
        if (okCount === 0 && opts.allowFullDashboardFallback) {
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
          const src = opts.perTileSource?.[tile.id];
          return {
            tile,
            pngDataUrl: s.pngDataUrl,
            result: s.result,
            insight: opts.insights[tile.id],
            forceImage: src === 'tile-image',
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
        message: usedFallback ? 'Done (fallback image)' : 'Ready',
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
