import type {
  MigrationDiffLine,
  MigrationFileDiff,
  SemanticMigrationFile,
  SemanticMigrationPackage,
  SemanticYamlFileName,
} from './types';

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isSemanticYamlFileName(fileName: string): fileName is SemanticYamlFileName {
  return fileName === 'model' ||
    fileName === 'relationships' ||
    /^[A-Za-z0-9_./-]+\.topic$/.test(fileName) ||
    /^[A-Za-z0-9_./-]+\.view$/.test(fileName);
}

export function normalizeYamlFileName(fileName: string) {
  return fileName.trim().replace(/^["']|["']$/g, '');
}

export function extractSemanticMigrationPackage(message: string): SemanticMigrationPackage {
  const files: SemanticMigrationFile[] = [];
  const warnings: string[] = [];
  const regex = /Target file:\s*([^\n]+)\s*\n\s*```yaml\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(message))) {
    const fileName = normalizeYamlFileName(match[1]);
    const yaml = match[2].trim();
    if (!isSemanticYamlFileName(fileName)) {
      warnings.push(`Unsupported target file "${fileName}" was ignored. Supported targets are model, relationships, <view>.view, and <topic>.topic.`);
      continue;
    }
    files.push({
      id: makeId('semantic-migration-file'),
      fileName,
      yaml,
      source: 'semantic-migration',
    });
  }

  return { files, rawMessage: message, warnings };
}

export function validateSemanticMigrationFiles(files: SemanticMigrationFile[], mainFiles?: Record<string, string>) {
  const issues: string[] = [];
  const seen = new Set<string>();
  files.forEach((file) => {
    if (seen.has(file.fileName)) issues.push(`${file.fileName} appears more than once. Keep exactly one complete replacement body per target file.`);
    seen.add(file.fileName);
    if (!file.yaml.trim()) issues.push(`${file.fileName} has an empty YAML body.`);
    issues.push(...lintFile(file));
    if (mainFiles) issues.push(...lintTargetPath(file.fileName, mainFiles));
    if (mainFiles?.[file.fileName] && dropsTopLevelBlocks(file.yaml, mainFiles[file.fileName])) {
      issues.push(`${file.fileName} may drop existing top-level blocks from the source YAML. Preserve existing sections unless the migration plan explicitly replaces the whole file.`);
    }
  });
  if (files.length === 0) issues.push('No deployable Omni semantic YAML blocks were captured from Blobby.');
  return issues;
}

function lintTargetPath(fileName: string, mainFiles: Record<string, string>) {
  if (mainFiles[fileName] || fileName === 'model' || fileName === 'relationships' || fileName.includes('/')) return [];
  if (!fileName.endsWith('.view') && !fileName.endsWith('.topic')) return [];

  const matchingExistingPaths = Object.keys(mainFiles).filter((sourceFileName) => sourceFileName.endsWith(`/${fileName}`));
  if (matchingExistingPaths.length === 0) return [];

  return [
    `${fileName} does not match an existing source file path. The model already contains ${matchingExistingPaths.join(', ')}; use the existing path or confirm this is an intentional new file before saving to dev.`,
  ];
}

function lintFile(file: SemanticMigrationFile) {
  const issues: string[] = [];
  const yaml = file.yaml;
  const fileName = file.fileName;
  if (!isSemanticYamlFileName(fileName)) {
    issues.push(`${fileName} is not a supported Omni semantic file name.`);
  }
  if (/\b(api[_-]?key|authorization|token|secret|password)\b/i.test(yaml)) {
    issues.push(`${fileName} appears to include credential-like text. Remove secrets before saving to dev.`);
  }
  const unsafeDescriptions = unquotedDescriptionLinesWithColon(yaml);
  if (unsafeDescriptions.length > 0) {
    issues.push(`${fileName} has unquoted description text containing ": " on line${unsafeDescriptions.length === 1 ? '' : 's'} ${unsafeDescriptions.join(', ')}. Quote the value or use a YAML block scalar so Omni receives description as a string.`);
  }
  if (fileName === 'model') {
    if (/^(\s*)(base_view|joins|dimensions|measures|ai_context|sample_queries|query|sql):/m.test(yaml)) {
      issues.push('model contains topic/view/query-only keys. Keep model-wide settings in the model file only.');
    }
  } else if (fileName === 'relationships') {
    if (/^\s*relationships\s*:/m.test(yaml)) {
      issues.push('relationships must be a top-level YAML list, not wrapped in a relationships: key.');
    }
    if (yaml.trim() && !yaml.trimStart().startsWith('-')) {
      issues.push('relationships should start with a YAML list item.');
    }
  } else if (fileName.endsWith('.topic')) {
    if (/^\s*(topics|name|dimensions|measures|sql|query)\s*:/m.test(yaml)) {
      issues.push(`${fileName} contains keys that do not belong in an Omni topic file.`);
    }
    if (/^default_filters\s*:\s*\n\s*-/m.test(yaml)) {
      issues.push(`${fileName} uses list-style default_filters, but Omni topic default_filters must be a field-keyed map. Preserve an existing known-good filter map or keep the filter guidance in ai_context/assumptions.`);
    }
    const sensitiveTopicFields = topicFieldSelectors(yaml).filter(isSensitiveSelector);
    if (sensitiveTopicFields.length > 0) {
      issues.push(`${fileName} includes sensitive fields in topic field curation (${sensitiveTopicFields.join(', ')}). Keep PII/contact/granular location fields out of fields/ai_fields unless explicit governed exposure is confirmed.`);
    }
    const aiContextIndex = yaml.search(/^ai_context\s*:/m);
    if (aiContextIndex >= 0) {
      const afterAiContext = yaml.slice(aiContextIndex).split(/\r?\n/).slice(1);
      const laterTopLevelKey = afterAiContext.find((line) => /^[A-Za-z0-9_-]+\s*:/.test(line));
      if (laterTopLevelKey) issues.push(`${fileName} has top-level YAML after ai_context. Put ai_context last.`);
    }
  } else if (fileName.endsWith('.view')) {
    if (/^(base_view|ai_fields|sample_queries|joins|topics)\s*:/m.test(yaml)) {
      issues.push(`${fileName} contains topic-only keys. Keep topics separate from view files.`);
    }
  }
  return issues;
}

function unquotedDescriptionLinesWithColon(yaml: string) {
  const lineNumbers: number[] = [];
  yaml.split(/\r?\n/).forEach((line, index) => {
    const match = /^(\s*)description:\s+(.+)$/.exec(line);
    if (!match) return;
    const value = match[2].trim();
    if (!value || value === '|' || value === '|-' || value === '>' || value === '>-' || value.startsWith('"') || value.startsWith("'")) return;
    if (value.includes(': ')) lineNumbers.push(index + 1);
  });
  return lineNumbers;
}

function topicFieldSelectors(yaml: string) {
  const selectors: string[] = [];
  let inFieldBlock = false;
  yaml.split(/\r?\n/).forEach((line) => {
    if (/^(fields|ai_fields)\s*:/.test(line)) {
      inFieldBlock = true;
      return;
    }
    if (inFieldBlock && /^[A-Za-z0-9_-]+\s*:/.test(line)) {
      inFieldBlock = false;
    }
    if (!inFieldBlock) return;
    const match = /^\s*-\s*["']?([^"',\]\s]+)["']?/.exec(line);
    if (match) selectors.push(match[1]);
  });
  return selectors;
}

function isSensitiveSelector(selector: string) {
  const field = selector.split('.').pop() || selector;
  return /(^|_)(email|full_?name|first_?name|last_?name|phone|address|zip|postal|latitude|longitude|lat|lon|birth|dob|ip)(_|$)/i.test(field);
}

function topLevelKeys(yaml: string) {
  return Array.from(yaml.matchAll(/^([A-Za-z0-9_-]+)\s*:/gm)).map((match) => match[1]);
}

function dropsTopLevelBlocks(nextYaml: string, sourceYaml: string) {
  const sourceKeys = topLevelKeys(sourceYaml).filter((key) => key !== 'access_grants');
  if (sourceKeys.length === 0) return false;
  const nextKeys = new Set(topLevelKeys(nextYaml));
  const dropped = sourceKeys.filter((key) => !nextKeys.has(key));
  return dropped.length > 0 && dropped.length >= Math.max(2, Math.ceil(sourceKeys.length / 2));
}

export function buildMigrationDiffs(mainFiles: Record<string, string> | undefined, branchFiles: Record<string, string> | undefined, savedFiles: SemanticMigrationFile[]): MigrationFileDiff[] {
  return savedFiles.map((file) => {
    const before = mainFiles?.[file.fileName] || '';
    const after = branchFiles?.[file.fileName] || file.yaml;
    return {
      fileName: file.fileName,
      lines: simpleLineDiff(before, after),
    };
  });
}

function simpleLineDiff(before: string, after: string): MigrationDiffLine[] {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines: MigrationDiffLine[] = [];
  for (let index = 0; index < max; index += 1) {
    const prev = beforeLines[index];
    const next = afterLines[index];
    if (prev === next) {
      if (next !== undefined) lines.push({ type: 'unchanged', text: next });
      continue;
    }
    if (prev !== undefined) lines.push({ type: 'removed', text: prev });
    if (next !== undefined) lines.push({ type: 'added', text: next });
  }
  return lines;
}
