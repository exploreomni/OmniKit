import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildEmbedActivity } from '../server/handlers/instance-dashboard';
import type { OmniEmbedUserRecord } from '../server/services/omniClient';

function user(
  id: string,
  patch: Partial<OmniEmbedUserRecord> & { filtered?: boolean },
): OmniEmbedUserRecord & { filtered: boolean } {
  return {
    id,
    displayName: id,
    userName: `${id}@example.com`,
    active: true,
    embedExternalId: id,
    groups: [],
    lastLogin: null,
    createdAt: new Date().toISOString(),
    filtered: false,
    ...patch,
  };
}

test('embed-user activity excludes filtered users and counts login windows', () => {
  const now = Date.now();
  const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  const activity = buildEmbedActivity([
    user('active-7d', { lastLogin: daysAgo(2), createdAt: daysAgo(20) }),
    user('active-30d', { lastLogin: daysAgo(20), createdAt: daysAgo(40) }),
    user('active-90d', { lastLogin: daysAgo(70), createdAt: daysAgo(80) }),
    user('never', { lastLogin: null, createdAt: daysAgo(5) }),
    user('filtered', { lastLogin: daysAgo(1), filtered: true }),
  ]);

  assert.equal(activity.active7d, 1);
  assert.equal(activity.active30d, 2);
  assert.equal(activity.active90d, 3);
  assert.equal(activity.neverLoggedIn, 1);
  assert.equal(activity.weeklyLogins.reduce((sum, row) => sum + row.count, 0), 3);
  assert.ok(activity.monthlySignups.reduce((sum, row) => sum + row.count, 0) >= 3);
});
