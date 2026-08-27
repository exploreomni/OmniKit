export type OmniApiContractStatus =
  | 'documented_current'
  | 'tenant_confirmed'
  | 'beta'
  | 'deprecated'
  | 'unverified'
  | 'retired';

export type OmniApiProbeMode = 'read_only' | 'controlled_write' | 'manual_only';
export type OmniApiProductionPolicy = 'allowed' | 'prohibited';

export interface OmniApiContract {
  id: string;
  path: string;
  methods: string[];
  status: OmniApiContractStatus;
  workflows: string[];
  docsUrl: string;
  probeMode: OmniApiProbeMode;
  productionPolicy?: OmniApiProductionPolicy;
  notes?: string;
}

const API_INDEX = 'https://docs.omni.co/api';

export const OMNI_API_CONTRACTS: OmniApiContract[] = [
  { id: 'content-export', path: '/api/unstable/documents/:param/export', methods: ['GET'], status: 'beta', workflows: ['dashboard_migrator'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'content-import', path: '/api/unstable/documents/import', methods: ['POST'], status: 'beta', workflows: ['dashboard_migrator'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'ai-jobs', path: '/api/v1/ai/jobs', methods: ['POST'], status: 'documented_current', workflows: ['semantic_studio', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/ai/create-ai-job', probeMode: 'controlled_write', notes: 'AI Content Studio uses this controlled-write workflow for visually grounded existing-dashboard review, dashboard creation, Apps (Beta), and narrative output. Review requests zero writes and supplies an approved dashboard render, but Omni documents no read-only action allowlist or guaranteed created-document ID. App creation through this asynchronous API remains an unverified attempt with an Omni Chat handoff; narrative output is not registered as a persistent Omni report artifact.' },
  { id: 'ai-job-status', path: '/api/v1/ai/jobs/:param', methods: ['GET'], status: 'documented_current', workflows: ['semantic_studio', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/ai/get-ai-job-status', probeMode: 'read_only' },
  { id: 'ai-job-cancel', path: '/api/v1/ai/jobs/:param/cancel', methods: ['POST'], status: 'documented_current', workflows: ['semantic_studio', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/ai/cancel-ai-job', probeMode: 'manual_only' },
  { id: 'ai-job-result', path: '/api/v1/ai/jobs/:param/result', methods: ['GET'], status: 'documented_current', workflows: ['semantic_studio', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/ai/stream-ai-job-results', probeMode: 'read_only' },
  { id: 'ai-pick-topic', path: '/api/v1/ai/pick-topic', methods: ['POST'], status: 'documented_current', workflows: ['semantic_studio'], docsUrl: 'https://docs.omni.co/api/ai/pick-topic', probeMode: 'controlled_write' },
  { id: 'ai-conversations-list', path: '/api/v1/ai/conversations', methods: ['GET'], status: 'documented_current', workflows: ['portfolio_overview'], docsUrl: 'https://docs.omni.co/api/ai/list-ai-conversations', probeMode: 'read_only', notes: 'Organization-wide totals require an Organization API key; OmniKit requests one row and retains only pageInfo.totalRecords.' },
  { id: 'ai-credit-controls-read', path: '/api/v1/ai/credit-controls', methods: ['GET'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: API_INDEX, probeMode: 'read_only', notes: 'Read-only aggregate credit-control evidence. Limit changes are a separate confirmation-gated operation and are not represented by this contract.' },
  { id: 'ai-credit-usage-users-read', path: '/api/v1/ai/credit-usage/users', methods: ['POST'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: API_INDEX, probeMode: 'read_only', notes: 'POST supplies the bounded user-usage query body but does not mutate tenant state.' },
  { id: 'ai-credit-usage-entity-groups-read', path: '/api/v1/ai/credit-usage/entity-groups', methods: ['POST'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: API_INDEX, probeMode: 'read_only', notes: 'POST supplies the bounded entity-group usage query body but does not mutate tenant state.' },
  { id: 'ai-eval-prompt-sets-list', path: '/api/v1/ai/eval/prompt-sets', methods: ['GET'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/list-eval-prompt-sets', probeMode: 'read_only', notes: 'Returns active prompt-set summaries for shared models the caller can access; OmniKit retains aggregate counts only.' },
  { id: 'ai-eval-prompt-set-get', path: '/api/v1/ai/eval/prompt-sets/:param', methods: ['GET'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/get-an-eval-prompt-set', probeMode: 'read_only', notes: 'The resource response includes prompt text and expectations, so the fleet evidence path does not call or expose it.' },
  { id: 'ai-eval-runs-list', path: '/api/v1/ai/eval/runs', methods: ['GET'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/list-eval-runs', probeMode: 'read_only', notes: 'Requires prompt_set_id. OmniKit reads at most one prompt set\'s newest-first run collection per instance.' },
  { id: 'ai-eval-run-get', path: '/api/v1/ai/eval/runs/:param', methods: ['GET'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/get-an-eval-run', probeMode: 'read_only', notes: 'The resource response includes per-prompt rows. OmniKit retains only a sanitized aggregate summary for at most one run per instance.' },
  { id: 'ai-eval-prompt-set-create', path: '/api/v1/ai/eval/prompt-sets', methods: ['POST'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/create-an-eval-prompt-set', probeMode: 'manual_only' },
  { id: 'ai-eval-prompt-set-update', path: '/api/v1/ai/eval/prompt-sets/:param', methods: ['PATCH'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/update-an-eval-prompt-set', probeMode: 'manual_only', notes: 'Supplying prompts replaces the full prompt list, so this write is never an automatic governance action.' },
  { id: 'ai-eval-prompt-set-archive', path: '/api/v1/ai/eval/prompt-sets/:param', methods: ['DELETE'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/archive-an-eval-prompt-set', probeMode: 'manual_only' },
  { id: 'ai-eval-prompt-set-restore', path: '/api/v1/ai/eval/prompt-sets/:param/unarchive', methods: ['POST'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/restore-an-archived-eval-prompt-set', probeMode: 'manual_only' },
  { id: 'ai-eval-run-start', path: '/api/v1/ai/eval/runs', methods: ['POST'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/start-an-eval-run', probeMode: 'manual_only', notes: 'Starts one agentic job per prompt and is excluded from point-in-time governance evidence.' },
  { id: 'ai-eval-run-cancel', path: '/api/v1/ai/eval/runs/:param/cancel', methods: ['POST'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/cancel-an-eval-run', probeMode: 'manual_only' },
  { id: 'ai-eval-run-restore', path: '/api/v1/ai/eval/runs/:param/unarchive', methods: ['POST'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/restore-an-archived-eval-run', probeMode: 'manual_only' },
  { id: 'ai-eval-run-archive', path: '/api/v1/ai/eval/runs/:param', methods: ['DELETE'], status: 'documented_current', workflows: ['ai_governance'], docsUrl: 'https://docs.omni.co/api/ai-eval/archive-an-eval-run', probeMode: 'manual_only' },
  { id: 'whoami', path: '/api/v1/whoami', methods: ['GET'], status: 'documented_current', workflows: ['instance_connection'], docsUrl: 'https://docs.omni.co/api/who-am-i/get-current-identity-and-permissions', probeMode: 'read_only', notes: 'Saved-instance verification uses this permission-neutral identity probe instead of requiring folder-list access.' },
  { id: 'api-keys-list', path: '/api/v1/api-keys', methods: ['GET'], status: 'documented_current', workflows: ['admin_readiness'], docsUrl: 'https://docs.omni.co/api/api-tokens/list-api-tokens', probeMode: 'read_only', notes: 'Admin readiness retains aggregate counts only; token ids, names, membership ids, and other token metadata are excluded.' },
  { id: 'connections', path: '/api/v1/connections', methods: ['GET'], status: 'documented_current', workflows: ['connection_health', 'dashboard_migrator', 'model_migrator'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'connection-dbt', path: '/api/v1/connections/:param/dbt', methods: ['GET'], status: 'documented_current', workflows: ['connection_health'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'connection-dbt-environments', path: '/api/v1/connections/:param/dbt/environments', methods: ['GET'], status: 'documented_current', workflows: ['connection_health', 'model_migrator'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'connection-schedules', path: '/api/v1/connections/:param/schedules', methods: ['GET'], status: 'documented_current', workflows: ['connection_health'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'dashboard-download-start', path: '/api/v1/dashboards/:param/download', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_downloads', 'deck_builder', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/dashboard-downloads/initiate-download', probeMode: 'controlled_write' },
  { id: 'dashboard-download-file', path: '/api/v1/dashboards/:param/download/:param', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_downloads', 'deck_builder', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/dashboard-downloads/download-file', probeMode: 'read_only' },
  { id: 'dashboard-download-status', path: '/api/v1/dashboards/:param/download/:param/status', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_downloads', 'deck_builder', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/dashboard-downloads/check-download-status', probeMode: 'read_only' },
  { id: 'dashboard-filters', path: '/api/v1/dashboards/:param/filters', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_downloads', 'deck_builder', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/dashboard-filters/get-dashboard-filters-and-controls', probeMode: 'read_only' },
  { id: 'documents-list', path: '/api/v1/documents', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations', 'deck_builder', 'portfolio_overview'], docsUrl: 'https://docs.omni.co/api/documents/list-documents', probeMode: 'read_only' },
  { id: 'document-create-v1', path: '/api/v1/documents', methods: ['POST'], status: 'deprecated', workflows: ['retired_contract'], docsUrl: 'https://docs.omni.co/api/versioning', probeMode: 'manual_only', notes: 'Use POST /api/v2/documents.' },
  { id: 'document-get-v1', path: '/api/v1/documents/:param', methods: ['GET'], status: 'deprecated', workflows: ['retired_contract'], docsUrl: 'https://docs.omni.co/api/versioning', probeMode: 'manual_only', notes: 'Use GET /api/v2/documents/:documentId.' },
  { id: 'document-update-v1', path: '/api/v1/documents/:param', methods: ['PUT', 'PATCH'], status: 'retired', workflows: ['retired_contract'], docsUrl: 'https://docs.omni.co/api/versioning', probeMode: 'manual_only', notes: 'Removed July 31, 2026; use a Documents V2 draft and publish workflow.' },
  { id: 'document-draft-create-v1', path: '/api/v1/documents/:param/draft', methods: ['POST'], status: 'deprecated', workflows: ['retired_contract'], docsUrl: 'https://docs.omni.co/api/versioning', probeMode: 'manual_only', notes: 'Use PATCH /api/v2/documents/:documentId/draft.' },
  { id: 'document-delete', path: '/api/v1/documents/:param', methods: ['DELETE'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/documents/delete-document', probeMode: 'controlled_write', notes: 'Moves the document to recoverable Trash; AI Content Studio requires an authoritative reread and exact user confirmation first.' },
  { id: 'document-access-list', path: '/api/v1/documents/:param/access-list', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/document-permissions/list-all-users-and-groups-with-document-access', probeMode: 'read_only' },
  { id: 'document-labels-bulk', path: '/api/v1/documents/:param/labels', methods: ['PATCH'], status: 'documented_current', workflows: ['dashboard_migrator', 'label_manager'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'document-label', path: '/api/v1/documents/:param/labels/:param', methods: ['PUT', 'DELETE'], status: 'documented_current', workflows: ['label_manager'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'document-move', path: '/api/v1/documents/:param/move', methods: ['PUT'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'document-permissions', path: '/api/v1/documents/:param/permissions', methods: ['POST', 'PATCH'], status: 'documented_current', workflows: ['dashboard_migrator'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'document-queries', path: '/api/v1/documents/:param/queries', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'deck_builder', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/documents/get-document-queries', probeMode: 'read_only' },
  { id: 'folders', path: '/api/v1/folders', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations', 'label_manager'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'job-status', path: '/api/v1/jobs/:param/status', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'labels-list', path: '/api/v1/labels', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'label_manager'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'labels-create', path: '/api/v1/labels', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'label_manager'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'models-list', path: '/api/v1/models', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'models-create', path: '/api/v1/models', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'model-branch', path: '/api/v1/models/:param/branch/:param', methods: ['DELETE'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'model-branch-merge', path: '/api/v1/models/:param/branch/:param/merge', methods: ['POST'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'manual_only' },
  { id: 'model-branch-dbt-write', path: '/api/v1/models/:param/branch/:param/dbt', methods: ['POST'], status: 'documented_current', workflows: ['model_migrator'], docsUrl: API_INDEX, probeMode: 'manual_only', notes: 'Writes dbt state to a model branch and requires explicit operator confirmation; it is never an automatic discovery probe.' },
  { id: 'content-validator-read', path: '/api/v1/models/:param/content-validator', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator', 'semantic_studio', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/content-validator/validate-content', probeMode: 'read_only' },
  { id: 'content-validator-find-replace', path: '/api/v1/models/:param/content-validator', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'manual_only', notes: 'POST performs a find-and-replace content mutation. Validation uses the GET operation and this write must never be used as a read-only readiness probe.' },
  { id: 'model-git', path: '/api/v1/models/:param/git', methods: ['GET'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'model-git-commit', path: '/api/v1/models/:param/git/commit', methods: ['POST'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'manual_only' },
  { id: 'model-migrate', path: '/api/v1/models/:param/migrate', methods: ['POST'], status: 'documented_current', workflows: ['model_migrator'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'model-refresh', path: '/api/v1/models/:param/refresh', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'model-schemas', path: '/api/v1/models/:param/schemas', methods: ['GET'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'topic-list', path: '/api/v1/models/:param/topic', methods: ['GET'], status: 'documented_current', workflows: ['portfolio_overview'], docsUrl: 'https://docs.omni.co/developers/cli/commands', probeMode: 'read_only' },
  { id: 'topic-create-direct', path: '/api/v1/models/:param/topic', methods: ['POST'], status: 'unverified', workflows: ['retired_contract'], docsUrl: API_INDEX, probeMode: 'manual_only', productionPolicy: 'prohibited', notes: 'Not documented for production use. OmniKit stages topic creation through reviewed model YAML branches.' },
  { id: 'topic-detail', path: '/api/v1/models/:param/topic/:param', methods: ['GET'], status: 'documented_current', workflows: ['semantic_studio'], docsUrl: 'https://docs.omni.co/api/topics/retrieve-a-topic', probeMode: 'read_only' },
  { id: 'topic-update-delete-direct', path: '/api/v1/models/:param/topic/:param', methods: ['PATCH', 'DELETE'], status: 'unverified', workflows: ['retired_contract'], docsUrl: API_INDEX, probeMode: 'manual_only', productionPolicy: 'prohibited', notes: 'Not documented for production use. OmniKit stages topic updates and removals through reviewed model YAML branches.' },
  { id: 'model-validate', path: '/api/v1/models/:param/validate', methods: ['GET'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'model-view-delete', path: '/api/v1/models/:param/view/:param', methods: ['DELETE'], status: 'documented_current', workflows: ['model_migrator', 'semantic_studio'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'model-yaml-read', path: '/api/v1/models/:param/yaml', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator', 'semantic_studio'], docsUrl: 'https://docs.omni.co/api/models/get-model-yaml', probeMode: 'read_only' },
  { id: 'model-yaml-write', path: '/api/v1/models/:param/yaml', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator', 'semantic_studio'], docsUrl: 'https://docs.omni.co/api/models/create-or-update-yaml-files', probeMode: 'controlled_write' },
  { id: 'model-yaml-delete', path: '/api/v1/models/:param/yaml', methods: ['DELETE'], status: 'documented_current', workflows: ['dashboard_migrator', 'model_migrator', 'semantic_studio'], docsUrl: 'https://docs.omni.co/api/models/delete-a-yaml-file', probeMode: 'controlled_write' },
  { id: 'query-run', path: '/api/v1/query/run', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'deck_builder', 'semantic_studio'], docsUrl: 'https://docs.omni.co/guides/api/run-document-queries', probeMode: 'controlled_write' },
  { id: 'query-wait', path: '/api/v1/query/wait', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'schedules-list', path: '/api/v1/schedules', methods: ['GET'], status: 'documented_current', workflows: ['schedules', 'admin_readiness'], docsUrl: 'https://docs.omni.co/api/schedules/list-schedules', probeMode: 'read_only' },
  { id: 'schedules-create', path: '/api/v1/schedules', methods: ['POST'], status: 'documented_current', workflows: ['schedules'], docsUrl: 'https://docs.omni.co/api/schedules/create-schedule', probeMode: 'controlled_write' },
  { id: 'schedule-get', path: '/api/v1/schedules/:param', methods: ['GET'], status: 'documented_current', workflows: ['schedules'], docsUrl: 'https://docs.omni.co/api/schedules/get-schedule', probeMode: 'read_only' },
  { id: 'schedule-update-delete', path: '/api/v1/schedules/:param', methods: ['PUT', 'DELETE'], status: 'documented_current', workflows: ['schedules'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'schedule-pause', path: '/api/v1/schedules/:param/pause', methods: ['PUT'], status: 'documented_current', workflows: ['schedules'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'schedule-resume', path: '/api/v1/schedules/:param/resume', methods: ['PUT'], status: 'documented_current', workflows: ['schedules'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'schedule-trigger', path: '/api/v1/schedules/:param/trigger', methods: ['POST'], status: 'documented_current', workflows: ['schedules'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'schedule-recipients', path: '/api/v1/schedules/:param/recipients', methods: ['GET'], status: 'documented_current', workflows: ['schedules', 'admin_readiness'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'uploads', path: '/api/v1/uploads', methods: ['GET'], status: 'documented_current', workflows: ['upload_governance'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'user-attributes', path: '/api/v1/user-attributes', methods: ['GET'], status: 'documented_current', workflows: ['user_management'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'user-group-model-roles-read', path: '/api/v1/user-groups/:param/model-roles', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'user_management', 'admin_readiness'], docsUrl: 'https://docs.omni.co/api/user-group-model-roles/retrieve-user-group-model-roles', probeMode: 'read_only' },
  { id: 'user-group-model-roles-write', path: '/api/v1/user-groups/:param/model-roles', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'user_management'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'user-model-roles-read', path: '/api/v1/users/:param/model-roles', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'user_management', 'admin_readiness'], docsUrl: 'https://docs.omni.co/api/user-model-roles/retrieve-user-model-roles', probeMode: 'read_only' },
  { id: 'user-model-roles-write', path: '/api/v1/users/:param/model-roles', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'user_management'], docsUrl: API_INDEX, probeMode: 'controlled_write' },
  { id: 'documents-v2-create', path: '/api/v2/documents', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'deck_builder'], docsUrl: 'https://docs.omni.co/api/documents-v2/create-document', probeMode: 'controlled_write' },
  { id: 'documents-v2-state', path: '/api/v2/documents/:param', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'deck_builder', 'ai_content_studio'], docsUrl: 'https://docs.omni.co/api/documents-v2/get-document-state', probeMode: 'read_only', notes: 'AI Content Studio uses this only as one postcondition in a dashboard verification chain; App type is not inferred from this response.' },
  { id: 'documents-v2-draft-create', path: '/api/v2/documents/:param/draft', methods: ['PATCH'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations'], docsUrl: 'https://docs.omni.co/api/documents-v2/create-draft-and-patch-document', probeMode: 'controlled_write' },
  { id: 'documents-v2-draft-state-read', path: '/api/v2/documents/:param/draft/:param', methods: ['GET'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations'], docsUrl: 'https://docs.omni.co/api/documents-v2/get-draft-state', probeMode: 'read_only' },
  { id: 'documents-v2-draft-state-write', path: '/api/v2/documents/:param/draft/:param', methods: ['PATCH'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations'], docsUrl: 'https://docs.omni.co/api/documents-v2/patch-draft', probeMode: 'controlled_write' },
  { id: 'documents-v2-draft-publish', path: '/api/v2/documents/:param/draft/publish', methods: ['POST'], status: 'documented_current', workflows: ['dashboard_migrator', 'dashboard_operations'], docsUrl: 'https://docs.omni.co/api/documents-v2/publish-draft', probeMode: 'controlled_write' },
  { id: 'scim-embed-users', path: '/api/scim/v2/embed/users', methods: ['GET'], status: 'documented_current', workflows: ['user_management'], docsUrl: API_INDEX, probeMode: 'read_only' },
  { id: 'scim-groups-list', path: '/api/scim/v2/groups', methods: ['GET'], status: 'documented_current', workflows: ['user_management', 'admin_readiness'], docsUrl: 'https://docs.omni.co/api/user-groups/list-user-groups', probeMode: 'read_only' },
  { id: 'scim-groups-create', path: '/api/scim/v2/groups', methods: ['POST'], status: 'documented_current', workflows: ['user_management'], docsUrl: 'https://docs.omni.co/api/user-groups/create-user-group', probeMode: 'controlled_write' },
  { id: 'scim-group-read', path: '/api/scim/v2/groups/:param', methods: ['GET'], status: 'documented_current', workflows: ['user_management'], docsUrl: 'https://docs.omni.co/api/user-groups/retrieve-user-group', probeMode: 'read_only' },
  { id: 'scim-group-write', path: '/api/scim/v2/groups/:param', methods: ['PUT', 'PATCH'], status: 'documented_current', workflows: ['user_management'], docsUrl: 'https://docs.omni.co/api/user-groups/update-user-group', probeMode: 'controlled_write' },
  { id: 'scim-users-list', path: '/api/scim/v2/users', methods: ['GET'], status: 'documented_current', workflows: ['user_management', 'admin_readiness'], docsUrl: 'https://docs.omni.co/api/users/list-users', probeMode: 'read_only' },
  { id: 'scim-users-create', path: '/api/scim/v2/users', methods: ['POST'], status: 'documented_current', workflows: ['user_management'], docsUrl: 'https://docs.omni.co/api/users/create-user', probeMode: 'controlled_write' },
  { id: 'scim-user', path: '/api/scim/v2/users/:param', methods: ['PUT', 'DELETE'], status: 'documented_current', workflows: ['user_management'], docsUrl: 'https://docs.omni.co/api/users/replace-user', probeMode: 'controlled_write' },
];

function patternRegex(pattern: string): RegExp {
  const escaped = pattern
    .split(':param')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escaped}$`);
}

export function findOmniApiContract(method: string, path: string): OmniApiContract | undefined {
  const upperMethod = method.toUpperCase();
  return OMNI_API_CONTRACTS.find((contract) => (
    contract.methods.includes(upperMethod) && patternRegex(contract.path).test(path)
  ));
}

export type OmniApiFailureClass = 'transient' | 'authentication' | 'contract' | 'request' | 'unknown';

export function classifyOmniApiFailure(status: number): OmniApiFailureClass {
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404 || status === 405 || status === 410) return 'contract';
  if (status >= 400 && status < 500) return 'request';
  return 'unknown';
}
