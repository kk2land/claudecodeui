import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  clearAndroidShareInsertionError,
  enqueueAndroidShareInsertion,
  registerAndroidShareInsertionHandler,
  subscribeAndroidShareInsertionError,
} from '@/modules/android-bridge/shareInsertion';
import type { AndroidBridge, AndroidShare } from '@/shared/types';

type BridgeWindow = Window & { cloudcliAndroid?: unknown };

const SHARE: AndroidShare = {
  id: 'share-1',
  kind: 'text',
  text: 'from Android',
  name: null,
  mimeType: null,
  size: null,
  createdAt: Date.now(),
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const createBridge = (consumeShare: AndroidBridge['consumeShare']): AndroidBridge => ({
  version: 1,
  getState: async () => ({
    version: 1,
    siteOrigin: 'https://cloud.example.com',
    webBridgeReady: true,
    signedIn: true,
    notificationsEnabled: false,
    serviceRunning: false,
    connected: false,
    lastError: null,
    pendingShareCount: 0,
  }),
  notify: async () => ({ shown: true }),
  setNotificationsEnabled: async (enabled) => ({
    version: 1,
    siteOrigin: 'https://cloud.example.com',
    webBridgeReady: true,
    signedIn: true,
    notificationsEnabled: enabled,
    serviceRunning: enabled,
    connected: false,
    lastError: null,
    pendingShareCount: 0,
  }),
  getSession: async () => null,
  saveSession: async () => ({ accepted: true }),
  clearSession: async () => undefined,
  listShares: async () => [],
  getShareContent: async () => ({ name: 'a.txt', mimeType: 'text/plain', size: 1, blob: new Blob(['a']) }),
  consumeShare,
  discardShare: async () => undefined,
  pickFiles: async () => [],
  saveFile: async () => ({ saved: true }),
});

beforeEach(() => {
  clearAndroidShareInsertionError();
});

afterEach(() => {
  delete (window as BridgeWindow).cloudcliAndroid;
});

test('a share is consumed only after the composer reports a successful insertion', async () => {
  const consumeShare = vi.fn(async (_shareId: string) => undefined);
  (window as BridgeWindow).cloudcliAndroid = createBridge(consumeShare);
  const handler = vi.fn(async () => ({ ok: true as const }));
  const unregister = registerAndroidShareInsertionHandler('session-1', handler);

  enqueueAndroidShareInsertion(SHARE, 'session-1');
  await flush();

  assert.equal(handler.mock.calls.length, 1);
  assert.equal(consumeShare.mock.calls.length, 1);
  assert.equal(consumeShare.mock.calls[0][0], 'share-1');
  unregister();
});

test('a failed insertion keeps the native share pending and reports the reason', async () => {
  const consumeShare = vi.fn(async (_shareId: string) => undefined);
  (window as BridgeWindow).cloudcliAndroid = createBridge(consumeShare);
  const errors: (string | null)[] = [];
  const unsubscribe = subscribeAndroidShareInsertionError((message) => errors.push(message));
  const unregister = registerAndroidShareInsertionHandler('session-1', async () => ({
    ok: false,
    error: 'The composer cannot accept this file.',
  }));

  enqueueAndroidShareInsertion(SHARE, 'session-1');
  await flush();

  assert.equal(consumeShare.mock.calls.length, 0);
  assert.equal(errors.at(-1), 'The composer cannot accept this file.');
  unsubscribe();
  unregister();
});
