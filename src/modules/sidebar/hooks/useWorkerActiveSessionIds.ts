import { useEffect, useState } from 'react';

import { usePlugins } from '@/modules/plugins';
import { api } from '@/shared/api';
import { isWorkerRunActive } from '@/shared/utils';
import type { WorkerActivitySnapshot } from '@/shared/types';

/** How often the sidebar refreshes the Worker activity shared by all of its rows. */
const WORKER_POLL_INTERVAL_MS = 2000;

/** Stable empty result, so an idle sidebar does not rerender on every poll. */
const NO_ACTIVE_SESSIONS: ReadonlySet<string> = new Set<string>();

/**
 * Returns the parent session ids whose latest Worker run is still active. One
 * unscoped poll serves every sidebar row, including sessions from other
 * projects and the recent-conversations list; it does not depend on which
 * session is currently selected.
 */
export function useWorkerActiveSessionIds(): ReadonlySet<string> {
  const { plugins } = usePlugins();
  const workerEnabled = plugins.some((plugin) => plugin.name === 'worker' && plugin.enabled);
  // Membership only; identity stays stable while the same sessions remain active.
  const [activeSessionIds, setActiveSessionIds] = useState<ReadonlySet<string>>(NO_ACTIVE_SESSIONS);

  useEffect(() => {
    if (!workerEnabled) {
      return;
    }

    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let restartRequested = false;
    let request: AbortController | null = null;

    const publish = (workers: WorkerActivitySnapshot['workers']) => {
      const next = new Set<string>();
      if (Array.isArray(workers)) {
        for (const worker of workers) {
          if (
            typeof worker?.parentSessionId === 'string'
            && worker.parentSessionId
            && isWorkerRunActive(worker.latestRun?.status)
          ) {
            next.add(worker.parentSessionId);
          }
        }
      }
      setActiveSessionIds((previous) => {
        if (previous.size !== next.size) {
          return next;
        }
        for (const sessionId of next) {
          if (!previous.has(sessionId)) {
            return next;
          }
        }
        return previous;
      });
    };

    const schedule = () => {
      if (!current || document.hidden) return;
      timer = setTimeout(() => void poll(), WORKER_POLL_INTERVAL_MS);
    };

    const poll = async (): Promise<void> => {
      if (!current || document.hidden) return;
      // Never stack requests; a slow snapshot delays the next attempt instead.
      if (inFlight) {
        restartRequested = true;
        return;
      }
      inFlight = true;
      const controller = new AbortController();
      request = controller;
      try {
        const response = await api.plugins.workerStateAll({ signal: controller.signal });
        if (!current) return;
        if (!response.ok) {
          // A failed read must not leave a stale spinner claiming a Worker runs.
          publish([]);
          return;
        }
        const body = await response.json() as WorkerActivitySnapshot;
        if (!current) return;
        publish(body?.workers);
      } catch {
        // Aborts happen only on hide/unmount, where the result is irrelevant;
        // real failures hide the indicators and retry on the next poll.
        if (current && !controller.signal.aborted) publish([]);
      } finally {
        inFlight = false;
        if (current) request = null;
        if (current && restartRequested && !document.hidden) {
          restartRequested = false;
          void poll();
        } else {
          restartRequested = false;
          schedule();
        }
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        clearTimeout(timer);
        request?.abort();
        return;
      }
      // Returning to the page refreshes now instead of waiting for the paused timer.
      clearTimeout(timer);
      void poll();
    };

    void poll();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      current = false;
      clearTimeout(timer);
      request?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [workerEnabled]);

  return workerEnabled ? activeSessionIds : NO_ACTIVE_SESSIONS;
}
