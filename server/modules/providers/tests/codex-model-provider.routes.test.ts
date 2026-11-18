import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { codexModelProviderService } from '@/modules/providers/list/codex/codex-model-provider.service.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import type { CodexModelProviderPatch, CodexModelProviders } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Mounts the real providers router, so parsing, status codes and the response
 * envelope are exercised. The service is mocked: these tests never start the
 * app-server or read the machine's Codex configuration.
 */
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
    await run(`http://127.0.0.1:${address.port}/api/providers/codex/model-providers`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const directory: CodexModelProviders = {
  defaultProvider: 'openai',
  hasCustomProviders: true,
  canChangeDefault: true,
  providers: [
    { id: 'openai', name: 'OpenAI', baseUrl: null, canEdit: false, settings: { type: 'openai' } },
    {
      id: 'alpha', name: 'Alpha service', baseUrl: 'https://alpha.example/v1', canEdit: true,
      settings: { type: 'customGateway', auth: { mode: 'environmentVariable', envKey: 'ALPHA_TOKEN' } },
    },
  ],
};

const provider = directory.providers[1];

const post = (baseUrl: string, body: unknown) => fetch(baseUrl, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const patch = (baseUrl: string, id: string, body: unknown) => fetch(`${baseUrl}/${encodeURIComponent(id)}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('GET /codex/model-providers serves the service directory unchanged', async (t) => {
  const list = t.mock.method(codexModelProviderService, 'list', async () => directory);
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(baseUrl);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true, data: directory });
      assert.equal(list.mock.callCount(), 1);
    });
  } finally {
    list.mock.restore();
  }
});

test('PUT /codex/model-providers/default trims the id and validates the body once', async (t) => {
  const setDefault = t.mock.method(codexModelProviderService, 'setDefault', async () => ({
    ...directory, defaultProvider: 'alpha',
  }));
  try {
    await withServer(async (baseUrl) => {
      const saved = await fetch(`${baseUrl}/default`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelProvider: '  alpha  ' }),
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json() as { data: CodexModelProviders }).data.defaultProvider, 'alpha');
      assert.deepEqual(setDefault.mock.calls.map((call) => call.arguments), [['alpha']]);

      for (const body of [{}, { modelProvider: '   ' }, { modelProvider: 42 }, []]) {
        const response = await fetch(`${baseUrl}/default`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        assert.ok(response.status === 400, `expected 400 for ${JSON.stringify(body)}`);
      }
      // Rejected bodies never reached the service.
      assert.equal(setDefault.mock.callCount(), 1);
    });
  } finally {
    setDefault.mock.restore();
  }
});

test('POST /codex/model-providers forwards an identity-less custom gateway with 201', async (t) => {
  const create = t.mock.method(codexModelProviderService, 'create', async () => provider);
  try {
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, {
        settings: { type: 'customGateway', name: 'Alpha service', baseUrl: 'https://alpha.example/v1', envKey: 'ALPHA_TOKEN' },
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { success: true, data: { provider } });
      assert.deepEqual(create.mock.calls.map((call) => call.arguments), [[{
        type: 'customGateway', name: 'Alpha service', baseUrl: 'https://alpha.example/v1', envKey: 'ALPHA_TOKEN',
      }]]);

      // An explicit null provider id is kept as a clear, not dropped.
      await post(baseUrl, { settings: { type: 'customGateway', providerId: null, name: 'Alpha service' } });
      assert.deepEqual(create.mock.calls[1].arguments[0], {
        type: 'customGateway', providerId: null, name: 'Alpha service',
      });
    });
  } finally {
    create.mock.restore();
  }
});

test('POST /codex/model-providers rejects unsupported settings without calling the service', async (t) => {
  const create = t.mock.method(codexModelProviderService, 'create');
  try {
    await withServer(async (baseUrl) => {
      const cases: Array<[unknown, number]> = [
        [[], 400],
        [{}, 400],
        [{ settings: 'custom' }, 400],
        [{ settings: { type: 'openai' } }, 400],
        [{ settings: { type: 'bedrock', providerId: 'openai' } }, 400],
        [{ settings: { type: 'gcp', providerId: 'amazon-bedrock' } }, 400],
        [{ settings: { type: 'customGateway', name: 42 } }, 400],
        [{ settings: { type: 'customGateway', baseUrl: 42 } }, 400],
        // Unknown native patch keys are refused instead of silently dropped.
        [{ settings: { type: 'customGateway', baseURI: 'https://alpha.example/v1' } }, 400],
      ];
      for (const [body, status] of cases) {
        const response = await post(baseUrl, body);
        assert.equal(response.status, status, `unexpected status for ${JSON.stringify(body)}`);
      }
      assert.equal(create.mock.callCount(), 0);
    });
  } finally {
    create.mock.restore();
  }
});

test('PATCH /codex/model-providers/:id forwards the path id and keeps omitted fields omitted', async (t) => {
  const update = t.mock.method(codexModelProviderService, 'update', async () => provider);
  try {
    await withServer(async (baseUrl) => {
      const response = await patch(baseUrl, 'amazon-bedrock', {
        settings: { type: 'bedrock', providerId: 'amazon-bedrock', region: 'us-east-1', profile: null },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true, data: { provider } });
      assert.deepEqual(update.mock.calls[0].arguments, ['amazon-bedrock', {
        type: 'bedrock', providerId: 'amazon-bedrock', region: 'us-east-1', profile: null,
      } satisfies CodexModelProviderPatch]);

      // `undefined` never appears from JSON; a missing field stays absent.
      await patch(baseUrl, 'gcp', { settings: { type: 'gcp', providerId: 'gcp' } });
      assert.deepEqual(update.mock.calls[1].arguments, ['gcp', { type: 'gcp', providerId: 'gcp' }]);

      const trimmed = await patch(baseUrl, '  alpha  ', { settings: { type: 'customGateway', name: 'Renamed' } });
      assert.equal(trimmed.status, 200);
      assert.deepEqual(update.mock.calls[2].arguments, ['alpha', { type: 'customGateway', name: 'Renamed' }]);
    });
  } finally {
    update.mock.restore();
  }
});

test('PATCH /codex/model-providers/:id returns the service error unchanged', async (t) => {
  const update = t.mock.method(codexModelProviderService, 'update', async () => {
    throw new AppError('The provider id in the body must match the id in the path.', {
      code: 'CODEX_MODEL_PROVIDER_ID_MISMATCH', statusCode: 400,
    });
  });
  try {
    await withServer(async (baseUrl) => {
      const response = await patch(baseUrl, 'alpha', { settings: { type: 'customGateway', providerId: 'beta' } });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        success: false,
        error: { code: 'CODEX_MODEL_PROVIDER_ID_MISMATCH', message: 'The provider id in the body must match the id in the path.' },
      });
    });
  } finally {
    update.mock.restore();
  }
});
