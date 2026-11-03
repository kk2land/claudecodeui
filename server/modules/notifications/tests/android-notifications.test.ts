import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  notificationChannelEndpointsDb,
  notificationPreferencesDb,
} from '@/modules/database/index.js';
import {
  createNotificationEvent,
  handleAndroidNotificationsConnection,
  handleDesktopNotificationsConnection,
  notifyUserIfEnabled,
  sendNotificationToChannel,
} from '@/modules/notifications/index.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';

type Frame = Record<string, any>;

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    OPEN: number;
    frames: Frame[];
    closed: { code?: number; reason?: string } | null;
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
    terminate: () => void;
  };
  socket.readyState = 1;
  socket.OPEN = 1;
  socket.frames = [];
  socket.closed = null;
  socket.send = (data: string) => {
    const frame = JSON.parse(data) as Frame;
    socket.frames.push(frame);
    socket.emit('frame', frame);
  };
  socket.close = (code?: number, reason?: string) => {
    socket.closed = { code, reason };
    socket.readyState = 3;
    socket.emit('close');
  };
  socket.terminate = () => {
    socket.readyState = 3;
    socket.emit('close');
  };
  return socket;
}

const sendFrame = (socket: ReturnType<typeof createFakeSocket>, payload: Frame) => {
  socket.emit('message', Buffer.from(JSON.stringify(payload)));
};

const waitForFrame = (
  socket: ReturnType<typeof createFakeSocket>,
  matches: (frame: Frame) => boolean,
  timeoutMs = 2000,
) =>
  new Promise<Frame>((resolve, reject) => {
    const existing = socket.frames.find(matches);
    if (existing) {
      resolve(existing);
      return;
    }
    const timer = setTimeout(() => {
      socket.off('frame', onFrame);
      reject(new Error(`No matching frame within ${timeoutMs} ms.`));
    }, timeoutMs);
    const onFrame = (frame: Frame) => {
      if (!matches(frame)) return;
      clearTimeout(timer);
      socket.off('frame', onFrame);
      resolve(frame);
    };
    socket.on('frame', onFrame);
  });

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds an orchestrator event with a unique dedupe key. The JS factory types
 * its `dedupeKey = null` default as `null`, although a string is valid at runtime.
 */
const createDeliveryEvent = (dedupeKey: string) =>
  createNotificationEvent({
    provider: 'system',
    kind: 'info',
    code: 'generic.info',
    dedupeKey: dedupeKey as never,
  });

const payload = {
  title: 'CloudCLI',
  body: 'System: notification',
  data: {
    sessionId: null,
    code: 'generic.info',
    provider: 'system',
    sessionName: null,
    tag: 'system:none:generic.info',
  },
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'android-notifications-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  // Notification tables reference users; the handlers only receive a user id.
  const db = getConnection();
  for (const userId of [1, 2, 7]) {
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(userId, `user-${userId}`, 'not-a-real-hash');
  }

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('android registration stores the android endpoint and replies once', async () => {
  await withIsolatedDatabase(() => {
    const ws = createFakeSocket();
    handleAndroidNotificationsConnection(ws as never, { user: { id: 1 } } as never);

    sendFrame(ws, {
      type: 'register',
      deviceId: 'android-device-1',
      label: 'Android',
      platform: 'android',
      appVersion: '1.0',
    });

    assert.deepEqual(ws.frames.at(-1), {
      type: 'registered',
      deviceId: 'android-device-1',
      enabled: true,
    });

    const endpoints = notificationChannelEndpointsDb.getEndpoints(1, 'android');
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].channel, 'android');
    assert.equal(endpoints[0].label, 'Android');
    assert.deepEqual(notificationChannelEndpointsDb.parseMetadata(endpoints[0].metadata_json), {
      platform: 'android',
      appVersion: '1.0',
    });

    // A second register, an acknowledgement and an unknown message are ignored.
    sendFrame(ws, { type: 'register', deviceId: 'android-device-2' });
    sendFrame(ws, { type: 'notification_ack', id: 'tag-1', action: 'shown' });
    sendFrame(ws, { type: 'mystery' });

    assert.equal(ws.frames.filter((frame) => frame.type === 'registered').length, 1);
    assert.equal(notificationChannelEndpointsDb.getEndpoints(1, 'android').length, 1);
  });
});

