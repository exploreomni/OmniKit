import { exportTileAsPng, blobToDataUrl } from './omniDeckApi';
import type { TileExportShape } from './omniDeckApi';
import { runTileQuery } from './queryRunner';
import { deckLog } from './log';
import type { DashboardTile, FilterOverride, RenderStrategy, TileExportState, TileVisualSource } from './types';

interface RunOptions {
  baseUrl: string;
  apiKey: string;
  dashboardId: string;
  tiles: DashboardTile[];
  strategy: RenderStrategy;
  /** Optional per-tile override; falls back to top-level strategy when a tile id is absent. */
  perTileSource?: Record<string, TileVisualSource>;
  concurrency?: number;
  onUpdate: (state: TileExportState) => void;
  signal?: AbortSignal;
  filterOverrides?: Record<string, FilterOverride>;
}

interface RunResult {
  states: Record<string, TileExportState>;
  shapeUsed: TileExportShape | null;
}

export async function runTileExports(opts: RunOptions): Promise<RunResult> {
  const { baseUrl, apiKey, dashboardId, tiles, strategy, onUpdate, signal, filterOverrides, perTileSource } = opts;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 6));
  const results: Record<string, TileExportState> = {};

  const sourceFor = (tileId: string): TileVisualSource => {
    const override = perTileSource?.[tileId];
    if (override) return override;
    return strategy === 'tile-image' ? 'tile-image' : 'native';
  };

  deckLog.step('exporter', `Starting tile run`, {
    dashboardId,
    tileCount: tiles.length,
    concurrency,
    strategy,
    perTileOverrides: perTileSource ? Object.keys(perTileSource).length : 0,
  });

  for (const tile of tiles) {
    const src = sourceFor(tile.id);
    if (src === 'skip') {
      results[tile.id] = { tileId: tile.id, status: 'skipped', strategy, message: 'Skipped by user' };
    } else {
      results[tile.id] = { tileId: tile.id, status: 'queued', strategy };
    }
    onUpdate(results[tile.id]);
  }

  let firstSuccessfulShape: TileExportShape | null = null;
  let firstStatusLogged = false;
  const queue = [...tiles];

  const workers = Array.from({ length: concurrency }).map(async () => {
    while (queue.length > 0) {
      if (signal?.aborted) return;
      const tile = queue.shift();
      if (!tile) return;
      const update = (patch: Partial<TileExportState>) => {
        results[tile.id] = { ...results[tile.id], ...patch };
        onUpdate(results[tile.id]);
      };

      const resolved = sourceFor(tile.id);
      if (resolved === 'skip') {
        continue;
      }

      update({ status: 'exporting', message: 'Starting' });

      if (resolved === 'native') {
        try {
          const { result } = await runTileQuery(baseUrl, apiKey, dashboardId, tile, signal, filterOverrides);
          update({
            status: 'done',
            message: `Rendered as ${result.renderKind} (${result.rowCount} rows)`,
            result,
            renderKind: result.renderKind,
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Query run failed.';
          deckLog.error('exporter', `Tile query failed: ${tile.name}`, { tileId: tile.id, error: errorMessage });
          update({ status: 'failed', error: errorMessage });
        }
        continue;
      }

      if (resolved === 'tile-image') {
        try {
          const defaultShapes: TileExportShape[] = ['queryIdentifierMapKey'];
          const shapesToTry: TileExportShape[] = firstSuccessfulShape
            ? ([firstSuccessfulShape, ...defaultShapes].filter(
                (s, i, a) => a.indexOf(s) === i
              ) as TileExportShape[])
            : defaultShapes;

          const logRaw = !firstStatusLogged;
          firstStatusLogged = true;

          const { blob, shapeUsed } = await exportTileAsPng(baseUrl, apiKey, dashboardId, {
            tile,
            signal,
            shapes: shapesToTry,
            filterOverrides,
            logFirstStatusPayload: logRaw,
            onStatusChange: (msg) => update({ status: 'polling', message: msg }),
          });
          if (!firstSuccessfulShape) {
            firstSuccessfulShape = shapeUsed;
            deckLog.step('exporter', `Locked successful per-tile shape: ${shapeUsed}`);
          }
          update({ status: 'fetching', message: 'Encoding image' });
          const dataUrl = await blobToDataUrl(blob);
          update({
            status: 'done',
            message: 'Ready',
            pngDataUrl: dataUrl,
            pngSize: blob.size,
            renderKind: undefined,
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Tile image export failed.';
          deckLog.error('exporter', `Tile failed: ${tile.name}`, { tileId: tile.id, error: errorMessage });
          update({ status: 'failed', error: errorMessage });
        }
        continue;
      }

      // strategy === 'full-dashboard' is handled at page level (single PNG, mirrored to all tiles)
      update({ status: 'queued', message: 'Awaiting full-dashboard fallback' });
    }
  });

  await Promise.all(workers);

  deckLog.step('exporter', 'Tile run complete', {
    succeeded: Object.values(results).filter((r) => r.status === 'done').length,
    failed: Object.values(results).filter((r) => r.status === 'failed').length,
    shapeUsed: firstSuccessfulShape,
  });

  return { states: results, shapeUsed: firstSuccessfulShape };
}
