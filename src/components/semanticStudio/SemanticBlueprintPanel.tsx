import { useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, Database, Info, Search, ShieldCheck } from 'lucide-react';
import { ComboBox } from '@/components/ui/ComboBox';
import type {
  SemanticBlueprintDraft,
  SemanticBlueprintRelationshipContract,
  SemanticBlueprintRelationshipDecision,
  SemanticBlueprintRelationshipType,
  SemanticBlueprintViewOption,
} from '@/services/semanticBlueprint';
import { semanticBlueprintQuestionLinesForEditing } from '@/services/semanticBlueprint';
import type {
  SemanticPermissionIntent,
  SemanticRelationshipIntent,
} from '@/services/semanticSolutionPlanner';

type SemanticBlueprintDraftWithDateDecision = SemanticBlueprintDraft & {
  primaryDateNotRequired?: boolean;
};

type SemanticBlueprintViewOptionWithDates = SemanticBlueprintViewOption & {
  dateFieldNames?: string[];
};

interface SemanticBlueprintPanelProps {
  draft: SemanticBlueprintDraftWithDateDecision;
  viewOptions: SemanticBlueprintViewOptionWithDates[];
  existingRelationshipContracts: SemanticBlueprintRelationshipContract[];
  issues: string[];
  relationshipIntent: SemanticRelationshipIntent;
  permissionIntent: SemanticPermissionIntent;
  approvalNotice?: string;
  viewInventoryError?: string;
  relationshipIntentSetup?: ReactNode;
  accessIntentSetup?: ReactNode;
  accessSetup?: ReactNode;
  busy: boolean;
  onRefreshModel?: () => void;
  onChange: (patch: Partial<SemanticBlueprintDraftWithDateDecision>) => void;
}

const NO_DEFAULT_DATE_VALUE = '__omnikit_no_default_date__';

