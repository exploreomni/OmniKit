import { isMap, parseDocument } from 'yaml';

function basename(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The GET API accepts a filename regex. Include all locations that could share the POST identity. */
export function modelYamlReadPattern(file: string): string {
  if (!file.endsWith('.topic')) return '^' + escapeRegex(file) + '$';
  const name = basename(file);
  if (/[^\x20-\x7e]/.test(name)) return '\\.topic$';
  const caseInsensitiveName = escapeRegex(name).replace(/[a-z]/gi, letter => '[' + letter.toLowerCase() + letter.toUpperCase() + ']');
  return '(?:^|/)' + caseInsensitiveName + '$';
}

export function assertUniqueTopicExportKey(file: string, files: Readonly<Record<string, unknown>>): void {
  if (!file.endsWith('.topic')) return;
  const name = basename(file).toLowerCase();
  if (Object.keys(files).some(key => key !== file && basename(key).toLowerCase() === name)) {
    throw new Error('Another model file uses the same topic name. Resolve the group or case difference in Omni before migrating.');
  }
}

function topicGroupDocument(file: string, yaml: string) {
  const parts = file.split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || basename(file) === '.topic'
    || file.length > 512 || file.includes('\\') || [...file].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    throw new Error('The exported topic path is unsafe.');
  }
  if (yaml.length > 2_000_000) throw new Error('Topic YAML exceeds the review limit.');
  const document = parseDocument(yaml, { uniqueKeys: true, strict: true, prettyErrors: false, intAsBigInt: true });
  if (!isMap(document.contents) || document.errors.length || document.warnings.length) {
    throw new Error('Topic group placement requires a valid YAML mapping.');
  }
  const group = parts.slice(0, -1).join('/');
  if (document.has('group_label') && document.get('group_label') !== group) {
    throw new Error('The exported topic folder and its authored group_label disagree. Resolve the grouping in Omni before migrating.');
  }
  return { group, document };
}

/** Omni constructs its topic export key from group_label and topic name. Persist inherited placement in the reviewed YAML. */
export function prepareTopicGroupYaml(file: string, yaml: string): string {
  const { group, document } = topicGroupDocument(file, yaml);
  if (!group || document.has('group_label')) return yaml;
  const map = document.contents!;
  if (!map.range || !isMap(map)) throw new Error('The topic grouping could not be added to the reviewed YAML.');
  const [start, end] = map.range;
  const entry = 'group_label: ' + JSON.stringify(group);
  if (map.flow) {
    // Keep every source token, including comments and the exact spelling of numeric literals.
    return yaml.slice(0, start + 1) + entry + (map.items.length ? ', ' : '') + yaml.slice(start + 1);
  }
  const newline = yaml.includes('\r\n') ? '\r\n' : '\n';
  const indent = ' '.repeat(start - yaml.lastIndexOf('\n', start - 1) - 1);
  return yaml.slice(0, end) + (yaml[end - 1] === '\n' ? '' : newline) + indent + entry + newline + yaml.slice(end);
}

export function topicYamlWriteFileName(file: string, yaml: string): string {
  if (!file.endsWith('.topic')) return file;
  const { group, document } = topicGroupDocument(file, yaml);
  if (group && !document.has('group_label')) {
    throw new Error('The approved topic YAML needs an explicit group_label to preserve its exported folder. Prepare a fresh migration review.');
  }
  return basename(file);
}
