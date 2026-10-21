import { randomUUID } from 'node:crypto';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { sessionRuntimeDb, sessionDraftsDb } from '@/modules/database/index.js';
import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { normalizeAppServerItem } from '@/modules/providers/list/codex/codex-app-server.events.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { appendFilesInputTag, normalizeAttachmentDescriptors, isImageAttachmentDescriptor } from '@/shared/image-attachments.js';
import { AppError, createCompleteMessage, createNormalizedMessage, isCodexGoalEnabled } from '@/shared/index.js';
import type {
  AnyRecord,
  CodexControlAction,
  CodexGoal,
  CodexRpcClient,
  CodexRpcFrame,
  CodexSessionState,
  CodexUserInputRequest,
  IProviderRuntime,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SessionRuntimeSettings,
} from '@/shared/index.js';


type NativeTurn = {
  id: string | null;
  writer: ProviderRuntimeWriter;
  done: Promise<void>;
  finish(): void;
  terminal: boolean;
  items: Map<string, AnyRecord>;
};

type NativeSession = {
  id: string;
  threadId: string | null;
  writer: ProviderRuntimeWriter;
  context: ProviderRuntimeContext;
  options: AnyRecord;
  startedAt: number;
  state: CodexSessionState;
  model: string;
  setup: Promise<void> | null;
  goalMutation: Promise<void> | null;
  turn: NativeTurn | null;
  // Fresh threads have no readable turns until native execution accepts input.
  historyReady: boolean;
  completedTurns: Set<string>;
  children: Set<string>;
  stop: Promise<boolean> | null;
  stopRequested: boolean;
};

type NativeRequest = {
  id: string;
  rpcId: string | number;
  session: NativeSession;
  threadId: string;
  turnId: string;
  kind: 'question' | 'command' | 'file' | 'permissions';
  params: AnyRecord;
  resolve(result: unknown): void;
};

function buildInput(command: string, attachments: unknown): AnyRecord[] {
  const files = normalizeAttachmentDescriptors(attachments);
  const text = appendFilesInputTag(command, files.filter((file) => !isImageAttachmentDescriptor(file)));
  return [
    { type: 'text', text: text.trim() ? text : 'Please analyze the attached file(s).', text_elements: [] },
    ...files.filter(isImageAttachmentDescriptor).map((file) => ({ type: 'localImage', path: file.path })),
  ];
}

/** Provider router uses this native runtime; injectable RPC/settings make lifecycle races testable. */
export class CodexAppServerRuntime implements IProviderRuntime {
  private sessions = new Map<string, NativeSession>();
  private nativeTerminals = new Set<string>();
  private terminalWaiters = new Map<string, () => void>();
  private failures = new Map<string, { state: CodexSessionState; writer: ProviderRuntimeWriter }>();
  private requests = new Map<string, NativeRequest>();
  private controls = new Map<string, Promise<CodexSessionState>>();
  private stopVersions = new Map<string, number>();
  private threadClosures = new Map<string, () => void>();
  private stopExitWaiters = new Set<() => void>();
  private unsubscribe: Array<() => void>;

  constructor(
    private readonly client: CodexRpcClient = codexAppServerTransport,
    private readonly settings: Pick<typeof sessionRuntimeDb, 'get' | 'update'> = sessionRuntimeDb,
    private readonly stopTimeoutMs = 10_000,
    private readonly confirmSteer = (sessionId: string, requestId: string) => sessionDraftsDb.confirmSteer(sessionId, requestId),
    private readonly readStoredMessages = async (sessionId: string): Promise<NormalizedMessage[]> =>
      (await new CodexSessionsProvider().fetchHistory(sessionId)).messages,
  ) {
    this.unsubscribe = [
      client.onNotification((frame) => this.onNotification(frame)),
      client.onRequest((frame) => this.onRequest(frame)),
      client.onExit((error) => {
        const stopped = error instanceof AppError && error.code === 'CODEX_APP_SERVER_STOPPED';
        for (const exited of this.stopExitWaiters) exited();
        for (const closed of this.threadClosures.values()) closed();
        for (const session of this.sessions.values()) {
          if (stopped || session.state.phase !== 'idle' || session.state.goal?.status === 'active') this.settings.update(session.id, { queueHeld: true });
          // Cancel work already awaiting setup/model resolution before process exit.
          if (stopped) this.stopVersions.set(session.id, (this.stopVersions.get(session.id) ?? 0) + 1);
          session.state.error = stopped ? undefined : error.message;
          session.state.phase = stopped ? 'stopping' : 'failed';
          session.stopRequested = true;
          if (stopped) session.state.goal = null;
          if (session.turn && !session.turn.terminal) this.complete(session, stopped ? 'interrupted' : 'failed', stopped ? undefined : error.message);
          this.cancelRequests(session);
          session.state.phase = stopped ? 'idle' : 'failed';
          this.publish(session);
          if (stopped) this.failures.delete(session.id);
          else this.failures.set(session.id, { state: this.getState(session.id), writer: session.writer });
        }
        this.sessions.clear();
      }),
    ];
  }

