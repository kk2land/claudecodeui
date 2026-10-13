import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionDraftsDb, sessionRuntimeDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

test('upgrades legacy drafts and recovers pending steer deliveries idempotently', async () => {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-controls-migration-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    const db = getConnection();
    const userId = Number(userDb.createUser('migration-test', 'hash').id);
    const queued = { id: 'queued-1', content: 'preserve this prompt' };
    sessionDraftsDb.saveDraft(userId, 'fresh-session', { text: 'fresh draft', queuedMessage: queued });
    assert.equal(sessionDraftsDb.getDrafts(userId)[0].queuedDelivery.status, 'queued');

    // Model the main-branch schema before any Codex control tables or queue columns exist.
    db.exec(`
      DROP TABLE session_drafts;
      DROP TABLE queued_steer_receipts;
      DROP TABLE session_runtime_settings;
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
    sessionsDb.createAppSession('legacy-session', 'codex', root);
    db.prepare('INSERT INTO session_drafts(user_id, draft_scope, draft_text, queued_message) VALUES (?, ?, ?, ?)')
      .run(userId, 'legacy-session', 'keep my draft', JSON.stringify(queued));
    runMigrations(db);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0].queuedMessage, queued);
    assert.equal(sessionDraftsDb.getDrafts(userId)[0].queuedDelivery.status, 'queued');
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 1);

    sessionRuntimeDb.update('legacy-session', { runtime: 'sdk', mode: 'plan', queueHeld: true });
    sessionDraftsDb.beginSteer(userId, 'legacy-session', queued.id, 'lost-ack');
    runMigrations(db);
    runMigrations(db);
    const draft = sessionDraftsDb.getDrafts(userId)[0];
    assert.equal(draft.text, 'keep my draft');
    assert.deepEqual(draft.queuedMessage, queued);
    assert.equal(draft.queuedDelivery.status, 'unknown');
    assert.equal(draft.queuedDelivery.requestId, 'lost-ack');
    assert.deepEqual(db.prepare('SELECT status FROM queued_steer_receipts WHERE request_id = ?').get('lost-ack'), { status: 'unknown' });
    assert.deepEqual(sessionRuntimeDb.get('legacy-session'), { runtime: 'sdk', mode: 'plan', queueHeld: true });
    assert.equal(sessionDraftsDb.listQueuedMessages().length, 0);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
