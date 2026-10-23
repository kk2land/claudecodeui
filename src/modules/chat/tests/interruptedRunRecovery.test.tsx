import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

const sessionMessages = vi.fn();
vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: (...args: unknown[]) => sessionMessages(...args) } } }));

const row = (id: string): NormalizedMessage => ({
  id, kind: 'text', role: 'user', content: id, provider: 'codex',
  sessionId: 'session-1', timestamp: '2026-10-23T05:00:00.000Z',
});

beforeEach(() => {
  sessionMessages.mockResolvedValue({ ok: true, json: async () => ({ data: { messages: [row('history')], total: 1, hasMore: false } }) });
});

test('quota broadcasts during interruption do not poison history or prevent the next turn from becoming idle', async () => {
  let listener: (event: ServerEvent) => void = () => {};
  const idle = vi.fn();
  const busy = vi.fn();
  const { result } = renderHook(() => {
    const store = useSessionStore();
    useChatRealtimeHandlers({
      isActive: true, subscribe: (fn) => { listener = fn; return () => {}; }, provider: 'codex',
      selectedSession: { id: 'session-1' } as ProjectSession, currentSessionId: 'session-1',
      setTokenBudget: () => {}, pendingPermissionRequests: [], setPendingPermissionRequests: () => {},
      streamTimerRef: { current: null }, accumulatedStreamRef: { current: '' },
      lastSeqRef: { current: new Map() }, executionIdsRef: { current: new Map() },
      statusCheckSentAtRef: { current: new Map() }, onSessionProcessing: busy, onSessionIdle: idle,
      onSessionBackground: () => idle(), requestLatestMessages: async () => {}, sessionStore: store,
    });
    return store;
  });
  await act(async () => { await result.current.fetchFromServer('session-1'); });
  const append = vi.spyOn(result.current, 'appendRealtime');

  act(() => {
    listener({ kind: 'status', sessionId: 'session-1', text: 'Working' });
    // This account-level event has neither an id nor a sessionId. It arrives
    // while the turn is running and again as Codex confirms interruption.
    listener({ kind: 'codex_rate_limits_updated', updatedAt: Date.now() });
    listener({ kind: 'future_global_broadcast', id: 'global-not-a-transcript-row' });
    listener({ kind: 'complete', sessionId: 'session-1', aborted: true });
  });
  expect(append).not.toHaveBeenCalled();
  expect(busy).toHaveBeenCalledTimes(1);
  expect(idle).toHaveBeenCalledTimes(1);
  expect(result.current.getMessages('session-1').map((message) => message.id)).toEqual(['history']);

  act(() => {
    result.current.appendRealtime('session-1', row('second-prompt'));
    listener({ kind: 'status', sessionId: 'session-1', text: 'Working' });
    listener({ kind: 'codex_rate_limits_updated', updatedAt: Date.now() });
    listener({ kind: 'complete', sessionId: 'session-1', success: false });
  });
  expect(idle).toHaveBeenCalledTimes(2);
  expect(result.current.getMessages('session-1').map((message) => message.id)).toEqual(['history', 'second-prompt']);
});

test('the store rejects rows with missing, non-string or empty IDs without affecting later valid rows', async () => {
  const { result } = renderHook(() => useSessionStore());
  await act(async () => { await result.current.fetchFromServer('session-1'); });
  act(() => {
    for (const id of [undefined, null, 42, '', '  ']) {
      result.current.appendRealtime('session-1', { ...row('invalid'), id } as unknown as NormalizedMessage);
    }
    result.current.appendRealtime('session-1', row('next-prompt'));
  });
  expect(result.current.getMessages('session-1').map((message) => message.id)).toEqual(['history', 'next-prompt']);
});
