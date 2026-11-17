import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { CodexControlPanel } from '@/modules/chat/composer/CodexControlPanel';
import { useCodexModelProviders } from '@/modules/chat/hooks/useCodexModelProviders';
import { api } from '@/shared/api';
import type { CodexBranchForkResult, CodexControls, CodexModelProviderControls, CodexSessionState } from '@/shared/types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const models = [{ value: 'shared-model', label: 'Shared model' }, { value: 'gateway-model', label: 'Gateway model' }];
const directory = { defaultProvider: 'openai', hasCustomProviders: true,
  providers: [{ id: 'openai', name: 'OpenAI' }, { id: 'gateway', name: 'Gateway' }] };
const response = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify({ success: status < 400, data }), { status }));

const NATIVE_IDLE: CodexSessionState = { runtime: 'app-server', mode: 'default', phase: 'idle', turnId: null, goal: null, questions: [] };

function nativeControls(patch: Partial<CodexSessionState> = {}, extra: Partial<CodexControls> = {}): CodexControls {
  return { sessionId: 'source-session', state: { ...NATIVE_IDLE, ...patch },
    pending: false, error: null, delivery: null, control: vi.fn().mockResolvedValue(undefined), steer: vi.fn(), ...extra };
}

function controller(patch: Partial<CodexModelProviderControls> = {}): CodexModelProviderControls {
  return {
    available: true, providers: directory.providers, modelProvider: 'openai', model: 'shared-model',
    activeSelection: { modelProvider: 'openai', model: 'shared-model' },
    loading: false, pending: false, error: null, modelOptions: models, modelOptionsFor: vi.fn(() => models),
    refresh: vi.fn().mockResolvedValue(undefined), loadModels: vi.fn().mockResolvedValue(['shared-model', 'gateway-model']),
    select: vi.fn().mockResolvedValue(undefined),
    forkWithHistory: vi.fn().mockResolvedValue({ ok: true, sessionId: 'forked-session' }),
    ...patch,
  };
}

