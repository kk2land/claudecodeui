import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import ProviderSkills from '@/modules/skills/ProviderSkills';
import type { ProviderSkill } from '@/shared/types';

/**
 * The settings skills tab renders a per-skill switch only when the provider
 * reports a persisted enablement flag. These tests pin the switch state, the
 * disabled-while-saving behaviour and the failure message.
 */

const useProviderSkills = vi.fn();

vi.mock('@/modules/skills/hooks/useProviderSkills', () => ({
  useProviderSkills: (...args: unknown[]) => useProviderSkills(...args),
}));

const skill = (overrides: Partial<ProviderSkill> = {}): ProviderSkill => ({
  provider: 'codex',
  name: 'review',
  description: 'Review code',
  command: '$review',
  scope: 'user',
  sourcePath: '/Users/me/.codex/skills/review/SKILL.md',
  enabled: true,
  ...overrides,
});

const mockHook = (overrides: Record<string, unknown> = {}) => {
  useProviderSkills.mockReturnValue({
    skills: [skill()],
    isLoading: false,
    isLoadingProjectScopes: false,
    loadError: null,
    saveStatus: null,
    updatingSkillPaths: [],
    skillToggleError: null,
    addSkills: vi.fn(),
    refreshSkills: vi.fn(),
    setSkillEnabled: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
};

beforeEach(() => {
  useProviderSkills.mockReset();
});

describe('ProviderSkills enablement switch', () => {
  test('renders an on switch for a Codex skill and reports the toggled value', async () => {
    const setSkillEnabled = vi.fn().mockResolvedValue(undefined);
    mockHook({ setSkillEnabled });

    render(<ProviderSkills selectedProvider="codex" currentProjects={[]} />);
    const toggle = screen.getByRole('switch', { name: 'Enable or disable review' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Enabled')).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() => expect(setSkillEnabled).toHaveBeenCalledWith(
      '/Users/me/.codex/skills/review/SKILL.md',
      false,
    ));
  });

  test('shows a disabled switch for a disabled skill and locks it while saving', () => {
    mockHook({
      skills: [skill({ enabled: false })],
      updatingSkillPaths: ['codex:/Users/me/.codex/skills/review/SKILL.md'],
    });

    render(<ProviderSkills selectedProvider="codex" currentProjects={[]} />);
    const toggle = screen.getByRole('switch', { name: 'Enable or disable review' }) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText('Saving…')).toBeTruthy();
  });

  test('omits the switch for providers without persisted enablement', () => {
    mockHook({ skills: [skill({ provider: 'claude', command: '/review', enabled: undefined })] });

    render(<ProviderSkills selectedProvider="claude" currentProjects={[]} />);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  test('surfaces the toggle failure without changing the rendered state', () => {
    mockHook({
      skills: [skill({ enabled: true })],
      skillToggleError: 'Codex config is not valid TOML',
    });

    render(<ProviderSkills selectedProvider="codex" currentProjects={[]} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Codex config is not valid TOML');
    expect(screen.getByRole('switch', { name: 'Enable or disable review' }).getAttribute('aria-checked'))
      .toBe('true');
  });
});
