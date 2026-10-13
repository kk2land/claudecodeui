import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ChatMessage, NormalizedMessage, ProjectSession } from '@/shared/types';

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { providers: {
    sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    sessionTokenUsage: async () => ({ ok: false }),
  } },
}));
vi.mock('@/shared/selectedProvider', () => ({ readSelectedProvider: () => 'codex' }));

const SESSION = { id: 'session-1' } as ProjectSession;
const SENT_AT = '2026-10-13T11:59:35.000Z';
const ACK_AT = '2026-10-13T11:59:37.000Z';

const prompt = (id = 'client-message-1'): ChatMessage => ({
  id, type: 'user', content: 'Explain how to reproduce it', timestamp: new Date(SENT_AT),
  images: [{ path: '/tmp/screenshot.png' }],
  files: [{ path: '/tmp/notes.txt', name: 'notes.txt' }],
});

const echo = (id = 'client-message-1'): NormalizedMessage => ({
  id, clientMessageId: id, sessionId: SESSION.id, provider: 'codex', kind: 'text', role: 'user',
  content: prompt().content, timestamp: ACK_AT,
  images: prompt().images, files: prompt().files,
});

function renderChat(selectedSession: ProjectSession | null = SESSION) {
  const sendMessage = vi.fn();
  const resetStreamingState = vi.fn();
  return renderHook(({ session }) => {
    const store = useSessionStore();
    const chat = useChatSessionState({
      isActive: true, selectedProject: null, selectedSession: session,
      ws: null, sendMessage, resetStreamingState,
      statusCheckSentAtRef: { current: new Map() },
      lastSeqRef: { current: new Map() },
      sessionStore: store,
    });
    return { chat, store };
  }, { initialProps: { session: selectedSession } });
}

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue({
    ok: true, json: async () => ({ data: { messages: [], total: 0, hasMore: false } }),
  });
});

test('native user snapshots and reconnect replay update the original bubble, then history takes over', async () => {
  const { result } = renderChat();
  act(() => result.current.chat.addMessage(prompt()));

  // item/started, item/completed and reconnect replay all carry the send's ID.
  for (let seq = 1; seq <= 3; seq++) {
    act(() => result.current.store.appendRealtime(SESSION.id, { ...echo(), seq }));
    const messages = result.current.chat.chatMessages;
    assert.equal(messages.length, 1);
    assert.equal(result.current.store.getMessages(SESSION.id)[0].id, 'client-message-1');
    assert.equal(messages[0].timestamp, SENT_AT);
    assert.deepEqual(messages[0].images, prompt().images);
    assert.deepEqual(messages[0].files, prompt().files);
  }

  const persisted = { ...echo(), transcriptAnchorId: 'turn-1' };
  sessionMessages.mockResolvedValue({
    ok: true, json: async () => ({ data: { messages: [persisted], total: 1, hasMore: false } }),
  });
  await act(async () => { await result.current.store.refreshLatestFromServer(SESSION.id); });
  assert.deepEqual(result.current.store.getMessages(SESSION.id), [persisted]);
  assert.equal(result.current.store.getSessionSlot(SESSION.id)?.realtimeMessages.length, 0);
});

test('the first message keeps its send ID while waiting for the new session to become visible', () => {
  const { result, rerender } = renderChat(null);
  act(() => result.current.chat.addMessage(prompt()));
  assert.equal(result.current.chat.chatMessages.length, 1);

  rerender({ session: SESSION });
  act(() => result.current.store.appendRealtime(SESSION.id, echo()));
  assert.equal(result.current.chat.chatMessages.length, 1);
  assert.equal(result.current.store.getMessages(SESSION.id)[0].id, 'client-message-1');
});

test('separate sends of identical text remain separate after native echoes', () => {
  const { result } = renderChat();
  for (const id of ['first-send', 'second-send']) {
    act(() => result.current.chat.addMessage(prompt(id)));
    act(() => result.current.store.appendRealtime(SESSION.id, echo(id)));
  }
  assert.equal(result.current.chat.chatMessages.length, 2);
  assert.deepEqual(result.current.store.getMessages(SESSION.id).map((message) => message.id), ['first-send', 'second-send']);
});

test('history without a client ID still replaces the optimistic bubble', async () => {
  const { result } = renderChat();
  act(() => result.current.chat.addMessage(prompt()));
  const persisted = { ...echo('provider-generated-id'), clientMessageId: undefined };
  sessionMessages.mockResolvedValue({
    ok: true, json: async () => ({ data: { messages: [persisted], total: 1, hasMore: false } }),
  });
  await act(async () => { await result.current.store.refreshLatestFromServer(SESSION.id); });
  assert.deepEqual(result.current.store.getMessages(SESSION.id), [persisted]);
});

test('refreshing the first send does not hide a pending identical second send', async () => {
  const { result } = renderChat();
  act(() => {
    result.current.chat.addMessage(prompt('first-send'));
    result.current.store.appendRealtime(SESSION.id, echo('first-send'));
    result.current.chat.addMessage({ ...prompt('second-send'), timestamp: new Date('2026-10-13T11:59:38.000Z') });
  });
  sessionMessages.mockResolvedValue({
    ok: true, json: async () => ({ data: { messages: [echo('first-send')], total: 1, hasMore: false } }),
  });
  await act(async () => { await result.current.store.refreshLatestFromServer(SESSION.id); });
  assert.equal(result.current.chat.chatMessages.length, 2);
  assert.deepEqual(result.current.store.getMessages(SESSION.id).map((message) => message.id), ['first-send', 'second-send']);

  act(() => result.current.store.appendRealtime(SESSION.id, echo('second-send')));
  assert.equal(result.current.chat.chatMessages.length, 2);
});
