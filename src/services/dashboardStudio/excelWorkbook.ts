export type ExcelFormulaClassification =
  | 'candidate_measure'
  | 'conditional_calculation'
  | 'lookup_or_join'
  | 'pivot_summary'
  | 'validation_needed';

export interface ExcelFormulaCandidate {
  sheetName: string;
  cell: string;
  formula: string;
  classification: ExcelFormulaClassification;
  guidance: string;
}

export interface ExcelChartEvidence {
  sheetName: string;
  chartName: string;
  chartType: string;
  title?: string;
  sourceRanges: string[];
  seriesCount: number;
}

export interface ExcelSheetSummary {
  name: string;
  rowCount: number;
  columnHeaders: string[];
  formulaCount: number;
  chartCount: number;
}

export interface ExcelWorkbookInventory {
  fileName: string;
  sizeBytes: number;
  sheetCount: number;
  sheets: ExcelSheetSummary[];
  formulas: ExcelFormulaCandidate[];
  charts: ExcelChartEvidence[];
  warnings: string[];
  summary: string;
}

interface WorkbookSheetRef {
  name: string;
  path: string;
}

const MAX_FORMULAS = 120;
const MAX_CHARTS = 60;
const MAX_HEADERS = 40;

function xmlDoc(value: string) {
  return new DOMParser().parseFromString(value, 'application/xml');
}

function attr(node: Element, name: string) {
  return node.getAttribute(name) || node.getAttribute(`r:${name}`) || '';
}

function localElements(root: ParentNode, localName: string) {
  return Array.from(root.querySelectorAll('*')).filter((element) => element.localName === localName) as Element[];
}

function zipDir(path: string) {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index) : '';
}

function normalizeZipPath(path: string) {
  const parts: string[] = [];
  path.replace(/^\/+/, '').split('/').forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') {
      parts.pop();
      return;
    }
    parts.push(part);
  });
  return parts.join('/');
}

function resolveTarget(baseDir: string, target: string) {
  if (target.startsWith('/')) return normalizeZipPath(target);
  return normalizeZipPath(`${baseDir}/${target}`);
}

function relsPathFor(path: string) {
  const dir = zipDir(path);
  const file = path.split('/').pop() || path;
  return `${dir}/_rels/${file}.rels`;
}

async function readZipText(zip: Awaited<ReturnType<typeof loadZip>>, path: string) {
  const file = zip.file(path);
  return file ? file.async('text') : null;
}

async function loadZip(file: File) {
  const { default: JSZip } = await import('jszip');
  return JSZip.loadAsync(await file.arrayBuffer());
}

function parseRelationships(xml: string | null, baseDir: string) {
  const relationships = new Map<string, { target: string; type: string }>();
  if (!xml) return relationships;
  const doc = xmlDoc(xml);
  Array.from(doc.getElementsByTagName('Relationship')).forEach((relationship) => {
    const id = relationship.getAttribute('Id') || '';
    const target = relationship.getAttribute('Target') || '';
    const type = relationship.getAttribute('Type') || '';
    if (id && target) relationships.set(id, { target: resolveTarget(baseDir, target), type });
  });
  return relationships;
}

function parseWorkbookSheets(workbookXml: string, workbookRelsXml: string | null): WorkbookSheetRef[] {
  const workbook = xmlDoc(workbookXml);
  const relationships = parseRelationships(workbookRelsXml, 'xl');
  return Array.from(workbook.getElementsByTagName('sheet')).map((sheet, index) => {
    const relationshipId = attr(sheet, 'id');
    const relationship = relationships.get(relationshipId);
    return {
      name: sheet.getAttribute('name') || `Sheet ${index + 1}`,
      path: relationship?.target || `xl/worksheets/sheet${index + 1}.xml`,
    };
  });
}

function parseSharedStrings(sharedStringsXml: string | null) {
  if (!sharedStringsXml) return [];
  const doc = xmlDoc(sharedStringsXml);
  return Array.from(doc.getElementsByTagName('si')).map((item) => item.textContent || '');
}