test('android registration rejects a missing deviceId exactly like desktop', async () => {
  await withIsolatedDatabase(() => {
    const androidSocket = createFakeSocket();
    handleAndroidNotificationsConnection(androidSocket as never, { user: { id: 1 } } as never);
    sendFrame(androidSocket, { type: 'register', deviceId: '   ' });

    assert.deepEqual(androidSocket.frames.at(-1), {
      type: 'error',
      code: 'DEVICE_ID_REQUIRED',
      message: 'Android notification registration requires deviceId.',
    });
    assert.deepEqual(androidSocket.closed, { code: 1008, reason: 'Missing deviceId' });

    const desktopSocket = createFakeSocket();
    handleDesktopNotificationsConnection(desktopSocket as never, { user: { id: 1 } } as never);
    sendFrame(desktopSocket, { type: 'register' });

    assert.deepEqual(desktopSocket.frames.at(-1), {
      type: 'error',
      code: 'DEVICE_ID_REQUIRED',
      message: 'Desktop notification registration requires deviceId.',
    });
    assert.deepEqual(desktopSocket.closed, { code: 1008, reason: 'Missing deviceId' });
  });
});

test('closing an android socket unregisters it from delivery', async () => {
  await withIsolatedDatabase(async () => {
    const ws = createFakeSocket();
    handleAndroidNotificationsConnection(ws as never, { user: { id: 1 } } as never);
    sendFrame(ws, { type: 'register', deviceId: 'android-device-1' });
    await waitForFrame(ws, (frame) => frame.type === 'registered');

    assert.deepEqual(sendNotificationToChannel(1, payload, 'android'), { attempted: 1, sent: 1 });

    ws.close(1000, 'done');
    assert.deepEqual(sendNotificationToChannel(1, payload, 'android'), { attempted: 0, sent: 0 });
  });
});

test('a newer android socket replaces the older socket for the same device', async () => {
  await withIsolatedDatabase(() => {
    const first = createFakeSocket();
    handleAndroidNotificationsConnection(first as never, { user: { id: 1 } } as never);
    sendFrame(first, { type: 'register', deviceId: 'shared-device' });

    const second = createFakeSocket();
    handleAndroidNotificationsConnection(second as never, { user: { id: 1 } } as never);
    sendFrame(second, { type: 'register', deviceId: 'shared-device' });

    assert.deepEqual(first.closed, { code: 4000, reason: 'Device reconnected' });
    assert.equal(second.frames.filter((frame) => frame.type === 'registered').length, 1);

    sendNotificationToChannel(1, payload, 'android');
    assert.equal(second.frames.filter((frame) => frame.type === 'notification').length, 1);
  });
});

test('android delivery is isolated by user, channel and enabled endpoints', async () => {
  await withIsolatedDatabase(() => {
    const android = createFakeSocket();
    handleAndroidNotificationsConnection(android as never, { user: { id: 1 } } as never);
    sendFrame(android, { type: 'register', deviceId: 'same-device' });

    const desktop = createFakeSocket();
    handleDesktopNotificationsConnection(desktop as never, { user: { id: 1 } } as never);
    sendFrame(desktop, { type: 'register', deviceId: 'same-device' });

    const otherUser = createFakeSocket();
    handleAndroidNotificationsConnection(otherUser as never, { user: { id: 2 } } as never);
    sendFrame(otherUser, { type: 'register', deviceId: 'same-device' });

    assert.equal(notificationChannelEndpointsDb.getEndpoints(1, 'desktop').length, 1);
    assert.equal(notificationChannelEndpointsDb.getEndpoints(2, 'android').length, 1);

    assert.deepEqual(sendNotificationToChannel(1, payload, 'android'), { attempted: 1, sent: 1 });
    assert.equal(android.frames.filter((frame) => frame.type === 'notification').length, 1);
    assert.equal(desktop.frames.filter((frame) => frame.type === 'notification').length, 0);
    assert.equal(otherUser.frames.filter((frame) => frame.type === 'notification').length, 0);

    notificationChannelEndpointsDb.setEndpointEnabled(1, 'android', 'same-device', false);
    assert.deepEqual(sendNotificationToChannel(1, payload, 'android'), { attempted: 0, sent: 0 });
    assert.equal(android.frames.filter((frame) => frame.type === 'notification').length, 1);
  });
});

