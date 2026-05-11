import { validateBaseUrl, jsonHeaders, sseHeaders } from '../security';

interface DeleteRequest {
  base_url: string;
  api_key: string;
  document_ids: Array<{ id: string; name: string }>;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const body: DeleteRequest = await req.json();
    const { base_url, api_key, document_ids } = body;

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
        { status: 400, headers: jsonHeaders }
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

          const results: Array<{
            id: string;
            name: string;
            status: string;
            error?: string;
          }> = [];
          let succeeded = 0;
          let failed = 0;
          const cleanUrl = base_url.replace(/\/+$/, "");

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

            try {
              const response = await fetch(
                `${cleanUrl}/api/v1/documents/${doc.id}`,
                {
                  method: "DELETE",
                  headers: {
                    Authorization: `Bearer ${api_key}`,
                    "Content-Type": "application/json",
                  },
                }
              );

              if (response.ok || response.status === 204) {
                succeeded++;
                results.push({ id: doc.id, name: doc.name, status: "success" });
                sendEvent({
                  type: "progress",
                  document_id: doc.id,
                  document_name: doc.name,
                  status: "success",
                  index: i,
                  total: document_ids.length,
                });
              } else {
                const text = await response.text();
                failed++;
                results.push({
                  id: doc.id,
                  name: doc.name,
                  status: "failed",
                  error: `Delete failed (${response.status}): ${text.slice(0, 200)}`,
                });
                sendEvent({
                  type: "progress",
                  document_id: doc.id,
                  document_name: doc.name,
                  status: "failed",
                  error: `Delete failed (${response.status})`,
                  index: i,
                  total: document_ids.length,
                });
              }
            } catch (error) {
              failed++;
              const msg = error instanceof Error ? error.message : "Unknown error";
              results.push({ id: doc.id, name: doc.name, status: "failed", error: msg });
              sendEvent({
                type: "progress",
                document_id: doc.id,
                document_name: doc.name,
                status: "failed",
                error: msg,
                index: i,
                total: document_ids.length,
              });
            }
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
