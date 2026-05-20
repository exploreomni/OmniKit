import type {
  MigrationArtifact,
  MigrationDashboardEvidence,
  MigrationExplore,
  MigrationField,
  MigrationInventory,
  MigrationMeasure,
  MigrationRelationship,
  MigrationSourceTool,
  MigrationView,
} from './types';

const MAX_ARTIFACT_CHARS = 140_000;

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function compact(value: string | undefined | null) {
  return (value || '').trim();
}

function unique(values: string[], limit = 80) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, limit);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function inferArtifactKind(name: string, sourceTool: MigrationSourceTool): MigrationArtifact['kind'] {
  const lower = name.toLowerCase();
  if (lower.endsWith('manifest.json')) return 'manifest';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.lkml') || lower.includes('lookml')) return 'lookml';
  if (lower.endsWith('.twb') || lower.endsWith('.tds') || lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.bim') || lower.endsWith('.tmdl') || lower.endsWith('.model')) return 'metadata';
  if (lower.endsWith('.json')) return 'json';
  if (lower.includes('dashboard')) return 'dashboard';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv')) return 'text';
  return sourceTool === 'looker' ? 'lookml' : 'unknown';
}

function displayNameFromFile(file: File) {
  const maybeRelative = 'webkitRelativePath' in file ? String(file.webkitRelativePath || '') : '';
  return maybeRelative || file.name;
}

export async function artifactsFromFiles(sourceTool: MigrationSourceTool, files: FileList | File[]) {
  const fileArray = Array.from(files);
  const artifacts: MigrationArtifact[] = [];

  for (const file of fileArray) {
    const name = displayNameFromFile(file);
    const warnings: string[] = [];
    if (file.type.startsWith('image/')) {
      artifacts.push({
        id: makeId('artifact'),
        sourceTool,
        name,
        kind: 'unknown',
        content: '',
        sizeBytes: file.size,
        parseWarnings: ['Image and screenshot uploads are not supported in semantic migration mode. Use source SQL, YAML, manifest JSON, or LookML text.'],
      });
      continue;
    }

    let content = await file.text();
    if (content.length > MAX_ARTIFACT_CHARS) {
      content = content.slice(0, MAX_ARTIFACT_CHARS);
      warnings.push(`Truncated ${name} to ${MAX_ARTIFACT_CHARS.toLocaleString()} characters for the AI prompt. Add fewer or more focused source files if detail is missing.`);
    }

    artifacts.push({
      id: makeId('artifact'),
      sourceTool,
      name,
      kind: inferArtifactKind(name, sourceTool),
      content,
      sizeBytes: file.size,
      parseWarnings: warnings,
    });
  }

  return artifacts;
}

export function artifactFromText(sourceTool: MigrationSourceTool, content: string, name = 'pasted-source.txt'): MigrationArtifact | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const warnings: string[] = [];
  const safeContent = trimmed.length > MAX_ARTIFACT_CHARS ? trimmed.slice(0, MAX_ARTIFACT_CHARS) : trimmed;
  if (trimmed.length > safeContent.length) {
    warnings.push(`Truncated pasted content to ${MAX_ARTIFACT_CHARS.toLocaleString()} characters for the AI prompt.`);
  }
  return {
    id: makeId('artifact'),
    sourceTool,
    name,
    kind: inferArtifactKind(name, sourceTool),
    content: safeContent,
    sizeBytes: new Blob([safeContent]).size,
    parseWarnings: warnings,
  };
}

