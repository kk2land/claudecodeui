import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useProviderRuntimeControls } from '@/modules/chat/hooks/useProviderRuntimeControls';
import { api } from '@/shared/api';
import type { LLMProvider, Project, ProviderRuntimeState } from '@/shared/types';

const { workerPlugin } = vi.hoisted(() => ({ workerPlugin: { enabled: false } }));
vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [{ name: 'worker', enabled: workerPlugin.enabled }] }),
}));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilities: () => ({ dsh: { runtimeManagement: { modes: ['acp', 'headless'], stoppableModes: ['acp'] } } }),
}));
afterEach(() => {
  workerPlugin.enabled = false;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const project: Project = { projectId: 'project-1', displayName: 'Test', fullPath: '/tmp/project' };
const state: ProviderRuntimeState = {
  runtime: 'headless', phase: 'idle', queueHeld: false, supportsPermissionRequests: false,
  diagnostics: { running: false, pid: null, startedAt: null, launcherPath: null, cliVersion: null },
};
const response = (value = state) => new Response(JSON.stringify({ success: true, data: value }));

test('allocates one session before saving transport and does not send a model prompt', async () => {
  vi.spyOn(api.providers, 'runtimeState').mockResolvedValue(response());
  const create = vi.spyOn(api.providers, 'createSession').mockResolvedValue(new Response(JSON.stringify({ success: true, data: { sessionId: 'created' } })));
  const change = vi.spyOn(api.providers, 'controlRuntime').mockResolvedValue(response({ ...state, runtime: 'acp' }));
  const established = vi.fn();
  const hook = renderHook(() => useProviderRuntimeControls({ provider: 'dsh', sessionId: null, project, onSessionEstablished: established }));
  await waitFor(() => expect(hook.result.current.state?.runtime).toBe('headless'));
  await act(async () => {
    await Promise.all([hook.result.current.control({ action: 'runtime', runtime: 'acp' }), hook.result.current.control({ action: 'runtime', runtime: 'acp' })]);
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenCalledWith('dsh', 'created', { action: 'runtime', runtime: 'acp' });
  expect(established).toHaveBeenCalledWith('created', { provider: 'dsh', project, summary: '' });
  expect(hook.result.current.pending).toBe(false);
});

test('a late read cannot overwrite a successful transport change', async () => {
  let finishRead!: (value: Response) => void;
  vi.spyOn(api.providers, 'runtimeState').mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));
  vi.spyOn(api.providers, 'controlRuntime').mockResolvedValue(response({ ...state, runtime: 'acp' }));
  const hook = renderHook(() => useProviderRuntimeControls({ provider: 'dsh', sessionId: 'session-1', project, onSessionEstablished: vi.fn() }));
  await act(async () => { await hook.result.current.control({ action: 'runtime', runtime: 'acp' }); });
  await act(async () => { finishRead(response()); });
  expect(hook.result.current.state?.runtime).toBe('acp');
});

test('late responses cannot repaint another session and unsupported providers never fetch controls', async () => {
  let finishRead!: (value: Response) => void;
  const read = vi.spyOn(api.providers, 'runtimeState').mockImplementation((_provider, sessionId) => sessionId === 'session-1'
    ? new Promise((resolve) => { finishRead = resolve; }) : Promise.resolve(response({ ...state, runtime: 'acp' })));
  const hook = renderHook(({ provider, sessionId }: { provider: LLMProvider; sessionId: string }) =>
    useProviderRuntimeControls({ provider, sessionId, project, onSessionEstablished: vi.fn() }),
  { initialProps: { provider: 'dsh', sessionId: 'session-1' } });
  hook.rerender({ provider: 'dsh', sessionId: 'session-2' });
  await waitFor(() => expect(hook.result.current.state?.runtime).toBe('acp'));
  await act(async () => { finishRead(response()); });
  expect(hook.result.current.state?.runtime).toBe('acp');
  hook.rerender({ provider: 'codex', sessionId: 'session-3' });
  expect(hook.result.current.available).toBe(false);
  expect(hook.result.current.state).toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
});

test('failed stops report the server error and release pending state without pretending the process exited', async () => {
  vi.spyOn(api.providers, 'runtimeState').mockResolvedValue(response({ ...state, runtime: 'acp', diagnostics: { ...state.diagnostics, running: true, pid: 42 } }));
  vi.spyOn(api.providers, 'controlRuntime').mockResolvedValue(new Response(JSON.stringify({ success: false, error: { message: 'Still stopping.' } }), { status: 409 }));
  const hook = renderHook(() => useProviderRuntimeControls({ provider: 'dsh', sessionId: 'session-1', project, onSessionEstablished: vi.fn() }));
  await waitFor(() => expect(hook.result.current.state?.diagnostics.running).toBe(true));
  await act(async () => { await expect(hook.result.current.control({ action: 'stop' })).rejects.toThrow('Still stopping.'); });
  expect(hook.result.current.pending).toBe(false);
  expect(hook.result.current.error).toBe('Still stopping.');
  expect(hook.result.current.canRetryStop).toBe(true);
  expect(hook.result.current.state?.diagnostics.pid).toBe(42);
});

test('an idle process poll preserves a failed Worker stop until an explicit retry confirms cleanup', async () => {
  vi.useFakeTimers();
  let snapshot: ProviderRuntimeState = { ...state, runtime: 'acp', queueHeld: true, diagnostics: { ...state.diagnostics, running: true, pid: 42 } };
  vi.spyOn(api.providers, 'runtimeState').mockImplementation(async () => response(snapshot));
  const change = vi.spyOn(api.providers, 'controlRuntime')
    .mockResolvedValueOnce(Response.json({ success: false, error: { code: 'DSH_WORKER_STOP_UNCONFIRMED', message: 'Worker cleanup not confirmed.' } }, { status: 409 }))
    .mockImplementation(async () => response(snapshot));
  const hook = renderHook(() => useProviderRuntimeControls({ provider: 'dsh', sessionId: 'session-1', project, onSessionEstablished: vi.fn() }));
  await act(async () => { await expect(hook.result.current.control({ action: 'stop' })).rejects.toThrow('Worker cleanup not confirmed.'); });

  snapshot = { ...snapshot, diagnostics: { ...state.diagnostics, running: false, pid: null } };
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(hook.result.current.state?.diagnostics.running).toBe(false);
  expect(hook.result.current.error).toBe('Worker cleanup not confirmed.');
  expect(hook.result.current.canRetryStop).toBe(true);

  await act(async () => { await hook.result.current.control({ action: 'stop' }); });
  expect(change).toHaveBeenCalledTimes(2);
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.canRetryStop).toBe(false);
  expect(hook.result.current.state?.queueHeld).toBe(true);
  hook.unmount();
});

test('a runtime switch error never enables the Stop retry shortcut', async () => {
  vi.spyOn(api.providers, 'runtimeState').mockImplementation(async () => response({ ...state, runtime: 'acp' }));
  vi.spyOn(api.providers, 'controlRuntime').mockResolvedValue(Response.json({ success: false, error: 'Runtime change failed.' }, { status: 409 }));
  const hook = renderHook(() => useProviderRuntimeControls({ provider: 'dsh', sessionId: 'session-1', project, onSessionEstablished: vi.fn() }));
  await act(async () => { await expect(hook.result.current.control({ action: 'runtime', runtime: 'headless' })).rejects.toThrow('Runtime change failed.'); });
  expect(hook.result.current.error).toBe('Runtime change failed.');
  expect(hook.result.current.canRetryStop).toBe(false);
});

test('finishing a new-session action after navigation cannot navigate back to the old project', async () => {
  vi.spyOn(api.providers, 'runtimeState').mockImplementation(() => Promise.resolve(response()));
  vi.spyOn(api.providers, 'createSession').mockResolvedValue(new Response(JSON.stringify({ data: { sessionId: 'created' } })));
  let finish!: (value: Response) => void;
  const change = vi.spyOn(api.providers, 'controlRuntime').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const established = vi.fn();
  const hook = renderHook(({ selectedProject }) => useProviderRuntimeControls({
    provider: 'dsh', sessionId: null, project: selectedProject, onSessionEstablished: established,
  }), { initialProps: { selectedProject: project } });
  let action!: Promise<void>;
  act(() => { action = hook.result.current.control({ action: 'runtime', runtime: 'acp' }); });
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1));
  hook.rerender({ selectedProject: { ...project, projectId: 'another-project' } });
  await act(async () => { finish(response({ ...state, runtime: 'acp' })); await action; });
  expect(established).not.toHaveBeenCalled();
  expect(hook.result.current.state?.runtime).toBe('headless');
});

