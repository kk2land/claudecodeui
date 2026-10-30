import type { WorkerHostService, WorkerIpcTransport } from '@/shared/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import {
  ensurePluginServer,
  getPluginPort,
  isPluginEnabled,
  onPluginExit,
  onPluginMessage,
  onPluginReady,
  sendPluginMessage,
} from '@/modules/plugins/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import {
  projectsDb,
  sessionDraftsDb,
  sessionRuntimeDb,
  sessionsDb,
} from '@/modules/database/index.js';

import { createWorkerHostService } from './worker-host.service.js';
import { WorkerIpcClient } from './worker-ipc.client.js';
import { createWorkerControlRouter } from './worker-control.routes.js';
import { createWorkerMcpRouter } from './worker-mcp.routes.js';

/** Bundled plugin name fixed by the Worker manifest and the `cloudcli-workers` IPC channel. */
const WORKER_PLUGIN = 'worker';

/** Production transport over the bundled plugin subprocess in `modules/plugins`. */
function createBundledWorkerTransport(): WorkerIpcTransport {
  return {
    isRunning: () => Boolean(getPluginPort(WORKER_PLUGIN)),
    ensureReady: async () => Boolean(await ensurePluginServer(WORKER_PLUGIN)),
    send: (message) => sendPluginMessage(WORKER_PLUGIN, message),
    onMessage: (listener) => onPluginMessage(WORKER_PLUGIN, listener),
    onExit: (listener) => onPluginExit(WORKER_PLUGIN, listener),
    onReady: (listener) => onPluginReady(WORKER_PLUGIN, listener),
  };
}

/**
 * Composition root for the Worker host bridge. The server entrypoint injects
 * `bridge` into the Codex adapter and mounts `mcpRouter` before JWT routes;
 * providers never import this module, which keeps the runtime graph acyclic.
 */
export function createWorkerModule(options: {
  serverPort: number;
  host?: string;
}): {
  host: WorkerHostService;
  mcpRouter: ReturnType<typeof createWorkerMcpRouter>;
  controlRouter: ReturnType<typeof createWorkerControlRouter>;
  initialize(): void;
  shutdown(): Promise<void>;
} {
  const hostName = options.host ?? '127.0.0.1';
  const ipc = new WorkerIpcClient(createBundledWorkerTransport());
  const host = createWorkerHostService({
    ipc,
    isEnabled: () => isPluginEnabled(WORKER_PLUGIN),
    resolveMcpUrl: () => `http://${hostName}:${options.serverPort}/api/worker-mcp`,
    runtime: providerRuntimeService,
    hasActiveRun: (sessionId) => chatRunRegistry.getRun(sessionId)?.status === 'running',
    sessions: sessionsDb,
    projects: projectsDb,
    drafts: sessionDraftsDb,
    settings: sessionRuntimeDb,
    runTurn: (input) => runDetachedChatTurn({
      sessionId: input.sessionId,
      userId: input.userId,
      content: input.content,
      options: { workerWakeup: true },
      workerSource: input.workerSource,
      finalGuard: input.finalGuard,
    }, { runtime: providerRuntimeService }),
  });
  const mcpRouter = createWorkerMcpRouter({
    host,
    isEnabled: () => isPluginEnabled(WORKER_PLUGIN),
    getPort: () => getPluginPort(WORKER_PLUGIN),
  });
  const controlRouter = createWorkerControlRouter(host);
  return {
    host,
    mcpRouter,
    controlRouter,
    initialize: () => host.initialize(),
    shutdown: () => host.shutdown(),
  };
}

