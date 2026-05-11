import { validateBaseUrl, jsonHeaders } from '../security';

interface RequestBody {
  base_url: string;
  api_key: string;
  action: "list" | "get" | "create" | "update" | "delete";
  model_id: string;
  topic_name?: string;
  base_view_name?: string;
  topic_data?: Record<string, unknown>;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const body: RequestBody = await req.json();
    const { base_url, api_key, action, model_id } = body;

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key || !action || !model_id) {
      return new Response(
        JSON.stringify({ error: "base_url, api_key, action, and model_id are required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");
    const authHeaders = {
      Authorization: `Bearer ${api_key}`,
      "Content-Type": "application/json",
    };

    let response: Response;

    switch (action) {
      case "list": {
        response = await fetch(
          `${cleanUrl}/api/v1/models/${model_id}/yaml`,
          { method: "GET", headers: authHeaders }
        );
        const yamlData = await response.json();
        const topics: Array<{ name: string; label?: string; description?: string }> = [];

        if (yamlData && typeof yamlData === "object" && yamlData.files && typeof yamlData.files === "object") {
          const files = yamlData.files as Record<string, string>;
          for (const [filePath, content] of Object.entries(files)) {
            const fileName = filePath.split("/").pop() ?? filePath;
            if (!fileName.endsWith(".topic")) continue;

            const topicName = fileName.replace(/\.topic$/, "");
            if (!topicName) continue;

            let label: string | undefined;
            let description: string | undefined;

            if (typeof content === "string") {
              const labelMatch = content.match(/^label:\s*["']?(.+?)["']?\s*$/m);
              if (labelMatch) label = labelMatch[1].trim();

              const descMatch = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
              if (descMatch) description = descMatch[1].trim();
            }

            topics.push({ name: topicName, ...(label ? { label } : {}), ...(description ? { description } : {}) });
          }
        }

        return new Response(JSON.stringify({ topics }), {
          status: response.ok ? 200 : response.status,
          headers: jsonHeaders,
        });
      }

      case "get": {
        if (!body.topic_name) {
          return new Response(
            JSON.stringify({ error: "topic_name is required for get action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(
          `${cleanUrl}/api/v1/models/${model_id}/topic/${encodeURIComponent(body.topic_name)}`,
          { method: "GET", headers: authHeaders }
        );
        const getData = await response.json();
        const topicData = getData.success !== false ? (getData.topic || getData) : getData;
        return new Response(JSON.stringify(topicData), {
          status: response.ok ? 200 : response.status,
          headers: jsonHeaders,
        });
      }

      case "create": {
        if (!body.base_view_name) {
          return new Response(
            JSON.stringify({ error: "base_view_name is required for create action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        const createPayload = {
          ...(body.topic_data || {}),
          baseViewName: body.base_view_name,
        };
        response = await fetch(
          `${cleanUrl}/api/v1/models/${model_id}/topic`,
          {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify(createPayload),
          }
        );
        break;
      }

      case "update": {
        if (!body.topic_name) {
          return new Response(
            JSON.stringify({ error: "topic_name is required for update action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(
          `${cleanUrl}/api/v1/models/${model_id}/topic/${encodeURIComponent(body.topic_name)}`,
          {
            method: "PATCH",
            headers: authHeaders,
            body: JSON.stringify(body.topic_data || {}),
          }
        );
        break;
      }

      case "delete": {
        if (!body.topic_name) {
          return new Response(
            JSON.stringify({ error: "topic_name is required for delete action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(
          `${cleanUrl}/api/v1/models/${model_id}/topic/${encodeURIComponent(body.topic_name)}`,
          { method: "DELETE", headers: authHeaders }
        );

        if (response.status === 204) {
          return new Response(
            JSON.stringify({ success: true }),
            { headers: jsonHeaders }
          );
        }
        break;
      }

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: jsonHeaders }
        );
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: response.ok ? 200 : response.status,
      headers: jsonHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
