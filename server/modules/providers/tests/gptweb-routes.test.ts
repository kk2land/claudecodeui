import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Request, Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { AppError } from '@/shared/index.js';
import type { AnyRecord } from '@/shared/index.js';

// Exercise Express's real route matching and parameter parser without opening
// a listener; only external-service work is stubbed by the individual tests.
function request(method: string, url: string, body: AnyRecord = {}): Promise<{ status: number; body: AnyRecord }> {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: AnyRecord) { resolve({ status: this.statusCode, body: payload }); },
    };
    const router = providerRouter as unknown as {
      handle(req: Request, res: Response, next: (error?: unknown) => void): void;
    };
    router.handle({ method, url, headers: {}, query: {}, body } as Request, response as unknown as Response, error => {
      if (error instanceof AppError) resolve({ status: error.statusCode, body: { error: { code: error.code } } });
      else reject(error ?? new Error(`No route matched ${method} ${url}`));
    });
  });
}

test('provider HTTP parsing accepts every registered provider and rejects unknown names', async () => {
  for (const { id } of providerRegistry.listProviders()) {
    const result = await request('GET', `/${id}/capabilities`);
    assert.equal(result.status, 200, id);
    assert.equal(result.body.data.provider, id);
  }
  const invalid = await request('GET', '/unknown/capabilities');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'UNSUPPORTED_PROVIDER');
});

test('GPT Web models, auth, MCP and skills routes reach their owning services', async t => {
  const calls: string[] = [];
  t.mock.method(providerModelsService, 'getProviderModels', async (provider: string) => {
    calls.push(`models:${provider}`);
    return { OPTIONS: [{ value: 'chatgpt-web/test', label: 'Test' }], DEFAULT: 'chatgpt-web/test' };
  });
  t.mock.method(providerAuthService, 'getProviderAuthStatus', async (provider: string) => {
    calls.push(`auth:${provider}`);
    return { provider, installed: true, authenticated: true, email: null, method: 'bridge_catalog' };
  });
  t.mock.method(providerMcpService, 'listProviderMcpServers', async (provider: string) => {
    calls.push(`mcp:${provider}`); return { user: [], project: [], local: [] };
  });
  t.mock.method(providerSkillsService, 'listProviderSkills', async (provider: string) => {
    calls.push(`skills:${provider}`); return [];
  });
  for (const endpoint of ['models', 'auth/status', 'mcp/servers', 'skills']) {
    const result = await request('GET', `/gptweb/${endpoint}`);
    assert.equal(result.status, 200, endpoint);
    assert.equal(result.body.success, true);
  }
  assert.deepEqual(calls, ['models:gptweb', 'auth:gptweb', 'mcp:gptweb', 'skills:gptweb']);
});

test('GPT Web session allocation through the HTTP router persists its provider identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gptweb-routes-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  try {
    await initializeDatabase();
    const result = await request('POST', '/sessions', { provider: 'gptweb', projectPath: root, initialMessage: 'Review this project' });
    assert.equal(result.status, 201);
    const session = sessionsDb.getSessionById(result.body.data.sessionId);
    assert.equal(session?.provider, 'gptweb');
    assert.equal(session?.custom_name, 'Review this project');
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