test('DSH ACP observes this session Worker activity and drops it on a session switch', async () => {
  workerPlugin.enabled = true;
  vi.spyOn(api.providers, 'runtimeState').mockImplementation(async () => response({ ...state, runtime: 'acp', workerEnabled: true }));
  const workerState = vi.spyOn(api.plugins, 'workerState').mockImplementation(async (_projectId, sessionId) => Response.json({
    workers: sessionId === 'session-1'
      ? [{ parentSessionId: 'session-1', projectId: 'project-1', latestRun: { status: 'stopping' } }]
      : [],
  }));
  const hook = renderHook(({ sessionId }: { sessionId: string }) => useProviderRuntimeControls({
    provider: 'dsh', sessionId, project, onSessionEstablished: vi.fn(),
  }), { initialProps: { sessionId: 'session-1' } });

  await waitFor(() => expect(hook.result.current.hasActiveWorkers).toBe(true));
  expect(workerState).toHaveBeenCalledWith('project-1', 'session-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));

  hook.rerender({ sessionId: 'session-2' });
  expect(hook.result.current.hasActiveWorkers).toBe(false);
  await waitFor(() => expect(workerState).toHaveBeenCalledWith('project-1', 'session-2', expect.any(Object)));
  expect(hook.result.current.hasActiveWorkers).toBe(false);
  hook.unmount();
});

test('headless and non-Worker ACP sessions never query Worker activity', async () => {
  workerPlugin.enabled = true;
  const workerState = vi.spyOn(api.plugins, 'workerState');
  vi.spyOn(api.providers, 'runtimeState').mockResolvedValue(response({ ...state, runtime: 'headless', workerEnabled: false }));
  const headless = renderHook(() => useProviderRuntimeControls({
    provider: 'dsh', sessionId: 'session-1', project, onSessionEstablished: vi.fn(),
  }));
  await waitFor(() => expect(headless.result.current.state?.runtime).toBe('headless'));
  await act(async () => { await Promise.resolve(); });
  expect(workerState).not.toHaveBeenCalled();
  expect(headless.result.current.hasActiveWorkers).toBe(false);
  headless.unmount();

  vi.spyOn(api.providers, 'runtimeState').mockResolvedValue(response({ ...state, runtime: 'acp', workerEnabled: false }));
  const nonWorker = renderHook(() => useProviderRuntimeControls({
    provider: 'dsh', sessionId: 'session-1', project, onSessionEstablished: vi.fn(),
  }));
  await waitFor(() => expect(nonWorker.result.current.state?.runtime).toBe('acp'));
  await act(async () => { await Promise.resolve(); });
  expect(workerState).not.toHaveBeenCalled();
  expect(nonWorker.result.current.hasActiveWorkers).toBe(false);
  nonWorker.unmount();
});

test('leaving the Chat tab pauses DSH Worker reads and returning refreshes activity', async () => {
  vi.useFakeTimers();
  workerPlugin.enabled = true;
  const read = vi.spyOn(api.providers, 'runtimeState').mockImplementation(async () => response({ ...state, runtime: 'acp', workerEnabled: true }));
  let workersActive = true;
  const workerState = vi.spyOn(api.plugins, 'workerState').mockImplementation(async () => Response.json({
    workers: workersActive ? [{ parentSessionId: 'session-1', projectId: 'project-1', latestRun: { status: 'running' } }] : [],
  }));
  const hook = renderHook(({ chatActive }) => useProviderRuntimeControls({
    provider: 'dsh', sessionId: 'session-1', project, chatActive, onSessionEstablished: vi.fn(),
  }), { initialProps: { chatActive: false } });

  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(read).toHaveBeenCalled();
  expect(hook.result.current.available).toBe(true);
  expect(workerState).not.toHaveBeenCalled();

  hook.rerender({ chatActive: true });
  await act(async () => {});
  expect(hook.result.current.hasActiveWorkers).toBe(true);
  expect(workerState).toHaveBeenCalledTimes(1);
  hook.rerender({ chatActive: false });
  expect(hook.result.current.hasActiveWorkers).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(workerState).toHaveBeenCalledTimes(1);

  workersActive = false;
  hook.rerender({ chatActive: true });
  await act(async () => {});
  expect(workerState).toHaveBeenCalledTimes(2);
  expect(hook.result.current.hasActiveWorkers).toBe(false);
  hook.unmount();
});

test('switching the DSH transport to headless clears Worker activity immediately', async () => {
  workerPlugin.enabled = true;
  vi.spyOn(api.providers, 'runtimeState').mockResolvedValue(response({ ...state, runtime: 'acp', workerEnabled: true }));
  vi.spyOn(api.plugins, 'workerState').mockResolvedValue(Response.json({
    workers: [{ parentSessionId: 'session-1', projectId: 'project-1', latestRun: { status: 'unknown' } }],
  }));
  vi.spyOn(api.providers, 'controlRuntime').mockResolvedValue(response({ ...state, runtime: 'headless', workerEnabled: false }));
  const hook = renderHook(() => useProviderRuntimeControls({
    provider: 'dsh', sessionId: 'session-1', project, onSessionEstablished: vi.fn(),
  }));

  await waitFor(() => expect(hook.result.current.hasActiveWorkers).toBe(true));
  await act(async () => { await hook.result.current.control({ action: 'runtime', runtime: 'headless' }); });
  expect(hook.result.current.state?.runtime).toBe('headless');
  expect(hook.result.current.hasActiveWorkers).toBe(false);
  hook.unmount();
});
