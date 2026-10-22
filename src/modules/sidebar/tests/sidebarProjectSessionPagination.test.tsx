import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps, SidebarSessionSelection } from '@/shared/types';

/**
 * A project lists five sessions at a time. The reveal window pages over the
 * rows already loaded before it asks the server for another page, so one click
 * can never dump an entire fetch onto the screen, a failed fetch reveals
 * nothing, and the bulk selection only ever sees the rows on screen.
 *
 * The row itself is stubbed: these assertions are about which sessions the list
 * renders, not about what a row looks like.
 */

vi.mock('@/modules/sidebar/SidebarSessionItem', () => ({
  default: (props: { session: SessionWithProvider }) =>
    React.createElement('div', {
      'data-testid': 'session-row',
      'data-session-id': props.session.id,
    }),
}));

vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({
  useCompactSidebar: () => false,
}));

const { default: SidebarProjectSessions } = await import('@/modules/sidebar/SidebarProjectSessions');

// Keys come back with their interpolation options appended (`key:count=2`), so a
// label can be asserted together with the number it was given.
const t = ((key: string, options?: unknown) =>
  options && typeof options === 'object'
    ? `${key}:${Object.entries(options).map(([name, value]) => `${name}=${String(value)}`).join(',')}`
    : key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};
const NO_IDS: ReadonlySet<string> = new Set<string>();

const project = (projectId: string): Project =>
  ({
    projectId,
    name: projectId,
    displayName: projectId,
    fullPath: `/tmp/${projectId}`,
    sessions: [],
  }) as unknown as Project;

