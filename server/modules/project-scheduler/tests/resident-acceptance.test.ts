import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionRuntimeDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { deleteOrArchiveProject } from '@/modules/projects/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { readResidentSessionInfo } from '@/modules/project-scheduler/index.js';
import type {
  ProviderRuntimeGateway,
  ResidentContinueAdmission,
  ResidentIpcEvent,
} from '@/shared/index.js';
import { AppError } from '@/shared/utils.js';

import { createResidentHostService } from '../resident-host.service.js';

/**
 * End-to-end acceptance for the resident binding guards the plugin relies on.
 *
 * These run the real database guards, the real session deletion service and the
 * real project deletion service against a temporary database and directory.
 * Nothing here talks to a provider: adoption uses a real chat-run-registry
 * admission (the same entry dispatchRun uses), and every other host dependency
 * is the injected seam the composition root already supplies.
 */

const SESSION = 'resident-acceptance-session';
const NATIVE_ID = 'native-acceptance-thread';

async function withDatabase(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resident-acceptance-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    await run(root);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function seedCodexSession(projectPath: string, sessionId = SESSION) {
  sessionsDb.createAppSession(sessionId, 'codex', projectPath, 'Acceptance conversation');
  sessionsDb.assignProviderSessionId(sessionId, NATIVE_ID);
  sessionRuntimeDb.update(sessionId, { runtime: 'app-server', queueHeld: false });
}

/** Admits a real registry run for the seeded session, as dispatchRun does synchronously. */
function admitRun(sessionId = SESSION) {
  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: 'codex',
    providerSessionId: NATIVE_ID,
    connection: null,
    userId: null,
    dispatch: {
      origin: 'foreground',
      permissionMode: 'acceptEdits',
      sandboxMode: 'workspace-write',
      model: 'gpt-5',
      effort: 'high',
      runtimeMode: 'app-server',
    },
  });
  assert.ok(run, 'the registry admits the run');
  return run;
}

type Settled = { started: boolean; error: string | null };

function createHarness(options: {
  pluginEnabled?: boolean;
  admission?: { accepted: true; executionId: string; settled: Promise<Settled> };
} = {}) {
  const events: ResidentIpcEvent[] = [];
  const continueCalls: string[] = [];
  const announcements: Array<{ kind: 'upsert' | 'removed'; sessionId: string }> = [];
  const runtime = {
    hasRuntime: () => true,
    abort: async () => true,
    getState: () => undefined,
    getManagedState: () => undefined,
    hasBackgroundWork: () => false,
    isQueueBlocked: () => false,
  } as unknown as ProviderRuntimeGateway;
  const host = createResidentHostService({
    runtime,
    // The binding guard must not depend on the plugin process being alive.
    isPluginEnabled: () => options.pluginEnabled ?? true,
    emitEvent: (event) => events.push(event),
    continueTurn: (input): ResidentContinueAdmission => {
      continueCalls.push(input.sessionId);
      return options.admission ?? { accepted: false, reason: 'unavailable', error: 'not configured' };
    },
    requestQueueDispatch: () => undefined,
    announceSession: (sessionId) => announcements.push({ kind: 'upsert', sessionId }),
    announceSessionRemoved: (sessionId) => announcements.push({ kind: 'removed', sessionId }),
  });
  host.initialize();
  const terminalEvents = () => events.filter(
    (event) => event.kind === 'event' && event.event === 'terminal',
  );
  return { host, events, terminalEvents, continueCalls, announcements };
}

/**
 * Force deletion is a physical delete of the row and its transcript, so it is
 * the destructive path the binding has to stop. Archiving stays available, the
 * row still answers a by-id lookup, and foreground lists/counts drop it.
 */
