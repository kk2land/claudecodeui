/**
 * The Browser Use MCP stdio entrypoint used to be started here. The feature is
 * retired for every instance role, so the CLI command now reports the closure
 * and exits instead of keeping an MCP process alive or exposing its tools.
 */
export async function startBrowserUseMcp(): Promise<void> {
  console.error('Browser Use is no longer available.');
}

// getBrowserUseRuntime: used by Browser Use services and environment-mode regression coverage.
export { getBrowserUseRuntime } from './browser-use-runtime.js';
