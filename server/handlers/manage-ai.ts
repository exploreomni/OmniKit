import { assertSafeOutboundUrl, validateBaseUrl, jsonHeaders } from '../security';
import { requestOmniJson, type OmniJsonRequest, type OmniJsonResponse } from '../services/omniJsonTransport';
import { aiPromptSecurityError } from '../services/aiPromptSecurity';
import {
  AI_PROMPT_MAX_CHARACTERS,
  AI_REQUEST_BODY_MAX_CHARACTERS,
} from '../../src/services/aiPromptSecurityShared';

export { createPublicOnlyLookup as createAiPublicOnlyLookup, readBoundedJson } from '../services/omniJsonTransport';

type AiAction =
  | 'pick-topic'
  | 'create-job'
  | 'get-job'
  | 'get-job-result'
  | 'get-content-studio-job-result'
  | 'cancel-job'
  | 'verify-content-document'
  | 'trash-content-document';

interface AiAttachment {
  data: string;
  mimeType: string;
  name?: string;
}

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
  document_id?: string;
  user_id?: string;
  attachments?: unknown;
  response_contract?: string;
}

const MEBIBYTE = 1024 * 1024;
const AI_ATTACHMENT_MAX_COUNT = 5;
const AI_IMAGE_ATTACHMENT_MAX_RAW_BYTES = 3 * MEBIBYTE;
const AI_ATTACHMENTS_MAX_COMBINED_RAW_BYTES = 15 * MEBIBYTE;
const AI_ATTACHMENT_REQUEST_BODY_MAX_CHARACTERS =
  AI_REQUEST_BODY_MAX_CHARACTERS
  + Math.ceil(AI_ATTACHMENTS_MAX_COMBINED_RAW_BYTES / 3) * 4
  + 8_192;
const AI_UPSTREAM_RESPONSE_MAX_BYTES = 2 * MEBIBYTE;
const AI_CONTENT_STUDIO_UPSTREAM_RESPONSE_MAX_BYTES = 16 * MEBIBYTE;
const AI_UPSTREAM_TIMEOUT_MS = 60_000;
const AI_ATTACHMENT_NAME_MAX_CHARACTERS = 255;
const AI_CONTENT_STUDIO_MAX_ACTIONS = 100;
const AI_CONTENT_STUDIO_MAX_MESSAGE_CHARACTERS = 50_000;
const AI_CONTENT_STUDIO_MAX_ACTION_MESSAGE_CHARACTERS = 2_000;
const AI_CONTENT_STUDIO_MAX_TOPIC_CHARACTERS = 1_024;
const AI_CONTENT_STUDIO_MAX_CHAT_URL_CHARACTERS = 2_048;
const AI_CONTENT_STUDIO_MAX_ACTION_TYPE_CHARACTERS = 100;
const AI_CONTENT_STUDIO_MAX_TIMESTAMP_CHARACTERS = 100;
const AI_CONTENT_STUDIO_MAX_DOCUMENT_ID_CHARACTERS = 200;
const AI_CONTENT_STUDIO_MAX_DOCUMENT_NAME_CHARACTERS = 254;
const AI_CONTENT_STUDIO_MAX_DOCUMENT_QUERIES = 1_000;
const AI_CONTENT_STUDIO_MAX_QUERY_PRESENTATIONS = 1_000;
const AI_CONTENT_STUDIO_MAX_LAYOUT_CONTAINERS = 1_000;
const AI_CONTENT_STUDIO_MAX_ACCESS_PAGES = 100;
const AI_CONTENT_STUDIO_MAX_ACCESS_GRANTS = 10_000;
const AI_CONTENT_STUDIO_MAX_ACCESS_CURSOR_CHARACTERS = 4_096;
const AI_CONTENT_STUDIO_MAX_VALIDATION_ISSUES = 500;
const AI_CONTENT_STUDIO_MAX_VALIDATION_ISSUE_CHARACTERS = 2_000;
const AI_CONTENT_STUDIO_RESPONSE_CONTRACT = 'ai-content-studio-v1';
const AI_CONTENT_STUDIO_RESULT_CONTRACT_MISMATCH = 'AI_RESULT_CONTRACT_MISMATCH';
const AI_CONTENT_STUDIO_COMPLETE_NO_USABLE_RESULT = 'COMPLETE_NO_USABLE_RESULT';
const AI_CONTENT_STUDIO_MAX_PROJECTION_ISSUES = 16;
const AI_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AI_JOB_STATES = new Set(['CANCELLED', 'COMPLETE', 'DELIVERING', 'EXECUTING', 'FAILED', 'QUEUED']);
const NEUTRAL_DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const QUERY_PRESENTATION_RECORD_KEY = /^[1-9][0-9]*$/;
const AI_CONTENT_STUDIO_QUERY_PRESENTATION_TYPES = new Set([
  'blank', 'csv', 'query', 'dataset', 'spreadsheet', 'sql', 'dbt', 'query-view', 'linked', 'app',
]);
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
]);
const REQUEST_BODY_KEYS = new Set([
  'base_url', 'api_key', 'action', 'model_id', 'prompt', 'topic_name',
  'potential_topic_names', 'current_topic_name', 'branch_id',
  'conversation_id', 'job_id', 'user_id', 'attachments', 'response_contract',
  'document_id',
]);

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

