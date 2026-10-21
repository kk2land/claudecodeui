import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useCodexControls } from '@/modules/chat/hooks/useCodexControls';
import { api } from '@/shared/api';
import { hydrateChatDrafts, readQueuedMessage, resetChatDrafts, writeQueuedMessage } from '@/shared/chatDrafts';
import type { CodexSessionState, Project, ServerEvent } from '@/shared/types';

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));

afterEach(() => {
  resetChatDrafts();
  vi.unstubAllGlobals();
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
    queuedMessage: expect.objectContaining({ id: steer.control.messageId, content: 'queued guidance' }),
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
