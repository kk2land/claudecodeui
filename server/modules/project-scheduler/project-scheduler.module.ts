import type { ProviderRuntimeGateway, ResidentIpcEvent } from '@/shared/index.js';
import { isPluginEnabled } from '@/modules/plugins/index.js';
import { requestQueuedMessageDispatch } from '@/modules/scheduled-messages/index.js';
import {
  broadcastSessionRemoved,
  broadcastSessionUpserted,
  setResidentProjectionReader,
  startResidentContinueTurn,
} from '@/modules/websocket/index.js';

import { createStageLogMcpService } from './stage-log-mcp.service.js';
import { createStageLogMcpRouter } from './stage-log-mcp.routes.js';
import { createStageLogService } from './stage-log.service.js';
import { readResidentSessionInfo } from './resident-session-projection.js';
import { createResidentHostService } from './resident-host.service.js';
import { createResidentIpcService } from './resident-ipc.service.js';

/**
 * Composition root for the resident ("常驻") host.
 *
 * The server entrypoint mounts it after the websocket server and before the
 * scheduled-messages dispatcher starts, passes `onSessionSettled` into that
 * dispatcher, and calls `recover()` once after bootstrap. Providers never
 * import this module, keeping the runtime graph acyclic.
 */
export function createProjectSchedulerModule(options: {
  runtime: ProviderRuntimeGateway;
  /** Stable URL the adapters inject as their stage-log MCP endpoint (tests may omit it). */
  mcpUrl?: string;
  /** Plugin enable switch; the MCP gate must not depend on the plugin process/port. */
  isPluginEnabled?: () => boolean;
}) {
  const pluginEnabled = options.isPluginEnabled ?? (() => isPluginEnabled('project-scheduler'));
  const logs = createStageLogService();
  const logMcp = createStageLogMcpService({
    logs,
    resolveMcpUrl: () => options.mcpUrl ?? '',
    isEnabled: pluginEnabled,
  });
  let logReady = true;
  // Late bound so the host can emit through the IPC service created from it.
  let emitEvent: (event: ResidentIpcEvent) => void = () => undefined;
  const host = createResidentHostService({
    runtime: options.runtime,
    isPluginEnabled: () => isPluginEnabled('project-scheduler'),
    emitEvent: (event) => emitEvent(event),
    continueTurn: (input) => startResidentContinueTurn(
      { ...input, userId: null },
      { runtime: options.runtime, notifyQueueChanged: requestQueuedMessageDispatch },
    ),
    requestQueueDispatch: (sessionId) => requestQueuedMessageDispatch(sessionId),
    // Only a re-shown session is announced; a hidden one has no removal frame.
    announceSession: (sessionId) => {
      void broadcastSessionUpserted(sessionId).catch(() => undefined);
    },
    announceSessionRemoved: (sessionId, projectId) => broadcastSessionRemoved(sessionId, projectId),
    logSystem: (input) => { logs.recordSystem(input); },
    logs: (query) => logs.list(query),
  });
  const ipc = createResidentIpcService(host);
  emitEvent = (event) => ipc.emit(event);

  return {
    host,
    /** Provider adapters inject this temporary MCP connection (W6 receives it via its setter). */
    logBridge: {
      prepareSession: (input: Parameters<typeof logMcp.prepareSession>[0]) => logMcp.prepareSession(input),
      closeRuntime: (runtimeInstanceId: string) => logMcp.closeRuntime(runtimeInstanceId),
    },
    /** Mounted by the server root before general API auth. */
    mcpRouter: createStageLogMcpRouter({
      service: logMcp,
      isEnabled: pluginEnabled,
      isReady: () => logReady,
    }),
    /** Watches run admissions and the plugin IPC channel; idempotent. */
    initialize(): void {
      host.initialize();
      logs.start();
      ipc.start();
      // The session delta carries the live resident projection so an adopted or
      // removed task updates the sidebar without a manual refresh.
      setResidentProjectionReader(readResidentSessionInfo);
    },
    /** Resumes only bindings that were running and enabled when the host stopped. */
    async recover(): Promise<void> {
      ipc.start();
      await host.recoverAfterRestart();
    },
    async shutdown(): Promise<void> {
      logReady = false;
      logs.stop();
      ipc.stop();
      await host.shutdown();
    },
  };
}
