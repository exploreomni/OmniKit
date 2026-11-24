import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, visit, type Pair, type Schema, type YAMLMap } from 'yaml';
import type { OmniModelYamlResponse } from './omniApi';

const deploymentYamlOptions = { schema: 'failsafe', prettyErrors: false } as const;

function flowFieldNames(value: string): string[] | undefined {
  const parsed = parseDocument('[' + value + ']', deploymentYamlOptions);
  const fields = parsed.contents;
  if (!parsed.errors.length && !parsed.warnings.length && isSeq(fields)) {
    const names: string[] = [];
    for (const item of fields.items) {
      if (!isScalar(item) || typeof item.value !== 'string' || item.anchor || item.tag || item.comment) return undefined;
      names.push(item.value);
    }
    return names;
  }

  // Bare Omni wildcards and timeframes can be valid field references but invalid YAML flow scalars.
  const token = /[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[\w.*:-]+(?:\[[\w.-]+\])?)[ \t]*(,|$)/y;
  const names: string[] = [];
  while (token.lastIndex < value.length) {
    const match = token.exec(value);
    if (!match) return undefined;
    const item = match[1];
    if (item.startsWith('"') || item.startsWith("'")) {
      const scalar = parseDocument(item, deploymentYamlOptions);
      if (scalar.errors.length || scalar.warnings.length || !isScalar(scalar.contents)
        || typeof scalar.contents.value !== 'string') return undefined;
      names.push(scalar.contents.value);
    } else if (item.startsWith('*') && item !== '*') {
      return undefined;
    } else {
      names.push(item);
    }
  }
  return names;
}

