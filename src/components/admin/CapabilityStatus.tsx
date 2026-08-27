import { useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import {
  fetchAdminReadiness,
  type AdminAccessPosture,
  type AdminEvidenceState,
  type AdminReadinessCapability,
  type AdminReadinessReport,
  type AdminReadinessState,
  type AdminReadinessWorkspace,
} from '@/services/adminReadiness';
import {
  isSafeOmniDeepLink,
  isSafeOmniDocumentationUrl,
  type OmniDeepLinkTarget,
} from '@/services/omniDeepLinks';
import { friendlyApiError } from '@/utils/apiErrors';

const EVIDENCE_LABELS: Record<AdminEvidenceState, string> = {
  not_checked: 'Not checked',
  available: 'Available',
  partial: 'Partial',
  unauthorized: 'Unauthorized',
  unsupported: 'Unsupported',
  unavailable: 'Unavailable',
  failed: 'Failed',
  stale: 'Stale',
};

const READINESS_LABELS: Record<AdminReadinessState, string> = {
  ready: 'Ready',
  action_required: 'Action required',
  not_configured: 'Not configured',
  unknown: 'Unknown',
};

const EVIDENCE_CLASSES: Record<AdminEvidenceState, string> = {
  not_checked: 'bg-gray-100 text-gray-700',
  available: 'bg-green-100 text-green-800',
  partial: 'bg-yellow-100 text-yellow-900',
  unauthorized: 'bg-red-100 text-red-800',
  unsupported: 'bg-gray-100 text-gray-700',
  unavailable: 'bg-red-100 text-red-800',
  failed: 'bg-red-100 text-red-800',
  stale: 'bg-yellow-100 text-yellow-900',
};

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}

function coverageLabel(capability: AdminReadinessCapability | AdminAccessPosture): string {
  const { included, total, unit } = capability.coverage;
  return total === null
    ? `${included} ${unit}; total unavailable`
    : `${included} of ${total} ${unit}`;
}

function capabilityData(capability: AdminReadinessCapability) {
  const data = capability.data;
  if (!data) return null;

  if (capability.id === 'identity.user_attributes' && Array.isArray(data)) {
    return (
      <div className="mt-3">
        <div className="text-xs font-medium text-content-primary">{data.length} attribute definition{data.length === 1 ? '' : 's'} returned</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {data.slice(0, 25).map((attribute) => (
            <div key={attribute.name} className="rounded-button border border-border bg-white px-3 py-2 text-xs">
              <div className="font-medium text-content-primary">{attribute.label || attribute.name}</div>
              <div className="mt-0.5 text-content-secondary">
                {attribute.name}{attribute.type ? ` · ${attribute.type}` : ''}{attribute.multiple ? ' · multiple values' : ''}
              </div>
              <div className="mt-0.5 text-content-secondary">
                {attribute.system ? 'System' : 'Custom'} · {attribute.hasDefault ? 'Default configured' : 'No default returned'} · {attribute.hasDescription ? 'Description present' : 'No description returned'}
              </div>
            </div>
          ))}
        </div>
        {data.length > 25 && <div className="mt-2 text-xs text-content-secondary">{data.length - 25} additional definitions are not rendered in this bounded view.</div>}
      </div>
    );
  }

  if (Array.isArray(data)) return null;
  if (capability.id === 'fleet.folder_read' && 'visibleFoldersLowerBound' in data) {
    return <div className="mt-2 text-xs text-content-secondary">Visible folders returned: at least {data.visibleFoldersLowerBound}</div>;
  }
  if (capability.id === 'fleet.api_tokens' && 'organization' in data) {
    return (
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-content-secondary sm:grid-cols-4">
        <span>Total metadata: {data.total}</span>
        <span>Organization: {data.organization}</span>
        <span>Personal: {data.personal}</span>
        <span>MCP: {data.mcp}</span>
        <span>Other: {data.other}</span>
        <span>Enabled: {data.enabled}</span>
        <span>Disabled: {data.disabled}</span>
      </div>
    );
  }
  if (capability.id === 'fleet.organization_api_key_confirmation' && 'confirmed' in data) {
    return <div className="mt-2 text-xs text-content-secondary">Saved operator confirmation: {data.confirmed ? 'Confirmed' : 'Not confirmed'}. This is not token introspection.</div>;
  }
  if ((capability.id === 'identity.scim_users' || capability.id === 'developer.embed_users') && 'statusUnknown' in data) {
    return (
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-content-secondary sm:grid-cols-4">
        <span>Total records: {data.total}</span>
        <span>Active: {data.active}</span>
        <span>Inactive: {data.inactive}</span>
        <span>Status unknown: {data.statusUnknown}</span>
      </div>
    );
  }
  if (capability.id === 'fleet.current_token_introspection' && 'keyScope' in data) {
    return (
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-content-secondary sm:grid-cols-4">
        <span>Key scope: {data.keyScope === 'organization' ? 'Organization' : 'User'}</span>
        <span>Organization role: {data.orgRole === 'ORG_ADMIN' ? 'Organization admin' : 'Member'}</span>
        <span>Model permission sets: {data.returnedModelCount}</span>
        <span>
          Permissions returned: {data.returnedPermissionCount}
          {data.rolesByModelTruncated ? ' · Partial' : ''}
        </span>
      </div>
    );
  }
  if (capability.id === 'identity.scim_groups' && 'total' in data) {
    return <div className="mt-2 text-xs text-content-secondary">Group records returned: {data.total}</div>;
  }
  if (capability.id === 'content.schedules' && 'lastStatus' in data) {
    return (
      <div className="mt-2 space-y-1 text-xs text-content-secondary">
        <div>Total: {data.total} · Active: {data.active} · Paused: {data.paused} · System disabled: {data.systemDisabled}</div>
        <div>Latest observed status records — Success: {data.lastStatus.success} · Error: {data.lastStatus.error} · Canceled: {data.lastStatus.canceled} · None: {data.lastStatus.none} · Unknown: {data.lastStatus.unknown}</div>
        <div>Latest observed completion: {data.latestObservedAt ? formatTimestamp(data.latestObservedAt) : 'Not returned'}</div>
        <div>This is latest-delivery evidence, not run history, reliability, or an SLA.</div>
      </div>
    );
  }
  return null;
}

