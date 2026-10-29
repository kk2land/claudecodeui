import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionRuntimeDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-source-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('source visibility filters every list before pagination while keeping rows readable by id', { concurrency: false }, async () => {
  const previousRuntime = process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  const root = '/workspace/source-project';

  try {
    await withIsolatedDatabase(() => {
      sessionsDb.createSession('codex-exec', 'codex', root, 'Exec transcript', undefined, '2026-07-01T10:00:00Z', '/tmp/exec.jsonl', 'exec');
      sessionsDb.createSession('codex-vscode', 'codex', root, 'App server', undefined, '2026-07-01T11:00:00Z', '/tmp/vscode.jsonl', 'vscode');
      sessionsDb.createSession('codex-unknown', 'codex', root, 'Older transcript', undefined, '2026-07-01T12:00:00Z', '/tmp/old.jsonl');
      sessionsDb.createSession('claude-plain', 'claude', root, 'Claude', undefined, '2026-07-01T13:00:00Z');
      sessionsDb.createSession('codex-exec-archived', 'codex', root, 'Archived exec', undefined, '2026-07-01T14:00:00Z', '/tmp/archived.jsonl', 'exec');
      sessionsDb.createSession('codex-vscode-archived', 'codex', root, 'Archived app', undefined, '2026-07-01T15:00:00Z', '/tmp/archived-vscode.jsonl', 'vscode');
      sessionsDb.updateSessionIsArchived('codex-exec-archived', true);
      sessionsDb.updateSessionIsArchived('codex-vscode-archived', true);
      // A persisted per-session SDK runtime does not override the process mode.
      sessionRuntimeDb.update('codex-exec', { runtime: 'sdk', queueHeld: false });

      assert.deepEqual(
        sessionsDb.getAllSessions().map((row) => row.session_id).sort(),
        ['claude-plain', 'codex-unknown', 'codex-vscode'],
      );

      const firstPage = sessionsDb.getRecentSessionsPage(2, 0);
      assert.equal(firstPage.total, 3);
      assert.deepEqual(firstPage.sessions.map((row) => row.session_id), ['claude-plain', 'codex-unknown']);
      const secondPage = sessionsDb.getRecentSessionsPage(2, 2);
      assert.equal(secondPage.total, 3);
      assert.deepEqual(secondPage.sessions.map((row) => row.session_id), ['codex-vscode']);

      assert.equal(sessionsDb.countSessionsByProjectPath(root), 3);
      assert.deepEqual(
        sessionsDb.getSessionsByProjectPathPage(root, 10, 0).map((row) => row.session_id),
        ['claude-plain', 'codex-unknown', 'codex-vscode'],
      );
      assert.deepEqual(
        sessionsDb.getArchivedSessions().map((row) => row.session_id),
        ['codex-vscode-archived'],
      );

      // Permanent project deletion still sees hidden rows; the archived view opts in.
      assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(root).length, 6);
      assert.deepEqual(
        sessionsDb.getSessionsByProjectPathIncludingArchived(root, { visibleOnly: true })
          .map((row) => row.session_id).sort(),
        ['claude-plain', 'codex-unknown', 'codex-vscode', 'codex-vscode-archived'],
      );

      const hidden = sessionsDb.getSessionById('codex-exec');
      assert.equal(hidden?.session_source, 'exec');
      assert.equal(hidden?.custom_name, 'Exec transcript');

      process.env.CLOUDCLI_CODEX_RUNTIME_MODE = 'sdk';
      assert.equal(sessionsDb.getAllSessions().length, 4);
      assert.equal(sessionsDb.getRecentSessionsPage(10, 0).total, 4);
      assert.equal(sessionsDb.countSessionsByProjectPath(root), 4);
    });
  } finally {
    if (previousRuntime === undefined) delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
    else process.env.CLOUDCLI_CODEX_RUNTIME_MODE = previousRuntime;
  }
});

