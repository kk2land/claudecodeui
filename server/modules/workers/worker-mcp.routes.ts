import http from 'node:http';

import express from 'express';

import type { WorkerHostService } from '@/shared/index.js';

/** Header allowlist that carries MCP authentication, protocol negotiation and resumption. */
const FORWARDED_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const;

/**
 * Stable host-side MCP endpoint. The bearer token is issued by `prepareSession`
 * and verified by the plugin itself; the host proxy never authenticates an
 * anonymous request by starting the plugin.
 */
export function createWorkerMcpRouter(dependencies: {
  host: WorkerHostService;
  isEnabled(): boolean;
  getPort(): number | null;
}): express.Router {
  const router = express.Router();

  router.all('*', async (req, res, next) => {
    if (!dependencies.isEnabled() || !dependencies.host.isReady()) {
      res.status(503).json({ error: { code: 'WORKER_MCP_UNAVAILABLE', message: 'The Worker plugin is not ready.' } });
      return;
    }
    const port = dependencies.getPort();
    if (!port) {
      res.status(503).json({ error: { code: 'WORKER_MCP_UNAVAILABLE', message: 'The Worker plugin is not ready.' } });
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const body = req.body === undefined || req.method === 'GET' || req.method === 'HEAD'
      ? null
      : Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    if (body) headers['content-length'] = String(body.length);
    const path = `/api/worker-mcp${req.url === '/' ? '' : req.url}`;
    const proxyRequest = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: req.method,
      headers,
    }, (proxyResponse) => {
      const responseHeaders = { ...proxyResponse.headers };
      delete responseHeaders.connection;
      delete responseHeaders['transfer-encoding'];
      res.writeHead(proxyResponse.statusCode ?? 502, responseHeaders);
      proxyResponse.pipe(res);
      proxyResponse.on('error', () => res.destroy());
    });
    proxyRequest.on('error', next);
    req.on('aborted', () => proxyRequest.destroy());
    if (body) proxyRequest.write(body);
    proxyRequest.end();
  });

  return router;
}
