import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/**
 * Retired providers keep their native transcripts when a project is force
 * deleted: the rows and superseded index entries go, the files stay on disk.
 * Other providers keep losing both the current and superseded transcripts.
 */
test('a hard delete keeps retired provider transcripts on disk', async () => {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-delete-retired-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    const project = projectsDb.createProjectPath(root);
    assert.ok(project.project);
    const projectId = project.project.project_id;

    const claudeTranscript = path.join(root, 'claude.jsonl');
    const claudeSuperseded = path.join(root, 'claude-old.jsonl');
    const dshTranscript = path.join(root, 'dsh.jsonl');
    const dshSuperseded = path.join(root, 'dsh-old.jsonl');
    for (const file of [claudeTranscript, claudeSuperseded, dshTranscript, dshSuperseded]) {
      await writeFile(file, '{}\n', 'utf8');
    }

    const claudeId = sessionsDb.createSession('claude-native', 'claude', root, 'Claude', undefined, undefined, claudeTranscript);
    sessionsDb.markProviderSessionSuperseded({
      providerSessionId: 'claude-old',
      provider: 'claude',
      sessionId: claudeId,
      jsonlPath: claudeSuperseded,
    });
    const dshId = sessionsDb.createSession('dsh-native', 'dsh', root, 'DSH', undefined, undefined, dshTranscript);
    sessionsDb.markProviderSessionSuperseded({
      providerSessionId: 'dsh-old',
      provider: 'dsh',
      sessionId: dshId,
      jsonlPath: dshSuperseded,
    });

    await deleteOrArchiveProject(projectId, true);

    // The live provider's current and superseded transcripts are gone.
    await assert.rejects(readFile(claudeTranscript, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(claudeSuperseded, 'utf8'), { code: 'ENOENT' });
    // The retired provider's files survive the delete untouched.
    assert.equal(await readFile(dshTranscript, 'utf8'), '{}\n');
    assert.equal(await readFile(dshSuperseded, 'utf8'), '{}\n');

    // The authorized project/index deletion still runs.
    assert.equal(projectsDb.getProjectById(projectId), null);
    assert.equal(sessionsDb.getSessionById(dshId), null);
    assert.deepEqual(sessionsDb.getSupersededTranscriptPaths(dshId), []);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
