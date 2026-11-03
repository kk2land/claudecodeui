import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

/**
 * `channels.android` is device-derived: the native endpoint registration writes
 * it and the web must not drop it when normalising the rest of the preference
 * object. A browser never shows Android controls, but a returning Android user
 * must still load the value the server already stored.
 */

const apiState = vi.hoisted(() => ({
  preferences: {} as Record<string, unknown>,
}));

vi.mock('@/shared/api', () => {
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  return {
    api: {
      settings: {
        notificationPreferences: () => json({ success: true, preferences: apiState.preferences }),
        saveNotificationPreferences: () => json({ success: true }),
      },
      user: {
        preferences: () => json({ preferences: {} }),
        savePreferences: () => json({ success: true }),
        drafts: () => json({ drafts: [] }),
        saveDraft: () => json({ success: true }),
        deleteDraft: () => json({ success: true }),
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
  localStorage.clear();
  apiState.preferences = {};
});

const renderSettings = async () => {
  const { useSettingsController } = await import('@/modules/settings/hooks/useSettingsController');
  return renderHook(() => useSettingsController({ isOpen: true, initialTab: 'notifications' }));
};

test('a stored android channel survives settings normalisation', async () => {
  apiState.preferences = {
    channels: { inApp: true, webPush: false, desktop: false, android: true, sound: true },
    events: { actionRequired: true, stop: true, error: true },
  };

  const { result } = await renderSettings();
  await waitFor(() => assert.equal(result.current.notificationPreferences.channels.android, true));
});

test('a server without the android key normalises to false', async () => {
  apiState.preferences = {
    channels: { inApp: true, webPush: false, desktop: false, sound: true },
    events: { actionRequired: true, stop: false, error: true },
  };

  const { result } = await renderSettings();
  await waitFor(() => assert.equal(result.current.notificationPreferences.channels.android, false));
});
