import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle,
  Loader2,
  ShieldCheck,
  Lock,
  KeyRound,
  ArrowRight,
  Sparkles,
  PlayCircle,
  ArrowRightLeft,
  FolderInput,
  Download,
  Cable,
  FileUp,
  Database,
  BookOpen,
  Tag,
  Calendar,
  Users,
  Shield,
  Link2,
  HelpCircle,
  Presentation,
  ChevronRight,
  LayoutDashboard,
  RefreshCw,
  Save,
  Server,
  UnlockKeyhole,
} from 'lucide-react';
import { listDocuments, listFolders, listGroups, listModels, listUsers, omniProxy } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { useVaultSession } from '@/hooks/useVaultSession';
import { OmniKitLogo } from '@/components/brand/OmniKitLogo';
import { ConnectionAnimation } from '@/components/ui/ConnectionAnimation';
import {
  saveSavedInstance,
  type InstanceRole,
} from '@/services/opsConsole';

type CapabilityIcon = typeof Sparkles;

interface Capability {
  id: string;
  title: string;
  blurb: string;
  count: number;
  icons: CapabilityIcon[];
}

const capabilities: Capability[] = [
  {
    id: 'ai',
    title: 'AI & Dashboards',
    blurb: 'Migrate, copy, and bulk-manage dashboards across instances with AI-assisted query running.',
    count: 6,
    icons: [Sparkles, ArrowRightLeft, FolderInput, Download, PlayCircle, Presentation],
  },
  {
    id: 'data',
    title: 'Data Platform',
    blurb: 'Inspect connections, curate models, and keep topics and uploads organized.',
    count: 4,
    icons: [Cable, Database, BookOpen, FileUp],
  },
  {
    id: 'governance',
    title: 'Governance',
    blurb: 'Manage users, groups, labels, schedules, and embeds with a full audit trail.',
    count: 5,
    icons: [Users, Shield, Tag, Calendar, Link2],
  },
];

function parseHost(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.host || null;
  } catch {
    return null;
  }
}

function CapabilityCard({ cap }: { cap: Capability }) {
  return (
    <div
      className="group relative rounded-2xl p-6 min-h-[164px] transition-all duration-200 hover:-translate-y-0.5"
      style={{
        background: '#7A2E52',
        border: '1px solid rgba(255,255,255,0.32)',
        boxShadow: 'none',
      }}
    >
      <div
        aria-hidden
        className="absolute inset-0 rounded-2xl pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{ border: '1px solid rgba(255,255,255,0.35)' }}
      />
      <div className="relative mb-5 flex items-start gap-3">
        <div className="grid min-w-0 flex-1 grid-cols-4 gap-1.5">
          {cap.icons.slice(0, 4).map((Icon, i) => (
            <div
              key={i}
              className="h-7 w-7 rounded-lg flex items-center justify-center transition-transform duration-300 group-hover:translate-x-0.5"
              style={{
                background: '#8A3A60',
                border: '1px solid rgba(255,255,255,0.35)',
                color: '#FFFFFF',
                transitionDelay: `${i * 40}ms`,
              }}
            >
              <Icon size={14} />
            </div>
          ))}
        </div>
        <span
          className="shrink-0 whitespace-nowrap rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-[0.08em]"
          style={{
            background: '#8A3A60',
            color: 'rgba(255,255,255,0.95)',
            border: '1px solid rgba(255,255,255,0.25)',
          }}
        >
          {cap.count} tools
        </span>
      </div>
      <div className="relative">
        <h3 className="text-[18px] font-semibold text-white leading-tight mb-2 flex items-center gap-1.5">
          {cap.title}
          <ChevronRight
            size={14}
            className="opacity-0 -translate-x-1 transition-all duration-200 group-hover:opacity-90 group-hover:translate-x-0 text-white/90"
          />
        </h3>
        <p className="text-[13px] leading-relaxed text-white/80">{cap.blurb}</p>
      </div>
    </div>
  );
}

interface QuickStartTile {
  label: string;
  description: string;
  to: string;
  icon: CapabilityIcon;
}

interface WorkspaceSnapshot {
  dashboards: number | null;
  folders: number | null;
  models: number | null;
  users: number | null;
  groups: number | null;
  schedules: number | null;
  connections: number | null;
  failures: string[];
  loadedAt: Date | null;
}

