export const WALKTHROUGH_VERSION = '2026-06-18-dashboard-migration-user-health';
export const WALKTHROUGH_DISPLAY_VERSION = 'Updated June 18, 2026';
export const WALKTHROUGH_STORAGE_KEY = 'omnikit:walkthrough:v1';

export type WalkthroughStepId =
  | 'start'
  | 'connect'
  | 'workflow-map'
  | 'instance-manager'
  | 'dashboard-ai'
  | 'dashboard-builder'
  | 'excel-dashboard'
  | 'dashboard-migrator'
  | 'model-migrator'
  | 'dashboard-operations'
  | 'downloads-decks'
  | 'readiness'
  | 'semantic-studio'
  | 'governance'
  | 'privacy'
  | 'review-rhythm';

export interface WalkthroughStep {
  id: WalkthroughStepId;
  route: string;
  label: string;
  title: string;
  purpose: string;
  directions: string[];
  outcome: string;
  caution?: string;
}

export interface WalkthroughStorageState {
  version: string;
  dismissedAt?: string;
  completedAt?: string;
  lastOpenedAt?: string;
  openCount?: number;
}

export const walkthroughSteps: WalkthroughStep[] = [
  {
    id: 'start',
    route: '/',
    label: 'Overview',
    title: 'Start with the big picture',
    purpose: 'OmniKit is a local workspace for Omni admins. It starts from a native encrypted vault, then helps you review content, make safer bulk changes, and prepare AI-assisted semantic work without leaving a controlled local tool.',
    directions: [
      'Use Home to unlock or create the local vault and choose the saved Omni instance for your session.',
      'Use the sidebar like a checklist, moving from the selected saved instance into the area that matches your task.',
      'Look for selected-state badges and progress panels to confirm what OmniKit will act on.',
      'When a workflow writes changes, expect a review step before anything is applied.',
    ],
    outcome: 'You know where work starts, where review happens, and where final approval stays in Omni.',
  },
  {
    id: 'connect',
    route: '/',
    label: 'Vault',
    title: 'Choose a saved Omni instance',
    purpose: 'Home is the front door. A non-technical user unlocks the local vault, chooses a saved Omni instance, and avoids re-entering credentials for every workflow.',
    directions: [
      'Create or unlock the native vault on Home.',
      'Add a saved instance if the vault is empty, using the Omni base URL and API key from the admin team.',
      'Choose the saved instance you want to use; the browser receives only a non-secret vault reference.',
      'After success, use the recommended next actions or the sidebar.',
    ],
    outcome: 'OmniKit can read the Omni content and model metadata needed by the rest of the app.',
    caution: 'Plaintext saved-instance API keys stay encrypted in the native vault and are not returned to the browser.',
  },
  {
    id: 'workflow-map',
    route: '/dashboards/operations',
    label: 'Workflow Map',
    title: 'Choose the workflow by the job you need done',
    purpose: 'Each page is built around one admin job. Users do not need to understand the underlying APIs before starting.',
    directions: [
      'Dashboard AI & Delivery is for dashboard reviews, migration, downloads, deck creation, and bulk dashboard operations.',
      'Data & AI Readiness is for Instance Manager, connection health, model health, content health, uploads, and AI Semantic Studio.',
      'Governance is for labels, schedules, users, groups, and embeds.',
    ],
    outcome: 'The user can pick the right page without guessing which technical object matters first.',
  },
  {
    id: 'instance-manager',
    route: '/instances',
    label: 'Instances',
    title: 'Set up saved Omni instances once',
    purpose: 'Instance Manager is the new multi-instance operations home. It uses a native encrypted local vault so technical admins can save source and destination Omni profiles without re-entering API keys for every migration.',
    directions: [
      'Unlock or create the native vault, then add source, destination, or source + destination instance profiles.',
      'If you are moving from omni-multi-instance-tools, use Import legacy multi-instance vault, run the dry run first, import valid profiles, then test each imported instance.',
      'Save default model IDs, folder IDs or folder paths, and tag-based metric filters.',
      'Use the Connections tab to scan saved instances, filter internal/test records, find schema model coverage issues, and queue schema refresh jobs from the local vault.',
      'Use the Embed Users tab to review active 7/30/90-day counts, never-logged-in users, signup/login trends, and entity rollups.',
    ],
    outcome: 'Admins can manage reusable multi-instance credentials and metrics while keeping secrets encrypted locally.',
    caution: 'Native vault secrets are not included in browser backups. Resetting the native vault removes saved instance profiles and local migration job history.',
  },
  {
    id: 'dashboard-ai',
    route: '/dashboards/ai-studio',
    label: 'Dashboard AI',
    title: 'Use AI Dashboard Studio for dashboard review and build handoff',
    purpose: 'AI Dashboard Studio is the dashboard-facing workspace. It has three lanes: build a new dashboard, convert Excel workbook evidence into a guarded dashboard draft, or review an existing dashboard.',
    directions: [
      'Use Build New Dashboard when you have a new dashboard request and want Omni chat to create a first-pass draft from selected model/topic context.',
      'Use Excel to Dashboard when a workbook contains formulas, summary tables, or charts that should inform a dashboard draft and identify follow-up model work.',
      'Use Review Existing Dashboard when you already have an Omni dashboard and need a quality, usability, or semantic-risk review.',
    ],
    outcome: 'Users can choose the right dashboard lane without needing to know API details or semantic YAML syntax.',
    caution: 'Dashboard Studio starts dashboard work and handoff conversations. Any model changes still route to AI Semantic Studio.',
  },
  {
    id: 'dashboard-builder',
    route: '/dashboards/ai-studio',
    label: 'Build',
    title: 'Build a new dashboard, then finish in Omni chat',
    purpose: 'Build New Dashboard turns a plain-English dashboard request into a first-pass Omni dashboard draft or a dashboard build brief, using only the selected model and topic context.',
    directions: [
      'Select the Omni model and optional topic first so Blobby has the right field universe.',
      'Describe the audience, business goal, KPIs, filters, layout, and color or brand style in normal language.',
      'Review the returned dashboard as a draft: confirm tile errors, chart types, color use, and blocked semantic gaps before sharing it.',
    ],
    outcome: 'The user leaves OmniKit with an Omni chat and first-pass dashboard path that is ready for human review and iteration.',
    caution: 'Ratio metrics such as AOV should be blocked unless the model already has a confirmed order-level ratio. Blobby should route missing measures to AI Semantic Studio.',
  },
  {
    id: 'excel-dashboard',
    route: '/dashboards/ai-studio',
    label: 'Excel',
    title: 'Convert Excel into a dashboard draft and next-step list',
    purpose: 'Excel to Dashboard parses an .xlsx workbook in page memory, summarizes sheets, formulas, and charts, then asks Blobby to draft safe dashboard tiles from existing fields while listing any needed model changes as follow-ups.',
    directions: [
      'Upload the workbook and review the inventory: sheets, formulas, likely measure candidates, and chart evidence.',
      'Run Convert Formulas & Visuals first. Formula candidates that need new modeled measures become follow-up tasks, not automatic topic or view updates.',
      'Use Start Guarded Draft Chat only for safe tiles that map to existing Omni fields. Blocked formulas, lookup tabs, and unvalidated ratios stay out of the draft until AI Semantic Studio work is complete.',
    ],
    outcome: 'A workbook becomes a clear dashboard handoff: what can be drafted now, what model work comes next, and what questions the owner must answer.',
    caution: 'Raw workbook contents are not stored by default. Missing lookup tabs, manually entered summaries, and hardcoded thresholds require human validation.',
  },
  {
    id: 'dashboard-migrator',
    route: '/dashboards/migrate',
    label: 'Migrate',
    title: 'Use Dashboard Migrator for reviewed copy/import jobs',
    purpose: 'Dashboard Migrator copies selected dashboards from a source instance and connection into one or more destinations, each with its own instance, connection, model, folder, and topic choices. Model Migrator is reserved for the semantic-layer tool.',
    directions: [
      'Unlock the native vault, then choose the source instance and connection to load dashboards across that connection.',
      'Select dashboards after confirming their current folder, model, and topic metadata, then add every destination needed for the migration.',
      'Map detected source topics to existing target topics or create a new target topic before import when the target model is compatible.',
      'Keep same-name replacement on for clean reruns, optionally empty target folders, and choose whether to queue native schema refresh per destination.',
      'Choose whether to move the source dashboard to Trash after verified success.',
      'Run the readiness check before starting. During the job, use the live board to watch export, topic preparation, import, metadata, schema refresh, and source-delete status.',
    ],
    outcome: 'Dashboard migration work becomes a reviewed, retryable copy/import job with clear warnings for missing fields, topic dependencies, folder placement, target replacement, metadata preservation, schema refresh, and source cleanup.',
    caution: 'The readiness check reviews field presence and job shape, not business-definition equivalence. Source cleanup should be enabled only when the imported dashboard has been verified enough for the operational handoff.',
  },
  {
    id: 'model-migrator',
    route: '/models/migrate',
    label: 'Model Migrator',
    title: 'Stage semantic model migration from saved instances',
    purpose: 'Model Migrator is the semantic-layer workflow. It starts with saved source and target Omni profiles, then inventories source models and dependent dashboards or workbook-only content before creating branch-only migration jobs.',
    directions: [
      'Unlock the native vault and choose a saved source instance.',
      'Choose the source connection and one or more shared models to migrate.',
      'Choose the target instance and connection, then map each source model to its intended target model.',
      'Review translated YAML, workbook preflight, and selected content before starting the unified migration job.',
    ],
    outcome: 'Admins can pick once, understand model/content scope, write accepted YAML to target branches, port workbook queries, and keep dashboard selections visible as handoff items in the same run.',
    caution: 'Main branches are never written. Validate and merge only from target dev branches, and disclose unsupported schedules, sharing, alerts, and permission artifacts in results.',
  },
  {
    id: 'dashboard-operations',
    route: '/dashboards/operations',
    label: 'Dashboards',
    title: 'Move, copy, or delete dashboards with confirmation',
    purpose: 'Dashboard workflows are designed for careful content operations with visible selections and final confirmation.',
    directions: [
      'Choose move, copy, or delete based on the operation you need.',
      'Select the dashboards and destination folder, then review the selected-state badges.',
      'Use the confirmation step and History log to keep an audit trail.',
    ],
    outcome: 'Dashboard work is handled as a reviewed operation instead of a blind one-click change.',
    caution: 'Delete workflows use extra confirmation. Keep that friction; it protects production content.',
  },
  {
    id: 'downloads-decks',
    route: '/deck-builder',
    label: 'Exports',
    title: 'Download dashboards or turn tiles into presentation decks',
    purpose: 'OmniKit supports both direct dashboard exports and repeatable PowerPoint deck generation from live Omni tiles.',
    directions: [
      'Use Dashboard Downloads when you need local dashboard export files.',
      'Use Deck Builder to select dashboard tiles, filters, templates, and layout options.',
      'Review the deck package before sharing it with stakeholders.',
    ],
    outcome: 'Users can move from live dashboard content to reusable files or presentation-ready material.',
  },
  {
    id: 'readiness',
    route: '/content-health',
    label: 'Readiness',
    title: 'Check connection, upload, model, and content health',
    purpose: 'The readiness pages help admins understand whether the Omni environment is healthy before they ask Blobby or bulk workflows to act on it.',
    directions: [
      'Use Instance Manager for multi-instance totals, filtered internal/test counts, schema refresh actions, embed-user activity charts, entity rollups, and saved instance configuration.',
      'Use Connection Health to inspect the active Omni connection in detail.',
      'Use Upload Governance, Model & Topic Health, and Content Health to identify stale content or semantic gaps.',
      'Treat these scans as triage: they tell you where to repair, not just what is broken.',
    ],
    outcome: 'Admins can diagnose the environment before making operational or semantic changes.',
  },
  {
    id: 'semantic-studio',
    route: '/topics',
    label: 'AI Semantic',
    title: 'Use AI Semantic Studio for governed semantic changes',
    purpose: 'AI Semantic Studio helps admins create reviewable Omni YAML packages while keeping Topic Builder, Model / View Builder, Permission Builder, and Semantic Migration Import separate.',
    directions: [
      'Use Guided Builders when you already know the Omni semantic target.',
      'Use Semantic Migration Import to convert dbt, Looker, Power BI, Tableau, or Domo semantic artifacts into Omni YAML.',
      'Review generated YAML, apply it to a dev branch, validate, then finish approval in Omni.',
    ],
    outcome: 'Blobby assists with semantic work while the admin keeps control of validation and deployment.',
    caution: 'This area should generate semantic YAML only. Dashboard screenshots and external BI credentials are intentionally out of scope.',
  },
  {
    id: 'governance',
    route: '/users',
    label: 'Governance',
    title: 'Manage people, labels, schedules, and embeds carefully',
    purpose: 'Governance pages help admins understand who has access, how content is organized, and what automated delivery exists.',
    directions: [
      'Use User Management for users, groups, inactive-user review, and entity access gaps.',
      'Use Labels to apply or audit content labels.',
      'Use Schedules and Embed URLs for delivery and embedded access workflows.',
    ],
    outcome: 'Governance changes are easier to inspect before they affect other users.',
  },
  {
    id: 'privacy',
    route: '/data-privacy',
    label: 'Privacy',
    title: 'Know exactly what is stored locally',
    purpose: 'OmniKit is local-first. The Data & Privacy page explains what is stored in the browser and gives users controls to export, import, or clear it.',
    directions: [
      'Review IndexedDB records for operation history and saved app metadata.',
      'Review localStorage and sessionStorage entries for browser-based state.',
      'Review the native vault path and reset controls for encrypted instance profiles and local migration job history.',
      'Use Instance Manager for one-time legacy multi-instance vault imports; keep the old tool data folder until imported profiles are verified.',
      'Use Clear all local data for browser data, and Reset native vault only when saved instance profiles should be removed.',
    ],
    outcome: 'Users can trust what the local app keeps and can cleanly reset it.',
  },
  {
    id: 'review-rhythm',
    route: '/history',
    label: 'Review',
    title: 'Use history and validation as the operating rhythm',
    purpose: 'The safest OmniKit habit is simple: select, review, apply only when validation passes, then use History and Omni review screens as the audit trail.',
    directions: [
      'Check History after meaningful operations or dashboard migration jobs.',
      'Open a migration job detail to review redacted step history, retry lineage, imported document IDs, warnings, and post-action results.',
      'Prefer dev branches and validation for semantic changes.',
      'Return to this guide from the sidebar any time someone needs a refresher.',
    ],
    outcome: 'Teams get a repeatable, low-anxiety workflow for day-to-day Omni administration.',
  },
];

export function readWalkthroughState(): WalkthroughStorageState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(WALKTHROUGH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WalkthroughStorageState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeWalkthroughState(next: WalkthroughStorageState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WALKTHROUGH_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Walkthrough persistence is helpful, not critical.
  }
}

export function clearWalkthroughState(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(WALKTHROUGH_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function shouldAutoOpenWalkthrough(state: WalkthroughStorageState | null): boolean {
  return !state || state.version !== WALKTHROUGH_VERSION;
}
