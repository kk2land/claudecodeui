import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { ProviderRuntimePanel } from '@/modules/chat/composer/ProviderRuntimePanel';
import type { ProviderRuntimeControls, ProviderRuntimeState } from '@/shared/types';

function controls(patch: Partial<ProviderRuntimeState> = {}): ProviderRuntimeControls {
  return {
    sessionId: 'dsh-session', available: true, modes: ['acp', 'headless'], stoppableModes: ['acp'],
    pending: false, error: null, control: vi.fn().mockResolvedValue(undefined), prepareSend: vi.fn().mockResolvedValue('dsh-session'),
    state: {
      runtime: 'acp', phase: 'idle', queueHeld: false, supportsPermissionRequests: true,
      diagnostics: { running: true, pid: 321, startedAt: 1792485922000, launcherPath: '/opt/dsh', cliVersion: '0.2.1' },
      ...patch,
    },
  };
}

test('shows DSH transport selection, actual process details and a stop action', () => {
  const value = controls();
  render(<ProviderRuntimePanel hasQueuedDraft controls={value} providerLabel="DeepSeek Harness" />);
  expect(screen.queryByRole('combobox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'DeepSeek Harness' }));
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['ACP', 'headless']);
  expect(screen.getByText('PID 321')).toBeTruthy();
  expect(screen.getByText('/opt/dsh')).toBeTruthy();
  expect(screen.getByText('v0.2.1')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'headless' } });
  expect(value.control).toHaveBeenCalledWith({ action: 'runtime', runtime: 'headless' });
  fireEvent.click(screen.getByRole('button', { name: 'Stop ACP' }));
  expect(value.control).toHaveBeenCalledWith({ action: 'stop' });
  expect(screen.queryByRole('button', { name: /plan|steer/i })).toBeNull();
});

test('headless has no ACP stop button and explains its approval limit', () => {
  render(<ProviderRuntimePanel hasQueuedDraft controls={controls({ runtime: 'headless', supportsPermissionRequests: false })} providerLabel="DeepSeek Harness" />);
  fireEvent.click(screen.getByRole('button', { name: 'DeepSeek Harness' }));
  expect(screen.queryByRole('button', { name: 'Stop ACP' })).toBeNull();
  expect(screen.getByText(/no interactive approval channel/)).toBeTruthy();
});

test('active turns prevent switching but allow stopping, while transitions lock conflicting actions', () => {
  const value = controls({ phase: 'running' });
  const view = render(<ProviderRuntimePanel hasQueuedDraft controls={value} providerLabel="DeepSeek Harness" />);
  fireEvent.click(screen.getByRole('button', { name: 'DeepSeek Harness' }));
  expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Stop ACP' }) as HTMLButtonElement).disabled).toBe(false);
  view.rerender(<ProviderRuntimePanel hasQueuedDraft controls={controls({ phase: 'stopping', queueHeld: true })} providerLabel="DeepSeek Harness" />);
  expect((screen.getByRole('button', { name: 'Stop ACP' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Resume queue' }) as HTMLButtonElement).disabled).toBe(true);
});

test('paused queues can resume independently of process startup and errors stay visible', () => {
  const value = controls({ queueHeld: true });
  value.error = 'Stop could not be confirmed.';
  render(<ProviderRuntimePanel hasQueuedDraft controls={value} providerLabel="DeepSeek Harness" />);
  fireEvent.click(screen.getByRole('button', { name: 'Resume queue' }));
  expect(value.control).toHaveBeenCalledWith({ action: 'queue-resume' });
  expect(screen.getByRole('alert').textContent).toBe('Stop could not be confirmed.');
});

for (const mobile of [false, true]) {
  test(`empty paused queues hide resume and queued messages restore it (${mobile ? 'mobile' : 'desktop'})`, () => {
    const value = controls({ queueHeld: true });
    const settingsContainer = mobile ? null : undefined;
    const view = render(<ProviderRuntimePanel controls={value} providerLabel="DeepSeek Harness" settingsContainer={settingsContainer} />);
    expect(screen.queryByRole('button', { name: 'Resume queue' })).toBeNull();
    if (mobile) expect(view.container.textContent).toBe('');
    view.rerender(<ProviderRuntimePanel controls={value} providerLabel="DeepSeek Harness" settingsContainer={settingsContainer} hasQueuedDraft />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume queue' }));
    expect(value.control).toHaveBeenCalledWith({ action: 'queue-resume' });
    view.rerender(<ProviderRuntimePanel controls={value} providerLabel="DeepSeek Harness" settingsContainer={settingsContainer} hasQueuedDraft={false} />);
    expect(screen.queryByRole('button', { name: 'Resume queue' })).toBeNull();
    expect(value.state?.queueHeld).toBe(true);
  });
}
