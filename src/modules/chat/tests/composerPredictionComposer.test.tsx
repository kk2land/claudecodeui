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
 * prediction is only the textarea's native placeholder: the real value stays
 * empty until the user accepts, and the row below it carries only the
 * localized shortcuts and the pointer/touch buttons. The persisted switch is
 * also proven to be the same preference the send options read.
 *
 * `useVoiceAvailable` needs the app-wide preferences provider, which this
 * fixture deliberately does not mount; it only decides whether the mic button
 * appears, so a local stub keeps the composer otherwise real.
 */
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));

const PROJECT: Project = { projectId: 'project-composer', displayName: 'Composer', fullPath: '/tmp/composer' };
const SESSION: ProjectSession = { id: 'session-composer' };
const PLACEHOLDER = 'Ask Codex anything';

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
      placeholder={PLACEHOLDER}
      isTextareaExpanded={composer.isTextareaExpanded}
      composerPrediction={composer.composerPrediction as ComposerPredictionControls}
    />
  );
}

/** The textarea keeps its normal accessible name even while the suggestion is its placeholder. */
const findTextarea = async () => screen.findByRole('textbox', { name: PLACEHOLDER }) as Promise<HTMLTextAreaElement>;

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

test('the real composer paints the suggestion as the textarea placeholder and Tab makes it an editable draft', async () => {
  const submit = vi.fn((event: Event) => event.preventDefault());
  render(<Harness codexControls={controls({ sourceTurnId: 'turn-1', status: 'ready', text: 'Explain the failing test.' })} />);

  const textarea = await findTextarea();
  const form = textarea.closest('form')!;
  form.addEventListener('submit', submit);

  // The suggestion is the native placeholder; the value and draft stay empty.
  assert.equal(textarea.value, '');
  assert.equal(textarea.placeholder, 'Explain the failing test.');
  assert.equal(screen.getByTestId('composer-prediction-hint').textContent, 'Tab to use · Esc to hide');

  await act(async () => { fireEvent.keyDown(textarea, { key: 'Tab' }); });

  assert.equal(textarea.value, 'Explain the failing test.');
  // The text is now an ordinary draft: the ordinary placeholder is restored
  // and the shortcut row is hidden.
  assert.equal(textarea.placeholder, PLACEHOLDER);
  assert.equal(screen.queryByTestId('composer-prediction-hint'), null);
  assert.equal(submit.mock.calls.length, 0);
});

test('the accept button in the real composer fills the draft without submitting the form', async () => {
  const submit = vi.fn((event: Event) => event.preventDefault());
  render(<Harness codexControls={controls({ sourceTurnId: 'turn-1', status: 'ready', text: 'Summarize the diff.' })} />);
  const textarea = await findTextarea();
  const form = textarea.closest('form')!;
  form.addEventListener('submit', submit);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use' })); });

  assert.equal(textarea.value, 'Summarize the diff.');
  assert.equal(textarea.placeholder, PLACEHOLDER);
  assert.equal(submit.mock.calls.length, 0);
});

test('Esc restores the ordinary placeholder and typing refuses the suggestion for good', async () => {
  const view = render(<Harness codexControls={controls({ sourceTurnId: 'turn-1', status: 'ready', text: 'Next step.' })} />);
  const textarea = await findTextarea();
  assert.equal(textarea.placeholder, 'Next step.');

  await act(async () => { fireEvent.keyDown(textarea, { key: 'Escape' }); });
  assert.equal(textarea.placeholder, PLACEHOLDER);
  assert.equal(screen.queryByTestId('composer-prediction-hint'), null);
  assert.equal(textarea.value, '');
  view.unmount();

  // A fresh suggestion is retired by typing, and clearing the box must not
  // bring it back as a placeholder.
  render(<Harness codexControls={controls({ sourceTurnId: 'turn-2', status: 'ready', text: 'Write the changelog.' })} />);
  const typedTextarea = await findTextarea();
  assert.equal(typedTextarea.placeholder, 'Write the changelog.');

  await act(async () => { fireEvent.change(typedTextarea, { target: { value: 'W' } }); });
  assert.equal(typedTextarea.value, 'W');
  assert.equal(typedTextarea.placeholder, PLACEHOLDER);
  assert.equal(screen.queryByTestId('composer-prediction-hint'), null);

  await act(async () => { fireEvent.change(typedTextarea, { target: { value: '' } }); });
  assert.equal(typedTextarea.placeholder, PLACEHOLDER);
  assert.equal(screen.queryByTestId('composer-prediction-hint'), null);
});

test('disabling suggestions through the footer toggle restores the ordinary placeholder', async () => {
  render(<Harness codexControls={controls({ sourceTurnId: 'turn-1', status: 'ready', text: 'Next step.' })} />);
  const textarea = await findTextarea();
  const toggle = await screen.findByRole('button', { name: /Suggestions on/ });
  assert.equal(textarea.placeholder, 'Next step.');
  assert.equal(screen.getByTestId('composer-prediction-hint').textContent, 'Tab to use · Esc to hide');

  await act(async () => { fireEvent.click(toggle); });

  assert.equal(textarea.placeholder, PLACEHOLDER);
  assert.equal(screen.queryByTestId('composer-prediction-hint'), null);
  const stored = JSON.parse(localStorage.getItem('user-preferences') ?? '{}');
  assert.equal(stored.uiPreferences.showComposerPredictions, false);
});

test('the real composer moves a pending request through ready, empty and rejected states', async () => {
  const { rerender } = render(<Harness codexControls={controls({ sourceTurnId: 'turn-1', status: 'pending' })} />);
  const textarea = await findTextarea();

  // Waiting is visible while the composer is idle and empty; it is not an error
  // and it must not claim the placeholder.
  assert.equal(screen.getByTestId('composer-prediction-pending').textContent, 'Waiting for a suggestion…');
  assert.equal(textarea.placeholder, PLACEHOLDER);
  assert.equal(screen.queryByTestId('composer-prediction-hint'), null);

  // The same turn's result then arrives with native text: it becomes the
  // placeholder, and the textarea value stays untouched until acceptance.
  rerender(<Harness codexControls={controls({ sourceTurnId: 'turn-1', status: 'ready', text: 'Show day one.' })} />);
  assert.equal(textarea.placeholder, 'Show day one.');
  assert.equal(screen.queryByTestId('composer-prediction-pending'), null);
  assert.equal(screen.getByTestId('composer-prediction-hint').textContent, 'Tab to use · Esc to hide');
  assert.equal(textarea.value, '');

  // A later turn can still come back without text; that is reported, not left
  // looking like a broken toggle.
  rerender(<Harness codexControls={controls({ sourceTurnId: 'turn-2', status: 'pending' })} />);
  rerender(<Harness codexControls={controls({ sourceTurnId: 'turn-2', status: 'unavailable', reason: 'empty' })} />);
  assert.equal(screen.queryByTestId('composer-prediction-pending'), null);
  assert.equal(screen.getByTestId('composer-prediction-unavailable').textContent, 'Codex returned no suggestion this time');
  assert.equal(textarea.placeholder, PLACEHOLDER);

  // A rejected request names the rejection without claiming a specific build.
  rerender(<Harness codexControls={controls({ sourceTurnId: 'turn-3', status: 'unavailable', reason: 'rejected' })} />);
  assert.equal(screen.getByTestId('composer-prediction-unavailable').textContent, 'Codex rejected the suggestion request');
});
