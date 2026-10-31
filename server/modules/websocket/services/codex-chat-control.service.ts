import { sessionDraftsDb, sessionRuntimeDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { AppError } from '@/shared/index.js';
import type {
  AnyRecord,
  CodexControlAction,
  CodexSessionState,
  ProviderRuntimeGateway,
  RealtimeClientConnection,
} from '@/shared/index.js';

type ControlInput = {
  sessionId: string | null;
  userId: string | number | null;
  requestId: unknown;
  control: unknown;
  options?: AnyRecord;
};

type ControlDependencies = {
  runtime: ProviderRuntimeGateway;
  connection: RealtimeClientConnection;
  filterAttachments(value: unknown): unknown[];
  /**
   * Composition-injected queue-change notice. Resuming a held queue or
   * recovering an uncertain delivery makes a waiting user turn sendable
   * immediately instead of waiting for the supplemental poll.
   */
  notifyQueueChanged?(sessionId: string): void;
};

type ControlResult = {
  kind: 'control_result';
  sessionId: string | null;
  requestId: string;
  ok: boolean;
  delivery?: string;
  error?: string | null;
  codexState?: CodexSessionState;
};

/** Validates control input before any native RPC or durable queue mutation. */
function parseControl(raw: AnyRecord): CodexControlAction {
  switch (raw.action) {
    case 'state': case 'stop-app-server': return { action: raw.action };
    case 'mode':
      if (raw.mode === 'default' || raw.mode === 'plan') return { action: 'mode', mode: raw.mode };
      break;
    case 'runtime':
      if (raw.runtime === 'sdk' || raw.runtime === 'app-server') return { action: 'runtime', runtime: raw.runtime };
      break;
    case 'model-provider':
      if (typeof raw.modelProvider === 'string' && raw.modelProvider.trim()
        && (raw.model === null || typeof raw.model === 'string' && raw.model.trim())) {
        return { action: 'model-provider', modelProvider: raw.modelProvider.trim(), model: raw.model === null ? null : raw.model.trim() };
      }
      break;
    case 'goal':
      if (['get', 'set', 'pause', 'resume', 'clear'].includes(raw.operation)
        && (raw.objective === undefined || typeof raw.objective === 'string')
        && (raw.tokenBudget === undefined || Number.isSafeInteger(raw.tokenBudget) && raw.tokenBudget > 0)) {
        return { action: 'goal', operation: raw.operation, objective: raw.objective, tokenBudget: raw.tokenBudget };
      }
      break;
    case 'answer':
      if (typeof raw.requestId === 'string' && raw.answers && typeof raw.answers === 'object' && !Array.isArray(raw.answers)) {
        return { action: 'answer', requestId: raw.requestId, answers: raw.answers };
      }
  }
  throw new AppError('Invalid Codex control request.', { code: 'INVALID_CONTROL', statusCode: 400 });
}

/** The WebSocket chat entry point delegates Codex controls and durable steer receipts here. */
export async function executeCodexChatControl(input: ControlInput, dependencies: ControlDependencies): Promise<ControlResult> {
  const { sessionId, userId } = input;
  const { runtime, connection, filterAttachments, notifyQueueChanged } = dependencies;
  const requestId = typeof input.requestId === 'string' ? input.requestId : '';
  const numericUserId = Number(userId);
  const response = { kind: 'control_result' as const, sessionId, requestId };
  let steering = false;

  try {
    const session = sessionId && sessionsDb.getSessionById(sessionId);
    if (!sessionId || !session || session.provider !== 'codex' || !runtime.control) throw new Error('Codex session controls are unavailable.');
    if (!requestId || requestId.length > 160) throw new Error('A control request id is required.');
    if (!input.control || typeof input.control !== 'object' || Array.isArray(input.control)) throw new Error('A control action is required.');
    const raw = input.control as AnyRecord;

    if (raw.action === 'queue-resume' || raw.action === 'queue-recover') {
      if (!Number.isSafeInteger(numericUserId) || userId === null) throw new Error('Authentication required.');
      if (raw.action === 'queue-recover') {
        const state = runtime.getState?.('codex', sessionId);
        if (chatRunRegistry.isProcessing(sessionId) || state?.goal?.status === 'active' || ['starting', 'running', 'stopping', 'stopFailed'].includes(state?.phase ?? '')) throw new Error('Confirm the current task has stopped before resolving delivery.');
        if (raw.decision !== 'queue' && raw.decision !== 'discard') throw new Error('Choose queue or discard.');
        sessionDraftsDb.recoverUnknown(numericUserId, sessionId, raw.decision);
      } else {
        sessionDraftsDb.resumeQueue(numericUserId, sessionId);
      }
      sessionRuntimeDb.update(sessionId, { queueHeld: false });
      notifyQueueChanged?.(sessionId);
    } else {
      let action: CodexControlAction;
      if (raw.action === 'steer') {
        if (userId === null || !Number.isSafeInteger(numericUserId) || typeof raw.messageId !== 'string' || typeof raw.expectedTurnId !== 'string') throw new Error('A queued message and target turn are required.');
        const claim = sessionDraftsDb.beginSteer(numericUserId, sessionId, raw.messageId, requestId);
        if (!claim.queuedMessage) {
          return { ...response, ok: claim.status === 'accepted', delivery: claim.status, error: claim.error,
            codexState: runtime.getState?.('codex', sessionId) };
        }
        steering = true;
        const message = claim.queuedMessage as AnyRecord;
        action = { action: 'steer', expectedTurnId: raw.expectedTurnId, requestId, content: typeof message.content === 'string' ? message.content : '',
          attachments: filterAttachments(message.attachments ?? message.images) };
      } else {
        action = parseControl(raw);
      }
      // Opening or reconnecting a chat requests state even in the SDK runtime.
      if (action.action === 'state') sessionsDb.recordSessionOpened(sessionId);
      if (action.action === 'model-provider') {
        const state = runtime.getState?.('codex', sessionId);
        const currentProvider = state?.modelSelection?.modelProvider ?? state?.activeModelSelection?.modelProvider;
        if (action.modelProvider !== currentProvider && (chatRunRegistry.isProcessing(sessionId)
          || runtime.hasBackgroundWork(sessionId) || state?.goal?.status === 'active'
          || ['starting', 'running', 'stopping', 'stopFailed'].includes(state?.phase ?? '')
          || sessionDraftsDb.hasQueuedMessages(sessionId))) {
          throw new AppError('Finish running tasks and empty the message queue before switching model services.', {
            code: 'CODEX_MODEL_PROVIDER_BUSY', statusCode: 409,
          });
        }
      }
      const run = chatRunRegistry.getRun(sessionId) ?? chatRunRegistry.startRun({ appSessionId: sessionId, provider: 'codex',
        providerSessionId: session.provider_session_id, connection, userId, passive: true })!;
      run.writer.updateWebSocket(connection);
      const options = { ...(input.options ?? {}), sessionId, cwd: session.project_path, projectPath: session.project_path };
      await runtime.control('codex', sessionId, action, options, run.writer);
      if (steering) sessionDraftsDb.finishSteer(numericUserId, sessionId, requestId, 'accepted');
    }
    return { ...response, ok: true, delivery: steering ? 'accepted' : undefined,
      codexState: runtime.getState?.('codex', sessionId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only an explicit RPC rejection proves non-delivery; disconnects and timeouts remain held.
    const uncertain = steering && !(error instanceof AppError && ['STALE_TURN', 'CODEX_APP_SERVER_REJECTED', 'UNSUPPORTED_RUNTIME_CONTROL', 'CODEX_MODEL_REQUIRED'].includes(error.code));
    const delivery = steering && sessionId ? sessionDraftsDb.finishSteer(numericUserId, sessionId, requestId, uncertain ? 'unknown' : 'rejected', message) : undefined;
    return { ...response, ok: delivery === 'accepted', error: delivery === 'accepted' ? undefined : message, delivery,
      codexState: sessionId ? runtime.getState?.('codex', sessionId) : undefined };
  }
}
