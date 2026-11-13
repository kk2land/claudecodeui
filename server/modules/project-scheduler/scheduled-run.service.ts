import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  projectsDb,
  scheduledTaskSessionsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { resolveDshTranscript } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import {
  AppError,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeProjectPath,
  readObjectRecord,
} from '@/shared/index.js';
import type { SchedulerAgent } from '@/shared/index.js';

/** How long attach waits for a just-spawned CLI to flush its transcript header. */
const TRANSCRIPT_WAIT_MS = 3_000;
const TRANSCRIPT_POLL_MS = 100;

type PreparedRun = {
  sessionId: string;
  projectId: string;
  taskId: string;
  provider: SchedulerAgent['provider'];
  cwd: string;
  sessionsRoot: string;
  executionId: string;
  nativeSessionId: string | null;
  /** This run allocated the app session rather than resuming an existing binding. */
  createdSession: boolean;
  /** The task asked to reuse a native session; only then may a new binding be created. */
  reuseSession: boolean;
  /** Native id and transcript were mapped, so the session is no longer an empty placeholder. */
  attached: boolean;
  run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>;
};

/** Dependencies injected by the module composition root. */
export type ScheduledRunHostDependencies = {
  /** Asks the scheduled-messages dispatcher to try this session's queue now. */
  requestQueueDispatch(sessionId: string): void;
  /** Announces a session delta after prepare/attach/finish changed its state. */
  announceSession?(sessionId: string): void;
};

/** Host-side authority for scheduled prompt CLI runs; consumed by the IPC service. */
export type ScheduledRunHostService = ReturnType<typeof createScheduledRunHostService>;

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`"${key}" is required.`, { code: 'invalid_request', statusCode: 400 });
  }
  return value;
}

function readAgent(payload: Record<string, unknown>): SchedulerAgent {
  const record = readObjectRecord(payload.agent);
  if (!record) {
    throw new AppError('"agent" is required.', { code: 'invalid_request', statusCode: 400 });
  }
  const provider = record.provider;
  if (provider !== 'codex' && provider !== 'dsh') {
    throw new AppError('Only Codex and DSH prompt tasks can own a native session.', {
      code: 'invalid_request',
      statusCode: 400,
    });
  }
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!model) {
    throw new AppError('"agent.model" is required.', { code: 'invalid_request', statusCode: 400 });
  }
  if (record.effort !== undefined && typeof record.effort !== 'string') {
    throw new AppError('"agent.effort" must be a string when present.', {
      code: 'invalid_request',
      statusCode: 400,
    });
  }
  return {
    provider,
    model,
    ...(typeof record.effort === 'string' ? { effort: record.effort } : {}),
  };
}

function readOutcome(payload: Record<string, unknown>): {
  code: number | null;
  success: boolean;
  aborted?: boolean;
  reason?: string;
} {
  const record = readObjectRecord(payload.outcome);
  if (!record || typeof record.success !== 'boolean') {
    throw new AppError('"outcome" with a boolean success is required.', {
      code: 'invalid_request',
      statusCode: 400,
    });
  }
  if (record.code !== null && (typeof record.code !== 'number' || !Number.isFinite(record.code))) {
    throw new AppError('"outcome.code" must be a number or null.', {
      code: 'invalid_request',
      statusCode: 400,
    });
  }
  if (record.aborted !== undefined && typeof record.aborted !== 'boolean') {
    throw new AppError('"outcome.aborted" must be a boolean when present.', {
      code: 'invalid_request',
      statusCode: 400,
    });
  }
  if (record.reason !== undefined && typeof record.reason !== 'string') {
    throw new AppError('"outcome.reason" must be a string when present.', {
      code: 'invalid_request',
      statusCode: 400,
    });
  }
  return {
    code: record.code as number | null,
    success: record.success,
    ...(typeof record.aborted === 'boolean' ? { aborted: record.aborted } : {}),
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
  };
}

