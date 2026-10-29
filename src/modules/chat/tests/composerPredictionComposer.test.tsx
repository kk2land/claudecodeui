import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

type HarnessOverrides = Partial<React.ComponentProps<typeof ChatComposer>>;

function Harness({ codexControls, overrides }: { codexControls: CodexControls; overrides?: HarnessOverrides }) {
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
      onTextareaResize={composer.resizeTextarea}
      placeholder={PLACEHOLDER}
      isTextareaExpanded={composer.isTextareaExpanded}
      isInputFocused={composer.isInputFocused}
      onInputFocusChange={composer.handleInputFocusChange}
      composerPrediction={composer.composerPrediction as ComposerPredictionControls}
      {...overrides}
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

test('an empty Codex model disables Send but leaves the model picker available', async () => {
  const codex = controls();
  codex.state!.modelSelection = { modelProvider: 'beta', model: null };
  render(<Harness codexControls={codex} overrides={{ model: '', availableModelOptions: [{ value: 'beta-model', label: 'Beta model' }] }} />);
  const textarea = await findTextarea();
  await act(async () => { fireEvent.change(textarea, { target: { value: 'wait for a model' } }); });
  assert.equal((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, true);
  assert.equal(screen.getByRole('button', { name: 'Select model and reasoning effort' }).textContent, 'Select a model');
  await act(async () => { fireEvent.keyDown(textarea, { key: 'Enter' }); });
  assert.equal(textarea.value, 'wait for a model');
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

/* ─── Mobile capsule / expansion ─────────────────────────────────── */

const stubPhone = () => {
  vi.stubGlobal('innerWidth', 412);
};

/** State-level patches beyond prediction, matching the Codex control fixture shape. */
const mobileControls = (patch: Partial<NonNullable<CodexControls['state']>>): CodexControls => {
  const base = controls();
  return { ...base, state: { ...base.state!, ...patch } };
};

test('mobile idle is one short capsule line that expands in place on focus and keeps a draft', async () => {
  stubPhone();
  const view = render(<Harness codexControls={controls({ sourceTurnId: 'turn-1', status: 'ready', text: 'Explain the failing test.' })} />);

  const textarea = await findTextarea();
  assert.equal(screen.getAllByRole('textbox').length, 1);
  assert.equal(textarea.getAttribute('rows'), '1');
  assert.equal(textarea.placeholder, 'Ask Codex');
  assert.equal(textarea.getAttribute('aria-label'), PLACEHOLDER);
  assert.ok(screen.getByRole('button', { name: 'Add attachment or action' }));
  assert.ok(screen.getByRole('button', { name: 'Send' }));

  await act(async () => { textarea.focus(); });
  // Same live textarea, now three rows tall with the suggestion actions inline
  // in the footer beside `+` — exactly one group, none under the textarea.
  assert.equal(screen.getAllByRole('textbox').length, 1);
  assert.equal(textarea.getAttribute('rows'), '3');
  assert.equal(textarea.placeholder, 'Explain the failing test.');
  assert.equal(screen.getAllByTestId('composer-prediction-hint').length, 1);
  assert.ok(screen.getByRole('button', { name: 'Chat settings' }));
  const tools = screen.getByRole('button', { name: 'Add attachment or action' }).closest('[data-slot="prompt-input-tools"]');
  assert.ok(tools?.contains(screen.getByRole('button', { name: 'Use' })));
  assert.ok(tools?.contains(screen.getByRole('button', { name: 'Hide suggestion' })));

  textarea.focus();
  const onSubmit = vi.fn((event: Event) => event.preventDefault());
  textarea.closest('form')!.addEventListener('submit', onSubmit);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use' })); });
  assert.equal(onSubmit.mock.calls.length, 0);
  assert.equal(textarea.value, 'Explain the failing test.');
  // A non-empty draft survives blur and keeps the expanded frame.
  await act(async () => { textarea.blur(); });
  assert.equal(textarea.value, 'Explain the failing test.');
  assert.equal(textarea.placeholder, PLACEHOLDER);

  await act(async () => { fireEvent.change(textarea, { target: { value: '' } }); });
  await act(async () => { textarea.blur(); });
  assert.equal(textarea.placeholder, 'Ask Codex');
  assert.equal(textarea.getAttribute('rows'), '1');

  // Desktop keeps the separate shortcut row below the textarea.
  vi.stubGlobal('innerWidth', 1024);
  await act(async () => { window.dispatchEvent(new Event('resize')); });
  view.rerender(<Harness codexControls={controls({ sourceTurnId: 'turn-6', status: 'ready', text: 'Desktop suggestion.' })} />);
  const desktopTextarea = await findTextarea();
  assert.equal(desktopTextarea.getAttribute('rows'), null);
  const desktopHint = screen.getByTestId('composer-prediction-hint');
  assert.ok(!desktopHint.closest('[data-slot="prompt-input-tools"]'));
});

test('the + sheet reaches chat settings and drives the real model, effort and permission options', async () => {
  stubPhone();
  const onSelectModel = vi.fn();
  const onSelectEffort = vi.fn();
  const onSelectPermissionMode = vi.fn();
  const overrides: HarnessOverrides = {
    model: 'gpt-5.4',
    availableModelOptions: [
      { value: 'gpt-5.4', label: 'GPT-5.4' },
      { value: 'gpt-5.5', label: 'GPT-5.5' },
    ],
    onSelectModel,
    effort: 'high',
    availableEffortOptions: [{ value: 'low' }, { value: 'high' }] as never,
    onSelectEffort,
    availablePermissionModes: ['default', 'plan'],
    onSelectPermissionMode,
  };
  const view = render(
    <Harness codexControls={controls()} overrides={overrides} />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Add attachment or action' }));
  const actions = await screen.findByRole('dialog', { name: 'Add to message' });
  fireEvent.click(within(actions).getByRole('button', { name: 'Chat settings' }));
  const settings = await screen.findByRole('dialog', { name: 'Chat settings' });

  const comboboxes = within(settings).getAllByRole('combobox') as HTMLSelectElement[];
  assert.equal(comboboxes.length, 3);
  assert.deepEqual(Array.from(comboboxes[0].options).map((option) => option.value), ['gpt-5.4', 'gpt-5.5']);
  fireEvent.change(comboboxes[0], { target: { value: 'gpt-5.5' } });
  assert.deepEqual(onSelectModel.mock.calls, [['gpt-5.5']]);
  fireEvent.change(comboboxes[1], { target: { value: 'low' } });
  assert.deepEqual(onSelectEffort.mock.calls, [['low']]);
  fireEvent.change(comboboxes[2], { target: { value: 'plan' } });
  assert.deepEqual(onSelectPermissionMode.mock.calls, [['plan']]);

  // Both the close icon and the footer action are named Done; use the footer.
  const done = within(settings).getAllByRole('button', { name: 'Done' });
  fireEvent.click(done[done.length - 1]);
  assert.equal(screen.queryByRole('dialog'), null);

  // No advertised effort levels means no invented reasoning section.
  view.rerender(<Harness codexControls={controls()} overrides={{ ...overrides, availableEffortOptions: [] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add attachment or action' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Add to message' })).getByRole('button', { name: 'Chat settings' }));
  const settingsWithoutEffort = await screen.findByRole('dialog', { name: 'Chat settings' });
  assert.equal(within(settingsWithoutEffort).getAllByRole('combobox').length, 2);
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(screen.queryByRole('dialog'), null);
});

test('blocking questions and a held queue stay outside the sheet and keep their answers across it', async () => {
  stubPhone();
  const codex = mobileControls({
    queueHeld: true,
    questions: [{
      requestId: 'q-request', turnId: 'turn-1', isBlocking: true,
      questions: [{
        id: 'format', header: 'Format', question: 'Which format?', isOther: true, isSecret: false,
        options: [{ label: 'JSON', description: 'Structured' }],
      }],
    }],
  });
  const view = render(<Harness codexControls={codex} />);
  assert.equal(screen.queryByRole('button', { name: 'Resume queue' }), null);
  view.rerender(<Harness codexControls={codex} overrides={{ queuedDraft: { content: '', attachments: [], uploadedAttachments: [{ name: 'file.txt' }] } }} />);

  // Both stay beside the input, not behind a sheet.
  assert.ok(await screen.findByText('Which format?'));
  const resume = screen.getByRole('button', { name: 'Resume queue' });
  fireEvent.click(resume);
  assert.deepEqual(vi.mocked(codex.control).mock.calls, [[{ action: 'queue-resume' }]]);

  fireEvent.change(screen.getByLabelText('Which format?'), { target: { value: 'YAML' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add attachment or action' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Add to message' })).getByRole('button', { name: 'Chat settings' }));
  const settingsDone = within(await screen.findByRole('dialog', { name: 'Chat settings' }))
    .getAllByRole('button', { name: 'Done' });
  fireEvent.click(settingsDone[settingsDone.length - 1]);

  assert.equal((screen.getByLabelText('Which format?') as HTMLInputElement).value, 'YAML');
  fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
  await act(async () => {});
  assert.deepEqual(vi.mocked(codex.control).mock.calls.at(-1), [
    { action: 'answer', requestId: 'q-request', answers: { format: { answers: ['YAML'] } } },
  ]);
});

test('the mobile Plan badge follows native app-server plan, never SDK or an unsupported permission mode', async () => {
  stubPhone();
  const view = render(
    <Harness codexControls={controls()} overrides={{ permissionMode: 'default' }} />,
  );
  const tools = () => screen.getByRole('button', { name: 'Add attachment or action' })
    .closest('[data-slot="prompt-input-tools"]');
  assert.equal(within(tools() as HTMLElement).queryByText('Plan'), null);

  // Native app-server plan shows even though the generic permission is default.
  view.rerender(
    <Harness codexControls={mobileControls({ mode: 'plan' })} overrides={{ permissionMode: 'default' }} />,
  );
  assert.ok(within(tools() as HTMLElement).getByText('Plan'));

  // A stale native plan on the SDK runtime is not a real plan session.
  view.rerender(
    <Harness codexControls={mobileControls({ runtime: 'sdk', mode: 'plan' })} overrides={{ permissionMode: 'default' }} />,
  );
  assert.equal(within(tools() as HTMLElement).queryByText('Plan'), null);

  view.rerender(
    <Harness codexControls={mobileControls({ mode: 'default' })} overrides={{ permissionMode: 'default' }} />,
  );
  assert.equal(within(tools() as HTMLElement).queryByText('Plan'), null);

  // Without Codex, only a provider that actually advertises Plan shows it.
  view.rerender(
    <Harness codexControls={controls()} overrides={{ codexControls: undefined, providerLabel: 'Claude', permissionMode: 'plan', availablePermissionModes: ['default', 'plan'] }} />,
  );
  assert.ok(within(tools() as HTMLElement).getByText('Plan'));

  view.rerender(
    <Harness codexControls={controls()} overrides={{ codexControls: undefined, providerLabel: 'DeepSeek Harness', permissionMode: 'plan', availablePermissionModes: ['default'] }} />,
  );
  assert.equal(within(tools() as HTMLElement).queryByText('Plan'), null);
});

test('leaving the phone with either sheet open closes it, unlocks body scroll and does not reopen on return', async () => {
  stubPhone();
  render(<Harness codexControls={controls()} />);
  const resizeTo = async (width: number) => {
    vi.stubGlobal('innerWidth', width);
    await act(async () => { window.dispatchEvent(new Event('resize')); });
  };

  for (const sheetName of ['Add to message', 'Chat settings']) {
    if (sheetName === 'Chat settings') {
      fireEvent.click(screen.getByRole('button', { name: 'Add attachment or action' }));
      fireEvent.click(within(await screen.findByRole('dialog', { name: 'Add to message' })).getByRole('button', { name: 'Chat settings' }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Add attachment or action' }));
    }
    assert.ok(await screen.findByRole('dialog', { name: sheetName }));
    assert.equal(String(document.body.style.overflow), 'hidden');

    await resizeTo(1024);
    assert.equal(screen.queryAllByRole('dialog').length, 0, `${sheetName} must close on desktop`);
    assert.equal(document.body.style.overflow, '');

    await resizeTo(412);
    assert.equal(screen.queryAllByRole('dialog').length, 0, `${sheetName} must stay closed back on mobile`);
  }
});

test('a short mobile draft recomputes the textarea height when the layout changes, keeping value and caret', async () => {
  stubPhone();
  const onSubmit = vi.fn((event: Event) => event.preventDefault());
  render(<Harness codexControls={controls()} overrides={{ onSubmit: onSubmit as never }} />);
  const textarea = await findTextarea();
  const form = textarea.closest('form')!;
  form.addEventListener('submit', onSubmit);

  // Model the real measurement: the mobile 16px font wraps sooner and is
  // taller than the desktop 14px one, so a stale inline height is observable.
  Object.defineProperty(textarea, 'scrollHeight', {
    configurable: true,
    get: () => (window.innerWidth < 640 ? 96 : 64),
  });
  await act(async () => { fireEvent.change(textarea, { target: { value: 'short draft' } }); });
  await act(async () => { fireEvent.input(textarea); });
  assert.equal(textarea.style.height, '96px');

  textarea.setSelectionRange(3, 7);
  const resizeTo = async (width: number) => {
    vi.stubGlobal('innerWidth', width);
    await act(async () => { window.dispatchEvent(new Event('resize')); });
  };
  await resizeTo(1024);
  assert.equal(textarea.style.height, '64px');
  assert.equal(textarea.value, 'short draft');
  assert.deepEqual([textarea.selectionStart, textarea.selectionEnd], [3, 7]);

  await resizeTo(412);
  assert.equal(textarea.style.height, '96px');
  assert.equal(onSubmit.mock.calls.length, 0);

  // Blank desktop keeps its native two-row height rather than an expanded one.
  await act(async () => { fireEvent.change(textarea, { target: { value: '' } }); });
  await resizeTo(1024);
  assert.equal(textarea.style.height, 'auto');
  assert.equal(textarea.getAttribute('rows'), null);
});

test('the inline schedule menu works inside the + sheet and schedules without submitting', async () => {
  stubPhone();
  const onScheduleMessage = vi.fn();
  const onSubmit = vi.fn((event: Event) => event.preventDefault());
  render(
    <Harness
      codexControls={controls()}
      overrides={{ onScheduleMessage, onSubmit: onSubmit as never }}
    />,
  );

  const textarea = await findTextarea();
  await act(async () => { fireEvent.change(textarea, { target: { value: 'send this later' } }); });
  fireEvent.click(screen.getByRole('button', { name: 'Add attachment or action' }));
  const actions = await screen.findByRole('dialog', { name: 'Add to message' });
  fireEvent.click(within(actions).getByRole('button', { name: 'Schedule this message' }));

  const menu = within(actions).getByRole('menu', { name: 'Schedule this message' });
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: /In 15 minutes/ }));
  assert.equal(onScheduleMessage.mock.calls.length, 1);
  assert.ok(onScheduleMessage.mock.calls[0][0] instanceof Date);
  assert.equal(onSubmit.mock.calls.length, 0);
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(textarea.value, 'send this later');
});
