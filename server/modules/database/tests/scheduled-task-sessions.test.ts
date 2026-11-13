import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  residentBindingsDb,
  scheduledTaskSessionsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

async function withDatabase(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scheduled-task-sessions-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    await run(root);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

/** Creates an indexed session with a provider-native id, like a real first run. */
function createNativeSession(
  sessionId: string,
  provider: 'codex' | 'dsh',
  projectPath: string,
  providerSessionId: string,
) {
  sessionsDb.createAppSession(sessionId, provider, projectPath, sessionId);
  sessionsDb.assignProviderSessionId(sessionId, providerSessionId);
}

test('the same task id in two projects keeps separate bindings and protection', async () => {
  await withDatabase(async (root) => {
    const projectOne = path.join(root, 'project-one');
    const projectTwo = path.join(root, 'project-two');
    createNativeSession('session-one', 'codex', projectOne, 'native-one');
    createNativeSession('session-two', 'codex', projectTwo, 'native-two');

    scheduledTaskSessionsDb.insert({
      projectId: 'project-1',
      taskId: 'shared-task',
      sessionId: 'session-one',
      cwd: projectOne,
    });
    scheduledTaskSessionsDb.insert({
      projectId: 'project-2',
      taskId: 'shared-task',
      sessionId: 'session-two',
      cwd: projectTwo,
    });

    assert.equal(
      scheduledTaskSessionsDb.findReusable({
        projectId: 'project-1',
        taskId: 'shared-task',
        provider: 'codex',
        cwd: projectOne,
      })?.sessionId,
      'session-one',
    );
    assert.equal(
      scheduledTaskSessionsDb.findReusable({
        projectId: 'project-2',
        taskId: 'shared-task',
        provider: 'codex',
        cwd: projectTwo,
      })?.sessionId,
      'session-two',
    );

    // Deleting one project's task leaves the identically named task in the other project bound.
    assert.equal(scheduledTaskSessionsDb.removeMissingTasks('project-1', []), 1);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected('session-one'), false);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected('session-two'), true);
    assert.equal(sessionsDb.deleteSessionById('session-two'), false);
  });
});

test('the newest compatible binding is reused and older bindings stay protected', async () => {
  await withDatabase(async (root) => {
    const oldCwd = path.join(root, 'old-cwd');
    const newCwd = path.join(root, 'new-cwd');
    createNativeSession('session-old', 'dsh', oldCwd, 'native-old');
    createNativeSession('session-new', 'dsh', newCwd, 'native-new');

    const first = scheduledTaskSessionsDb.insert({
      projectId: 'project-1',
      taskId: 'task-1',
      sessionId: 'session-old',
      cwd: oldCwd,
    });
    scheduledTaskSessionsDb.insert({
      projectId: 'project-1',
      taskId: 'task-1',
      sessionId: 'session-new',
      cwd: newCwd,
    });

    const secondBinding = scheduledTaskSessionsDb.listByTask('project-1', 'task-1')
      .find((row) => row.sessionId === 'session-new')!;
    assert.equal(
      scheduledTaskSessionsDb.findReusable({
        projectId: 'project-1',
        taskId: 'task-1',
        provider: 'dsh',
        cwd: oldCwd,
      })?.sessionId,
      'session-old',
    );
    assert.deepEqual(
      scheduledTaskSessionsDb.findReusable({
        projectId: 'project-1',
        taskId: 'task-1',
        provider: 'dsh',
        cwd: newCwd,
      }),
      {
        ...secondBinding,
        provider: 'dsh',
        providerSessionId: 'native-new',
      },
    );

    // Editing the task's cwd must not unlock the replaced binding or its session.
    assert.deepEqual(
      scheduledTaskSessionsDb.listByTask('project-1', 'task-1').map((row) => row.sessionId),
      ['session-old', 'session-new'],
    );
    assert.equal(sessionsDb.isSessionResidentProtected('session-old'), true);
    assert.equal(sessionsDb.isSessionResidentProtected('session-new'), true);

    // Re-inserting the same reference is idempotent and preserves the original binding.
    const repeated = scheduledTaskSessionsDb.insert({
      projectId: 'project-1',
      taskId: 'task-1',
      sessionId: 'session-old',
      cwd: oldCwd,
    });
    assert.equal(repeated.createdAt, first.createdAt);
    assert.equal(scheduledTaskSessionsDb.listByTask('project-1', 'task-1').length, 2);
  });
});

