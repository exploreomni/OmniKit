import { validateBaseUrl, jsonHeaders } from '../security';

interface RequestBody {
  base_url: string;
  api_key: string;
  embed_data: Record<string, unknown>;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const body: RequestBody = await req.json();
    const { base_url, api_key, embed_data } = body;

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key || !embed_data) {
      return new Response(
        JSON.stringify({ error: "base_url, api_key, and embed_data are required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");
    const response = await fetch(`${cleanUrl}/embed/sso/generate-url`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(embed_data),
    });

    if (!response.ok) {
      const text = await response.text();
      return new Response(
        JSON.stringify({ error: `Embed URL generation failed (${response.status}): ${text.slice(0, 300)}` }),
        { status: response.status, headers: jsonHeaders }
      );
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), {
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
