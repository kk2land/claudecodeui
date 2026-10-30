import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import { CodexControlPanel } from '@/modules/chat/composer/CodexControlPanel';
import { useCodexModelProviders } from '@/modules/chat/hooks/useCodexModelProviders';
import { api } from '@/shared/api';
import { CODEX_MODEL_PROVIDERS_CHANGED_EVENT } from '@/shared/constants';
import type { CodexControls, CodexModelProviderControls } from '@/shared/types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const models = [{ value: 'shared-model', label: 'Shared model' }, { value: 'alpha-only', label: 'Alpha model' }];
const directory = { defaultProvider: 'alpha', hasCustomProviders: true,
  providers: [{ id: 'alpha', name: 'Alpha service' }, { id: 'beta', name: 'Beta service' }] };
const response = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ success: true, data })));

function controller(patch: Partial<CodexModelProviderControls> = {}): CodexModelProviderControls {
  return { available: true, providers: directory.providers, modelProvider: 'alpha', model: 'shared-model', modelOptions: models,
    loading: false, pending: false, error: null, refresh: vi.fn().mockResolvedValue(undefined),
    loadModels: vi.fn().mockResolvedValue(['shared-model', 'beta-only']), select: vi.fn().mockResolvedValue(undefined), ...patch };
}

const nativeControls: CodexControls = {
  state: { runtime: 'app-server', mode: 'default', phase: 'idle', turnId: null, goal: null, questions: [] },
  pending: false, error: null, delivery: null, control: vi.fn(), steer: vi.fn(),
};

