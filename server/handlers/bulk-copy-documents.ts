import { validateBaseUrl, jsonHeaders, sseHeaders } from '../security';

interface CopyRequest {
  base_url: string;
  api_key: string;
  document_ids: Array<{ id: string; name: string; base_model_id?: string }>;
  target_folder_path: string;
  target_folder_id?: string;
  scope?: string;
  base_model_id_override?: string;
  rename_suffix?: string;
}

interface CopyResult {
  success: boolean;
  error?: string;
  detail?: string;
  new_document_id?: string | null;
  steps?: Record<string, unknown>;
  request_payload?: unknown;
  response_body?: unknown;
  response_status?: number;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

const MODEL_ID_KEYS = new Set(["baseModelId", "base_model_id", "sharedModelId", "shared_model_id"]);
const ENVELOPE_CANDIDATES = ["dashboard", "document", "data", "export", "payload", "result"];

function ensureTopLevelModelId(obj: unknown, modelId: string): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  const record = obj as Record<string, unknown>;
  for (const key of MODEL_ID_KEYS) {
    if (key in record && typeof record[key] === "string" && (record[key] as string).length > 0) return;
  }
  record["baseModelId"] = modelId;
}

function renameDocumentInPayload(payload: unknown, newName: string): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const rec = payload as Record<string, unknown>;
  if (typeof rec.name === "string") rec.name = newName;
  if (typeof rec.title === "string") rec.title = newName;
  for (const candidate of ENVELOPE_CANDIDATES) {
    const inner = rec[candidate];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const innerRec = inner as Record<string, unknown>;
      if (typeof innerRec.name === "string") innerRec.name = newName;
      if (typeof innerRec.title === "string") innerRec.title = newName;
    }
  }
}

function extractNewDocumentIdentifier(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const workbook = b.workbook;
  if (workbook && typeof workbook === "object" && !Array.isArray(workbook)) {
    const wb = workbook as Record<string, unknown>;
    if (typeof wb.identifier === "string" && wb.identifier.length > 0) return wb.identifier;
    if (typeof wb.id === "string" && wb.id.length > 0) return wb.id;
  }
  const dashboard = b.dashboard;
  if (dashboard && typeof dashboard === "object" && !Array.isArray(dashboard)) {
    const dash = dashboard as Record<string, unknown>;
    if (typeof dash.identifier === "string" && dash.identifier.length > 0) return dash.identifier;
    if (typeof dash.id === "string" && dash.id.length > 0) return dash.id;
  }
  if (typeof b.identifier === "string" && b.identifier.length > 0) return b.identifier;
  if (typeof b.id === "string" && b.id.length > 0) return b.id;
  if (typeof b.slug === "string" && b.slug.length > 0) return b.slug;
  return null;
}