test('a disabled hidden binding keeps refusing force deletion and hiding from lists until it is removed', async () => {
  await withDatabase(async (root) => {
    seedCodexSession(root);
    admitRun();
    const harness = createHarness({ pluginEnabled: false });
    const adopted = await harness.host.handleRequest('adopt', {
      taskId: 'task-acceptance',
      sessionId: SESSION,
    }) as { binding: { taskId: string } };
    assert.equal(adopted.binding.taskId, 'task-acceptance');

    // Disabled: silent, still protected.
    const disabled = await harness.host.handleRequest('setEnabled', {
      taskId: 'task-acceptance',
      enabled: false,
    }) as { binding: { enabled: boolean } };
    assert.equal(disabled.binding.enabled, false);
    // Hidden: dropped from the sidebar without archiving the row.
    await harness.host.handleRequest('setVisible', { taskId: 'task-acceptance', visible: false });
    assert.equal(harness.announcements.at(-1)?.kind, 'removed');

    // Lookup by id still resolves the real row, hidden or not.
    assert.ok(sessionsDb.getSessionById(SESSION));
    // Every foreground list and count applies the binding's visible flag.
    assert.equal(sessionsDb.countSessionsByProjectPath(root), 0);
    assert.deepEqual(sessionsDb.getSessionsByProjectPathPage(root, 10, 0), []);

    // The guard the projection reads reports the binding, not "adopt me".
    const info = readResidentSessionInfo({ sessionId: SESSION, provider: 'codex' });
    assert.equal(info?.blockedReason, 'already_resident');
    assert.equal(info?.adoptable, false);
    assert.equal(info?.enabled, false);
    assert.equal(info?.visible, false);

    // The real API path: force delete is refused, archive is still allowed.
    await assert.rejects(
      sessionsService.deleteOrArchiveSessionById(SESSION, { force: true }),
      (error: unknown) => error instanceof AppError && error.code === 'RESIDENT_PROTECTED',
    );
    // The call the orphan prune makes for a vanished transcript.
    assert.equal(sessionsDb.deleteSessionById(SESSION), false);
    const archived = await sessionsService.deleteOrArchiveSessionById(SESSION, { force: false });
    assert.equal(archived.action, 'archived');
    sessionsDb.updateSessionIsArchived(SESSION, false);

    // Removing the task keeps the session and hands it back to normal management.
    const removed = await harness.host.handleRequest('remove', { taskId: 'task-acceptance' });
    assert.deepEqual(removed, { removed: true, sessionId: SESSION });
    assert.equal(harness.announcements.at(-1)?.kind, 'upsert');
    assert.ok(sessionsDb.getSessionById(SESSION), 'the session survives unbinding');
    assert.equal(sessionsDb.countSessionsByProjectPath(root), 1);
    assert.equal(sessionsDb.isSessionResidentProtected(SESSION), false);
    const deleted = await sessionsService.deleteOrArchiveSessionById(SESSION, { force: true });
    assert.equal(deleted.action, 'deleted');
    assert.equal(sessionsDb.getSessionById(SESSION), null);
  });
});

test('a protected session is not merged away by the provider-id duplicate cleanup', async () => {
  await withDatabase(async (root) => {
    // The watcher indexed the native transcript first, so the bound row is the
    // duplicate the id assignment would otherwise delete inside its transaction.
    seedCodexSession(root);
    admitRun();
    const harness = createHarness();
    await harness.host.handleRequest('adopt', { taskId: 'task-merge', sessionId: SESSION });
    sessionsDb.createSession(
      `watcher-${NATIVE_ID}`,
      'codex',
      root,
      'Watcher row',
      undefined,
      undefined,
      path.join(root, 'native.jsonl'),
    );
    sessionsDb.assignProviderSessionId(`watcher-${NATIVE_ID}`, NATIVE_ID);

    // The bound row still owns its transcript path and cannot be pruned later.
    assert.ok(sessionsDb.getSessionById(SESSION));
    assert.equal(sessionsDb.isSessionResidentProtected(SESSION), true);
  });
});

/**
 * Project force deletion removes todos, transcripts and rows. The guard has to
 * run before the first of those, and unbinding has to restore the whole path.
 */
test('project force deletion refuses before transcripts, todos or rows are touched', async () => {
  await withDatabase(async (root) => {
    const project = projectsDb.createProjectPath(root);
    assert.ok(project.project);
    const projectId = project.project.project_id;
    const transcript = path.join(root, 'acceptance.jsonl');
    await writeFile(transcript, '{"type":"summary"}\n', 'utf8');
    sessionsDb.createSession(SESSION, 'codex', root, 'Acceptance', undefined, undefined, transcript);
    sessionsDb.assignProviderSessionId(SESSION, NATIVE_ID);
    sessionRuntimeDb.update(SESSION, { runtime: 'app-server', queueHeld: false });
    admitRun();
    const harness = createHarness();
    await harness.host.handleRequest('adopt', { taskId: 'task-project', sessionId: SESSION });

    await assert.rejects(
      deleteOrArchiveProject(projectId, true),
      (error: unknown) => error instanceof AppError && error.code === 'RESIDENT_PROTECTED',
    );
    // First side effect untouched: the transcript is still on disk.
    assert.equal(await readFile(transcript, 'utf8'), '{"type":"summary"}\n');
    assert.ok(projectsDb.getProjectById(projectId));
    assert.ok(sessionsDb.getSessionById(SESSION));

    // The foreground turn ends and is settled, so the task can be removed.
    chatRunRegistry.completeRun(SESSION, { exitCode: 0 });
    harness.host.onSessionSettled(SESSION);
    await harness.host.handleRequest('remove', { taskId: 'task-project' });
    await deleteOrArchiveProject(projectId, true);
    assert.equal(projectsDb.getProjectById(projectId), null);
    assert.equal(sessionsDb.getSessionById(SESSION), null);
    await assert.rejects(readFile(transcript, 'utf8'), { code: 'ENOENT' });
  });
});

