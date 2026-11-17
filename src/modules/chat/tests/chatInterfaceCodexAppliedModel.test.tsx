import assert from 'node:assert/strict';

import type { ComponentProps } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type ChatComposer from '@/modules/chat/composer/ChatComposer';
import type { CodexModelProviderControls, Project, ProjectSession } from '@/shared/types';

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
}));

vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: harness.composer }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => null, cancel: async () => false }),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
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
    provider: 'codex',
    providerCapabilities: {},
    pendingPermissionRequests: [],
    providerModelCatalog: {},
    currentProviderModelOptions: [], currentProviderModel: 'a-model',
    currentProviderEffort: 'high', currentProviderEffortOptions: [],
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
  useCodexControls: () => ({ state: { runtime: 'app-server', questions: [] } }),
}));
vi.mock('@/modules/chat/hooks/useProviderRuntimeControls', () => ({
  useProviderRuntimeControls: () => ({ available: false }),
}));
vi.mock('@/modules/chat/hooks/useCodexModelProviders', () => ({
  useCodexModelProviders: () => {
    const activeSelection = { modelProvider: 'alpha', model: 'a-model' };
    const savedTarget = { modelProvider: 'beta', model: 'b-model' };
    const sameServiceTarget = { modelProvider: 'alpha', model: 'next-model' };
    // Same service: the pending model is applied. Other service: only a branch target.
    const appliedSelection = harness.sameServiceTarget ? sameServiceTarget : activeSelection;
    const shown = appliedSelection;
    return {
      available: true, providers: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
      modelProvider: shown.modelProvider, model: shown.model,
      selection: harness.sameServiceTarget ? sameServiceTarget : savedTarget,
      appliedSelection: shown, activeSelection,
      modelOptions: [{ value: shown.model, label: shown.model }],
      modelOptionsFor: () => null, loading: false, pending: false, error: null,
      refresh: async () => {}, loadModels: async () => [], select: async () => {},
      forkWithHistory: async () => ({ ok: true, sessionId: 'forked-session' }),
    } satisfies CodexModelProviderControls;
  },
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({ input: '', setInput: () => {}, textareaRef: { current: null } }),
}));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));

const { default: ChatInterface } = await import('@/modules/chat/ChatInterface');

const project: Project = { projectId: 'p1', displayName: 'repo', fullPath: '/work/repo', path: '/work/repo' };
const session: ProjectSession = { id: 'source-session', provider: 'codex' };

function renderChat() {
  return render(<ChatInterface isActive selectedProject={project} selectedSession={session} ws={null} sendMessage={() => {}} />);
}

beforeEach(() => { harness.sameServiceTarget = false; vi.clearAllMocks(); });

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
