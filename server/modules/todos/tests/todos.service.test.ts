import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
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
import type { TodoUploadFile } from '@/shared/index.js';
import { createTodoService } from '@/modules/todos/todos.service.js';

type Env = {
  service: ReturnType<typeof createTodoService>;
  userId: number;
  otherUserId: number;
  projectId: string;
  baseDir: string;
  assetsDir: string;
  root: string;
  clock: { now: Date };
  events: string[];
};

async function withEnv(runTest: (env: Env) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'todos-service-'));
  const baseDir = path.join(root, 'todo-assets');
  const assetsDir = path.join(root, 'chat-assets');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    const userId = Number(userDb.createUser('todos-user', 'hash').id);
    const otherUserId = Number(userDb.createUser('todos-other', 'hash').id);
    const project = projectsDb.createProjectPath(path.join(root, 'project')).project;
    assert.ok(project);
    const clock = { now: new Date('2026-01-01T00:00:00.000Z') };
    const events: string[] = [];
    const service = createTodoService({
      baseDir,
      chatAssetsDir: assetsDir,
      clock: () => clock.now,
      broadcast: (changedProjectId) => events.push(changedProjectId),
      copyIntoChatAssets: async (files) => {
        await fs.mkdir(assetsDir, { recursive: true });
        return Promise.all(files.map(async (file, index) => {
          const destination = path.join(assetsDir, `copy-${index}-${path.basename(file.name)}`);
          await fs.copyFile(file.sourcePath, destination);
          return {
            path: destination,
            name: file.name,
            mimeType: file.mimeType,
            size: (await fs.stat(destination)).size,
          };
        }));
      },
    });
    await runTest({ service, userId, otherUserId, projectId: project.project_id, baseDir, assetsDir, root, clock, events });
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function upload(root: string, name: string, content: string): Promise<TodoUploadFile> {
  const tempPath = path.join(root, `upload-${name}`);
  await fs.writeFile(tempPath, content);
  return { tempPath, name, mimeType: 'text/plain', size: Buffer.byteLength(content) };
}

test('creates, isolates, edits only pending todos, and restores with submission cleared', async () => {
  await withEnv(async ({ service, userId, otherUserId, projectId, root, clock }) => {
    const todo = await service.create(userId, projectId, {
      content: 'write tests',
      files: [await upload(root, 'a.txt', 'aaa')],
      storedAttachments: [],
    });
    assert.equal(todo.content, 'write tests');
    assert.equal(todo.attachments.length, 1);
    assert.equal(service.list(userId, projectId).length, 1);
    assert.equal(service.list(otherUserId, projectId).length, 0);

    clock.now = new Date('2026-01-02T00:00:00.000Z');
    const edited = await service.update(userId, projectId, todo.id, {
      content: 'write better tests',
      files: [],
      keepAttachmentIds: [todo.attachments[0].id],
      storedAttachments: [],
    });
    assert.equal(edited.content, 'write better tests');
    assert.equal(edited.updatedAt, '2026-01-02T00:00:00.000Z');

    const sessionId = 'todo-session';
    sessionsDb.createAppSession(sessionId, 'codex', path.join(root, 'project'));
    service.markSubmitted({ userId, sessionId, todoIds: [todo.id] });
    let stored = projectTodosDb.get(userId, projectId, todo.id);
    assert.equal(stored?.status, 'submitted');
    assert.equal(stored?.submittedSessionId, sessionId);
    assert.equal(stored?.stateChangedAt, '2026-01-02T00:00:00.000Z');

    // A duplicate callback must not reset the retention clock.
    clock.now = new Date('2026-01-04T00:00:00.000Z');
    service.markSubmitted({ userId, sessionId, todoIds: [todo.id] });
    stored = projectTodosDb.get(userId, projectId, todo.id);
    assert.equal(stored?.stateChangedAt, '2026-01-02T00:00:00.000Z');
    clock.now = new Date('2026-01-02T00:00:00.000Z');

    // Editing a submitted todo is refused.
    await assert.rejects(() => service.update(userId, projectId, todo.id, {
      content: 'nope', files: [], storedAttachments: [],
    }), /Only pending todos/);

    // Restore clears the submitted session and keeps the same attachment bytes.
    clock.now = new Date('2026-01-03T00:00:00.000Z');
    const restored = service.restore(userId, projectId, todo.id);
    assert.equal(restored.status, 'pending');
    assert.equal(restored.submittedSessionId, null);
    const files = await fs.readdir(path.join(
      root, 'todo-assets', String(userId), projectId, todo.id,
    ));
    assert.equal(files.length, 1);
    assert.equal((await fs.readFile(path.join(
      root, 'todo-assets', String(userId), projectId, todo.id, files[0],
    ), 'utf8')), 'aaa');
  });
});

