import { useCallback, useEffect, useState } from 'react';

import { getAndroidBridge } from '@/modules/android-bridge/androidBridge';
import {
  publishAndroidBridgeState,
  readAndroidBridgeState,
  subscribeAndroidBridgeState,
} from '@/modules/android-bridge/bridgeRuntime';
import type { AndroidBridgeState } from '@/shared/types';

type AndroidBridgeStateHook = {
  /** True only for a complete version-1 injected bridge; false means no Android controls. */
  available: boolean;
  state: AndroidBridgeState | null;
  refresh: () => Promise<void>;
};

/**
 * Reads the native bridge state for settings. The native value is the only
 * source of truth; there is no optimistic client-side copy, and a browser
 * without a bridge stays at `available: false` with the existing UI unchanged.
 */
export function useAndroidBridgeState(): AndroidBridgeStateHook {
  const available = getAndroidBridge() !== null;
  // Local snapshot of the shared runtime cache so native state changes re-render
  // exactly the consumers that read the bridge, without a provider.
  const [state, setState] = useState<AndroidBridgeState | null>(() => readAndroidBridgeState());

  const refresh = useCallback(async () => {
    const bridge = getAndroidBridge();
    if (!bridge) {
      return;
    }

    try {
      publishAndroidBridgeState(await bridge.getState());
    } catch (error) {
      console.warn('[AndroidBridge] Could not refresh the native state:', error);
    }
  }, []);

  useEffect(() => subscribeAndroidBridgeState(setState), []);

  useEffect(() => {
    if (!available || readAndroidBridgeState()) {
      return;
    }
    void refresh();
  }, [available, refresh]);

  return { available, state, refresh };
}
