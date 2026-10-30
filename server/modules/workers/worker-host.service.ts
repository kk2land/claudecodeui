import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  CodexSessionState,
  CodexWorkerBridge,
  CodexWorkerPrepareSessionInput,
  WorkerCancelFenceInput,
  WorkerNotification,
  WorkerOwner,
  WorkerWakeSource,
  WorkerWakeTurnInput,
} from '@/shared/index.js';
import type { WorkerIpcClient } from './worker-ipc.client.js';

type SessionLookup = { project_path: string | null; provider: string } | null;

/** Composition-boundary inputs used only by this service file. */
type WorkerHostDependencies = {
  ipc: WorkerIpcClient;
  /** True only while the bundled Worker plugin is enabled in plugin config. */
  isEnabled(): boolean;
  /** Absolute MCP URL the Codex thread config should point at. */
  resolveMcpUrl(): string;
  runtime: {
    isQueueBlocked(sessionId: string): boolean;
    getState?(provider: 'codex', sessionId: string): CodexSessionState | undefined;
    hasBackgroundWork(sessionId: string): boolean;
  };
  hasActiveRun(sessionId: string): boolean;
  sessions: { getSessionById(sessionId: string): SessionLookup };
  projects: { getProjectPath(projectPath: string): { project_id: string } | null };
  drafts: { hasQueuedMessages(sessionId: string): boolean };
  settings: { get(sessionId: string): { queueHeld: boolean } };
  runTurn(input: WorkerWakeTurnInput): Promise<{ started: boolean; error: string | null }>;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  randomToken?: () => string;
  randomBatchId?: () => string;
  log?: (message: string, detail?: unknown) => void;
};

type RegisteredOwner = {
  owner: WorkerOwner;
  token: string;
  /** True only after the plugin has acknowledged this owner registration. */
  registered: boolean;
};

const RETRY_DELAY_MS = 2_000;
const IDLE_MERGE_MS = 500;

/**
 * Host-side orchestration for the bundled Worker plugin. The returned object
 * satisfies the shared `WorkerHostService` consumed by the MCP/control routes.
 *
 * Responsibilities are limited to the trusted boundary: verifying the real
 * session/project, registering owner tokens, forwarding Codex lifecycle
 * cleanup, and waking the parent session with outbox results. Worker execution,
 * concurrency, logs, and persistence stay inside the plugin process.
 */