test('prepare copies attachments to direct chat assets and leaves the todo pending', async () => {
  await withEnv(async ({ service, userId, projectId, otherUserId, root, assetsDir }) => {
    const todo = await service.create(userId, projectId, {
      content: 'send me',
      files: [await upload(root, 'b.txt', 'hello')],
      storedAttachments: [],
    });
    const draft = await service.prepare(userId, projectId, [todo.id]);
    assert.equal(draft.text, 'send me');
    assert.deepEqual(draft.todoIds, [todo.id]);
    assert.equal(draft.attachments.length, 1);
    assert.equal(path.dirname(String(draft.attachments[0].path)), assetsDir);
    assert.equal(await fs.readFile(String(draft.attachments[0].path), 'utf8'), 'hello');
    assert.equal(projectTodosDb.get(userId, projectId, todo.id)?.status, 'pending');

    await assert.rejects(() => service.prepare(otherUserId, projectId, [todo.id]), /pending todos/);
  });
});

test('stored chat descriptors are copied, never moved, and remain readable after todo deletion', async () => {
  await withEnv(async ({ service, userId, projectId, assetsDir }) => {
    await fs.mkdir(assetsDir, { recursive: true });
    const source = path.join(assetsDir, 'chat-source.txt');
    await fs.writeFile(source, 'chat copy');
    const todo = await service.create(userId, projectId, {
      content: '',
      files: [],
      storedAttachments: [{ path: source, name: 'chat-source.txt', mimeType: 'text/plain', size: 8 }],
    });
    assert.equal(todo.attachments.length, 1);
    assert.equal(await fs.readFile(source, 'utf8'), 'chat copy');
    await service.remove(userId, projectId, todo.id);
    assert.equal(await fs.readFile(source, 'utf8'), 'chat copy');
  });
});

test('prepare enforces the ten-attachment total across a batch before copying', async () => {
  await withEnv(async ({ service, userId, projectId, root }) => {
    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const todo = await service.create(userId, projectId, {
        content: `todo ${index}`,
        files: [await upload(root, `batch-${index}.txt`, String(index))],
        storedAttachments: [],
      });
      ids.push(todo.id);
    }
    await assert.rejects(() => service.prepare(userId, projectId, ids), /At most 10 attachments/);
    assert.equal(projectTodosDb.get(userId, projectId, ids[0])?.status, 'pending');
  });
});

test('private attachment lookup rejects foreign ids and traversal', async () => {
  await withEnv(async ({ service, userId, projectId, root }) => {
    const todo = await service.create(userId, projectId, {
      content: '', files: [await upload(root, 'c.txt', 'secret')], storedAttachments: [],
    });
    const attachment = todo.attachments[0];
    assert.equal(service.openAttachment(userId, projectId, todo.id, attachment.id).status, 'found');
    assert.equal(service.openAttachment(userId, projectId, todo.id, '../c.txt').status, 'missing');
    assert.equal(service.openAttachment(userId, projectId, 'other-todo', attachment.id).status, 'missing');
  });
});

