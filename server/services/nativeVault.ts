import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const VAULT_VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const DEFAULT_VAULT_PATH = './data/vault.enc';
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export type InstanceRole = 'source' | 'destination' | 'both';

export interface InstanceMetricFilter {
  connectionDatabaseContains: string[];
  connectionDatabaseExact: string[];
  embedExternalIdContains: string[];
  embedExternalIdExact: string[];
}

export interface PostMigrationAction {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface SavedInstance {
  id: string;
  label: string;
  role: InstanceRole;
  baseUrl: string;
  apiKey: string;
  defaultModelId?: string;
  defaultFolderId?: string;
  defaultFolderPath?: string;
  entityGroupSeparator?: string;
  metricFilter: InstanceMetricFilter;
  postMigrationActions: PostMigrationAction[];
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
}

export type SavedInstancePublic = Omit<SavedInstance, 'apiKey'> & {
  apiKeyMasked: string;
};

interface VaultPayload {
  version: typeof VAULT_VERSION;
  instances: SavedInstance[];
}

interface UnlockedVault {
  key: Buffer;
  salt: Buffer;
  payload: VaultPayload;
}

let unlockedVault: UnlockedVault | null = null;
let lastVaultActivityAt = 0;
let idleTimer: NodeJS.Timeout | null = null;

export function getVaultPath(): string {
  return process.env.OMNIKIT_VAULT_PATH || DEFAULT_VAULT_PATH;
}

export function getVaultIdleTimeoutMs(): number {
  const raw = Number(process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_IDLE_TIMEOUT_MS;
}

export function vaultExists(): boolean {
  return existsSync(getVaultPath());
}

export function isVaultUnlocked(): boolean {
  enforceIdleTimeout();
  return unlockedVault !== null;
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleTimer(): void {
  clearIdleTimer();
  const timeout = getVaultIdleTimeoutMs();
  if (!unlockedVault || timeout <= 0) return;
  idleTimer = setTimeout(() => {
    lockVault();
  }, timeout);
  idleTimer.unref?.();
}

function touchVault(): void {
  if (!unlockedVault) return;
  lastVaultActivityAt = Date.now();
  scheduleIdleTimer();
}

function enforceIdleTimeout(): void {
  if (!unlockedVault) return;
  const timeout = getVaultIdleTimeoutMs();
  if (timeout <= 0) return;
  if (Date.now() - lastVaultActivityAt >= timeout) lockVault();
}

function defaultFilter(): InstanceMetricFilter {
  return {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  };
}

function normalizeFilter(filter: Partial<InstanceMetricFilter> | undefined): InstanceMetricFilter {
  const clean = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
  return {
    connectionDatabaseContains: clean(filter?.connectionDatabaseContains),
    connectionDatabaseExact: clean(filter?.connectionDatabaseExact),
    embedExternalIdContains: clean(filter?.embedExternalIdContains),
    embedExternalIdExact: clean(filter?.embedExternalIdExact),
  };
}

function normalizeActions(actions: unknown): PostMigrationAction[] {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((action): action is Partial<PostMigrationAction> => Boolean(action) && typeof action === 'object' && !Array.isArray(action))
    .map((action) => ({
      name: typeof action.name === 'string' && action.name.trim() ? action.name.trim() : 'Post-migration action',
      method: normalizeMethod(action.method),
      url: typeof action.url === 'string' ? action.url.trim() : '',
      headers: action.headers && typeof action.headers === 'object' && !Array.isArray(action.headers)
        ? Object.fromEntries(Object.entries(action.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      body: typeof action.body === 'string' ? action.body : '',
    }))
    .filter((action) => action.url);
}

function normalizeMethod(value: unknown): PostMigrationAction['method'] {
  const method = typeof value === 'string' ? value.toUpperCase() : 'POST';
  if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return method;
  return 'POST';
}

function normalizeRole(value: unknown): InstanceRole {
  return value === 'source' || value === 'destination' || value === 'both' ? value : 'destination';
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
}

function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

function decrypt(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function persist(): void {
  if (!unlockedVault) throw new Error('vault locked');
  const vaultPath = getVaultPath();
  mkdirSync(dirname(vaultPath), { recursive: true });
  const encrypted = encrypt(JSON.stringify(unlockedVault.payload), unlockedVault.key);
  writeFileSync(vaultPath, Buffer.concat([unlockedVault.salt, encrypted]), { mode: 0o600 });
  chmodSync(vaultPath, 0o600);
}

function requireUnlocked(): UnlockedVault {
  enforceIdleTimeout();
  if (!unlockedVault) throw Object.assign(new Error('vault locked'), { statusCode: 423 });
  touchVault();
  return unlockedVault;
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return '••••';
  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
}

function labelFromBaseUrl(baseUrl: string): string {
  try {
    const withProtocol = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
    return new URL(withProtocol).host;
  } catch {
    return baseUrl;
  }
}

function toPublic(instance: SavedInstance): SavedInstancePublic {
  const { apiKey: _apiKey, ...rest } = instance;
  void _apiKey;
  return { ...rest, apiKeyMasked: maskApiKey(instance.apiKey) };
}

function normalizeInstance(raw: Partial<SavedInstance> & { apiKey?: string }, existing?: SavedInstance): SavedInstance {
  const now = new Date().toISOString();
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : existing?.baseUrl || '';
  const apiKey = typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : existing?.apiKey || '';
  if (!baseUrl || !apiKey) throw new Error('Instance Base URL and API key are required.');

  return {
    id: existing?.id || raw.id || randomUUID(),
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : existing?.label || labelFromBaseUrl(baseUrl),
    role: normalizeRole(raw.role ?? existing?.role),
    baseUrl,
    apiKey,
    defaultModelId: typeof raw.defaultModelId === 'string' && raw.defaultModelId.trim() ? raw.defaultModelId.trim() : undefined,
    defaultFolderId: typeof raw.defaultFolderId === 'string' && raw.defaultFolderId.trim() ? raw.defaultFolderId.trim() : undefined,
    defaultFolderPath: typeof raw.defaultFolderPath === 'string' && raw.defaultFolderPath.trim() ? raw.defaultFolderPath.trim() : undefined,
    entityGroupSeparator: typeof raw.entityGroupSeparator === 'string' && raw.entityGroupSeparator.trim() ? raw.entityGroupSeparator : undefined,
    metricFilter: normalizeFilter(raw.metricFilter ?? existing?.metricFilter ?? defaultFilter()),
    postMigrationActions: normalizeActions(raw.postMigrationActions ?? existing?.postMigrationActions ?? []),
    createdAt: existing?.createdAt || raw.createdAt || now,
    updatedAt: now,
    lastValidatedAt: raw.lastValidatedAt || existing?.lastValidatedAt,
  };
}

export function unlockVault(passphrase: string): void {
  if (!passphrase.trim()) throw new Error('Enter a vault passphrase.');
  const vaultPath = getVaultPath();
  mkdirSync(dirname(vaultPath), { recursive: true });

  if (!existsSync(vaultPath)) {
    const salt = randomBytes(SALT_LEN);
    const key = deriveKey(passphrase, salt);
    unlockedVault = { key, salt, payload: { version: VAULT_VERSION, instances: [] } };
    touchVault();
    persist();
    return;
  }

  const blob = readFileSync(vaultPath);
  const salt = blob.subarray(0, SALT_LEN);
  const encrypted = blob.subarray(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  const json = decrypt(encrypted, key);
  const parsed = JSON.parse(json) as Partial<VaultPayload>;
  if (parsed.version !== VAULT_VERSION) throw new Error(`Unsupported vault version: ${String(parsed.version)}`);
  unlockedVault = {
    key,
    salt: Buffer.from(salt),
    payload: {
      version: VAULT_VERSION,
      instances: Array.isArray(parsed.instances)
        ? parsed.instances.map((instance) => normalizeInstance(instance as SavedInstance))
        : [],
    },
  };
  touchVault();
}

export function lockVault(): void {
  clearIdleTimer();
  if (unlockedVault?.key) unlockedVault.key.fill(0);
  unlockedVault = null;
  lastVaultActivityAt = 0;
}

export function resetVault(): void {
  lockVault();
  const vaultPath = getVaultPath();
  if (existsSync(vaultPath)) rmSync(vaultPath, { force: true });
}

export function changeVaultPassphrase(currentPassphrase: string, nextPassphrase: string): void {
  if (!nextPassphrase.trim()) throw Object.assign(new Error('Enter a new vault passphrase.'), { statusCode: 400 });
  const current = requireUnlocked();
  const verify = deriveKey(currentPassphrase, current.salt);
  if (!timingSafeEqual(verify, current.key)) {
    verify.fill(0);
    throw Object.assign(new Error('Incorrect current passphrase.'), { statusCode: 400 });
  }
  verify.fill(0);
  const oldKey = current.key;
  const oldSalt = current.salt;
  const nextSalt = randomBytes(SALT_LEN);
  const nextKey = deriveKey(nextPassphrase, nextSalt);
  unlockedVault = { key: nextKey, salt: nextSalt, payload: current.payload };
  try {
    persist();
    oldKey.fill(0);
  } catch (err) {
    unlockedVault = { key: oldKey, salt: oldSalt, payload: current.payload };
    throw err;
  }
}

export function listInstances(): SavedInstancePublic[] {
  return requireUnlocked().payload.instances.map(toPublic);
}

export function getInstance(id: string): SavedInstance | undefined {
  return requireUnlocked().payload.instances.find((instance) => instance.id === id);
}

export function upsertInstance(raw: Partial<SavedInstance> & { id?: string; apiKey?: string }): SavedInstancePublic {
  const vault = requireUnlocked();
  const existing = raw.id
    ? vault.payload.instances.find((instance) => instance.id === raw.id)
    : vault.payload.instances.find((instance) => instance.baseUrl.toLowerCase() === raw.baseUrl?.toLowerCase());
  const saved = normalizeInstance(raw, existing);
  vault.payload.instances = [
    ...vault.payload.instances.filter((instance) => instance.id !== saved.id),
    saved,
  ].sort((a, b) => a.label.localeCompare(b.label));
  persist();
  return toPublic(saved);
}

export function deleteInstance(id: string): void {
  const vault = requireUnlocked();
  vault.payload.instances = vault.payload.instances.filter((instance) => instance.id !== id);
  persist();
}

export function markInstanceValidated(id: string): SavedInstancePublic {
  const vault = requireUnlocked();
  const existing = vault.payload.instances.find((instance) => instance.id === id);
  if (!existing) throw new Error('Instance not found.');
  existing.lastValidatedAt = new Date().toISOString();
  existing.updatedAt = existing.lastValidatedAt;
  persist();
  return toPublic(existing);
}

export function vaultStatus() {
  enforceIdleTimeout();
  return {
    unlocked: isVaultUnlocked(),
    exists: vaultExists(),
    path: getVaultPath(),
    idleTimeoutMs: getVaultIdleTimeoutMs(),
    lastActivityAt: lastVaultActivityAt || undefined,
    instanceCount: unlockedVault?.payload.instances.length ?? 0,
  };
}
