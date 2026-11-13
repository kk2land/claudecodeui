import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import { SessionOutput } from '@/modules/chat/SessionOutput';
import type * as SharedApi from '@/shared/api';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ServerEvent } from '@/shared/types';

/**
 * The resident task detail is a live transcript, so where it is scrolled is part of what it shows:
 * opening it mid-run must land on the newest output, a growing reply must stay in view, and a
 * reader who scrolled up to read history must not be dragged back down. The real component, the
 * real session store and the real socket subscription are used; only the socket, the history
 * endpoint and the (absent) layout are replaced, because those are process-wide or jsdom has none.
 */

type Listener = (event: ServerEvent) => void;
const listeners = new Set<Listener>();

type HistoryPage = { messages: unknown[]; total: number; hasMore: boolean };
const historyCalls: Array<{ sessionId: string; offset: number }> = [];
const newestPages = new Map<string, HistoryPage>();
const olderPages = new Map<string, HistoryPage>();
/** Older-page requests wait here when a test needs to switch sessions mid-request. */
let olderPageGate: Promise<void> | null = null;
let releaseOlderPages: (() => void) | null = null;
/** Makes the history endpoint fail, so a polling test can watch it come back. */
let historyEndpointDown = false;

/**
 * jsdom has no layout: scrollHeight and clientHeight are always 0 and scrollTop never clamps, so a
 * transcript that scrolls itself looks exactly like one that does not. These stand-ins give every
 * element the page's single viewport and content height, and clamp scrollTop the way a browser
 * does, so the assertions describe where the reader actually ends up.
 */
const VIEWPORT_PX = 400;
const OLDER_PAGE_HEIGHT_PX = 400;
let contentPx = 800;
let scrollTops = new WeakMap<Element, number>();

const maxScrollTop = () => Math.max(contentPx - VIEWPORT_PX, 0);

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    ws: null,
    isConnected: true,
    connectionStatus: 'connected',
    sendMessage: () => {},
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  }),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    api: {
      ...actual.api,
      sessionDetails: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { provider: 'codex' } }),
      }),
      providers: {
        ...actual.api.providers,
        sessionMessages: async (sessionId: string, options: { offset?: number } = {}) => {
          const offset = options.offset ?? 0;
          historyCalls.push({ sessionId, offset });
          if (historyEndpointDown) return { ok: false, status: 503, json: async () => ({}) };
          if (offset > 0 && olderPageGate) await olderPageGate;
          const page = offset > 0 ? olderPages.get(sessionId) : newestPages.get(sessionId);
          // The rows an older page prepends make the transcript taller; nothing else moves.
          if (offset > 0) contentPx += OLDER_PAGE_HEIGHT_PX;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: page ?? { messages: [], total: 0, hasMore: false },
            }),
          };
        },
      },
    },
  };
});

beforeEach(() => {
  listeners.clear();
  historyCalls.length = 0;
  newestPages.clear();
  olderPages.clear();
  olderPageGate = null;
  releaseOlderPages = null;
  historyEndpointDown = false;
  contentPx = 800;
  scrollTops = new WeakMap<Element, number>();

  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => contentPx,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT_PX,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) { return scrollTops.get(this) ?? 0; },
    set(this: Element, next: number) {
      scrollTops.set(this, Math.max(0, Math.min(next, maxScrollTop())));
    },
  });
});

afterEach(() => {
  for (const property of ['scrollHeight', 'clientHeight', 'scrollTop']) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
  }
});

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

function textMessage(id: string, sessionId: string, content: string) {
  return {
    id,
    sessionId,
    provider: 'codex',
    timestamp: '2026-06-01T00:00:00.000Z',
    kind: 'text',
    role: 'assistant',
    content,
  };
}

