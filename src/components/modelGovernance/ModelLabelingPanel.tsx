import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, GitBranch, Loader2, Search, Tags, XCircle } from 'lucide-react';
import type { ConnectionConfig, OmniModel } from '@/types';
import { getModelYaml, updateModelYamlFiles } from '@/services/omniApi';
import {
  applyLabelPatches,
  buildLabelPatternValue,
  findFilesChangedSinceLoad,
  parseSemanticInventory,
  type LabelPatch,
  type SemanticFieldRow,
  type SemanticInventory,
  type SemanticTopicRow,
  type SemanticViewRow,
} from '@/services/modelGovernance';
import { useLogOperation } from '@/hooks/useOperationLog';
import { getConnectionCacheKey } from '@/services/connectionGuards';
import { ReleaseGateEvidencePanel } from '@/components/modelGovernance/ReleaseGateEvidencePanel';
import {
  collectReleaseGateEvidence,
  reconcileReleaseGateApproval,
  type ReleaseGateAffectedContentScope,
  type ReleaseGateApproval,
  type ReleaseGateEvidence,
} from '@/services/releaseGateEvidence';
import {
  discardReviewedModelBranch,
  inspectModelWriteCapability,
  isGovernanceEditableModel,
  prepareReviewedModelHandoff,
  ReviewedPullRequestVerificationError,
  startReviewedModelBranch,
  type ModelWriteCapability,
  type ReviewedModelBranch,
  type ReviewedValidation,
} from '@/services/reviewedModelWrite';

interface ModelLabelingPanelProps {
  connection: ConnectionConfig;
  models: OmniModel[];
}

type LabelMode = 'topics' | 'views' | 'field-groups';
type BulkMode = 'set' | 'prefix' | 'title-case' | 'find-replace' | 'clear';

interface LabelPreview {
  branch: ReviewedModelBranch;
  targetModel: OmniModel;
  patches: LabelPatch[];
  changedFiles: Array<{ fileName: string; yaml: string }>;
  validation: ReviewedValidation;
  releaseEvidence: ReleaseGateEvidence;
  warnings: string[];
}

interface LabelResult {
  mode: 'manual_handoff' | 'pull_request' | 'quarantined' | 'discarded';
  message: string;
  patches: LabelPatch[];
  url?: string;
}

function editableModels(models: OmniModel[]): OmniModel[] {
  return models.filter(isGovernanceEditableModel);
}

function labelModel(model: OmniModel): string {
  return `${model.name}${model.kind ? ` · ${model.kind.replace(/_/g, ' ')}` : ''}`;
}

function patchName(patch: LabelPatch): string {
  if (patch.kind === 'field') return `${patch.viewName}.${patch.fieldName}`;
  return patch.name;
}

function labelAffectedContentScope(patches: LabelPatch[]): ReleaseGateAffectedContentScope {
  return {
    state: 'metadata_only',
    basis: 'metadata_only_label_change',
    targets: patches.map((patch) => ({
      type: patch.kind === 'topic' ? 'TOPIC' : patch.kind === 'view' ? 'VIEW' : 'FIELD_GROUP',
      name: patch.kind === 'field' ? `${patch.viewName}.${patch.fieldName}` : patch.name,
    })),
  };
}

