import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  residentBindingsDb,
  sessionRuntimeDb,
  sessionsDb,
} from '@/modules/database/index.js';

import { readResidentSessionInfo } from '../resident-session-projection.js';

test('both existing Codex runtimes project resident metadata; unsupported providers project nothing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resident-projection-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    for (const [sessionId, runtime] of [
      ['exec-session', 'sdk'],
      ['app-server-session', 'app-server'],
    ] as const) {
      sessionsDb.createAppSession(sessionId, 'codex', root, sessionId);
      sessionRuntimeDb.update(sessionId, { runtime });
      const projection = readResidentSessionInfo({ sessionId, provider: 'codex' });
      assert.ok(projection);
      // The configured runtime never disqualifies a Codex session, and the
      // plugin-not-running test environment reports its own reason, not a
      // provider-level refusal.
      assert.notEqual(projection.blockedReason, 'unsupported_provider');
    }

    // A bound exec session reports the binding instead of an adoption offer.
    sessionsDb.createAppSession('bound-exec', 'codex', root, 'bound');
    sessionRuntimeDb.update('bound-exec', { runtime: 'sdk' });
    residentBindingsDb.insert({
      taskId: 'task-exec',
      sessionId: 'bound-exec',
      projectId: '',
      name: 'bound',
      provider: 'codex',
      providerSessionId: 'native-bound',
      enabled: true,
      visible: true,
      status: 'stopped',
      executionId: null,
      stopCause: null,
      terminal: null,
      permissionMode: null,
      sandboxMode: null,
      model: null,
      effort: null,
      runtime: 'sdk',
    });
    const bound = readResidentSessionInfo({ sessionId: 'bound-exec', provider: 'codex' });
    assert.equal(bound?.taskId, 'task-exec');
    assert.equal(bound?.blockedReason, 'already_resident');

    // Providers without resident support keep their old payload shape.
    sessionsDb.createAppSession('claude-session', 'claude', root, 'claude');
    assert.equal(
      readResidentSessionInfo({ sessionId: 'claude-session', provider: 'claude' }),
      null,
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});