test('retention removes private files before rows and keeps chat copies', async () => {
  await withEnv(async ({ service, userId, projectId, root, clock }) => {
    const todo = await service.create(userId, projectId, {
      content: 'retain', files: [await upload(root, 'd.txt', 'retained')], storedAttachments: [],
    });
    const draft = await service.prepare(userId, projectId, [todo.id]);
    const sessionId = 'retention-session';
    sessionsDb.createAppSession(sessionId, 'codex', path.join(root, 'project'));
    service.markSubmitted({ userId, sessionId, todoIds: [todo.id] });

    // Exactly seven days is already expired for prepare and restore.
    clock.now = new Date('2026-01-08T00:00:00.000Z');
    assert.equal(service.list(userId, projectId).length, 0);
    await assert.rejects(() => service.prepare(userId, projectId, [todo.id]), /pending todos/);
    assert.throws(() => service.restore(userId, projectId, todo.id), /not found|no longer be restored/);

    await service.runRetention();
    assert.equal(projectTodosDb.get(userId, projectId, todo.id), null);
    await assert.rejects(() => fs.access(path.join(root, 'todo-assets', String(userId), projectId, todo.id)));
    assert.equal(await fs.readFile(String(draft.attachments[0].path), 'utf8'), 'retained');
  });
});

test('retention keeps the row when its folder cannot be removed', { skip: process.getuid?.() === 0 }, async () => {
  await withEnv(async ({ service, userId, projectId, root, clock, baseDir }) => {
    const todo = await service.create(userId, projectId, {
      content: 'locked', files: [await upload(root, 'e.txt', 'locked')], storedAttachments: [],
    });
    const sessionId = 'locked-session';
    sessionsDb.createAppSession(sessionId, 'codex', path.join(root, 'project'));
    service.markSubmitted({ userId, sessionId, todoIds: [todo.id] });
    const todoDir = path.join(baseDir, String(userId), projectId, todo.id);
    await fs.chmod(todoDir, 0o555);
    clock.now = new Date('2026-01-09T00:00:00.000Z');
    try {
      await service.runRetention();
      assert.ok(projectTodosDb.get(userId, projectId, todo.id));
    } finally {
      await fs.chmod(todoDir, 0o755);
    }
    await service.runRetention();
    assert.equal(projectTodosDb.get(userId, projectId, todo.id), null);
  });
});

test('deleteProjectTodos removes every user row and folder, and markSubmitted ignores deleted or missing sessions', async () => {
  await withEnv(async ({ service, userId, otherUserId, projectId, root }) => {
    const mine = await service.create(userId, projectId, {
      content: 'mine', files: [await upload(root, 'f.txt', 'f')], storedAttachments: [],
    });
    const theirs = await service.create(otherUserId, projectId, {
      content: 'theirs', files: [], storedAttachments: [],
    });
    const deleted = await service.create(userId, projectId, { content: 'deleted', files: [], storedAttachments: [] });
    await service.remove(userId, projectId, deleted.id);
    service.markSubmitted({ userId, sessionId: 'missing-session', todoIds: [deleted.id] });
    assert.equal(projectTodosDb.get(userId, projectId, deleted.id)?.status, 'deleted');

    await service.deleteProjectTodos(projectId);
    assert.equal(projectTodosDb.get(userId, projectId, mine.id), null);
    assert.equal(projectTodosDb.get(userId, projectId, deleted.id), null);
    assert.equal(projectTodosDb.get(otherUserId, projectId, theirs.id), null);
    await assert.rejects(() => fs.access(path.join(root, 'todo-assets', String(userId), projectId, mine.id)));
  });
});

test('create, update, remove, restore and mark broadcast only after successful writes', async () => {
  await withEnv(async ({ service, userId, projectId, root, clock, events }) => {
    const todo = await service.create(userId, projectId, {
      content: 'broadcast', files: [await upload(root, 'g.txt', 'g')], storedAttachments: [],
    });
    assert.deepEqual(events, [projectId]);

    await service.update(userId, projectId, todo.id, {
      content: 'edited', files: [], keepAttachmentIds: [todo.attachments[0].id], storedAttachments: [],
    });
    assert.deepEqual(events, [projectId, projectId]);

    await assert.rejects(() => service.create(userId, projectId, {
      content: '', files: [], storedAttachments: [],
    }), /needs text/);
    assert.equal(events.length, 2);

    await service.remove(userId, projectId, todo.id);
    assert.deepEqual(events, [projectId, projectId, projectId]);

    await assert.rejects(() => service.update(userId, projectId, todo.id, {
      content: 'not pending', files: [], storedAttachments: [],
    }), /Only pending todos/);
    assert.equal(events.length, 3);

    service.restore(userId, projectId, todo.id);
    assert.deepEqual(events, [projectId, projectId, projectId, projectId]);

    const sessionId = 'broadcast-session';
    sessionsDb.createAppSession(sessionId, 'codex', path.join(root, 'project'));
    service.markSubmitted({ userId, sessionId, todoIds: [todo.id] });
    assert.deepEqual(events, [projectId, projectId, projectId, projectId, projectId]);

    // A missing session or an already submitted row does not announce a change.
    clock.now = new Date('2026-01-02T00:00:00.000Z');
    service.markSubmitted({ userId, sessionId, todoIds: [todo.id] });
    service.markSubmitted({ userId, sessionId: 'missing', todoIds: [todo.id] });
    assert.equal(events.length, 5);
  });
});