function transcriptError(): AppError {
  return new AppError('The native transcript for this run is not readable yet.', {
    code: 'session_unavailable',
    statusCode: 409,
  });
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Verifies that a file is the transcript of this exact Codex thread. Codex keeps the thread id as
 * the rollout filename suffix and repeats it in `session_meta`; this only reads the metadata the
 * provider indexer already uses.
 */
async function isCodexTranscript(nativeSessionId: string, filePath: string): Promise<boolean> {
  if (!path.basename(filePath).endsWith(`-${nativeSessionId}.jsonl`)) return false;
  const meta = await extractFirstValidJsonlData(filePath, (raw) => {
    const record = readObjectRecord(raw);
    if (record?.type !== 'session_meta') return null;
    const payload = readObjectRecord(record.payload);
    return typeof payload?.id === 'string' ? { id: payload.id } : null;
  });
  return meta?.id === nativeSessionId;
}

async function resolveTranscript(input: {
  provider: SchedulerAgent['provider'];
  nativeSessionId: string;
  sessionsRoot: string;
  transcriptPath?: string;
  indexedPath?: string | null;
}): Promise<string> {
  const deadline = Date.now() + TRANSCRIPT_WAIT_MS;
  for (;;) {
    try {
      const root = await realpath(input.sessionsRoot);
      if (input.provider === 'dsh') {
        // The provider helper reuses DSH generation selection and header/decompression checks;
        // this service only decides which directory may be read.
        if (input.transcriptPath) {
          const provided = await realpath(path.resolve(input.transcriptPath));
          if (isInside(root, provided)) {
            const found = await resolveDshTranscript({
              sessionsRoot: input.sessionsRoot,
              nativeSessionId: input.nativeSessionId,
              filePath: provided,
            });
            if (found) return found;
          }
        }
        if (input.indexedPath) {
          const indexed = await realpath(input.indexedPath);
          if (isInside(root, indexed)) {
            const found = await resolveDshTranscript({
              sessionsRoot: input.sessionsRoot,
              nativeSessionId: input.nativeSessionId,
              filePath: indexed,
            });
            if (found) return found;
          }
        }
        const found = await resolveDshTranscript({
          sessionsRoot: input.sessionsRoot,
          nativeSessionId: input.nativeSessionId,
        });
        if (found) return found;
      } else {
        // A reused Codex session is only readable when its indexed rollout is inside this run's
        // effective home; never fall back to another home that happens to carry the same id.
        if (input.indexedPath) {
          const indexed = await realpath(input.indexedPath);
          if (isInside(root, indexed) && await isCodexTranscript(input.nativeSessionId, indexed)) {
            return indexed;
          }
        }
        if (input.transcriptPath) {
          const target = await realpath(path.resolve(input.transcriptPath));
          if (isInside(root, target) && await isCodexTranscript(input.nativeSessionId, target)) {
            return target;
          }
        } else {
          for (const candidate of await findFilesRecursivelyCreatedAfter(root, '.jsonl', null)) {
            if (await isCodexTranscript(input.nativeSessionId, candidate)) {
              return await realpath(candidate);
            }
          }
        }
      }
    } catch {
      // A missing or partially written transcript is retried until the bounded deadline.
    }
    if (Date.now() >= deadline) throw transcriptError();
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_POLL_MS));
  }
}

/**
 * Host authority for scheduled prompt CLI runs.
 *
 * The plugin owns the provider process and the task definitions; this service owns only the
 * session identity, transcript mapping, deletion protection and the real busy slot that must
 * survive until the process is confirmed stopped. It never speaks a provider protocol and never
 * executes a prompt itself.
 */