async function readBoundedRequestText(req: Request): Promise<string | Response> {
  const declaredLength = Number(req.headers.get('content-length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > AI_ATTACHMENT_REQUEST_BODY_MAX_CHARACTERS) {
    return jsonResponse(
      { error: `AI request exceeds the ${AI_ATTACHMENT_REQUEST_BODY_MAX_CHARACTERS.toLocaleString()} character attachment request limit.` },
      413,
    );
  }

  if (!req.body) return '';
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > AI_ATTACHMENT_REQUEST_BODY_MAX_CHARACTERS) {
        await reader.cancel().catch(() => undefined);
        return jsonResponse(
          { error: `AI request exceeds the ${AI_ATTACHMENT_REQUEST_BODY_MAX_CHARACTERS.toLocaleString()} character attachment request limit.` },
          413,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

function requireField(body: RequestBody, field: keyof RequestBody): string | Response {
  const value = body[field];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return jsonResponse({ error: `${field} is required.` }, 400);
}

function rejectUnsafePrompt(prompt: string): Response | null {
  if (prompt.length > AI_PROMPT_MAX_CHARACTERS) {
    return jsonResponse(
      { error: `AI prompt exceeds the ${AI_PROMPT_MAX_CHARACTERS.toLocaleString()} character server limit.` },
      413,
    );
  }
  const error = aiPromptSecurityError(prompt);
  return error ? jsonResponse({ error }, 400) : null;
}

function rejectOversizedMetadata(body: RequestBody): Response | null {
  const limits: Array<[keyof RequestBody, number]> = [
    ['base_url', 2_048],
    ['api_key', 8_192],
    ['model_id', 1_024],
    ['topic_name', 1_024],
    ['current_topic_name', 1_024],
    ['branch_id', 1_024],
    ['conversation_id', 1_024],
    ['job_id', 1_024],
    ['document_id', AI_CONTENT_STUDIO_MAX_DOCUMENT_ID_CHARACTERS],
    ['user_id', 1_024],
    ['response_contract', 100],
  ];
  for (const [field, maximum] of limits) {
    const value = body[field];
    if (value !== undefined && typeof value !== 'string') {
      return jsonResponse({ error: `${field} must be a string.` }, 400);
    }
    if (typeof value === 'string' && value.length > maximum) {
      return jsonResponse({ error: `${field} exceeds the ${maximum.toLocaleString()} character limit.` }, 413);
    }
  }
  if (body.prompt !== undefined && typeof body.prompt !== 'string') {
    return jsonResponse({ error: 'prompt must be a string.' }, 400);
  }
  if (body.action !== undefined && typeof body.action !== 'string') {
    return jsonResponse({ error: 'action must be a string.' }, 400);
  }
  if (body.potential_topic_names !== undefined) {
    if (
      !Array.isArray(body.potential_topic_names)
      || body.potential_topic_names.length > 100
      || body.potential_topic_names.some((value) => typeof value !== 'string' || value.length > 1_024)
    ) {
      return jsonResponse({ error: 'potential_topic_names must contain at most 100 bounded strings.' }, 400);
    }
  }
  return null;
}

function isCanonicalBase64(data: string): boolean {
  if (!data || data.length % 4 !== 0) return false;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const contentLength = data.length - padding;
  let lastValue = 0;
  for (let index = 0; index < contentLength; index += 1) {
    const code = data.charCodeAt(index);
    const valid = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!valid) return false;
    lastValue = code >= 65 && code <= 90
      ? code - 65
      : code >= 97 && code <= 122
        ? code - 71
        : code >= 48 && code <= 57
          ? code + 4
          : code === 43 ? 62 : 63;
  }
  for (let index = contentLength; index < data.length; index += 1) {
    if (data.charCodeAt(index) !== 61) return false;
  }
  if ((padding === 2 && (lastValue & 15) !== 0) || (padding === 1 && (lastValue & 3) !== 0)) return false;
  return true;
}

function decodedBase64ByteLength(data: string): number | null {
  if (!isCanonicalBase64(data)) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function attachmentMagicMatches(data: string, mimeType: string): boolean {
  const bytes = Buffer.from(data, 'base64');
  const startsWith = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (mimeType === 'image/png') return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mimeType === 'image/jpeg') return startsWith(0xff, 0xd8, 0xff);
  if (mimeType === 'image/gif') {
    return bytes.subarray(0, 6).toString('ascii') === 'GIF87a'
      || bytes.subarray(0, 6).toString('ascii') === 'GIF89a';
  }
  if (mimeType === 'image/webp') {
    return bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  return false;
}

function validateAttachments(value: unknown): AiAttachment[] | Response {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return jsonResponse({ error: 'attachments must be an array.' }, 400);
  if (value.length > AI_ATTACHMENT_MAX_COUNT) {
    return jsonResponse({ error: `A maximum of ${AI_ATTACHMENT_MAX_COUNT} attachments is allowed.` }, 413);
  }

  const attachments: AiAttachment[] = [];
  let combinedRawBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return jsonResponse({ error: `Attachment ${index + 1} must be an object.` }, 400);
    }
    const record = item as Record<string, unknown>;
    const unexpectedKeys = Object.keys(record).filter((key) => !['data', 'mimeType', 'name'].includes(key));
    if (unexpectedKeys.length > 0) {
      return jsonResponse({ error: `Attachment ${index + 1} contains unsupported fields.` }, 400);
    }
    if (typeof record.data !== 'string') {
      return jsonResponse({ error: `Attachment ${index + 1} data must be a base64 string.` }, 400);
    }
    if (typeof record.mimeType !== 'string' || !ALLOWED_ATTACHMENT_MIME_TYPES.has(record.mimeType)) {
      return jsonResponse({ error: `Attachment ${index + 1} has an unsupported MIME type.` }, 400);
    }
    if (record.name !== undefined && (
      typeof record.name !== 'string'
      || !record.name.trim()
      || record.name.length > AI_ATTACHMENT_NAME_MAX_CHARACTERS
      || /[\0\r\n]/.test(record.name)
    )) {
      return jsonResponse({ error: `Attachment ${index + 1} has an invalid name.` }, 400);
    }

    const rawBytes = decodedBase64ByteLength(record.data);
    if (rawBytes == null) {
      return jsonResponse({ error: `Attachment ${index + 1} data must be canonical base64 without a data-URL prefix.` }, 400);
    }
    if (record.mimeType.startsWith('image/') && rawBytes > AI_IMAGE_ATTACHMENT_MAX_RAW_BYTES) {
      return jsonResponse({ error: `Image attachment ${index + 1} exceeds the 3 MiB raw file limit.` }, 413);
    }
    if (!attachmentMagicMatches(record.data, record.mimeType)) {
      return jsonResponse({ error: `Attachment ${index + 1} content does not match its declared MIME type.` }, 400);
    }
    combinedRawBytes += rawBytes;
    if (combinedRawBytes > AI_ATTACHMENTS_MAX_COMBINED_RAW_BYTES) {
      return jsonResponse({ error: 'Attachments exceed the 15 MiB combined raw file limit.' }, 413);
    }

    attachments.push({
      data: record.data,
      mimeType: record.mimeType,
      ...(typeof record.name === 'string' ? { name: record.name.trim() } : {}),
    });
  }
  return attachments;
}

function invalidContentStudioResult(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error('invalid-content-studio-result'), {
    statusCode: 422,
    code: AI_CONTENT_STUDIO_RESULT_CONTRACT_MISMATCH,
  });
}

type AiContentStudioProjectionIssue =
  | 'MESSAGE_DROPPED'
  | 'RESULT_SUMMARY_DROPPED'
  | 'ACTIONS_DROPPED'
  | 'ACTION_DROPPED'
  | 'ACTION_DROPPED_NOT_OBJECT'
  | 'ACTION_DROPPED_INVALID_TYPE'
  | 'ACTION_DROPPED_MISSING_MESSAGE'
  | 'ACTION_DROPPED_INVALID_MESSAGE_TYPE'
  | 'ACTION_DROPPED_OVERSIZED_MESSAGE'
  | 'ACTION_DROPPED_INVALID_TIMESTAMP'
  | 'ACTIONS_TRUNCATED'
  | 'TOPIC_DROPPED'
  | 'OMNI_CHAT_URL_DROPPED';

interface AiContentStudioOptionalString {
  value?: string;
  dropped: boolean;
}

function optionalContentStudioString(
  value: unknown,
  maximumCharacters: number,
): AiContentStudioOptionalString {
  if (value == null) return { dropped: false };
  if (typeof value !== 'string') return { dropped: true };
  const trimmed = value.trim();
  if (!trimmed) return { dropped: false };
  if (trimmed.length > maximumCharacters) return { dropped: true };
  return { value: trimmed, dropped: false };
}

