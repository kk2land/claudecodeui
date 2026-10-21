import { randomUUID } from 'node:crypto';

import type {
  AnyRecord,
  CodexComposerPredictionReason,
  CodexPredictionConfiguration,
  CodexRpcClient,
  CodexRpcFrame,
} from '@/shared/index.js';
import { AppError } from '@/shared/index.js';

/** Prompt suffix the desktop client appends before its response schema. */
const SCHEMA_INSTRUCTION = 'Return only JSON matching this schema: {"type":"object","properties":{"suggestion":{"type":["string","null"]}},"required":["suggestion"]}';
/** One overall deadline covers the fork, the turn and the answer. */
const DEFAULT_DEADLINE_MS = 30_000;

/** Why one prediction produced no text; the runtime maps these to state. */
type PredictionOutcome =
  | { status: 'ready'; text: string }
  | { status: 'unavailable'; reason: CodexComposerPredictionReason };

/** Cancellation source; `reverse`/`close` are rejections, `deadline` a timeout. */
type CancelReason = 'reverse' | 'deadline' | 'close';

/**
 * One prediction run's mutable lifecycle state.
 *
 * The original fork/turn promises live here, observed via `then`/`catch` for
 * their entire lifetime so a late acknowledgement is still cleaned up after the
 * UI has already settled. Nothing awaits a cleanup on the result path.
 */
class Run {
  private readonly controller = new AbortController();
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly onCallerAbort: () => void;
  private readonly caller: AbortSignal;
  private reason: CancelReason | null = null;
  // Listeners registered by `until` on this run's signal, torn down on dispose.
  private readonly raceListeners = new Set<() => void>();

  // The resources this run may have created; recorded by the promise observers
  // no matter when the RPC finally acknowledges.
  forkThreadId: string | null = null;
  turnId: string | null = null;

  constructor(readonly epoch: number, caller: AbortSignal, deadlineMs: number) {
    this.caller = caller;
    this.onCallerAbort = () => this.controller.abort();
    caller.addEventListener('abort', this.onCallerAbort, { once: true });
    if (caller.aborted) this.controller.abort();
    this.deadline = setTimeout(() => this.cancel('deadline'), Math.max(1, deadlineMs));
    this.deadline.unref?.();
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get cancelled(): boolean { return this.signal.aborted; }
  get cancelledFor(): CancelReason | null { return this.reason; }

  cancel(reason: CancelReason): void {
    if (this.reason) return;
    this.reason = reason;
    this.controller.abort();
  }

  /** Races `promise` against this run's abort signal; the original promise still
   *  settles independently via its observer, so a late ACK is never lost. */
  until<T>(promise: Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(new AppError('Prediction was cancelled.', { code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504 }));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new AppError('Prediction was cancelled.', { code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504 }));
      const clear = () => { this.raceListeners.delete(clear); this.signal.removeEventListener('abort', onAbort); };
      this.raceListeners.add(clear);
      this.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => { clear(); resolve(value); },
        (error) => { clear(); reject(error); },
      );
    });
  }

  /** Tears down the deadline and caller listener without marking a successful
   *  run as cancelled. */
  dispose(): void {
    clearTimeout(this.deadline);
    this.caller.removeEventListener('abort', this.onCallerAbort);
    for (const clear of this.raceListeners) clear();
    this.raceListeners.clear();
  }
}

/**
 * Used by CodexAppServerRuntime to run predictions in ephemeral parent forks.
 *
 * The desktop client does not use a prediction RPC. It forks the parent with
 * `experimentalPredictionMode`, runs an ordinary text turn on that temporary
 * thread with the remotely configured prompt, reads the standard agent-message
 * notifications, and unsubscribes. This executor does the same; nothing it
 * receives may reach the parent conversation.
 */
export class CodexComposerPredictions {
  /** Temporary thread id → its creating epoch; a thread remains owned until its
   *  unsubscribe settles, so late temporary events stay isolated. */
  private readonly temporaryThreads = new Map<string, number>();
  /** Live runs, so reverse requests and close can cancel them. */
  private readonly runs = new Set<Run>();
  /** In-flight interrupts for a given connection/thread/turn, to avoid duplicates. */
  private readonly interrupted = new Set<string>();
  private disposed = false;

  /**
   * @param client The shared app-server connection.
   * @param isLive True while this exact connection may accept RPCs.
   * @param deadlineMs Overall budget for one prediction.
   * @param generation Returns the current connection generation; a run captures
   *   it up front so late cleanup can never address a replacement process.
   */
  constructor(
    private readonly client: CodexRpcClient,
    private readonly isLive: () => boolean = () => true,
    private readonly deadlineMs = DEFAULT_DEADLINE_MS,
    private readonly generation: () => number = () => 0,
  ) {}

  /** True for a thread this executor forked; such a thread never belongs to the user's session. */
  ownsThread(threadId: string | undefined): boolean {
    return Boolean(threadId && this.temporaryThreads.has(threadId));
  }

