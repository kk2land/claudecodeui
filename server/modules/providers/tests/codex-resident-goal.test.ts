import assert from 'node:assert/strict';
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
import { createProjectSchedulerModule } from '@/modules/project-scheduler/index.js';
import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type {
  AnyRecord,
  CodexRpcClient,
  CodexRpcFrame,
  ProviderRuntimeContext,
  ProviderRuntimeGateway,
} from '@/shared/index.js';

const SESSION = 'resident-goal-session';
const NATIVE = 'native-goal-thread';

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), 'expected state was never reached');
}

/**
 * Real Codex app-server runtime over a fake RPC transport, real chat run
 * registry, and the real resident host. Goal continuations flow through the
 * runtime's own `writer.nextTurn()` → registry new run → host tracking, so the
 * monitor's terminal decision is exercised on the real notification sequence.
 */
type GoalHarness = {
  module: ReturnType<typeof createProjectSchedulerModule>;
  runtime: CodexAppServerRuntime;
  gateway: ProviderRuntimeGateway;
  userId: number;
  frame(method: string, params?: AnyRecord): void;
  startTurn(content: string): Promise<unknown>;
  control(action: AnyRecord): Promise<unknown>;
  snapshot(): ReturnType<typeof chatRunRegistry.getSnapshot>;
  binding(): ReturnType<typeof residentBindingsDb.getByTaskId>;
  queued(): number;
};

async function harness(runTest: (h: GoalHarness) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const goalSetting = process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  process.env.CLOUDCLI_CODEX_GOAL_ENABLED = 'true';
  const root = await mkdtemp(path.join(os.tmpdir(), 'resident-goal-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  chatRunRegistry.clearAll();
  try {
    const userId = Number(userDb.createUser('resident-goal', 'hash').id);
    sessionsDb.createAppSession(SESSION, 'codex', root, 'Resident goal');
    sessionsDb.assignProviderSessionId(SESSION, NATIVE);
    sessionRuntimeDb.update(SESSION, {
      runtime: 'app-server',
      mode: 'default',
      modelSelection: { modelProvider: 'openai', model: 'test-model' },
    });

    const calls: Array<{ method: string; params: AnyRecord }> = [];
    let notify: (frame: CodexRpcFrame) => void = () => {};
    let request: (frame: CodexRpcFrame) => Promise<unknown> = async () => ({});
    let goal: AnyRecord | null = null;
    let turnNumber = 1;
    const rpc: CodexRpcClient = {
      async request<T>(method: string, params: AnyRecord = {}) {
        calls.push({ method, params });
        switch (method) {
          case 'thread/start': case 'thread/resume': return { thread: { id: NATIVE }, model: 'test-model', modelProvider: 'openai' } as T;
          case 'thread/read': return { thread: { turns: [] } } as T;
          case 'thread/goal/get': return { goal } as T;
          case 'thread/goal/set':
            goal = { threadId: NATIVE, objective: 'goal', tokensUsed: 0, tokenBudget: null, timeUsedSeconds: 0, status: 'active', ...params };
            return { goal } as T;
          case 'thread/goal/clear': goal = null; return {} as T;
          case 'thread/unsubscribe': return { status: 'notLoaded' } as T;
          case 'turn/start': return { turn: { id: `turn-${turnNumber++}` } } as T;
          default: return {} as T;
        }
      },
      onNotification(fn) { notify = fn; return () => {}; },
      onRequest(fn) { request = fn; return () => {}; },
      onExit() { return () => {}; },
    };
    void request;

    const runtime = new CodexAppServerRuntime(
      rpc,
      sessionRuntimeDb,
      100,
      () => undefined,
      async () => [],
      30_000,
      {
        modelProviders: {
          list: async () => ({ defaultProvider: 'openai', hasCustomProviders: false, providers: [{ id: 'openai', name: 'OpenAI' }] }),
          models: async (modelProvider: string) => ({ modelProvider, models: ['test-model'], expiresAt: Date.now() + 60_000 }),
        },
      } as never,
    );
    const context = {
      resolveProviderSessionId: () => NATIVE,
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ DEFAULT: 'test-model', OPTIONS: [] }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
    } as unknown as ProviderRuntimeContext;
    const options = { sessionId: SESSION, cwd: root, projectPath: root, model: 'test-model', effort: 'high', permissionMode: 'acceptEdits' };

    const gateway = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      isQueueBlocked: (id: string) => Boolean(sessionRuntimeDb.get(id).queueHeld),
      getState: () => runtime.getState(SESSION),
      getManagedState: () => undefined,
      getPendingApprovalsForSession: () => [],
      resolveToolApproval: () => undefined,
      stopBackgroundTask: async () => false,
      abort: async () => runtime.abort(SESSION),
      run: (_provider: string, command: string, runOptions: AnyRecord, writer: never) =>
        runtime.run(command, runOptions, writer, context),
    } as unknown as ProviderRuntimeGateway;

    const module = createProjectSchedulerModule({ runtime: gateway });
    module.initialize();

    const frame = (method: string, params: AnyRecord = {}) =>
      notify({ method, params: { threadId: NATIVE, ...params } });

    /** Starts one real registry run and the adapter turn it owns. */
    const startTurn = async (content: string) => {
      const run = chatRunRegistry.startRun({
        appSessionId: SESSION,
        provider: 'codex',
        providerSessionId: NATIVE,
        connection: null,
        userId,
        dispatch: {
          origin: 'foreground',
          permissionMode: 'acceptEdits',
          sandboxMode: null,
          model: 'test-model',
          effort: 'high',
          runtimeMode: 'app-server',
        },
      });
      assert.ok(run);
      void runtime.run(content, options, run.writer as never, context);
      return run;
    };

    try {
      await runTest({
        module,
        runtime,
        gateway,
        userId,
        frame,
        startTurn,
        control: (action: AnyRecord) => runtime.control(SESSION, action as never, options, chatRunRegistry.getRun(SESSION)!.writer as never, context),
        snapshot: () => chatRunRegistry.getSnapshot(SESSION),
        binding: () => residentBindingsDb.getByTaskId('task-goal'),
        queued: () => (sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? []).length,
      });
    } finally {
      await module.shutdown();
      // The fake transport cannot confirm every unload; the turn state is what this test owns.
      await runtime.close().catch(() => undefined);
      chatRunRegistry.clearAll();
    }
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    if (goalSetting === undefined) delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
    else process.env.CLOUDCLI_CODEX_GOAL_ENABLED = goalSetting;
    await rm(root, { recursive: true, force: true });
  }
}

