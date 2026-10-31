import { randomUUID } from 'node:crypto';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { sessionRuntimeDb, sessionDraftsDb } from '@/modules/database/index.js';
import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { normalizeAppServerItem } from '@/modules/providers/list/codex/codex-app-server.events.js';
import { CodexComposerPredictions } from '@/modules/providers/list/codex/codex-composer-predictions.provider.js';
import { CodexPredictionConfigProvider } from '@/modules/providers/list/codex/codex-prediction-config.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { codexModelProviderService } from '@/modules/providers/list/codex/codex-model-provider.service.js';
import { appendFilesInputTag, normalizeAttachmentDescriptors, isImageAttachmentDescriptor } from '@/shared/image-attachments.js';
import { AppError, createCompleteMessage, createNormalizedMessage, isCodexGoalEnabled } from '@/shared/index.js';
import type {
  AnyRecord,
  CodexComposerPredictionReason,
  CodexControlAction,
  CodexGoal,
  CodexModelSelection,
  CodexRpcClient,
  CodexRpcFrame,
  CodexSessionState,
  CodexUserInputRequest,
  CodexWorkerBridge,
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
  /**
   * The in-flight `turn/start` RPC only, present until its ack or rejection.
   * Stop awaits it to distinguish "not acknowledged yet" from "result unknown";
   * it must never hold the longer `turn.done` wait of the whole run.
   */
  starting?: Promise<AnyRecord> | null;
  done: Promise<void>;
  finish(): void;
  terminal: boolean;
  items: Map<string, AnyRecord>;
  /** This run's chat.send opted into a native composer prediction for its turn. */
  composerPredictions: boolean;
  /**
   * The input this adapter submitted for the turn, and the ID sent with it.
   * Native user items may arrive without `clientId`; correlation uses this
   * record so the first input keeps the composer's identity. Absent for turns
   * this adapter did not submit (autonomous goal continuations), which must
   * never inherit an ID.
   */
  submittedInput?: NativeSubmittedInput;
};

type NativeSubmittedInput = {
  clientId: string;
  input: AnyRecord[];
  /** Native item that already claimed this submission; later items cannot. */
  boundItemId?: string;
};

/**
 * The single outstanding composer-prediction request of a live session.
 *
 * `threadId` and `sourceTurnId` are the request identity; `controller` aborts
 * the ephemeral fork/turn when the parent turn is replaced, stopped or closed.
 * Every asynchronous continuation re-checks this exact object, so a late fork
 * acknowledgement or result can never overwrite a newer turn's state.
 */
type NativePredictionRequest = {
  threadId: string;
  sourceTurnId: string;
  controller: AbortController;
  /** Overrides every invalidation point so a replaced request's timer dies. */
  timer?: ReturnType<typeof setTimeout>;
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
  /** Native model provider reported by start/resume; null when a CLI omits it. */
  modelProvider: string | null;
  setup: Promise<void> | null;
  goalMutation: Promise<void> | null;
  turn: NativeTurn | null;
  /** Outstanding composer-prediction request; cleared by every invalidation point. */
  prediction: NativePredictionRequest | null;
  // Fresh threads have no readable turns until native execution accepts input.
  historyReady: boolean;
  completedTurns: Set<string>;
  children: Set<string>;
  stop: Promise<boolean> | null;
  stopRequested: boolean;
};

/**
 * Whether a CLI build advertises the stable prediction fork protocol.
 *
 * The fork fields shipped in public 0.163.0; the desktop's internal alpha
 * threshold is intentionally not reused because it is not a public guarantee.
 * Prerelease and unknown identities stay unsupported rather than risk a fork
 * that silently ignores `experimentalPredictionMode`.
 */
function supportsComposerPredictions(version: string | null): boolean {
  if (!version) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major !== 0) return major > 0;
  return minor > 163 || (minor === 163 && patch >= 0);
}

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

/**
 * Whether a native user item describes the input this adapter submitted.
 *
 * Only semantics are compared: ordered part types and their text or path.
 * Native items carry extra metadata (`text_elements`, timestamps) that must not
 * prevent correlation, and the submitted text is compared untrimmed because
 * that is exactly what `turn/start` received. Anything unrecognized fails the
 * comparison rather than risking an unrelated item being bound to this send.
 */