/** Preserve unrelated bytes and only normalize actual fields/sorts keys in an authored topic. */
export function normalizeTopicYamlForDeploy(yaml: string): string {
  if (!/^[ \t]*(?:fields|sorts):[ \t]*\[/m.test(yaml)) return yaml;
  const lineCounter = new LineCounter();
  const document = parseDocument(yaml, { ...deploymentYamlOptions, lineCounter });
  const lines = yaml.split('\n');
  visit(document, {
    Pair(_key, pair) {
      if (!isScalar(pair.key) || !pair.key.range || !['fields', 'sorts'].includes(String(pair.key.value))) return;
      const index = lineCounter.linePos(pair.key.range[0]).line - 1;
      const line = lines[index];
      const fields = line.match(/^(\s*fields:\s*)\[(.*)\](\s*)$/);
      if (fields) {
        const names = flowFieldNames(fields[2]);
        if (names) lines[index] = fields[1] + '[' + names.map(name => JSON.stringify(name)).join(', ') + ']' + fields[3];
        return;
      }
      const sort = line.match(/^(\s*)sorts:\s*\[\{\s*column_name:\s*(.+),\s*sort_descending:\s*(true|false)\s*\}\](\s*)$/i);
      if (sort) {
        const parsed = parseDocument(sort[2].trim(), deploymentYamlOptions);
        const field = parsed.contents;
        if (parsed.errors.length || parsed.warnings.length || !isScalar(field) || typeof field.value !== 'string'
          || field.tag || field.anchor || field.comment || field.type === 'PLAIN' && /[,{}]/.test(field.value)) return;
        const indent = sort[1];
        lines[index] = [
          indent + 'sorts:',
          indent + '  - field: ' + JSON.stringify(field.value),
          indent + '    desc: ' + sort[3].toLowerCase() + sort[4],
        ].join('\n');
      }
    },
  });
  return lines.join('\n');
}

export interface PreservedTopicYaml {
  yaml: string;
  restoredTopLevelKeys: string[];
  restoredPaths: string[];
}

interface TopLevelBlock {
  key: string;
  text: string;
}

export interface AuthoredTopicYamlFile {
  fileName: `${string}.topic`;
  yaml: string;
}

export interface StagedTopicYamlVerification {
  matches: boolean;
  normalized: boolean;
  reason?: string;
}

export interface StagedTopicYamlVerificationOptions {
  topicName?: string;
}

export function normalizeTopicName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function authoredTopicYamlFiles(
  modelYaml: Pick<OmniModelYamlResponse, 'files'> | null | undefined,
  topicName: string | undefined,
): AuthoredTopicYamlFile[] {
  const normalizedTopicName = normalizeTopicName(topicName || '');
  if (!normalizedTopicName || !modelYaml?.files) return [];
  return Object.entries(modelYaml.files).flatMap(([fileName, yaml]) => {
    if (!fileName.endsWith('.topic') || typeof yaml !== 'string') return [];
    const leaf = fileName.split('/').at(-1)?.replace(/\.topic$/i, '') || '';
    return normalizeTopicName(leaf) === normalizedTopicName
      ? [{ fileName: fileName as `${string}.topic`, yaml }]
      : [];
  });
}

/**
 * Resolve the exact authored file path, including nested folders. Fail closed
 * when no file or multiple normalized matches exist.
 */
export function findAuthoredTopicYamlFile(
  modelYaml: Pick<OmniModelYamlResponse, 'files'> | null | undefined,
  topicName: string | undefined,
): AuthoredTopicYamlFile | null {
  const matches = authoredTopicYamlFiles(modelYaml, topicName);
  if (matches.length !== 1) return null;
  return matches[0];
}

function parseTopicDocument(yaml: string, label: string) {
  const document = parseDocument(yaml, {
    prettyErrors: false,
    strict: false,
    uniqueKeys: false,
  });
  if (document.errors.length > 0) {
    throw new Error(`${label} topic YAML is invalid: ${document.errors.map((error) => error.message).join(' ')}`);
  }
  if (!isMap(document.contents)) {
    throw new Error(`${label} topic YAML must be a top-level mapping.`);
  }
  return document;
}

function parseComparableTopicDocument(yaml: string, label: string) {
  const document = parseDocument(yaml, {
    prettyErrors: false,
    strict: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`${label} topic YAML is invalid: ${document.errors.map((error) => error.message).join(' ')}`);
  }
  if (!isMap(document.contents)) {
    throw new Error(`${label} topic YAML must be a top-level mapping.`);
  }
  return document;
}

function comparableRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isEmptyRecord(value: unknown): boolean {
  const row = comparableRecord(value);
  return Boolean(row) && Object.keys(row as Record<string, unknown>).length === 0;
}

function compareTopicValue(
  intended: unknown,
  staged: unknown,
  path: string[],
  options: StagedTopicYamlVerificationOptions,
): string | null {
  if (Array.isArray(intended)) {
    if (!Array.isArray(staged) || staged.length !== intended.length) {
      return `${path.join('.') || 'topic'} changed list length or type`;
    }
    for (let index = 0; index < intended.length; index += 1) {
      const mismatch = compareTopicValue(intended[index], staged[index], [...path, String(index)], options);
      if (mismatch) return mismatch;
    }
    return null;
  }

  const intendedRecord = comparableRecord(intended);
  if (intendedRecord) {
    const stagedRecord = comparableRecord(staged);
    if (!stagedRecord) return `${path.join('.') || 'topic'} changed mapping type`;
    for (const [key, value] of Object.entries(intendedRecord)) {
      if (!Object.prototype.hasOwnProperty.call(stagedRecord, key)) {
        const isDefaultAscendingSort = key === 'desc'
          && value === false
          && path.length >= 2
          && path[path.length - 2] === 'sorts'
          && /^\d+$/.test(path[path.length - 1]);
        if (isDefaultAscendingSort) continue;
        return `${[...path, key].join('.')} is missing`;
      }
      const mismatch = compareTopicValue(value, stagedRecord[key], [...path, key], options);
      if (mismatch) return mismatch;
    }
    for (const [key, value] of Object.entries(stagedRecord)) {
      if (Object.prototype.hasOwnProperty.call(intendedRecord, key)) continue;
      if (path.length === 0 && key === 'joins') {
        const joins = comparableRecord(value);
        if (!joins) return 'joins was added with an unexpected type';
        const configuredJoin = Object.entries(joins).find(([, join]) => !isEmptyRecord(join));
        if (configuredJoin) return `joins.${configuredJoin[0]} was added unexpectedly`;
        continue;
      }
      const isOmniJoinNormalization = path.length === 1
        && path[0] === 'joins'
        && isEmptyRecord(value);
      const isOmniSampleQueryTopicNormalization = key === 'topic'
        && path.length === 3
        && path[0] === 'sample_queries'
        && path[2] === 'query'
        && typeof value === 'string'
        && Boolean(options.topicName)
        && normalizeTopicName(value) === normalizeTopicName(options.topicName || '');
      if (!isOmniJoinNormalization && !isOmniSampleQueryTopicNormalization) {
        return `${[...path, key].join('.')} was added unexpectedly`;
      }
    }
    return null;
  }

  return Object.is(intended, staged)
    ? null
    : `${path.join('.') || 'topic'} changed value`;
}

function collectYamlComments(document: ReturnType<typeof parseDocument>): string[] {
  const comments: string[] = [];
  const addComments = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const commentBefore = 'commentBefore' in value ? (value as { commentBefore?: unknown }).commentBefore : undefined;
    const comment = 'comment' in value ? (value as { comment?: unknown }).comment : undefined;
    for (const candidate of [commentBefore, comment]) {
      if (typeof candidate !== 'string') continue;
      comments.push(...candidate.split('\n').map((line) => line.trim()).filter(Boolean));
    }
  };
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    addComments(value);
    if (isMap(value)) {
      for (const pair of value.items) {
        walk(pair.key);
        walk(pair.value);
      }
    } else if (isSeq(value)) {
      for (const item of value.items) walk(item);
    }
  };
  addComments(document);
  walk(document.contents);
  return comments;
}

