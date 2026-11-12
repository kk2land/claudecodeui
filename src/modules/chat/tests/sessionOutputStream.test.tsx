import { describe, expect, test, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useSessionOutputStream } from '@/modules/chat/hooks/useSessionOutputStream';
import type { ServerEvent } from '@/shared/types';

/**
 * Integration coverage for the resident task detail's read-only viewer. The real hook, the real
 * session store and the real websocket subscription are used; only the shared socket and the
 * history endpoint are replaced, because both are process-wide side channels.
 *
 * The behaviours here are the ones a user actually hit: a replay overlapping the live broadcast
 * duplicated stream text, and a second session's frames leaking in through bare `stream_delta`
 * text.
 */

type Listener = (event: ServerEvent) => void;
const listeners = new Set<Listener>();
const sent: Array<Record<string, unknown>> = [];
const historyCalls: Array<{ sessionId: string; offset?: number }> = [];
let historyPage: { messages: unknown[]; total: number; hasMore: boolean } = {
  messages: [],
  total: 0,
  hasMore: false,
};

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    ws: null,
    isConnected: true,
    connectionStatus: 'connected',
    sendMessage: (message: Record<string, unknown>) => { sent.push(message); },
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  }),
}));

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: async (sessionId: string, options: { offset?: number } = {}) => {
        historyCalls.push({ sessionId, offset: options.offset });
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: historyPage }),
        };
      },
    },
  },
}));

function emit(event: Partial<ServerEvent> & { sessionId: string; kind: string }) {
  const frame = {
    id: `event-${Math.random()}`,
    provider: 'codex',
    timestamp: '2026-06-01T00:00:00.000Z',
    ...event,
  } as unknown as ServerEvent;
  act(() => {
    for (const listener of listeners) listener(frame);
  });
}

/** One viewer with the store it owns, exposed through rendered text for assertions. */
function Viewer({ sessionId }: { sessionId: string }) {
  const store = useSessionStore();
  const { pendingPermissions, replayComplete } = useSessionOutputStream({ sessionId, store, provider: 'codex' });
  const messages = store.getMessages(sessionId);
  return (
    <div>
      <span data-testid={`text-${sessionId}`}>
        {messages.filter((message) => message.kind === 'text' || message.kind === 'stream_delta')
          .map((message) => String(message.content))
          .join('|')}
      </span>
      <span data-testid={`perms-${sessionId}`}>{pendingPermissions.length}</span>
      <span data-testid={`gap-${sessionId}`}>{replayComplete ? 'ok' : 'gap'}</span>
    </div>
  );
}

const lastSubscribe = () => sent.filter((message) => message.type === 'chat.subscribe').pop();

