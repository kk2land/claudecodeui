import assert from 'node:assert/strict';

import type { ComponentProps } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type ChatComposer from '@/modules/chat/composer/ChatComposer';
import type { LLMProvider, Project, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * The scheduled-message banner follows the server's `scheduled_messages_changed`
 * frames only because ChatInterface hands the websocket context's `subscribe`
 * to useScheduledMessages (#1546). The hook takes it as an optional second
 * argument, so a call that drops it still type-checks and the hook's own tests
 * still pass, while the banner silently goes back to stale-until-reload. This
 * renders ChatInterface with everything else stubbed to catch exactly that.
 */

const harness = vi.hoisted(() => ({
  sessionId: 'session-a' as string | null,
  provider: 'claude' as LLMProvider,
  servicesAvailable: true,
  hasModelSelection: true,
  selectedModel: 'openai/gpt-5.6-sol' as string | null,
  effortOptions: [{ value: 'low' }, { value: 'high' }],
  selectCodexModel: vi.fn(async (_provider: string, _model: string) => {}),
  selectProviderModel: vi.fn(async (_provider: LLMProvider, _model: string, _sessionId?: string | null) => {}),
  selectProviderEffort: vi.fn(async () => {}),
  composer: vi.fn((_props: ComponentProps<typeof ChatComposer>) => null),
  // The websocket context's own function; ChatInterface must pass this one on, not a stand-in.
  subscribe: (_listener: (event: ServerEvent) => void) => () => {},
  useScheduledMessages: vi.fn((_sessionId: string | null, _subscribe?: unknown) => ({
    scheduledMessages: [],
    schedule: async () => null,
    cancel: async () => false,
  })),
}));

vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: harness.useScheduledMessages,
}));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: harness.subscribe }),
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
vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({ provider: harness.provider, pendingPermissionRequests: [], providerModelCatalog: {}, currentProviderModelOptions: [],
    currentProviderModel: 'openai/gpt-5.6-sol', currentProviderEffort: 'high', currentProviderEffortOptions: harness.effortOptions,
    selectProviderEffort: harness.selectProviderEffort, selectProviderModel: harness.selectProviderModel }),
}));
vi.mock('@/modules/chat/hooks/useCodexControls', () => ({
  useCodexControls: () => ({ state: { runtime: 'app-server' } }),
}));
vi.mock('@/modules/chat/hooks/useProviderRuntimeControls', () => ({
  useProviderRuntimeControls: () => ({ available: false }),
}));
vi.mock('@/modules/chat/hooks/useCodexModelProviders', () => ({
  useCodexModelProviders: () => ({ available: harness.provider === 'codex' && harness.servicesAvailable, model: harness.selectedModel ?? '',
    selection: harness.provider === 'codex' && harness.hasModelSelection ? { modelProvider: 'gateway', model: harness.selectedModel } : undefined,
    modelProvider: 'gateway', select: harness.selectCodexModel,
    modelOptions: [{ value: 'openai/gpt-5.6-sol', label: 'openai/gpt-5.6-sol' }] }),
}));
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: [],
    currentSessionId: harness.sessionId,
    setCurrentSessionId: () => {},
    requestLatestMessages: async () => {},
  }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({ input: '', setInput: () => {}, textareaRef: { current: null } }),
}));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: harness.composer }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));

const { default: ChatInterface } = await import('@/modules/chat/ChatInterface');

const project: Project = { projectId: 'p1', displayName: 'repo', fullPath: '/work/repo', path: '/work/repo' };
const session: ProjectSession = { id: 'session-a', provider: 'claude' };

beforeEach(() => {
  harness.provider = 'claude';
  harness.sessionId = 'session-a';
  harness.servicesAvailable = true;
  harness.hasModelSelection = true;
  harness.selectedModel = 'openai/gpt-5.6-sol';
  harness.effortOptions = [{ value: 'low' }, { value: 'high' }];
  vi.clearAllMocks();
});

test('ChatInterface gives useScheduledMessages the websocket subscribe, so the banner stays live', () => {
  render(
    <ChatInterface
      isActive
      selectedProject={project}
      selectedSession={session}
      ws={null}
      sendMessage={() => {}}
    />,
  );

  const calls = harness.useScheduledMessages.mock.calls;
  assert.ok(calls.length > 0, 'ChatInterface no longer reads the scheduled list through useScheduledMessages');
  for (const [sessionId, subscribe] of calls) {
    assert.equal(sessionId, harness.sessionId);
    assert.equal(
      subscribe,
      harness.subscribe,
      'useScheduledMessages must get the websocket context\'s subscribe, or scheduled_messages_changed is never heard',
    );
  }
});

test('a service model without catalog metadata retains Codex reasoning choices and saves the chosen effort', async () => {
  harness.provider = 'codex';
  render(<ChatInterface isActive selectedProject={project} selectedSession={{ ...session, provider: 'codex' }} ws={null} sendMessage={() => {}} />);
  const props = harness.composer.mock.calls.at(-1)![0];
  assert.equal(props.model, 'openai/gpt-5.6-sol');
  assert.deepEqual(props.availableEffortOptions, [{ value: 'low' }, { value: 'high' }]);
  assert.equal(props.effort, 'high');
  await act(async () => { await props.onSelectEffort('low'); });
  assert.deepEqual(harness.selectProviderEffort.mock.calls, [['codex', 'low', harness.sessionId]]);
});

test('an empty service model hides reasoning choices until a model is selected', () => {
  harness.provider = 'codex';
  harness.selectedModel = null;
  render(<ChatInterface isActive selectedProject={project} selectedSession={{ ...session, provider: 'codex' }} ws={null} sendMessage={() => {}} />);
  const props = harness.composer.mock.calls.at(-1)![0];
  assert.equal(props.model, '');
  assert.deepEqual(props.availableEffortOptions, []);
});

test('models with no declared reasoning levels keep their reasoning choices hidden', () => {
  harness.provider = 'codex';
  harness.effortOptions = [];
  render(<ChatInterface isActive selectedProject={project} selectedSession={{ ...session, provider: 'codex' }} ws={null} sendMessage={() => {}} />);
  assert.deepEqual(harness.composer.mock.calls.at(-1)![0].availableEffortOptions, []);
});

test.each([null, 'session-a'])('the first remote model pick uses session controls with session %s', async (sessionId) => {
  harness.provider = 'codex';
  harness.sessionId = sessionId;
  harness.hasModelSelection = false;
  render(<ChatInterface isActive selectedProject={project}
    selectedSession={sessionId ? { id: sessionId, provider: 'codex' } : null} ws={null} sendMessage={() => {}} />);

  await act(async () => { await harness.composer.mock.calls.at(-1)![0].onSelectModel('gateway/new-model'); });

  assert.deepEqual(harness.selectCodexModel.mock.calls, [['gateway', 'gateway/new-model']]);
  assert.equal(harness.selectProviderModel.mock.calls.length, 0, 'a remote id must not be reconciled against the built-in global catalog');
});

test.each(['codex', 'claude'] as const)('%s without service choices keeps the existing model selector', async (provider) => {
  harness.provider = provider;
  harness.sessionId = null;
  harness.servicesAvailable = false;
  harness.hasModelSelection = false;
  render(<ChatInterface isActive selectedProject={project} selectedSession={null} ws={null} sendMessage={() => {}} />);

  await act(async () => { await harness.composer.mock.calls.at(-1)![0].onSelectModel('builtin-model'); });

  assert.equal(harness.selectCodexModel.mock.calls.length, 0);
  assert.deepEqual(harness.selectProviderModel.mock.calls, [[provider, 'builtin-model', null]]);
});
