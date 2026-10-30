import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { announceScheduledMessagesChanged } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { readQueuedChatMessage } from '@/shared/utils.js';
import type { QueuedChatMessage } from '@/shared/index.js';

/**
 * How often due scheduled messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const SCHEDULED_POLL_INTERVAL_MS = 30_000;

/**
 * Supplemental check for persisted user queues.
 *
 * Enqueue and turn completion trigger a pass immediately. This interval is only
 * the safety net for an event that could not be observed (for example an append
 * before the process finished starting), and is deliberately shorter than the
 * scheduled-message minute granularity because queued prompts are expected to
 * follow the current turn closely.
 */
const QUEUE_RECHECK_INTERVAL_MS = 15_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let queueTimer: ReturnType<typeof setInterval> | null = null;
let scheduledDispatchInFlight = false;
let activeRuntime: ProviderRuntimeGateway | null = null;
let unsubscribeTurnCompleted: (() => void) | null = null;
/**
 * Sessions with a queued dispatch in flight.
 *
 * A provider run can last for minutes. Tracking this per session means one
 * long turn cannot hold the global lock and starve every other session.
 */
const dispatchingSessions = new Set<string>();
/**
 * Sessions whose next queue head should be tried as soon as the current run
 * settles. Set by a completion notification or an enqueue that raced the run.
 */
const deferredSessionDispatches = new Set<string>();
/**
 * Sessions where a due scheduled message owns the next turn.
 *
 * Set before the scheduled turn aborts/waits out the current run, so a
 * completion notification cannot reserve the ordinary queue in the gap. It is
 * released when that scheduled turn settles, then the queue is tried at once.
 */
const scheduledPrioritySessions = new Set<string>();

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Returns whether the claimed turn was admitted; false means its head was restored or consumed. */
async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
): Promise<boolean> {
  const message = readQueuedChatMessage(candidate.queuedMessage);
  if (!message) {
    // An unusable legacy entry is consumed without reserving a slot forever.
    sessionDraftsDb.confirmQueuedMessageDispatch(candidate);
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return false;
  }

  // The claim removed only the head and reserved its slot; the tail stays
  // queued. A turn that could not be admitted is put back at the head, so it is
  // retried ahead of the tail. Once admitted the receipt stays accepted, which
  // also stops a delayed browser PUT from resurrecting the turn.
  try {
    const started = await sendClaimedQueuedMessageHead(candidate, message, runtime);
    if (started) {
      sessionDraftsDb.confirmQueuedMessageDispatch(candidate);
    }
    return started;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error('[ScheduledMessages] Queued message dispatch failed', {
      sessionId: candidate.sessionId,
      error: reason,
    });
    return false;
  }
}

/** Returns whether the turn was admitted; an unadmitted claim is put back. */
async function sendClaimedQueuedMessageHead(
  candidate: QueuedSessionMessageRecord,
  message: QueuedChatMessage,
  runtime: ProviderRuntimeGateway,
): Promise<boolean> {
  const previousRun = chatRunRegistry.getRun(candidate.sessionId);
  const dispatch = runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
      onTurnStarting: () => sessionDraftsDb.confirmQueuedMessageDispatch(candidate),
    },
    { runtime },
  );

  // Reservation alone does not prove delivery: Codex may still be changing
  // model providers. The callback frees the slot immediately before input is
  // sent, while a failed resume leaves the dispatch receipt restorable.
  const admittedRun = chatRunRegistry.getRun(candidate.sessionId);
  const admitted = Boolean(admittedRun && admittedRun !== previousRun);

  try {
    const result = await dispatch;

    // The registry check and run reservation are separate operations. If a run
    // wins that tiny race, put the turn back at the head so the next poll tries
    // again. A run that did start and then failed is consumed rather than
    // retried: its turn may already have reached the provider.
    if (!result.started) {
      sessionDraftsDb.restoreQueuedMessage(candidate);
      return false;
    }
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return true;
  } catch (error) {
    // A rejected dispatch before the run was reserved (unavailable provider,
    // deleted session, failing `hasRuntime`) never reached the provider, so the
    // head goes back at the front of the untouched tail. Once admitted the
    // receipt becomes accepted instead: retrying could deliver the turn twice.
    if (admitted) {
      sessionDraftsDb.confirmQueuedMessageDispatch(candidate);
    } else {
      sessionDraftsDb.restoreQueuedMessage(candidate);
    }
    throw error;
  }
}

/**
 * Whether a queued turn has to keep waiting for the session.
 *
 * A turn that ends with background work still going (a backgrounded command,
 * agent or workflow) is marked completed, but its CLI process stays open so
 * that work can report back. A new turn replaces that process and stops the
 * work, which is why the composer asks before an interactive send. A queued
 * turn was promised to go "when this finishes", so it waits for that work too.
 */
function isSessionBusy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  return scheduledPrioritySessions.has(sessionId)
    || chatRunRegistry.isProcessing(sessionId) || runtime.hasBackgroundWork(sessionId)
    || Boolean(runtime.isQueueBlocked?.(sessionId));
}

/**
 * Sends idle sessions' persisted turns; used by the timer and providers' queue
 * integration tests.
 *
 * `sessionId` narrows one pass to a single session, which is what enqueue and
 * turn-completion notifications use. Different sessions progress independently;
 * a long provider run only occupies its own session's slot.
 */
