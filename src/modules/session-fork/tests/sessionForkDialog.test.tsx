import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { SessionForkDialog } from '@/modules/session-fork';
import { api } from '@/shared/api';
import type { SessionForkSource } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: {
  forkSession: vi.fn(),
  providers: { capabilities: vi.fn(), models: vi.fn(), authStatus: vi.fn() },
} }));

const source: SessionForkSource = { sessionId: 'source', provider: 'codex' };
const fork = { sessionId: 'target', provider: 'dsh', sessionName: 'Transferred session', projectPath: '/project' };
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response;

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
  vi.mocked(api.providers.capabilities).mockResolvedValue(response({ success: true, data: { providers: [
    { provider: 'codex', supportsSessionForking: true, supportsSessionTransfer: true },
    { provider: 'dsh', supportsSessionForking: false, supportsSessionTransfer: true },
    { provider: 'claude', supportsSessionForking: true, supportsSessionTransfer: true, hiddenFromModelPicker: true },
    { provider: 'cursor', supportsSessionTransfer: true },
  ] } }));
  vi.mocked(api.providers.models).mockImplementation(async (provider) => response({ success: true, data: { models: {
    DEFAULT: `${provider}-model`, OPTIONS: [{ value: `${provider}-model`, label: `${provider} Model`,
      effort: { default: 'medium', values: [{ value: 'medium' }, { value: 'high' }] } }],
  } } }));
  vi.mocked(api.providers.authStatus).mockImplementation(async (provider) => response({ success: true, data: { installed: provider !== 'cursor' } }));
  vi.mocked(api.forkSession).mockResolvedValue(response({ success: true, data: fork }));
});

async function open(overrides: Partial<SessionForkSource> = {}) {
  const onClose = vi.fn();
  const onForked = vi.fn();
  render(<SessionForkDialog source={{ ...source, ...overrides }} onClose={onClose} onForked={onForked} />);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  return { onClose, onForked };
}

test('cross-provider fork sends the selected model/effort and navigates using the server result', async () => {
  const callbacks = await open({ upToAnchorId: 'turn-1', upToMessageId: 'message-1' });
  fireEvent.change(screen.getByLabelText('Target provider'), { target: { value: 'dsh' } });
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('dsh-model');
  fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'high' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create fork' }));
  await waitFor(() => expect(callbacks.onForked).toHaveBeenCalledWith(fork));
  expect(api.forkSession).toHaveBeenCalledWith('source', {
    targetProvider: 'dsh', model: 'dsh-model', effort: 'high',
    upToAnchorId: 'turn-1', upToMessageId: 'message-1', contextMode: 'full',
  });
  expect(callbacks.onClose).toHaveBeenCalledTimes(1);
});

test('same-provider default retains the source model instead of replacing it with catalog defaults', async () => {
  await open();
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Create fork' }));
  await waitFor(() => expect(api.forkSession).toHaveBeenCalledWith('source', { targetProvider: 'codex', contextMode: 'full' }));
});

test('deployment-hidden targets stay hidden and unavailable providers cannot be selected', async () => {
  await open();
  const providerOptions = Array.from((screen.getByLabelText('Target provider') as HTMLSelectElement).options);
  expect(providerOptions.map((option) => option.value)).toEqual(['codex', 'dsh', 'cursor']);
  expect(providerOptions.find((option) => option.value === 'cursor')?.disabled).toBe(true);
  expect(api.providers.models).not.toHaveBeenCalledWith('claude');
});

test('a hidden source provider remains available for its existing native fork', async () => {
  await open({ provider: 'claude' });
  expect((screen.getByLabelText('Target provider') as HTMLSelectElement).value).toBe('claude');
  expect(screen.getByRole('option', { name: 'Claude' })).toBeTruthy();
});

test('a size error preserves the dialog and lets the user explicitly retry with compact context', async () => {
  vi.mocked(api.forkSession).mockResolvedValueOnce(response({ success: false, error: { message: 'Context is too large. Choose compact context.' } }, false));
  const callbacks = await open();
  fireEvent.change(screen.getByLabelText('Target provider'), { target: { value: 'dsh' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create fork' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Context is too large');
  expect(callbacks.onClose).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('History context'), { target: { value: 'compact' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create fork' }));
  await waitFor(() => expect(callbacks.onForked).toHaveBeenCalledWith(fork));
  expect(api.forkSession).toHaveBeenLastCalledWith('source', { targetProvider: 'dsh', model: 'dsh-model', contextMode: 'compact' });
});

test('pending creation blocks duplicate submissions and Escape dismissal', async () => {
  let finish!: (value: Response) => void;
  vi.mocked(api.forkSession).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const callbacks = await open();
  const create = screen.getByRole('button', { name: 'Create fork' });
  fireEvent.click(create);
  fireEvent.click(create);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(api.forkSession).toHaveBeenCalledTimes(1);
  expect(callbacks.onClose).not.toHaveBeenCalled();
  finish(response({ success: true, data: fork }));
  await waitFor(() => expect(callbacks.onForked).toHaveBeenCalledWith(fork));
});

test('cancel never creates a session', async () => {
  const callbacks = await open();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  expect(api.forkSession).not.toHaveBeenCalled();
});