async function copyDocument(
  baseUrl: string,
  apiKey: string,
  documentId: string,
  documentName: string,
  folderPath: string,
  options: { scope?: string; baseModelIdOverride?: string; renameSuffix?: string }
): Promise<CopyResult> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const steps: Record<string, unknown> = {};

  // Step 1: Export
  let exportBody: unknown;
  try {
    const response = await fetchWithTimeout(
      `${cleanUrl}/api/unstable/documents/${documentId}/export`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      },
      30000
    );
    const body = await readBody(response);
    steps.export = { status: response.status, ok: response.ok };
    if (!response.ok) {
      return { success: false, error: `Export failed (${response.status})`, steps };
    }
    exportBody = body;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: `Export error: ${msg}`, steps };
  }

  // Step 2: Optionally apply baseModelId override and rename
  if (options.baseModelIdOverride) {
    ensureTopLevelModelId(exportBody, options.baseModelIdOverride);
  }
  if (options.renameSuffix && options.renameSuffix.trim().length > 0) {
    renameDocumentInPayload(exportBody, `${documentName}${options.renameSuffix}`);
  }

  // Step 3: Import (creates a NEW document — source remains untouched)
  let importBody: unknown;
  let importStatus = 0;
  let newIdentifier: string | null = null;
  try {
    const importUrl = new URL(`${cleanUrl}/api/unstable/documents/import`);
    if (options.scope) importUrl.searchParams.set("scope", options.scope);
    const response = await fetchWithTimeout(
      importUrl.toString(),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(exportBody),
      },
      30000
    );
    importBody = await readBody(response);
    importStatus = response.status;
    newIdentifier = extractNewDocumentIdentifier(importBody);
    steps.import = {
      status: response.status,
      ok: response.ok,
      new_identifier: newIdentifier,
    };
    if (!response.ok) {
      const errText =
        typeof importBody === "string"
          ? importBody.slice(0, 300)
          : JSON.stringify(importBody).slice(0, 300);
      return {
        success: false,
        error: `Import failed (${response.status}): ${errText}`,
        steps,
        response_body: importBody,
        response_status: importStatus,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: `Import error: ${msg}`, steps };
  }

  // Step 4: Move the new copy into the target folder (in place)
  if (!newIdentifier) {
    return {
      success: false,
      error: "Import succeeded but could not extract new document identifier",
      steps,
      response_body: importBody,
      response_status: importStatus,
    };
  }

  try {
    const movePayload: Record<string, unknown> = { folderPath };
    if (options.scope) movePayload.scope = options.scope;
    const response = await fetchWithTimeout(
      `${cleanUrl}/api/v1/documents/${newIdentifier}/move`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(movePayload),
      },
      15000
    );
    const body = await readBody(response);
    steps.move = {
      status: response.status,
      ok: response.ok,
      document_identifier: newIdentifier,
      folder_path: folderPath,
    };
    if (!response.ok) {
      const errText =
        typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
      return {
        success: false,
        error: `Copy succeeded but move to folder failed (${response.status}): ${errText}`,
        steps,
        new_document_id: newIdentifier,
        response_body: importBody,
        response_status: importStatus,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return {
      success: false,
      error: `Copy succeeded but move to folder errored: ${msg}`,
      steps,
      new_document_id: newIdentifier,
    };
  }

  return {
    success: true,
    detail: `Copied to ${folderPath}`,
    new_document_id: newIdentifier,
    steps,
    response_body: importBody,
    response_status: importStatus,
  };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const body: CopyRequest = await req.json();
    const {
      base_url,
      api_key,
      document_ids,
      target_folder_path,
      scope,
      base_model_id_override,
      rename_suffix,
    } = body;

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key) {
      return new Response(JSON.stringify({ error: "Credentials are required." }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    if (!document_ids || document_ids.length === 0) {
      return new Response(
        JSON.stringify({ error: "At least one document must be selected." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    if (target_folder_path === undefined || target_folder_path === null) {
      return new Response(JSON.stringify({ error: "Target folder is required." }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        function sendEvent(event: Record<string, unknown>) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }

        let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
        try {
          heartbeatInterval = setInterval(() => {
            sendEvent({ type: "heartbeat" });
          }, 5000);

          const results: Array<Record<string, unknown>> = [];
          let succeeded = 0;
          let failed = 0;

          for (let i = 0; i < document_ids.length; i++) {
            const doc = document_ids[i];

            sendEvent({
              type: "progress",
              document_id: doc.id,
              document_name: doc.name,
              status: "in_progress",
              index: i,
              total: document_ids.length,
            });

            const copyResult = await copyDocument(base_url, api_key, doc.id, doc.name, target_folder_path, {
              scope,
              baseModelIdOverride: base_model_id_override ?? doc.base_model_id,
              renameSuffix: rename_suffix,
            });

            const resultEntry = {
              id: doc.id,
              name: doc.name,
              status: copyResult.success ? "success" : "failed",
              error: copyResult.error,
              detail: copyResult.detail,
              new_document_id: copyResult.new_document_id,
              steps: copyResult.steps,
              request_payload: copyResult.request_payload,
              response_body: copyResult.response_body,
              response_status: copyResult.response_status,
            };

            if (copyResult.success) succeeded++;
            else failed++;

            results.push(resultEntry);

            sendEvent({
              type: "progress",
              ...resultEntry,
              index: i,
              total: document_ids.length,
            });
          }

          sendEvent({
            type: "complete",
            summary: { succeeded, failed, skipped: 0, total: document_ids.length },
            results,
          });
        } finally {
          if (heartbeatInterval) clearInterval(heartbeatInterval);
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        ...sseHeaders,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
