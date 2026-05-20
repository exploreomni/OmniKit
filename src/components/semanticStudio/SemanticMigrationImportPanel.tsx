import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  Database,
  ExternalLink,
  FileCode2,
  FileText,
  Loader2,
  ShieldCheck,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import {
  ApiError,
  createAiJob,
  createModelBranch,
  getAiJob,
  getAiJobResult,
  getModelYaml,
  listModels,
  updateModelYamlFile,
  validateModel,
  validateModelContent,
  type OmniAiJob,
  type OmniAiJobResult,
  type OmniModelYamlResponse,
} from '@/services/omniApi';
import type { OmniModel } from '@/types';
import {
  artifactFromText,
  artifactsFromFiles,
  buildMigrationInventory,
} from '@/services/semanticMigration/adapters';
import {
  buildSemanticMigrationPackagePrompt,
  buildSemanticMigrationPlanPrompt,
} from '@/services/semanticMigration/prompts';
import {
  buildMigrationDiffs,
  extractSemanticMigrationPackage,
  validateSemanticMigrationFiles,
} from '@/services/semanticMigration/package';
import type {
  MigrationArtifact,
  MigrationFileDiff,
  MigrationRunStage,
  MigrationSourceTool,
  PlannedMigrationSourceTool,
  SemanticMigrationFile,
} from '@/services/semanticMigration/types';

const SOURCE_OPTIONS: Array<{ id: MigrationSourceTool; label: string; description: string }> = [
  { id: 'dbt', label: 'dbt', description: 'manifest.json, schema YAML, model SQL, semantic models, exposures' },
  { id: 'looker', label: 'Looker', description: 'LookML views, explores, joins, measures, dashboard LookML' },
  { id: 'power_bi', label: 'Power BI', description: 'model.bim, TMDL, report JSON, DAX measures, relationships' },
  { id: 'tableau', label: 'Tableau', description: 'TWB/TDS XML, datasources, calculated fields, workbook usage' },
  { id: 'domo', label: 'Domo', description: 'dataset schemas, card JSON, Beast Mode formulas, DataFlow SQL' },
];

const PLANNED_SOURCES: Array<{ id: PlannedMigrationSourceTool; label: string }> = [
  { id: 'sigma', label: 'Sigma' },
];

const TERMINAL_AI_STATES = ['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELED'];

function normalizeAiState(value?: string) {
  return (value || '').trim().toUpperCase();
}

function readFirstString(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const current = record[key];
    if (typeof current === 'string' && current.trim()) return current.trim();
  }
  return '';
}

function extractAiMessage(result: OmniAiJobResult | null, job: OmniAiJob | null) {
  return readFirstString(result, ['message', 'finalMessage', 'final_message', 'answer', 'resultSummary', 'result_summary']) ||
    readFirstString(job, ['message', 'resultSummary', 'result_summary']);
}

function normalizeBranchName(value: string) {
  const trimmed = value.trim();
  const base = trimmed || `semantic-migration-${new Date().toISOString().slice(0, 10)}`;
  const cleaned = base
    .replace(/^codex[/-]/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return /^Omnikit-/i.test(cleaned) ? cleaned : `Omnikit-${cleaned}`;
}

function branchNameFromModel(model?: OmniModel, sourceTool?: MigrationSourceTool) {
  const modelPart = (model?.name || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const runStamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase();
  return normalizeBranchName(`semantic-migration-${sourceTool || 'source'}-${modelPart}-${runStamp}`);
}

function defaultPasteName(sourceTool: MigrationSourceTool) {
  if (sourceTool === 'looker') return 'pasted-lookml.lkml';
  if (sourceTool === 'power_bi') return 'pasted-power-bi.tmdl';
  if (sourceTool === 'tableau') return 'pasted-tableau.twb';
  if (sourceTool === 'domo') return 'pasted-domo.json';
  return 'pasted-dbt.yml';
}

function pastePlaceholder(sourceTool: MigrationSourceTool) {
  if (sourceTool === 'looker') return 'Paste LookML view/explore/dashboard text...';
  if (sourceTool === 'power_bi') return 'Paste Power BI model.bim JSON, TMDL, report layout JSON, or DAX measure text...';
  if (sourceTool === 'tableau') return 'Paste Tableau TWB/TDS XML, datasource XML, or calculated field text...';
  if (sourceTool === 'domo') return 'Paste Domo dataset/card JSON, Beast Mode formulas, or DataFlow SQL...';
  return 'Paste dbt YAML, manifest JSON excerpt, or model SQL...';
}

function sourceToolLabel(sourceTool: MigrationSourceTool) {
  return SOURCE_OPTIONS.find((option) => option.id === sourceTool)?.label || sourceTool;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function modelIsBase(model: OmniModel) {
  return !model.deletedAt && (!model.kind || ['SHARED', 'SHARED_EXTENSION'].includes(model.kind));
}

function fileBadge(fileName: string) {
  if (fileName === 'model') return 'Settings/model';
  if (fileName === 'relationships') return 'relationships';
  if (fileName.endsWith('.topic')) return '.topic';
  if (fileName.endsWith('.view')) return '.view';
  return 'semantic YAML';
}

function basenameWithoutExtension(fileName: string) {
  const base = fileName.split('/').pop() || fileName;
  return base.replace(/\.(view|topic)$/, '');
}

function likelyTargetFiles(inventory: ReturnType<typeof buildMigrationInventory>, files?: Record<string, string>) {
  const allFiles = files || {};
  const sourceNames = new Set<string>();
  inventory.views.forEach((view) => sourceNames.add(view.name));
  inventory.explores.forEach((explore) => {
    sourceNames.add(explore.name);
    if (explore.baseView) sourceNames.add(explore.baseView);
  });
  inventory.relationships.forEach((relationship) => {
    sourceNames.add(relationship.from);
    sourceNames.add(relationship.to);
  });
  inventory.dashboards.forEach((dashboard) => {
    dashboard.fields.forEach((field) => {
      const [viewName] = field.split('.');
      if (viewName) sourceNames.add(viewName);
    });
  });

  const selected: Record<string, string> = {};
  Object.entries(allFiles).forEach(([fileName, yaml]) => {
    if (fileName === 'model' || fileName === 'relationships') return;
    const baseName = basenameWithoutExtension(fileName);
    if (sourceNames.has(baseName)) selected[fileName] = yaml;
  });

  Object.entries(allFiles).forEach(([fileName, yaml]) => {
    if (fileName.endsWith('.topic') && /transaction|order/i.test(fileName)) selected[fileName] = yaml;
  });

  return selected;
}

function applyStageLabel(stage: MigrationRunStage) {
  if (stage === 'preparing') return 'Loading source YAML and running preflight checks';
  if (stage === 'creating-branch') return 'Creating dev branch';
  if (stage === 'saving') return 'Saving generated YAML to the dev branch';
  if (stage === 'validating') return 'Running model and content validation';
  if (stage === 'ready') return 'Ready for Omni branch review';
  if (stage === 'failed') return 'Action needed before retrying';
  return 'Waiting for package review';
}

function normalizeMarkdownForDisplay(value: string) {
  return value
    .replace(/\\_/g, '_')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={`${part}-${index}`} className="font-semibold text-content-primary">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={`${part}-${index}`} className="rounded bg-surface-secondary px-1 py-0.5 font-mono text-[0.9em] text-content-primary">{part.slice(1, -1)}</code>;
        }
        return <span key={`${part}-${index}`}>{part}</span>;
      })}
    </>
  );
}

