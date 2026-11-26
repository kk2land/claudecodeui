import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '@/modules/task-master';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import PlanHandoffContext from '@/modules/chat/context/PlanHandoffContext';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import { api } from '@/shared/api';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { useProviderCapabilities } from '@/shared/hooks/useProviderCapabilities';
import type {
  ChatMessage,
  LLMProvider,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '@/shared/types';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useCodexControls } from '@/modules/chat/hooks/useCodexControls';
import { useCodexModelProviders } from '@/modules/chat/hooks/useCodexModelProviders';
import { usePlanHandoff } from '@/modules/chat/hooks/usePlanHandoff';
import { getToolConfig } from '@/modules/chat/tools/configs/toolConfigs';
import { parseToolPayload } from '@/modules/chat/utils/messageTransforms';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { ProjectTodoDialog, useProjectTodos } from '@/modules/todos';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useEscapeToAbortSession } from '@/modules/chat/hooks/useEscapeToAbortSession';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';

type ChatInterfaceProps = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
};

/**
 * Used by the project-workspace module (via the chat barrel) to render a
 * project session's chat tab; it owns the session, provider, realtime and
 * composer state that ChatMessagesPane and ChatComposer render.
 */
function ChatInterface({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe, isConnected } = useWebSocket();
  const providerCapabilities = useProviderCapabilities();
  const { t } = useTranslation('chat');
  const processingSessions = useProcessingSessions();
  const projectTodos = useProjectTodos({
    projectId: selectedProject?.projectId ?? '',
    enabled: isActive && Boolean(selectedProject),
  });
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
    markSessionBackground: onSessionBackground,
    getSessionActivity,
  } = useSessionProtectionActions();

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());
  // A replay cursor is valid only for its execution, including native goal continuations.
  const executionIdsRef = useRef(new Map<string, string>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    hiddenModelProviders = [],
    providerVisibilityLoading,
    providerVisibilityError,
    retryProviderVisibility,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    syncSessionModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
    supportsSideQuestions,
    supportsSteering,
    supportsContextClearing,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    revealMessage,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    executionIdsRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const codexControls = useCodexControls({
    enabled: provider === 'codex', sessionId: selectedSession?.id || currentSessionId,
    project: selectedProject, chatActive: isActive, options: { model: currentProviderModel, effort: currentProviderEffort, permissionMode },
    sendMessage, onSessionEstablished: handleSessionEstablished,
  });

  // A history-preserving branch is an ordinary session row; navigating to it
  // leaves the source conversation, its selection and its queue untouched.
  const handleSessionForked = useCallback((forkedSessionId: string) => {
    onNavigateToSession?.(forkedSessionId);
  }, [onNavigateToSession]);

  const codexModelProviders = useCodexModelProviders({
    enabled: provider === 'codex' && codexControls.state?.runtime !== 'sdk',
    controls: codexControls, model: currentProviderModel,
    knownModels: providerModelCatalog.codex?.OPTIONS ?? currentProviderModelOptions,
    onSessionForked: handleSessionForked,
  });
  const composerModel = codexModelProviders.selection ? codexModelProviders.model : currentProviderModel;
  // A loaded native catalog is authoritative, including an empty list and a
  // model with no reasoning choices; only an unanswered catalog may keep the
  // static provider metadata. `available` describes the settings card, not
  // whether the default OpenAI service has a catalog. A stale catalog from a
  // previous Codex view must never describe another provider or an SDK thread.
  const codexCatalogActive = provider === 'codex' && codexControls.state?.runtime !== 'sdk';
  const nativeModelOptions = codexCatalogActive ? codexModelProviders.modelOptions : null;
  const nativeModelOption = nativeModelOptions?.find((option) => option.value === composerModel) ?? null;
  const composerModelOptions = nativeModelOptions ?? currentProviderModelOptions;
  const composerEffortOptions = nativeModelOptions
    ? nativeModelOption?.effort?.values ?? []
    : composerModel ? currentProviderEffortOptions : [];
  // The shared controller may still hold the previous model's effort; the
  // composer, sends and plan handoff use the native model's own choices.
  const effortForNativeModel = (
    options: typeof nativeModelOptions,
    model: string,
    requested: string,
  ): string => {
    if (!options) return requested;
    const option = options.find((candidate) => candidate.value === model);
    const values = option?.effort?.values ?? [];
    if (values.length === 0) return DEFAULT_EFFORT_VALUE;
    if (values.some((value) => value.value === requested)) return requested;
    const nativeDefault = option?.effort?.default;
    return nativeDefault && values.some((value) => value.value === nativeDefault)
      ? nativeDefault
      : DEFAULT_EFFORT_VALUE;
  };
  const composerEffort = effortForNativeModel(nativeModelOptions, composerModel, currentProviderEffort);
  const composerSessionId = selectedSession?.id || currentSessionId;
  const { available: codexModelProvidersAvailable, selection: codexModelSelection, appliedSelection: codexAppliedSelection,
    select: selectCodexModel, modelProvider: codexModelProvider } = codexModelProviders;
  // Only the route the composer shows may be synced back. A saved target for
  // another service is a branch-form value and must never replace the source's
  // model in the shared provider-state controller.
  const confirmedCodexModel = codexAppliedSelection?.model;
  useEffect(() => {
    if (!composerSessionId || !confirmedCodexModel || confirmedCodexModel === currentProviderModel) return;
    let active = true;
    // Keep the shared model/effort controller in sync with the native control
    // acknowledgement; otherwise reasoning choices would still use the old model.
    queueMicrotask(() => { if (active) syncSessionModel('codex', composerSessionId, confirmedCodexModel); });
    return () => { active = false; };
  }, [composerSessionId, confirmedCodexModel, currentProviderModel, syncSessionModel]);

  // Native plan handoff needs the provider's advertised control, the real
  // app-server runtime, and a CLI whose actual version supports the method; an
  // old or unknown CLI keeps the entry hidden. A saved target for another
  // service is a branch value, so the native route wins; without one the
  // confirmed applied selection is still a real answer.
  // A disconnected socket would allocate a target it could never send to, so
  // the handoff is only offered while this client can reach the server.
  const planHandoffEnabled = provider === 'codex'
    && codexControls.state?.runtime === 'app-server'
    && codexControls.state.planHandoffSupported === true
    && providerCapabilities.codex?.nativeControls?.planHandoff === true
    && isConnected;
  const planHandoffRoute = codexModelProviders.activeSelection ?? codexModelProviders.appliedSelection;
  const planHandoffModel = planHandoffRoute?.model?.trim();
  // The target turn must run the route the source thread actually uses; a
  // same-service model that is still pending is not that route, and its
  // reasoning choices do not apply to a model the new session will not run.
  const planHandoffSendModel = planHandoffModel ?? composerModel;
  const planHandoffSendEffort = planHandoffModel === composerModel
    ? composerEffort
    : effortForNativeModel(nativeModelOptions, planHandoffSendModel, currentProviderEffort);
  const planHandoff = usePlanHandoff({
    enabled: planHandoffEnabled && Boolean(selectedProject),
    project: selectedProject,
    sendMessage,
    onSessionEstablished: handleSessionEstablished,
    onSessionProcessing,
    // The plan on screen belongs to this open transcript; with its exact body it
    // identifies a handoff this page already completed.
    sourceSessionId: composerSessionId || null,
    onOpenSession: onNavigateToSession,
    content: t('codex.implementPrompt'),
    model: planHandoffSendModel,
    effort: planHandoffSendEffort,
    permissionMode,
    resolvePermissionModeForProvider,
    ...(planHandoffRoute && planHandoffModel
      ? { modelSelection: { modelProvider: planHandoffRoute.modelProvider, model: planHandoffModel } }
      : {}),
  });
  // Only the newest plan in the open conversation may be implemented: the scan
  // stops at the last context clear, and an incomplete, failed or empty newest
  // plan means there is no plan rather than an older approved one. The exact
  // card markup is reused so the toolbar sends what the card shows.
  const latestPlan = useMemo<{ sourceSessionId: string | null; markdown: string } | null>(() => {
    if (!planHandoffEnabled || !selectedProject || isProcessing || isLoadingSessionMessages
      || codexControls.state?.mode !== 'plan') {
      return null;
    }
    const sourceSessionId = selectedSession?.id || currentSessionId || null;
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      const message = chatMessages[index];
      if (message.contextCleared) return null;
      if (message.toolName !== 'ExitPlanMode' && message.toolName !== 'exit_plan_mode') continue;
      // The newest plan is the only candidate; older rows are history.
      const result = message.toolResult;
      const failed = !result || result.isError === true
        || message.toolStatus === 'failed' || message.toolStatus === 'in_progress';
      if (failed || message.isStreaming) return null;
      const content = getToolConfig(message.toolName).input
        .getContentProps?.(parseToolPayload(message.toolInput))?.content;
      return typeof content === 'string' && content.trim().length > 0
        ? { sourceSessionId, markdown: content }
        : null;
    }
    return null;
  }, [planHandoffEnabled, selectedProject, isProcessing, isLoadingSessionMessages,
    codexControls.state?.mode, selectedSession?.id, currentSessionId, chatMessages]);
  // A plan this page already handed off has one target; the toolbar relabels
  // its entry to reopen that session instead of creating another.
  const planHandoffTargetSessionId = latestPlan
    ? planHandoff.handedOffSessionIdFor(latestPlan)
    : null;
  const planHandoffContextValue = useMemo(
    () => planHandoff.enabled
      ? {
          implementInNewSession: planHandoff.implementInNewSession,
          pending: planHandoff.pending,
          latestPlan,
          handedOffTargetSessionId: planHandoffTargetSessionId,
        }
      : null,
    [planHandoff.enabled, planHandoff.implementInNewSession, planHandoff.pending,
      latestPlan, planHandoffTargetSessionId],
  );

  /**
   * Clears the open session's context: the conversation stays on screen, with
   * a divider where the clear happened, and the next message starts fresh.
   */
  const handleClearContext = useCallback(async () => {
    const sessionId = currentSessionId || selectedSession?.id;
    if (!supportsContextClearing) {
      addMessage({ type: 'assistant', content: t('misc.clearContextUnsupported'), timestamp: Date.now() });
      return;
    }
    // A chat that has not sent its first message has no context yet.
    if (!sessionId) {
      addMessage({ type: 'assistant', content: t('misc.clearContextEmpty'), timestamp: Date.now() });
      return;
    }

    try {
      const response = await api.clearSessionContext(sessionId);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
      }
      if (!payload?.data?.cleared) {
        addMessage({ type: 'assistant', content: t('misc.clearContextEmpty'), timestamp: Date.now() });
        return;
      }
      // Brings in the divider the server now ends the history with, and the
      // cleared usage. The refresh is scoped to `sessionId`, so a clear that
      // finishes after the user opened another chat leaves that chat's counter.
      await requestLatestMessages(sessionId, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addMessage({ type: 'error', content: t('misc.clearContextFailed', { message }), timestamp: Date.now() });
    }
  }, [addMessage, currentSessionId, requestLatestMessages, selectedSession?.id, supportsContextClearing, t]);

  // The button asks first: unlike a typed `/clear`, a click can be a slip.
  const handleClearContextClick = useCallback(() => {
    if (window.confirm(t('misc.clearContextConfirm'))) {
      void handleClearContext();
    }
  }, [handleClearContext, t]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    attachmentRejections,
    dismissAttachmentRejections,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    handleSendMenuChoice,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    queuedDrafts,
    queuedDraft,
    moveQueuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    pendingSteers,
    handleSteerOutcome,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    resizeTextarea,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
    composerPrediction,
    todoDialogOpen,
    setTodoDialogOpen,
    selectProjectTodo,
    detachTodoSource,
    removeStoredTodoAttachment,
    todoNotice,
    todoSourceIds,
    storedAttachments,
    localTodoCommand,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel: composerModel,
    currentProviderEffort: composerEffort,
    isLoading: isProcessing,
    codexControls: provider === 'codex' ? codexControls : undefined,
    // Native predictions exist only for the app-server runtime that advertises
    // the integration; SDK compatibility has no such native method. Before the
    // first snapshot arrives, retain the user's opt-in for that first message;
    // the backend requests predictions only when it selects the native runtime.
    composerPredictionsEligible: provider === 'codex' && codexControls.predictionsSupported === true
      && codexControls.state?.runtime !== 'sdk',
    composerPredictionsBlocked: pendingPermissionRequests.length > 0,
    composerPredictionsUnsupported: codexControls.predictionsUnsupported === true
      && codexControls.state?.runtime !== 'sdk',
    executionIdsRef,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    isConnected,
    sendByCtrlEnter,
    supportsSteering,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen,
    onShowSettings,
    onClearContext: handleClearContext,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
    supportsSideQuestions,
    isVisible: isActive,
  });

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await requestLatestMessages(selectedSession.id, isActive);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
        executionId: executionIdsRef.current.get(selectedSession.id),
      }],
    });
  }, [isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage]);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    executionIdsRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onSessionBackground,
    getSessionActivity,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
    onSteerOutcome: handleSteerOutcome,
  });

  // Lets other modules (the quick settings Commands tab) hand text to the
  // composer: append it after a separating space, then focus the textarea with
  // the caret at the end once React has rendered the new value.
  const insertComposerText = useCallback((text: string) => {
    setInput((previous) => {
      const separator = previous && !/\s$/.test(previous) ? ' ' : '';
      return `${previous}${separator}${text}`;
    });
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      const caretPosition = textarea.value.length;
      textarea.setSelectionRange(caretPosition, caretPosition);
    });
  }, [setInput, textareaRef]);

  usePaletteOpsRegister({ insertComposerText });

  useEscapeToAbortSession({
    canAbortSession,
    onAbortSession: handleAbortSession,
    composerRef: textareaRef,
  });

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  /**
   * Branches the conversation into a new session that ends at this message,
   * then opens it. The session being viewed is left exactly as it was.
   */
  const handleForkFromMessage = useCallback(async (message: ChatMessage) => {
    const anchorId = message.transcriptAnchorId;
    const sourceSessionId = selectedSession?.id;
    if (!anchorId || !sourceSessionId) return;

    try {
      const response = await api.forkSession(sourceSessionId, { upToAnchorId: anchorId });
      const payload = await response.json();
      const forkedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof forkedSessionId !== 'string') {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      onNavigateToSession?.(forkedSessionId);
    } catch (error) {
      console.error('Error forking session:', error);
    }
  }, [onNavigateToSession, selectedSession?.id]);

  const { scheduledMessages, schedule: scheduleMessage, cancel: cancelScheduledMessage } =
    useScheduledMessages(currentSessionId || selectedSession?.id || null, subscribe);

  /**
   * Hands the composer's current text to the server to send later, and clears
   * the box as a send would — the message has left the composer either way.
   */
  const handleScheduleMessage = useCallback(async (scheduledFor: Date) => {
    const content = input.trim();
    if (!content) return;

    const scheduled = await scheduleMessage({
      content,
      scheduledFor,
      options: { model: composerModel, effort: composerEffort, permissionMode },
    });
    if (scheduled) {
      setInput('');
    }
  }, [composerEffort, composerModel, input, permissionMode, scheduleMessage, setInput]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // Lets markdown image paths in the transcript resolve against this project.
  const markdownWorkspaceValue = useMemo(() => ({
    projectId: selectedProject?.projectId ?? null,
  }), [selectedProject?.projectId]);

  // Lets a workflow card fetch its agents' timelines for this session.
  const transcriptSessionValue = useMemo(() => ({ sessionId: currentSessionId }), [currentSessionId]);

  // The first remote model pick also needs session controls: they allocate a
  // new session before saving it, so the built-in default cannot replace it.
  const selectSessionModel = useCallback(async (targetProvider: LLMProvider, model: string, sessionId?: string | null) => {
    if (targetProvider === 'codex' && (codexModelProvidersAvailable || codexModelSelection) && sessionId === composerSessionId) {
      await selectCodexModel(codexModelProvider, model);
      return { scope: 'session' as const, model };
    }
    return selectProviderModel(targetProvider, model, sessionId);
  }, [codexModelProvidersAvailable, codexModelSelection, selectCodexModel, codexModelProvider, composerSessionId, selectProviderModel]);

  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectSessionModel(provider, model, composerSessionId);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [composerSessionId, provider, selectSessionModel]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, composerSessionId);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [composerSessionId, provider, selectProviderEffort]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve space for floating status tabs. Codex's status is inside the input
  // and already contributes to the composer's height.
  const hasActivityIndicator = Boolean(provider !== 'codex' && sessionActivity && pendingPermissionRequests.length === 0);

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }


  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <PlanHandoffContext.Provider value={planHandoffContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <MarkdownWorkspaceContext.Provider value={markdownWorkspaceValue}>
          <TranscriptSessionContext.Provider value={transcriptSessionValue}>
            <ChatMessagesPane
              scrollContainerRef={scrollContainerRef}
              // Not redundant with the `scroll` listener. A first page is 20 rows,
              // tool results fold into their calls, and the "load earlier" link is
              // hidden while more pages exist — so a short transcript is often not
              // scrollable at all and never emits `scroll`. Wheel and touch are
              // then the only way to reach the top pager or the "load all" overlay.
              onWheel={handleScroll}
              onTouchMove={handleScroll}
              isLoadingSessionMessages={isLoadingSessionMessages}
              isProcessing={isProcessing}
              hasActivityIndicator={hasActivityIndicator}
              chatMessages={chatMessages}
              selectedSession={selectedSession}
              currentSessionId={currentSessionId}
              provider={provider}
              setProvider={setProvider}
              textareaRef={textareaRef}
              providerModels={providerModels}
              setProviderModel={setStoredProviderModel}
              providerModelCatalog={providerModelCatalog}
              hiddenModelProviders={hiddenModelProviders}
              providerVisibilityLoading={providerVisibilityLoading}
              providerVisibilityError={providerVisibilityError}
              onRetryProviderVisibility={retryProviderVisibility}
              providerModelActions={providerModelActions}
              providerModelsLoading={providerModelsLoading}
              tasksEnabled={tasksEnabled}
              isTaskMasterInstalled={isTaskMasterInstalled}
              onShowAllTasks={onShowAllTasks}
              setInput={setInput}
              isLoadingMoreMessages={isLoadingMoreMessages}
              hasMoreMessages={hasMoreMessages}
              totalMessages={totalMessages}
              sessionMessagesCount={chatMessages.length}
              visibleMessageCount={visibleMessageCount}
              visibleMessages={visibleMessages}
              loadEarlierMessages={loadEarlierMessages}
              revealMessage={revealMessage}
              backgroundTasks={sessionActivity?.tasks}
              sendMessage={sendMessage}
              loadAllMessages={loadAllMessages}
              allMessagesLoaded={allMessagesLoaded}
              isLoadingAllMessages={isLoadingAllMessages}
              loadAllJustFinished={loadAllJustFinished}
              showLoadAllOverlay={showLoadAllOverlay}
              createDiff={createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              onGrantToolPermission={handleGrantToolPermission}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              selectedProject={selectedProject}
              // Editing replaces the turn and everything after it, so it is only
              // offered when the session is idle — a half-truncated transcript with
              // a live stream writing into it is not recoverable.
              // A linked source draft must be sent as-is; editing an earlier turn
              // would replace its conversation with that history message.
              onEditMessage={supportsMessageEditing && !isProcessing && todoSourceIds.length === 0 ? beginEditMessage : undefined}
              onForkFromMessage={supportsSessionForking ? handleForkFromMessage : undefined}
              onLoadFullTranscript={loadFullTranscript}
            />
          </TranscriptSessionContext.Provider>
        </MarkdownWorkspaceContext.Provider>

        {/* Let native questions scroll within the space left by the input on short screens. */}
        <div className={`relative ${codexControls?.state?.questions.length ? 'flex min-h-0 flex-col' : 'flex-shrink-0'}`}>
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          {(selectedSession || currentSessionId || !hiddenModelProviders.includes(provider)) && <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          canAbortSession={canAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={selectPermissionMode}
          providerLabel={selectedProviderLabel}
          effort={composerEffort}
          availableEffortOptions={composerEffortOptions}
          onSelectEffort={handleSelectComposerEffort}
          model={composerModel}
          availableModelOptions={composerModelOptions}
          onSelectModel={handleSelectComposerModel}
          modelsLoading={providerModelsLoading || codexModelProviders.loading}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          onClearContext={supportsContextClearing && (currentSessionId || selectedSession?.id) ? handleClearContextClick : undefined}
          isEditingSentMessage={Boolean(editingAnchorId)}
          onCancelEditMessage={cancelEditMessage}
          scheduledMessages={scheduledMessages}
          onScheduleMessage={handleScheduleMessage}
          onCancelScheduledMessage={cancelScheduledMessage}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          codexControls={provider === 'codex' ? codexControls : undefined}
          codexModelProviders={provider === 'codex' && codexControls.state?.runtime !== 'sdk' ? codexModelProviders : undefined}
          onExecutePlan={() => handleVoiceTranscript(t('codex.implementPrompt'), false)}
          queuedDrafts={queuedDrafts}
          queuedDraft={queuedDraft}
          backgroundSendPrompt={backgroundSendPrompt}
          onResolveBackgroundSendPrompt={resolveBackgroundSendPrompt}
          onMoveQueuedDraft={moveQueuedDraft}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          onSendMenuChoice={handleSendMenuChoice}
          supportsSteering={supportsSteering}
          pendingSteers={pendingSteers}
          attachedFiles={attachedFiles}
          todoSourceIds={todoSourceIds}
          storedAttachments={storedAttachments}
          onRemoveStoredAttachment={removeStoredTodoAttachment}
          onDetachTodoSource={detachTodoSource}
          todoNotice={todoNotice}
          pendingTodoCount={projectTodos.todos.filter((todo) => todo.status === 'pending').length}
          onOpenTodoList={() => setTodoDialogOpen(true)}
          localTodoCommand={localTodoCommand}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          attachmentRejections={attachmentRejections}
          onDismissAttachmentRejections={dismissAttachmentRejections}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onTextareaResize={resizeTextarea}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          isVisible={isActive}
          sendByCtrlEnter={sendByCtrlEnter}
          composerPrediction={provider === 'codex' && (codexControls.predictionsSupported || codexControls.predictionsUnsupported)
            ? composerPrediction : undefined}
          supportsSideQuestions={supportsSideQuestions}
        />}
        </div>
      </div>
      </PlanHandoffContext.Provider>

      {selectedProject && (
        <ProjectTodoDialog
          projectId={selectedProject.projectId}
          projectName={selectedProject.displayName || selectedProject.projectId}
          todosState={projectTodos}
          open={todoDialogOpen}
          onOpenChange={setTodoDialogOpen}
          onSelectTodo={selectProjectTodo}
          onNavigateToSession={onNavigateToSession}
        />
      )}

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        hiddenModelProviders={hiddenModelProviders}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={composerModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectSessionModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