  getState(sessionId: string): CodexSessionState {
    const session = this.sessions.get(sessionId);
    if (session) return { ...session.state, diagnostics: this.client.status, queueHeld: this.settings.get(sessionId).queueHeld, goal: session.state.goal ? { ...session.state.goal, threadId: session.id } : null, questions: [...session.state.questions] };
    const settings = this.settings.get(sessionId);
    const failure = this.failures.get(sessionId);
    if (failure) return { ...failure.state, ...settings, diagnostics: this.client.status };
    return { ...settings, diagnostics: this.client.status, phase: 'idle', turnId: null, goal: null, questions: [] };
  }

  private publish(session: NativeSession): void {
    session.writer.send(createNormalizedMessage({
      provider: 'codex', sessionId: session.id, kind: 'status', text: 'codex_control', codexState: this.getState(session.id),
    }));
  }

  private assertLiveSession(session: NativeSession): void {
    if (this.sessions.get(session.id) !== session) {
      throw new AppError('Codex app-server session was closed.', { code: 'CODEX_APP_SERVER_SESSION_CLOSED', statusCode: 409 });
    }
  }

  private async ensure(sessionId: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<NativeSession> {
    let session = this.sessions.get(sessionId);
    const providerId = context.resolveProviderSessionId(sessionId);
    if (session && session.threadId && session.threadId !== providerId) {
      if (session.turn && !session.turn.terminal) throw new Error('Cannot replace an active Codex thread.');
      // Editing/forking replaces the mapping, but the old thread may still own tools or a goal.
      if (!await this.abort(sessionId, false)) throw new Error('Stop the previous Codex thread before replacing it.');
      this.sessions.delete(sessionId);
      session = undefined;
    }
    if (session) {
      session.writer = writer;
      session.options = { ...session.options, ...options };
      await session.setup;
      return session;
    }
    session = {
      id: sessionId, threadId: providerId, writer, context, options, startedAt: Date.now(),
      state: { ...this.getState(sessionId), runtime: 'app-server', phase: 'starting', error: undefined }, model: '',
      setup: null, goalMutation: null, turn: null, historyReady: Boolean(providerId), completedTurns: new Set(), children: new Set(), stop: null, stopRequested: Boolean(providerId) && this.settings.get(sessionId).queueHeld,
    };
    this.failures.delete(sessionId);
    this.sessions.set(sessionId, session);
    const target = session;
    this.publish(target);
    target.setup = (async () => {
      target.model = await context.resolveResumeModel(sessionId, options.model) ?? '';
      this.assertLiveSession(target);
      if (target.stopRequested && !providerId) return;
      const permission = this.permissionOptions(options);
      const result = await this.client.request(providerId ? 'thread/resume' : 'thread/start', {
        // Select readable history for new threads; this creation-only setting
        // cannot migrate existing threads. Resume reads their history separately.
        ...(providerId ? { threadId: providerId, excludeTurns: true } : { historyMode: 'legacy' }),
        cwd: options.cwd ?? options.projectPath,
        ...(target.model ? { model: target.model } : {}), ...permission,
      });
      this.assertLiveSession(target);
      if (!result.thread?.id) throw new Error('Codex did not return a thread id.');
      target.threadId = result.thread.id;
      target.model = result.model || result.thread.model || target.model;
      writer.setSessionId?.(target.threadId!);
      if (!providerId) writer.send(createNormalizedMessage({ provider: 'codex', sessionId, kind: 'session_created', newSessionId: target.threadId! }));
      const { goal } = isCodexGoalEnabled()
        ? await this.client.request('thread/goal/get', { threadId: target.threadId })
        : { goal: null };
      this.assertLiveSession(target);
      target.state.goal = goal ?? null;
      if (providerId && goal?.status === 'active') {
        // Restoring a persisted thread after a backend restart must not resume its goal implicitly.
        target.stopRequested = true;
        this.settings.update(sessionId, { queueHeld: true });
      }
      if (target.stopRequested && goal?.status === 'active') {
        const paused = await this.client.request('thread/goal/set', { threadId: target.threadId, status: 'paused' });
        target.state.goal = paused.goal;
      }
      target.state.phase = target.stopRequested ? 'stopping' : 'idle';
      this.publish(target);
    })().catch((error: Error) => {
      if (this.sessions.get(sessionId) === target) {
        target.state.phase = 'failed';
        target.state.error = error.message;
        this.publish(target);
        this.sessions.delete(sessionId);
      }
      throw error;
    });
    await target.setup;
    target.setup = null;
    if (target.stopRequested && target.threadId) await this.abort(sessionId, false);
    if (!target.threadId) this.sessions.delete(sessionId);
    return target;
  }

  private permissionOptions(options: AnyRecord) {
    return {
      sandbox: options.permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write',
      approvalPolicy: options.permissionMode === 'acceptEdits' || options.permissionMode === 'bypassPermissions' ? 'never' : 'on-request',
    };
  }

  private turnPermissions(options: AnyRecord) {
    return {
      approvalPolicy: this.permissionOptions(options).approvalPolicy,
      sandboxPolicy: options.permissionMode === 'bypassPermissions' ? { type: 'dangerFullAccess' } : {
        type: 'workspaceWrite', writableRoots: [options.cwd ?? options.projectPath].filter(Boolean),
        networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
    };
  }

  private collaboration(session: NativeSession) {
    return { mode: session.state.mode, settings: {
      model: session.model,
      reasoning_effort: session.options.effort && session.options.effort !== 'default' ? session.options.effort : null,
      developer_instructions: null,
    } };
  }

  private newTurn(session: NativeSession, writer: ProviderRuntimeWriter, id: string | null): NativeTurn {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const turn: NativeTurn = { id, writer, done, finish, terminal: false, items: new Map() };
    session.turn = turn;
    session.writer = writer;
    session.state.turnId = id;
    session.state.error = undefined;
    session.state.phase = session.stopRequested ? 'stopping' : id ? 'running' : 'starting';
    return turn;
  }

  async run(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<void> {
    const sessionId = options.sessionId ?? randomUUID();
    const stopVersion = this.stopVersions.get(sessionId) ?? 0;
    let session: NativeSession;
    try {
      session = await this.ensure(sessionId, options, writer, context);
    } catch (error) {
      if (stopVersion !== (this.stopVersions.get(sessionId) ?? 0) && error instanceof AppError
        && ['CODEX_APP_SERVER_STOPPED', 'CODEX_APP_SERVER_SESSION_CLOSED'].includes(error.code)) {
        writer.send(createCompleteMessage({ provider: 'codex', sessionId, exitCode: 0, aborted: true }));
        return;
      }
      throw error;
    }
    // Stop may have finished while thread initialization was still pending. Only
    // a new user submission, captured after that Stop, may clear its intent.
    if (stopVersion !== (this.stopVersions.get(sessionId) ?? 0)) {
      writer.send({ ...createCompleteMessage({ provider: 'codex', sessionId, exitCode: 0, aborted: true }), stopping: session.state.phase !== 'idle' });
      return;
    }
    if (session.stopRequested) {
      if (session.state.phase !== 'idle') throw new Error('The previous Codex stop has not been confirmed.');
      session.stopRequested = false;
    }
    if (session.turn && !session.turn.terminal) throw new Error('Codex already has an active turn.');
    if (options.collaborationMode === 'plan' || options.collaborationMode === 'default') {
      session.state.mode = options.collaborationMode;
      this.settings.update(sessionId, { mode: options.collaborationMode });
    }
    session.model = await context.resolveResumeModel(sessionId, options.model) ?? session.model;
    if (stopVersion !== (this.stopVersions.get(sessionId) ?? 0)) {
      writer.send({ ...createCompleteMessage({ provider: 'codex', sessionId, exitCode: 0, aborted: true }), stopping: session.state.phase !== 'idle' });
      return;
    }
    const turn = this.newTurn(session, writer, null);
    this.publish(session);
    try {
      const result = await this.client.request('turn/start', {
        threadId: session.threadId,
        input: buildInput(command, options.attachments ?? [...(options.images ?? []), ...(options.files ?? [])]),
        clientUserMessageId: options.clientMessageId ?? randomUUID(),
        collaborationMode: this.collaboration(session),
        ...this.turnPermissions(options),
      });
      if (!result.turn?.id) throw new Error('Codex did not return a turn id.');
      session.historyReady = true;
      turn.id = result.turn.id;
      if (!turn.terminal) {
        session.state.turnId = turn.id;
        session.state.phase = session.stopRequested ? 'stopping' : 'running';
        this.publish(session);
        if (session.stopRequested) await this.interrupt(session, turn);
      }
      await turn.done;
    } catch (error) {
      if (turn.terminal && error instanceof AppError && error.code === 'CODEX_APP_SERVER_STOPPED') return;
      // An uncertain start must be reconciled instead of opening a duplicate turn.
      if (error instanceof AppError && error.code === 'CODEX_APP_SERVER_TIMEOUT') {
        session.state.phase = 'stopFailed';
        session.state.error = error.message;
        this.publish(session);
        await turn.done;
      } else {
        this.complete(session, 'failed', error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
  }

  private complete(session: NativeSession, status: string, error?: string): void {
    const turn = session.turn;
    if (!turn || turn.terminal) return;
    turn.terminal = true;
    if (turn.id) session.completedTurns.add(turn.id);
    if (session.completedTurns.size > 100) session.completedTurns.delete(session.completedTurns.values().next().value!);
    this.cancelRequests(session, turn.id ?? undefined, session.threadId ?? undefined);
    session.state.turnId = null;
    session.state.phase = session.stopRequested ? 'stopping' : status === 'failed' ? 'failed' : 'idle';
    if (error) {
      session.state.error = error;
      turn.writer.send(createNormalizedMessage({ provider: 'codex', sessionId: session.id, kind: 'error', content: error }));
    }
    this.publish(session);
    turn.writer.send({ ...createCompleteMessage({ provider: 'codex', sessionId: session.id, exitCode: status === 'failed' ? 1 : 0, aborted: status === 'interrupted' }),
      goalActive: session.state.goal?.status === 'active', stopping: session.stopRequested, turnId: turn.id,
      success: status === 'completed' && !['blocked', 'usageLimited', 'budgetLimited'].includes(session.state.goal?.status ?? '') });
    if (!session.stopRequested && session.state.goal?.status !== 'active') {
      const notice = { userId: turn.writer.userId ?? null, provider: 'codex', sessionId: session.options.sessionId ?? session.id, sessionName: session.options.sessionSummary ?? null };
      if (status === 'failed') notifyRunFailed({ ...notice, error: error ?? 'Codex turn failed.' });
      else if (status === 'completed') notifyRunStopped({ ...notice, stopReason: session.state.goal?.status ?? 'completed' });
    }
    turn.finish();
  }

  private onNotification(frame: CodexRpcFrame): void {
    const p = frame.params ?? {};
    if (frame.method === 'thread/closed') this.threadClosures.get(p.threadId)?.();
    if (frame.method === 'turn/completed') {
      const key = `${p.threadId}:${p.turn?.id}`;
      this.nativeTerminals.add(key);
      if (this.nativeTerminals.size > 1000) this.nativeTerminals.delete(this.nativeTerminals.values().next().value!);
      this.terminalWaiters.get(key)?.();
      this.terminalWaiters.delete(key);
    }
    if (frame.method === 'thread/started') {
      const parent = p.thread?.parentThreadId ?? p.thread?.source?.subagent?.thread_spawn?.parent_thread_id;
      const owner = [...this.sessions.values()].find((candidate) => candidate.threadId === parent || candidate.children.has(parent));
      if (owner && p.thread?.id) {
        owner.children.add(p.thread.id);
        if (owner.stopRequested && !owner.stop) void this.abort(owner.id);
      }
      return;
    }
    const session = [...this.sessions.values()].find((candidate) => candidate.threadId === p.threadId || candidate.children.has(p.threadId));
    if (!session) return;
    if (frame.method === 'serverRequest/resolved') {
      for (const request of this.requests.values()) if (request.session === session && request.threadId === p.threadId && request.rpcId === p.requestId) this.cancelRequest(request);
      return;
    }
    // Child interactions belong to this UI session, but child turns and goals
    // must never replace the parent's execution state or complete its writer.
    if (session.threadId !== p.threadId) {
      if (frame.method === 'turn/completed') this.cancelRequests(session, p.turn?.id, p.threadId);
      if (frame.method === 'thread/closed') {
        this.cancelRequests(session, undefined, p.threadId);
        session.children.delete(p.threadId);
      }
      return;
    }
    if (frame.method === 'thread/goal/updated' || frame.method === 'thread/goal/cleared') {
      // A saved goal must not keep a disabled deployment's ordinary chat busy.
      session.state.goal = !isCodexGoalEnabled() || frame.method.endsWith('cleared') ? null : p.goal;
      this.publish(session);
      return;
    }
    const turnId: string | undefined = p.turnId ?? p.turn?.id;
    if (frame.method === 'turn/started') {
      if (!turnId || session.completedTurns.has(turnId)) return;
      if (!session.turn || session.turn.terminal) this.newTurn(session, session.writer.nextTurn?.() ?? session.writer, turnId);
      if (session.turn!.id && session.turn!.id !== turnId) return;
      session.historyReady = true;
      session.turn!.id = turnId;
      session.state.turnId = turnId;
      session.state.phase = session.stopRequested ? 'stopping' : 'running';
      this.publish(session);
      if (session.stopRequested) {
        void this.interrupt(session, session.turn!).then(() => { if (!session.stop) void this.abort(session.id); })
          .catch((error: Error) => { session.state.error = error.message; session.state.phase = 'stopFailed'; this.publish(session); });
      }
      return;
    }
    const turn = session.turn;
    if (!turn || turn.terminal || (turnId && turn.id && turnId !== turn.id)) return;
    if (frame.method === 'turn/completed') { if (!turn.id && turnId) turn.id = turnId; this.complete(session, p.turn.status, p.turn.error?.message); return; }
    if (frame.method === 'error') {
      if (!p.willRetry) turn.writer.send(createNormalizedMessage({ provider: 'codex', sessionId: session.id, kind: 'error', content: p.error?.message ?? 'Codex error' }));
      return;
    }
    if (frame.method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage ?? p.usage;
      if (usage?.total) turn.writer.send(createNormalizedMessage({ provider: 'codex', sessionId: session.id, kind: 'status', text: 'token_budget',
        tokenBudget: { used: usage.total.totalTokens, total: usage.modelContextWindow, inputTokens: usage.total.inputTokens, outputTokens: usage.total.outputTokens } }));
      return;
    }
    if (frame.method === 'turn/plan/updated') {
      turn.writer.send(createNormalizedMessage({ provider: 'codex', sessionId: session.id, id: `codex:${turn.id}:steps`, kind: 'tool_use', toolName: 'TodoWrite', toolId: `codex:${turn.id}:steps`,
        toolInput: { todos: (p.plan ?? []).map((step: AnyRecord) => ({ content: step.step, status: step.status === 'inProgress' ? 'in_progress' : step.status })) } }));
      return;
    }
    let item: AnyRecord | undefined;
    if (frame.method === 'item/started' || frame.method === 'item/completed') {
      item = { ...p.item, completed: frame.method === 'item/completed' };
    } else if (p.itemId && typeof p.delta === 'string') {
      item = { ...turn.items.get(p.itemId), id: p.itemId };
      if (frame.method === 'item/agentMessage/delta' || frame.method === 'item/plan/delta') {
        item.type = frame.method.includes('/plan/') ? 'plan' : 'agentMessage';
        item.text = (item.text ?? '') + p.delta;
      } else if (frame.method === 'item/reasoning/summaryTextDelta' || frame.method === 'item/reasoning/textDelta') {
        item.type = 'reasoning';
        const field = frame.method.includes('summary') ? 'summary' : 'content';
        const index = p.summaryIndex ?? p.contentIndex ?? 0;
        item[field] = [...(item[field] ?? [])];
        item[field][index] = (item[field][index] ?? '') + p.delta;
      } else if (frame.method === 'item/commandExecution/outputDelta') {
        item.type = 'commandExecution';
        item.aggregatedOutput = (item.aggregatedOutput ?? '') + p.delta;
      } else return;
    }
    if (item?.id) {
      if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') for (const child of item.receiverThreadIds ?? []) if (child !== session.threadId) session.children.add(child);
      if (item.type === 'userMessage' && item.clientId) this.confirmSteer(session.id, item.clientId);
      turn.items.set(item.id, item);
      for (const message of normalizeAppServerItem(item, session.id, turn.id ?? turnId ?? 'starting')) turn.writer.send(message);
    }
  }

  private async interrupt(session: NativeSession, turn: NativeTurn): Promise<void> {
    if (!turn.id || turn.terminal) return;
    this.assertLiveSession(session);
    await this.client.request('turn/interrupt', { threadId: session.threadId, turnId: turn.id });
  }

  async abort(sessionId: string, invalidateControls = true): Promise<boolean> {
    if (invalidateControls) this.stopVersions.set(sessionId, (this.stopVersions.get(sessionId) ?? 0) + 1);
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.stop) return session.stop;
    session.stopRequested = true;
    session.state.phase = 'stopping';
    this.settings.update(sessionId, { queueHeld: true });
    this.publish(session);
    session.stop = (async () => {
      const deadline = Date.now() + this.stopTimeoutMs;
      // Process exit settles parent/child waits and invalidates their remaining cleanup RPCs.
      let processExited = false;
      let onExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        onExit = () => { processExited = true; resolve(); };
      });
      this.stopExitWaiters.add(onExit);
      const exitError = new AppError('Codex app-server session was closed.', { code: 'CODEX_APP_SERVER_SESSION_CLOSED', statusCode: 409 });
      const bounded = async <T>(promise: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([promise, exited.then(() => { throw exitError; }), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Codex has not confirmed the stop. Retry to check its state.')), Math.max(1, deadline - Date.now()));
          })]);
          if (processExited) throw exitError;
          return result;
        } finally { clearTimeout(timer); }
      };
      const request = (method: string, params: AnyRecord): Promise<AnyRecord> => {
        // Check before creating the promise: request() can lazily spawn a process.
        this.assertLiveSession(session);
        return bounded(this.client.request(method, params));
      };
      try {
        await bounded(session.setup ?? Promise.resolve());
        // A goal/set already sent may activate a turn after Stop. Let it settle, then pause it.
        await bounded(session.goalMutation?.catch(() => {}) ?? Promise.resolve());
        let pauseError: unknown;
        if (session.threadId && session.state.goal && !['paused', 'complete'].includes(session.state.goal.status)) {
          try {
            const result = await request('thread/goal/set', { threadId: session.threadId, status: 'paused' });
            session.state.goal = result.goal;
          } catch (error) { pauseError = error; }
        }
        // Retrying an uncertain turn/start recovers its id before interrupting it.
        if (session.threadId && session.turn && !session.turn.id && !session.setup) {
          const result = await request('thread/read', { threadId: session.threadId, includeTurns: true });
          const active = result.thread?.turns?.find((turn: AnyRecord) => turn.status === 'inProgress');
          if (active) session.turn.id = active.id;
        }
        do {
          while (session.turn && !session.turn.terminal) {
            const turn = session.turn;
            try { await bounded(this.interrupt(session, turn)); }
            catch (error) { if (!turn.terminal) throw error; }
            await bounded(turn.done);
          }
          if (pauseError) throw pauseError;
          // Subagents own native turns too. Interrupt only this thread's descendants.
          const cleaned = new Set<string>();
          while ([...session.children].some((id) => !cleaned.has(id))) {
            for (const childId of session.children) {
              if (cleaned.has(childId)) continue;
              const { thread } = await request('thread/read', { threadId: childId, includeTurns: true });
              if (isCodexGoalEnabled() && !thread?.ephemeral) {
                const { goal } = await request('thread/goal/get', { threadId: childId });
                if (goal?.status === 'active') await request('thread/goal/set', { threadId: childId, status: 'paused' });
              }
              const childTurn = thread?.turns?.find((entry: AnyRecord) => entry.status === 'inProgress');
              if (childTurn) {
                const key = `${childId}:${childTurn.id}`;
                const done = new Promise<void>((resolve) => { this.terminalWaiters.set(key, resolve); });
                try {
                  if (!this.nativeTerminals.has(key)) {
                    await request('turn/interrupt', { threadId: childId, turnId: childTurn.id });
                    if (!this.nativeTerminals.has(key)) await bounded(done);
                  }
                } finally { this.terminalWaiters.delete(key); }
              }
              await request('thread/backgroundTerminals/clean', { threadId: childId });
              cleaned.add(childId);
            }
          }
          if (session.threadId) await request('thread/backgroundTerminals/clean', { threadId: session.threadId });
        } while (session.turn && !session.turn.terminal);
        this.cancelRequests(session);
        session.state.phase = 'idle';
        session.state.error = undefined;
        this.publish(session);
        return true;
      } catch (error) {
        // Exit already published the terminal state. Old stops must not overwrite a replacement session.
        if (processExited) return true;
        session.state.phase = 'stopFailed';
        session.state.error = error instanceof Error ? error.message : String(error);
        this.publish(session);
        return false;
      } finally {
        this.stopExitWaiters.delete(onExit);
        session.stop = null;
      }
    })();
    return session.stop;
  }

