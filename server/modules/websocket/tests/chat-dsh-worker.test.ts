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
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  handleChatConnection,
  runDetachedChatTurn,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  AnyRecord,
  ProviderRuntimeGateway,
  ProviderRuntimeState,
  WorkerWakeSource,
} from '@/shared/index.js';

const SESSION_ID = 'dsh-worker-session';

type DshHarness = {
  sessionId: string;
  userId: number;
  socket: EventEmitter & { frames: AnyRecord[] };
  managedState: ProviderRuntimeState;
  runtime: ProviderRuntimeGateway;
  runs: AnyRecord[];
  aborts: string[];
  send(data: AnyRecord): void;
};

function idleDshState(overrides: Partial<ProviderRuntimeState> = {}): ProviderRuntimeState {
  return {
    runtime: 'acp',
    phase: 'idle',
    queueHeld: false,
    supportsPermissionRequests: true,
    workerEnabled: true,
    diagnostics: {
      running: false,
      pid: null,
      startedAt: null,
      launcherPath: null,
      cliVersion: null,
    },
    ...overrides,
  };
}

async function harness(
  runTest: (h: DshHarness) => Promise<void>,
  options: { managedState?: ProviderRuntimeState; abortResult?: boolean } = {},
): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat-dsh-worker-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();

  const userId = Number(userDb.createUser('dsh-worker-queue', 'hash').id);
  sessionsDb.createAppSession(SESSION_ID, 'dsh', root);

  const managedState = options.managedState ?? idleDshState();
  const runs: AnyRecord[] = [];
  const aborts: string[] = [];
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    // DSH never fabricates the Codex app-server state shape.
    getState: () => undefined,
    getManagedState: () => managedState,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    async abort(_provider, sessionId) {
      aborts.push(sessionId);
      return options.abortResult ?? true;
    },
    async run(_provider, content: string, runOptions: AnyRecord) {
      runs.push({ content, options: runOptions });
    },
  };

  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    frames: [] as AnyRecord[],
    send(text: string) {
      this.frames.push(JSON.parse(text) as AnyRecord);
    },
  });
  handleChatConnection(socket as never, { user: { id: userId } } as never, { runtime });

  try {
    await runTest({
      sessionId: SESSION_ID,
      userId,
      socket,
      managedState,
      runtime,
      runs,
      aborts,
      send(data) {
        socket.emit('message', JSON.stringify({ sessionId: SESSION_ID, ...data }));
      },
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

function startBusyRun(userId: number): void {
  chatRunRegistry.startRun({
    appSessionId: SESSION_ID,
    provider: 'dsh',
    providerSessionId: null,
    connection: null,
    userId,
  });
}

test('a busy DSH ACP Worker send is queued with its ticket, input identity, and server-owned markers stripped', async () => {
  await harness(async (h) => {
    startBusyRun(h.userId);
    h.send({
      type: 'chat.send',
      content: 'queue this DSH follow-up',
      options: {
        clientMessageId: 'dsh-client-1',
        model: 'deepseek-official/test',
        workerWakeup: true,
        workerSource: 'client-forged',
        userTurn: true,
        images: [{ path: '/etc/passwd', name: 'outside.png' }],
      },
    });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'chat_queued');
    assert.equal(frame.sessionId, h.sessionId);
    assert.equal(frame.clientMessageId, 'dsh-client-1');
    assert.equal(frame.messageId, (frame.queuedMessage as AnyRecord).id);
    const queued = frame.queuedMessage as AnyRecord;
    assert.equal(queued.content, 'queue this DSH follow-up');
    assert.equal((queued.options as AnyRecord).clientMessageId, 'dsh-client-1');
    assert.equal((queued.options as AnyRecord).workerWakeup, undefined);
    assert.equal((queued.options as AnyRecord).workerSource, undefined);
    assert.equal((queued.options as AnyRecord).userTurn, undefined);
    // The same upload-store trust boundary drops attachments outside the store.
    assert.deepEqual(queued.attachments, []);
    assert.deepEqual(queuedDrafts(h.userId).map((message) => message.id), [frame.messageId]);
    assert.equal(h.runs.length, 0);
  });
});

test('a repeated DSH clientMessageId returns the same ticket without a second queue entry', async () => {
  await harness(async (h) => {
    startBusyRun(h.userId);
    const payload = {
      type: 'chat.send',
      content: 'retry me once',
      options: { clientMessageId: 'dsh-retry' },
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
    assert.deepEqual(queuedDrafts(h.userId).map((message) => message.id), [first.messageId]);
  });
});

test('a full DSH queue rejects with a ticket-bearing error and no fabricated codexState', async () => {
  await harness(async (h) => {
    sessionDraftsDb.saveDraft(h.userId, h.sessionId, {
      queuedMessages: [
        { id: 'one', content: 'one' },
        { id: 'two', content: 'two' },
        { id: 'three', content: 'three' },
      ],
    });
    h.send({
      type: 'chat.send',
      content: 'fourth',
      options: { clientMessageId: 'dsh-queue-full' },
    });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'protocol_error');
    assert.equal(frame.code, 'QUEUE_LIMIT_REACHED');
    assert.equal(frame.clientMessageId, 'dsh-queue-full');
    assert.equal('codexState' in frame, false);
    assert.equal(queuedDrafts(h.userId).length, 3);
  });
});

test('a headless DSH session keeps the existing RUN_IN_PROGRESS behaviour', async () => {
  await harness(async (h) => {
    h.managedState.runtime = 'headless';
    h.managedState.workerEnabled = false;
    startBusyRun(h.userId);
    h.send({ type: 'chat.send', content: 'do not queue', options: { clientMessageId: 'dsh-headless' } });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'protocol_error');
    assert.equal(frame.code, 'RUN_IN_PROGRESS');
    assert.equal(queuedDrafts(h.userId).length, 0);
  });
});

test('a plain DSH ACP session without a registered Worker does not use the queue', async () => {
  await harness(async (h) => {
    h.managedState.workerEnabled = false;
    startBusyRun(h.userId);
    h.send({ type: 'chat.send', content: 'do not queue', options: { clientMessageId: 'dsh-no-worker' } });
    await settle();

    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'protocol_error');
    assert.equal(frame.code, 'RUN_IN_PROGRESS');
    assert.equal(queuedDrafts(h.userId).length, 0);
  });
});

