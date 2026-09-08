import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import manageUsers from '../server/handlers/manage-users';
import { executeIdentityImport, IDENTITY_IMPORT_TEMPLATE, parseIdentityImportCsv, preflightIdentityImport } from '../src/services/userManagement/bulkIdentityImport';

const URN = 'urn:omni:params:1.0:UserAttribute';
const ATTRIBUTE = 'omni_allows_personal_content';
const HEADERS = 'action,display_name,email,group,role,connection,model';
const EMAIL = 'person@example.com';
const scope = { key: 'personal-policy-test', instanceId: 'instance-test', label: 'Test instance' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const csv = (value: string, name = '') => `${HEADERS},allow_personal_content\nadd,${name},${EMAIL},,,,,${value}`;
type User = { id: string; userName: string; displayName: string; active: boolean; [key: string]: unknown };

function fixture(t: TestContext, options: { existing?: boolean; setting?: unknown; ignoreSetting?: boolean; rejectWrite?: boolean; missingDefinition?: boolean; displayName?: string; omitDetailAfterWrite?: boolean; wrongDetailIdentity?: boolean; withGroup?: boolean; member?: boolean } = {}) {
  const baseUrl = 'https://policy-test.omniapp.co';
  const key = `synthetic-${t.name}`;
  let user: User | undefined = options.existing === false ? undefined : {
    id: 'membership-example', userName: EMAIL, displayName: options.displayName ?? 'Example User', active: true,
    [URN]: { department: 'Preserved department', ...(options.setting !== undefined ? { [ATTRIBUTE]: options.setting } : {}) },
  };
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  const detailReads: string[] = [];
  const group = { id: 'example-group', displayName: 'Example group', members: options.member ? [{ value: 'membership-example' }] : [] };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || '{}'));
    // Real list/search responses can omit the extension despite a successful
    // setting change. Never let fixture-rich search results mask that contract.
    const listed = user ? { ...user } : undefined;
    if (listed) delete listed[URN];
    const users = listed ? [listed] : [];
    if (url === '/api/manage-users' && (body.action === 'list' || body.action === 'find')) {
      return json({ Resources: users, totalResults: users.length, itemsPerPage: users.length, startIndex: 1 });
    }
    if (url === '/api/manage-groups' && body.action === 'list') {
      const groups = options.withGroup ? [group] : [];
      return json({ Resources: groups, totalResults: groups.length, itemsPerPage: groups.length, startIndex: 1 });
    }
    if (url === '/api/manage-groups' && body.action === 'get' && options.withGroup) return json(group);
    if (url === '/api/manage-users' && body.action === 'get') {
      assert.equal(init?.cache, 'no-store');
      detailReads.push(body.user_id);
      const detail = user ? structuredClone(user) : undefined;
      if (detail && options.omitDetailAfterWrite && writes.length > 0) delete detail[URN];
      if (detail && options.wrongDetailIdentity) detail.userName = 'different@example.com';
      return manageUsers(new Request('http://localhost/api/manage-users', { method: 'POST', body: JSON.stringify(body) }), {
        assertSafeUrl: async () => undefined,
        fetchImpl: async (upstreamUrl, upstream) => {
          assert.equal(upstream?.method, 'GET');
          assert.equal(String(upstreamUrl), `${baseUrl}/api/scim/v2/users/${body.user_id}`);
          return json(detail ?? {}, detail ? 200 : 404);
        },
      });
    }
    if (url === '/api/manage-users' && body.action === 'list_attributes') {
      return json({ userAttributes: [
        { name: 'department', system: false }, { name: 'omni_is_org_admin', system: true },
        ...(!options.missingDefinition ? [{ name: ATTRIBUTE, system: true }] : []),
      ] });
    }
    if (url === '/api/manage-users' && ['create', 'update'].includes(body.action)) {
      return manageUsers(new Request('http://localhost/api/manage-users', { method: 'POST', body: JSON.stringify(body) }), {
        assertSafeUrl: async () => undefined,
        fetchImpl: async (_url, upstream) => {
          const payload = JSON.parse(String(upstream?.body));
          writes.push({ method: upstream?.method || '', body: payload });
          if (options.rejectWrite) return json({ error: 'Unsupported setting' }, 400);
          if (upstream?.method === 'POST') {
            user = { id: 'membership-example', active: true, ...payload } as User;
            if (options.ignoreSetting) delete (user[URN] as Record<string, unknown>)[ATTRIBUTE];
          } else {
            assert.equal(upstream?.method, 'PATCH');
            assert(user);
            for (const operation of payload.Operations) {
              if (operation.path.startsWith(`${URN}:`)) {
                const name = operation.path.slice(URN.length + 1);
                if (!(name === ATTRIBUTE && options.ignoreSetting)) (user[URN] as Record<string, unknown>)[name] = operation.value;
              } else user[operation.path] = operation.value;
            }
          }
          return json(user);
        },
      });
    }
    assert.fail(`Unexpected request: ${url} ${body.action}`);
  });
  return { baseUrl, key, writes, detailReads, get user() { return user; } };
}

