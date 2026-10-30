import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  onPluginExit,
  onPluginMessage,
  onPluginReady,
  sendPluginMessage,
  startPluginServer,
  stopPluginServer,
} from '../plugin-process.service.js';

/**
 * Real child-process fixture: the plugin reports ready on stdout and answers
 * on the Node IPC channel exactly like the bundled Worker server will.
 */
test('a plugin server exchanges IPC messages and reports ready/exit lifecycle', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-ipc-'));
  fs.writeFileSync(path.join(directory, 'server.mjs'), `
    console.log(JSON.stringify({ ready: true, port: 45123 }));
    process.on('message', (message) => {
      process.send({ echo: message, channel: message.channel, id: message.id });
    });
    process.on('SIGTERM', () => process.exit(0));
  `);
  t.after(async () => {
    await stopPluginServer('fixture-ipc');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const messages: unknown[] = [];
  let ready = false;
  let exited = false;
  const unsubscribeMessage = onPluginMessage('fixture-ipc', (message: unknown) => messages.push(message));
  const unsubscribeReady = onPluginReady('fixture-ipc', () => { ready = true; });
  const unsubscribeExit = onPluginExit('fixture-ipc', () => { exited = true; });
  t.after(() => { unsubscribeMessage(); unsubscribeReady(); unsubscribeExit(); });

  const port = await startPluginServer('fixture-ipc', directory, 'server.mjs');
  assert.equal(port, 45123);
  assert.equal(ready, true);
  assert.equal(sendPluginMessage('fixture-ipc', {
    channel: 'cloudcli-workers', id: '1', kind: 'request', action: 'closeAll', payload: { reason: 'test' },
  }), true);
  for (let index = 0; index < 100 && messages.length === 0; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { channel: string }).channel, 'cloudcli-workers');

  await stopPluginServer('fixture-ipc');
  assert.equal(exited, true);
  assert.equal(sendPluginMessage('fixture-ipc', { ping: true }), false);
});
