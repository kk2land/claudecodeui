import { useEffect, useState } from 'react';

import { getAndroidBridge } from '@/modules/android-bridge/androidBridge';
import { subscribeAndroidShares } from '@/modules/android-bridge/bridgeRuntime';
import type { AndroidShare } from '@/shared/types';

type AndroidSharesHook = {
  shares: AndroidShare[];
};

/**
 * Loads the native pending-share inbox and re-reads it whenever native reports
 * a change. Without a bridge the list stays empty, which keeps the inbox
 * invisible in an ordinary browser.
 */
export function useAndroidShares(): AndroidSharesHook {
  // Pending native shares shown after login; re-read on every shares-changed event.
  const [shares, setShares] = useState<AndroidShare[]>([]);

  useEffect(() => {
    const bridge = getAndroidBridge();
    if (!bridge) {
      return undefined;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await bridge.listShares();
        if (!cancelled) {
          setShares(next);
        }
      } catch (error) {
        console.warn('[AndroidBridge] Could not read pending shares:', error);
      }
    };

    void refresh();
    const unsubscribe = subscribeAndroidShares(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { shares };
}
