import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import type { AndroidBridge } from '@/shared/types';

type BridgeWindow = Window & { cloudcliAndroid?: unknown };

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const createToken = (offsetSeconds: number): string => {
  const now = Math.floor(Date.now() / 1000) + offsetSeconds;
  return `${base64url({ alg: 'none' })}.${base64url({ iat: now, exp: now + 3600 })}.signature`;
};

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const nativeAddEventListener = window.addEventListener.bind(window);
const bridgeListeners: { type: string; listener: EventListenerOrEventListenerObject }[] = [];

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  // Bootstrap registers module-scoped listeners; each test gets a fresh module,
  // so its listeners must be removed instead of accumulating across cases.
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    bridgeListeners.push({ type, listener: listener as EventListenerOrEventListenerObject });
    nativeAddEventListener(type, listener, options);
  });
});

afterEach(() => {
  delete (window as BridgeWindow).cloudcliAndroid;
  for (const { type, listener } of bridgeListeners) {
    window.removeEventListener(type, listener);
  }
  bridgeListeners.length = 0;
  vi.restoreAllMocks();
});

test('the native token is restored before anything renders', async () => {
  const token = createToken(0);
  const getSession = vi.fn(async () => ({ token }));
  (window as BridgeWindow).cloudcliAndroid = createBridge({ getSession });

  const { initializeAndroidBridge } = await import('@/modules/android-bridge/bootstrap');
  await initializeAndroidBridge();

  assert.equal(localStorage.getItem('auth-token'), token);
  assert.equal(getSession.mock.calls.length, 1);
});

test('an absent native session removes a stale web token', async () => {
  localStorage.setItem('auth-token', createToken(0));
  (window as BridgeWindow).cloudcliAndroid = createBridge();

  const { initializeAndroidBridge } = await import('@/modules/android-bridge/bootstrap');
  await initializeAndroidBridge();

  assert.equal(localStorage.getItem('auth-token'), null);
});

test('web login/refresh reaches native once, and a native refresh comes back without looping', async () => {
  const restored = createToken(0);
  const refreshed = createToken(1);
  const nativeRefreshed = createToken(2);
  const saveSession = vi.fn(async (_token: string) => ({ accepted: true }));
  const clearSession = vi.fn(async () => undefined);
  (window as BridgeWindow).cloudcliAndroid = createBridge({
    getSession: async () => ({ token: restored }),
    saveSession,
    clearSession,
  });

  const { initializeAndroidBridge } = await import('@/modules/android-bridge/bootstrap');
  const { AUTH_TOKEN_REFRESHED_EVENT, expireAuthSession } = await import('@/shared/authToken');
  await initializeAndroidBridge();

  window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: refreshed }));
  await flush();
  assert.deepEqual(saveSession.mock.calls.map(([token]) => token), [refreshed]);

  // Repeating the same web refresh must not call native again.
  window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: refreshed }));
  await flush();
  assert.equal(saveSession.mock.calls.length, 1);

  // A native background refresh updates web storage; its refreshed event must
  // not be echoed back to native.
  window.dispatchEvent(new CustomEvent('cloudcliandroid:session', { detail: { token: nativeRefreshed } }));
  await flush();
  assert.equal(localStorage.getItem('auth-token'), nativeRefreshed);
  assert.equal(saveSession.mock.calls.length, 1);

  expireAuthSession();
  await flush();
  assert.equal(localStorage.getItem('auth-token'), null);
  assert.equal(clearSession.mock.calls.length, 1);
});

test('without a bridge initialization is a no-op and leaves the browser session alone', async () => {
  const token = createToken(0);
  localStorage.setItem('auth-token', token);

  const { initializeAndroidBridge } = await import('@/modules/android-bridge/bootstrap');
  await initializeAndroidBridge();

  assert.equal(localStorage.getItem('auth-token'), token);
});
