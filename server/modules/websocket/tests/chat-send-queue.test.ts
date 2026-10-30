import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionDraftsDb,
  sessionRuntimeDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord, CodexSessionState, ProviderRuntimeGateway } from '@/shared/index.js';

type Harness = {
  sessionId: string;
  userId: number;
  socket: EventEmitter & { frames: AnyRecord[] };
  state: CodexSessionState;
  runs: AnyRecord[];
  notifications: string[];
  send(data: AnyRecord): void;
};

async function harness(
  provider: 'codex' | 'claude',
  runTest: (h: Harness) => Promise<void>,
): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat-send-queue-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();

  const sessionId = `busy-queue-${provider}`;
  const userId = Number(userDb.createUser(`queue-${provider}`, 'hash').id);
  sessionsDb.createAppSession(sessionId, provider, root);
  sessionRuntimeDb.update(sessionId, {
    runtime: 'app-server',
    modelSelection: { modelProvider: 'openai', model: 'test-model' },
  });

  const state: CodexSessionState = {
    runtime: 'app-server',
    mode: 'default',
    turnId: 'turn-running',
    phase: 'running',
    goal: null,
    questions: [],
    workerEnabled: provider === 'codex',
  };
  const runs: AnyRecord[] = [];
  const notifications: string[] = [];
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    getState: () => state,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    abort: async () => true,
    async run(_provider: string, content: string, options: AnyRecord) { runs.push({ content, options }); },
  } as never;

  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    frames: [] as AnyRecord[],
    send(text: string) { this.frames.push(JSON.parse(text) as AnyRecord); },
  });
  handleChatConnection(socket as never, { user: { id: userId } } as never, {
    runtime,
    notifyQueueChanged: (changedSessionId) => notifications.push(changedSessionId),
  });

  try {
    await runTest({
      sessionId, userId, socket, state, runs, notifications,
      send(data) { socket.emit('message', JSON.stringify({ sessionId, ...data })); },
    });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 20); });

function queuedDrafts(userId: number): Array<Record<string, unknown>> {
  return (sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? []) as Array<Record<string, unknown>>;
}

test('a busy Worker-enabled Codex send is queued and acknowledged with the saved ticket', async () => {
  await harness('codex', async (h) => {
    chatRunRegistry.startRun({
      appSessionId: h.sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: h.userId,
    });
    h.send({
      type: 'chat.send',
      content: 'queue this follow-up',
      options: { clientMessageId: 'client-queue-1', model: 'test-model', permissionMode: 'plan' },
    });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'chat_queued');
    assert.equal(frame.sessionId, h.sessionId);
    assert.equal(frame.clientMessageId, 'client-queue-1');
    assert.equal(frame.messageId, (frame.queuedMessage as AnyRecord).id);
    assert.equal((frame.queuedMessage as AnyRecord).content, 'queue this follow-up');
    assert.equal(((frame.queuedMessage as AnyRecord).options as AnyRecord).clientMessageId, 'client-queue-1');
    assert.deepEqual(queuedDrafts(h.userId).map((message) => message.id), [frame.messageId]);
    assert.deepEqual(h.notifications, [h.sessionId]);
    assert.equal(h.runs.length, 0);
  });
});

test('a repeated clientMessageId returns the same queued ticket and never inserts twice', async () => {
  await harness('codex', async (h) => {
    chatRunRegistry.startRun({
      appSessionId: h.sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: h.userId,
    });
    const payload = {
      type: 'chat.send',
      content: 'retry me',
      options: { clientMessageId: 'client-queue-retry' },
    };
    h.send(payload);
    await settle();
    const first = h.socket.frames.at(-1)!;
    h.send(payload);
    await settle();
    const second = h.socket.frames.at(-1)!;

    assert.equal(first.kind, 'chat_queued');
    assert.equal(second.kind, 'chat_queued');
    assert.equal(second.messageId, first.messageId);
    assert.equal(queuedDrafts(h.userId).length, 1);
  });
});

test('a new busy send appends behind the existing user queue instead of jumping it', async () => {
  await harness('codex', async (h) => {
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, {
      queuedMessages: [{ id: 'already-waiting', content: 'first' }],
    });
    chatRunRegistry.startRun({
      appSessionId: h.sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: h.userId,
    });
    h.send({
      type: 'chat.send', content: 'second',
      options: { clientMessageId: 'client-queue-second' },
    });
    await settle();

    assert.deepEqual(queuedDrafts(h.userId).map((message) => message.content), ['first', 'second']);
  });
});

