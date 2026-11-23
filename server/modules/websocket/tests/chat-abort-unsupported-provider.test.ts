import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord, ProviderRuntimeGateway } from '@/shared/index.js';

/**
 * A retired provider's row outlives the provider itself, so Stop must answer
 * that the provider is unavailable instead of asking the runtime router for
 * state it cannot resolve (which surfaces as a generic INTERNAL_ERROR).
 */
test('chat.abort refuses a retired provider session before reading runtime state', async () => {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'chat-abort-unsupported-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  chatRunRegistry.clearAll();

  const userId = Number(userDb.createUser('abort-unsupported', 'hash').id);
  sessionsDb.createAppSession('retired-dsh-session', 'dsh', root, 'Retired DSH');
  sessionsDb.createAppSession('live-claude-session', 'claude', root, 'Live Claude');

  const stateReads: string[] = [];
  const runtime = {
    hasRuntime: (provider: string) => provider === 'claude',
    hasBackgroundWork: () => false,
    getState(provider: string) {
      stateReads.push(provider);
      return undefined;
    },
    isQueueBlocked: () => false,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    async abort() {
      throw new Error('abort must not run for an unavailable provider');
    },
    async run() {
      return undefined;
    },
  } as unknown as ProviderRuntimeGateway;

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

  const send = (data: AnyRecord) => socket.emit('message', JSON.stringify(data));
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(predicate(), 'condition did not become true');
  };

  try {
    send({ type: 'chat.abort', sessionId: 'retired-dsh-session', requestId: 'stop-retired' });
    await waitFor(() => frames.some((frame) => frame.kind === 'protocol_error'));

    const retired = frames.find((frame) => frame.kind === 'protocol_error');
    assert.ok(retired);
    assert.equal(retired.code, 'UNSUPPORTED_PROVIDER');
    assert.equal(retired.sessionId, 'retired-dsh-session');
    // The router was never asked for state it cannot resolve.
    assert.deepEqual(stateReads, []);
    assert.equal(frames.some((frame) => frame.code === 'INTERNAL_ERROR'), false);

    // A missing session keeps its previous answer: there is no run to stop.
    frames.length = 0;
    send({ type: 'chat.abort', sessionId: 'missing-session', requestId: 'stop-missing' });
    await waitFor(() => frames.length > 0);
    assert.equal(frames[0].kind, 'protocol_error');
    assert.equal(frames[0].code, 'NO_ACTIVE_RUN');
    assert.equal(frames[0].sessionId, 'missing-session');

    // A live provider with no run keeps answering NO_ACTIVE_RUN and may be
    // asked for state, exactly as before.
    frames.length = 0;
    send({ type: 'chat.abort', sessionId: 'live-claude-session', requestId: 'stop-idle' });
    await waitFor(() => frames.length > 0);
    assert.equal(frames[0].kind, 'protocol_error');
    assert.equal(frames[0].code, 'NO_ACTIVE_RUN');
    assert.equal(frames[0].sessionId, 'live-claude-session');
    assert.deepEqual(stateReads, ['claude']);
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