function optionLabel(option: SemanticBlueprintViewOption): string {
  const context = [
    option.schemaName,
    option.roleHint === 'unknown' ? '' : `${option.roleHint} hint`,
  ].filter(Boolean).join(' · ');
  return context ? `${option.viewName} — ${context}` : option.viewName;
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

const RELATIONSHIP_DECISION_OPTIONS: Array<{
  value: SemanticBlueprintRelationshipDecision;
  label: string;
}> = [
  { value: 'use_existing', label: 'Reuse an existing model relationship' },
  { value: 'propose_reusable', label: 'Let Blobby propose how the data connects' },
  { value: 'create_reusable', label: 'Enter an exact relationship manually (advanced)' },
  { value: 'needs_review', label: 'Defer to a semantic owner' },
];

const RELATIONSHIP_TYPE_OPTIONS: Array<{ value: SemanticBlueprintRelationshipType; label: string }> = [
  { value: 'many_to_one', label: 'Many primary rows to one supporting row' },
  { value: 'one_to_many', label: 'One primary row to many supporting rows' },
  { value: 'one_to_one', label: 'One primary row to one supporting row' },
  { value: 'many_to_many', label: 'Many-to-many (fanout risk)' },
  { value: 'assumed_many_to_one', label: 'Assumed many-to-one (must validate)' },
];

function defaultRelationshipContract(
  primaryViewName: string,
  supportingViewName: string,
): SemanticBlueprintRelationshipContract {
  return {
    joinFromView: primaryViewName,
    joinToView: supportingViewName,
    joinType: 'always_left',
    onSql: '',
    relationshipType: 'many_to_one',
    reversible: false,
  };
}

function relationshipContractKey(contract: SemanticBlueprintRelationshipContract): string {
  return JSON.stringify(contract);
}

export function SemanticBlueprintPanel({
  draft,
  viewOptions,
  existingRelationshipContracts,
  issues,
  relationshipIntent,
  permissionIntent,
  approvalNotice,
  viewInventoryError,
  relationshipIntentSetup,
  accessIntentSetup,
  accessSetup,
  busy,
  onRefreshModel,
  onChange,
}: SemanticBlueprintPanelProps) {
  const [supportingSearch, setSupportingSearch] = useState('');
  const schemaNames = useMemo(() => Array.from(new Set(
    viewOptions.map((option) => option.schemaName).filter((value): value is string => Boolean(value)),
  )).sort(), [viewOptions]);
  const selectedSchemas = new Set(draft.focusedSchemaNames.map((schemaName) => schemaName.toLowerCase()));
  const focusedViewOptions = viewOptions.filter((option) => (
    selectedSchemas.size === 0
    || !option.schemaName
    || selectedSchemas.has(option.schemaName.toLowerCase())
  ));
  const primaryOptions = focusedViewOptions.map((option) => ({
    value: option.viewName,
    label: optionLabel(option),
  }));
  const supportingOptions = focusedViewOptions
    .filter((option) => option.viewName !== draft.primaryViewName)
    .filter((option) => !supportingSearch.trim() || optionLabel(option).toLowerCase().includes(supportingSearch.trim().toLowerCase()))
    .slice(0, 80);
  const approvedViews = [draft.primaryViewName, ...draft.supportingViewNames].filter(Boolean);
  const approvedViewNames = new Set(approvedViews.map((viewName) => viewName.toLowerCase()));
  const automaticallyExcludedViewCount = viewOptions.filter(
    (option) => !approvedViewNames.has(option.viewName.toLowerCase()),
  ).length;
  const dateFieldOptions = viewOptions.flatMap((option) => {
    if (!approvedViewNames.has(option.viewName.toLowerCase())) return [];
    return (option.dateFieldNames || []).flatMap((fieldName) => {
      const cleanFieldName = fieldName.trim();
      if (!cleanFieldName) return [];
      const reference = cleanFieldName.includes('.')
        ? cleanFieldName
        : `${option.viewName}.${cleanFieldName}`;
      return [{ value: reference, label: reference }];
    });
  }).filter((option, index, options) => (
    options.findIndex((candidate) => candidate.value.toLowerCase() === option.value.toLowerCase()) === index
  ));
  const primaryDateValue = draft.primaryDateNotRequired
    ? NO_DEFAULT_DATE_VALUE
    : draft.primaryDateField;
  const primaryDateVerified = !draft.primaryDateField || dateFieldOptions.some(
    (option) => option.value.toLowerCase() === draft.primaryDateField.toLowerCase(),
  );
  const localDateIssues = [
    !draft.primaryDateNotRequired && !draft.primaryDateField
      ? 'Choose a verified primary date or select No default date.'
      : '',
    !draft.primaryDateNotRequired && !primaryDateVerified
      ? 'The selected primary date is no longer available in the approved views. Choose another verified date or No default date.'
      : '',
  ].filter(Boolean);
  const preApprovalIssues = Array.from(new Set([
    ...issues.filter((issue) => !/approve the semantic blueprint/i.test(issue)),
    ...localDateIssues,
  ]));
  const relationshipIntentSummary = relationshipIntent === 'required'
    ? draft.supportingViewNames.length > 0
      ? 'A reviewed connection is required for every related data source.'
      : 'Connection review is included if the topic needs it.'
    : 'No relationship-file change is approved.';
  const permissionIntentSummary = permissionIntent === 'required'
    ? 'Access setup is included and must be confirmed before generation.'
    : 'No access changes are approved.';

  return (
    <section className="space-y-4 border-y border-border bg-surface-secondary px-3 py-4" aria-labelledby="semantic-blueprint-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="semantic-blueprint-title" className="text-sm font-semibold text-content-primary">
            Define the build instructions
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-content-secondary">
            Tell Blobby what the topic should mean and which data it may use. These approved instructions become the governed semantic blueprint and act as a hard boundary, not a suggestion.
          </p>
        </div>
        <span className={`inline-flex w-fit items-center gap-1 rounded-chip border px-2 py-1 text-[11px] font-semibold ${draft.reviewedAndApproved ? 'border-green-200 bg-green-50 text-green-800' : 'border-gray-200 bg-white text-content-secondary'}`}>
          {draft.reviewedAndApproved && <CheckCircle2 size={13} aria-hidden="true" />}
          {draft.reviewedAndApproved ? 'Approved by you' : 'Needs your approval'}
        </span>
      </div>

      <div className="border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-900" role="note">
        <div className="flex items-start gap-2">
          <Info size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold">Approval follows these choices.</span>{' '}
            Editing these build instructions, connection choices, access choices, or dependency file actions revokes approval. Review and approve again before continuing.
          </span>
        </div>
      </div>

      {approvalNotice && (
        <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900" role="status">
          {approvalNotice}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <label className="block text-xs font-semibold text-content-primary">
          Business outcome <span className="text-red-600">Required</span>
          <textarea
            value={draft.businessPurpose}
            onChange={(event) => onChange({ businessPurpose: event.target.value })}
            disabled={busy}
            rows={3}
            className="input-field mt-1 w-full resize-y text-sm font-normal"
            placeholder="Example: Help regional leaders understand store sales, menu performance, and operating trends."
          />
          <span className="mt-1 block font-normal text-content-secondary">Describe the decision this topic should help someone make.</span>
        </label>

        <label className="block text-xs font-semibold text-content-primary">
          Questions this topic must answer <span className="text-red-600">Required</span>
          <textarea
            value={draft.businessQuestions.join('\n')}
            onChange={(event) => onChange({
              businessQuestions: semanticBlueprintQuestionLinesForEditing(event.target.value),
            })}
            disabled={busy}
            rows={3}
            className="input-field mt-1 w-full resize-y text-sm font-normal"
            placeholder={'Which stores are growing fastest?\nWhich menu categories drive margin?'}
          />
          <span className="mt-1 block font-normal text-content-secondary">Use one question per line. These become acceptance criteria for the AI review.</span>
        </label>

        <label className="block text-xs font-semibold text-content-primary">
          What does one row represent? <span className="text-red-600">Required</span>
          <input
            value={draft.grain}
            onChange={(event) => onChange({ grain: event.target.value })}
            disabled={busy}
            className="input-field mt-1 w-full text-sm font-normal"
            placeholder="One row per order line"
          />
          <span className="mt-1 block font-normal text-content-secondary">State what one record represents so joins and measures preserve the right level of detail.</span>
        </label>

        <label className="block text-xs font-semibold text-content-primary">
          Audience <span className="font-normal text-content-tertiary">Optional</span>
          <input
            value={draft.audience}
            onChange={(event) => onChange({ audience: event.target.value })}
            disabled={busy}
            className="input-field mt-1 w-full text-sm font-normal"
            placeholder="Regional operators and finance leaders"
          />
          <span className="mt-1 block font-normal text-content-secondary">This guides naming and descriptions; it does not create permissions.</span>
        </label>
      </div>

      <div className="border-t border-border pt-4">
        <div className="flex items-start gap-2">
          <Database size={16} className="mt-0.5 shrink-0 text-content-secondary" aria-hidden="true" />
          <div>
            <h4 className="text-xs font-semibold text-content-primary">Set the data boundary</h4>
            <p className="mt-0.5 text-xs leading-relaxed text-content-secondary">
              Choose the exact views Blobby may use. Everything not approved remains out of scope.
            </p>
          </div>
        </div>

        {schemaNames.length > 0 && (
          <details className="mt-3 border-y border-border bg-white">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-content-primary">
              Focus schemas (optional){draft.focusedSchemaNames.length ? ` · ${draft.focusedSchemaNames.length} selected` : ''}
            </summary>
            <div className="flex flex-wrap gap-2 border-t border-border p-3">
              {schemaNames.map((schemaName) => {
                const selected = draft.focusedSchemaNames.includes(schemaName);
                return (
                  <label key={schemaName} className={`flex cursor-pointer items-center gap-2 border px-2.5 py-1.5 text-xs ${selected ? 'border-omni-300 bg-omni-50 text-omni-900' : 'border-border bg-white text-content-secondary'}`}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={busy}
                      onChange={() => onChange({ focusedSchemaNames: toggleValue(draft.focusedSchemaNames, schemaName) })}
                      className="h-4 w-4 accent-omni-600"
                    />
                    <span className="font-mono">{schemaName}</span>
                  </label>
                );
              })}
            </div>
          </details>
        )}

        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div>
            <label className="text-xs font-semibold text-content-primary">Main data source <span className="text-red-600">Required</span></label>
            <div className="mt-1">
              <ComboBox
                options={primaryOptions}
                value={draft.primaryViewName}
                onChange={(primaryViewName) => onChange({ primaryViewName })}
                placeholder={
                  primaryOptions.length > 0
                    ? 'Choose the main data source...'
                    : busy
                      ? 'Loading model views...'
                      : viewInventoryError
                        ? 'Effective model views could not be verified'
                      : viewOptions.length > 0
                        ? 'No views match the schema focus'
                        : 'No effective model views were returned by Omni'
                }
                ariaLabel="Main data source"
                allowFreeText={false}
                disabled={busy || primaryOptions.length === 0}
                emptyLabel="No model views match this search"
                maxVisibleOptions={80}
              />
            </div>
            {!busy && viewOptions.length === 0 && onRefreshModel && (
              <div className="mt-2 flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                <span>
                  {viewInventoryError
                    ? `OmniKit could not verify this model's effective view inventory. ${viewInventoryError}`
                    : 'Omni returned no effective model views. If this model should expose database views, refresh its schema in Omni and reload the inventory here.'}
                </span>
                <button
                  type="button"
                  onClick={onRefreshModel}
                  className="shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 font-semibold text-amber-900 hover:bg-amber-100"
                >
                  Reload views
                </button>
              </div>
            )}
            <p className="mt-1 text-[11px] leading-relaxed text-content-secondary">
              This becomes the topic base view. Fact/dimension labels are conservative name hints, not verified cardinality.
            </p>
          </div>

          <details className="overflow-hidden border border-border bg-white" open={draft.supportingViewNames.length > 0}>
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-content-primary">
              Related data (optional){draft.supportingViewNames.length > 0 ? ` · ${draft.supportingViewNames.length} selected` : ''}
            </summary>
            <div className="border-t border-border p-2">
              <p className="mb-2 text-[11px] leading-relaxed text-content-secondary">
                Select only the related data Blobby may use. Every view you do not select stays outside this solution automatically.
              </p>
              <label className="input-field flex items-center gap-2 py-1.5">
                <Search size={13} className="shrink-0 text-content-secondary" aria-hidden="true" />
                <span className="sr-only">Search related data</span>
                <input
                  type="search"
                  value={supportingSearch}
                  onChange={(event) => setSupportingSearch(event.target.value)}
                  disabled={busy}
                  placeholder="Search related views..."
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                />
              </label>
              <div className="mt-2 max-h-44 divide-y divide-border overflow-y-auto border-y border-border">
                {supportingOptions.length > 0 ? supportingOptions.map((option) => {
                  const selected = draft.supportingViewNames.includes(option.viewName);
                  return (
                    <label key={option.viewName} className="flex cursor-pointer items-center gap-2 px-2 py-2 text-xs text-content-primary hover:bg-surface-secondary">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={busy}
                        onChange={() => {
                          const nextSupportingViewNames = toggleValue(draft.supportingViewNames, option.viewName);
                          const relationshipDecisions = selected
                            ? Object.fromEntries(Object.entries(draft.relationshipDecisions).filter(([key]) => key !== option.viewName))
                            : { ...draft.relationshipDecisions, [option.viewName]: 'propose_reusable' as const };
                          const relationshipContracts = selected
                            ? Object.fromEntries(Object.entries(draft.relationshipContracts).filter(([key]) => key !== option.viewName))
                            : draft.relationshipContracts;
                          onChange({
                            supportingViewNames: nextSupportingViewNames,
                            relationshipDecisions,
                            relationshipContracts,
                          });
                        }}
                        className="h-4 w-4 shrink-0 accent-omni-600"
                      />
                      <span className="min-w-0 truncate">{optionLabel(option)}</span>
                    </label>
                  );
                }) : (
                  <div className="px-2 py-3 text-xs text-content-secondary">No related data matches this search.</div>
                )}
              </div>
            </div>
          </details>
        </div>

        <div className="mt-4 border-y border-border bg-white px-3 py-3">
          <label className="block text-xs font-semibold text-content-primary">
            Primary date <span className="text-red-600">Required</span>
            <div className="mt-1">
              <ComboBox
                options={[
                  { value: NO_DEFAULT_DATE_VALUE, label: 'No default date' },
                  ...dateFieldOptions,
                ]}
                value={primaryDateValue}
                onChange={(value) => onChange(value === NO_DEFAULT_DATE_VALUE
                  ? { primaryDateField: '', primaryDateNotRequired: true }
                  : { primaryDateField: value, primaryDateNotRequired: false })}
                placeholder={draft.primaryViewName ? 'Choose a verified date field...' : 'Choose the main data source first'}
                ariaLabel="Primary date"
                allowFreeText={false}
                disabled={busy || !draft.primaryViewName}
                emptyLabel="No verified date fields are available in the approved views"
                maxVisibleOptions={80}
              />
            </div>
            <span className="mt-1 block font-normal text-content-secondary">
              Choose a verified date from the approved data, or explicitly choose No default date. Blobby cannot infer another field.
            </span>
          </label>
        </div>

        {relationshipIntentSetup && (
          <div className="mt-4 border-t border-border pt-4">
            {relationshipIntentSetup}
          </div>
        )}

        {draft.supportingViewNames.length > 0 && (
          <div className="mt-3 border-y border-border bg-white" aria-labelledby="semantic-blueprint-relationship-title">
            <div className="px-3 py-2">
              <h5 id="semantic-blueprint-relationship-title" className="text-xs font-semibold text-content-primary">
                Decide how each related data source connects
              </h5>
              <p className="mt-0.5 text-[11px] leading-relaxed text-content-secondary">
                Blobby can propose each missing reusable relationship from the approved view YAML. You review the generated relationship file before anything is written to a branch.
              </p>
            </div>
            <div className="divide-y divide-border border-t border-border">
              {draft.supportingViewNames.map((viewName) => {
                const decision = draft.relationshipDecisions[viewName] || 'needs_review';
                const contract = draft.relationshipContracts[viewName]
                  || defaultRelationshipContract(draft.primaryViewName, viewName);
                const authoredContracts = existingRelationshipContracts.filter((candidate) => {
                  const endpoints = [candidate.joinFromView, candidate.joinToView].map((value) => value.toLowerCase());
                  return endpoints.includes(draft.primaryViewName.toLowerCase())
                    && endpoints.includes(viewName.toLowerCase());
                });
                const updateContract = (patch: Partial<SemanticBlueprintRelationshipContract>) => onChange({
                  relationshipContracts: {
                    ...draft.relationshipContracts,
                    [viewName]: { ...contract, ...patch, joinType: 'always_left' },
                  },
                });
                return (
                <div key={viewName} className="grid gap-3 px-3 py-3 text-xs">
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(15rem,0.9fr)] sm:items-center">
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-content-primary">{viewName}</span>
                    <span className="mt-0.5 block text-[11px] font-normal text-content-secondary">Relative to {draft.primaryViewName || 'the main data source'}</span>
                  </span>
                  <select
                    value={decision}
                    disabled={busy}
                    onChange={(event) => {
                      const nextDecision = event.target.value as SemanticBlueprintRelationshipDecision;
                      const nextContract = nextDecision === 'create_reusable'
                        ? contract
                        : nextDecision === 'use_existing'
                          ? authoredContracts.find((candidate) => relationshipContractKey(candidate) === relationshipContractKey(contract))
                            || authoredContracts[0]
                          : undefined;
                      onChange({
                        relationshipDecisions: {
                          ...draft.relationshipDecisions,
                          [viewName]: nextDecision,
                        },
                        relationshipContracts: nextContract
                          ? { ...draft.relationshipContracts, [viewName]: nextContract }
                          : Object.fromEntries(Object.entries(draft.relationshipContracts).filter(([key]) => key !== viewName)),
                      });
                    }}
                    className="input-field w-full text-xs font-normal"
                    aria-label={`Relationship decision for ${viewName}`}
                  >
                    {RELATIONSHIP_DECISION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  </div>
                  {decision === 'use_existing' && (
                    authoredContracts.length > 0 ? (
                      <label className="block border-t border-border pt-3 font-semibold text-content-primary">
                        Existing model relationship
                        <select
                          value={relationshipContractKey(contract)}
                          disabled={busy}
                          onChange={(event) => {
                            const selected = authoredContracts.find((candidate) => (
                              relationshipContractKey(candidate) === event.target.value
                            ));
                            if (selected) updateContract(selected);
                          }}
                          className="input-field mt-1 w-full text-xs font-normal"
                          aria-label={`Existing relationship for ${viewName}`}
                        >
                          {authoredContracts.map((candidate) => (
                            <option key={relationshipContractKey(candidate)} value={relationshipContractKey(candidate)}>
                              {candidate.joinFromView} to {candidate.joinToView} · {candidate.relationshipType}
                            </option>
                          ))}
                        </select>
                        <span className="mt-1 block font-mono text-[11px] font-normal text-content-secondary">
                          {contract.onSql}
                        </span>
                      </label>
                    ) : (
                      <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                        No authored relationship connects these exact views. Let Blobby propose one, enter the exact relationship manually, or remove the related data source.
                      </div>
                    )
                  )}
                  {decision === 'propose_reusable' && (
                    <div className="border-t border-blue-200 bg-blue-50 px-3 py-2 text-[11px] leading-relaxed text-blue-900">
                      Blobby will propose one complete relationship between <span className="font-mono">{draft.primaryViewName}</span> and <span className="font-mono">{viewName}</span> using only their reviewed fields. Unsupported keys or cardinality will stop for review instead of being guessed.
                    </div>
                  )}
                  {decision === 'create_reusable' && (
                    <div className="grid gap-3 border-t border-border pt-3 lg:grid-cols-2">
                      <label className="block font-semibold text-content-primary">
                        Join direction
                        <select
                          value={`${contract.joinFromView}|${contract.joinToView}`}
                          disabled={busy || !draft.primaryViewName}
                          onChange={(event) => {
                            const [joinFromView, joinToView] = event.target.value.split('|');
                            updateContract({ joinFromView, joinToView });
                          }}
                          className="input-field mt-1 w-full text-xs font-normal"
                        >
                          <option value={`${draft.primaryViewName}|${viewName}`}>{draft.primaryViewName || 'Main data source'} to {viewName}</option>
                          <option value={`${viewName}|${draft.primaryViewName}`}>{viewName} to {draft.primaryViewName || 'main data source'}</option>
                        </select>
                      </label>
                      <label className="block font-semibold text-content-primary">
                        Cardinality
                        <select
                          value={contract.relationshipType}
                          disabled={busy}
                          onChange={(event) => updateContract({ relationshipType: event.target.value as SemanticBlueprintRelationshipType })}
                          className="input-field mt-1 w-full text-xs font-normal"
                        >
                          {RELATIONSHIP_TYPE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="block font-semibold text-content-primary lg:col-span-2">
                        Exact join SQL <span className="text-red-600">Required</span>
                        <input
                          value={contract.onSql}
                          disabled={busy}
                          onChange={(event) => updateContract({ onSql: event.target.value })}
                          className="input-field mt-1 w-full font-mono text-xs font-normal"
                          placeholder={`\${${contract.joinFromView || draft.primaryViewName}.key} = \${${contract.joinToView || viewName}.key}`}
                        />
                        <span className="mt-1 block text-[11px] font-normal text-content-secondary">
                          Use exact Omni field selectors. Join behavior is fixed to <span className="font-mono">always_left</span>.
                        </span>
                      </label>
                      <label className="flex items-start gap-2 font-medium text-content-primary lg:col-span-2">
                        <input
                          type="checkbox"
                          checked={contract.reversible}
                          disabled={busy}
                          onChange={(event) => updateContract({ reversible: event.target.checked })}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-omni-600"
                        />
                        <span>
                          Allow Omni to traverse this relationship in both directions.
                          <span className="mt-0.5 block text-[11px] font-normal text-content-secondary">Leave off unless bidirectional exploration is intentionally reviewed.</span>
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              );})}
            </div>
          </div>
        )}

        <div className="mt-3 flex items-start gap-2 border-y border-border bg-white px-3 py-2 text-xs" role="status">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-green-700" aria-hidden="true" />
          <div>
            <div className="font-semibold text-content-primary">
              {approvedViews.length} {approvedViews.length === 1 ? 'view' : 'views'} included
            </div>
            <p className="mt-0.5 leading-relaxed text-content-secondary">
              {automaticallyExcludedViewCount} other {automaticallyExcludedViewCount === 1 ? 'view is' : 'views are'} excluded automatically. Change the primary or additional views above to adjust this boundary.
            </p>
          </div>
        </div>
      </div>

      {accessIntentSetup && (
        <div className="border-t border-border pt-4">
          {accessIntentSetup}
        </div>
      )}

      {permissionIntent === 'required' && accessSetup && (
        <div className="border-t border-border pt-4">
          <div className="mb-3">
            <h4 className="text-xs font-semibold text-content-primary">Configure the approved access boundary</h4>
            <p className="mt-1 text-xs leading-relaxed text-content-secondary">
              Choose grants and row filters only after the reachable views are set. These exact choices become part of the final build-instructions approval.
            </p>
          </div>
          <fieldset disabled={busy} aria-disabled={busy}>
            {accessSetup}
          </fieldset>
        </div>
      )}

      <details className="border-y border-border bg-white">
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-content-primary">Additional governance guidance (optional)</summary>
        <div className="grid gap-3 border-t border-border p-3 lg:grid-cols-2">
          <label className="block text-xs font-semibold text-content-primary">
            Relationship guidance
            <textarea
              value={draft.relationshipGuidance}
              onChange={(event) => onChange({ relationshipGuidance: event.target.value })}
              disabled={busy}
              rows={2}
              className="input-field mt-1 w-full resize-y text-sm font-normal"
              placeholder="Only join locations by store_id; do not combine separate fact grains."
            />
          </label>
          <label className="block text-xs font-semibold text-content-primary lg:col-span-2">
            Security guidance
            <textarea
              value={draft.securityGuidance}
              onChange={(event) => onChange({ securityGuidance: event.target.value })}
              disabled={busy}
              rows={2}
              className="input-field mt-1 w-full resize-y text-sm font-normal"
              placeholder="Preserve current access controls. Do not infer new grants or row filters."
            />
          </label>
        </div>
      </details>

      <div className={`border px-3 py-3 ${preApprovalIssues.length === 0 ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className="flex items-start gap-2">
          <ShieldCheck size={16} className={`mt-0.5 shrink-0 ${preApprovalIssues.length === 0 ? 'text-green-700' : 'text-amber-700'}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-content-primary">Approve the build instructions</div>
            <dl className="mt-2 grid gap-2 text-xs leading-relaxed text-content-secondary sm:grid-cols-2">
              <div className="border-l-2 border-omni-300 pl-2">
                <dt className="font-semibold text-content-primary">Views</dt>
                <dd>{approvedViews.length > 0
                  ? `Primary: ${draft.primaryViewName}. Additional included views: ${draft.supportingViewNames.join(', ') || 'none'}. All other existing views remain blocked.`
                  : 'Complete the required data choices.'}</dd>
              </div>
              <div className="border-l-2 border-blue-300 pl-2">
                <dt className="font-semibold text-content-primary">How the data connects</dt>
                <dd>{relationshipIntentSummary}</dd>
              </div>
              <div className="border-l-2 border-amber-300 pl-2">
                <dt className="font-semibold text-content-primary">Access</dt>
                <dd>{permissionIntentSummary}</dd>
              </div>
              <div className="border-l-2 border-gray-300 pl-2">
                <dt className="font-semibold text-content-primary">File actions</dt>
                <dd>Only the actions currently shown in the dependency plan are approved.</dd>
              </div>
            </dl>
            {preApprovalIssues.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-amber-900">
                {preApprovalIssues.slice(0, 6).map((issue) => <li key={issue}>- {issue}</li>)}
              </ul>
            )}
            <label className={`mt-3 flex items-start gap-2 text-xs font-semibold ${preApprovalIssues.length === 0 ? 'cursor-pointer text-green-900' : 'cursor-not-allowed text-content-tertiary'}`}>
              <input
                type="checkbox"
                checked={draft.reviewedAndApproved}
                disabled={busy || preApprovalIssues.length > 0}
                onChange={(event) => onChange({ reviewedAndApproved: event.target.checked })}
                className="mt-0.5 h-4 w-4 shrink-0 accent-omni-600"
              />
              <span>I approve these build instructions as the governed semantic blueprint, including this exact view allowlist, relationship decisions, access decision, and dependency file actions. Any change requires me to review and approve again.</span>
            </label>
          </div>
        </div>
      </div>
    </section>
  );
}

export default SemanticBlueprintPanel;