  async control(sessionId: string, action: CodexControlAction, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<CodexSessionState> {
    if (action.action !== 'goal' && action.action !== 'mode') return this.applyControl(sessionId, action, options, writer, context);
    const version = this.stopVersions.get(sessionId) ?? 0;
    const previous = this.controls.get(sessionId);
    const operation = (async () => {
      await previous?.catch(() => {});
      if (version !== (this.stopVersions.get(sessionId) ?? 0) && (action.action === 'mode' || ['set', 'resume'].includes(action.operation))) {
        throw new Error('This control was cancelled by Stop.');
      }
      return this.applyControl(sessionId, action, options, writer, context, version);
    })();
    this.controls.set(sessionId, operation);
    try { return await operation; }
    finally { if (this.controls.get(sessionId) === operation) this.controls.delete(sessionId); }
  }

  private async restoreHistory(session: NativeSession): Promise<void> {
    // session_created refreshes can race the first turn/start. Defer the RPC
    // itself until its acknowledgement or a native auto-turn proves readiness.
    if (!session.historyReady) return;
    let thread: AnyRecord | undefined;
    try {
      ({ thread } = await this.client.request('thread/read', { threadId: session.threadId, includeTurns: true }));
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'CODEX_APP_SERVER_REJECTED') throw error;
      // Resumed threads may still be empty, and persistence can lag the first
      // turn acknowledgement. Do not confirm receipts or alter the pending
      // turn; later refreshes must still retry native history.
      if (error.message.includes('is not materialized yet; includeTurns is unavailable before first user message')) return;
      // Opening/reconnecting restores receipts, not active-turn state. Only this
      // known history limitation can use the same persisted rows as the UI;
      // Stop still requires native confirmation and other RPC errors propagate.
      if (!error.message.includes('list_turns is not supported yet')) throw error;
      for (const message of await this.readStoredMessages(session.id)) {
        if (message.role === 'user' && typeof message.clientMessageId === 'string' && message.clientMessageId) {
          this.confirmSteer(session.id, message.clientMessageId);
        }
        if (message.subagent?.id && message.subagent.id !== session.threadId) session.children.add(message.subagent.id);
      }
      return;
    }
    for (const turn of thread?.turns ?? []) for (const item of turn.items ?? []) {
      if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
        for (const child of item.receiverThreadIds ?? []) if (child !== session.threadId) session.children.add(child);
      }
      if (item.type === 'userMessage' && item.clientId) this.confirmSteer(session.id, item.clientId);
    }
  }

  private async applyControl(sessionId: string, action: CodexControlAction, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext, stopVersion?: number): Promise<CodexSessionState> {
    if (action.action === 'state') return this.getState(sessionId);
    // Keep read/pause/clear available for reconciling goals saved before disablement.
    if (action.action === 'goal' && ['set', 'resume'].includes(action.operation) && !isCodexGoalEnabled()) {
      throw new AppError('Codex Goals are disabled. Set CLOUDCLI_CODEX_GOAL_ENABLED=true to enable them.', {
        code: 'CODEX_GOAL_DISABLED', statusCode: 403,
      });
    }
    if (action.action === 'runtime' || action.action === 'stop-app-server') throw new Error('Process and runtime controls belong to the provider router.');
    if (action.action === 'steer') {
      const session = this.sessions.get(sessionId);
      if (!session || session.stopRequested || !session.turn || session.turn.terminal || session.turn.id !== action.expectedTurnId) {
        throw new AppError('The target turn ended or is stopping. Your message is still queued.', { code: 'STALE_TURN', statusCode: 409 });
      }
      await this.client.request('turn/steer', { threadId: session.threadId, expectedTurnId: action.expectedTurnId,
        clientUserMessageId: action.requestId, input: buildInput(action.content, action.attachments) });
      // Steer acceptance can precede its native userMessage item by an entire model call.
      for (const message of normalizeAppServerItem({ type: 'userMessage', id: action.requestId, clientId: action.requestId, content: buildInput(action.content, action.attachments) }, sessionId, action.expectedTurnId)) session.writer.send(message);
      return this.getState(sessionId);
    }
    if (action.action === 'answer') {
      const request = this.requests.get(action.requestId);
      if (!request || request.session.id !== sessionId || request.kind !== 'question') throw new AppError('This question has already been resolved.', { code: 'STALE_QUESTION', statusCode: 409 });
      const questions = request.params.questions as CodexUserInputRequest['questions'];
      for (const question of questions) {
        const answer = action.answers[question.id];
        if (!answer || !Array.isArray(answer.answers) || !answer.answers.every((value) => typeof value === 'string') || !answer.answers.length) {
          throw new AppError('Please answer every question.', { code: 'INVALID_ANSWERS', statusCode: 400 });
        }
      }
      this.resolveRequest(request, { answers: Object.fromEntries(questions.map((q) => [q.id, action.answers[q.id]])) });
      return this.getState(sessionId);
    }
    if (action.action === 'mode') {
      const existing = this.sessions.get(sessionId);
      if (action.mode === 'plan' && existing?.state.goal?.status === 'active') {
        if (!await this.abort(sessionId)) throw new Error('Could not pause the current goal.');
      }
      this.settings.update(sessionId, { mode: action.mode });
      if (existing) { existing.state.mode = action.mode; this.publish(existing); }
      return this.getState(sessionId);
    }
    if (action.operation === 'get' && !context.resolveProviderSessionId(sessionId) && !this.sessions.has(sessionId)) return this.getState(sessionId);
    const session = await this.ensure(sessionId, options, writer, context);
    this.assertLiveSession(session);
    if (action.operation === 'get') {
      const { goal } = isCodexGoalEnabled()
        ? await this.client.request('thread/goal/get', { threadId: session.threadId })
        : { goal: null };
      this.assertLiveSession(session);
      session.state.goal = goal ?? null;
      await this.restoreHistory(session);
    } else if (action.operation === 'pause' || action.operation === 'clear') {
      if (!await this.abort(sessionId)) throw new Error(session.state.error ?? 'Could not stop Codex.');
      if (action.operation === 'clear') {
        await this.client.request('thread/goal/clear', { threadId: session.threadId });
        session.state.goal = null;
      }
    } else {
      if (stopVersion !== (this.stopVersions.get(sessionId) ?? 0)) throw new Error('This control was cancelled by Stop.');
      if (session.stop || ['stopping', 'stopFailed'].includes(session.state.phase)) throw new Error('Wait for Codex to confirm it has stopped.');
      if (action.operation === 'set' && (!action.objective?.trim() || action.objective.length > 4000)) throw new Error('A goal must contain 1–4000 characters.');
      if (action.tokenBudget !== undefined && (!Number.isSafeInteger(action.tokenBudget) || action.tokenBudget <= 0)) throw new Error('Token budget must be a positive integer.');
      if (action.operation === 'resume' && (!session.state.goal || session.state.goal.status === 'complete')) throw new Error('There is no unfinished goal to resume.');
      if (action.operation === 'resume' && session.state.mode === 'plan') throw new Error('Switch to execution mode before resuming the goal.');
      const nextBudget = action.tokenBudget ?? session.state.goal?.tokenBudget;
      if (action.operation === 'resume' && nextBudget != null && nextBudget <= (session.state.goal?.tokensUsed ?? 0)) throw new Error('Increase the goal budget before resuming.');
      session.stopRequested = false;
      if (!session.turn || session.turn.terminal) session.state.phase = 'starting';
      this.publish(session);
      session.goalMutation = (async () => {
        session.model = await context.resolveResumeModel(sessionId, options.model) ?? session.model;
        if (session.stopRequested) throw new Error('This goal action was cancelled by Stop.');
        await this.client.request('thread/settings/update', { threadId: session.threadId,
          collaborationMode: this.collaboration(session), ...this.turnPermissions(session.options) });
        if (session.stopRequested) throw new Error('This goal action was cancelled by Stop.');
        const result = await this.client.request('thread/goal/set', {
          threadId: session.threadId,
          ...(action.operation === 'set' ? { objective: action.objective } : {}),
          status: session.state.mode === 'plan' ? 'paused' : 'active',
          ...(action.tokenBudget !== undefined ? { tokenBudget: action.tokenBudget } : {}),
        });
        session.state.goal = result.goal;
      })();
      try { await session.goalMutation; }
      finally {
        session.goalMutation = null;
        if (session.state.phase === 'starting' && (!session.turn || session.turn.terminal)) session.state.phase = 'idle';
        this.publish(session);
      }
    }
    this.publish(session);
    return this.getState(sessionId);
  }

  private onRequest(frame: CodexRpcFrame): Promise<unknown> {
    const p = frame.params ?? {};
    const session = [...this.sessions.values()].find((candidate) => candidate.threadId === p.threadId || candidate.children.has(p.threadId));
    const kind = frame.method === 'item/tool/requestUserInput' ? 'question'
      : frame.method === 'item/commandExecution/requestApproval' ? 'command'
        : frame.method === 'item/fileChange/requestApproval' ? 'file'
          : frame.method === 'item/permissions/requestApproval' ? 'permissions' : null;
    if (!kind) return Promise.reject(new Error(`Unsupported Codex request: ${frame.method}`));
    if (!session || session.stopRequested || (session.threadId === p.threadId && (session.turn?.terminal || (session.turn?.id && session.turn.id !== p.turnId)))) {
      return Promise.resolve(kind === 'question' ? { answers: {} } : kind === 'permissions' ? { permissions: {}, scope: 'turn' } : { decision: 'cancel' });
    }
    const id = `codex:${randomUUID()}`;
    return new Promise((resolve) => {
      const request: NativeRequest = { id, rpcId: frame.id!, session, threadId: p.threadId, turnId: p.turnId, kind, params: p, resolve };
      this.requests.set(id, request);
      if (kind === 'question') {
        session.state.questions.push({ requestId: id, turnId: p.turnId, isBlocking: p.isBlocking !== false, questions: p.questions });
        this.publish(session);
      } else {
        session.writer.send(createNormalizedMessage({ provider: 'codex', sessionId: session.id, kind: 'permission_request', requestId: id,
          toolName: kind === 'command' ? 'Bash' : kind === 'file' ? 'FileChange' : 'Permissions', input: p,
          context: { provider: 'codex', availableDecisions: p.availableDecisions ?? ['accept', 'decline', 'cancel'] } }));
      }
    });
  }

  private resolveRequest(request: NativeRequest, response: unknown): void {
    if (!this.requests.delete(request.id)) return;
    request.session.state.questions = request.session.state.questions.filter((q) => q.requestId !== request.id);
    request.resolve(response);
    if (request.kind === 'question') this.publish(request.session);
    else request.session.writer.send(createNormalizedMessage({ provider: 'codex', sessionId: request.session.id, kind: 'permission_resolved', requestId: request.id }));
  }

  private cancelRequest(request: NativeRequest): void {
    this.resolveRequest(request, request.kind === 'question' ? { answers: {} } : request.kind === 'permissions' ? { permissions: {}, scope: 'turn' } : { decision: 'cancel' });
  }

  private cancelRequests(session: NativeSession, turnId?: string, threadId?: string): void {
    for (const request of this.requests.values()) if (request.session === session && (!turnId || request.turnId === turnId) && (!threadId || request.threadId === threadId)) {
      this.cancelRequest(request);
    }
  }

  readonly permissions = {
    resolve: (requestId: string, decision: ProviderPermissionDecision) => {
      const request = this.requests.get(requestId);
      if (!request || request.kind === 'question') return;
      if (request.kind === 'permissions') {
        this.resolveRequest(request, { permissions: decision.allow ? request.params.permissions : {}, scope: 'turn' });
        return;
      }
      const nativeDecision = decision.nativeDecision ?? (decision.allow ? 'accept' : 'decline');
      const allowed: unknown[] = request.params.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'];
      // Never broaden an "allow once" into a session-wide or saved policy approval.
      if (!allowed.includes(nativeDecision)) return;
      this.resolveRequest(request, { decision: nativeDecision });
    },
    listPending: (sessionId: string) => [...this.requests.values()].filter((r) => r.session.id === sessionId && r.kind !== 'question')
      .map((r) => ({ requestId: r.id, provider: 'codex', toolName: r.kind === 'command' ? 'Bash' : r.kind === 'file' ? 'FileChange' : 'Permissions', input: r.params, context: { provider: 'codex', availableDecisions: r.params.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'] } })),
  };

  /** Session status polling must include native goal gaps and uncertain stopping states. */
  listActiveSessions() {
    return [...this.sessions.values()]
      .filter((session) => session.state.goal?.status === 'active' || ['starting', 'running', 'stopping', 'stopFailed'].includes(session.state.phase))
      .map((session) => ({ sessionId: session.id, startedAt: session.startedAt, statusText: session.state.phase === 'stopFailed' ? 'Stop not confirmed' : session.state.phase === 'stopping' ? 'Stopping…' : undefined }));
  }

  /** The router checks session activity before switching runtimes. */
  isBusy(sessionId?: string): boolean {
    return [...this.sessions.values()].some((s) => (!sessionId || s.id === sessionId) && Boolean(s.setup || s.stop || s.goalMutation || ['stopping', 'stopFailed'].includes(s.state.phase) || (s.turn && !s.turn.terminal) || s.state.goal?.status === 'active'))
      || [...this.requests.values()].some((request) => !sessionId || request.session.id === sessionId)
      || (sessionId ? this.controls.has(sessionId) : this.controls.size > 0);
  }

  /** The router releases the native writer/cache before allowing the SDK to append to its rollout. */
  async releaseSession(sessionId: string, providerThreadId: string | null): Promise<void> {
    if (this.isBusy(sessionId)) throw new Error('Stop this session before changing its runtime.');
    const session = this.sessions.get(sessionId);
    const threadId = session?.threadId ?? providerThreadId;
    const queueHeld = this.settings.get(sessionId).queueHeld;
    const stopVersion = this.stopVersions.get(sessionId) ?? 0;
    if (session && !await this.abort(sessionId, false)) throw new Error('Could not stop the previous Codex runtime.');
    if (!threadId) return;
    if (session) this.assertLiveSession(session);
    if (session) { session.state.phase = 'stopping'; this.publish(session); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>((resolve, reject) => {
      this.threadClosures.set(threadId, resolve);
      timer = setTimeout(() => reject(new Error('Codex has not confirmed that the thread was unloaded. Retry changing its runtime.')), this.stopTimeoutMs);
    });
    try {
      // Unsubscribe acknowledges detachment before shutdown finishes. Wait for
      // thread/closed too, so a quick SDK round trip cannot reuse stale history.
      await Promise.all([closed, this.client.request('thread/unsubscribe', { threadId }).then((result) => {
        if (result.status === 'notLoaded') this.threadClosures.get(threadId)?.();
        else if (!['unsubscribed', 'notSubscribed'].includes(result.status)) throw new Error('Codex did not confirm thread unsubscription.');
      })]);
    } finally {
      clearTimeout(timer);
      this.threadClosures.delete(threadId);
      // Even an uncertain unsubscribe must force a fresh resume on the next use.
      if (session) this.cancelRequests(session);
      this.sessions.delete(sessionId);
      this.failures.delete(sessionId);
      if (stopVersion === (this.stopVersions.get(sessionId) ?? 0)) this.settings.update(sessionId, { queueHeld });
    }
  }

  async close(): Promise<void> {
    if (this.client === codexAppServerTransport) {
      await Promise.all(this.listActiveSessions().map(({ sessionId }) => this.abort(sessionId)));
      await codexAppServerTransport.close();
    }
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe = [];
  }
}

/** Codex's provider router and fork client share the same process and event subscription. */
export const codexAppServerRuntime = new CodexAppServerRuntime();
