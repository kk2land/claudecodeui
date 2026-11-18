import assert from 'node:assert/strict';

import { createRef } from 'react';
import { render } from '@testing-library/react';
import { test, vi } from 'vitest';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage } from '@/shared/types';

/**
 * A provider run flushes roughly ten times a second, and every flush re-renders
 * the transcript with a fresh array. Only the row that grew should cost a
 * render; the collapsed tool-call groups above it must bail out of their memo.
 *
 * Counted through the render-context hook every transcript row calls at the top
 * of its body, which is the cheapest place to observe "this component's body
 * ran" without wrapping the components under test.
 */
let rowRenders = 0;
vi.mock('@/modules/chat/context/TranscriptRenderContext', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useIsExportingTranscript: () => {
      rowRenders += 1;
      return false;
    },
  };
});

const TOOL_RUN_LENGTH = 3;
const TOOL_GROUP_COUNT = 4;

const toolRow = (index: number, call: number): ChatMessage => ({
  type: 'tool',
  content: '',
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, index, call)).toISOString(),
  isToolUse: true,
  toolName: 'Read',
  toolInput: JSON.stringify({ file_path: `/src/file-${index}-${call}.ts` }),
});

const assistantRow = (index: number): ChatMessage => ({
  type: 'assistant',
  content: `Reviewed batch ${index}.`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, index, 59)).toISOString(),
});

/** Runs of same-tool calls, each long enough to collapse into one group row. */
function buildHistory(): ChatMessage[] {
  const rows: ChatMessage[] = [];
  for (let index = 0; index < TOOL_GROUP_COUNT; index += 1) {
    for (let call = 0; call < TOOL_RUN_LENGTH; call += 1) {
      rows.push(toolRow(index, call));
    }
    rows.push(assistantRow(index));
  }
  return rows;
}

const noop = () => undefined;
const stable = {
  scrollContainerRef: createRef<HTMLDivElement>(),
  textareaRef: createRef<HTMLTextAreaElement>(),
  selectedSession: { id: 'session-1' },
  selectedProject: { projectId: 'project-1', name: 'repo', path: '/repo' },
  providerModels: {},
  providerModelCatalog: {},
  providerModelActions: {},
  createDiff: () => [],
  onGrantToolPermission: () => ({ success: true }),
};

