import { validateBaseUrl, jsonHeaders } from '../security';

function extractSlug(folder: Record<string, unknown>): string {
  for (const key of ["identifier", "slug", "filePath", "file_path", "path"]) {
    const val = folder[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return "";
}

function extractId(folder: Record<string, unknown>): string {
  for (const key of ["id", "uuid", "folder_id", "folderId"]) {
    const val = folder[key];
    if (val !== null && val !== undefined && String(val).length > 0) return String(val);
  }
  const slug = extractSlug(folder);
  return slug;
}

function normalizeFolders(folders: unknown[], depth = 0): unknown[] {
  return folders.map((f) => {
    if (!f || typeof f !== "object") return f;
    const folder = f as Record<string, unknown>;
    const slug = extractSlug(folder);
    const id = extractId(folder);
    const children = Array.isArray(folder.children)
      ? normalizeFolders(folder.children as unknown[], depth + 1)
      : folder.children;
    const identifier = typeof folder.identifier === "string" && folder.identifier.length > 0
      ? folder.identifier
      : slug || undefined;
    if (depth === 0) {
      console.log("[list-folders] Raw folder sample keys:", Object.keys(folder));
      console.log("[list-folders] Raw folder sample:", JSON.stringify(folder).slice(0, 300));
    }
    return { ...folder, id, identifier, children };
  });
}

function extractArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["folders", "data", "items", "results", "records"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    const firstArrayVal = Object.values(obj).find((v) => Array.isArray(v));
    if (firstArrayVal) return firstArrayVal as unknown[];
  }
  return null;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { base_url, api_key } = await req.json();

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(`${cleanUrl}/api/v1/folders`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${api_key}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      return new Response(
        JSON.stringify({
          error: `Omni API returned ${response.status}. Check your base URL and API key.`,
          detail: text,
          folders: [],
        }),
        { status: response.status, headers: jsonHeaders }
      );
    }

    const data = await response.json();
    const folders = extractArray(data);

    if (folders === null) {
      return new Response(
        JSON.stringify({
          error: "Could not find a folder list in the Omni API response. The response shape may have changed.",
          rawResponse: data,
          folders: [],
        }),
        { headers: jsonHeaders }
      );
    }

    return new Response(JSON.stringify({ folders: normalizeFolders(folders) }), {
      headers: jsonHeaders,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return new Response(JSON.stringify({ error: message, folders: [] }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
