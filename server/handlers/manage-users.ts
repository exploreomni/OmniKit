import { validateBaseUrl, jsonHeaders } from '../security';

interface RequestBody {
  base_url: string;
  api_key: string;
  action: "list" | "find" | "create" | "update" | "delete";
  count?: number;
  start_index?: number;
  email?: string;
  user_id?: string;
  user_data?: Record<string, unknown>;
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
    const scimBase = `${cleanUrl}/api/scim/v2/users`;
    const authHeaders = {
      Authorization: `Bearer ${api_key}`,
      "Content-Type": "application/json",
    };

    let response: Response;

    switch (action) {
      case "list": {
        const count = body.count || 100;
        const startIndex = body.start_index || 1;
        response = await fetch(
          `${scimBase}?count=${count}&startIndex=${startIndex}`,
          { method: "GET", headers: authHeaders }
        );
        break;
      }

      case "find": {
        if (!body.email) {
          return new Response(
            JSON.stringify({ error: "email is required for find action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(
          `${scimBase}?filter=${encodeURIComponent(`userName eq "${body.email}"`)}`,
          { method: "GET", headers: authHeaders }
        );
        break;
      }

      case "create": {
        if (!body.user_data) {
          return new Response(
            JSON.stringify({ error: "user_data is required for create action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(scimBase, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(body.user_data),
        });
        break;
      }

      case "update": {
        if (!body.user_id || !body.user_data) {
          return new Response(
            JSON.stringify({ error: "user_id and user_data are required for update action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(`${scimBase}/${body.user_id}`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify(body.user_data),
        });
        break;
      }

      case "delete": {
        if (!body.user_id) {
          return new Response(
            JSON.stringify({ error: "user_id is required for delete action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(`${scimBase}/${body.user_id}`, {
          method: "DELETE",
          headers: authHeaders,
        });

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