test('source survives watcher merges and is cleared when the thread changes', { concurrency: false }, async () => {
  const previousRuntime = process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  const root = '/workspace/source-lifecycle';

  try {
    await withIsolatedDatabase(() => {
      // A watcher-indexed exec row merges into the app session: the canonical
      // row inherits the source and the duplicate disappears.
      sessionsDb.createAppSession('app-lifecycle', 'codex', root, 'Lifecycle');
      sessionsDb.createSession('native-exec', 'codex', root, 'Watcher exec', undefined, undefined, '/tmp/native-exec.jsonl', 'exec');
      sessionsDb.assignProviderSessionId('app-lifecycle', 'native-exec');

      assert.equal(sessionsDb.getSessionById('native-exec'), null);
      assert.equal(sessionsDb.getSessionById('app-lifecycle')?.session_source, 'exec');
      assert.deepEqual(sessionsDb.getAllSessions(), []);

      sessionsDb.detachProviderSession('app-lifecycle');
      assert.equal(sessionsDb.getSessionById('app-lifecycle')?.session_source, null);
      assert.deepEqual(sessionsDb.getAllSessions().map((row) => row.session_id), ['app-lifecycle']);

      // Mapping a vscode-origin transcript makes the canonical row visible.
      sessionsDb.createSession('native-vscode', 'codex', root, 'Watcher vscode', undefined, undefined, '/tmp/native-vscode.jsonl', 'vscode');
      sessionsDb.assignProviderSessionId('app-lifecycle', 'native-vscode');
      assert.equal(sessionsDb.getSessionById('native-vscode'), null);
      assert.equal(sessionsDb.getSessionById('app-lifecycle')?.session_source, 'vscode');
      assert.deepEqual(sessionsDb.getAllSessions().map((row) => row.session_id), ['app-lifecycle']);

      // Repointing to a new thread must not keep the old origin.
      sessionsDb.createSession('native-repoint', 'codex', root, 'Watcher exec 2', undefined, undefined, '/tmp/native-repoint.jsonl', 'exec');
      sessionsDb.repointSessionToProviderSession('app-lifecycle', {
        providerSessionId: 'native-repoint',
        jsonlPath: '/tmp/native-repoint.jsonl',
      });

      const repointed = sessionsDb.getSessionById('app-lifecycle');
      assert.equal(repointed?.session_source, null);
      assert.equal(repointed?.jsonl_path, '/tmp/native-repoint.jsonl');
      assert.deepEqual(sessionsDb.getAllSessions().map((row) => row.session_id), ['app-lifecycle']);
    });
  } finally {
    if (previousRuntime === undefined) delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
    else process.env.CLOUDCLI_CODEX_RUNTIME_MODE = previousRuntime;
  }
});

test('session source migration is idempotent and preserves rows and indexes', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    sessionsDb.createSession(
      'legacy-codex', 'codex', '/workspace/legacy-project', 'Keep this title',
      '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '/tmp/legacy.jsonl', 'exec',
    );
    sessionsDb.updateSessionIsArchived('legacy-codex', true);

    // Model an installation that predates the source column.
    db.exec('ALTER TABLE sessions DROP COLUMN session_source');
    assert.equal(
      (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
        .some((column) => column.name === 'session_source'),
      false,
    );

    runMigrations(db);
    runMigrations(db);

    const sourceColumns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .filter((column) => column.name === 'session_source');
    assert.equal(sourceColumns.length, 1);

    const row = db.prepare(
      `SELECT provider_session_id, custom_name, isArchived, jsonl_path, session_source
       FROM sessions WHERE session_id = 'legacy-codex'`,
    ).get() as Record<string, unknown>;
    assert.deepEqual(row, {
      provider_session_id: 'legacy-codex',
      custom_name: 'Keep this title',
      isArchived: 1,
      jsonl_path: '/tmp/legacy.jsonl',
      session_source: null,
    });
    for (const index of [
      'idx_session_ids_lookup',
      'idx_sessions_provider_session_id',
      'idx_sessions_project_path',
      'idx_sessions_is_archived',
    ]) {
      assert.ok(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index),
        `index ${index} must survive the migration`,
      );
    }
  });
});
