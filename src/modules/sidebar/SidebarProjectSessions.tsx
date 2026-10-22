import { useEffect, useRef, useState } from 'react';
import { CheckSquare, Plus, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';

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

  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;
  const visibleSessions = sessions.slice(0, visibleSessionCount);
  // Loaded sessions the reveal window still hides; independent of the server.
  const hasHiddenSessions = sessions.length > visibleSessionCount;
  const isSelecting = selectedSessionIds !== null;
  // A session with a response in flight cannot be deleted — the same rule the
  // row's options menu applies — so it is not selectable either.
  const isSessionRunning = (session: SessionWithProvider) =>
    activeSessions.has(session.id) && !backgroundSessionIds.has(session.id);
  // Selection is scoped to the rows on screen: a bulk delete must never reach a
  // session the pager hides, nor one the server has not sent yet.
  const selectableSessionIds = visibleSessions
    .filter((session) => !isSessionRunning(session))
    .map((session) => session.id);
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
    pendingServerRevealRef.current = { loaded: sessions.length, visible: visibleSessions.length };
    onLoadMoreSessions(project.projectId);
  };

  return (
    <div className="ml-3 space-y-1 border-l border-border pl-3">
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
          {visibleSessions.map((session) => (
            <SidebarSessionItem
              key={session.id}
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
              onDeleteSession={onDeleteSession}
              onForkSession={onForkSession}
              isSelecting={isSelecting}
              isChecked={checkedSessionIds.has(session.id)}
              onToggleSessionSelected={onToggleSessionSelected}
              t={t}
            />
          ))}

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
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : t('sessions.showMore')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