function missingComments(intended: string[], staged: string[]): string[] {
  const available = new Map<string, number>();
  for (const comment of staged) available.set(comment, (available.get(comment) || 0) + 1);
  return intended.filter((comment) => {
    const count = available.get(comment) || 0;
    if (count < 1) return true;
    available.set(comment, count - 1);
    return false;
  });
}

/**
 * Omni may return a canonicalized combined topic after a branch write. Accept
 * formatting changes and empty join declarations only when all authored values
 * and comments survive. Any other semantic addition, deletion, or change fails
 * closed so the reviewer never advances on an unverified branch payload.
 */
export function verifyStagedTopicYaml(
  intendedYaml: string,
  stagedYaml: string,
  options: StagedTopicYamlVerificationOptions = {},
): StagedTopicYamlVerification {
  if (intendedYaml === stagedYaml) return { matches: true, normalized: false };
  try {
    const intendedDocument = parseComparableTopicDocument(intendedYaml, 'Intended');
    const stagedDocument = parseComparableTopicDocument(stagedYaml, 'Staged');
    const intended = intendedDocument.toJS({ maxAliasCount: 100 });
    const staged = stagedDocument.toJS({ maxAliasCount: 100 });
    const mismatch = compareTopicValue(intended, staged, [], options);
    if (mismatch) return { matches: false, normalized: true, reason: mismatch };
    const omittedComments = missingComments(
      collectYamlComments(intendedDocument),
      collectYamlComments(stagedDocument),
    );
    if (omittedComments.length > 0) {
      return { matches: false, normalized: true, reason: 'authored comments were omitted' };
    }
    return { matches: true, normalized: true };
  } catch (error) {
    return {
      matches: false,
      normalized: true,
      reason: error instanceof Error ? error.message : 'staged topic YAML could not be verified',
    };
  }
}

/**
 * Existing topic files can contain source-authored inline relationships that
 * OmniKit must preserve during an additive update. Allow that legacy shape
 * only when the complete relationship value is structurally unchanged.
 */
export function hasUnchangedAuthoredTopicRelationships(
  sourceYaml: string,
  candidateYaml: string,
): boolean {
  try {
    const sourceDocument = parseComparableTopicDocument(sourceYaml, 'Source');
    const candidateDocument = parseComparableTopicDocument(candidateYaml, 'Candidate');
    const source = comparableRecord(sourceDocument.toJS({ maxAliasCount: 100 }));
    const candidate = comparableRecord(candidateDocument.toJS({ maxAliasCount: 100 }));
    if (!source || !candidate) return false;
    if (!Object.prototype.hasOwnProperty.call(source, 'relationships')) return false;
    if (!Object.prototype.hasOwnProperty.call(candidate, 'relationships')) return false;
    return compareTopicValue(
      source.relationships,
      candidate.relationships,
      ['relationships'],
      {},
    ) === null;
  } catch {
    return false;
  }
}

function scalarKey(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const scalar = (value as { value?: unknown }).value;
    return typeof scalar === 'string' ? scalar : String(scalar ?? '');
  }
  return String(value ?? '');
}

function documentKeys(yaml: string, label: string): string[] {
  const document = parseTopicDocument(yaml, label);
  if (!isMap(document.contents)) return [];
  return document.contents.items
    .map((pair) => scalarKey(pair.key).trim())
    .filter(Boolean);
}

function topLevelBlocks(yaml: string): TopLevelBlock[] {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n');
  const starts: Array<{ key: string; index: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z_][\w-]*):(?:\s|$)/);
    if (match) starts.push({ key: match[1], index });
  }

  return starts.map((entry, position) => ({
    key: entry.key,
    text: lines
      .slice(entry.index, starts[position + 1]?.index ?? lines.length)
      .join('\n')
      .trimEnd(),
  }));
}

