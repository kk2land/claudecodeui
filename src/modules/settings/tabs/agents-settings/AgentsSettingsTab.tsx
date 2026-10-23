import { useEffect, useMemo, useState } from 'react';

import type { AgentCategory, AgentContextByProvider, AgentProvider, AgentSettingsProject, ClaudePermissionsState, CodexPermissionMode, CursorPermissionsState, ProviderAuthStatus, ProviderCapabilityRow } from '@/shared/types';
import { useProviderCapabilities } from '@/shared/hooks/useProviderCapabilities';
import AgentCategoryContentSection from '@/modules/settings/tabs/agents-settings/sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from '@/modules/settings/tabs/agents-settings/sections/AgentCategoryTabsSection';
import AgentSelectorSection from '@/modules/settings/tabs/agents-settings/sections/AgentSelectorSection';

type ProviderAuthStatusByProvider = Record<AgentProvider, ProviderAuthStatus>;

type AgentsSettingsTabProps = {
  providerAuthStatus: ProviderAuthStatusByProvider;
  onProviderLogin: (provider: AgentProvider) => void;
  claudePermissions: ClaudePermissionsState;
  onClaudePermissionsChange: (value: ClaudePermissionsState) => void;
  cursorPermissions: CursorPermissionsState;
  onCursorPermissionsChange: (value: CursorPermissionsState) => void;
  codexPermissionMode: CodexPermissionMode;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  projects: AgentSettingsProject[];
};

/** Every agent provider this tab can render, before deployment visibility narrows the list. */
const AGENT_PROVIDERS: AgentProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'dsh'];

/**
 * The capability row as this tab reads it. The shared row type only models the
 * fields chat consumes, while the capabilities endpoint also reports the
 * deployment's `hiddenFromModelPicker` flag; reading it here keeps the shared
 * type and backend capability service untouched.
 */
type ProviderVisibilityRow = ProviderCapabilityRow & { hiddenFromModelPicker?: boolean };

/** Rendered by Settings for the "agents" tab, hosting per-provider account, permission, MCP and skill settings. */
export default function AgentsSettingsTab({
  providerAuthStatus,
  onProviderLogin,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  projects,
}: AgentsSettingsTabProps) {
  // Which agent tab the user last chose; it may name a provider the deployment
  // hides, so every render goes through effectiveSelectedAgent instead.
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>('claude');
  // Which category panel the user last chose within the current agent; corrected
  // here whenever the effective agent's category list no longer contains it.
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');
  // Deployment visibility comes from the server capability matrix; a provider
  // with no row, or one hidden from pickers, gets no tab. Authentication is a
  // separate concern and never decides whether a provider is offered.
  const capabilities = useProviderCapabilities();
  // The hook's declared row type omits the visibility flag that the endpoint
  // sends, so the rows are read through the local widened shape.
  const visibleAgents = useMemo<AgentProvider[]>(() => {
    const rows = capabilities as Partial<Record<AgentProvider, ProviderVisibilityRow>>;
    return AGENT_PROVIDERS.filter((provider) => (
      rows[provider] !== undefined && rows[provider]?.hiddenFromModelPicker !== true
    ));
  }, [capabilities]);

  // The capability matrix loads asynchronously, so a kept selection can name a
  // provider that is not currently visible; fall back to the first visible one
  // while leaving the user's own choice intact for when it becomes visible again.
  const effectiveSelectedAgent = visibleAgents.includes(selectedAgent)
    ? selectedAgent
    : visibleAgents[0];

  const visibleCategories = useMemo<AgentCategory[]>(() => {
    if (!effectiveSelectedAgent) return [];
    return effectiveSelectedAgent === 'dsh' ? ['account', 'mcp', 'skills'] : effectiveSelectedAgent === 'opencode'
      ? ['account', 'permissions', 'mcp']
      : ['account', 'permissions', 'mcp', 'skills'];
  }, [effectiveSelectedAgent]);

  const agentContextById = useMemo<AgentContextByProvider>(() => ({
    claude: {
      authStatus: providerAuthStatus.claude,
      onLogin: () => onProviderLogin('claude'),
    },
    cursor: {
      authStatus: providerAuthStatus.cursor,
      onLogin: () => onProviderLogin('cursor'),
    },
    codex: {
      authStatus: providerAuthStatus.codex,
      onLogin: () => onProviderLogin('codex'),
    },
    dsh: { authStatus: providerAuthStatus.dsh, onLogin: () => onProviderLogin('dsh') },
    opencode: {
      authStatus: providerAuthStatus.opencode,
      onLogin: () => onProviderLogin('opencode'),
    },
  }), [
    onProviderLogin,
    providerAuthStatus.claude,
    providerAuthStatus.codex,
    providerAuthStatus.cursor,
    providerAuthStatus.opencode,
    providerAuthStatus.dsh,
  ]);

  useEffect(() => {
    if (!visibleCategories.includes(selectedCategory)) {
      setSelectedCategory(visibleCategories[0] ?? 'account');
    }
  }, [selectedCategory, visibleCategories]);

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      {effectiveSelectedAgent && (
        <>
          <AgentSelectorSection
            agents={visibleAgents}
            selectedAgent={effectiveSelectedAgent}
            onSelectAgent={setSelectedAgent}
            agentContextById={agentContextById}
          />

          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <AgentCategoryTabsSection
              categories={visibleCategories}
              selectedAgent={effectiveSelectedAgent}
              selectedCategory={selectedCategory}
              onSelectCategory={setSelectedCategory}
            />

            <AgentCategoryContentSection
              selectedAgent={effectiveSelectedAgent}
              selectedCategory={selectedCategory}
              agentContextById={agentContextById}
              claudePermissions={claudePermissions}
              onClaudePermissionsChange={onClaudePermissionsChange}
              cursorPermissions={cursorPermissions}
              onCursorPermissionsChange={onCursorPermissionsChange}
              codexPermissionMode={codexPermissionMode}
              onCodexPermissionModeChange={onCodexPermissionModeChange}
              projects={projects}
            />
          </div>
        </>
      )}
    </div>
  );
}
