import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { api } from '@/shared/api';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import ModelLibraryPanel from '@/modules/chat/modals/ModelLibraryPanel';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import { readSelectedProvider } from '@/shared/selectedProvider';
import type { LLMProvider, ProjectSession, ProviderModelActions, ProviderModelsDefinition } from '@/shared/types';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

const apiState = vi.hoisted(() => ({
  hidden: [] as string[], failedCatalogs: [] as string[], capabilitiesWait: null as Promise<void> | null,
  capabilitiesMode: 'success' as 'success' | 'network-error' | 'http-error' | 'invalid' | 'legacy',
}));
const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'dsh', 'gptweb'];
const catalog = (provider: LLMProvider): ProviderModelsDefinition => ({
  DEFAULT: `${provider}-builtin`,
  OPTIONS: [
    { value: `${provider}-builtin`, label: `${provider} built in` },
    { value: `${provider}-custom`, label: `${provider} custom`, isCustom: true, recordId: 1 },
  ],
});
const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: (provider: LLMProvider) => okJson({
        success: !apiState.failedCatalogs.includes(provider), data: { models: catalog(provider) },
      }),
      capabilities: async () => {
        await apiState.capabilitiesWait;
        if (apiState.capabilitiesMode === 'network-error') throw new Error('Transient network error');
        if (apiState.capabilitiesMode === 'http-error') return { ok: false, json: async () => ({ success: true, data: { providers: [] } }) };
        if (apiState.capabilitiesMode === 'invalid') return okJson({ success: true, data: null });
        return okJson({ success: true, data: { providers: PROVIDERS.map((provider) => ({
          provider, ...(apiState.capabilitiesMode === 'legacy' ? {} : { hiddenFromModelPicker: apiState.hidden.includes(provider) }),
        })) } });
      },
      sessionActiveModel: (provider: LLMProvider) => okJson({
        success: true, data: { model: `${provider}-existing`, source: 'session' },
      }),
    },
  },
}));
vi.mock('@/modules/task-master', () => ({ NextTaskBanner: () => null }));

const ACTIONS: ProviderModelActions = {
  create: async () => {}, update: async () => {}, remove: async () => {}, setCustomModelsOnly: async () => {},
};
const CATALOGS = Object.fromEntries(PROVIDERS.map((provider) => [provider, catalog(provider)]));
const MODELS = Object.fromEntries(PROVIDERS.map((provider) => [provider, `${provider}-builtin`])) as Record<LLMProvider, string>;

function renderPicker(hiddenModelProviders: LLMProvider[] = []) {
  return render(<ProviderSelectionEmptyState
    selectedSession={null} currentSessionId={null} provider="claude" setProvider={() => {}}
    textareaRef={{ current: null }} providerModels={MODELS} setProviderModel={() => {}}
    providerModelCatalog={CATALOGS} providerModelActions={ACTIONS} providerModelsLoading={false}
    hiddenModelProviders={hiddenModelProviders} tasksEnabled={false} isTaskMasterInstalled={false} setInput={() => {}}
  />);
}

function StatefulPicker() {
  const state = useChatProviderState({ selectedSession: null, selectedProject: null });
  return <ProviderSelectionEmptyState
    selectedSession={null} currentSessionId={null} provider={state.provider} setProvider={state.setProvider}
    textareaRef={{ current: null }} providerModels={state.providerModels} setProviderModel={state.setStoredProviderModel}
    providerModelCatalog={state.providerModelCatalog} providerModelActions={ACTIONS} providerModelsLoading={state.providerModelsLoading}
    hiddenModelProviders={state.hiddenModelProviders} providerVisibilityLoading={state.providerVisibilityLoading}
    providerVisibilityError={state.providerVisibilityError} onRetryProviderVisibility={state.retryProviderVisibility}
    tasksEnabled={false} isTaskMasterInstalled={false} setInput={() => {}}
  />;
}

