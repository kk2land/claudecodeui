import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  residentBindingsDb,
  sessionRuntimeDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, startResidentContinueTurn } from '@/modules/websocket/index.js';
import type { ChatRunDispatch } from '@/modules/websocket/index.js';
import type {
  ProviderRuntimeGateway,
  ResidentBindingView,
  ResidentContinueAdmission,
  ResidentIpcEvent,
} from '@/shared/index.js';
import { AppError } from '@/shared/utils.js';

import { createResidentHostService } from '../resident-host.service.js';
import { createStageLogService } from '../stage-log.service.js';

const SESSION = 'resident-session-1';

async function withDatabase(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resident-host-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    sessionsDb.createAppSession(SESSION, 'codex', root, 'Resident conversation');
    sessionsDb.assignProviderSessionId(SESSION, 'native-thread-1');
    sessionRuntimeDb.update(SESSION, { runtime: 'app-server', queueHeld: false });
    await run(root);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    delete process.env.DATABASE_PATH;
    await rm(root, { recursive: true, force: true });
  }
}

type ContinueCall = {
  sessionId: string;
  permissionMode?: string | null;
  model?: string | null;
  effort?: string | null;
};

function createHarness(options: {
  continueTurn?: (input: ContinueCall) => ResidentContinueAdmission;
  abort?: () => Promise<boolean>;
  pluginEnabled?: boolean;
} = {}) {
  const events: ResidentIpcEvent[] = [];
  const continueCalls: ContinueCall[] = [];
  const aborts: string[] = [];
  const states = new Map<string, { goal?: { status: string }; phase?: string; queueHeld?: boolean }>();
  const announcements: Array<{ kind: 'upsert' | 'removed'; sessionId: string }> = [];
  const logs = createStageLogService();
  const runtime = {
    hasRuntime: () => true,
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return options.abort ? options.abort() : true;
    },
    getState: () => states.get(SESSION),
    hasBackgroundWork: () => false,
    isQueueBlocked: (sessionId: string) => Boolean(states.get(sessionId)?.queueHeld),
  } as unknown as ProviderRuntimeGateway;
  const host = createResidentHostService({
    runtime,
    isPluginEnabled: () => options.pluginEnabled ?? true,
    emitEvent: (event) => events.push(event),
    continueTurn: (input) => {
      continueCalls.push(input);
      return options.continueTurn
        ? options.continueTurn(input)
        : { accepted: false, reason: 'unavailable', error: 'not configured' };
    },
    requestQueueDispatch: () => undefined,
    announceSession: (sessionId) => announcements.push({ kind: 'upsert', sessionId }),
    announceSessionRemoved: (sessionId) => announcements.push({ kind: 'removed', sessionId }),
    logSystem: (input) => { logs.recordSystem(input); },
    logs: (query) => logs.list(query),
  });
  host.initialize();
  return { host, events, continueCalls, aborts, states, announcements, logs };
}

/** Admits a real registry run, the way dispatchRun does synchronously. */
function admitRun(
  origin: ChatRunDispatch['origin'] = 'foreground',
  runtimeMode: 'app-server' | 'sdk' = 'app-server',
) {
  chatRunRegistry.clearAll();
  const run = chatRunRegistry.startRun({
    appSessionId: SESSION,
    provider: 'codex',
    providerSessionId: 'native-thread-1',
    connection: null,
    userId: null,
    dispatch: {
      origin,
      permissionMode: 'acceptEdits',
      sandboxMode: 'workspace-write',
      model: 'gpt-5',
      effort: 'high',
      runtimeMode,
    },
  });
  assert.ok(run);
  return run;
}

