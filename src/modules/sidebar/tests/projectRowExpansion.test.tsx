import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';

/**
 * The desktop row click both selects a project and toggles its session list.
 * Selecting an expanded project made the controller's selection effect re-open
 * the list the click had just closed, so the first click appeared to do
 * nothing. These tests pin the row's contract: an expanded row only toggles,
 * a collapsed row selects and expands.
 */

vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({
  useCompactSidebar: () => false,
}));

vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

const t = ((key: string) => key) as unknown as React.ComponentProps<typeof SidebarProjectItem>['t'];
const noop = () => {};
const NO_IDS: ReadonlySet<string> = new Set<string>();

const PROJECT_A = {
  projectId: 'a',
  path: '/a',
  fullPath: '/a',
  displayName: 'project a',
  sessions: [],
  sessionMeta: { total: 0, hasMore: false },
} as unknown as Project;

const PROJECT_B = {
  projectId: 'b',
  path: '/b',
  fullPath: '/b',
  displayName: 'project b',
  sessions: [],
  sessionMeta: { total: 0, hasMore: false },
} as unknown as Project;

function renderRow({ isExpanded, isSelected }: { isExpanded: boolean; isSelected: boolean }) {
  const onProjectSelect = vi.fn();
  const onToggleProject = vi.fn();

  render(
    <SidebarProjectItem
      project={PROJECT_B}
      selectedProject={isSelected ? PROJECT_B : PROJECT_A}
      selectedSession={null}
      isExpanded={isExpanded}
      isDeleting={false}
      isStarred={false}
      isEditing={false}
      renameDraft=""
      sessions={[]}
      initialSessionsLoaded
      isLoadingMoreSessions={false}
      currentTime={new Date('2026-11-26T10:00:00.000Z')}
      sessionRenameId={null}
      sessionRenameDraft=""
      tasksEnabled={false}
      mcpServerStatus={null}
      onRenameDraftChange={noop}
      onToggleProject={onToggleProject}
      onProjectSelect={onProjectSelect}
      onToggleStarProject={noop}
      onStartEditingProject={noop}
      onCancelEditingProject={noop}
      onSaveProjectName={noop}
      onDeleteProject={noop}
      onSessionSelect={noop}
      onArchiveSession={noop}
      onDeleteSession={noop}
      onForkSession={noop}
      onLoadMoreSessions={noop}
      activeSessions={NO_IDS}
      backgroundSessionIds={NO_IDS}
      attentionSessionIds={NO_IDS}
      onNewSession={noop}
      onStartEditingSession={noop}
      onCancelEditingSession={noop}
      onSaveEditingSession={noop}
      selectedSessionIds={null}
      onSetSessionSelection={noop}
      onToggleSessionSelected={noop}
      onCancelSessionSelection={noop}
      onDeleteSelectedSessions={noop}
      t={t}
    />,
  );

  return { onProjectSelect, onToggleProject };
}

test('clicking an expanded project that is not selected only collapses it', () => {
  const { onProjectSelect, onToggleProject } = renderRow({ isExpanded: true, isSelected: false });

  fireEvent.click(screen.getByText('project b'));

  assert.equal(onProjectSelect.mock.calls.length, 0, 'the row must not steal the selection');
  assert.deepEqual(onToggleProject.mock.calls, [['b']], 'the row collapses');
});

test('clicking a collapsed project selects it and expands it', () => {
  const { onProjectSelect, onToggleProject } = renderRow({ isExpanded: false, isSelected: false });

  fireEvent.click(screen.getByText('project b'));

  assert.deepEqual(onProjectSelect.mock.calls, [[PROJECT_B]], 'the row selects the project');
  assert.deepEqual(onToggleProject.mock.calls, [['b']], 'the row expands it');
});

test('clicking the selected expanded project only collapses it', () => {
  const { onProjectSelect, onToggleProject } = renderRow({ isExpanded: true, isSelected: true });

  fireEvent.click(screen.getByText('project b'));

  assert.equal(onProjectSelect.mock.calls.length, 0, 'an already selected project is not reselected');
  assert.deepEqual(onToggleProject.mock.calls, [['b']]);
});
