import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useCodexControls } from '@/modules/chat/hooks/useCodexControls';
import { api } from '@/shared/api';
import { hydrateChatDrafts, readQueuedMessage, resetChatDrafts, writeQueuedMessage } from '@/shared/chatDrafts';
import type { CodexSessionState, Project, ServerEvent } from '@/shared/types';

const { subscribe, workerPlugin } = vi.hoisted(() => ({
  subscribe: vi.fn(), workerPlugin: { enabled: false },
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [{ name: 'worker', enabled: workerPlugin.enabled }] }),
}));

afterEach(() => {
  workerPlugin.enabled = false;
  resetChatDrafts();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('the first remote model selection allocates a session and survives navigation to it', async () => {
  const listeners = new Set<(event: ServerEvent) => void>();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(Response.json({ success: true, data: { providers: [] } }));
  vi.spyOn(api.user, 'drafts').mockImplementation(async () => Response.json({ drafts: [] }));
  const create = vi.spyOn(api.providers, 'createSession').mockResolvedValue(Response.json({
    success: true, data: { sessionId: 'remote-model-session' },
  }));
  const modelSelection = { modelProvider: 'gateway', model: 'gateway/new-model' };
  const state: CodexSessionState = {
    runtime: 'app-server', mode: 'default', phase: 'idle', turnId: null, goal: null, questions: [], modelSelection,
  };
  const send = vi.fn((message) => queueMicrotask(() => {
    for (const listener of listeners) listener({ kind: 'control_result', sessionId: message.sessionId,
      requestId: message.requestId, ok: true, codexState: state } as ServerEvent);
  }));
  const established = vi.fn();
  const project = { projectId: 'project', fullPath: '/project' } as Project;
  const hook = renderHook(({ sessionId }: { sessionId: string | null }) => useCodexControls({
    enabled: true, sessionId, project, options: { model: 'builtin-model' },
    sendMessage: send, onSessionEstablished: established,
  }), { initialProps: { sessionId: null as string | null } });

  await act(async () => { await hook.result.current.control({ action: 'model-provider', ...modelSelection }); });
  expect(create).toHaveBeenCalledExactlyOnceWith({ provider: 'codex', projectPath: '/project', initialMessage: '' });
  expect(established).toHaveBeenCalledWith('remote-model-session', expect.objectContaining({ provider: 'codex', project }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'remote-model-session', control: { action: 'model-provider', ...modelSelection },
  }));

  hook.rerender({ sessionId: 'remote-model-session' });
  await waitFor(() => {
    expect(hook.result.current.state?.modelSelection).toEqual(modelSelection);
    expect(hook.result.current.pending).toBe(false);
  });
  expect(create).toHaveBeenCalledTimes(1);
});

test('reports Worker activity for the current native session', async () => {
  workerPlugin.enabled = true;
  const listeners = new Set<(event: ServerEvent) => void>();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(Response.json({ success: true, data: { providers: [] } }));
  vi.spyOn(api.user, 'drafts').mockImplementation(async () => Response.json({ drafts: [] }));
  const state: CodexSessionState = {
    runtime: 'app-server', mode: 'default', phase: 'idle', turnId: null, goal: null, questions: [],
  };
  const sendMessage = vi.fn((message) => queueMicrotask(() => {
    for (const listener of listeners) listener({ kind: 'control_result', sessionId: 'session-worker',
      requestId: message.requestId, ok: true, codexState: state } as ServerEvent);
  }));
  const workerState = vi.spyOn(api.plugins, 'workerState').mockResolvedValue(Response.json({
    workers: [{ parentSessionId: 'session-worker', projectId: 'project', latestRun: { status: 'running' } }],
  }));
  const hook = renderHook(() => useCodexControls({
    enabled: true, sessionId: 'session-worker',
    project: { projectId: 'project', fullPath: '/project' } as Project,
    options: {}, sendMessage, onSessionEstablished: () => {},
  }));
  await waitFor(() => expect(hook.result.current.hasActiveWorkers).toBe(true));
  expect(workerState).toHaveBeenCalledWith('project', 'session-worker', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  hook.unmount();
});

test('keeps native Codex state while the chat is inactive and starts Worker polling on resume', async () => {
  workerPlugin.enabled = true;
  const listeners = new Set<(event: ServerEvent) => void>();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(Response.json({ success: true, data: { providers: [] } }));
  vi.spyOn(api.user, 'drafts').mockImplementation(async () => Response.json({ drafts: [] }));
  const state: CodexSessionState = {
    runtime: 'app-server', mode: 'default', phase: 'running', turnId: 'turn-inactive', goal: null, questions: [],
  };
  const workerState = vi.spyOn(api.plugins, 'workerState').mockResolvedValue(Response.json({
    workers: [{ parentSessionId: 'session-inactive', projectId: 'project', latestRun: { status: 'running' } }],
  }));
  const sendMessage = vi.fn();
  const hook = renderHook(({ chatActive }: { chatActive: boolean }) => useCodexControls({
    enabled: true, sessionId: 'session-inactive', chatActive,
    project: { projectId: 'project', fullPath: '/project' } as Project,
    options: {}, sendMessage, onSessionEstablished: () => {},
  }), { initialProps: { chatActive: false } });

  expect(workerState).not.toHaveBeenCalled();
  act(() => {
    for (const listener of listeners) listener({
      kind: 'control_result', sessionId: 'session-inactive', requestId: 'manual', ok: true, codexState: state,
    } as ServerEvent);
  });
  await waitFor(() => expect(hook.result.current.state?.turnId).toBe('turn-inactive'));
  expect(workerState).not.toHaveBeenCalled();

  hook.rerender({ chatActive: true });
  await waitFor(() => expect(hook.result.current.hasActiveWorkers).toBe(true));
  expect(workerState).toHaveBeenCalledWith('project', 'session-inactive', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  hook.unmount();
});

test('restores controls and assigns a persisted steer ID without native randomUUID', async () => {
  localStorage.clear();
  resetChatDrafts();
  vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
    new Response(JSON.stringify({ drafts: [] }), { status: 200 }),
  )));
  const listeners = new Set<(event: ServerEvent) => void>();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  const state: CodexSessionState = {
    runtime: 'app-server', mode: 'default', phase: 'running', turnId: 'turn-1', goal: null, questions: [],
  };
  const sendMessage = vi.fn((message) => {
    queueMicrotask(() => {
      const event = {
        kind: 'control_result', sessionId: 'session-http', requestId: message.requestId, ok: true, codexState: state,
      } as ServerEvent;
      for (const listener of listeners) listener(event);
    });
  });
  const saved = vi.spyOn(api.user, 'saveDraft');
  const hook = renderHook(() => useCodexControls({
    enabled: true, sessionId: 'session-http', project: null, options: {}, sendMessage, onSessionEstablished: () => {},
  }));
  await waitFor(() => {
    expect(hook.result.current.state?.turnId).toBe('turn-1');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(hook.result.current.pending).toBe(false);
  });
  expect(hook.result.current.goalsEnabled).toBe(false);
  await act(async () => {
    await expect(hook.result.current.control({ action: 'goal', operation: 'set', objective: 'disabled' })).rejects.toThrow('disabled');
  });
  expect(sendMessage.mock.calls.filter(([message]) => message.control.action === 'goal')
    .map(([message]) => message.control.operation)).toEqual(['get']);

  // Older persisted drafts have no ID; steering must save one before sending it.
  await act(async () => { writeQueuedMessage('session-http', { content: 'queued guidance' }); });
  await act(async () => { await hook.result.current.steer(); });

  const steer = sendMessage.mock.calls.find(([message]) => message.control.action === 'steer')?.[0];
  expect(steer?.control.messageId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  expect(saved).toHaveBeenCalledWith('session-http', expect.objectContaining({
    queuedMessages: [expect.objectContaining({ id: steer.control.messageId, content: 'queued guidance' })],
  }));
  const requestIds = sendMessage.mock.calls.map(([message]) => message.requestId);
  expect(new Set(requestIds).size).toBe(requestIds.length);
  for (const id of requestIds) {
    expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  }
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.pending).toBe(false);
});

