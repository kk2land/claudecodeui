import assert from 'node:assert/strict';

import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { SETTINGS_MAIN_TABS } from '@/shared/constants';
import SettingsSidebar from '@/modules/settings/SettingsSidebar';

/**
 * TaskMaster and Browser Use are retired for every instance role. Their
 * settings pages must not be reachable from navigation, and a remembered or
 * deep-linked `tasks`/`browser` initial tab must land on Agents instead of
 * mounting a closed feature's panel.
 */

vi.mock('@/shared/api', () => {
  const ok = async () => new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  return {
    api: {
      settings: {
        notificationPreferences: () => Promise.resolve({ ok: false }),
        saveNotificationPreferences: () => Promise.resolve({ ok: true, json: async () => ({}) }),
      },
      user: {
        preferences: async () => new Response(JSON.stringify({ preferences: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
        savePreferences: ok,
        drafts: ok,
        saveDraft: ok,
        deleteDraft: ok,
      },
    },
  };
});

vi.mock('@/shared/context/ThemeContext', () => {
  const theme = { isDarkMode: false, toggleDarkMode: () => undefined };
  return { useTheme: () => theme };
});

vi.mock('@/modules/provider-auth', () => {
  const authStatus = {
    providerAuthStatus: {},
    checkProviderAuthStatus: () => Promise.resolve({ authenticated: false }),
    refreshProviderAuthStatuses: () => Promise.resolve(),
  };
  return { useProviderAuthStatus: () => authStatus };
});

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('the settings tab registry omits the retired TaskMaster and Browser pages', () => {
  const ids = SETTINGS_MAIN_TABS.map((tab) => tab.id);

  assert.equal(ids.includes('tasks'), false);
  assert.equal(ids.includes('browser'), false);
});

test('the settings sidebar renders no TaskMaster or Browser navigation items', () => {
  render(<SettingsSidebar activeTab="agents" onChange={() => undefined} />);

  assert.equal(screen.queryByRole('button', { name: 'Tasks' }), null);
  assert.equal(screen.queryByRole('button', { name: 'Browser' }), null);
});

test.each(['tasks', 'browser'])(
  'an initial %s tab falls back to Agents instead of mounting the retired panel',
  async (initialTab) => {
    const { useSettingsController } = await import(
      '@/modules/settings/hooks/useSettingsController'
    );
    const { result } = renderHook(() => useSettingsController({ isOpen: true, initialTab }));

    await waitFor(() => {
      assert.ok(result.current.activeTab);
    });

    assert.equal(result.current.activeTab, 'agents');
  },
);