test('notification preferences persist channels.android and default it to false', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(notificationPreferencesDb.getPreferences(1).channels.android, false);

    const stored = notificationPreferencesDb.updatePreferences(1, {
      channels: { android: true, desktop: false },
      events: { stop: true },
    });
    assert.equal(stored.channels.android, true);
    assert.equal(stored.channels.desktop, false);
    assert.equal(notificationPreferencesDb.getPreferences(1).channels.android, true);
  });
});

test('the orchestrator delivers to android only when channels.android is enabled', async () => {
  await withIsolatedDatabase(async () => {
    const android = createFakeSocket();
    handleAndroidNotificationsConnection(android as never, { user: { id: 1 } } as never);
    sendFrame(android, { type: 'register', deviceId: 'android-device-1' });

    notificationPreferencesDb.updatePreferences(1, {
      channels: { android: false },
      events: { actionRequired: true, stop: true, error: true },
    });
    notifyUserIfEnabled({
      userId: 1,
      event: createDeliveryEvent('android-disabled-1'),
    });
    await delay(30);
    assert.equal(android.frames.filter((frame) => frame.type === 'notification').length, 0);

    notificationPreferencesDb.updatePreferences(1, {
      channels: { android: true },
      events: { actionRequired: true, stop: true, error: true },
    });
    notifyUserIfEnabled({
      userId: 1,
      event: createDeliveryEvent('android-enabled-1'),
    });
    const frame = await waitForFrame(android, (candidate) => candidate.type === 'notification');
    assert.equal(frame.payload.title, 'CloudCLI');
    assert.equal(frame.payload.data.code, 'generic.info');
    assert.equal(frame.id, frame.payload.data.tag);
  });
});

test('desktop delivery keeps its existing behavior and channel isolation', async () => {
  await withIsolatedDatabase(async () => {
    const desktop = createFakeSocket();
    handleDesktopNotificationsConnection(desktop as never, { user: { id: 1 } } as never);
    sendFrame(desktop, { type: 'register', deviceId: 'desktop-device-1' });

    notificationPreferencesDb.updatePreferences(1, {
      channels: { desktop: true, android: false },
      events: { actionRequired: true, stop: true, error: true },
    });
    notifyUserIfEnabled({
      userId: 1,
      event: createDeliveryEvent('desktop-enabled-1'),
    });
    const frame = await waitForFrame(desktop, (candidate) => candidate.type === 'notification');
    assert.equal(frame.payload.data.tag, 'system:none:generic.info');

    assert.deepEqual(sendNotificationToChannel(1, payload, 'android'), { attempted: 0, sent: 0 });
  });
});

test('the websocket gateway routes /android-notifications into the android handler', async () => {
  await withIsolatedDatabase(async () => {
    const httpServer = createServer();
    const wss = createWebSocketServer(httpServer, {
      verifyClient: {
        isPlatform: true,
        authenticateWebSocket: () => ({ id: 7, username: 'route-test' }),
      },
      chat: {} as never,
      shell: {} as never,
      getPluginPort: () => 0,
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;

    const client = new WebSocket(`ws://127.0.0.1:${port}/android-notifications`);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('android websocket did not open')), 5000);
        client.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        client.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      const registered = await new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no registered frame')), 5000);
        client.on('message', (data) => {
          const frame = JSON.parse(data.toString()) as Frame;
          if (frame.type !== 'registered') return;
          clearTimeout(timer);
          resolve(frame);
        });
        client.send(JSON.stringify({
          type: 'register',
          deviceId: 'routed-android-device',
          label: 'Android',
          platform: 'android',
        }));
      });

      assert.deepEqual(registered, {
        type: 'registered',
        deviceId: 'routed-android-device',
        enabled: true,
      });

      const androidEndpoints = notificationChannelEndpointsDb.getEndpoints(7, 'android');
      assert.equal(androidEndpoints.length, 1);
      assert.equal(androidEndpoints[0].endpoint_id, 'routed-android-device');
      assert.equal(notificationChannelEndpointsDb.getEndpoints(7, 'desktop').length, 0);
    } finally {
      client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
