import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';

import {
  closeConnection,
  initializeDatabase,
  residentBindingsDb,
  sessionRuntimeDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { createProjectSchedulerModule } from '@/modules/project-scheduler/index.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import {
  chatRunRegistry,
} from '@/modules/websocket/index.js';
import {
  closeScheduledMessageDispatcher,
  dispatchQueuedMessages,
  initializeScheduledMessageDispatcher,
} from '@/modules/scheduled-messages/index.js';
import type { ProviderRuntimeContext, ProviderRuntimeGateway } from '@/shared/index.js';

const SESSION = 'codex-resident-terminal-session';
const NATIVE = 'native-terminal-thread';

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 300 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), 'expected state was never reached');
}

/**
 * Real Codex exec adapter (`codexRuntime`) → the real CodexSessionsProvider
 * normalizer → the real chat run registry → the real resident host and the real
 * scheduled-messages dispatcher. Only the native SDK stream is mocked, so the
 * terminal classification is the production one.
 */
type TerminalHarness = {
  module: ReturnType<typeof createProjectSchedulerModule>;
  gateway: ProviderRuntimeGateway;
  userId: string | number | null;
  root: string;
  resumedWith: string[];
  startRun(): NonNullable<ReturnType<typeof chatRunRegistry.getRun>>;
  snapshot(): ReturnType<typeof chatRunRegistry.getSnapshot>;
  binding(): ReturnType<typeof residentBindingsDb.getByTaskId>;
};

async function harness(
  events: unknown[],
  runTest: (h: TerminalHarness) => Promise<void>,
) {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-resident-terminal-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  chatRunRegistry.clearAll();
  const originalResume = Codex.prototype.resumeThread;
  const restoreMocks = [originalResume];
  void restoreMocks;
  try {
    const userId = null;
    sessionsDb.createAppSession(SESSION, 'codex', root, 'Resident exec terminal');
    sessionsDb.assignProviderSessionId(SESSION, NATIVE);
    sessionRuntimeDb.update(SESSION, {
      runtime: 'sdk',
      modelSelection: { modelProvider: 'openai', model: 'test-model' },
    });

    const resumedWith: string[] = [];
    const thread = {
      id: NATIVE,
      async runStreamed() {
        return {
          events: (async function* () {
            for (const event of events) yield event;
          })(),
        };
      },
    } as unknown as Thread;
    Codex.prototype.resumeThread = ((id: string) => {
      resumedWith.push(id);
      return thread;
    }) as typeof Codex.prototype.resumeThread;

    const sessions = new CodexSessionsProvider();
    const context = {
      resolveProviderSessionId: () => NATIVE,
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
      // The production normalization boundary: the Codex provider's own adapter.
      normalizeMessage: (raw: unknown, sessionId: string | null) => sessions.normalizeMessage(raw, sessionId),
      isProviderInstalled: async () => true,
    } as unknown as ProviderRuntimeContext;

    const gateway = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      isQueueBlocked: () => false,
      getState: () => undefined,
      getManagedState: () => undefined,
      getPendingApprovalsForSession: () => [],
      resolveToolApproval: () => undefined,
      stopBackgroundTask: async () => false,
      abort: async () => codexRuntime.abort(SESSION),
      run: (_provider: string, command: string, options: Record<string, unknown>, writer: never) =>
        codexRuntime.run(command, options, writer, context),
    } as unknown as ProviderRuntimeGateway;

    const module = createProjectSchedulerModule({ runtime: gateway });
    module.initialize();
    initializeScheduledMessageDispatcher(gateway, {
      onSessionSettled: (id) => module.host.onSessionSettled(id),
    });

    const startRun = () => {
      const run = chatRunRegistry.startRun({
        appSessionId: SESSION,
        provider: 'codex',
        providerSessionId: NATIVE,
        connection: null,
        userId,
        dispatch: {
          origin: 'resident',
          permissionMode: 'acceptEdits',
          sandboxMode: null,
          model: 'test-model',
          effort: 'high',
          runtimeMode: 'sdk',
        },
      });
      assert.ok(run);
      void codexRuntime.run('continue', { sessionId: SESSION, model: 'test-model', cwd: root, permissionMode: 'acceptEdits' }, run.writer, context);
      return run;
    };

    try {
      await runTest({
        module,
        gateway,
        userId,
        root,
        resumedWith,
        startRun,
        snapshot: () => chatRunRegistry.getSnapshot(SESSION),
        binding: () => residentBindingsDb.getByTaskId('task-terminal'),
      });
    } finally {
      closeScheduledMessageDispatcher();
      await module.shutdown();
      chatRunRegistry.clearAll();
    }
  } finally {
    Codex.prototype.resumeThread = originalResume;
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const NOW = new Date().toISOString();

function threadEvents(turnEnd: Record<string, unknown>) {
  return [
    { type: 'thread.started', thread_id: NATIVE },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { id: 'item-1', type: 'agent_message', text: 'done' },
    },
    turnEnd,
  ];
}