test('chat.abort reaches the Worker host for an idle DSH ACP parent', async () => {
  await harness(async (h) => {
    h.send({ type: 'chat.abort', requestId: 'stop-idle-worker' });
    await settle();

    assert.deepEqual(h.aborts, [h.sessionId]);
    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'control_result');
    assert.equal(frame.requestId, 'stop-idle-worker');
    assert.equal(frame.ok, true);
    assert.equal('codexState' in frame, false);
  });
});

test('an idle DSH ACP session without a Worker still reports NO_ACTIVE_RUN', async () => {
  await harness(async (h) => {
    h.managedState.workerEnabled = false;
    h.send({ type: 'chat.abort', requestId: 'stop-idle-plain' });
    await settle();

    assert.deepEqual(h.aborts, []);
    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'protocol_error');
    assert.equal(frame.code, 'NO_ACTIVE_RUN');
  });
});

test('an idle headless DSH session does not reach the abort path', async () => {
  await harness(async (h) => {
    h.managedState.runtime = 'headless';
    h.managedState.workerEnabled = false;
    h.send({ type: 'chat.abort', requestId: 'stop-idle-headless' });
    await settle();

    assert.deepEqual(h.aborts, []);
    assert.equal(h.socket.frames.at(-1)?.code, 'NO_ACTIVE_RUN');
  });
});

test('an unconfirmed idle DSH Worker stop reports STOP_NOT_CONFIRMED', async () => {
  await harness(async (h) => {
    h.send({ type: 'chat.abort', requestId: 'stop-unconfirmed' });
    await settle();

    assert.deepEqual(h.aborts, [h.sessionId]);
    const frame = h.socket.frames.at(-1)!;
    assert.equal(frame.kind, 'control_result');
    assert.equal(frame.ok, false);
    assert.equal(frame.code, 'STOP_NOT_CONFIRMED');
  }, { abortResult: false });
});

test('a held DSH queue blocks an automatic Worker wake-up before starting a run', async () => {
  await harness(async (h) => {
    h.managedState.queueHeld = true;
    const result = await runDetachedChatTurn({
      sessionId: h.sessionId,
      userId: h.userId,
      content: 'worker result',
      workerSource: { batchId: 'batch-held', results: [] } as WorkerWakeSource,
      finalGuard: () => true,
    }, { runtime: h.runtime });

    assert.equal(result.started, false);
    assert.match(result.error ?? '', /holding its queue/);
    assert.equal(h.runs.length, 0);
  });
});

test('a stopping DSH parent blocks an automatic Worker wake-up before starting a run', async () => {
  await harness(async (h) => {
    h.managedState.phase = 'stopping';
    const result = await runDetachedChatTurn({
      sessionId: h.sessionId,
      userId: h.userId,
      content: 'worker result',
      workerSource: { batchId: 'batch-stopping', results: [] } as WorkerWakeSource,
      finalGuard: () => true,
    }, { runtime: h.runtime });

    assert.equal(result.started, false);
    assert.match(result.error ?? '', /stopping or holding/);
    assert.equal(h.runs.length, 0);
  });
});

test('a DSH wake-up refused by its final gate never starts a run', async () => {
  await harness(async (h) => {
    const result = await runDetachedChatTurn({
      sessionId: h.sessionId,
      userId: h.userId,
      content: 'worker result',
      workerSource: { batchId: 'batch-gate', results: [] } as WorkerWakeSource,
      finalGuard: () => false,
    }, { runtime: h.runtime });

    assert.equal(result.started, false);
    assert.match(result.error ?? '', /stopped or is waiting/);
    assert.equal(h.runs.length, 0);
  });
});
