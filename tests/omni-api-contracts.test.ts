import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  findOmniApiUsages,
  normalizeOmniApiPath,
} from '../scripts/omni-api-contract-scanner';
import {
  classifyOmniApiFailure,
  findOmniApiContract,
  OMNI_API_CONTRACTS,
} from '../server/services/omniApiContracts';

const tempRoots: string[] = [];

function makeSourceTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'omnikit-api-contracts-'));
  tempRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() || '', { recursive: true, force: true });
  }
});

test('scanner resolves dynamic Omni endpoints and optional query templates', () => {
  const root = makeSourceTree({
    'server/live.ts': `
      const modelId = 'model-1';
      const query = '?include=fields';
      fetch(\`https://example.omniapp.co/api/v1/models/\${modelId}/yaml\${query}\`);
      client.request('POST', '/api/v1/query/run');
    `,
  });

  assert.deepEqual(findOmniApiUsages(root).map(({ method, path: endpoint }) => ({ method, endpoint })), [
    { method: 'GET', endpoint: '/api/v1/models/:param/yaml' },
    { method: 'POST', endpoint: '/api/v1/query/run' },
  ]);
  assert.equal(normalizeOmniApiPath('/v2/documents/doc-1?draft=true'), '/api/v2/documents/doc-1');
  assert.equal(
    normalizeOmniApiPath(':param/api/scim/v2/groups?count=100'),
    '/api/scim/v2/groups',
  );
});

test('scanner excludes tests, fixtures, and docs', () => {
  const root = makeSourceTree({
    'server/live.ts': "fetch('/api/v1/folders');",
    'server/fixtures/example.ts': "fetch('/api/v1/not-real');",
    'src/component.test.ts': "fetch('/api/v1/not-real');",
    'tests/example.ts': "fetch('/api/v1/not-real');",
  });

  assert.deepEqual(findOmniApiUsages(root).map(({ path: endpoint }) => endpoint), ['/api/v1/folders']);
});

test('every production Omni endpoint is classified and none is retired, deprecated, or policy-prohibited', () => {
  const usages = findOmniApiUsages(process.cwd());
  const missing = usages.filter((usage) => !findOmniApiContract(usage.method, usage.path));
  const blocked = usages.filter((usage) => {
    const contract = findOmniApiContract(usage.method, usage.path);
    return contract?.status === 'retired'
      || contract?.status === 'deprecated'
      || contract?.productionPolicy === 'prohibited';
  });

  assert.deepEqual(missing, []);
  assert.deepEqual(blocked, []);
  assert.ok(usages.length > 50, 'Expected the production endpoint inventory to be non-trivial.');
});

test('registry operations and ids are unique and unverified contracts explain the gap', () => {
  const ids = new Set<string>();
  const operations = new Set<string>();
  for (const contract of OMNI_API_CONTRACTS) {
    assert.equal(ids.has(contract.id), false, `Duplicate contract id ${contract.id}`);
    ids.add(contract.id);
    if (contract.status === 'unverified') assert.ok(contract.notes?.trim(), contract.id);
    for (const method of contract.methods) {
      const operation = `${method} ${contract.path}`;
      assert.equal(operations.has(operation), false, `Duplicate operation ${operation}`);
      operations.add(operation);
    }
  }
});

test('mixed GET and mutation paths are operation-specific and readiness reads stay read-only', () => {
  const documentedReadOnlyPostQueries = new Set([
    'POST /api/v1/ai/credit-usage/users',
    'POST /api/v1/ai/credit-usage/entity-groups',
  ]);
  for (const contract of OMNI_API_CONTRACTS) {
    assert.equal(
      contract.methods.includes('GET') && contract.methods.some((method) => method !== 'GET'),
      false,
      `${contract.id} mixes GET with a mutation method`,
    );
    if (contract.methods.includes('GET') && contract.status !== 'deprecated' && contract.status !== 'retired') {
      assert.equal(contract.probeMode, 'read_only', `${contract.id} GET must be read-only`);
    }
    if (contract.probeMode === 'read_only') {
      assert.ok(contract.methods.every((method) => (
        method === 'GET' || documentedReadOnlyPostQueries.has(`${method} ${contract.path}`)
      )), `${contract.id} non-GET cannot be a read-only operation without an explicit contract exception`);
    }
  }

  assert.equal(findOmniApiContract('GET', '/api/v1/api-keys')?.id, 'api-keys-list');
  assert.equal(findOmniApiContract('GET', '/api/v1/schedules/schedule-1')?.id, 'schedule-get');
  assert.equal(findOmniApiContract('POST', '/api/v1/schedules')?.id, 'schedules-create');
  assert.equal(findOmniApiContract('PUT', '/api/v1/schedules/schedule-1')?.id, 'schedule-update-delete');
  assert.equal(findOmniApiContract('POST', '/api/v1/users/user-1/model-roles')?.probeMode, 'controlled_write');
  assert.equal(findOmniApiContract('GET', '/api/v1/users/user-1/model-roles')?.probeMode, 'read_only');
  assert.equal(findOmniApiContract('POST', '/api/scim/v2/users')?.probeMode, 'controlled_write');
  assert.equal(findOmniApiContract('GET', '/api/scim/v2/users')?.probeMode, 'read_only');
  assert.equal(findOmniApiContract('POST', '/api/v1/ai/credit-usage/users')?.probeMode, 'read_only');
  assert.equal(findOmniApiContract('POST', '/api/v1/ai/credit-usage/entity-groups')?.probeMode, 'read_only');
});