function renderModelsCommand(provider: LLMProvider, hiddenModelProviders: LLMProvider[], sessionId: string | null = null) {
  return render(<CommandResultModal
    payload={{ kind: 'models', data: { current: { provider, model: `${provider}-builtin` } } }}
    onClose={() => {}} providerModelCatalog={CATALOGS} providerModelActions={ACTIONS} hiddenModelProviders={hiddenModelProviders}
    activeProvider={provider} activeProviderModel={`${provider}-builtin`} currentSessionId={sessionId}
    onSelectProviderModel={async (_provider, model) => ({ scope: sessionId ? 'session' : 'default', model })}
  />);
}

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  apiState.hidden = [];
  apiState.failedCatalogs = [];
  apiState.capabilitiesWait = null;
  apiState.capabilitiesMode = 'success';
  // cmdk scrolls and measures its list, which jsdom does not implement.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('an unset visibility setting preserves the selected provider and every model group', async () => {
  writeUserPreference('selectedProvider', 'cursor');
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.provider, 'cursor');
  assert.deepEqual(result.current.hiddenModelProviders, []);

  renderPicker();
  fireEvent.click(screen.getByRole('button', { name: /Click to change model/ }));
  const picker = within(screen.getByRole('dialog'));
  for (const provider of PROVIDERS) assert.equal(Boolean(picker.queryByText(`${provider} built in`)), true);
});

test('new chats skip a stored hidden provider while preserving its model preference and catalog', async () => {
  apiState.hidden = ['claude', 'cursor'];
  writeUserPreference('selectedProvider', 'cursor');
  localStorage.setItem('cursor-model', 'cursor-custom');
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));

  await waitFor(() => assert.equal(result.current.provider, 'codex'));
  assert.equal(readSelectedProvider(), 'codex');
  assert.equal(localStorage.getItem('cursor-model'), 'cursor-custom');
  assert.equal(result.current.providerModels.cursor, 'cursor-custom');
  assert.deepEqual(result.current.providerModelCatalog.cursor?.OPTIONS, catalog('cursor').OPTIONS);
});

test('existing hidden-provider sessions keep their model and fall back only after navigating to a new chat', async () => {
  apiState.hidden = ['cursor'];
  const session = { id: 'cursor-session', __provider: 'cursor' } as ProjectSession;
  const { result, rerender } = renderHook(({ selectedSession }) => useChatProviderState({ selectedSession, selectedProject: null }),
    { initialProps: { selectedSession: session as ProjectSession | null } });

  await waitFor(() => assert.equal(result.current.currentProviderModel, 'cursor-existing'));
  assert.equal(result.current.provider, 'cursor');
  assert.deepEqual(result.current.currentProviderModelOptions, catalog('cursor').OPTIONS);
  rerender({ selectedSession: null });
  await waitFor(() => assert.equal(result.current.provider, 'claude'));
});

test('hidden providers have no headings, built-in models, custom models or search matches', () => {
  renderPicker(['cursor', 'gptweb']);
  fireEvent.click(screen.getByRole('button', { name: /Click to change model/ }));
  assert.equal(Boolean(screen.queryByRole('button', { name: /Cursor/ })), false);
  assert.equal(Boolean(screen.queryByRole('button', { name: /GPT Web/ })), false);
  assert.equal(Boolean(screen.queryByText('cursor built in')), false);
  assert.equal(Boolean(screen.queryByText('cursor custom')), false);
  assert.equal(Boolean(screen.queryByText('gptweb custom')), false);
  fireEvent.change(screen.getByPlaceholderText('Search models...'), { target: { value: 'cursor' } });
  assert.equal(Boolean(screen.queryByText('No models found.')), true);
});

test('the new-chat model library excludes hidden provider tabs and models', () => {
  renderPicker(['cursor', 'gptweb']);
  fireEvent.click(screen.getByRole('button', { name: /Click to change model/ }));
  fireEvent.click(screen.getByRole('button', { name: /Add model/ }));
  const library = within(screen.getByRole('dialog'));
  assert.equal(Boolean(library.queryByRole('button', { name: /Cursor/ })), false);
  assert.equal(Boolean(library.queryByRole('button', { name: /GPT Web/ })), false);
  assert.equal(Boolean(library.queryByText('cursor custom')), false);
  assert.equal(Boolean(library.queryByRole('button', { name: /Codex/ })), true);
});

