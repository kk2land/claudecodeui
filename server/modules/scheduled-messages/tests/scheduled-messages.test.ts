import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scheduledMessagesDb, sessionDraftsDb, sessionRuntimeDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import type { ProviderRuntimeGateway } from '@/shared/index.js';
import {
  closeScheduledMessageDispatcher,
  dispatchDueScheduledMessages,
  dispatchQueuedMessages,
  initializeScheduledMessageDispatcher,
  requestQueuedMessageDispatch,
} from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry, connectedClients, onChatRunCompleted } from '@/modules/websocket/index.js';

const SESSION_ID = 'scheduled-session';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-messages-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('scheduler', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Scheduled session');
    await runTest(Number(user.id));
  } finally {
    chatRunRegistry.clearAll();
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

/** Waits for a dispatcher pass that was started without a promise to await. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'condition was not reached');
}

function createRuntime(
  runs: RunCall[],
  behaviour: 'ok' | 'throw' = 'ok',
  aborts: string[] = [],
  hasBackgroundWork: (sessionId: string) => boolean = () => false,
) {
  return {
    hasRuntime: () => true,
    hasBackgroundWork,
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      if (behaviour === 'throw') {
        throw new Error('provider exploded');
      }
      runs.push({ provider, command, options });
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
  } as never;
}

/** A chat socket that records what it is sent, standing in for an open browser tab. */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  /** The scheduled-message announcements among everything this socket received. */
  announcements(): Array<Record<string, unknown>> {
    return this.frames.filter((frame) => frame.kind === 'scheduled_messages_changed');
  }
}

function openTab(): FakeConnection {
  const connection = new FakeConnection();
  connectedClients.add(connection as never);
  return connection;
}

test('a message due in the past is sent on the next pass, not skipped', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The server was down when this came due.
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'run the nightly checks',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const sent = await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(sent, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'run the nightly checks');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('Codex queued input uses the latest session model and remains queued if provider setup fails', async () => {
  await withIsolatedDatabase(async (userId) => {
    const sessionId = 'codex-provider-queue';
    sessionsDb.createAppSession(sessionId, 'codex', '/tmp', 'Provider queue');
    sessionRuntimeDb.update(sessionId, { modelSelection: { modelProvider: 'beta', model: 'new-model' } });
    sessionDraftsDb.saveDraft(userId, sessionId, { queuedMessages: [
      { id: 'head', content: 'first pending', options: { model: 'old-model' } },
      { id: 'tail', content: 'second pending', options: { model: 'old-model' } },
    ] });
    let failSetup = true;
    const received: string[] = [];
    const runtime: ProviderRuntimeGateway = {
      hasRuntime: () => true, hasBackgroundWork: () => false, abort: async () => true,
      stopBackgroundTask: async () => false, resolveToolApproval: () => {}, getPendingApprovalsForSession: () => [],
      isQueueBlocked: (id) => sessionRuntimeDb.get(id).queueHeld,
      async run(_provider, command, options) {
        assert.equal(options.model, 'new-model');
        assert.equal(sessionsDb.getSessionById(sessionId)?.model, 'new-model', 'the stale queue model must not overwrite the session');
        if (failSetup) {
          sessionRuntimeDb.update(sessionId, { queueHeld: true });
          throw new Error('provider resume rejected before input');
        }
        options.onTurnStarting();
        received.push(command);
      },
    };
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessages.map((message) => (message as { id: string }).id), ['head', 'tail']);
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.deepEqual(received, []);
    failSetup = false;
    sessionRuntimeDb.update(sessionId, { queueHeld: false });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(received, ['first pending']);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessages.map((message) => (message as { id: string }).id), ['tail']);
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(received, ['first pending', 'second pending']);
  });
});

