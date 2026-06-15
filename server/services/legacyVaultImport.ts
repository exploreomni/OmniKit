import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateBaseUrl } from '../security';
import {
  decryptVaultBlob,
  listInstances,
  upsertInstance,
  type InstanceMetricFilter,
  type InstanceRole,
  type PostMigrationAction,
} from './nativeVault';

const MAX_LEGACY_VAULT_BYTES = 1024 * 1024;
const PRIVATE_HOST_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1$|fc00:|fd[0-9a-f]{2}:)/i;
const LOOPBACK_NAMES = new Set(['localhost', '0.0.0.0']);

export interface LegacyVaultImportOptions {
  path: string;
  passphrase: string;
  dryRun?: boolean;
  confirmAbsolutePath?: boolean;
}

export interface LegacyVaultImportResult {
  dryRun: boolean;
  imported: number;
  wouldImport: number;
  skipped: Array<{ label: string; reason: string }>;
  warnings: string[];
}

interface LegacyInstance {
  id?: unknown;
  label?: unknown;
  role?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  userId?: unknown;
  modelId?: unknown;
  folderId?: unknown;
  folderPath?: unknown;
  postMigrationActions?: unknown;
  dashboardTabs?: unknown;
  dashboardEnabled?: unknown;
  dashboardFilter?: unknown;
  entityGroupSeparator?: unknown;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

function validateImportPath(rawPath: string, confirmAbsolutePath = false): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw Object.assign(new Error('Legacy vault path is required.'), { statusCode: 400 });
  if (trimmed.includes('\0')) throw Object.assign(new Error('Legacy vault path is invalid.'), { statusCode: 400 });
  if (!trimmed.endsWith('.enc')) throw Object.assign(new Error('Legacy vault path must point to a .enc file.'), { statusCode: 400 });

  if (path.isAbsolute(trimmed)) {
    if (!confirmAbsolutePath) {
      throw Object.assign(new Error('Confirm absolute-path import before reading this legacy vault file.'), { statusCode: 400 });
    }
    return path.resolve(trimmed);
  }

  const normalized = path.normalize(trimmed);
  if (normalized.startsWith('..') || normalized.includes(`${path.sep}..${path.sep}`)) {
    throw Object.assign(new Error('Relative legacy vault paths must stay inside the OmniKit workspace.'), { statusCode: 400 });
  }
  return path.resolve(process.cwd(), normalized);
}

function parseLegacyRole(value: unknown): InstanceRole {
  if (value === 'source' || value === 'destination') return value;
  if (value === 'both') return 'both';
  return 'destination';
}

function legacyMetricFilter(raw: unknown): InstanceMetricFilter {
  const filter = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    connectionDatabaseContains: cleanList(filter.databaseContains),
    connectionDatabaseExact: cleanList(filter.databaseExact),
    embedExternalIdContains: cleanList(filter.externalIdContains),
    embedExternalIdExact: cleanList(filter.externalIdExact),
  };
}

function parseMethod(value: unknown): PostMigrationAction['method'] {
  const method = typeof value === 'string' ? value.toUpperCase() : 'POST';
  if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return method;
  return 'POST';
}

function validateActionUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'URL is invalid.';
  }
  if (parsed.protocol !== 'https:') return 'URL must use HTTPS.';
  const host = parsed.hostname.toLowerCase();
  if (LOOPBACK_NAMES.has(host) || PRIVATE_HOST_RE.test(host)) return 'Private-network URLs are blocked.';
  const allowlist = (process.env.OMNIKIT_POST_ACTION_ALLOWLIST || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length > 0 && !allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    return `Host is not allowlisted: ${host}.`;
  }
  return null;
}