const quickStartTiles: QuickStartTile[] = [
  { label: 'Migrate dashboards', description: 'Remap models or copy to another instance', to: '/dashboards/migrate', icon: ArrowRightLeft },
  { label: 'Audit permissions', description: 'Review users and group access', to: '/users', icon: Shield },
  { label: 'Build a deck', description: 'Export dashboards to PowerPoint', to: '/deck-builder', icon: Presentation },
];

const EMPTY_SNAPSHOT: WorkspaceSnapshot = {
  dashboards: null,
  folders: null,
  models: null,
  users: null,
  groups: null,
  schedules: null,
  connections: null,
  failures: [],
  loadedAt: null,
};

interface NewVaultInstanceForm {
  label: string;
  role: InstanceRole;
  baseUrl: string;
  apiKey: string;
}

const EMPTY_VAULT_INSTANCE_FORM: NewVaultInstanceForm = {
  label: '',
  role: 'both',
  baseUrl: '',
  apiKey: '',
};

function countNestedFolders(folders: Array<{ children?: unknown }>): number {
  return folders.reduce((total, folder) => {
    const children = Array.isArray(folder.children) ? folder.children as Array<{ children?: unknown }> : [];
    return total + 1 + countNestedFolders(children);
  }, 0);
}

function totalFromScim(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const total = Number(record.totalResults);
  if (Number.isFinite(total)) return total;
  const resources = record.Resources;
  return Array.isArray(resources) ? resources.length : null;
}

function totalFromPageInfo(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const pageInfo = record.pageInfo;
  if (pageInfo && typeof pageInfo === 'object') {
    const total = Number((pageInfo as Record<string, unknown>).totalRecords);
    if (Number.isFinite(total)) return total;
  }
  const total = Number(record.totalRecords);
  if (Number.isFinite(total)) return total;
  const records = record.records;
  return Array.isArray(records) ? records.length : null;
}

function valueFromSettled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

function failureLabel(result: PromiseSettledResult<unknown>, label: string) {
  return result.status === 'rejected' ? label : null;
}

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await promise };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function formatMetric(value: number | null) {
  if (value === null) return '—';
  return new Intl.NumberFormat().format(value);
}