test('empty Codex models keep every queued message intact and only dispatch after an explicit model choice', async () => {
  await withIsolatedDatabase(async (userId) => {
    const sessionId = 'codex-empty-model';
    sessionsDb.createAppSession(sessionId, 'codex', '/tmp');
    sessionRuntimeDb.update(sessionId, { modelSelection: { modelProvider: 'beta', model: null } });
    sessionDraftsDb.saveDraft(userId, sessionId, { queuedMessages: [
      { id: 'first', content: 'first queued', options: { model: 'stale-model' } },
      { id: 'second', content: 'second queued', options: { model: 'stale-model' } },
    ] });
    const before = sessionDraftsDb.getDrafts(userId);
    const runs: RunCall[] = [];
    const runtime: ProviderRuntimeGateway = createRuntime(runs);
    runtime.isQueueBlocked = providerRuntimeService.isQueueBlocked;
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), before);
    assert.equal(runs.length, 0);
    sessionRuntimeDb.update(sessionId, { modelSelection: { modelProvider: 'beta', model: 'chosen-model' } });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs[0].options.model, 'chosen-model');
    assert.equal(runs[0].command, 'first queued');
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessages.map((message) => (message as { id: string }).id), ['second']);
  });
});

test('a queued message is sent by the server without a browser connection', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: {
        content: 'continue on the VPS',
        options: { model: 'claude-opus-5' },
        attachments: [{ path: '/tmp/upload.png' }],
      },
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'continue on the VPS');
    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.deepEqual(runs[0].options.attachments, []);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('retired GPT Web queues remain stored and due schedules fail without starting a runtime', async () => {
  await withIsolatedDatabase(async (userId) => {
    const projectPath = sessionsDb.getSessionById(SESSION_ID)!.project_path!;
    sessionsDb.createAppSession('legacy-web', 'gptweb', projectPath);
    const queuedMessage = { content: 'keep this pending message' };
    sessionDraftsDb.saveDraft(userId, 'legacy-web', { text: '', queuedMessage });
    scheduledMessagesDb.create({ userId, sessionId: 'legacy-web', content: 'scheduled legacy message',
      options: {}, scheduledFor: new Date(Date.now() - 60_000) });

    assert.equal(await dispatchQueuedMessages(providerRuntimeService), 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, queuedMessage);
    assert.equal(await dispatchDueScheduledMessages(providerRuntimeService), 1);
    const scheduled = scheduledMessagesDb.listForSession(userId, 'legacy-web')[0];
    assert.equal(scheduled.status, 'failed');
    assert.match(scheduled.failure_reason!, /Provider "gptweb" is not available/);
    assert.equal(chatRunRegistry.getRun('legacy-web'), undefined);
    assert.ok(sessionsDb.getSessionById('legacy-web'));
  });
});

test('a queued message stays pending while its session is busy', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after this run' },
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after this run',
    });
  });
});

test('a provider-owned queue hold blocks dispatch until explicitly released', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'after the hold' } });
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs) as ProviderRuntimeGateway;
    let held = true;
    runtime.isQueueBlocked = (sessionId) => {
      assert.equal(sessionId, SESSION_ID);
      return held;
    };
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 1);
    held = false;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs.length, 1);
  });
});

test('stopping app-server preserves another session queue while SDK and Claude queues keep dispatching', async () => {
  await withIsolatedDatabase(async (userId) => {
    for (const id of ['stop-session', 'native-queue', 'sdk-queue']) sessionsDb.createAppSession(id, 'codex', '/tmp');
    sessionRuntimeDb.update('stop-session', { runtime: 'app-server' });
    sessionRuntimeDb.update('native-queue', { runtime: 'app-server' });
    sessionRuntimeDb.update('sdk-queue', { runtime: 'sdk' });
    for (const id of ['native-queue', 'sdk-queue', SESSION_ID]) {
      sessionDraftsDb.saveDraft(userId, id, { text: '', queuedMessage: { id, content: `pending ${id}` } });
    }
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs) as ProviderRuntimeGateway;
    runtime.isQueueBlocked = providerRuntimeService.isQueueBlocked;
    const stopping = providerRuntimeService.control('codex', 'stop-session', { action: 'stop-app-server' }, {}, { send() {} });
    assert.equal(await dispatchQueuedMessages(runtime), 2);
    await stopping;
    assert.deepEqual(runs.map(({ command }) => command).sort(), [`pending ${SESSION_ID}`, 'pending sdk-queue'].sort());
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.deepEqual(sessionDraftsDb.listQueuedMessages().map(({ queuedMessage }) => queuedMessage), [
      { id: 'native-queue', content: 'pending native-queue' },
    ]);
    sessionRuntimeDb.update('native-queue', { queueHeld: false });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs.at(-1)?.command, 'pending native-queue');
  });
});

