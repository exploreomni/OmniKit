import { useMemo, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Eye,
  EyeOff,
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
  Copy,
  Check,
  Presentation,
  ChevronRight,
} from 'lucide-react';
import { testConnection } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';

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
      className="group relative rounded-2xl p-4 transition-all duration-200 hover:-translate-y-0.5"
      style={{
        background: 'linear-gradient(140deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 100%)',
        border: '1px solid rgba(255,255,255,0.22)',
        backdropFilter: 'blur(10px)',
        boxShadow: '0 4px 20px -6px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.15)',
      }}
    >
      <div
        aria-hidden
        className="absolute inset-0 rounded-2xl pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{ border: '1px solid rgba(255,255,255,0.35)' }}
      />
      <div className="relative flex items-start justify-between mb-3">
        <div className="flex gap-1">
          {cap.icons.slice(0, 4).map((Icon, i) => (
            <div
              key={i}
              className="w-6 h-6 rounded-lg flex items-center justify-center transition-transform duration-300 group-hover:translate-x-0.5"
              style={{
                background: 'linear-gradient(135deg, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0.12) 100%)',
                border: '1px solid rgba(255,255,255,0.35)',
                color: '#FFFFFF',
                transitionDelay: `${i * 40}ms`,
              }}
            >
              <Icon size={12} />
            </div>
          ))}
        </div>
        <span
          className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full"
          style={{
            background: 'rgba(255,255,255,0.18)',
            color: 'rgba(255,255,255,0.95)',
            border: '1px solid rgba(255,255,255,0.25)',
          }}
        >
          {cap.count} tools
        </span>
      </div>
      <div className="relative">
        <h3 className="text-[15px] font-semibold text-white leading-tight mb-1 flex items-center gap-1.5">
          {cap.title}
          <ChevronRight
            size={14}
            className="opacity-0 -translate-x-1 transition-all duration-200 group-hover:opacity-90 group-hover:translate-x-0 text-white/90"
          />
        </h3>
        <p className="text-[12px] leading-relaxed text-white/80">{cap.blurb}</p>
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

const quickStartTiles: QuickStartTile[] = [
  { label: 'Migrate dashboards', description: 'Move content between instances', to: '/dashboards/migrate', icon: ArrowRightLeft },
  { label: 'Audit permissions', description: 'Review users and group access', to: '/users', icon: Shield },
  { label: 'Build a deck', description: 'Export dashboards to PowerPoint', to: '/deck-builder', icon: Presentation },
];

