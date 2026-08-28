import { validateBaseUrl, jsonHeaders } from '../security';

interface RequestBody {
  base_url: string;
  api_key: string;
  action: "list" | "get" | "create" | "update" | "patch";
  count?: number;
  start_index?: number;
  group_id?: string;
  group_data?: Record<string, unknown>;
}

export interface ManageGroupsDependencies {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const GROUP_REQUEST_TIMEOUT_MS = 15_000;

class GroupTransportError extends Error {
  constructor(
    readonly status: 499 | 504,
    readonly code: "GROUP_REQUEST_CANCELLED" | "GROUP_REQUEST_TIMEOUT",
  ) {
    super(code);
    this.name = "GroupTransportError";
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

async function performGroupRequest(
  req: Request,
  url: string,
  init: RequestInit,
  dependencies: ManageGroupsDependencies,
): Promise<Response> {
  if (req.signal.aborted) {
    throw new GroupTransportError(499, "GROUP_REQUEST_CANCELLED");
  }

  const controller = new AbortController();
  let timedOut = false;
  let rejectBoundary: (reason: GroupTransportError) => void = () => undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const cancel = () => {
    controller.abort(req.signal.reason);
    rejectBoundary(new GroupTransportError(499, "GROUP_REQUEST_CANCELLED"));
  };
  req.signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectBoundary(new GroupTransportError(504, "GROUP_REQUEST_TIMEOUT"));
  }, dependencies.timeoutMs ?? GROUP_REQUEST_TIMEOUT_MS);

  const operation = (async () => {
    const response = await (dependencies.fetchImpl || fetch)(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return json({ error: `Omni group request failed with HTTP ${response.status}.` }, response.status);
    }
    if (response.status === 204) return json({ success: true });
    return json(await response.json());
  })();

  try {
    return await Promise.race([operation, boundary]);
  } catch (error) {
    if (error instanceof GroupTransportError) throw error;
    if (timedOut) throw new GroupTransportError(504, "GROUP_REQUEST_TIMEOUT");
    if (req.signal.aborted) throw new GroupTransportError(499, "GROUP_REQUEST_CANCELLED");
    throw error;
  } finally {
    clearTimeout(timeout);
    req.signal.removeEventListener("abort", cancel);
  }
}

export default async function handler(
  req: Request,
  dependencies: ManageGroupsDependencies = {},
): Promise<Response> {
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
    const scimBase = `${cleanUrl}/api/scim/v2/groups`;
    const authHeaders = {
      Authorization: `Bearer ${api_key}`,
      "Content-Type": "application/json",
    };

    let upstreamUrl = scimBase;
    let upstreamInit: RequestInit;

    switch (action) {
      case "list": {
        const count = body.count || 100;
        const startIndex = body.start_index || 1;
        upstreamUrl = `${scimBase}?count=${count}&startIndex=${startIndex}`;
        upstreamInit = { method: "GET", headers: authHeaders };
        break;
      }

      case "get": {
        if (!body.group_id) {
          return new Response(
            JSON.stringify({ error: "group_id is required for get action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        upstreamUrl = `${scimBase}/${encodeURIComponent(body.group_id)}`;
        upstreamInit = {
          method: "GET",
          headers: authHeaders,
        };
        break;
      }

      case "create": {
        if (!body.group_data) {
          return new Response(
            JSON.stringify({ error: "group_data is required for create action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        upstreamInit = {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(body.group_data),
        };
        break;
      }

      case "update": {
        if (!body.group_id || !body.group_data) {
          return new Response(
            JSON.stringify({ error: "group_id and group_data are required for update action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        upstreamUrl = `${scimBase}/${encodeURIComponent(body.group_id)}`;
        upstreamInit = {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify(body.group_data),
        };
        break;
      }

      case "patch": {
        if (!body.group_id || !body.group_data) {
          return new Response(
            JSON.stringify({ error: "group_id and group_data are required for patch action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        upstreamUrl = `${scimBase}/${encodeURIComponent(body.group_id)}`;
        upstreamInit = {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify(body.group_data),
        };
        break;
      }

      default:
        return new Response(
          JSON.stringify({ error: "Unknown action." }),
          { status: 400, headers: jsonHeaders }
        );
    }

    return await performGroupRequest(req, upstreamUrl, upstreamInit, dependencies);
  } catch (error) {
    if (error instanceof GroupTransportError) {
      const message = error.code === "GROUP_REQUEST_TIMEOUT"
        ? "The Omni group request timed out."
        : "The Omni group request was cancelled.";
      return json({ error: message, code: error.code }, error.status);
    }
    return new Response(JSON.stringify({ error: "The Omni group request could not be completed." }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
