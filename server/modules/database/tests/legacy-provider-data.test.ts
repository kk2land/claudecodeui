import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, providerModelsDb, sessionRuntimeDb, sessionsDb } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

test('historical model migration preserves data and copied threads stay provider-scoped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-data-db-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    const db = getConnection();
    db.exec(`DROP TABLE provider_models;
      CREATE TABLE provider_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('claude','cursor','codex','opencode','dsh')),
        model_id TEXT NOT NULL, model_name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        effort_values TEXT, effort_default TEXT, upstream_extra TEXT,
        UNIQUE(provider,model_id));
      CREATE INDEX idx_provider_upgrade_preserve ON provider_models(model_name);
      INSERT INTO provider_models(id,provider,model_id,model_name,effort_values,effort_default,upstream_extra)
      VALUES(42,'codex','existing','Existing','["high"]','high','preserve');
      INSERT INTO provider_models(id,provider,model_id,model_name) VALUES(100,'dsh','deleted','Deleted');
      DELETE FROM provider_models WHERE id=100;`);
    runMigrations(db); runMigrations(db);
    assert.deepEqual(db.prepare('SELECT id, effort_values, effort_default, upstream_extra FROM provider_models WHERE id=42').get(),
      { id: 42, effort_values: '["high"]', effort_default: 'high', upstream_extra: 'preserve' });
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_provider_upgrade_preserve'").get());
    assert.ok(providerModelsDb.createCustomProviderModel('codex', { id: 'custom', model: 'Custom' }).recordId > 100);

    db.prepare("INSERT INTO provider_models (provider, model_id, model_name) VALUES ('gptweb', 'legacy-model', 'Legacy')").run();
    runMigrations(db);
    assert.ok(db.prepare("SELECT 1 FROM provider_models WHERE provider = 'gptweb' AND model_id = 'legacy-model'").get());

    const codexId = sessionsDb.createSession('copied-native-thread', 'codex', root, 'Native Codex');
    const dshId = sessionsDb.createSession('copied-native-thread', 'dsh', root, 'DSH');
    assert.notEqual(dshId, codexId);
    assert.equal(sessionsDb.getSessionById(codexId)?.provider, 'codex');
    assert.equal(sessionsDb.getSessionByProviderSessionId('copied-native-thread', 'dsh')?.session_id, dshId);
    assert.equal(sessionsDb.createSession('copied-native-thread', 'dsh', root), dshId);
    sessionRuntimeDb.update(codexId, { runtime: 'app-server', queueHeld: false });
    sessionRuntimeDb.update(dshId, { runtime: 'app-server', queueHeld: false });
    sessionRuntimeDb.holdCodexAppServerQueues();
    assert.equal(sessionRuntimeDb.get(codexId).queueHeld, true);
    assert.equal(sessionRuntimeDb.get(dshId).queueHeld, false);

    sessionsDb.createAppSession('dsh-app', 'dsh', root);
    sessionsDb.assignProviderSessionId('dsh-app', 'copied-native-thread');
    assert.equal(sessionsDb.getSessionById(codexId)?.provider, 'codex');
    assert.equal(sessionsDb.getSessionById(dshId), null);
    assert.equal(sessionsDb.getSessionByProviderSessionId('copied-native-thread', 'dsh')?.session_id, 'dsh-app');

    const nativeFork = sessionsDb.createSession('copied-fork', 'codex', root);
    const indexedFork = sessionsDb.createSession('copied-fork', 'dsh', root);
    sessionsDb.createForkedSession({ sessionId: 'dsh-fork', provider: 'dsh', projectPath: root,
      customName: 'DSH fork', providerSessionId: 'copied-fork', jsonlPath: '/dsh-fork.jsonl',
      forkedFromSessionId: 'dsh-app', model: 'deepseek/default', effort: 'high' });
    assert.equal(sessionsDb.getSessionById(nativeFork)?.provider, 'codex');
    assert.equal(sessionsDb.getSessionById(indexedFork), null);
    assert.equal(sessionsDb.getSessionByProviderSessionId('copied-fork', 'dsh')?.session_id, 'dsh-fork');

    const nativeEdited = sessionsDb.createSession('copied-edit', 'codex', root);
    const indexedEdit = sessionsDb.createSession('copied-edit', 'dsh', root);
    sessionsDb.repointSessionToProviderSession('dsh-app', { providerSessionId: 'copied-edit', jsonlPath: '/dsh-edit.jsonl' });
    assert.equal(sessionsDb.getSessionById(nativeEdited)?.provider, 'codex');
    assert.equal(sessionsDb.getSessionById(indexedEdit), null);
    assert.equal(sessionsDb.getSessionByProviderSessionId('copied-edit', 'dsh')?.session_id, 'dsh-app');
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('retired provider rows stay in storage without affecting visible pages or totals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'retired-provider-db-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    sessionsDb.createSession('legacy-web', 'gptweb', root, 'Legacy', undefined, '2099-01-01T00:00:00Z');
    sessionsDb.createSession('active-codex', 'codex', root, 'Codex');
    sessionsDb.createAppSession('archived-web', 'gptweb', root);
    getConnection().prepare('UPDATE sessions SET isArchived = 1 WHERE session_id = ?').run('archived-web');
    runMigrations(getConnection());

    assert.deepEqual(sessionsDb.getAllSessions().map((row) => row.session_id), ['active-codex']);
    assert.deepEqual(sessionsDb.getRecentSessionsPage(1, 0).sessions.map((row) => row.session_id), ['active-codex']);
    assert.equal(sessionsDb.getRecentSessionsPage(1, 0).total, 1);
    assert.equal(sessionsDb.getRecentSessionsPage(1, 1).sessions.length, 0);
    assert.deepEqual(sessionsDb.getSessionsByProjectPathPage(root, 1, 0).map((row) => row.session_id), ['active-codex']);
    assert.equal(sessionsDb.countSessionsByProjectPath(root), 1);
    assert.equal(sessionsDb.getSessionsByProjectPath(root).length, 1);
    assert.deepEqual(sessionsDb.getArchivedSessions(), []);
    assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(root).length, 3);
    assert.equal(sessionsDb.getSessionById('legacy-web')?.provider, 'gptweb');
    assert.equal(sessionsDb.getSessionById('archived-web')?.isArchived, 1);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
