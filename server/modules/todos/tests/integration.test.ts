import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  closeConnection,
  initializeDatabase,
  projectTodosDb,
  projectsDb,
  sessionDraftsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import { createTodosRouter } from '@/modules/todos/todos.routes.js';
import { createTodoService } from '@/modules/todos/todos.service.js';
import type { AnyRecord, ChatAttachmentDescriptor, ProviderRuntimeGateway, TodoDraftMeta } from '@/shared/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type Stack = {
  url: string;
  userId: number;
  projectId: string;
  sessionId: string;
  root: string;
  metaScope: string;
  service: ReturnType<typeof createTodoService>;
  advance(ms: number): void;
  runtime: ProviderRuntimeGateway;
  runs: Array<{ content: string; options: AnyRecord }>;
};

/**
 * Copies prepared todo files into a temp chat-assets folder.
 *
 * The real copier writes to the shared `~/.cloudcli/assets`; a test cannot
 * point that at a temp directory, so this seam (which the service already
 * exposes for tests) performs the same physical copy inside the sandbox.
 */
async function copyIntoChatAssets(
  root: string,
  files: Array<{ sourcePath: string; name: string; mimeType?: string }>,
): Promise<ChatAttachmentDescriptor[]> {
  const assetsDir = path.join(root, 'chat-assets');
  await fs.mkdir(assetsDir, { recursive: true });
  const copied: ChatAttachmentDescriptor[] = [];
  for (const file of files) {
    const destination = path.join(assetsDir, `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.name}`);
    await fs.copyFile(file.sourcePath, destination);
    const stats = await fs.stat(destination);
    copied.push({ path: destination, name: file.name, mimeType: file.mimeType, size: stats.size });
  }
  return copied;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withStack(runTest: (stack: Stack) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'todos-integration-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();

  let now = new Date('2026-01-01T00:00:00.000Z');
  const userId = Number(userDb.createUser('todos-integration', 'hash').id);
  const projectId = projectsDb.createProjectPath(root).project!.project_id;
  const sessionId = 'todos-integration-session';
  sessionsDb.createAppSession(sessionId, 'claude', root);

  const runs: Stack['runs'] = [];
  // Mirrors the adapters: acceptance is a server-owned signal, never inferred
  // from the turn's text or its exit code.
  const runtime = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    getState: () => undefined,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    abort: async () => true,
    run: (_provider: string, content: string, options: AnyRecord) => {
      runs.push({ content, options });
      return new Promise<void>((resolve) => { options.__finish = resolve; });
    },
  } as unknown as ProviderRuntimeGateway;

  const service = createTodoService({
    baseDir: path.join(root, 'todo-assets'),
    chatAssetsDir: path.join(root, 'chat-assets'),
    clock: () => now,
    broadcast: () => undefined,
    copyIntoChatAssets: (files) => copyIntoChatAssets(root, files),
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number } }).user = { id: userId };
    next();
  });
  app.use('/api/projects', createTodosRouter(service));
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message ?? 'error' });
  });

  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');

  try {
    await runTest({
      url: `http://127.0.0.1:${address.port}`,
      userId,
      projectId,
      sessionId,
      root,
      metaScope: `project:${projectId}`,
      service,
      advance(ms) { now = new Date(now.getTime() + ms); },
      runtime,
      runs,
    });
  } finally {
    chatRunRegistry.clearAll();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

async function createTodoViaHttp(
  stack: Stack,
  content: string,
  files: Array<{ body: Uint8Array; name: string; type: string }> = [],
): Promise<{ id: string; content: string; status: string; attachments: Array<{ id: string; name: string }> }> {
  const form = new FormData();
  form.append('content', content);
  for (const file of files) form.append('files', new Blob([file.body], { type: file.type }), file.name);
  const response = await fetch(`${stack.url}/api/projects/${stack.projectId}/todos`, { method: 'POST', body: form });
  assert.equal(response.status, 200);
  return (await response.json() as { todo: { id: string; content: string; status: string; attachments: Array<{ id: string; name: string }> } }).todo;
}

async function prepareDraft(stack: Stack, todoIds: string[]): Promise<TodoDraftMeta & { text: string }> {
  const response = await fetch(`${stack.url}/api/projects/${stack.projectId}/todos/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ todoIds }),
  });
  assert.equal(response.status, 200);
  return (await response.json() as { draft: TodoDraftMeta & { text: string } }).draft;
}

test('prepared todo text and copied attachments feed a draft whose meta and queued source survive edits', async () => {
  await withStack(async (stack) => {
    const created = await createTodoViaHttp(stack, '发布前检查', [
      { body: new TextEncoder().encode('# 检查项'), name: '检查项.md', type: 'text/markdown' },
      { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), name: '预览.png', type: 'image/png' },
    ]);
    assert.equal(created.status, 'pending');
    assert.deepEqual(created.attachments.map((attachment) => attachment.name), ['检查项.md', '预览.png']);

    const draft = await prepareDraft(stack, [created.id]);
    assert.equal(draft.text, '发布前检查');
    assert.deepEqual(draft.todoIds, [created.id]);
    assert.equal(draft.attachments.length, 2);
    // Preparing copies the bytes out of the private todo folder; the todo itself stays pending.
    const copiedText = await fs.readFile(draft.attachments[0].path!, 'utf8');
    assert.equal(copiedText, '# 检查项');
    assert.equal(projectTodosDb.get(stack.userId, stack.projectId, created.id)?.status, 'pending');

    const meta: TodoDraftMeta = { todoIds: draft.todoIds, attachments: draft.attachments };
    sessionDraftsDb.saveDraft(stack.userId, stack.metaScope, { text: draft.text, meta });
    // Debounced composer edits and queue appends must not drop the todo source.
    sessionDraftsDb.saveDraftText(stack.userId, stack.metaScope, `${draft.text}\n追加说明`);
    sessionDraftsDb.appendQueuedMessage(stack.userId, stack.metaScope, {
      content: '排队后发送',
      attachments: [],
      options: { todoIds: draft.todoIds },
      todoIds: draft.todoIds,
    });

    const stored = sessionDraftsDb.getDrafts(stack.userId).find((item) => item.scope === stack.metaScope);
    assert.ok(stored);
    assert.deepEqual(stored.meta, meta);
    assert.equal(stored.text, '发布前检查\n追加说明');
    const queued = stored.queuedMessages[0] as { todoIds?: string[]; options?: { todoIds?: string[] } };
    assert.deepEqual(queued.todoIds, [created.id]);
    assert.deepEqual(queued.options?.todoIds, [created.id]);
  });
});

test('only a real provider acceptance submits, and restore/delete/retention keep the chat copy', async () => {
  await withStack(async (stack) => {
    const created = await createTodoViaHttp(stack, '修复登录超时', [
      { body: new TextEncoder().encode('方案正文'), name: '方案.md', type: 'text/markdown' },
    ]);
    const draft = await prepareDraft(stack, [created.id]);
    const chatCopy = draft.attachments[0].path!;
    assert.equal(await fs.readFile(chatCopy, 'utf8'), '方案正文');

    let forgedCalls = 0;
    const turn = runDetachedChatTurn({
      sessionId: stack.sessionId,
      userId: stack.userId,
      content: draft.text,
      options: {
        todoIds: draft.todoIds,
        // A client-supplied callback must never be installed.
        onInputAccepted: () => { forgedCalls += 1; },
      },
    }, { runtime: stack.runtime });
    await waitFor(() => stack.runs.length === 1);

    const options = stack.runs[0].options;
    const accept = options.onInputAccepted as (() => void) | undefined;
    assert.equal(options.todoIds, undefined);
    assert.equal(forgedCalls, 0);
    assert.equal(typeof accept, 'function');
    // The provider has not received the turn yet, so the source is still pending.
    assert.equal(projectTodosDb.get(stack.userId, stack.projectId, created.id)?.status, 'pending');

    accept!();
    // Repeating the signal must not re-mark or re-broadcast.
    accept!();
    const submitted = projectTodosDb.get(stack.userId, stack.projectId, created.id);
    assert.equal(submitted?.status, 'submitted');
    assert.equal(submitted?.submittedSessionId, stack.sessionId);

    (options.__finish as () => void)();
    const result = await turn;
    assert.equal(result.started, true);

    const restoredResponse = await fetch(
      `${stack.url}/api/projects/${stack.projectId}/todos/${created.id}/restore`,
      { method: 'POST' },
    );
    assert.equal(restoredResponse.status, 200);
    assert.equal((await restoredResponse.json() as { todo: { status: string } }).todo.status, 'pending');

    const deletedResponse = await fetch(
      `${stack.url}/api/projects/${stack.projectId}/todos/${created.id}`,
      { method: 'DELETE' },
    );
    assert.equal(deletedResponse.status, 200);
    const beforeExpiry = await fetch(`${stack.url}/api/projects/${stack.projectId}/todos`);
    const listed = (await beforeExpiry.json() as { todos: Array<{ id: string; status: string }> }).todos;
    assert.equal(listed.find((todo) => todo.id === created.id)?.status, 'deleted');

    stack.advance(8 * DAY_MS);
    await stack.service.runRetention();

    const afterRetention = await fetch(`${stack.url}/api/projects/${stack.projectId}/todos`);
    assert.deepEqual((await afterRetention.json() as { todos: unknown[] }).todos, []);
    assert.equal(projectTodosDb.get(stack.userId, stack.projectId, created.id), null);
    const privateDir = path.join(stack.root, 'todo-assets', String(stack.userId), stack.projectId, created.id);
    await assert.rejects(fs.access(privateDir));
    // Seven-day cleanup may only remove the private copy, never the chat asset.
    assert.equal(await fs.readFile(chatCopy, 'utf8'), '方案正文');
  });
});

test('a turn that ends without acceptance keeps its todo pending and its files intact', async () => {
  await withStack(async (stack) => {
    const created = await createTodoViaHttp(stack, '未接收就结束');
    const draft = await prepareDraft(stack, [created.id]);

    const turn = runDetachedChatTurn({
      sessionId: stack.sessionId,
      userId: stack.userId,
      content: draft.text,
      options: { todoIds: draft.todoIds },
    }, { runtime: stack.runtime });
    await waitFor(() => stack.runs.length === 1);
    // The runtime resolves without ever calling onInputAccepted.
    (stack.runs[0].options.__finish as () => void)();
    await turn;

    assert.equal(projectTodosDb.get(stack.userId, stack.projectId, created.id)?.status, 'pending');
    const download = await fetch(
      `${stack.url}/api/projects/${stack.projectId}/todos/${created.id}/attachments/x`,
    );
    // Unknown attachment ids stay missing; the pending todo itself is still listed.
    assert.equal(download.status, 404);
    const list = await fetch(`${stack.url}/api/projects/${stack.projectId}/todos`);
    assert.equal((await list.json() as { todos: Array<{ status: string }> }).todos[0].status, 'pending');
  });
});
