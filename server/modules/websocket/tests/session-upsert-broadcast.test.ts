import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  broadcastSessionUpserted,
  broadcastSessionUpsertedBatch,
} from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-upsert-broadcast-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('an upsert always carries the provider session id', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-1', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-1', 'native-1');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('app-1');

    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].kind, 'session_upserted');
    assert.equal(connection.frames[0].sessionId, 'app-1');
    assert.equal(connection.frames[0].providerSessionId, 'native-1');
  });
});

test('the watcher path resolves a provider-native id to the same canonical event', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-2', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-2', 'native-2');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    // The sessions watcher only ever knows the id written in the transcript.
    await broadcastSessionUpsertedBatch(['native-2']);

    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].sessionId, 'app-2');
    assert.equal(connection.frames[0].providerSessionId, 'native-2');
  });
});

test('a session with no provider id yet reports null rather than omitting the field', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-3', 'claude', '/workspace/demo');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('app-3');

    assert.equal(connection.frames.length, 1);
    assert.ok('providerSessionId' in connection.frames[0]);
    assert.equal(connection.frames[0].providerSessionId, null);
  });
});

test('an unresolvable id broadcasts nothing', async () => {
  await withIsolatedDatabase(async () => {
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('does-not-exist');
    await broadcastSessionUpsertedBatch(['also-missing']);

    assert.deepEqual(connection.frames, []);
  });
});

test('a batch delivers every resolvable session and skips the rest', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-4', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-5', 'claude', '/workspace/demo');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpsertedBatch(['app-4', 'missing', 'app-5']);

    assert.deepEqual(
      connection.frames.map((frame) => frame.sessionId),
      ['app-4', 'app-5'],
    );
  });
});

test('a closed socket is skipped', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-6', 'claude', '/workspace/demo');

    const open = new FakeConnection();
    const closing = new FakeConnection();
    closing.readyState = 3;
    connectedClients.add(open as never);
    connectedClients.add(closing as never);

    await broadcastSessionUpserted('app-6');

    assert.equal(open.frames.length, 1);
    assert.deepEqual(closing.frames, []);
  });
});

test('copied threads broadcast the requested app session independently of the other provider', async () => {
  await withIsolatedDatabase(async () => {
    const codexId = sessionsDb.createSession('shared-thread', 'codex', '/workspace/native');
    const dshId = sessionsDb.createSession('shared-thread', 'dsh', '/workspace/dsh', 'DSH', undefined, '2099-01-01T00:00:00Z');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpsertedBatch([codexId, dshId]);

    assert.deepEqual(connection.frames.map(frame => [frame.sessionId, frame.provider]), [
      [codexId, 'codex'], [dshId, 'dsh'],
    ]);
  });
});

test('retained GPT Web records are not broadcast into the sidebar', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('legacy-web', 'gptweb', '/workspace/legacy');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('legacy-web');

    assert.deepEqual(connection.frames, []);
    assert.ok(sessionsDb.getSessionById('legacy-web'));
  });
});

test('exec-origin Codex sessions are not broadcast while the app-server runtime owns the list', async () => {
  const previousRuntime = process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession('codex-sdk', 'codex', '/workspace/demo', 'SDK', undefined, undefined, '/tmp/sdk.jsonl', 'exec');
      sessionsDb.createSession('codex-native', 'codex', '/workspace/demo', 'Native', undefined, undefined, '/tmp/native.jsonl', 'vscode');
      const connection = new FakeConnection();
      connectedClients.add(connection as never);

      await broadcastSessionUpsertedBatch(['codex-sdk', 'codex-native']);
      await broadcastSessionUpserted('codex-sdk');

      assert.deepEqual(connection.frames.map((frame) => frame.sessionId), ['codex-native']);
      // The hidden row itself is still available for resume/history/delete.
      assert.equal(sessionsDb.getSessionById('codex-sdk')?.session_source, 'exec');
    });
  } finally {
    if (previousRuntime === undefined) delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
    else process.env.CLOUDCLI_CODEX_RUNTIME_MODE = previousRuntime;
  }
});

test('explicit SDK runtime broadcasts exec sessions again', async () => {
  const previousRuntime = process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  process.env.CLOUDCLI_CODEX_RUNTIME_MODE = 'sdk';
  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession('codex-sdk', 'codex', '/workspace/demo', 'SDK', undefined, undefined, '/tmp/sdk.jsonl', 'exec');
      const connection = new FakeConnection();
      connectedClients.add(connection as never);

      await broadcastSessionUpserted('codex-sdk');

      assert.deepEqual(connection.frames.map((frame) => frame.sessionId), ['codex-sdk']);
    });
  } finally {
    if (previousRuntime === undefined) delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
    else process.env.CLOUDCLI_CODEX_RUNTIME_MODE = previousRuntime;
  }
});
