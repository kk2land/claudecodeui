// pluginsRoutes: used by the server entrypoint to mount protected plugin-management endpoints.
export { pluginsRoutes } from './plugins.module.js';

// startEnabledPluginServers: used by the server entrypoint to start enabled plugin subprocesses.
export { startEnabledPluginServers } from './plugin-process.service.js';
// stopAllPlugins: used by the server entrypoint to stop plugin subprocesses during shutdown.
export { stopAllPlugins } from './plugin-process.service.js';
// getPluginPort: used by WebSocket setup in the server entrypoint to proxy plugin connections.
export { getPluginPort } from './plugin-process.service.js';
// ensurePluginServer: used by the Worker bridge to start an enabled bundled plugin before owner registration.
export { ensurePluginServer } from './plugin-process.service.js';
// isPluginEnabled: used by the Worker bridge and MCP proxy to honor the plugin enable switch.
export { isPluginEnabled } from './plugin-process.service.js';
// sendPluginMessage: used by the Worker bridge to send `cloudcli-workers` IPC requests.
export { sendPluginMessage } from './plugin-process.service.js';
// onPluginMessage: used by the Worker bridge to receive IPC responses and events.
export { onPluginMessage } from './plugin-process.service.js';
// onPluginExit: used by the Worker bridge to settle in-flight requests when the plugin exits.
export { onPluginExit } from './plugin-process.service.js';
// onPluginReady: used by the Worker bridge to re-register owners after a managed restart.
export { onPluginReady } from './plugin-process.service.js';
