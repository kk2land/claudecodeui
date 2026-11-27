import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectTodosDb, projectsDb, sessionDraftsDb, sessionRuntimeDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchQueuedMessages } from '@/modules/scheduled-messages/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord, CodexSessionState, ProviderRuntimeGateway } from '@/shared/index.js';
import { AppError } from '@/shared/index.js';

type QueueChange = { sessionId: string; candidates: ReturnType<typeof sessionDraftsDb.listQueuedMessages> };

async function harness(runTest: (h: {
  userId: number; sessionId: string; projectId: string; runtime: ProviderRuntimeGateway; frames: AnyRecord[];
  socket: EventEmitter; calls: AnyRecord[]; state: CodexSessionState; queueChanges: QueueChange[];
  send(control: AnyRecord, requestId?: string): void;
}) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-controls-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db'); await initializeDatabase();
  const sessionId = 'app-codex';
  const userId = Number(userDb.createUser('codex-test', 'hash').id);
  sessionsDb.createAppSession(sessionId, 'codex', root);
  const createdProject = projectsDb.createProjectPath(root);
  assert.ok(createdProject.project);
  const projectId = createdProject.project.project_id;
  const frames: AnyRecord[] = []; const calls: AnyRecord[] = [];
  const queueChanges: QueueChange[] = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: (text: string) => frames.push(JSON.parse(text)) });
  const state: CodexSessionState = { runtime: 'app-server', mode: 'default', turnId: 't1', phase: 'running', goal: null, questions: [] };
  const runtime: ProviderRuntimeGateway = { hasRuntime: () => true, hasBackgroundWork: () => false,
    steer: async () => false,
    askSideQuestion: async () => ({ status: 'error', error: 'No side questions here.', answer: '' }),
    getState: () => state, getPendingApprovalsForSession: () => [], resolveToolApproval: () => {}, stopBackgroundTask: async () => false,
    abort: async () => false, run: async (_provider, content, options) => { calls.push({ run: content, options }); },
    control: async (provider, sid, action, options) => { calls.push({ provider, sid, action, options }); return state; } };
  handleChatConnection(socket as never, { user: { id: userId } } as never, {
    runtime,
    notifyQueueChanged: (changedSessionId) => queueChanges.push({
      sessionId: changedSessionId,
      candidates: sessionDraftsDb.listQueuedMessages(changedSessionId),
    }),
  });
  const send = (control: AnyRecord, requestId = 'request-1') => socket.emit('message', JSON.stringify({ type: 'chat.control', sessionId, requestId, control }));
  try { await runTest({ userId, sessionId, projectId, runtime, frames, socket, calls, state, queueChanges, send }); }
  finally {
    connectedClients.clear(); chatRunRegistry.clearAll(); closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const queued = { id: 'message-1', content: 'guide this', attachments: [{ path: '/etc/passwd' }] };

for (const mode of ['app-server', 'sdk'] as const) {
  test(`opening a chat in ${mode} mode records access while background subscriptions do not`, async (t) => {
    let now = Date.parse('2026-10-31T12:00:00.123Z');
    t.mock.method(Date, 'now', () => now);
    await harness(async (h) => {
      h.state.runtime = mode;
      h.state.phase = 'idle';
      h.state.turnId = null;
      sessionRuntimeDb.update(h.sessionId, { runtime: mode });
      const before = sessionsDb.getSessionById(h.sessionId)!;
      assert.equal(before.last_opened_at, null);

      h.send({ action: 'state' });
      await settle();
      const opened = sessionsDb.getSessionById(h.sessionId)!;
      assert.equal(h.frames.at(-1)?.ok, true);
      assert.equal(opened.last_opened_at, new Date(now).toISOString());
      assert.equal(opened.updated_at, before.updated_at);

      now += 60_000;
      h.socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: h.sessionId, lastSeq: 0 }] }));
      await settle();
      assert.equal(sessionsDb.getSessionById(h.sessionId)?.last_opened_at, opened.last_opened_at);
    });
  });
}

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

