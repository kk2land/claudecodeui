import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  residentBindingsDb,
  sessionDraftsDb,
  sessionRuntimeDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  closeScheduledMessageDispatcher,
  dispatchQueuedMessages,
  initializeScheduledMessageDispatcher,
} from '@/modules/scheduled-messages/index.js';
import { createProjectSchedulerModule } from '@/modules/project-scheduler/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  AnyRecord,
  CodexSessionState,
  ProviderRuntimeGateway,
} from '@/shared/index.js';

type Harness = {
  sessionId: string;
  userId: number;
  runtime: ProviderRuntimeGateway;
  runs: Array<{ content: string; options: AnyRecord }>;
  aborts: string[];
  host: ReturnType<typeof createProjectSchedulerModule>['host'];
  stopModule(): Promise<void>;
  send(data: AnyRecord): void;
  finishCurrent(): Promise<void>;
  waitFor(predicate: () => boolean): Promise<void>;
  queued(): Array<Record<string, unknown>>;
  /** Seeds a saved pending queue entry through the real queue database. */
  enqueue(content: string, id: string): void;
};

/** One real WS chat connection over the real registry, queue DB and dispatcher. */
async function harness(runTest: (h: Harness) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'resident-exec-ws-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  chatRunRegistry.clearAll();

  const sessionId = 'resident-exec-session';
  const userId = Number(userDb.createUser('resident-exec', 'hash').id);
  sessionsDb.createAppSession(sessionId, 'codex', root, 'Resident exec');
  sessionsDb.assignProviderSessionId(sessionId, 'native-exec-thread');
  sessionRuntimeDb.update(sessionId, {
    runtime: 'sdk',
    modelSelection: { modelProvider: 'openai', model: 'gpt-5' },
  });

  const runs: Array<{ content: string; options: AnyRecord }> = [];
  const aborts: string[] = [];
  let releaseRun: (() => void) | null = null;
  let runAborted = false;

  const runtime = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    // The router merges the persisted settings into state; mirror that here.
    getState: () => ({
      runtime: 'sdk',
      mode: 'default',
      turnId: null,
      phase: 'idle',
      goal: null,
      questions: [],
      queueHeld: sessionRuntimeDb.get(sessionId).queueHeld,
    }),
    getManagedState: () => undefined,
    isQueueBlocked: (id: string) => Boolean(sessionRuntimeDb.get(id).queueHeld),
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    async abort(_provider: string, id: string) {
      aborts.push(id);
      // The real router aborts the live exec run; the chat handler emits the
      // terminal complete on its behalf.
      runAborted = true;
      releaseRun?.();
      releaseRun = null;
      return true;
    },
    async run(
      _provider: string,
      content: string,
      options: AnyRecord,
      writer: { sendComplete: (opts: { exitCode: number; aborted?: boolean }) => void },
    ) {
      runs.push({ content, options });
      await new Promise<void>((resolve) => { releaseRun = resolve; });
      if (!runAborted) writer.sendComplete({ exitCode: 0 });
      runAborted = false;
      return undefined;
    },
  } as unknown as ProviderRuntimeGateway;

  const module = createProjectSchedulerModule({ runtime });
  const host = module.host;
  module.initialize();
  initializeScheduledMessageDispatcher(runtime, {
    onSessionSettled: (id) => host.onSessionSettled(id),
  });

  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    frames: [] as AnyRecord[],
    send(text: string) { this.frames.push(JSON.parse(text) as AnyRecord); },
  });
  handleChatConnection(socket as never, { user: { id: userId } } as never, {
    runtime,
    notifyQueueChanged: () => undefined,
  });

  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(predicate(), 'condition did not become true');
  };

  try {
    await runTest({
      sessionId,
      userId,
      runtime,
      runs,
      aborts,
      host,
      stopModule: () => module.shutdown(),
      send(data) { socket.emit('message', JSON.stringify({ sessionId, ...data })); },
      async finishCurrent() {
        const finish = releaseRun;
        releaseRun = null;
        finish?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      waitFor,
      queued() {
        return (sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? []) as Array<Record<string, unknown>>;
      },
      enqueue(content: string, id: string) {
        sessionDraftsDb.enqueueChatMessage(
          userId,
          sessionId,
          { content, options: { model: 'gpt-5' }, attachments: [] },
          id,
        );
      },
    });
  } finally {
    closeScheduledMessageDispatcher();
    await module.shutdown();
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function adoptRunning(h: Harness, taskId: string) {
  const adopted = await h.host.handleRequest('adopt', { taskId, sessionId: h.sessionId }) as {
    binding: { runtime: { provider: string } };
  };
  assert.equal(adopted.binding.runtime.provider, 'codex');
  // The recorded runtime is the session's configured exec runtime, not app-server.
  assert.equal(residentBindingsDb.getByTaskId(taskId)?.runtime, 'sdk');
}

test('exec foreground Stop holds its pending queue; the monitor stops, the queue never auto-runs, and a restart never continues', async () => {
  await harness(async (h) => {
    h.send({ type: 'chat.send', content: 'long task', options: { model: 'gpt-5' } });
    await h.waitFor(() => h.runs.length === 1);
    await adoptRunning(h, 'task-exec-stop');

    // A saved pending queue entry exists from the existing queue database.
    h.enqueue('saved follow-up', 'saved-1');
    assert.equal(h.queued().length, 1);

    // Foreground Stop through the real chat.abort path.
    h.send({ type: 'chat.abort', requestId: 'stop-1' });
    await h.waitFor(() => h.aborts.length === 1);
    await h.waitFor(() => residentBindingsDb.getByTaskId('task-exec-stop')?.status === 'stopped');
    // Exec runtime now persists the same queue hold as app-server.
    assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, true);
    const stopped = residentBindingsDb.getByTaskId('task-exec-stop')!;
    assert.equal(stopped.terminal?.cause, 'user_stopped');
    assert.equal(stopped.terminal?.alert, false);

    // A real dispatcher pass must not start the saved entry while the queue is held.
    await dispatchQueuedMessages(h.runtime, { sessionId: h.sessionId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.runs.length, 1);
    assert.equal(h.queued().length, 1);

    // After a restart the stopped task is not continued: recovery never sends a
    // turn, so no provider run is started.
    await h.stopModule();
    chatRunRegistry.clearAll();
    const restarted = createProjectSchedulerModule({ runtime: h.runtime });
    restarted.initialize();
    await restarted.recover();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.runs.length, 1);
    await restarted.shutdown();
  });
});

test('after a plugin stop of an exec task, a foreground message runs the same session, releases the hold and settles with one alert', async () => {
  await harness(async (h) => {
    h.send({ type: 'chat.send', content: 'first turn', options: { model: 'gpt-5' } });
    await h.waitFor(() => h.runs.length === 1);
    await adoptRunning(h, 'task-exec-continue');
    await h.finishCurrent();

    h.send({ type: 'chat.send', content: 'second turn', options: { model: 'gpt-5' } });
    await h.waitFor(() => h.runs.length === 2);
    const stopped = await h.host.handleRequest('stop', { taskId: 'task-exec-continue' }) as {
      binding: { status: string };
    };
    assert.equal(stopped.binding.status, 'stopped');
    assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, true);
    const silentStop = residentBindingsDb.getByTaskId('task-exec-continue')!;
    assert.equal(silentStop.terminal?.cause, 'user_stopped');
    assert.equal(silentStop.terminal?.alert, false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Explicit foreground input with an empty queue resumes the empty queue.
    h.send({ type: 'chat.send', content: 'after stop', options: { model: 'gpt-5' } });
    await h.waitFor(() => h.runs.length === 3);
    const last = h.runs.at(-1)!;
    assert.equal(last.options.sessionId, h.sessionId);
    assert.equal(sessionRuntimeDb.get(h.sessionId).runtime, 'sdk');
    assert.equal(sessionsDb.getSessionById(h.sessionId)?.provider_session_id, 'native-exec-thread');
    assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, false);

    // The natural end is one alerting terminal, not a stuck "running" binding.
    await h.finishCurrent();
    await dispatchQueuedMessages(h.runtime, { sessionId: h.sessionId });
    await h.waitFor(() => residentBindingsDb.getByTaskId('task-exec-continue')?.status === 'stopped');
    const settled = residentBindingsDb.getByTaskId('task-exec-continue')!;
    assert.equal(settled.terminal?.cause, 'completed');
    assert.equal(settled.terminal?.alert, true);
    // A distinct episode id: exactly one new terminal after the silent stop.
    assert.notEqual(settled.terminal?.id, silentStop.terminal?.id);
  });
});

