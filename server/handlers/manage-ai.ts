import { validateBaseUrl, jsonHeaders } from '../security';

type AiAction = 'pick-topic' | 'create-job' | 'get-job' | 'get-job-result' | 'cancel-job';

interface RequestBody {
  base_url: string;
  api_key: string;
  action: AiAction;
  model_id?: string;
  prompt?: string;
  topic_name?: string;
  potential_topic_names?: string[];
  current_topic_name?: string;
  branch_id?: string;
  conversation_id?: string;
  job_id?: string;
  user_id?: string;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return { success: true };
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function requireField(body: RequestBody, field: keyof RequestBody): string | Response {
  const value = body[field];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return new Response(
    JSON.stringify({ error: `${field} is required.` }),
    { status: 400, headers: jsonHeaders }
  );
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
        JSON.stringify({ error: 'base_url, api_key, and action are required.' }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, '');
    const authHeaders = {
      Authorization: `Bearer ${api_key}`,
      'Content-Type': 'application/json',
    };

    let response: Response;

    switch (action) {
      case 'pick-topic': {
        const modelId = requireField(body, 'model_id');
        if (modelId instanceof Response) return modelId;
        const prompt = requireField(body, 'prompt');
        if (prompt instanceof Response) return prompt;

        const payload: Record<string, unknown> = {
          modelId,
          prompt,
        };
        if (body.branch_id) payload.branchId = body.branch_id;
        if (body.current_topic_name) payload.currentTopicName = body.current_topic_name;
        if (Array.isArray(body.potential_topic_names) && body.potential_topic_names.length > 0) {
          payload.potentialTopicNames = body.potential_topic_names;
        }
        if (body.user_id) payload.userId = body.user_id;

        response = await fetch(`${cleanUrl}/api/v1/ai/pick-topic`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(payload),
        });
        break;
      }

      case 'create-job': {
        const modelId = requireField(body, 'model_id');
        if (modelId instanceof Response) return modelId;
        const prompt = requireField(body, 'prompt');
        if (prompt instanceof Response) return prompt;

        const payload: Record<string, unknown> = {
          modelId,
          prompt,
        };
        if (body.topic_name) payload.topicName = body.topic_name;
        if (body.branch_id) payload.branchId = body.branch_id;
        if (body.conversation_id) payload.conversationId = body.conversation_id;

        const params = new URLSearchParams();
        if (body.user_id) params.set('userId', body.user_id);
        const query = params.toString();

        response = await fetch(`${cleanUrl}/api/v1/ai/jobs${query ? `?${query}` : ''}`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(payload),
        });
        break;
      }

      case 'get-job': {
        const jobId = requireField(body, 'job_id');
        if (jobId instanceof Response) return jobId;
        response = await fetch(`${cleanUrl}/api/v1/ai/jobs/${encodeURIComponent(jobId)}`, {
          method: 'GET',
          headers: authHeaders,
        });
        break;
      }

      case 'get-job-result': {
        const jobId = requireField(body, 'job_id');
        if (jobId instanceof Response) return jobId;
        response = await fetch(`${cleanUrl}/api/v1/ai/jobs/${encodeURIComponent(jobId)}/result`, {
          method: 'GET',
          headers: authHeaders,
        });
        break;
      }

      case 'cancel-job': {
        const jobId = requireField(body, 'job_id');
        if (jobId instanceof Response) return jobId;
        response = await fetch(`${cleanUrl}/api/v1/ai/jobs/${encodeURIComponent(jobId)}/cancel`, {
          method: 'POST',
          headers: authHeaders,
        });
        break;
      }

      default:
        return new Response(
          JSON.stringify({ error: `Unknown AI action: ${action}` }),
          { status: 400, headers: jsonHeaders }
        );
    }

    const data = await readJson(response);
    return new Response(JSON.stringify(data), {
      status: response.ok ? response.status : response.status,
      headers: jsonHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
