import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileSpreadsheet,
  Filter,
  LayoutDashboard,
  Loader2,
  MessageSquareText,
  Send,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  XCircle,
} from 'lucide-react';
import { DashboardSearch } from '@/components/deckBuilder/DashboardSearch';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { AIWorkingAnimation, type AIWorkStepStatus } from '@/components/ui/AIWorkingAnimation';
import { Vehicle } from '@/components/ui/Vehicle';
import { useConnection } from '@/contexts/ConnectionContext';
import { useLogOperation } from '@/contexts/OperationLogContext';
import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import { ApiError, cancelAiJob, createAiJob, enrichDocuments, getAiJob, getAiJobResult, listModels, listTopics, type EnrichmentResult, type OmniAiJob, type OmniAiJobResult } from '@/services/omniApi';
import { fetchDashboardList, fetchDashboardSummary } from '@/services/deckBuilder/omniDeckApi';
import { dashboardCache, type CachedDashboard } from '@/services/deckBuilder/localCache';
import type { DashboardFilter, DashboardTile } from '@/services/deckBuilder/types';
import { parseExcelWorkbook, type ExcelWorkbookInventory } from '@/services/dashboardStudio/excelWorkbook';
import type { OmniModel, OmniTopic } from '@/types';

interface InspectedDashboard {
  id: string;
  name: string;
  folderPath?: string;
  tiles: DashboardTile[];
  filters: DashboardFilter[];
  topics: string[];
  modelId?: string;
}

type WorkflowStepState = 'active' | 'done' | 'pending';
type DashboardStudioLane = 'review' | 'builder' | 'excel';
type AiRunLane = 'review' | 'builder' | 'excel' | 'excel_dashboard';
type ExcelConversionIntent = 'dashboard_only' | 'semantic_and_dashboard' | 'semantic_only';

const TERMINAL_AI_STATES = ['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELED'];
const MAX_EXCEL_UPLOAD_BYTES = 20 * 1024 * 1024;

interface AiRunContext {
  lane: AiRunLane;
  requestKey: string;
  baseUrl: string;
  apiKey: string;
  startedAt: number;
  modelId: string;
  topicName?: string;
  dashboardId?: string;
  jobId?: string;
  createdConversationId?: string;
  createdChatUrl?: string;
}

interface TimedOutAiRun {
  lane: AiRunLane;
  jobId: string;
  chatUrl: string;
}

class AiRunCancelledError extends Error {
  constructor() {
    super('AI run cancelled.');
    this.name = 'AiRunCancelledError';
  }
}

class AiRunStaleError extends Error {
  constructor() {
    super('AI run ignored because the active Omni connection changed.');
    this.name = 'AiRunStaleError';
  }
}

class AiJobTimeoutError extends Error {
  context: AiRunContext;
  chatUrl: string;

  constructor(context: AiRunContext, chatUrl: string) {
    super('Omni is still working on this job. Keep waiting, open Omni chat, or cancel it.');
    this.name = 'AiJobTimeoutError';
    this.context = context;
    this.chatUrl = chatUrl;
  }
}

function normalizeAiState(state: string | undefined) {
  return (state || '').trim().toUpperCase().replace(/[-\s]/g, '_');
}

function readNestedString(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) return '';
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current.trim() : '';
}

function readFirstString(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === 'string' && field.trim()) return field.trim();
  }
  return '';
}

function buildOmniChatUrl(baseUrl: string, conversationId: string) {
  // Fallback only; API-provided omniChatUrl wins whenever Omni returns one.
  const cleanBase = baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  if (!cleanBase || !conversationId) return '';
  return `${cleanBase}/chat/${encodeURIComponent(conversationId)}`;
}

