import { useState, useEffect } from 'react';
import { Loader2, Plus, Database, X } from 'lucide-react';
import { listModels, createModel } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusChip } from '@/components/ui/StatusChip';
import type { OmniModel } from '@/types';

function CreateModelModal({
  open,
  models,
  onClose,
  onCreate,
}: {
  open: boolean;
  models: OmniModel[];
  onClose: () => void;
  onCreate: (connectionId: string, name: string, kind: string, baseModelId?: string) => Promise<void>;
}) {
  const [connectionId, setConnectionId] = useState('');
  const [modelName, setModelName] = useState('');
  const [modelKind, setModelKind] = useState('SHARED');
  const [baseModelId, setBaseModelId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const uniqueConnections = [...new Set(models.map((m) => m.connectionId).filter(Boolean))];

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!connectionId || !modelName) return;
    setSaving(true);
    setError('');
    try {
      await onCreate(connectionId, modelName, modelKind, baseModelId || undefined);
      onClose();
      setModelName('');
      setBaseModelId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create model');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-card shadow-dropdown p-6 max-w-md w-full mx-4">
        <button onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-content-primary mb-4">Create Model</h3>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-4">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-content-secondary mb-1">Connection ID</label>
            {uniqueConnections.length > 0 ? (
              <select
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                className="input-field"
              >
                <option value="">Select a connection...</option>
                {uniqueConnections.map((c) => (
                  <option key={c} value={c!}>{c}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                className="input-field font-mono text-xs"
                placeholder="Enter connection ID"
              />
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-content-secondary mb-1">Model Name</label>
            <input
              type="text"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              className="input-field"
              placeholder="My New Model"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-content-secondary mb-1">Kind</label>
            <select
              value={modelKind}
              onChange={(e) => setModelKind(e.target.value)}
              className="input-field"
            >
              <option value="SHARED">Shared</option>
              <option value="TOPIC">Topic</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-content-secondary mb-1">Base Model ID (optional)</label>
            <input
              type="text"
              value={baseModelId}
              onChange={(e) => setBaseModelId(e.target.value)}
              className="input-field font-mono text-xs"
              placeholder="Optional parent model ID"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={saving || !connectionId || !modelName} className="btn-primary text-sm">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Create Model
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ModelsPage() {
  const { connection } = useConnection();
  const [models, setModels] = useState<OmniModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    async function fetchModels() {
      setLoading(true);
      setError('');
      try {
        const res = await listModels(connection.baseUrl, connection.apiKey);
        if (res.error) {
          setError(res.error);
          return;
        }
        setModels(Array.isArray(res.models) ? res.models : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load models');
      } finally {
        setLoading(false);
      }
    }
    fetchModels();
  }, [connection.baseUrl, connection.apiKey]);

  async function handleCreateModel(connectionId: string, name: string, kind: string, baseModelId?: string) {
    await createModel(connection.baseUrl, connection.apiKey, connectionId, name, kind, baseModelId);
    const res = await listModels(connection.baseUrl, connection.apiKey);
    setModels(Array.isArray(res.models) ? res.models : []);
  }

  const filteredModels = models.filter((m) => {
    const matchesSearch = !search || m.name.toLowerCase().includes(search.toLowerCase()) || m.id.toLowerCase().includes(search.toLowerCase());
    const matchesKind = kindFilter === 'all' || (m.kind || '').toLowerCase() === kindFilter.toLowerCase();
    return matchesSearch && matchesKind;
  });

  const kinds = [...new Set(models.map((m) => m.kind).filter(Boolean))];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Models"
        description={`${models.length} models in your Omni instance.`}
        actions={
          <button onClick={() => setShowCreate(true)} className="btn-primary text-sm">
            <Plus size={14} />
            Create Model
          </button>
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      <div className="flex gap-3">
        <div className="flex-1">
          <SearchInput value={search} onChange={setSearch} placeholder="Search models..." />
        </div>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          className="input-field w-auto"
        >
          <option value="all">All Kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k!}>{k}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="text-omni-500 animate-spin" />
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2">
            <div className="col-span-1" />
            <div className="col-span-4 text-xs font-medium text-content-secondary uppercase tracking-wider">Name</div>
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">ID</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Kind</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Connection</div>
          </div>
          <div className="max-h-[500px] overflow-y-auto">
            {filteredModels.length === 0 ? (
              <div className="text-center py-12 text-content-secondary text-sm">No models found.</div>
            ) : (
              filteredModels.map((model) => (
                <div
                  key={model.id}
                  className="px-4 py-3 border-b border-border/50 grid grid-cols-12 gap-2 items-center hover:bg-surface-secondary transition-colors"
                >
                  <div className="col-span-1">
                    <Database size={16} className="text-content-secondary" />
                  </div>
                  <div className="col-span-4 text-sm text-content-primary font-medium truncate">{model.name}</div>
                  <div className="col-span-3 font-mono text-xs text-content-secondary truncate" title={model.id}>{model.id}</div>
                  <div className="col-span-2">
                    {model.kind && (
                      <StatusChip status="info" label={model.kind} />
                    )}
                  </div>
                  <div className="col-span-2 font-mono text-xs text-content-secondary truncate" title={model.connectionId}>
                    {model.connectionId ? (model.connectionId.length > 12 ? model.connectionId.slice(0, 12) + '...' : model.connectionId) : '-'}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <CreateModelModal
        open={showCreate}
        models={models}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreateModel}
      />
    </div>
  );
}
