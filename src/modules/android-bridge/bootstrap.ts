import { getAndroidBridge } from '@/modules/android-bridge/androidBridge';
import {
  notifyAndroidSharesChanged,
  publishAndroidBridgeState,
  readAndroidBridgeState,
} from '@/modules/android-bridge/bridgeRuntime';
import {
  AUTH_SESSION_EXPIRED_EVENT,
  AUTH_TOKEN_REFRESHED_EVENT,
  expireAuthSession,
  storeAuthToken,
} from '@/shared/authToken';
import type { AndroidBridge, AndroidBridgeState } from '@/shared/types';

/**
 * Restores the native session and connects the web auth events to the Android
 * bridge before React renders. Every listener is registered once, and every
 * failure is contained here so an unavailable or failing bridge never blocks
 * the web app from starting.
 */

let initialized = false;
let lastSyncedToken: string | null = null;

type AndroidSessionEvent = CustomEvent<{ token?: unknown }>;
type AndroidStateEvent = CustomEvent<AndroidBridgeState>;
type AndroidSharesEvent = CustomEvent<{ count?: unknown }>;

function registerBridgeEvents(bridge: AndroidBridge): void {
  window.addEventListener('cloudcliandroid:state', (event) => {
    const state = (event as AndroidStateEvent).detail;
    if (state && typeof state === 'object') {
      publishAndroidBridgeState(state);
    }
  });

  window.addEventListener('cloudcliandroid:session', (event) => {
    const token = (event as AndroidSessionEvent).detail?.token;
    if (typeof token !== 'string') {
      return;
    }

    // Remember the token before storing it: storing dispatches the normal
    // refreshed event, whose listener must not echo it straight back to native.
    lastSyncedToken = token;
    if (!storeAuthToken(token)) {
      localStorage.removeItem('auth-token');
    }
  });

  window.addEventListener('cloudcliandroid:session-expired', () => {
    lastSyncedToken = null;
    expireAuthSession();
  });

  window.addEventListener('cloudcliandroid:shares-changed', (event) => {
    const count = (event as AndroidSharesEvent).detail?.count;
    if (typeof count === 'number') {
      const previous = readAndroidBridgeState();
      if (previous) {
        publishAndroidBridgeState({ ...previous, pendingShareCount: count });
      }
    }
    notifyAndroidSharesChanged();
  });

  window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, (event) => {
    const token = (event as CustomEvent<unknown>).detail;
    if (typeof token !== 'string' || token === lastSyncedToken) {
      return;
    }

    void bridge.saveSession(token).then((result) => {
      if (result?.accepted) {
        lastSyncedToken = token;
      } else {
        console.warn('[AndroidBridge] Native session rejected a refreshed token:', result?.reason);
      }
    }).catch((error) => {
      console.warn('[AndroidBridge] Could not save the refreshed session:', error);
    });
  });

  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, () => {
    lastSyncedToken = null;
    void bridge.clearSession().catch((error) => {
      console.warn('[AndroidBridge] Could not clear the native session:', error);
    });
  });
}

async function restoreSession(bridge: AndroidBridge): Promise<void> {
  try {
    const session = await bridge.getSession();
    if (session?.token) {
      lastSyncedToken = session.token;
      if (!storeAuthToken(session.token)) {
        localStorage.removeItem('auth-token');
      }
      return;
    }

    // The native store is authoritative on Android: a web token left behind by
    // a previous native sign-out must not resurrect that session.
    localStorage.removeItem('auth-token');
  } catch (error) {
    console.warn('[AndroidBridge] Could not restore the native session:', error);
  }
}

/** One idempotent start-up step; call it before rendering the React tree. */
export async function initializeAndroidBridge(): Promise<void> {
  if (initialized) {
    return;
  }
  initialized = true;

  const bridge = getAndroidBridge();
  if (!bridge) {
    return;
  }

  await restoreSession(bridge);
  registerBridgeEvents(bridge);

  void bridge.getState().then(publishAndroidBridgeState).catch((error) => {
    console.warn('[AndroidBridge] Could not read the native bridge state:', error);
  });
  void bridge.listShares().catch((error) => {
    console.warn('[AndroidBridge] Could not read pending shares:', error);
  });
}
