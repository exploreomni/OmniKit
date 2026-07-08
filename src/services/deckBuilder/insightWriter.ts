import {
  ApiError,
  cancelAiJob,
  createAiJob,
  getAiJob,
  getAiJobResult,
  type OmniAiJob,
  type OmniAiJobResult,
} from '../omniApi';
import { cleanDeckInsightText, isDeckInsightRefusal } from './prompts';

const TERMINAL_AI_STATES = new Set(['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELED']);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

export interface GenerateDeckInsightInput {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  topicName?: string;
  prompt: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxPolls?: number;
  onStatus?: (message: string) => void;
  onJobId?: (jobId: string) => void;
}

export interface GenerateDeckInsightResult {
  text: string;
  jobId: string;
  conversationId?: string;
  chatUrl?: string;
  truncated: boolean;
}

export class DeckInsightCancelledError extends Error {
  constructor() {
    super('AI insight generation cancelled.');
    this.name = 'DeckInsightCancelledError';
  }
}

function normalizeAiState(value: string | undefined): string {
  return (value || '').trim().toUpperCase().replace(/[-\s]/g, '_');
}

function readFirstString(value: unknown, keys: string[]): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === 'string' && field.trim()) return field.trim();
  }
  return '';
}

function buildOmniChatUrl(baseUrl: string, conversationId: string): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  return cleanBase && conversationId ? `${cleanBase}/chat/${encodeURIComponent(conversationId)}` : '';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DeckInsightCancelledError();
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeckInsightCancelledError());
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(new DeckInsightCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function jobToResult(job: OmniAiJob | null | undefined): OmniAiJobResult | null {
  if (!job) return null;
  const message = readFirstString(job, ['resultSummary', 'result_summary', 'message']);
  return message ? { message } : null;
}

function extractAiMessage(result: OmniAiJobResult | null | undefined, fallbackJob?: OmniAiJob | null): string {
  const direct =
    readFirstString(result, ['finalMessage', 'final_message', 'message', 'resultSummary', 'result_summary', 'answer']) ||
    readFirstString(fallbackJob, ['resultSummary', 'result_summary', 'message']);
  if (direct) return direct;

  const actions = Array.isArray(result?.actions) ? result?.actions : Array.isArray(fallbackJob?.actions) ? fallbackJob?.actions : [];
  for (const action of actions || []) {
    const value =
      readFirstString(action, ['message', 'result', 'summary', 'text', 'answer']) ||
      readFirstString((action as Record<string, unknown>).payload, ['message', 'result', 'summary', 'text', 'answer']);
    if (value) return value;
  }
  return '';
}

async function createAiJobWithRetry(input: GenerateDeckInsightInput): Promise<OmniAiJob> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(input.signal);
    try {
      input.onStatus?.(attempt > 0 ? 'Retrying Omni AI job...' : 'Creating Omni AI job...');
      return await createAiJob(input.baseUrl, input.apiKey, {
        modelId: input.modelId,
        topicName: input.topicName || undefined,
        prompt: input.prompt,
      });
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ApiError && RETRYABLE_STATUSES.has(error.status);
      if (!retryable || attempt === 2) break;
      input.onStatus?.('Omni is busy, waiting a moment before retrying...');
      await wait(8000, input.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Omni AI job failed to start.');
}

async function waitForAiJob(input: GenerateDeckInsightInput, jobId: string): Promise<{ job: OmniAiJob | null; timedOut: boolean }> {
  let latest: OmniAiJob | null = null;
  const maxPolls = input.maxPolls ?? 36;
  const pollIntervalMs = input.pollIntervalMs ?? 3000;
  for (let i = 0; i < maxPolls; i += 1) {
    throwIfAborted(input.signal);
    latest = await getAiJob(input.baseUrl, input.apiKey, jobId);
    const state = normalizeAiState(latest.state || latest.status);
    if (TERMINAL_AI_STATES.has(state)) return { job: latest, timedOut: false };
    input.onStatus?.('Waiting for Blobby to finish...');
    await wait(pollIntervalMs, input.signal);
  }
  return { job: latest, timedOut: true };
}

async function getAiResult(input: GenerateDeckInsightInput, jobId: string, finalJob: OmniAiJob | null): Promise<OmniAiJobResult> {
  const fallback = jobToResult(finalJob);
  let lastError: unknown = null;
  for (let i = 0; i < 8; i += 1) {
    throwIfAborted(input.signal);
    try {
      const result = await getAiJobResult(input.baseUrl, input.apiKey, jobId);
      if (extractAiMessage(result, finalJob)) return result;
    } catch (error) {
      lastError = error;
    }
    await wait(3000, input.signal);
  }
  if (fallback) return fallback;
  throw lastError instanceof Error ? lastError : new Error('AI result was not available yet.');
}

export async function generateDeckInsight(input: GenerateDeckInsightInput): Promise<GenerateDeckInsightResult> {
  if (!input.modelId.trim()) throw new Error('This tile does not expose a model ID for Omni AI.');
  let jobId = '';
  const cancelOnAbort = async () => {
    if (!jobId) return;
    try {
      await cancelAiJob(input.baseUrl, input.apiKey, jobId);
    } catch {
      // Best effort cancellation; the UI still treats the local run as cancelled.
    }
  };
  input.signal?.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    const created = await createAiJobWithRetry(input);
    jobId = created.jobId || created.id || '';
    if (!jobId) throw new Error('Omni did not return an AI job ID.');
    input.onJobId?.(jobId);
    const createdConversationId = readFirstString(created, ['conversationId', 'conversation_id']);
    const createdChatUrl = readFirstString(created, ['omniChatUrl', 'omni_chat_url']) || buildOmniChatUrl(input.baseUrl, createdConversationId);
    input.onStatus?.('Waiting for Blobby to finish...');
    const { job: finalJob, timedOut } = await waitForAiJob(input, jobId);
    if (timedOut) throw new Error('Omni is still working on this insight. Try again in a moment.');
    const finalState = normalizeAiState(finalJob?.state || finalJob?.status);
    if (['FAILED', 'CANCELLED', 'CANCELED'].includes(finalState)) throw new Error(`Omni AI job ${finalState.toLowerCase()}.`);
    input.onStatus?.('Retrieving AI insight...');
    const result = await getAiResult(input, jobId, finalJob);
    const rawText = extractAiMessage(result, finalJob);
    if (!rawText) throw new Error('Omni AI did not return an insight.');
    if (isDeckInsightRefusal(rawText)) {
      throw new Error('Omni AI declined to generate an insight for this tile. Try again or write the insight manually.');
    }
    const cleaned = cleanDeckInsightText(rawText);
    if (!cleaned.text) throw new Error('Omni AI returned an empty insight.');
    const conversationId = readFirstString(result, ['conversationId', 'conversation_id']) || readFirstString(finalJob, ['conversationId', 'conversation_id']) || createdConversationId;
    const chatUrl = readFirstString(result, ['omniChatUrl', 'omni_chat_url']) || readFirstString(finalJob, ['omniChatUrl', 'omni_chat_url']) || createdChatUrl || buildOmniChatUrl(input.baseUrl, conversationId);
    return { text: cleaned.text, jobId, conversationId, chatUrl, truncated: cleaned.truncated };
  } finally {
    input.signal?.removeEventListener('abort', cancelOnAbort);
  }
}