interface AiContentStudioActionMessage {
  value?: string;
  issue?: Extract<
    AiContentStudioProjectionIssue,
    | 'ACTION_DROPPED_MISSING_MESSAGE'
    | 'ACTION_DROPPED_INVALID_MESSAGE_TYPE'
    | 'ACTION_DROPPED_OVERSIZED_MESSAGE'
  >;
}

function contentStudioActionMessage(value: unknown): AiContentStudioActionMessage {
  if (value == null) return { issue: 'ACTION_DROPPED_MISSING_MESSAGE' };
  if (typeof value !== 'string') return { issue: 'ACTION_DROPPED_INVALID_MESSAGE_TYPE' };
  if (value.length > AI_CONTENT_STUDIO_MAX_ACTION_MESSAGE_CHARACTERS) {
    return { issue: 'ACTION_DROPPED_OVERSIZED_MESSAGE' };
  }
  // Omni's live action stream can use an empty message for otherwise valid
  // search/query progress actions. Preserve that bounded envelope so the
  // client can classify the action type instead of treating it as data loss.
  return { value: value.trim() };
}

function projectedDocumentId(action: Record<string, unknown>): string | undefined {
  const result = action.result && typeof action.result === 'object' && !Array.isArray(action.result)
    ? action.result as Record<string, unknown>
    : undefined;
  const resultDocument = result?.document && typeof result.document === 'object' && !Array.isArray(result.document)
    ? result.document as Record<string, unknown>
    : undefined;
  const actionDocument = action.document && typeof action.document === 'object' && !Array.isArray(action.document)
    ? action.document as Record<string, unknown>
    : undefined;
  const candidates = [
    action.documentId,
    action.document_id,
    result?.documentId,
    result?.document_id,
    resultDocument?.id,
    resultDocument?.identifier,
    actionDocument?.id,
    actionDocument?.identifier,
  ];
  return candidates.find((candidate): candidate is string => (
    typeof candidate === 'string'
    && candidate.length <= AI_CONTENT_STUDIO_MAX_DOCUMENT_ID_CHARACTERS
    && NEUTRAL_DOCUMENT_ID.test(candidate)
  ));
}

/**
 * Projects the documented result contract to the fields AI Content Studio renders.
 * Query definitions, CSV rows, and all other action result payloads stay server-side.
 */
function contentStudioResultChatUrl(baseUrl: string, value: unknown): AiContentStudioOptionalString {
  const projected = optionalContentStudioString(
    value,
    AI_CONTENT_STUDIO_MAX_CHAT_URL_CHARACTERS,
  );
  if (projected.dropped || !projected.value) return projected;
  try {
    const expected = new URL(baseUrl);
    const parsed = new URL(projected.value);
    const sameOrigin = expected.origin === parsed.origin;
    const expectedTenant = standardOmniTenant(expected.hostname);
    const candidateTenant = standardOmniTenant(parsed.hostname);
    const sameStandardTenant = expected.port === ''
      && parsed.port === ''
      && expectedTenant !== ''
      && expectedTenant === candidateTenant;
    if (
      expected.protocol !== 'https:'
      || parsed.protocol !== 'https:'
      || expected.username
      || expected.password
      || parsed.username
      || parsed.password
      || (!sameOrigin && !sameStandardTenant)
    ) return { dropped: true };
    return { value: `${parsed.origin}${parsed.pathname}`, dropped: false };
  } catch {
    return { dropped: true };
  }
}

function completeNoUsableContentStudioResult(
  projectionIssues: AiContentStudioProjectionIssue[],
): Error & { statusCode: number; code: string; projectionIssues: AiContentStudioProjectionIssue[] } {
  return Object.assign(new Error('complete-no-usable-content-studio-result'), {
    statusCode: 422,
    code: AI_CONTENT_STUDIO_COMPLETE_NO_USABLE_RESULT,
    projectionIssues,
  });
}

function projectAiContentStudioResult(value: unknown, baseUrl: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidContentStudioResult();
  const result = value as Record<string, unknown>;
  const projectionIssues: AiContentStudioProjectionIssue[] = [];
  const addProjectionIssue = (issue: AiContentStudioProjectionIssue) => {
    if (
      projectionIssues.length < AI_CONTENT_STUDIO_MAX_PROJECTION_ISSUES
      && !projectionIssues.includes(issue)
    ) projectionIssues.push(issue);
  };

  const projectedMessage = optionalContentStudioString(
    result.message,
    AI_CONTENT_STUDIO_MAX_MESSAGE_CHARACTERS,
  );
  if (projectedMessage.dropped) addProjectionIssue('MESSAGE_DROPPED');
  const projectedResultSummary = optionalContentStudioString(
    result.resultSummary,
    AI_CONTENT_STUDIO_MAX_MESSAGE_CHARACTERS,
  );
  if (projectedResultSummary.dropped) addProjectionIssue('RESULT_SUMMARY_DROPPED');

  const actions: Array<Record<string, string>> = [];
  const rawActions = result.actions == null
    ? []
    : Array.isArray(result.actions)
      ? result.actions
      : null;
  if (rawActions === null) addProjectionIssue('ACTIONS_DROPPED');
  const boundedActions = rawActions?.slice(0, AI_CONTENT_STUDIO_MAX_ACTIONS) || [];
  if ((rawActions?.length || 0) > AI_CONTENT_STUDIO_MAX_ACTIONS) {
    addProjectionIssue('ACTIONS_TRUNCATED');
  }
  boundedActions.forEach((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      addProjectionIssue('ACTION_DROPPED');
      addProjectionIssue('ACTION_DROPPED_NOT_OBJECT');
      return;
    }
    const action = candidate as Record<string, unknown>;
    const projectedType = optionalContentStudioString(
      action.type,
      AI_CONTENT_STUDIO_MAX_ACTION_TYPE_CHARACTERS,
    );
    const projectedTimestamp = optionalContentStudioString(
      action.timestamp,
      AI_CONTENT_STUDIO_MAX_TIMESTAMP_CHARACTERS,
    );
    const documentId = projectedDocumentId(action);
    const rawActionMessage = typeof action.message === 'string' ? action.message.trim() : '';
    const redundantFinalNarrative = projectedType.value?.toLowerCase() === 'summarize'
      && rawActionMessage.length > 0
      && rawActionMessage.length <= AI_CONTENT_STUDIO_MAX_MESSAGE_CHARACTERS
      && (rawActionMessage === projectedMessage.value || rawActionMessage === projectedResultSummary.value)
      && Boolean(projectedTimestamp.value)
      && !projectedTimestamp.dropped
      && !Number.isNaN(Date.parse(projectedTimestamp.value || ''))
      && !documentId;
    if (redundantFinalNarrative) {
      // Live result streams can repeat the complete final narrative in a
      // summarize action regardless of its length. The bounded top-level
      // message is authoritative for display, so omit the duplicate instead
      // of forwarding and classifying the same answer twice.
      return;
    }
    const projectedActionMessage = contentStudioActionMessage(action.message);
    const projectedTypeValue = projectedType.value || '';
    const projectedTimestampValue = projectedTimestamp.value || '';
    const invalidType = !projectedTypeValue || projectedType.dropped;
    const invalidTimestamp = !projectedTimestampValue
      || projectedTimestamp.dropped
      || Number.isNaN(Date.parse(projectedTimestampValue));
    if (invalidType || projectedActionMessage.issue || invalidTimestamp) {
      addProjectionIssue('ACTION_DROPPED');
      if (invalidType) addProjectionIssue('ACTION_DROPPED_INVALID_TYPE');
      if (projectedActionMessage.issue) addProjectionIssue(projectedActionMessage.issue);
      if (invalidTimestamp) addProjectionIssue('ACTION_DROPPED_INVALID_TIMESTAMP');
      return;
    }
    actions.push({
      type: projectedTypeValue,
      message: projectedActionMessage.value || '',
      timestamp: projectedTimestampValue,
      ...(documentId ? { documentId } : {}),
    });
  });

  const projectedTopic = optionalContentStudioString(
    result.topic,
    AI_CONTENT_STUDIO_MAX_TOPIC_CHARACTERS,
  );
  if (projectedTopic.dropped) addProjectionIssue('TOPIC_DROPPED');
  const projectedOmniChatUrl = contentStudioResultChatUrl(baseUrl, result.omniChatUrl);
  if (projectedOmniChatUrl.dropped) addProjectionIssue('OMNI_CHAT_URL_DROPPED');

  if (!projectedMessage.value && !projectedResultSummary.value && actions.length === 0) {
    throw completeNoUsableContentStudioResult(projectionIssues);
  }
  return {
    actions,
    ...(projectedMessage.value ? { message: projectedMessage.value } : {}),
    ...(projectedResultSummary.value ? { resultSummary: projectedResultSummary.value } : {}),
    ...(projectedTopic.value ? { topic: projectedTopic.value } : {}),
    ...(projectedOmniChatUrl.value ? { omniChatUrl: projectedOmniChatUrl.value } : {}),
    ...(projectionIssues.length > 0 ? { projectionIssues } : {}),
  };
}