function openSettings(controls: CodexModelProviderControls, codex: CodexControls = nativeControls()) {
  const view = render(<CodexControlPanel controls={codex} modelProviders={controls} onExecutePlan={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  return view;
}

const serviceField = () => screen.getByRole('combobox', { name: 'Model service' }) as HTMLSelectElement;
const branchButton = () => screen.queryByRole('button', { name: /branch/ }) as HTMLButtonElement | null;

test('choosing another service stages a branch target and prefills the model the conversation uses', async () => {
  // The target's catalog is not loaded yet, so staging has to fetch it first.
  const catalogs: Record<string, string[]> = {};
  const controls = controller({
    modelOptionsFor: vi.fn((id: string) => catalogs[id]?.map((value) => ({ value, label: value })) ?? null),
    loadModels: vi.fn(async (id: string) => { catalogs[id] = ['shared-model', 'gateway-model']; return catalogs[id]; }),
  });
  openSettings(controls);

  fireEvent.change(serviceField(), { target: { value: 'gateway' } });

  // The source conversation is never written to; the target exists only here.
  expect(controls.select).not.toHaveBeenCalled();
  expect(controls.forkWithHistory).not.toHaveBeenCalled();
  expect(serviceField().value).toBe('gateway');
  expect(screen.getByText('Currently using: OpenAI · shared-model')).toBeTruthy();
  expect(screen.queryByText(/^Next turn:/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Create branch with history' })).toBeTruthy();
  await waitFor(() => expect(controls.loadModels).toHaveBeenCalledWith('gateway'));
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Branch model' }) as HTMLSelectElement).value).toBe('shared-model'));
});

test('creating a branch asks for the full history on the staged target', async () => {
  const controls = controller();
  openSettings(controls);
  fireEvent.change(serviceField(), { target: { value: 'gateway' } });
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Branch model' }) as HTMLSelectElement).value).toBe('shared-model'));

  fireEvent.click(screen.getByRole('button', { name: 'Create branch with history' }));

  await waitFor(() => expect(controls.forkWithHistory).toHaveBeenCalledWith({ modelProvider: 'gateway', model: 'shared-model' }));
  expect(controls.select).not.toHaveBeenCalled();
});

test('a staged target with no catalog model requires an explicit choice before branching', async () => {
  const controls = controller({ modelProvider: 'gateway', model: '',
    selection: { modelProvider: 'gateway', model: null },
    // The source model is not offered by the target, so it cannot be preselected.
    modelOptionsFor: vi.fn(() => models.filter((option) => option.value === 'gateway-model')),
    loadModels: vi.fn().mockResolvedValue(['gateway-model']) });
  openSettings(controls);

  expect(screen.getByText('Currently using: OpenAI · shared-model')).toBeTruthy();
  expect(screen.getByText('Choose a model to create the branch.')).toBeTruthy();
  expect(branchButton()?.disabled).toBe(true);
  fireEvent.click(branchButton()!);
  expect(controls.forkWithHistory).not.toHaveBeenCalled();

  fireEvent.change(screen.getByRole('combobox', { name: 'Branch model' }), { target: { value: 'gateway-model' } });
  expect(branchButton()?.disabled).toBe(false);
  fireEvent.click(branchButton()!);
  await waitFor(() => expect(controls.forkWithHistory).toHaveBeenCalledWith({ modelProvider: 'gateway', model: 'gateway-model' }));
});

test('a saved target model the service no longer offers must be chosen again before branching', async () => {
  const controls = controller({ modelProvider: 'gateway', model: 'removed',
    selection: { modelProvider: 'gateway', model: 'removed' },
    modelOptionsFor: vi.fn(() => [{ value: 'valid-model', label: 'Valid model' }]),
    loadModels: vi.fn().mockResolvedValue(['valid-model']) });
  openSettings(controls);

  const branchModel = () => screen.getByRole('combobox', { name: 'Branch model' }) as HTMLSelectElement;
  // The removed id is not offered as if it were a valid choice.
  expect(branchModel().value).toBe('');
  expect(screen.queryByRole('option', { name: 'removed' })).toBeNull();
  expect(screen.getByText('The model removed is not available from this service. Choose a model to create the branch.')).toBeTruthy();
  expect(branchButton()?.disabled).toBe(true);
  fireEvent.click(branchButton()!);
  expect(controls.forkWithHistory).not.toHaveBeenCalled();

  fireEvent.change(branchModel(), { target: { value: 'valid-model' } });
  expect(branchButton()?.disabled).toBe(false);
  fireEvent.click(branchButton()!);
  await waitFor(() => expect(controls.forkWithHistory).toHaveBeenCalledWith({ modelProvider: 'gateway', model: 'valid-model' }));
});

test('an unloaded or failed target catalog keeps branching disabled', async () => {
  const neverResolves = new Promise<string[]>(() => {});
  const controls = controller({ modelOptionsFor: vi.fn(() => null), loadModels: vi.fn(() => neverResolves) });
  const view = openSettings(controls);

  fireEvent.change(serviceField(), { target: { value: 'gateway' } });

  await waitFor(() => expect(controls.loadModels).toHaveBeenCalledWith('gateway'));
  expect(branchButton()?.disabled).toBe(true);
  expect((screen.getByRole('combobox', { name: 'Branch model' }) as HTMLSelectElement).disabled).toBe(true);
  view.unmount();

  const failed = controller({ modelOptionsFor: vi.fn(() => null), loadModels: vi.fn().mockRejectedValue(new Error('Models unavailable')) });
  openSettings(failed);
  fireEvent.change(serviceField(), { target: { value: 'gateway' } });

  expect((await screen.findByRole('alert')).textContent).toBe('Models unavailable');
  expect(branchButton()?.disabled).toBe(true);

  // Re-staging the same target retries the catalog instead of staying stuck.
  fireEvent.change(serviceField(), { target: { value: 'gateway' } });
  await waitFor(() => expect(failed.loadModels).toHaveBeenCalledTimes(2));
});

test('a source catalog failure the hook already reports stays visible', () => {
  const controls = controller({ error: 'Could not read this service’s models.' });
  openSettings(controls);

  expect(screen.getByRole('alert').textContent).toBe('Could not read this service’s models.');
});

test('a rejected branch keeps the source conversation and reports the server code, not its English text', async () => {
  const controls = controller({ forkWithHistory: vi.fn().mockResolvedValue({ ok: false,
    code: 'CODEX_MODEL_PROVIDER_FORK_BUSY', message: 'FORK_REFUSED: session is working' }) });
  openSettings(controls);
  fireEvent.change(serviceField(), { target: { value: 'gateway' } });
  await waitFor(() => expect(branchButton()?.disabled).toBe(false));

  fireEvent.click(branchButton()!);

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('This conversation is still running. Empty its queue and finish or stop it before creating a branch.');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.queryByText(/FORK_REFUSED/)).toBeNull();
  expect(controls.select).not.toHaveBeenCalled();
  expect(serviceField().value).toBe('gateway');
  // The failure is retryable in place.
  expect(branchButton()?.disabled).toBe(false);
  fireEvent.click(branchButton()!);
  await waitFor(() => expect(controls.forkWithHistory).toHaveBeenCalledTimes(2));
});

test('an unfamiliar failure code still surfaces the server message', async () => {
  const controls = controller({ forkWithHistory: vi.fn().mockResolvedValue({ ok: false,
    code: 'CODEX_MODEL_PROVIDER_FORK_NEW_REASON', message: 'Unexpected backend reason.' }) });
  openSettings(controls, nativeControls({}, { sessionId: 'source-session' }));
  fireEvent.change(serviceField(), { target: { value: 'gateway' } });
  await waitFor(() => expect(branchButton()?.disabled).toBe(false));

  fireEvent.click(branchButton()!);

  expect((await screen.findByRole('alert')).textContent).toBe('Unexpected backend reason.');
});

test('a saved target that the native thread never adopted is restored as a branch target', async () => {
  const controls = controller({ modelProvider: 'gateway', model: 'gateway-model',
    selection: { modelProvider: 'gateway', model: 'gateway-model' } });
  openSettings(controls);

  expect(serviceField().value).toBe('gateway');
  expect(screen.getByText('Currently using: OpenAI · shared-model')).toBeTruthy();
  expect(screen.queryByText('Next turn: Gateway · gateway-model')).toBeNull();
  expect((screen.getByRole('combobox', { name: 'Branch model' }) as HTMLSelectElement).value).toBe('gateway-model');
  await waitFor(() => expect(branchButton()?.disabled).toBe(false));

  // Re-selecting the same target must not make the restore entry disappear.
  fireEvent.change(serviceField(), { target: { value: 'gateway' } });
  await waitFor(() => expect(controls.loadModels).toHaveBeenCalledWith('gateway'));
  expect((await screen.findByRole('combobox', { name: 'Branch model' }) as HTMLSelectElement).value).toBe('gateway-model');
  expect(screen.getByRole('button', { name: 'Create branch with history' })).toBeTruthy();
  expect(controls.select).not.toHaveBeenCalled();
});

test('returning to the source service restores its own model instead of the staged target model', async () => {
  const controls = controller({ modelProvider: 'gateway', model: 'gateway-model',
    selection: { modelProvider: 'gateway', model: 'gateway-model' } });
  openSettings(controls);

  fireEvent.change(serviceField(), { target: { value: 'openai' } });

  await waitFor(() => expect(controls.select).toHaveBeenCalledWith('openai', 'shared-model'));
  expect(controls.forkWithHistory).not.toHaveBeenCalled();
});

test('a conversation without native history keeps the existing service control flow', async () => {
  const controls = controller({ activeSelection: undefined });
  openSettings(controls);

  fireEvent.change(serviceField(), { target: { value: 'gateway' } });

  await waitFor(() => expect(controls.select).toHaveBeenCalledWith('gateway', 'shared-model'));
  expect(branchButton()).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Branch model' })).toBeNull();
});

test('a same-service model change is not a branch', () => {
  const controls = controller({ selection: { modelProvider: 'openai', model: 'gateway-model' } });
  openSettings(controls);

  expect(screen.getByText('Next turn: OpenAI · gateway-model')).toBeTruthy();
  expect(branchButton()).toBeNull();
  expect(controls.forkWithHistory).not.toHaveBeenCalled();
});

test('the cross-service rejection code is localized instead of its message', async () => {
  const controls = controller({ activeSelection: undefined,
    select: vi.fn().mockRejectedValue(Object.assign(new Error('MODEL_PROVIDER differs from native thread'), { code: 'CODEX_MODEL_PROVIDER_FORK_REQUIRED' })) });
  openSettings(controls);

  fireEvent.change(serviceField(), { target: { value: 'gateway' } });

  expect((await screen.findByRole('alert')).textContent)
    .toBe('This conversation keeps its current service. Create a branch with history to use another service.');
  expect(screen.queryByText(/MODEL_PROVIDER differs/)).toBeNull();
  expect(serviceField().value).toBe('openai');
});

test('an outstanding branch request disables duplicate submissions', async () => {
  let settle: (result: CodexBranchForkResult) => void = () => {};
  const controls = controller({ forkWithHistory: vi.fn(() => new Promise<CodexBranchForkResult>((resolve) => { settle = resolve; })) });
  openSettings(controls);
  fireEvent.change(serviceField(), { target: { value: 'gateway' } });
  await waitFor(() => expect(branchButton()?.disabled).toBe(false));

  fireEvent.click(branchButton()!);

  const pending = await screen.findByRole('button', { name: 'Creating branch…' });
  expect((pending as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(pending);
  expect(controls.forkWithHistory).toHaveBeenCalledTimes(1);
  expect(serviceField().disabled).toBe(true);

  await act(async () => { settle({ ok: true, sessionId: 'forked-session' }); });
});

test.each([
  ['running turn', nativeControls({ phase: 'running', turnId: 'turn-1' }), {}],
  ['held queue', nativeControls({ queueHeld: true }), {}],
  ['queued draft', nativeControls(), { hasQueuedDraft: true }],
  ['background work', nativeControls(), { hasRunningTasks: true }],
] as const)('branching is disabled while the source has %s', (_label, codex, panelProps) => {
  const controls = controller();
  render(<CodexControlPanel controls={codex} modelProviders={controls} onExecutePlan={() => {}} {...panelProps} />);
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));

  expect(serviceField().disabled).toBe(true);
  expect(screen.getByText('Finish running tasks and empty the message queue before switching model services.')).toBeTruthy();
  expect(branchButton()).toBeNull();
  expect(controls.select).not.toHaveBeenCalled();
});

test('the hook copies the whole transcript onto the target service and navigates to the branch', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => response({ models: ['gateway-model'] }));
  const fork = vi.spyOn(api, 'forkSession').mockImplementation(() => response({ sessionId: 'forked-session' }, 201));
  const onSessionForked = vi.fn();
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls: nativeControls(),
    model: 'shared-model', knownModels: models, onSessionForked }));
  await waitFor(() => expect(view.result.current.available).toBe(true));

  let result: unknown;
  await act(async () => { result = await view.result.current.forkWithHistory({ modelProvider: 'gateway', model: 'gateway-model' }); });

  expect(result).toEqual({ ok: true, sessionId: 'forked-session' });
  expect(fork).toHaveBeenCalledWith('source-session', { codexModelSelection: { modelProvider: 'gateway', model: 'gateway-model' } });
  // No anchor: the branch carries the complete history.
  expect(Object.keys(fork.mock.calls[0][1] as object)).toEqual(['codexModelSelection']);
  expect(onSessionForked).toHaveBeenCalledWith('forked-session');
});

