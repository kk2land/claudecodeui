import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import type { AppTab, Plugin, Project, ProjectSession } from '@/shared/types';
import { getPageTitle } from '@/shared/utils';
import { usePlugins } from '@/modules/plugins';

type UseWorkspacePageTitleArgs = {
  /** The workspace tab the user is viewing; chat keeps the session-based title. */
  activeTab: AppTab;
  /** The selected project, or null before any project is loaded. */
  selectedProject: Project | null;
  /** The open session; only the chat tab is allowed to expose its title. */
  selectedSession: ProjectSession | null;
};

/** Prefix identifying a plugin tab in `AppTab`; mirrors how WorkspaceTabs builds plugin tab ids. */
const PLUGIN_TAB_PREFIX = 'plugin:';

/**
 * Resolves the page name shown for a non-chat tab. Built-in tabs reuse the
 * labels already translated for the tab bar; a plugin tab uses its manifest
 * display name and falls back to the raw plugin name until the plugin list has
 * loaded, so the title never reads "undefined".
 */
const getTabPageName = (
  activeTab: AppTab,
  t: ReturnType<typeof useTranslation>['t'],
  plugins: Plugin[],
): string => {
  if (activeTab.startsWith(PLUGIN_TAB_PREFIX)) {
    const pluginName = activeTab.slice(PLUGIN_TAB_PREFIX.length);
    return plugins.find((plugin) => plugin.name === pluginName)?.displayName?.trim() || pluginName;
  }

  switch (activeTab) {
    case 'files':
      return t('mainContent.projectFiles');
    case 'shell':
      return t('tabs.shell');
    case 'git':
      return t('tabs.git');
    case 'tasks':
      return t('tabs.tasks');
    case 'browser':
      return t('tabs.browser');
    default:
      return t('misc.projectFallback');
  }
};

/**
 * Keeps the browser tab title in step with the workspace page actually on
 * screen. Mounted once by ProjectMainRegion, which owns the document title so
 * no other component writes a competing session title. Chat keeps
 * `getPageTitle`'s existing semantics; every other tab names the tab itself, so
 * an open session's name never leaks into the title.
 *
 * Only the resolved string is a dependency, so the effect stays idle while the
 * same page title is shown. That leaves the completion marker the chat module
 * prefixes onto the title intact across unrelated session updates.
 */
export function useWorkspacePageTitle({
  activeTab,
  selectedProject,
  selectedSession,
}: UseWorkspacePageTitleArgs): void {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const pageTitle = activeTab === 'chat'
    ? getPageTitle(selectedProject, selectedSession)
    // The app name comes from the shared helper so there is a single source of
    // truth for the base title instead of a duplicated constant.
    : `${getTabPageName(activeTab, t, plugins)} - ${getPageTitle(null, null)}`;

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);
}
