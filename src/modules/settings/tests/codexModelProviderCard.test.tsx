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
}));
const { read, save } = mocks;

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedApi>()),
  api: { providers: { codexModelProviders: mocks.read, setCodexDefaultModelProvider: mocks.save } },
}));

// The CLI row is unrelated to this card and would make its own status request.
vi.mock('@/modules/settings/tabs/agents-settings/sections/content/ProviderCliVersion', () => ({
  default: () => null,
}));

const directory: CodexModelProviders = {
  defaultProvider: 'alpha',
  hasCustomProviders: true,
  providers: [
    { id: 'openai', name: 'OpenAI' },
    { id: 'alpha', name: 'Alpha service' },
    { id: 'beta', name: 'Beta service' },
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

const renderAccount = (agent: 'codex' | 'claude' = 'codex') => render(
  <AccountContent agent={agent} authStatus={authStatus} onLogin={() => {}} />,
);

const select = () => screen.findByRole('combobox', { name: 'Default model service' }) as Promise<HTMLSelectElement>;

beforeEach(() => {
  read.mockReset();
  read.mockImplementation(() => respond(directory));
  save.mockReset();
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
