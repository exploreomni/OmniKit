import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  CheckSquare,
  Download,
  FileText,
  Folder,
  FolderOpen,
  LayoutDashboard,
  Loader2,
  MinusCircle,
  PlusCircle,
  ShieldCheck,
  Tag,
  Upload,
} from 'lucide-react';
import { useConnection } from '@/hooks/useConnection';
import { useLogOperation } from '@/hooks/useOperationLog';
import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import { omniProxy, listFolders, listDocuments } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SearchInput } from '@/components/ui/SearchInput';
import {
  selectedBadgeClass,
  selectedRowClass,
  selectedTreeRowClass,
  unselectedRowClass,
  unselectedTreeRowClass,
} from '@/components/ui/selectionStyles';
import { friendlyApiError } from '@/utils/apiErrors';
import { csvRowsToText } from '@/utils/csvExport';
import {
  BULK_CONTENT_LABELS_CELL_FORMAT,
  BULK_CONTENT_LABEL_LIMITS,
  BULK_CONTENT_LABEL_TEMPLATE_ROWS,
  normalizeBulkContentLabelTarget,
  parseBulkContentLabelsCsv,
  type BulkContentLabelPlan,
  type BulkContentLabelTargetType,
} from '@/services/bulkContentLabels';
import type { OmniLabel, OmniFolder, OmniDocument } from '@/types';

type FolderTargetMode = 'folder' | 'documents' | 'both';

const MAX_BULK_CSV_BYTES = BULK_CONTENT_LABEL_LIMITS.maxBytes;
const LABEL_MUTATION_SPACING_MS = 1_050;

type LabelApplyResult = {
  id: string;
  name: string;
  type: 'folder' | 'document';
  status: 'success' | 'skipped' | 'failed';
  detail: string;
};

type ApplyProgress = {
  completed: number;
  total: number;
};

type ActiveMutationEvidence = {
  connectionKey: string;
  instanceLabel: string;
  operation: string;
  writeStarted: boolean;
  confirmedWrites: number;
  inFlightTarget?: string;
};

type MutationReviewNotice = {
  id: string;
  instanceLabel: string;
  operation: string;
  confirmedWrites: number;
  reason: 'instance_changed' | 'unconfirmed_result' | 'stopped';
  targets: string[];
};

type BulkLabelTargetPreview = {
  key: string;
  type: BulkContentLabelTargetType;
  id: string;
  name: string;
  reference: string;
  currentLabels: string[];
  add: string[];
  remove: string[];
  noops: string[];
  rowNumbers: number[];
};

type BulkLabelPreview = {
  connectionKey: string;
  instanceLabel: string;
  plan: BulkContentLabelPlan;
  targets: BulkLabelTargetPreview[];
  labelCatalog: OmniLabel[];
  missingLabels: string[];
  issues: Array<{ message: string; rowNumbers?: number[] }>;
  fingerprint: string;
  createdAt: number;
};

type BulkLabelResult = {
  stage: 'label' | 'folder' | 'document';
  target: string;
  status: 'success' | 'skipped' | 'failed';
  rowNumbers: number[];
  message: string;
};

type InventoryResponse<T> = {
  folders?: T[];
  documents?: T[];
  complete?: boolean;
  loadedResults?: number;
  totalResults?: number;
};

type LabeledTarget = {
  id: string;
  type: 'folder' | 'document';
  labels: string[];
  available: boolean;
};

type FolderDashboard = OmniDocument & {
  folderId?: string;
  folderName?: string;
  folderPath?: string;
};

type LabelMutationResponse = {
  labels?: string[];
};

type LabelCreateResponse = {
  label?: OmniLabel;
  record?: OmniLabel;
  data?: OmniLabel;
  id?: string;
  name?: string;
};

type LabelListResponse = {
  records?: unknown;
  labels?: unknown;
};

function mergeMutationReviewNotice(
  notices: MutationReviewNotice[],
  evidence: ActiveMutationEvidence,
  reason: MutationReviewNotice['reason'],
  target?: string,
): MutationReviewNotice[] {
  const id = `${evidence.connectionKey}|${evidence.operation}|${reason}`;
  const nextTarget = target || evidence.inFlightTarget;
  const existing = notices.find((notice) => notice.id === id);
  if (!existing) {
    return [...notices, {
      id,
      instanceLabel: evidence.instanceLabel,
      operation: evidence.operation,
      confirmedWrites: evidence.confirmedWrites,
      reason,
      targets: nextTarget ? [nextTarget] : [],
    }];
  }
  return notices.map((notice) => notice.id === id
    ? {
        ...notice,
        confirmedWrites: Math.max(notice.confirmedWrites, evidence.confirmedWrites),
        targets: nextTarget && !notice.targets.includes(nextTarget)
          ? [...notice.targets, nextTarget]
          : notice.targets,
      }
    : notice);
}

function flattenFolders(folders: OmniFolder[], depth = 0): Array<OmniFolder & { depth: number }> {
  const result: Array<OmniFolder & { depth: number }> = [];
  for (const folder of folders) {
    result.push({ ...folder, depth });
    if (folder.children) result.push(...flattenFolders(folder.children, depth + 1));
  }
  return result;
}

function labelName(label: OmniLabel): string {
  return label.name;
}

function parseLabelCatalog(payload: LabelListResponse | null | undefined): OmniLabel[] {
  const values = Array.isArray(payload?.records)
    ? payload.records
    : Array.isArray(payload?.labels)
      ? payload.labels
      : null;
  if (!values) throw new Error('Omni returned an unsupported label catalog response.');

  const result: OmniLabel[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const record = typeof value === 'string'
      ? { name: value }
      : value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<OmniLabel>
        : null;
    const name = typeof record?.name === 'string' ? record.name.trim() : '';
    if (!name) throw new Error('Omni returned a label without a valid name.');
    const key = normalize(name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...record,
      id: typeof record?.id === 'string' && record.id.trim() ? record.id.trim() : name,
      name,
    });
  }
  return result;
}

function normalize(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    const key = normalize(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(label);
  }
  return result;
}

function extractLabels(payload: unknown): string[] {
  return extractLabelState(payload).labels;
}

function extractLabelState(payload: unknown): { available: boolean; labels: string[] } {
  const candidates = [
    payload,
    (payload as { folder?: unknown })?.folder,
    (payload as { document?: unknown })?.document,
    (payload as { record?: unknown })?.record,
    (payload as { data?: unknown })?.data,
  ];

  for (const candidate of candidates) {
    const labels = (candidate as { labels?: unknown })?.labels;
    if (!Array.isArray(labels)) continue;
    return {
      available: true,
      labels: uniqueLabels(
        labels
          .map((label) => (typeof label === 'string' ? label : (label as { name?: string })?.name))
          .filter((label): label is string => Boolean(label)),
      ),
    };
  }

  return { available: false, labels: [] };
}

function hasLabel(labels: string[], name: string): boolean {
  const target = normalize(name);
  return labels.some((label) => normalize(label) === target);
}

function expectedLabelsAfterChange(current: string[], add: string[], remove: string[]): string[] {
  const removed = new Set(remove.map(normalize));
  return uniqueLabels([
    ...current.filter((label) => !removed.has(normalize(label))),
    ...add,
  ]);
}

function sameLabelSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(right.map(normalize));
  return left.every((label) => rightKeys.has(normalize(label)));
}

function seedLabelsFromFolders(folders: OmniFolder[]): Record<string, string[]> {
  const seed: Record<string, string[]> = {};
  for (const folder of flattenFolders(folders)) {
    const labelState = extractLabelState(folder);
    if (labelState.available) seed[folder.id] = labelState.labels;
  }
  return seed;
}

function extractDocuments(payload: unknown): OmniDocument[] {
  const candidates = [
    (payload as { documents?: unknown })?.documents,
    (payload as { records?: unknown })?.records,
    (payload as { data?: { documents?: unknown; records?: unknown } })?.data?.documents,
    (payload as { data?: { documents?: unknown; records?: unknown } })?.data?.records,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as OmniDocument[];
  }

  return [];
}

function normalizeFolderDocument(doc: OmniDocument, folder: OmniFolder): FolderDashboard {
  const raw = doc as OmniDocument & {
    title?: string;
    displayTitle?: string;
    document?: { id?: string; name?: string; title?: string; displayTitle?: string; labels?: Array<string | { name?: string }> };
  };
  const nested = raw.document;
  const id = doc.id || nested?.id || doc.identifier || '';
  const name = doc.name || raw.title || raw.displayTitle || nested?.name || nested?.title || nested?.displayTitle || 'Untitled document';
  const labelState = extractLabelState(doc);

  return {
    ...doc,
    id,
    name,
    labels: labelState.available ? labelState.labels : undefined,
    folderId: doc.folderId || folder.id,
    folderName: folder.name,
    folderPath: doc.folderPath || folder.path || folder.identifier,
  };
}

function labelFromCreateResponse(payload: LabelCreateResponse | undefined, fallbackName: string): OmniLabel {
  const label = payload?.label || payload?.record || payload?.data || payload || { name: fallbackName };
  const name = label?.name || fallbackName;
  return {
    ...label,
    id: label?.id || name,
    name,
  };
}