test('a queued message waits for background work its session\'s last turn left running', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after the background job' },
    });
    // Turn A ended, so its run is completed, but it backgrounded a command
    // that is still running under A's CLI process.
    const runA = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    runA!.writer.sendComplete({ exitCode: 0 });
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

    let backgroundWork = true;
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, 'ok', [], (sessionId) => sessionId === SESSION_ID && backgroundWork);

    // Starting B now would replace that process and stop the command.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after the background job',
    });

    // Once the work has reported back, B goes on the next pass.
    backgroundWork = false;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'send after the background job');
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});


test('a FIFO queue dispatches one entry per pass, in order, and keeps the tail', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [
        { id: 'first', content: 'first turn' },
        { id: 'second', content: 'second turn' },
        { id: 'third', content: 'third turn' },
      ],
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);

    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(runs.map(({ command }) => command), ['first turn']);
    assert.deepEqual(
      sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.map((entry) => (entry as { id: string }).id),
      ['second', 'third'],
      'only the head leaves the queue',
    );

    // A pass while a turn is still running must not take the next one.
    assert.equal(await dispatchQueuedMessages(createRuntime([], 'ok', [], () => true)), 0);

    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(runs.map(({ command }) => command), ['first turn', 'second turn']);
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(runs.map(({ command }) => command), ['first turn', 'second turn', 'third turn']);
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a dispatch that cannot start puts the head back in front of the untouched tail', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ id: 'head', content: 'head turn' }, { id: 'tail', content: 'tail turn' }],
    });

    const claimed = sessionDraftsDb.listQueuedMessages();
    assert.equal(claimed.length, 1, 'one candidate per scope');
    assert.equal(sessionDraftsDb.claimQueuedMessage(claimed[0]), true);
    assert.deepEqual(
      sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.map((entry) => (entry as { id: string }).id),
      ['tail'],
    );

    sessionDraftsDb.restoreQueuedMessage(claimed[0]);
    const restored = sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? [];
    assert.deepEqual(restored.map((entry) => (entry as { id: string }).id), ['head', 'tail']);

    // Restoring twice must not duplicate the head.
    sessionDraftsDb.restoreQueuedMessage(claimed[0]);
    assert.equal((sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? []).length, 2);
  });
});

test('a delayed browser snapshot cannot resurrect the claimed head while it runs', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      queuedMessages: [{ id: 'a', content: 'one' }, { id: 'b', content: 'two' }, { id: 'c', content: 'three' }],
    });

    let releaseRun!: () => void;
    const running = new Promise<void>((resolve) => { releaseRun = resolve; });
    const runs: string[] = [];
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      run: async (_provider: string, command: string) => {
        runs.push(command);
        await running;
      },
      abort: async () => true,
    } as never;

    const dispatch = dispatchQueuedMessages(runtime);
    // Wait until the head has been claimed and its run is in flight.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(runs, ['one']);
    assert.deepEqual(
      sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.map((entry) => (entry as { id: string }).id),
      ['b', 'c'],
    );

    // A browser tab that still shows the pre-claim snapshot PUTs it back.
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      queuedMessages: [
        { id: 'a', content: 'one' },
        { id: 'b', content: 'two' },
        { id: 'c', content: 'three' },
      ],
    });
    assert.deepEqual(
      sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.map((entry) => (entry as { id: string }).id),
      ['b', 'c'],
      'the in-flight turn is filtered out of the stale snapshot',
    );

    releaseRun();
    await dispatch;
    assert.deepEqual(runs, ['one'], 'the in-flight turn is never dispatched twice');
  });
});

