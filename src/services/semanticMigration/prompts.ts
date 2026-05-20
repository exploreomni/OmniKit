import type { MigrationInventory } from './types';

const MAX_ARTIFACT_SNIPPET_CHARS = 12_000;
const MAX_TOTAL_SNIPPET_CHARS = 36_000;
const MAX_TARGET_YAML_CHARS = 12_000;
const MAX_TOTAL_TARGET_YAML_CHARS = 48_000;

function redactSensitive(value: string) {
  return value
    .replace(/(api[_-]?key|authorization|token|secret|password)(["'\s:=]+)([^"',\s}]+)/gi, '$1$2[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
}

function listItems(values: string[], fallback = '- None detected') {
  return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : fallback;
}

function inventorySummary(inventory: MigrationInventory) {
  const viewLines = inventory.views.slice(0, 25).map((view) => {
    const fieldNames = view.fields.slice(0, 12).map((field) => field.name).join(', ');
    const measureNames = view.measures.slice(0, 8).map((measure) => measure.name).join(', ');
    return `${view.name}${view.description ? ` - ${view.description}` : ''}${fieldNames ? ` | fields: ${fieldNames}` : ''}${measureNames ? ` | measures: ${measureNames}` : ''}`;
  });

  const exploreLines = inventory.explores.slice(0, 20).map((explore) => {
    const joins = explore.joins.map((join) => `${join.from} -> ${join.to}${join.sql ? ` on ${join.sql}` : ''}`).join('; ');
    return `${explore.name}${explore.baseView ? ` | base: ${explore.baseView}` : ''}${joins ? ` | joins: ${joins}` : ''}`;
  });

  const relationshipLines = inventory.relationships.slice(0, 25).map((relationship) =>
    `${relationship.from} -> ${relationship.to}${relationship.relationshipType ? ` (${relationship.relationshipType})` : ''}${relationship.sql ? ` | ${relationship.sql}` : ''}`
  );

  const dashboardLines = inventory.dashboards.slice(0, 20).map((dashboard) => {
    const fields = dashboard.fields.slice(0, 12).join(', ');
    const filters = dashboard.filters.slice(0, 8).join(', ');
    return `${dashboard.name}${fields ? ` | fields: ${fields}` : ''}${filters ? ` | filters: ${filters}` : ''}`;
  });

  const metricLines = inventory.metrics.slice(0, 30).map((metric) =>
    `${metric.name}${metric.aggregateType ? ` (${metric.aggregateType})` : ''}${metric.description ? ` - ${metric.description}` : ''}`
  );

  return [
    `Source tool: ${inventory.sourceTool}`,
    `Inventory: ${inventory.summary}`,
    '',
    'Detected semantic objects:',
    listItems(viewLines),
    '',
    'Detected explores/topics:',
    listItems(exploreLines),
    '',
    'Detected relationships:',
    listItems(relationshipLines),
    '',
    'Detected metrics/measures:',
    listItems(metricLines),
    '',
    'Detected dashboard/report evidence:',
    listItems(dashboardLines),
    '',
    'Parser warnings:',
    listItems(inventory.warnings),
  ].join('\n');
}

function artifactSnippets(inventory: MigrationInventory) {
  let total = 0;
  return inventory.artifacts
    .filter((artifact) => artifact.content.trim())
    .slice(0, 8)
    .map((artifact) => {
      const remaining = Math.max(0, MAX_TOTAL_SNIPPET_CHARS - total);
      const limit = Math.min(MAX_ARTIFACT_SNIPPET_CHARS, remaining);
      if (limit <= 0) return '';
      const snippet = redactSensitive(artifact.content.slice(0, limit));
      total += snippet.length;
      return [
        `--- Artifact: ${artifact.name} (${artifact.kind}, ${artifact.sizeBytes} bytes) ---`,
        snippet,
      ].join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

function existingFileContext(fileNames?: string[]) {
  const names = (fileNames || []).filter(Boolean).sort();
  if (names.length === 0) return '- Target model file list was not loaded. Treat target file names as validation items.';
  return listItems(names);
}

function currentTargetYamlContext(files?: Record<string, string>) {
  const entries = Object.entries(files || {}).filter(([, yaml]) => yaml.trim());
  if (entries.length === 0) return '- Current target YAML bodies were not loaded. Do not return complete replacements for existing files unless the admin confirms the current body separately.';

  let total = 0;
  return entries
    .map(([fileName, yaml]) => {
      const remaining = Math.max(0, MAX_TOTAL_TARGET_YAML_CHARS - total);
      const limit = Math.min(MAX_TARGET_YAML_CHARS, remaining);
      if (limit <= 0) return '';
      const body = yaml.length > limit ? `${yaml.slice(0, limit)}\n# ... truncated for prompt budget; preserve any omitted existing sections unless explicitly confirmed.` : yaml;
      total += body.length;
      return [
        `--- Current target file: ${fileName} ---`,
        '```yaml',
        body,
        '```',
      ].join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

function sourcePracticeGuidance(sourceTool: MigrationInventory['sourceTool']) {
  if (sourceTool === 'dbt') {
    return `dbt migration practice:
- Treat dbt as the transformation and semantic evidence layer, not as an Omni semantic file replacement.
- Use dbt model YAML, columns, metrics, semantic models, constraints, tests, and exposures to infer Omni views, relationships, topics, and validation notes.
- Keep dbt repository source and Omni semantic model files separate; OmniKit should generate Omni YAML to a dev branch only.
- Do not invent joins, measures, or permission controls that are not supported by source artifacts or confirmed admin intent.`;
  }

  if (sourceTool === 'looker') {
    return `Looker migration practice:
- Treat LookML views, explores, joins, measures, access filters, and dashboard usage as evidence for an Omni re-model.
- Re-model for Omni semantics instead of transliterating LookML one-to-one.
- Use dashboards and Looks only as usage evidence for topics, fields, default filters, and validation priorities.
- Derived tables/PDTs should generally become dbt or warehouse models before Omni view YAML; route access_filter logic to Permission Builder validation.`;
  }

  if (sourceTool === 'power_bi') {
    return `Power BI migration practice:
- Treat model.bim, TMDL, DAX measures, relationships, and report layout metadata as semantic evidence for Omni.
- Convert Power BI tables and measures into Omni-native views/measures only after validating DAX definitions, grain, and filter context assumptions.
- Use reports/pages/visuals as field-usage evidence for topics and ai_context, not as dashboard recreation instructions.
- Row-level security roles, workspace permissions, and sensitivity labels should become Permission Builder validation items unless explicitly confirmed.`;
  }

  if (sourceTool === 'tableau') {
    return `Tableau migration practice:
- Treat TWB/TDS datasource XML, fields, calculated fields, joins, worksheets, and dashboards as semantic evidence for Omni.
- Convert Tableau calculated fields carefully; table calculations and LOD expressions need human review before becoming Omni SQL.
- Use workbooks and dashboards as usage evidence for topics, field curation, and validation priorities, not as dashboard recreation instructions.
- Tableau permissions, extracts, and refresh schedules should stay validation notes unless the target Omni file supports an explicit equivalent.`;
  }

  return `Domo migration practice:
- Treat dataset schemas, card metadata, Beast Mode formulas, DataFlow SQL, and dashboard/card usage as semantic evidence for Omni.
- Validate Beast Mode formulas, dataset grain, and Magic ETL/DataFlow assumptions before generating Omni measures.
- Use Domo cards and dashboards as usage evidence for topics and field prioritization, not as dashboard recreation instructions.
- Domo group permissions and PDP policies should become Permission Builder validation items unless explicitly confirmed.`;
}

export function buildSemanticMigrationPlanPrompt(params: {
  inventory: MigrationInventory;
  modelName: string;
  modelId: string;
  adminGoal: string;
  existingFileNames?: string[];
}) {
  const { inventory, modelName, modelId, adminGoal, existingFileNames } = params;
  return `AI Semantic Studio - Semantic Migration Import Plan

Act as a senior analytics engineer migrating semantic layer evidence into Omni.

Stage contract: PLAN ONLY.
- Return concise admin-friendly markdown.
- Do not return deployable YAML, Target file blocks, or code fences labeled yaml.
- This workflow is semantic-only: do not generate dashboards, dashboard import JSON, image analysis, screenshots, or external BI credential steps.
- Dashboard/report artifacts are evidence for semantic design only.

Target Omni model:
- Name: ${modelName}
- ID: ${modelId}

Existing Omni semantic files in the target model:
${existingFileContext(existingFileNames)}

Admin migration goal:
${adminGoal.trim() || 'Create reviewed Omni semantic YAML from uploaded/pasted source artifacts.'}

${sourcePracticeGuidance(inventory.sourceTool)}

Local parser inventory:
${inventorySummary(inventory)}

Source artifact snippets:
${artifactSnippets(inventory) || '- No source snippets were available.'}

Return exactly these sections:
- Migration readout
- Proposed Omni semantic targets
- Translation risks
- Human confirmations needed
- Package readiness

Keep each section to 3-5 bullets.`;
}

export function buildSemanticMigrationPackagePrompt(params: {
  inventory: MigrationInventory;
  modelName: string;
  modelId: string;
  adminGoal: string;
  confirmedPlan: string;
  existingFileNames?: string[];
  currentTargetFiles?: Record<string, string>;
}) {
  const { inventory, modelName, modelId, adminGoal, confirmedPlan, existingFileNames, currentTargetFiles } = params;
  return `AI Semantic Studio - Semantic Migration YAML Package

Act as a senior analytics engineer generating reviewable Omni semantic YAML from confirmed migration inputs.

Stage contract: PACKAGE.
- Return complete replacement YAML bodies only for Omni semantic files that are needed and supported by the source evidence.
- Each file must be preceded by "Target file: <target>" and the next non-empty line must be \`\`\`yaml.
- Supported targets: model, relationships, <view>.view, <topic>.topic.
- Put assumptions and validations after the final YAML block only.
- Do not return dashboard JSON, dashboard build specs, screenshots, BI credentials, patch fragments, or files for unsupported tools.
- Do not modify Topic Builder, Model / View Builder, or Permission Builder prompts; this is a Semantic Migration Import package.

Omni file rules:
- model is for model-wide settings only. Do not put topic joins, fields, dimensions, measures, or ai_context in model.
- relationships is a top-level YAML list of relationship objects. Do not wrap it in a relationships: key.
- <view>.view is for dimensions, measures, field descriptions, formats, hidden flags, primary keys, links, synonyms, and view-level metadata.
- <topic>.topic is for base_view, label, description, default_filters, joins, fields, ai_fields, sample_queries, and final ai_context.
- Preserve source intent but generate Omni-native YAML. Do not transliterate unsupported source syntax.
- Use exact existing target file names when replacing current files. Do not shorten schema-qualified paths: if the target model contains public/order_items.view, return Target file: public/order_items.view, not Target file: order_items.view.
- If a source object maps to an existing file listed below, update that existing file path. Only return a new unqualified <view>.view or <topic>.topic file when the admin explicitly confirmed a new file should be created.
- For every existing file you return, use the current target YAML body below as source of truth and return a complete replacement that preserves all unchanged top-level sections and existing fields/measures. Do not replace a mature file with a minimal skeleton.
- Prefer small, safe metadata/context edits over broad rewrites. If preserving a current file body is too large or uncertain, omit that deployable file and put the recommendation in Assumptions / validations.
- Quote description values or use YAML block scalars when description text contains colon-space, lists, formulas, or source field inventories. Do not emit unquoted description strings such as "Source fields: id, status" because Omni may reject them as non-string values.
- If a join, metric, filter, permission, or target file is not confirmed by source evidence, put it in assumptions/validations instead of inventing deployable YAML.
- Do not convert source dashboard filters, LookML always_filter, access_filter, or prose filter defaults into deployable Omni default_filters unless the current target file already contains a known-good default_filters map to preserve. If exact Omni filter map syntax is uncertain, keep the filter rule in ai_context and Assumptions / validations.
- Treat raw PII, access filters, user attributes, and permissions as validation items unless explicitly confirmed in the source evidence and target file type supports them.
- Do not add direct PII, contact fields, person names, raw identifiers, zip/postal codes, or precise latitude/longitude to topic fields or ai_fields unless the admin explicitly confirmed governed exposure in this package. If source artifacts mention these fields, keep them in Assumptions / validations or add negative AI-routing guidance in ai_context.
- Do not add a broad topic fields list just to mirror a BI datasource. Use topic fields only for a narrow, current-safe curation set; otherwise preserve the existing topic shape and describe curation recommendations after the YAML.

Target Omni model:
- Name: ${modelName}
- ID: ${modelId}

Existing Omni semantic files in the target model:
${existingFileContext(existingFileNames)}

Current YAML bodies for likely target files:
${currentTargetYamlContext(currentTargetFiles)}

Admin migration goal:
${adminGoal.trim() || 'Create reviewed Omni semantic YAML from uploaded/pasted source artifacts.'}

Confirmed migration plan:
${confirmedPlan.trim() || 'No separate plan text was provided. Use the parser inventory and source snippets as the confirmed migration scope.'}

${sourcePracticeGuidance(inventory.sourceTool)}

Local parser inventory:
${inventorySummary(inventory)}

Source artifact snippets:
${artifactSnippets(inventory) || '- No source snippets were available.'}

Required response shape:
Target file: <model | relationships | name.view | name.topic>
\`\`\`yaml
<complete replacement YAML body>
\`\`\`

Assumptions / validations
- <max 5 bullets>`;
}
