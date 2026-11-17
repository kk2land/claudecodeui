import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * gateway writer forwards so assertions can inspect the outbound protocol.
 */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-registry-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('live events are remapped to the app session id and sequenced', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-1',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: 'user-1',
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'provider-id-9', content: 'hello' });
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'provider-id-9', content: 'hello world' });

    assert.equal(connection.frames.length, 2);
    assert.equal(connection.frames[0]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[0]?.seq, 1);
    assert.equal(connection.frames[1]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[1]?.seq, 2);
  });
});

test('session_created is swallowed and persisted as the provider-id mapping', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-run-2', 'cursor', '/workspace/demo');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-2',
      provider: 'cursor',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'cursor',
      sessionId: 'cursor-native-7',
      newSessionId: 'cursor-native-7',
    });

    // The upsert is broadcast without blocking the run: resolving the owning
    // project's display name is async, so let that settle before asserting.
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // The provider-native event itself is never forwarded...
    const sessionUpserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.equal(sessionUpserts.length, 1);
    assert.equal(sessionUpserts[0]?.sessionId, 'app-run-2');
    assert.equal(sessionUpserts[0]?.providerSessionId, 'cursor-native-7');
    // ...but the canonical mapping is recorded and persisted in the database.
    assert.equal(run.providerSessionId, 'cursor-native-7');
    assert.equal(sessionsDb.getSessionById('app-run-2')?.provider_session_id, 'cursor-native-7');
  });
});

test('complete marks the run finished and duplicate completes are dropped', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-3', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-3',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 0 });
    // Late duplicate from a killed runtime's exit handler.
    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 1 });

    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.actualSessionId, 'app-run-3');
    assert.equal(chatRunRegistry.isProcessing('app-run-3'), false);

    // completeRun is also a no-op once the run already completed.
    chatRunRegistry.completeRun('app-run-3', { exitCode: 1 });
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
  });
});

test('a finished run\'s safety net cannot complete the session\'s next run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-9', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const firstRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(firstRun);
    firstRun.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-9', exitCode: 0 });

    // A queued message starts the next run before the first run's runtime
    // promise settles (the chat handler's `finally` hasn't executed yet).
    const secondRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(secondRun);

    // First run's safety net fires late: it must not touch the new run.
    chatRunRegistry.completeRunIfCurrent(firstRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), true);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);

    // The second run's own safety net still works while it is current.
    chatRunRegistry.completeRunIfCurrent(secondRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), false);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 2);
  });
});

test('listRunningRuns returns only currently running app sessions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-7', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-run-8', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const completedRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-7',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(completedRun);

    const runningRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-8',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(runningRun);

    chatRunRegistry.completeRun('app-run-7', { exitCode: 0 });

    const runningSessions = chatRunRegistry.listRunningRuns();
    assert.deepEqual(runningSessions.map((session) => session.sessionId), ['app-run-8']);
    assert.equal(runningSessions[0]?.provider, 'codex');
  });
});

test('replayEvents returns only events after the requested seq', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-4',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'c' });

    const replayed = chatRunRegistry.replayEvents('app-run-4', 1);
    assert.deepEqual(replayed.map((event) => event.content), ['b', 'c']);
    assert.deepEqual(replayed.map((event) => event.seq), [2, 3]);
  });
});

test('replay retains the first and latest full snapshots without retaining every growing copy', async () => {
  await withIsolatedDatabase(() => {
    const run = chatRunRegistry.startRun({
      appSessionId: 'snapshot-memory', provider: 'codex', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    let content = '';
    for (let index = 0; index < 1000; index++) {
      content += '内容'.repeat(64);
      run.writer.send({ kind: 'thinking', id: 'reasoning', provider: 'codex', content });
    }

    const replay = chatRunRegistry.replayEvents('snapshot-memory', 0);
    assert.equal(replay.at(-1)?.content, content);
    assert.deepEqual(replay.map((event) => event.seq), [1, 1000]);
    assert.ok(replay.reduce((total, event) => total + (event.content?.length ?? 0), 0) <= content.length + 128);
    assert.deepEqual(chatRunRegistry.replayEvents('snapshot-memory', 500).map((event) => event.content), [content]);
  });
});

test('compacted snapshot replay preserves message order, live delivery and interleaved controls', async () => {
  await withIsolatedDatabase(() => {
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'snapshot-order', provider: 'codex', providerSessionId: null, connection, userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'text', id: 'reply', provider: 'codex', content: 'first' });
    run.writer.send({ kind: 'tool_use', id: 'command', provider: 'codex', toolId: 'command', toolName: 'Bash' });
    run.writer.send({ kind: 'text', id: 'reply', provider: 'codex', content: 'first update' });
    run.writer.send({ kind: 'permission_request', id: 'approval', provider: 'codex', requestId: 'approval' });
    run.writer.send({ kind: 'text', id: 'reply', provider: 'codex', content: 'first update finished' });
    run.writer.send({ kind: 'permission_resolved', id: 'approval', provider: 'codex', requestId: 'approval' });

    assert.deepEqual(connection.frames.map((frame) => frame.seq), [1, 2, 3, 4, 5, 6]);
    const replay = chatRunRegistry.replayEvents('snapshot-order', 0);
    assert.deepEqual(replay.map((event) => event.seq), [1, 2, 4, 5, 6]);
    // Applying these frames by message id leaves the reply before its tool card.
    const rows = new Map<string, string | undefined>();
    for (const event of replay) if (event.kind === 'text' || event.kind === 'tool_use') rows.set(event.id, event.content);
    assert.deepEqual([...rows], [['reply', 'first update finished'], ['command', undefined]]);
    assert.deepEqual(chatRunRegistry.replayEvents('snapshot-order', 3).map((event) => event.seq), [4, 5, 6]);
  });
});