function insertBeforeAiContext(candidateYaml: string, blocks: TopLevelBlock[]): string {
  if (blocks.length === 0) return candidateYaml.trimEnd();
  const lines = candidateYaml.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const aiContextIndex = lines.findIndex((line) => /^ai_context:(?:\s|$)/.test(line));
  const insertion = blocks.flatMap((block, index) => (
    index === blocks.length - 1 ? block.text.split('\n') : [...block.text.split('\n'), '']
  ));

  if (aiContextIndex < 0) {
    return [...lines, '', ...insertion].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }
  return [
    ...lines.slice(0, aiContextIndex),
    ...insertion,
    '',
    ...lines.slice(aiContextIndex),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function pairKey(pair: Pair): string {
  return scalarKey(pair.key).trim();
}

function restoreNodeMetadata(source: unknown, candidate: unknown): boolean {
  if (!isNode(source) || !isNode(candidate)) return false;
  let restored = false;
  if (!candidate.commentBefore && source.commentBefore) {
    candidate.commentBefore = source.commentBefore;
    restored = true;
  }
  if (!candidate.comment && source.comment) {
    candidate.comment = source.comment;
    restored = true;
  }
  if (!candidate.spaceBefore && source.spaceBefore) {
    candidate.spaceBefore = true;
    restored = true;
  }
  return restored;
}

function restoreMissingMapEntries(
  source: YAMLMap,
  candidate: YAMLMap,
  schema: Schema,
  path: string[],
  restoredPaths: string[],
): boolean {
  let restoredMetadata = false;
  for (const sourcePair of source.items) {
    const key = pairKey(sourcePair);
    if (!key) continue;
    const candidatePair = candidate.items.find((pair) => pairKey(pair) === key);
    const nextPath = [...path, key];
    if (!candidatePair) {
      candidate.items.push(sourcePair.clone(schema));
      restoredPaths.push(nextPath.join('.'));
      continue;
    }

    restoredMetadata = restoreNodeMetadata(sourcePair.key, candidatePair.key) || restoredMetadata;
    restoredMetadata = restoreNodeMetadata(sourcePair.value, candidatePair.value) || restoredMetadata;
    if (isMap(sourcePair.value) && isMap(candidatePair.value)) {
      restoredMetadata = restoreMissingMapEntries(
        sourcePair.value,
        candidatePair.value,
        schema,
        nextPath,
        restoredPaths,
      ) || restoredMetadata;
    }
  }
  return restoredMetadata;
}

/**
 * Topic YAML writes replace an entire file. Preserve exact source blocks that a
 * generated candidate omitted so an additive edit cannot silently erase authored
 * settings, permissions, filters, or future Omni keys.
 */
export function preserveExistingTopicYaml(sourceYaml: string, candidateYaml: string): PreservedTopicYaml {
  const sourceDocument = parseTopicDocument(sourceYaml, 'Source');
  const originalCandidateDocument = parseTopicDocument(candidateYaml, 'Candidate');
  if (!isMap(sourceDocument.contents) || !isMap(originalCandidateDocument.contents)) {
    throw new Error('Source and candidate topic YAML must be top-level mappings.');
  }

  const sourceKeys = documentKeys(sourceYaml, 'Source');
  const candidateKeys = new Set(documentKeys(candidateYaml, 'Candidate'));
  const sourceBlocks = new Map(topLevelBlocks(sourceYaml).map((block) => [block.key, block]));
  const restoredTopLevelKeys = sourceKeys.filter((key) => !candidateKeys.has(key));
  const missingBlocks = restoredTopLevelKeys.map((key) => sourceBlocks.get(key)).filter((block): block is TopLevelBlock => Boolean(block));
  if (missingBlocks.length !== restoredTopLevelKeys.length) {
    const unavailable = restoredTopLevelKeys.filter((key) => !sourceBlocks.has(key));
    throw new Error(`OmniKit could not preserve source topic section${unavailable.length === 1 ? '' : 's'}: ${unavailable.join(', ')}.`);
  }

  const candidateWithTopLevelRestorations = insertBeforeAiContext(candidateYaml, missingBlocks);
  const candidateDocument = parseTopicDocument(candidateWithTopLevelRestorations, 'Candidate');
  if (!isMap(candidateDocument.contents)) {
    throw new Error('Candidate topic YAML must be a top-level mapping.');
  }
  const restoredPaths: string[] = [...restoredTopLevelKeys];
  const restoredMetadata = restoreMissingMapEntries(
    sourceDocument.contents,
    candidateDocument.contents,
    candidateDocument.schema,
    [],
    restoredPaths,
  );
  if (!candidateDocument.commentBefore && sourceDocument.commentBefore) {
    candidateDocument.commentBefore = sourceDocument.commentBefore;
  }
  if (!candidateDocument.comment && sourceDocument.comment) {
    candidateDocument.comment = sourceDocument.comment;
  }

  const nestedRestorations = restoredPaths.filter((path) => path.includes('.'));
  const documentMetadataRestored = Boolean(
    (!originalCandidateDocument.commentBefore && sourceDocument.commentBefore)
    || (!originalCandidateDocument.comment && sourceDocument.comment)
  );
  const yaml = nestedRestorations.length > 0 || restoredMetadata || documentMetadataRestored
    ? candidateDocument.toString().trimEnd()
    : candidateWithTopLevelRestorations;
  parseTopicDocument(yaml, 'Preserved candidate');
  return { yaml, restoredTopLevelKeys, restoredPaths };
}
