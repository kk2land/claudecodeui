import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectTodosDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord, ProviderRuntimeGateway } from '@/shared/index.js';

type Harness = {
  sessionId: string;
  userId: number;
  projectId: string;
  socket: EventEmitter & { frames: AnyRecord[] };
  runs: AnyRecord[];
  runtime: ProviderRuntimeGateway;
  /** Lets the fake provider run settle, so `finally` cleanup can be observed. */
  finishRun(): void;
  send(data: AnyRecord): void;
};

async function harness(
  runTest: (h: Harness) => Promise<void>,
  makeRun?: (runs: AnyRecord[]) => ProviderRuntimeGateway['run'],
): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat-todo-sources-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();

  const project = projectsDb.createProjectPath(root);
  assert.ok(project.project);
  const projectId = project.project.project_id;
  const sessionId = 'todo-source-session';
  const userId = Number(userDb.createUser('todo-sources', 'hash').id);
  sessionsDb.createAppSession(sessionId, 'claude', root);

  const runs: AnyRecord[] = [];
  // The fake run stays open like a live provider turn until the test settles it.
  const finishRun = () => { for (const run of runs) run.release?.(); };
  // The adapter decides acceptance; this fake never calls it unless the test does.
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    getState: () => undefined,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    abort: async () => true,
    run: makeRun
      ? makeRun(runs)
      : async (_provider: string, content: string, options: AnyRecord) => {
        runs.push({ content, options, accept: options.onInputAccepted, release: null as (() => void) | null });
        await new Promise<void>((resolve) => { runs.at(-1)!.release = resolve; });
      },
  } as never;

  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    frames: [] as AnyRecord[],
    send(text: string) { this.frames.push(JSON.parse(text) as AnyRecord); },
  });
  handleChatConnection(socket as never, { user: { id: userId } } as never, { runtime });

  try {
    await runTest({ sessionId, userId, projectId, socket, runs, runtime, finishRun, send(data) { socket.emit('message', JSON.stringify({ sessionId, ...data })); } });
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

function createTodo(userId: number, projectId: string, id: string): void {
  projectTodosDb.create({ id, userId, projectId, content: 'todo', attachments: [], createdAt: new Date().toISOString() });
}

test('a todo-sourced send keeps ids server-side and submits them only on provider acceptance', async () => {
  await harness(async (h) => {
    createTodo(h.userId, h.projectId, 'todo-a');
    let forgedCalls = 0;
    h.send({
      type: 'chat.send',
      content: 'todo text',
      options: {
        todoIds: ['todo-a'],
        // A client-supplied callback must never be installed.
        onInputAccepted: () => { forgedCalls += 1; },
      },
    });
    await settle();

    assert.equal(h.runs.length, 1);
    const options = h.runs[0].options as AnyRecord;
    assert.equal(options.todoIds, undefined);
    assert.equal(forgedCalls, 0);
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-a')?.status, 'pending');

    const accept = h.runs[0].accept as () => void;
    accept();
    // Once semantics: a repeated provider signal cannot re-mark or double-broadcast.
    accept();
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-a')?.status, 'submitted');
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-a')?.submittedSessionId, h.sessionId);

    h.finishRun();
    await settle();
    // Dropped after the run so an automatic next turn never inherits it.
    assert.equal(options.onInputAccepted, undefined);
  });
});

test('a run that ends without acceptance keeps its todo sources pending', async () => {
  await harness(async (h) => {
    createTodo(h.userId, h.projectId, 'todo-b');
    h.send({ type: 'chat.send', content: 'todo text', options: { todoIds: ['todo-b'] } });
    await settle();

    assert.equal(h.runs.length, 1);
    assert.equal(typeof h.runs[0].accept, 'function');
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-b')?.status, 'pending');
    h.finishRun();
  });
});

test('an ordinary send gets no acceptance callback and behaves as before', async () => {
  await harness(async (h) => {
    h.send({ type: 'chat.send', content: 'plain text', options: {} });
    await settle();

    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].accept, undefined);
  });
});