test('an idle full user queue rejects the send with an idle codexState', async () => {
  await harness('codex', async (h) => {
    h.state.phase = 'idle';
    h.state.turnId = null;
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, {
      queuedMessages: [{ id: 'a', content: 'a' }, { id: 'b', content: 'b' }, { id: 'c', content: 'c' }],
    });
    h.send({
      type: 'chat.send', content: 'fourth',
      options: { clientMessageId: 'client-queue-full' },
    });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'protocol_error');
    assert.equal(frame.code, 'QUEUE_LIMIT_REACHED');
    assert.equal(frame.clientMessageId, 'client-queue-full');
    assert.equal((frame.codexState as AnyRecord).phase, 'idle');
    assert.equal(queuedDrafts(h.userId).length, 3);
  });
});

test('an invalid fallback message is rejected with its current codexState', async () => {
  await harness('codex', async (h) => {
    h.state.phase = 'idle';
    h.state.turnId = null;
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, {
      queuedMessages: [{ id: 'waiting', content: 'first' }],
    });
    h.send({
      type: 'chat.send', content: '   ',
      options: { clientMessageId: 'client-empty' },
    });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'protocol_error');
    assert.equal(frame.code, 'CONTENT_REQUIRED');
    assert.equal(frame.clientMessageId, 'client-empty');
    assert.equal((frame.codexState as AnyRecord).phase, 'idle');
  });
});

test('a session without Worker config keeps the existing RUN_IN_PROGRESS behaviour', async () => {
  await harness('codex', async (h) => {
    h.state.workerEnabled = false;
    chatRunRegistry.startRun({
      appSessionId: h.sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: h.userId,
    });
    h.send({ type: 'chat.send', content: 'do not queue', options: { clientMessageId: 'client-no-worker' } });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'protocol_error');
    assert.equal(frame.code, 'RUN_IN_PROGRESS');
    assert.equal(queuedDrafts(h.userId).length, 0);
  });
});

test('another provider keeps its existing RUN_IN_PROGRESS behaviour', async () => {
  await harness('claude', async (h) => {
    chatRunRegistry.startRun({
      appSessionId: h.sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: h.userId,
    });
    h.send({ type: 'chat.send', content: 'do not queue', options: { clientMessageId: 'client-claude' } });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'protocol_error');
    assert.equal(frame.code, 'RUN_IN_PROGRESS');
    assert.equal(queuedDrafts(h.userId).length, 0);
  });
});

test('a retry after the queue head was claimed is rejected by its delivery receipt', async () => {
  await harness('codex', async (h) => {
    // Produce the same receipt the busy fallback writes, then add a tail.
    sessionDraftsDb.enqueueChatMessage(
      h.userId, h.sessionId,
      { content: 'already claimed', options: {}, attachments: [] },
      'client-claimed',
    );
    const current = sessionDraftsDb.getDrafts(h.userId)[0].queuedMessages as Array<Record<string, unknown>>;
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, {
      queuedMessages: [...current, { id: 'tail', content: 'still waiting' }],
    });
    const candidate = sessionDraftsDb.listQueuedMessages()[0];
    assert.equal(sessionDraftsDb.claimQueuedMessage(candidate), true);
    chatRunRegistry.startRun({
      appSessionId: h.sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: h.userId,
    });

    h.send({
      type: 'chat.send', content: 'already claimed',
      options: { clientMessageId: 'client-claimed' },
    });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'protocol_error');
    assert.equal(frame.code, 'MESSAGE_ALREADY_SENT');
    assert.equal(frame.clientMessageId, 'client-claimed');
    assert.deepEqual(queuedDrafts(h.userId).map((message) => message.id), ['tail']);
  });
});

test('an idle Worker-enabled session with a waiting FIFO queues a new send behind it', async () => {
  await harness('codex', async (h) => {
    h.state.phase = 'idle';
    h.state.turnId = null;
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, {
      queuedMessages: [{ id: 'first', content: 'first waiting' }],
    });

    h.send({ type: 'chat.send', content: 'second', options: { clientMessageId: 'client-second-idle' } });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'chat_queued');
    assert.equal(h.runs.length, 0, 'the second send must not start while the first is waiting');
    assert.deepEqual(queuedDrafts(h.userId).map((message) => message.content), ['first waiting', 'second']);
  });
});