function downloadCsv(fileName: string, rows: Array<Array<string | number>>) {
  const blob = new Blob([csvRowsToText(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function instanceDisplayLabel(baseUrl: string, configuredLabel?: string): string {
  const label = configuredLabel?.trim();
  try {
    const host = new URL(baseUrl).host;
    if (label && label !== host) return `${label} (${host})`;
    return label || host;
  } catch {
    return label || 'selected Omni instance';
  }
}

function referenceKeys(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const keys = new Set([normalizeBulkContentLabelTarget(trimmed)]);
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    keys.add(normalizeBulkContentLabelTarget(url.toString()));
  } catch {
    // IDs and other opaque references are compared without URL interpretation.
  }
  return [...keys];
}

function targetRecordKeys(record: Pick<OmniFolder, 'id' | 'identifier' | 'url'>): string[] {
  return [...new Set([
    ...referenceKeys(record.id),
    ...referenceKeys(record.identifier || ''),
    ...referenceKeys(record.url || ''),
  ])];
}

function indexTargets<T extends Pick<OmniFolder, 'id' | 'identifier' | 'url'>>(records: T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const record of records) {
    for (const key of targetRecordKeys(record)) {
      const values = index.get(key) || [];
      if (!values.some((value) => value.id === record.id)) values.push(record);
      index.set(key, values);
    }
  }
  return index;
}

function findIndexedTargets<T extends { id: string }>(index: Map<string, T[]>, reference: string): T[] {
  const matches = new Map<string, T>();
  for (const key of referenceKeys(reference)) {
    for (const record of index.get(key) || []) matches.set(record.id, record);
  }
  return [...matches.values()];
}

function uniqueRowNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function sameRecordIds(left: Array<{ id: string }>, right: Array<{ id: string }>): boolean {
  if (left.length !== right.length) return false;
  const leftIds = new Set(left.map((record) => record.id));
  return right.every((record) => leftIds.has(record.id));
}

function bulkPreviewFingerprint(
  connectionKey: string,
  targets: BulkLabelTargetPreview[],
  missingLabels: string[],
): string {
  return JSON.stringify({
    connectionKey,
    missingLabels: [...missingLabels].map(normalize).sort(),
    targets: [...targets]
      .map((target) => ({
        key: target.key,
        add: target.add.map(normalize).sort(),
        remove: target.remove.map(normalize).sort(),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  });
}

function bulkResultRows(instanceLabel: string, results: BulkLabelResult[]): Array<Array<string | number>> {
  return [
    ['instance', 'status', 'stage', 'target', 'source_rows', 'message'],
    ...results.map((result) => [
      instanceLabel,
      result.status,
      result.stage,
      result.target,
      result.rowNumbers.join('|'),
      result.message,
    ]),
  ];
}

export function LabelsPage() {
  const { connection } = useConnection();
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const logOp = useLogOperation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bulkValidationAbortRef = useRef<AbortController | null>(null);
  const bulkExecutionLockRef = useRef(false);
  const bulkInputRevisionRef = useRef(0);
  const manualMutationAbortRef = useRef<AbortController | null>(null);
  const activeMutationEvidenceRef = useRef<ActiveMutationEvidence | null>(null);
  const folderDocumentLoadsRef = useRef<Set<string>>(new Set());
  const nextLabelMutationAtRef = useRef(0);
  const [labels, setLabels] = useState<OmniLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [folders, setFolders] = useState<OmniFolder[]>([]);
  const [folderLabels, setFolderLabels] = useState<Record<string, string[]>>({});
  const [unavailableFolderLabelIds, setUnavailableFolderLabelIds] = useState<Set<string>>(new Set());
  const [activeFolderId, setActiveFolderId] = useState('');
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [folderTargetMode, setFolderTargetMode] = useState<FolderTargetMode>('documents');
  const [folderSearch, setFolderSearch] = useState('');

  const [documentsByFolder, setDocumentsByFolder] = useState<Record<string, FolderDashboard[]>>({});
  const [docSearch, setDocSearch] = useState('');
  const [selectedDocumentsById, setSelectedDocumentsById] = useState<Record<string, FolderDashboard>>({});
  const [documentLabels, setDocumentLabels] = useState<Record<string, string[]>>({});
  const [unavailableDocumentLabelIds, setUnavailableDocumentLabelIds] = useState<Set<string>>(new Set());
  const [loadingFolderDocumentIds, setLoadingFolderDocumentIds] = useState<Set<string>>(new Set());
  const [failedFolderDocumentIds, setFailedFolderDocumentIds] = useState<Set<string>>(new Set());

  const [addLabels, setAddLabels] = useState<string[]>([]);
  const [removeLabels, setRemoveLabels] = useState<string[]>([]);
  const [newLabelName, setNewLabelName] = useState('');
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyProgress, setApplyProgress] = useState<ApplyProgress | null>(null);
  const [showApplyConfirm, setShowApplyConfirm] = useState(false);
  const [applyResults, setApplyResults] = useState<LabelApplyResult[]>([]);

  const [bulkCsvText, setBulkCsvText] = useState('');
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkPlan, setBulkPlan] = useState<BulkContentLabelPlan | null>(null);
  const [bulkPreview, setBulkPreview] = useState<BulkLabelPreview | null>(null);
  const [bulkValidating, setBulkValidating] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<ApplyProgress | null>(null);
  const [bulkResults, setBulkResults] = useState<BulkLabelResult[]>([]);
  const [bulkError, setBulkError] = useState('');
  const [bulkPreviewConsumed, setBulkPreviewConsumed] = useState(false);
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  const [mutationReviewNotices, setMutationReviewNotices] = useState<MutationReviewNotice[]>([]);

  const selectedInstanceLabel = instanceDisplayLabel(connection.baseUrl, connection.instanceLabel);

  function beginMutationEvidence(operation: string) {
    activeMutationEvidenceRef.current = {
      connectionKey,
      instanceLabel: selectedInstanceLabel,
      operation,
      writeStarted: false,
      confirmedWrites: 0,
    };
  }

  function markMutationRequestStarted(requestKey: string, target: string) {
    const evidence = activeMutationEvidenceRef.current;
    if (!evidence || evidence.connectionKey !== requestKey) return;
    evidence.writeStarted = true;
    evidence.inFlightTarget = target;
  }

  function markMutationRequestFinished(requestKey: string, confirmed: boolean) {
    const evidence = activeMutationEvidenceRef.current;
    if (!evidence || evidence.connectionKey !== requestKey) return;
    if (confirmed) evidence.confirmedWrites += 1;
    else if (evidence.inFlightTarget) {
      setMutationReviewNotices((previous) => mergeMutationReviewNotice(
        previous,
        evidence,
        'unconfirmed_result',
        evidence.inFlightTarget,
      ));
    }
    evidence.inFlightTarget = undefined;
  }

  function clearMutationEvidence(requestKey: string) {
    if (activeMutationEvidenceRef.current?.connectionKey === requestKey) {
      activeMutationEvidenceRef.current = null;
    }
  }

  const flatFolders = useMemo(() => flattenFolders(folders), [folders]);
  const foldersById = useMemo(() => new Map(flatFolders.map((folder) => [folder.id, folder])), [flatFolders]);
  const selectedFolders = useMemo(
    () => flatFolders.filter((folder) => selectedFolderIds.has(folder.id)),
    [flatFolders, selectedFolderIds],
  );
  const selectedFolderTargets = useMemo(
    () => folderTargetMode === 'documents' ? [] : selectedFolders,
    [folderTargetMode, selectedFolders],
  );
  const selectedDocs = useMemo(() => Object.values(selectedDocumentsById), [selectedDocumentsById]);
  const filteredFolders = useMemo(() => {
    const term = folderSearch.trim().toLowerCase();
    if (!term) return flatFolders;
    return flatFolders.filter((folder) => {
      const labelsForFolder = folderLabels[folder.id] || extractLabels(folder);
      const haystack = [
        folder.name,
        folder.path,
        folder.identifier,
        ...labelsForFolder,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(term);
    });
  }, [flatFolders, folderLabels, folderSearch]);

  useEffect(() => {
    const activeMutation = activeMutationEvidenceRef.current;
    if (activeMutation?.writeStarted && activeMutation.connectionKey !== connectionKey) {
      setMutationReviewNotices((previous) => mergeMutationReviewNotice(
        previous,
        activeMutation,
        'instance_changed',
      ));
    }
    activeMutationEvidenceRef.current = null;
    bulkValidationAbortRef.current?.abort();
    bulkValidationAbortRef.current = null;
    bulkInputRevisionRef.current += 1;
    manualMutationAbortRef.current?.abort();
    manualMutationAbortRef.current = null;
    bulkExecutionLockRef.current = false;
    folderDocumentLoadsRef.current.clear();
    nextLabelMutationAtRef.current = 0;
    setBulkPlan(null);
    setBulkPreview(null);
    setBulkResults([]);
    setBulkProgress(null);
    setBulkError('');
    setBulkValidating(false);
    setBulkRunning(false);
    setBulkPreviewConsumed(false);
    setShowBulkConfirm(false);

    async function load() {
      const requestKey = connectionKey;
      setLoading(true);
      setError('');
      setLabels([]);
      setFolders([]);
      setFolderLabels({});
      setUnavailableFolderLabelIds(new Set());
      setActiveFolderId('');
      setSelectedFolderIds(new Set());
      setFolderTargetMode('documents');
      setDocumentsByFolder({});
      setSelectedDocumentsById({});
      setDocumentLabels({});
      setUnavailableDocumentLabelIds(new Set());
      setLoadingFolderDocumentIds(new Set());
      setFailedFolderDocumentIds(new Set());
      setAddLabels([]);
      setRemoveLabels([]);
      setNewLabelName('');
      setCreatingLabel(false);
      setApplying(false);
      setApplyProgress(null);
      setApplyResults([]);
      setShowApplyConfirm(false);
      try {
        const [labelsRes, foldersRes] = await Promise.all([
          omniProxy<LabelListResponse>(connection.baseUrl, connection.apiKey, 'GET', '/v1/labels'),
          listFolders(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 }),
        ]);
        if (!isActiveConnectionRequest(requestKey)) return;

        const nextFolders = Array.isArray(foldersRes.folders) ? foldersRes.folders : [];
        const nextLabels = parseLabelCatalog(labelsRes);
        const nextFolderLabels = seedLabelsFromFolders(nextFolders);
        const nextUnavailableFolderLabelIds = new Set(
          flattenFolders(nextFolders)
            .filter((folder) => !extractLabelState(folder).available)
            .map((folder) => folder.id),
        );

        try {
          const folderDetails = await omniProxy<{ records?: OmniFolder[]; folders?: OmniFolder[] }>(
            connection.baseUrl,
            connection.apiKey,
            'GET',
            '/v1/folders',
            { queryParams: { include: 'labels', pageSize: '1000' } },
          );
          if (!isActiveConnectionRequest(requestKey)) return;
          const detailedFolders = folderDetails.records || folderDetails.folders || [];
          for (const folder of detailedFolders) {
            const labelState = extractLabelState(folder);
            if (labelState.available) {
              nextFolderLabels[folder.id] = labelState.labels;
              nextUnavailableFolderLabelIds.delete(folder.id);
            }
          }
        } catch {
          // Folder hierarchy from the edge function is still enough to run the workflow.
        }

        setLabels(nextLabels);
        setFolders(nextFolders);
        setFolderLabels(nextFolderLabels);
        setUnavailableFolderLabelIds(nextUnavailableFolderLabelIds);
      } catch (err) {
        if (!isActiveConnectionRequest(requestKey)) return;
        setError(friendlyApiError(err, 'Failed to load labels'));
      } finally {
        if (isActiveConnectionRequest(requestKey)) setLoading(false);
      }
    }
    load();
    return () => {
      bulkValidationAbortRef.current?.abort();
      manualMutationAbortRef.current?.abort();
    };
  }, [connection.baseUrl, connection.apiKey, connectionKey, isActiveConnectionRequest]);

  const fetchFolderDocuments = useCallback(async (
    folder: OmniFolder,
    options?: { signal?: AbortSignal },
  ): Promise<FolderDashboard[]> => {
    const res = await listDocuments(connection.baseUrl, connection.apiKey, folder.id, {
      allPages: true,
      pageSize: 100,
      includeAllDocuments: true,
      forceRefresh: true,
      signal: options?.signal,
    }) as InventoryResponse<OmniDocument>;
    if (res.complete !== true) {
      throw new Error(
        `Omni returned an incomplete document inventory for ${folder.name} (${res.loadedResults || 0}/${res.totalResults ?? 'unknown'} loaded).`,
      );
    }
    const docs = extractDocuments(res);
    return docs.map((doc) => normalizeFolderDocument(doc, folder)).filter((doc) => Boolean(doc.id));
  }, [connection.baseUrl, connection.apiKey]);

  const loadFolderDocuments = useCallback(async (folderId: string, options?: { makeActive?: boolean }) => {
    const requestKey = connectionKey;
    const folder = foldersById.get(folderId);
    if (options?.makeActive !== false) {
      setActiveFolderId(folderId);
      setDocSearch('');
    }
    setApplyResults([]);
    if (!folderId || !folder) return;
    if (documentsByFolder[folderId]) return;
    const loadKey = `${connectionKey}|${folderId}`;
    if (folderDocumentLoadsRef.current.has(loadKey)) return;

    folderDocumentLoadsRef.current.add(loadKey);
    setError('');
    setFailedFolderDocumentIds((prev) => {
      const next = new Set(prev);
      next.delete(folderId);
      return next;
    });
    setLoadingFolderDocumentIds((prev) => new Set([...prev, folderId]));
    try {
      const nextDocs = await fetchFolderDocuments(folder);
      if (!isActiveConnectionRequest(requestKey)) return;
      setDocumentsByFolder((prev) => ({ ...prev, [folderId]: nextDocs }));
      const labelSeed: Record<string, string[]> = {};
      const unavailableIds = new Set<string>();
      for (const doc of nextDocs) {
        const labelState = extractLabelState(doc);
        if (labelState.available) labelSeed[doc.id] = labelState.labels;
        else unavailableIds.add(doc.id);
      }
      setDocumentLabels((prev) => ({ ...prev, ...labelSeed }));
      setUnavailableDocumentLabelIds((prev) => {
        const next = new Set(prev);
        for (const doc of nextDocs) next.delete(doc.id);
        for (const id of unavailableIds) next.add(id);
        return next;
      });
      setFailedFolderDocumentIds((prev) => {
        const next = new Set(prev);
        next.delete(folderId);
        return next;
      });
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setFailedFolderDocumentIds((prev) => new Set([...prev, folderId]));
      setError(friendlyApiError(err, 'Failed to load folder documents'));
    } finally {
      folderDocumentLoadsRef.current.delete(loadKey);
      if (isActiveConnectionRequest(requestKey)) setLoadingFolderDocumentIds((prev) => {
        const next = new Set(prev);
        next.delete(folderId);
        return next;
      });
    }
  }, [connectionKey, documentsByFolder, fetchFolderDocuments, foldersById, isActiveConnectionRequest]);

  useEffect(() => {
    if (folderTargetMode === 'folder') return;
    for (const folderId of selectedFolderIds) {
      if (
        !documentsByFolder[folderId]
        && !loadingFolderDocumentIds.has(folderId)
        && !failedFolderDocumentIds.has(folderId)
      ) {
        void loadFolderDocuments(folderId, { makeActive: false });
      }
    }
  }, [documentsByFolder, failedFolderDocumentIds, folderTargetMode, loadFolderDocuments, loadingFolderDocumentIds, selectedFolderIds]);

  function toggleFolder(folderId: string) {
    if (applying || bulkRunning) return;
    setApplyResults([]);
    const selecting = !selectedFolderIds.has(folderId);
    if (!selecting) {
      if (activeFolderId === folderId) {
        setActiveFolderId('');
        setDocSearch('');
      }
      setSelectedDocumentsById((prev) => {
        const next = { ...prev };
        for (const [docId, doc] of Object.entries(next)) {
          if (doc.folderId === folderId) delete next[docId];
        }
        return next;
      });
    }
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
    if (selecting && folderTargetMode !== 'folder') {
      void loadFolderDocuments(folderId, { makeActive: !activeFolderId });
    }
  }

  function toggleDoc(doc: FolderDashboard) {
    if (applying || bulkRunning) return;
    setApplyResults([]);
    setSelectedDocumentsById((prev) => {
      const next = { ...prev };
      if (next[doc.id]) {
        delete next[doc.id];
      } else {
        next[doc.id] = doc;
      }
      return next;
    });
  }

  function toggleAllVisible() {
    if (applying || bulkRunning) return;
    setApplyResults([]);
    const visibleIds = filteredDocs.map((doc) => doc.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedDocumentsById[id]);
    if (allSelected) {
      setSelectedDocumentsById((prev) => {
        const next = { ...prev };
        visibleIds.forEach((id) => {
          delete next[id];
        });
        return next;
      });
    } else {
      setSelectedDocumentsById((prev) => {
        const next = { ...prev };
        filteredDocs.forEach((doc) => {
          next[doc.id] = doc;
        });
        return next;
      });
    }
  }

  function toggleAddLabel(name: string) {
    if (applying || bulkRunning) return;
    setApplyResults([]);
    setAddLabels((prev) => (prev.includes(name) ? prev.filter((label) => label !== name) : [...prev, name]));
    setRemoveLabels((prev) => prev.filter((label) => label !== name));
  }

  function toggleRemoveLabel(name: string) {
    if (applying || bulkRunning) return;
    setApplyResults([]);
    setRemoveLabels((prev) => (prev.includes(name) ? prev.filter((label) => label !== name) : [...prev, name]));
    setAddLabels((prev) => prev.filter((label) => label !== name));
  }

  async function waitForLabelMutationSlot(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException('The label operation was cancelled.', 'AbortError');
    const now = Date.now();
    const waitMs = Math.max(0, nextLabelMutationAtRef.current - now);
    nextLabelMutationAtRef.current = Math.max(now, nextLabelMutationAtRef.current) + LABEL_MUTATION_SPACING_MS;
    if (waitMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, waitMs);
        const onAbort = () => {
          window.clearTimeout(timeout);
          reject(new DOMException('The label operation was cancelled.', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (signal?.aborted) throw new DOMException('The label operation was cancelled.', 'AbortError');
  }

  async function handleCreateLabel() {
    const name = newLabelName.trim();
    if (!name || creatingLabel || applying || bulkRunning || manualMutationAbortRef.current) return;
    const existing = labels.find((label) => normalize(labelName(label)) === normalize(name));
    if (existing) {
      setNewLabelName('');
      toggleAddLabel(labelName(existing));
      return;
    }

    setCreatingLabel(true);
    setError('');
    const requestKey = connectionKey;
    const controller = new AbortController();
    manualMutationAbortRef.current = controller;
    beginMutationEvidence('label creation');
    try {
      await waitForLabelMutationSlot(controller.signal);
      if (controller.signal.aborted || !isActiveConnectionRequest(requestKey)) return;
      markMutationRequestStarted(requestKey, name);
      const response = await omniProxy<LabelCreateResponse | undefined>(
        connection.baseUrl,
        connection.apiKey,
        'POST',
        '/v1/labels',
        { body: { name }, signal: controller.signal },
      );
      if (controller.signal.aborted || !isActiveConnectionRequest(requestKey)) return;
      markMutationRequestFinished(requestKey, true);
      const created = labelFromCreateResponse(response, name);
      setLabels((prev) => [...prev, created].sort((a, b) => labelName(a).localeCompare(labelName(b))));
      setNewLabelName('');
      setAddLabels((prev) => (prev.some((label) => normalize(label) === normalize(created.name)) ? prev : [...prev, created.name]));
      setRemoveLabels((prev) => prev.filter((label) => normalize(label) !== normalize(created.name)));
    } catch (err) {
      if (controller.signal.aborted || !isActiveConnectionRequest(requestKey)) return;
      markMutationRequestFinished(requestKey, false);
      setError(friendlyApiError(err, 'Failed to create label'));
    } finally {
      if (isActiveConnectionRequest(requestKey)) setCreatingLabel(false);
      if (manualMutationAbortRef.current === controller) manualMutationAbortRef.current = null;
      clearMutationEvidence(requestKey);
    }
  }

  function clearBulkAnalysis(nextText = bulkCsvText) {
    bulkInputRevisionRef.current += 1;
    bulkValidationAbortRef.current?.abort();
    bulkValidationAbortRef.current = null;
    setBulkCsvText(nextText);
    setBulkPlan(null);
    setBulkPreview(null);
    setBulkResults([]);
    setBulkProgress(null);
    setBulkError('');
    setBulkValidating(false);
    setBulkPreviewConsumed(false);
    setShowBulkConfirm(false);
  }

  async function handleBulkFile(file: File) {
    clearBulkAnalysis('');
    const inputRevision = bulkInputRevisionRef.current;
    setBulkFileName(file.name);
    if (file.size > MAX_BULK_CSV_BYTES) {
      setBulkError('CSV files are limited to 5 MB for local preflight safety.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setBulkError('Choose a .csv file.');
      return;
    }
    try {
      const text = await file.text();
      if (bulkInputRevisionRef.current !== inputRevision) return;
      setBulkCsvText(text);
    } catch (fileError) {
      if (bulkInputRevisionRef.current !== inputRevision) return;
      setBulkError(friendlyApiError(fileError, 'Could not read the CSV file'));
    }
  }

  async function buildBulkLabelPreview(
    plan: BulkContentLabelPlan,
    requestKey: string,
    signal: AbortSignal,
  ): Promise<BulkLabelPreview> {
    const needsFolders = plan.operations.some((operation) => operation.targetType === 'folder');
    const needsDocuments = plan.operations.some((operation) => operation.targetType === 'document');
    const [folderInventory, documentInventory, labelInventory] = await Promise.all([
      needsFolders
        ? listFolders(connection.baseUrl, connection.apiKey, {
            allPages: true,
            pageSize: 100,
            forceRefresh: true,
            signal,
          }) as Promise<InventoryResponse<OmniFolder>>
        : Promise.resolve({ folders: [], complete: true } as InventoryResponse<OmniFolder>),
      needsDocuments
        ? listDocuments(connection.baseUrl, connection.apiKey, undefined, {
            allPages: true,
            pageSize: 100,
            forceRefresh: true,
            includeAllDocuments: true,
            signal,
          }) as Promise<InventoryResponse<OmniDocument>>
        : Promise.resolve({ documents: [], complete: true } as InventoryResponse<OmniDocument>),
      omniProxy<LabelListResponse>(
        connection.baseUrl,
        connection.apiKey,
        'GET',
        '/v1/labels',
        { signal },
      ),
    ]);

    if (signal.aborted || !isActiveConnectionRequest(requestKey)) {
      throw new DOMException('The label preview was cancelled.', 'AbortError');
    }

    const issues: BulkLabelPreview['issues'] = plan.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => ({ message: issue.message, rowNumbers: issue.rowNumbers || (issue.rowNumber ? [issue.rowNumber] : undefined) }));
    if (needsFolders && folderInventory.complete !== true) {
      issues.push({
        message: `Folder inventory is incomplete (${folderInventory.loadedResults || 0}/${folderInventory.totalResults ?? 'unknown'} loaded). No folder changes can run.`,
      });
    }
    if (needsDocuments && documentInventory.complete !== true) {
      issues.push({
        message: `Document inventory is incomplete (${documentInventory.loadedResults || 0}/${documentInventory.totalResults ?? 'unknown'} loaded). No document changes can run.`,
      });
    }

    const folderRecords = flattenFolders(folderInventory.folders || []);
    const documentRecords = documentInventory.documents || [];
    const folderIndex = indexTargets(folderRecords);
    const documentIndex = indexTargets(documentRecords);
    const grouped = new Map<string, {
      type: BulkContentLabelTargetType;
      record: OmniFolder | OmniDocument;
      reference: string;
      add: Map<string, { label: string; rows: number[] }>;
      remove: Map<string, { label: string; rows: number[] }>;
    }>();

    for (const operation of plan.operations) {
      const matches = operation.targetType === 'folder'
        ? findIndexedTargets(folderIndex, operation.targetIdOrUrl)
        : findIndexedTargets(documentIndex, operation.targetIdOrUrl);
      if (matches.length === 0) {
        issues.push({
          rowNumbers: operation.rowNumbers,
          message: `${operation.targetType} ${operation.targetIdOrUrl} was not found in the selected Omni instance. Use its exact Omni ID or URL.`,
        });
        continue;
      }
      if (matches.length > 1) {
        issues.push({
          rowNumbers: operation.rowNumbers,
          message: `${operation.targetType} ${operation.targetIdOrUrl} matched more than one record. Use the exact immutable ID.`,
        });
        continue;
      }

      const record = matches[0];
      const key = `${operation.targetType}:${record.id}`;
      const target = grouped.get(key) || {
        type: operation.targetType,
        record,
        reference: operation.targetIdOrUrl,
        add: new Map<string, { label: string; rows: number[] }>(),
        remove: new Map<string, { label: string; rows: number[] }>(),
      };
      const destination = operation.action === 'add' ? target.add : target.remove;
      for (const label of operation.labels) {
        const labelKey = normalize(label);
        const existing = destination.get(labelKey) || { label, rows: [] };
        existing.rows.push(...operation.rowNumbers);
        existing.rows = uniqueRowNumbers(existing.rows);
        destination.set(labelKey, existing);
      }
      grouped.set(key, target);
    }

    const labelCatalogRecords = parseLabelCatalog(labelInventory);
    const labelCatalog = new Map(labelCatalogRecords.map((label) => [normalize(labelName(label)), labelName(label)]));
    const missingLabelMap = new Map<string, string>();
    const targets: BulkLabelTargetPreview[] = [];

    for (const [key, target] of grouped) {
      const conflicts = [...target.add.keys()].filter((labelKey) => target.remove.has(labelKey));
      if (conflicts.length > 0) {
        issues.push({
          rowNumbers: uniqueRowNumbers(conflicts.flatMap((labelKey) => [
            ...(target.add.get(labelKey)?.rows || []),
            ...(target.remove.get(labelKey)?.rows || []),
          ])),
          message: `${target.type} ${target.reference} cannot add and remove the same resolved label: ${conflicts.map((labelKey) => target.add.get(labelKey)?.label || labelKey).join(', ')}.`,
        });
        continue;
      }

      const labelState = extractLabelState(target.record);
      if (!labelState.available) {
        issues.push({
          rowNumbers: uniqueRowNumbers([
            ...[...target.add.values()].flatMap((value) => value.rows),
            ...[...target.remove.values()].flatMap((value) => value.rows),
          ]),
          message: `Current labels are unavailable for ${target.type} ${target.reference}. Refresh the inventory before applying changes.`,
        });
        continue;
      }

      const currentByKey = new Map(labelState.labels.map((label) => [normalize(label), label]));
      const add: string[] = [];
      const remove: string[] = [];
      const noops: string[] = [];
      for (const [labelKey, source] of target.add) {
        const current = currentByKey.get(labelKey);
        if (current) {
          noops.push(`Add ${current} (already present)`);
          continue;
        }
        const canonical = labelCatalog.get(labelKey) || source.label;
        add.push(canonical);
        if (!labelCatalog.has(labelKey)) missingLabelMap.set(labelKey, canonical);
      }
      for (const [labelKey, source] of target.remove) {
        const current = currentByKey.get(labelKey);
        if (current) remove.push(current);
        else noops.push(`Remove ${labelCatalog.get(labelKey) || source.label} (not present)`);
      }

      targets.push({
        key,
        type: target.type,
        id: target.record.id,
        name: target.record.name,
        reference: target.reference,
        currentLabels: labelState.labels,
        add: uniqueLabels(add),
        remove: uniqueLabels(remove),
        noops,
        rowNumbers: uniqueRowNumbers([
          ...[...target.add.values()].flatMap((value) => value.rows),
          ...[...target.remove.values()].flatMap((value) => value.rows),
        ]),
      });
    }

    targets.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
    const missingLabels = [...missingLabelMap.values()].sort((left, right) => left.localeCompare(right));
    return {
      connectionKey: requestKey,
      instanceLabel: selectedInstanceLabel,
      plan,
      targets,
      labelCatalog: labelCatalogRecords,
      missingLabels,
      issues,
      fingerprint: bulkPreviewFingerprint(requestKey, targets, missingLabels),
      createdAt: Date.now(),
    };
  }

  async function analyzeBulkCsv() {
    if (bulkRunning || applying || !bulkCsvText.trim()) return;
    bulkValidationAbortRef.current?.abort();
    const controller = new AbortController();
    bulkValidationAbortRef.current = controller;
    const requestKey = connectionKey;
    setBulkValidating(true);
    setBulkError('');
    setBulkResults([]);
    setBulkPreview(null);
    setBulkPreviewConsumed(false);

    try {
      const plan = parseBulkContentLabelsCsv(bulkCsvText);
      setBulkPlan(plan);
      if (plan.blocked) return;
      const preview = await buildBulkLabelPreview(plan, requestKey, controller.signal);
      if (controller.signal.aborted || !isActiveConnectionRequest(requestKey)) return;
      setLabels(preview.labelCatalog);
      setBulkPreview(preview);
    } catch (previewError) {
      if (controller.signal.aborted || !isActiveConnectionRequest(requestKey)) return;
      setBulkPlan(null);
      setBulkError(friendlyApiError(previewError, 'Could not validate the label CSV'));
    } finally {
      if (isActiveConnectionRequest(requestKey) && bulkValidationAbortRef.current === controller) {
        setBulkValidating(false);
        bulkValidationAbortRef.current = null;
      }
    }
  }

  async function executeBulkLabels() {
    setShowBulkConfirm(false);
    if (
      !bulkPreview
      || bulkPreviewConsumed
      || bulkRunning
      || applying
      || bulkExecutionLockRef.current
      || creatingLabel
      || manualMutationAbortRef.current
    ) return;
    if (bulkPreview.connectionKey !== connectionKey) {
      setBulkError('The selected Omni instance changed. Validate a fresh preview before applying labels.');
      return;
    }

    bulkExecutionLockRef.current = true;
    const requestKey = connectionKey;
    const controller = new AbortController();
    bulkValidationAbortRef.current?.abort();
    bulkValidationAbortRef.current = controller;
    beginMutationEvidence('CSV label import');
    setBulkRunning(true);
    setBulkError('');
    setBulkResults([]);

    const results: BulkLabelResult[] = [];
    const publishResult = (result: BulkLabelResult, total: number) => {
      results.push(result);
      if (!isActiveConnectionRequest(requestKey)) return;
      setBulkResults([...results]);
      setBulkProgress({ completed: results.length, total });
    };

    try {
      const freshPreview = await buildBulkLabelPreview(bulkPreview.plan, requestKey, controller.signal);
      if (controller.signal.aborted || !isActiveConnectionRequest(requestKey)) return;
      setLabels(freshPreview.labelCatalog);
      setBulkPreview(freshPreview);
      if (freshPreview.issues.length > 0) {
        setBulkError('The fresh preflight found blocking issues. Review them before applying changes.');
        return;
      }
      if (freshPreview.fingerprint !== bulkPreview.fingerprint) {
        setBulkError('Omni label state changed after the preview. Review the refreshed changes, then confirm again.');
        return;
      }

      const total = freshPreview.missingLabels.length + freshPreview.targets.length;
      setBulkProgress({ completed: 0, total });
      const failedLabelCreates = new Set<string>();
      for (const label of freshPreview.missingLabels) {
        if (controller.signal.aborted) throw new DOMException('The label operation was cancelled.', 'AbortError');
        if (!isActiveConnectionRequest(requestKey)) return;
        try {
          await waitForLabelMutationSlot(controller.signal);
          if (controller.signal.aborted || !isActiveConnectionRequest(requestKey)) return;
          markMutationRequestStarted(requestKey, `label ${label}`);
          const response = await omniProxy<LabelCreateResponse | undefined>(
            connection.baseUrl,
            connection.apiKey,
            'POST',
            '/v1/labels',
            { body: { name: label }, signal: controller.signal },
          );
          if (controller.signal.aborted || !isActiveConnectionRequest(requestKey)) {
            throw new DOMException('The label operation was cancelled.', 'AbortError');
          }
          markMutationRequestFinished(requestKey, true);
          const created = labelFromCreateResponse(response, label);
          setLabels((previous) => previous.some((existing) => normalize(labelName(existing)) === normalize(created.name))
            ? previous
            : [...previous, created].sort((left, right) => labelName(left).localeCompare(labelName(right))));
          publishResult({ stage: 'label', target: created.name, status: 'success', rowNumbers: [], message: 'Created missing basic label.' }, total);
        } catch (createError) {
          if (controller.signal.aborted) throw createError;
          markMutationRequestFinished(requestKey, false);
          failedLabelCreates.add(normalize(label));
          publishResult({
            stage: 'label',
            target: label,
            status: 'failed',
            rowNumbers: [],
            message: friendlyApiError(createError, 'Label creation failed'),
          }, total);
        }
      }

      for (const target of freshPreview.targets) {
        if (controller.signal.aborted) throw new DOMException('The label operation was cancelled.', 'AbortError');
        if (!isActiveConnectionRequest(requestKey)) return;
        const unavailableAdds = target.add.filter((label) => failedLabelCreates.has(normalize(label)));
        if (unavailableAdds.length > 0) {
          publishResult({
            stage: target.type,
            target: target.name,
            status: 'failed',
            rowNumbers: target.rowNumbers,
            message: `Skipped because these required labels could not be created: ${unavailableAdds.join(', ')}.`,
          }, total);
          continue;
        }
        if (target.add.length === 0 && target.remove.length === 0) {
          publishResult({
            stage: target.type,
            target: target.name,
            status: 'skipped',
            rowNumbers: target.rowNumbers,
            message: target.noops.join('; ') || 'No label changes needed.',
          }, total);
          continue;
        }

        try {
          const response = await patchTargetLabels(
            target.type,
            target.id,
            target.currentLabels,
            target.add,
            target.remove,
            requestKey,
            controller.signal,
            () => markMutationRequestStarted(requestKey, `${target.type} ${target.name}`),
          );
          if (!isActiveConnectionRequest(requestKey)) return;
          markMutationRequestFinished(requestKey, true);
          if (target.type === 'folder') {
            setFolderLabels((previous) => ({ ...previous, [target.id]: response.labels }));
          } else {
            setDocumentLabels((previous) => ({ ...previous, [target.id]: response.labels }));
          }
          publishResult({
            stage: target.type,
            target: target.name,
            status: 'success',
            rowNumbers: target.rowNumbers,
            message: `${target.add.length} added, ${target.remove.length} removed.${target.noops.length > 0 ? ` ${target.noops.length} no-op${target.noops.length === 1 ? '' : 's'}.` : ''}`,
          }, total);
        } catch (mutationError) {
          if (controller.signal.aborted) throw mutationError;
          markMutationRequestFinished(requestKey, false);
          publishResult({
            stage: target.type,
            target: target.name,
            status: 'failed',
            rowNumbers: target.rowNumbers,
            message: friendlyApiError(mutationError, `${target.type === 'folder' ? 'Folder' : 'Document'} label update failed`),
          }, total);
        }
      }

      if (!isActiveConnectionRequest(requestKey)) return;
      setBulkPreviewConsumed(true);
      logOp('label_change', `CSV label import for ${freshPreview.targets.length} content targets`, {
        durationMs: Date.now() - freshPreview.createdAt,
        itemCount: freshPreview.targets.length,
      });
    } catch (executionError) {
      if (controller.signal.aborted && isActiveConnectionRequest(requestKey)) {
        const evidence = activeMutationEvidenceRef.current;
        if (evidence?.connectionKey === requestKey && evidence.writeStarted) {
          setMutationReviewNotices((previous) => mergeMutationReviewNotice(
            previous,
            evidence,
            'stopped',
          ));
        }
        setBulkPreviewConsumed(true);
        setBulkError('The CSV label operation was stopped. Some completed or in-flight writes may have reached Omni; validate a fresh preview before continuing.');
      } else if (isActiveConnectionRequest(requestKey)) {
        setBulkError(friendlyApiError(executionError, 'The CSV label operation could not be completed'));
      }
    } finally {
      if (isActiveConnectionRequest(requestKey)) {
        setBulkRunning(false);
        setBulkProgress(null);
      }
      bulkExecutionLockRef.current = false;
      if (bulkValidationAbortRef.current === controller) bulkValidationAbortRef.current = null;
      clearMutationEvidence(requestKey);
    }
  }

  async function patchTargetLabels(
    targetType: 'folder' | 'document',
    targetId: string,
    currentLabels: string[],
    add: string[],
    remove: string[],
    requestKey: string,
    signal: AbortSignal,
    onRequestStart?: () => void,
  ) {
    const path = targetType === 'folder'
      ? `/v1/folders/${encodeURIComponent(targetId)}/labels`
      : `/v1/documents/${encodeURIComponent(targetId)}/labels`;
    if (signal.aborted || !isActiveConnectionRequest(requestKey)) {
      throw new DOMException('The label operation was cancelled.', 'AbortError');
    }
    await waitForLabelMutationSlot(signal);
    if (signal.aborted || !isActiveConnectionRequest(requestKey)) {
      throw new DOMException('The label operation was cancelled.', 'AbortError');
    }
    onRequestStart?.();
    const response = await omniProxy<LabelMutationResponse | undefined>(
      connection.baseUrl,
      connection.apiKey,
      'PATCH',
      path,
      { body: { add, remove }, signal },
    );
    if (
      !response
      || !Array.isArray(response.labels)
      || !response.labels.every((label) => typeof label === 'string' && label.trim().length > 0)
    ) {
      throw new Error(`Omni returned an invalid ${targetType} label response. The outcome must be reviewed before retrying.`);
    }
    const nextLabels = uniqueLabels(response.labels.map((label) => label.trim()));
    const expectedLabels = expectedLabelsAfterChange(currentLabels, add, remove);
    if (!sameLabelSet(nextLabels, expectedLabels)) {
      throw new Error(
        `Omni did not confirm the requested ${targetType} label state. The outcome must be reviewed before retrying.`,
      );
    }
    return { labels: nextLabels };
  }

  async function handleApply() {
    setShowApplyConfirm(false);
    if (
      applying
      || bulkRunning
      || creatingLabel
      || manualMutationAbortRef.current
      || bulkExecutionLockRef.current
      || loadingDocs
      || failedSelectedFolderDocumentIds.length > 0
      || unavailableSelectedLabelCount > 0
      || selectedTargetCount === 0
      || (addLabels.length === 0 && removeLabels.length === 0)
    ) return;

    const requestKey = connectionKey;
    const controller = new AbortController();
    manualMutationAbortRef.current = controller;
    beginMutationEvidence('manual label update');
    setApplying(true);
    setError('');
    setApplyResults([]);
    setApplyProgress({ completed: 0, total: selectedTargetCount });
    const start = Date.now();
    const results: LabelApplyResult[] = [];
    let completed = 0;

    const publishResult = (result: LabelApplyResult) => {
      results.push(result);
      completed += 1;
      if (!isActiveConnectionRequest(requestKey)) return;
      setApplyResults([...results]);
      setApplyProgress({ completed, total: selectedTargetCount });
    };

    try {
      let folderTargetsForApply = selectedFolderTargets;
      let documentTargetsForApply = selectedDashboardTargets;

      if (folderTargetsForApply.length > 0) {
        const inventory = await listFolders(connection.baseUrl, connection.apiKey, {
          allPages: true,
          pageSize: 100,
          forceRefresh: true,
          signal: controller.signal,
        }) as InventoryResponse<OmniFolder>;
        if (controller.signal.aborted || !isActiveConnectionRequest(requestKey)) {
          throw new DOMException('The label operation was cancelled.', 'AbortError');
        }
        if (inventory.complete !== true) {
          throw new Error(
            `Omni returned an incomplete folder inventory (${inventory.loadedResults || 0}/${inventory.totalResults ?? 'unknown'} loaded).`,
          );
        }
        const freshFoldersById = new Map(flattenFolders(inventory.folders || []).map((folder) => [folder.id, folder]));
        folderTargetsForApply = folderTargetsForApply.map((folder) => {
          const fresh = freshFoldersById.get(folder.id);
          if (!fresh) throw new Error(`Folder ${folder.name} is no longer present in the selected Omni instance.`);
          const labelState = extractLabelState(fresh);
          if (!labelState.available) throw new Error(`Current labels are unavailable for folder ${folder.name}.`);
          return { ...fresh, labels: labelState.labels };
        });
        setFolderLabels((previous) => ({
          ...previous,
          ...Object.fromEntries(folderTargetsForApply.map((folder) => [folder.id, extractLabelState(folder).labels])),
        }));
      }

      if (documentTargetsForApply.length > 0 || (folderTargetMode !== 'folder' && selectedFolderIds.size > 0)) {
        // Empty folders still belong to the confirmed document scope. Recheck them
        // too, so new contents require a fresh confirmation instead of being missed.
        const folderIds = [...new Set([
          ...(folderTargetMode !== 'folder' ? selectedFolderIds : []),
          ...documentTargetsForApply.map((document) => document.folderId).filter(Boolean),
        ])] as string[];
        const refreshedByFolder: Record<string, FolderDashboard[]> = {};
        const refreshedDocuments = new Map<string, FolderDashboard>();
        let folderScopeChanged = false;

        for (const folderId of folderIds) {
          const folder = foldersById.get(folderId);
          if (!folder) throw new Error(`The folder for a selected document is no longer available (${folderId}).`);
          const freshDocuments = await fetchFolderDocuments(folder, { signal: controller.signal });
          if (controller.signal.aborted || !isActiveConnectionRequest(requestKey)) {
            throw new DOMException('The label operation was cancelled.', 'AbortError');
          }
          refreshedByFolder[folderId] = freshDocuments;
          for (const document of freshDocuments) refreshedDocuments.set(document.id, document);
          if (
            folderTargetMode !== 'folder'
            && selectedFolderIds.has(folderId)
            && !sameRecordIds(documentsByFolder[folderId] || [], freshDocuments)
          ) {
            folderScopeChanged = true;
          }
        }

        const refreshedLabels: Record<string, string[]> = {};
        const unavailableIds = new Set<string>();
        for (const documents of Object.values(refreshedByFolder)) {
          for (const document of documents) {
            const labelState = extractLabelState(document);
            if (labelState.available) refreshedLabels[document.id] = labelState.labels;
            else unavailableIds.add(document.id);
          }
        }
        setDocumentsByFolder((previous) => ({ ...previous, ...refreshedByFolder }));
        setDocumentLabels((previous) => ({ ...previous, ...refreshedLabels }));
        setUnavailableDocumentLabelIds((previous) => {
          const next = new Set(previous);
          for (const documents of Object.values(refreshedByFolder)) {
            for (const document of documents) next.delete(document.id);
          }
          for (const id of unavailableIds) next.add(id);
          return next;
        });
        if (folderScopeChanged) {
          throw new Error('A selected folder’s document inventory changed after selection. Review the refreshed targets before applying labels.');
        }

        documentTargetsForApply = documentTargetsForApply.map((document) => {
          const fresh = refreshedDocuments.get(document.id);
          if (!fresh) throw new Error(`Document ${document.name} is no longer present in the selected Omni instance.`);
          const labelState = extractLabelState(fresh);
          if (!labelState.available) throw new Error(`Current labels are unavailable for document ${document.name}.`);
          return { ...fresh, labels: labelState.labels };
        });
      }

      for (const folder of folderTargetsForApply) {
        if (!isActiveConnectionRequest(requestKey)) break;
        try {
          const current = extractLabelState(folder).labels;
          const addForFolder = addLabels.filter((label) => !hasLabel(current, label));
          const removeForFolder = removeLabels.filter((label) => hasLabel(current, label));
          if (addForFolder.length === 0 && removeForFolder.length === 0) {
            publishResult({ id: folder.id, name: folder.name, type: 'folder', status: 'skipped', detail: 'No folder label changes needed' });
            continue;
          }

          const response = await patchTargetLabels(
            'folder',
            folder.id,
            current,
            addForFolder,
            removeForFolder,
            requestKey,
            controller.signal,
            () => markMutationRequestStarted(requestKey, `folder ${folder.name}`),
          );
          if (!isActiveConnectionRequest(requestKey)) break;
          markMutationRequestFinished(requestKey, true);
          setFolderLabels((prev) => ({ ...prev, [folder.id]: response.labels }));
          publishResult({
            id: folder.id,
            name: folder.name,
            type: 'folder',
            status: 'success',
            detail: `${addForFolder.length} added, ${removeForFolder.length} removed`,
          });
        } catch (err) {
          if (controller.signal.aborted) throw err;
          markMutationRequestFinished(requestKey, false);
          publishResult({
            id: folder.id,
            name: folder.name,
            type: 'folder',
            status: 'failed',
            detail: friendlyApiError(err, 'Folder label update failed'),
          });
        }
      }

      for (const doc of documentTargetsForApply) {
        if (!isActiveConnectionRequest(requestKey)) break;
        try {
          const current = extractLabelState(doc).labels;
          const addForDoc = addLabels.filter((label) => !hasLabel(current, label));
          const removeForDoc = removeLabels.filter((label) => hasLabel(current, label));
          if (addForDoc.length === 0 && removeForDoc.length === 0) {
            publishResult({ id: doc.id, name: doc.name, type: 'document', status: 'skipped', detail: 'No document label changes needed' });
            continue;
          }

          const response = await patchTargetLabels(
            'document',
            doc.id,
            current,
            addForDoc,
            removeForDoc,
            requestKey,
            controller.signal,
            () => markMutationRequestStarted(requestKey, `document ${doc.name}`),
          );
          if (!isActiveConnectionRequest(requestKey)) break;
          markMutationRequestFinished(requestKey, true);
          setDocumentLabels((prev) => ({ ...prev, [doc.id]: response.labels }));
          publishResult({
            id: doc.id,
            name: doc.name,
            type: 'document',
            status: 'success',
            detail: `${addForDoc.length} added, ${removeForDoc.length} removed`,
          });
        } catch (err) {
          if (controller.signal.aborted) throw err;
          markMutationRequestFinished(requestKey, false);
          publishResult({
            id: doc.id,
            name: doc.name,
            type: 'document',
            status: 'failed',
            detail: friendlyApiError(err, 'Document label update failed'),
          });
        }
      }

      if (!isActiveConnectionRequest(requestKey)) return;
      logOp('label_change', `Bulk label update for ${selectedFolderTargets.length} folders and ${selectedDashboardTargets.length} documents`, {
        durationMs: Date.now() - start,
        itemCount: selectedTargetCount,
      });
      setAddLabels([]);
      setRemoveLabels([]);
    } catch (applyError) {
      if (!controller.signal.aborted && isActiveConnectionRequest(requestKey)) {
        setError(friendlyApiError(applyError, 'Could not revalidate the selected label targets'));
      }
    } finally {
      if (isActiveConnectionRequest(requestKey)) {
        setApplying(false);
        setApplyProgress(null);
      }
      if (manualMutationAbortRef.current === controller) manualMutationAbortRef.current = null;
      clearMutationEvidence(requestKey);
    }
  }

  const dashboardFolderIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (id?: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };

    if (folderTargetMode !== 'folder') selectedFolders.forEach((folder) => add(folder.id));
    add(activeFolderId);
    selectedDocs.forEach((doc) => add(doc.folderId));

    return ids;
  }, [activeFolderId, folderTargetMode, selectedFolders, selectedDocs]);
  const dashboardList = useMemo(() => {
    const seen = new Set<string>();
    const nextDocs: FolderDashboard[] = [];
    for (const folderId of dashboardFolderIds) {
      for (const doc of documentsByFolder[folderId] || []) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        nextDocs.push(doc);
      }
    }
    return nextDocs;
  }, [dashboardFolderIds, documentsByFolder]);
  const filteredDocs = useMemo(() => {
    const term = docSearch.trim().toLowerCase();
    if (!term) return dashboardList;
    return dashboardList.filter((doc) => (
      doc.name.toLowerCase().includes(term) ||
      (doc.folderName || '').toLowerCase().includes(term) ||
      (doc.folderPath || '').toLowerCase().includes(term)
    ));
  }, [dashboardList, docSearch]);
  const loadingDocs = dashboardFolderIds.some((id) => loadingFolderDocumentIds.has(id));
  const loadingDashboardFolderCount = dashboardFolderIds.filter((id) => loadingFolderDocumentIds.has(id)).length;
  const failedSelectedFolderDocumentIds = folderTargetMode === 'folder'
    ? []
    : selectedFolders.filter((folder) => failedFolderDocumentIds.has(folder.id)).map((folder) => folder.id);
  const selectedDashboardTargets = useMemo(() => {
    const seen = new Set<string>();
    const targets: FolderDashboard[] = [];
    const add = (doc: FolderDashboard) => {
      if (seen.has(doc.id)) return;
      seen.add(doc.id);
      targets.push(doc);
    };

    selectedDocs.forEach(add);
    if (folderTargetMode !== 'folder') {
      for (const folder of selectedFolders) {
        (documentsByFolder[folder.id] || []).forEach(add);
      }
    }

    return targets;
  }, [documentsByFolder, folderTargetMode, selectedDocs, selectedFolders]);
  const selectedLabelSets = useMemo<LabeledTarget[]>(
    () => [
      ...selectedFolderTargets.map((folder) => ({
        id: folder.id,
        type: 'folder' as const,
        labels: folderLabels[folder.id] ?? extractLabelState(folder).labels,
        available: !unavailableFolderLabelIds.has(folder.id),
      })),
      ...selectedDashboardTargets.map((doc) => ({
        id: doc.id,
        type: 'document' as const,
        labels: documentLabels[doc.id] ?? extractLabelState(doc).labels,
        available: !unavailableDocumentLabelIds.has(doc.id),
      })),
    ],
    [
      documentLabels,
      folderLabels,
      selectedDashboardTargets,
      selectedFolderTargets,
      unavailableDocumentLabelIds,
      unavailableFolderLabelIds,
    ],
  );
  const unavailableSelectedLabelCount = selectedLabelSets.filter((target) => !target.available).length;
  const visibleSelected = filteredDocs.length > 0 && filteredDocs.every((doc) => selectedDocumentsById[doc.id]);
  const selectedTargetCount = selectedFolderTargets.length + selectedDashboardTargets.length;
  const canApply = selectedTargetCount > 0
    && !loadingDocs
    && !bulkRunning
    && !creatingLabel
    && failedSelectedFolderDocumentIds.length === 0
    && unavailableSelectedLabelCount === 0
    && (addLabels.length > 0 || removeLabels.length > 0);
  const selectedTargetSummary = [
    selectedFolderTargets.length > 0
      ? `${selectedFolderTargets.length} folder${selectedFolderTargets.length === 1 ? '' : 's'}`
      : '',
    selectedDashboardTargets.length > 0
      ? `${selectedDashboardTargets.length} document${selectedDashboardTargets.length === 1 ? '' : 's'}`
      : '',
  ].filter(Boolean).join(' and ');
  const bulkPlanIssues = bulkPlan?.issues.filter((issue) => issue.severity === 'error') || [];
  const bulkBlockingCount = bulkPlanIssues.length + (bulkPreview?.issues.length || 0);
  const bulkChangedTargets = bulkPreview?.targets.filter((target) => target.add.length > 0 || target.remove.length > 0).length || 0;
  const bulkNoopTargets = bulkPreview?.targets.length ? bulkPreview.targets.length - bulkChangedTargets : 0;
  const bulkCanApply = Boolean(
    bulkPreview
    && bulkPreview.connectionKey === connectionKey
    && !bulkPreviewConsumed
    && !bulkRunning
    && !applying
    && !creatingLabel
    && bulkBlockingCount === 0,
  );
  const labelWorkflowLocked = applying || bulkRunning || creatingLabel;

  function coverageFor(label: string) {
    if (selectedTargetCount === 0) return { count: 0, total: 0, state: 'none' as const };
    if (unavailableSelectedLabelCount > 0) {
      return { count: 0, total: selectedTargetCount, state: 'unknown' as const };
    }
    const count = selectedLabelSets.filter((target) => hasLabel(target.labels, label)).length;
    if (count === selectedTargetCount) return { count, total: selectedTargetCount, state: 'all' as const };
    if (count > 0) return { count, total: selectedTargetCount, state: 'some' as const };
    return { count, total: selectedTargetCount, state: 'none' as const };
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bulk Label Governance"
        description="Apply governed label changes to folders, documents inside folders, or both. Manual changes use loaded coverage; CSV changes revalidate immediately before writing."
        icon={<Blobby mood="labels" size={58} className="animate-float" style={{ animationDuration: '3.6s' }} />}
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      {mutationReviewNotices.map((notice) => {
        const listedTargets = notice.targets.slice(0, 3).join(', ');
        const additionalTargetCount = Math.max(0, notice.targets.length - 3);
        return (
          <div key={notice.id} role="alert" className="rounded-card border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="font-semibold">Label operation outcome needs review</div>
            <p className="mt-1 text-xs leading-5">
              The {notice.operation} against {notice.instanceLabel} has an outcome OmniKit could not fully confirm.
              {' '}{notice.confirmedWrites} write{notice.confirmedWrites === 1 ? ' was' : 's were'} confirmed.
              {notice.reason === 'instance_changed' ? ' The selected instance changed while the operation was active.' : ''}
              {notice.reason === 'stopped' ? ' The operation was stopped while a request could still have been in flight.' : ''}
              {listedTargets ? ` Review ${listedTargets}${additionalTargetCount ? ` and ${additionalTargetCount} more target${additionalTargetCount === 1 ? '' : 's'}` : ''}.` : ''}
              {' '}Validate the current labels in that instance before retrying.
            </p>
            <button
              type="button"
              onClick={() => setMutationReviewNotices((previous) => previous.filter((entry) => entry.id !== notice.id))}
              className="btn-secondary mt-2 text-xs"
            >
              Dismiss
            </button>
          </div>
        );
      })}

      {loading ? (
        <WorkflowStatusScene
          variant="label-apply"
          title="Loading label governance"
          detail="Collecting labels, folders, and current label coverage before changes can be queued."
          statusLabel="Loading"
          compact
        />
      ) : (
        <>
          <div className="grid md:grid-cols-4 gap-3">
            <div className="card p-4">
              <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Available Labels</div>
              <div className="mt-2 text-2xl font-semibold text-content-primary">{labels.length}</div>
              <p className="mt-1 text-xs text-content-secondary">Pulled from Omni label taxonomy.</p>
            </div>
            <div className="card p-4">
              <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Selected Folders</div>
              <div className="mt-2 text-2xl font-semibold text-content-primary">{selectedFolders.length}</div>
              <p className="mt-1 text-xs text-content-secondary">
                {folderTargetMode === 'documents'
                  ? `${selectedFolders.length} used as document scopes.`
                  : folderTargetMode === 'both'
                    ? 'Folders and their documents are targets.'
                    : 'Folder records are direct targets.'}
              </p>
            </div>
            <div className="card p-4">
              <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Document Targets</div>
              <div className="mt-2 text-2xl font-semibold text-content-primary">{selectedDashboardTargets.length}</div>
              <p className="mt-1 text-xs text-content-secondary">Documents selected directly or through folder scope.</p>
            </div>
            <div className="card p-4">
              <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Queued Changes</div>
              <div className="mt-2 text-2xl font-semibold text-content-primary">{addLabels.length + removeLabels.length}</div>
              <p className="mt-1 text-xs text-content-secondary">{addLabels.length} add, {removeLabels.length} remove.</p>
            </div>
          </div>

          <section className="card p-0 overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                  <Upload size={16} className="text-omni-700" />
                  CSV label import
                </div>
                <p className="mt-1 max-w-3xl text-xs leading-5 text-content-secondary">
                  Use one row per folder or document. Each quoted labels cell can contain multiple comma-separated labels.
                </p>
              </div>
              <button
                type="button"
                onClick={() => downloadCsv(
                  'omnikit-content-label-template.csv',
                  BULK_CONTENT_LABEL_TEMPLATE_ROWS.map((row) => [...row]),
                )}
                disabled={bulkRunning || applying}
                className="btn-secondary text-sm disabled:opacity-40"
              >
                <Download size={14} />
                Download template
              </button>
            </div>

            <div className="grid border-b border-border md:grid-cols-3">
              <div className="border-b border-border px-5 py-3 md:border-b-0 md:border-r">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary">1. Target</div>
                <p className="mt-1 text-xs text-content-primary">Use an exact Omni ID or URL and choose folder or document.</p>
              </div>
              <div className="border-b border-border px-5 py-3 md:border-b-0 md:border-r">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary">2. Preview</div>
                <p className="mt-1 text-xs text-content-primary">Resolve current labels, merge duplicates, and block conflicts before writes.</p>
              </div>
              <div className="px-5 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary">3. Apply</div>
                <p className="mt-1 text-xs text-content-primary">Create missing basic labels, then update each target independently.</p>
              </div>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  disabled={bulkRunning || applying}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleBulkFile(file);
                    event.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={bulkRunning || applying}
                  className="btn-secondary text-sm disabled:opacity-40"
                >
                  <FileText size={14} />
                  Choose CSV
                </button>
                <span className="text-xs text-content-secondary">{bulkFileName || 'No file selected. You can also paste CSV below.'}</span>
              </div>

              <textarea
                value={bulkCsvText}
                disabled={bulkRunning || applying}
                onChange={(event) => {
                  setBulkFileName('');
                  clearBulkAnalysis(event.target.value);
                }}
                className="input-field min-h-32 resize-y font-mono text-xs leading-5 disabled:opacity-60"
                spellCheck={false}
                placeholder={'action,target_type,target_id_or_url,labels\nadd,folder,00000000-0000-4000-8000-000000000001,"Finance, Executive"\nremove,document,https://example.omniapp.co/dashboards/example-id,Legacy'}
              />

              <div className="rounded-card border border-border bg-surface-secondary px-4 py-3 text-xs leading-5 text-content-secondary">
                <div className="font-semibold text-content-primary">Four exact columns: action, target_type, target_id_or_url, labels</div>
                <p className="mt-1">
                  Action is add or remove. Target type is folder or document. Quote the entire labels cell when it contains a list. {BULK_CONTENT_LABELS_CELL_FORMAT} Values are trimmed and deduplicated case-insensitively.
                </p>
                <p className="mt-1">
                  Compatible duplicate rows are merged, while adding and removing the same label from one resolved target is blocked. Blank CSV lines are rejected so every preview and result keeps its exact source line.
                </p>
                <p className="mt-1">
                  A folder label applies only to the folder. It does not cascade to documents inside it. Missing labels are created as ordinary labels during the confirmed run; Verified and Homepage behavior is never inferred from the CSV.
                </p>
              </div>

              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex max-w-3xl items-start gap-2 text-xs text-content-secondary">
                  <ShieldCheck size={15} className="mt-0.5 shrink-0 text-green-700" />
                  <span>
                    Validation makes no changes and binds the preview to <span className="font-semibold text-content-primary">{selectedInstanceLabel}</span>.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void analyzeBulkCsv()}
                  disabled={!bulkCsvText.trim() || bulkValidating || bulkRunning || applying}
                  className="btn-primary text-sm disabled:opacity-40"
                >
                  {bulkValidating ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  {bulkValidating ? 'Checking Omni...' : bulkPreviewConsumed ? 'Validate fresh preview' : 'Validate import'}
                </button>
              </div>

              {bulkError && (
                <div className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{bulkError}</div>
              )}

              {bulkValidating && (
                <WorkflowStatusScene
                  variant="label-apply"
                  title="Validating label import"
                  detail={`Resolving folders, documents, and current labels in ${selectedInstanceLabel}.`}
                  statusLabel="Preflight"
                  compact
                />
              )}

              {bulkPlan && (
                <div className="rounded-card border border-border overflow-hidden">
                  <div className="flex flex-col gap-3 border-b border-border bg-surface-secondary px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-semibold text-content-primary">CSV preflight</div>
                      <div className="mt-0.5 text-xs text-content-secondary">
                        {bulkPreview ? `Checked against ${bulkPreview.instanceLabel}.` : 'Local CSV checks complete.'}
                      </div>
                    </div>
                    <span className={`rounded-chip px-3 py-1 text-xs font-semibold ${
                      bulkBlockingCount > 0
                        ? 'bg-red-100 text-red-800'
                        : bulkPreview
                          ? bulkPreviewConsumed
                            ? 'bg-gray-100 text-gray-700'
                            : 'bg-green-100 text-green-800'
                          : 'bg-gray-100 text-gray-700'
                    }`}>
                      {bulkBlockingCount > 0 ? `${bulkBlockingCount} blocking` : bulkPreviewConsumed ? 'Consumed' : bulkPreview ? 'Ready' : 'Needs Omni check'}
                    </span>
                  </div>

                  <div className="grid border-b border-border sm:grid-cols-2 lg:grid-cols-5">
                    {[
                      ['Source rows', bulkPlan.summary.sourceRows],
                      ['Resolved targets', bulkPreview?.targets.length || 0],
                      ['Targets changing', bulkChangedTargets],
                      ['No-op targets', bulkNoopTargets],
                      ['Labels to create', bulkPreview?.missingLabels.length || 0],
                    ].map(([label, value]) => (
                      <div key={label} className="border-b border-border px-4 py-3 last:border-b-0 sm:border-r lg:border-b-0">
                        <div className="text-[10px] uppercase tracking-wider text-content-secondary">{label}</div>
                        <div className="mt-1 text-lg font-semibold text-content-primary">{value}</div>
                      </div>
                    ))}
                  </div>

                  {(bulkPlanIssues.length > 0 || (bulkPreview?.issues.length || 0) > 0) && (
                    <div className="border-b border-red-200 bg-red-50 px-4 py-3">
                      <div className="text-xs font-semibold uppercase tracking-wider text-red-800">Blocking issues</div>
                      <div className="mt-2 max-h-36 space-y-1 overflow-y-auto text-xs text-red-700">
                        {[
                          ...bulkPlanIssues.map((issue) => ({
                            message: issue.message,
                            rowNumbers: issue.rowNumbers || (issue.rowNumber ? [issue.rowNumber] : undefined),
                          })),
                          ...(bulkPreview?.issues || []),
                        ].slice(0, 50).map((issue, index) => (
                          <div key={`${issue.message}-${index}`}>
                            {issue.rowNumbers?.length ? `Row${issue.rowNumbers.length === 1 ? '' : 's'} ${issue.rowNumbers.join(', ')}: ` : ''}{issue.message}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {bulkPreview && bulkPreview.targets.length > 0 && (
                    <div className="max-h-80 divide-y divide-border/50 overflow-y-auto">
                      {bulkPreview.targets.slice(0, 100).map((target) => (
                        <div key={target.key} className="px-4 py-3 text-xs">
                          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <span className="font-semibold capitalize text-content-primary">{target.type}</span>
                              <span className="ml-2 font-medium text-content-primary">{target.name}</span>
                              <span className="ml-2 text-content-secondary">Rows {target.rowNumbers.join(', ')}</span>
                            </div>
                            <span className="truncate font-mono text-[10px] text-content-secondary">{target.id}</span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {target.add.map((label) => <span key={`add-${label}`} className="rounded-chip bg-green-100 px-2 py-0.5 text-green-800">+ {label}</span>)}
                            {target.remove.map((label) => <span key={`remove-${label}`} className="rounded-chip bg-red-100 px-2 py-0.5 text-red-800">− {label}</span>)}
                            {target.noops.map((label) => <span key={`noop-${label}`} className="rounded-chip bg-gray-100 px-2 py-0.5 text-gray-700">{label}</span>)}
                          </div>
                        </div>
                      ))}
                      {bulkPreview.targets.length > 100 && (
                        <div className="px-4 py-3 text-xs text-content-secondary">Showing the first 100 of {bulkPreview.targets.length} resolved targets.</div>
                      )}
                    </div>
                  )}

                  <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-xs text-content-secondary">
                      {bulkPreview?.missingLabels.length
                        ? `Missing basic labels to create: ${bulkPreview.missingLabels.join(', ')}`
                        : bulkPreview
                          ? 'All referenced labels already exist or are removal no-ops.'
                          : 'Validate against Omni before changes can run.'}
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowBulkConfirm(true)}
                      disabled={!bulkCanApply || bulkChangedTargets === 0}
                      className="btn-primary shrink-0 text-sm disabled:opacity-40"
                    >
                      <Tag size={14} />
                      Apply CSV changes
                    </button>
                  </div>
                </div>
              )}

              {bulkRunning && (
                <div className="space-y-3">
                  <WorkflowStatusScene
                    variant="label-apply"
                    title="Applying CSV label changes"
                    detail={`Creating missing labels first, then updating each resolved target in ${selectedInstanceLabel}.`}
                    statusLabel="Applying"
                    progressLabel={bulkProgress ? `${bulkProgress.completed}/${bulkProgress.total} operations complete` : undefined}
                    compact
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => bulkValidationAbortRef.current?.abort()}
                      className="btn-secondary text-xs"
                    >
                      Stop operation
                    </button>
                  </div>
                </div>
              )}

              {bulkResults.length > 0 && (
                <div className="rounded-card border border-border overflow-hidden">
                  <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-secondary px-4 py-3">
                    <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">CSV results</div>
                    <button
                      type="button"
                      onClick={() => downloadCsv('omnikit-content-label-results.csv', bulkResultRows(selectedInstanceLabel, bulkResults))}
                      className="btn-secondary text-xs"
                    >
                      <Download size={13} />
                      Export results
                    </button>
                  </div>
                  <div className="max-h-52 divide-y divide-border/50 overflow-y-auto">
                    {bulkResults.slice(0, 100).map((result, index) => (
                      <div key={`${result.stage}-${result.target}-${index}`} className="flex items-start gap-2 px-4 py-2 text-xs">
                        {result.status === 'success' ? (
                          <CheckCircle size={14} className="mt-0.5 shrink-0 text-success" />
                        ) : result.status === 'failed' ? (
                          <AlertCircle size={14} className="mt-0.5 shrink-0 text-error" />
                        ) : (
                          <MinusCircle size={14} className="mt-0.5 shrink-0 text-content-secondary" />
                        )}
                        <div>
                          <div className="font-medium capitalize text-content-primary">{result.stage}: {result.target}</div>
                          <div className="text-content-secondary">{result.rowNumbers.length ? `Rows ${result.rowNumbers.join(', ')} · ` : ''}{result.message}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          <div className="grid items-stretch gap-5 xl:grid-cols-[minmax(300px,0.85fr)_minmax(0,1fr)] 2xl:grid-cols-[minmax(300px,0.82fr)_minmax(0,1.02fr)_minmax(440px,1.12fr)]">
            <div className="card flex max-h-[860px] min-h-[660px] flex-col p-0 overflow-hidden">
              <div className="p-4 border-b border-border">
                <h3 className="text-sm font-semibold text-content-primary flex items-center gap-2">
                  <Folder size={16} className="text-omni-700" />
                  Folders
                </h3>
                <p className="mt-1 text-xs text-content-secondary leading-5">
                  Choose exactly what selecting a folder means. Folder labels do not automatically cascade to documents.
                </p>
                <label className="mt-3 block text-[10px] font-semibold uppercase tracking-wider text-content-secondary">
                  Selected folders target
                  <select
                    value={folderTargetMode}
                    disabled={labelWorkflowLocked}
                    onChange={(event) => {
                      setFolderTargetMode(event.target.value as FolderTargetMode);
                      setApplyResults([]);
                    }}
                    className="input-field mt-1 text-xs normal-case tracking-normal"
                  >
                    <option value="documents">Documents inside each folder</option>
                    <option value="folder">The folder itself</option>
                    <option value="both">The folder and its documents</option>
                  </select>
                </label>
                <div className="mt-3">
                  <SearchInput value={folderSearch} onChange={setFolderSearch} placeholder="Search folders or labels..." />
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-border/50">
                {flatFolders.length === 0 ? (
                  <div className="py-12 px-4 text-center text-sm text-content-secondary">
                    No folders were returned from Omni.
                  </div>
                ) : filteredFolders.length === 0 ? (
                  <div className="py-12 px-4 text-center text-sm text-content-secondary">
                    No folders match this search.
                  </div>
                ) : (
                  filteredFolders.map((folder) => {
                    const isSelected = selectedFolderIds.has(folder.id);
                    const isActive = activeFolderId === folder.id;
                    const labelsForFolder = folderLabels[folder.id] ?? extractLabelState(folder).labels;
                    const folderLabelsAvailable = !unavailableFolderLabelIds.has(folder.id);
                    return (
                      <div key={folder.id} className={`px-3 py-2.5 transition-all ${isSelected ? selectedTreeRowClass : isActive ? 'border-l-4 border-l-omni-300 bg-surface-secondary' : unselectedTreeRowClass}`}>
                        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 items-start" style={{ paddingLeft: `${folder.depth * 14}px` }}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={labelWorkflowLocked}
                            onChange={() => toggleFolder(folder.id)}
                            className="mt-1 accent-omni-700"
                            aria-label={`Select folder ${folder.name}`}
                          />
                          <button
                            type="button"
                            disabled={labelWorkflowLocked}
                            onClick={() => toggleFolder(folder.id)}
                            className="min-w-0 text-left disabled:cursor-not-allowed disabled:opacity-60"
                            aria-label={`${isSelected ? 'Deselect' : 'Select'} folder ${folder.name}`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {isActive ? (
                                <FolderOpen size={15} className="text-omni-700 flex-shrink-0" />
                              ) : (
                                <Folder size={15} className="text-content-secondary flex-shrink-0" />
                              )}
                              <span className="text-sm font-medium text-content-primary truncate">{folder.name}</span>
                              {isSelected && (
                                <span className="rounded-chip bg-white border border-omni-200 px-2 py-0.5 text-[10px] text-omni-800">
                                  {folderTargetMode === 'folder' ? 'folder target' : folderTargetMode === 'both' ? 'folder + documents' : 'document scope'}
                                </span>
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {!folderLabelsAvailable ? (
                                <span className="text-[10px] text-amber-700">Folder labels unavailable</span>
                              ) : labelsForFolder.length > 0 ? (
                                labelsForFolder.map((label) => (
                                  <span key={label} className="rounded-chip bg-white border border-border px-2 py-0.5 text-[10px] text-content-secondary">
                                    {label}
                                  </span>
                                ))
                              ) : (
                                <span className="text-[10px] text-content-secondary">No folder labels found</span>
                              )}
                            </div>
                          </button>
                          <button
                            type="button"
                            disabled={labelWorkflowLocked}
                            onClick={() => loadFolderDocuments(folder.id)}
                            className="mt-0.5 rounded-button border border-border bg-white px-2 py-1 text-[10px] font-medium text-content-secondary transition-colors hover:border-omni-300 hover:text-omni-700 disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={`Browse documents in ${folder.name}`}
                          >
                            Browse
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="card flex max-h-[860px] min-h-[660px] flex-col p-0 overflow-hidden">
              <div className="p-4 border-b border-border space-y-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-content-primary flex items-center gap-2">
                      <LayoutDashboard size={16} className="text-omni-700" />
                      Documents
                      {dashboardFolderIds.length > 0 ? (
                        <span className="text-content-secondary font-normal">
                          from {dashboardFolderIds.length} folder scope{dashboardFolderIds.length === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </h3>
                    <p className="mt-1 text-xs text-content-secondary leading-5">
                      Select documents across any selected or browsed folder. Chosen documents stay selected when you browse another folder.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={toggleAllVisible}
                    disabled={filteredDocs.length === 0 || labelWorkflowLocked}
                    className="btn-secondary text-sm whitespace-nowrap"
                  >
                    <CheckSquare size={14} />
                    {visibleSelected ? 'Clear visible' : `Select visible (${filteredDocs.length})`}
                  </button>
                </div>
                <SearchInput value={docSearch} onChange={setDocSearch} placeholder="Search documents or folder names..." />
              </div>

              {loadingDocs ? (
                <div className="min-h-0 flex-1 p-4">
                  <WorkflowStatusScene
                    variant="label-apply"
                    title="Loading folder documents"
                    detail={`Pulling documents for ${loadingDashboardFolderCount} folder${loadingDashboardFolderCount === 1 ? '' : 's'}.`}
                    statusLabel="Loading"
                    compact
                  />
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-border/50">
                  {dashboardFolderIds.length === 0 ? (
                    <div className="py-12 px-4 text-center text-sm text-content-secondary">
                      Select one or more folders to show all documents from those folders.
                    </div>
                  ) : filteredDocs.length === 0 ? (
                    <div className="py-12 px-4 text-center text-sm text-content-secondary">
                      No documents found for the selected folder scope.
                    </div>
                  ) : (
                    filteredDocs.map((doc) => {
                      const isSelected = Boolean(selectedDocumentsById[doc.id]);
                      const labelsForDoc = documentLabels[doc.id] ?? extractLabelState(doc).labels;
                      const documentLabelsAvailable = !unavailableDocumentLabelIds.has(doc.id);
                      return (
                        <label
                          key={doc.id}
                          className={`block px-4 py-3 cursor-pointer transition-all ${
                            isSelected ? selectedRowClass : unselectedRowClass
                          }`}
                        >
                          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 items-start">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              disabled={labelWorkflowLocked}
                              onChange={() => toggleDoc(doc)}
                              className="mt-1 accent-omni-700"
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 min-w-0">
                                <LayoutDashboard size={14} className="text-content-secondary flex-shrink-0" />
                                <span className="text-sm font-medium text-content-primary truncate">{doc.name}</span>
                                {isSelected && (
                                  <span className={selectedBadgeClass}>
                                    <CheckCircle size={12} />
                                    Selected
                                  </span>
                                )}
                              </div>
                              {doc.folderName && (
                                <div className="mt-0.5 text-[10px] text-content-secondary truncate">
                                  Folder: <span className="font-medium text-content-primary">{doc.folderName}</span>
                                </div>
                              )}
                              <div className="mt-1 flex flex-wrap gap-1">
                                {!documentLabelsAvailable ? (
                                  <span className="text-[10px] text-amber-700">Document labels unavailable</span>
                                ) : labelsForDoc.length > 0 ? (
                                  labelsForDoc.map((label) => (
                                    <span key={label} className="rounded-chip bg-white border border-border px-2 py-0.5 text-[10px] text-content-secondary">
                                      {label}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-[10px] text-content-secondary">No document labels found</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            <div className="card max-h-[860px] min-h-[660px] space-y-5 overflow-y-auto xl:col-span-2 2xl:col-span-1">
              <div>
                <h3 className="text-base font-semibold text-content-primary flex items-center gap-2">
                  <Tag size={16} className="text-omni-700" />
                  Multi-apply labels
                </h3>
                <p className="mt-1 text-xs text-content-secondary leading-5">
                  Coverage is calculated across every direct folder and document target, so OmniKit skips labels that are already correct.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-card border border-border bg-surface-secondary p-3">
                  <div className="text-[10px] font-semibold text-content-secondary uppercase tracking-wider">Folder Targets</div>
                  <div className="mt-1 text-lg font-semibold text-content-primary">{selectedFolderTargets.length}</div>
                </div>
                <div className="rounded-card border border-border bg-surface-secondary p-3">
                  <div className="text-[10px] font-semibold text-content-secondary uppercase tracking-wider">Document Targets</div>
                  <div className="mt-1 text-lg font-semibold text-content-primary">{selectedDashboardTargets.length}</div>
                </div>
              </div>

              {unavailableSelectedLabelCount > 0 && (
                <div role="status" className="flex items-start gap-2 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                  <span>
                    Current labels are unavailable for {unavailableSelectedLabelCount} selected target{unavailableSelectedLabelCount === 1 ? '' : 's'}.
                    OmniKit will not apply changes until the label inventory can be loaded safely.
                  </span>
                </div>
              )}

              {failedSelectedFolderDocumentIds.length > 0 && (
                <div role="status" className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                    <span>
                      OmniKit could not load the document inventory for {failedSelectedFolderDocumentIds.length} selected folder{failedSelectedFolderDocumentIds.length === 1 ? '' : 's'}.
                      No folder-scoped document changes can run until that inventory is complete.
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={applying || bulkRunning}
                    onClick={() => {
                      for (const folderId of failedSelectedFolderDocumentIds) {
                        void loadFolderDocuments(folderId, { makeActive: false });
                      }
                    }}
                    className="btn-secondary mt-2 text-xs disabled:opacity-40"
                  >
                    Retry document inventory
                  </button>
                </div>
              )}

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleCreateLabel();
                }}
                className="rounded-card border border-border bg-surface-secondary p-3"
              >
                <label className="block text-xs font-semibold text-content-primary">Create or queue a label</label>
                <p className="mt-1 text-xs text-content-secondary leading-5">
                  Add a new Omni label, then automatically queue it for the currently selected folder and document targets.
                </p>
                <div className="mt-3 flex gap-2">
                  <input
                    value={newLabelName}
                    disabled={labelWorkflowLocked}
                    onChange={(event) => setNewLabelName(event.target.value)}
                    className="input-field text-sm disabled:opacity-60"
                    placeholder="e.g. Executive Ready"
                  />
                  <button
                    type="submit"
                    disabled={creatingLabel || labelWorkflowLocked || !newLabelName.trim()}
                    className="btn-secondary text-sm whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {creatingLabel ? <Loader2 size={14} className="animate-spin" /> : <PlusCircle size={14} />}
                    Add
                  </button>
                </div>
              </form>

              {selectedTargetCount === 0 ? (
                <div className="rounded-card border border-border bg-surface-secondary p-4 text-sm text-content-secondary">
                  Select folders, documents, or both to see current label coverage.
                </div>
              ) : labels.length === 0 ? (
                <div className="rounded-card border border-border bg-surface-secondary p-4 text-sm text-content-secondary">
                  No organization labels were returned from Omni.
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-content-secondary uppercase tracking-wider mb-2">Add labels</label>
                    <div className="max-h-40 overflow-y-auto pr-1 flex flex-wrap gap-1.5">
                      {labels.map((label) => {
                        const name = labelName(label);
                        const coverage = coverageFor(name);
                        const alreadyEverywhere = coverage.state === 'all';
                        const coverageUnknown = coverage.state === 'unknown';
                        return (
                          <button
                            key={`add-${name}`}
                            type="button"
                            disabled={labelWorkflowLocked || alreadyEverywhere || coverageUnknown}
                            onClick={() => toggleAddLabel(name)}
                            className={`px-2.5 py-1 rounded-chip text-xs font-medium transition-colors border ${
                              addLabels.includes(name)
                                ? 'bg-green-100 border-green-300 text-green-800'
                                : alreadyEverywhere || coverageUnknown
                                ? 'bg-gray-50 border-border text-content-tertiary cursor-not-allowed'
                                : 'bg-white border-border text-content-secondary hover:border-green-300'
                            }`}
                            title={coverageUnknown
                              ? 'Current label coverage is unavailable. Refresh before applying changes.'
                              : alreadyEverywhere
                                ? 'Already applied to every selected target'
                                : `${coverage.count}/${coverage.total} selected targets already have this label`}
                          >
                            <PlusCircle size={11} className="inline mr-1" />
                            {name}
                            {coverage.total > 0 && <span className="ml-1 opacity-60">{coverage.count}/{coverage.total}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-content-secondary uppercase tracking-wider mb-2">Remove labels</label>
                    <div className="max-h-40 overflow-y-auto pr-1 flex flex-wrap gap-1.5">
                      {labels.map((label) => {
                        const name = labelName(label);
                        const coverage = coverageFor(name);
                        const absentEverywhere = coverage.state === 'none';
                        const coverageUnknown = coverage.state === 'unknown';
                        return (
                          <button
                            key={`remove-${name}`}
                            type="button"
                            disabled={labelWorkflowLocked || absentEverywhere || coverageUnknown}
                            onClick={() => toggleRemoveLabel(name)}
                            className={`px-2.5 py-1 rounded-chip text-xs font-medium transition-colors border ${
                              removeLabels.includes(name)
                                ? 'bg-red-100 border-red-300 text-red-800'
                                : absentEverywhere || coverageUnknown
                                ? 'bg-gray-50 border-border text-content-tertiary cursor-not-allowed'
                                : 'bg-white border-border text-content-secondary hover:border-red-300'
                            }`}
                            title={coverageUnknown
                              ? 'Current label coverage is unavailable. Refresh before applying changes.'
                              : absentEverywhere
                                ? 'None of the selected targets have this label'
                                : `${coverage.count}/${coverage.total} selected targets have this label`}
                          >
                            <MinusCircle size={11} className="inline mr-1" />
                            {name}
                            {coverage.total > 0 && <span className="ml-1 opacity-60">{coverage.count}/{coverage.total}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {applying && (
                <WorkflowStatusScene
                  variant="label-apply"
                  title="Applying label changes"
                  detail="Updating folders and documents sequentially to avoid API bursts."
                  statusLabel="Applying"
                  progressLabel={applyProgress ? `${applyProgress.completed}/${applyProgress.total} targets complete` : undefined}
                  compact
                />
              )}

              <button
                type="button"
                onClick={() => setShowApplyConfirm(true)}
                disabled={applying || !canApply}
                className="btn-primary text-sm w-full justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {applying ? <Loader2 size={14} className="animate-spin" /> : <Tag size={14} />}
                Apply to {selectedTargetCount || 0} target{selectedTargetCount === 1 ? '' : 's'}
              </button>

              {applyResults.length > 0 && (
                <div className="rounded-card border border-border overflow-hidden">
                  <div className="px-3 py-2 bg-surface-secondary text-xs font-semibold text-content-secondary uppercase tracking-wider">
                    Results
                  </div>
                  <div className="max-h-52 overflow-y-auto divide-y divide-border/50">
                    {applyResults.map((result) => (
                      <div key={`${result.type}-${result.id}`} className="px-3 py-2 flex items-start gap-2 text-xs">
                        {result.status === 'success' ? (
                          <CheckCircle size={14} className="text-success mt-0.5 flex-shrink-0" />
                        ) : result.status === 'failed' ? (
                          <AlertCircle size={14} className="text-error mt-0.5 flex-shrink-0" />
                        ) : (
                          <MinusCircle size={14} className="text-content-secondary mt-0.5 flex-shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="font-medium text-content-primary truncate">
                            {result.type === 'folder' ? 'Folder' : 'Document'}: {result.name}
                          </div>
                          <div className="text-content-secondary">{result.detail}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <ConfirmDialog
            open={showApplyConfirm}
            title="Apply label changes?"
            message={`OmniKit will update ${selectedTargetSummary || 'the selected targets'} in ${connection.instanceLabel || connection.baseUrl}. Folder labels do not cascade to their documents.`}
            confirmLabel="Apply labels"
            itemCount={selectedTargetCount}
            onConfirm={() => void handleApply()}
            onCancel={() => setShowApplyConfirm(false)}
          />
          <ConfirmDialog
            open={showBulkConfirm}
            title="Apply CSV label changes?"
            message={`OmniKit will create ${bulkPreview?.missingLabels.length || 0} missing basic label${bulkPreview?.missingLabels.length === 1 ? '' : 's'} and update ${bulkChangedTargets} folder or document target${bulkChangedTargets === 1 ? '' : 's'} in ${selectedInstanceLabel}. Each target is an independent API operation; no cross-target rollback is promised.`}
            confirmLabel="Apply CSV changes"
            itemCount={bulkChangedTargets}
            onConfirm={() => void executeBulkLabels()}
            onCancel={() => setShowBulkConfirm(false)}
          />
        </>
      )}
    </div>
  );
}