function invalidAiContentStudioJobResponse(): Error & { statusCode: number } {
  return Object.assign(new Error('invalid-content-studio-job-response'), { statusCode: 502 });
}

function contentStudioJobString(value: unknown, maximumCharacters: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw invalidAiContentStudioJobResponse();
  const trimmed = value.trim();
  if ((!trimmed && required) || trimmed.length > maximumCharacters) throw invalidAiContentStudioJobResponse();
  return trimmed || undefined;
}

function contentStudioJobId(value: unknown): string {
  const id = contentStudioJobString(value, 200);
  if (!id || !AI_JOB_ID.test(id)) throw invalidAiContentStudioJobResponse();
  return id;
}

function contentStudioJobState(value: unknown): string {
  const state = contentStudioJobString(value, 32);
  if (!state || !AI_JOB_STATES.has(state)) throw invalidAiContentStudioJobResponse();
  return state;
}

function standardOmniTenant(hostname: string): string {
  const suffix = hostname.endsWith('.omniapp.co')
    ? '.omniapp.co'
    : hostname.endsWith('.omni.co')
      ? '.omni.co'
      : '';
  if (!suffix) return '';
  const tenant = hostname.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenant) ? tenant : '';
}

function contentStudioChatUrl(baseUrl: string, value: unknown, required: boolean): string | undefined {
  const raw = contentStudioJobString(value, AI_CONTENT_STUDIO_MAX_CHAT_URL_CHARACTERS, required);
  if (!raw) return undefined;
  try {
    const expected = new URL(baseUrl);
    const parsed = new URL(raw);
    const sameOrigin = expected.origin === parsed.origin;
    const expectedTenant = standardOmniTenant(expected.hostname);
    const candidateTenant = standardOmniTenant(parsed.hostname);
    const sameStandardTenant = expected.port === ''
      && parsed.port === ''
      && expectedTenant !== ''
      && expectedTenant === candidateTenant;
    if (
      expected.protocol !== 'https:'
      || parsed.protocol !== 'https:'
      || expected.username
      || expected.password
      || parsed.username
      || parsed.password
      || (!sameOrigin && !sameStandardTenant)
    ) throw invalidAiContentStudioJobResponse();
    return `${parsed.origin}${parsed.pathname}`;
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 502) throw error;
    throw invalidAiContentStudioJobResponse();
  }
}

function projectAiContentStudioCreateJob(value: unknown, baseUrl: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidAiContentStudioJobResponse();
  const job = value as Record<string, unknown>;
  return {
    jobId: contentStudioJobId(job.jobId),
    conversationId: contentStudioJobId(job.conversationId),
    omniChatUrl: contentStudioChatUrl(baseUrl, job.omniChatUrl, true),
  };
}

function projectAiContentStudioJobStatus(value: unknown, baseUrl: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidAiContentStudioJobResponse();
  const job = value as Record<string, unknown>;
  const conversationId = job.conversationId === undefined ? undefined : contentStudioJobId(job.conversationId);
  const omniChatUrl = contentStudioChatUrl(baseUrl, job.omniChatUrl, false);
  return {
    id: contentStudioJobId(job.id),
    state: contentStudioJobState(job.state),
    ...(conversationId ? { conversationId } : {}),
    ...(omniChatUrl ? { omniChatUrl } : {}),
  };
}

function projectAiContentStudioCancelJob(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidAiContentStudioJobResponse();
  const job = value as Record<string, unknown>;
  const state = contentStudioJobState(job.state);
  if (state !== 'CANCELLED') throw invalidAiContentStudioJobResponse();
  return {
    jobId: contentStudioJobId(job.jobId),
    state,
  };
}

function invalidAiContentDocumentResponse(): Error & { statusCode: number } {
  return Object.assign(new Error('invalid-content-document-response'), { statusCode: 502 });
}

function contentDocumentString(value: unknown, maximumCharacters: number): string {
  if (typeof value !== 'string') throw invalidAiContentDocumentResponse();
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximumCharacters) throw invalidAiContentDocumentResponse();
  return trimmed;
}

function contentDocumentIdentifier(value: unknown): string {
  const identifier = contentDocumentString(value, AI_CONTENT_STUDIO_MAX_DOCUMENT_ID_CHARACTERS);
  if (!NEUTRAL_DOCUMENT_ID.test(identifier)) throw invalidAiContentDocumentResponse();
  return identifier;
}

function contentDocumentModelId(value: unknown): string {
  const modelId = contentDocumentString(value, AI_CONTENT_STUDIO_MAX_DOCUMENT_ID_CHARACTERS);
  if (!AI_JOB_ID.test(modelId)) throw invalidAiContentDocumentResponse();
  return modelId;
}

function contentDocumentRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidAiContentDocumentResponse();
  }
  return value as Record<string, unknown>;
}

interface AiContentAccessPage {
  accessGrantCount: number;
  directAccessGrantCount: number;
  inheritedAccessGrantCount: number;
  ownerGrantCount: number;
  hasNextPage: boolean;
  nextCursor?: string;
  totalRecords: number;
}

interface AiContentAccessSummary {
  accessGrantCount: number;
  directAccessGrantCount: number;
  inheritedAccessGrantCount: number;
  ownerGrantCount: number;
  accessListComplete: true;
}