export function createScheduledRunHostService(dependencies: ScheduledRunHostDependencies) {
  const runs = new Map<string, PreparedRun>();
  /**
   * Last committed task ids per project, learned from `scheduledSyncTasks`. Unknown projects
   * count as committed; only an explicit sync can prove that a task was deleted.
   */
  const committedTasks = new Map<string, Set<string>>();

  function taskIsCommitted(projectId: string, taskId: string): boolean {
    const committed = committedTasks.get(projectId);
    return !committed || committed.has(taskId);
  }

  /** True when the binding's indexed transcript is still inside this run's effective root. */
  async function bindingMatchesRoot(sessionId: string, sessionsRoot: string): Promise<boolean> {
    const indexed = sessionsDb.getSessionById(sessionId);
    if (!indexed?.jsonl_path) return false;
    try {
      const root = await realpath(sessionsRoot);
      const file = await realpath(indexed.jsonl_path);
      return isInside(root, file);
    } catch {
      // A not-yet-created root cannot contain an old transcript; the run starts a new session.
      return false;
    }
  }

  /** Validates that the effective cwd is a real directory inside the committed project. */
  async function resolveTaskDirectory(projectId: string, cwdInput: string): Promise<{
    projectPath: string;
    cwd: string;
  }> {
    const project = projectsDb.getProjectById(projectId);
    if (!project) {
      throw new AppError('The project no longer exists.', {
        code: 'not_found',
        statusCode: 404,
      });
    }
    if (!path.isAbsolute(cwdInput)) {
      throw new AppError('"cwd" must be absolute.', { code: 'invalid_request', statusCode: 400 });
    }
    let projectPath: string;
    let cwd: string;
    try {
      projectPath = await realpath(project.project_path);
      cwd = await realpath(cwdInput);
      if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new AppError('The task cwd is not a readable directory inside its project.', {
        code: 'invalid_request',
        statusCode: 400,
      });
    }
    if (cwd !== projectPath && !cwd.startsWith(`${projectPath}${path.sep}`)) {
      throw new AppError('The task cwd is outside its project.', {
        code: 'invalid_request',
        statusCode: 400,
      });
    }
    return { projectPath, cwd };
  }

  async function prepare(payload: Record<string, unknown>): Promise<{
    sessionId: string;
    executionId: string;
    nativeSessionId: string | null;
  }> {
    const projectId = readString(payload, 'projectId');
    const taskId = readString(payload, 'taskId');
    const runId = readString(payload, 'runId');
    const agent = readAgent(payload);
    const reuseSession = payload.reuseSession;
    if (typeof reuseSession !== 'boolean') {
      throw new AppError('"reuseSession" must be a boolean.', {
        code: 'invalid_request',
        statusCode: 400,
      });
    }
    const sessionsRoot = readString(payload, 'sessionsRoot');
    if (!path.isAbsolute(sessionsRoot)) {
      throw new AppError('"sessionsRoot" must be absolute.', {
        code: 'invalid_request',
        statusCode: 400,
      });
    }
    const identity = await resolveTaskDirectory(projectId, readString(payload, 'cwd'));
    if (runs.has(runId)) {
      throw new AppError('This scheduled run was already prepared.', {
        code: 'active_execution',
        statusCode: 409,
      });
    }

    // Reuse only a compatible, still-indexed binding in this run's effective provider home;
    // older bindings stay protected but are never selected after cwd/provider/home changed.
    let reusable = reuseSession
      ? scheduledTaskSessionsDb.findReusable({
        projectId,
        taskId,
        provider: agent.provider,
        cwd: identity.cwd,
      })
      : null;
    if (reusable && !await bindingMatchesRoot(reusable.sessionId, sessionsRoot)) reusable = null;
    const createdSession = !reusable;
    const sessionId = reusable?.sessionId ?? randomUUID();
    if (createdSession) {
      sessionsDb.createAppSession(sessionId, agent.provider, identity.projectPath, taskId);
    }

    const run = chatRunRegistry.startRun({
      appSessionId: sessionId,
      provider: agent.provider,
      providerSessionId: reusable?.providerSessionId ?? null,
      connection: null,
      userId: null,
      external: true,
      dispatch: {
        // A scheduled CLI run has no socket and is not a foreground/resident turn.
        origin: 'detached',
        permissionMode: null,
        sandboxMode: null,
        model: agent.model,
        effort: agent.effort ?? null,
        runtimeMode: null,
      },
    });
    if (!run) {
      // Only a session created by this call is safe to roll back; a reused session belongs to
      // its earlier binding and run.
      if (createdSession) sessionsDb.deleteSessionById(sessionId);
      throw new AppError('This session already has an active run.', {
        code: 'active_execution',
        statusCode: 409,
      });
    }

    sessionsDb.setSessionModel(sessionId, agent.model);
    if (agent.effort !== undefined) sessionsDb.setSessionEffort(sessionId, agent.effort);
    // Binding waits for a verified native attach: a CLI that fails to start must not leave a
    // permanent empty session behind. Reused bindings already exist and are never rewritten.
    runs.set(runId, {
      sessionId,
      projectId,
      taskId,
      provider: agent.provider,
      cwd: identity.cwd,
      sessionsRoot: normalizeProjectPath(sessionsRoot),
      executionId: run.executionId,
      nativeSessionId: reusable?.providerSessionId ?? null,
      createdSession,
      reuseSession,
      attached: false,
      run,
    });
    return {
      sessionId,
      executionId: run.executionId,
      nativeSessionId: reusable?.providerSessionId ?? null,
    };
  }

  async function attachNative(payload: Record<string, unknown>): Promise<{ sessionId: string }> {
    const runId = readString(payload, 'runId');
    const executionId = readString(payload, 'executionId');
    const nativeSessionId = readString(payload, 'nativeSessionId');
    const transcriptPath = payload.transcriptPath === undefined
      ? undefined
      : readString(payload, 'transcriptPath');
    const entry = runs.get(runId);
    if (!entry || entry.executionId !== executionId) {
      throw new AppError('This scheduled run does not own that execution.', {
        code: 'invalid_request',
        statusCode: 409,
      });
    }
    if (entry.nativeSessionId && entry.nativeSessionId !== nativeSessionId) {
      throw new AppError('A resumed scheduled run reported a different native session.', {
        code: 'invalid_request',
        statusCode: 409,
      });
    }
    const indexed = sessionsDb.getSessionById(entry.sessionId);
    if (!indexed) {
      throw new AppError('The scheduled session no longer exists.', {
        code: 'session_unavailable',
        statusCode: 404,
      });
    }
    const filePath = await resolveTranscript({
      provider: entry.provider,
      nativeSessionId,
      sessionsRoot: entry.sessionsRoot,
      transcriptPath,
      indexedPath: indexed.jsonl_path,
    });

    // Point the app row at the exact native transcript; the watcher may already have indexed a
    // duplicate row for it, which this merge replaces when it is unprotected.
    sessionsDb.repointSessionToProviderSession(entry.sessionId, {
      providerSessionId: nativeSessionId,
      jsonlPath: filePath,
    });
    // From here the session has a real native transcript and must never be rolled back as empty.
    entry.attached = true;
    // A new reuse binding is created only for a verified attach and only while the task is still
    // part of the last committed set, so a task deleted mid-run cannot regain protection.
    if (entry.createdSession && entry.reuseSession && taskIsCommitted(entry.projectId, entry.taskId)) {
      scheduledTaskSessionsDb.insert({
        projectId: entry.projectId,
        taskId: entry.taskId,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
      });
    }
    try {
      // Persists the app-to-native mapping through the existing run writer and updates the
      // registry snapshot used by subscribe/abort bookkeeping.
      entry.run.writer.setSessionId(nativeSessionId);
    } catch (error) {
      console.error('[ProjectScheduler] Failed to record the scheduled native session', {
        runId,
        error: String(error),
      });
    }
    entry.nativeSessionId = nativeSessionId;
    dependencies.announceSession?.(entry.sessionId);
    return { sessionId: entry.sessionId };
  }

  function finishRun(payload: Record<string, unknown>): { finished: boolean } {
    const runId = readString(payload, 'runId');
    const executionId = readString(payload, 'executionId');
    const outcome = readOutcome(payload);
    const entry = runs.get(runId);
    if (!entry || entry.executionId !== executionId) {
      // A duplicate finish, a stale execution, or a host restart that no longer knows the run is
      // already finished: report it without touching any current run.
      return { finished: false };
    }
    // The terminal event derives success from the exit code, so a reported failure with
    // `code: 0` still needs a failing code; an abort stays a non-failing terminal.
    const exitCode = outcome.aborted
      ? outcome.code ?? 0
      : outcome.success
        ? 0
        : outcome.code && outcome.code !== 0 ? outcome.code : 1;
    const finished = chatRunRegistry.completeExternalRun(entry.sessionId, executionId, {
      exitCode,
      aborted: outcome.aborted === true,
    });
    runs.delete(runId);
    if (!finished) return { finished: false };
    // A run that never attached produced only an empty app row. Remove that placeholder; sessions
    // with a native id/transcript (and every existing binding) are left untouched.
    let rolledBack = false;
    if (entry.createdSession && !entry.attached) {
      const placeholder = sessionsDb.getSessionById(entry.sessionId);
      if (placeholder && !placeholder.provider_session_id && !placeholder.jsonl_path) {
        rolledBack = sessionsDb.deleteSessionById(entry.sessionId);
      }
    }
    if (!rolledBack) {
      dependencies.requestQueueDispatch(entry.sessionId);
      dependencies.announceSession?.(entry.sessionId);
    }
    return { finished: true };
  }

  function syncTasks(payload: Record<string, unknown>): { released: number } {
    const projectId = readString(payload, 'projectId');
    const taskIds = payload.taskIds;
    if (!Array.isArray(taskIds) || !taskIds.every((item) => typeof item === 'string' && item.trim())) {
      throw new AppError('"taskIds" must be an array of non-empty strings.', {
        code: 'invalid_request',
        statusCode: 400,
      });
    }
    if (!projectsDb.getProjectById(projectId)) {
      throw new AppError('The project no longer exists.', {
        code: 'not_found',
        statusCode: 404,
      });
    }
    // Only removed task ids lose their bindings. Disabled tasks and tasks that cleared
    // `reuseSession` stay listed and therefore stay protected, and no session row is deleted.
    const released = scheduledTaskSessionsDb.removeMissingTasks(projectId, taskIds);
    committedTasks.set(projectId, new Set(taskIds));
    return { released };
  }

  return {
    /** Shape-validated plugin request dispatch; every error becomes a typed IPC failure. */
    async handleRequest(action: string, payload: Record<string, unknown>): Promise<unknown> {
      switch (action) {
        case 'scheduledPrepare':
          return prepare(payload);
        case 'scheduledAttachNative':
          return attachNative(payload);
        case 'scheduledFinishRun':
          return finishRun(payload);
        case 'scheduledSyncTasks':
          return syncTasks(payload);
        default:
          throw new AppError('Unknown scheduled run action.', {
            code: 'invalid_request',
            statusCode: 400,
          });
      }
    },
  };
}
