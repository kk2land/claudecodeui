import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';
import type { Router } from 'express';

import browserUseRoutes from '../browser-use.routes.js';
import browserUseMcpRoutes from '../browser-use-mcp.routes.js';

async function requestClosedRoute(
  mountPath: string,
  router: Router,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const app = express().use(express.json()).use(mountPath, router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Browser Use settings and session endpoints are closed with an explicit 403', async () => {
  const settings = await requestClosedRoute('/api/browser-use', browserUseRoutes, '/api/browser-use/settings');

  assert.deepEqual(settings, {
    status: 403,
    body: {
      success: false,
      error: {
        code: 'BROWSER_USE_DISABLED',
        message: 'Browser Use is no longer available.',
      },
    },
  });

  const session = await requestClosedRoute(
    '/api/browser-use',
    browserUseRoutes,
    '/api/browser-use/sessions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );

  assert.equal(session.status, 403);
});

test('the Browser Use MCP bridge is closed before token validation', async () => {
  const response = await requestClosedRoute(
    '/api/browser-use-mcp',
    browserUseMcpRoutes,
    '/api/browser-use-mcp/tools/browser_create_session',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );

  assert.deepEqual(response, {
    status: 403,
    body: {
      success: false,
      error: {
        code: 'BROWSER_USE_DISABLED',
        message: 'Browser Use MCP is no longer available.',
      },
    },
  });
});
