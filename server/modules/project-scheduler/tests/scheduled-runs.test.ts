import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  residentBindingsDb,
  scheduledTaskSessionsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { createScheduledRunHostService } from '@/modules/project-scheduler/scheduled-run.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/shared/index.js';
import { AppError } from '@/shared/utils.js';

async function withDatabase(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scheduled-run-host-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    await run(root);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function createService() {
  const dispatches: string[] = [];
  const announcements: string[] = [];
  const service = createScheduledRunHostService({
    requestQueueDispatch: (sessionId) => dispatches.push(sessionId),
    announceSession: (sessionId) => announcements.push(sessionId),
  });
  return { service, dispatches, announcements };
}

async function createProject(root: string, name: string): Promise<{ projectId: string; projectPath: string }> {
  const projectPath = path.join(root, name);
  await mkdir(projectPath, { recursive: true });
  const project = projectsDb.createProjectPath(projectPath).project;
  assert.ok(project);
  return { projectId: project.project_id, projectPath };
}

async function writeCodexTranscript(
  sessionsRoot: string,
  nativeSessionId: string,
  cwd: string,
): Promise<string> {
  const directory = path.join(sessionsRoot, '2026', '01', '02');
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-2026-01-02T03-04-05-${nativeSessionId}.jsonl`);
  await writeFile(
    filePath,
    `${JSON.stringify({
      timestamp: '2026-01-02T03:04:05.000Z',
      type: 'session_meta',
      payload: { id: nativeSessionId, cwd },
    })}\n`,
  );
  return filePath;
}

function codexTurn(index: number, prompt: string, reply: string) {
  const turnId = `turn-${index}`;
  const timestamp = new Date(Date.UTC(2026, 0, 2, 3, 4, index)).toISOString();
  return [
    { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    { timestamp, type: 'turn_context', payload: { turn_id: turnId } },
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: prompt } },
    {
      timestamp,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] },
    },
    { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
  ];
}

async function appendCodexTurn(
  filePath: string,
  index: number,
  prompt: string,
  reply: string,
): Promise<void> {
  await appendFile(filePath, `${codexTurn(index, prompt, reply).map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function dshHeader(nativeSessionId: string, cwd: string) {
  return { type: 'session', version: 4, id: nativeSessionId, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 };
}

function dshUser(seq: number, text: string) {
  return {
    type: 'user/message',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    data: {
      id: `user-${seq}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  };
}

function dshAssistant(seq: number, text: string) {
  return {
    type: 'assistant/message',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `assistant-${seq}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        content: [{ type: 'text', text }],
      },
    },
  };
}

async function writeDshTranscript(
  sessionsRoot: string,
  nativeSessionId: string,
  cwd: string,
  rows: Array<Record<string, unknown>>,
  version = 4,
): Promise<string> {
  const directory = path.join(sessionsRoot, 'workspace', nativeSessionId);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `session.v${version}.jsonl`);
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return filePath;
}

async function appendDshRows(filePath: string, rows: Array<Record<string, unknown>>): Promise<void> {
  await appendFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function preparePayload(input: {
  projectId: string;
  taskId: string;
  runId: string;
  provider: 'codex' | 'dsh';
  cwd: string;
  sessionsRoot: string;
  reuseSession?: boolean;
}) {
  return {
    projectId: input.projectId,
    taskId: input.taskId,
    runId: input.runId,
    agent: {
      provider: input.provider,
      model: input.provider === 'codex' ? 'gpt-test' : 'deepseek-test',
      effort: 'high',
    },
    cwd: input.cwd,
    reuseSession: input.reuseSession ?? false,
    sessionsRoot: input.sessionsRoot,
  };
}

test('prepare rejects a cwd outside the committed project', async () => {
  await withDatabase(async (root) => {
    const { projectId } = await createProject(root, 'project');
    const outside = await mkdtemp(path.join(os.tmpdir(), 'scheduled-outside-'));
    try {
      const { service } = createService();
      await assert.rejects(
        service.handleRequest('scheduledPrepare', preparePayload({
          projectId,
          taskId: 'task-outside',
          runId: 'run-outside',
          provider: 'codex',
          cwd: outside,
          sessionsRoot: path.join(root, 'sessions'),
        })),
        (error: unknown) => error instanceof AppError && error.code === 'invalid_request',
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('prepare, attach and finish map a custom CODEX_HOME transcript and release busy once', async () => {
  await withDatabase(async (root) => {
    const { projectId, projectPath } = await createProject(root, 'project');
    const cwd = path.join(projectPath, 'packages', 'app');
    await mkdir(cwd, { recursive: true });
    // Deliberately outside ~/.codex to prove the host does not rely on the fixed scan.
    const sessionsRoot = path.join(root, 'custom-codex-home', 'sessions');
    const nativeId = 'thread-custom-home';
    const transcript = await writeCodexTranscript(sessionsRoot, nativeId, cwd);
    const { service, dispatches } = createService();

    const prepared = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'task-one',
      runId: 'run-one',
      provider: 'codex',
      cwd,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string; nativeSessionId: string | null };
    assert.equal(prepared.nativeSessionId, null);
    assert.equal(chatRunRegistry.isProcessing(prepared.sessionId), true);
    // The new session is not protected until the native id and transcript are verified.
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(prepared.sessionId), false);

    const attached = await service.handleRequest('scheduledAttachNative', {
      runId: 'run-one',
      executionId: prepared.executionId,
      nativeSessionId: nativeId,
    }) as { sessionId: string };
    assert.equal(attached.sessionId, prepared.sessionId);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(prepared.sessionId), true);
    const session = sessionsDb.getSessionById(prepared.sessionId);
    assert.equal(session?.provider_session_id, nativeId);
    assert.equal(session?.jsonl_path, transcript);
    assert.equal(session?.provider, 'codex');
    assert.equal(session?.model, 'gpt-test');
    assert.equal(session?.effort, 'high');

    const finished = await service.handleRequest('scheduledFinishRun', {
      runId: 'run-one',
      executionId: prepared.executionId,
      outcome: { code: 0, success: true },
    }) as { finished: boolean };
    assert.equal(finished.finished, true);
    assert.equal(chatRunRegistry.isProcessing(prepared.sessionId), false);
    assert.deepEqual(dispatches, [prepared.sessionId]);
    // A duplicate finish is a no-op and cannot complete a later run.
    assert.deepEqual(
      await service.handleRequest('scheduledFinishRun', {
        runId: 'run-one',
        executionId: prepared.executionId,
        outcome: { code: 0, success: true },
      }),
      { finished: false },
    );
  });
});

test('reuse selects the same native session across runs and after a host restart', async () => {
  await withDatabase(async (root) => {
    const { projectId, projectPath } = await createProject(root, 'project');
    const sessionsRoot = path.join(root, 'codex-sessions');
    const firstNative = 'thread-first';
    await writeCodexTranscript(sessionsRoot, firstNative, projectPath);
    const first = createService();

    const prepared = await first.service.handleRequest('scheduledPrepare', preparePayload({
      projectId, taskId: 'daily', runId: 'run-1', provider: 'codex', cwd: projectPath, sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string };
    await first.service.handleRequest('scheduledAttachNative', {
      runId: 'run-1', executionId: prepared.executionId, nativeSessionId: firstNative,
    });
    await first.service.handleRequest('scheduledFinishRun', {
      runId: 'run-1', executionId: prepared.executionId, outcome: { code: 0, success: true },
    });

    const second = createService();
    const reused = await second.service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'daily',
      runId: 'run-2',
      provider: 'codex',
      cwd: projectPath,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string; nativeSessionId: string | null };
    assert.equal(reused.sessionId, prepared.sessionId);
    assert.equal(reused.nativeSessionId, firstNative);

    await second.service.handleRequest('scheduledAttachNative', {
      runId: 'run-2', executionId: reused.executionId, nativeSessionId: firstNative,
    });
    await second.service.handleRequest('scheduledFinishRun', {
      runId: 'run-2', executionId: reused.executionId, outcome: { code: 0, success: true },
    });

    // A host restart forgets the old run but keeps the binding and transcript in the database.
    chatRunRegistry.clearAll();
    const third = createService();
    const recovered = await third.service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'daily',
      runId: 'run-3',
      provider: 'codex',
      cwd: projectPath,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; nativeSessionId: string | null };
    assert.equal(recovered.sessionId, prepared.sessionId);
    assert.equal(recovered.nativeSessionId, firstNative);
    assert.equal(
      sessionsDb.getSessionById(prepared.sessionId)?.jsonl_path,
      path.join(sessionsRoot, '2026', '01', '02', `rollout-2026-01-02T03-04-05-${firstNative}.jsonl`),
    );
  });
});

test('the same task id in two projects keeps separate sessions and bindings', async () => {
  await withDatabase(async (root) => {
    const firstProject = await createProject(root, 'first-project');
    const secondProject = await createProject(root, 'second-project');
    const sessionsRoot = path.join(root, 'codex-sessions');
    const firstNative = 'thread-project-one';
    const secondNative = 'thread-project-two';
    await writeCodexTranscript(sessionsRoot, firstNative, firstProject.projectPath);
    await writeCodexTranscript(sessionsRoot, secondNative, secondProject.projectPath);
    const { service } = createService();

    const first = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId: firstProject.projectId,
      taskId: 'shared-task',
      runId: 'run-a',
      provider: 'codex',
      cwd: firstProject.projectPath,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string };
    const second = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId: secondProject.projectId,
      taskId: 'shared-task',
      runId: 'run-b',
      provider: 'codex',
      cwd: secondProject.projectPath,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string };
    assert.notEqual(first.sessionId, second.sessionId);
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-a', executionId: first.executionId, nativeSessionId: firstNative,
    });
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-b', executionId: second.executionId, nativeSessionId: secondNative,
    });
    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-a', executionId: first.executionId, outcome: { code: 0, success: true },
    });
    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-b', executionId: second.executionId, outcome: { code: 0, success: true },
    });

    assert.deepEqual(
      await service.handleRequest('scheduledSyncTasks', {
        projectId: firstProject.projectId,
        taskIds: [],
      }),
      { released: 1 },
    );
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(first.sessionId), false);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(second.sessionId), true);
    assert.ok(sessionsDb.getSessionById(first.sessionId));
  });
});

