import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';
import type { AgentProvider, ClaudePermissionsState, CursorPermissionsState, ProviderAuthStatus } from '@/shared/types';

/**
 * The agents settings tab offers a provider tab only when the server's
 * capability matrix advertises that provider and the deployment does not hide
 * it. Authentication is deliberately irrelevant: a signed-out provider stays
 * tabbable, and a hidden one offers no account panel at all.
 */

const capabilitiesState = vi.hoisted(() => ({
  rows: {} as Partial<Record<AgentProvider, { provider: AgentProvider; hiddenFromModelPicker?: boolean }>>,
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilities: () => capabilitiesState.rows,
}));

// The content sections pull in MCP, skills and permission panels that are not
// under test here; the assertions target the selector and category tabs.
vi.mock('@/modules/settings/tabs/agents-settings/sections/AgentCategoryContentSection', () => ({
  default: ({ selectedAgent, selectedCategory }: { selectedAgent: AgentProvider; selectedCategory: string }) => (
    <div data-testid="agent-content">{`${selectedAgent}:${selectedCategory}`}</div>
  ),
}));

const row = (provider: AgentProvider, hiddenFromModelPicker = false) => ({
  provider,
  hiddenFromModelPicker,
});

const authStatus = (authenticated: boolean): ProviderAuthStatus => ({
  authenticated,
  email: authenticated ? 'someone@example.com' : null,
  method: authenticated ? 'credentials_file' : null,
  error: null,
  loading: false,
});

const claudePermissions: ClaudePermissionsState = { allowedTools: [], disallowedTools: [], skipPermissions: false };
const cursorPermissions: CursorPermissionsState = { allowedCommands: [], disallowedCommands: [], skipPermissions: false };

/** The tab's props, rebuilt per render so a rerender can reuse them unchanged. */
const tabProps = () => ({
  providerAuthStatus: {
    claude: authStatus(true),
    cursor: authStatus(false),
    codex: authStatus(false),
    opencode: authStatus(false),
    dsh: authStatus(false),
  },
  onProviderLogin: () => {},
  claudePermissions,
  onClaudePermissionsChange: () => {},
  cursorPermissions,
  onCursorPermissionsChange: () => {},
  codexPermissionMode: 'default' as const,
  onCodexPermissionModeChange: () => {},
  projects: [],
});

const renderTab = () => render(<AgentsSettingsTab {...tabProps()} />);

/** The provider pills, read from the tablist buttons by their visible label. */
const agentPills = () => screen.queryAllByRole('button')
  .filter((button) => ['Claude', 'Cursor', 'Codex', 'OpenCode', 'DeepSeek Harness']
    .some((name) => button.textContent?.includes(name)));

const categoryTabs = () => screen.queryAllByRole('tab').map((tab) => tab.textContent);

const content = () => screen.queryByTestId('agent-content')?.textContent ?? null;

beforeEach(() => {
  capabilitiesState.rows = {
    claude: row('claude'),
    cursor: row('cursor'),
    codex: row('codex'),
    opencode: row('opencode'),
    dsh: row('dsh'),
  };
});

describe('AgentsSettingsTab provider visibility', () => {
  it('shows every visible provider and omits ones hidden by the deployment', () => {
    capabilitiesState.rows = {
      claude: row('claude'),
      cursor: row('cursor', true),
      codex: row('codex'),
      opencode: row('opencode', true),
      dsh: row('dsh'),
    };

    renderTab();

    const labels = agentPills().map((pill) => pill.textContent);
    expect(labels).toHaveLength(3);
    expect(labels.some((label) => label?.includes('Claude'))).toBe(true);
    expect(labels.some((label) => label?.includes('Codex'))).toBe(true);
    expect(labels.some((label) => label?.includes('DeepSeek Harness'))).toBe(true);
    expect(screen.queryByText('Cursor')).toBeNull();
    expect(screen.queryByText('OpenCode')).toBeNull();
  });

  it('omits providers the capability matrix does not advertise', () => {
    capabilitiesState.rows = { claude: row('claude'), codex: row('codex') };

    renderTab();

    expect(agentPills().map((pill) => pill.textContent)).toHaveLength(2);
    expect(screen.queryByText('Cursor')).toBeNull();
    expect(screen.queryByText('OpenCode')).toBeNull();
    expect(screen.queryByText('DeepSeek Harness')).toBeNull();
  });

  it('falls back to the first visible provider when the default is hidden', () => {
    capabilitiesState.rows = {
      cursor: row('cursor'),
      codex: row('codex'),
    };

    renderTab();

    // Claude, the initial selection, is not offered, so the tab renders Cursor.
    expect(content()).toBe('cursor:account');
    expect(categoryTabs()).toEqual(['Account', 'Permissions', 'MCP Servers', 'Skills']);
  });

  it('renders no selector, categories or content when no provider is visible', () => {
    capabilitiesState.rows = {};

    const { container } = renderTab();

    expect(agentPills()).toHaveLength(0);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByTestId('agent-content')).toBeNull();
    // The empty state needs no copy of its own; the tab simply renders nothing.
    expect(container.textContent).toBe('');
  });

  it('replaces the content when the selected provider becomes hidden on rerender', () => {
    const { rerender } = renderTab();
    expect(content()).toBe('claude:account');

    act(() => {
      capabilitiesState.rows = {
        claude: row('claude', true),
        cursor: row('cursor'),
        codex: row('codex'),
        opencode: row('opencode'),
        dsh: row('dsh'),
      };
    });
    rerender(<AgentsSettingsTab {...tabProps()} />);

    // Claude is gone from the pills and its panel is replaced by the fallback.
    expect(screen.queryByText('Claude')).toBeNull();
    expect(content()).not.toBe('claude:account');
    expect(content()).toBe('cursor:account');
  });

  it('switches the content and categories when another visible provider is selected', () => {
    renderTab();

    const dshPill = agentPills().find((pill) => pill.textContent?.includes('DeepSeek Harness'));
    expect(dshPill).toBeTruthy();
    act(() => { dshPill?.click(); });

    expect(content()).toBe('dsh:account');
    // DSH has no permissions category, so the list narrows with the selection.
    expect(categoryTabs()).toEqual(['Account', 'MCP Servers', 'Skills']);
  });

  it('moves the category to the first one the newly selected provider supports', () => {
    renderTab();

    const permissionsTab = screen.getAllByRole('tab').find((tab) => tab.textContent === 'Permissions');
    act(() => { permissionsTab?.click(); });
    expect(content()).toBe('claude:permissions');

    const dshPill = agentPills().find((pill) => pill.textContent?.includes('DeepSeek Harness'));
    act(() => { dshPill?.click(); });

    // DSH has no permissions panel, so the correction lands on its first category.
    expect(content()).toBe('dsh:account');
    expect(screen.getByRole('tab', { name: 'Account' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps a signed-out provider tabbable', () => {
    capabilitiesState.rows = { claude: row('claude'), cursor: row('cursor', true) };

    const props = tabProps();
    props.providerAuthStatus.claude = authStatus(false);
    props.providerAuthStatus.cursor = authStatus(true);
    render(<AgentsSettingsTab {...props} />);

    // Cursor stays hidden despite being signed in; signed-out Claude stays visible.
    const labels = agentPills().map((pill) => pill.textContent);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain('Claude');
    expect(content()).toBe('claude:account');
  });
});