test('interleaved tool snapshots keep only the first and latest state of each row', async () => {
  await withIsolatedDatabase(() => {
    const run = chatRunRegistry.startRun({
      appSessionId: 'snapshot-tool', provider: 'codex', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    for (let index = 1; index <= 1000; index++) {
      run.writer.send({ kind: 'tool_use', id: 'command', provider: 'codex', toolId: 'command', toolName: 'Bash',
        status: index === 1000 ? 'completed' : 'in_progress' });
      // A provider may use the same id for a tool call and its result.
      run.writer.send({ kind: 'tool_result', id: 'command', provider: 'codex', toolId: 'command', content: `output ${index}` });
    }

    const replay = chatRunRegistry.replayEvents('snapshot-tool', 0);
    assert.deepEqual(replay.map((event) => event.seq), [1, 2, 1999, 2000]);
    assert.equal(replay.at(-2)?.status, 'completed');
    assert.equal(replay.at(-1)?.content, 'output 1000');
  });
});

test('delta and control events sharing an id remain complete and ordered', async () => {
  await withIsolatedDatabase(() => {
    const run = chatRunRegistry.startRun({
      appSessionId: 'delta-replay', provider: 'claude', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    for (const content of ['a', 'b', 'c']) {
      run.writer.send({ kind: 'stream_delta', id: 'reply', provider: 'claude', content });
    }
    run.writer.send({ kind: 'stream_end', id: 'reply', provider: 'claude' });
    run.writer.send({ kind: 'status', id: 'status', provider: 'claude', text: 'working' });
    run.writer.send({ kind: 'status', id: 'status', provider: 'claude', text: 'done' });

    const replay = chatRunRegistry.replayEvents('delta-replay', 0);
    assert.deepEqual(replay.map((event) => event.seq), [1, 2, 3, 4, 5, 6]);
    assert.equal(replay.slice(0, 3).map((event) => event.content).join(''), 'abc');
  });
});

test('snapshot compaction remains bounded and replayable after the event cap evicts an anchor', async () => {
  await withIsolatedDatabase(() => {
    const run = chatRunRegistry.startRun({
      appSessionId: 'snapshot-cap', provider: 'codex', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    for (let index = 0; index < 5000; index++) {
      run.writer.send({ kind: 'text', id: `reply-${index}`, provider: 'codex', content: `message ${index}` });
    }
    for (const content of ['updated', 'updated again', 'finished']) {
      run.writer.send({ kind: 'text', id: 'reply-0', provider: 'codex', content });
    }

    const replay = chatRunRegistry.replayEvents('snapshot-cap', 0);
    assert.equal(replay.length, 5000);
    assert.deepEqual(replay.filter((event) => event.id === 'reply-0').map((event) => event.seq), [5001, 5003]);
    assert.equal(replay.at(-1)?.content, 'finished');
    assert.deepEqual(chatRunRegistry.replayEvents('snapshot-cap', 5001).map((event) => event.content), ['finished']);
  });
});

test('outbound JSON is serialized once for live subscribers and skipped for detached or closed sockets', async () => {
  await withIsolatedDatabase(() => {
    const run = chatRunRegistry.startRun({
      appSessionId: 'lazy-json', provider: 'codex', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    let serializations = 0;
    const message = { kind: 'tool_use', id: 'command', provider: 'codex', toolInput: {
      toJSON() { serializations++; return { command: 'echo hello' }; },
    } };
    run.writer.send(message);
    assert.equal(serializations, 0);
    assert.equal(chatRunRegistry.replayEvents('lazy-json', 0).length, 1);

    const closed = new FakeConnection();
    closed.readyState = 3;
    chatRunRegistry.attachConnection('lazy-json', closed);
    run.writer.send(message);
    assert.equal(serializations, 0);

    const first = new FakeConnection();
    const second = new FakeConnection();
    chatRunRegistry.attachConnection('lazy-json', first);
    chatRunRegistry.attachConnection('lazy-json', second);
    run.writer.send(message);
    assert.equal(serializations, 1);
    assert.deepEqual(first.frames, second.frames);
    assert.deepEqual(closed.frames, []);
  });
});

test('attachConnection adds a socket without cutting off the ones already watching', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5', 'opencode', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5',
      provider: 'opencode',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'before' });

    // A second tab on the same session subscribes mid-run.
    const secondConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5', secondConnection), true);
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });

    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['before', 'after']);
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), ['after']);
  });
});

test('a refreshed tab stops receiving once its old socket is closed', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5b', 'opencode', '/workspace/demo');
    const staleConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5b',
      provider: 'opencode',
      providerSessionId: null,
      connection: staleConnection,
      userId: null,
    });
    assert.ok(run);

    // The page reloads: the original socket closes and the fresh one subscribes.
    staleConnection.readyState = 3;
    const reloadedConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5b', reloadedConnection), true);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'later' });

    assert.deepEqual(staleConnection.frames, []);
    assert.deepEqual(reloadedConnection.frames.map((frame) => frame.content), ['after', 'later']);
  });
});

test('startRun rejects a second concurrent run for the same session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'opencode', '/workspace/demo');
    const connection = new FakeConnection();
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(first);

    const second = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.equal(second, null);

    // After the run finishes a new one is allowed again.
    chatRunRegistry.completeRun('app-run-6', { exitCode: 0 });
    const third = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(third);
  });
});