function openSettings(controls: CodexModelProviderControls) {
  const view = render(<CodexControlPanel controls={nativeControls} modelProviders={controls} onExecutePlan={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  return view;
}

test('service selection is in Codex settings while the model popup retains only models and reasoning', () => {
  const controls = controller();
  const refreshModels = vi.fn();
  render(<>
    <CodexControlPanel controls={nativeControls} modelProviders={controls} onExecutePlan={() => {}} />
    <ComposerModelMenu effort="high" effortOptions={[{ value: 'high' }]} onSelectEffort={() => {}}
      model="shared-model" modelOptions={models} onSelectModel={() => {}} modelsLoading={false} onOpen={refreshModels} />
  </>);
  expect(screen.queryByText('Model service')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  expect(screen.getByRole('combobox', { name: 'Model service' })).toBeTruthy();
  expect(screen.getByText('Only this conversation · Takes effect next turn')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
  const menu = within(screen.getByRole('menu'));
  expect(menu.queryByText('Model service')).toBeNull();
  expect(menu.getByRole('menuitem', { name: 'Shared model' })).toBeTruthy();
  expect(menu.getByRole('menuitemradio', { name: 'high' }).getAttribute('aria-checked')).toBe('true');
  expect(refreshModels).toHaveBeenCalledTimes(1);
  expect(controls.refresh).toHaveBeenCalledTimes(1);
});

test('Codex settings omit service selection without extra providers and in SDK mode', () => {
  const controls = controller({ available: false });
  const view = openSettings(controls);
  expect(screen.queryByRole('combobox', { name: 'Model service' })).toBeNull();
  view.rerender(<CodexControlPanel controls={{ ...nativeControls, state: { ...nativeControls.state!, runtime: 'sdk' } }}
    modelProviders={controller()} onExecutePlan={() => {}} />);
  expect(screen.queryByRole('combobox', { name: 'Model service' })).toBeNull();
});

test('the service field submits the current model for the server to retain or clear, without a model picker', async () => {
  const controls = controller();
  openSettings(controls);
  fireEvent.change(screen.getByRole('combobox', { name: 'Model service' }), { target: { value: 'beta' } });
  await waitFor(() => expect(controls.select).toHaveBeenCalledWith('beta', 'shared-model'));
  expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Codex runtime settings' })).toBeTruthy();
});

test('a rejected service change preserves the confirmed service and reports the error in settings', async () => {
  const controls = controller({ select: vi.fn().mockRejectedValue(new Error('Service offline')) });
  openSettings(controls);
  fireEvent.change(screen.getByRole('combobox', { name: 'Model service' }), { target: { value: 'beta' } });
  await screen.findByText('Service offline');
  expect((screen.getByRole('combobox', { name: 'Model service' }) as HTMLSelectElement).value).toBe('alpha');
  expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
});

test.each(['running', 'queued', 'background'] as const)('service switching is disabled with %s work', (kind) => {
  const controls = controller();
  render(<CodexControlPanel controls={kind === 'running' ? { ...nativeControls, state: { ...nativeControls.state!, phase: 'running', turnId: 'turn-1' } } : nativeControls}
    modelProviders={controls} hasQueuedDraft={kind === 'queued'} hasRunningTasks={kind === 'background'} onExecutePlan={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  expect((screen.getByRole('combobox', { name: 'Model service' }) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByText('Finish running tasks and empty the message queue before switching model services.')).toBeTruthy();
  expect(controls.select).not.toHaveBeenCalled();
});

test('an empty model directs selection back to the composer instead of adding a settings model field', () => {
  const controls = controller({ modelProvider: 'beta', model: '', selection: { modelProvider: 'beta', model: null } });
  openSettings(controls);
  expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  expect(screen.getByText('Choose a model below before sending prompts or running queued messages.')).toBeTruthy();
  const select = vi.fn();
  render(<ComposerModelMenu effort="default" effortOptions={[]} onSelectEffort={() => {}}
    model="" modelOptions={[{ value: 'beta-only', label: 'Beta model' }]} onSelectModel={select} modelsLoading={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Select a model' }));
  expect(screen.getByRole('menuitemradio', { name: 'Beta model' }).getAttribute('aria-checked')).toBe('false');
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Beta model' }));
  expect(select).toHaveBeenCalledWith('beta-only');
});

test('next-turn state names the chosen service while the active turn still uses the original service', () => {
  const controls = controller({ modelProvider: 'beta', selection: { modelProvider: 'beta', model: 'shared-model' },
    activeSelection: { modelProvider: 'alpha', model: 'shared-model' } });
  openSettings(controls);
  expect(screen.getByText('Next turn: Beta service · shared-model')).toBeTruthy();
  expect(screen.getByText('Currently using: Alpha service · shared-model')).toBeTruthy();
});

test('mobile service selection is inside the portalled Codex settings panel', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const view = render(<CodexControlPanel controls={nativeControls} modelProviders={controller()} onExecutePlan={() => {}} settingsContainer={host} />);
  expect(within(host).queryByRole('combobox', { name: 'Model service' })).toBeNull();
  fireEvent.click(within(host).getByRole('button', { name: 'Codex' }));
  expect(within(host).getByRole('combobox', { name: 'Model service' })).toBeTruthy();
  expect(within(view.container).queryByRole('combobox', { name: 'Model service' })).toBeNull();
  view.unmount();
  host.remove();
});

test('directory discovery is disabled outside native Codex and an unextended config never fetches models', async () => {
  const read = vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response({ ...directory, hasCustomProviders: false }));
  const load = vi.spyOn(api.providers, 'codexModelProviderModels');
  const controls: CodexControls = { state: null, pending: false, error: null, delivery: null, control: vi.fn(), steer: vi.fn() };
  const view = renderHook(({ enabled }) => useCodexModelProviders({ enabled, controls, model: 'shared-model', knownModels: models }), { initialProps: { enabled: false } });
  expect(read).not.toHaveBeenCalled();
  view.rerender({ enabled: true });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  expect(view.result.current.available).toBe(false);
  expect(load).not.toHaveBeenCalled();
});

test('reopened sessions use their saved choice and service-specific model list instead of a global default', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  const load = vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => response({ models: ['shared-model', 'unknown-model'] }));
  const control = vi.fn().mockResolvedValue(undefined);
  const controls: CodexControls = { state: { runtime: 'app-server', mode: 'default', phase: 'running', turnId: 'turn-1', goal: null, questions: [],
    modelSelection: { modelProvider: 'beta', model: 'unknown-model' }, activeModelSelection: { modelProvider: 'alpha', model: 'shared-model' } },
    pending: false, error: null, delivery: null, control, steer: vi.fn() };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'global-model', knownModels: models }));
  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(2));
  expect(load).toHaveBeenCalledWith('beta');
  expect(view.result.current.model).toBe('unknown-model');
  expect(view.result.current.modelOptions?.find((option) => option.value === 'unknown-model')?.effort).toBeUndefined();
  await act(async () => { await view.result.current.select('beta', 'shared-model'); });
  expect(control).toHaveBeenCalledWith({ action: 'model-provider', modelProvider: 'beta', model: 'shared-model' });
});

test('a persisted empty model never falls back to the global or active thread model on reopen', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => response({ models: ['beta-only'] }));
  const controls: CodexControls = { ...nativeControls, state: { ...nativeControls.state!,
    modelSelection: { modelProvider: 'beta', model: null }, activeModelSelection: { modelProvider: 'alpha', model: 'shared-model' } } };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'global-model', knownModels: models }));
  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(1));
  expect(view.result.current.model).toBe('');
  expect(view.result.current.modelProvider).toBe('beta');
});

