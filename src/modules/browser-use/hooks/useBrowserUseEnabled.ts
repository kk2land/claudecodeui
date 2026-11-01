import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { BROWSER_USE_FEATURE_ENABLED } from '@/shared/constants';

/** Tracks whether the Browser Use workspace is enabled in server settings. */
export function useBrowserUseEnabled() {
  const [browserUseEnabled, setBrowserUseEnabled] = useState(false);

  const loadBrowserUseSettings = useCallback(async () => {
    try {
      const response = await api.browserUse.settings();
      const data = await response.json();
      setBrowserUseEnabled(Boolean(
        response.ok
        && data?.success !== false
        && data?.data?.settings?.enabled,
      ));
    } catch {
      setBrowserUseEnabled(false);
    }
  }, []);

  useEffect(() => {
    // Browser Use is retired for every role, so the old server-side
    // `enabled: true` value must not trigger a settings request or mount the tab.
    if (!BROWSER_USE_FEATURE_ENABLED) {
      return;
    }

    void loadBrowserUseSettings();
    window.addEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
    return () => window.removeEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
  }, [loadBrowserUseSettings]);

  return BROWSER_USE_FEATURE_ENABLED ? browserUseEnabled : false;
}
