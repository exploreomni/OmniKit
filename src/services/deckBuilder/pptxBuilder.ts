import PptxGenJS from 'pptxgenjs';
import { deckLog } from './log';
import { layoutForRole, resolveKitOrDefault } from './templateStore';
import type {
  BrandConfig,
  DashboardTile,
  InsightFormat,
  LayoutKit,
  SlideFitMode,
  SlideOverride,
  SlideOverlay,
  SlideLayout,
  TileColumn,
  TileRenderKind,
  TileResult,
} from './types';

export interface DeckTileEntry {
  tile: DashboardTile;
  pngDataUrl?: string;
  result?: TileResult;
  insight?: string;
  forceImage?: boolean;
  slideOverride?: SlideOverride;
}

export interface BuildDeckInput {
  dashboardName: string;
  dashboardUrl: string;
  generatedAt: Date;
  brand?: BrandConfig;
  template?: LayoutKit;
  tiles: DeckTileEntry[];
  includeAppendix: boolean;
  generatedByUser?: string;
}

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const NUMERIC_TYPES = new Set(['number', 'integer', 'float', 'double', 'decimal', 'numeric', 'bigint', 'long']);

function hex(input: string | undefined): string {
  return (input || '').replace(/^#/, '').toUpperCase() || '000000';
}

const NEUTRAL_SLATE_HEADER = '334155';

function decodePngSize(dataUrl: string): { w: number; h: number } | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const b64 = dataUrl.slice(comma + 1, comma + 1 + 64);
  try {
    const bin = atob(b64);
    if (bin.length < 24) return null;
    const code = (i: number) => bin.charCodeAt(i);
    if (code(0) !== 0x89 || code(1) !== 0x50 || code(2) !== 0x4e || code(3) !== 0x47) return null;
    const w = (code(16) << 24) | (code(17) << 16) | (code(18) << 8) | code(19);
    const h = (code(20) << 24) | (code(21) << 16) | (code(22) << 8) | code(23);
    if (w <= 0 || h <= 0) return null;
    return { w, h };
  } catch {
    return null;
  }
}

function cleanColumnLabel(raw: string): string {
  let s = raw || '';
  const dotIdx = s.lastIndexOf('.');
  if (dotIdx >= 0 && dotIdx < s.length - 1) s = s.slice(dotIdx + 1);
  s = s.replace(/^_+|_+$/g, '').replace(/_+/g, ' ');
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function isNumeric(col: TileColumn): boolean {
  return Boolean(col.type && NUMERIC_TYPES.has(col.type));
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (!isNaN(n)) return n;
  }
  return 0;
}

function formatCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < 1e6) return v.toLocaleString();
    if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return String(Number(v.toFixed(4)));
  }
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  } catch {
    return String(v);
  }
}

