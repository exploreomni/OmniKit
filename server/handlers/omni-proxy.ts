import { validateBaseUrl, validateEndpoint, jsonHeaders } from '../security';

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

interface ProxyRequest {
  base_url: string;
  api_key: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  body?: unknown;
  query_params?: Record<string, string>;
  raw_response?: boolean;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const {
      base_url,
      api_key,
      method,
      endpoint,
      body,
      query_params,
      raw_response,
    }: ProxyRequest = await req.json();

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    const endpointError = validateEndpoint(endpoint);
    if (endpointError) {
      return new Response(JSON.stringify({ error: endpointError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key || !method) {
      return new Response(
        JSON.stringify({
          error: "base_url, api_key, method, and endpoint are required.",
        }),
        { status: 400, headers: jsonHeaders }
      );
    }

    if (!ALLOWED_METHODS.has(method)) {
      return new Response(
        JSON.stringify({ error: `Unsupported method: ${method}` }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");
    let url = `${cleanUrl}/api${endpoint}`;

    if (query_params && Object.keys(query_params).length > 0) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query_params)) {
        if (value !== undefined && value !== null && value !== "") {
          params.append(key, value);
        }
      }
      const qs = params.toString();
      if (qs) {
        url += `?${qs}`;
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${api_key}`,
    };

    if (body !== undefined && (method === "POST" || method === "PUT" || method === "PATCH")) {
      headers["Content-Type"] = "application/json";
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (body !== undefined && (method === "POST" || method === "PUT" || method === "PATCH")) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    if (raw_response) {
      const responseHeaders = new Headers();
      response.headers.forEach((value, key) => {
        if (
          key.toLowerCase() === "content-type" ||
          key.toLowerCase() === "content-disposition"
        ) {
          responseHeaders.set(key, value);
        }
      });
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      return new Response(
        JSON.stringify({
          error: `Omni returned an unexpected HTML response (HTTP ${response.status}). Check your Base URL.`,
        }),
        {
          status: 502,
          headers: jsonHeaders,
        }
      );
    }

    let responseBody;
    const text = await response.text();
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = { raw: text };
    }

    return new Response(JSON.stringify(responseBody), {
      status: response.status,
      headers: jsonHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Proxy request failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
