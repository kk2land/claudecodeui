import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import { getAndroidBridge, isAndroidBridgeErrorCode } from '@/modules/android-bridge/androidBridge';
import { saveBlob } from '@/modules/android-bridge/saveBlob';
import type { AndroidBridge } from '@/shared/types';

type BridgeWindow = Window & { cloudcliAndroid?: unknown };

const clearInjectedBridge = () => {
  delete (window as BridgeWindow).cloudcliAndroid;
};

afterEach(() => {
  clearInjectedBridge();
  vi.unstubAllGlobals();
});

const createBridge = (overrides: Partial<AndroidBridge> = {}): AndroidBridge => ({
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
  consumeShare: async () => undefined,
  discardShare: async () => undefined,
  pickFiles: async () => [],
  saveFile: async () => ({ saved: true }),
  ...overrides,
});

test('a version-1 bridge is accepted only when every public method exists', () => {
  (window as BridgeWindow).cloudcliAndroid = createBridge();
  assert.ok(getAndroidBridge());

  (window as BridgeWindow).cloudcliAndroid = { ...createBridge(), saveFile: undefined };
  assert.equal(getAndroidBridge(), null);

  (window as BridgeWindow).cloudcliAndroid = { ...createBridge(), version: 2 };
  assert.equal(getAndroidBridge(), null);
});

test('an ordinary browser has no bridge and keeps the anchor download fallback', async () => {
  clearInjectedBridge();
  const createObjectURL = vi.fn(() => 'blob:test');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
  const click = vi.fn();
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
    const element = originalCreateElement(tagName);
    if (tagName === 'a') {
      element.click = click;
    }
    return element;
  });

  assert.equal(getAndroidBridge(), null);
  assert.equal(await saveBlob(new Blob(['zip'], { type: 'application/zip' }), 'folder.zip'), true);
  assert.equal(createObjectURL.mock.calls.length, 1);
  assert.equal(click.mock.calls.length, 1);

  // The shared helper revokes on a later task so Firefox and Safari can read
  // the object URL after click(); let it run while the URL stub is installed.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(revokeObjectURL.mock.calls.length, 1);
});

test('saveBlob uses the native picker and treats cancellation as a quiet false', async () => {
  const saveFile = vi.fn()
    .mockResolvedValueOnce({ saved: true })
    .mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'AndroidBridgeError', code: 'CANCELLED' }));
  (window as BridgeWindow).cloudcliAndroid = createBridge({ saveFile });

  assert.equal(await saveBlob(new Blob(['a']), 'a.txt'), true);
  assert.equal(await saveBlob(new Blob(['a']), 'a.txt'), false);
  assert.equal(saveFile.mock.calls.length, 2);
  assert.equal(saveFile.mock.calls[0][0].name, 'a.txt');
});

test('bridge error codes are readable without losing the message', () => {
  const error = Object.assign(new Error('permission denied'), { code: 'PERMISSION_DENIED' });
  assert.equal(isAndroidBridgeErrorCode(error, 'PERMISSION_DENIED'), true);
  assert.equal(isAndroidBridgeErrorCode(error, 'CANCELLED'), false);
  assert.equal(isAndroidBridgeErrorCode(new Error('plain'), 'CANCELLED'), false);
});
