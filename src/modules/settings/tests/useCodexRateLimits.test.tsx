import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCodexRateLimits } from '@/modules/settings/hooks/useCodexRateLimits';
import type * as SharedApi from '@/shared/api';
import type { CodexRateLimitsState } from '@/shared/types';

/**
 * The quota card must be cache-only on mount, refresh explicitly, and follow
 * `codex_rate_limits_updated` frames. These tests pin those behaviours plus the
 * races the review found: a late GET or POST must never revive a snapshot that a
 * newer frame (including an account clear) already replaced, and a cache re-read
 * must never leave the refresh button spinning.
 *
 * The websocket context is mocked with its real shape (`subscribe`, `isConnected`);
 * reconnection is simulated by changing that connection status, never by
 * inventing a synthetic event the context does not emit.
 */

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  codexRateLimits: vi.fn(),
  refreshCodexRateLimits: vi.fn(),
  // Mirrors the real context's `isConnected`; the tests drive it as a prop.
  isConnected: true,
}));
const { subscribe, codexRateLimits, refreshCodexRateLimits } = mocks;

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: mocks.subscribe, isConnected: mocks.isConnected }),
}));

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedApi>()),
  api: { providers: { codexRateLimits: mocks.codexRateLimits, refreshCodexRateLimits: mocks.refreshCodexRateLimits } },
}));

const snapshot = {
  weekly: { remainingPercent: 75, resetsAt: 1_800_000_000 },
  fiveHour: null,
  updatedAt: 1_700_000_000_000,
  stale: false,
};

const respond = (data: CodexRateLimitsState | unknown) => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => ({ success: true, data }),
}) as Promise<Response>;

let listeners: Array<(event: Record<string, unknown>) => void>;

const emit = (event: Record<string, unknown>) => {
  act(() => { for (const listener of listeners) listener(event); });
};

beforeEach(() => {
  listeners = [];
  mocks.isConnected = true;
  subscribe.mockReset();
  subscribe.mockImplementation((listener: (event: Record<string, unknown>) => void) => {
    listeners.push(listener);
    return () => { listeners = listeners.filter((entry) => entry !== listener); };
  });
  codexRateLimits.mockReset();
  refreshCodexRateLimits.mockReset();
});

/**
 * Renders the hook through a wrapper that reads the mocked context's connection
 * status, so a rerender with a new `isConnected` prop is a real status change.
 */
function renderQuotaHook(enabled = true) {
  return renderHook(
    ({ isConnected }: { isConnected: boolean }) => {
      mocks.isConnected = isConnected;
      return useCodexRateLimits(enabled);
    },
    { initialProps: { isConnected: true } },
  );
}