test.each(['mount', 'reconnect'])('reconciles persisted steer receipts on %s with Goals disabled', async (trigger) => {
  localStorage.clear();
  resetChatDrafts();
  const sessionId = 'session-recovery';
  let unknown = trigger === 'mount';
  let pauseRestore = unknown;
  let confirmRestore: (() => void) | undefined;
  vi.spyOn(api.user, 'drafts').mockImplementation(async () => new Response(JSON.stringify({
    drafts: unknown ? [{ scope: sessionId, text: '', queuedMessage: { id: 'queued-message', content: 'already delivered' },
      queuedDelivery: { status: 'unknown', requestId: 'lost-receipt', error: 'Confirmation pending.' } }] : [],
  }), { status: 200 }));
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(new Response(JSON.stringify({
    success: true, data: { providers: [{ provider: 'codex', nativeControls: { goal: false } }] },
  }), { status: 200 }));
  await hydrateChatDrafts();

  const listeners = new Set<(event: ServerEvent) => void>();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  const state: CodexSessionState = {
    runtime: 'app-server', mode: 'default', phase: 'idle', turnId: null, goal: null, questions: [],
  };
  const sendMessage = vi.fn((message) => {
    const restoring = message.control.action === 'goal' && message.control.operation === 'get';
    const acknowledge = () => {
      if (restoring) unknown = false;
      const event = { kind: 'control_result', sessionId, requestId: message.requestId, ok: true, codexState: state } as ServerEvent;
      for (const listener of listeners) listener(event);
    };
    // The server only removes an uncertain draft once history proves delivery.
    if (restoring && pauseRestore) confirmRestore = acknowledge;
    else queueMicrotask(acknowledge);
  });
  const hook = renderHook(() => useCodexControls({
    enabled: true, sessionId, project: null, options: {}, sendMessage, onSessionEstablished: () => {},
  }));
  if (trigger === 'reconnect') {
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(hook.result.current.pending).toBe(false);
    });
    unknown = true;
    pauseRestore = true;
    sendMessage.mockClear();
    await act(async () => { await hydrateChatDrafts(); });
    act(() => { for (const listener of listeners) listener({ kind: 'websocket_reconnected' } as ServerEvent); });
  }

  await waitFor(() => expect(confirmRestore).toBeTypeOf('function'));
  expect(hook.result.current.goalsEnabled).toBe(false);
  expect(hook.result.current.delivery?.status).toBe('unknown');
  expect(hook.result.current.pending).toBe(true);
  await act(async () => { confirmRestore!(); });
  await waitFor(() => {
    expect(hook.result.current.pending).toBe(false);
    expect(hook.result.current.delivery).toBeNull();
    expect(readQueuedMessage(sessionId)).toBeNull();
  });
  expect(sendMessage.mock.calls.map(([message]) => message.control)).toEqual([
    { action: 'state' }, { action: 'goal', operation: 'get' },
  ]);
});

