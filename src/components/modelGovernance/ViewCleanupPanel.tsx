import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { ConnectionConfig, OmniModel } from '@/types';
import {
  deleteModelView,
  getModelYaml,
  refreshModel,
  updateModelYamlFiles,
  validateModel,
  validateModelContent,
} from '@/services/omniApi';
import {
  buildStaleViewCandidates,
  normalizeContentReferences,
  parseSemanticInventory,
  setViewIgnored,
  type SemanticContentReference,
  type StaleViewCandidate,
  type ValidationIssueLike,
} from '@/services/modelGovernance';
import {
  discardReviewedModelBranch,
  isGovernanceEditableModel,
  prepareReviewedModelHandoff,
  ReviewedPullRequestVerificationError,
  startReviewedModelBranch,
  type ReviewedModelBranch,
  type ReviewedHandoffResult,
  type ReviewedValidation,
} from '@/services/reviewedModelWrite';
import { getConnectionCacheKey } from '@/services/connectionGuards';
import { useLogOperation } from '@/hooks/useOperationLog';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ReleaseGateEvidencePanel } from '@/components/modelGovernance/ReleaseGateEvidencePanel';
import {
  collectTargetedAffectedContent,
  collectReleaseGateEvidence,
  reconcileReleaseGateApproval,
  type ReleaseGateApproval,
  type ReleaseGateEvidence,
} from '@/services/releaseGateEvidence';

interface ViewCleanupPanelProps {
  connection: ConnectionConfig;
  models: OmniModel[];
  validationResults: Record<string, ValidationIssueLike[]>;
  onValidationResult: (modelId: string, issues: ValidationIssueLike[]) => void;
}

interface CleanupPreview {
  branch: ReviewedModelBranch;
  targetModel: OmniModel;
  results: Array<{
    viewName: string;
    fileName: string;
    targetFileName: string;
    status: 'staged' | 'failed' | 'skipped';
    detail: string;
  }>;
  validation: ReviewedValidation;
  releaseEvidence: ReleaseGateEvidence;
}

interface RefreshPreview {
  branch: ReviewedModelBranch;
  targetModel: OmniModel;
  status: string;
  affectedViewNames: string[];
  validation: ReviewedValidation | null;
  releaseEvidence: ReleaseGateEvidence | null;
}

interface GovernanceResult {
  title: string;
  message: string;
  mode: 'manual_handoff' | 'pull_request' | 'quarantined' | 'queued' | 'discarded';
  rows?: CleanupPreview['results'];
  url?: string;
  removedViews?: string[];
}

type CandidateFilter = 'all' | 'safe' | 'broken' | 'referenced' | 'unknown' | 'manual';
type HardRefreshMode = 'direct' | 'branch';

function modelLabel(model: OmniModel): string {
  return `${model.name}${model.kind ? ` · ${model.kind.replace(/_/g, ' ')}` : ''}`;
}

function confidenceLabel(candidate: StaleViewCandidate): string {
  if (candidate.confidence === 'high') return 'High confidence';
  if (candidate.confidence === 'medium') return 'Medium confidence';
  return 'Manual review';
}

function referenceLabel(candidate: StaleViewCandidate): string {
  if (candidate.referenceStatus === 'verified-zero') return '0 confirmed references';
  if (candidate.referenceStatus === 'referenced') return `${candidate.references.length} referenced content item${candidate.references.length === 1 ? '' : 's'}`;
  if (candidate.referenceStatus === 'failed') return 'Reference check failed';
  return 'References not checked';
}