function projectAiContentAccessPage(value: unknown): AiContentAccessPage {
  const envelope = contentDocumentRecord(value);
  if (!Array.isArray(envelope.principals) || envelope.principals.length > 100) {
    throw invalidAiContentDocumentResponse();
  }
  let directAccessGrantCount = 0;
  let inheritedAccessGrantCount = 0;
  let ownerGrantCount = 0;
  envelope.principals.forEach((candidate) => {
    const principal = contentDocumentRecord(candidate);
    if (principal.accessSource === 'direct') directAccessGrantCount += 1;
    else if (principal.accessSource === 'folder') inheritedAccessGrantCount += 1;
    else throw invalidAiContentDocumentResponse();
    if (principal.isOwner !== undefined && typeof principal.isOwner !== 'boolean') {
      throw invalidAiContentDocumentResponse();
    }
    if (principal.isOwner === true) ownerGrantCount += 1;
  });

  const pageInfo = contentDocumentRecord(envelope.pageInfo);
  if (
    typeof pageInfo.hasNextPage !== 'boolean'
    || !Number.isInteger(pageInfo.totalRecords)
    || (pageInfo.totalRecords as number) < 0
    || (pageInfo.totalRecords as number) > AI_CONTENT_STUDIO_MAX_ACCESS_GRANTS
  ) {
    throw invalidAiContentDocumentResponse();
  }
  const nextCursor = pageInfo.hasNextPage
    ? contentDocumentString(pageInfo.nextCursor, AI_CONTENT_STUDIO_MAX_ACCESS_CURSOR_CHARACTERS)
    : undefined;
  return {
    accessGrantCount: envelope.principals.length,
    directAccessGrantCount,
    inheritedAccessGrantCount,
    ownerGrantCount,
    hasNextPage: pageInfo.hasNextPage,
    ...(nextCursor ? { nextCursor } : {}),
    totalRecords: pageInfo.totalRecords as number,
  };
}

interface AiContentDocumentStateSummary {
  name: string;
  modelId: string;
  queryPresentationCount: number;
  queryPresentationTypes: Array<{ type: string; count: number }>;
  layoutContainerCount: number;
}

function projectAiContentDocumentState(documentValue: unknown): AiContentDocumentStateSummary {
  const document = contentDocumentRecord(documentValue);
  const name = contentDocumentString(document.name, AI_CONTENT_STUDIO_MAX_DOCUMENT_NAME_CHARACTERS);
  const modelId = contentDocumentModelId(document.modelId);

  const queryPresentations = contentDocumentRecord(document.queryPresentations);
  const presentationData = contentDocumentRecord(queryPresentations.data);
  if (
    !Array.isArray(queryPresentations.order)
    || queryPresentations.order.length > AI_CONTENT_STUDIO_MAX_QUERY_PRESENTATIONS
    || Object.keys(presentationData).length > AI_CONTENT_STUDIO_MAX_QUERY_PRESENTATIONS
  ) {
    throw invalidAiContentDocumentResponse();
  }
  const presentationKeys = Object.keys(presentationData);
  const presentationOrder = queryPresentations.order.map((candidate) => (
    contentDocumentString(candidate, AI_CONTENT_STUDIO_MAX_DOCUMENT_ID_CHARACTERS)
  ));
  if (
    presentationKeys.some((key) => !QUERY_PRESENTATION_RECORD_KEY.test(key))
    || presentationOrder.some((key) => !QUERY_PRESENTATION_RECORD_KEY.test(key))
    || new Set(presentationOrder).size !== presentationOrder.length
    || presentationKeys.length !== presentationOrder.length
    || presentationKeys.some((key) => !presentationOrder.includes(key))
  ) {
    throw invalidAiContentDocumentResponse();
  }
  const presentationTypeCounts = new Map<string, number>();
  presentationKeys.forEach((key) => {
    const presentation = contentDocumentRecord(presentationData[key]);
    const type = contentDocumentString(presentation.type, 32);
    if (!AI_CONTENT_STUDIO_QUERY_PRESENTATION_TYPES.has(type)) {
      throw invalidAiContentDocumentResponse();
    }
    if (type === 'linked') {
      const sourceKey = contentDocumentString(
        presentation.sourceQueryPresentationKey,
        AI_CONTENT_STUDIO_MAX_DOCUMENT_ID_CHARACTERS,
      );
      if (!QUERY_PRESENTATION_RECORD_KEY.test(sourceKey) || !presentationData[sourceKey]) {
        throw invalidAiContentDocumentResponse();
      }
    }
    presentationTypeCounts.set(type, (presentationTypeCounts.get(type) || 0) + 1);
  });

  if (
    !Array.isArray(document.containers)
    || document.containers.length > AI_CONTENT_STUDIO_MAX_LAYOUT_CONTAINERS
    || document.containers.some((container) => !container || typeof container !== 'object' || Array.isArray(container))
  ) {
    // Documents V2 omits containers for workbook-only documents. Dashboard
    // verification must not silently certify a workbook as a dashboard.
    throw invalidAiContentDocumentResponse();
  }

  return {
    name,
    modelId,
    queryPresentationCount: presentationKeys.length,
    queryPresentationTypes: Array.from(presentationTypeCounts.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => ({ type, count })),
    layoutContainerCount: document.containers.length,
  };
}

