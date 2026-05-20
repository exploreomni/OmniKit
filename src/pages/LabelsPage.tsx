import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  CheckSquare,
  Folder,
  FolderOpen,
  LayoutDashboard,
  Loader2,
  MinusCircle,
  PlusCircle,
  Tag,
} from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { useLogOperation } from '@/contexts/OperationLogContext';
import { omniProxy, listFolders, listDocuments } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { SearchInput } from '@/components/ui/SearchInput';
import {
  selectedBadgeClass,
  selectedRowClass,
  selectedTreeRowClass,
  unselectedRowClass,
  unselectedTreeRowClass,
} from '@/components/ui/selectionStyles';
import { friendlyApiError } from '@/utils/apiErrors';
import type { OmniLabel, OmniFolder, OmniDocument } from '@/types';

type LabelApplyResult = {
  id: string;
  name: string;
  type: 'folder' | 'dashboard';
  status: 'success' | 'skipped' | 'failed';
  detail: string;
};

type LabeledTarget = {
  id: string;
  type: 'folder' | 'dashboard';
  labels: string[];
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

function normalize(value: string): string {
  return value.trim().toLowerCase();
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
    return uniqueLabels(
      labels
        .map((label) => (typeof label === 'string' ? label : (label as { name?: string })?.name))
        .filter((label): label is string => Boolean(label)),
    );
  }

  return [];
}

function hasLabel(labels: string[], name: string): boolean {
  const target = normalize(name);
  return labels.some((label) => normalize(label) === target);
}

function mergeLabelChanges(current: string[], add: string[], remove: string[]): string[] {
  const removed = new Set(remove.map(normalize));
  const kept = current.filter((label) => !removed.has(normalize(label)));
  return uniqueLabels([...kept, ...add]);
}

