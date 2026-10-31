import assert from 'node:assert/strict';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import {
  hydrateChatDrafts,
  readQueuedMessages,
  resetChatDrafts,
  writeQueuedMessages,
} from '@/shared/chatDrafts';
import type {
  ChatMessage,
  CodexControls,
  CodexSessionState,
  LLMProvider,
  PermissionMode,
  Project,
  ProjectSession,
  ServerEvent,
} from '@/shared/types';

/**
 * Server-owned queue receipts: when only Worker activity makes the session
 * busy, the composer still submits normally. The backend accepts the send and
 * answers `chat_queued`; that receipt must convert the optimistic row into the
 * same durable queue card the dispatcher will later start, without resending
 * or leaking across conversations.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION_A: ProjectSession = { id: 'session-a' };
const SESSION_B: ProjectSession = { id: 'session-b' };
const UPLOADED = { name: 'notes.txt', path: '/uploads/notes.txt', mimeType: 'text/plain', size: 5 };

type StoredQueueEntry = { id?: string; content: string; options?: Record<string, unknown>; attachments?: unknown[] };

let serverDrafts: Array<{ scope: string; text: string; queuedMessages: StoredQueueEntry[] }> = [];
let saveDraftBodies: Array<Record<string, unknown>> = [];
let emit: ((event: ServerEvent) => void) | null = null;

const subscribe = (listener: (event: ServerEvent) => void) => {
  emit = listener;
  return () => {
    if (emit === listener) emit = null;
  };
};

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  serverDrafts = [];
  saveDraftBodies = [];
  emit = null;
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/api/assets/files')) {
      const form = init?.body as FormData;
      return json({
        attachments: (form.getAll('files') as File[]).map((file) => ({
          name: file.name,
          path: `/uploads/${file.name}`,
          mimeType: file.type,
          size: file.size,
        })),
      });
    }
    if (path.endsWith('/api/user/drafts')) {
      if ((init?.method ?? 'GET') === 'PUT') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
        saveDraftBodies.push(body);
      }
      return json({ drafts: serverDrafts });
    }
    return json([]);
  }));
});

afterEach(() => {
  cleanup();
  resetChatDrafts();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const codexControls = (state: CodexSessionState): CodexControls => ({
  sessionId: SESSION_A.id,
  state,
  error: null,
  pending: false,
  delivery: null,
  hasActiveWorkers: true,
  control: async () => undefined,
  steer: async () => undefined,
});

const workerIdleState: CodexSessionState = {
  runtime: 'app-server',
  mode: 'default',
  turnId: null,
  phase: 'idle',
  goal: null,
  questions: [],
  workerEnabled: true,
};

type RenderArgs = {
  session?: ProjectSession;
  isLoading?: boolean;
  provider?: LLMProvider;
  workerQueueEnabled?: boolean;
  onSessionIdle?: () => void;
  onSessionProcessing?: () => void;
};

function renderHarness({
  session = SESSION_A,
  isLoading = false,
  provider = 'codex',
  workerQueueEnabled = false,
  onSessionIdle = () => undefined,
  onSessionProcessing = () => undefined,
}: RenderArgs = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const lastSeqRef = { current: new Map<string, number>() };
  const executionIdsRef = { current: new Map<string, string>() };
  const view = renderHook(() => {
    const store = useSessionStore();
    const composer = useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: session,
      currentSessionId: session.id,
      provider,
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading,
      ...(provider === 'codex' ? { codexControls: codexControls(workerIdleState) } : {}),
      workerQueueEnabled,
      canAbortSession: false,
      tokenBudget: null,
      processingSessions: new Map(),
      sendMessage: (message) => { sent.push(message as Record<string, unknown>); },
      scrollToBottom: () => undefined,
      addMessage: (message: ChatMessage) => {
        const messageId = typeof message.id === 'string' ? message.id : '';
        if (!messageId || message.type === 'error') {
          if (message.type === 'error') {
            store.appendRealtime(session.id, {
              id: `error-${store.getMessages(session.id).length}`,
              sessionId: session.id,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(message.content ?? ''),
            });
          }
          return;
        }
        store.appendRealtime(session.id, {
          id: messageId,
          clientMessageId: messageId,
          sessionId: session.id,
          timestamp: new Date(message.timestamp).toISOString(),
          provider,
          kind: 'text',
          role: 'user',
          isOptimistic: true,
          content: message.content,
          images: message.images,
          files: message.files,
        });
      },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    });
    useChatRealtimeHandlers({
      isActive: true,
      subscribe,
      provider,
      selectedSession: session,
      currentSessionId: session.id,
      setTokenBudget: () => undefined,
      pendingPermissionRequests: [],
      setPendingPermissionRequests: () => undefined,
      streamTimerRef: { current: null },
      accumulatedStreamRef: { current: '' },
      lastSeqRef,
      executionIdsRef,
      statusCheckSentAtRef,
      onSessionProcessing,
      onSessionIdle,
      onSessionBackground: () => undefined,
      getSessionActivity: () => undefined,
      onWebSocketReconnect: () => undefined,
      requestLatestMessages: async () => undefined,
      sessionStore: store,
    });
    return { composer, store };
  });
  const submit = async (text: string, files: File[] = []) => {
    await act(async () => {
      view.result.current.composer.setInput(text);
      view.result.current.composer.setAttachedFiles(files);
    });
    await act(async () => {
      await view.result.current.composer.handleSubmit({ preventDefault: () => undefined } as never);
    });
  };
  const send = async (event: ServerEvent) => {
    await act(async () => {
      emit?.(event);
    });
  };
  return { view, sent, submit, send };
}

const queueAck = (
  frame: Record<string, unknown>,
  messageId: string,
  queue: StoredQueueEntry[],
  attachments: unknown[] = [],
) => {
  const options = frame.options as Record<string, unknown>;
  const clientMessageId = String(options.clientMessageId);
  serverDrafts = [{ scope: String(frame.sessionId), text: '', queuedMessages: queue }];
  return {
    kind: 'chat_queued',
    sessionId: frame.sessionId,
    clientMessageId,
    messageId,
    queuedMessage: {
      id: messageId,
      content: frame.content,
      options,
      attachments,
    },
  } as ServerEvent;
};

test('worker-only activity still submits a normal chat.send without local queueing', async () => {
  const { view, sent, submit } = renderHarness();

  await submit('deploy the worker');

  assert.equal(sent.filter((frame) => frame.type === 'chat.send').length, 1);
  assert.deepEqual(readQueuedMessages(SESSION_A.id), [], 'the client did not invent a queue entry');
  assert.equal(view.result.current.store.getMessages(SESSION_A.id).length, 1, 'the optimistic turn stays visible until the receipt');
});

test('chat_queued converts the optimistic turn into one queue card without resending', async () => {
  const onSessionIdle = vi.fn();
  const { view, sent, submit, send } = renderHarness({ onSessionIdle });
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await submit('deploy the worker', [file]);

  const frame = sent.find((entry) => entry.type === 'chat.send');
  assert.ok(frame);
  await send(queueAck(frame, 'queued-1', [{
    id: 'queued-1',
    content: 'deploy the worker',
    options: frame.options as Record<string, unknown>,
    attachments: [UPLOADED],
  }], [UPLOADED]));

  await waitFor(() => assert.equal(view.result.current.composer.queuedDrafts.length, 1));
  assert.equal(view.result.current.composer.queuedDrafts[0].id, 'queued-1');
  assert.equal(
    view.result.current.composer.queuedDrafts[0].options?.clientMessageId,
    (frame.options as Record<string, unknown>).clientMessageId,
    'the queue card retains the original send identity',
  );
  assert.deepEqual(readQueuedMessages(SESSION_A.id).map(({ id }) => id), ['queued-1']);
  assert.deepEqual(view.result.current.store.getMessages(SESSION_A.id), [], 'the optimistic row is not left beside its queue card');
  assert.equal(sent.filter((entry) => entry.type === 'chat.send').length, 1, 'the accepted message is never resent');
  assert.equal(
    saveDraftBodies.some((body) => Array.isArray(body.queuedMessages)),
    false,
    'the receipt does not PUT a composer queue snapshot over the server-owned queue',
  );
  assert.equal(onSessionIdle.mock.calls.length, 0, 'queueing does not idle an active turn');

  // A fresh composer reads the durable store before any request lands, so the
  // card survives a reload as well as a session switch.
  view.unmount();
  const refreshed = renderHarness({ onSessionIdle });
  assert.equal(refreshed.view.result.current.composer.queuedDrafts[0]?.id, 'queued-1');
});

test('an ACK arriving after hydrate adds its file to the existing card without a queue PUT', async () => {
  const { view, sent, submit, send } = renderHarness();
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await submit('hydrated before ACK', [file]);
  const frame = sent.find((entry) => entry.type === 'chat.send');
  assert.ok(frame);
  const queued = {
    id: 'early-ticket',
    content: 'hydrated before ACK',
    options: frame.options as Record<string, unknown>,
    attachments: [UPLOADED],
  };

  // The ordinary draft poll lands first and draws the card without a File.
  serverDrafts = [{ scope: SESSION_A.id, text: '', queuedMessages: [queued] }];
  await act(async () => { await hydrateChatDrafts(); });
  await waitFor(() => assert.equal(view.result.current.composer.queuedDrafts.length, 1));
  assert.deepEqual(view.result.current.composer.queuedDrafts[0].attachments, []);

  await send(queueAck(frame, 'early-ticket', [queued], [UPLOADED]));
  await waitFor(() => assert.equal(view.result.current.composer.queuedDrafts[0]?.attachments[0], file));

  // A repeat receipt must not replace the File already retained on this page.
  await send(queueAck(frame, 'early-ticket', [queued], [UPLOADED]));
  await waitFor(() => assert.equal(view.result.current.composer.queuedDrafts[0]?.attachments[0], file));
  assert.equal(
    saveDraftBodies.some((body) => Array.isArray(body.queuedMessages)),
    false,
    'hydrate plus ACK reconciliation does not PUT the queue or the File',
  );

  await act(async () => { view.result.current.composer.editQueuedDraft('early-ticket'); });
  assert.equal(view.result.current.composer.attachedFiles[0], file);
  await act(async () => {
    await view.result.current.composer.handleSubmit({ preventDefault: () => undefined } as never);
  });
  const resent = sent.filter((entry) => entry.type === 'chat.send')[1];
  assert.ok(resent);
  assert.deepEqual((resent.options as Record<string, unknown>).attachments, [UPLOADED]);
});

test('a dispatched echo retires the queue card and leaves exactly one transcript row', async () => {
  const { view, sent, submit, send } = renderHarness();
  await submit('deploy the worker');
  const frame = sent.find((entry) => entry.type === 'chat.send');
  assert.ok(frame);
  const ack = queueAck(frame, 'queued-1', [{
    id: 'queued-1',
    content: 'deploy the worker',
    options: frame.options as Record<string, unknown>,
  }]);
  await send(ack);
  await waitFor(() => assert.equal(view.result.current.composer.queuedDrafts.length, 1));

  serverDrafts = [];
  await send({
    kind: 'text',
    role: 'user',
    id: 'provider-row-1',
    clientMessageId: ack.clientMessageId,
    sessionId: SESSION_A.id,
    provider: 'codex',
    content: 'deploy the worker',
    timestamp: new Date().toISOString(),
  });
  await waitFor(() => assert.equal(view.result.current.composer.queuedDrafts.length, 0));

  const rows = view.result.current.store.getMessages(SESSION_A.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'provider-row-1');
  assert.equal(rows[0].content, 'deploy the worker');
});

test('a receipt for another session never appears in the open composer', async () => {
  const { view, sent, send } = renderHarness();
  await act(async () => {
    view.result.current.store.appendRealtime(SESSION_B.id, {
      id: 'client-b',
      clientMessageId: 'client-b',
      sessionId: SESSION_B.id,
      timestamp: new Date().toISOString(),
      provider: 'codex',
      kind: 'text',
      role: 'user',
      isOptimistic: true,
      content: 'for the other chat',
    });
  });
  await act(async () => { view.result.current.composer.setInput('typing here'); });

  serverDrafts = [{ scope: SESSION_B.id, text: '', queuedMessages: [{ id: 'queued-b', content: 'for the other chat' }] }];
  await send({
    kind: 'chat_queued',
    sessionId: SESSION_B.id,
    clientMessageId: 'client-b',
    messageId: 'queued-b',
    queuedMessage: { id: 'queued-b', content: 'for the other chat', attachments: [] },
  });

  await waitFor(() => assert.deepEqual(readQueuedMessages(SESSION_B.id).map(({ id }) => id), ['queued-b']));
  assert.deepEqual(view.result.current.store.getMessages(SESSION_B.id), []);
  assert.deepEqual(view.result.current.composer.queuedDrafts, [], 'the current composer stays untouched');
  assert.equal(view.result.current.composer.input, 'typing here');
  assert.deepEqual(readQueuedMessages(SESSION_A.id), []);
  assert.equal(sent.length, 0);
});

test('multiple accepted sends remain distinct FIFO cards with their own attachments', async () => {
  const { view, sent, submit, send } = renderHarness();
  await submit('first');
  const first = sent.find((entry) => entry.type === 'chat.send');
  assert.ok(first);
  await send(queueAck(first, 'queued-1', [{
    id: 'queued-1', content: 'first', options: first.options as Record<string, unknown>, attachments: [UPLOADED],
  }], [UPLOADED]));
  await waitFor(() => assert.equal(view.result.current.composer.queuedDrafts.length, 1));

  await submit('second');
  const second = sent.filter((entry) => entry.type === 'chat.send')[1];
  assert.ok(second);
  await send(queueAck(second, 'queued-2', [
    { id: 'queued-1', content: 'first', options: first.options as Record<string, unknown>, attachments: [UPLOADED] },
    { id: 'queued-2', content: 'second', options: second.options as Record<string, unknown>, attachments: [] },
  ]));

  await waitFor(() => assert.equal(view.result.current.composer.queuedDrafts.length, 2));
  const stored = readQueuedMessages(SESSION_A.id);
  assert.deepEqual(stored.map(({ id }) => id), ['queued-1', 'queued-2']);
  assert.deepEqual(stored[0]?.attachments, [UPLOADED]);
  assert.deepEqual(stored[1]?.attachments, []);
  assert.equal(sent.filter((entry) => entry.type === 'chat.send').length, 2);
});

test('a queue-limit refusal restores the prompt and files without idling the running turn', async () => {
  const onSessionIdle = vi.fn();
  const onSessionProcessing = vi.fn();
  const { view, sent, submit, send } = renderHarness({ onSessionIdle, onSessionProcessing });
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await submit('must not be lost', [file]);
  const frame = sent.find((entry) => entry.type === 'chat.send');
  assert.ok(frame);
  const clientMessageId = (frame.options as Record<string, unknown>).clientMessageId;

  await act(async () => {
    onSessionProcessing();
  });
  await send({
    kind: 'protocol_error',
    sessionId: SESSION_A.id,
    clientMessageId,
    code: 'QUEUE_LIMIT_REACHED',
    error: 'Queue is full (3)',
  });

  await waitFor(() => assert.equal(view.result.current.composer.input, 'must not be lost'));
  assert.equal(view.result.current.composer.attachedFiles[0], file, 'the original browser file is still attached');
  assert.deepEqual(readQueuedMessages(SESSION_A.id), []);
  assert.equal(sent.filter((entry) => entry.type === 'chat.send').length, 1, 'refusal never auto-resends');
  assert.equal(onSessionIdle.mock.calls.length, 0, 'the current turn is not marked idle');
  assert.equal(view.result.current.store.getMessages(SESSION_A.id).filter((row) => row.role === 'user').length, 0);
  assert.ok(view.result.current.store.getMessages(SESSION_A.id).some(
    (row) => row.kind === 'error' && /queue is full/i.test(String(row.content)),
  ));
});


test('an idle refusal with an authoritative idle state restores input and ends its optimistic processing', async () => {
  const onSessionIdle = vi.fn();
  const { view, sent, submit, send } = renderHarness({ onSessionIdle });
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await submit('idle refused', [file]);
  const frame = sent.find((entry) => entry.type === 'chat.send');
  assert.ok(frame);
  const clientMessageId = (frame.options as Record<string, unknown>).clientMessageId;

  await send({
    kind: 'protocol_error',
    sessionId: SESSION_A.id,
    clientMessageId,
    code: 'QUEUE_LIMIT_REACHED',
    error: 'Queue is full (3)',
    codexState: { ...workerIdleState, turnId: null, phase: 'idle' },
  });

  await waitFor(() => assert.equal(view.result.current.composer.input, 'idle refused'));
  assert.equal(view.result.current.composer.attachedFiles[0], file);
  assert.equal(onSessionIdle.mock.calls.length, 1, 'the native idle snapshot ends the optimistic turn');
  assert.equal(sent.filter((entry) => entry.type === 'chat.send').length, 1, 'refusal never auto-resends');
  assert.equal(
    view.result.current.store.getMessages(SESSION_A.id).filter((row) => row.role === 'user').length,
    0,
    'the refused optimistic row is removed',
  );
});

test('MESSAGE_ALREADY_SENT keeps the accepted user row without restoring or resending', async () => {
  const { view, sent, submit, send } = renderHarness();
  await submit('accepted once');
  const frame = sent.find((entry) => entry.type === 'chat.send');
  assert.ok(frame);
  const clientMessageId = (frame.options as Record<string, unknown>).clientMessageId;

  await send({
    kind: 'protocol_error',
    sessionId: SESSION_A.id,
    clientMessageId,
    code: 'MESSAGE_ALREADY_SENT',
    error: 'Already accepted',
  });

  assert.equal(view.result.current.composer.input, '', 'the accepted prompt is not restored for a second send');
  assert.deepEqual(readQueuedMessages(SESSION_A.id), []);
  assert.equal(sent.filter((entry) => entry.type === 'chat.send').length, 1, 'the duplicate is not resent');
  assert.equal(
    view.result.current.store.getMessages(SESSION_A.id).filter((row) => row.kind === 'error').length,
    0,
    'an idempotent duplicate is not reported as a send failure',
  );
  assert.equal(
    view.result.current.store.getMessages(SESSION_A.id).filter((row) => row.role === 'user').length,
    1,
    'the accepted optimistic user row stays in the transcript',
  );

  await send({
    kind: 'text',
    role: 'user',
    id: 'provider-row-accepted',
    clientMessageId,
    sessionId: SESSION_A.id,
    provider: 'codex',
    content: 'accepted once',
    timestamp: new Date().toISOString(),
  });
  const rows = view.result.current.store.getMessages(SESSION_A.id).filter((row) => row.role === 'user');
  assert.equal(rows.length, 1, 'the native echo replaces rather than duplicates the accepted row');
  assert.equal(rows[0]?.content, 'accepted once');
});

test('editing an acknowledged queue card keeps the original browser file for resend', async () => {
  const { view, sent, submit, send } = renderHarness();
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await submit('deploy with notes', [file]);
  const frame = sent.find((entry) => entry.type === 'chat.send');
  assert.ok(frame);
  await send(queueAck(frame, 'queued-file', [{
    id: 'queued-file',
    content: 'deploy with notes',
    options: frame.options as Record<string, unknown>,
    attachments: [UPLOADED],
  }], [UPLOADED]));
  await waitFor(() => assert.equal(view.result.current.composer.queuedDrafts.length, 1));

  const queuedId = view.result.current.composer.queuedDrafts[0].id;
  assert.ok(queuedId);
  await act(async () => { view.result.current.composer.editQueuedDraft(queuedId); });

  assert.equal(view.result.current.composer.input, 'deploy with notes');
  assert.equal(view.result.current.composer.attachedFiles[0], file, 'the acknowledged card retains its browser file');
  assert.deepEqual(view.result.current.composer.queuedDrafts, []);

  await act(async () => {
    await view.result.current.composer.handleSubmit({ preventDefault: () => undefined } as never);
  });
  const resent = sent.filter((entry) => entry.type === 'chat.send')[1];
  assert.ok(resent);
  assert.deepEqual(
    (resent.options as Record<string, unknown>).attachments,
    [UPLOADED],
    'editing and resending uploads the retained file again',
  );
});

test('an in-flight queue PUT preserves a ticket accepted after its snapshot', async () => {
  serverDrafts = [{
    scope: SESSION_A.id,
    text: '',
    queuedMessages: [{ id: 'A', content: 'A' }],
  }];
  const { view } = renderHarness();
  await act(async () => { await hydrateChatDrafts(); });
  assert.deepEqual(readQueuedMessages(SESSION_A.id).map(({ id }) => id), ['A']);

  let releasePut!: () => void;
  let reportPut!: (body: Record<string, unknown>) => void;
  const putStarted = new Promise<Record<string, unknown>>((resolve) => { reportPut = resolve; });
  const fallback = vi.mocked(fetch).getMockImplementation();
  assert.ok(fallback);
  const applySnapshot = (body: Record<string, unknown>) => {
    const scope = String(body.scope);
    const incoming = Array.isArray(body.queuedMessages) ? body.queuedMessages as StoredQueueEntry[] : [];
    const current = serverDrafts.find((draft) => draft.scope === scope)?.queuedMessages ?? [];
    if (!Array.isArray(body.knownQueuedMessageIds)) {
      serverDrafts = [{ scope, text: String(body.text ?? ''), queuedMessages: incoming }];
      return;
    }
    const known = new Set(body.knownQueuedMessageIds.map(String));
    const incomingById = new Map(incoming.map((entry) => [String(entry.id), entry]));
    const next: StoredQueueEntry[] = [];
    for (const entry of current) {
      const id = String(entry.id);
      if (!known.has(id)) {
        next.push(entry);
      } else if (incomingById.has(id)) {
        next.push(incomingById.get(id)!);
        incomingById.delete(id);
      }
    }
    next.push(...incomingById.values());
    serverDrafts = [{ scope, text: String(body.text ?? ''), queuedMessages: next }];
  };
  vi.mocked(fetch).mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/api/user/drafts')) {
      if ((init?.method ?? 'GET') === 'PUT') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
        saveDraftBodies.push(body);
        reportPut(body);
        await new Promise<void>((resolve) => { releasePut = resolve; });
        applySnapshot(body);
        return json({ success: true });
      }
      return json({ drafts: serverDrafts });
    }
    return fallback(url, init);
  });

  await act(async () => {
    writeQueuedMessages(SESSION_A.id, [{ id: 'A', content: 'A edited' }]);
    await putStarted;
  });
  const oldPut = await putStarted;
  assert.deepEqual(oldPut.knownQueuedMessageIds, ['A'], 'the old snapshot only knows the ticket it edited');
  assert.equal(JSON.stringify(oldPut.knownQueuedMessageIds).includes('"B"'), false, 'the later ticket is not in the old PUT');

  // The server accepts B while A's edit is still in flight.
  serverDrafts = [{
    scope: SESSION_A.id,
    text: '',
    queuedMessages: [{ id: 'A', content: 'A' }, { id: 'B', content: 'B' }],
  }];
  await act(async () => {
    emit?.({
      kind: 'chat_queued',
      sessionId: SESSION_A.id,
      clientMessageId: 'client-b',
      messageId: 'B',
      queuedMessage: { id: 'B', content: 'B', attachments: [] },
    });
  });
  await waitFor(() => assert.deepEqual(
    readQueuedMessages(SESSION_A.id).map(({ id }) => id),
    ['A', 'B'],
    'the acknowledged ticket appears beside the locally edited one',
  ));

  releasePut!();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await hydrateChatDrafts(); });

  assert.deepEqual(
    readQueuedMessages(SESSION_A.id).map(({ id, content }) => [id, content]),
    [['A', 'A edited'], ['B', 'B']],
    'the delayed PUT preserves the server ticket it never saw',
  );
  assert.deepEqual(view.result.current.composer.queuedDrafts.map(({ id }) => id), ['A', 'B']);
});

test('a DSH ACP Worker receipt becomes one queue card without keeping the optimistic row', async () => {
  const { view, sent, submit, send } = renderHarness({ provider: 'dsh', workerQueueEnabled: true });
  await submit('deploy the DSH worker');

  const frame = sent.find((entry) => entry.type === 'chat.send');
  assert.ok(frame);
  await send(queueAck(frame, 'dsh-queued-1', [{
    id: 'dsh-queued-1',
    content: 'deploy the DSH worker',
    options: frame.options as Record<string, unknown>,
  }]));

  await waitFor(() => assert.equal(view.result.current.composer.queuedDrafts.length, 1));
  assert.equal(view.result.current.composer.queuedDrafts[0].id, 'dsh-queued-1');
  assert.deepEqual(readQueuedMessages(SESSION_A.id).map(({ id }) => id), ['dsh-queued-1']);
  assert.deepEqual(view.result.current.store.getMessages(SESSION_A.id), [], 'the optimistic row is replaced by its card');
  assert.equal(sent.filter((entry) => entry.type === 'chat.send').length, 1, 'the accepted DSH message is not resent');
});

test('a refused DSH ACP Worker send restores its prompt and files without idling the turn', async () => {
  const onSessionIdle = vi.fn();
  const { view, sent, submit, send } = renderHarness({ provider: 'dsh', workerQueueEnabled: true, onSessionIdle });
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await submit('DSH prompt must survive', [file]);
  const frame = sent.find((entry) => entry.type === 'chat.send');
  assert.ok(frame);
  const clientMessageId = (frame.options as Record<string, unknown>).clientMessageId;

  await send({
    kind: 'protocol_error',
    sessionId: SESSION_A.id,
    clientMessageId,
    code: 'QUEUE_LIMIT_REACHED',
    error: 'Queue is full (3)',
  });

  await waitFor(() => assert.equal(view.result.current.composer.input, 'DSH prompt must survive'));
  assert.equal(view.result.current.composer.attachedFiles[0], file, 'the original DSH browser file is still attached');
  assert.deepEqual(readQueuedMessages(SESSION_A.id), []);
  assert.equal(sent.filter((entry) => entry.type === 'chat.send').length, 1, 'the refused DSH send is never auto-resent');
  assert.equal(onSessionIdle.mock.calls.length, 0, 'the DSH refusal does not idle an active turn');
  assert.equal(view.result.current.store.getMessages(SESSION_A.id).filter((row) => row.role === 'user').length, 0);
});

test('DSH headless sends remain receipt-free and do not restore a refused prompt', async () => {
  const { view, sent, submit, send } = renderHarness({ provider: 'dsh', workerQueueEnabled: false });
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await submit('headless prompt', [file]);
  const frame = sent.find((entry) => entry.type === 'chat.send');
  assert.ok(frame);
  const clientMessageId = (frame.options as Record<string, unknown>).clientMessageId;

  await send({
    kind: 'protocol_error',
    sessionId: SESSION_A.id,
    clientMessageId,
    code: 'QUEUE_LIMIT_REACHED',
    error: 'Queue is full (3)',
  });

  await waitFor(() => assert.equal(
    view.result.current.store.getMessages(SESSION_A.id).filter((row) => row.role === 'user').length,
    0,
  ));
  assert.equal(view.result.current.composer.input, '', 'headless keeps its existing composer behavior');
  assert.deepEqual(view.result.current.composer.attachedFiles, []);
  assert.deepEqual(readQueuedMessages(SESSION_A.id), []);
  assert.equal(sent.filter((entry) => entry.type === 'chat.send').length, 1);
});

test('a delayed deletion only removes the ticket its snapshot knew', async () => {
  serverDrafts = [{
    scope: SESSION_A.id,
    text: '',
    queuedMessages: [{ id: 'A', content: 'A' }],
  }];
  const { view } = renderHarness();
  await act(async () => { await hydrateChatDrafts(); });

  let releasePut!: () => void;
  let reportPut!: (body: Record<string, unknown>) => void;
  const putStarted = new Promise<Record<string, unknown>>((resolve) => { reportPut = resolve; });
  const fallback = vi.mocked(fetch).getMockImplementation();
  assert.ok(fallback);
  const applySnapshot = (body: Record<string, unknown>) => {
    const scope = String(body.scope);
    const incoming = Array.isArray(body.queuedMessages) ? body.queuedMessages as StoredQueueEntry[] : [];
    const current = serverDrafts.find((draft) => draft.scope === scope)?.queuedMessages ?? [];
    const known = new Set(Array.isArray(body.knownQueuedMessageIds) ? body.knownQueuedMessageIds.map(String) : []);
    if (!Array.isArray(body.knownQueuedMessageIds)) {
      serverDrafts = [{ scope, text: String(body.text ?? ''), queuedMessages: incoming }];
      return;
    }
    const incomingById = new Map(incoming.map((entry) => [String(entry.id), entry]));
    const next: StoredQueueEntry[] = [];
    for (const entry of current) {
      const id = String(entry.id);
      if (!known.has(id)) next.push(entry);
      else if (incomingById.has(id)) {
        next.push(incomingById.get(id)!);
        incomingById.delete(id);
      }
    }
    next.push(...incomingById.values());
    serverDrafts = [{ scope, text: String(body.text ?? ''), queuedMessages: next }];
  };
  vi.mocked(fetch).mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/api/user/drafts')) {
      if ((init?.method ?? 'GET') === 'PUT') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
        saveDraftBodies.push(body);
        reportPut(body);
        await new Promise<void>((resolve) => { releasePut = resolve; });
        applySnapshot(body);
        return json({ success: true });
      }
      return json({ drafts: serverDrafts });
    }
    return fallback(url, init);
  });

  await act(async () => {
    writeQueuedMessages(SESSION_A.id, []);
    await putStarted;
  });
  const oldPut = await putStarted;
  assert.deepEqual(oldPut.knownQueuedMessageIds, ['A'], 'an empty snapshot still names the ticket it deleted');

  serverDrafts = [{
    scope: SESSION_A.id,
    text: '',
    queuedMessages: [{ id: 'A', content: 'A' }, { id: 'B', content: 'B' }],
  }];
  await act(async () => {
    emit?.({
      kind: 'chat_queued',
      sessionId: SESSION_A.id,
      clientMessageId: 'client-b',
      messageId: 'B',
      queuedMessage: { id: 'B', content: 'B', attachments: [] },
    });
  });
  await waitFor(() => assert.deepEqual(readQueuedMessages(SESSION_A.id).map(({ id }) => id), ['B']));

  releasePut!();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await hydrateChatDrafts(); });

  assert.deepEqual(readQueuedMessages(SESSION_A.id).map(({ id }) => id), ['B']);
  assert.deepEqual(view.result.current.composer.queuedDrafts.map(({ id }) => id), ['B']);
});
