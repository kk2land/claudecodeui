import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GptwebModelsProvider } from '@/modules/providers/list/gptweb/gptweb-models.provider.js';

const webModel = { slug: 'chatgpt-web/sol', display_name: 'Sol (Web)', visibility: 'list',
  default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] };

test('GPT Web discovers only visible bridge models with their actual effort and profile credentials', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gptweb-models-'));
  try {
    await writeFile(path.join(home, 'config.toml'), 'openai_base_url = "http://127.0.0.1:17841/v1"\nmodel = "chatgpt-web/sol"\n');
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'profile-token', account_id: 'profile-account' } }));
    let requests = 0;
    const models = new GptwebModelsProvider(home, (async (input, init) => {
      requests++;
      const url = new URL(String(input));
      assert.equal(url.pathname, '/v1/models');
      assert.match(url.searchParams.get('client_version')!, /^\d+\.\d+\.\d+/);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer profile-token');
      assert.equal(new Headers(init?.headers).get('chatgpt-account-id'), 'profile-account');
      return Response.json({ models: [
        { slug: 'native-model', visibility: 'list' }, webModel, webModel,
        { ...webModel, slug: 'chatgpt-web/legacy', visibility: 'hide' },
      ] });
    }) as typeof fetch);
    const [one, two] = await Promise.all([models.getSupportedModels(), models.getSupportedModels()]);
    assert.deepEqual(one, { DEFAULT: 'chatgpt-web/sol', OPTIONS: [{ value: 'chatgpt-web/sol', label: 'Sol (Web)', description: undefined,
      effort: { default: 'high', values: [{ value: 'medium' }, { value: 'high' }] } }] });
    assert.deepEqual(two, one);
    assert.deepEqual(await models.getCurrentActiveModel(), { model: 'chatgpt-web/sol' });
    await models.getSupportedModels();
    assert.equal(requests, 1);
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'changed-token' } }));
    await assert.rejects(models.getSupportedModels(), /Cannot reach/);
    assert.equal(requests, 2, 'changed credentials must invalidate the cached catalog');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('GPT Web reads an active custom-provider profile without rewriting configuration', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gptweb-profile-'));
  const original = process.env.GPTWEB_TEST_KEY;
  process.env.GPTWEB_TEST_KEY = 'custom-token';
  try {
    await writeFile(path.join(home, 'config.toml'), `profile = "web"
[profiles.web]
model_provider = "bridge"
[model_providers.bridge]
base_url = "http://localhost:9100/v1/"
env_key = "GPTWEB_TEST_KEY"
`);
    const models = new GptwebModelsProvider(home, (async (input, init) => {
      assert.equal(new URL(String(input)).pathname, '/v1/models');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer custom-token');
      return Response.json({ models: [webModel] });
    }) as typeof fetch);
    assert.equal((await models.getSupportedModels()).DEFAULT, webModel.slug);
  } finally {
    if (original === undefined) delete process.env.GPTWEB_TEST_KEY; else process.env.GPTWEB_TEST_KEY = original;
    await rm(home, { recursive: true, force: true });
  }
});

test('GPT Web reports unavailable or malformed catalogs without using native Codex defaults', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gptweb-errors-'));
  try {
    await writeFile(path.join(home, 'config.toml'), 'openai_base_url = "http://localhost:17841/v1"');
    for (const [response, code] of [
      [new Response(null, { status: 401 }), 'GPTWEB_MODELS_REJECTED'],
      [Response.json({ data: [] }), 'GPTWEB_MODELS_INVALID'],
      [Response.json({ models: [{ slug: 'native-only', visibility: 'list' }] }), 'GPTWEB_MODELS_EMPTY'],
    ] as const) {
      const models = new GptwebModelsProvider(home, (async () => response) as typeof fetch);
      await assert.rejects(models.getSupportedModels(), (error: unknown) => (error as { code: string }).code === code);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