test('finish is scoped to one execution and an active external run blocks detached writes', async () => {
  await withDatabase(async (root) => {
    const { projectId, projectPath } = await createProject(root, 'project');
    const sessionsRoot = path.join(root, 'dsh-sessions');
    const nativeId = 'dsh-native-session';
    await writeDshTranscript(
      sessionsRoot,
      nativeId,
      projectPath,
      [dshHeader(nativeId, projectPath), dshUser(0, 'first question'), dshAssistant(1, 'first answer')],
    );
    const { service } = createService();

    const prepared = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'dsh-task',
      runId: 'run-dsh',
      provider: 'dsh',
      cwd: projectPath,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string; nativeSessionId: string | null };
    assert.equal(prepared.nativeSessionId, null);
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-dsh',
      executionId: prepared.executionId,
      nativeSessionId: nativeId,
    });
    assert.equal(
      sessionsDb.getSessionById(prepared.sessionId)?.jsonl_path,
      path.join(sessionsRoot, 'workspace', nativeId, 'session.v4.jsonl'),
    );

    const runtime = {
      hasRuntime: () => true,
      getState: () => undefined,
      getManagedState: () => undefined,
      hasBackgroundWork: () => false,
    } as unknown as ProviderRuntimeGateway;
    const detached = await runDetachedChatTurn(
      { sessionId: prepared.sessionId, userId: 1, content: 'foreground turn', interruptActiveRun: true },
      { runtime },
    );
    assert.equal(detached.started, false);
    assert.equal(chatRunRegistry.isProcessing(prepared.sessionId), true);

    const wrong = await service.handleRequest('scheduledFinishRun', {
      runId: 'run-dsh',
      executionId: 'not-this-execution',
      outcome: { code: 0, success: true },
    }) as { finished: boolean };
    assert.equal(wrong.finished, false);
    assert.equal(chatRunRegistry.isProcessing(prepared.sessionId), true);

    const finished = await service.handleRequest('scheduledFinishRun', {
      runId: 'run-dsh',
      executionId: prepared.executionId,
      outcome: { code: null, success: false, aborted: true, reason: 'plugin restart' },
    }) as { finished: boolean };
    assert.equal(finished.finished, true);
    assert.equal(chatRunRegistry.isProcessing(prepared.sessionId), false);
    const abortedSnapshot = chatRunRegistry.getSnapshot(prepared.sessionId);
    assert.equal(abortedSnapshot?.aborted, true);
    assert.equal(abortedSnapshot?.success, false);

    // A reported failure with code 0 must still surface as a failed terminal.
    const retry = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'dsh-task',
      runId: 'run-dsh-retry',
      provider: 'dsh',
      cwd: projectPath,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string; nativeSessionId: string | null };
    assert.equal(retry.sessionId, prepared.sessionId);
    assert.equal(retry.nativeSessionId, nativeId);
    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-dsh-retry',
      executionId: retry.executionId,
      outcome: { code: 0, success: false, reason: 'agent reported failure' },
    });
    const failedSnapshot = chatRunRegistry.getSnapshot(prepared.sessionId);
    assert.equal(failedSnapshot?.success, false);
    assert.equal(failedSnapshot?.exitCode, 1);
  });
});

