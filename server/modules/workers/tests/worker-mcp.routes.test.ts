import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/index.js';
import type { WorkerHostService } from '@/shared/index.js';

import { createWorkerMcpRouter } from '../worker-mcp.routes.js';

function listen(app: express.Express): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function request(port: number, options: http.RequestOptions, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, ...options }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += String(chunk); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('the Worker MCP proxy forwards owner auth, body and streaming response', async (t) => {
  const checked: Array<string | undefined> = [];
  const received: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-1' });
      res.write('event: message\n');
      res.end('data: {"ok":true}\n\n');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const address = upstream.address();
  const upstreamPort = typeof address === 'object' && address ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

  const app = express();
  app.use(express.json());
  app.use('/api/worker-mcp', createWorkerMcpRouter({
    host: {
      isReady: () => true,
      assertMcpSkillEnabled: async (authorization) => { checked.push(authorization); },
    } as WorkerHostService,
    isEnabled: () => true,
    getPort: () => upstreamPort,
  }));
  const server = await listen(app);
  t.after(() => server.close());

  const response = await request(server.port, {
    method: 'POST',
    path: '/api/worker-mcp',
    headers: {
      authorization: 'Bearer owner-token',
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
  }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.equal(response.status, 200);
  assert.match(response.body, /data: \{"ok":true\}/);
  assert.equal(received.length, 1);
  assert.deepEqual(checked, ['Bearer owner-token']);
  assert.equal(received[0].url, '/api/worker-mcp');
  assert.equal(received[0].headers.authorization, 'Bearer owner-token');
  assert.equal(received[0].headers['mcp-protocol-version'], '2025-06-18');
  assert.deepEqual(JSON.parse(received[0].body), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
});

test('the Worker MCP proxy rejects disabled skills before forwarding stale tool calls', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api/worker-mcp', createWorkerMcpRouter({
    host: {
      isReady: () => true,
      assertMcpSkillEnabled: async () => {
        throw new AppError('The cloudcli-workers skill is disabled.', { code: 'WORKER_SKILL_DISABLED', statusCode: 403 });
      },
    } as unknown as WorkerHostService,
    isEnabled: () => true,
    getPort: () => 1,
  }));
  app.use((error: AppError, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode).json({ error: { code: error.code } });
  });
  const server = await listen(app);
  t.after(() => server.close());
  for (const name of ['worker_start', 'worker_resume']) {
    const response = await request(server.port, {
      method: 'POST', path: '/api/worker-mcp',
      headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }));
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error.code, 'WORKER_SKILL_DISABLED');
  }
});

test('the Worker MCP proxy never starts or forwards to a disabled plugin', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/worker-mcp', createWorkerMcpRouter({
    host: { isReady: () => false } as WorkerHostService,
    isEnabled: () => false,
    getPort: () => 1,
  }));
  const server = await listen(app);
  try {
    const response = await request(server.port, { method: 'POST', path: '/api/worker-mcp' }, '{}');
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.body).error.code, 'WORKER_MCP_UNAVAILABLE');
  } finally {
    await server.close();
  }
});
