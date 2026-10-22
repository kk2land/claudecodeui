import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test } from 'vitest';

import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';

/**
 * The collapsed sidebar is the 48px icon rail shown when the panel is hidden.
 * It keeps the expand toggle, settings and update controls after removing
 * the Report Issue and Join Community entries from the sidebar.
 */

const LABELS: Record<string, string> = {
  'common:versionUpdate.ariaLabels.showSidebar': 'Show sidebar',
  'actions.settings': 'Settings',
  'common:versionUpdate.ariaLabels.updateAvailable': 'Update available',
  'version.restartRequired': 'Restart required',
  'actions.reportIssue': 'Report Issue',
  'actions.joinCommunity': 'Join Community',
};

const t = ((key: string, fallback?: string) => LABELS[key] ?? fallback ?? key) as unknown as TFunction;

const renderRail = (overrides: Partial<{ updateAvailable: boolean; restartRequired: boolean }> = {}) => {
  const calls = { expanded: 0, settings: 0, versionModal: 0 };
  const view = render(
    <SidebarCollapsed
      onExpand={() => {
        calls.expanded += 1;
      }}
      onShowSettings={() => {
        calls.settings += 1;
      }}
      updateAvailable={overrides.updateAvailable ?? false}
      restartRequired={overrides.restartRequired ?? false}
      onShowVersionModal={() => {
        calls.versionModal += 1;
      }}
      t={t}
    />,
  );
  return { calls, container: view.container };
};

test('the rail has no Report Issue or Join Community entry', () => {
  const { container } = renderRail();

  assert.equal(screen.queryByRole('button', { name: 'Report Issue' }), null);
  assert.equal(screen.queryByRole('link', { name: 'Report Issue' }), null);
  assert.equal(screen.queryByRole('button', { name: 'Join Community' }), null);
  assert.equal(screen.queryByRole('link', { name: 'Join Community' }), null);
  // The two removed entries were the rail's only anchors, so any remaining
  // link with an href would mean one of them crept back in.
  assert.deepEqual(
    [...container.querySelectorAll('a[href]')].map((anchor) => anchor.getAttribute('href')),
    [],
  );
});

test('the rail still expands and opens settings', () => {
  const { calls } = renderRail();

  fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

  assert.deepEqual(calls, { expanded: 1, settings: 1, versionModal: 0 });
});

test('an available update stays reachable and opens the version modal', () => {
  const { calls } = renderRail({ updateAvailable: true });

  fireEvent.click(screen.getByRole('button', { name: 'Update available' }));

  assert.deepEqual(calls, { expanded: 0, settings: 0, versionModal: 1 });
});

test('update and restart indicators stay off the rail until they apply', () => {
  renderRail();

  assert.equal(screen.queryByRole('button', { name: 'Update available' }), null);
  assert.equal(screen.queryByLabelText('Restart required'), null);
});

test('a pending restart is announced on the rail', () => {
  renderRail({ restartRequired: true });

  assert.ok(screen.getByLabelText('Restart required'));
});