test('restore and a concurrent append together never exceed the cap or drop the tail', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      queuedMessages: [{ id: 'a', content: 'one' }, { id: 'b', content: 'two' }, { id: 'c', content: 'three' }],
    });
    const claimed = sessionDraftsDb.listQueuedMessages();
    assert.equal(sessionDraftsDb.claimQueuedMessage(claimed[0]), true);

    // The claimed turn still reserves its slot: a fourth append is refused.
    assert.throws(
      () => sessionDraftsDb.saveDraft(userId, SESSION_ID, {
        queuedMessages: [
          { id: 'b', content: 'two' }, { id: 'c', content: 'three' }, { id: 'd', content: 'four' },
        ],
      }),
      (error: Error & { code?: string }) => error.code === 'QUEUE_LIMIT_REACHED',
    );

    // Restoring the claim puts the head back in front of the untouched tail.
    sessionDraftsDb.restoreQueuedMessage(claimed[0]);
    const restored = sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? [];
    assert.deepEqual(restored.map((entry) => (entry as { id: string }).id), ['a', 'b', 'c']);
    assert.equal(restored.length, 3);
  });
});

test('a provider-level dispatch failure consumes the head but keeps the queued tail', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ id: 'exploding', content: 'will fail' }, { id: 'kept', content: 'still queued' }],
    });

    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      run: async () => { throw new Error('provider exploded'); },
      abort: async () => true,
    } as never;

    assert.equal(await dispatchQueuedMessages(runtime), 1);
    // The failed turn did reach the provider and may have run, so retrying it
    // automatically could duplicate a turn. What must never happen is the
    // untouched tail disappearing with it.
    assert.deepEqual(
      sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.map((entry) => (entry as { id: string }).id),
      ['kept'],
      'the tail stays queued when the head fails',
    );
    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.deepEqual(runs.map(({ command }) => command), ['still queued']);
  });
});

test('a dispatch rejected before admission restores the head and can be retried', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ id: 'head', content: 'must not be lost' }, { id: 'tail', content: 'still queued' }],
    });

    const unavailable = {
      // Resolving the provider throws before a run is reserved, so the turn was
      // never admitted and the claim must be rolled back rather than retained.
      hasRuntime: () => { throw new Error('provider lookup failed'); },
      hasBackgroundWork: () => false,
      run: async () => { throw new Error('must not run'); },
    } as never;

    assert.equal(await dispatchQueuedMessages(unavailable), 1);
    assert.deepEqual(
      sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.map((entry) => (entry as { id: string }).id),
      ['head', 'tail'],
      'the unadmitted head and the untouched tail are both still queued',
    );

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.deepEqual(runs.map(({ command }) => command), ['must not be lost']);
    assert.deepEqual(
      sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.map((entry) => (entry as { id: string }).id),
      ['tail'],
    );
  });
});

test('cancelling a queued entry leaves the rest of the queue alone', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ id: 'keep-1', content: 'one' }, { id: 'drop', content: 'two' }, { id: 'keep-2', content: 'three' }],
    });

    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      queuedMessages: (sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? [])
        .filter((entry) => (entry as { id: string }).id !== 'drop'),
    });

    assert.deepEqual(
      sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.map((entry) => (entry as { id: string }).id),
      ['keep-1', 'keep-2'],
    );
    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.deepEqual(runs.map(({ command }) => command), ['one']);
    assert.equal((sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? []).length, 1);
  });
});

