import { validateBaseUrl, jsonHeaders } from '../security';

export default async function handler(req: Request): Promise<Response> {
  try {
    const { base_url, api_key } = await req.json();

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(
        JSON.stringify({ status: "error", message: urlError }),
        { status: 400, headers: jsonHeaders }
      );
    }

    if (!api_key) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "Base URL and API key are required.",
        }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(`${cleanUrl}/api/v1/folders`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${api_key}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      return new Response(
        JSON.stringify({
          status: "error",
          message: `Connection failed (${response.status}). Check your base URL and API key.`,
          detail: text,
        }),
        { status: 200, headers: jsonHeaders }
      );
    }

    return new Response(
      JSON.stringify({ status: "ok", message: "Connected successfully." }),
      { headers: jsonHeaders }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return new Response(
      JSON.stringify({
        status: "error",
        message: `Could not connect. ${message}`,
      }),
      { status: 200, headers: jsonHeaders }
    );
  }
}
