import { sessionRuntimeDb } from '@/modules/database/index.js';
import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { codexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import type { IProviderRuntime } from '@/shared/index.js';
import { AppError, createNormalizedMessage } from '@/shared/index.js';

type RouterDependencies = {
  native: Pick<typeof codexAppServerRuntime, 'run' | 'abort' | 'getState' | 'control' | 'listActiveSessions' | 'permissions' | 'close' | 'isBusy' | 'releaseSession' | 'resetAfterRestart'>;
  sdk: IProviderRuntime;
  settings: Pick<typeof sessionRuntimeDb, 'get' | 'update'>;
  restart(): Promise<void>;
};

/** CodexProvider and provider tests use this dispatcher with isolated lifecycle dependencies. */
export function createCodexRuntimeRouter(overrides: Partial<RouterDependencies> = {}): IProviderRuntime {
  const { native, sdk, settings, restart } = {
    native: codexAppServerRuntime, sdk: codexRuntime, settings: sessionRuntimeDb,
    restart: () => codexAppServerTransport.restart(), ...overrides,
  };
  // A live SDK run stays addressable even if the user's default selection changes.
  const sdkSessions = new Set<string>();
  // Runtime handoff must exclude both new sends and concurrent control mutations.
  const switchingSessions = new Set<string>();
  const assertNotSwitching = (sessionId: string) => {
    if (switchingSessions.has(sessionId)) throw new AppError('Wait for the runtime change to finish.', { code: 'CODEX_RUNTIME_BUSY', statusCode: 409 });
  };
  return {
    async run(command, options, writer, context) {
      assertNotSwitching(options.sessionId);
      const mode = options.sessionId ? settings.get(options.sessionId).runtime : process.env.CLOUDCLI_CODEX_RUNTIME_MODE ?? 'app-server';
      if (mode !== 'sdk') return native.run(command, options, writer, context);
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
    async control(sessionId, action, options, writer, context) {
      const current = native.getState(sessionId);
      if (action.action === 'state') return { ...current, ...settings.get(sessionId) };
      assertNotSwitching(sessionId);
      if (action.action === 'restart') {
        if (sdkSessions.size || switchingSessions.size || native.isBusy()) throw new Error('Stop all Codex sessions before restarting app-server.');
        await restart();
        native.resetAfterRestart();
        return { ...native.getState(sessionId), ...settings.get(sessionId) };
      }
      if (action.action === 'runtime') {
        if (sdkSessions.has(sessionId) || native.isBusy(sessionId)) {
          throw new AppError('Stop this session before changing its runtime.', { code: 'CODEX_RUNTIME_BUSY', statusCode: 409 });
        }
        if (settings.get(sessionId).runtime === action.runtime) return { ...current, ...settings.get(sessionId) };
        switchingSessions.add(sessionId);
        try {
          await native.releaseSession(sessionId, context.resolveProviderSessionId(sessionId));
          if (action.runtime === 'app-server') {
            // Restore the persisted goal and history immediately, including the
            // paused-goal controls, before publishing the completed handoff.
            await native.control(sessionId, { action: 'goal', operation: 'get' }, options, writer, context);
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
      return native.control(sessionId, action, options, writer, context);
    },
    listActiveSessions: () => native.listActiveSessions(),
    permissions: native.permissions,
    close: () => native.close(),
  };
}

/** CodexProvider uses this dispatcher; SDK and native controls never silently fall back to each other. */
export const codexRuntimeRouter = createCodexRuntimeRouter();
