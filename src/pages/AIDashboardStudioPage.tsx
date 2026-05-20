import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Filter,
  LayoutDashboard,
  Loader2,
  MessageSquareText,
  Sparkles,
} from 'lucide-react';
import { DashboardSearch } from '@/components/deckBuilder/DashboardSearch';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { AIWorkingAnimation, type AIWorkStepStatus } from '@/components/ui/AIWorkingAnimation';
import { Vehicle } from '@/components/ui/Vehicle';
import { useConnection } from '@/contexts/ConnectionContext';
import { ApiError, createAiJob, enrichDocuments, getAiJob, getAiJobResult, listTopics, type EnrichmentResult, type OmniAiJob, type OmniAiJobResult } from '@/services/omniApi';
import { fetchDashboardList, fetchDashboardSummary } from '@/services/deckBuilder/omniDeckApi';
import { dashboardCache, type CachedDashboard } from '@/services/deckBuilder/localCache';
import type { DashboardFilter, DashboardTile } from '@/services/deckBuilder/types';

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

function shortenId(value?: string) {
  if (!value) return 'Not detected';
  return value.length > 20 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function cleanReviewText(value: string) {
  return value.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

function AiReviewContent({ message }: { message: string }) {
  const lines = message.split('\n');
  return (
    <div className="space-y-3">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        if (/^Here is the full AI Dashboard Studio review/i.test(trimmed)) return null;
        if (/^-{3,}$/.test(trimmed)) {
          return <div key={`${index}-${trimmed}`} className="h-px bg-border my-4" />;
        }
        if (/^#{1,4}\s+/.test(trimmed)) {
          return (
            <div key={`${index}-${trimmed}`} className="pt-2 text-sm font-semibold text-content-primary">
              {cleanReviewText(trimmed.replace(/^#{1,4}\s+/, ''))}
            </div>
          );
        }
        if (/^[-*]\s+/.test(trimmed)) {
          return (
            <div key={`${index}-${trimmed}`} className="flex gap-2 text-sm leading-6 text-content-secondary">
              <span className="mt-2 h-1.5 w-1.5 rounded-full bg-omni-500 flex-shrink-0" />
              <span>{cleanReviewText(trimmed.replace(/^[-*]\s+/, ''))}</span>
            </div>
          );
        }
        return (
          <p key={`${index}-${trimmed}`} className="text-sm leading-6 text-content-secondary">
            {cleanReviewText(trimmed)}
          </p>
        );
      })}
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

export function AIDashboardStudioPage() {
  const { connection } = useConnection();
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
  const [error, setError] = useState('');

  useEffect(() => {
    const cached = dashboardCache.load(connection.baseUrl);
    if (cached?.data) {
      setDashboards(cached.data);
      setDashboardsSyncedAt(cached.savedAt);
    }
  }, [connection.baseUrl]);

  async function refreshDashboardList() {
    setLoadingDashboards(true);
    setError('');
    try {
      const next = await fetchDashboardList(connection.baseUrl, connection.apiKey);
      setDashboards(next);
      setDashboardsSyncedAt(Date.now());
      dashboardCache.save(connection.baseUrl, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboards');
    } finally {
      setLoadingDashboards(false);
    }
  }

  async function inspectDashboard(picked: CachedDashboard) {
    const sameDashboard = selectedDashboard?.id === picked.id || dashboard?.id === picked.id;
    setSelectedDashboard(picked);
    setDashboard(null);
    setAiMessage('');
    setAiJob(null);
    if (!sameDashboard) {
      setChatUrl('');
      setAiConversationId('');
      setReviewStatus('');
    } else {
      setReviewStatus(aiConversationId ? 'Continuing the existing Omni AI chat for this dashboard.' : '');
    }
    setInspecting(true);
    setError('');
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
          topics = catalogTopics.map((topic) => topic.name).filter(Boolean).slice(0, 5);
        } catch {
          topics = [];
        }
      }
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
      setError(err instanceof Error ? err.message : 'Failed to inspect dashboard');
    } finally {
      setInspecting(false);
    }
  }

  async function waitForAiJob(jobId: string, pollIntervalMs = 3000, maxPolls = 36) {
    let latest: OmniAiJob | null = null;
    for (let i = 0; i < maxPolls; i += 1) {
      latest = await getAiJob(connection.baseUrl, connection.apiKey, jobId);
      setAiJob((prev) => ({ ...(prev || {}), ...latest }));
      const state = normalizeAiState(latest.state || latest.status);
      if (['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELED'].includes(state)) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return latest;
  }

  async function getAiResult(jobId: string, finalJob: OmniAiJob | null) {
    let lastError: unknown = null;
    for (let i = 0; i < 8; i += 1) {
      try {
        const result = await getAiJobResult(connection.baseUrl, connection.apiKey, jobId);
        if (extractAiMessage(result, finalJob)) return result;
      } catch (err) {
        lastError = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (extractAiMessage(undefined, finalJob)) return null;
    throw lastError instanceof Error ? lastError : new Error('AI result was not available yet.');
  }

  async function createDashboardAiJobWithRetry(prompt: string) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await createAiJob(connection.baseUrl, connection.apiKey, {
          modelId: dashboard?.modelId || '',
          topicName: dashboard?.topics[0],
          prompt,
          conversationId: aiConversationId || undefined,
        });
      } catch (err) {
        lastError = err;
        const retryable = err instanceof ApiError && [429, 500, 502, 503].includes(err.status);
        if (!retryable || attempt === 2) break;
        setReviewStatus('Omni is busy, waiting a moment before retrying...');
        await new Promise((resolve) => setTimeout(resolve, 8000));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Omni AI review failed to start.');
  }

  async function runDashboardReview() {
    if (!dashboard?.modelId) return;
    setReviewing(true);
    setError('');
    setAiMessage('');
    setReviewStatus(aiConversationId ? 'Continuing existing Omni AI chat...' : 'Starting Omni AI review...');
    try {
      const prompt = buildDashboardReviewPrompt(dashboard);
      setReviewStatus(aiConversationId ? 'Creating follow-up AI job in the same chat...' : 'Creating Omni AI job...');
      const created = await createDashboardAiJobWithRetry(prompt);
      setAiJob(created);
      const jobId = created.jobId || created.id;
      if (!jobId) throw new Error('Omni did not return an AI job ID.');
      const createdConversationId = readFirstString(created, ['conversationId', 'conversation_id']);
      if (createdConversationId) setAiConversationId(createdConversationId);
      setReviewStatus('Waiting for Omni AI to finish...');
      const finalJob = await waitForAiJob(jobId);
      const finalState = normalizeAiState(finalJob?.state || finalJob?.status);
      const finalConversationId = readFirstString(finalJob, ['conversationId', 'conversation_id']) || createdConversationId || aiConversationId;
      if (['FAILED', 'CANCELLED', 'CANCELED'].includes(finalState)) {
        throw new Error(`Omni AI job ${finalState.toLowerCase()}.`);
      }
      setReviewStatus('Retrieving AI review output...');
      const result = await getAiResult(jobId, finalJob);
      const message = extractAiMessage(result, finalJob) || 'AI review completed, but no narrative result was returned.';
      const resultConversationId = readFirstString(result, ['conversationId', 'conversation_id']);
      const nextConversationId = resultConversationId || finalConversationId;
      if (nextConversationId) setAiConversationId(nextConversationId);
      setAiMessage(message);
      setReviewStatus('Review complete.');
      setChatUrl(
        readFirstString(result, ['omniChatUrl', 'omni_chat_url']) ||
        readFirstString(finalJob, ['omniChatUrl', 'omni_chat_url']) ||
        readFirstString(created, ['omniChatUrl', 'omni_chat_url']) ||
        chatUrl
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to run AI dashboard review';
      setError(message);
      setReviewStatus(`Review failed: ${message}`);
    } finally {
      setReviewing(false);
    }
  }

  const aiStatus = normalizeAiState(aiJob?.state || aiJob?.status);
  const canRunAi = Boolean(dashboard?.modelId && !reviewing && !inspecting);
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

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

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

            <button
              onClick={runDashboardReview}
              disabled={!canRunAi}
              className={`${canRunAi ? 'btn-primary' : 'bg-surface-secondary border border-border text-content-tertiary cursor-not-allowed'} w-full text-sm inline-flex items-center justify-center gap-2 rounded-button px-5 py-2.5 font-semibold transition-all`}
            >
              {reviewing ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              Run Focused AI Review
            </button>
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
                  detail="Blobby is checking tiles, filters, topic routing, semantic dependencies, and the final admin recommendations."
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
                      <a href={chatUrl} target="_blank" rel="noreferrer" className="btn-secondary text-sm inline-flex items-center gap-2">
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
                  <a href={chatUrl} target="_blank" rel="noreferrer" className="btn-secondary text-sm inline-flex items-center justify-center gap-2 flex-shrink-0">
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
    </div>
  );
}
