import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DestinationFolderPicker } from '../src/components/dashboardMigration/DestinationFolderPicker';
import { destinationFolderChoices, destinationFolderPatch, destinationFolderSelection, destinationPage, TOP_LEVEL_FOLDER } from '../src/components/dashboardMigration/dashboardDestinationSelection';
import { EMPTY_FOLDER_CATALOG } from '../src/components/dashboardMigration/useDashboardDestinationFolders';

test('folder picker uses stable IDs, deduplicates nested entries and never submits synthesized paths', () => {
  const choices = destinationFolderChoices([
    { id: 'parent', name: 'Shared', path: '/Shared', children: [{ id: 'child', name: 'Reports' }] },
    { id: 'different', name: 'Reports', path: '/Finance/Reports' },
    { id: 'parent', name: 'Shared', path: '/Shared' },
  ]);
  assert.equal(choices.length, 3);
  assert.equal(choices.find((choice) => choice.folderId === 'child')?.label, '/Shared / Reports');
  assert.deepEqual(destinationFolderPatch(choices, 'folder:child'), { folderId: 'child', folderPath: '' });
  assert.deepEqual(destinationFolderPatch(choices, 'folder:different'), { folderId: 'different', folderPath: '/Finance/Reports' });
  assert.deepEqual(destinationFolderPatch(choices, TOP_LEVEL_FOLDER), { folderId: '', folderPath: '' });
});

test('missing or renamed saved folders are kept visibly without silently changing scope', () => {
  const choices = destinationFolderChoices([{ id: 'saved', name: 'New', path: '/New' }]);
  const original = { folderId: 'saved', folderPath: '/Old' };
  const missing = destinationFolderSelection(choices, original);
  assert.equal(missing.missing, true);
  assert.equal(missing.options.find((option) => option.value === missing.value)?.label, '/Old');
  assert.equal(destinationFolderPatch(choices, missing.value), undefined);
  assert.deepEqual(original, { folderId: 'saved', folderPath: '/Old' });
  assert.equal(destinationFolderSelection(choices, { folderPath: 'New/' }).value, 'folder:saved');
});

test('100 selected destinations render ten per page with stable identities and clamped removal', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ targetId: `destination-${index}` }));
  assert.equal(destinationPage(rows, 0).rows.length, 10);
  assert.equal(destinationPage(rows, 9).rows[0].targetId, 'destination-90');
  assert.equal(destinationPage(rows, 9).pageCount, 10);
  assert.equal(destinationPage(rows.slice(0, 89), 9).page, 8);
  assert.deepEqual(destinationPage([], 9), { page: 0, pageCount: 1, rows: [] });
});

test('folder control is a searchable list and errors remain distinct from empty results', () => {
  const markup = renderToStaticMarkup(<DestinationFolderPicker rowLabel="Destination 1" disabled={false} catalog={{ ...EMPTY_FOLDER_CATALOG, error: 'Folder access unavailable.' }} onLoad={() => {}} onChange={() => {}} />);
  assert.match(markup, /role="combobox"/);
  assert.match(markup, /aria-label="Destination 1 folder"/);
  assert.match(markup, /Folder access unavailable/);
  assert.match(markup, /role="alert"/);
  assert.doesNotMatch(markup, /folder input type/);
});

test('large fleets use one searchable add control and one lazily loaded row editor', () => {
  const source = readFileSync(new URL('../src/components/dashboardMigration/DashboardSafeCopyFlow.tsx', import.meta.url), 'utf8');
  assert.match(source, /ariaLabel="Instance to add as a destination"/);
  assert.match(source, /destinationWindow\.rows\.map/);
  assert.match(source, /expanded && <div id=/);
  assert.match(source, /loadDestinationCatalog\(activeDestinationInstanceId\)/);
  assert.doesNotMatch(source, /destinationInstances\.map\(\(instance\) => <button/);
  assert.doesNotMatch(source, /folder input type/);
});
