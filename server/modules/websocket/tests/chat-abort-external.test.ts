import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionRuntimeDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord, ProviderRuntimeGateway } from '@/shared/index.js';

type Harness = {
  sessionId: string;
  /** The external run the scheduler started, used to assert its execution identity. */
  run: NonNullable<ReturnType<typeof chatRunRegistry.getRun>>;
  aborts: string[];
  frames: AnyRecord[];
  send(data: AnyRecord): void;
  waitFor(predicate: () => boolean): Promise<void>;
};

/**
 * One real WS chat connection over a session whose current run was started the
 * way the project scheduler prepares a scheduled prompt CLI run: registry run
 * flagged `external`, no native instance inside this server.
 */
async function harness(
  provider: 'codex' | 'dsh',
  runTest: (h: Harness) => Promise<void>,
): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), `chat-abort-external-${provider}-`));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  chatRunRegistry.clearAll();

  const sessionId = `external-abort-${provider}`;
  const userId = Number(userDb.createUser(`external-abort-${provider}`, 'hash').id);
  sessionsDb.createAppSession(sessionId, provider, root, 'Scheduled prompt run');

  const aborts: string[] = [];
  // No native state: the scheduled CLI run lives in the scheduler's own plugin
  // process, so a Stop from this server has nothing to abort.
  const runtime = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    getState: () => undefined,
    getManagedState: () => undefined,
    isQueueBlocked: () => false,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    async abort(_provider: string, id: string) {
      aborts.push(id);
      return true;
    },
    async run() {
      return undefined;
    },
  } as unknown as ProviderRuntimeGateway;

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: null,
    connection: null,
    userId: null,
    external: true,
    dispatch: {
      origin: 'detached',
      permissionMode: null,
      sandboxMode: null,
      model: null,
      effort: null,
      runtimeMode: null,
    },
  });
  assert.ok(run);

  const frames: AnyRecord[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send(text: string) {
      frames.push(JSON.parse(text) as AnyRecord);
    },
  });
  handleChatConnection(socket as never, { user: { id: userId } } as never, {
    runtime,
    notifyQueueChanged: () => undefined,
  });

  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(predicate(), 'condition did not become true');
  };

  try {
    await runTest({
      sessionId,
      run,
      aborts,
      frames,
      send(data) {
        socket.emit('message', JSON.stringify({ sessionId, ...data }));
      },
      waitFor,
    });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

// The guard is provider-neutral (it reads the registry's external flag), so one
// case per supported scheduled provider proves both providers share it.
for (const provider of ['codex', 'dsh'] as const) {
  test(`chat.abort refuses an external scheduled ${provider} run instead of reporting a Stop it cannot perform`, async () => {
    await harness(provider, async (h) => {
      h.send({ type: 'chat.abort', requestId: 'stop-external', executionId: h.run.executionId });
      await h.waitFor(() => h.frames.some((frame) => frame.kind === 'control_result'));

      const result = h.frames.find((frame) => frame.kind === 'control_result')!;
      assert.equal(result.sessionId, h.sessionId);
      assert.equal(result.requestId, 'stop-external');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'EXTERNAL_RUN');
      assert.match(String(result.error), /scheduled task/i);
      // The refusal settles the request instead of leaving Stop pending.
      assert.equal(h.frames.filter((frame) => frame.kind === 'control_result').length, 1);

      // No side effect ran: no native abort, no queue hold, same running run.
      assert.deepEqual(h.aborts, []);
      assert.equal(sessionRuntimeDb.get(h.sessionId).queueHeld, false);
      const snapshot = chatRunRegistry.getSnapshot(h.sessionId);
      assert.equal(snapshot?.status, 'running');
      assert.equal(snapshot?.executionId, h.run.executionId);
      assert.equal(chatRunRegistry.isExternalRun(h.sessionId), true);

      // The generic completion path used by chat.abort/queue interruption still
      // cannot end it; only the scheduler's own finish releases the run.
      chatRunRegistry.completeRunIfCurrent(h.run, { exitCode: 0, aborted: true });
      assert.equal(chatRunRegistry.getSnapshot(h.sessionId)?.status, 'running');
      assert.equal(
        chatRunRegistry.completeExternalRun(h.sessionId, h.run.executionId, { exitCode: 0, aborted: true }),
        true,
      );
      assert.equal(chatRunRegistry.getSnapshot(h.sessionId)?.status, 'completed');
      assert.equal(chatRunRegistry.getSnapshot(h.sessionId)?.aborted, true);
    });
  });
}