function seedLabelsFromFolders(folders: OmniFolder[]): Record<string, string[]> {
  const seed: Record<string, string[]> = {};
  for (const folder of flattenFolders(folders)) {
    const labels = extractLabels(folder);
    if (labels.length > 0) seed[folder.id] = labels;
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
  const name = doc.name || raw.title || raw.displayTitle || nested?.name || nested?.title || nested?.displayTitle || 'Untitled dashboard';
  const labels = extractLabels(doc).length > 0 ? doc.labels : nested?.labels;

  return {
    ...doc,
    id,
    name,
    labels,
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

export function LabelsPage() {
  const { connection } = useConnection();
  const logOp = useLogOperation();
  const [labels, setLabels] = useState<OmniLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [folders, setFolders] = useState<OmniFolder[]>([]);
  const [folderLabels, setFolderLabels] = useState<Record<string, string[]>>({});
  const [activeFolderId, setActiveFolderId] = useState('');
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [folderSearch, setFolderSearch] = useState('');

  const [documentsByFolder, setDocumentsByFolder] = useState<Record<string, FolderDashboard[]>>({});
  const [docSearch, setDocSearch] = useState('');
  const [selectedDocumentsById, setSelectedDocumentsById] = useState<Record<string, FolderDashboard>>({});
  const [documentLabels, setDocumentLabels] = useState<Record<string, string[]>>({});
  const [loadingLabelIds, setLoadingLabelIds] = useState<Set<string>>(new Set());
  const [loadingFolderDocumentIds, setLoadingFolderDocumentIds] = useState<Set<string>>(new Set());

  const [addLabels, setAddLabels] = useState<string[]>([]);
  const [removeLabels, setRemoveLabels] = useState<string[]>([]);
  const [newLabelName, setNewLabelName] = useState('');
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResults, setApplyResults] = useState<LabelApplyResult[]>([]);

  const flatFolders = useMemo(() => flattenFolders(folders), [folders]);
  const foldersById = useMemo(() => new Map(flatFolders.map((folder) => [folder.id, folder])), [flatFolders]);
  const selectedFolders = useMemo(
    () => flatFolders.filter((folder) => selectedFolderIds.has(folder.id)),
    [flatFolders, selectedFolderIds],
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
    async function load() {
      setLoading(true);
      setError('');
      try {
        const [labelsRes, foldersRes] = await Promise.all([
          omniProxy<{ records?: OmniLabel[]; labels?: OmniLabel[] }>(connection.baseUrl, connection.apiKey, 'GET', '/v1/labels'),
          listFolders(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 }),
        ]);

        const nextFolders = Array.isArray(foldersRes.folders) ? foldersRes.folders : [];
        const nextLabels = labelsRes.records || labelsRes.labels || [];
        const nextFolderLabels = seedLabelsFromFolders(nextFolders);

        try {
          const folderDetails = await omniProxy<{ records?: OmniFolder[]; folders?: OmniFolder[] }>(
            connection.baseUrl,
            connection.apiKey,
            'GET',
            '/v1/folders',
            { queryParams: { include: 'labels', pageSize: '1000' } },
          );
          const detailedFolders = folderDetails.records || folderDetails.folders || [];
          for (const folder of detailedFolders) {
            const labelsFromDetail = extractLabels(folder);
            if (labelsFromDetail.length > 0) nextFolderLabels[folder.id] = labelsFromDetail;
          }
        } catch {
          // Folder hierarchy from the edge function is still enough to run the workflow.
        }

        setLabels(nextLabels);
        setFolders(nextFolders);
        setFolderLabels(nextFolderLabels);
      } catch (err) {
        setError(friendlyApiError(err, 'Failed to load labels'));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [connection.baseUrl, connection.apiKey]);

  const fetchFolderDocuments = useCallback(async (folder: OmniFolder): Promise<FolderDashboard[]> => {
    const res = await listDocuments(connection.baseUrl, connection.apiKey, folder.id, { allPages: true, pageSize: 100 });
    const docs = extractDocuments(res);
    return docs.map((doc) => normalizeFolderDocument(doc, folder)).filter((doc) => Boolean(doc.id));
  }, [connection.baseUrl, connection.apiKey]);

  const fetchDocumentLabels = useCallback(async (docId: string): Promise<string[]> => {
    try {
      const detail = await omniProxy<Record<string, unknown>>(
        connection.baseUrl,
        connection.apiKey,
        'GET',
        `/v1/documents/${docId}`,
      );
      return extractLabels(detail);
    } catch {
      return [];
    }
  }, [connection.baseUrl, connection.apiKey]);

  const loadFolderDocuments = useCallback(async (folderId: string, options?: { makeActive?: boolean }) => {
    const folder = foldersById.get(folderId);
    if (options?.makeActive !== false) {
      setActiveFolderId(folderId);
      setDocSearch('');
    }
    setApplyResults([]);
    if (!folderId || !folder) return;
    if (documentsByFolder[folderId]) return;

    setLoadingFolderDocumentIds((prev) => new Set([...prev, folderId]));
    try {
      const nextDocs = await fetchFolderDocuments(folder);
      setDocumentsByFolder((prev) => ({ ...prev, [folderId]: nextDocs }));
      const labelSeed: Record<string, string[]> = {};
      for (const doc of nextDocs) {
        const labelsFromList = extractLabels(doc);
        if (labelsFromList.length > 0) labelSeed[doc.id] = labelsFromList;
      }
      setDocumentLabels((prev) => ({ ...prev, ...labelSeed }));
      for (const doc of nextDocs) {
        if (labelSeed[doc.id]) continue;
        const labelsForDoc = await fetchDocumentLabels(doc.id);
        setDocumentLabels((prev) => ({ ...prev, [doc.id]: labelsForDoc }));
      }
    } catch (err) {
      setDocumentsByFolder((prev) => ({ ...prev, [folderId]: [] }));
      setError(friendlyApiError(err, 'Failed to load folder dashboards'));
    } finally {
      setLoadingFolderDocumentIds((prev) => {
        const next = new Set(prev);
        next.delete(folderId);
        return next;
      });
    }
  }, [documentsByFolder, fetchDocumentLabels, fetchFolderDocuments, foldersById]);

  async function ensureDocumentLabels(ids: string[]) {
    const missing = ids.filter((id) => !documentLabels[id] && !loadingLabelIds.has(id));
    if (missing.length === 0) return;

    setLoadingLabelIds((prev) => new Set([...prev, ...missing]));
    for (const id of missing) {
      const labelsForDoc = await fetchDocumentLabels(id);
      setDocumentLabels((prev) => ({ ...prev, [id]: labelsForDoc }));
      setLoadingLabelIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function toggleFolder(folderId: string) {
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
    if (selecting) {
      void loadFolderDocuments(folderId, { makeActive: !activeFolderId });
    }
  }

  function toggleDoc(doc: FolderDashboard) {
    setApplyResults([]);
    setSelectedDocumentsById((prev) => {
      const next = { ...prev };
      if (next[doc.id]) {
        delete next[doc.id];
      } else {
        next[doc.id] = doc;
        ensureDocumentLabels([doc.id]);
      }
      return next;
    });
  }

  function toggleAllVisible() {
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
      ensureDocumentLabels(visibleIds);
    }
  }

  function toggleAddLabel(name: string) {
    setApplyResults([]);
    setAddLabels((prev) => (prev.includes(name) ? prev.filter((label) => label !== name) : [...prev, name]));
    setRemoveLabels((prev) => prev.filter((label) => label !== name));
  }

  function toggleRemoveLabel(name: string) {
    setApplyResults([]);
    setRemoveLabels((prev) => (prev.includes(name) ? prev.filter((label) => label !== name) : [...prev, name]));
    setAddLabels((prev) => prev.filter((label) => label !== name));
  }

  async function handleCreateLabel() {
    const name = newLabelName.trim();
    if (!name || creatingLabel) return;
    const existing = labels.find((label) => normalize(labelName(label)) === normalize(name));
    if (existing) {
      setNewLabelName('');
      toggleAddLabel(labelName(existing));
      return;
    }

    setCreatingLabel(true);
    setError('');
    try {
      const response = await omniProxy<LabelCreateResponse | undefined>(
        connection.baseUrl,
        connection.apiKey,
        'POST',
        '/v1/labels',
        { body: { name } },
      );
      const created = labelFromCreateResponse(response, name);
      setLabels((prev) => [...prev, created].sort((a, b) => labelName(a).localeCompare(labelName(b))));
      setNewLabelName('');
      setAddLabels((prev) => (prev.some((label) => normalize(label) === normalize(created.name)) ? prev : [...prev, created.name]));
      setRemoveLabels((prev) => prev.filter((label) => normalize(label) !== normalize(created.name)));
    } catch (err) {
      setError(friendlyApiError(err, 'Failed to create label'));
    } finally {
      setCreatingLabel(false);
    }
  }

  async function patchDocumentLabels(docId: string, add: string[], remove: string[], current: string[]) {
    const nextLabels = mergeLabelChanges(current, add, remove);
    let firstError: unknown;

    try {
      for (const label of add) {
        await omniProxy(connection.baseUrl, connection.apiKey, 'PUT', `/v1/documents/${docId}/labels/${encodeURIComponent(label)}`);
      }
      for (const label of remove) {
        await omniProxy(connection.baseUrl, connection.apiKey, 'DELETE', `/v1/documents/${docId}/labels/${encodeURIComponent(label)}`);
      }
      return { labels: nextLabels };
    } catch (endpointError) {
      firstError = endpointError;
    }

    try {
      const response = await omniProxy<LabelMutationResponse | undefined>(
        connection.baseUrl,
        connection.apiKey,
        'PATCH',
        `/v1/documents/${docId}/labels`,
        { body: { add, remove } },
      );
      return response?.labels ? response : { labels: nextLabels };
    } catch {
      throw firstError;
    }
  }

  async function handleApply() {
    if (selectedDashboardTargets.length === 0 || (addLabels.length === 0 && removeLabels.length === 0)) return;

    setApplying(true);
    setApplyResults([]);
    const start = Date.now();
    const results: LabelApplyResult[] = [];

    for (const folder of selectedFolders) {
      const scopedCount = (documentsByFolder[folder.id] || []).length;
      results.push({
        id: folder.id,
        name: folder.name,
        type: 'folder',
        status: scopedCount > 0 ? 'success' : 'skipped',
        detail: scopedCount > 0
          ? `Used as a folder scope for ${scopedCount} dashboard${scopedCount === 1 ? '' : 's'}.`
          : 'No dashboards loaded from this folder scope.',
      });
      setApplyResults([...results]);
    }

    for (const doc of selectedDashboardTargets) {
      try {
        const current = documentLabels[doc.id] ?? await fetchDocumentLabels(doc.id);
        const addForDoc = addLabels.filter((label) => !hasLabel(current, label));
        const removeForDoc = removeLabels.filter((label) => hasLabel(current, label));

        if (addForDoc.length === 0 && removeForDoc.length === 0) {
          results.push({ id: doc.id, name: doc.name, type: 'dashboard', status: 'skipped', detail: 'No dashboard label changes needed' });
          setApplyResults([...results]);
          continue;
        }

        const response = await patchDocumentLabels(doc.id, addForDoc, removeForDoc, current);
        const nextLabels = response?.labels || mergeLabelChanges(current, addForDoc, removeForDoc);
        setDocumentLabels((prev) => ({ ...prev, [doc.id]: nextLabels }));
        results.push({
          id: doc.id,
          name: doc.name,
          type: 'dashboard',
          status: 'success',
          detail: `${addForDoc.length} added, ${removeForDoc.length} removed`,
        });
      } catch (err) {
        results.push({
          id: doc.id,
          name: doc.name,
          type: 'dashboard',
          status: 'failed',
          detail: friendlyApiError(err, 'Dashboard label update failed'),
        });
      }
      setApplyResults([...results]);
    }

    logOp('label_change', `Bulk label update for ${selectedFolders.length} folder scopes and ${selectedDashboardTargets.length} dashboards`, {
      durationMs: Date.now() - start,
      itemCount: selectedDashboardTargets.length,
    });
    setAddLabels([]);
    setRemoveLabels([]);
    setApplying(false);
  }

  const dashboardFolderIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (id?: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };

    selectedFolders.forEach((folder) => add(folder.id));
    add(activeFolderId);
    selectedDocs.forEach((doc) => add(doc.folderId));

    return ids;
  }, [activeFolderId, selectedFolders, selectedDocs]);
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
  const selectedDashboardTargets = useMemo(() => {
    const seen = new Set<string>();
    const targets: FolderDashboard[] = [];
    const add = (doc: FolderDashboard) => {
      if (seen.has(doc.id)) return;
      seen.add(doc.id);
      targets.push(doc);
    };

    selectedDocs.forEach(add);
    for (const folder of selectedFolders) {
      (documentsByFolder[folder.id] || []).forEach(add);
    }

    return targets;
  }, [documentsByFolder, selectedDocs, selectedFolders]);
  const selectedLabelSets = useMemo<LabeledTarget[]>(
    () => selectedDashboardTargets.map((doc) => ({
        id: doc.id,
        type: 'dashboard' as const,
        labels: documentLabels[doc.id] || extractLabels(doc),
      })),
    [selectedDashboardTargets, documentLabels],
  );
  const visibleSelected = filteredDocs.length > 0 && filteredDocs.every((doc) => selectedDocumentsById[doc.id]);
  const selectedTargetCount = selectedDashboardTargets.length;
  const canApply = selectedTargetCount > 0 && !loadingDocs && (addLabels.length > 0 || removeLabels.length > 0);

  function coverageFor(label: string) {
    if (selectedTargetCount === 0) return { count: 0, total: 0, state: 'none' as const };
    const count = selectedLabelSets.filter((target) => hasLabel(target.labels, label)).length;
    if (count === selectedTargetCount) return { count, total: selectedTargetCount, state: 'all' as const };
    if (count > 0) return { count, total: selectedTargetCount, state: 'some' as const };
    return { count, total: selectedTargetCount, state: 'none' as const };
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bulk Label Governance"
        description="Select folder scopes and dashboards, compare existing labels, then apply dashboard label changes only where they are actually needed."
        icon={<Blobby mood="labels" size={58} className="animate-float" style={{ animationDuration: '3.6s' }} />}
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

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
              <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Folder Scopes</div>
              <div className="mt-2 text-2xl font-semibold text-content-primary">{selectedFolders.length}</div>
              <p className="mt-1 text-xs text-content-secondary">Folders selected as dashboard scopes.</p>
            </div>
            <div className="card p-4">
              <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Selected Dashboards</div>
              <div className="mt-2 text-2xl font-semibold text-content-primary">{selectedDocs.length}</div>
              <p className="mt-1 text-xs text-content-secondary">Dashboard targets across folders.</p>
            </div>
            <div className="card p-4">
              <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Queued Changes</div>
              <div className="mt-2 text-2xl font-semibold text-content-primary">{addLabels.length + removeLabels.length}</div>
              <p className="mt-1 text-xs text-content-secondary">{addLabels.length} add, {removeLabels.length} remove.</p>
            </div>
          </div>

          <div className="grid items-stretch gap-5 xl:grid-cols-[minmax(300px,0.85fr)_minmax(0,1fr)] 2xl:grid-cols-[minmax(300px,0.82fr)_minmax(0,1.02fr)_minmax(440px,1.12fr)]">
            <div className="card flex max-h-[860px] min-h-[660px] flex-col p-0 overflow-hidden">
              <div className="p-4 border-b border-border">
                <h3 className="text-sm font-semibold text-content-primary flex items-center gap-2">
                  <Folder size={16} className="text-omni-700" />
                  Folders
                </h3>
                <p className="mt-1 text-xs text-content-secondary leading-5">
                  Select folders as dashboard scopes. Folder labels are shown for context; public Omni APIs write labels to dashboards.
                </p>
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
                    const labelsForFolder = folderLabels[folder.id] || extractLabels(folder);
                    return (
                      <div key={folder.id} className={`px-3 py-2.5 transition-all ${isSelected ? selectedTreeRowClass : isActive ? 'border-l-4 border-l-omni-300 bg-surface-secondary' : unselectedTreeRowClass}`}>
                        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 items-start" style={{ paddingLeft: `${folder.depth * 14}px` }}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleFolder(folder.id)}
                            className="mt-1 accent-omni-700"
                            aria-label={`Select folder ${folder.name}`}
                          />
                          <button
                            type="button"
                            onClick={() => toggleFolder(folder.id)}
                            className="min-w-0 text-left"
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
                                  selected
                                </span>
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {labelsForFolder.length > 0 ? (
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
                            onClick={() => loadFolderDocuments(folder.id)}
                            className="mt-0.5 rounded-button border border-border bg-white px-2 py-1 text-[10px] font-medium text-content-secondary transition-colors hover:border-omni-300 hover:text-omni-700"
                            aria-label={`Browse dashboards in ${folder.name}`}
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
                      Dashboards
                      {dashboardFolderIds.length > 0 ? (
                        <span className="text-content-secondary font-normal">
                          from {dashboardFolderIds.length} folder scope{dashboardFolderIds.length === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </h3>
                    <p className="mt-1 text-xs text-content-secondary leading-5">
                      Select dashboards across any selected or browsed folder. Chosen dashboards stay selected when you browse another folder.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={toggleAllVisible}
                    disabled={filteredDocs.length === 0}
                    className="btn-secondary text-sm whitespace-nowrap"
                  >
                    <CheckSquare size={14} />
                    {visibleSelected ? 'Clear visible' : `Select visible (${filteredDocs.length})`}
                  </button>
                </div>
                <SearchInput value={docSearch} onChange={setDocSearch} placeholder="Search dashboards or folder names..." />
              </div>

              {loadingDocs ? (
                <div className="min-h-0 flex-1 p-4">
                  <WorkflowStatusScene
                    variant="label-apply"
                    title="Loading folder dashboards"
                    detail={`Pulling dashboards for ${loadingDashboardFolderCount} folder${loadingDashboardFolderCount === 1 ? '' : 's'}.`}
                    statusLabel="Loading"
                    compact
                  />
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-border/50">
                  {dashboardFolderIds.length === 0 ? (
                    <div className="py-12 px-4 text-center text-sm text-content-secondary">
                      Select one or more folders to show all dashboards from those folders.
                    </div>
                  ) : filteredDocs.length === 0 ? (
                    <div className="py-12 px-4 text-center text-sm text-content-secondary">
                      No dashboards found for the selected folder scope.
                    </div>
                  ) : (
                    filteredDocs.map((doc) => {
                      const isSelected = Boolean(selectedDocumentsById[doc.id]);
                      const labelsForDoc = documentLabels[doc.id] || extractLabels(doc);
                      const isLoadingLabels = loadingLabelIds.has(doc.id);
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
                                {isLoadingLabels ? (
                                  <span className="text-[10px] text-content-secondary">Loading labels...</span>
                                ) : labelsForDoc.length > 0 ? (
                                  labelsForDoc.map((label) => (
                                    <span key={label} className="rounded-chip bg-white border border-border px-2 py-0.5 text-[10px] text-content-secondary">
                                      {label}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-[10px] text-content-secondary">No dashboard labels found</span>
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
                  Coverage is calculated across selected folders and dashboards, so OmniKit skips labels that are already correct.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-card border border-border bg-surface-secondary p-3">
                  <div className="text-[10px] font-semibold text-content-secondary uppercase tracking-wider">Folder Scopes</div>
                  <div className="mt-1 text-lg font-semibold text-content-primary">{selectedFolders.length}</div>
                </div>
                <div className="rounded-card border border-border bg-surface-secondary p-3">
                  <div className="text-[10px] font-semibold text-content-secondary uppercase tracking-wider">Dashboard Targets</div>
                  <div className="mt-1 text-lg font-semibold text-content-primary">{selectedDocs.length}</div>
                </div>
              </div>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleCreateLabel();
                }}
                className="rounded-card border border-border bg-surface-secondary p-3"
              >
                <label className="block text-xs font-semibold text-content-primary">Create or queue a label</label>
                <p className="mt-1 text-xs text-content-secondary leading-5">
                  Add a new Omni label, then automatically queue it for dashboards in selected folders and any individually selected dashboards.
                </p>
                <div className="mt-3 flex gap-2">
                  <input
                    value={newLabelName}
                    onChange={(event) => setNewLabelName(event.target.value)}
                    className="input-field text-sm"
                    placeholder="e.g. Executive Ready"
                  />
                  <button
                    type="submit"
                    disabled={creatingLabel || !newLabelName.trim()}
                    className="btn-secondary text-sm whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {creatingLabel ? <Loader2 size={14} className="animate-spin" /> : <PlusCircle size={14} />}
                    Add
                  </button>
                </div>
              </form>

              {selectedTargetCount === 0 ? (
                <div className="rounded-card border border-border bg-surface-secondary p-4 text-sm text-content-secondary">
                  Select folder scopes, dashboards, or both to see current dashboard label coverage.
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
                        return (
                          <button
                            key={`add-${name}`}
                            type="button"
                            disabled={alreadyEverywhere}
                            onClick={() => toggleAddLabel(name)}
                            className={`px-2.5 py-1 rounded-chip text-xs font-medium transition-colors border ${
                              addLabels.includes(name)
                                ? 'bg-green-100 border-green-300 text-green-800'
                                : alreadyEverywhere
                                ? 'bg-gray-50 border-border text-content-tertiary cursor-not-allowed'
                                : 'bg-white border-border text-content-secondary hover:border-green-300'
                            }`}
                            title={alreadyEverywhere ? 'Already applied to every selected target' : `${coverage.count}/${coverage.total} selected targets already have this label`}
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
                        return (
                          <button
                            key={`remove-${name}`}
                            type="button"
                            disabled={absentEverywhere}
                            onClick={() => toggleRemoveLabel(name)}
                            className={`px-2.5 py-1 rounded-chip text-xs font-medium transition-colors border ${
                              removeLabels.includes(name)
                                ? 'bg-red-100 border-red-300 text-red-800'
                                : absentEverywhere
                                ? 'bg-gray-50 border-border text-content-tertiary cursor-not-allowed'
                                : 'bg-white border-border text-content-secondary hover:border-red-300'
                            }`}
                            title={absentEverywhere ? 'None of the selected targets have this label' : `${coverage.count}/${coverage.total} selected targets have this label`}
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

              {(applying || loadingLabelIds.size > 0) && (
                <WorkflowStatusScene
                  variant="label-apply"
                  title={applying ? 'Applying label changes' : 'Checking current labels'}
                  detail={applying ? 'Updating folders and dashboards sequentially to avoid API bursts.' : 'Reading selected dashboard label coverage.'}
                  statusLabel={applying ? 'Applying' : 'Checking'}
                  compact
                />
              )}

              <button
                type="button"
                onClick={handleApply}
                disabled={applying || !canApply}
                className="btn-primary text-sm w-full justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {applying ? <Loader2 size={14} className="animate-spin" /> : <Tag size={14} />}
                Apply to {selectedTargetCount || 0} dashboard{selectedTargetCount === 1 ? '' : 's'}
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
                            {result.type === 'folder' ? 'Folder scope' : 'Dashboard'}: {result.name}
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
        </>
      )}
    </div>
  );
}
