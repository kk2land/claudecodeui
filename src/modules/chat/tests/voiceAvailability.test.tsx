import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useVoiceAvailable } from '@/modules/chat/hooks/useVoiceAvailable';
import MessageSpeakControl from '@/modules/chat/transcript/MessageSpeakControl';
import { api } from '@/shared/api';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { CodexControls, CodexSessionState, PendingPermissionRequest, VoiceInputState } from '@/shared/types';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * The voice controls used to be gated on a configured backend as well as on the
 * `voiceEnabled` preference: `useVoiceAvailable` returned false until either
 * this browser's local voice config had a base URL or `/api/voice/health`
 * answered `configured: true`. That state is per-device and per-server, so a
 * phone that never stored the desktop's base URL (or a server without
 * `VOICE_API_BASE_URL`) removed the mic button entirely — the user could not
 * even reach the error that would have explained why.
 *
 * The preference alone now decides whether the controls exist; a failing
 * backend has to reach the recorder/player's own error feedback instead of
 * deleting the entry. These tests pin both halves of that contract: the
 * composer mic and the read-aloud control appear on a device with no local
 * voice backend even when the health probe fails, and stay hidden when the
 * feature is switched off.
 */

const toggleBrowserVoice = vi.fn();
let browserVoiceState: VoiceInputState = 'idle';
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: browserVoiceState, toggle: toggleBrowserVoice, stop: () => {} }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <UiPreferencesProvider>{children}</UiPreferencesProvider>
);

/** Seeds the persisted preference the provider reads on mount. */
const setVoiceEnabled = (enabled: boolean) => {
  writeUserPreference('uiPreferences', { voiceEnabled: enabled });
};

/** A phone that has never saved a voice base URL. */
const hasNoLocalVoiceBackend = () => {
  assert.equal(localStorage.getItem('voiceConfig'), null);
};

const composerProps = (): ComponentProps<typeof ChatComposer> => ({
  pendingPermissionRequests: [] as PendingPermissionRequest[],
  handlePermissionDecision: () => {},
  handleGrantToolPermission: () => ({ success: false }),
  activity: null,
  isLoading: false,
  onAbortSession: () => {},
  permissionMode: 'default',
  availablePermissionModes: ['default'],
  onSelectPermissionMode: () => {},
  providerLabel: 'Claude',
  effort: 'default',
  availableEffortOptions: [],
  onSelectEffort: () => {},
  model: 'default',
  availableModelOptions: [],
  onSelectModel: () => {},
  modelsLoading: false,
  tokenBudget: null,
  onShowTokenUsage: () => {},
  slashCommandsCount: 0,
  onToggleCommandMenu: () => {},
  hasInput: false,
  onClearInput: () => {},
  onSubmit: () => {},
  isDragActive: false,
  queuedDraft: null,
  backgroundSendPrompt: null,
  onResolveBackgroundSendPrompt: () => {},
  isEditingSentMessage: false,
  onCancelEditMessage: () => {},
  scheduledMessages: [],
  onScheduleMessage: () => {},
  onCancelScheduledMessage: () => {},
  onEditQueuedDraft: () => {},
  onDeleteQueuedDraft: () => {},
  attachedFiles: [],
  onRemoveAttachment: () => {},
  fileErrors: new Map<string, string>(),
  showFileDropdown: false,
  filteredFiles: [],
  selectedFileIndex: 0,
  onSelectFile: () => {},
  filteredCommands: [],
  selectedCommandIndex: 0,
  onCommandSelect: () => {},
  onCloseCommandMenu: () => {},
  isCommandMenuOpen: false,
  frequentCommands: [],
  getRootProps: () => ({}),
  getInputProps: () => ({}),
  openAttachmentPicker: () => {},
  inputHighlightRef: { current: null },
  renderInputWithMentions: () => null,
  textareaRef: { current: null },
  input: '',
  onVoiceTranscript: () => {},
  onInputChange: () => {},
  onTextareaClick: () => {},
  onTextareaKeyDown: () => {},
  onTextareaPaste: () => {},
  onTextareaScrollSync: () => {},
  onTextareaInput: () => {},
  placeholder: 'Message',
  isTextareaExpanded: false,
});

