import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectTodosDb,
  userDb,
} from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

test('legacy database gains project_todos idempotently and keeps rows', async () => {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-todos-migration-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    const db = getConnection();
    const userId = Number(userDb.createUser('project-todos-migration', 'hash').id);
    db.exec('DROP TABLE project_todos');
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_todos'").get(),
      undefined,
    );

    runMigrations(db);
    runMigrations(db);

    const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const created = projectTodosDb.create({
      id: 'todo-migration',
      userId,
      projectId: 'project-migration',
      content: 'survives',
      attachments: [],
      createdAt: now,
    });
    assert.equal(created.content, 'survives');
    runMigrations(db);
    assert.equal(projectTodosDb.get(userId, 'project-migration', 'todo-migration')?.content, 'survives');
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