test('a naturally completed exec turn reaches the resident host as completed/success/alert through the real dispatcher', async () => {
  await harness(threadEvents({ type: 'turn.completed', usage: null }), async (h) => {
    const run = h.startRun();
    // Adopt while the native turn is really running (the only eligible state).
    await h.module.host.handleRequest('adopt', { taskId: 'task-terminal', sessionId: SESSION });
    await eventually(() => h.snapshot()?.status === 'completed');
    assert.deepEqual(h.resumedWith, [NATIVE]);

    // The production normalizer's own terminal, not the adapter's dropped duplicate.
    const snapshot = h.snapshot()!;
    assert.equal(snapshot.dispatch.runtimeMode, 'sdk');
    assert.equal(snapshot.success, true);
    assert.equal(snapshot.exitCode, 0);
    assert.equal(snapshot.hadError, false);

    await dispatchQueuedMessages(h.gateway, { sessionId: SESSION });
    await eventually(() => h.binding()?.terminal !== null);

    const record = h.binding()!;
    assert.equal(record.status, 'stopped');
    assert.equal(record.terminal?.status, 'success');
    assert.equal(record.terminal?.cause, 'completed');
    assert.equal(record.terminal?.alert, true);
    assert.equal(record.providerSessionId, NATIVE);
    assert.equal(record.runtime, 'sdk');
    assert.equal(record.terminal?.executionId, run.executionId);
  });
});

test('a failed exec turn stays failed with a reason and still alerts', async () => {
  await harness(
    threadEvents({ type: 'turn.failed', error: { message: 'native exec exploded' } }),
    async (h) => {
      const run = h.startRun();
      await h.module.host.handleRequest('adopt', { taskId: 'task-terminal', sessionId: SESSION });
      await eventually(() => h.snapshot()?.status === 'completed');
      assert.deepEqual(h.resumedWith, [NATIVE]);
      const snapshot = h.snapshot()!;
      assert.equal(snapshot.success, false);
      assert.equal(snapshot.hadError, true);
      assert.match(snapshot.errorText ?? '', /native exec exploded/);

      await dispatchQueuedMessages(h.gateway, { sessionId: SESSION });
      await eventually(() => h.binding()?.terminal !== null);

      const record = h.binding()!;
      assert.equal(record.status, 'stopped');
      assert.equal(record.terminal?.status, 'failed');
      assert.equal(record.terminal?.cause, 'failed');
      assert.equal(record.terminal?.alert, true);
      assert.match(record.terminal?.reason ?? '', /native exec exploded/);
      assert.equal(record.terminal?.executionId, run.executionId);
    },
  );
});

test('the same native id is resumed for every exec turn', async () => {
  await harness(threadEvents({ type: 'turn.completed', usage: null }), async (h) => {
    h.startRun();
    await eventually(() => h.snapshot()?.status === 'completed');
    h.startRun();
    await eventually(() => h.snapshot()?.status === 'completed');
    assert.deepEqual(h.resumedWith, [NATIVE, NATIVE]);
    assert.equal(sessionsDb.getSessionById(SESSION)?.provider_session_id, NATIVE);
    assert.equal(sessionRuntimeDb.get(SESSION).runtime, 'sdk');
  });
});

void NOW;