export function buildMigrationInventory(sourceTool: MigrationSourceTool, artifacts: MigrationArtifact[]): MigrationInventory {
  const warnings: string[] = artifacts.flatMap((artifact) => artifact.parseWarnings);
  const views: MigrationView[] = [];
  const explores: MigrationExplore[] = [];
  const relationships: MigrationRelationship[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const metrics: MigrationMeasure[] = [];

  artifacts.forEach((artifact) => {
    if (!artifact.content.trim()) return;
    if (sourceTool === 'dbt') {
      const parsed = parseDbtArtifact(artifact);
      views.push(...parsed.views);
      relationships.push(...parsed.relationships);
      dashboards.push(...parsed.dashboards);
      metrics.push(...parsed.metrics);
      warnings.push(...parsed.warnings);
    } else if (sourceTool === 'looker') {
      const parsed = parseLookerArtifact(artifact);
      views.push(...parsed.views);
      explores.push(...parsed.explores);
      relationships.push(...parsed.relationships);
      dashboards.push(...parsed.dashboards);
      metrics.push(...parsed.metrics);
      warnings.push(...parsed.warnings);
    } else {
      const parsed = parseStructuredBiArtifact(artifact, sourceTool);
      views.push(...parsed.views);
      explores.push(...parsed.explores);
      relationships.push(...parsed.relationships);
      dashboards.push(...parsed.dashboards);
      metrics.push(...parsed.metrics);
      warnings.push(...parsed.warnings);
    }
  });

  const mergedViews = mergeViews(views);
  const mergedMetrics = mergeMeasures([...metrics, ...mergedViews.flatMap((view) => view.measures)]);
  const mergedRelationships = mergeRelationships([...relationships, ...explores.flatMap((explore) => explore.joins)]);
  const mergedDashboards = mergeDashboards(dashboards);
  const cleanWarnings = unique(warnings, 60);

  return {
    sourceTool,
    artifactCount: artifacts.length,
    artifacts,
    views: mergedViews,
    explores: mergeExplores(explores),
    relationships: mergedRelationships,
    dashboards: mergedDashboards,
    metrics: mergedMetrics,
    warnings: cleanWarnings,
    summary: [
      `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`,
      `${mergedViews.length} semantic object${mergedViews.length === 1 ? '' : 's'}`,
      `${mergedMetrics.length} metric/measure${mergedMetrics.length === 1 ? '' : 's'}`,
      `${mergedRelationships.length} relationship${mergedRelationships.length === 1 ? '' : 's'}`,
      `${mergedDashboards.length} dashboard/report evidence item${mergedDashboards.length === 1 ? '' : 's'}`,
    ].join(' · '),
  };
}

function parseDbtArtifact(artifact: MigrationArtifact) {
  if (artifact.kind === 'manifest') return parseDbtManifest(artifact);
  if (artifact.kind === 'yaml') return parseDbtYaml(artifact);
  if (artifact.kind === 'sql') return parseDbtSql(artifact);
  return {
    views: [] as MigrationView[],
    relationships: [] as MigrationRelationship[],
    dashboards: [] as MigrationDashboardEvidence[],
    metrics: [] as MigrationMeasure[],
    warnings: [`${artifact.name} was included as context but did not match a dbt manifest, YAML, or SQL artifact.`],
  };
}

function parseDbtManifest(artifact: MigrationArtifact) {
  const warnings: string[] = [];
  const views: MigrationView[] = [];
  const relationships: MigrationRelationship[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const metrics: MigrationMeasure[] = [];

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(artifact.content) as Record<string, unknown>;
  } catch {
    return {
      views,
      relationships,
      dashboards,
      metrics,
      warnings: [`${artifact.name} is not valid JSON, so OmniKit could not parse it as a dbt manifest.`],
    };
  }

  const nodes = asRecord(manifest.nodes);
  Object.values(nodes).forEach((nodeValue) => {
    const node = asRecord(nodeValue);
    const resourceType = compact(String(node.resource_type || node.resourceType || ''));
    const name = compact(String(node.name || node.alias || ''));
    if (!name) return;
    if (resourceType === 'model' || resourceType === 'seed' || resourceType === 'snapshot' || resourceType === 'source') {
      const columns = asRecord(node.columns);
      views.push({
        name,
        description: compact(String(node.description || '')),
        sourceArtifact: artifact.name,
        fields: Object.entries(columns).map(([columnName, columnValue]) => {
          const column = asRecord(columnValue);
          return {
            name: columnName,
            type: compact(String(column.data_type || column.dataType || column.type || '')),
            description: compact(String(column.description || '')),
            sourceArtifact: artifact.name,
          };
        }),
        measures: [],
        warnings: [],
      });
    }

    if (resourceType === 'metric' || resourceType === 'measure') {
      metrics.push({
        name,
        description: compact(String(node.description || '')),
        aggregateType: compact(String(node.calculation_method || node.type || '')),
        sourceArtifact: artifact.name,
      });
    }

    if (resourceType === 'exposure') {
      dashboards.push({
        name,
        fields: [],
        filters: [],
        sourceArtifact: artifact.name,
      });
    }
  });

  const semanticModels = asRecord(manifest.semantic_models || manifest.semanticModels);
  Object.values(semanticModels).forEach((semanticValue) => {
    const semantic = asRecord(semanticValue);
    const name = compact(String(semantic.name || semantic.model || ''));
    if (!name) return;
    const dimensions = Array.isArray(semantic.dimensions) ? semantic.dimensions : [];
    const measures = Array.isArray(semantic.measures) ? semantic.measures : [];
    views.push({
      name,
      description: compact(String(semantic.description || '')),
      sourceArtifact: artifact.name,
      fields: dimensions.map((dimensionValue) => {
        const dimension = asRecord(dimensionValue);
        return {
          name: compact(String(dimension.name || '')),
          type: compact(String(dimension.type || '')),
          description: compact(String(dimension.description || '')),
          sourceArtifact: artifact.name,
        };
      }).filter((field) => field.name),
      measures: measures.map((measureValue) => {
        const measure = asRecord(measureValue);
        return {
          name: compact(String(measure.name || '')),
          type: compact(String(measure.type || '')),
          aggregateType: compact(String(measure.agg || measure.agg_time_dimension || measure.type || '')),
          description: compact(String(measure.description || '')),
          sourceArtifact: artifact.name,
        };
      }).filter((measure) => measure.name),
      warnings: [],
    });
  });

  if (views.length === 0 && metrics.length === 0 && dashboards.length === 0) {
    warnings.push(`${artifact.name} parsed successfully, but no dbt models, metrics, semantic models, or exposures were detected.`);
  }

  return { views, relationships, dashboards, metrics, warnings };
}

function parseDbtYaml(artifact: MigrationArtifact) {
  const lines = artifact.content.split(/\r?\n/);
  const views: MigrationView[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const metrics: MigrationMeasure[] = [];
  const warnings: string[] = [];
  let section = '';
  let currentView: MigrationView | null = null;
  let inColumns = false;

  lines.forEach((line) => {
    const indent = line.match(/^\s*/)?.[0].length || 0;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const root = trimmed.match(/^([a-zA-Z_]+):\s*$/);
    if (indent === 0 && root) {
      section = root[1];
      currentView = null;
      inColumns = false;
      return;
    }

    const namedItem = trimmed.match(/^-\s+name:\s*["']?([^"'\s#]+)["']?/);
    if (namedItem && ['models', 'sources', 'semantic_models'].includes(section) && indent <= 4) {
      currentView = {
        name: namedItem[1],
        sourceArtifact: artifact.name,
        fields: [],
        measures: [],
        warnings: [],
      };
      views.push(currentView);
      inColumns = false;
      return;
    }

    if (namedItem && section === 'metrics') {
      metrics.push({ name: namedItem[1], sourceArtifact: artifact.name });
      return;
    }

    if (namedItem && section === 'exposures') {
      dashboards.push({ name: namedItem[1], fields: [], filters: [], sourceArtifact: artifact.name });
      return;
    }

    if (currentView && trimmed === 'columns:') {
      inColumns = true;
      return;
    }

    if (currentView && inColumns && namedItem) {
      currentView.fields.push({ name: namedItem[1], sourceArtifact: artifact.name });
      return;
    }

    if (currentView && trimmed.startsWith('description:') && !currentView.description) {
      currentView.description = trimmed.replace(/^description:\s*/, '').replace(/^["']|["']$/g, '');
    }
  });

  if (views.length === 0 && metrics.length === 0 && dashboards.length === 0) {
    warnings.push(`${artifact.name} did not expose dbt models, metrics, semantic models, or exposures through the lightweight parser.`);
  }
  return { views, relationships: [] as MigrationRelationship[], dashboards, metrics, warnings };
}

function parseDbtSql(artifact: MigrationArtifact) {
  const name = artifact.name.split('/').pop()?.replace(/\.sql$/i, '') || artifact.name;
  const selectList = artifact.content.match(/\bselect\b([\s\S]*?)\bfrom\b/i)?.[1] || '';
  const columns = unique(selectList
    ?.split(',')
    .map((part) => {
      const alias = part.match(/\bas\s+([a-zA-Z_][\w]*)/i)?.[1];
      const bare = part.trim().match(/([a-zA-Z_][\w]*)\s*$/)?.[1];
      return alias || bare || '';
    }) || [], 40);
  return {
    views: [{
      name,
      sourceArtifact: artifact.name,
      fields: columns.map((column) => ({ name: column, sourceArtifact: artifact.name })),
      measures: [],
      warnings: columns.length === 0 ? ['SQL model fields could not be inferred safely from the select list.'] : [],
    }],
    relationships: [] as MigrationRelationship[],
    dashboards: [] as MigrationDashboardEvidence[],
    metrics: [] as MigrationMeasure[],
    warnings: [] as string[],
  };
}

function parseLookerArtifact(artifact: MigrationArtifact) {
  const warnings: string[] = [];
  const views = extractLookmlViews(artifact);
  const explores = extractLookmlExplores(artifact);
  const relationships = explores.flatMap((explore) => explore.joins);
  const dashboards = extractLookmlDashboards(artifact);
  const metrics = views.flatMap((view) => view.measures);

  if (/access_filter\s*:/.test(artifact.content)) {
    warnings.push(`${artifact.name} contains Looker access_filter definitions. Treat them as permission requirements; do not convert them without confirmed Omni user attributes and grants.`);
  }
  if (/derived_table\s*:|explore_source\s*:|sql_trigger_value\s*:/.test(artifact.content)) {
    warnings.push(`${artifact.name} appears to contain a derived table or PDT pattern. Prefer moving transformation logic to dbt or a governed warehouse model before generating Omni view YAML.`);
  }
  if (views.length === 0 && explores.length === 0 && dashboards.length === 0) {
    warnings.push(`${artifact.name} did not expose LookML views, explores, or dashboard evidence through the lightweight parser.`);
  }

  return { views, explores, relationships, dashboards, metrics, warnings };
}

function extractLookmlViews(artifact: MigrationArtifact): MigrationView[] {
  return extractNamedBlocks(artifact.content, 'view').map(({ name, block }) => {
    const fields = extractNamedBlocks(block, 'dimension')
      .concat(extractNamedBlocks(block, 'dimension_group'))
      .map(({ name: fieldName, block: fieldBlock }) => parseLookmlField(fieldName, fieldBlock, artifact.name));
    const measures = extractNamedBlocks(block, 'measure')
      .map(({ name: measureName, block: measureBlock }) => ({
        ...parseLookmlField(measureName, measureBlock, artifact.name),
        aggregateType: matchLookmlParam(measureBlock, 'type'),
      }));
    return {
      name,
      description: matchLookmlParam(block, 'description'),
      sourceArtifact: artifact.name,
      fields,
      measures,
      warnings: /hidden:\s*yes|hidden:\s*true/.test(block) ? ['Contains hidden Looker fields; preserve intent instead of blindly exposing everything in Omni.'] : [],
    };
  });
}

function extractLookmlExplores(artifact: MigrationArtifact): MigrationExplore[] {
  return extractNamedBlocks(artifact.content, 'explore').map(({ name, block }) => {
    const joins = extractNamedBlocks(block, 'join').map(({ name: joinName, block: joinBlock }) => ({
      from: name,
      to: joinName,
      joinType: matchLookmlParam(joinBlock, 'type'),
      relationshipType: matchLookmlParam(joinBlock, 'relationship'),
      sql: matchLookmlParam(joinBlock, 'sql_on'),
      sourceArtifact: artifact.name,
    }));
    return {
      name,
      baseView: matchLookmlParam(block, 'view_name') || name,
      joins,
      fields: unique(Array.from(block.matchAll(/\bfields\s*:\s*\[([^\]]+)\]/g)).flatMap((match) => splitInlineList(match[1])), 80),
      filters: unique(Array.from(block.matchAll(/\b(?:always_filter|conditionally_filter|access_filter)\s*:\s*([^\n{]+)/g)).map((match) => match[0]), 40),
      sourceArtifact: artifact.name,
    };
  });
}

function extractLookmlDashboards(artifact: MigrationArtifact): MigrationDashboardEvidence[] {
  const dashboards = extractNamedBlocks(artifact.content, 'dashboard').map(({ name, block }) => ({
    name,
    fields: unique(Array.from(block.matchAll(/\b(?:field|dimension|measure)\s*:\s*"?([^"\n]+)"?/g)).map((match) => match[1]), 80),
    filters: unique(Array.from(block.matchAll(/\bfilter(?:s)?\s*:\s*([^\n{]+)/g)).map((match) => match[1]), 40),
    sourceArtifact: artifact.name,
  }));

  if (dashboards.length > 0) return dashboards;
  if (/dashboard|element|tile|vis_config|listen:/i.test(artifact.content)) {
    return [{
      name: artifact.name.replace(/\.(dashboard\.)?lookml$/i, ''),
      fields: unique(Array.from(artifact.content.matchAll(/\b(?:field|dimension|measure)\s*:\s*"?([^"\n]+)"?/g)).map((match) => match[1]), 80),
      filters: unique(Array.from(artifact.content.matchAll(/\bfilter(?:s)?\s*:\s*([^\n{]+)/g)).map((match) => match[1]), 40),
      sourceArtifact: artifact.name,
    }];
  }
  return [];
}

function parseLookmlField(name: string, block: string, sourceArtifact: string): MigrationField {
  return {
    name,
    type: matchLookmlParam(block, 'type'),
    sql: matchLookmlParam(block, 'sql'),
    description: matchLookmlParam(block, 'description'),
    sourceArtifact,
  };
}

function parseStructuredBiArtifact(artifact: MigrationArtifact, sourceTool: MigrationSourceTool) {
  if (sourceTool === 'power_bi') return parsePowerBiArtifact(artifact);
  if (sourceTool === 'tableau') return parseTableauArtifact(artifact);
  if (sourceTool === 'domo') return parseDomoArtifact(artifact);
  return emptyParseResult(`${artifact.name} is not supported by a migration adapter yet.`);
}

function emptyParseResult(warning?: string) {
  return {
    views: [] as MigrationView[],
    explores: [] as MigrationExplore[],
    relationships: [] as MigrationRelationship[],
    dashboards: [] as MigrationDashboardEvidence[],
    metrics: [] as MigrationMeasure[],
    warnings: warning ? [warning] : [] as string[],
  };
}

function parsePowerBiArtifact(artifact: MigrationArtifact) {
  const parsedJson = tryParseJson(artifact.content);
  if (parsedJson) return parsePowerBiJsonArtifact(artifact, parsedJson);
  const textResult = parsePowerBiTextArtifact(artifact);
  const embeddedJsonResults = extractEmbeddedJsonObjects(artifact.content)
    .map((json, index) => parsePowerBiJsonArtifact({ ...artifact, name: `${artifact.name} JSON segment ${index + 1}` }, json));

  if (embeddedJsonResults.length === 0) return textResult;

  return {
    views: [...textResult.views, ...embeddedJsonResults.flatMap((result) => result.views)],
    explores: [...textResult.explores, ...embeddedJsonResults.flatMap((result) => result.explores)],
    relationships: [...textResult.relationships, ...embeddedJsonResults.flatMap((result) => result.relationships)],
    dashboards: [...textResult.dashboards, ...embeddedJsonResults.flatMap((result) => result.dashboards)],
    metrics: [...textResult.metrics, ...embeddedJsonResults.flatMap((result) => result.metrics)],
    warnings: [...textResult.warnings, ...embeddedJsonResults.flatMap((result) => result.warnings)],
  };
}

function extractEmbeddedJsonObjects(content: string) {
  const objects: unknown[] = [];
  for (let index = 0; index < content.length && objects.length < 5; index += 1) {
    if (content[index] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = index; cursor < content.length; cursor += 1) {
      const char = content[cursor];
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
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParseJson(content.slice(index, cursor + 1));
          if (parsed && (findFirstRecord(parsed, ['model']) || findFirstArray(parsed, ['tables', 'relationships', 'sections']))) {
            objects.push(parsed);
            index = cursor;
          }
          break;
        }
      }
    }
  }
  return objects;
}

function parsePowerBiJsonArtifact(artifact: MigrationArtifact, json: unknown) {
  const warnings: string[] = [];
  const model = findFirstRecord(json, ['model']) || asRecord(json);
  const tables = findFirstArray(model, ['tables']) || findFirstArray(json, ['tables', 'entities']);
  const relationshipsRaw = findFirstArray(model, ['relationships']) || findFirstArray(json, ['relationships']);
  const views: MigrationView[] = [];
  const metrics: MigrationMeasure[] = [];
  const relationships: MigrationRelationship[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];

  tables.forEach((tableValue) => {
    const table = asRecord(tableValue);
    const name = compact(String(table.name || table.displayName || table.entityName || ''));
    if (!name) return;
    const columns = findFirstArray(table, ['columns', 'fields']) || [];
    const measures = findFirstArray(table, ['measures']) || [];
    const parsedMeasures = measures.map((measureValue) => {
      const measure = asRecord(measureValue);
      return {
        name: compact(String(measure.name || measure.displayName || '')),
        type: 'measure',
        sql: compact(String(measure.expression || measure.dax || '')),
        description: compact(String(measure.description || '')),
        aggregateType: 'DAX',
        sourceArtifact: artifact.name,
      };
    }).filter((measure) => measure.name);
    metrics.push(...parsedMeasures);
    views.push({
      name,
      description: compact(String(table.description || '')),
      sourceArtifact: artifact.name,
      fields: columns.map((columnValue) => {
        const column = asRecord(columnValue);
        return {
          name: compact(String(column.name || column.displayName || '')),
          type: compact(String(column.dataType || column.type || '')),
          description: compact(String(column.description || '')),
          sourceArtifact: artifact.name,
        };
      }).filter((field) => field.name),
      measures: parsedMeasures,
      warnings: [],
    });
  });

  relationshipsRaw.forEach((relationshipValue) => {
    const relationship = asRecord(relationshipValue);
    const from = compact(String(relationship.fromTable || relationship.from_table || relationship.fromColumn || relationship.from || ''));
    const to = compact(String(relationship.toTable || relationship.to_table || relationship.toColumn || relationship.to || ''));
    if (!from || !to) return;
    relationships.push({
      from,
      to,
      relationshipType: compact(String(relationship.cardinality || relationship.crossFilteringBehavior || '')),
      sourceArtifact: artifact.name,
    });
  });

  const reportName = compact(String(asRecord(json).name || asRecord(json).displayName || ''));
  const visualFields = unique(Array.from(JSON.stringify(json).matchAll(/"queryRef"\s*:\s*"([^"]+)"/g)).map((match) => match[1]), 80);
  if (reportName || visualFields.length > 0 || /visual(Container|s)|sections/i.test(JSON.stringify(json))) {
    dashboards.push({
      name: reportName || artifact.name.replace(/\.[^.]+$/, ''),
      fields: visualFields,
      filters: unique(Array.from(JSON.stringify(json).matchAll(/"filter"\s*:\s*"([^"]+)"/g)).map((match) => match[1]), 40),
      sourceArtifact: artifact.name,
    });
  }

  if (views.length === 0 && metrics.length === 0 && dashboards.length === 0) {
    warnings.push(`${artifact.name} is JSON, but OmniKit could not detect Power BI tables, measures, relationships, or report field usage.`);
  }
  warnings.push('Power BI DAX measures are captured as semantic evidence; review measure definitions before converting them to Omni measures.');
  return { views, explores: [] as MigrationExplore[], relationships, dashboards, metrics, warnings };
}

function parsePowerBiTextArtifact(artifact: MigrationArtifact) {
  const warnings: string[] = [];
  const views: MigrationView[] = [];
  const metrics: MigrationMeasure[] = [];
  const tableBlocks = extractIndentedBlocks(artifact.content, 'table');

  tableBlocks.forEach(({ name, block }) => {
    const fields = Array.from(block.matchAll(/\bcolumn\s+["']?([^"'\n=]+)["']?/gi)).map((match) => ({
      name: compact(match[1]),
      sourceArtifact: artifact.name,
    })).filter((field) => field.name);
    const measures = Array.from(block.matchAll(/\bmeasure\s+["']?([^"'\n=]+)["']?\s*=?\s*([^\n]*)/gi)).map((match) => ({
      name: compact(match[1]),
      sql: compact(match[2]),
      aggregateType: 'DAX',
      sourceArtifact: artifact.name,
    })).filter((measure) => measure.name);
    metrics.push(...measures);
    views.push({
      name,
      sourceArtifact: artifact.name,
      fields,
      measures,
      warnings: [],
    });
  });

  if (views.length === 0 && metrics.length === 0) {
    warnings.push(`${artifact.name} did not expose Power BI TMDL table or measure definitions through the lightweight parser.`);
  }
  return { views, explores: [] as MigrationExplore[], relationships: [] as MigrationRelationship[], dashboards: [] as MigrationDashboardEvidence[], metrics, warnings };
}

function parseTableauArtifact(artifact: MigrationArtifact) {
  const content = artifact.content;
  const warnings: string[] = [];
  const fields: MigrationField[] = [];
  const measures: MigrationMeasure[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const relationships: MigrationRelationship[] = [];
  const datasourceNames = unique(Array.from(content.matchAll(/<datasource\b[^>]*(?:caption|name)=["']([^"']+)["']/gi)).map((match) => match[1]), 30);

  Array.from(content.matchAll(/<column\b([^>]*?)\/>|<column\b([^>]*)>([\s\S]*?)<\/column>/gi)).forEach((match) => {
    const attrs = parseXmlAttributes(match[1] || match[2] || '');
    const body = match[3] || '';
    const rawName = cleanTableauName(attrs.caption || attrs.name || '');
    if (!rawName) return;
    const role = (attrs.role || '').toLowerCase();
    const calculation = body.match(/<calculation\b[^>]*formula=["']([^"']+)["']/i)?.[1];
    if (role === 'measure' || calculation) {
      measures.push({
        name: rawName,
        type: attrs.datatype || attrs.type,
        sql: calculation,
        aggregateType: attrs['default-aggregation'],
        sourceArtifact: artifact.name,
      });
    } else {
      fields.push({
        name: rawName,
        type: attrs.datatype || attrs.type,
        sourceArtifact: artifact.name,
      });
    }
  });

  Array.from(content.matchAll(/<relation\b([^>]*)>/gi)).forEach((match) => {
    const attrs = parseXmlAttributes(match[1]);
    if (attrs.join || attrs.type === 'join') {
      relationships.push({
        from: cleanTableauName(attrs.table || attrs.name || 'tableau_relation'),
        to: cleanTableauName(attrs.join || attrs.type || 'joined_relation'),
        joinType: attrs.join,
        sourceArtifact: artifact.name,
      });
    }
  });

  Array.from(content.matchAll(/<dashboard\b[^>]*name=["']([^"']+)["'][\s\S]*?<\/dashboard>/gi)).forEach((match) => {
    dashboards.push({
      name: cleanTableauName(match[1]),
      fields: unique(Array.from(match[0].matchAll(/(?:column|field)=["']([^"']+)["']/gi)).map((fieldMatch) => cleanTableauName(fieldMatch[1])), 80),
      filters: unique(Array.from(match[0].matchAll(/filter[^=]*=["']([^"']+)["']/gi)).map((filterMatch) => cleanTableauName(filterMatch[1])), 40),
      sourceArtifact: artifact.name,
    });
  });

  const views = datasourceNames.length > 0 || fields.length > 0 || measures.length > 0
    ? [{
        name: datasourceNames[0] || artifact.name.replace(/\.[^.]+$/, ''),
        sourceArtifact: artifact.name,
        fields,
        measures,
        warnings: [],
      }]
    : [];

  if (!/<workbook|<datasource|<column/i.test(content)) {
    warnings.push(`${artifact.name} does not look like Tableau TWB/TDS XML. Use unencrypted .twb or .tds text exports for better parsing.`);
  }
  if (views.length === 0 && dashboards.length === 0) {
    warnings.push(`${artifact.name} did not expose Tableau datasource fields or dashboard evidence through the lightweight parser.`);
  }
  warnings.push('Tableau calculated fields are captured as formula evidence; review calculations before converting them to Omni SQL.');
  return { views, explores: [] as MigrationExplore[], relationships, dashboards, metrics: measures, warnings };
}

function parseDomoArtifact(artifact: MigrationArtifact) {
  const parsedJson = tryParseJson(artifact.content);
  if (parsedJson) return parseDomoJsonArtifact(artifact, parsedJson);
  return parseDomoTextArtifact(artifact);
}

function parseDomoJsonArtifact(artifact: MigrationArtifact, json: unknown) {
  const warnings: string[] = [];
  const views: MigrationView[] = [];
  const dashboards: MigrationDashboardEvidence[] = [];
  const metrics: MigrationMeasure[] = [];
  const root = asRecord(json);
  const datasets = findFirstArray(root, ['datasets', 'dataSets', 'schemas']) || (root.columns ? [root] : []);
  datasets.forEach((datasetValue) => {
    const dataset = asRecord(datasetValue);
    const name = compact(String(dataset.name || dataset.title || dataset.id || artifact.name.replace(/\.[^.]+$/, '')));
    const columns = findFirstArray(dataset, ['columns', 'fields', 'schema']) || [];
    views.push({
      name,
      description: compact(String(dataset.description || '')),
      sourceArtifact: artifact.name,
      fields: columns.map((columnValue) => {
        const column = asRecord(columnValue);
        return {
          name: compact(String(column.name || column.columnName || column.field || '')),
          type: compact(String(column.type || column.dataType || '')),
          sourceArtifact: artifact.name,
        };
      }).filter((field) => field.name),
      measures: [],
      warnings: [],
    });
  });

  const beastModes = findFirstArray(root, ['beastModes', 'calculatedFields', 'calculations']) || [];
  beastModes.forEach((measureValue) => {
    const measure = asRecord(measureValue);
    metrics.push({
      name: compact(String(measure.name || measure.title || '')),
      sql: compact(String(measure.formula || measure.expression || '')),
      aggregateType: 'Beast Mode',
      sourceArtifact: artifact.name,
    });
  });

  const cards = findFirstArray(root, ['cards', 'dashboards', 'pages']) || [];
  cards.forEach((cardValue) => {
    const card = asRecord(cardValue);
    dashboards.push({
      name: compact(String(card.name || card.title || card.id || artifact.name.replace(/\.[^.]+$/, ''))),
      fields: unique(JSON.stringify(card).match(/"name"\s*:\s*"([^"]+)"/g)?.map((value) => value.replace(/^"name"\s*:\s*"|"$/g, '')) || [], 80),
      filters: unique(JSON.stringify(card).match(/"filter[^"]*"\s*:\s*"([^"]+)"/g)?.map((value) => value.replace(/^"filter[^"]*"\s*:\s*"|"$/g, '')) || [], 40),
      sourceArtifact: artifact.name,
    });
  });

  if (views.length === 0 && dashboards.length === 0 && metrics.length === 0) {
    warnings.push(`${artifact.name} is JSON, but OmniKit could not detect Domo datasets, cards, dashboards, or Beast Mode calculations.`);
  }
  warnings.push('Domo Beast Mode formulas and card metadata are semantic evidence; validate calculations and dataset grain before generating Omni YAML.');
  return { views, explores: [] as MigrationExplore[], relationships: [] as MigrationRelationship[], dashboards, metrics, warnings };
}

function parseDomoTextArtifact(artifact: MigrationArtifact) {
  const warnings: string[] = [];
  const metrics = Array.from(artifact.content.matchAll(/(?:beast\s*mode|calculated\s*field)\s*:?\s*([^\n=]+)\s*=?\s*([^\n]+)/gi)).map((match) => ({
    name: compact(match[1]),
    sql: compact(match[2]),
    aggregateType: 'Beast Mode',
    sourceArtifact: artifact.name,
  })).filter((measure) => measure.name);
  if (metrics.length === 0) warnings.push(`${artifact.name} did not expose Domo dataset schema, card metadata, or Beast Mode calculations through the lightweight parser.`);
  return {
    views: [] as MigrationView[],
    explores: [] as MigrationExplore[],
    relationships: [] as MigrationRelationship[],
    dashboards: [] as MigrationDashboardEvidence[],
    metrics,
    warnings,
  };
}

function tryParseJson(content: string) {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function findFirstRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    for (const key of keys) {
      if (record[key] && typeof record[key] === 'object' && !Array.isArray(record[key])) return record[key] as Record<string, unknown>;
    }
    Object.values(record).forEach((item) => {
      if (item && typeof item === 'object') queue.push(item);
    });
  }
  return null;
}

function findFirstArray(value: unknown, keys: string[]): unknown[] {
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    Object.values(record).forEach((item) => {
      if (item && typeof item === 'object') queue.push(item);
    });
  }
  return [];
}

function extractIndentedBlocks(content: string, keyword: string) {
  const lines = content.split(/\r?\n/);
  const blocks: Array<{ name: string; block: string }> = [];
  lines.forEach((line, index) => {
    const match = line.trim().match(new RegExp(`^${keyword}\\s+['"]?([^'"]+)['"]?`, 'i'));
    if (!match) return;
    const indent = line.match(/^\s*/)?.[0].length || 0;
    const blockLines: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const currentIndent = lines[cursor].match(/^\s*/)?.[0].length || 0;
      if (lines[cursor].trim() && currentIndent <= indent) break;
      blockLines.push(lines[cursor]);
    }
    blocks.push({ name: compact(match[1]), block: blockLines.join('\n') });
  });
  return blocks;
}

function parseXmlAttributes(value: string) {
  const attrs: Record<string, string> = {};
  Array.from(value.matchAll(/([A-Za-z0-9_-]+)=["']([^"']*)["']/g)).forEach((match) => {
    attrs[match[1]] = match[2];
  });
  return attrs;
}

function cleanTableauName(value: string) {
  return compact(value)
    .replace(/^\[|\]$/g, '')
    .replace(/^Calculation_/, '')
    .replace(/\s+/g, ' ');
}

function matchLookmlParam(block: string, param: string) {
  const match = block.match(new RegExp(`\\b${param}\\s*:\\s*(?:"([^"]*)"|([^\\n]+))`, 'i'));
  return compact((match?.[1] || match?.[2] || '').replace(/;;\s*$/, ''));
}

function extractNamedBlocks(content: string, keyword: string) {
  const blocks: Array<{ name: string; block: string }> = [];
  const regex = new RegExp(`\\b${keyword}\\s*:\\s*([\\w.]+)\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    const name = match[1];
    const blockStart = match.index + match[0].length;
    const blockEnd = findMatchingBrace(content, blockStart - 1);
    if (blockEnd > blockStart) {
      blocks.push({ name, block: content.slice(blockStart, blockEnd) });
      regex.lastIndex = blockEnd;
    }
  }
  return blocks;
}

function findMatchingBrace(content: string, openBraceIndex: number) {
  let depth = 0;
  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitInlineList(value: string) {
  return value
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function mergeViews(views: MigrationView[]) {
  const map = new Map<string, MigrationView>();
  views.forEach((view) => {
    const existing = map.get(view.name);
    if (!existing) {
      map.set(view.name, {
        ...view,
        fields: mergeFields(view.fields),
        measures: mergeMeasures(view.measures),
        warnings: unique(view.warnings),
      });
      return;
    }
    existing.description ||= view.description;
    existing.fields = mergeFields([...existing.fields, ...view.fields]);
    existing.measures = mergeMeasures([...existing.measures, ...view.measures]);
    existing.warnings = unique([...existing.warnings, ...view.warnings]);
  });
  return Array.from(map.values());
}

function mergeFields(fields: MigrationField[]) {
  const map = new Map<string, MigrationField>();
  fields.forEach((field) => {
    if (!field.name) return;
    const existing = map.get(field.name);
    if (!existing) {
      map.set(field.name, field);
      return;
    }
    existing.type ||= field.type;
    existing.sql ||= field.sql;
    existing.description ||= field.description;
  });
  return Array.from(map.values()).slice(0, 100);
}

function mergeMeasures(measures: MigrationMeasure[]) {
  const map = new Map<string, MigrationMeasure>();
  measures.forEach((measure) => {
    if (!measure.name) return;
    const existing = map.get(measure.name);
    if (!existing) {
      map.set(measure.name, measure);
      return;
    }
    existing.type ||= measure.type;
    existing.sql ||= measure.sql;
    existing.description ||= measure.description;
    existing.aggregateType ||= measure.aggregateType;
  });
  return Array.from(map.values()).slice(0, 120);
}

function mergeRelationships(relationships: MigrationRelationship[]) {
  const seen = new Set<string>();
  return relationships.filter((relationship) => {
    const key = `${relationship.from}|${relationship.to}|${relationship.sql || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 120);
}

function mergeExplores(explores: MigrationExplore[]) {
  const map = new Map<string, MigrationExplore>();
  explores.forEach((explore) => {
    const existing = map.get(explore.name);
    if (!existing) {
      map.set(explore.name, {
        ...explore,
        joins: mergeRelationships(explore.joins),
        fields: unique(explore.fields),
        filters: unique(explore.filters),
      });
      return;
    }
    existing.joins = mergeRelationships([...existing.joins, ...explore.joins]);
    existing.fields = unique([...existing.fields, ...explore.fields]);
    existing.filters = unique([...existing.filters, ...explore.filters]);
  });
  return Array.from(map.values());
}

function mergeDashboards(dashboards: MigrationDashboardEvidence[]) {
  const map = new Map<string, MigrationDashboardEvidence>();
  dashboards.forEach((dashboard) => {
    const existing = map.get(dashboard.name);
    if (!existing) {
      map.set(dashboard.name, {
        ...dashboard,
        fields: unique(dashboard.fields),
        filters: unique(dashboard.filters),
      });
      return;
    }
    existing.fields = unique([...existing.fields, ...dashboard.fields]);
    existing.filters = unique([...existing.filters, ...dashboard.filters]);
  });
  return Array.from(map.values());
}
