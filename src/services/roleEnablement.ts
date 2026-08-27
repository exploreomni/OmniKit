import { walkthroughSteps, type WalkthroughStepId } from '@/services/walkthrough';

export const ENABLEMENT_ROLES = [
  'Viewer',
  'Restricted Querier',
  'Querier',
  'Modeler',
  'Admin',
] as const;

export type EnablementRole = typeof ENABLEMENT_ROLES[number];
export type EnablementDepth = 'quick_start' | 'core' | 'deep_dive';
export type EnablementGoal = 'consume' | 'explore' | 'build' | 'govern' | 'administer' | 'ai';

export interface EnablementModule {
  id: string;
  title: string;
  objective: string;
  minutes: number;
  exercise: string;
  proof: string;
  escalationBoundary: string;
  asset: {
    kind: 'walkthrough' | 'app' | 'deck';
    label: string;
    route: string;
  };
  goals: EnablementGoal[];
}

export interface RoleEnablementPath {
  schemaVersion: 1;
  generatedAt: string;
  role: EnablementRole;
  omniRoleLabel: string;
  depth: EnablementDepth;
  goals: EnablementGoal[];
  totalMinutes: number;
  prerequisites: string[];
  modules: EnablementModule[];
  successMeasures: string[];
  guardrails: string[];
}

interface ModuleDefinition extends Omit<EnablementModule, 'asset'> {
  roles: EnablementRole[];
  depth: EnablementDepth[];
  asset: EnablementModule['asset'] | { kind: 'walkthrough'; label: string; stepId: WalkthroughStepId };
}

