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

test('native ack followed by client-ID-less history still leaves one user row', async () => {
  const { result } = renderChat();
  act(() => result.current.chat.addMessage(prompt()));

  // item/started repeats the composer's ID, so it replaces the optimistic row.
  act(() => result.current.store.appendRealtime(SESSION.id, echo()));
  assert.equal(result.current.chat.chatMessages.length, 1);

  // A thread started with historyMode "legacy" returns this turn without a
  // client id, so the ack and the persisted copy carry different identities.
  const persisted = {
    ...echo('provider-generated-id'), clientMessageId: undefined, transcriptAnchorId: 'turn-1',
  };
  sessionMessages.mockResolvedValue({
    ok: true, json: async () => ({ data: { messages: [persisted], total: 1, hasMore: false } }),
  });
  await act(async () => { await result.current.store.refreshLatestFromServer(SESSION.id); });

  const messages = result.current.chat.chatMessages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, persisted.content);
  assert.deepEqual(result.current.store.getMessages(SESSION.id), [persisted]);
  assert.equal(result.current.store.getSessionSlot(SESSION.id)?.realtimeMessages.length, 0);
});

test('native snapshots keep local edit provenance and attachments the echo omits', () => {
  const { result } = renderChat();
  act(() => result.current.chat.addMessage({ ...prompt('edited-send'), replacesAnchorId: 'turn-1' }));

  // The provider's item snapshot is authoritative for content, but it does not
  // know this is a pending replacement or which files the optimistic row holds.
  act(() => result.current.store.appendRealtime(SESSION.id, {
    ...echo('edited-send'), content: 'Edited prompt', images: undefined, files: undefined,
  }));

  const [row] = result.current.store.getMessages(SESSION.id);
  assert.equal(row.content, 'Edited prompt');
  assert.equal(row.timestamp, SENT_AT);
  assert.equal(row.isOptimistic, true);
  assert.equal(row.replacesAnchorId, 'turn-1');
  assert.deepEqual(row.images, prompt().images);
  assert.deepEqual(row.files, prompt().files);

  // Attachments the snapshot does carry are still applied normally.
  act(() => result.current.store.appendRealtime(SESSION.id, {
    ...echo('edited-send'), content: 'Edited prompt again',
    images: [{ path: '/tmp/native.png' }], files: [],
  }));
  const [updated] = result.current.store.getMessages(SESSION.id);
  assert.equal(updated.content, 'Edited prompt again');
  assert.deepEqual(updated.images, [{ path: '/tmp/native.png' }]);
  assert.deepEqual(updated.files, prompt().files);
});

test('a late native ack or replay never re-adds a row history already took over', async () => {
  const { result } = renderChat();
  act(() => result.current.chat.addMessage(prompt()));

  // Legacy history returns the same turn without a client id, so the row that
  // takes the echo over has an identity the composer never saw.
  const persisted = { ...echo('provider-generated-id'), clientMessageId: undefined };
  sessionMessages.mockResolvedValue({
    ok: true, json: async () => ({ data: { messages: [persisted], total: 1, hasMore: false } }),
  });
  await act(async () => { await result.current.store.refreshLatestFromServer(SESSION.id); });
  assert.equal(result.current.chat.chatMessages.length, 1);

  // item/started, item/completed and reconnect replay still carry the send ID.
  for (let seq = 1; seq <= 3; seq++) {
    act(() => result.current.store.appendRealtime(SESSION.id, {
      ...echo(), seq, isStreaming: seq < 3,
    }));
    assert.equal(result.current.chat.chatMessages.length, 1);
    const rows = result.current.store.getMessages(SESSION.id);
    assert.deepEqual(rows.map((message) => message.id), ['provider-generated-id']);
    assert.equal(rows[0].content, persisted.content);
  }
});

