import { residentBindingsDb } from '@/modules/database/index.js';
import { getPluginPort, isPluginEnabled } from '@/modules/plugins/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ResidentSessionInfo } from '@/shared/index.js';

/**
 * Reads the resident metadata the server attaches to its session projections
 * (project lists/pages, the running-sessions feed, and lookup by id).
 *
 * This is the single source for the UI's three-dot menu. It answers from real
 * state on every request — an active registry run and the actual plugin
 * process — instead of a caller-supplied flag, so a running session's menu
 * enables as soon as the projection is refetched and a bound session is never
 * offered again. Both existing Codex runtimes (app-server and the exec/SDK
 * adapter) qualify; the session keeps whatever runtime it is configured with.
 * Real domain guards still live in the host.
 */
export function readResidentSessionInfo(input: {
  sessionId: string;
  provider: string;
}): ResidentSessionInfo | null {
  if (input.provider !== 'codex' && input.provider !== 'dsh') {
    return null;
  }
  const record = residentBindingsDb.getBySessionId(input.sessionId);
  if (record) {
    return {
      taskId: record.taskId,
      status: record.status,
      enabled: record.enabled,
      visible: record.visible,
      adoptable: false,
      blockedReason: 'already_resident',
    };
  }
  // The plugin must be both enabled and actually serving its API: an enabled
  // switch with a crashed process cannot accept adoption.
  const pluginReady = isPluginEnabled('project-scheduler')
    && Boolean(getPluginPort('project-scheduler'));
  const activeRun = chatRunRegistry.isProcessing(input.sessionId);
  if (!pluginReady) {
    return {
      taskId: null,
      status: null,
      enabled: false,
      visible: false,
      adoptable: false,
      blockedReason: 'plugin_unavailable',
    };
  }
  return {
    taskId: null,
    status: null,
    enabled: false,
    visible: false,
    adoptable: activeRun,
    blockedReason: activeRun ? null : 'not_running',
  };
}
