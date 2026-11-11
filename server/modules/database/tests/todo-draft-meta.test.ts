import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionDraftsDb,
  userDb,
} from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

async function withDrafts(runTest: (userId: number) => void): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'todo-draft-meta-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    const userId = Number(userDb.createUser('todo-draft-meta', 'hash').id);
    runTest(userId);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const todoMeta = {
  todoIds: ['todo-1'],
  attachments: [{ path: '/home/user/.cloudcli/assets/a.txt', name: 'a.txt', mimeType: 'text/plain', size: 3 }],
};

test('text-only and queue writes preserve stored draft meta', async () => {
  await withDrafts((userId) => {
    sessionDraftsDb.saveDraft(userId, 'scope-a', { text: 'draft', meta: todoMeta });
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].meta, todoMeta);

    // The debounced text save omits meta and must not erase it.
    sessionDraftsDb.saveDraftText(userId, 'scope-a', 'draft edited');
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].meta, todoMeta);

    sessionDraftsDb.enqueueChatMessage(userId, 'scope-a', { content: 'queued', attachments: [] }, 'queued-1');
    const draft = sessionDraftsDb.getDrafts(userId)[0];
    assert.deepEqual(draft.meta, todoMeta);
    assert.equal(draft.text, 'draft edited');
    assert.deepEqual((draft.queuedMessages[0] as { id: string }).id, 'queued-1');

    // Clearing the queue or rewriting it also keeps meta.
    sessionDraftsDb.clearQueuedMessage(userId, 'scope-a');
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].meta, todoMeta);
  });
});

test('explicit null clears meta and permits deleting an otherwise empty draft', async () => {
  await withDrafts((userId) => {
    sessionDraftsDb.saveDraft(userId, 'scope-b', { text: '', meta: todoMeta });
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 1);

    sessionDraftsDb.saveDraft(userId, 'scope-b', { text: '', meta: null });
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), []);
  });
});

test('attachment-only meta survives empty cleanup and saveDraftText keeps it', async () => {
  await withDrafts((userId) => {
    const attachmentOnly = { todoIds: [], attachments: todoMeta.attachments };
    sessionDraftsDb.saveDraft(userId, 'scope-c', { text: '', meta: attachmentOnly });
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].meta, attachmentOnly);

    sessionDraftsDb.saveDraftText(userId, 'scope-c', '');
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].meta, attachmentOnly);

    sessionDraftsDb.saveDraftText(userId, 'scope-c', '', null);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), []);
  });
});

test('legacy draft table gains draft_meta idempotently without losing queue rows', async () => {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'todo-draft-migration-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    const db = getConnection();
    const userId = Number(userDb.createUser('todo-draft-migration', 'hash').id);
    const queued = { id: 'legacy-1', content: 'keep me' };
    db.exec('DROP TABLE session_drafts');
    db.exec(`
      CREATE TABLE session_drafts (
        user_id INTEGER NOT NULL,
        draft_scope TEXT NOT NULL,
        draft_text TEXT NOT NULL DEFAULT '',
        queued_message TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, draft_scope),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.prepare('INSERT INTO session_drafts(user_id, draft_scope, draft_text, queued_message) VALUES (?, ?, ?, ?)')
      .run(userId, 'legacy-scope', 'legacy text', JSON.stringify([queued]));

    runMigrations(db);
    runMigrations(db);

    const upgraded = sessionDraftsDb.getDrafts(userId)[0];
    assert.equal(upgraded.text, 'legacy text');
    assert.deepEqual(upgraded.queuedMessage, queued);
    assert.equal(upgraded.meta, null);

    sessionDraftsDb.saveDraftText(userId, 'legacy-scope', 'legacy text', todoMeta);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].meta, todoMeta);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessage, queued);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
