import assert from 'node:assert/strict';

import type { ComponentProps, ContextType } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type ChatComposer from '@/modules/chat/composer/ChatComposer';
import type PlanHandoffContext from '@/modules/chat/context/PlanHandoffContext';
import type { ChatMessage, CodexModelProviderControls, Project, ProjectSession } from '@/shared/types';

type PlanHandoffContextValue = NonNullable<ContextType<typeof PlanHandoffContext>>;

/**
 * A saved selection naming another service than the native thread runs is a
 * branch-form value, never an applied route. The composer must keep showing the
 * route the thread really uses, and the shared model/effort controller must not
 * be synced to the saved target — otherwise editing reasoning later would send
 * a model the source thread never adopted.
 */

const harness = vi.hoisted(() => ({
  composer: vi.fn((_props: ComponentProps<typeof ChatComposer>) => null),
  syncSessionModel: vi.fn(),
  selectProviderModel: vi.fn(async () => {}),
  selectProviderEffort: vi.fn(async () => {}),
  // The hook's own view: a cross-service saved target, or a same-service pending model.
  sameServiceTarget: false,
  // A native catalog overrides the static provider metadata once loaded.
  nativeOptions: null as ComponentProps<typeof ChatComposer>['availableModelOptions'] | null,
  staticEffortOptions: [] as ComponentProps<typeof ChatComposer>['availableEffortOptions'],
  // A null native route, to prove a nullable saved model is never sent as a choice.
  routeWithoutModel: false,
  // The selected provider, native runtime and advertised control decide whether a plan can be handed off.
  provider: 'codex' as 'codex' | 'claude',
  runtime: 'app-server' as 'app-server' | 'sdk',
  // Adapter capability and the actual CLI version gate the handoff independently.
  planHandoffSupported: true,
  nativePlanHandoffSupported: true as boolean | undefined,
  // The plan handoff card reads this from inside the chat tree.
  planHandoff: null as PlanHandoffContextValue | null,
  capturePlanHandoff: (value: PlanHandoffContextValue | null): void => { harness.planHandoff = value; },
  createSession: vi.fn(),
  sendMessage: vi.fn(),
  // A disconnected socket must not allocate a target it cannot send to.
  connected: true,
  staticModelOptions: [] as ComponentProps<typeof ChatComposer>['availableModelOptions'],
  composerStateArgs: null as { currentProviderEffort?: string; currentProviderModel?: string } | null,
  // The open transcript and the native mode decide whether the latest plan can be handed off.
  mode: 'default' as 'default' | 'plan',
  chatMessages: [] as ChatMessage[],
  isProcessing: false,
  isLoadingSessionMessages: false,
  composerStateSpies: {
    setInput: vi.fn(), setAttachedFiles: vi.fn(), deleteQueuedDraft: vi.fn(), editQueuedDraft: vi.fn(),
    handleSubmit: vi.fn(),
  },
}));