export async function dispatchQueuedMessages(
  runtime: ProviderRuntimeGateway,
  options: { sessionId?: string } = {},
): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages().filter(
    (candidate) => !options.sessionId || candidate.sessionId === options.sessionId,
  );
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    // A previous pass still owns this session's slot until its run settles.
    if (dispatchingSessions.has(candidate.sessionId)) {
      return;
    }
    if (isSessionBusy(candidate.sessionId, runtime)) {
      return;
    }
    if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
      return;
    }
    claimed += 1;
    dispatchingSessions.add(candidate.sessionId);
    let admitted = false;
    try {
      admitted = await sendClaimedQueuedMessage(candidate, runtime);
    } finally {
      dispatchingSessions.delete(candidate.sessionId);
      // Completion (or an enqueue) during the run asked for another pass; do
      // it on the next tick so this call still reports the turn it claimed.
      // An unadmitted attempt restored its head and must not immediately retry
      // itself in a tight loop; the supplemental poll owns that retry.
      if (deferredSessionDispatches.delete(candidate.sessionId) && admitted) {
        scheduleSessionDispatch(candidate.sessionId);
      }
    }
  }));

  return claimed;
}

/**
 * Asks the dispatcher to try this session now, or as soon as its run settles.
 *
 * Exported for the User module's enqueue path, the Codex busy `chat.send`
 * fallback, Codex queue-resume controls, and the composition root's turn
 * completion notification. It never throws and never blocks the request that
 * changed the queue.
 */
export function requestQueuedMessageDispatch(sessionId?: string): void {
  const runtime = activeRuntime;
  if (!runtime) {
    return;
  }
  if (sessionId && (dispatchingSessions.has(sessionId) || scheduledPrioritySessions.has(sessionId))) {
    deferredSessionDispatches.add(sessionId);
    return;
  }
  void dispatchQueuedMessages(runtime, sessionId ? { sessionId } : undefined).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ScheduledMessages] Immediate queued-message dispatch failed', { sessionId, error: message });
  });
}

/** Runs one session's next pass after the current dispatch promise settles. */
function scheduleSessionDispatch(sessionId: string): void {
  const timer = setTimeout(() => {
    requestQueuedMessageDispatch(sessionId);
  }, 0);
  timer.unref?.();
}

/** Records why a claimed message did not go, and shows it on its session's banner. */
function recordFailure(row: ScheduledMessageRow, reason: string): void {
  scheduledMessagesDb.markFailed(row.id, reason);
  announceScheduledMessagesChanged(row.session_id);
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  // The scheduled turn may abort the current run and emit its complete event
  // before its own dispatch is reserved. Holding this session's priority
  // across that whole turn stops the completion listener from inserting the
  // ordinary queue in the gap.
  scheduledPrioritySessions.add(row.session_id);
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        interruptActiveRun: true,
      },
      { runtime },
    );

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider) or started and then failed.
    // Silently dropping a message the user scheduled is worse than telling
    // them it did not go.
    if (!result.started || result.error) {
      recordFailure(row, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(row, message);
  } finally {
    scheduledPrioritySessions.delete(row.session_id);
    deferredSessionDispatches.delete(row.session_id);
    // The scheduled turn has settled: the waiting user queue follows on the
    // next tick, preserving FIFO instead of waiting for the 15s fallback.
    scheduleSessionDispatch(row.session_id);
  }
}

/**
 * Sends every message whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now);
  if (due.length === 0) {
    return 0;
  }

  // The claim already recorded them as sent, so their banners come down now,
  // as the turns start, rather than once the last turn has finished.
  for (const sessionId of new Set(due.map((row) => row.session_id))) {
    announceScheduledMessagesChanged(sessionId);
  }

  // Sequentially: a session can only have one run at a time, and two due
  // messages for the same session must not race each other into it.
  for (const row of due) {
    await sendClaimedMessage(row, runtime);
  }

  return due.length;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(
  runtime: ProviderRuntimeGateway,
  options: {
    /**
     * Composition-root bridge to the websocket module's completion notice.
     * Injected instead of deep-importing the registry here, which keeps the
     * scheduled-messages module's dependencies explicit and acyclic.
     */
    subscribeTurnCompleted?: (listener: (sessionId: string) => void) => () => void;
  } = {},
): void {
  if (pollTimer) {
    return;
  }
  activeRuntime = runtime;

  const pollScheduled = () => {
    // A due-message pass that overruns the interval must not be started again
    // underneath itself; the claim is transactional but the runs are not.
    if (scheduledDispatchInFlight) {
      return;
    }
    scheduledDispatchInFlight = true;
    void dispatchDueScheduledMessages(runtime)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Scheduled dispatch pass failed', { error: message });
      })
      .finally(() => {
        scheduledDispatchInFlight = false;
      });
  };

  const pollQueue = () => {
    void dispatchQueuedMessages(runtime).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ScheduledMessages] Queued-message dispatch pass failed', { error: message });
    });
  };

  pollTimer = setInterval(pollScheduled, SCHEDULED_POLL_INTERVAL_MS);
  queueTimer = setInterval(pollQueue, QUEUE_RECHECK_INTERVAL_MS);
  // Never keep the process alive just to poll for messages.
  pollTimer.unref?.();
  queueTimer.unref?.();

  // A turn that ends starts the next user prompt immediately; the interval is
  // only the fallback. The root injects the websocket module's subscriber.
  unsubscribeTurnCompleted = options.subscribeTurnCompleted?.((sessionId) => {
    requestQueuedMessageDispatch(sessionId);
  }) ?? null;

  // Catch up on anything that came due or was queued while the server was down.
  pollScheduled();
  pollQueue();
}

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (queueTimer) {
    clearInterval(queueTimer);
    queueTimer = null;
  }
  unsubscribeTurnCompleted?.();
  unsubscribeTurnCompleted = null;
  activeRuntime = null;
  deferredSessionDispatches.clear();
}
