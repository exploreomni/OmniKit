import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Clock, KeyRound, Loader2, Lock, Server, ShieldCheck, UnlockKeyhole } from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { useVaultSession } from '@/hooks/useVaultSession';
import { PassphraseInput } from '@/components/ui/PassphraseInput';
import { hasSavedVaultConnection } from '@/services/connectionGuards';

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

function isRecentlyValidated(value?: string): boolean {
  if (!value) return false;
  const validatedAt = Date.parse(value);
  if (!Number.isFinite(validatedAt)) return false;
  return Date.now() - validatedAt < 24 * 60 * 60 * 1000;
}

function validationLabel(value?: string): string {
  if (!value) return 'Not tested recently';
  const validatedAt = Date.parse(value);
  if (!Number.isFinite(validatedAt)) return 'Validation age unknown';
  return isRecentlyValidated(value) ? 'Tested in the last 24h' : 'Test again recommended';
}

export function InstanceSwitcher() {
  const { connection } = useConnection();
  const {
    status,
    vaultStatus,
    instances,
    loading,
    lockedMessage,
    unlock,
    connectInstance,
    touch,
  } = useVaultSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [passphrase, setPassphrase] = useState('');
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
  const canUnlockVault = Boolean(passphrase.trim()) && Boolean(vaultStatus?.exists) && !busy;
  const hasSavedConnection = hasSavedVaultConnection(connection);

  async function handleConnect(instanceId: string) {
    if (instanceId === connection.instanceId) {
      setOpen(false);
      return;
    }
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

  async function handleUnlock() {
    if (!canUnlockVault) return;
    setBusy(true);
    setError('');
    try {
      await unlock(passphrase);
      setPassphrase('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock the vault.');
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
              {activeInstance?.label || connection.instanceLabel || (hasSavedConnection ? 'Saved instance' : 'Instance vault')}
            </span>
            <span className="block truncate text-[10px] font-medium text-content-secondary">
              {activeInstance
                ? `${roleLabel(activeInstance.role)} · ${activeInstance.apiKeyMasked}`
                : hasSavedConnection
                  ? `${connection.apiKeyMasked || 'Vault key masked'} · saved profile`
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
              <div className="space-y-2">
                <label className="text-[11px] font-semibold text-content-secondary">
                  Vault passphrase
                </label>
                <PassphraseInput
                  value={passphrase}
                  onChange={setPassphrase}
                  onSubmit={() => {
                    if (canUnlockVault) void handleUnlock();
                  }}
                  disabled={busy || status === 'unknown'}
                  inputClassName="h-9 text-xs"
                  placeholder={status === 'unknown' ? 'Checking vault status...' : 'Enter vault passphrase'}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={handleUnlock}
                  disabled={!canUnlockVault}
                  className="btn-primary flex w-full items-center justify-center gap-2 text-xs"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <UnlockKeyhole size={13} />}
                  Unlock and resume
                </button>
                <Link to="/" className="btn-secondary flex w-full items-center justify-center gap-2 text-xs">
                  <Lock size={13} />
                  Open Home
                </Link>
              </div>
            ) : (
              <div className="space-y-2">
                {instances.length === 0 ? (
                  <Link to="/instances" className="btn-secondary flex w-full items-center justify-center gap-2 text-xs">
                    <Server size={13} />
                    Add saved instance
                  </Link>
                ) : (
                  <>
                    <div className="max-h-56 overflow-auto rounded-[7px] border border-border-subtle" role="listbox" aria-label="Saved Omni instances">
                      {instances.map((instance) => {
                        const active = instance.id === connection.instanceId;
                        const recent = isRecentlyValidated(instance.lastValidatedAt);
                        return (
                          <button
                            key={instance.id}
                            type="button"
                            onClick={() => void handleConnect(instance.id)}
                            disabled={busy}
                            className={`flex w-full items-start gap-2 border-b border-border-subtle px-2.5 py-2 text-left last:border-b-0 transition ${
                              active
                                ? 'border-l-4 border-l-omni-500 bg-omni-50 text-omni-900 hover:bg-omni-100'
                                : 'border-l-4 border-l-transparent hover:bg-surface-secondary'
                            } disabled:cursor-wait disabled:opacity-70`}
                            role="option"
                            aria-selected={active}
                          >
                            <span
                              className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${recent ? 'bg-emerald-500' : 'bg-slate-300'}`}
                              title={validationLabel(instance.lastValidatedAt)}
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-semibold text-content-primary">{instance.label}</span>
                              <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                                <span className="shrink-0 rounded-full bg-surface-tertiary px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-content-secondary">
                                  {roleLabel(instance.role)}
                                </span>
                                {active && (
                                  <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-omni-700 ring-1 ring-omni-100">
                                    Active
                                  </span>
                                )}
                              </span>
                              <span className="mt-0.5 block truncate text-[10px] text-content-secondary">
                                {instance.apiKeyMasked}
                              </span>
                              <span className="mt-0.5 block truncate text-[10px] text-content-tertiary">
                                {validationLabel(instance.lastValidatedAt)}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
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
