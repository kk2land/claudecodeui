import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { AppTab, Plugin, Project, ProjectSession } from '@/shared/types';

/**
 * The workspace, not the sidebar, owns the browser tab title. Chat keeps the
 * session-based title, every other tab names the tab, and a plugin tab uses the
 * display name from its manifest — including while the plugin list is still
 * loading — so a page never advertises a chat session the user is not looking at.
 */

const pluginsState: { plugins: Plugin[] } = { plugins: [] };

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => pluginsState,
}));

const { useWorkspacePageTitle } = await import(
  '@/modules/project-workspace/hooks/useWorkspacePageTitle'
);

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'My Project',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
};

const session: ProjectSession = {
  id: 'session-1',
  summary: 'Fix browser tab title',
  __provider: 'claude',
  __projectId: 'project-1',
};

const schedulerPlugin: Plugin = {
  name: 'project-scheduler',
  displayName: '定时任务',
  version: '1.0.0',
  description: '',
  author: '',
  icon: 'icon.svg',
  type: 'react',
  slot: 'tab',
  entry: 'client.js',
  server: null,
  permissions: [],
  enabled: true,
  serverRunning: false,
  dirName: 'project-scheduler',
  repoUrl: null,
};

const renderTitle = (activeTab: AppTab, selectedProject: Project | null = project, selectedSession: ProjectSession | null = session) =>
  renderHook(
    ({ tab }: { tab: AppTab }) => useWorkspacePageTitle({
      activeTab: tab,
      selectedProject,
      selectedSession,
    }),
    { initialProps: { tab: activeTab } },
  );

beforeEach(() => {
  pluginsState.plugins = [];
  document.title = 'CloudCLI UI';
});

test('chat shows the open session title, exactly as getPageTitle resolves it', () => {
  renderTitle('chat');
  assert.equal(document.title, 'Fix browser tab title');
});

test('chat with no session falls back to the project name', () => {
  renderTitle('chat', project, null);
  assert.equal(document.title, 'My Project - CloudCLI UI');
});

test('with no project or session the app name is shown', () => {
  renderTitle('chat', null, null);
  assert.equal(document.title, 'CloudCLI UI');
});

test('a plugin tab shows the plugin display name and never the open session title', () => {
  pluginsState.plugins = [schedulerPlugin];
  renderTitle('plugin:project-scheduler');

  assert.equal(document.title, '定时任务 - CloudCLI UI');
  assert.ok(!document.title.includes(session.summary as string));
});

test('a plugin that has not loaded yet falls back to its name rather than showing undefined', () => {
  renderTitle('plugin:project-scheduler');

  assert.equal(document.title, 'project-scheduler - CloudCLI UI');
  assert.ok(!document.title.includes('undefined'));
});

test('a loaded plugin replaces the fallback title once the plugin list arrives', () => {
  const { rerender } = renderTitle('plugin:project-scheduler');
  assert.equal(document.title, 'project-scheduler - CloudCLI UI');

  pluginsState.plugins = [schedulerPlugin];
  rerender({ tab: 'plugin:project-scheduler' });

  assert.equal(document.title, '定时任务 - CloudCLI UI');
});

test('switching chat to a plugin tab and back restores the session title', () => {
  pluginsState.plugins = [schedulerPlugin];
  const { rerender } = renderTitle('chat');
  assert.equal(document.title, 'Fix browser tab title');

  act(() => rerender({ tab: 'plugin:project-scheduler' }));
  assert.equal(document.title, '定时任务 - CloudCLI UI');

  act(() => rerender({ tab: 'chat' }));
  assert.equal(document.title, 'Fix browser tab title');
});

test('built-in non-chat tabs use their existing translated page names, not the session title', () => {
  const { rerender } = renderTitle('chat');

  const expectedTitles: Array<[AppTab, string]> = [
    ['files', 'Project Files - CloudCLI UI'],
    ['shell', 'Shell - CloudCLI UI'],
    ['git', 'Source Control - CloudCLI UI'],
    ['tasks', 'Tasks - CloudCLI UI'],
    ['browser', 'Browser - CloudCLI UI'],
  ];

  for (const [tab, expectedTitle] of expectedTitles) {
    act(() => rerender({ tab }));
    assert.equal(document.title, expectedTitle, `unexpected title for the ${tab} tab`);
  }
});

test('a non-chat tab with no project still names the tab', () => {
  renderTitle('git', null, null);
  assert.equal(document.title, 'Source Control - CloudCLI UI');
});

test('unrelated plugin refreshes preserve the chat completion indicator', () => {
  const { rerender } = renderTitle('chat');
  document.title = '[Done] Fix browser tab title';

  pluginsState.plugins = [schedulerPlugin];
  rerender({ tab: 'chat' });
  assert.equal(document.title, '[Done] Fix browser tab title');

  rerender({ tab: 'plugin:project-scheduler' });
  assert.equal(document.title, '定时任务 - CloudCLI UI');
});
