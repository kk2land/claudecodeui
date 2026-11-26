import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';
import { useSessionPins } from '@/modules/sidebar/hooks/useSessionPins';
import { buildProjectSessionTree } from '@/modules/sidebar/utils/projectSessionTree';

const FORK_INDENT_PX = 12;
const MAX_FORK_INDENT_DEPTH = 4;

/** How many of a project's loaded sessions one page of the sidebar list shows. */
const PROJECT_SESSIONS_PAGE_SIZE = 5;

/** Where the list stood when the user asked the server for more sessions. */
type PendingServerReveal = {
  /** Loaded sessions at request time, used to tell whether the response added rows. */
  loaded: number;
  /** Rows actually on screen at request time; the next reveal starts here. */
  visible: number;
};

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  includeOffPagePins?: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  /** The sessions ticked here, or null when this project's list is not in selection mode. */
  selectedSessionIds: ReadonlySet<string> | null;
  onSetSessionSelection: (selection: SidebarSessionSelection) => void;
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  onCancelSessionSelection: () => void;
  onDeleteSelectedSessions: (sessionIds: string[]) => void;
  t: TFunction;
};

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

/** Rendered by SidebarProjectItem to show an expanded project's sessions, delegating each row to SidebarSessionItem. */
export default function SidebarProjectSessions({
  project,
  isExpanded,
  includeOffPagePins = true,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onArchiveSession,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  onNewSession,
  selectedSessionIds,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  t,
}: SidebarProjectSessionsProps) {
  const isCompact = useCompactSidebar();
  // How many of the loaded sessions this project reveals. It pages over what is
  // already loaded before it reaches the server, so a project never expands to
  // everything the server holds in one click.
  const [visibleSessionCount, setVisibleSessionCount] = useState(PROJECT_SESSIONS_PAGE_SIZE);
  // Where the list stood when the user asked the server for more, or null when
  // no request is outstanding. A response reveals exactly one page from there,
  // so a slow reply cannot dump a whole server page (20 rows) onto the screen;
  // a failed request adds nothing and reveals nothing.
  const pendingServerRevealRef = useRef<PendingServerReveal | null>(null);

  // Collapsing must forget the revealed pages so reopening starts at five rows
  // again.
  useEffect(() => {
    setVisibleSessionCount(PROJECT_SESSIONS_PAGE_SIZE);
    pendingServerRevealRef.current = null;
  }, [isExpanded, project.projectId]);

  // Both conditions live in one effect so the check for new rows always wins:
  // a settled request that did add rows reveals one page, and one that added
  // nothing (failure, or nothing left on the server) just clears the marker.
  useEffect(() => {
    const pendingReveal = pendingServerRevealRef.current;
    if (pendingReveal === null) {
      return;
    }

    if (sessions.length > pendingReveal.loaded) {
      // The request added rows: reveal one page from the last row that was on
      // screen, never the whole server page it returned.
      pendingServerRevealRef.current = null;
      setVisibleSessionCount(pendingReveal.visible + PROJECT_SESSIONS_PAGE_SIZE);
      return;
    }

    if (!isLoadingMoreSessions) {
      pendingServerRevealRef.current = null;
    }
  }, [isLoadingMoreSessions, sessions.length]);
  // The rows this project currently shows: the branch pages over what is
  // already loaded before it asks the server for more.
  const visibleSessions = useMemo(
    () => sessions.slice(0, visibleSessionCount),
    [sessions, visibleSessionCount],
  );
  const pins = useSessionPins();
  const projectPins = useMemo(
    () => pins?.sessions.filter((pin) => pin.projectId === project.projectId) ?? [],
    [pins?.sessions, project.projectId],
  );
  const pinnedSessionIds = useMemo(
    () => projectPins.map((pin) => pin.sessionId),
    [projectPins],
  );
  // A pin never spends one of the page's five slots: the window skips pinned
  // rows, and the tree then gets those pinned rows back from `sessions` in
  // their original order so a loaded pin keeps its real metadata.
  const normalSessions = useMemo(() => {
    // Filtered/Running lists keep the plain window, pins are not excluded there.
    if (!includeOffPagePins) return sessions;
    const pinned = new Set(pinnedSessionIds);
    return sessions.filter((session) => !pinned.has(session.id));
  }, [sessions, pinnedSessionIds, includeOffPagePins]);
  const treeRows = useMemo(() => {
    // Filtered/Running lists keep the plain window and borrow no pins.
    if (!includeOffPagePins) {
      return buildProjectSessionTree(visibleSessions, project.projectId);
    }

    const loadedIds = new Set(sessions.map((session) => session.id));
    const ancestors = new Map(sessions.flatMap((session) => session.forkAncestors ?? []).map((ancestor) => [ancestor.id, ancestor]));
    // A pin the server never returned has no page row and no ancestor snapshot
    // to borrow, so it keeps the smaller pin summary.
    const offPagePins: SessionWithProvider[] = projectPins.filter((pin) => !loadedIds.has(pin.sessionId)).map((pin) => ({
      forkedFromSessionId: pin.forkedFromSessionId,
      forkAncestors: pin.forkAncestors,
      ...ancestors.get(pin.sessionId),
      id: pin.sessionId, summary: pin.sessionTitle, __provider: pin.provider,
      __projectId: project.projectId, lastActivity: pin.lastActivity ?? undefined,
    }));
    const ordinaryIds = new Set(normalSessions.slice(0, visibleSessionCount).map((session) => session.id));
    const pageIds = new Set([...pinnedSessionIds, ...ordinaryIds]);
    return buildProjectSessionTree(
      [...sessions.filter((session) => pageIds.has(session.id)), ...offPagePins],
      project.projectId,
      pinnedSessionIds,
    );
  }, [includeOffPagePins, visibleSessions, sessions, normalSessions, project.projectId, projectPins, pinnedSessionIds]);
  const selectedSessionId = selectedSession?.id ?? null;
  const targetAncestors = useMemo(() => {
    const parents = new Map(treeRows.map((row) => [row.session.id, row.parentId]));
    const reveal = new Set<string>();
    for (const target of [selectedSessionId, sessionRenameId]) {
      let parentId = target ? parents.get(target) : null;
      while (parentId && !reveal.has(parentId)) {
        reveal.add(parentId);
        parentId = parents.get(parentId);
      }
    }
    return reveal;
  }, [treeRows, selectedSessionId, sessionRenameId]);
  // Retain explicit branch collapses, while revealing a newly selected or renamed descendant.
  const [forkTreeState, setForkTreeState] = useState(() => ({
    targetAncestors, selectedSessionId, sessionRenameId, collapsedForks: new Set<string>(),
  }));
  const { collapsedForks } = forkTreeState;

  // Reveal a newly selected/renamed fork before committing a hidden row. Later
  // title/activity updates must not undo an explicit collapse by the user.
  if (forkTreeState.selectedSessionId !== selectedSessionId
    || forkTreeState.sessionRenameId !== sessionRenameId
    || forkTreeState.targetAncestors.size !== targetAncestors.size
    || [...targetAncestors].some((id) => !forkTreeState.targetAncestors.has(id))) {
    setForkTreeState({
      targetAncestors, selectedSessionId, sessionRenameId,
      collapsedForks: new Set([...collapsedForks].filter((id) => !targetAncestors.has(id))),
    });
  }

  const visibleRows = useMemo(() => {
    let hiddenBelowDepth = Infinity;
    const visible: (typeof treeRows[number] & { continuationDepths: number[] })[] = [];
    const continuingAncestors = new Set<number>();
    for (const row of treeRows) {
      if (row.depth > hiddenBelowDepth) continue;
      hiddenBelowDepth = row.hasChildren && collapsedForks.has(row.session.id) ? row.depth : Infinity;
      // Keep sibling rails running through an expanded child's descendants.
      // Only visible columns are retained, so a deep chain stays linear in size.
      for (const depth of continuingAncestors) {
        if (depth >= row.depth) continuingAncestors.delete(depth);
      }
      visible.push({ ...row, continuationDepths: [...continuingAncestors] });
      if (row.depth > 0 && row.depth < MAX_FORK_INDENT_DEPTH && !row.isLastSibling) {
        continuingAncestors.add(row.depth);
      }
    }
    return visible;
  }, [treeRows, collapsedForks]);
  const hasForks = treeRows.some((row) => row.hasChildren);

  if (!isExpanded) {
    return null;
  }

  // The tree also holds pin-only rows the server never returned, so the empty
  // state follows the rows the project can actually draw.
  const hasSessions = treeRows.length > 0;
  // Ordinary rows the reveal window still hides; pinned rows never count.
  const hasHiddenSessions = normalSessions.length > visibleSessionCount;
  const isSelecting = selectedSessionIds !== null;
  // A session with a response in flight cannot be deleted — the same rule the
  // row's options menu applies — so it is not selectable either.
  const isSessionRunning = (session: SessionWithProvider) =>
    activeSessions.has(session.id) && !backgroundSessionIds.has(session.id);
  // Only rows on screen are selectable: a collapsed fork's descendants are
  // hidden, so a bulk delete must not reach them.
  const selectableSessionIds = visibleRows
    .filter(({ session }) => !isSessionRunning(session))
    .map(({ session }) => session.id);
  // Re-derived from the selectable rows rather than read straight off the
  // selection, so a row that started running after it was ticked drops out of
  // the count, the button and the ids the confirmation is opened with.
  const effectiveSelectedIds = selectedSessionIds
    ? selectableSessionIds.filter((sessionId) => selectedSessionIds.has(sessionId))
    : [];
  const checkedSessionIds = new Set(effectiveSelectedIds);
  const allLoadedSelected =
    selectableSessionIds.length > 0 && effectiveSelectedIds.length === selectableSessionIds.length;
  // With rows still hidden behind the pager or on the server, the button only
  // reaches the visible ones, so it offers "Select all loaded" rather than a
  // "Select all" it could not honour. Once those rows are ticked it flips to
  // "Clear" either way.
  const hasMoreThanVisible = hasHiddenSessions || hasMoreSessions;
  const selectAllLabel = allLoadedSelected
    ? t('sessions.clearSelection')
    : hasMoreThanVisible
      ? t('sessions.selectAllLoaded')
      : t('sessions.selectAll');
  const hasMoreSessionsToShow = hasHiddenSessions || hasMoreSessions;

  const showMoreSessions = () => {
    if (hasHiddenSessions) {
      setVisibleSessionCount((count) => count + PROJECT_SESSIONS_PAGE_SIZE);
      return;
    }

    if (!hasMoreSessions || isLoadingMoreSessions) {
      return;
    }

    // Every loaded row is already on screen: continue with the server's page,
    // remembering where the list and the window stood so only one page of the
    // response shows.
    pendingServerRevealRef.current = { loaded: sessions.length, visible: Math.min(visibleSessionCount, normalSessions.length) };
    onLoadMoreSessions(project.projectId);
  };

  return (
    <div className="ml-1.5 space-y-1 border-l border-border/70 pl-1.5">
      {isCompact ? (
        <div className="px-3 pb-1 pt-1">
          <button
            className="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
            onClick={() => {
              onProjectSelect(project);
              onNewSession(project);
            }}
          >
            <Plus className="h-3 w-3" />
            {t('sessions.newSession')}
          </button>
        </div>
      ) : (
        <Button
          variant="default"
          size="sm"
          className="flex h-8 w-full justify-start gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => onNewSession(project)}
        >
          <Plus className="h-3 w-3" />
          {t('sessions.newSession')}
        </Button>
      )}

      {(isSelecting || (initialSessionsLoaded && selectableSessionIds.length > 0)) && (
        <div className={cn('space-y-1', isCompact && 'px-3')}>
          {isSelecting ? (
            <>
              {/* Wraps rather than clips: at the narrowest sidebar width a long
                  translated "Select all loaded" leaves no room for Cancel. */}
              <div className="flex flex-wrap items-center justify-between gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    onSetSessionSelection({
                      projectId: project.projectId,
                      sessionIds: new Set(allLoadedSelected ? [] : selectableSessionIds),
                    })
                  }
                  disabled={selectableSessionIds.length === 0}
                >
                  {selectAllLabel}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={onCancelSessionSelection}
                >
                  {t('actions.cancel')}
                </Button>
              </div>
              <Button
                variant="destructive"
                size="sm"
                className="h-8 w-full justify-center gap-2 bg-red-600 text-xs font-medium text-white hover:bg-red-700"
                onClick={() => onDeleteSelectedSessions(effectiveSelectedIds)}
                disabled={effectiveSelectedIds.length === 0}
              >
                <Trash2 className="h-3 w-3" />
                {t('sessions.deleteSelected', { count: effectiveSelectedIds.length })}
              </Button>
            </>
          ) : (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() =>
                  onSetSessionSelection({ projectId: project.projectId, sessionIds: new Set() })
                }
              >
                <CheckSquare className="h-3 w-3" />
                {t('sessions.select')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* A page emptied by deleting every loaded row still has sessions behind
          it on the server, so it keeps its "Show more" instead of "No sessions". */}
      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions && !hasMoreSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          <div className={cn(!hasForks && 'space-y-1')} data-testid="project-session-tree">
            {visibleRows.map(({ session, parentId, depth, hasChildren, isLastSibling, continuationDepths }) => (
              <div
                key={session.id}
                data-session-id={session.id}
                data-parent-session-id={parentId ?? undefined}
                data-fork-depth={depth}
                data-fork-branch={hasChildren || undefined}
                className="relative flex min-w-0 items-stretch"
                style={depth > 0 ? { paddingLeft: `${Math.min(depth, MAX_FORK_INDENT_DEPTH) * FORK_INDENT_PX}px` } : undefined}
              >
                {parentId && (
                  <span
                    aria-hidden="true"
                    data-fork-connector={isLastSibling ? 'last' : 'branch'}
                    className="pointer-events-none absolute inset-y-0"
                    style={{ left: `${(Math.min(depth, MAX_FORK_INDENT_DEPTH) - 1) * FORK_INDENT_PX + FORK_INDENT_PX / 2}px`, width: `${FORK_INDENT_PX}px` }}
                  >
                    <span className={cn('absolute left-0 top-0 border-l border-muted-foreground/50', isLastSibling ? 'bottom-1/2' : 'bottom-0')} />
                    <span className="absolute left-0 top-1/2 border-t border-muted-foreground/50" style={{ width: hasChildren ? '6px' : '12px' }} />
                  </span>
                )}
                {continuationDepths.map((ancestorDepth) => (
                  <span
                    key={ancestorDepth}
                    aria-hidden="true"
                    data-fork-continuation={ancestorDepth}
                    className="pointer-events-none absolute inset-y-0 border-l border-muted-foreground/50"
                    style={{ left: `${(ancestorDepth - 1) * FORK_INDENT_PX + FORK_INDENT_PX / 2}px` }}
                  />
                ))}
                {hasChildren && !collapsedForks.has(session.id) && (
                  <span
                    aria-hidden="true"
                    data-fork-stem=""
                    className="pointer-events-none absolute bottom-0 border-l border-muted-foreground/50"
                    style={{ left: `${Math.min(depth, MAX_FORK_INDENT_DEPTH - 1) * FORK_INDENT_PX + FORK_INDENT_PX / 2}px`, top: 'calc(50% + 7px)' }}
                  />
                )}
                {hasForks && (
                  hasChildren ? (
                    <button
                      type="button"
                      className="relative flex w-3 flex-shrink-0 items-center justify-center rounded text-foreground/70 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={!collapsedForks.has(session.id)}
                      aria-label={collapsedForks.has(session.id)
                        ? t('sessions.expandForks', { session: session.summary || session.name || t('projects.newSession') })
                        : t('sessions.collapseForks', { session: session.summary || session.name || t('projects.newSession') })}
                      onClick={() => setForkTreeState((previous) => {
                        const next = new Set(previous.collapsedForks);
                        if (next.has(session.id)) next.delete(session.id);
                        else next.add(session.id);
                        return { ...previous, collapsedForks: next };
                      })}
                    >
                      <ChevronRight className={cn('h-3 w-3 transition-transform', !collapsedForks.has(session.id) && 'rotate-90')} strokeWidth={2.5} aria-hidden="true" />
                    </button>
                  ) : <span className="w-3 flex-shrink-0" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <SidebarSessionItem
                    project={project}
                    session={session}
                    selectedSession={selectedSession}
                    isProcessing={isSessionRunning(session)}
                    hasBackgroundWork={backgroundSessionIds.has(session.id)}
                    needsAttention={attentionSessionIds.has(session.id)}
                    currentTime={currentTime}
                    onRenameDraftChange={onRenameDraftChange}
                    isEditing={session.id === sessionRenameId}
                    renameDraft={session.id === sessionRenameId ? sessionRenameDraft : ''}
                    onStartEditingSession={onStartEditingSession}
                    onCancelEditingSession={onCancelEditingSession}
                    onSaveEditingSession={onSaveEditingSession}
                    onProjectSelect={onProjectSelect}
                    onSessionSelect={onSessionSelect}
                    onArchiveSession={onArchiveSession}
                    onDeleteSession={onDeleteSession}
                    onForkSession={onForkSession}
                    isSelecting={isSelecting}
                    isChecked={checkedSessionIds.has(session.id)}
                    onToggleSessionSelected={onToggleSessionSelected}
                    treeRow={hasForks}
                    t={t}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* One control for both stages: it reveals the next local page, then
              once every loaded row is on screen it asks the server for more.
              Hidden as soon as there is nothing left to show. */}
          {hasMoreSessionsToShow && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center text-xs text-muted-foreground hover:text-foreground"
              onClick={showMoreSessions}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : t('sessions.showMore', 'Load more sessions')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