test('adoption requires a real active run, binds once, and records dispatch permissions', async () => {
  await withDatabase(async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.host.handleRequest('adopt', { taskId: 'task-1', sessionId: SESSION }),
      (error: unknown) => error instanceof AppError && error.code === 'not_running',
    );

    admitRun();
    const adopted = await harness.host.handleRequest('adopt', {
      taskId: 'task-1',
      sessionId: SESSION,
    }) as { binding: { status: string; runtime: { permissionMode: string } } };
    assert.equal(adopted.binding.status, 'running');
    assert.equal(adopted.binding.runtime.permissionMode, 'acceptEdits');
    assert.equal(residentBindingsDb.getBySessionId(SESSION)?.providerSessionId, 'native-thread-1');
    assert.equal(residentBindingsDb.getBySessionId(SESSION)?.model, 'gpt-5');

    await assert.rejects(
      harness.host.handleRequest('adopt', { taskId: 'task-2', sessionId: SESSION }),
      (error: unknown) => error instanceof AppError && error.code === 'already_resident',
    );
    await harness.host.shutdown();
  });
});

test('recovery resumes exactly one continue for a persisted running binding and never revives stopped/disabled ones', async () => {
  await withDatabase(async () => {
    const first = createHarness();
    admitRun();
    await first.host.handleRequest('adopt', { taskId: 'task-1', sessionId: SESSION });
    // A graceful shutdown is not a terminal: the row stays running for recovery.
    await first.host.shutdown();
    await first.host.handleRequest('status', {});
    assert.equal(residentBindingsDb.getByTaskId('task-1')?.status, 'running');
    assert.equal(residentBindingsDb.getByTaskId('task-1')?.terminal, null);

    // A stopped task and a disabled one are not recovery candidates.
    residentBindingsDb.insert({
      taskId: 'task-stopped',
      sessionId: 'stopped-session',
      projectId: '',
      name: 'stopped',
      provider: 'codex',
      providerSessionId: 'native-stopped',
      enabled: true,
      visible: true,
      status: 'stopped',
      executionId: 'exec-old',
      stopCause: 'completed',
      terminal: null,
      permissionMode: null,
      sandboxMode: null,
      model: null,
      effort: null,
      runtime: 'app-server',
    });
    residentBindingsDb.insert({
      taskId: 'task-disabled',
      sessionId: 'disabled-session',
      projectId: '',
      name: 'disabled',
      provider: 'codex',
      providerSessionId: 'native-disabled',
      enabled: false,
      visible: true,
      status: 'running',
      executionId: 'exec-disabled',
      stopCause: null,
      terminal: null,
      permissionMode: null,
      sandboxMode: null,
      model: null,
      effort: null,
      runtime: 'app-server',
    });
    residentBindingsDb.insert({
      taskId: 'task-stopping',
      sessionId: 'stopping-session',
      projectId: '',
      name: 'stopping',
      provider: 'codex',
      providerSessionId: 'native-stopping',
      enabled: true,
      visible: true,
      status: 'stopping',
      executionId: 'exec-stopping',
      stopCause: 'user_stopped',
      terminal: null,
      permissionMode: null,
      sandboxMode: null,
      model: null,
      effort: null,
      runtime: 'app-server',
    });

    // A real restart starts with an empty run registry.
    chatRunRegistry.clearAll();
    const continueCalls: ContinueCall[] = [];
    const second = createHarness({
      continueTurn: (input) => {
        continueCalls.push(input);
        if (input.sessionId !== SESSION) {
          return { accepted: false, reason: 'unavailable', error: 'unknown session' };
        }
        // Real admission of the continue turn in the same native session.
        const run = admitRun('resident');
        return {
          accepted: true,
          executionId: run.executionId,
          settled: Promise.resolve({ started: true, error: null }),
        };
      },
    });
    await second.host.recoverAfterRestart();
    // Exactly one continue for the running binding, carrying its recorded settings.
    assert.equal(continueCalls.length, 1);
    assert.deepEqual(continueCalls[0], {
      sessionId: SESSION,
      permissionMode: 'acceptEdits',
      model: 'gpt-5',
      effort: 'high',
    });
    assert.equal(residentBindingsDb.getByTaskId('task-1')?.status, 'running');
    assert.equal(residentBindingsDb.getByTaskId('task-1')?.terminal, null);

    // Disabled: never continued, recorded as a silent disabled terminal.
    assert.equal(continueCalls.some((call) => call.sessionId === 'disabled-session'), false);
    const disabled = residentBindingsDb.getByTaskId('task-disabled')!;
    assert.equal(disabled.status, 'stopped');
    assert.equal(disabled.terminal?.cause, 'disabled');
    assert.equal(disabled.terminal?.alert, false);
    // Stopped: untouched.
    assert.equal(residentBindingsDb.getByTaskId('task-stopped')?.terminal, null);
    // A Codex stop that was still settling keeps its existing behavior: recovery
    // neither continues it nor rewrites its row.
    assert.equal(continueCalls.some((call) => call.sessionId === 'stopping-session'), false);
    const codexStopping = residentBindingsDb.getByTaskId('task-stopping')!;
    assert.equal(codexStopping.status, 'stopping');
    assert.equal(codexStopping.stopCause, 'user_stopped');
    assert.equal(codexStopping.terminal, null);

    // A second recovery on this host (e.g. a plugin reconnect) does nothing.
    await second.host.recoverAfterRestart();
    assert.equal(continueCalls.length, 1);
    await second.host.shutdown();
  });
});

