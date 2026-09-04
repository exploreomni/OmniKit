import type { UserModelRoleName } from '../omniApi';

export const IDENTITY_IMPORT_LIMITS = {
  maxRows: 5_000,
  maxCompiledOperations: 20_000,
  maxListValuesPerCell: 50,
  maxRoleTargetsPerRow: 100,
  maxTotalRoleTargets: 10_000,
  maxEmailLength: 320,
  maxDisplayNameLength: 256,
  maxGroupNameLength: 64,
  maxScopeNameLength: 256,
} as const;

export type IdentityModelRoleName = UserModelRoleName;

export const IDENTITY_NO_ASSIGNMENT_LABEL = 'No assignment';

const ROLE_ALIASES: Readonly<Record<string, IdentityModelRoleName>> = {
  viewer: 'VIEWER',
  restricted_querier: 'QUERY_TOPICS',
  query_topics: 'QUERY_TOPICS',
  querier: 'QUERIER',
  modeler: 'MODELER',
  admin: 'CONNECTION_ADMIN',
  connection_admin: 'CONNECTION_ADMIN',
  no_access: 'NO_ACCESS',
};

export function normalizeIdentityModelRole(value: string): IdentityModelRoleName | null {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ROLE_ALIASES[key] ?? null;
}

export function isIdentityNoAssignment(value: string): boolean {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '_') === 'no_assignment';
}

export function identityModelRoleLabel(roleName: IdentityModelRoleName): string {
  switch (roleName) {
    case 'VIEWER': return 'Viewer';
    case 'QUERY_TOPICS': return 'Restricted Querier';
    case 'QUERIER': return 'Querier';
    case 'MODELER': return 'Modeler';
    case 'CONNECTION_ADMIN': return 'Connection Admin';
    case 'NO_ACCESS': return 'No Access';
  }
}

export type EscapedIdentityList = {
  values: string[];
  duplicateCount: number;
};

const CSV_FORMULA_PREFIX_PATTERN = /^[\t\r\n ]*[=+\-@]/;

/**
 * Reserves one leading apostrophe as a reversible, spreadsheet-safe marker.
 * A real leading apostrophe is doubled so OmniKit exports round-trip exactly.
 */
export function escapeIdentityCsvValue(value: string): string {
  return value.startsWith("'") || CSV_FORMULA_PREFIX_PATTERN.test(value)
    ? `'${value}`
    : value;
}

export function unescapeIdentityCsvValue(value: string): string {
  if (value.startsWith("''")) return value.slice(1);
  if (value.startsWith("'") && CSV_FORMULA_PREFIX_PATTERN.test(value.slice(1))) return value.slice(1);
  return value;
}

/**
 * Parses a comma-delimited value inside one CSV cell. A literal comma is
 * represented as `\,` and a literal backslash as `\\`.
 */
export function parseEscapedIdentityList(
  value: string,
  options: { label: string; maxValueLength: number },
): EscapedIdentityList {
  if (!value.trim()) return { values: [], duplicateCount: 0 };

  const rawValues: string[] = [];
  let current = '';
  let escaping = false;
  for (const character of value) {
    if (escaping) {
      if (character !== ',' && character !== '\\') {
        throw new Error(`${options.label} uses an unsupported escape. Only \\, and \\\\ are allowed.`);
      }
      current += character;
      escaping = false;
      continue;
    }
    if (character === '\\') {
      escaping = true;
      continue;
    }
    if (character === ',') {
      rawValues.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (escaping) throw new Error(`${options.label} ends with an incomplete escape.`);
  rawValues.push(current);

  if (rawValues.length > IDENTITY_IMPORT_LIMITS.maxListValuesPerCell) {
    throw new Error(`${options.label} is limited to ${IDENTITY_IMPORT_LIMITS.maxListValuesPerCell} values per row.`);
  }

  const values: string[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const rawValue of rawValues) {
    const nextValue = unescapeIdentityCsvValue(rawValue.trim());
    if (!nextValue) throw new Error(`${options.label} contains an empty value.`);
    if (nextValue.length > options.maxValueLength) {
      throw new Error(`${options.label} values cannot exceed ${options.maxValueLength} characters.`);
    }
    if ([...nextValue].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })) {
      throw new Error(`${options.label} values cannot contain control characters.`);
    }
    const key = nextValue.normalize('NFC').toLowerCase();
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    values.push(nextValue);
  }
  return { values, duplicateCount };
}

export function escapeIdentityListValue(value: string): string {
  return escapeIdentityCsvValue(value).replace(/\\/g, '\\\\').replace(/,/g, '\\,');
}

export function joinIdentityList(values: string[]): string {
  return values.map(escapeIdentityListValue).join(', ');
}