test('compact reserves the session until the native turn ends', async () => {
  await harness(async (h) => {
    h.send({ action: 'compact' });
    await settle();
    assert.deepEqual(h.calls[0].action, { action: 'compact' });
    assert.equal(h.frames.at(-1)?.ok, true);
    assert.equal(chatRunRegistry.isProcessing(h.sessionId), true);
    assert.equal(chatRunRegistry.getSnapshot(h.sessionId)?.dispatch.origin, 'control');

    h.send({ action: 'compact' }, 'second-compaction');
    await settle();
    assert.equal(h.frames.at(-1)?.code, 'RUN_IN_PROGRESS');
    assert.equal(h.calls.length, 1);

    chatRunRegistry.completeRun(h.sessionId, { exitCode: 0 });
    assert.equal(chatRunRegistry.isProcessing(h.sessionId), false);
  });
});

test('a rejected compact request releases its reserved session', async () => {
  await harness(async (h) => {
    h.runtime.control = async () => { throw new AppError('No native thread.', { code: 'CODEX_COMPACTION_NEEDS_SESSION' }); };
    h.send({ action: 'compact' });
    await settle();
    assert.equal(h.frames.at(-1)?.code, 'CODEX_COMPACTION_NEEDS_SESSION');
    assert.equal(chatRunRegistry.isProcessing(h.sessionId), false);
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
    assert.equal(h.frames.at(-1)?.code, undefined);
    assert.equal(chatRunRegistry.isProcessing(h.sessionId), true);
  });
});

test('a confirmed stop response carries no failure code', async () => {
  await harness(async (h) => {
    h.runtime.abort = async () => true;
    const run = chatRunRegistry.startRun({ appSessionId: h.sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: h.userId })!;
    h.socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: h.sessionId, requestId: 'stop-ok' })); await settle();
    assert.equal(h.frames.at(-1)?.ok, true);
    assert.equal(h.frames.at(-1)?.code, undefined);
    assert.equal(run.status, 'completed');
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

test('a rejected Codex control keeps its typed code beside the readable message', async () => {
  await harness(async (h) => {
    h.runtime.control = async () => {
      throw new AppError('This conversation runs on "alpha". Create a branch to use "beta".', {
        code: 'CODEX_MODEL_PROVIDER_FORK_REQUIRED', statusCode: 409,
      });
    };
    h.send({ action: 'goal', operation: 'get' });
    await settle();
    const frame = h.frames.at(-1)!;
    assert.equal(frame.kind, 'control_result');
    assert.equal(frame.ok, false);
    assert.equal(frame.code, 'CODEX_MODEL_PROVIDER_FORK_REQUIRED');
    assert.match(frame.error, /Create a branch/);
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

test('an opt-in steer timeout stays unknown until a native echo proves acceptance', async () => {
  await harness(async (h) => {
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: '', queuedMessage: queued });
    h.runtime.control = async () => { throw new AppError('No response', { code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504 }); };
    h.send({ action: 'steer', messageId: queued.id, expectedTurnId: 't1', queueIfTurnEnded: true }); await settle();
    assert.equal(h.frames.at(-1)?.delivery, 'unknown');
    assert.equal(h.frames.at(-1)?.code, 'CODEX_APP_SERVER_TIMEOUT');
    assert.equal(sessionDraftsDb.getDrafts(h.userId)[0].queuedDelivery.status, 'unknown');
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 0);
    assert.deepEqual(h.queueChanges, []);
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
    assert.equal(h.frames.at(-1)?.delivery, 'rejected');
    assert.equal(h.frames.at(-1)?.code, 'STALE_TURN');
    assert.equal(sessionDraftsDb.getDrafts(h.userId)[0].queuedDelivery.status, 'held');
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 0);
    assert.deepEqual(h.queueChanges, []);
    h.send({ action: 'queue-resume' }, 'resume-1'); await settle();
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 1);
    assert.deepEqual(h.queueChanges.map(({ sessionId }) => sessionId), [h.sessionId]);
  });
});