test('a refused recovery reports an alerting failure instead of a new session', async () => {
  await withDatabase(async () => {
    const first = createHarness();
    admitRun();
    await first.host.handleRequest('adopt', { taskId: 'task-1', sessionId: SESSION });
    await first.host.shutdown();

    chatRunRegistry.clearAll();
    const second = createHarness({
      continueTurn: () => ({ accepted: false, reason: 'unavailable', error: 'native session is gone' }),
    });
    await second.host.recoverAfterRestart();
    const failed = residentBindingsDb.getByTaskId('task-1')!;
    assert.equal(failed.status, 'stopped');
    assert.equal(failed.terminal?.cause, 'recovery_failed');
    assert.equal(failed.terminal?.status, 'failed');
    assert.equal(failed.terminal?.alert, true);
    assert.match(failed.terminal?.reason ?? '', /native session is gone/);
    await second.host.shutdown();
  });
});

test('a foreground abort closes the episode silently even while the queue stays held, and is not resumed later', async () => {
  await withDatabase(async () => {
    const first = createHarness();
    admitRun();
    await first.host.handleRequest('adopt', { taskId: 'task-1', sessionId: SESSION });
    // chat.abort holds the Codex queue; a queued turn may remain, so the
    // dispatcher never reports the session settled.
    sessionRuntimeDb.update(SESSION, { queueHeld: true });
    chatRunRegistry.completeRun(SESSION, { exitCode: 0, aborted: true });

    const stopped = residentBindingsDb.getByTaskId('task-1')!;
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.terminal?.cause, 'user_stopped');
    assert.equal(stopped.terminal?.alert, false);
    await first.host.shutdown();

    chatRunRegistry.clearAll();
    const calls: ContinueCall[] = [];
    const second = createHarness({
      continueTurn: (input) => {
        calls.push(input);
        return { accepted: false, reason: 'unavailable', error: 'should not be called' };
      },
    });
    await second.host.recoverAfterRestart();
    assert.deepEqual(calls, []);
    await second.host.shutdown();
  });
});

test('a foreground turn after a natural end is tracked and classified from the provider terminal', async () => {
  await withDatabase(async () => {
    const harness = createHarness();
    admitRun();
    await harness.host.handleRequest('adopt', { taskId: 'task-1', sessionId: SESSION });
    chatRunRegistry.completeRun(SESSION, { exitCode: 0, aborted: false });
    harness.host.onSessionSettled(SESSION);
    assert.equal(residentBindingsDb.getByTaskId('task-1')?.terminal?.cause, 'completed');

    // The user keeps chatting in the original session: the binding tracks it.
    admitRun('foreground');
    assert.equal(residentBindingsDb.getByTaskId('task-1')?.status, 'running');
    // A provider failure reported only in the terminal (no error event) is still a failure.
    chatRunRegistry.completeRun(SESSION, { exitCode: 1, aborted: false });
    harness.host.onSessionSettled(SESSION);
    const failed = residentBindingsDb.getByTaskId('task-1')!;
    assert.equal(failed.terminal?.cause, 'failed');
    assert.equal(failed.terminal?.status, 'failed');
    assert.equal(failed.terminal?.alert, true);
    assert.match(failed.terminal?.reason ?? '', /exited with code 1/);
    await harness.host.shutdown();
  });
});