const MODULES: ModuleDefinition[] = [
  {
    id: 'trusted-content-navigation',
    title: 'Navigate trusted content safely',
    objective: 'Find governed dashboards, recognize ownership and freshness cues, and know when not to reinterpret a metric.',
    minutes: 20,
    exercise: 'Open a governed dashboard, identify its audience and filters, then explain what evidence is and is not visible.',
    proof: 'Learner can locate trusted content and describe one validation or escalation checkpoint.',
    escalationBoundary: 'Metric-definition or data-quality disputes return to the content owner or data team.',
    asset: { kind: 'walkthrough', label: 'Fleet and content walkthrough', stepId: 'start' },
    goals: ['consume'],
    roles: ['Viewer', 'Restricted Querier', 'Querier', 'Modeler', 'Admin'],
    depth: ['quick_start', 'core', 'deep_dive'],
  },
  {
    id: 'filters-drills-exports',
    title: 'Filter, drill, and export with context intact',
    objective: 'Use dashboard interactions without silently changing the business question or losing filter context.',
    minutes: 25,
    exercise: 'Apply a filter, drill into one value, and document the active context before exporting.',
    proof: 'Learner can reproduce the filtered result and name the context carried into the export.',
    escalationBoundary: 'A dashboard export is a point-in-time artifact, not a new governed source of truth.',
    asset: { kind: 'app', label: 'Dashboard Downloads', route: '/dashboards/downloads' },
    goals: ['consume'],
    roles: ['Viewer', 'Restricted Querier', 'Querier', 'Modeler', 'Admin'],
    depth: ['quick_start', 'core', 'deep_dive'],
  },
  {
    id: 'query-topics',
    title: 'Explore within assigned Query Topics',
    objective: 'Build questions inside the topic boundary represented to learners as Restricted Querier access.',
    minutes: 35,
    exercise: 'Create a query from an assigned topic, add a governed measure and dimension, and explain why fields outside the topic are unavailable.',
    proof: 'Learner produces a query using only assigned topic fields and validates the grain.',
    escalationBoundary: 'Restricted Querier is the learning label; access is implemented through Query Topics and must be verified with a test user.',
    asset: { kind: 'walkthrough', label: 'Readiness and permission walkthrough', stepId: 'readiness' },
    goals: ['explore'],
    roles: ['Restricted Querier'],
    depth: ['quick_start', 'core', 'deep_dive'],
  },
  {
    id: 'governed-query-building',
    title: 'Build and validate governed queries',
    objective: 'Choose a topic, check grain, build calculations deliberately, and validate results before sharing.',
    minutes: 45,
    exercise: 'Answer one business question in a workbook, reconcile the result to a trusted baseline, and save it in the approved location.',
    proof: 'Learner explains the query grain, the selected measures, and the validation evidence.',
    escalationBoundary: 'Semantic changes and unresolved fanout belong with a Modeler.',
    asset: { kind: 'app', label: 'AI Content Studio review workflow', route: '/content/ai-studio' },
    goals: ['explore', 'build', 'ai'],
    roles: ['Querier', 'Modeler', 'Admin'],
    depth: ['core', 'deep_dive'],
  },
  {
    id: 'presentation-handoff',
    title: 'Package governed findings for stakeholders',
    objective: 'Turn approved Omni tiles into a reviewable presentation without treating the deck as the analytical system of record.',
    minutes: 30,
    exercise: 'Select approved tiles, preserve their titles and filters, and generate a draft deck for review.',
    proof: 'Learner can trace every slide back to its Omni source and state the as-of context.',
    escalationBoundary: 'Deck copy and interpretation require human review before external distribution.',
    asset: { kind: 'deck', label: 'Deck Builder', route: '/deck-builder' },
    goals: ['consume', 'build'],
    roles: ['Viewer', 'Restricted Querier', 'Querier', 'Modeler', 'Admin'],
    depth: ['core', 'deep_dive'],
  },
  {
    id: 'semantic-development',
    title: 'Develop semantic changes on a branch',
    objective: 'Inspect model context, author the smallest coherent change, and preserve dependency and checksum evidence.',
    minutes: 60,
    exercise: 'Plan a topic change, stage it on a development branch, and review the resulting file diff.',
    proof: 'Learner can explain dependencies, affected content, and the reason for every changed file.',
    escalationBoundary: 'Ambiguous business logic stops for owner review rather than being inferred by the tool.',
    asset: { kind: 'walkthrough', label: 'AI Semantic Studio walkthrough', stepId: 'semantic-studio' },
    goals: ['build', 'govern', 'ai'],
    roles: ['Modeler', 'Admin'],
    depth: ['core', 'deep_dive'],
  },
  {
    id: 'release-preflight',
    title: 'Validate and hand off a governed release',
    objective: 'Collect caller, dbt, Git, checksum, validation, Content Validator, affected-content, and diff evidence before review.',
    minutes: 50,
    exercise: 'Generate a release evidence bundle and complete the manual PR or Omni review handoff without merging.',
    proof: 'Learner can identify every release gate and the system of record for final approval.',
    escalationBoundary: 'OmniKit never automatically merges a governed release.',
    asset: { kind: 'walkthrough', label: 'Model Migrator review workflow', stepId: 'model-migrator' },
    goals: ['govern'],
    roles: ['Modeler', 'Admin'],
    depth: ['deep_dive'],
  },
  {
    id: 'identity-access',
    title: 'Administer identity and verify effective access',
    objective: 'Separate organization, model, group, and content permission evidence and validate uncertain outcomes with a test user.',
    minutes: 55,
    exercise: 'Review one user lifecycle record and one expected-access scenario, then classify every finding as observed, inferred, confirmed, or unverified.',
    proof: 'Learner can explain why a role assignment alone does not prove effective access.',
    escalationBoundary: 'Embed-group and entity-folder behavior is not implied where the public API does not expose it.',
    asset: { kind: 'walkthrough', label: 'Administration walkthrough', stepId: 'governance' },
    goals: ['administer', 'govern'],
    roles: ['Admin'],
    depth: ['quick_start', 'core', 'deep_dive'],
  },
  {
    id: 'operations-evidence',
    title: 'Operate schedules, AI controls, and fleet evidence',
    objective: 'Review point-in-time control evidence, ownership exposure, and exclusions without overstating monitoring or reliability.',
    minutes: 45,
    exercise: 'Export one schedule ownership bundle and one AI governance snapshot, then identify the missing historical evidence.',
    proof: 'Learner separates current configuration/latest status from historical reliability.',
    escalationBoundary: 'Changes to schedules, AI limits, or evals use separate confirmed workflows in Omni.',
    asset: { kind: 'app', label: 'Fleet & Readiness', route: '/admin/fleet' },
    goals: ['administer', 'ai'],
    roles: ['Admin'],
    depth: ['core', 'deep_dive'],
  },
];

