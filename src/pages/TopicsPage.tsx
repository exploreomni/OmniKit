import { useState, useEffect } from 'react';
import { Loader2, Plus, BookOpen, Trash2, CreditCard as Edit3, Eye, X, ChevronDown, ChevronRight } from 'lucide-react';
import { listModels, listTopics, getTopic, createTopic, updateTopic, deleteTopic } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { OmniModel } from '@/types';

function TopicFormModal({
  open,
  modelId,
  editMode,
  initialName,
  initialData,
  onClose,
  onSave,
}: {
  open: boolean;
  modelId: string;
  editMode: boolean;
  initialName?: string;
  initialData?: string;
  onClose: () => void;
  onSave: () => void;
}) {
  const { connection } = useConnection();
  const [baseViewName, setBaseViewName] = useState('');
  const [, setTopicName] = useState('');
  const [jsonBody, setJsonBody] = useState('{}');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (editMode && initialName) {
      setTopicName(initialName);
      setJsonBody(initialData || '{}');
    } else {
      setTopicName('');
      setBaseViewName('');
      setJsonBody('{}');
    }
    setError('');
  }, [editMode, initialName, initialData, open]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = JSON.parse(jsonBody);
      if (editMode && initialName) {
        await updateTopic(connection.baseUrl, connection.apiKey, modelId, initialName, body);
      } else {
        if (!baseViewName) throw new Error('Base view name is required');
        await createTopic(connection.baseUrl, connection.apiKey, modelId, baseViewName, body);
      }
      onSave();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save topic');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-card shadow-dropdown p-6 max-w-lg w-full mx-4">
        <button onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-content-primary mb-4">
          {editMode ? 'Update Topic' : 'Create Topic'}
        </h3>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-4">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          {!editMode && (
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Base View Name</label>
              <input
                type="text"
                value={baseViewName}
                onChange={(e) => setBaseViewName(e.target.value)}
                className="input-field font-mono text-xs"
                placeholder="e.g. orders"
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-content-secondary mb-1">
              Topic Body (JSON)
            </label>
            <textarea
              value={jsonBody}
              onChange={(e) => setJsonBody(e.target.value)}
              className="input-field font-mono text-xs h-48 resize-none"
              placeholder='{ "label": "My Topic", "description": "..." }'
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary text-sm">
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {editMode ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TopicDetailModal({
  open,
  data,
  onClose,
}: {
  open: boolean;
  data: Record<string, unknown> | null;
  onClose: () => void;
}) {
  if (!open || !data) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-card shadow-dropdown p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-content-primary mb-4">Topic Detail</h3>
        <pre className="bg-gray-900 text-green-400 text-xs p-4 rounded overflow-auto max-h-[60vh] font-mono leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );
}

interface TopicEntry {
  name: string;
  label?: string;
  description?: string;
}

export function TopicsPage() {
  const { connection } = useConnection();
  const [models, setModels] = useState<OmniModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [topics, setTopics] = useState<TopicEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [error, setError] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [topicDetails, setTopicDetails] = useState<Record<string, Record<string, unknown>>>({});
  const [showForm, setShowForm] = useState(false);
  const [editTopic, setEditTopic] = useState<{ name: string; data: string } | null>(null);
  const [viewTopic, setViewTopic] = useState<Record<string, unknown> | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  useEffect(() => {
    async function fetchModels() {
      setLoading(true);
      try {
        const res = await listModels(connection.baseUrl, connection.apiKey);
        setModels(Array.isArray(res.models) ? res.models : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load models');
      } finally {
        setLoading(false);
      }
    }
    fetchModels();
  }, [connection.baseUrl, connection.apiKey]);

  async function fetchTopicDetail(topicName: string) {
    if (topicDetails[topicName]) return topicDetails[topicName];
    try {
      const data = await getTopic(connection.baseUrl, connection.apiKey, selectedModelId, topicName);
      setTopicDetails((prev) => ({ ...prev, [topicName]: data }));
      return data;
    } catch {
      return null;
    }
  }

  async function handleModelSelect(modelId: string) {
    setSelectedModelId(modelId);
    setTopics([]);
    setTopicDetails({});
    if (!modelId) return;

    setLoadingTopics(true);
    setError('');
    try {
      const data = await listTopics(connection.baseUrl, connection.apiKey, modelId);
      setTopics(data.map((t) => ({
        name: t.name,
        label: t.label,
        description: t.description,
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load topics');
      setTopics([]);
    } finally {
      setLoadingTopics(false);
    }
  }

  async function toggleExpand(topicName: string) {
    const next = new Set(expandedIds);
    if (next.has(topicName)) {
      next.delete(topicName);
    } else {
      next.add(topicName);
      await fetchTopicDetail(topicName);
    }
    setExpandedIds(next);
  }

  async function handleDeleteTopic() {
    if (!deleteTarget || !selectedModelId) return;
    try {
      await deleteTopic(connection.baseUrl, connection.apiKey, selectedModelId, deleteTarget);
      setTopics((prev) => prev.filter((t) => t.name !== deleteTarget));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setDeleteTarget(null);
    }
  }

  function handleRefresh() {
    if (selectedModelId) handleModelSelect(selectedModelId);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Topics"
        description="View and manage topics within your Omni models."
        actions={
          selectedModelId ? (
            <button onClick={() => { setEditTopic(null); setShowForm(true); }} className="btn-primary text-sm">
              <Plus size={14} />
              Create Topic
            </button>
          ) : undefined
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      <div>
        <label className="block text-xs font-medium text-content-secondary mb-1.5">Select Model</label>
        {loading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 size={16} className="text-omni-500 animate-spin" />
            <span className="text-sm text-content-secondary">Loading models...</span>
          </div>
        ) : (
          <select
            value={selectedModelId}
            onChange={(e) => handleModelSelect(e.target.value)}
            className="input-field"
          >
            <option value="">Choose a model...</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name} ({m.id})</option>
            ))}
          </select>
        )}
      </div>

      {loadingTopics && (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={20} className="text-omni-500 animate-spin" />
        </div>
      )}

      {selectedModelId && !loadingTopics && (
        <div className="space-y-3">
          {topics.length === 0 ? (
            <div className="card text-center py-8">
              <BookOpen size={32} className="mx-auto mb-2 text-content-secondary opacity-40" />
              <p className="text-sm text-content-secondary">No topics found for this model. Create one to get started.</p>
            </div>
          ) : (
            topics.map((topic) => {
              const isExpanded = expandedIds.has(topic.name);
              const detail = topicDetails[topic.name];

              return (
                <div key={topic.name} className="card p-0 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3">
                    <button
                      onClick={() => toggleExpand(topic.name)}
                      className="flex items-center gap-3 flex-1"
                    >
                      {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <div className="text-left">
                        <div className="text-sm font-medium text-content-primary">{topic.label || topic.name}</div>
                        {topic.description && (
                          <div className="text-xs text-content-secondary truncate max-w-md">{topic.description}</div>
                        )}
                      </div>
                    </button>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={async () => {
                          const data = await fetchTopicDetail(topic.name);
                          if (data) setViewTopic(data);
                        }}
                        className="p-1.5 text-content-secondary hover:text-omni-700 hover:bg-omni-100 rounded transition-colors"
                      >
                        <Eye size={14} />
                      </button>
                      <button
                        onClick={async () => {
                          const data = await fetchTopicDetail(topic.name);
                          setEditTopic({ name: topic.name, data: JSON.stringify(data, null, 2) });
                          setShowForm(true);
                        }}
                        className="p-1.5 text-content-secondary hover:text-omni-700 hover:bg-omni-100 rounded transition-colors"
                      >
                        <Edit3 size={14} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(topic.name)}
                        className="p-1.5 text-content-secondary hover:text-error hover:bg-red-50 rounded transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {isExpanded && detail && (
                    <div className="border-t border-border px-4 py-3 bg-surface-secondary">
                      <div className="grid grid-cols-2 gap-4 text-xs">
                        <div>
                          <span className="font-medium text-content-primary">Base View:</span>{' '}
                          <span className="font-mono text-content-secondary">{((detail as Record<string, unknown>).base_view_name || (detail as Record<string, unknown>).baseViewName) as string || 'N/A'}</span>
                        </div>
                        <div>
                          <span className="font-medium text-content-primary">Views:</span>{' '}
                          <span className="text-content-secondary">
                            {Array.isArray((detail as Record<string, unknown>).views) ? ((detail as Record<string, unknown>).views as unknown[]).length : 0}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      <TopicFormModal
        open={showForm}
        modelId={selectedModelId}
        editMode={!!editTopic}
        initialName={editTopic?.name}
        initialData={editTopic?.data}
        onClose={() => { setShowForm(false); setEditTopic(null); }}
        onSave={handleRefresh}
      />

      <TopicDetailModal
        open={!!viewTopic}
        data={viewTopic}
        onClose={() => setViewTopic(null)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Topic"
        message={`Are you sure you want to delete topic "${deleteTarget}"? This cannot be undone.`}
        confirmLabel="Delete Topic"
        variant="danger"
        onConfirm={handleDeleteTopic}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
