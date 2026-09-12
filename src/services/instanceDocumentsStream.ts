import { ApiError } from './omniApi';
import { emitVaultLocked } from './vaultEvents';
import type { InstanceDocumentsResponse } from './opsConsole';

export interface InstanceDocumentsProgress {
  pages: number;
  returnedRecords: number;
  reportedTotalRecords?: number;
}

function responseError(value: unknown, status: number): ApiError {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const message = typeof row.error === 'string' ? row.error : typeof row.message === 'string' ? row.message : 'Dashboard browsing could not finish.';
  if (status === 423) emitVaultLocked(message);
  return new ApiError(status, message, undefined, typeof row.code === 'string' ? row.code : undefined);
}

function completedResponse(value: unknown): InstanceDocumentsResponse {
  const row = value as Partial<InstanceDocumentsResponse> | null;
  if (!row || !Array.isArray(row.documents) || row.inventory?.complete !== true) {
    throw new Error('The dashboard inventory was incomplete. No partial browsing results were added.');
  }
  return row as InstanceDocumentsResponse;
}

/** Progress contains counters only. Document lists become usable only at a complete terminal response. */
export async function readInstanceDocumentsStream(
  response: Response,
  onProgress?: (progress: InstanceDocumentsProgress) => void,
  signal?: AbortSignal,
): Promise<InstanceDocumentsResponse> {
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('Dashboard browsing canceled.', 'AbortError'); };
  checkAbort();
  if (!response.ok || !response.headers.get('content-type')?.includes('ndjson')) {
    const value: unknown = await response.json().catch(() => null);
    checkAbort();
    if (!response.ok || (value && typeof value === 'object' && 'error' in value)) throw responseError(value, response.status);
    return completedResponse(value);
  }
  if (!response.body) throw new Error('The dashboard progress stream was unavailable.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancelReader, { once: true });
  const consume = (line: string): InstanceDocumentsResponse | undefined => {
    if (!line.trim()) return undefined;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === 'error') throw responseError(event, 502);
    if (event.type === 'complete') return completedResponse(event);
    if (event.type !== 'progress'
      || !Number.isSafeInteger(event.pages) || Number(event.pages) < 0
      || !Number.isSafeInteger(event.returnedRecords) || Number(event.returnedRecords) < 0
      || (event.reportedTotalRecords !== undefined && (!Number.isSafeInteger(event.reportedTotalRecords) || Number(event.reportedTotalRecords) < 0))) {
      throw new Error('Dashboard browsing returned an invalid progress response.');
    }
    onProgress?.({ pages: Number(event.pages), returnedRecords: Number(event.returnedRecords), ...(event.reportedTotalRecords !== undefined ? { reportedTotalRecords: Number(event.reportedTotalRecords) } : {}) });
    return undefined;
  };
  try {
    while (true) {
      checkAbort();
      const { done, value } = await reader.read();
      checkAbort();
      pending += decoder.decode(value, { stream: !done });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const complete = consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (complete) return complete;
        newline = pending.indexOf('\n');
      }
      if (done) {
        const complete = consume(pending);
        if (complete) return complete;
        throw new Error('Dashboard browsing ended before completion. No partial results were added.');
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
