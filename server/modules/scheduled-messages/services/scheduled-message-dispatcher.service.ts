import { scheduledMessagesDb, sessionDraftsDb, sessionRuntimeDb, sessionsDb } from '@/modules/database/index.js';
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
 *
 * Queued messages do not wait for this: they are also dispatched the moment
 * the run that blocked them settles (see `unsubscribeTurnCompleted` below). The
 * poll remains their safety net for the cases no run-settled event covers —
 * a message queued while nothing was running, or one left behind by a server
 * restart.
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
let activeRuntime: ProviderRuntimeGateway | null = null;
let unsubscribeTurnCompleted: (() => void) | null = null;
/**
 * Composition-root listener told when a session has genuinely nothing left to
 * do. Used by the resident host to commit a stopped episode only after the
 * queue/dispatch chain drained, so an ordinary turn end never reports a stop
 * while a queued turn, a goal or a scheduled turn is still owed.
 */
let sessionSettledListener: ((sessionId: string) => void) | null = null;
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

/**
 * Whether one session truly has nothing left: no dispatch in flight, no
 * deferred/scheduled priority, no active run or background work, no queued
 * turn, and no native goal or stop transition still owed.
 */
function isSessionSettled(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  if (
    dispatchingSessions.has(sessionId)
    || scheduledPrioritySessions.has(sessionId)
    || deferredSessionDispatches.has(sessionId)
  ) {
    return false;
  }
  if (
    chatRunRegistry.isProcessing(sessionId)
    || runtime.hasBackgroundWork(sessionId)
    || Boolean(runtime.isQueueBlocked?.(sessionId))
    || sessionDraftsDb.hasQueuedMessages(sessionId)
  ) {
    return false;
  }
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    return true;
  }
  // Codex reports the app-server goal; a goal or stop transition means the
  // session is still working.
  const state = runtime.getState?.('codex', sessionId);
  const goalActive = state?.goal?.status === 'active';
  return !(goalActive || ['starting', 'stopping', 'stopFailed'].includes(state?.phase ?? ''));
}

/** Reports a settled session to the composition root; never throws into a dispatch pass. */
function announceSettledIfIdle(sessionId: string, runtime: ProviderRuntimeGateway): void {
  if (!sessionSettledListener || !isSessionSettled(sessionId, runtime)) {
    return;
  }
  try {
    sessionSettledListener(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ScheduledMessages] Session-settled listener failed', { sessionId, error: message });
  }
}

/**
 * Sessions whose scheduled sends are still going, from this pass or an
 * earlier one. Their next due rows stay pending (and keep their banner) until
 * those sends finish, so they neither overtake nor interrupt them.
 */