function renderView(sessionId: string, pollIntervalMs?: number) {
  const view = render(
    <UiPreferencesProvider>
      <SessionOutput sessionId={sessionId} pollIntervalMs={pollIntervalMs} />
    </UiPreferencesProvider>,
  );
  const scroller = view.container.querySelector<HTMLDivElement>('div.overflow-y-auto');
  if (!scroller) throw new Error('transcript scroll container not found');
  return { ...view, scroller };
}

/** Re-renders the same mounted viewer against another session, as the plugin host does. */
function switchSession(view: ReturnType<typeof renderView>, sessionId: string) {
  view.rerender(
    <UiPreferencesProvider>
      <SessionOutput sessionId={sessionId} />
    </UiPreferencesProvider>,
  );
}

describe('SessionOutput scroll position', () => {
  test('opens on the newest output and follows the same row as it grows', async () => {
    newestPages.set('session-a', {
      messages: [textMessage('a-1', 'session-a', '第一条输出')],
      total: 1,
      hasMore: false,
    });
    const view = renderView('session-a');

    await view.findByText('第一条输出');
    // The first page is only the tail, so opening the viewer must not leave the reader at its top.
    expect(view.scroller.scrollTop).toBe(maxScrollTop());
    // Without a poll interval the viewer never re-reads history on its own.
    expect(historyCalls).toHaveLength(1);

    // A run streams into the row that is already there: no new row appears, the content grows.
    contentPx = 1200;
    emit({ sessionId: 'session-a', kind: 'stream_delta', content: '正在写入的第二段', seq: 1, executionId: 'exec-1' });
    await view.findByText('正在写入的第二段');
    await waitFor(() => expect(view.scroller.scrollTop).toBe(maxScrollTop()));

    contentPx = 1600;
    emit({ sessionId: 'session-a', kind: 'stream_delta', content: '，还在写', seq: 2, executionId: 'exec-1' });
    await waitFor(() => expect(view.scroller.scrollTop).toBe(maxScrollTop()));
  });

  test('scrolling up pauses following until the reader asks for the newest output', async () => {
    newestPages.set('session-a', {
      messages: [textMessage('a-1', 'session-a', '第一条输出')],
      total: 1,
      hasMore: false,
    });
    const view = renderView('session-a');
    await view.findByText('第一条输出');

    // The reader scrolls up into what is already there.
    view.scroller.scrollTop = 60;
    fireEvent.scroll(view.scroller);
    expect(view.queryByText('回到最新')).toBeTruthy();

    contentPx = 1200;
    emit({ sessionId: 'session-a', kind: 'stream_delta', content: '不该把读者拉下去', seq: 1, executionId: 'exec-1' });
    await view.findByText('不该把读者拉下去');
    expect(view.scroller.scrollTop).toBe(60);

    fireEvent.click(view.getByText('回到最新'));
    await waitFor(() => expect(view.scroller.scrollTop).toBe(maxScrollTop()));
    expect(view.queryByText('回到最新')).toBeNull();
  });

  test('an older page is prepended without moving the rows being read', async () => {
    newestPages.set('session-a', {
      messages: [textMessage('a-2', 'session-a', '最新的一条输出')],
      total: 2,
      hasMore: true,
    });
    olderPages.set('session-a', {
      messages: [textMessage('a-1', 'session-a', '更早的一条输出')],
      total: 2,
      hasMore: false,
    });
    const view = renderView('session-a');
    await view.findByText('最新的一条输出');

    // Reading the first page means the reader sits off the bottom when they ask for more.
    view.scroller.scrollTop = 100;
    fireEvent.scroll(view.scroller);
    fireEvent.click(view.getByText('加载更早消息'));

    await view.findByText('更早的一条输出');
    // The prepended rows add their own height, so the position that read the same rows moves down
    // by exactly that much instead of staying at 100.
    await waitFor(() => expect(view.scroller.scrollTop).toBe(100 + OLDER_PAGE_HEIGHT_PX));
    expect(view.getByText('最新的一条输出')).toBeTruthy();
  });

  test('switching sessions lands on the new session’s newest output', async () => {
    newestPages.set('session-a', {
      messages: [textMessage('a-1', 'session-a', 'A 的输出')],
      total: 1,
      hasMore: false,
    });
    newestPages.set('session-b', {
      messages: [textMessage('b-1', 'session-b', 'B 的输出')],
      total: 1,
      hasMore: false,
    });
    const view = renderView('session-a');
    await view.findByText('A 的输出');

    view.scroller.scrollTop = 60;
    fireEvent.scroll(view.scroller);
    expect(view.queryByText('回到最新')).toBeTruthy();

    contentPx = 1600;
    switchSession(view, 'session-b');

    await view.findByText('B 的输出');
    await waitFor(() => expect(view.scroller.scrollTop).toBe(maxScrollTop()));
    // Follow mode restarts with the session: the new transcript is not the one being read.
    expect(view.queryByText('回到最新')).toBeNull();
  });

  test('an older page that answers after a session switch leaves the new session alone', async () => {
    newestPages.set('session-a', {
      messages: [textMessage('a-2', 'session-a', 'A 的最新输出')],
      total: 2,
      hasMore: true,
    });
    newestPages.set('session-b', {
      messages: [textMessage('b-1', 'session-b', 'B 的输出')],
      total: 1,
      hasMore: false,
    });
    olderPages.set('session-a', {
      messages: [textMessage('a-1', 'session-a', 'A 的更早输出')],
      total: 2,
      hasMore: false,
    });
    olderPageGate = new Promise<void>((resolve) => { releaseOlderPages = resolve; });

    const view = renderView('session-a');
    await view.findByText('A 的最新输出');
    view.scroller.scrollTop = 100;
    fireEvent.scroll(view.scroller);
    fireEvent.click(view.getByText('加载更早消息'));
    await waitFor(() => expect(historyCalls.some((call) => call.offset > 0)).toBe(true));

    contentPx = 1600;
    switchSession(view, 'session-b');
    await view.findByText('B 的输出');
    await waitFor(() => expect(view.scroller.scrollTop).toBe(maxScrollTop()));
    const newestOutputTop = view.scroller.scrollTop;

    // The abandoned page finally arrives for the session that is no longer shown. It must not
    // prepend rows here, nor move the reader by the height those rows would have added.
    await act(async () => {
      releaseOlderPages?.();
      await olderPageGate;
    });

    expect(view.queryByText('A 的更早输出')).toBeNull();
    expect(view.scroller.scrollTop).toBe(newestOutputTop);
  });

  test('a stream that lands while an older page is in flight does not consume its compensation', async () => {
    newestPages.set('session-a', {
      messages: [textMessage('a-2', 'session-a', '最新的一条输出')],
      total: 2,
      hasMore: true,
    });
    olderPages.set('session-a', {
      messages: [textMessage('a-1', 'session-a', '更早的一条输出')],
      total: 2,
      hasMore: false,
    });
    olderPageGate = new Promise<void>((resolve) => { releaseOlderPages = resolve; });

    const view = renderView('session-a');
    await view.findByText('最新的一条输出');
    view.scroller.scrollTop = 100;
    fireEvent.scroll(view.scroller);
    fireEvent.click(view.getByText('加载更早消息'));
    await waitFor(() => expect(historyCalls.some((call) => call.offset > 0)).toBe(true));

    // The run keeps writing while that page is in flight: the transcript grows below the reader.
    contentPx = 1100;
    emit({ sessionId: 'session-a', kind: 'stream_delta', content: '运行中的新输出', seq: 1, executionId: 'exec-1' });
    await view.findByText('运行中的新输出');
    // Growth below the reader must not be mistaken for the older page arriving.
    expect(view.scroller.scrollTop).toBe(100);

    // Now the page lands. Only the height its own rows added moves the reader.
    await act(async () => {
      releaseOlderPages?.();
      await olderPageGate;
    });
    await view.findByText('更早的一条输出');
    await waitFor(() => expect(view.scroller.scrollTop).toBe(100 + OLDER_PAGE_HEIGHT_PX));
  });
});