/**
 * Sync/status traffic is reconciliation only. The plugin re-asks for state every
 * time it (re)starts, and a binding must never be fed a second continue by it.
 */
test('status and snapshot reconciliation never continues a binding', async () => {
  await withDatabase(async (root) => {
    seedCodexSession(root);
    admitRun();
    const harness = createHarness();
    await harness.host.handleRequest('adopt', { taskId: 'task-sync', sessionId: SESSION });

    const status = await harness.host.handleRequest('status', {}) as { bindings: unknown[] };
    assert.equal(status.bindings.length, 1);
    const single = await harness.host.handleRequest('status', { taskId: 'task-sync' });
    assert.deepEqual(single, { bindings: status.bindings });
    assert.equal(harness.host.snapshot().bindings.length, 1);
    assert.equal(harness.host.isBusy(), true);
    assert.deepEqual(harness.continueCalls, []);
    assert.equal(harness.terminalEvents().length, 0);
  });
});

/**
 * A continue that is admitted but never starts must still close its episode
 * exactly once: the settled rejection is the only terminal for that execution,
 * and a later settle notification cannot resurrect or re-alert it.
 */
test('an admitted continue that fails to settle commits one failed alerting terminal', async () => {
  await withDatabase(async (root) => {
    seedCodexSession(root);
    admitRun();
    let settle!: (value: Settled) => void;
    const settled = new Promise<Settled>((resolve) => { settle = resolve; });
    const harness = createHarness({
      admission: { accepted: true, executionId: 'exec-settled-failed', settled },
    });
    await harness.host.handleRequest('adopt', { taskId: 'task-settle', sessionId: SESSION });
    // The foreground turn ended and settled before the plugin asks to continue.
    chatRunRegistry.completeRun(SESSION, { exitCode: 0 });
    harness.host.onSessionSettled(SESSION);

    const continued = await harness.host.handleRequest('continue', { taskId: 'task-settle' }) as {
      result: { accepted: boolean };
      binding: { status: string };
    };
    assert.equal(continued.result.accepted, true);
    assert.equal(continued.binding.status, 'running');

    // The foreground episode already committed its own terminal; count only what
    // the failed continue adds.
    const baseline = harness.terminalEvents().length;
    settle({ started: false, error: 'the turn could not start' });
    await settled;
    // Let the rejection handler run before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    const bindings = await harness.host.handleRequest('status', { taskId: 'task-settle' }) as {
      bindings: Array<{ status: string; terminal: { id: string; cause: string; alert: boolean; reason: string | null } | null }>;
    };
    const binding = bindings.bindings[0];
    assert.equal(binding.status, 'stopped');
    assert.equal(binding.terminal?.id, 'task-settle:exec-settled-failed');
    assert.equal(binding.terminal?.cause, 'failed');
    assert.equal(binding.terminal?.alert, true);
    assert.equal(binding.terminal?.reason, 'the turn could not start');
    assert.equal(harness.terminalEvents().length, baseline + 1);

    // A settle notification for the same session is not a new episode.
    harness.host.onSessionSettled(SESSION);
    harness.host.onSessionSettled(SESSION);
    const after = await harness.host.handleRequest('status', { taskId: 'task-settle' }) as {
      bindings: Array<{ terminal: { id: string } | null }>;
    };
    assert.equal(after.bindings[0].terminal?.id, 'task-settle:exec-settled-failed');
    assert.equal(harness.terminalEvents().length, baseline + 1);
    assert.deepEqual(harness.continueCalls, [SESSION]);
  });
});
