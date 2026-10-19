import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, providerModelsDb, sessionsDb } from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

test('DSH model migration preserves upstream columns, indexes, rows, effort and autoincrement state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-migration-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    const db = getConnection();
    db.exec(`DROP TABLE provider_models;
      CREATE TABLE provider_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(provider IN ('claude','cursor','codex','opencode')),
        model_id TEXT NOT NULL, model_name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        effort_values TEXT, effort_default TEXT, upstream_extra TEXT,
        UNIQUE(provider,model_id));
      CREATE INDEX idx_custom_models ON provider_models(model_name);
      INSERT INTO provider_models(id,provider,model_id,model_name,effort_values,effort_default,upstream_extra)
      VALUES(42,'codex','existing','Existing','["high"]','high','preserve upstream');
      INSERT INTO provider_models(id,provider,model_id,model_name) VALUES(100,'claude','removed','Removed');
      DELETE FROM provider_models WHERE id=100;`);
    const legacySql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'provider_models'").get() as { sql: string }).sql;
    runMigrations(db); runMigrations(db);
    assert.deepEqual(db.prepare('SELECT id, effort_values, effort_default, upstream_extra FROM provider_models WHERE id=42').get(),
      { id: 42, effort_values: '["high"]', effort_default: 'high', upstream_extra: 'preserve upstream' });
    assert(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_custom_models'").get());
    const model = providerModelsDb.createCustomProviderModel('dsh', { id: 'deepseek-official/custom', model: 'Custom' });
    assert(model.recordId > 100);
    assert.equal(providerModelsDb.listCustomProviderModels('dsh').length, 1);
    db.exec('DROP TABLE provider_models');
    db.exec(legacySql);
    db.exec("INSERT INTO provider_models(id,provider,model_id,model_name) VALUES(200,'codex','removed','Removed'); DELETE FROM provider_models;");
    runMigrations(db);
    assert(providerModelsDb.createCustomProviderModel('dsh', { id: 'fresh', model: 'Fresh' }).recordId > 200);
    const { sessionsService } = await import('@/modules/providers/index.js');
    const nativeLog = path.join(root, 'session.v4.jsonl');
    await writeFile(nativeLog, 'preserve all generations');
    sessionsDb.createSession('native-delete', 'dsh', root, 'Keep history', undefined, undefined, nativeLog);
    await assert.rejects(sessionsService.deleteOrArchiveSessionById('native-delete', { force: true, deletedFromDisk: true }),
      (error: unknown) => (error as { code: string }).code === 'DSH_NATIVE_DELETE_UNSUPPORTED');
    assert(sessionsDb.getSessionById('native-delete'));
    assert.equal(await readFile(nativeLog, 'utf8'), 'preserve all generations');
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