test('sync removes bindings without deleting sessions, re-adding on attach, or unlocking resident tasks', async () => {
  await withDatabase(async (root) => {
    const { projectId, projectPath } = await createProject(root, 'project');
    const sessionsRoot = path.join(root, 'codex-sessions');
    const nativeId = 'thread-sync';
    await writeCodexTranscript(sessionsRoot, nativeId, projectPath);
    const { service } = createService();

    // An unrelated resident binding must keep its protection through scheduled sync.
    sessionsDb.createAppSession('resident-session', 'codex', projectPath, 'Resident');
    sessionsDb.assignProviderSessionId('resident-session', 'resident-native');
    residentBindingsDb.insert({
      taskId: 'resident-task',
      sessionId: 'resident-session',
      projectId,
      name: 'Resident',
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

    const prepared = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId, taskId: 'task-sync', runId: 'run-sync', provider: 'codex', cwd: projectPath, sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string };
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-sync', executionId: prepared.executionId, nativeSessionId: nativeId,
    });
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(prepared.sessionId), true);

    // A still-committed task keeps its binding even if it is disabled or cleared reuseSession.
    assert.deepEqual(
      await service.handleRequest('scheduledSyncTasks', { projectId, taskIds: ['task-sync'] }),
      { released: 0 },
    );
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(prepared.sessionId), true);

    const synced = await service.handleRequest('scheduledSyncTasks', {
      projectId,
      taskIds: [],
    }) as { released: number };
    assert.equal(synced.released, 1);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(prepared.sessionId), false);
    assert.ok(sessionsDb.getSessionById(prepared.sessionId));

    // The already-running run finishing later must not re-add the removed binding.
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-sync', executionId: prepared.executionId, nativeSessionId: nativeId,
    });
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(prepared.sessionId), false);
    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-sync', executionId: prepared.executionId, outcome: { code: 0, success: true },
    });

    assert.equal(sessionsDb.isSessionResidentProtected('resident-session'), true);
    assert.equal(sessionsDb.isProviderSessionResidentProtected('codex', 'resident-native'), true);
    assert.equal(sessionsDb.deleteSessionById('resident-session'), false);
    assert.equal(sessionsDb.deleteSessionById(prepared.sessionId), true);
  });
});