function rowNumber(cellRef: string) {
  const match = cellRef.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function cellValue(cell: Element, sharedStrings: string[]) {
  const value = localElements(cell, 'v')[0]?.textContent || '';
  if (!value) return localElements(cell, 't').map((node) => node.textContent || '').join('');
  if (cell.getAttribute('t') === 's') return sharedStrings[Number(value)] || value;
  return value;
}

function classifyFormula(formula: string): Pick<ExcelFormulaCandidate, 'classification' | 'guidance'> {
  const upper = formula.toUpperCase();
  if (/\b(SUM|SUMIF|SUMIFS|COUNT|COUNTA|COUNTIF|COUNTIFS|AVERAGE|AVERAGEIF|AVERAGEIFS|MIN|MAX)\s*\(/.test(upper)) {
    return {
      classification: 'candidate_measure',
      guidance: 'Likely measure candidate. Validate source field mapping, grain, filters, and null behavior before converting to Omni YAML.',
    };
  }
  if (/\b(GETPIVOTDATA|SUBTOTAL)\s*\(/.test(upper)) {
    return {
      classification: 'pivot_summary',
      guidance: 'Pivot or subtotal logic. Treat as dashboard aggregation evidence unless the underlying row-level formula is confirmed.',
    };
  }
  if (/\b(VLOOKUP|HLOOKUP|XLOOKUP|INDEX|MATCH)\s*\(/.test(upper)) {
    return {
      classification: 'lookup_or_join',
      guidance: 'Lookup logic. Validate whether this should become a relationship, joined view, or upstream transformation before adding a measure.',
    };
  }
  if (/\b(IF|IFS|SWITCH|CHOOSE)\s*\(/.test(upper)) {
    return {
      classification: 'conditional_calculation',
      guidance: 'Conditional logic. Review carefully before translating to CASE-style SQL or a calculated dimension/measure.',
    };
  }
  return {
    classification: 'validation_needed',
    guidance: 'Formula captured as migration evidence. Human review is needed before converting to Omni SQL.',
  };
}

function parseDimensionRef(value: string | null) {
  if (!value) return 0;
  const refs = value.split(':');
  return Math.max(...refs.map(rowNumber));
}

function chartType(chartDoc: Document) {
  const known = ['barChart', 'lineChart', 'areaChart', 'pieChart', 'doughnutChart', 'scatterChart', 'radarChart', 'bubbleChart'];
  return known.find((type) => localElements(chartDoc, type).length > 0)?.replace(/Chart$/, '') || 'chart';
}

function chartTitle(chartDoc: Document) {
  const title = localElements(chartDoc, 'title')[0];
  return title?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

async function parseChartsForSheet(
  zip: Awaited<ReturnType<typeof loadZip>>,
  sheetPath: string,
  sheetName: string,
): Promise<ExcelChartEvidence[]> {
  const rels = parseRelationships(await readZipText(zip, relsPathFor(sheetPath)), zipDir(sheetPath));
  const drawingTargets = Array.from(rels.values())
    .filter((relationship) => /\/drawing$/i.test(relationship.type) || relationship.target.includes('/drawings/'))
    .map((relationship) => relationship.target);

  const charts: ExcelChartEvidence[] = [];
  for (const drawingPath of drawingTargets) {
    const drawingXml = await readZipText(zip, drawingPath);
    if (!drawingXml) continue;
    const drawingDoc = xmlDoc(drawingXml);
    const drawingRels = parseRelationships(await readZipText(zip, relsPathFor(drawingPath)), zipDir(drawingPath));
    const chartRelationshipIds = localElements(drawingDoc, 'chart')
      .map((chart) => attr(chart, 'id'))
      .filter(Boolean);

    for (const relationshipId of chartRelationshipIds) {
      const chartPath = drawingRels.get(relationshipId)?.target;
      if (!chartPath) continue;
      const chartXml = await readZipText(zip, chartPath);
      if (!chartXml) continue;
      const chartDoc = xmlDoc(chartXml);
      charts.push({
        sheetName,
        chartName: chartPath.split('/').pop()?.replace(/\.xml$/i, '') || chartPath,
        chartType: chartType(chartDoc),
        title: chartTitle(chartDoc) || undefined,
        sourceRanges: Array.from(new Set(localElements(chartDoc, 'f').map((node) => node.textContent || '').filter(Boolean))).slice(0, 20),
        seriesCount: localElements(chartDoc, 'ser').length,
      });
    }
  }
  return charts;
}

export async function parseExcelWorkbook(file: File): Promise<ExcelWorkbookInventory> {
  if (!/\.xlsx$/i.test(file.name)) {
    throw new Error('Excel conversion currently supports .xlsx workbooks. Save older .xls files as .xlsx before importing.');
  }

  const zip = await loadZip(file);
  const workbookXml = await readZipText(zip, 'xl/workbook.xml');
  if (!workbookXml) throw new Error('This .xlsx file is missing xl/workbook.xml and could not be parsed.');

  const sharedStrings = parseSharedStrings(await readZipText(zip, 'xl/sharedStrings.xml'));
  const sheets = parseWorkbookSheets(workbookXml, await readZipText(zip, 'xl/_rels/workbook.xml.rels'));
  const formulas: ExcelFormulaCandidate[] = [];
  const charts: ExcelChartEvidence[] = [];
  const sheetSummaries: ExcelSheetSummary[] = [];
  const warnings: string[] = [];

  for (const sheet of sheets) {
    const sheetXml = await readZipText(zip, sheet.path);
    if (!sheetXml) {
      warnings.push(`${sheet.name} could not be read from ${sheet.path}.`);
      continue;
    }

    const sheetDoc = xmlDoc(sheetXml);
    const cells = Array.from(sheetDoc.getElementsByTagName('c'));
    const dimensionRows = parseDimensionRef(sheetDoc.getElementsByTagName('dimension')[0]?.getAttribute('ref') || null);
    const maxRow = Math.max(dimensionRows, ...cells.map((cell) => rowNumber(cell.getAttribute('r') || '0')));
    const columnHeaders = cells
      .filter((cell) => rowNumber(cell.getAttribute('r') || '') === 1)
      .map((cell) => cellValue(cell, sharedStrings))
      .filter(Boolean)
      .slice(0, MAX_HEADERS);

    cells.forEach((cell) => {
      const formula = localElements(cell, 'f')[0]?.textContent?.trim();
      if (!formula || formulas.length >= MAX_FORMULAS) return;
      const classification = classifyFormula(formula);
      formulas.push({
        sheetName: sheet.name,
        cell: cell.getAttribute('r') || 'unknown',
        formula,
        ...classification,
      });
    });

    const sheetCharts = await parseChartsForSheet(zip, sheet.path, sheet.name);
    charts.push(...sheetCharts.slice(0, Math.max(0, MAX_CHARTS - charts.length)));
    sheetSummaries.push({
      name: sheet.name,
      rowCount: maxRow,
      columnHeaders,
      formulaCount: cells.filter((cell) => localElements(cell, 'f')[0]).length,
      chartCount: sheetCharts.length,
    });
  }

  if (formulas.length >= MAX_FORMULAS) warnings.push(`Formula inventory was capped at ${MAX_FORMULAS} formulas for prompt quality.`);
  if (charts.length >= MAX_CHARTS) warnings.push(`Chart inventory was capped at ${MAX_CHARTS} charts for prompt quality.`);
  if (charts.length === 0) warnings.push('No embedded Excel chart XML was detected. The workbook can still be analyzed for formulas and table structure.');

  return {
    fileName: file.name,
    sizeBytes: file.size,
    sheetCount: sheetSummaries.length,
    sheets: sheetSummaries,
    formulas,
    charts,
    warnings,
    summary: `${sheetSummaries.length} sheet${sheetSummaries.length === 1 ? '' : 's'} · ${formulas.length} formula${formulas.length === 1 ? '' : 's'} · ${charts.length} chart${charts.length === 1 ? '' : 's'}`,
  };
}
