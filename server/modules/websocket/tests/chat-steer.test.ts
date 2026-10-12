import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord } from '@/shared/types.js';

async function withGateway(check: (context: { socket: EventEmitter; frames: AnyRecord[]; calls: AnyRecord[] }) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chat-steer-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const frames: AnyRecord[] = [];
  const calls: AnyRecord[] = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: (data: string) => frames.push(JSON.parse(data)) });
  try {
    sessionsDb.createAppSession('app-steer', 'codex', directory);
    chatRunRegistry.startRun({ appSessionId: 'app-steer', provider: 'codex', providerSessionId: 'native-thread', connection: socket as never, userId: 1 });
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: {
      hasRuntime: () => true,
      async steer(provider: string, sessionId: string, content: string, options: AnyRecord) { calls.push({ provider, sessionId, content, options }); return true; },
    } as never });
    await check({ socket, frames, calls });
  } finally {
    connectedClients.clear(); chatRunRegistry.clearAll(); closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('chat.steer routes through the session provider and filters attachments without completing its run', async () => {
  await withGateway(async ({ socket, frames, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: 'app-steer', provider: 'claude', content: 'change direction', options: { model: 'ignored', attachments: [{ path: '/etc/passwd', mimeType: 'text/plain' }] } }));
    await settle();
    assert.deepEqual(calls, [{ provider: 'codex', sessionId: 'app-steer', content: 'change direction', options: { images: [], files: [] } }]);
    assert.equal(chatRunRegistry.isProcessing('app-steer'), true);
    assert.deepEqual(frames, []);
  });
});

test('steer arriving after completion does not start a replacement turn', async () => {
  await withGateway(async ({ socket, frames, calls }) => {
    chatRunRegistry.completeRun('app-steer', { exitCode: 0 });
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: 'app-steer', content: 'late' }));
    await settle();
    assert.deepEqual(calls, []);
    assert.equal(frames.at(-1)?.code, 'STEER_NO_ACTIVE_RUN');
    assert.equal(chatRunRegistry.isProcessing('app-steer'), false);
  });
});

test('empty steer is rejected and leaves the active run processing', async () => {
  await withGateway(async ({ socket, frames, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: 'app-steer', content: ' ' }));
    await settle();
    assert.deepEqual(calls, []);
    assert.equal(frames.at(-1)?.code, 'STEER_EMPTY_INPUT');
    assert.equal(chatRunRegistry.isProcessing('app-steer'), true);
  });
});
