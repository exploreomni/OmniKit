import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set([
  '__fixtures__',
  '__tests__',
  'coverage',
  'dist',
  'docs',
  'examples',
  'fixtures',
  'node_modules',
  'test',
  'tests',
]);
export interface OmniApiUsage {
  method: string;
  path: string;
  file: string;
  line: number;
  column: number;
}

function staticText(node: ts.Node | undefined, constants: Map<string, string>): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text) ?? null;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression, constants);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return staticText(node.expression, constants);
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      value += ':param';
      value += span.literal.text;
    }
    return value;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left, constants);
    const right = staticText(node.right, constants);
    return left !== null && right !== null ? `${left}${right}` : null;
  }
  return null;
}

function collectStaticConstants(sourceFile: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = staticText(node.initializer, constants);
      if (value !== null) constants.set(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return constants;
}

function methodFromCall(node: ts.CallExpression, constants: Map<string, string>): string | null {
  for (const argument of node.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name.getText().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (name !== 'method') continue;
      const method = staticText(property.initializer, constants)?.toUpperCase();
      if (method && HTTP_METHODS.has(method)) return method;
    }
  }

  for (const argument of node.arguments) {
    const method = staticText(argument, constants)?.toUpperCase();
    if (method && HTTP_METHODS.has(method)) return method;
  }

  const calleeName = ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : ts.isIdentifier(node.expression)
      ? node.expression.text
      : '';
  const method = calleeName.toUpperCase();
  if (HTTP_METHODS.has(method)) return method;
  if (calleeName === 'fetch') return 'GET';
  return null;
}

export function normalizeOmniApiPath(rawValue: string): string | null {
  const value = rawValue.trim();
  const candidates = [
    '/api/unstable/',
    '/unstable/',
    '/api/scim/v2/',
    '/scim/v2/',
    '/api/v2/',
    '/v2/',
    '/api/v1/',
    '/v1/',
  ];
  const matches = candidates
    .map((candidate) => ({ candidate, index: value.indexOf(candidate) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index);
  if (matches.length === 0) return null;

  let endpoint = value.slice(matches[0].index).split(/[?#]/, 1)[0];
  if (!endpoint.startsWith('/api/')) endpoint = `/api${endpoint}`;
  endpoint = endpoint.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  // Optional query-string template expressions can collapse to a trailing
  // `:param` when the `?` itself lives inside the expression.
  endpoint = endpoint.replace(/(?<=[A-Za-z0-9_-]):param$/, '');
  return endpoint || null;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const productionRoot of ['server', 'src']) {
    const absoluteRoot = path.join(root, productionRoot);
    try {
      if (!statSync(absoluteRoot).isDirectory()) continue;
    } catch {
      continue;
    }

    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path.join(directory, entry.name));
          continue;
        }
        if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
        if (/\.(?:spec|test)\.[^.]+$/i.test(entry.name)) continue;
        files.push(path.join(directory, entry.name));
      }
    };
    walk(absoluteRoot);
  }
  return files.sort();
}

export function findOmniApiUsages(root: string): OmniApiUsage[] {
  const findings: OmniApiUsage[] = [];
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, 'utf8');
    const scriptKind = file.endsWith('.tsx') || file.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
    const constants = collectStaticConstants(sourceFile);

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const method = methodFromCall(node, constants);
        if (method) {
          for (const argument of node.arguments) {
            const value = staticText(argument, constants);
            if (value === null) continue;
            const endpoint = normalizeOmniApiPath(value);
            if (!endpoint) continue;
            const position = sourceFile.getLineAndCharacterOfPosition(argument.getStart(sourceFile));
            findings.push({
              method,
              path: endpoint,
              file: path.relative(root, file),
              line: position.line + 1,
              column: position.character + 1,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return findings.sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.method.localeCompare(right.method)
    || left.file.localeCompare(right.file)
    || left.line - right.line
  ));
}
