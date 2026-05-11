import type JSZip from 'jszip';
import { deckLog } from './log';
import { defaultLayoutsForBrand } from './templateStore';
import type { BrandConfig, LayoutDecoration, LayoutKit, SlideLayout, SlideRole } from './types';
import { DEFAULT_BRAND } from './types';

type JSZipInstance = InstanceType<typeof JSZip>;

const MAX_BYTES = 15 * 1024 * 1024;
const EMU_PER_INCH = 914400;

export interface IngestOptions {
  splitMasters?: boolean;
}

export interface IngestResult {
  kits: LayoutKit[];
  warnings: string[];
}

export async function ingestPptxTemplate(file: File, opts: IngestOptions = {}): Promise<IngestResult> {
  if (file.size > MAX_BYTES) {
    throw new Error(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is 15 MB.`);
  }
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  if (!zip.file('[Content_Types].xml')) {
    throw new Error('Not a valid .pptx file (missing Content Types).');
  }

  const warnings: string[] = [];
  const parser = new DOMParser();

  async function readXml(path: string): Promise<Document | null> {
    const entry = zip.file(path);
    if (!entry) return null;
    const xml = await entry.async('string');
    const doc = parser.parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      deckLog.warn('template-ingest', `XML parse error at ${path}`);
      return null;
    }
    return doc;
  }

  async function readBinary(path: string): Promise<string | null> {
    const entry = zip.file(path);
    if (!entry) return null;
    const blob = await entry.async('blob');
    return await blobToDataUrl(blob);
  }

  // Theme colors + fonts
  const themeDoc = await readXml('ppt/theme/theme1.xml');
  const themeColors: Record<string, string> = {};
  let majorFont = DEFAULT_BRAND.fontFamily;
  let minorFont = DEFAULT_BRAND.fontFamily;
  if (themeDoc) {
    const clrScheme = themeDoc.getElementsByTagNameNS('*', 'clrScheme')[0];
    if (clrScheme) {
      for (const child of Array.from(clrScheme.children)) {
        const name = child.localName;
        const srgb = child.getElementsByTagNameNS('*', 'srgbClr')[0];
        const sys = child.getElementsByTagNameNS('*', 'sysClr')[0];
        const val = srgb?.getAttribute('val') || sys?.getAttribute('lastClr');
        if (name && val) themeColors[name] = val.toUpperCase();
      }
    }
    const majorLatin = themeDoc.getElementsByTagNameNS('*', 'majorFont')[0]?.getElementsByTagNameNS('*', 'latin')[0];
    const minorLatin = themeDoc.getElementsByTagNameNS('*', 'minorFont')[0]?.getElementsByTagNameNS('*', 'latin')[0];
    if (majorLatin?.getAttribute('typeface')) majorFont = majorLatin.getAttribute('typeface')!;
    if (minorLatin?.getAttribute('typeface')) minorFont = minorLatin.getAttribute('typeface')!;
  } else {
    warnings.push('No theme1.xml found — using default colors.');
  }

  // Thumbnail
  const thumbnail = await readBinary('docProps/thumbnail.jpeg');

  // Enumerate masters + layouts
  const masters: Array<{ path: string; doc: Document }> = [];
  for (const path of Object.keys(zip.files)) {
    if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(path)) {
      const doc = await readXml(path);
      if (doc) masters.push({ path, doc });
    }
  }
  if (masters.length === 0) warnings.push('No slide masters found.');

  const masterDecorations: Record<number, LayoutDecoration[]> = {};
  const layoutEntries: Array<{ path: string; doc: Document; masterIndex: number }> = [];
  for (let i = 0; i < masters.length; i += 1) {
    const master = masters[i];
    const relsPath = master.path.replace(/\/slideMaster(\d+)\.xml$/, '/_rels/slideMaster$1.xml.rels');
    const relsDoc = await readXml(relsPath);
    if (!relsDoc) continue;
    masterDecorations[i] = await extractDecorations(master.doc, master.path, zip, relsDoc, themeColors);
    const rels = Array.from(relsDoc.getElementsByTagNameNS('*', 'Relationship'));
    for (const rel of rels) {
      const type = rel.getAttribute('Type') || '';
      if (!type.endsWith('/slideLayout')) continue;
      const target = rel.getAttribute('Target') || '';
      const layoutPath = resolveRelPath(master.path, target);
      const doc = await readXml(layoutPath);
      if (doc) layoutEntries.push({ path: layoutPath, doc, masterIndex: i });
    }
  }

  // Parse theme-based BrandConfig — explicitly construct so OmniKit defaults
  // like pink table headers do not leak into uploaded templates.
  const primaryColor = themeColors['accent1'] || DEFAULT_BRAND.primaryColor;
  const accentColor = themeColors['accent2'] || themeColors['accent1'] || DEFAULT_BRAND.accentColor;
  const titleColor = themeColors['dk1'] || themeColors['tx1'] || DEFAULT_BRAND.titleColor;
  const backgroundColor = themeColors['lt1'] || themeColors['bg1'] || DEFAULT_BRAND.backgroundColor;
  const palette = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
    .map((k) => themeColors[k])
    .filter(Boolean) as string[];

  const brandBase: BrandConfig = {
    name: file.name.replace(/\.pptx$/i, ''),
    fontFamily: minorFont || majorFont || DEFAULT_BRAND.fontFamily,
    footerText: '',
    primaryColor,
    accentColor,
    titleColor,
    backgroundColor,
    tableHeaderColor: primaryColor,
    tableZebraColor: 'F3F4F6',
    bodyTextColor: titleColor || '1F2937',
    chartPalette: palette.length > 0 ? palette : DEFAULT_BRAND.chartPalette,
  };

  // Convert each layout entry into a SlideLayout
  const slideLayoutsByMaster: Record<number, SlideLayout[]> = {};
  for (const entry of layoutEntries) {
    const sl = await parseSlideLayout(
      entry.doc,
      entry.path,
      zip,
      brandBase,
      themeColors,
      masterDecorations[entry.masterIndex] || []
    );
    if (!slideLayoutsByMaster[entry.masterIndex]) slideLayoutsByMaster[entry.masterIndex] = [];
    slideLayoutsByMaster[entry.masterIndex].push(sl);
  }

  if (Object.keys(slideLayoutsByMaster).length === 0) {
    warnings.push('No slide layouts parsed — using generated defaults.');
    const kit: LayoutKit = {
      id: `pptx-${Date.now()}`,
      name: brandBase.name,
      source: 'pptx',
      sourceFileName: file.name,
      brand: brandBase,
      layouts: defaultLayoutsForBrand(brandBase),
      thumbnailDataUrl: thumbnail || undefined,
      importedAt: Date.now(),
    };
    return { kits: [kit], warnings };
  }

  const masterCount = Object.keys(slideLayoutsByMaster).length;
  const splitByMaster = opts.splitMasters && masterCount > 1;

  const kits: LayoutKit[] = [];
  if (splitByMaster) {
    for (const [idxStr, layouts] of Object.entries(slideLayoutsByMaster)) {
      const idx = Number(idxStr);
      const merged = mergeWithDefaults(layouts, brandBase);
      kits.push({
        id: `pptx-${Date.now()}-m${idx}`,
        name: `${brandBase.name} (master ${idx + 1})`,
        source: 'pptx',
        sourceFileName: file.name,
        brand: brandBase,
        layouts: merged,
        thumbnailDataUrl: thumbnail || undefined,
        importedAt: Date.now(),
      });
    }
  } else {
    const allLayouts = Object.values(slideLayoutsByMaster).flat();
    const merged = mergeWithDefaults(allLayouts, brandBase);
    kits.push({
      id: `pptx-${Date.now()}`,
      name: brandBase.name,
      source: 'pptx',
      sourceFileName: file.name,
      brand: brandBase,
      layouts: merged,
      thumbnailDataUrl: thumbnail || undefined,
      importedAt: Date.now(),
    });
  }

  deckLog.step('template-ingest', `Parsed ${layoutEntries.length} layout(s) across ${masterCount} master(s)`, {
    file: file.name,
    kitCount: kits.length,
    warnings: warnings.length,
  });

  return { kits, warnings };
}

function mergeWithDefaults(parsed: SlideLayout[], brand: BrandConfig): SlideLayout[] {
  const byRole: Record<SlideRole, SlideLayout | undefined> = {
    title: parsed.find((l) => l.role === 'title'),
    content: parsed.find((l) => l.role === 'content'),
    section: parsed.find((l) => l.role === 'section'),
    closing: parsed.find((l) => l.role === 'closing'),
    appendix: parsed.find((l) => l.role === 'appendix'),
  };
  const defaults = defaultLayoutsForBrand(brand);
  const out: SlideLayout[] = [];
  for (const role of ['title', 'content', 'section', 'closing', 'appendix'] as SlideRole[]) {
    out.push(byRole[role] || defaults.find((d) => d.role === role)!);
  }
  // Preserve any extra parsed layouts (duplicates for same role become aliases)
  for (const extra of parsed) {
    if (!out.includes(extra)) out.push(extra);
  }
  return out;
}

async function parseSlideLayout(
  doc: Document,
  layoutPath: string,
  zip: JSZipInstance,
  brand: BrandConfig,
  themeColors: Record<string, string>,
  masterDecorations: LayoutDecoration[]
): Promise<SlideLayout> {
  const cSld = doc.getElementsByTagNameNS('*', 'cSld')[0];
  const layoutName = cSld?.getAttribute('name') || 'Layout';
  const type = doc.getElementsByTagNameNS('*', 'sldLayout')[0]?.getAttribute('type') || '';

  const role = guessRole(layoutName, type);

  const bgColor = parseSolidFillColor(cSld, themeColors);

  const relsPath = layoutPath.replace(/\/slideLayout(\d+)\.xml$/, '/_rels/slideLayout$1.xml.rels');
  const relsDoc = await (async () => {
    const entry = zip.file(relsPath);
    if (!entry) return null;
    const xml = await entry.async('string');
    return new DOMParser().parseFromString(xml, 'application/xml');
  })();

  const layoutDecorations = relsDoc ? await extractDecorations(doc, layoutPath, zip, relsDoc, themeColors) : [];
  const decorations = [...masterDecorations, ...layoutDecorations];

  // Placeholder geometry
  const spTree = cSld?.getElementsByTagNameNS('*', 'spTree')[0];
  let titleBox: SlideLayout['titleBox'];
  let bodyBox: SlideLayout['bodyBox'];
  if (spTree) {
    for (const sp of Array.from(spTree.getElementsByTagNameNS('*', 'sp'))) {
      const phType = sp
        .getElementsByTagNameNS('*', 'nvSpPr')[0]
        ?.getElementsByTagNameNS('*', 'nvPr')[0]
        ?.getElementsByTagNameNS('*', 'ph')[0]
        ?.getAttribute('type') || '';
      const xfrm = sp.getElementsByTagNameNS('*', 'spPr')[0]?.getElementsByTagNameNS('*', 'xfrm')[0];
      if (!xfrm) continue;
      const offEl = xfrm.getElementsByTagNameNS('*', 'off')[0];
      const extEl = xfrm.getElementsByTagNameNS('*', 'ext')[0];
      if (!offEl || !extEl) continue;
      const x = emuToIn(Number(offEl.getAttribute('x')));
      const y = emuToIn(Number(offEl.getAttribute('y')));
      const w = emuToIn(Number(extEl.getAttribute('cx')));
      const h = emuToIn(Number(extEl.getAttribute('cy')));
      if (!titleBox && (phType === 'title' || phType === 'ctrTitle')) {
        titleBox = { x, y, w, h, fontSize: phType === 'ctrTitle' ? 40 : 24, color: brand.titleColor, bold: true };
      } else if (!bodyBox && (phType === 'body' || phType === '' || phType === 'subTitle')) {
        bodyBox = { x, y, w, h };
      }
    }
  }

  const defaults = defaultLayoutsForBrand(brand);
  const defaultForRole = defaults.find((d) => d.role === role)!;

  return {
    id: `parsed-${layoutPath.replace(/[^a-z0-9]+/gi, '-')}`,
    role,
    name: layoutName,
    backgroundColor: bgColor || defaultForRole.backgroundColor,
    backgroundImageDataUrl: undefined,
    headerBarColor: undefined,
    headerBarHeight: undefined,
    titleBox: titleBox || defaultForRole.titleBox,
    bodyBox: bodyBox || defaultForRole.bodyBox,
    footerBox: defaultForRole.footerBox,
    logoBox: undefined,
    insightPanel: false,
    decorations: decorations.length > 0 ? decorations : undefined,
  };
}

async function extractDecorations(
  doc: Document,
  docPath: string,
  zip: JSZipInstance,
  relsDoc: Document,
  themeColors: Record<string, string>
): Promise<LayoutDecoration[]> {
  const cSld = doc.getElementsByTagNameNS('*', 'cSld')[0];
  const spTree = cSld?.getElementsByTagNameNS('*', 'spTree')[0];
  if (!spTree) return [];

  const relMap: Record<string, string> = {};
  for (const rel of Array.from(relsDoc.getElementsByTagNameNS('*', 'Relationship'))) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) relMap[id] = target;
  }

  const decorations: LayoutDecoration[] = [];

  for (const node of Array.from(spTree.children)) {
    const local = node.localName;
    const xfrm = node.getElementsByTagNameNS('*', 'xfrm')[0];
    if (!xfrm) continue;
    const offEl = xfrm.getElementsByTagNameNS('*', 'off')[0];
    const extEl = xfrm.getElementsByTagNameNS('*', 'ext')[0];
    if (!offEl || !extEl) continue;
    const x = emuToIn(Number(offEl.getAttribute('x')));
    const y = emuToIn(Number(offEl.getAttribute('y')));
    const w = emuToIn(Number(extEl.getAttribute('cx')));
    const h = emuToIn(Number(extEl.getAttribute('cy')));
    if (w <= 0 || h <= 0) continue;

    if (local === 'pic') {
      const blip = node.getElementsByTagNameNS('*', 'blip')[0];
      const embedId = blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')
        || blip?.getAttribute('r:embed');
      if (!embedId) continue;
      const target = relMap[embedId];
      if (!target) continue;
      const imgPath = resolveRelPath(docPath, target);
      const data = await readBinary(zip, imgPath);
      if (!data) continue;
      decorations.push({ type: 'pic', x, y, w, h, data });
    } else if (local === 'sp') {
      const isPlaceholder = !!node
        .getElementsByTagNameNS('*', 'nvSpPr')[0]
        ?.getElementsByTagNameNS('*', 'nvPr')[0]
        ?.getElementsByTagNameNS('*', 'ph')[0];
      if (isPlaceholder) continue;

      const spPr = node.getElementsByTagNameNS('*', 'spPr')[0];
      const fill = spPr ? parseSolidFillColor(spPr, themeColors) : undefined;
      const lnEl = spPr?.getElementsByTagNameNS('*', 'ln')[0];
      const line = lnEl ? parseSolidFillColor(lnEl, themeColors) : undefined;

      const txBody = node.getElementsByTagNameNS('*', 'txBody')[0];
      const textRuns: string[] = [];
      let color: string | undefined;
      let fontSize: number | undefined;
      let bold = false;
      let fontFamily: string | undefined;
      if (txBody) {
        for (const r of Array.from(txBody.getElementsByTagNameNS('*', 'r'))) {
          const t = r.getElementsByTagNameNS('*', 't')[0]?.textContent || '';
          if (t) textRuns.push(t);
          const rPr = r.getElementsByTagNameNS('*', 'rPr')[0];
          if (rPr && !color) {
            const c = parseSolidFillColor(rPr, themeColors);
            if (c) color = c;
            const sz = rPr.getAttribute('sz');
            if (sz) fontSize = Math.round(Number(sz) / 100);
            if (rPr.getAttribute('b') === '1') bold = true;
            const latin = rPr.getElementsByTagNameNS('*', 'latin')[0];
            const typeface = latin?.getAttribute('typeface');
            if (typeface) fontFamily = typeface;
          }
        }
      }
      const text = textRuns.join('').trim();

      if (text) {
        decorations.push({ type: 'text', x, y, w, h, text, color, fontSize, bold, fontFamily });
      } else if (fill || line) {
        decorations.push({ type: 'rect', x, y, w, h, fill, line });
      }
    }
  }

  return decorations;
}

function parseSolidFillColor(
  el: Element | null | undefined,
  themeColors?: Record<string, string>
): string | undefined {
  if (!el) return undefined;
  const bg = el.getElementsByTagNameNS('*', 'bg')[0];
  const target = bg || el;
  const srgb = target.getElementsByTagNameNS('*', 'srgbClr')[0];
  if (srgb?.getAttribute('val')) return srgb.getAttribute('val')!.toUpperCase();
  if (themeColors) {
    const scheme = target.getElementsByTagNameNS('*', 'schemeClr')[0];
    const val = scheme?.getAttribute('val');
    if (val && themeColors[val]) return themeColors[val];
    if (val === 'bg1' && themeColors['lt1']) return themeColors['lt1'];
    if (val === 'tx1' && themeColors['dk1']) return themeColors['dk1'];
  }
  return undefined;
}

function guessRole(name: string, type: string): SlideRole {
  const n = `${name} ${type}`.toLowerCase();
  if (/title\s*slide|cover|titleslide|title$|^title/.test(n)) return 'title';
  if (/section|divider|header/.test(n)) return 'section';
  if (/thank|end|closing|final|conclusion|goodbye/.test(n)) return 'closing';
  if (/appendix|reference|source|audit/.test(n)) return 'appendix';
  return 'content';
}

function emuToIn(emu: number): number {
  if (!Number.isFinite(emu)) return 0;
  return Math.round((emu / EMU_PER_INCH) * 100) / 100;
}

function resolveRelPath(sourcePath: string, target: string): string {
  // sourcePath e.g. "ppt/slideMasters/slideMaster1.xml"; target e.g. "../slideLayouts/slideLayout1.xml"
  const srcParts = sourcePath.split('/');
  srcParts.pop();
  const tgtParts = target.split('/');
  for (const p of tgtParts) {
    if (p === '..') srcParts.pop();
    else if (p !== '.') srcParts.push(p);
  }
  return srcParts.join('/');
}

async function readBinary(zip: JSZipInstance, path: string): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  const blob = await entry.async('blob');
  return await blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(blob);
  });
}
