import { test, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { messages: [], total: 0, hasMore: false } }) }),
    },
  },
}));

/**
 * A broadcast carries every running session's `stream_delta` to this socket, and those frames are
 * bare text with no row identity. The handler used to accumulate all of them in one shared buffer,
 * so a background run's text was flushed into the transcript the user was reading. This asserts
 * per-session isolation in both directions: B never appears in A, and B's own text is kept for B
 * instead of being consumed without being shown.
 */

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const updates: Array<{ sessionId: string; text: string }> = [];
  const finalized: string[] = [];

  // The real store: the assertions must read what the transcript will actually render, not a
  // single spied call. A duplicated background row and a summary row differ in content, which the
  // store's merge cannot collapse, so only the merged result proves the write is single-sourced.
  const { result } = renderHook(() => {
    const store = useSessionStore();
    useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'codex',
    selectedSession: { id: 'session-a', provider: 'codex' } as ProjectSession,
    currentSessionId: 'session-a',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    executionIdsRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: {
      ...store,
      appendRealtime: (sessionId: string, message: NormalizedMessage) => {
        store.appendRealtime(sessionId, message);
      },
      updateStreaming: (sessionId: string, text: string) => {
        updates.push({ sessionId, text });
        store.updateStreaming(sessionId, text, 'codex');
      },
      finalizeStreaming: (sessionId: string) => {
        finalized.push(sessionId);
        store.finalizeStreaming(sessionId);
      },
    },
  });
    return store;
  });

  const dispatch = (event: Partial<ServerEvent> & { sessionId: string; kind: string }) => {
    listener?.({
      id: `event-${Math.random()}`,
      provider: 'codex',
      timestamp: '2026-06-01T00:00:00.000Z',
      ...event,
    } as unknown as ServerEvent);
  };
  return { dispatch, updates, finalized, store: () => result.current };
};

test('a background session’s delta never enters the viewed session’s streamed text', async () => {
  const { dispatch, updates } = renderHandlers();

  dispatch({ sessionId: 'session-a', kind: 'stream_delta', content: 'A说', seq: 1, executionId: 'exec-a' });
  dispatch({ sessionId: 'session-b', kind: 'stream_delta', content: 'B说', seq: 1, executionId: 'exec-b' });
  dispatch({ sessionId: 'session-a', kind: 'stream_delta', content: '完毕', seq: 2, executionId: 'exec-a' });
  dispatch({ sessionId: 'session-b', kind: 'stream_delta', content: '结束', seq: 2, executionId: 'exec-b' });

  await vi.waitFor(() => {
    expect(updates.some((entry) => entry.sessionId === 'session-a')).toBe(true);
    expect(updates.some((entry) => entry.sessionId === 'session-b')).toBe(true);
  });

  const viewed = updates.filter((entry) => entry.sessionId === 'session-a').map((entry) => entry.text);
  const background = updates.filter((entry) => entry.sessionId === 'session-b').map((entry) => entry.text);
  expect(viewed[viewed.length - 1]).toBe('A说完毕');
  // The background text is kept for its own session — not swallowed by the viewed transcript.
  expect(background[background.length - 1]).toBe('B说结束');
  expect(viewed.join('')).not.toContain('B说');
  expect(background.join('')).not.toContain('A说');
});

test('the background session stores its text once, with no per-frame fragments', async () => {
  const { dispatch, store } = renderHandlers();

  dispatch({ sessionId: 'session-a', kind: 'stream_delta', content: 'A行', seq: 1, executionId: 'exec-a' });
  dispatch({ sessionId: 'session-b', kind: 'stream_delta', content: 'B行一', seq: 1, executionId: 'exec-b' });
  dispatch({ sessionId: 'session-b', kind: 'stream_delta', content: 'B行二', seq: 2, executionId: 'exec-b' });
  dispatch({ sessionId: 'session-b', kind: 'text', role: 'assistant', content: 'B最终', id: 'b-final', seq: 3, executionId: 'exec-b' });

  await vi.waitFor(() => {
    const texts = store().getMessages('session-b')
      .filter((message) => message.kind === 'text' || message.kind === 'stream_delta')
      .map((message) => String(message.content));
    // Exactly one accumulated representation of the streamed text, plus the provider's final row.
    expect(texts.filter((text) => text.includes('B行一B行二'))).toHaveLength(1);
    // No fragment rows of the same turn survive beside it.
    expect(texts).not.toContain('B行一');
    expect(texts).not.toContain('B行二');
    // The viewed session is untouched by the background text.
    const viewed = store().getMessages('session-a')
      .map((message) => String(message.content)).join('|');
    expect(viewed).toBe('A行');
  });
});

test('a replayed frame is applied once, so the streamed text is not doubled', async () => {
  const { dispatch, updates, store } = renderHandlers();

  dispatch({ sessionId: 'session-a', kind: 'stream_delta', content: '回答', seq: 1, executionId: 'exec-a' });
  dispatch({ sessionId: 'session-a', kind: 'stream_delta', content: '回答', seq: 1, executionId: 'exec-a' });
  dispatch({ sessionId: 'session-a', kind: 'stream_delta', content: '完成', seq: 2, executionId: 'exec-a' });

  await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));
  expect(updates[updates.length - 1]).toEqual({ sessionId: 'session-a', text: '回答完成' });
  const merged = store().getMessages('session-a')
    .filter((message) => message.kind === 'text' || message.kind === 'stream_delta')
    .map((message) => String(message.content));
  expect(merged).toEqual(['回答完成']);
});
