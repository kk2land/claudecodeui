import type { StageLogMcpConfig } from '@/shared/index.js';

/**
 * MCP server name for the host's stage logger.
 *
 * Both Codex adapters register the tool under this name so the model sees a
 * single stable `stage_log` tool. It must never collide with the Worker
 * server (`cloudcli_workers`), because the two capabilities are enabled
 * independently.
 */
const STAGE_LOG_MCP_SERVER = 'cloudcli_scheduler';

/**
 * Temporary app-server `thread/start|resume` config for the stage logger.
 *
 * Returns a flat, per-server override (`mcp_servers.cloudcli_scheduler`) so the
 * user's own MCP servers in config.toml stay untouched, and null when the host
 * declined logging so the thread request stays exactly as before.
 */
export function stageLogThreadConfig(connection: StageLogMcpConfig | null): Record<string, unknown> | null {
  if (!connection) return null;
  return {
    [`mcp_servers.${STAGE_LOG_MCP_SERVER}`]: {
      url: connection.url,
      http_headers: { ...connection.headers },
      enabled: true,
    },
  };
}

/**
 * Temporary Codex exec constructor config for the stage logger.
 *
 * The SDK flattens this nested table into `--config` overrides for the child
 * CLI, so the same server table reaches `codex exec` without a ThreadOptions
 * field (which cannot carry MCP configuration). Null leaves the constructor
 * config unchanged.
 */
export function stageLogSdkConfig(connection: StageLogMcpConfig | null): Record<string, unknown> | null {
  if (!connection) return null;
  return {
    mcp_servers: {
      [STAGE_LOG_MCP_SERVER]: {
        url: connection.url,
        http_headers: { ...connection.headers },
        enabled: true,
      },
    },
  };
}
