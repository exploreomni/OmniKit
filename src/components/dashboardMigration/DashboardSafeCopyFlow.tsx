import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useConnection } from '@/hooks/useConnection';
import { ApiError } from '@/services/omniApi';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Database,
  ExternalLink,
  FileText,
  FolderInput,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';

import { SavedInstanceRequiredEmptyState } from '@/components/layout/RequireConnection';
import { ComboBox } from '@/components/ui/ComboBox';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusChip } from '@/components/ui/StatusChip';
import { DashboardReadinessReview } from './DashboardReadinessReview';
import { dashboardReadinessIsStale, staleDashboardReadiness } from './dashboardReadinessPresentation';
import { DestinationFolderPicker } from './DestinationFolderPicker';
import { DESTINATIONS_PER_PAGE, destinationPage } from './dashboardDestinationSelection';
import { destinationFolderCacheKey, EMPTY_FOLDER_CATALOG, useDashboardDestinationFolders } from './useDashboardDestinationFolders';
import { hasVerifiedDashboardSelection, mergeVerifiedDashboardDocuments, sourceConnectionEmptyLabel, sourceConnectionLoadError } from './dashboardSourceSelection';
import {
  getMigrationJob,
  getVaultStatus,
  listInstanceDocuments,
  lookupInstanceDocument,
  streamInstanceDocuments,
  listMigrationJobs,
  listModelMigratorConnections,
  listModelMigratorModels,
  listSavedInstances,
  retryDashboardSafeCopyTarget,
  subscribeMigrationJob,
  type InstanceDocument,
  type InstanceDocumentInventory,
  type InstanceDocumentsProgress,
  type InstanceModel,
  type MigrationJob,
  type ModelMigratorConnection,
  type SavedInstancePublic,
  type VaultStatus,
} from '@/services/opsConsole';
import { modelDisplayLabel, sortDocuments, sortModels, sortSavedInstances } from '@/utils/catalogSort';
// Shared with DashboardMigrationWizard so both flows disambiguate connections
// that share a name, rather than each rendering its own option shape.
import { buildConnectionComboBoxOptions } from './dashboardMigrationUtils';
import { createDashboardSafeCopyModelMigratorHandoff } from '@/services/modelMigratorHandoff';
import {
  createDashboardDeploymentPlan,
  deployDashboardDeploymentPlan,
  getDashboardDeploymentPlan,
  recheckDashboardDeploymentPlan,
  updateDashboardDeploymentPlan,
  type DashboardDeploymentPlan,
  type DashboardDeploymentTargetUpdate,
  type DashboardReadinessProgressEvent,
} from '@/services/dashboardDeploymentPlans';
import {
  createDashboardSafeCopyDraft,
  DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS,
  dashboardSafeCopyDraftReducer,
  dashboardSafeCopyIntentFromDraft,
  dashboardSafeCopyJobProgress,
  dashboardSafeCopyTargetActions,
  isDashboardSafeCopyJobForRequest,
  isDashboardSafeCopyTerminal,
  newDashboardSafeCopyRequestId,
  readDashboardSafeCopyDraft,
  resolveDashboardSafeCopyDestinationDefaults,
  shouldApplyDashboardSafeCopyJobSnapshot,
  writeDashboardSafeCopyDraft,
  type DashboardSafeCopyDestinationDraft,
  type DashboardSafeCopyDocumentPhase,
  type DashboardSafeCopyStep,
  type DashboardSafeCopyTargetStage,
  type DashboardSafeCopyTargetPhase,
  type DashboardSafeCopyTargetProgress,
} from './dashboardSafeCopyFlowState';

const MAX_SELECTED_DASHBOARDS = 500;
const MAX_DESTINATIONS = 100;
const DASHBOARD_PAGE_SIZE = 100;
const PROGRESS_DOCUMENT_PAGE_SIZE = 20;
const TRACKING_REFRESH_MS = 4_000;
const STEP_LABELS = ['Choose dashboards', 'Choose destinations', 'Review readiness', 'Deploy and track'] as const;

interface DestinationCatalog {
  connections: ModelMigratorConnection[];
  models: InstanceModel[];
  loading: boolean;
  loaded: boolean;
  error: string;
}

interface SourceConnectionCatalog {
  instanceId: string;
  connections: ModelMigratorConnection[];
  loading: boolean;
  loaded: boolean;
  error: string;
}

const EMPTY_SOURCE_CONNECTION_CATALOG: SourceConnectionCatalog = {
  instanceId: '', connections: [], loading: false, loaded: false, error: '',
};

const EMPTY_DESTINATION_CATALOG: DestinationCatalog = {
  connections: [],
  models: [],
  loading: false,
  loaded: false,
  error: '',
};

const TARGET_PHASE_LABELS: Record<DashboardSafeCopyTargetPhase, string> = {
  preparing: 'Preparing destination',
  ready: 'Ready to copy',
  copying: 'Copying dashboards',
  verifying: 'Verifying dashboards',
  reconciliation_required: 'Reconciliation required',
  succeeded: 'Complete',
  canceled: 'Canceled before copy',
  needs_attention: 'Needs attention',
};

const TARGET_PHASE_CHIPS: Record<DashboardSafeCopyTargetPhase, string> = {
  preparing: 'pending',
  ready: 'ready',
  copying: 'in_progress',
  verifying: 'in_progress',
  reconciliation_required: 'warning',
  succeeded: 'success',
  canceled: 'skipped',
  needs_attention: 'failed',
};

const TARGET_STAGES: Array<{ id: DashboardSafeCopyTargetStage; label: string }> = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'copy', label: 'Copy' },
  { id: 'verify', label: 'Verify' },
  { id: 'complete', label: 'Complete' },
];

const DOCUMENT_PHASE_LABELS: Record<DashboardSafeCopyDocumentPhase, string> = {
  waiting: 'Waiting',
  copying: 'Copying',
  verifying: 'Verifying',
  complete: 'Complete',
  reconciliation_required: 'Reconciliation required',
  canceled: 'Canceled',
  needs_attention: 'Needs attention',
};

const DOCUMENT_PHASE_CHIPS: Record<DashboardSafeCopyDocumentPhase, string> = {
  waiting: 'pending',
  copying: 'in_progress',
  verifying: 'in_progress',
  complete: 'success',
  reconciliation_required: 'warning',
  canceled: 'skipped',
  needs_attention: 'failed',
};

function instanceSupportsSource(instance: SavedInstancePublic): boolean {
  return instance.role === 'source' || instance.role === 'both';
}

function instanceSupportsDestination(instance: SavedInstancePublic): boolean {
  return instance.role === 'destination' || instance.role === 'both';
}

function sourceDocumentId(document: InstanceDocument): string {
  return document.identifier || document.id;
}

