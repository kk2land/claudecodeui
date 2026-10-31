import type { CodexWorkerBridge, DshWorkerBridge } from '@/shared/index.js';

import { codexAppServerRuntime } from './list/codex/codex-app-server.runtime.js';
import { codexAppServerTransport } from './list/codex/codex-app-server.transport.js';
import type { DshRuntimeProvider } from './list/dsh/dsh-runtime.provider.js';
import { providerRegistry } from './provider.registry.js';

export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';

// sessionRetentionService: server bootstrap owns daily cleanup and shutdown ordering.
export { sessionRetentionService } from './services/session-retention.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to initialize
// pending titles and resolve edited messages' provider-owned resume points.
export { sessionsService } from './services/sessions.service.js';

// codexRateLimitsService: used by the Codex rate-limit routes (cache + manual
// refresh) and by the server bootstrap, which broadcasts its updates on the
// existing authenticated chat websocket.
export { codexRateLimitsService } from './list/codex/codex-rate-limits.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';


// setCodexWorkerBridge: used by the server composition root to inject Worker
// lifecycle callbacks without providers importing the workers module.
export function setCodexWorkerBridge(bridge: CodexWorkerBridge | null, mcpUrl?: string): void {
  codexAppServerRuntime.setWorkerBridge(bridge);
  codexAppServerTransport.setWorkerMcpUrl(mcpUrl ?? null);
}

/** Server bootstrap injects DSH's Worker callbacks without a providers-to-workers runtime dependency. */
export function setDshWorkerBridge(bridge: DshWorkerBridge | null): void {
  (providerRegistry.resolveProvider('dsh').runtime as DshRuntimeProvider).setWorkerBridge(bridge);
}