const sessionsSending = new Set<string>();

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
  message: QueuedChatMessage | null,
  needsProof: boolean,
  runtime: ProviderRuntimeGateway,
): Promise<boolean> {
  if (!message) {
    // An unusable legacy entry is consumed without reserving a slot forever.
    sessionDraftsDb.confirmQueuedMessageDispatch(candidate);
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return false;
  }

  // A turn that could not be admitted stays ahead of the tail. Accepted
  // receipts also stop a delayed browser PUT from resurrecting the turn.
  try {
    const started = await sendClaimedQueuedMessageHead(candidate, message, needsProof, runtime);
    if (started && !needsProof) {
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

/**
 * Whether this queue entry may only be confirmed from native delivery proof.
 *
 * A speech-derived Codex app-server turn carries no draft text anyone can
 * re-derive, and its `turn/start` can be refused after the receipt was claimed.
 * Only that provider loses the "started" shortcut; every other provider and
 * ordinary web prompt keeps its existing delivery policy.
 */
function requiresNativeInputAcceptance(
  candidate: QueuedSessionMessageRecord,
  message: QueuedChatMessage,
): boolean {
  if (message.options?.inputSource !== 'voice') return false;
  const session = sessionsDb.getSessionById(candidate.sessionId);
  if (session?.provider !== 'codex') return false;
  return sessionRuntimeDb.get(candidate.sessionId)?.runtime === 'app-server';
}

/** Returns whether the turn was admitted; an unadmitted claim is put back. */
async function sendClaimedQueuedMessageHead(
  candidate: QueuedSessionMessageRecord,
  message: QueuedChatMessage,
  needsProof: boolean,
  runtime: ProviderRuntimeGateway,
): Promise<boolean> {
  const previousRun = chatRunRegistry.getRun(candidate.sessionId);
  const dispatch = runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
      // A proof-backed claim is confirmed from the provider's own acceptance
      // callback below, never merely because native input is about to start.
      ...(needsProof
        ? { onInputAccepted: () => sessionDraftsDb.finishSteer(candidate.userId, candidate.sessionId, candidate.dispatchRequestId!, 'accepted') }
        : { onTurnStarting: () => sessionDraftsDb.confirmQueuedMessageDispatch(candidate) }),
    },
    { runtime },
  );

  // Reservation alone does not prove delivery: Codex may still be changing
  // model providers. Ordinary turns free their slot before input starts; a
  // proof-backed turn waits for native acceptance.
  const admittedRun = chatRunRegistry.getRun(candidate.sessionId);
  const admitted = Boolean(admittedRun && admittedRun !== previousRun);

  try {
    const result = await dispatch;

    // The native turn exists but the runtime could neither confirm nor refuse
    // it. Retrying could deliver it twice, so park it for the existing
    // explicit recovery flow and leave the tail untouched.
    if (result.deliveryUnknown) {
      const delivery = sessionDraftsDb.finishSteer(
        candidate.userId,
        candidate.sessionId,
        candidate.dispatchRequestId!,
        'unknown',
        'The provider result could not be confirmed. Resolve this message before the queue continues.',
      );
      if (delivery === 'accepted') {
        sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
        return true;
      }
      return false;
    }

    // The registry check and run reservation are separate operations. If a run
    // wins that tiny race, put the turn back at the head so the next poll tries
    // again. A run that did start and then failed is consumed rather than
    // retried: its turn may already have reached the provider.
    if (!result.started) {
      if (needsProof) {
        sessionDraftsDb.finishSteer(candidate.userId, candidate.sessionId, candidate.dispatchRequestId!, 'rejected', result.error, { keepQueuedOnRejection: true });
      } else {
        sessionDraftsDb.restoreQueuedMessage(candidate);
      }
      return false;
    }
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return true;
  } catch (error) {
    // A rejected dispatch before the run was reserved (unavailable provider,
    // deleted session, failing `hasRuntime`) never reached the provider, so the
    // head goes back at the front of the untouched tail. Once admitted the
    // receipt becomes accepted instead: retrying could deliver the turn twice.
    // finishSteer retains a prior acceptance instead of releasing it.
    if (needsProof) {
      sessionDraftsDb.finishSteer(candidate.userId, candidate.sessionId, candidate.dispatchRequestId!, 'rejected', null, { keepQueuedOnRejection: true });
    } else if (admitted) {
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
  // sessionsSending too: a scheduled turn can complete before its send settles,
  // and the session's next due row would then interrupt this queued turn.
  return scheduledPrioritySessions.has(sessionId) || sessionsSending.has(sessionId)
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
  const candidates = sessionDraftsDb.listQueuedMessages(options.sessionId);
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    // A previous pass still owns this session's slot until its run settles.
    if (dispatchingSessions.has(candidate.sessionId)) {
      return;
    }
    if (isSessionBusy(candidate.sessionId, runtime)) {
      return;
    }
    const message = readQueuedChatMessage(candidate.queuedMessage);
    const needsProof = message !== null && requiresNativeInputAcceptance(candidate, message);
    if (!sessionDraftsDb.claimQueuedMessage(candidate, needsProof)) {
      return;
    }
    claimed += 1;
    dispatchingSessions.add(candidate.sessionId);
    let admitted = false;
    try {
      admitted = await sendClaimedQueuedMessage(candidate, message, needsProof, runtime);
    } finally {
      dispatchingSessions.delete(candidate.sessionId);
      // Completion (or an enqueue) during the run asked for another pass; do
      // it on the next tick so this call still reports the turn it claimed.
      // An unadmitted attempt restored its head and must not immediately retry
      // itself in a tight loop; the supplemental poll owns that retry.
      if (deferredSessionDispatches.delete(candidate.sessionId) && admitted) {
        scheduleSessionDispatch(candidate.sessionId);
      } else {
        // The chain for this session ended here: either no follow-up was owed
        // or the retry above will report its own settlement later.
        announceSettledIfIdle(candidate.sessionId, runtime);
      }
    }
  }));

  // A completion notification for a session with no queued turn claims nothing
  // above, so its settled state is reported here.
  if (options.sessionId) {
    announceSettledIfIdle(options.sessionId, runtime);
  }

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
 * Sends every message whose time has come and returns how many it handled.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now, sessionsSending);
  if (due.length === 0) {
    return 0;
  }

  // The claim already recorded them as sent, so their banners come down now,
  // as the turns start, rather than once the last turn has finished.
  for (const sessionId of new Set(due.map((row) => row.session_id))) {
    announceScheduledMessagesChanged(sessionId);
  }

  // Sessions side by side, since a turn can stay open a long time (see
  // runDispatchPass). A session's rows that were due at `now` go one after
  // another in this pass, each claimed only when the earlier send ends, so
  // none is recorded as sent while it still waits and no poll gap opens
  // between them. A turn the user starts meanwhile is still interrupted, as
  // any scheduled send interrupts the active run.
  // shortcut: a session's next row waits for the whole earlier send, background work included (the runtime ends that hold after 30 idle minutes); interrupt instead if timeliness matters more.
  let sent = 0;
  await Promise.all(due.map(async (first) => {
    const sessionId = first.session_id;
    sessionsSending.add(sessionId);
    try {
      let row: ScheduledMessageRow | null = first;
      while (row) {
        await sendClaimedMessage(row, runtime);
        sent += 1;
        row = scheduledMessagesDb.claimNextDue(sessionId, now);
        if (row) announceScheduledMessagesChanged(sessionId);
      }
    } catch (error) {
      logPassFailure(error);
    } finally {
      sessionsSending.delete(sessionId);
      // A run that settled while this session's sends were going was skipped
      // by the completion notification (isSessionBusy), so the queued turn it
      // unblocked goes now instead of waiting for the next poll.
      requestQueuedMessageDispatch(sessionId);
    }
  }));

  return sent;
}

function logPassFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
}

/**
 * One poll's work. A send waits for its whole turn, and a Claude turn that
 * leaves background work running (a Monitor, say) stays open until that work
 * reports back, so passes must not wait on each other: claims are
 * transactional, and a queued turn skips a session that is still busy.
 *
 * Exported so a test can drive overlapping passes.
 */
export function runDispatchPass(runtime: ProviderRuntimeGateway): Promise<void> {
  return Promise.all([
    // First, so a due send that starts a run at once has registered it before
    // the queued pass checks whether that session is busy.
    dispatchDueScheduledMessages(runtime).catch(logPassFailure),
    dispatchQueuedMessages(runtime).catch(logPassFailure),
  ]).then(() => undefined);
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
    /**
     * Composition-root notification that a session has genuinely settled: no
     * run, no queue, no scheduled priority, no goal or stop transition. The
     * resident host commits a stopped episode only on this signal, so a plain
     * turn completion is never mistaken for "the resident task stopped".
     */
    onSessionSettled?: (sessionId: string) => void;
  } = {},
): void {
  if (pollTimer) {
    return;
  }
  activeRuntime = runtime;
  sessionSettledListener = options.onSessionSettled ?? null;

  const pollScheduled = () => {
    // Passes may overlap: a send that stays open (a turn held for background
    // work) must not stop the next poll from sending another session's newly
    // due rows. Claims are transactional per row and `sessionsSending` keeps a
    // session's own rows from overtaking or interrupting each other.
    void dispatchDueScheduledMessages(runtime).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ScheduledMessages] Scheduled dispatch pass failed', { error: message });
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
  sessionSettledListener = null;
  activeRuntime = null;
  deferredSessionDispatches.clear();
}
