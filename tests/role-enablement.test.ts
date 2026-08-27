import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENABLEMENT_ROLES,
  generateRoleEnablementPath,
  roleEnablementMarkdown,
} from '../src/services/roleEnablement';

test('role enablement supports the five requested learning roles', () => {
  assert.deepEqual(ENABLEMENT_ROLES, ['Viewer', 'Restricted Querier', 'Querier', 'Modeler', 'Admin']);
  for (const role of ENABLEMENT_ROLES) {
    const path = generateRoleEnablementPath({ role, depth: 'core', generatedAt: '2026-08-26T12:00:00.000Z' });
    assert.ok(path.modules.length > 0, `${role} should receive at least one module`);
    assert.ok(path.totalMinutes > 0);
  }
});

test('Restricted Querier path translates the learning label to the Query Topics boundary', () => {
  const path = generateRoleEnablementPath({
    role: 'Restricted Querier',
    depth: 'core',
    goals: ['explore'],
    generatedAt: '2026-08-26T12:00:00.000Z',
  });
  const markdown = roleEnablementMarkdown(path);

  assert.equal(path.omniRoleLabel, 'Restricted Querier (Query Topics)');
  assert.match(markdown, /Query Topics/);
  assert.match(markdown, /test user/i);
  assert.match(markdown, /does not assign an Omni role/i);
  assert.doesNotMatch(markdown, /role assignment (?:is )?complete/i);
});

test('enablement modules reuse existing OmniKit app, walkthrough, or deck routes', () => {
  const path = generateRoleEnablementPath({ role: 'Admin', depth: 'deep_dive' });
  assert.ok(path.modules.every((module) => module.asset.route.startsWith('/')));
  assert.ok(path.modules.some((module) => module.asset.kind === 'walkthrough'));
  assert.ok(path.modules.some((module) => module.asset.kind === 'app'));
});