test('a queued message can be steered by id without reordering the queue', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ id: 'first', content: 'one' }, { id: 'second', content: 'two' }],
    });

    const claim = sessionDraftsDb.beginSteer(userId, SESSION_ID, 'first', 'request-1');
    assert.equal((claim.queuedMessage as { id: string }).id, 'first');
    sessionDraftsDb.finishSteer(userId, SESSION_ID, 'request-1', 'accepted');

    assert.deepEqual(
      sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.map((entry) => (entry as { id: string }).id),
      ['second'],
      'accepting a steer removes only its own entry',
    );
    assert.equal(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage && (sessionDraftsDb.getDrafts(userId)[0]!.queuedMessage as { id: string }).id, 'second');
  });
});

test('only the queue head can be steered; a later entry stays queued in place', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ id: 'first', content: 'one' }, { id: 'second', content: 'two' }],
    });

    assert.throws(
      () => sessionDraftsDb.beginSteer(userId, SESSION_ID, 'second', 'request-tail'),
      (error: Error & { code?: string }) => error.code === 'QUEUE_NOT_HEAD',
    );
    assert.deepEqual(
      sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.map((entry) => (entry as { id: string }).id),
      ['first', 'second'],
    );
  });
});

test('unknown steer recovery preserves every other queued entry', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ id: 'uncertain', content: 'maybe sent' }, { id: 'tail', content: 'definitely queued' }],
    });
    sessionDraftsDb.beginSteer(userId, SESSION_ID, 'uncertain', 'request-2');
    sessionDraftsDb.finishSteer(userId, SESSION_ID, 'request-2', 'unknown', 'no acknowledgement');

    sessionDraftsDb.recoverUnknown(userId, SESSION_ID, 'queue');
    const recovered = sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? [];
    assert.equal(recovered.length, 2);
    assert.equal((recovered[1] as { id: string }).id, 'tail');
    assert.notEqual((recovered[0] as { id: string }).id, 'uncertain', 'the uncertain turn gets a new ticket');

    sessionDraftsDb.beginSteer(userId, SESSION_ID, (recovered[0] as { id: string }).id, 'request-3');
    sessionDraftsDb.finishSteer(userId, SESSION_ID, 'request-3', 'unknown', 'no acknowledgement');
    sessionDraftsDb.recoverUnknown(userId, SESSION_ID, 'discard');
    assert.deepEqual(
      sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.map((entry) => (entry as { id: string }).id),
      ['tail'],
    );
  });
});

test('a legacy singleton row is adopted as a one-entry FIFO queue', async () => {
  await withIsolatedDatabase(async (userId) => {
    // Simulates a row written before the queue existed: plain object JSON in
    // the same `queued_message` column, inserted directly rather than saved.
    const { getConnection } = await import('@/modules/database/index.js');
    getConnection().prepare(`INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message)
      VALUES (?, ?, '', ?)`).run(userId, SESSION_ID, JSON.stringify({ id: 'legacy', content: 'legacy turn' }));

    const draft = sessionDraftsDb.getDrafts(userId)[0];
    assert.deepEqual(draft.queuedMessages, [{ id: 'legacy', content: 'legacy turn' }]);
    assert.deepEqual(draft.queuedMessage, { id: 'legacy', content: 'legacy turn' });
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 1);

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.deepEqual(runs.map(({ command }) => command), ['legacy turn']);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a fourth queued message is rejected by the repository, never truncated silently', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      queuedMessages: [{ id: 'a', content: 'one' }, { id: 'b', content: 'two' }, { id: 'c', content: 'three' }],
    });

    assert.throws(
      () => sessionDraftsDb.saveDraft(userId, SESSION_ID, {
        queuedMessages: [
          { id: 'a', content: 'one' }, { id: 'b', content: 'two' },
          { id: 'c', content: 'three' }, { id: 'd', content: 'four' },
        ],
      }),
      (error: Error & { code?: string }) => error.code === 'QUEUE_LIMIT_REACHED',
    );
    assert.equal(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages.length, 3);
  });
});

