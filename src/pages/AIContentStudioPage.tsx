import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
} from 'react';
import {
  ExternalLink,
  Loader2,
  Copy,
  Paperclip,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { DashboardSearch } from '@/components/deckBuilder/DashboardSearch';
import { AttachmentDropzone } from '@/components/aiContentStudio/AttachmentDropzone';
import { ModeTabs } from '@/components/aiContentStudio/ModeTabs';
import { aiContentModeDetail } from '@/components/aiContentStudio/modeDetails';
import { OneShotBriefForm } from '@/components/aiContentStudio/OneShotBriefForm';
import { OutcomePanel } from '@/components/aiContentStudio/OutcomePanel';
import { ScopeSelector } from '@/components/aiContentStudio/ScopeSelector';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { AIWorkingAnimation } from '@/components/ui/AIWorkingAnimation';
import { useConnection } from '@/hooks/useConnection';
import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import { useLogOperation } from '@/hooks/useOperationLog';
import { cancelAiContentStudioJob, listConnections, listTopics } from '@/services/omniApi';
import { fetchDashboardList, fetchDashboardSummary } from '@/services/deckBuilder/omniDeckApi';
import { dashboardCache, type CachedDashboard } from '@/services/deckBuilder/localCache';
import {
  addContentAttachments,
  MAX_CONTENT_ATTACHMENTS,
  MAX_CONTENT_REQUEST_BYTES,
} from '@/services/aiContentStudio/attachments';
import { aiContentBriefIsReady } from '@/services/aiContentStudio/brief';
import {
  AIContentCompletedResultValidationError,
  AIContentCreateAcceptanceUnknownError,
  AIContentResultContractMismatchError,
  AIContentTerminalJobError,
  AIContentUnresolvedJobError,
  recoverCompletedAIContentJob,
  runAIContentJob,
  validateOmniChatUrl,
} from '@/services/aiContentStudio/jobRunner';
import { buildAIContentPrompt, projectDashboardEvidence } from '@/services/aiContentStudio/prompts';
import {
  captureDashboardReviewRender,
  hasReviewImageFallback,
} from '@/services/aiContentStudio/reviewAttachments';
import {
  aiContentModelInventoryError,
  loadAIContentModelInventory,
  resolveAIContentDashboardModels,
} from '@/services/aiContentStudio/modelInventory';
import {
  captureAIContentModelSnapshot,
  compareAIContentModelSnapshots,
  unavailableModelMutationCheck,
  type AIContentModelMutationCheck,
} from '@/services/aiContentStudio/modelSnapshot';
import {
  aiContentStudioFormReducer,
  initialAIContentStudioForm,
} from '@/services/aiContentStudio/studioState';
import { sha256Text } from '@/services/contentHash';
import { hasActiveSavedVaultConnection } from '@/services/connectionGuards';
import {
  applyStudioConnectionNames,
  parseStudioConnectionNamesResponse,
  type StudioModelConnectionRecord,
} from '@/services/topicsRequestState';
import type {
  AIContentAttachment,
  AIContentJobOutcome,
  AIContentMode,
  AIContentUnresolvedJobReason,
  InspectedContentDashboard,
} from '@/services/aiContentStudio/types';
import type { OmniModel, OmniTopic } from '@/types';

interface RunContext {
  token: number;
  scope: string;
  baseUrl: string;
  apiKey: string;
  jobId: string;
  chatUrl: string;
  startedAt: number;
  mode: AIContentMode;
  submissionStarted: boolean;
  terminalState?: 'COMPLETE';
}

type RunReconciliationReasonCode =
  | AIContentUnresolvedJobReason
  | 'result-contract-mismatch'
  | 'completed-result-validation'
  | 'artifact-unverified'
  | 'creation-status-unverified'
  | 'response-review-required'
  | 'create-acceptance-unknown';

interface UnresolvedRun extends RunContext {
  reason: string;
  reasonCode: Exclude<RunReconciliationReasonCode, 'create-acceptance-unknown'>;
}

type RunReconciliation = Pick<RunContext, 'token' | 'jobId' | 'chatUrl' | 'startedAt' | 'mode' | 'terminalState'> & {
  reason: string;
  reasonCode: RunReconciliationReasonCode;
};

function reconciliationView(
  context: RunContext,
  reason: string,
  reasonCode: RunReconciliation['reasonCode'],
): RunReconciliation {
  return {
    token: context.token,
    jobId: context.jobId,
    chatUrl: context.chatUrl,
    startedAt: context.startedAt,
    mode: context.mode,
    terminalState: context.terminalState,
    reason,
    reasonCode,
  };
}

const AI_CONTENT_RECONCILIATION_STORAGE_PREFIX = 'omnikit:ai-content-reconciliation:v1:';

interface StoredCompletedReconciliation {
  version: 1;
  instanceId: string;
  jobId: string;
  chatUrl: string;
  mode: AIContentMode;
  startedAt: number;
  reasonCode:
    | 'result-unavailable'
    | 'result-contract-mismatch'
    | 'completed-result-validation'
    | 'artifact-unverified'
    | 'creation-status-unverified'
    | 'response-review-required';
  terminalState: 'COMPLETE';
}

function reconciliationStorageKey(connectionKey: string): string {
  return `${AI_CONTENT_RECONCILIATION_STORAGE_PREFIX}${sha256Text(connectionKey)}`;
}

function clearStoredReconciliation(connectionKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(reconciliationStorageKey(connectionKey));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

function storeCompletedReconciliation(
  connectionKey: string,
  instanceId: string,
  reconciliation: RunReconciliation,
): void {
  if (
    typeof window === 'undefined'
    || reconciliation.terminalState !== 'COMPLETE'
    || (
      reconciliation.reasonCode !== 'result-unavailable'
      && reconciliation.reasonCode !== 'result-contract-mismatch'
      && reconciliation.reasonCode !== 'completed-result-validation'
      && reconciliation.reasonCode !== 'artifact-unverified'
      && reconciliation.reasonCode !== 'creation-status-unverified'
      && reconciliation.reasonCode !== 'response-review-required'
    )
  ) return;
  const safe: StoredCompletedReconciliation = {
    version: 1,
    instanceId,
    jobId: reconciliation.jobId,
    chatUrl: reconciliation.chatUrl,
    mode: reconciliation.mode,
    startedAt: reconciliation.startedAt,
    reasonCode: reconciliation.reasonCode,
    terminalState: 'COMPLETE',
  };
  try {
    window.sessionStorage.setItem(reconciliationStorageKey(connectionKey), JSON.stringify(safe));
  } catch {
    // The in-memory reconciliation hold remains authoritative for this page.
  }
}

function loadCompletedReconciliation(
  connectionKey: string,
  instanceId: string,
  baseUrl: string,
): StoredCompletedReconciliation | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(reconciliationStorageKey(connectionKey));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const candidate = JSON.parse(raw) as Partial<StoredCompletedReconciliation>;
    const mode = candidate.mode;
    const jobId = typeof candidate.jobId === 'string' ? candidate.jobId.trim() : '';
    if (
      candidate.version !== 1
      || candidate.instanceId !== instanceId
      || (
        candidate.reasonCode !== 'result-unavailable'
        && candidate.reasonCode !== 'result-contract-mismatch'
        && candidate.reasonCode !== 'completed-result-validation'
        && candidate.reasonCode !== 'artifact-unverified'
        && candidate.reasonCode !== 'creation-status-unverified'
        && candidate.reasonCode !== 'response-review-required'
      )
      || candidate.terminalState !== 'COMPLETE'
      || (mode !== 'review' && mode !== 'dashboard' && mode !== 'app' && mode !== 'report')
      || !jobId
      || jobId.length > 200
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(jobId)
      || typeof candidate.startedAt !== 'number'
      || !Number.isFinite(candidate.startedAt)
    ) throw new Error('invalid reconciliation metadata');
    const chatUrl = validateOmniChatUrl(baseUrl, typeof candidate.chatUrl === 'string' ? candidate.chatUrl : '');
    return {
      version: 1,
      instanceId,
      jobId,
      chatUrl,
      mode,
      startedAt: candidate.startedAt,
      reasonCode: candidate.reasonCode,
      terminalState: 'COMPLETE',
    };
  } catch {
    clearStoredReconciliation(connectionKey);
    return null;
  }
}

function aiContentModeFromSearch(search: string): AIContentMode {
  const requested = new URLSearchParams(search).get('mode')?.trim().toLowerCase();
  if (requested === 'apps' || requested === 'app') return 'app';
  if (requested === 'review' || requested === 'report' || requested === 'dashboard') return requested;
  return 'dashboard';
}

function initialMode(): AIContentMode {
  return aiContentModeFromSearch(typeof window === 'undefined' ? '' : window.location.search);
}

function shortJobId(jobId: string): string {
  return jobId.trim() ? jobId.trim().slice(0, 8) : 'unknown';
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === 'AbortError';
}

function isCreationHandoffMode(mode: AIContentMode): mode is 'dashboard' | 'app' {
  return mode === 'dashboard' || mode === 'app';
}

function isNoWriteAgentMode(mode: AIContentMode): mode is 'review' | 'report' {
  return mode === 'review' || mode === 'report';
}

function requiresNoWriteResponseHold(issue: string): boolean {
  return !/^(?:REVIEW|REPORT)_STRUCTURE:/i.test(issue.trim());
}

function completedCreationHandoffOutcome(input: {
  mode: 'dashboard' | 'app';
  jobId: string;
  chatUrl: string;
  requestedName: string;
}): AIContentJobOutcome & { mode: AIContentMode; requestedName: string } {
  const artifactLabel = input.mode === 'app' ? 'App' : 'dashboard';
  return {
    jobId: input.jobId,
    state: 'COMPLETE',
    resultAvailability: 'unavailable',
    message: `Omni confirmed the AI job as COMPLETE. Continue in Omni Chat to inspect and refine the ${artifactLabel}. OmniKit has not verified that the requested ${artifactLabel} exists or satisfies the brief.`,
    actionSummaries: [],
    conversationId: '',
    chatUrl: input.chatUrl,
    documentReferences: [],
    artifactState: 'not-returned',
    actionReviewIssues: [],
    mode: input.mode,
    requestedName: input.requestedName,
  };
}

function completedReportedCreationOutcome(input: {
  mode: 'dashboard' | 'app';
  jobId: string;
  chatUrl: string;
  requestedName: string;
}): AIContentJobOutcome & { mode: AIContentMode; requestedName: string } {
  const artifactLabel = input.mode === 'app' ? 'App' : 'dashboard';
  return {
    jobId: input.jobId,
    state: 'COMPLETE',
    resultAvailability: 'available',
    message: `Omni returned the expected ${artifactLabel} creation action, but no documented artifact identifier. Continue in Omni Chat and reconcile the exact ${artifactLabel} before relying on it or starting another creation job.`,
    actionSummaries: [],
    conversationId: '',
    chatUrl: input.chatUrl,
    documentReferences: [],
    artifactState: 'reported-created-unverified',
    actionReviewIssues: [],
    mode: input.mode,
    requestedName: input.requestedName,
  };
}

const RESTORED_CREATION_STATUS_REVIEW_ISSUE = 'ACTION_EVIDENCE_REQUIRES_REVIEW: The completed job returned incomplete, unknown, or potentially mutating action evidence. Inspect the exact job in Omni.';
const RESTORED_NO_WRITE_RESPONSE_REVIEW_ISSUE = 'RESPONSE_EVIDENCE_REQUIRES_REVIEW: The completed no-write request returned action or postcondition evidence that OmniKit could not verify. Inspect the exact job in Omni.';

function completedCreationStatusUnverifiedOutcome(input: {
  mode: 'dashboard' | 'app';
  jobId: string;
  chatUrl: string;
  requestedName: string;
}): AIContentJobOutcome & { mode: AIContentMode; requestedName: string } {
  const artifactLabel = input.mode === 'app' ? 'App' : 'dashboard';
  return {
    jobId: input.jobId,
    state: 'COMPLETE',
    resultAvailability: 'available',
    message: `Omni completed the ${artifactLabel} job, but its action evidence was incomplete, unknown, or potentially mutating. OmniKit cannot determine whether the requested ${artifactLabel} was created. Inspect this exact job in Omni before another creation request.`,
    actionSummaries: [],
    conversationId: '',
    chatUrl: input.chatUrl,
    documentReferences: [],
    artifactState: 'creation-status-unverified',
    actionReviewIssues: [RESTORED_CREATION_STATUS_REVIEW_ISSUE],
    mode: input.mode,
    requestedName: input.requestedName,
  };
}