test('an accepted fallback ticket retried while idle is rejected instead of executed again', async () => {
  await harness('codex', async (h) => {
    h.state.phase = 'idle';
    h.state.turnId = null;
    sessionDraftsDb.enqueueChatMessage(
      h.userId, h.sessionId,
      { content: 'already accepted', options: {}, attachments: [] },
      'client-accepted',
    );
    const candidate = sessionDraftsDb.listQueuedMessages()[0];
    assert.equal(sessionDraftsDb.claimQueuedMessage(candidate), true);
    sessionDraftsDb.confirmQueuedMessageDispatch(candidate);

    h.send({
      type: 'chat.send', content: 'already accepted',
      options: { clientMessageId: 'client-accepted' },
    });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'protocol_error');
    assert.equal(frame.code, 'MESSAGE_ALREADY_SENT');
    assert.equal((frame.codexState as AnyRecord).phase, 'idle');
    assert.equal(h.runs.length, 0);
    assert.equal(queuedDrafts(h.userId).length, 0);
  });
});

test('a claimed fallback head reserves one slot until accepted', async () => {
  await harness('codex', async (h) => {
    sessionDraftsDb.enqueueChatMessage(
      h.userId, h.sessionId,
      { content: 'claimed head', options: {}, attachments: [] },
      'client-claimed-head',
    );
    const candidate = sessionDraftsDb.listQueuedMessages()[0];
    assert.equal(sessionDraftsDb.claimQueuedMessage(candidate), true);

    sessionDraftsDb.saveDraft(h.userId, h.sessionId, {
      queuedMessages: [{ id: 'two', content: 'two' }, { id: 'three', content: 'three' }],
    });
    assert.throws(
      () => sessionDraftsDb.saveDraft(h.userId, h.sessionId, {
        queuedMessages: [
          { id: 'two', content: 'two' }, { id: 'three', content: 'three' },
          { id: 'four', content: 'four' },
        ],
      }),
      (error: Error & { code?: string }) => error.code === 'QUEUE_LIMIT_REACHED',
    );

    sessionDraftsDb.confirmQueuedMessageDispatch(candidate);
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, {
      queuedMessages: [
        { id: 'two', content: 'two' }, { id: 'three', content: 'three' },
        { id: 'four', content: 'four' },
      ],
    });
    assert.equal(queuedDrafts(h.userId).length, 3);
  });
});

test('an accepted manual steer ticket cannot be queued again', async () => {
  await harness('codex', async (h) => {
    h.state.phase = 'idle';
    h.state.turnId = null;
    sessionDraftsDb.enqueueChatMessage(
      h.userId, h.sessionId,
      { content: 'steered away', options: {}, attachments: [] },
      'client-steered',
    );
    sessionDraftsDb.beginSteer(h.userId, h.sessionId, 'client-steered', 'steer-request');
    sessionDraftsDb.finishSteer(h.userId, h.sessionId, 'steer-request', 'accepted');

    h.send({
      type: 'chat.send', content: 'steered away',
      options: { clientMessageId: 'client-steered' },
    });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'protocol_error');
    assert.equal(frame.code, 'MESSAGE_ALREADY_SENT');
    assert.equal(h.runs.length, 0);
    assert.equal(queuedDrafts(h.userId).length, 0);
  });
});

test('the same client message id in another session is not claimed by this session receipt', async () => {
  await harness('codex', async (h) => {
    const otherSession = 'other-busy-queue-session';
    sessionsDb.createAppSession(otherSession, 'codex', '/tmp');
    sessionDraftsDb.enqueueChatMessage(
      h.userId, otherSession,
      { content: 'other session message', options: {}, attachments: [] },
      'shared-client-id',
    );
    const candidate = sessionDraftsDb.listQueuedMessages()[0];
    assert.equal(sessionDraftsDb.claimQueuedMessage(candidate), true);
    sessionDraftsDb.confirmQueuedMessageDispatch(candidate);

    assert.equal(sessionDraftsDb.hasSentChatMessage(h.userId, h.sessionId, 'shared-client-id'), false);
    const enqueued = sessionDraftsDb.enqueueChatMessage(
      h.userId, h.sessionId,
      { content: 'this session message', options: {}, attachments: [] },
      'shared-client-id',
    );
    assert.equal(enqueued.appended, true);
    assert.equal(enqueued.queuedMessage.id, 'shared-client-id');
  });
});
