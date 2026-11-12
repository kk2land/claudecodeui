import path from 'node:path';

import {
  projectsDb,
  residentBindingsDb,
  sessionRuntimeDb,
  sessionsDb,
} from '@/modules/database/index.js';
import type { ResidentBindingRecord } from '@/modules/database/index.js';
import { chatRunRegistry, onChatRunCompleted, onChatRunStarted } from '@/modules/websocket/index.js';
import type { ResidentContinueAdmission } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';
import type {
  LLMProvider,
  ProviderRuntimeGateway,
  ResidentBindingView,
  ResidentContinueResult,
  ResidentIpcEvent,
  ResidentStopCause,
  ResidentTerminal,
} from '@/shared/index.js';

/**
 * Dependencies the composition root injects into the resident host.
 *
 * Every cross-module capability arrives as a function or a database import so
 * the host never reaches into another module's internals, and provider
 * adapters never import this module.
 */
export type ResidentHostDependencies = {
  runtime: ProviderRuntimeGateway;
  /** Plugin lifecycle: a disabled plugin cannot be served, but its bindings stay protected. */
  isPluginEnabled(): boolean;
  /** Pushes one contract event to the plugin subprocess; a no-op while it is not running. */
  emitEvent(event: ResidentIpcEvent): void;
  /** Trusted detached-turn entry owned by the websocket module (reuses dispatchRun). */
  continueTurn(input: {
    sessionId: string;
    permissionMode?: string | null;
    model?: string | null;
    effort?: string | null;
  }): ResidentContinueAdmission;
  /** Asks the scheduled-messages dispatcher to try this session's queue now. */
  requestQueueDispatch(sessionId: string): void;
  /** Announces a session delta after it becomes visible again. */
  announceSession(sessionId: string): void;
  /** Removes a hidden session from foreground lists without archiving it. */
  announceSessionRemoved(sessionId: string, projectId: string | null): void;
};

/** The single host-side authority for resident bindings; consumed by the IPC service and bootstrap. */
export type ResidentHostService = ReturnType<typeof createResidentHostService>;

/** Causes whose terminal must alert. Deliberate user actions stay silent. */
function causeAlerts(cause: ResidentStopCause): boolean {
  return cause === 'completed' || cause === 'failed' || cause === 'recovery_failed';
}

function terminalStatus(
  cause: ResidentStopCause,
  hadError: boolean,
): ResidentTerminal['status'] {
  if (cause === 'completed') return hadError ? 'failed' : 'success';
  if (cause === 'failed' || cause === 'recovery_failed') return 'failed';
  return 'stopped';
}

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`"${key}" is required.`, { code: 'invalid_request', statusCode: 400 });
  }
  return value;
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value !== 'boolean') {
    throw new AppError(`"${key}" must be a boolean.`, { code: 'invalid_request', statusCode: 400 });
  }
  return value;
}

/**
 * Creates the resident host: adoption, execution tracking, terminal episodes,
 * stop/continue/remove, restart recovery, and the session projection the UI
 * reads. It owns every write to `resident_bindings`; the plugin only keeps task
 * metadata and a terminal cursor.
 */
