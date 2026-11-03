import type { AndroidBridgeState } from '@/shared/types';

/**
 * Module-level mirror of the native bridge state and the two subscriptions the
 * UI needs. It deliberately lives outside React: bootstrap runs before the
 * renderer exists, and the composer/share inbox must observe native events
 * without mounting a provider.
 */

let cachedState: AndroidBridgeState | null = null;
const stateListeners = new Set<(state: AndroidBridgeState) => void>();
const sharesListeners = new Set<() => void>();

/** Returns the last state received from native, or null before the first `getState()`/state event. */
export function readAndroidBridgeState(): AndroidBridgeState | null {
  return cachedState;
}

/** Publishes a native state snapshot to every mounted consumer. */
export function publishAndroidBridgeState(state: AndroidBridgeState): void {
  cachedState = state;
  for (const listener of stateListeners) {
    listener(state);
  }
}

/** Subscribes to native state changes; used by the settings hook. */
export function subscribeAndroidBridgeState(
  listener: (state: AndroidBridgeState) => void,
): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** Announces that pending shares may have changed; consumers re-read `listShares()`. */
export function notifyAndroidSharesChanged(): void {
  for (const listener of sharesListeners) {
    listener();
  }
}

/** Subscribes to share-inbox invalidation from native events or local insertion. */
export function subscribeAndroidShares(listener: () => void): () => void {
  sharesListeners.add(listener);
  return () => {
    sharesListeners.delete(listener);
  };
}