describe('useCodexRateLimits', () => {
  it('does not request anything while the deployment disables quotas', () => {
    const { result } = renderQuotaHook(false);
    expect(codexRateLimits).not.toHaveBeenCalled();
    expect(refreshCodexRateLimits).not.toHaveBeenCalled();
    expect(result.current.enabled).toBe(false);
    expect(result.current.snapshot).toBeNull();
  });

  it('mounts cache-only and never refreshes on its own', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot }));
    const { result } = renderQuotaHook();

    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));
    expect(codexRateLimits).toHaveBeenCalledTimes(1);
    expect(refreshCodexRateLimits).not.toHaveBeenCalled();
  });

  it('refresh calls the manual endpoint and applies its snapshot', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot: null }));
    const refreshed = { ...snapshot, weekly: { remainingPercent: 50, resetsAt: 1_800_100_000 } };
    refreshCodexRateLimits.mockImplementation(() => respond(refreshed));

    const { result } = renderQuotaHook();
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => { await result.current.refresh(); });
    expect(refreshCodexRateLimits).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toEqual(refreshed);
    expect(result.current.refreshing).toBe(false);
  });

  it('a failed refresh keeps the cached values and reports the error', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot }));
    refreshCodexRateLimits.mockImplementation(() => Promise.resolve({
      ok: false,
      status: 502,
      json: async () => ({ success: false, error: { code: 'CODEX_RATE_LIMITS_REFRESH_FAILED', message: 'Codex is offline' } }),
    }) as Promise<Response>);

    const { result } = renderQuotaHook();
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));

    await act(async () => { await result.current.refresh(); });
    expect(result.current.snapshot).toMatchObject({ ...snapshot, stale: true });
    expect(result.current.error).toContain('Codex is offline');
    expect(result.current.refreshing).toBe(false);
  });

  it('applies a websocket frame without another request', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot: null }));
    const { result } = renderQuotaHook();
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const updated = { ...snapshot, stale: true };
    emit({ kind: 'codex_rate_limits_updated', enabled: true, snapshot: updated });

    expect(result.current.snapshot).toEqual(updated);
    expect(codexRateLimits).toHaveBeenCalledTimes(1);
    expect(refreshCodexRateLimits).not.toHaveBeenCalled();
  });

  it('an account-change frame clears the snapshot', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot }));
    const { result } = renderQuotaHook();
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));

    emit({ kind: 'codex_rate_limits_updated', enabled: true, snapshot: null });
    expect(result.current.snapshot).toBeNull();
  });

  it('re-reads the cache when the real connection status recovers, never refreshing', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot }));
    const { result, rerender } = renderQuotaHook();
    await waitFor(() => expect(codexRateLimits).toHaveBeenCalledTimes(1));

    // The socket drops, then reconnects: that real status transition is the signal.
    rerender({ isConnected: false });
    rerender({ isConnected: true });

    await waitFor(() => expect(codexRateLimits).toHaveBeenCalledTimes(2));
    expect(refreshCodexRateLimits).not.toHaveBeenCalled();
    expect(result.current.snapshot).toEqual(snapshot);
  });

  it('does not re-read the cache for an unrelated rerender while still connected', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot }));
    const { result, rerender } = renderQuotaHook();
    await waitFor(() => expect(codexRateLimits).toHaveBeenCalledTimes(1));

    rerender({ isConnected: true });
    rerender({ isConnected: true });
    expect(codexRateLimits).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toEqual(snapshot);
  });

  it('a late GET cannot revive a snapshot after an account-change clear', async () => {
    let resolveCache: ((response: Response) => void) | null = null;
    codexRateLimits.mockImplementation(() => new Promise<Response>((resolve) => { resolveCache = resolve; }));

    const { result } = renderQuotaHook();
    // The account changes while the initial cache read is still in flight.
    emit({ kind: 'codex_rate_limits_updated', enabled: true, snapshot: null });

    await act(async () => {
      resolveCache?.({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { enabled: true, snapshot } }),
      } as Response);
      await Promise.resolve();
    });

    // The previous account's quota must not come back.
    expect(result.current.snapshot).toBeNull();
  });

  it('a late GET cannot overwrite a newer fresh frame', async () => {
    let resolveCache: ((response: Response) => void) | null = null;
    codexRateLimits.mockImplementation(() => new Promise<Response>((resolve) => { resolveCache = resolve; }));
    const newer = { ...snapshot, updatedAt: 1_700_000_500_000 };

    const { result } = renderQuotaHook();
    emit({ kind: 'codex_rate_limits_updated', enabled: true, snapshot: newer });

    await act(async () => {
      resolveCache?.({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { enabled: true, snapshot } }),
      } as Response);
      await Promise.resolve();
    });

    expect(result.current.snapshot).toEqual(newer);
  });

  it('a refresh whose result a newer frame superseded is discarded', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot }));
    let resolveRefresh: ((response: Response) => void) | null = null;
    refreshCodexRateLimits.mockImplementation(() => new Promise<Response>((resolve) => { resolveRefresh = resolve; }));

    const { result } = renderQuotaHook();
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));

    let pending: Promise<void> | undefined;
    act(() => { pending = result.current.refresh(); });
    // The account changes before the POST answers.
    emit({ kind: 'codex_rate_limits_updated', enabled: true, snapshot: null });

    await act(async () => {
      resolveRefresh?.({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: snapshot }),
      } as Response);
      await pending;
    });

    // The POST result belongs to the old account and must not restore it.
    expect(result.current.snapshot).toBeNull();
    expect(result.current.refreshing).toBe(false);
  });

  it('a late refresh failure does not mark a newer quota notification stale', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot }));
    let rejectRefresh: ((reason: Error) => void) | undefined;
    refreshCodexRateLimits.mockImplementation(() => new Promise<Response>((_resolve, reject) => {
      rejectRefresh = reject;
    }));
    const { result } = renderQuotaHook();
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));
    let pending: Promise<void> | undefined;
    act(() => { pending = result.current.refresh(); });
    const newer = { ...snapshot, weekly: { remainingPercent: 60, resetsAt: 1_800_000_000 }, updatedAt: snapshot.updatedAt + 1 };
    emit({ kind: 'codex_rate_limits_updated', enabled: true, snapshot: newer });
    await act(async () => {
      rejectRefresh?.(new Error('old request failed'));
      await pending;
    });
    expect(result.current.snapshot).toEqual(newer);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.error).toContain('old request failed');
  });

  it('applies a null refresh result as a real clear', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot }));
    refreshCodexRateLimits.mockImplementation(() => respond(null));

    const { result } = renderQuotaHook();
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));

    await act(async () => { await result.current.refresh(); });
    expect(result.current.snapshot).toBeNull();
  });

  it('a cache re-read during a refresh does not strand the loading state', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot }));
    let resolveRefresh: ((response: Response) => void) | null = null;
    refreshCodexRateLimits.mockImplementation(() => new Promise<Response>((resolve) => { resolveRefresh = resolve; }));

    const { result, rerender } = renderQuotaHook();
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));

    let pending: Promise<void> | undefined;
    act(() => { pending = result.current.refresh(); });
    expect(result.current.refreshing).toBe(true);

    // A reconnect re-reads the cache while the POST is still outstanding.
    rerender({ isConnected: false });
    rerender({ isConnected: true });
    await waitFor(() => expect(codexRateLimits).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveRefresh?.({
        ok: false,
        status: 502,
        json: async () => ({ success: false, error: { message: 'still offline' } }),
      } as Response);
      await pending;
    });

    expect(result.current.refreshing).toBe(false);
  });

  it('two refreshes at the same synchronous point share one request', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot }));
    let resolveRefresh: ((response: Response) => void) | null = null;
    refreshCodexRateLimits.mockImplementation(() => new Promise<Response>((resolve) => { resolveRefresh = resolve; }));

    const { result } = renderQuotaHook();
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));

    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = result.current.refresh();
      second = result.current.refresh();
    });
    expect(refreshCodexRateLimits).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh?.({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: snapshot }),
      } as Response);
      await Promise.all([first ?? Promise.resolve(), second ?? Promise.resolve()]);
    });
    expect(result.current.refreshing).toBe(false);
  });

  it('a request from a disabled lifecycle cannot write into the re-enabled one', async () => {
    let resolveCache: ((response: Response) => void) | null = null;
    codexRateLimits.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveCache = resolve; }));
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot: { ...snapshot, updatedAt: 1_700_000_900_000 } }));

    const rendered = renderHook(
      ({ enabled: on }: { enabled: boolean }) => useCodexRateLimits(on),
      { initialProps: { enabled: true } },
    );
    // The deployment is disabled, then enabled again, before the first GET answers.
    rendered.rerender({ enabled: false });
    rendered.rerender({ enabled: true });
    await waitFor(() => expect(codexRateLimits).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveCache?.({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { enabled: true, snapshot } }),
      } as Response);
      await Promise.resolve();
    });

    // The stale first-lifecycle answer must not overwrite the new lifecycle's data.
    expect(rendered.result.current.snapshot?.updatedAt).toBe(1_700_000_900_000);
  });

  it('clears the loading state when the deployment disables mid-refresh', async () => {
    codexRateLimits.mockImplementation(() => respond({ enabled: true, snapshot }));
    refreshCodexRateLimits.mockImplementation(() => new Promise<Response>(() => {}));

    const rendered = renderHook(
      ({ enabled: on }: { enabled: boolean }) => useCodexRateLimits(on),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(rendered.result.current.snapshot).toEqual(snapshot));

    act(() => { void rendered.result.current.refresh(); });
    expect(rendered.result.current.refreshing).toBe(true);

    rendered.rerender({ enabled: false });
    await waitFor(() => expect(rendered.result.current.refreshing).toBe(false));
  });

  it('marks retained values stale once the page outlives the reported reset', async () => {
    vi.useFakeTimers();
    try {
      const resetAt = Math.floor(Date.now() / 1000) + 10;
      codexRateLimits.mockImplementation(() => respond({
        enabled: true,
        snapshot: { ...snapshot, weekly: { remainingPercent: 75, resetsAt: resetAt } },
      }));

      const { result } = renderQuotaHook();
      // Let the cache read settle under the fake clock.
      await act(async () => { await Promise.resolve(); });
      expect(result.current.snapshot?.stale).toBe(false);

      act(() => { vi.advanceTimersByTime(11_000); });

      expect(result.current.snapshot?.stale).toBe(true);
      // The original remaining percentage is retained, never recomputed.
      expect(result.current.snapshot?.weekly?.remainingPercent).toBe(75);
      // The deadline adds no poll and no RPC.
      expect(codexRateLimits).toHaveBeenCalledTimes(1);
      expect(refreshCodexRateLimits).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