test('the model library chooses a visible initial tab when the stored provider is hidden', () => {
  render(<ModelLibraryPanel initialProvider="cursor" hiddenModelProviders={['cursor']}
    providerModelCatalog={CATALOGS} actions={ACTIONS} />);
  assert.equal(screen.getByRole('button', { name: /Claude/ }).getAttribute('aria-pressed'), 'true');
  assert.equal(Boolean(screen.queryByText('cursor custom')), false);
});

test('provider visibility survives a failed model catalog response', async () => {
  apiState.hidden = ['gptweb'];
  apiState.failedCatalogs = ['gptweb'];
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.deepEqual(result.current.hiddenModelProviders, ['gptweb']);
  assert.equal(result.current.providerModelCatalog.gptweb, undefined);
});

test('model options wait for visibility even when catalogs load first', async () => {
  apiState.hidden = ['cursor'];
  let resolveCapabilities!: () => void;
  apiState.capabilitiesWait = new Promise<void>((resolve) => { resolveCapabilities = resolve; });
  writeUserPreference('selectedProvider', 'cursor');
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.deepEqual(result.current.currentProviderModelOptions, []);
  assert.equal(result.current.hiddenModelProviders.length, PROVIDERS.length);
  resolveCapabilities();
  await waitFor(() => assert.equal(result.current.provider, 'claude'));
  assert.deepEqual(result.current.hiddenModelProviders, ['cursor']);
});

test('hiding every provider leaves an empty picker without exposing the previous selection', async () => {
  apiState.hidden = [...PROVIDERS];
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await waitFor(() => assert.equal(result.current.hiddenModelProviders.length, PROVIDERS.length));
  assert.deepEqual(result.current.currentProviderModelOptions, []);
  renderPicker(PROVIDERS);
  assert.equal(Boolean(screen.queryByText('claude built in')), false);
  assert.equal(Boolean(screen.queryByText(/claude-builtin/)), false);
  assert.equal(Boolean(screen.queryByRole('button', { name: /Choose a model/ })), true);
  fireEvent.click(screen.getByRole('button', { name: /Click to change model/ }));
  assert.equal(Boolean(screen.queryByText('No models found.')), true);
  assert.equal((screen.getByRole('button', { name: /Add model/ }) as HTMLButtonElement).disabled, true);
});

for (const mode of ['network-error', 'http-error', 'invalid'] as const) {
  test(`${mode} keeps new-chat models unavailable until a successful retry confirms visibility`, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiState.hidden = ['cursor'];
    apiState.capabilitiesMode = mode;
    writeUserPreference('selectedProvider', 'cursor');
    render(<StatefulPicker />);
    await screen.findByRole('alert');
    assert.equal(Boolean(screen.queryByRole('button', { name: /Click to change model/ })), false);
    assert.equal(Boolean(screen.queryByText('cursor custom')), false);
    apiState.capabilitiesMode = 'success';
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: /Claude.*Click to change model/ });
    fireEvent.click(screen.getByRole('button', { name: /Click to change model/ }));
    assert.equal(Boolean(screen.queryByRole('button', { name: /Cursor/ })), false);
    assert.equal(Boolean(screen.queryByText('cursor built in')), false);
    assert.equal(Boolean(screen.queryByText('cursor custom')), false);
  });
}

test('a successful legacy capability list without visibility fields still shows all providers', async () => {
  apiState.hidden = ['cursor'];
  apiState.capabilitiesMode = 'legacy';
  writeUserPreference('selectedProvider', 'cursor');
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await waitFor(() => assert.equal(result.current.providerVisibilityLoading, false));
  assert.equal(result.current.providerVisibilityError, false);
  assert.deepEqual(result.current.hiddenModelProviders, []);
  assert.equal(result.current.provider, 'cursor');
});

