import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Database, FileCode2, GitBranch, Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { listModels, listTopics, validateModel } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusChip } from '@/components/ui/StatusChip';
import { Blobby } from '@/components/ui/Blobby';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import type { OmniModel } from '@/types';

const READINESS_SCAN_DELAY_MS = 1500;

type ValidationIssue = {
  message?: string;
  is_warning?: boolean;
  yaml_path?: string;
  auto_fix?: {
    description_short?: string;
    description_unique?: string;
  };
};

type TopicHealthSummary = {
  topics: number;
  described: number;
  missingDescription: string[];
  error?: string;
};

function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function modelKindLabel(kind: string | undefined): string {
  return kind?.replace(/_/g, ' ') || 'Unknown';
}

function issueSeverity(issue: ValidationIssue) {
  return issue.is_warning ? 'Warning' : 'Error';
}

function guidanceForIssue(issue: ValidationIssue): string {
  const message = issue.message || '';
  if (issue.auto_fix?.description_unique || issue.auto_fix?.description_short) {
    return issue.auto_fix.description_unique || issue.auto_fix.description_short || '';
  }
  if (message.includes('Set base_view')) {
    return 'Open the topic YAML and point base_view to an existing view, or remove the topic if the source view no longer exists.';
  }
  if (message.toLowerCase().includes('no view')) {
    return 'Confirm the referenced view exists in the model YAML. If it was renamed or deleted, update any topic, join, or field reference that still points to the old view.';
  }
  if (message.toLowerCase().includes('field')) {
    return 'Inspect the YAML path shown below and confirm the referenced field exists, is spelled correctly, and is available in the selected model or branch.';
  }
  return 'Review the YAML file and path shown below, then re-run validation after the model change is made in Omni or through the approved YAML workflow.';
}

function readinessStatus(issues: ValidationIssue[] | undefined) {
  if (!issues) return { label: 'Not Scanned', className: 'text-content-secondary', icon: null };
  const errors = issues.filter((issue) => !issue.is_warning).length;
  const warnings = issues.filter((issue) => issue.is_warning).length;
  if (errors === 0 && warnings === 0) {
    return { label: 'Ready', className: 'text-green-700', icon: <CheckCircle2 size={13} /> };
  }
  if (errors > 0) {
    return { label: `${errors} errors / ${warnings} warnings`, className: 'text-red-700', icon: <AlertTriangle size={13} /> };
  }
  return { label: `${warnings} warnings`, className: 'text-amber-700', icon: <AlertTriangle size={13} /> };
}

function topicHealthStatus(summary: TopicHealthSummary | undefined) {
  if (!summary) return { label: 'Not Scanned', className: 'text-content-secondary', icon: null };
  if (summary.error) return { label: 'Topic scan failed', className: 'text-red-700', icon: <AlertTriangle size={13} /> };
  if (summary.topics === 0) return { label: 'No topics', className: 'text-amber-700', icon: <AlertTriangle size={13} /> };
  if (summary.missingDescription.length > 0) {
    return { label: `${summary.missingDescription.length} topic gaps`, className: 'text-amber-700', icon: <AlertTriangle size={13} /> };
  }
  return { label: 'Topics healthy', className: 'text-green-700', icon: <CheckCircle2 size={13} /> };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('429') || normalized.includes('rate limit') || normalized.includes('too many') || normalized.includes('security');
}

