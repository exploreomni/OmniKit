import type { ConnectionConfig } from '@/types';

const STORAGE_KEY = 'omnikit:instanceVault:v1';
const VAULT_VERSION = 1;
const ITERATIONS = 250_000;

export interface SavedOmniInstance {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultTargetFolder?: string;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
}

interface VaultPayload {
  version: typeof VAULT_VERSION;
  instances: SavedOmniInstance[];
}

interface EncryptedVault {
  version: typeof VAULT_VERSION;
  kdf: 'PBKDF2-SHA256';
  cipher: 'AES-GCM';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

interface UnlockedVault {
  key: CryptoKey;
  salt: Uint8Array;
  iterations: number;
  payload: VaultPayload;
}

let unlockedVault: UnlockedVault | null = null;

function assertCrypto() {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    throw new Error('Encrypted vaults require browser crypto support.');
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function makeId(): string {
  if (window.crypto.randomUUID) return window.crypto.randomUUID();
  return `instance-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function labelFromUrl(value: string): string {
  try {
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(url).host;
  } catch {
    return value;
  }
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await window.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptPayload(key: CryptoKey, salt: Uint8Array, iterations: number, payload: VaultPayload): Promise<EncryptedVault> {
  const iv = randomBytes(12);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, plaintext);

  return {
    version: VAULT_VERSION,
    kdf: 'PBKDF2-SHA256',
    cipher: 'AES-GCM',
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
}

async function decryptPayload(key: CryptoKey, vault: EncryptedVault): Promise<VaultPayload> {
  const iv = base64ToBytes(vault.iv);
  const ciphertext = base64ToBytes(vault.ciphertext);
  const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(ciphertext));
  const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as Partial<VaultPayload>;
  return {
    version: VAULT_VERSION,
    instances: Array.isArray(parsed.instances) ? parsed.instances.filter(isSavedInstance) : [],
  };
}

function isSavedInstance(value: unknown): value is SavedOmniInstance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<SavedOmniInstance>;
  return typeof row.id === 'string'
    && typeof row.name === 'string'
    && typeof row.baseUrl === 'string'
    && typeof row.apiKey === 'string'
    && typeof row.createdAt === 'string'
    && typeof row.updatedAt === 'string';
}

function readEncryptedVault(): EncryptedVault | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<EncryptedVault>;
  if (
    parsed.version !== VAULT_VERSION
    || parsed.kdf !== 'PBKDF2-SHA256'
    || parsed.cipher !== 'AES-GCM'
    || typeof parsed.iterations !== 'number'
    || typeof parsed.salt !== 'string'
    || typeof parsed.iv !== 'string'
    || typeof parsed.ciphertext !== 'string'
  ) {
    throw new Error('Saved instance vault metadata is invalid.');
  }
  return parsed as EncryptedVault;
}

async function writeUnlockedVault(nextPayload: VaultPayload): Promise<void> {
  if (!unlockedVault) throw new Error('Unlock the instance vault before saving.');
  const encrypted = await encryptPayload(unlockedVault.key, unlockedVault.salt, unlockedVault.iterations, nextPayload);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted));
  unlockedVault = { ...unlockedVault, payload: nextPayload };
}

export function hasInstanceVault(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.localStorage.getItem(STORAGE_KEY);
}

export function isInstanceVaultUnlocked(): boolean {
  return unlockedVault !== null;
}

export function getUnlockedInstanceVault(): VaultPayload | null {
  return unlockedVault?.payload ?? null;
}

export function lockInstanceVault(): void {
  unlockedVault = null;
}

export async function createInstanceVault(password: string): Promise<VaultPayload> {
  assertCrypto();
  if (!password.trim()) throw new Error('Enter a vault password.');
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, ITERATIONS);
  const payload: VaultPayload = { version: VAULT_VERSION, instances: [] };
  const encrypted = await encryptPayload(key, salt, ITERATIONS, payload);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted));
  unlockedVault = { key, salt, iterations: ITERATIONS, payload };
  return payload;
}

export async function unlockInstanceVault(password: string): Promise<VaultPayload> {
  assertCrypto();
  if (!password.trim()) throw new Error('Enter your vault password.');
  const encrypted = readEncryptedVault();
  if (!encrypted) return createInstanceVault(password);

  try {
    const salt = base64ToBytes(encrypted.salt);
    const key = await deriveKey(password, salt, encrypted.iterations);
    const payload = await decryptPayload(key, encrypted);
    unlockedVault = { key, salt, iterations: encrypted.iterations, payload };
    return payload;
  } catch {
    throw new Error('Could not unlock the instance vault. Check the password and try again.');
  }
}

export async function saveInstanceToVault(input: {
  id?: string;
  name: string;
  connection: ConnectionConfig;
  defaultTargetFolder?: string;
}): Promise<SavedOmniInstance> {
  if (!unlockedVault) throw new Error('Unlock the instance vault before saving.');
  const baseUrl = input.connection.baseUrl.trim();
  const apiKey = input.connection.apiKey.trim();
  if (!baseUrl || !apiKey) throw new Error('Target Base URL and API key are required before saving.');

  const now = new Date().toISOString();
  const existing = input.id
    ? unlockedVault.payload.instances.find((instance) => instance.id === input.id)
    : unlockedVault.payload.instances.find((instance) => instance.baseUrl.toLowerCase() === baseUrl.toLowerCase());

  const saved: SavedOmniInstance = {
    id: existing?.id ?? makeId(),
    name: input.name.trim() || existing?.name || labelFromUrl(baseUrl),
    baseUrl,
    apiKey,
    defaultTargetFolder: input.defaultTargetFolder?.trim() || undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastValidatedAt: input.connection.status === 'success' ? now : existing?.lastValidatedAt,
  };

  const others = unlockedVault.payload.instances.filter((instance) => instance.id !== saved.id);
  const payload: VaultPayload = {
    version: VAULT_VERSION,
    instances: [...others, saved].sort((a, b) => a.name.localeCompare(b.name)),
  };
  await writeUnlockedVault(payload);
  return saved;
}

export async function deleteInstanceFromVault(id: string): Promise<void> {
  if (!unlockedVault) throw new Error('Unlock the instance vault before deleting.');
  const payload: VaultPayload = {
    version: VAULT_VERSION,
    instances: unlockedVault.payload.instances.filter((instance) => instance.id !== id),
  };
  await writeUnlockedVault(payload);
}