test('a settings save announcement re-reads the directory so new conversations use the new default', async () => {
  const read = vi.spyOn(api.providers, 'codexModelProviders')
    .mockImplementationOnce(() => response(directory))
    .mockImplementation(() => response({ ...directory, defaultProvider: 'beta' }));
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => response({ models: ['shared-model'] }));
  const controls: CodexControls = { ...nativeControls, state: null };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'shared-model', knownModels: models }));
  await waitFor(() => expect(view.result.current.modelProvider).toBe('alpha'));

  act(() => { window.dispatchEvent(new Event(CODEX_MODEL_PROVIDERS_CHANGED_EVENT)); });

  await waitFor(() => expect(view.result.current.modelProvider).toBe('beta'));
  expect(read).toHaveBeenCalledTimes(2);
});

test('switching to another conversation re-reads the directory default', async () => {
  const read = vi.spyOn(api.providers, 'codexModelProviders')
    .mockImplementationOnce(() => response(directory))
    .mockImplementationOnce(() => response({ ...directory, defaultProvider: 'beta' }));
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => response({ models: ['shared-model'] }));
  const controls: CodexControls = { ...nativeControls, state: null };
  const view = renderHook(
    ({ sessionId }) => useCodexModelProviders({ enabled: true, controls: { ...controls, sessionId }, model: 'shared-model', knownModels: models }),
    { initialProps: { sessionId: 'session-one' } },
  );
  await waitFor(() => expect(view.result.current.modelProvider).toBe('alpha'));

  view.rerender({ sessionId: 'session-two' });

  await waitFor(() => expect(view.result.current.modelProvider).toBe('beta'));
  expect(read).toHaveBeenCalledTimes(2);
});

test('a saved session selection still wins after the session changes and the directory reloads', async () => {
  const read = vi.spyOn(api.providers, 'codexModelProviders')
    .mockImplementationOnce(() => response(directory))
    .mockImplementation(() => response({ ...directory, defaultProvider: 'openai' }));
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => response({ models: ['beta-only'] }));
  const controls: CodexControls = { ...nativeControls, state: { ...nativeControls.state!,
    modelSelection: { modelProvider: 'beta', model: 'beta-only' } } };
  const view = renderHook(
    ({ sessionId }) => useCodexModelProviders({ enabled: true, controls: { ...controls, sessionId }, model: 'shared-model', knownModels: models }),
    { initialProps: { sessionId: 'session-one' } },
  );
  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(1));

  view.rerender({ sessionId: 'session-two' });

  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(view.result.current.modelProvider).toBe('beta');
  expect(view.result.current.model).toBe('beta-only');
});