function projectAiContentDocumentVerification(
  requestedDocumentId: string,
  documentState: AiContentDocumentStateSummary,
  queryValue: unknown,
  filterValue: unknown,
  validationValue: unknown,
  accessSummary: AiContentAccessSummary,
): Record<string, unknown> {
  const { name, modelId } = documentState;
  const queryEnvelope = contentDocumentRecord(queryValue);
  if (!Array.isArray(queryEnvelope.queries) || queryEnvelope.queries.length > AI_CONTENT_STUDIO_MAX_DOCUMENT_QUERIES) {
    throw invalidAiContentDocumentResponse();
  }
  const queries = queryEnvelope.queries.map((candidate) => {
    const row = contentDocumentRecord(candidate);
    const query = contentDocumentRecord(row.query);
    const queryModelIds = query.modelId === undefined ? [] : [contentDocumentModelId(query.modelId)];
    return {
      id: contentDocumentIdentifier(row.id),
      name: contentDocumentString(row.name, AI_CONTENT_STUDIO_MAX_DOCUMENT_NAME_CHARACTERS),
      modelIds: queryModelIds,
    };
  });

  const filters = contentDocumentRecord(filterValue);
  const identifier = contentDocumentIdentifier(filters.identifier);
  const filterMap = contentDocumentRecord(filters.filters);
  if (!Array.isArray(filters.controls) || filters.controls.length > AI_CONTENT_STUDIO_MAX_DOCUMENT_QUERIES) {
    throw invalidAiContentDocumentResponse();
  }

  const validation = contentDocumentRecord(validationValue);
  if (contentDocumentModelId(validation.model_id) !== modelId || !Array.isArray(validation.content)) {
    throw invalidAiContentDocumentResponse();
  }
  const exactValidation = validation.content.find((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const row = candidate as Record<string, unknown>;
    return row.identifier === identifier
      || row.identifier === requestedDocumentId
      || row.document_id === requestedDocumentId;
  });
  if (!exactValidation) throw invalidAiContentDocumentResponse();
  const validationDocument = contentDocumentRecord(exactValidation);
  if (!Array.isArray(validationDocument.queries_and_issues) || !Array.isArray(validationDocument.dashboard_filter_issues)) {
    throw invalidAiContentDocumentResponse();
  }
  const contentValidationIssues: string[] = [];
  validationDocument.queries_and_issues.forEach((candidate) => {
    const row = contentDocumentRecord(candidate);
    if (!Array.isArray(row.issues)) throw invalidAiContentDocumentResponse();
    row.issues.forEach((issue) => {
      contentValidationIssues.push(contentDocumentString(issue, AI_CONTENT_STUDIO_MAX_VALIDATION_ISSUE_CHARACTERS));
    });
  });
  validationDocument.dashboard_filter_issues.forEach((issue) => {
    contentValidationIssues.push(contentDocumentString(issue, AI_CONTENT_STUDIO_MAX_VALIDATION_ISSUE_CHARACTERS));
  });
  if (contentValidationIssues.length > AI_CONTENT_STUDIO_MAX_VALIDATION_ISSUES) {
    throw invalidAiContentDocumentResponse();
  }

  return {
    identifier,
    name,
    modelId,
    queryCount: queries.length,
    queries,
    queryPresentationCount: documentState.queryPresentationCount,
    queryPresentationTypes: documentState.queryPresentationTypes,
    layoutContainerCount: documentState.layoutContainerCount,
    filterCount: Object.keys(filterMap).length,
    controlCount: filters.controls.length,
    ...accessSummary,
    contentValidationIssues,
    verifiedAt: new Date().toISOString(),
  };
}

function projectAiContentDocumentTrash(
  requestedDocumentId: string,
  value: unknown,
): Record<string, unknown> {
  const result = contentDocumentRecord(value);
  if (result.success !== true) throw invalidAiContentDocumentResponse();
  return {
    identifier: requestedDocumentId,
    trashed: true,
    trashedAt: new Date().toISOString(),
  };
}

function replaceExact(value: string, sensitive: string): string {
  return sensitive ? value.split(sensitive).join('[redacted]') : value;
}

function looksLikeLargeBinary(value: string): boolean {
  if (/^data:[^;,]+;base64,/i.test(value)) return true;
  return value.length >= 1_024 && isCanonicalBase64(value);
}

function sanitizeUpstreamValue(
  value: unknown,
  apiKey: string,
  attachmentData: Set<string>,
  insideAttachmentContainer = false,
): unknown {
  if (typeof value === 'string') {
    if (looksLikeLargeBinary(value)) return '[redacted-binary]';
    let sanitized = replaceExact(value, apiKey);
    for (const data of attachmentData) sanitized = replaceExact(sanitized, data);
    return sanitized;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUpstreamValue(item, apiKey, attachmentData, insideAttachmentContainer));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const normalizedKey = key.replace(/[^a-z]/gi, '').toLowerCase();
    const nextInsideAttachment = insideAttachmentContainer || normalizedKey === 'attachment' || normalizedKey === 'attachments';
    if (nextInsideAttachment && normalizedKey === 'data') return [];
    let safeKey = replaceExact(key, apiKey);
    for (const data of attachmentData) safeKey = replaceExact(safeKey, data);
    return [[safeKey, sanitizeUpstreamValue(item, apiKey, attachmentData, nextInsideAttachment)]];
  }));
}

function upstreamErrorResponse(response: OmniJsonResponse, resource = 'Omni AI'): Response {
  const status = response.status >= 300 && response.status < 400 ? 502 : response.status;
  const publicStatus = status >= 400 && status <= 599 ? status : 502;
  const message = publicStatus === 401
    ? `${resource} authentication failed.`
    : publicStatus === 403
      ? `The Omni credential is not authorized for this ${resource.toLowerCase()} operation.`
      : publicStatus === 404
        ? `The requested ${resource} resource was not found.`
        : publicStatus === 429
          ? `${resource} is rate limited. Wait briefly and try again.`
          : `${resource} request failed (HTTP ${response.status}).`;
  return jsonResponse({ error: message }, publicStatus);
}

