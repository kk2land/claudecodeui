import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { codexRateLimitsService } from '@/modules/providers/list/codex/codex-rate-limits.service.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

/** Mounts the real providers router, so route parsing and error mapping are exercised. */
async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const snapshot = {
  weekly: { remainingPercent: 75, resetsAt: 1_800_000_000 },
  fiveHour: { remainingPercent: 60, resetsAt: 1_700_000_600 },
  updatedAt: 1_700_000_000_000,
  stale: false,
};

test('GET /codex/rate-limits serves the cache without invoking a refresh', async (t) => {
  const getState = t.mock.method(codexRateLimitsService, 'getState', () => ({ enabled: true, snapshot }));
  const refresh = t.mock.method(codexRateLimitsService, 'refresh');
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/providers/codex/rate-limits`);
      assert.equal(response.status, 200);
      const body = await response.json() as { data: unknown };
      assert.deepEqual(body.data, { enabled: true, snapshot });
      assert.equal(getState.mock.callCount(), 1);
      // Reading the cache must never ask the app-server for quota.
      assert.equal(refresh.mock.callCount(), 0);
    });
  } finally {
    getState.mock.restore();
    refresh.mock.restore();
  }
});

test('POST /codex/rate-limits/refresh returns the refreshed snapshot', async (t) => {
  const refresh = t.mock.method(codexRateLimitsService, 'refresh', async () => snapshot);
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/providers/codex/rate-limits/refresh`, { method: 'POST' });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json() as { data: unknown }).data, snapshot);
      assert.equal(refresh.mock.callCount(), 1);
    });
  } finally {
    refresh.mock.restore();
  }
});

test('POST /codex/rate-limits/refresh surfaces the disabled refusal as 403', async (t) => {
  const refresh = t.mock.method(codexRateLimitsService, 'refresh', async () => {
    throw new AppError('Codex rate limits are disabled.', { code: 'CODEX_RATE_LIMITS_DISABLED', statusCode: 403 });
  });
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/providers/codex/rate-limits/refresh`, { method: 'POST' });
      assert.equal(response.status, 403);
      const body = await response.json() as { error: { code: string } };
      assert.equal(body.error.code, 'CODEX_RATE_LIMITS_DISABLED');
    });
  } finally {
    refresh.mock.restore();
  }
});

test('POST /codex/rate-limits/refresh reports a failed read as 502', async (t) => {
  const refresh = t.mock.method(codexRateLimitsService, 'refresh', async () => {
    throw new AppError('Could not refresh Codex rate limits: offline', {
      code: 'CODEX_RATE_LIMITS_REFRESH_FAILED', statusCode: 502,
    });
  });
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/providers/codex/rate-limits/refresh`, { method: 'POST' });
      assert.equal(response.status, 502);
      const body = await response.json() as { error: { code: string } };
      assert.equal(body.error.code, 'CODEX_RATE_LIMITS_REFRESH_FAILED');
    });
  } finally {
    refresh.mock.restore();
  }
});

test('GET /codex/rate-limits hides the cache entirely while the deployment is disabled', async (t) => {
  // A seeded cache must not leak through the endpoint once the flag is off.
  const getState = t.mock.method(codexRateLimitsService, 'getState', () => ({ enabled: false, snapshot: null }));
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/providers/codex/rate-limits`);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json() as { data: unknown }).data, { enabled: false, snapshot: null });
    });
  } finally {
    getState.mock.restore();
  }
});

test('GET /codex/rate-limits reports an expired snapshot as stale', async (t) => {
  const expired = {
    weekly: { remainingPercent: 75, resetsAt: 1_700_000_000 },
    fiveHour: null,
    updatedAt: 1_700_000_000_000,
    stale: true,
  };
  const getState = t.mock.method(codexRateLimitsService, 'getState', () => ({ enabled: true, snapshot: expired }));
  const refresh = t.mock.method(codexRateLimitsService, 'refresh');
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/providers/codex/rate-limits`);
      const body = await response.json() as { data: { snapshot: { stale: boolean; weekly: { remainingPercent: number } } } };
      assert.equal(body.data.snapshot.stale, true);
      // The expired window keeps its value; it is not restored to 100%.
      assert.equal(body.data.snapshot.weekly.remainingPercent, 75);
      assert.equal(refresh.mock.callCount(), 0);
    });
  } finally {
    getState.mock.restore();
    refresh.mock.restore();
  }
});
