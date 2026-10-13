import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionRuntimeDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord, CodexSessionState, ProviderRuntimeGateway } from '@/shared/index.js';
import { AppError } from '@/shared/index.js';

async function harness(runTest: (h: {
  userId: number; sessionId: string; runtime: ProviderRuntimeGateway; frames: AnyRecord[];
  socket: EventEmitter; calls: AnyRecord[]; state: CodexSessionState;
  send(control: AnyRecord, requestId?: string): void;
}) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-controls-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db'); await initializeDatabase();
  const sessionId = 'app-codex';
  const userId = Number(userDb.createUser('codex-test', 'hash').id);
  sessionsDb.createAppSession(sessionId, 'codex', root);
  const frames: AnyRecord[] = []; const calls: AnyRecord[] = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: (text: string) => frames.push(JSON.parse(text)) });
  const state: CodexSessionState = { runtime: 'app-server', mode: 'default', turnId: 't1', phase: 'running', goal: null, questions: [] };
  const runtime: ProviderRuntimeGateway = { hasRuntime: () => true, hasBackgroundWork: () => false,
    getState: () => state, getPendingApprovalsForSession: () => [], resolveToolApproval: () => {}, stopBackgroundTask: async () => false,
    abort: async () => false, run: async (_provider, content) => { calls.push({ run: content }); },
    control: async (provider, sid, action, options) => { calls.push({ provider, sid, action, options }); return state; } };
  handleChatConnection(socket as never, { user: { id: userId } } as never, { runtime });
  const send = (control: AnyRecord, requestId = 'request-1') => socket.emit('message', JSON.stringify({ type: 'chat.control', sessionId, requestId, control }));
  try { await runTest({ userId, sessionId, runtime, frames, socket, calls, state, send }); }
  finally {
    connectedClients.clear(); chatRunRegistry.clearAll(); closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const queued = { id: 'message-1', content: 'guide this', attachments: [{ path: '/etc/passwd' }] };

test('a delayed stop for a previous execution cannot interrupt its replacement', async () => {
  await harness(async (h) => {
    let aborts = 0;
    h.runtime.abort = async () => { aborts++; return true; };
    chatRunRegistry.startRun({ appSessionId: h.sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: h.userId });
    h.socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: h.sessionId, executionId: 'previous-execution' }));
    await settle();
    assert.equal(aborts, 0);
    assert.equal(h.frames.at(-1)?.ok, false);
    assert.equal(chatRunRegistry.isProcessing(h.sessionId), true);
  });
});

test('steer atomically owns the persisted message and repeats do not resend or resurrect it', async () => {
  await harness(async (h) => {
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: 'new composer text', queuedMessage: queued });
    h.send({ action: 'steer', messageId: queued.id, expectedTurnId: 't1' }); await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].action.content, queued.content);
    assert.deepEqual(h.calls[0].action.attachments, []);
    assert.equal(h.frames.at(-1)?.delivery, 'accepted');
    assert.equal(sessionDraftsDb.getDrafts(h.userId)[0].queuedMessage, null);
    h.send({ action: 'steer', messageId: queued.id, expectedTurnId: 't1' }); await settle();
    assert.equal(h.calls.length, 1);
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: 'later draft', queuedMessage: queued });
    assert.equal(sessionDraftsDb.getDrafts(h.userId)[0].queuedMessage, null);
  });
});

test('the queue dispatcher cannot claim a message while its steer acknowledgement is pending', async () => {
  await harness(async (h) => {
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: '', queuedMessage: queued });
    let accept!: () => void;
    h.runtime.control = async () => { await new Promise<void>((resolve) => { accept = resolve; }); return h.state; };
    h.send({ action: 'steer', messageId: queued.id, expectedTurnId: 't1' }); await settle();
    h.state.phase = 'idle'; h.state.turnId = null;
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 0);
    assert.throws(() => sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: '', queuedMessage: null }), /awaiting steering/);
    accept(); await settle();
    assert.equal(h.frames.at(-1)?.delivery, 'accepted');
  });
});

