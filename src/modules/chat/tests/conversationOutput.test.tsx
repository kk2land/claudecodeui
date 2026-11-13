import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import { ConversationOutput } from '@/modules/chat/ConversationOutput';
import type { WorkerConversationMessage } from '@/shared/types';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';

/**
 * The Worker conversation view is the main transcript, read-only, over rows a plugin parsed from
 * its own event log. These tests use the real transcript components: what matters is that every
 * row kind stays readable, that the newest output is followed while it streams, and that a reader
 * who scrolled up is left alone — without this view ever fetching history on its own.
 */

/**
 * jsdom has no layout, so a scrolling transcript looks the same whether or not it follows. These
 * stand-ins give the element one viewport and content height and clamp `scrollTop` the way a
 * browser does, which is what the assertions describe.
 */
const VIEWPORT_PX = 300;
let contentPx = 600;
let scrollTops = new WeakMap<Element, number>();

const maxScrollTop = () => Math.max(contentPx - VIEWPORT_PX, 0);

/**
 * jsdom ships no ResizeObserver. The view is expected to observe the rows it drew, so this mock
 * records what each observer watches and lets a test deliver the size change a browser would
 * report after layout settles. It deliberately does not fire on its own: a test states when layout
 * grows, which is the whole condition under repair.
 */
type Observation = { target: Element | null; callback: () => void };
const observations = new Set<Observation>();

class MockResizeObserver {
  private readonly observation: Observation;
  constructor(callback: () => void) {
    this.observation = { target: null, callback };
    observations.add(this.observation);
  }
  observe(target: Element): void {
    this.observation.target = target;
  }
  unobserve(target: Element): void {
    if (this.observation.target === target) this.observation.target = null;
  }
  disconnect(): void {
    observations.delete(this.observation);
  }
}

/** Grows the rendered content and reports it the way the browser's observer would. */
function reportContentGrowth(growthPx = 120): void {
  contentPx += growthPx;
  act(() => {
    for (const observation of [...observations]) observation.callback();
  });
}

beforeEach(() => {
  contentPx = 600;
  scrollTops = new WeakMap<Element, number>();
  observations.clear();
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
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
  observations.clear();
  vi.unstubAllGlobals();
  for (const property of ['scrollHeight', 'clientHeight', 'scrollTop']) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
  }
});

/** The scroller a plugin panel would provide: the view drives it instead of owning one. */
function createScroller(): HTMLDivElement {
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  return scroller;
}

function renderView(messages: WorkerConversationMessage[], provider = 'pi', scrollContainer = createScroller()) {
  const view = render(
    <UiPreferencesProvider>
      <ConversationOutput provider={provider} messages={messages} scrollContainer={scrollContainer} />
    </UiPreferencesProvider>,
  );
  const rerender = (nextMessages: WorkerConversationMessage[]) => view.rerender(
    <UiPreferencesProvider>
      <ConversationOutput provider={provider} messages={nextMessages} scrollContainer={scrollContainer} />
    </UiPreferencesProvider>,
  );
  return { ...view, rerender, scroller: scrollContainer };
}