test('optional personal content column preserves old files and distinguishes false, blank, conflicts and removals', () => {
  const old = parseIdentityImportCsv(`${HEADERS}\nadd,,${EMAIL},,,,`);
  assert.equal(old.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert(!Object.hasOwn(old.records[0], 'allowPersonalContent'));
  for (const [input, expected] of [['FALSE', false], ['true', true], ['', undefined]] as const) {
    const plan = parseIdentityImportCsv(csv(input));
    assert.equal(plan.issues.filter((issue) => issue.severity === 'error').length, 0);
    assert.equal(plan.records[0].type === 'user' && plan.records[0].allowPersonalContent, expected);
  }
  assert(parseIdentityImportCsv(csv('no')).issues.some((issue) => issue.severity === 'error'));
  assert(parseIdentityImportCsv(csv('false').replace('\nadd,', '\nremove,')).issues.some((issue) => /only supported with add/.test(issue.message)));
  const duplicate = parseIdentityImportCsv(`${csv('false')}\nadd,,${EMAIL},,,,,true`);
  assert(duplicate.issues.some((issue) => /Conflicting allow_personal_content/.test(issue.message)));
  const merged = parseIdentityImportCsv(`${csv('')}\nadd,,${EMAIL},,,,,false`);
  assert.equal(merged.records.length, 1);
  assert.deepEqual(merged.records[0].rowNumbers, [2, 3]);
  assert.equal(merged.records[0].type === 'user' && merged.records[0].allowPersonalContent, false);
  assert(IDENTITY_IMPORT_TEMPLATE.every((row) => row.length === 8));
});

test('existing true can become false through a targeted PATCH and verified field result', async (t) => {
  const f = fixture(t, { setting: true });
  const preflight = await preflightIdentityImport(f.baseUrl, f.key, parseIdentityImportCsv(csv('false')), scope);
  assert.deepEqual(preflight.personalContentChanges[0], { email: EMAIL, rowNumbers: [2], current: 'enabled', requested: false, disposition: 'set' });
  assert.equal(preflight.changes.usersToUpdate, 1);
  const results = await executeIdentityImport(f.baseUrl, f.key, preflight, undefined, scope);
  assert.deepEqual(f.writes, [{ method: 'PATCH', body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [{ op: 'replace', path: `${URN}:${ATTRIBUTE}`, value: 'false' }] } }]);
  assert.equal(f.user?.active, true);
  assert.equal(f.user?.displayName, 'Example User');
  assert.equal((f.user?.[URN] as Record<string, unknown>).department, 'Preserved department');
  assert(results.some((result) => result.field === 'allow_personal_content' && result.status === 'succeeded'));
  assert.equal(results.filter((result) => result.status === 'failed').length, 0);
  assert.equal(f.detailReads.length, 3, 'one preview read, one revalidation, and one post-write read; no polling');
});

test('boolean false readback is a no-op, while blank never resends the setting during user completion', async (t) => {
  const f = fixture(t, { setting: false, displayName: '' });
  const noop = await preflightIdentityImport(f.baseUrl, f.key, parseIdentityImportCsv(csv('false')), scope);
  assert.equal(noop.personalContentChanges[0].disposition, 'noop');
  const noopResults = await executeIdentityImport(f.baseUrl, f.key, noop, undefined, scope);
  assert.equal(f.writes.length, 0);
  assert(noopResults.some((result) => result.field === 'allow_personal_content' && result.status === 'skipped'));
  const blank = await preflightIdentityImport(f.baseUrl, `${f.key}-completion`, parseIdentityImportCsv(csv('', 'Completed User')), scope);
  await executeIdentityImport(f.baseUrl, `${f.key}-completion`, blank, undefined, scope);
  assert.deepEqual(f.writes[0].body.Operations, [{ op: 'replace', path: 'displayName', value: 'Completed User' }]);
  assert.equal((f.user?.[URN] as Record<string, unknown>)[ATTRIBUTE], false);
});

test('new user gets the explicit setting in POST and no separate fallback request', async (t) => {
  const f = fixture(t, { existing: false });
  const preflight = await preflightIdentityImport(f.baseUrl, f.key, parseIdentityImportCsv(csv('false', 'Example User')), scope);
  assert.equal(preflight.personalContentChanges[0].current, 'new_user');
  const results = await executeIdentityImport(f.baseUrl, f.key, preflight, undefined, scope);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].method, 'POST');
  assert.deepEqual(f.writes[0].body[URN], { [ATTRIBUTE]: 'false' });
  assert(results.some((result) => result.field === 'allow_personal_content' && result.status === 'succeeded'));
});

