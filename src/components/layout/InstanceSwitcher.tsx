import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Clock, KeyRound, Loader2, Lock, Server, ShieldCheck } from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { useVaultSession } from '@/hooks/useVaultSession';

function hostFromUrl(value: string): string {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).host;
  } catch {
    return value.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function roleLabel(role: string): string {
  if (role === 'both') return 'Source + destination';
  return role === 'source' ? 'Source' : 'Destination';
}

export function InstanceSwitcher() {
  const { connection, isConnected } = useConnection();
  const {
    status,
    vaultStatus,
    instances,
    loading,
    lockedMessage,
    connectInstance,
    touch,
  } = useVaultSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!vaultStatus?.unlocked) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [vaultStatus?.unlocked]);

  useEffect(() => {
    if (lockedMessage) setOpen(true);
  }, [lockedMessage]);

  const activeInstance = useMemo(
    () => instances.find((instance) => instance.id === connection.instanceId),
    [connection.instanceId, instances],
  );
  const remainingMs = vaultStatus?.unlocked && vaultStatus.idleTimeoutMs && vaultStatus.lastActivityAt
    ? vaultStatus.lastActivityAt + vaultStatus.idleTimeoutMs - now
    : null;
  const showIdleWarning = remainingMs !== null && remainingMs > 0 && remainingMs < 5 * 60 * 1000;
  const manualHost = connection.baseUrl ? hostFromUrl(connection.baseUrl) : '';

  async function handleConnect(instanceId: string) {
    setBusy(true);
    setError('');
    try {
      await connectInstance(instanceId);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to this saved instance.');
    } finally {
      setBusy(false);
    }
  }

  async function handleExtend() {
    setBusy(true);
    setError('');
    try {
      await touch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not extend the vault session.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-2 pb-2">
      <div className="rounded-[8px] border border-border-subtle bg-surface-secondary/60 p-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-2 rounded-[6px] px-2 py-2 text-left text-[12px] font-semibold text-content-primary transition hover:bg-white"
          aria-expanded={open}
        >
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] ${status === 'unlocked' ? 'bg-omni-50 text-omni-700' : 'bg-white text-content-secondary'}`}>
            {status === 'unlocked' ? <ShieldCheck size={14} /> : <Lock size={14} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">
              {activeInstance?.label || connection.instanceLabel || (isConnected ? 'One-time connection' : 'Instance vault')}
            </span>
            <span className="block truncate text-[10px] font-medium text-content-secondary">
              {activeInstance
                ? `${roleLabel(activeInstance.role)} · ${activeInstance.apiKeyMasked}`
                : isConnected && manualHost
                  ? manualHost
                  : status === 'unlocked'
                    ? `${instances.length} saved instance${instances.length === 1 ? '' : 's'}`
                    : status === 'no-vault'
                      ? 'Set up vault'
                      : 'Unlock to switch'}
            </span>
          </span>
          {loading ? <Loader2 size={13} className="animate-spin text-content-secondary" /> : <ChevronDown size={13} className="text-content-secondary" />}
        </button>

        {showIdleWarning && (
          <div className="mt-2 rounded-[6px] border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex min-w-0 items-center gap-1">
                <Clock size={11} />
                <span className="truncate">Locks in {formatRemaining(remainingMs)}</span>
              </span>
              <button type="button" onClick={handleExtend} disabled={busy} className="font-semibold text-amber-900 hover:underline">
                Extend
              </button>
            </div>
          </div>
        )}

        {open && (
          <div className="mt-2 space-y-2 rounded-[8px] border border-border-subtle bg-white p-2 text-[12px] shadow-sm">
            {lockedMessage && (
              <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                {lockedMessage}
              </div>
            )}
            {error && (
              <div className="rounded-[6px] border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                {error}
              </div>
            )}

            {status === 'no-vault' ? (
              <Link to="/" className="btn-primary flex w-full items-center justify-center gap-2 text-xs">
                <KeyRound size={13} />
                Set up on Home
              </Link>
            ) : status === 'locked' || status === 'unknown' ? (
              <Link to="/" className="btn-primary flex w-full items-center justify-center gap-2 text-xs">
                <Lock size={13} />
                Unlock on Home
              </Link>
            ) : (
              <div className="space-y-2">
                {instances.length === 0 ? (
                  <Link to="/instances" className="btn-secondary flex w-full items-center justify-center gap-2 text-xs">
                    <Server size={13} />
                    Add saved instance
                  </Link>
                ) : (
                  <>
                    <select
                      value={connection.instanceId || ''}
                      onChange={(event) => void handleConnect(event.target.value)}
                      disabled={busy}
                      className="input-field h-9 text-xs"
                    >
                      <option value="">Choose an instance</option>
                      {instances.map((instance) => (
                        <option key={instance.id} value={instance.id}>
                          {instance.label} · {roleLabel(instance.role)}
                        </option>
                      ))}
                    </select>
                    <Link to="/instances" className="btn-secondary flex w-full items-center justify-center gap-2 text-xs">
                      <Server size={13} />
                      Manage instances
                    </Link>
                  </>
                )}
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  );
}