function actionTarget(url: string): OmniDeepLinkTarget | null {
  try {
    return new URL(url).pathname === '/api-explorer' ? 'api_explorer' : new URL(url).pathname === '/' ? 'tenant_root' : null;
  } catch {
    return null;
  }
}

function safeAction(action: NonNullable<AdminReadinessCapability['actions']>[number], baseUrl?: string): boolean {
  if (action.kind === 'documentation') return isSafeOmniDocumentationUrl(action.url);
  const target = actionTarget(action.url);
  return Boolean(baseUrl && target && isSafeOmniDeepLink(action.url, baseUrl, target));
}

export function CapabilityStatus({ capability, baseUrl }: { capability: AdminReadinessCapability; baseUrl?: string }) {
  return (
    <article data-capability-id={capability.id} className="rounded-card border border-border bg-surface-secondary p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-content-primary">{capability.label}</h3>
          <p className="mt-1 text-xs leading-5 text-content-secondary">{capability.reason.message}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className={`rounded-chip px-2 py-0.5 text-xs font-semibold ${EVIDENCE_CLASSES[capability.evidenceState]}`}>
            {EVIDENCE_LABELS[capability.evidenceState]}
          </span>
          <span className="rounded-chip bg-white px-2 py-0.5 text-xs font-semibold text-content-secondary ring-1 ring-border">
            {READINESS_LABELS[capability.readinessState]}
          </span>
        </div>
      </div>

      {capabilityData(capability)}

      <dl className="mt-3 grid gap-2 text-xs text-content-secondary sm:grid-cols-2">
        <div><dt className="inline font-medium text-content-primary">Reason:</dt> <dd className="inline font-mono">{capability.reason.code}</dd></div>
        <div><dt className="inline font-medium text-content-primary">Coverage:</dt> <dd className="inline">{coverageLabel(capability)}{capability.coverage.complete ? ' · Complete' : ' · Partial'}</dd></div>
        <div><dt className="inline font-medium text-content-primary">Source:</dt> <dd className="inline">{capability.source.kind}{capability.source.method ? ` · ${capability.source.method}` : ''}{capability.source.path ? ` · ${capability.source.path}` : ''}</dd></div>
        <div><dt className="inline font-medium text-content-primary">Checked:</dt> <dd className="inline">{formatTimestamp(capability.checkedAt)}</dd></div>
      </dl>

      {capability.exclusions.length > 0 && (
        <div className="mt-2 text-xs text-content-secondary">Exclusions: {capability.exclusions.join(' · ')}</div>
      )}

      {capability.actions && capability.actions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {capability.actions.map((action) => safeAction(action, baseUrl) ? (
            <a
              key={`${action.kind}:${action.label}`}
              href={action.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary text-xs"
            >
              {action.label}
              <ExternalLink size={12} />
            </a>
          ) : (
            <span key={`${action.kind}:${action.label}`} className="rounded-button border border-border bg-white px-3 py-2 text-xs text-content-secondary">
              {action.label}: link unavailable
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export function AdminReadinessPanel({
  workspace,
  instanceId,
  baseUrl,
}: {
  workspace: AdminReadinessWorkspace;
  instanceId?: string;
  baseUrl?: string;
}) {
  const [report, setReport] = useState<AdminReadinessReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestSequence = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    requestSequence.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setReport(null);
    setLoading(false);
    setError('');
    return () => controllerRef.current?.abort();
  }, [baseUrl, instanceId, workspace]);

  async function verify() {
    if (!instanceId) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const next = await fetchAdminReadiness(instanceId, workspace, { signal: controller.signal });
      if (requestId !== requestSequence.current) return;
      setReport(next);
    } catch (nextError) {
      if (controller.signal.aborted || requestId !== requestSequence.current) return;
      setReport(null);
      setError(friendlyApiError(nextError, 'Read-only readiness could not be verified'));
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }

  return (
    <section data-testid={`admin-readiness-${workspace}`} className="card space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-content-primary">Read-only readiness</h2>
          <p className="mt-1 text-xs leading-5 text-content-secondary">
            Verifies documented GET capabilities only. Settings without a documented read contract remain manual or unsupported.
          </p>
        </div>
        <button type="button" onClick={verify} disabled={!instanceId || loading} className="btn-secondary shrink-0 text-sm disabled:opacity-40">
          {loading ? <Loader2 size={14} className="animate-spin" /> : report ? <RefreshCw size={14} /> : null}
          Verify read capabilities
        </button>
      </div>

      <div aria-live="polite" className="text-xs text-content-secondary">
        {loading
          ? 'Verifying documented read capabilities...'
          : report
            ? `Verification completed ${formatTimestamp(report.checkedAt)}${report.servedFromCache ? ' from cached evidence' : ''}.`
            : instanceId
              ? 'Not checked. Verification runs only when requested.'
              : 'Choose an active saved Omni instance to verify read capabilities.'}
      </div>

      {error && <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {report && (
        <div className="space-y-3">
          {report.capabilities.map((capability) => (
            <CapabilityStatus key={capability.id} capability={capability} baseUrl={baseUrl} />
          ))}
        </div>
      )}
    </section>
  );
}

export function AccessPostureEvidence({ posture }: { posture: AdminAccessPosture }) {
  return (
    <div data-access-posture-id={posture.id} className="mt-3 rounded-card border border-border bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-content-primary">Model-role assignments returned by Omni</div>
        <span className={`rounded-chip px-2 py-0.5 text-xs font-semibold ${EVIDENCE_CLASSES[posture.evidenceState]}`}>
          {EVIDENCE_LABELS[posture.evidenceState]}
        </span>
      </div>
      <p className="mt-1 text-xs text-content-secondary">{posture.reason.message} Assignments are not proof of effective content, row, field, or query access.</p>
      {posture.roles.length === 0 ? (
        <div className="mt-2 text-xs text-content-secondary">
          {posture.evidenceState === 'available' ? 'No model-role assignments were returned by this complete read.' : 'No assignment count is claimed because the read is incomplete or unavailable.'}
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {posture.roles.slice(0, 25).map((role, index) => (
            <div key={`${role.connectionId || 'connection'}:${role.modelId || 'model'}:${role.roleName}:${index}`} className="rounded-button border border-border bg-surface-secondary px-3 py-2 text-xs text-content-secondary">
              <div className="font-semibold text-content-primary">{role.roleName}</div>
              <div>{role.baseRole ? `Base role: ${role.baseRole} · ` : ''}Connection: {role.connectionId || 'Not returned'} · Model: {role.modelId || 'Not returned'}</div>
              {role.provenance ? (
                <div>Provenance: {[role.provenance.type, role.provenance.name, role.provenance.depth === undefined ? undefined : `depth ${role.provenance.depth}`].filter(Boolean).join(' · ') || 'Not returned'}</div>
              ) : (
                <div>Provenance: Not returned; assignment origin is not claimed.</div>
              )}
            </div>
          ))}
          {posture.roles.length > 25 && <div className="text-xs text-content-secondary">{posture.roles.length - 25} additional assignments are not rendered in this bounded view.</div>}
        </div>
      )}
      <div className="mt-2 text-xs text-content-secondary">Reason: <span className="font-mono">{posture.reason.code}</span> · Coverage: {coverageLabel(posture)} · Checked: {formatTimestamp(posture.checkedAt)}</div>
    </div>
  );
}