test('retention broadcasts each affected project once and not a failed cleanup', { skip: process.getuid?.() === 0 }, async () => {
  await withEnv(async ({ service, userId, projectId, root, clock, events, baseDir }) => {
    const secondProject = projectsDb.createProjectPath(path.join(root, 'project-2')).project;
    assert.ok(secondProject);
    const first = await service.create(userId, projectId, {
      content: 'first', files: [await upload(root, 'h.txt', 'h')], storedAttachments: [],
    });
    const second = await service.create(userId, secondProject.project_id, {
      content: 'second', files: [], storedAttachments: [],
    });
    const sessionId = 'retention-broadcast-session';
    const secondSessionId = 'retention-broadcast-second-session';
    sessionsDb.createAppSession(sessionId, 'codex', path.join(root, 'project'));
    sessionsDb.createAppSession(secondSessionId, 'codex', path.join(root, 'project-2'));
    service.markSubmitted({ userId, sessionId, todoIds: [first.id] });
    service.markSubmitted({ userId, sessionId: secondSessionId, todoIds: [second.id] });
    events.length = 0;

    const lockedDir = path.join(baseDir, String(userId), projectId, first.id);
    await fs.chmod(lockedDir, 0o555);
    clock.now = new Date('2026-01-09T00:00:00.000Z');
    try {
      await service.runRetention();
      // The locked project kept its row, so only the other project is announced.
      assert.deepEqual(events, [secondProject.project_id]);
      assert.ok(projectTodosDb.get(userId, projectId, first.id));
    } finally {
      await fs.chmod(lockedDir, 0o755);
    }

    await service.runRetention();
    assert.deepEqual(events.sort(), [projectId, secondProject.project_id].sort());
    assert.equal(projectTodosDb.get(userId, projectId, first.id), null);
    assert.equal(projectTodosDb.get(userId, secondProject.project_id, second.id), null);
  });
});

test('a partial stored-attachment copy failure removes only this update’s new file', async () => {
  await withEnv(async ({ service, userId, projectId, assetsDir, events, root, baseDir }) => {
    const todo = await service.create(userId, projectId, {
      content: 'original', files: [await upload(root, 'original.txt', 'orig')], storedAttachments: [],
    });
    await fs.mkdir(assetsDir, { recursive: true });
    const validSource = path.join(assetsDir, 'valid.txt');
    await fs.writeFile(validSource, 'valid');
    events.length = 0;

    await assert.rejects(() => service.update(userId, projectId, todo.id, {
      content: 'original',
      files: [],
      keepAttachmentIds: [todo.attachments[0].id],
      storedAttachments: [
        { path: validSource, name: 'valid.txt', mimeType: 'text/plain', size: 5 },
        { path: path.join(assetsDir, 'missing.txt'), name: 'missing.txt', mimeType: 'text/plain', size: 7 },
      ],
    }));

    assert.deepEqual(events, []);
    const stored = projectTodosDb.get(userId, projectId, todo.id);
    assert.equal(stored?.content, 'original');
    assert.deepEqual(stored?.attachments.map((attachment) => attachment.name), ['original.txt']);
    const directory = path.join(baseDir, String(userId), projectId, todo.id);
    assert.equal((await fs.readdir(directory)).length, 1);
    assert.equal(await fs.readFile(path.join(directory, (await fs.readdir(directory))[0]), 'utf8'), 'orig');
  });
});
