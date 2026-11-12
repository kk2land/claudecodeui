import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { asyncHandler } from '@/shared/utils.js';

import {
  createStageLogMcpServer,
  type StageLogMcpService,
} from './stage-log-mcp.service.js';

/**
 * Stable host MCP endpoint for stage logs. Stateless JSON responses, authenticated by the
 * temporary bearer token the adapters injected; independent of the scheduler plugin process and
 * of general API auth. Mounted before the authenticated routes by the server composition root.
 */
export function createStageLogMcpRouter(dependencies: {
  service: StageLogMcpService;
  isEnabled(): boolean;
  isReady(): boolean;
}): express.Router {
  const router = express.Router();

  router.post('/', asyncHandler(async (req, res) => {
    // Gate: the plugin switch plus a ready logger. The plugin port/IPC is deliberately not
    // required — resident recovery runs before the plugin process starts.
    if (!dependencies.isEnabled() || !dependencies.isReady()) {
      res.status(503).json({
        error: { code: 'STAGE_LOG_UNAVAILABLE', message: 'Stage logging is unavailable.' },
      });
      return;
    }
    const owner = dependencies.service.authorize(req.headers.authorization);
    if (!owner) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Stage log token is not valid.' },
      });
      return;
    }
    const server = createStageLogMcpServer(dependencies.service, owner);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: 'MCP_FAILED',
            message: error instanceof Error ? error.message : 'Stage log call failed.',
          },
        });
      }
    }
  }));

  router.all('/', (_req, res) => {
    res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } });
  });

  return router;
}