const makeSessions = (prefix: string, count: number): SessionWithProvider[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index + 1}`,
    summary: `${prefix}${index + 1}`,
    lastActivity: '2026-08-21T09:59:00.000Z',
    __provider: 'claude',
  })) as unknown as SessionWithProvider[];

type Overrides = {
  sessions?: SessionWithProvider[];
  projectId?: string;
  isExpanded?: boolean;
  hasMoreSessions?: boolean;
  isLoadingMoreSessions?: boolean;
  selectedSessionIds?: ReadonlySet<string> | null;
  activeSessions?: ReadonlySet<string>;
  onLoadMoreSessions?: (projectId: string) => void;
  onSetSessionSelection?: (selection: SidebarSessionSelection) => void;
  onDeleteSelectedSessions?: (sessionIds: string[]) => void;
};

const renderSessions = (initialOverrides: Overrides = {}) => {
  let overrides = initialOverrides;
  const props = {
    project: project(overrides.projectId ?? 'project-1'),
    isExpanded: overrides.isExpanded ?? true,
    sessions: overrides.sessions ?? makeSessions('s', 12),
    selectedSession: null,
    initialSessionsLoaded: true,
    hasMoreSessions: overrides.hasMoreSessions ?? false,
    isLoadingMoreSessions: overrides.isLoadingMoreSessions ?? false,
    activeSessions: overrides.activeSessions ?? NO_IDS,
    backgroundSessionIds: NO_IDS,
    attentionSessionIds: NO_IDS,
    currentTime: new Date('2026-08-21T10:00:00.000Z'),
    sessionRenameId: null,
    sessionRenameDraft: '',
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    onDeleteSession: noop,
    onLoadMoreSessions: overrides.onLoadMoreSessions ?? noop,
    onNewSession: noop,
    selectedSessionIds: overrides.selectedSessionIds ?? null,
    onSetSessionSelection: overrides.onSetSessionSelection ?? noop,
    onToggleSessionSelected: noop,
    onCancelSessionSelection: noop,
    onDeleteSelectedSessions: overrides.onDeleteSelectedSessions ?? noop,
    t,
  };
  const view = render(React.createElement(SidebarProjectSessions, props));
  return {
    ...view,
    // Accumulates overrides: a later call keeps whatever the previous ones set,
    // so a test can step through several renders without restating every prop.
    rerender: (next: Overrides) => {
      overrides = { ...overrides, ...next };
      view.rerender(
        React.createElement(SidebarProjectSessions, {
          ...props,
          project: project(overrides.projectId ?? 'project-1'),
          isExpanded: overrides.isExpanded ?? true,
          sessions: overrides.sessions ?? props.sessions,
          hasMoreSessions: overrides.hasMoreSessions ?? false,
          isLoadingMoreSessions: overrides.isLoadingMoreSessions ?? false,
          selectedSessionIds: overrides.selectedSessionIds ?? null,
          activeSessions: overrides.activeSessions ?? NO_IDS,
        }),
      );
    },
  };
};

const visibleSessionIds = (): string[] =>
  screen.queryAllByTestId('session-row').map((row) => row.getAttribute('data-session-id') ?? '');

const showMoreButton = (): HTMLButtonElement | null =>
  [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'sessions.showMore',
  ) ?? null;

test('a project opens with five rows and a Show more button, without fetching', () => {
  const onLoadMoreSessions = vi.fn();
  renderSessions({ onLoadMoreSessions });

  assert.deepEqual(visibleSessionIds(), ['s1', 's2', 's3', 's4', 's5']);
  assert.ok(showMoreButton(), 'the hidden local rows stay reachable');
  assert.equal(onLoadMoreSessions.mock.calls.length, 0, 'rendering must not fetch');
});

test('each click reveals the next five loaded rows, then the button goes away', () => {
  const onLoadMoreSessions = vi.fn();
  const { rerender } = renderSessions({ sessions: makeSessions('s', 12), onLoadMoreSessions });

  fireEvent.click(showMoreButton() as HTMLButtonElement);
  assert.deepEqual(visibleSessionIds(), makeSessions('s', 10).map((session) => session.id));

  rerender({});
  fireEvent.click(showMoreButton() as HTMLButtonElement);
  assert.deepEqual(visibleSessionIds(), makeSessions('s', 12).map((session) => session.id));

  rerender({});
  assert.equal(
    showMoreButton(),
    null,
    'with every loaded row on screen and no server page left there is nothing to show',
  );
  assert.equal(onLoadMoreSessions.mock.calls.length, 0, 'local rows are revealed before the server is asked');
});

test('the server is only asked once every loaded row is visible, and adds one page at a time', () => {
  const onLoadMoreSessions = vi.fn();
  const twelve = makeSessions('s', 12);
  const { rerender } = renderSessions({ sessions: twelve, hasMoreSessions: true, onLoadMoreSessions });

  fireEvent.click(showMoreButton() as HTMLButtonElement);
  rerender({});
  fireEvent.click(showMoreButton() as HTMLButtonElement);
  rerender({});
  assert.deepEqual(visibleSessionIds(), twelve.map((session) => session.id));
  assert.equal(onLoadMoreSessions.mock.calls.length, 0, 'two of the three clicks only reveal local rows');

  fireEvent.click(showMoreButton() as HTMLButtonElement);
  assert.deepEqual(onLoadMoreSessions.mock.calls, [['project-1']], 'the last click continues on the server');

  // The fetch returns a full server page (20 rows). Only the next five appear.
  const twentyFive = makeSessions('s', 25);
  rerender({ sessions: twentyFive });
  assert.deepEqual(visibleSessionIds(), makeSessions('s', 17).map((session) => session.id));

  rerender({});
  fireEvent.click(showMoreButton() as HTMLButtonElement);
  assert.deepEqual(visibleSessionIds(), makeSessions('s', 22).map((session) => session.id));
});

test('a failed server page reveals nothing and can be retried', () => {
  const onLoadMoreSessions = vi.fn();
  const five = makeSessions('s', 5);
  const { rerender } = renderSessions({ sessions: five, hasMoreSessions: true, onLoadMoreSessions });

  assert.deepEqual(visibleSessionIds(), five.map((session) => session.id));
  fireEvent.click(showMoreButton() as HTMLButtonElement);
  assert.deepEqual(onLoadMoreSessions.mock.calls, [['project-1']]);

  // The request is in flight, then the controller reports it failed and the
  // loaded list has not grown. The button must still offer exactly one page.
  rerender({ isLoadingMoreSessions: true });
  rerender({ isLoadingMoreSessions: false });
  assert.deepEqual(visibleSessionIds(), five.map((session) => session.id), 'a failure reveals nothing');
  assert.ok(showMoreButton(), 'the failed page can be retried');

  fireEvent.click(showMoreButton() as HTMLButtonElement);
  assert.equal(onLoadMoreSessions.mock.calls.length, 2, 'the retry reaches the server again');
});

test('collapsing and reopening a project resets it to five rows', () => {
  const { rerender } = renderSessions({ sessions: makeSessions('s', 12) });

  fireEvent.click(showMoreButton() as HTMLButtonElement);
  rerender({});
  assert.equal(visibleSessionIds().length, 10);

  rerender({ isExpanded: false });
  assert.equal(visibleSessionIds().length, 0, 'a collapsed project renders no rows');

  rerender({ isExpanded: true });
  assert.deepEqual(visibleSessionIds(), ['s1', 's2', 's3', 's4', 's5']);
});

test('two projects page independently', () => {
  const sessionRows = (prefix: string) =>
    screen
      .getAllByTestId('session-row')
      .filter((row) => row.getAttribute('data-session-id')?.startsWith(prefix))
      .map((row) => row.getAttribute('data-session-id') ?? '');

  const propsFor = (projectId: string) => ({
    project: project(projectId),
    isExpanded: true,
    sessions: makeSessions(`${projectId}-s`, 12),
    selectedSession: null,
    initialSessionsLoaded: true,
    hasMoreSessions: false,
    isLoadingMoreSessions: false,
    activeSessions: NO_IDS,
    backgroundSessionIds: NO_IDS,
    attentionSessionIds: NO_IDS,
    currentTime: new Date('2026-08-21T10:00:00.000Z'),
    sessionRenameId: null,
    sessionRenameDraft: '',
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    onDeleteSession: noop,
    onLoadMoreSessions: noop,
    onNewSession: noop,
    selectedSessionIds: null,
    onSetSessionSelection: noop,
    onToggleSessionSelected: noop,
    onCancelSessionSelection: noop,
    onDeleteSelectedSessions: noop,
    t,
  });

  render(
    React.createElement(
      'div',
      null,
      React.createElement(SidebarProjectSessions, propsFor('a')),
      React.createElement(SidebarProjectSessions, propsFor('b')),
    ),
  );

  assert.equal(sessionRows('a-').length, 5);
  assert.equal(sessionRows('b-').length, 5);

  fireEvent.click(showMoreButton() as HTMLButtonElement);
  assert.equal(sessionRows('a-').length, 10, 'the clicked project reveals another page');
  assert.equal(sessionRows('b-').length, 5, 'the other project is untouched');
});

test('bulk selection only ever reaches the visible deletable rows', () => {
  const onSetSessionSelection = vi.fn();
  renderSessions({
    sessions: makeSessions('s', 12),
    hasMoreSessions: true,
    selectedSessionIds: NO_IDS,
    activeSessions: new Set(['s4']),
    onSetSessionSelection,
  });

  // Twelve loaded, five on screen, one of those running, and more on the server.
  assert.ok(buttonWithText('sessions.selectAllLoaded'), 'hidden or unloaded rows keep the loaded-only wording');
  assert.equal(buttonWithText('sessions.selectAll'), null);

  fireEvent.click(buttonWithText('sessions.selectAllLoaded') as HTMLButtonElement);
  assert.deepEqual(
    [...(onSetSessionSelection.mock.calls[0][0] as SidebarSessionSelection).sessionIds],
    ['s1', 's2', 's3', 's5'],
    'only the visible, deletable rows are selected',
  );
});

test('a selection carrying ids the pager hides is pruned before deletion', () => {
  const onDeleteSelectedSessions = vi.fn();
  const { container } = renderSessions({
    sessions: makeSessions('s', 12),
    selectedSessionIds: new Set(['s1', 's6', 's7']),
    onDeleteSelectedSessions,
  });

  const deleteButton = buttonWithText('sessions.deleteSelected:count=1', container);
  assert.ok(deleteButton, 'the hidden ids are not counted');
  fireEvent.click(deleteButton);
  assert.deepEqual(onDeleteSelectedSessions.mock.calls[0][0], ['s1']);
});

test('Select all returns once every loaded row is visible and the server has no more', () => {
  renderSessions({ sessions: makeSessions('s', 5), hasMoreSessions: false, selectedSessionIds: NO_IDS });

  assert.ok(buttonWithText('sessions.selectAll'), 'nothing hidden means Select all');
  assert.equal(buttonWithText('sessions.selectAllLoaded'), null);
});

function buttonWithText(text: string, container: HTMLElement = document.body): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === text) ?? null
  );
}