test('only reuseSession runs create bindings; non-reuse runs stay ordinary sessions', async () => {
  await withDatabase(async (root) => {
    const { projectId, projectPath } = await createProject(root, 'project');
    const sessionsRoot = path.join(root, 'codex-sessions');
    const nativeId = 'thread-reuse-toggle';
    const transcript = await writeCodexTranscript(sessionsRoot, nativeId, projectPath);
    await appendCodexTurn(transcript, 0, 'first prompt', 'first reply');
    const { service } = createService();

    const reused = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'toggle',
      runId: 'run-reuse',
      provider: 'codex',
      cwd: projectPath,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string };
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-reuse',
      executionId: reused.executionId,
      nativeSessionId: nativeId,
    });
    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-reuse',
      executionId: reused.executionId,
      outcome: { code: 0, success: true },
    });
    assert.equal(scheduledTaskSessionsDb.listByTask(projectId, 'toggle').length, 1);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(reused.sessionId), true);

    const ordinaryOne = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'toggle',
      runId: 'run-ordinary-1',
      provider: 'codex',
      cwd: projectPath,
      sessionsRoot,
      reuseSession: false,
    })) as { sessionId: string; executionId: string };
    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-ordinary-1',
      executionId: ordinaryOne.executionId,
      outcome: { code: 0, success: true },
    });
    const ordinaryTwo = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'toggle',
      runId: 'run-ordinary-2',
      provider: 'codex',
      cwd: projectPath,
      sessionsRoot,
      reuseSession: false,
    })) as { sessionId: string; executionId: string };
    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-ordinary-2',
      executionId: ordinaryTwo.executionId,
      outcome: { code: 0, success: true },
    });

    assert.notEqual(ordinaryOne.sessionId, reused.sessionId);
    assert.notEqual(ordinaryTwo.sessionId, ordinaryOne.sessionId);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(ordinaryOne.sessionId), false);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(ordinaryTwo.sessionId), false);
    // Non-reuse runs never accumulate permanent bindings, while the old true binding survives.
    assert.equal(scheduledTaskSessionsDb.listByTask(projectId, 'toggle').length, 1);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(reused.sessionId), true);
  });
});

