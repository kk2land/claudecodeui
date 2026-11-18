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
const directory = { defaultProvider: 'alpha', hasCustomProviders: true, canChangeDefault: true,
  providers: [
    { id: 'alpha', name: 'Alpha service', baseUrl: 'https://alpha.example.com/v1', canEdit: true,
      settings: { type: 'customGateway' as const, auth: { mode: 'none' as const } } },
    { id: 'beta', name: 'Beta service', baseUrl: 'https://beta.example.com/v1', canEdit: true,
      settings: { type: 'customGateway' as const, auth: { mode: 'none' as const } } },
  ] };
const response = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ success: true, data })));

function controller(patch: Partial<CodexModelProviderControls> = {}): CodexModelProviderControls {
  return { available: true, providers: directory.providers, modelProvider: 'alpha', model: 'shared-model', modelOptions: models,
    modelOptionsFor: vi.fn(() => null), loading: false, pending: false, error: null, refresh: vi.fn().mockResolvedValue(undefined),
    loadModels: vi.fn().mockResolvedValue(['shared-model', 'beta-only']), select: vi.fn().mockResolvedValue(undefined),
    forkWithHistory: vi.fn().mockResolvedValue({ ok: true, sessionId: 'forked-session' }), ...patch };
}

const nativeControls: CodexControls = {
  state: { runtime: 'app-server', mode: 'default', phase: 'idle', turnId: null, goal: null, questions: [] },
  pending: false, error: null, delivery: null, control: vi.fn(), steer: vi.fn(),
};

const catalog = (modelProvider: string, ids: string[]) => ({ modelProvider, models: ids,
  items: ids.map((id) => ({ value: id, label: id, isDefault: id === ids[0], hidden: false })) });

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

test('next-turn state names the chosen model while the active turn still uses the original one', () => {
  const controls = controller({ modelProvider: 'alpha', selection: { modelProvider: 'alpha', model: 'alpha-only' },
    activeSelection: { modelProvider: 'alpha', model: 'shared-model' } });
  openSettings(controls);
  expect(screen.getByText('Next turn: Alpha service · alpha-only')).toBeTruthy();
  expect(screen.getByText('Currently using: Alpha service · shared-model')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create branch with history' })).toBeNull();
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

test('directory discovery is disabled outside native Codex while a default OpenAI-only install still loads its native models', async () => {
  const read = vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response({ ...directory, hasCustomProviders: false }));
  const load = vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => response(catalog('alpha', ['shared-model'])));
  const controls: CodexControls = { state: null, pending: false, error: null, delivery: null, control: vi.fn(), steer: vi.fn() };
  const view = renderHook(({ enabled }) => useCodexModelProviders({ enabled, controls, model: 'shared-model', knownModels: models, onSessionForked: () => {} }), { initialProps: { enabled: false } });
  expect(read).not.toHaveBeenCalled();
  view.rerender({ enabled: true });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  expect(view.result.current.available).toBe(false);
  // Extra services are hidden, but the built-in service still has a native catalog.
  await waitFor(() => expect(load).toHaveBeenCalledWith('alpha'));
  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(1));
});

test('reopened sessions use their saved choice and service-specific model list instead of a global default', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  const load = vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => response({ models: ['shared-model', 'unknown-model'] }));
  const control = vi.fn().mockResolvedValue(undefined);
  const controls: CodexControls = { state: { runtime: 'app-server', mode: 'default', phase: 'running', turnId: 'turn-1', goal: null, questions: [],
    modelSelection: { modelProvider: 'beta', model: 'unknown-model' }, activeModelSelection: { modelProvider: 'beta', model: 'shared-model' } },
    pending: false, error: null, delivery: null, control, steer: vi.fn() };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'global-model', knownModels: models, onSessionForked: () => {} }));
  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(2));
  expect(load).toHaveBeenCalledWith('beta');
  expect(view.result.current.model).toBe('unknown-model');
  expect(view.result.current.modelOptions?.find((option) => option.value === 'unknown-model')?.effort).toBeUndefined();
  await act(async () => { await view.result.current.select('beta', 'shared-model'); });
  expect(control).toHaveBeenCalledWith({ action: 'model-provider', modelProvider: 'beta', model: 'shared-model' });
});

