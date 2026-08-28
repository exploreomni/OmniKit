import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Upload,
  XCircle,
} from 'lucide-react';
import { useConnection } from '@/hooks/useConnection';
import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { friendlyApiError } from '@/utils/apiErrors';
import { csvRowsToText } from '@/utils/csvExport';
import {
  executeIdentityImport,
  IdentityImportExecutionStoppedError,
  IDENTITY_IMPORT_TEMPLATE,
  identityImportExecutionProgressTotal,
  parseIdentityImportCsv,
  preflightIdentityImport,
  type IdentityImportPlan,
  type IdentityImportPreflight,
  type IdentityImportProgress,
  type IdentityImportIssue,
  type IdentityImportResult,
} from '@/services/userManagement/bulkIdentityImport';

const MAX_CSV_BYTES = 5 * 1024 * 1024;

type InterruptedIdentityJournal = {
  scope: IdentityImportPreflight['scope'];
  results: IdentityImportResult[];
  message: string;
};

function downloadCsv(fileName: string, rows: Array<Array<string | number>>) {
  const csv = csvRowsToText(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function instanceLabel(baseUrl: string, configuredLabel?: string, instanceId?: string) {
  const label = configuredLabel?.trim();
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    // The connection screen owns URL validation. Keep this label fail-safe.
  }
  if (label && host && label !== host) return `${label} (${host})`;
  return label || host || instanceId?.trim() || 'selected Omni instance';
}

function identityKey(value: string) {
  return value.trim().normalize('NFC').toLowerCase();
}

function issueRowLabel(issue: IdentityImportIssue): string {
  const rows = [...new Set(
    issue.rowNumbers?.length
      ? issue.rowNumbers
      : issue.rowNumber
        ? [issue.rowNumber]
        : [],
  )].filter((row) => Number.isSafeInteger(row) && row > 0).sort((left, right) => left - right);
  if (rows.length === 0) return '';
  const ranges: string[] = [];
  let start = rows[0];
  let end = rows[0];
  for (const row of rows.slice(1)) {
    if (row === end + 1) {
      end = row;
      continue;
    }
    ranges.push(start === end ? String(start) : `${start}–${end}`);
    start = row;
    end = row;
  }
  ranges.push(start === end ? String(start) : `${start}–${end}`);
  return `${rows.length === 1 ? 'Row' : 'Rows'} ${ranges.join(', ')}`;
}

function identityResultRows(
  scope: IdentityImportPreflight['scope'],
  results: IdentityImportResult[],
): Array<Array<string | number>> {
  return [
    ['instance', 'instance_id', 'status', 'stage', 'field', 'target', 'source_rows', 'message'],
    ...results.map((result) => [
      scope.label,
      scope.instanceId || '',
      result.status,
      result.stage,
      result.field,
      result.target,
      result.rowNumbers.join('|'),
      result.message,
    ]),
  ];
}

export function BulkIdentityImportPage() {
  const { connection } = useConnection();
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultsSectionRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(true);
  const fileReadRequestRef = useRef(0);
  const validationAbortRef = useRef<AbortController | null>(null);
  const executionAbortRef = useRef<AbortController | null>(null);
  const executionLockRef = useRef(false);
  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState('');
  const [plan, setPlan] = useState<IdentityImportPlan | null>(null);
  const [preflight, setPreflight] = useState<IdentityImportPreflight | null>(null);
  const [validating, setValidating] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<IdentityImportProgress | null>(null);
  const [results, setResults] = useState<IdentityImportResult[]>([]);
  const [error, setError] = useState('');
  const [previewConsumed, setPreviewConsumed] = useState(false);
  const [showDeprovisionConfirm, setShowDeprovisionConfirm] = useState(false);
  const [interruptedJournal, setInterruptedJournal] = useState<InterruptedIdentityJournal | null>(null);

  const selectedInstanceId = connection.instanceId?.trim() || '';
  const selectedInstanceLabel = instanceLabel(connection.baseUrl, connection.instanceLabel, selectedInstanceId);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    fileReadRequestRef.current += 1;
    validationAbortRef.current?.abort();
    executionAbortRef.current?.abort();
    validationAbortRef.current = null;
    executionAbortRef.current = null;
    executionLockRef.current = false;
    setPlan(null);
    setPreflight(null);
    setResults([]);
    setProgress(null);
    setError('');
    setValidating(false);
    setRunning(false);
    setPreviewConsumed(false);
    setShowDeprovisionConfirm(false);

    return () => {
      validationAbortRef.current?.abort();
      executionAbortRef.current?.abort();
    };
  }, [connectionKey]);

  function clearAnalysis(nextText = csvText, cancelPendingFileRead = true) {
    if (cancelPendingFileRead) fileReadRequestRef.current += 1;
    validationAbortRef.current?.abort();
    validationAbortRef.current = null;
    executionLockRef.current = false;
    setCsvText(nextText);
    setPlan(null);
    setPreflight(null);
    setResults([]);
    setProgress(null);
    setError('');
    setValidating(false);
    setPreviewConsumed(false);
    setShowDeprovisionConfirm(false);
  }

  async function handleFile(file: File) {
    if (file.size > MAX_CSV_BYTES) {
      setError('CSV files are limited to 5 MB for local preflight safety.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Choose a .csv file.');
      return;
    }
    const fileReadRequest = fileReadRequestRef.current + 1;
    fileReadRequestRef.current = fileReadRequest;
    setFileName(file.name);
    clearAnalysis('', false);
    try {
      const text = await file.text();
      if (!mountedRef.current || fileReadRequestRef.current !== fileReadRequest) return;
      setCsvText(text);
    } catch (fileError) {
      if (!mountedRef.current || fileReadRequestRef.current !== fileReadRequest) return;
      setError(friendlyApiError(fileError, 'Could not read the CSV file'));
    }
  }

  async function analyzeCsv() {
    if (running) return;
    const requestKey = connectionKey;
    validationAbortRef.current?.abort();
    const controller = new AbortController();
    validationAbortRef.current = controller;
    executionLockRef.current = false;
    setError('');
    setResults([]);
    setProgress(null);
    setPreflight(null);
    setPreviewConsumed(false);
    setShowDeprovisionConfirm(false);

    let parsed: IdentityImportPlan;
    try {
      parsed = parseIdentityImportCsv(csvText);
      setPlan(parsed);
    } catch (parseError) {
      setPlan(null);
      setError(friendlyApiError(parseError, 'Could not parse the CSV'));
      validationAbortRef.current = null;
      return;
    }

    if (parsed.issues.some((issue) => issue.severity === 'error')) {
      validationAbortRef.current = null;
      return;
    }

    const requestIsActive = () => (
      validationAbortRef.current === controller
      && !controller.signal.aborted
      && isActiveConnectionRequest(requestKey)
    );
    setValidating(true);
    setProgress(null);
    try {
      const checked = await preflightIdentityImport(
        connection.baseUrl,
        connection.apiKey,
        parsed,
        {
          key: requestKey,
          ...(selectedInstanceId ? { instanceId: selectedInstanceId } : {}),
          label: selectedInstanceLabel,
          signal: controller.signal,
          isActive: requestIsActive,
        },
        (nextProgress) => { if (requestIsActive()) setProgress(nextProgress); },
      );
      if (requestIsActive()) setPreflight(checked);
    } catch (preflightError) {
      if (!requestIsActive()) return;
      setError(friendlyApiError(
        preflightError,
        'Preflight failed. User, group, and model-role APIs require an Omni Organization API key',
      ));
    } finally {
      if (requestIsActive()) {
        validationAbortRef.current = null;
        setValidating(false);
        setProgress(null);
      }
    }
  }

  async function runImport() {
    if (
      !preflight
      || running
      || validating
      || previewConsumed
      || executionLockRef.current
      || preflight.scope.key !== connectionKey
      || !isActiveConnectionRequest(connectionKey)
      || preflight.issues.some((issue) => issue.severity === 'error')
    ) return;

    // A ref closes the same-tick double-click window before React can re-render.
    executionLockRef.current = true;
    setPreviewConsumed(true);
    setShowDeprovisionConfirm(false);
    const requestKey = connectionKey;
    const reviewedScope = preflight.scope;
    const controller = new AbortController();
    executionAbortRef.current = controller;
    const requestIsActive = () => (
      executionAbortRef.current === controller
      && !controller.signal.aborted
      && isActiveConnectionRequest(requestKey)
    );

    setRunning(true);
    setError('');
    setResults([]);
    setProgress({
      completed: 0,
      total: identityImportExecutionProgressTotal(preflight),
      stage: 'Revalidating',
      message: `Refreshing identity evidence for ${preflight.scope.label} before the first change...`,
    });
    try {
      const nextResults = await executeIdentityImport(
        connection.baseUrl,
        connection.apiKey,
        preflight,
        (nextProgress) => {
          if (requestIsActive()) setProgress(nextProgress);
        },
        {
          key: requestKey,
          ...(selectedInstanceId ? { instanceId: selectedInstanceId } : {}),
          label: selectedInstanceLabel,
          signal: controller.signal,
          isActive: requestIsActive,
        },
      );
      if (requestIsActive()) setResults(nextResults);
    } catch (runError) {
      if (runError instanceof IdentityImportExecutionStoppedError) {
        if (!mountedRef.current) return;
        const message = `${runError.message} The prior preview is consumed, and an in-flight outcome may be unverified. Refresh that instance and validate a fresh preview before retrying.`;
        if (requestIsActive()) {
          setResults(runError.results);
          setError(message);
        } else {
          setInterruptedJournal({ scope: reviewedScope, results: runError.results, message });
        }
        return;
      }
      if (!requestIsActive()) return;
      setError(friendlyApiError(runError, 'Identity import stopped. Validate a fresh preview before retrying'));
    } finally {
      if (requestIsActive()) {
        executionAbortRef.current = null;
        setRunning(false);
      }
    }
  }

  function exportResults() {
    const scope = preflight?.scope || {
      key: connectionKey,
      ...(selectedInstanceId ? { instanceId: selectedInstanceId } : {}),
      label: selectedInstanceLabel,
    };
    downloadCsv('omnikit-identity-import-results.csv', identityResultRows(scope, results));
  }

  const issues = useMemo(
    () => preflight?.issues || plan?.issues || [],
    [plan?.issues, preflight?.issues],
  );
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const hasDeprovisioning = Boolean(preflight?.changes.usersToDelete);
  const preflightIsCurrent = Boolean(preflight && preflight.scope.key === connectionKey);
  const canRun = Boolean(
    preflight
    && preflightIsCurrent
    && errorCount === 0
    && !validating
    && !running
    && !previewConsumed
    && !executionLockRef.current
  );
  const successfulResults = results.filter((result) => result.status === 'succeeded').length;
  const failedResultEntries = useMemo(
    () => results.filter((result) => result.status === 'failed'),
    [results],
  );
  const displayedResults = useMemo(() => {
    const rank: Record<IdentityImportResult['status'], number> = { failed: 0, skipped: 1, succeeded: 2 };
    return [...results].sort((left, right) => rank[left.status] - rank[right.status]);
  }, [results]);
  const failedResults = failedResultEntries.length;
  const skippedResults = results.length - successfulResults - failedResults;
  const executionIncomplete = previewConsumed && Boolean(error);
  const executionFinished = previewConsumed && !running && !validating && Boolean(progress);
  const terminalNeedsReview = failedResults > 0 || executionIncomplete;
  const firstFailure = failedResultEntries[0];
  const progressPercent = progress
    ? progress.completed >= progress.total
      ? 100
      : Math.min(99, Math.max(progress.completed > 0 ? 1 : 0, Math.floor((progress.completed / Math.max(1, progress.total)) * 100)))
    : 0;
  const revalidatingExecution = running && progress?.stage === 'Revalidating';
  const terminalSummary = executionIncomplete
    ? results.length > 0
      ? `Execution stopped after recording ${results.length} result entr${results.length === 1 ? 'y' : 'ies'}. ${error}`
      : `Execution stopped before a result journal was returned. ${error}`
    : failedResults > 0
      ? `${failedResults} result${failedResults === 1 ? '' : 's'} need review. ${successfulResults} succeeded and ${skippedResults} skipped.`
      : `Import finished with ${successfulResults} succeeded and ${skippedResults} skipped.`;
  const workflowDetail = progress
    ? running || validating
      ? `${progress.stage}: ${progress.message}`
      : terminalSummary
    : validating
      ? 'Connecting to Omni...'
      : 'Preparing the import.';
  const workflowProgressLabel = progress
    ? running || validating
      ? `${progress.completed}/${progress.total} steps complete · ${progressPercent}%`
      : executionIncomplete
        ? `${progress.completed}/${progress.total} steps processed before stopping`
        : `Finished · ${successfulResults} succeeded · ${failedResults} failed · ${skippedResults} skipped`
    : undefined;

  const deprovisionTargets = useMemo(() => {
    if (!preflight) return [];
    const usersByEmail = new Map(
      preflight.inventory.users.map((user) => [identityKey(user.userName), user]),
    );
    return preflight.plan.records.flatMap((record) => {
      if (record.type !== 'user' || record.action !== 'delete') return [];
      const user = usersByEmail.get(identityKey(record.email));
      if (!user) return [];
      return [{
        email: record.email,
        displayName: user.displayName || record.displayName || 'Unnamed user',
        rowNumbers: record.rowNumbers,
      }];
    });
  }, [preflight]);

  const issuesByRow = useMemo(() => {
    const next = new Map<number, typeof issues>();
    issues.forEach((issue) => {
      const firstRow = issue.rowNumber || issue.rowNumbers?.[0];
      if (!firstRow) return;
      next.set(firstRow, [...(next.get(firstRow) || []), issue]);
    });
    return next;
  }, [issues]);

  const roleChangesByRow = useMemo(() => {
    const next = new Map<number, IdentityImportPreflight['roleChanges']>();
    preflight?.roleChanges.forEach((change) => {
      change.rowNumbers.forEach((rowNumber) => {
        next.set(rowNumber, [...(next.get(rowNumber) || []), change]);
      });
    });
    return next;
  }, [preflight]);

  return (
    <div className="space-y-5">
      <section className="card p-0 overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
              <Upload size={16} className="text-omni-600" />
              Bulk identity import
            </div>
            <p className="mt-1 text-xs text-content-secondary leading-5 max-w-3xl">
              Use one CSV to provision users, manage group memberships, assign scoped model roles, or deprovision access. Every preview is bound to the selected Omni instance before changes can run.
            </p>
          </div>
          <button
            type="button"
            onClick={() => downloadCsv('omnikit-identity-import-template.csv', IDENTITY_IMPORT_TEMPLATE)}
            disabled={running}
            className="btn-secondary text-sm disabled:opacity-40"
          >
            <Download size={14} />
            Download template
          </button>
        </div>

        <div className="grid border-b border-border md:grid-cols-3">
          <div className="px-5 py-4 border-b border-border md:border-b-0 md:border-r">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-secondary">1. Prepare</div>
            <div className="mt-1 text-sm font-medium text-content-primary">One person per row</div>
            <p className="mt-1 text-xs text-content-secondary">Use add to provision access or remove to revoke listed groups or deprovision the user.</p>
          </div>
          <div className="px-5 py-4 border-b border-border md:border-b-0 md:border-r">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-secondary">2. Validate</div>
            <div className="mt-1 text-sm font-medium text-content-primary">No writes during preflight</div>
            <p className="mt-1 text-xs text-content-secondary">OmniKit resolves identities, memberships, and unique connection/model role scopes first.</p>
          </div>
          <div className="px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-secondary">3. Apply</div>
            <div className="mt-1 text-sm font-medium text-content-primary">Dependency-safe, one shot</div>
            <p className="mt-1 text-xs text-content-secondary">Groups, users, memberships, roles, then confirmed deprovisioning.</p>
          </div>
        </div>

        <div className="px-5 py-5 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              disabled={running}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={running}
              className="btn-secondary text-sm disabled:opacity-40"
            >
              <FileText size={14} />
              Choose CSV
            </button>
            <div className="text-xs text-content-secondary">
              {fileName || 'No file selected. You can also paste CSV below.'}
            </div>
          </div>

          <textarea
            value={csvText}
            disabled={running}
            onChange={(event) => {
              setFileName('');
              clearAnalysis(event.target.value);
            }}
            className="input-field min-h-48 resize-y font-mono text-xs leading-5 disabled:opacity-60"
            spellCheck={false}
            placeholder={'action,display_name,email,group,role,connection,model\nadd,Example Analyst,analyst@example.com,"Analytics Users, Finance Users",Restricted Querier,Production Warehouse,\nremove,,former.analyst@example.com,Legacy Users,,,'}
          />

          <div className="rounded-card border border-border bg-surface-secondary px-4 py-3 text-xs leading-5 text-content-secondary">
            <div className="font-semibold text-content-primary">Seven columns: action, display_name, email, group, role, connection, model</div>
            <p className="mt-1">
              Separate multiple group, connection, or model names with commas. Escape a literal comma as <code className="font-mono text-content-primary">{'\\,'}</code> and a literal backslash as <code className="font-mono text-content-primary">{'\\\\'}</code>. CSV quoting still applies around cells containing commas.
            </p>
            <p className="mt-1">
              Roles are Viewer, Restricted Querier, Querier, Modeler, Connection Admin (or Admin), and No Access. Restricted Querier is sent to Omni as QUERY_TOPICS. Admin maps only to Connection Admin; Bulk Import never grants Organization Admin. Connection Admin is connection-scoped, so any supplied model values are ignored with a non-blocking warning and the named connections remain the targets. Omni does not publish a role-clear operation, so remove rows that name a role are blocked rather than converted to No Access. A remove row with groups revokes only those memberships; a remove row with blank group and role revokes the user&apos;s Omni organization membership. Full deprovisioning requires the current display_name and an exact identity match. Supported legacy files remain accepted.
            </p>
            <p className="mt-1">
              For an add row with Restricted Querier, leave model blank to assign the role to every current active shared model in each named connection. The preview expands and lists every model before execution. Models created later are not included automatically. Other model roles still require explicit model names.
            </p>
            <p className="mt-1">
              Omni applies these resource changes separately, so the import is not atomic and OmniKit does not promise rollback. Partial and unverified outcomes stay in the result journal and always require a fresh validation before retrying.
            </p>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-2 text-xs text-content-secondary max-w-3xl">
              <ShieldCheck size={15} className="mt-0.5 shrink-0 text-green-700" />
              <span>
                Requires an Organization API key. Bulk Import does not persist the CSV; OmniKit sends only the reviewed operations to <span className="font-semibold text-content-primary">{selectedInstanceLabel}</span>.
              </span>
            </div>
            <button
              type="button"
              onClick={() => void analyzeCsv()}
              disabled={!csvText.trim() || validating || running}
              className="btn-primary text-sm disabled:opacity-40"
            >
              {validating ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              {validating ? 'Checking Omni...' : previewConsumed ? 'Validate fresh preview' : 'Validate import'}
            </button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {interruptedJournal && (
        <section className="card p-0 overflow-hidden border-amber-300">
          <div className="px-5 py-4 border-b border-amber-200 bg-amber-50 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                <AlertTriangle size={17} />
                Interrupted import journal · {interruptedJournal.scope.label}
              </div>
              <p className="mt-1 max-w-4xl text-xs leading-5 text-amber-800">{interruptedJournal.message}</p>
              <p className="mt-1 text-xs font-semibold text-amber-900">
                {interruptedJournal.results.length} completed journal entr{interruptedJournal.results.length === 1 ? 'y' : 'ies'} from the previously selected instance
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => downloadCsv(
                  'omnikit-interrupted-identity-import-results.csv',
                  identityResultRows(interruptedJournal.scope, interruptedJournal.results),
                )}
                className="btn-secondary text-sm"
              >
                <Download size={14} />
                Export journal
              </button>
              <button type="button" onClick={() => setInterruptedJournal(null)} className="btn-secondary text-sm">
                Dismiss
              </button>
            </div>
          </div>
          {interruptedJournal.results.length > 0 && (
            <div className="max-h-64 divide-y divide-border overflow-y-auto">
              {interruptedJournal.results.map((result, index) => (
                <div key={`${result.stage}-${result.field}-${result.target}-${index}`} className="px-5 py-3 text-xs">
                  <div>
                    <span className="font-semibold uppercase tracking-wider text-content-secondary">{result.status} · {result.stage} · {result.field}</span>
                    <span className="ml-2 break-all font-medium text-content-primary">{result.target}</span>
                  </div>
                  <div className="mt-1 text-content-secondary">Source row{result.rowNumbers.length === 1 ? '' : 's'} {result.rowNumbers.join(', ')} · {result.message}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {plan && (
        <section className="card p-0 overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-content-primary">Import preflight</div>
              <p className="mt-0.5 text-xs text-content-secondary">
                {preflight
                  ? `Checked against ${preflight.scope.label}.`
                  : validating
                    ? `Checking ${selectedInstanceLabel}.`
                    : 'Local CSV checks complete.'}
              </p>
            </div>
            <div className={`rounded-chip px-3 py-1 text-xs font-semibold ${errorCount > 0 ? 'bg-red-100 text-red-800' : preflight && preflightIsCurrent ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
              {errorCount > 0 ? `${errorCount} blocking` : preflight && preflightIsCurrent ? 'Ready' : 'Needs Omni check'}
            </div>
          </div>

          <div className="grid border-b border-border sm:grid-cols-2 lg:grid-cols-7">
            {[
              ['User upserts', plan.summary.userUpserts],
              ['User deprovisions', plan.summary.userDeletes],
              ['Groups ensured', plan.summary.groupsEnsured],
              ['Membership adds', plan.summary.membershipsAdded],
              ['Membership removals', plan.summary.membershipsRemoved],
              ['Role rows', plan.summary.rolesAdded],
              ['Role removals', plan.summary.rolesRemoved],
            ].map(([label, value]) => (
              <div key={label} className="px-4 py-3 border-b border-border last:border-b-0 sm:border-r lg:border-b-0">
                <div className="text-[10px] uppercase tracking-wider text-content-secondary">{label}</div>
                <div className="mt-1 text-lg font-semibold text-content-primary">{value}</div>
              </div>
            ))}
          </div>

          {preflight && (
            <div className="grid border-b border-border bg-surface-secondary sm:grid-cols-2 lg:grid-cols-5">
              {[
                ['Create users', preflight.changes.usersToCreate],
                ['Fill user values', preflight.changes.usersToUpdate],
                ['Deprovision users', preflight.changes.usersToDelete],
                ['Create groups', preflight.changes.groupsToCreate],
                ['Add memberships', preflight.changes.membershipAdds],
                ['Remove memberships', preflight.changes.membershipRemoves],
                ['Assign roles', preflight.changes.roleAdds],
                ['Role removals blocked', preflight.changes.roleRemoves],
                ['No changes', preflight.changes.noOps],
                ['Conflicts preserved', preflight.changes.conflicts],
              ].map(([label, value]) => (
                <div key={label} className="px-4 py-3 border-b border-border last:border-b-0 sm:border-r">
                  <div className="text-[10px] uppercase tracking-wider text-content-secondary">{label}</div>
                  <div className="mt-1 text-sm font-semibold text-content-primary">{value}</div>
                </div>
              ))}
            </div>
          )}

          {plan.previewRows.length > 0 && (
            <div className="border-b border-border">
              <div className="px-5 py-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Row-level preview</div>
                  <p className="mt-0.5 text-xs text-content-secondary">Every source row stays traceable through validation and results.</p>
                </div>
                <div className="text-xs text-content-secondary">{plan.previewRows.length.toLocaleString()} source row{plan.previewRows.length === 1 ? '' : 's'}</div>
              </div>
              <div className="max-h-[34rem] overflow-auto">
                <table className="min-w-[1080px] w-full text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-surface-secondary text-[10px] uppercase tracking-wider text-content-secondary">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Row</th>
                      <th className="px-4 py-2 font-semibold">Action</th>
                      <th className="px-4 py-2 font-semibold">User</th>
                      <th className="px-4 py-2 font-semibold">Groups</th>
                      <th className="px-4 py-2 font-semibold">Role and resolved scope</th>
                      <th className="px-4 py-2 font-semibold">Planned effect</th>
                      <th className="px-4 py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {plan.previewRows.map((row, index) => {
                      const rowIssues = issuesByRow.get(row.rowNumber) || [];
                      const rowRoleChanges = roleChangesByRow.get(row.rowNumber) || [];
                      const rowHasError = rowIssues.some((issue) => issue.severity === 'error');
                      const rowHasWarning = rowIssues.some((issue) => issue.severity === 'warning');
                      return (
                        <tr key={`${row.rowNumber}-${row.action}-${index}`} className={row.destructive ? 'bg-red-50/60' : undefined}>
                          <td className="px-4 py-3 align-top font-mono text-content-secondary">{row.rowNumber}</td>
                          <td className="px-4 py-3 align-top">
                            <span className={`rounded-chip px-2 py-0.5 font-semibold ${row.destructive ? 'bg-red-100 text-red-800' : row.action === 'remove' || row.action === 'delete' ? 'bg-amber-100 text-amber-800' : 'bg-omni-100 text-omni-800'}`}>
                              {row.action}
                            </span>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className="font-medium text-content-primary">{row.displayName || '—'}</div>
                            <div className="mt-0.5 break-all text-content-secondary">{row.email || '—'}</div>
                          </td>
                          <td className="px-4 py-3 align-top text-content-secondary">
                            {row.groups.length > 0 ? row.groups.join(', ') : '—'}
                          </td>
                          <td className="px-4 py-3 align-top">
                            {rowRoleChanges.length > 0 ? (
                              <div className="space-y-2">
                                {rowRoleChanges.map((change) => (
                                  <div key={`${change.connectionId}-${change.modelId || ''}-${change.roleName}`} className="rounded border border-border bg-surface-primary p-2">
                                    <div className="font-semibold text-content-primary">{row.role || change.roleName} <span className="font-mono text-[10px] text-content-secondary">({change.roleName})</span></div>
                                    <div className="mt-1 text-content-secondary">Connection: {change.connectionName} · <span className="font-mono break-all">{change.connectionId}</span></div>
                                    {change.modelId && <div className="mt-0.5 text-content-secondary">Model: {change.modelName || 'Unnamed model'} · <span className="font-mono break-all">{change.modelId}</span></div>}
                                    <div className="mt-1 text-content-secondary"><span className="font-semibold capitalize">{change.disposition}</span> — {change.message}</div>
                                  </div>
                                ))}
                              </div>
                            ) : row.role ? (
                              <div>
                                <div className="font-semibold text-content-primary">{row.role}</div>
                                <div className="mt-0.5 text-content-secondary">
                                  {row.connections.length > 0 ? `Connections: ${row.connections.join(', ')}` : 'Connection scope unresolved'}
                                </div>
                                {row.models.length > 0 && <div className="mt-0.5 text-content-secondary">Models: {row.models.join(', ')}</div>}
                              </div>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-3 align-top text-content-secondary">
                            <ul className="space-y-1">
                              {row.effects.map((effect) => <li key={effect}>{effect}</li>)}
                            </ul>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <span className={`font-semibold ${rowHasError ? 'text-red-700' : rowHasWarning ? 'text-amber-700' : preflightIsCurrent ? 'text-green-700' : 'text-content-secondary'}`}>
                              {rowHasError ? 'Blocked' : rowHasWarning ? 'Warning' : preflightIsCurrent ? 'Ready' : 'Local'}
                            </span>
                            {rowIssues.length > 0 && (
                              <div className="mt-1 space-y-1 text-content-secondary">
                                {rowIssues.map((issue, issueIndex) => <div key={`${issue.message}-${issueIndex}`}>{issue.message}</div>)}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {issues.length > 0 && (
            <div className="divide-y divide-border">
              <div className="px-5 py-2 text-[11px] font-semibold uppercase tracking-wider text-content-secondary">
                {errorCount} blocking · {warningCount} warning{warningCount === 1 ? '' : 's'}
              </div>
              {issues.map((issue, index) => (
                <div key={`${issue.message}-${index}`} className="px-5 py-3 flex items-start gap-2 text-xs">
                  {issue.severity === 'error'
                    ? <XCircle size={15} className="mt-0.5 shrink-0 text-red-600" />
                    : <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />}
                  <span className={issue.severity === 'error' ? 'text-red-700' : 'text-amber-800'}>
                    {issueRowLabel(issue) ? `${issueRowLabel(issue)}: ` : ''}{issue.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          {preflight && hasDeprovisioning && (
            <div className="border-t border-red-200 bg-red-50/70 px-5 py-4">
              <div className="text-sm font-semibold text-red-800">
                Deprovisioning review · {preflight.changes.usersToDelete} user{preflight.changes.usersToDelete === 1 ? '' : 's'} · {preflight.scope.label}
              </div>
              <p className="mt-1 text-xs leading-5 text-red-700">
                These exact organization memberships will be revoked after other approved changes. Review or transfer schedules and content ownership, and retire user-owned personal-access-token workflows that may stop when access is revoked.
              </p>
              <div className="mt-3 max-h-40 overflow-y-auto rounded border border-red-200 bg-white/70 divide-y divide-red-100">
                {deprovisionTargets.map((target) => (
                  <div key={identityKey(target.email)} className="px-3 py-2 text-xs text-red-800">
                    <span className="font-semibold">{target.displayName}</span>
                    <span className="ml-2 break-all">{target.email}</span>
                    <span className="ml-2 text-red-600">Source row{target.rowNumbers.length === 1 ? '' : 's'} {target.rowNumbers.join(', ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {preflight && previewConsumed && (
            <div className="px-5 py-3 border-t border-border bg-amber-50 text-xs text-amber-800">
              This preview has already been consumed. Validate again against {preflight.scope.label} before another execution.
            </div>
          )}

          {preflight && (
            <div className="px-5 py-4 border-t border-border flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-content-secondary">
                Target: <span className="font-semibold text-content-primary">{preflight.scope.label}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!canRun) return;
                  if (hasDeprovisioning) setShowDeprovisionConfirm(true);
                  else void runImport();
                }}
                disabled={!canRun}
                className="btn-primary text-sm disabled:opacity-40"
              >
                {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {running ? 'Applying changes...' : previewConsumed ? 'Validate again to run' : 'Run identity import'}
              </button>
            </div>
          )}
        </section>
      )}

      {(running || validating || progress) && (
        <section className="card bg-surface-secondary space-y-3">
          <WorkflowStatusScene
            variant="bulk-upload"
            title={validating ? 'Validating identity inventory' : revalidatingExecution ? 'Revalidating approved changes' : running ? 'Applying identity changes' : terminalNeedsReview ? 'Identity import finished with review items' : 'Identity import complete'}
            detail={workflowDetail}
            statusLabel={validating || revalidatingExecution ? 'Checking' : running ? 'Running' : terminalNeedsReview ? 'Needs review' : 'Complete'}
            progressLabel={workflowProgressLabel}
            active={running || validating}
            compact
          />
          {progress && (
            <div
              className={`identity-import-progress ${running || validating ? 'identity-import-progress-active' : ''} ${progress.completed === 0 ? 'identity-import-progress-indeterminate' : ''}`}
              role="progressbar"
              aria-label={`${progress.stage} progress`}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.completed}
              aria-valuetext={`${progress.completed} of ${progress.total} steps complete`}
            >
              <div
                className={`identity-import-progress-fill ${running || validating ? 'identity-import-progress-fill-active' : ''}`}
                style={{ width: `${progressPercent}%` }}
              >
                <span aria-hidden />
              </div>
            </div>
          )}
          {executionFinished && (
            <div className={`rounded-lg border px-4 py-3 ${terminalNeedsReview ? 'border-amber-200 bg-amber-50' : 'border-green-200 bg-green-50'}`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  {terminalNeedsReview
                    ? <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-700" />
                    : <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-green-700" />}
                  <div className="min-w-0">
                    <div className={`text-sm font-semibold ${terminalNeedsReview ? 'text-amber-900' : 'text-green-900'}`}>
                      {executionIncomplete ? 'Execution stopped' : failedResults > 0 ? `${failedResults} result${failedResults === 1 ? '' : 's'} need review` : 'Import finished successfully'}
                    </div>
                    <p className={`mt-1 text-xs leading-5 ${terminalNeedsReview ? 'text-amber-800' : 'text-green-800'}`}>
                      {terminalSummary}
                    </p>
                    {firstFailure && (
                      <div className="mt-2 rounded-md border border-amber-200 bg-white/80 px-3 py-2 text-xs text-amber-900">
                        <span className="font-semibold">First failure:</span>{' '}
                        <span className="break-all">{firstFailure.target}</span>
                        <span className="block mt-1 text-amber-800">{firstFailure.message}</span>
                      </div>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  aria-controls="identity-import-results"
                  onClick={() => {
                    const section = resultsSectionRef.current;
                    if (!section) return;
                    section.scrollIntoView({ block: 'start' });
                    section.focus({ preventScroll: true });
                  }}
                  className="btn-secondary shrink-0 text-sm"
                >
                  {failedResults > 0 ? 'Review failures' : 'View results'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {executionFinished && (
        <section
          id="identity-import-results"
          ref={resultsSectionRef}
          tabIndex={-1}
          aria-labelledby="identity-import-results-heading"
          className="card p-0 overflow-hidden scroll-mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-omni-500"
        >
          <div className="px-5 py-4 border-b border-border flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              {failedResults > 0 || executionIncomplete
                ? <AlertTriangle size={20} className="text-amber-600" />
                : <CheckCircle2 size={20} className="text-green-700" />}
              <div>
                <div id="identity-import-results-heading" className="text-sm font-semibold text-content-primary">Import results · {preflight?.scope.label || selectedInstanceLabel}</div>
                <p className="mt-0.5 text-xs text-content-secondary">
                  {successfulResults} succeeded · {failedResults} failed · {skippedResults} skipped{executionIncomplete ? ' · execution stopped; review before retrying' : ''}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={exportResults} disabled={results.length === 0} className="btn-secondary text-sm disabled:opacity-40">
                <Download size={14} />
                Export results
              </button>
              <button
                type="button"
                onClick={() => {
                  setCsvText('');
                  setFileName('');
                  clearAnalysis('');
                }}
                className="btn-secondary text-sm"
              >
                <RefreshCw size={14} />
                New import
              </button>
            </div>
          </div>
          <div className="max-h-96 divide-y divide-border overflow-y-auto">
            {results.length === 0 && (
              <div className="px-5 py-4 text-xs leading-5 text-content-secondary">
                {error || 'No result entries were produced because no changes were required.'}
              </div>
            )}
            {displayedResults.map((result, index) => (
              <div key={`${result.stage}-${result.field}-${result.target}-${index}`} className="px-5 py-3 flex items-start gap-3 text-xs">
                {result.status === 'succeeded'
                  ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-700" />
                  : result.status === 'failed'
                    ? <XCircle size={14} className="mt-0.5 shrink-0 text-red-600" />
                    : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />}
                <div className="min-w-0">
                  <div>
                    <span className="font-semibold uppercase tracking-wider text-content-secondary">{result.stage} · {result.field}</span>
                    <span className="ml-2 break-all font-medium text-content-primary">{result.target}</span>
                  </div>
                  <div className="mt-1 text-content-secondary">Source row{result.rowNumbers.length === 1 ? '' : 's'} {result.rowNumbers.join(', ')} · {result.message}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={showDeprovisionConfirm}
        title={`Deprovision users from ${preflight?.scope.label || selectedInstanceLabel}?`}
        message={`You are about to revoke Omni organization membership for ${preflight?.changes.usersToDelete || 0} exact user${preflight?.changes.usersToDelete === 1 ? '' : 's'} listed in the deprovisioning review for ${preflight?.scope.label || selectedInstanceLabel}. This cannot be undone from this import and may stop user-owned schedules and personal-access-token workflows. Other approved changes run before deprovisioning.`}
        confirmLabel="Revoke membership and run"
        cancelLabel="Review preview"
        variant="danger"
        requireTypedConfirmation
        confirmationPhrase="DEPROVISION"
        onCancel={() => {
          if (!running) setShowDeprovisionConfirm(false);
        }}
        onConfirm={() => void runImport()}
      />
    </div>
  );
}
