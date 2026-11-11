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
  projectsDb,
  userDb,
} from '@/modules/database/index.js';
import { createTodoService } from '@/modules/todos/todos.service.js';
import { createTodosRouter } from '@/modules/todos/todos.routes.js';
import { TODO_UPLOAD_TEMP_DIR } from '@/modules/todos/todos.uploads.js';

type Server = { url: string; close: () => Promise<void> };

async function withRouteServer(runTest: (server: Server, userId: number, projectId: string, root: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'todos-routes-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  const userId = Number(userDb.createUser('todos-routes', 'hash').id);
  const project = projectsDb.createProjectPath(path.join(root, 'project')).project;
  assert.ok(project);
  const service = createTodoService({
    baseDir: path.join(root, 'todo-assets'),
    chatAssetsDir: path.join(root, 'chat-assets'),
    broadcast: () => undefined,
    copyIntoChatAssets: async () => [],
  });
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number } }).user = { id: userId };
    next();
  });
  app.use('/api/projects', createTodosRouter(service));
  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const server = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
  };
  try {
    await runTest(server, userId, project.project_id, root);
  } finally {
    await server.close();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('multipart Chinese filenames save and download with a valid RFC5987 header', async () => {
  await withRouteServer(async (server, _userId, projectId) => {
    const form = new FormData();
    form.append('content', '中文附件');
    form.append('files', new Blob(['需求正文'], { type: 'text/plain' }), '需求说明.md');
    form.append('files', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), '图片预览.png');
    const created = await fetch(`${server.url}/api/projects/${projectId}/todos`, { method: 'POST', body: form });
    assert.equal(created.status, 200);
    const { todo } = await created.json() as { todo: { id: string; attachments: Array<{ id: string; name: string }> } };
    assert.deepEqual(todo.attachments.map((item) => item.name), ['需求说明.md', '图片预览.png']);

    const textAttachment = todo.attachments[0];
    const download = await fetch(
      `${server.url}/api/projects/${projectId}/todos/${todo.id}/attachments/${textAttachment.id}`,
    );
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    const disposition = download.headers.get('content-disposition') ?? '';
    assert.match(disposition, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
    assert.match(disposition, new RegExp(encodeURIComponent(textAttachment.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await download.text(), '需求正文');

    const image = await fetch(
      `${server.url}/api/projects/${projectId}/todos/${todo.id}/attachments/${todo.attachments[1].id}`,
    );
    assert.equal(image.status, 200);
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
  });
});

test('a rejected parse removes the files it already uploaded', async () => {
  await withRouteServer(async (server, _userId, projectId) => {
    const before = new Set(await fs.readdir(TODO_UPLOAD_TEMP_DIR).catch(() => []));
    const form = new FormData();
    form.append('content', 'bad parse');
    form.append('storedAttachments', '{not-json');
    form.append('files', new Blob(['cleanup me'], { type: 'text/plain' }), 'cleanup.txt');
    const response = await fetch(`${server.url}/api/projects/${projectId}/todos`, { method: 'POST', body: form });
    assert.equal(response.status, 400);
    const after = (await fs.readdir(TODO_UPLOAD_TEMP_DIR)).filter((name) => !before.has(name));
    assert.deepEqual(after, []);
  });
});

test('an update parse failure removes its uploads and leaves the todo unchanged', async () => {
  await withRouteServer(async (server, _userId, projectId) => {
    const created = await fetch(`${server.url}/api/projects/${projectId}/todos`, {
      method: 'POST',
      body: (() => {
        const form = new FormData();
        form.append('content', 'before');
        return form;
      })(),
    });
    const { todo } = await created.json() as { todo: { id: string } };
    const before = new Set(await fs.readdir(TODO_UPLOAD_TEMP_DIR).catch(() => []));
    const form = new FormData();
    form.append('content', 'after');
    form.append('keepAttachmentIds', '{bad-json');
    form.append('files', new Blob(['cleanup me'], { type: 'text/plain' }), 'cleanup.txt');
    const response = await fetch(`${server.url}/api/projects/${projectId}/todos/${todo.id}`, {
      method: 'PUT',
      body: form,
    });
    assert.equal(response.status, 400);
    const after = (await fs.readdir(TODO_UPLOAD_TEMP_DIR)).filter((name) => !before.has(name));
    assert.deepEqual(after, []);
    const listed = await (await fetch(`${server.url}/api/projects/${projectId}/todos`)).json() as {
      todos: Array<{ content: string }>;
    };
    assert.equal(listed.todos[0].content, 'before');
  });
});
