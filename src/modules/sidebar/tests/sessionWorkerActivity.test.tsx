import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useSidebarSessionActivity } from '@/modules/sidebar/hooks/useSidebarSessionActivity';
import { api } from '@/shared/api';
import type { WorkerRunStatus } from '@/shared/types';

const { pluginState } = vi.hoisted(() => ({ pluginState: { enabled: true } }));
vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [{ name: 'worker', enabled: pluginState.enabled }] }),
}));

const NO_SESSIONS: ReadonlySet<string> = new Set<string>();
let pageHidden = false;

beforeEach(() => {
  pageHidden = false;
  pluginState.enabled = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => pageHidden });
  vi.useFakeTimers();
});

afterEach(() => {
  pageHidden = false;
  vi.useRealTimers();
});

function worker(status: WorkerRunStatus, parentSessionId = 'session-1') {
  return { parentSessionId, latestRun: { status } };
}

function state(workers: Array<Record<string, unknown>>) {
  return Response.json({ workers });
}

/** Lets the unscoped state read, JSON parse and React updates settle before asserting. */
async function settle() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

async function advance(milliseconds = 2000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

const renderActivity = (initialBusy: ReadonlySet<string> = NO_SESSIONS, initialBackground: ReadonlySet<string> = NO_SESSIONS) =>
  renderHook(
    ({ busySessionIds, backgroundSessionIds }: { busySessionIds: ReadonlySet<string>; backgroundSessionIds: ReadonlySet<string> }) =>
      useSidebarSessionActivity({ busySessionIds, backgroundSessionIds }),
    { initialProps: { busySessionIds: initialBusy, backgroundSessionIds: initialBackground } },
  );

test('an idle parent session with a running Worker draws the spinner', async () => {
  vi.spyOn(api.plugins, 'workerStateAll').mockResolvedValue(state([worker('running')]));
  const hook = renderActivity();

  await settle();

  expect(hook.result.current.activeSessions.has('session-1')).toBe(true);
  expect(hook.result.current.backgroundSessionIds.has('session-1')).toBe(false);
  hook.unmount();
});

test.each(['starting', 'running', 'stopping', 'unknown'] as const)(
  'a %s Worker keeps its idle parent active',
  async (status) => {
    vi.spyOn(api.plugins, 'workerStateAll').mockResolvedValue(state([worker(status)]));
    const hook = renderActivity();
    await settle();
    expect(hook.result.current.activeSessions.has('session-1')).toBe(true);
    hook.unmount();
  },
);

test.each(['queued', 'completed', 'failed', 'cancelled', 'interrupted'] as const)(
  'a %s Worker leaves its idle parent inactive',
  async (status) => {
    vi.spyOn(api.plugins, 'workerStateAll').mockResolvedValue(state([worker(status)]));
    const hook = renderActivity();
    await settle();
    expect(hook.result.current.activeSessions.size).toBe(0);
    hook.unmount();
  },
);

test('the parent stays active while any of its Workers still runs, and stops when the last one ends', async () => {
  const workerStateAll = vi.spyOn(api.plugins, 'workerStateAll')
    .mockResolvedValueOnce(state([worker('running'), worker('starting')]))
    .mockResolvedValueOnce(state([worker('completed'), worker('running')]))
    .mockResolvedValueOnce(state([worker('completed'), worker('cancelled')]));
  const hook = renderActivity();
  await settle();
  expect(hook.result.current.activeSessions.has('session-1')).toBe(true);

  await advance();
  await settle();
  expect(hook.result.current.activeSessions.has('session-1')).toBe(true);

  await advance();
  await settle();
  expect(hook.result.current.activeSessions.has('session-1')).toBe(false);
  expect(workerStateAll).toHaveBeenCalledTimes(3);
  hook.unmount();
});

test('an active Worker keeps the parent active while the user looks at another session', async () => {
  vi.spyOn(api.plugins, 'workerStateAll').mockResolvedValue(state([worker('running')]));
  const hook = renderActivity(new Set(['session-selected']));
  await settle();
  expect(hook.result.current.activeSessions).toEqual(new Set(['session-selected', 'session-1']));

  // Moving the selection is a prop change of the list, not of the selected
  // session: the Worker keeps its own parent in the activity set.
  hook.rerender({ busySessionIds: new Set(['session-other']), backgroundSessionIds: NO_SESSIONS });
  await settle();
  expect(hook.result.current.activeSessions).toEqual(new Set(['session-other', 'session-1']));
  hook.unmount();
});

test('the session own spinner is unchanged when no Worker is active', async () => {
  vi.spyOn(api.plugins, 'workerStateAll').mockResolvedValue(state([worker('completed')]));
  const busy = new Set(['session-1']);
  const hook = renderActivity(busy);

  await settle();

  expect(hook.result.current.activeSessions).toBe(busy);
  expect(hook.result.current.activeSessions.has('session-1')).toBe(true);
  hook.unmount();
});

test('a Worker takes precedence over the background-task dot', async () => {
  const workerStateAll = vi.spyOn(api.plugins, 'workerStateAll')
    .mockResolvedValueOnce(state([worker('running')]))
    .mockResolvedValueOnce(state([worker('completed')]));
  const busy = new Set(['session-1']);
  const background = new Set(['session-1']);
  const hook = renderActivity(busy, background);
  await settle();
  expect(hook.result.current.activeSessions.has('session-1')).toBe(true);
  expect(hook.result.current.backgroundSessionIds.has('session-1')).toBe(false);

  await advance();
  await settle();
  expect(hook.result.current.activeSessions).toBe(busy);
  expect(hook.result.current.backgroundSessionIds).toBe(background);
  hook.unmount();
});

test('does not query when the Worker plugin is disabled', async () => {
  pluginState.enabled = false;
  const workerStateAll = vi.spyOn(api.plugins, 'workerStateAll');
  const hook = renderActivity();
  await settle();
  expect(workerStateAll).not.toHaveBeenCalled();
  expect(hook.result.current.activeSessions.size).toBe(0);
  hook.unmount();
});

test('a failed read hides Worker activity and the next poll recovers', async () => {
  vi.spyOn(api.plugins, 'workerStateAll')
    .mockResolvedValueOnce(state([worker('running')]))
    .mockRejectedValueOnce(new Error('plugin unavailable'))
    .mockResolvedValueOnce(state([worker('running')]));
  const hook = renderActivity();
  await settle();
  expect(hook.result.current.activeSessions.has('session-1')).toBe(true);

  await advance();
  await settle();
  expect(hook.result.current.activeSessions.size).toBe(0);

  await advance();
  await settle();
  expect(hook.result.current.activeSessions.has('session-1')).toBe(true);
  hook.unmount();
});