function formatKpi(v: unknown): string {
  if (typeof v === 'number') {
    if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
    if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}K`;
    if (Number.isInteger(v)) return v.toLocaleString();
    return String(Number(v.toFixed(2)));
  }
  return formatCell(v);
}

interface RenderCtx {
  slide: PptxGenJS.Slide;
  brand: BrandConfig;
  layout: SlideLayout;
  body: { x: number; y: number; w: number; h: number };
}

function paintLayoutChrome(slide: PptxGenJS.Slide, brand: BrandConfig, layout: SlideLayout, logoDataUrl?: string) {
  if (layout.backgroundImageDataUrl) {
    slide.background = { data: layout.backgroundImageDataUrl };
  } else {
    slide.background = { color: hex(layout.backgroundColor || brand.backgroundColor) };
  }

  if (layout.decorations && layout.decorations.length > 0) {
    for (const dec of layout.decorations) {
      if (dec.type === 'pic') {
        slide.addImage({
          data: dec.data,
          x: dec.x, y: dec.y, w: dec.w, h: dec.h,
          sizing: { type: 'contain', w: dec.w, h: dec.h },
        });
      } else if (dec.type === 'rect') {
        slide.addShape('rect', {
          x: dec.x, y: dec.y, w: dec.w, h: dec.h,
          fill: dec.fill ? { color: hex(dec.fill) } : { type: 'none' },
          line: dec.line ? { color: hex(dec.line), width: 0.75 } : { type: 'none' },
        });
      } else if (dec.type === 'text') {
        slide.addText(dec.text, {
          x: dec.x, y: dec.y, w: dec.w, h: dec.h,
          fontFace: dec.fontFamily || brand.fontFamily,
          fontSize: dec.fontSize ?? 14,
          bold: dec.bold,
          color: hex(dec.color || brand.bodyTextColor || '333333'),
          valign: 'middle',
        });
      }
    }
  }

  if (layout.headerBarColor && (layout.headerBarHeight ?? 0) > 0) {
    slide.addShape('rect', {
      x: 0,
      y: 0,
      w: SLIDE_W,
      h: layout.headerBarHeight!,
      fill: { color: hex(layout.headerBarColor) },
      line: { color: hex(layout.headerBarColor) },
    });
  }
  if (logoDataUrl && layout.logoBox) {
    const lb = layout.logoBox;
    slide.addImage({
      data: logoDataUrl,
      x: lb.x, y: lb.y, w: lb.w, h: lb.h,
      sizing: { type: 'contain', w: lb.w, h: lb.h },
    });
  }
}

function addTitle(slide: PptxGenJS.Slide, brand: BrandConfig, layout: SlideLayout, title: string) {
  const box = layout.titleBox || { x: 0.5, y: 0.3, w: SLIDE_W - 1, h: 0.7 };
  slide.addText(title || 'Untitled', {
    x: box.x, y: box.y, w: box.w, h: box.h,
    fontFace: brand.fontFamily,
    fontSize: box.fontSize ?? 24,
    bold: box.bold ?? true,
    color: hex(box.color || brand.titleColor),
  });
}

function insightTextFor(text: string | undefined, format: InsightFormat = 'paragraph'): string {
  const clean = (text || '').trim();
  if (!clean) return 'Add insight here...';
  if (format !== 'bullets') return clean;
  return clean
    .split('\n')
    .map((line) => line.replace(/^[•*-]\s*/, '').trim())
    .filter(Boolean)
    .map((line) => `• ${line}`)
    .join('\n');
}

function addInsightPanel(
  ctx: RenderCtx,
  insight: string | undefined,
  box?: { x: number; y: number; w: number; h: number },
  format: InsightFormat = 'paragraph',
) {
  const { slide, brand, layout } = ctx;
  const body = ctx.body;
  if (!layout.insightPanel && !box && !insight?.trim()) return;
  const fallbackX = body.x + body.w + 0.3;
  const panel = box || {
    x: fallbackX < SLIDE_W - 1.9 ? fallbackX : 0.6,
    y: fallbackX < SLIDE_W - 1.9 ? body.y : SLIDE_H - 1.8,
    w: fallbackX < SLIDE_W - 1.9 ? Math.max(1.5, SLIDE_W - fallbackX - 0.5) : SLIDE_W - 1.2,
    h: fallbackX < SLIDE_W - 1.9 ? body.h : 1.25,
  };
  slide.addShape('rect', {
    x: panel.x, y: panel.y, w: panel.w, h: panel.h,
    fill: { color: 'F8F1F5' },
    line: { color: hex(brand.accentColor), width: 0.75 },
  });
  slide.addText('Insights', {
    x: panel.x + 0.2, y: panel.y + 0.15, w: panel.w - 0.4, h: 0.35,
    fontFace: brand.fontFamily, fontSize: 12, bold: true, color: hex(brand.primaryColor),
  });
  slide.addText(insightTextFor(insight, format), {
    x: panel.x + 0.2, y: panel.y + 0.55, w: panel.w - 0.4, h: Math.max(0.3, panel.h - 0.7),
    fontFace: brand.fontFamily, fontSize: 12, color: hex(brand.bodyTextColor || '333333'), valign: 'top',
  });
}

function addOverlays(slide: PptxGenJS.Slide, brand: BrandConfig, overlays: SlideOverlay[] | undefined) {
  if (!overlays || overlays.length === 0) return;
  for (const overlay of overlays) {
    const color = hex(overlay.color || brand.accentColor);
    if (overlay.type === 'arrow' || overlay.type === 'line') {
      slide.addShape('line', {
        x: overlay.x,
        y: overlay.y,
        w: overlay.w,
        h: overlay.h,
        rotate: overlay.rotation,
        line: { color, width: 2, endArrowType: overlay.type === 'arrow' ? 'triangle' : 'none' },
      });
    } else if (overlay.type === 'box') {
      slide.addShape('rect', {
        x: overlay.x,
        y: overlay.y,
        w: overlay.w,
        h: overlay.h,
        rotate: overlay.rotation,
        fill: { color: 'FFFFFF', transparency: 100 },
        line: { color, width: 1.75 },
      });
    } else if (overlay.type === 'symbol') {
      slide.addShape('ellipse', {
        x: overlay.x,
        y: overlay.y,
        w: overlay.w,
        h: overlay.h,
        rotate: overlay.rotation,
        fill: { color: 'FFFFFF', transparency: 10 },
        line: { color, width: 1.5 },
      });
      slide.addText(overlay.text || '!', {
        x: overlay.x,
        y: overlay.y + overlay.h * 0.08,
        w: overlay.w,
        h: overlay.h,
        rotate: overlay.rotation,
        fontFace: brand.fontFamily,
        fontSize: Math.max(12, overlay.h * 30),
        bold: true,
        color,
        align: 'center',
        valign: 'middle',
      });
    } else {
      slide.addText(overlay.text || 'Key takeaway', {
        x: overlay.x,
        y: overlay.y,
        w: overlay.w,
        h: overlay.h,
        rotate: overlay.rotation,
        fontFace: brand.fontFamily,
        fontSize: 12,
        bold: true,
        color,
        valign: 'middle',
        fit: 'shrink',
        fill: { color: 'FFFFFF', transparency: 5 },
        line: { color, width: 1 },
        margin: 0.08,
      });
    }
  }
}

function addFooter(slide: PptxGenJS.Slide, brand: BrandConfig, layout: SlideLayout, dashboardName: string, dateLabel: string) {
  const fb = layout.footerBox;
  if (!fb) return;
  slide.addText(`${dashboardName}  •  ${dateLabel}`, {
    x: fb.x, y: fb.y, w: Math.max(1, fb.w - 2), h: fb.h,
    fontFace: brand.fontFamily,
    fontSize: fb.fontSize ?? 9,
    color: hex(fb.color || '888888'),
  });
  slide.addText(brand.footerText, {
    x: fb.x + Math.max(1, fb.w - 2), y: fb.y, w: 2, h: fb.h,
    fontFace: brand.fontFamily,
    fontSize: fb.fontSize ?? 9,
    color: hex(fb.color || '888888'),
    align: 'right',
  });
}

function renderKpi(ctx: RenderCtx, result: TileResult) {
  const { slide, brand, body } = ctx;
  const col = result.columns[0];
  const value = result.rows[0]?.[col.name];
  slide.addText(formatKpi(value), {
    x: body.x, y: body.y + body.h * 0.2, w: body.w, h: body.h * 0.5,
    fontFace: brand.fontFamily, fontSize: 96, bold: true,
    color: hex(brand.primaryColor), align: 'center', valign: 'middle',
  });
  slide.addText(col.label || col.name, {
    x: body.x, y: body.y + body.h * 0.7, w: body.w, h: 0.6,
    fontFace: brand.fontFamily, fontSize: 18, color: hex(brand.titleColor), align: 'center',
  });
}

type ChartName = 'bar' | 'line' | 'pie';

function paletteFor(brand: BrandConfig): string[] {
  if (brand.chartPalette && brand.chartPalette.length > 0) return brand.chartPalette.map(hex);
  return [hex(brand.primaryColor), hex(brand.accentColor), '6B7280', '10B981', 'F59E0B', 'EF4444'];
}

function renderChart(
  ctx: RenderCtx,
  result: TileResult,
  kind: ChartName,
  chartTypes: { bar: ChartName; line: ChartName; pie: ChartName }
) {
  const { slide, brand, body } = ctx;
  const palette = paletteFor(brand);
  const dimCol = result.columns.find((col) => !isNumeric(col)) || result.columns[0];
  const measureCols = result.columns.filter((col) => isNumeric(col) && col.name !== dimCol.name);
  if (measureCols.length === 0) {
    renderTable(ctx, result);
    return;
  }
  const labels = result.rows.map((r) => formatCell(r[dimCol.name]));

  if (kind === 'pie') {
    const measure = measureCols[0];
    const data = [
      { name: measure.label || measure.name, labels, values: result.rows.map((r) => toNumber(r[measure.name])) },
    ];
    slide.addChart(chartTypes.pie, data, {
      x: body.x, y: body.y, w: body.w, h: body.h,
      chartColors: palette,
      showLegend: true, legendPos: 'r', showPercent: true,
    });
    return;
  }

  const data = measureCols.map((m) => ({
    name: m.label || m.name, labels,
    values: result.rows.map((r) => toNumber(r[m.name])),
  }));

  slide.addChart(kind === 'line' ? chartTypes.line : chartTypes.bar, data, {
    x: body.x, y: body.y, w: body.w, h: body.h,
    chartColors: palette,
    catAxisLabelFontFace: brand.fontFamily, catAxisLabelFontSize: 10,
    valAxisLabelFontFace: brand.fontFamily, valAxisLabelFontSize: 10,
    showLegend: measureCols.length > 1, legendPos: 'b',
    barDir: kind === 'bar' ? 'col' : undefined,
  });
}

function resolveTableColors(brand: BrandConfig): { header: string; zebra: string } {
  const mode = brand.tableHeaderMode || 'brand';
  if (mode === 'neutral') {
    return { header: NEUTRAL_SLATE_HEADER, zebra: hex(brand.tableZebraColor || 'F1F5F9') };
  }
  return {
    header: hex(brand.tableHeaderColor || brand.primaryColor),
    zebra: hex(brand.tableZebraColor || 'F8F1F5'),
  };
}

function renderTable(ctx: RenderCtx, result: TileResult) {
  const { slide, brand, body } = ctx;
  const { header: headerFill, zebra: zebraFill } = resolveTableColors(brand);
  const bodyColor = hex(brand.bodyTextColor || '1F2937');

  const numCols = Math.max(1, result.columns.length);
  const colW = Math.max(0.6, body.w / numCols);
  const charsPerCol = Math.max(8, Math.floor(colW * 12));

  const headerRow = result.columns.map((col) => {
    const cleaned = cleanColumnLabel(col.label || col.name);
    const text = cleaned.length > charsPerCol ? `${cleaned.slice(0, charsPerCol - 1)}…` : cleaned;
    return {
      text,
      options: {
        bold: true, color: 'FFFFFF',
        fill: { color: headerFill },
        fontFace: brand.fontFamily, fontSize: 11,
        align: (isNumeric(col) ? 'right' : 'left') as 'right' | 'left',
        valign: 'middle' as const,
      },
    };
  });

  const bodyRows = result.rows.map((row, idx) =>
    result.columns.map((col) => ({
      text: formatCell(row[col.name]),
      options: {
        fontFace: brand.fontFamily, fontSize: 10, color: bodyColor,
        fill: { color: idx % 2 === 0 ? 'FFFFFF' : zebraFill },
        align: (isNumeric(col) ? 'right' : 'left') as 'right' | 'left',
        valign: 'middle' as const,
      },
    }))
  );

  slide.addTable([headerRow, ...bodyRows], {
    x: body.x, y: body.y, w: body.w,
    h: Math.min(body.h, 0.35 + 0.28 * (result.rows.length + 1)),
    colW: Array(numCols).fill(colW),
    fontFace: brand.fontFamily,
    border: { type: 'solid', color: 'E5E7EB', pt: 0.5 },
    autoPage: false,
  });

  if (result.truncated) {
    slide.addText(`Showing first ${result.rows.length} of ${result.rowCount} rows`, {
      x: body.x, y: body.y + body.h - 0.3, w: body.w, h: 0.3,
      fontFace: brand.fontFamily, fontSize: 9, italic: true, color: '6B7280',
    });
  }
}

function renderEmpty(ctx: RenderCtx) {
  const { slide, brand, body } = ctx;
  slide.addText('No data returned for this tile.', {
    x: body.x, y: body.y + body.h / 2 - 0.4, w: body.w, h: 0.8,
    fontFace: brand.fontFamily, fontSize: 18, color: '9CA3AF', align: 'center', italic: true,
  });
}

function renderMarkdown(ctx: RenderCtx, result: TileResult) {
  const { slide, brand, body } = ctx;
  const text = String(result.rows[0]?.markdown ?? '').replace(/[#*_`>]/g, '').trim();
  slide.addText(text || 'Empty text tile', {
    x: body.x, y: body.y, w: body.w, h: body.h,
    fontFace: brand.fontFamily, fontSize: 14, color: hex(brand.bodyTextColor || '1F2937'), valign: 'top',
  });
}

