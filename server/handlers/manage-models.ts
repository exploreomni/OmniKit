import { validateBaseUrl, jsonHeaders } from '../security';

interface RequestBody {
  base_url: string;
  api_key: string;
  action: "create";
  connection_id: string;
  model_name: string;
  model_kind?: string;
  base_model_id?: string;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const body: RequestBody = await req.json();
    const { base_url, api_key, action } = body;

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key || !action) {
      return new Response(
        JSON.stringify({ error: "base_url, api_key, and action are required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");
    const authHeaders = {
      Authorization: `Bearer ${api_key}`,
      "Content-Type": "application/json",
    };

    if (action === "create") {
      if (!body.connection_id || !body.model_name) {
        return new Response(
          JSON.stringify({ error: "connection_id and model_name are required." }),
          { status: 400, headers: jsonHeaders }
        );
      }

      const payload: Record<string, unknown> = {
        connectionId: body.connection_id,
        modelName: body.model_name,
        modelKind: body.model_kind || "SHARED",
      };
      if (body.base_model_id) {
        payload.baseModelId = body.base_model_id;
      }

      const response = await fetch(`${cleanUrl}/api/v1/models`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.ok ? 200 : response.status,
        headers: jsonHeaders,
      });
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: jsonHeaders }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