function shortenId(value?: string) {
  if (!value) return 'Not detected';
  return value.length > 20 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function modelIsBase(model: OmniModel) {
  return !model.deletedAt && (!model.kind || ['SHARED', 'SHARED_EXTENSION'].includes(model.kind));
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dashboardColorGuidance(colorScheme: string) {
  return colorScheme.trim()
    ? colorScheme.trim()
    : 'No brand palette provided. Choose a restrained Omni-friendly palette with neutral dashboard chrome, clear chart contrast, and consistent semantic colors.';
}

function excelIntentLabel(intent: ExcelConversionIntent) {
  if (intent === 'dashboard_only') return 'Dashboard draft only';
  if (intent === 'semantic_only') return 'Model follow-up plan only';
  return 'Dashboard draft with model follow-ups';
}

function compactPromptTitlePart(value: string | undefined, fallback: string, maxLength = 80) {
  const clean = (value || '').replace(/\s+/g, ' ').trim() || fallback;
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1).trim()}…` : clean;
}

function cleanReviewText(value: string) {
  return value.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

function parseMarkdownTableCells(value: string) {
  return value
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cleanReviewText(cell));
}

function isMarkdownTableRow(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('|')) return false;
  return parseMarkdownTableCells(trimmed).length >= 2;
}

function isMarkdownTableDivider(value: string) {
  const cells = parseMarkdownTableCells(value);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function AiReviewContent({ message }: { message: string }) {
  const lines = message.split('\n');
  const blocks: ReactNode[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    if (/^Here is the full AI Dashboard Studio review/i.test(trimmed)) continue;

    if (isMarkdownTableRow(trimmed)) {
      const tableLines: string[] = [];
      let cursor = index;
      while (cursor < lines.length && isMarkdownTableRow(lines[cursor])) {
        tableLines.push(lines[cursor].trim());
        cursor += 1;
      }

      const rows = tableLines
        .filter((line) => !isMarkdownTableDivider(line))
        .map((line) => parseMarkdownTableCells(line));

      if (rows.length > 1) {
        blocks.push(
          <div key={`table-${index}`} className="overflow-x-auto rounded-card border border-border bg-white">
            <table className="min-w-full text-left text-xs">
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={`table-${index}-${rowIndex}`} className={rowIndex === 0 ? 'bg-surface-secondary text-content-primary' : 'border-t border-border text-content-secondary'}>
                    {row.map((cell, cellIndex) => {
                      const Cell = rowIndex === 0 ? 'th' : 'td';
                      return (
                        <Cell key={`table-${index}-${rowIndex}-${cellIndex}`} className="px-3 py-2 align-top leading-5">
                          {cell}
                        </Cell>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        index = cursor - 1;
        continue;
      }
    }

    if (/^-{3,}$/.test(trimmed)) {
      blocks.push(<div key={`${index}-${trimmed}`} className="h-px bg-border my-4" />);
      continue;
    }
    if (/^#{1,4}\s+/.test(trimmed)) {
      blocks.push(
        <div key={`${index}-${trimmed}`} className="pt-2 text-sm font-semibold text-content-primary">
          {cleanReviewText(trimmed.replace(/^#{1,4}\s+/, ''))}
        </div>
      );
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      blocks.push(
        <div key={`${index}-${trimmed}`} className="flex gap-2 text-sm leading-6 text-content-secondary">
          <span className="mt-2 h-1.5 w-1.5 rounded-full bg-omni-500 flex-shrink-0" />
          <span>{cleanReviewText(trimmed.replace(/^[-*]\s+/, ''))}</span>
        </div>
      );
      continue;
    }
    blocks.push(
      <p key={`${index}-${trimmed}`} className="text-sm leading-6 text-content-secondary">
        {cleanReviewText(trimmed)}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {blocks}
    </div>
  );
}

function stepClasses(state: WorkflowStepState) {
  if (state === 'done') return 'border-green-200 bg-green-50 text-green-700';
  if (state === 'active') return 'border-omni-200 bg-omni-50 text-omni-700';
  return 'border-border bg-white text-content-tertiary';
}

function extractMessageFromActions(actions?: Array<Record<string, unknown>>) {
  if (!Array.isArray(actions)) return '';
  const candidates = actions
    .flatMap((action) => [
      readNestedString(action, ['message']),
      readNestedString(action, ['summary']),
      readNestedString(action, ['content']),
      readNestedString(action, ['result', 'message']),
      readNestedString(action, ['result', 'summary']),
      readNestedString(action, ['result', 'content']),
      readNestedString(action, ['result', 'text']),
      readNestedString(action, ['result', 'answer']),
      readNestedString(action, ['result', 'finalMessage']),
      readNestedString(action, ['result', 'final_message']),
    ])
    .map((value) => value.trim())
    .filter((value) => value.length > 40);
  return candidates[candidates.length - 1] || '';
}

function extractAiMessage(result?: OmniAiJobResult | null, job?: OmniAiJob | null) {
  return (
    readFirstString(result, ['message', 'resultSummary', 'result_summary', 'finalMessage', 'final_message', 'answer', 'response', 'content', 'text', 'summary']) ||
    extractMessageFromActions(result?.actions) ||
    readFirstString(job, ['message', 'resultSummary', 'result_summary', 'finalMessage', 'final_message', 'answer', 'response', 'content', 'text', 'summary']) ||
    extractMessageFromActions(job?.actions) ||
    ''
  );
}

function jobToResult(job: OmniAiJob | null | undefined): OmniAiJobResult | null {
  if (!job) return null;
  const message = extractAiMessage(undefined, job);
  const topic = readFirstString(job, ['topicName', 'topic_name', 'topic']);
  if (!message && !topic && !job.actions?.length) return null;
  return {
    actions: job.actions,
    message,
    resultSummary: readFirstString(job, ['resultSummary', 'result_summary']),
    topic,
    omniChatUrl: readFirstString(job, ['omniChatUrl', 'omni_chat_url']),
  };
}

function hasAiResultContent(result?: OmniAiJobResult | null, job?: OmniAiJob | null) {
  return Boolean(extractAiMessage(result, job));
}

function extractAiProgressMessage(job?: OmniAiJob | null) {
  const direct = readFirstString(job, [
    'progressMessage',
    'progress_message',
    'statusMessage',
    'status_message',
    'detail',
    'details',
    'message',
  ]);
  if (direct && direct.length < 220) return direct;
  if (!Array.isArray(job?.actions)) return '';
  const actionMessages = job.actions
    .flatMap((action) => [
      readFirstString(action, ['progressMessage', 'progress_message', 'statusMessage', 'status_message']),
      readFirstString(action, ['message', 'summary']),
      readNestedString(action, ['result', 'progressMessage']),
      readNestedString(action, ['result', 'statusMessage']),
      readNestedString(action, ['result', 'message']),
    ])
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length < 220);
  return actionMessages[actionMessages.length - 1] || '';
}

function dashboardReviewScopeNote(dashboard: InspectedDashboard) {
  const notes = [
    dashboard.tiles.length > 25 ? `reviewing first 25 of ${dashboard.tiles.length} tiles` : '',
    dashboard.filters.length > 15 ? `reviewing first 15 of ${dashboard.filters.length} filters` : '',
  ].filter(Boolean);
  return notes.length ? notes.join('; ') : '';
}

function excelInventoryScopeNotes(inventory: ExcelWorkbookInventory) {
  return [
    inventory.sheets.length > 20 ? `reviewing first 20 of ${inventory.sheets.length} sheets` : '',
    inventory.formulas.length > 40 ? `reviewing first 40 of ${inventory.formulas.length} formulas` : '',
    inventory.charts.length > 30 ? `reviewing first 30 of ${inventory.charts.length} charts` : '',
    inventory.warnings.length > 12 ? `reviewing first 12 of ${inventory.warnings.length} parser warnings` : '',
  ].filter(Boolean);
}

function buildDashboardReviewPrompt(dashboard: InspectedDashboard) {
  const tileLines = dashboard.tiles.slice(0, 25).map((tile, index) => {
    const section = tile.section ? ` | section: ${tile.section}` : '';
    const type = tile.tileType ? ` | type: ${tile.tileType}` : '';
    return `${index + 1}. ${tile.name}${section}${type}`;
  });
  const filterLines = dashboard.filters.slice(0, 15).map((filter) => {
    const label = filter.label && filter.label !== filter.field ? ` (${filter.label})` : '';
    return `- ${filter.field}${label}`;
  });
  const scopeNote = dashboardReviewScopeNote(dashboard);

  return `AI Dashboard Studio Review - ${dashboard.name}

Act as a senior BI product designer, analytics engineer, and dashboard quality reviewer.

Review this Omni dashboard for executive readiness, self-service usability, semantic consistency, and AI-readiness.

Response rules:
- Do not use markdown tables.
- Keep the review concise and admin-friendly.
- Do not recommend direct API changes.
- Do not claim you can modify the dashboard, create a branch, or deploy changes.
- Treat follow-up work as questions and human-authored recommendations for Omni builders.
- Frame next steps as dashboard-builder tasks that the user can complete in the Omni UI.
- Separate content/design issues from semantic/model issues.
- Flag anything that should be routed to Content Health, Model & Topic Health, or AI Semantic Studio.

Dashboard:
- Name: ${dashboard.name}
- Dashboard ID: ${dashboard.id}
- Folder: ${dashboard.folderPath || 'Unknown'}
- Model ID: ${dashboard.modelId || 'Unknown'}
- Topics: ${dashboard.topics.length ? dashboard.topics.join(', ') : 'None detected'}
- Tile count: ${dashboard.tiles.length}
- Filter count: ${dashboard.filters.length}
${scopeNote ? `- Scope note: ${scopeNote}` : ''}

Tiles:
${tileLines.length ? tileLines.join('\n') : '- No tiles detected'}

Filters:
${filterLines.length ? filterLines.join('\n') : '- No filters detected'}

Return exactly these sections:
1. Dashboard purpose and likely audience
2. Business questions it appears to answer
3. UX and layout risks
4. Metric, filter, and semantic risks
5. AI-readiness risks
6. Concrete recommendations
7. Owner validation questions
8. Omni UI handoff checklist`;
}

function buildDashboardDeveloperPrompt(params: {
  modelName: string;
  modelId: string;
  topicName?: string;
  audience: string;
  goal: string;
  kpis: string;
  filters: string;
  layout: string;
  colorScheme: string;
  notes: string;
}) {
  const { modelName, modelId, topicName, audience, goal, kpis, filters, layout, colorScheme, notes } = params;
  const titleTarget = topicName ? `${modelName} / ${topicName}` : modelName;
  return `${compactPromptTitlePart(titleTarget, 'Selected model')} - AI Dashboard Studio Build New Dashboard

Act as a senior Omni dashboard developer and analytics product designer.

Goal:
Start a first-pass Omni dashboard build from this prompt, then keep the conversation open so the user can finish dashboard iteration in Omni chat.

Rules:
- Use only the selected Omni model/topic context. Do not invent unavailable fields.
- If dashboard creation is available in this Omni Agent surface, create a draft/first-pass dashboard from the requirements.
- If dashboard creation is not available from this API job, return a dashboard build brief that the user can continue in Omni chat.
- Do not mark a tile as validated unless the created dashboard preview renders it without an error. If preview verification is not available, call the dashboard a draft that still needs Omni UI review.
- Treat chart type fidelity as part of validation. If a requested line, bar, KPI, or table tile renders as a different visualization type, list it as visual review required and tell the user exactly what to adjust in Omni UI.
- Treat blank or axes-only charts as fix-required even if the query succeeds. A chart is not validated unless visible marks, values, or rows render in the preview.
- For trend requests, prefer a true line or bar trend chart. Do not duplicate the same table as both the revenue trend and margin trend unless chart creation is unavailable; if that fallback happens, say so clearly.
- For ratio metrics, use an existing ratio measure only when its definition matches the requested KPI. Do not substitute a row-level average for an order-level ratio unless the field definition confirms that grain.
- Do not generate semantic YAML in this lane. Route semantic gaps to AI Semantic Studio.
- Do not ask for external BI credentials, screenshots, or unsupported imports.
- Do not use markdown tables; use short bullets for tile and filter lists.
- Apply the requested color scheme when Omni dashboard creation supports styling. Do not use color as the only way to communicate status; labels, titles, and values must remain clear without color.
- Use accessible contrast and consistent semantic colors: green for healthy/positive, red for risk/negative, amber for warning, and neutral colors for context.
- Keep the response admin-friendly and action-oriented.

Target:
- Model: ${modelName}
- Model ID: ${modelId}
- Topic: ${topicName || 'Use the best available topic in this model'}

Dashboard request:
- Audience: ${audience || 'Not specified'}
- Business goal: ${goal || 'Not specified'}
- KPI / metric ideas: ${kpis || 'Not specified'}
- Filters / controls: ${filters || 'Not specified'}
- Layout / visual style: ${layout || 'Not specified'}
- Color / brand style: ${dashboardColorGuidance(colorScheme)}
- Additional notes: ${notes || 'None'}

Return exactly these sections:
1. First-pass dashboard build status
2. Proposed dashboard title and audience
3. Tiles to create
4. Filters and interactions
5. Semantic gaps to route elsewhere
6. Questions for the user in Omni chat
7. Next step in Omni`;
}

function excelInventoryPromptBlock(inventory: ExcelWorkbookInventory) {
  const sheetLines = inventory.sheets.slice(0, 20).map((sheet) =>
    `- ${sheet.name}: ${sheet.rowCount} rows, ${sheet.formulaCount} formulas, ${sheet.chartCount} charts${sheet.columnHeaders.length ? `, headers: ${sheet.columnHeaders.slice(0, 12).join(', ')}` : ''}`
  );
  const formulaLines = inventory.formulas.slice(0, 40).map((formula) =>
    `- ${formula.sheetName}!${formula.cell}: =${formula.formula} | ${formula.classification} | ${formula.guidance}`
  );
  const chartLines = inventory.charts.slice(0, 30).map((chart) =>
    `- ${chart.sheetName}/${chart.chartName}: ${chart.chartType}${chart.title ? `, title: ${chart.title}` : ''}${chart.sourceRanges.length ? `, ranges: ${chart.sourceRanges.slice(0, 4).join('; ')}` : ''}`
  );
  const warningLines = inventory.warnings.slice(0, 12).map((warning) => `- ${warning}`);
  const scopeNotes = excelInventoryScopeNotes(inventory);

  return `Workbook:
- File: ${inventory.fileName}
- Size: ${formatSize(inventory.sizeBytes)}
- Summary: ${inventory.summary}
${scopeNotes.length ? `- Scope note: ${scopeNotes.join('; ')}` : ''}

Sheets:
${sheetLines.length ? sheetLines.join('\n') : '- None detected'}

Formula candidates:
${formulaLines.length ? formulaLines.join('\n') : '- No formulas detected'}

Chart / visual evidence:
${chartLines.length ? chartLines.join('\n') : '- No embedded chart metadata detected'}

Parser warnings:
${warningLines.length ? warningLines.join('\n') : '- None'}`;
}

function buildExcelConversionPrompt(params: {
  inventory: ExcelWorkbookInventory;
  intent: ExcelConversionIntent;
  modelName: string;
  modelId: string;
  topicName?: string;
  adminGoal: string;
  colorScheme: string;
}) {
  const { inventory, intent, modelName, modelId, topicName, adminGoal, colorScheme } = params;
  return `${compactPromptTitlePart(inventory.fileName, 'Excel workbook')} - AI Dashboard Studio Excel Conversion

Act as a senior analytics engineer and Omni dashboard developer.

Goal:
Convert an Excel workbook into a reviewed Omni dashboard migration plan. Focus on what Blobby can safely draft now from existing Omni fields, and what formula or lookup logic should become model follow-up work.

Rules:
- This is a planning/conversion analysis step, not a production write.
- This lane does not update Omni semantic files, topics, views, relationships, or model YAML.
- Do not return deployable YAML in this response.
- Do not claim a formula is safe to deploy until grain, source fields, filters, and null behavior are validated.
- Formula candidates that should become Omni measures must be listed as model follow-ups for AI Semantic Studio, reviewed YAML, and dev-branch validation.
- Dashboard requirements can be used to start a guarded Blobby dashboard chat using existing Omni fields only.
- When dashboard intent is selected, separate safe draft tiles that can use existing Omni fields from blocked tiles that require semantic work first.
- Make the sequencing explicit: Blobby can draft safe dashboard tiles now, while blocked measures, lookup dimensions, and ratio metrics remain follow-up work in AI Semantic Studio before they are added.
- If the workbook appears to contain raw source data, note that the user may need Omni upload/data input table steps before dashboard creation.
- Do not use markdown tables; use short bullets grouped under the required sections.
- Capture dashboard color and brand requirements as visual requirements. Do not use color as the only status signal; require labels or values alongside color.
- Use accessible contrast and consistent semantic colors: green for healthy/positive, red for risk/negative, amber for warning, and neutral colors for context.

Target:
- Model: ${modelName}
- Model ID: ${modelId}
- Topic: ${topicName || 'Not selected'}
- User intent: ${excelIntentLabel(intent)}
- Admin goal: ${adminGoal || 'Create a guarded dashboard draft from Excel evidence and list model follow-up requirements.'}
- Color / brand style: ${dashboardColorGuidance(colorScheme)}

${excelInventoryPromptBlock(inventory)}

Return exactly these sections:
1. Workbook readout
2. Safe dashboard candidates from existing fields
3. Formulas that should not become measures yet
4. Model follow-ups and blocked work
5. Dashboard visual requirements
6. Human validation questions
7. Recommended next step`;
}

function buildExcelDashboardPrompt(params: {
  inventory: ExcelWorkbookInventory;
  analysis: string;
  modelName: string;
  modelId: string;
  topicName?: string;
  adminGoal: string;
  colorScheme: string;
}) {
  const { inventory, analysis, modelName, modelId, topicName, adminGoal, colorScheme } = params;
  return `${compactPromptTitlePart(inventory.fileName, 'Excel workbook')} - AI Dashboard Studio Excel Dashboard Build

Act as Blobby, an Omni dashboard developer.

Goal:
Use the prior Excel conversion analysis to start a guarded first-pass dashboard draft in Omni chat, or return the exact dashboard build brief if creation is not available in this AI job surface.

Rules:
- Use only validated Omni model/topic fields. Do not invent fields from Excel formulas.
- If the prior conversion analysis says a formula needs validation, treat that tile as blocked unless an exact existing Omni field is confirmed.
- If formulas require new measures that do not exist yet, pause that tile and list it as a model follow-up for AI Semantic Studio.
- For Average Order Value or other ratio formulas, do not use a generic average field unless it is explicitly defined as the same numerator and denominator. If the matching ratio measure is not confirmed, block the tile and route it to AI Semantic Studio.
- If dashboard creation is available, create a draft/first-pass dashboard from only the validated visual requirements that map to existing Omni fields.
- If dashboard creation is not available, return a build brief and ask the user to continue in Omni chat.
- If the prior conversion analysis recommends semantic work first, still create only the safe draft tiles when possible and list every blocked tile clearly. Do not create placeholders that imply blocked metrics are live.
- Do not claim a created tile is validated unless the dashboard preview renders it without an error. If any tile errors, list it under blocked/fix-required tiles with the likely field or grain issue.
- Treat chart type fidelity as part of validation. If a requested chart renders as a table, or a scorecard renders as a chart, list it as visual review required and tell the user exactly what to adjust in Omni UI.
- Treat blank or axes-only charts as fix-required even if the query succeeds. A chart is not validated unless visible marks, values, or rows render in the preview.
- For workbook charts and trend requirements, prefer the closest matching Omni chart type. Do not silently convert an embedded Excel chart into a table unless chart creation is unavailable.
- Do not generate semantic YAML here.
- Do not use markdown tables; use short bullets for tile, filter, and blocker lists.
- Apply the requested color scheme when Omni dashboard creation supports styling. Do not use color as the only way to communicate status; labels, titles, and values must remain clear without color.
- Use accessible contrast and consistent semantic colors: green for healthy/positive, red for risk/negative, amber for warning, and neutral colors for context.

Target:
- Model: ${modelName}
- Model ID: ${modelId}
- Topic: ${topicName || 'Use the best available topic in this model'}
- Admin goal: ${adminGoal || 'Create a guarded Omni dashboard draft from safe existing fields and list model follow-ups.'}
- Color / brand style: ${dashboardColorGuidance(colorScheme)}

Excel inventory:
${excelInventoryPromptBlock(inventory)}

Prior conversion analysis:
${analysis}

Return exactly these sections:
1. Dashboard build status
2. Draft dashboard title
3. Tiles to create now
4. Tiles blocked by semantic prerequisites
5. Filters and interactions
6. Omni chat next step`;
}

export function AIDashboardStudioPage() {
  const { connection } = useConnection();
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const logOperation = useLogOperation();
  const excelFileInputRef = useRef<HTMLInputElement>(null);
  const aiRunTrackersRef = useRef<Partial<Record<AiRunLane, { cancelled: boolean; requestKey: string; jobId?: string; startedAt: number }>>>({});
  const timedOutAiRunRef = useRef<AiRunContext | null>(null);
  const [studioLane, setStudioLane] = useState<DashboardStudioLane>('builder');
  const [dashboards, setDashboards] = useState<CachedDashboard[]>([]);
  const [dashboardsSyncedAt, setDashboardsSyncedAt] = useState<number | null>(null);
  const [loadingDashboards, setLoadingDashboards] = useState(false);
  const [selectedDashboard, setSelectedDashboard] = useState<CachedDashboard | null>(null);
  const [dashboard, setDashboard] = useState<InspectedDashboard | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [aiJob, setAiJob] = useState<OmniAiJob | null>(null);
  const [aiMessage, setAiMessage] = useState('');
  const [chatUrl, setChatUrl] = useState('');
  const [aiConversationId, setAiConversationId] = useState('');
  const [reviewStatus, setReviewStatus] = useState('');
  const [reviewProgress, setReviewProgress] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [builderError, setBuilderError] = useState('');
  const [excelError, setExcelError] = useState('');
  const [activeAiJobs, setActiveAiJobs] = useState<Partial<Record<AiRunLane, string>>>({});
  const [timedOutAiRun, setTimedOutAiRun] = useState<TimedOutAiRun | null>(null);
  const [studioModels, setStudioModels] = useState<OmniModel[]>([]);
  const [loadingStudioModels, setLoadingStudioModels] = useState(false);
  const [studioModelSearch, setStudioModelSearch] = useState('');
  const [studioModelId, setStudioModelId] = useState('');
  const [studioTopics, setStudioTopics] = useState<OmniTopic[]>([]);
  const [studioTopicName, setStudioTopicName] = useState('');
  const [loadingStudioTopics, setLoadingStudioTopics] = useState(false);
  const [builderAudience, setBuilderAudience] = useState('');
  const [builderGoal, setBuilderGoal] = useState('');
  const [builderKpis, setBuilderKpis] = useState('');
  const [builderFilters, setBuilderFilters] = useState('');
  const [builderLayout, setBuilderLayout] = useState('');
  const [builderColorScheme, setBuilderColorScheme] = useState('');
  const [builderNotes, setBuilderNotes] = useState('');
  const [builderMessage, setBuilderMessage] = useState('');
  const [builderStatus, setBuilderStatus] = useState('');
  const [builderChatUrl, setBuilderChatUrl] = useState('');
  const [builderConversationId, setBuilderConversationId] = useState('');
  const [builderRunning, setBuilderRunning] = useState(false);
  const [excelIntent, setExcelIntent] = useState<ExcelConversionIntent>('semantic_and_dashboard');
  const [excelGoal, setExcelGoal] = useState('');
  const [excelColorScheme, setExcelColorScheme] = useState('');
  const [excelInventory, setExcelInventory] = useState<ExcelWorkbookInventory | null>(null);
  const [excelParsing, setExcelParsing] = useState(false);
  const [excelRunning, setExcelRunning] = useState(false);
  const [excelDashboardRunning, setExcelDashboardRunning] = useState(false);
  const [excelMessage, setExcelMessage] = useState('');
  const [excelDashboardMessage, setExcelDashboardMessage] = useState('');
  const [excelStatus, setExcelStatus] = useState('');
  const [excelChatUrl, setExcelChatUrl] = useState('');
  const [excelConversationId, setExcelConversationId] = useState('');

  useEffect(() => {
    const cached = dashboardCache.load(connection.baseUrl);
    if (cached?.data) {
      setDashboards(cached.data);
      setDashboardsSyncedAt(cached.savedAt);
    } else {
      setDashboards([]);
      setDashboardsSyncedAt(null);
    }
    setLoadingDashboards(false);
    setSelectedDashboard(null);
    setDashboard(null);
    setInspecting(false);
    setReviewError('');
    setReviewProgress('');
  }, [connection.baseUrl, connectionKey]);

  useEffect(() => {
    let cancelled = false;
    async function loadStudioModels() {
      setLoadingStudioModels(true);
      try {
        const response = await listModels(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 });
        if (!cancelled) setStudioModels(Array.isArray(response.models) ? response.models : []);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to load Omni models.';
          setBuilderError(message);
          setExcelError(message);
        }
      } finally {
        if (!cancelled) setLoadingStudioModels(false);
      }
    }
    loadStudioModels();
    return () => {
      cancelled = true;
    };
  }, [connection.baseUrl, connection.apiKey]);

  useEffect(() => {
    let cancelled = false;
    async function loadTopicsForModel() {
      if (!studioModelId) {
        setStudioTopics([]);
        setStudioTopicName('');
        return;
      }
      setLoadingStudioTopics(true);
      try {
        const topics = await listTopics(connection.baseUrl, connection.apiKey, studioModelId);
        if (!cancelled) {
          setStudioTopics(Array.isArray(topics) ? topics : []);
          setStudioTopicName((current) => current && topics.some((topic) => topic.name === current) ? current : '');
        }
      } catch {
        if (!cancelled) setStudioTopics([]);
      } finally {
        if (!cancelled) setLoadingStudioTopics(false);
      }
    }
    loadTopicsForModel();
    return () => {
      cancelled = true;
    };
  }, [connection.baseUrl, connection.apiKey, studioModelId]);

  function setLaneStatus(lane: AiRunLane, value: string) {
    if (lane === 'review') setReviewStatus(value);
    if (lane === 'builder') setBuilderStatus(value);
    if (lane === 'excel' || lane === 'excel_dashboard') setExcelStatus(value);
  }

  function setLaneProgress(lane: AiRunLane, value: string) {
    if (lane === 'review') setReviewProgress(value);
    if (lane === 'builder') setBuilderStatus(value);
    if (lane === 'excel' || lane === 'excel_dashboard') setExcelStatus(value);
  }

  function setLaneRunning(lane: AiRunLane, value: boolean) {
    if (lane === 'review') setReviewing(value);
    if (lane === 'builder') setBuilderRunning(value);
    if (lane === 'excel') setExcelRunning(value);
    if (lane === 'excel_dashboard') setExcelDashboardRunning(value);
  }

  function setLaneError(lane: AiRunLane, value: string) {
    if (lane === 'review') setReviewError(value);
    if (lane === 'builder') setBuilderError(value);
    if (lane === 'excel' || lane === 'excel_dashboard') setExcelError(value);
  }

  function laneLabel(lane: AiRunLane) {
    if (lane === 'review') return 'review';
    if (lane === 'builder') return 'dashboard builder';
    if (lane === 'excel_dashboard') return 'Excel dashboard builder';
    return 'Excel conversion';
  }

  function beginAiRun(lane: AiRunLane, modelId: string, topicName?: string, dashboardId?: string): AiRunContext {
    const context: AiRunContext = {
      lane,
      requestKey: connectionKey,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      startedAt: Date.now(),
      modelId,
      topicName,
      dashboardId,
    };
    aiRunTrackersRef.current[lane] = {
      cancelled: false,
      requestKey: context.requestKey,
      startedAt: context.startedAt,
    };
    setActiveAiJobs((current) => {
      const next = { ...current };
      delete next[lane];
      return next;
    });
    setTimedOutAiRun((current) => current?.lane === lane ? null : current);
    if (timedOutAiRunRef.current?.lane === lane) timedOutAiRunRef.current = null;
    return context;
  }

  function markAiRunJob(context: AiRunContext, jobId: string) {
    context.jobId = jobId;
    const tracker = aiRunTrackersRef.current[context.lane];
    if (tracker) tracker.jobId = jobId;
    setActiveAiJobs((current) => ({ ...current, [context.lane]: jobId }));
  }

  function isAiRunCurrent(context: AiRunContext) {
    const tracker = aiRunTrackersRef.current[context.lane];
    return Boolean(
      tracker &&
      !tracker.cancelled &&
      tracker.requestKey === context.requestKey &&
      isActiveConnectionRequest(context.requestKey)
    );
  }

  function finishAiRun(context: AiRunContext) {
    const tracker = aiRunTrackersRef.current[context.lane];
    if (tracker?.startedAt === context.startedAt) {
      delete aiRunTrackersRef.current[context.lane];
    }
    setActiveAiJobs((current) => {
      const next = { ...current };
      delete next[context.lane];
      return next;
    });
  }

  function logAiRun(context: AiRunContext, outcome: 'succeeded' | 'failed' | 'cancelled' | 'timed out', message?: string) {
    const jobPart = context.jobId ? `job ${shortenId(context.jobId)}` : 'job not returned';
    const modelPart = context.modelId ? `model ${shortenId(context.modelId)}` : 'model unknown';
    const topicPart = context.topicName ? ` topic ${context.topicName}` : '';
    const dashboardPart = context.dashboardId ? ` dashboard ${shortenId(context.dashboardId)}` : '';
    const detailPart = message ? ` - ${message.slice(0, 140)}` : '';
    logOperation('ai_query', `AI Dashboard Studio ${laneLabel(context.lane)} ${outcome}: ${jobPart}, ${modelPart}${topicPart}${dashboardPart}${detailPart}`, {
      successCount: outcome === 'succeeded' ? 1 : 0,
      failureCount: outcome === 'succeeded' ? 0 : 1,
      durationMs: Date.now() - context.startedAt,
    });
  }

  async function cancelActiveAiRun(lane: AiRunLane) {
    const tracker = aiRunTrackersRef.current[lane];
    if (!tracker) return;
    tracker.cancelled = true;
    const jobId = tracker.jobId;
    const context: AiRunContext = {
      lane,
      requestKey: tracker.requestKey,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      startedAt: tracker.startedAt,
      modelId: studioModelId || dashboard?.modelId || '',
      topicName: studioTopicName || dashboard?.topics[0],
      dashboardId: lane === 'review' ? dashboard?.id : undefined,
      jobId,
    };
    setLaneStatus(lane, 'Cancelled.');
    setLaneRunning(lane, false);
    setTimedOutAiRun((current) => current?.lane === lane ? null : current);
    if (timedOutAiRunRef.current?.lane === lane) timedOutAiRunRef.current = null;
    setActiveAiJobs((current) => {
      const next = { ...current };
      delete next[lane];
      return next;
    });
    if (jobId) {
      try {
        await cancelAiJob(connection.baseUrl, connection.apiKey, jobId);
      } catch (err) {
        setLaneError(lane, err instanceof Error ? err.message : 'Could not cancel the Omni AI job.');
      }
    }
    logAiRun(context, 'cancelled');
  }

  function applyAiOutcome(context: AiRunContext, outcome: { message: string; conversationId: string; chatUrl: string }) {
    if (context.lane === 'review') {
      setAiMessage(outcome.message);
      if (outcome.conversationId) setAiConversationId(outcome.conversationId);
      setChatUrl(outcome.chatUrl || chatUrl);
      setReviewStatus('Review complete.');
    } else if (context.lane === 'builder') {
      setBuilderMessage(outcome.message);
      setBuilderConversationId(outcome.conversationId);
      setBuilderChatUrl(outcome.chatUrl || builderChatUrl);
      setBuilderStatus('Dashboard developer handoff ready.');
    } else if (context.lane === 'excel') {
      setExcelMessage(outcome.message);
      setExcelConversationId(outcome.conversationId);
      setExcelChatUrl(outcome.chatUrl || excelChatUrl);
      setExcelStatus('Excel formula and dashboard conversion analysis ready.');
    } else {
      setExcelDashboardMessage(outcome.message);
      setExcelConversationId(outcome.conversationId);
      setExcelChatUrl(outcome.chatUrl || excelChatUrl);
      setExcelStatus('Excel dashboard handoff ready.');
    }
  }

  async function keepWaitingForTimedOutRun() {
    const context = timedOutAiRunRef.current;
    if (!context?.jobId) return;
    aiRunTrackersRef.current[context.lane] = {
      cancelled: false,
      requestKey: context.requestKey,
      jobId: context.jobId,
      startedAt: context.startedAt,
    };
    setActiveAiJobs((current) => ({ ...current, [context.lane]: context.jobId || '' }));
    setTimedOutAiRun(null);
    setLaneRunning(context.lane, true);
    setLaneError(context.lane, '');
    setLaneStatus(context.lane, 'Still waiting for Omni AI...');
    try {
      const pollResult = await waitForAiJob(context);
      const finalJob = pollResult.job;
      const finalState = normalizeAiState(finalJob?.state || finalJob?.status);
      if (pollResult.timedOut && !TERMINAL_AI_STATES.includes(finalState)) {
        setTimedOutAiRun({ lane: context.lane, jobId: context.jobId, chatUrl: context.createdChatUrl || '' });
        setLaneStatus(context.lane, 'Omni is still working on this job. Keep waiting, open Omni chat, or cancel it.');
        logAiRun(context, 'timed out');
        return;
      }
      if (['FAILED', 'CANCELLED', 'CANCELED'].includes(finalState)) throw new Error(`Omni AI job ${finalState.toLowerCase()}.`);
      const outcome = await resolveAiJobOutcome(context, finalJob);
      applyAiOutcome(context, outcome);
      logAiRun(context, 'succeeded');
      finishAiRun(context);
      timedOutAiRunRef.current = null;
    } catch (err) {
      if (err instanceof AiRunStaleError || err instanceof AiRunCancelledError) return;
      const message = err instanceof Error ? err.message : 'Failed while waiting for Omni AI.';
      setLaneError(context.lane, message);
      setLaneStatus(context.lane, `${laneLabel(context.lane)} failed: ${message}`);
      logAiRun(context, 'failed', message);
      finishAiRun(context);
      timedOutAiRunRef.current = null;
    } finally {
      if (!timedOutAiRunRef.current || timedOutAiRunRef.current.lane !== context.lane) {
        setLaneRunning(context.lane, false);
      }
    }
  }

  async function refreshDashboardList() {
    const requestKey = connectionKey;
    setLoadingDashboards(true);
    setReviewError('');
    try {
      const next = await fetchDashboardList(connection.baseUrl, connection.apiKey);
      if (!isActiveConnectionRequest(requestKey)) return;
      setDashboards(next);
      setDashboardsSyncedAt(Date.now());
      dashboardCache.save(connection.baseUrl, next);
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setReviewError(err instanceof Error ? err.message : 'Failed to load dashboards');
    } finally {
      if (isActiveConnectionRequest(requestKey)) setLoadingDashboards(false);
    }
  }

  async function inspectDashboard(picked: CachedDashboard) {
    const requestKey = connectionKey;
    const sameDashboard = selectedDashboard?.id === picked.id || dashboard?.id === picked.id;
    setSelectedDashboard(picked);
    setDashboard(null);
    setAiMessage('');
    setAiJob(null);
    if (!sameDashboard) {
      setChatUrl('');
      setAiConversationId('');
      setReviewStatus('');
      setReviewProgress('');
    } else {
      setReviewStatus(aiConversationId ? 'Continuing the existing Omni AI chat for this dashboard.' : '');
    }
    setInspecting(true);
    setReviewError('');
    try {
      const [summary, enrichmentMap] = await Promise.all([
        fetchDashboardSummary(connection.baseUrl, connection.apiKey, picked.id),
        enrichDocuments(connection.baseUrl, connection.apiKey, [picked.id]).catch(() => ({} as Record<string, EnrichmentResult>)),
      ]);
      const enrichment = enrichmentMap[picked.id];
      const modelId = enrichment?.baseModelId || summary.modelId;
      let topics = enrichment?.topicNames?.length ? enrichment.topicNames : summary.topics || [];
      if (topics.length === 0 && modelId) {
        try {
          const catalogTopics = await listTopics(connection.baseUrl, connection.apiKey, modelId);
          if (!isActiveConnectionRequest(requestKey)) return;
          topics = catalogTopics.map((topic) => topic.name).filter(Boolean).slice(0, 5);
        } catch {
          topics = [];
        }
      }
      if (!isActiveConnectionRequest(requestKey)) return;
      setDashboard({
        id: picked.id,
        name: summary.name || picked.name,
        folderPath: picked.folderPath,
        tiles: summary.tiles || [],
        filters: summary.filters || [],
        topics,
        modelId,
      });
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setReviewError(err instanceof Error ? err.message : 'Failed to inspect dashboard');
    } finally {
      if (isActiveConnectionRequest(requestKey)) setInspecting(false);
    }
  }

  async function waitForAiJob(context: AiRunContext, pollIntervalMs = 3000, maxPolls = 36) {
    if (!context.jobId) throw new Error('Omni did not return an AI job ID.');
    let latest: OmniAiJob | null = null;
    for (let i = 0; i < maxPolls; i += 1) {
      if (!isAiRunCurrent(context)) throw new AiRunStaleError();
      latest = await getAiJob(context.baseUrl, context.apiKey, context.jobId);
      if (!isAiRunCurrent(context)) throw new AiRunStaleError();
      setAiJob((prev) => ({ ...(prev || {}), ...latest }));
      const progress = extractAiProgressMessage(latest);
      if (progress) setLaneProgress(context.lane, progress);
      const state = normalizeAiState(latest.state || latest.status);
      if (TERMINAL_AI_STATES.includes(state)) return { job: latest, timedOut: false };
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    if (!isAiRunCurrent(context)) throw new AiRunStaleError();
    return { job: latest, timedOut: true };
  }

  async function getAiResult(context: AiRunContext, finalJob: OmniAiJob | null) {
    if (!context.jobId) throw new Error('Omni did not return an AI job ID.');
    const fallbackFromFinalJob = jobToResult(finalJob);
    let lastError: unknown = null;
    for (let i = 0; i < 8; i += 1) {
      try {
        if (!isAiRunCurrent(context)) throw new AiRunStaleError();
        const result = await getAiJobResult(context.baseUrl, context.apiKey, context.jobId);
        if (hasAiResultContent(result, finalJob)) return result;
      } catch (err) {
        if (err instanceof AiRunStaleError || err instanceof AiRunCancelledError) throw err;
        lastError = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    if (!isAiRunCurrent(context)) throw new AiRunStaleError();
    const latest = await getAiJob(context.baseUrl, context.apiKey, context.jobId).catch(() => null);
    const fallback = jobToResult(latest) || fallbackFromFinalJob;
    if (fallback) return fallback;

    if (lastError instanceof ApiError && lastError.status === 404) {
      throw new Error('Omni has not exposed the AI result through the API yet. Try again in a moment, or continue from the Omni chat if it is available.');
    }
    throw lastError instanceof Error ? lastError : new Error('AI result was not available yet.');
  }

  async function resolveAiJobOutcome(context: AiRunContext, finalJob: OmniAiJob | null) {
    const finalConversationId =
      readFirstString(finalJob, ['conversationId', 'conversation_id']) ||
      context.createdConversationId ||
      '';
    const finalChatUrl =
      readFirstString(finalJob, ['omniChatUrl', 'omni_chat_url']) ||
      context.createdChatUrl ||
      buildOmniChatUrl(context.baseUrl, finalConversationId);
    setLaneStatus(context.lane, 'Retrieving AI output...');
    let result: OmniAiJobResult | null = null;
    try {
      result = await getAiResult(context, finalJob);
    } catch (err) {
      if (finalChatUrl) {
        return {
          message:
            'Blobby started the Omni dashboard conversation, but Omni did not expose the full AI result stream back to OmniKit yet. Continue the dashboard build in Omni chat using the handoff link below.',
          conversationId: finalConversationId,
          chatUrl: finalChatUrl,
        };
      }
      throw err;
    }
    const conversationId =
      readFirstString(result, ['conversationId', 'conversation_id']) ||
      finalConversationId;
    const chatUrl =
      readFirstString(result, ['omniChatUrl', 'omni_chat_url']) ||
      finalChatUrl ||
      buildOmniChatUrl(context.baseUrl, conversationId);
    const aiMessage = extractAiMessage(result, finalJob);
    const message = aiMessage || (chatUrl
      ? 'Blobby completed the Omni dashboard conversation, but Omni did not expose the full narrative result back to OmniKit. Continue in Omni chat using the handoff link below, then review any draft dashboard tiles for errors before saving or sharing.'
      : 'Blobby completed, but no narrative result was returned.');
    return { message, conversationId, chatUrl };
  }

  async function runModelAiPrompt(params: {
    lane: AiRunLane;
    modelId: string;
    topicName?: string;
    dashboardId?: string;
    prompt: string;
    conversationId?: string;
    status: (value: string) => void;
  }) {
    const context = beginAiRun(params.lane, params.modelId, params.topicName, params.dashboardId);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        params.status(attempt > 0 ? 'Retrying Omni AI job...' : 'Creating Omni AI job...');
        const created = await createAiJob(context.baseUrl, context.apiKey, {
          modelId: params.modelId,
          topicName: params.topicName || undefined,
          prompt: params.prompt,
          conversationId: params.conversationId || undefined,
        });
        if (!isAiRunCurrent(context)) throw new AiRunStaleError();
        setAiJob(created);
        const jobId = created.jobId || created.id;
        if (!jobId) throw new Error('Omni did not return an AI job ID.');
        markAiRunJob(context, jobId);
        const createdConversationId = readFirstString(created, ['conversationId', 'conversation_id']) || params.conversationId || '';
        const createdChatUrl =
          readFirstString(created, ['omniChatUrl', 'omni_chat_url']) ||
          buildOmniChatUrl(context.baseUrl, createdConversationId);
        context.createdConversationId = createdConversationId;
        context.createdChatUrl = createdChatUrl;
        params.status('Waiting for Blobby to finish...');
        const pollResult = await waitForAiJob(context);
        const finalJob = pollResult.job;
        const finalState = normalizeAiState(finalJob?.state || finalJob?.status);
        if (pollResult.timedOut && !TERMINAL_AI_STATES.includes(finalState)) {
          timedOutAiRunRef.current = context;
          setTimedOutAiRun({ lane: context.lane, jobId, chatUrl: createdChatUrl });
          setLaneStatus(context.lane, 'Omni is still working on this job. Keep waiting, open Omni chat, or cancel it.');
          logAiRun(context, 'timed out');
          throw new AiJobTimeoutError(context, createdChatUrl);
        }
        if (['FAILED', 'CANCELLED', 'CANCELED'].includes(finalState)) throw new Error(`Omni AI job ${finalState.toLowerCase()}.`);
        const outcome = await resolveAiJobOutcome(context, finalJob);
        logAiRun(context, 'succeeded');
        finishAiRun(context);
        return outcome;
      } catch (err) {
        if (err instanceof AiJobTimeoutError) throw err;
        if (err instanceof AiRunStaleError || err instanceof AiRunCancelledError) {
          finishAiRun(context);
          throw err;
        }
        lastError = err;
        const retryable = err instanceof ApiError && [429, 500, 502, 503].includes(err.status);
        if (!retryable || attempt === 2) break;
        params.status('Omni is busy, waiting a moment before retrying...');
        await new Promise((resolve) => setTimeout(resolve, 8000));
      }
    }
    logAiRun(context, 'failed', lastError instanceof Error ? lastError.message : undefined);
    finishAiRun(context);
    throw lastError instanceof Error ? lastError : new Error('Omni AI job failed to start.');
  }

  async function runDashboardReview() {
    if (!dashboard?.modelId) return;
    setReviewing(true);
    setReviewError('');
    setReviewProgress('');
    setAiMessage('');
    setReviewStatus(aiConversationId ? 'Continuing existing Omni AI chat...' : 'Starting Omni AI review...');
    try {
      const outcome = await runModelAiPrompt({
        lane: 'review',
        modelId: dashboard.modelId,
        topicName: dashboard.topics[0],
        dashboardId: dashboard.id,
        conversationId: aiConversationId || undefined,
        status: setReviewStatus,
        prompt: buildDashboardReviewPrompt(dashboard),
      });
      setAiMessage(outcome.message);
      if (outcome.conversationId) setAiConversationId(outcome.conversationId);
      setChatUrl(outcome.chatUrl || chatUrl);
      setReviewStatus('Review complete.');
    } catch (err) {
      if (err instanceof AiJobTimeoutError) return;
      if (err instanceof AiRunStaleError || err instanceof AiRunCancelledError) return;
      const message = err instanceof Error ? err.message : 'Failed to run AI dashboard review';
      setReviewError(message);
      setReviewStatus(`Review failed: ${message}`);
    } finally {
      if (!timedOutAiRunRef.current || timedOutAiRunRef.current.lane !== 'review') setReviewing(false);
    }
  }

  async function runDashboardDeveloper() {
    const selectedModel = studioModels.find((model) => model.id === studioModelId);
    if (!selectedModel) {
      setBuilderError('Choose an Omni model before starting the dashboard developer lane.');
      return;
    }
    if (!builderGoal.trim()) {
      setBuilderError('Describe the dashboard goal before asking Blobby to build the first pass.');
      return;
    }
    setBuilderRunning(true);
    setBuilderMessage('');
    setBuilderError('');
    setBuilderStatus(builderConversationId ? 'Continuing dashboard developer chat...' : 'Starting dashboard developer chat...');
    try {
      const outcome = await runModelAiPrompt({
        lane: 'builder',
        modelId: selectedModel.id,
        topicName: studioTopicName || undefined,
        conversationId: builderConversationId || undefined,
        status: setBuilderStatus,
        prompt: buildDashboardDeveloperPrompt({
          modelName: selectedModel.name,
          modelId: selectedModel.id,
          topicName: studioTopicName || undefined,
          audience: builderAudience,
          goal: builderGoal,
          kpis: builderKpis,
          filters: builderFilters,
          layout: builderLayout,
          colorScheme: builderColorScheme,
          notes: builderNotes,
        }),
      });
      setBuilderMessage(outcome.message);
      setBuilderConversationId(outcome.conversationId);
      setBuilderChatUrl(outcome.chatUrl || builderChatUrl);
      setBuilderStatus('Dashboard developer handoff ready.');
    } catch (err) {
      if (err instanceof AiJobTimeoutError) return;
      if (err instanceof AiRunStaleError || err instanceof AiRunCancelledError) return;
      const message = err instanceof Error ? err.message : 'Failed to start Blobby dashboard developer.';
      setBuilderError(message);
      setBuilderStatus(`Dashboard developer failed: ${message}`);
    } finally {
      if (!timedOutAiRunRef.current || timedOutAiRunRef.current.lane !== 'builder') setBuilderRunning(false);
    }
  }

  async function handleExcelUpload(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_EXCEL_UPLOAD_BYTES) {
      const message = `Workbook is ${formatSize(file.size)}. Upload a file under ${formatSize(MAX_EXCEL_UPLOAD_BYTES)} so parsing does not freeze the browser.`;
      setExcelError(message);
      setExcelStatus(`Excel parsing blocked: ${message}`);
      if (excelFileInputRef.current) excelFileInputRef.current.value = '';
      return;
    }
    setExcelParsing(true);
    setExcelError('');
    setExcelInventory(null);
    setExcelMessage('');
    setExcelDashboardMessage('');
    setExcelConversationId('');
    setExcelChatUrl('');
    try {
      const inventory = await parseExcelWorkbook(file);
      setExcelInventory(inventory);
      setExcelStatus(`Parsed ${inventory.summary}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse Excel workbook.';
      setExcelError(message);
      setExcelStatus(`Excel parsing failed: ${message}`);
    } finally {
      setExcelParsing(false);
      if (excelFileInputRef.current) excelFileInputRef.current.value = '';
    }
  }

  async function runExcelConversion() {
    const selectedModel = studioModels.find((model) => model.id === studioModelId);
    if (!selectedModel) {
      setExcelError('Choose an Omni model before asking Blobby to convert Excel formulas.');
      return;
    }
    if (!excelInventory) {
      setExcelError('Upload an .xlsx workbook before running Excel conversion.');
      return;
    }
    setExcelRunning(true);
    setExcelError('');
    setExcelMessage('');
    setExcelDashboardMessage('');
    setExcelStatus('Starting Excel conversion analysis...');
    try {
      const outcome = await runModelAiPrompt({
        lane: 'excel',
        modelId: selectedModel.id,
        topicName: studioTopicName || undefined,
        conversationId: excelConversationId || undefined,
        status: setExcelStatus,
        prompt: buildExcelConversionPrompt({
          inventory: excelInventory,
          intent: excelIntent,
          modelName: selectedModel.name,
          modelId: selectedModel.id,
          topicName: studioTopicName || undefined,
          adminGoal: excelGoal,
          colorScheme: excelColorScheme,
        }),
      });
      setExcelMessage(outcome.message);
      setExcelConversationId(outcome.conversationId);
      setExcelChatUrl(outcome.chatUrl || excelChatUrl);
      setExcelStatus('Excel formula and dashboard conversion analysis ready.');
    } catch (err) {
      if (err instanceof AiJobTimeoutError) return;
      if (err instanceof AiRunStaleError || err instanceof AiRunCancelledError) return;
      const message = err instanceof Error ? err.message : 'Failed to convert Excel workbook with Blobby.';
      setExcelError(message);
      setExcelStatus(`Excel conversion failed: ${message}`);
    } finally {
      if (!timedOutAiRunRef.current || timedOutAiRunRef.current.lane !== 'excel') setExcelRunning(false);
    }
  }

  async function runExcelDashboardDeveloper() {
    const selectedModel = studioModels.find((model) => model.id === studioModelId);
    if (!selectedModel || !excelInventory || !excelMessage) {
      setExcelError('Run Excel conversion analysis before starting a dashboard build chat.');
      return;
    }
    setExcelDashboardRunning(true);
    setExcelError('');
    setExcelStatus('Starting Excel dashboard build chat...');
    try {
      const outcome = await runModelAiPrompt({
        lane: 'excel_dashboard',
        modelId: selectedModel.id,
        topicName: studioTopicName || undefined,
        conversationId: excelConversationId || undefined,
        status: setExcelStatus,
        prompt: buildExcelDashboardPrompt({
          inventory: excelInventory,
          analysis: excelMessage,
          modelName: selectedModel.name,
          modelId: selectedModel.id,
          topicName: studioTopicName || undefined,
          adminGoal: excelGoal,
          colorScheme: excelColorScheme,
        }),
      });
      setExcelDashboardMessage(outcome.message);
      setExcelConversationId(outcome.conversationId);
      setExcelChatUrl(outcome.chatUrl || excelChatUrl);
      setExcelStatus('Excel dashboard handoff ready.');
    } catch (err) {
      if (err instanceof AiJobTimeoutError) return;
      if (err instanceof AiRunStaleError || err instanceof AiRunCancelledError) return;
      const message = err instanceof Error ? err.message : 'Failed to start Excel dashboard build chat.';
      setExcelError(message);
      setExcelStatus(`Excel dashboard build failed: ${message}`);
    } finally {
      if (!timedOutAiRunRef.current || timedOutAiRunRef.current.lane !== 'excel_dashboard') setExcelDashboardRunning(false);
    }
  }

  const aiStatus = normalizeAiState(aiJob?.state || aiJob?.status);
  const canRunAi = Boolean(dashboard?.modelId && !reviewing && !inspecting);
  const activeLaneError = studioLane === 'review' ? reviewError : studioLane === 'builder' ? builderError : excelError;
  const activeLaneTimeout = timedOutAiRun && (
    (studioLane === 'review' && timedOutAiRun.lane === 'review') ||
    (studioLane === 'builder' && timedOutAiRun.lane === 'builder') ||
    (studioLane === 'excel' && (timedOutAiRun.lane === 'excel' || timedOutAiRun.lane === 'excel_dashboard'))
  ) ? timedOutAiRun : null;
  const reviewScopeNote = dashboard ? dashboardReviewScopeNote(dashboard) : '';
  const selectedStudioModel = studioModels.find((model) => model.id === studioModelId) || null;
  const filteredStudioModels = studioModels.filter((model) => {
    const needle = studioModelSearch.toLowerCase().trim();
    const matches = !needle ||
      model.name.toLowerCase().includes(needle) ||
      model.id.toLowerCase().includes(needle) ||
      (model.connectionName || '').toLowerCase().includes(needle);
    return modelIsBase(model) && matches;
  });
  const semanticScope = useMemo(() => {
    if (!dashboard) {
      return {
        sourceLabel: 'Awaiting dashboard inspection',
        sourceId: 'Not detected',
        sourceType: 'Dashboard semantic source',
        supportText: 'Model and topic metadata will appear after inspection.',
      };
    }
    const hasTopics = dashboard.topics.length > 0;
    return {
      sourceLabel: hasTopics ? dashboard.topics.join(', ') : 'Model-level dashboard',
      sourceId: hasTopics
        ? `Topic: ${dashboard.topics.join(', ')}${dashboard.modelId ? ` | Model ID: ${dashboard.modelId}` : ''}`
        : `Model ID: ${dashboard.modelId || 'Not detected'}`,
      supportText: hasTopics
        ? 'Use the topic for extra AI context; keep model ID visible because the API review is model-scoped.'
        : 'No topic was detected, so the review runs from model context only.',
    };
  }, [dashboard]);
  const workflowSteps = useMemo(
    () => [
      {
        label: 'Select',
        detail: selectedDashboard ? selectedDashboard.name : 'Choose a dashboard',
        state: selectedDashboard ? 'done' : 'active',
      },
      {
        label: 'Inspect',
        detail: inspecting ? 'Reading dashboard metadata' : dashboard ? `${dashboard.tiles.length} tiles, ${dashboard.filters.length} filters` : 'Find model, topics, filters',
        state: dashboard ? 'done' : selectedDashboard ? 'active' : 'pending',
      },
      {
        label: 'Review',
        detail: reviewing ? reviewStatus || 'Omni AI is reviewing' : aiMessage ? 'AI review complete' : !dashboard ? 'Ready after inspection' : canRunAi ? 'Ready for AI review' : 'Needs model mapping',
        state: aiMessage ? 'done' : dashboard ? 'active' : 'pending',
      },
      {
        label: 'Output',
        detail: aiMessage ? 'Review and chat handoff ready' : 'Review artifact appears here',
        state: aiMessage ? 'active' : 'pending',
      },
    ] as Array<{ label: string; detail: string; state: WorkflowStepState }>,
    [aiMessage, canRunAi, dashboard, inspecting, reviewStatus, reviewing, selectedDashboard]
  );
  const dashboardReviewSteps = useMemo(() => {
    const status = reviewStatus.toLowerCase();
    const creating = status.includes('starting') || status.includes('creating');
    const waiting = status.includes('waiting') || status.includes('finish');
    const retrieving = status.includes('retrieving') || status.includes('output');
    const complete = status.includes('complete');
    const failed = status.includes('failed');

    const stepStatus = (index: number): AIWorkStepStatus => {
      if (failed) return index === 0 ? 'failed' : 'pending';
      if (complete) return 'complete';
      if (index === 0) return creating ? 'active' : waiting || retrieving ? 'complete' : 'active';
      if (index === 1) return waiting ? 'active' : retrieving ? 'complete' : 'pending';
      return retrieving ? 'active' : 'pending';
    };

    return [
      { label: 'Start AI job', status: stepStatus(0) },
      { label: 'Review dashboard', status: stepStatus(1) },
      { label: 'Collect output', status: stepStatus(2) },
    ];
  }, [reviewStatus]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI Dashboard Studio"
        description="Inspect a dashboard, summarize its semantic dependencies, and run a focused AI review before migration, delivery, or executive sharing."
        icon={<Blobby mood="dashboard" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
      />

      {activeLaneError && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{activeLaneError}</div>
      )}

      {activeLaneTimeout && (
        <div className="rounded-card border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-semibold">Omni is still working on this AI job.</div>
          <div className="mt-1 text-amber-800">
            Job <span className="font-mono">{shortenId(activeLaneTimeout.jobId)}</span> is still running. Keep waiting here, continue in Omni chat, or cancel the job.
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void keepWaitingForTimedOutRun()} className="btn-secondary text-xs">
              <Loader2 size={13} />
              Keep waiting
            </button>
            {activeLaneTimeout.chatUrl && (
              <a href={activeLaneTimeout.chatUrl} className="btn-secondary text-xs">
                <ExternalLink size={13} />
                Open Omni chat
              </a>
            )}
            <button type="button" onClick={() => void cancelActiveAiRun(activeLaneTimeout.lane)} className="btn-secondary text-xs text-red-700">
              <XCircle size={13} />
              Cancel job
            </button>
          </div>
        </div>
      )}

      <StudioLaneSelector activeLane={studioLane} onChange={setStudioLane} />

      {studioLane === 'review' && (
        <>
      <div className="rounded-card border border-border bg-white overflow-hidden">
        <div className="grid md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-border">
          {workflowSteps.map((step, index) => (
            <div key={step.label} className="p-4 flex items-start gap-3 min-h-[86px]">
              <div className={`h-8 w-8 rounded-full border flex items-center justify-center text-xs font-semibold flex-shrink-0 ${stepClasses(step.state)}`}>
                {step.state === 'done' ? <CheckCircle2 size={15} /> : index + 1}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-content-primary">{step.label}</div>
                <div className="mt-1 text-xs text-content-secondary leading-5 line-clamp-2">{step.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <div className="card p-4 min-h-[124px]">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Dashboard Catalog</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{dashboards.length}</div>
          <div className="mt-1 text-xs text-content-secondary">Cached search inventory</div>
        </div>
        <div className="card p-4 min-h-[124px]">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Tiles</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{dashboard?.tiles.length ?? '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">Queries or dashboard blocks</div>
        </div>
        <div className="card p-4 min-h-[124px]">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Filters</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{dashboard?.filters.length ?? '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">Controls detected</div>
        </div>
        <div className="card p-4 min-h-[124px]">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Semantic Source</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{dashboard ? (dashboard.topics.length ? 'Topic' : 'Model') : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary truncate">{dashboard ? semanticScope.sourceLabel : 'Awaiting selection'}</div>
        </div>
        <div className="card p-4 min-h-[124px]">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Studio Output</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{aiMessage ? 'Review' : dashboard?.modelId ? 'Ready' : '-'}</div>
          <div className="mt-1 text-xs text-content-secondary">{dashboard?.modelId ? 'AI review and chat handoff' : dashboard ? 'Needs model mapping' : 'Awaiting selection'}</div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(380px,0.9fr)_minmax(0,1.1fr)] xl:items-start">
          <div className="card p-4 space-y-4 h-full xl:self-stretch xl:col-start-1 xl:row-start-1">
            <div>
              <div className="text-sm font-semibold text-content-primary">1. Select dashboard</div>
              <div className="mt-1 text-xs text-content-secondary">Choose the dashboard you want AI to evaluate. Refresh only when the catalog is stale.</div>
            </div>
            <DashboardSearch
              dashboards={dashboards}
              loading={loadingDashboards}
              lastSyncedAt={dashboardsSyncedAt}
              onRefresh={refreshDashboardList}
              onPick={inspectDashboard}
              selectedDashboardId={selectedDashboard?.id}
              disabled={inspecting || reviewing}
            />
          </div>

          <div className="card p-4 space-y-4 h-full xl:self-stretch xl:col-start-2 xl:row-start-1">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-content-primary">2. Confirm review scope</div>
                <div className="mt-1 text-xs text-content-secondary">AI reviews dashboard metadata, tile names, filters, model routing, and detected topics.</div>
              </div>
              {inspecting && <Loader2 size={16} className="text-omni-600 animate-spin flex-shrink-0" />}
            </div>

            {!selectedDashboard ? (
              <div className="rounded-card border border-dashed border-border p-4 text-sm text-content-secondary">
                Select a dashboard to inspect its tiles, filters, model, and topics.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-card border border-border bg-surface-secondary p-3">
                  <div className="text-sm font-semibold text-content-primary truncate">{dashboard?.name || selectedDashboard.name}</div>
                  <div className="mt-1 text-[11px] font-mono text-content-tertiary">{shortenId(selectedDashboard.id)}</div>
                  {selectedDashboard.folderPath && <div className="mt-1 text-xs text-content-secondary truncate">{selectedDashboard.folderPath}</div>}
                </div>

                {dashboard && (
                  <div className="space-y-2 text-xs">
                    <div className="rounded-card border border-border bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">Topic / Model ID</div>
                      <div className="mt-1 font-mono text-[11px] leading-5 text-content-primary break-all">{semanticScope.sourceId}</div>
                    </div>
                    <div className="rounded-card border border-border bg-white px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">Topic / Model</div>
                      <div className="mt-1 text-content-primary">{semanticScope.sourceLabel}</div>
                      <div className="mt-0.5 text-[11px] leading-4 text-content-secondary">{semanticScope.supportText}</div>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-content-secondary">Tiles / filters</span>
                      <span className="text-content-primary">{dashboard.tiles.length} / {dashboard.filters.length}</span>
                    </div>
                    {reviewScopeNote && (
                      <div className="rounded-card border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                        Scope note: {reviewScopeNote}.
                      </div>
                    )}
                  </div>
                )}

                {dashboard && !dashboard.modelId && (
                  <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs px-3 py-2 rounded-card flex items-start gap-2">
                    <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                    <div>No model ID was detected from the dashboard tiles. Run Content Health or inspect the dashboard query configuration before starting an AI review.</div>
                  </div>
                )}
                {dashboard && dashboard.modelId && dashboard.topics.length === 0 && (
                  <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs px-3 py-2 rounded-card flex items-start gap-2">
                    <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                    <div>No topic could be detected or fetched for this model. The AI review can still run from model context, but topic-specific dashboard recommendations may be less precise.</div>
                  </div>
                )}
                {dashboard && aiConversationId && (
                  <div className="bg-omni-50 border border-omni-200 text-omni-800 text-xs px-3 py-2 rounded-card">
                    Continuing the same Omni chat for this dashboard: <span className="font-mono">{shortenId(aiConversationId)}</span>
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-2">
              <button
                onClick={runDashboardReview}
                disabled={!canRunAi}
                className={`${canRunAi ? 'btn-primary' : 'bg-surface-secondary border border-border text-content-tertiary cursor-not-allowed'} w-full text-sm inline-flex items-center justify-center gap-2 rounded-button px-5 py-2.5 font-semibold transition-all`}
              >
                {reviewing ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                Run Focused AI Review
              </button>
              {reviewing && activeAiJobs.review && (
                <button
                  type="button"
                  onClick={() => void cancelActiveAiRun('review')}
                  className="btn-secondary w-full justify-center text-sm text-red-700"
                >
                  <XCircle size={14} />
                  Cancel AI review
                </button>
              )}
            </div>
          </div>

	          <div className="card p-0 overflow-hidden h-full min-h-[420px] xl:self-stretch xl:col-start-1 xl:row-start-2 flex flex-col">
            <div className="px-4 py-3 border-b border-border bg-white">
              <div className="text-sm font-semibold text-content-primary">3. Dashboard shape</div>
              <div className="text-xs text-content-secondary mt-0.5">A compact map of the evidence AI will use before producing recommendations.</div>
            </div>
            {!dashboard ? (
              <div className="p-6 text-sm text-content-secondary">No dashboard inspected yet.</div>
            ) : (
	              <div className="grid md:grid-cols-2 flex-1 min-h-0">
	                <div className="p-4 border-b md:border-b-0 md:border-r border-border flex min-h-0 flex-col">
	                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-content-secondary mb-3">
	                    <LayoutDashboard size={13} /> Tiles
	                  </div>
	                  <div className="space-y-2 min-h-[240px] flex-1 overflow-y-auto pr-1">
                    {dashboard.tiles.length === 0 ? (
                      <div className="text-sm text-content-secondary">No tiles detected.</div>
                    ) : (
                      dashboard.tiles.slice(0, 30).map((tile) => (
                        <div key={tile.id} className="rounded-button border border-border bg-surface-secondary px-3 py-2">
                          <div className="text-xs font-medium text-content-primary truncate">{tile.name}</div>
                          <div className="mt-0.5 text-[10px] text-content-tertiary truncate">{tile.section || tile.tileType || tile.queryId || tile.id}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
	                <div className="p-4 flex min-h-0 flex-col">
	                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-content-secondary mb-3">
	                    <Filter size={13} /> Filters
	                  </div>
	                  <div className="space-y-2 min-h-[240px] flex-1 overflow-y-auto pr-1">
                    {dashboard.filters.length === 0 ? (
                      <div className="text-sm text-content-secondary">No dashboard filters detected.</div>
                    ) : (
                      dashboard.filters.slice(0, 30).map((filter) => (
                        <div key={`${filter.field}-${filter.label || ''}`} className="rounded-button border border-border bg-surface-secondary px-3 py-2">
                          <div className="text-xs font-medium text-content-primary truncate">{filter.label || filter.field}</div>
                          <div className="mt-0.5 text-[10px] text-content-tertiary truncate">{filter.field}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="card p-0 overflow-hidden xl:col-start-2 xl:row-start-2">
            <div className="px-4 py-3 border-b border-border bg-white flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-content-primary">4. AI review output</div>
                <div className="text-xs text-content-secondary mt-0.5">{reviewStatus || 'One AI call, then polling starts only after the previous request succeeds.'}</div>
              </div>
              {aiStatus && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-chip bg-omni-50 text-omni-700">{aiStatus}</span>
              )}
            </div>
            <div className="p-4">
              {reviewing ? (
                <AIWorkingAnimation
                  variant="dashboard"
                  title="Reviewing dashboard with Omni AI"
                  detail={reviewProgress || 'Blobby is checking tiles, filters, topic routing, semantic dependencies, and the final admin recommendations.'}
                  statusLabel={reviewStatus || 'Working'}
                  steps={dashboardReviewSteps}
                />
              ) : aiMessage ? (
                <div className="space-y-4">
                  <div className="rounded-card border border-border bg-white p-5 max-h-[560px] overflow-y-auto">
                    <AiReviewContent message={aiMessage} />
                  </div>
                  <div className="rounded-card border border-omni-100 bg-omni-50 p-4">
                    <div className="text-sm font-semibold text-content-primary">Builder handoff</div>
                    <div className="mt-1 text-sm leading-6 text-content-secondary">
                      Use this review as an Omni UI checklist. Continue the same chat for follow-up questions while this dashboard stays selected; implement visual or dashboard changes in Omni.
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {chatUrl && (
                      <a href={chatUrl} className="btn-secondary text-sm inline-flex items-center gap-2">
                        Open Omni chat
                        <ArrowRight size={14} />
                      </a>
                    )}
                    <div className="text-xs text-content-secondary">
                      Route content issues to Content Health and semantic issues to AI Semantic Studio.
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-card border border-dashed border-border p-6 text-sm text-content-secondary">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center gap-2 font-medium text-content-primary">
                        <MessageSquareText size={15} />
                        No AI review yet
                      </div>
                      Select and inspect a dashboard, then run the review to generate dashboard purpose, UX risks,
                      semantic risks, and recommendations. The AI review is a handoff checklist; dashboard edits
                      remain a human authoring workflow in Omni.
                    </div>
                    <div className="flex justify-center sm:w-36 sm:flex-shrink-0" aria-hidden>
                      <Vehicle kind="fighter-jet" width={126} height={82} />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {dashboard && aiMessage && (
            <div className="card p-4 xl:col-span-2 xl:row-start-3">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-3xl">
                  <div className="text-sm font-semibold text-content-primary">Chat handoff</div>
                  <div className="mt-1 text-sm leading-6 text-content-secondary">
                    The AI API can review the dashboard and continue the same conversation while this dashboard stays selected.
                    Changing dashboards or refreshing the session starts a fresh chat. The API does not document a dashboard-edit endpoint,
                    so dashboard development remains a human authoring workflow in Omni.
                  </div>
                </div>
                {chatUrl && (
                  <a href={chatUrl} className="btn-secondary text-sm inline-flex items-center justify-center gap-2 flex-shrink-0">
                    Ask follow-up in Omni
                    <ArrowRight size={14} />
                  </a>
                )}
              </div>
              <div className="mt-4 text-xs font-semibold uppercase tracking-wider text-content-secondary">Useful follow-up questions</div>
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                {[
                  'Which recommendations are dashboard-only versus semantic-model work?',
                  'What should the owner validate before sharing this dashboard?',
                  'Which two improvements would have the highest business impact?',
                ].map((question) => (
                  <div key={question} className="rounded-card border border-border bg-surface-secondary px-3 py-2 text-sm leading-5 text-content-secondary">
                    {question}
                  </div>
                ))}
              </div>
            </div>
          )}
      </div>
        </>
      )}

      {studioLane === 'builder' && (
        <DashboardDeveloperLane
          models={filteredStudioModels}
          loadingModels={loadingStudioModels}
          modelSearch={studioModelSearch}
          selectedModel={selectedStudioModel}
          selectedModelId={studioModelId}
          topics={studioTopics}
          selectedTopicName={studioTopicName}
          loadingTopics={loadingStudioTopics}
          audience={builderAudience}
          goal={builderGoal}
          kpis={builderKpis}
          filters={builderFilters}
          layout={builderLayout}
          colorScheme={builderColorScheme}
          notes={builderNotes}
          running={builderRunning}
          status={builderStatus}
          message={builderMessage}
          chatUrl={builderChatUrl}
          onModelSearch={setStudioModelSearch}
          onModelSelect={(modelId) => {
            setStudioModelId(modelId);
            setBuilderMessage('');
            setBuilderChatUrl('');
            setBuilderConversationId('');
          }}
          onTopicSelect={setStudioTopicName}
          onAudience={setBuilderAudience}
          onGoal={setBuilderGoal}
          onKpis={setBuilderKpis}
          onFilters={setBuilderFilters}
          onLayout={setBuilderLayout}
          onColorScheme={setBuilderColorScheme}
          onNotes={setBuilderNotes}
          onRun={runDashboardDeveloper}
          onCancel={() => void cancelActiveAiRun('builder')}
        />
      )}

      {studioLane === 'excel' && (
        <ExcelDashboardLane
          fileInputRef={excelFileInputRef}
          models={filteredStudioModels}
          loadingModels={loadingStudioModels}
          modelSearch={studioModelSearch}
          selectedModel={selectedStudioModel}
          selectedModelId={studioModelId}
          topics={studioTopics}
          selectedTopicName={studioTopicName}
          loadingTopics={loadingStudioTopics}
          intent={excelIntent}
          goal={excelGoal}
          colorScheme={excelColorScheme}
          inventory={excelInventory}
          parsing={excelParsing}
          running={excelRunning}
          dashboardRunning={excelDashboardRunning}
          status={excelStatus}
          message={excelMessage}
          dashboardMessage={excelDashboardMessage}
          chatUrl={excelChatUrl}
          onModelSearch={setStudioModelSearch}
          onModelSelect={(modelId) => {
            setStudioModelId(modelId);
            setExcelMessage('');
            setExcelDashboardMessage('');
            setExcelConversationId('');
            setExcelChatUrl('');
          }}
          onTopicSelect={setStudioTopicName}
          onIntent={setExcelIntent}
          onGoal={setExcelGoal}
          onColorScheme={setExcelColorScheme}
          onUpload={handleExcelUpload}
          onClear={() => {
            setExcelInventory(null);
            setExcelMessage('');
            setExcelDashboardMessage('');
            setExcelStatus('');
          }}
          onAnalyze={runExcelConversion}
          onBuildDashboard={runExcelDashboardDeveloper}
          onCancelAnalyze={() => void cancelActiveAiRun('excel')}
          onCancelBuildDashboard={() => void cancelActiveAiRun('excel_dashboard')}
        />
      )}
    </div>
  );
}

function StudioLaneSelector({ activeLane, onChange }: { activeLane: DashboardStudioLane; onChange: (lane: DashboardStudioLane) => void }) {
  const lanes: Array<{ id: DashboardStudioLane; label: string; description: string; icon: ReactNode }> = [
    { id: 'builder', label: 'Build New Dashboard', description: 'Start a first-pass dashboard developer chat, then finish in Omni.', icon: <Wand2 size={16} /> },
    { id: 'excel', label: 'Excel to Dashboard', description: 'Draft safe tiles from workbook evidence and list model follow-ups.', icon: <FileSpreadsheet size={16} /> },
    { id: 'review', label: 'Review Existing Dashboard', description: 'Inspect a live Omni dashboard and generate a focused review.', icon: <LayoutDashboard size={16} /> },
  ];

  return (
    <div className="grid gap-3 lg:grid-cols-3" aria-label="AI Dashboard Studio lanes">
      {lanes.map((lane) => {
        const selected = activeLane === lane.id;
        return (
          <button
            key={lane.id}
            type="button"
            onClick={() => onChange(lane.id)}
            aria-pressed={selected}
            className={`rounded-card border p-4 text-left transition-all ${
              selected
                ? 'border-omni-500 bg-omni-50 shadow-soft ring-2 ring-omni-100'
                : 'border-border bg-white hover:border-omni-200 hover:bg-surface-secondary'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className={`rounded-button p-2 ${selected ? 'bg-omni-600 text-white' : 'bg-surface-secondary text-content-secondary'}`}>
                {lane.icon}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                  {lane.label}
                  {selected && <span className="rounded-chip bg-omni-600 px-2 py-0.5 text-[10px] font-semibold text-white">Selected</span>}
                </div>
                <div className="mt-1 text-xs leading-5 text-content-secondary">{lane.description}</div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function TargetModelSelector({
  models,
  loadingModels,
  modelSearch,
  selectedModel,
  selectedModelId,
  topics,
  selectedTopicName,
  loadingTopics,
  onModelSearch,
  onModelSelect,
  onTopicSelect,
}: {
  models: OmniModel[];
  loadingModels: boolean;
  modelSearch: string;
  selectedModel: OmniModel | null;
  selectedModelId: string;
  topics: OmniTopic[];
  selectedTopicName: string;
  loadingTopics: boolean;
  onModelSearch: (value: string) => void;
  onModelSelect: (value: string) => void;
  onTopicSelect: (value: string) => void;
}) {
  return (
    <div className="card p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-content-primary">Target Omni context</div>
        <div className="mt-0.5 text-xs text-content-secondary">Choose the model and optional topic Blobby should use.</div>
      </div>
      {selectedModel && (
        <div className="rounded-card border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 size={14} />
            {selectedModel.name}
          </div>
          <div className="mt-0.5 break-all font-mono text-[11px] text-green-700">{selectedModel.id}</div>
        </div>
      )}
      <input
        value={modelSearch}
        onChange={(event) => onModelSearch(event.target.value)}
        className="input-field text-sm"
        placeholder="Search models..."
      />
      <div className="max-h-[260px] overflow-y-auto rounded-card border border-border bg-white">
        {loadingModels ? (
          <div className="px-3 py-3 text-sm text-content-secondary">Loading models...</div>
        ) : models.length === 0 ? (
          <div className="px-3 py-3 text-sm text-content-secondary">No base models match that search.</div>
        ) : models.slice(0, 60).map((model) => {
          const selected = selectedModelId === model.id;
          return (
            <button
              key={model.id}
              type="button"
              onClick={() => onModelSelect(model.id)}
              aria-pressed={selected}
              className={`w-full border-b border-border/60 px-3 py-2.5 text-left transition-all last:border-b-0 ${
                selected ? 'border-l-4 border-l-omni-500 bg-omni-50 text-omni-800' : 'border-l-4 border-l-transparent hover:bg-surface-secondary text-content-primary'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{model.name}</div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-content-tertiary">{model.id}</div>
                </div>
                {selected && <span className="rounded-chip bg-omni-600 px-2 py-1 text-[10px] font-semibold text-white">Selected</span>}
              </div>
            </button>
          );
        })}
      </div>
      <div>
        <label className="text-xs font-semibold text-content-primary">Optional topic</label>
        <select
          value={selectedTopicName}
          onChange={(event) => onTopicSelect(event.target.value)}
          disabled={!selectedModel || loadingTopics}
          className="input-field mt-1 text-sm disabled:opacity-60"
        >
          <option value="">{loadingTopics ? 'Loading topics...' : 'Let Blobby choose best topic'}</option>
          {topics.map((topic) => (
            <option key={topic.name} value={topic.name}>{topic.label || topic.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function AiOutputPanel({ title, subtitle, message, chatUrl }: { title: string; subtitle: string; message: string; chatUrl?: string }) {
  if (!message) return null;
  return (
    <div className="rounded-card border border-border bg-white overflow-hidden">
      <div className="border-b border-border bg-surface-secondary px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-content-primary">{title}</div>
          <div className="mt-0.5 text-xs text-content-secondary">{subtitle}</div>
        </div>
        {chatUrl && (
          <a href={chatUrl} className="btn-secondary text-sm justify-center">
            <ExternalLink size={14} />
            Open Omni chat
          </a>
        )}
      </div>
      <div className="max-h-[620px] overflow-y-auto p-5">
        <AiReviewContent message={message} />
      </div>
    </div>
  );
}

function DashboardDeveloperLane({
  models,
  loadingModels,
  modelSearch,
  selectedModel,
  selectedModelId,
  topics,
  selectedTopicName,
  loadingTopics,
  audience,
  goal,
  kpis,
  filters,
  layout,
  colorScheme,
  notes,
  running,
  status,
  message,
  chatUrl,
  onModelSearch,
  onModelSelect,
  onTopicSelect,
  onAudience,
  onGoal,
  onKpis,
  onFilters,
  onLayout,
  onColorScheme,
  onNotes,
  onRun,
  onCancel,
}: {
  models: OmniModel[];
  loadingModels: boolean;
  modelSearch: string;
  selectedModel: OmniModel | null;
  selectedModelId: string;
  topics: OmniTopic[];
  selectedTopicName: string;
  loadingTopics: boolean;
  audience: string;
  goal: string;
  kpis: string;
  filters: string;
  layout: string;
  colorScheme: string;
  notes: string;
  running: boolean;
  status: string;
  message: string;
  chatUrl: string;
  onModelSearch: (value: string) => void;
  onModelSelect: (value: string) => void;
  onTopicSelect: (value: string) => void;
  onAudience: (value: string) => void;
  onGoal: (value: string) => void;
  onKpis: (value: string) => void;
  onFilters: (value: string) => void;
  onLayout: (value: string) => void;
  onColorScheme: (value: string) => void;
  onNotes: (value: string) => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
      <div className="space-y-4">
        <TargetModelSelector
          models={models}
          loadingModels={loadingModels}
          modelSearch={modelSearch}
          selectedModel={selectedModel}
          selectedModelId={selectedModelId}
          topics={topics}
          selectedTopicName={selectedTopicName}
          loadingTopics={loadingTopics}
          onModelSearch={onModelSearch}
          onModelSelect={onModelSelect}
          onTopicSelect={onTopicSelect}
        />
        <div className="rounded-card border border-omni-100 bg-omni-50 p-4 text-sm leading-6 text-omni-800">
          <div className="font-semibold text-omni-900">How this lane works</div>
          Blobby starts a draft dashboard developer conversation using the selected model/topic. Final review stays in Omni chat so users can fix errored tiles, refine, save, and share through the normal Omni UI.
        </div>
      </div>

      <div className="space-y-4">
        <div className="card p-4 space-y-4">
          <div>
            <div className="text-sm font-semibold text-content-primary">Dashboard request</div>
            <div className="mt-0.5 text-xs text-content-secondary">Give Blobby enough product direction to create a useful first pass.</div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <LabeledTextarea label="Audience" value={audience} onChange={onAudience} placeholder="e.g. Revenue leadership, Sales Ops, regional managers" />
            <LabeledTextarea label="Business goal" value={goal} onChange={onGoal} placeholder="e.g. Track order volume, revenue, and fulfillment health by region" />
            <LabeledTextarea label="KPIs / metrics" value={kpis} onChange={onKpis} placeholder="Revenue, order count, average order value, delivery time..." />
            <LabeledTextarea label="Filters / controls" value={filters} onChange={onFilters} placeholder="Date range, status, region, category..." />
            <LabeledTextarea label="Layout" value={layout} onChange={onLayout} placeholder="Executive summary, KPI row, trends, breakdowns, detail table..." />
            <LabeledTextarea label="Color / brand style" value={colorScheme} onChange={onColorScheme} placeholder="e.g. Neutral canvas, blue revenue charts, green positive variance, red risk states, accessible contrast" />
            <LabeledTextarea label="Additional notes" value={notes} onChange={onNotes} placeholder="Known constraints, fields to avoid, owner questions..." />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={onRun}
              disabled={!selectedModel || !goal.trim() || running}
              className="btn-primary flex-1 text-sm justify-center disabled:cursor-not-allowed disabled:opacity-60"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Start New Dashboard Build
            </button>
            {running && (
              <button type="button" onClick={onCancel} className="btn-secondary justify-center text-sm text-red-700">
                <XCircle size={14} />
                Cancel
              </button>
            )}
          </div>
          {status && <div className="rounded-card border border-border bg-surface-secondary px-3 py-2 text-xs text-content-secondary">{status}</div>}
        </div>

        <AiOutputPanel
          title="Dashboard developer output"
          subtitle="Use this as the Omni chat handoff. If Blobby created a first pass, review tile errors and continue from the linked chat."
          message={message}
          chatUrl={chatUrl}
        />
      </div>
    </div>
  );
}

function ExcelDashboardLane({
  fileInputRef,
  models,
  loadingModels,
  modelSearch,
  selectedModel,
  selectedModelId,
  topics,
  selectedTopicName,
  loadingTopics,
  intent,
  goal,
  colorScheme,
  inventory,
  parsing,
  running,
  dashboardRunning,
  status,
  message,
  dashboardMessage,
  chatUrl,
  onModelSearch,
  onModelSelect,
  onTopicSelect,
  onIntent,
  onGoal,
  onColorScheme,
  onUpload,
  onClear,
  onAnalyze,
  onBuildDashboard,
  onCancelAnalyze,
  onCancelBuildDashboard,
}: {
  fileInputRef: RefObject<HTMLInputElement>;
  models: OmniModel[];
  loadingModels: boolean;
  modelSearch: string;
  selectedModel: OmniModel | null;
  selectedModelId: string;
  topics: OmniTopic[];
  selectedTopicName: string;
  loadingTopics: boolean;
  intent: ExcelConversionIntent;
  goal: string;
  colorScheme: string;
  inventory: ExcelWorkbookInventory | null;
  parsing: boolean;
  running: boolean;
  dashboardRunning: boolean;
  status: string;
  message: string;
  dashboardMessage: string;
  chatUrl: string;
  onModelSearch: (value: string) => void;
  onModelSelect: (value: string) => void;
  onTopicSelect: (value: string) => void;
  onIntent: (value: ExcelConversionIntent) => void;
  onGoal: (value: string) => void;
  onColorScheme: (value: string) => void;
  onUpload: (file: File | undefined) => void;
  onClear: () => void;
  onAnalyze: () => void;
  onBuildDashboard: () => void;
  onCancelAnalyze: () => void;
  onCancelBuildDashboard: () => void;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
      <div className="space-y-4">
        <TargetModelSelector
          models={models}
          loadingModels={loadingModels}
          modelSearch={modelSearch}
          selectedModel={selectedModel}
          selectedModelId={selectedModelId}
          topics={topics}
          selectedTopicName={selectedTopicName}
          loadingTopics={loadingTopics}
          onModelSearch={onModelSearch}
          onModelSelect={onModelSelect}
          onTopicSelect={onTopicSelect}
        />
        <div className="card p-4 space-y-3">
          <div>
            <div className="text-sm font-semibold text-content-primary">Excel workbook</div>
            <div className="mt-0.5 text-xs text-content-secondary">Upload an .xlsx workbook. Raw file contents stay in page memory for this session.</div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(event) => onUpload(event.target.files?.[0])}
          />
          <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-secondary w-full justify-center text-sm">
            {parsing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            Upload Excel workbook
          </button>
          {inventory && (
            <button type="button" onClick={onClear} className="btn-secondary w-full justify-center text-sm">
              <Trash2 size={14} />
              Clear workbook
            </button>
          )}
        </div>
        <div className="card p-4 space-y-3">
          <div className="text-sm font-semibold text-content-primary">Conversion intent</div>
          {[
            { id: 'semantic_and_dashboard', label: 'Dashboard draft + model follow-ups', description: 'Draft safe tiles from existing fields, then list model updates as follow-up work.' },
            { id: 'dashboard_only', label: 'Dashboard draft only', description: 'Use formulas as context, but keep model-change recommendations out of the handoff.' },
            { id: 'semantic_only', label: 'Model follow-up plan only', description: 'Stop after formula, lookup, and measure recommendations for AI Semantic Studio.' },
          ].map((option) => (
            <label key={option.id} className="flex cursor-pointer items-start gap-2 rounded-card border border-border bg-white px-3 py-2 text-sm">
              <input
                type="radio"
                checked={intent === option.id}
                onChange={() => onIntent(option.id as ExcelConversionIntent)}
                className="mt-1 text-omni-700 focus:ring-omni-500"
              />
              <span>
                <span className="block font-semibold text-content-primary">{option.label}</span>
                <span className="block text-xs leading-5 text-content-secondary">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <div className="card p-4 space-y-4">
          <div>
            <div className="text-sm font-semibold text-content-primary">Excel conversion brief</div>
            <div className="mt-0.5 text-xs text-content-secondary">Blobby will draft safe dashboard needs from existing fields and list formula or lookup gaps as follow-ups.</div>
          </div>
          <textarea
            value={goal}
            onChange={(event) => onGoal(event.target.value)}
            className="input-field min-h-[86px] resize-y text-sm"
            placeholder="e.g. Convert this sales workbook into governed revenue measures and an executive dashboard."
          />
          <label className="block">
            <span className="text-xs font-semibold text-content-primary">Color / brand style</span>
            <textarea
              value={colorScheme}
              onChange={(event) => onColorScheme(event.target.value)}
              className="input-field mt-1 min-h-[74px] resize-y text-sm"
              placeholder="e.g. Preserve workbook chart colors where readable; use blue for revenue, green for healthy, red for risk, amber for warnings"
            />
          </label>
          {inventory ? (
            <ExcelInventoryPreview inventory={inventory} />
          ) : (
            <div className="rounded-card border border-amber-100 bg-amber-50 px-3 py-3 text-sm text-amber-800">
              Upload an .xlsx workbook to inspect sheets, formulas, and chart metadata.
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={onAnalyze}
              disabled={!selectedModel || !inventory || running}
              className="btn-primary flex-1 text-sm justify-center disabled:cursor-not-allowed disabled:opacity-60"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
              Convert Formulas & Visuals
            </button>
            {running && (
              <button type="button" onClick={onCancelAnalyze} className="btn-secondary justify-center text-sm text-red-700">
                <XCircle size={14} />
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={onBuildDashboard}
              disabled={!selectedModel || !inventory || !message || dashboardRunning || intent === 'semantic_only'}
              className="btn-secondary flex-1 text-sm justify-center disabled:cursor-not-allowed disabled:opacity-60"
            >
              {dashboardRunning ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Start Guarded Draft Chat
            </button>
            {dashboardRunning && (
              <button type="button" onClick={onCancelBuildDashboard} className="btn-secondary justify-center text-sm text-red-700">
                <XCircle size={14} />
                Cancel
              </button>
            )}
          </div>
          {status && <div className="rounded-card border border-border bg-surface-secondary px-3 py-2 text-xs text-content-secondary">{status}</div>}
        </div>

        <AiOutputPanel
          title="Excel conversion analysis"
          subtitle="Review what can be drafted now and what should route to AI Semantic Studio later."
          message={message}
          chatUrl={chatUrl}
        />
        <AiOutputPanel
          title="Excel dashboard developer output"
          subtitle="Continue in Omni chat to review tile errors, finish iteration, and save the dashboard."
          message={dashboardMessage}
          chatUrl={chatUrl}
        />
      </div>
    </div>
  );
}

function LabeledTextarea({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-content-primary">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="input-field mt-1 min-h-[92px] resize-y text-sm"
        placeholder={placeholder}
      />
    </label>
  );
}

function ExcelInventoryPreview({ inventory }: { inventory: ExcelWorkbookInventory }) {
  const measureCandidates = inventory.formulas.filter((formula) => formula.classification === 'candidate_measure').length;
  const scopeNotes = excelInventoryScopeNotes(inventory);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <MiniMetric label="Sheets" value={String(inventory.sheetCount)} />
        <MiniMetric label="Formulas" value={String(inventory.formulas.length)} />
        <MiniMetric label="Measure candidates" value={String(measureCandidates)} />
        <MiniMetric label="Charts" value={String(inventory.charts.length)} />
      </div>
      <details className="rounded-card border border-border bg-white overflow-hidden" open>
        <summary className="cursor-pointer bg-surface-secondary px-3 py-2 text-xs font-semibold text-content-primary">
          Workbook inventory
        </summary>
        <div className="space-y-3 p-3">
          <div className="text-xs text-content-secondary">{inventory.fileName} · {formatSize(inventory.sizeBytes)} · {inventory.summary}</div>
          {scopeNotes.length > 0 && (
            <div className="rounded-card border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Scope note: {scopeNotes.join('; ')}.
            </div>
          )}
          <InventoryList
            title="Sheets"
            items={inventory.sheets.map((sheet) => `${sheet.name}: ${sheet.rowCount} rows, ${sheet.formulaCount} formulas, ${sheet.chartCount} charts`)}
          />
          <InventoryList
            title="Formula candidates"
            items={inventory.formulas.slice(0, 12).map((formula) => `${formula.sheetName}!${formula.cell}: =${formula.formula} (${formula.classification})`)}
            empty="No formulas detected."
          />
          <InventoryList
            title="Chart evidence"
            items={inventory.charts.slice(0, 12).map((chart) => `${chart.sheetName}/${chart.chartName}: ${chart.chartType}${chart.title ? ` - ${chart.title}` : ''}`)}
            empty="No embedded chart metadata detected."
          />
          {inventory.warnings.length > 0 && (
            <div className="rounded-card border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {inventory.warnings.join(' ')}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-border bg-white p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary">{label}</div>
      <div className="mt-1 text-xl font-semibold text-content-primary">{value}</div>
    </div>
  );
}

function InventoryList({ title, items, empty = 'None detected.' }: { title: string; items: string[]; empty?: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-secondary">{title}</div>
      {items.length === 0 ? (
        <div className="text-xs text-content-secondary">{empty}</div>
      ) : (
        <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-content-secondary">
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
    </div>
  );
}
