import { assertSafeOutboundUrl, validateBaseUrl, jsonHeaders } from '../security';
import { acquireOmniRequestSlot } from '../services/omniClient';

interface PageInfo {
  hasNextPage: boolean;
  nextCursor: string | null;
  pageSize: number;
  totalRecords: number;
}

interface DocumentPage {
  records: unknown[];
  pageInfo: PageInfo;
}

const MAX_PAGES = 50;
const PAGE_TIMEOUT_MS = 15_000;

export interface ListDocumentsDependencies {
  fetch?: typeof fetch;
  validateOutbound?: (url: string) => Promise<void>;
  acquireRequestSlot?: (apiKey: string, signal?: AbortSignal) => Promise<void>;
  pageTimeoutMs?: number;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

async function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  void operation.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseDocumentPage(data: unknown): DocumentPage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (!Array.isArray(row.records)) return null;
  const pageInfo = row.pageInfo;
  if (!pageInfo || typeof pageInfo !== "object" || Array.isArray(pageInfo)) return null;
  const info = pageInfo as Record<string, unknown>;
  if (
    typeof info.hasNextPage !== "boolean"
    || !Number.isSafeInteger(info.pageSize)
    || Number(info.pageSize) < 1
    || !isNonNegativeInteger(info.totalRecords)
    || row.records.length > Number(info.pageSize)
    || row.records.length > Number(info.totalRecords)
    || (info.hasNextPage && row.records.length === 0)
  ) return null;
  const nextCursor = info.nextCursor;
  if (info.hasNextPage) {
    if (typeof nextCursor !== "string" || nextCursor.trim().length === 0) return null;
  } else if (nextCursor !== undefined && nextCursor !== null) {
    return null;
  }
  return {
    records: row.records,
    pageInfo: {
      hasNextPage: info.hasNextPage,
      nextCursor: typeof nextCursor === "string" ? nextCursor : null,
      pageSize: Number(info.pageSize),
      totalRecords: Number(info.totalRecords),
    },
  };
}

function isSafeDocumentLabel(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).name === 'string'
    && String((value as Record<string, unknown>).name).trim().length > 0;
}

function collectDocumentIds(records: unknown[], seen: Set<string>): boolean {
  for (const value of records) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const id = typeof record.identifier === "string" ? record.identifier.trim() : "";
    if (
      !id
      || seen.has(id)
      || typeof record.name !== "string"
      || record.name.trim().length === 0
      || (record.url !== undefined && typeof record.url !== "string")
      || (record.hasDashboard !== undefined && typeof record.hasDashboard !== "boolean")
      || (record.type !== undefined && typeof record.type !== "string")
      || (record.kind !== undefined && typeof record.kind !== "string")
      || (record.labels !== undefined && (
        !Array.isArray(record.labels) || !record.labels.every(isSafeDocumentLabel)
      ))
    ) return false;
    seen.add(id);
  }
  return true;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

function nested(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function normalizeDocument(raw: Record<string, unknown>) {
  const content = (raw.content && typeof raw.content === "object" && !Array.isArray(raw.content))
    ? raw.content as Record<string, unknown>
    : null;
  const metadata = (raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata))
    ? raw.metadata as Record<string, unknown>
    : null;

  const docId = String(raw.identifier ?? raw.id ?? raw.slug ?? "");

  const baseModelId = firstString(
    raw.sharedModelId, raw.shared_model_id,
    raw.base_model_id, raw.baseModelId,
    content?.sharedModelId, content?.shared_model_id,
    content?.base_model_id, content?.baseModelId,
    metadata?.sharedModelId, metadata?.shared_model_id,
    metadata?.base_model_id, metadata?.baseModelId,
    nested(raw, "baseModel", "id"),
    nested(raw, "model", "id"),
    nested(content, "baseModel", "id"),
  );

  return {
    id: docId,
    name: String(raw.name ?? ""),
    identifier: docId,
    url: firstString(raw.url),
    hasDashboard: typeof raw.hasDashboard === "boolean" ? raw.hasDashboard : undefined,
    connectionId: firstString(raw.connectionId),
    baseModelId,
    folderId: firstString(raw.folder_id, raw.folderId, nested(raw, "folder", "id")),
    folderPath: firstString(raw.folder_path, raw.folderPath, raw.path, nested(raw, "folder", "path")),
    type: String(raw.type ?? raw.kind ?? "") || undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    labels: Array.isArray(raw.labels)
      ? raw.labels.flatMap((label) => {
          if (typeof label === "string" && label.trim()) return [label.trim()];
          if (label && typeof label === "object" && !Array.isArray(label)) {
            const name = firstString((label as Record<string, unknown>).name);
            return name ? [name] : [];
          }
          return [];
        })
      : undefined,
  };
}