function completedNoWriteResponseReviewOutcome(input: {
  mode: 'review' | 'report';
  jobId: string;
  chatUrl: string;
  requestedName: string;
}): AIContentJobOutcome & { mode: AIContentMode; requestedName: string } {
  const responseLabel = input.mode === 'review' ? 'dashboard review' : 'narrative report';
  return {
    jobId: input.jobId,
    state: 'COMPLETE',
    resultAvailability: 'available',
    message: `Omni completed the ${responseLabel}, but its returned action or scoped-model postcondition evidence still requires reconciliation. Inspect this exact job in Omni before submitting another request.`,
    actionSummaries: [],
    conversationId: '',
    chatUrl: input.chatUrl,
    documentReferences: [],
    artifactState: 'not-returned',
    actionReviewIssues: [RESTORED_NO_WRITE_RESPONSE_REVIEW_ISSUE],
    mode: input.mode,
    requestedName: input.requestedName,
  };
}

export function AIContentStudioPage() {
  const { connection } = useConnection();
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const logOperation = useLogOperation();
  const [form, dispatchForm] = useReducer(aiContentStudioFormReducer, initialMode(), initialAIContentStudioForm);
  const { mode, modelId, topicName, contentName, brief, approvedScope } = form;
  const [models, setModels] = useState<OmniModel[]>([]);
  const [connectionCatalog, setConnectionCatalog] = useState<{
    scopeKey: string;
    connections: StudioModelConnectionRecord[];
  } | null>(null);
  const [topics, setTopics] = useState<OmniTopic[]>([]);
  const [modelInventoryPhase, setModelInventoryPhase] = useState<'loading' | 'verified' | 'failed'>('loading');
  const [modelInventoryError, setModelInventoryError] = useState('');
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [dashboards, setDashboards] = useState<CachedDashboard[]>([]);
  const [dashboardsSyncedAt, setDashboardsSyncedAt] = useState<number | null>(null);
  const [loadingDashboards, setLoadingDashboards] = useState(false);
  const [selectedDashboard, setSelectedDashboard] = useState<CachedDashboard | null>(null);
  const [dashboard, setDashboard] = useState<InspectedContentDashboard | null>(null);
  const [inspectingDashboard, setInspectingDashboard] = useState(false);
  const [attachments, setAttachments] = useState<AIContentAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [attachmentReadsPending, setAttachmentReadsPending] = useState(0);
  const [reviewRenderNotice, setReviewRenderNotice] = useState('');
  const [acknowledgedReconciliation, setAcknowledgedReconciliation] = useState(false);
  const [ambiguousCreate, setAmbiguousCreate] = useState<RunReconciliation | null>(null);
  const [unresolvedRun, setUnresolvedRun] = useState<RunReconciliation | null>(null);
  const [running, setRunning] = useState(false);
  const [terminalCompletePendingResult, setTerminalCompletePendingResult] = useState(false);
  const [recoveringResult, setRecoveringResult] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [copiedJobId, setCopiedJobId] = useState(false);
  const [jobId, setJobId] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<(AIContentJobOutcome & { mode: AIContentMode; requestedName: string }) | null>(null);
  const [unexpectedActions, setUnexpectedActions] = useState<string[]>([]);
  const [modelMutationCheck, setModelMutationCheck] = useState<AIContentModelMutationCheck | undefined>();
  const abortRef = useRef<AbortController | null>(null);
  const submitLockRef = useRef(false);
  const submittedScopeRef = useRef('');
  const attachmentsRef = useRef<AIContentAttachment[]>([]);
  const attachmentEpochRef = useRef(0);
  const attachmentReadsPendingRef = useRef(0);
  const attachmentQueueRef = useRef<Promise<void>>(Promise.resolve());
  const connectionKeyRef = useRef(connectionKey);
  const runningContextRef = useRef<RunContext | null>(null);
  const unresolvedRunRef = useRef<UnresolvedRun | null>(null);
  const lifecycleTokenRef = useRef(0);
  const loggedTerminalRunsRef = useRef(new Set<number>());
  const modelInventoryRequestRef = useRef(0);
  const modelInventoryAbortRef = useRef<AbortController | null>(null);
  const connectionCatalogAbortRef = useRef<AbortController | null>(null);
  const topicsAbortRef = useRef<AbortController | null>(null);
  connectionKeyRef.current = connectionKey;

  const reviewDashboards = useMemo(() => {
    const namesByConnectionId = new Map(
      connectionCatalog?.scopeKey === connectionKey
        ? connectionCatalog.connections.map((candidate) => [candidate.id, candidate.name])
        : [],
    );
    return dashboards.map((candidate) => {
      const authoritativeName = candidate.connectionId
        ? namesByConnectionId.get(candidate.connectionId)
        : undefined;
      const connectionVerifiedDashboard = { ...candidate };
      delete connectionVerifiedDashboard.connectionName;
      return authoritativeName
        ? { ...connectionVerifiedDashboard, connectionName: authoritativeName }
        : connectionVerifiedDashboard;
    });
  }, [connectionCatalog, connectionKey, dashboards]);

  const loadingModels = modelInventoryPhase === 'loading';
  const selectedModelKind = models.find((model) => model.id === modelId)?.kind;

  const scopeFingerprint = useMemo(() => `ai-content-scope-sha256:${sha256Text(JSON.stringify({
    connectionKey,
    mode,
    modelId,
    modelKind: selectedModelKind || null,
    topicName,
    contentName: contentName.trim(),
    brief,
    attachments: attachments.map((attachment) => attachment.id),
    dashboardEvidence: dashboard ? projectDashboardEvidence(dashboard) : null,
    reviewRender: mode === 'review' && dashboard
      ? { dashboardId: dashboard.id, format: 'png', fullDashboard: true }
      : null,
  }))}`, [attachments, brief, connectionKey, contentName, dashboard, mode, modelId, selectedModelKind, topicName]);

  const modeInfo = aiContentModeDetail(mode);
  const ModeIcon = modeInfo.icon;
  const isCreationMode = mode === 'dashboard' || mode === 'app';
  const reconciliationRequired = Boolean(unresolvedRun || ambiguousCreate);
  const interactionLocked = running || recoveringResult || cancelling || reconciliationRequired;
  const reviewEligibleModelIds = dashboard?.eligibleModelIds || [];
  const effectiveModelId = mode === 'review' ? dashboard?.modelId || modelId : modelId;
  const effectiveModel = models.find((candidate) => candidate.id === effectiveModelId);
  const effectiveModelApprovalName = effectiveModel?.name.trim()
    || (effectiveModelId ? 'selected verified model' : '(select a verified SHARED model)');
  const effectiveModelApprovalTitle = effectiveModelId ? `Model ID: ${effectiveModelId}` : undefined;
  const reviewModelResolutionBlocked = mode === 'review'
    && Boolean(dashboard?.modelResolutionBlockedReason);
  const effectiveModelKind = effectiveModel?.kind;
  const verifiedEffectiveModelKind = effectiveModelKind === 'SHARED'
    ? effectiveModelKind
    : null;
  const effectiveTopicName = topicName;
  const agentBriefReady = mode === 'review' ? true : aiContentBriefIsReady(mode, brief);
  const approvedCurrentScope = approvedScope === scopeFingerprint;
  const approvalPrerequisitesReady = Boolean(
    attachmentReadsPending === 0
    && attachmentReadsPendingRef.current === 0
    && effectiveModelId
    && modelInventoryPhase === 'verified'
    && verifiedEffectiveModelKind
    && (mode !== 'review' || dashboard)
    && !reviewModelResolutionBlocked
    && (!isCreationMode || contentName.trim())
    && agentBriefReady
  );
  const missingAppApprovalRequirements = mode === 'app'
    ? [
        !contentName.trim() ? 'content name' : '',
        !effectiveModelId || modelInventoryPhase !== 'verified' || !verifiedEffectiveModelKind ? 'verified shared model' : '',
        !brief.objective.trim() ? 'outcome or decision' : '',
        !brief.requiredContent.trim() ? 'required data and content' : '',
        !brief.layoutAndInteractions.trim() ? 'layout and interactions' : '',
        !brief.acceptanceCriteria.trim() ? 'acceptance criteria' : '',
        attachmentReadsPending > 0 || attachmentReadsPendingRef.current > 0 ? 'finished attachment processing' : '',
      ].filter(Boolean)
    : [];
  const canRun = Boolean(
    !running
    && !cancelling
    && !unresolvedRun
    && !ambiguousCreate
    && attachmentReadsPending === 0
    && attachmentReadsPendingRef.current === 0
    && effectiveModelId
    && modelInventoryPhase === 'verified'
    && verifiedEffectiveModelKind
    && (mode !== 'review' || dashboard)
    && !reviewModelResolutionBlocked
    && agentBriefReady
    && (!isCreationMode || contentName.trim())
    && approvedCurrentScope
  );

  const logTerminal = useCallback((
    context: RunContext,
    status: 'response_received' | 'failed' | 'cancelled',
    counts: { itemCount?: number; successCount?: number; failureCount?: number } = {},
  ) => {
    if (loggedTerminalRunsRef.current.has(context.token)) return;
    loggedTerminalRunsRef.current.add(context.token);
    logOperation('ai_query', `AI Content Studio ${context.mode} ${status}; job ${shortJobId(context.jobId)}`, {
      itemCount: counts.itemCount ?? 1,
      // A successful AI request is not evidence that a dashboard or App exists.
      // This count records receipt of a contract-valid response only.
      successCount: counts.successCount ?? (status === 'response_received' ? 1 : 0),
      failureCount: counts.failureCount ?? (status === 'failed' ? 1 : 0),
      durationMs: Math.max(0, Date.now() - context.startedAt),
      details: {
        mode: context.mode,
        jobId: shortJobId(context.jobId),
        status,
      },
    });
  }, [logOperation]);

  const clearRunOutput = useCallback(() => {
    setOutcome(null);
    setUnexpectedActions([]);
    setModelMutationCheck(undefined);
    setError('');
    setProgress('');
    setJobId('');
    setReviewRenderNotice('');
  }, []);

  const cancelContext = useCallback(async (context: RunContext, message: string) => {
    const cancellationToken = lifecycleTokenRef.current + 1;
    lifecycleTokenRef.current = cancellationToken;
    abortRef.current?.abort();

    if (context.terminalState === 'COMPLETE') {
      const reason = context.mode === 'review'
        ? 'Omni reported the review job complete before the local result read stopped. The review may already be available.'
        : context.mode === 'report'
          ? 'Omni reported the report job complete before the local result read stopped. The narrative response may already be available.'
          : 'Omni reported the job complete before the local result read stopped. The requested artifact may already exist.';
      const unresolved: UnresolvedRun = {
        ...context,
        token: cancellationToken,
        reason,
        reasonCode: 'result-unavailable',
      };
      runningContextRef.current = unresolved;
      unresolvedRunRef.current = unresolved;
      abortRef.current = null;
      submitLockRef.current = false;
      setRunning(false);
      setTerminalCompletePendingResult(false);
      setCancelling(false);
      setJobId(context.jobId);
      setUnresolvedRun(reconciliationView(unresolved, reason, unresolved.reasonCode));
      setAcknowledgedReconciliation(false);
      if (isCreationHandoffMode(context.mode)) {
        setOutcome(completedCreationHandoffOutcome({
          mode: context.mode,
          jobId: context.jobId,
          chatUrl: context.chatUrl,
          requestedName: '',
        }));
        setUnexpectedActions([]);
        setModelMutationCheck(undefined);
        setError('');
        setProgress('Omni confirmed the job as COMPLETE. Continue in Omni Chat, or retry the result-only read. No cancellation or new job was sent.');
      } else {
        setProgress(`${message} Omni already reported COMPLETE, so no cancellation was sent.`);
      }
      return;
    }

    setCancelling(true);
    setProgress('Cancelling…');

    if (!context.jobId && !context.submissionStarted) {
      if (lifecycleTokenRef.current !== cancellationToken) return;
      runningContextRef.current = null;
      abortRef.current = null;
      submitLockRef.current = false;
      setRunning(false);
      setCancelling(false);
      setProgress(message);
      return;
    }

    if (!context.jobId) {
      if (lifecycleTokenRef.current !== cancellationToken) return;
      runningContextRef.current = null;
      abortRef.current = null;
      submitLockRef.current = false;
      setRunning(false);
      setCancelling(false);
      setAmbiguousCreate(reconciliationView(
        context,
        'Omni did not return a job ID.',
        'create-acceptance-unknown',
      ));
      setAcknowledgedReconciliation(false);
      setProgress(`${message} Omni had not returned a job ID, so acceptance cannot be reconciled automatically.`);
      return;
    }

    try {
      const cancelled = await cancelAiContentStudioJob(context.baseUrl, context.apiKey, context.jobId);
      if (lifecycleTokenRef.current !== cancellationToken) return;
      const cancelledState = String(cancelled.state || cancelled.status || '').trim().toUpperCase();
      if (cancelledState !== 'CANCELLED') {
        throw new Error(`Omni returned ${cancelledState || 'an unknown state'} instead of a confirmed cancelled state.`);
      }
      logTerminal(context, 'cancelled', { successCount: 0, failureCount: 0 });
      unresolvedRunRef.current = null;
      setUnresolvedRun(null);
      setAmbiguousCreate(null);
      setAcknowledgedReconciliation(false);
      setProgress('Cancellation confirmed by Omni.');
    } catch (cause) {
      if (lifecycleTokenRef.current !== cancellationToken) return;
      const unresolved = {
        ...context,
        reason: cause instanceof Error ? cause.message : 'Omni did not confirm cancellation.',
        reasonCode: 'poll-unavailable' as const,
      };
      unresolvedRunRef.current = unresolved;
      setUnresolvedRun(reconciliationView(unresolved, unresolved.reason, unresolved.reasonCode));
      setError(cause instanceof Error
        ? `The local wait stopped, but Omni did not confirm cancellation: ${cause.message}`
        : 'The local wait stopped, but Omni did not confirm cancellation.');
    } finally {
      if (lifecycleTokenRef.current === cancellationToken) {
        runningContextRef.current = null;
        abortRef.current = null;
        submitLockRef.current = false;
        setRunning(false);
        setCancelling(false);
      }
    }
  }, [logTerminal]);

  useEffect(() => {
    const priorRun = runningContextRef.current || unresolvedRunRef.current;
    const connectionToken = lifecycleTokenRef.current + 1;
    lifecycleTokenRef.current = connectionToken;
    abortRef.current?.abort();
    abortRef.current = null;
    runningContextRef.current = null;
    submittedScopeRef.current = '';
    setRunning(false);
    setTerminalCompletePendingResult(false);
    setRecoveringResult(false);
    setCopiedJobId(false);
    setCancelling(Boolean(priorRun?.jobId && priorRun.terminalState !== 'COMPLETE'));
    setModels([]);
    setTopics([]);
    dispatchForm({ type: 'reset-for-connection' });
    setModelInventoryPhase('loading');
    setModelInventoryError('');
    setConnectionCatalog(null);
    setLoadingTopics(false);
    setLoadingDashboards(false);
    setInspectingDashboard(false);
    setSelectedDashboard(null);
    setDashboard(null);
    attachmentEpochRef.current += 1;
    attachmentReadsPendingRef.current = 0;
    attachmentsRef.current = [];
    setAttachments([]);
    setAttachmentError('');
    setAttachmentReadsPending(0);
    setAcknowledgedReconciliation(false);
    setAmbiguousCreate(priorRun && !priorRun.jobId && priorRun.submissionStarted
      ? reconciliationView(
          priorRun,
          'The prior request may have been accepted before the instance changed.',
          'create-acceptance-unknown',
        )
      : null);
    unresolvedRunRef.current = null;
    setUnresolvedRun(null);
    clearRunOutput();
    const cached = dashboardCache.load(connectionKey);
    setDashboards(cached?.data || []);
    setDashboardsSyncedAt(cached?.savedAt || null);
    const restored = loadCompletedReconciliation(
      connectionKey,
      connection.instanceId || 'manual',
      connection.baseUrl,
    );
    if (restored) {
      const existingOutcome = restored.mode === 'review'
        ? 'The review may already be available.'
        : restored.mode === 'report'
          ? 'The narrative response may already be available.'
          : 'The requested artifact may already exist.';
      const reason = restored.reasonCode === 'result-contract-mismatch'
        ? `Omni reported this job complete, but its result did not match the documented AI response contract. ${existingOutcome}`
        : restored.reasonCode === 'completed-result-validation'
          ? `Omni reported this job complete, but its returned result did not pass OmniKit’s local validation. ${existingOutcome}`
          : restored.reasonCode === 'artifact-unverified'
            ? `Omni returned the expected creation action, but no verifiable artifact identifier. ${existingOutcome}`
            : restored.reasonCode === 'creation-status-unverified'
              ? `Omni completed this job, but its action evidence was incomplete, unknown, or potentially mutating. ${existingOutcome}`
              : restored.reasonCode === 'response-review-required'
                ? `Omni completed this no-write request, but its action or scoped-model postcondition evidence still requires reconciliation. ${existingOutcome}`
                : `Omni reported this job complete, but OmniKit could not read its structured result. ${existingOutcome}`;
      const restoredContext: UnresolvedRun = {
        token: connectionToken,
        scope: `restored-complete-job:${restored.jobId}`,
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        jobId: restored.jobId,
        chatUrl: restored.chatUrl,
        startedAt: restored.startedAt,
        mode: restored.mode,
        submissionStarted: true,
        terminalState: 'COMPLETE',
        reason,
        reasonCode: restored.reasonCode,
      };
      unresolvedRunRef.current = restoredContext;
      runningContextRef.current = restoredContext;
      dispatchForm({ type: 'change-mode', mode: restored.mode });
      setUnresolvedRun(reconciliationView(restoredContext, reason, restoredContext.reasonCode));
      if (isCreationHandoffMode(restored.mode)) {
        setOutcome(restored.reasonCode === 'artifact-unverified'
          ? completedReportedCreationOutcome({
              mode: restored.mode,
              jobId: restored.jobId,
              chatUrl: restored.chatUrl,
              requestedName: '',
            })
          : restored.reasonCode === 'creation-status-unverified'
            ? completedCreationStatusUnverifiedOutcome({
                mode: restored.mode,
                jobId: restored.jobId,
                chatUrl: restored.chatUrl,
                requestedName: '',
              })
            : completedCreationHandoffOutcome({
                mode: restored.mode,
                jobId: restored.jobId,
                chatUrl: restored.chatUrl,
                requestedName: '',
              }));
        setUnexpectedActions(restored.reasonCode === 'creation-status-unverified'
          ? [RESTORED_CREATION_STATUS_REVIEW_ISSUE]
          : []);
        setModelMutationCheck(undefined);
        setError('');
        setProgress(restored.reasonCode === 'artifact-unverified'
          ? 'Omni completed the job and reported creation. Reconcile the exact artifact in Omni before starting another creation job.'
          : restored.reasonCode === 'creation-status-unverified'
            ? 'Omni completed the job, but its creation status is unverified. Another creation job remains locked until this exact job is reconciled in Omni.'
            : 'Omni confirmed the job as COMPLETE. Continue in Omni Chat, or retry the result-only read. No new job will be created.');
      } else if (restored.reasonCode === 'response-review-required' && isNoWriteAgentMode(restored.mode)) {
        setOutcome(completedNoWriteResponseReviewOutcome({
          mode: restored.mode,
          jobId: restored.jobId,
          chatUrl: restored.chatUrl,
          requestedName: restored.mode === 'review' ? 'Dashboard review' : 'Narrative report',
        }));
        setUnexpectedActions([RESTORED_NO_WRITE_RESPONSE_REVIEW_ISSUE]);
        setModelMutationCheck(unavailableModelMutationCheck(
          'The page was restored after completion, so the original pre/post model comparison is not retained locally.',
        ));
        setError('');
        setProgress(`Omni completed the ${restored.mode === 'review' ? 'review' : 'report'} request, but its response evidence still requires reconciliation before another request.`);
      } else {
        setError(reason);
        setProgress('The completed job is locked for result recovery or manual reconciliation.');
      }
      setJobId(restored.jobId);
    }
    if (priorRun?.jobId && priorRun.terminalState !== 'COMPLETE') {
      void cancelAiContentStudioJob(priorRun.baseUrl, priorRun.apiKey, priorRun.jobId)
        .then((cancelled) => {
          if (lifecycleTokenRef.current !== connectionToken) return;
          const state = String(cancelled.state || cancelled.status || '').trim().toUpperCase();
          if (state !== 'CANCELLED') throw new Error(`Omni returned ${state || 'an unknown state'} instead of a confirmed cancelled state.`);
          logTerminal(priorRun, 'cancelled', { successCount: 0, failureCount: 0 });
          setCancelling(false);
          setProgress('The prior instance job was cancelled.');
        })
        .catch((cause) => {
          if (lifecycleTokenRef.current !== connectionToken) return;
          setCancelling(false);
          const unresolved = {
            ...priorRun,
            reason: cause instanceof Error ? cause.message : 'Omni did not confirm cancellation.',
            reasonCode: 'poll-unavailable' as const,
          };
          unresolvedRunRef.current = unresolved;
          setUnresolvedRun(reconciliationView(unresolved, unresolved.reason, unresolved.reasonCode));
          setError('The prior instance job could not be confirmed cancelled. Reconcile it before starting another job.');
        });
    }
  }, [clearRunOutput, connection.apiKey, connection.baseUrl, connection.instanceId, connectionKey, logTerminal]);

  useEffect(() => {
    if (!unresolvedRun) return;
    const secureContext = unresolvedRunRef.current;
    if (
      !secureContext
      || secureContext.jobId !== unresolvedRun.jobId
      || secureContext.baseUrl !== connection.baseUrl
      || secureContext.apiKey !== connection.apiKey
    ) return;
    storeCompletedReconciliation(
      connectionKey,
      connection.instanceId || 'manual',
      unresolvedRun,
    );
  }, [connection.apiKey, connection.baseUrl, connection.instanceId, connectionKey, unresolvedRun]);

  useEffect(() => () => {
    const activeRun = runningContextRef.current || unresolvedRunRef.current;
    abortRef.current?.abort();
    if (activeRun?.jobId && activeRun.terminalState !== 'COMPLETE') {
      void cancelAiContentStudioJob(activeRun.baseUrl, activeRun.apiKey, activeRun.jobId).catch(() => undefined);
    }
    runningContextRef.current = null;
    unresolvedRunRef.current = null;
    lifecycleTokenRef.current += 1;
    submitLockRef.current = false;
  }, []);

  const refreshModelInventory = useCallback(async (
    forceRefresh = false,
  ): Promise<OmniModel[] | null> => {
    if (!hasActiveSavedVaultConnection(connection)) return null;
    modelInventoryAbortRef.current?.abort();
    connectionCatalogAbortRef.current?.abort();
    const controller = new AbortController();
    const connectionCatalogController = new AbortController();
    modelInventoryAbortRef.current = controller;
    connectionCatalogAbortRef.current = connectionCatalogController;
    const requestId = modelInventoryRequestRef.current + 1;
    modelInventoryRequestRef.current = requestId;
    const requestConnectionKey = connectionKey;
    setModelInventoryPhase('loading');
    setModelInventoryError('');
    setConnectionCatalog(null);

    // Connection names come from Omni's documented connection catalog, not
    // from model or document display metadata. Keep this optional read off the
    // critical model-verification path so a slow or unavailable catalog never
    // blocks dashboard review.
    const connectionCatalogResult = listConnections(
      connection.baseUrl,
      connection.apiKey,
      { forceRefresh, signal: connectionCatalogController.signal },
    ).then(
      (value) => ({
        status: 'fulfilled' as const,
        connections: parseStudioConnectionNamesResponse(value),
      }),
      () => ({ status: 'rejected' as const }),
    );

    try {
      const nextModels = await loadAIContentModelInventory(
        connection.baseUrl,
        connection.apiKey,
        forceRefresh,
        undefined,
        controller.signal,
      );
      if (
        modelInventoryRequestRef.current !== requestId
        || !isActiveConnectionRequest(requestConnectionKey)
      ) return null;
      // Only the documented connection catalog may contribute display names.
      // Strip any speculative model-level label before the optional catalog read.
      setModels(applyStudioConnectionNames(nextModels, []));
      setModelInventoryPhase('verified');
      void connectionCatalogResult.then((result) => {
        if (
          result.status !== 'fulfilled'
          || connectionCatalogController.signal.aborted
          || modelInventoryRequestRef.current !== requestId
          || !isActiveConnectionRequest(requestConnectionKey)
        ) return;
        // The catalog lands in its own state and nowhere else. reviewDashboards
        // reads display names from here, which is the only thing the catalog is
        // for.
        //
        // It must not be merged back into `models`. Nothing reads
        // model.connectionName, but writing it replaced the `models` array
        // identity, which re-ran every value and effect derived from it — and
        // that could flip `canRun` back to false after the operator had already
        // approved the scope. On a fast connection the catalog lands before the
        // operator interacts, so it looked fine; on a slow one the run button
        // greyed out under them, and on CI it timed out waiting for a button
        // that had been enabled a moment earlier. Keeping the verified inventory
        // immutable after verification is what makes readiness stable.
        setConnectionCatalog({
          scopeKey: requestConnectionKey,
          connections: result.connections,
        });
      }).finally(() => {
        if (connectionCatalogAbortRef.current === connectionCatalogController) {
          connectionCatalogAbortRef.current = null;
        }
      });
      return nextModels;
    } catch (cause) {
      connectionCatalogController.abort();
      if (connectionCatalogAbortRef.current === connectionCatalogController) {
        connectionCatalogAbortRef.current = null;
      }
      if (controller.signal.aborted || isAbortError(cause)) return null;
      if (
        modelInventoryRequestRef.current !== requestId
        || !isActiveConnectionRequest(requestConnectionKey)
      ) return null;
      setModels([]);
      setModelInventoryPhase('failed');
      setModelInventoryError(aiContentModelInventoryError(cause));
      return null;
    } finally {
      if (modelInventoryAbortRef.current === controller) modelInventoryAbortRef.current = null;
    }
  }, [connection, connectionKey, isActiveConnectionRequest]);

  useEffect(() => {
    if (!hasActiveSavedVaultConnection(connection)) {
      modelInventoryRequestRef.current += 1;
      modelInventoryAbortRef.current?.abort();
      modelInventoryAbortRef.current = null;
      connectionCatalogAbortRef.current?.abort();
      connectionCatalogAbortRef.current = null;
      setConnectionCatalog(null);
      setModels([]);
      return undefined;
    }
    // A saved-instance API key can rotate without changing its browser-side
    // vault reference. Bypass the short metadata cache on each verified mount
    // so a newly connected credential cannot inherit the prior key's inventory.
    void refreshModelInventory(true);
    return () => {
      modelInventoryRequestRef.current += 1;
      modelInventoryAbortRef.current?.abort();
      modelInventoryAbortRef.current = null;
      connectionCatalogAbortRef.current?.abort();
      connectionCatalogAbortRef.current = null;
    };
  }, [connection, refreshModelInventory]);

  useEffect(() => {
    if (
      modelInventoryPhase === 'verified'
      && modelId
      && !models.some((model) => model.id === modelId)
    ) {
      dispatchForm({ type: 'change-model', modelId: '' });
      clearRunOutput();
    }
  }, [clearRunOutput, modelId, modelInventoryPhase, models]);

  useEffect(() => {
    topicsAbortRef.current?.abort();
    const controller = new AbortController();
    topicsAbortRef.current = controller;
    if (!modelId) {
      setTopics([]);
      dispatchForm({ type: 'sync-topics', availableTopics: [] });
      setLoadingTopics(false);
      return () => {
        controller.abort();
        if (topicsAbortRef.current === controller) topicsAbortRef.current = null;
      };
    }
    setLoadingTopics(true);
    void listTopics(connection.baseUrl, connection.apiKey, modelId, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) {
          setTopics(Array.isArray(response) ? response : []);
          dispatchForm({ type: 'sync-topics', availableTopics: response.map((topic) => topic.name) });
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted && !isAbortError(cause)) setTopics([]);
      })
      .finally(() => {
        if (topicsAbortRef.current !== controller) return;
        topicsAbortRef.current = null;
        if (!controller.signal.aborted) setLoadingTopics(false);
      });
    return () => {
      controller.abort();
      if (topicsAbortRef.current === controller) topicsAbortRef.current = null;
    };
  }, [connection.apiKey, connection.baseUrl, modelId]);

  useEffect(() => {
    const activeRun = runningContextRef.current;
    if (!activeRun || activeRun.terminalState === 'COMPLETE' || activeRun.scope === scopeFingerprint) return;
    void cancelContext(activeRun, 'The local wait stopped because its scope changed.');
  }, [cancelContext, scopeFingerprint]);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length || running || cancelling) return;
    const remainingReviewSlots = mode === 'review'
      ? Math.max(0, MAX_CONTENT_ATTACHMENTS - 1 - attachmentsRef.current.length)
      : files.length;
    const requestedFiles = files.slice(0, remainingReviewSlots);
    const reservedSlotMessage = requestedFiles.length < files.length
      ? `Review reserves one attachment slot for the automatic dashboard render. Add no more than ${MAX_CONTENT_ATTACHMENTS - 1} optional references.`
      : '';
    if (requestedFiles.length === 0) {
      setAttachmentError(reservedSlotMessage);
      return;
    }
    const requestedConnectionKey = connectionKey;
    const requestedEpoch = attachmentEpochRef.current;
    attachmentReadsPendingRef.current += 1;
    setAttachmentReadsPending(attachmentReadsPendingRef.current);
    const work = attachmentQueueRef.current
      .then(async () => {
        if (connectionKeyRef.current !== requestedConnectionKey || attachmentEpochRef.current !== requestedEpoch) return;
        try {
          const result = await addContentAttachments(attachmentsRef.current, requestedFiles);
          if (connectionKeyRef.current !== requestedConnectionKey || attachmentEpochRef.current !== requestedEpoch) return;
          attachmentsRef.current = result.attachments;
          setAttachments(result.attachments);
          setAttachmentError([reservedSlotMessage, ...result.rejected].filter(Boolean).join(' '));
          clearRunOutput();
        } catch {
          if (connectionKeyRef.current === requestedConnectionKey && attachmentEpochRef.current === requestedEpoch) {
            setAttachmentError('One or more attachments could not be read. Choose the files again.');
          }
        }
      })
      .finally(() => {
        if (connectionKeyRef.current !== requestedConnectionKey || attachmentEpochRef.current !== requestedEpoch) return;
        attachmentReadsPendingRef.current = Math.max(0, attachmentReadsPendingRef.current - 1);
        setAttachmentReadsPending(attachmentReadsPendingRef.current);
      });
    attachmentQueueRef.current = work.catch(() => undefined);
    await work;
  }, [cancelling, clearRunOutput, connectionKey, mode, running]);

  function removeAttachment(id: string) {
    attachmentEpochRef.current += 1;
    const next = attachmentsRef.current.filter((attachment) => attachment.id !== id);
    attachmentsRef.current = next;
    setAttachments(next);
    clearRunOutput();
  }

  function pasteAttachments(event: ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  }

  async function refreshDashboards() {
    const requestKey = connectionKey;
    setLoadingDashboards(true);
    setError('');
    try {
      const next = await fetchDashboardList(connection.baseUrl, connection.apiKey);
      if (!isActiveConnectionRequest(requestKey)) return;
      setDashboards(next);
      setDashboardsSyncedAt(Date.now());
      dashboardCache.save(connectionKey, next);
    } catch (cause) {
      if (isActiveConnectionRequest(requestKey)) setError(cause instanceof Error ? cause.message : 'Could not load dashboards.');
    } finally {
      if (isActiveConnectionRequest(requestKey)) setLoadingDashboards(false);
    }
  }

  async function inspectDashboard(
    picked: CachedDashboard,
    inventoryOverride?: readonly OmniModel[],
  ) {
    const verifiedModels = inventoryOverride || models;
    if (!inventoryOverride && modelInventoryPhase !== 'verified') {
      setError('Wait for the verified SHARED model inventory before inspecting a dashboard.');
      return;
    }
    const requestKey = connectionKey;
    clearRunOutput();
    setSelectedDashboard(picked);
    setDashboard(null);
    setInspectingDashboard(true);
    try {
      const summary = await fetchDashboardSummary(connection.baseUrl, connection.apiKey, picked.id);
      if (!isActiveConnectionRequest(requestKey)) return;
      const resolution = await resolveAIContentDashboardModels({
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        verifiedSharedModels: verifiedModels,
        evidence: {
          documentModelId: summary.documentModelId,
          workbookModelId: summary.workbookModelId,
          queryModelIds: summary.queryModelIds,
          connectionId: picked.connectionId,
          documentConnectionId: summary.documentConnectionId,
          documentModelReadError: summary.documentModelReadError,
        },
      });
      if (!isActiveConnectionRequest(requestKey)) return;
      const reviewModelId = !resolution.blockedReason && resolution.eligibleModelIds.length === 1
        ? resolution.eligibleModelIds[0]
        : undefined;
      setDashboard({
        id: picked.id,
        folderPath: picked.folderPath,
        connectionId: picked.connectionId || summary.documentConnectionId,
        ...summary,
        modelIds: resolution.detectedModelIds,
        eligibleModelIds: resolution.eligibleModelIds,
        canonicalModelIdByDetectedId: resolution.canonicalModelIdByDetectedId,
        modelResolutionBlockedReason: resolution.blockedReason,
        modelResolutionNotice: resolution.notice,
        modelId: reviewModelId,
      });
      dispatchForm({ type: 'set-review-scope', modelId: reviewModelId || '' });
    } catch (cause) {
      if (isActiveConnectionRequest(requestKey)) setError(cause instanceof Error ? cause.message : 'Could not inspect this dashboard.');
    } finally {
      if (isActiveConnectionRequest(requestKey)) setInspectingDashboard(false);
    }
  }

  async function retryReviewModelResolution() {
    const nextModels = await refreshModelInventory(true);
    if (nextModels && selectedDashboard) {
      await inspectDashboard(selectedDashboard, nextModels);
    }
  }

  async function startRun() {
    if (
      !canRun
      || submitLockRef.current
      || submittedScopeRef.current === scopeFingerprint
      || attachmentReadsPendingRef.current > 0
    ) return;
    if (!effectiveModelId || !verifiedEffectiveModelKind) return;
    const runDashboard = mode === 'review' ? dashboard : null;
    if (mode === 'review' && !runDashboard) return;
    submitLockRef.current = true;
    const runScope = scopeFingerprint;
    const runToken = lifecycleTokenRef.current + 1;
    lifecycleTokenRef.current = runToken;
    const controller = new AbortController();
    abortRef.current = controller;
    const context: RunContext = {
      token: runToken,
      scope: runScope,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      jobId: '',
      chatUrl: '',
      startedAt: Date.now(),
      mode,
      submissionStarted: false,
    };
    runningContextRef.current = context;
    unresolvedRunRef.current = null;
    setRunning(true);
    setTerminalCompletePendingResult(false);
    setCancelling(false);
    setError('');
    setOutcome(null);
    setUnexpectedActions([]);
    setJobId('');
    setUnresolvedRun(null);
    setAmbiguousCreate(null);
    setAcknowledgedReconciliation(false);
    setReviewRenderNotice('');

    let retainSecureContext = false;
    try {
      let runAttachments = [...attachments];
      let reviewRenderAttachmentName: string | undefined;
      if (mode === 'review' && runDashboard) {
        setProgress('Capturing the full dashboard render for visual review…');
        try {
          const captured = await captureDashboardReviewRender({
            baseUrl: connection.baseUrl,
            apiKey: connection.apiKey,
            dashboardId: runDashboard.id,
            dashboardName: runDashboard.name,
            userAttachments: runAttachments,
            signal: controller.signal,
            onStatusChange: (message) => {
              if (lifecycleTokenRef.current === runToken && runningContextRef.current?.token === runToken) {
                setProgress(message);
              }
            },
          });
          runAttachments = captured.attachments;
          reviewRenderAttachmentName = captured.renderAttachmentName;
          setReviewRenderNotice('The full dashboard PNG was captured automatically and included as the current visible-state evidence.');
        } catch {
          if (controller.signal.aborted) {
            throw new DOMException('The dashboard render was cancelled.', 'AbortError');
          }
          const fallbackImage = runAttachments.find((attachment) => attachment.contentType.startsWith('image/'));
          if (!fallbackImage || !hasReviewImageFallback(runAttachments)) {
            setError('Automatic dashboard render could not be captured. Add a screenshot image, then run Blobby review again.');
            setProgress('No AI job was submitted because visual review evidence was unavailable.');
            return;
          }
          reviewRenderAttachmentName = fallbackImage.name;
          setReviewRenderNotice('Automatic dashboard render could not be captured, so the uploaded screenshot was used as visual evidence.');
        }
      }

      const prompt = buildAIContentPrompt({
        mode,
        contentName: mode === 'review' && runDashboard ? runDashboard.name : contentName,
        brief,
        attachmentManifest: runAttachments.map(({ name, contentType }) => ({ name, contentType })),
        ...(mode === 'review' && runDashboard
          ? { dashboard: runDashboard, reviewRenderAttachmentName }
          : {}),
      });
      const requestBytes = new TextEncoder().encode(prompt).byteLength
        + runAttachments.reduce((sum, attachment) => sum + attachment.size, 0);
      if (requestBytes > MAX_CONTENT_REQUEST_BYTES) {
        setError('The one-shot brief and attachments exceed Omni’s 15 MiB request budget. Remove an attachment or shorten the brief.');
        return;
      }

      setProgress('Capturing a scoped model mutation baseline…');
      const modelSnapshotBefore = await captureAIContentModelSnapshot(
        connection.baseUrl,
        connection.apiKey,
        effectiveModelId,
        verifiedEffectiveModelKind,
      );
      if (
        controller.signal.aborted
        || lifecycleTokenRef.current !== runToken
        || runningContextRef.current?.scope !== runScope
      ) return;
      submittedScopeRef.current = runScope;
      dispatchForm({ type: 'clear-approval' });
      context.submissionStarted = true;
      const next = await runAIContentJob({
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        modelId: effectiveModelId,
        topicName: effectiveTopicName,
        prompt,
        attachments: runAttachments,
        mode,
        signal: controller.signal,
        scope: {
          key: runScope,
          isCurrent: (key) => key === scopeFingerprint
            && lifecycleTokenRef.current === runToken
            && runningContextRef.current?.token === runToken,
        },
        onJobCreated: (createdJobId, trustedChatUrl) => {
          if (lifecycleTokenRef.current !== runToken || runningContextRef.current?.token !== runToken) return;
          setJobId(createdJobId);
          runningContextRef.current.jobId = createdJobId;
          runningContextRef.current.chatUrl = trustedChatUrl || '';
        },
        onTerminal: (state, terminalJobId, trustedChatUrl) => {
          if (
            state !== 'COMPLETE'
            || lifecycleTokenRef.current !== runToken
            || runningContextRef.current?.token !== runToken
            || runningContextRef.current.scope !== runScope
            || runScope !== scopeFingerprint
            || !isActiveConnectionRequest(connectionKey)
          ) return;
          context.jobId = terminalJobId;
          context.chatUrl = trustedChatUrl || context.chatUrl;
          context.terminalState = 'COMPLETE';
          runningContextRef.current = context;
          setJobId(terminalJobId);
          setTerminalCompletePendingResult(true);
          setProgress('Omni reports the job as complete. Reading and validating the existing result…');
          storeCompletedReconciliation(
            connectionKey,
            connection.instanceId || 'manual',
            reconciliationView(
              context,
              mode === 'review'
                ? 'Omni reported the review job complete, but the structured result read is still pending. The review may already be available.'
                : mode === 'report'
                  ? 'Omni reported the report job complete, but the structured result read is still pending. The narrative response may already be available.'
                  : 'Omni reported the job complete, but the structured result read is still pending. The requested artifact may already exist.',
              'result-unavailable',
            ),
          );
        },
        onProgress: (message) => {
          if (lifecycleTokenRef.current === runToken && runningContextRef.current?.token === runToken) setProgress(message);
        },
      });
      if (
        controller.signal.aborted
        || lifecycleTokenRef.current !== runToken
        || runningContextRef.current?.token !== runToken
        || runningContextRef.current.scope !== runScope
        || runScope !== scopeFingerprint
      ) return;

      const unexpected = Array.from(new Set(next.actionReviewIssues));
      let mutationCheck: AIContentModelMutationCheck;
      try {
        setProgress('Rechecking the selected model and active branches…');
        const modelSnapshotAfter = await captureAIContentModelSnapshot(
          connection.baseUrl,
          connection.apiKey,
          effectiveModelId,
          verifiedEffectiveModelKind,
        );
        mutationCheck = compareAIContentModelSnapshots(modelSnapshotBefore, modelSnapshotAfter);
      } catch (cause) {
        mutationCheck = unavailableModelMutationCheck(cause instanceof Error ? cause.message : 'The post-run model snapshot could not be captured.');
      }
      const reconciledUnexpected = Array.from(new Set([...unexpected, ...mutationCheck.issues]));
      setUnexpectedActions(unexpected);
      setModelMutationCheck(mutationCheck);
      setOutcome({
        ...next,
        mode: context.mode,
        requestedName: mode === 'review' && runDashboard ? runDashboard.name : contentName.trim(),
      });
      setTerminalCompletePendingResult(false);
      context.jobId = next.jobId;
      context.chatUrl = next.chatUrl;
      context.terminalState = 'COMPLETE';
      const noWriteResponseNeedsReview = isNoWriteAgentMode(context.mode)
        && (
          mutationCheck.status !== 'unchanged'
          || unexpected.some(requiresNoWriteResponseHold)
        );
      if (noWriteResponseNeedsReview) {
        const responseLabel = context.mode === 'review' ? 'review' : 'report';
        const reason = `Omni completed the ${responseLabel} request, but its returned action or scoped-model postcondition evidence still requires reconciliation.`;
        const unresolved: UnresolvedRun = {
          ...context,
          reason,
          reasonCode: 'response-review-required',
        };
        runningContextRef.current = unresolved;
        unresolvedRunRef.current = unresolved;
        setUnresolvedRun(reconciliationView(unresolved, reason, unresolved.reasonCode));
        storeCompletedReconciliation(
          connectionKey,
          connection.instanceId || 'manual',
          reconciliationView(unresolved, reason, unresolved.reasonCode),
        );
        setAcknowledgedReconciliation(false);
        setProgress(`Omni completed the ${responseLabel} request, but another ${responseLabel} request remains locked until its response evidence is reconciled in Omni.`);
        retainSecureContext = true;
      } else if (
        isCreationHandoffMode(context.mode)
        && (
          next.artifactState === 'reported-created-unverified'
          || next.artifactState === 'creation-status-unverified'
        )
      ) {
        const creationStatusUnverified = next.artifactState === 'creation-status-unverified';
        const reason = creationStatusUnverified
          ? `Omni completed the ${context.mode === 'app' ? 'App' : 'dashboard'} job, but its action evidence was incomplete, unknown, or potentially mutating. The artifact may already exist.`
          : `Omni returned the expected ${context.mode === 'app' ? 'App' : 'dashboard'} creation action without a verifiable artifact identifier. The artifact may already exist.`;
        const unresolved: UnresolvedRun = {
          ...context,
          reason,
          reasonCode: creationStatusUnverified ? 'creation-status-unverified' : 'artifact-unverified',
        };
        runningContextRef.current = unresolved;
        unresolvedRunRef.current = unresolved;
        setUnresolvedRun(reconciliationView(unresolved, reason, unresolved.reasonCode));
        storeCompletedReconciliation(
          connectionKey,
          connection.instanceId || 'manual',
          reconciliationView(unresolved, reason, unresolved.reasonCode),
        );
        setAcknowledgedReconciliation(false);
        setProgress(creationStatusUnverified
          ? 'Omni completed the job, but its creation status is unverified. Another creation job remains locked until this exact job is reconciled in Omni.'
          : 'Omni completed the job and reported creation, but another create remains locked until the artifact is reconciled in Omni.');
        retainSecureContext = true;
      } else {
        clearStoredReconciliation(connectionKey);
        setProgress(reconciledUnexpected.length > 0 ? 'Completed with response details requiring review.' : 'Completed. The response and scoped model snapshot were checked.');
      }
      logTerminal(context, 'response_received', {
        itemCount: next.actionSummaries.length,
        successCount: 1,
        failureCount: 0,
      });
    } catch (cause) {
      if (lifecycleTokenRef.current !== runToken) return;
      if (cause instanceof AIContentCompletedResultValidationError) {
        context.jobId = cause.jobId;
        context.chatUrl = cause.chatUrl;
        context.terminalState = 'COMPLETE';
        const unresolved: UnresolvedRun = {
          ...context,
          reason: cause.message,
          reasonCode: 'completed-result-validation',
        };
        runningContextRef.current = unresolved;
        unresolvedRunRef.current = unresolved;
        setJobId(cause.jobId);
        setUnresolvedRun(reconciliationView(unresolved, cause.message, unresolved.reasonCode));
        setAcknowledgedReconciliation(false);
        if (isCreationHandoffMode(context.mode)) {
          setOutcome(completedCreationHandoffOutcome({
            mode: context.mode,
            jobId: cause.jobId,
            chatUrl: cause.chatUrl,
            requestedName: contentName.trim(),
          }));
          setUnexpectedActions([]);
          setModelMutationCheck(undefined);
          setError('');
          setProgress('Omni confirmed the job as COMPLETE. Continue in Omni Chat, or retry the result-only read. No new job will be created.');
        } else {
          setError(cause.message);
          setProgress('Omni reports the job complete. The returned result needs manual reconciliation after failing local validation.');
        }
        retainSecureContext = true;
      } else if (cause instanceof AIContentResultContractMismatchError) {
        context.jobId = cause.jobId;
        context.chatUrl = cause.chatUrl;
        context.terminalState = 'COMPLETE';
        const unresolved: UnresolvedRun = {
          ...context,
          reason: cause.message,
          reasonCode: 'result-contract-mismatch',
        };
        runningContextRef.current = unresolved;
        unresolvedRunRef.current = unresolved;
        setJobId(cause.jobId);
        setUnresolvedRun(reconciliationView(unresolved, cause.message, unresolved.reasonCode));
        setAcknowledgedReconciliation(false);
        if (isCreationHandoffMode(context.mode)) {
          setOutcome(completedCreationHandoffOutcome({
            mode: context.mode,
            jobId: cause.jobId,
            chatUrl: cause.chatUrl,
            requestedName: contentName.trim(),
          }));
          setUnexpectedActions([]);
          setModelMutationCheck(undefined);
          setError('');
          setProgress('Omni confirmed the job as COMPLETE. Continue in Omni Chat, or retry the result-only read. No new job will be created.');
        } else {
          setError(cause.message);
          setProgress('Omni reports the job complete. The result contract needs recovery or manual reconciliation.');
        }
        retainSecureContext = true;
      } else if (cause instanceof AIContentUnresolvedJobError) {
        context.jobId = cause.jobId;
        context.chatUrl = cause.chatUrl;
        const terminalWasComplete = context.terminalState === 'COMPLETE' || cause.reason === 'result-unavailable';
        context.terminalState = terminalWasComplete ? 'COMPLETE' : undefined;
        const reason = terminalWasComplete && cause.reason !== 'result-unavailable'
          ? mode === 'review'
            ? 'Omni reported the review job complete, but OmniKit could not finish reading its structured result before the local wait ended. The review may already be available.'
            : mode === 'report'
              ? 'Omni reported the report job complete, but OmniKit could not finish reading its structured result before the local wait ended. The narrative response may already be available.'
              : 'Omni reported the job complete, but OmniKit could not finish reading its structured result before the local wait ended. The requested artifact may already exist.'
          : cause.message;
        const reasonCode = terminalWasComplete ? 'result-unavailable' : cause.reason;
        const unresolved = { ...context, reason, reasonCode };
        runningContextRef.current = unresolved;
        unresolvedRunRef.current = unresolved;
        setJobId(cause.jobId);
        setUnresolvedRun(reconciliationView(unresolved, reason, reasonCode));
        setAcknowledgedReconciliation(false);
        if (terminalWasComplete && isCreationHandoffMode(context.mode)) {
          setOutcome(completedCreationHandoffOutcome({
            mode: context.mode,
            jobId: cause.jobId,
            chatUrl: cause.chatUrl,
            requestedName: contentName.trim(),
          }));
          setUnexpectedActions([]);
          setModelMutationCheck(undefined);
          setError('');
          setProgress('Omni confirmed the job as COMPLETE. Continue in Omni Chat, or retry the result-only read. No new job will be created.');
        } else {
          setError(reason);
          setProgress('The job state needs reconciliation in Omni.');
        }
        retainSecureContext = true;
      } else if (cause instanceof AIContentCreateAcceptanceUnknownError) {
        setAmbiguousCreate(reconciliationView(context, cause.message, 'create-acceptance-unknown'));
        setAcknowledgedReconciliation(false);
        setError(cause.message);
        setProgress('Job submission acceptance is unknown. Reconcile in Omni before retrying.');
      } else if (cause instanceof AIContentTerminalJobError) {
        context.jobId = cause.jobId;
        context.chatUrl = cause.chatUrl;
        if (cause.state === 'CANCELLED') {
          setProgress('Omni reported the job as cancelled.');
          logTerminal(context, 'cancelled', { successCount: 0, failureCount: 0 });
        } else {
          setError(cause.message);
          logTerminal(context, 'failed', { successCount: 0, failureCount: 1 });
        }
      } else if (cause instanceof DOMException && cause.name === 'AbortError') {
        setProgress('The local wait stopped. Cancellation confirmation is still required.');
      } else if (context.terminalState === 'COMPLETE' && context.jobId) {
        const reason = cause instanceof Error
          ? `Omni reported the job complete, but OmniKit could not safely finish the existing result: ${cause.message}`
          : 'Omni reported the job complete, but OmniKit could not safely finish the existing result.';
        const unresolved: UnresolvedRun = {
          ...context,
          reason,
          reasonCode: 'result-unavailable',
        };
        runningContextRef.current = unresolved;
        unresolvedRunRef.current = unresolved;
        setUnresolvedRun(reconciliationView(unresolved, reason, unresolved.reasonCode));
        setAcknowledgedReconciliation(false);
        if (isCreationHandoffMode(context.mode)) {
          setOutcome(completedCreationHandoffOutcome({
            mode: context.mode,
            jobId: context.jobId,
            chatUrl: context.chatUrl,
            requestedName: contentName.trim(),
          }));
          setUnexpectedActions([]);
          setModelMutationCheck(undefined);
          setError('');
          setProgress('Omni confirmed the job as COMPLETE. Continue in Omni Chat, or retry the result-only read. No new job will be created.');
        } else {
          setError(reason);
          setProgress('Omni reports the job complete. The existing result needs recovery or manual reconciliation.');
        }
        retainSecureContext = true;
      } else {
        setError(cause instanceof Error ? cause.message : 'The Omni AI job failed.');
        logTerminal(context, 'failed', { successCount: 0, failureCount: 1 });
      }
    } finally {
      if (lifecycleTokenRef.current === runToken) {
        submitLockRef.current = false;
        if (!retainSecureContext && runningContextRef.current?.token === runToken) runningContextRef.current = null;
        if (!retainSecureContext) {
          unresolvedRunRef.current = null;
        }
        abortRef.current = null;
        setRunning(false);
        setTerminalCompletePendingResult(false);
      }
    }
  }

  async function cancelRun() {
    const context = runningContextRef.current || unresolvedRunRef.current;
    if (!context || cancelling) return;
    await cancelContext(context, 'The local wait stopped.');
  }

  async function retryCompletedResult() {
    const reconciliation = unresolvedRun;
    const context = unresolvedRunRef.current || runningContextRef.current;
    if (
      !reconciliation
      || !context
      || reconciliation.terminalState !== 'COMPLETE'
      || recoveringResult
    ) return;

    const recoveryToken = lifecycleTokenRef.current + 1;
    lifecycleTokenRef.current = recoveryToken;
    context.token = recoveryToken;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setRecoveringResult(true);
    setCopiedJobId(false);
    setError('');
    setProgress('Rereading the completed job result without creating another job…');

    try {
      const next = await recoverCompletedAIContentJob({
        baseUrl: context.baseUrl,
        apiKey: context.apiKey,
        jobId: context.jobId,
        mode: reconciliation.mode,
        signal: controller.signal,
        chatUrl: context.chatUrl,
      });
      if (
        controller.signal.aborted
        || lifecycleTokenRef.current !== recoveryToken
        || !isActiveConnectionRequest(connectionKey)
      ) return;

      const recoveredIssues = Array.from(new Set(next.actionReviewIssues));
      setUnexpectedActions(recoveredIssues);
      const recoveredMutationCheck = unavailableModelMutationCheck(
        'The result was recovered after the original run ended, so its pre-run model snapshot is no longer available for comparison.',
      );
      setModelMutationCheck(recoveredMutationCheck);
      setOutcome({
        ...next,
        mode: reconciliation.mode,
        requestedName: reconciliation.mode === 'review'
          ? dashboard?.name || 'Dashboard review'
          : contentName.trim(),
      });
      context.chatUrl = next.chatUrl || context.chatUrl;
      setAmbiguousCreate(null);
      setAcknowledgedReconciliation(false);
      if (isNoWriteAgentMode(reconciliation.mode)) {
        const responseLabel = reconciliation.mode === 'review' ? 'review' : 'report';
        const reason = `Recovered the completed ${responseLabel} response, but its action or scoped-model postcondition evidence still requires reconciliation.`;
        const responseHold: UnresolvedRun = {
          ...context,
          terminalState: 'COMPLETE',
          reason,
          reasonCode: 'response-review-required',
        };
        unresolvedRunRef.current = responseHold;
        runningContextRef.current = responseHold;
        setUnresolvedRun(reconciliationView(responseHold, reason, responseHold.reasonCode));
        storeCompletedReconciliation(
          connectionKey,
          connection.instanceId || 'manual',
          reconciliationView(responseHold, reason, responseHold.reasonCode),
        );
        setProgress(`Recovered the completed ${responseLabel} response without creating another job. Another ${responseLabel} request remains locked until its response evidence is reconciled in Omni.`);
      } else if (
        isCreationHandoffMode(reconciliation.mode)
        && (
          next.artifactState === 'reported-created-unverified'
          || next.artifactState === 'creation-status-unverified'
        )
      ) {
        const creationStatusUnverified = next.artifactState === 'creation-status-unverified';
        const reason = creationStatusUnverified
          ? `Omni completed the ${reconciliation.mode === 'app' ? 'App' : 'dashboard'} job, but its action evidence was incomplete, unknown, or potentially mutating. The artifact may already exist.`
          : `Omni returned the expected ${reconciliation.mode === 'app' ? 'App' : 'dashboard'} creation action without a verifiable artifact identifier. The artifact may already exist.`;
        const artifactHold: UnresolvedRun = {
          ...context,
          terminalState: 'COMPLETE',
          reason,
          reasonCode: creationStatusUnverified ? 'creation-status-unverified' : 'artifact-unverified',
        };
        unresolvedRunRef.current = artifactHold;
        runningContextRef.current = artifactHold;
        setUnresolvedRun(reconciliationView(artifactHold, reason, artifactHold.reasonCode));
        storeCompletedReconciliation(
          connectionKey,
          connection.instanceId || 'manual',
          reconciliationView(artifactHold, reason, artifactHold.reasonCode),
        );
        setProgress(creationStatusUnverified
          ? 'Recovered the completed result, but its creation status is unverified. Another creation job remains locked until this exact job is reconciled in Omni.'
          : 'Recovered the completed result. Another creation job remains locked until the reported artifact is reconciled in Omni.');
      } else {
        unresolvedRunRef.current = null;
        runningContextRef.current = null;
        setUnresolvedRun(null);
        clearStoredReconciliation(connectionKey);
        setProgress(recoveredIssues.length > 0
          ? 'Recovered the completed result. Artifact postconditions still require review.'
          : 'Recovered the completed result without creating another job.');
      }
      logTerminal(context, 'response_received', {
        itemCount: next.actionSummaries.length,
        successCount: 1,
        failureCount: 0,
      });
    } catch (cause) {
      if (controller.signal.aborted || lifecycleTokenRef.current !== recoveryToken) return;
      const mismatch = cause instanceof AIContentResultContractMismatchError;
      const validationFailure = cause instanceof AIContentCompletedResultValidationError;
      const reasonCode: UnresolvedRun['reasonCode'] = validationFailure
        ? 'completed-result-validation'
        : mismatch
          ? 'result-contract-mismatch'
          : 'result-unavailable';
      const reason = mismatch || validationFailure
        ? cause.message
        : cause instanceof Error
          ? `The completed result still could not be read: ${cause.message}`
          : 'The completed result still could not be read.';
      const unresolved: UnresolvedRun = {
        ...context,
        terminalState: 'COMPLETE',
        reason,
        reasonCode,
        chatUrl: mismatch || validationFailure ? cause.chatUrl || context.chatUrl : context.chatUrl,
      };
      unresolvedRunRef.current = unresolved;
      runningContextRef.current = unresolved;
      setUnresolvedRun(reconciliationView(unresolved, reason, reasonCode));
      if (isCreationHandoffMode(reconciliation.mode)) {
        setOutcome(completedCreationHandoffOutcome({
          mode: reconciliation.mode,
          jobId: context.jobId,
          chatUrl: unresolved.chatUrl,
          requestedName: contentName.trim(),
        }));
        setUnexpectedActions([]);
        setModelMutationCheck(undefined);
        setError('');
        setProgress('Omni still reports the job as COMPLETE. Continue in Omni Chat, or retry the same result-only read later. No new job was created.');
      } else {
        setError(reason);
        setProgress('The completed job remains locked for result recovery or manual reconciliation.');
      }
    } finally {
      if (lifecycleTokenRef.current === recoveryToken) {
        abortRef.current = null;
        setRecoveringResult(false);
      }
    }
  }

  function changeMode(nextMode: AIContentMode) {
    if (running || cancelling || unresolvedRun || ambiguousCreate) return;
    dispatchForm({ type: 'change-mode', mode: nextMode });
    setSelectedDashboard(null);
    setDashboard(null);
    if (nextMode === 'review') {
      attachmentEpochRef.current += 1;
      attachmentsRef.current = [];
      setAttachments([]);
      setAttachmentError('');
    }
    setAcknowledgedReconciliation(false);
    clearRunOutput();
  }

  function acknowledgeReconciledRun() {
    const context = unresolvedRunRef.current;
    const reconciledMode = context?.mode;
    if (context) {
      unresolvedRunRef.current = null;
      runningContextRef.current = null;
    }
    setUnresolvedRun(null);
    setAmbiguousCreate(null);
    setAcknowledgedReconciliation(true);
    clearStoredReconciliation(connectionKey);
    setError('');
    setProgress(reconciledMode === 'review'
      ? 'Review reconciliation acknowledged. A manual retry may submit a duplicate review request.'
      : reconciledMode === 'report'
        ? 'Report reconciliation acknowledged. A manual retry may submit a duplicate report request.'
        : 'Reconciliation acknowledged. A manual retry may create a duplicate if the prior request succeeded.');
  }

  async function copyReconciliationJobId() {
    if (!unresolvedRun?.jobId) return;
    try {
      await navigator.clipboard.writeText(unresolvedRun.jobId);
      setCopiedJobId(true);
    } catch {
      setCopiedJobId(false);
    }
  }

  const completedResultHold = Boolean(
    unresolvedRun
    && unresolvedRun.terminalState === 'COMPLETE'
    && (
      unresolvedRun.reasonCode === 'result-unavailable'
      || unresolvedRun.reasonCode === 'result-contract-mismatch'
      || unresolvedRun.reasonCode === 'completed-result-validation'
    ),
  );
  const completedCreationHandoff = Boolean(
    completedResultHold
    && unresolvedRun
    && isCreationHandoffMode(unresolvedRun.mode),
  );
  const completedArtifactHold = Boolean(
    unresolvedRun
    && unresolvedRun.terminalState === 'COMPLETE'
    && unresolvedRun.reasonCode === 'artifact-unverified'
    && isCreationHandoffMode(unresolvedRun.mode),
  );
  const completedCreationStatusHold = Boolean(
    unresolvedRun
    && unresolvedRun.terminalState === 'COMPLETE'
    && unresolvedRun.reasonCode === 'creation-status-unverified'
    && isCreationHandoffMode(unresolvedRun.mode),
  );
  const completedCreationVerificationHold = completedArtifactHold || completedCreationStatusHold;
  const completedResponseReviewHold = Boolean(
    unresolvedRun
    && unresolvedRun.terminalState === 'COMPLETE'
    && unresolvedRun.reasonCode === 'response-review-required'
    && isNoWriteAgentMode(unresolvedRun.mode),
  );

  return (
    <div className="space-y-5" onPaste={pasteAttachments}>
      <PageHeader
        title="AI Content Studio"
        description="Review dashboards or use Omni Agent to create dashboards, Apps, and evidence-grounded narrative reports from a governed semantic scope, a focused one-shot brief, and visual references."
        icon={<Blobby mood="dashboard" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
      />

      <div className="rounded-card border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">
        <strong>Controlled action boundary:</strong>{' '}
        {mode === 'review'
          ? 'Review submits one no-write request through an Omni Agent API surface that is write-capable and has no documented action allowlist. Returned actions and the selected model’s pre/post snapshot are checked before the review is trusted or shared.'
          : mode === 'report'
            ? 'Narrative Report submits one no-write request through an Omni Agent API surface that is write-capable and has no documented action allowlist. Returned actions and the selected model’s pre/post snapshot are checked before the report is trusted or shared.'
            : 'This mode starts one write-capable Omni Agent job. The API has no documented action allowlist. Returned actions and artifact postconditions must be reconciled before the result is trusted or shared.'}
      </div>

      <ModeTabs mode={mode} disabled={interactionLocked} onChange={changeMode} />

      {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {(unresolvedRun || ambiguousCreate) && (
        <div role={completedCreationHandoff ? 'status' : 'alert'} className="rounded-card border border-amber-300 bg-amber-50 p-4 text-xs leading-5 text-amber-950">
          <div className="font-semibold">{completedCreationHandoff
            ? 'Omni job completed'
            : completedCreationStatusHold
              ? 'Creation status requires reconciliation before another AI job'
              : completedArtifactHold
                ? 'Artifact verification required before another AI job'
                : completedResponseReviewHold
                  ? 'Response evidence requires reconciliation before another AI job'
                  : 'Reconciliation required before another AI job'}</div>
          <p className="mt-1">
            {completedCreationHandoff && unresolvedRun
              ? `Omni confirmed this ${unresolvedRun.mode === 'app' ? 'App' : 'dashboard'} job as COMPLETE. Its separate structured result is unavailable in OmniKit. Continue in Omni Chat, or retry the result-only read below. This confirms job completion, not that the requested artifact exists or satisfies the brief.`
              : completedArtifactHold && unresolvedRun
                ? `Omni completed this ${unresolvedRun.mode === 'app' ? 'App' : 'dashboard'} job and returned the expected creation action, but no verifiable artifact identifier. The artifact may already exist, so another creation job remains locked until you reconcile this exact job in Omni.`
              : completedCreationStatusHold && unresolvedRun
                ? `Omni completed this ${unresolvedRun.mode === 'app' ? 'App' : 'dashboard'} job, but its action evidence was incomplete, unknown, or potentially mutating. OmniKit cannot determine whether the requested artifact was created, so another creation job remains locked until you reconcile this exact job in Omni.`
              : completedResponseReviewHold && unresolvedRun
                ? `Omni completed this ${unresolvedRun.mode === 'review' ? 'review' : 'report'} request, but its returned action or scoped-model postcondition evidence still requires reconciliation. Another ${unresolvedRun.mode === 'review' ? 'review' : 'report'} request remains locked until you inspect this exact job in Omni.`
              : unresolvedRun
              ? completedResultHold
                ? unresolvedRun.mode === 'review'
                  ? `Omni reports this review job as COMPLETE. ${unresolvedRun.reason} Another review job remains locked until this result is recovered or reconciled.`
                  : unresolvedRun.mode === 'report'
                    ? `Omni reports this report job as COMPLETE. ${unresolvedRun.reason} The narrative response may already be available, so another report request remains locked.`
                    : `Omni reports this job as COMPLETE. ${unresolvedRun.reason} The requested ${unresolvedRun.mode === 'app' ? 'App' : 'artifact'} may already exist, so a new create remains locked.`
                : `Job ${shortJobId(unresolvedRun.jobId)} has not reached a locally confirmed terminal state. ${unresolvedRun.reason}`
              : 'Omni may have accepted the AI job even though no job ID was returned. Starting again could submit a duplicate job.'}
          </p>
          {unresolvedRun?.jobId && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-card border border-amber-200 bg-white/70 px-3 py-2">
              <span className="font-medium">Full job ID</span>
              <code className="min-w-0 flex-1 break-all font-mono text-[11px]" data-testid="ai-content-reconciliation-job-id">{unresolvedRun.jobId}</code>
              <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => void copyReconciliationJobId()}>
                <Copy size={13} /> {copiedJobId ? 'Copied' : 'Copy job ID'}
              </button>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {unresolvedRun?.chatUrl && !completedCreationHandoff && !completedCreationVerificationHold && !completedResponseReviewHold && (
              <a
                href={unresolvedRun.chatUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${completedResultHold && isNoWriteAgentMode(unresolvedRun.mode) ? 'btn-primary' : 'btn-secondary'} text-xs`}
              >
                <ExternalLink size={13} /> {completedResultHold && unresolvedRun.mode === 'app'
                  ? 'Continue existing App in Omni chat'
                  : completedResultHold && isNoWriteAgentMode(unresolvedRun.mode)
                    ? 'Continue in Omni Chat'
                    : 'Check Omni chat'}
              </a>
            )}
            {unresolvedRun && completedResultHold && (
              <button type="button" className="btn-secondary" disabled={recoveringResult} onClick={() => void retryCompletedResult()}>
                {recoveringResult ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {recoveringResult ? 'Rereading completed result…' : 'Retry result read'}
              </button>
            )}
            {unresolvedRun && !completedResultHold && !completedCreationVerificationHold && !completedResponseReviewHold && (
              <button type="button" className="btn-secondary text-red-700" disabled={cancelling} onClick={() => void cancelRun()}>
                {cancelling ? <Loader2 size={13} className="animate-spin" /> : <XCircle size={13} />}
                {cancelling ? 'Confirming cancellation…' : 'Cancel job in Omni'}
              </button>
            )}
          </div>
          <label className="mt-3 flex items-start gap-2">
            <input
              type="checkbox"
              checked={acknowledgedReconciliation}
              disabled={cancelling || recoveringResult}
              onChange={(event) => setAcknowledgedReconciliation(event.target.checked)}
              className="mt-1"
            />
            <span>
              {completedArtifactHold && unresolvedRun?.mode === 'app'
                ? 'I inspected this exact completed App job in Omni and either verified the App or confirmed it was not created. I understand that starting another build may create a duplicate.'
                : completedArtifactHold && unresolvedRun?.mode === 'dashboard'
                  ? 'I inspected this exact completed dashboard job in Omni and either verified the dashboard or confirmed it was not created. I understand that starting another job may create a duplicate.'
                : completedCreationStatusHold && unresolvedRun?.mode === 'app'
                  ? 'I inspected this exact completed App job and its action history in Omni, and either verified the App or confirmed it was not created. I understand that starting another build may create a duplicate.'
                : completedCreationStatusHold && unresolvedRun?.mode === 'dashboard'
                  ? 'I inspected this exact completed dashboard job and its action history in Omni, and either verified the dashboard or confirmed it was not created. I understand that starting another job may create a duplicate.'
                : completedResultHold && unresolvedRun?.mode === 'app'
                ? 'I inspected this exact existing App in Omni and either verified it manually or moved it to recoverable Trash. I understand that starting a new build may create a duplicate.'
                : completedResultHold && unresolvedRun?.mode === 'dashboard'
                  ? 'I inspected this exact completed dashboard job in Omni and understand that starting another job may create a duplicate.'
                : completedResultHold && unresolvedRun?.mode === 'review'
                  ? 'I checked this exact review job in Omni and understand that manually retrying may submit a duplicate AI review.'
                  : completedResultHold && unresolvedRun?.mode === 'report'
                    ? 'I checked this exact report job in Omni and understand that manually retrying may submit a duplicate narrative report request.'
                    : completedResponseReviewHold && unresolvedRun?.mode === 'review'
                      ? 'I inspected this exact completed review and its returned actions and model postconditions in Omni. I understand that starting another review may submit a duplicate request.'
                      : completedResponseReviewHold && unresolvedRun?.mode === 'report'
                        ? 'I inspected this exact completed narrative report and its returned actions and model postconditions in Omni. I understand that starting another report may submit a duplicate request.'
                        : 'I checked Omni and understand that manually retrying may create a duplicate if the prior request succeeded.'}
            </span>
          </label>
          <button
            type="button"
            className="btn-secondary btn-sm mt-3"
            disabled={!acknowledgedReconciliation || cancelling || recoveringResult}
            onClick={acknowledgeReconciledRun}
          >
            Clear hold after reconciliation
          </button>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(360px,0.85fr)_minmax(0,1.15fr)] xl:items-start">
        <div className="card space-y-5 p-5">
          <div>
            <div className="flex items-center gap-2">
              <ModeIcon size={17} className="text-omni-700" />
              <h2 className="text-sm font-semibold text-content-primary">{modeInfo.label}</h2>
            </div>
            <p className="mt-1 text-xs leading-5 text-content-secondary">{modeInfo.description}</p>
          </div>

          {mode === 'review' && (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-content-primary">Existing dashboard evidence</div>
              <DashboardSearch
                dashboards={reviewDashboards}
                loading={loadingDashboards}
                lastSyncedAt={dashboardsSyncedAt}
                onRefresh={() => void refreshDashboards()}
                onPick={(picked) => void inspectDashboard(picked)}
                selectedDashboardId={selectedDashboard?.id}
                selectedDashboardConnectionId={selectedDashboard?.connectionId}
                disabled={interactionLocked || inspectingDashboard || modelInventoryPhase !== 'verified'}
                showInlineResults
              />
              {modelInventoryPhase === 'loading' && (
                <div className="flex items-center gap-2 text-xs text-content-secondary">
                  <Loader2 size={13} className="animate-spin" /> Verifying shared models before dashboard inspection…
                </div>
              )}
              {inspectingDashboard && <div className="flex items-center gap-2 text-xs text-content-secondary"><Loader2 size={13} className="animate-spin" /> Inspecting dashboard structure and semantic associations…</div>}
              {dashboard && (
                <div className="rounded-card border border-border bg-surface-secondary p-3 text-xs">
                  <div className="font-semibold text-content-primary">{dashboard.name}</div>
                  <div className="mt-1 text-content-secondary">{dashboard.tiles.length} tiles · {dashboard.filters.length} filters · {dashboard.topics.length || 0} detected topics</div>
                  <div className="mt-1 font-mono text-[11px] text-content-tertiary">
                    Detected model IDs: {dashboard.modelIds.length > 0 ? dashboard.modelIds.join(', ') : 'not detected'}
                  </div>
                  {reviewEligibleModelIds.length > 0 && (
                    <div className="mt-1 font-mono text-[11px] text-content-tertiary">
                      Verified SHARED scope: {reviewEligibleModelIds.join(', ')}
                    </div>
                  )}
                  {reviewEligibleModelIds.length > 1 && !dashboard.modelResolutionBlockedReason && (
                    <div role="alert" className="mt-3 rounded-card border border-amber-200 bg-amber-50 p-2 text-[11px] leading-4 text-amber-900">
                      This dashboard has multiple exact, verified SHARED model associations. Select the intended governed scope below before approving the review; the selected model is bound to the review fingerprint.
                    </div>
                  )}
                  {dashboard.modelResolutionBlockedReason && (
                    <div role="alert" className="mt-3 space-y-2 rounded-card border border-amber-200 bg-amber-50 p-2 text-[11px] leading-4 text-amber-900">
                      <div>{dashboard.modelResolutionBlockedReason}</div>
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        disabled={interactionLocked || modelInventoryPhase === 'loading'}
                        onClick={() => void retryReviewModelResolution()}
                      >
                        <RefreshCw size={13} /> Retry model verification
                      </button>
                    </div>
                  )}
                  {dashboard.modelResolutionNotice && !dashboard.modelResolutionBlockedReason && (
                    <div role="status" className="mt-3 rounded-card border border-blue-200 bg-blue-50 p-2 text-[11px] leading-4 text-blue-900">
                      {dashboard.modelResolutionNotice}
                    </div>
                  )}
                  {reviewEligibleModelIds.length <= 1 && !dashboard.modelResolutionBlockedReason && dashboard.topics.length > 0 && (
                    <label className="mt-3 block">
                      <span className="mb-1 block text-[11px] font-medium text-content-secondary">Detected topic scope (optional)</span>
                      <select value={topicName} disabled={interactionLocked} onChange={(event) => { dispatchForm({ type: 'change-topic', topicName: event.target.value }); clearRunOutput(); }} className="input-field">
                        <option value="">Model context only</option>
                        {dashboard.topics.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              )}
            </div>
          )}

          {mode !== 'review' && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-content-secondary">
                Content name{isCreationMode ? ' (required)' : ''}
              </span>
              <input
                value={contentName}
                onChange={(event) => { dispatchForm({ type: 'change-content-name', contentName: event.target.value }); clearRunOutput(); }}
                disabled={interactionLocked}
                maxLength={200}
                placeholder={mode === 'report' ? 'Report title (optional)' : `Name for the ${mode}`}
                className="input-field"
              />
            </label>
          )}

          {(mode !== 'review' || (dashboard && reviewEligibleModelIds.length > 1 && !dashboard.modelResolutionBlockedReason)) && (
            <div className="space-y-2">
              <ScopeSelector
                models={mode === 'review' && dashboard && reviewEligibleModelIds.length > 1
                  ? models.filter((model) => reviewEligibleModelIds.includes(model.id))
                  : models}
                topics={topics}
                modelId={modelId}
                topicName={topicName}
                loadingModels={loadingModels}
                loadingTopics={loadingTopics}
                disabled={interactionLocked || modelInventoryPhase === 'failed'}
                modelEmptyLabel={mode === 'review'
                  ? 'Select a verified SHARED model'
                  : modelInventoryPhase === 'verified' && models.length === 0
                    ? 'No shared models available'
                    : undefined}
                onModelChange={(value) => { dispatchForm({ type: 'change-model', modelId: value }); clearRunOutput(); }}
                onTopicChange={(value) => { dispatchForm({ type: 'change-topic', topicName: value }); clearRunOutput(); }}
              />
              {modelInventoryPhase === 'failed' && mode !== 'review' && (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-800">
                  <span>{modelInventoryError}</span>
                  <button
                    type="button"
                    className="btn-secondary btn-sm shrink-0"
                    disabled={interactionLocked}
                    onClick={() => void refreshModelInventory(true)}
                  >
                    <RefreshCw size={13} /> Retry inventory
                  </button>
                </div>
              )}
              {modelInventoryPhase === 'verified' && models.length === 0 && mode !== 'review' && (
                <div role="status" className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                  Omni returned a verified empty shared-model inventory. Add or request access to a shared model, then retry the inventory.
                </div>
              )}
            </div>
          )}

          {mode === 'review' && modelInventoryPhase === 'failed' && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-800">
              <span>{modelInventoryError}</span>
              <button
                type="button"
                className="btn-secondary btn-sm shrink-0"
                disabled={interactionLocked}
                onClick={() => void retryReviewModelResolution()}
              >
                <RefreshCw size={13} /> Retry inventory
              </button>
            </div>
          )}

          {mode === 'review' && dashboard && !dashboard.modelResolutionBlockedReason && effectiveModelId && modelInventoryPhase === 'verified' && !verifiedEffectiveModelKind && (
            <div role="alert" className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              The selected dashboard model is not available as a verified SHARED model. Select an eligible detected model or request access before running the AI review.
            </div>
          )}

          <OneShotBriefForm
            mode={mode}
            brief={brief}
            disabled={interactionLocked}
            onChange={(field, value) => {
              dispatchForm({ type: 'change-brief-field', field, value });
              clearRunOutput();
            }}
          />

          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-content-primary">
              <Paperclip size={14} /> {mode === 'review' ? 'Optional review evidence' : 'Visual references'}
            </div>
            {mode === 'review' && (
              <p className="mb-2 text-xs leading-5 text-content-secondary">
                OmniKit automatically captures the full dashboard PNG when the review starts. Add up to four screenshots for alternate states or PDFs for supporting context; the fifth slot is reserved for that render. If automatic capture fails, at least one uploaded screenshot image is required.
              </p>
            )}
            <AttachmentDropzone
              attachments={attachments}
              disabled={interactionLocked || attachmentReadsPending > 0}
              error={attachmentError}
              onFiles={(files) => void addFiles(files)}
              onRemove={removeAttachment}
            />
            {attachmentReadsPending > 0 && (
              <div role="status" className="mt-2 flex items-center gap-2 text-xs text-content-secondary">
                <Loader2 size={13} className="animate-spin" /> Processing attachments before submission…
              </div>
            )}
            {mode === 'review' && reviewRenderNotice && (
              <div role="status" className="mt-2 rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-900">
                {reviewRenderNotice}
              </div>
            )}
          </div>

          {mode === 'app' && missingAppApprovalRequirements.length > 0 && (
            <div role="status" className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              Complete before approval: {missingAppApprovalRequirements.join(', ')}.
            </div>
          )}

          <label className="flex items-start gap-3 rounded-card border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
            <input
              type="checkbox"
              checked={approvedCurrentScope}
              disabled={interactionLocked || !approvalPrerequisitesReady}
              onChange={(event) => {
                if (event.target.checked) submittedScopeRef.current = '';
                dispatchForm(event.target.checked
                  ? { type: 'approve-scope', scope: scopeFingerprint }
                  : { type: 'clear-approval' });
              }}
              className="mt-1"
            />
            <span>
              {mode === 'review' ? (
                <>I approve sending the selected dashboard render, optional review evidence, and bounded dashboard structure to Omni Agent for one AI dashboard review scoped to model <strong title={effectiveModelApprovalTitle}>{effectiveModelApprovalName}</strong>{effectiveTopicName ? <> and topic <strong>{effectiveTopicName}</strong></> : null}. The request instructs zero writes, but I understand the API surface is write-capable and returned actions must be reviewed.</>
              ) : mode === 'dashboard' ? (
                <>I approve one controlled-write Agent job requesting the dashboard named <strong>{contentName.trim() || '(enter a name)'}</strong>, scoped to model <strong title={effectiveModelApprovalTitle}>{effectiveModelApprovalName}</strong>{effectiveTopicName ? <> and topic <strong>{effectiveTopicName}</strong></> : null}. Destination, ownership, and creation remain unverified until the exact artifact is reconciled.</>
              ) : mode === 'app' ? (
                <>I approve one controlled-write <strong>Beta</strong> Agent job attempting the App named <strong>{contentName.trim() || '(enter a name)'}</strong>, scoped to model <strong title={effectiveModelApprovalTitle}>{effectiveModelApprovalName}</strong>{effectiveTopicName ? <> and topic <strong>{effectiveTopicName}</strong></> : null}. I will verify the result manually through Omni Chat and will not widen sandbox settings without governance review.</>
              ) : (
                <>I approve one no-write narrative request through an Omni Agent API surface that is write-capable, scoped to model <strong title={effectiveModelApprovalTitle}>{effectiveModelApprovalName}</strong>{effectiveTopicName ? <> and topic <strong>{effectiveTopicName}</strong></> : null}. I understand the prompt instructs zero writes and I will review every returned action and scoped-model postcondition before relying on the report.</>
              )}
            </span>
          </label>

          {mode === 'app' && (
            <div className="rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-900">
              <strong>Apps (Beta) prerequisites:</strong> Apps must be enabled in Settings &gt; General. Before approval, define the required data, layout and interactions, and acceptance criteria so Omni can test bindings instead of producing a placeholder. Each App is paired with a workbook and supports up to 100 wired queries. Schedules, deliveries, downloads, and embedding are unsupported. The sandbox blocks outbound network access and external navigation by default; any per-App exception requires a narrow domain and governance review.
            </div>
          )}

          {mode === 'report' && (
            <div className="rounded-card border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-900">
              Reports are structured narrative output in this page with an Omni chat handoff. The studio checks the response contract but does not claim factual validation or creation of a persistent Omni report artifact.
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={!canRun} onClick={() => void startRun()}>
              {running ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {running ? 'Working…' : mode === 'review' ? 'Run Blobby review' : mode === 'report' ? 'Generate report' : mode === 'app' ? 'Start App build' : 'Request dashboard'}
            </button>
            {running && !terminalCompletePendingResult && (
              <button type="button" className="btn-secondary text-red-700" disabled={cancelling} onClick={() => void cancelRun()}>
                {cancelling ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                {cancelling ? 'Confirming cancellation…' : 'Cancel'}
              </button>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {running && (
            <AIWorkingAnimation
              variant="dashboard"
              title={terminalCompletePendingResult ? 'Omni Agent completed the job' : 'Omni Agent is working'}
              detail={progress || 'Starting one AI job…'}
              statusLabel={jobId ? `Job ${jobId.slice(0, 8)}…` : 'Submitting'}
              compact
              steps={[
                { label: 'Submit once', status: jobId ? 'complete' : 'active' },
                { label: 'Poll job', status: terminalCompletePendingResult ? 'complete' : jobId ? 'active' : 'pending' },
                { label: 'Check response', status: terminalCompletePendingResult ? 'active' : 'pending' },
              ]}
            />
          )}

          {!running && !outcome && (
            <div className="card min-h-[360px] p-6 text-center flex flex-col items-center justify-center">
              <Blobby mood="dashboard" size={88} />
              <div className="mt-4 text-sm font-semibold text-content-primary">Your content outcome will appear here</div>
              <div className="mt-2 max-w-md text-xs leading-5 text-content-secondary">
                {mode === 'review'
                  ? 'Select a dashboard and verified SHARED model, optionally add a focused brief or references, then approve one visual AI review. OmniKit captures the current dashboard render automatically and checks returned actions plus the scoped model snapshot.'
                  : mode === 'report'
                    ? 'Select a semantic scope, complete the one-shot brief, optionally add visual references, and approve the exact no-write report scope. OmniKit checks the returned response, actions, and scoped model snapshot before the report is trusted.'
                    : 'Select a semantic scope, complete the one-shot brief, optionally add visual references, and approve the exact controlled-write scope. Changing scope cancels the active wait instead of applying a stale result.'}
              </div>
              {progress && <div className="mt-3 text-xs text-content-secondary">{progress}</div>}
            </div>
          )}

          {outcome && (
            <OutcomePanel
              outcome={outcome}
              mode={outcome.mode}
              contentName={outcome.requestedName}
              unexpectedActions={unexpectedActions}
              baseUrl={connection.baseUrl}
              apiKey={connection.apiKey}
              expectedModelId={effectiveModelId}
              modelMutationCheck={modelMutationCheck}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default AIContentStudioPage;