test('current registry corrections preserve read-versus-write semantics', () => {
  assert.equal(findOmniApiContract('GET', '/api/v1/models/model-1/content-validator')?.probeMode, 'read_only');
  assert.equal(findOmniApiContract('POST', '/api/v1/models/model-1/content-validator')?.id, 'content-validator-find-replace');
  assert.equal(findOmniApiContract('POST', '/api/v1/models/model-1/content-validator')?.probeMode, 'manual_only');

  for (const [method, endpoint] of [
    ['POST', '/api/v1/models/model-1/migrate'],
    ['DELETE', '/api/v1/models/model-1/view/orders'],
    ['GET', '/api/v1/query/wait'],
    ['GET', '/api/v1/ai/credit-controls'],
    ['GET', '/api/v1/schedules/schedule-1/recipients'],
    ['GET', '/api/v1/connections/connection-1/dbt/environments'],
  ] as const) {
    assert.equal(findOmniApiContract(method, endpoint)?.status, 'documented_current', `${method} ${endpoint}`);
  }

  const dbtWrite = findOmniApiContract('POST', '/api/v1/models/model-1/branch/reviewed/dbt');
  assert.equal(dbtWrite?.probeMode, 'manual_only');
  assert.match(dbtWrite?.notes || '', /confirmation/i);

  for (const [method, endpoint] of [
    ['GET', '/api/v1/ai/eval/prompt-sets'],
    ['GET', '/api/v1/ai/eval/prompt-sets/prompt-set-1'],
    ['GET', '/api/v1/ai/eval/runs'],
    ['GET', '/api/v1/ai/eval/runs/run-1'],
  ] as const) {
    const contract = findOmniApiContract(method, endpoint);
    assert.equal(contract?.status, 'documented_current', `${method} ${endpoint}`);
    assert.equal(contract?.probeMode, 'read_only', `${method} ${endpoint}`);
  }

  for (const [method, endpoint] of [
    ['POST', '/api/v1/ai/eval/prompt-sets'],
    ['PATCH', '/api/v1/ai/eval/prompt-sets/prompt-set-1'],
    ['DELETE', '/api/v1/ai/eval/prompt-sets/prompt-set-1'],
    ['POST', '/api/v1/ai/eval/prompt-sets/prompt-set-1/unarchive'],
    ['POST', '/api/v1/ai/eval/runs'],
    ['POST', '/api/v1/ai/eval/runs/run-1/cancel'],
    ['POST', '/api/v1/ai/eval/runs/run-1/unarchive'],
    ['DELETE', '/api/v1/ai/eval/runs/run-1'],
  ] as const) {
    const contract = findOmniApiContract(method, endpoint);
    assert.equal(contract?.status, 'documented_current', `${method} ${endpoint}`);
    assert.equal(contract?.probeMode, 'manual_only', `${method} ${endpoint}`);
  }
});

test('method-specific documentation links retain documented operation status', () => {
  const documentedOperations = [
    ['POST', '/api/v1/models/model-1/yaml', 'https://docs.omni.co/api/models/create-or-update-yaml-files'],
    ['DELETE', '/api/v1/models/model-1/yaml', 'https://docs.omni.co/api/models/delete-a-yaml-file'],
    ['GET', '/api/v2/documents/document-1/draft/draft-1', 'https://docs.omni.co/api/documents-v2/get-draft-state'],
    ['PATCH', '/api/v2/documents/document-1/draft/draft-1', 'https://docs.omni.co/api/documents-v2/patch-draft'],
    ['POST', '/api/v2/documents/document-1/draft/publish', 'https://docs.omni.co/api/documents-v2/publish-draft'],
  ] as const;

  for (const [method, path, docsUrl] of documentedOperations) {
    const contract = findOmniApiContract(method, path);
    assert.equal(contract?.status, 'documented_current', `${method} ${path}`);
    assert.equal(contract?.docsUrl, docsUrl, `${method} ${path}`);
  }
});

