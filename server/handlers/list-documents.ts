import { validateBaseUrl, jsonHeaders } from '../security';

function extractArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["documents", "dashboards", "data", "items", "results", "records"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    const firstArrayVal = Object.values(obj).find((v) => Array.isArray(v));
    if (firstArrayVal) return firstArrayVal as unknown[];
  }
  return null;
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
    baseModelId,
    folderId: String(raw.folder_id ?? raw.folderId ?? "") || undefined,
    folderPath: String(raw.folder_path ?? raw.folderPath ?? raw.path ?? "") || undefined,
    type: String(raw.type ?? raw.kind ?? "") || undefined,
  };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { base_url, api_key, folder_id } = await req.json();

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
    const params = new URLSearchParams();
    if (folder_id) {
      params.set("folderId", folder_id);
    }

    const url = `${cleanUrl}/api/v1/documents${params.toString() ? `?${params.toString()}` : ""}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
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
          error: `Omni API returned ${response.status}.`,
          detail: text.slice(0, 500),
          documents: [],
        }),
        { status: response.status, headers: jsonHeaders }
      );
    }

    const data = await response.json();
    const raw = extractArray(data);

    if (raw && raw.length > 0) {
      const sample = raw[0] as Record<string, unknown>;
      console.log("[list-documents] Raw API sample keys:", Object.keys(sample));
      console.log("[list-documents] Raw API sample:", JSON.stringify(sample).slice(0, 500));
    }

    if (raw === null) {
      return new Response(
        JSON.stringify({
          error: "Could not find a document list in the Omni API response.",
          documents: [],
        }),
        { headers: jsonHeaders }
      );
    }

    const documents = raw
      .map((item) => normalizeDocument(item as Record<string, unknown>))
      .filter((d) => !d.type || d.type === "dashboard");

    return new Response(JSON.stringify({ documents }), {
      headers: jsonHeaders,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return new Response(JSON.stringify({ error: message, documents: [] }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