test('manual compaction keeps the resident binding and its recovery settings intact', async () => {
  await withDatabase(async () => {
    const harness = createHarness();
    admitRun('control');
    await assert.rejects(harness.host.handleRequest('adopt', { taskId: 'task-1', sessionId: SESSION }), { code: 'not_running' });
    admitRun();
    await harness.host.handleRequest('adopt', { taskId: 'task-1', sessionId: SESSION });
    chatRunRegistry.completeRun(SESSION, { exitCode: 0 });
    harness.host.onSessionSettled(SESSION);
    const stopped = residentBindingsDb.getByTaskId('task-1');
    assert.equal(stopped?.status, 'stopped');

    admitRun('control');
    assert.equal(chatRunRegistry.isProcessing(SESSION), true);
    assert.deepEqual(residentBindingsDb.getByTaskId('task-1'), stopped);
    chatRunRegistry.completeRun(SESSION, { exitCode: 1 });
    harness.host.onSessionSettled(SESSION);
    assert.deepEqual(residentBindingsDb.getByTaskId('task-1'), stopped);
    await harness.host.shutdown();
  });
});

test('stop reaches a real foreground run even when the binding already reports stopped', async () => {
  await withDatabase(async () => {
    const harness = createHarness();
    admitRun();
    await harness.host.handleRequest('adopt', { taskId: 'task-1', sessionId: SESSION });
    chatRunRegistry.completeRun(SESSION, { exitCode: 0, aborted: false });
    harness.host.onSessionSettled(SESSION);
    assert.equal(residentBindingsDb.getByTaskId('task-1')?.status, 'stopped');

    admitRun('foreground');
    const stopped = await harness.host.handleRequest('stop', { taskId: 'task-1' }) as {
      binding: { status: string; terminal: { cause: string; alert: boolean } | null };
    };
    assert.deepEqual(harness.aborts, [SESSION]);
    assert.equal(stopped.binding.status, 'stopped');
    assert.equal(stopped.binding.terminal?.cause, 'user_stopped');
    assert.equal(stopped.binding.terminal?.alert, false);
    // The session and its protection remain until the task is removed.
    assert.equal(sessionsDb.isSessionResidentProtected(SESSION), true);
    await harness.host.shutdown();
  });
});

test('continue admission keeps the native session and the stored dispatch options', async () => {
  await withDatabase(async () => {
    // A real dispatch-level probe: the provider runtime observes the options.
    const seen: Array<Record<string, unknown>> = [];
    let command: string | null = null;
    const dependencies = {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, prompt: string, options: Record<string, unknown>, writer: {
          sendComplete: (opts: { exitCode: number; aborted?: boolean }) => void;
        }) => {
          command = prompt;
          seen.push(options);
          writer.sendComplete({ exitCode: 0 });
          return undefined;
        },
        getState: () => undefined,
        hasManagedState: () => undefined,
        hasBackgroundWork: () => false,
      },
    } as never;

    const admission = startResidentContinueTurn(
      {
        sessionId: SESSION,
        userId: null,
        permissionMode: 'acceptEdits',
        model: 'gpt-5',
        effort: 'high',
      },
      dependencies,
    );
    assert.equal(admission.accepted, true);
    if (!admission.accepted) return;
    await admission.settled;
    assert.equal(command, 'continue');
    const options = seen[0];
    assert.equal(options.permissionMode, 'acceptEdits');
    assert.equal(options.model, 'gpt-5');
    assert.equal(options.effort, 'high');
    assert.equal(options.sessionId, SESSION);
    assert.equal(options.userTurn, true);
    assert.equal(options.residentContinue, undefined);
    assert.equal(options.providerSessionId, undefined);
    // The native id is resolved from the session row, never invented.
    assert.equal(sessionsDb.getSessionById(SESSION)?.provider_session_id, 'native-thread-1');
  });
});

