import { assertSafeOutboundUrl, validateBaseUrl, jsonHeaders } from '../security';
import { acquireOmniRequestSlot } from '../services/omniClient';

function extractSlug(folder: Record<string, unknown>): string {
  for (const key of ["identifier", "slug", "filePath", "file_path", "path"]) {
    const val = folder[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return "";
}

function normalizeFolders(folders: unknown[]): unknown[] {
  return folders.map((f) => {
    const folder = f as Record<string, unknown>;
    const slug = extractSlug(folder);
    const children = Array.isArray(folder.children)
      ? normalizeFolders(folder.children as unknown[])
      : undefined;
    const identifier = typeof folder.identifier === "string" && folder.identifier.trim().length > 0
      ? folder.identifier.trim()
      : slug || undefined;
    const labels = Array.isArray(folder.labels)
      ? folder.labels.map((label) => typeof label === "string"
        ? label.trim()
        : { name: String((label as Record<string, unknown>).name).trim() })
      : undefined;
    return {
      id: (folder.id as string).trim(),
      name: (folder.name as string).trim(),
      ...(identifier ? { identifier } : {}),
      ...(typeof folder.path === "string" && folder.path.trim() ? { path: folder.path.trim() } : {}),
      ...(typeof folder.url === "string" && folder.url.trim() ? { url: folder.url.trim() } : {}),
      ...(labels ? { labels } : {}),
      ...(children ? { children } : {}),
    };
  });
}

function isSafeFolderLabel(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).name === "string"
    && String((value as Record<string, unknown>).name).trim().length > 0;
}

function collectFolderIds(records: unknown[], seen: Set<string>): boolean {
  for (const value of records) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const folder = value as Record<string, unknown>;
    const id = typeof folder.id === "string" ? folder.id.trim() : "";
    if (
      !id
      || seen.has(id)
      || typeof folder.name !== "string"
      || folder.name.trim().length === 0
      || ['identifier', 'slug', 'filePath', 'file_path', 'path'].some((key) => (
        folder[key] !== undefined && typeof folder[key] !== "string"
      ))
      || (folder.url !== undefined && typeof folder.url !== "string")
      || (folder.labels !== undefined && (!Array.isArray(folder.labels) || !folder.labels.every(isSafeFolderLabel)))
    ) return false;
    seen.add(id);
    if (folder.children !== undefined) {
      if (!Array.isArray(folder.children) || !collectFolderIds(folder.children, seen)) return false;
    }
  }
  return true;
}

interface PageInfo {
  hasNextPage: boolean;
  nextCursor: string | null;
  pageSize: number;
  totalRecords: number;
}

interface FolderPage {
  records: unknown[];
  pageInfo: PageInfo;
}

const MAX_PAGES = 50;
const PAGE_TIMEOUT_MS = 15_000;

export interface ListFoldersDependencies {
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

function parseFolderPage(data: unknown): FolderPage | null {
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

export default async function handler(
  req: Request,
  dependencies: ListFoldersDependencies = {},
): Promise<Response> {
  try {
    const { base_url, api_key, page_size, cursor, all_pages } = await req.json();

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
    const seenFolderIds = new Set<string>();
    if (nextCursor) seenCursors.add(nextCursor);

    while (pagesFetched < MAX_PAGES) {
      const params = new URLSearchParams();
      params.set("pageSize", String(pageSize));
      params.set("sortField", "name");
      params.set("sortDirection", "asc");
      params.set("include", "labels");
      if (nextCursor) params.set("cursor", nextCursor);

      const url = `${cleanUrl}/api/v1/folders?${params.toString()}`;
      try {
        await raceWithAbortSignal(
          (dependencies.validateOutbound
            || ((candidate: string) => assertSafeOutboundUrl(candidate, { label: 'base_url' })))(url),
          req.signal,
        );
      } catch (error) {
        if (req.signal.aborted) throw error;
        return new Response(
          JSON.stringify({ error: 'The Omni folder destination could not be validated safely.' }),
          { status: 400, headers: jsonHeaders },
        );
      }
      await (dependencies.acquireRequestSlot || acquireOmniRequestSlot)(api_key, req.signal);
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([req.signal, controller.signal]);
      const timeout = setTimeout(
        () => controller.abort(new DOMException('The folder inventory page timed out.', 'TimeoutError')),
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
            JSON.stringify({ error: 'Omni redirected the folder inventory request unexpectedly.' }),
            { status: 502, headers: jsonHeaders },
          );
        }

        if (!response.ok) {
          return new Response(
            JSON.stringify({
              error: `Omni folder read failed with HTTP ${response.status}.`,
            }),
            { status: response.status, headers: jsonHeaders }
          );
        }
        responseData = await raceWithAbortSignal(response.json(), requestSignal);
      } finally {
        clearTimeout(timeout);
      }

      const page = parseFolderPage(responseData);
      if (page === null) {
        return new Response(
          JSON.stringify({
            error: "Omni returned an unsupported folder response shape.",
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
              JSON.stringify({ error: "Omni returned inconsistent folder pagination evidence." }),
              { status: 502, headers: jsonHeaders }
            );
          }
        } else if (
          (totalMode === 'stable' && !stableTotal)
          || (totalMode === 'remaining' && !remainingTotal)
        ) {
          return new Response(
            JSON.stringify({ error: "Omni returned inconsistent folder pagination evidence." }),
            { status: 502, headers: jsonHeaders }
          );
        }
      }
      if (!collectFolderIds(page.records, seenFolderIds)) {
        return new Response(
          JSON.stringify({ error: "Omni returned malformed or duplicate folder records." }),
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
          JSON.stringify({ error: "Omni returned non-advancing folder pagination evidence." }),
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
        JSON.stringify({ error: "Omni returned inconsistent folder collection totals." }),
        { status: 502, headers: jsonHeaders }
      );
    }

    return new Response(
      JSON.stringify({
        folders: normalizeFolders(allRaw),
        pageInfo: lastPageInfo,
        pagesFetched,
        complete,
        loadedResults: allRaw.length,
        totalResults: totalRecords,
        ...(reachedSafetyLimit ? { reasonCode: "PAGINATION_SAFETY_LIMIT_REACHED" } : {}),
      }),
      {
        headers: jsonHeaders,
      }
      );
  } catch {
    return new Response(JSON.stringify({ error: "The Omni folder read could not be completed." }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