  /** Ends the prediction running on `threadId` without showing its reverse request. */
  cancelThread(threadId: string): void {
    for (const run of this.runs) if (run.forkThreadId === threadId) run.cancel('reverse');
  }

  async generate(input: {
    parentThreadId: string;
    sourceTurnId: string;
    config: CodexPredictionConfiguration;
    model: string;
    effort: string | null;
    signal: AbortSignal;
  }): Promise<PredictionOutcome> {
    if (this.disposed) return { status: 'unavailable', reason: 'rejected' };
    input.signal.throwIfAborted();

    const run = new Run(this.generation(), input.signal, this.deadlineMs);
    this.runs.add(run);

    let events: { result: Promise<PredictionOutcome>; stop(): void } | null = null;
    try {
      const forkPromise = this.client.request<AnyRecord>('thread/fork', {
        threadId: input.parentThreadId,
        experimentalPredictionMode: true,
        ephemeral: true,
        excludeTurns: true,
        threadSource: 'composer_predictions',
      });
      // The fork promise is observed for its full lifetime: whatever thread it
      // finally names is recorded and, if this run has been cancelled, cleaned
      // up in the background against the same connection generation.
      void forkPromise.then(
        (forked) => {
          const id = typeof forked?.thread?.id === 'string' ? forked.thread.id : null;
          if (!id) return;
          run.forkThreadId = id;
          this.temporaryThreads.set(id, run.epoch);
          if (run.cancelled) this.cleanupCancelled(run);
        },
        () => { /* late rejection is inert; nothing was created */ },
      );

      const forked = await run.until(forkPromise);
      const forkThreadId = typeof forked?.thread?.id === 'string' ? forked.thread.id : null;
      if (!forkThreadId) return { status: 'unavailable', reason: 'failed' };
      run.forkThreadId = forkThreadId;
      this.temporaryThreads.set(forkThreadId, run.epoch);
      if (!this.connectionUsable(run.epoch)) return { status: 'unavailable', reason: 'rejected' };

      // Installed before turn/start so a notification that beats the RPC
      // acknowledgement is still observed for this exact thread.
      events = this.watch(forkThreadId, () => run.turnId,
        (id) => { if (!run.turnId) run.turnId = id; },
        (turnId) => { if (turnId) run.turnId = turnId; void this.interrupt(forkThreadId, turnId, run.epoch); });

      const effort = input.config.predictionReasoningEffort ?? input.effort;
      const turnPromise = this.client.request<AnyRecord>('turn/start', {
        threadId: forkThreadId,
        clientUserMessageId: randomUUID(),
        input: [{ type: 'text', text: `${input.config.prompt}\n\n${SCHEMA_INSTRUCTION}`, text_elements: [] }],
        turnTrigger: 'composer_predictions',
        responsesapiClientMetadata: {
          prediction_source_thread_id: input.parentThreadId,
          prediction_source_turn_id: input.sourceTurnId,
          prediction_trigger: 'live',
        },
        outputSchema: null,
        ...(effort ? { effort } : {}),
      });
      // The turn promise is observed too: a late turn id is recorded and, if the
      // run was cancelled, the turn is interrupted then unsubscribed.
      void turnPromise.then(
        (started) => {
          const id = typeof started?.turn?.id === 'string' ? started.turn.id : null;
          if (id && !run.turnId) run.turnId = id;
          if (run.cancelled) this.cleanupCancelled(run);
        },
        () => { /* late rejection is inert */ },
      );

      // The result races the turn/start acknowledgement and its error: a
      // completed/terminal notification may arrive before the ACK, and it must
      // not wait for that ACK. The ACK's value is validated only to record the
      // turn id; once it resolves, keep waiting for the events result.
      const startResult = turnPromise.then((started) => {
        if (!run.turnId && typeof started?.turn?.id === 'string') run.turnId = started.turn.id;
        if (!run.turnId) throw new Error('turn/start returned no turn id');
        return events!.result;
      });
      return await run.until(Promise.race([events.result, startResult]));
    } catch (error) {
      // A start RPC can fail after turn/started already supplied its id. Stop
      // that known turn even when the transport error preceded our deadline.
      this.cleanupCancelled(run);
      return this.classify(error, run);
    } finally {
      events?.stop();
      this.runs.delete(run);
      if (run.cancelled) {
        this.cleanupCancelled(run);
      } else if (run.forkThreadId) {
        void this.unsubscribe(run.forkThreadId, run.epoch);
      }
      // Tear down the deadline timer and caller listener; a successful run must
      // not be marked cancelled here.
      run.dispose();
    }
  }

  /** Background cleanup for a cancelled/closed run; interrupt and unsubscribe
   *  run independently so a hung interrupt never blocks the unsubscribe. */
  private cleanupCancelled(run: Run): void {
    const threadId = run.forkThreadId;
    if (!threadId) return; // fork never acknowledged; nothing was created.
    const turnId = run.turnId;
    // Fire both, each with its own catch, without awaiting one before the other.
    void this.interrupt(threadId, turnId, run.epoch);
    void this.unsubscribe(threadId, run.epoch);
  }