test('a changed provider home is not reused and never reads the old transcript', async () => {
  await withDatabase(async (root) => {
    const { projectId, projectPath } = await createProject(root, 'project');
    const firstRoot = path.join(root, 'codex-home-first', 'sessions');
    const secondRoot = path.join(root, 'codex-home-second', 'sessions');
    const nativeId = 'same-native-id';
    const firstTranscript = await writeCodexTranscript(firstRoot, nativeId, projectPath);
    await appendCodexTurn(firstTranscript, 0, 'from root A', 'answer from root A');
    const { service } = createService();

    const first = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'home-change',
      runId: 'run-home-a',
      provider: 'codex',
      cwd: projectPath,
      sessionsRoot: firstRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string; nativeSessionId: string | null };
    assert.equal(first.nativeSessionId, null);
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-home-a',
      executionId: first.executionId,
      nativeSessionId: nativeId,
    });
    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-home-a',
      executionId: first.executionId,
      outcome: { code: 0, success: true },
    });

    // The new root does not exist yet at prepare time; that must be a normal new run, not a reuse.
    const second = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'home-change',
      runId: 'run-home-b',
      provider: 'codex',
      cwd: projectPath,
      sessionsRoot: secondRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string; nativeSessionId: string | null };
    assert.equal(second.nativeSessionId, null);
    assert.notEqual(second.sessionId, first.sessionId);
    // The changed home keeps the old binding protected but does not resume it; the new binding
    // is created only after this run attaches a verified transcript.
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(first.sessionId), true);
    assert.equal(scheduledTaskSessionsDb.listByTask(projectId, 'home-change').length, 1);

    const secondTranscript = await writeCodexTranscript(secondRoot, nativeId, projectPath);
    await appendCodexTurn(secondTranscript, 0, 'from root B', 'answer from root B');
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-home-b',
      executionId: second.executionId,
      nativeSessionId: nativeId,
    });
    assert.equal(sessionsDb.getSessionById(second.sessionId)?.jsonl_path, secondTranscript);
    assert.equal(chatRunRegistry.isProcessing(second.sessionId), true);
    assert.equal(scheduledTaskSessionsDb.listByTask(projectId, 'home-change').length, 2);

    const secondHistory = await sessionsService.fetchHistory(second.sessionId);
    assert.ok(secondHistory.messages.some((message) => message.content === 'answer from root B'));
    assert.ok(!secondHistory.messages.some((message) => message.content === 'answer from root A'));
    const firstHistory = await sessionsService.fetchHistory(first.sessionId);
    assert.ok(firstHistory.messages.some((message) => message.content === 'answer from root A'));

    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-home-b',
      executionId: second.executionId,
      outcome: { code: 0, success: true },
    });
  });
});

