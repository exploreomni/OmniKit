import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  CheckCircle,
  Loader2,
  ShieldCheck,
  Lock,
  KeyRound,
  ArrowRight,
  ArrowRightLeft,
  FolderInput,
  Cable,
  Database,
  Calendar,
  Users,
  Shield,
  HelpCircle,
  Presentation,
  LayoutDashboard,
  RefreshCw,
  Save,
  Server,
  UnlockKeyhole,
} from 'lucide-react';
import { listDocuments, listFolders, listGroups, listModels, listUsers, omniProxy } from '@/services/omniApi';
import { useConnection } from '@/hooks/useConnection';
import { useVaultSession } from '@/hooks/useVaultSession';
import { OmniKitLogo } from '@/components/brand/OmniKitLogo';
import { ConnectionAnimation } from '@/components/ui/ConnectionAnimation';
import { ConnectionFailureDetails } from '@/components/ui/ConnectionFailureDetails';
import { PassphraseInput } from '@/components/ui/PassphraseInput';
import { countWorkspaceSnapshotSemanticModels } from '@/services/workspaceSnapshot';
import {
  instanceConnectionDiagnosticFromError,
  type InstanceConnectionDiagnostic,
} from '@/services/instanceConnectionDiagnostics';
import {
  saveSavedInstance,
  type InstanceRole,
} from '@/services/opsConsole';
import { getConnectionCacheKey } from '@/services/connectionGuards';

type CapabilityIcon = typeof LayoutDashboard;

function parseHost(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.host || null;
  } catch {
    return null;
  }
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
  { label: 'Migrate dashboards', description: 'Remap dashboard models or copy to another instance', to: '/dashboards/migrate', icon: ArrowRightLeft },
  { label: 'Audit permissions', description: 'Review users and group access', to: '/admin/identity/users', icon: Shield },
  { label: 'Build a deck', description: 'Export dashboards to PowerPoint', to: '/deck-builder', icon: Presentation },
];

