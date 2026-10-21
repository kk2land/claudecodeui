import { useCallback, useSyncExternalStore } from 'react';

import { subscribeToUserPreferences, writeUserPreference } from '@/shared/userSettings';
import { readStoredUiPreferences } from '@/shared/uiPreferences';

/**
 * Reads and writes one boolean UI preference without requiring the
 * UiPreferencesProvider.
 *
 * The composer hooks are also exercised directly by unit tests that mount no
 * application providers, so prediction state reads the same persisted
 * `uiPreferences` blob through the shared store instead of a React context.
 * Subscribing there keeps a change made in another tab or on another device in
 * effect here too.
 */
export function useComposerPredictionsPreference(): { enabled: boolean; setEnabled(enabled: boolean): void } {
  // Keep every composer in sync with the persisted switch across preference hydration and edits.
  const enabled = useSyncExternalStore(
    subscribeToUserPreferences,
    () => readStoredUiPreferences().showComposerPredictions,
    () => true,
  );

  const setEnabled = useCallback((next: boolean) => {
    // Merge into the stored blob so every other UI preference is preserved.
    const stored = readStoredUiPreferences();
    if (stored.showComposerPredictions === next) return;
    writeUserPreference('uiPreferences', { ...stored, showComposerPredictions: next });
  }, []);

  return { enabled, setEnabled };
}