/** Finds the mic button by its icon, since the control has no text of its own. */
const findMicButton = (container: HTMLElement) => container.querySelector(
  '[data-slot="prompt-input-tools"] button svg.lucide-mic',
);

const stubAndroidBridge = (openVoiceChat?: unknown) => {
  const noop = () => {};
  vi.stubGlobal('cloudcliAndroid', {
    version: 1,
    getState: noop,
    notify: noop,
    setNotificationsEnabled: noop,
    getSession: noop,
    saveSession: noop,
    clearSession: noop,
    listShares: noop,
    getShareContent: noop,
    consumeShare: noop,
    discardShare: noop,
    pickFiles: noop,
    saveFile: noop,
    openVoiceChat,
  });
};

const codexControls = (runtime: CodexSessionState['runtime'], sessionId: string | null = 'selected-session'): CodexControls => ({
  sessionId,
  state: { runtime, mode: 'default', phase: 'idle', turnId: null, goal: null, questions: [] },
  error: null,
  pending: false,
  delivery: null,
  control: async () => {},
  steer: async () => {},
});

const openMobileActions = (
  controls: CodexControls,
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {},
) => {
  vi.stubGlobal('innerWidth', 412);
  render(<ChatComposer {...composerProps()} providerLabel="Codex" codexControls={controls} {...overrides} />, { wrapper });
  fireEvent.click(screen.getByRole('button', { name: 'Add attachment or action' }));
  return within(screen.getByRole('dialog', { name: 'Add to message' }));
};

beforeEach(() => {
  localStorage.clear();
  // The preference store is a module singleton, so clearing localStorage alone
  // would let one case's `voiceEnabled` leak into the next.
  resetUserPreferences();
});