function matchesSubmittedInput(nativeContent: unknown, submittedInput: AnyRecord[]): boolean {
  if (!Array.isArray(nativeContent) || nativeContent.length !== submittedInput.length) return false;
  return nativeContent.every((part: AnyRecord, index) => {
    const expected = submittedInput[index];
    if (!part || part.type !== expected.type) return false;
    if (part.type === 'text') return part.text === expected.text;
    if (part.type === 'localImage') return part.path === expected.path;
    return false;
  });
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
  private readonly configProvider: Pick<CodexPredictionConfigProvider, 'load'>;
  private readonly predictions: CodexComposerPredictions;
  private readonly providerEligible: (provider: string | null) => boolean;
  private readonly random: () => number;
  private readonly readCliVersion: () => string | null;
  private readonly modelProviders: Pick<typeof codexModelProviderService, 'list' | 'models'>;
  // Incremented on every app-server exit and turned invalid by close(). A
  // prediction run captures it up front so its cleanup can never address a
  // replacement process with the old thread ids.
  private connectionEpoch = 1;
  // Injected by the server composition root; providers must not import workers.
  private workerBridge: CodexWorkerBridge | null = null;
  private readonly fallbackInstanceId = randomUUID();

  constructor(
    private readonly client: CodexRpcClient = codexAppServerTransport,
    private readonly settings: Pick<typeof sessionRuntimeDb, 'get' | 'update'> = sessionRuntimeDb,
    private readonly stopTimeoutMs = 10_000,
    private readonly confirmSteer = (sessionId: string, requestId: string) => sessionDraftsDb.confirmSteer(sessionId, requestId),
    private readonly readStoredMessages = async (sessionId: string): Promise<NormalizedMessage[]> =>
      (await new CodexSessionsProvider().fetchHistory(sessionId)).messages,
    // Bounds how long a native prediction may stay pending; tests inject a
    // short value instead of waiting out the production deadline.
    private readonly predictionTimeoutMs = 30_000,
    // Prediction dependencies are injectable so tests never read real
    // credentials or wait out the network. Production uses the defaults.
    options: {
      configProvider?: Pick<CodexPredictionConfigProvider, 'load'>;
      predictions?: CodexComposerPredictions;
      /** Test-only provider gate; production accepts only Codex's own provider. */
      providerEligible?: (provider: string | null) => boolean;
      random?: () => number;
      /** Test-only CLI identity; production reads the running launcher's version. */
      cliVersion?: () => string | null;
      /** Configured model directory, injectable so protocol tests never use real credentials. */
      modelProviders?: Pick<typeof codexModelProviderService, 'list' | 'models'>;
    } = {},
  ) {
    this.configProvider = options.configProvider ?? new CodexPredictionConfigProvider();
    this.predictions = options.predictions
      ?? new CodexComposerPredictions(client, () => this.connectionLive(), predictionTimeoutMs, () => this.connectionEpoch);
    this.providerEligible = options.providerEligible ?? ((provider) => provider === 'openai');
    this.random = options.random ?? Math.random;
    this.readCliVersion = options.cliVersion ?? (() => this.client.status?.cliVersion ?? null);
    this.modelProviders = options.modelProviders ?? codexModelProviderService;
    this.unsubscribe = [
      client.onNotification((frame) => this.onNotification(frame)),
      client.onRequest((frame) => this.onRequest(frame)),
      client.onExit((error, appServerInstanceId) => {
        // A new process may serve a later request; anything already in flight
        // belongs to the dead generation and must never be replayed against it.
        this.connectionEpoch += 1;
        const stopped = error instanceof AppError && error.code === 'CODEX_APP_SERVER_STOPPED';
        // Close the workers that belonged to this exited process. The callback
        // only reaches the plugin IPC; it never spawns a replacement app-server.
        void this.workerBridge?.closeAppServer(
          appServerInstanceId ?? this.fallbackInstanceId,
          stopped ? 'Codex app-server stopped.' : 'Codex app-server exited.',
        ).catch(() => {});
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
          // A dropped prediction must not survive the process that would have answered it.
          this.clearPrediction(session);
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

  /** The composition root installs the Worker bridge; native runtimes never import workers. */
  setWorkerBridge(bridge: CodexWorkerBridge | null): void {
    this.workerBridge = bridge;
  }

  private appServerInstanceId(): string {
    return this.client.ensureInstanceId?.() ?? this.client.instanceId ?? this.fallbackInstanceId;
  }

  /**
   * Registers the temporary Worker MCP thread config. A missing or disabled
   * plugin returns null so Codex keeps working without Worker tools; the user's
   * global Codex config and skill directories are never modified.
   */
  private async prepareWorkerConfig(
    sessionId: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<Record<string, unknown> | null> {
    if (!this.workerBridge) return null;
    try {
      return await this.workerBridge.prepareSession({
        sessionId,
        projectPath: String(options.projectPath ?? options.cwd ?? ''),
        userId: writer.userId ?? null,
        appServerInstanceId: this.appServerInstanceId(),
      });
    } catch {
      // Worker registration is optional; a bridge failure must not block Codex.
      return null;
    }
  }

  getState(sessionId: string): CodexSessionState {
    const session = this.sessions.get(sessionId);
    const predictionSupported = this.predictionSupported();
    const settings = this.settings.get(sessionId);
    if (session) return { ...session.state, ...settings, diagnostics: this.client.status, predictionSupported,
      ...(session.modelProvider && session.model ? { activeModelSelection: { modelProvider: session.modelProvider, model: session.model } } : {}),
      goal: session.state.goal ? { ...session.state.goal, threadId: session.id } : null, questions: [...session.state.questions], ...(session.state.prediction ? { prediction: { ...session.state.prediction } } : {}) };
    const failure = this.failures.get(sessionId);
    if (failure) return { ...failure.state, ...settings, predictionSupported, diagnostics: this.client.status };
    return { ...settings, diagnostics: this.client.status, predictionSupported, phase: 'idle', turnId: null, goal: null, questions: [] };
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

  private async ensure(sessionId: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext,
    selection = this.settings.get(sessionId).modelSelection): Promise<NativeSession> {
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
      state: { ...this.getState(sessionId), runtime: 'app-server', phase: 'starting', error: undefined }, model: '', modelProvider: null,
      setup: null, goalMutation: null, turn: null, prediction: null, historyReady: Boolean(providerId), completedTurns: new Set(), children: new Set(), stop: null, stopRequested: Boolean(providerId) && this.settings.get(sessionId).queueHeld,
    };
    this.failures.delete(sessionId);
    this.sessions.set(sessionId, session);
    const target = session;
    this.publish(target);
    target.setup = (async () => {
      target.model = selection?.model ?? await context.resolveResumeModel(sessionId, options.model) ?? '';
      // New threads inherit the current global default; an explicit session
      // selection wins. Existing threads resume without a global override here.
      const requestedModelProvider = selection?.modelProvider
        ?? (!providerId ? (await this.modelProviders.list()).defaultProvider : undefined);
      this.assertLiveSession(target);
      if (target.stopRequested && !providerId) return;
      const permission = this.permissionOptions(options);
      // The Worker owner/token is registered once per loaded thread. The
      // returned map is a temporary thread config override, never config.toml.
      const workerConfig = await this.prepareWorkerConfig(sessionId, options, writer);
      this.assertLiveSession(target);
      if (target.stopRequested && !providerId) return;
      const result = await this.client.request(providerId ? 'thread/resume' : 'thread/start', {
        // Select readable history for new threads; this creation-only setting
        // cannot migrate existing threads. Resume reads their history separately.
        ...(providerId ? { threadId: providerId, excludeTurns: true } : { historyMode: 'legacy' }),
        cwd: options.cwd ?? options.projectPath,
        ...(requestedModelProvider ? { modelProvider: requestedModelProvider } : {}),
        ...(target.model ? { model: target.model } : {}), ...permission,
        ...(workerConfig ? { config: workerConfig } : {}),
      });
      this.assertLiveSession(target);
      if (!result.thread?.id) throw new Error('Codex did not return a thread id.');
      target.threadId = result.thread.id;
      // Only the native thread's accepted config proves Worker tools exist.
      target.state.workerEnabled = Boolean(workerConfig);
      target.model = result.model || result.thread.model || target.model;
      target.modelProvider = typeof result.modelProvider === 'string' ? result.modelProvider : null;
      if (selection && target.modelProvider !== selection.modelProvider) {
        throw new Error('Codex did not apply the selected model provider. No message was sent.');
      }
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

  /** Ordinary turns and goal activation resolve the saved model while preserving the requested effort. */
  private async configureModel(session: NativeSession, context: ProviderRuntimeContext, selection?: CodexModelSelection): Promise<void> {
    session.model = selection?.model ?? await context.resolveResumeModel(session.id, session.options.model) ?? session.model;
  }

  private newTurn(session: NativeSession, writer: ProviderRuntimeWriter, id: string | null, composerPredictions = false): NativeTurn {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const turn: NativeTurn = { id, writer, done, finish, terminal: false, items: new Map(), composerPredictions };
    // Anything still pending belongs to the turn this one replaces, including
    // a suggestion already shown for it.
    this.clearPrediction(session);
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
    // A confirmed provider/model choice is one snapshot for this turn. Changes
    // made while setup or inference is running belong to the following turn.
    await this.controls.get(sessionId)?.catch(() => {});
    const selection = this.settings.get(sessionId).modelSelection;
    if (selection?.model === null) throw new AppError('Choose a model before sending a prompt.', {
      code: 'CODEX_MODEL_REQUIRED', statusCode: 409,
    });
    let session: NativeSession;
    try {
      const loaded = this.sessions.get(sessionId);
      if (selection && loaded?.modelProvider !== selection.modelProvider) {
        await this.releaseSession(sessionId, context.resolveProviderSessionId(sessionId));
      }
      session = await this.ensure(sessionId, options, writer, context, selection);
    } catch (error) {
      if (stopVersion !== (this.stopVersions.get(sessionId) ?? 0) && error instanceof AppError
        && ['CODEX_APP_SERVER_STOPPED', 'CODEX_APP_SERVER_SESSION_CLOSED'].includes(error.code)) {
        writer.send(createCompleteMessage({ provider: 'codex', sessionId, exitCode: 0, aborted: true }));
        return;
      }
      if (selection && stopVersion === (this.stopVersions.get(sessionId) ?? 0)) {
        this.settings.update(sessionId, { queueHeld: true });
        const state: CodexSessionState = { ...this.getState(sessionId), phase: 'failed', error: error instanceof Error ? error.message : String(error) };
        const loaded = this.sessions.get(sessionId);
        if (loaded) Object.assign(loaded.state, { phase: state.phase, error: state.error });
        this.failures.set(sessionId, { state, writer });
        writer.send(createNormalizedMessage({ provider: 'codex', sessionId, kind: 'status', text: 'codex_control', codexState: state }));
      }
      throw error;
    }
    // Stop may have finished while thread initialization was still pending. Only
    // a new user submission, captured after that Stop, may clear its intent.
    if (stopVersion !== (this.stopVersions.get(sessionId) ?? 0)) {
      writer.send({ ...createCompleteMessage({ provider: 'codex', sessionId, exitCode: 0, aborted: true }), stopping: session.state.phase !== 'idle' });
      return;
    }
    const workerWakeup = options.workerWakeup === true;
    // An automatic Worker wake-up may continue only an active, unpaused owner;
    // it must never clear a Stop or a held queue.
    if (workerWakeup && (session.stopRequested || this.settings.get(sessionId).queueHeld)) {
      throw new AppError('The session stopped or is holding its queue.', {
        code: 'CODEX_WORKER_WAKE_STOPPED', statusCode: 409,
      });
    }
    if (session.stopRequested) {
      if (session.stop || session.state.phase !== 'idle') throw new Error('The previous Codex stop has not been confirmed.');
      session.stopRequested = false;
    }
    // Only an explicit user turn after confirmed cleanup re-activates Worker delivery.
    if (!workerWakeup && options.userTurn === true) {
      await this.workerBridge?.activateSession(sessionId).catch(() => {});
    }
    if (session.turn && !session.turn.terminal) throw new Error('Codex already has an active turn.');
    if (options.collaborationMode === 'plan' || options.collaborationMode === 'default') {
      session.state.mode = options.collaborationMode;
      this.settings.update(sessionId, { mode: options.collaborationMode });
    }
    await this.configureModel(session, context, selection);
    if (stopVersion !== (this.stopVersions.get(sessionId) ?? 0)) {
      writer.send({ ...createCompleteMessage({ provider: 'codex', sessionId, exitCode: 0, aborted: true }), stopping: session.state.phase !== 'idle' });
      return;
    }
    // A Worker wake-up consults its trusted final gate immediately before the
    // native turn exists. A user message that arrived after the Worker batch was
    // claimed defers this turn normally: no native turn is created, so there is
    // no failed state, no error event and no failure notification. The host
    // puts the same batch back to pending and retries it later.
    const deferTurn = typeof options.deferTurn === 'function'
      ? options.deferTurn as () => boolean
      : null;
    if (deferTurn && !deferTurn()) {
      throw new AppError('The Worker wake-up was deferred until the session is idle.', {
        code: 'WORKER_WAKE_DEFERRED', statusCode: 409,
      });
    }
    const turn = this.newTurn(session, writer, null, options.composerPredictions === true);
    this.publish(session);
    try {
      // Recorded before the RPC but inside the guarded block: item notifications
      // can arrive while turn/start is still awaiting its reply, and they must
      // find this identity, while a build failure keeps the existing cleanup.
      const clientUserMessageId: string = options.clientMessageId ?? randomUUID();
      const input = buildInput(command, options.attachments ?? [...(options.images ?? []), ...(options.files ?? [])]);
      turn.submittedInput = { clientId: clientUserMessageId, input };
      // Queue dispatch keeps its receipt reserved until input can actually be
      // delivered. A failed provider resume must leave that message queued.
      options.onTurnStarting?.();
      const starting = this.client.request('turn/start', {
        threadId: session.threadId,
        input,
        clientUserMessageId,
        collaborationMode: this.collaboration(session),
        ...this.turnPermissions(options),
      });
      turn.starting = starting;
      let result: AnyRecord | undefined;
      try {
        // A native terminal can arrive before the proxy acknowledges turn/start;
        // release the run rather than waiting out the acknowledgement budget.
        result = await Promise.race([starting, turn.done.then(() => undefined)]);
      } finally {
        turn.starting = null;
      }
      if (turn.terminal) return;
      if (!result?.turn?.id) throw new Error('Codex did not return a turn id.');
      session.historyReady = true;
      turn.id = result.turn.id;
      if (!turn.terminal) {
        session.state.turnId = turn.id;
        session.state.phase = session.stopRequested ? 'stopping' : 'running';
        this.publish(session);
      }
      // Let the Stop that is already settling observe this id; a Stop that
      // already returned uncertain owns no coordinator, so reconcile it here.
      if (session.stopRequested) {
        const continuing = session.stop;
        if (continuing) await continuing;
        if (this.sessions.get(session.id) === session && session.turn === turn
          && session.stopRequested && !session.stop && session.state.phase !== 'idle') {
          void this.abort(session.id, false);
        }
      }
      await turn.done;
    } catch (error) {
      if (turn.terminal && error instanceof AppError && error.code === 'CODEX_APP_SERVER_STOPPED') return;
      // An uncertain start must be reconciled instead of opening a duplicate turn.
      if (error instanceof AppError && error.code === 'CODEX_APP_SERVER_TIMEOUT') {
        // A native terminal or a turn/started id proves this turn exists; a
        // slow proxy acknowledgement is not an uncertain stop. Only an RPC with
        // no native evidence keeps the resultUnknown/stopFailed protection.
        if (!turn.terminal && !turn.id) {
          session.state.phase = 'stopFailed';
          session.state.error = error.message;
          this.publish(session);
        }
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
    } else if (status === 'completed' && !session.stopRequested) {
      // A normal completion supersedes an earlier startup-acknowledgement
      // warning; a failed or stopped turn keeps its own error instead.
      session.state.error = undefined;
    }
    this.publish(session);
    const success = status === 'completed' && !['blocked', 'usageLimited', 'budgetLimited'].includes(session.state.goal?.status ?? '');
    turn.writer.send({ ...createCompleteMessage({ provider: 'codex', sessionId: session.id, exitCode: status === 'failed' ? 1 : 0, aborted: status === 'interrupted' }),
      goalActive: session.state.goal?.status === 'active', stopping: session.stopRequested, turnId: turn.id,
      success });
    if (!session.stopRequested && session.state.goal?.status !== 'active') {
      const notice = { userId: turn.writer.userId ?? null, provider: 'codex', sessionId: session.options.sessionId ?? session.id, sessionName: session.options.sessionSummary ?? null };
      if (status === 'failed') notifyRunFailed({ ...notice, error: error ?? 'Codex turn failed.' });
      else if (status === 'completed') notifyRunStopped({ ...notice, stopReason: session.state.goal?.status ?? 'completed' });
    }
    // Only an ordinary, successful, still-live turn asks for a suggestion. A
    // failed, interrupted, stopping or goal-continued turn, or a runtime the
    // user has already left, must never start one. The prediction itself is an
    // ordinary model turn on an ephemeral fork, so it is detached from this
    // run promise and can never fail, delay or extend the user's turn.
    if (turn.composerPredictions && success && !session.stopRequested && !error
      && session.state.goal?.status !== 'active' && this.sessions.get(session.id) === session) {
      this.requestPrediction(session, turn.id);
    }
    turn.finish();
  }

  /**
   * Clears the session's prediction state and aborts its request. Every point
   * that ends the turn it belongs to (new turn, stop, runtime handoff, process
   * exit, close) calls this so a late fork or result cannot resurrect an old
   * suggestion.
   */
  private clearPrediction(session: NativeSession): void {
    session.prediction?.controller.abort();
    if (session.prediction?.timer) clearTimeout(session.prediction.timer);
    session.prediction = null;
    if (session.state.prediction) session.state.prediction = undefined;
  }

  private settlePrediction(
    session: NativeSession,
    request: NativePredictionRequest,
    value:
      | { status: 'ready'; text: string }
      | { status: 'unavailable'; reason: CodexComposerPredictionReason; error?: string },
  ): void {
    // Identity is re-checked at the point of use: a stale result for a previous
    // turn, a replaced request, or a closed/replaced session must not publish.
    if (session.prediction !== request || this.sessions.get(session.id) !== session) return;
    if (request.timer) clearTimeout(request.timer);
    session.prediction = null;
    session.state.prediction = { sourceTurnId: request.sourceTurnId, ...value };
    this.publish(session);
  }

  /**
   * Starts one detached prediction request for a completed parent turn.
   *
   * The UI is moved to `pending` immediately, then the remote configuration and
   * the parent's eligibility decide whether an ephemeral fork is created. No
   * path substitutes a fresh thread, and no path joins the run promise.
   */
  private requestPrediction(session: NativeSession, sourceTurnId: string | null): void {
    const threadId = session.threadId;
    if (!sourceTurnId || !threadId) return;
    // Never restart a stopped app-server merely to fetch a suggestion. A client
    // without status (scripted tests) is assumed live.
    if (!this.connectionLive()) return;
    this.clearPrediction(session);
    if (!this.predictionSupported()) {
      session.state.prediction = { sourceTurnId, status: 'unavailable', reason: 'unsupported' };
      this.publish(session);
      return;
    }
    // Native prediction forks inherit the parent's MCP credentials and reject
    // config overrides. Keep Worker ownership out of every prediction fork.
    if (session.state.workerEnabled) {
      session.state.prediction = { sourceTurnId, status: 'unavailable', reason: 'worker_mcp' };
      this.publish(session);
      return;
    }
    if (!this.predictionsEligible(session)) {
      session.state.prediction = { sourceTurnId, status: 'unavailable', reason: 'ineligible' };
      this.publish(session);
      return;
    }
    const request: NativePredictionRequest = { threadId, sourceTurnId, controller: new AbortController() };
    session.prediction = request;
    session.state.prediction = { sourceTurnId, status: 'pending' };
    this.publish(session);
    // One overall deadline covers the remote config, any token refresh, the fork
    // and the turn. When it fires, the whole request is aborted and reported as
    // a timeout; the executor's own deadline no longer has to bound config I/O.
    request.timer = setTimeout(() => {
      request.controller.abort();
      this.settlePrediction(session, request, { status: 'unavailable', reason: 'timeout', error: 'Prediction timed out.' });
    }, Math.max(1, this.predictionTimeoutMs));
    request.timer.unref?.();
    void this.runPrediction(session, request).catch(() => {
      // Every failure is classified into the snapshot; nothing reaches chat.
      this.settlePrediction(session, request, { status: 'unavailable', reason: 'request_failed' });
    }).finally(() => { if (request.timer) clearTimeout(request.timer); });
  }

  /**
   * Resolves configuration, checks this parent's eligibility and forks.
   *
   * The parent thread is never resumed or modified here: its mode, model and
   * provider were established by `ensure`, and a stopped session is never
   * restarted just to check whether it could accept a prediction.
   */
  private async runPrediction(session: NativeSession, request: NativePredictionRequest): Promise<void> {
    const { signal } = request.controller;
    const unavailable = (reason: CodexComposerPredictionReason) =>
      this.settlePrediction(session, request, { status: 'unavailable', reason });

    if (!this.predictionsEligible(session)) {
      unavailable('ineligible');
      return;
    }
    const loaded = await this.configProvider.load({
      signal,
      // app-server owns token refresh: ask it to refresh, then the loader
      // re-reads auth.json itself rather than writing credentials anywhere.
      refreshCredentials: async () => {
        if (!this.connectionLive()) throw new Error('Codex app-server is not running.');
        await this.client.request('account/read', { refreshToken: true });
      },
    });
    if (signal.aborted) return;
    // Eligibility may have changed while the remote config was loading: a Plan
    // switch or an active Goal must not start a fork after the fact.
    if (session.prediction !== request || this.sessions.get(session.id) !== session) return;
    if (!this.predictionsEligible(session)) {
      unavailable('ineligible');
      return;
    }
    if (loaded.status !== 'ready') {
      unavailable(loaded.reason);
      return;
    }
    const config = loaded.config;
    if (!config.isEnabled || config.unsupportedModels.includes(session.model)) {
      unavailable('ineligible');
      return;
    }
    const rate = config.liveSampleRate ?? config.sampleRate;
    // A sampling miss is an ordinary "no suggestion", not an account/model
    // ineligibility: the user did nothing wrong, the draw simply declined.
    if (rate < 1 && this.random() >= rate) {
      unavailable('empty');
      return;
    }
    const outcome = await this.predictions.generate({
      parentThreadId: request.threadId,
      sourceTurnId: request.sourceTurnId,
      config,
      model: session.model,
      effort: this.effortOf(session),
      signal,
    });
    if (signal.aborted) return;
    if (outcome.status === 'ready') {
      this.settlePrediction(session, request, { status: 'ready', text: outcome.text });
      return;
    }
    unavailable(outcome.reason);
  }

  /**
   * Whether this parent turn may still produce a prediction.
   *
   * Plan mode and an active Goal are user-intent boundaries: neither may start
   * or keep a suggestion. A non-OpenAI provider is likewise excluded. Checked
   * both when a prediction is requested and again after any asynchronous
   * configuration load.
   */
  private predictionsEligible(session: NativeSession): boolean {
    const selected = this.settings.get(session.id).modelSelection;
    return session.state.mode !== 'plan'
      && session.state.goal?.status !== 'active'
      && (!selected || selected.modelProvider === session.modelProvider && selected.model === session.model)
      && this.providerEligible(session.modelProvider);
  }

  /** Effective reasoning effort of the parent turn; `default` means unset. */
  private effortOf(session: NativeSession): string | null {
    const effort = session.options.effort;
    return typeof effort === 'string' && effort !== 'default' ? effort : null;
  }

  /** True when this connection may still accept RPCs, without starting one. */
  private connectionLive(): boolean {
    return !this.client.status || this.client.status.running;
  }

  /**
   * Public stable builds from 0.163.0 on carry the prediction fork fields.
   *
   * This is deliberately not the desktop's internal alpha threshold: the
   * adapter needs a documented, stable protocol. Unknown and prerelease
   * identities stay unsupported so no build silently degrades to a plain turn.
   */
  private predictionSupported(): boolean {
    return supportsComposerPredictions(this.readCliVersion());
  }

  private onNotification(frame: CodexRpcFrame): void {
    const p = frame.params ?? {};
    // A composer prediction lives on a temporary ephemeral fork. Its events are
    // read by that executor alone and must never touch the parent transcript,
    // child set, turn state or queue.
    if (this.predictions.ownsThread(p.threadId)) return;
    // A late `thread/started` can arrive after its fork acknowledgement; the
    // analytics source identifies it even when the id is not yet known here.
    if (frame.method === 'thread/started' && p.thread?.threadSource === 'composer_predictions') return;
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
      // An active Goal owns the conversation; no suggestion may start or remain.
      if (session.state.goal?.status === 'active') this.clearPrediction(session);
      this.publish(session);
      return;
    }
    if (frame.method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage ?? p.usage;
      // Like Codex TUI, context occupancy uses the last request, not lifetime usage.
      // This is a thread notification and can arrive after turn/completed.
      if (usage?.last) (session.turn?.writer ?? session.writer).send(createNormalizedMessage({ provider: 'codex', sessionId: session.id, kind: 'status', text: 'token_budget',
        tokenBudget: { used: usage.last.totalTokens, total: usage.modelContextWindow, inputTokens: usage.last.inputTokens, outputTokens: usage.last.outputTokens } }));
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
      // A running native turn proves the start was accepted; retire the stale
      // startup-timeout warning. A stopping or failed turn keeps its own error.
      if (!session.stopRequested) session.state.error = undefined;
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
      if (item.type === 'userMessage') this.correlateSubmittedInput(turn, item);
      if (item.type === 'userMessage' && item.clientId) this.confirmSteer(session.id, item.clientId);
      turn.items.set(item.id, item);
      for (const message of normalizeAppServerItem(item, session.id, turn.id ?? turnId ?? 'starting')) turn.writer.send(message);
    }
  }

  /**
   * Gives a native user item the identity this adapter submitted under.
   *
   * A provider-supplied `clientId` is always authoritative. When it names this
   * adapter's own submission, that item owns the submission, so a later item
   * with equal text cannot claim it; the matching ID alone is sufficient, since
   * the provider may normalize the displayed content. Otherwise the item
   * inherits the ID already associated with the same native item ID — that is
   * how a `completed` snapshot repeats what `started` established — and only
   * then may it claim the still-unbound submitted input, provided the content
   * matches what `turn/start` actually received. One native item owns that
   * submission; other items keep their native ID so a repeated-looking turn
   * never reuses it. Turns without a submitted record (autonomous goal
   * continuations) are left untouched.
   */
  private correlateSubmittedInput(turn: NativeTurn, item: AnyRecord): void {
    const submitted = turn.submittedInput;
    if (item.clientId) {
      if (submitted && !submitted.boundItemId && item.clientId === submitted.clientId) {
        submitted.boundItemId = item.id;
      }
      return;
    }

    // A `completed` snapshot repeats the item `started` established; carry the
    // ID that snapshot settled on, whichever source it came from.
    const knownForItem = turn.items.get(item.id)?.clientId;
    if (typeof knownForItem === 'string' && knownForItem.length > 0) {
      item.clientId = knownForItem;
      return;
    }

    if (!submitted) return;

    if (submitted.boundItemId) {
      if (submitted.boundItemId !== item.id) return;
    } else {
      if (!matchesSubmittedInput(item.content, submitted.input)) return;
      submitted.boundItemId = item.id;
    }

    item.clientId = submitted.clientId;
  }

  private async interrupt(session: NativeSession, turn: NativeTurn): Promise<void> {
    if (!turn.id || turn.terminal) return;
    this.assertLiveSession(session);
    await this.client.request('turn/interrupt', { threadId: session.threadId, turnId: turn.id });
  }

  async abort(sessionId: string, invalidateControls = true): Promise<boolean> {
    if (invalidateControls) this.stopVersions.set(sessionId, (this.stopVersions.get(sessionId) ?? 0) + 1);
    // Start both independent cleanups immediately. Worker cleanup must never
    // delay setting native Stop intent or interrupting the native turn.
    const workerCleanup = this.workerBridge
      ? this.workerBridge.stopSession(sessionId, 'session-stop').catch(() => false)
      : Promise.resolve(true);
    const session = this.sessions.get(sessionId);
    if (!session) return await workerCleanup;
    if (session.stop) return (await session.stop) && (await workerCleanup);
    // Stop hides any suggestion immediately, before the native turn confirms.
    this.clearPrediction(session);
    session.stopRequested = true;
    session.state.phase = 'stopping';
    this.settings.update(sessionId, { queueHeld: true });
    this.publish(session);
    const nativeStop = (async () => {
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
        // An unacknowledged start has no native id to interrupt yet. Wait for
        // the RPC to settle or the turn to end natively before reconciling;
        // run() alone turns a rejection into a terminal or uncertain outcome.
        const startingTurn = session.turn;
        if (startingTurn && !startingTurn.terminal && !startingTurn.id && startingTurn.starting) {
          await bounded(Promise.race([startingTurn.starting.catch(() => undefined), startingTurn.done]));
        }
        // Retrying an uncertain turn/start recovers its id before interrupting it.
        const pendingTurn = session.turn;
        if (session.threadId && pendingTurn && !pendingTurn.terminal && !pendingTurn.id && !session.setup) {
          const result = await request('thread/read', { threadId: session.threadId, includeTurns: true });
          const active = result.thread?.turns?.find((turn: AnyRecord) => turn.status === 'inProgress');
          if (active) pendingTurn.id = active.id;
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
      }
    })();
    // One Stop is confirmed only when both native interruption and Worker
    // cleanup finish. Join both without short-circuiting, and keep the shared
    // promise alive until the slower cleanup settles.
    let combined!: Promise<boolean>;
    combined = (async () => {
      const [nativeStopped, workersStopped] = await Promise.all([nativeStop, workerCleanup]);
      // Keep Stop visible while either cleanup is pending. A process exit may
      // already have discarded this session, so never publish over its replacement.
      if (this.sessions.get(sessionId) === session) {
        if (!workersStopped) {
          session.state.phase = 'stopFailed';
          session.state.error = 'Worker cleanup was not confirmed. Retry the stop before sending another turn.';
          this.publish(session);
        } else if (nativeStopped) {
          session.state.phase = 'idle';
          session.state.error = undefined;
          this.publish(session);
        }
      }
      if (session.stop === combined) session.stop = null;
      return nativeStopped && workersStopped;
    })();
    session.stop = combined;
    return session.stop;
  }

  async control(sessionId: string, action: CodexControlAction, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<CodexSessionState> {
    if (action.action !== 'goal' && action.action !== 'mode' && action.action !== 'model-provider') return this.applyControl(sessionId, action, options, writer, context);
    const version = this.stopVersions.get(sessionId) ?? 0;
    const previous = this.controls.get(sessionId);
    const operation = (async () => {
      await previous?.catch(() => {});
      if (version !== (this.stopVersions.get(sessionId) ?? 0) && (action.action === 'mode' || action.action === 'goal' && ['set', 'resume'].includes(action.operation))) {
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
    if (action.action === 'model-provider') {
      const currentProvider = this.settings.get(sessionId).modelSelection?.modelProvider ?? this.sessions.get(sessionId)?.modelProvider;
      if (action.modelProvider !== currentProvider && this.hasNativeWork(sessionId)) {
        throw new AppError('Finish running tasks before switching model services.', { code: 'CODEX_MODEL_PROVIDER_BUSY', statusCode: 409 });
      }
      const catalog = await this.modelProviders.models(action.modelProvider);
      // Keep a shared model, otherwise require a new choice in the composer.
      // Never substitute the service's first model or the CLI default.
      const modelSelection: CodexModelSelection = { modelProvider: action.modelProvider,
        model: action.model !== null && catalog.models.includes(action.model) ? action.model : null };
      this.settings.update(sessionId, { modelSelection });
      const existing = this.sessions.get(sessionId);
      if (existing) {
        this.clearPrediction(existing);
        this.publish(existing);
      } else writer.send(createNormalizedMessage({ provider: 'codex', sessionId, kind: 'status', text: 'codex_control', codexState: this.getState(sessionId) }));
      return this.getState(sessionId);
    }
    const selected = this.settings.get(sessionId).modelSelection;
    const loaded = this.sessions.get(sessionId);
    if (selected?.model === null) {
      // Reconnect must keep the empty choice instead of resuming with a CLI
      // default. Existing work can still be paused/cleared on its loaded thread.
      if (action.action === 'goal' && action.operation === 'get') return this.getState(sessionId);
      if (action.action === 'steer' || action.action === 'goal' && (!loaded || ['set', 'resume'].includes(action.operation))) {
        throw new AppError('Choose a model before sending a prompt.', { code: 'CODEX_MODEL_REQUIRED', statusCode: 409 });
      }
    }
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
      if (existing) {
        existing.state.mode = action.mode;
        // Plan never shows or starts a suggestion; retire any pending/ready one.
        if (action.mode === 'plan') this.clearPrediction(existing);
        this.publish(existing);
      }
      return this.getState(sessionId);
    }
    if (action.operation === 'get' && !context.resolveProviderSessionId(sessionId) && !this.sessions.has(sessionId)) return this.getState(sessionId);
    if (['set', 'resume'].includes(action.operation) && selected && loaded?.modelProvider !== selected.modelProvider) {
      if (this.hasNativeWork(sessionId)) throw new AppError('Pause the current goal before applying the selected model provider.', {
        code: 'CODEX_RUNTIME_BUSY', statusCode: 409,
      });
      await this.unloadSession(sessionId, context.resolveProviderSessionId(sessionId));
    }
    const session = await this.ensure(sessionId, options, writer, context);
    this.assertLiveSession(session);
    if (action.operation === 'get') {
      const { goal } = isCodexGoalEnabled()
        ? await this.client.request('thread/goal/get', { threadId: session.threadId })
        : { goal: null };
      this.assertLiveSession(session);
      session.state.goal = goal ?? null;
      // A goal read is authoritative even without a notification: an active or
      // new intent retires any pending/ready suggestion.
      if (goal?.status === 'active') this.clearPrediction(session);
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
      // A new explicit Goal intent retires any pending/ready suggestion before
      // the async settings/model/goal RPCs run (a paused goal still counts).
      this.clearPrediction(session);
      if (!session.turn || session.turn.terminal) session.state.phase = 'starting';
      this.publish(session);
      session.goalMutation = (async () => {
        await this.configureModel(session, context, selected);
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
        // The RPC result may activate the goal without a notification.
        if (result.goal?.status === 'active') this.clearPrediction(session);
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
    // A prediction turn must never surface an approval or question to the user.
    // Refuse it with the shape each reverse-request contract expects and end
    // that prediction's turn; an unknown method is explicitly rejected.
    if (this.predictions.ownsThread(p.threadId)) {
      this.predictions.cancelThread(p.threadId);
      if (frame.method === 'item/tool/requestUserInput') return Promise.resolve({ answers: {} });
      if (frame.method === 'item/permissions/requestApproval') return Promise.resolve({ permissions: {}, scope: 'turn' });
      if (frame.method === 'item/commandExecution/requestApproval' || frame.method === 'item/fileChange/requestApproval') {
        return Promise.resolve({ decision: 'cancel' });
      }
      return Promise.reject(new Error(`Unsupported Codex request: ${frame.method}`));
    }
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

  private hasNativeWork(sessionId?: string): boolean {
    return [...this.sessions.values()].some((s) => (!sessionId || s.id === sessionId) && Boolean(s.setup || s.stop || s.goalMutation || ['stopping', 'stopFailed'].includes(s.state.phase) || (s.turn && !s.turn.terminal) || s.state.goal?.status === 'active'))
      || [...this.requests.values()].some((request) => !sessionId || request.session.id === sessionId);
  }

  /** The router checks session activity before switching runtimes. */
  isBusy(sessionId?: string): boolean {
    return this.hasNativeWork(sessionId) || (sessionId ? this.controls.has(sessionId) : this.controls.size > 0);
  }

  /** The router releases the native writer/cache before allowing the SDK to append to its rollout. */
  async releaseSession(sessionId: string, providerThreadId: string | null): Promise<void> {
    if (this.isBusy(sessionId)) throw new Error('Stop this session before changing its runtime.');
    await this.unloadSession(sessionId, providerThreadId);
  }

  /** Run/runtime handoff and serialized goal activation both resume only after native closure. */
  private async unloadSession(sessionId: string, providerThreadId: string | null): Promise<void> {
    const session = this.sessions.get(sessionId);
    const threadId = session?.threadId ?? providerThreadId;
    const queueHeld = this.settings.get(sessionId).queueHeld;
    const stopVersion = this.stopVersions.get(sessionId) ?? 0;
    // Even without a cached native session, a runtime handoff must stop the
    // Worker owner; it must still perform the existing thread/unsubscribe
    // history handoff when a provider thread id is known.
    if (!session) {
      if (!await this.abort(sessionId, false)) throw new Error('Could not stop the previous Worker cleanup.');
    } else if (!await this.abort(sessionId, false)) throw new Error('Could not stop the previous Codex runtime.');
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
      // The SDK continues the same rollout, so no native suggestion may survive the handoff.
      if (session) this.clearPrediction(session);
      this.sessions.delete(sessionId);
      this.failures.delete(sessionId);
      if (stopVersion === (this.stopVersions.get(sessionId) ?? 0)) this.settings.update(sessionId, { queueHeld });
    }
  }

  async close(): Promise<void> {
    if (this.client === codexAppServerTransport) {
      await Promise.all(this.listActiveSessions().map(({ sessionId }) => this.abort(sessionId)));
      await codexAppServerTransport.close();
      // Closing the real transport emits onExit, which already bumped the epoch.
    }
    for (const session of this.sessions.values()) this.clearPrediction(session);
    // Close must not invalidate an injected client's still-live cleanup by
    // bumping the epoch ahead of it; the executor cancels every run and the
    // onExit handler is the only thing that advances the generation.
    await this.predictions.close();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe = [];
  }
}

/** Codex's provider router and fork client share the same process and event subscription. */
export const codexAppServerRuntime = new CodexAppServerRuntime();