export interface ManageAiDependencies {
  request?: (request: OmniJsonRequest) => Promise<OmniJsonResponse>;
  validateOutbound?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export async function handleManageAi(req: Request, dependencies: ManageAiDependencies = {}): Promise<Response> {
  let timedOut = false;
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(req.signal.reason);
  if (req.signal.aborted) controller.abort(req.signal.reason);
  else req.signal.addEventListener('abort', abortFromRequest, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('AI upstream request timed out.'));
  }, dependencies.timeoutMs ?? AI_UPSTREAM_TIMEOUT_MS);

  try {
    const rawBody = await readBoundedRequestText(req);
    if (rawBody instanceof Response) return rawBody;
    let body: RequestBody;
    try {
      body = JSON.parse(rawBody) as RequestBody;
    } catch {
      return jsonResponse({ error: 'Request body must be valid JSON.' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: 'Request body must be a JSON object.' }, 400);
    }
    const metadataError = rejectOversizedMetadata(body);
    if (metadataError) return metadataError;

    const { base_url, api_key, action } = body;
    const urlError = validateBaseUrl(base_url);
    if (urlError) return jsonResponse({ error: urlError }, 400);
    const parsedBaseUrl = new URL(base_url);
    if (!/^https:\/\/[^/?#]+\/?$/i.test(base_url) || parsedBaseUrl.pathname !== '/') {
      return jsonResponse({
        error: 'base_url must be the Omni tenant origin only (for example, https://tenant.omniapp.co). Do not include /api or another path.',
      }, 400);
    }
    if (
      !api_key
      || typeof api_key !== 'string'
      || api_key.trim().length < 4
      || api_key !== api_key.trim()
      || api_key.length > 8_192
      || !action
    ) {
      return jsonResponse({ error: 'base_url, api_key, and action are required.' }, 400);
    }

    const attachments = validateAttachments(body.attachments);
    if (attachments instanceof Response) return attachments;
    if (attachments.length === 0 && rawBody.length > AI_REQUEST_BODY_MAX_CHARACTERS) {
      return jsonResponse(
        { error: `AI request exceeds the ${AI_REQUEST_BODY_MAX_CHARACTERS.toLocaleString()} character server limit.` },
        413,
      );
    }
    if (Object.keys(body).some((key) => !REQUEST_BODY_KEYS.has(key))) {
      return jsonResponse({ error: 'Request body contains unsupported fields.' }, 400);
    }
    if (
      body.response_contract !== undefined
      && body.response_contract !== AI_CONTENT_STUDIO_RESPONSE_CONTRACT
    ) {
      return jsonResponse({ error: 'response_contract is not supported.' }, 400);
    }
    if (
      body.response_contract === AI_CONTENT_STUDIO_RESPONSE_CONTRACT
      && !['create-job', 'get-job', 'cancel-job'].includes(action)
    ) {
      return jsonResponse({ error: 'The AI Content Studio response contract is not supported for this action.' }, 400);
    }
    if (body.attachments !== undefined && action !== 'create-job') {
      return jsonResponse({ error: 'attachments are supported only for create-job.' }, 400);
    }

    const cleanUrl = parsedBaseUrl.origin;
    const authHeaders = {
      Authorization: `Bearer ${api_key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const requestContentEndpoint = async (
      url: string,
      method: 'GET' | 'DELETE',
      maximumResponseBytes = AI_UPSTREAM_RESPONSE_MAX_BYTES,
    ): Promise<OmniJsonResponse | Response> => {
      try {
        await (dependencies.validateOutbound || ((candidate: string) => (
          assertSafeOutboundUrl(candidate, { label: 'base_url' })
        )))(url);
      } catch (error) {
        return jsonResponse({
          error: error instanceof Error ? error.message : 'base_url could not be validated safely.',
        }, 400);
      }
      if (controller.signal.aborted) {
        return jsonResponse({
          error: timedOut ? 'Omni content verification timed out.' : 'Omni content verification was cancelled.',
        }, timedOut ? 504 : 499);
      }
      return (dependencies.request || requestOmniJson)({
        url,
        method,
        headers: authHeaders,
        signal: controller.signal,
        maximumResponseBytes,
      });
    };

    if (action === 'verify-content-document' || action === 'trash-content-document') {
      const documentId = requireField(body, 'document_id');
      if (documentId instanceof Response) return documentId;
      if (
        documentId.length > AI_CONTENT_STUDIO_MAX_DOCUMENT_ID_CHARACTERS
        || !NEUTRAL_DOCUMENT_ID.test(documentId)
      ) {
        return jsonResponse({ error: 'document_id must be an exact Omni document identifier or UUID.' }, 400);
      }

      if (action === 'trash-content-document') {
        const trash = await requestContentEndpoint(
          `${cleanUrl}/api/v1/documents/${encodeURIComponent(documentId)}`,
          'DELETE',
        );
        if (trash instanceof Response) return trash;
        if (trash.status < 200 || trash.status >= 300) {
          return upstreamErrorResponse(trash, 'Omni document trash');
        }
        return jsonResponse(projectAiContentDocumentTrash(documentId, trash.data), 200);
      }

      const documentState = await requestContentEndpoint(
        `${cleanUrl}/api/v2/documents/${encodeURIComponent(documentId)}`,
        'GET',
      );
      if (documentState instanceof Response) return documentState;
      if (documentState.status < 200 || documentState.status >= 300) {
        return upstreamErrorResponse(documentState, 'Omni dashboard verification');
      }
      const projectedDocumentState = projectAiContentDocumentState(documentState.data);
      const modelId = projectedDocumentState.modelId;

      const documentQueries = await requestContentEndpoint(
        `${cleanUrl}/api/v1/documents/${encodeURIComponent(documentId)}/queries`,
        'GET',
      );
      if (documentQueries instanceof Response) return documentQueries;
      if (documentQueries.status < 200 || documentQueries.status >= 300) {
        return upstreamErrorResponse(documentQueries, 'Omni dashboard query verification');
      }

      const dashboardFilters = await requestContentEndpoint(
        `${cleanUrl}/api/v1/dashboards/${encodeURIComponent(documentId)}/filters`,
        'GET',
      );
      if (dashboardFilters instanceof Response) return dashboardFilters;
      if (dashboardFilters.status < 200 || dashboardFilters.status >= 300) {
        return upstreamErrorResponse(dashboardFilters, 'Omni dashboard filter verification');
      }

      let accessGrantCount = 0;
      let directAccessGrantCount = 0;
      let inheritedAccessGrantCount = 0;
      let ownerGrantCount = 0;
      let expectedAccessGrantCount: number | undefined;
      let accessCursor: string | undefined;
      let accessListComplete = false;
      const seenAccessCursors = new Set<string>();
      for (let pageIndex = 0; pageIndex < AI_CONTENT_STUDIO_MAX_ACCESS_PAGES; pageIndex += 1) {
        const accessParams = new URLSearchParams({ pageSize: '100' });
        if (accessCursor) accessParams.set('cursor', accessCursor);
        const accessResponse = await requestContentEndpoint(
          `${cleanUrl}/api/v1/documents/${encodeURIComponent(documentId)}/access-list?${accessParams.toString()}`,
          'GET',
        );
        if (accessResponse instanceof Response) return accessResponse;
        if (accessResponse.status < 200 || accessResponse.status >= 300) {
          return upstreamErrorResponse(accessResponse, 'Omni document access verification');
        }
        const accessPage = projectAiContentAccessPage(accessResponse.data);
        if (expectedAccessGrantCount === undefined) expectedAccessGrantCount = accessPage.totalRecords;
        else if (expectedAccessGrantCount !== accessPage.totalRecords) throw invalidAiContentDocumentResponse();
        accessGrantCount += accessPage.accessGrantCount;
        directAccessGrantCount += accessPage.directAccessGrantCount;
        inheritedAccessGrantCount += accessPage.inheritedAccessGrantCount;
        ownerGrantCount += accessPage.ownerGrantCount;
        if (accessGrantCount > AI_CONTENT_STUDIO_MAX_ACCESS_GRANTS) {
          throw invalidAiContentDocumentResponse();
        }
        if (!accessPage.hasNextPage) {
          if (accessGrantCount !== expectedAccessGrantCount) throw invalidAiContentDocumentResponse();
          accessListComplete = true;
          break;
        }
        if (!accessPage.nextCursor || seenAccessCursors.has(accessPage.nextCursor)) {
          throw invalidAiContentDocumentResponse();
        }
        seenAccessCursors.add(accessPage.nextCursor);
        accessCursor = accessPage.nextCursor;
      }
      if (!accessListComplete) throw invalidAiContentDocumentResponse();
      const accessSummary: AiContentAccessSummary = {
        accessGrantCount,
        directAccessGrantCount,
        inheritedAccessGrantCount,
        ownerGrantCount,
        accessListComplete: true,
      };

      const contentValidation = await requestContentEndpoint(
        `${cleanUrl}/api/v1/models/${encodeURIComponent(modelId)}/content-validator?include_personal_folders=true`,
        'GET',
        AI_CONTENT_STUDIO_UPSTREAM_RESPONSE_MAX_BYTES,
      );
      if (contentValidation instanceof Response) return contentValidation;
      if (contentValidation.status < 200 || contentValidation.status >= 300) {
        return upstreamErrorResponse(contentValidation, 'Omni content validation');
      }

      return jsonResponse(projectAiContentDocumentVerification(
        documentId,
        projectedDocumentState,
        documentQueries.data,
        dashboardFilters.data,
        contentValidation.data,
        accessSummary,
      ), 200);
    }

    let targetUrl: string;
    let init: { method: string; headers: Record<string, string>; body?: string };

    switch (action) {
      case 'pick-topic': {
        const modelId = requireField(body, 'model_id');
        if (modelId instanceof Response) return modelId;
        const prompt = requireField(body, 'prompt');
        if (prompt instanceof Response) return prompt;
        const promptError = rejectUnsafePrompt(prompt);
        if (promptError) return promptError;
        const payload: Record<string, unknown> = { modelId, prompt };
        if (body.branch_id) payload.branchId = body.branch_id;
        if (body.current_topic_name) payload.currentTopicName = body.current_topic_name;
        if (Array.isArray(body.potential_topic_names) && body.potential_topic_names.length > 0) {
          payload.potentialTopicNames = body.potential_topic_names;
        }
        if (body.user_id) payload.userId = body.user_id;
        targetUrl = `${cleanUrl}/api/v1/ai/pick-topic`;
        init = { method: 'POST', headers: authHeaders, body: JSON.stringify(payload) };
        break;
      }
      case 'create-job': {
        const modelId = requireField(body, 'model_id');
        if (modelId instanceof Response) return modelId;
        const prompt = requireField(body, 'prompt');
        if (prompt instanceof Response) return prompt;
        const promptError = rejectUnsafePrompt(prompt);
        if (promptError) return promptError;
        const attachmentBytes = attachments.reduce((sum, attachment) => (
          sum + (decodedBase64ByteLength(attachment.data) || 0)
        ), 0);
        if (Buffer.byteLength(prompt, 'utf8') + attachmentBytes > AI_ATTACHMENTS_MAX_COMBINED_RAW_BYTES) {
          return jsonResponse({ error: 'The AI prompt and attachments exceed the 15 MiB combined request limit.' }, 413);
        }
        const payload: Record<string, unknown> = { modelId, prompt };
        if (body.topic_name) payload.topicName = body.topic_name;
        if (body.branch_id) payload.branchId = body.branch_id;
        if (body.conversation_id) payload.conversationId = body.conversation_id;
        if (attachments.length > 0) payload.attachments = attachments;
        const params = new URLSearchParams();
        if (body.user_id) params.set('userId', body.user_id);
        const query = params.toString();
        targetUrl = `${cleanUrl}/api/v1/ai/jobs${query ? `?${query}` : ''}`;
        init = { method: 'POST', headers: authHeaders, body: JSON.stringify(payload) };
        break;
      }
      case 'get-job': {
        const jobId = requireField(body, 'job_id');
        if (jobId instanceof Response) return jobId;
        targetUrl = `${cleanUrl}/api/v1/ai/jobs/${encodeURIComponent(jobId)}`;
        init = { method: 'GET', headers: authHeaders };
        break;
      }
      case 'get-job-result':
      case 'get-content-studio-job-result': {
        const jobId = requireField(body, 'job_id');
        if (jobId instanceof Response) return jobId;
        targetUrl = `${cleanUrl}/api/v1/ai/jobs/${encodeURIComponent(jobId)}/result`;
        init = { method: 'GET', headers: authHeaders };
        break;
      }
      case 'cancel-job': {
        const jobId = requireField(body, 'job_id');
        if (jobId instanceof Response) return jobId;
        targetUrl = `${cleanUrl}/api/v1/ai/jobs/${encodeURIComponent(jobId)}/cancel`;
        init = { method: 'POST', headers: authHeaders };
        break;
      }
      default:
        return jsonResponse({ error: `Unknown AI action: ${String(action)}` }, 400);
    }

    try {
      await (dependencies.validateOutbound || ((url: string) => assertSafeOutboundUrl(url, { label: 'base_url' })))(targetUrl);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : 'base_url could not be validated safely.' }, 400);
    }
    if (controller.signal.aborted) {
      return jsonResponse({ error: timedOut ? 'Omni AI request timed out.' : 'Omni AI request was cancelled.' }, timedOut ? 504 : 499);
    }

    const response = await (dependencies.request || requestOmniJson)({
      url: targetUrl,
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
      maximumResponseBytes: action === 'get-content-studio-job-result'
        ? AI_CONTENT_STUDIO_UPSTREAM_RESPONSE_MAX_BYTES
        : AI_UPSTREAM_RESPONSE_MAX_BYTES,
      // Omni's documented streamed-result endpoint currently returns a JSON
      // object with application/octet-stream on live tenants. Permit that
      // transport label only for the two exact result-read actions; every
      // create, status, cancellation, and non-result operation retains the
      // application/json/+json requirement.
      allowOctetStreamJson: action === 'get-job-result'
        || action === 'get-content-studio-job-result',
    });
    if (response.status < 200 || response.status >= 300) return upstreamErrorResponse(response);
    const responseData = action === 'get-content-studio-job-result'
      ? projectAiContentStudioResult(response.data, cleanUrl)
      : body.response_contract === AI_CONTENT_STUDIO_RESPONSE_CONTRACT && action === 'cancel-job'
        ? projectAiContentStudioCancelJob(response.data)
        : body.response_contract === AI_CONTENT_STUDIO_RESPONSE_CONTRACT && action === 'create-job'
          ? projectAiContentStudioCreateJob(response.data, cleanUrl)
          : body.response_contract === AI_CONTENT_STUDIO_RESPONSE_CONTRACT && action === 'get-job'
            ? projectAiContentStudioJobStatus(response.data, cleanUrl)
            : response.data || { success: true };
    return jsonResponse(
      sanitizeUpstreamValue(
        responseData,
        api_key,
        new Set(attachments.map((attachment) => attachment.data)),
      ),
      response.status === 204 ? 200 : response.status,
    );
  } catch (error) {
    if (controller.signal.aborted) {
      return jsonResponse({ error: timedOut ? 'Omni AI request timed out.' : 'Omni AI request was cancelled.' }, timedOut ? 504 : 499);
    }
    const statusCode = (error as { statusCode?: number })?.statusCode;
    const errorCode = (error as { code?: string })?.code;
    if (statusCode === 422 && errorCode === AI_CONTENT_STUDIO_COMPLETE_NO_USABLE_RESULT) {
      const projectionIssues = (error as { projectionIssues?: unknown }).projectionIssues;
      return jsonResponse({
        error: 'Omni completed the job without a usable narrative or valid action evidence.',
        code: AI_CONTENT_STUDIO_COMPLETE_NO_USABLE_RESULT,
        ...(Array.isArray(projectionIssues) && projectionIssues.length > 0 ? { projectionIssues } : {}),
      }, 422);
    }
    if (statusCode === 422 && errorCode === AI_CONTENT_STUDIO_RESULT_CONTRACT_MISMATCH) {
      return jsonResponse({
        error: 'Omni completed the job, but its result did not match the documented AI response contract.',
        code: AI_CONTENT_STUDIO_RESULT_CONTRACT_MISMATCH,
      }, 422);
    }
    if (statusCode === 502) {
      return jsonResponse({ error: 'Omni AI returned an invalid or oversized JSON response.' }, 502);
    }
    return jsonResponse({ error: 'Omni AI request failed safely.' }, 502);
  } finally {
    clearTimeout(timeout);
    req.signal.removeEventListener('abort', abortFromRequest);
  }
}

export default function handler(req: Request): Promise<Response> {
  return handleManageAi(req);
}
