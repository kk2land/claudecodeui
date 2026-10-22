import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test } from 'vitest';

import SidebarFooter from '@/modules/sidebar/SidebarFooter';

/**
 * The footer is the panel's bottom bar. It used to offer Report Issue and Join
 * Community above Settings on both layouts; those two entries are gone, and the
 * footer must not start linking off to them again from either breakpoint.
 */

const LABELS: Record<string, string> = {
  'actions.settings': 'Settings',
  'version.updateAvailable': 'Update available',
  'version.restartRequired': 'Restart required',
  'branding.openSource': 'Open Source',
};

const t = ((key: string, fallback?: string) => LABELS[key] ?? fallback ?? key) as unknown as TFunction;

const renderFooter = (overrides: Partial<{ updateAvailable: boolean; restartRequired: boolean }> = {}) => {
  const calls = { settings: 0, versionModal: 0 };
  const view = render(
    <SidebarFooter
      updateAvailable={overrides.updateAvailable ?? false}
      restartRequired={overrides.restartRequired ?? false}
      releaseInfo={null}
      latestVersion="1.2.3"
      currentVersion="1.2.2"
      onShowVersionModal={() => {
        calls.versionModal += 1;
      }}
      onShowSettings={() => {
        calls.settings += 1;
      }}
      t={t}
    />,
  );
  return { calls, container: view.container };
};

test('the footer offers no Report Issue or Join Community entry on either layout', () => {
  const { container } = renderFooter();

  assert.equal(screen.queryByRole('link', { name: 'Report Issue' }), null);
  assert.equal(screen.queryByRole('link', { name: 'Join Community' }), null);
  assert.equal(screen.queryByRole('button', { name: 'Report Issue' }), null);
  assert.equal(screen.queryByRole('button', { name: 'Join Community' }), null);

  // The only anchor left is the version line's repository link; the removed
  // entries were the only other ones, so any other href is a regression.
  assert.deepEqual(
    [...container.querySelectorAll('a[href]')].map((anchor) => anchor.getAttribute('href')),
    ['https://github.com/siteboon/claudecodeui'],
  );
});

test('settings stays reachable on the desktop and mobile layouts', () => {
  const { calls } = renderFooter();

  // Both layout variants are mounted; the breakpoint classes decide which one
  // is painted, so each Settings button must still open the same dialog.
  const settingsButtons = screen.getAllByRole('button', { name: 'Settings' });
  assert.equal(settingsButtons.length, 2, 'one Settings control per layout');
  for (const button of settingsButtons) {
    fireEvent.click(button);
  }

  assert.deepEqual(calls, { settings: 2, versionModal: 0 });
});

test('an available update and a pending restart stay in the footer', () => {
  const { calls } = renderFooter({ updateAvailable: true, restartRequired: true });

  assert.ok(screen.getByText('Restart required'));
  const updateButtons = screen.getAllByRole('button', { name: /Update available/ });
  assert.equal(updateButtons.length, 2, 'desktop and mobile update banners');
  fireEvent.click(updateButtons[0]);

  assert.deepEqual(calls, { settings: 0, versionModal: 1 });
});
