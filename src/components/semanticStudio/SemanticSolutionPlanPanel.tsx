import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  FileCode2,
  FilePenLine,
  Info,
  Layers3,
  Loader2,
  Wrench,
} from 'lucide-react';
import { SemanticBlueprintPanel } from '@/components/semanticStudio/SemanticBlueprintPanel';
import type {
  SemanticBlueprintDraft,
  SemanticBlueprintRelationshipContract,
  SemanticBlueprintViewOption,
} from '@/services/semanticBlueprint';
import type {
  SemanticArtifactAction,
  SemanticArtifactKind,
  SemanticArtifactReadiness,
  SemanticPermissionIntent,
  SemanticRelationshipIntent,
  SemanticSolutionDependencyItem,
  SemanticSolutionGoal,
  SemanticSolutionPlan,
} from '@/services/semanticSolutionPlanner';

export interface SemanticSolutionPlanPanelProps {
  goal: SemanticSolutionGoal;
  onGoalChange: (goal: SemanticSolutionGoal) => void;
  plan: SemanticSolutionPlan | null;
  selectedTopicName: string;
  plannedTopicName: string;
  onPlannedTopicNameChange: (name: string) => void;
  blueprintDraft: SemanticBlueprintDraft;
  blueprintViewOptions: SemanticBlueprintViewOption[];
  blueprintRelationshipContracts: SemanticBlueprintRelationshipContract[];
  blueprintIssues: string[];
  approvalNotice?: string;
  blueprintViewInventoryError?: string;
  onBlueprintDraftChange: (patch: Partial<SemanticBlueprintDraft>) => void;
  requestedArtifactFileNames: string[];
  onRequestedArtifactFileNamesChange: (fileNames: string[]) => void;
  relationshipIntent: SemanticRelationshipIntent;
  onRelationshipIntentChange: (intent: SemanticRelationshipIntent) => void;
  permissionIntent: SemanticPermissionIntent;
  onPermissionIntentChange: (intent: SemanticPermissionIntent) => void;
  accessSetup?: ReactNode;
  onItemActionChange: (itemId: string, action: SemanticArtifactAction) => void;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
  onRefreshModel?: () => void;
  busy: boolean;
}

const GOAL_OPTIONS: Array<{
  value: SemanticSolutionGoal;
  label: string;
  summary: string;
  recommended?: boolean;
}> = [
  {
    value: 'build_new_topic',
    label: 'Build a topic end to end',
    summary: 'Plan the model, dependencies, topic, and access together.',
    recommended: true,
  },
  {
    value: 'improve_existing_topic',
    label: 'Improve an existing topic',
    summary: 'Review the selected topic and the semantic files it depends on.',
  },
  {
    value: 'advanced_single_file',
    label: 'Advanced: edit one semantic file',
    summary: 'Limit the plan to explicitly requested semantic artifacts.',
  },
];

const DEPENDENCY_GROUPS: Array<{
  kind: SemanticArtifactKind;
  label: string;
}> = [
  { kind: 'model', label: 'Model setup' },
  { kind: 'view', label: 'Views' },
  { kind: 'query_view', label: 'Query views' },
  { kind: 'relationships', label: 'How the data connects' },
  { kind: 'topic', label: 'Topic' },
  { kind: 'permissions', label: 'Access' },
];

const STATUS_LABELS: Record<SemanticArtifactReadiness, string> = {
  ready: 'Ready',
  needs_work: 'Needs work',
  missing: 'Missing',
  not_required: 'Not required',
  blocked: 'Blocked',
};

const STATUS_STYLES: Record<SemanticArtifactReadiness, string> = {
  ready: 'border-green-200 bg-green-50 text-green-800',
  needs_work: 'border-amber-200 bg-amber-50 text-amber-900',
  missing: 'border-blue-200 bg-blue-50 text-blue-800',
  not_required: 'border-gray-200 bg-gray-50 text-gray-600',
  blocked: 'border-red-200 bg-red-50 text-red-800',
};

const ACTION_LABELS: Record<SemanticArtifactAction, string> = {
  reuse: 'Use existing',
  edit: 'Update',
  create: 'Create',
  exclude: 'Exclude from this topic',
};