test('a disabled plugin switch leaves a persisted running binding alone without a continue or alert', async () => {
  await withDatabase(async () => {
    const first = createHarness();
    admitRun();
    await first.host.handleRequest('adopt', { taskId: 'task-1', sessionId: SESSION });
    await first.host.shutdown();

    chatRunRegistry.clearAll();
    const calls: ContinueCall[] = [];
    const second = createHarness({
      pluginEnabled: false,
      continueTurn: (input) => {
        calls.push(input);
        return { accepted: false, reason: 'unavailable', error: 'plugin off' };
      },
    });
    await second.host.recoverAfterRestart();
    assert.deepEqual(calls, []);
    const record = residentBindingsDb.getByTaskId('task-1')!;
    // No continue, no terminal, no deletion: the task and its protection survive
    // the plugin switch, and reopening the plugin only re-syncs.
    assert.equal(record.status, 'stopped');
    assert.equal(record.terminal, null);
    assert.equal(sessionsDb.isSessionResidentProtected(SESSION), true);
    await second.host.shutdown();
  });
});

test('exec-mode Codex keeps its configured runtime through adopt, stop, continue and recovery', async () => {
  await withDatabase(async () => {
    sessionRuntimeDb.update(SESSION, { runtime: 'sdk', queueHeld: false });
    const first = createHarness();
    admitRun('foreground', 'sdk');
    const adopted = await first.host.handleRequest('adopt', {
      taskId: 'task-exec',
      sessionId: SESSION,
    }) as { binding: { status: string; runtime: { provider: string } } };
    assert.equal(adopted.binding.status, 'running');
    // The configured runtime is recorded as-is; nothing is switched to app-server.
    assert.equal(residentBindingsDb.getByTaskId('task-exec')?.runtime, 'sdk');

    const stopped = await first.host.handleRequest('stop', { taskId: 'task-exec' }) as {
      binding: { status: string; terminal: { cause: string } | null };
    };
    assert.deepEqual(first.aborts, [SESSION]);
    assert.equal(stopped.binding.status, 'stopped');
    assert.equal(stopped.binding.terminal?.cause, 'user_stopped');
    // Stop holds the persisted Codex queue for the exec runtime too.
    assert.equal(sessionRuntimeDb.get(SESSION).queueHeld, true);
    assert.equal(residentBindingsDb.getByTaskId('task-exec')?.runtime, 'sdk');
    await first.host.shutdown();

    const calls: ContinueCall[] = [];
    const second = createHarness({
      continueTurn: (input) => {
        calls.push(input);
        const run = admitRun('resident', 'sdk');
        return {
          accepted: true,
          executionId: run.executionId,
          settled: Promise.resolve({ started: true, error: null }),
        };
      },
    });
    const continued = await second.host.handleRequest('continue', { taskId: 'task-exec' }) as {
      result: { accepted: boolean; executionId: string | null };
    };
    assert.equal(continued.result.accepted, true);
    // Same session, same native id, same recorded dispatch settings; queue released.
    assert.equal(second.continueCalls[0]?.sessionId, SESSION);
    assert.equal(second.continueCalls[0]?.permissionMode, 'acceptEdits');
    assert.equal(second.continueCalls[0]?.model, 'gpt-5');
    assert.equal(sessionRuntimeDb.get(SESSION).runtime, 'sdk');
    assert.equal(sessionRuntimeDb.get(SESSION).queueHeld, false);
    assert.equal(
      sessionsDb.getSessionById(SESSION)?.provider_session_id,
      'native-thread-1',
    );
    await second.host.shutdown();
  });
});