export function ConnectPage() {
  const navigate = useNavigate();
  const { connection, updateConnection, isConnected, setStatus } = useConnection();
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);

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
  const urlValid = Boolean(parsedHost);
  const apiKeyHasValidShape = connection.apiKey.trim().length >= 12;
  const canTest = urlValid && apiKeyHasValidShape && !testing;

  const blobbyConfig = {
    untested: { src: '/blobby-waving.webp', alt: 'Blobby waving hello' },
    testing: { src: '/blobby-in-progress.webp', alt: 'Blobby connecting' },
    success: { src: '/blobby-celebrating.webp', alt: 'Blobby celebrating connection' },
    error: { src: '/blobby-error.webp', alt: 'Blobby connection error' },
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

  async function copyApiKey() {
    if (!connection.apiKey) return;
    try {
      await navigator.clipboard.writeText(connection.apiKey);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 1500);
    } catch {
      // ignore
    }
  }

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
            backgroundImage: `radial-gradient(circle, rgba(255,255,255,0.10) 1px, transparent 1px)`,
            backgroundSize: '34px 34px',
            maskImage: 'radial-gradient(ellipse at center, black 40%, transparent 85%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 40%, transparent 85%)',
          }}
        />
        <div
          aria-hidden
          className="absolute -top-24 -right-24 w-[520px] h-[520px] rounded-full pointer-events-none animate-float"
          style={{
            background: 'radial-gradient(circle, rgba(255,200,225,0.28) 0%, transparent 65%)',
            animationDuration: '9s',
          }}
        />
        <div
          aria-hidden
          className="absolute -bottom-32 -left-24 w-[460px] h-[460px] rounded-full pointer-events-none animate-float"
          style={{
            background: 'radial-gradient(circle, rgba(255,120,170,0.22) 0%, transparent 70%)',
            animationDuration: '11s',
            animationDelay: '1.5s',
          }}
        />

        <div className="relative z-10 max-w-2xl mx-auto w-full">
          <div className="flex items-center justify-between mb-10">
            <div className="flex items-center gap-2.5">
              <img src="/omni-logo.webp" alt="Omni" className="h-5 w-auto object-contain brightness-0 invert" />
              <div className="h-4 w-px bg-white/30" />
              <span className="text-[12px] font-semibold tracking-wide text-white/90 uppercase">OmniKit · Connect</span>
            </div>
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-full"
              style={{
                background: 'rgba(255,255,255,0.12)',
                border: '1px solid rgba(255,255,255,0.22)',
                backdropFilter: 'blur(8px)',
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
                  style={{ background: statusPill.dot, boxShadow: `0 0 8px ${statusPill.dot}` }}
                />
              </span>
              <span className="text-[11px] font-medium text-white/90">{statusPill.text}</span>
            </div>
          </div>

          {!isConnected && (
            <div className="mb-10">
              <div className="flex items-end gap-5 mb-5">
                <div className="relative flex-shrink-0">
                  <div
                    aria-hidden
                    className="absolute inset-0 rounded-full"
                    style={{
                      background: 'radial-gradient(circle, rgba(255,255,255,0.3) 0%, transparent 65%)',
                      transform: 'scale(2.2)',
                    }}
                  />
                  <img
                    key={currentBlobby.src}
                    src={currentBlobby.src}
                    alt={currentBlobby.alt}
                    className="w-24 h-24 object-contain relative z-10 animate-float"
                    style={{ animationDuration: '3.5s' }}
                  />
                </div>
                <div className="pb-2">
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/70 mb-2">
                    Omni Admin Toolkit
                  </p>
                  <h1 className="text-[44px] font-bold leading-[1.02] tracking-tight text-white">
                    Your Omni
                    <br />
                    <span className="bg-gradient-to-r from-white to-white/75 bg-clip-text text-transparent">
                      command center.
                    </span>
                  </h1>
                </div>
              </div>
              <p className="text-[14px] leading-relaxed text-white/85 max-w-md mb-4">
                A unified admin toolkit for every corner of your Omni analytics instance — from AI queries to governance.
              </p>
              <div className="flex items-center gap-3 text-[11px] text-white/75 font-medium">
                <span>15 tools</span>
                <span className="w-1 h-1 rounded-full bg-white/40" />
                <span>No data stored</span>
                <span className="w-1 h-1 rounded-full bg-white/40" />
                <span>Works offline-ready</span>
              </div>
            </div>
          )}

          {isConnected && (
            <div className="mb-8 animate-fadeIn">
              <div className="flex items-end gap-5 mb-5">
                <div className="relative flex-shrink-0">
                  <div
                    aria-hidden
                    className="absolute inset-0 rounded-full"
                    style={{
                      background: 'radial-gradient(circle, rgba(52,211,153,0.35) 0%, transparent 65%)',
                      transform: 'scale(2.4)',
                    }}
                  />
                  <img
                    src="/blobby-celebrating.webp"
                    alt="Blobby celebrating"
                    className="w-24 h-24 object-contain relative z-10 animate-float"
                    style={{ animationDuration: '3s' }}
                  />
                </div>
                <div className="pb-2">
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/70 mb-2">
                    You're in
                  </p>
                  <h1 className="text-[40px] font-bold leading-[1.02] tracking-tight text-white">
                    What would you like<br />to do first?
                  </h1>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {quickStartTiles.map((tile) => {
                  const Icon = tile.icon;
                  return (
                    <button
                      key={tile.to}
                      onClick={() => navigate(tile.to)}
                      className="group text-left rounded-2xl p-4 transition-all duration-200 hover:-translate-y-0.5"
                      style={{
                        background: 'linear-gradient(140deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.08) 100%)',
                        border: '1px solid rgba(255,255,255,0.28)',
                        backdropFilter: 'blur(10px)',
                        boxShadow: '0 4px 20px -6px rgba(0,0,0,0.18)',
                      }}
                    >
                      <div
                        className="w-9 h-9 rounded-xl flex items-center justify-center mb-3 text-white"
                        style={{
                          background: 'linear-gradient(135deg, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0.1) 100%)',
                          border: '1px solid rgba(255,255,255,0.35)',
                        }}
                      >
                        <Icon size={16} />
                      </div>
                      <div className="text-[14px] font-semibold text-white leading-tight mb-1 flex items-center gap-1.5">
                        {tile.label}
                        <ArrowRight
                          size={13}
                          className="opacity-0 -translate-x-1 transition-all duration-200 group-hover:opacity-90 group-hover:translate-x-0"
                        />
                      </div>
                      <div className="text-[11px] text-white/75 leading-snug">{tile.description}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {!isConnected && (
            <div className="grid grid-cols-3 gap-3">
              {capabilities.map((cap) => (
                <CapabilityCard key={cap.id} cap={cap} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div
        className="w-[460px] flex-shrink-0 flex flex-col overflow-y-auto relative"
        style={{ background: 'linear-gradient(180deg, #FFFFFF 0%, #FFF7FB 100%)' }}
      >
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `radial-gradient(circle, rgba(255,71,148,0.07) 1px, transparent 1px)`,
            backgroundSize: '32px 32px',
            maskImage: 'radial-gradient(ellipse at top, black 30%, transparent 80%)',
            WebkitMaskImage: 'radial-gradient(ellipse at top, black 30%, transparent 80%)',
          }}
        />
        <div className="relative z-10 flex-1 px-9 py-10">
          <div className="mb-7">
            <h2 className="text-[22px] font-bold tracking-tight mb-1.5" style={{ color: '#1A0818' }}>
              {isConnected ? 'Signed in' : 'Get connected'}
            </h2>
            <p className="text-[13px] leading-relaxed" style={{ color: '#6B4A60' }}>
              {isConnected
                ? 'Your instance is connected. Credentials never leave this browser.'
                : 'Enter your Omni instance URL and API key. Credentials are held in browser memory only.'}
            </p>
          </div>

          <div
            className="rounded-2xl p-5 mb-4"
            style={{
              background: '#FFFFFF',
              border: '1px solid rgba(255,71,148,0.15)',
              boxShadow:
                '0 6px 24px -12px rgba(200,24,106,0.18), 0 2px 6px -2px rgba(200,24,106,0.06)',
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
                      <span className="font-mono font-medium" style={{ color: '#C8186A' }}>
                        {parsedHost}
                      </span>
                    </>
                  ) : (
                    'Your Omni workspace URL, including https://'
                  )}
                </p>
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
                    type={showKey ? 'text' : 'password'}
                    value={connection.apiKey}
                    onChange={(e) => updateConnection({ apiKey: e.target.value, status: 'untested' })}
                    onKeyDown={handleFieldKeyDown}
                    placeholder="Paste your API key"
                    className="input-field pr-20 font-mono text-[13px]"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    {connection.apiKey && (
                      <button
                        type="button"
                        onClick={copyApiKey}
                        className="p-1.5 rounded-md text-content-tertiary hover:text-omni-700 hover:bg-pink-50 transition-colors"
                        aria-label="Copy API key"
                      >
                        {keyCopied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="p-1.5 rounded-md text-content-tertiary hover:text-omni-700 hover:bg-pink-50 transition-colors"
                      aria-label={showKey ? 'Hide API key' : 'Show API key'}
                    >
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
                <p className="text-[11px] mt-1.5" style={{ color: '#8A6078' }}>
                  Kept in browser memory only. Cleared when the tab closes.
                </p>
              </div>
            </div>
          </div>

          <button
            onClick={handleTest}
            disabled={!canTest && connection.status !== 'success'}
            className="w-full relative flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-[13px] font-semibold transition-all duration-200 text-white disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:-translate-y-px enabled:hover:brightness-110 enabled:active:translate-y-0 overflow-hidden"
            style={{
              background:
                connection.status === 'success'
                  ? 'linear-gradient(135deg, #10B981 0%, #059669 100%)'
                  : 'linear-gradient(135deg, #FF4794 0%, #C8186A 100%)',
              boxShadow:
                connection.status === 'success'
                  ? '0 4px 16px -4px rgba(16,185,129,0.4)'
                  : '0 4px 16px -4px rgba(200,24,106,0.45)',
            }}
          >
            {testing && (
              <span
                aria-hidden
                className="absolute inset-0 opacity-40"
                style={{
                  background:
                    'linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.5) 50%, transparent 70%)',
                  backgroundSize: '200% 100%',
                  animation: 'shimmer 1.4s linear infinite',
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
                <Loader2 size={12} className="animate-spin" style={{ color: '#E02C80' }} />
                <span style={{ color: '#E02C80' }} className="font-medium">
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

          {isConnected && (
            <button
              onClick={() => navigate('/dashboards/migrate')}
              className="w-full mt-4 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-150 hover:-translate-y-px"
              style={{
                background: '#FFFFFF',
                border: '1px solid rgba(255,71,148,0.3)',
                color: '#C8186A',
                boxShadow: '0 2px 8px -4px rgba(200,24,106,0.25)',
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
              body="Credentials are held in browser memory only and never stored, logged, or transmitted beyond your Omni instance."
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
          background: 'linear-gradient(135deg, rgba(255,71,148,0.12) 0%, rgba(200,24,106,0.08) 100%)',
          color: '#C8186A',
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
      {href && <ArrowRight size={12} className="flex-shrink-0 mt-1" style={{ color: '#C8186A', opacity: 0.6 }} />}
    </>
  );

  const baseClass = 'flex items-start gap-3 px-3.5 py-3 rounded-xl transition-all duration-150';
  const baseStyle = {
    background: 'rgba(255,255,255,0.7)',
    border: '1px solid rgba(255,71,148,0.12)',
  } as const;

  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={`${baseClass} hover:border-pink-200`} style={baseStyle}>
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