test('a due message interrupts a run in progress instead of failing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'the schedule wins',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    const aborts: string[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs, 'ok', aborts)), 1);

    assert.deepEqual(aborts, [SESSION_ID]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'the schedule wins');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a message that is not due yet is left alone', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'later',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('a due message is claimed once, so overlapping passes cannot double-send it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'only once',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await Promise.all([
      dispatchDueScheduledMessages(runtime),
      dispatchDueScheduledMessages(runtime),
    ]);

    assert.equal(runs.length, 1);
  });
});

test('the composer settings it was scheduled with travel with it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'with options',
      options: { model: 'claude-opus-5', permissionMode: 'plan' },
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.equal(runs[0].options.permissionMode, 'plan');
  });
});

test('a provider failure is recorded on the message instead of vanishing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    await dispatchDueScheduledMessages(createRuntime([], 'throw'));

    const row = scheduledMessagesDb.listForSession(userId, SESSION_ID)[0];
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason ?? '', /provider exploded/);
  });
});

test('a cancelled message never fires', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'never mind',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    scheduledMessagesService.cancel(userId, scheduled.id);

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
  });
});

test('a failed message can be dismissed, and stays dismissed', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([], 'throw'));
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'failed');

    scheduledMessagesService.cancel(userId, scheduled.id);

    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'cancelled');
  });
});

test('cancelling something that already fired is refused', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'gone',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([]));

    assert.throws(
      () => scheduledMessagesService.cancel(userId, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
  });
});

test('one user cannot cancel another user\'s scheduled message', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'mine',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    assert.throws(
      () => scheduledMessagesService.cancel(userId + 1, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('scheduling validates its input', async () => {
  await withIsolatedDatabase(async (userId) => {
    const base = { userId, sessionId: SESSION_ID, scheduledFor: new Date(Date.now() + 1000).toISOString() };

    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: '   ' }),
      (error: Error & { code?: string }) => error.code === 'CONTENT_REQUIRED',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: 'hi', scheduledFor: 'not a date' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULE_TIME',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({
        ...base,
        content: 'hi',
        scheduledFor: new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString(),
      }),
      (error: Error & { code?: string }) => error.code === 'SCHEDULE_TOO_FAR_AHEAD',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, sessionId: 'nope', content: 'hi' }),
      (error: Error & { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
  });
});


test('a running queued turn frees its slot for three waiting prompts before completion', async () => {
  await withIsolatedDatabase(async (userId) => {
    const queue = ['a', 'b', 'c'].map((id) => ({ id, content: id }));
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessages: queue });
    let finishRun!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const running = new Promise<void>((resolve) => { finishRun = resolve; });
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      run: async () => { notifyStarted(); await running; },
    } as never;
    const dispatch = dispatchQueuedMessages(runtime);
    try {
      await started;
      sessionDraftsDb.saveDraft(userId, SESSION_ID, {
        text: '', queuedMessages: [...queue.slice(1), { id: 'd', content: 'd' }],
      });
      assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages, [
        ...queue.slice(1), { id: 'd', content: 'd' },
      ]);
    } finally {
      finishRun();
      await dispatch;
    }
  });
});

test('an enqueue and each completed turn dispatch the next FIFO entry without waiting for the poll', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: RunCall[] = [];
    initializeScheduledMessageDispatcher(createRuntime(runs), {
      subscribeTurnCompleted: onChatRunCompleted,
    });
    try {
      sessionDraftsDb.saveDraft(userId, SESSION_ID, {
        queuedMessages: [{ id: 'first', content: 'first immediate' }, { id: 'second', content: 'second immediate' }],
      });

      requestQueuedMessageDispatch(SESSION_ID);
      await waitFor(() => runs.length === 2);

      assert.deepEqual(runs.map(({ command }) => command), ['first immediate', 'second immediate']);
      assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    } finally {
      closeScheduledMessageDispatcher();
    }
  });
});