  /** Unsubscribes every temporary thread on close; background only, no await. */
  async close(): Promise<void> {
    this.disposed = true;
    const runs = [...this.runs];
    for (const run of runs) run.cancel('close');
    this.runs.clear();
    // Each thread carries its own creation epoch; never fall back to the current
    // generation for an old thread id.
    for (const [threadId, epoch] of this.temporaryThreads) {
      void this.unsubscribe(threadId, epoch);
    }
  }

  /** True while this run's exact connection generation is still the live one. */
  private connectionUsable(epoch: number): boolean {
    return this.generation() === epoch && this.isLive();
  }

  private watch(
    threadId: string,
    turnId: () => string | null,
    onTurnId: (id: string) => void,
    onNonTerminalError: (turnId: string | null) => void,
  ) {
    let text = '';
    let settle!: (outcome: PredictionOutcome) => void;
    const result = new Promise<PredictionOutcome>((resolve) => { settle = resolve; });
    let done = false;
    const finish = (outcome: PredictionOutcome) => { if (done) return; done = true; settle(outcome); };
    const unsubscribe = this.client.onNotification((frame: CodexRpcFrame) => {
      if (done) return;
      const p = frame.params ?? {};
      if (p.threadId !== threadId) return;
      const expected = turnId();
      const incoming = typeof p.turnId === 'string' ? p.turnId : typeof p.turn?.id === 'string' ? p.turn.id : null;
      if (expected && incoming && incoming !== expected) return;
      // After the turn id is known, id-less messages cannot be attributed and
      // are ignored rather than polluting the accumulated text.
      if (expected && !incoming && frame.method !== 'turn/completed') return;
      if (frame.method === 'turn/started') {
        if (incoming) onTurnId(incoming);
        return;
      }
      if (frame.method === 'error' && !p.willRetry) {
        if (!expected || !incoming || incoming === expected) {
          onNonTerminalError(incoming ?? expected);
          finish({ status: 'unavailable', reason: 'failed' });
        }
        return;
      }
      if (frame.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
        if (incoming && !expected) onTurnId(incoming);
        text += p.delta;
        return;
      }
      if (frame.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
        text = p.item.text;
        return;
      }
      if (frame.method !== 'turn/completed' || !incoming) return;
      onTurnId(incoming);
      if (p.turn?.status !== 'completed') {
        finish({ status: 'unavailable', reason: 'failed' });
        return;
      }
      finish(parsePrediction(text));
    });
    return { result, stop: () => { done = true; unsubscribe(); } };
  }

  /** Classifies a thrown run error into a stable, non-sensitive reason. */
  private classify(error: unknown, run: Run): PredictionOutcome {
    if (run.cancelledFor === 'reverse' || run.cancelledFor === 'close') return { status: 'unavailable', reason: 'rejected' };
    if (run.cancelledFor === 'deadline' || run.signal.aborted) return { status: 'unavailable', reason: 'timeout' };
    if (error instanceof AppError && error.code === 'CODEX_APP_SERVER_REJECTED') {
      return { status: 'unavailable', reason: 'rejected' };
    }
    if (error instanceof AppError && error.code === 'CODEX_APP_SERVER_TIMEOUT') {
      return { status: 'unavailable', reason: 'timeout' };
    }
    return { status: 'unavailable', reason: 'request_failed' };
  }

  /** Interrupts a prediction turn that may still be running after a cancellation. */
  private async interrupt(threadId: string, turnId: string | null, epoch: number): Promise<void> {
    if (!turnId || !this.connectionUsable(epoch)) return;
    const key = `${epoch}:${threadId}:${turnId}`;
    if (this.interrupted.has(key)) return;
    this.interrupted.add(key);
    try {
      await this.client.request('turn/interrupt', { threadId, turnId });
    } catch {
      // The turn may already be over; unsubscribe is the real cleanup.
    } finally {
      this.interrupted.delete(key);
    }
  }

  private async unsubscribe(threadId: string, epoch: number): Promise<void> {
    if (!this.connectionUsable(epoch)) {
      this.temporaryThreads.delete(threadId);
      return;
    }
    try {
      await this.client.request('thread/unsubscribe', { threadId });
    } catch {
      // A dead connection cannot leak a subscription past process exit.
    } finally {
      this.temporaryThreads.delete(threadId);
    }
  }
}

/** Parses the model's answer strictly: no regex extraction, no fence stripping. */
function parsePrediction(text: string): PredictionOutcome {
  const trimmed = text.trim();
  if (!trimmed) return { status: 'unavailable', reason: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { status: 'unavailable', reason: 'failed' };
  }
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : null;
  if (!record || !('suggestion' in record)) return { status: 'unavailable', reason: 'failed' };
  const suggestion = record.suggestion;
  if (suggestion === null) return { status: 'unavailable', reason: 'empty' };
  if (typeof suggestion !== 'string') return { status: 'unavailable', reason: 'failed' };
  const trimmedSuggestion = suggestion.trim();
  return trimmedSuggestion
    ? { status: 'ready', text: trimmedSuggestion }
    : { status: 'unavailable', reason: 'empty' };
}
