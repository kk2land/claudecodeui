import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useProviderRuntimeControls } from '@/modules/chat/hooks/useProviderRuntimeControls';
import { api } from '@/shared/api';
import type { LLMProvider, Project, ProviderRuntimeState } from '@/shared/types';

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilities: () => ({ dsh: { runtimeManagement: { modes: ['acp', 'headless'], stoppableModes: ['acp'] } } }),
}));
afterEach(() => { vi.restoreAllMocks(); });

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
  expect(hook.result.current.state?.diagnostics.pid).toBe(42);
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