test('a user-held saved queue does not keep the monitor running: the explicit turn ends as a stopped alert', async () => {
  await harness(async (h) => {
    h.send({ type: 'chat.send', content: 'long task', options: { model: 'gpt-5' } });
    await h.waitFor(() => h.runs.length === 1);
    await adoptRunning(h, 'task-exec-held-queue');
    h.enqueue('saved follow-up', 'saved-held');
    assert.equal(h.queued().length, 1);
    h.send({ type: 'chat.abort', requestId: 'stop-held' });
    await h.waitFor(() => h.aborts.length === 1);
    await h.waitFor(() => residentBindingsDb.getByTaskId('task-exec-held-queue')?.status === 'stopped');
    assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, true);

    // The user explicitly sends a new message while the saved queue is held:
    // it is admitted, but the saved queue stays held for an explicit resume.
    h.send({ type: 'chat.send', content: 'explicit turn', options: { model: 'gpt-5' } });
    await h.waitFor(() => h.runs.length === 2);
    assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, true);

    await h.finishCurrent();
    await h.waitFor(() => residentBindingsDb.getByTaskId('task-exec-held-queue')?.terminal?.cause === 'completed');
    const stopped = residentBindingsDb.getByTaskId('task-exec-held-queue')!;
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.terminal?.alert, true);

    // The saved entry still waits for the user; it is never auto-run.
    assert.equal(h.queued().length, 1);
    await dispatchQueuedMessages(h.runtime, { sessionId: h.sessionId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.runs.length, 2);
    assert.equal(h.queued().length, 1);
  });
});

test('a non-held saved queue still auto-continues without a false stopped episode', async () => {
  await harness(async (h) => {
    h.send({ type: 'chat.send', content: 'first turn', options: { model: 'gpt-5' } });
    await h.waitFor(() => h.runs.length === 1);
    await adoptRunning(h, 'task-exec-auto-queue');
    h.enqueue('queued follow-up', 'saved-auto');
    assert.equal(h.queued().length, 1);

    await h.finishCurrent();
    // The dispatched queued turn stays open, so the pass is not awaited.
    void dispatchQueuedMessages(h.runtime, { sessionId: h.sessionId });
    await h.waitFor(() => h.runs.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.queued().length, 0);
    const running = residentBindingsDb.getByTaskId('task-exec-auto-queue')!;
    assert.equal(running.status, 'running');
    assert.equal(running.terminal, null);

    await h.finishCurrent();
    await dispatchQueuedMessages(h.runtime, { sessionId: h.sessionId });
    await h.waitFor(() => residentBindingsDb.getByTaskId('task-exec-auto-queue')?.terminal?.cause === 'completed');
  });
});