function goalIcon(goal: SemanticSolutionGoal) {
  if (goal === 'build_new_topic') return <Layers3 size={16} aria-hidden="true" />;
  if (goal === 'improve_existing_topic') return <Wrench size={16} aria-hidden="true" />;
  return <FilePenLine size={16} aria-hidden="true" />;
}

function parseArtifactFileNames(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((fileName) => fileName.trim())
    .filter(Boolean);
}

function sameFileNames(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((fileName, index) => fileName === right[index]);
}

function StatusBadge({ readiness }: { readiness: SemanticArtifactReadiness }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-chip border px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[readiness]}`}>
      {STATUS_LABELS[readiness]}
    </span>
  );
}

function DependencyItemRow({
  item,
  index,
  itemCount,
  busy,
  onActionChange,
}: {
  item: SemanticSolutionDependencyItem;
  index: number;
  itemCount: number;
  busy: boolean;
  onActionChange: (itemId: string, action: SemanticArtifactAction) => void;
}) {
  const dependencyLabel = itemCount > 1
    ? `${item.required ? 'Required' : 'Optional'} dependency ${index + 1}`
    : `${item.required ? 'Required' : 'Optional'} dependency`;
  const actionOptions: SemanticArtifactAction[] = item.kind === 'permissions'
    ? ['edit', 'exclude']
    : item.exists
      ? ['reuse', 'edit', 'exclude']
      : item.readiness === 'not_required' && item.kind !== 'relationships'
        ? ['exclude']
        : ['create', 'exclude'];
  const selectableActions = item.readiness === 'blocked' && !/user (?:explicitly )?excluded|action override/i.test(item.reason)
    ? [item.action]
    : actionOptions;

  return (
    <div className="flex min-h-10 flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-xs text-content-secondary">
        {dependencyLabel}{item.requested ? ' / Requested' : ''}
      </span>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <StatusBadge readiness={item.readiness} />
        {selectableActions.length > 1 ? (
          <label className="flex items-center gap-2 text-xs text-content-secondary">
            <span className="sr-only">Decision for {item.fileName}</span>
            <select
              value={item.action}
              disabled={busy}
              onChange={(event) => onActionChange(item.id, event.target.value as SemanticArtifactAction)}
              className="input-field min-w-[9.5rem] py-1 text-xs font-medium text-content-primary"
              aria-label={`Decision for ${item.fileName}`}
            >
              {selectableActions.map((action) => (
                <option key={action} value={action}>{ACTION_LABELS[action]}</option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-xs font-medium text-content-primary">{ACTION_LABELS[item.action]}</span>
        )}
      </div>
    </div>
  );
}

export function SemanticSolutionPlanPanel({
  goal,
  onGoalChange,
  plan,
  selectedTopicName,
  plannedTopicName,
  onPlannedTopicNameChange,
  blueprintDraft,
  blueprintViewOptions,
  blueprintRelationshipContracts,
  blueprintIssues,
  approvalNotice,
  blueprintViewInventoryError,
  onBlueprintDraftChange,
  requestedArtifactFileNames,
  onRequestedArtifactFileNamesChange,
  relationshipIntent,
  onRelationshipIntentChange,
  permissionIntent,
  onPermissionIntentChange,
  accessSetup,
  onItemActionChange,
  advancedOpen,
  onAdvancedOpenChange,
  onRefreshModel,
  busy,
}: SemanticSolutionPlanPanelProps) {
  const goalGroupId = useId();
  const topicNameInputId = useId();
  const topicNameHelpId = useId();
  const accessGroupId = useId();
  const relationshipGroupId = useId();
  const artifactInputId = useId();
  const artifactHelpId = useId();
  const [artifactDraft, setArtifactDraft] = useState(() => requestedArtifactFileNames.join('\n'));
  const parsedArtifactFileNames = useMemo(() => parseArtifactFileNames(artifactDraft), [artifactDraft]);
  const artifactInputIssue = parsedArtifactFileNames.length > 1
    ? 'Enter exactly one artifact file. No file from this input will be used until the extra entries are removed.'
    : '';

  useEffect(() => {
    setArtifactDraft((currentDraft) => {
      const currentFileNames = parseArtifactFileNames(currentDraft);
      if (currentFileNames.length > 1) return currentDraft;
      return sameFileNames(currentFileNames, requestedArtifactFileNames)
        ? currentDraft
        : requestedArtifactFileNames.join('\n');
    });
  }, [requestedArtifactFileNames]);

  const itemsByKind = useMemo(() => {
    const grouped = new Map<SemanticArtifactKind, SemanticSolutionDependencyItem[]>();
    DEPENDENCY_GROUPS.forEach(({ kind }) => grouped.set(kind, []));
    plan?.items.forEach((item) => grouped.get(item.kind)?.push(item));
    return grouped;
  }, [plan]);

  const selectedTopic = selectedTopicName.trim();
  const relationshipPlanItem = itemsByKind.get('relationships')?.[0];
  const relationshipPlanMessage = relationshipPlanItem
    ? relationshipPlanItem.action === 'reuse'
      ? 'How the data connects: use the existing relationship file. OmniKit will not replace it.'
      : relationshipPlanItem.action === 'exclude'
        ? 'How the data connects: no relationship-file change is planned. Add one only after its fields and row behavior are confirmed.'
        : relationshipPlanItem.action === 'create'
          ? 'How the data connects: create the reviewed relationship file before the topic is built.'
          : 'How the data connects: update the reviewed relationship file before the topic is built.'
    : '';

  return (
    <section className="space-y-4" aria-busy={busy}>
      <div>
        <h2 className="text-base font-semibold text-content-primary">Build a semantic solution</h2>
        <p className="mt-1 text-sm text-content-secondary">
          Choose the outcome first. The dependency plan stays reviewable before any Omni change.
        </p>
      </div>

      <fieldset disabled={busy}>
        <legend className="mb-2 text-xs font-semibold text-content-primary">Goal</legend>
        <div className="grid overflow-hidden rounded-button border border-border lg:grid-cols-3">
          {GOAL_OPTIONS.map((option) => {
            const selected = goal === option.value;
            return (
              <label
                key={option.value}
                className={`flex cursor-pointer gap-3 border-b border-border px-3 py-3 transition-colors last:border-b-0 focus-within:z-10 focus-within:ring-2 focus-within:ring-inset focus-within:ring-omni-500 lg:border-b-0 lg:border-r lg:last:border-r-0 ${selected ? 'bg-omni-50' : 'bg-white hover:bg-surface-secondary'} ${busy ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <input
                  type="radio"
                  name={goalGroupId}
                  value={option.value}
                  checked={selected}
                  onChange={() => onGoalChange(option.value)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-omni-600"
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-content-primary">
                    {goalIcon(option.value)}
                    <span>{option.label}</span>
                    {option.recommended && (
                      <span className="rounded-chip border border-green-200 bg-green-50 px-2 py-0.5 text-[10px] font-semibold text-green-800">
                        Recommended
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-content-secondary">{option.summary}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {goal !== 'advanced_single_file' && (
        <div className="space-y-4">
          {goal === 'improve_existing_topic' && (
            <div className="flex flex-col gap-1 border-l-2 border-omni-300 pl-3 sm:flex-row sm:items-baseline sm:gap-2">
              <span className="text-xs font-semibold text-content-secondary">Selected topic</span>
              <span className="text-sm font-semibold text-content-primary">
                {selectedTopic || 'No topic selected'}
              </span>
            </div>
          )}

          {goal === 'build_new_topic' && (
          <label htmlFor={topicNameInputId} className="block text-xs font-semibold text-content-primary">
            Topic name
            <input
              id={topicNameInputId}
              value={plannedTopicName}
              onChange={(event) => onPlannedTopicNameChange(event.target.value)}
              disabled={busy}
              aria-describedby={topicNameHelpId}
              autoComplete="off"
              className="input-field mt-1 w-full text-sm font-normal"
              placeholder="Customer analytics"
            />
            <span id={topicNameHelpId} className="mt-1 block font-normal text-content-secondary">
              Use the business-facing name people should recognize in Omni.
            </span>
          </label>
          )}

        </div>
      )}

      {goal !== 'advanced_single_file' && (
        <SemanticBlueprintPanel
          draft={blueprintDraft}
          viewOptions={blueprintViewOptions}
          existingRelationshipContracts={blueprintRelationshipContracts}
          issues={blueprintIssues}
          relationshipIntent={relationshipIntent}
          permissionIntent={permissionIntent}
          approvalNotice={approvalNotice}
          viewInventoryError={blueprintViewInventoryError}
          relationshipIntentSetup={(
            <fieldset disabled={busy}>
              <legend className="mb-2 text-xs font-semibold text-content-primary">How the data connects</legend>
              <div className="grid overflow-hidden rounded-button border border-border md:grid-cols-2">
                <label className={`flex cursor-pointer items-start gap-2 border-b border-border px-3 py-3 transition-colors focus-within:z-10 focus-within:ring-2 focus-within:ring-inset focus-within:ring-omni-500 md:border-b-0 md:border-r ${relationshipIntent === 'required' ? 'bg-omni-50' : 'bg-white hover:bg-surface-secondary'}`}>
                  <input
                    type="radio"
                    name={relationshipGroupId}
                    value="required"
                    checked={relationshipIntent === 'required'}
                    onChange={() => onRelationshipIntentChange('required')}
                    className="mt-0.5 h-4 w-4 accent-omni-600"
                  />
                  <span>
                    <span className="block text-xs font-semibold text-content-primary">Review or create connections</span>
                    <span className="mt-1 block text-xs leading-relaxed text-content-secondary">Required when related data is selected. OmniKit preserves existing joins and prepares Settings/relationships before the topic.</span>
                  </span>
                </label>
                <label className={`flex cursor-pointer items-start gap-2 px-3 py-3 transition-colors focus-within:z-10 focus-within:ring-2 focus-within:ring-inset focus-within:ring-omni-500 ${relationshipIntent === 'not_required' ? 'bg-omni-50' : 'bg-white hover:bg-surface-secondary'}`}>
                  <input
                    type="radio"
                    name={relationshipGroupId}
                    value="not_required"
                    checked={relationshipIntent === 'not_required'}
                    onChange={() => onRelationshipIntentChange('not_required')}
                    className="mt-0.5 h-4 w-4 accent-omni-600"
                  />
                  <span>
                    <span className="block text-xs font-semibold text-content-primary">Use only the main data source</span>
                    <span className="mt-1 block text-xs leading-relaxed text-content-secondary">Choose this only when no related data is needed. OmniKit will not change Settings/relationships.</span>
                  </span>
                </label>
              </div>
            </fieldset>
          )}
          accessIntentSetup={(
            <fieldset disabled={busy}>
              <legend className="mb-2 text-xs font-semibold text-content-primary">Who can use this topic?</legend>
              <div className="inline-flex max-w-full overflow-hidden rounded-button border border-border bg-white">
                <label className={`flex cursor-pointer items-center gap-2 border-r border-border px-3 py-2 text-xs font-medium ${permissionIntent === 'required' ? 'bg-omni-50 text-omni-900' : 'text-content-secondary hover:bg-surface-secondary'} ${busy ? 'cursor-not-allowed opacity-60' : ''}`}>
                  <input
                    type="radio"
                    name={accessGroupId}
                    value="required"
                    checked={permissionIntent === 'required'}
                    onChange={() => onPermissionIntentChange('required')}
                    className="h-4 w-4 accent-omni-600"
                  />
                  Configure access
                </label>
                <label className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium ${permissionIntent === 'not_required' ? 'bg-omni-50 text-omni-900' : 'text-content-secondary hover:bg-surface-secondary'} ${busy ? 'cursor-not-allowed opacity-60' : ''}`}>
                  <input
                    type="radio"
                    name={accessGroupId}
                    value="not_required"
                    checked={permissionIntent === 'not_required'}
                    onChange={() => onPermissionIntentChange('not_required')}
                    className="h-4 w-4 accent-omni-600"
                  />
                  Keep access unchanged
                </label>
              </div>
            </fieldset>
          )}
          accessSetup={accessSetup}
          busy={busy}
          onRefreshModel={onRefreshModel}
          onChange={onBlueprintDraftChange}
        />
      )}

      <section aria-labelledby={`${goalGroupId}-dependencies`} className="overflow-hidden rounded-button border border-border bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-secondary px-3 py-2">
          <h3 id={`${goalGroupId}-dependencies`} className="text-xs font-semibold text-content-primary">
            Dependency plan
          </h3>
          {busy && (
            <span role="status" className="inline-flex items-center gap-1.5 text-xs text-content-secondary">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" /> Updating
            </span>
          )}
        </div>

        {plan ? (
          <div>
            {DEPENDENCY_GROUPS.map(({ kind, label }) => {
              const items = itemsByKind.get(kind) || [];
              return (
                <div key={kind} className="grid border-b border-border last:border-b-0 sm:grid-cols-[11rem_minmax(0,1fr)]">
                  <div className="bg-surface-secondary px-3 py-2 text-xs font-semibold text-content-primary">
                    {label}
                  </div>
                  <div className="divide-y divide-border">
                    {items.length > 0 ? items.map((item, index) => (
                      <DependencyItemRow
                        key={item.id}
                        item={item}
                        index={index}
                        itemCount={items.length}
                        busy={busy}
                        onActionChange={onItemActionChange}
                      />
                    )) : (
                      <div className="flex min-h-10 items-center justify-end px-3 py-2">
                        <StatusBadge readiness="not_required" />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-4 text-sm text-content-secondary">
            The dependency plan will appear here when the current choices are ready.
          </div>
        )}
      </section>

      {relationshipPlanMessage && (
        <div className="flex items-start gap-2 border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900" role="status">
          <Info size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{relationshipPlanMessage}</span>
        </div>
      )}

      {plan?.blocked && plan.blockers.length > 0 && (
        <div className="border border-red-200 bg-red-50 px-3 py-3 text-red-900" role="alert">
          <h3 className="text-xs font-semibold">Blocked reasons</h3>
          <ul className="mt-2 space-y-1.5 text-xs leading-relaxed">
            {plan.blockers.map((reason) => <li key={reason}>- {reason}</li>)}
          </ul>
        </div>
      )}

      <details
        open={advancedOpen}
        onToggle={(event) => {
          if (event.currentTarget.open !== advancedOpen) {
            onAdvancedOpenChange(event.currentTarget.open);
          }
        }}
        className="overflow-hidden rounded-button border border-border bg-white"
      >
        <summary className="flex cursor-pointer items-center gap-2 bg-surface-secondary px-3 py-2 text-xs font-semibold text-content-primary">
          <FileCode2 size={14} aria-hidden="true" />
          Advanced details
        </summary>
        <div className="space-y-4 border-t border-border p-3">
          <section aria-labelledby={`${artifactInputId}-file-list`}>
            <h3 id={`${artifactInputId}-file-list`} className="text-xs font-semibold text-content-primary">
              Technical artifact files
            </h3>
            {plan?.items.length ? (
              <ul className="mt-2 divide-y divide-border border-y border-border">
                {plan.items.map((item) => {
                  const groupLabel = DEPENDENCY_GROUPS.find((group) => group.kind === item.kind)?.label;
                  return (
                    <li key={item.id} className="flex flex-col gap-1 py-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                      <code className="break-all text-content-primary">{item.fileName}</code>
                      <span className="shrink-0 text-content-secondary">{groupLabel}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-content-secondary">No technical artifact files are planned yet.</p>
            )}
          </section>

          {goal === 'advanced_single_file' ? (
            <label htmlFor={artifactInputId} className="block text-xs font-semibold text-content-primary">
              Requested artifact file
              <input
                id={artifactInputId}
                value={artifactDraft}
                onChange={(event) => {
                  const nextDraft = event.target.value;
                  const nextFileNames = parseArtifactFileNames(nextDraft);
                  setArtifactDraft(nextDraft);
                  onRequestedArtifactFileNamesChange(nextFileNames.length <= 1 ? nextFileNames : []);
                }}
                disabled={busy}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-describedby={artifactHelpId}
                aria-invalid={Boolean(artifactInputIssue)}
                className="input-field mt-1 w-full font-mono text-xs font-normal"
                placeholder="views/orders.view"
              />
              <span id={artifactHelpId} className="mt-1 block font-normal text-content-secondary">
                {artifactInputIssue ? (
                  <span role="alert" className="text-red-700">{artifactInputIssue}</span>
                ) : (
                  'Advanced mode intentionally limits this run to one reviewed semantic file.'
                )}
              </span>
            </label>
          ) : (
            <p className="text-xs leading-relaxed text-content-secondary">
              View files are controlled by the approved build instructions. Only the main data source and selected related data can enter this solution.
            </p>
          )}
        </div>
      </details>
    </section>
  );
}

export default SemanticSolutionPlanPanel;