test('native-id retention protection works for both scheduler providers and keeps resident protection', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    const codexPath = path.join(root, 'codex-cwd');
    const dshPath = path.join(root, 'dsh-cwd');
    createNativeSession('codex-session', 'codex', projectPath, 'codex-native');
    createNativeSession('dsh-session', 'dsh', projectPath, 'dsh-native');
    createNativeSession('resident-session', 'codex', projectPath, 'resident-native');

    scheduledTaskSessionsDb.insert({
      projectId: 'project-1',
      taskId: 'codex-task',
      sessionId: 'codex-session',
      cwd: codexPath,
    });
    scheduledTaskSessionsDb.insert({
      projectId: 'project-1',
      taskId: 'dsh-task',
      sessionId: 'dsh-session',
      cwd: dshPath,
    });
    residentBindingsDb.insert({
      taskId: 'resident-task',
      sessionId: 'resident-session',
      projectId: 'project-1',
      name: 'Resident task',
      provider: 'codex',
      providerSessionId: 'resident-native',
      enabled: true,
      visible: true,
      status: 'idle',
      executionId: null,
      stopCause: null,
      terminal: null,
      permissionMode: null,
      sandboxMode: null,
      model: null,
      effort: null,
      runtime: null,
    });

    assert.equal(sessionsDb.isProviderSessionResidentProtected('codex', 'codex-native'), true);
    assert.equal(sessionsDb.isProviderSessionResidentProtected('dsh', 'dsh-native'), true);
    assert.equal(sessionsDb.isProviderSessionResidentProtected('codex', 'dsh-native'), false);
    assert.equal(sessionsDb.isProviderSessionResidentProtected('codex', 'unknown-native'), false);
    assert.equal(sessionsDb.deleteSessionByProviderSessionId('codex-native', 'codex'), false);

    // Reconciling scheduled tasks must not unlock the unrelated resident binding.
    scheduledTaskSessionsDb.removeMissingTasks('project-1', []);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected('codex-session'), false);
    assert.equal(sessionsDb.isSessionResidentProtected('resident-session'), true);
    assert.equal(sessionsDb.deleteSessionById('resident-session'), false);
    assert.equal(sessionsDb.deleteSessionById('codex-session'), true);
  });
});

test('orphan pruning and project purge keep bound sessions until the task is removed', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    createNativeSession('bound-session', 'codex', projectPath, 'bound-native');
    createNativeSession('purged-session', 'codex', projectPath, 'purged-native');

    scheduledTaskSessionsDb.insert({
      projectId: 'project-1',
      taskId: 'task-1',
      sessionId: 'bound-session',
      cwd: projectPath,
    });

    // The synchronizer prunes orphaned native rows through `deleteSessionById`.
    assert.equal(sessionsDb.deleteSessionById('bound-session'), false);
    assert.ok(sessionsDb.getSessionById('bound-session'));

    // A project purge drops the unbound row but never the task's session.
    sessionsDb.deleteSessionsByProjectPath(projectPath);
    assert.ok(sessionsDb.getSessionById('bound-session'));
    assert.equal(sessionsDb.getSessionById('purged-session'), null);

    // Reconciling against the current task list keeps a still-present task bound.
    assert.equal(scheduledTaskSessionsDb.removeMissingTasks('project-1', ['task-1']), 0);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected('bound-session'), true);
  });
});

test('deleting a task keeps its session and only then allows a physical delete', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    createNativeSession('kept-session', 'codex', projectPath, 'kept-native');
    scheduledTaskSessionsDb.insert({
      projectId: 'project-1',
      taskId: 'task-1',
      sessionId: 'kept-session',
      cwd: projectPath,
    });

    // A task sync that finds no tasks removes the bindings, keeps the session, and only then
    // allows the user's physical delete.
    assert.equal(scheduledTaskSessionsDb.removeMissingTasks('project-1', []), 1);
    assert.ok(sessionsDb.getSessionById('kept-session'));
    assert.equal(sessionsDb.deleteSessionById('kept-session'), true);
    assert.equal(sessionsDb.getSessionById('kept-session'), null);
  });
});

test('migrations add the binding table without rewriting resident rows', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    createNativeSession('resident-session', 'codex', projectPath, 'resident-native');
    const db = getConnection();
    residentBindingsDb.insert({
      taskId: 'resident-task',
      sessionId: 'resident-session',
      projectId: 'project-1',
      name: 'Resident task',
      provider: 'codex',
      providerSessionId: 'resident-native',
      enabled: true,
      visible: true,
      status: 'stopped',
      executionId: null,
      stopCause: null,
      terminal: null,
      permissionMode: null,
      sandboxMode: null,
      model: null,
      effort: null,
      runtime: null,
    });

    // Model an installation created before scheduled task bindings existed.
    db.exec('DROP TABLE scheduled_task_sessions');
    runMigrations(db);
    runMigrations(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'scheduled_task_sessions'",
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((row) => row.name), ['scheduled_task_sessions']);
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'scheduled_task_sessions' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(indexes.map((row) => row.name), [
      'idx_scheduled_task_sessions_session',
      'idx_scheduled_task_sessions_task_cwd',
      'sqlite_autoindex_scheduled_task_sessions_1',
    ]);
    assert.equal(residentBindingsDb.getByTaskId('resident-task')?.providerSessionId, 'resident-native');
  });
});
