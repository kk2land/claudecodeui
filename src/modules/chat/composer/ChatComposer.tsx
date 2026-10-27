import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import { PaperclipIcon, MessageSquareIcon, XIcon, Loader2, ArrowUpIcon, PencilIcon, PlusIcon, SlidersHorizontalIcon, ActivityIcon, MicIcon } from 'lucide-react';

import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { useVoiceAvailable } from '@/modules/chat/hooks/useVoiceAvailable';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { DEFAULT_EFFORT_VALUE, MAX_QUEUED_MESSAGES } from '@/shared/constants';
import { CodexControlPanel } from '@/modules/chat/composer/CodexControlPanel';
import { ProviderRuntimePanel } from '@/modules/chat/composer/ProviderRuntimePanel';
import type { BackgroundSendChoice, BackgroundSendPrompt, ToolPermissionDecision, CodexControls, ComposerPredictionControls, ProviderRuntimeControls, QueuedDraft, ScheduledMessage, SlashCommand,SessionActivity,PendingPermissionRequest,PermissionMode,ProviderModelOption } from '@/shared/types';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '@/modules/chat/composer/PromptInput';
import CommandMenu from '@/modules/chat/composer/CommandMenu';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import ComposerAttachment from '@/modules/chat/composer/ComposerAttachment';
import VoiceInputButton from '@/modules/chat/composer/VoiceInputButton';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import BackgroundSendDialog from '@/modules/chat/composer/BackgroundSendDialog';
import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';
import { ScheduledMessageList } from '@/modules/chat/composer/ScheduledMessageList';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';
import { ComposerPredictionActions, ComposerPredictionStatus } from '@/modules/chat/composer/ComposerPrediction';
import { MobileComposerSheet, MobileSheetAction } from '@/modules/chat/composer/MobileComposerSheet';

type MentionableFile = {
  name: string;
  path: string;
};

type ChatComposerProps = {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: ToolPermissionDecision,
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  activity: SessionActivity | null;
  isLoading: boolean;
  onAbortSession: () => void;
  permissionMode: PermissionMode;
  availablePermissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
  providerLabel: string;
  effort: string;
  availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  model: string;
  availableModelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  /** The whole pending FIFO queue for the open session, oldest first. */
  queuedDrafts?: QueuedDraft[];
  /** Head of `queuedDrafts`; retained for single-message callers and tests. */
  queuedDraft?: QueuedDraft | null;
  codexControls?: CodexControls;
  runtimeControls?: ProviderRuntimeControls;
  onExecutePlan?: () => void;
  backgroundSendPrompt: BackgroundSendPrompt | null;
  onResolveBackgroundSendPrompt: (choice: BackgroundSendChoice) => void;
  /** Set while the composer is replacing an already-sent message. */
  isEditingSentMessage: boolean;
  onCancelEditMessage: () => void;
  /** Messages waiting to be sent to this session later. */
  scheduledMessages: ScheduledMessage[];
  onScheduleMessage: (scheduledFor: Date) => void;
  onCancelScheduledMessage: (id: string) => void;
  /** `id` is preferred; `position` keeps unticketed legacy entries addressable. */
  onEditQueuedDraft: (id?: string, position?: number) => void;
  onDeleteQueuedDraft: (id?: string, position?: number) => void;
  attachedFiles: File[];
  onRemoveAttachment: (index: number) => void;
  fileErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openAttachmentPicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onVoiceTranscript?: (text: string, send?: boolean) => void;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  /** Re-runs the composer's own autosize after the mobile/desktop frame changes. */
  onTextareaResize?: (target: HTMLTextAreaElement) => void;
  isInputFocused?: boolean;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
  /**
   * Codex's native next-message suggestion plus its persisted switch. Optional
   * so existing fixtures and non-Codex composers need no changes.
   */
  composerPrediction?: ComposerPredictionControls;
};

/**
 * Rendered by chat's ChatInterface as the whole input area: textarea, pending
 * attachments, queued message, permission banner, voice input and the
 * model/permission popovers that drive the next turn.
 */