function MarkdownLite({ text }: { text: string }) {
  const lines = normalizeMarkdownForDisplay(text).split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];

  function flushList() {
    if (listItems.length === 0) return;
    const items = listItems;
    blocks.push(
      <ul key={`list-${blocks.length}`} className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-content-secondary">
        {items.map((item, index) => (
          <li key={`${item}-${index}`}><InlineMarkdown text={item} /></li>
        ))}
      </ul>
    );
    listItems = [];
  }

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      return;
    }

    if (/^-{3,}$/.test(line)) {
      flushList();
      blocks.push(<hr key={`rule-${index}`} className="border-border" />);
      return;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      blocks.push(
        <div key={`heading-${index}`} className="pt-1 text-sm font-semibold text-content-primary">
          <InlineMarkdown text={heading[2]} />
        </div>
      );
      return;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      listItems.push(bullet[1]);
      return;
    }

    flushList();
    blocks.push(
      <p key={`paragraph-${index}`} className="text-sm leading-relaxed text-content-secondary">
        <InlineMarkdown text={line} />
      </p>
    );
  });
  flushList();

  return <div className="space-y-3">{blocks}</div>;
}

export function SemanticMigrationImportPanel() {
  const { connection } = useConnection();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sourceTool, setSourceTool] = useState<MigrationSourceTool>('dbt');
  const [models, setModels] = useState<OmniModel[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [artifacts, setArtifacts] = useState<MigrationArtifact[]>([]);
  const [pasteName, setPasteName] = useState(defaultPasteName('dbt'));
  const [pasteText, setPasteText] = useState('');
  const [adminGoal, setAdminGoal] = useState('');
  const [stage, setStage] = useState<MigrationRunStage>('idle');
  const [error, setError] = useState('');
  const [planMessage, setPlanMessage] = useState('');
  const [packageMessage, setPackageMessage] = useState('');
  const [packageFiles, setPackageFiles] = useState<SemanticMigrationFile[]>([]);
  const [packageWarnings, setPackageWarnings] = useState<string[]>([]);
  const [conversationId, setConversationId] = useState('');
  const [chatUrl, setChatUrl] = useState('');
  const [branchName, setBranchName] = useState('');
  const [branchId, setBranchId] = useState('');
  const [mainYaml, setMainYaml] = useState<OmniModelYamlResponse | null>(null);
  const [mainYamlModelId, setMainYamlModelId] = useState('');
  const [branchYaml, setBranchYaml] = useState<OmniModelYamlResponse | null>(null);
  const [validation, setValidation] = useState<Array<{ message?: string; is_warning?: boolean; yaml_path?: string }> | null>(null);
  const [contentValidation, setContentValidation] = useState<Record<string, unknown> | null>(null);
  const [diffs, setDiffs] = useState<MigrationFileDiff[]>([]);
  const [packageLintIssues, setPackageLintIssues] = useState<string[]>([]);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadModels() {
      try {
        const response = await listModels(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 });
        if (!cancelled) setModels(Array.isArray(response.models) ? response.models : []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load Omni models.');
      }
    }
    loadModels();
    return () => {
      cancelled = true;
    };
  }, [connection.baseUrl, connection.apiKey]);

  const selectedModel = models.find((model) => model.id === selectedModelId) || null;
  const inventory = useMemo(() => buildMigrationInventory(sourceTool, artifacts), [sourceTool, artifacts]);
  const filteredModels = models.filter((model) => {
    const needle = modelSearch.toLowerCase().trim();
    const matches = !needle ||
      model.name.toLowerCase().includes(needle) ||
      model.id.toLowerCase().includes(needle) ||
      (model.connectionName || '').toLowerCase().includes(needle);
    return modelIsBase(model) && matches;
  });
  const validationErrors = (validation || []).filter((issue) => !issue.is_warning);
  const validationWarnings = (validation || []).filter((issue) => issue.is_warning);
  const readyForOmniReview = stage === 'ready' && diffs.length > 0 && validationErrors.length === 0 && reviewAcknowledged;
  const selectedSourceOption = SOURCE_OPTIONS.find((option) => option.id === sourceTool) || SOURCE_OPTIONS[0];
  const existingFileNames = Object.keys(mainYaml?.files || {});
  const targetContextLoaded = Boolean(selectedModel && mainYaml && mainYamlModelId === selectedModel.id);

  function resetGeneratedWork() {
    setPlanMessage('');
    setPackageMessage('');
    setPackageFiles([]);
    setPackageWarnings([]);
    setPackageLintIssues([]);
    setConversationId('');
    setChatUrl('');
    setBranchId('');
    setBranchYaml(null);
    setValidation(null);
    setContentValidation(null);
    setDiffs([]);
    setReviewAcknowledged(false);
    setStage('idle');
  }

  async function ensureTargetYamlContext() {
    if (!selectedModel) throw new Error('Select an Omni model before loading target context.');
    if (mainYaml && mainYamlModelId === selectedModel.id) return mainYaml;
    const loaded = await getModelYaml(connection.baseUrl, connection.apiKey, selectedModel.id, { includeChecksums: true });
    setMainYaml(loaded);
    setMainYamlModelId(selectedModel.id);
    return loaded;
  }

  function changeSourceTool(next: MigrationSourceTool) {
    setSourceTool(next);
    setArtifacts([]);
    setPasteName(defaultPasteName(next));
    setPasteText('');
    if (selectedModel) setBranchName(branchNameFromModel(selectedModel, next));
    resetGeneratedWork();
  }

  async function handleFileUpload(files: FileList | null) {
    if (!files?.length) return;
    setStage('parsing');
    setError('');
    try {
      const nextArtifacts = await artifactsFromFiles(sourceTool, files);
      setArtifacts((current) => [...current, ...nextArtifacts]);
      resetGeneratedWork();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read source files.');
      setStage('failed');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleAddPastedSource() {
    const artifact = artifactFromText(sourceTool, pasteText, pasteName || 'pasted-source.txt');
    if (!artifact) {
      setError('Paste source content before adding it to the migration inventory.');
      return;
    }
    setArtifacts((current) => [...current, artifact]);
    setPasteText('');
    setError('');
    resetGeneratedWork();
  }

  function removeArtifact(id: string) {
    setArtifacts((current) => current.filter((artifact) => artifact.id !== id));
    resetGeneratedWork();
  }

  function clearArtifacts() {
    setArtifacts([]);
    resetGeneratedWork();
  }

  async function waitForAiJob(jobId: string) {
    let latest: OmniAiJob | null = null;
    for (let index = 0; index < 36; index += 1) {
      latest = await getAiJob(connection.baseUrl, connection.apiKey, jobId);
      const state = normalizeAiState(latest.state || latest.status);
      if (TERMINAL_AI_STATES.includes(state)) break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return latest;
  }

  async function runAiPrompt(prompt: string, activeConversationId?: string) {
    if (!selectedModel) throw new Error('Select an Omni model before running Blobby.');
    const created = await createAiJob(connection.baseUrl, connection.apiKey, {
      modelId: selectedModel.id,
      prompt,
      conversationId: activeConversationId || undefined,
    });
    const jobId = created.jobId || created.id;
    if (!jobId) throw new Error('Omni did not return an AI job ID.');
    const finalJob = await waitForAiJob(jobId);
    const finalState = normalizeAiState(finalJob?.state || finalJob?.status);
    if (!TERMINAL_AI_STATES.includes(finalState)) {
      throw new Error('Blobby did not finish within the expected time. Open the Omni chat and retry when it completes.');
    }
    if (['FAILED', 'CANCELLED', 'CANCELED'].includes(finalState)) {
      throw new Error(`Blobby job ${finalState.toLowerCase()}.`);
    }
    let result: OmniAiJobResult | null = null;
    for (let index = 0; index < 8; index += 1) {
      result = await getAiJobResult(connection.baseUrl, connection.apiKey, jobId).catch(() => null);
      if (extractAiMessage(result, finalJob)) break;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    const message = extractAiMessage(result, finalJob);
    if (!message) throw new Error('Blobby completed but did not return a readable response.');
    const nextConversationId =
      readFirstString(result, ['conversationId', 'conversation_id']) ||
      readFirstString(finalJob, ['conversationId', 'conversation_id']) ||
      readFirstString(created, ['conversationId', 'conversation_id']);
    const nextChatUrl =
      readFirstString(result, ['omniChatUrl', 'omni_chat_url']) ||
      readFirstString(finalJob, ['omniChatUrl', 'omni_chat_url']) ||
      readFirstString(created, ['omniChatUrl', 'omni_chat_url']);
    return { message, conversationId: nextConversationId, chatUrl: nextChatUrl };
  }

  async function handlePlanMigration() {
    if (!selectedModel) return;
    if (artifacts.length === 0) {
      setError(`Add ${sourceToolLabel(sourceTool)} source artifacts before planning the migration.`);
      return;
    }
    setStage('planning');
    setError('');
    setPackageFiles([]);
    setPackageMessage('');
    setPackageWarnings([]);
    setPackageLintIssues([]);
    setValidation(null);
    setDiffs([]);
    try {
      const targetYaml = await ensureTargetYamlContext();
      const prompt = buildSemanticMigrationPlanPrompt({
        inventory,
        modelName: selectedModel.name,
        modelId: selectedModel.id,
        adminGoal,
        existingFileNames: Object.keys(targetYaml.files || {}),
      });
      const outcome = await runAiPrompt(prompt, conversationId || undefined);
      setPlanMessage(outcome.message);
      if (outcome.conversationId) setConversationId(outcome.conversationId);
      if (outcome.chatUrl) setChatUrl(outcome.chatUrl);
      setStage('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Migration planning failed.');
      setStage('failed');
    }
  }

  async function handleGeneratePackage() {
    if (!selectedModel) return;
    if (!planMessage.trim()) {
      setError('Generate and review the migration plan before creating YAML.');
      return;
    }
    setStage('package');
    setError('');
    setPackageLintIssues([]);
    setValidation(null);
    setDiffs([]);
    try {
      const targetYaml = await ensureTargetYamlContext();
      const targetFiles = likelyTargetFiles(inventory, targetYaml.files || {});
      const prompt = buildSemanticMigrationPackagePrompt({
        inventory,
        modelName: selectedModel.name,
        modelId: selectedModel.id,
        adminGoal,
        confirmedPlan: planMessage,
        existingFileNames: Object.keys(targetYaml.files || {}),
        currentTargetFiles: targetFiles,
      });
      const outcome = await runAiPrompt(prompt, conversationId || undefined);
      const parsed = extractSemanticMigrationPackage(outcome.message);
      setPackageMessage(outcome.message);
      setPackageFiles(parsed.files);
      setPackageWarnings(parsed.warnings);
      if (outcome.conversationId) setConversationId(outcome.conversationId);
      if (outcome.chatUrl) setChatUrl(outcome.chatUrl);
      setBranchName((current) => current || branchNameFromModel(selectedModel, sourceTool));
      const lintIssues = validateSemanticMigrationFiles(parsed.files, targetYaml.files || {});
      if (lintIssues.length > 0) {
        setPackageLintIssues(lintIssues);
        setError(`Fix generated YAML before saving to dev:\n${lintIssues.map((issue) => `- ${issue}`).join('\n')}`);
        setStage('failed');
        return;
      }
      setStage('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Semantic YAML package generation failed.');
      setStage('failed');
    }
  }

  function updatePackageFile(id: string, patch: Partial<SemanticMigrationFile>) {
    setPackageFiles((current) => current.map((file) => file.id === id ? { ...file, ...patch } : file));
    setPackageLintIssues([]);
    setError('');
    setValidation(null);
    setContentValidation(null);
    setDiffs([]);
    setReviewAcknowledged(false);
    setStage('idle');
  }

  function removePackageFile(id: string) {
    setPackageFiles((current) => current.filter((file) => file.id !== id));
    setPackageLintIssues([]);
    setError('');
    setValidation(null);
    setContentValidation(null);
    setDiffs([]);
    setReviewAcknowledged(false);
  }

  async function handleApplyToDev() {
    if (!selectedModel) return;
    if (!selectedModel.connectionId) {
      setError('The selected model is missing connection metadata, so OmniKit cannot create a branch safely.');
      return;
    }
    if (packageLintIssues.length > 0) {
      setError(`Fix generated YAML before saving to dev:\n${packageLintIssues.map((issue) => `- ${issue}`).join('\n')}`);
      setStage('failed');
      return;
    }
    setError('');
    setReviewAcknowledged(false);
    setValidation(null);
    setContentValidation(null);
    setDiffs([]);
    let applyStep = 'preparing';
    try {
      applyStep = 'loading source YAML';
      setStage('preparing');
      const main = await getModelYaml(connection.baseUrl, connection.apiKey, selectedModel.id, { includeChecksums: true });
      setMainYaml(main);
      setMainYamlModelId(selectedModel.id);
      const preflightIssues = validateSemanticMigrationFiles(packageFiles, main.files || {});
      if (preflightIssues.length > 0) {
        setPackageLintIssues(preflightIssues);
        throw new Error(`Fix generated YAML before saving to dev:\n${preflightIssues.map((issue) => `- ${issue}`).join('\n')}`);
      }

      applyStep = 'creating the dev branch';
      setStage('creating-branch');
      const resolvedBranchName = normalizeBranchName(branchName || branchNameFromModel(selectedModel, sourceTool));
      setBranchName(resolvedBranchName);
      const branch = await createModelBranch(connection.baseUrl, connection.apiKey, {
        connectionId: selectedModel.connectionId,
        baseModelId: selectedModel.id,
        branchName: resolvedBranchName,
      });
      const nextBranchId =
        readFirstString(branch, ['id', 'modelId', 'model_id', 'branchId', 'branch_id']) ||
        readFirstString((branch as Record<string, unknown>).model, ['id']) ||
        readFirstString((branch as Record<string, unknown>).data, ['id']);
      if (!nextBranchId) throw new Error('Omni did not return a branch model ID.');
      setBranchId(nextBranchId);

      applyStep = 'loading branch YAML';
      const branchBefore = await getModelYaml(connection.baseUrl, connection.apiKey, selectedModel.id, {
        branchId: nextBranchId,
        includeChecksums: true,
      });

      applyStep = 'saving generated YAML';
      setStage('saving');
      for (const file of packageFiles) {
        await updateModelYamlFile(connection.baseUrl, connection.apiKey, {
          modelId: selectedModel.id,
          branchId: nextBranchId,
          fileName: file.fileName,
          yaml: file.yaml,
          previousChecksum: branchBefore.checksums?.[file.fileName] || main.checksums?.[file.fileName],
          commitMessage: `AI Semantic Migration update: ${file.fileName}`,
        });
      }

      applyStep = 'validating the dev branch';
      setStage('validating');
      const branchAfter = await getModelYaml(connection.baseUrl, connection.apiKey, selectedModel.id, {
        branchId: nextBranchId,
        includeChecksums: true,
      });
      setBranchYaml(branchAfter);
      setDiffs(buildMigrationDiffs(main.files || {}, branchAfter.files || {}, packageFiles));
      const modelValidation = await validateModel(connection.baseUrl, connection.apiKey, selectedModel.id, nextBranchId);
      setValidation(Array.isArray(modelValidation) ? modelValidation : []);
      const contentResult = await validateModelContent(connection.baseUrl, connection.apiKey, selectedModel.id, nextBranchId).catch((err) => ({
        error: err instanceof Error ? err.message : 'Content validation failed',
      }));
      setContentValidation(contentResult);
      setStage('ready');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply semantic migration package to dev.';
      const detail = err instanceof ApiError && err.detail ? `\n${err.detail}` : '';
      const branchHint = applyStep === 'creating the dev branch'
        ? '\nIf this branch name already exists, enter a new dev branch name and retry.'
        : '';
      setError(`Apply to Dev failed while ${applyStep}: ${message}${branchHint}${detail}`);
      setStage('failed');
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-card border border-omni-100 bg-omni-50 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-omni-800">
              <Wand2 size={16} />
              Semantic Migration Import
            </div>
            <p className="mt-1 max-w-4xl text-sm leading-relaxed text-omni-700">
              Drop in dbt, Looker, Power BI, Tableau, or Domo semantic artifacts, let OmniKit parse them locally, then ask Blobby for an Omni-native semantic YAML package. This lane does not create dashboards, analyze screenshots, or store raw source files by default.
            </p>
          </div>
          <span className="w-fit rounded-chip bg-white px-2.5 py-1 text-xs font-semibold text-omni-700">
            Semantic-only
          </span>
        </div>
      </div>

      {error && (
        <div className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 whitespace-pre-wrap">{error}</div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)] gap-5 items-start">
        <div className="space-y-4">
          <div className="card p-4 space-y-4">
            <div>
              <div className="text-sm font-semibold text-content-primary">1. Source system</div>
              <div className="mt-0.5 text-xs text-content-secondary">Choose the external semantic source. Selected options are highlighted and tagged.</div>
            </div>
            <div className="rounded-card border border-omni-200 bg-omni-50 px-3 py-2 text-xs text-omni-800">
              <div className="flex items-center gap-2 font-semibold">
                <CheckCircle2 size={14} />
                Selected source: {selectedSourceOption.label}
              </div>
              <div className="mt-0.5 text-omni-700">{selectedSourceOption.description}</div>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {SOURCE_OPTIONS.map((option) => {
                const selected = sourceTool === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => changeSourceTool(option.id)}
                    aria-pressed={selected}
                    className={`relative rounded-card border p-3 text-left transition-all ${
                      selected ? 'border-omni-500 bg-gradient-to-r from-omni-50 to-white shadow-soft ring-2 ring-omni-200' : 'border-border bg-white hover:border-omni-200 hover:bg-surface-secondary'
                    }`}
                  >
                    {selected && <div className="absolute left-0 top-0 h-full w-1 rounded-l-[8px] bg-omni-500" />}
                    <div className="flex items-start justify-between gap-3 pl-1">
                      <div>
                        <div className="text-sm font-semibold text-content-primary">{option.label}</div>
                        <div className="mt-1 text-[11px] leading-relaxed text-content-secondary">{option.description}</div>
                      </div>
                      <span className={`shrink-0 rounded-chip px-2 py-1 text-[10px] font-semibold ${
                        selected ? 'bg-omni-600 text-white' : 'bg-surface-secondary text-content-secondary'
                      }`}>
                        {selected ? 'Selected' : 'Choose'}
                      </span>
                    </div>
                    {selected && (
                      <div className="mt-2 inline-flex items-center gap-1 pl-1 text-[11px] font-semibold text-omni-700">
                        <CheckCircle2 size={13} />
                        Active parser and prompt context
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-2">
              {PLANNED_SOURCES.map((source) => (
                <span key={source.id} className="rounded-chip border border-border bg-surface-secondary px-2 py-1 text-[10px] font-semibold text-content-tertiary">
                  {source.label} planned
                </span>
              ))}
            </div>
          </div>

          <div className="card p-4 space-y-3">
            <div>
              <div className="text-sm font-semibold text-content-primary">2. Target Omni model</div>
              <div className="mt-0.5 text-xs text-content-secondary">Choose the model where generated semantic YAML should be staged.</div>
            </div>
            {selectedModel && (
              <div className="rounded-card border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
                <div className="flex items-center gap-2 font-semibold">
                  <CheckCircle2 size={14} />
                  Selected model: {selectedModel.name}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-green-700 break-all">{selectedModel.id}</div>
                <div className="mt-1 text-[11px] text-green-700">
                  {targetContextLoaded ? `Target YAML context loaded: ${existingFileNames.length} files` : 'Target YAML context loads before Blobby planning.'}
                </div>
              </div>
            )}
            <input
              value={modelSearch}
              onChange={(event) => setModelSearch(event.target.value)}
              className="input-field text-sm"
              placeholder="Search models..."
            />
            <div className="max-h-[280px] overflow-y-auto rounded-card border border-border bg-white">
              {filteredModels.length === 0 ? (
                <div className="px-3 py-3 text-sm text-content-secondary">No base models match that search.</div>
              ) : filteredModels.map((model) => {
                const selected = selectedModelId === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => {
                      setSelectedModelId(model.id);
                      setBranchName(branchNameFromModel(model, sourceTool));
                      setMainYaml(null);
                      setMainYamlModelId('');
                      resetGeneratedWork();
                    }}
                    aria-pressed={selected}
                    className={`w-full border-b border-border/60 px-3 py-2.5 text-left transition-all last:border-b-0 ${
                      selected ? 'border-l-4 border-l-omni-500 bg-omni-50 text-omni-800 shadow-soft' : 'border-l-4 border-l-transparent hover:bg-surface-secondary text-content-primary'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{model.name}</div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-content-tertiary">{model.id}</div>
                      </div>
                      {selected && (
                        <span className="shrink-0 rounded-chip bg-omni-600 px-2 py-1 text-[10px] font-semibold text-white">
                          Selected
                        </span>
                      )}
                    </div>
                    {(model.connectionName || model.connectionId) && (
                      <div className="mt-0.5 truncate text-[11px] text-content-secondary">
                        {model.connectionName || model.connectionId}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="card p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-content-primary">3. Source artifacts</div>
                <div className="mt-0.5 text-xs text-content-secondary">Files and pasted text stay in page memory unless you export them outside OmniKit.</div>
              </div>
              {artifacts.length > 0 && (
                <button type="button" onClick={clearArtifacts} className="btn-secondary text-xs px-2 py-1.5">
                  <Trash2 size={12} />
                  Clear
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".json,.yml,.yaml,.sql,.lkml,.lookml,.txt,.md,.csv,.xml,.twb,.tds,.bim,.tmdl"
              className="hidden"
              onChange={(event) => handleFileUpload(event.target.files)}
            />
            <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-secondary text-sm w-full justify-center">
              <Upload size={14} />
              Upload source files
            </button>
            <div className="grid grid-cols-1 gap-2">
              <input
                value={pasteName}
                onChange={(event) => setPasteName(event.target.value)}
                className="input-field text-xs"
                placeholder={defaultPasteName(sourceTool)}
              />
              <textarea
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
                className="input-field min-h-[160px] resize-y font-mono text-xs"
                placeholder={pastePlaceholder(sourceTool)}
                spellCheck={false}
              />
              <button type="button" onClick={handleAddPastedSource} className="btn-secondary text-sm justify-center">
                <FileText size={14} />
                Add pasted source
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-4 min-w-0">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
            <SummaryCard icon={<FileCode2 size={16} />} label="Artifacts" value={String(inventory.artifactCount)} />
            <SummaryCard icon={<Database size={16} />} label="Semantic objects" value={String(inventory.views.length)} />
            <SummaryCard icon={<ClipboardCheck size={16} />} label="Relationships" value={String(inventory.relationships.length)} />
            <SummaryCard icon={<ShieldCheck size={16} />} label="Warnings" value={String(inventory.warnings.length)} />
          </div>

          <div className="rounded-card border border-border bg-white overflow-hidden">
            <div className="border-b border-border bg-surface-secondary px-4 py-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-content-primary">Parsed migration inventory</div>
                <div className="mt-0.5 text-xs text-content-secondary">{inventory.summary}</div>
              </div>
              <span className="rounded-chip bg-white px-2 py-1 text-[10px] font-semibold text-content-secondary">
                Local parser
              </span>
            </div>
            <div className="p-4 space-y-4">
              {artifacts.length === 0 ? (
                <div className="rounded-card border border-amber-100 bg-amber-50 px-3 py-3 text-sm text-amber-800">
                  Add {selectedSourceOption.label} artifacts to build a migration inventory. Images and external BI credentials are intentionally out of scope.
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    {artifacts.map((artifact) => (
                      <div key={artifact.id} className="rounded-card border border-border bg-white px-3 py-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-content-primary">{artifact.name}</div>
                            <div className="mt-0.5 text-[11px] text-content-secondary">
                              {artifact.kind} · {formatSize(artifact.sizeBytes)}
                            </div>
                            {artifact.parseWarnings.length > 0 && (
                              <div className="mt-1 text-[11px] text-amber-700">{artifact.parseWarnings.join(' ')}</div>
                            )}
                          </div>
                          <button type="button" onClick={() => removeArtifact(artifact.id)} className="text-content-tertiary hover:text-red-600">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {inventory.warnings.length > 0 && (
                    <div className="rounded-card border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <div className="mb-1 flex items-center gap-1 font-semibold">
                        <AlertTriangle size={13} />
                        Parser warnings
                      </div>
                      <ul className="list-disc space-y-1 pl-4">
                        {inventory.warnings.slice(0, 6).map((warning) => <li key={warning}>{warning}</li>)}
                      </ul>
                    </div>
                  )}

                  <InventoryPreview title="Semantic objects" empty="No models/views detected." items={inventory.views.map((view) => `${view.name} (${view.fields.length} fields, ${view.measures.length} measures)`)} />
                  <InventoryPreview title="Explores/topics" empty="No explores detected." items={inventory.explores.map((explore) => `${explore.name}${explore.baseView ? ` -> ${explore.baseView}` : ''}`)} />
                  <InventoryPreview title="Dashboard/report evidence" empty="No dashboard or exposure evidence detected." items={inventory.dashboards.map((dashboard) => `${dashboard.name}${dashboard.fields.length ? ` (${dashboard.fields.length} fields)` : ''}`)} />
                </>
              )}
            </div>
          </div>

          <div className="rounded-card border border-border bg-white overflow-hidden">
            <div className="border-b border-border bg-surface-secondary px-4 py-3">
              <div className="text-sm font-semibold text-content-primary">Blobby migration flow</div>
              <div className="mt-0.5 text-xs text-content-secondary">Plan first, generate semantic YAML second, save only after review.</div>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="text-xs font-semibold text-content-primary">Admin goal</label>
                <textarea
                  value={adminGoal}
                  onChange={(event) => {
                    setAdminGoal(event.target.value);
                    setPackageFiles([]);
                    setPackageMessage('');
                    setValidation(null);
                    setDiffs([]);
                  }}
                  className="input-field mt-1 min-h-[86px] resize-y text-sm"
                  placeholder={`e.g. Convert the uploaded ${selectedSourceOption.label} semantic artifacts into Omni views, relationships, and a focused topic.`}
                />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={handlePlanMigration}
                  disabled={!selectedModel || artifacts.length === 0 || stage === 'planning' || stage === 'package'}
                  className="btn-primary text-sm justify-center disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {stage === 'planning' ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
                  Plan migration
                </button>
                <button
                  type="button"
                  onClick={handleGeneratePackage}
                  disabled={!planMessage || stage === 'planning' || stage === 'package'}
                  className="btn-secondary text-sm justify-center disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {stage === 'package' ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
                  Generate semantic YAML
                </button>
                {chatUrl && (
                  <a href={chatUrl} target="_blank" rel="noreferrer" className="btn-secondary text-sm justify-center">
                    <ExternalLink size={14} />
                    Open Omni chat
                  </a>
                )}
              </div>
            </div>
          </div>

          {planMessage && (
            <OutputPanel title="Migration plan" subtitle="Review this before generating YAML.">
              <MarkdownLite text={planMessage} />
            </OutputPanel>
          )}

          {packageWarnings.length > 0 && (
            <div className="rounded-card border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {packageWarnings.join(' ')}
            </div>
          )}

          {packageFiles.length > 0 && (
            <OutputPanel title="Semantic YAML package" subtitle="Edit before saving. Only these files will be written to the dev branch.">
              <div className="space-y-3">
                {packageFiles.map((file) => (
                  <div key={file.id} className="rounded-card border border-border bg-white overflow-hidden">
                    <div className="flex flex-col gap-2 border-b border-border bg-surface-secondary px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-content-secondary">Target file</div>
                        <input
                          value={file.fileName}
                          onChange={(event) => updatePackageFile(file.id, { fileName: event.target.value as SemanticMigrationFile['fileName'] })}
                          className="input-field mt-1 font-mono text-xs"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-chip bg-white px-2 py-1 text-[10px] font-semibold text-content-secondary">
                          {fileBadge(file.fileName)}
                        </span>
                        <button type="button" onClick={() => removePackageFile(file.id)} className="btn-secondary text-xs px-2 py-1.5">
                          Remove
                        </button>
                      </div>
                    </div>
                    <textarea
                      value={file.yaml}
                      onChange={(event) => updatePackageFile(file.id, { yaml: event.target.value })}
                      className="w-full min-h-[280px] border-0 bg-white p-3 font-mono text-xs text-content-primary focus:ring-0"
                      spellCheck={false}
                    />
                  </div>
                ))}
              </div>
            </OutputPanel>
          )}

          {packageFiles.length > 0 && (
            <div className="rounded-card border border-border bg-white overflow-hidden">
              <div className="border-b border-border bg-surface-secondary px-4 py-3">
                <div className="text-sm font-semibold text-content-primary">Apply to dev branch</div>
                <div className="mt-0.5 text-xs text-content-secondary">OmniKit writes generated semantic YAML to a dev branch, validates it, then routes final approval back to Omni.</div>
              </div>
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_220px] gap-3">
                  <div>
                    <label className="text-xs font-semibold text-content-primary">Dev branch name</label>
                    <input
                      value={branchName}
                      onChange={(event) => {
                        setBranchName(event.target.value);
                        setBranchId('');
                      }}
                      className="input-field mt-1 text-sm"
                      placeholder={branchNameFromModel(selectedModel || undefined, sourceTool)}
                    />
                    {branchId && <div className="mt-1 font-mono text-[11px] text-content-tertiary">Branch model id: {branchId}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={handleApplyToDev}
                    disabled={packageLintIssues.length > 0 || ['preparing', 'creating-branch', 'saving', 'validating'].includes(stage)}
                    className="btn-primary mt-5 text-sm justify-center disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {['preparing', 'creating-branch', 'saving', 'validating'].includes(stage) ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                    Apply to Dev
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <ValidationCard label="Branch" value={branchId ? 'Created' : 'Waiting'} ready={Boolean(branchId)} />
                  <ValidationCard label="Model validation" value={validation ? `${validationErrors.length} errors · ${validationWarnings.length} warnings` : 'Not run'} ready={Boolean(validation && validationErrors.length === 0)} />
                  <ValidationCard label="Diff" value={diffs.length ? `${diffs.length} files changed` : 'Not ready'} ready={diffs.length > 0} />
                </div>

                <div className="rounded-card border border-border bg-surface-secondary px-3 py-2 text-xs text-content-secondary">
                  Current step: <span className="font-semibold text-content-primary">{applyStageLabel(stage)}</span>
                </div>

                {error && packageFiles.length > 0 && (
                  <div className="rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 whitespace-pre-wrap">
                    {error}
                  </div>
                )}

                {(mainYaml || branchYaml) && (
                  <div className="rounded-card border border-border bg-surface-secondary px-3 py-2 text-[11px] text-content-secondary">
                    Main files loaded: {Object.keys(mainYaml?.files || {}).length} · Dev files loaded: {Object.keys(branchYaml?.files || {}).length}
                  </div>
                )}

                {contentValidation && (
                  <details className="rounded-card border border-border bg-white overflow-hidden text-xs">
                    <summary className="cursor-pointer bg-surface-secondary px-3 py-2 font-semibold text-content-primary">
                      Content validation response
                    </summary>
                    <pre className="max-h-[260px] overflow-auto p-3 text-[11px] text-content-secondary">{formatJson(contentValidation)}</pre>
                  </details>
                )}

                {validationErrors.length > 0 && (
                  <div className="rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    <div className="font-semibold">Model validation returned errors</div>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {validationErrors.slice(0, 8).map((issue, index) => (
                        <li key={`${issue.yaml_path || 'issue'}-${index}`}>{[issue.yaml_path, issue.message].filter(Boolean).join(': ')}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {diffs.length > 0 && (
                  <div className="space-y-3">
                    {diffs.map((diff) => (
                      <details key={diff.fileName} className="rounded-card border border-border bg-white overflow-hidden">
                        <summary className="cursor-pointer bg-surface-secondary px-3 py-2 text-xs font-semibold text-content-primary">
                          {diff.fileName}
                        </summary>
                        <pre className="max-h-[360px] overflow-auto p-3 text-[11px] leading-relaxed">
                          {diff.lines.slice(0, 500).map((line, index) => (
                            <div key={`${diff.fileName}-${index}`} className={
                              line.type === 'added'
                                ? 'text-green-700'
                                : line.type === 'removed'
                                  ? 'text-red-700'
                                  : 'text-content-tertiary'
                            }>
                              {line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}
                              {line.text}
                            </div>
                          ))}
                        </pre>
                      </details>
                    ))}
                  </div>
                )}

                {diffs.length > 0 && (
                  <label className="flex items-start gap-2 rounded-button border border-omni-100 bg-omni-50 px-3 py-2 text-xs text-omni-700">
                    <input
                      type="checkbox"
                      checked={reviewAcknowledged}
                      onChange={(event) => setReviewAcknowledged(event.target.checked)}
                      className="mt-0.5 rounded border-omni-300 text-omni-700 focus:ring-omni-500"
                    />
                    <span>I reviewed the dev branch diff and validation results, and this semantic migration package is ready for Omni model branch review.</span>
                  </label>
                )}

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-border pt-4">
                  <div className="text-xs text-content-secondary leading-relaxed">
                    Final approval stays in Omni. After semantic validation passes, review and promote the branch from Omni's model editor.
                    {branchName && (
                      <div className="mt-1 font-mono text-[11px] text-content-primary break-all">
                        {branchId ? 'Dev branch' : 'Requested dev branch'}: {branchName}
                      </div>
                    )}
                  </div>
                  {readyForOmniReview ? (
                    <a href={connection.baseUrl.replace(/\/+$/, '')} target="_blank" rel="noreferrer" className="btn-primary text-sm justify-center">
                      <ExternalLink size={14} />
                      Open Omni for sign-off
                    </a>
                  ) : (
                    <button type="button" disabled className="btn-secondary text-sm justify-center opacity-60 cursor-not-allowed">
                      <ClipboardCheck size={14} />
                      Review required first
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {packageMessage && (
            <details className="rounded-card border border-border bg-white overflow-hidden">
              <summary className="cursor-pointer bg-surface-secondary px-4 py-3 text-sm font-semibold text-content-primary">
                Raw Blobby package response
              </summary>
              <pre className="max-h-[420px] overflow-auto p-4 text-xs text-content-secondary whitespace-pre-wrap">{packageMessage}</pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-card border border-border bg-white p-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-content-secondary">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold text-content-primary">{value}</div>
    </div>
  );
}

function InventoryPreview({ title, empty, items }: { title: string; empty: string; items: string[] }) {
  return (
    <details className="rounded-card border border-border bg-white overflow-hidden">
      <summary className="cursor-pointer bg-surface-secondary px-3 py-2 text-xs font-semibold text-content-primary">
        {title}
      </summary>
      <div className="p-3">
        {items.length === 0 ? (
          <div className="text-xs text-content-secondary">{empty}</div>
        ) : (
          <ul className="list-disc space-y-1 pl-4 text-xs text-content-secondary">
            {items.slice(0, 30).map((item) => <li key={item}>{item}</li>)}
          </ul>
        )}
      </div>
    </details>
  );
}

function OutputPanel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-white overflow-hidden">
      <div className="border-b border-border bg-surface-secondary px-4 py-3">
        <div className="text-sm font-semibold text-content-primary">{title}</div>
        <div className="mt-0.5 text-xs text-content-secondary">{subtitle}</div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function ValidationCard({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return (
    <div className={`rounded-card border p-3 ${ready ? 'border-green-200 bg-green-50' : 'border-border bg-white'}`}>
      <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">{label}</div>
      <div className={`mt-2 text-sm font-semibold ${ready ? 'text-green-800' : 'text-content-primary'}`}>
        {ready ? <CheckCircle2 size={14} className="mr-1 inline-block" /> : null}
        {value}
      </div>
    </div>
  );
}
