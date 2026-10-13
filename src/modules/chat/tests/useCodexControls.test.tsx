import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useCodexControls } from '@/modules/chat/hooks/useCodexControls';
import { api } from '@/shared/api';
import { hydrateChatDrafts, readQueuedMessage, resetChatDrafts, writeQueuedMessage } from '@/shared/chatDrafts';
import type { CodexSessionState, ServerEvent } from '@/shared/types';

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
