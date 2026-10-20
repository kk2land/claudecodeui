import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import type { IProvider } from '@/shared/index.js';

test('GPT Web indexes the configured home independently and disabling it preserves history and other scan progress', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gptweb-index-'));
  const originalDatabase = process.env.DATABASE_PATH;
  const originalHome = process.env.CODEX_GPTWEB_HOME;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.CODEX_GPTWEB_HOME = path.join(root, 'custom-web-profile');
  t.mock.method(os, 'homedir', () => path.join(root, 'user'));
  try {
    await initializeDatabase();
    const codexFile = path.join(root, 'user', '.codex', 'sessions', 'rollout-shared.jsonl');
    const webFile = path.join(process.env.CODEX_GPTWEB_HOME, 'sessions', 'rollout-shared.jsonl');
    for (const file of [codexFile, webFile]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'shared-native-id', cwd: root } }) + '\n');
    }
    assert.equal(await new CodexSessionSynchronizer().synchronize(), 1);
    assert.equal(await new CodexSessionSynchronizer('gptweb').synchronize(), 1);
    const native = sessionsDb.getSessionByProviderSessionId('shared-native-id', 'codex')!;
    const web = sessionsDb.getSessionByProviderSessionId('shared-native-id', 'gptweb')!;
    assert.equal(native.jsonl_path, codexFile);
    assert.equal(web.jsonl_path, webFile);
    assert.notEqual(native.session_id, web.session_id);

    await rm(webFile);
    delete process.env.CODEX_GPTWEB_HOME;
    let codexScans = 0;
    t.mock.method(providerRegistry, 'listProviders', () => [
      { id: 'codex', sessionSynchronizer: { synchronize: async () => { codexScans++; return 0; } } },
      { id: 'gptweb', sessionSynchronizer: { synchronize: async () => { throw new Error('Disabled profile was scanned'); } } },
    ] as unknown as IProvider[]);
    const result = await sessionSynchronizerService.synchronizeSessions();
    assert.equal(codexScans, 1);
    assert.deepEqual(result.failures, []);
    assert.ok(sessionsDb.getSessionById(web.session_id));
  } finally {
    closeConnection();
    if (originalDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = originalDatabase;
    if (originalHome === undefined) delete process.env.CODEX_GPTWEB_HOME; else process.env.CODEX_GPTWEB_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
});
