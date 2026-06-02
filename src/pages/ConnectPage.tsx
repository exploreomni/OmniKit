import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle,
  XCircle,
  Loader2,
  Wifi,
  ShieldCheck,
  Lock,
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
} from 'lucide-react';
import { listDocuments, listFolders, listGroups, listModels, listUsers, omniProxy, testConnection } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { OmniKitLogo } from '@/components/brand/OmniKitLogo';
import { ConnectionAnimation } from '@/components/ui/ConnectionAnimation';

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

function isRecognizedOmniHost(host: string | null) {
  if (!host) return false;
  return /(^|\.)((explore)?omni\.dev|omni\.co|exploreomni\.dev)$/i.test(host);
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
  const { connection, updateConnection, isConnected, setStatus } = useConnection();
  const [testing, setTesting] = useState(false);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(EMPTY_SNAPSHOT);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotLoadedFor, setSnapshotLoadedFor] = useState('');

  const connectionKey = `${connection.baseUrl.trim()}|${connection.apiKey ? 'key-present' : 'no-key'}`;

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

  async function handleTest() {
    if (!connection.baseUrl || !connection.apiKey) return;
    setTesting(true);
    setStatus('testing');

    try {
      const result = await testConnection(connection.baseUrl, connection.apiKey);
      if (result.status === 'ok') {
        setStatus('success');
      } else {
        setStatus('error', result.message || 'Connection failed.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not connect. Check your base URL and API key.';
      setStatus('error', message);
    } finally {
      setTesting(false);
    }
  }

  function handleFieldKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && connection.baseUrl && connection.apiKey && !testing) {
      e.preventDefault();
      handleTest();
    }
  }

  const parsedHost = useMemo(() => parseHost(connection.baseUrl), [connection.baseUrl]);
  const hostNeedsReview = Boolean(parsedHost && !isRecognizedOmniHost(parsedHost));
  const urlValid = Boolean(parsedHost);
  const apiKeyHasValidShape = connection.apiKey.trim().length >= 12;
  const canTest = urlValid && apiKeyHasValidShape && !testing;

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
          body: 'Pick the workflow you want to start. OmniKit will keep using this connection while the tab stays open.',
        };
      case 'error':
        return {
          eyebrow: 'Connection needs attention',
          titleTop: "Let's get you",
          titleBottom: 'connected.',
          body: 'Check the URL and API key, then test again. OmniKit will keep your key masked the whole time.',
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
            <OmniKitLogo variant="light" size="sm" subtitle="Connect" />
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
                    <span>No data stored</span>
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
              {isConnected ? 'Signed in' : 'Get connected'}
            </h2>
            <p className="text-[13px] leading-relaxed" style={{ color: '#6B4A60' }}>
              {isConnected
                ? 'Your instance is connected. Credentials stay masked and session-scoped.'
                : 'Enter your Omni instance URL and API key. Credentials are held in browser memory for this session.'}
            </p>
          </div>

          <div
            className="rounded-2xl p-5 mb-4"
            style={{
              background: '#FFFFFF',
              border: '1px solid rgba(217,222,232,0.95)',
              boxShadow: '0 6px 18px rgba(64,71,84,0.10)',
            }}
          >
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="base-url" className="text-[12px] font-semibold" style={{ color: '#1A0818' }}>
                    Base URL
                  </label>
                  {connection.baseUrl && (
                    <span className={`text-[10px] font-medium ${urlValid ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {urlValid ? 'Valid' : 'Check format'}
                    </span>
                  )}
                </div>
                <div className="relative">
                  <input
                    id="base-url"
                    type="url"
                    value={connection.baseUrl}
                    onChange={(e) => updateConnection({ baseUrl: e.target.value, status: 'untested' })}
                    onKeyDown={handleFieldKeyDown}
                    placeholder="https://your-org.omni.co"
                    className="input-field pr-9"
                    aria-describedby="base-url-hint"
                  />
                  {connection.baseUrl && urlValid && (
                    <CheckCircle
                      size={15}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-500"
                      aria-hidden
                    />
                  )}
                </div>
                <p id="base-url-hint" className="text-[11px] mt-1.5" style={{ color: '#8A6078' }}>
                  {parsedHost ? (
                    <>
                      Will connect to{' '}
                      <span className="font-mono font-medium" style={{ color: '#C83B70' }}>
                        {parsedHost}
                      </span>
                    </>
                  ) : (
                    'Your Omni workspace URL, including https://'
                  )}
                </p>
                {hostNeedsReview && (
                  <p className="mt-1.5 rounded-button border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800">
                    Confirm this is a trusted Omni host before testing. OmniKit keeps the key masked, but the API call will be sent to this URL.
                  </p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="api-key"
                    className="text-[12px] font-semibold flex items-center gap-1"
                    style={{ color: '#1A0818' }}
                  >
                    API Key
                    <a
                      href="https://docs.omni.co/docs/API/authentication"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex text-content-tertiary hover:text-omni-700 transition-colors"
                      aria-label="Where do I find my API key?"
                    >
                      <HelpCircle size={12} />
                    </a>
                  </label>
                  <span className="text-[10px] font-medium" style={{ color: '#8A6078' }}>
                    Settings → API
                  </span>
                </div>
                <div className="relative">
	                  <input
	                    id="api-key"
	                    type="password"
	                    value={connection.apiKey}
	                    onChange={(e) => updateConnection({ apiKey: e.target.value, status: 'untested' })}
	                    onKeyDown={handleFieldKeyDown}
	                    placeholder="Paste your API key"
	                    className="input-field pr-10 font-mono text-[13px]"
	                    autoComplete="new-password"
	                    spellCheck={false}
	                    autoCapitalize="off"
	                    aria-describedby="api-key-hint"
	                  />
	                  <Lock
	                    size={14}
	                    className="absolute right-3 top-1/2 -translate-y-1/2 text-content-tertiary"
	                    aria-hidden
	                  />
	                </div>
	                <p id="api-key-hint" className="text-[11px] mt-1.5" style={{ color: '#8A6078' }}>
	                  Always masked in OmniKit. Held in browser memory and cleared when the tab closes.
	                </p>
              </div>
            </div>
          </div>

          <button
            onClick={handleTest}
            disabled={!canTest && connection.status !== 'success'}
            className="w-full relative flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-[13px] font-semibold transition-all duration-200 text-white disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:-translate-y-px enabled:hover:brightness-110 enabled:active:translate-y-0 overflow-hidden"
            style={{
	              background: connection.status === 'success' ? '#10B981' : '#C83B70',
	              boxShadow: 'none',
            }}
          >
            {testing && (
              <span
                aria-hidden
                className="absolute inset-0 opacity-40"
                style={{
	                  background: 'transparent',
	                  backgroundSize: '200% 100%',
	                  animation: 'none',
                }}
              />
            )}
            <span className="relative flex items-center gap-2">
              {testing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : connection.status === 'success' ? (
                <CheckCircle size={14} />
              ) : (
                <Wifi size={14} />
              )}
              {testing
                ? 'Testing connection…'
                : connection.status === 'success'
                ? 'Connected'
                : 'Test Connection'}
            </span>
            {!testing && connection.status !== 'success' && canTest && (
              <span
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-medium px-1.5 py-0.5 rounded border border-white/30 text-white/80"
                aria-hidden
              >
                Enter
              </span>
            )}
          </button>

          <div className="mt-3 flex items-center justify-center gap-2 text-[12px]" aria-live="polite">
            {connection.status === 'untested' && (
              <>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(155,48,101,0.3)' }} />
                <span style={{ color: 'rgba(155,48,101,0.6)' }}>Not tested yet</span>
              </>
            )}
            {connection.status === 'testing' && (
              <>
                <Loader2 size={12} className="animate-spin" style={{ color: '#E4477C' }} />
                <span style={{ color: '#E4477C' }} className="font-medium">
                  Verifying credentials…
                </span>
              </>
            )}
            {connection.status === 'success' && (
              <>
                <CheckCircle size={12} className="text-emerald-500" />
                <span className="text-emerald-600 font-medium">Successfully connected</span>
              </>
            )}
            {connection.status === 'error' && (
              <>
                <XCircle size={12} className="text-red-500" />
                <span className="text-red-600 font-medium truncate max-w-[320px]">
                  {connection.errorMessage || 'Connection failed'}
                </span>
              </>
            )}
          </div>

          {connection.status !== 'untested' && (
            <div
              className="mt-4 rounded-2xl overflow-hidden"
              style={{
	                background: '#FFFFFF',
	                border: '1px solid rgba(217,222,232,0.95)',
              }}
            >
              <ConnectionAnimation status={connection.status} />
            </div>
          )}

          {isConnected && (
            <button
              onClick={() => navigate('/dashboards/migrate')}
              className="w-full mt-4 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-150 hover:-translate-y-px"
              style={{
                background: '#FFFFFF',
                border: '1px solid rgba(255,71,148,0.3)',
                color: '#C83B70',
                boxShadow: '0 2px 6px -3px rgba(64,71,84,0.16)',
              }}
            >
              Open dashboard
              <ArrowRight size={13} />
            </button>
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