test('malformed todoIds are refused before any provider run', async () => {
  await harness(async (h) => {
    h.send({ type: 'chat.send', content: 'todo text', options: { todoIds: [''] } });
    await settle();

    assert.equal(h.runs.length, 0);
    assert.equal(h.socket.frames.at(-1)?.code, 'INVALID_TODO_IDS');
  });
});

test('a FIFO queued turn carries its todo sources into the detached dispatch and marks them', async () => {
  await harness(async (h) => {
    createTodo(h.userId, h.projectId, 'todo-c');
    const dispatching = runDetachedChatTurn(
      {
        sessionId: h.sessionId,
        userId: h.userId,
        content: 'queued todo text',
        options: { todoIds: ['todo-c'] },
      },
      { runtime: h.runtime },
    );
    await settle();
    assert.equal(h.runs.length, 1);
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-c')?.status, 'pending');
    (h.runs[0].accept as () => void)();
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-c')?.status, 'submitted');
    h.finishRun();
    const result = await dispatching;
    assert.equal(result.started, true);
  });
});

test('output after the app-facing complete cannot consume the old todo sources', async () => {
  let releaseRun: (() => void) | null = null;
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  await harness(async (h) => {
    createTodo(h.userId, h.projectId, 'todo-late');
    h.send({ type: 'chat.send', content: 'todo text', options: { todoIds: ['todo-late'] } });
    await settle();
    const run = h.runs[0];
    // The runtime keeps its promise alive after the app-facing terminal, as
    // Claude does while background work holds the query open.
    (run.writer as { send(message: AnyRecord): void }).send({
      kind: 'complete', provider: 'claude', sessionId: h.sessionId, exitCode: 0,
    });
    await settle();

    (run.accept as () => void)();
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-late')?.status, 'pending');

    releaseRun!();
    await settle();
    (run.accept as () => void)();
    assert.equal(projectTodosDb.get(h.userId, h.projectId, 'todo-late')?.status, 'pending');
  }, (runs) => async (_provider: string, content: string, options: AnyRecord, writer) => {
    runs.push({ content, options, accept: options.onInputAccepted, writer });
    await runGate;
  });
});

test('malformed todoIds never reserve the session, so the next valid send runs', async () => {
  const malformed = [[''], ['ok', 3], 'todo-1'];
  await harness(async (h) => {
    for (const bad of malformed) {
      h.send({ type: 'chat.send', content: 'bad todo', options: { todoIds: bad } });
      await settle();

      assert.equal(h.runs.length, 0, 'the provider must not run for malformed todo ids');
      assert.equal(chatRunRegistry.isProcessing(h.sessionId), false, 'a refused frame must not leave a running slot');
      assert.equal(h.socket.frames.at(-1)?.code, 'INVALID_TODO_IDS');

      // The same session is still usable for an ordinary todo-sourced send.
      h.send({ type: 'chat.send', content: 'valid todo', options: { todoIds: ['todo-valid'] } });
      await settle();
      assert.equal(h.runs.length, 1);
      assert.equal(chatRunRegistry.isProcessing(h.sessionId), true);
      h.finishRun();
      await settle();
      assert.equal(chatRunRegistry.isProcessing(h.sessionId), false);
      h.runs.length = 0;
    }
  });
});

test('a detached dispatch also refuses malformed todoIds without reserving the session', async () => {
  await harness(async (h) => {
    const result = await runDetachedChatTurn(
      { sessionId: h.sessionId, userId: h.userId, content: 'bad todo', options: { todoIds: [''] } },
      { runtime: h.runtime },
    );
    assert.equal(result.started, false);
    assert.equal(h.runs.length, 0);
    assert.equal(chatRunRegistry.isProcessing(h.sessionId), false);

    const valid = runDetachedChatTurn(
      { sessionId: h.sessionId, userId: h.userId, content: 'valid todo', options: { todoIds: ['todo-valid'] } },
      { runtime: h.runtime },
    );
    await settle();
    assert.equal(h.runs.length, 1);
    assert.equal(chatRunRegistry.isProcessing(h.sessionId), true);
    h.finishRun();
    assert.equal((await valid).started, true);
    assert.equal(chatRunRegistry.isProcessing(h.sessionId), false);
  });
});
