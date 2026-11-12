import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ServerEvent } from '@/shared/types';

/**
 * Hiding a resident session broadcasts `session_removed`, which is not a delete: the sidebar row
 * goes away and the counts follow, while the open chat keeps its session, context and transcript.
 * The event may also arrive without an owning project — then the counts can only be corrected by
 * the server, so the hook refreshes instead of decrementing a project it would have to guess.
 */

const projectsResponse = vi.fn();
const LISTENER_SESSIONS = [
  { id: 'session-hidden', summary: 'hidden soon' },
  // A second page the user already loaded, plus a row older than it.
  { id: 'session-loaded-page-2', summary: 'page two' },
];

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const project = (overrides: Partial<Project> = {}): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'repo',
  isStarred: false,
  sessions: LISTENER_SESSIONS.map((session) => ({ ...session })),
  // Three sessions exist on the server; only two pages of rows are loaded here.
  sessionMeta: { hasMore: true, total: 3 },
  ...overrides,
});

const listeners = new Set<(event: ServerEvent) => void>();

const emit = (event: ServerEvent) => {
  act(() => {
    for (const listener of listeners) listener(event);
  });
};

const renderProjectsState = async (sessionId?: string) => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  return renderHook(() => useProjectsState({
    sessionId,
    navigate: vi.fn(),
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isMobile: false,
    isSessionProcessing: () => false,
  }));
};

const sidebarSessions = (result: { current: { projects: Project[] } }) =>
  result.current.projects.flatMap((entry) => (entry.sessions ?? []).map((session) => session.id));

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [project()] });
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('a hidden session leaves the sidebar, keeps the other loaded pages and fixes the total', async () => {
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.sidebarSharedProps.isLoading, false));

  emit({ kind: 'session_removed', sessionId: 'session-hidden', projectId: 'project-1', timestamp: '2026-08-01T00:00:00.000Z' });

  assert.deepEqual(sidebarSessions(result), ['session-loaded-page-2']);
  const updated = result.current.projects[0]!;
  // The count comes from the server total, not from the rows this page happens to hold.
  assert.equal(updated.sessionMeta?.total, 2);
  assert.equal(updated.sessionMeta?.hasMore, true);
  // Nothing was refetched: a known owner is handled locally.
  assert.equal(projectsResponse.mock.calls.length, 1);
});

test('a sid-only removal for a row that was never loaded refreshes the authoritative counts', async () => {
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.sidebarSharedProps.isLoading, false));

  // `session-not-loaded` is the third session: present in `total`, absent from every loaded page.
  emit({ kind: 'session_removed', sessionId: 'session-not-loaded', timestamp: '2026-08-01T00:00:00.000Z' });

  await waitFor(() => assert.equal(projectsResponse.mock.calls.length, 2));
  // The loaded pages are preserved; the refresh replaces them with the server's truth, not by
  // deleting rows the event did not name.
  assert.ok(sidebarSessions(result).includes('session-loaded-page-2'));
});

test('the open chat keeps its session when that session is hidden', async () => {
  const { result } = await renderProjectsState('session-hidden');
  await waitFor(() => assert.equal(result.current.sidebarSharedProps.isLoading, false));
  assert.equal(result.current.selectedSession?.id, 'session-hidden');

  emit({ kind: 'session_removed', sessionId: 'session-hidden', projectId: 'project-1' });

  assert.equal(sidebarSessions(result).includes('session-hidden'), false);
  // The selection, its provider and its transcript state are untouched: a hide is not a delete.
  assert.equal(result.current.selectedSession?.id, 'session-hidden');
});

test('a resident-only upsert reaches the row even when nothing else changed', async () => {
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.sidebarSharedProps.isLoading, false));

  const upsert = (resident: unknown) => ({
    kind: 'session_upserted',
    sessionId: 'session-hidden',
    provider: 'codex',
    // Identical summary and activity: only the resident projection changes.
    session: { id: 'session-hidden', summary: 'hidden soon', lastActivity: '2026-08-01T00:00:00.000Z', resident },
    project: { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'repo', isStarred: false },
    timestamp: '2026-08-01T00:00:00.000Z',
  });

  const residentOf = () => result.current.projects[0]?.sessions
    ?.find((session) => session.id === 'session-hidden')?.resident;

  emit(upsert(null));
  assert.equal(residentOf(), null);

  emit(upsert({
    taskId: 'resident-1',
    status: 'running',
    enabled: true,
    visible: true,
    adoptable: false,
    blockedReason: 'already_resident',
  }));
  assert.equal((residentOf() as { taskId?: string } | null)?.taskId, 'resident-1');

  emit(upsert(null));
  assert.equal(residentOf(), null);
});