function dedupeReferences(rows: SemanticContentReference[]): SemanticContentReference[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.documentId || row.identifier}|${row.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resultFromPublish(
  title: string,
  publish: ReviewedHandoffResult,
  rows?: CleanupPreview['results'],
): GovernanceResult {
  return {
    title,
    message: publish.message,
    mode: publish.mode,
    rows,
    url: publish.url,
  };
}

export function ViewCleanupPanel({
  connection,
  models,
  validationResults,
  onValidationResult,
}: ViewCleanupPanelProps) {
  const logOperation = useLogOperation();
  const connectionKey = getConnectionCacheKey(connection);
  const activeConnectionRef = useRef(connectionKey);
  const schemaConnectionIds = useMemo(() => (
    [...new Set(models.filter((model) => !model.deletedAt && model.kind?.toUpperCase() === 'SCHEMA').map((model) => model.connectionId).filter(Boolean))]
      .sort() as string[]
  ), [models]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('all');
  const schemaModels = useMemo(() => models.filter((model) => (
    !model.deletedAt
    && model.kind?.toUpperCase() === 'SCHEMA'
    && (selectedConnectionId === 'all' || model.connectionId === selectedConnectionId)
  )), [models, selectedConnectionId]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const activeModelRef = useRef('');
  const selectedModel = models.find((model) => model.id === selectedModelId) || null;
  const relatedTargetModels = useMemo(() => {
    if (!selectedModel) return [];
    return models.filter((model) => (
      isGovernanceEditableModel(model)
      && model.connectionId === selectedModel.connectionId
      && model.baseModelId === selectedModel.id
    ));
  }, [models, selectedModel]);
  const [selectedTargetModelId, setSelectedTargetModelId] = useState('');
  const activeTargetModelRef = useRef('');
  const selectedTargetModel = relatedTargetModels.find((model) => model.id === selectedTargetModelId) || null;
  const [includeManualCandidates, setIncludeManualCandidates] = useState(false);
  const [candidates, setCandidates] = useState<StaleViewCandidate[]>([]);
  const [selectedViews, setSelectedViews] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CandidateFilter>('all');
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [refreshPreview, setRefreshPreview] = useState<RefreshPreview | null>(null);
  const [cleanupApproval, setCleanupApproval] = useState<ReleaseGateApproval | null>(null);
  const [refreshApproval, setRefreshApproval] = useState<ReleaseGateApproval | null>(null);
  const [result, setResult] = useState<GovernanceResult | null>(null);
  const [pendingOverride, setPendingOverride] = useState<StaleViewCandidate | null>(null);
  const [confirmHardRefresh, setConfirmHardRefresh] = useState(false);
  const [hardRefreshMode, setHardRefreshMode] = useState<HardRefreshMode>('direct');
  const [refreshBaseline, setRefreshBaseline] = useState<string[]>([]);
  const [lastScannedViews, setLastScannedViews] = useState<string[]>([]);

  useEffect(() => {
    activeConnectionRef.current = connectionKey;
    setSelectedConnectionId('all');
    setSelectedModelId('');
    activeModelRef.current = '';
    setSelectedTargetModelId('');
    activeTargetModelRef.current = '';
    setCandidates([]);
    setSelectedViews(new Set());
    setPreview(null);
    setRefreshPreview(null);
    setCleanupApproval(null);
    setRefreshApproval(null);
    setResult(null);
  }, [connectionKey]);

  useEffect(() => {
    if (relatedTargetModels.some((model) => model.id === selectedTargetModelId)) return;
    const nextTargetId = relatedTargetModels.length === 1 ? relatedTargetModels[0].id : '';
    activeTargetModelRef.current = nextTargetId;
    setSelectedTargetModelId(nextTargetId);
  }, [relatedTargetModels, selectedTargetModelId]);

  const selectedCandidates = candidates.filter((candidate) => selectedViews.has(candidate.viewName));
  const filteredCandidates = candidates.filter((candidate) => {
    const needle = search.toLowerCase();
    const matchesSearch = !needle
      || candidate.viewName.toLowerCase().includes(needle)
      || candidate.fileName.toLowerCase().includes(needle)
      || candidate.validationIssues.join(' ').toLowerCase().includes(needle);
    const matchesFilter = filter === 'all'
      || (filter === 'safe' && candidate.safeByDefault)
      || (filter === 'broken' && (candidate.reason === 'broken-reference' || candidate.reason === 'source-drift'))
      || (filter === 'referenced' && candidate.referenceStatus === 'referenced')
      || (filter === 'unknown' && (candidate.referenceStatus === 'unknown' || candidate.referenceStatus === 'failed'))
      || (filter === 'manual' && candidate.confidence === 'manual');
    return matchesSearch && matchesFilter;
  });

  function isCurrent(requestKey: string, modelId?: string): boolean {
    return activeConnectionRef.current === requestKey && (!modelId || activeModelRef.current === modelId);
  }

  function isTargetCurrent(requestKey: string, targetModelId: string): boolean {
    return activeConnectionRef.current === requestKey && activeTargetModelRef.current === targetModelId;
  }

  function resetStagedWork() {
    setPreview(null);
    setRefreshPreview(null);
    setCleanupApproval(null);
    setRefreshApproval(null);
    setResult(null);
  }

  async function lookupReferences(
    requestKey: string,
    schemaModelId: string,
    baseCandidates: StaleViewCandidate[],
  ) {
    const contentReferences: Record<string, SemanticContentReference[]> = {};
    const referenceErrors: Record<string, string> = {};
    if (relatedTargetModels.length === 0) {
      for (const candidate of baseCandidates) {
        referenceErrors[candidate.viewName] = 'No editable shared model is linked to this schema model, so live content references cannot be verified.';
      }
      return { contentReferences, referenceErrors };
    }

    let complete = 0;
    for (const candidate of baseCandidates) {
      const rows: SemanticContentReference[] = [];
      const failures: string[] = [];
      for (const targetModel of relatedTargetModels) {
        try {
          const raw = await validateModelContent(connection.baseUrl, connection.apiKey, targetModel.id, {
            find: candidate.viewName,
            findType: 'VIEW',
            includePersonalFolders: true,
          });
          rows.push(...normalizeContentReferences(raw));
        } catch (lookupError) {
          failures.push(`${targetModel.name}: ${lookupError instanceof Error ? lookupError.message : 'reference lookup failed'}`);
        }
      }
      if (!isCurrent(requestKey, schemaModelId)) return { contentReferences: {}, referenceErrors: {} };
      if (failures.length > 0) referenceErrors[candidate.viewName] = failures.join(' ');
      else contentReferences[candidate.viewName] = dedupeReferences(rows);
      complete += 1;
      setMessage(`Checking live content references ${complete}/${baseCandidates.length}...`);
    }
    return { contentReferences, referenceErrors };
  }

  async function scanCandidates() {
    if (!selectedModel) return;
    const requestKey = connectionKey;
    const modelId = selectedModel.id;
    setLoading(true);
    setError('');
    setMessage('Loading schema YAML and validation evidence...');
    resetStagedWork();
    try {
      const yaml = await getModelYaml(connection.baseUrl, connection.apiKey, modelId, { includeChecksums: true });
      if (!isCurrent(requestKey, modelId)) return;
      const inventory = parseSemanticInventory(yaml.files || {});
      const hasCachedValidation = Object.prototype.hasOwnProperty.call(validationResults, modelId);
      const issues = hasCachedValidation
        ? validationResults[modelId]
        : await validateModel(connection.baseUrl, connection.apiKey, modelId);
      if (!isCurrent(requestKey, modelId)) return;
      if (!hasCachedValidation) onValidationResult(modelId, Array.isArray(issues) ? issues : []);
      const baseCandidates = buildStaleViewCandidates({
        inventory,
        validationIssues: Array.isArray(issues) ? issues : [],
        includeManualCandidates,
      });
      const referenceLookup = await lookupReferences(requestKey, modelId, baseCandidates);
      if (!isCurrent(requestKey, modelId)) return;
      const nextCandidates = buildStaleViewCandidates({
        inventory,
        validationIssues: Array.isArray(issues) ? issues : [],
        contentReferences: referenceLookup.contentReferences,
        referenceErrors: referenceLookup.referenceErrors,
        includeManualCandidates,
      });
      const currentViewNames = inventory.views.map((view) => view.name);
      const removedViews = refreshBaseline.filter((viewName) => !currentViewNames.includes(viewName));
      setLastScannedViews(currentViewNames);
      setCandidates(nextCandidates);
      setSelectedViews(new Set(nextCandidates.filter((candidate) => candidate.safeByDefault).map((candidate) => candidate.viewName)));
      if (removedViews.length > 0) {
        setResult({
          title: 'Hard refresh comparison',
          message: `The refreshed model no longer contains ${removedViews.length} previously scanned view${removedViews.length === 1 ? '' : 's'}.`,
          mode: 'queued',
          removedViews,
        });
        setRefreshBaseline([]);
      }
      const warningText = inventory.warnings.length > 0 ? ` ${inventory.warnings.length} YAML file${inventory.warnings.length === 1 ? '' : 's'} could not be parsed and were excluded.` : '';
      setMessage(nextCandidates.length === 0
        ? `No stale-view candidates were found from exact validation signals.${warningText} Use hard schema refresh for source-drift cleanup.`
        : `Found ${nextCandidates.length} candidate view${nextCandidates.length === 1 ? '' : 's'}. Safe select includes only high-confidence views with confirmed zero references.${warningText}`);
    } catch (scanError) {
      if (isCurrent(requestKey, modelId)) setError(scanError instanceof Error ? scanError.message : 'Could not scan stale views.');
    } finally {
      if (isCurrent(requestKey, modelId)) setLoading(false);
    }
  }

  function toggleView(candidate: StaleViewCandidate) {
    resetStagedWork();
    if (selectedViews.has(candidate.viewName)) {
      setSelectedViews((current) => {
        const next = new Set(current);
        next.delete(candidate.viewName);
        return next;
      });
      return;
    }
    if (!candidate.safeByDefault) {
      setPendingOverride(candidate);
      return;
    }
    setSelectedViews((current) => new Set(current).add(candidate.viewName));
  }

  function includeOverrideCandidate() {
    if (!pendingOverride) return;
    setSelectedViews((current) => new Set(current).add(pendingOverride.viewName));
    setPendingOverride(null);
  }

  function selectSafe() {
    resetStagedWork();
    setSelectedViews(new Set(candidates.filter((candidate) => candidate.safeByDefault).map((candidate) => candidate.viewName)));
  }

  async function previewSurgicalCleanup() {
    if (!selectedTargetModel) {
      setError('Choose an editable shared model associated with this schema model before staging surgical cleanup.');
      return;
    }
    if (selectedCandidates.length === 0) {
      setError('Select at least one stale-view candidate first.');
      return;
    }
    const requestKey = connectionKey;
    const targetModelId = selectedTargetModel.id;
    setLoading(true);
    setError('');
    setMessage('Creating a reviewed shared-model branch...');
    resetStagedWork();
    let branch: ReviewedModelBranch | null = null;
    try {
      branch = await startReviewedModelBranch(connection, selectedTargetModel, 'omnikit-view-cleanup');
      const branchYaml = await getModelYaml(connection.baseUrl, connection.apiKey, selectedTargetModel.id, {
        branchId: branch.branchId,
        mode: 'extension',
        includeChecksums: true,
      });
      if (!isTargetCurrent(requestKey, targetModelId)) {
        await discardReviewedModelBranch(connection, branch).catch(() => undefined);
        return;
      }
      const results: CleanupPreview['results'] = [];
      for (const candidate of selectedCandidates) {
        const targetLeafName = candidate.fileName.split('/').pop() || `${candidate.viewName}.view`;
        const existingFileName = Object.keys(branchYaml.files || {}).find((name) => (
          name === targetLeafName || name.endsWith(`/${targetLeafName}`)
        ));
        const targetFileName = existingFileName || targetLeafName;
        try {
          await deleteModelView(connection.baseUrl, connection.apiKey, {
            modelId: selectedTargetModel.id,
            viewName: candidate.viewName,
            mode: 'COMBINED',
            branchId: branch.branchId,
          });
          results.push({
            viewName: candidate.viewName,
            fileName: candidate.fileName,
            targetFileName,
            status: 'staged',
            detail: 'Omni staged a combined-mode view removal on the shared-model branch.',
          });
        } catch {
          try {
            const existingYaml = existingFileName ? branchYaml.files?.[existingFileName] || '' : '';
            const checksum = existingFileName ? branchYaml.checksums?.[existingFileName] : undefined;
            await updateModelYamlFiles(connection.baseUrl, connection.apiKey, {
              modelId: selectedTargetModel.id,
              branchId: branch.branchId,
              mode: 'extension',
              commitMessage: 'Stage OmniKit stale-view cleanup',
              files: [{
                fileName: existingFileName || targetFileName,
                yaml: setViewIgnored(existingYaml || '{}'),
                previousChecksum: checksum,
              }],
            });
            results.push({
              viewName: candidate.viewName,
              fileName: candidate.fileName,
              targetFileName: existingFileName || targetFileName,
              status: 'staged',
              detail: 'The shared-model extension will mark this schema view as ignored.',
            });
          } catch (stageError) {
            results.push({
              viewName: candidate.viewName,
              fileName: candidate.fileName,
              targetFileName,
              status: 'failed',
              detail: stageError instanceof Error ? stageError.message : 'Could not stage this view change.',
            });
          }
        }
      }
      const stagedFiles = results.filter((row) => row.status === 'staged').map((row) => row.targetFileName);
      const affectedContentEvidence = await collectTargetedAffectedContent(
        connection,
        selectedTargetModel.id,
        results
          .filter((row) => row.status === 'staged')
          .map((row) => ({ type: 'VIEW', name: row.viewName })),
      );
      const releaseEvidence = await collectReleaseGateEvidence({
        connection,
        model: selectedTargetModel,
        branch,
        affectedFiles: stagedFiles,
        ...affectedContentEvidence,
      });
      if (!isTargetCurrent(requestKey, targetModelId)) {
        await discardReviewedModelBranch(connection, branch).catch(() => undefined);
        return;
      }
      setPreview({ branch, targetModel: selectedTargetModel, results, validation: releaseEvidence.validation, releaseEvidence });
      setCleanupApproval(null);
      setMessage(releaseEvidence.status === 'blocked'
        ? 'Cleanup branch is staged, but the release gate is blocked. Review the evidence before handoff.'
        : 'Cleanup branch is staged. Approve the exact release evidence before handoff.');
    } catch (previewError) {
      if (branch) await discardReviewedModelBranch(connection, branch).catch(() => undefined);
      if (isTargetCurrent(requestKey, targetModelId)) setError(previewError instanceof Error ? previewError.message : 'Could not stage cleanup branch.');
    } finally {
      if (isTargetCurrent(requestKey, targetModelId)) setLoading(false);
    }
  }

  async function publishCleanup() {
    if (!preview || preview.releaseEvidence.status === 'blocked') return;
    const requestKey = connectionKey;
    const targetModelId = preview.targetModel.id;
    setPublishing(true);
    setError('');
    try {
      const stagedRows = preview.results.filter((row) => row.status === 'staged');
      const affectedContentEvidence = await collectTargetedAffectedContent(
        connection,
        preview.targetModel.id,
        stagedRows.map((row) => ({ type: 'VIEW', name: row.viewName })),
      );
      const releaseEvidence = await collectReleaseGateEvidence({
        connection,
        model: preview.targetModel,
        branch: preview.branch,
        affectedFiles: stagedRows.map((row) => row.targetFileName),
        ...affectedContentEvidence,
      });
      if (!isTargetCurrent(requestKey, targetModelId)) return;
      const currentApproval = reconcileReleaseGateApproval(cleanupApproval, releaseEvidence);
      if (!currentApproval) {
        setPreview({ ...preview, validation: releaseEvidence.validation, releaseEvidence });
        setCleanupApproval(null);
        setError('Release evidence changed or is blocked. Review the refreshed fingerprint and approve it again before handoff.');
        return;
      }
      const publish = await prepareReviewedModelHandoff(connection, preview.branch, 'Review OmniKit stale-view cleanup');
      if (!isTargetCurrent(requestKey, targetModelId)) return;
      const staged = preview.results.filter((row) => row.status === 'staged').length;
      const failed = preview.results.filter((row) => row.status === 'failed').length;
      logOperation('model_governance', `Stale view cleanup sent for review for ${preview.targetModel.name}`, {
        itemCount: preview.results.length,
        successCount: staged,
        failureCount: failed,
        details: {
          operation: 'stale_view_cleanup',
          modelId: preview.targetModel.id,
          modelName: preview.targetModel.name,
          branchName: preview.branch.branchName,
          publishMode: publish.mode,
          viewCount: preview.results.length,
        },
      });
      setResult(resultFromPublish('Cleanup result', publish, preview.results));
      setPreview(null);
      setCleanupApproval(null);
      setMessage(publish.message);
    } catch (publishError) {
      if (isTargetCurrent(requestKey, targetModelId)) {
        if (publishError instanceof ReviewedPullRequestVerificationError) {
          setResult({
            title: 'Cleanup handoff needs reconciliation',
            message: `${publishError.message} No retry is allowed until the reported review is reconciled in Omni.`,
            mode: 'quarantined',
            rows: preview.results,
            url: publishError.reviewUrl || preview.branch.capability.webUrl || connection.baseUrl,
          });
          setPreview(null);
          setCleanupApproval(null);
        } else {
          setError(publishError instanceof Error ? publishError.message : 'Could not prepare the cleanup handoff.');
        }
      }
    } finally {
      if (isTargetCurrent(requestKey, targetModelId)) setPublishing(false);
    }
  }

  async function discardCleanup() {
    if (!preview) return;
    setLoading(true);
    setError('');
    try {
      await discardReviewedModelBranch(connection, preview.branch);
      setResult({ title: 'Cleanup branch discarded', message: 'No model changes were published.', mode: 'discarded', rows: preview.results });
      setPreview(null);
      setCleanupApproval(null);
      setMessage('Cleanup branch discarded. No model changes were published.');
    } catch (discardError) {
      setError(discardError instanceof Error ? discardError.message : 'Could not discard cleanup branch.');
    } finally {
      setLoading(false);
    }
  }

  async function runHardRefresh() {
    if (!selectedModel) return;
    const requestKey = connectionKey;
    const schemaModelId = selectedModel.id;
    setConfirmHardRefresh(false);
    setLoading(true);
    setError('');
    setResult(null);
    setRefreshBaseline(lastScannedViews);
    try {
      if (hardRefreshMode === 'branch') {
        if (!selectedTargetModel) throw new Error('Choose an associated editable shared model for branch-based refresh.');
        const branch = await startReviewedModelBranch(connection, selectedTargetModel, 'omnikit-hard-refresh');
        try {
          const response = await refreshModel(connection.baseUrl, connection.apiKey, selectedTargetModel.id, { branchId: branch.branchId });
          if (!isTargetCurrent(requestKey, selectedTargetModel.id)) {
            await discardReviewedModelBranch(connection, branch).catch(() => undefined);
            return;
          }
          setRefreshPreview({
            branch,
            targetModel: selectedTargetModel,
            status: response.status || 'running',
            affectedViewNames: [...lastScannedViews],
            validation: null,
            releaseEvidence: null,
          });
          setRefreshApproval(null);
          setMessage(`Hard schema refresh queued on branch ${branch.branchName}. Wait for Omni to finish, then check the branch before handoff.`);
        } catch (refreshError) {
          await discardReviewedModelBranch(connection, branch).catch(() => undefined);
          throw refreshError;
        }
      } else {
        const response = await refreshModel(connection.baseUrl, connection.apiKey, selectedModel.id);
        if (!isCurrent(requestKey, schemaModelId)) return;
        logOperation('model_governance', `Hard schema refresh queued for ${selectedModel.name}`, {
          itemCount: 1,
          successCount: 1,
          details: {
            operation: 'hard_schema_refresh',
            modelId: selectedModel.id,
            modelName: selectedModel.name,
            publishMode: 'direct',
          },
        });
        setResult({
          title: 'Hard refresh queued',
          message: `Omni reported ${response.status || 'running'}. Rescan after completion to compare which views were removed.`,
          mode: 'queued',
        });
        setMessage('Hard schema refresh queued. Omni manages this asynchronous operation. Rescan after it finishes.');
      }
    } catch (refreshError) {
      if (isCurrent(requestKey, schemaModelId)) setError(refreshError instanceof Error ? refreshError.message : 'Could not queue hard schema refresh.');
    } finally {
      if (isCurrent(requestKey, schemaModelId)) setLoading(false);
    }
  }

  async function checkRefreshBranch() {
    if (!refreshPreview) return;
    setLoading(true);
    setError('');
    try {
      const affectedContentEvidence = await collectTargetedAffectedContent(
        connection,
        refreshPreview.targetModel.id,
        refreshPreview.affectedViewNames.map((viewName) => ({ type: 'VIEW', name: viewName })),
      );
      const releaseEvidence = await collectReleaseGateEvidence({
        connection,
        model: refreshPreview.targetModel,
        branch: refreshPreview.branch,
        ...affectedContentEvidence,
      });
      setRefreshPreview({ ...refreshPreview, validation: releaseEvidence.validation, releaseEvidence });
      setRefreshApproval(null);
      setMessage(releaseEvidence.status === 'blocked'
        ? 'The refresh release gate still has blockers or is still processing. Review the evidence and check again.'
        : 'The refresh branch is validation-ready. Approve the exact release evidence before handoff.');
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : 'Could not validate refresh branch.');
    } finally {
      setLoading(false);
    }
  }

  async function publishRefreshBranch() {
    if (!refreshPreview?.releaseEvidence || refreshPreview.releaseEvidence.status === 'blocked') return;
    setPublishing(true);
    setError('');
    try {
      const affectedContentEvidence = await collectTargetedAffectedContent(
        connection,
        refreshPreview.targetModel.id,
        refreshPreview.affectedViewNames.map((viewName) => ({ type: 'VIEW', name: viewName })),
      );
      const releaseEvidence = await collectReleaseGateEvidence({
        connection,
        model: refreshPreview.targetModel,
        branch: refreshPreview.branch,
        ...affectedContentEvidence,
      });
      const currentApproval = reconcileReleaseGateApproval(refreshApproval, releaseEvidence);
      if (!currentApproval) {
        setRefreshPreview({ ...refreshPreview, validation: releaseEvidence.validation, releaseEvidence });
        setRefreshApproval(null);
        setError('Release evidence changed or is blocked. Review the refreshed fingerprint and approve it again before handoff.');
        return;
      }
      const publish = await prepareReviewedModelHandoff(connection, refreshPreview.branch, 'Review OmniKit hard schema refresh');
      logOperation('model_governance', `Hard schema refresh sent for review for ${refreshPreview.targetModel.name}`, {
        itemCount: 1,
        successCount: 1,
        details: {
          operation: 'hard_schema_refresh',
          modelId: refreshPreview.targetModel.id,
          modelName: refreshPreview.targetModel.name,
          branchName: refreshPreview.branch.branchName,
          publishMode: publish.mode,
        },
      });
      setResult(resultFromPublish('Hard refresh result', publish));
      setRefreshPreview(null);
      setRefreshApproval(null);
      setMessage(publish.message);
    } catch (publishError) {
      if (publishError instanceof ReviewedPullRequestVerificationError) {
        setResult({
          title: 'Refresh handoff needs reconciliation',
          message: `${publishError.message} No retry is allowed until the reported review is reconciled in Omni.`,
          mode: 'quarantined',
          url: publishError.reviewUrl || refreshPreview.branch.capability.webUrl || connection.baseUrl,
        });
        setRefreshPreview(null);
        setRefreshApproval(null);
      } else {
        setError(publishError instanceof Error ? publishError.message : 'Could not prepare the refresh handoff.');
      }
    } finally {
      setPublishing(false);
    }
  }

  async function discardRefreshBranch() {
    if (!refreshPreview) return;
    setLoading(true);
    setError('');
    try {
      await discardReviewedModelBranch(connection, refreshPreview.branch);
      setRefreshPreview(null);
      setRefreshApproval(null);
      setResult({ title: 'Refresh branch discarded', message: 'No schema refresh changes were published.', mode: 'discarded' });
    } catch (discardError) {
      setError(discardError instanceof Error ? discardError.message : 'Could not discard refresh branch.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4" role="tabpanel" id="model-tabpanel-cleanup" aria-labelledby="model-tab-cleanup">
      <section className="card p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-content-primary">Stale view cleanup</h2>
            <p className="mt-1 text-sm text-content-secondary">
              Detect drift in the schema model, verify live content references, then use hard refresh or stage a surgical shared-model change.
            </p>
          </div>
          <div className="grid min-w-[220px] gap-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Connection</label>
            <select
              value={selectedConnectionId}
              onChange={(event) => {
                setSelectedConnectionId(event.target.value);
                setSelectedModelId('');
                activeModelRef.current = '';
                setSelectedTargetModelId('');
                activeTargetModelRef.current = '';
                setCandidates([]);
                setSelectedViews(new Set());
                resetStagedWork();
              }}
              className="input-field"
            >
              <option value="all">All connections</option>
              {schemaConnectionIds.map((connectionId) => <option key={connectionId} value={connectionId}>{connectionId}</option>)}
            </select>
          </div>
          <div className="grid min-w-[280px] gap-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Schema model to scan</label>
            <select
              value={selectedModelId}
              onChange={(event) => {
                activeModelRef.current = event.target.value;
                setSelectedModelId(event.target.value);
                setCandidates([]);
                setSelectedViews(new Set());
                resetStagedWork();
              }}
              className="input-field"
            >
              <option value="">Choose schema model</option>
              {schemaModels.map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
            </select>
          </div>
        </div>

        {selectedModel && (
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Shared model for surgical cleanup</label>
              <select value={selectedTargetModelId} onChange={(event) => { activeTargetModelRef.current = event.target.value; setSelectedTargetModelId(event.target.value); resetStagedWork(); }} className="input-field mt-1">
                <option value="">Choose associated shared model</option>
                {relatedTargetModels.map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
              </select>
              {relatedTargetModels.length === 0 && (
                <p className="mt-1 text-xs text-amber-800">No editable shared model reports this schema model as its base. Hard refresh remains available, but surgical cleanup and reference verification are blocked.</p>
              )}
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Hard refresh path</label>
              <select value={hardRefreshMode} onChange={(event) => setHardRefreshMode(event.target.value as HardRefreshMode)} className="input-field mt-1">
                <option value="direct">Run directly</option>
                <option value="branch" disabled={!selectedTargetModel}>Stage on shared-model branch</option>
              </select>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={scanCandidates} disabled={!selectedModel || loading} className="btn-primary text-sm">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            Scan for stale views
          </button>
          <button type="button" onClick={() => setConfirmHardRefresh(true)} disabled={!selectedModel || loading} className="btn-secondary text-sm">
            <RefreshCw size={14} />
            Run hard schema refresh
          </button>
          <label className="inline-flex items-center gap-2 text-xs text-content-secondary">
            <input type="checkbox" checked={includeManualCandidates} onChange={(event) => setIncludeManualCandidates(event.target.checked)} className="rounded border-border text-omni-700 focus:ring-omni-500" />
            Include every view for manual review
          </label>
        </div>
        <div className="mt-3 rounded-card border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          Hard refresh is Omni’s recommended path for dropped database objects. Surgical cleanup never edits the schema model directly; it stages an ignored view in an associated shared-model branch.
        </div>
      </section>

      <div aria-live="polite" aria-atomic="true">
        {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {!error && message && <div className="rounded-card border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{message}</div>}
      </div>

      <section className="card p-4 space-y-3" aria-label="Stale view candidates">
        <div className="grid gap-3 xl:grid-cols-[1fr_180px_auto_auto]">
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-tertiary" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} className="input-field pl-9" placeholder="Search view, file, or validation evidence..." />
          </div>
          <select value={filter} onChange={(event) => setFilter(event.target.value as CandidateFilter)} className="input-field" aria-label="Filter candidates">
            <option value="all">All candidates</option>
            <option value="safe">Safe select</option>
            <option value="broken">Broken/source drift</option>
            <option value="referenced">Referenced</option>
            <option value="unknown">Unknown risk</option>
            <option value="manual">Manual review</option>
          </select>
          <button type="button" onClick={selectSafe} disabled={candidates.length === 0} className="btn-secondary text-sm">Select safe</button>
          <button type="button" onClick={previewSurgicalCleanup} disabled={selectedCandidates.length === 0 || loading || !selectedTargetModel} className="btn-primary text-sm">
            <GitBranch size={14} />
            Preview branch
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[
            ['Candidates', candidates.length, 'text-content-primary'],
            ['Safe', candidates.filter((row) => row.safeByDefault).length, 'text-green-700'],
            ['Referenced/unknown', candidates.filter((row) => row.referenceStatus !== 'verified-zero').length, 'text-amber-700'],
            ['Selected', selectedCandidates.length, 'text-omni-700'],
          ].map(([label, value, color]) => (
            <div key={String(label)} className="rounded-card border border-border bg-surface-secondary p-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">{label}</div>
              <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-card border border-border">
          {filteredCandidates.length === 0 ? (
            <div className="p-8 text-center text-sm text-content-secondary">Scan a schema model to see exact stale-view candidates.</div>
          ) : filteredCandidates.map((candidate) => {
            const isSelected = selectedViews.has(candidate.viewName);
            const riskColor = candidate.safeByDefault ? 'text-green-700' : candidate.referenceStatus === 'referenced' ? 'text-amber-700' : 'text-red-700';
            return (
              <div key={candidate.viewName} className="grid gap-3 border-b border-border/70 px-4 py-3 last:border-b-0 xl:grid-cols-[24px_minmax(0,1fr)_220px_150px]">
                <input type="checkbox" checked={isSelected} onChange={() => toggleView(candidate)} className="mt-1 rounded border-border text-omni-700 focus:ring-omni-500" aria-label={`Include ${candidate.viewName}`} />
                <div className="min-w-0">
                  <div className="font-semibold text-content-primary">{candidate.label || candidate.viewName}</div>
                  <div className="font-mono text-xs text-content-secondary">{candidate.fileName}</div>
                  <div className="mt-1 text-xs text-content-secondary">Reason: {candidate.reason.replace(/-/g, ' ')}</div>
                  {candidate.validationIssues[0] && <div className="mt-1 text-xs text-amber-800">{candidate.validationIssues[0]}</div>}
                  {candidate.references.length > 0 && (
                    <details className="mt-2 text-xs text-content-secondary">
                      <summary className="cursor-pointer font-semibold">Show referenced content</summary>
                      <div className="mt-1 space-y-1">
                        {candidate.references.slice(0, 8).map((reference) => (
                          <div key={`${reference.documentId}:${reference.identifier}`}>{reference.name}{reference.folderPath ? ` · ${reference.folderPath}` : ''}{reference.queryNames.length ? ` · ${reference.queryNames.join(', ')}` : ''}</div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
                <div className="text-sm">
                  <div className={riskColor}>{candidate.safeByDefault ? 'Safe by default' : 'Explicit review required'}</div>
                  <div className="text-xs text-content-secondary">{referenceLabel(candidate)}</div>
                  {candidate.referenceError && <div className="mt-1 text-xs text-red-700">{candidate.referenceError}</div>}
                </div>
                <div className="text-sm text-content-secondary">{confidenceLabel(candidate)}</div>
              </div>
            );
          })}
        </div>
      </section>

      {preview && (
        <section className="card p-5 space-y-4" aria-label="Cleanup branch preview">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-content-primary">Cleanup branch preview</h3>
              <p className="mt-1 text-sm text-content-secondary">{preview.branch.branchName} on {preview.targetModel.name}. Main remains untouched.</p>
            </div>
            <div className={preview.releaseEvidence.status === 'blocked' ? 'rounded-chip bg-red-50 px-3 py-1 text-sm font-semibold text-red-700' : 'rounded-chip bg-green-50 px-3 py-1 text-sm font-semibold text-green-700'}>
              {preview.releaseEvidence.status === 'blocked' ? 'Release gate blocked' : preview.branch.capability.pullRequestRequired ? 'Ready for PR' : 'Ready for manual handoff'}
            </div>
          </div>
          <div className="overflow-hidden rounded-card border border-border">
            {preview.results.map((row) => (
              <div key={row.viewName} className="grid gap-2 border-b border-border/70 px-3 py-2 text-sm last:border-b-0 md:grid-cols-[1fr_1fr_auto]">
                <div><div className="font-semibold text-content-primary">{row.viewName}</div><div className="font-mono text-xs text-content-secondary">Source: {row.fileName}</div></div>
                <div><div className="font-mono text-xs text-content-secondary">Target: {row.targetFileName}</div><div className="text-xs text-content-secondary">{row.detail}</div></div>
                {row.status === 'staged' ? <CheckCircle2 size={16} className="text-green-700" /> : <AlertTriangle size={16} className="text-red-700" />}
              </div>
            ))}
          </div>
          {(preview.validation.modelIssues.length > 0 || preview.validation.contentIssueCount > 0 || preview.validation.contentError) && (
            <div className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <div className="font-semibold">Validation summary</div>
              <div className="mt-1">{preview.validation.modelIssues.slice(0, 4).map((issue) => issue.message || issue.yaml_path || 'Validation issue').join(' · ') || preview.validation.contentError || `${preview.validation.contentIssueCount} content issue${preview.validation.contentIssueCount === 1 ? '' : 's'} found.`}</div>
            </div>
          )}
          <ReleaseGateEvidencePanel
            evidence={preview.releaseEvidence}
            approval={cleanupApproval}
            onApprovalChange={setCleanupApproval}
            disabled={publishing}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={discardCleanup} disabled={loading || publishing} className="btn-secondary text-sm"><XCircle size={14} />Discard branch</button>
            <button type="button" onClick={publishCleanup} disabled={publishing || preview.releaseEvidence.status === 'blocked' || preview.results.every((row) => row.status !== 'staged') || !cleanupApproval} className="btn-primary text-sm">
              {publishing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              {preview.branch.capability.pullRequestRequired ? 'Create PR handoff' : 'Prepare manual handoff'}
            </button>
          </div>
        </section>
      )}

      {refreshPreview && (
        <section className="card p-5 space-y-3" aria-label="Hard refresh branch">
          <div className="flex items-start gap-3"><RefreshCw size={18} className="mt-0.5 text-omni-700" /><div><h3 className="font-semibold text-content-primary">Hard refresh branch</h3><p className="text-sm text-content-secondary">{refreshPreview.branch.branchName} · Omni status: {refreshPreview.status}</p></div></div>
          {refreshPreview.validation && (
            <div className={refreshPreview.releaseEvidence?.status === 'blocked' ? 'rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900' : 'rounded-card border border-green-200 bg-green-50 p-3 text-sm text-green-800'}>
              {refreshPreview.releaseEvidence?.status === 'blocked' ? 'The release gate has blockers or the refresh is still processing.' : 'Model and content validation are ready.'}
            </div>
          )}
          {refreshPreview.releaseEvidence && (
            <ReleaseGateEvidencePanel
              evidence={refreshPreview.releaseEvidence}
              approval={refreshApproval}
              onApprovalChange={setRefreshApproval}
              disabled={publishing}
            />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={discardRefreshBranch} disabled={loading || publishing} className="btn-secondary text-sm"><XCircle size={14} />Discard branch</button>
            <button type="button" onClick={checkRefreshBranch} disabled={loading || publishing} className="btn-secondary text-sm"><ShieldAlert size={14} />Check branch</button>
            <button type="button" onClick={publishRefreshBranch} disabled={publishing || !refreshPreview.releaseEvidence || refreshPreview.releaseEvidence.status === 'blocked' || !refreshApproval} className="btn-primary text-sm"><CheckCircle2 size={14} />{refreshPreview.branch.capability.pullRequestRequired ? 'Create PR handoff' : 'Prepare manual handoff'}</button>
          </div>
        </section>
      )}

      {result && (
        <section className="card p-5" aria-live="polite">
          <div className="flex items-start gap-3"><CheckCircle2 size={20} className={result.mode === 'discarded' ? 'text-content-secondary' : 'text-green-700'} /><div className="min-w-0"><h3 className="font-semibold text-content-primary">{result.title}</h3><p className="mt-1 text-sm text-content-secondary">{result.message}</p>{result.url && <a href={result.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-omni-700 underline">{result.mode === 'pull_request' ? 'Open pull request' : result.mode === 'quarantined' ? 'Open Omni to reconcile' : 'Open Omni for sign-off'} <ExternalLink size={13} /></a>}{result.removedViews && <div className="mt-2 text-sm text-content-secondary">Removed: {result.removedViews.join(', ')}</div>}</div></div>
        </section>
      )}

      <ConfirmDialog
        open={Boolean(pendingOverride)}
        title="Include a protected candidate?"
        message={pendingOverride?.referenceStatus === 'referenced'
          ? `${pendingOverride.viewName} is referenced by live content. Including it may break dashboards or workbooks.`
          : `${pendingOverride?.viewName || 'This view'} does not have a confirmed zero-reference result. OmniKit cannot classify it as safe.`}
        confirmLabel="Include candidate"
        variant="danger"
        requireTypedConfirmation
        confirmationPhrase="INCLUDE"
        onConfirm={includeOverrideCandidate}
        onCancel={() => setPendingOverride(null)}
      />
      <ConfirmDialog
        open={confirmHardRefresh}
        title={hardRefreshMode === 'branch' ? 'Queue branch-based hard refresh?' : 'Run hard schema refresh now?'}
        message={hardRefreshMode === 'branch'
          ? 'Omni will refresh the associated shared model on a review branch. You must wait for completion, validate, and explicitly publish.'
          : 'Omni will immediately start a hard refresh of the schema model. Dropped database structures can be removed, and this path is less granular than surgical cleanup.'}
        confirmLabel="Run hard refresh"
        variant="danger"
        requireTypedConfirmation
        confirmationPhrase="REFRESH"
        onConfirm={runHardRefresh}
        onCancel={() => setConfirmHardRefresh(false)}
      />
    </div>
  );
}
