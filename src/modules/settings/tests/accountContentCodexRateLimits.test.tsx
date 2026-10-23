import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import AccountContent from '@/modules/settings/tabs/agents-settings/sections/content/AccountContent';
import type * as SharedApi from '@/shared/api';
import type { ProviderAuthStatus } from '@/shared/types';

/**
 * The Codex account panel shows the quota card only when the deployment
 * enables it, with the weekly window always present, the 5-hour window only
 * when Codex reports it, and a stale marker when the values may be old.
 */

const state = {
  snapshot: {
    weekly: { remainingPercent: 75, resetsAt: 1_800_000_000 },
    fiveHour: { remainingPercent: 60, resetsAt: 1_700_000_600 },
    updatedAt: 1_700_000_000_000,
    stale: false,
  },
};

const mocks = vi.hoisted(() => ({
  codexRateLimits: vi.fn(),
  refreshCodexRateLimits: vi.fn(),
  subscribe: vi.fn(),
}));
const { codexRateLimits, refreshCodexRateLimits, subscribe } = mocks;

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: mocks.subscribe }),
}));

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedApi>()),
  api: { providers: { codexRateLimits: mocks.codexRateLimits, refreshCodexRateLimits: mocks.refreshCodexRateLimits } },
}));

const authStatus: ProviderAuthStatus = {
  authenticated: true,
  email: 'someone@example.com',
  method: 'credentials_file',
  error: null,
  loading: false,
};

const respond = (data: unknown) => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => ({ success: true, data }),
}) as Promise<Response>;

const renderCodexAccount = (rateLimitsEnabled: boolean) => render(
  <AccountContent
    agent="codex"
    authStatus={authStatus}
    onLogin={() => {}}
    rateLimitsEnabled={rateLimitsEnabled}
  />,
);

beforeEach(() => {
  codexRateLimits.mockReset();
  codexRateLimits.mockImplementation(() => respond({ enabled: true, ...state }));
  refreshCodexRateLimits.mockReset();
  subscribe.mockReset();
  subscribe.mockImplementation(() => () => {});
});

describe('AccountContent Codex quota card', () => {
  it('hides the card and skips the cache request when the deployment is off', () => {
    renderCodexAccount(false);
    expect(screen.queryByTestId('codex-rate-limits')).toBeNull();
    expect(screen.queryByText('Account quota')).toBeNull();
    expect(codexRateLimits).not.toHaveBeenCalled();
  });

  it('shows both windows with the remaining percentages when enabled', async () => {
    renderCodexAccount(true);
    const card = await screen.findByTestId('codex-rate-limits');
    expect(card.textContent).toContain('Weekly limit');
    expect(card.textContent).toContain('75% left');
    expect(card.textContent).toContain('5-hour limit');
    expect(card.textContent).toContain('60% left');
    // Cache-only mount.
    expect(refreshCodexRateLimits).not.toHaveBeenCalled();
  });

  it('shows the weekly window as unavailable and hides a missing 5-hour window', async () => {
    codexRateLimits.mockImplementation(() => respond({
      enabled: true,
      snapshot: { ...state.snapshot, weekly: null, fiveHour: null },
    }));
    renderCodexAccount(true);
    const card = await screen.findByTestId('codex-rate-limits');
    expect(card.textContent).toContain('The weekly limit is not reported for this account.');
    expect(card.textContent).not.toContain('5-hour limit');
  });

  it('marks an expired window stale and keeps its reported value', async () => {
    codexRateLimits.mockImplementation(() => respond({
      enabled: true,
      // The weekly reset is in the past, so the server flags this stale.
      snapshot: {
        ...state.snapshot,
        weekly: { remainingPercent: 12.5, resetsAt: 1_700_000_000 },
        stale: true,
      },
    }));
    renderCodexAccount(true);
    const card = await screen.findByTestId('codex-rate-limits');
    // The reported remaining quota is shown, never recalculated to a full window.
    expect(card.textContent).toContain('12.5% left');
    expect(card.textContent).toContain('These values may be out of date. Refresh to update them.');
  });

  it('marks stale values and offers a refresh', async () => {
    codexRateLimits.mockImplementation(() => respond({
      enabled: true,
      snapshot: { ...state.snapshot, stale: true },
    }));
    renderCodexAccount(true);
    const card = await screen.findByTestId('codex-rate-limits');
    expect(card.textContent).toContain('These values may be out of date. Refresh to update them.');
    expect(screen.getByRole('button', { name: /refresh/i })).toBeTruthy();
  });

  it('keeps the old values and shows an explicit error when a refresh fails', async () => {
    refreshCodexRateLimits.mockImplementation(() => Promise.resolve({
      ok: false,
      status: 502,
      json: async () => ({ success: false, error: { code: 'CODEX_RATE_LIMITS_REFRESH_FAILED', message: 'Codex is offline' } }),
    }) as Promise<Response>);
    renderCodexAccount(true);
    const button = await screen.findByRole('button', { name: /refresh/i });

    await act(async () => { button.click(); });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Refresh failed');
    expect(alert.textContent).toContain('Codex is offline');
    // The previously loaded window is still shown rather than cleared, and the
    // card says the retained values may be out of date.
    expect(screen.getByTestId('codex-rate-limits').textContent).toContain('75% left');
    expect(screen.getByTestId('codex-rate-limits').textContent)
      .toContain('These values may be out of date. Refresh to update them.');
  });

  it('shows nothing for a provider other than Codex even when enabled', () => {
    render(
      <AccountContent
        agent="claude"
        authStatus={authStatus}
        onLogin={() => {}}
        rateLimitsEnabled
      />,
    );
    expect(screen.queryByTestId('codex-rate-limits')).toBeNull();
    expect(codexRateLimits).not.toHaveBeenCalled();
  });
});