test('a held resident goal continuation is a middle turn: no alert, same native thread, one final alert', async () => {
  await harness(async (h) => {
    // First turn: adopt while it is really running.
    await h.startTurn('first');
    await eventually(() => h.runtime.getState(SESSION).turnId === 'turn-1');
    await h.module.host.handleRequest('adopt', { taskId: 'task-goal', sessionId: SESSION });
    // The binding records the existing app-server runtime and its real permission.
    assert.equal(h.binding()?.runtime, 'app-server');
    assert.equal(h.binding()?.permissionMode, 'acceptEdits');

    // The user's Stop persisted a hold and one saved queue entry waits for an
    // explicit resume. The explicit turn keeps the hold because the queue is not empty.
    h.frame('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
    await eventually(() => h.snapshot()?.status === 'completed');
    // The foreground Stop is silent: one user_stopped terminal, no alert.
    await eventually(() => h.binding()?.status === 'stopped');
    const stopTerminal = h.binding()?.terminal;
    assert.equal(stopTerminal?.cause, 'user_stopped');
    assert.equal(stopTerminal?.alert, false);
    sessionRuntimeDb.update(SESSION, { queueHeld: true });
    sessionDraftsDb.enqueueChatMessage(
      h.userId,
      SESSION,
      { content: 'saved follow-up', options: { model: 'test-model' }, attachments: [] },
      'saved-goal-1',
    );

    // The explicit foreground turn starts (hold retained) and the user sets a goal
    // during it. The provider's terminal therefore reports goalActive=true.
    await h.startTurn('explicit turn');
    await eventually(() => h.runtime.getState(SESSION).turnId === 'turn-2');
    await h.control({ action: 'goal', operation: 'set', objective: 'finish the task' });
    await eventually(() => h.runtime.getState(SESSION).goal?.status === 'active');
    h.frame('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
    await eventually(() => h.snapshot()?.status === 'completed');
    assert.equal(h.snapshot()?.goalActive, true);

    // Middle turn: the goal owns the continuation, so the monitor must not alert.
    // The only terminal is still the earlier silent Stop.
    assert.equal(h.binding()?.status, 'running');
    assert.equal(h.binding()?.terminal?.id, stopTerminal?.id);
    assert.equal(sessionRuntimeDb.get(SESSION).queueHeld, true);

    // The native next turn arrives through the runtime's own nextTurn writer,
    // taking a new registry run without changing the app/native session.
    const middleExecution = h.binding()?.executionId;
    h.frame('turn/started', { turn: { id: 'turn-3' } });
    await eventually(() => h.binding()?.executionId !== middleExecution);
    assert.equal(sessionsDb.getSessionById(SESSION)?.provider_session_id, NATIVE);
    assert.equal(sessionRuntimeDb.get(SESSION).runtime, 'app-server');
    assert.equal(h.binding()?.status, 'running');
    assert.equal(h.binding()?.terminal?.id, stopTerminal?.id);
    assert.equal(h.queued(), 1);

    // The goal finishes before its final turn completes; that terminal carries
    // goalActive=false, so it is the real end of the resident episode.
    h.frame('thread/goal/updated', { goal: { threadId: NATIVE, status: 'complete', objective: 'goal', tokensUsed: 1, tokenBudget: null } });
    await eventually(() => h.runtime.getState(SESSION).goal?.status === 'complete');
    h.frame('turn/completed', { turn: { id: 'turn-3', status: 'completed' } });
    await eventually(() => Boolean(h.binding()?.terminal));

    const terminal = h.binding()!;
    assert.equal(terminal.status, 'stopped');
    assert.equal(terminal.terminal?.cause, 'completed');
    assert.equal(terminal.terminal?.alert, true);
    // Exactly one new terminal episode for the whole goal run, and the saved
    // queue is still held for the user's explicit resume.
    assert.notEqual(terminal.terminal?.id, stopTerminal?.id);
    assert.equal(terminal.terminal?.executionId, h.snapshot()?.executionId);
    assert.equal(sessionRuntimeDb.get(SESSION).queueHeld, true);
    assert.equal(h.queued(), 1);
  });
});
