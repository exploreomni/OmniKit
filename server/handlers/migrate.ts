import { validateBaseUrl, jsonHeaders, sseHeaders } from '../security';

interface MigrationRequest {
  source: { base_url: string; api_key: string };
  target: { base_url: string; api_key: string };
  dashboards: { id: string; name: string; base_model_id?: string }[];
  model_mapping: Record<string, string>;
  target_folder?: string;
  dry_run: boolean;
  in_place?: boolean;
}

interface SSEEvent {
  type: "progress" | "complete" | "heartbeat" | "diagnostic";
  dashboard_id?: string;
  dashboard_name?: string;
  status?: "pending" | "in_progress" | "success" | "warning" | "failed" | "skipped";
  error?: string;
  warnings?: string[];
  index?: number;
  total?: number;
  replacements?: number;
  summary?: { succeeded: number; failed: number; skipped: number; total: number };
  results?: Array<{
    id: string;
    name: string;
    status: string;
    error?: string;
    source_model?: string;
    target_model?: string;
    warnings?: string[];
  }>;
  phase?: string;
  detail?: Record<string, unknown>;
}

const MODEL_ID_KEYS = new Set([
  "baseModelId", "base_model_id",
  "sharedModelId", "shared_model_id",
]);
const FOLDER_PATH_KEYS = new Set([
  "folderPath", "folder_path", "filePath", "file_path",
  "folder", "path", "parentPath", "parent_path",
]);
const ENVELOPE_CANDIDATES = ["dashboard", "document", "data", "export", "payload", "result"];

