import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, providerModelsDb, sessionRuntimeDb, sessionsDb } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

test('GPT Web preserves model-library data and keeps copied native threads and queue stops provider-scoped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gptweb-db-'));
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
      CREATE INDEX idx_gptweb_upgrade_preserve ON provider_models(model_name);
      INSERT INTO provider_models(id,provider,model_id,model_name,effort_values,effort_default,upstream_extra)
      VALUES(42,'codex','existing','Existing','["high"]','high','preserve');
      INSERT INTO provider_models(id,provider,model_id,model_name) VALUES(100,'dsh','deleted','Deleted');
      DELETE FROM provider_models WHERE id=100;`);
    runMigrations(db); runMigrations(db);
    assert.deepEqual(db.prepare('SELECT id, effort_values, effort_default, upstream_extra FROM provider_models WHERE id=42').get(),
      { id: 42, effort_values: '["high"]', effort_default: 'high', upstream_extra: 'preserve' });
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_gptweb_upgrade_preserve'").get());
    assert.ok(providerModelsDb.createCustomProviderModel('gptweb', { id: 'chatgpt-web/custom', model: 'Custom' }).recordId > 100);

    const codexId = sessionsDb.createSession('copied-native-thread', 'codex', root, 'Native Codex');
    const webId = sessionsDb.createSession('copied-native-thread', 'gptweb', root, 'Web Codex');
    assert.notEqual(webId, codexId);
    assert.equal(sessionsDb.getSessionById(codexId)?.provider, 'codex');
    assert.equal(sessionsDb.getSessionByProviderSessionId('copied-native-thread', 'gptweb')?.session_id, webId);
    assert.equal(sessionsDb.createSession('copied-native-thread', 'gptweb', root), webId);
    sessionRuntimeDb.update(codexId, { runtime: 'app-server', queueHeld: false });
    sessionRuntimeDb.update(webId, { runtime: 'app-server', queueHeld: false });
    sessionRuntimeDb.holdCodexAppServerQueues('gptweb');
    assert.equal(sessionRuntimeDb.get(webId).queueHeld, true);
    assert.equal(sessionRuntimeDb.get(codexId).queueHeld, false);
    sessionRuntimeDb.update(webId, { queueHeld: false });
    sessionRuntimeDb.holdCodexAppServerQueues();
    assert.equal(sessionRuntimeDb.get(codexId).queueHeld, true);
    assert.equal(sessionRuntimeDb.get(webId).queueHeld, false);

    sessionsDb.createAppSession('web-app', 'gptweb', root);
    sessionsDb.assignProviderSessionId('web-app', 'copied-native-thread');
    assert.equal(sessionsDb.getSessionById(codexId)?.provider, 'codex');
    assert.equal(sessionsDb.getSessionById(webId), null);
    assert.equal(sessionsDb.getSessionByProviderSessionId('copied-native-thread', 'gptweb')?.session_id, 'web-app');

    const nativeFork = sessionsDb.createSession('copied-fork', 'codex', root);
    const indexedFork = sessionsDb.createSession('copied-fork', 'gptweb', root);
    sessionsDb.createForkedSession({ sessionId: 'web-fork', provider: 'gptweb', projectPath: root,
      customName: 'Web fork', providerSessionId: 'copied-fork', jsonlPath: '/web-fork.jsonl',
      forkedFromSessionId: 'web-app', model: 'chatgpt-web/sol', effort: 'high' });
    assert.equal(sessionsDb.getSessionById(nativeFork)?.provider, 'codex');
    assert.equal(sessionsDb.getSessionById(indexedFork), null);
    assert.equal(sessionsDb.getSessionByProviderSessionId('copied-fork', 'gptweb')?.session_id, 'web-fork');

    const nativeEdited = sessionsDb.createSession('copied-edit', 'codex', root);
    const indexedEdit = sessionsDb.createSession('copied-edit', 'gptweb', root);
    sessionsDb.repointSessionToProviderSession('web-app', { providerSessionId: 'copied-edit', jsonlPath: '/web-edit.jsonl' });
    assert.equal(sessionsDb.getSessionById(nativeEdited)?.provider, 'codex');
    assert.equal(sessionsDb.getSessionById(indexedEdit), null);
    assert.equal(sessionsDb.getSessionByProviderSessionId('copied-edit', 'gptweb')?.session_id, 'web-app');
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