vi.mock('@/modules/chat/composer/ChatComposer', async () => {
  const { usePlanHandoff } = await import('@/modules/chat/context/PlanHandoffContext');
  function ComposerProbe(props: ComponentProps<typeof ChatComposer>) {
    harness.capturePlanHandoff(usePlanHandoff());
    harness.composer(props);
    return null;
  }
  return { default: ComposerProbe };
});
vi.mock('@/shared/api', () => ({ api: { providers: { createSession: harness.createSession } } }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilities: () => ({ codex: { nativeControls: { planHandoff: harness.planHandoffSupported } } }),
}));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => null, cancel: async () => false }),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => {}, isConnected: harness.connected }),
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({
    markSessionProcessing: () => {},
    markSessionIdle: () => {},
    markSessionBackground: () => {},
    getSessionActivity: () => null,
  }),
}));
vi.mock('@/modules/task-master', () => ({ useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }) }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('@/modules/todos', () => ({ ProjectTodoDialog: () => null, useProjectTodos: () => ({ todos: [] }) }));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({
    provider: harness.provider,
    providerCapabilities: {},
    pendingPermissionRequests: [],
    providerModelCatalog: {},
    currentProviderModelOptions: harness.staticModelOptions, currentProviderModel: 'a-model',
    currentProviderEffort: 'high', currentProviderEffortOptions: harness.staticEffortOptions,
    permissionMode: 'default', availablePermissionModes: ['default'],
    selectPermissionMode: () => {}, cyclePermissionMode: () => {},
    resolvePermissionModeForProvider: () => 'default',
    selectProviderModel: harness.selectProviderModel, syncSessionModel: harness.syncSessionModel,
    selectProviderEffort: harness.selectProviderEffort,
    supportsMessageEditing: false, supportsSessionForking: false,
    supportsSideQuestions: false, supportsSteering: false, supportsContextClearing: false,
  }),
}));
vi.mock('@/modules/chat/hooks/useCodexControls', () => ({
  useCodexControls: () => ({ state: {
    runtime: harness.runtime, questions: [], planHandoffSupported: harness.nativePlanHandoffSupported,
    mode: harness.mode,
  } }),
}));
vi.mock('@/modules/chat/hooks/useProviderRuntimeControls', () => ({
  useProviderRuntimeControls: () => ({ available: false }),
}));
vi.mock('@/modules/chat/hooks/useCodexModelProviders', () => ({
  useCodexModelProviders: () => {
    const activeSelection = { modelProvider: 'alpha', model: harness.routeWithoutModel ? null : 'a-model' };
    const savedTarget = { modelProvider: 'beta', model: 'b-model' };
    const sameServiceTarget = { modelProvider: 'alpha', model: 'next-model' };
    // Same service: the pending model is applied. Other service: only a branch target.
    const appliedSelection = harness.routeWithoutModel
      ? null
      : harness.sameServiceTarget ? sameServiceTarget : activeSelection;
    const shown = appliedSelection ?? activeSelection;
    const shownModel = shown.model ?? 'a-model';
    return {
      // OpenAI-only installations still receive the default service's native catalog.
      available: false,
      providers: [
        { id: 'alpha', name: 'Alpha', baseUrl: null, canEdit: false, settings: { type: 'openai' as const } },
        { id: 'beta', name: 'Beta', baseUrl: null, canEdit: true, settings: { type: 'gcp' as const } },
      ],
      modelProvider: shown.modelProvider, model: shownModel,
      selection: harness.sameServiceTarget ? sameServiceTarget : savedTarget,
      appliedSelection: appliedSelection ?? undefined, activeSelection,
      modelOptions: harness.nativeOptions ?? [{ value: shownModel, label: shownModel, effort: { values: [{ value: 'high' }] } }],
      modelOptionsFor: () => null, loading: false, pending: false, error: null,
      refresh: async () => {}, loadModels: async () => [], select: async () => {},
      forkWithHistory: async () => ({ ok: true, sessionId: 'forked-session' }),
    } satisfies CodexModelProviderControls;
  },
}));
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: harness.chatMessages, addMessage: () => {}, sessionActivity: null,
    isProcessing: harness.isProcessing, canAbortSession: false,
    currentSessionId: 'source-session', setCurrentSessionId: () => {},
    isLoadingSessionMessages: harness.isLoadingSessionMessages, isLoadingMoreMessages: false,
    hasMoreMessages: false, totalMessages: harness.chatMessages.length,
    isUserScrolledUp: false, setIsUserScrolledUp: () => {},
    tokenBudget: null, setTokenBudget: () => {},
    visibleMessageCount: harness.chatMessages.length, visibleMessages: harness.chatMessages,
    loadEarlierMessages: () => {}, revealMessage: () => {}, loadAllMessages: () => {},
    loadFullTranscript: () => {}, allMessagesLoaded: true, isLoadingAllMessages: false,
    loadAllJustFinished: false, showLoadAllOverlay: false, createDiff: () => [],
    scrollContainerRef: { current: null }, scrollToBottom: () => {}, scrollToBottomAndReset: () => {},
    handleScroll: () => {}, requestLatestMessages: () => {},
  }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: (args: { currentProviderEffort?: string; currentProviderModel?: string }) => {
    harness.composerStateArgs = args;
    return {
      input: '', setInput: harness.composerStateSpies.setInput, textareaRef: { current: null },
      setAttachedFiles: harness.composerStateSpies.setAttachedFiles,
      deleteQueuedDraft: harness.composerStateSpies.deleteQueuedDraft,
      editQueuedDraft: harness.composerStateSpies.editQueuedDraft,
      handleSubmit: harness.composerStateSpies.handleSubmit,
    };
  },
}));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));

const { default: ChatInterface } = await import('@/modules/chat/ChatInterface');

const project: Project = { projectId: 'p1', displayName: 'repo', fullPath: '/work/repo', path: '/work/repo' };
const session: ProjectSession = { id: 'source-session', provider: 'codex' };

function renderChat() {
  return render(<ChatInterface isActive selectedProject={project} selectedSession={session} ws={null} sendMessage={harness.sendMessage} />);
}

function createdSessionResponse(sessionId = 'target-session', sessionName = 'Plan') {
  return { ok: true, status: 200, json: async () => ({ data: { sessionId, sessionName } }) };
}