export function ModelLabelingPanel({ connection, models }: ModelLabelingPanelProps) {
  const logOperation = useLogOperation();
  const connectionKey = getConnectionCacheKey(connection);
  const activeConnectionRef = useRef(connectionKey);
  const modelConnectionIds = useMemo(() => (
    [...new Set(editableModels(models).map((model) => model.connectionId).filter(Boolean))]
      .sort() as string[]
  ), [models]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('all');
  const modelOptions = useMemo(() => editableModels(models).filter((model) => (
    selectedConnectionId === 'all' || model.connectionId === selectedConnectionId
  )), [models, selectedConnectionId]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const activeModelRef = useRef('');
  const [mode, setMode] = useState<LabelMode>('topics');
  const [inventory, setInventory] = useState<SemanticInventory | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [checksums, setChecksums] = useState<Record<string, string>>({});
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectedViewName, setSelectedViewName] = useState('');
  const [search, setSearch] = useState('');
  const [bulkMode, setBulkMode] = useState<BulkMode>('title-case');
  const [bulkValue, setBulkValue] = useState('');
  const [bulkFind, setBulkFind] = useState('');
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<LabelPreview | null>(null);
  const [result, setResult] = useState<LabelResult | null>(null);
  const [releaseApproval, setReleaseApproval] = useState<ReleaseGateApproval | null>(null);
  const [capability, setCapability] = useState<ModelWriteCapability | null>(null);

  const selectedModel = models.find((model) => model.id === selectedModelId) || null;
  const topics = inventory?.topics || [];
  const views = inventory?.views || [];
  const fields = inventory?.fields || [];
  const viewFilteredFields = selectedViewName ? fields.filter((field) => field.viewName === selectedViewName) : fields;

  const activeRows = mode === 'topics'
    ? topics
    : mode === 'views'
      ? views
      : viewFilteredFields;

  const filteredRows = activeRows.filter((row) => {
    const needle = search.toLowerCase();
    if (!needle) return true;
    if ('viewName' in row) {
      return row.name.toLowerCase().includes(needle)
        || row.viewName.toLowerCase().includes(needle)
        || row.groupLabel.toLowerCase().includes(needle);
    }
    return row.name.toLowerCase().includes(needle) || row.label.toLowerCase().includes(needle);
  });

  useEffect(() => {
    activeConnectionRef.current = connectionKey;
    setSelectedConnectionId('all');
    setSelectedModelId('');
    activeModelRef.current = '';
    resetWorkState();
    setCapability(null);
    setResult(null);
  }, [connectionKey]);

  function rowKey(row: SemanticTopicRow | SemanticViewRow | SemanticFieldRow): string {
    if ('viewName' in row) return `field:${row.fileName}:${row.kind}:${row.name}`;
    return `${mode === 'topics' ? 'topic' : 'view'}:${row.fileName}`;
  }

  function currentValue(row: SemanticTopicRow | SemanticViewRow | SemanticFieldRow): string {
    if ('viewName' in row) return row.groupLabel;
    return row.label;
  }

  function draftValue(row: SemanticTopicRow | SemanticViewRow | SemanticFieldRow): string {
    const key = rowKey(row);
    return Object.prototype.hasOwnProperty.call(draftValues, key) ? draftValues[key] : currentValue(row);
  }

  function resetWorkState() {
    setInventory(null);
    setFiles({});
    setChecksums({});
    setDraftValues({});
    setSelectedKeys(new Set());
    setPreview(null);
    setReleaseApproval(null);
    setResult(null);
    setSelectedViewName('');
  }

  async function loadInventory() {
    if (!selectedModel) return;
    const requestKey = connectionKey;
    const modelId = selectedModel.id;
    setLoading(true);
    setError('');
    setMessage('');
    setPreview(null);
    setReleaseApproval(null);
    setResult(null);
    try {
      const nextCapability = await inspectModelWriteCapability(connection, selectedModel);
      if (activeConnectionRef.current !== requestKey || activeModelRef.current !== modelId) return;
      setCapability(nextCapability);
      if (!nextCapability.editable) throw new Error(nextCapability.reason || 'This model is not editable.');
      const yaml = await getModelYaml(connection.baseUrl, connection.apiKey, modelId, {
        includeChecksums: true,
      });
      if (activeConnectionRef.current !== requestKey || activeModelRef.current !== modelId) return;
      const nextFiles = yaml.files || {};
      const nextInventory = parseSemanticInventory(nextFiles);
      setFiles(nextFiles);
      setChecksums(yaml.checksums || {});
      setInventory(nextInventory);
      setDraftValues({});
      setSelectedKeys(new Set());
      setSelectedViewName(nextInventory.views[0]?.name || '');
      const warningText = nextInventory.warnings.length > 0
        ? ` ${nextInventory.warnings.length} YAML file${nextInventory.warnings.length === 1 ? '' : 's'} could not be parsed and will not be edited.`
        : '';
      setMessage(`Loaded ${nextInventory.topics.length} topics, ${nextInventory.views.length} views, and ${nextInventory.fields.length} fields from ${selectedModel.name}.${warningText}`);
    } catch (err) {
      if (activeConnectionRef.current === requestKey && activeModelRef.current === modelId) setError(err instanceof Error ? err.message : 'Could not load model YAML for labeling.');
    } finally {
      if (activeConnectionRef.current === requestKey && activeModelRef.current === modelId) setLoading(false);
    }
  }

  function toggleRow(row: SemanticTopicRow | SemanticViewRow | SemanticFieldRow) {
    setPreview(null);
    const key = rowKey(row);
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setDraft(row: SemanticTopicRow | SemanticViewRow | SemanticFieldRow, value: string) {
    setPreview(null);
    const key = rowKey(row);
    setDraftValues((current) => ({ ...current, [key]: value }));
  }

  function selectVisible() {
    setPreview(null);
    setSelectedKeys(new Set(filteredRows.map((row) => rowKey(row))));
  }

  function applyBulkToSelection() {
    setPreview(null);
    const selectedRows = activeRows.filter((row) => selectedKeys.has(rowKey(row)));
    if (selectedRows.length === 0) {
      setError('Select at least one topic, view, or field first.');
      return;
    }
    setDraftValues((current) => {
      const next = { ...current };
      for (const row of selectedRows) {
        const before = Object.prototype.hasOwnProperty.call(next, rowKey(row)) ? next[rowKey(row)] : currentValue(row);
        next[rowKey(row)] = buildLabelPatternValue({
          name: row.name,
          current: before,
          mode: bulkMode,
          value: bulkValue,
          find: bulkFind,
        });
      }
      return next;
    });
    setMessage(`Applied ${bulkMode.replace('-', ' ')} to ${selectedRows.length} selected row${selectedRows.length === 1 ? '' : 's'}. Review the before/after values before previewing a branch.`);
  }

  function buildPatches(): LabelPatch[] {
    if (!inventory) return [];
    const patches: LabelPatch[] = [];
    for (const topic of inventory.topics) {
      const key = `topic:${topic.fileName}`;
      if (!Object.prototype.hasOwnProperty.call(draftValues, key)) continue;
      if (draftValues[key] === topic.label) continue;
      patches.push({ kind: 'topic', fileName: topic.fileName, name: topic.name, before: topic.label, after: draftValues[key] });
    }
    for (const view of inventory.views) {
      const key = `view:${view.fileName}`;
      if (!Object.prototype.hasOwnProperty.call(draftValues, key)) continue;
      if (draftValues[key] === view.label) continue;
      patches.push({ kind: 'view', fileName: view.fileName, name: view.name, before: view.label, after: draftValues[key] });
    }
    for (const field of inventory.fields) {
      const key = `field:${field.fileName}:${field.kind}:${field.name}`;
      if (!Object.prototype.hasOwnProperty.call(draftValues, key)) continue;
      if (draftValues[key] === field.groupLabel) continue;
      patches.push({
        kind: 'field',
        fileName: field.fileName,
        viewName: field.viewName,
        fieldName: field.name,
        fieldKind: field.kind,
        before: field.groupLabel,
        after: draftValues[key],
      });
    }
    return patches;
  }

  async function previewBranch() {
    if (!selectedModel) return;
    if (!selectedModel.connectionId) {
      setError('This model is missing a connection ID, so OmniKit cannot create a reviewed labeling branch.');
      return;
    }
    const patches = buildPatches();
    if (patches.length === 0) {
      setError('No label changes are staged. Edit values or apply a bulk action first.');
      return;
    }
    const requestKey = connectionKey;
    const modelId = selectedModel.id;
    setLoading(true);
    setError('');
    setMessage('');
    setPreview(null);
    setResult(null);
    let branch: ReviewedModelBranch | null = null;
    try {
      branch = await startReviewedModelBranch(connection, selectedModel, 'omnikit-model-labels');
      const branchYaml = await getModelYaml(connection.baseUrl, connection.apiKey, selectedModel.id, {
        branchId: branch.branchId,
        mode: 'combined',
        includeChecksums: true,
      });
      if (activeConnectionRef.current !== requestKey || activeModelRef.current !== modelId) {
        await discardReviewedModelBranch(connection, branch).catch(() => undefined);
        return;
      }
      const affectedFiles = [...new Set(patches.map((patch) => patch.fileName))];
      const changedSinceLoad = findFilesChangedSinceLoad({
        affectedFiles,
        originalFiles: files,
        originalChecksums: checksums,
        branchFiles: branchYaml.files || {},
        branchChecksums: branchYaml.checksums || {},
      });
      if (changedSinceLoad.length > 0) {
        throw new Error(`The model changed after labels were loaded: ${changedSinceLoad.join(', ')}. Reload labels and reapply your edits.`);
      }
      const patchResult = applyLabelPatches(branchYaml.files || {}, patches);
      if (patchResult.changedFiles.length === 0) throw new Error('No YAML files changed after applying the staged label decisions.');
      await updateModelYamlFiles(connection.baseUrl, connection.apiKey, {
        modelId: selectedModel.id,
        branchId: branch.branchId,
        mode: 'combined',
        files: patchResult.changedFiles.map((file) => ({
          ...file,
          previousChecksum: branchYaml.checksums?.[file.fileName],
        })),
        commitMessage: 'OmniKit model label updates',
      });
      const releaseEvidence = await collectReleaseGateEvidence({
        connection,
        model: selectedModel,
        branch,
        affectedFiles: patchResult.changedFiles.map((file) => file.fileName),
        affectedContentScope: labelAffectedContentScope(patchResult.deltas),
      });
      if (activeConnectionRef.current !== requestKey || activeModelRef.current !== modelId) {
        await discardReviewedModelBranch(connection, branch).catch(() => undefined);
        return;
      }
      setPreview({
        branch,
        targetModel: selectedModel,
        patches: patchResult.deltas,
        changedFiles: patchResult.changedFiles,
        validation: releaseEvidence.validation,
        releaseEvidence,
        warnings: patchResult.warnings,
      });
      setReleaseApproval(null);
      setMessage(releaseEvidence.status === 'blocked'
        ? 'Labeling branch is staged, but the release gate is blocked. Review the evidence before handoff.'
        : 'Labeling branch is ready for review. Approve the exact release evidence before handoff.');
    } catch (err) {
      if (branch) await discardReviewedModelBranch(connection, branch).catch(() => undefined);
      if (activeConnectionRef.current === requestKey && activeModelRef.current === modelId) setError(err instanceof Error ? err.message : 'Could not preview labeling changes on a branch.');
    } finally {
      if (activeConnectionRef.current === requestKey && activeModelRef.current === modelId) setLoading(false);
    }
  }

  async function publishPreview() {
    if (!preview || preview.releaseEvidence.status === 'blocked') return;
    const requestKey = connectionKey;
    const modelId = preview.targetModel.id;
    setPublishing(true);
    setError('');
    try {
      const releaseEvidence = await collectReleaseGateEvidence({
        connection,
        model: preview.targetModel,
        branch: preview.branch,
        affectedFiles: preview.changedFiles.map((file) => file.fileName),
        affectedContentScope: labelAffectedContentScope(preview.patches),
      });
      if (activeConnectionRef.current !== requestKey || activeModelRef.current !== modelId) return;
      const currentApproval = reconcileReleaseGateApproval(releaseApproval, releaseEvidence);
      if (!currentApproval) {
        setPreview({ ...preview, validation: releaseEvidence.validation, releaseEvidence });
        setReleaseApproval(null);
        setError('Release evidence changed or is blocked. Review the refreshed fingerprint and approve it again before handoff.');
        return;
      }
      const publish = await prepareReviewedModelHandoff(connection, preview.branch, 'Review OmniKit model labels');
      if (activeConnectionRef.current !== requestKey || activeModelRef.current !== modelId) return;
      const topicCount = preview.patches.filter((patch) => patch.kind === 'topic').length;
      const viewCount = preview.patches.filter((patch) => patch.kind === 'view').length;
      const fieldCount = preview.patches.filter((patch) => patch.kind === 'field').length;
      logOperation('model_governance', `Model labeling sent for review for ${preview.targetModel.name}`, {
        itemCount: preview.patches.length,
        successCount: preview.patches.length,
        details: {
          operation: 'model_labeling',
          modelId: preview.targetModel.id,
          modelName: preview.targetModel.name,
          branchName: preview.branch.branchName,
          publishMode: publish.mode,
          topicCount,
          viewCount,
          fieldCount,
        },
      });
      setResult({
        mode: publish.mode,
        message: publish.message,
        patches: preview.patches,
        url: publish.url,
      });
      setPreview(null);
      setReleaseApproval(null);
      setMessage(publish.message);
    } catch (err) {
      if (activeConnectionRef.current === requestKey && activeModelRef.current === modelId) {
        if (err instanceof ReviewedPullRequestVerificationError) {
          setResult({
            mode: 'quarantined',
            message: `${err.message} No retry is allowed until the reported review is reconciled in Omni.`,
            patches: preview.patches,
            url: err.reviewUrl || preview.branch.capability.webUrl || connection.baseUrl,
          });
          setPreview(null);
          setReleaseApproval(null);
        } else {
          setError(err instanceof Error ? err.message : 'Could not prepare the labeling handoff.');
        }
      }
    } finally {
      if (activeConnectionRef.current === requestKey && activeModelRef.current === modelId) setPublishing(false);
    }
  }

  async function discardPreview() {
    if (!preview) return;
    setLoading(true);
    setError('');
    try {
      await discardReviewedModelBranch(connection, preview.branch);
      setResult({ mode: 'discarded', message: 'No model changes were published.', patches: preview.patches });
      setPreview(null);
      setReleaseApproval(null);
      setMessage('Labeling branch discarded. No model changes were published.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not discard labeling branch.');
    } finally {
      setLoading(false);
    }
  }

  const branchHasErrors = Boolean(preview?.releaseEvidence.status === 'blocked');

  return (
    <div className="space-y-4" role="tabpanel" id="model-tabpanel-labeling" aria-labelledby="model-tab-labeling">
      <div className="card p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-content-primary">Model labeling</h2>
            <p className="mt-1 text-sm text-content-secondary">
              Bulk-set topic and view labels, or assign field group labels, then validate the YAML on a branch before human handoff.
            </p>
          </div>
          <div className="grid min-w-[240px] gap-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Connection</label>
            <select
              value={selectedConnectionId}
              onChange={(event) => {
                setSelectedConnectionId(event.target.value);
                setSelectedModelId('');
                resetWorkState();
              }}
              className="input-field"
            >
              <option value="all">All connections</option>
              {modelConnectionIds.map((connectionId) => (
                <option key={connectionId} value={connectionId}>{connectionId}</option>
              ))}
            </select>
          </div>
          <div className="grid min-w-[320px] gap-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Editable model</label>
            <select value={selectedModelId} onChange={(event) => { activeModelRef.current = event.target.value; setSelectedModelId(event.target.value); setCapability(null); resetWorkState(); }} className="input-field">
              <option value="">Choose model</option>
              {modelOptions.map((model) => (
                <option key={model.id} value={model.id}>{labelModel(model)}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={loadInventory} disabled={!selectedModel || loading} className="btn-primary text-sm">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Tags size={14} />}
            Load labels
          </button>
          <div className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Omni separates dimensions and measures that share the same group_label. Use paths like Location &gt; Address when you want nested groups.
          </div>
        </div>
        {capability && (
          <div className={`mt-3 rounded-card border px-3 py-2 text-sm ${capability.editable ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
            {capability.editable
              ? capability.pullRequestRequired
                ? 'This model is editable and requires a pull-request handoff after validation.'
                : 'This model is editable through a reviewed Omni branch.'
              : capability.reason}
          </div>
        )}
      </div>

      <div aria-live="polite" aria-atomic="true">
        {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {!error && message && <div className="rounded-card border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{message}</div>}
      </div>

      <div className="card p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Model labeling modes">
          {([
            ['topics', 'Topics'],
            ['views', 'Views'],
            ['field-groups', 'Field groups'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => { setMode(id); setSelectedKeys(new Set()); setSearch(''); setPreview(null); }}
              className={mode === id ? 'btn-primary text-sm' : 'btn-secondary text-sm'}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 xl:grid-cols-[1fr_180px_180px_180px_auto_auto]">
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-tertiary" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} className="input-field pl-9" placeholder="Search names and labels..." />
          </div>
          {mode === 'field-groups' ? (
            <select value={selectedViewName} onChange={(event) => setSelectedViewName(event.target.value)} className="input-field">
              <option value="">All views</option>
              {views.map((view) => (
                <option key={view.name} value={view.name}>{view.label || view.name}</option>
              ))}
            </select>
          ) : <div />}
          <select value={bulkMode} onChange={(event) => setBulkMode(event.target.value as BulkMode)} className="input-field">
            <option value="title-case">Title case names</option>
            <option value="set">Set same value</option>
            <option value="prefix">Prefix current</option>
            <option value="find-replace">Find/replace</option>
            <option value="clear">Clear</option>
          </select>
          <input value={bulkFind} onChange={(event) => setBulkFind(event.target.value)} disabled={bulkMode !== 'find-replace'} className="input-field" placeholder="Find text" />
          <input value={bulkValue} onChange={(event) => setBulkValue(event.target.value)} disabled={bulkMode === 'title-case' || bulkMode === 'clear'} className="input-field" placeholder={mode === 'field-groups' ? 'Group label' : 'Label value'} />
          <button type="button" onClick={applyBulkToSelection} disabled={selectedKeys.size === 0} className="btn-secondary text-sm">Apply bulk</button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={selectVisible} disabled={filteredRows.length === 0} className="btn-secondary text-sm">Select visible</button>
          <button type="button" onClick={previewBranch} disabled={!inventory || loading || buildPatches().length === 0} className="btn-primary text-sm">
            <GitBranch size={14} />
            Preview branch
          </button>
          <span className="text-xs text-content-secondary">
            {filteredRows.length} visible · {selectedKeys.size} selected · {buildPatches().length} changed
          </span>
        </div>

        <div className="overflow-hidden rounded-card border border-border">
          {!inventory ? (
            <div className="p-8 text-center text-sm text-content-secondary">Load a model to review topic, view, and field labels.</div>
          ) : filteredRows.length === 0 ? (
            <div className="p-8 text-center text-sm text-content-secondary">No rows match this filter.</div>
          ) : filteredRows.map((row) => {
            const key = rowKey(row);
            const value = draftValue(row);
            const before = currentValue(row);
            const changed = value !== before;
            return (
              <label key={key} className="grid cursor-pointer gap-3 border-b border-border/70 px-4 py-3 last:border-b-0 xl:grid-cols-[24px_1fr_240px_240px]">
                <input type="checkbox" checked={selectedKeys.has(key)} onChange={() => toggleRow(row)} className="mt-1 rounded border-border text-omni-700 focus:ring-omni-500" />
                <div className="min-w-0">
                  <div className="font-semibold text-content-primary">{'viewName' in row ? `${row.viewName}.${row.name}` : row.name}</div>
                  <div className="font-mono text-xs text-content-secondary">{row.fileName}</div>
                  {'kind' in row && <div className="mt-1 text-xs text-content-secondary">{row.kind}</div>}
                </div>
                <div className="text-sm">
                  <div className="text-xs font-semibold uppercase tracking-wider text-content-tertiary">Current</div>
                  <div className="mt-1 text-content-secondary">{before || 'No value'}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-content-tertiary">New value</div>
                  <input value={value} onChange={(event) => setDraft(row, event.target.value)} className={`input-field mt-1 h-9 text-sm ${changed ? 'border-omni-300 bg-omni-50' : ''}`} placeholder={mode === 'field-groups' ? 'No group label' : 'No label'} />
                </div>
              </label>
            );
          })}
        </div>
      </div>

      {preview && (
        <div className="card p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-content-primary">Labeling branch preview</h3>
              <p className="mt-1 text-sm text-content-secondary">Branch {preview.branch.branchName} changes {preview.changedFiles.length} YAML file{preview.changedFiles.length === 1 ? '' : 's'} on {preview.targetModel.name}.</p>
            </div>
            <div className={branchHasErrors ? 'rounded-chip bg-red-50 px-3 py-1 text-sm font-semibold text-red-700' : 'rounded-chip bg-green-50 px-3 py-1 text-sm font-semibold text-green-700'}>
              {branchHasErrors ? 'Release gate blocked' : preview.branch.capability.pullRequestRequired ? 'Ready for PR' : 'Validation ready'}
            </div>
          </div>
          <div className="grid gap-2">
            {preview.patches.map((patch) => (
              <div key={`${patch.kind}:${patch.fileName}:${patchName(patch)}`} className="grid gap-2 rounded-card border border-border bg-surface-secondary px-3 py-2 text-sm xl:grid-cols-[1fr_1fr_1fr]">
                <div>
                  <div className="font-semibold text-content-primary">{patchName(patch)}</div>
                  <div className="font-mono text-xs text-content-secondary">{patch.fileName}</div>
                </div>
                <div><span className="text-content-tertiary">Before:</span> {patch.before || 'No value'}</div>
                <div><span className="text-content-tertiary">After:</span> {patch.after || 'Cleared'}</div>
              </div>
            ))}
          </div>
          {preview.warnings.length > 0 && (
            <div className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{preview.warnings.join(' ')}</div>
          )}
          {(preview.validation.modelIssues.length > 0 || preview.validation.contentIssueCount > 0 || preview.validation.contentError) && (
            <div className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <div className="font-semibold">Validation after label changes</div>
              <div className="mt-1">{preview.validation.modelIssues.slice(0, 3).map((issue) => issue.message || issue.yaml_path || 'Validation issue').join(' · ') || preview.validation.contentError || `${preview.validation.contentIssueCount} content issue${preview.validation.contentIssueCount === 1 ? '' : 's'} found.`}</div>
            </div>
          )}
          <ReleaseGateEvidencePanel
            evidence={preview.releaseEvidence}
            approval={releaseApproval}
            onApprovalChange={setReleaseApproval}
            disabled={publishing}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={discardPreview} disabled={loading || publishing} className="btn-secondary text-sm">
              <XCircle size={14} />
              Discard branch
            </button>
            <button type="button" onClick={publishPreview} disabled={publishing || branchHasErrors || !releaseApproval} className="btn-primary text-sm">
              {publishing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {preview.branch.capability.pullRequestRequired ? 'Create PR handoff' : 'Prepare manual handoff'}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="card p-5" aria-live="polite">
          <div className="flex items-start gap-3">
            <CheckCircle2 size={20} className={result.mode === 'discarded' ? 'text-content-secondary' : 'text-green-700'} />
            <div className="min-w-0">
              <h3 className="font-semibold text-content-primary">Model labeling result</h3>
              <p className="mt-1 text-sm text-content-secondary">{result.message}</p>
              <p className="mt-1 text-xs text-content-secondary">{result.patches.length} reviewed label change{result.patches.length === 1 ? '' : 's'}.</p>
              {result.url && <a href={result.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-omni-700 underline">{result.mode === 'pull_request' ? 'Open pull request' : result.mode === 'quarantined' ? 'Open Omni to reconcile' : 'Open Omni for sign-off'} <ExternalLink size={13} /></a>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
