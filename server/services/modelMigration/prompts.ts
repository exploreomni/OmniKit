export const MODEL_MIGRATION_PROMPT_VERSION = '2026-06-12-model-migrator-v1';

export function buildDialectTranslationPrompt(input: {
  sourceDialect: string;
  targetDialect: string;
  fileName: string;
  schemaMap: Array<{ source: string; target: string }>;
  yaml: string;
}): string {
  const schemaMap = input.schemaMap.length > 0
    ? input.schemaMap.map((row) => `- ${row.source} -> ${row.target}`).join('\n')
    : '- No schema map provided; do not rewrite catalog or schema names unless they are unambiguous.';

  return [
    `Prompt version: ${MODEL_MIGRATION_PROMPT_VERSION}`,
    `Task: translate Omni semantic YAML SQL from ${input.sourceDialect || 'source dialect'} to ${input.targetDialect || 'target dialect'}.`,
    '',
    'Hard rules:',
    '- Never invent views, fields, joins, topics, filters, or business logic.',
    '- Preserve Omni view and field names unless the input explicitly renames them.',
    '- Mark every rewritten sql block as needing human review in the response notes.',
    '- Refuse with a short blocker note when a function or dialect feature is ambiguous.',
    '- Return complete file content, not patches.',
    '',
    'Schema map:',
    schemaMap,
    '',
    `File: ${input.fileName}`,
    'YAML:',
    input.yaml,
  ].join('\n');
}