test('a saved target on another service is a branch form value, not the route the composer shows', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  const load = vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => response({ models: ['shared-model', 'a-model'] }));
  const controls: CodexControls = { ...nativeControls, state: { ...nativeControls.state!,
    modelSelection: { modelProvider: 'beta', model: 'b-model' }, activeModelSelection: { modelProvider: 'alpha', model: 'a-model' } } };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'global-model', knownModels: models, onSessionForked: () => {} }));
  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(2));

  // The composer follows the native run; the saved target stays available for the branch form.
  expect(load).toHaveBeenCalledWith('alpha');
  expect(view.result.current.modelProvider).toBe('alpha');
  expect(view.result.current.model).toBe('a-model');
  expect(view.result.current.appliedSelection).toEqual({ modelProvider: 'alpha', model: 'a-model' });
  expect(view.result.current.selection).toEqual({ modelProvider: 'beta', model: 'b-model' });
  expect(view.result.current.activeSelection).toEqual({ modelProvider: 'alpha', model: 'a-model' });
  expect(view.result.current.modelOptionsFor('beta')).toBeNull();
});

test('a persisted empty model never falls back to the global or active thread model on reopen', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => response({ models: ['beta-only'] }));
  const controls: CodexControls = { ...nativeControls, state: { ...nativeControls.state!,
    modelSelection: { modelProvider: 'beta', model: null }, activeModelSelection: { modelProvider: 'beta', model: 'shared-model' } } };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'global-model', knownModels: models, onSessionForked: () => {} }));
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
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'shared-model', knownModels: models, onSessionForked: () => {} }));
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
    ({ sessionId }) => useCodexModelProviders({ enabled: true, controls: { ...controls, sessionId }, model: 'shared-model', knownModels: models, onSessionForked: () => {} }),
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
    ({ sessionId }) => useCodexModelProviders({ enabled: true, controls: { ...controls, sessionId }, model: 'shared-model', knownModels: models, onSessionForked: () => {} }),
    { initialProps: { sessionId: 'session-one' } },
  );
  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(1));

  view.rerender({ sessionId: 'session-two' });

  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(view.result.current.modelProvider).toBe('beta');
  expect(view.result.current.model).toBe('beta-only');
});

test('native catalog metadata stays per service: the same model id keeps its own label and effort on each service', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation((id: string) => response({
    modelProvider: id,
    models: ['shared-model'],
    items: [id === 'alpha'
      ? { value: 'shared-model', label: 'Shared on Alpha', description: 'Alpha reasoning', effort: { default: 'high', values: [{ value: 'low' }, { value: 'high' }] }, isDefault: true, hidden: false }
      : { value: 'shared-model', label: 'Shared on Beta', effort: { values: [] }, isDefault: true, hidden: false }],
  }));
  const controls: CodexControls = { ...nativeControls, state: null };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'shared-model', knownModels: models, onSessionForked: () => {} }));
  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(1));

  // The active service renders its own native metadata, not the shared catalog's.
  expect(view.result.current.modelOptions?.[0]).toEqual({
    value: 'shared-model', label: 'Shared on Alpha', description: 'Alpha reasoning',
    effort: { default: 'high', values: [{ value: 'low' }, { value: 'high' }] },
  });

  await act(async () => { await view.result.current.loadModels('beta'); });
  const beta = view.result.current.modelOptionsFor('beta');
  expect(beta?.[0]?.label).toBe('Shared on Beta');
  // A reported, empty effort list means this service has no levels; known models must not supply any.
  expect(beta?.[0]?.effort).toEqual({ values: [] });
  expect(view.result.current.modelOptions?.[0]?.label).toBe('Shared on Alpha');
});

test('an unloaded service answers null while a loaded service with no models answers an empty list', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation((id: string) => response(catalog(id, [])));
  const controls: CodexControls = { ...nativeControls, state: null };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'shared-model', knownModels: models, onSessionForked: () => {} }));

  await waitFor(() => expect(view.result.current.modelOptions).toEqual([]));
  expect(view.result.current.modelOptionsFor('beta')).toBeNull();
});

test('a change announcement re-reads the edited service even when its id stayed the same', async () => {
  const read = vi.spyOn(api.providers, 'codexModelProviders')
    .mockImplementationOnce(() => response(directory))
    .mockImplementation(() => response({ ...directory, providers: directory.providers.map((provider) => (
      provider.id === 'alpha' ? { ...provider, name: 'Alpha renamed' } : provider)) }));
  const load = vi.spyOn(api.providers, 'codexModelProviderModels')
    .mockImplementationOnce(() => response(catalog('alpha', ['shared-model'])))
    .mockImplementation(() => response(catalog('alpha', ['edited-model'])));
  const controls: CodexControls = { ...nativeControls, state: null };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'shared-model', knownModels: models, onSessionForked: () => {} }));
  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(1));

  act(() => { window.dispatchEvent(new Event(CODEX_MODEL_PROVIDERS_CHANGED_EVENT)); });

  // An edited endpoint behind an unchanged id must not leave the old catalog in place.
  await waitFor(() => expect(view.result.current.modelOptions?.[0]?.value).toBe('edited-model'));
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenLastCalledWith('alpha');
  expect(read).toHaveBeenCalledTimes(2);
});

