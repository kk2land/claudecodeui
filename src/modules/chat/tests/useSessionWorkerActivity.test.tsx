import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useSessionWorkerActivity } from '@/modules/chat/hooks/useSessionWorkerActivity';
import { api } from '@/shared/api';

const { pluginState } = vi.hoisted(() => ({ pluginState: { enabled: true } }));
vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [{ name: 'worker', enabled: pluginState.enabled }] }),
}));

type WorkerStatus = 'queued' | 'starting' | 'running' | 'stopping' | 'unknown'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted';

const ARGS = { enabled: true, native: true, chatActive: true, projectId: 'project-1', sessionId: 'session-1' };
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

function worker(status: WorkerStatus, patch: Record<string, unknown> = {}) {
  return { parentSessionId: 'session-1', projectId: 'project-1', latestRun: { status }, ...patch };
}

function state(workers: Array<Record<string, unknown>>) {
  return Response.json({ workers });
}

/** Lets the state read, JSON parse and React updates settle before asserting. */
async function settle() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

async function advance(milliseconds = 2000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

test.each(['starting', 'running', 'stopping', 'unknown'] as const)(
  'a %s Worker marks the current session active',
  async (status) => {
    const workerState = vi.spyOn(api.plugins, 'workerState').mockResolvedValue(state([worker(status)]));
    const hook = renderHook(() => useSessionWorkerActivity(ARGS));
    await settle();
    expect(workerState).toHaveBeenCalledWith('project-1', 'session-1', expect.any(Object));
    expect(hook.result.current).toBe(true);
    hook.unmount();
  },
);

test.each(['queued', 'completed', 'failed', 'cancelled', 'interrupted'] as const)(
  'a %s Worker does not mark the session active',
  async (status) => {
    vi.spyOn(api.plugins, 'workerState').mockResolvedValue(state([worker(status)]));
    const hook = renderHook(() => useSessionWorkerActivity(ARGS));
    await settle();
    expect(hook.result.current).toBe(false);
    hook.unmount();
  },
);

test('records for another project or parent session never light this button', async () => {
  vi.spyOn(api.plugins, 'workerState').mockResolvedValue(state([
    worker('running', { projectId: 'project-other' }),
    worker('running', { parentSessionId: 'session-other' }),
    worker('running', { latestRun: null }),
  ]));
  const hook = renderHook(() => useSessionWorkerActivity(ARGS));
  await settle();
  expect(hook.result.current).toBe(false);
  hook.unmount();
});

test.each([
  ['Worker plugin disabled', { ...ARGS }, false],
  ['Codex not selected', { ...ARGS, enabled: false }, true],
  ['SDK runtime', { ...ARGS, native: false }, true],
  ['missing project', { ...ARGS, projectId: null }, true],
  ['missing session', { ...ARGS, sessionId: null }, true],
  ['inactive chat', { ...ARGS, chatActive: false }, true],
] as const)('does not query when %s', async (_label, args, pluginEnabled) => {
  pluginState.enabled = pluginEnabled;
  const workerState = vi.spyOn(api.plugins, 'workerState');
  const hook = renderHook(() => useSessionWorkerActivity(args));
  await settle();
  expect(workerState).not.toHaveBeenCalled();
  expect(hook.result.current).toBe(false);
  hook.unmount();
});

test('a failed read hides the previous activity and the next poll recovers', async () => {
  const workerState = vi.spyOn(api.plugins, 'workerState')
    .mockResolvedValueOnce(state([worker('running')]))
    .mockRejectedValueOnce(new Error('plugin unavailable'))
    .mockResolvedValueOnce(state([worker('running')]));
  const hook = renderHook(() => useSessionWorkerActivity(ARGS));
  await settle();
  expect(hook.result.current).toBe(true);

  await advance();
  await settle();
  expect(hook.result.current).toBe(false);
  expect(workerState).toHaveBeenCalledTimes(2);

  await advance();
  await settle();
  expect(hook.result.current).toBe(true);
  expect(workerState).toHaveBeenCalledTimes(3);
  hook.unmount();
});

test('HTTP failures also hide activity instead of throwing into chat', async () => {
  vi.spyOn(api.plugins, 'workerState')
    .mockResolvedValueOnce(state([worker('running')]))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'failed' }), { status: 503 }));
  const hook = renderHook(() => useSessionWorkerActivity(ARGS));
  await settle();
  expect(hook.result.current).toBe(true);
  await advance();
  await settle();
  expect(hook.result.current).toBe(false);
  hook.unmount();
});