test('a turn ending after ifEmpty append hands the opted-in steer ticket to the dispatcher', async () => {
  await harness(async (h) => {
    h.state.mode = 'plan';
    const { queuedMessage } = sessionDraftsDb.appendQueuedMessage(h.userId, h.sessionId, {
      content: 'Guide the plan', options: { clientMessageId: 'voice-message' }, attachments: [],
    }, true);
    const [originalHead] = sessionDraftsDb.listQueuedMessages(h.sessionId);
    h.state.phase = 'idle';
    h.state.turnId = null;
    const control = h.runtime.control!;
    h.runtime.control = async (...args) => {
      await control(...args);
      throw new AppError('Turn ended', { code: 'STALE_TURN', statusCode: 409 });
    };

    const steer = { action: 'steer', messageId: queuedMessage.id, expectedTurnId: 't1', queueIfTurnEnded: true };
    h.send(steer);
    await settle();
    const { ok, code, delivery, error } = h.frames.at(-1)!;
    assert.deepEqual({ ok, code, delivery, error }, { ok: false, code: 'STALE_TURN', delivery: 'rejected', error: 'Turn ended' });
    assert.deepEqual(h.queueChanges, [{ sessionId: h.sessionId, candidates: [originalHead] }]);
    assert.deepEqual(sessionDraftsDb.getDrafts(h.userId)[0].queuedDelivery, { status: 'queued', requestId: null, error: null });
    assert.deepEqual(sessionDraftsDb.listQueuedMessages(h.sessionId), [originalHead]);

    h.send(steer);
    await settle();
    assert.equal(h.frames.at(-1)?.delivery, 'rejected');
    assert.equal(h.frames.at(-1)?.error, 'Turn ended');
    assert.equal(h.queueChanges.length, 1);
    assert.deepEqual(h.calls.map(({ action }) => action), [{
      action: 'steer', expectedTurnId: 't1', requestId: 'request-1', content: queuedMessage.content, attachments: [],
    }]);

    assert.equal(await dispatchQueuedMessages(h.runtime, { sessionId: h.sessionId }), 1);
    assert.equal(await dispatchQueuedMessages(h.runtime, { sessionId: h.sessionId }), 0);
    assert.equal(h.calls[1].run, queuedMessage.content);
    assert.equal(h.calls[1].options.clientMessageId, 'voice-message');
  });
});

test('a steer takes the voice flag only from its claimed queue entry', async () => {
  await harness(async (h) => {
    const { queuedMessage: spoken } = sessionDraftsDb.appendQueuedMessage(h.userId, h.sessionId, {
      content: 'spoken follow-up', options: { inputSource: 'voice' }, attachments: [],
    }, true);
    h.send({ action: 'steer', messageId: spoken.id, expectedTurnId: 't1' });
    await settle();
    assert.equal(h.calls.at(-1)?.action.inputSource, 'voice');
    assert.equal(h.frames.at(-1)?.delivery, 'accepted');

    // A voice flag on the external control body is not trusted or forwarded.
    const { queuedMessage: typed } = sessionDraftsDb.appendQueuedMessage(h.userId, h.sessionId, {
      content: 'typed follow-up', options: {}, attachments: [],
    }, true);
    h.send({ action: 'steer', messageId: typed.id, expectedTurnId: 't1', inputSource: 'voice' }, 'request-2');
    await settle();
    assert.equal('inputSource' in (h.calls.at(-1)?.action ?? {}), false);
  });
});