test('a long turn in one session does not block a queued turn in another session', async () => {
  await withIsolatedDatabase(async (userId) => {
    const otherSession = 'parallel-session';
    sessionsDb.createAppSession(otherSession, 'claude', '/tmp', 'Parallel session');
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { queuedMessages: [{ id: 'long', content: 'long turn' }] });
    sessionDraftsDb.saveDraft(userId, otherSession, { queuedMessages: [{ id: 'short', content: 'short turn' }] });

    let releaseLong!: () => void;
    const longRunning = new Promise<void>((resolve) => { releaseLong = resolve; });
    const runs: string[] = [];
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      abort: async () => true,
      run: async (_provider: string, command: string) => {
        runs.push(command);
        if (command === 'long turn') await longRunning;
      },
    } as never;

    const dispatch = dispatchQueuedMessages(runtime);
    try {
      // The second session is admitted while the first model turn is still open.
      await waitFor(() => runs.includes('short turn'));
      assert.deepEqual(runs, ['long turn', 'short turn']);
    } finally {
      releaseLong();
      await dispatch;
    }
  });
});

test('the supplemental queue check fires at 15 seconds', async (t) => {
  await withIsolatedDatabase(async (userId) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const runs: RunCall[] = [];
    initializeScheduledMessageDispatcher(createRuntime(runs));
    try {
      sessionDraftsDb.saveDraft(userId, SESSION_ID, { queuedMessages: [{ id: 'waiting', content: 'after the poll' }] });

      t.mock.timers.tick(14_999);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(runs.length, 0);

      t.mock.timers.tick(1);
      await waitFor(() => runs.length === 1);
      assert.equal(runs[0].command, 'after the poll');
    } finally {
      closeScheduledMessageDispatcher();
    }
  });
});

test('a due scheduled message keeps its turn ahead of the user queue across the abort completion', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runs: string[] = [];
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      isQueueBlocked: () => false,
      abort: async () => true,
      run: async (_provider: string, command: string) => { runs.push(command); },
    } as never;

    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      queuedMessages: [{ id: 'user-B', content: 'user B' }],
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'scheduled C',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    initializeScheduledMessageDispatcher(runtime, { subscribeTurnCompleted: onChatRunCompleted });
    try {
      // The dispatcher's catch-up poll claims the due row, interrupts A, then
      // lets the queued B follow once the scheduled turn settles.
      await waitFor(() => runs.length === 2);

      assert.deepEqual(runs, ['scheduled C', 'user B'], 'the due schedule wins, then the user queue follows');
      assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
    } finally {
      closeScheduledMessageDispatcher();
    }
  });
});

test('an async abort that completes A before returning still does not let the user queue run before C', async () => {
  await withIsolatedDatabase(async (userId) => {
    let abortStarted!: () => void;
    let releaseAbort!: () => void;
    const abortRunning = new Promise<void>((resolve) => { abortStarted = resolve; });
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const runs: string[] = [];
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      isQueueBlocked: () => false,
      abort: async () => {
        // The real abort may publish A's terminal complete before its awaited
        // cleanup settles; the queued B must still stay behind C.
        chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0, aborted: true });
        abortStarted();
        await abortGate;
        return true;
      },
      run: async (_provider: string, command: string) => { runs.push(command); },
    } as never;

    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      queuedMessages: [{ id: 'user-B', content: 'user B' }],
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'scheduled C',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    initializeScheduledMessageDispatcher(runtime, { subscribeTurnCompleted: onChatRunCompleted });
    try {
      await abortRunning;
      // Neither an explicit enqueue request nor a queue timer pass may run B
      // while the scheduled turn is still waiting for abort confirmation.
      assert.equal(await dispatchQueuedMessages(runtime, { sessionId: SESSION_ID }), 0);
      requestQueuedMessageDispatch(SESSION_ID);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(runs, []);

      releaseAbort();
      await waitFor(() => runs.length === 2);
      assert.deepEqual(runs, ['scheduled C', 'user B']);
      assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
    } finally {
      releaseAbort();
      closeScheduledMessageDispatcher();
    }
  });
});
