import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useCodexControls } from '@/modules/chat/hooks/useCodexControls';
import { api } from '@/shared/api';
import type { Project, ServerEvent } from '@/shared/types';

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
afterEach(() => { vi.restoreAllMocks(); });

test('GPT Web allocates its own provider session before forwarding native plan controls', async () => {
  const listeners = new Set<(event: ServerEvent) => void>();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener); return () => listeners.delete(listener);
  });
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(Response.json({ success: true, data: { providers: [
    { provider: 'gptweb', nativeControls: { goal: false, plan: true, steer: true } },
  ] } }));
  vi.spyOn(api.user, 'drafts').mockImplementation(async () => Response.json({ drafts: [] }));
  const create = vi.spyOn(api.providers, 'createSession').mockResolvedValue(Response.json({
    success: true, data: { sessionId: 'web-session', sessionName: 'Web task' },
  }));
  const established = vi.fn();
  const send = vi.fn(message => queueMicrotask(() => {
    for (const listener of listeners) listener({ kind: 'control_result', sessionId: 'web-session',
      requestId: message.requestId, ok: true } as ServerEvent);
  }));
  const hook = renderHook(() => useCodexControls({ provider: 'gptweb', enabled: true, sessionId: null,
    project: { projectId: 'project', fullPath: '/project' } as Project, options: {}, sendMessage: send, onSessionEstablished: established }));
  await act(async () => { await hook.result.current.control({ action: 'mode', mode: 'plan' }); });
  expect(create).toHaveBeenCalledWith({ provider: 'gptweb', projectPath: '/project', initialMessage: '' });
  expect(established).toHaveBeenCalledWith('web-session', expect.objectContaining({ provider: 'gptweb' }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'web-session', control: { action: 'mode', mode: 'plan' } }));
  expect(hook.result.current.pending).toBe(false);
  hook.unmount();
});

test('switching providers during session creation never reuses the previous request', async () => {
  const listeners = new Set<(event: ServerEvent) => void>();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener); return () => listeners.delete(listener);
  });
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(Response.json({ success: true, data: { providers: [] } }));
  vi.spyOn(api.user, 'drafts').mockImplementation(async () => Response.json({ drafts: [] }));
  let finishWeb!: (response: Response) => void;
  const webResponse = new Promise<Response>(resolve => { finishWeb = resolve; });
  const create = vi.spyOn(api.providers, 'createSession').mockImplementationOnce(() => webResponse)
    .mockResolvedValueOnce(Response.json({ success: true, data: { sessionId: 'codex-session' } }));
  const established = vi.fn();
  const send = vi.fn(message => queueMicrotask(() => {
    for (const listener of listeners) listener({ kind: 'control_result', sessionId: message.sessionId,
      requestId: message.requestId, ok: true } as ServerEvent);
  }));
  const project = { projectId: 'project', fullPath: '/project' } as Project;
  const hook = renderHook(({ provider }: { provider: 'codex' | 'gptweb' }) => useCodexControls({ provider,
    enabled: true, sessionId: null, project, options: {}, sendMessage: send, onSessionEstablished: established,
  }), { initialProps: { provider: 'gptweb' } });
  let webControl!: Promise<void>;
  let codexControl!: Promise<void>;
  // Attach the rejection handler before resolving the now-stale Web request.
  let webResult!: Promise<unknown>;
  act(() => {
    webControl = hook.result.current.control({ action: 'mode', mode: 'plan' });
    webResult = webControl.catch(error => error);
  });
  hook.rerender({ provider: 'codex' });
  act(() => { codexControl = hook.result.current.control({ action: 'mode', mode: 'plan' }); });
  try {
    expect(create.mock.calls.map(([input]) => input.provider)).toEqual(['gptweb', 'codex']);
    await act(async () => { await codexControl; });
  } finally {
    await act(async () => {
      finishWeb(Response.json({ success: true, data: { sessionId: 'web-session' } }));
      await Promise.allSettled([webResult, codexControl]);
    });
    hook.unmount();
  }
  expect(await webResult).toBeInstanceOf(Error);
  expect(established).toHaveBeenCalledTimes(1);
  expect(established).toHaveBeenCalledWith('codex-session', expect.objectContaining({ provider: 'codex' }));
  expect(send.mock.calls.map(([message]) => message.sessionId)).toEqual(['codex-session']);
});
