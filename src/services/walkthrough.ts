export const WALKTHROUGH_VERSION = '2026-05-20-dashboard-excel-final';
export const WALKTHROUGH_DISPLAY_VERSION = 'Updated May 20, 2026';
export const WALKTHROUGH_STORAGE_KEY = 'omnikit:walkthrough:v1';

export type WalkthroughStepId =
  | 'start'
  | 'connect'
  | 'workflow-map'
  | 'dashboard-ai'
  | 'dashboard-builder'
  | 'excel-dashboard'
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
    route: '/connect',
    label: 'Overview',
    title: 'Start with the big picture',
    purpose: 'OmniKit is a local workspace for Omni admins. It helps you connect, review content, make safer bulk changes, and prepare AI-assisted semantic work without leaving a controlled local tool.',
    directions: [
      'Use the sidebar like a checklist, moving from Connect into the area that matches your task.',
      'Look for selected-state badges and progress panels to confirm what OmniKit will act on.',
      'When a workflow writes changes, expect a review step before anything is applied.',
    ],
    outcome: 'You know where work starts, where review happens, and where final approval stays in Omni.',
  },
  {
    id: 'connect',
    route: '/connect',
    label: 'Connect',
    title: 'Connect to your Omni instance',
    purpose: 'Connect is the front door. A non-technical user only needs the Omni URL and an API key from their admin team.',
    directions: [
      'Paste the Omni base URL, such as yourcompany.omniapp.co.',
      'Paste the API key and test the connection.',
      'After success, use the recommended next actions or the sidebar.',
    ],
    outcome: 'OmniKit can read the Omni content and model metadata needed by the rest of the app.',
    caution: 'The active API key stays in same-tab session storage and is cleared by Data & Privacy.',
  },
  {
    id: 'workflow-map',
    route: '/dashboards/operations',
    label: 'Workflow Map',
    title: 'Choose the workflow by the job you need done',
    purpose: 'Each page is built around one admin job. Users do not need to understand the underlying APIs before starting.',
    directions: [
      'Dashboard AI & Delivery is for dashboard reviews, migration, downloads, deck creation, and bulk dashboard operations.',
      'Data & AI Readiness is for model health, content health, uploads, connections, and AI Semantic Studio.',
      'Governance is for labels, schedules, users, groups, and embeds.',
    ],
    outcome: 'The user can pick the right page without guessing which technical object matters first.',
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
    id: 'model-migrator',
    route: '/dashboards/migrate',
    label: 'Migrate',
    title: 'Use Model Migrator for Omni-to-Omni dashboard moves',
    purpose: 'Model Migrator is for moving dashboards between Omni connections while reviewing model mappings before committing.',
    directions: [
      'Pick the source and target Omni connections.',
      'Select dashboards, map base models, and run Compatibility Preflight.',
      'Review payload and field-compatibility warnings before committing; results are logged to History.',
    ],
    outcome: 'Dashboard migration work becomes a reviewed checklist with clear warnings for missing fields or risky model swaps.',
    caution: 'Preflight checks field presence, not business-definition equivalence. External BI semantic imports belong in AI Semantic Studio.',
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
      'Use Connection Health to confirm Omni access and account readiness.',
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
      'Use User Management for users and groups.',
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
      'Review localStorage and sessionStorage entries.',
      'Use Clear all local data when handing off or resetting a machine.',
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
      'Check History after meaningful operations.',
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