test('ignored or rejected setting never reports success and never automatically retries creation', async (t) => {
  for (const rejected of [false, true]) await t.test(rejected ? 'rejected' : 'ignored', async (subtest) => {
    const f = fixture(subtest, { existing: false, ignoreSetting: !rejected, rejectWrite: rejected });
    const preflight = await preflightIdentityImport(f.baseUrl, f.key, parseIdentityImportCsv(csv('false', 'Example User')), scope);
    const results = await executeIdentityImport(f.baseUrl, f.key, preflight, undefined, scope);
    assert.equal(f.writes.length, 1);
    assert(results.some((result) => result.field === 'allow_personal_content' && result.status === 'failed'));
    assert(!results.some((result) => result.status === 'succeeded'));
  });
});

test('missing definition and unsupported system attributes remain blocked', async (t) => {
  const f = fixture(t, { setting: true, missingDefinition: true });
  const preflight = await preflightIdentityImport(f.baseUrl, f.key, parseIdentityImportCsv(csv('false')), scope);
  assert.equal(preflight.personalContentChanges[0].disposition, 'blocked');
  await assert.rejects(executeIdentityImport(f.baseUrl, f.key, preflight, undefined, scope), /preflight errors/);
  const legacy = parseIdentityImportCsv(`record_type,action,email,display_name,attribute_omni_is_org_admin\nuser,upsert,${EMAIL},Example User,true`);
  const blocked = await preflightIdentityImport(f.baseUrl, `${f.key}-legacy`, legacy, scope);
  assert(blocked.issues.some((issue) => /system-managed/.test(issue.message)));
  assert.equal(f.writes.length, 0);
});

test('setting drift and instance changes invalidate approval before a write', async (t) => {
  const f = fixture(t, { setting: true });
  const preflight = await preflightIdentityImport(f.baseUrl, f.key, parseIdentityImportCsv(csv('false')), scope);
  await assert.rejects(executeIdentityImport(f.baseUrl, f.key, preflight, undefined, { ...scope, instanceId: 'other' }), /instance changed/);
  (f.user?.[URN] as Record<string, unknown>)[ATTRIBUTE] = false;
  await assert.rejects(executeIdentityImport(f.baseUrl, f.key, preflight, undefined, scope), /inventory changed/);
  assert.equal(f.writes.length, 0);
});

test('missing detailed setting remains unverified without duplicate user failures or failing already-satisfied membership', async (t) => {
  const f = fixture(t, { setting: true, omitDetailAfterWrite: true, withGroup: true, member: true });
  const input = `${HEADERS},allow_personal_content\nadd,Example User,${EMAIL},Example group,,,,false`;
  const checked = await preflightIdentityImport(f.baseUrl, f.key, parseIdentityImportCsv(input), scope);
  const results = await executeIdentityImport(f.baseUrl, f.key, checked, undefined, scope);
  assert.equal((f.user?.[URN] as Record<string, unknown>)[ATTRIBUTE], 'false', 'write applied but response lacks evidence');
  assert.equal(f.writes.length, 1, 'an ambiguous write is not retried');
  const failures = results.filter((result) => result.status === 'failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].field, 'allow_personal_content');
  assert.match(failures[0].message, /individual user response omitted/);
  assert(results.some((result) => result.field === 'membership' && result.status === 'skipped' && /already in/.test(result.message)));
  assert(!results.some((result) => /unavailable/.test(result.message)));
});

test('unverified setting blocks required membership writes with an accurate dependency explanation', async (t) => {
  const f = fixture(t, { setting: true, ignoreSetting: true, withGroup: true });
  const input = `${HEADERS},allow_personal_content\nadd,,${EMAIL},Example group,,,,false`;
  const checked = await preflightIdentityImport(f.baseUrl, f.key, parseIdentityImportCsv(input), scope);
  const results = await executeIdentityImport(f.baseUrl, f.key, checked, undefined, scope);
  assert(results.some((result) => result.field === 'allow_personal_content' && result.status === 'failed'));
  assert(results.some((result) => result.field === 'membership' && result.status === 'failed' && /not attempted/.test(result.message)));
  assert.equal(f.writes.length, 1);
});

test('exact user detail must match the preview email before any write', async (t) => {
  const f = fixture(t, { setting: true, wrongDetailIdentity: true });
  await assert.rejects(preflightIdentityImport(f.baseUrl, f.key, parseIdentityImportCsv(csv('false')), scope), /exact user/);
  assert.equal(f.writes.length, 0);
});

test('bulk UI explains the policy and shows its before-and-after preview', () => {
  const source = readFileSync(new URL('../src/pages/BulkIdentityImportPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /allow_personal_content/);
  assert.match(source, /personalContentChangesByRow/);
  assert.match(source, /My documents/);
  assert.match(source, /Personal content/);
});