function findModelIdInPayload(obj: unknown, maxDepth = 5): string | null {
  if (!obj || typeof obj !== "object" || maxDepth <= 0) return null;
  const record = obj as Record<string, unknown>;
  for (const key of MODEL_ID_KEYS) {
    const val = record[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  for (const val of Object.values(record)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const found = findModelIdInPayload(val, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

function findModelIdPath(obj: unknown, currentPath = "", maxDepth = 8): string | null {
  if (!obj || typeof obj !== "object" || maxDepth <= 0) return null;
  if (Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  for (const key of MODEL_ID_KEYS) {
    const val = record[key];
    if (typeof val === "string" && val.length > 0) {
      return currentPath ? `${currentPath}.${key}` : key;
    }
  }
  for (const [key, val] of Object.entries(record)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const path = currentPath ? `${currentPath}.${key}` : key;
      const found = findModelIdPath(val, path, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

function countModelIdFields(obj: unknown, maxDepth = 8): number {
  let count = 0;
  if (!obj || typeof obj !== "object" || maxDepth <= 0) return count;
  if (Array.isArray(obj)) {
    for (const item of obj) count += countModelIdFields(item, maxDepth - 1);
    return count;
  }
  const record = obj as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    if (MODEL_ID_KEYS.has(key) && typeof val === "string" && val.length > 0) {
      count++;
    }
    if (val && typeof val === "object") {
      count += countModelIdFields(val, maxDepth - 1);
    }
  }
  return count;
}

function normalizeExportPayload(raw: unknown): { payload: unknown; unwrapped: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { payload: raw, unwrapped: null };
  }

  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const candidate of ENVELOPE_CANDIDATES) {
    if (
      candidate in record &&
      record[candidate] &&
      typeof record[candidate] === "object" &&
      !Array.isArray(record[candidate])
    ) {
      const inner = record[candidate] as Record<string, unknown>;
      const innerHasModel = findModelIdInPayload(inner) !== null;
      const outerHasModel = (() => {
        for (const key of MODEL_ID_KEYS) {
          const val = record[key];
          if (typeof val === "string" && val.length > 0) return true;
        }
        return false;
      })();

      if (innerHasModel && !outerHasModel && keys.length <= 4) {
        return { payload: inner, unwrapped: candidate };
      }
    }
  }

  return { payload: raw, unwrapped: null };
}

function ensureTopLevelModelId(obj: unknown, targetModelId: string): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const record = obj as Record<string, unknown>;

  for (const key of MODEL_ID_KEYS) {
    if (key in record && typeof record[key] === "string" && (record[key] as string).length > 0) {
      return true;
    }
  }

  record["baseModelId"] = targetModelId;
  return true;
}

function injectModelId(obj: unknown, targetId: string, maxDepth = 5): boolean {
  if (!obj || typeof obj !== "object" || maxDepth <= 0) return false;
  const record = obj as Record<string, unknown>;
  for (const key of MODEL_ID_KEYS) {
    if (key in record) {
      record[key] = targetId;
      return true;
    }
  }
  for (const val of Object.values(record)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      if (injectModelId(val, targetId, maxDepth - 1)) return true;
    }
  }
  return false;
}

function validateTransformedPayload(obj: unknown): string | null {
  const modelId = findModelIdInPayload(obj);
  if (!modelId) {
    return "Transformed payload has no model ID -- import will likely fail.";
  }
  return null;
}

function replaceAllModelIds(
  obj: unknown,
  targetId: string,
  allowedIds: Set<string>,
  maxDepth = 10
): number {
  let replaced = 0;
  if (!obj || typeof obj !== "object" || maxDepth <= 0) return replaced;
  if (Array.isArray(obj)) {
    for (const item of obj) replaced += replaceAllModelIds(item, targetId, allowedIds, maxDepth - 1);
    return replaced;
  }
  const record = obj as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    if (MODEL_ID_KEYS.has(key) && typeof val === "string" && val.length > 0 && !allowedIds.has(val)) {
      record[key] = targetId;
      replaced++;
    }
    if (val && typeof val === "object") {
      replaced += replaceAllModelIds(val, targetId, allowedIds, maxDepth - 1);
    }
  }
  return replaced;
}

interface CompatibilityPreflightResult {
  status: "success" | "warning";
  referencedFields: string[];
  missingFields: string[];
  matchedFieldCount: number;
  targetFieldCount: number | null;
  warnings: string[];
}

const FIELD_REF_KEYS = new Set([
  "field", "fieldName", "field_name", "column_name", "columnName",
  "fields", "pivots", "sorts", "filters", "filter", "measures",
  "dimensions", "x", "y", "series",
]);

const FIELD_REF_PATTERN = /\b([A-Za-z_][\w/]*\.[A-Za-z_][\w]*(?:\[[A-Za-z_][\w]*\])?)\b/g;

function normalizeFieldRef(value: string): string {
  return value.trim().replace(/\[[^\]]+\]$/, "");
}

function isOmniFormulaFunctionRef(value: string): boolean {
  const [namespace, member] = normalizeFieldRef(value).split(".");
  return namespace?.toLowerCase() === "omni" && /^OMNI_FX_/i.test(member || "");
}

function isLikelyFieldRef(value: string): boolean {
  const normalized = normalizeFieldRef(value);
  return !isOmniFormulaFunctionRef(normalized) && /^[A-Za-z_][\w/]*\.[A-Za-z_][\w]*$/.test(normalized);
}

function extractFieldRefsFromString(value: string, onlyIfFieldLike = false): string[] {
  const refs = new Set<string>();
  const candidates = onlyIfFieldLike ? [value] : Array.from(value.matchAll(FIELD_REF_PATTERN)).map((m) => m[1]);
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = normalizeFieldRef(candidate);
    if (isLikelyFieldRef(normalized)) refs.add(normalized);
  }
  return [...refs];
}

function extractDashboardFieldRefs(obj: unknown, maxDepth = 14): string[] {
  const refs = new Set<string>();

  function walk(node: unknown, keyHint = "", depth = maxDepth): void {
    if (node === null || node === undefined || depth <= 0) return;

    if (typeof node === "string") {
      const keyLooksFieldLike = FIELD_REF_KEYS.has(keyHint) || /field|column|sort|pivot|filter|measure|dimension/i.test(keyHint);
      for (const ref of extractFieldRefsFromString(node, !keyLooksFieldLike)) {
        refs.add(ref);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyHint, depth - 1);
      return;
    }

    if (typeof node === "object") {
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        walk(val, key, depth - 1);
      }
    }
  }

  walk(obj);
  return [...refs].sort();
}

function viewNameVariants(fileName: string): string[] {
  const withoutSuffix = fileName.replace(/\.view$/, "");
  const leaf = withoutSuffix.includes("/") ? withoutSuffix.split("/").pop() || withoutSuffix : withoutSuffix;
  const withoutQuerySuffix = leaf.replace(/\.query$/, "");
  return [...new Set([withoutSuffix, leaf, withoutQuerySuffix].filter(Boolean))];
}

function extractFieldsFromViewYaml(fileName: string, yaml: string): string[] {
  const refs = new Set<string>();
  if (!fileName.endsWith(".view")) return [];

  const viewNames = viewNameVariants(fileName);
  let activeSection = false;
  let sectionIndent = -1;

  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const sectionMatch = line.match(/^(\s*)(dimensions|measures):\s*$/);
    if (sectionMatch) {
      activeSection = true;
      sectionIndent = sectionMatch[1].length;
      continue;
    }

    if (!activeSection) continue;

    if (indent <= sectionIndent) {
      activeSection = false;
      continue;
    }

    if (indent === sectionIndent + 2) {
      const fieldMatch = line.trim().match(/^([A-Za-z_][\w]*):/);
      if (fieldMatch) {
        for (const viewName of viewNames) {
          refs.add(`${viewName}.${fieldMatch[1]}`);
        }
      }
    }
  }

  return [...refs];
}

