import { useUiPreferences } from '@/shared/context/UiPreferencesContext';

/**
 * Whether the voice controls (composer mic, read-aloud) should be shown. Only
 * the user's `voiceEnabled` preference decides, toggled in Quick Settings / the
 * Settings modal.
 *
 * This used to also require a configured backend: either a base URL in this
 * browser's local voice config or a successful `/api/voice/health` probe. That
 * is per-device state, so a phone without the desktop's stored base URL — or a
 * server without `VOICE_API_BASE_URL` — removed the entry entirely, and the user
 * could not even reach the error explaining why. Backend failures now surface
 * through the recorder/player's own error message instead of hiding the control.
 */
export function useVoiceAvailable(): boolean {
  return useUiPreferences().voiceEnabled;
}
