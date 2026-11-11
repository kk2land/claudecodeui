import assert from 'node:assert/strict';
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
import { deleteOrArchiveProject } from '@/modules/projects/services/project-delete.service.js';

test('a hard delete removes the project todos before the project row', async () => {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-delete-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    const project = projectsDb.createProjectPath(root);
    assert.ok(project.project);
    const projectId = project.project.project_id;
    const userId = Number(userDb.createUser('delete-todos', 'hash').id);
    sessionsDb.createAppSession('delete-session', 'claude', root);
    const createdAt = new Date().toISOString();
    projectTodosDb.create({ id: 'todo-doomed', userId, projectId, content: 'gone', attachments: [], createdAt });
    projectTodosDb.create({ id: 'todo-kept', userId, projectId: 'other-project', content: 'kept', attachments: [], createdAt });

    await deleteOrArchiveProject(projectId, true);

    assert.equal(projectsDb.getProjectById(projectId), null);
    assert.equal(projectTodosDb.get(userId, projectId, 'todo-doomed'), null);
    // Unrelated projects' todos are untouched.
    assert.equal(projectTodosDb.get(userId, 'other-project', 'todo-kept')?.status, 'pending');
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