const DEPTH_LIMITS: Record<EnablementDepth, number> = {
  quick_start: 3,
  core: 6,
  deep_dive: Number.POSITIVE_INFINITY,
};

function resolveAsset(asset: ModuleDefinition['asset']): EnablementModule['asset'] {
  if ('route' in asset) return asset;
  const walkthrough = walkthroughSteps.find(({ id }) => id === asset.stepId);
  if (!walkthrough) throw new Error(`Missing walkthrough asset ${asset.stepId}.`);
  return { kind: 'walkthrough', label: asset.label, route: walkthrough.route };
}

function prerequisites(role: EnablementRole): string[] {
  if (role === 'Viewer') return ['Access to one approved Omni dashboard.'];
  if (role === 'Restricted Querier') return ['Viewer fluency.', 'At least one assigned Query Topic and a test-user access check.'];
  if (role === 'Querier') return ['Viewer fluency.', 'Access to an approved model and topic.'];
  if (role === 'Modeler') return ['Querier fluency.', 'A development branch and reviewed release process.'];
  return ['Admin access in a controlled environment.', 'A saved OmniKit instance and explicit change authority.'];
}

export function generateRoleEnablementPath(input: {
  role: EnablementRole;
  depth: EnablementDepth;
  goals?: EnablementGoal[];
  generatedAt?: string;
}): RoleEnablementPath {
  if (!ENABLEMENT_ROLES.includes(input.role)) throw new Error('Choose a supported Omni role.');
  const requestedGoals = [...new Set(input.goals ?? [])];
  const candidates = MODULES.filter((module) => (
    module.roles.includes(input.role)
    && module.depth.includes(input.depth)
    && (requestedGoals.length === 0 || module.goals.some((goal) => requestedGoals.includes(goal)))
  ));
  const modules = candidates.slice(0, DEPTH_LIMITS[input.depth]).map(({ roles: _roles, depth: _depth, asset, ...module }) => ({
    ...module,
    asset: resolveAsset(asset),
  }));
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    role: input.role,
    omniRoleLabel: input.role === 'Restricted Querier' ? 'Restricted Querier (Query Topics)' : input.role,
    depth: input.depth,
    goals: requestedGoals,
    totalMinutes: modules.reduce((sum, module) => sum + module.minutes, 0),
    prerequisites: prerequisites(input.role),
    modules,
    successMeasures: [
      'Learner completes every exercise using approved content or a controlled environment.',
      'Learner can explain the validation evidence and escalation boundary for the role.',
      'Role access is verified with the intended user or a representative test user.',
    ],
    guardrails: [
      'This plan generates a learning path; it does not assign an Omni role or track LMS completion.',
      'Official Omni documentation and the tenant permission result remain the release truth.',
      'Customer-facing adaptations require human review before delivery.',
    ],
  };
}

export function roleEnablementMarkdown(path: RoleEnablementPath): string {
  const lines = [
    `# ${path.omniRoleLabel} enablement path`,
    '',
    `Generated: ${path.generatedAt}`,
    `Depth: ${path.depth.replace(/_/g, ' ')}`,
    `Estimated guided time: ${path.totalMinutes} minutes`,
    '',
    '## Prerequisites',
    '',
    ...path.prerequisites.map((item) => `- ${item}`),
    '',
    '## Learning path',
    '',
  ];
  path.modules.forEach((module, index) => {
    lines.push(
      `### ${index + 1}. ${module.title} (${module.minutes} minutes)`,
      '',
      module.objective,
      '',
      `- Exercise: ${module.exercise}`,
      `- Proof: ${module.proof}`,
      `- Escalation boundary: ${module.escalationBoundary}`,
      `- Reusable asset: ${module.asset.label} (${module.asset.route})`,
      '',
    );
  });
  lines.push(
    '## Success measures',
    '',
    ...path.successMeasures.map((item) => `- ${item}`),
    '',
    '## Guardrails',
    '',
    ...path.guardrails.map((item) => `- ${item}`),
    '',
  );
  return lines.join('\n');
}