test('recovery of an exec-mode binding continues the same session exactly once', async () => {
  await withDatabase(async () => {
    sessionRuntimeDb.update(SESSION, { runtime: 'sdk', queueHeld: false });
    const first = createHarness();
    admitRun('foreground', 'sdk');
    await first.host.handleRequest('adopt', { taskId: 'task-exec', sessionId: SESSION });
    await first.host.shutdown();
    assert.equal(residentBindingsDb.getByTaskId('task-exec')?.status, 'running');

    chatRunRegistry.clearAll();
    const calls: ContinueCall[] = [];
    const second = createHarness({
      continueTurn: (input) => {
        calls.push(input);
        const run = admitRun('resident', 'sdk');
        return {
          accepted: true,
          executionId: run.executionId,
          settled: Promise.resolve({ started: true, error: null }),
        };
      },
    });
    await second.host.recoverAfterRestart();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.sessionId, SESSION);
    assert.equal(sessionRuntimeDb.get(SESSION).runtime, 'sdk');
    assert.equal(residentBindingsDb.getByTaskId('task-exec')?.runtime, 'sdk');
    assert.equal(residentBindingsDb.getByTaskId('task-exec')?.status, 'running');
    await second.host.shutdown();
  });
});

test('a provider without resident support is refused explicitly', async () => {
  await withDatabase(async () => {
    sessionsDb.createAppSession('claude-session', 'claude', path.join('claude-project'), 'Claude');
    const harness = createHarness();
    await assert.rejects(
      harness.host.handleRequest('adopt', { taskId: 'task-claude', sessionId: 'claude-session' }),
      (error: unknown) => error instanceof AppError && error.code === 'unsupported_provider',
    );
    await harness.host.shutdown();
  });
});

