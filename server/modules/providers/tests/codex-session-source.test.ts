import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-source-db-'));

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

/** Writes one Codex rollout whose session_meta carries the given runtime source. */
async function writeCodexTranscript(
  homeDir: string,
  sessionId: string,
  workspacePath: string,
  source?: string,
): Promise<string> {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '07');
  await mkdir(sessionsDir, { recursive: true });

  const payload: Record<string, unknown> = { id: sessionId, cwd: workspacePath };
  if (source !== undefined) payload.source = source;

  const filePath = path.join(sessionsDir, `rollout-${sessionId}.jsonl`);
  await writeFile(filePath, `${JSON.stringify({ type: 'session_meta', payload })}\n`, 'utf8');
  return filePath;
}

test('full synchronization stores exec/vscode/cli and unknown sources, hiding only exec', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-source-sync-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath);
  const restoreHomeDir = patchHomeDir(tempRoot);
  const previousRuntime = process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;

  try {
    await writeCodexTranscript(tempRoot, 'codex-exec', workspacePath, 'exec');
    await writeCodexTranscript(tempRoot, 'codex-vscode', workspacePath, 'vscode');
    await writeCodexTranscript(tempRoot, 'codex-cli', workspacePath, 'cli');
    await writeCodexTranscript(tempRoot, 'codex-legacy', workspacePath);

    await withIsolatedDatabase(async () => {
      await new CodexSessionSynchronizer().synchronize();

      assert.equal(sessionsDb.getSessionById('codex-exec')?.session_source, 'exec');
      assert.equal(sessionsDb.getSessionById('codex-vscode')?.session_source, 'vscode');
      assert.equal(sessionsDb.getSessionById('codex-cli')?.session_source, 'cli');
      assert.equal(sessionsDb.getSessionById('codex-legacy')?.session_source, 'unknown');

      assert.deepEqual(
        sessionsDb.getAllSessions().map((row) => row.session_id).sort(),
        ['codex-cli', 'codex-legacy', 'codex-vscode'],
      );
      // A hidden row stays reachable by id for resume, history, and deletion.
      assert.equal(sessionsDb.getSessionById('codex-exec')?.provider, 'codex');
    });
  } finally {
    restoreHomeDir();
    if (previousRuntime === undefined) delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
    else process.env.CLOUDCLI_CODEX_RUNTIME_MODE = previousRuntime;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('file synchronization stores the source and explicit sdk runtime keeps source-exec sessions visible', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-source-file-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath);
  const restoreHomeDir = patchHomeDir(tempRoot);
  const previousRuntime = process.env.CLOUDCLI_CODEX_RUNTIME_MODE;

  try {
    const filePath = await writeCodexTranscript(tempRoot, 'codex-sdk-file', workspacePath, 'exec');

    await withIsolatedDatabase(async () => {
      await new CodexSessionSynchronizer().synchronizeFile(filePath);

      delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
      assert.equal(sessionsDb.getSessionById('codex-sdk-file')?.session_source, 'exec');
      assert.deepEqual(sessionsDb.getAllSessions(), []);

      process.env.CLOUDCLI_CODEX_RUNTIME_MODE = 'sdk';
      assert.deepEqual(sessionsDb.getAllSessions().map((row) => row.session_id), ['codex-sdk-file']);
    });
  } finally {
    restoreHomeDir();
    if (previousRuntime === undefined) delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
    else process.env.CLOUDCLI_CODEX_RUNTIME_MODE = previousRuntime;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('an existing exec row is backfilled even when the scan cursor is after its file', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-source-backfill-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath);
  const restoreHomeDir = patchHomeDir(tempRoot);
  const previousRuntime = process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;

  try {
    const filePath = await writeCodexTranscript(tempRoot, 'codex-old-exec', workspacePath, 'exec');

    await withIsolatedDatabase(async () => {
      // Indexed before the source column existed: source NULL, user state set.
      sessionsDb.createSession(
        'codex-old-exec', 'codex', workspacePath, 'My renamed conversation',
        '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z', filePath,
      );
      sessionsDb.updateSessionIsArchived('codex-old-exec', true);
      const before = sessionsDb.getSessionById('codex-old-exec');
      assert.equal(before?.session_source, null);

      // The cursor is in the future, so the birthtime filter would skip the file.
      await new CodexSessionSynchronizer().synchronize(new Date(Date.now() + 60 * 60 * 1000));

      const after = sessionsDb.getSessionById('codex-old-exec');
      assert.equal(after?.session_source, 'exec');
      assert.equal(after?.custom_name, before?.custom_name);
      assert.equal(after?.isArchived, before?.isArchived);
      assert.equal(after?.provider_session_id, before?.provider_session_id);
      assert.equal(after?.jsonl_path, filePath);
      // Backfilling the source must not change timestamps or sidebar ordering.
      assert.equal(after?.created_at, before?.created_at);
      assert.equal(after?.updated_at, before?.updated_at);
      assert.deepEqual(sessionsDb.getAllSessions(), []);
      assert.deepEqual(sessionsDb.getArchivedSessions(), []);

      // The source is stored once; a later scan does not rewrite it.
      await new CodexSessionSynchronizer().synchronize();
      assert.equal(sessionsDb.getSessionById('codex-old-exec')?.session_source, 'exec');
    });
  } finally {
    restoreHomeDir();
    if (previousRuntime === undefined) delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
    else process.env.CLOUDCLI_CODEX_RUNTIME_MODE = previousRuntime;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
