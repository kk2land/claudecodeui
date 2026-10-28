import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * Opening a DSH session fires the token-usage endpoint at the same time as the
 * live event/history path that owns the real context reading. Before the next
 * ACP turn the endpoint only has the in-process cache, so an empty
 * `unsupported` answer must not replace a reading already shown in the
 * composer. Other providers keep their existing refresh behavior.
 */

const harness = vi.hoisted(() => ({
  resolveTokenUsage: null as null | ((value: unknown) => void),
}));

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => new Promise((resolve) => {
        harness.resolveTokenUsage = resolve;
      }),
    },
  },
}));

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const store = {
  fetchFromServer: vi.fn(async () => ({
    fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0,
  })),
  fetchMore: vi.fn(),
  appendRealtime: vi.fn(),
  refreshLatestFromServer: vi.fn(),
  setActiveSession: vi.fn(),
  isStale: vi.fn(() => false),
  updateStreaming: vi.fn(),
  finalizeStreaming: vi.fn(),
  getMessages: vi.fn(() => []),
  getSessionSlot: vi.fn(() => ({
    fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0,
  })),
};

async function renderSession(provider: 'dsh' | 'claude') {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  const selectedSession: ProjectSession = { id: `session-${provider}`, provider };
  return renderHook(() => useChatSessionState({
    isActive: true,
    selectedProject: project,
    selectedSession,
    ws: null,
    sendMessage: vi.fn(),
    resetStreamingState: vi.fn(),
    statusCheckSentAtRef: { current: new Map() },
    lastSeqRef: { current: new Map() },
    sessionStore: store as never,
  }));
}

async function settleUnsupportedRefresh() {
  await act(async () => {
    harness.resolveTokenUsage?.({
      ok: true,
      json: async () => ({ data: { used: 0, total: 0, unsupported: true } }),
    });
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  harness.resolveTokenUsage = null;
  vi.clearAllMocks();
});

test('a DSH live context reading survives an unsupported endpoint refresh', async () => {
  const hook = await renderSession('dsh');
  const liveReading = { used: 66_408, total: 1_000_000 };

  await act(async () => {
    hook.result.current.setTokenBudget(liveReading);
  });
  await settleUnsupportedRefresh();

  assert.deepEqual(hook.result.current.tokenBudget, liveReading);
});

test('another provider keeps applying its unsupported endpoint refresh', async () => {
  const hook = await renderSession('claude');

  await act(async () => {
    hook.result.current.setTokenBudget({ used: 10, total: 100 });
  });
  await settleUnsupportedRefresh();

  assert.deepEqual(hook.result.current.tokenBudget, { used: 0, total: 0, unsupported: true });
});