test('Codex native history sees rows appended while the scheduled run is still busy', async () => {
  await withDatabase(async (root) => {
    const { projectId, projectPath } = await createProject(root, 'project');
    const sessionsRoot = path.join(root, 'codex-live', 'sessions');
    const nativeId = 'thread-live-codex';
    const transcript = await writeCodexTranscript(sessionsRoot, nativeId, projectPath);
    await appendCodexTurn(transcript, 0, 'first prompt', 'first reply');
    const { service } = createService();

    const prepared = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'live-codex',
      runId: 'run-live-codex',
      provider: 'codex',
      cwd: projectPath,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string };
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-live-codex',
      executionId: prepared.executionId,
      nativeSessionId: nativeId,
    });
    assert.equal(chatRunRegistry.isProcessing(prepared.sessionId), true);

    const first = await sessionsService.fetchHistory(prepared.sessionId);
    assert.ok(first.messages.some((message) => message.content === 'first reply'));

    await appendCodexTurn(transcript, 1, 'second prompt', 'second reply');
    const second = await sessionsService.fetchHistory(prepared.sessionId);
    assert.ok(second.messages.some((message) => message.content === 'second prompt'));
    assert.ok(second.messages.some((message) => message.content === 'second reply'));
    assert.equal(chatRunRegistry.isProcessing(prepared.sessionId), true);

    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-live-codex',
      executionId: prepared.executionId,
      outcome: { code: 0, success: true },
    });
  });
});

test('DSH native history reads the custom-root session and follows live rows and a newer generation', async () => {
  await withDatabase(async (root) => {
    const { projectId, projectPath } = await createProject(root, 'project');
    const sessionsRoot = path.join(root, 'dsh-live', 'sessions');
    const nativeId = 'dsh-live-native';
    const transcript = await writeDshTranscript(sessionsRoot, nativeId, projectPath, [
      dshHeader(nativeId, projectPath),
      dshUser(0, 'first dsh question'),
      dshAssistant(1, 'first dsh answer'),
    ]);
    const { service } = createService();

    const prepared = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'live-dsh',
      runId: 'run-live-dsh',
      provider: 'dsh',
      cwd: projectPath,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string };
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-live-dsh',
      executionId: prepared.executionId,
      nativeSessionId: nativeId,
    });
    assert.equal(chatRunRegistry.isProcessing(prepared.sessionId), true);
    assert.equal(sessionsDb.getSessionById(prepared.sessionId)?.jsonl_path, transcript);

    const first = await sessionsService.fetchHistory(prepared.sessionId);
    assert.ok(first.messages.some((message) => message.content === 'first dsh answer'));

    await appendDshRows(transcript, [
      dshUser(2, 'live follow up'),
      {
        type: 'assistant/message',
        seq: 3,
        time: 4,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-3',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            content: [
              { type: 'text', text: 'live follow-up answer' },
              { type: 'tool-call', id: 'read-live', name: 'read', arguments: '{"path":"file.txt"}' },
            ],
          },
        },
      },
      {
        type: 'tool/call',
        seq: 4,
        time: 5,
        surfaceOp: 'append',
        data: { turn: 1, step: 1, callId: 'read-live', name: 'read', arguments: '{"path":"file.txt"}' },
      },
      {
        type: 'tool/result',
        seq: 5,
        time: 6,
        surfaceOp: 'append',
        sourceEventSeqs: [4],
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'result-live',
            role: 'tool',
            source: { kind: 'tool', callId: 'read-live' },
            toolCallId: 'read-live',
            content: [{ type: 'text', text: 'live file contents' }],
            isError: false,
          },
        },
      },
    ]);
    const second = await sessionsService.fetchHistory(prepared.sessionId);
    assert.ok(second.messages.some((message) => message.content === 'live follow up'));
    assert.ok(second.messages.some((message) => message.content === 'live follow-up answer'));
    const liveTool = second.messages.find((message) => message.kind === 'tool_use' && message.toolName === 'read');
    assert.ok(liveTool);
    const liveResult = second.messages.find(
      (message) => message.kind === 'tool_result' && message.toolId === liveTool.toolId,
    );
    assert.equal(liveResult?.content, 'live file contents');

    // Compaction writes a newer generation next to the indexed v4 file; history must follow it.
    await writeDshTranscript(sessionsRoot, nativeId, projectPath, [
      dshHeader(nativeId, projectPath),
      dshUser(0, 'after compaction'),
      dshAssistant(1, 'compacted answer'),
    ], 5);
    const compacted = await sessionsService.fetchHistory(prepared.sessionId);
    assert.ok(compacted.messages.some((message) => message.content === 'compacted answer'));
    assert.ok(!compacted.messages.some((message) => message.content === 'live follow-up answer'));
    assert.equal(chatRunRegistry.isProcessing(prepared.sessionId), true);

    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-live-dsh',
      executionId: prepared.executionId,
      outcome: { code: 0, success: true },
    });
  });
});