test('switching sessions invalidates the old scope and ignores its late response', async () => {
  let resolveLate!: (response: Response) => void;
  const late = new Promise<Response>((resolve) => { resolveLate = resolve; });
  const workerState = vi.spyOn(api.plugins, 'workerState')
    .mockResolvedValueOnce(state([worker('running')]));
  const hook = renderHook((props: typeof ARGS) => useSessionWorkerActivity(props), { initialProps: ARGS });
  await settle();
  expect(hook.result.current).toBe(true);

  workerState.mockImplementationOnce(() => late)
    .mockImplementation(async () => state([]));
  await advance();
  hook.rerender({ ...ARGS, sessionId: 'session-2' });
  expect(hook.result.current).toBe(false);
  await settle();
  expect(hook.result.current).toBe(false);

  await act(async () => { resolveLate(state([worker('running')])); });
  await settle();
  expect(hook.result.current).toBe(false);
  expect(workerState).toHaveBeenLastCalledWith('project-1', 'session-2', expect.any(Object));
  hook.unmount();
});

test('pausing an inactive chat stops polling and resuming reads immediately without stacking loops', async () => {
  const workerState = vi.spyOn(api.plugins, 'workerState')
    .mockImplementation(async () => state([worker('running')]));
  const hook = renderHook((props: typeof ARGS) => useSessionWorkerActivity(props), {
    initialProps: { ...ARGS, chatActive: true },
  });
  await settle();
  expect(workerState).toHaveBeenCalledTimes(1);
  expect(hook.result.current).toBe(true);

  hook.rerender({ ...ARGS, chatActive: false });
  await settle();
  expect(hook.result.current).toBe(false);
  await advance(6000);
  expect(workerState).toHaveBeenCalledTimes(1);

  // No visibility listener survives while the chat is paused, so a tab-level
  // foreground event cannot start a second loop.
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await settle();
  expect(workerState).toHaveBeenCalledTimes(1);

  hook.rerender({ ...ARGS, chatActive: true });
  await settle();
  expect(workerState).toHaveBeenCalledTimes(2);
  expect(hook.result.current).toBe(true);

  // Repeated pause/resume keeps exactly one poll loop alive.
  hook.rerender({ ...ARGS, chatActive: false });
  await settle();
  await advance(4000);
  expect(workerState).toHaveBeenCalledTimes(2);
  hook.rerender({ ...ARGS, chatActive: true });
  await settle();
  expect(workerState).toHaveBeenCalledTimes(3);
  await advance();
  await settle();
  expect(workerState).toHaveBeenCalledTimes(4);
  hook.unmount();
});

test('deactivating aborts an in-flight read and its late response cannot override the resumed scope', async () => {
  let resolveLate!: (response: Response) => void;
  const late = new Promise<Response>((resolve) => { resolveLate = resolve; });
  let pendingSignal: AbortSignal | null | undefined;
  const workerState = vi.spyOn(api.plugins, 'workerState')
    .mockResolvedValueOnce(state([worker('running')]));
  const hook = renderHook((props: typeof ARGS) => useSessionWorkerActivity(props), {
    initialProps: { ...ARGS, chatActive: true },
  });
  await settle();
  expect(hook.result.current).toBe(true);

  workerState.mockImplementationOnce((_projectId, _sessionId, options) => {
    pendingSignal = options?.signal;
    return late;
  }).mockImplementation(async () => state([]));
  await advance();
  expect(workerState).toHaveBeenCalledTimes(2);

  hook.rerender({ ...ARGS, chatActive: false });
  await settle();
  expect(hook.result.current).toBe(false);
  expect(pendingSignal?.aborted).toBe(true);

  hook.rerender({ ...ARGS, chatActive: true });
  await settle();
  expect(workerState).toHaveBeenCalledTimes(3);
  expect(workerState).toHaveBeenLastCalledWith('project-1', 'session-1', expect.any(Object));
  expect(hook.result.current).toBe(false);

  await act(async () => { resolveLate(state([worker('running')])); });
  await settle();
  expect(hook.result.current).toBe(false);
  expect(workerState).toHaveBeenCalledTimes(3);
  hook.unmount();
});

test('pauses while the page is hidden and refreshes immediately when visible', async () => {
  const workerState = vi.spyOn(api.plugins, 'workerState')
    .mockImplementation(async () => state([worker('running')]));
  const hook = renderHook(() => useSessionWorkerActivity(ARGS));
  await settle();
  expect(workerState).toHaveBeenCalledTimes(1);

  pageHidden = true;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await advance();
  expect(workerState).toHaveBeenCalledTimes(1);

  pageHidden = false;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await settle();
  expect(workerState).toHaveBeenCalledTimes(2);
  expect(hook.result.current).toBe(true);
  hook.unmount();
});

test('unmounting stops polling', async () => {
  const workerState = vi.spyOn(api.plugins, 'workerState').mockResolvedValue(state([worker('running')]));
  const hook = renderHook(() => useSessionWorkerActivity(ARGS));
  await settle();
  expect(hook.result.current).toBe(true);
  hook.unmount();
  await advance();
  expect(workerState).toHaveBeenCalledTimes(1);
});

test('the plugin state helper encodes both scope parameters', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ workers: [] }));
  vi.stubGlobal('fetch', fetchMock);
  await api.plugins.workerState('project id', 'session&1');
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    '/api/plugins/worker/rpc/state?projectId=project+id&parentSessionId=session%261',
  );
  vi.unstubAllGlobals();
});