function paneProps(chatMessages: ChatMessage[]) {
  return {
    ...stable,
    onWheel: noop,
    onTouchMove: noop,
    isLoadingSessionMessages: false,
    chatMessages,
    currentSessionId: 'session-1',
    provider: 'claude',
    setProvider: noop,
    setProviderModel: noop,
    providerModelsLoading: false,
    tasksEnabled: false,
    isTaskMasterInstalled: false,
    onShowAllTasks: null,
    setInput: noop,
    isLoadingMoreMessages: false,
    hasMoreMessages: false,
    totalMessages: chatMessages.length,
    sessionMessagesCount: chatMessages.length,
    visibleMessageCount: 1000,
    visibleMessages: chatMessages,
    loadEarlierMessages: noop,
    revealMessage: noop,
    sendMessage: noop,
    loadAllMessages: noop,
    allMessagesLoaded: true,
    isLoadingAllMessages: false,
    loadAllJustFinished: false,
    showLoadAllOverlay: false,
    showRawParameters: false,
    showThinking: true,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const pane = (chatMessages: ChatMessage[]) => (
  <UiPreferencesProvider>
    <ChatMessagesPane {...(paneProps(chatMessages) as any)} />
  </UiPreferencesProvider>
);
/* eslint-enable @typescript-eslint/no-explicit-any */

test('a stream tick re-renders the growing row, not the collapsed tool groups above it', { timeout: 30_000 }, () => {
  const history = buildHistory();
  let streaming: ChatMessage = {
    type: 'assistant',
    content: 'Here',
    timestamp: '2026-01-01T00:10:00.000Z',
  };

  const view = render(pane([...history, streaming]));
  assert.equal(
    view.container.querySelectorAll('.chat-message.tool > button[aria-expanded]').length,
    TOOL_GROUP_COUNT,
    'the fixture must actually collapse its tool runs into groups',
  );

  const perFlush: number[] = [];
  for (let flush = 1; flush <= 3; flush += 1) {
    streaming = { ...streaming, content: `${streaming.content} token${flush}` };
    const before = rowRenders;
    view.rerender(pane([...history, streaming]));
    perFlush.push(rowRenders - before);
  }

  assert.deepEqual(
    perFlush,
    [1, 1, 1],
    `only the streaming row may re-render per flush; got ${JSON.stringify(perFlush)}`,
  );
});

/** A Worker run reports progress through the `cloudcli_workers` MCP server. */
const workerTool = (tool: string) => `mcp__cloudcli_workers__${tool}`;

const callRow = (toolName: string, input: unknown, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-01-01T00:20:00.000Z',
  isToolUse: true,
  toolName,
  toolInput: JSON.stringify(input),
  ...extra,
});

test('Worker MCP calls are hidden while failures, other MCP tools and commands stay', { timeout: 30_000 }, () => {
  const rows: ChatMessage[] = [
    {
      type: 'assistant',
      content: 'Delegated the work to a Worker.',
      timestamp: '2026-01-01T00:19:59.000Z',
    },
    // Three identical in-flight calls would collapse into one tool group if the
    // filter ran after grouping instead of before it.
    callRow(workerTool('worker_context'), { view: 'compact' }, { toolStatus: 'in_progress' }),
    callRow(workerTool('worker_context'), { view: 'compact' }, { toolStatus: 'in_progress' }),
    callRow(workerTool('worker_context'), { view: 'compact' }, { toolStatus: 'in_progress' }),
    callRow(workerTool('worker_get'), { id: 'worker-1' }, {
      toolStatus: 'completed',
      toolResult: { content: 'worker snapshot' },
    }),
    callRow(workerTool('worker_start'), { prompt: 'VISIBLE_WORKER_ISERROR' }, {
      toolStatus: 'failed',
      toolResult: { content: 'worker start failed', isError: true },
    }),
    // A status-only failure keeps its card too, before any result is attached.
    callRow(workerTool('worker_wait'), { id: 'VISIBLE_WORKER_STATUS_FAILED' }, { toolStatus: 'failed' }),
    callRow('sleep', { text: 'VISIBLE_SLEEP' }),
    callRow('exec', { command: 'echo VISIBLE_EXEC' }),
    // Another MCP server exposing a tool of the same name must stay: only the
    // `cloudcli_workers` prefix is filtered.
    callRow('mcp__filesystem__worker_get', { path: '/VISIBLE_OTHER_MCP' }, {
      toolResult: { content: 'files' },
    }),
  ];

  const view = render(pane(rows));
  const text = view.container.textContent || '';

  assert.ok(text.includes('Delegated the work to a Worker.'), 'the surrounding transcript keeps its body text');
  assert.ok(!text.includes('worker_context'), `Worker context calls must not render; got ${JSON.stringify(text)}`);
  assert.ok(!text.includes('worker_get (cloudcli_workers)'), 'the successful Worker call must not render');
  assert.equal(
    (text.match(/\(cloudcli_workers\)/g) ?? []).length,
    2,
    'only the two failed Worker calls keep their MCP label',
  );
  assert.equal(
    view.container.querySelectorAll('.chat-message.tool > button[aria-expanded]').length,
    0,
    'hidden Worker calls must not leave a collapsed tool group behind',
  );

  assert.ok(text.includes('VISIBLE_WORKER_ISERROR'), 'a Worker call whose result is an error stays visible');
  assert.ok(text.includes('VISIBLE_WORKER_STATUS_FAILED'), 'a Worker call with a failed status stays visible');
  assert.ok(text.includes('sleep'), 'a normal sleep tool stays visible');
  assert.ok(text.includes('VISIBLE_SLEEP'), 'the sleep tool\'s own row keeps its input summary');
  assert.ok(text.includes('VISIBLE_EXEC'), 'a normal exec tool stays visible');
  assert.ok(text.includes('worker_get (filesystem)'), 'another MCP server\'s same-named tool stays visible');
  assert.ok(text.includes('/VISIBLE_OTHER_MCP'), 'its row keeps the input summary of an unfiltered MCP call');
});
