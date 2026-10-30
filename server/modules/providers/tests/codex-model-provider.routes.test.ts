import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { AppError } from '@/shared/utils.js';

test('the Codex default-provider route validates input and returns the safe directory', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-route-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(home, { recursive: true, force: true });
  });

  // The service captures CODEX_HOME when the route module loads, so the
  // environment is set before this dynamic import.
  const { default: providerRouter } = await import('@/modules/providers/provider.routes.js');
  const original = [
    'model = "gpt-5"',
    '[model_providers.alpha]',
    'name = "Alpha service"',
    'base_url = "https://alpha.example/v1"',
    '',
  ].join('\n');
  await writeFile(path.join(home, 'config.toml'), original);

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
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/codex/model-providers`;
    const initial = await fetch(baseUrl);
    assert.deepEqual((await initial.json() as { data: unknown }).data, {
      defaultProvider: 'openai', hasCustomProviders: true,
      providers: [{ id: 'openai', name: 'OpenAI' }, { id: 'alpha', name: 'Alpha service' }],
    });

    const saved = await fetch(`${baseUrl}/default`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelProvider: '  alpha  ' }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json() as { data: unknown }).data, {
      defaultProvider: 'alpha', hasCustomProviders: true,
      providers: [{ id: 'openai', name: 'OpenAI' }, { id: 'alpha', name: 'Alpha service' }],
    });
    const withAlpha = original.replace('[model_providers.alpha]', 'model_provider = "alpha"\n[model_providers.alpha]');
    assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), withAlpha);

    for (const [body, status, code] of [
      [{}, 400, 'CODEX_MODEL_PROVIDER_REQUIRED'],
      [{ modelProvider: '   ' }, 400, 'CODEX_MODEL_PROVIDER_REQUIRED'],
      [{ modelProvider: 42 }, 400, 'CODEX_MODEL_PROVIDER_REQUIRED'],
      [[], 400, 'INVALID_REQUEST_BODY'],
      [{ modelProvider: 'missing' }, 404, 'CODEX_MODEL_PROVIDER_NOT_FOUND'],
    ] as const) {
      const response = await fetch(`${baseUrl}/default`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, status);
      assert.equal((await response.json() as { error: { code: string } }).error.code, code);
      assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), withAlpha);
    }

    const cleared = await fetch(`${baseUrl}/default`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelProvider: 'openai' }),
    });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json() as { data: { defaultProvider: string } }).data.defaultProvider, 'openai');
    assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), original);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