export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  activity,
  isLoading,
  onAbortSession,
  permissionMode,
  availablePermissionModes,
  onSelectPermissionMode,
  providerLabel,
  effort,
  availableEffortOptions,
  onSelectEffort,
  model,
  availableModelOptions,
  onSelectModel,
  modelsLoading,
  tokenBudget,
  onShowTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  onSubmit,
  isDragActive,
  queuedDraft,
  queuedDrafts,
  codexControls,
  runtimeControls,
  onExecutePlan,
  backgroundSendPrompt,
  onResolveBackgroundSendPrompt,
  isEditingSentMessage,
  onCancelEditMessage,
  scheduledMessages,
  onScheduleMessage,
  onCancelScheduledMessage,
  onEditQueuedDraft,
  onDeleteQueuedDraft,
  attachedFiles,
  onRemoveAttachment,
  fileErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openAttachmentPicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onVoiceTranscript,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onTextareaResize,
  isInputFocused = false,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
  composerPrediction,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  const fileDropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedFileRef = useRef<HTMLDivElement | null>(null);
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [isCommandMenuOpen, textareaRef]);

  useEffect(() => {
    const dropdown = fileDropdownRef.current;
    const selectedFile = selectedFileRef.current;
    if (!showFileDropdown || !dropdown || !selectedFile) {
      return;
    }

    const itemTop = selectedFile.offsetTop;
    const itemBottom = itemTop + selectedFile.offsetHeight;
    const visibleTop = dropdown.scrollTop;
    const visibleBottom = visibleTop + dropdown.clientHeight;

    if (itemTop < visibleTop) {
      dropdown.scrollTop = itemTop;
    } else if (itemBottom > visibleBottom) {
      dropdown.scrollTop = itemBottom - dropdown.clientHeight;
    }
  }, [selectedFileIndex, showFileDropdown]);

  // Voice state is hosted here (not in the mic button) so the main Send button can stop
  // recording and send the transcript in one tap, the way the mic button drops it in the box.
  const voiceAvailable = useVoiceAvailable();
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVoiceError = useCallback((msg: string) => {
    setVoiceError(msg);
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
    voiceErrorTimer.current = setTimeout(() => setVoiceError(null), 4000);
  }, []);
  useEffect(() => () => {
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
  }, []);
  const noopTranscript = useCallback(() => {}, []);
  const { state: voiceState, toggle: voiceToggle, stop: voiceStop } = useVoiceInput(
    onVoiceTranscript ?? noopTranscript,
    handleVoiceError,
  );
  const isRecording = voiceState === 'recording';
  const isTranscribing = voiceState === 'transcribing';

  // The mobile layout is gated by the same 640px breakpoint as the composer's
  // sm: utilities, so CSS and the React branches below cannot disagree.
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 640, trackPWA: false });
  // Which bottom sheet is open, if any. Kept here because both the collapsed +
  // and the expanded settings entry open them, and the provider panels portal
  // into the settings sheet.
  const [mobileSheet, setMobileSheet] = useState<'actions' | 'settings' | null>(null);
  // The settings sheet's portal host. A ref callback stores the mounted node; it
  // becomes null when the sheet closes, which hides routine provider settings
  // again while their panels stay mounted for blocking questions.
  const [mobileSettingsHost, setMobileSettingsHost] = useState<HTMLDivElement | null>(null);
  // Stable so React does not detach/reattach the portal host every render.
  const setMobileSettingsNode = useCallback((node: HTMLDivElement | null) => {
    setMobileSettingsHost((previous) => (previous === node ? previous : node));
  }, []);

  // The sheets are phone-only chrome. Leaving the phone closes them through the
  // shared Dialog's own open=false path so its overlay, scroll lock and saved
  // focus are released; returning to the phone keeps them closed. Adjusting
  // during render discards the stale value before it can paint.
  if (!isMobile && mobileSheet !== null) setMobileSheet(null);

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // Hide the thinking/status bar while any permission request is pending
  const hasPendingPermissions = pendingPermissionRequests.length > 0;
  // Provider toolbars sit above the input, so their activity belongs inside it.
  const hasControlPanel = Boolean(codexControls || runtimeControls);
  // Keep status components mounted while idle so their exit animation can finish.
  const showFloatingActivity = !hasPendingPermissions && !hasControlPanel;
  const hasFloatingActivityIndicator = Boolean(activity && showFloatingActivity);

  // Native Codex Plan is owned by its app-server runtime, not the generic
  // permission mode; SDK sessions can carry a stale native mode. Other
  // providers only advertise Plan through their real permission capabilities.
  const isPlanMode = codexControls
    ? codexControls.state?.runtime === 'app-server' && codexControls.state.mode === 'plan'
    : permissionMode === 'plan' && availablePermissionModes.includes('plan');

  // A blank, unfocused mobile composer is the single-line capsule. Any draft,
  // attachment, edit, or live recording keeps it expanded so state is never
  // hidden behind a sheet or collapsed under the user's caret. While a sheet is
  // open the expanded frame stays behind it so its trigger remains mounted for
  // focus restoration and closing does not jump the layout.
  const mobileCompact = isMobile
    && mobileSheet === null
    && !isInputFocused
    && input.trim().length === 0
    && attachedFiles.length === 0
    && !isEditingSentMessage
    && !isRecording
    && !isTranscribing;

  const hasDraft = input.trim().length > 0;

  // Mobile and desktop frames use different rows, font sizes and min heights,
  // but the inline height written by the last autosize overrides those classes.
  // Re-measure with the hook's own routine when only the frame changes; typing
  // keeps its existing onInput autosize, so this is not a per-keystroke layout.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!hasDraft) {
      // Blank desktop must keep its native two-row height, never expanded.
      textarea.style.height = 'auto';
      return;
    }
    // The textarea transitions all properties for 150ms; measuring mid-flight
    // would freeze an interpolated padding/font height. Reading scrollHeight
    // forces the final CSS layout, so suppress the transition for this one
    // measurement and restore it before paint.
    const previousTransition = textarea.style.transition;
    textarea.style.transition = 'none';
    try {
      onTextareaResize?.(textarea);
      onTextareaScrollSync(textarea);
    } finally {
      textarea.style.transition = previousTransition;
    }
  }, [isMobile, mobileCompact, hasDraft, textareaRef, onTextareaResize, onTextareaScrollSync]);

  // Every card renders in FIFO order; `queuedDraft` alone is still honoured so
  // single-message callers keep working.
  const pendingDrafts = queuedDrafts ?? (queuedDraft ? [queuedDraft] : []);
  const hasQueuedDraft = pendingDrafts.length > 0;
  const queueFull = pendingDrafts.length >= MAX_QUEUED_MESSAGES;
  // A full queue still routes a submit through the queue action: the hook
  // rejects it visibly and keeps the text. Falling through to `onAbortSession`
  // would stop the running turn instead of refusing the fourth message.
  const canQueueDraft = isLoading && Boolean(input.trim() || attachedFiles.length > 0);
  const submitHint = queueFull && isLoading
    ? t('input.hintText.queueFull', {
      count: MAX_QUEUED_MESSAGES,
      defaultValue: 'Queue is full ({{count}}). Send or delete one first',
    })
    : canQueueDraft
      ? hasQueuedDraft
        ? t('input.hintText.queueNext', { defaultValue: 'Enter to queue another message' })
        : t('input.hintText.queue', { defaultValue: 'Enter to queue your next message' })
      : sendByCtrlEnter
        ? t('input.hintText.ctrlEnter')
        : t('input.hintText.enter');
  const submitAriaLabel = canQueueDraft
    ? t('input.queue.sendNext', { defaultValue: 'Queue next message' })
    : isLoading
      ? t('input.stop')
      : t('input.send');

  // A visible native suggestion is painted through the textarea's own
  // placeholder, so its value, draft and mention highlight stay untouched until
  // the user accepts it. `input === ''` mirrors the prediction hook's own
  // condition; any other text falls back to the ordinary placeholder.
  const composerSuggestionHint = input === '' ? composerPrediction?.suggestion ?? null : null;
  // The capsule needs a short hint; the full placeholder stays the accessible
  // name and returns as soon as the composer expands.
  const compactPlaceholder = t('mobileComposer.compactPlaceholder', {
    provider: providerLabel,
    defaultValue: 'Ask {{provider}}',
  });
  const textareaPlaceholder = mobileCompact
    ? compactPlaceholder
    : composerSuggestionHint ?? placeholder;

  const selectedModelOption = availableModelOptions.find((option) => option.value === model);
  const modelLabel = selectedModelOption?.label || model;
  const effortLabel = effort === DEFAULT_EFFORT_VALUE
    ? t('mobileComposer.effortDefault', { defaultValue: 'Default' })
    : effort;
  const mobileConfigLabel = modelLabel
    || (availableEffortOptions.length > 0 ? effortLabel : t('mobileComposer.modelSettings', { defaultValue: 'Model & runtime' }));
  const showMobileEffort = availableEffortOptions.length > 0 && effort !== DEFAULT_EFFORT_VALUE;

  // One submit control for desktop and mobile: desktop renders it in the
  // historical right cluster, the mobile capsule/dock in the same footer slot.
  const submitButton = (
    <PromptInputSubmit
      onClick={
        canQueueDraft
          ? (e: MouseEvent<HTMLButtonElement>) => {
              e.preventDefault();
              onSubmit(e);
            }
          : isLoading
            ? onAbortSession
            : isRecording
              ? (e: MouseEvent<HTMLButtonElement>) => {
                  e.preventDefault();
                  voiceStop({ send: true });
                }
              : undefined
      }
      disabled={
        isLoading
          ? false
          : isRecording
            ? false
            : isTranscribing
              ? true
              : !input.trim() && attachedFiles.length === 0
      }
      aria-label={submitAriaLabel}
      title={submitAriaLabel}
      className={isMobile ? 'h-11 w-11 shrink-0 rounded-full' : 'h-10 w-10 shrink-0 sm:h-10 sm:w-10'}
    >
      {isTranscribing ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : canQueueDraft ? (
        <ArrowUpIcon className="h-4 w-4" />
      ) : undefined}
    </PromptInputSubmit>
  );

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6">
      {showFloatingActivity && (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-10 w-[calc(100%-1rem)] max-w-[54.25rem] -translate-x-1/2 translate-y-px bg-transparent sm:w-[calc(100%-2rem)]">
          <ActivityIndicator activity={activity} onAbort={onAbortSession} isInputFocused={isInputFocused} />
        </div>
      )}

      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-[54.25rem]">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
          />
        </div>
      )}

      <ScheduledMessageList
        scheduledMessages={scheduledMessages}
        onCancel={onCancelScheduledMessage}
      />

      {isEditingSentMessage && (
        <div className="mx-auto mb-2 flex max-w-[54.25rem] items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
          <PencilIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1">
            {t('composer.editing.title')}
            {' — '}
            <span className="text-muted-foreground">{t('composer.editing.filesNotReverted')}</span>
          </span>
          <button
            type="button"
            onClick={onCancelEditMessage}
            className="shrink-0 rounded-md px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('composer.editing.cancel')}
          </button>
        </div>
      )}

      {codexControls && <CodexControlPanel key={codexControls.sessionId ?? 'new'} controls={codexControls} hasQueuedDraft={hasQueuedDraft} onExecutePlan={onExecutePlan ?? (() => {})} settingsContainer={isMobile ? mobileSettingsHost : undefined} />}
      {runtimeControls && <ProviderRuntimePanel key={`${providerLabel}:${runtimeControls.sessionId ?? 'new'}`} controls={runtimeControls} hasQueuedDraft={hasQueuedDraft} providerLabel={providerLabel} settingsContainer={isMobile ? mobileSettingsHost : undefined} />}
      <BackgroundSendDialog
        prompt={backgroundSendPrompt}
        onResolve={onResolveBackgroundSendPrompt}
      />

      {isMobile && hasControlPanel && !hasPendingPermissions && (
        <div className="mx-auto max-w-[54.25rem]">
          <ActivityIndicator activity={activity} onAbort={onAbortSession} variant="inline" />
        </div>
      )}

      {pendingDrafts.map((draft, index) => (
        <QueuedMessageCard
          key={draft.id ?? `${index}-${draft.content.slice(0, 24)}`}
          content={draft.content}
          attachmentCount={draft.uploadedAttachments?.length ?? draft.attachments.length}
          controls={codexControls}
          canSteerMode={draft.options?.collaborationMode !== 'plan'}
          // Only the head is dispatchable next; later cards are shown in order
          // with the same edit/delete actions but cannot precede the head.
          isHead={index === 0}
          position={index + 1}
          total={pendingDrafts.length}
          onEdit={() => onEditQueuedDraft(draft.id, index)}
          onDelete={() => onDeleteQueuedDraft(draft.id, index)}
        />
      ))}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-[54.25rem]">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div
            ref={fileDropdownRef}
            className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md"
          >
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                ref={index === selectedFileIndex ? selectedFileRef : undefined}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={[
            isTextareaExpanded ? 'chat-input-expanded' : '',
            hasFloatingActivityIndicator && !isMobile ? 'rounded-t-none' : '',
            isMobile
              ? mobileCompact
                ? 'flex items-center gap-1 rounded-[1.375rem] px-1.5 py-1'
                : 'rounded-2xl'
              : '',
          ].filter(Boolean).join(' ')}
          {...getRootProps()}
        >
          {hasControlPanel && !hasPendingPermissions && !isMobile && (
            <ActivityIndicator activity={activity} onAbort={onAbortSession} variant="inline" />
          )}
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">Drop files here</p>
              </div>
            </div>
          )}

          {attachedFiles.length > 0 && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedFiles.map((file, index) => (
                    <ComposerAttachment
                      key={`${file.name}-${file.lastModified}-${index}`}
                      file={file}
                      onRemove={() => onRemoveAttachment(index)}
                      error={fileErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          <PromptInputBody className={isMobile && mobileCompact ? 'order-2 min-w-0 flex-1' : undefined}>
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div
                className={[
                  'chat-input-placeholder block w-full whitespace-pre-wrap break-words text-transparent',
                  isMobile ? 'px-3 py-2.5 text-base leading-6' : 'px-4 py-2 text-sm leading-6',
                ].join(' ')}
              >
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              // Keep the accessible name stable: the suggestion replaces the
              // placeholder visually but must not rename the field.
              aria-label={placeholder}
              placeholder={textareaPlaceholder}
              rows={isMobile ? (mobileCompact ? 1 : 3) : undefined}
              className={isMobile
                ? `px-3 py-2.5 text-base leading-6 ${mobileCompact ? '' : 'min-h-24'}`
                : undefined}
            />
            {composerSuggestionHint !== null && !isMobile && (
              <ComposerPredictionActions
                onAccept={() => { composerPrediction?.accept(); }}
                onDismiss={() => { composerPrediction?.dismiss(); }}
              />
            )}
        </PromptInputBody>

        <PromptInputFooter
          className={isMobile
            ? mobileCompact
              ? 'contents'
              : 'flex-wrap gap-y-1 border-t-0 px-2 py-1.5'
            : 'flex-wrap gap-y-1'}
        >
          <PromptInputTools className={isMobile ? `${mobileCompact ? 'order-1' : ''} min-w-0 shrink-0` : 'min-w-0'}>
            {isMobile ? (
              <>
              <PromptInputButton
                tooltip={{ content: t('mobileComposer.actions', { defaultValue: 'Add attachment or action' }) }}
                onClick={() => setMobileSheet('actions')}
                // Keep the textarea focused so tapping an expanded control does
                // not collapse the composer before the click lands.
                onPointerDown={(event) => event.preventDefault()}
                aria-label={t('mobileComposer.actions', { defaultValue: 'Add attachment or action' })}
                aria-haspopup="dialog"
                className={`${mobileCompact ? 'h-11 w-11' : 'h-9 w-9'} shrink-0 rounded-full border border-border/60 bg-muted/40 [&_svg]:size-5`}
              >
                <PlusIcon />
              </PromptInputButton>
              {isPlanMode && (
                <span className="shrink-0 whitespace-nowrap px-1 text-xs font-medium text-primary">
                  {t('mobileComposer.plan', { defaultValue: 'Plan' })}
                </span>
              )}
              {composerSuggestionHint !== null && !mobileCompact && (
                <ComposerPredictionActions
                  inline
                  onAccept={() => { composerPrediction?.accept(); }}
                  onDismiss={() => { composerPrediction?.dismiss(); }}
                />
              )}
              {(isRecording || isTranscribing) && (
                <VoiceInputButton state={voiceState} onToggle={voiceToggle} />
              )}
              </>
            ) : (
              <>
                <PromptInputButton
                  tooltip={{ content: t('input.attachFiles') }}
                  onClick={openAttachmentPicker}
                  aria-label={t('input.attachFiles')}
                >
                  <PaperclipIcon />
                </PromptInputButton>

                {onVoiceTranscript && voiceAvailable && (
                  <VoiceInputButton state={voiceState} onToggle={voiceToggle} errorMsg={voiceError} />
                )}

                <TokenUsageSummary provider={providerLabel.toLowerCase()} usage={tokenBudget} onClick={onShowTokenUsage} />

                {composerPrediction?.available && (
                  <ComposerPredictionStatus
                    unsupported={composerPrediction.unsupported}
                    enabled={composerPrediction.enabled}
                    onChange={composerPrediction.setEnabled}
                    pending={composerPrediction.pending}
                    unavailable={composerPrediction.unavailable}
                    unavailableReason={composerPrediction.unavailableReason}
                  />
                )}

                <PromptInputButton
                  tooltip={{ content: t('input.showAllCommands') }}
                  onClick={onToggleCommandMenu}
                  className="relative"
                >
                  <MessageSquareIcon />
                  {slashCommandsCount > 0 && (
                    <span
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                    >
                      {slashCommandsCount}
                    </span>
                  )}
                </PromptInputButton>

                {hasInput && (
                  <PromptInputButton
                    tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                    onClick={onClearInput}
                    className="hidden sm:flex"
                  >
                    <XIcon />
                  </PromptInputButton>
                )}
              </>
            )}
          </PromptInputTools>

          <div className={
            isMobile
              ? mobileCompact
                ? 'order-3 flex shrink-0 items-center gap-1.5 sm:gap-2'
                : 'ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:gap-2'
              : 'ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2'
          }>
            {!isMobile && (
              <>
                <ScheduleMessagePopover
                  disabled={!input.trim()}
                  onSchedule={onScheduleMessage}
                />

                <ComposerModelMenu
                  effort={effort}
                  effortOptions={availableEffortOptions}
                  onSelectEffort={onSelectEffort}
                  model={model}
                  modelOptions={availableModelOptions}
                  onSelectModel={onSelectModel}
                  modelsLoading={modelsLoading}
                />

                <ComposerPermissionMenu
                  permissionMode={permissionMode}
                  permissionModes={availablePermissionModes}
                  onSelectPermissionMode={onSelectPermissionMode}
                  providerLabel={providerLabel}
                />
              </>
            )}

            {isMobile && !mobileCompact && (
              <button
                type="button"
                onClick={() => setMobileSheet('settings')}
                // Same focus-preserving rule as +, since this button only exists
                // while the expanded composer is mounted.
                onPointerDown={(event) => event.preventDefault()}
                aria-haspopup="dialog"
                aria-label={t('mobileComposer.settings', { defaultValue: 'Chat settings' })}
                className="flex h-9 min-w-0 max-w-[9.5rem] items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <SlidersHorizontalIcon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate text-foreground">{mobileConfigLabel}</span>
                {showMobileEffort && (
                  <span className="hidden shrink-0 truncate text-muted-foreground min-[380px]:inline">· {effortLabel}</span>
                )}
              </button>
            )}

            {submitButton}
          </div>

          <div
            className={`order-last hidden basis-full px-2 text-center text-xs leading-4 text-muted-foreground/50 transition-opacity duration-200 lg:block ${
              input.trim() && !canQueueDraft ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {submitHint}
          </div>
        </PromptInputFooter>
        </PromptInput>

        <MobileComposerSheet
          open={isMobile && mobileSheet === 'actions'}
          onOpenChange={(open) => setMobileSheet(open ? 'actions' : null)}
          title={t('mobileComposer.actionsTitle', { defaultValue: 'Add to message' })}
          doneLabel={t('mobileComposer.done', { defaultValue: 'Done' })}
        >
          {(close) => (
            <div className="space-y-1">
              <MobileSheetAction
                icon={<SlidersHorizontalIcon />}
                label={t('mobileComposer.settings', { defaultValue: 'Chat settings' })}
                onClick={() => setMobileSheet('settings')}
              />
              <MobileSheetAction
                icon={<PaperclipIcon />}
                label={t('input.attachFiles')}
                onClick={() => { close(); openAttachmentPicker(); }}
              />
              {onVoiceTranscript && voiceAvailable && (
                <MobileSheetAction
                  icon={<MicIcon />}
                  label={isRecording ? t('voice.stopRecording') : t('voice.input')}
                  onClick={() => { close(); voiceToggle(); }}
                />
              )}
              <MobileSheetAction
                icon={<ActivityIcon />}
                label={t('mobileComposer.tokenUsage', { defaultValue: 'Token usage' })}
                onClick={() => { close(); onShowTokenUsage(); }}
              />
              <MobileSheetAction
                icon={<MessageSquareIcon />}
                label={t('input.showAllCommands')}
                badge={slashCommandsCount || undefined}
                onClick={() => { close(); requestAnimationFrame(onToggleCommandMenu); }}
              />
              {hasInput && (
                <MobileSheetAction
                  icon={<XIcon />}
                  label={t('input.clearInput', { defaultValue: 'Clear input' })}
                  onClick={() => { close(); onClearInput(); }}
                />
              )}
              {composerPrediction?.available && (
                <div className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5">
                  <span className="text-sm text-muted-foreground">
                    {t('mobileComposer.prediction', { defaultValue: 'Next-message suggestions' })}
                  </span>
                  <ComposerPredictionStatus
                    unsupported={composerPrediction.unsupported}
                    enabled={composerPrediction.enabled}
                    onChange={composerPrediction.setEnabled}
                    pending={composerPrediction.pending}
                    unavailable={composerPrediction.unavailable}
                    unavailableReason={composerPrediction.unavailableReason}
                  />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5">
                <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                  {t('schedule.trigger')}
                </span>
                <ScheduleMessagePopover
                  disabled={!input.trim()}
                  onSchedule={(scheduledFor) => { close(); onScheduleMessage(scheduledFor); }}
                  inline
                />
              </div>
            </div>
          )}
        </MobileComposerSheet>

        <MobileComposerSheet
          open={isMobile && mobileSheet === 'settings'}
          onOpenChange={(open) => setMobileSheet(open ? 'settings' : null)}
          title={t('mobileComposer.settingsTitle', { defaultValue: 'Chat settings' })}
          doneLabel={t('mobileComposer.done', { defaultValue: 'Done' })}
        >
          {() => (
            <div className="space-y-4">
              <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium">
                <span>{t('mobileComposer.model', { defaultValue: 'Model' })}</span>
                <select
                  value={model}
                  onChange={(event) => onSelectModel(event.target.value)}
                  disabled={modelsLoading && availableModelOptions.length === 0}
                  className="h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {availableModelOptions.length === 0 && (
                    <option value={model}>
                      {modelsLoading
                        ? t('mobileComposer.loadingModels', { defaultValue: 'Loading models…' })
                        : model || t('mobileComposer.noModels', { defaultValue: 'No models available' })}
                    </option>
                  )}
                  {availableModelOptions.length > 0
                    && !availableModelOptions.some((option) => option.value === model) && (
                      <option value={model}>{modelLabel}</option>
                    )}
                  {availableModelOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label || option.value}</option>
                  ))}
                </select>
              </label>

              {availableEffortOptions.length > 0 && (
                <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium">
                  <span>{t('mobileComposer.reasoning', { defaultValue: 'Reasoning' })}</span>
                  <select
                    value={effort}
                    onChange={(event) => onSelectEffort(event.target.value)}
                    className="h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value={DEFAULT_EFFORT_VALUE}>{t('mobileComposer.effortDefault', { defaultValue: 'Default' })}</option>
                    {availableEffortOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.value}</option>
                    ))}
                  </select>
                </label>
              )}

              {availablePermissionModes.length > 0 && (
                <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium">
                  <span>{t('mobileComposer.permissions', { defaultValue: 'Permissions' })}</span>
                  <select
                    value={permissionMode}
                    onChange={(event) => onSelectPermissionMode(event.target.value as PermissionMode)}
                    className="h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {availablePermissionModes.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(`codex.modes.${mode}`, { defaultValue: mode })}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {(codexControls || runtimeControls) && (
                <div className="min-w-0 space-y-2 border-t border-border/50 pt-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('mobileComposer.runtime', { defaultValue: 'Runtime settings' })}
                  </p>
                  <div ref={setMobileSettingsNode} />
                </div>
              )}
            </div>
          )}
        </MobileComposerSheet>
      </div>}

      {isMobile && voiceError && (
        <p role="alert" className="mx-auto mt-1 max-w-[54.25rem] px-2 text-center text-xs text-destructive">
          {voiceError}
        </p>
      )}
    </div>
  );
}