test('a failed catalog reload keeps the confirmed service and model and reports its reason', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => Promise.resolve(new Response(
    JSON.stringify({ success: false, error: { message: 'Catalog offline' } }), { status: 502 })));
  const controls: CodexControls = { ...nativeControls, state: null };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'shared-model', knownModels: models, onSessionForked: () => {} }));

  await waitFor(() => expect(view.result.current.error).toBe('Catalog offline'));
  expect(view.result.current.modelProvider).toBe('alpha');
  expect(view.result.current.modelOptions).toBeNull();
  await act(async () => { await expect(view.result.current.loadModels('alpha')).rejects.toThrow(); });
});

test('a catalog is not exposed once the composer leaves native Codex', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation((id: string) => response(catalog(id, ['shared-model'])));
  const controls: CodexControls = { ...nativeControls, state: null };
  const view = renderHook(
    ({ enabled }) => useCodexModelProviders({ enabled, controls, model: 'shared-model', knownModels: models, onSessionForked: () => {} }),
    { initialProps: { enabled: true } },
  );
  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(1));

  // Switching to Claude (or off native Codex) must not leave Codex models and
  // effort levels available to the shared composer.
  view.rerender({ enabled: false });

  await waitFor(() => expect(view.result.current.modelOptions).toBeNull());
  expect(view.result.current.modelOptionsFor('alpha')).toBeNull();
  expect(view.result.current.available).toBe(false);
});

test('a failed directory reload keeps the confirmed service and models and reports the reason', async () => {
  const read = vi.spyOn(api.providers, 'codexModelProviders')
    .mockImplementationOnce(() => response(directory))
    .mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ success: false, error: { message: 'Directory offline' } }), { status: 500 })));
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation((id: string) => response(catalog(id, ['shared-model'])));
  const controls: CodexControls = { ...nativeControls, state: null };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'shared-model', knownModels: models, onSessionForked: () => {} }));
  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(1));

  act(() => { window.dispatchEvent(new Event(CODEX_MODEL_PROVIDERS_CHANGED_EVENT)); });

  await waitFor(() => expect(view.result.current.error).toBe('Directory offline'));
  // The last confirmed directory survives, so the selected service and its models stay usable.
  expect(view.result.current.modelProvider).toBe('alpha');
  expect(view.result.current.modelOptionsFor('alpha')).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(2);
});

test('a saved model the service now hides keeps its native label and effort without exposing other hidden models', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  const hidden = (value: string, label: string) => ({
    value, label, description: `${label} description`,
    effort: { default: 'medium', values: [{ value: 'medium' }, { value: 'high' }] },
    isDefault: false, hidden: true,
  });
  const visible = { value: 'new-model', label: 'New model', effort: { values: [] }, isDefault: true, hidden: false };
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation((id: string) => response({
    modelProvider: id,
    // `models` is the visible picker; a retired saved model only exists in `items`.
    models: ['new-model'],
    items: id === 'alpha'
      ? [visible, hidden('retired', 'Retired model'), hidden('other-hidden', 'Other hidden')]
      : [visible, hidden('retired', 'Retired model')],
  }));
  const controls: CodexControls = { ...nativeControls, state: { ...nativeControls.state!,
    modelSelection: { modelProvider: 'alpha', model: 'retired' }, activeModelSelection: { modelProvider: 'alpha', model: 'retired' } } };
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls, model: 'global-model', knownModels: models, onSessionForked: () => {} }));

  await waitFor(() => expect(view.result.current.modelOptions).toHaveLength(2));
  const options = view.result.current.modelOptions ?? [];
  expect(options.find((option) => option.value === 'retired')).toEqual({
    value: 'retired', label: 'Retired model', description: 'Retired model description',
    effort: { default: 'medium', values: [{ value: 'medium' }, { value: 'high' }] },
  });
  // The visible catalog is untouched and no other hidden row is offered.
  expect(options.map((option) => option.value)).toEqual(['new-model', 'retired']);
  expect(view.result.current.model).toBe('retired');

  // Another service's preview never gains its hidden rows.
  await act(async () => { await view.result.current.loadModels('beta'); });
  expect(view.result.current.modelOptionsFor('beta')?.map((option) => option.value)).toEqual(['new-model']);
});