async function loadTargetFieldUniverse(
  baseUrl: string,
  apiKey: string,
  modelId: string
): Promise<{ fields: Set<string>; error?: string }> {
  try {
    const cleanUrl = baseUrl.replace(/\/+$/, "");
    const url = `${cleanUrl}/api/v1/models/${encodeURIComponent(modelId)}/yaml?fullyResolved=true`;
    const response = await fetchWithRetry(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      },
      30000
    );

    if (!response.ok) {
      const text = await response.text();
      return {
        fields: new Set(),
        error: `Target model YAML inspection failed (${response.status}): ${text.slice(0, 200)}`,
      };
    }

    const data = await response.json();
    const files = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).files
      : null;

    if (!files || typeof files !== "object" || Array.isArray(files)) {
      return { fields: new Set(), error: "Target model YAML inspection returned no file map." };
    }

    const fields = new Set<string>();
    for (const [fileName, yaml] of Object.entries(files as Record<string, unknown>)) {
      if (typeof yaml !== "string") continue;
      for (const fieldRef of extractFieldsFromViewYaml(fileName, yaml)) {
        fields.add(fieldRef);
      }
    }

    return { fields };
  } catch (err) {
    return {
      fields: new Set(),
      error: err instanceof Error ? err.message : "Target model YAML inspection failed.",
    };
  }
}

function formatFieldList(fields: string[], limit = 8): string {
  const shown = fields.slice(0, limit).join(", ");
  const remaining = fields.length - limit;
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

async function runCompatibilityPreflight(params: {
  dashboardPayload: unknown;
  targetBaseUrl: string;
  targetApiKey: string;
  targetModelId: string;
}): Promise<CompatibilityPreflightResult> {
  const referencedFields = extractDashboardFieldRefs(params.dashboardPayload);
  const warnings: string[] = [];

  const { fields: targetFields, error } = await loadTargetFieldUniverse(
    params.targetBaseUrl,
    params.targetApiKey,
    params.targetModelId
  );

  if (referencedFields.length === 0) {
    warnings.push("No dashboard field references were detected in the export payload. Review the migrated dashboard in Omni before publishing.");
  }

  if (error) {
    warnings.push(`${error} Payload structure was checked, but semantic field compatibility could not be fully verified.`);
    return {
      status: "warning",
      referencedFields,
      missingFields: [],
      matchedFieldCount: 0,
      targetFieldCount: null,
      warnings,
    };
  }

  const missingFields = referencedFields.filter((field) => !targetFields.has(field));
  if (missingFields.length > 0) {
    warnings.push(
      `${missingFields.length} referenced field${missingFields.length === 1 ? "" : "s"} were not found in the target model: ${formatFieldList(missingFields)}.`
    );
  }

  return {
    status: warnings.length > 0 ? "warning" : "success",
    referencedFields,
    missingFields,
    matchedFieldCount: referencedFields.length - missingFields.length,
    targetFieldCount: targetFields.size,
    warnings,
  };
}

function deepTransform(
  obj: unknown,
  modelMapping: Record<string, string>,
  targetFolder: string | undefined
): { result: unknown; replacements: number; folderReplacements: number; folderKeysFound: string[] } {
  let replacements = 0;
  let folderReplacements = 0;
  const folderKeysFound: string[] = [];

  function walk(node: unknown): unknown {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object") {
      const record = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(record)) {
        if (MODEL_ID_KEYS.has(key) && typeof val === "string" && modelMapping[val]) {
          out[key] = modelMapping[val];
          replacements++;
        } else if (
          FOLDER_PATH_KEYS.has(key) &&
          typeof val === "string"
        ) {
          folderKeysFound.push(`${key}=${val}`);
          if (targetFolder !== undefined && targetFolder !== "") {
            out[key] = targetFolder;
            folderReplacements++;
            replacements++;
          } else {
            out[key] = walk(val);
          }
        } else {
          out[key] = walk(val);
        }
      }
      return out;
    }
    return node;
  }

  const result = walk(obj);
  return { result, replacements, folderReplacements, folderKeysFound };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retries = 2,
  delays = [1000, 3000]
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs);
      if (response.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, delays[attempt] ?? 3000));
        continue;
      }
      return response;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt] ?? 3000));
    }
  }
  throw new Error("Max retries exceeded");
}