function renderUnsupported(ctx: RenderCtx, tileName: string) {
  const { slide, brand, body } = ctx;
  slide.addText(`"${tileName}" cannot be rendered natively (unsupported tile type).`, {
    x: body.x, y: body.y + body.h / 2 - 0.4, w: body.w, h: 0.8,
    fontFace: brand.fontFamily, fontSize: 16, color: '9CA3AF', align: 'center', italic: true,
  });
}

function renderImage(ctx: RenderCtx, pngDataUrl: string, fit: SlideFitMode = 'contain') {
  const { slide, body, layout } = ctx;
  const gutter = layout.insightPanel ? 0.1 : 0;
  const maxW = Math.max(0.5, body.w - gutter);
  const maxH = body.h;

  if (fit === 'stretch') {
    slide.addImage({
      data: pngDataUrl,
      x: body.x,
      y: body.y,
      w: maxW,
      h: maxH,
    });
    return;
  }

  if (fit === 'cover') {
    slide.addImage({
      data: pngDataUrl,
      x: body.x,
      y: body.y,
      w: maxW,
      h: maxH,
      sizing: { type: 'cover', w: maxW, h: maxH },
    });
    return;
  }

  const size = decodePngSize(pngDataUrl);
  let w = maxW;
  let h = maxH;
  if (size) {
    const imgAspect = size.w / size.h;
    const boxAspect = maxW / maxH;
    if (imgAspect > boxAspect) {
      w = maxW;
      h = maxW / imgAspect;
    } else {
      h = maxH;
      w = maxH * imgAspect;
    }
  }

  const x = body.x + (maxW - w) / 2;
  const y = body.y + (maxH - h) / 2;

  slide.addImage({
    data: pngDataUrl,
    x, y, w, h,
    sizing: { type: 'contain', w, h },
  });
}

