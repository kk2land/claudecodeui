import { useEffect, useState } from 'react';

import { usePlugins } from '@/modules/plugins';
import { api } from '@/shared/api';

/** Worker run statuses that still hold an execution slot; queued and terminal runs do not. */
const ACTIVE_WORKER_STATUSES = new Set(['starting', 'running', 'stopping', 'unknown']);

/** How often the active chat refreshes its Worker plugin state while visible. */
const WORKER_POLL_INTERVAL_MS = 2000;

type WorkerSnapshot = {
  workers?: Array<{
    parentSessionId?: unknown;
    projectId?: unknown;
    latestRun?: { status?: unknown } | null;
  }> | null;
};

type Args = {
  /** True while a provider that can own Worker plugin runs is selected. */
  enabled: boolean;
  /** False for a transport that never owns Worker runs (Codex SDK, DSH headless or unregistered ACP). */
  native: boolean;
  /** False while another workspace tab covers the chat; pauses polling without changing native controls. */
  chatActive?: boolean;
  projectId: string | null | undefined;
  sessionId: string | null;
};

/**
 * Codex and DSH runtime controls use this to show activity only for a Worker
 * owned by the current session. It reuses the authenticated Worker plugin state
 * endpoint and is intentionally separate from each provider's own turn activity.
 */
export function useSessionWorkerActivity({ enabled, native, chatActive = true, projectId, sessionId }: Args): boolean {
  const { plugins } = usePlugins();
  const workerEnabled = plugins.some((plugin) => plugin.name === 'worker' && plugin.enabled);
  const active = chatActive && enabled && native && workerEnabled && Boolean(projectId) && Boolean(sessionId);
  const scope = active ? `${projectId}:${sessionId}` : null;
  // The scope tag makes a result from a previous project/session immediately
  // unusable, even before the old effect cleanup has run.
  const [snapshot, setSnapshot] = useState<{ scope: string; active: boolean } | null>(null);

  useEffect(() => {
    if (!scope || !projectId || !sessionId) {
      // Do not let a paused or out-of-scope result reappear before the next fresh read.
      setSnapshot(null);
      return;
    }
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let restartRequested = false;
    let request: AbortController | null = null;

    // Unchanged polls must not rerender the owning chat and its transcript.
    const publishActivity = (active: boolean) => setSnapshot((previous) =>
      previous?.scope === scope && previous.active === active ? previous : { scope, active });

    const schedule = () => {
      if (!current || document.hidden) return;
      timer = setTimeout(() => void poll(), WORKER_POLL_INTERVAL_MS);
    };

    const poll = async (): Promise<void> => {
      if (!current || document.hidden) return;
      // Never stack requests: a slow state read delays the next attempt instead.
      if (inFlight) {
        restartRequested = true;
        return;
      }
      inFlight = true;
      const controller = new AbortController();
      request = controller;
      try {
        const response = await api.plugins.workerState(projectId, sessionId, { signal: controller.signal });
        if (!current) return;
        if (!response.ok) {
          // A failed read must not leave an old spinner claiming the session is busy.
          publishActivity(false);
          return;
        }
        const body = await response.json() as WorkerSnapshot;
        if (!current) return;
        const workers = Array.isArray(body?.workers) ? body.workers : [];
        // The server already filtered by query, but a mismatched record must not
        // light this chat's button either.
        publishActivity(workers.some((worker) => worker.parentSessionId === sessionId
            && worker.projectId === projectId
            && typeof worker.latestRun?.status === 'string'
            && ACTIVE_WORKER_STATUSES.has(worker.latestRun.status)));
      } catch {
        // Aborts happen only on hide/unmount/scope change, where the result is
        // already irrelevant; real failures hide the indicator and retry later.
        if (current && !controller.signal.aborted) publishActivity(false);
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
  }, [scope, projectId, sessionId]);

  return Boolean(scope && snapshot?.scope === scope && snapshot.active);
}