async function exportDashboard(
  baseUrl: string,
  apiKey: string,
  dashboardId: string
): Promise<{ data: unknown; error?: string }> {
  try {
    const cleanUrl = baseUrl.replace(/\/+$/, "");
    const response = await fetchWithRetry(
      `${cleanUrl}/api/unstable/documents/${dashboardId}/export`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      },
      30000
    );

    if (!response.ok) {
      const text = await response.text();
      return {
        data: null,
        error: `Export failed (${response.status}): ${text.slice(0, 300)}`,
      };
    }

    const data = await response.json();
    if (!data) {
      return { data: null, error: "Export returned empty response." };
    }
    return { data };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { data: null, error: `Export error: ${msg}` };
  }
}

async function importDashboard(
  baseUrl: string,
  apiKey: string,
  payload: unknown
): Promise<{ data: unknown; error?: string; payloadSnapshot?: string }> {
  try {
    const cleanUrl = baseUrl.replace(/\/+$/, "");
    const bodyStr = JSON.stringify(payload);
    const response = await fetchWithRetry(
      `${cleanUrl}/api/unstable/documents/import`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: bodyStr,
      },
      30000
    );

    if (!response.ok) {
      const text = await response.text();
      return {
        data: null,
        error: `Import failed (${response.status}): ${text.slice(0, 300)}`,
        payloadSnapshot: bodyStr.slice(0, 500),
      };
    }

    const data = await response.json();
    if (!data) {
      return { data: null, error: "Import returned empty response." };
    }
    return { data };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { data: null, error: `Import error: ${msg}` };
  }
}

function injectFolderPath(obj: unknown, folder: string): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const record = obj as Record<string, unknown>;
  record["filePath"] = folder;
  return true;
}

function extractImportedDocumentId(importResponse: unknown): string | null {
  if (!importResponse || typeof importResponse !== "object") return null;
  const rec = importResponse as Record<string, unknown>;

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  const fromRecord = (r: Record<string, unknown>): string | null =>
    str(r.id) ?? str(r.identifier) ?? str(r.slug) ?? str(r.documentId) ?? str(r.document_id);

  const direct = fromRecord(rec);
  if (direct) return direct;

  for (const key of ["document", "data", "dashboard", "result"]) {
    if (rec[key] && typeof rec[key] === "object" && !Array.isArray(rec[key])) {
      const nested = fromRecord(rec[key] as Record<string, unknown>);
      if (nested) return nested;
    }
  }

  return null;
}