beforeEach(() => {
  harness.sameServiceTarget = false;
  harness.nativeOptions = null;
  harness.staticEffortOptions = [];
  harness.routeWithoutModel = false;
  harness.provider = 'codex';
  harness.runtime = 'app-server';
  harness.planHandoffSupported = true;
  harness.nativePlanHandoffSupported = true;
  harness.connected = true;
  harness.staticModelOptions = [];
  harness.composerStateArgs = null;
  harness.planHandoff = null;
  harness.mode = 'default';
  harness.chatMessages = [];
  harness.isProcessing = false;
  harness.isLoadingSessionMessages = false;
  vi.clearAllMocks();
});

test('a saved target on another service is displayed as the native route and never synced back', async () => {
  renderChat();
  await act(async () => { await Promise.resolve(); });

  // The composer shows the route the thread really runs, never the saved target.
  const props = harness.composer.mock.calls.at(-1)![0];
  assert.equal(props.model, 'a-model');
  assert.deepEqual(props.availableModelOptions.map((option) => option.value), ['a-model']);
  assert.equal(harness.syncSessionModel.mock.calls.length, 0);
});

test('a same-service pending model still syncs, so the control path is unchanged', async () => {
  harness.sameServiceTarget = true;
  renderChat();
  await act(async () => { await Promise.resolve(); });

  assert.equal(harness.composer.mock.calls.at(-1)![0].model, 'next-model');
  assert.deepEqual(harness.syncSessionModel.mock.calls, [['codex', 'source-session', 'next-model']]);
});

test('a native catalog replaces static metadata even without custom providers', async () => {
  harness.nativeOptions = [{ value: 'a-model', label: 'A Model', effort: { default: 'medium', values: [{ value: 'low' }, { value: 'medium' }] } }];
  harness.staticEffortOptions = [{ value: 'high' }];
  renderChat();
  await act(async () => { await Promise.resolve(); });

  const props = harness.composer.mock.calls.at(-1)![0];
  assert.equal(props.availableModelOptions, harness.nativeOptions);
  assert.deepEqual(props.availableEffortOptions.map((option) => option.value), ['low', 'medium']);
  // The saved 'high' is not offered by this native model; its own default wins.
  assert.equal(props.effort, 'medium');
});

test('a native model without reasoning effort does not borrow static effort values', async () => {
  harness.nativeOptions = [{ value: 'a-model', label: 'A Model', effort: { values: [] } }];
  harness.staticEffortOptions = [{ value: 'high' }];
  renderChat();
  await act(async () => { await Promise.resolve(); });

  const props = harness.composer.mock.calls.at(-1)![0];
  assert.deepEqual(props.availableEffortOptions, []);
  assert.equal(props.effort, 'default');
});

test('an approved plan creates one target and sends the complete plan to the native route', async () => {
  harness.createSession.mockResolvedValue(createdSessionResponse());
  const markdown = '## Plan\n\n1. Keep every word\n2. Run the tests';
  renderChat();
  await act(async () => { await Promise.resolve(); });

  await act(async () => { await harness.planHandoff!.implementInNewSession({ markdown }); });

  assert.equal(harness.createSession.mock.calls.length, 1);
  assert.deepEqual(harness.createSession.mock.calls[0][0], {
    provider: 'codex', projectPath: '/work/repo', initialMessage: markdown,
  });
  assert.equal(harness.sendMessage.mock.calls.length, 1);
  const frame = harness.sendMessage.mock.calls[0][0];
  assert.equal(frame.type, 'chat.send');
  assert.equal(frame.sessionId, 'target-session');
  assert.equal(frame.options.collaborationMode, 'default');
  assert.deepEqual(frame.options.approvedPlan, {
    markdown,
    modelSelection: { modelProvider: 'alpha', model: 'a-model' },
  });
  // The source composer, its submit path, queue and attachments are untouched.
  for (const spy of Object.values(harness.composerStateSpies)) assert.equal(spy.mock.calls.length, 0);
});

test('a same-service pending model never replaces the native route actually running', async () => {
  harness.sameServiceTarget = true;
  harness.createSession.mockResolvedValue(createdSessionResponse());
  renderChat();
  await act(async () => { await Promise.resolve(); });

  await act(async () => { await harness.planHandoff!.implementInNewSession({ markdown: '# Plan' }); });

  assert.deepEqual(harness.sendMessage.mock.calls[0][0].options.approvedPlan.modelSelection,
    { modelProvider: 'alpha', model: 'a-model' });
});

