import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import type { WorkerIpcTransport } from '@/shared/index.js';
import { WorkerIpcClient } from '../worker-ipc.client.js';

/**
 * Exercises the real Node child-process IPC channel rather than a mocked
 * message bus. The child implements only the fixed envelope responses used by
 * the host bridge.
 */
const fixture = `
const send = (message) => { if (process.connected) process.send(message); };
process.on('message', (message) => {
  if (!message || message.channel !== 'cloudcli-workers') return;
  if (message.action === 'registerOwner') {
    send({ channel: 'cloudcli-workers', id: message.id, kind: 'response', ok: true, value: message.payload.owner });
    return;
  }
  if (message.action === 'listNotifications') {
    send({ channel: 'cloudcli-workers', id: message.id, kind: 'response', ok: true, value: [] });
    return;
  }
  send({ channel: 'cloudcli-workers', id: message.id, kind: 'response', ok: false, error: { code: 'UNKNOWN', message: 'unknown action' } });
});
`;

function childTransport(child: ReturnType<typeof spawn>): WorkerIpcTransport {
  let running = true;
  child.on('exit', () => { running = false; });
  return {
    isRunning: () => running,
    ensureReady: async () => true,
    send: (message) => {
      if (!child.connected) return false;
      child.send(message);
      return true;
    },
    onMessage: (listener) => {
      child.on('message', listener);
      return () => child.off('message', listener);
    },
    onExit: (listener) => {
      child.on('exit', listener);
      return () => child.off('exit', listener);
    },
    onReady: () => () => {},
  };
}

test('WorkerIpcClient completes a request over a real child IPC channel', async () => {
  const child = spawn(process.execPath, ['-e', fixture], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const client = new WorkerIpcClient(childTransport(child), 2_000);
  try {
    const owner = await client.request('registerOwner', {
      owner: {
        id: 'instance:session', parentSessionId: 'session', projectId: 'project', projectPath: '/repo',
        userId: null, appServerInstanceId: 'instance', paused: false,
      },
      token: 'owner-token',
    });
    assert.equal(owner.id, 'instance:session');
    assert.deepEqual(await client.request('listNotifications', {}), []);
  } finally {
    client.dispose();
    child.kill('SIGKILL');
  }
});

test('a plugin exit rejects an in-flight request instead of replaying it', async () => {
  const child = spawn(process.execPath, ['-e', fixture], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const transport = childTransport(child);
  const client = new WorkerIpcClient(transport, 5_000);
  try {
    const pending = client.request('claimNotifications', { ownerId: 'o', eventIds: [], batchId: 'b' });
    assert.ok(child.connected);
    child.kill('SIGKILL');
    await assert.rejects(pending, { code: 'WORKER_PLUGIN_DISCONNECTED' });
    await assert.rejects(
      client.request('listNotifications', {}),
      { code: 'WORKER_PLUGIN_UNAVAILABLE' },
    );
  } finally {
    client.dispose();
  }
});
