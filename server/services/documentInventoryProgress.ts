import type { OmniDocumentInventoryProgress } from './omniClient';

type Observer = (progress: OmniDocumentInventoryProgress) => void;
const observers = new Map<string, Set<Observer>>();

export function observeDocumentInventory(key: string, observer?: Observer): () => void {
  if (!observer) return () => undefined;
  const listeners = observers.get(key) ?? new Set<Observer>();
  listeners.add(observer);
  observers.set(key, listeners);
  return () => {
    listeners.delete(observer);
    if (!listeners.size && observers.get(key) === listeners) observers.delete(key);
  };
}

export function publishDocumentInventoryProgress(key: string, progress: OmniDocumentInventoryProgress): void {
  for (const listener of observers.get(key) ?? []) {
    try { listener({ ...progress }); } catch { /* A disconnected observer cannot fail a shared read. */ }
  }
}

/** One request, counters only until the terminal complete response; no polling. */
export function documentInventoryStream(
  signal: AbortSignal,
  load: (signal: AbortSignal, progress: Observer) => Promise<Response>,
): Response {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      const encoder = new TextEncoder();
      const send = (event: unknown) => {
        if (!closed && !controller.signal.aborted) output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      send({ type: 'progress', pages: 0, returnedRecords: 0 });
      void load(controller.signal, (progress) => send({ type: 'progress', ...progress }))
        .then(async (response) => {
          const body = await response.json() as Record<string, unknown>;
          send({ ...body, type: response.ok ? 'complete' : 'error' });
        })
        .catch(() => send({ type: 'error', error: 'Dashboard browsing could not finish. No partial catalog was accepted.' }))
        .finally(() => {
          signal.removeEventListener('abort', abort);
          if (!closed) { closed = true; output.close(); }
        });
    },
    cancel() {
      closed = true;
      signal.removeEventListener('abort', abort);
      controller.abort(new DOMException('Dashboard browsing cancelled.', 'AbortError'));
    },
  });
  return new Response(stream, { headers: {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no',
  } });
}