test('a route without a model does not send a nullable model selection', async () => {
  harness.routeWithoutModel = true;
  harness.createSession.mockResolvedValue(createdSessionResponse());
  renderChat();
  await act(async () => { await Promise.resolve(); });

  await act(async () => { await harness.planHandoff!.implementInNewSession({ markdown: '# Plan' }); });

  assert.equal('modelSelection' in harness.sendMessage.mock.calls[0][0].options.approvedPlan, false);
});

test('a failed target creation leaves the source and reports the error', async () => {
  harness.createSession.mockResolvedValue({
    ok: false, status: 500, json: async () => ({ error: { message: 'gateway unavailable' } }),
  });
  renderChat();
  await act(async () => { await Promise.resolve(); });

  await act(async () => {
    await assert.rejects(
      () => harness.planHandoff!.implementInNewSession({ markdown: '# Plan' }),
      /gateway unavailable/,
    );
  });
  assert.equal(harness.sendMessage.mock.calls.length, 0);
});

test('SDK transcripts and unadvertised servers get no native handoff context', async () => {
  harness.runtime = 'sdk';
  renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.equal(harness.planHandoff, null);

  cleanup();
  harness.runtime = 'app-server';
  harness.planHandoffSupported = false;
  renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.equal(harness.planHandoff, null);
});

test('an SDK transcript ignores a stale native catalog', async () => {
  harness.runtime = 'sdk';
  harness.nativeOptions = [{ value: 'a-model', label: 'A Model', effort: { values: [{ value: 'low' }] } }];
  harness.staticModelOptions = [{ value: 'static-model', label: 'Static' }];
  harness.staticEffortOptions = [{ value: 'high' }];
  renderChat();
  await act(async () => { await Promise.resolve(); });

  const props = harness.composer.mock.calls.at(-1)![0];
  assert.equal(props.availableModelOptions, harness.staticModelOptions);
  assert.deepEqual(props.availableEffortOptions.map((option) => option.value), ['high']);
  assert.equal(harness.planHandoff, null);
});

test('a disconnected socket does not offer the handoff', async () => {
  harness.connected = false;
  renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.equal(harness.planHandoff, null);
});

test('an empty native effort set makes the ordinary send use the default effort', async () => {
  harness.nativeOptions = [{ value: 'a-model', label: 'A Model', effort: { values: [] } }];
  renderChat();
  await act(async () => { await Promise.resolve(); });

  assert.equal(harness.composerStateArgs?.currentProviderEffort, 'default');
  assert.equal(harness.composer.mock.calls.at(-1)![0].effort, 'default');
});

test('the plan send uses the actual route model and its effort, not a pending same-service pick', async () => {
  harness.sameServiceTarget = true;
  harness.nativeOptions = [
    { value: 'a-model', label: 'A Model', effort: { values: [{ value: 'low' }, { value: 'high' }] } },
    { value: 'next-model', label: 'Next', effort: { values: [{ value: 'low' }] } },
  ];
  harness.createSession.mockResolvedValue(createdSessionResponse());
  renderChat();
  await act(async () => { await Promise.resolve(); });

  await act(async () => { await harness.planHandoff!.implementInNewSession({ markdown: '# Plan' }); });

  const frame = harness.sendMessage.mock.calls[0][0];
  // The native route is still the applied 'a-model'; 'next-model' is only pending.
  assert.equal(frame.options.model, 'a-model');
  assert.equal(frame.options.effort, 'high');
  assert.deepEqual(frame.options.approvedPlan.modelSelection, { modelProvider: 'alpha', model: 'a-model' });
});

test('a non-Codex transcript ignores a stale Codex catalog', async () => {
  harness.provider = 'claude';
  harness.nativeOptions = [{ value: 'a-model', label: 'A Model', effort: { values: [{ value: 'low' }] } }];
  harness.staticModelOptions = [{ value: 'static-model', label: 'Static' }];
  harness.staticEffortOptions = [{ value: 'high' }];
  renderChat();
  await act(async () => { await Promise.resolve(); });

  const props = harness.composer.mock.calls.at(-1)![0];
  assert.equal(props.availableModelOptions, harness.staticModelOptions);
  assert.deepEqual(props.availableEffortOptions.map((option) => option.value), ['high']);
  assert.equal(harness.planHandoff, null);
});

test.each([false, undefined])('an old or unknown CLI (%s) hides the native handoff consumer', async (nativeFlag) => {
  harness.nativePlanHandoffSupported = nativeFlag;
  renderChat();
  await act(async () => { await Promise.resolve(); });
  // ChatInterface composes the real context the plan card reads; no context means no button.
  assert.equal(harness.planHandoff, null);
});

