/** Exact, reviewable physical namespace selection for one shared authored view. */
export interface DashboardPackageBindingNamespace {
  catalog?: string;
  database?: string;
  schema?: string;
}
export interface DashboardPackageBindingMapping {
  sourceFileName: string;
  targetFileName: string;
  source: DashboardPackageBindingNamespace;
  destination: DashboardPackageBindingNamespace;
}
const keys = ['catalog', 'database', 'schema'] as const;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_$-]{0,255}$/.test(value);
const viewPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 512
  && value.endsWith('.view') && !value.endsWith('.query.view') && !value.includes('\\')
  && value.split('/').every(part => !!part && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(part))
  && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function namespace(value: unknown): value is DashboardPackageBindingNamespace {
  return record(value) && Object.entries(value).every(([key, entry]) => keys.includes(key as typeof keys[number]) && identifier(entry))
    && !(value.catalog !== undefined && value.database !== undefined && value.catalog !== value.database);
}
export function isDashboardPackageBindingMapping(value: unknown): value is DashboardPackageBindingMapping {
  return record(value) && Object.keys(value).length === 4
    && Object.keys(value).every(key => ['sourceFileName', 'targetFileName', 'source', 'destination'].includes(key))
    && viewPath(value.sourceFileName) && viewPath(value.targetFileName)
    && namespace(value.source) && namespace(value.destination);
}
/** Stable identity includes absent versus present namespace keys; no case folding. */
export function dashboardPackageBindingKey(mapping: DashboardPackageBindingMapping): string {
  const ordered = (value: DashboardPackageBindingNamespace) => Object.fromEntries(keys
    .filter(key => Object.prototype.hasOwnProperty.call(value, key)).map(key => [key, value[key]]));
  return JSON.stringify({ sourceFileName: mapping.sourceFileName, targetFileName: mapping.targetFileName,
    source: ordered(mapping.source), destination: ordered(mapping.destination) });
}
