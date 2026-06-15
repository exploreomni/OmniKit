import { OmniClient } from '../omniClient';

const TERMINAL_SUCCESS = new Set(['succeeded', 'success', 'completed', 'complete', 'done']);
const TERMINAL_FAILURE = new Set(['failed', 'error', 'canceled', 'cancelled']);
const REFUSAL_PATTERNS = [
  /\bi\s+(?:can'?t|cannot|won'?t)\b/i,
  /\bunable\s+to\s+(?:help|comply|rewrite|provide)\b/i,
  /\bcan(?:not|'?t)\s+assist\b/i,
  /\brefus(?:e|al|ed)\b/i,
];

export function aiResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const row = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'message', 'result', 'response', 'output']) {
    const nested = row[key];
    if (typeof nested === 'string') return nested;
    const deep = aiResultText(nested);
    if (deep) return deep;
  }
  if (Array.isArray(row.messages)) {
    return row.messages.map(aiResultText).filter(Boolean).join('\n');
  }
  return '';
}

export function extractYamlFromAiResult(value: unknown): string {
  const text = aiResultText(value).trim();
  if (!text) return '';
  const fenced = text.match(/```(?:ya?ml)?\s*([\s\S]*?)```/i);
  if (!fenced && isAiRefusalText(text)) return '';
  return (fenced?.[1] || text).trim();
}

export function isAiRefusalText(text: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed) && REFUSAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function shouldRunAiDialectPass(fileName: string, yaml: string): boolean {
  if (!/\.(view|topic|model|relationship|relationships)$/i.test(fileName)) return false;
  return /^\s*(sql|on_sql|where_sql|having_sql|filters?|custom_sql)\s*:/mi.test(yaml)
    || /\bsql\s*:/i.test(yaml);
}

export async function runAiDialectPass(
  client: OmniClient,
  modelId: string,
  prompt: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ yaml?: string; jobId?: string; warning?: string; refusal?: string }> {
  const job = await client.createAiJob({ modelId, prompt });
  if (!job.id) return { warning: 'Omni AI did not return a job id; deterministic translation is still available for review.' };
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  let lastStatus = job.status;
  while (Date.now() < deadline) {
    const current = await client.getAiJob(job.id);
    lastStatus = current.status || lastStatus;
    const normalized = (lastStatus || '').toLowerCase();
    if (TERMINAL_SUCCESS.has(normalized) || TERMINAL_FAILURE.has(normalized)) break;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2_000));
  }
  const normalized = (lastStatus || '').toLowerCase();
  if (!TERMINAL_SUCCESS.has(normalized)) {
    return { jobId: job.id, warning: `Omni AI job ${job.id} did not complete successfully${lastStatus ? ` (${lastStatus})` : ''}; deterministic translation is still available.` };
  }
  const result = await client.getAiJobResult(job.id);
  const text = aiResultText(result).trim();
  if (isAiRefusalText(text)) {
    return { jobId: job.id, refusal: `Omni AI job ${job.id} declined to produce a YAML rewrite; deterministic translation is still available.` };
  }
  const yaml = extractYamlFromAiResult(result);
  return yaml ? { yaml, jobId: job.id } : { jobId: job.id, warning: `Omni AI job ${job.id} completed without a YAML body; deterministic translation is still available.` };
}
