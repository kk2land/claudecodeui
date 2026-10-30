import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createWorkerControlRouter } from '../worker-control.routes.js';
import type { WorkerCancelFenceInput } from '@/shared/index.js';

function listen(app: express.Express): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: typeof address === 'object' && address ? address.port : 0, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('the real UI cancel path fences the host owner before the generic plugin proxy runs', async () => {
  const fenced: WorkerCancelFenceInput[] = [];
  const forwarded: Array<{ path: string; body: unknown }> = [];
  const app = express();
  app.use(express.json());
  app.use('/api/plugins/worker/rpc', createWorkerControlRouter({ fenceCancel: (input) => { fenced.push(input); return 1; } }));
  // Stands in for the existing generic /api/plugins/:name/rpc/* proxy.
  app.all('/api/plugins/:name/rpc/*', (req, res) => {
    forwarded.push({ path: req.originalUrl, body: req.body });
    res.json({ ok: true });
  });
  const server = await listen(app);
  try {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = JSON.stringify({ all: true, parentSessionId: 'session-1', projectId: 'project-1', pause: true });
      const req = http.request({
        hostname: '127.0.0.1', port: server.port, method: 'POST',
        path: '/api/plugins/worker/rpc/cancel',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += String(chunk); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assert.equal(response.status, 200);
    assert.deepEqual(fenced, [{ all: true, parentSessionId: 'session-1', projectId: 'project-1', pause: true }]);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].path, '/api/plugins/worker/rpc/cancel');
    assert.deepEqual(forwarded[0].body, { all: true, parentSessionId: 'session-1', projectId: 'project-1', pause: true });
  } finally {
    await server.close();
  }
});
