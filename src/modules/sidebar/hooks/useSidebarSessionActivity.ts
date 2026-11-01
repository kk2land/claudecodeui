import { useMemo } from 'react';

import { useWorkerActiveSessionIds } from '@/modules/sidebar/hooks/useWorkerActiveSessionIds';

type Args = {
  /** Sessions busy with their own provider run, including background-only work. */
  busySessionIds: ReadonlySet<string>;
  /** The subset of `busySessionIds` that only runs background tasks. */
  backgroundSessionIds: ReadonlySet<string>;
};

type SidebarSessionActivity = {
  /** Sessions that draw the running spinner: own activity plus owned active Workers. */
  activeSessions: ReadonlySet<string>;
  /** Background-only sessions; an active Worker keeps its parent out of this set. */
  backgroundSessionIds: ReadonlySet<string>;
};

/**
 * Merges a session's own provider activity with the Workers it owns. A Worker
 * outlives its parent session's turn, so the list must not lose the spinner
 * just because the parent itself is idle. This only feeds list presentation;
 * it never marks the session as processing for the chat, queue or wakeup.
 */
export function useSidebarSessionActivity({ busySessionIds, backgroundSessionIds }: Args): SidebarSessionActivity {
  const workerSessionIds = useWorkerActiveSessionIds();

  return useMemo(() => {
    if (workerSessionIds.size === 0) {
      return { activeSessions: busySessionIds, backgroundSessionIds };
    }

    return {
      activeSessions: new Set([...busySessionIds, ...workerSessionIds]),
      // A live Worker is stronger activity than the background-task dot, so it
      // keeps the row on the spinner even when the session also lists tasks.
      backgroundSessionIds: new Set([...backgroundSessionIds].filter((sessionId) => !workerSessionIds.has(sessionId))),
    };
  }, [busySessionIds, backgroundSessionIds, workerSessionIds]);
}
