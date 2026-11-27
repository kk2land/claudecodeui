import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import AccountContent from '@/modules/settings/tabs/agents-settings/sections/content/AccountContent';
import type * as SharedApi from '@/shared/api';
import { CODEX_MODEL_PROVIDERS_CHANGED_EVENT } from '@/shared/constants';
import type { CodexModelProviders, ProviderAuthStatus } from '@/shared/types';

/**
 * The Codex account panel exposes one global default model service. These tests
 * pin the confirmed-value behaviour: options come from the server directory, a
 * save is only reflected after the server answers, failures keep the previous
 * value, and changing the default notifies mounted chat hooks.
 */

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  update: vi.fn(),
}));
const { read, save, update } = mocks;

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedApi>()),
  api: { providers: {
    codexModelProviders: mocks.read,
    setCodexDefaultModelProvider: mocks.save,
    updateCodexModelProvider: mocks.update,
  } },
}));

// The CLI row is unrelated to this card and would make its own status request.
vi.mock('@/modules/settings/tabs/agents-settings/sections/content/ProviderCliVersion', () => ({
  default: () => null,
}));

const directory: CodexModelProviders = {
  defaultProvider: 'alpha',
  hasCustomProviders: true,
  canChangeDefault: true,
  providers: [
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', canEdit: false, settings: { type: 'openai' } },
    { id: 'alpha', name: 'Alpha service', baseUrl: 'https://alpha.example.com/v1', canEdit: true,
      settings: { type: 'customGateway', auth: { mode: 'environmentVariable', envKey: 'ALPHA_API_KEY' } } },
    { id: 'beta', name: 'Beta service', baseUrl: 'https://beta.example.com/v1', canEdit: true,
      settings: { type: 'customGateway', auth: { mode: 'externallyConfigured', envKey: 'BETA_API_KEY' } } },
  ],
};

const authStatus: ProviderAuthStatus = {
  authenticated: true,
  email: 'someone@example.com',
  method: 'credentials_file',
  error: null,
  loading: false,
};

const respond = (data: unknown, status = 200) => Promise.resolve(new Response(
  JSON.stringify({ success: status < 400, data, error: status < 400 ? undefined : { message: 'Service offline' } }),
  { status },
));

const fail = (status: number, error: { code: string; message: string }) => Promise.resolve(new Response(
  JSON.stringify({ success: false, error }),
  { status },
));

const renderAccount = (agent: 'codex' | 'claude' = 'codex') => render(
  <AccountContent agent={agent} authStatus={authStatus} onLogin={() => {}} />,
);

const select = () => screen.findByRole('combobox', { name: 'Default model service' }) as Promise<HTMLSelectElement>;