test('a retry failure preserves an already confirmed visibility matrix', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  apiState.hidden = ['cursor'];
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await waitFor(() => assert.deepEqual(result.current.hiddenModelProviders, ['cursor']));
  apiState.capabilitiesMode = 'network-error';
  act(() => result.current.retryProviderVisibility());
  await waitFor(() => assert.equal(logged.mock.calls.length, 1));
  assert.deepEqual(result.current.hiddenModelProviders, ['cursor']);
  assert.equal(result.current.providerVisibilityError, false);
});

test('a hanging visibility request times out without revealing models', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(api.providers, 'capabilities').mockImplementation((options = {}) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  assert.equal(result.current.providerVisibilityError, true);
  assert.equal(result.current.providerVisibilityLoading, false);
  assert.deepEqual(result.current.currentProviderModelOptions, []);
});

test('a capability failure leaves an existing hidden-provider session usable', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  apiState.capabilitiesMode = 'network-error';
  const session = { id: 'cursor-existing', __provider: 'cursor' } as ProjectSession;
  const { result } = renderHook(() => useChatProviderState({ selectedSession: session, selectedProject: null }));
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'cursor-existing'));
  assert.equal(result.current.provider, 'cursor');
  assert.deepEqual(result.current.currentProviderModelOptions, catalog('cursor').OPTIONS);
});

test('the new-chat /models library hides deployment-hidden providers', () => {
  renderModelsCommand('claude', ['cursor', 'gptweb']);
  fireEvent.click(screen.getByRole('button', { name: 'Manage models' }));
  assert.equal(Boolean(screen.queryByRole('button', { name: /Cursor/ })), false);
  assert.equal(Boolean(screen.queryByRole('button', { name: /GPT Web/ })), false);
  assert.equal(Boolean(screen.queryByRole('button', { name: /Codex/ })), true);
  assert.equal(Boolean(screen.queryByText('cursor custom')), false);
});

test('an existing-session /models library keeps its hidden provider and models available', () => {
  renderModelsCommand('cursor', ['cursor'], 'cursor-existing');
  assert.equal(Boolean(screen.queryByText('cursor built in')), true);
  fireEvent.click(screen.getByRole('button', { name: 'Manage models' }));
  assert.equal(Boolean(screen.queryByRole('button', { name: /Cursor/ })), true);
  assert.equal(Boolean(screen.queryByText('cursor custom')), true);
});

test('a stale /models payload does not restore a hidden provider after navigation to a new chat', () => {
  renderModelsCommand('cursor', ['cursor']);
  assert.equal(Boolean(screen.queryByRole('button', { name: /Cursor/ })), false);
  assert.equal(Boolean(screen.queryByText('cursor built in')), false);
  assert.equal(Boolean(screen.queryByText('cursor custom')), false);
});

test('an already open session model library drops hidden models when navigating to a new chat', () => {
  const view = renderModelsCommand('cursor', ['cursor'], 'cursor-existing');
  fireEvent.click(screen.getByRole('button', { name: 'Manage models' }));
  assert.equal(Boolean(screen.queryByText('cursor custom')), true);
  view.rerender(<CommandResultModal
    payload={{ kind: 'models', data: { current: { provider: 'cursor', model: 'cursor-builtin' } } }}
    onClose={() => {}} providerModelCatalog={CATALOGS} providerModelActions={ACTIONS} hiddenModelProviders={['cursor']}
    activeProvider="claude" activeProviderModel="claude-builtin" currentSessionId={null}
    onSelectProviderModel={async (_provider, model) => ({ scope: 'default', model })}
  />);
  assert.equal(Boolean(screen.queryByRole('button', { name: /Cursor/ })), false);
  assert.equal(Boolean(screen.queryByText('cursor custom')), false);
  assert.equal(Boolean(screen.queryByRole('button', { name: 'Back to models' })), false);
});

test('an open /models dialog exposes no models if every provider is hidden', () => {
  renderModelsCommand('claude', PROVIDERS);
  assert.equal(Boolean(screen.queryByText('No models found.')), true);
  assert.equal(Boolean(screen.queryByText('claude built in')), false);
  assert.equal(Boolean(screen.queryByRole('textbox')), false);
});