afterEach(() => {
  // Also drops the debounced server write the seeding queued.
  resetUserPreferences();
  browserVoiceState = 'idle';
  toggleBrowserVoice.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('voice stays available with no local backend and a failing health probe', async () => {
  setVoiceEnabled(true);
  hasNoLocalVoiceBackend();
  const health = vi.spyOn(api.voice, 'health').mockRejectedValue(new Error('voice backend unreachable'));

  const { result } = renderHook(() => useVoiceAvailable(), { wrapper });

  assert.equal(result.current, true);
  await act(async () => {});
  assert.equal(result.current, true);
  // The preference, not the probe, decides: a phone must not pay for a request
  // that can only remove its own microphone.
  assert.equal(health.mock.calls.length, 0);
});

test('voice is unavailable when the preference is off, whatever the backend says', async () => {
  setVoiceEnabled(false);
  const health = vi.spyOn(api.voice, 'health').mockResolvedValue(new Response('{"configured":true}'));

  const { result } = renderHook(() => useVoiceAvailable(), { wrapper });

  assert.equal(result.current, false);
  await act(async () => {});
  assert.equal(result.current, false);
  assert.equal(health.mock.calls.length, 0);
});

test('the composer keeps its mic on a phone with no local backend when health fails', () => {
  setVoiceEnabled(true);
  hasNoLocalVoiceBackend();
  vi.spyOn(api.voice, 'health').mockRejectedValue(new Error('voice backend unreachable'));

  const { container } = render(<ChatComposer {...composerProps()} />, { wrapper });

  assert.ok(findMicButton(container), 'expected the composer toolbar to render the mic');
});

test('the composer hides the mic when the voice preference is off', () => {
  setVoiceEnabled(false);

  const { container } = render(<ChatComposer {...composerProps()} />, { wrapper });

  assert.equal(findMicButton(container), null);
});

test('the mobile voice action opens the selected native session with the draft intact', () => {
  setVoiceEnabled(false);
  hasNoLocalVoiceBackend();
  const openVoiceChat = vi.fn().mockResolvedValue(undefined);
  stubAndroidBridge(openVoiceChat);
  const onSubmit = vi.fn();
  const onClearInput = vi.fn();
  const input = 'Keep this draft';
  const actions = openMobileActions(codexControls('app-server', 'selected-codex-session'), {
    hasInput: true, input, onSubmit, onClearInput, onVoiceTranscript: undefined,
  });

  fireEvent.click(actions.getByRole('button', { name: 'Voice input' }));

  assert.deepEqual(openVoiceChat.mock.calls, [['selected-codex-session']]);
  assert.equal(screen.queryByRole('dialog', { name: 'Add to message' }), null);
  assert.equal(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).value, input);
  assert.equal(onSubmit.mock.calls.length, 0);
  assert.equal(onClearInput.mock.calls.length, 0);
  assert.equal(toggleBrowserVoice.mock.calls.length, 0);
});

test.each([
  { reason: 'without a bridge', method: undefined, runtime: 'app-server', sessionId: 'selected-session' },
  { reason: 'with a non-callable bridge method', method: true, runtime: 'app-server', sessionId: 'selected-session' },
  { reason: 'for an SDK session', method: () => {}, runtime: 'sdk', sessionId: 'selected-session' },
  { reason: 'without a session ID', method: () => {}, runtime: 'app-server', sessionId: null },
] as const)('mobile voice is hidden with dictation off $reason', ({ method, runtime, sessionId }) => {
  if (method !== undefined) stubAndroidBridge(method);
  const actions = openMobileActions(codexControls(runtime, sessionId));
  assert.equal(actions.queryByRole('button', { name: 'Voice input' }), null);
});

test.each([
  { scenario: 'with an old bridge', hasNativeVoice: false, runtime: 'app-server', state: 'idle', label: 'Voice input' },
  { scenario: 'in the SDK runtime', hasNativeVoice: true, runtime: 'sdk', state: 'idle', label: 'Voice input' },
  { scenario: 'during browser recording', hasNativeVoice: true, runtime: 'app-server', state: 'recording', label: 'Stop recording' },
] as const)('the mobile menu keeps its browser voice action $scenario', ({ hasNativeVoice, runtime, state, label }) => {
  setVoiceEnabled(true);
  browserVoiceState = state;
  const openVoiceChat = vi.fn();
  stubAndroidBridge(hasNativeVoice ? openVoiceChat : undefined);
  const actions = openMobileActions(codexControls(runtime));

  fireEvent.click(actions.getByRole('button', { name: label }));

  assert.equal(toggleBrowserVoice.mock.calls.length, 1);
  assert.equal(openVoiceChat.mock.calls.length, 0);
});

test('the desktop composer still uses browser dictation when Android voice is available', () => {
  setVoiceEnabled(true);
  const openVoiceChat = vi.fn();
  stubAndroidBridge(openVoiceChat);
  const { container } = render(
    <ChatComposer {...composerProps()} providerLabel="Codex" codexControls={codexControls('app-server')} />,
    { wrapper },
  );
  const micButton = findMicButton(container)?.closest('button');
  assert.ok(micButton);
  fireEvent.click(micButton);
  assert.equal(toggleBrowserVoice.mock.calls.length, 1);
  assert.equal(openVoiceChat.mock.calls.length, 0);
});

test.each([
  { failure: new Error('Voice page unavailable'), message: 'Voice page unavailable' },
  { failure: undefined, message: 'Could not open voice input.' },
])('the mobile composer displays a native voice launch failure as "$message"', async ({ failure, message }) => {
  stubAndroidBridge(vi.fn().mockRejectedValue(failure));
  const actions = openMobileActions(codexControls('app-server'));
  fireEvent.click(actions.getByRole('button', { name: 'Voice input' }));
  assert.equal((await screen.findByRole('alert')).textContent, message);
});

test('read-aloud follows the same preference instead of probing the backend', () => {
  setVoiceEnabled(true);
  hasNoLocalVoiceBackend();
  const health = vi.spyOn(api.voice, 'health').mockRejectedValue(new Error('voice backend unreachable'));

  const enabled = render(<MessageSpeakControl content="Hello" />, { wrapper });
  assert.ok(enabled.container.querySelector('svg.lucide-volume-2'));
  enabled.unmount();

  setVoiceEnabled(false);
  const disabled = render(<MessageSpeakControl content="Hello" />, { wrapper });
  assert.equal(disabled.container.querySelector('svg.lucide-volume-2'), null);
  assert.equal(health.mock.calls.length, 0);
});