test('a native user echo keeps its accepted receipt when the RPC later times out', async () => {
  await harness(async (h) => {
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: 'new draft', queuedMessage: queued });
    h.runtime.control = async () => {
      sessionDraftsDb.confirmSteer(h.sessionId, 'request-1');
      throw new AppError('ACK timed out', { code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504 });
    };
    h.send({ action: 'steer', messageId: queued.id, expectedTurnId: 't1' }); await settle();
    assert.equal(h.frames.at(-1)?.ok, true);
    assert.equal(h.frames.at(-1)?.delivery, 'accepted');
    assert.equal(sessionDraftsDb.getDrafts(h.userId)[0].queuedMessage, null);
  });
});

test('a queue claim that wins first prevents the steer RPC from starting', async () => {
  await harness(async (h) => {
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: '', queuedMessage: queued });
    assert.equal(sessionDraftsDb.claimQueuedMessage(sessionDraftsDb.listQueuedMessages()[0]), true);
    h.send({ action: 'steer', messageId: queued.id, expectedTurnId: 't1' }); await settle();
    assert.equal(h.calls.length, 0); assert.equal(h.frames.at(-1)?.ok, false);
  });
});

test('uncertain delivery stays held until a native echo proves acceptance, even after a late timeout', async () => {
  await harness(async (h) => {
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: '', queuedMessage: queued });
    h.runtime.control = async () => { throw new AppError('No response', { code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504 }); };
    h.send({ action: 'steer', messageId: queued.id, expectedTurnId: 't1' }); await settle();
    assert.equal(sessionDraftsDb.getDrafts(h.userId)[0].queuedDelivery.status, 'unknown');
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 0);
    sessionDraftsDb.confirmSteer(h.sessionId, 'request-1');
    sessionDraftsDb.finishSteer(h.userId, h.sessionId, 'request-1', 'unknown', 'late timeout');
    assert.equal(sessionDraftsDb.getDrafts(h.userId)[0].queuedMessage, null);
  });
});

test('a rejected steer preserves the message until an explicit queue resume', async () => {
  await harness(async (h) => {
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: '', queuedMessage: queued });
    h.runtime.control = async () => { throw new AppError('Turn ended', { code: 'STALE_TURN', statusCode: 409 }); };
    h.send({ action: 'steer', messageId: queued.id, expectedTurnId: 't1' }); await settle();
    assert.equal(sessionDraftsDb.getDrafts(h.userId)[0].queuedDelivery.status, 'held');
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 0);
    h.send({ action: 'queue-resume' }, 'resume-1'); await settle();
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 1);
  });
});

test('failed stop never completes the run and scheduled interruption cannot start a replacement', async () => {
  await harness(async (h) => {
    const run = chatRunRegistry.startRun({ appSessionId: h.sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: h.userId })!;
    h.socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: h.sessionId })); await settle();
    assert.equal(run.status, 'running'); assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, true);
    assert.ok(!h.frames.some((frame) => frame.kind === 'complete'));
    const result = await runDetachedChatTurn({ sessionId: h.sessionId, userId: h.userId, content: 'scheduled', interruptActiveRun: true }, { runtime: h.runtime });
    assert.equal(result.started, false); assert.equal(h.calls.length, 0);
  });
});

test('native turn continuation transfers subscribers and changes replay execution identity', async () => {
  await harness(async (h) => {
    const run = chatRunRegistry.startRun({ appSessionId: h.sessionId, provider: 'codex', providerSessionId: null, connection: h.socket as never, userId: h.userId })!;
    run.writer.sendComplete({ exitCode: 0 });
    const writer = run.writer.nextTurn!();
    writer.send({ kind: 'text', id: 'new', content: 'second', provider: 'codex' });
    const current = chatRunRegistry.getRun(h.sessionId)!;
    assert.notEqual(current.executionId, run.executionId);
    assert.equal(current.status, 'running'); assert.equal(h.frames.at(-1)?.content, 'second');
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    assert.equal(current.status, 'running');
    h.socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: h.sessionId, executionId: run.executionId, lastSeq: 999 }] })); await settle();
    assert.equal(h.frames.filter((frame) => frame.content === 'second').length, 2);
  });
});