test('the first send stays a single row when its history takeover arrives first', async () => {
  const { result, rerender } = renderChat(null);
  act(() => result.current.chat.addMessage(prompt()));

  const persisted = { ...echo('provider-generated-id'), clientMessageId: undefined };
  sessionMessages.mockResolvedValue({
    ok: true, json: async () => ({ data: { messages: [persisted], total: 1, hasMore: false } }),
  });
  await act(async () => {
    rerender({ session: SESSION });
    await result.current.store.refreshLatestFromServer(SESSION.id);
  });
  assert.equal(result.current.chat.chatMessages.length, 1);

  act(() => result.current.store.appendRealtime(SESSION.id, echo()));
  assert.equal(result.current.chat.chatMessages.length, 1);
  assert.deepEqual(
    result.current.store.getMessages(SESSION.id).map((message) => message.id),
    ['provider-generated-id'],
  );
});

test('a retired history row accounts for only one of two identical sends', async () => {
  const { result } = renderChat();
  act(() => result.current.chat.addMessage(prompt('first-send')));
  act(() => result.current.store.appendRealtime(SESSION.id, echo('first-send')));

  const h1 = { ...echo('history-1'), clientMessageId: undefined };
  sessionMessages.mockResolvedValue({
    ok: true, json: async () => ({ data: { messages: [h1], total: 1, hasMore: false } }),
  });
  await act(async () => { await result.current.store.refreshLatestFromServer(SESSION.id); });
  assert.deepEqual(result.current.store.getMessages(SESSION.id).map((message) => message.id), ['history-1']);

  // The second send repeats the text exactly. H1 belongs to the first send.
  act(() => result.current.chat.addMessage({
    ...prompt('second-send'), timestamp: new Date('2026-10-13T11:59:40.000Z'),
  }));
  assert.deepEqual(
    result.current.store.getMessages(SESSION.id).map((message) => message.id),
    ['history-1', 'second-send'],
  );

  // Legacy readers regenerate the persisted ID on every read.
  const h1ReadAgain = { ...h1, id: 'history-1-regenerated' };
  sessionMessages.mockResolvedValue({
    ok: true, json: async () => ({ data: { messages: [h1ReadAgain], total: 1, hasMore: false } }),
  });
  await act(async () => { await result.current.store.refreshLatestFromServer(SESSION.id); });
  assert.deepEqual(
    result.current.store.getMessages(SESSION.id).map((message) => message.id),
    ['history-1-regenerated', 'second-send'],
  );

  act(() => result.current.store.appendRealtime(SESSION.id, echo('second-send')));
  assert.equal(result.current.chat.chatMessages.length, 2);

  const h2 = { ...echo('history-2'), clientMessageId: undefined, timestamp: '2026-10-13T11:59:42.000Z' };
  sessionMessages.mockResolvedValue({
    ok: true, json: async () => ({
      data: { messages: [h1ReadAgain, h2], total: 2, hasMore: false },
    }),
  });
  await act(async () => { await result.current.store.refreshLatestFromServer(SESSION.id); });
  assert.deepEqual(
    result.current.store.getMessages(SESSION.id).map((message) => message.id),
    ['history-1-regenerated', 'history-2'],
  );
});

test('a native snapshot associates by clientMessageId without merging another send', () => {
  const { result } = renderChat();
  act(() => result.current.chat.addMessage(prompt('local-canonical')));

  // The provider's own item id differs, but it keeps the composer's send ID.
  act(() => result.current.store.appendRealtime(SESSION.id, {
    ...echo('provider-item-id'), clientMessageId: 'local-canonical',
  }));
  let messages = result.current.store.getMessages(SESSION.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'local-canonical');
  assert.equal(messages[0].timestamp, SENT_AT);

  // A different submission with identical text keeps its own client ID.
  act(() => result.current.store.appendRealtime(SESSION.id, {
    ...echo('other-client-id'), id: 'provider-item-id-2', clientMessageId: 'other-client-id',
  }));
  messages = result.current.store.getMessages(SESSION.id);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.id), ['local-canonical', 'provider-item-id-2']);
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
