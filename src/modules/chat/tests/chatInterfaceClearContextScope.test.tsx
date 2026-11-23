import assert from 'node:assert/strict';

import type { ComponentProps } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type ChatComposer from '@/modules/chat/composer/ChatComposer';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * Clearing an old chat's context must not touch another chat's token counter.
 * The real ChatInterface and useChatSessionState render against a fake session
 * store, so the counter can only move through the hook's own session-scoped
 * history refresh, not a mirror of it.
 */

const harness = vi.hoisted(() => ({
  composer: vi.fn((_props: ComponentProps<typeof ChatComposer>) => null),
  clear: vi.fn(),
}));

vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: harness.composer }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => null, cancel: async () => false }),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({
    markSessionProcessing: () => {},
    markSessionIdle: () => {},
    markSessionBackground: () => {},
    getSessionActivity: () => null,
  }),
}));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }) }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('@/modules/todos', () => ({ ProjectTodoDialog: () => null, useProjectTodos: () => ({ todos: [] }) }));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({
    provider: 'claude',
    providerCapabilities: { claude: { supportsContextClearing: true } },
    supportsContextClearing: true,
    pendingPermissionRequests: [],
    providerModelCatalog: {},
    currentProviderModelOptions: [], currentProviderModel: 'model-x',
    currentProviderEffort: 'high', currentProviderEffortOptions: [],
    permissionMode: 'default', availablePermissionModes: ['default'],
    selectPermissionMode: () => {}, cyclePermissionMode: () => {},
    resolvePermissionModeForProvider: () => 'default',
    supportsMessageEditing: false, supportsSessionForking: false,
    supportsSideQuestions: false, supportsSteering: false,
  }),
}));
vi.mock('@/modules/chat/hooks/useCodexControls', () => ({
  useCodexControls: () => ({ state: { runtime: 'app-server', questions: [] } }),
}));
vi.mock('@/modules/chat/hooks/useCodexModelProviders', () => ({
  useCodexModelProviders: () => ({ available: false }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({ input: '', setInput: () => {}, textareaRef: { current: null } }),
}));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));
vi.mock('@/shared/api', () => ({
  api: {
    // The composer's own usage endpoint answers for whichever session is mounted,
    // which is how the counter gets its non-empty starting value.
    providers: {
      sessionTokenUsage: (sessionId: string) => Promise.resolve({
        ok: true,
        json: async () => ({ data: usageSlots.get(sessionId) ?? null }),
      }),
    },
    clearSessionContext: harness.clear,
  },
}));

const A_BUDGET = { used: 1111, total: 200000 };
const B_BUDGET = { used: 2222, total: 200000 };

/** What the composer's usage endpoint reports per session. */
const usageSlots = new Map<string, Record<string, unknown> | null>([
  ['session-a', A_BUDGET],
  ['session-b', B_BUDGET],
]);

/** What a history slot carries; a cleared session answers with no usage, as the backend does. */
const historySlots = new Map<string, Record<string, unknown> | null>([
  ['session-a', A_BUDGET],
  ['session-b', B_BUDGET],
]);

const store = {
  fetchFromServer: vi.fn(async (sessionId: string) => ({
    fetchedAt: 1, status: 'idle' as const, total: 1, hasMore: false, offset: 0, tokenUsage: historySlots.get(sessionId),
  })),
  fetchMore: vi.fn(),
  appendRealtime: vi.fn(),
  // The real guard: a refresh for a session that is no longer active is deferred.
  refreshLatestFromServer: vi.fn(async (sessionId: string, { canRequest }: { canRequest: () => boolean }) => {
    const slot = { fetchedAt: Date.now(), status: 'idle' as const, total: 1, hasMore: false, offset: 0, tokenUsage: historySlots.get(sessionId) };
    if (!canRequest()) return { slot, applied: false, changed: false, deferred: true };
    return { slot, applied: true, changed: true, deferred: false };
  }),
  setActiveSession: vi.fn(),
  isStale: vi.fn(() => false),
  updateStreaming: vi.fn(),
  finalizeStreaming: vi.fn(),
  getMessages: vi.fn(() => []),
  getSessionSlot: vi.fn((sessionId: string) => ({
    fetchedAt: 1, status: 'idle' as const, total: 1, hasMore: false, offset: 0, tokenUsage: historySlots.get(sessionId),
  })),
};
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => store }));

const { default: ChatInterface } = await import('@/modules/chat/ChatInterface');

const project: Project = { projectId: 'p1', displayName: 'repo', fullPath: '/work/repo', path: '/work/repo' };
const sessionA: ProjectSession = { id: 'session-a', provider: 'claude' };
const sessionB: ProjectSession = { id: 'session-b', provider: 'claude' };

const renderInterface = (session: ProjectSession) => (
  <ChatInterface isActive selectedProject={project} selectedSession={session} ws={null} sendMessage={() => {}} />
);

const latestComposer = () => harness.composer.mock.calls.at(-1)![0];

beforeEach(() => {
  vi.clearAllMocks();
  usageSlots.set('session-a', A_BUDGET);
  usageSlots.set('session-b', B_BUDGET);
  historySlots.set('session-a', A_BUDGET);
  historySlots.set('session-b', B_BUDGET);
  vi.stubGlobal('confirm', () => true);
});

test('a delayed clear for another chat leaves the open chat\'s token counter alone', async () => {
  let resolveClear: (response: Response) => void = () => {};
  harness.clear.mockImplementation(() => new Promise<Response>((resolve) => { resolveClear = resolve; }));

  const view = render(renderInterface(sessionA));
  await waitFor(() => assert.deepEqual(latestComposer().tokenBudget, A_BUDGET));

  // Start the clear on A, then move to B before the server answers.
  await act(async () => { latestComposer().onClearContext?.(); });
  view.rerender(renderInterface(sessionB));
  await waitFor(() => assert.deepEqual(latestComposer().tokenBudget, B_BUDGET));

  // The clear finishes while B is open: every await in the handler is a
  // microtask, so act flushes it before B's counter is read.
  await act(async () => {
    historySlots.set('session-a', null); // the backend cleared A's context
    resolveClear(Response.json({ data: { sessionId: 'session-a', cleared: true } }));
  });

  assert.deepEqual(latestComposer().tokenBudget, B_BUDGET, 'B keeps its own counter');

  // A's refresh was deferred while B was open; returning to A applies it, which
  // also proves above that A's clear had completed rather than still pending.
  view.rerender(renderInterface(sessionA));
  await waitFor(() => assert.equal(latestComposer().tokenBudget, null, 'the cleared context has no usage left'));
});

test('a clear in the open chat drops the counter through the scoped history refresh', async () => {
  harness.clear.mockImplementation(async () => {
    historySlots.set('session-a', null);
    return Response.json({ data: { sessionId: 'session-a', cleared: true } });
  });

  render(renderInterface(sessionA));
  await waitFor(() => assert.deepEqual(latestComposer().tokenBudget, A_BUDGET));

  await act(async () => { latestComposer().onClearContext?.(); });

  await waitFor(() => {
    assert.equal(latestComposer().tokenBudget, null, 'the cleared context has no usage left');
    assert.ok(
      store.refreshLatestFromServer.mock.calls.some(([id]) => id === 'session-a'),
      'through the session-scoped refresh',
    );
  });
});
