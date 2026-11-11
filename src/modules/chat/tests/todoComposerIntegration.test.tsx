import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts, writeDraftMeta } from '@/shared/chatDrafts';
import type { CodexControls, PermissionMode, Project, ProjectSession, ToolPermissionDecision } from '@/shared/types';

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-a' };
const META = {
  todoIds: ['todo-1'],
  attachments: [{ path: '/store/spec.md', name: 'spec.md', size: 4 }],
};
const createdTodos: FormData[] = [];
let sentMessages: unknown[] = [];

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      assets: { uploadFiles: () => okJson({ attachments: [] }) },
      todos: {
        create: (_pid: string, formData: FormData) => {
          createdTodos.push(formData);
          return Promise.resolve(new Response('{}', { status: 200 }));
        },
      },
    },
  };
});

const missingModelControls = (): CodexControls => ({
  sessionId: SESSION.id,
  state: {
    runtime: 'app-server', mode: 'default', phase: 'idle', turnId: null, goal: null, questions: [],
    modelSelection: { modelProvider: 'beta', model: null },
  },
  goalsEnabled: true,
  predictionsSupported: false,
  pending: false, error: null, delivery: null,
  control: vi.fn().mockResolvedValue(undefined), steer: vi.fn().mockResolvedValue(undefined),
});

type Args = { isLoading: boolean; codexControls?: CodexControls; onAbortSession: () => void; background?: boolean };

function Harness({ isLoading, codexControls, onAbortSession, background = false }: Args) {
  const send = (message: unknown) => { sentMessages.push(message); };
  const composer = useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    provider: 'codex',
    permissionMode: 'default',
    cyclePermissionMode: vi.fn(),
    resolvePermissionModeForProvider: (_provider, mode) => mode as PermissionMode,
    currentProviderModel: 'gpt-5.4',
    currentProviderEffort: 'high',
    isLoading,
    codexControls,
    processingSessions: background
      ? new Map([[SESSION.id, { background: true, tasks: [] }]]) as never
      : undefined,
    supportsSideQuestions: true,
    canAbortSession: true,
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
      isLoading={isLoading}
      onAbortSession={onAbortSession}
      canAbortSession
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
      queuedDrafts={composer.queuedDrafts}
      codexControls={codexControls}
      backgroundSendPrompt={composer.backgroundSendPrompt}
      onResolveBackgroundSendPrompt={composer.resolveBackgroundSendPrompt}
      supportsSideQuestions
      isEditingSentMessage={false}
      onCancelEditMessage={composer.cancelEditMessage}
      scheduledMessages={[]}
      onScheduleMessage={() => {}}
      onCancelScheduledMessage={() => {}}
      onEditQueuedDraft={composer.editQueuedDraft}
      onDeleteQueuedDraft={composer.deleteQueuedDraft}
      onSendMenuChoice={composer.handleSendMenuChoice}
      attachedFiles={composer.attachedFiles}
      storedAttachments={composer.storedAttachments}
      todoSourceIds={composer.todoSourceIds}
      todoNotice={composer.todoNotice}
      localTodoCommand={composer.localTodoCommand}
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
      placeholder="Ask Codex"
      isTextareaExpanded={composer.isTextareaExpanded}
      isInputFocused={composer.isInputFocused}
      onInputFocusChange={composer.handleInputFocusChange}
      composerPrediction={composer.composerPrediction}
    />
  );
}

const findTextarea = async () => screen.findByRole('textbox', { name: 'Ask Codex' }) as Promise<HTMLTextAreaElement>;

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  createdTodos.length = 0;
  sentMessages = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
    String(url).includes('/files') ? [] : { success: true, data: [], commands: [], drafts: [], preferences: {} },
  ), { status: 200 }))));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetChatDrafts();
});

test('the real send button runs a local /todo save even with no model and no turn', async () => {
  const onAbortSession = vi.fn();
  render(<Harness isLoading={false} codexControls={missingModelControls()} onAbortSession={onAbortSession} />);
  const textarea = await findTextarea();
  await act(async () => { fireEvent.change(textarea, { target: { value: '/todo save this' } }); });

  const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
  assert.equal(send.disabled, false);
  await act(async () => { fireEvent.click(send); });

  assert.equal(createdTodos.length, 1);
  assert.equal(createdTodos[0].get('content'), 'save this');
  assert.equal(onAbortSession.mock.calls.length, 0);
});

test('an ordinary message still cannot send while the Codex model is missing', async () => {
  render(<Harness isLoading={false} codexControls={missingModelControls()} onAbortSession={() => {}} />);
  const textarea = await findTextarea();
  await act(async () => { fireEvent.change(textarea, { target: { value: 'ordinary message' } }); });

  assert.equal((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled, true);
});

test('stored attachments alone are sendable and never mistaken for an empty composer', async () => {
  writeDraftMeta(SESSION.id, { todoIds: [], attachments: [{ path: '/store/a.txt', name: 'a.txt' }] });
  render(<Harness isLoading={false} onAbortSession={() => {}} />);

  const submit = (await screen.findAllByRole('button')).find((button) => button.getAttribute('aria-label') === 'Send') as HTMLButtonElement;
  assert.ok(submit, 'the send button exists for a stored-attachment-only draft');
  assert.equal(submit.disabled, false);
  await act(async () => { fireEvent.click(submit); });

  const sent = sentMessages.at(-1) as { content: string; options: { attachments?: unknown[] } };
  assert.equal(sent.content, '');
  assert.deepEqual(sent.options.attachments, [{ path: '/store/a.txt', name: 'a.txt' }]);
});

test('a running turn shows the explicit send menu instead of turning a stored-attachment draft into Stop', async () => {
  writeDraftMeta(SESSION.id, { todoIds: [], attachments: [{ path: '/store/a.txt', name: 'a.txt' }] });
  const onAbortSession = vi.fn();
  render(<Harness isLoading onAbortSession={onAbortSession} />);

  const menu = await screen.findByRole('button', { name: 'Send options' });
  assert.ok(menu);
  await act(async () => { fireEvent.click(menu); });
  // Opening the caret menu never stops the turn; Stop is a separate row choice.
  assert.equal(onAbortSession.mock.calls.length, 0);
});


test('the real background dialog hides the side question for a source send and restores it after detach', async () => {
  writeDraftMeta(SESSION.id, META);
  render(<Harness isLoading={false} background onAbortSession={() => {}} />);
  const textarea = await findTextarea();
  await act(async () => { fireEvent.change(textarea, { target: { value: 'todo body' } }); });
  const send = (await screen.findAllByRole('button')).find((button) => button.getAttribute('aria-label') === 'Send') as HTMLButtonElement;
  await act(async () => { fireEvent.click(send); });

  await screen.findByRole('button', { name: 'Queue' });
  assert.equal(screen.queryByRole('button', { name: 'Side question' }), null);
});

test('a background dialog without a todo source still offers the side question', async () => {
  render(<Harness isLoading={false} background onAbortSession={() => {}} />);
  const textarea = await findTextarea();
  await act(async () => { fireEvent.change(textarea, { target: { value: 'ordinary text' } }); });
  const send = (await screen.findAllByRole('button')).find((button) => button.getAttribute('aria-label') === 'Send') as HTMLButtonElement;
  await act(async () => { fireEvent.click(send); });

  await screen.findByRole('button', { name: 'Queue' });
  assert.ok(screen.getByRole('button', { name: 'Side question' }));
});