test('a persisted binding from a retired provider ends silently and stays removable', async () => {
  await withDatabase(async () => {
    const retiredSession = 'retired-dsh-session';
    sessionsDb.createAppSession(retiredSession, 'dsh', path.join('dsh-project'), 'DSH conversation');
    sessionsDb.assignProviderSessionId(retiredSession, 'dsh-native-1');
    // The shape a DSH binding had when it was still adoptable: enabled, running.
    residentBindingsDb.insert({
      taskId: 'task-retired',
      sessionId: retiredSession,
      projectId: '',
      name: 'DSH conversation',
      provider: 'dsh',
      providerSessionId: 'dsh-native-1',
      enabled: true,
      visible: true,
      status: 'running',
      executionId: 'dsh-exec-1',
      stopCause: null,
      terminal: null,
      permissionMode: null,
      sandboxMode: null,
      model: 'gw/model',
      effort: null,
      runtime: null,
    });
    // A retired binding can also survive in `stopping`: its stop had no adapter to
    // confirm it, so recovery must clear it exactly like the running one.
    const stoppingSession = 'retired-dsh-stopping';
    sessionsDb.createAppSession(stoppingSession, 'dsh', path.join('dsh-project'), 'DSH stopping');
    sessionsDb.assignProviderSessionId(stoppingSession, 'dsh-native-stopping');
    residentBindingsDb.insert({
      taskId: 'task-retired-stopping',
      sessionId: stoppingSession,
      projectId: '',
      name: 'DSH stopping',
      provider: 'dsh',
      providerSessionId: 'dsh-native-stopping',
      enabled: true,
      visible: true,
      status: 'stopping',
      executionId: 'dsh-exec-stopping',
      stopCause: 'user_stopped',
      terminal: null,
      permissionMode: null,
      sandboxMode: null,
      model: null,
      effort: null,
      runtime: null,
    });

    const harness = createHarness({
      continueTurn: () => {
        throw new Error('a retired provider binding must never be continued');
      },
    });
    await harness.host.recoverAfterRestart();

    const recovered = residentBindingsDb.getByTaskId('task-retired')!;
    assert.equal(recovered.status, 'stopped');
    assert.equal(recovered.stopCause, 'disabled');
    // Ended, not failed: no alert, and the episode is recorded as a stopped one.
    assert.equal(recovered.terminal?.cause, 'disabled');
    assert.equal(recovered.terminal?.status, 'stopped');
    assert.equal(recovered.terminal?.alert, false);
    // Identity, native id, dispatch settings and the switch are preserved as stored.
    assert.equal(recovered.provider, 'dsh');
    assert.equal(recovered.providerSessionId, 'dsh-native-1');
    assert.equal(recovered.model, 'gw/model');
    assert.equal(recovered.enabled, true);
    // No provider round trip and no fabricated Codex runtime.
    assert.deepEqual(harness.aborts, []);
    assert.deepEqual(harness.continueCalls, []);
    assert.equal(sessionsDb.isSessionResidentProtected(retiredSession), true);

    const listed = await harness.host.handleRequest('status', { taskId: 'task-retired' }) as {
      bindings: ResidentBindingView[];
    };
    assert.equal(listed.bindings[0]?.status, 'stopped');
    assert.equal(listed.bindings[0]?.runtime.provider, 'dsh');

    // The leftover `stopping` row is ended the same silent way and no longer blocks
    // anything: its stored switch, provider and session stay as they were.
    const recoveredStopping = residentBindingsDb.getByTaskId('task-retired-stopping')!;
    assert.equal(recoveredStopping.status, 'stopped');
    assert.equal(recoveredStopping.stopCause, 'disabled');
    assert.equal(recoveredStopping.terminal?.cause, 'disabled');
    assert.equal(recoveredStopping.terminal?.alert, false);
    assert.equal(recoveredStopping.enabled, true);
    assert.equal(recoveredStopping.provider, 'dsh');
    assert.equal(sessionsDb.isSessionResidentProtected(stoppingSession), true);
    assert.deepEqual(harness.aborts, []);

    // Manual continue and re-enable refuse the retired provider explicitly.
    const refused = (error: unknown) => error instanceof AppError && error.code === 'unsupported_provider';
    await assert.rejects(harness.host.handleRequest('continue', { taskId: 'task-retired' }), refused);
    await assert.rejects(
      harness.host.handleRequest('setEnabled', { taskId: 'task-retired', enabled: true }),
      refused,
    );
    assert.deepEqual(harness.continueCalls, []);

    // The ordinary remove flow cleans the binding up and keeps the session.
    const removed = await harness.host.handleRequest('remove', { taskId: 'task-retired' }) as {
      removed: boolean;
      sessionId: string;
    };
    assert.equal(removed.removed, true);
    assert.equal(removed.sessionId, retiredSession);
    assert.equal(residentBindingsDb.getByTaskId('task-retired'), null);
    assert.equal(sessionsDb.getSessionById(retiredSession)?.session_id, retiredSession);

    // The recovered `stopping` binding is removable through the same flow.
    const removedStopping = await harness.host.handleRequest('remove', {
      taskId: 'task-retired-stopping',
    }) as { removed: boolean; sessionId: string };
    assert.equal(removedStopping.removed, true);
    assert.equal(removedStopping.sessionId, stoppingSession);
    assert.equal(residentBindingsDb.getByTaskId('task-retired-stopping'), null);
    assert.equal(sessionsDb.getSessionById(stoppingSession)?.session_id, stoppingSession);
    await harness.host.shutdown();
  });
});

test('stopping a retired provider binding ends it locally without calling the provider', async () => {
  await withDatabase(async () => {
    const retiredSession = 'retired-dsh-running';
    sessionsDb.createAppSession(retiredSession, 'dsh', path.join('dsh-project'), 'DSH running');
    sessionsDb.assignProviderSessionId(retiredSession, 'dsh-native-2');
    residentBindingsDb.insert({
      taskId: 'task-retired-stop',
      sessionId: retiredSession,
      projectId: '',
      name: 'DSH running',
      provider: 'dsh',
      providerSessionId: 'dsh-native-2',
      enabled: true,
      visible: true,
      status: 'running',
      executionId: 'dsh-exec-2',
      stopCause: null,
      terminal: null,
      permissionMode: null,
      sandboxMode: null,
      model: null,
      effort: null,
      runtime: null,
    });

    const harness = createHarness();
    const stopped = await harness.host.handleRequest('stop', { taskId: 'task-retired-stop' }) as {
      binding: ResidentBindingView;
    };
    assert.deepEqual(harness.aborts, []);
    assert.equal(stopped.binding.status, 'stopped');
    assert.equal(stopped.binding.terminal?.cause, 'user_stopped');
    assert.equal(stopped.binding.terminal?.alert, false);
    assert.equal(stopped.binding.runtime.provider, 'dsh');
    await harness.host.shutdown();
  });
});