function WorkspaceSnapshotPanel({
  snapshot,
  loading,
  onRefresh,
  onNavigate,
}: {
  snapshot: WorkspaceSnapshot;
  loading: boolean;
  onRefresh: () => void;
  onNavigate: (to: string) => void;
}) {
  const metrics = [
    { label: 'Dashboards', value: snapshot.dashboards, detail: 'Content catalog', icon: LayoutDashboard, to: '/dashboards/operations' },
    { label: 'Models', value: snapshot.models, detail: 'Semantic layer', icon: Database, to: '/models' },
    { label: 'Users', value: snapshot.users, detail: 'SCIM directory', icon: Users, to: '/users' },
    { label: 'Groups', value: snapshot.groups, detail: 'Access cohorts', icon: Shield, to: '/users?tab=groups' },
    { label: 'Schedules', value: snapshot.schedules, detail: 'Deliveries', icon: Calendar, to: '/schedules' },
    { label: 'Folders', value: snapshot.folders, detail: 'Content spaces', icon: FolderInput, to: '/labels' },
    { label: 'Connections', value: snapshot.connections, detail: 'Data sources', icon: Cable, to: '/connections' },
  ];

  return (
    <div
      className="rounded-2xl p-4"
      style={{
        background: '#7A2E52',
        border: '1px solid rgba(255,255,255,0.38)',
        boxShadow: 'none',
      }}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <div className="text-[12px] font-bold uppercase tracking-[0.18em] text-white/80">Workspace snapshot</div>
          <div className="mt-1 text-[13px] text-white/90">
            Read-only summary from your connected Omni instance.
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-semibold text-white transition-all hover:-translate-y-px disabled:opacity-60 disabled:hover:translate-y-0"
          style={{
	            background: '#8A3A60',
            border: '1px solid rgba(255,255,255,0.34)',
          }}
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <button
              key={metric.label}
              type="button"
              onClick={() => onNavigate(metric.to)}
              className="group text-left rounded-xl p-3 min-h-[92px] transition-all hover:-translate-y-0.5"
              style={{
	                background: '#8A3A60',
                border: '1px solid rgba(255,255,255,0.30)',
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-white/95"
                  style={{
	                    background: '#7A2E52',
                    border: '1px solid rgba(255,255,255,0.20)',
                  }}
                >
                  <Icon size={15} />
                </div>
                {loading && metric.value === null && <Loader2 size={13} className="animate-spin text-white/70" />}
              </div>
              <div className="mt-2 text-[22px] font-bold leading-none text-white">{formatMetric(metric.value)}</div>
              <div className="mt-1 text-[12px] font-semibold text-white/90">{metric.label}</div>
              <div className="mt-0.5 text-[11px] text-white/78">{metric.detail}</div>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-col gap-1.5 text-[11px] text-white/75 sm:flex-row sm:items-center sm:justify-between">
        <span>
          {snapshot.loadedAt
            ? `Last updated ${snapshot.loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
            : loading
              ? 'Loading workspace counts...'
              : 'Snapshot will load after connection.'}
        </span>
        {snapshot.failures.length > 0 && (
          <span className="text-white/82">
            Limited permissions for: {snapshot.failures.join(', ')}
          </span>
        )}
      </div>
    </div>
  );
}

export function ConnectPage() {
  const navigate = useNavigate();
  const { connection, resetConnection, isConnected } = useConnection();
  const {
    status: vaultSessionState,
    vaultStatus,
    instances: savedInstances,
    unlock: unlockVault,
    connectInstance,
    refreshInstances,
  } = useVaultSession();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(EMPTY_SNAPSHOT);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotLoadedFor, setSnapshotLoadedFor] = useState('');
  const [selectedInstanceId, setSelectedInstanceId] = useState('');
  const [vaultPassphrase, setVaultPassphrase] = useState('');
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultMessage, setVaultMessage] = useState('');
  const [vaultError, setVaultError] = useState('');
  const [newVaultInstance, setNewVaultInstance] = useState<NewVaultInstanceForm>(EMPTY_VAULT_INSTANCE_FORM);
  const [showAddVaultInstance, setShowAddVaultInstance] = useState(false);

  const connectionKey = `${connection.baseUrl.trim()}|${connection.instanceId || (connection.apiKey ? 'manual-key-present' : 'no-key')}`;
  const selectedInstance = savedInstances.find((instance) => instance.id === selectedInstanceId) || savedInstances[0] || null;

  useEffect(() => {
    setSelectedInstanceId((current) => {
      if (current && savedInstances.some((instance) => instance.id === current)) return current;
      return savedInstances[0]?.id || '';
    });
  }, [savedInstances]);

  async function handleVaultUnlock() {
    setVaultBusy(true);
    setVaultError('');
    setVaultMessage('');
    const hadExistingVault = Boolean(vaultStatus?.exists);
    try {
      await unlockVault(vaultPassphrase);
      setVaultPassphrase('');
      const instances = await refreshInstances();
      setVaultMessage(hadExistingVault ? 'Vault unlocked. Choose a saved instance to connect.' : 'Vault created. Add your first Omni instance to continue.');
      setShowAddVaultInstance(instances.length === 0);
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : 'Could not unlock the vault.');
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleUseSavedInstance(instanceId = selectedInstance?.id || '') {
    if (!instanceId) return;
    setVaultBusy(true);
    setVaultError('');
    setVaultMessage('');
    try {
      const instance = await connectInstance(instanceId);
      await refreshInstances();
      setVaultMessage(`Connected to ${instance.label}.`);
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : 'Could not connect to the saved instance.');
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleSaveAndUseVaultInstance() {
    setVaultBusy(true);
    setVaultError('');
    setVaultMessage('');
    try {
      const saved = await saveSavedInstance({
        label: newVaultInstance.label,
        role: newVaultInstance.role,
        baseUrl: newVaultInstance.baseUrl,
        apiKey: newVaultInstance.apiKey,
        metricFilter: {
          connectionDatabaseContains: [],
          connectionDatabaseExact: [],
          embedExternalIdContains: [],
          embedExternalIdExact: [],
        },
        postMigrationActions: [],
      });
      setNewVaultInstance(EMPTY_VAULT_INSTANCE_FORM);
      setShowAddVaultInstance(false);
      await refreshInstances();
      setSelectedInstanceId(saved.instance.id);
      const instance = await connectInstance(saved.instance.id);
      await refreshInstances();
      setVaultMessage(`Saved and connected to ${instance.label}.`);
    } catch (err) {
      setVaultError(err instanceof Error ? err.message : 'Could not save and test this instance.');
    } finally {
      setVaultBusy(false);
    }
  }

  const loadWorkspaceSnapshot = useCallback(async () => {
    if (!connection.baseUrl || !connection.apiKey) return;
    setSnapshotLoading(true);

    try {
      const documentsRes = await settle(listDocuments(connection.baseUrl, connection.apiKey, undefined, { allPages: true, pageSize: 250 }));
      const foldersRes = await settle(listFolders(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 }));
      const modelsRes = await settle(listModels(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100, include: 'activeBranches' }));
      const usersRes = await settle(listUsers(connection.baseUrl, connection.apiKey, 1, 1));
      const groupsRes = await settle(listGroups(connection.baseUrl, connection.apiKey, 1, 1));
      const schedulesRes = await settle(omniProxy<{ records?: unknown[]; pageInfo?: { totalRecords?: number } }>(
        connection.baseUrl,
        connection.apiKey,
        'GET',
        '/v1/schedules',
        { queryParams: { cursor: '1', pageSize: '1' } },
      ));
      const connectionsRes = await settle(omniProxy<{ records?: unknown[]; connections?: unknown[] }>(
        connection.baseUrl,
        connection.apiKey,
        'GET',
        '/v1/connections',
      ));

      const documentsPayload = valueFromSettled(documentsRes) as { documents?: unknown[] } | null;
      const foldersPayload = valueFromSettled(foldersRes) as { folders?: Array<{ children?: unknown }> } | null;
      const modelsPayload = valueFromSettled(modelsRes) as { models?: unknown[] } | null;
      const usersPayload = valueFromSettled(usersRes);
      const groupsPayload = valueFromSettled(groupsRes);
      const schedulesPayload = valueFromSettled(schedulesRes);
      const connectionsPayload = valueFromSettled(connectionsRes);

      const failures = [
        failureLabel(documentsRes, 'dashboards'),
        failureLabel(foldersRes, 'folders'),
        failureLabel(modelsRes, 'models'),
        failureLabel(usersRes, 'users'),
        failureLabel(groupsRes, 'groups'),
        failureLabel(schedulesRes, 'schedules'),
        failureLabel(connectionsRes, 'connections'),
      ].filter((label): label is string => Boolean(label));

      setSnapshot({
        dashboards: Array.isArray(documentsPayload?.documents) ? documentsPayload.documents.length : null,
        folders: Array.isArray(foldersPayload?.folders) ? countNestedFolders(foldersPayload.folders) : null,
        models: Array.isArray(modelsPayload?.models) ? modelsPayload.models.length : null,
        users: totalFromScim(usersPayload),
        groups: totalFromScim(groupsPayload),
        schedules: totalFromPageInfo(schedulesPayload),
        connections: Array.isArray((connectionsPayload as { records?: unknown[] } | null)?.records)
          ? (connectionsPayload as { records?: unknown[] }).records?.length ?? null
          : Array.isArray((connectionsPayload as { connections?: unknown[] } | null)?.connections)
            ? (connectionsPayload as { connections?: unknown[] }).connections?.length ?? null
            : null,
        failures,
        loadedAt: new Date(),
      });
      setSnapshotLoadedFor(connectionKey);
    } finally {
      setSnapshotLoading(false);
    }
  }, [connection.apiKey, connection.baseUrl, connectionKey]);

  useEffect(() => {
    if (!isConnected) {
      setSnapshot(EMPTY_SNAPSHOT);
      setSnapshotLoadedFor('');
      return;
    }
    if (snapshotLoadedFor === connectionKey || snapshotLoading) return;
    loadWorkspaceSnapshot();
  }, [connectionKey, isConnected, loadWorkspaceSnapshot, snapshotLoadedFor, snapshotLoading]);

  const parsedHost = useMemo(() => parseHost(connection.baseUrl), [connection.baseUrl]);
  const vaultUnlocked = vaultSessionState === 'unlocked';
  const canUnlockVault = Boolean(vaultPassphrase.trim()) && (vaultStatus?.exists || vaultPassphrase.trim().length >= 8) && !vaultBusy;
  const newInstanceHost = parseHost(newVaultInstance.baseUrl);
  const canSaveVaultInstance = Boolean(newInstanceHost && newVaultInstance.apiKey.trim().length >= 12 && !vaultBusy);
  const isVaultConnected = connection.connectionMode === 'vault' && Boolean(connection.instanceId);

  const blobbyConfig = {
    untested: { src: '/blobby-waving.png', alt: 'Blobby waving hello' },
    testing: { src: '/blobby-connection-testing.png', alt: 'Blobby testing the connection' },
    success: { src: '/blobby-connection-success.png', alt: 'Blobby celebrating a successful connection' },
    error: { src: '/blobby-error.png', alt: 'Blobby connection error' },
  };
  const currentBlobby = blobbyConfig[connection.status];

  const statusPill = (() => {
    switch (connection.status) {
      case 'testing':
        return { dot: '#FDE68A', text: 'Testing connection…', pulse: true };
      case 'success':
        return { dot: '#34D399', text: parsedHost ? `Connected to ${parsedHost}` : 'Connected', pulse: false };
      case 'error':
        return { dot: '#FCA5A5', text: connection.errorMessage || 'Connection failed', pulse: false };
      default:
        return { dot: 'rgba(255,255,255,0.55)', text: 'Awaiting credentials', pulse: false };
    }
  })();

  const heroCopy = useMemo(() => {
    switch (connection.status) {
      case 'testing':
        return {
          eyebrow: 'Checking connection',
          titleTop: 'Blobby is checking',
          titleBottom: 'your Omni access.',
          body: 'Validating reachability and API permissions. This usually takes just a moment.',
        };
      case 'success':
        return {
          eyebrow: "You're in",
          titleTop: 'What would you like',
          titleBottom: 'to do first?',
          body: 'Pick the workflow you want to start. OmniKit will keep using this saved vault instance while the tab stays open.',
        };
      case 'error':
        return {
          eyebrow: 'Connection needs attention',
          titleTop: "Let's get you",
          titleBottom: 'connected.',
          body: 'Return Home, unlock the vault, and choose a saved instance again. OmniKit keeps plaintext keys out of the browser.',
        };
      default:
        return {
          eyebrow: 'Omni Admin Toolkit',
          titleTop: 'Your Omni',
          titleBottom: 'command center.',
          body: 'A unified admin toolkit for every corner of your Omni analytics instance, from AI queries to governance.',
        };
    }
  }, [connection.status]);

  return (
    <div className="flex min-h-screen max-h-screen overflow-hidden">
      <div
        className="flex flex-col justify-center flex-1 relative overflow-hidden px-12 py-10"
        style={{
          background:
            'linear-gradient(155deg, #4A0E2E 0%, #8A1651 28%, #D4236F 60%, #FF6FA8 100%)',
        }}
      >
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
	            backgroundImage: 'none',
            backgroundSize: '34px 34px',
	            maskImage: 'none',
	            WebkitMaskImage: 'none',
          }}
        />
        <div
          aria-hidden
          className="absolute -top-24 -right-24 w-[520px] h-[520px] rounded-full pointer-events-none animate-float"
          style={{
	            background: 'transparent',
            animationDuration: '9s',
          }}
        />
        <div
          aria-hidden
          className="absolute -bottom-32 -left-24 w-[460px] h-[460px] rounded-full pointer-events-none animate-float"
          style={{
	            background: 'transparent',
            animationDuration: '11s',
            animationDelay: '1.5s',
          }}
        />

        <div className="relative z-10 mx-auto w-full max-w-5xl">
          <div className="flex items-center justify-between mb-14">
            <OmniKitLogo variant="light" size="sm" subtitle="Home" />
            <div
              className="flex items-center gap-2 rounded-full px-4 py-2"
              style={{
                background: 'rgba(255,255,255,0.12)',
                border: '1px solid rgba(255,255,255,0.22)',
              }}
              aria-live="polite"
            >
              <span className="relative flex h-2 w-2">
                {statusPill.pulse && (
                  <span
                    className="absolute inline-flex h-full w-full rounded-full opacity-70 animate-ping"
                    style={{ background: statusPill.dot }}
                  />
                )}
                <span
                  className="relative inline-flex rounded-full h-2 w-2"
	                  style={{ background: statusPill.dot, boxShadow: 'none' }}
                />
              </span>
              <span className="text-[12px] font-medium text-white/90">
                {statusPill.text}
              </span>
            </div>
          </div>

          <div className="animate-fadeIn">
            <div className="flex items-center gap-7 mb-7">
              <div className="relative flex-shrink-0">
                <div
                  aria-hidden
                  className="absolute inset-0 rounded-full"
                  style={{
	                    background: 'transparent',
                    transform: 'scale(2.4)',
                  }}
                />
                <img
                  key={currentBlobby.src}
                  src={currentBlobby.src}
                  alt={currentBlobby.alt}
                  className="w-40 h-40 object-contain relative z-10 animate-float"
                  style={{ animationDuration: connection.status === 'testing' ? '2.4s' : '3.2s' }}
                />
              </div>
              <div className="pb-1">
                <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-white/70 mb-3">
                  {heroCopy.eyebrow}
                </p>
                <h1 className="text-[66px] 2xl:text-[72px] font-bold leading-[0.96] tracking-tight text-white">
                  <span className="block">{heroCopy.titleTop}</span>
	                  <span className="block text-white">
                    {heroCopy.titleBottom}
                  </span>
                </h1>
                <p className="mt-6 max-w-2xl text-[16px] leading-relaxed text-white/80">
                  {heroCopy.body}
                </p>
                {!isConnected && (
                  <div className="mt-4 flex items-center gap-3 text-[11px] text-white/75 font-medium">
                    <span>15 tools</span>
                    <span className="w-1 h-1 rounded-full bg-white" />
                    <span>Vault-first</span>
                    <span className="w-1 h-1 rounded-full bg-white" />
                    <span>Works offline-ready</span>
                  </div>
                )}
              </div>
            </div>
            {isConnected ? (
              <div className="space-y-4">
                <WorkspaceSnapshotPanel
                  snapshot={snapshot}
                  loading={snapshotLoading}
                  onRefresh={loadWorkspaceSnapshot}
                  onNavigate={navigate}
                />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {quickStartTiles.map((tile) => {
                    const Icon = tile.icon;
                    return (
                      <button
                        key={tile.to}
                        onClick={() => navigate(tile.to)}
                        className="group text-left rounded-2xl p-5 min-h-[132px] transition-all duration-200 hover:-translate-y-0.5"
                        style={{
	                          background: '#7A2E52',
                          border: '1px solid rgba(255,255,255,0.32)',
	                          boxShadow: 'none',
                        }}
                      >
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center mb-4 text-white"
                          style={{
	                            background: '#8A3A60',
                            border: '1px solid rgba(255,255,255,0.35)',
                          }}
                        >
                          <Icon size={18} />
                        </div>
                        <div className="text-[17px] font-semibold text-white leading-tight mb-1.5 flex items-center gap-1.5">
                          {tile.label}
                          <ArrowRight
                            size={14}
                            className="opacity-0 -translate-x-1 transition-all duration-200 group-hover:opacity-90 group-hover:translate-x-0"
                          />
                        </div>
                        <div className="text-[12px] text-white/80 leading-relaxed">{tile.description}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {capabilities.map((cap) => (
                <CapabilityCard key={cap.id} cap={cap} />
              ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        className="w-[460px] flex-shrink-0 flex flex-col overflow-y-auto relative"
        style={{ background: '#FFFFFF' }}
      >
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
	            backgroundImage: 'none',
            backgroundSize: '32px 32px',
	            maskImage: 'none',
	            WebkitMaskImage: 'none',
          }}
        />
        <div className="relative z-10 flex-1 px-9 py-10">
          <div className="mb-7">
            <h2 className="text-[22px] font-bold tracking-tight mb-1.5" style={{ color: '#1A0818' }}>
              {isConnected ? 'Connected workspace' : 'Start with your vault'}
            </h2>
            <p className="text-[13px] leading-relaxed" style={{ color: '#6B4A60' }}>
              {isConnected
                ? isVaultConnected
                  ? 'This session is using a saved vault profile. The browser only keeps a non-secret reference.'
                  : 'This session was created by an older connection path. Choose a saved vault instance before starting new work.'
                : 'Create or unlock your local encrypted vault, then choose the Omni instance you want to use.'}
            </p>
          </div>

          {isConnected ? (
            <div className="space-y-4">
              <div
                className="rounded-2xl p-5"
                style={{
                  background: '#FFFFFF',
                  border: '1px solid rgba(217,222,232,0.95)',
                  boxShadow: '0 6px 18px rgba(64,71,84,0.10)',
                }}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                    <CheckCircle size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold" style={{ color: '#1A0818' }}>
                      {connection.instanceLabel || parsedHost || 'Omni instance'}
                    </div>
                    <div className="mt-1 truncate text-[12px]" style={{ color: '#6B4A60' }}>
                      {connection.baseUrl}
                    </div>
                    <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-omni-50 px-2.5 py-1 text-[11px] font-semibold text-omni-700">
                      <ShieldCheck size={12} />
                      {isVaultConnected ? `Vault key ${connection.apiKeyMasked || 'masked'}` : 'Legacy session key'}
                    </div>
                  </div>
                </div>
                <div
                  className="mt-4 rounded-2xl overflow-hidden"
                  style={{
                    background: '#FFFFFF',
                    border: '1px solid rgba(217,222,232,0.95)',
                  }}
                >
                  <ConnectionAnimation status={connection.status} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => navigate('/dashboards/migrate')}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-150 hover:-translate-y-px"
                    style={{
                      background: '#C83B70',
                      color: '#FFFFFF',
                      boxShadow: '0 2px 6px -3px rgba(64,71,84,0.16)',
                    }}
                  >
                    Open dashboard
                    <ArrowRight size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={resetConnection}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-150 hover:-translate-y-px"
                    style={{
                      background: '#FFFFFF',
                      border: '1px solid rgba(217,222,232,0.95)',
                      color: '#6B4A60',
                    }}
                  >
                    Change
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div
                className="rounded-2xl p-5"
                style={{
                  background: '#FFFFFF',
                  border: '1px solid rgba(217,222,232,0.95)',
                  boxShadow: '0 6px 18px rgba(64,71,84,0.10)',
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-[14px] font-semibold" style={{ color: '#1A0818' }}>
                      <ShieldCheck size={16} className="text-omni-600" />
                      Local encrypted vault
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed" style={{ color: '#6B4A60' }}>
                      Save Omni URLs and API keys locally so users can pick from dropdowns instead of re-entering credentials.
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${vaultUnlocked ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
                    {vaultUnlocked ? 'Unlocked' : vaultStatus?.exists ? 'Locked' : 'New'}
                  </span>
                </div>

                {vaultError && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">{vaultError}</div>}
                {vaultMessage && <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-[12px] text-green-700">{vaultMessage}</div>}

                {!vaultUnlocked ? (
                  <div className="mt-4 space-y-3">
                    <input
                      type="password"
                      value={vaultPassphrase}
                      onChange={(event) => setVaultPassphrase(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && canUnlockVault) void handleVaultUnlock();
                      }}
                      className="input-field"
                      placeholder={vaultStatus?.exists ? 'Enter vault passphrase' : 'Create vault passphrase'}
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={handleVaultUnlock}
                      disabled={!canUnlockVault}
                      className="w-full btn-primary inline-flex items-center justify-center gap-2"
                    >
                      {vaultBusy ? <Loader2 size={15} className="animate-spin" /> : <UnlockKeyhole size={15} />}
                      {vaultStatus?.exists ? 'Unlock vault' : 'Create vault'}
                    </button>
                    <p className="text-[11px] leading-relaxed" style={{ color: '#8A6078' }}>
                      The passphrase never leaves your machine. The vault file lives under OmniKit's local data folder.
                    </p>
                  </div>
                ) : (
                  <div className="mt-4 space-y-4">
                    {savedInstances.length > 0 && (
                      <div className="space-y-2">
                        <label className="text-[12px] font-semibold" style={{ color: '#1A0818' }}>
                          Choose saved instance
                        </label>
                        <select
                          value={selectedInstance?.id || ''}
                          onChange={(event) => setSelectedInstanceId(event.target.value)}
                          className="input-field"
                        >
                          {savedInstances.map((instance) => (
                            <option key={instance.id} value={instance.id}>
                              {instance.label} — {instance.baseUrl}
                            </option>
                          ))}
                        </select>
                        {selectedInstance && (
                          <div className="rounded-xl border border-border-subtle bg-surface-subtle px-3 py-2 text-[11px]" style={{ color: '#6B4A60' }}>
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate">{selectedInstance.apiKeyMasked}</span>
                              <span className="rounded-full bg-white px-2 py-0.5 font-semibold text-content-secondary">
                                {selectedInstance.role === 'both' ? 'Source + destination' : selectedInstance.role}
                              </span>
                            </div>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleUseSavedInstance()}
                          disabled={vaultBusy || !selectedInstance}
                          className="w-full btn-primary inline-flex items-center justify-center gap-2"
                        >
                          {vaultBusy ? <Loader2 size={15} className="animate-spin" /> : <Server size={15} />}
                          Use & test selected instance
                        </button>
                      </div>
                    )}

                    {(showAddVaultInstance || savedInstances.length === 0) ? (
                      <div className="rounded-xl border border-border-subtle p-3">
                        <div className="text-[13px] font-semibold" style={{ color: '#1A0818' }}>
                          {savedInstances.length === 0 ? 'Add your first connection' : 'Add another connection'}
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed" style={{ color: '#8A6078' }}>
                          Only URL and API key are required. Model, folder, filters, and actions can be selected later.
                        </p>
                        <div className="mt-3 space-y-3">
                          <input
                            value={newVaultInstance.label}
                            onChange={(event) => setNewVaultInstance((prev) => ({ ...prev, label: event.target.value }))}
                            className="input-field"
                            placeholder="Label, optional"
                          />
                          <select
                            value={newVaultInstance.role}
                            onChange={(event) => setNewVaultInstance((prev) => ({ ...prev, role: event.target.value as InstanceRole }))}
                            className="input-field"
                          >
                            <option value="both">Use as source + destination</option>
                            <option value="source">Use as source only</option>
                            <option value="destination">Use as destination only</option>
                          </select>
                          <input
                            type="url"
                            value={newVaultInstance.baseUrl}
                            onChange={(event) => setNewVaultInstance((prev) => ({ ...prev, baseUrl: event.target.value }))}
                            className="input-field"
                            placeholder="https://your-org.omni.co"
                          />
                          <input
                            type="password"
                            value={newVaultInstance.apiKey}
                            onChange={(event) => setNewVaultInstance((prev) => ({ ...prev, apiKey: event.target.value }))}
                            className="input-field font-mono text-[13px]"
                            placeholder="API key"
                            autoComplete="new-password"
                            spellCheck={false}
                            autoCapitalize="off"
                          />
                          <button
                            type="button"
                            onClick={handleSaveAndUseVaultInstance}
                            disabled={!canSaveVaultInstance}
                            className="w-full btn-primary inline-flex items-center justify-center gap-2"
                          >
                            {vaultBusy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                            Save, test, and connect
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowAddVaultInstance(true)}
                        className="w-full btn-secondary inline-flex items-center justify-center gap-2"
                      >
                        <KeyRound size={15} />
                        Add another saved instance
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="mt-7 space-y-2">
            <TrustRow
              icon={<ShieldCheck size={14} />}
              title="Your data stays private"
              body="Credentials are masked, never stored, and used only by the OmniKit API proxy to reach your configured Omni instance."
            />
            <TrustRow
              icon={<Lock size={14} />}
              title="API key required"
              body="Find your API key in your Omni instance under Settings. Give it the permissions for the tools you plan to use."
            />
            <TrustRow
              icon={<HelpCircle size={14} />}
              title="Need help connecting?"
              body="Check the Omni documentation for authentication details and sample setup steps."
              href="https://docs.omni.co/docs/API/authentication"
            />
          </div>
        </div>
      </div>

      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

function TrustRow({
  icon,
  title,
  body,
  href,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  href?: string;
}) {
  const content = (
    <>
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{
	          background: '#F8F9FD',
          color: '#C83B70',
          border: '1px solid rgba(255,71,148,0.18)',
        }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold mb-0.5" style={{ color: '#1A0818' }}>
          {title}
        </p>
        <p className="text-[11px] leading-relaxed" style={{ color: '#6B4A60' }}>
          {body}
        </p>
      </div>
      {href && <ArrowRight size={12} className="flex-shrink-0 mt-1" style={{ color: '#C83B70', opacity: 0.6 }} />}
    </>
  );

  const baseClass = 'flex items-start gap-3 px-3.5 py-3 rounded-xl transition-all duration-150';
  const baseStyle = {
	    background: '#FFFFFF',
	    border: '1px solid rgba(217,222,232,0.95)',
  } as const;

  if (href) {
    return (
	      <a href={href} target="_blank" rel="noreferrer" className={`${baseClass} hover:border-border-strong`} style={baseStyle}>
        {content}
      </a>
    );
  }
  return (
    <div className={baseClass} style={baseStyle}>
      {content}
    </div>
  );
}