beforeEach(() => {
  read.mockReset();
  read.mockImplementation(() => respond(directory));
  save.mockReset();
  update.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Codex default model service card', () => {
  it('initializes from the server default and lists every service, including OpenAI', async () => {
    renderAccount();
    const control = await select();
    await waitFor(() => expect(control.value).toBe('alpha'));
    expect(control.disabled).toBe(false);
    expect(screen.getByRole('option', { name: 'OpenAI' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Alpha service' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Beta service' })).toBeTruthy();
  });

  it('keeps a server default that is missing from the option list instead of showing OpenAI', async () => {
    read.mockImplementation(() => respond({ ...directory, defaultProvider: 'removed' }));
    renderAccount();
    const control = await select();
    await waitFor(() => expect(control.value).toBe('removed'));
    expect(screen.getByRole('option', { name: 'removed' })).toBeTruthy();
  });

  it('saves the chosen service and notifies mounted chat hooks after the server confirms', async () => {
    const changed = vi.fn();
    window.addEventListener(CODEX_MODEL_PROVIDERS_CHANGED_EVENT, changed);
    save.mockImplementation(() => respond({ ...directory, defaultProvider: 'beta' }));

    renderAccount();
    const control = await select();
    await waitFor(() => expect(control.value).toBe('alpha'));
    fireEvent.change(control, { target: { value: 'beta' } });

    await waitFor(() => expect(save).toHaveBeenCalledWith('beta'));
    await waitFor(() => expect(control.value).toBe('beta'));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(control.disabled).toBe(false);
    window.removeEventListener(CODEX_MODEL_PROVIDERS_CHANGED_EVENT, changed);
  });

  it('sends OpenAI as the explicit request value', async () => {
    save.mockImplementation(() => respond({ ...directory, defaultProvider: 'openai' }));
    renderAccount();
    const control = await select();
    await waitFor(() => expect(control.value).toBe('alpha'));
    fireEvent.change(control, { target: { value: 'openai' } });
    await waitFor(() => expect(save).toHaveBeenCalledWith('openai'));
    expect(save.mock.calls[0][0]).toBe('openai');
  });

  it('keeps the confirmed service and shows an alert when saving fails', async () => {
    save.mockImplementation(() => respond(directory, 500));
    renderAccount();
    const control = await select();
    await waitFor(() => expect(control.value).toBe('alpha'));

    fireEvent.change(control, { target: { value: 'beta' } });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Service offline');
    expect(control.value).toBe('alpha');
    expect(control.disabled).toBe(false);
  });

  it('disables the select while a save is in flight', async () => {
    let resolveSave: ((response: Response) => void) | undefined;
    save.mockImplementation(() => new Promise<Response>((resolve) => { resolveSave = resolve; }));
    renderAccount();
    const control = await select();
    await waitFor(() => expect(control.value).toBe('alpha'));

    fireEvent.change(control, { target: { value: 'beta' } });
    await waitFor(() => expect(control.disabled).toBe(true));

    resolveSave?.(await respond({ ...directory, defaultProvider: 'beta' }));
    await waitFor(() => expect(control.value).toBe('beta'));
    expect(control.disabled).toBe(false);
  });

  it('shows a load failure with a retry that re-reads the directory', async () => {
    read.mockImplementationOnce(() => respond(directory, 500));
    renderAccount();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load model services.');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect((await select()).value).toBe('alpha');
  });

  it('does not render or request the directory for another agent', () => {
    renderAccount('claude');
    expect(screen.queryByRole('combobox', { name: 'Default model service' })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('Codex model service editing', () => {
  it('edits a custom gateway with only the fields the user changed and leaves its external credential alone', async () => {
    const changed = vi.fn();
    window.addEventListener(CODEX_MODEL_PROVIDERS_CHANGED_EVENT, changed);
    update.mockImplementation(() => respond({ provider: { ...directory.providers[2], name: 'Beta renamed' } }));
    read.mockImplementationOnce(() => respond(directory))
      .mockImplementation(() => respond({ ...directory, providers: [directory.providers[0], directory.providers[1],
        { ...directory.providers[2], name: 'Beta renamed' }] }));

    renderAccount();
    await select();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[1]);
    const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    // The externally configured key is shown as a hint and is never re-sent on an unrelated edit.
    expect((screen.getByRole('textbox', { name: 'Environment variable' }) as HTMLInputElement).value).toBe('BETA_API_KEY');
    fireEvent.change(name, { target: { value: 'Beta renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(update).toHaveBeenCalledWith('beta', { type: 'customGateway', providerId: 'beta', name: 'Beta renamed' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('codex-model-provider-editor')).toBeNull());
    expect(screen.getByRole('option', { name: 'Beta renamed' })).toBeTruthy();
    window.removeEventListener(CODEX_MODEL_PROVIDERS_CHANGED_EVENT, changed);
  });

  it('offers no custom gateway create action', async () => {
    renderAccount();
    await select();
    // The services list is there, with its per-service edit actions, but no create form.
    expect(await screen.findAllByRole('button', { name: 'Edit' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Add custom gateway' })).toBeNull();
    expect(screen.queryByTestId('codex-model-provider-editor')).toBeNull();
  });

  it('refuses to save a custom gateway whose name was cleared instead of dropping the edit', async () => {
    renderAccount();
    await select();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: '   ' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Base URL' }), { target: { value: 'https://alpha2.example.com/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Enter a name for this service.')).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByTestId('codex-model-provider-editor')).toBeTruthy();
  });

  it('keeps a failed write open and shows the native reason', async () => {
    update.mockImplementation(() => respond(null, 500));
    renderAccount();
    await select();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Alpha offline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Service offline');
    expect(screen.getByTestId('codex-model-provider-editor')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Alpha offline');
  });

  it('reports a stored default-service change that does not take effect and shows the effective directory', async () => {
    const changed = vi.fn();
    window.addEventListener(CODEX_MODEL_PROVIDERS_CHANGED_EVENT, changed);
    // The write is stored, but another config layer still decides the default.
    save.mockImplementation(() => fail(409, {
      code: 'CODEX_MODEL_PROVIDER_DEFAULT_OVERRIDDEN', message: 'Locked by a managed policy',
    }));
    read.mockImplementationOnce(() => respond(directory))
      .mockImplementation(() => respond({ ...directory, defaultProvider: 'beta' }));

    renderAccount();
    const control = await select();
    await waitFor(() => expect(control.value).toBe('alpha'));
    fireEvent.change(control, { target: { value: 'openai' } });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Codex accepted the change');
    expect(alert.textContent).toContain('Locked by a managed policy');
    // The effective directory, not the requested value, is what the card shows.
    await waitFor(() => expect(control.value).toBe('beta'));
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(CODEX_MODEL_PROVIDERS_CHANGED_EVENT, changed);
  });

  it('keeps an externally configured credential field read-only while every other field still edits', async () => {
    renderAccount();
    await select();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[1]);

    expect((screen.getByRole('textbox', { name: 'Environment variable' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('textbox', { name: 'Base URL' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('shows native services read-only when the user layer or Codex forbids writing them', async () => {
    renderAccount();
    await select();
    // OpenAI and the editable custom services are both listed; only OpenAI is read-only.
    expect((await screen.findAllByRole('button', { name: 'Edit' })).length).toBe(2);
    expect(screen.getAllByText('Read-only: change this service in Codex\'s own configuration.').length).toBe(1);
  });

  it('disables the default service and explains why when the layer forbids changing it', async () => {
    read.mockImplementation(() => respond({ ...directory, canChangeDefault: false }));
    renderAccount();
    const control = await select();
    await waitFor(() => expect(control.disabled).toBe(true));
    expect(screen.getByText('This user layer does not allow changing the default model service.')).toBeTruthy();
  });
});