function mapLegacyActions(label: string, value: unknown, warnings: string[]): PostMigrationAction[] {
  if (!Array.isArray(value)) return [];
  const actions: PostMigrationAction[] = [];
  value.forEach((raw, index) => {
    const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const url = cleanString(row.url);
    if (!url) return;
    const urlError = validateActionUrl(url);
    const name = cleanString(row.name) || `Post-migration action ${index + 1}`;
    if (urlError) {
      warnings.push(`${label}: skipped post-migration action "${name}" because ${urlError}`);
      return;
    }
    actions.push({
      kind: 'webhook',
      name,
      method: parseMethod(row.method),
      url,
      headers: row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)
        ? Object.fromEntries(Object.entries(row.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      body: typeof row.body === 'string' ? row.body : '',
    });
  });
  return actions;
}

function parseLegacyVault(json: string): LegacyInstance[] {
  const parsed = JSON.parse(json) as { version?: unknown; instances?: unknown };
  if (parsed.version !== 1) throw Object.assign(new Error(`Unsupported legacy vault version: ${String(parsed.version)}`), { statusCode: 400 });
  if (!Array.isArray(parsed.instances)) throw Object.assign(new Error('Legacy vault does not contain an instances array.'), { statusCode: 400 });
  return parsed.instances.filter((row): row is LegacyInstance => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
}

export function importLegacyVault(options: LegacyVaultImportOptions): LegacyVaultImportResult {
  const existingBaseUrls = new Set(listInstances().map((instance) => normalizeBaseUrl(instance.baseUrl)));
  const filePath = validateImportPath(options.path, options.confirmAbsolutePath);
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    throw Object.assign(new Error('Legacy vault file was not found or could not be read.'), { statusCode: 400 });
  }
  if (!stats.isFile()) throw Object.assign(new Error('Legacy vault path must be a regular file.'), { statusCode: 400 });
  if (stats.size <= 0 || stats.size > MAX_LEGACY_VAULT_BYTES) {
    throw Object.assign(new Error('Legacy vault file must be greater than 0 bytes and smaller than 1 MB.'), { statusCode: 400 });
  }

  let legacyInstances: LegacyInstance[];
  try {
    const json = decryptVaultBlob(options.passphrase, readFileSync(filePath));
    legacyInstances = parseLegacyVault(json);
  } catch (err) {
    if (err && typeof err === 'object' && 'statusCode' in err) throw err;
    throw Object.assign(new Error('Could not decrypt or parse the legacy vault. Check the file and passphrase.'), {
      statusCode: 400,
    });
  }

  const skipped: LegacyVaultImportResult['skipped'] = [];
  const warnings: string[] = [];
  let imported = 0;
  let wouldImport = 0;

  for (const legacy of legacyInstances) {
    const label = cleanString(legacy.label) || cleanString(legacy.baseUrl) || 'Unnamed legacy instance';
    const baseUrl = cleanString(legacy.baseUrl);
    const apiKey = cleanString(legacy.apiKey);
    if (!baseUrl) {
      skipped.push({ label, reason: 'Missing base URL.' });
      continue;
    }
    if (!apiKey) {
      skipped.push({ label, reason: 'Missing API key.' });
      continue;
    }
    const urlError = validateBaseUrl(baseUrl);
    if (urlError) {
      skipped.push({ label, reason: urlError });
      continue;
    }
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (existingBaseUrls.has(normalizedBaseUrl)) {
      skipped.push({ label, reason: 'An OmniKit saved instance with this base URL already exists.' });
      continue;
    }

    const postMigrationActions = mapLegacyActions(label, legacy.postMigrationActions, warnings);
    if (legacy.userId) warnings.push(`${label}: legacy userId was dropped because OmniKit does not use it.`);
    if (legacy.dashboardTabs || legacy.dashboardEnabled !== undefined) {
      warnings.push(`${label}: legacy dashboard tab settings were dropped because OmniKit uses Instance Manager tabs.`);
    }

    wouldImport += 1;
    existingBaseUrls.add(normalizedBaseUrl);
    if (options.dryRun) continue;

    upsertInstance({
      label,
      role: parseLegacyRole(legacy.role),
      baseUrl,
      apiKey,
      defaultModelId: cleanString(legacy.modelId),
      defaultFolderId: cleanString(legacy.folderId),
      defaultFolderPath: cleanString(legacy.folderPath),
      entityGroupSeparator: typeof legacy.entityGroupSeparator === 'string' ? legacy.entityGroupSeparator : undefined,
      metricFilter: legacyMetricFilter(legacy.dashboardFilter),
      postMigrationActions,
    });
    imported += 1;
  }

  return {
    dryRun: Boolean(options.dryRun),
    imported,
    wouldImport,
    skipped,
    warnings,
  };
}