const commandCenterAreas = [
  { label: 'Content operations', detail: 'Dashboards, folders, and delivery', icon: LayoutDashboard },
  { label: 'Semantic administration', detail: 'Models, topics, and data connections', icon: Database },
  { label: 'Access and governance', detail: 'Users, groups, and policy checks', icon: Shield },
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

function describePassphraseStrength(passphrase: string) {
  const trimmed = passphrase.trim();
  if (!trimmed) return { label: 'Strength: waiting for passphrase', tone: 'text-content-tertiary' };

  const variety = [
    /[a-z]/.test(trimmed),
    /[A-Z]/.test(trimmed),
    /\d/.test(trimmed),
    /[^A-Za-z0-9]/.test(trimmed),
  ].filter(Boolean).length;
  const score = (trimmed.length >= 12 ? 1 : 0) + (trimmed.length >= 16 ? 1 : 0) + Math.min(variety, 3);

  if (score >= 4) return { label: 'Strength: strong', tone: 'text-emerald-700' };
  if (score >= 3) return { label: 'Strength: good', tone: 'text-amber-700' };
  return { label: 'Strength: basic. Use 12+ characters with a mix of character types.', tone: 'text-amber-800' };
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
    { label: 'Users', value: snapshot.users, detail: 'SCIM directory', icon: Users, to: '/admin/identity/users' },
    { label: 'Groups', value: snapshot.groups, detail: 'Access cohorts', icon: Shield, to: '/admin/identity/users?tab=groups' },
    { label: 'Schedules', value: snapshot.schedules, detail: 'Deliveries', icon: Calendar, to: '/admin/content/schedules' },
    { label: 'Folders', value: snapshot.folders, detail: 'Content spaces', icon: FolderInput, to: '/admin/content/labels' },
    { label: 'Connections', value: snapshot.connections, detail: 'Data sources', icon: Cable, to: '/admin/fleet/connections' },
  ];

  return (
    <section className="border-y border-border bg-surface-primary" aria-labelledby="workspace-snapshot-title">
      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-5">
        <div>
          <h2 id="workspace-snapshot-title" className="text-sm font-bold text-brand-wine">Workspace snapshot</h2>
          <p className="mt-1 text-xs text-content-secondary">
            Read-only summary from your connected Omni instance.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-button border border-border-strong bg-surface-primary text-brand-wine transition-colors hover:border-brand-wine hover:bg-omni-50 disabled:cursor-not-allowed disabled:opacity-60"
          aria-label={loading ? 'Refreshing workspace snapshot' : 'Refresh workspace snapshot'}
          title="Refresh workspace snapshot"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4 xl:grid-cols-7">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <button
              key={metric.label}
              type="button"
              onClick={() => onNavigate(metric.to)}
              className="group min-h-[112px] bg-surface-primary p-3 text-left transition-colors hover:bg-omni-50 focus-visible:relative focus-visible:z-10"
              aria-label={`${metric.label}: ${formatMetric(metric.value)}. Open ${metric.detail}.`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-omni-100 text-brand-wine">
                  <Icon size={15} aria-hidden="true" />
                </div>
                {loading && metric.value === null && <Loader2 size={13} className="animate-spin text-content-tertiary" aria-hidden="true" />}
              </div>
              <div className="mt-3 text-xl font-bold leading-none text-brand-wine">{formatMetric(metric.value)}</div>
              <div className="mt-1 text-xs font-semibold text-content-primary">{metric.label}</div>
              <div className="mt-0.5 text-[11px] text-content-tertiary">{metric.detail}</div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border bg-surface-secondary/45 px-4 py-2.5 text-[11px] text-content-tertiary sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <span>
          {snapshot.loadedAt
            ? `Last updated ${snapshot.loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
            : loading
              ? 'Loading workspace counts...'
              : 'Snapshot will load after connection.'}
        </span>
        {snapshot.failures.length > 0 && (
          <span className="text-amber-800">
            Limited permissions for: {snapshot.failures.join(', ')}
          </span>
        )}
      </div>
    </section>
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
    refreshStatus,
    refreshInstances,
  } = useVaultSession();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(EMPTY_SNAPSHOT);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotLoadedFor, setSnapshotLoadedFor] = useState('');
  const [selectedInstanceId, setSelectedInstanceId] = useState('');
  const [vaultPassphrase, setVaultPassphrase] = useState('');
  const [vaultPassphraseConfirm, setVaultPassphraseConfirm] = useState('');
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultMessage, setVaultMessage] = useState('');
  const [vaultError, setVaultError] = useState<InstanceConnectionDiagnostic | null>(null);
  const [newVaultInstance, setNewVaultInstance] = useState<NewVaultInstanceForm>(EMPTY_VAULT_INSTANCE_FORM);
  const [showAddVaultInstance, setShowAddVaultInstance] = useState(false);

  const connectionKey = getConnectionCacheKey(connection);
  const activeConnectionKeyRef = useRef(connectionKey);
  const selectedInstance = savedInstances.find((instance) => instance.id === selectedInstanceId) || savedInstances[0] || null;

  useEffect(() => {
    activeConnectionKeyRef.current = connectionKey;
  }, [connectionKey]);

  useEffect(() => {
    setSelectedInstanceId((current) => {
      if (current && savedInstances.some((instance) => instance.id === current)) return current;
      return savedInstances[0]?.id || '';
    });
  }, [savedInstances]);

  async function handleVaultUnlock() {
    setVaultBusy(true);
    setVaultError(null);
    setVaultMessage('');
    try {
      const beforeUnlockStatus = await refreshStatus().catch(() => vaultStatus);
      const hadExistingVault = Boolean(beforeUnlockStatus?.exists);
      const unlockResult = await unlockVault(vaultPassphrase);
      setVaultPassphrase('');
      setVaultPassphraseConfirm('');
      const instances = await refreshInstances();
      if (unlockResult.resumedInstance) {
        setVaultMessage(`Vault unlocked and resumed ${unlockResult.resumedInstance.label}.`);
      } else if (unlockResult.activeInstance) {
        setVaultMessage(`Vault unlocked and connected to ${unlockResult.activeInstance.label}.`);
      } else if (unlockResult.resetConnection) {
        setVaultMessage('Vault unlocked. Choose a saved instance to continue.');
      } else {
        setVaultMessage(hadExistingVault ? 'Vault unlocked. Choose a saved instance to connect.' : 'Vault created. Add your first Omni instance to continue.');
      }
      setShowAddVaultInstance(instances.length === 0);
    } catch (err) {
      setVaultError({ message: err instanceof Error ? err.message : 'Could not unlock the vault.' });
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleUseSavedInstance(instanceId = selectedInstance?.id || '') {
    if (!instanceId) return;
    setVaultBusy(true);
    setVaultError(null);
    setVaultMessage('');
    try {
      const instance = await connectInstance(instanceId);
      await refreshInstances();
      setVaultMessage(`Connected to ${instance.label}.`);
    } catch (err) {
      setVaultError(instanceConnectionDiagnosticFromError(err, 'Could not connect to the saved instance.'));
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleSaveAndUseVaultInstance() {
    setVaultBusy(true);
    setVaultError(null);
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
      setVaultError(instanceConnectionDiagnosticFromError(err, 'Could not save and test this instance.'));
    } finally {
      setVaultBusy(false);
    }
  }

  const loadWorkspaceSnapshot = useCallback(async () => {
    if (!connection.baseUrl || !connection.apiKey) return;
    const requestKey = connectionKey;
    setSnapshotLoading(true);

    try {
      // Connect spends one read-only burst on the workspace snapshot; batch before adding more probes.
      const documentsRes = await settle(listDocuments(connection.baseUrl, connection.apiKey, undefined, { allPages: true, pageSize: 250 }));
      const foldersRes = await settle(listFolders(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 }));
      const modelsRes = await settle(listModels(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100, modelKind: 'SHARED' }));
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

      if (activeConnectionKeyRef.current !== requestKey) return;

      setSnapshot({
        dashboards: Array.isArray(documentsPayload?.documents) ? documentsPayload.documents.length : null,
        folders: Array.isArray(foldersPayload?.folders) ? countNestedFolders(foldersPayload.folders) : null,
        models: countWorkspaceSnapshotSemanticModels(modelsPayload?.models),
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
      setSnapshotLoadedFor(requestKey);
    } finally {
      if (activeConnectionKeyRef.current === requestKey) setSnapshotLoading(false);
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
  const creatingVault = !vaultStatus?.exists;
  const passphraseStrength = useMemo(() => describePassphraseStrength(vaultPassphrase), [vaultPassphrase]);
  const passphraseMatches = !creatingVault || vaultPassphrase === vaultPassphraseConfirm;
  const canUnlockVault = Boolean(vaultPassphrase.trim())
    && !vaultBusy
    && (creatingVault ? vaultPassphrase.trim().length >= 8 && passphraseMatches : Boolean(vaultStatus?.exists));
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
        return { dot: '#7A6870', text: 'Awaiting credentials', pulse: false };
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
          body: connection.errorMessage || 'Return Home, unlock the vault, and choose a saved instance again. OmniKit keeps plaintext keys out of the browser.',
        };
      default:
        return {
          eyebrow: 'Omni Admin Toolkit',
          titleTop: 'Your Omni',
          titleBottom: 'command center.',
          body: 'A unified admin toolkit for every corner of your Omni analytics instance, from AI queries to governance.',
        };
    }
  }, [connection.errorMessage, connection.status]);

  return (
    <main className="min-h-full bg-[var(--omni-brand-warm)]">
      <div className="h-1 bg-[var(--omni-brand-pink)]" aria-hidden="true" />
      <div className="mx-auto flex min-h-[calc(100vh-4px)] w-full max-w-[1600px] flex-col px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
        <header className="flex flex-col gap-3 border-b border-[var(--omni-border)] pb-4 sm:flex-row sm:items-center sm:justify-between">
          <OmniKitLogo size="sm" subtitle="Home" />
          <div
            className="inline-flex max-w-full items-start gap-2 self-start rounded-full border border-[var(--omni-border)] bg-white px-3 py-2 sm:self-auto"
            role="status"
            aria-live="polite"
          >
            <span className="relative mt-1 flex h-2 w-2 shrink-0">
              {statusPill.pulse && (
                <span
                  className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                  style={{ background: statusPill.dot }}
                  aria-hidden="true"
                />
              )}
              <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: statusPill.dot }} aria-hidden="true" />
            </span>
            <span className="min-w-0 break-words text-xs font-medium text-content-secondary">{statusPill.text}</span>
          </div>
        </header>

        <div className="grid min-w-0 flex-1 gap-6 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)] lg:items-start xl:gap-10">
          <section className="min-w-0" aria-labelledby="home-vault-heading">
            <div className="overflow-hidden border-l-4 border-[var(--omni-brand-pink)] bg-[var(--omni-brand-wine)] text-white">
              <div className="grid min-w-0 items-center gap-4 px-5 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-7 sm:py-7">
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase text-white/70">{heroCopy.eyebrow}</p>
                  <h1 id="home-vault-heading" className="mt-2 max-w-3xl text-[32px] font-bold leading-[1.08] text-white sm:text-[40px]">
                    <span className="block">{heroCopy.titleTop}</span>
                    <span className="block">{heroCopy.titleBottom}</span>
                  </h1>
                  <p className="mt-4 max-w-2xl text-sm leading-6 text-white/80">{heroCopy.body}</p>
                  {connection.status === 'error' && connection.errorMessage && (
                    <div className="mt-4 max-w-2xl">
                      <ConnectionFailureDetails
                        message={connection.errorMessage}
                        code={connection.errorCode}
                        tone="inverse"
                      />
                    </div>
                  )}
                </div>
                <img
                  key={currentBlobby.src}
                  src={currentBlobby.src}
                  alt=""
                  className="mx-auto h-20 w-20 shrink-0 object-contain motion-safe:animate-float sm:h-24 sm:w-24"
                  style={{ animationDuration: connection.status === 'testing' ? '2.4s' : '3.2s' }}
                  aria-hidden="true"
                />
              </div>
            </div>

            {isConnected ? (
              <div className="mt-6 space-y-6">
                <WorkspaceSnapshotPanel
                  snapshot={snapshot}
                  loading={snapshotLoading}
                  onRefresh={loadWorkspaceSnapshot}
                  onNavigate={navigate}
                />
                <section aria-labelledby="quick-actions-title">
                  <div className="mb-3 flex items-end justify-between gap-3">
                    <div>
                      <h2 id="quick-actions-title" className="text-base font-bold text-[var(--omni-brand-wine)]">Quick actions</h2>
                      <p className="mt-1 text-xs text-content-secondary">Continue with the connected workspace.</p>
                    </div>
                  </div>
                  <div className="divide-y divide-[var(--omni-border)] border-y border-[var(--omni-border)] bg-white">
                    {quickStartTiles.map((tile) => {
                      const Icon = tile.icon;
                      return (
                        <button
                          key={tile.to}
                          type="button"
                          onClick={() => navigate(tile.to)}
                          className="group flex min-h-[76px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[#FFF4F8] sm:px-5"
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[7px] bg-[#FFE3EE] text-[var(--omni-brand-wine)]">
                            <Icon size={17} aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-content-primary">{tile.label}</span>
                            <span className="mt-0.5 block text-xs leading-5 text-content-secondary">{tile.description}</span>
                          </span>
                          <ArrowRight size={15} className="shrink-0 text-[var(--omni-brand-pink-hover)] transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>
            ) : (
              <section className="mt-6" aria-labelledby="command-center-scope-title">
                <div className="mb-3">
                  <h2 id="command-center-scope-title" className="text-base font-bold text-[var(--omni-brand-wine)]">Command center scope</h2>
                  <p className="mt-1 text-xs text-content-secondary">Operational work areas activate after an instance is connected.</p>
                </div>
                <div className="divide-y divide-[var(--omni-border)] border-y border-[var(--omni-border)] bg-white">
                  {commandCenterAreas.map((area) => {
                    const Icon = area.icon;
                    return (
                      <div key={area.label} className="flex min-h-[76px] items-center gap-3 px-4 py-3 sm:px-5">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[7px] bg-[#FFE3EE] text-[var(--omni-brand-wine)]">
                          <Icon size={17} aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-content-primary">{area.label}</span>
                          <span className="mt-0.5 block text-xs leading-5 text-content-secondary">{area.detail}</span>
                        </span>
                        <span className="shrink-0 text-[11px] font-semibold text-content-tertiary">Awaiting connection</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </section>

          <div className="min-w-0 space-y-4 lg:sticky lg:top-6">
          <aside className="min-w-0 overflow-hidden rounded-card border border-[var(--omni-border)] bg-surface-primary shadow-card" aria-labelledby="vault-panel-title">
            <div className="h-1 bg-[var(--omni-brand-pink)]" aria-hidden="true" />
            <div className="px-5 py-5 sm:px-6 sm:py-6">
              <div className="mb-5">
                <h2 id="vault-panel-title" className="text-xl font-bold text-[var(--omni-brand-wine)]">
                  {isConnected ? 'Connected workspace' : 'Vault access'}
                </h2>
                <p className="mt-1.5 text-xs leading-5 text-content-secondary">
                  {isConnected
                    ? isVaultConnected
                      ? 'This session is using a saved vault profile. The browser only keeps a non-secret reference.'
                      : 'This session was created by an older connection path. Choose a saved vault instance before starting new work.'
                    : 'Unlock the local vault, then select the Omni instance for this session.'}
                </p>
              </div>

              {isConnected ? (
                <div>
                  <div className="flex items-start gap-3 border-y border-[var(--omni-border)] bg-[#FBFFF8] py-4">
                    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[7px] bg-emerald-50 text-emerald-700">
                      <CheckCircle size={17} aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-content-primary">
                        {connection.instanceLabel || parsedHost || 'Omni instance'}
                      </div>
                      <div className="mt-1 break-all text-xs text-content-secondary">{connection.baseUrl}</div>
                      <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full bg-[#FFF0F5] px-2.5 py-1 text-[11px] font-semibold text-[var(--omni-brand-wine)]">
                        <ShieldCheck size={12} className="shrink-0" aria-hidden="true" />
                        <span className="truncate">{isVaultConnected ? `Vault key ${connection.apiKeyMasked || 'masked'}` : 'Saved instance required'}</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 overflow-hidden border-y border-[var(--omni-border)] bg-white">
                    <ConnectionAnimation status={connection.status} />
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                    <button type="button" onClick={() => navigate('/dashboards/migrate')} className="btn-primary justify-center">
                      Open dashboard
                      <ArrowRight size={13} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={resetConnection} className="btn-secondary justify-center">
                      Change instance
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-start justify-between gap-3 border-y border-[var(--omni-border)] bg-[#FFFBF9] py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                        <ShieldCheck size={16} className="shrink-0 text-[var(--omni-brand-wine)]" aria-hidden="true" />
                        Local encrypted vault
                      </div>
                      <p className="mt-1 text-xs leading-5 text-content-secondary">
                        Credentials stay encrypted locally and are referenced by saved instance.
                      </p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${vaultUnlocked ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
                      {vaultUnlocked ? 'Unlocked' : vaultStatus?.exists ? 'Locked' : 'New'}
                    </span>
                  </div>

                  {vaultError && (
                    <div className="mt-4">
                      <ConnectionFailureDetails message={vaultError.message} code={vaultError.code} />
                    </div>
                  )}
                  {vaultMessage && <div className="mt-4 rounded-[7px] border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700" role="status">{vaultMessage}</div>}

	                {!vaultUnlocked ? (
	                  <form
                      className="mt-4 space-y-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (canUnlockVault) void handleVaultUnlock();
                      }}
                    >
                      <label className="block text-xs font-semibold text-content-primary">
                        <span className="mb-1.5 block">{vaultStatus?.exists ? 'Vault passphrase' : 'Create passphrase'}</span>
                        <PassphraseInput
                          value={vaultPassphrase}
                          onChange={setVaultPassphrase}
                          placeholder={vaultStatus?.exists ? 'Enter vault passphrase' : 'At least 8 characters'}
                          autoComplete={vaultStatus?.exists ? 'current-password' : 'new-password'}
                        />
                      </label>
	                    {creatingVault && (
	                      <>
	                        <label className="block text-xs font-semibold text-content-primary">
                              <span className="mb-1.5 block">Confirm passphrase</span>
                              <PassphraseInput
                                value={vaultPassphraseConfirm}
                                onChange={setVaultPassphraseConfirm}
                                placeholder="Re-enter passphrase"
                                autoComplete="new-password"
                              />
                            </label>
	                        <div className="rounded-[7px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
	                          This passphrase cannot be recovered. Store it in your password manager before saving credentials.
	                        </div>
	                        <div className={`text-[11px] font-medium ${passphraseStrength.tone}`} aria-live="polite">
	                          {passphraseStrength.label}
	                        </div>
	                        {vaultPassphraseConfirm && !passphraseMatches && (
	                          <div className="text-[11px] font-medium text-red-700" role="alert">
	                            Passphrases do not match.
	                          </div>
	                        )}
	                      </>
	                    )}
	                    <button
	                      type="submit"
	                      disabled={!canUnlockVault}
	                      className="w-full btn-primary inline-flex items-center justify-center gap-2"
	                    >
	                      {vaultBusy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <UnlockKeyhole size={15} aria-hidden="true" />}
	                      {vaultStatus?.exists ? 'Unlock vault' : 'Create vault'}
	                    </button>
	                    <p className="text-[11px] leading-relaxed text-content-tertiary">
	                      The passphrase never leaves your machine. The vault file lives under OmniKit's local data folder.
	                    </p>
	                  </form>
	                ) : (
	                  <div className="mt-4 space-y-5">
	                    {savedInstances.length > 0 && (
	                      <div className="space-y-2.5">
	                        <label htmlFor="saved-vault-instance" className="text-xs font-semibold text-content-primary">
	                          Choose saved instance
	                        </label>
	                        <select
                              id="saved-vault-instance"
	                          value={selectedInstance?.id || ''}
	                          onChange={(event) => setSelectedInstanceId(event.target.value)}
	                          className="input-field"
	                        >
	                          {savedInstances.map((instance) => (
	                            <option key={instance.id} value={instance.id}>
	                              {instance.label} - {instance.baseUrl}
	                            </option>
	                          ))}
	                        </select>
	                        {selectedInstance && (
	                          <div className="border-y border-[var(--omni-border)] bg-[var(--omni-brand-warm)] px-3 py-2 text-[11px] text-content-secondary">
	                            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
	                              <span className="truncate">{selectedInstance.apiKeyMasked}</span>
	                              <span className="font-semibold text-[var(--omni-brand-wine)]">
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
	                          {vaultBusy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Server size={15} aria-hidden="true" />}
	                          Use and test selected instance
	                        </button>
	                      </div>
	                    )}

	                    {(showAddVaultInstance || savedInstances.length === 0) ? (
	                      <section className="border-t border-[var(--omni-border)] pt-5" aria-labelledby="add-vault-instance-title">
	                        <h3 id="add-vault-instance-title" className="text-sm font-semibold text-[var(--omni-brand-wine)]">
	                          {savedInstances.length === 0 ? 'Add your first connection' : 'Add another connection'}
	                        </h3>
	                        <p className="mt-1 text-[11px] leading-relaxed text-content-tertiary">
	                          Only URL and API key are required. Model, folder, filters, and actions can be selected later.
	                        </p>
	                        <form
                              className="mt-3 space-y-3"
                              onSubmit={(event) => {
                                event.preventDefault();
                                if (canSaveVaultInstance) void handleSaveAndUseVaultInstance();
                              }}
                            >
                              <label htmlFor="vault-instance-label" className="block text-xs font-semibold text-content-primary">
                                <span className="mb-1.5 block">Instance label <span className="font-normal text-content-tertiary">(optional)</span></span>
	                            <input
                                  id="vault-instance-label"
	                              value={newVaultInstance.label}
	                              onChange={(event) => setNewVaultInstance((prev) => ({ ...prev, label: event.target.value }))}
	                              className="input-field"
	                              placeholder="Production"
	                            />
                              </label>
                              <label htmlFor="vault-instance-role" className="block text-xs font-semibold text-content-primary">
                                <span className="mb-1.5 block">Instance role</span>
	                            <select
                                  id="vault-instance-role"
	                              value={newVaultInstance.role}
	                              onChange={(event) => setNewVaultInstance((prev) => ({ ...prev, role: event.target.value as InstanceRole }))}
	                              className="input-field"
	                            >
	                              <option value="both">Use as source + destination</option>
	                              <option value="source">Use as source only</option>
	                              <option value="destination">Use as destination only</option>
	                            </select>
                              </label>
                              <label htmlFor="vault-instance-url" className="block text-xs font-semibold text-content-primary">
                                <span className="mb-1.5 block">Omni URL</span>
	                            <input
                                  id="vault-instance-url"
	                              type="url"
	                              value={newVaultInstance.baseUrl}
	                              onChange={(event) => setNewVaultInstance((prev) => ({ ...prev, baseUrl: event.target.value }))}
	                              className="input-field"
	                              placeholder="https://your-org.omni.co"
                                  autoComplete="url"
                                  required
                                  aria-invalid={Boolean(newVaultInstance.baseUrl && !newInstanceHost)}
	                            />
                              </label>
                              <label htmlFor="vault-instance-api-key" className="block text-xs font-semibold text-content-primary">
                                <span className="mb-1.5 block">API key</span>
	                            <input
                                  id="vault-instance-api-key"
	                              type="password"
	                              value={newVaultInstance.apiKey}
	                              onChange={(event) => setNewVaultInstance((prev) => ({ ...prev, apiKey: event.target.value }))}
	                              className="input-field font-mono text-[13px]"
	                              placeholder="Enter API key"
	                              autoComplete="new-password"
	                              spellCheck={false}
	                              autoCapitalize="off"
                                  required
	                            />
                              </label>
	                          <button
	                            type="submit"
	                            disabled={!canSaveVaultInstance}
	                            className="w-full btn-primary inline-flex items-center justify-center gap-2"
	                          >
	                            {vaultBusy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
	                            Save, test, and connect
	                          </button>
	                        </form>
	                      </section>
	                    ) : (
	                      <button
                        type="button"
                        onClick={() => setShowAddVaultInstance(true)}
	                        className="w-full btn-secondary inline-flex items-center justify-center gap-2"
	                      >
	                        <KeyRound size={15} aria-hidden="true" />
	                        Add another saved instance
	                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            </div>
          </aside>

          <div className="mt-7 space-y-2">
            <TrustRow
              icon={<ShieldCheck size={14} />}
              title="Your data stays private"
              body="Credentials are encrypted in the native vault. The browser only receives a masked key and a non-secret reference."
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
      </div>
    </main>
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
      <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-button border border-border bg-omni-50 text-omni-800">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold mb-0.5 text-content-primary">
          {title}
        </p>
        <p className="text-[11px] leading-relaxed text-content-secondary">
          {body}
        </p>
      </div>
      {href && <ArrowRight size={12} className="flex-shrink-0 mt-1 text-omni-600 opacity-60" />}
    </>
  );

  const baseClass = 'flex items-start gap-3 px-3.5 py-3 rounded-card transition-colors duration-150';
  const baseStyle = {
    background: 'var(--omni-brand-warm)',
    border: '1px solid var(--omni-border)',
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
