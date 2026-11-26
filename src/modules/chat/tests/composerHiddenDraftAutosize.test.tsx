import assert from 'node:assert/strict';

import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession, ToolPermissionDecision } from '@/shared/types';

/**
 * Switching sessions while another workspace tab hides the chat restores the
 * draft, but the composer has no layout then: `scrollHeight` is 0 and a
 * measurement taken in that commit would cache the collapsed height. The
 * composer has to wait for the visible commit and then re-run the same autosize
 * (and mention-overlay scroll sync) before paint, keeping the draft text intact.
 */

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-b' };
const LONG_DRAFT = Array.from({ length: 8 }, (_, index) => `line ${index + 1} of the restored draft`).join('\n');
const VISIBLE_HEIGHT = 132;

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
      providers: { skills: () => okJson({ data: { skills: [] } }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      getFiles: () => okJson([]),
    },
  };
});

type Args = { isVisible: boolean };

type ProbeArgs = {
  textareaRef: { current: HTMLTextAreaElement | null };
  passiveHeights: Array<string | undefined>;
};

/** Records the inline height when passive effects flush, i.e. what the layout phase already committed. */
function PassiveHeightProbe({ textareaRef, passiveHeights }: ProbeArgs) {
  useEffect(() => {
    passiveHeights.push(textareaRef.current?.style.height);
  });
  return null;
}

function Harness({ isVisible, passiveHeights }: Args & { passiveHeights: ProbeArgs['passiveHeights'] }) {
  const composer = useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: vi.fn(),
    resolvePermissionModeForProvider: (_provider, mode) => mode as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'high',
    isLoading: false,
    canAbortSession: true,
    tokenBudget: null,
    sendMessage: () => {},
    scrollToBottom() {},
    addMessage() {},
    setIsUserScrolledUp() {},
    setPendingPermissionRequests() {},
    isVisible,
  });
  return (
    <>
      {/* First sibling on purpose: its passive effect runs before ChatComposer's
          own passive effects, so the height it records can only come from the
          layout phase. */}
      <PassiveHeightProbe textareaRef={composer.textareaRef} passiveHeights={passiveHeights} />
      <ChatComposer
        pendingPermissionRequests={[]}
        handlePermissionDecision={(_ids: string | string[], _decision: ToolPermissionDecision) => {}}
        handleGrantToolPermission={() => ({ success: false })}
        activity={null}
        isLoading={false}
        onAbortSession={() => {}}
        canAbortSession
        permissionMode="default"
        availablePermissionModes={['default']}
        onSelectPermissionMode={() => {}}
        providerLabel="Claude"
        effort="high"
        availableEffortOptions={[]}
        onSelectEffort={() => {}}
        model="test-model"
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
        backgroundSendPrompt={composer.backgroundSendPrompt}
        onResolveBackgroundSendPrompt={composer.resolveBackgroundSendPrompt}
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
        attachmentRejections={composer.attachmentRejections}
        onDismissAttachmentRejections={composer.dismissAttachmentRejections}
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
        placeholder="Ask Claude"
        isTextareaExpanded={composer.isTextareaExpanded}
        isInputFocused={composer.isInputFocused}
        onInputFocusChange={composer.handleInputFocusChange}
        isVisible={isVisible}
        composerPrediction={composer.composerPrediction}
      />
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  // The hook restores drafts synchronously from the mirror, so this is the
  // draft the hidden composer starts with — exactly the session-switch case.
  writeDraftText(SESSION.id, LONG_DRAFT);
});

let restoreScrollHeight: (() => void) | null = null;

afterEach(() => {
  restoreScrollHeight?.();
  restoreScrollHeight = null;
  resetChatDrafts();
  vi.unstubAllGlobals();
});

test('a hidden restored draft is measured once when the chat becomes visible, and keeps its text', async () => {
  // jsdom always reports 0, so stand in for the real layout: a hidden textarea
  // has no content height, a visible one reports its wrapped line height. Each
  // read is recorded so the assertion is about the production measurement, not
  // about a test double's own bookkeeping.
  const scrollHeightReads: number[] = [];
  let chatVisible = false;
  const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!(this instanceof HTMLTextAreaElement)) return originalScrollHeight?.get?.call(this) ?? 0;
      scrollHeightReads.push(chatVisible ? VISIBLE_HEIGHT : 0);
      return chatVisible ? VISIBLE_HEIGHT : 0;
    },
  });
  restoreScrollHeight = () => {
    if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  };

  const passiveHeights: ProbeArgs['passiveHeights'] = [];
  const view = render(<Harness isVisible={false} passiveHeights={passiveHeights} />);
  const textarea = (await screen.findByRole('textbox', { name: 'Ask Claude' })) as HTMLTextAreaElement;
  const highlight = textarea.previousElementSibling as HTMLDivElement;

  // Hidden: the restored draft is kept, but the composer never reads a layout.
  assert.equal(textarea.value, LONG_DRAFT);
  assert.deepEqual(scrollHeightReads, []);
  assert.equal(textarea.style.height, '');
  assert.equal(passiveHeights.at(-1), '');

  // The mention highlight layer already sat scrolled away while this text was
  // longer than the box.
  Object.defineProperty(textarea, 'scrollTop', { configurable: true, value: 48, writable: true });
  Object.defineProperty(textarea, 'scrollLeft', { configurable: true, value: 2, writable: true });

  chatVisible = true;
  view.rerender(<Harness isVisible passiveHeights={passiveHeights} />);

  // Exactly one production measurement for the visible commit; the hook's
  // passive fallback must see the layout measurement's cache and not repeat it.
  assert.deepEqual(scrollHeightReads, [VISIBLE_HEIGHT]);
  assert.equal(textarea.style.height, `${VISIBLE_HEIGHT}px`);
  // The height is already written before any passive effect runs, i.e. the real
  // onTextareaResize ran in the layout phase before paint.
  assert.equal(passiveHeights.at(-1), `${VISIBLE_HEIGHT}px`);
  // The draft is restored verbatim, and the highlight overlay follows the box.
  assert.equal(textarea.value, LONG_DRAFT);
  assert.equal(highlight.scrollTop, 48);
  assert.equal(highlight.scrollLeft, 2);
});
