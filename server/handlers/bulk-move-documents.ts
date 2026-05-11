import { validateBaseUrl, jsonHeaders, sseHeaders } from '../security';

interface MoveRequest {
  base_url: string;
  api_key: string;
  document_ids: Array<{ id: string; name: string; base_model_id?: string }>;
  target_folder_path: string;
  target_folder_id?: string;
  scope?: string;
}

interface MoveResult {
  success: boolean;
  error?: string;
  detail?: string;
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

async function moveDocument(
  baseUrl: string,
  apiKey: string,
  documentId: string,
  folderPath: string,
  scope?: string
): Promise<MoveResult> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const steps: Record<string, unknown> = {};

  const payload: Record<string, unknown> = { folderPath };
  if (scope) payload.scope = scope;

  try {
    const response = await fetchWithTimeout(
      `${cleanUrl}/api/v1/documents/${documentId}/move`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      15000
    );
    const body = await readBody(response);
    steps.move = {
      status: response.status,
      ok: response.ok,
      folder_path: folderPath,
    };

    if (!response.ok) {
      const errText =
        typeof body === "string"
          ? body.slice(0, 300)
          : JSON.stringify(body).slice(0, 300);
      return {
        success: false,
        error: `Move failed (${response.status}): ${errText}`,
        steps,
        request_payload: payload,
        response_body: body,
        response_status: response.status,
      };
    }

    return {
      success: true,
      detail: `Moved in place to ${folderPath}`,
      steps,
      request_payload: payload,
      response_body: body,
      response_status: response.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return {
      success: false,
      error: `Move error: ${msg}`,
      steps,
      request_payload: payload,
    };
  }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const body: MoveRequest = await req.json();
    const { base_url, api_key, document_ids, target_folder_path, scope } = body;

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key) {
      return new Response(
        JSON.stringify({ error: "Credentials are required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    if (!document_ids || document_ids.length === 0) {
      return new Response(
        JSON.stringify({ error: "At least one document must be selected." }),
        {
          status: 400,
          headers: jsonHeaders,
        }
      );
    }

    if (target_folder_path === undefined || target_folder_path === null) {
      return new Response(
        JSON.stringify({ error: "Target folder is required." }),
        {
          status: 400,
          headers: jsonHeaders,
        }
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        function sendEvent(event: Record<string, unknown>) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
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

            const moveResult = await moveDocument(
              base_url,
              api_key,
              doc.id,
              target_folder_path,
              scope
            );

            const resultEntry = {
              id: doc.id,
              name: doc.name,
              status: moveResult.success ? "success" : "failed",
              error: moveResult.error,
              detail: moveResult.detail,
              steps: moveResult.steps,
              request_payload: moveResult.request_payload,
              response_body: moveResult.response_body,
              response_status: moveResult.response_status,
            };

            if (moveResult.success) succeeded++;
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
            summary: {
              succeeded,
              failed,
              skipped: 0,
              total: document_ids.length,
            },
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