test('a prepared run that fails before native attach leaves no empty protected session', async () => {
  await withDatabase(async (root) => {
    const { projectId, projectPath } = await createProject(root, 'project');
    const sessionsRoot = path.join(root, 'codex-early-fail', 'sessions');
    const nativeId = 'thread-late-attach';
    await writeCodexTranscript(sessionsRoot, nativeId, projectPath);
    const { service } = createService();

    for (const runId of ['run-fail-1', 'run-fail-2']) {
      const failed = await service.handleRequest('scheduledPrepare', preparePayload({
        projectId,
        taskId: 'early-fail',
        runId,
        provider: 'codex',
        cwd: projectPath,
        sessionsRoot,
        reuseSession: true,
      })) as { sessionId: string; executionId: string };
      // A prepared placeholder is ordinary/unprotected until a native transcript is verified.
      assert.equal(scheduledTaskSessionsDb.isSessionProtected(failed.sessionId), false);
      await service.handleRequest('scheduledFinishRun', {
        runId,
        executionId: failed.executionId,
        outcome: { code: 1, success: false, aborted: true, reason: 'CLI failed before spawn' },
      });
      assert.equal(sessionsDb.getSessionById(failed.sessionId), null);
    }
    assert.equal(scheduledTaskSessionsDb.listByTask(projectId, 'early-fail').length, 0);

    const attached = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'early-fail',
      runId: 'run-attach',
      provider: 'codex',
      cwd: projectPath,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string };
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(attached.sessionId), false);
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-attach',
      executionId: attached.executionId,
      nativeSessionId: nativeId,
    });
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(attached.sessionId), true);
    assert.equal(scheduledTaskSessionsDb.listByTask(projectId, 'early-fail').length, 1);
    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-attach',
      executionId: attached.executionId,
      outcome: { code: 0, success: true },
    });
    assert.ok(sessionsDb.getSessionById(attached.sessionId));
  });
});

test('attaching after the task was deleted mid-run maps history without restoring protection', async () => {
  await withDatabase(async (root) => {
    const { projectId, projectPath } = await createProject(root, 'project');
    const sessionsRoot = path.join(root, 'codex-inflight-delete', 'sessions');
    const nativeId = 'thread-inflight-delete';
    const transcript = await writeCodexTranscript(sessionsRoot, nativeId, projectPath);
    await appendCodexTurn(transcript, 0, 'in-flight prompt', 'in-flight answer');
    const { service } = createService();

    const prepared = await service.handleRequest('scheduledPrepare', preparePayload({
      projectId,
      taskId: 'deleted-mid-run',
      runId: 'run-inflight-delete',
      provider: 'codex',
      cwd: projectPath,
      sessionsRoot,
      reuseSession: true,
    })) as { sessionId: string; executionId: string };
    // The task was removed from the committed set while this CLI run was still starting.
    assert.deepEqual(
      await service.handleRequest('scheduledSyncTasks', { projectId, taskIds: [] }),
      { released: 0 },
    );
    await service.handleRequest('scheduledAttachNative', {
      runId: 'run-inflight-delete',
      executionId: prepared.executionId,
      nativeSessionId: nativeId,
    });
    assert.equal(sessionsDb.getSessionById(prepared.sessionId)?.jsonl_path, transcript);
    assert.equal(scheduledTaskSessionsDb.isSessionProtected(prepared.sessionId), false);
    assert.equal(scheduledTaskSessionsDb.listByTask(projectId, 'deleted-mid-run').length, 0);
    const history = await sessionsService.fetchHistory(prepared.sessionId);
    assert.ok(history.messages.some((message) => message.content === 'in-flight answer'));

    await service.handleRequest('scheduledFinishRun', {
      runId: 'run-inflight-delete',
      executionId: prepared.executionId,
      outcome: { code: 1, success: false, aborted: true },
    });
    // The session is kept because it attached to a real transcript, and it stays deletable.
    assert.ok(sessionsDb.getSessionById(prepared.sessionId));
    assert.equal(sessionsDb.deleteSessionById(prepared.sessionId), true);
  });
});