test('a user Stop keeps an opted-in stale steer held after the runtime returns to idle', async () => {
  await harness(async (h) => {
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { queuedMessage: queued });
    let rejectSteer!: (error: Error) => void;
    h.runtime.control = async () => new Promise((_, reject) => { rejectSteer = reject; });
    h.runtime.abort = async () => {
      h.state.phase = 'idle';
      h.state.turnId = null;
      return true;
    };
    h.send({ action: 'steer', messageId: queued.id, expectedTurnId: 't1', queueIfTurnEnded: true });
    await settle();
    assert.equal(sessionDraftsDb.getDrafts(h.userId)[0].queuedDelivery.status, 'steering');

    h.socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: h.sessionId, requestId: 'stop' }));
    await settle();
    assert.equal(h.frames.at(-1)?.ok, true);
    assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, true);

    rejectSteer(new AppError('Turn ended', { code: 'STALE_TURN', statusCode: 409 }));
    await settle();
    assert.equal(h.frames.at(-1)?.delivery, 'rejected');
    assert.equal(h.frames.at(-1)?.code, 'STALE_TURN');
    const draft = sessionDraftsDb.getDrafts(h.userId)[0];
    assert.equal(draft.queuedDelivery.status, 'held');
    assert.deepEqual(draft.queuedMessages, [queued]);
    assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, true);
    assert.equal(sessionDraftsDb.listQueuedMessages(h.sessionId).length, 0);
    assert.deepEqual(h.queueChanges, []);
  });
});

test('failed stop never completes the run and scheduled interruption cannot start a replacement', async () => {
  await harness(async (h) => {
    const run = chatRunRegistry.startRun({ appSessionId: h.sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: h.userId })!;
    h.socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: h.sessionId })); await settle();
    assert.equal(run.status, 'running'); assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, true);
    assert.equal(h.frames.at(-1)?.ok, false);
    assert.equal(h.frames.at(-1)?.code, 'STOP_NOT_CONFIRMED');
    assert.ok(!h.frames.some((frame) => frame.kind === 'complete'));
    const result = await runDetachedChatTurn({ sessionId: h.sessionId, userId: h.userId, content: 'scheduled', interruptActiveRun: true }, { runtime: h.runtime });
    assert.equal(result.started, false); assert.equal(h.calls.length, 0);
  });
});

test('an explicit prompt after Stop resumes an empty queue before the next Worker result', async () => {
  await harness(async (h) => {
    h.state.phase = 'idle';
    h.state.turnId = null;
    h.state.workerEnabled = true;
    h.runtime.abort = async () => true;
    h.runtime.getState = () => ({ ...h.state, queueHeld: sessionRuntimeDb.get(h.sessionId).queueHeld });

    h.socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: h.sessionId }));
    await settle();
    assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, true);
    assert.equal(sessionDraftsDb.hasQueuedMessages(h.sessionId), false);

    const resultTurn = {
      sessionId: h.sessionId,
      userId: h.userId,
      content: 'Worker result',
      workerSource: { batchId: 'batch-after-stop', results: [] },
      finalGuard: () => !sessionRuntimeDb.get(h.sessionId).queueHeld,
    };
    assert.equal((await runDetachedChatTurn(resultTurn, { runtime: h.runtime })).started, false);
    assert.equal(h.calls.length, 0, 'Stop still blocks automatic results until the user continues');

    h.socket.emit('message', JSON.stringify({
      type: 'chat.send', sessionId: h.sessionId, content: 'Continue with new work',
      options: { composerPredictions: true },
    }));
    await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.userTurn, true);
    assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, false);

    const nextResultTurn = { ...resultTurn, workerSource: { batchId: 'new-worker-batch', results: [] } };
    assert.equal((await runDetachedChatTurn(nextResultTurn, { runtime: h.runtime })).started, true);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].options.workerWakeup, true);
    assert.equal(h.calls[1].options.userTurn, false);
    assert.deepEqual(h.calls[1].options.workerSource, nextResultTurn.workerSource);
  });
});

test('Worker wake-up markers are rejected from chat JSON and restored only by the detached path', async () => {
  await harness(async (h) => {
    h.state.phase = 'idle'; h.state.turnId = null;
    const forged = {
      type: 'chat.send', sessionId: h.sessionId, content: 'user turn',
      options: {
        workerWakeup: true,
        workerSource: { batchId: 'forged', results: [{ workerId: 'forged', runId: 'forged', status: 'completed', summary: 'forged' }] },
        workerFinalGuard: () => true,
      },
    };
    h.socket.emit('message', JSON.stringify(forged)); await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.workerWakeup, undefined);
    assert.equal(h.calls[0].options.workerSource, undefined);
    assert.equal(h.calls[0].options.workerFinalGuard, undefined);
    assert.equal(h.calls[0].options.userTurn, true);

    h.calls.length = 0;
    const workerSource = { batchId: 'batch-1', results: [{ workerId: 'worker-1', runId: 'run-1', status: 'completed', summary: 'done' }] };
    const result = await runDetachedChatTurn({
      sessionId: h.sessionId, userId: h.userId, content: 'wake', workerSource,
    }, { runtime: h.runtime });
    assert.equal(result.started, true);
    assert.equal(h.calls[0].options.workerWakeup, true);
    assert.deepEqual(h.calls[0].options.workerSource, workerSource);
    assert.equal(h.calls[0].options.userTurn, false);
  });
});