export async function buildDeck(input: BuildDeckInput): Promise<Blob> {
  const pptx = new PptxGenJS();
  const chartTypes: { bar: ChartName; line: ChartName; pie: ChartName } = {
    bar: pptx.ChartType.bar as ChartName,
    line: pptx.ChartType.line as ChartName,
    pie: pptx.ChartType.pie as ChartName,
  };
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = `${input.dashboardName} - Generated Deck`;

  const baseKit = resolveKitOrDefault(input.template || input.brand);
  const kit = input.brand ? { ...baseKit, brand: input.brand } : baseKit;
  const brand = kit.brand;
  pptx.company = brand.name;

  const dateLabel = input.generatedAt.toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const titleLayout = layoutForRole(kit, 'title');
  const contentLayout = layoutForRole(kit, 'content');
  const appendixLayout = layoutForRole(kit, 'appendix');

  // Title slide
  const titleSlide = pptx.addSlide();
  paintLayoutChrome(titleSlide, brand, titleLayout, brand.logoDataUrl);
  addTitle(titleSlide, brand, titleLayout, input.dashboardName);
  if (titleLayout.bodyBox) {
    titleSlide.addText(`Generated ${dateLabel}`, {
      x: titleLayout.bodyBox.x, y: titleLayout.bodyBox.y, w: titleLayout.bodyBox.w, h: titleLayout.bodyBox.h,
      fontFace: brand.fontFamily, fontSize: 18, color: hex(brand.accentColor),
    });
  }
  if (titleLayout.footerBox) {
    titleSlide.addText(brand.footerText, {
      x: titleLayout.footerBox.x, y: titleLayout.footerBox.y, w: titleLayout.footerBox.w, h: titleLayout.footerBox.h,
      fontFace: brand.fontFamily, fontSize: titleLayout.footerBox.fontSize ?? 10,
      color: hex(titleLayout.footerBox.color || '888888'),
    });
  }

  // Content slides
  for (const entry of input.tiles) {
    const slide = pptx.addSlide();
    paintLayoutChrome(slide, brand, contentLayout, brand.logoDataUrl);
    addTitle(slide, brand, contentLayout, entry.slideOverride?.title || entry.tile.name);

    const body = entry.slideOverride?.bodyBox || contentLayout.bodyBox || { x: 0.5, y: 1.1, w: 8.6, h: 5.6 };
    const ctx: RenderCtx = { slide, brand, layout: contentLayout, body };
    const fit = entry.slideOverride?.fit || 'contain';

    const wantImage = entry.forceImage && entry.pngDataUrl;
    if (wantImage) {
      renderImage(ctx, entry.pngDataUrl!, fit);
    } else if (entry.result) {
      const kind: TileRenderKind = entry.result.renderKind;
      try {
        if (kind === 'kpi') renderKpi(ctx, entry.result);
        else if (kind === 'bar' || kind === 'line' || kind === 'pie') renderChart(ctx, entry.result, kind, chartTypes);
        else if (kind === 'empty') renderEmpty(ctx);
        else if (kind === 'markdown') renderMarkdown(ctx, entry.result);
        else if (kind === 'unsupported') renderUnsupported(ctx, entry.tile.name);
        else renderTable(ctx, entry.result);
      } catch (err) {
        deckLog.warn('render', `Falling back to table for tile "${entry.tile.name}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
        renderTable(ctx, entry.result);
      }
    } else if (entry.pngDataUrl) {
      renderImage(ctx, entry.pngDataUrl, fit);
    } else {
      renderEmpty(ctx);
    }

    addInsightPanel(ctx, entry.insight, entry.slideOverride?.insightBox, entry.slideOverride?.insightFormat);
    addOverlays(slide, brand, entry.slideOverride?.overlays);
    addFooter(slide, brand, contentLayout, input.dashboardName, dateLabel);
    if (entry.slideOverride?.speakerNotes?.trim()) {
      slide.addNotes(insightTextFor(entry.slideOverride.speakerNotes, entry.slideOverride.speakerNotesFormat));
    }
  }

  if (input.includeAppendix) {
    const appendix = pptx.addSlide();
    paintLayoutChrome(appendix, brand, appendixLayout);
    addTitle(appendix, brand, appendixLayout, 'Source & Audit');

    const lines: Array<{ text: string; options?: PptxGenJS.TextPropsOptions }> = [
      { text: 'Dashboard: ', options: { bold: true } },
      { text: `${input.dashboardName}\n` },
      { text: 'URL: ', options: { bold: true } },
      { text: `${input.dashboardUrl}\n` },
      { text: 'Generated: ', options: { bold: true } },
      { text: `${input.generatedAt.toISOString()}\n` },
      { text: 'Generated by: ', options: { bold: true } },
      { text: `${input.generatedByUser || 'OmniKit user'}\n\n` },
      { text: 'Selected tiles:\n', options: { bold: true } },
      ...input.tiles.map((t) => {
        const rk = t.result?.renderKind;
        const tag = t.forceImage ? ' (image)' : rk ? ` (${rk})` : t.pngDataUrl ? ' (image)' : '';
        return { text: `• ${t.tile.name}${tag}\n` };
      }),
    ];

    const ab = appendixLayout.bodyBox || { x: 0.6, y: 1.2, w: SLIDE_W - 1.2, h: SLIDE_H - 1.6 };
    appendix.addText(lines, {
      x: ab.x, y: ab.y, w: ab.w, h: ab.h,
      fontFace: brand.fontFamily, fontSize: 12, color: hex(brand.bodyTextColor || '333333'), valign: 'top',
    });
  }

  const arrayBuffer = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
  return new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}

export function deckFileName(dashboardName: string, generatedAt: Date): string {
  const slug = (dashboardName || 'omni-dashboard')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'omni-dashboard';
  const date = generatedAt.toISOString().slice(0, 10);
  return `${slug}_${date}.pptx`;
}
