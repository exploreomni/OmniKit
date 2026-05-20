import { useState, useEffect, type ReactNode } from 'react';
import {
  Bot,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  ExternalLink,
  Loader2,
  BookOpen,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  listModels,
  listTopics,
  getTopic,
  createTopic,
  updateTopic,
  deleteTopic,
  createAiJob,
  getAiJob,
  getAiJobResult,
  createModelBranch,
  getModelYaml,
  updateModelYamlFile,
  validateModel,
  validateModelContent,
  ApiError,
  type OmniAiJob,
  type OmniAiJobResult,
  type OmniModelYamlResponse,
} from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SearchInput } from '@/components/ui/SearchInput';
import { Blobby } from '@/components/ui/Blobby';
import { AIWorkingAnimation, type AIWorkStepStatus } from '@/components/ui/AIWorkingAnimation';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { SemanticMigrationImportPanel } from '@/components/semanticStudio/SemanticMigrationImportPanel';
import {
  selectedBadgeClass,
  selectedCardClass,
  selectedRowClass,
  unselectedBadgeClass,
  unselectedCardClass,
  unselectedRowClass,
} from '@/components/ui/selectionStyles';
import type { OmniModel } from '@/types';

function TopicFormModal({
  open,
  modelId,
  editMode,
  initialName,
  initialData,
  onClose,
  onSave,
}: {
  open: boolean;
  modelId: string;
  editMode: boolean;
  initialName?: string;
  initialData?: string;
  onClose: () => void;
  onSave: () => void;
}) {
  const { connection } = useConnection();
  const [baseViewName, setBaseViewName] = useState('');
  const [, setTopicName] = useState('');
  const [jsonBody, setJsonBody] = useState('{}');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (editMode && initialName) {
      setTopicName(initialName);
      setJsonBody(initialData || '{}');
    } else {
      setTopicName('');
      setBaseViewName('');
      setJsonBody('{}');
    }
    setError('');
  }, [editMode, initialName, initialData, open]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = JSON.parse(jsonBody);
      if (editMode && initialName) {
        await updateTopic(connection.baseUrl, connection.apiKey, modelId, initialName, body);
      } else {
        if (!baseViewName) throw new Error('Base view name is required');
        await createTopic(connection.baseUrl, connection.apiKey, modelId, baseViewName, body);
      }
      onSave();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save topic');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-card shadow-dropdown p-6 max-w-lg w-full mx-4">
        <button onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-content-primary mb-4">
          {editMode ? 'Update Topic' : 'Create Topic'}
        </h3>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-4">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          {!editMode && (
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Base View Name</label>
              <input
                type="text"
                value={baseViewName}
                onChange={(e) => setBaseViewName(e.target.value)}
                className="input-field font-mono text-xs"
                placeholder="e.g. orders"
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-content-secondary mb-1">
              Topic Body (JSON)
            </label>
            <textarea
              value={jsonBody}
              onChange={(e) => setJsonBody(e.target.value)}
              className="input-field font-mono text-xs h-48 resize-none"
              placeholder='{ "label": "My Topic", "description": "..." }'
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary text-sm">
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {editMode ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TopicDetailModal({
  open,
  data,
  onClose,
}: {
  open: boolean;
  data: Record<string, unknown> | null;
  onClose: () => void;
}) {
  if (!open || !data) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-card shadow-dropdown p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-content-primary mb-4">Topic Detail</h3>
        <pre className="bg-gray-900 text-green-400 text-xs p-4 rounded overflow-auto max-h-[60vh] font-mono leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );
}

interface TopicEntry {
  name: string;
  label?: string;
  description?: string;
}

type AiResultMode = 'topic-plan' | 'context-review' | 'readiness-probe' | 'final-yaml' | null;

type StudioStep = 'scope' | 'baseline' | 'confirm' | 'package' | 'deploy';

type StudioPath = 'topic' | 'model' | 'permissions';
type StudioPathSelection = StudioPath | '';

type WorkstreamId = 'full' | 'context' | 'metrics' | 'joins' | 'fields' | 'permissions';

type DeepReviewChunkId = 'probe' | 'field-audit' | 'context-audit' | 'topic-plan' | 'final-yaml';

type DeepReviewChunkStatus = 'pending' | 'running' | 'complete' | 'failed';

type DeployStatus = 'idle' | 'preparing' | 'creating-branch' | 'saving' | 'validating' | 'ready' | 'failed';

type SupportedYamlFileName = 'model' | 'relationships' | `${string}.topic` | `${string}.view`;

type DeployFileDraft = {
  id: string;
  fileName: string;
  yaml: string;
  source: 'topic-builder' | 'view-model-builder' | 'permission-builder' | 'manual';
};

type PermissionAccessGrantContract = {
  name: string;
  userAttribute: string;
  allowedValues: string[];
};

type PermissionTopicAccessFilterContract = {
  field: string;
  userAttribute: string;
  valuesForUnfiltered: string[];
};

type PermissionPackageContract = {
  accessGrants: PermissionAccessGrantContract[];
  topicRequiredAccessGrants: string[];
  topicAccessFilters: PermissionTopicAccessFilterContract[];
  assumptions: string[];
  blockers: string[];
};

type DeployDiff = {
  fileName: string;
  added: number;
  removed: number;
  beforeLength: number;
  afterLength: number;
  before: string;
  after: string;
  rows: DeployDiffRow[];
};

type DeployDiffRow = {
  type: 'same' | 'added' | 'removed';
  beforeLine?: number;
  afterLine?: number;
  text: string;
};

type ContentValidationSummary = {
  contentDocuments: number;
  documentsWithIssues: number;
  newIssueCount: number;
  newDocumentsWithIssues: number;
  existingIssueCount: number;
  dashboardFilterIssueCount: number;
  queryIssueCount: number;
  sampleIssues: string[];
  sampleNewIssues: string[];
  sampleExistingIssues: string[];
  errorMessage?: string;
};

interface JoinTree {
  [viewName: string]: JoinTree;
}

type YamlDraft = {
  id: string;
  label: string;
  description: string;
  content: string;
  targetFileName?: string;
};

type ReadinessSummary = {
  topic: string;
  verdict: string;
  confidence: string;
  questions: string[];
  useCases: string[];
  businessRules: string[];
  gaps: string[];
  outOfScope: string[];
};

type ReviewSection = {
  id: string;
  title: string;
  description: string;
  content: string;
  defaultOpen?: boolean;
};

type ReadinessInputs = {
  questions: string[];
  questionInputs: string[];
  useCases: string[];
  useCaseInputs: string[];
  businessRules: string[];
  gaps: string[];
  outOfScope: string[];
  notes: string;
};

type ManualCopy = {
  label: string;
  value: string;
};

type DeepReviewChunkState = {
  id: DeepReviewChunkId;
  label: string;
  description: string;
  status: DeepReviewChunkStatus;
  jobId?: string;
  message?: string;
  error?: string;
  parsed?: unknown;
  startedAt?: number;
  finishedAt?: number;
};

const EMPTY_READINESS_INPUTS: ReadinessInputs = {
  questions: ['', '', ''],
  questionInputs: ['', '', ''],
  useCases: ['', '', ''],
  useCaseInputs: ['', '', ''],
  businessRules: [''],
  gaps: [''],
  outOfScope: [''],
  notes: '',
};

const READINESS_JSON_KEYS = {
  questions: ['questions', 'businessQuestions', 'business_questions', 'semanticQuestions', 'semantic_questions'],
  useCases: ['useCases', 'use_cases', 'usecases', 'businessUseCases', 'business_use_cases'],
  businessRules: ['businessRules', 'business_rules', 'queryAssumptions', 'query_assumptions', 'filters'],
  clarifyingQuestions: ['clarifyingQuestions', 'clarifying_questions', 'validationQuestions', 'validation_questions'],
  gaps: ['gaps', 'modelingGaps', 'modeling_gaps', 'fieldIssues', 'field_issues', 'modelSettingIssues', 'model_setting_issues'],
  outOfScope: ['outOfScope', 'out_of_scope', 'negativeRouting', 'negative_routing', 'negativeModelGuidance', 'negative_model_guidance'],
};

const REVIEW_GAP_JSON_KEYS = ['gaps', 'modelingGaps', 'modeling_gaps'];

const REVIEW_JSON_KEY_GROUPS = {
  fieldIssues: ['fieldIssues', 'field_issues', 'modelSettingIssues', 'model_setting_issues', 'permissionIssues', 'permission_issues'],
  measures: ['metrics', 'measureRecommendations', 'measure_recommendations', 'modelMetrics', 'model_metrics', 'permissionRecommendations', 'permission_recommendations'],
  routing: ['routingRules', 'routing_rules', 'modelRoutingGuidance', 'model_routing_guidance', 'permissionRoutingRules', 'permission_routing_rules'],
  negativeRouting: ['negativeRouting', 'negative_routing', 'negativeModelGuidance', 'negative_model_guidance'],
  synonyms: ['synonyms', 'attributeCandidates', 'attribute_candidates'],
  aiContext: ['aiContextOpportunities', 'ai_context_opportunities', 'modelAiContextOpportunities', 'model_ai_context_opportunities'],
  targetPlan: [
    'targetFileNotes',
    'target_file_notes',
    'targetFilePlan',
    'target_file_plan',
    'recommendations',
    'modelRecommendations',
    'model_recommendations',
    'modelSettings',
    'model_settings',
  ],
  separateWorkflow: ['separateWorkflowNotes', 'separate_workflow_notes', 'separateWorkflowPlan', 'separate_workflow_plan'],
  validations: ['clarifyingQuestions', 'clarifying_questions', 'validationQuestions', 'validation_questions'],
};

const SEMANTIC_FILE_TAXONOMY = `Omni semantic file taxonomy:
- model: Settings/model file. Use for model-wide settings such as cache_policies, ignored_schemas, ignored_views, access_grants, and other global model configuration. Do not put topic joins, topic ai_context, dimensions, or measures here.
- relationships: Settings/relationships file. This file is a top-level YAML list of relationship objects with join_from_view, join_to_view, join_type, on_sql, relationship_type, and optional reversible. Do not wrap this file in a relationships: key.
- <view>.view: Schema or virtual-schema view file. Use for dimensions, measures, field descriptions, formats, hidden flags, primary keys, links, synonyms, and view-level metadata.
- <topic>.topic: Topic file under Topics. Use for base_view, label, group_label, display_order, description, default_filters, topic-scoped joins, topic-scoped view overrides, fields, ai_fields, sample_queries, and final ai_context.
- Keep these files separate. If a request needs multiple file areas, return separate deployable artifacts with explicit Target file lines.`;

const OMNI_TOPIC_YAML_GUIDANCE = `When returning Omni topic YAML, follow Omni's current topic file format:
- Return a single topic file body, not a top-level topics: array.
- Do not include name: in the YAML body; the topic name comes from the topic file/name chosen by the admin.
- For existing topic updates, preserve the current topic YAML as the source of truth and make only the confirmed topic-file edits. Do not drop existing default_filters, joins, views, fields, ai_fields, sample_queries, or ai_context unless the admin explicitly confirmed removal.
- Put top-level keys in this practical order whenever possible: base_view, label, group_label, display_order, description, default_filters, joins, views, fields, ai_fields, sample_queries, ai_context.
- Use base_view: <view_name> for the required base view.
- Use label: for the user-facing topic label.
- Use group_label and display_order when the admin wants the topic organized in a specific Topic group.
- Use description: for the human-facing topic purpose.
- Treat ai_context as advisory prose only. It does not enforce filters or define executable model logic.
- Put ai_context at the bottom of the topic file. If ai_context is a multiline scalar, no other YAML keys should appear underneath it.
- Prefer ai_context: >- for long prose or ai_context: | for intentionally line-preserved guidance. In both cases, keep it as the final top-level key.
- Do not use field interpolation syntax or filter-condition syntax inside ai_context. Mention fields and business rules in plain English.
- Use joins: as a nested mapping with {} leaves that follows the actual join path; do not use a flat views: list to define topic membership.
- Topic joins are the topic-scoped join graph. Model-level reusable relationship definitions belong in the Settings relationships file, not as a top-level relationships: key in topic YAML.
- Preserve existing source-of-truth joins exactly. If the current topic has no joins, or if a new-topic candidate needs a join, do not put an unvalidated candidate join in deployable topic YAML. Put the candidate join path in assumptions/validations unless the relationship edge is already known-good or the admin explicitly confirmed the exact join path.
- Do not remove or re-parent existing joined views unless the admin explicitly asks for a join redesign. If the path is uncertain, keep the proposed join out of ai_fields and sample_queries until validation succeeds.
- For new-topic candidates, do not create a views: block unless the exact topic-scoped syntax is already present in source YAML or explicitly confirmed. Field labels, descriptions, context, values, synonyms, SQL, dimensions:, and measures: belong in Model / View Builder, not the generated topic package.
- Preserve an existing views: block only when updating an existing topic and the source YAML already contains it. Do not invent views.<view>.dimensions or views.<view>.measures in a new topic file.
- Use fields: [...] only when recommending explicit field curation.
- Use ai_fields: [...] when recommending a narrower AI-facing field set than the full topic field set. ai_fields changes what Omni Agent is aware of, not what the user can access.
- For row-level permissions in topic files, Omni documents access_filters as the topic-level row access parameter. Only add access_filters when the field, user_attribute reference, bypass values, and syntax are confirmed.
- For topic-level access grants, use required_access_grants only when the referenced grant already exists in the model file access_grants or is being delivered through a separate confirmed Settings/model workflow.
- Only include existing, current-safe fields in fields or ai_fields. Proposed future measures belong in a separate Model / View Builder artifact until they exist.
- Do not include direct PII, contact, person-identifying, or granular location fields in ai_fields by default, such as email, full name, first/last name, phone, address, zip/postal code, precise latitude/longitude, birth date, raw IDs, or equivalent fields. Keep them available to users when appropriate, but omit them from AI routing unless the admin explicitly confirmed PII lookup, precise location analysis, or display as a supported use case.
- For new-topic candidates, omit fields from joined views in ai_fields and sample_queries unless the join path is already known-good in the source topic or the admin explicitly confirmed the join. Candidate joins and joined-view fields should wait until the join validates.
- For PII use cases, prefer masked or governed fields over raw identifiers. If the topic needs identity display, require a validation note that the audience, access path, and governed field are intentional.
- Do not put global view-level measure definitions, global hidden-field changes, validation questions, or implementation comments inside the copyable topic YAML block.
- Assumptions and validations must match the YAML exactly. Do not claim a field was omitted, excluded, retained, or filtered if the copyable YAML does the opposite.
- If recommending sample_queries, provide valid sample_queries objects with query, description, prompt, and optional vis_config. Put sample_queries before ai_context. Otherwise keep example questions as prose outside the YAML.
- In sample_queries.query.fields, quote every field selector, especially timeframe selectors such as "example_view.created_at[month]".
- In sample_queries.query.sorts, use documented keys field and desc. Do not use column_name or sort_descending.
- When recommending metric or measure changes, separate topic-level YAML from Model / View Builder output if the change belongs in a model, relationships, or view file.
- Only include default_filters, always_where_filters, access_filters, or other filter parameters when you are confident they match current Omni topic syntax; otherwise put the recommendation in validation questions.
- For existing topics, preserve filter blocks from the current source YAML verbatim unless the admin explicitly confirms a filter syntax change. Do not convert prose-only scoping rules, such as region or age defaults, into default_filters by inventing operators such as equal, greater_than, less_than, or greater_than_or_equal_to.
- In sample_queries, omit query.filters unless you are copying a known-good existing query filter shape. Topic default filters already apply, and invalid sample query filter syntax can break validation.
- A valid topic skeleton looks like:
  base_view: example_orders
  label: Example Orders
  group_label: Example Group
  display_order: 0
  description: Example transaction analysis.
  default_filters:
    example_orders.created_at:
      time_for_duration: [30 complete days ago, 30 days]
  joins:
    example_lookup:
      example_nested_lookup: {}
    example_customer: {}
  views:
    example_lookup:
      dimensions:
        example_label:
          label: Example Label
  sample_queries:
    Example Metric by Month:
      query:
        fields: ["example_orders.created_at[month]", "example_orders.example_metric"]
        base_view: example_orders
        sorts:
          - field: "example_orders.created_at[month]"
            desc: false
        topic: example_orders
      description: Monthly example metric trend
      prompt: Show example metric by month
  ai_context: >-
    Plain-English guidance goes last.
- If exact YAML syntax is uncertain, do not invent it. Explain the recommendation in prose for the admin to review in Omni.`;

const OMNI_RELATIONSHIPS_YAML_GUIDANCE = `When returning the Settings/relationships file:
- Return the complete relationships file body as a top-level YAML list.
- Do not wrap the list in a relationships: key.
- Each relationship should use join_from_view, join_to_view, join_type, on_sql, relationship_type, and optional reversible.
- Do not include topic joins, dimensions, measures, ai_fields, sample_queries, or model settings.`;

const OMNI_VIEW_FILE_YAML_GUIDANCE = `When returning a .view file:
- Return the complete replacement file body for the selected .view target, not a patch fragment.
- Preserve existing source-defining sections: query, sql, schema, table_name, schema_label, and extends as applicable.
- Preserve existing dimensions and measures unless the admin explicitly confirmed deletion by field name. For noisy or deprecated fields, prefer hidden: true plus clearer descriptions over removing field keys.
- For .query.view files, the top-level query: or sql: section is required.
- Use nested mappings under dimensions: and measures:. Do not use list-style "- name:" objects.
- View-level ai_context and field-level ai_context are supported; keep them plain English.
- Keep ai_context concise: routing purpose, grain, caveats, and negative routing only. Do not include raw SQL examples or topic-style sample queries in .view files.
- Synonyms are field-level metadata on dimensions or measures. Do not include a top-level synonyms: key in .view files.
- Synonyms should be YAML lists. Quote synonym items that contain special YAML characters such as #, :, [, ], {, }, or commas.
- Do not use values: under dimensions or measures. If known enum values are useful for admins, mention them in description or assumptions/validations instead of adding unsupported field metadata.
- When a field SQL references another field in the same view, use unqualified field references like \${primary_key}, \${numeric_value}, or \${metric_value}; do not use \${view_name.field_name} inside that same view file.
- Use lowercase aggregate_type values such as sum, count, count_distinct, average, min, max, median, percentile.
- Preserve aggregate semantics in labels and descriptions. aggregate_type: count is a row count at the view grain; do not describe it as distinct unless the measure uses count_distinct or an explicit distinct key.
- For standard additive measures, include both sql and aggregate_type, for example sql: \${field_name} plus aggregate_type: sum.
- Omni view field names must be unique across dimensions and measures. When adding an aggregating measure for an existing query-view dimension, keep the source dimension under dimensions (hidden when appropriate) and create a distinct measure key such as <field_name>_sum, <field_name>_total, or <field_name>_metric with sql: \${field_name} and aggregate_type.
- Do not create a measure with the same key as the source dimension and sql: \${same_key}; that creates a circular reference. Preserve the user-facing label on the measure instead.
- Ratio or compound measures should reference the new measure keys, such as \${current_metric_sum} / NULLIF(\${baseline_metric_sum}, 0), not the raw hidden dimensions.
- For count_distinct measures, include sql for the distinct key, for example sql: \${entity_id}.
- For ratio or compound measures, use sql expressions that reference other measures, for example sql: \${current_metric_sum} / NULLIF(\${baseline_metric_sum}, 0), and omit aggregate_type unless the SQL itself is a raw aggregate.
- For ratio measures, reference same-view measures as \${measure_name}; do not prefix with the view name.
- For view or field permissions, Omni documents required_access_grants at the view, dimension, and measure level. Only add required_access_grants when the referenced grant already exists in Settings/model access_grants or is being delivered through a separate confirmed Settings/model workflow.
- For direct PII/contact/person-identifying dimensions, do not add synonyms or ai_context that increase AI routing unless the admin explicitly confirmed PII lookup/display. Prefer documented masking/gating controls: mask_unless_access_grants for MD5 masking, required_access_grants to block field access entirely, or Omni user attributes via Mustache syntax ({{ omni_attributes.<attribute_reference> }}) for custom conditional hide/hash logic.
- If adding or recommending masking, keep raw PII governed. A common custom pattern is a masked field using CASE WHEN {{omni_attributes.can_see_pii}} = 'false' THEN 'no access' ELSE <field> END, but only deploy exact syntax when it is confirmed for this model.
- Do not include topic-only keys such as base_view, joins, ai_fields, or sample_queries.`;

const OMNI_MODEL_FILE_YAML_GUIDANCE = `When returning the Settings/model file:
- Return only global model configuration such as cache_policies, ignored_schemas, ignored_views, access_grants, access filters, user attributes, or global settings.
- Do not include topics, relationships, dimensions, measures, view metadata, ai_fields, sample_queries, or topic ai_context.
- For PII/RLS governance, prefer enforceable model-level configuration when supported and confirmed: access_grants, default_topic_required_access_grants, default_topic_access_filters, user attributes / omni_attributes, or ignored views. Do not rely on ai_context alone for true security.
- Omni documents row-level permissions at the model level with default_topic_access_filters, which match a field value to a user_attribute. Only add these when every target topic can resolve the field or the affected topics explicitly override with access_filters: [].
- Omni documents access_grants in the model file; topics, views, dimensions, and measures can then reference those grants through required_access_grants. Do not create required_access_grants that reference undefined grants.
- If exact permission syntax is uncertain, do not invent deployable model YAML. Ask for admin validation and include a short non-deployable commented example in assumptions/validations instead.
- Preserve existing model settings unless the confirmed change requires editing them.`;

const OMNI_AI_COMPACT_OUTPUT_RULES = `Response budget rules:
- Put the requested copyable artifact first: JSON for review steps, YAML for package steps.
- Do not use markdown tables. Use short bullets instead.
- Do not restate the full prompt, prior findings, or prior chat history.
- Keep prose concise and admin-friendly.
- Prefer 3-5 high-signal items per section.
- If more detail is needed, say what should be reviewed next instead of expanding in this response.`;

const TOPIC_AI_READINESS_ROLE = 'Act as a senior AI analytics engineer specializing in semantic layers, topic design, joins, metrics, filters, governed self-service, and AI context quality.';

const PERMISSION_BUILDER_GUARDRAILS = `Permission Builder guardrails:
- Permission Builder is a separate development path for access design and governance integrity. It may review topic, model, and view implications together.
- Permission Builder packages the Settings/model file plus the selected permission target when the selected target is a .topic or .view file, because access_grants must live in Settings/model before topics/views/fields can reference them.
- For Settings/model-only targets, package only Settings/model.
- Do not infer and apply permissions from data names alone. Treat names such as employee_email, user_id, region, country, department, tenant_id, account_id, or omni_email as candidate permission anchors until the admin confirms the exact user_attribute, field, bypass/admin behavior, null/default behavior, and target file.
- For Settings/model targets, focus on access_grants, user attributes, default_topic_required_access_grants, default_topic_access_filters, and other model-level permission configuration. Do not emit topic or view YAML.
- For .topic targets, define or preserve the required access_grant in Settings/model, then add topic-level required_access_grants and/or access_filters only when the referenced grant/user_attribute and field syntax are confirmed. Do not create access_grants in a topic file.
- For .view targets, define or preserve the required access_grant in Settings/model, then add view/field required_access_grants, mask_unless_access_grants, or confirmed custom masking using {{ omni_attributes.<attribute_reference> }}. Do not emit model-level grant definitions inside a view file.
- If a permission change requires a file outside the expected package targets, put it in separateWorkflow notes. Do not mix unrelated model, view, and topic permission YAML in one deployable artifact.
- Prefer enforceable controls over AI guidance, but keep speculative controls out of deployable YAML until the admin confirms them.`;

const PERMISSION_PACKAGE_EXACTNESS_GUARDRAILS = `Permission package exactness guardrails:
- Confirmed admin inputs are the only source for grant names, user_attribute references, allowed_values, access_filter fields, bypass values, and default/null behavior.
- Preserve exact confirmed user_attribute references and allowed_values. Do not convert a group-based grant such as omni_user_groups into boolean user attributes like transactions_access: true or can_see_pii: true.
- Do not add a user_attributes: block or default_value entries unless that exact YAML key already exists in the source Settings/model file or the admin explicitly confirmed that exact model YAML syntax. If a user attribute must be provisioned outside semantic YAML, list it in Assumptions / validations instead.
- If any permission prerequisite is missing or ambiguous, keep the affected enforceable control out of the deployable YAML and put the prerequisite in Assumptions / validations.`;

const FIELD_VISIBILITY_GUARDRAILS = `Field visibility guardrails:
- Out of scope means the AI should avoid routing to that field or use case; it does not automatically mean hidden: true.
- For Topic Builder work, out-of-scope fields should usually be excluded from ai_fields only, while remaining available to users unless there is a documented governance or confusion risk.
- Recommend hidden: true only when a field would actively mislead users in the selected context, such as mislabeled development artifacts, duplicate measures with identical SQL, surrogate-key aggregates, or fields that create clear governance risk.
- Fields from joined views are out of scope for hidden: true recommendations unless the admin provided a specific governance, privacy, or user-confusion reason.
- When recommending hidden: true, state the reason separately from out-of-scope routing.`;

// Docs-backed source notes for maintainers/admins:
// - Data access control: https://docs.omni.co/modeling/develop/data-access-control
// - User attributes and omni_attributes: https://docs.omni.co/docs/administration/user-attributes
// - Topic access_filters: https://docs.omni.co/modeling/topics/parameters/access-filters
// - Model default_topic_access_filters: https://docs.omni.co/modeling/models/default-topic-access-filters
// - Model access_grants: https://docs.omni.co/modeling/models/access-grants
// - Model default_topic_required_access_grants: https://docs.omni.co/modeling/models/default-topic-required-access-grants
// - View/field required_access_grants: https://docs.omni.co/modeling/views/parameters/required-access-grants
// - Dimension required_access_grants: https://docs.omni.co/modeling/dimensions/parameters/required-access-grants
// - Dimension mask_unless_access_grants: https://docs.omni.co/modeling/dimensions/parameters/mask-unless-access-grants
const PII_GOVERNANCE_GUARDRAILS = `PII, permissions, and RLS guardrails:
- Do not assume public internet or documentation browsing is available during this AI job. Use the embedded Omni docs-backed rules below instead of telling the model to open external links.
- Omni data access control uses user attributes plus model parameters. Users must have the required user attribute value to access governed topics, views/tables, fields, or rows.
- Access grants are defined in the Settings/model file under access_grants. Each grant references a user_attribute and allowed_values.
- Topics, views, dimensions, and measures can require existing grants with required_access_grants. Do not reference a grant unless it already exists in Settings/model or is being delivered in a separate confirmed Settings/model workflow.
- Row-level access in a topic uses access_filters, matching a topic field to a user_attribute. Model-wide default row-level access uses default_topic_access_filters, which apply to topics unless explicitly overridden.
- Model-wide default topic grant requirements use default_topic_required_access_grants. They should be used carefully because they affect new topics broadly.
- User attributes can be referenced in SQL with Mustache syntax as {{ omni_attributes.<attribute_reference> }} for custom conditional logic, masking, or hashing.
- Sensitive dimensions can use mask_unless_access_grants to MD5-mask values unless the user has the required grant. Use required_access_grants when the field should be blocked entirely instead of masked.
- Treat direct identifiers, contact fields, names, addresses, phone numbers, birth dates, raw user/customer IDs, IP addresses, granular zip/postal codes, precise latitude/longitude, and similar person-identifying or quasi-identifying fields as sensitive.
- Prefer enforceable governance over advisory text. Use Omni's documented controls: access_filters for topic-level row access, default_topic_access_filters for model-level row access, access_grants plus required_access_grants for topic/view/field access, mask_unless_access_grants for MD5 masking sensitive dimensions, and {{ omni_attributes.<attribute_reference> }} in field SQL for custom conditional masking or hashing.
- Topic Builder: do not include sensitive fields in ai_fields or sample queries unless the admin explicitly confirmed AI-assisted PII lookup/display or precise location analysis. Keep such fields available to users when appropriate, but do not make them AI routing defaults. If row-level permissions are requested in Topic Builder, use access_filters only with confirmed field and user_attribute syntax; otherwise put it in validation notes.
- Model / View Builder: if the selected target is Settings/model, review PII/RLS as model-level access_grants, default_topic_required_access_grants, or default_topic_access_filters work. If the target is a .view file, prefer required_access_grants on views/fields, mask_unless_access_grants on sensitive dimensions, or custom masked dimensions using omni_attributes when the grant/attribute already exists or is explicitly confirmed.
- If exact Omni permission syntax is uncertain or belongs in another file, do not invent deployable YAML. Put the required permission workflow in validation notes, and when useful include a clearly non-deployable commented example using {{ omni_attributes.<attribute_reference> }}, such as masking a field when can_see_pii is false.
- Per Omni docs, be careful with default user attribute values for access filters or access grants; defaults can unintentionally grant access. Ask for validation before recommending defaults for permission-driving attributes.
- Assumptions and validations must not contradict the YAML. If a sensitive field is included, say why and what permission/validation is required; if it is omitted from AI routing, make sure it is actually absent from ai_fields.`;

const AI_REVIEW_STAGE_CONTRACT = `Stage contract: REVIEW ONLY.
- Return exactly one fenced json block.
- Do not generate YAML, Target file blocks, code fences labeled yaml, or deployable file bodies.
- Build on the prior brief instead of repeating it.
- Keep findings tied to the selected lane and target file. Put other-file work in separateWorkflow notes.`;

const AI_PACKAGE_STAGE_CONTRACT = `Stage contract: PACKAGE.
- Generate only after the human confirmed inputs and clicked Generate File.
- For Topic Builder and Model / View Builder, return exactly one deployable YAML body for the selected target.
- For Permission Builder, return one deployable YAML body per expected permission target: Settings/model plus the selected .topic or .view target, or Settings/model only when model is selected.
- Put the deployable YAML in a fenced code block labeled yaml.
- For Model / View Builder and Permission Builder, each YAML body must be preceded by "Target file: <target>" and the next non-empty line must be \`\`\`yaml.
- Do not include unrelated files, patch fragments, or exploratory review findings in the YAML block.
- Put assumptions and validations after the YAML block only.`;

const STUDIO_STEPS: Array<{ id: StudioStep; label: string; description: string }> = [
  { id: 'scope', label: 'Scope', description: 'Workflow and model' },
  { id: 'baseline', label: 'Review', description: 'Run AI discovery review' },
  { id: 'confirm', label: 'Confirm', description: 'Business inputs' },
  { id: 'package', label: 'Package', description: 'Generated YAML' },
  { id: 'deploy', label: 'Deploy', description: 'Save, validate, diff, handoff' },
];

const STUDIO_PATHS: Array<{
  id: StudioPath;
  label: string;
  description: string;
  output: string;
  defaultWorkstreams: WorkstreamId[];
}> = [
  {
    id: 'topic',
    label: 'Topic Builder',
    description: 'Use when the deliverable is a .topic file: base view, topic joins, default filters, ai_fields, sample queries, routing, and topic ai_context.',
    output: 'One .topic file. Model, relationships, and .view gaps stay as review notes.',
    defaultWorkstreams: ['context', 'joins', 'fields'],
  },
  {
    id: 'model',
    label: 'Model / View Builder',
    description: 'Use when the deliverable is a Settings/model file, Settings/relationships file, or .view file for metrics, dimensions, field metadata, hidden fields, or global model config.',
    output: 'One target file: model, relationships, or <view>.view. No .topic file.',
    defaultWorkstreams: ['metrics', 'fields', 'context'],
  },
  {
    id: 'permissions',
    label: 'Permission Builder',
    description: 'Use when the deliverable is governed access: model grants/user attributes, topic access filters, topic grants, view grants, or masked fields.',
    output: 'One target file: model, <topic>.topic, or <view>.view. Cross-file permission gaps stay as review notes.',
    defaultWorkstreams: ['permissions', 'fields', 'context'],
  },
];

const WORKSTREAMS: Array<{ id: WorkstreamId; label: string; description: string; layer: string }> = [
  {
    id: 'full',
    label: 'Full workflow inspection',
    description: 'Review all checks that belong to the selected workflow.',
    layer: 'Recommended',
  },
  {
    id: 'context',
    label: 'AI guidance',
    description: 'Context, routing, sample queries, synonyms, and fields Omni Agent should prioritize.',
    layer: 'AI',
  },
  {
    id: 'metrics',
    label: 'Metrics and definitions',
    description: 'Measures, dimensions, filters, field metadata, and model-level YAML recommendations.',
    layer: 'Model',
  },
  {
    id: 'joins',
    label: 'Joins and relationships',
    description: 'Topic join paths, Settings/relationships edges, relationship risk, and fanout checks.',
    layer: 'Topic + Model',
  },
  {
    id: 'fields',
    label: 'Field cleanup',
    description: 'Hide noisy fields and promote the fields Omni Agent should use.',
    layer: 'Model',
  },
  {
    id: 'permissions',
    label: 'Permissions',
    description: 'Access grants, user attributes, access filters, masking, RLS, and permission target placement.',
    layer: 'Governance',
  },
];

const INSPECTION_WORKSTREAMS = WORKSTREAMS.filter((workstream) => workstream.id !== 'full');

function defaultWorkstreamsForPath(path: StudioPath) {
  return STUDIO_PATHS.find((item) => item.id === path)?.defaultWorkstreams || STUDIO_PATHS[0].defaultWorkstreams;
}

function workstreamsForPath(path: StudioPathSelection) {
  if (path === 'topic') return INSPECTION_WORKSTREAMS.filter((workstream) => workstream.id !== 'metrics');
  if (path === 'model') return INSPECTION_WORKSTREAMS;
  if (path === 'permissions') {
    return INSPECTION_WORKSTREAMS.filter((workstream) => ['permissions', 'fields', 'context', 'joins'].includes(workstream.id));
  }
  return [];
}

const DEEP_REVIEW_POLL_INTERVAL_MS = 5000;
const DEEP_REVIEW_COOLDOWN_MS = 3500;

function buildPromptTopicTitle(topicName?: string, topicLabel?: string) {
  const name = topicName?.trim();
  const label = topicLabel?.trim();
  if (label && name && label !== name) return `${label} (${name})`;
  return label || name || 'Let Omni Choose';
}

function getTopicDetailValue(detail: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!detail) return undefined;
  for (const key of keys) {
    const value = detail[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function buildJoinTreeFromJoinViaMap(joinViaMap: unknown, keyOrder: unknown): JoinTree {
  if (!joinViaMap || typeof joinViaMap !== 'object' || Array.isArray(joinViaMap)) return {};
  const map = joinViaMap as Record<string, unknown>;
  const orderedKeys = Array.isArray(keyOrder)
    ? keyOrder.filter((key): key is string => typeof key === 'string' && key in map)
    : [];
  const keys = [...orderedKeys, ...Object.keys(map).filter((key) => !orderedKeys.includes(key))];
  const root: JoinTree = {};

  keys.forEach((viewName) => {
    const path = Array.isArray(map[viewName])
      ? (map[viewName] as unknown[]).filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : [];
    let current = root;
    [...path, viewName].forEach((pathView) => {
      if (!current[pathView]) current[pathView] = {};
      current = current[pathView];
    });
  });

  return root;
}

function renderJoinTree(tree: JoinTree, indent = 0): string[] {
  return Object.entries(tree).flatMap(([viewName, children]) => {
    const prefix = ' '.repeat(indent);
    const childEntries = Object.keys(children);
    if (childEntries.length === 0) return [`${prefix}${viewName}: {}`];
    return [`${prefix}${viewName}:`, ...renderJoinTree(children, indent + 2)];
  });
}

function buildJoinYamlFromTopicDetail(detail: Record<string, unknown> | null | undefined) {
  const joinViaMap = getTopicDetailValue(detail, ['join_via_map', 'joinViaMap']);
  const keyOrder = getTopicDetailValue(detail, ['join_via_map_key_order', 'joinViaMapKeyOrder']);
  const tree = buildJoinTreeFromJoinViaMap(joinViaMap, keyOrder);
  const lines = renderJoinTree(tree, 2);
  return lines.length ? ['joins:', ...lines].join('\n') : '';
}

function formatRelationshipSummary(detail: Record<string, unknown> | null | undefined) {
  const relationships = getTopicDetailValue(detail, ['relationships']);
  if (!Array.isArray(relationships)) return '';
  const lines = relationships
    .map((relationship) => {
      if (!relationship || typeof relationship !== 'object') return '';
      const record = relationship as Record<string, unknown>;
      const left = typeof record.left_view_name === 'string' ? record.left_view_name : '';
      const right = typeof record.right_view_name === 'string' ? record.right_view_name : '';
      const type = typeof record.type === 'string' ? record.type : '';
      if (!left || !right) return '';
      return `- ${left} -> ${right}${type ? ` (${type})` : ''}`;
    })
    .filter(Boolean)
    .slice(0, 12);

  return lines.length ? lines.join('\n') : '';
}

function buildTopicSourceContext(
  topicName: string | undefined,
  detail: Record<string, unknown> | null | undefined,
  options: { currentTopicYaml?: string; includeCurrentYaml?: boolean; maxYamlChars?: number } = {}
) {
  if (!topicName) {
    return [
      'Topic Builder source context:',
      '- No existing topic is selected.',
      '- Treat this as new-topic candidate mode. Use model metadata, available topic names, and admin inputs to recommend the topic candidate; generate the complete .topic body only in Package.',
      '- Do not describe this as an update to an existing topic unless Omni explicitly chooses an existing topic and explains why.',
      '- If joins, base view, ai_fields, or sample_queries require validation, put those items in assumptions or validation notes instead of inventing model/view YAML in the topic output.',
    ].join('\n');
  }
  if (!detail) return `Topic "${topicName}" is selected, but no loaded topic detail is available yet. Treat joins and fields as unverified until the topic is inspected.`;

  const baseView = getTopicDetailValue(detail, ['base_view_name', 'baseViewName', 'base_view']);
  const joinYaml = buildJoinYamlFromTopicDetail(detail);
  const relationships = formatRelationshipSummary(detail);
  const currentTopicYaml = options.currentTopicYaml?.trim() || '';
  const includeCurrentYaml = options.includeCurrentYaml ?? false;

  return [
    'Current topic source-of-truth from Omni API:',
    `- Topic: ${topicName}`,
    `- Base view: ${typeof baseView === 'string' && baseView.trim() ? baseView : 'unknown'}`,
    currentTopicYaml
      ? includeCurrentYaml
        ? [
            '- Current topic YAML from Omni API. Treat this as the source of truth and preserve all unchanged sections in the final package:',
            '```yaml',
            compactYamlForPrompt(currentTopicYaml, options.maxYamlChars),
            '```',
          ].join('\n')
        : summarizeYamlFileForPrompt(`${topicName}.topic`, currentTopicYaml)
      : includeCurrentYaml
        ? '- Current topic YAML: not returned by Omni API. Do not generate a deployable full replacement until the current topic body is available.'
        : '- Current topic YAML body is reserved for the Package step so review does not accidentally generate a patch.',
    joinYaml
      ? [
          '- Current topic joins. Preserve these existing paths unless the admin explicitly asks to redesign joins. You may add candidate joins for new requirements, but do not remove or re-parent these paths:',
          '```yaml',
          joinYaml,
          '```',
        ].join('\n')
      : '- Current topic joins: none returned or not loaded. Candidate joins may be proposed when needed, but must be labeled as candidate changes and validated on a dev branch before final sign-off in Omni.',
    relationships
      ? ['- Relationship edges returned by Omni:', relationships].join('\n')
      : '- Relationship edges returned by Omni: none returned or not loaded.',
    'Guardrail: preserve known-good joins and clearly distinguish candidate join additions. Candidate joins may be correct, but they are not trusted until branch validation passes and the admin approves the diff.',
  ].join('\n');
}

function compactYamlForPrompt(yaml: string, maxChars = 18_000) {
  const cleaned = yaml.trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}\n# ... truncated by OmniKit. Target file is too large for a safe complete AI rewrite; ask the admin to narrow the scope or edit manually.`;
}

function summarizeYamlFileForPrompt(fileName: string, yaml: string) {
  const cleaned = yaml.trim();
  if (!cleaned) return '';
  const topLevelKeys = Array.from(cleaned.matchAll(/^([A-Za-z_][\w-]*):\s*/gm))
    .map((match) => match[1])
    .filter((key, index, values) => values.indexOf(key) === index)
    .slice(0, 16);
  const dimensionNames = Array.from(cleaned.matchAll(/^\s{2}([A-Za-z_][\w.-]*):\s*$/gm))
    .map((match) => match[1])
    .filter((name, index, values) => values.indexOf(name) === index)
    .slice(0, 20);
  return [
    `- Target file loaded: ${fileName}`,
    topLevelKeys.length ? `- Top-level sections: ${topLevelKeys.join(', ')}` : '- Top-level sections: none detected',
    dimensionNames.length ? `- Detected field keys: ${dimensionNames.join(', ')}` : '- Detected field keys: none detected from lightweight scan',
    '- Full source body is reserved for the Package step so review does not accidentally generate a patch.',
  ].join('\n');
}

function buildModelSourceContext(
  modelYaml: OmniModelYamlResponse | null | undefined,
  targetBaseViewName: string | undefined,
  studioPath: StudioPath,
  options: { includeTargetYaml?: boolean; maxYamlChars?: number } = {}
) {
  if (!pathUsesTargetSemanticFile(studioPath)) {
    return 'Model / View Builder context: not selected for this path. Keep model, relationships, and view-file changes out of the deployable output unless they are explicitly required.';
  }

  const fileNames = Object.keys(modelYaml?.files || {}).sort();
  const viewNames = Object.keys(modelYaml?.viewNames || {}).sort();
  const likelyViewFiles = fileNames.filter((fileName) => fileName.endsWith('.view')).slice(0, 25);
  const likelyTopicFiles = fileNames.filter((fileName) => fileName.endsWith('.topic')).slice(0, 25);
  const targetFile = targetBaseViewName?.trim() || '';
  const targetFileYaml = targetFile ? modelYaml?.files?.[targetFile] || '' : '';
  const settingsModelYaml = modelYaml?.files?.model || '';
  const includeTargetYaml = options.includeTargetYaml ?? true;
  const targetFileType = targetFile === 'model'
    ? 'Settings/model file'
    : targetFile === 'relationships'
      ? 'Settings/relationships file'
      : targetFile.endsWith('.topic')
        ? 'existing .topic file'
      : targetFile.endsWith('.view')
        ? 'schema or virtual-schema .view file'
        : 'not provided';
  const pathLabel = studioPath === 'permissions' ? 'Permission Builder' : 'Model / View Builder';
  const pathContract = studioPath === 'permissions'
    ? `- Permission Builder path: selected as the primary workflow; expected package targets: ${permissionPackageTargetFiles(targetFile).join(', ') || 'choose a permission target first'}.`
    : '- Model / View Builder path: selected as the primary workflow; no topic file should be created in this lane.';

  return [
    'Current model source context from Omni API:',
    pathContract,
    `- Target semantic file from admin: ${targetFile || 'not provided; infer cautiously from the model and ask for confirmation before staging ambiguous changes.'}`,
    `- Target file type: ${targetFileType}`,
    `- YAML files returned: ${fileNames.length ? fileNames.slice(0, 40).join(', ') : 'none returned or not loaded'}`,
    `- View files detected: ${likelyViewFiles.length ? likelyViewFiles.join(', ') : 'none detected from file names'}`,
    studioPath === 'permissions' ? `- Topic files detected: ${likelyTopicFiles.length ? likelyTopicFiles.join(', ') : 'none detected from file names'}` : '',
    `- Model view names returned: ${viewNames.length ? viewNames.slice(0, 40).join(', ') : 'none returned'}`,
    targetFileYaml
      ? includeTargetYaml
        ? [
            '- Current target file YAML from Omni API. Treat this as the source of truth and preserve all unchanged sections in the final package:',
            '```yaml',
            compactYamlForPrompt(targetFileYaml, options.maxYamlChars),
            '```',
          ].join('\n')
        : summarizeYamlFileForPrompt(targetFile, targetFileYaml)
      : '- Current target file YAML: not returned by Omni API. Do not generate a deployable full replacement until the current file body is available.',
    studioPath === 'permissions' && targetFile && targetFile !== 'model'
      ? settingsModelYaml
        ? includeTargetYaml
          ? [
              '- Current Settings/model YAML from Omni API. This is the source of truth for access_grants and model-level permission settings. Preserve unchanged sections in the final model package:',
              '```yaml',
              compactYamlForPrompt(settingsModelYaml, options.maxYamlChars),
              '```',
            ].join('\n')
          : summarizeYamlFileForPrompt('model', settingsModelYaml)
        : '- Current Settings/model YAML: not returned by Omni API. Do not generate model-level access_grants until the model file body is available.'
      : '',
    includeTargetYaml
      ? studioPath === 'permissions'
        ? `Package guardrail: create deployable YAML only for the expected Permission Builder package targets listed above. Return complete replacement file bodies, not patches.`
        : `Package guardrail: create deployable YAML only for the selected target semantic file in the ${pathLabel} lane and return the complete replacement file body, not a patch.`
      : 'Review guardrail: identify selected-target changes and separate follow-up workflows only. Do not draft deployable YAML in review.',
  ].filter(Boolean).join('\n');
}

function buildTopicBuilderModelDiscoveryContext(modelYaml: OmniModelYamlResponse | null | undefined) {
  const fileNames = Object.keys(modelYaml?.files || {}).sort();
  const viewNames = Object.keys(modelYaml?.viewNames || {}).sort();
  const likelyViewFiles = fileNames.filter((fileName) => fileName.endsWith('.view')).slice(0, 40);
  const settingsFiles = fileNames.filter((fileName) => fileName === 'model' || fileName === 'relationships');

  return [
    'Read-only model context for Topic Builder:',
    '- Use this model inventory only to recommend a topic candidate, base view, topic join path, ai_fields, sample queries, and ai_context.',
    '- Do not create or modify Settings/model, Settings/relationships, or .view files in this Topic Builder lane.',
    `- Settings files available: ${settingsFiles.length ? settingsFiles.join(', ') : 'none returned'}`,
    `- View files detected: ${likelyViewFiles.length ? likelyViewFiles.join(', ') : 'none returned from model YAML'}`,
    `- Model view names returned: ${viewNames.length ? viewNames.slice(0, 60).join(', ') : 'none returned'}`,
    '- If the user needs new metrics, field definitions, or reusable relationships, list those as validation notes and route them to Model / View Builder.',
  ].join('\n');
}

function topicNameFromTargetFile(fileName: string) {
  const clean = fileName.trim();
  return clean.endsWith('.topic') ? clean.replace(/\.topic$/i, '') : '';
}

function findTopicYamlFile(modelYaml: OmniModelYamlResponse | null | undefined, topicName: string | undefined) {
  const cleanTopicName = topicName?.trim();
  if (!cleanTopicName || !modelYaml?.files) return null;
  const underscoreName = cleanTopicName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const candidates = new Set([
    `${cleanTopicName}.topic`,
    `${cleanTopicName.toLowerCase()}.topic`,
    `${underscoreName}.topic`,
    `${slugify(cleanTopicName)}.topic`,
  ]);
  const exactFileName = Array.from(candidates).find((candidate) => typeof modelYaml.files?.[candidate] === 'string');
  if (exactFileName) return { fileName: exactFileName, yaml: modelYaml.files?.[exactFileName] || '' };
  const normalizedTopicName = underscoreName || slugify(cleanTopicName);
  const matchedFileName = Object.keys(modelYaml.files).find((fileName) => {
    if (!fileName.endsWith('.topic')) return false;
    const baseName = fileName.replace(/\.topic$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return baseName === normalizedTopicName;
  });
  return matchedFileName ? { fileName: matchedFileName, yaml: modelYaml.files[matchedFileName] || '' } : null;
}

function replaceTopLevelYamlBlock(yaml: string, key: string, replacement: string) {
  const cleanReplacement = replacement.trim();
  if (!cleanReplacement) return yaml;

  const lines = yaml.split('\n');
  const keyPattern = new RegExp(`^${key}:\\s*`);
  const start = lines.findIndex((line) => keyPattern.test(line));
  const nextTopLevelPattern = /^[A-Za-z_][\w-]*:\s*/;

  if (start >= 0) {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (nextTopLevelPattern.test(lines[index])) {
        end = index;
        break;
      }
    }
    return [...lines.slice(0, start), ...cleanReplacement.split('\n'), ...lines.slice(end)].join('\n');
  }

  const insertBefore = lines.findIndex((line) => /^(views|fields|ai_fields|sample_queries|ai_context):\s*/.test(line));
  if (insertBefore >= 0) {
    return [...lines.slice(0, insertBefore), cleanReplacement, ...lines.slice(insertBefore)].join('\n');
  }
  return [yaml.trimEnd(), cleanReplacement].filter(Boolean).join('\n\n');
}

function extractTopLevelYamlBlock(yaml: string, key: string) {
  const lines = yaml.split('\n');
  const keyPattern = new RegExp(`^${key}:\\s*`);
  const start = lines.findIndex((line) => keyPattern.test(line));
  const nextTopLevelPattern = /^[A-Za-z_][\w-]*:\s*/;
  if (start < 0) return '';

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (nextTopLevelPattern.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function cloneJoinTree(tree: JoinTree): JoinTree {
  return Object.fromEntries(Object.entries(tree).map(([key, value]) => [key, cloneJoinTree(value)]));
}

function collectJoinViewNames(tree: JoinTree, names = new Set<string>()) {
  Object.entries(tree).forEach(([viewName, children]) => {
    names.add(viewName);
    collectJoinViewNames(children, names);
  });
  return names;
}

function parseJoinYamlBlock(joinYaml: string): JoinTree {
  const root: JoinTree = {};
  const stack: Array<{ indent: number; node: JoinTree }> = [{ indent: -1, node: root }];

  joinYaml.split('\n').forEach((line) => {
    if (!line.trim() || line.trim().startsWith('#') || /^joins:\s*/.test(line)) return;
    const match = line.match(/^(\s*)(["']?[\w.:-]+["']?):\s*(?:\{\})?\s*(?:#.*)?$/);
    if (!match) return;
    const indent = match[1].length;
    const viewName = match[2].replace(/^["']|["']$/g, '');

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    if (!parent[viewName]) parent[viewName] = {};
    stack.push({ indent, node: parent[viewName] });
  });

  return root;
}

function mergeCandidateJoinTree(target: JoinTree, candidate: JoinTree, sourceViewNames: Set<string>) {
  Object.entries(candidate).forEach(([viewName, candidateChildren]) => {
    if (target[viewName]) {
      mergeCandidateJoinTree(target[viewName], candidateChildren, sourceViewNames);
      return;
    }

    if (sourceViewNames.has(viewName)) return;

    target[viewName] = {};
    mergeCandidateJoinTree(target[viewName], candidateChildren, sourceViewNames);
  });
}

function mergeSourceTopicJoins(yaml: string, sourceJoinYaml: string) {
  if (!sourceJoinYaml.trim()) return yaml;

  const sourceTree = parseJoinYamlBlock(sourceJoinYaml);
  const sourceViewNames = collectJoinViewNames(sourceTree);
  const candidateJoinYaml = extractTopLevelYamlBlock(yaml, 'joins');
  const mergedTree = cloneJoinTree(sourceTree);

  if (candidateJoinYaml.trim()) {
    mergeCandidateJoinTree(mergedTree, parseJoinYamlBlock(candidateJoinYaml), sourceViewNames);
  }

  const mergedJoinYaml = ['joins:', ...renderJoinTree(mergedTree, 2)].join('\n');
  return replaceTopLevelYamlBlock(yaml, 'joins', mergedJoinYaml);
}

function replaceTopLevelYamlBlockBefore(yaml: string, key: string, replacement: string, beforeKeys: string[]) {
  const cleanReplacement = replacement.trim();
  if (!cleanReplacement) return yaml;

  const lines = yaml.split('\n');
  const keyPattern = new RegExp(`^${escapeRegex(key)}:\\s*`);
  const start = lines.findIndex((line) => keyPattern.test(line));
  const nextTopLevelPattern = /^[A-Za-z_][\w-]*:\s*/;

  if (start >= 0) {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (nextTopLevelPattern.test(lines[index])) {
        end = index;
        break;
      }
    }
    return [...lines.slice(0, start), ...cleanReplacement.split('\n'), ...lines.slice(end)].join('\n');
  }

  const beforePattern = new RegExp(`^(?:${beforeKeys.map(escapeRegex).join('|')}):\\s*`);
  const insertBefore = lines.findIndex((line) => beforePattern.test(line));
  if (insertBefore >= 0) {
    return [...lines.slice(0, insertBefore), cleanReplacement, ...lines.slice(insertBefore)].join('\n');
  }

  return [yaml.trimEnd(), cleanReplacement].filter(Boolean).join('\n\n');
}

function parseBracketedList(value: string) {
  return uniqueStrings(
    value
      .split(',')
      .map((item) => item.trim().replace(/^[`"']+|[`"']+$/g, ''))
      .filter(Boolean),
    20
  );
}

function cleanPermissionIdentifier(value: string) {
  return value.trim().replace(/[.,;:]+$/g, '');
}

function parsePermissionAccessGrants(text: string) {
  const grants: PermissionAccessGrantContract[] = [];
  const seen = new Set<string>();
  const grantPattern = /(?:define\s+(?:a\s+)?|create\s+(?:a\s+)?|add\s+(?:a\s+)?|grant\s+)([A-Za-z_][\w-]*)(?:\s+grant)?[\s\S]{0,180}?user_attribute\s*:?\s*([A-Za-z_][\w.-]*)[\s\S]{0,180}?allowed_values?\s*:?\s*\[([^\]]+)\]/gi;
  Array.from(text.matchAll(grantPattern)).forEach((match) => {
    const name = cleanPermissionIdentifier(match[1] || '');
    const userAttribute = cleanPermissionIdentifier(match[2] || '');
    const allowedValues = parseBracketedList(match[3] || '');
    if (!name || !userAttribute || allowedValues.length === 0) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    grants.push({ name, userAttribute, allowedValues });
  });

  return grants;
}

function parsePermissionRequiredTopicGrants(text: string, grants: PermissionAccessGrantContract[]) {
  const required = new Set<string>();
  Array.from(text.matchAll(/(?:restrict|gate|limit)[\s\S]{0,120}?topic[\s\S]{0,120}?\b([A-Za-z_][\w-]*)\s+grant\b/gi))
    .forEach((match) => {
      if (match[1]) required.add(match[1]);
    });
  Array.from(text.matchAll(/required_access_grants?[\s\S]{0,80}?\b([A-Za-z_][\w-]*)\b/gi))
    .forEach((match) => {
      if (match[1] && match[1] !== 'required_access_grants') required.add(match[1]);
    });

  if (!required.size) {
    const topicEntryGrant = grants.find((grant) => !/pii/i.test(grant.name));
    if (topicEntryGrant && /topic[\s\S]{0,160}(?:restrict|gate|access)|(?:restrict|gate|access)[\s\S]{0,160}topic/i.test(text)) {
      required.add(topicEntryGrant.name);
    }
  }

  return Array.from(required).filter((grantName) => grants.some((grant) => grant.name === grantName));
}

function parsePermissionTopicAccessFilters(text: string) {
  const filters: PermissionTopicAccessFilterContract[] = [];
  const seen = new Set<string>();
  const accessFilterPattern = /access[_\s-]?filters?[\s\S]{0,140}?(?:on|field:?)\s*([A-Za-z_][\w-]*\.[A-Za-z_][\w-]*)[\s\S]{0,180}?user_attribute\s*:?\s*([A-Za-z_][\w.-]*)[\s\S]{0,180}?values[_\s-]?for[_\s-]?unfiltered\s*:?\s*\[([^\]]+)\]/gi;
  Array.from(text.matchAll(accessFilterPattern)).forEach((match) => {
    const field = cleanPermissionIdentifier(match[1] || '');
    const userAttribute = cleanPermissionIdentifier(match[2] || '');
    const valuesForUnfiltered = parseBracketedList(match[3] || '');
    if (!field || !userAttribute || valuesForUnfiltered.length === 0) return;
    const key = `${field.toLowerCase()}|${userAttribute.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    filters.push({ field, userAttribute, valuesForUnfiltered });
  });

  return filters;
}

function buildPermissionPackageContract(input: {
  readinessInputSummary: string;
  businessQuestion: string;
  previousSummary: string;
  targetFileName: string;
  sourceModelYaml: string;
  sourceTargetYaml: string;
}): PermissionPackageContract {
  const sourceText = [
    input.businessQuestion,
    input.readinessInputSummary,
  ].filter(Boolean).join('\n\n');
  const accessGrants = parsePermissionAccessGrants(sourceText);
  const topicRequiredAccessGrants = parsePermissionRequiredTopicGrants(sourceText, accessGrants);
  const topicAccessFilters = parsePermissionTopicAccessFilters(sourceText);
  const blockers: string[] = [];

  if (!input.targetFileName.endsWith('.topic')) blockers.push('Deterministic Permission packaging currently supports selected .topic targets only.');
  if (!input.sourceModelYaml.trim()) blockers.push('Settings/model source YAML is missing, so access_grants cannot be assembled safely.');
  if (!input.sourceTargetYaml.trim()) blockers.push(`${input.targetFileName} source YAML is missing, so the complete replacement topic file cannot be assembled safely.`);
  if (!accessGrants.length) blockers.push('No complete confirmed access_grants contract was found in Confirm inputs.');
  if (!topicRequiredAccessGrants.length) blockers.push('No confirmed topic-level required_access_grants entry was found in Confirm inputs.');
  if (!topicAccessFilters.length) blockers.push('No complete confirmed topic access_filters contract was found in Confirm inputs.');
  if (extractTopLevelYamlBlock(input.sourceTargetYaml, 'access_filters').trim()) {
    blockers.push('Existing topic access_filters were detected; deterministic merge is deferred to avoid overwriting existing RLS.');
  }

  const assumptions = [
    'The package defines only confirmed Settings/model access_grants and selected-topic permission controls; it does not create user_attributes or default values.',
    'Users with a null or unset permission-driving user attribute should receive Omni access-filter denial or the normal access-filter error; no open-access default is added.',
    topicAccessFilters.length
      ? `Cross-scope users must be assigned ${topicAccessFilters[0].userAttribute} = ${topicAccessFilters[0].valuesForUnfiltered.join(', ')} before deployment.`
      : '',
    accessGrants.some((grant) => /pii/i.test(grant.name))
      ? 'PII field masking is deferred to a separate public/users.view Permission Builder package that references the PII grant created here.'
      : 'PII field masking remains a separate public/users.view Permission Builder workflow.',
    'The Complete / Processing status rule remains advisory ai_context only and is not converted into an access_filter or model default in this package.',
  ].filter(Boolean);

  return {
    accessGrants,
    topicRequiredAccessGrants,
    topicAccessFilters,
    assumptions,
    blockers,
  };
}

function removeYamlMappingEntries(block: string, entryNames: string[]) {
  const removeNames = new Set(entryNames.map((name) => name.toLowerCase()));
  const lines = block.split('\n');
  const result: string[] = [];
  let skipping = false;

  lines.forEach((line, index) => {
    if (index === 0) {
      result.push(line);
      return;
    }
    const entryMatch = line.match(/^\s{2}([A-Za-z_][\w-]*):\s*/);
    if (entryMatch?.[1]) {
      skipping = removeNames.has(entryMatch[1].toLowerCase());
    }
    if (!skipping) result.push(line);
  });

  return result.join('\n').trimEnd();
}

function renderAccessGrantYamlEntries(grants: PermissionAccessGrantContract[]) {
  return grants.flatMap((grant) => [
    `  ${grant.name}:`,
    `    user_attribute: ${grant.userAttribute}`,
    '    allowed_values:',
    ...grant.allowedValues.map((value) => `      - ${quoteYamlString(value)}`),
  ]);
}

function applyPermissionAccessGrantsToModelYaml(sourceYaml: string, grants: PermissionAccessGrantContract[]) {
  const existingBlock = extractTopLevelYamlBlock(sourceYaml, 'access_grants');
  const existingWithoutManagedGrants = existingBlock
    ? removeYamlMappingEntries(existingBlock, grants.map((grant) => grant.name))
    : 'access_grants:';
  const replacement = [
    existingWithoutManagedGrants,
    ...renderAccessGrantYamlEntries(grants),
  ].filter((line) => line.trim()).join('\n');

  return replaceTopLevelYamlBlock(sourceYaml.trimEnd(), 'access_grants', replacement).trimEnd();
}

function renderRequiredAccessGrantsBlock(grantNames: string[]) {
  return [
    'required_access_grants:',
    ...grantNames.map((grantName) => `  - ${grantName}`),
  ].join('\n');
}

function renderTopicAccessFiltersBlock(filters: PermissionTopicAccessFilterContract[]) {
  return [
    'access_filters:',
    ...filters.flatMap((filter) => [
      `  - field: ${filter.field}`,
      `    user_attribute: ${filter.userAttribute}`,
      '    values_for_unfiltered:',
      ...filter.valuesForUnfiltered.map((value) => `      - ${quoteYamlString(value)}`),
    ]),
  ].join('\n');
}

function extractTopicAiContextText(sourceYaml: string) {
  const block = extractTopLevelYamlBlock(sourceYaml, 'ai_context');
  if (!block.trim()) return '';

  const lines = block.split('\n');
  const firstValue = lines[0]?.replace(/^ai_context:\s*/, '').trim() || '';
  if (firstValue && !/^[>|]/.test(firstValue)) return cleanYamlScalar(firstValue);

  return lines
    .slice(1)
    .map((line) => line.replace(/^\s{2}/, ''))
    .join('\n')
    .trim();
}

function wrapPlainText(value: string, maxWidth = 82) {
  return value
    .split(/\n{2,}/)
    .flatMap((paragraph) => {
      const words = paragraph.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      if (!words.length) return [''];
      const lines: string[] = [];
      let current = '';
      words.forEach((word) => {
        const next = current ? `${current} ${word}` : word;
        if (next.length > maxWidth && current) {
          lines.push(current);
          current = word;
        } else {
          current = next;
        }
      });
      if (current) lines.push(current);
      return [...lines, ''];
    })
    .slice(0, -1);
}

function renderFoldedTextYamlBlock(key: string, value: string) {
  return [
    `${key}: >-`,
    ...wrapPlainText(value).map((line) => (line ? `  ${line}` : '')),
  ].join('\n');
}

function buildPermissionTopicAiContext(sourceYaml: string, contract: PermissionPackageContract) {
  const existingContext = extractTopicAiContextText(sourceYaml);
  const entryGrant = contract.topicRequiredAccessGrants[0] || 'the confirmed topic access grant';
  const filter = contract.topicAccessFilters[0];
  const accessScope = filter
    ? `ACCESS SCOPE: This topic requires ${entryGrant}. Results are filtered by matching ${filter.field} to the user's ${filter.userAttribute} attribute. Users assigned ${filter.userAttribute} = ${filter.valuesForUnfiltered.join(', ')} can query across all filtered values.`
    : `ACCESS SCOPE: This topic requires ${entryGrant}.`;

  return [
    'This topic covers transaction and revenue analysis. Answer questions about transactions, order volume, revenue, and fulfillment metrics.',
    accessScope,
    'STATUS FILTER (ADVISORY ONLY): When counting orders or calculating revenue, default to Complete or Processing status when that business assumption is appropriate. This is AI guidance only, not row-level security. Analysts who need all statuses must explicitly override the assumption.',
    'METRIC ROUTING: Use order_items.sale_price_sum for revenue questions and order_items.order_count for order volume questions when those fields exist in the model.',
    'PII ROUTING: Do not use this topic for AI-assisted display, lookup, export, or mapping of raw customer PII or precise location fields such as email, full name, last name, zip, latitude, longitude, or age until the corresponding public/users.view field-level controls are deployed.',
    existingContext ? `SOURCE CONTEXT PRESERVED: ${existingContext}` : '',
  ].filter(Boolean).join('\n\n');
}

function applyPermissionContractToTopicYaml(sourceYaml: string, contract: PermissionPackageContract) {
  const topicPermissionInsertBefore = ['joins', 'views', 'fields', 'ai_fields', 'sample_queries', 'ai_context'];
  const requiredGrantNames = uniqueStrings([
    ...topLevelListItems(sourceYaml, 'required_access_grants'),
    ...contract.topicRequiredAccessGrants,
  ], 20);
  let nextYaml = sourceYaml.trimEnd();
  nextYaml = replaceTopLevelYamlBlockBefore(
    nextYaml,
    'required_access_grants',
    renderRequiredAccessGrantsBlock(requiredGrantNames),
    topicPermissionInsertBefore
  );
  nextYaml = replaceTopLevelYamlBlockBefore(
    nextYaml,
    'access_filters',
    renderTopicAccessFiltersBlock(contract.topicAccessFilters),
    topicPermissionInsertBefore
  );
  nextYaml = replaceTopLevelYamlBlock(
    nextYaml,
    'ai_context',
    renderFoldedTextYamlBlock('ai_context', buildPermissionTopicAiContext(sourceYaml, contract))
  );
  return nextYaml.trimEnd();
}

function buildPermissionPackageMessage(files: Array<{ fileName: string; yaml: string }>, assumptions: string[]) {
  return [
    ...files.map((file) => [
      `Target file: ${file.fileName}`,
      '```yaml',
      file.yaml.trimEnd(),
      '```',
    ].join('\n')),
    'Assumptions / validations',
    ...uniqueStrings(assumptions, 5).map((assumption) => `- ${assumption}`),
  ].join('\n\n');
}

function buildDeterministicPermissionTopicPackage(input: {
  targetFileName: string;
  sourceModelYaml: string;
  sourceTargetYaml: string;
  readinessInputSummary: string;
  businessQuestion: string;
  previousSummary: string;
}) {
  const contract = buildPermissionPackageContract(input);
  if (contract.blockers.length > 0) {
    return { message: '', contract };
  }

  const modelYaml = applyPermissionAccessGrantsToModelYaml(input.sourceModelYaml, contract.accessGrants);
  const topicYaml = applyPermissionContractToTopicYaml(input.sourceTargetYaml, contract);
  return {
    message: buildPermissionPackageMessage([
      { fileName: 'model', yaml: modelYaml },
      { fileName: input.targetFileName, yaml: topicYaml },
    ], contract.assumptions),
    contract,
  };
}

function formatWorkstreamFocus(workstreams: WorkstreamId[], studioPath: StudioPathSelection) {
  const availableWorkstreams = workstreamsForPath(studioPath);
  const selected = workstreams.includes('full')
    ? availableWorkstreams
    : availableWorkstreams.filter((workstream) => workstreams.includes(workstream.id));

  return selected
    .map((workstream) => `- ${workstream.label}: ${workstream.description}`)
    .join('\n');
}

const DEEP_REVIEW_CHUNKS: Array<Omit<DeepReviewChunkState, 'status'>> = [
  {
    id: 'probe',
    label: 'Probe',
    description: 'Baseline fit, questions, use cases, and initial risks.',
  },
  {
    id: 'field-audit',
    label: 'Model / View',
    description: 'Settings/model, relationships, .view fields, measures, and metadata gaps.',
  },
  {
    id: 'context-audit',
    label: 'Context',
    description: 'AI context, field metadata, synonyms, routing rules, and sample values.',
  },
  {
    id: 'topic-plan',
    label: 'Build Plan',
    description: 'Topic Builder and Model / View Builder plan with admin validations.',
  },
  {
    id: 'final-yaml',
    label: 'Package',
    description: 'Final reviewable YAML assembled after admin confirmation.',
  },
];

const REVIEW_CHUNK_IDS: DeepReviewChunkId[] = ['probe', 'field-audit', 'context-audit', 'topic-plan'];
const FINAL_PACKAGE_CHUNK_ID: DeepReviewChunkId = 'final-yaml';

function initialDeepReviewChunks(): DeepReviewChunkState[] {
  return DEEP_REVIEW_CHUNKS.map((chunk) => ({ ...chunk, status: 'pending' }));
}

function buildPackageYamlGuidance(studioPath: StudioPath, targetFileName?: string) {
  const target = targetFileName?.trim() || '';
  if (studioPath === 'permissions') {
    const guidance = [OMNI_MODEL_FILE_YAML_GUIDANCE];
    if (target.endsWith('.topic')) guidance.push(OMNI_TOPIC_YAML_GUIDANCE);
    if (target.endsWith('.view')) guidance.push(OMNI_VIEW_FILE_YAML_GUIDANCE);
    if (target === 'model') return OMNI_MODEL_FILE_YAML_GUIDANCE;
    return [
      'Permission Builder package guidance:',
      '- Return Settings/model first when it is an expected package target, then the selected permission target file.',
      '- Keep each file body complete and in its own Target file + fenced yaml block.',
      ...guidance,
    ].join('\n');
  }
  if (studioPath === 'topic' || target.endsWith('.topic')) return OMNI_TOPIC_YAML_GUIDANCE;
  if (target === 'model') return OMNI_MODEL_FILE_YAML_GUIDANCE;
  if (target === 'relationships') return OMNI_RELATIONSHIPS_YAML_GUIDANCE;
  if (target.endsWith('.view')) return OMNI_VIEW_FILE_YAML_GUIDANCE;
  return [
    'Selected target file type is ambiguous. Use the selected target exactly and do not create extra files.',
    OMNI_MODEL_FILE_YAML_GUIDANCE,
    OMNI_RELATIONSHIPS_YAML_GUIDANCE,
    OMNI_VIEW_FILE_YAML_GUIDANCE,
  ].join('\n');
}

function buildDeepReviewChunkPrompt(input: {
  chunkId: DeepReviewChunkId;
  studioPath: StudioPath;
  topicTitle: string;
  workstreamSummary: string;
  modelName: string;
  modelId: string;
  topicName?: string;
  targetBaseViewName?: string;
  businessQuestion: string;
  topics: TopicEntry[];
  readinessInputSummary: string;
  previousSummary: string;
  topicSourceContext: string;
  modelSourceContext: string;
  }) {
  const isPackageChunk = input.chunkId === FINAL_PACKAGE_CHUNK_ID;
  const selectedTargetFile = input.targetBaseViewName?.trim() || '';
  const isPermissionPath = input.studioPath === 'permissions';
  const isSettingsModelTarget = pathUsesTargetSemanticFile(input.studioPath) && selectedTargetFile === 'model';
  const isRelationshipsTarget = input.studioPath === 'model' && selectedTargetFile === 'relationships';
  const isTopicTarget = isPermissionPath && selectedTargetFile.endsWith('.topic');
  const isViewTarget = pathUsesTargetSemanticFile(input.studioPath) && selectedTargetFile.endsWith('.view');
  const isQueryViewTarget = /\.query\.view$/i.test(selectedTargetFile);
  const topicScope = isPermissionPath
    ? isTopicTarget
      ? `Permission target topic: ${topicNameFromTargetFile(selectedTargetFile)} (${selectedTargetFile}). Treat this as an existing target file; do not create a new topic candidate.`
      : 'Topic: Not selected unless the Permission Builder target is an existing .topic file. Do not create topic YAML unless the selected target is a .topic file.'
    : !pathIncludesTopic(input.studioPath)
    ? 'Topic: Not required for this Model / View Builder path. Do not create topic YAML unless the admin changes paths.'
    : input.topicName
      ? `Topic: ${input.topicName}`
      : 'Topic: New topic candidate mode. No existing topic is selected; use confirmed inputs, model context, and existing topics to recommend a topic file name. Generate the complete .topic body only in Package.';
  const pathLabel =
    input.studioPath === 'permissions'
      ? 'Permission Builder only'
      : input.studioPath === 'model'
      ? 'Model / View Builder only'
      : 'Topic Builder only';
  const defaultWorkflow =
    isPermissionPath
      ? `No specific workflow was provided. Review the selected ${targetFileTypeLabel(selectedTargetFile)} target for permission integrity: access grants, user attributes, access filters, required grants, masking, RLS, PII exposure, and whether related permission work belongs in another target file.`
      :
    isSettingsModelTarget
      ? 'No specific workflow was provided. Review only Settings/model global configuration such as cache policies, access grants/filters, ignored schemas/views, fiscal/calendar settings, and model-level AI settings.'
      : isRelationshipsTarget
      ? 'No specific workflow was provided. Review only the Settings/relationships file for reusable relationship edges, cardinality, join SQL, fanout risk, and relationship metadata. Infer candidate gaps from the current relationships YAML and model inventory only.'
      : isViewTarget
      ? `No specific workflow was provided. Review only the selected ${isQueryViewTarget ? 'query view' : 'view'} file for semantic modeling quality using its current YAML as the source of truth. Infer the view's business purpose from its name, source-defining sections, dimensions, measures, descriptions, formats, and existing metadata.`
      : input.studioPath === 'model'
      ? 'No specific workflow was provided. Run a broad model/view development review for model settings, relationships, view fields, metrics, and descriptions.'
      : 'No specific workflow was provided. Run a broad topic development review for topic shape, joins, ai_fields, sample queries, and AI context.';
  const visibilityGuardrails = isSettingsModelTarget
    ? 'Settings/model guardrail: field visibility is not applicable in this lane. Do not recommend hidden fields, dimensions, measures, field synonyms, topic ai_fields, topic sample_queries, view YAML, or relationship YAML as selected-target work. Mention other-file findings only in separateWorkflow notes.'
    : FIELD_VISIBILITY_GUARDRAILS;
  const reviewFileBoundaries = isPermissionPath
    ? `File boundaries: Permission Builder reviews permission design across topic/model/view. Expected package targets for this run: ${permissionPackageTargetFiles(selectedTargetFile).join(', ') || 'choose a permission target first'}. Put permission work outside those targets in separateWorkflow notes.`
    : 'File boundaries: Topic Builder creates .topic files only. Model / View Builder creates one selected target only: model, relationships, or .view.';
  const workflowScope = `Model: ${input.modelName} (${input.modelId})
Development path: ${pathLabel}
${topicScope}
Target semantic file: ${selectedTargetFile || 'Not provided'}
Business question or workflow: ${input.businessQuestion || defaultWorkflow}
Existing topics: ${input.topics.map((topic) => topic.name).slice(0, 20).join(', ') || 'No topics listed yet'}
${isPackageChunk ? SEMANTIC_FILE_TAXONOMY : reviewFileBoundaries}
${isPackageChunk ? AI_PACKAGE_STAGE_CONTRACT : AI_REVIEW_STAGE_CONTRACT}
${input.topicSourceContext}
${input.modelSourceContext}
${visibilityGuardrails}
${isPermissionPath ? PERMISSION_BUILDER_GUARDRAILS : ''}
${PII_GOVERNANCE_GUARDRAILS}
Selected studio workstreams:
${input.workstreamSummary}
Confirmed admin inputs:
${input.readinessInputSummary}
Prior review brief:
${input.previousSummary || 'None yet.'}`;

  if (input.chunkId === 'probe') {
    return `${input.topicTitle} - AI Semantic Studio Deep Review - 1 of 5 - Baseline Probe
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Return ONLY one fenced json block. No prose before or after it.
\`\`\`json
{
  "topic": "selected_topic_name_or_not_applicable",
  "targetView": "target_view_or_base_view_when_model_path",
  "verdict": "short readiness verdict",
  "confidence": "0-100%",
  "questions": ["3-5 business questions this semantic work should support"],
  "useCases": ["3 business use cases"],
  "businessRules": ["3-5 default filters, grains, or assumptions"],
  "clarifyingQuestions": ["3-5 questions the admin should answer before YAML is generated"],
  "gaps": ["3-5 highest-priority gaps"],
  "outOfScope": ["3-5 questions this workflow should not answer or should route elsewhere"]
}
\`\`\``;
  }

  if (input.chunkId === 'field-audit') {
    if (isPermissionPath) {
      return `${input.topicTitle} - AI Semantic Studio Deep Review - 2 of 5 - Permission Target Audit
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Focus only on permission integrity for the selected target file. Review candidate user attributes, access grants, required_access_grants, access_filters, default_topic_access_filters, default_topic_required_access_grants, mask_unless_access_grants, omni_attributes usage, sensitive fields, row-level security, and target-file placement.
Do not treat a sensitive-looking field name as enough evidence to emit deployable permissions. Ask for confirmation of exact field, user_attribute, grant name, allowed values, bypass/admin behavior, and null/default behavior.
This is a review step, not a generation step. Do not include Target file lines, fenced YAML blocks, or deployable file bodies. If you include a yamlHint, keep it short and non-deployable.
Return ONLY one fenced json block. No prose before or after it.
\`\`\`json
{
  "permissionIssues": [
    {
      "target": "selected_file.permission_area",
      "severity": "critical|high|medium|low",
      "issue": "short issue",
      "recommendation": "specific permission remediation",
      "yamlHint": "optional concise non-deployable hint"
    }
  ],
  "permissionRecommendations": ["3-5 access grant, access filter, masking, or RLS recommendations"],
  "targetFileNotes": ["3-5 concise notes for the selected target file only; no YAML blocks"],
  "separateWorkflowNotes": ["0-3 permission changes that belong in a different target file"],
  "validationQuestions": ["3-5 questions for the admin or data owner"]
}
\`\`\``;
    }

    if (isSettingsModelTarget) {
      return `${input.topicTitle} - AI Semantic Studio Deep Review - 2 of 5 - Settings/model Audit
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Focus only on Settings/model parameters: default_cache_policy, cache_policies, ignored_schemas, ignored_views, included_schemas, included_views, access_grants, default_topic_access_filters, default_topic_required_access_grants, fiscal_month_offset, week_start_day, default_row_limit, default_numeric_locale, ai_context, ai_settings, auto_run, constants, dynamic_schemas, and extends.
Do not review view dimensions, measures, labels, hidden fields, synonyms, topic ai_fields, sample_queries, topic joins, or relationship objects in this target-file lane. Put those observations in separateWorkflowNotes only, with the correct target file.
This is a review step, not a generation step. Do not include Target file lines, fenced YAML blocks, or deployable file bodies. If you include a yamlHint, keep it non-deployable and scoped to model keys only.
Return ONLY one fenced json block. No prose before or after it.
\`\`\`json
{
  "modelSettingIssues": [
    {
      "target": "model.setting_key",
      "severity": "critical|high|medium|low",
      "issue": "short issue",
      "recommendation": "specific Settings/model remediation",
      "yamlHint": "optional concise model-key hint"
    }
  ],
  "modelRecommendations": ["3-5 Settings/model additions, fixes, or validation recommendations"],
  "targetFileNotes": ["3-5 concise non-deployable notes for the Settings/model file only; no YAML blocks"],
  "separateWorkflowNotes": ["0-3 items that belong in a different target file/workflow, such as relationships, .view, or .topic files"],
  "validationQuestions": ["3-5 questions for the admin or data owner"]
}
\`\`\``;
    }

    return `${input.topicTitle} - AI Semantic Studio Deep Review - 2 of 5 - Model / View Builder Audit
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Focus only on fields, dimensions, measures, metrics, descriptions, hidden/noisy fields, relationships, model settings, and view/modeling gaps. Return ONLY one fenced json block. No prose before or after it.
Apply the field visibility guardrails strictly: do not recommend hidden: true solely because a field is out of scope. Use ai_fields exclusion for AI routing unless the field is misleading, duplicated, a dev artifact, a surrogate-key aggregate, or a documented governance risk.
This is a review step, not a generation step. Do not include Target file lines, fenced YAML blocks, or deployable file bodies. If you include a yamlHint, make it a short non-deployable hint such as "measures.example_metric.aggregate_type: sum"; do not write a full YAML artifact.
\`\`\`json
{
  "fieldIssues": [
    {
      "target": "view.field_or_measure",
      "severity": "critical|high|medium|low",
      "issue": "short issue",
      "recommendation": "specific remediation",
      "yamlHint": "optional concise YAML/modeling hint"
    }
  ],
  "measureRecommendations": ["3-5 measure additions, fixes, or hide/deprecate recommendations"],
  "targetFileNotes": ["3-5 concise non-deployable notes for the selected target file only; no YAML blocks"],
  "separateWorkflowNotes": ["0-3 items that belong in a different target file/workflow, such as relationships or another .view file"],
  "validationQuestions": ["3-5 questions for the admin or data owner"]
}
\`\`\``;
  }

  if (input.chunkId === 'context-audit') {
    if (isPermissionPath) {
      return `${input.topicTitle} - AI Semantic Studio Deep Review - 3 of 5 - Permission Context and Routing Audit
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Focus only on permission context quality: what should be enforceable YAML versus advisory ai_context, how AI should avoid sensitive fields, where permissions belong across model/topic/view targets, and which permission assumptions must be visible to admins before Package.
Treat negative routing and out-of-scope guidance as AI context, not as a permission control. Real restrictions must use access_grants, required_access_grants, access_filters, default_topic_access_filters, or mask_unless_access_grants in the correct selected file.
This is a review step, not a generation step. Do not include Target file lines, fenced YAML blocks, or deployable file bodies.
Return ONLY one fenced json block. No prose before or after it.
\`\`\`json
{
  "permissionRoutingRules": ["3-5 rules for when to use this permission target or route to another target"],
  "negativeRouting": ["3-5 sensitive or out-of-scope questions AI should avoid or route elsewhere"],
  "attributeCandidates": [
    {
      "candidate": "field_or_user_attribute",
      "likelyUse": "access grant|access filter|masking|row access",
      "validationNeeded": "what the admin must confirm"
    }
  ],
  "aiContextOpportunities": ["3-5 concise permission-context improvements"]
}
\`\`\``;
    }

    if (isSettingsModelTarget) {
      return `${input.topicTitle} - AI Semantic Studio Deep Review - 3 of 5 - Settings/model AI Context Audit
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Focus only on model-level AI quality: ai_context, ai_settings, ai_chat_topics, default access-filter guidance, and domain framing that applies across the whole model.
Do not propose field-level synonyms, sample values, topic sample_queries, topic ai_fields, topic joins, view descriptions, or relationship objects. Those belong in separate target-file workflows.
This is a review step, not a generation step. Do not include Target file lines, fenced YAML blocks, or deployable file bodies.
Return ONLY one fenced json block. No prose before or after it.
\`\`\`json
{
  "modelRoutingGuidance": ["3-5 model-level guidance rules that help Omni Agent choose between existing topics/views"],
  "negativeModelGuidance": ["3-5 model-level caveats or questions that should not be answered without another workflow"],
  "modelAiContextOpportunities": ["3-5 concise model-level ai_context or ai_settings improvements"],
  "separateWorkflowNotes": ["0-3 field, topic, relationship, or view metadata items that belong outside Settings/model"],
  "validationQuestions": ["3-5 questions for the admin or data owner"]
}
\`\`\``;
    }

    return `${input.topicTitle} - AI Semantic Studio Deep Review - 3 of 5 - AI Context and Routing Audit
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Focus only on AI quality. For Topic Builder paths, cover topic ai_context, ai_fields, routing, sample queries, and negative routing. For Model / View Builder paths, cover field descriptions, synonyms, sample values, model-level guidance, and field metadata. Return ONLY one fenced json block. No prose before or after it.
Treat negative routing and out-of-scope guidance as AI context, not a hidden-field instruction. Prefer ai_fields exclusions and routing notes unless a separate misleading-field or governance risk is documented.
This is a review step, not a generation step. Do not include Target file lines, fenced YAML blocks, or deployable file bodies.
\`\`\`json
{
  "routingRules": ["3-5 rules that tell Omni Agent when to use this topic, model setting, relationship, or view definition"],
  "negativeRouting": ["3-5 questions that should route away from this workflow"],
  "synonyms": [
    {
      "target": "view.field_or_measure",
      "terms": ["term1", "term2"],
      "reason": "why this helps AI"
    }
  ],
  "aiContextOpportunities": ["3-5 topic or field context improvements"]
}
\`\`\``;
  }

  if (input.chunkId === 'topic-plan') {
    if (isPermissionPath) {
      return `${input.topicTitle} - AI Semantic Studio Deep Review - 4 of 5 - Permission Implementation Plan
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Create the Permission Builder implementation plan as structured data only. Respect the expected package targets for this run: ${permissionPackageTargetFiles(selectedTargetFile).join(', ') || selectedTargetFile}. Package may emit Settings/model plus the selected .topic or .view target when the selected target needs grants. Do not include deployable YAML in this review step.
If exact permission syntax, grant names, user_attribute references, allowed values, row-level match fields, or null/default behavior are not confirmed, choose ask_data_owner_first instead of inventing deployable YAML.
Return ONLY one fenced json block. No prose before or after it.
\`\`\`json
{
  "decision": "update_existing|ask_data_owner_first",
  "targetFiles": ["expected target files for Package"],
  "permissionObjective": "short description of the governed access outcome",
  "enforcementPoints": ["permission keys to use or validate by target file"],
  "attributeCandidates": ["candidate user attributes or field anchors to validate"],
  "targetFilePlan": ["3-5 implementation steps for the expected package targets; no YAML blocks"],
  "separateWorkflowPlan": ["0-3 permission changes that require files outside this package"],
  "validationQuestions": ["3-5 final admin questions before package generation"]
}
\`\`\``;
    }

    if (isSettingsModelTarget) {
      return `${input.topicTitle} - AI Semantic Studio Deep Review - 4 of 5 - Settings/model Implementation Plan
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Create the implementation plan as structured data only for the selected Settings/model target. Do not create deployable YAML yet. Do not include dimensions, measures, relationships, topic joins, ai_fields, sample_queries, or view-file metadata as selected-target work.
If a recommendation requires unconfirmed governance choices (access filters, ignored views/schemas, fiscal calendar), mark it ask_data_owner_first rather than inventing YAML.
Return ONLY one fenced json block. No prose before or after it.
\`\`\`json
{
  "decision": "update_existing|ask_data_owner_first",
  "targetFile": "model",
  "modelSettings": ["model keys to preserve, add, change, or validate"],
  "targetFilePlan": ["3-5 Settings/model-only implementation steps; no YAML blocks"],
  "separateWorkflowPlan": ["0-3 changes that require relationships, .view, or .topic workflows"],
  "validationQuestions": ["3-5 final admin questions before package generation"]
}
\`\`\``;
    }

    return `${input.topicTitle} - AI Semantic Studio Deep Review - 4 of 5 - Builder Implementation Plan
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Create the implementation plan as structured data only. Respect the selected development path: Model / View Builder returns model, relationships, or .view work as the primary lane; Topic Builder returns topic work as the primary lane. This is still a Review step: do not create deployable file bodies, Target file blocks, or final YAML yet. Do not mix topic YAML with model/view YAML in the same copyable artifact. Return ONLY one fenced json block. No prose before or after it.
Separate routing scope from field visibility. Out-of-scope recommendations should become ai_context, negative routing, or ai_fields exclusions. Only recommend hidden fields when the field itself is misleading, duplicated, a dev artifact, a surrogate-key aggregate, or a documented governance risk.
This is a planning step, not a generation step. Do not include Target file lines, fenced YAML blocks, or deployable file bodies. Keep the plan short and tied to the selected target file. Mention other files only as separate follow-up workflows.
\`\`\`json
{
  "decision": "update_existing|create_new|ask_data_owner_first",
  "topicName": "topic file/name recommendation",
  "label": "user-facing topic label",
  "description": "short human-facing description",
  "baseView": "base view",
  "grain": "semantic grain",
  "joins": ["joins to keep/add/remove"],
  "fields": ["fields or field groups to expose"],
  "metrics": ["metrics or measures to add, fix, hide, or validate"],
  "filters": ["default or always-on filters to validate"],
  "recommendations": ["3-5 concrete implementation recommendations"],
  "targetFilePlan": ["3-5 changes for the selected target file only; no YAML blocks"],
  "separateWorkflowPlan": ["0-3 changes that require a different workflow/target file"],
  "validationQuestions": ["3-5 final admin questions"]
}
\`\`\``;
  }

  if (input.studioPath === 'permissions') {
    const selectedTargetFile = input.targetBaseViewName?.trim() || '<selected target file>';
    const expectedTargetFiles = permissionPackageTargetFiles(selectedTargetFile);
    const expectedTargetList = expectedTargetFiles.join(', ') || selectedTargetFile;
    const responseShape = (expectedTargetFiles.length ? expectedTargetFiles : [selectedTargetFile])
      .map((targetFileName) => [
        `Target file: ${targetFileName}`,
        '```yaml',
        `<complete replacement YAML body for ${targetFileName}>`,
        '```',
      ].join('\n'))
      .join('\n\n');
    return `${input.topicTitle} - AI Semantic Studio Deep Review - 5 of 5 - Permission YAML Package
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}
${PERMISSION_PACKAGE_EXACTNESS_GUARDRAILS}

Create the final reviewable Permission Builder package from the confirmed admin inputs. The user has explicitly completed Review and Confirm and has now told Blobby to generate the file package. Return complete replacement YAML bodies for exactly these expected permission targets: ${expectedTargetList}. Do not return patch fragments or permission YAML for adjacent targets.
Use enforceable Omni permission controls in the file where Omni documents them. Settings/model targets may define access_grants, user attributes, default_topic_required_access_grants, and default_topic_access_filters. .topic targets may use topic-level required_access_grants and access_filters only when the referenced grant/user_attribute and field syntax are confirmed. .view targets may use view/field required_access_grants, mask_unless_access_grants, or confirmed custom masking with {{ omni_attributes.<attribute_reference> }}.
For .topic and .view permission packages, Settings/model is part of the deployable package because grants must be defined there before the selected target can safely reference them.
Do not infer deployable permissions solely from field names. If a grant, user_attribute, field, allowed value, row-level match, default/null behavior, or admin bypass is not confirmed, keep the source YAML unchanged and list the needed validation after the YAML block.
Use the current target file YAML and Settings/model YAML provided above as the source of truth. Each YAML block must be a complete replacement body for that target file, preserving unchanged source sections. If any expected target YAML was not provided or is truncated, do not invent a full replacement for that file; return assumptions/validations explaining what is needed.

Return ONLY this shape, with no prose before the first Target file:
${responseShape}

Assumptions / validations
- <max 5 bullets>

Critical formatting rules:
- Every YAML body must be inside a fenced \`\`\`yaml block.
- Do not write raw YAML outside the code fence.
- Do not add a "Permission Builder output" heading before any target line.
- Do not add markdown bolding around target lines.
- Do not include unrelated target files or separate workflow YAML outside the expected targets.

Follow this Omni YAML guidance for the expected permission targets:
${buildPackageYamlGuidance(input.studioPath, input.targetBaseViewName)}`;
  }

  if (input.studioPath === 'model') {
    const selectedTargetFile = input.targetBaseViewName?.trim() || '<selected target file>';
    return `${input.topicTitle} - AI Semantic Studio Deep Review - 5 of 5 - Model / View YAML Package
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Create the final reviewable Model / View Builder package from the confirmed admin inputs. The user has explicitly completed Review and Confirm and has now told Blobby to generate the file package. Do NOT create topic YAML. Do NOT include base_view, topic joins, ai_fields, sample_queries, or topic ai_context unless the target file is explicitly a topic file, which this path is not. Do not return patch fragments; return complete target file bodies that can be staged to the dev branch.
Do not hide fields solely because a use case is out of scope. Recommend hidden fields only for misleading fields, duplicates, dev artifacts, surrogate-key aggregates, or documented governance risk. Otherwise recommend descriptions, synonyms, or AI routing guidance.
For PII/RLS changes, use enforceable governance only in the correct selected target: Settings/model for model-level access grants/user attributes/access filters, or .view files for confirmed masked dimensions using omni_attributes. If exact syntax is not confirmed, do not invent deployable YAML; put the permission recommendation and a non-deployable commented example in assumptions/validations.
Use the current target file YAML provided above as the source of truth. The final YAML must be a complete replacement body for the selected target file, preserving unchanged source sections. If the current target file YAML was not provided or is truncated, do not invent a full replacement; return assumptions/validations explaining what is needed.

Return ONLY this shape, with no prose before Target file:
Target file: ${selectedTargetFile}
\`\`\`yaml
<complete replacement YAML body for ${selectedTargetFile}>
\`\`\`

Assumptions / validations
- <max 5 bullets>

Critical formatting rules:
- The YAML must be inside the fenced \`\`\`yaml block.
- Do not write raw YAML outside the code fence.
- Do not add a "Model / View Builder output" heading before the target line.
- Do not add markdown bolding around the target line.

Follow this Omni Model / View Builder YAML guidance for the selected target only:
${buildPackageYamlGuidance(input.studioPath, input.targetBaseViewName)}`;
  }

  if (input.studioPath === 'topic') {
    return `${input.topicTitle} - AI Semantic Studio Deep Review - 5 of 5 - Topic YAML Package
${TOPIC_AI_READINESS_ROLE}

${OMNI_AI_COMPACT_OUTPUT_RULES}
${workflowScope}

Create the final reviewable Topic Builder package from the confirmed admin inputs. The user has explicitly completed Review and Confirm and has now told Blobby to generate the file package. Put the topic YAML first so OmniKit can capture it. Do NOT create deployable model, relationships, or .view files in this path. If metrics or field definitions are missing, list them in validation notes instead of returning Target file blocks. Do not return patch fragments; return the complete topic file body that can be staged to the dev branch. If no existing topic was selected, this is a new-topic candidate: return a complete new .topic body and put the recommended topic file name in Assumptions / validations after the YAML block.
Do not convert out-of-scope guidance into hidden: true recommendations. Put out-of-scope questions in ai_context or omit fields from ai_fields. Use topic-scoped hidden fields only when there is a separate documented reason that the field is misleading or risky for users.
Do not include direct PII, contact, or person-identifying fields in ai_fields unless the confirmed admin inputs explicitly require AI-assisted PII lookup or display. If they remain available to users but should not drive AI routing, omit them from ai_fields and mention that in assumptions.
Do not include raw technical selectors in ai_fields or sample_queries unless the confirmed admin inputs explicitly require AI-assisted lookup/display: id, *_id, session_id, ad_event_id, uri, url, referrer, or referrer_code. For session questions, prefer validated session measures; if no safe session measure exists, put the gap in assumptions/validations instead of routing AI to raw session_id.
If a join path is only a candidate or needs relationship validation, do not include joins: in the deployable YAML. Put that join in assumptions/validations instead. Do not include joined-view fields in ai_fields or sample_queries unless the join is known-good or explicitly confirmed.
Do not include view-definition YAML in the topic file. Never write views.<view>.dimensions, views.<view>.measures, dimensions:, measures:, field labels, field context, values, synonyms, SQL, or measure definitions inside the topic YAML. Those belong in a separate Model / View Builder workflow and should appear only in assumptions/validations or separate workflow notes.
For existing topic updates, use the current topic YAML provided above as the source of truth. Preserve unchanged sections exactly where possible. If the current topic YAML body was not provided or is truncated, do not invent a complete replacement; return assumptions/validations explaining what is needed.

Return ONLY this shape, with the fenced YAML block first and no prose before it:
\`\`\`yaml
<complete topic file body>
\`\`\`

Assumptions / validations
- <max 5 bullets>

Critical formatting rules:
- The first non-whitespace characters of the response must be \`\`\`yaml.
- The topic YAML must be inside the fenced \`\`\`yaml block.
- Do not write raw YAML outside the code fence.
- For new-topic candidates, do not write "Recommended topic file name" before the YAML block. Put the suggested file name in Assumptions / validations after the YAML block.
- Do not add a "Complete Topic YAML" heading before the code fence.
- For Topic Builder, the YAML block must not contain view-level dimensions/measures under views:. If field context, labels, values, synonyms, or measures are needed, list them after the YAML block as Model / View Builder validation work.
- Before returning, self-check that the assumptions/validations do not contradict the YAML, especially ai_fields inclusion/exclusion and default_filters.

Follow this Omni topic YAML guidance:
${buildPackageYamlGuidance(input.studioPath, input.targetBaseViewName)}

This final YAML block must contain only topic-file parameters. Keep ai_context as the final top-level key. Do not include comments with global view-level measure definitions, target-state fields that do not exist yet, validation notes, or admin instructions inside the YAML block.`;
  }

  return '';
}

function buildPackageRepairPrompt(input: {
  studioPath: StudioPath;
  topicTitle: string;
  modelName: string;
  modelId: string;
  topicName?: string;
  targetFileName?: string;
  readinessInputSummary: string;
  previousSummary: string;
  topicSourceContext: string;
  modelSourceContext: string;
  invalidResponse: string;
  invalidReasons?: string[];
}) {
  const targetFile = input.studioPath === 'topic'
    ? input.targetFileName || (input.topicName ? `${input.topicName}.topic` : 'new_topic_candidate.topic')
    : input.targetFileName?.trim() || 'selected_target.view';
  const lane = input.studioPath === 'topic'
    ? 'Topic Builder'
    : input.studioPath === 'permissions'
      ? 'Permission Builder'
      : 'Model / View Builder';
  const permissionTargetFiles = input.studioPath === 'permissions' ? permissionPackageTargetFiles(targetFile) : [];
  const requiredResponseShape = input.studioPath === 'permissions'
    ? (permissionTargetFiles.length ? permissionTargetFiles : [targetFile]).map((fileName) => [
      `Target file: ${fileName}`,
      '```yaml',
      `<complete replacement YAML body for ${fileName}>`,
      '```',
    ].join('\n')).join('\n\n') + '\n\nAssumptions / validations\n- <max 5 bullets>'
    : input.studioPath === 'model'
    ? [
      `Target file: ${targetFile}`,
      '```yaml',
      `<complete replacement YAML body for ${targetFile}>`,
      '```',
      '',
      'Assumptions / validations',
      '- <max 5 bullets>',
    ].join('\n')
    : [
      '```yaml',
      '<complete topic file body>',
      '```',
      '',
      'Assumptions / validations',
      '- <max 5 bullets>',
    ].join('\n');

  const invalidReasonText = input.invalidReasons?.length
    ? `The previous Package response produced YAML, but it failed OmniKit package lint:\n${input.invalidReasons.map((reason) => `- ${reason}`).join('\n')}`
    : 'The previous Package response did not include a complete, valid deployable YAML block, so OmniKit captured 0 files.';

  return `${input.topicTitle} - AI Semantic Studio Package Repair
${TOPIC_AI_READINESS_ROLE}

${invalidReasonText}
Repair the output only. Do not redo the review.

Model: ${input.modelName} (${input.modelId})
Development path: ${lane}
Target file: ${targetFile}

${AI_PACKAGE_STAGE_CONTRACT}
${input.studioPath === 'model' || input.studioPath === 'permissions' ? SEMANTIC_FILE_TAXONOMY : 'Topic Builder creates one .topic file only.'}
${input.topicSourceContext}
${input.modelSourceContext}
${input.studioPath === 'permissions' ? PERMISSION_BUILDER_GUARDRAILS : ''}
${input.studioPath === 'permissions' ? PERMISSION_PACKAGE_EXACTNESS_GUARDRAILS : ''}
${PII_GOVERNANCE_GUARDRAILS}

Confirmed admin inputs:
${input.readinessInputSummary}

Prior review brief:
${input.previousSummary || 'None yet.'}

Required response shape:
${requiredResponseShape}

Rules:
- ${input.studioPath === 'permissions' ? `Return deployable YAML blocks for exactly these Permission Builder targets: ${(permissionTargetFiles.length ? permissionTargetFiles : [targetFile]).join(', ')}.` : `Return exactly one deployable YAML block for ${targetFile}.`}
- Do not return a heading before the deployable artifact.
- If this is a Topic Builder response, the first non-whitespace characters of the response must be \`\`\`yaml.
- If this is a Permission Builder response, the first non-whitespace line must be Target file: ${(permissionTargetFiles.length ? permissionTargetFiles : [targetFile])[0]}.
- Every YAML body must be inside a fenced \`\`\`yaml block.
- Do not write raw YAML outside the code fence.
- Do not return unrelated files.
- Do not return patch fragments.
- For existing topic or view updates, preserve the current source YAML from Omni API and change only the confirmed target-file sections.
- For new-topic candidates, put the suggested topic file name in assumptions/validations after the YAML block, not before it.
- If a topic join is unvalidated, do not include joins: or joined-view ai_fields/sample queries in deployable YAML. Put the candidate join in assumptions/validations.
- For Topic Builder repairs, do not include view-definition YAML in the topic file. Never write views.<view>.dimensions, views.<view>.measures, dimensions:, measures:, field labels, field context, values, synonyms, SQL, or measure definitions inside the topic YAML. Put that work in assumptions/validations as Model / View Builder follow-up.
- For Permission Builder repairs, return Settings/model plus the selected .topic or .view target when those are expected. Keep model grants in Settings/model, topic access_filters/required_access_grants in the topic, and view masking/grants in the view.
- If ${targetFile} is a .query.view, include the top-level query: or sql: section from the source file.
- Enforce the PII/RLS guardrails above. Do not include sensitive fields in topic ai_fields or sample queries unless explicitly confirmed. For model/view permission work, prefer enforceable access grants, access filters, user attributes / omni_attributes, or masked dimensions when the selected target supports them.
- Keep assumptions and validations outside the YAML block.
- Follow only this target-specific guidance:
${buildPackageYamlGuidance(input.studioPath, targetFile)}

Invalid previous response, for context only:
${input.invalidResponse.slice(0, 4000)}`;
}

function compactList(values: string[]) {
  return values.map(cleanGeneratedText).filter(Boolean);
}

function uniqueStrings(values: string[], maxItems = 12) {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (cleaned && !seen.has(cleaned.toLowerCase())) {
      seen.add(cleaned.toLowerCase());
      result.push(cleaned);
    }
  });
  return result.slice(0, maxItems);
}

function isSupportedYamlFileName(fileName: string): fileName is SupportedYamlFileName {
  const clean = fileName.trim();
  return clean === 'model' || clean === 'relationships' || clean.endsWith('.topic') || clean.endsWith('.view');
}

function topLevelKeyIndex(yaml: string, key: string) {
  return yaml.split('\n').findIndex((line) => new RegExp(`^${key}:\\s*`).test(line));
}

function sectionFieldNames(yaml: string, sectionName: string) {
  const lines = yaml.split('\n');
  const sectionIndex = lines.findIndex((line) => new RegExp(`^${escapeRegex(sectionName)}:\\s*$`).test(line));
  if (sectionIndex < 0) return [];
  const names: string[] = [];
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Za-z_][\w-]*:\s*/.test(line)) break;
    const match = line.match(/^\s{2}([A-Za-z_][\w.-]*):\s*$/);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

function topLevelListItems(yaml: string, key: string) {
  const block = extractTopLevelYamlBlock(yaml, key);
  if (!block) return [];

  const inlineMatch = block.match(new RegExp(`^${escapeRegex(key)}:\\s*\\[(.*)\\]\\s*$`, 'm'));
  if (inlineMatch?.[1]) {
    return inlineMatch[1]
      .split(',')
      .map((value) => value.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  return block
    .split('\n')
    .map((line) => line.match(/^\s*-\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/)?.[1] || '')
    .filter(Boolean);
}

function isLikelySensitiveAiField(fieldName: string) {
  const full = fieldName
    .replace(/\[[^\]]+\]$/, '')
    .toLowerCase();
  const clean = fieldName
    .replace(/\[[^\]]+\]$/, '')
    .split('.')
    .pop()
    ?.toLowerCase() || '';
  if (!clean || clean.includes('masked') || clean.includes('hash')) return false;
  if (clean === 'id') {
    return /(^|\.|_)(user|users|customer|customers|person|people|member|members|patient|patients|employee|employees|contact|contacts|account|accounts)(\.|_|$)/.test(full);
  }
  if (/^(user|customer|person|member|patient|employee|contact|account)_?id$/.test(clean)) return true;
  return [
    'email',
    'full_name',
    'first_name',
    'last_name',
    'phone',
    'phone_number',
    'address',
    'street',
    'street_address',
    'zip',
    'zipcode',
    'zip_code',
    'postal',
    'postal_code',
    'latitude',
    'longitude',
    'lat',
    'lon',
    'lng',
    'birth_date',
    'birthdate',
    'date_of_birth',
    'dob',
    'ssn',
    'social_security_number',
    'passport',
    'ip',
    'ip_address',
  ].includes(clean);
}

function isLikelyUnsafeTopicAiRoutingField(fieldName: string) {
  const full = fieldName
    .replace(/\[[^\]]+\]$/, '')
    .toLowerCase();
  const clean = full.split('.').pop() || '';
  if (!clean || clean.includes('masked') || clean.includes('hash')) return false;
  if (isLikelySensitiveAiField(fieldName)) return true;
  if (clean === 'id' || /_id$/.test(clean)) return true;
  return [
    'uri',
    'url',
    'path',
    'page_path',
    'referrer',
    'referer',
    'referrer_code',
    'referer_code',
  ].includes(clean);
}

function sampleQueryFieldSelectors(yaml: string) {
  const block = extractTopLevelYamlBlock(yaml, 'sample_queries');
  if (!block) return [];

  const selectors = new Set<string>();
  Array.from(block.matchAll(/["']([A-Za-z_][\w-]*\.[A-Za-z_][\w-]*(?:\[[^\]]+\])?)["']/g)).forEach((match) => {
    if (match[1]) selectors.add(match[1]);
  });
  Array.from(block.matchAll(/^\s*-\s*["']?([A-Za-z_][\w-]*\.[A-Za-z_][\w-]*(?:\[[^\]]+\])?)["']?\s*(?:#.*)?$/gm)).forEach((match) => {
    if (match[1]) selectors.add(match[1]);
  });
  return Array.from(selectors);
}

function topicBaseViewNameFromYaml(yaml: string) {
  return yaml.match(/^\s*base_view:\s*["']?([A-Za-z_][\w-]*)["']?\s*$/m)?.[1] || '';
}

function selectorViewName(selector: string) {
  return selector.replace(/\[[^\]]+\]$/, '').split('.')[0] || '';
}

function nonBaseTopicSelectors(yaml: string) {
  const baseView = topicBaseViewNameFromYaml(yaml);
  if (!baseView) return [];

  return uniqueStrings([
    ...topLevelListItems(yaml, 'ai_fields'),
    ...sampleQueryFieldSelectors(yaml),
  ].filter((selector) => {
    const viewName = selectorViewName(selector);
    return viewName && viewName !== baseView;
  }), 20);
}

function hasNonEmptyTopicJoinBlock(yaml: string) {
  const joinBlock = extractTopLevelYamlBlock(yaml, 'joins');
  if (!joinBlock.trim()) return false;
  return joinBlock
    .split('\n')
    .slice(1)
    .some((line) => line.trim() && !line.trim().startsWith('#'));
}

function sensitiveViewFieldMetadataNames(yaml: string) {
  return sectionFieldBlocks(yaml, 'dimensions')
    .filter((block) => isLikelySensitiveAiField(block.name))
    .filter((block) => /(^|\n)\s{4}(synonyms|ai_context):\s*/.test(block.body))
    .filter((block) => !/omni_attributes|masked/i.test(block.name) && !/omni_attributes/i.test(block.body))
    .map((block) => block.name);
}

function sectionFieldBlocks(yaml: string, sectionName: string) {
  const lines = yaml.split('\n');
  const sectionIndex = lines.findIndex((line) => new RegExp(`^${escapeRegex(sectionName)}:\\s*$`).test(line));
  if (sectionIndex < 0) return [];
  const blocks: Array<{ name: string; body: string }> = [];
  let current: { name: string; lines: string[] } | null = null;

  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Za-z_][\w-]*:\s*/.test(line)) break;
    const match = line.match(/^\s{2}([A-Za-z_][\w.-]*):\s*$/);
    if (match?.[1]) {
      if (current) blocks.push({ name: current.name, body: current.lines.join('\n') });
      current = { name: match[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }

  if (current) blocks.push({ name: current.name, body: current.lines.join('\n') });
  return blocks;
}

function circularMeasureReferenceNames(yaml: string) {
  return sectionFieldBlocks(yaml, 'measures')
    .filter((block) => new RegExp(`^\\s{4}sql:\\s*\\$\\{${escapeRegex(block.name)}\\}\\s*$`, 'm').test(block.body))
    .map((block) => block.name);
}

function unsupportedViewFieldMetadataPaths(yaml: string) {
  const unsupportedKeys = ['values'];
  return ['dimensions', 'measures'].flatMap((sectionName) => sectionFieldBlocks(yaml, sectionName)
    .flatMap((block) => unsupportedKeys
      .filter((key) => new RegExp(`(^|\\n)\\s{4}${escapeRegex(key)}:\\s*`, 'm').test(block.body))
      .map((key) => `${sectionName}.${block.name}.${key}`)));
}

function missingViewFieldPaths(sourceYaml: string, draftYaml: string) {
  if (!sourceYaml.trim() || !draftYaml.trim()) return [];
  return ['dimensions', 'measures'].flatMap((sectionName) => {
    const draftNames = new Set(sectionFieldNames(draftYaml, sectionName));
    return sectionFieldNames(sourceYaml, sectionName)
      .filter((name) => !draftNames.has(name))
      .map((name) => `${sectionName}.${name}`);
  });
}

function isViewFieldRemovalConfirmed(fieldPath: string, confirmedInputText = '') {
  const fieldName = fieldPath.split('.').pop() || fieldPath;
  const confirmed = confirmedInputText.toLowerCase();
  if (!confirmed) return false;
  const escapedField = escapeRegex(fieldName.toLowerCase());
  return new RegExp(`\\b(remove|delete|drop)\\b[\\s\\S]{0,120}\\b${escapedField}\\b|\\b${escapedField}\\b[\\s\\S]{0,120}\\b(remove|delete|drop)\\b`).test(confirmed);
}

function viewFieldPreservationLintIssues(file: DeployFileDraft, sourceYaml: string, confirmedInputText = '') {
  if (!file.fileName.endsWith('.view') || !sourceYaml.trim()) return [];
  const missingFields = missingViewFieldPaths(sourceYaml, file.yaml)
    .filter((fieldPath) => !isViewFieldRemovalConfirmed(fieldPath, confirmedInputText));
  if (missingFields.length === 0) return [];
  return [
    `${file.fileName} drops existing view fields from the source YAML: ${missingFields.join(', ')}. Preserve existing dimensions/measures and use hidden: true or metadata edits instead unless the admin explicitly confirmed deletion by field name.`,
  ];
}

function sourceTargetYamlFromContext(sourceContext = '') {
  if (!sourceContext.includes('Current target file YAML')) return '';
  const match = sourceContext.match(/Current target file YAML[\s\S]*?```yaml\n([\s\S]*?)\n```/);
  const yaml = match?.[1]?.trim() || '';
  if (!yaml || yaml.includes('# ... truncated by OmniKit')) return '';
  return yaml;
}

function validateDeployYamlFile(file: DeployFileDraft) {
  const fileName = file.fileName.trim();
  const yaml = file.yaml.trim();
  const issues: string[] = [];

  if (!yaml) return [`YAML is empty for ${fileName}.`];
  if (!isSupportedYamlFileName(fileName)) {
    return [`Unsupported file name "${fileName}". Use model, relationships, <name>.topic, or <name>.view.`];
  }

  if (fileName.endsWith('.topic')) {
    if (file.source !== 'permission-builder' && !/^\s*base_view:\s*\S+/m.test(yaml)) issues.push(`${fileName} must include base_view.`);
    if (fileName === 'new_topic_candidate.topic') {
      issues.push('Replace the generic new_topic_candidate.topic file name with the reviewed topic file name before saving.');
    }
    if (/^\s*topics:\s*/m.test(yaml) || /^\s*name:\s*/m.test(yaml)) {
      issues.push(`${fileName} should be a single topic file body without topics: or name:.`);
    }
    if (hasTopLevelYamlKey(yaml, ['dimensions', 'measures', 'schema', 'schema_label', 'table_name', 'query', 'sql', 'extends'])) {
      issues.push(`${fileName} contains view-file keys. Keep dimensions, measures, schema, query, and sql changes in Model / View Builder artifacts, not topic YAML.`);
    }
    const topicViewsBlock = extractTopLevelYamlBlock(yaml, 'views');
    if (/^\s{4}(dimensions|measures):\s*/m.test(topicViewsBlock)) {
      issues.push(`${fileName} contains view-level dimensions/measures inside views:. Move field labels, context, values, synonyms, and measure definitions to Model / View Builder; Topic Builder must only stage valid topic YAML.`);
    }
    if (hasTopLevelYamlKey(yaml, ['default_cache_policy', 'cache_policies', 'ignored_schemas', 'ignored_views', 'access_grants', 'user_attributes', 'week_start_day', 'fiscal_month_offset'])) {
      issues.push(`${fileName} contains Settings/model keys. Keep global model configuration in Target file: model.`);
    }
    if (/^\s*relationships:\s*$/m.test(yaml) || /^\s*-\s*join_from_view:\s*/m.test(normalizeModelViewYaml(yaml))) {
      issues.push(`${fileName} contains Settings/relationships entries. Use topic joins: for topic-scoped paths or Target file: relationships for reusable relationship definitions.`);
    }
    const defaultFiltersBlock = extractTopLevelYamlBlock(yaml, 'default_filters') || '';
    if (/^\s{4}(equal|not_equal|greater_than|less_than|greater_than_or_equal_to|less_than_or_equal_to):\s*/m.test(defaultFiltersBlock)) {
      issues.push(`${fileName} has likely invalid default_filters operators. Preserve source filter syntax exactly or use Omni topic filter specs such as time_for_duration; do not invent equal/greater_than-style operators.`);
    }
    const unsafeAiFields = topLevelListItems(yaml, 'ai_fields').filter(isLikelyUnsafeTopicAiRoutingField);
    if (unsafeAiFields.length > 0) {
      issues.push(`${fileName} includes likely sensitive, raw identifier, URL, or debug fields in ai_fields: ${unsafeAiFields.join(', ')}. Omit them from AI routing unless the admin explicitly confirmed lookup/display as a supported use case.`);
    }
    const unsafeSampleQueryFields = sampleQueryFieldSelectors(yaml).filter(isLikelyUnsafeTopicAiRoutingField);
    if (unsafeSampleQueryFields.length > 0) {
      issues.push(`${fileName} includes likely sensitive, raw identifier, URL, or debug fields in sample_queries: ${unsafeSampleQueryFields.join(', ')}. Use governed/masked fields or remove those examples unless the admin explicitly confirmed lookup/display as a supported use case.`);
    }
    const aiContextIndex = topLevelKeyIndex(yaml, 'ai_context');
    if (aiContextIndex >= 0) {
      const keysAfterAiContext = yaml
        .split('\n')
        .slice(aiContextIndex + 1)
        .filter((line) => /^[a-zA-Z_][\w-]*:\s*/.test(line));
      if (keysAfterAiContext.length > 0) issues.push(`${fileName} must keep ai_context as the final top-level key.`);
    }
  }

  if (fileName === 'relationships') {
    if (/^\s*relationships:\s*$/m.test(yaml)) issues.push('relationships must be a top-level list, not wrapped in relationships:.');
    if (!/^\s*-\s*join_from_view:\s*/m.test(normalizeModelViewYaml(yaml))) {
      issues.push('relationships must contain join objects with join_from_view.');
    }
  }

  if (fileName.endsWith('.view')) {
    if (hasTopLevelYamlKey(yaml, ['base_view', 'joins', 'ai_fields', 'sample_queries'])) {
      issues.push(`${fileName} contains topic-only keys. Use Topic Builder for base_view, topic joins, ai_fields, and sample_queries.`);
    }
    if (hasTopLevelYamlKey(yaml, ['synonyms'])) {
      issues.push(`${fileName} contains top-level synonyms. Put synonyms under dimensions or measures instead.`);
    }
    const dimensionNames = sectionFieldNames(yaml, 'dimensions');
    const measureNames = sectionFieldNames(yaml, 'measures');
    const duplicateFieldNames = dimensionNames.filter((name) => measureNames.includes(name));
    if (duplicateFieldNames.length > 0) {
      issues.push(`${fileName} has duplicate field names in dimensions and measures: ${duplicateFieldNames.join(', ')}. Field names must be unique; keep the source dimension hidden and use a distinct measure key such as <field_name>_sum.`);
    }
    const circularMeasureNames = circularMeasureReferenceNames(yaml);
    if (circularMeasureNames.length > 0) {
      issues.push(`${fileName} has circular measure SQL references: ${circularMeasureNames.join(', ')}. A measure cannot use sql: \${same_measure_name}; reference a distinct source dimension instead.`);
    }
    const unsupportedFieldMetadata = unsupportedViewFieldMetadataPaths(yaml);
    if (unsupportedFieldMetadata.length > 0) {
      issues.push(`${fileName} contains unsupported .view field metadata: ${unsupportedFieldMetadata.join(', ')}. Do not use values: under dimensions or measures; put known enum values in description or assumptions/validations instead.`);
    }
    const sensitiveMetadataNames = sensitiveViewFieldMetadataNames(yaml);
    if (sensitiveMetadataNames.length > 0) {
      issues.push(`${fileName} adds AI-routing metadata to likely raw PII fields: ${sensitiveMetadataNames.join(', ')}. Remove synonyms/ai_context from raw PII fields or route through a masked/governed field using omni_attributes.`);
    }
    if (hasTopLevelYamlKey(yaml, ['default_cache_policy', 'cache_policies', 'ignored_schemas', 'ignored_views', 'access_grants', 'access_filters', 'user_attributes', 'week_start_day', 'fiscal_month_offset'])) {
      issues.push(`${fileName} contains Settings/model keys. Use Target file: model for global model configuration.`);
    }
    if (/^\s*-\s*join_from_view:\s*/m.test(normalizeModelViewYaml(yaml))) {
      issues.push(`${fileName} contains Settings/relationships entries. Use Target file: relationships for reusable join definitions.`);
    }
    if (!hasTopLevelYamlKey(yaml, ['query', 'sql', 'schema', 'table_name', 'extends'])) {
      issues.push(`${fileName} looks like a patch fragment. Return the complete view file body, preserving query/sql or schema/table_name source sections.`);
    }
    if (fileName.endsWith('.query.view') && !hasTopLevelYamlKey(yaml, ['query', 'sql'])) {
      issues.push(`${fileName} is a query view and must include the source query: or sql: section.`);
    }
    const viewStem = fileName
      .split('/')
      .pop()
      ?.replace(/\.query\.view$/i, '')
      .replace(/\.view$/i, '');
    if (viewStem && new RegExp(`\\$\\{${viewStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`).test(yaml)) {
      issues.push(`${fileName} references same-view fields with a view prefix. Inside a view file, use \${field_name} instead of \${${viewStem}.field_name}.`);
    }
  }

  if (fileName === 'model') {
    if (hasTopLevelYamlKey(yaml, ['base_view', 'joins', 'ai_fields', 'sample_queries', 'dimensions', 'measures', 'schema_label', 'schema', 'table_name', 'query', 'sql', 'extends'])) {
      issues.push('model must contain only Settings/model configuration, not topic, view, dimension, or measure definitions.');
    }
    if (/^\s*-\s*join_from_view:\s*/m.test(normalizeModelViewYaml(yaml))) {
      issues.push('model must not contain Settings/relationships entries. Use Target file: relationships for reusable join definitions.');
    }
  }

  return issues;
}

function packageDeployFilesFromMessage(options: {
  message: string;
  workflowPath: StudioPath;
  packageScopeName: string;
  packageViewName: string;
  targetFileName?: string;
  topicName?: string;
}) {
  if (pathUsesTargetSemanticFile(options.workflowPath)) {
    const allowedTargetFiles = expectedPackageTargetFiles(options.workflowPath, options.targetFileName);
    return extractViewModelYamlDrafts(
      options.message,
      options.packageScopeName,
      options.packageViewName,
      options.targetFileName || '',
      allowedTargetFiles
    )
      .filter((draft) => draft.targetFileName)
      .map((draft) => normalizeDeployFile({
        id: makeId('package-lint-file'),
        fileName: draft.targetFileName || 'selected_target.view',
        yaml: draft.content,
        source: options.workflowPath === 'permissions' ? 'permission-builder' : 'view-model-builder',
      }));
  }

  const planSummary = extractPlanSummary(options.message);
  return extractYamlDrafts(options.message, 'final-yaml').map((draft) => {
    const topicName = topicNameStem(
      options.topicName ||
      inferTopicNameFromTopicYaml(draft.content) ||
      planSummary.topicName ||
      options.packageScopeName ||
      'new_topic_candidate'
    );
    return normalizeDeployFile({
      id: makeId('package-lint-topic'),
      fileName: `${topicName || 'new_topic_candidate'}.topic`,
      yaml: draft.content,
      source: 'topic-builder',
    });
  });
}

function permissionExactnessLintIssues(files: DeployFileDraft[], confirmedInputText = '', sourceContext = '') {
  const issues: string[] = [];
  const confirmed = confirmedInputText.toLowerCase();
  const source = sourceContext.toLowerCase();
  const modelFile = files.find((file) => file.fileName.trim() === 'model');
  if (!modelFile) return issues;

  const modelYaml = modelFile.yaml;
  const accessGrantsBlock = extractTopLevelYamlBlock(modelYaml, 'access_grants');
  const userAttributesBlock = extractTopLevelYamlBlock(modelYaml, 'user_attributes');
  const sourceHadUserAttributes = /^\s*user_attributes:\s*/m.test(source);
  const sourceHadDefaultValues = /^\s*default_value:\s*/m.test(source);
  const confirmedExactUserAttributesYaml = /\buser_attributes\s*:/.test(confirmed);
  const confirmedExactDefaultValueYaml = /\bdefault_value\s*:/.test(confirmed);

  if (userAttributesBlock && !sourceHadUserAttributes && !confirmedExactUserAttributesYaml) {
    issues.push('Permission Builder model package added a user_attributes: block that was not present in the source Settings/model YAML and was not explicitly confirmed as exact model YAML. Reference confirmed user attributes in access_grants, and list provisioning/defaults in assumptions instead.');
  }

  if (/^\s*default_value:\s*/m.test(userAttributesBlock) && !sourceHadDefaultValues && !confirmedExactDefaultValueYaml) {
    issues.push('Permission Builder model package added default_value entries without exact confirmed YAML syntax. Do not invent permission-driving defaults; list null/default behavior in assumptions unless the admin provided the exact Settings/model user_attributes YAML.');
  }

  if (confirmed.includes('omni_user_groups') && /user_attribute:\s*(transactions_access|can_see_pii)\b/i.test(accessGrantsBlock)) {
    issues.push('Permission Builder package ignored the confirmed omni_user_groups user_attribute and converted a group-based grant into a boolean grant attribute. Preserve the exact confirmed user_attribute reference and allowed_values, or leave the grant out with a validation note.');
  }

  if (/allowed_values:\s*\n\s*-\s*["']?true["']?/i.test(accessGrantsBlock) && !/allowed_values?[^\n]*(true|"true"|'true')|["']true["']/.test(confirmed)) {
    issues.push('Permission Builder package invented boolean allowed_values for access_grants. Use only explicitly confirmed allowed_values, such as named groups, or omit the grant and list the missing values in assumptions.');
  }

  return issues;
}

function packageLintIssuesFromMessage(options: {
  message: string;
  workflowPath: StudioPath;
  packageScopeName: string;
  packageViewName: string;
  targetFileName?: string;
  topicName?: string;
  readinessInputSummary?: string;
  sourceContext?: string;
}) {
  const files = packageDeployFilesFromMessage(options);
  const issues = files.flatMap(validateDeployYamlFile);
  if (options.workflowPath === 'model') {
    const sourceTargetYaml = sourceTargetYamlFromContext(options.sourceContext);
    files
      .filter((file) => file.fileName.endsWith('.view'))
      .forEach((file) => {
        issues.push(...viewFieldPreservationLintIssues(file, sourceTargetYaml, options.readinessInputSummary));
      });
  }
  if (options.workflowPath === 'permissions') {
    issues.push(...permissionExactnessLintIssues(files, options.readinessInputSummary, options.sourceContext));
    const expectedTargets = expectedPackageTargetFiles(options.workflowPath, options.targetFileName);
    const capturedTargets = new Set(files.map((file) => file.fileName.trim()));
    expectedTargets
      .filter((targetFileName) => !capturedTargets.has(targetFileName))
      .forEach((targetFileName) => {
        issues.push(`Permission Builder package is missing expected target file ${targetFileName}. RLS/access grants must be staged in Settings/model plus the selected permission target when applicable.`);
      });
  }
  if (options.workflowPath === 'topic' && !options.topicName) {
    files
      .filter((file) => file.fileName.endsWith('.topic'))
      .forEach((file) => {
        const joinedSelectors = nonBaseTopicSelectors(file.yaml);
        if (joinedSelectors.length > 0) {
          issues.push(`${file.fileName} is a new-topic candidate with joined-view fields in ai_fields or sample_queries: ${joinedSelectors.join(', ')}. Remove them until the join path validates, or create/confirm the relationship in a separate workflow first.`);
        }
        if (hasNonEmptyTopicJoinBlock(file.yaml)) {
          issues.push(`${file.fileName} is a new-topic candidate with topic joins. Keep unvalidated joins out of deployable topic YAML and list candidate joins in assumptions/validations until the relationship path is confirmed.`);
        }
      });
  }
  return uniqueStrings(issues, 12);
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
	    .slice(0, 48) || 'omnikit';
}

function timestampForBranch() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function buildBranchName(topicName: string) {
  return `Omnikit-${slugify(topicName || 'model')}-${timestampForBranch()}`;
}

function normalizeBranchNamePrefix(branchName: string) {
  return branchName.trim().replace(/^semantic-studio-/i, 'Omnikit-');
}

function pathIncludesTopic(path: StudioPathSelection) {
  return path === 'topic';
}

function pathIncludesModel(path: StudioPathSelection) {
  return path === 'model';
}

function pathIncludesPermissions(path: StudioPathSelection) {
  return path === 'permissions';
}

function pathUsesTargetSemanticFile(path: StudioPathSelection) {
  return path === 'model' || path === 'permissions';
}

function targetFileTypeLabel(fileName: string) {
  if (fileName === 'model') return 'Settings/model';
  if (fileName === 'relationships') return 'Settings/relationships';
  if (fileName.endsWith('.topic')) return '.topic';
  if (fileName.endsWith('.view')) return '.view';
  return 'Target file';
}

function permissionPackageTargetFiles(targetFileName?: string) {
  const target = cleanDeployTargetFileName(targetFileName || '');
  if (!target) return [];
  if (target === 'model') return ['model'];
  if (target.endsWith('.topic') || target.endsWith('.view')) return ['model', target];
  return [target];
}

function expectedPackageTargetFiles(workflowPath: StudioPathSelection, targetFileName?: string) {
  const target = cleanDeployTargetFileName(targetFileName || '');
  if (pathIncludesPermissions(workflowPath)) return permissionPackageTargetFiles(target);
  if (pathUsesTargetSemanticFile(workflowPath)) return target ? [target] : [];
  return [];
}

function topicDetailKey(topicName: string, modelId?: string) {
  return `${modelId || 'unknown-model'}:${topicName}`;
}

function splitDiffLines(value: string) {
  if (!value) return [];
  return value.replace(/\n$/, '').split('\n');
}

function buildLineDiffRows(before: string, after: string): DeployDiffRow[] {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  const lcs = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0) as number[]);

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lcs[beforeIndex][afterIndex] = beforeLines[beforeIndex] === afterLines[afterIndex]
        ? lcs[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(lcs[beforeIndex + 1][afterIndex], lcs[beforeIndex][afterIndex + 1]);
    }
  }

  const rows: DeployDiffRow[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let beforeLine = 1;
  let afterLine = 1;

  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (beforeIndex < beforeLines.length && afterIndex < afterLines.length && beforeLines[beforeIndex] === afterLines[afterIndex]) {
      rows.push({
        type: 'same',
        beforeLine,
        afterLine,
        text: beforeLines[beforeIndex],
      });
      beforeIndex += 1;
      afterIndex += 1;
      beforeLine += 1;
      afterLine += 1;
    } else if (afterIndex < afterLines.length && (beforeIndex === beforeLines.length || lcs[beforeIndex][afterIndex + 1] >= lcs[beforeIndex + 1][afterIndex])) {
      rows.push({
        type: 'added',
        afterLine,
        text: afterLines[afterIndex],
      });
      afterIndex += 1;
      afterLine += 1;
    } else if (beforeIndex < beforeLines.length) {
      rows.push({
        type: 'removed',
        beforeLine,
        text: beforeLines[beforeIndex],
      });
      beforeIndex += 1;
      beforeLine += 1;
    }
  }

  return rows;
}

function buildDeployDiffs(mainYaml: OmniModelYamlResponse | null, devYaml: OmniModelYamlResponse | null, files: DeployFileDraft[]): DeployDiff[] {
  return files.map((file) => {
    const before = mainYaml?.files?.[file.fileName] || '';
    const after = devYaml?.files?.[file.fileName] || file.yaml;
    const rows = buildLineDiffRows(before, after);
    const added = rows.filter((row) => row.type === 'added').length;
    const removed = rows.filter((row) => row.type === 'removed').length;
    return {
      fileName: file.fileName,
      added,
      removed,
      beforeLength: before.length,
      afterLength: after.length,
      before,
      after,
      rows,
    };
  });
}

function quoteYamlFlowArrayItems(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const unquoted = item.replace(/^["']|["']$/g, '');
      return `"${unquoted.replace(/"/g, '\\"')}"`;
    })
    .join(', ');
}

function normalizeTopicYamlForDeploy(yaml: string) {
  const lines = yaml.split('\n');
  const normalizedLines = lines.flatMap((line) => {
    const fieldsMatch = line.match(/^(\s*fields:\s*)\[(.*)\]\s*$/);
    if (fieldsMatch) {
      return [`${fieldsMatch[1]}[${quoteYamlFlowArrayItems(fieldsMatch[2])}]`];
    }

    const sortMatch = line.match(/^(\s*)sorts:\s*\[\{\s*column_name:\s*([^,}]+),\s*sort_descending:\s*(true|false)\s*\}\]\s*$/i);
    if (sortMatch) {
      const indent = sortMatch[1];
      const field = sortMatch[2].trim().replace(/^["']|["']$/g, '');
      const desc = sortMatch[3].toLowerCase();
      return [
        `${indent}sorts:`,
        `${indent}  - field: "${field}"`,
        `${indent}    desc: ${desc}`,
      ];
    }

    return [line];
  });

  return normalizedLines.join('\n');
}

function cleanYamlScalar(value: string) {
  return value.trim().replace(/^["']|["']$/g, '');
}

function quoteYamlString(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function splitSynonymString(value: string) {
  return cleanYamlScalar(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSynonymsForDeploy(yaml: string) {
  const lines = yaml.split('\n');
  const normalizedLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const flowMatch = line.match(/^(\s*)synonyms:\s*\[(.*)\]\s*$/);
    if (flowMatch) {
      const synonyms = flowMatch[2]
        .split(',')
        .map(cleanYamlScalar)
        .filter(Boolean);
      normalizedLines.push(`${flowMatch[1]}synonyms:`);
      synonyms.forEach((synonym) => normalizedLines.push(`${flowMatch[1]}  - ${quoteYamlString(synonym)}`));
      continue;
    }

    const stringMatch = line.match(/^(\s*)synonyms:\s*(["'].+["']|[^#\n]+)\s*$/);
    if (stringMatch) {
      const synonyms = splitSynonymString(stringMatch[2]);
      normalizedLines.push(`${stringMatch[1]}synonyms:`);
      synonyms.forEach((synonym) => normalizedLines.push(`${stringMatch[1]}  - ${quoteYamlString(synonym)}`));
      continue;
    }

    const blockMatch = line.match(/^(\s*)synonyms:\s*$/);
    if (!blockMatch) {
      normalizedLines.push(line);
      continue;
    }

    const synonyms: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const itemMatch = lines[cursor].match(/^(\s*)-\s*(.+?)\s*$/);
      if (!itemMatch || itemMatch[1].length <= blockMatch[1].length) break;
      synonyms.push(cleanYamlScalar(itemMatch[2]));
      cursor += 1;
    }

    if (!synonyms.length) {
      normalizedLines.push(line);
      continue;
    }

    normalizedLines.push(`${blockMatch[1]}synonyms:`);
    synonyms.forEach((synonym) => normalizedLines.push(`${blockMatch[1]}  - ${quoteYamlString(synonym)}`));
    index = cursor - 1;
  }

  return normalizedLines.join('\n');
}

function normalizeDeployFile(file: DeployFileDraft): DeployFileDraft {
  const yaml = normalizeSynonymsForDeploy(file.yaml);
  if (!file.fileName.trim().endsWith('.topic')) {
    return {
      ...file,
      yaml,
    };
  }
  return {
    ...file,
    yaml: normalizeTopicYamlForDeploy(yaml),
  };
}

function formatErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    return error.detail ? `${error.message}\n${error.detail}` : error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

function isMissingBranchError(error: unknown) {
  if (error instanceof ApiError && error.status === 404) return true;
  const message = formatErrorMessage(error, '').toLowerCase();
  return message.includes('branch does not exist') || message.includes('branch not found');
}

function normalizeContentIssueSignature(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isPermissionPrerequisiteIssue(value: string) {
  const normalized = normalizeContentIssueSignature(value);
  return (
    normalized.includes('no such user attribute') ||
    normalized.includes('unknown user attribute') ||
    normalized.includes('missing user attribute') ||
    normalized.includes('undefined user attribute') ||
    normalized.includes('user attribute does not exist') ||
    normalized.includes('user attribute not found') ||
    normalized.includes('no such access grant') ||
    normalized.includes('unknown access grant') ||
    normalized.includes('missing access grant') ||
    normalized.includes('undefined access grant') ||
    normalized.includes('access grant does not exist') ||
    normalized.includes('access grant not found') ||
    /user attribute .+ (does not exist|not found|is not defined|cannot be found)/.test(normalized) ||
    /access grant .+ (does not exist|not found|is not defined|cannot be found)/.test(normalized)
  );
}

function extractContentValidationIssues(validation: Record<string, unknown> | null) {
  const issues: Array<{ signature: string; label: string }> = [];
  if (!validation || validation.error) return issues;

  const content = Array.isArray(validation.content) ? validation.content : [];
  content.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const document = item as Record<string, unknown>;
    const documentName = typeof document.name === 'string' && document.name.trim() ? document.name.trim() : 'Untitled content';

    const dashboardFilterIssues = Array.isArray(document.dashboard_filter_issues) ? document.dashboard_filter_issues : [];
    dashboardFilterIssues.forEach((filterIssue) => {
      if (!filterIssue || typeof filterIssue !== 'object') return;
      const issueRecord = filterIssue as Record<string, unknown>;
      const filterName =
        readFirstString(issueRecord, ['filter_name', 'filterName', 'name']) ||
        readFirstString(issueRecord, ['field', 'field_name', 'fieldName']) ||
        'Dashboard filter';
      const messages = Array.isArray(issueRecord.issues)
        ? issueRecord.issues.filter((issue): issue is string => typeof issue === 'string' && Boolean(issue.trim()))
        : [];
      messages.forEach((message) => {
        const label = `${documentName} / ${filterName}: ${message}`;
        issues.push({ label, signature: normalizeContentIssueSignature(label) });
      });
    });

    const queryIssues = Array.isArray(document.queries_and_issues) ? document.queries_and_issues : [];
    queryIssues.forEach((queryIssue) => {
      if (!queryIssue || typeof queryIssue !== 'object') return;
      const query = queryIssue as Record<string, unknown>;
      const queryName = typeof query.query_name === 'string' && query.query_name.trim() ? query.query_name.trim() : 'Query';
      const messages = Array.isArray(query.issues)
        ? query.issues.filter((issue): issue is string => typeof issue === 'string' && Boolean(issue.trim()))
        : [];
      messages.forEach((message) => {
        const label = `${documentName} / ${queryName}: ${message}`;
        issues.push({ label, signature: normalizeContentIssueSignature(label) });
      });
    });
  });

  return issues;
}

function extractNewPermissionPrerequisiteIssues(
  validation: Record<string, unknown> | null,
  baselineValidation: Record<string, unknown> | null = null
) {
  if (!validation || validation.error) return [];

  const baselineSignatures = new Set(extractContentValidationIssues(baselineValidation).map((issue) => issue.signature));
  const seen = new Set<string>();
  const issues: string[] = [];

  extractContentValidationIssues(validation).forEach((issue) => {
    if (baselineSignatures.has(issue.signature) || seen.has(issue.signature)) return;
    if (!isPermissionPrerequisiteIssue(issue.label)) return;
    seen.add(issue.signature);
    issues.push(issue.label);
  });

  return issues;
}

function summarizeContentValidation(
  validation: Record<string, unknown> | null,
  baselineValidation: Record<string, unknown> | null = null
): ContentValidationSummary | null {
  if (!validation) return null;

  if (validation.error) {
    return {
      contentDocuments: 0,
      documentsWithIssues: 0,
      newIssueCount: 0,
      newDocumentsWithIssues: 0,
      existingIssueCount: 0,
      dashboardFilterIssueCount: 0,
      queryIssueCount: 0,
      sampleIssues: [],
      sampleNewIssues: [],
      sampleExistingIssues: [],
      errorMessage: typeof validation.message === 'string' ? validation.message : 'Content validation failed.',
    };
  }

  const baselineSignatures = new Set(extractContentValidationIssues(baselineValidation).map((issue) => issue.signature));
  const content = Array.isArray(validation.content) ? validation.content : [];
  let documentsWithIssues = 0;
  let newDocumentsWithIssues = 0;
  let dashboardFilterIssueCount = 0;
  let queryIssueCount = 0;
  let newIssueCount = 0;
  let existingIssueCount = 0;
  const sampleIssues: string[] = [];
  const sampleNewIssues: string[] = [];
  const sampleExistingIssues: string[] = [];

  content.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const document = item as Record<string, unknown>;
    const documentName = typeof document.name === 'string' && document.name.trim() ? document.name.trim() : 'Untitled content';
    let hasIssue = false;
    let hasNewIssue = false;

    const dashboardFilterIssues = Array.isArray(document.dashboard_filter_issues) ? document.dashboard_filter_issues : [];
    dashboardFilterIssues.forEach((filterIssue) => {
      if (!filterIssue || typeof filterIssue !== 'object') return;
      const issueRecord = filterIssue as Record<string, unknown>;
      const filterName =
        readFirstString(issueRecord, ['filter_name', 'filterName', 'name']) ||
        readFirstString(issueRecord, ['field', 'field_name', 'fieldName']) ||
        'Dashboard filter';
      const issues = Array.isArray((filterIssue as Record<string, unknown>).issues)
        ? ((filterIssue as Record<string, unknown>).issues as unknown[]).filter((issue): issue is string => typeof issue === 'string' && Boolean(issue.trim()))
        : [];
      dashboardFilterIssueCount += issues.length;
      issues.forEach((issue) => {
        hasIssue = true;
        const label = `${documentName} / ${filterName}: ${issue}`;
        const isExisting = baselineSignatures.has(normalizeContentIssueSignature(label));
        if (isExisting) {
          existingIssueCount += 1;
          if (sampleExistingIssues.length < 5) sampleExistingIssues.push(label);
        } else {
          newIssueCount += 1;
          hasNewIssue = true;
          if (sampleNewIssues.length < 5) sampleNewIssues.push(label);
        }
        if (sampleIssues.length < 5) sampleIssues.push(label);
      });
    });

    const queryIssues = Array.isArray(document.queries_and_issues) ? document.queries_and_issues : [];
    queryIssues.forEach((queryIssue) => {
      if (!queryIssue || typeof queryIssue !== 'object') return;
      const query = queryIssue as Record<string, unknown>;
      const queryName = typeof query.query_name === 'string' && query.query_name.trim() ? query.query_name.trim() : 'Query';
      const issues = Array.isArray(query.issues)
        ? query.issues.filter((issue): issue is string => typeof issue === 'string' && Boolean(issue.trim()))
        : [];
      queryIssueCount += issues.length;
      issues.forEach((issue) => {
        hasIssue = true;
        const label = `${documentName} / ${queryName}: ${issue}`;
        const isExisting = baselineSignatures.has(normalizeContentIssueSignature(label));
        if (isExisting) {
          existingIssueCount += 1;
          if (sampleExistingIssues.length < 5) sampleExistingIssues.push(label);
        } else {
          newIssueCount += 1;
          hasNewIssue = true;
          if (sampleNewIssues.length < 5) sampleNewIssues.push(label);
        }
        if (sampleIssues.length < 5) sampleIssues.push(label);
      });
    });

    if (hasIssue) documentsWithIssues += 1;
    if (hasNewIssue) newDocumentsWithIssues += 1;
  });

  return {
    contentDocuments: content.length,
    documentsWithIssues,
    newIssueCount,
    newDocumentsWithIssues,
    existingIssueCount,
    dashboardFilterIssueCount,
    queryIssueCount,
    sampleIssues,
    sampleNewIssues,
    sampleExistingIssues,
  };
}

function formatListWithInputs(values: string[], inputs: string[]) {
  const items = compactList(values);
  if (!items.length) return ['- None confirmed yet'];

  return items.flatMap((item, index) => {
    const input = inputs[index]?.trim();
    return input ? [`- ${item}`, `  Admin input: ${input}`] : [`- ${item}`];
  });
}

function formatReadinessInputs(inputs: ReadinessInputs, scopeNoun = 'topic') {
  const sections = [
    [`Confirmed questions this ${scopeNoun} should answer`, formatListWithInputs(inputs.questions, inputs.questionInputs)],
    ['Confirmed business use cases', formatListWithInputs(inputs.useCases, inputs.useCaseInputs)],
    ['Confirmed business rules / filters', compactList(inputs.businessRules)],
    ['Confirmed gaps to address', compactList(inputs.gaps)],
    ['Confirmed out-of-scope questions', compactList(inputs.outOfScope)],
  ];

  const lines = sections.flatMap(([label, values]) => {
    const items = values as string[];
    return [`${label}:`, ...(items.length ? items.map((item) => (item.startsWith('-') || item.startsWith('  ') ? item : `- ${item}`)) : ['- None confirmed yet'])];
  });

  if (inputs.notes.trim()) {
    lines.push('Admin notes:', inputs.notes.trim());
  }

  return lines.join('\n');
}

function extractBalancedJsonCandidates(content: string) {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function scoreParsedJsonCandidate(value: unknown) {
  const record = asRecord(value);
  if (!record) return -100;

  const highSignalKeys = [
    'topic',
    'targetView',
    'target_view',
    'verdict',
    'confidence',
    'questions',
    'useCases',
    'use_cases',
    'businessUseCases',
    'business_use_cases',
    'businessRules',
    'business_rules',
    'clarifyingQuestions',
    'clarifying_questions',
    'gaps',
    'outOfScope',
    'out_of_scope',
    'fieldIssues',
    'field_issues',
    'measureRecommendations',
    'measure_recommendations',
    'targetFileNotes',
    'target_file_notes',
    'separateWorkflowNotes',
    'separate_workflow_notes',
    'validationQuestions',
    'validation_questions',
    'routingRules',
    'routing_rules',
    'negativeRouting',
    'negative_routing',
    'synonyms',
    'aiContextOpportunities',
    'ai_context_opportunities',
    'targetFilePlan',
    'target_file_plan',
    'recommendations',
  ];

  let score = 0;
  highSignalKeys.forEach((key) => {
    if (record[key] !== undefined) score += 5;
    if (Array.isArray(record[key]) && (record[key] as unknown[]).length) score += 3;
  });

  const serialized = JSON.stringify(record).toLowerCase();
  if (/selected_topic_name_or_not_applicable|target_view_or_base_view|short readiness verdict|3-5 business questions|term1|optional concise yaml/i.test(serialized)) {
    score -= 40;
  }
  score += Math.min(serialized.length / 2000, 5);
  return score;
}

function tryParseJsonBlock(content: string): unknown | null {
  const fencedBlocks = Array.from(content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
    .map((match) => match[1]?.trim())
    .filter(Boolean) as string[];
  const candidates = uniqueNonEmpty([
    ...fencedBlocks.reverse(),
    ...extractBalancedJsonCandidates(content).reverse(),
    content.trim(),
  ], 40);

  const parsedCandidates: unknown[] = [];
  for (const candidate of candidates) {
    try {
      parsedCandidates.push(JSON.parse(candidate));
      continue;
    } catch {
      const firstBrace = candidate.indexOf('{');
      const lastBrace = candidate.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          parsedCandidates.push(JSON.parse(candidate.slice(firstBrace, lastBrace + 1)));
        } catch {
          // Try the next candidate.
        }
      }
    }
  }

  return parsedCandidates
    .map((value) => ({ value, score: scoreParsedJsonCandidate(value) }))
    .sort((a, b) => b.score - a.score)[0]?.value || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isTemplateJsonPlaceholder(value: string) {
  return /selected_topic_name_or_not_applicable|target_view_or_base_view|short readiness verdict|0-100%|3-5 business questions|3 business use cases|3-5 default filters|3-5 questions|term1|optional concise yaml|view\.field_or_measure|critical\|high\|medium\|low/i.test(value);
}

function readStringArray(record: Record<string, unknown> | null, keys: string[], fallback: string[] = []) {
  if (!record) return fallback;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const items = value
        .map((item) => (typeof item === 'string' ? cleanGeneratedText(item) : stringifyStructuredItem(item)))
        .filter((item) => item && !isTemplateJsonPlaceholder(item));
      if (items.length) return items;
    }
  }
  return fallback;
}

function stringifyStructuredItem(value: unknown, options: { includeYamlHint?: boolean } = {}): string {
  const includeYamlHint = options.includeYamlHint !== false;
  if (typeof value === 'string') return cleanExtractedItem(value);
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return [
    record.target,
    record.severity ? `[${record.severity}]` : '',
    Array.isArray(record.terms) ? `Terms: ${record.terms.filter((term) => typeof term === 'string').join(', ')}` : '',
    record.issue,
    record.recommendation,
    record.reason,
    includeYamlHint ? record.yamlHint : '',
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' - ')
    .trim();
}

function collectStructuredStrings(value: unknown, keys: string[], options: { includeYamlHint?: boolean } = {}): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const results: string[] = [];

  Object.entries(record).forEach(([key, nested]) => {
    if (keys.includes(key) && Array.isArray(nested)) {
      nested.forEach((item) => {
        const text = stringifyStructuredItem(item, options);
        if (text) results.push(text);
      });
    } else if (nested && typeof nested === 'object') {
      results.push(...collectStructuredStrings(nested, keys, options));
    }
  });

  return results;
}

function collectReviewValues(parsed: unknown[], keys: string[], maxItems: number, options: { includeYamlHint?: boolean } = {}) {
  return uniqueStrings(parsed.flatMap((item) => collectStructuredStrings(item, keys, options)), maxItems);
}

function formatReviewSection(label: string, values: string[]) {
  return [
    `${label}:`,
    ...(values.length ? values.map((value) => `- ${value}`) : ['- none'])
  ].join('\n');
}

function buildPreviousChunkSummary(chunks: DeepReviewChunkState[]) {
  const parsedChunks = chunks.filter((chunk) => chunk.status === 'complete' && chunk.parsed);
  if (!parsedChunks.length) return '';

  const parsed = parsedChunks.map((chunk) => chunk.parsed).filter(Boolean);
  const questions = collectReviewValues(parsed, READINESS_JSON_KEYS.questions, 5);
  const useCases = collectReviewValues(parsed, READINESS_JSON_KEYS.useCases, 5);
  const rules = collectReviewValues(parsed, READINESS_JSON_KEYS.businessRules, 6);
  const gaps = collectReviewValues(parsed, REVIEW_GAP_JSON_KEYS, 8);
  const fieldIssues = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.fieldIssues, 16);
  const measures = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.measures, 10);
  const routing = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.routing, 8);
  const negativeRouting = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.negativeRouting, 8);
  const synonyms = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.synonyms, 12);
  const aiContext = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.aiContext, 10);
  const targetPlan = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.targetPlan, 12);
  const separateWorkflow = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.separateWorkflow, 8);
  const validations = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.validations, 8);
  const chunkStatus = parsedChunks.map((chunk) => `${chunk.id}: complete`).join(', ');

  return [
    'Prior review brief. Build on this; do not restate it unless it affects the current step.',
    `Completed chunks: ${chunkStatus}`,
    formatReviewSection('Questions', questions),
    formatReviewSection('Use cases', useCases),
    formatReviewSection('Rules', rules),
    formatReviewSection('Gaps', gaps),
    formatReviewSection('Field / modeling issues', fieldIssues),
    formatReviewSection('Metrics / measure guidance', measures),
    formatReviewSection('Routing', routing),
    formatReviewSection('Negative routing', negativeRouting),
    formatReviewSection('Synonyms', synonyms),
    formatReviewSection('AI context opportunities', aiContext),
    formatReviewSection('Selected-target plan', targetPlan),
    formatReviewSection('Separate workflow notes', separateWorkflow),
    formatReviewSection('Validations', validations),
  ].join('\n').slice(0, 12000);
}

function isModelPackageNoise(value: string) {
  return /sample quer|sample_queries|select\s+.+\s+from\s+|order\s+by\s+|limit\s+\d+/i.test(value);
}

function isUnsafeTopicFilterInstruction(value: string) {
  return /(?:promote|add|convert|enforce|create|write).{0,80}(default_filters?|always_where_filters?|access_filters?)|(?:default_filters?|always_where_filters?|access_filters?).{0,80}(?:equal|greater_than|less_than|greater_than_or_equal_to|less_than_or_equal_to|operator|syntax)/i.test(value);
}

function isNonTopicPackageInstruction(value: string) {
  return /settings\/model|settings\/relationships|target\s+file\s*:\s*(model|relationships)|relationships\s+file|model\s*\/\s*view\s+builder|model\/view|view\s+builder|\.query\.view\b|\.view\b|view\s+file|dimensions?\.[\w-]+|measures?\.[\w-]+|schema:|table_name|aggregate_type|hidden:\s*true|mask_unless_access_grants|required_access_grants|access_grants|omni_attributes|join_from_view|join_to_view|on_sql|relationship_type|fiscal_month_offset|cache_polic(?:y|ies)|ignored_schemas?|ignored_views?|default_topic_access_filters?|default_topic_required_access_grants?/i.test(value);
}

function packageBriefValues(values: string[], studioPath?: StudioPathSelection) {
  if (studioPath === 'topic') {
    return values.filter((value) => !isUnsafeTopicFilterInstruction(value) && !isNonTopicPackageInstruction(value));
  }
  if (studioPath !== 'model') return values;
  return values.filter((value) => !isModelPackageNoise(value));
}

function buildPackageChangeSummary(chunks: DeepReviewChunkState[], studioPath?: StudioPathSelection) {
  const parsedChunks = chunks.filter((chunk) => chunk.status === 'complete' && chunk.parsed);
  if (!parsedChunks.length) return '';

  const parsed = parsedChunks.map((chunk) => chunk.parsed).filter(Boolean);
  const targetPlan = packageBriefValues(collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.targetPlan, 12), studioPath);
  const metrics = packageBriefValues(collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.measures, 10), studioPath);
  const routing = packageBriefValues(collectReviewValues(parsed, [
    ...REVIEW_JSON_KEY_GROUPS.routing,
    ...REVIEW_JSON_KEY_GROUPS.negativeRouting,
    ...REVIEW_JSON_KEY_GROUPS.aiContext,
    ...REVIEW_JSON_KEY_GROUPS.synonyms,
  ], 16), studioPath);
  const fieldConstraints = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.fieldIssues, 16, { includeYamlHint: false });
  const validations = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.validations, 8);
  const separateWorkflow = collectReviewValues(parsed, REVIEW_JSON_KEY_GROUPS.separateWorkflow, 8);

  return [
    'Approved change brief for Package. Use this as edit intent only; the current target file YAML is the source of truth.',
    ...(studioPath === 'model' ? [
      'Model/View package constraint: keep ai_context concise and do not include raw SQL sample queries, topic joins, ai_fields, or sample_queries in the target file.',
      'Model/View package constraint: field names must be unique across dimensions and measures. If adding a measure for an existing dimension, keep the source dimension hidden and use a distinct measure key such as <field_name>_sum; do not create a measure with sql: ${same_key}.',
      'Model/View package constraint: ratio measures should reference the distinct aggregating measures, not hidden raw dimensions.',
      'Model/View package constraint: top-level synonyms are invalid in .view files; put synonyms under dimensions or measures only.',
      'Model/View package constraint: preserve aggregate semantics in field copy. Do not describe aggregate_type: count as distinct unless the measure uses count_distinct or an explicit distinct key.',
      'Model/View package constraint: treat PII/RLS as governance work. Use enforceable access grants, access filters, user attributes / omni_attributes, or masked dimensions only when supported by the selected target and confirmed; otherwise put a non-deployable commented example in validations.',
      'Model/View package constraint: do not add synonyms or ai_context to raw PII/contact/person-identifying fields unless the admin explicitly confirmed AI-assisted PII lookup/display.',
    ] : studioPath === 'permissions' ? [
      'Permission package constraint: emit Settings/model plus the selected .topic or .view target when the selected target needs access grants; emit model only for a Settings/model target.',
      'Permission package constraint: do not infer deployable permissions from field names alone. Unconfirmed grants, user attributes, match fields, allowed values, bypass rules, and null/default behavior belong in validations.',
      'Permission package constraint: Settings/model is the only target that may define access_grants or model-level defaults. .topic and .view targets may only reference grants/user attributes defined or preserved in Settings/model.',
      'Permission package constraint: .topic targets may use required_access_grants and access_filters only with confirmed syntax. .view targets may use required_access_grants, mask_unless_access_grants, or confirmed omni_attributes masking.',
      'Permission package constraint: preserve every packaged file YAML as source of truth and keep permission work outside expected package targets in separateWorkflow notes.',
    ] : studioPath === 'topic' ? [
      'Topic package constraint: preserve existing topic YAML as the source of truth and change only confirmed topic-file sections.',
      'Topic package constraint: do not promote prose rules into executable default_filters unless the current source YAML already contains known-good filter syntax or the admin confirmed exact Omni syntax.',
      'Topic package constraint: omit sample query filters unless copying a known-good existing query filter shape; put unverified filter logic in ai_context or assumptions.',
      'Topic package constraint: do not include view/model/relationships keys or global field definitions in the topic YAML.',
      'Topic package constraint: omit direct PII, contact, and person-identifying fields from ai_fields unless the confirmed admin inputs explicitly require AI-assisted PII lookup or display.',
      'Topic package constraint: omit raw technical selectors from ai_fields and sample_queries unless explicitly confirmed for AI-assisted lookup/display: id, *_id, session_id, ad_event_id, uri, url, referrer, and referrer_code.',
      'Topic package constraint: do not use sample queries to display direct PII/contact fields unless the admin explicitly confirmed that use case.',
      'Topic package constraint: assumptions and validations must not contradict the YAML block.',
    ] : []),
    formatReviewSection('Selected-target edits', targetPlan),
    formatReviewSection('Metrics / field definitions', metrics),
    formatReviewSection('AI routing / metadata', routing),
    formatReviewSection('Review constraints / exclusions', fieldConstraints),
    formatReviewSection('Keep outside this package', separateWorkflow),
    formatReviewSection('Validation notes', validations),
  ].join('\n').slice(0, 9000);
}

function buildDeepReviewUnionSummary(chunks: DeepReviewChunkState[]) {
  const parsedChunks = chunks.map((chunk) => chunk.parsed).filter(Boolean);
  const questions = collectReviewValues(parsedChunks, READINESS_JSON_KEYS.questions, 6);
  const useCases = collectReviewValues(parsedChunks, READINESS_JSON_KEYS.useCases, 6);
  const rules = collectReviewValues(parsedChunks, READINESS_JSON_KEYS.businessRules, 8);
  const gaps = collectReviewValues(parsedChunks, REVIEW_GAP_JSON_KEYS, 10);
  const fieldIssues = collectReviewValues(parsedChunks, REVIEW_JSON_KEY_GROUPS.fieldIssues, 18);
  const measures = collectReviewValues(parsedChunks, REVIEW_JSON_KEY_GROUPS.measures, 12);
  const routing = collectReviewValues(parsedChunks, REVIEW_JSON_KEY_GROUPS.routing, 10);
  const negativeRouting = collectReviewValues(parsedChunks, REVIEW_JSON_KEY_GROUPS.negativeRouting, 10);
  const synonyms = collectReviewValues(parsedChunks, REVIEW_JSON_KEY_GROUPS.synonyms, 14);
  const aiContext = collectReviewValues(parsedChunks, REVIEW_JSON_KEY_GROUPS.aiContext, 12);
  const targetPlan = collectReviewValues(parsedChunks, REVIEW_JSON_KEY_GROUPS.targetPlan, 14);
  const separateWorkflow = collectReviewValues(parsedChunks, REVIEW_JSON_KEY_GROUPS.separateWorkflow, 10);
  const validations = collectReviewValues(parsedChunks, [...REVIEW_JSON_KEY_GROUPS.validations, 'filters'], 10);
  const chunkStatus = chunks.map((chunk) => `- ${chunk.label}: ${chunk.status}${chunk.error ? ` (${chunk.error})` : ''}`);

  const format = (label: string, values: string[]) => [
    `## ${label}`,
    ...(values.length ? values.map((value) => `- ${value}`) : ['- No structured items returned.']),
  ].join('\n');

  return [
    '# Token-Safe Deep Review Union',
    'OmniKit ran the review as sequential AI jobs and merged the structured chunk outputs below.',
    '',
    '## Chunk Status',
    ...chunkStatus,
    '',
    format('Questions To Support', questions),
    '',
    format('Business Use Cases', useCases),
    '',
    format('Business Rules / Filters', rules),
    '',
    format('Gaps', gaps),
    '',
    format('Field / Modeling Issues', fieldIssues),
    '',
    format('Metrics / Measures', measures),
    '',
    format('Routing Rules', routing),
    '',
    format('Negative Routing', negativeRouting),
    '',
    format('Synonyms', synonyms),
    '',
    format('AI Context Opportunities', aiContext),
    '',
    format('Selected-Target Plan', targetPlan),
    '',
    format('Separate Workflow Notes', separateWorkflow),
    '',
    format('Validation Questions', validations),
  ].join('\n');
}

function cleanExtractedItem(value: string) {
  return stripInlineFormatting(value)
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^\|\s*/, '')
    .replace(/\s*\|$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanGeneratedText(value: string) {
  return cleanExtractedItem(value)
    .replace(/\\"/g, '"')
    .replace(/^["'“”]+/, '')
    .replace(/["'“”]+$/, '')
    .trim();
}

function extractSectionItems(content: string, headingMatchers: RegExp[], maxItems: number) {
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => headingMatchers.some((matcher) => matcher.test(line)));
  if (startIndex === -1) return [];

  const items: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^#{1,4}\s+/.test(trimmed) || /^-{3,}$/.test(trimmed)) {
      if (items.length) break;
      continue;
    }
    if (/^\|?\s*-+\s*\|/.test(trimmed) || /^(\|.*\|)$/.test(trimmed) && /question|use case|gap|detail|priority/i.test(trimmed)) continue;
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed) || trimmed.startsWith('|')) {
      const item = cleanExtractedItem(trimmed.split('|').filter(Boolean).join(' - '));
      if (item && !items.includes(item)) items.push(item);
    }
    if (items.length >= maxItems) break;
  }
  return items.slice(0, maxItems);
}

function getSectionContent(content: string, headingMatchers: RegExp[]) {
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => headingMatchers.some((matcher) => matcher.test(line.trim())));
  if (startIndex === -1) return '';

  const sectionLines: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^(?:#{1,4}\s*)?\d+\.\s+/.test(trimmed) && sectionLines.some((line) => line.trim())) break;
    if (/^Probe queries executed:/i.test(trimmed)) break;
    sectionLines.push(lines[i]);
  }
  return sectionLines.join('\n').trim();
}

function uniqueNonEmpty(values: string[], maxItems: number) {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const cleaned = cleanExtractedItem(value).replace(/\s+Fix:\s+.*$/i, '').trim();
    if (cleaned && !seen.has(cleaned.toLowerCase())) {
      seen.add(cleaned.toLowerCase());
      result.push(cleaned);
    }
  });
  return result.slice(0, maxItems);
}

function extractReadinessQuestions(content: string) {
  const section = getSectionContent(content, [/top\s+\d.*questions/i, /industry-standard questions/i, /questions.*answer/i]);
  const quoted = Array.from(section.matchAll(/"([^"]+\?[^"]*)"/g)).map((match) => match[1]);
  if (quoted.length) return uniqueNonEmpty(quoted, 5);

  return uniqueNonEmpty(
    section
      .split('\n')
      .filter((line) => /\?/.test(line))
      .map((line) => line.replace(/^\d+\.\s*/, '')),
    5
  );
}

function extractReadinessUseCases(content: string) {
  const section = getSectionContent(content, [/top\s+\d.*business use cases/i, /business use cases/i]);
  const matches = Array.from(section.matchAll(/Use Case\s+\d+\s+[—-]\s+(.+)/gi)).map((match) => match[1]);
  if (matches.length) return uniqueNonEmpty(matches, 3);
  return uniqueNonEmpty(extractSectionItems(content, [/business use cases/i], 3), 3);
}

function extractReadinessBusinessRules(content: string) {
  const section = getSectionContent(content, [/query assumptions/i, /assumptions made/i, /default filters/i]);
  const matches = Array.from(section.matchAll(/^([^:\n]{3,90}):\s+(.+)$/gm)).map((match) => `${match[1]}: ${match[2]}`);
  if (matches.length) return uniqueNonEmpty(matches, 4);
  return uniqueNonEmpty(extractSectionItems(content, [/query assumptions/i, /assumptions/i, /default filters/i], 4), 4);
}

function extractReadinessGaps(content: string) {
  const section = getSectionContent(content, [/data.*modeling gaps/i, /critical blockers/i, /quality risks/i]);
  const coded = Array.from(section.matchAll(/^[BQ]\d+\s+[—-]\s+(.+)$/gm)).map((match) => match[1]);
  if (coded.length) return uniqueNonEmpty(coded, 5);
  return uniqueNonEmpty(extractSectionItems(content, [/critical gaps/i, /data.*modeling gaps/i, /blockers/i], 5), 5);
}

function extractReadinessOutOfScope(content: string) {
  const section = getSectionContent(content, [/ai context opportunities/i, /questions.*should not answer/i, /negative routing/i]);
  const quoted = Array.from(section.matchAll(/"([^"]*(?:Do not use|should not|do not answer)[^"]*)"/gi)).map((match) => match[1]);
  if (quoted.length) return uniqueNonEmpty(quoted, 3);
  const negativeLines = section.split('\n').filter((line) => /negative routing|do not use|should not|do not answer/i.test(line));
  return uniqueNonEmpty(negativeLines, 3);
}

function deriveReadinessInputs(content: string): ReadinessInputs {
  const parsed = asRecord(tryParseJsonBlock(content));
  if (parsed) {
    try {
      const questions = readStringArray(parsed, READINESS_JSON_KEYS.questions, EMPTY_READINESS_INPUTS.questions);
      const useCases = readStringArray(parsed, READINESS_JSON_KEYS.useCases, EMPTY_READINESS_INPUTS.useCases);
      const clarifyingQuestions = readStringArray(parsed, READINESS_JSON_KEYS.clarifyingQuestions, []);
      const gaps = [
        ...readStringArray(parsed, READINESS_JSON_KEYS.gaps, EMPTY_READINESS_INPUTS.gaps),
        ...clarifyingQuestions.map((question) => `Clarify: ${question}`),
      ];
      return {
        questions,
        questionInputs: Array.from({ length: questions.length }, () => ''),
        useCases,
        useCaseInputs: Array.from({ length: useCases.length }, () => ''),
        businessRules: readStringArray(parsed, READINESS_JSON_KEYS.businessRules, EMPTY_READINESS_INPUTS.businessRules),
        gaps: uniqueNonEmpty(gaps, 6),
        outOfScope: readStringArray(parsed, READINESS_JSON_KEYS.outOfScope, EMPTY_READINESS_INPUTS.outOfScope),
        notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      };
    } catch {
      // Fall back to markdown section parsing below.
    }
  }

  const questions = extractReadinessQuestions(content);
  const useCases = extractReadinessUseCases(content);
  const gaps = extractReadinessGaps(content);
  const businessRules = extractReadinessBusinessRules(content);
  const outOfScope = extractReadinessOutOfScope(content);

  return {
    questions: questions.length ? questions : EMPTY_READINESS_INPUTS.questions,
    questionInputs: Array.from({ length: questions.length || EMPTY_READINESS_INPUTS.questions.length }, () => ''),
    useCases: useCases.length ? useCases : EMPTY_READINESS_INPUTS.useCases,
    useCaseInputs: Array.from({ length: useCases.length || EMPTY_READINESS_INPUTS.useCases.length }, () => ''),
    businessRules: businessRules.length ? businessRules : EMPTY_READINESS_INPUTS.businessRules,
    gaps: gaps.length ? gaps : EMPTY_READINESS_INPUTS.gaps,
    outOfScope: outOfScope.length ? outOfScope : EMPTY_READINESS_INPUTS.outOfScope,
    notes: '',
  };
}

function mergeReadinessList(currentValues: string[], derivedValues: string[], fallback: string[], preferDerived = false) {
  const maxLength = Math.max(currentValues.length, derivedValues.length, fallback.length, 1);
  const merged = Array.from({ length: maxLength }, (_, index) => {
    const current = cleanGeneratedText(currentValues[index] || '');
    const derived = cleanGeneratedText(derivedValues[index] || '');
    return (preferDerived ? derived || current : current || derived) || '';
  });
  const lastFilledIndex = merged.reduce((last, value, index) => (value.trim() ? index : last), -1);
  if (lastFilledIndex < 0) return fallback;
  return merged.slice(0, Math.max(lastFilledIndex + 1, 1));
}

function alignReadinessDetails(currentValues: string[], details: string[], values: string[], preserveOriginals: boolean) {
  return values.map((value, index) => {
    const detail = details[index] || '';
    const previousValue = cleanGeneratedText(currentValues[index] || '');
    const nextValue = cleanGeneratedText(value || '');
    if (!preserveOriginals || detail || !previousValue || !nextValue || previousValue.toLowerCase() === nextValue.toLowerCase()) {
      return detail;
    }
    return `Original brief: ${previousValue}`;
  });
}

function mergeReadinessInputs(current: ReadinessInputs, derived: ReadinessInputs, options: { preferDerived?: boolean } = {}): ReadinessInputs {
  const preferDerived = Boolean(options.preferDerived);
  const questions = mergeReadinessList(current.questions, derived.questions, EMPTY_READINESS_INPUTS.questions, preferDerived);
  const useCases = mergeReadinessList(current.useCases, derived.useCases, EMPTY_READINESS_INPUTS.useCases, preferDerived);
  const businessRules = mergeReadinessList(current.businessRules, derived.businessRules, EMPTY_READINESS_INPUTS.businessRules, preferDerived);
  const gaps = mergeReadinessList(current.gaps, derived.gaps, EMPTY_READINESS_INPUTS.gaps, preferDerived);
  const outOfScope = mergeReadinessList(current.outOfScope, derived.outOfScope, EMPTY_READINESS_INPUTS.outOfScope, preferDerived);

  return {
    questions,
    questionInputs: alignReadinessDetails(current.questions, current.questionInputs, questions, preferDerived),
    useCases,
    useCaseInputs: alignReadinessDetails(current.useCases, current.useCaseInputs, useCases, preferDerived),
    businessRules,
    gaps,
    outOfScope,
    notes: current.notes.trim() ? current.notes : derived.notes,
  };
}

function parseReadinessSummary(content: string): ReadinessSummary {
  const parsed = asRecord(tryParseJsonBlock(content));
  const fallbackInputs = deriveReadinessInputs(content);
  const topic =
    readFirstString(parsed, ['topic', 'topicName', 'topic_name', 'selectedTopic', 'selected_topic']) ||
    content.match(/Topic:\s*`?([a-zA-Z0-9_ -]+)/i)?.[1] ||
    '';
  const verdict =
    readFirstString(parsed, ['verdict', 'readinessVerdict', 'readiness_verdict', 'summary']) ||
    content.match(/(?:Overall\s+)?(?:AI\s+)?Readiness(?:\s+Verdict)?:?\s*([^\n]+)/i)?.[1] ||
    content.match(/Summary Verdict\s*[:\n]\s*([^\n]+)/i)?.[1] ||
    '';
  const confidence =
    readFirstString(parsed, ['confidence', 'confidenceLevel', 'confidence_level']) ||
    content.match(/Confidence(?:\s+Level)?:\s*([0-9]+%?[^.\n]*)/i)?.[1] ||
    '';

  return {
    topic: cleanGeneratedText(topic),
    verdict: cleanGeneratedText(verdict),
    confidence: cleanGeneratedText(confidence),
    questions: readStringArray(parsed, READINESS_JSON_KEYS.questions, fallbackInputs.questions),
    useCases: readStringArray(parsed, READINESS_JSON_KEYS.useCases, fallbackInputs.useCases),
    businessRules: readStringArray(parsed, READINESS_JSON_KEYS.businessRules, fallbackInputs.businessRules),
    gaps: readStringArray(parsed, READINESS_JSON_KEYS.gaps, fallbackInputs.gaps),
    outOfScope: readStringArray(parsed, READINESS_JSON_KEYS.outOfScope, fallbackInputs.outOfScope),
  };
}

function normalizeAiState(state: string | undefined) {
  return (state || '').trim().toUpperCase().replace(/[-\s]/g, '_');
}

function jobToResult(job: OmniAiJob | null | undefined): OmniAiJobResult | null {
  if (!job) return null;
  const message = extractAiMessage(undefined, job);
  const topic = readFirstString(job, ['topicName', 'topic_name', 'topic']);
  if (!message && !topic && !job.actions?.length) return null;
  return {
    actions: job.actions,
    message,
    resultSummary: readFirstString(job, ['resultSummary', 'result_summary']),
    topic,
    omniChatUrl: readFirstString(job, ['omniChatUrl', 'omni_chat_url']),
  };
}

function readNestedString(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) return '';
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current.trim() : '';
}

function readFirstString(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === 'string' && field.trim()) return field.trim();
  }
  return '';
}

function readFirstNestedString(value: unknown, paths: string[][]) {
  for (const path of paths) {
    const nested = readNestedString(value, path);
    if (nested) return nested;
  }
  return '';
}

function collectNestedStrings(value: unknown, depth = 0, seen = new WeakSet<object>()): string[] {
  if (typeof value === 'string') return [value.trim()].filter(Boolean);
  if (!value || typeof value !== 'object' || depth > 7) return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectNestedStrings(item, depth + 1, seen));
  }

  return Object.values(value as Record<string, unknown>).flatMap((item) => collectNestedStrings(item, depth + 1, seen));
}

function scoreAiMessageCandidate(value: string) {
  const text = value.trim();
  if (text.length < 40) return -100;
  if (
    /Field Definitions\s+YAML representation of all available fields/i.test(text) ||
    /YAML representation of all available fields,\s*grouped by view/i.test(text) ||
    /(^|\n)\s*-\s*view_name:\s*[A-Za-z_][\w.-]*/m.test(text)
  ) {
    return -1000;
  }
  let score = 0;
  if (/target\s+file\s*:/i.test(text)) score += 30;
  if (/```yaml/i.test(text)) score += 35;
  if (/```json/i.test(text)) score += 20;
  if (/(^|\n)\s*(query:|dimensions:|measures:|base_view:|joins:|ai_fields:|sample_queries:)\s*/m.test(text)) score += 12;
  if (/assumptions?\s*(?:\/|and)\s*validations?/i.test(text)) score += 5;
  if (/required response shape|stage contract|current target file yaml|invalid previous response|rules:\s*-|act as a senior ai/i.test(text)) score -= 35;
  if (/return exactly|do not return|do not include|follow only this/i.test(text)) score -= 12;
  score += Math.min(text.length / 5000, 4);
  return score;
}

function pickBestAiMessageCandidate(candidates: string[]) {
  return candidates
    .map((value) => ({ value: value.trim(), score: scoreAiMessageCandidate(value) }))
    .filter((candidate) => candidate.value.length > 40 && candidate.score > -500)
    .sort((a, b) => b.score - a.score || b.value.length - a.value.length)[0]?.value || '';
}

function extractMessageFromActions(actions?: Array<Record<string, unknown>>) {
  if (!Array.isArray(actions)) return '';
  return pickBestAiMessageCandidate(collectNestedStrings(actions));
}

function extractAiMessage(result?: OmniAiJobResult | null, job?: OmniAiJob | null) {
  return pickBestAiMessageCandidate([
    readFirstString(result, ['message', 'resultSummary', 'result_summary', 'finalMessage', 'final_message', 'answer', 'response', 'content', 'text', 'summary']) ||
      '',
    extractMessageFromActions(result?.actions),
    readFirstString(job, ['message', 'resultSummary', 'result_summary', 'finalMessage', 'final_message', 'answer', 'response', 'content', 'text', 'summary']) ||
      '',
    extractMessageFromActions(job?.actions),
  ]);
}

function hasAiResultContent(result?: OmniAiJobResult | null, job?: OmniAiJob | null) {
  return Boolean(extractAiMessage(result, job));
}

function stripInlineFormatting(text: string) {
  return text.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

function isYamlStart(line: string) {
  return /^\s*(base_view:|label:|description:|ai_context:|context:|joins:|views:|fields:|ai_fields:|sample_queries:|default_filters:|always_where_filters:|access_filters:|topics:|name:|- name:|- join_from_view:)/.test(line);
}

function normalizeDraftContent(lines: string[]) {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractCodeBlocksWithContext(content: string) {
  return Array.from(content.matchAll(/```([^\n]*)\n([\s\S]*?)```/gi))
    .map((match) => ({
      language: match[1]?.trim() || '',
      content: match[2]?.trim() || '',
      before: content.slice(Math.max(0, (match.index || 0) - 320), match.index || 0),
    }))
    .filter((block) => Boolean(block.content));
}

function extractCodeBlocks(content: string) {
  return extractCodeBlocksWithContext(content)
    .map((block) => block.content)
    .filter(Boolean);
}

function removeLegacyTopicsWrapper(raw: string) {
  const lines = raw.split('\n');
  const nonEmptyIndex = lines.findIndex((line) => line.trim() && !line.trim().startsWith('#'));
  if (nonEmptyIndex === -1 || lines[nonEmptyIndex].trim() !== 'topics:') return raw;

  const itemIndex = lines.findIndex((line, index) => index > nonEmptyIndex && /^\s*-\s+name:/.test(line));
  if (itemIndex === -1) return raw;

  const topicName = lines[itemIndex].replace(/^\s*-\s+name:\s*/, '').trim();
  const converted = lines.slice(itemIndex + 1).map((line) => line.replace(/^\s{4}/, '').replace(/^\s{2}/, ''));
  return [`# Suggested topic file name: ${topicName}`, ...converted].join('\n');
}

function normalizeOmniTopicYaml(raw: string) {
  let yaml = removeLegacyTopicsWrapper(raw)
    .replace(/^\s*---\s*/g, '')
    .replace(/\n\s*---\s*$/g, '')
    .replace(/^(\s*)base_view_name:/gm, '$1base_view:')
    .trim();

  if (!/^\s*ai_context:/m.test(yaml)) {
    yaml = yaml.replace(/^(\s*)context:/gm, '$1ai_context:');
  }

  return yaml.replace(/\n{3,}/g, '\n\n').trim();
}

function isTopicYamlLike(content: string) {
  return /(^|\n)(base_view|ai_context|context|joins|views|fields|ai_fields|sample_queries|default_filters|always_where_filters|access_filters|topics):\s*/.test(content);
}

function isCompleteTopicYamlLike(content: string) {
  return isTopicYamlLike(content) && /^\s*base_view:\s*\S+/m.test(content);
}

function isTargetTopicYamlLike(content: string) {
  const cleaned = normalizeModelViewYaml(normalizeOmniTopicYaml(content));
  if (!cleaned) return false;
  if (isRelationshipsFileYamlLike(cleaned)) return false;
  if (/^\s*topics:\s*/m.test(cleaned) || /^\s*name:\s*/m.test(cleaned)) return false;
  if (hasTopLevelYamlKey(cleaned, [
    'dimensions',
    'measures',
    'schema',
    'schema_label',
    'table_name',
    'query',
    'sql',
    'extends',
    'default_cache_policy',
    'cache_policies',
    'ignored_schemas',
    'ignored_views',
    'access_grants',
    'user_attributes',
    'week_start_day',
    'fiscal_month_offset',
  ])) {
    return false;
  }
  return hasTopLevelYamlKey(cleaned, [
    'base_view',
    'label',
    'group_label',
    'display_order',
    'description',
    'default_filters',
    'always_where_filters',
    'joins',
    'views',
    'fields',
    'ai_fields',
    'sample_queries',
    'ai_context',
    'required_access_grants',
    'access_filters',
  ]);
}

function topicNameStem(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function inferTopicNameFromTopicYaml(yaml: string) {
  const suggested = yaml.match(/^\s*#\s*Suggested topic file name:\s*([A-Za-z_][\w-]*)/im)?.[1];
  if (suggested) return topicNameStem(suggested);

  const sampleQueryTopics = uniqueNonEmpty(
    Array.from(yaml.matchAll(/^\s+topic:\s*([A-Za-z_][\w-]*)\s*$/gm)).map((match) => match[1] || ''),
    4
  );
  if (sampleQueryTopics.length === 1) return topicNameStem(sampleQueryTopics[0]);

  const label = yaml.match(/^\s*label:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1];
  if (label) return topicNameStem(label);

  const baseView = yaml.match(/^\s*base_view:\s*([A-Za-z_][\w-]*)\s*$/m)?.[1];
  return baseView ? topicNameStem(baseView) : '';
}

function uniqueDrafts(drafts: YamlDraft[]) {
  const byKey = new Map<string, YamlDraft>();
  drafts.forEach((draft) => {
    const normalizedContent = draft.content
      .replace(/^\s*---\s*\n?/, '')
      .replace(/\n?\s*---\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const key = draft.targetFileName
      ? `target:${draft.targetFileName}`
      : `content:${normalizedContent}`;
    const existing = byKey.get(key);
    if (!existing || normalizedContent.length > existing.content.replace(/\s+/g, ' ').trim().length) {
      byKey.set(key, { ...draft, content: draft.content.replace(/\n?\s*---\s*$/, '').trim() });
    }
  });
  return Array.from(byKey.values());
}

function extractYamlSection(
  lines: string[],
  startMatcher: RegExp,
  stopMatcher: RegExp,
  label: string,
  description: string
): YamlDraft | null {
  const startIndex = lines.findIndex((line) => startMatcher.test(line.trim()));
  if (startIndex === -1) return null;

  let yamlStart = -1;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (stopMatcher.test(lines[i].trim())) break;
    if (isYamlStart(lines[i])) {
      yamlStart = i;
      break;
    }
  }
  if (yamlStart === -1) return null;

  const sectionLines: string[] = [];
  for (let i = yamlStart; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (stopMatcher.test(trimmed)) break;
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) break;
    sectionLines.push(lines[i]);
  }

  const draft = normalizeDraftContent(sectionLines);
  return draft ? { id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label, description, content: draft } : null;
}

function isYamlAssumptionsHeader(line: string) {
  return /^(assumptions?\s*(?:\/|and)\s*validations?|validation questions|validations?|notes?)\b/i.test(line.trim());
}

function extractInlineCompleteTopicYaml(content: string, mode: AiResultMode): YamlDraft | null {
  if (mode !== 'final-yaml') return null;

  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => /^\s*base_view:\s*\S+/.test(line));
  if (startIndex === -1) return null;

  const sectionLines: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (isYamlAssumptionsHeader(trimmed)) break;
    if (/^```/.test(trimmed)) break;
    sectionLines.push(lines[index]);
  }

  const draft = normalizeOmniTopicYaml(normalizeDraftContent(sectionLines));
  if (!isCompleteTopicYamlLike(draft)) return null;

  return {
    id: 'complete-topic-yaml-inline',
    label: 'Complete Topic YAML',
    description: 'Copy only this YAML section into the approved Omni modeling workflow after admin review.',
    content: draft,
  };
}

function extractYamlDrafts(content: string, mode: AiResultMode): YamlDraft[] {
  const drafts: YamlDraft[] = [];
  const fencedBlocks = extractCodeBlocks(content)
    .map(normalizeOmniTopicYaml)
    .filter((block) => (mode === 'final-yaml' ? isCompleteTopicYamlLike(block) : isTopicYamlLike(block)));

  if (fencedBlocks.length > 0) {
    return uniqueDrafts(fencedBlocks.map((block, index) => ({
      id: `topic-yaml-draft-${index + 1}`,
      label: mode === 'context-review'
        ? 'Topic guidance YAML'
        : mode === 'final-yaml'
          ? 'Complete Topic YAML'
          : 'Topic YAML draft',
      description: 'Copy only this YAML section into the approved Omni modeling workflow after admin review.',
      content: block,
    })));
  }

  const lines = content.split('\n');
  const topicContext = extractYamlSection(
    lines,
    /(ai_context yaml|topic-level.*ai_context|stronger topic-level|recommended replacement)/i,
    /^(\s*#{1,4}\s*)?(2\.|missing business|field-level|3\.|4\.|example questions|questions this topic|summary)/i,
    mode === 'context-review' ? 'Topic guidance YAML' : mode === 'final-yaml' ? 'Complete Topic YAML' : 'Topic YAML draft',
    'Copy only this YAML section into the approved Omni modeling workflow after admin review.'
  );

  if (topicContext) {
    drafts.push({
      ...topicContext,
      content: normalizeOmniTopicYaml(topicContext.content),
    });
  }

  const topicYamlDraft = extractYamlSection(
    lines,
    /(topic yaml draft|complete topic yaml|final yaml package|final reviewable yaml)/i,
    /^(\s*#{1,4}\s*)?(next steps|show ai actions|draft ai context|build final yaml|formatted response)/i,
    mode === 'context-review' ? 'Topic guidance YAML' : mode === 'final-yaml' ? 'Complete Topic YAML' : 'Topic YAML draft',
    'Copy only this YAML section into the approved Omni modeling workflow after admin review.'
  );

  if (topicYamlDraft) {
    drafts.push({
      ...topicYamlDraft,
      content: normalizeOmniTopicYaml(topicYamlDraft.content),
    });
  }

  const inlineCompleteTopicYaml = extractInlineCompleteTopicYaml(content, mode);
  if (inlineCompleteTopicYaml) {
    drafts.push(inlineCompleteTopicYaml);
  }

  return uniqueDrafts(drafts.filter((draft) => (mode === 'final-yaml' ? isCompleteTopicYamlLike(draft.content) : isTopicYamlLike(draft.content))));
}

function extractPlanSummary(content: string) {
  const topicName =
    content.match(/"topicName"\s*:\s*"([^"]+)"/i)?.[1] ||
    content.match(/"topic"\s*:\s*"([^"]+)"/i)?.[1] ||
    content.match(/^\s*topicName\s*:\s*`?([a-zA-Z0-9_ -]+)/im)?.[1] ||
    content.match(/^\s*topic\s*:\s*`?([a-zA-Z0-9_ -]+)/im)?.[1] ||
    content.match(/\|\s*(?:\*\*)?name(?:\*\*)?\s*\|\s*`?([a-zA-Z0-9_ -]+)`?\s*\|/i)?.[1] ||
    content.match(/^\s*name:\s*`?([a-zA-Z0-9_ -]+)/im)?.[1];
  const label =
    content.match(/"label"\s*:\s*"([^"]+)"/i)?.[1] ||
    content.match(/\|\s*(?:\*\*)?label(?:\*\*)?\s*\|\s*`?([^|`]+)`?\s*\|/i)?.[1] ||
    content.match(/^\s*label:\s*`?([^\n`]+)/im)?.[1];
  const baseView =
    content.match(/"baseView"\s*:\s*"([^"]+)"/i)?.[1] ||
    content.match(/\*\*Base view:\*\*\s*`?([a-zA-Z0-9_]+)/i)?.[1] ||
    content.match(/^\s*base_view:\s*([a-zA-Z0-9_]+)/im)?.[1] ||
    content.match(/^\s*base_view_name:\s*([a-zA-Z0-9_]+)/im)?.[1] ||
    content.match(/^\s*base view:\s*`?([a-zA-Z0-9_]+)/im)?.[1];

  return {
    topicName: topicName ? stripInlineFormatting(topicName) : '',
    label: label ? stripInlineFormatting(label) : '',
    baseView: baseView ? stripInlineFormatting(baseView) : '',
  };
}

function headingMatches(line: string, matcher: RegExp) {
  return matcher.test(line.replace(/^#{1,4}\s+/, '').replace(/^\d+\.\s+/, '').trim());
}

function extractReviewSection(content: string, matcher: RegExp) {
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => headingMatches(line.trim(), matcher));
  if (startIndex === -1) return '';

  const sectionLines: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed && !sectionLines.length) continue;
    if (/^#{1,4}\s+/.test(trimmed) && sectionLines.some((line) => line.trim())) break;
    if (/^\d+\.\s+[A-Z][^:]{2,80}$/.test(trimmed) && sectionLines.some((line) => line.trim())) break;
    sectionLines.push(lines[i]);
  }

  return sectionLines.join('\n').trim();
}

function getReviewSections(content: string, mode: AiResultMode): ReviewSection[] {
  const candidates: ReviewSection[] =
    mode === 'context-review'
      ? [
          {
            id: 'where-to-apply',
            title: 'Where To Apply',
            description: 'What a nontechnical admin should know before applying the guidance.',
            content: extractReviewSection(content, /where to apply/i),
            defaultOpen: true,
          },
          {
            id: 'what-changed',
            title: 'What Changed',
            description: 'Plain-English explanation of the semantic guidance updates.',
            content: extractReviewSection(content, /what changed/i),
          },
          {
            id: 'related-modeling',
            title: 'Related Model / View Changes',
            description: 'Metric, relationship, filter, or field work that belongs outside the topic context block.',
            content: extractReviewSection(content, /related model\s*\/\s*view changes|related view\s*\/\s*model changes|related modeling changes/i),
          },
          {
            id: 'confirm-before-applying',
            title: 'Confirm Before Applying',
            description: 'Human review questions before this becomes a modeled change.',
            content: extractReviewSection(content, /confirm before applying/i),
          },
        ]
      : mode === 'final-yaml'
        ? [
		          {
		            id: 'view-level-modeling',
		            title: 'Model / View Builder Output',
		            description: 'Measure, label, hidden-field, relationship, and model work that should stay separate from topic YAML.',
		            content: extractReviewSection(content, /model\s*\/\s*view builder output|view\s*\/\s*model builder output|view\s*\/\s*model yaml patches|view-level modeling scripts|view-level changes|modeling scripts/i),
	          },
	            {
	              id: 'validations',
	              title: 'Assumptions And Validations',
		              description: 'Checks to complete before branch save, diff review, and Omni sign-off.',
	              content: extractReviewSection(content, /assumptions\s*\/\s*validations|validation questions|confirm before applying/i),
	              defaultOpen: true,
	            },
          ]
        : [
            {
              id: 'plan-summary',
              title: 'Plan Summary',
              description: 'The short admin-readable recommendation behind the generated YAML.',
              content: extractReviewSection(content, /plan summary/i),
              defaultOpen: true,
            },
            {
              id: 'validation-questions',
              title: 'Validation Questions',
              description: 'Questions to answer before applying topic or model changes.',
              content: extractReviewSection(content, /validation questions/i),
            },
          {
            id: 'view-level-modeling',
            title: 'Model / View Builder Output',
            description: 'Metric, measure, hidden-field, relationship, or model work that belongs outside topic YAML.',
            content: extractReviewSection(content, /model\s*\/\s*view builder output|view\s*\/\s*model builder output|view\s*\/\s*model yaml patches|view-level modeling scripts|modeling scripts/i),
          },
            {
              id: 'admin-decision',
              title: 'Admin Decision',
              description: 'Recommended next action for the admin or data owner.',
              content: extractReviewSection(content, /admin decision/i),
            },
          ];

  return candidates.filter((section) => section.content.trim().length > 0);
}

function cleanDeployTargetFileName(value: string) {
  const cleaned = value
    .replace(/\\([_`*[\](){}#+.!-])/g, '$1')
    .replace(/[`"']/g, '')
    .replace(/[),.;]+$/g, '')
    .trim();

  if (/^(model|relationships)$/i.test(cleaned)) return cleaned.toLowerCase();
  if (/^[\w./-]+\.(topic|view)$/i.test(cleaned)) return cleaned;
  return '';
}

function readDeployTargetFileName(...values: string[]) {
  for (const value of values) {
    const normalizedValue = stripInlineFormatting(value).replace(/\\([_`*[\](){}#+.!-])/g, '$1');
    const match =
      normalizedValue.match(/target\s+file\s*:\s*([^\s\n]+)/i) ||
      normalizedValue.match(/file\s*:\s*([^\s\n]+)/i) ||
      normalizedValue.match(/apply\s+(?:in|to)\s+([^\s\n]+)/i);
    if (match?.[1]) {
      const cleaned = cleanDeployTargetFileName(match[1]);
      if (cleaned) return cleaned;
    }
  }
  return '';
}

function stripDeployTargetDirective(yaml: string) {
  return yaml
    .split('\n')
    .filter((line) => !/^\s*#?\s*(target\s+file|file)\s*:\s*/i.test(line))
    .join('\n')
    .trim();
}

function normalizeModelViewYaml(raw: string) {
  const cleaned = stripDeployTargetDirective(raw);
  if (!/^\s*relationships:\s*$/m.test(cleaned)) return cleaned;

  const lines = cleaned.split('\n');
  const relationshipsIndex = lines.findIndex((line) => /^\s*relationships:\s*$/.test(line));
  if (relationshipsIndex < 0) return cleaned;

  const body = lines
    .slice(relationshipsIndex + 1)
    .filter((line) => line.trim())
    .map((line) => line.replace(/^\s{2}/, ''));
  const prefix = lines.slice(0, relationshipsIndex).filter((line) => line.trim());
  return [...prefix, ...body].join('\n').trim();
}

function isRelationshipsFileYamlLike(yaml: string) {
  const cleaned = normalizeModelViewYaml(yaml);
  return /^\s*-\s*join_from_view:\s*/m.test(cleaned) && /^\s*join_to_view:\s*/m.test(cleaned);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasTopLevelYamlKey(yaml: string, keys: string[]) {
  if (!keys.length) return false;
  return new RegExp(`^(?:${keys.map(escapeRegex).join('|')}):\\s*`, 'm').test(yaml);
}

function isModelFileYamlLike(yaml: string) {
  const cleaned = normalizeModelViewYaml(yaml);
  if (!cleaned) return false;
  if (isRelationshipsFileYamlLike(cleaned)) return false;
  if (hasTopLevelYamlKey(cleaned, ['base_view', 'sample_queries', 'ai_fields', 'joins', 'schema_label', 'schema', 'table_name', 'query', 'sql', 'extends', 'dimensions', 'measures'])) return false;
  return hasTopLevelYamlKey(cleaned, ['default_cache_policy', 'cache_policies', 'ignored_schemas', 'ignored_views', 'access_grants', 'access_filters', 'user_attributes', 'week_start_day', 'fiscal_month_offset', 'ai_context']);
}

function isViewFileYamlLike(yaml: string) {
  const cleaned = normalizeModelViewYaml(yaml);
  if (!cleaned) return false;
  if (isRelationshipsFileYamlLike(cleaned)) return false;
  if (hasTopLevelYamlKey(cleaned, ['base_view', 'sample_queries', 'ai_fields', 'joins', 'default_cache_policy', 'cache_policies', 'ignored_schemas', 'ignored_views', 'access_grants', 'access_filters', 'user_attributes', 'week_start_day', 'fiscal_month_offset'])) return false;
  if (!hasTopLevelYamlKey(cleaned, ['query', 'sql', 'schema', 'table_name', 'extends'])) return false;
  return hasTopLevelYamlKey(cleaned, ['schema_label', 'description', 'schema', 'table_name', 'query', 'dimensions', 'measures']);
}

function isViewModelYamlLike(yaml: string) {
  const cleaned = normalizeModelViewYaml(yaml);
  return isRelationshipsFileYamlLike(cleaned) || isModelFileYamlLike(cleaned) || isViewFileYamlLike(cleaned);
}

function fallbackViewTargetFileName(value: string) {
  const cleaned = cleanDeployTargetFileName(value);
  if (cleaned) return cleaned;
  const trimmed = value.trim();
  if (!trimmed) return 'semantic_studio.view';
  return `${trimmed.replace(/[^\w.-]+/g, '_')}.view`;
}

function fallbackTopicFileName(value: string) {
  const cleaned = cleanDeployTargetFileName(value);
  if (cleaned) return cleaned;
  return `${topicNameStem(value || 'semantic_studio')}.topic`;
}

function yamlMatchesTargetFile(yaml: string, targetFileName: string) {
  const cleaned = normalizeModelViewYaml(yaml);
  if (targetFileName === 'model') return isModelFileYamlLike(cleaned);
  if (targetFileName === 'relationships') return isRelationshipsFileYamlLike(cleaned);
  if (targetFileName.endsWith('.topic')) return isTargetTopicYamlLike(cleaned);
  if (targetFileName.endsWith('.view')) return isViewFileYamlLike(cleaned);
  return false;
}

function yamlLooksLikeTargetFile(yaml: string, targetFileName: string) {
  if (targetFileName.endsWith('.topic')) return isTargetTopicYamlLike(yaml);
  return isViewModelYamlLike(yaml);
}

function inferViewModelTargetFileName(yaml: string, explicitTarget: string, topicName: string, baseViewName?: string, requiredTargetFileName?: string) {
  if (explicitTarget) return explicitTarget;
  if (requiredTargetFileName) return requiredTargetFileName;
  const cleaned = normalizeModelViewYaml(yaml);
  if (isCompleteTopicYamlLike(cleaned)) return fallbackTopicFileName(topicName || baseViewName || 'semantic_studio');
  if (isRelationshipsFileYamlLike(cleaned) || /^\s*relationships:\s*/m.test(cleaned)) return 'relationships';
  if (isViewFileYamlLike(cleaned)) return fallbackViewTargetFileName(baseViewName || topicName || 'semantic_studio');
  if (hasTopLevelYamlKey(cleaned, ['default_cache_policy', 'cache_policies', 'ignored_schemas', 'ignored_views', 'access_grants', 'access_filters', 'user_attributes', 'week_start_day', 'fiscal_month_offset', 'ai_context'])) return 'model';
  return fallbackViewTargetFileName(baseViewName || topicName || 'semantic_studio');
}

function extractViewModelYamlDrafts(
  content: string,
  topicName: string,
  baseViewName?: string,
  requiredTargetFileName?: string,
  allowedTargetFileNames: string[] = []
): YamlDraft[] {
  const section =
    extractReviewSection(content, /model\s*\/\s*view builder output|view\s*\/\s*model builder output|view\s*\/\s*model yaml patches|view-level modeling scripts|modeling scripts/i) ||
    content;
  if (!section.trim()) return [];

  const drafts: YamlDraft[] = [];
  const requiredTarget = requiredTargetFileName ? cleanDeployTargetFileName(requiredTargetFileName) : '';
  const allowedTargets = uniqueStrings([
    ...allowedTargetFileNames.map(cleanDeployTargetFileName),
    requiredTarget,
  ].filter(Boolean), 8);
  const targetIsAllowed = (targetFileName: string) => !allowedTargets.length || allowedTargets.includes(targetFileName);
  const targetArtifactLabel = (targetFileName: string) => {
    if (targetFileName === 'model') return 'Settings/model YAML';
    return targetFileName.endsWith('.topic') ? 'Topic Permission YAML' : 'Model / View YAML';
  };
  extractCodeBlocksWithContext(section).forEach((block, index) => {
    const yaml = normalizeModelViewYaml(block.content);
    const targetFileName = inferViewModelTargetFileName(
      yaml,
      readDeployTargetFileName(block.before, block.content),
      topicName,
      baseViewName,
      requiredTarget
    );
    if (!targetIsAllowed(targetFileName)) return;
    if (!yamlLooksLikeTargetFile(yaml, targetFileName)) return;
    if (!yamlMatchesTargetFile(yaml, targetFileName)) return;
    drafts.push({
      id: `view-model-yaml-draft-${index + 1}`,
      label: targetArtifactLabel(targetFileName),
      description: `Deployable target-file artifact for ${targetFileName}.`,
      content: yaml,
      targetFileName,
    });
  });

  const lines = section.split('\n');
  lines.forEach((line, index) => {
    const targetFileName = readDeployTargetFileName(line);
    if (!targetFileName) return;
    if (!targetIsAllowed(targetFileName)) return;

    const yamlLines: string[] = [];
    for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex += 1) {
      const currentLine = lines[lineIndex];
      const trimmed = currentLine.trim();
      const normalizedHeading = stripInlineFormatting(trimmed).replace(/:$/, '').toLowerCase();

      if (!yamlLines.length && !trimmed) continue;
      if (/^```/.test(trimmed)) continue;
      if (/^target\s+file\s*:/i.test(stripInlineFormatting(trimmed))) break;
      if (
        yamlLines.length > 0 &&
        (
          /^assumptions?\s*(?:\/|and)\s*validations?/i.test(normalizedHeading) ||
          /^supporting review notes$/i.test(normalizedHeading) ||
          /^required response shape$/i.test(normalizedHeading) ||
          /^rules$/i.test(normalizedHeading) ||
          /^invalid previous response/i.test(normalizedHeading) ||
          /^[\w .'-]+ - ai semantic studio/i.test(normalizedHeading)
        )
      ) {
        break;
      }
      yamlLines.push(currentLine);
    }

    const yaml = normalizeModelViewYaml(yamlLines.join('\n'));
    if (!yamlLooksLikeTargetFile(yaml, targetFileName)) return;
    if (!yamlMatchesTargetFile(yaml, targetFileName)) return;
    drafts.push({
      id: `view-model-raw-yaml-draft-${index + 1}`,
      label: targetArtifactLabel(targetFileName),
      description: `Deployable target-file artifact for ${targetFileName}.`,
      content: yaml,
      targetFileName,
    });
  });

  return uniqueDrafts(drafts);
}

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={`${part}-${index}`} className="px-1 py-0.5 rounded bg-surface-secondary border border-border font-mono text-[0.92em]">{part.slice(1, -1)}</code>;
        }
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={`${part}-${index}`} className="font-semibold text-content-primary">{part.slice(2, -2)}</strong>;
        }
        return <span key={`${part}-${index}`}>{part}</span>;
      })}
    </>
  );
}

function MarkdownLite({ content }: { content: string }) {
  const lines = content.split('\n');
  const blocks: ReactNode[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;

    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      blocks.push(
        <pre key={`code-${i}`} className="bg-gradient-to-br from-omni-50 via-white to-omni-50 text-content-primary text-xs p-3 rounded-card overflow-auto max-h-72 font-mono leading-relaxed border border-omni-100">
          {codeLines.join('\n')}
        </pre>
      );
      continue;
    }

    if (/^#{1,4}\s+/.test(trimmed)) {
      blocks.push(
        <h4 key={`heading-${i}`} className="text-sm font-semibold text-content-primary mt-3 first:mt-0">
          <InlineText text={trimmed.replace(/^#{1,4}\s+/, '')} />
        </h4>
      );
      continue;
    }

    if (/^\|.*\|$/.test(trimmed)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        if (!/^\|\s*-+/.test(lines[i].trim())) {
          tableLines.push(lines[i].trim());
        }
        i += 1;
      }
      i -= 1;
      const rows = tableLines.map((tableLine) => tableLine.split('|').slice(1, -1).map((cell) => stripInlineFormatting(cell)));
      blocks.push(
        <div key={`table-${i}`} className="overflow-auto border border-border rounded-card">
          <table className="min-w-full text-xs">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`} className={rowIndex === 0 ? 'bg-surface-secondary font-semibold text-content-primary' : 'border-t border-border text-content-secondary'}>
                  {row.map((cell, cellIndex) => (
                    <td key={`cell-${cellIndex}`} className="px-3 py-2 align-top">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      const ordered = /^\d+\.\s+/.test(trimmed);
      while (i < lines.length && (ordered ? /^\d+\.\s+/.test(lines[i].trim()) : /^[-*]\s+/.test(lines[i].trim()))) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      i -= 1;
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(
        <ListTag key={`list-${i}`} className={`text-sm text-content-secondary space-y-1 ${ordered ? 'list-decimal' : 'list-disc'} pl-5`}>
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}><InlineText text={item} /></li>
          ))}
        </ListTag>
      );
      continue;
    }

    const paragraphLines = [trimmed];
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() &&
      lines[i + 1].trim() !== '---' &&
      !/^#{1,4}\s+/.test(lines[i + 1].trim()) &&
      !/^[-*]\s+/.test(lines[i + 1].trim()) &&
      !/^\d+\.\s+/.test(lines[i + 1].trim()) &&
      !/^\|.*\|$/.test(lines[i + 1].trim()) &&
      !lines[i + 1].trim().startsWith('```')
    ) {
      i += 1;
      paragraphLines.push(lines[i].trim());
    }
    blocks.push(
      <p key={`paragraph-${i}`} className="text-sm text-content-secondary leading-relaxed">
        <InlineText text={paragraphLines.join(' ')} />
      </p>
    );
  }

  return <div className="space-y-3">{blocks}</div>;
}

function ReadinessListCard({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  const displayItems = items.map(cleanGeneratedText).filter(Boolean).slice(0, 5);
  return (
    <div className="rounded-card border border-border bg-white p-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">{title}</div>
      <ul className="mt-2 space-y-1.5 text-xs text-content-secondary">
        {displayItems.length ? displayItems.map((item, index) => (
          <li key={`${title}-${index}`} className="flex gap-2 leading-relaxed">
            <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-omni-400 flex-shrink-0" />
            <span>{item}</span>
          </li>
        )) : (
          <li className="text-content-tertiary">No structured items returned.</li>
        )}
      </ul>
    </div>
  );
}

function ReadinessSummaryView({
  summary,
  rawMessage,
  onCopy,
  copied,
}: {
  summary: ReadinessSummary;
  rawMessage: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="rounded-card border border-omni-100 bg-omni-50 p-4 xl:col-span-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-omni-700">Readiness Verdict</div>
          <div className="mt-2 text-sm text-omni-800 leading-relaxed">
            {summary.verdict || 'Omni returned a baseline result. Review the structured sections below before continuing.'}
          </div>
        </div>
        <div className="rounded-card border border-border bg-white p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Baseline Scope</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">{summary.topic || 'Selected topic'}</div>
          <div className="mt-1 text-xs text-content-secondary">
            {summary.confidence ? `Confidence: ${summary.confidence}` : 'Confidence not returned'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <ReadinessListCard title="Questions To Support" items={summary.questions} />
        <ReadinessListCard title="Business Use Cases" items={summary.useCases} />
        <ReadinessListCard title="Business Rules" items={summary.businessRules} />
        <ReadinessListCard title="Gaps To Address" items={summary.gaps} />
      </div>

      <ReadinessListCard title="Out Of Scope / Route Away" items={summary.outOfScope} />

      {rawMessage && (
        <details className="rounded-card border border-border bg-white overflow-hidden">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-content-primary bg-surface-secondary border-b border-border">
            Full Omni response
          </summary>
          <div className="p-4 max-h-[360px] overflow-y-auto">
            <MarkdownLite content={rawMessage} />
          </div>
          <div className="px-3 py-2 border-t border-border bg-surface-secondary flex justify-end">
            <button type="button" onClick={onCopy} className="btn-secondary text-xs px-2 py-1.5">
              {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy Full Response'}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}

function ReviewSections({
  sections,
  onCopy,
  copiedResult,
}: {
  sections: ReviewSection[];
  onCopy: (id: string, value: string) => void;
  copiedResult: string | null;
}) {
  if (!sections.length) return null;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
      {sections.map((section) => (
        <details
          key={section.id}
          open={section.defaultOpen}
          className={`rounded-card border border-border bg-white overflow-hidden ${
            section.id === 'validations' ? 'xl:col-span-2' : ''
          }`}
        >
          <summary className="cursor-pointer px-3 py-2 border-b border-border bg-surface-secondary">
            <div className="inline-flex flex-col">
              <span className="text-xs font-semibold text-content-primary">{section.title}</span>
              <span className="text-[11px] text-content-secondary mt-0.5">{section.description}</span>
            </div>
          </summary>
          <div className="p-4 max-h-[360px] overflow-y-auto">
            <MarkdownLite content={section.content} />
          </div>
          <div className="px-3 py-2 border-t border-border bg-surface-secondary flex justify-end">
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCopy(`section-${section.id}`, section.content);
              }}
              className="btn-secondary text-xs px-2 py-1.5"
            >
              {copiedResult === `section-${section.id}` ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copiedResult === `section-${section.id}` ? 'Copied' : 'Copy Section'}
            </button>
          </div>
        </details>
      ))}
    </div>
  );
}

function YamlDraftCard({
  draft,
  copied,
  onCopy,
}: {
  draft: YamlDraft;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <details className="rounded-card border border-border bg-white overflow-hidden">
      <summary className="cursor-pointer px-3 py-2 border-b border-border bg-omni-50 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-content-primary">{draft.label}</div>
          <div className="text-[11px] text-content-secondary mt-0.5 truncate">{draft.description}</div>
          {draft.targetFileName && (
            <div className="mt-1 text-[10px] font-mono text-content-tertiary truncate">Target file: {draft.targetFileName}</div>
          )}
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCopy();
          }}
          className="btn-secondary text-xs px-2 py-1.5"
          aria-label={`Copy ${draft.label}`}
        >
          {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy YAML'}
        </button>
      </summary>
      <pre className="bg-gradient-to-br from-omni-50 via-white to-omni-50 text-content-primary text-xs p-4 overflow-auto max-h-96 font-mono leading-relaxed border-t border-omni-100">
        {draft.content}
      </pre>
    </details>
  );
}

function formatDeployReviewPath(fileName: string) {
  const clean = fileName.trim();
  if (!clean) return 'Select target file';
  if (clean === 'model') return 'Settings/model';
  if (clean === 'relationships') return 'Settings/relationships';
  if (clean.endsWith('.topic')) return `Topics/${clean}`;
  if (clean.endsWith('.view')) return clean.includes('/') ? clean : `Views/${clean}`;
  return clean;
}

function DeployDiffViewer({ diff }: { diff: DeployDiff }) {
  if (!diff.rows.length) {
    return (
      <div className="rounded-button border border-border bg-surface-secondary px-3 py-2 text-xs text-content-secondary">
        No line-level changes detected.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-b-card">
      <div className="grid grid-cols-[52px_52px_32px_minmax(0,1fr)] border-b border-border bg-white px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-content-secondary">
        <div>Main</div>
        <div>Dev</div>
        <div />
        <div>YAML diff</div>
      </div>
      <div className="max-h-[520px] overflow-auto bg-white font-mono text-[11px] leading-relaxed">
        {diff.rows.map((row, index) => {
          const isAdded = row.type === 'added';
          const isRemoved = row.type === 'removed';
          const rowClass = isAdded
            ? 'bg-green-50 text-green-950'
            : isRemoved
              ? 'bg-red-50 text-red-950'
              : 'bg-white text-content-primary';
          const gutterClass = isAdded
            ? 'bg-green-100 text-green-800'
            : isRemoved
              ? 'bg-red-100 text-red-800'
              : 'bg-surface-secondary text-content-tertiary';
          const sign = isAdded ? '+' : isRemoved ? '-' : ' ';

          return (
            <div
              key={`${row.type}-${row.beforeLine || ''}-${row.afterLine || ''}-${index}`}
              className={`grid grid-cols-[52px_52px_32px_minmax(0,1fr)] border-b border-border/60 ${rowClass}`}
            >
              <div className={`select-none px-2 py-1 text-right ${gutterClass}`}>{row.beforeLine || ''}</div>
              <div className={`select-none px-2 py-1 text-right ${gutterClass}`}>{row.afterLine || ''}</div>
              <div className={`select-none px-2 py-1 text-center font-bold ${gutterClass}`}>{sign}</div>
              <pre className="min-w-0 overflow-x-auto whitespace-pre-wrap px-3 py-1">{row.text || ' '}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EditableList({
  label,
  description,
  values,
  placeholder,
  onChange,
  details,
  detailPlaceholder,
  onDetailsChange,
  defaultOpen = true,
}: {
  label: string;
  description: string;
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
  details?: string[];
  detailPlaceholder?: string;
  onDetailsChange?: (values: string[]) => void;
  defaultOpen?: boolean;
}) {
  const detailValues = details || [];

  function updateValue(index: number, value: string) {
    onChange(values.map((item, itemIndex) => (itemIndex === index ? value : item)));
  }

  function updateDetail(index: number, value: string) {
    if (!onDetailsChange) return;
    const next = values.map((_, itemIndex) => detailValues[itemIndex] || '');
    next[index] = value;
    onDetailsChange(next);
  }

  function removeValue(index: number) {
    const next = values.filter((_, itemIndex) => itemIndex !== index);
    onChange(next.length ? next : ['']);
    if (onDetailsChange) {
      const nextDetails = detailValues.filter((_, itemIndex) => itemIndex !== index);
      onDetailsChange(nextDetails.length ? nextDetails : ['']);
    }
  }

  function addValue() {
    onChange([...values, '']);
    if (onDetailsChange) {
      onDetailsChange([...detailValues, '']);
    }
  }

  return (
    <details open={defaultOpen} className="rounded-card border border-border bg-white overflow-hidden">
      <summary className="cursor-pointer list-none px-3 py-3 bg-white hover:bg-surface-secondary transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-content-primary">{label}</div>
            <div className="text-[11px] text-content-secondary mt-0.5">{description}</div>
          </div>
          <span className="text-[10px] px-2 py-1 rounded-chip bg-surface-secondary text-content-secondary flex-shrink-0">
            {values.filter((value) => value.trim()).length || values.length} item{values.length === 1 ? '' : 's'}
          </span>
        </div>
      </summary>
      <div className="px-3 pb-3 space-y-2">
        <div className="space-y-2">
          {values.map((value, index) => (
            <div key={`${label}-${index}`} className="rounded-button border border-border bg-surface-secondary p-2 space-y-2">
              <div className="flex gap-2">
                <input
                  value={value}
                  onChange={(event) => updateValue(index, event.target.value)}
                  className="input-field text-xs bg-white"
                  placeholder={placeholder}
                />
                <button
                  type="button"
                  onClick={() => removeValue(index)}
                  className="btn-secondary px-2"
                  aria-label={`Remove ${label} item`}
                >
                  <X size={13} />
                </button>
              </div>
              {onDetailsChange && (
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">
                    Admin input / expected answer
                  </div>
                  <textarea
                    value={detailValues[index] || ''}
                    onChange={(event) => updateDetail(index, event.target.value)}
                    className="input-field text-xs min-h-[74px] resize-y bg-white"
                    placeholder={detailPlaceholder || 'Add admin input, expected answer, definitions, or acceptance criteria...'}
                    aria-label={`${label} admin input ${index + 1}`}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addValue}
          className="text-xs text-omni-700 hover:text-omni-900 font-medium"
        >
          Add item
        </button>
      </div>
    </details>
  );
}

function ManualCopyFallback({
  manualCopy,
  onClose,
}: {
  manualCopy: ManualCopy;
  onClose: () => void;
}) {
  return (
    <div className="rounded-card border border-amber-200 bg-amber-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-amber-900">Copy blocked by browser privacy</div>
          <div className="text-[11px] text-amber-800 mt-0.5">
            The content is ready. Open the fallback only if the browser did not place the {manualCopy.label} on your clipboard.
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-amber-700 hover:text-amber-900">
          <X size={14} />
        </button>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-amber-900">Open manual fallback</summary>
        <textarea
          readOnly
          value={manualCopy.value}
          onFocus={(event) => event.currentTarget.select()}
          className="mt-2 input-field min-h-[120px] max-h-[260px] font-mono text-xs bg-white"
          aria-label={`Manual copy ${manualCopy.label}`}
        />
      </details>
    </div>
  );
}

export function TopicsPage() {
  const { connection } = useConnection();
  const [studioMode, setStudioMode] = useState<'builders' | 'migration'>('builders');
  const [models, setModels] = useState<OmniModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedTopicName, setSelectedTopicName] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [includeBranches, setIncludeBranches] = useState(false);
  const [topicSearch, setTopicSearch] = useState('');
  const [topics, setTopics] = useState<TopicEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [error, setError] = useState('');
  const [topicDetails, setTopicDetails] = useState<Record<string, Record<string, unknown>>>({});
  const [showForm, setShowForm] = useState(false);
  const [editTopic, setEditTopic] = useState<{ name: string; data: string } | null>(null);
  const [viewTopic, setViewTopic] = useState<Record<string, unknown> | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [studioStep, setStudioStep] = useState<StudioStep>('scope');
  const [selectedStudioPath, setSelectedStudioPath] = useState<StudioPathSelection>('');
  const [targetBaseViewName, setTargetBaseViewName] = useState('');
  const [targetFileSearch, setTargetFileSearch] = useState('');
  const [modelFileOptions, setModelFileOptions] = useState<string[]>([]);
  const [loadingModelFiles, setLoadingModelFiles] = useState(false);
	  const [selectedWorkstreams, setSelectedWorkstreams] = useState<WorkstreamId[]>([]);
	  const [aiPrompt, setAiPrompt] = useState('');
	  const [aiFocusTopic, setAiFocusTopic] = useState('');
	  const [aiLastMode, setAiLastMode] = useState<AiResultMode>(null);
  const [aiError, setAiError] = useState('');
  const [aiPickedTopic, setAiPickedTopic] = useState('');
  const [aiConversationId, setAiConversationId] = useState('');
  const [aiPackageConversationId, setAiPackageConversationId] = useState('');
  const [readinessCompleted, setReadinessCompleted] = useState(false);
  const [readinessBaselineMessage, setReadinessBaselineMessage] = useState('');
  const [readinessBaselineStatus, setReadinessBaselineStatus] = useState('');
  const [readinessBaselineChatUrl, setReadinessBaselineChatUrl] = useState('');
  const [readinessInputs, setReadinessInputs] = useState<ReadinessInputs>(EMPTY_READINESS_INPUTS);
  const [aiJob, setAiJob] = useState<OmniAiJob | null>(null);
  const [aiJobResult, setAiJobResult] = useState<OmniAiJobResult | null>(null);
  const [copiedResult, setCopiedResult] = useState<string | null>(null);
  const [copyError, setCopyError] = useState('');
  const [manualCopy, setManualCopy] = useState<ManualCopy | null>(null);
  const [focusNotice, setFocusNotice] = useState('');
  const [deepReviewRunning, setDeepReviewRunning] = useState(false);
  const [deepReviewChunks, setDeepReviewChunks] = useState<DeepReviewChunkState[]>(initialDeepReviewChunks);
  const [deepReviewSummary, setDeepReviewSummary] = useState('');
  const [deepReviewFinalMessage, setDeepReviewFinalMessage] = useState('');
  const [deepReviewError, setDeepReviewError] = useState('');
  const [deployStatus, setDeployStatus] = useState<DeployStatus>('idle');
  const [deployBranchName, setDeployBranchName] = useState('');
  const [deployBranchNameEdited, setDeployBranchNameEdited] = useState(false);
  const [deployBranchId, setDeployBranchId] = useState('');
  const [deployFiles, setDeployFiles] = useState<DeployFileDraft[]>([]);
  const [deployMainYaml, setDeployMainYaml] = useState<OmniModelYamlResponse | null>(null);
  const [deployDevYaml, setDeployDevYaml] = useState<OmniModelYamlResponse | null>(null);
  const [deployDiffs, setDeployDiffs] = useState<DeployDiff[]>([]);
  const [deployValidation, setDeployValidation] = useState<Array<{ message?: string; is_warning?: boolean; yaml_path?: string }> | null>(null);
  const [deployMainContentValidation, setDeployMainContentValidation] = useState<Record<string, unknown> | null>(null);
  const [deployContentValidation, setDeployContentValidation] = useState<Record<string, unknown> | null>(null);
  const [deployError, setDeployError] = useState('');
  const [deployReviewAcknowledged, setDeployReviewAcknowledged] = useState(false);

  async function loadModelFileOptions(modelId: string, path: StudioPathSelection = selectedStudioPath) {
    if (!modelId) {
      setModelFileOptions([]);
      return;
    }
    setLoadingModelFiles(true);
    try {
      const yaml = await getModelYaml(connection.baseUrl, connection.apiKey, modelId).catch(() => null);
      const fileNames = Object.keys(yaml?.files || {});
      const supported = fileNames.filter((fileName) => {
        if (path === 'permissions') {
          return fileName === 'model' || fileName.endsWith('.topic') || fileName.endsWith('.view');
        }
        return fileName === 'model' || fileName === 'relationships' || fileName.endsWith('.view');
      });
      const pinnedTargets = path === 'permissions' ? ['model'] : ['model', 'relationships'];
      setModelFileOptions(uniqueStrings([...pinnedTargets, ...supported], 120));
    } finally {
      setLoadingModelFiles(false);
    }
  }

  useEffect(() => {
    async function fetchModels() {
      setLoading(true);
      try {
        const res = await listModels(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 });
        setModels(Array.isArray(res.models) ? res.models : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load models');
      } finally {
        setLoading(false);
      }
    }
    fetchModels();
  }, [connection.baseUrl, connection.apiKey]);

  useEffect(() => {
    const modelId = selectedModelId;
    const detailKey = selectedTopicName ? topicDetailKey(selectedTopicName, modelId) : '';
    if (!modelId || !selectedTopicName || topicDetails[detailKey]) return;
    let cancelled = false;

    async function fetchSelectedTopicDetail() {
      try {
        const data = await getTopic(connection.baseUrl, connection.apiKey, modelId, selectedTopicName);
        if (!cancelled) {
          setTopicDetails((prev) => ({ ...prev, [detailKey]: data }));
        }
      } catch {
        // Topic detail is advisory for the inspector and prompt context; keep the workflow usable if it cannot load.
      }
    }

    fetchSelectedTopicDetail();
    return () => {
      cancelled = true;
    };
  }, [connection.baseUrl, connection.apiKey, selectedModelId, selectedTopicName, topicDetails]);

  async function fetchTopicDetail(topicName: string, modelId = selectedModelId) {
    const detailKey = topicDetailKey(topicName, modelId);
    if (topicDetails[detailKey]) return topicDetails[detailKey];
    if (!modelId) return null;
    try {
      const data = await getTopic(connection.baseUrl, connection.apiKey, modelId, topicName);
      setTopicDetails((prev) => ({ ...prev, [detailKey]: data }));
      return data;
    } catch {
      return null;
    }
  }

  function resetAiConversation() {
    setAiConversationId('');
    setAiPackageConversationId('');
    setAiJob(null);
    setAiJobResult(null);
    setAiLastMode(null);
    setReadinessCompleted(false);
    setReadinessBaselineMessage('');
    setReadinessBaselineStatus('');
    setReadinessBaselineChatUrl('');
    setReadinessInputs(EMPTY_READINESS_INPUTS);
    setCopiedResult(null);
    setCopyError('');
    setManualCopy(null);
    setFocusNotice('');
    setDeepReviewRunning(false);
    setDeepReviewChunks(initialDeepReviewChunks());
    setDeepReviewSummary('');
    setDeepReviewFinalMessage('');
    setAiPackageConversationId('');
    setDeepReviewError('');
    setDeployStatus('idle');
    setDeployBranchName('');
    setDeployBranchId('');
    setDeployFiles([]);
    setDeployDiffs([]);
    setDeployValidation(null);
    setDeployMainContentValidation(null);
    setDeployContentValidation(null);
    setDeployError('');
    setDeployReviewAcknowledged(false);
  }

  function isModelEligibleForStudio(model: OmniModel) {
    return !model.kind || ['SHARED', 'SHARED_EXTENSION'].includes(model.kind) || (includeBranches && model.kind === 'BRANCH');
  }

  async function loadTopicsForModel(modelId: string) {
    setLoadingTopics(true);
    setError('');
    setTopics([]);
    setTopicDetails({});
    setSelectedTopicName('');
    setAiFocusTopic('');
    setAiPickedTopic('');

    if (!modelId) {
      setLoadingTopics(false);
      return;
    }

    try {
      const nextTopics = await listTopics(connection.baseUrl, connection.apiKey, modelId);
      setTopics(nextTopics);

      // Leave topic selection empty by default so admins can intentionally
      // create a new .topic candidate instead of accidentally updating the
      // first existing topic returned by Omni.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load topics for this model');
      setTopics([]);
    } finally {
      setLoadingTopics(false);
    }
  }

  async function handleModelSelect(modelId: string) {
    setSelectedModelId(modelId);
    setSelectedTopicName('');
    setTopics([]);
    setTopicDetails({});
    setAiFocusTopic('');
    setAiPickedTopic('');
    setTargetBaseViewName('');
    setTargetFileSearch('');
    setModelFileOptions([]);
    resetAiConversation();
    if (!modelId) return;
    if (pathIncludesTopic(selectedStudioPath)) {
      await loadTopicsForModel(modelId);
    }
    if (pathUsesTargetSemanticFile(selectedStudioPath)) {
      await loadModelFileOptions(modelId, selectedStudioPath);
    }
  }

  function handleStudioPathSelect(path: StudioPath) {
    setSelectedStudioPath(path);
    setSelectedWorkstreams(defaultWorkstreamsForPath(path));
    resetAiConversation();
    setTargetBaseViewName('');
    setTargetFileSearch('');
    setModelFileOptions([]);
    if (pathUsesTargetSemanticFile(path)) {
      setSelectedTopicName('');
      setTopics([]);
      setTopicDetails({});
      setAiFocusTopic('');
      setAiPickedTopic('');
      if (selectedModelId) loadModelFileOptions(selectedModelId, path);
      return;
    }

    if (selectedModelId) {
      loadTopicsForModel(selectedModelId);
    }
  }

  async function handleDeleteTopic() {
    if (!deleteTarget || !selectedModelId) return;
    try {
      await deleteTopic(connection.baseUrl, connection.apiKey, selectedModelId, deleteTarget);
      setTopics((prev) => prev.filter((t) => t.name !== deleteTarget));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setDeleteTarget(null);
    }
  }

  function handleRefresh() {
    if (selectedModelId && selectedStudioPath === 'topic') loadTopicsForModel(selectedModelId);
    if (selectedModelId && pathUsesTargetSemanticFile(selectedStudioPath)) loadModelFileOptions(selectedModelId, selectedStudioPath);
  }

  function handleAiPromptChange(value: string) {
    setAiPrompt(value);
    if (aiConversationId) {
      resetAiConversation();
    }
  }

  function updateReadinessInputs(patch: Partial<ReadinessInputs>) {
    setReadinessInputs((prev) => ({ ...prev, ...patch }));
  }

  async function waitForAiJob(jobId: string, pollIntervalMs = 3000, maxPolls = 30) {
    let latest: OmniAiJob | null = null;
    for (let i = 0; i < maxPolls; i += 1) {
      latest = await getAiJob(connection.baseUrl, connection.apiKey, jobId);
      setAiJob((prev) => ({ ...(prev || {}), ...latest }));
      const state = normalizeAiState(latest.state || latest.status);
      if (['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELED'].includes(state)) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return latest;
  }

  async function getAiJobResultWithFallback(jobId: string, finalJob: OmniAiJob | null, retryIntervalMs = 3000) {
    const fallbackFromFinalJob = jobToResult(finalJob);
    let lastError: unknown = null;

    for (let i = 0; i < 10; i += 1) {
      try {
        const result = await getAiJobResult(connection.baseUrl, connection.apiKey, jobId);
        if (hasAiResultContent(result, finalJob)) {
          return result;
        }
        lastError = new Error('Omni AI job completed, but the result payload was empty.');
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
      } catch (err) {
        lastError = err;
        const shouldRetry =
          err instanceof ApiError &&
          (err.status === 404 || err.status === 429 || err.status === 500 || err.status === 503);
        if (!shouldRetry) break;
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
      }
    }

    const latest = await getAiJob(connection.baseUrl, connection.apiKey, jobId).catch(() => null);
    const fallback = jobToResult(latest) || fallbackFromFinalJob;
    if (fallback) return fallback;

    if (lastError instanceof ApiError && lastError.status === 404) {
      throw new Error('Omni has not exposed the result stream through the API yet. Open the Omni chat result, or try the action again in a moment.');
    }
    throw lastError instanceof Error ? lastError : new Error('AI job result was not available yet.');
  }

  function updateDeepReviewChunk(id: DeepReviewChunkId, patch: Partial<DeepReviewChunkState>) {
    setDeepReviewChunks((prev) => prev.map((chunk) => (chunk.id === id ? { ...chunk, ...patch } : chunk)));
  }

  async function createAiJobWithRetry(params: {
    prompt: string;
    topicName?: string;
    conversationId?: string;
  }) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await createAiJob(connection.baseUrl, connection.apiKey, {
	        modelId: selectedModel?.id || '',
	        prompt: params.prompt,
	        topicName: params.topicName,
	        conversationId: params.conversationId,
	      });
      } catch (err) {
        lastError = err;
        const retryable = err instanceof ApiError && [429, 500, 502, 503].includes(err.status);
        if (!retryable || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 8000));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('AI job failed to start.');
  }

  async function runAiPrompt(params: {
    prompt: string;
    topicName?: string;
    conversationId?: string;
    pollIntervalMs?: number;
  }) {
    const created = await createAiJobWithRetry(params);
    setAiJob(created);

    const jobId = created.jobId || created.id;
    if (!jobId) throw new Error('Omni did not return an AI job ID.');

    const createdConversationId = readFirstString(created, ['conversationId', 'conversation_id']);
    const finalJob = await waitForAiJob(jobId, params.pollIntervalMs, 36);
    const finalState = normalizeAiState(finalJob?.state || finalJob?.status);
    const finalConversationId = readFirstString(finalJob, ['conversationId', 'conversation_id']) || createdConversationId;
    const terminalStates = ['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELED'];

    if (!terminalStates.includes(finalState)) {
      throw new Error('Omni AI did not finish this response within the expected time. This can happen with the known Blobby "continue" issue; open the Omni chat, ask it to continue, then retry this chunk/package from OmniKit.');
    }

    if (['FAILED', 'CANCELLED', 'CANCELED'].includes(finalState)) {
      throw new Error(`Omni AI job ${finalState.toLowerCase()}.`);
    }

    const result = await getAiJobResultWithFallback(jobId, finalJob, params.pollIntervalMs || 3000);
    const message = extractAiMessage(result, finalJob);
    const chatUrl =
      readFirstString(result, ['omniChatUrl', 'omni_chat_url']) ||
      readFirstString(finalJob, ['omniChatUrl', 'omni_chat_url']) ||
      readFirstString(created, ['omniChatUrl', 'omni_chat_url']);

    return {
      created,
      finalJob,
      result,
      message,
      chatUrl,
      jobId,
      conversationId: finalConversationId,
      topic: result.topic,
    };
  }

  async function handleRunDeepReview() {
	    if (!selectedModel || !selectedStudioPath || !modelTargetReady || deepReviewRunning) return;
	    const workflowPath = selectedStudioPath;
    const targetView = targetBaseViewName.trim();
    const permissionTopicName = pathIncludesPermissions(workflowPath) && targetView.endsWith('.topic')
      ? topicNameFromTargetFile(targetView)
      : undefined;
	    const topicName = pathIncludesTopic(workflowPath) ? aiFocusTopic || aiPickedTopic || selectedTopicName || undefined : permissionTopicName;
	    const isNewTopicCandidate = pathIncludesTopic(workflowPath) && !topicName;
	    if (isNewTopicCandidate && newTopicBriefItemCount === 0) {
	      setDeepReviewError('Add at least one question, use case, goal, or admin note before asking Omni AI to recommend a new topic.');
	      return;
	    }
    const promptTopic = topicName
      ? topics.find((topic) => topic.name === topicName)
      : null;
    const topicTitle = workflowPath === 'permissions'
      ? `${selectedModel.name} - Permission Builder`
      : workflowPath === 'model'
        ? `${selectedModel.name} - Model / View Builder`
        : buildPromptTopicTitle(topicName, promptTopic?.label);
    const workstreamSummary = formatWorkstreamFocus(selectedWorkstreams, workflowPath);
    const businessQuestion = aiPrompt.trim();
    let workingChunks = initialDeepReviewChunks();
    let workingConversationId = aiConversationId || '';

    setDeepReviewRunning(true);
    setDeepReviewChunks(workingChunks);
    setDeepReviewSummary('');
    setDeepReviewFinalMessage('');
    setAiPackageConversationId('');
    setDeepReviewError('');
    setAiError('');
    setAiJob(null);
    setAiJobResult(null);
    setAiLastMode(null);
    setCopiedResult(null);
    setCopyError('');
    setManualCopy(null);
    setFocusNotice('');

    try {
      const topicDetail = topicName && pathIncludesTopic(workflowPath) ? await fetchTopicDetail(topicName, selectedModel.id) : null;
      const topicSourceContext = pathIncludesTopic(workflowPath)
        ? buildTopicSourceContext(topicName, asRecord(topicDetail))
        : 'Topic Builder context: not selected. Keep topic YAML out of the deployable output.';
      const shouldLoadModelDiscoveryContext = pathUsesTargetSemanticFile(workflowPath) || (pathIncludesTopic(workflowPath) && !topicName);
      const modelYaml = shouldLoadModelDiscoveryContext
        ? await getModelYaml(connection.baseUrl, connection.apiKey, selectedModel.id).catch(() => null)
        : null;
      const modelSourceContext = pathUsesTargetSemanticFile(workflowPath)
        ? buildModelSourceContext(modelYaml, targetView || selectedTopicBaseView || undefined, workflowPath, { includeTargetYaml: false })
        : !topicName
          ? buildTopicBuilderModelDiscoveryContext(modelYaml)
          : 'Model / View Builder context: not selected. Keep model, relationships, and view-file changes out of the deployable output unless they are explicitly required.';

      const reviewChunks = DEEP_REVIEW_CHUNKS.filter((chunk) => REVIEW_CHUNK_IDS.includes(chunk.id));
      for (let index = 0; index < reviewChunks.length; index += 1) {
        const chunk = reviewChunks[index];
        const chunkIndex = DEEP_REVIEW_CHUNKS.findIndex((item) => item.id === chunk.id);
        const startedAt = Date.now();
        updateDeepReviewChunk(chunk.id, { status: 'running', error: undefined, startedAt, finishedAt: undefined });
        workingChunks = workingChunks.map((existing) => (existing.id === chunk.id ? { ...existing, status: 'running', error: undefined, startedAt, finishedAt: undefined } : existing));

        const prompt = buildDeepReviewChunkPrompt({
          chunkId: chunk.id,
          studioPath: workflowPath,
          topicTitle,
          workstreamSummary,
          modelName: selectedModel.name,
          modelId: selectedModel.id,
          topicName,
          targetBaseViewName: targetView || selectedTopicBaseView || undefined,
          businessQuestion,
          topics,
          readinessInputSummary: formatReadinessInputs(readinessInputs, workflowPath === 'permissions' ? 'permission target' : workflowPath === 'model' ? 'model/view' : 'topic'),
          previousSummary: buildPreviousChunkSummary(workingChunks),
          topicSourceContext,
          modelSourceContext,
        });

        const outcome = await runAiPrompt({
          prompt,
          topicName: pathIncludesTopic(workflowPath) || pathIncludesPermissions(workflowPath) ? topicName : undefined,
          conversationId: workingConversationId || undefined,
          pollIntervalMs: DEEP_REVIEW_POLL_INTERVAL_MS,
        });

        if (outcome.conversationId) {
          workingConversationId = outcome.conversationId;
          setAiConversationId(outcome.conversationId);
        }

        if (outcome.chatUrl && chunk.id === 'probe') {
          setReadinessBaselineChatUrl(outcome.chatUrl);
        }

        const parsed = chunk.id === 'final-yaml' ? null : tryParseJsonBlock(outcome.message);
        const nextChunk: DeepReviewChunkState = {
          ...workingChunks[chunkIndex],
          status: 'complete',
          jobId: outcome.jobId,
          message: outcome.message,
          parsed,
          finishedAt: Date.now(),
        };
        workingChunks = workingChunks.map((existing) => (existing.id === chunk.id ? nextChunk : existing));
        setDeepReviewChunks(workingChunks);

        if (chunk.id === 'probe') {
          setReadinessCompleted(Boolean(outcome.message));
          setReadinessBaselineStatus('COMPLETE');
          setReadinessBaselineMessage(outcome.message);
          const derivedInputs = deriveReadinessInputs(outcome.message);
          setReadinessInputs((current) => mergeReadinessInputs(current, derivedInputs, { preferDerived: true }));
          if (outcome.topic && pathIncludesTopic(workflowPath)) {
            setAiPickedTopic(outcome.topic);
            setAiFocusTopic(outcome.topic);
          }
        }

        if (index < reviewChunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, DEEP_REVIEW_COOLDOWN_MS));
        }
      }

      setDeepReviewSummary(buildDeepReviewUnionSummary(workingChunks));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token-safe deep review failed.';
      setDeepReviewError(message);
      setDeepReviewChunks((prev) => prev.map((chunk) => (chunk.status === 'running' ? { ...chunk, status: 'failed', error: message, finishedAt: Date.now() } : chunk)));
    } finally {
      setDeepReviewRunning(false);
    }
  }

  async function handleGenerateFinalPackage() {
    if (!selectedModel || !selectedStudioPath || !modelTargetReady || deepReviewRunning) return;
    const workflowPath = selectedStudioPath;
    const targetView = targetBaseViewName.trim();
    const permissionTopicName = pathIncludesPermissions(workflowPath) && targetView.endsWith('.topic')
      ? topicNameFromTargetFile(targetView)
      : undefined;
    const topicName = pathIncludesTopic(workflowPath) ? aiFocusTopic || aiPickedTopic || selectedTopicName || undefined : permissionTopicName;
    const promptTopic = topicName
      ? topics.find((topic) => topic.name === topicName)
      : null;
    const topicTitle = workflowPath === 'permissions'
      ? `${selectedModel.name} - Permission Builder`
      : workflowPath === 'model'
        ? `${selectedModel.name} - Model / View Builder`
        : buildPromptTopicTitle(topicName, promptTopic?.label);
    const workstreamSummary = formatWorkstreamFocus(selectedWorkstreams, workflowPath);
    const businessQuestion = aiPrompt.trim();
    let workingChunks = deepReviewChunks;
    // Package generation is isolated from the review conversation, but package
    // retries reuse one package thread so we do not create a new Omni chat for
    // every Generate click.
    let workingConversationId = aiPackageConversationId || '';

    setDeepReviewRunning(true);
    setDeepReviewError('');
    setDeepReviewFinalMessage('');
    setAiError('');
    setAiJob(null);
    setAiJobResult(null);
    setAiLastMode(null);
    setDeployFiles([]);
    setDeployDiffs([]);
    setDeployValidation(null);
    setDeployMainContentValidation(null);
    setDeployContentValidation(null);
    setDeployReviewAcknowledged(false);
    setDeployStatus('idle');
    setCopiedResult(null);
    setCopyError('');
    setManualCopy(null);

    try {
      const packageReadinessInputSummary = formatReadinessInputs(readinessInputs, workflowPath === 'permissions' ? 'permission target' : workflowPath === 'model' ? 'model/view' : 'topic');
      const topicDetail = topicName && pathIncludesTopic(workflowPath) ? await fetchTopicDetail(topicName, selectedModel.id) : null;
      const shouldLoadModelDiscoveryContext = pathUsesTargetSemanticFile(workflowPath) || pathIncludesTopic(workflowPath);
      const modelYaml = shouldLoadModelDiscoveryContext
        ? await getModelYaml(connection.baseUrl, connection.apiKey, selectedModel.id).catch(() => null)
        : null;
      const currentTopicYamlFile = pathIncludesTopic(workflowPath)
        ? findTopicYamlFile(modelYaml, topicName)
        : null;
      const topicSourceContext = pathIncludesTopic(workflowPath)
        ? buildTopicSourceContext(topicName, asRecord(topicDetail), {
            currentTopicYaml: currentTopicYamlFile?.yaml || '',
            includeCurrentYaml: Boolean(topicName),
            maxYamlChars: 18_000,
          })
        : 'Topic Builder context: not selected. Keep topic YAML out of the deployable output.';
      const modelSourceContext = pathUsesTargetSemanticFile(workflowPath)
        ? buildModelSourceContext(modelYaml, targetView || selectedTopicBaseView || undefined, workflowPath, { includeTargetYaml: true, maxYamlChars: 18_000 })
        : !topicName
          ? buildTopicBuilderModelDiscoveryContext(modelYaml)
          : 'Model / View Builder context: not selected. Keep model, relationships, and view-file changes out of the deployable output unless they are explicitly required.';
      const chunk = DEEP_REVIEW_CHUNKS.find((item) => item.id === FINAL_PACKAGE_CHUNK_ID);
      if (!chunk) throw new Error('Final package chunk is not configured.');

      const startedAt = Date.now();
      updateDeepReviewChunk(chunk.id, { status: 'running', error: undefined, startedAt, finishedAt: undefined });
      workingChunks = workingChunks.map((existing) => (existing.id === chunk.id ? { ...existing, status: 'running', error: undefined, startedAt, finishedAt: undefined } : existing));
      const packageChangeSummary = buildPackageChangeSummary(workingChunks, workflowPath);
      const targetFileForRepair = pathUsesTargetSemanticFile(workflowPath)
        ? targetView || selectedTopicBaseView || undefined
        : currentTopicYamlFile?.fileName || (topicName ? `${topicName}.topic` : undefined);
      const packageScopeForRepair = pathUsesTargetSemanticFile(workflowPath)
        ? selectedModel.name || targetFileForRepair || 'model'
        : topicName || 'new_topic_candidate';
      const packageViewForRepair = targetView || selectedTopicBaseView || packageScopeForRepair;
      const expectedTargetFilesForRepair = expectedPackageTargetFiles(workflowPath, targetFileForRepair);

      const deterministicPermissionPackage = workflowPath === 'permissions' && targetFileForRepair?.endsWith('.topic')
        ? buildDeterministicPermissionTopicPackage({
            targetFileName: targetFileForRepair,
            sourceModelYaml: modelYaml?.files?.model || '',
            sourceTargetYaml: modelYaml?.files?.[targetFileForRepair] || currentTopicYamlFile?.yaml || '',
            readinessInputSummary: packageReadinessInputSummary,
            businessQuestion,
            previousSummary: packageChangeSummary,
          })
        : null;

      if (deterministicPermissionPackage?.message) {
        const packageLintIssues = packageLintIssuesFromMessage({
          message: deterministicPermissionPackage.message,
          workflowPath,
          packageScopeName: packageScopeForRepair,
          packageViewName: packageViewForRepair,
          targetFileName: targetFileForRepair,
          topicName,
          readinessInputSummary: packageReadinessInputSummary,
          sourceContext: modelSourceContext,
        });
        if (packageLintIssues.length > 0) {
          throw new Error(`Deterministic Permission package failed preflight lint:\n${packageLintIssues.map((issue) => `- ${issue}`).join('\n')}`);
        }

        const existingFinalChunk = workingChunks.find((existing) => existing.id === chunk.id) || { ...chunk, status: 'pending' as DeepReviewChunkStatus };
        const nextChunk: DeepReviewChunkState = {
          ...existingFinalChunk,
          id: chunk.id,
          label: chunk.label,
          description: chunk.description,
          status: 'complete',
          jobId: 'deterministic-permission-package',
          message: deterministicPermissionPackage.message,
          parsed: null,
          finishedAt: Date.now(),
        };
        workingChunks = workingChunks.map((existing) => (existing.id === chunk.id ? nextChunk : existing));
        setDeepReviewChunks(workingChunks);
        setDeepReviewFinalMessage(deterministicPermissionPackage.message);
        setAiLastMode('final-yaml');
        setStudioStep('package');
        return;
      }

      const prompt = buildDeepReviewChunkPrompt({
        chunkId: chunk.id,
        studioPath: workflowPath,
        topicTitle,
        workstreamSummary,
        modelName: selectedModel.name,
        modelId: selectedModel.id,
        topicName,
        targetBaseViewName: targetView || selectedTopicBaseView || undefined,
        businessQuestion,
        topics,
        readinessInputSummary: packageReadinessInputSummary,
        previousSummary: packageChangeSummary,
        topicSourceContext,
        modelSourceContext,
      });

      let outcome = await runAiPrompt({
        prompt,
        topicName: pathIncludesTopic(workflowPath) || pathIncludesPermissions(workflowPath) ? topicName : undefined,
        conversationId: workingConversationId || undefined,
        pollIntervalMs: DEEP_REVIEW_POLL_INTERVAL_MS,
      });

      if (outcome.conversationId) {
        workingConversationId = outcome.conversationId;
        setAiPackageConversationId(outcome.conversationId);
      }

      let capturedDraftCount = pathUsesTargetSemanticFile(workflowPath)
        ? extractViewModelYamlDrafts(outcome.message, packageScopeForRepair, packageViewForRepair, targetFileForRepair || '', expectedTargetFilesForRepair).length
        : extractYamlDrafts(outcome.message, 'final-yaml').length;
      let packageLintIssues = capturedDraftCount > 0
        ? packageLintIssuesFromMessage({
            message: outcome.message,
            workflowPath,
            packageScopeName: packageScopeForRepair,
            packageViewName: packageViewForRepair,
            targetFileName: targetFileForRepair,
            topicName,
            readinessInputSummary: packageReadinessInputSummary,
            sourceContext: modelSourceContext,
          })
        : [];

      if (capturedDraftCount === 0 || packageLintIssues.length > 0) {
        const repairPrompt = buildPackageRepairPrompt({
          studioPath: workflowPath,
          topicTitle,
          modelName: selectedModel.name,
          modelId: selectedModel.id,
          topicName,
          targetFileName: targetFileForRepair,
          readinessInputSummary: packageReadinessInputSummary,
          previousSummary: packageChangeSummary,
          topicSourceContext,
          modelSourceContext,
          invalidResponse: outcome.message,
          invalidReasons: packageLintIssues,
        });
        outcome = await runAiPrompt({
          prompt: repairPrompt,
          topicName: pathIncludesTopic(workflowPath) || pathIncludesPermissions(workflowPath) ? topicName : undefined,
          conversationId: workingConversationId || undefined,
          pollIntervalMs: DEEP_REVIEW_POLL_INTERVAL_MS,
        });
        if (outcome.conversationId) {
          workingConversationId = outcome.conversationId;
          setAiPackageConversationId(outcome.conversationId);
        }
        capturedDraftCount = pathUsesTargetSemanticFile(workflowPath)
          ? extractViewModelYamlDrafts(outcome.message, packageScopeForRepair, packageViewForRepair, targetFileForRepair || '', expectedTargetFilesForRepair).length
          : extractYamlDrafts(outcome.message, 'final-yaml').length;
        packageLintIssues = capturedDraftCount > 0
          ? packageLintIssuesFromMessage({
              message: outcome.message,
              workflowPath,
              packageScopeName: packageScopeForRepair,
              packageViewName: packageViewForRepair,
              targetFileName: targetFileForRepair,
              topicName,
              readinessInputSummary: packageReadinessInputSummary,
              sourceContext: modelSourceContext,
            })
          : [];
      }
      if (capturedDraftCount === 0) {
        throw new Error('Final package generation did not return a deployable YAML block after repair.');
      }
      if (packageLintIssues.length > 0) {
        throw new Error(`Final package generated YAML that still needs repair before Deploy:\n${packageLintIssues.map((issue) => `- ${issue}`).join('\n')}`);
      }

      const existingFinalChunk = workingChunks.find((existing) => existing.id === chunk.id) || { ...chunk, status: 'pending' as DeepReviewChunkStatus };
      const nextChunk: DeepReviewChunkState = {
        ...existingFinalChunk,
        id: chunk.id,
        label: chunk.label,
        description: chunk.description,
        status: 'complete',
        jobId: outcome.jobId,
        message: outcome.message,
        parsed: null,
        finishedAt: Date.now(),
      };
      workingChunks = workingChunks.map((existing) => (existing.id === chunk.id ? nextChunk : existing));
      setDeepReviewChunks(workingChunks);
      setDeepReviewFinalMessage(outcome.message);
      setAiLastMode('final-yaml');
      setStudioStep('package');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Final package generation failed.';
      setDeepReviewError(message);
      setDeepReviewChunks((prev) => prev.map((chunk) => (chunk.id === FINAL_PACKAGE_CHUNK_ID ? { ...chunk, status: 'failed', error: message, finishedAt: Date.now() } : chunk.status === 'running' ? { ...chunk, status: 'failed', error: message, finishedAt: Date.now() } : chunk)));
    } finally {
      setDeepReviewRunning(false);
    }
  }

  async function copyTextToClipboard(value: string) {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.opacity = '0.01';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
      const copied = document.execCommand('copy');
      if (copied) return;
    } finally {
      document.body.removeChild(textarea);
    }

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        // Fall through to a user-facing fallback when the browser denies clipboard access.
      }
    }

    throw new Error('Browser clipboard access was blocked.');
  }

  async function handleCopyResult(kind: string, value: string) {
    const copyValue = value.trim();
    if (!copyValue) return;
    setCopyError('');
    try {
      await copyTextToClipboard(copyValue);
      setCopiedResult(kind);
      setManualCopy(null);
      window.setTimeout(() => setCopiedResult(null), 1600);
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : 'Copy failed. Select the text manually and copy it.');
      setManualCopy({
        label: kind.includes('yaml') ? 'YAML' : kind === 'readiness' ? 'findings' : kind === 'plan' ? 'plan' : 'content',
        value: copyValue,
      });
    }
  }

  function toggleWorkstream(id: WorkstreamId) {
    setSelectedWorkstreams((prev) => {
      if (id === 'full') return ['full'];
      const current = prev.includes('full')
        ? INSPECTION_WORKSTREAMS.map((workstream) => workstream.id)
        : prev.filter((value) => value !== 'full');
      const next = current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id];
      return next.length > 0 ? next : selectedStudioPath ? defaultWorkstreamsForPath(selectedStudioPath) : [];
    });
  }

  const topicModelOptions = models.filter((model) => {
    const needle = modelSearch.toLowerCase();
    const connectionLabel = `${model.connectionName || ''} ${model.connectionId || ''}`.toLowerCase();
    const matchesSearch =
      !needle ||
      model.name.toLowerCase().includes(needle) ||
      model.id.toLowerCase().includes(needle) ||
      model.kind?.toLowerCase().includes(needle) ||
      connectionLabel.includes(needle);
    return isModelEligibleForStudio(model) && matchesSearch;
  });
  const targetFileOptions = modelFileOptions.filter((fileName) => {
    const needle = targetFileSearch.toLowerCase().trim();
    return !needle || fileName.toLowerCase().includes(needle);
  });

  const selectedModel = models.find((model) => model.id === selectedModelId);
  const filteredTopics = topics.filter((topic) => {
    const needle = topicSearch.toLowerCase();
    return !needle ||
      topic.name.toLowerCase().includes(needle) ||
      topic.label?.toLowerCase().includes(needle) ||
      topic.description?.toLowerCase().includes(needle);
  });
  const describedTopics = topics.filter((topic) => Boolean(topic.description)).length;
  const loadedDetails = Object.keys(topicDetails).length;
	  const aiIsBusy = deepReviewRunning;
  const selectedPathConfig = selectedStudioPath
    ? STUDIO_PATHS.find((path) => path.id === selectedStudioPath) || null
    : null;
	  const selectedPathIncludesTopic = pathIncludesTopic(selectedStudioPath);
	  const selectedPathIncludesModel = pathIncludesModel(selectedStudioPath);
  const selectedPathIncludesPermissions = pathIncludesPermissions(selectedStudioPath);
  const selectedPathUsesTargetFile = pathUsesTargetSemanticFile(selectedStudioPath);
	  const modelTargetReady = !selectedPathUsesTargetFile || Boolean(targetBaseViewName.trim());
	  const targetSemanticFile = targetBaseViewName.trim();
	  const targetSemanticFileType = targetFileTypeLabel(targetSemanticFile);
	  const laneFileScope = selectedStudioPath === 'topic'
	    ? {
	        title: 'Topic file scope',
	        subtitle: 'This run creates one reviewable .topic file.',
	        items: [
	          {
	            label: '*.topic',
	            description: 'Base view, topic joins, topic-level filters, ai_fields, sample queries, routing, and final ai_context.',
	          },
	          {
	            label: 'Review notes',
	            description: 'Metrics, relationships, and .view changes stay advisory until you run Model / View Builder.',
	          },
	        ],
	      }
	    : selectedStudioPath === 'model'
	      ? {
	          title: 'Target file scope',
	          subtitle: targetSemanticFile
		            ? `This run reviews ${targetSemanticFileType}; deployable YAML is generated only after Confirm.`
	            : 'Choose one target file so the AI package stays deployable.',
	          items: targetSemanticFile === 'model'
	            ? [
	                {
	                  label: 'model',
	                  description: 'Settings/model work such as cache policies, ignored schemas/views, access grants, and global model config.',
	                },
	                {
	                  label: 'Excluded',
	                  description: 'No .topic, relationships, or .view file is generated in this lane unless you select that target instead.',
	                },
	              ]
	            : targetSemanticFile === 'relationships'
	              ? [
	                  {
	                    label: 'relationships',
	                    description: 'Settings/relationships work as a top-level list of reusable join edges and relationship metadata.',
	                  },
	                  {
	                    label: 'Excluded',
	                    description: 'No .topic, Settings/model, or .view file is generated in this lane unless you select that target instead.',
	                  },
	                ]
	              : targetSemanticFile.endsWith('.view')
	                ? [
	                    {
	                      label: targetSemanticFile,
	                      description: 'View-file work such as dimensions, measures, descriptions, formats, hidden flags, and field metadata.',
	                    },
	                    {
	                      label: 'Excluded',
	                      description: 'No .topic, Settings/model, or Settings/relationships file is generated in this lane.',
	                    },
	                  ]
	                : [
	                    {
	                      label: 'Choose a target',
	                      description: 'Select model, relationships, or a .view file before running review.',
	                    },
	                  ],
	        }
      : selectedStudioPath === 'permissions'
        ? {
            title: 'Permission target scope',
            subtitle: targetSemanticFile
              ? `This run reviews ${targetSemanticFileType}; Permission Builder stages the files needed for enforceable access.`
              : 'Choose the topic, view, or model scope for the enforceable permission change.',
            items: targetSemanticFile === 'model'
              ? [
                  {
                    label: 'model',
                    description: 'Access grants, user attributes, default topic access filters, and model-wide grant requirements.',
                  },
                  {
                    label: 'Separate workflows',
                    description: 'Topic access filters and view masking stay as follow-up target files unless you select that file instead.',
                  },
                ]
              : targetSemanticFile.endsWith('.topic')
                ? [
                    {
                      label: 'model',
                      description: 'Defines or preserves access_grants and model-level access settings required by the topic.',
                    },
                    {
                      label: targetSemanticFile,
                      description: 'Topic-level required grants and access filters for row-level matching against confirmed user attributes.',
                    },
                  ]
                : targetSemanticFile.endsWith('.view')
                  ? [
                      {
                        label: 'model',
                        description: 'Defines or preserves access_grants required by view, dimension, or measure controls.',
                      },
                      {
                        label: targetSemanticFile,
                        description: 'View or field required grants, masked dimensions, and confirmed omni_attributes-based masking.',
                      },
                    ]
                  : [
                      {
                        label: 'Choose a target',
                        description: 'Select model, an existing .topic file, or a .view file before running review.',
                      },
                    ],
          }
	      : null;
		  const confirmScopeNoun =
		    selectedStudioPath === 'permissions'
          ? 'permission target'
          : selectedStudioPath === 'model'
		      ? 'model/view file'
		      : 'topic file';
		  const activeAiTopic = selectedPathIncludesTopic ? aiFocusTopic || aiPickedTopic || selectedTopicName : '';
		  const topicCreationMode = selectedPathIncludesTopic && !activeAiTopic;
		  const newTopicBriefItemCount =
		    compactList(readinessInputs.questions).length +
		    compactList(readinessInputs.questionInputs).length +
		    compactList(readinessInputs.useCases).length +
		    compactList(readinessInputs.useCaseInputs).length +
		    (aiPrompt.trim() ? 1 : 0) +
		    (readinessInputs.notes.trim() ? 1 : 0);
		  const newTopicBriefReady = !topicCreationMode || newTopicBriefItemCount > 0;
		  const canRunReadinessProbe = Boolean(selectedModel && selectedStudioPath && modelTargetReady);
		  const canRunDiscoveryReview = canRunReadinessProbe && newTopicBriefReady;
	  const selectedTopic = topics.find((topic) => topic.name === selectedTopicName) || null;
  const selectedTopicDetail = selectedTopicName ? topicDetails[topicDetailKey(selectedTopicName, selectedModelId)] : undefined;
  const selectedTopicViews = Array.isArray(selectedTopicDetail?.views) ? selectedTopicDetail.views as Array<Record<string, unknown>> : [];
  const selectedTopicRelationships = Array.isArray(selectedTopicDetail?.relationships) ? selectedTopicDetail.relationships as unknown[] : [];
  const selectedTopicFieldCount = selectedTopicViews.reduce((count, view) => {
    const dimensions = Array.isArray(view.dimensions) ? view.dimensions.length : 0;
    const measures = Array.isArray(view.measures) ? view.measures.length : 0;
    return count + dimensions + measures;
  }, 0);
  const selectedTopicBaseView = (selectedTopicDetail?.base_view_name || selectedTopicDetail?.baseViewName) as string | undefined;
  const selectedTopicAiContext = (selectedTopicDetail?.ai_context || selectedTopicDetail?.aiContext) as string | undefined;
  const selectedTopicJoinYaml = buildJoinYamlFromTopicDetail(selectedTopicDetail);
  const selectedTopicScore = selectedTopic
    ? [
        Boolean(selectedTopic.description),
        Boolean(selectedTopicAiContext),
        Boolean(selectedTopicBaseView),
        selectedTopicFieldCount > 0,
        selectedTopicRelationships.length > 0,
      ].filter(Boolean).length
    : 0;
  const aiMessage = extractAiMessage(aiJobResult, aiJob);
  const aiChatUrl = readFirstString(aiJobResult, ['omniChatUrl', 'omni_chat_url']) || readFirstString(aiJob, ['omniChatUrl', 'omni_chat_url']);
  const aiConversationDisplay = readFirstString(aiJob, ['conversationId', 'conversation_id']);
  const baselineMessage = aiLastMode === 'readiness-probe' ? aiMessage : readinessBaselineMessage;
  const baselineStatus =
    aiLastMode === 'readiness-probe'
      ? aiJob?.state || aiJob?.status || readinessBaselineStatus
      : readinessBaselineStatus || (readinessBaselineMessage ? 'COMPLETE' : '');
  const baselineChatUrl =
    aiLastMode === 'readiness-probe'
      ? aiChatUrl || readinessBaselineChatUrl
      : readinessBaselineChatUrl || aiChatUrl;
  const showBaselineCard = Boolean((aiLastMode === 'readiness-probe' && (aiJob || baselineMessage || aiError)) || baselineMessage);
  const aiYamlDrafts = selectedPathIncludesTopic ? extractYamlDrafts(aiMessage, aiLastMode) : [];
  const deepReviewYamlDrafts = selectedPathIncludesTopic ? extractYamlDrafts(deepReviewFinalMessage, 'final-yaml') : [];
  const baselineSummary = baselineMessage ? parseReadinessSummary(baselineMessage) : null;
  const aiReviewSections = aiMessage ? getReviewSections(aiMessage, aiLastMode) : [];
  const aiHasCuratedOutput = aiYamlDrafts.length > 0 || aiReviewSections.length > 0;
  const showAiResultPanelForStep: boolean =
    studioStep !== 'package' && aiLastMode !== 'final-yaml';
  const activeDeepReviewChunk = deepReviewChunks.find((chunk) => chunk.status === 'running') || null;
  const completedDeepReviewCount = deepReviewChunks.filter((chunk) => chunk.status === 'complete').length;
  const reviewChunks = deepReviewChunks.filter((chunk) => REVIEW_CHUNK_IDS.includes(chunk.id));
  const reviewChunksComplete = reviewChunks.length === REVIEW_CHUNK_IDS.length && reviewChunks.every((chunk) => chunk.status === 'complete');
  const finalPackageChunk = deepReviewChunks.find((chunk) => chunk.id === FINAL_PACKAGE_CHUNK_ID);
  const finalPackageReady = finalPackageChunk?.status === 'complete' && Boolean(deepReviewFinalMessage);
  const failedDeepReviewChunk = deepReviewChunks.find((chunk) => chunk.status === 'failed') || null;
  const deepReviewStarted = deepReviewChunks.some((chunk) => chunk.status !== 'pending') || Boolean(deepReviewSummary || deepReviewFinalMessage || deepReviewError);
  const deepReviewComplete = finalPackageReady;
  const canContinueToConfirm = readinessCompleted && reviewChunksComplete && !deepReviewRunning;
  const deepReviewFinalSections = deepReviewFinalMessage ? getReviewSections(deepReviewFinalMessage, 'final-yaml') : [];
  const deepReviewSummarySections = deepReviewSummary ? getReviewSections(deepReviewSummary, 'final-yaml') : [];
  const deepReviewPackageSections = [
    ...deepReviewFinalSections,
    ...deepReviewSummarySections.filter((summarySection) => !deepReviewFinalSections.some((section) => section.id === summarySection.id)),
  ];
  const deployValidationErrors = (deployValidation || []).filter((issue) => !issue.is_warning);
  const deployValidationWarnings = (deployValidation || []).filter((issue) => issue.is_warning);
  const deployContentSummary = summarizeContentValidation(deployContentValidation, deployMainContentValidation);
  const deployContentHasIssues = Boolean(deployContentSummary && !deployContentSummary.errorMessage && deployContentSummary.newIssueCount > 0);
  const deployContentHasExistingIssues = Boolean(
    deployContentSummary &&
    !deployContentSummary.errorMessage &&
    deployContentSummary.documentsWithIssues > 0 &&
    deployContentSummary.newIssueCount === 0
  );
  const deployContentFailed = Boolean(deployContentSummary?.errorMessage);
  const permissionModelPrerequisiteIssues = selectedPathIncludesPermissions
    ? deployValidationErrors
        .map((issue) => [issue.yaml_path, issue.message].filter(Boolean).join(': '))
        .filter((message) => message.trim() && isPermissionPrerequisiteIssue(message))
    : [];
  const permissionContentPrerequisiteIssues = selectedPathIncludesPermissions
    ? extractNewPermissionPrerequisiteIssues(deployContentValidation, deployMainContentValidation)
    : [];
  const permissionPrerequisiteIssueLabels = uniqueStrings(
    [...permissionModelPrerequisiteIssues, ...permissionContentPrerequisiteIssues],
    Number.MAX_SAFE_INTEGER
  );
  const permissionPrerequisiteIssueCount = permissionPrerequisiteIssueLabels.length;
  const permissionPrerequisiteIssues = permissionPrerequisiteIssueLabels.slice(0, 8);
  const permissionPrerequisiteBlocked = selectedPathIncludesPermissions && permissionPrerequisiteIssueCount > 0;
  const deployReadyForOmniReview =
    deployStatus === 'ready' &&
    Boolean(deployBranchName.trim()) &&
    Boolean(deployValidation) &&
	    deployDiffs.length > 0 &&
	    deployValidationErrors.length === 0 &&
	    !deployContentFailed &&
      !permissionPrerequisiteBlocked &&
	    deployReviewAcknowledged;
  const deployInFlight = ['preparing', 'creating-branch', 'saving', 'validating'].includes(deployStatus);
  const deployStatusLabel =
    deployStatus === 'preparing'
      ? 'Preparing branch'
      : deployStatus === 'creating-branch'
        ? 'Creating dev branch'
        : deployStatus === 'saving'
          ? 'Saving YAML'
          : deployStatus === 'validating'
            ? 'Validating branch'
            : 'Deploying';
  const omniReviewUrl = connection.baseUrl.replace(/\/+$/, '');
  const deepReviewProgressLabel = activeDeepReviewChunk
    ? `Chunk ${DEEP_REVIEW_CHUNKS.findIndex((chunk) => chunk.id === activeDeepReviewChunk.id) + 1} of ${DEEP_REVIEW_CHUNKS.length}: ${activeDeepReviewChunk.label}`
    : failedDeepReviewChunk
      ? `Needs attention: ${failedDeepReviewChunk.label}`
      : finalPackageReady
        ? 'Final package complete'
        : reviewChunksComplete
          ? 'Review ready for confirmation'
        : `${completedDeepReviewCount} of ${DEEP_REVIEW_CHUNKS.length} chunks complete`;
  const deepReviewAnimationDetail =
	    selectedStudioPath === 'permissions'
        ? 'Blobby is running the review in ordered chunks: permission baseline, target audit, permission context, and an implementation plan. File generation waits for Confirm.'
        : selectedStudioPath === 'model'
	      ? 'Blobby is running the review in ordered chunks: model/view baseline, field work, AI metadata, and an implementation plan. File generation waits for Confirm.'
	      : topicCreationMode
	        ? 'Blobby is reviewing your question/use-case brief against the selected model, available views, and existing topics before recommending a new topic candidate.'
	        : 'Blobby is running the review in ordered chunks: topic readiness, joins, AI guidance, and implementation plan. Topic YAML waits for Confirm.';
  const deepReviewAnimationSteps = deepReviewChunks.map((chunk) => {
    const status: AIWorkStepStatus =
      chunk.status === 'complete'
        ? 'complete'
        : chunk.status === 'running'
          ? 'active'
          : chunk.status === 'failed'
            ? 'failed'
            : 'pending';
    return { label: chunk.label, status };
  });
  const aiPlanSummary = extractPlanSummary(aiMessage || deepReviewFinalMessage);
  const inferredTopicName = selectedPathIncludesTopic ? inferTopicNameFromTopicYaml(deepReviewYamlDrafts[0]?.content || aiYamlDrafts[0]?.content || '') : '';
	  const packageScopeName = selectedPathUsesTargetFile
	    ? selectedModel?.name || targetBaseViewName || 'model'
	    : activeAiTopic || selectedTopicName || inferredTopicName || aiPlanSummary.topicName || 'new_topic_candidate';
	  const packageTopicName = selectedPathIncludesTopic
	    ? activeAiTopic || selectedTopicName || inferredTopicName || aiPlanSummary.topicName || 'new_topic_candidate'
	    : '';
  const packageViewName = targetBaseViewName.trim() || selectedTopicBaseView || aiPlanSummary.baseView || packageScopeName;
  const deepReviewViewModelDrafts = selectedPathUsesTargetFile
    ? extractViewModelYamlDrafts(
        deepReviewFinalMessage,
        packageScopeName,
        packageViewName,
        targetSemanticFile,
        expectedPackageTargetFiles(selectedStudioPath, targetSemanticFile)
      )
    : [];
  const packageHasDeployableFiles = selectedPathIncludesTopic ? deepReviewYamlDrafts.length > 0 : deepReviewViewModelDrafts.length > 0;
  const resultTopic = aiJobResult?.topic || aiPickedTopic || '';
  const resultTopicEntry = topics.find((topic) => topic.name === resultTopic) || null;
  const resultTopicExists = Boolean(resultTopicEntry);
  const resultTopicDisplay = resultTopicEntry?.label || resultTopic || '';
  const recommendedPlanTarget = resultTopicExists
    ? `Omni used this existing topic while drafting. Compare it against the proposed topic before creating anything new.`
    : aiPlanSummary.topicName
      ? `Review "${aiPlanSummary.topicName}" as a candidate new topic.`
      : 'Review the generated plan with the data owner before creating or updating a topic.';
  const studioStepIndex = STUDIO_STEPS.findIndex((step) => step.id === studioStep);
  const visibleInspectionWorkstreams = workstreamsForPath(selectedStudioPath);
  const activeWorkstreams = selectedWorkstreams.includes('full')
    ? visibleInspectionWorkstreams
    : visibleInspectionWorkstreams.filter((workstream) => selectedWorkstreams.includes(workstream.id));
  const canOpenStudioStep = (stepId: StudioStep) => {
    if (stepId === 'scope') return true;
    if (stepId === 'baseline') return Boolean(selectedModel && selectedStudioPath && modelTargetReady);
    if (stepId === 'deploy') return Boolean(selectedModel && selectedStudioPath && deepReviewComplete && packageHasDeployableFiles);
    return Boolean(selectedModel && selectedStudioPath && modelTargetReady && readinessCompleted);
  };

	  function initializeDeployFiles() {
	    const topicDraft = deepReviewYamlDrafts[0];
	    const topicName = packageTopicName;
	    const normalizedExistingBranchName = normalizeBranchNamePrefix(deployBranchName);
	    const defaultBranchName = buildBranchName(packageScopeName);
	    if (!deployBranchNameEdited || !deployBranchName.trim()) {
	      if (deployBranchName !== defaultBranchName) setDeployBranchName(defaultBranchName);
	    } else if (deployBranchName !== normalizedExistingBranchName) {
	      setDeployBranchName(normalizedExistingBranchName);
	    }

    if (deployFiles.length > 0) return;

    const nextFiles: DeployFileDraft[] = [];
    if (selectedPathIncludesTopic && topicDraft?.content && topicName) {
      nextFiles.push({
        id: makeId('topic-file'),
        fileName: `${topicName}.topic`,
        yaml: mergeSourceTopicJoins(topicDraft.content, selectedTopicJoinYaml),
        source: 'topic-builder',
      });
    }

    deepReviewViewModelDrafts.forEach((draft) => {
      if (!draft.targetFileName) return;
      nextFiles.push({
        id: makeId(selectedPathIncludesPermissions ? 'permission-file' : 'view-model-file'),
        fileName: draft.targetFileName,
        yaml: draft.content,
        source: selectedPathIncludesPermissions ? 'permission-builder' : 'view-model-builder',
      });
    });

    setDeployFiles(nextFiles);
  }

  function handleOpenDeployStep() {
    initializeDeployFiles();
    setStudioStep('deploy');
  }

  function updateDeployFile(id: string, patch: Partial<DeployFileDraft>) {
    setDeployStatus('idle');
    setDeployDiffs([]);
    setDeployValidation(null);
    setDeployMainContentValidation(null);
    setDeployContentValidation(null);
    setDeployReviewAcknowledged(false);
    setDeployFiles((prev) => prev.map((file) => (file.id === id ? { ...file, ...patch } : file)));
  }

  function removeDeployFile(id: string) {
    setDeployStatus('idle');
    setDeployDiffs([]);
    setDeployValidation(null);
    setDeployMainContentValidation(null);
    setDeployContentValidation(null);
    setDeployReviewAcknowledged(false);
    setDeployFiles((prev) => prev.filter((file) => file.id !== id));
  }

  async function ensureDeployBranch(options: { forceCreate?: boolean } = {}) {
    if (!selectedModel) throw new Error('Select a model before creating a branch.');
    if (deployBranchId && !options.forceCreate) return { branchId: deployBranchId, branchName: deployBranchName };
    if (!selectedModel.connectionId) {
      throw new Error('This model is missing connection metadata, so OmniKit cannot create a branch safely. Re-load models or create the dev branch in Omni first.');
    }

	    const branchName = normalizeBranchNamePrefix(deployBranchName) || buildBranchName(packageScopeName || selectedModel.name);
	    if (branchName !== deployBranchName.trim()) setDeployBranchName(branchName);
    setDeployStatus('creating-branch');
    const created = await createModelBranch(connection.baseUrl, connection.apiKey, {
      connectionId: selectedModel.connectionId,
      baseModelId: selectedModel.id,
      branchName,
    });
    const branchId =
      readFirstString(created, ['id', 'modelId', 'model_id', 'branchId', 'branch_id']) ||
      readFirstNestedString(created, [
        ['model', 'id'],
        ['branch', 'id'],
        ['data', 'id'],
        ['result', 'id'],
      ]);
    if (!branchId) {
      throw new Error(created.error || 'Omni did not return a branch model id.');
    }
    const resolvedBranchName =
      readFirstString(created, ['name', 'modelName', 'model_name']) ||
      readFirstNestedString(created, [
        ['model', 'name'],
        ['model', 'modelName'],
        ['model', 'model_name'],
        ['branch', 'name'],
        ['data', 'name'],
        ['result', 'name'],
      ]) ||
      branchName;
    setDeployBranchId(branchId);
    setDeployBranchName(resolvedBranchName);
    return { branchId, branchName: resolvedBranchName };
  }

  async function handleApplyToDevBranch() {
    if (!selectedModel) return;
    if (!deployFiles.length) {
      setDeployError('Add at least one YAML file before saving to a dev branch.');
      return;
    }

    setDeployError('');
    setDeployValidation(null);
    setDeployMainContentValidation(null);
    setDeployContentValidation(null);
    setDeployReviewAcknowledged(false);

    try {
      const filesToSave = deployFiles.map(normalizeDeployFile);
      setDeployFiles(filesToSave);

      const invalidFile = filesToSave.find((file) => !isSupportedYamlFileName(file.fileName));
      if (invalidFile) {
        throw new Error(`Unsupported file name "${invalidFile.fileName}". Use model, relationships, <name>.topic, or <name>.view.`);
      }
      const emptyFile = filesToSave.find((file) => !file.yaml.trim());
      if (emptyFile) {
        throw new Error(`YAML is empty for ${emptyFile.fileName}.`);
      }
      const lintIssues = filesToSave.flatMap(validateDeployYamlFile);
      if (selectedPathIncludesTopic && !selectedTopicName) {
        filesToSave
          .filter((file) => file.fileName.endsWith('.topic'))
          .forEach((file) => {
            const joinedSelectors = nonBaseTopicSelectors(file.yaml);
            if (joinedSelectors.length > 0) {
              lintIssues.push(`${file.fileName} is a new-topic candidate with joined-view fields in ai_fields or sample_queries: ${joinedSelectors.join(', ')}. Remove them until the join path validates, or create/confirm the relationship in a separate workflow first.`);
            }
            if (hasNonEmptyTopicJoinBlock(file.yaml)) {
              lintIssues.push(`${file.fileName} is a new-topic candidate with topic joins. Keep unvalidated joins out of deployable topic YAML and list candidate joins in assumptions/validations until the relationship path is confirmed.`);
            }
          });
      }
      if (lintIssues.length > 0) {
        throw new Error(`Fix generated YAML before saving to dev:\n${lintIssues.map((issue) => `- ${issue}`).join('\n')}`);
      }

      setDeployStatus('preparing');
      const mainYaml = await getModelYaml(connection.baseUrl, connection.apiKey, selectedModel.id, {
        includeChecksums: true,
      });
      setDeployMainYaml(mainYaml);
      if (selectedStudioPath === 'model') {
        const sourcePreservationIssues = filesToSave.flatMap((file) =>
          viewFieldPreservationLintIssues(
            file,
            mainYaml.files?.[file.fileName] || '',
            formatReadinessInputs(readinessInputs, 'model/view'),
          ),
        );
        if (sourcePreservationIssues.length > 0) {
          throw new Error(`Fix generated YAML before saving to dev:\n${sourcePreservationIssues.map((issue) => `- ${issue}`).join('\n')}`);
        }
      }

      let { branchId } = await ensureDeployBranch();
      let branchYamlBefore: OmniModelYamlResponse;
      try {
        branchYamlBefore = await getModelYaml(connection.baseUrl, connection.apiKey, selectedModel.id, {
          branchId,
          includeChecksums: true,
        });
      } catch (err) {
        if (!isMissingBranchError(err)) throw err;
        setDeployBranchId('');
        const recreated = await ensureDeployBranch({ forceCreate: true });
        branchId = recreated.branchId;
        branchYamlBefore = await getModelYaml(connection.baseUrl, connection.apiKey, selectedModel.id, {
          branchId,
          includeChecksums: true,
        });
      }
      setDeployStatus('saving');
      for (const file of filesToSave) {
        const previousChecksum = branchYamlBefore.checksums?.[file.fileName] || mainYaml.checksums?.[file.fileName];
        await updateModelYamlFile(connection.baseUrl, connection.apiKey, {
          modelId: selectedModel.id,
          branchId,
          fileName: file.fileName as SupportedYamlFileName,
          yaml: file.yaml,
          previousChecksum,
          commitMessage: `AI Semantic Studio update: ${file.fileName}`,
        });
      }

      setDeployStatus('validating');
      const branchYamlAfter = await getModelYaml(connection.baseUrl, connection.apiKey, selectedModel.id, {
        branchId,
        includeChecksums: true,
      });
      setDeployDevYaml(branchYamlAfter);
      setDeployDiffs(buildDeployDiffs(mainYaml, branchYamlAfter, filesToSave));

      const validation = await validateModel(connection.baseUrl, connection.apiKey, selectedModel.id, branchId);
      setDeployValidation(Array.isArray(validation) ? validation : []);
      const mainContentValidation = await validateModelContent(connection.baseUrl, connection.apiKey, selectedModel.id).catch((err) => ({
        error: err instanceof Error ? err.message : 'Main content validation failed',
      }));
      setDeployMainContentValidation(mainContentValidation);
      const contentValidation = await validateModelContent(connection.baseUrl, connection.apiKey, selectedModel.id, branchId).catch((err) => ({
        error: err instanceof Error ? err.message : 'Content validation failed',
      }));
      setDeployContentValidation(contentValidation);
      setDeployStatus('ready');
    } catch (err) {
      setDeployStatus('failed');
      setDeployError(formatErrorMessage(err, 'Failed to apply changes to the dev branch.'));
    }
  }

  return (
	    <div className="space-y-5">
	      <PageHeader
	        title="AI Semantic Studio"
	        description="Build, review, validate, and deploy semantic YAML changes with human approval."
	        icon={<Blobby mood="semantic" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
	      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      <div className="card p-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" aria-label="AI Semantic Studio mode">
          <button
            type="button"
            onClick={() => setStudioMode('builders')}
            aria-pressed={studioMode === 'builders'}
            className={`relative rounded-button border px-3 py-2 text-left transition-all ${
              studioMode === 'builders' ? selectedCardClass : unselectedCardClass
            }`}
          >
            {studioMode === 'builders' && <div className="absolute left-0 top-0 h-full w-1 rounded-l-[8px] bg-omni-500" />}
            <div className="text-sm font-semibold">Guided Builders</div>
            <div className="mt-0.5 text-[11px]">Topic Builder, Model / View Builder, and Permission Builder.</div>
            {studioMode === 'builders' && (
              <span className={`${selectedBadgeClass} mt-2`}>
                <CheckCircle2 size={12} />
                Selected
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setStudioMode('migration')}
            aria-pressed={studioMode === 'migration'}
            className={`relative rounded-button border px-3 py-2 text-left transition-all ${
              studioMode === 'migration' ? selectedCardClass : unselectedCardClass
            }`}
          >
            {studioMode === 'migration' && <div className="absolute left-0 top-0 h-full w-1 rounded-l-[8px] bg-omni-500" />}
            <div className="text-sm font-semibold">Semantic Migration Import</div>
            <div className="mt-0.5 text-[11px]">Convert external semantic artifacts into Omni YAML.</div>
            {studioMode === 'migration' && (
              <span className={`${selectedBadgeClass} mt-2`}>
                <CheckCircle2 size={12} />
                Selected
              </span>
            )}
          </button>
        </div>
      </div>

      {studioMode === 'migration' ? (
        <SemanticMigrationImportPanel />
      ) : (
      <>
      <div className="card p-3">
        <div className="flex items-center justify-between overflow-x-auto gap-2" aria-label="AI Semantic Studio progress">
          {STUDIO_STEPS.map((step, index) => {
            const isActive = step.id === studioStep;
            const isDone = index < studioStepIndex;
            const reachable = canOpenStudioStep(step.id);
            return (
              <button
                key={step.id}
                type="button"
                onClick={() => reachable && setStudioStep(step.id)}
                disabled={!reachable}
                aria-current={isActive ? 'step' : undefined}
                aria-label={`Step ${index + 1}: ${step.label}. ${step.description}`}
                className="min-w-[132px] flex-1 text-left disabled:cursor-not-allowed rounded-button transition-colors hover:bg-surface-secondary"
              >
                <div className="flex items-center gap-2 px-2 py-2">
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{
                      background: isActive || isDone ? '#FF4794' : 'rgba(255,71,148,0.10)',
                      color: isActive || isDone ? '#FFFFFF' : reachable ? '#C8186A' : 'rgba(155,48,101,0.45)',
                    }}
                  >
                    {isDone ? <CheckCircle2 size={14} /> : index + 1}
                  </div>
                  <div className="min-w-0">
                    <div className={`text-xs font-semibold truncate ${isActive ? 'text-omni-700' : reachable ? 'text-content-primary' : 'text-content-tertiary'}`}>
                      {step.label}
                    </div>
                    <div className="text-[10px] text-content-tertiary truncate">{step.description}</div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] leading-4 text-content-secondary">
          <span className="font-semibold text-content-primary">Path:</span>
          <span className="px-2 py-1 rounded-chip bg-pink-50 text-omni-700">
            {selectedPathConfig?.label || 'Choose Topic, Model / View, or Permissions'}
          </span>
          <span className="font-semibold text-content-primary">Workstreams:</span>
          {activeWorkstreams.length > 0 ? activeWorkstreams.map((workstream) => (
            <span key={workstream.id} className="px-2 py-1 rounded-chip bg-omni-50 text-omni-700">
              {workstream.label}
            </span>
          )) : (
            <span className="px-2 py-1 rounded-chip bg-surface-secondary text-content-secondary">
              Waiting for workflow
            </span>
          )}
          <span className="ml-auto text-content-tertiary">
            {!selectedStudioPath
              ? 'Choose a workflow to begin'
              : deepReviewComplete
                ? 'Final package ready'
                : reviewChunksComplete
                  ? 'Next: confirm inputs'
                  : readinessCompleted
                    ? 'Review in progress'
                    : selectedModel && modelTargetReady
                      ? 'Next: run discovery review'
                      : selectedModel
                        ? selectedPathUsesTargetFile
                          ? 'Choose a target file'
                          : 'Choose a topic to begin'
                        : 'Choose a model to begin'}
          </span>
        </div>
      </div>

      <div className="card px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-sm font-semibold text-content-primary">
              {selectedStudioPath === 'topic' ? 'Model topic context' : selectedStudioPath === 'permissions' ? 'Permission context' : selectedStudioPath === 'model' ? 'Model development context' : 'Studio context'}
            </div>
            <div className="text-xs text-content-secondary mt-0.5">
              {selectedStudioPath === 'topic'
                ? 'Topic Builder creates only .topic files.'
                : selectedStudioPath === 'permissions'
                  ? 'Permission Builder stages Settings/model plus the selected .topic or .view target when grants are needed.'
                : selectedStudioPath === 'model'
                  ? 'Model / View Builder creates only Settings/model, Settings/relationships, or .view files.'
                  : 'Choose whether this run is for a topic file, model/view file, or permission target.'}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-chip bg-surface-secondary px-2.5 py-1 text-content-secondary">
              {topicModelOptions.length} model{topicModelOptions.length === 1 ? '' : 's'}
            </span>
            {!selectedStudioPath ? (
              <span className="rounded-chip bg-surface-secondary px-2.5 py-1 text-content-secondary">
                Choose workflow
              </span>
            ) : selectedStudioPath === 'topic' ? (
              <>
                <span className="rounded-chip bg-surface-secondary px-2.5 py-1 text-content-secondary">
                  {selectedModel ? selectedModel.name : 'No model selected'}
                </span>
                <span className="rounded-chip bg-surface-secondary px-2.5 py-1 text-content-secondary">
                  {topics.length} topic{topics.length === 1 ? '' : 's'}
                </span>
                <span className="rounded-chip bg-surface-secondary px-2.5 py-1 text-content-secondary">
                  {describedTopics}/{topics.length} described
                </span>
                <span className="rounded-chip bg-surface-secondary px-2.5 py-1 text-content-secondary">
                  {loadedDetails} loaded
                </span>
                <span className={`rounded-chip px-2.5 py-1 ${selectedTopicScore >= 4 ? 'bg-green-100 text-green-800' : selectedTopic ? 'bg-yellow-100 text-yellow-800' : 'bg-surface-secondary text-content-secondary'}`}>
                  {selectedTopic ? `${selectedTopicScore}/5 topic checks` : 'No topic selected'}
                </span>
              </>
            ) : (
              <>
                <span className="rounded-chip bg-surface-secondary px-2.5 py-1 text-content-secondary">
                  {selectedModel ? selectedModel.name : 'No model selected'}
                </span>
                <span className="rounded-chip bg-surface-secondary px-2.5 py-1 text-content-secondary">
                  {selectedStudioPath === 'permissions' ? 'Permission lane' : 'Topic files excluded'}
                </span>
                <span className={`rounded-chip px-2.5 py-1 ${modelTargetReady ? 'bg-surface-secondary text-content-secondary' : 'bg-amber-100 text-amber-800'}`}>
                  Target: {targetBaseViewName.trim() || 'required'}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className={studioStep === 'scope' ? 'grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)] gap-5 items-start' : 'grid grid-cols-1 gap-5 items-start'}>
        {studioStep === 'scope' && (
        <div className="space-y-4">
          <div className="card p-4 space-y-3">
            <div>
              <div className="text-sm font-semibold text-content-primary">Select scope</div>
              <div className="text-xs text-content-secondary mt-0.5">Choose the workflow first, then select the Omni model that contains that work.</div>
            </div>
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-content-secondary">1. Workflow</div>
              <div className="grid grid-cols-1 gap-2">
                {STUDIO_PATHS.map((path) => {
                  const selected = selectedStudioPath === path.id;
                  return (
                    <button
                      key={path.id}
                      type="button"
                      onClick={() => handleStudioPathSelect(path.id)}
                      aria-pressed={selected}
                      className={`relative text-left rounded-card border p-3 transition-all ${
                        selected ? selectedCardClass : unselectedCardClass
                      }`}
                    >
                      {selected && <div className="absolute left-0 top-0 h-full w-1 rounded-l-[8px] bg-omni-500" />}
                      <div className="flex items-start justify-between gap-3 pl-1">
                        <div>
                          <div className="text-sm font-semibold text-content-primary">{path.label}</div>
                          <div className="mt-1 text-[11px] leading-relaxed text-content-secondary">{path.output}</div>
                        </div>
                        <span className={selected ? selectedBadgeClass : unselectedBadgeClass}>
                          {selected && <CheckCircle2 size={12} />}
                          {selected ? 'Selected' : path.id === 'topic' ? '.topic' : path.id === 'permissions' ? 'permissions' : 'model/relationships/.view'}
                        </span>
                      </div>
                      {selected && (
                        <div className="mt-2 inline-flex items-center gap-1 pl-1 text-[11px] font-semibold text-omni-700">
                          <CheckCircle2 size={13} />
                          Active workflow lane
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-secondary">2. Omni model</div>
            <SearchInput value={modelSearch} onChange={setModelSearch} placeholder="Search models..." />
            {loading ? (
              <div className="flex items-center gap-2 py-2">
                <Loader2 size={16} className="text-omni-500 animate-spin" />
                <span className="text-sm text-content-secondary">Loading models...</span>
              </div>
            ) : !selectedStudioPath ? (
              <div className="rounded-card border border-border bg-surface-secondary px-3 py-3 text-sm text-content-secondary">
                Choose Topic Builder, Model / View Builder, or Permission Builder before selecting a model.
              </div>
            ) : topicModelOptions.length === 0 ? (
              <div className="rounded-card border border-border bg-surface-secondary px-3 py-3 text-sm text-content-secondary">
                No models match that search.
              </div>
            ) : (
              <div className="max-h-[250px] overflow-y-auto rounded-card border border-border bg-white">
                {topicModelOptions.map((model) => {
                  const selected = selectedModelId === model.id;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => handleModelSelect(model.id)}
                      aria-pressed={selected}
                      className={`w-full border-b border-border/60 px-3 py-2.5 text-left transition-all last:border-b-0 ${
                        selected ? selectedRowClass : unselectedRowClass
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">{model.name}</div>
                          <div className="mt-0.5 truncate font-mono text-[10px] text-content-tertiary">{model.id}</div>
                          {(model.connectionName || model.connectionId) && (
                            <div className="mt-0.5 truncate text-[11px] text-content-secondary">
                              {model.connectionName || model.connectionId}
                            </div>
                          )}
                        </div>
                        <span className={selected ? selectedBadgeClass : unselectedBadgeClass}>
                          {selected && <CheckCircle2 size={12} />}
                          {selected ? 'Selected' : model.kind || 'Model'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {selectedModel && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-content-secondary">
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-chip bg-omni-50 text-omni-700">
                  <ShieldCheck size={12} />
                  {selectedModel.kind || 'Model'}
                </span>
                <span className="font-medium text-content-primary">{selectedModel.name}</span>
                <span className="font-mono break-all">{selectedModel.id}</span>
                {(selectedModel.connectionName || selectedModel.connectionId) && (
                  <span className="text-content-tertiary">
                    Connection: {selectedModel.connectionName || selectedModel.connectionId}
                  </span>
                )}
              </div>
            )}
            <label className="inline-flex items-center gap-2 text-xs text-content-secondary">
              <input
                type="checkbox"
                checked={includeBranches}
                onChange={(e) => {
                  setIncludeBranches(e.target.checked);
                  resetAiConversation();
                }}
                className="rounded border-border text-omni-700 focus:ring-omni-500"
              />
              Include branch models
            </label>
          </div>

          {selectedStudioPath === 'topic' && (
	          <div className="card p-0 overflow-hidden">
	            <div className="px-4 py-3 border-b border-border bg-white">
	              <div className="text-sm font-semibold text-content-primary">Topics</div>
	              <div className="text-xs text-content-secondary mt-0.5">
	                {selectedModelId
	                  ? 'Choose an existing topic to update, or create a new topic candidate.'
	                  : 'Choose a model first.'}
	              </div>
	            </div>
	            {selectedModelId && (
	              <div className="p-3 border-b border-border space-y-2">
	                <SearchInput value={topicSearch} onChange={setTopicSearch} placeholder="Search topics..." />
	                <button
	                  type="button"
	                  onClick={() => {
	                    setSelectedTopicName('');
	                    setAiFocusTopic('');
	                    setAiPickedTopic('');
	                    resetAiConversation();
	                  }}
                    aria-pressed={topicCreationMode}
	                  className={`relative w-full rounded-card border px-3 py-2 text-left transition-all ${
	                    topicCreationMode
	                      ? selectedCardClass
	                      : unselectedCardClass
	                  }`}
	                >
                    {topicCreationMode && <div className="absolute left-0 top-0 h-full w-1 rounded-l-[8px] bg-omni-500" />}
                    <div className="flex items-start justify-between gap-3 pl-1">
                      <div className="min-w-0">
	                      <div className="text-xs font-semibold">Create new topic candidate</div>
	                  <div className="mt-0.5 text-[11px] text-content-secondary">
	                    No existing topic selected. Omni AI will propose a new .topic file.
	                  </div>
                      </div>
                      {topicCreationMode && (
                        <span className={selectedBadgeClass}>
                          <CheckCircle2 size={12} />
                          Selected
                        </span>
                      )}
                    </div>
	                </button>
	              </div>
	            )}
            <div className="max-h-[520px] overflow-y-auto">
              {loadingTopics ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 size={18} className="text-omni-500 animate-spin" />
                </div>
              ) : !selectedModelId ? (
                <div className="px-4 py-8 text-center text-sm text-content-secondary">Pick a model to load topics.</div>
	            ) : filteredTopics.length === 0 ? (
	              <div className="px-4 py-8 text-center text-sm text-content-secondary">
	                {topics.length === 0 ? 'No topics found. Continue in creation mode to draft a new topic.' : 'No topics match this search.'}
	              </div>
              ) : (
                filteredTopics.map((topic) => (
                  <button
                    key={topic.name}
                    onClick={() => {
                      setSelectedTopicName(topic.name);
                      setAiFocusTopic(topic.name);
                      resetAiConversation();
                      fetchTopicDetail(topic.name, selectedModelId);
                    }}
                    aria-pressed={selectedTopicName === topic.name}
                    className={`w-full text-left px-4 py-3 border-b border-border/50 transition-all ${
                      selectedTopicName === topic.name ? selectedRowClass : unselectedRowClass
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{topic.label || topic.name}</div>
                        <div className="text-[10px] font-mono text-content-tertiary truncate">{topic.name}</div>
                      </div>
                      {selectedTopicName === topic.name ? (
                        <span className={selectedBadgeClass}>
                          <CheckCircle2 size={12} />
                          Selected
                        </span>
                      ) : (
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${topic.description ? 'bg-green-500' : 'bg-amber-400'}`} />
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
          )}
        </div>
        )}

        <div className="flex flex-col gap-4 min-w-0">
	          {!selectedStudioPath ? (
		            <div className="card p-8 text-center">
		              <BookOpen size={34} className="mx-auto text-content-secondary opacity-50" />
		              <h2 className="mt-3 text-lg font-semibold text-content-primary">Choose a workflow to start</h2>
			              <p className="mt-1 text-sm text-content-secondary">Topic Builder creates .topic files. Model / View Builder creates Settings/model, Settings/relationships, or .view files. Pick one lane before selecting a model.</p>
		            </div>
	          ) : !selectedModel ? (
            <div className="card p-8 text-center">
              <BookOpen size={34} className="mx-auto text-content-secondary opacity-50" />
              <h2 className="mt-3 text-lg font-semibold text-content-primary">Select a model to start</h2>
              <p className="mt-1 text-sm text-content-secondary">
                {selectedStudioPath === 'topic'
                  ? 'Topic Builder will load topics from the selected model and produce a .topic file.'
                  : selectedStudioPath === 'permissions'
                    ? 'Permission Builder will inspect model YAML and stage Settings/model plus the selected permission target.'
	                  : 'Model / View Builder will inspect model YAML and produce one target file: model, relationships, or .view.'}
              </p>
            </div>
          ) : (
            <>
              {studioStep === 'scope' && (
	              <div className="card p-0 overflow-hidden order-2">
	                <div className="px-4 py-3 border-b border-border bg-white flex items-center justify-between gap-4">
	                  <div>
	                    <div className="text-sm font-semibold text-content-primary">
	                      {selectedTopic ? selectedTopic.label || selectedTopic.name : topicCreationMode ? 'New topic candidate' : 'Topic inspector'}
	                    </div>
	                    <div className="text-xs text-content-secondary mt-0.5">
	                      {selectedTopic
	                        ? selectedTopic.name
	                        : topicCreationMode
	                          ? 'No existing topic selected. Omni AI will draft a new .topic file from model context and your inputs.'
	                          : 'Select a topic to inspect readiness.'}
	                    </div>
	                  </div>
	                  <span className={`px-2.5 py-1 rounded-chip text-xs font-semibold ${selectedTopicScore >= 4 ? 'bg-green-100 text-green-800' : selectedTopic ? 'bg-yellow-100 text-yellow-800' : topicCreationMode ? 'bg-omni-50 text-omni-700' : 'bg-gray-100 text-gray-600'}`}>
	                    {selectedTopic ? `${selectedTopicScore}/5 checks` : topicCreationMode ? 'Creation mode' : 'No topic selected'}
	                  </span>
	                </div>
                {selectedTopic ? (
                  <div className="p-4 space-y-4">
                    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 text-sm items-stretch">
                      <div className="rounded-card border border-border bg-surface-secondary p-3 h-full min-h-[78px]">
                        <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Base View</div>
                        <div className="mt-1 font-mono text-xs text-content-primary truncate">{selectedTopicBaseView || 'Not loaded'}</div>
                      </div>
                      <div className="rounded-card border border-border bg-surface-secondary p-3 h-full min-h-[78px]">
                        <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Views</div>
                        <div className="mt-1 text-lg font-semibold text-content-primary">{selectedTopicViews.length}</div>
                      </div>
                      <div className="rounded-card border border-border bg-surface-secondary p-3 h-full min-h-[78px]">
                        <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Fields</div>
                        <div className="mt-1 text-lg font-semibold text-content-primary">{selectedTopicFieldCount}</div>
                      </div>
                      <div className="rounded-card border border-border bg-surface-secondary p-3 h-full min-h-[78px]">
                        <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Joins</div>
                        <div className="mt-1 text-lg font-semibold text-content-primary">{selectedTopicRelationships.length}</div>
                      </div>
                    </div>

	                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
	                      <details open={!selectedTopic.description} className="rounded-card border border-border bg-white overflow-hidden">
	                        <summary className="cursor-pointer px-3 py-2 bg-surface-secondary border-b border-border">
	                          <span className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Description</span>
	                        </summary>
	                        <div className="p-3 text-sm text-content-secondary">
	                          {selectedTopic.description || 'No topic description found. Add a concise business-purpose description before promoting AI usage.'}
	                        </div>
	                      </details>
	                      <details open={!selectedTopicAiContext} className="rounded-card border border-border bg-white overflow-hidden">
	                        <summary className="cursor-pointer px-3 py-2 bg-surface-secondary border-b border-border">
	                          <span className="text-xs font-semibold uppercase tracking-wider text-content-secondary">AI Context</span>
	                        </summary>
	                        <div className="p-3 text-sm text-content-secondary whitespace-pre-wrap max-h-[220px] overflow-y-auto">
	                          {selectedTopicAiContext || 'No topic-level ai_context found. Use AI Semantic Studio to draft reviewable context and semantic guidance.'}
	                        </div>
	                      </details>
	                    </div>

	                    <details className="rounded-card border border-border bg-white overflow-hidden">
	                      <summary className="cursor-pointer px-3 py-2 bg-surface-secondary border-b border-border">
	                        <span className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Current Join Graph</span>
	                      </summary>
	                      <div className="p-3 space-y-2">
	                        <pre className="rounded-button border border-border bg-surface-secondary p-3 text-xs text-content-primary overflow-auto whitespace-pre-wrap">
	                          {selectedTopicJoinYaml || 'No join graph returned yet. Expand/reload the topic before asking AI to modify joins.'}
	                        </pre>
	                        <div className="text-[11px] text-content-secondary">
	                          Existing paths are preserved; proposed joins must pass branch validation.
	                        </div>
	                      </div>
	                    </details>

	                    <div className="bg-omni-50 border border-omni-100 rounded-card p-4 text-sm text-omni-700">
	                      <div className="font-semibold">Governed workflow</div>
	                      <div className="mt-1 text-xs">Drafts stay read-only until Deploy writes approved files to a dev branch for validation and diff review.</div>
	                    </div>
                  </div>
                ) : selectedStudioPath === 'permissions' ? (
                  <div className="p-5 space-y-4">
                    <div className="rounded-card border border-omni-100 bg-omni-50 p-4 text-sm text-omni-700">
                      <div className="font-semibold">Permission Builder path</div>
                      <div className="mt-1 text-xs leading-relaxed">
                        Choose the permission target in Review setup. Topic and view targets stage Settings/model with the selected target so grants and RLS land in the right files.
                      </div>
                    </div>
                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 text-sm items-stretch">
                      <div className="rounded-card border border-border bg-surface-secondary p-3 h-full min-h-[78px]">
                        <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Selected Model</div>
                        <div className="mt-1 font-semibold text-content-primary truncate">{selectedModel?.name || '-'}</div>
                      </div>
                      <div className="rounded-card border border-border bg-surface-secondary p-3 h-full min-h-[78px]">
                        <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Permission Targets</div>
                        <div className="mt-1 text-lg font-semibold text-content-primary">
                          {loadingModelFiles ? '...' : modelFileOptions.length}
                        </div>
                        <div className="mt-0.5 text-[11px] text-content-secondary">model / .topic / .view</div>
                      </div>
                      <div className="rounded-card border border-border bg-surface-secondary p-3 h-full min-h-[78px]">
                        <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Primary Output</div>
                        <div className="mt-1 text-xs font-semibold text-content-primary">model + selected target</div>
                      </div>
                    </div>
                  </div>
                ) : selectedStudioPath === 'model' ? (
                  <div className="p-5 space-y-4">
                    <div className="rounded-card border border-omni-100 bg-omni-50 p-4 text-sm text-omni-700">
	                      <div className="font-semibold">Model / View development path</div>
                      <div className="mt-1 text-xs leading-relaxed">
	                        No topic is required. OmniKit will ask Omni AI for exactly one target file: Settings/model, Settings/relationships, or a .view file.
                      </div>
                    </div>
                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 text-sm items-stretch">
                      <div className="rounded-card border border-border bg-surface-secondary p-3 h-full min-h-[78px]">
                        <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Selected Model</div>
                        <div className="mt-1 font-semibold text-content-primary truncate">{selectedModel?.name || '-'}</div>
	                      </div>
	                      <div className="rounded-card border border-border bg-surface-secondary p-3 h-full min-h-[78px]">
	                        <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Target Files</div>
	                        <div className="mt-1 text-lg font-semibold text-content-primary">
	                          {loadingModelFiles ? '...' : modelFileOptions.length}
	                        </div>
	                        <div className="mt-0.5 text-[11px] text-content-secondary">model / relationships / .view</div>
	                      </div>
                      <div className="rounded-card border border-border bg-surface-secondary p-3 h-full min-h-[78px]">
	                        <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Primary Output</div>
	                        <div className="mt-1 text-xs font-semibold text-content-primary">model / relationships / .view</div>
                      </div>
                    </div>
                  </div>
	                ) : (
	                  <div className="p-8 text-center text-sm text-content-secondary">
	                    <div className="mx-auto max-w-xl">
	                      <div className="text-base font-semibold text-content-primary">Draft a topic from scratch</div>
	                      <div className="mt-2 leading-relaxed">
	                        Continue to Review with no topic selected. Omni AI will use the selected model, existing topic list, and your business context to propose a new topic file name, base view, joins, ai_fields, sample queries, and ai_context.
	                      </div>
	                      <div className="mt-3 rounded-card border border-omni-100 bg-omni-50 px-3 py-2 text-xs text-omni-700">
	                        Existing topics stay untouched unless you select one explicitly.
	                      </div>
	                    </div>
	                  </div>
	                )}
              </div>
              )}

              {studioStep === 'scope' && (
	                <div className="card p-4 space-y-4 order-1">
	                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="text-sm font-semibold text-content-primary">Review setup</div>
                        <div className="text-xs text-content-secondary mt-0.5">
                          This lane stages only the files needed for the selected workflow. Permission Builder can package Settings/model plus the selected topic or view target.
                        </div>
                      </div>
                      <span className="w-fit rounded-chip bg-surface-secondary px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-content-secondary">
                        {selectedStudioPath === 'topic' ? 'Topic lane' : selectedStudioPath === 'permissions' ? 'Permission lane' : 'Model lane'}
                      </span>
                  </div>
                  {selectedPathUsesTargetFile && (
                    <div className="grid grid-cols-1 gap-3">
	                      <div className="rounded-card border border-border bg-white p-3">
	                        <label className="block text-xs font-semibold text-content-primary">
		                          Target semantic file
	                        </label>
	                        <div className="text-[11px] text-content-secondary mt-0.5">
		                          {selectedPathIncludesPermissions
                                ? 'Required. Choose Settings/model, an existing .topic, or a .view file. Topic/view selections also stage Settings/model for grants.'
                                : 'Required. Choose Settings/model, Settings/relationships, or the .view file this run should build.'}
	                        </div>
	                        <SearchInput
	                          value={targetFileSearch}
	                          onChange={setTargetFileSearch}
	                          placeholder={loadingModelFiles ? 'Loading model files...' : selectedPathIncludesPermissions ? 'Search model, .topic, or .view files...' : 'Search model, relationships, or .view files...'}
	                        />
	                        <div className="mt-2 max-h-[220px] overflow-y-auto rounded-card border border-border bg-white">
	                          {!selectedModel ? (
	                            <div className="px-3 py-3 text-xs text-content-secondary">Choose a model first.</div>
	                          ) : loadingModelFiles ? (
	                            <div className="flex items-center gap-2 px-3 py-3 text-xs text-content-secondary">
	                              <Loader2 size={14} className="animate-spin text-omni-500" />
	                              Loading model files...
	                            </div>
	                          ) : targetFileOptions.length === 0 ? (
	                            <div className="px-3 py-3 text-xs text-content-secondary">No target files match that search.</div>
	                          ) : (
	                            targetFileOptions.map((fileName) => {
	                              const selected = targetBaseViewName === fileName;
	                              const fileType = fileName === 'model'
	                                ? 'Settings/model'
	                                : fileName === 'relationships'
	                                  ? 'Settings/relationships'
                                    : fileName.endsWith('.topic')
                                      ? '.topic'
	                                  : '.view';
	                              return (
	                                <button
	                                  key={fileName}
	                                  type="button"
	                                  onClick={() => {
	                                    setTargetBaseViewName(fileName);
	                                    if (aiConversationId) resetAiConversation();
	                                  }}
                                    aria-pressed={selected}
	                                  className={`w-full border-b border-border/60 px-3 py-2.5 text-left transition-all last:border-b-0 ${
	                                    selected ? selectedRowClass : unselectedRowClass
	                                  }`}
	                                >
	                                  <div className="flex items-center justify-between gap-3">
	                                    <span className="min-w-0 truncate font-mono text-xs">{fileName}</span>
	                                    <span className={selected ? selectedBadgeClass : unselectedBadgeClass}>
                                        {selected && <CheckCircle2 size={12} />}
	                                      {selected ? 'Selected' : fileType}
	                                    </span>
	                                  </div>
	                                </button>
	                              );
	                            })
	                          )}
	                        </div>
	                        {!modelTargetReady && (
	                          <div className="mt-2 text-[11px] text-amber-700">
	                            Pick one target so the generated package stays focused and reviewable.
	                          </div>
                        )}
                      </div>
                    </div>
                  )}
	                  <div className="rounded-card border border-omni-100 bg-omni-50 p-3">
	                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
	                      <div>
	                        <div className="text-xs font-semibold text-omni-800">Selected output</div>
	                        <div className="text-xs text-omni-700">{selectedPathConfig?.output}</div>
	                      </div>
	                      <div className="text-[11px] text-omni-700">
	                        Draft only until Deploy validates a dev branch.
	                      </div>
	                    </div>
	                  </div>
		                  {laneFileScope && (
		                    <div className="rounded-card border border-border bg-white p-3">
		                      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
		                        <div>
		                          <div className="text-sm font-semibold text-content-primary">{laneFileScope.title}</div>
		                          <div className="text-xs text-content-secondary mt-0.5">{laneFileScope.subtitle}</div>
		                        </div>
		                        <span className="w-fit rounded-chip bg-surface-secondary px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-content-secondary">
		                          {selectedStudioPath === 'topic' ? '.topic only' : targetSemanticFile ? `${targetSemanticFileType} only` : 'Pick target'}
		                        </span>
		                      </div>
		                      <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-content-secondary md:grid-cols-2">
		                        {laneFileScope.items.map((item) => (
		                          <div key={item.label} className="rounded-button border border-border bg-surface-secondary p-2">
		                            <div className="font-mono font-semibold text-content-primary">{item.label}</div>
		                            <div className="mt-1">{item.description}</div>
		                          </div>
		                        ))}
		                      </div>
		                    </div>
		                  )}
	                  <div className="rounded-card border border-border bg-white p-3 space-y-3">
	                    <div>
		                      <div className="text-sm font-semibold text-content-primary">Optional focus toggles</div>
	                      <div className="text-xs text-content-secondary mt-0.5">
	                        {selectedStudioPath === 'topic'
		                          ? 'Choose what Topic Builder should inspect more deeply. Metrics and model definitions stay out of topic YAML.'
                              : selectedStudioPath === 'permissions'
                                ? 'Choose what Permission Builder should inspect more deeply. Settings/model is staged automatically when the selected target needs grants.'
		                          : 'Choose what Model / View Builder should inspect more deeply for the selected target file.'}
	                      </div>
	                    </div>
	                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-stretch">
	                    {visibleInspectionWorkstreams.map((workstream) => {
                      const selected = selectedWorkstreams.includes('full') || selectedWorkstreams.includes(workstream.id);
                      return (
                        <button
                          key={workstream.id}
                          type="button"
                          onClick={() => toggleWorkstream(workstream.id)}
                          aria-pressed={selected}
	                          className={`relative text-left rounded-card border p-3 transition-all h-full min-h-[84px] ${
                            selected ? selectedCardClass : unselectedCardClass
                          }`}
                        >
                          {selected && <div className="absolute left-0 top-0 h-full w-1 rounded-l-[8px] bg-omni-500" />}
                          <div className="flex items-start justify-between gap-3 pl-1">
                            <div>
                              <div className="text-sm font-semibold text-content-primary">{workstream.label}</div>
                              <div className="mt-1 text-xs text-content-secondary leading-relaxed">{workstream.description}</div>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-2">
                              <span className={selected ? selectedBadgeClass : unselectedBadgeClass}>
                                {selected && <CheckCircle2 size={12} />}
                                {selected ? 'Selected' : workstream.layer}
                              </span>
                              <CheckCircle2 className={`h-4 w-4 ${selected ? 'text-omni-600' : 'text-content-tertiary'}`} />
                            </div>
                          </div>
                        </button>
                      );
                    })}
                    </div>
                  </div>
                  <div className="flex justify-end">
                  <button
                      type="button"
                      onClick={() => setStudioStep('baseline')}
                      disabled={!selectedModel || !modelTargetReady}
                      className="btn-primary text-sm"
                    >
                      Continue to Review
                    </button>
                  </div>
                </div>
              )}

              {studioStep === 'baseline' && (
              <>
              <div className="card p-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-border bg-white flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                  <Bot size={16} className="text-omni-700" />
	                  <div>
	                  <div className="text-sm font-semibold text-content-primary">AI Discovery Review</div>
	                  <div className="text-xs text-content-secondary mt-0.5">
	                      {selectedStudioPath === 'permissions'
                          ? 'Start here. Omni AI reviews permission integrity for the selected model, topic, or view target. The file is generated only after Confirm.'
                        : selectedStudioPath === 'model'
		                        ? 'Start here. Omni AI reviews the selected model, relationships, or .view target and recommends what should change. The file is generated only after Confirm.'
	                        : 'Start here. Omni AI reviews topic shape, joins, routing, ai_fields, and sample queries. Topic YAML is generated only after Confirm.'}
                    </div>
	                </div>
              </div>
              {aiChatUrl && (
                <a
                  href={aiChatUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-secondary text-xs"
                >
                  <ExternalLink size={13} />
                  Open in Omni
                </a>
              )}
            </div>

            <div className="p-4 space-y-4">
              {selectedModel?.kind !== 'SHARED' && (
                <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs px-3 py-2 rounded-card">
                  Omni AI topic picking and AI jobs are documented for shared models. Use a shared model for the most reliable result.
                </div>
              )}

	              <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
                <div className="xl:col-span-2">
                  <label className="block text-xs font-medium text-content-secondary mb-1.5">Optional goal or question</label>
                  <textarea
                    value={aiPrompt}
                    onChange={(e) => handleAiPromptChange(e.target.value)}
                    className="input-field min-h-[96px] resize-y text-sm"
                    placeholder={
                      selectedStudioPath === 'permissions'
                        ? 'Optional. Example: Restrict this topic to users whose employee email matches the current Omni user email, but ask before writing YAML.'
                        : selectedStudioPath === 'model'
                        ? 'Optional. Example: Create governed metrics and clear field definitions for the selected view. If unsure, leave blank and start broad.'
                        : 'Optional. Example: Can this topic answer revenue, margin, and returns questions? If unsure, leave blank and start broad.'
                    }
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-content-secondary mb-1.5">
	                    {selectedPathUsesTargetFile ? 'Target semantic file' : 'Topic to review'}
                  </label>
                  {selectedPathUsesTargetFile ? (
                    <div className="rounded-card border border-border bg-surface-secondary px-3 py-3">
                      <div className="font-mono text-xs text-content-primary break-all">
                        {targetBaseViewName || 'No target selected'}
                      </div>
                      <div className="mt-1 text-[11px] text-content-secondary">
                        Change this in Scope so the AI thread stays attached to one semantic file.
                      </div>
                    </div>
                  ) : (
                    <select
                      value={aiFocusTopic || selectedTopicName}
                      onChange={(e) => {
                        setAiFocusTopic(e.target.value);
                        setSelectedTopicName(e.target.value);
                        resetAiConversation();
                        if (e.target.value) fetchTopicDetail(e.target.value);
                      }}
                      className="input-field"
                    >
	                      <option value="">Create/propose new topic</option>
                      {topics.map((topic) => (
                        <option key={topic.name} value={topic.name}>{topic.label || topic.name}</option>
                      ))}
                    </select>
                  )}
	                  <div className="mt-2 text-[11px] text-content-secondary">
	                    {selectedStudioPath === 'permissions'
                            ? 'Permission Builder will generate Settings/model plus this selected permission target after Confirm when the target needs grants.'
                          : selectedStudioPath === 'model'
			                      ? 'Model / View Builder will generate YAML only for this selected file after Confirm.'
	                      : 'Choose an existing topic to update, or keep Create/propose new topic selected to draft a new .topic file.'}
	                  </div>
	                  {selectedPathUsesTargetFile && !modelTargetReady && (
	                    <div className="mt-2 rounded-card border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
	                      {selectedPathIncludesPermissions
                          ? <>Choose one target before running discovery: <span className="font-mono">model</span>, an existing <span className="font-mono">.topic</span>, or a <span className="font-mono">.view</span> file.</>
                          : <>Choose one target before running discovery: <span className="font-mono">model</span>, <span className="font-mono">relationships</span>, or a <span className="font-mono">.view</span> file.</>}
	                    </div>
	                  )}
                  {aiPickedTopic && (
                    <div className="mt-2 text-xs text-omni-700">
                      Picked: <span className="font-semibold">{topics.find((topic) => topic.name === aiPickedTopic)?.label || aiPickedTopic}</span>
                      {topics.some((topic) => topic.name === aiPickedTopic) && (
                        <span className="font-mono text-content-tertiary"> ({aiPickedTopic})</span>
                      )}
                    </div>
                  )}
                </div>
	              </div>

	              <div className="rounded-card border border-border bg-surface-secondary p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
	                <div className="text-xs text-content-secondary leading-relaxed">
		                  <span className="font-semibold text-content-primary">Review first, generate later.</span> No deployable file is created in this step.{' '}
	                  <span className="ml-1">
	                    {aiConversationId
	                      ? 'Review chunks reuse one Omni AI thread; Generate uses one isolated package thread.'
	                      : 'A new review thread starts when the review runs; package retries reuse their own isolated thread.'}
	                  </span>
	                </div>
	                {aiConversationId && (
	                  <button type="button" onClick={resetAiConversation} className="text-xs text-omni-700 hover:text-omni-900 font-medium">
	                    Start new AI thread
	                  </button>
	                )}
	              </div>

	              <div className="rounded-card border border-border bg-white p-3">
	                <div className="text-xs font-semibold text-content-primary">File creation sequence</div>
	                <div className="mt-2 grid grid-cols-1 gap-2 text-[11px] text-content-secondary sm:grid-cols-4">
	                  <div className="rounded-button border border-border bg-surface-secondary px-3 py-2">
	                    <span className="font-semibold text-content-primary">1 Review</span>
	                    <div>Find gaps and recommendations.</div>
	                  </div>
	                  <div className="rounded-button border border-border bg-surface-secondary px-3 py-2">
	                    <span className="font-semibold text-content-primary">2 Confirm</span>
	                    <div>Approve questions and rules.</div>
	                  </div>
	                  <div className="rounded-button border border-border bg-surface-secondary px-3 py-2">
	                    <span className="font-semibold text-content-primary">3 Generate</span>
	                    <div>Tell Blobby to create the file.</div>
	                  </div>
	                  <div className="rounded-button border border-border bg-surface-secondary px-3 py-2">
	                    <span className="font-semibold text-content-primary">4 Deploy</span>
	                    <div>Save to dev branch only.</div>
	                  </div>
	                </div>
	              </div>

		              <div className="space-y-3">
	                {topicCreationMode && (
	                  <div className="rounded-card border border-omni-100 bg-omni-50 p-4 space-y-4">
	                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
	                      <div className="flex items-start gap-3">
	                        <Blobby mood="semantic" size={58} className="animate-float" style={{ animationDuration: '3.5s' }} />
	                        <div>
	                          <div className="text-sm font-semibold text-omni-800">New topic brief</div>
	                          <div className="mt-1 text-xs leading-relaxed text-omni-700">
	                            Tell Blobby what this topic should answer first. Then Omni AI reviews the selected model, available views, and existing topics to recommend the best new .topic file.
	                          </div>
	                        </div>
	                      </div>
	                      <span className={`w-fit rounded-chip px-2 py-1 text-[10px] font-semibold ${
	                        newTopicBriefReady ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
	                      }`}>
	                        {newTopicBriefReady ? `${newTopicBriefItemCount} input${newTopicBriefItemCount === 1 ? '' : 's'} ready` : 'Needs brief'}
	                      </span>
	                    </div>
	                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
	                      <EditableList
	                        label="Questions this new topic should answer"
	                        description="Add the natural-language questions that justify creating a new topic."
	                        values={readinessInputs.questions}
	                        placeholder="e.g. Which campaigns drove pipeline this quarter?"
	                        onChange={(values) => updateReadinessInputs({
	                          questions: values,
	                          questionInputs: values.map((_, index) => readinessInputs.questionInputs[index] || ''),
	                        })}
	                        details={readinessInputs.questionInputs}
	                        detailPlaceholder="Add expected answer shape, required grain, default filters, metric definitions, or acceptance criteria..."
	                        onDetailsChange={(values) => updateReadinessInputs({ questionInputs: values })}
	                      />
	                      <EditableList
	                        label="Business use cases"
	                        description="Add the workflows, stakeholders, or decisions this new topic should support."
	                        values={readinessInputs.useCases}
	                        placeholder="e.g. Weekly executive pipeline review"
	                        onChange={(values) => updateReadinessInputs({
	                          useCases: values,
	                          useCaseInputs: values.map((_, index) => readinessInputs.useCaseInputs[index] || ''),
	                        })}
	                        details={readinessInputs.useCaseInputs}
	                        detailPlaceholder="Add decision owner, cadence, KPIs, routing expectations, or success criteria..."
	                        onDetailsChange={(values) => updateReadinessInputs({ useCaseInputs: values })}
	                      />
	                    </div>
	                    {!newTopicBriefReady && (
	                      <div className="rounded-button border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
	                        Add at least one question, use case, goal, or admin note before Blobby recommends a new topic.
	                      </div>
	                    )}
	                  </div>
	                )}
	                <button
	                  onClick={handleRunDeepReview}
	                  disabled={aiIsBusy || !canRunDiscoveryReview}
	                  className="btn-primary text-sm justify-center w-full"
	                >
	                  {deepReviewRunning ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
		                  {topicCreationMode ? 'Review Model and Recommend Topic' : 'Run AI Discovery Review'}
	                </button>
	                <div className="text-[11px] text-content-tertiary">
	                  {topicCreationMode
		                    ? 'Runs after the brief is filled in, then recommends a topic candidate. Blobby generates the .topic file only after you confirm.'
		                    : 'Runs four sequential discovery chunks. Blobby generates the file package only after you confirm the business inputs.'}
	                </div>
		              </div>

              {(deepReviewRunning || deepReviewStarted) && (
                <div className="rounded-card border border-border bg-white overflow-hidden">
                  <div className="px-4 py-3 border-b border-border bg-surface-secondary flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-content-primary">Token-safe deep review</div>
                      <div className="text-xs text-content-secondary mt-0.5">
                        {deepReviewProgressLabel}. Each chunk runs after the prior chunk succeeds, keeping API calls spaced out.
                      </div>
                    </div>
                    <span className={`text-[11px] px-2 py-1 rounded-chip ${deepReviewRunning ? 'bg-amber-50 text-amber-700' : deepReviewError ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
                      {deepReviewRunning ? 'Running' : deepReviewError ? 'Needs attention' : 'Ready'}
                    </span>
                  </div>
                  <div className="p-4 space-y-4">
                    {deepReviewRunning && (
	                      <AIWorkingAnimation
	                        variant="semantic"
	                        title={selectedPathIncludesPermissions ? 'Building the permission package' : selectedPathIncludesModel ? 'Building the model/view package' : topicCreationMode ? 'Reviewing model and recommending topic' : 'Building the topic package'}
	                        detail={deepReviewAnimationDetail}
                        statusLabel={deepReviewProgressLabel}
                        steps={deepReviewAnimationSteps}
                        compact
                      />
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                      {deepReviewChunks.map((chunk, index) => (
                        <div
                          key={chunk.id}
                          className={`rounded-card border p-3 ${
                            chunk.status === 'complete'
                              ? 'border-green-200 bg-green-50'
                              : chunk.status === 'running'
                                ? 'border-omni-200 bg-omni-50'
                                : chunk.status === 'failed'
                                  ? 'border-red-200 bg-red-50'
                                  : 'border-border bg-white'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[11px] font-semibold text-content-primary">{index + 1}. {chunk.label}</div>
                            {chunk.status === 'running' ? (
                              <Loader2 size={13} className="text-omni-600 animate-spin" />
                            ) : chunk.status === 'complete' ? (
                              <CheckCircle2 size={13} className="text-green-700" />
                            ) : chunk.status === 'failed' ? (
                              <X size={13} className="text-red-700" />
                            ) : (
                              <span className="w-3 h-3 rounded-full border border-border" />
                            )}
                          </div>
                          <div className="mt-1 text-[10px] text-content-secondary leading-snug">{chunk.description}</div>
                          <div className="mt-2 text-[10px] font-medium text-content-secondary">
                            {chunk.status === 'running'
                              ? 'Running now'
                              : chunk.status === 'complete'
                                ? 'Complete'
                                : chunk.status === 'failed'
                                  ? 'Needs attention'
                                  : 'Waiting'}
                          </div>
                          {chunk.jobId && <div className="mt-2 text-[9px] font-mono text-content-tertiary truncate">{chunk.jobId}</div>}
                        </div>
                      ))}
                    </div>

                    {deepReviewRunning && (
                      <div className="rounded-card border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        {activeDeepReviewChunk
                          ? `${activeDeepReviewChunk.label} is running. Completed chunks remain saved, and the next chunk will not start until this one succeeds.`
                          : 'Waiting for Omni to acknowledge the next chunk.'}
                      </div>
                    )}

                    {deepReviewError && (
                      <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded-card">
                        {deepReviewError}
                      </div>
                    )}

                    {copyError && manualCopy && (
                      <ManualCopyFallback manualCopy={manualCopy} onClose={() => setManualCopy(null)} />
                    )}

                    {deepReviewSummary && (
                      <details className="rounded-card border border-border bg-white overflow-hidden">
                        <summary className="cursor-pointer px-3 py-2 border-b border-border bg-surface-secondary">
                          <div>
                            <div className="text-xs font-semibold text-content-primary">Supporting review summary</div>
                            <div className="text-[11px] text-content-secondary mt-0.5">Merged findings from the sequential AI chunks.</div>
                          </div>
                        </summary>
                        <div className="p-4 max-h-[420px] overflow-y-auto">
                          <div className="flex justify-end mb-3">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              handleCopyResult('deep-review-summary', deepReviewSummary);
                            }}
                            className="btn-secondary text-xs px-2 py-1.5"
                          >
                            {copiedResult === 'deep-review-summary' ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                            {copiedResult === 'deep-review-summary' ? 'Copied' : 'Copy Summary'}
                          </button>
                          </div>
                          <MarkdownLite content={deepReviewSummary} />
                        </div>
                      </details>
                    )}

                    {deepReviewYamlDrafts.map((draft) => (
                      <YamlDraftCard
                        key={`deep-${draft.id}`}
                        draft={{ ...draft, description: 'Generated by the final sequential chunk after the structured audit chunks completed.' }}
                        copied={copiedResult === `deep-${draft.id}`}
                        onCopy={() => handleCopyResult(`deep-${draft.id}`, draft.content)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {showBaselineCard && (
                <details open={!deepReviewComplete} className="rounded-card border border-border bg-white overflow-hidden">
                  <summary className="cursor-pointer px-4 py-3 border-b border-border bg-surface-secondary">
                    <div>
                      <div className="text-sm font-semibold text-content-primary">Baseline findings</div>
                      <div className="text-xs text-content-secondary mt-0.5">
                        {baselineStatus ? `Job status: ${baselineStatus}` : 'Readiness probe result'}
                      </div>
                    </div>
                  </summary>
                  <div className="p-4 max-h-[560px] overflow-y-auto">
                    {baselineMessage && (
                      <div className="flex justify-end mb-3">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          handleCopyResult('readiness', baselineMessage);
                        }}
                        className="btn-secondary text-xs px-2 py-1.5"
                      >
                        {copiedResult === 'readiness' ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                        {copiedResult === 'readiness' ? 'Copied' : 'Copy Findings'}
                      </button>
                      </div>
                    )}
                    {baselineMessage && baselineSummary ? (
                      <ReadinessSummaryView
                        summary={baselineSummary}
                        rawMessage={baselineMessage}
                        copied={copiedResult === 'readiness'}
                        onCopy={() => handleCopyResult('readiness', baselineMessage)}
                      />
                    ) : aiError ? (
                      <div className="rounded-card border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
                        <div>{aiError}</div>
                        {baselineChatUrl && (
                          <a
                            href={baselineChatUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-flex items-center gap-1 font-medium text-red-800 hover:text-red-900"
                          >
                            <ExternalLink size={13} />
                            Open the Omni chat
                          </a>
                        )}
                      </div>
	                    ) : (
	                      <div className="text-sm text-content-secondary">
	                        Omni marked the job complete, but did not return a readable readiness result to OmniKit.
                      </div>
                    )}
                  </div>
                </details>
              )}

              {aiLastMode === 'readiness-probe' && copyError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded-card">
                  {copyError}
                </div>
              )}

              {aiLastMode === 'readiness-probe' && manualCopy && (
                <ManualCopyFallback manualCopy={manualCopy} onClose={() => setManualCopy(null)} />
              )}

              {readinessCompleted && (
                <div className="flex flex-col items-end gap-2">
                  {deepReviewStarted && !deepReviewComplete && (
                    <div className="text-xs text-content-secondary">
                      {reviewChunksComplete
                        ? 'Review the AI findings and confirm inputs before generating YAML.'
                        : 'Finish the discovery review before confirming business inputs.'}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setStudioStep('confirm')}
                    disabled={!canContinueToConfirm}
                    className="btn-primary text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {!reviewChunksComplete ? 'Review still running' : 'Continue to Confirm'}
                  </button>
                </div>
              )}
            </div>
          </div>
              </>
              )}

              {studioStep === 'confirm' && (
              <div className="rounded-card border border-border bg-white overflow-hidden">
                <div className="px-4 py-3 border-b border-border bg-surface-secondary flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-content-primary">Confirm Review Inputs</div>
                    <div className="text-xs text-content-secondary mt-0.5">
                      Review what Omni AI suggested for this {confirmScopeNoun}, correct anything that does not match the business, and add details a nontechnical admin would know.
                    </div>
                  </div>
                  <span className={`text-[11px] px-2 py-1 rounded-chip ${readinessCompleted ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                    {readinessCompleted ? 'Baseline ready' : 'Run probe first'}
                  </span>
                </div>
                <div className="p-4 space-y-4">
                  {!readinessCompleted && (
                    <div className="bg-amber-50 border border-amber-100 text-amber-800 text-xs px-3 py-2 rounded-card">
                      Run the AI discovery review first. It will pre-fill this step with suggested questions, use cases, business rules, gaps, and out-of-scope items.
                    </div>
                  )}
                  {readinessCompleted && (
                    <>
	                      <div className="rounded-card border border-omni-100 bg-omni-50 p-3 text-sm text-omni-700">
	                        <div className="font-semibold">Your role in this step</div>
	                        <div className="mt-1 text-xs leading-relaxed">
	                          {selectedPathIncludesPermissions
                              ? 'You do not need to write YAML. For enforceable permissions, confirm the exact grant name, user_attribute reference, allowed values, access filter field, bypass value, and null/default behavior. When this looks right, tell Blobby to generate the model plus target package from these approved inputs.'
                              : 'You do not need to write YAML. Confirm whether these questions, definitions, and rules are true for your business. When this looks right, tell Blobby to generate the file package from these approved inputs.'}
	                        </div>
	                      </div>
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                        <EditableList
                          label="Questions to support"
                          description={`Confirm the natural-language questions this ${confirmScopeNoun} should support, then add the expected answer shape or business nuance underneath each one.`}
                          values={readinessInputs.questions}
                          placeholder="e.g. What was revenue by month?"
                          onChange={(values) => updateReadinessInputs({
                            questions: values,
                            questionInputs: values.map((_, index) => readinessInputs.questionInputs[index] || ''),
                          })}
                          details={readinessInputs.questionInputs}
                          detailPlaceholder="Add expected answer, required metric, default filter, definition, owner note, or validation criteria..."
                          onDetailsChange={(values) => updateReadinessInputs({ questionInputs: values })}
                        />
                        <EditableList
                          label="Business use cases"
                          description={`Confirm the workflows this ${confirmScopeNoun} should enable, then add the decision, stakeholder, cadence, or success criteria underneath each one.`}
                          values={readinessInputs.useCases}
                          placeholder="e.g. Forecast actuals vs targets"
                          onChange={(values) => updateReadinessInputs({
                            useCases: values,
                            useCaseInputs: values.map((_, index) => readinessInputs.useCaseInputs[index] || ''),
                          })}
                          details={readinessInputs.useCaseInputs}
                          detailPlaceholder="Add workflow owner, business decision, cadence, KPIs, handoff notes, or success criteria..."
                          onDetailsChange={(values) => updateReadinessInputs({ useCaseInputs: values })}
                        />
                        <EditableList
                          label="Business rules"
                          description="Confirm filters, definitions, grains, and date logic Omni Agent should respect."
                          values={readinessInputs.businessRules}
                          placeholder="e.g. Use Complete and Processing for revenue"
                          defaultOpen={false}
                          onChange={(values) => updateReadinessInputs({ businessRules: values })}
                        />
                        <EditableList
                          label="Gaps to address"
                          description="Confirm blockers or modeling improvements the YAML should account for."
                          values={readinessInputs.gaps}
                          placeholder="e.g. Add a forecast target table"
                          defaultOpen={false}
                          onChange={(values) => updateReadinessInputs({ gaps: values })}
                        />
                      </div>
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                        <EditableList
                          label="Out-of-scope questions"
                          description={`Confirm questions this ${confirmScopeNoun} should route away from or avoid answering.`}
                          values={readinessInputs.outOfScope}
                          placeholder="e.g. Do not answer inventory on hand"
                          defaultOpen={false}
                          onChange={(values) => updateReadinessInputs({ outOfScope: values })}
                        />
                        <div className="rounded-card border border-border bg-white p-3">
                          <label className="text-xs font-semibold text-content-primary">Admin notes</label>
                          <div className="text-[11px] text-content-secondary mt-0.5">Add any business nuance Omni Agent should carry into the YAML drafts.</div>
                          <textarea
                            value={readinessInputs.notes}
                            onChange={(event) => updateReadinessInputs({ notes: event.target.value })}
                            className="input-field text-xs min-h-[126px] resize-y mt-2"
                            placeholder="Optional notes, owners, validation concerns, or wording preferences..."
                          />
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={handleGenerateFinalPackage}
                          disabled={deepReviewRunning || !reviewChunksComplete}
                          className="btn-primary text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {deepReviewRunning ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
	                          Tell Blobby to Generate File
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
              )}

              {studioStep === 'package' && (
                <div className="rounded-card border border-border bg-white overflow-hidden">
                  <div className="px-4 py-3 border-b border-border bg-surface-secondary flex items-center justify-between gap-3">
		                    <div>
		                      <div className="text-sm font-semibold text-content-primary">Change Package</div>
		                      <div className="text-xs text-content-secondary mt-0.5">
		                        Generated only after you told Blobby to create the file package. Review before opening Deploy.
		                      </div>
		                    </div>
                    <ClipboardCheck size={18} className="text-omni-700" />
                  </div>
                  <div className="p-4 space-y-4">
                    {deepReviewComplete && packageHasDeployableFiles ? (
                      <div className="rounded-card border border-green-200 bg-green-50 p-4 text-sm text-green-800">
	                        <div className="font-semibold">Final package is ready</div>
	                        <div className="mt-1 text-xs leading-relaxed">
	                          {selectedStudioPath === 'permissions'
                              ? 'Permission target YAML is ready for review.'
                              : selectedStudioPath === 'model'
                              ? 'View/model YAML files are ready for review.'
                              : 'Topic YAML is ready for review.'}
	                        </div>
                      </div>
                    ) : deepReviewComplete ? (
                      <div className="rounded-card border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                        <div className="font-semibold">No deployable file was captured</div>
                        <div className="mt-1 text-xs leading-relaxed">
                          The AI response did not include a complete, valid YAML body for the selected target file. Return to Confirm and regenerate, or narrow the scope before saving to a dev branch.
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-card border border-amber-100 bg-amber-50 p-4 text-sm text-amber-800">
	                        <div className="font-semibold">Package not ready yet</div>
	                        <div className="mt-1 text-xs leading-relaxed">
			                          Run the discovery review, confirm the inputs, then tell Blobby to generate the file package from those confirmed inputs.
	                        </div>
                        <button
                          type="button"
                          onClick={() => setStudioStep(reviewChunksComplete ? 'confirm' : 'baseline')}
                          className="btn-secondary text-xs mt-3"
                        >
                          {reviewChunksComplete ? 'Go to Confirm' : 'Go to Review'}
                        </button>
                      </div>
                    )}
	                    <div className="rounded-card border border-border bg-surface-secondary p-3 text-xs text-content-secondary">
	                      <span className="font-semibold text-content-primary">Deployable package files:</span>{' '}
                      {selectedPathIncludesTopic
                        ? `${deepReviewYamlDrafts.length} topic file${deepReviewYamlDrafts.length === 1 ? '' : 's'}`
                        : `${deepReviewViewModelDrafts.length} ${selectedPathIncludesPermissions ? 'permission package' : 'model/view'} file${deepReviewViewModelDrafts.length === 1 ? '' : 's'}`}
                      {deepReviewViewModelDrafts.length > 0 && (
                        <span className="block mt-1">
                          Targets: {deepReviewViewModelDrafts.map((draft) => draft.targetFileName).filter(Boolean).join(', ')}
                        </span>
                      )}
                    </div>

                    {deepReviewYamlDrafts.map((draft) => (
                      <YamlDraftCard
                        key={`package-${draft.id}`}
                        draft={{ ...draft, description: 'Final YAML generated from confirmed inputs. Review with a data owner before applying.' }}
                        copied={copiedResult === `package-${draft.id}`}
                        onCopy={() => handleCopyResult(`package-${draft.id}`, draft.content)}
                      />
                    ))}

                    {deepReviewViewModelDrafts.map((draft) => (
                      <YamlDraftCard
                        key={`package-${draft.id}`}
                        draft={draft}
                        copied={copiedResult === `package-${draft.id}`}
                        onCopy={() => handleCopyResult(`package-${draft.id}`, draft.content)}
                      />
                    ))}

                    <ReviewSections
                      sections={deepReviewPackageSections}
                      copiedResult={copiedResult}
                      onCopy={handleCopyResult}
                    />

                    {deepReviewComplete && packageHasDeployableFiles && (
                      <div className="flex justify-end">
                        <button type="button" onClick={handleOpenDeployStep} className="btn-primary text-sm">
                          Continue to Deploy
                        </button>
                      </div>
                    )}

                    {deepReviewSummary && (
                      <details className="rounded-card border border-border bg-white overflow-hidden">
                        <summary className="cursor-pointer px-3 py-2 border-b border-border bg-surface-secondary">
                          <span className="text-xs font-semibold text-content-primary">Supporting Review Notes</span>
                        </summary>
                        <div className="p-4 max-h-[360px] overflow-y-auto">
                          <MarkdownLite content={deepReviewSummary} />
                        </div>
                      </details>
                    )}

	                  </div>
	                </div>
	              )}

              {studioStep === 'deploy' && (
                <div className="rounded-card border border-border bg-white overflow-hidden">
                  <div className="px-4 py-3 border-b border-border bg-surface-secondary flex items-center justify-between gap-3">
                    <div>
	                      <div className="text-sm font-semibold text-content-primary">Save To Dev Branch</div>
	                      <div className="text-xs text-content-secondary mt-0.5">
		                        Save approved files to a dev branch, validate, diff, then finish sign-off in Omni.
	                      </div>
                    </div>
                    <ShieldCheck size={18} className="text-omni-700" />
                  </div>
                  <div className="p-4 space-y-4">
                    <div className="grid grid-cols-1 xl:grid-cols-4 gap-3 text-sm items-stretch">
                      <div className="rounded-card border border-border bg-white p-3 h-full min-h-[86px]">
                        <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">1 Branch</div>
	                        <div className="mt-1 text-xs text-content-secondary">Create or reuse a dev branch.</div>
                      </div>
                      <div className="rounded-card border border-border bg-white p-3 h-full min-h-[86px]">
                        <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">2 Save</div>
	                        <div className="mt-1 text-xs text-content-secondary">Write approved YAML only.</div>
                      </div>
                      <div className="rounded-card border border-border bg-white p-3 h-full min-h-[86px]">
                        <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">3 Validate</div>
	                        <div className="mt-1 text-xs text-content-secondary">Run model and content checks.</div>
                      </div>
                      <div className="rounded-card border border-border bg-white p-3 h-full min-h-[86px]">
	                        <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">4 Omni Sign-off</div>
		                        <div className="mt-1 text-xs text-content-secondary">Review evidence, then finish in Omni.</div>
                      </div>
                    </div>

                    <div className="rounded-card border border-omni-100 bg-omni-50 p-4 text-sm text-omni-700">
                      <div className="font-semibold">Review before save</div>
                      <div className="mt-1 text-xs leading-relaxed">
	                        Edit staged YAML if needed. OmniKit writes these files only to the dev branch.
                      </div>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-content-primary">Files To Save</div>
	                            <div className="text-xs text-content-secondary mt-0.5">Generated package files for the dev branch.</div>
                          </div>
                        </div>

                        <div className={`rounded-card border p-4 text-sm ${
                          deployFiles.length > 0
                            ? 'border-green-100 bg-green-50 text-green-800'
                            : 'border-amber-100 bg-amber-50 text-amber-800'
                        }`}>
                          <div className="font-semibold">
                            {deployFiles.length > 0 ? 'Generated package is staged automatically' : 'No generated file is staged'}
                          </div>
                          <div className="mt-1 text-xs leading-relaxed">
                            {deployFiles.length > 0
	                              ? 'Files come from the Package step for this topic/model.'
                              : 'Return to Package to generate the selected Topic Builder or Model / View Builder files before deploying. Deploy is not meant for ad hoc blank YAML files.'}
                          </div>
                        </div>

                        {deployFiles.length === 0 ? (
                          <div className="rounded-card border border-amber-100 bg-amber-50 p-4 text-sm text-amber-800">
	                            No files staged yet. Return to Package to generate the AI Semantic Studio package for the selected path.
                          </div>
                        ) : (
                          deployFiles.map((file) => (
                            <div key={file.id} className="rounded-card border border-border bg-white overflow-hidden">
                              <div className="px-3 py-2 bg-surface-secondary border-b border-border flex items-center justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                  <label className="text-[11px] font-semibold uppercase tracking-wider text-content-secondary">Target file</label>
                                  <div className="mt-1 inline-flex max-w-full items-center rounded-chip border border-border bg-white px-2 py-1 font-mono text-[11px] text-content-primary">
                                    <span className="truncate">{formatDeployReviewPath(file.fileName)}</span>
                                  </div>
                                  <input
                                    value={file.fileName}
                                    onChange={(event) => updateDeployFile(file.id, { fileName: event.target.value })}
                                    className="input-field mt-1 font-mono text-xs"
                                    placeholder="example.topic or example.view"
                                  />
                                </div>
                                <div className="flex flex-col items-end gap-2">
                                  <span className="text-[10px] px-2 py-1 rounded-chip bg-white text-content-secondary">
                                    {file.source === 'topic-builder' ? 'Topic Builder' : file.source === 'permission-builder' ? 'Permission Builder' : file.source === 'view-model-builder' ? 'Model / View Builder' : 'Manual'}
                                  </span>
                                  <button type="button" onClick={() => removeDeployFile(file.id)} className="btn-secondary text-xs px-2 py-1.5">
                                    Remove
                                  </button>
                                </div>
                              </div>
                              <textarea
                                value={file.yaml}
                                onChange={(event) => updateDeployFile(file.id, { yaml: event.target.value })}
                                className="w-full min-h-[260px] p-3 font-mono text-xs border-0 focus:ring-0 bg-white text-content-primary"
                                spellCheck={false}
                              />
                            </div>
                          ))
                        )}
                      </div>

                      <div className="space-y-3 xl:pt-[50px]">
                        <div className="rounded-card border border-border bg-white p-3">
                          <div className="text-sm font-semibold text-content-primary">Branch</div>
                          <label className="block mt-3 text-[11px] font-semibold uppercase tracking-wider text-content-secondary">Dev branch name</label>
                          <input
                            value={deployBranchName}
                            onChange={(event) => {
                              setDeployBranchNameEdited(true);
                              setDeployBranchName(event.target.value);
                              setDeployBranchId('');
                            }}
                            className="input-field mt-1 text-xs"
                            placeholder={buildBranchName(packageScopeName || selectedModel?.name || 'model')}
                          />
                          {deployBranchId && (
                            <div className="mt-2 text-[11px] text-content-secondary break-all">
                              Branch model id: <span className="font-mono">{deployBranchId}</span>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={handleApplyToDevBranch}
	                            disabled={deployStatus === 'creating-branch' || deployStatus === 'saving' || deployStatus === 'validating' || deployFiles.length === 0}
                            className="btn-primary text-sm w-full mt-3 disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            {deployStatus === 'creating-branch' || deployStatus === 'saving' || deployStatus === 'validating'
                              ? <Loader2 size={15} className="animate-spin" />
                              : <ShieldCheck size={15} />}
                            Apply To Dev Branch
                          </button>
                        </div>

                        <div className="rounded-card border border-border bg-white p-3">
                          <div className="text-sm font-semibold text-content-primary">Status</div>
                          <div className="mt-2 text-xs text-content-secondary">Current state: <span className="font-semibold text-content-primary">{deployStatus}</span></div>
                          {(deployMainYaml || deployDevYaml) && (
                            <div className="mt-2 text-[11px] text-content-secondary">
                              Main files loaded: {Object.keys(deployMainYaml?.files || {}).length} · Dev files loaded: {Object.keys(deployDevYaml?.files || {}).length}
                            </div>
                          )}
                          {deployError && (
                            <div className="mt-3 rounded-button border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                              {deployError}
                            </div>
                          )}
	                        </div>

                        {deployInFlight && (
                          <WorkflowStatusScene
                            variant="branch-deploy"
                            title={deployStatusLabel}
	                            detail="Moving generated semantic YAML through branch save, validation, diff review, and Omni handoff."
                            statusLabel={deployStatus}
                            compact
                          />
                        )}

                      </div>
                    </div>

                    {(deployValidation || deployContentValidation) && (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                        <div className="rounded-card border border-border bg-white overflow-hidden">
                          <div className="px-3 py-2 bg-surface-secondary border-b border-border">
                            <div className="text-xs font-semibold text-content-primary">Model Validation</div>
                            <div className="text-[11px] text-content-secondary">{deployValidationErrors.length} errors, {deployValidationWarnings.length} warnings</div>
                          </div>
                          <div className="p-3 max-h-[240px] overflow-y-auto text-xs text-content-secondary space-y-2">
                            {deployValidation && deployValidation.length > 0 ? deployValidation.map((issue, index) => (
                              <div key={`${issue.message}-${index}`} className={`rounded-button border px-3 py-2 ${issue.is_warning ? 'border-amber-100 bg-amber-50 text-amber-800' : 'border-red-100 bg-red-50 text-red-700'}`}>
                                <div className="font-semibold">{issue.is_warning ? 'Warning' : 'Error'} {issue.yaml_path ? `- ${issue.yaml_path}` : ''}</div>
                                <div>{issue.message || 'No message returned.'}</div>
                              </div>
                            )) : (
                              <div className="rounded-button border border-green-100 bg-green-50 px-3 py-2 text-green-800">No model validation issues returned.</div>
                            )}
                          </div>
                        </div>

                        <div className="rounded-card border border-border bg-white overflow-hidden">
                          <div className="px-3 py-2 bg-surface-secondary border-b border-border">
                            <div className="text-xs font-semibold text-content-primary">Content Validation</div>
                            <div className="text-[11px] text-content-secondary">
                              {deployContentSummary
                                ? `${deployContentSummary.contentDocuments} documents checked · ${deployContentSummary.newIssueCount} new issues · ${deployContentSummary.documentsWithIssues} existing impacted items`
                                : 'Workbook/dashboard impact response from Omni.'}
                            </div>
                          </div>
                          <div className="p-3 max-h-[240px] overflow-y-auto text-xs text-content-secondary space-y-3">
                            {deployContentSummary?.errorMessage ? (
                              <div className="rounded-button border border-red-100 bg-red-50 px-3 py-2 text-red-700">
                                {deployContentSummary.errorMessage}
                              </div>
                            ) : deployContentSummary ? (
                              <>
                                <div className={`rounded-button border px-3 py-2 ${permissionPrerequisiteBlocked || deployContentSummary.newIssueCount ? 'border-red-100 bg-red-50 text-red-700' : 'border-green-100 bg-green-50 text-green-800'}`}>
                                  {permissionPrerequisiteBlocked
                                    ? `${permissionPrerequisiteIssueCount} unresolved permission prerequisite${permissionPrerequisiteIssueCount === 1 ? '' : 's'} found in validation. Resolve before Omni sign-off.`
                                    : deployContentSummary.newIssueCount
	                                    ? `${deployContentSummary.newIssueCount} new branch-only content issue${deployContentSummary.newIssueCount === 1 ? '' : 's'} found across ${deployContentSummary.newDocumentsWithIssues} workbook/dashboard item${deployContentSummary.newDocumentsWithIssues === 1 ? '' : 's'}. Review before Omni sign-off.`
                                    : deployContentSummary.documentsWithIssues
                                      ? `No new branch-only content issues. ${deployContentSummary.documentsWithIssues} workbook/dashboard item${deployContentSummary.documentsWithIssues === 1 ? '' : 's'} already had issues on main, so they are advisory only.`
                                      : 'No workbook/dashboard impact issues returned.'}
                                </div>
                                {permissionPrerequisiteBlocked && (
                                  <div className="space-y-1">
                                    <div className="text-[11px] font-semibold uppercase tracking-wider text-red-700">Permission prerequisites blocking sign-off</div>
                                    {permissionPrerequisiteIssues.map((issue) => (
                                      <div key={issue} className="rounded-button border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-700">
                                        {issue}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {deployContentSummary.sampleNewIssues.length > 0 && (
                                  <div className="space-y-1">
                                    <div className="text-[11px] font-semibold uppercase tracking-wider text-content-secondary">New branch-only issues</div>
                                    {deployContentSummary.sampleNewIssues.map((issue) => (
                                      <div key={issue} className="rounded-button border border-border bg-white px-3 py-2 text-[11px] text-content-secondary">
                                        {issue}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {deployContentSummary.sampleExistingIssues.length > 0 && (
                                  <details className="text-[11px]">
                                    <summary className="cursor-pointer text-content-secondary hover:text-content-primary">
                                      Show existing main-branch content issues that do not block this change
                                    </summary>
                                    <div className="mt-2 space-y-1">
                                      {deployContentSummary.sampleExistingIssues.map((issue) => (
                                        <div key={issue} className="rounded-button border border-border bg-white px-3 py-2 text-[11px] text-content-secondary">
                                          {issue}
                                        </div>
                                      ))}
                                    </div>
                                  </details>
                                )}
                                <details className="text-[11px]">
                                  <summary className="cursor-pointer text-content-secondary hover:text-content-primary">Show raw content validation response</summary>
                                  <pre className="mt-2 rounded-button bg-surface-secondary p-3 overflow-auto whitespace-pre-wrap">
                                    {deployContentValidation ? JSON.stringify(deployContentValidation, null, 2) : 'Not run yet.'}
                                  </pre>
                                </details>
                              </>
                            ) : (
                              <div className="rounded-button border border-border bg-surface-secondary px-3 py-2">Not run yet.</div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {deployDiffs.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                          <div>
                            <div className="text-sm font-semibold text-content-primary">Dev Branch Diff</div>
	                            <div className="text-xs text-content-secondary mt-0.5">Review exactly what was saved to the dev branch. Green lines are additions; red lines are deletions.</div>
                          </div>
                          <div className="flex flex-wrap gap-2 text-[11px]">
                            <span className="rounded-chip border border-green-200 bg-green-50 px-2 py-1 text-green-800">+ Added</span>
                            <span className="rounded-chip border border-red-200 bg-red-50 px-2 py-1 text-red-800">- Deleted</span>
                            <span className="rounded-chip border border-border bg-white px-2 py-1 text-content-secondary">Context</span>
                          </div>
                        </div>
                        {deployDiffs.map((diff) => (
                          <details key={diff.fileName} open className="rounded-card border border-border bg-white overflow-hidden">
                            <summary className="cursor-pointer px-3 py-2 bg-surface-secondary border-b border-border">
                              <span className="text-xs font-semibold text-content-primary">{diff.fileName}</span>
                              <span className="ml-2 rounded-chip border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] text-green-800">+{diff.added}</span>
                              <span className="ml-1 rounded-chip border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] text-red-800">-{diff.removed}</span>
                            </summary>
                            <DeployDiffViewer diff={diff} />
                          </details>
                        ))}
                      </div>
                    )}

                    {(deployValidation || deployContentValidation || deployDiffs.length > 0 || deployStatus === 'ready') && (
                      <div className="rounded-card border border-border bg-white overflow-hidden">
                        <div className="px-4 py-3 bg-surface-secondary border-b border-border flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <div className="text-sm font-semibold text-content-primary">Final Human Review</div>
                            <div className="text-xs text-content-secondary mt-0.5">
		                              Omni final sign-off is the last step after validation, impact checks, and diff review.
                            </div>
                          </div>
                          <ClipboardCheck size={18} className="text-omni-700 shrink-0" />
                        </div>
                        <div className="p-4 space-y-4">
                          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 text-sm items-stretch">
                            <div className={`rounded-card border p-3 h-full min-h-[92px] ${
                              deployValidationErrors.length === 0 && deployStatus === 'ready'
                                ? 'border-green-200 bg-green-50'
                                : 'border-border bg-white'
                            }`}>
                              <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Model YAML</div>
                              <div className={`mt-2 text-sm font-semibold ${
                                deployValidationErrors.length === 0 && deployStatus === 'ready' ? 'text-green-800' : 'text-content-primary'
                              }`}>
                                {deployValidationErrors.length === 0 && deployStatus === 'ready' ? 'Validation passed' : 'Waiting for validation'}
                              </div>
                              <div className="mt-1 text-xs text-content-secondary">
                                {deployValidation
                                  ? `${deployValidationErrors.length} error${deployValidationErrors.length === 1 ? '' : 's'} · ${deployValidationWarnings.length} warning${deployValidationWarnings.length === 1 ? '' : 's'}`
                                  : 'Run Apply To Dev Branch first.'}
                              </div>
                            </div>

                            <div className={`rounded-card border p-3 h-full min-h-[92px] ${
                              permissionPrerequisiteBlocked || deployContentFailed || deployContentHasIssues
                                ? 'border-red-200 bg-red-50'
                                : deployContentSummary
                                  ? 'border-green-200 bg-green-50'
                                  : 'border-border bg-white'
                            }`}>
                              <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Content Impact</div>
                              <div className={`mt-2 text-sm font-semibold ${
                                permissionPrerequisiteBlocked || deployContentFailed || deployContentHasIssues
                                  ? 'text-red-800'
                                  : deployContentSummary
                                    ? 'text-green-800'
                                    : 'text-content-primary'
                              }`}>
                                {permissionPrerequisiteBlocked
                                  ? 'Permission prerequisite missing'
                                  : deployContentFailed
                                  ? 'Validation failed'
                                  : deployContentHasIssues
                                    ? 'New issues need review'
                                    : deployContentHasExistingIssues
                                      ? 'No new blockers'
                                      : deployContentSummary
                                        ? 'No issues returned'
                                        : 'Not run yet'}
                              </div>
                              <div className="mt-1 text-xs text-content-secondary">
                                {permissionPrerequisiteBlocked
                                  ? `${permissionPrerequisiteIssueCount} unresolved grant or user-attribute issue${permissionPrerequisiteIssueCount === 1 ? '' : 's'} must be fixed before sign-off.`
                                  : deployContentSummary
                                  ? deployContentHasExistingIssues
                                    ? `${deployContentSummary.documentsWithIssues} existing main-branch item${deployContentSummary.documentsWithIssues === 1 ? '' : 's'} shown for awareness only.`
                                    : `${deployContentSummary.newIssueCount} new branch-only issue${deployContentSummary.newIssueCount === 1 ? '' : 's'}.`
                                  : 'Existing unrelated content issues will not block this topic change.'}
                              </div>
                            </div>

                            <div className={`rounded-card border p-3 h-full min-h-[92px] ${
                              deployDiffs.length > 0 ? 'border-green-200 bg-green-50' : 'border-border bg-white'
                            }`}>
                              <div className="text-xs font-semibold uppercase tracking-wider text-content-secondary">Code Diff</div>
                              <div className={`mt-2 text-sm font-semibold ${deployDiffs.length > 0 ? 'text-green-800' : 'text-content-primary'}`}>
                                {deployDiffs.length > 0 ? 'Ready for review' : 'Not ready'}
                              </div>
                              <div className="mt-1 text-xs text-content-secondary">
                                {deployDiffs.length > 0
	                                  ? `${deployDiffs.length} file${deployDiffs.length === 1 ? '' : 's'} changed. Review green additions and red deletions before Omni sign-off.`
                                  : 'A diff appears here after the dev branch is saved.'}
                              </div>
                            </div>
                          </div>

	                          {deployDiffs.length > 0 && (
                              permissionPrerequisiteBlocked ? (
                                <div className="rounded-button border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                                  <div className="font-semibold">Permission Builder sign-off is blocked</div>
                                  <div className="mt-1 leading-relaxed">
                                    Omni validation could not resolve one or more access grants or user attributes referenced by this package. Provision the missing permission prerequisite, rerun validation, then complete sign-off.
                                  </div>
                                </div>
                              ) : (
                                <label className={`flex items-start gap-2 rounded-button border px-3 py-2 text-xs ${
                                  deployContentHasIssues
                                    ? 'border-red-100 bg-red-50 text-red-700'
                                    : 'border-omni-100 bg-omni-50 text-omni-700'
                                }`}>
                                  <input
                                    type="checkbox"
                                    checked={deployReviewAcknowledged}
                                    onChange={(event) => setDeployReviewAcknowledged(event.target.checked)}
                                    className="mt-0.5 rounded border-omni-300 text-omni-700 focus:ring-omni-500"
                                  />
                                  <span>
                                    {deployContentHasIssues
                                      ? 'I reviewed the new branch-only content validation issues and the dev branch diff, and I am comfortable handing this off for Omni sign-off.'
                                      : 'I reviewed the dev branch diff and validation results, and I am ready to complete final sign-off in Omni.'}
                                  </span>
                                </label>
                              )
	                          )}

	                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-border pt-4">
	                            <div className="text-xs text-content-secondary leading-relaxed max-w-3xl">
		                              OmniKit stops after saving to a dev branch, validating, and showing the diff. Complete final approval and production promotion from Omni's model editor so the system of record owns sign-off.
	                              {deployBranchName && (
	                                <div className="mt-1 font-mono text-[11px] text-content-primary break-all">Dev branch: {deployBranchName}</div>
	                              )}
                              {deployFiles.length > 0 && (
                                <div className="mt-1 font-mono text-[11px] text-content-primary break-all">
                                  Review path: {selectedModel?.name || selectedModelId || 'Selected model'} -&gt; {deployBranchName || 'dev branch'} -&gt; {deployFiles.map((file) => file.fileName).join(', ')}
                                </div>
                              )}
	                            </div>
	                            {deployReadyForOmniReview ? (
	                              <a
	                                href={omniReviewUrl}
	                                target="_blank"
	                                rel="noreferrer"
	                                className="btn-primary text-sm w-full sm:w-auto sm:min-w-[260px] justify-center"
	                              >
	                                <ExternalLink size={15} />
	                                Open Omni For Sign-off
	                              </a>
	                            ) : (
	                              <button
	                                type="button"
	                                disabled
	                                className="btn-secondary text-sm w-full sm:w-auto sm:min-w-[260px] justify-center opacity-60 cursor-not-allowed"
	                              >
	                                <ClipboardCheck size={15} />
	                                {permissionPrerequisiteBlocked ? 'Resolve Permission Prerequisite' : 'Review Required First'}
	                              </button>
	                            )}
	                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {aiError && aiLastMode !== 'readiness-probe' && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded-card">{aiError}</div>
              )}

              {showAiResultPanelForStep && aiLastMode && (aiJob || aiJobResult) && (
                <div className="border border-border rounded-card bg-white overflow-hidden">
                  <div className="px-4 py-3 bg-surface-secondary border-b border-border flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-content-primary">
                        {aiLastMode === 'topic-plan'
                          ? 'Topic plan review'
                          : aiLastMode === 'context-review'
                            ? 'Semantic context review'
                            : aiLastMode === 'final-yaml'
                              ? 'Final YAML package'
                              : 'AI result'}
                      </div>
                      <div className="text-xs text-content-secondary mt-0.5">
                        {aiJob?.state || aiJob?.status ? `Job status: ${aiJob.state || aiJob.status}` : 'Generated by Omni AI'}
                      </div>
                    </div>
                    {aiConversationDisplay && (
                      <div className="text-[10px] text-content-tertiary font-mono truncate">{aiConversationDisplay}</div>
                    )}
                  </div>

                  <div className="p-4 space-y-4">
                    {aiLastMode === 'topic-plan' && aiMessage && (
                      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
                        <div className="rounded-card border border-border bg-white p-3">
                          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Existing Topic Used</div>
                          <div className="mt-2 text-sm font-semibold text-content-primary">{resultTopicDisplay || 'No existing topic returned'}</div>
                          {resultTopic && <div className="mt-0.5 font-mono text-[11px] text-content-tertiary">Topic name: {resultTopic}</div>}
                          <div className="mt-1 text-xs text-content-secondary">{recommendedPlanTarget}</div>
                        </div>
                        <div className="rounded-card border border-border bg-white p-3">
                          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Proposed Topic</div>
                          <div className="mt-2 text-sm font-semibold text-content-primary">{aiPlanSummary.topicName || '-'}</div>
                          <div className="mt-1 text-xs text-content-secondary">{aiPlanSummary.label || 'No label extracted'}</div>
                        </div>
                        <div className="rounded-card border border-border bg-white p-3">
                          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Base View</div>
                          <div className="mt-2 text-sm font-mono text-content-primary">{aiPlanSummary.baseView || '-'}</div>
                          <div className="mt-1 text-xs text-content-secondary">Confirm grain before approving changes.</div>
                        </div>
                      </div>
                    )}

                    {aiLastMode === 'topic-plan' && aiMessage && (
                      <div className="rounded-card border border-omni-100 bg-omni-50 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-omni-700">Next admin action</div>
                            <div className="mt-1 text-sm text-omni-700">
                              Treat this as the planning foundation. Decide whether this updates an existing topic or becomes a new focused topic, then review the draft YAML in Omni before applying anything.
                            </div>
                          </div>
                          <ClipboardCheck size={18} className="text-omni-700 flex-shrink-0" />
                        </div>
                        <div className="mt-3 grid grid-cols-1 xl:grid-cols-4 gap-2 text-xs text-omni-700">
	                          <div className="rounded-button border border-omni-100 bg-white px-3 py-2">1. Confirm grain and base view</div>
	                          <div className="rounded-button border border-omni-100 bg-white px-3 py-2">2. Choose new vs existing topic</div>
	                          <div className="rounded-button border border-omni-100 bg-white px-3 py-2">3. Review default filters</div>
	                          <div className="rounded-button border border-omni-100 bg-white px-3 py-2">4. Test after approval</div>
                        </div>
                      </div>
                    )}

                    {aiMessage && !aiHasCuratedOutput && (
                      <div className="rounded-card border border-border bg-white overflow-hidden">
                        <div className="px-3 py-2 border-b border-border bg-surface-secondary flex items-center justify-between gap-3">
                          <div className="text-xs font-semibold text-content-primary">Omni response</div>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              handleCopyResult('plan', aiMessage);
                            }}
                            className="btn-secondary text-xs px-2 py-1.5"
                          >
                            {copiedResult === 'plan' ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                            {copiedResult === 'plan' ? 'Copied' : 'Copy Plan'}
                          </button>
                        </div>
                        <div className="p-4 max-h-[560px] overflow-y-auto">
                          <MarkdownLite content={aiMessage} />
                        </div>
                      </div>
                    )}

                    {aiYamlDrafts.map((draft) => (
                      <YamlDraftCard
                        key={draft.id}
                        draft={draft}
                        copied={copiedResult === draft.id}
                        onCopy={() => handleCopyResult(draft.id, draft.content)}
                      />
                    ))}

                    <ReviewSections
                      sections={aiReviewSections}
                      copiedResult={copiedResult}
                      onCopy={handleCopyResult}
                    />

                    {copyError && (
                      <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded-card">
                        {copyError}
                      </div>
                    )}

                    {manualCopy && (
                      <ManualCopyFallback manualCopy={manualCopy} onClose={() => setManualCopy(null)} />
                    )}

                    {(aiLastMode === 'topic-plan' || aiLastMode === 'context-review' || aiLastMode === 'final-yaml') && (
                      <div className="space-y-2">
                        {focusNotice && (
                          <div className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-button px-3 py-2">
                            {focusNotice}
                          </div>
                        )}
                        <div className="text-xs text-content-tertiary">
                          Create/update remains approval-gated and is not performed from this review. Use the complete AI Studio review as the normal path.
                        </div>
                      </div>
                    )}

                    {Array.isArray(aiJobResult?.actions) && aiJobResult.actions.length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-content-secondary hover:text-content-primary">Show AI actions</summary>
                        <pre className="mt-2 bg-gray-900 text-green-400 text-[11px] p-3 rounded overflow-auto max-h-72 font-mono leading-relaxed">
                          {JSON.stringify(aiJobResult.actions, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <TopicFormModal
        open={showForm}
        modelId={selectedModelId}
        editMode={!!editTopic}
        initialName={editTopic?.name}
        initialData={editTopic?.data}
        onClose={() => { setShowForm(false); setEditTopic(null); }}
        onSave={handleRefresh}
      />

      <TopicDetailModal
        open={!!viewTopic}
        data={viewTopic}
        onClose={() => setViewTopic(null)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Topic"
        message={`Are you sure you want to delete topic "${deleteTarget}"? This cannot be undone.`}
        confirmLabel="Delete Topic"
        variant="danger"
        onConfirm={handleDeleteTopic}
        onCancel={() => setDeleteTarget(null)}
      />

      </>
      )}
    </div>
  );
}