describe('useSessionOutputStream', () => {
  test('a mid-turn open replays from 0 and then appends live text exactly once', async () => {
    listeners.clear();
    sent.length = 0;
    historyPage = { messages: [], total: 0, hasMore: false };
    const { getByTestId } = render(<Viewer sessionId="session-a" />);

    // First viewer: it must replay the whole run, never the server's watermark as "consumed".
    await waitFor(() => expect(lastSubscribe()).toBeTruthy());
    expect(lastSubscribe()).toMatchObject({ sessions: [{ sessionId: 'session-a', lastSeq: 0 }] });
    // Mounting subscribes exactly once: the initial subscribe and the reconnect effect must not
    // both fire, or every viewer would ask the server to replay the run twice.
    expect(sent.filter((message) => message.type === 'chat.subscribe')).toHaveLength(1);

    emit({ sessionId: 'session-a', kind: 'stream_delta', content: 'Hello ', seq: 1, executionId: 'exec-1' });
    emit({ sessionId: 'session-a', kind: 'stream_delta', content: 'world', seq: 2, executionId: 'exec-1' });
    // The same frames again, as the subscribe replay delivers them on top of the live broadcast.
    emit({ sessionId: 'session-a', kind: 'stream_delta', content: 'Hello ', seq: 1, executionId: 'exec-1' });
    emit({ sessionId: 'session-a', kind: 'stream_delta', content: 'world', seq: 2, executionId: 'exec-1' });

    await waitFor(() => expect(getByTestId('text-session-a').textContent).toBe('Hello world'));
  });

  test('another session’s delta never reaches this viewer’s transcript', async () => {
    listeners.clear();
    historyPage = { messages: [], total: 0, hasMore: false };
    const { getByTestId } = render(<Viewer sessionId="session-a" />);

    emit({ sessionId: 'session-a', kind: 'stream_delta', content: 'A-only', seq: 1, executionId: 'exec-1' });
    emit({ sessionId: 'session-b', kind: 'stream_delta', content: 'B-text', seq: 1, executionId: 'exec-9' });
    emit({ sessionId: 'session-b', kind: 'text', role: 'assistant', content: 'B-final', id: 'b-1', seq: 2, executionId: 'exec-9' });

    await waitFor(() => expect(getByTestId('text-session-a').textContent).toBe('A-only'));
  });

  test('two viewers of one run keep independent text and watermarks', async () => {
    listeners.clear();
    historyPage = { messages: [], total: 0, hasMore: false };
    const { getByTestId } = render(
      <>
        <Viewer sessionId="session-a" />
        <Viewer sessionId="session-b" />
      </>,
    );

    emit({ sessionId: 'session-a', kind: 'stream_delta', content: 'alpha', seq: 1, executionId: 'exec-a' });
    emit({ sessionId: 'session-b', kind: 'stream_delta', content: 'beta', seq: 1, executionId: 'exec-b' });

    await waitFor(() => expect(getByTestId('text-session-a').textContent).toBe('alpha'));
    expect(getByTestId('text-session-b').textContent).toBe('beta');
  });

  test('complete finalizes the stream once and re-reads the persisted tail', async () => {
    listeners.clear();
    historyCalls.length = 0;
    historyPage = { messages: [], total: 0, hasMore: false };
    const { getByTestId } = render(<Viewer sessionId="session-a" />);

    emit({ sessionId: 'session-a', kind: 'stream_delta', content: 'partial', seq: 1, executionId: 'exec-1' });
    await waitFor(() => expect(getByTestId('text-session-a').textContent).toBe('partial'));

    // The persisted row replaces the provisional one; the viewer must not show both.
    historyPage = {
      messages: [{
        id: 'assistant-1',
        sessionId: 'session-a',
        provider: 'codex',
        timestamp: '2026-06-01T00:00:01.000Z',
        kind: 'text',
        role: 'assistant',
        content: 'partial',
      }],
      total: 1,
      hasMore: false,
    };
    const before = historyCalls.length;
    emit({ sessionId: 'session-a', kind: 'complete', success: true, seq: 2, executionId: 'exec-1' });

    await waitFor(() => expect(historyCalls.length).toBeGreaterThan(before));
    await waitFor(() => expect(getByTestId('text-session-a').textContent).toBe('partial'));
  });

  test('a permission card appears for this session and disappears when it is resolved elsewhere', async () => {
    listeners.clear();
    historyPage = { messages: [], total: 0, hasMore: false };
    const { getByTestId } = render(<Viewer sessionId="session-a" />);

    emit({
      sessionId: 'session-a',
      kind: 'permission_request',
      requestId: 'req-1',
      toolName: 'Bash',
      seq: 1,
      executionId: 'exec-1',
    });
    await waitFor(() => expect(getByTestId('perms-session-a').textContent).toBe('1'));
    // A prompt for another session is not this viewer's card.
    emit({
      sessionId: 'session-b',
      kind: 'permission_request',
      requestId: 'req-2',
      toolName: 'Bash',
      seq: 1,
      executionId: 'exec-2',
    });
    expect(getByTestId('perms-session-a').textContent).toBe('1');

    emit({ sessionId: 'session-a', kind: 'permission_resolved', requestId: 'req-1', seq: 2, executionId: 'exec-1' });
    await waitFor(() => expect(getByTestId('perms-session-a').textContent).toBe('0'));

    emit({ sessionId: 'session-a', kind: 'permission_request', requestId: 'req-3', toolName: 'Bash', seq: 3, executionId: 'exec-1' });
    await waitFor(() => expect(getByTestId('perms-session-a').textContent).toBe('1'));
    // A terminal frame clears anything still waiting.
    emit({ sessionId: 'session-a', kind: 'complete', success: false, seq: 4, executionId: 'exec-1' });
    await waitFor(() => expect(getByTestId('perms-session-a').textContent).toBe('0'));
  });

  test('history and live text merge without dropping either side', async () => {
    listeners.clear();
    historyPage = {
      messages: [
        { id: 'u1', sessionId: 'session-a', provider: 'codex', timestamp: '2026-06-01T00:00:00.000Z', kind: 'text', role: 'user', content: '请报告状态' },
        { id: 'a1', sessionId: 'session-a', provider: 'codex', timestamp: '2026-06-01T00:00:01.000Z', kind: 'text', role: 'assistant', content: '上一条回复' },
      ],
      total: 2,
      hasMore: false,
    };
    const { getByTestId } = render(<Viewer sessionId="session-a" />);

    await waitFor(() => expect(getByTestId('text-session-a').textContent).toContain('上一条回复'));
    emit({ sessionId: 'session-a', kind: 'stream_delta', content: '新的输出', seq: 1, executionId: 'exec-2' });

    await waitFor(() => expect(getByTestId('text-session-a').textContent).toContain('新的输出'));
    expect(getByTestId('text-session-a').textContent).toContain('请报告状态');
  });

  test('unmounting removes the viewer’s listener and leaves no shared state behind', async () => {
    listeners.clear();
    historyPage = { messages: [], total: 0, hasMore: false };
    const { unmount, getByTestId } = render(<Viewer sessionId="session-a" />);
    expect(listeners.size).toBe(1);

    emit({ sessionId: 'session-a', kind: 'stream_delta', content: 'before', seq: 1, executionId: 'exec-1' });
    await waitFor(() => expect(getByTestId('text-session-a').textContent).toBe('before'));

    unmount();
    expect(listeners.size).toBe(0);
    // Frames arriving after disposal must be harmless — no listener, no setState on a dead view.
    expect(() => emit({ sessionId: 'session-a', kind: 'stream_delta', content: 'after', seq: 2, executionId: 'exec-1' })).not.toThrow();
  });
});
