import { validateBaseUrl, jsonHeaders } from '../security';

function getNestedString(obj: unknown, ...path: string[]): string | null {
  let current: unknown = obj;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

function findValueByKey(obj: unknown, keys: string[], maxDepth = 5): string | null {
  if (!obj || typeof obj !== "object" || maxDepth <= 0) return null;

  const record = obj as Record<string, unknown>;

  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string" && val.length > 0) return val;
  }

  for (const val of Object.values(record)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const found = findValueByKey(val, keys, maxDepth - 1);
      if (found) return found;
    }
  }

  return null;
}

function extractBaseModelId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;

  const sharedId =
    getNestedString(data, "dashboard", "sharedModelId") ??
    getNestedString(data, "dashboard", "model", "baseModelId") ??
    getNestedString(data, "document", "sharedModelId") ??
    getNestedString(data, "document", "baseModel", "id");

  if (sharedId) return sharedId;

  return findValueByKey(data, [
    "sharedModelId",
    "shared_model_id",
    "baseModelId",
    "base_model_id",
    "modelId",
    "model_id",
  ]);
}

function extractBaseModelName(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;

  return (
    getNestedString(data, "document", "baseModel", "name") ??
    getNestedString(data, "dashboard", "model", "name") ??
    getNestedString(data, "document", "model", "name") ??
    findValueByKey(data, ["modelName", "model_name"], 3)
  );
}

function extractTopicNames(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];

  const names = new Set<string>();
  const record = data as Record<string, unknown>;

  function walk(obj: unknown, depth: number): void {
    if (!obj || typeof obj !== "object" || depth <= 0) return;

    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth - 1);
      return;
    }

    const rec = obj as Record<string, unknown>;

    if (typeof rec.topicName === "string" && rec.topicName.length > 0) {
      names.add(rec.topicName);
    }
    if (typeof rec.topic_name === "string" && rec.topic_name.length > 0) {
      names.add(rec.topic_name);
    }

    for (const val of Object.values(rec)) {
      if (val && typeof val === "object") walk(val, depth - 1);
    }
  }

  walk(record, 8);
  return [...names];
}

function extractConnectionName(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;

  return (
    getNestedString(data, "document", "connection", "name") ??
    getNestedString(data, "dashboard", "connection", "name") ??
    null
  );
}

function extractConnectionId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;

  return (
    getNestedString(data, "document", "connection", "id") ??
    getNestedString(data, "document", "connectionId") ??
    getNestedString(data, "dashboard", "connection", "id") ??
    getNestedString(data, "dashboard", "connectionId") ??
    findValueByKey(data, ["connectionId", "connection_id"], 3)
  );
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { base_url, api_key, document_ids } = await req.json();

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key || !Array.isArray(document_ids)) {
      return new Response(
        JSON.stringify({ error: "base_url, api_key, and document_ids[] are required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");

    const results = await Promise.all(
      document_ids.map(async (id: string) => {
        try {
          const response = await fetch(
            `${cleanUrl}/api/unstable/documents/${id}/export`,
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${api_key}`,
                "Content-Type": "application/json",
              },
            }
          );

          if (!response.ok) {
            return { id, baseModelId: null, baseModelName: null, topicNames: null, connectionName: null, connectionId: null, enrichmentError: `Export API returned ${response.status}` };
          }

          const data = await response.json();
          const baseModelId = extractBaseModelId(data);
          const baseModelName = extractBaseModelName(data);
          const topicNames = extractTopicNames(data);
          const connectionName = extractConnectionName(data);
          const connectionId = extractConnectionId(data);
          return {
            id,
            baseModelId,
            baseModelName: baseModelName || null,
            topicNames: topicNames.length > 0 ? topicNames : null,
            connectionName: connectionName || null,
            connectionId: connectionId || null,
            enrichmentError: baseModelId ? null : "No model ID found in export payload",
          };
        } catch (err) {
          return {
            id,
            baseModelId: null,
            baseModelName: null,
            topicNames: null,
            connectionName: null,
            connectionId: null,
            enrichmentError: err instanceof Error ? err.message : "Export request failed",
          };
        }
      })
    );

    return new Response(JSON.stringify({ enrichments: results }), {
      headers: jsonHeaders,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return new Response(JSON.stringify({ error: message, enrichments: [] }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