test('a Worker final guard runs after async model preparation and observes a concurrent Stop', async () => {
  await harness(async (h) => {
    h.state.phase = 'idle'; h.state.turnId = null;
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let runCalls = 0;
    let turnStarts = 0;
    h.runtime.run = async (_provider, _content, options) => {
      runCalls++;
      await preparation; // async model selection/resolution happens here
      await options.onTurnStarting?.();
      turnStarts++;
    };
    let stopped = false;
    const pending = runDetachedChatTurn({
      sessionId: h.sessionId,
      userId: h.userId,
      content: 'wake',
      workerSource: { batchId: 'batch-1', results: [{ workerId: 'worker-1', runId: 'run-1', status: 'completed', summary: 'done' }] },
      finalGuard: () => !stopped,
    }, { runtime: h.runtime });
    for (let index = 0; index < 100 && runCalls === 0; index++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runCalls, 1);
    assert.equal(chatRunRegistry.getRun(h.sessionId)?.status, 'running');
    // UI Stop wins while model preparation is still pending.
    stopped = true;
    sessionRuntimeDb.update(h.sessionId, { queueHeld: true });
    releasePreparation();
    const result = await pending;
    assert.equal(result.started, false);
    assert.equal(turnStarts, 0);
    assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, true);
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

const todoQueued = { ...queued, options: { todoIds: ['todo-steer'] } };
function createSteerTodo(userId: number, projectId: string): void {
  projectTodosDb.create({ id: 'todo-steer', userId, projectId, content: 'todo', attachments: [], createdAt: new Date().toISOString() });
}

test('a native steer confirms its todo source only after the control RPC succeeds', async () => {
  await harness(async (h) => {
    createSteerTodo(h.userId, h.projectId);
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: '', queuedMessage: todoQueued });
    h.send({ action: 'steer', messageId: todoQueued.id, expectedTurnId: 't1' }); await settle();
    assert.equal(h.frames.at(-1)?.delivery, 'accepted');
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-steer')?.status, 'submitted');
  });
});

test('a rejected native steer leaves its todo source pending', async () => {
  await harness(async (h) => {
    createSteerTodo(h.userId, h.projectId);
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: '', queuedMessage: todoQueued });
    h.runtime.control = async () => { throw new AppError('Turn ended', { code: 'STALE_TURN', statusCode: 409 }); };
    h.send({ action: 'steer', messageId: todoQueued.id, expectedTurnId: 't1' }); await settle();
    assert.equal(h.frames.at(-1)?.delivery, 'rejected');
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-steer')?.status, 'pending');
  });
});

test('an unknown native steer keeps its todo source pending until a native echo confirms', async () => {
  await harness(async (h) => {
    createSteerTodo(h.userId, h.projectId);
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, { text: '', queuedMessage: todoQueued });
    h.runtime.control = async () => { throw new AppError('No response', { code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504 }); };
    h.send({ action: 'steer', messageId: todoQueued.id, expectedTurnId: 't1' }); await settle();
    assert.equal(h.frames.at(-1)?.delivery, 'unknown');
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-steer')?.status, 'pending');
    // A late native echo accepts the queue receipt, but only the steer RPC is
    // the todo-submission proof, so the source stays pending.
    sessionDraftsDb.confirmSteer(h.sessionId, 'request-1');
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-steer')?.status, 'pending');
  });
});