export function createWorkerHostService(dependencies: WorkerHostDependencies) {
  const owners = new Map<string, RegisteredOwner>();
  const sessionOwners = new Map<string, string>();
  const pendingNotifications = new Map<string, WorkerNotification>();
  const inFlight = new Set<string>();
  const unsubscribe: Array<() => void> = [];
  const schedule = dependencies.setTimeout ?? setTimeout;
  const cancel = dependencies.clearTimeout ?? clearTimeout;
  const randomToken = dependencies.randomToken ?? (() => randomBytes(32).toString('hex'));
  const randomBatchId = dependencies.randomBatchId ?? randomUUID;
  const log = dependencies.log ?? console.error;
  const ownerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let refreshing = false;
  let shuttingDown = false;

  function clearOwnerTimer(ownerId: string): void {
    const timer = ownerTimers.get(ownerId);
    if (timer) cancel(timer);
    ownerTimers.delete(ownerId);
  }

  function clearAllTimers(): void {
    for (const timer of ownerTimers.values()) cancel(timer);
    ownerTimers.clear();
  }

  /**
   * One timer per owner. A busy owner's later event can never replace an idle
   * owner's earlier due window, and same-owner events still merge.
   */
  function scheduleOwnerFlush(entry: RegisteredOwner, delay: number): void {
    if (shuttingDown) return;
    const ownerId = entry.owner.id;
    clearOwnerTimer(ownerId);
    const timer = schedule(() => {
      ownerTimers.delete(ownerId);
      if (owners.get(ownerId) === entry) void deliverOwner(entry);
    }, delay);
    timer.unref?.();
    ownerTimers.set(ownerId, timer);
  }

  function currentOwners(): RegisteredOwner[] {
    return [...owners.values()];
  }

  function ownerFor(sessionId: string): RegisteredOwner | undefined {
    const ownerId = sessionOwners.get(sessionId);
    return ownerId ? owners.get(ownerId) : undefined;
  }

  function isKnownOwner(ownerId: string): boolean {
    return owners.has(ownerId);
  }

  function isCurrentOwner(entry: RegisteredOwner): boolean {
    return owners.get(entry.owner.id) === entry;
  }

  function candidatesFor(entry: RegisteredOwner): WorkerNotification[] {
    return [...pendingNotifications.values()].filter((notification) => notification.ownerId === entry.owner.id);
  }

  function drop(ids: string[]): void {
    for (const id of ids) pendingNotifications.delete(id);
  }

  function removeOwner(entry: RegisteredOwner): void {
    owners.delete(entry.owner.id);
    inFlight.delete(entry.owner.id);
    clearOwnerTimer(entry.owner.id);
    if (sessionOwners.get(entry.owner.parentSessionId) === entry.owner.id) {
      sessionOwners.delete(entry.owner.parentSessionId);
    }
    for (const [id, notification] of pendingNotifications) {
      if (notification.ownerId === entry.owner.id) pendingNotifications.delete(id);
    }
  }

  /** Synchronous local pause used by Stop/fence/restart before any async cleanup. */
  function pauseLocally(entry: RegisteredOwner, reason: string): void {
    entry.owner.paused = true;
    entry.owner.pausedReason = reason;
    clearOwnerTimer(entry.owner.id);
    for (const [id, notification] of pendingNotifications) {
      if (notification.ownerId === entry.owner.id) pendingNotifications.delete(id);
    }
  }

  async function setPaused(entry: RegisteredOwner, paused: boolean, reason?: string): Promise<boolean> {
    if (paused) pauseLocally(entry, reason ?? 'stopped');
    else {
      entry.owner.paused = false;
      entry.owner.pausedReason = undefined;
    }
    // A provisional owner has no remote process yet, so a Stop that lands
    // during startup is already a complete cleanup even if IPC is unavailable.
    if (!entry.registered) return true;
    try {
      await dependencies.ipc.request('setOwnerPaused', {
        ownerId: entry.owner.id,
        paused,
        ...(reason ? { reason } : {}),
      });
      return true;
    } catch (error) {
      log(`[Workers] Could not ${paused ? 'pause' : 'activate'} owner ${entry.owner.id}`, error);
      // A failed pause still keeps the local fence; a failed activation stays
      // paused so an unavailable plugin can never cause an implicit wake-up.
      if (!paused) pauseLocally(entry, 'activation not confirmed');
      return false;
    }
  }

  /**
   * Explicit pause/Stop/lost authority is `held`. Ordinary parent activity is
   * not: it must be waited out and retried until the session becomes idle.
   */
  function holdReason(entry: RegisteredOwner): string | null {
    if (shuttingDown) return 'shutdown';
    if (!isCurrentOwner(entry)) return 'lost-authority';
    if (entry.owner.paused) return 'paused';
    if (dependencies.settings.get(entry.owner.parentSessionId).queueHeld) return 'queueHeld';
    const phase = dependencies.runtime.getState?.('codex', entry.owner.parentSessionId)?.phase;
    if (phase === 'stopping' || phase === 'stopFailed') return phase;
    return null;
  }

  /** Normal parent work that must finish before a Worker result may wake it. */
  function busyReason(entry: RegisteredOwner): string | null {
    const sessionId = entry.owner.parentSessionId;
    if (dependencies.hasActiveRun(sessionId)) return 'active-run';
    const state = dependencies.runtime.getState?.('codex', sessionId);
    if (state && (state.phase === 'starting' || state.phase === 'running')) return state.phase;
    if (state?.goal?.status === 'active') return 'goal';
    if (dependencies.runtime.isQueueBlocked(sessionId)) return 'queue-blocked';
    if (dependencies.runtime.hasBackgroundWork(sessionId)) return 'background';
    if (dependencies.drafts.hasQueuedMessages(sessionId)) return 'queued-messages';
    return null;
  }

  async function settle(
    ids: string[],
    batchId: string,
    delivery: 'delivered' | 'pending' | 'held' | 'unknown',
    keepForRetry = false,
  ): Promise<void> {
    try {
      await dependencies.ipc.request('settleNotifications', { batchId, delivery });
    } catch (error) {
      // The batch stays in an unknown state in the plugin; never replay it automatically.
      log(`[Workers] Could not settle notification batch ${batchId} as ${delivery}`, error);
      keepForRetry = false;
    }
    if (!keepForRetry) drop(ids);
  }

  async function claim(owner: RegisteredOwner, ids: string[]): Promise<{ batchId: string; notifications: WorkerNotification[] } | null> {
    const batchId = randomBatchId();
    try {
      const result = await dependencies.ipc.request('claimNotifications', {
        ownerId: owner.owner.id,
        eventIds: ids,
        batchId,
      });
      return { batchId, notifications: result.notifications ?? [] };
    } catch (error) {
      // Claiming is not idempotent across a disconnect: drop the candidates instead of resending.
      log(`[Workers] Could not claim notifications for ${owner.owner.id}`, error);
      drop(ids);
      return null;
    }
  }

  function finalGuard(entry: RegisteredOwner, appServerInstanceId: string): boolean {
    const sessionId = entry.owner.parentSessionId;
    return !shuttingDown
      && owners.get(entry.owner.id) === entry
      && entry.owner.appServerInstanceId === appServerInstanceId
      && !entry.owner.paused
      && !dependencies.settings.get(sessionId).queueHeld
      // A user turn queued after this batch was claimed has priority. Returning
      // false here makes the host settle the same batch back to pending; it is
      // a normal delay, not a native failure.
      && !dependencies.drafts.hasQueuedMessages(sessionId);
  }

  async function deliverOwner(entry: RegisteredOwner): Promise<void> {
    const ownerId = entry.owner.id;
    if (inFlight.has(ownerId)) return;
    const candidates = candidatesFor(entry);
    if (!candidates.length) return;

    inFlight.add(ownerId);
    try {
      const ids = candidates.map((notification) => notification.id);
      // Explicit stop/lost authority is settled held. This is the only path
      // besides shutdown that converts a candidate to `held`; ordinary busy
      // states never do.
      if (holdReason(entry)) {
        const claimed = await claim(entry, ids);
        if (claimed) {
          const claimedIds = claimed.notifications.map((notification) => notification.id);
          if (claimedIds.length) await settle(claimedIds, claimed.batchId, 'held');
          drop(ids);
        }
        return;
      }
      // Busy means "retry later" without claiming: an in-flight user turn,
      // queued user messages, a goal, or native background work must retain all
      // its own priority and must never be interrupted by a Worker summary.
      if (busyReason(entry)) {
        scheduleOwnerFlush(entry, RETRY_DELAY_MS);
        return;
      }

      const claimed = await claim(entry, ids);
      if (!claimed) return;
      const notifications = claimed.notifications;
      const claimedIds = notifications.map((notification) => notification.id);
      // Anything the plugin omitted from the batch was acknowledged elsewhere;
      // it is never counted as delivered.
      if (!notifications.length) {
        drop(ids);
        return;
      }
      const stopped = holdReason(entry);
      if (stopped) {
        await settle(claimedIds, claimed.batchId, 'held');
        drop(ids.filter((id) => !claimedIds.includes(id)));
        return;
      }
      if (busyReason(entry)) {
        // A busy race won after the claim. Release the same batch to pending and
        // keep the original notification ids for the next check.
        await settle(claimedIds, claimed.batchId, 'pending', true);
        drop(ids.filter((id) => !claimedIds.includes(id)));
        scheduleOwnerFlush(entry, RETRY_DELAY_MS);
        return;
      }
      const source: WorkerWakeSource = {
        batchId: claimed.batchId,
        results: notifications.map((notification) => ({
          workerId: notification.workerId,
          runId: notification.runId,
          status: notification.status,
          summary: notification.summary,
        })),
      };
      const content = [
        `Automatic Worker execution result (batch ${source.batchId}).`,
        'This is not user acceptance. Review the result with Codex before continuing.',
        '',
        ...source.results.map((result) => [
          `Worker: ${result.workerId}`,
          `Run: ${result.runId}`,
          `Status: ${result.status}`,
          `Summary: ${result.summary}`,
        ].join('\n')),
      ].join('\n');
      const appServerInstanceId = entry.owner.appServerInstanceId;
      try {
        const result = await dependencies.runTurn({
          sessionId: entry.owner.parentSessionId,
          userId: entry.owner.userId,
          content,
          workerSource: source,
          finalGuard: () => finalGuard(entry, appServerInstanceId),
        });
        if (result.started) {
          await settle(claimedIds, claimed.batchId, 'delivered');
        } else if (holdReason(entry)) {
          await settle(claimedIds, claimed.batchId, 'held');
        } else {
          await settle(claimedIds, claimed.batchId, 'pending', true);
        }
      } catch (error) {
        // The turn may have been admitted before the failure; keep it unknown.
        log(`[Workers] Automatic wake-up for ${ownerId} failed`, error);
        await settle(claimedIds, claimed.batchId, 'unknown');
      }
      drop(ids.filter((id) => !claimedIds.includes(id)));
    } finally {
      inFlight.delete(ownerId);
      ensureScheduled();
    }
  }

  function ensureScheduled(): void {
    if (shuttingDown) return;
    for (const entry of currentOwners()) {
      if (inFlight.has(entry.owner.id) || ownerTimers.has(entry.owner.id) || !candidatesFor(entry).length) continue;
      // In-flight owners reschedule themselves when their turn settles.
      scheduleOwnerFlush(entry, busyReason(entry) !== null ? RETRY_DELAY_MS : IDLE_MERGE_MS);
    }
  }

  async function refreshOutbox(): Promise<void> {
    if (shuttingDown || refreshing) return;
    refreshing = true;
    try {
      const listed = await dependencies.ipc.request('listNotifications', {});
      for (const notification of listed) {
        // Only live owners receive automatic or manual delivery decisions.
        if (notification.delivery === 'pending' && isKnownOwner(notification.ownerId)) {
          pendingNotifications.set(notification.id, notification);
        }
      }
      for (const entry of currentOwners()) {
        if (candidatesFor(entry).length) scheduleOwnerFlush(entry, IDLE_MERGE_MS);
      }
    } catch (error) {
      log('[Workers] Could not refresh the persisted notification outbox', error);
    } finally {
      refreshing = false;
    }
  }

  async function holdPendingNotifications(): Promise<void> {
    if (!owners.size) return;
    let listed: WorkerNotification[];
    try {
      listed = await dependencies.ipc.request('listNotifications', {});
    } catch (error) {
      log('[Workers] Could not list notifications after plugin restart', error);
      return;
    }
    const known = new Set(owners.keys());
    const pending = listed.filter((notification) => notification.delivery === 'pending' && known.has(notification.ownerId));
    const byOwner = new Map<string, WorkerNotification[]>();
    for (const notification of pending) {
      const list = byOwner.get(notification.ownerId) ?? [];
      list.push(notification);
      byOwner.set(notification.ownerId, list);
    }
    for (const [ownerId, list] of byOwner) {
      const owner = owners.get(ownerId);
      if (!owner) continue;
      const ids = list.map((notification) => notification.id);
      const claimed = await claim(owner, ids);
      if (claimed) {
        await settle(claimed.notifications.map((notification) => notification.id), claimed.batchId, 'held');
        drop(ids);
      }
    }
  }

  async function registerOwner(entry: RegisteredOwner): Promise<boolean> {
    try {
      await dependencies.ipc.request('registerOwner', { owner: entry.owner, token: entry.token });
      return true;
    } catch (error) {
      log(`[Workers] Could not register owner for ${entry.owner.parentSessionId}`, error);
      return false;
    }
  }

  async function restoreOwners(): Promise<void> {
    if (shuttingDown || !owners.size) return;
    // A plugin restart is not an explicit user turn. Pause every live owner
    // locally before the reconnect can deliver anything or re-register.
    for (const entry of currentOwners()) pauseLocally(entry, 'worker plugin restarted');
    if (!await dependencies.ipc.ensureReady()) return;
    for (const entry of currentOwners()) {
      if (!isCurrentOwner(entry)) continue;
      await registerOwner(entry);
    }
    // Historical pending consequences stay held until a genuine user turn
    // reactivates the owner and the user manually retries them.
    await holdPendingNotifications();
  }

  function fenceCancel(input: WorkerCancelFenceInput): number {
    const hasFilter = Boolean(input.parentSessionId || input.projectId);
    if (!input.all && !hasFilter) return 0;
    const targets = currentOwners().filter((entry) => {
      if (input.parentSessionId && entry.owner.parentSessionId !== input.parentSessionId) return false;
      if (input.projectId && entry.owner.projectId !== input.projectId) return false;
      return true;
    });
    if (input.pause !== false) {
      for (const entry of targets) pauseLocally(entry, 'user-cancelled-workers');
    }
    return targets.length;
  }

  const bridge: CodexWorkerBridge = {
    async prepareSession(input: CodexWorkerPrepareSessionInput) {
      if (!dependencies.isEnabled()) return null;
      const session = dependencies.sessions.getSessionById(input.sessionId);
      const projectPath = session?.project_path ? path.resolve(session.project_path) : null;
      if (!session || session.provider !== 'codex' || !projectPath) return null;
      // The owner may only assert the real project this app session belongs to.
      if (path.resolve(input.projectPath) !== projectPath) return null;
      const project = dependencies.projects.getProjectPath(projectPath);
      if (!project) return null;
      const ownerId = `${input.appServerInstanceId}:${input.sessionId}`;
      const previousOwnerId = sessionOwners.get(input.sessionId);
      const previous = previousOwnerId ? owners.get(previousOwnerId) : undefined;
      const entry: RegisteredOwner = {
        owner: {
          id: ownerId,
          parentSessionId: input.sessionId,
          projectId: project.project_id,
          projectPath,
          userId: input.userId,
          appServerInstanceId: input.appServerInstanceId,
          paused: previous?.owner.paused ?? false,
          ...(previous?.owner.pausedReason ? { pausedReason: previous.owner.pausedReason } : {}),
        },
        token: randomToken(),
        registered: previous?.owner.id === ownerId ? previous.registered : false,
      };
      const rollback = () => {
        if (owners.get(ownerId) === entry) owners.delete(ownerId);
        if (previous && previous.owner.id === ownerId) owners.set(ownerId, previous);
        if (previousOwnerId) sessionOwners.set(input.sessionId, previousOwnerId);
        else sessionOwners.delete(input.sessionId);
      };

      // Publish before the first startup/registration await so a Stop during
      // ensureReady still fences this exact provisional owner.
      owners.set(ownerId, entry);
      sessionOwners.set(input.sessionId, ownerId);
      if (!await dependencies.ipc.ensureReady()) {
        rollback();
        return null;
      }
      if (!await registerOwner(entry)) {
        rollback();
        return null;
      }
      entry.registered = true;
      if (entry.owner.paused) {
        // The Stop may have fenced before the plugin acknowledged registration.
        // Re-assert the preserved pause so core and local authority agree.
        try {
          await dependencies.ipc.request('setOwnerPaused', {
            ownerId,
            paused: true,
            reason: entry.owner.pausedReason ?? 'stopped during registration',
          });
        } catch (error) {
          log(`[Workers] Could not preserve pause for owner ${ownerId} after registration`, error);
        }
      }
      if (previous && previous.owner.id !== ownerId) removeOwner(previous);
      return {
        // Per-server override: unrelated MCP servers configured by the user are
        // preserved instead of being replaced by a top-level server table.
        'mcp_servers.cloudcli_workers': {
          url: dependencies.resolveMcpUrl(),
          http_headers: { Authorization: `Bearer ${entry.token}` },
          enabled: true,
        },
      };
    },
    async activateSession(sessionId: string) {
      const entry = ownerFor(sessionId);
      if (!entry || !entry.owner.paused) return;
      await setPaused(entry, false);
    },
    async stopSession(sessionId: string, reason: string) {
      // A replacement can leave the previous owner visible until registration
      // succeeds. Pause every live owner for this session and report an honest
      // aggregate instead of silently succeeding on only the provisional one.
      const targets = currentOwners().filter((entry) => entry.owner.parentSessionId === sessionId);
      if (!targets.length) return true;
      let confirmed = true;
      for (const entry of targets) {
        if (!await setPaused(entry, true, reason)) confirmed = false;
      }
      return confirmed;
    },
    async closeAppServer(appServerInstanceId: string, reason: string) {
      const affected = currentOwners().filter((entry) => entry.owner.appServerInstanceId === appServerInstanceId);
      for (const entry of affected) removeOwner(entry);
      try {
        await dependencies.ipc.request('closeInstance', { appServerInstanceId, reason });
      } catch (error) {
        log(`[Workers] Could not close Worker instance ${appServerInstanceId}`, error);
      }
    },
  };

  return {
    bridge,
    fenceCancel,
    initialize() {
      unsubscribe.push(
        dependencies.ipc.onEvent((event) => {
          if (event.event === 'notification') {
            if (!isKnownOwner(event.value.ownerId)) return;
            // Manual retry emits the same notification event; it is discoverable
            // here but an explicit retry never unpauses a stopped owner.
            pendingNotifications.set(event.value.id, event.value);
            const entry = owners.get(event.value.ownerId)!;
            scheduleOwnerFlush(entry, busyReason(entry) !== null ? RETRY_DELAY_MS : IDLE_MERGE_MS);
            return;
          }
          // A retry implemented as a persisted-outbox change still has to be
          // discoverable by the host without resuming a paused owner.
          void refreshOutbox();
        }),
        dependencies.ipc.onDisconnect(() => {
          // Shutdown already paused owners and cleared notifications; its
          // closeAll catch reports any unconfirmed cleanup.
          if (shuttingDown) return;
          clearAllTimers();
          // A plugin restart must stop automatic consequences immediately, not
          // only after the reconnect event.
          for (const entry of currentOwners()) pauseLocally(entry, 'worker plugin disconnected');
          pendingNotifications.clear();
          log('[Workers] Worker plugin disconnected; owners are locally paused until a user turn');
        }),
        dependencies.ipc.onReady(() => {
          void restoreOwners();
        }),
      );
    },
    /** Used by the server bootstrap to re-register known owners after a managed plugin restart. */
    restoreOwners,
    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      clearAllTimers();
      for (const entry of currentOwners()) pauseLocally(entry, 'CloudCLI is shutting down');
      pendingNotifications.clear();
      try {
        await dependencies.ipc.request('closeAll', { reason: 'CloudCLI is shutting down.' });
      } catch (error) {
        log('[Workers] Could not confirm Worker cleanup during shutdown', error);
      }
      owners.clear();
      sessionOwners.clear();
      inFlight.clear();
      for (const stop of unsubscribe) stop();
      unsubscribe.length = 0;
      dependencies.ipc.dispose();
    },
    /** Used by the Worker MCP proxy and diagnostics; never starts the plugin. */
    isReady() {
      return !shuttingDown && dependencies.isEnabled() && dependencies.ipc.isReady();
    },
  };
}