test('topic contracts preserve supported reads while quarantining direct mutations', () => {
  assert.equal(
    findOmniApiContract('GET', '/api/v1/models/model-1/topic/orders')?.status,
    'documented_current',
  );
  assert.equal(
    findOmniApiContract('POST', '/api/v1/models/model-1/topic')?.status,
    'unverified',
  );
  assert.equal(
    findOmniApiContract('POST', '/api/v1/models/model-1/topic')?.productionPolicy,
    'prohibited',
  );
  assert.equal(
    findOmniApiContract('PATCH', '/api/v1/models/model-1/topic/orders')?.status,
    'unverified',
  );
  assert.equal(
    findOmniApiContract('PATCH', '/api/v1/models/model-1/topic/orders')?.productionPolicy,
    'prohibited',
  );
  assert.equal(
    findOmniApiContract('DELETE', '/api/v1/models/model-1/topic/orders')?.status,
    'unverified',
  );
  assert.equal(
    findOmniApiContract('DELETE', '/api/v1/models/model-1/topic/orders')?.productionPolicy,
    'prohibited',
  );
  assert.equal(
    findOmniApiContract('POST', '/api/v1/models/model-1/yaml')?.status,
    'documented_current',
  );
  assert.equal(
    findOmniApiContract('DELETE', '/api/v1/models/model-1/yaml')?.status,
    'documented_current',
  );
});

test('Topic Builder has no direct topic-mutation client or modal surface', () => {
  const apiSource = readFileSync(path.join(process.cwd(), 'src/services/omniApi.ts'), 'utf8');
  const pageSource = readFileSync(path.join(process.cwd(), 'src/pages/TopicsPage.tsx'), 'utf8');
  const handlerSource = readFileSync(path.join(process.cwd(), 'server/handlers/manage-topics.ts'), 'utf8');

  assert.doesNotMatch(apiSource, /export async function (?:createTopic|updateTopic|deleteTopic)\b/);
  assert.doesNotMatch(pageSource, /\b(?:TopicFormModal|TopicDetailModal|ConfirmDialog)\b/);
  assert.doesNotMatch(handlerSource, /case ["'](?:create|update|delete)["']/);
  assert.match(pageSource, /ReviewedTopicDeletePanel/);
  assert.match(pageSource, /stageGovernedTopicMutation/);
  assert.match(pageSource, /expectedPreWriteSnapshot:\s*governedTopicExpectedSnapshot/);
  assert.match(pageSource, /yaml:\s*branchTopicFile\.yaml/);
  assert.match(pageSource, /checksum:\s*branchYamlBefore\.checksums\?\.\[branchTopicFile\.fileName\]/);
  assert.match(pageSource, /currentBranchYaml\.checksums\?\.\[file\.fileName\]\s*!==\s*deployDevYaml\.checksums\?\.\[file\.fileName\]/);
  assert.match(
    pageSource,
    /validateReviewedModelBranch\(connection, reviewedBranch,\s*\{\s*baselineContentResult:\s*currentMainContentValidation,\s*\}\)/,
  );
  assert.match(pageSource, /createReviewedModelPullRequestHandoff/);
  assert.doesNotMatch(pageSource, /publishReviewedModelBranch/);
  assert.doesNotMatch(pageSource, /branchYamlBefore\.checksums\?\.\[file\.fileName\]\s*\|\|\s*mainYaml\.checksums/);
});

test('hosted security workflow reaches Omni API and Documents V2 checks through the canonical gate', () => {
  const workflowSource = readFileSync(path.join(process.cwd(), '.github/workflows/security.yml'), 'utf8');
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const securityCheck = packageJson.scripts?.['security:check'] || '';

  assert.match(workflowSource, /npm run test:release-gate-coverage/);
  assert.match(workflowSource, /npm run security:check/);
  assert.match(securityCheck, /npm run test:omni-api-contracts/);
  assert.match(securityCheck, /npm run verify:omni-api-contracts/);
  assert.match(securityCheck, /npm run test:documents-v2-contract/);
});

test('failure classification separates contract retirement from auth and transient failures', () => {
  assert.equal(classifyOmniApiFailure(401), 'authentication');
  assert.equal(classifyOmniApiFailure(403), 'authentication');
  assert.equal(classifyOmniApiFailure(404), 'contract');
  assert.equal(classifyOmniApiFailure(405), 'contract');
  assert.equal(classifyOmniApiFailure(410), 'contract');
  assert.equal(classifyOmniApiFailure(429), 'transient');
  assert.equal(classifyOmniApiFailure(503), 'transient');
  assert.equal(classifyOmniApiFailure(422), 'request');
  assert.equal(classifyOmniApiFailure(200), 'unknown');
});