test('the current CLI keeps the native handoff consumer available', async () => {
  renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.ok(harness.planHandoff);
});

function planRow(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00.000Z',
    toolName: 'ExitPlanMode',
    toolInput: JSON.stringify({ plan: '## Plan\n\nDo the work' }),
    toolResult: { content: 'approved' },
    ...overrides,
  };
}

const completePlanRow = () => planRow();
const clearedRow = () => ({ type: 'system', timestamp: '2026-01-01T00:00:00.000Z', contextCleared: true } as ChatMessage);

test('plan mode publishes the newest complete plan with its exact card markdown and source session', async () => {
  const markdown = '## 计划\n\n```ts\nconst answer = 42;\n```\n\n保留尾部空白  ';
  harness.mode = 'plan';
  harness.chatMessages = [planRow({ toolInput: JSON.stringify({ plan: markdown }) })];
  renderChat();
  await act(async () => { await Promise.resolve(); });

  assert.deepEqual(harness.planHandoff?.latestPlan, { sourceSessionId: 'source-session', markdown });
});

test('a plan is unavailable outside plan mode, while processing or while history loads', async () => {
  harness.mode = 'plan';
  harness.chatMessages = [completePlanRow()];
  harness.mode = 'default';
  renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.equal(harness.planHandoff?.latestPlan, null);

  cleanup();
  harness.mode = 'plan';
  harness.isProcessing = true;
  renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.equal(harness.planHandoff?.latestPlan, null);

  cleanup();
  harness.isProcessing = false;
  harness.isLoadingSessionMessages = true;
  renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.equal(harness.planHandoff?.latestPlan, null);
});

test.each([
  ['no messages', []],
  ['only todos', [{
    type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z',
    toolName: 'TodoWrite', toolInput: JSON.stringify({ todos: [{ content: 'Step 1', status: 'pending' }] }),
    toolResult: { content: 'ok' },
  } as ChatMessage]],
  ['only an assistant list', [{
    type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z',
    content: '1. Read the code\n2. Change the code\n3. Run the tests',
  } as ChatMessage]],
])('plan mode with %s publishes no plan', async (_label, messages) => {
  harness.mode = 'plan';
  harness.chatMessages = messages;
  renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.equal(harness.planHandoff?.latestPlan, null);
});

test('two complete plans resolve to the last one with its exact full text', async () => {
  const first = '## First plan\n\n1. Old step';
  const second = '## Second plan\n\n```ts\nconst later = true;\n```\n\nKeep this tail  ';
  harness.mode = 'plan';
  harness.chatMessages = [
    planRow({ toolInput: JSON.stringify({ plan: first }) }),
    planRow({ toolInput: JSON.stringify({ plan: second }) }),
  ];
  renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual(harness.planHandoff?.latestPlan, { sourceSessionId: 'source-session', markdown: second });
});

test('loading older history around the same latest plan keeps that plan as the target', async () => {
  const latest = '## Latest plan\n\nDo the current work';
  harness.mode = 'plan';
  harness.chatMessages = [planRow({ toolInput: JSON.stringify({ plan: latest }) })];
  const view = renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.equal(harness.planHandoff?.latestPlan?.markdown, latest);

  harness.chatMessages = [
    planRow({ toolInput: JSON.stringify({ plan: '## Older plan\n\nAlready done' }) }),
    ...harness.chatMessages,
  ];
  view.rerender(<ChatInterface isActive selectedProject={project} selectedSession={session}
    ws={null} sendMessage={harness.sendMessage} />);
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual(harness.planHandoff?.latestPlan, { sourceSessionId: 'source-session', markdown: latest });
});

test.each([
  ['still streaming', { toolResult: null }],
  ['streaming despite a result', { toolResult: { content: 'approved' }, isStreaming: true }],
  ['failed', { toolResult: { content: 'denied', isError: true } }],
  ['reported failed', { toolStatus: 'failed' }],
  ['in progress', { toolStatus: 'in_progress' }],
  ['empty', { toolInput: JSON.stringify({ plan: '   ' }) }],
])('a newest plan that is %s hides the handoff instead of reusing the older complete plan', async (_label, overrides) => {
  harness.mode = 'plan';
  harness.chatMessages = [completePlanRow(), planRow(overrides)];
  renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.equal(harness.planHandoff?.latestPlan, null);
});

test('a context clear ends the plan scope so an earlier plan is never handed off', async () => {
  harness.mode = 'plan';
  harness.chatMessages = [completePlanRow(), clearedRow()];
  renderChat();
  await act(async () => { await Promise.resolve(); });
  assert.equal(harness.planHandoff?.latestPlan, null);
});
