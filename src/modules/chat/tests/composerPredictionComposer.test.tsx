import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import { resetUserPreferences } from '@/shared/userSettings';
import type { CodexControls, ComposerPredictionControls, Project, ProjectSession, ToolPermissionDecision } from '@/shared/types';

/**
 * Renders the real ChatComposer with the real composer hook to prove the
 * prediction overlay is a separate layer from the textarea value, that its
 * buttons accept without submitting, and that the persisted switch is wired to
 * the same preference the send options read.
 *
 * `useVoiceAvailable` needs the app-wide preferences provider, which this
 * fixture deliberately does not mount; it only decides whether the mic button
 * appears, so a local stub keeps the composer otherwise real.
 */
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));

const PROJECT: Project = { projectId: 'project-composer', displayName: 'Composer', fullPath: '/tmp/composer' };
const SESSION: ProjectSession = { id: 'session-composer' };

const controls = (prediction?: CodexControls['state'] extends infer S ? S extends { prediction?: infer P } ? P : never : never): CodexControls => ({
  sessionId: SESSION.id,
  state: {
    runtime: 'app-server', mode: 'default', phase: 'idle', turnId: null, goal: null, questions: [],
    ...(prediction ? { prediction } : {}),
  },
  goalsEnabled: true,
  predictionsSupported: true,
  pending: false, error: null, delivery: null,
  control: vi.fn().mockResolvedValue(undefined), steer: vi.fn().mockResolvedValue(undefined),
});

function Harness({ codexControls }: { codexControls: CodexControls }) {
  const send = vi.fn();
  const composer = useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    provider: 'codex',
    permissionMode: 'default',
    cyclePermissionMode: vi.fn(),
    resolvePermissionModeForProvider: (_provider, mode) => mode as never,
    currentProviderModel: 'gpt-5.4',
    currentProviderEffort: 'high',
    isLoading: false,
    codexControls,
    composerPredictionsEligible: true,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: send,
    scrollToBottom() {},
    addMessage() {},
    setIsUserScrolledUp() {},
    setPendingPermissionRequests() {},
  });
  return (
    <ChatComposer
      pendingPermissionRequests={[]}
      handlePermissionDecision={(_ids: string | string[], _decision: ToolPermissionDecision) => {}}
      handleGrantToolPermission={() => ({ success: false })}
      activity={null}
      isLoading={false}
      onAbortSession={() => {}}
      permissionMode="default"
      availablePermissionModes={['default']}
      onSelectPermissionMode={() => {}}
      providerLabel="Codex"
      effort="high"
      availableEffortOptions={[]}
      onSelectEffort={() => {}}
      model="gpt-5.4"
      availableModelOptions={[]}
      onSelectModel={() => {}}
      modelsLoading={false}
      tokenBudget={null}
      onShowTokenUsage={() => {}}
      slashCommandsCount={0}
      onToggleCommandMenu={() => {}}
      hasInput={Boolean(composer.input.trim())}
      onClearInput={composer.handleClearInput}
      onSubmit={composer.handleSubmit as never}
      isDragActive={false}
      queuedDraft={composer.queuedDraft}
      codexControls={codexControls}
      backgroundSendPrompt={null}
      onResolveBackgroundSendPrompt={() => {}}
      isEditingSentMessage={false}
      onCancelEditMessage={composer.cancelEditMessage}
      scheduledMessages={[]}
      onScheduleMessage={() => {}}
      onCancelScheduledMessage={() => {}}
      onEditQueuedDraft={composer.editQueuedDraft}
      onDeleteQueuedDraft={composer.deleteQueuedDraft}
      attachedFiles={composer.attachedFiles}
      onRemoveAttachment={() => {}}
      fileErrors={composer.fileErrors}
      showFileDropdown={composer.showFileDropdown}
      filteredFiles={composer.filteredFiles}
      selectedFileIndex={composer.selectedFileIndex}
      onSelectFile={composer.selectFile}
      filteredCommands={composer.filteredCommands}
      selectedCommandIndex={composer.selectedCommandIndex}
      onCommandSelect={composer.handleCommandSelect}
      onCloseCommandMenu={composer.resetCommandMenuState}
      isCommandMenuOpen={composer.showCommandMenu}
      frequentCommands={composer.frequentCommands}
      getRootProps={composer.getRootProps as never}
      getInputProps={composer.getInputProps as never}
      openAttachmentPicker={composer.openAttachmentPicker}
      inputHighlightRef={composer.inputHighlightRef}
      renderInputWithMentions={composer.renderInputWithMentions}
      textareaRef={composer.textareaRef}
      input={composer.input}
      onVoiceTranscript={composer.handleVoiceTranscript}
      onInputChange={composer.handleInputChange}
      onTextareaClick={composer.handleTextareaClick}
      onTextareaKeyDown={composer.handleKeyDown}
      onTextareaPaste={composer.handlePaste}
      onTextareaScrollSync={composer.syncInputOverlayScroll}
      onTextareaInput={composer.handleTextareaInput}
      placeholder="Ask Codex anything"
      isTextareaExpanded={composer.isTextareaExpanded}
      composerPrediction={composer.composerPrediction as ComposerPredictionControls}
    />
  );
}

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  resetChatDrafts();
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
    String(url).includes('/files') ? [] : { success: true, data: [], commands: [], drafts: [], preferences: {} },
  ), { status: 200 }))));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetChatDrafts();
});

test('the real composer leaves the textarea empty and lets Tab turn the ghost text into an editable draft', async () => {
  render(<Harness codexControls={controls({ sourceTurnId: 'turn-1', status: 'ready', text: 'Explain the failing test.' })} />);

  const textarea = await screen.findByPlaceholderText('Ask Codex anything') as HTMLTextAreaElement;
  // The suggestion is rendered as its own preview, not as the textarea value
  // and not as its placeholder.
  assert.equal(textarea.value, '');
  assert.equal(textarea.placeholder, 'Ask Codex anything');
  assert.equal(screen.getByTestId('composer-prediction').textContent, 'Explain the failing test.');

  await act(async () => { fireEvent.keyDown(textarea, { key: 'Tab' }); });

  assert.equal(textarea.value, 'Explain the failing test.');
  // The preview is gone because the text is now an ordinary draft.
  assert.equal(screen.queryByTestId('composer-prediction'), null);
});

test('the accept button in the real composer fills the draft without submitting the form', async () => {
  const submit = vi.fn((event: Event) => event.preventDefault());
  render(<Harness codexControls={controls({ sourceTurnId: 'turn-1', status: 'ready', text: 'Summarize the diff.' })} />);
  const textarea = await screen.findByPlaceholderText('Ask Codex anything') as HTMLTextAreaElement;
  const form = textarea.closest('form')!;
  form.addEventListener('submit', submit);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use' })); });

  assert.equal(textarea.value, 'Summarize the diff.');
  assert.equal(submit.mock.calls.length, 0);
});

test('the composer footer toggle persists the preference and hides the preview', async () => {
  render(<Harness codexControls={controls({ sourceTurnId: 'turn-1', status: 'ready', text: 'Next step.' })} />);
  const toggle = await screen.findByRole('button', { name: /Suggestions on/ });
  assert.equal(screen.getByTestId('composer-prediction').textContent, 'Next step.');

  await act(async () => { fireEvent.click(toggle); });

  assert.equal(screen.queryByTestId('composer-prediction'), null);
  const stored = JSON.parse(localStorage.getItem('user-preferences') ?? '{}');
  assert.equal(stored.uiPreferences.showComposerPredictions, false);
});