describe('ConversationOutput rendering', () => {
  test('renders input, thinking, tools, results and errors as readable conversation', () => {
    const messages: WorkerConversationMessage[] = [
      { id: 'u-1', role: 'user', text: '请把构建结果整理成 Markdown' },
      { id: 't-1', role: 'assistant', text: '先确认当前分支，再跑构建。', thinking: true },
      { id: 'a-1', role: 'assistant', text: '构建通过，没有错误。', streaming: false },
      {
        id: 'tool-1',
        role: 'tool',
        text: '',
        toolId: 'call-1',
        toolName: 'Bash',
        toolInput: { command: 'npm run build' },
        toolOutput: 'vite build finished',
      },
      {
        id: 'tool-2',
        role: 'tool',
        text: '',
        toolId: 'call-2',
        toolName: 'Read',
        toolInput: { file_path: 'src/missing.ts' },
        toolOutput: 'ENOENT: no such file',
        isError: true,
      },
      { id: 'e-1', role: 'error', text: 'CLI 退出码 2' },
    ];

    const view = renderView(messages);
    const text = view.container.textContent ?? '';

    expect(text).toContain('请把构建结果整理成 Markdown');
    // The provider is named by the shared header: a Worker's Pi run reads as Pi, not Claude.
    expect(text).toContain('Pi');
    // Thinking rows are the run's own reasoning, so they are shown rather than folded away.
    expect(text).toContain('先确认当前分支，再跑构建。');
    expect(text).toContain('构建通过，没有错误。');
    // A tool call and its result stay one readable card: command, payload and output all survive.
    expect(text).toContain('npm run build');
    // Shell output is a collapsed row by default, exactly as in the main conversation.
    fireEvent.click(view.getByText('npm run build'));
    expect(view.container.textContent).toContain('vite build finished');
    expect(text).toContain('Read');
    expect(text).toContain('missing.ts');
    expect(text).toContain('ENOENT: no such file');
    expect(text).toContain('CLI 退出码 2');
    // Rows have no native time, so the transcript invents none: no clock time is drawn anywhere.
    expect(text).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  test('a tool row that carries only text is shown as text instead of an empty card', () => {
    const view = renderView([{ id: 'tool-text', role: 'tool', text: '工具输出已被截断' }]);
    expect(view.container.textContent).toContain('工具输出已被截断');
  });

  test('never requests history or a session on its own', async () => {
    const { api } = await import('@/shared/api');
    const sessionDetails = vi.spyOn(api, 'sessionDetails');
    const sessionMessages = vi.spyOn(api.providers, 'sessionMessages');

    const view = renderView([
      { id: 'u-1', role: 'user', text: '读取这段运行日志' },
      { id: 'a-1', role: 'assistant', text: '已读取。' },
    ]);
    await waitFor(() => expect(view.container.textContent).toContain('已读取。'));

    expect(sessionDetails).not.toHaveBeenCalled();
    expect(sessionMessages).not.toHaveBeenCalled();
  });
});

describe('ConversationOutput scroll following', () => {
  test('opens on the newest row and follows the same row as it grows', () => {
    const first: WorkerConversationMessage[] = [
      { id: 'a-1', role: 'assistant', text: '第一段', streaming: true },
    ];
    const view = renderView(first);
    // Mounting mid-run must not leave the reader at the top of the output.
    expect(view.scroller.scrollTop).toBe(maxScrollTop());

    // The same row keeps streaming: no row is added, only its text and the height grow.
    contentPx = 900;
    view.rerender([{ id: 'a-1', role: 'assistant', text: '第一段，第二段正在写入', streaming: true }]);
    expect(view.container.textContent).toContain('第一段，第二段正在写入');
    expect(view.scroller.scrollTop).toBe(maxScrollTop());

    contentPx = 1200;
    view.rerender([
      { id: 'a-1', role: 'assistant', text: '第一段，第二段正在写入，还在写', streaming: true },
    ]);
    expect(view.scroller.scrollTop).toBe(maxScrollTop());
    expect(view.queryByText('回到最新')).toBeNull();
  });

  test('scrolling up pauses following until the reader asks for the newest output', () => {
    const view = renderView([{ id: 'a-1', role: 'assistant', text: '第一条输出' }]);
    expect(view.scroller.scrollTop).toBe(maxScrollTop());

    view.scroller.scrollTop = 50;
    fireEvent.scroll(view.scroller);
    expect(view.queryByText('回到最新')).toBeTruthy();

    // A run keeps writing while the reader reads older rows: they stay where they are.
    contentPx = 1200;
    view.rerender([
      { id: 'a-1', role: 'assistant', text: '第一条输出' },
      { id: 'a-2', role: 'assistant', text: '不该把读者拉下去' },
    ]);
    expect(view.container.textContent).toContain('不该把读者拉下去');
    expect(view.scroller.scrollTop).toBe(50);

    fireEvent.click(view.getByText('回到最新'));
    expect(view.scroller.scrollTop).toBe(maxScrollTop());
    expect(view.queryByText('回到最新')).toBeNull();
  });

  test('a switch to a new mount starts following again with nothing carried over', () => {
    const view = renderView([{ id: 'a-1', role: 'assistant', text: '旧投递的输出' }]);
    view.scroller.scrollTop = 40;
    fireEvent.scroll(view.scroller);
    expect(view.queryByText('回到最新')).toBeTruthy();

    view.unmount();
    const nextScroller = createScroller();
    const next = renderView([{ id: 'b-1', role: 'assistant', text: '新挂载的输出' }], 'pi', nextScroller);
    expect(next.container.textContent).toContain('新挂载的输出');
    expect(next.scroller.scrollTop).toBe(maxScrollTop());
    expect(next.queryByText('回到最新')).toBeNull();
  });
});

describe('ConversationOutput late content growth', () => {
  test('keeps following when the drawn rows grow after the commit without new messages', () => {
    const messages: WorkerConversationMessage[] = [
      { id: 'a-1', role: 'assistant', text: '第一段输出', streaming: true },
    ];
    const view = renderView(messages);
    expect(view.scroller.scrollTop).toBe(maxScrollTop());

    // The observer belongs to the rows, not to the viewport this view scrolls.
    const [observation] = [...observations];
    expect(observation).toBeTruthy();
    expect(observation.target).not.toBe(view.scroller);
    expect(observation.target?.textContent).toContain('第一段输出');

    // Same props, same rows: only the layout of what is already drawn finishes later.
    reportContentGrowth(250);
    expect(view.scroller.scrollTop).toBe(maxScrollTop());
    expect(view.queryByText('回到最新')).toBeNull();
  });

  test('a reader who paused is never pulled down by late layout growth, and can resume', () => {
    const view = renderView([{ id: 'a-1', role: 'assistant', text: '第一条输出' }]);
    view.scroller.scrollTop = 50;
    fireEvent.scroll(view.scroller);
    expect(view.queryByText('回到最新')).toBeTruthy();

    reportContentGrowth(300);
    // Pausing is the reader's decision: growth arrives and nothing moves.
    expect(view.scroller.scrollTop).toBe(50);
    expect(view.queryByText('回到最新')).toBeTruthy();

    fireEvent.click(view.getByText('回到最新'));
    expect(view.scroller.scrollTop).toBe(maxScrollTop());

    // Once following again, later growth keeps the newest output in view.
    reportContentGrowth(200);
    expect(view.scroller.scrollTop).toBe(maxScrollTop());
    expect(view.queryByText('回到最新')).toBeNull();
  });

  test('a standalone mount observes the rows inside its own scroll area', () => {
    const view = render(
      <UiPreferencesProvider>
        <ConversationOutput
          provider="pi"
          messages={[{ id: 'a-1', role: 'assistant', text: '自带滚动的输出' }]}
        />
      </UiPreferencesProvider>,
    );
    const scroller = view.container.querySelector<HTMLDivElement>('div.overflow-y-auto');
    if (!scroller) throw new Error('standalone scroll container not found');
    const [observation] = [...observations];
    expect(observation).toBeTruthy();
    expect(observation.target).not.toBe(scroller);
    expect(scroller.contains(observation.target)).toBe(true);

    reportContentGrowth(180);
    expect(scroller.scrollTop).toBe(maxScrollTop());
  });

  test('unmount disconnects the observer', () => {
    const view = renderView([{ id: 'a-1', role: 'assistant', text: '卸载前的输出' }]);
    expect(observations.size).toBe(1);

    view.unmount();
    expect(observations.size).toBe(0);
  });
});