export function ModelsPage() {
  const navigate = useNavigate();
  const { connection } = useConnection();
  const connectionKey = connection.instanceId || connection.baseUrl;
  const activeConnectionKeyRef = useRef(connectionKey);
  const [models, setModels] = useState<OmniModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('production');
  const [connectionFilter, setConnectionFilter] = useState<string>('all');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [validationResults, setValidationResults] = useState<Record<string, ValidationIssue[]>>({});
  const [topicHealthResults, setTopicHealthResults] = useState<Record<string, TopicHealthSummary>>({});
  const [scanRunning, setScanRunning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ complete: 0, total: 0 });
  const [scanBatchSize, setScanBatchSize] = useState(10);
  const [scanPausedMessage, setScanPausedMessage] = useState('');
  const [selectedIssue, setSelectedIssue] = useState<{ model: OmniModel; issue: ValidationIssue } | null>(null);

  useEffect(() => {
    activeConnectionKeyRef.current = connectionKey;
  }, [connectionKey]);

  useEffect(() => {
    fetchModels(false);
    // fetchModels intentionally stays local so filter changes are explicit dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.baseUrl, connection.apiKey, connectionKey, includeDeleted]);

  async function fetchModels(keepRows: boolean) {
    const requestKey = connectionKey;
    if (keepRows) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError('');
    try {
      const res = await listModels(connection.baseUrl, connection.apiKey, {
        allPages: true,
        pageSize: 100,
        includeDeleted,
        include: 'activeBranches',
        sortField: 'name',
        sortDirection: 'asc',
      });
      if (res.error) {
        if (activeConnectionKeyRef.current !== requestKey) return;
        setError(res.error);
        return;
      }
      if (activeConnectionKeyRef.current !== requestKey) return;
      setModels(Array.isArray(res.models) ? res.models : []);
    } catch (err) {
      if (activeConnectionKeyRef.current !== requestKey) return;
      setError(err instanceof Error ? err.message : 'Failed to load models');
    } finally {
      if (activeConnectionKeyRef.current === requestKey) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  async function handleValidate(model: OmniModel) {
    const requestKey = connectionKey;
    setValidatingId(model.id);
    setError('');
    try {
      const issues = await validateModel(connection.baseUrl, connection.apiKey, model.id);
      if (activeConnectionKeyRef.current !== requestKey) return;
      setValidationResults((prev) => ({ ...prev, [model.id]: Array.isArray(issues) ? issues : [] }));
      await scanTopicHealth(model);
    } catch (err) {
      if (activeConnectionKeyRef.current !== requestKey) return;
      setValidationResults((prev) => ({
        ...prev,
        [model.id]: [{ message: err instanceof Error ? err.message : 'Validation failed', is_warning: false }],
      }));
    } finally {
      if (activeConnectionKeyRef.current === requestKey) setValidatingId(null);
    }
  }

  async function scanTopicHealth(model: OmniModel) {
    const requestKey = connectionKey;
    try {
      const topics = await listTopics(connection.baseUrl, connection.apiKey, model.id);
      if (activeConnectionKeyRef.current !== requestKey) return;
      const missingDescription = topics
        .filter((topic) => !topic.description?.trim())
        .map((topic) => topic.label || topic.name)
        .slice(0, 5);
      setTopicHealthResults((prev) => ({
        ...prev,
        [model.id]: {
          topics: topics.length,
          described: topics.length - topics.filter((topic) => !topic.description?.trim()).length,
          missingDescription,
        },
      }));
    } catch (err) {
      if (activeConnectionKeyRef.current !== requestKey) return;
      setTopicHealthResults((prev) => ({
        ...prev,
        [model.id]: {
          topics: 0,
          described: 0,
          missingDescription: [],
          error: err instanceof Error ? err.message : 'Topic health scan failed',
        },
      }));
    }
  }

  async function handleReadinessScan() {
    const scanTargets = filteredModels
      .filter((model) => !model.deletedAt && (!validationResults[model.id] || !topicHealthResults[model.id]))
      .slice(0, scanBatchSize);

    if (scanTargets.length === 0) {
      setScanPausedMessage('All visible models in this filter have already been scanned. Adjust filters or refresh to scan a different set.');
      return;
    }

    setScanRunning(true);
    setScanProgress({ complete: 0, total: scanTargets.length });
    setError('');
    setScanPausedMessage('');

    for (let i = 0; i < scanTargets.length; i += 1) {
      const model = scanTargets[i];
      try {
        const issues = await validateModel(connection.baseUrl, connection.apiKey, model.id);
        setValidationResults((prev) => ({ ...prev, [model.id]: Array.isArray(issues) ? issues : [] }));
        await scanTopicHealth(model);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Validation failed';
        setValidationResults((prev) => ({
          ...prev,
          [model.id]: [{ message, is_warning: false }],
        }));
        if (isRateLimitError(message)) {
          setScanPausedMessage('Scan paused because Omni returned a rate or security response. Wait a bit, then continue with a smaller batch.');
          break;
        }
      } finally {
        setScanProgress({ complete: i + 1, total: scanTargets.length });
      }
      if (i < scanTargets.length - 1) {
        await wait(READINESS_SCAN_DELAY_MS);
      }
    }

    setScanRunning(false);
  }

  const filteredModels = models.filter((model) => {
    const needle = search.toLowerCase();
    const matchesSearch =
      !needle ||
      model.name.toLowerCase().includes(needle) ||
      model.id.toLowerCase().includes(needle) ||
      model.connectionId?.toLowerCase().includes(needle);
    const productionKinds = ['SCHEMA', 'SHARED', 'SHARED_EXTENSION'];
    const matchesKind =
      kindFilter === 'all' ||
      (kindFilter === 'production' && productionKinds.includes(model.kind || '')) ||
      (model.kind || '').toLowerCase() === kindFilter.toLowerCase();
    const matchesConnection = connectionFilter === 'all' || model.connectionId === connectionFilter;
    return matchesSearch && matchesKind && matchesConnection;
  });

  const kinds = [...new Set(models.map((model) => model.kind).filter(Boolean))].sort();
  const connectionIds = [...new Set(models.map((model) => model.connectionId).filter(Boolean))].sort();
  const activeModels = models.filter((model) => !model.deletedAt);
  const schemaCount = activeModels.filter((model) => model.kind === 'SCHEMA').length;
  const sharedCount = activeModels.filter((model) => model.kind === 'SHARED' || model.kind === 'SHARED_EXTENSION').length;
  const branchCount = activeModels.filter((model) => model.kind === 'BRANCH').length;
  const scannedModels = Object.keys(validationResults).length;
  const topicScannedModels = Object.keys(topicHealthResults).length;
  const totalTopicsScanned = Object.values(topicHealthResults).reduce((sum, result) => sum + result.topics, 0);
  const topicGapModels = models.filter((model) => {
    const result = topicHealthResults[model.id];
    return Boolean(result?.error || result?.topics === 0 || (result?.missingDescription.length || 0) > 0);
  }).length;
  const issueModels = models.filter((model) => (validationResults[model.id] || []).some((issue) => !issue.is_warning)).length;
  const warningModels = models.filter((model) => {
    const issues = validationResults[model.id] || [];
    return issues.length > 0 && issues.every((issue) => issue.is_warning);
  }).length;
  const readyModels = models.filter((model) => validationResults[model.id]?.length === 0).length;
  const visibleUnscannedCount = filteredModels.filter((model) => !model.deletedAt && (!validationResults[model.id] || !topicHealthResults[model.id])).length;
  const nextScanCount = Math.min(scanBatchSize, visibleUnscannedCount);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Model & Topic Health"
        description="Read-only health checks for model settings, relationships, views, and topic coverage before routing fixes into AI Semantic Studio."
        icon={<Blobby mood="model" size={58} className="animate-float" style={{ animationDuration: '3.5s' }} />}
        actions={
          <button
            onClick={handleReadinessScan}
            disabled={scanRunning || loading || visibleUnscannedCount === 0}
            className="btn-primary text-sm"
          >
            {scanRunning ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            {scanRunning ? 'Scanning...' : `Scan Health ${nextScanCount || scanBatchSize}`}
          </button>
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Models Scanned</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{scannedModels}</div>
          <div className="mt-1 text-xs text-content-secondary">{scanRunning ? `${scanProgress.complete}/${scanProgress.total} complete` : `${visibleUnscannedCount} visible remaining`}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Model Blockers</div>
          <div className="mt-2 text-2xl font-semibold text-red-700">{issueModels}</div>
          <div className="mt-1 text-xs text-content-secondary">Models with validation errors</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Needs Review</div>
          <div className="mt-2 text-2xl font-semibold text-amber-700">{warningModels}</div>
          <div className="mt-1 text-xs text-content-secondary">Warning-only models</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Topic Health</div>
          <div className="mt-2 text-2xl font-semibold text-amber-700">{topicGapModels}</div>
          <div className="mt-1 text-xs text-content-secondary">{totalTopicsScanned} topics across {topicScannedModels} models</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Ready</div>
          <div className="mt-2 text-2xl font-semibold text-green-700">{readyModels}</div>
          <div className="mt-1 text-xs text-content-secondary">{activeModels.length} active models loaded</div>
        </div>
      </div>

      <div className="card p-4">
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Inventory</div>
            <div className="mt-1 text-content-primary">{schemaCount} schema / {sharedCount} shared / {branchCount} branches</div>
          </div>
          <div>
            <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Next Action</div>
            <div className="mt-1 text-content-primary">{issueModels > 0 || topicGapModels > 0 ? 'Open issue details or route repairs to AI Semantic Studio.' : scannedModels > 0 ? 'Review warnings or proceed.' : 'Run a health scan.'}</div>
          </div>
          <div className="xl:col-span-2">
            <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Safety</div>
            <div className="mt-1 text-content-secondary">Read-only estate triage. Validates model files, relationships, view files, and topic coverage in throttled batches of {scanBatchSize}, with a {READINESS_SCAN_DELAY_MS / 1000}s pause between models.</div>
          </div>
        </div>
      </div>

      {scanPausedMessage && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm px-4 py-3 rounded-card">
          {scanPausedMessage}
        </div>
      )}

      {scanRunning && (
        <WorkflowStatusScene
          variant="health-scan"
          title="Scanning model and topic health"
          detail="Checking model validation and topic coverage in a controlled batch."
          statusLabel="Scanning"
          progressLabel={`${scanProgress.complete}/${scanProgress.total} models complete`}
          compact
        />
      )}

      <div className="card p-4 space-y-3">
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-3">
          <div className="xl:col-span-2">
            <SearchInput value={search} onChange={setSearch} placeholder="Search model name, ID, or connection ID..." />
          </div>
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="input-field">
            <option value="production">Production model layers</option>
            <option value="all">All model kinds</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind!}>{modelKindLabel(kind)}</option>
            ))}
          </select>
          <select value={connectionFilter} onChange={(e) => setConnectionFilter(e.target.value)} className="input-field">
            <option value="all">All connections</option>
            {connectionIds.map((id) => (
              <option key={id} value={id!}>{id}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs text-content-secondary">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => setIncludeDeleted(e.target.checked)}
              className="rounded border-border text-omni-700 focus:ring-omni-500"
            />
            Include deleted models
          </label>
          <button onClick={() => fetchModels(true)} className="btn-secondary text-sm">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
          <label className="inline-flex items-center gap-2 text-xs text-content-secondary">
            Batch
            <select
              value={scanBatchSize}
              onChange={(e) => setScanBatchSize(Number(e.target.value))}
              disabled={scanRunning}
              className="input-field h-9 w-20 py-1 text-xs"
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={25}>25</option>
            </select>
          </label>
          <span className="text-xs text-content-secondary">{filteredModels.length.toLocaleString()} visible of {models.length.toLocaleString()} loaded</span>
        </div>
      </div>

      {loading ? (
        <WorkflowStatusScene
          variant="health-scan"
          title="Loading model and topic health"
          detail="Pulling the model inventory before validation begins."
          statusLabel="Loading"
          compact
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-white">
            <div className="text-sm font-semibold text-content-primary">Model and topic health triage</div>
            <div className="text-xs text-content-secondary mt-0.5">Scan the next unscanned visible batch, then route repairs into AI Semantic Studio. No model, relationships, view, or topic files are changed here.</div>
          </div>
          <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2">
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Model</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Kind</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Connection</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Updated</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Validation</div>
            <div className="col-span-1 text-xs font-medium text-content-secondary uppercase tracking-wider" />
          </div>
          <div className="max-h-[560px] overflow-y-auto">
            {filteredModels.length === 0 ? (
              <div className="text-center py-12 text-content-secondary text-sm">No models found.</div>
            ) : (
              filteredModels.map((model) => {
                const issues = validationResults[model.id];
                const topicHealth = topicHealthResults[model.id];

                return (
                  <div key={model.id} className="border-b border-border/50">
                    <div className="px-4 py-3 grid grid-cols-12 gap-2 items-center hover:bg-surface-secondary transition-colors">
                      <div className="col-span-3 min-w-0">
                        <div className="flex items-center gap-2">
                          {model.kind === 'BRANCH' ? <GitBranch size={15} className="text-content-secondary flex-shrink-0" /> : <Database size={15} className="text-content-secondary flex-shrink-0" />}
                          <div className="min-w-0">
                            <div className="text-sm text-content-primary font-medium truncate">{model.name}</div>
                            <div className="font-mono text-[10px] text-content-tertiary truncate" title={model.id}>{model.id}</div>
                          </div>
                        </div>
                      </div>
                      <div className="col-span-2">
                        <StatusChip status={model.deletedAt ? 'warning' : 'info'} label={modelKindLabel(model.kind)} />
                      </div>
                      <div className="col-span-2 font-mono text-xs text-content-secondary truncate" title={model.connectionId}>
                        {model.connectionId || '-'}
                      </div>
                      <div className="col-span-2 text-xs text-content-secondary">{formatDate(model.updatedAt)}</div>
                      <div className="col-span-2 text-xs space-y-2">
                        <div>
                          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">Model</div>
                          <span className={`inline-flex items-center gap-1 ${readinessStatus(issues).className}`}>
                            {readinessStatus(issues).icon}
                            {readinessStatus(issues).label}
                          </span>
                        </div>
                        {topicHealth && (
                          <div className="border-t border-border/60 pt-2">
                            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">Topic</div>
                            <span className={`inline-flex items-center gap-1 ${topicHealthStatus(topicHealth).className}`}>
                              {topicHealthStatus(topicHealth).icon}
                              {topicHealthStatus(topicHealth).label}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="col-span-1 flex justify-end">
                        <button
                          onClick={() => handleValidate(model)}
                          disabled={validatingId === model.id || Boolean(model.deletedAt)}
                          className="btn-secondary text-xs px-2 py-1.5"
                        >
                          {validatingId === model.id ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                          Check
                        </button>
                      </div>
                    </div>
                    {issues && issues.length > 0 && (
                      <div className="px-4 pb-3 pl-12 space-y-1">
                        {issues.slice(0, 3).map((issue, index) => (
                          <div key={`${model.id}-${index}`} className="flex items-start gap-2 text-xs text-content-secondary">
                            <FileCode2 size={12} className="mt-0.5 flex-shrink-0" />
                            <span className="font-mono text-content-tertiary">{issue.yaml_path || 'model'}</span>
                            <button
                              onClick={() => setSelectedIssue({ model, issue })}
                              className="text-left text-content-secondary hover:text-omni-700 transition-colors"
                            >
                              {issue.message || 'Validation issue'}
                            </button>
                          </div>
                        ))}
                        {issues.length > 3 && (
                          <div className="text-xs text-content-tertiary">+ {issues.length - 3} more issues</div>
                        )}
                      </div>
                    )}
                    {topicHealth && (topicHealth.error || topicHealth.topics === 0 || topicHealth.missingDescription.length > 0) && (
                      <div className="px-4 pb-3 pl-12 text-xs text-content-secondary">
                        <div className="rounded-button border border-amber-100 bg-amber-50 px-3 py-2 text-amber-800">
                          <span className="font-semibold">Topic health:</span>{' '}
                          {topicHealth.error
                            ? topicHealth.error
                            : topicHealth.topics === 0
                              ? 'No topics returned for this model.'
                              : `Missing descriptions: ${topicHealth.missingDescription.join(', ')}`}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {selectedIssue && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSelectedIssue(null)} />
          <div className="relative h-full w-full max-w-xl bg-white shadow-dropdown border-l border-border overflow-y-auto animate-fadeIn">
            <div className="sticky top-0 z-10 bg-white border-b border-border px-5 py-4 flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-medium uppercase tracking-wider text-content-secondary">{issueSeverity(selectedIssue.issue)}</div>
                <h2 className="text-lg font-semibold text-content-primary mt-1">Validation issue</h2>
              </div>
              <button onClick={() => setSelectedIssue(null)} className="btn-ghost p-2" aria-label="Close issue details">
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="card p-4 bg-surface-secondary">
                <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Model</div>
                <div className="mt-1 text-sm font-semibold text-content-primary">{selectedIssue.model.name}</div>
                <div className="mt-1 font-mono text-xs text-content-secondary break-all">{selectedIssue.model.id}</div>
              </div>

              <div>
                <div className="text-xs font-medium text-content-secondary uppercase tracking-wider mb-1.5">Message</div>
                <div className="text-sm text-content-primary leading-relaxed">{selectedIssue.issue.message || 'Validation issue'}</div>
              </div>

              <div>
                <div className="text-xs font-medium text-content-secondary uppercase tracking-wider mb-1.5">YAML path</div>
                <div className="font-mono text-xs text-content-secondary bg-surface-secondary border border-border rounded-button px-3 py-2">
                  {selectedIssue.issue.yaml_path || 'model'}
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-content-secondary uppercase tracking-wider mb-1.5">Recommended next step</div>
                <div className="text-sm text-content-primary leading-relaxed">{guidanceForIssue(selectedIssue.issue)}</div>
              </div>

              <div className="bg-omni-50 border border-omni-100 rounded-card p-4 text-sm text-omni-700">
                <div className="font-semibold mb-1">Read-only guardrail</div>
                <div>OmniKit is not applying this fix here. Route semantic repairs into AI Semantic Studio, validate on a dev branch, then rerun this health scan.</div>
              </div>

              <div className="flex justify-end gap-2">
                <button onClick={() => navigate('/topics')} className="btn-primary text-sm">Open AI Semantic Studio</button>
                <button onClick={() => setSelectedIssue(null)} className="btn-secondary text-sm">Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
