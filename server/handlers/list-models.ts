import { validateBaseUrl, jsonHeaders } from '../security';

function extractArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["models", "data", "items", "results", "records"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    const firstArrayVal = Object.values(obj).find((v) => Array.isArray(v));
    if (firstArrayVal) return firstArrayVal as unknown[];
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractString(
  raw: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

function extractNestedString(
  raw: Record<string, unknown>,
  objKey: string,
  ...fields: string[]
): string {
  const nested = raw[objKey];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return "";
  return extractString(nested as Record<string, unknown>, ...fields);
}

function normalizeModel(raw: Record<string, unknown>) {
  const id = String(raw.id ?? "");
  const identifier = extractString(raw, "identifier", "slug", "key");
  const rawName = extractString(
    raw,
    "name",
    "label",
    "display_name",
    "displayName",
    "modelName",
    "model_name"
  );
  const isUuidName = UUID_RE.test(rawName);
  const name = (isUuidName ? "" : rawName) || identifier || id;

  const connectionId =
    extractString(raw, "connection_id", "connectionId") ||
    extractNestedString(raw, "connection", "id") ||
    undefined;

  const connectionName =
    extractString(raw, "connectionName", "connection_name") ||
    extractNestedString(raw, "connection", "name") ||
    undefined;

  const baseModelId =
    extractString(raw, "base_model_id", "baseModelId") ||
    extractNestedString(raw, "baseModel", "id") ||
    undefined;

  return {
    id,
    name,
    identifier,
    connectionId,
    connectionName,
    baseModelId,
    kind: extractString(raw, "kind", "model_kind", "modelKind", "type") || undefined,
  };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { base_url, api_key, model_kind, connection_id } = await req.json();

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
    const effectiveKind = model_kind || "SHARED";
    params.set("modelKind", effectiveKind);
    if (connection_id) {
      params.set("connectionId", connection_id);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(
      `${cleanUrl}/api/v1/models?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${api_key}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      return new Response(
        JSON.stringify({
          error: `Omni API returned ${response.status}.`,
          detail: text.slice(0, 500),
          models: [],
        }),
        { status: response.status, headers: jsonHeaders }
      );
    }

    const data = await response.json();
    const raw = extractArray(data);

    if (raw === null) {
      return new Response(
        JSON.stringify({
          error: "Could not find a model list in the Omni API response.",
          models: [],
        }),
        { headers: jsonHeaders }
      );
    }

    const models = raw.map((item) => normalizeModel(item as Record<string, unknown>));

    return new Response(JSON.stringify({ models }), {
      headers: jsonHeaders,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return new Response(JSON.stringify({ error: message, models: [] }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