describe('SessionOutput polling a CLI-owned session', () => {
  test('a poll refreshes the transcript, follows at the bottom, and leaves a reader who scrolled up', async () => {
    newestPages.set('session-a', {
      messages: [textMessage('a-1', 'session-a', '第一条输出')],
      total: 1,
      hasMore: false,
    });
    const view = renderView('session-a', 25);
    await view.findByText('第一条输出');

    // The run writes into the provider transcript instead of the socket: the poll is the only source.
    newestPages.set('session-a', {
      messages: [textMessage('a-1', 'session-a', '第一条输出'), textMessage('a-2', 'session-a', '轮询到的新输出')],
      total: 2,
      hasMore: false,
    });
    await view.findByText('轮询到的新输出');
    // A refresh at the bottom keeps following, and does not stack a second copy of the old row.
    await waitFor(() => expect(view.scroller.scrollTop).toBe(maxScrollTop()));
    expect(view.queryAllByText('第一条输出')).toHaveLength(1);

    // The reader scrolls up to reread what is already there.
    view.scroller.scrollTop = 50;
    fireEvent.scroll(view.scroller);
    contentPx = 1200;
    newestPages.set('session-a', {
      messages: [
        textMessage('a-1', 'session-a', '第一条输出'),
        textMessage('a-2', 'session-a', '轮询到的新输出'),
        textMessage('a-3', 'session-a', '继续追加的输出'),
      ],
      total: 3,
      hasMore: false,
    });
    await view.findByText('继续追加的输出');
    expect(view.scroller.scrollTop).toBe(50);
  });

  test('polling keeps an older page already loaded, and stops when the viewer unmounts', async () => {
    newestPages.set('session-a', {
      messages: [textMessage('a-2', 'session-a', '最新的一条输出')],
      total: 2,
      hasMore: true,
    });
    olderPages.set('session-a', {
      messages: [textMessage('a-1', 'session-a', '更早的一条输出')],
      total: 2,
      hasMore: false,
    });
    const view = renderView('session-a', 25);
    await view.findByText('最新的一条输出');
    fireEvent.click(view.getByText('加载更早消息'));
    await view.findByText('更早的一条输出');

    // Several refreshes of the newest page later, the reader still has both pages, once each.
    const newestPageCalls = () => historyCalls.filter((call) => call.offset === 0).length;
    await waitFor(() => expect(newestPageCalls()).toBeGreaterThan(2));
    expect(view.queryAllByText('更早的一条输出')).toHaveLength(1);
    expect(view.queryAllByText('最新的一条输出')).toHaveLength(1);

    view.unmount();
    const callsAtUnmount = historyCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(historyCalls.length).toBe(callsAtUnmount);
  });

  test('a failing refresh keeps retrying at a slower rate and recovers', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    newestPages.set('session-a', {
      messages: [textMessage('a-1', 'session-a', '第一条输出')],
      total: 1,
      hasMore: false,
    });
    const view = renderView('session-a', 20);
    await view.findByText('第一条输出');

    historyEndpointDown = true;
    const callsBeforeOutage = historyCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 160));
    // Retries keep coming (recovery is possible) but back off instead of hammering the endpoint.
    const failedCalls = historyCalls.length - callsBeforeOutage;
    expect(failedCalls).toBeGreaterThan(0);
    expect(failedCalls).toBeLessThanOrEqual(5);
    expect(errorLog).toHaveBeenCalled();

    historyEndpointDown = false;
    newestPages.set('session-a', {
      messages: [textMessage('a-1', 'session-a', '第一条输出'), textMessage('a-2', 'session-a', '恢复后的输出')],
      total: 2,
      hasMore: false,
    });
    await view.findByText('恢复后的输出');
  });
});