export default async function handler(
  req: Request,
  dependencies: ListDocumentsDependencies = {},
): Promise<Response> {
  try {
    const {
      base_url,
      api_key,
      folder_id,
      page_size,
      cursor,
      all_pages,
      include_all_documents,
    } = await req.json();

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key) {
      return new Response(
        JSON.stringify({ error: "Base URL and API key are required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");
    const requestedPageSize = Number(page_size);
    const pageSize = Number.isSafeInteger(requestedPageSize) && requestedPageSize > 0
      ? Math.min(requestedPageSize, 100)
      : 100;
    const allRaw: unknown[] = [];
    const initialCursor = typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
    let nextCursor = initialCursor;
    let lastPageInfo: PageInfo | null = null;
    let totalRecords: number | null = null;
    let totalMode: 'stable' | 'remaining' | null = null;
    let pagesFetched = 0;
    let reachedSafetyLimit = false;
    const seenCursors = new Set<string>();
    const seenDocumentIds = new Set<string>();
    if (nextCursor) seenCursors.add(nextCursor);

    while (pagesFetched < MAX_PAGES) {
      const params = new URLSearchParams();
      params.set("pageSize", String(pageSize));
      params.set("sortField", "name");
      params.set("sortDirection", "asc");
      params.set("include", "labels");
      if (folder_id) params.set("folderId", folder_id);
      if (nextCursor) params.set("cursor", nextCursor);

      const url = `${cleanUrl}/api/v1/documents?${params.toString()}`;
      try {
        await raceWithAbortSignal(
          (dependencies.validateOutbound
            || ((candidate: string) => assertSafeOutboundUrl(candidate, { label: 'base_url' })))(url),
          req.signal,
        );
      } catch (error) {
        if (req.signal.aborted) throw error;
        return new Response(
          JSON.stringify({ error: 'The Omni document destination could not be validated safely.' }),
          { status: 400, headers: jsonHeaders },
        );
      }
      await (dependencies.acquireRequestSlot || acquireOmniRequestSlot)(api_key, req.signal);
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([req.signal, controller.signal]);
      const timeout = setTimeout(
        () => controller.abort(new DOMException('The document inventory page timed out.', 'TimeoutError')),
        dependencies.pageTimeoutMs ?? PAGE_TIMEOUT_MS,
      );
      let response: Response;
      let responseData: unknown;
      try {
        response = await raceWithAbortSignal(
          (dependencies.fetch || globalThis.fetch)(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${api_key}`,
            "Content-Type": "application/json",
          },
          redirect: 'manual',
          signal: requestSignal,
          }),
          requestSignal,
        );
        if (response.status >= 300 && response.status < 400) {
          return new Response(
            JSON.stringify({ error: 'Omni redirected the document inventory request unexpectedly.' }),
            { status: 502, headers: jsonHeaders },
          );
        }

        if (!response.ok) {
          return new Response(
            JSON.stringify({
              error: `Omni document read failed with HTTP ${response.status}.`,
            }),
            { status: response.status, headers: jsonHeaders }
          );
        }
        responseData = await raceWithAbortSignal(response.json(), requestSignal);
      } finally {
        clearTimeout(timeout);
      }

      const page = parseDocumentPage(responseData);
      if (page === null) {
        return new Response(
          JSON.stringify({
            error: "Omni returned an unsupported document response shape.",
          }),
          { status: 502, headers: jsonHeaders }
        );
      }

      const recordsBeforePage = allRaw.length;
      if (totalRecords === null) {
        totalRecords = page.pageInfo.totalRecords;
      } else {
        const stableTotal = page.pageInfo.totalRecords === totalRecords;
        const remainingTotal = page.pageInfo.totalRecords === totalRecords - recordsBeforePage;
        if (totalMode === null) {
          if (stableTotal) totalMode = 'stable';
          else if (remainingTotal) totalMode = 'remaining';
          else {
            return new Response(
              JSON.stringify({ error: "Omni returned inconsistent document pagination evidence." }),
              { status: 502, headers: jsonHeaders }
            );
          }
        } else if (
          (totalMode === 'stable' && !stableTotal)
          || (totalMode === 'remaining' && !remainingTotal)
        ) {
          return new Response(
            JSON.stringify({ error: "Omni returned inconsistent document pagination evidence." }),
            { status: 502, headers: jsonHeaders }
          );
        }
      }
      if (!collectDocumentIds(page.records, seenDocumentIds)) {
        return new Response(
          JSON.stringify({ error: "Omni returned malformed or duplicate document records." }),
          { status: 502, headers: jsonHeaders }
        );
      }
      allRaw.push(...page.records);
      lastPageInfo = page.pageInfo;
      pagesFetched += 1;
      if (!page.pageInfo.hasNextPage || all_pages !== true) break;
      const returnedCursor = page.pageInfo.nextCursor;
      if (!returnedCursor || seenCursors.has(returnedCursor)) {
        return new Response(
          JSON.stringify({ error: "Omni returned non-advancing document pagination evidence." }),
          { status: 502, headers: jsonHeaders }
        );
      }
      if (pagesFetched >= MAX_PAGES) {
        reachedSafetyLimit = true;
        break;
      }
      seenCursors.add(returnedCursor);
      nextCursor = returnedCursor;
    }

    const startedAtBeginning = initialCursor === undefined;
    const reachedEnd = lastPageInfo?.hasNextPage === false;
    const complete = startedAtBeginning
      && reachedEnd
      && !reachedSafetyLimit
      && allRaw.length === totalRecords;
    if (startedAtBeginning && reachedEnd && !reachedSafetyLimit && !complete) {
      return new Response(
        JSON.stringify({ error: "Omni returned inconsistent document collection totals." }),
        { status: 502, headers: jsonHeaders }
      );
    }

    const documents = allRaw
      .map((item) => normalizeDocument(item as Record<string, unknown>))
      .filter((d) => include_all_documents === true
        || (d.hasDashboard !== false && (!d.type || d.type === "dashboard" || d.type === "document")));

    return new Response(JSON.stringify({
      documents,
      pageInfo: lastPageInfo,
      pagesFetched,
      complete,
      loadedResults: allRaw.length,
      totalResults: totalRecords,
      ...(reachedSafetyLimit ? { reasonCode: "PAGINATION_SAFETY_LIMIT_REACHED" } : {}),
    }), {
      headers: jsonHeaders,
    });
  } catch {
    return new Response(JSON.stringify({ error: "The Omni document read could not be completed." }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