async function updateDashboardModelInPlace(
  baseUrl: string,
  apiKey: string,
  documentId: string,
  docName: string,
  targetModelId: string
): Promise<{ data: unknown; error?: string; status?: number }> {
  try {
    const cleanUrl = baseUrl.replace(/\/+$/, "");
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const attempts: Array<{ url: string; method: string; body: Record<string, string>; label: string }> = [
      {
        url: `${cleanUrl}/api/unstable/documents/${documentId}/update-model`,
        method: "POST",
        body: { baseModelId: targetModelId },
        label: "document model endpoint with baseModelId",
      },
      {
        url: `${cleanUrl}/api/unstable/documents/${documentId}/update-model`,
        method: "POST",
        body: { modelId: targetModelId },
        label: "document model endpoint with modelId",
      },
      {
        url: `${cleanUrl}/api/unstable/documents/${documentId}`,
        method: "PATCH",
        body: { name: docName, modelId: targetModelId },
        label: "legacy document patch fallback",
      },
    ];

    const failures: string[] = [];
    for (const attempt of attempts) {
      const response = await fetchWithRetry(
        attempt.url,
        {
          method: attempt.method,
          headers,
          body: JSON.stringify(attempt.body),
        },
        20000
      );

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        return { data, status: response.status };
      }

      const text = (await response.text()).slice(0, 300);
      failures.push(`${attempt.label} failed (${response.status}): ${text}`);

      if (![400, 404, 405, 422].includes(response.status)) {
        break;
      }
    }

    return {
      data: null,
      error: `Model remap failed. ${failures.join(" | ")}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { data: null, error: `Model remap error: ${msg}` };
  }
}

async function moveDocumentToFolder(
  baseUrl: string,
  apiKey: string,
  documentId: string,
  folder: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const cleanUrl = baseUrl.replace(/\/+$/, "");
    const response = await fetchWithRetry(
      `${cleanUrl}/api/v1/documents/${documentId}/move`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderPath: folder }),
      },
      15000
    );

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Move failed (${response.status}): ${text.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: `Move error: ${msg}` };
  }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const body: MigrationRequest = await req.json();
    const { source, target, dashboards, model_mapping, target_folder, dry_run, in_place } = body;

    const sourceUrlError = validateBaseUrl(source?.base_url);
    if (sourceUrlError) {
      return new Response(JSON.stringify({ error: `Source: ${sourceUrlError}` }), { status: 400, headers: jsonHeaders });
    }
    const targetUrlError = validateBaseUrl(target?.base_url);
    if (targetUrlError) {
      return new Response(JSON.stringify({ error: `Target: ${targetUrlError}` }), { status: 400, headers: jsonHeaders });
    }

    if (!source?.api_key || !target?.api_key) {
      return new Response(
        JSON.stringify({ error: "Source and target credentials are required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    if (!dashboards || dashboards.length === 0) {
      return new Response(
        JSON.stringify({ error: "At least one dashboard must be selected." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        function sendEvent(event: SSEEvent) {
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
            source_model?: string;
            target_model?: string;
          }> = [];
          let succeeded = 0;
          let failed = 0;
          let skipped = 0;

          for (let i = 0; i < dashboards.length; i++) {
            const dashboard = dashboards[i];

            sendEvent({
              type: "progress",
              dashboard_id: dashboard.id,
              dashboard_name: dashboard.name,
              status: "in_progress",
              index: i,
              total: dashboards.length,
            });

            const resolvedSourceModel = dashboard.base_model_id || "";
            const mappedTarget =
              model_mapping[resolvedSourceModel] ||
              model_mapping["__unresolved__"] ||
              "";

            if (resolvedSourceModel && !mappedTarget) {
              skipped++;
              const result = {
                id: dashboard.id,
                name: dashboard.name,
                status: "skipped",
                error: `No mapping for model "${resolvedSourceModel}".`,
                source_model: resolvedSourceModel,
              };
              results.push(result);
              sendEvent({
                type: "progress",
                dashboard_id: dashboard.id,
                dashboard_name: dashboard.name,
                status: "skipped",
                error: result.error,
                index: i,
                total: dashboards.length,
              });
              continue;
            }

            if (in_place) {
              const targetModelId = mappedTarget || resolvedSourceModel;
              if (!targetModelId) {
                failed++;
                const result = {
                  id: dashboard.id,
                  name: dashboard.name,
                  status: "failed",
                  error: "No target model selected for in-place swap.",
                  source_model: resolvedSourceModel,
                  target_model: "",
                };
                results.push(result);
                sendEvent({
                  type: "progress",
                  dashboard_id: dashboard.id,
                  dashboard_name: dashboard.name,
                  status: "failed",
                  error: result.error,
                  index: i,
                  total: dashboards.length,
                });
                continue;
              }

              const noChange = resolvedSourceModel && resolvedSourceModel === targetModelId;

              if (dry_run) {
                let compatibility: CompatibilityPreflightResult | null = null;
                if (!noChange) {
                  const { data: preflightExportData, error: preflightExportError } = await exportDashboard(
                    source.base_url,
                    source.api_key,
                    dashboard.id
                  );
                  if (preflightExportError || !preflightExportData) {
                    compatibility = {
                      status: "warning",
                      referencedFields: [],
                      missingFields: [],
                      matchedFieldCount: 0,
                      targetFieldCount: null,
                      warnings: [
                        `${preflightExportError || "Export returned no data."} Payload structure could not be inspected before model remap.`,
                      ],
                    };
                  } else {
                    const { payload: preflightPayload } = normalizeExportPayload(preflightExportData);
                    compatibility = await runCompatibilityPreflight({
                      dashboardPayload: preflightPayload,
                      targetBaseUrl: target.base_url,
                      targetApiKey: target.api_key,
                      targetModelId,
                    });
                  }

                  sendEvent({
                    type: "diagnostic",
                    dashboard_id: dashboard.id,
                    dashboard_name: dashboard.name,
                    phase: "compatibility_preflight",
                    detail: {
                      referencedFieldCount: compatibility.referencedFields.length,
                      matchedFieldCount: compatibility.matchedFieldCount,
                      missingFields: compatibility.missingFields.slice(0, 25),
                      targetFieldCount: compatibility.targetFieldCount,
                      warnings: compatibility.warnings,
                      semanticCheckAvailable: compatibility.targetFieldCount !== null,
                    },
                  });
                }

                const compatibilityWarnings = compatibility?.warnings ?? [];
                succeeded++;
                const result = {
                  id: dashboard.id,
                  name: dashboard.name,
                  status: compatibilityWarnings.length > 0 ? "warning" : "success",
                  source_model: resolvedSourceModel,
                  target_model: targetModelId,
                  error: compatibilityWarnings.length > 0
                    ? compatibilityWarnings.join(" ")
                    : noChange ? "Model already correct -- no change needed." : undefined,
                  warnings: compatibilityWarnings,
                };
                results.push(result);
                sendEvent({
                  type: "diagnostic",
                  dashboard_id: dashboard.id,
                  dashboard_name: dashboard.name,
                  phase: "in_place_update",
                  detail: {
                    currentModelId: resolvedSourceModel,
                    targetModelId,
                    changed: !noChange,
                    dryRun: true,
                  },
                });
                sendEvent({
                  type: "progress",
                  dashboard_id: dashboard.id,
                  dashboard_name: dashboard.name,
                  status: compatibilityWarnings.length > 0 ? "warning" : "success",
                  error: result.error,
                  warnings: compatibilityWarnings,
                  index: i,
                  total: dashboards.length,
                });
                continue;
              }

              if (noChange) {
                succeeded++;
                const result = {
                  id: dashboard.id,
                  name: dashboard.name,
                  status: "success" as const,
                  error: "Model already correct -- no change needed.",
                  source_model: resolvedSourceModel,
                  target_model: targetModelId,
                };
                results.push(result);
                sendEvent({
                  type: "diagnostic",
                  dashboard_id: dashboard.id,
                  dashboard_name: dashboard.name,
                  phase: "in_place_update",
                  detail: {
                    currentModelId: resolvedSourceModel,
                    targetModelId,
                    changed: false,
                    skipped: true,
                  },
                });
                sendEvent({
                  type: "progress",
                  dashboard_id: dashboard.id,
                  dashboard_name: dashboard.name,
                  status: "success",
                  index: i,
                  total: dashboards.length,
                });
                continue;
              }

              const patchResult = await updateDashboardModelInPlace(
                target.base_url,
                target.api_key,
                dashboard.id,
                dashboard.name,
                targetModelId
              );

              sendEvent({
                type: "diagnostic",
                dashboard_id: dashboard.id,
                dashboard_name: dashboard.name,
                phase: "in_place_update",
                detail: {
                  currentModelId: resolvedSourceModel,
                  targetModelId,
                  changed: true,
                  status: patchResult.status ?? null,
                  ok: !patchResult.error,
                  error: patchResult.error ?? null,
                },
              });

              if (patchResult.error) {
                failed++;
                const result = {
                  id: dashboard.id,
                  name: dashboard.name,
                  status: "failed",
                  error: patchResult.error,
                  source_model: resolvedSourceModel,
                  target_model: targetModelId,
                };
                results.push(result);
                sendEvent({
                  type: "progress",
                  dashboard_id: dashboard.id,
                  dashboard_name: dashboard.name,
                  status: "failed",
                  error: patchResult.error,
                  index: i,
                  total: dashboards.length,
                });
              } else {
                succeeded++;
                const result = {
                  id: dashboard.id,
                  name: dashboard.name,
                  status: "success" as const,
                  source_model: resolvedSourceModel,
                  target_model: targetModelId,
                };
                results.push(result);
                sendEvent({
                  type: "progress",
                  dashboard_id: dashboard.id,
                  dashboard_name: dashboard.name,
                  status: "success",
                  index: i,
                  total: dashboards.length,
                });
              }
              continue;
            }

            const { data: rawExportData, error: exportError } = await exportDashboard(
              source.base_url,
              source.api_key,
              dashboard.id
            );

            if (exportError || !rawExportData) {
              failed++;
              const result = {
                id: dashboard.id,
                name: dashboard.name,
                status: "failed",
                error: exportError || "Export returned no data.",
                source_model: resolvedSourceModel,
                target_model: mappedTarget,
              };
              results.push(result);
              sendEvent({
                type: "progress",
                dashboard_id: dashboard.id,
                dashboard_name: dashboard.name,
                status: "failed",
                error: result.error,
                index: i,
                total: dashboards.length,
              });
              continue;
            }

            const rawTopKeys = rawExportData && typeof rawExportData === "object" && !Array.isArray(rawExportData)
              ? Object.keys(rawExportData as Record<string, unknown>)
              : [];

            const { payload: exportData, unwrapped } = normalizeExportPayload(rawExportData);

            const payloadModelId = findModelIdInPayload(exportData);
            const modelIdPath = findModelIdPath(exportData);
            const modelIdFieldCount = countModelIdFields(exportData);

            sendEvent({
              type: "diagnostic",
              dashboard_id: dashboard.id,
              dashboard_name: dashboard.name,
              phase: "post_export",
              detail: {
                rawTopLevelKeys: rawTopKeys,
                unwrappedEnvelope: unwrapped,
                modelIdFound: payloadModelId ?? null,
                modelIdPath: modelIdPath ?? null,
                modelIdFieldCount,
                payloadSizeBytes: JSON.stringify(exportData).length,
              },
            });

            const sourceModel = payloadModelId || resolvedSourceModel;

            if (!sourceModel && !mappedTarget) {
              failed++;
              const result = {
                id: dashboard.id,
                name: dashboard.name,
                status: "failed",
                error: "Could not determine source model ID -- enrichment may have failed for this dashboard.",
                source_model: "",
                target_model: "",
              };
              results.push(result);
              sendEvent({
                type: "progress",
                dashboard_id: dashboard.id,
                dashboard_name: dashboard.name,
                status: "failed",
                error: result.error,
                index: i,
                total: dashboards.length,
              });
              continue;
            }

            const effectiveTarget = mappedTarget || model_mapping[sourceModel] || "";

            if (!effectiveTarget) {
              failed++;
              const result = {
                id: dashboard.id,
                name: dashboard.name,
                status: "failed",
                error: `No target model mapping found for source model "${sourceModel}".`,
                source_model: sourceModel,
                target_model: "",
              };
              results.push(result);
              sendEvent({
                type: "progress",
                dashboard_id: dashboard.id,
                dashboard_name: dashboard.name,
                status: "failed",
                error: result.error,
                index: i,
                total: dashboards.length,
              });
              continue;
            }

            if (!payloadModelId && effectiveTarget) {
              injectModelId(exportData, resolvedSourceModel || effectiveTarget);
            }

            const effectiveMapping = { ...model_mapping };
            if (!resolvedSourceModel && mappedTarget) {
              const foundId = findModelIdInPayload(exportData);
              if (foundId && !effectiveMapping[foundId]) {
                effectiveMapping[foundId] = mappedTarget;
              }
            }

            const { result: transformed, replacements, folderReplacements, folderKeysFound } = deepTransform(
              exportData,
              effectiveMapping,
              target_folder
            );

            const folderRequested = !!target_folder && target_folder.length > 0;
            const folderInjected = folderRequested && folderKeysFound.length === 0;

            if (folderInjected) {
              injectFolderPath(transformed, target_folder!);
            }

            ensureTopLevelModelId(transformed, effectiveTarget);

            const allowedModelIds = new Set<string>();
            allowedModelIds.add(effectiveTarget);
            for (const v of Object.values(effectiveMapping)) {
              if (v) allowedModelIds.add(v);
            }
            const forcedReplacements = replaceAllModelIds(transformed, effectiveTarget, allowedModelIds);

            const importPayload = unwrapped
              ? { [unwrapped]: transformed }
              : transformed;

            const postTransformModelId = findModelIdInPayload(transformed);
            const postTransformTopKeys = transformed && typeof transformed === "object" && !Array.isArray(transformed)
              ? Object.keys(transformed as Record<string, unknown>)
              : [];

            sendEvent({
              type: "diagnostic",
              dashboard_id: dashboard.id,
              dashboard_name: dashboard.name,
              phase: "post_transform",
              detail: {
                replacements,
                folderReplacements,
                folderKeysFound,
                folderInjected,
                folderRequested,
                forcedModelIdReplacements: forcedReplacements,
                topLevelModelIdPresent: (() => {
                  if (!transformed || typeof transformed !== "object" || Array.isArray(transformed)) return false;
                  const rec = transformed as Record<string, unknown>;
                  for (const key of MODEL_ID_KEYS) {
                    if (typeof rec[key] === "string" && (rec[key] as string).length > 0) return true;
                  }
                  return false;
                })(),
                transformedModelId: postTransformModelId ?? null,
                transformedTopLevelKeys: postTransformTopKeys,
                envelopeRewrapped: unwrapped ?? null,
              },
            });

            const validationError = validateTransformedPayload(transformed);
            if (validationError) {
              failed++;
              const result = {
                id: dashboard.id,
                name: dashboard.name,
                status: "failed",
                error: validationError,
                source_model: sourceModel,
                target_model: effectiveTarget,
              };
              results.push(result);
              sendEvent({
                type: "progress",
                dashboard_id: dashboard.id,
                dashboard_name: dashboard.name,
                status: "failed",
                error: result.error,
                index: i,
                total: dashboards.length,
              });
              continue;
            }

            if (dry_run) {
              const compatibility = await runCompatibilityPreflight({
                dashboardPayload: transformed,
                targetBaseUrl: target.base_url,
                targetApiKey: target.api_key,
                targetModelId: effectiveTarget,
              });

              sendEvent({
                type: "diagnostic",
                dashboard_id: dashboard.id,
                dashboard_name: dashboard.name,
                phase: "compatibility_preflight",
                detail: {
                  referencedFieldCount: compatibility.referencedFields.length,
                  matchedFieldCount: compatibility.matchedFieldCount,
                  missingFields: compatibility.missingFields.slice(0, 25),
                  targetFieldCount: compatibility.targetFieldCount,
                  warnings: compatibility.warnings,
                  semanticCheckAvailable: compatibility.targetFieldCount !== null,
                },
              });

              succeeded++;
              const result = {
                id: dashboard.id,
                name: dashboard.name,
                status: compatibility.status,
                error: compatibility.warnings.length > 0 ? compatibility.warnings.join(" ") : undefined,
                source_model: sourceModel,
                target_model: effectiveTarget,
                warnings: compatibility.warnings,
              };
              results.push(result);
              sendEvent({
                type: "progress",
                dashboard_id: dashboard.id,
                dashboard_name: dashboard.name,
                status: compatibility.status,
                error: result.error,
                warnings: compatibility.warnings,
                replacements,
                index: i,
                total: dashboards.length,
              });
              continue;
            }

            const importResult = await importDashboard(
              target.base_url,
              target.api_key,
              importPayload
            );

            if (importResult.error) {
              failed++;
              const errorMsg = importResult.payloadSnapshot
                ? `${importResult.error} [payload preview: ${importResult.payloadSnapshot}]`
                : importResult.error;
              const result = {
                id: dashboard.id,
                name: dashboard.name,
                status: "failed",
                error: errorMsg,
                source_model: sourceModel,
                target_model: effectiveTarget,
              };
              results.push(result);
              sendEvent({
                type: "progress",
                dashboard_id: dashboard.id,
                dashboard_name: dashboard.name,
                status: "failed",
                error: importResult.error,
                index: i,
                total: dashboards.length,
              });
            } else {
              let folderMoveWarning: string | undefined;

              if (folderRequested) {
                const importedId = extractImportedDocumentId(importResult.data);
                if (importedId) {
                  const moveResult = await moveDocumentToFolder(
                    target.base_url,
                    target.api_key,
                    importedId,
                    target_folder!
                  );
                  if (!moveResult.success) {
                    folderMoveWarning = `Dashboard imported but folder move failed: ${moveResult.error}`;
                    sendEvent({
                      type: "diagnostic",
                      dashboard_id: dashboard.id,
                      dashboard_name: dashboard.name,
                      phase: "post_import_move",
                      detail: {
                        importedDocumentId: importedId,
                        targetFolder: target_folder,
                        moveError: moveResult.error ?? null,
                      },
                    });
                  } else {
                    sendEvent({
                      type: "diagnostic",
                      dashboard_id: dashboard.id,
                      dashboard_name: dashboard.name,
                      phase: "post_import_move",
                      detail: {
                        importedDocumentId: importedId,
                        targetFolder: target_folder,
                        moveSuccess: true,
                      },
                    });
                  }
                } else {
                  folderMoveWarning = "Dashboard imported but could not determine new document ID for folder move.";
                  sendEvent({
                    type: "diagnostic",
                    dashboard_id: dashboard.id,
                    dashboard_name: dashboard.name,
                    phase: "post_import_move",
                    detail: {
                      importResponseKeys: importResult.data && typeof importResult.data === "object"
                        ? Object.keys(importResult.data as Record<string, unknown>)
                        : [],
                      targetFolder: target_folder,
                      error: "Could not extract imported document ID from response",
                    },
                  });
                }
              }

              succeeded++;
              const resultStatus = folderMoveWarning ? "warning" as const : "success" as const;
              const result = {
                id: dashboard.id,
                name: dashboard.name,
                status: resultStatus,
                error: folderMoveWarning,
                source_model: sourceModel,
                target_model: effectiveTarget,
              };
              results.push(result);
              sendEvent({
                type: "progress",
                dashboard_id: dashboard.id,
                dashboard_name: dashboard.name,
                status: resultStatus,
                replacements,
                index: i,
                total: dashboards.length,
                warnings: folderMoveWarning ? [folderMoveWarning] : undefined,
              });
            }
          }

          sendEvent({
            type: "complete",
            summary: { succeeded, failed, skipped, total: dashboards.length },
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
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
