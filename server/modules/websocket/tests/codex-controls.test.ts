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

test('model-provider controls validate and forward the current session selection', async () => {
  await harness(async (h) => {
    h.state.phase = 'idle'; h.state.turnId = null;
    h.send({ action: 'model-provider', modelProvider: ' beta ', model: ' new-model ' });
    await settle();
    assert.deepEqual(h.calls[0].action, { action: 'model-provider', modelProvider: 'beta', model: 'new-model' });
    assert.equal(h.calls[0].sid, h.sessionId);
    h.send({ action: 'model-provider', modelProvider: 'beta', model: null }, 'empty-model');
    await settle();
    assert.deepEqual(h.calls[1].action, { action: 'model-provider', modelProvider: 'beta', model: null });
    h.send({ action: 'model-provider', modelProvider: 'beta', model: '' }, 'invalid-selection');
    await settle();
    assert.equal(h.calls.length, 2);
    assert.equal(h.frames.at(-1)?.ok, false);
  });
});

for (const blocker of ['running', 'background', 'queued'] as const) {
  test(`service switching is rejected with ${blocker} work even when the client bypasses disabled controls`, async () => {
    await harness(async (h) => {
      h.state.phase = blocker === 'running' ? 'running' : 'idle';
      h.state.turnId = blocker === 'running' ? 't1' : null;
      h.state.activeModelSelection = { modelProvider: 'alpha', model: 'first-model' };
      h.runtime.hasBackgroundWork = () => blocker === 'background';
      if (blocker === 'queued') {
        sessionDraftsDb.saveDraft(h.userId, h.sessionId, { queuedMessages: [{ id: 'waiting', content: 'keep queued' }] });
        sessionRuntimeDb.update(h.sessionId, { queueHeld: true });
      }
      const before = sessionDraftsDb.getDrafts(h.userId);
      h.send({ action: 'model-provider', modelProvider: 'beta', model: 'next-model' });
      await settle();
      assert.equal(h.frames.at(-1)?.ok, false);
      assert.match(h.frames.at(-1)?.error, /Finish running tasks and empty the message queue/);
      assert.equal(h.calls.length, 0);
      assert.deepEqual(sessionDraftsDb.getDrafts(h.userId), before);
      // The restriction is service-specific; the existing model picker still
      // supports changing the next model within the current service.
      h.send({ action: 'model-provider', modelProvider: 'alpha', model: 'another-model' }, 'same-service');
      await settle();
      assert.equal(h.frames.at(-1)?.ok, true);
      assert.equal(h.calls.length, 1);
    });
  });
}

test('an empty model refuses direct and scheduled prompts without dispatching or interrupting work', async () => {
  await harness(async (h) => {
    h.state.phase = 'idle'; h.state.turnId = null;
    sessionRuntimeDb.update(h.sessionId, { modelSelection: { modelProvider: 'beta', model: null } });
    h.socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: h.sessionId, content: 'blocked', options: { model: 'old-model' } }));
    await settle();
    assert.equal(h.calls.length, 0);
    assert.ok(h.frames.some((frame) => frame.code === 'CODEX_MODEL_REQUIRED'));
    assert.equal(sessionsDb.getSessionById(h.sessionId)?.model, null);
    let aborted = false;
    h.runtime.abort = async () => { aborted = true; return true; };
    const active = chatRunRegistry.startRun({ appSessionId: h.sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: h.userId })!;
    const result = await runDetachedChatTurn({ sessionId: h.sessionId, userId: h.userId, content: 'due message', interruptActiveRun: true }, { runtime: h.runtime });
    assert.equal(result.started, false);
    assert.match(result.error!, /Choose a model/);
    assert.equal(aborted, false);
    assert.equal(active.status, 'running');
    assert.equal(h.calls.length, 0);
  });
});

for (const savedEffort of [null, 'low']) {
  test(`a selected Codex service preserves reasoning effort with saved effort ${savedEffort}`, async () => {
    await harness(async (h) => {
      h.state.phase = 'idle'; h.state.turnId = null;
      sessionRuntimeDb.update(h.sessionId, { runtime: 'app-server', modelSelection: { modelProvider: 'beta', model: 'remote-model' } });
      if (savedEffort) sessionsDb.setSessionEffort(h.sessionId, savedEffort);
      let receivedEffort: unknown;
      h.runtime.run = async (_provider, _content, options) => {
        receivedEffort = options.effort;
        options.onTurnStarting?.();
      };

      const result = await runDetachedChatTurn({
        sessionId: h.sessionId, userId: h.userId, content: 'test effort',
        options: { model: 'remote-model', effort: 'high' },
      }, { runtime: h.runtime });

      assert.equal(result.started, true);
      // New sessions keep the composer's choice; existing sessions retain
      // their confirmed effort even when a queued entry still carries high.
      const expected = savedEffort ?? 'high';
      assert.equal(receivedEffort, expected);
      assert.equal(sessionsDb.getSessionById(h.sessionId)?.effort, expected);
    });
  });
}

test('the first prompt names a session allocated for plan controls and broadcasts its title', async () => {
  await harness(async (h) => {
    sessionsDb.updateSessionCustomName(h.sessionId, 'Untitled Session');
    h.state.phase = 'idle';
    h.state.turnId = null;
    h.runtime.control = async (_provider, _sessionId, action) => {
      if (action.action === 'mode') h.state.mode = action.mode;
      return h.state;
    };
    h.send({ action: 'mode', mode: 'plan' });
    await settle();
    assert.equal(sessionsDb.getSessionById(h.sessionId)?.custom_name, 'Untitled Session');
    assert.equal(sessionsDb.getSessionById(h.sessionId)?.provider_session_id, null);

    let dispatched!: () => void;
    const dispatch = new Promise<void>((resolve) => { dispatched = resolve; });
    h.runtime.run = async (_provider, content) => { h.calls.push({ run: content }); dispatched(); };
    h.socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: h.sessionId, content: 'Design a reliable deployment plan' }));
    await dispatch;

    assert.equal(sessionsDb.getSessionById(h.sessionId)?.custom_name, 'Design a reliable deployment');
    assert.ok(h.frames.some((frame) => frame.kind === 'session_upserted'
      && frame.sessionId === h.sessionId && frame.session.summary === 'Design a reliable deployment'));
    assert.equal(h.calls.at(-1)?.run, 'Design a reliable deployment plan');
    assert.equal(h.state.mode, 'plan');
  });
});

test('the process stop control reaches the Codex runtime without accepting a client PID', async () => {
  await harness(async (h) => {
    h.send({ action: 'stop-app-server', pid: 1 }); await settle();
    assert.deepEqual(h.calls[0].action, { action: 'stop-app-server' });
    assert.equal(h.frames.at(-1)?.ok, true);
  });
});

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

test('invalid native controls are acknowledged without reserving a run or changing the queue', async () => {
  await harness(async (h) => {
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: 'draft', queuedMessage: queued });
    for (const action of [{ action: 'mode', mode: 'invalid' }, { action: 'goal', operation: 'set', tokenBudget: -1 }, { action: 'unknown' }]) {
      h.send(action);
      await settle();
      assert.equal(h.frames.at(-1)?.kind, 'control_result');
      assert.equal(h.frames.at(-1)?.ok, false);
      assert.equal(chatRunRegistry.getRun(h.sessionId), undefined);
      assert.deepEqual(sessionDraftsDb.getDrafts(h.userId)[0].queuedMessage, queued);
      assert.equal(h.calls.length, 0);
    }
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
