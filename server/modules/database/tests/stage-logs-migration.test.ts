import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  stageLogsDb,
} from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

async function withDatabase(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-logs-migration-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await run(root);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const LEGACY_ROW = {
  id: 'legacy-log-1',
  task_id: 'task-legacy',
  session_id: 'session-legacy',
  execution_id: 'exec-legacy',
  source: 'agent',
  occurred_at: '2026-02-03T04:05:06.000Z',
  created_at: '2026-02-03T04:06:07.000Z',
  content: 'legacy node',
  status: 'failed',
  phase: 'deploy',
  data_json: '{"attempt":2}',
};

test('a fresh database gets only the stage table', async () => {
  await withDatabase(async () => {
    await initializeDatabase();
    const tables = getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('stage_logs','resident_logs')")
      .all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((row) => row.name), ['stage_logs']);
  });
});

test('legacy resident_logs rows migrate in place, survive a repeat run, and keep every field', async () => {
  await withDatabase(async () => {
    await initializeDatabase();
    const db = getConnection();
    // Model a database created before the rename.
    db.exec('DROP TABLE stage_logs');
    db.exec(`
      CREATE TABLE resident_logs (
        id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, session_id TEXT NOT NULL,
        execution_id TEXT, source TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
        content TEXT NOT NULL, status TEXT NOT NULL, phase TEXT, data_json TEXT
      )
    `);
    db.prepare(`INSERT INTO resident_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        LEGACY_ROW.id, LEGACY_ROW.task_id, LEGACY_ROW.session_id, LEGACY_ROW.execution_id,
        LEGACY_ROW.source, LEGACY_ROW.occurred_at, LEGACY_ROW.created_at, LEGACY_ROW.content,
        LEGACY_ROW.status, LEGACY_ROW.phase, LEGACY_ROW.data_json,
      );

    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('stage_logs','resident_logs')")
      .all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((row) => row.name), ['stage_logs']);
    assert.deepEqual(stageLogsDb.listPage({
      taskId: LEGACY_ROW.task_id,
      keepFrom: '2000-01-01T00:00:00.000Z',
      limit: 10,
    }), [{
      id: LEGACY_ROW.id,
      taskId: LEGACY_ROW.task_id,
      sessionId: LEGACY_ROW.session_id,
      executionId: LEGACY_ROW.execution_id,
      source: 'agent',
      occurredAt: LEGACY_ROW.occurred_at,
      createdAt: LEGACY_ROW.created_at,
      content: LEGACY_ROW.content,
      status: LEGACY_ROW.status,
      phase: LEGACY_ROW.phase,
      data: { attempt: 2 },
    }]);

    // A second initialization must not duplicate or lose the migrated row.
    runMigrations(db);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM stage_logs').get() as { count: number }).count,
      1,
    );
  });
});
