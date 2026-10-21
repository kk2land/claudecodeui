import { sessionRuntimeDb, sessionsDb } from '@/modules/database/index.js';
import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { codexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import type { IProviderRuntime } from '@/shared/index.js';
import { AppError, createNormalizedMessage } from '@/shared/index.js';

type RouterDependencies = {
  native: Pick<typeof codexAppServerRuntime, 'run' | 'abort' | 'getState' | 'control' | 'listActiveSessions' | 'permissions' | 'close' | 'isBusy' | 'releaseSession'>;
  sdk: IProviderRuntime;
  settings: Pick<typeof sessionRuntimeDb, 'get' | 'update' | 'holdCodexAppServerQueues'>;
  isCodexSession(sessionId: string): boolean;
  isStopping(): boolean;
  stop(): Promise<void>;
};

/** CodexProvider and provider tests use this dispatcher with isolated lifecycle dependencies. */
export function createCodexRuntimeRouter(overrides: Partial<RouterDependencies> = {}): IProviderRuntime {
  const { native, sdk, settings, stop, isStopping, isCodexSession } = {
    native: codexAppServerRuntime, sdk: codexRuntime, settings: sessionRuntimeDb,
    stop: () => codexAppServerTransport.stop(),
    isStopping: () => codexAppServerTransport.isStopping,
    isCodexSession: (sessionId: string) => sessionsDb.getSessionById(sessionId)?.provider === 'codex',
    ...overrides,
  };
  // A live SDK run stays addressable even if the user's default selection changes.
  const sdkSessions = new Set<string>();
  // Runtime handoff must exclude both new sends and concurrent control mutations.
  const switchingSessions = new Set<string>();
  // Reconnect/history polling must not undo an explicit process stop.
  let processStopped = false;
  // Exclude native sends and controls until the shared process confirms exit.
  let stopping: Promise<void> | null = null;
  // A process stop cancels runtime handoffs that were already awaiting unload.
  let stopVersion = 0;
  const assertNotSwitching = (sessionId: string) => {
    if (switchingSessions.has(sessionId)) throw new AppError('Wait for the runtime change to finish.', { code: 'CODEX_RUNTIME_BUSY', statusCode: 409 });
  };
  return {
    async run(command, options, writer, context) {
      assertNotSwitching(options.sessionId);
      const mode = options.sessionId ? settings.get(options.sessionId).runtime : process.env.CLOUDCLI_CODEX_RUNTIME_MODE ?? 'app-server';
      if (mode !== 'sdk') {
        if (stopping || isStopping()) throw new AppError('Codex app-server is stopping.', { code: 'CODEX_APP_SERVER_STOPPING', statusCode: 409 });
        processStopped = false;
        return native.run(command, options, writer, context);
      }
      sdkSessions.add(options.sessionId);
      try { return await sdk.run(command, options, writer, context); }
      finally { sdkSessions.delete(options.sessionId); }
    },
    abort(sessionId) {
      return sdkSessions.has(sessionId) ? sdk.abort(sessionId) : native.abort(sessionId);
    },
    getState(sessionId) {
      return { ...native.getState(sessionId), ...settings.get(sessionId) };
    },
    isQueueBlocked(sessionId) {
      const state = native.getState(sessionId);
      // Queue resume may clear the persisted hold while SIGTERM is still pending.
      // The gateway asks every provider, so keep this process-wide gate Codex-only.
      if ((stopping || isStopping()) && settings.get(sessionId).runtime === 'app-server' && isCodexSession(sessionId)) return true;
      return Boolean(state.queueHeld || state.goal?.status === 'active'
        || ['starting', 'running', 'stopping', 'stopFailed'].includes(state.phase));
    },
    async control(sessionId, action, options, writer, context) {
      const current = native.getState(sessionId);
      if (action.action === 'state') return { ...current, ...settings.get(sessionId) };
      if (action.action === 'stop-app-server') {
        processStopped = true;
        settings.holdCodexAppServerQueues();
        if (settings.get(sessionId).runtime === 'app-server') settings.update(sessionId, { queueHeld: true });
        if (!stopping) {
          stopVersion++;
          stopping = stop().finally(() => { stopping = null; });
        }
        await stopping;
        return { ...native.getState(sessionId), ...settings.get(sessionId) };
      }
      if (stopping || isStopping()) throw new AppError('Codex app-server is stopping.', { code: 'CODEX_APP_SERVER_STOPPING', statusCode: 409 });
      assertNotSwitching(sessionId);
      if (processStopped && action.action === 'goal' && action.operation === 'get') return { ...current, ...settings.get(sessionId) };
      if (action.action === 'runtime') {
        if (sdkSessions.has(sessionId) || native.isBusy(sessionId)) {
          throw new AppError('Stop this session before changing its runtime.', { code: 'CODEX_RUNTIME_BUSY', statusCode: 409 });
        }
        if (settings.get(sessionId).runtime === action.runtime) return { ...current, ...settings.get(sessionId) };
        const version = stopVersion;
        switchingSessions.add(sessionId);
        try {
          await native.releaseSession(sessionId, context.resolveProviderSessionId(sessionId));
          if (version !== stopVersion) throw new Error('The runtime change was cancelled by stopping app-server.');
          if (action.runtime === 'app-server') {
            // Restore the persisted goal and history immediately, including the
            // paused-goal controls, before publishing the completed handoff.
            await native.control(sessionId, { action: 'goal', operation: 'get' }, options, writer, context);
            if (version !== stopVersion) throw new Error('The runtime change was cancelled by stopping app-server.');
            processStopped = false;
          }
          settings.update(sessionId, { runtime: action.runtime });
          return { ...native.getState(sessionId), ...settings.get(sessionId) };
        } finally {
          switchingSessions.delete(sessionId);
          writer.send(createNormalizedMessage({ provider: 'codex', sessionId, kind: 'status', text: 'codex_control',
            codexState: { ...native.getState(sessionId), ...settings.get(sessionId) } }));
        }
      }
      if (settings.get(sessionId).runtime === 'sdk') {
        if (action.action === 'goal' && action.operation === 'get') return { ...current, ...settings.get(sessionId) };
        throw new AppError('This action requires the Codex app-server runtime.', { code: 'UNSUPPORTED_RUNTIME_CONTROL', statusCode: 409 });
      }
      if (action.action === 'goal' && ['set', 'resume'].includes(action.operation)) processStopped = false;
      return native.control(sessionId, action, options, writer, context);
    },
    listActiveSessions: () => native.listActiveSessions(),
    permissions: native.permissions,
    close: () => native.close(),
  };
}

/** CodexProvider uses this dispatcher; SDK and native controls never silently fall back to each other. */
export const codexRuntimeRouter = createCodexRuntimeRouter();