test('the resident task name follows the linked session title without touching persisted state', async () => {
  await withDatabase(async () => {
    const harness = createHarness();
    admitRun();
    const adopted = await harness.host.handleRequest('adopt', {
      taskId: 'task-title',
      sessionId: SESSION,
    }) as { binding: ResidentBindingView };
    // Adoption snapshots the session title it was created with.
    assert.equal(adopted.binding.name, 'Resident conversation');
    const persisted = residentBindingsDb.getByTaskId('task-title')!;
    const executionBefore = (await harness.host.handleRequest('status', {
      taskId: 'task-title',
    }) as { bindings: ResidentBindingView[] }).bindings[0].executionId;

    // The real rename path the sidebar uses.
    sessionsService.renameSessionById(SESSION, '侧栏重命名后的标题');

    const all = await harness.host.handleRequest('status', {}) as {
      bindings: ResidentBindingView[];
    };
    const one = await harness.host.handleRequest('status', {
      taskId: 'task-title',
    }) as { bindings: ResidentBindingView[] };
    for (const binding of [all.bindings[0], one.bindings[0]]) {
      assert.equal(binding.name, '侧栏重命名后的标题');
      // Only the display title follows; identity, run state and fallback are unchanged.
      assert.equal(binding.taskId, persisted.taskId);
      assert.equal(binding.sessionId, persisted.sessionId);
      assert.equal(binding.executionId, executionBefore);
      assert.equal(binding.enabled, persisted.enabled);
      assert.equal(binding.visible, persisted.visible);
      assert.equal(binding.status, persisted.status);
    }
    // The persisted adoption snapshot is untouched, and no run control fired.
    assert.equal(residentBindingsDb.getByTaskId('task-title')?.name, persisted.name);
    assert.deepEqual(harness.continueCalls, []);
    assert.deepEqual(harness.aborts, []);

    // A blank current title keeps the persisted adoption snapshot as fallback.
    sessionsService.renameSessionById(SESSION, '   ');
    const fallback = await harness.host.handleRequest('status', {
      taskId: 'task-title',
    }) as { bindings: ResidentBindingView[] };
    assert.equal(fallback.bindings[0].name, 'Resident conversation');
    await harness.host.shutdown();
  });
});

test('the system run-start log belongs to the new execution, not the previous one', async () => {
  await withDatabase(async () => {
    const harness = createHarness();
    const first = admitRun();
    await harness.host.handleRequest('adopt', { taskId: 'task-exec-log', sessionId: SESSION });
    // A real second admission replaces the binding's execution id.
    const second = admitRun('resident');
    assert.notEqual(second.executionId, first.executionId);
    assert.equal(residentBindingsDb.getByTaskId('task-exec-log')?.executionId, second.executionId);

    const runStarts = harness.logs.list({ taskId: 'task-exec-log' }).logs
      .filter((entry) => entry.content === '运行开始');
    assert.ok(runStarts.length > 0);
    // The newest run-start entry carries the new execution, never the earlier one.
    assert.equal(runStarts[0].executionId, second.executionId);
    assert.equal(runStarts.some((entry) => entry.executionId === first.executionId), false);
    // The adopt entry is a separate real transition.
    assert.equal(
      harness.logs.list({ taskId: 'task-exec-log' }).logs.some((entry) => entry.content === '已设为常驻任务'),
      true,
    );
  });
});