test.each(['provider', 'project'])('ignores a pending session allocation after switching %s', async (scope) => {
  const listeners = new Set<(event: ServerEvent) => void>();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(Response.json({ success: true, data: { providers: [] } }));
  vi.spyOn(api.user, 'drafts').mockImplementation(async () => Response.json({ drafts: [] }));
  let finish!: (response: Response) => void;
  vi.spyOn(api.providers, 'createSession').mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const established = vi.fn();
  const send = vi.fn((message) => queueMicrotask(() => {
    for (const listener of listeners) listener({ kind: 'control_result', sessionId: message.sessionId,
      requestId: message.requestId, ok: true } as ServerEvent);
  }));
  const hook = renderHook(({ enabled, projectId }: { enabled: boolean; projectId: string }) => useCodexControls({
    enabled, sessionId: null, project: { projectId, fullPath: `/${projectId}` } as Project,
    options: {}, sendMessage: send, onSessionEstablished: established,
  }), { initialProps: { enabled: true, projectId: 'first' } });
  let outcome!: Promise<unknown>;
  act(() => { outcome = hook.result.current.control({ action: 'mode', mode: 'plan' }).catch((error) => error); });
  hook.rerender({ enabled: scope !== 'provider', projectId: scope === 'project' ? 'second' : 'first' });
  const pendingAfterSwitch = hook.result.current.pending;
  await act(async () => {
    finish(Response.json({ success: true, data: { sessionId: 'stale-session' } }));
    await outcome;
  });
  hook.unmount();

  expect(pendingAfterSwitch).toBe(false);
  expect(await outcome).toBeInstanceOf(Error);
  expect(established).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('returning to Codex allocates a fresh session and a stale response cannot clear its pending state', async () => {
  const listeners = new Set<(event: ServerEvent) => void>();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(Response.json({ success: true, data: { providers: [] } }));
  vi.spyOn(api.user, 'drafts').mockImplementation(async () => Response.json({ drafts: [] }));
  const completions: Array<(response: Response) => void> = [];
  const create = vi.spyOn(api.providers, 'createSession').mockImplementation(() => new Promise<Response>((resolve) => { completions.push(resolve); }));
  const established = vi.fn();
  const send = vi.fn((message) => queueMicrotask(() => {
    for (const listener of listeners) listener({ kind: 'control_result', sessionId: message.sessionId,
      requestId: message.requestId, ok: true } as ServerEvent);
  }));
  const project = { projectId: 'project', fullPath: '/project' } as Project;
  const hook = renderHook(({ enabled }: { enabled: boolean }) => useCodexControls({
    enabled, sessionId: null, project, options: {}, sendMessage: send, onSessionEstablished: established,
  }), { initialProps: { enabled: true } });
  let first!: Promise<unknown>;
  let second!: Promise<unknown>;
  act(() => { first = hook.result.current.control({ action: 'mode', mode: 'plan' }).catch((error) => error); });
  hook.rerender({ enabled: false });
  hook.rerender({ enabled: true });
  act(() => { second = hook.result.current.control({ action: 'mode', mode: 'plan' }).catch((error) => error); });
  await act(async () => {
    completions[0](Response.json({ success: true, data: { sessionId: 'stale-session' } }));
    await first;
  });
  const pendingAfterStaleResponse = hook.result.current.pending;
  await act(async () => {
    completions[1]?.(Response.json({ success: true, data: { sessionId: 'current-session' } }));
    await second;
  });
  hook.unmount();

  expect(create).toHaveBeenCalledTimes(2);
  expect(await first).toBeInstanceOf(Error);
  expect(pendingAfterStaleResponse).toBe(true);
  expect(established).toHaveBeenCalledTimes(1);
  expect(send.mock.calls.map(([message]) => message.sessionId)).toEqual(['current-session']);
});

async function setupStopAlerts() {
  const listeners = new Set<(event: ServerEvent) => void>();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  vi.spyOn(api.providers, 'capabilities').mockResolvedValue(Response.json({ success: true, data: { providers: [] } }));
  vi.spyOn(api.user, 'drafts').mockImplementation(async () => Response.json({ drafts: [] }));
  const state: CodexSessionState = {
    runtime: 'app-server', mode: 'default', phase: 'running', turnId: 'turn-1', goal: null, questions: [],
  };
  const respond = (message: { sessionId: string; requestId: string }, ok = true, error?: string) => {
    for (const listener of listeners) listener({ kind: 'control_result', sessionId: message.sessionId,
      requestId: message.requestId, ok, ...(ok ? {} : { error }), codexState: state } as ServerEvent);
  };
  const sendMessage = vi.fn((message) => queueMicrotask(() => respond(message)));
  const hook = renderHook(() => useCodexControls({
    enabled: true, sessionId: 'session-stop', project: null, options: {}, sendMessage, onSessionEstablished: () => {},
  }));
  await waitFor(() => {
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(hook.result.current.pending).toBe(false);
  });
  const emit = (event: ServerEvent) => act(() => {
    for (const listener of listeners) listener({ sessionId: 'session-stop', ...event } as ServerEvent);
  });
  return { hook, emit, sendMessage, respond };
}

test('an uncertain stop alert clears only after a clean native idle snapshot', async () => {
  const { hook, emit } = await setupStopAlerts();
  const stopFailed: CodexSessionState = {
    runtime: 'app-server', mode: 'default', phase: 'stopFailed', turnId: 'turn-1', error: 'old', goal: null, questions: [],
  };
  emit({ kind: 'control_result', requestId: 'stop-1', ok: false, error: 'Stop has not been confirmed.', code: 'STOP_NOT_CONFIRMED', codexState: stopFailed });
  expect(hook.result.current.error).toBe('Stop has not been confirmed.');
  emit({ kind: 'status', text: 'codex_control', codexState: { ...stopFailed, phase: 'stopping' } });
  expect(hook.result.current.error).toBe('Stop has not been confirmed.');
  emit({ kind: 'complete', stopping: true });
  expect(hook.result.current.error).toBe('Stop has not been confirmed.');
  // Another session's clean idle must not retire this session's Stop alert.
  emit({ sessionId: 'session-other', kind: 'status', text: 'codex_control', codexState: { ...stopFailed, phase: 'idle', error: undefined } });
  expect(hook.result.current.error).toBe('Stop has not been confirmed.');
  emit({ kind: 'status', text: 'codex_control', codexState: { ...stopFailed, phase: 'idle', error: undefined } });
  expect(hook.result.current.error).toBeNull();
});

test('a failed process stop stays retryable after native idle until a retry succeeds', async () => {
  const { hook, emit, sendMessage, respond } = await setupStopAlerts();
  sendMessage.mockImplementation((message) => queueMicrotask(() => respond(message, false, 'Worker cleanup not confirmed.')));
  await act(async () => {
    await expect(hook.result.current.control({ action: 'stop-app-server' })).rejects.toThrow('Worker cleanup not confirmed.');
  });
  emit({ kind: 'status', codexState: { runtime: 'app-server', mode: 'default', phase: 'idle', turnId: null, goal: null, questions: [] } });
  expect(hook.result.current.hasActiveWorkers).toBe(false);
  expect(hook.result.current.canRetryStop).toBe(true);
  expect(hook.result.current.error).toBe('Worker cleanup not confirmed.');
  sendMessage.mockImplementation((message) => queueMicrotask(() => respond(message)));
  await act(async () => { await hook.result.current.control({ action: 'stop-app-server' }); });
  expect(hook.result.current.canRetryStop).toBe(false);
  expect(hook.result.current.error).toBeNull();
});

test('a failure response already carrying recovered idle does not rewrite the stop alert', async () => {
  const { hook, emit } = await setupStopAlerts();
  const idle: CodexSessionState = {
    runtime: 'app-server', mode: 'default', phase: 'idle', turnId: null, error: undefined, goal: null, questions: [],
  };
  emit({ kind: 'control_result', requestId: 'stop-2', ok: false, error: 'Stop has not been confirmed.', code: 'STOP_NOT_CONFIRMED', codexState: idle });
  expect(hook.result.current.error).toBeNull();
});

test('unconfirmed stop and unrelated control failures survive non-idle or dirty idle snapshots', async () => {
  const { hook, emit } = await setupStopAlerts();
  const stopFailed: CodexSessionState = {
    runtime: 'app-server', mode: 'default', phase: 'stopFailed', turnId: 'turn-1', error: 'native stop failed', goal: null, questions: [],
  };
  emit({ kind: 'control_result', requestId: 'stop-3', ok: false, error: 'Stop has not been confirmed.', code: 'STOP_NOT_CONFIRMED', codexState: stopFailed });
  emit({ kind: 'status', text: 'codex_control', codexState: { ...stopFailed, phase: 'idle', error: 'still failing' } });
  expect(hook.result.current.error).toBe('Stop has not been confirmed.');
  emit({ kind: 'status', text: 'codex_control', codexState: stopFailed });
  expect(hook.result.current.error).toBe('Stop has not been confirmed.');

  // A later non-Stop failure replaces the alert and must not be retired by idle.
  emit({ kind: 'control_result', requestId: 'model-1', ok: false, error: 'Model switch failed', codexState: stopFailed });
  emit({ kind: 'status', text: 'codex_control', codexState: { ...stopFailed, phase: 'idle', error: undefined } });
  expect(hook.result.current.error).toBe('Model switch failed');

});

test('a timed-out control clears on a late success for the same session only', async () => {
  const { hook, sendMessage, respond } = await setupStopAlerts();
  sendMessage.mockImplementation(() => {});
  sendMessage.mockClear();
  vi.useFakeTimers();
  let outcome!: Promise<unknown>;
  act(() => { outcome = hook.result.current.control({ action: 'mode', mode: 'plan' }).catch((error) => error); });
  await act(async () => { await Promise.resolve(); });
  const request = sendMessage.mock.calls.at(-1)![0];

  await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
  expect(hook.result.current.error).toBe('Confirmation pending. Reconnect to check the saved state.');
  expect(hook.result.current.pending).toBe(false);

  // Another session's receipt must not retire this session's timeout alert.
  act(() => { respond({ sessionId: 'session-other', requestId: request.requestId }, true); });
  expect(hook.result.current.error).toBe('Confirmation pending. Reconnect to check the saved state.');

  act(() => { respond({ sessionId: 'session-stop', requestId: request.requestId }, true); });
  expect(hook.result.current.error).toBeNull();
  expect(await outcome).toBeInstanceOf(Error);
  hook.unmount();
  vi.useRealTimers();
});

test('a timed-out control is replaced by a late failure for the same session', async () => {
  const { hook, sendMessage, respond } = await setupStopAlerts();
  sendMessage.mockImplementation(() => {});
  sendMessage.mockClear();
  vi.useFakeTimers();
  let outcome!: Promise<unknown>;
  act(() => { outcome = hook.result.current.control({ action: 'mode', mode: 'plan' }).catch((error) => error); });
  await act(async () => { await Promise.resolve(); });
  const request = sendMessage.mock.calls.at(-1)![0];

  await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
  expect(hook.result.current.error).toBe('Confirmation pending. Reconnect to check the saved state.');

  act(() => { respond({ sessionId: 'session-stop', requestId: request.requestId }, false, 'Model switch failed'); });
  expect(hook.result.current.error).toBe('Model switch failed');
  expect(hook.result.current.pending).toBe(false);
  expect(await outcome).toBeInstanceOf(Error);
  hook.unmount();
  vi.useRealTimers();
});

test('a later reconnect refresh supersedes an unanswered automatic sync', async () => {
  const { hook, emit, sendMessage, respond } = await setupStopAlerts();
  sendMessage.mockClear();
  vi.useFakeTimers();
  // The first reconnect's state receipt is lost, leaving its automatic sync pending.
  sendMessage.mockImplementation(() => {});
  act(() => { emit({ kind: 'websocket_reconnected' }); });
  await act(async () => { await Promise.resolve(); });
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(hook.result.current.pending).toBe(true);

  // A second reconnect reconciles successfully; the first deadline must stay silent.
  sendMessage.mockImplementation((message) => { queueMicrotask(() => respond(message)); });
  act(() => { emit({ kind: 'websocket_reconnected' }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(hook.result.current.pending).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.pending).toBe(false);
  hook.unmount();
  vi.useRealTimers();
});

test('an unconfirmed user control is not cleared by a successful automatic refresh', async () => {
  const { hook, emit, sendMessage, respond } = await setupStopAlerts();
  sendMessage.mockClear();
  vi.useFakeTimers();
  sendMessage.mockImplementation(() => {});
  let outcome!: Promise<unknown>;
  act(() => { outcome = hook.result.current.control({ action: 'mode', mode: 'plan' }).catch((error) => error); });
  await act(async () => { await Promise.resolve(); });
  expect(hook.result.current.pending).toBe(true);

  sendMessage.mockImplementation((message) => { queueMicrotask(() => respond(message)); });
  act(() => { emit({ kind: 'websocket_reconnected' }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.pending).toBe(true);

  await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
  expect(hook.result.current.error).toBe('Confirmation pending. Reconnect to check the saved state.');
  expect(hook.result.current.pending).toBe(false);
  expect(await outcome).toBeInstanceOf(Error);
  hook.unmount();
  vi.useRealTimers();
});
