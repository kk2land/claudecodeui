import { expect, test, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import { SessionOutput } from '@/modules/chat/SessionOutput';
import type * as SharedApi from '@/shared/api';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';

/**
 * The detail panel shows the session's newest page; older turns stay behind an explicit control.
 * This mounts the real component against a paged history endpoint, so it fails if the viewer ever
 * presents the first page as the whole transcript.
 */

const historyCalls: Array<{ offset?: number; limit?: number }> = [];

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    ws: null,
    isConnected: true,
    connectionStatus: 'connected',
    sendMessage: () => {},
    subscribe: () => () => {},
  }),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    api: {
      ...actual.api,
      providers: {
        ...actual.api.providers,
        sessionMessages: async (_sessionId: string, options: { offset?: number; limit?: number } = {}) => {
        historyCalls.push(options);
        const older = (options.offset ?? 0) > 0;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: older
              ? {
                messages: [{
                  id: 'old-1',
                  sessionId: 'session-a',
                  provider: 'codex',
                  timestamp: '2026-05-01T00:00:00.000Z',
                  kind: 'text',
                  role: 'assistant',
                  content: '更早的一条输出',
                }],
                total: 2,
                hasMore: false,
              }
              : {
                messages: [{
                  id: 'new-1',
                  sessionId: 'session-a',
                  provider: 'codex',
                  timestamp: '2026-06-01T00:00:00.000Z',
                  kind: 'text',
                  role: 'assistant',
                  content: '最新的一条输出',
                }],
                total: 2,
                hasMore: true,
              },
          }),
        };
        },
      },
    },
  };
});

test('older history stays behind a load control instead of being silently omitted', async () => {
  historyCalls.length = 0;
  const { getByText, findByText, queryByText } = render(
    <UiPreferencesProvider>
      <SessionOutput sessionId="session-a" />
    </UiPreferencesProvider>,
  );

  await findByText('最新的一条输出');
  expect(historyCalls).toHaveLength(1);
  expect(historyCalls[0]?.offset ?? 0).toBe(0);

  const loadOlder = getByText('加载更早消息');
  await act(async () => {
    fireEvent.click(loadOlder);
  });

  await waitFor(() => expect(historyCalls.length).toBeGreaterThan(1));
  expect(historyCalls[1]?.offset).toBe(1);
  expect(await findByText('更早的一条输出')).toBeTruthy();
  // Both pages are present and the control retires once the history is complete.
  expect(getByText('最新的一条输出')).toBeTruthy();
  await waitFor(() => expect(queryByText('加载更早消息')).toBeNull());
});