test('the hook returns a fork rejection with its code and does not navigate', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  const fork = vi.spyOn(api, 'forkSession').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
    success: false, error: { code: 'CODEX_MODEL_PROVIDER_FORK_BUSY', message: 'Session is working.' },
  }), { status: 409 })));
  const onSessionForked = vi.fn();
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls: nativeControls(),
    model: 'shared-model', knownModels: models, onSessionForked }));
  await waitFor(() => expect(view.result.current.available).toBe(true));

  let result: unknown;
  await act(async () => { result = await view.result.current.forkWithHistory({ modelProvider: 'gateway', model: 'gateway-model' }); });

  expect(result).toEqual({ ok: false, code: 'CODEX_MODEL_PROVIDER_FORK_BUSY', message: 'Session is working.' });
  expect(fork).toHaveBeenCalledTimes(1);
  expect(onSessionForked).not.toHaveBeenCalled();
});

test('a previewed service catalog is available without replacing the saved selection options', async () => {
  vi.spyOn(api.providers, 'codexModelProviders').mockImplementation(() => response(directory));
  const load = vi.spyOn(api.providers, 'codexModelProviderModels').mockImplementation(() => response({ models: ['gateway-model'] }));
  const view = renderHook(() => useCodexModelProviders({ enabled: true, controls: nativeControls(),
    model: 'shared-model', knownModels: models, onSessionForked: () => {} }));
  await waitFor(() => expect(view.result.current.available).toBe(true));
  await waitFor(() => expect(view.result.current.modelOptions).toEqual([{ value: 'gateway-model', label: 'Gateway model' }]));

  await act(async () => { await view.result.current.loadModels('gateway'); });

  expect(view.result.current.modelOptionsFor('gateway')).toEqual([{ value: 'gateway-model', label: 'Gateway model' }]);
  expect(view.result.current.modelProvider).toBe('openai');
  expect(load).toHaveBeenCalledWith('gateway');
});
