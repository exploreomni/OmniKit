import { validateBaseUrl, jsonHeaders } from '../security';

const MODEL_ID_KEYS = new Set([
  "baseModelId",
  "base_model_id",
  "modelId",
  "model_id",
  "sharedModelId",
  "shared_model_id",
]);

interface ModelIdLocation {
  path: string;
  key: string;
  value: string;
}

function findAllModelIds(
  obj: unknown,
  currentPath = "",
  maxDepth = 10
): ModelIdLocation[] {
  const results: ModelIdLocation[] = [];
  if (!obj || typeof obj !== "object" || maxDepth <= 0) return results;

  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => {
      results.push(
        ...findAllModelIds(item, `${currentPath}[${idx}]`, maxDepth - 1)
      );
    });
    return results;
  }

  const record = obj as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    const path = currentPath ? `${currentPath}.${key}` : key;
    if (MODEL_ID_KEYS.has(key) && typeof val === "string" && val.length > 0) {
      results.push({ path, key, value: val });
    }
    if (val && typeof val === "object") {
      results.push(...findAllModelIds(val, path, maxDepth - 1));
    }
  }
  return results;
}

function findNullOrUndefinedFields(
  obj: unknown,
  currentPath = "",
  maxDepth = 3
): string[] {
  const results: string[] = [];
  if (!obj || typeof obj !== "object" || maxDepth <= 0) return results;
  if (Array.isArray(obj)) return results;

  const record = obj as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    const path = currentPath ? `${currentPath}.${key}` : key;
    if (val === null || val === undefined) {
      results.push(path);
    } else if (typeof val === "object" && !Array.isArray(val)) {
      results.push(...findNullOrUndefinedFields(val, path, maxDepth - 1));
    }
  }
  return results;
}

function detectEnvelopePattern(
  obj: unknown
): { pattern: string; innerKeys: string[] } | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record);

  const wrapperCandidates = ["dashboard", "document", "data", "export", "payload", "result"];
  for (const candidate of wrapperCandidates) {
    if (
      keys.length <= 3 &&
      candidate in record &&
      record[candidate] &&
      typeof record[candidate] === "object" &&
      !Array.isArray(record[candidate])
    ) {
      const inner = record[candidate] as Record<string, unknown>;
      return {
        pattern: `{ ${candidate}: {...} }`,
        innerKeys: Object.keys(inner),
      };
    }
  }

  return null;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { base_url, api_key, document_id } = await req.json();

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key || !document_id) {
      return new Response(
        JSON.stringify({
          error: "base_url, api_key, and document_id are required.",
        }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let response: Response;
    try {
      response = await fetch(
        `${cleanUrl}/api/unstable/documents/${document_id}/export`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${api_key}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text();
      return new Response(
        JSON.stringify({
          error: `Export request failed (${response.status})`,
          detail: text.slice(0, 500),
        }),
        {
          status: 200,
          headers: jsonHeaders,
        }
      );
    }

    const rawPayload = await response.json();
    const topLevelKeys = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? Object.keys(rawPayload)
      : [];

    const modelIdLocations = findAllModelIds(rawPayload);
    const hasTopLevelModelId = modelIdLocations.some(
      (loc) => !loc.path.includes(".")
    );
    const envelope = detectEnvelopePattern(rawPayload);
    const nullFields = findNullOrUndefinedFields(rawPayload);

    const payloadStr = JSON.stringify(rawPayload);

    const diagnostics = {
      topLevelKeys,
      payloadSizeBytes: payloadStr.length,
      modelIdLocations,
      modelIdCount: modelIdLocations.length,
      hasTopLevelModelId,
      envelopePattern: envelope,
      nullOrUndefinedFields: nullFields.slice(0, 20),
    };

    return new Response(
      JSON.stringify({
        documentId: document_id,
        diagnostics,
        rawPayload,
      }),
      {
        headers: jsonHeaders,
      }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
