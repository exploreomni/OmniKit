import { useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import {
  createReviewedModelPullRequestHandoff,
  discardReviewedModelBranch,
  ReviewedPullRequestVerificationError,
  stageGovernedTopicMutation,
  startReviewedModelBranch,
  type GovernedTopicMutationEvidence,
  type ModelWriteCapability,
  type ReviewedModelBranch,
} from '@/services/reviewedModelWrite';
import { getModelYaml } from '@/services/omniApi';
import { findAuthoredTopicYamlFile } from '@/services/topicYamlGovernance';
import type { ConnectionConfig, OmniModel } from '@/types';
import { ReleaseGateEvidencePanel } from '@/components/modelGovernance/ReleaseGateEvidencePanel';
import {
  collectTargetedAffectedContent,
  collectReleaseGateEvidence,
  reconcileReleaseGateApproval,
  type ReleaseGateApproval,
  type ReleaseGateEvidence,
} from '@/services/releaseGateEvidence';

type ReviewedTopicDeletePanelProps = {
  connection: ConnectionConfig;
  model: OmniModel;
  topicName: string;
  capability: ModelWriteCapability | null;
  capabilityLoading: boolean;
};

function normalizeTopicName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function ReviewedTopicDeletePanel({
  connection,
  model,
  topicName,
  capability,
  capabilityLoading,
}: ReviewedTopicDeletePanelProps) {
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState<'idle' | 'staging' | 'ready' | 'blocked' | 'discarding' | 'discarded' | 'failed'>('idle');
  const [error, setError] = useState('');
  const [branch, setBranch] = useState<ReviewedModelBranch | null>(null);
  const [evidence, setEvidence] = useState<GovernedTopicMutationEvidence | null>(null);
  const [releaseEvidence, setReleaseEvidence] = useState<ReleaseGateEvidence | null>(null);
  const [releaseApproval, setReleaseApproval] = useState<ReleaseGateApproval | null>(null);
  const [handoff, setHandoff] = useState<{ status: 'idle' | 'creating' | 'ready' | 'failed' | 'quarantined'; message: string; url: string }>({
    status: 'idle',
    message: '',
    url: '',
  });

  const confirmed = confirmation.trim() === topicName;
  const busy = status === 'staging' || status === 'discarding' || handoff.status === 'creating';
  const canStage = capability?.editable === true && confirmed && !busy && !evidence && !branch;
  const releaseBlocked = releaseEvidence?.status === 'blocked';

  async function handleStageRemoval() {
    if (!canStage) return;
    setStatus('staging');
    setError('');
    let nextBranch: ReviewedModelBranch | null = null;
    try {
      const sourceYaml = await getModelYaml(connection.baseUrl, connection.apiKey, model.id, {
        includeChecksums: true,
        fullyResolved: false,
      });
      const sourceTopicFile = findAuthoredTopicYamlFile(sourceYaml, topicName);
      if (!sourceTopicFile) {
        throw new Error(`OmniKit could not resolve one exact authored .topic file for ${topicName}. Resolve missing or duplicate paths before removal.`);
      }
      nextBranch = await startReviewedModelBranch(connection, model, `omnikit-topic-remove-${normalizeTopicName(topicName)}`);
      setBranch(nextBranch);
      const nextEvidence = await stageGovernedTopicMutation(connection, nextBranch, {
        action: 'delete',
        fileName: sourceTopicFile.fileName,
        commitMessage: `Stage reviewed removal of ${sourceTopicFile.fileName}`,
      });
      const affectedContentEvidence = await collectTargetedAffectedContent(
        connection,
        model.id,
        [{ type: 'TOPIC', name: topicName }],
      );
      const nextReleaseEvidence = await collectReleaseGateEvidence({
        connection,
        model,
        branch: nextBranch,
        affectedFiles: [nextEvidence.fileName],
        ...affectedContentEvidence,
      });
      setEvidence(nextEvidence);
      setReleaseEvidence(nextReleaseEvidence);
      setReleaseApproval(null);
      setStatus(nextReleaseEvidence.status === 'blocked' ? 'blocked' : 'ready');
    } catch (stageError) {
      let cleanupError = '';
      if (nextBranch) {
        try {
          await discardReviewedModelBranch(connection, nextBranch);
          setBranch(null);
        } catch (cleanupFailure) {
          setBranch(nextBranch);
          cleanupError = ` Review branch ${nextBranch.branchName} could not be discarded automatically: ${cleanupFailure instanceof Error ? cleanupFailure.message : 'unknown cleanup failure'}`;
        }
      }
      setStatus('failed');
      setError(`${stageError instanceof Error ? stageError.message : 'The reviewed topic removal could not be staged.'}${cleanupError}`);
    }
  }

  async function handleDiscard() {
    if (!branch || busy) return;
    setStatus('discarding');
    setError('');
    try {
      await discardReviewedModelBranch(connection, branch);
      setEvidence(null);
      setReleaseEvidence(null);
      setBranch(null);
      setConfirmation('');
      setReleaseApproval(null);
      setHandoff({ status: 'idle', message: '', url: '' });
      setStatus('discarded');
    } catch (discardError) {
      setStatus('failed');
      setError(discardError instanceof Error ? discardError.message : 'The review branch could not be discarded.');
    }
  }

  async function handleReleaseHandoff() {
    if (!branch || !evidence || !releaseEvidence || releaseEvidence.status === 'blocked' || !releaseApproval) return;
    setHandoff({ status: 'creating', message: '', url: '' });
    try {
      const affectedContentEvidence = await collectTargetedAffectedContent(
        connection,
        model.id,
        [{ type: 'TOPIC', name: topicName }],
      );
      const freshEvidence = await collectReleaseGateEvidence({
        connection,
        model,
        branch,
        affectedFiles: [evidence.fileName],
        ...affectedContentEvidence,
      });
      const currentApproval = reconcileReleaseGateApproval(releaseApproval, freshEvidence);
      if (!currentApproval) {
        setReleaseEvidence(freshEvidence);
        setReleaseApproval(null);
        setHandoff({
          status: 'failed',
          message: 'Release evidence changed or is blocked. Review the refreshed fingerprint and approve it again before handoff.',
          url: '',
        });
        return;
      }
      if (!branch.capability.pullRequestRequired) {
        setHandoff({
          status: 'ready',
          message: 'The validated development branch remains for final sign-off in Omni. OmniKit did not merge or publish it.',
          url: branch.capability.webUrl || connection.baseUrl,
        });
        return;
      }
      const result = await createReviewedModelPullRequestHandoff(
        connection,
        branch,
        `Reviewed topic removal: ${evidence.fileName}`,
      );
      setHandoff({
        status: 'ready',
        message: result.message,
        url: result.url || branch.capability.webUrl || connection.baseUrl,
      });
    } catch (handoffError) {
      const reportedReviewUrl = handoffError instanceof ReviewedPullRequestVerificationError
        ? handoffError.reviewUrl || ''
        : '';
      if (handoffError instanceof ReviewedPullRequestVerificationError) setReleaseApproval(null);
      setHandoff({
        status: handoffError instanceof ReviewedPullRequestVerificationError ? 'quarantined' : 'failed',
        message: `${handoffError instanceof Error ? handoffError.message : 'The pull-request handoff could not be created.'}${handoffError instanceof ReviewedPullRequestVerificationError ? ' No retry is allowed until the reported review is reconciled in Omni.' : reportedReviewUrl ? ' Open the reported review and reconcile it before taking another action.' : ''}`,
        url: reportedReviewUrl || (handoffError instanceof ReviewedPullRequestVerificationError ? branch.capability.webUrl || connection.baseUrl : ''),
      });
    }
  }

  return (
    <details className="rounded-card border border-border bg-white overflow-hidden">
      <summary className="cursor-pointer px-3 py-2 bg-surface-secondary border-b border-border">
        <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-content-secondary">
          <Trash2 size={14} /> Remove topic
        </span>
      </summary>
      <div className="p-4 space-y-4">
        <div className="rounded-card border border-amber-100 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Removal is staged for review</div>
              <div className="mt-1 text-xs leading-relaxed">
                OmniKit creates a dev branch, removes the exact authored topic file there, and validates the result. The shared model is not changed automatically.
              </div>
            </div>
          </div>
        </div>

        {capabilityLoading ? (
          <div className="text-xs text-content-secondary inline-flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Checking model write policy...
          </div>
        ) : !capability?.editable ? (
          <div className="rounded-button border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
            {capability?.reason || 'OmniKit could not verify that this model supports reviewed branch changes.'}
          </div>
        ) : evidence && branch ? (
          <div className="space-y-3">
            <div className={`rounded-card border p-3 text-sm ${
              evidence.validation.blocking || releaseBlocked
                ? 'border-red-100 bg-red-50 text-red-800'
                : 'border-green-100 bg-green-50 text-green-800'
            }`}>
              <div className="font-semibold">
                {evidence.validation.blocking || releaseBlocked ? 'Release gate needs attention' : 'Removal is ready for human review'}
              </div>
              <div className="mt-1 text-xs leading-relaxed">
                Branch <span className="font-mono">{branch.branchName}</span> · file <span className="font-mono">{evidence.fileName}</span> · {evidence.validation.modelIssues.length} model issues · {evidence.validation.contentIssueCount} content issues
              </div>
              <div className="mt-1 text-xs">
                {branch.capability.pullRequestRequired
                  ? 'This model requires a pull request before the shared model can change.'
                  : 'Review the diff in Omni and choose whether to merge it. OmniKit has not published this branch.'}
              </div>
            </div>
            <details className="rounded-button border border-border bg-white overflow-hidden">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-content-primary">
                Review exact file removal ({evidence.diff.beforeYaml.split('\n').length} lines)
              </summary>
              <pre className="max-h-64 overflow-auto border-t border-border bg-surface-secondary p-3 text-[11px] leading-relaxed text-content-secondary whitespace-pre-wrap">
                {evidence.diff.beforeYaml}
              </pre>
            </details>
            {!evidence.validation.blocking && (
              releaseEvidence && (
                <ReleaseGateEvidencePanel
                  evidence={releaseEvidence}
                  approval={releaseApproval}
                  onApprovalChange={setReleaseApproval}
                  disabled={handoff.status === 'creating'}
                />
              )
            )}
            <div className="flex flex-wrap gap-2">
              {handoff.status === 'ready' || handoff.status === 'quarantined' ? (
                <a href={handoff.url} target="_blank" rel="noreferrer" className="btn-primary text-xs">
                  <ExternalLink size={14} /> {handoff.status === 'quarantined' ? 'Open Omni to reconcile' : branch.capability.pullRequestRequired ? 'Open pull request' : 'Open Omni for sign-off'}
                </a>
              ) : (
                <button
                  type="button"
                  onClick={handleReleaseHandoff}
                  disabled={!releaseApproval || evidence.validation.blocking || releaseBlocked || handoff.status === 'creating' || Boolean(handoff.url)}
                  className="btn-primary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {handoff.status === 'creating' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  {branch.capability.pullRequestRequired ? 'Create pull request handoff' : 'Prepare manual handoff'}
                </button>
              )}
              <button type="button" onClick={handleDiscard} disabled={busy || Boolean(handoff.url)} className="btn-secondary text-xs">
                {status === 'discarding' ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                Discard review branch
              </button>
              {handoff.status === 'failed' && handoff.url && (
                <a href={handoff.url} target="_blank" rel="noreferrer" className="btn-secondary text-xs">
                  <ExternalLink size={14} /> Open reported review
                </a>
              )}
            </div>
            {handoff.message && (
              <div className={`rounded-button border px-3 py-2 text-xs ${
                handoff.status === 'failed'
                  ? 'border-red-100 bg-red-50 text-red-700'
                  : 'border-green-100 bg-green-50 text-green-800'
              }`}>
                {handoff.message}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block text-xs font-semibold text-content-primary">
              Type <span className="font-mono">{topicName}</span> to confirm
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                className="input-field mt-1 font-mono text-xs"
                autoComplete="off"
              />
            </label>
            <button type="button" onClick={handleStageRemoval} disabled={!canStage} className="btn-secondary text-xs disabled:opacity-50 disabled:cursor-not-allowed">
              {status === 'staging' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Stage removal on dev branch
            </button>
            {status === 'discarded' && (
              <div className="rounded-button border border-green-100 bg-green-50 px-3 py-2 text-xs text-green-800">
                The review branch was discarded. The shared model was never changed.
              </div>
            )}
            {status === 'failed' && branch && (
              <div className="rounded-button border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <div className="font-semibold">Review branch cleanup is still required</div>
                <div className="mt-1 font-mono break-all">{branch.branchName}</div>
                <button type="button" onClick={handleDiscard} disabled={busy} className="btn-secondary text-xs mt-2">
                  <RotateCcw size={14} />
                  Retry branch cleanup
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-button border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
      </div>
    </details>
  );
}
