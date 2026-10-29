import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { closeConnection, initializeDatabase, sessionRuntimeDb, sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { CodexForkProvider } from '@/modules/providers/list/codex/codex-fork.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

/**
 * The fork endpoint itself is exercised against the real `codex app-server` in
 * codex-message-editing.test.ts and codex-model-provider.smoke.test.ts. These
 * tests cover request mapping and the app session's persisted fork settings.
 */

let directory: string;
const previousDatabasePath = process.env.DATABASE_PATH;
const previousRuntime = process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'codex-session-fork-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  process.env.CLOUDCLI_CODEX_RUNTIME_MODE = 'app-server';
  await initializeDatabase();
});
afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousRuntime === undefined) delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  else process.env.CLOUDCLI_CODEX_RUNTIME_MODE = previousRuntime;
  await rm(directory, { recursive: true, force: true });
});

test('a Codex fork asks for the whole thread when no anchor is given', { concurrency: false }, async () => {
  const realForkThread = codexAppServer.forkThread;
  const forkCalls: unknown[] = [];
  codexAppServer.forkThread = async (input) => {
    forkCalls.push(input);
    return { threadId: 'thread-2', path: '/tmp/rollout-thread-2.jsonl' };
  };

  try {
    const forked = await new CodexForkProvider().forkSession({
      providerSessionId: 'thread-1',
      jsonlPath: '/tmp/rollout-thread-1.jsonl',
      projectPath: '/tmp/workspace',
      title: 'ignored by codex',
    });
    assert.deepEqual(forked, { providerSessionId: 'thread-2', jsonlPath: '/tmp/rollout-thread-2.jsonl' });
  } finally {
    codexAppServer.forkThread = realForkThread;
  }

  assert.deepEqual(forkCalls, [{ threadId: 'thread-1', lastTurnId: undefined, cwd: '/tmp/workspace' }]);
});

test('forking from a message cuts through that message\'s turn', async () => {
  const realForkThread = codexAppServer.forkThread;
  const forkCalls: unknown[] = [];
  codexAppServer.forkThread = async (input) => {
    forkCalls.push(input);
    return { threadId: 'thread-2', path: '/tmp/rollout-thread-2.jsonl' };
  };

  try {
    await new CodexForkProvider().forkSession({
      providerSessionId: 'thread-1',
      jsonlPath: '/tmp/rollout-thread-1.jsonl',
      projectPath: '/tmp/workspace',
      upToAnchorId: 'turn-b',
    });
  } finally {
    codexAppServer.forkThread = realForkThread;
  }

  // Inclusive of the turn it names, so the branch keeps the message that was
  // forked from *and* the answer it got. A turn is written as one thing; there
  // is no cut that stops between them.
  assert.deepEqual(forkCalls, [{ threadId: 'thread-1', lastTurnId: 'turn-b', cwd: '/tmp/workspace' }]);
});

for (const { name, runtime, modelSelection } of [
  { name: 'a selected service and remote model', runtime: 'app-server', modelSelection: { modelProvider: 'beta', model: 'gateway/new-model' } },
  { name: 'a selected service with an empty model', runtime: 'app-server', modelSelection: { modelProvider: 'beta', model: null } },
  { name: 'no explicit service', runtime: 'app-server', modelSelection: undefined },
  { name: 'SDK with an inactive service selection', runtime: 'sdk', modelSelection: { modelProvider: 'beta', model: 'gateway/new-model' } },
] as const) {
  test(`forking preserves ${name} without inheriting queue or collaboration state`, async (t) => {
    const sourcePath = path.join(directory, 'source.jsonl');
    const forkPath = path.join(directory, 'fork.jsonl');
    await writeFile(sourcePath, '{}\n');
    await writeFile(forkPath, '{}\n');
    const now = new Date().toISOString();
    sessionsDb.createSession('source', 'codex', directory, 'Source', now, now, sourcePath);
    sessionsDb.assignProviderSessionId('source', 'native-source');
    sessionsDb.setSessionModel('source', 'gpt-5.4');
    sessionsDb.setSessionEffort('source', 'high');
    sessionRuntimeDb.update('source', { runtime, modelSelection, mode: 'plan', queueHeld: true });
    const sourceSettings = sessionRuntimeDb.get('source');
    // An explicit native selection must also pin the fork's runtime, even if
    // the installation's default has since changed to the SDK.
    if (runtime === 'app-server' && modelSelection) process.env.CLOUDCLI_CODEX_RUNTIME_MODE = 'sdk';
    const calls: Array<{ method: string; params: unknown }> = [];
    t.mock.method(codexAppServerTransport, 'request', async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { thread: { id: 'native-fork', path: forkPath } };
    });

    const result = await sessionsService.forkSessionById('source', { upToAnchorId: 'turn-b' });
    const inherited = runtime === 'app-server' ? modelSelection : undefined;
    assert.deepEqual(calls, [{ method: 'thread/fork', params: {
      threadId: 'native-source', lastTurnId: 'turn-b', cwd: directory,
      ...(inherited ? { modelProvider: inherited.modelProvider, ...(inherited.model ? { model: inherited.model } : {}) } : {}),
    } }]);
    const child = sessionsDb.getSessionById(result.sessionId)!;
    assert.equal(child.provider_session_id, 'native-fork');
    assert.equal(child.forked_from_session_id, 'source');
    assert.equal(child.effort, 'high');
    assert.deepEqual(sessionRuntimeDb.get(result.sessionId), {
      runtime: 'app-server', mode: 'default', queueHeld: false,
      ...(inherited ? { modelSelection: inherited } : {}),
    });
    assert.deepEqual(sessionRuntimeDb.get('source'), sourceSettings);
    assert.equal(sessionsDb.getSessionById('source')?.provider_session_id, 'native-source');
  });
}