function verifiedDashboardUrl(baseUrl: string | undefined, identifier: string | undefined): string {
  if (!baseUrl || !identifier) return '';
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    url.username = '';
    url.password = '';
    url.pathname = `/dashboards/${encodeURIComponent(identifier)}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function documentSearchText(document: InstanceDocument): string {
  return [
    document.name,
    document.identifier,
    document.baseModelName,
    document.baseModelId,
    document.folderPath,
    ...(document.labels || []),
  ].filter(Boolean).join(' ').toLocaleLowerCase('en-US');
}

const DESTINATION_ACCESS_NOTICE = 'Source sharing is not copied. Access inherited from the destination folder and business acceptance still require your review.';

function destinationFolderLabel(folderPath?: string, folderId?: string): string {
  const path = (folderPath || '').normalize('NFKC').trim().slice(0, 512);
  if (path) return path;
  const id = (folderId || '').normalize('NFKC').trim().slice(0, 128);
  return id ? `Saved destination folder (${id})` : 'Top level';
}

function jobStatusLabel(job: MigrationJob): string {
  if (job.status === 'pending') return 'Preparing destinations';
  if (job.status === 'running') return 'Copying and verifying';
  if (job.status === 'succeeded') return 'Move complete';
  if (job.status === 'partial') return 'Completed with exceptions';
  if (job.status === 'failed') return 'Needs attention';
  return 'Canceled';
}

function jobStatusChip(job: MigrationJob): string {
  if (job.status === 'succeeded') return 'success';
  if (job.status === 'pending') return 'pending';
  if (job.status === 'running') return 'in_progress';
  if (job.status === 'partial') return 'warning';
  return 'failed';
}

function sameDestinationResolution(
  row: DashboardSafeCopyDestinationDraft,
  connectionId: string,
  modelId: string,
): boolean {
  return row.connectionId === connectionId && row.modelId === modelId;
}

function sameDocumentScope(left: string[], right: string[]): boolean {
  const expected = new Set(right);
  return left.length === expected.size && new Set(left).size === left.length && left.every((id) => expected.has(id));
}

export function DashboardSafeCopyFlow() {
  const navigate = useNavigate();
  const location = useLocation();
  const returnPlanId = new URLSearchParams(location.search).get('planId') || '';
  const { connection } = useConnection();
  const [draft, dispatchDraft] = useReducer(
    dashboardSafeCopyDraftReducer,
    undefined,
    readDashboardSafeCopyDraft,
  );
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [instances, setInstances] = useState<SavedInstancePublic[]>([]);
  const [sourceConnectionCatalog, setSourceConnectionCatalog] = useState<SourceConnectionCatalog>(EMPTY_SOURCE_CONNECTION_CATALOG);
  const [documents, setDocuments] = useState<InstanceDocument[]>([]);
  const [dashboardInventory, setDashboardInventory] = useState<InstanceDocumentInventory | null>(null);
  const [destinationCatalogs, setDestinationCatalogs] = useState<Record<string, DestinationCatalog>>({});
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [deploymentPlan, setDeploymentPlan] = useState<DashboardDeploymentPlan | null>(null);
  const [topicRepairBusy, setTopicRepairBusy] = useState(false);
  const latestDeploymentPlan = useRef(deploymentPlan);
  latestDeploymentPlan.current = deploymentPlan;
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  const [readinessProgress, setReadinessProgress] = useState<DashboardReadinessProgressEvent | null>(null);
  const [readinessStartedAt, setReadinessStartedAt] = useState<number | null>(null);
  const [savingPlanTargetId, setSavingPlanTargetId] = useState('');
  const [search, setSearch] = useState('');
  const [visibleDashboardCount, setVisibleDashboardCount] = useState(DASHBOARD_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [loadingDashboards, setLoadingDashboards] = useState(false);
  const [loadingDashboardLookup, setLoadingDashboardLookup] = useState(false);
  const [dashboardReference, setDashboardReference] = useState('');
  const [dashboardBrowseProgress, setDashboardBrowseProgress] = useState<InstanceDocumentsProgress | null>(null);
  const [dashboardBrowseStartedAt, setDashboardBrowseStartedAt] = useState<number | null>(null);
  const [dashboardBrowseElapsed, setDashboardBrowseElapsed] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [retryingTargetIds, setRetryingTargetIds] = useState<string[]>([]);
  const [trackingRevision, setTrackingRevision] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [progressAnnouncement, setProgressAnnouncement] = useState('');
  const [visibleProgressDocuments, setVisibleProgressDocuments] = useState<Record<string, number>>({});
  const [expandedProgressTargetId, setExpandedProgressTargetId] = useState('');
  const [newDestinationInstanceId, setNewDestinationInstanceId] = useState('');
  const [destinationSearch, setDestinationSearch] = useState('');
  const [destinationPageIndex, setDestinationPageIndex] = useState(0);
  const [expandedDestinationId, setExpandedDestinationId] = useState<string | null>(null);
  const destinationFolders = useDashboardDestinationFolders(Boolean(vaultStatus?.unlocked));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const submitGuardRef = useRef(false);
  const retryGuardRef = useRef(new Set<string>());
  const sourceConnectionRequestRef = useRef(0);
  const dashboardRequestRef = useRef(0);
  const destinationRequestRef = useRef<Record<string, number>>({});
  const sourceConnectionAbortRef = useRef<AbortController | null>(null);
  const sourceConnectionContextRef = useRef({ instanceId: draft.sourceId, step: draft.step, jobId: draft.jobId, planId: draft.planId || returnPlanId, unlocked: Boolean(vaultStatus?.unlocked) });
  sourceConnectionContextRef.current = { instanceId: draft.sourceId, step: draft.step, jobId: draft.jobId, planId: draft.planId || returnPlanId, unlocked: Boolean(vaultStatus?.unlocked) };
  const dashboardAbortRef = useRef<AbortController | null>(null);
  const dashboardHydrationKeyRef = useRef('');
  const dashboardScope = JSON.stringify([draft.sourceId, draft.sourceConnectionId]);
  const dashboardScopeRef = useRef(dashboardScope);
  dashboardScopeRef.current = dashboardScope;
  const verifiedDocumentsScopeRef = useRef('');
  const selectedScopeRef = useRef({ ids: draft.selectedDocumentIds, destinations: draft.destinations.length });
  selectedScopeRef.current = { ids: draft.selectedDocumentIds, destinations: draft.destinations.length };
  const destinationAbortRef = useRef<Record<string, AbortController>>({});
  const planAbortRef = useRef<AbortController | null>(null);
  const planRequestRef = useRef(0);
  const planIdentityRef = useRef(draft.requestId);
  const planRestoreKeyRef = useRef('');
  const jobRef = useRef<MigrationJob | null>(null);
  const announcedProgressRef = useRef<{ jobId: string; values: Map<string, string> }>({
    jobId: '',
    values: new Map(),
  });

  const sourceInstances = useMemo(
    () => sortSavedInstances(instances.filter(instanceSupportsSource)),
    [instances],
  );
  const destinationInstances = useMemo(
    () => sortSavedInstances(instances.filter(instanceSupportsDestination)),
    [instances],
  );
  const sourceInstance = instances.find((instance) => instance.id === draft.sourceId);
  const currentPlan = deploymentPlan && deploymentPlan.id === draft.planId ? deploymentPlan : null;
  const sourcePlanRestoring = Boolean((draft.planId || returnPlanId) && !currentPlan);
  const sourceCatalog = sourceConnectionCatalog.instanceId === draft.sourceId ? sourceConnectionCatalog : EMPTY_SOURCE_CONNECTION_CATALOG;
  const sourceConnections = sourceCatalog.connections;
  const sourceConnectionOptions = buildConnectionComboBoxOptions(sourceConnections);
  if (draft.sourceConnectionId && !sourceConnectionOptions.some((option) => option.value === draft.sourceConnectionId)) {
    sourceConnectionOptions.unshift({ value: draft.sourceConnectionId, label: `Selected connection (${draft.sourceConnectionId})`, subtitle: sourceCatalog.loaded ? 'Saved selection — not in the returned catalog' : 'Saved selection — connection catalog not loaded' });
  }
  const readyTargetIds = checkingReadiness || dashboardReadinessIsStale(currentPlan) ? [] : currentPlan?.targets.filter((row) => row.status === 'ready' && !row.deploymentJobId).map((row) => row.targetId) || [];
  const selectedReadyTargetIds = (draft.selectedTargetIds || []).filter((id) => readyTargetIds.includes(id));
  const heldTargetCount = draft.destinations.length - selectedReadyTargetIds.length;
  const selectedDocumentIds = useMemo(() => new Set(draft.selectedDocumentIds), [draft.selectedDocumentIds]);
  const filteredDocuments = useMemo(() => {
    if (verifiedDocumentsScopeRef.current !== dashboardScope) return [];
    const query = search.trim().toLocaleLowerCase('en-US');
    const sorted = sortDocuments(documents);
    return query ? sorted.filter((document) => documentSearchText(document).includes(query)) : sorted;
  }, [dashboardScope, documents, search]);
  const visibleDocuments = useMemo(
    () => filteredDocuments.slice(0, visibleDashboardCount),
    [filteredDocuments, visibleDashboardCount],
  );
  const sourceLabelByDocumentId = useMemo(() => Object.fromEntries(documents.flatMap((document) => {
    const ids = new Set([document.id, document.identifier].filter((value): value is string => Boolean(value)));
    return [...ids].map((id) => [id, document.name]);
  })), [documents]);
  const progress = useMemo(() => job ? dashboardSafeCopyJobProgress(job, {
    defaultDocumentLimit: 0,
    sourceLabelByDocumentId,
    documentLimitByTarget: expandedProgressTargetId ? {
      [expandedProgressTargetId]: visibleProgressDocuments[expandedProgressTargetId] || PROGRESS_DOCUMENT_PAGE_SIZE,
    } : {},
  }) : [], [expandedProgressTargetId, job, sourceLabelByDocumentId, visibleProgressDocuments]);
  const strictlyVerifiedMove = Boolean(
    job
    && job.status === 'succeeded'
    && (job.targets?.length || 0) > 0
    && progress.length === job.targets?.length
    && progress.every((target) => target.phase === 'succeeded'),
  );
  const globalReconciliationHold = job?.details?.safeCopyExecutionState === 'reconciliation_required'
    || progress.some((target) => target.blocksNewScope);
  const globalEvidenceHold = progress.some((target) => target.globalHold);
  const unresolvedWriteEvidence = globalReconciliationHold || progress.some((target) => (
    target.phase === 'copying'
    || target.phase === 'verifying'
    || target.phase === 'reconciliation_required'
  ));
  const canStartAnotherMove = strictlyVerifiedMove || Boolean(
    job
    && isDashboardSafeCopyTerminal(job.status)
    && !unresolvedWriteEvidence,
  );
  const displayedJobStatus = globalReconciliationHold
    ? { label: 'Reconciliation required', chip: 'warning' }
    : globalEvidenceHold
    ? { label: 'Verification evidence incomplete', chip: 'warning' }
    : job?.status === 'succeeded' && !strictlyVerifiedMove
    ? { label: 'Verification evidence incomplete', chip: 'warning' }
    : job ? { label: jobStatusLabel(job), chip: jobStatusChip(job) } : undefined;
  const instanceById = useMemo(
    () => new Map(instances.map((instance) => [instance.id, instance])),
    [instances],
  );
  const destinationRows = draft.destinations.map((destination, destinationIndex) => {
    const instance = instanceById.get(destination.instanceId);
    const catalog = destinationCatalogs[destination.instanceId] || EMPTY_DESTINATION_CATALOG;
    const connectionLabel = catalog.connections.find((row) => row.id === destination.connectionId)?.name || destination.connectionId || 'Choose connection';
    const model = catalog.models.find((row) => row.id === destination.modelId);
    const modelLabel = model ? modelDisplayLabel(model) : destination.modelId || 'Choose model';
    const folderLabel = destinationFolderLabel(destination.folderPath, destination.folderId);
    return { destination, destinationIndex, instance, catalog, connectionLabel, modelLabel, folderLabel };
  });
  const filteredDestinations = destinationRows.filter((row) => [row.instance?.label, row.instance?.baseUrl, row.connectionLabel, row.modelLabel, row.folderLabel]
    .some((value) => value?.toLocaleLowerCase('en-US').includes(destinationSearch.trim().toLocaleLowerCase('en-US'))));
  const destinationWindow = destinationPage(filteredDestinations, destinationPageIndex);
  const activeDestinationId = expandedDestinationId ?? destinationWindow.rows[0]?.destination.targetId;
  const activeDestinationInstanceId = draft.destinations.find((row) => row.targetId === activeDestinationId)?.instanceId;

  useEffect(() => {
    setVisibleProgressDocuments({});
    setExpandedProgressTargetId('');
  }, [job?.id]);

  useEffect(() => {
    if (!job) {
      announcedProgressRef.current = { jobId: '', values: new Map() };
      setProgressAnnouncement('');
      return;
    }
    const next = new Map<string, string>();
    for (const target of progress) {
      next.set(`target:${target.targetId}`, target.phase);
      for (const document of target.documents) {
        next.set(`document:${target.targetId}:${document.sourceDocumentId}`, document.phase);
      }
    }
    const previous = announcedProgressRef.current;
    if (previous.jobId !== job.id) {
      announcedProgressRef.current = { jobId: job.id, values: next };
      setProgressAnnouncement('');
      return;
    }
    const changes: string[] = [];
    for (const target of progress) {
      const targetKey = `target:${target.targetId}`;
      if (previous.values.get(targetKey) !== undefined && previous.values.get(targetKey) !== target.phase) {
        changes.push(`${target.destinationLabel}: ${TARGET_PHASE_LABELS[target.phase]}.`);
      }
      for (const document of target.documents) {
        const documentKey = `document:${target.targetId}:${document.sourceDocumentId}`;
        if (previous.values.get(documentKey) !== undefined && previous.values.get(documentKey) !== document.phase) {
          changes.push(`${target.destinationLabel}, dashboard ${document.chosenTargetName || document.sourceLabel}: ${DOCUMENT_PHASE_LABELS[document.phase]}.`);
        }
      }
    }
    announcedProgressRef.current = { jobId: job.id, values: next };
    if (changes.length > 0) {
      const visible = changes.slice(0, 4);
      const remaining = changes.length - visible.length;
      setProgressAnnouncement(`${visible.join(' ')}${remaining > 0 ? ` ${remaining} more status changes.` : ''}`);
    }
  }, [job, progress]);

  useEffect(() => {
    writeDashboardSafeCopyDraft(draft);
  }, [draft]);

  useEffect(() => {
    if (planIdentityRef.current === draft.requestId) return;
    planIdentityRef.current = draft.requestId;
    if (draft.planId) return;
    planAbortRef.current?.abort();
    planRequestRef.current += 1;
    setCheckingReadiness(false);
    setReadinessStartedAt(null);
    setReadinessProgress(null);
    setSavingPlanTargetId('');
    setDeploymentPlan(null);
    planRestoreKeyRef.current = '';
    if (returnPlanId) navigate(location.pathname, { replace: true });
  }, [draft.requestId, draft.planId, returnPlanId, location.pathname, navigate]);

  useEffect(() => {
    const planId = returnPlanId || draft.planId;
    if (!planId || !vaultStatus?.unlocked || planRestoreKeyRef.current === planId) return;
    const controller = new AbortController();
    planAbortRef.current?.abort();
    planAbortRef.current = controller;
    const request = ++planRequestRef.current;
    planRestoreKeyRef.current = planId;
    let completed = false;
    setCheckingReadiness(true);
    setError('');
    void (async () => {
      const restored = await getDashboardDeploymentPlan(planId, controller.signal);
      if (controller.signal.aborted || planRequestRef.current !== request) return;
      if (restored.plan.id !== planId) throw new Error('The server returned a different deployment plan. Nothing was restored.');
      // Opening or returning from a review is not evidence that anything changed.
      // Restore the saved plan only; readiness is rechecked by an explicit action.
      const response = restored;
      if (controller.signal.aborted || planRequestRef.current !== request) return;
      completed = true;
      if (!draft.jobId || draft.planId !== response.plan.id) {
        jobRef.current = null;
        setJob(null);
      }
      setDeploymentPlan(response.plan);
      dispatchDraft({ type: 'restore_plan', plan: response.plan });
      if (!draft.jobId && draft.deploymentRequestId) {
        const history = await listMigrationJobs();
        if (controller.signal.aborted || planRequestRef.current !== request) return;
        const matches = history.jobs.filter((candidate) => isDashboardSafeCopyJobForRequest(candidate, draft.deploymentRequestId!)
          && sameDocumentScope(candidate.documentIds, response.plan.intent.source.documentIds)
          && (!draft.selectedTargetIds?.length || sameDocumentScope((candidate.targets || []).map((row) => row.id), draft.selectedTargetIds)));
        if (matches.length === 1) dispatchDraft({ type: 'attach_job', jobId: matches[0].id, requestId: draft.deploymentRequestId });
      }
    })().catch((loadError) => {
      if (!controller.signal.aborted && planRequestRef.current === request) setError(loadError instanceof Error ? loadError.message : 'Could not restore this deployment plan.');
    }).finally(() => {
      if (!controller.signal.aborted && planRequestRef.current === request) setCheckingReadiness(false);
    });
    return () => {
      controller.abort();
      if (!completed && planRestoreKeyRef.current === planId) planRestoreKeyRef.current = '';
    };
  // Reopening a plan restores server-owned scope, without polling readiness.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnPlanId, vaultStatus?.unlocked]);

  useEffect(() => {
    // headingRef is shared by the three per-step headings, so a re-render
    // between this effect and the frame callback can replace the node the focus
    // was applied to and silently drop it — and this effect will not run again,
    // leaving the step change unannounced. Confirm the focus actually landed and
    // retry on the next frames rather than firing once and hoping.
    const focusHeading = () => {
      const node = headingRef.current;
      if (!node) return false;
      if (document.activeElement !== node) node.focus();
      return document.activeElement === node;
    };
    if (focusHeading()) return;
    let frame = window.requestAnimationFrame(() => {
      if (focusHeading()) return;
      frame = window.requestAnimationFrame(() => {
        focusHeading();
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draft.jobId, draft.step, loading]);

  useEffect(() => {
    let active = true;
    void Promise.all([getVaultStatus(), listSavedInstances()])
      .then(async ([status, saved]) => {
        if (!active) return;
        const nextInstances = sortSavedInstances(saved.instances);
        setVaultStatus(status);
        setInstances(nextInstances);
        if (draft.jobId || draft.planId || returnPlanId) return;
        if (status.unlocked) {
          try {
            const history = await listMigrationJobs();
            if (!active) return;
            const matches = history.jobs.filter((candidate) => (
              isDashboardSafeCopyJobForRequest(candidate, draft.deploymentRequestId || draft.requestId)
            ));
            if (matches.length === 1) {
              const recovered = { ...draft, step: 2 as const, jobId: matches[0].id };
              writeDashboardSafeCopyDraft(recovered);
              dispatchDraft({ type: 'attach_job', jobId: matches[0].id, requestId: draft.deploymentRequestId || draft.requestId });
              setMessage('Recovered the prior dashboard move from its durable request identity.');
              return;
            }
            if (matches.length > 1) {
              setError('More than one job matched the saved move identity, so none was opened. Choose dashboards to start a new move.');
            }
          } catch {
            if (active) setMessage('Prior move recovery is temporarily unavailable. You can still start a new move.');
          }
        }
        const eligibleSources = nextInstances.filter(instanceSupportsSource);
        const sourceStillEligible = eligibleSources.some((instance) => instance.id === draft.sourceId);
        const activeSourceId = connection.instanceId
          && eligibleSources.some((instance) => instance.id === connection.instanceId)
          ? connection.instanceId
          : '';
        const nextSourceId = sourceStillEligible
          ? draft.sourceId
          : activeSourceId || (eligibleSources.length === 1 ? eligibleSources[0].id : '');
        if (nextSourceId !== draft.sourceId) {
          dispatchDraft({
            type: 'choose_source',
            sourceId: nextSourceId,
            requestId: newDashboardSafeCopyRequestId(),
          });
        }
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load saved Omni instances.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  // Initial boot intentionally uses the identity-only restored draft snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    sourceConnectionRequestRef.current += 1;
    dashboardRequestRef.current += 1;
    sourceConnectionAbortRef.current?.abort();
    dashboardAbortRef.current?.abort();
    planAbortRef.current?.abort();
    planRequestRef.current += 1;
    Object.entries(destinationAbortRef.current).forEach(([instanceId, controller]) => {
      destinationRequestRef.current[instanceId] = (destinationRequestRef.current[instanceId] || 0) + 1;
      controller.abort();
    });
  }, []);

  const loadSourceConnections = useCallback(async (instanceId: string) => {
    const context = sourceConnectionContextRef.current;
    if (!instanceId || context.instanceId !== instanceId || context.step !== 0 || context.jobId || !context.unlocked) return;
    sourceConnectionAbortRef.current?.abort();
    const controller = new AbortController();
    sourceConnectionAbortRef.current = controller;
    const request = sourceConnectionRequestRef.current + 1;
    sourceConnectionRequestRef.current = request;
    const isCurrent = () => !controller.signal.aborted && sourceConnectionRequestRef.current === request
      && sourceConnectionContextRef.current.instanceId === instanceId && sourceConnectionContextRef.current.step === 0
      && !sourceConnectionContextRef.current.jobId && sourceConnectionContextRef.current.unlocked;
    setSourceConnectionCatalog((current) => ({ ...(current.instanceId === instanceId ? current : EMPTY_SOURCE_CONNECTION_CATALOG), instanceId, loading: true, error: '' }));
    try {
      const response = await listModelMigratorConnections(instanceId, controller.signal);
      if (!isCurrent()) return;
      const connections = response.connections.filter((row) => !row.deletedAt);
      setSourceConnectionCatalog({ instanceId, connections, loading: false, loaded: true, error: '' });
      // A background picker catalog must never rewrite a restored plan's source binding.
      if (!sourceConnectionContextRef.current.planId) {
        dispatchDraft({
          type: 'resolve_source_connections',
          sourceId: instanceId,
          connectionIds: connections.map((row) => row.id),
          requestId: newDashboardSafeCopyRequestId(),
        });
      }
    } catch (loadError) {
      if (isCurrent()) {
        setSourceConnectionCatalog((current) => current.instanceId === instanceId ? {
          ...current, loading: false,
          error: sourceConnectionLoadError(loadError),
        } : current);
      }
    } finally {
      if (isCurrent()) setSourceConnectionCatalog((current) => current.instanceId === instanceId ? { ...current, loading: false } : current);
    }
  }, []);

  useEffect(() => {
    if (draft.jobId || draft.step !== 0 || !draft.sourceId || !vaultStatus?.unlocked || sourcePlanRestoring) return;
    void loadSourceConnections(draft.sourceId);
    return () => {
      sourceConnectionAbortRef.current?.abort();
      sourceConnectionRequestRef.current += 1;
      setSourceConnectionCatalog((current) => current.loading ? { ...current, loading: false } : current);
    };
  }, [draft.jobId, draft.sourceId, draft.step, loadSourceConnections, sourcePlanRestoring, vaultStatus?.unlocked]);

  // Changing the source cancels work; it never starts a whole-instance scan.
  useEffect(() => {
    dashboardAbortRef.current?.abort();
    dashboardRequestRef.current += 1;
    dashboardHydrationKeyRef.current = '';
    verifiedDocumentsScopeRef.current = '';
    setDocuments([]);
    setDashboardInventory(null);
    setLoadingDashboards(false);
    setLoadingDashboardLookup(false);
    setDashboardReference('');
    setDashboardBrowseProgress(null);
    setDashboardBrowseStartedAt(null);
    setDashboardBrowseElapsed(0);
    setVisibleDashboardCount(DASHBOARD_PAGE_SIZE);
  }, [dashboardScope]);

  useEffect(() => {
    if (!loadingDashboards || dashboardBrowseStartedAt === null) return;
    // Display elapsed time only. No network polling or synthetic page progress.
    const updateElapsed = () => setDashboardBrowseElapsed(Math.floor((Date.now() - dashboardBrowseStartedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [dashboardBrowseStartedAt, loadingDashboards]);

  const loadDashboards = useCallback(async (selectedIds?: string[], forceRefresh = false) => {
    if (!draft.sourceId || !draft.sourceConnectionId) return;
    dashboardAbortRef.current?.abort();
    const controller = new AbortController();
    dashboardAbortRef.current = controller;
    const request = dashboardRequestRef.current + 1;
    dashboardRequestRef.current = request;
    const scope = JSON.stringify([draft.sourceId, draft.sourceConnectionId]);
    const isCurrent = () => !controller.signal.aborted && dashboardRequestRef.current === request && dashboardScopeRef.current === scope;
    const browsing = !selectedIds;
    setLoadingDashboards(browsing);
    setLoadingDashboardLookup(!browsing);
    if (browsing) {
      setDashboardBrowseProgress(null);
      setDashboardBrowseStartedAt(Date.now());
      setDashboardBrowseElapsed(0);
    }
    setError('');
    setMessage('');
    try {
      const options = {
        connectionId: draft.sourceConnectionId,
        allFolders: true,
        includeModelDetails: false,
        forceRefresh,
        signal: controller.signal,
      };
      const response = selectedIds
        ? await listInstanceDocuments(draft.sourceId, { ...options, documentIds: selectedIds })
        : await streamInstanceDocuments(draft.sourceId, { ...options, onProgress: (progress) => { if (isCurrent()) setDashboardBrowseProgress(progress); } });
      if (!isCurrent()) return;
      if (!response.inventory.complete || response.inventory.scope !== (browsing ? 'credential' : 'explicit_documents')) {
        throw new Error('The dashboard response did not confirm the requested scope. No partial results were added.');
      }
      const verified = mergeVerifiedDashboardDocuments([], response.documents, draft.sourceConnectionId);
      if (selectedIds && !hasVerifiedDashboardSelection(verified, selectedIds, draft.sourceConnectionId)) throw new Error('Some saved dashboard selections could not be verified. Add them by link or browse to review the source.');
      verifiedDocumentsScopeRef.current = scope;
      setDocuments((current) => mergeVerifiedDashboardDocuments(current, verified, draft.sourceConnectionId));
      if (browsing) setDashboardInventory(response.inventory);
    } catch (loadError) {
      if (controller.signal.aborted) return;
      if (isCurrent()) {
        setError(loadError instanceof Error ? loadError.message : 'Could not finish loading dashboards. Previously verified choices were kept.');
      }
    } finally {
      if (isCurrent()) {
        setLoadingDashboards(false);
        setLoadingDashboardLookup(false);
      }
    }
  }, [draft.sourceConnectionId, draft.sourceId]);

  useEffect(() => {
    if (draft.jobId || !draft.sourceId || !draft.sourceConnectionId || loadingDashboards || loadingDashboardLookup) return;
    const known = new Set(documents.map(sourceDocumentId));
    const missing = draft.selectedDocumentIds.filter((id) => !known.has(id));
    if (missing.length === 0) return;
    const key = JSON.stringify([dashboardScope, missing]);
    if (dashboardHydrationKeyRef.current === key) return;
    dashboardHydrationKeyRef.current = key;
    // Restored plans revalidate their exact IDs, not the entire source catalog.
    void loadDashboards(missing);
  }, [dashboardScope, documents, draft.jobId, draft.selectedDocumentIds, draft.sourceConnectionId, draft.sourceId, loadDashboards, loadingDashboardLookup, loadingDashboards]);

  function cancelDashboardLoading() {
    dashboardAbortRef.current?.abort();
    dashboardRequestRef.current += 1;
    setLoadingDashboards(false);
    setLoadingDashboardLookup(false);
    setMessage('Dashboard loading canceled. Previously verified dashboards and selections were kept; no partial browse results were added.');
  }

  async function addDashboardByReference() {
    const reference = dashboardReference.trim();
    if (!reference || !draft.sourceId || !draft.sourceConnectionId || loadingDashboards || loadingDashboardLookup) return;
    dashboardAbortRef.current?.abort();
    const controller = new AbortController();
    dashboardAbortRef.current = controller;
    const request = ++dashboardRequestRef.current;
    const scope = dashboardScope;
    const isCurrent = () => !controller.signal.aborted && dashboardRequestRef.current === request && dashboardScopeRef.current === scope;
    setLoadingDashboardLookup(true);
    setError('');
    setMessage('');
    try {
      const response = await lookupInstanceDocument(draft.sourceId, { connectionId: draft.sourceConnectionId, reference, signal: controller.signal });
      if (!isCurrent()) return;
      const verified = mergeVerifiedDashboardDocuments([], [response.document], draft.sourceConnectionId);
      verifiedDocumentsScopeRef.current = scope;
      setDocuments((current) => mergeVerifiedDashboardDocuments(current, verified, draft.sourceConnectionId));
      const documentId = sourceDocumentId(response.document);
      const selected = selectedScopeRef.current;
      const limit = selected.destinations ? Math.min(MAX_SELECTED_DASHBOARDS, Math.floor(DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS / selected.destinations)) : MAX_SELECTED_DASHBOARDS;
      if (!selected.ids.includes(documentId)) {
        if (selected.ids.length >= limit) setMessage(`Dashboard verified, but the ${limit}-dashboard selection limit has been reached.`);
        else {
          dispatchDraft({ type: 'toggle_document', documentId, limit, requestId: newDashboardSafeCopyRequestId() });
          setMessage('Dashboard verified and selected. You can add another link or continue to destinations.');
        }
      } else setMessage('This dashboard is already verified and selected.');
      setDashboardReference('');
    } catch (lookupError) {
      if (isCurrent()) setError(lookupError instanceof Error ? lookupError.message : 'The dashboard could not be verified. Nothing was added.');
    } finally {
      if (isCurrent()) setLoadingDashboardLookup(false);
    }
  }

  const loadDestinationCatalog = useCallback(async (instanceId: string) => {
    const instance = instances.find((row) => row.id === instanceId);
    if (!instance) return;
    const request = (destinationRequestRef.current[instanceId] || 0) + 1;
    destinationRequestRef.current[instanceId] = request;
    destinationAbortRef.current[instanceId]?.abort();
    const controller = new AbortController();
    destinationAbortRef.current[instanceId] = controller;
    setDestinationCatalogs((current) => ({
      ...current,
      [instanceId]: { ...(current[instanceId] || EMPTY_DESTINATION_CATALOG), loading: true, error: '' },
    }));
    try {
      const [connectionResponse, modelResponse] = await Promise.all([
        listModelMigratorConnections(instanceId, controller.signal),
        listModelMigratorModels(instanceId, { signal: controller.signal }),
      ]);
      if (destinationRequestRef.current[instanceId] !== request) return;
      const catalog: DestinationCatalog = {
        connections: connectionResponse.connections.filter((row) => !row.deletedAt),
        models: sortModels(modelResponse.models.filter((row) => !row.deletedAt)),
        loading: false,
        loaded: true,
        error: '',
      };
      setDestinationCatalogs((current) => ({ ...current, [instanceId]: catalog }));
    } catch (loadError) {
      if (controller.signal.aborted) return;
      if (destinationRequestRef.current[instanceId] !== request) return;
      setDestinationCatalogs((current) => ({
        ...current,
        [instanceId]: {
          ...(current[instanceId] || EMPTY_DESTINATION_CATALOG),
          loading: false,
          loaded: false,
          error: loadError instanceof Error ? loadError.message : 'Could not load destination connections and models.',
        },
      }));
    }
  }, [instances]);

  useEffect(() => {
    if (draft.jobId || draft.step !== 1 || !activeDestinationInstanceId) return;
    const catalog = destinationCatalogs[activeDestinationInstanceId];
    if (!catalog?.loading && !catalog?.loaded && !catalog?.error) void loadDestinationCatalog(activeDestinationInstanceId);
  }, [destinationCatalogs, activeDestinationInstanceId, draft.jobId, draft.step, loadDestinationCatalog]);

  useEffect(() => {
    if (draft.jobId || draft.planId) return;
    for (const destination of draft.destinations) {
      const catalog = destinationCatalogs[destination.instanceId];
      const instance = instances.find((row) => row.id === destination.instanceId);
      if (!catalog?.loaded || !instance) continue;
      const resolution = resolveDashboardSafeCopyDestinationDefaults({ instance, connections: catalog.connections, models: catalog.models, current: destination });
      const modelId = destination.requiresModelChoice ? destination.modelId : resolution.modelId;
      if (!sameDestinationResolution(destination, resolution.connectionId, modelId)) {
        dispatchDraft({ type: 'update_destination', targetId: destination.targetId, patch: { connectionId: resolution.connectionId, modelId }, requestId: newDashboardSafeCopyRequestId() });
      }
    }
  }, [destinationCatalogs, draft.destinations, draft.jobId, draft.planId, instances]);

  useEffect(() => {
    const jobId = draft.jobId;
    if (!jobId || (draft.planId && !currentPlan)) return undefined;
    let active = true;
    let terminal = false;
    let rejected = false;
    let subscribed = false;
    let unsubscribe: () => void = () => {};
    const rejectRestoredJob = (reason: string) => {
      if (!active || rejected) return;
      rejected = true;
      const next = createDashboardSafeCopyDraft();
      writeDashboardSafeCopyDraft(next);
      jobRef.current = null;
      setJob(null);
      dispatchDraft({ type: 'reject_restored_job', draft: next });
      setError(reason);
      setMessage('Choose dashboards to start a new move. No stored migration scope was trusted.');
    };
    const applyJob = (next: MigrationJob): boolean => {
      if (!active || rejected) return false;
      if (next.id !== jobId || !isDashboardSafeCopyJobForRequest(next, draft.requestId)
        || (currentPlan && !sameDocumentScope(next.documentIds, currentPlan.intent.source.documentIds))) {
        rejectRestoredJob('The saved job did not match this safe dashboard move and was not opened.');
        return false;
      }
      const current = jobRef.current;
      if (current) {
        if (!shouldApplyDashboardSafeCopyJobSnapshot(current, next)) return false;
      }
      jobRef.current = next;
      setJob(next);
      terminal = isDashboardSafeCopyTerminal(next.status);
      if (terminal) {
        window.clearInterval(refreshTimer);
        unsubscribe();
        subscribed = false;
      }
      return true;
    };
    const refresh = async () => {
      if (!active || terminal || rejected) return;
      try {
        const response = await getMigrationJob(jobId);
        if (!applyJob(response.job) || terminal || subscribed) return;
        subscribed = true;
        unsubscribe = subscribeMigrationJob(jobId, (event) => {
          if (event.type === 'snapshot') applyJob(event.job);
          else if (event.type === 'job' && event.job) applyJob(event.job);
          else if (event.type === 'item') void refresh();
        }, () => {
          void refresh();
        });
      } catch (loadError) {
        if (!active) return;
        if (loadError instanceof ApiError && loadError.status === 404) {
          rejectRestoredJob('The saved dashboard move no longer exists. Its local recovery identity was cleared.');
          return;
        }
        setError(loadError instanceof Error ? loadError.message : 'Could not refresh migration progress.');
      }
    };
    const refreshTimer = window.setInterval(() => void refresh(), TRACKING_REFRESH_MS);
    void refresh();
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(refreshTimer);
    };
  }, [draft.jobId, draft.requestId, draft.planId, currentPlan, trackingRevision]);

  function chooseSource(instanceId: string) {
    // Re-selecting the instance that is already chosen must not disturb an
    // in-flight load. This function invalidates the pending source-connection
    // request and clears the list, but the reload is driven by an effect keyed
    // on draft.sourceId — so when the id has not changed the effect cannot
    // re-fire, the arriving response is dropped by the stale-request guard, and
    // the connection picker stays permanently empty with no error shown.
    if (instanceId === draft.sourceId) return;
    sourceConnectionAbortRef.current?.abort();
    dashboardAbortRef.current?.abort();
    sourceConnectionRequestRef.current += 1;
    dashboardRequestRef.current += 1;
    setSourceConnectionCatalog(EMPTY_SOURCE_CONNECTION_CATALOG);
    setDocuments([]);
    setDashboardInventory(null);
    setVisibleDashboardCount(DASHBOARD_PAGE_SIZE);
    dispatchDraft({
      type: 'choose_source',
      sourceId: instanceId,
      requestId: newDashboardSafeCopyRequestId(),
    });
    setError('');
  }

  function chooseSourceConnection(connectionId: string) {
    if (connectionId === draft.sourceConnectionId) return;
    dashboardAbortRef.current?.abort();
    dashboardRequestRef.current += 1;
    setDocuments([]);
    setDashboardInventory(null);
    setVisibleDashboardCount(DASHBOARD_PAGE_SIZE);
    dispatchDraft({
      type: 'choose_source_connection',
      connectionId,
      requestId: newDashboardSafeCopyRequestId(),
    });
    setError('');
  }

  function toggleDocument(documentId: string) {
    if (verifiedDocumentsScopeRef.current !== dashboardScope || !hasVerifiedDashboardSelection(documents, [documentId], draft.sourceConnectionId)) return;
    if (!selectedDocumentIds.has(documentId) && draft.selectedDocumentIds.length >= MAX_SELECTED_DASHBOARDS) {
      setError(`A move supports at most ${MAX_SELECTED_DASHBOARDS} dashboards.`);
      return;
    }
    if (
      !selectedDocumentIds.has(documentId)
      && draft.destinations.length > 0
      && (draft.selectedDocumentIds.length + 1) * draft.destinations.length > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS
    ) {
      setError(`A move supports at most ${DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS.toLocaleString()} dashboard-destination copies.`);
      return;
    }
    dispatchDraft({
      type: 'toggle_document',
      documentId,
      limit: MAX_SELECTED_DASHBOARDS,
      requestId: newDashboardSafeCopyRequestId(),
    });
  }

  function selectAllMatching() {
    const ids = filteredDocuments.map(sourceDocumentId);
    const documentLimit = draft.destinations.length > 0
      ? Math.min(MAX_SELECTED_DASHBOARDS, Math.floor(DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS / draft.destinations.length))
      : MAX_SELECTED_DASHBOARDS;
    const bounded = [...new Set([...draft.selectedDocumentIds, ...ids])].slice(0, documentLimit).sort();
    dispatchDraft({
      type: 'patch_plan',
      patch: { selectedDocumentIds: bounded },
      requestId: newDashboardSafeCopyRequestId(),
    });
    if (bounded.length < new Set([...draft.selectedDocumentIds, ...ids]).size) {
      setMessage(`Selected the first ${documentLimit} dashboards within the safe copy limit.`);
    }
  }

  function addDestination(instanceId = '') {
    if (draft.destinations.length >= MAX_DESTINATIONS) {
      setError(`A move supports at most ${MAX_DESTINATIONS} destinations.`);
      return;
    }
    if (
      draft.selectedDocumentIds.length * (draft.destinations.length + 1) > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS
    ) {
      setError(`A move supports at most ${DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS.toLocaleString()} dashboard-destination copies.`);
      return;
    }
    const chosenInstanceId = instanceId || (destinationInstances.length === 1 ? destinationInstances[0].id : '');
    const instance = instanceById.get(chosenInstanceId);
    const targetId = newDashboardSafeCopyRequestId();
    dispatchDraft({
      type: 'add_destination',
      destination: { targetId, instanceId: chosenInstanceId, connectionId: '', modelId: '', folderId: instance?.defaultFolderId || '', folderPath: instance?.defaultFolderPath || '' },
      limit: MAX_DESTINATIONS,
      requestId: newDashboardSafeCopyRequestId(),
    });
    setExpandedDestinationId(targetId);
    setDestinationSearch('');
    setDestinationPageIndex(Math.floor(draft.destinations.length / DESTINATIONS_PER_PAGE));
    setNewDestinationInstanceId('');
    setError('');
  }

  function updateDestination(targetId: string, patch: Partial<Omit<DashboardSafeCopyDestinationDraft, 'targetId'>>) {
    dispatchDraft({ type: 'update_destination', targetId, patch, requestId: newDashboardSafeCopyRequestId() });
    setError('');
  }

  function setDestinationInstance(targetId: string, instanceId: string) {
    const instance = instanceById.get(instanceId);
    updateDestination(targetId, { instanceId, connectionId: '', modelId: '', requiresModelChoice: false, folderId: instance?.defaultFolderId || '', folderPath: instance?.defaultFolderPath || '' });
  }

  function setDestinationConnection(targetId: string, connectionId: string) {
    const destination = draft.destinations.find((row) => row.targetId === targetId);
    if (!destination) return;
    const instanceId = destination.instanceId;
    const catalog = destinationCatalogs[instanceId] || EMPTY_DESTINATION_CATALOG;
    const instance = instances.find((row) => row.id === instanceId);
    if (!instance) return;
    const resolution = resolveDashboardSafeCopyDestinationDefaults({
      instance,
      connections: catalog.connections,
      models: catalog.models,
      current: { connectionId, modelId: '' },
    });
    updateDestination(targetId, {
      connectionId: resolution.connectionId,
      modelId: resolution.modelId,
      requiresModelChoice: false,
    });
  }

  function setDestinationModel(targetId: string, modelId: string) {
    const destination = draft.destinations.find((row) => row.targetId === targetId);
    if (!destination) return;
    const instanceId = destination.instanceId;
    const catalog = destinationCatalogs[instanceId] || EMPTY_DESTINATION_CATALOG;
    const model = catalog.models.find((row) => row.id === modelId);
    updateDestination(targetId, {
      modelId,
      connectionId: model?.connectionId || destination.connectionId,
      requiresModelChoice: false,
    });
  }

  async function checkReadiness() {
    if (checkingReadiness || savingPlanTargetId || draft.jobId || submitting) return;
    planAbortRef.current?.abort();
    const controller = new AbortController();
    planAbortRef.current = controller;
    const request = ++planRequestRef.current;
    const identity = draft.requestId;
    setCheckingReadiness(true);
    setReadinessStartedAt(Date.now());
    setReadinessProgress(null);
    setDeploymentPlan(staleDashboardReadiness);
    setError('');
    setMessage('');
    const onProgress = (progress: DashboardReadinessProgressEvent) => {
      if (!controller.signal.aborted && request === planRequestRef.current && identity === planIdentityRef.current) setReadinessProgress(progress);
    };
    try {
      const restoringPlanId = !currentPlan ? draft.planId || returnPlanId : '';
      const response = currentPlan
        ? await recheckDashboardDeploymentPlan(currentPlan.id, controller.signal, onProgress)
        : restoringPlanId ? await recheckDashboardDeploymentPlan(restoringPlanId, controller.signal, onProgress)
        : await createDashboardDeploymentPlan(dashboardSafeCopyIntentFromDraft(draft, instances), controller.signal, onProgress);
      if (controller.signal.aborted || request !== planRequestRef.current || identity !== planIdentityRef.current) return;
      if ((currentPlan || restoringPlanId) ? response.plan.id !== (currentPlan?.id || restoringPlanId) : response.plan.intent.requestId !== identity) throw new Error('The readiness result did not match these dashboard choices. Recheck before deploying.');
      setDeploymentPlan(response.plan);
      planRestoreKeyRef.current = response.plan.id;
      dispatchDraft({ type: 'restore_plan', plan: response.plan });
      navigate(`${location.pathname}?planId=${encodeURIComponent(response.plan.id)}`, { replace: true });
    } catch (planError) {
      if (!controller.signal.aborted && request === planRequestRef.current) {
        setDeploymentPlan(staleDashboardReadiness);
        setError(planError instanceof Error ? planError.message : 'Could not verify deployment readiness.');
      }
    } finally {
      if (request === planRequestRef.current) {
        setCheckingReadiness(false);
        setReadinessStartedAt(null);
      }
    }
  }

  function cancelReadiness() {
    if (!checkingReadiness || readinessStartedAt === null) return;
    planAbortRef.current?.abort();
    planRequestRef.current += 1;
    setCheckingReadiness(false);
    setReadinessStartedAt(null);
    setDeploymentPlan(staleDashboardReadiness);
    setError('');
    setMessage('Readiness check canceled. Previous findings are stale and cannot authorize deployment. Choose Recheck readiness when you are ready.');
  }

  async function savePlanTargetChoices(update: DashboardDeploymentTargetUpdate) {
    if (!currentPlan || update.revision !== currentPlan.revision || checkingReadiness || savingPlanTargetId || submitting || draft.jobId) return;
    const target = currentPlan.targets.find((row) => row.targetId === update.targetId);
    if (!target || target.deploymentJobId || target.repairJobId) return;
    planAbortRef.current?.abort();
    const controller = new AbortController();
    planAbortRef.current = controller;
    const request = ++planRequestRef.current;
    const identity = draft.requestId;
    setSavingPlanTargetId(update.targetId);
    setError('');
    setMessage('');
    try {
      const response = await updateDashboardDeploymentPlan(currentPlan.id, update, controller.signal);
      if (controller.signal.aborted || request !== planRequestRef.current || identity !== planIdentityRef.current) return;
      if (response.plan.id !== currentPlan.id || response.plan.revision < update.revision || !response.plan.targets.some((row) => row.targetId === update.targetId)) throw new Error('The saved plan response did not match these choices. Reopen the plan before continuing.');
      setDeploymentPlan(response.plan);
      dispatchDraft({ type: 'restore_plan', plan: response.plan });
      setMessage('Plan choices saved. Finish reviewing any other choices, then select Recheck readiness. Saving a choice does not establish compatibility or safe staging access.');
    } catch (saveError) {
      if (!controller.signal.aborted && request === planRequestRef.current) setError(saveError instanceof Error ? saveError.message : 'The plan choices could not be saved.');
    } finally {
      if (request === planRequestRef.current) setSavingPlanTargetId('');
    }
  }

  function resolveInModelMigrator(targetId: string) {
    if (!currentPlan || checkingReadiness || savingPlanTargetId) return;
    writeDashboardSafeCopyDraft(draft);
    navigate('/models/migrate', { state: { version: 2, source: 'dashboard_deployment_plan', planId: currentPlan.id, targetId } });
  }

  async function returnToPlan() {
    if (!currentPlan || checkingReadiness) return;
    planAbortRef.current?.abort();
    const controller = new AbortController();
    planAbortRef.current = controller;
    const request = ++planRequestRef.current;
    setCheckingReadiness(true);
    setError('');
    try {
      const response = await getDashboardDeploymentPlan(currentPlan.id, controller.signal);
      if (controller.signal.aborted || request !== planRequestRef.current) return;
      if (response.plan.id !== currentPlan.id) throw new Error('The saved plan did not match this deployment.');
      const next = { ...createDashboardSafeCopyDraft(), planId: response.plan.id, requestId: response.plan.intent.requestId };
      dispatchDraft({ type: 'reset', draft: next });
      dispatchDraft({ type: 'restore_plan', plan: response.plan });
      setDeploymentPlan(response.plan);
      jobRef.current = null;
      setJob(null);
      setMessage('The plan is ready to review. Previously deployed destinations remain recorded.');
    } catch (planError) {
      if (!controller.signal.aborted && request === planRequestRef.current) setError(planError instanceof Error ? planError.message : 'Could not reopen the deployment plan.');
    } finally {
      if (request === planRequestRef.current) setCheckingReadiness(false);
    }
  }

  function goToStep(step: DashboardSafeCopyStep) {
    if (draft.jobId || checkingReadiness || savingPlanTargetId || topicRepairBusy) return;
    dispatchDraft({ type: 'set_step', step });
    setError('');
    setMessage('');
  }

  async function startMove() {
    if (submitGuardRef.current || submitting) return;
    if (!currentPlan || checkingReadiness || savingPlanTargetId || topicRepairBusy || selectedReadyTargetIds.length === 0) {
      setError('Check readiness and explicitly select at least one ready destination before deploying.');
      return;
    }
    if (draft.selectedDocumentIds.length * draft.destinations.length > DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS) {
      setError(`Reduce the move to ${DASHBOARD_SAFE_COPY_MAX_MATRIX_CELLS.toLocaleString()} dashboard-destination copies or fewer.`);
      return;
    }
    submitGuardRef.current = true;
    setSubmitting(true);
    setError('');
    setMessage('Starting the selected ready destinations...');
    const deploymentRequestId = draft.deploymentRequestId || newDashboardSafeCopyRequestId();
    const requestDraft = { ...draft, step: 3 as const, deploymentRequestId };
    dispatchDraft({ type: 'prepare_deployment', deploymentRequestId });
    writeDashboardSafeCopyDraft(requestDraft);
    try {
      const response = await deployDashboardDeploymentPlan(currentPlan.id, currentPlan.revision, selectedReadyTargetIds, deploymentRequestId);
      if (!isDashboardSafeCopyJobForRequest(response.job, deploymentRequestId)
        || !sameDocumentScope(response.job.documentIds, currentPlan.intent.source.documentIds)
        || !sameDocumentScope((response.job.targets || []).map((row) => row.id), selectedReadyTargetIds)) {
        throw new Error('The server returned a job that did not match this safe dashboard move. Nothing was attached locally.');
      }
      const attachedDraft = { ...requestDraft, requestId: deploymentRequestId, jobId: response.job.id };
      writeDashboardSafeCopyDraft(attachedDraft);
      const current = jobRef.current;
      if (!current || shouldApplyDashboardSafeCopyJobSnapshot(current, response.job, { allowTerminalReopen: true })) {
        jobRef.current = response.job;
        setJob(response.job);
      }
      setDeploymentPlan(response.plan);
      dispatchDraft({ type: 'attach_job', jobId: response.job.id, requestId: deploymentRequestId });
      setMessage('Deployment started. You can leave this page and return to the same job.');
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Could not start the dashboard move.');
      setMessage('');
    } finally {
      submitGuardRef.current = false;
      setSubmitting(false);
    }
  }

  async function retryTarget(targetId: string) {
    if (!job || retryGuardRef.current.has(targetId)) return;
    retryGuardRef.current.add(targetId);
    setRetryingTargetIds((current) => [...current, targetId]);
    setError('');
    try {
      const response = await retryDashboardSafeCopyTarget(job.id, targetId, newDashboardSafeCopyRequestId());
      if (response.job.id !== job.id || !isDashboardSafeCopyJobForRequest(response.job, draft.requestId)) {
        throw new Error('The retry response did not match this safe dashboard move and was not applied.');
      }
      const current = jobRef.current;
      if (current && shouldApplyDashboardSafeCopyJobSnapshot(current, response.job, { allowTerminalReopen: true })) {
        jobRef.current = response.job;
        setJob(response.job);
      }
      setTrackingRevision((revision) => revision + 1);
      setMessage('Destination retry accepted. OmniKit will reconcile prior evidence before any new write.');
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : 'Could not retry this destination.');
    } finally {
      retryGuardRef.current.delete(targetId);
      setRetryingTargetIds((current) => current.filter((id) => id !== targetId));
    }
  }

  function chooseAnotherModel(targetId: string) {
    if (!job || !isDashboardSafeCopyJobForRequest(job, draft.requestId)) return;
    const action = {
      type: 'replan_target' as const,
      job,
      targetId,
      requestId: newDashboardSafeCopyRequestId(),
    };
    const next = dashboardSafeCopyDraftReducer(draft, action);
    if (next === draft) {
      setError('Only a destination that needs attention can be replanned with another model.');
      return;
    }
    writeDashboardSafeCopyDraft(next);
    dispatchDraft(action);
    jobRef.current = null;
    setJob(null);
    setDocuments([]);
    setDashboardInventory(null);
    setDestinationCatalogs({});
    setSourceConnectionCatalog(EMPTY_SOURCE_CONNECTION_CATALOG);
    setSearch('');
    setVisibleDashboardCount(DASHBOARD_PAGE_SIZE);
    setError('');
    setMessage('Only this destination will be retried. Successful destinations stay untouched. Choose a different model.');
  }

  function openModelMigrator(target: DashboardSafeCopyTargetProgress) {
    if (!job || !isDashboardSafeCopyJobForRequest(job, draft.requestId)) return;
    const persistedTarget = job.targets?.find((row) => row.id === target.targetId);
    try {
      const handoff = createDashboardSafeCopyModelMigratorHandoff({
        jobId: job.id,
        targetId: target.targetId,
        sourceInstanceId: job.sourceId,
        sourceConnectionId: job.sourceConnectionId || '',
        targetInstanceId: target.destinationId,
        targetConnectionId: persistedTarget?.targetConnectionId || '',
        targetModelId: target.modelId || '',
      });
      navigate('/models/migrate', { state: handoff });
    } catch (handoffError) {
      setError(handoffError instanceof Error
        ? handoffError.message
        : 'The Model Migrator repair scope could not be opened safely.');
    }
  }

  function startAnotherMove() {
    const next = createDashboardSafeCopyDraft();
    writeDashboardSafeCopyDraft(next);
    dispatchDraft({ type: 'reset', draft: next });
    jobRef.current = null;
    setJob(null);
    setDocuments([]);
    setDashboardInventory(null);
    setDestinationCatalogs({});
    setSourceConnectionCatalog(EMPTY_SOURCE_CONNECTION_CATALOG);
    setSearch('');
    setError('');
    setMessage('');
  }

  // Saved scope preserves navigation while its display catalog is unavailable;
  // it never changes server-owned readiness or authorizes deployment.
  const savedSourceScopeMatches = Boolean(currentPlan && draft.selectedDocumentIds.length > 0
    && currentPlan.intent.source.instanceId === draft.sourceId
    && currentPlan.intent.source.connectionId === draft.sourceConnectionId
    && sameDocumentScope(currentPlan.intent.source.documentIds, draft.selectedDocumentIds));
  const sourceReady = Boolean(
    draft.sourceId
    && draft.sourceConnectionId
    && (savedSourceScopeMatches || (verifiedDocumentsScopeRef.current === dashboardScope
      && hasVerifiedDashboardSelection(documents, draft.selectedDocumentIds, draft.sourceConnectionId))),
  );
  const destinationsReady = draft.destinations.length > 0
    && draft.destinations.every((row) => row.connectionId && row.modelId);

  if (loading && !job) {
    return (
      <div className="card flex items-center justify-center gap-2 p-8 text-content-secondary" role="status">
        <Loader2 size={18} className="motion-safe:animate-spin" aria-hidden="true" />
        Preparing the safe dashboard move...
      </div>
    );
  }

  if (!vaultStatus?.unlocked && !draft.jobId) {
    return (
      <>
        {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <SavedInstanceRequiredEmptyState toolName="Dashboard Migrator" />
      </>
    );
  }

  return (
    <div className="space-y-5">
      <nav className="card p-3" aria-label="Dashboard move steps">
        <ol className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          {STEP_LABELS.map((label, index) => {
            const step = index as DashboardSafeCopyStep;
            const enabled = !draft.jobId && !submitting && !checkingReadiness && !savingPlanTargetId && (
              step === 0
              || (step === 1 && sourceReady)
              || (step === 2 && sourceReady && destinationsReady)
              || (step === 3 && Boolean(currentPlan) && !checkingReadiness && selectedReadyTargetIds.length > 0)
            );
            return (
              <li key={label}>
                <button
                  type="button"
                  onClick={() => enabled && goToStep(step)}
                  disabled={!enabled}
                  aria-current={draft.step === step ? 'step' : undefined}
                  className={`w-full rounded-button px-3 py-2.5 text-left transition motion-reduce:transition-none ${
                    draft.step === step
                      ? 'bg-omni-600 text-white'
                      : enabled ? 'bg-surface-secondary text-content-secondary hover:bg-omni-50' : 'bg-surface-secondary text-content-tertiary opacity-60'
                  }`}
                >
                  <span className="block text-[10px] font-bold uppercase tracking-[0.16em] opacity-80">Step {index + 1}</span>
                  <span className="block text-sm font-semibold">{label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {message && <div role="status" aria-live="polite" className="rounded-card border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">{message}</div>}

      {draft.step === 0 && !draft.jobId && (
        <section className="space-y-5" aria-labelledby="safe-copy-dashboards-heading">
          <div className="card p-5">
            <h2 ref={headingRef} tabIndex={-1} id="safe-copy-dashboards-heading" className="text-lg font-semibold text-content-primary">
              Choose dashboards
            </h2>
            <p className="mt-1 text-sm text-content-secondary">
              Choose a source connection, then add dashboards by link or identifier. Browse the full accessible catalog only when you need to find a dashboard.
            </p>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-content-primary">Source instance</label>
                <ComboBox
                  options={sourceInstances.map((instance) => ({
                    value: instance.id,
                    label: instance.label,
                    subtitle: instance.baseUrl.replace(/^https?:\/\//, ''),
                  }))}
                  value={draft.sourceId}
                  onChange={chooseSource}
                  allowFreeText={false}
                  placeholder="Choose a source instance"
                  emptyLabel="No source-eligible saved instances found"
                  ariaLabel="Source instance"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-content-primary">Source connection</label>
                <ComboBox
                  options={sourceConnectionOptions}
                  value={draft.sourceConnectionId}
                  onChange={chooseSourceConnection}
                  allowFreeText={false}
                  disabled={!draft.sourceId}
                  isLoading={sourceCatalog.loading}
                  loadingLabel="Loading source connections..."
                  placeholder="Choose a source connection"
                  emptyLabel={sourceConnectionEmptyLabel(sourceCatalog)}
                  ariaLabel="Source connection"
                  optionLayout="stacked"
                />
                {sourceCatalog.error && <div role="alert" className="mt-2 rounded-card border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
                  <p className="font-semibold">Source connection catalog could not be loaded</p>
                  <p>{sourceCatalog.error}</p>
                  <p>Saved choices are unchanged. This catalog message is separate from dashboard readiness.{sourceCatalog.connections.length > 0 ? ' Previously loaded connections are still shown.' : ''}</p>
                  <button type="button" className="btn-secondary btn-sm mt-2" disabled={sourceCatalog.loading || !draft.sourceId} onClick={() => void loadSourceConnections(draft.sourceId)}>Retry source connections</button>
                </div>}
              </div>
            </div>
          </div>

          <div className="card p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-base font-semibold text-content-primary">Dashboards</h3>
                <p className="mt-1 text-xs text-content-secondary">
                  {dashboardInventory?.complete && dashboardInventory.scope === 'credential'
                    ? `Browse completed: ${dashboardInventory.matchedRecordCount} dashboards returned for this connection. Previously verified dashboards are also kept below.`
                    : documents.length > 0 ? `${documents.length} dashboards individually verified. The full catalog has not been browsed.`
                    : draft.sourceConnectionId ? 'Add a known dashboard without scanning the full catalog, or choose to browse.' : 'Choose a source connection to add dashboards.'}
                </p>
                {dashboardInventory?.complete && <p className="mt-1 text-xs text-content-secondary">
                  {dashboardInventory.cache.status === 'hit' ? 'Reused complete cached inventory' : dashboardInventory.cache.status === 'shared' ? 'Reused a completed shared inventory request' : 'Complete inventory fetched'}
                  {' · '}{new Date(dashboardInventory.cache.fetchedAt).toLocaleString()}. This timestamp describes the browse result, not every retained dashboard. Readiness checks the selected dashboards again.
                </p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={selectAllMatching}
                  disabled={filteredDocuments.length === 0}
                  className="btn-secondary btn-sm"
                >
                  Select matching
                </button>
                <button
                  type="button"
                  onClick={() => dispatchDraft({
                    type: 'patch_plan',
                    patch: { selectedDocumentIds: [] },
                    requestId: newDashboardSafeCopyRequestId(),
                  })}
                  disabled={draft.selectedDocumentIds.length === 0}
                  className="btn-secondary btn-sm"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => void loadDashboards()}
                  disabled={!draft.sourceConnectionId || loadingDashboards || loadingDashboardLookup}
                  className="btn-secondary btn-sm"
                >
                  Browse all dashboards
                </button>
                {dashboardInventory?.complete && <button type="button" onClick={() => void loadDashboards(undefined, true)} disabled={!draft.sourceConnectionId || loadingDashboards || loadingDashboardLookup} className="btn-secondary btn-sm" title="Fetch a new catalog from Omni instead of reusing the cached browse result">
                  <RefreshCw size={13} aria-hidden="true" />Refresh catalog
                </button>}
              </div>
            </div>
            <form className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); void addDashboardByReference(); }}>
              <label className="min-w-0 flex-1 text-sm font-semibold text-content-primary">
                Dashboard link or identifier
                <input value={dashboardReference} onChange={(event) => setDashboardReference(event.target.value)} disabled={!draft.sourceConnectionId || loadingDashboards || loadingDashboardLookup} placeholder="Paste a dashboard link or identifier" className="input-field mt-1 w-full" autoComplete="off" />
              </label>
              <button type="submit" className="btn-primary justify-center" disabled={!draft.sourceConnectionId || !dashboardReference.trim() || loadingDashboards || loadingDashboardLookup}>
                <Plus size={14} aria-hidden="true" />Add dashboard by link
              </button>
            </form>
            <p className="mt-2 text-xs text-content-secondary">Each added dashboard must belong to the selected instance and connection. This only verifies selection; it does not copy anything.</p>
            <div className="mt-4">
              <SearchInput
                value={search}
                onChange={(value) => {
                  setSearch(value);
                  setVisibleDashboardCount(DASHBOARD_PAGE_SIZE);
                }}
                placeholder="Search dashboards, folders, models, or labels"
              />
            </div>
            {loadingDashboards && (
              <div className="mt-4 rounded-card bg-surface-secondary px-3 py-3 text-sm text-content-secondary">
                <div role="status" aria-live="polite" className="flex items-center gap-2"><Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" />
                  {dashboardBrowseProgress ? `${dashboardBrowseProgress.pages} pages received · ${dashboardBrowseProgress.returnedRecords.toLocaleString()} source records scanned${dashboardBrowseProgress.reportedTotalRecords !== undefined ? ` · reported total ${dashboardBrowseProgress.reportedTotalRecords.toLocaleString()}` : ''}` : 'Waiting for the first inventory page or a complete cached result…'}
                </div>
                <p className="mt-1">Elapsed: {dashboardBrowseElapsed}s. Results are added only after the full accessible catalog is complete.</p>
                <button type="button" onClick={cancelDashboardLoading} className="btn-secondary btn-sm mt-2">Cancel browsing</button>
              </div>
            )}
            {loadingDashboardLookup && <div role="status" className="mt-4 flex flex-wrap items-center gap-2 rounded-card bg-surface-secondary px-3 py-3 text-sm text-content-secondary">
              <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" />Verifying the requested dashboard identifiers…
              <button type="button" onClick={cancelDashboardLoading} className="btn-secondary btn-sm">Cancel verification</button>
            </div>}
            {!loadingDashboards && dashboardInventory?.complete && documents.length === 0 && <p className="mt-4 text-sm text-content-secondary">No accessible dashboards were returned for this connection.</p>}
            {documents.length > 0 && (
              <div className="mt-4 max-h-[32rem] overflow-y-auto rounded-card border border-border" aria-label="Available dashboards">
                {visibleDocuments.map((document) => {
                  const documentId = sourceDocumentId(document);
                  const selected = selectedDocumentIds.has(documentId);
                  return (
                    <label
                      key={documentId}
                      className={`flex cursor-pointer items-start gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0 ${selected ? 'bg-omni-50' : 'bg-white hover:bg-surface-secondary'}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleDocument(documentId)}
                        className="mt-0.5 h-4 w-4 accent-omni-600"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-content-primary">{document.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-content-secondary">
                          {document.folderPath || 'Folder details not supplied'}
                          {(document.baseModelName || document.baseModelId) ? ` · ${document.baseModelName || document.baseModelId}` : ''}
                        </span>
                      </span>
                    </label>
                  );
                })}
                {filteredDocuments.length === 0 && (
                  <div className="px-4 py-8 text-center text-sm text-content-secondary">No dashboards match this search.</div>
                )}
                {visibleDocuments.length < filteredDocuments.length && (
                  <div className="flex justify-center border-t border-border-subtle bg-white p-3">
                    <button
                      type="button"
                      onClick={() => setVisibleDashboardCount((count) => count + DASHBOARD_PAGE_SIZE)}
                      className="btn-secondary btn-sm"
                    >
                      Show {Math.min(DASHBOARD_PAGE_SIZE, filteredDocuments.length - visibleDocuments.length)} more
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm font-semibold text-content-primary">
                {draft.selectedDocumentIds.length} dashboard{draft.selectedDocumentIds.length === 1 ? '' : 's'} selected
              </div>
              <button
                type="button"
                onClick={() => goToStep(1)}
                disabled={!sourceReady}
                className="btn-primary justify-center"
              >
                Choose destinations
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      )}

      {draft.step === 1 && !draft.jobId && (
        <section className="space-y-5" aria-labelledby="safe-copy-destinations-heading">
          <div className="card p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 ref={headingRef} tabIndex={-1} id="safe-copy-destinations-heading" className="text-lg font-semibold text-content-primary">Choose destinations</h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-content-secondary">
                  Each dashboard will be copied to every destination you include. Add another row to use the same instance with a different connection, model, or folder.
                </p>
              </div>
              <span className="rounded-full bg-omni-50 px-3 py-1 text-xs font-semibold text-omni-800">{draft.destinations.length} destinations</span>
            </div>
            {draft.destinations.length === 0 && (
              <div className="mt-5 rounded-card border border-dashed border-border bg-surface-secondary p-6 text-center">
                <Database size={24} className="mx-auto text-omni-600" aria-hidden="true" />
                <p className="mt-3 text-sm font-semibold text-content-primary">Where should these dashboards go?</p>
                <p className="mt-1 text-xs text-content-secondary">Start with one destination. Saved defaults stay editable.</p>
              </div>
            )}
            {destinationInstances.length > 0 ? (
              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <ComboBox options={destinationInstances.map((instance) => ({ value: instance.id, label: instance.label, subtitle: instance.baseUrl.replace(/^https?:\/\//, '') }))}
                    value={newDestinationInstanceId} onChange={setNewDestinationInstanceId} allowFreeText={false} ariaLabel="Instance to add as a destination" placeholder={`Search ${destinationInstances.length} destination instance${destinationInstances.length === 1 ? '' : 's'}…`} optionLayout="stacked" maxVisibleOptions={30} />
                </div>
                <button type="button" className="btn-secondary justify-center" onClick={() => addDestination(newDestinationInstanceId)} disabled={!newDestinationInstanceId || submitting || draft.destinations.length >= MAX_DESTINATIONS}><Plus size={14} aria-hidden="true" />Add destination</button>
              </div>
            ) : <p className="mt-4 text-sm text-content-secondary">Add a saved destination instance to continue.</p>}
            {draft.destinations.length > 1 && (
              <div className="mt-4 border-t border-border pt-4">
                <SearchInput value={destinationSearch} onChange={(value) => { setDestinationSearch(value); setDestinationPageIndex(0); setExpandedDestinationId(null); }} ariaLabel="Search selected destinations" placeholder="Find a selected instance, connection, model, or folder…" />
                <p className="mt-2 text-xs text-content-secondary">{filteredDestinations.length} of {draft.destinations.length} selected destinations · Expand one row to edit its settings.</p>
              </div>
            )}
          </div>

          {destinationWindow.rows.map(({ destination, destinationIndex, instance, catalog, connectionLabel, modelLabel, folderLabel }) => {
            const modelOptions = catalog.models.filter((model) => model.connectionId === destination.connectionId);
            const rowLabel = `Destination ${destinationIndex + 1}`;
            const expanded = destination.targetId === activeDestinationId;
            return (
              <article key={destination.targetId} className={`card ${expanded ? 'p-5' : 'px-5 py-3'}`} aria-labelledby={`destination-${destination.targetId}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 id={`destination-${destination.targetId}`}>
                      <button type="button" className="flex w-full items-start gap-2 text-left text-sm font-semibold text-content-primary" aria-label={`Edit ${rowLabel.toLowerCase()}`} aria-expanded={expanded} aria-controls={`destination-editor-${destination.targetId}`}
                        onClick={() => setExpandedDestinationId(expanded ? '' : destination.targetId)}>
                        <ChevronDown size={16} className={`mt-0.5 shrink-0 ${expanded ? '' : '-rotate-90'}`} aria-hidden="true" />
                        <span className="min-w-0 truncate">{destinationIndex + 1}. {instance?.label || 'Choose instance'}</span>
                      </button>
                    </h3>
                    <p className="mt-1 truncate pl-6 text-xs text-content-secondary" title={`${connectionLabel} → ${modelLabel} → ${folderLabel}`}>{connectionLabel} → {modelLabel} → {folderLabel}</p>
                    {(!destination.connectionId || !destination.modelId) && <p className="mt-1 pl-6 text-xs text-amber-800">Setup needed</p>}
                  </div>
                  <button type="button" className="btn-secondary btn-sm" aria-label={`Remove ${rowLabel.toLowerCase()}`} onClick={() => { dispatchDraft({ type: 'remove_destination', targetId: destination.targetId, requestId: newDashboardSafeCopyRequestId() }); if (expanded) setExpandedDestinationId(null); }}><Trash2 size={14} aria-hidden="true" /><span className="hidden sm:inline">Remove</span></button>
                </div>
                {expanded && <div id={`destination-editor-${destination.targetId}`}>
                <div className="mt-4 grid min-w-0 gap-4 md:grid-cols-2">
                  <div>
                    <div className="mb-1.5 text-xs font-semibold text-content-secondary">Instance</div>
                    <ComboBox options={destinationInstances.map((row) => ({ value: row.id, label: row.label, subtitle: row.baseUrl.replace(/^https?:\/\//, '') }))} value={destination.instanceId} onChange={(value) => setDestinationInstance(destination.targetId, value)} allowFreeText={false} ariaLabel={`${rowLabel} instance`} placeholder="Choose instance" optionLayout="stacked" maxVisibleOptions={30} />
                  </div>
                  <div>
                    <div className="mb-1.5 text-xs font-semibold text-content-secondary">Connection</div>
                    <ComboBox options={buildConnectionComboBoxOptions(catalog.connections)} value={destination.connectionId} onChange={(value) => setDestinationConnection(destination.targetId, value)} allowFreeText={false} ariaLabel={`${instance?.label || 'Saved instance'} destination ${destinationIndex + 1} connection`} placeholder={catalog.loading ? 'Loading connections…' : 'Choose connection'} disabled={!destination.instanceId || catalog.loading} emptyLabel="No active destination connections" optionLayout="stacked" />
                  </div>
                  <div>
                    <div className="mb-1.5 text-xs font-semibold text-content-secondary">Model</div>
                    <ComboBox options={modelOptions.map((model) => ({ value: model.id, label: modelDisplayLabel(model), subtitle: model.connectionName || model.connectionId }))} value={destination.modelId} onChange={(value) => setDestinationModel(destination.targetId, value)} allowFreeText={false} ariaLabel={`${rowLabel} model`} disabled={!destination.connectionId || catalog.loading} placeholder={destination.connectionId ? 'Choose model' : 'Choose connection first'} emptyLabel="No shared models for this connection" optionLayout="stacked" />
                  </div>
                  <DestinationFolderPicker rowLabel={rowLabel} folderId={destination.folderId} folderPath={destination.folderPath} disabled={!instance}
                    catalog={instance ? destinationFolders.catalogs[destinationFolderCacheKey(instance)] || EMPTY_FOLDER_CATALOG : EMPTY_FOLDER_CATALOG}
                    onLoad={(force) => { if (instance) void destinationFolders.load(instance, force); }} onChange={(patch) => updateDestination(destination.targetId, patch)} />
                </div>
                {catalog.loading && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-content-secondary"><Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />Loading destination choices…</p>}
                {catalog.error && <div role="alert" className="mt-4 rounded-card border border-red-200 bg-red-50 p-3 text-xs text-red-700">{catalog.error}<button type="button" onClick={() => void loadDestinationCatalog(destination.instanceId)} className="btn-secondary btn-sm ml-2"><RefreshCw size={13} aria-hidden="true" />Retry</button></div>}
                </div>}
              </article>
            );
          })}
          {draft.destinations.length > 0 && filteredDestinations.length === 0 && <p role="status" className="card p-5 text-sm text-content-secondary">No selected destinations match this search. Clear the search to see all destinations.</p>}
          {destinationWindow.pageCount > 1 && (
            <nav aria-label="Selected destination pages" className="flex items-center justify-between gap-3">
              <button type="button" className="btn-secondary btn-sm" disabled={destinationWindow.page === 0} onClick={() => { setDestinationPageIndex(destinationWindow.page - 1); setExpandedDestinationId(null); }}>Previous</button>
              <span className="text-xs text-content-secondary">Page {destinationWindow.page + 1} of {destinationWindow.pageCount} · {DESTINATIONS_PER_PAGE} destinations per page</span>
              <button type="button" className="btn-secondary btn-sm" disabled={destinationWindow.page + 1 >= destinationWindow.pageCount} onClick={() => { setDestinationPageIndex(destinationWindow.page + 1); setExpandedDestinationId(null); }}>Next</button>
            </nav>
          )}
          <div className="card p-5">
            <p className="text-xs leading-5 text-content-secondary">Copies receive distinct names when needed. {DESTINATION_ACCESS_NOTICE}</p>
            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button type="button" onClick={() => goToStep(0)} className="btn-secondary justify-center"><ArrowLeft size={15} aria-hidden="true" />Back</button>
              <button type="button" onClick={() => { goToStep(2); if (!currentPlan) void checkReadiness(); }} disabled={!destinationsReady || !sourceReady} className="btn-primary justify-center">Review readiness<ArrowRight size={15} aria-hidden="true" /></button>
            </div>
          </div>
        </section>
      )}

      {draft.step === 2 && !draft.jobId && (
        <section className="space-y-5" aria-labelledby="safe-copy-readiness-heading">
          <div className="card p-5">
            <h2 ref={headingRef} tabIndex={-1} id="safe-copy-readiness-heading" className="text-lg font-semibold text-content-primary">Review readiness</h2>
            <p className="mt-1 text-sm leading-6 text-content-secondary">Review source definitions, any destination topic choices, and remaining evidence gaps. Workbook-local definitions stay local; copying them is unavailable until workbook-copy capability is verified. Model Migrator reviews shared-model repairs only.</p>
            <div className="mt-5">
              <DashboardReadinessReview
                plan={currentPlan}
                checking={checkingReadiness}
                progress={readinessProgress}
                startedAt={readinessStartedAt}
                onCancel={readinessStartedAt !== null ? cancelReadiness : undefined}
                savingTargetId={savingPlanTargetId}
                selectedTargetIds={selectedReadyTargetIds}
                destinationLabels={Object.fromEntries(draft.destinations.map((destination) => {
                  const catalog = destinationCatalogs[destination.instanceId];
                  const model = catalog?.models.find((row) => row.id === destination.modelId);
                  return [destination.targetId, { instance: instanceById.get(destination.instanceId)?.label || destination.instanceId, connection: catalog?.connections.find((row) => row.id === destination.connectionId)?.name || destination.connectionId, model: model ? modelDisplayLabel(model) : destination.modelId, folder: destinationFolderLabel(destination.folderPath, destination.folderId) }];
                }))}
                folderCatalogs={Object.fromEntries(draft.destinations.map((destination) => {
                  const instance = instanceById.get(destination.instanceId);
                  return [destination.targetId, instance ? destinationFolders.catalogs[destinationFolderCacheKey(instance)] || EMPTY_FOLDER_CATALOG : EMPTY_FOLDER_CATALOG];
                }))}
                onLoadFolders={(targetId, forceRefresh) => {
                  const destination = draft.destinations.find((row) => row.targetId === targetId);
                  const instance = destination && instanceById.get(destination.instanceId);
                  if (instance) void destinationFolders.load(instance, forceRefresh);
                }}
                onUpdate={(update) => void savePlanTargetChoices(update)}
                onCheck={() => void checkReadiness()}
                onSelect={(targetIds) => dispatchDraft({ type: 'select_targets', targetIds, deploymentRequestId: newDashboardSafeCopyRequestId() })}
                onResolve={resolveInModelMigrator}
                onPlanChange={(plan) => {
                  const current = latestDeploymentPlan.current;
                  if (!current || current.id !== plan.id || current.revision >= plan.revision) return;
                  latestDeploymentPlan.current = plan;
                  setDeploymentPlan(plan);
                  dispatchDraft({ type: 'restore_plan', plan });
                  dispatchDraft({ type: 'select_targets', targetIds: [], deploymentRequestId: newDashboardSafeCopyRequestId() });
                }}
                topicRepairBusy={topicRepairBusy}
                onTopicRepairBusyChange={setTopicRepairBusy}
              />
            </div>
          </div>
          <div className="card flex flex-col-reverse gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <button type="button" onClick={() => goToStep(1)} disabled={checkingReadiness || topicRepairBusy || Boolean(savingPlanTargetId)} className="btn-secondary justify-center"><ArrowLeft size={15} aria-hidden="true" />Back to destinations</button>
            <button type="button" onClick={() => goToStep(3)} disabled={checkingReadiness || topicRepairBusy || Boolean(savingPlanTargetId) || selectedReadyTargetIds.length === 0} className="btn-primary justify-center">Review deployment ({selectedReadyTargetIds.length})<ArrowRight size={15} aria-hidden="true" /></button>
          </div>
        </section>
      )}

      {draft.step === 3 && (
        <section className="space-y-5" aria-labelledby="safe-copy-track-heading">
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {progressAnnouncement}
          </p>
          <div className="card p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 ref={headingRef} tabIndex={-1} id="safe-copy-track-heading" className="text-lg font-semibold text-content-primary">
                  Deploy and track
                </h2>
                <p className="mt-1 text-sm text-content-secondary">
                  {job ? 'Follow dashboard creation and verification for each deployed destination.' : 'Confirm the destinations included in this deployment.'}
                </p>
              </div>
              {job && displayedJobStatus && (
                <StatusChip status={displayedJobStatus.chip} label={displayedJobStatus.label} />
              )}
            </div>

            {!job && (
              <>
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-card bg-surface-secondary p-4">
                    <FileText size={17} className="text-omni-700" aria-hidden="true" />
                    <div className="mt-2 text-2xl font-semibold text-content-primary">{draft.selectedDocumentIds.length}</div>
                    <div className="text-xs text-content-secondary">Dashboards</div>
                  </div>
                  <div className="rounded-card bg-surface-secondary p-4">
                    <Database size={17} className="text-omni-700" aria-hidden="true" />
                    <div className="mt-2 text-2xl font-semibold text-content-primary">{selectedReadyTargetIds.length}</div>
                    <div className="text-xs text-content-secondary">Included destinations</div>
                  </div>
                  <div className="rounded-card bg-surface-secondary p-4">
                    <Copy size={17} className="text-omni-700" aria-hidden="true" />
                    <div className="mt-2 text-2xl font-semibold text-content-primary">{draft.selectedDocumentIds.length * selectedReadyTargetIds.length}</div>
                    <div className="text-xs text-content-secondary">Planned copies</div>
                  </div>
                </div>
                <div className="mt-5 rounded-card border border-border p-4">
                  <div className="text-sm font-semibold text-content-primary">
                    {sourceInstance?.label || draft.sourceId} → {selectedReadyTargetIds.length} selected destinations
                  </div>
                  <ul className="mt-2 space-y-1 text-xs text-content-secondary" aria-label="Destination folders">
                    {draft.destinations.filter((row) => selectedReadyTargetIds.includes(row.targetId)).map((destination) => (
                      <li key={destination.targetId}>
                        {instances.find((instance) => instance.id === destination.instanceId)?.label || destination.instanceId}: Folder {destinationFolderLabel(
                          destination.folderPath,
                          destination.folderId,
                        )}
                      </li>
                    ))}
                  </ul>
                  {heldTargetCount > 0 && <p className="mt-3 rounded-card border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">{heldTargetCount} destination{heldTargetCount === 1 ? ' is' : 's are'} held and will not be deployed. Return to the plan to resolve or select them.</p>}
                  <div className="mt-2 text-xs leading-5 text-content-secondary">
                    Existing content is not replaced or deleted. {DESTINATION_ACCESS_NOTICE}
                  </div>
                </div>
                <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <button type="button" onClick={() => goToStep(2)} disabled={submitting} className="btn-secondary justify-center">
                    <ArrowLeft size={15} aria-hidden="true" /> Back
                  </button>
                  <button type="button" onClick={() => void startMove()} disabled={submitting || checkingReadiness || Boolean(savingPlanTargetId) || !currentPlan || selectedReadyTargetIds.length === 0} className="btn-primary justify-center">
                    {submitting ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" /> : <FolderInput size={15} aria-hidden="true" />}
                    {submitting ? 'Starting deployment…' : `Deploy to ${selectedReadyTargetIds.length} destination${selectedReadyTargetIds.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              </>
            )}

            {job && (
              <div className="mt-5 rounded-card border border-border bg-surface-secondary p-4">
                {globalReconciliationHold && (
                  <div role="alert" className="mb-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
                    This move is paused for reconciliation. Retry the affected destination before starting another move.
                  </div>
                )}
                <p className="text-xs leading-5 text-content-secondary">
                  Each destination advances independently through prepare, copy, verify, and complete.
                </p>
                <details className="mt-3 text-xs text-content-secondary">
                  <summary className="cursor-pointer font-semibold">Technical details</summary>
                  <div className="mt-2 break-all font-mono text-[10px] text-content-primary">Job {job.id}</div>
                </details>
              </div>
            )}
          </div>

          {job && progress.map((target, targetIndex) => {
            const retrying = retryingTargetIds.includes(target.targetId);
            const actions = dashboardSafeCopyTargetActions(target);
            const destinationInstance = instanceById.get(target.destinationId);
            const targetScope = job.targets?.find((candidate) => candidate.id === target.targetId);
            const visibleDocumentCount = visibleProgressDocuments[target.targetId] || PROGRESS_DOCUMENT_PAGE_SIZE;
            const visibleTargetDocuments = target.documents;
            const documentsExpanded = expandedProgressTargetId === target.targetId;
            const targetHeadingId = `safe-copy-progress-target-${targetIndex + 1}`;
            return (
              <article key={target.targetId} className="card min-w-0 p-4 sm:p-5" aria-labelledby={targetHeadingId}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 id={targetHeadingId} className="break-words text-base font-semibold text-content-primary">{target.destinationLabel}</h3>
                    <p className="mt-1 break-words text-xs text-content-secondary">
                      {target.modelName ? `Model ${target.modelName}` : 'Destination model selected'}
                    </p>
                    <p className="mt-1 break-words text-xs text-content-secondary">
                      Folder {destinationFolderLabel(targetScope?.targetFolderPath, targetScope?.targetFolderId)}
                    </p>
                  </div>
                  <StatusChip status={TARGET_PHASE_CHIPS[target.phase]} label={TARGET_PHASE_LABELS[target.phase]} />
                </div>

                <ol
                  className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
                  aria-label={`${target.destinationLabel} move stages`}
                >
                  {TARGET_STAGES.map((stage, index) => {
                    const active = target.activeStage === stage.id;
                    const complete = target.completedStages.includes(stage.id);
                    const attention = active && (
                      target.phase === 'needs_attention' || target.phase === 'reconciliation_required'
                    );
                    const canceled = active && target.phase === 'canceled';
                    const tone = complete && (!active || target.phase === 'succeeded')
                      ? 'border-green-200 bg-green-50 text-green-900'
                      : attention
                        ? 'border-amber-300 bg-amber-50 text-amber-950'
                        : canceled
                          ? 'border-border bg-surface-secondary text-content-secondary'
                          : active
                            ? 'border-omni-300 bg-omni-50 text-omni-900'
                            : 'border-border bg-white text-content-secondary';
                    const stageState = complete && (!active || target.phase === 'succeeded')
                      ? 'Complete'
                      : active ? TARGET_PHASE_LABELS[target.phase] : 'Not started';
                    return (
                      <li
                        key={stage.id}
                        aria-current={active ? 'step' : undefined}
                        className={`min-w-0 rounded-card border px-2 py-2 ${tone}`}
                      >
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                          {complete && <Check size={12} aria-hidden="true" />}
                          <span className="break-words">{index + 1}. {stage.label}</span>
                        </div>
                        <span className="sr-only">: {stageState}</span>
                      </li>
                    );
                  })}
                </ol>
                {(target.message || target.exceptionCodes.length > 0) && (
                  <div className={`mt-4 rounded-card border px-3 py-2 text-xs ${actions.canRetry ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-border bg-surface-secondary text-content-secondary'}`}>
                    {target.message || 'This destination returned a bounded migration exception.'}
                    {target.exceptionCodes.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer font-semibold">Technical details</summary>
                        <div className="mt-1 break-words font-mono text-[10px]">{target.exceptionCodes.join(' · ')}</div>
                      </details>
                    )}
                  </div>
                )}

                {target.documentCount > 0 && (
                  <details
                    open={documentsExpanded}
                    onToggle={(event) => {
                      if (event.currentTarget.open) setExpandedProgressTargetId(target.targetId);
                      else setExpandedProgressTargetId((current) => current === target.targetId ? '' : current);
                    }}
                    className="mt-4 rounded-card border border-border bg-surface-secondary"
                  >
                    <summary className="cursor-pointer px-3 py-3 text-sm font-semibold text-content-primary sm:px-4">
                      Dashboard results ({target.documentCount})
                    </summary>
                    {documentsExpanded && <div className="border-t border-border p-3 sm:p-4">
                      <ul className="space-y-2" aria-label={`Dashboard progress for ${target.destinationLabel}`}>
                        {visibleTargetDocuments.map((document) => {
                          const dashboardUrl = document.phase === 'complete'
                            ? verifiedDashboardUrl(destinationInstance?.baseUrl, document.verifiedDestinationIdentifier)
                            : '';
                          return (
                            <li
                              key={document.sourceDocumentId}
                              className="min-w-0 rounded-card border border-border bg-white p-3"
                            >
                              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <div className="break-words text-sm font-semibold text-content-primary">
                                    {document.sourceLabel}
                                  </div>
                                  {document.chosenTargetName && (
                                    <div className="mt-1 break-words text-xs text-content-secondary">
                                      Copied as {document.chosenTargetName}
                                    </div>
                                  )}
                                </div>
                                <StatusChip
                                  status={DOCUMENT_PHASE_CHIPS[document.phase]}
                                  label={DOCUMENT_PHASE_LABELS[document.phase]}
                                  size="xs"
                                />
                              </div>
                              <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                {dashboardUrl ? (
                                  <a
                                    href={dashboardUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn-secondary btn-sm w-full justify-center sm:w-auto"
                                    aria-label={`Open ${document.chosenTargetName || document.sourceLabel} in ${target.destinationLabel}`}
                                  >
                                    <ExternalLink size={13} aria-hidden="true" /> Open verified dashboard
                                  </a>
                                ) : <span />}
                                <details className="min-w-0 text-xs text-content-secondary">
                                  <summary className="cursor-pointer font-semibold">Technical details</summary>
                                  <div className="mt-1 break-all font-mono text-[10px]">
                                    Source dashboard {document.sourceDocumentId}
                                    {document.exceptionCode ? ` · ${document.exceptionCode}` : ''}
                                  </div>
                                </details>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                      {visibleTargetDocuments.length < target.documentCount && (
                        <button
                          type="button"
                          onClick={() => setVisibleProgressDocuments((current) => ({
                            ...current,
                            [target.targetId]: Math.min(
                              target.documentCount,
                              visibleDocumentCount + PROGRESS_DOCUMENT_PAGE_SIZE,
                            ),
                          }))}
                          className="btn-secondary btn-sm mt-3 w-full justify-center sm:w-auto"
                        >
                          Show {Math.min(PROGRESS_DOCUMENT_PAGE_SIZE, target.documentCount - visibleTargetDocuments.length)} more
                        </button>
                      )}
                    </div>}
                  </details>
                )}
                {(actions.canRetry || actions.canChooseAnotherModel || actions.canOpenModelMigrator) && (
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    {actions.canRetry && (
                      <button
                        type="button"
                        onClick={() => void retryTarget(target.targetId)}
                        disabled={retrying}
                        className="btn-secondary btn-sm w-full justify-center sm:w-auto"
                      >
                        {retrying ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}
                        {retrying ? 'Reconciling...' : 'Retry destination'}
                      </button>
                    )}
                    {actions.canChooseAnotherModel && (
                      <button
                        type="button"
                        onClick={() => chooseAnotherModel(target.targetId)}
                        disabled={retrying}
                        className="btn-secondary btn-sm w-full justify-center sm:w-auto"
                      >
                        <Database size={13} aria-hidden="true" /> Choose another model
                      </button>
                    )}
                    {actions.canOpenModelMigrator && (
                      <button
                        type="button"
                        onClick={() => openModelMigrator(target)}
                        disabled={retrying}
                        className="btn-secondary btn-sm w-full justify-center sm:w-auto"
                      >
                        <ExternalLink size={13} aria-hidden="true" /> Open Model Migrator
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}

          {job && isDashboardSafeCopyTerminal(job.status) && (
            <div className={`card p-5 ${strictlyVerifiedMove ? 'border-green-200 bg-green-50' : ''}`}>
              <div className="flex items-start gap-3">
                {strictlyVerifiedMove
                  ? <CheckCircle2 size={21} className="mt-0.5 text-green-700" aria-hidden="true" />
                  : <AlertTriangle size={21} className="mt-0.5 text-amber-700" aria-hidden="true" />}
                <div>
                  <h3 className="text-base font-semibold text-content-primary">
                    {strictlyVerifiedMove ? 'Move complete' : displayedJobStatus?.label || 'Needs attention'}
                  </h3>
                  <p className="mt-1 text-sm text-content-secondary">
                    {strictlyVerifiedMove
                      ? `The deployed dashboards passed content, query, and direct-access verification. ${DESTINATION_ACCESS_NOTICE}`
                      : 'Successful destinations are preserved. Only destinations shown above as needing attention should be retried or opened in Model Migrator.'}
                  </p>
                </div>
              </div>
              {canStartAnotherMove && (
                <button type="button" onClick={startAnotherMove} className="btn-primary mt-4 justify-center">
                  Start another move
                </button>
              )}
              {canStartAnotherMove && currentPlan && <button type="button" onClick={() => void returnToPlan()} disabled={checkingReadiness} className="btn-secondary mt-4 sm:ml-3">{checkingReadiness ? 'Restoring plan…' : 'Return to deployment plan'}</button>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