export function createResidentHostService(dependencies: ResidentHostDependencies) {
  const { runtime } = dependencies;
  let unsubscribeRunStarted: (() => void) | null = null;
  let unsubscribeRunCompleted: (() => void) | null = null;
  /** Set at shutdown: no terminal may be committed while providers are closing. */
  let suspended = false;
  /** Restart recovery is a bootstrap step for this host instance, never a plugin event. */
  let recovered = false;

  function toView(record: ResidentBindingRecord): ResidentBindingView {
    // The linked session is the title's single source of truth: a sidebar rename
    // must show here on the next projection read. The adoption snapshot stays as
    // the fallback for a session with no usable (or missing) custom name.
    const currentTitle = sessionsDb.getSessionById(record.sessionId)?.custom_name?.trim();
    return {
      taskId: record.taskId,
      name: currentTitle || record.name,
      sessionId: record.sessionId,
      projectId: record.projectId,
      enabled: record.enabled,
      visible: record.visible,
      status: record.status,
      executionId: record.executionId,
      stopCause: record.stopCause,
      runtime: {
        provider: record.provider as ResidentBindingView['runtime']['provider'],
        permissionMode: record.permissionMode,
        sandboxMode: record.sandboxMode,
      },
      terminal: record.terminal,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function requireBinding(taskId: string): ResidentBindingRecord {
    const record = residentBindingsDb.getByTaskId(taskId);
    if (!record) {
      throw new AppError('Unknown resident task.', { code: 'not_found', statusCode: 404 });
    }
    return record;
  }

  function emitChanged(taskIds: string[]): void {
    dependencies.emitEvent({ channel: 'cloudcli-scheduler-resident', kind: 'event', event: 'changed', value: { taskIds } });
  }

  /**
   * Commits one terminal episode. `terminal.id` is stable for the execution, so
   * a repeated delivery cannot create a second run in the plugin. The latest
   * terminal is kept independently of a later admission (only `stop_cause` is
   * cleared then), which is what lets an unread episode still be processed.
   */
  function commitTerminal(
    record: ResidentBindingRecord,
    cause: ResidentStopCause,
    options: {
      reason?: string | null;
      executionId?: string | null;
      /** Provider-reported failure independent of the cause (a completed run can fail). */
      failed?: boolean;
    } = {},
  ): ResidentBindingRecord {
    const executionId = options.executionId ?? record.executionId;
    const run = chatRunRegistry.getSnapshot(record.sessionId);
    const failed = options.failed ?? Boolean(run?.hadError || run?.success === false);
    // A provider that reported an unsuccessful terminal is a failure even when
    // no earlier `error` event arrived; an aborted run stays a silent stop.
    const effectiveCause: ResidentStopCause = cause === 'completed' && failed ? 'failed' : cause;
    const terminal: ResidentTerminal = {
      id: `${record.taskId}:${executionId ?? 'unstarted'}`,
      taskId: record.taskId,
      sessionId: record.sessionId,
      executionId: executionId ?? '',
      status: terminalStatus(effectiveCause, failed),
      cause: effectiveCause,
      alert: causeAlerts(effectiveCause),
      endedAt: new Date().toISOString(),
      reason: options.reason
        ?? (failed
          ? run?.errorText ?? (typeof run?.exitCode === 'number'
            ? `The provider exited with code ${run.exitCode}.`
            : null)
          : null),
      usage: null,
    };
    const updated = residentBindingsDb.update(record.taskId, {
      status: 'stopped',
      stopCause: effectiveCause,
      terminal,
      executionId,
    })!;
    dependencies.emitEvent({
      channel: 'cloudcli-scheduler-resident',
      kind: 'event',
      event: 'terminal',
      value: terminal,
    });
    emitChanged([record.taskId]);
    return updated;
  }

  /**
   * A run was admitted for a bound session. Keep the binding's execution id and
   * dispatch snapshot aligned with the real turn; a new admission clears the
   * stop cause but never the unprocessed latest terminal.
   */
  function trackRunStarted(run: {
    sessionId: string;
    executionId: string;
    dispatch: {
      origin: 'foreground' | 'resident' | 'detached';
      permissionMode: string | null;
      sandboxMode: string | null;
      model: string | null;
      effort: string | null;
      runtimeMode: string | null;
    };
  }): void {
    const record = residentBindingsDb.getBySessionId(run.sessionId);
    if (!record) return;
    // Every real run in the bound session is tracked, whoever asked for it: the
    // user continues the same conversation from the foreground, so a new turn
    // must show as running and be able to recover after a restart. A disabled
    // task still records truth, it just never resumes or alerts on its own.
    residentBindingsDb.update(record.taskId, {
      status: 'running',
      executionId: run.executionId,
      stopCause: null,
      permissionMode: run.dispatch.permissionMode,
      sandboxMode: run.dispatch.sandboxMode,
      model: run.dispatch.model,
      effort: run.dispatch.effort,
      runtime: run.dispatch.runtimeMode,
    });
    emitChanged([record.taskId]);
  }

  /** Whether the session currently has an active provider run the host must not interrupt. */
  function hasActiveRun(sessionId: string, provider: LLMProvider): boolean {
    if (chatRunRegistry.isProcessing(sessionId)) return true;
    const state = provider === 'codex'
      ? runtime.getState?.('codex', sessionId)
      : runtime.getManagedState?.(provider, sessionId);
    // Codex state carries the app-server goal; DSH managed state does not.
    const goalActive = (state as { goal?: { status?: string } } | undefined)?.goal?.status === 'active';
    return Boolean(goalActive || ['starting', 'stopping', 'stopFailed'].includes(state?.phase ?? ''));
  }

  /**
   * Releases the persisted Codex queue hold. `queue_held` is stored per session
   * for both configured runtimes (`app-server` and `sdk`, the existing Codex
   * exec adapter) and is what the queue dispatcher reads, so release it for
   * whichever runtime the session actually uses.
   */
  function releaseCodexQueueHold(sessionId: string): void {
    sessionRuntimeDb.update(sessionId, { queueHeld: false });
  }

  /** Stops a running binding silently; the caller owns whether the cause is user/disabled/deleted. */
  async function stopBinding(
    record: ResidentBindingRecord,
    cause: ResidentStopCause,
  ): Promise<ResidentBindingRecord> {
    // The database can say `stopped` while the user is chatting in the original
    // session; a stop must still reach that real run. Without an actual run (and
    // without an open binding episode) there is nothing to stop.
    const provider = record.provider as LLMProvider;
    if (
      record.status !== 'running'
      && record.status !== 'stopping'
      && !hasActiveRun(record.sessionId, provider)
    ) {
      return record;
    }
    // The cause is persisted before the abort: an abort that completes quickly
    // must never be reported as a natural completion or an error.
    residentBindingsDb.update(record.taskId, { status: 'stopping', stopCause: cause });
    // A deliberate stop must keep holding for the configured Codex runtime, so
    // a pending queue cannot immediately run again while the run winds down.
    if (provider === 'codex') {
      sessionRuntimeDb.update(record.sessionId, { queueHeld: true });
    }
    const stopped = await runtime.abort(provider, record.sessionId).catch(() => false);
    if (!stopped) {
      residentBindingsDb.update(record.taskId, { status: 'running', stopCause: null });
      throw new AppError('The resident run did not confirm its stop.', {
        code: 'stop_failed',
        statusCode: 409,
      });
    }
    chatRunRegistry.completeRun(record.sessionId, { exitCode: 0, aborted: true });
    const current = residentBindingsDb.getByTaskId(record.taskId)!;
    // The terminal complete above already committed this episode through the
    // abort listener; only commit here when it did not (no live registry run).
    if (current.status === 'stopped' && current.terminal?.cause === cause) {
      return current;
    }
    return commitTerminal(current, cause, { failed: false });
  }

  function adopt(payload: Record<string, unknown>): ResidentBindingView {
    const taskId = readString(payload, 'taskId');
    const sessionId = readString(payload, 'sessionId');
    if (residentBindingsDb.getByTaskId(taskId) || residentBindingsDb.getBySessionId(sessionId)) {
      throw new AppError('This session already has a resident task.', {
        code: 'already_resident',
        statusCode: 409,
      });
    }
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError('The session no longer exists.', { code: 'session_unavailable', statusCode: 404 });
    }
    const provider = session.provider as LLMProvider;
    if (provider !== 'codex' && provider !== 'dsh') {
      throw new AppError('Only Codex (app-server or exec) and DSH sessions can be resident.', {
        code: 'unsupported_provider',
        statusCode: 400,
      });
    }
    if (!session.provider_session_id) {
      throw new AppError('The session has no native id yet.', { code: 'session_unavailable', statusCode: 409 });
    }
    if (!hasActiveRun(sessionId, provider)) {
      throw new AppError('Only a running session can become resident.', {
        code: 'not_running',
        statusCode: 409,
      });
    }

    const run = chatRunRegistry.getSnapshot(sessionId);
    const project = session.project_path ? projectsDb.getProjectPath(session.project_path) : null;
    const settings = provider === 'codex' ? sessionRuntimeDb.get(sessionId) : null;
    const record = residentBindingsDb.insert({
      taskId,
      sessionId,
      projectId: project?.project_id ?? '',
      // The original session title is the name; the plugin never invents one.
      name: session.custom_name?.trim()
        || path.basename(session.project_path ?? '') || sessionId,
      provider,
      providerSessionId: session.provider_session_id,
      enabled: true,
      visible: true,
      status: run?.status === 'running' ? 'running' : 'idle',
      executionId: run?.executionId ?? null,
      stopCause: null,
      terminal: null,
      permissionMode: run?.dispatch.permissionMode ?? null,
      sandboxMode: run?.dispatch.sandboxMode ?? null,
      model: run?.dispatch.model ?? session.model,
      effort: run?.dispatch.effort ?? session.effort,
      runtime: run?.dispatch.runtimeMode ?? settings?.runtime ?? null,
    });
    emitChanged([taskId]);
    // Publish the new projection so every sidebar stops offering adoption now.
    dependencies.announceSession(sessionId);
    return toView(record);
  }

  function status(payload: Record<string, unknown>): { bindings: ResidentBindingView[] } {
    const taskId = typeof payload.taskId === 'string' && payload.taskId.trim()
      ? payload.taskId
      : null;
    if (taskId) {
      return { bindings: [toView(requireBinding(taskId))] };
    }
    return { bindings: residentBindingsDb.list().map(toView) };
  }

  async function setEnabled(payload: Record<string, unknown>): Promise<{ binding: ResidentBindingView }> {
    const taskId = readString(payload, 'taskId');
    const enabled = readBoolean(payload, 'enabled');
    let record = requireBinding(taskId);
    if (!enabled) {
      // Disabling a running task stops it silently; the cause is recorded as
      // `disabled`, so the episode never alerts and the binding stays protected.
      if (record.status === 'running' || record.status === 'stopping') {
        await stopBinding(record, 'disabled');
      } else {
        emitChanged([taskId]);
      }
      record = residentBindingsDb.update(taskId, { enabled: false })!;
      return { binding: toView(record) };
    }
    record = residentBindingsDb.update(taskId, { enabled: true })!;
    // Re-enabling a stopped task resumes the original native session exactly
    // once; an active one is reported as-is and never fed a second input.
    if (record.status === 'stopped' || record.status === 'idle') {
      await resume(record);
      record = residentBindingsDb.getByTaskId(taskId)!;
    }
    return { binding: toView(record) };
  }

  function setVisible(payload: Record<string, unknown>): { binding: ResidentBindingView } {
    const taskId = readString(payload, 'taskId');
    const visible = readBoolean(payload, 'visible');
    const record = residentBindingsDb.update(taskId, { visible })!;
    if (visible) {
      // Showing a resident session performs the existing restore operation when
      // its row was archived; visibility itself never borrows isArchived.
      const session = sessionsDb.getSessionById(record.sessionId);
      if (session?.isArchived) {
        sessionsDb.updateSessionIsArchived(record.sessionId, false);
      }
      dependencies.announceSession(record.sessionId);
    } else {
      // The binding hides the row; the sidebar drops it and its counts now,
      // while lookup by id and deletion protection stay untouched.
      dependencies.announceSessionRemoved(record.sessionId, record.projectId || null);
    }
    emitChanged([taskId]);
    return { binding: toView(record) };
  }

  async function stop(payload: Record<string, unknown>): Promise<{ binding: ResidentBindingView }> {
    const record = requireBinding(readString(payload, 'taskId'));
    const stopped = await stopBinding(record, 'user_stopped');
    return { binding: toView(stopped) };
  }

  /** Sends one trusted continue turn in the original native session, then releases the held queue. */
  async function resume(record: ResidentBindingRecord): Promise<ResidentContinueResult> {
    if (!record.enabled) {
      return { accepted: false, executionId: null, reason: 'disabled' };
    }
    if (
      record.status === 'running'
      || record.status === 'stopping'
      || hasActiveRun(record.sessionId, record.provider as LLMProvider)
    ) {
      return { accepted: false, executionId: null, reason: 'already_running' };
    }
    const admission = dependencies.continueTurn({
      sessionId: record.sessionId,
      // Keep the permission/model the binding actually dispatch-recorded; a
      // resume must not silently fall back to provider defaults.
      permissionMode: record.permissionMode,
      model: record.model,
      effort: record.effort,
    });
    if (!admission.accepted) {
      if (admission.reason === 'already_running') {
        return { accepted: false, executionId: null, reason: 'already_running' };
      }
      throw new AppError(admission.error, { code: 'continue_failed', statusCode: 409 });
    }
    // The admission is answered immediately, but the dispatch promise still owns
    // the real outcome. If it never starts, the episode is a failure (and alerts
    // for a recovery); if it started, the settled/abort chain closes it once.
    const executionId = admission.executionId;
    void admission.settled
      .then((result) => {
        if (result.started) return;
        const current = residentBindingsDb.getByTaskId(record.taskId);
        if (!current || current.executionId !== executionId) return;
        commitTerminal(current, 'failed', {
          reason: result.error ?? 'The resident turn could not start.',
          executionId,
        });
      })
      .catch((error: unknown) => {
        const current = residentBindingsDb.getByTaskId(record.taskId);
        if (!current || current.executionId !== executionId) return;
        commitTerminal(current, 'failed', {
          reason: error instanceof Error ? error.message : String(error),
          executionId,
        });
      });
    residentBindingsDb.update(record.taskId, {
      status: 'running',
      executionId: admission.executionId,
      stopCause: null,
    });
    // Admitted first, so a queued turn can never overtake the continue input;
    // the queue keeps its own order behind this run.
    releaseCodexQueueHold(record.sessionId);
    dependencies.requestQueueDispatch(record.sessionId);
    emitChanged([record.taskId]);
    return { accepted: true, executionId: admission.executionId, reason: null };
  }

  async function continueTask(payload: Record<string, unknown>): Promise<{
    result: ResidentContinueResult;
    binding: ResidentBindingView;
  }> {
    const record = requireBinding(readString(payload, 'taskId'));
    const result = await resume(record);
    return { result, binding: toView(residentBindingsDb.getByTaskId(record.taskId)!) };
  }

  async function remove(payload: Record<string, unknown>): Promise<{ removed: true; sessionId: string }> {
    const record = requireBinding(readString(payload, 'taskId'));
    if (
      record.status === 'running'
      || record.status === 'stopping'
      || chatRunRegistry.isProcessing(record.sessionId)
    ) {
      throw new AppError('Stop the resident task before removing it.', {
        code: 'active_execution',
        statusCode: 409,
      });
    }
    residentBindingsDb.remove(record.taskId);
    // The session is kept and becomes an ordinary visible session again.
    dependencies.announceSession(record.sessionId);
    emitChanged([record.taskId]);
    return { removed: true, sessionId: record.sessionId };
  }

  /**
   * Commits a stopped episode once the dispatcher proves the session settled.
   * A still-running run, an owed queued turn, a scheduled priority turn, or an
   * active goal/stop transition keeps the binding open; a plain turn completion
   * is only a candidate.
   */
  function onSessionSettled(sessionId: string): void {
    if (suspended) return;
    const record = residentBindingsDb.getBySessionId(sessionId);
    if (!record) return;
    if (record.status !== 'running' && record.status !== 'stopping') return;
    if (chatRunRegistry.isProcessing(sessionId)) return;
    const run = chatRunRegistry.getSnapshot(sessionId);
    // A foreground stop (chat.abort) is a deliberate user action even though it
    // reaches the host only as a terminal complete: report it silently. A
    // provider terminal that failed (`success: false`, non-zero exit or an
    // error event) is a failure even without a preceding error message.
    const failed = Boolean(run?.hadError || run?.success === false);
    const cause: ResidentStopCause = record.stopCause
      ?? (!record.enabled
        ? 'disabled'
        : run?.aborted
          ? 'user_stopped'
          : failed ? 'failed' : 'completed');
    commitTerminal(record, cause, { failed });
  }

  /**
   * Restarts recovery: only bindings that were running and enabled when the
   * host stopped are resumed, in their original native session. A binding that
   * ended, failed or was stopped/disabled is never revived, and an explicit
   * failure is reported as an alerting terminal instead of a new session.
   */
  async function recoverAfterRestart(): Promise<void> {
    if (recovered) return;
    recovered = true;
    // A persisted `running` row belongs to the previous host process: there is no
    // live registry run for it here. Mark those rows stopped first so the normal
    // continue gate (which refuses an active binding) admits exactly one turn.
    const leftovers = residentBindingsDb.listRunning();
    for (const leftover of leftovers) {
      residentBindingsDb.update(leftover.taskId, { status: 'stopped', stopCause: null });
    }
    // The plugin switch is independent of a task's `enabled`: with the plugin
    // off the host must not drive a continue. Leave the binding (and its
    // protection) alone without a terminal; reopening the plugin only syncs.
    const pluginEnabled = dependencies.isPluginEnabled();
    for (const leftover of leftovers) {
      const record = residentBindingsDb.getByTaskId(leftover.taskId);
      if (!record) continue;
      if (!record.enabled) {
        commitTerminal(record, 'disabled');
        continue;
      }
      if (!pluginEnabled) continue;
      try {
        const result = await resume(record);
        if (result.accepted) continue;
        if (result.reason === 'already_running') {
          // A live run already exists for this session; keep tracking it and do
          // not send a second continue.
          residentBindingsDb.update(record.taskId, { status: 'running' });
          continue;
        }
        commitTerminal(record, 'recovery_failed', { reason: 'Recovery was refused.' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        commitTerminal(record, 'recovery_failed', { reason: message });
      }
    }
  }

  return {
    initialize(): void {
      if (unsubscribeRunStarted) return;
      unsubscribeRunStarted = onChatRunStarted((run) => {
        try {
          trackRunStarted(run);
        } catch (error) {
          console.error('[ProjectScheduler] Failed to track a resident run', { sessionId: run.sessionId, error: String(error) });
        }
      });
      unsubscribeRunCompleted = onChatRunCompleted((sessionId, snapshot) => {
        try {
          if (suspended) return;
          const current = residentBindingsDb.getBySessionId(sessionId);
          if (!current || (current.status !== 'running' && current.status !== 'stopping')) return;
          // An abort confirmed by the provider is a finished episode even when a
          // held queue or a Stop keeps the dispatcher from ever reporting the
          // session settled. A foreground chat.abort lands here too.
          if (snapshot.aborted) {
            commitTerminal(current, current.stopCause ?? 'user_stopped', { failed: false });
            return;
          }
          // The terminal boundary itself says a Codex goal still owns the thread,
          // or a Stop is still in flight: the next native turn will follow, so
          // this completion is a middle turn, not the finished episode. Never
          // clear the hold for this (that would release the saved queue).
          if (snapshot.goalActive || snapshot.stopping) return;
          // A user-held queue is not pending automatic work: the saved entries
          // wait for an explicit resume, so the monitor must stop here instead of
          // staying "running" forever (and being revived by a restart).
          const settings = current.provider === 'codex' ? sessionRuntimeDb.get(sessionId) : null;
          const nativeState = current.provider === 'codex'
            ? runtime.getState?.('codex', sessionId)
            : runtime.getManagedState?.(current.provider as LLMProvider, sessionId);
          const held = Boolean(settings?.queueHeld)
            || Boolean((nativeState as { queueHeld?: boolean } | undefined)?.queueHeld);
          if (!held) return;
          const failed = Boolean(snapshot.hadError || snapshot.success === false);
          commitTerminal(
            current,
            current.stopCause ?? (!current.enabled ? 'disabled' : failed ? 'failed' : 'completed'),
            { failed },
          );
        } catch (error) {
          console.error('[ProjectScheduler] Failed to settle a resident run', { sessionId, error: String(error) });
        }
      });
    },

    async shutdown(): Promise<void> {
      // A shutdown is not a terminal episode: suspend the settle/abort chain and
      // leave `running` rows for the next start's recovery, without committing
      // anything or alerting.
      suspended = true;
      unsubscribeRunStarted?.();
      unsubscribeRunStarted = null;
      unsubscribeRunCompleted?.();
      unsubscribeRunCompleted = null;
    },

    onSessionSettled,
    recoverAfterRestart,

    /** Shape-validated plugin request dispatch; every error becomes a typed IPC failure. */
    async handleRequest(action: string, payload: Record<string, unknown>): Promise<unknown> {
      switch (action) {
        case 'adopt': return { binding: adopt(payload) };
        case 'status': return status(payload);
        case 'setEnabled': return setEnabled(payload);
        case 'setVisible': return setVisible(payload);
        case 'stop': return stop(payload);
        case 'continue': return continueTask(payload);
        case 'remove': return remove(payload);
        default:
          throw new AppError('Unknown resident action.', { code: 'invalid_request', statusCode: 400 });
      }
    },

    /** Snapshot pushed to the plugin on every (re)start: reconcile, never resume. */
    snapshot(): { bindings: ResidentBindingView[] } {
      return { bindings: residentBindingsDb.list().map(toView) };
    },

    isBusy(): boolean {
      return residentBindingsDb.list().some(
        (record) => record.status === 'running' || record.status === 'stopping',
      );
    },

  };
}
