import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexModelProviderService } from '@/modules/providers/list/codex/codex-model-provider.service.js';

const config = `model_provider="alpha"
[model_providers.alpha]
name="Alpha service"
base_url="https://alpha.example/v1/"
env_key="ALPHA_TOKEN"
http_headers={"X-Client"="cloudcli"}
env_http_headers={"X-Workspace"="WORKSPACE"}
query_params={"api-version"="preview"}
[model_providers.beta]
name="Beta service"
base_url="https://beta.example/v1"
experimental_bearer_token="beta-secret"
`;

test('only extra config entries enable the picker; metadata never contains endpoint secrets', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-directory-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const service = new CodexModelProviderService({ home });
  assert.deepEqual(await service.list(), { defaultProvider: 'openai', hasCustomProviders: false, providers: [{ id: 'openai', name: 'OpenAI' }] });
  await writeFile(path.join(home, 'config.toml'), config);
  assert.deepEqual(await service.list(), { defaultProvider: 'alpha', hasCustomProviders: true,
    providers: [{ id: 'openai', name: 'OpenAI' }, { id: 'alpha', name: 'Alpha service' }, { id: 'beta', name: 'Beta service' }] });
  const serialized = JSON.stringify(await service.list());
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('https://'), false);
});

test('the default provider edit preserves comments, CRLF and unrelated model_provider keys', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-default-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = path.join(home, 'config.toml');
  const original = [
    '# keep this comment',
    'model = "gpt-5"',
    '"model_provider" = "beta"   # stay inline',
    'notes = """',
    'model_provider = "fake-inside-a-string"',
    '"""',
    '',
    '[model_providers.alpha]',
    'name = "Alpha service"',
    'base_url = "https://alpha.example/v1"',
    '',
    '[model_providers.beta]',
    'name = "Beta service"',
    'base_url = "https://beta.example/v1"',
    '',
    '[profiles.fast]',
    'model_provider = "beta"',
    '',
  ].join('\r\n');
  await writeFile(configPath, original);
  const service = new CodexModelProviderService({ home });

  const changed = await service.setDefault('alpha');
  assert.equal(changed.defaultProvider, 'alpha');
  assert.deepEqual(changed.providers.map((provider) => provider.id), ['openai', 'alpha', 'beta']);
  const withAlpha = original.replace('"model_provider" = "beta"', '"model_provider" = "alpha"');
  assert.equal(await readFile(configPath, 'utf8'), withAlpha);

  // Saving the value already present does not touch the file.
  const before = await stat(configPath);
  await service.setDefault('alpha');
  assert.equal((await stat(configPath)).mtimeMs, before.mtimeMs);

  // OpenAI removes only the root statement, keeping the multiline decoys and
  // the profiles.*.model_provider assignment byte-identical.
  await service.setDefault('openai');
  const withoutRoot = withAlpha.replace('"model_provider" = "alpha"   # stay inline\r\n', '');
  assert.equal(await readFile(configPath, 'utf8'), withoutRoot);
  assert.ok(withoutRoot.includes('model_provider = "fake-inside-a-string"'));
  assert.ok(withoutRoot.includes('[profiles.fast]\r\nmodel_provider = "beta"\r\n'));

  // A new assignment is inserted before the first table header, still CRLF.
  const directory = await service.setDefault('beta');
  assert.equal(directory.defaultProvider, 'beta');
  const expected = withoutRoot.replace('[model_providers.alpha]', 'model_provider = "beta"\r\n[model_providers.alpha]');
  assert.equal(await readFile(configPath, 'utf8'), expected);
  assert.equal(/[^\r]\n/.test(await readFile(configPath, 'utf8')), false);
});

test('an unknown default service fails without creating or rewriting config', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-default-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  const service = new CodexModelProviderService({ home, environment: {} });

  await assert.rejects(service.setDefault('missing'), { code: 'CODEX_MODEL_PROVIDER_NOT_FOUND' });
  await assert.rejects(stat(path.join(home, 'config.toml')), { code: 'ENOENT' });
  await assert.rejects(stat(home), { code: 'ENOENT' }, 'selecting an unknown service creates no home directory');

  assert.deepEqual(await service.setDefault('openai'), {
    defaultProvider: 'openai', hasCustomProviders: false, providers: [{ id: 'openai', name: 'OpenAI' }],
  });
  await assert.rejects(stat(path.join(home, 'config.toml')), { code: 'ENOENT' }, 'OpenAI needs no config.toml');

  await writeFile(path.join(root, 'config.toml'), 'model_provider = [');
  const invalid = new CodexModelProviderService({ home: root, environment: {} });
  await assert.rejects(invalid.setDefault('openai'), { code: 'CODEX_CONFIG_INVALID' });
  assert.equal(await readFile(path.join(root, 'config.toml'), 'utf8'), 'model_provider = [');
});

test('an explicit root openai default is removed and ordinary values still skip unchanged writes', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-openai-default-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = path.join(home, 'config.toml');
  const original = [
    '# keep',
    'model_provider = "openai" # remove this statement',
    'model = "gpt-5"',
    '',
    '[profiles.fast]',
    'model_provider = "openai"',
    '',
  ].join('\n');
  await writeFile(configPath, original);
  const service = new CodexModelProviderService({ home, environment: {} });

  const directory = await service.setDefault('openai');
  assert.equal(directory.defaultProvider, 'openai');
  const expected = original.replace('model_provider = "openai" # remove this statement\n', '');
  assert.equal(await readFile(configPath, 'utf8'), expected);
  assert.ok(expected.includes('[profiles.fast]\nmodel_provider = "openai"'));

  const pinned = new Date('2020-01-02T03:04:05.000Z');
  await utimes(configPath, pinned, pinned);
  const before = await stat(configPath);
  await service.setDefault('openai');
  assert.equal((await stat(configPath)).mtimeMs, before.mtimeMs);
});

test('catalog requests use each service authentication and cache successes for exactly sixty seconds', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-models-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'config.toml'), config);
  let now = 10_000;
  const calls: Array<{ url: string; headers: Headers }> = [];
  const service = new CodexModelProviderService({ home, now: () => now,
    environment: { ALPHA_TOKEN: 'alpha-secret', WORKSPACE: 'team-a' },
    fetch: async (url, options) => {
      calls.push({ url: String(url), headers: new Headers(options?.headers) });
      return Response.json({ data: [{ id: 'shared-model' }, { id: 'alpha-only' }, { id: 'shared-model' }] });
    },
  });
  assert.deepEqual(await service.models('alpha'), { modelProvider: 'alpha', models: ['shared-model', 'alpha-only'], expiresAt: 70_000 });
  now = 69_999;
  await service.models('alpha');
  assert.equal(calls.length, 1);
  await service.models('beta');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://alpha.example/v1/models?api-version=preview');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer alpha-secret');
  assert.equal(calls[0].headers.get('X-Workspace'), 'team-a');
  assert.equal(calls[1].headers.get('Authorization'), 'Bearer beta-secret');
  assert.equal(calls[1].headers.has('X-Workspace'), false);
  now = 70_000;
  await service.models('alpha');
  assert.equal(calls.length, 3);
  await writeFile(path.join(home, 'config.toml'), config.replace('alpha.example', 'replacement.example'));
  await service.models('alpha');
  assert.equal(calls.length, 4, 'a changed endpoint cannot reuse the previous endpoint’s cache');
  assert.match(calls[3].url, /replacement\.example/);
});

test('missing providers and credentials fail before HTTP; rejected and malformed responses never become catalogs', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-errors-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'config.toml'), config);
  let calls = 0;
  let response = () => new Response('do not expose beta-secret', { status: 401 });
  const service = new CodexModelProviderService({ home, environment: {}, fetch: async () => { calls++; return response(); } });
  await assert.rejects(service.models('missing'), { code: 'CODEX_MODEL_PROVIDER_NOT_FOUND' });
  await assert.rejects(service.models('alpha'), { code: 'CODEX_MODEL_PROVIDER_AUTH_REQUIRED' });
  assert.equal(calls, 0);
  await assert.rejects(service.models('beta'), (error: Error) => error.message.includes('401') && !error.message.includes('beta-secret'));
  response = () => Response.json({ data: [{ name: 'no id' }] });
  await assert.rejects(service.models('beta'), { code: 'CODEX_MODEL_CATALOG_INVALID' });
  response = () => Response.json({ data: [{ id: 'working-model' }] });
  assert.deepEqual((await service.models('beta')).models, ['working-model']);
  assert.equal(calls, 3);
  await writeFile(path.join(home, 'config.toml'), 'model_providers = [');
  await assert.rejects(service.list(), { code: 'CODEX_CONFIG_INVALID' });
  await writeFile(path.join(home, 'config.toml'), config.replace('beta-secret', 'private-secret\\ninvalid-header'));
  await assert.rejects(service.models('beta'), (error: Error & { code?: string }) =>
    error.code === 'CODEX_CONFIG_INVALID' && !error.message.includes('private-secret'));
});

test('OpenAI model discovery follows the saved login and isolates account caches', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-native-catalog-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const auth = (account: string) => writeFile(path.join(home, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt', tokens: { access_token: 'test-oauth-token', account_id: account },
  }));
  await auth('account-a');
  const calls: Array<{ url: string; headers: Headers }> = [];
  const service = new CodexModelProviderService({ home, environment: { OPENAI_API_KEY: 'unrelated-env-key', IGNORED_TOKEN: 'ignored-token' }, fetch: async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options?.headers) });
    if (String(url).startsWith('https://proxy.example')) return Response.json({ data: [{ id: 'proxy-model' }] });
    return Response.json({ models: [{ slug: 'native-model', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hide' }] });
  } });
  assert.deepEqual((await service.models('openai')).models, ['native-model']);
  assert.match(calls[0].url, /^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=/);
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer test-oauth-token');
  assert.equal(calls[0].headers.get('ChatGPT-Account-Id'), 'account-a');
  await service.models('openai');
  assert.equal(calls.length, 1);
  await auth('account-b');
  await service.models('openai');
  assert.equal(calls.length, 2);
  await writeFile(path.join(home, 'config.toml'), '[model_providers.proxy]\nbase_url="https://proxy.example/v1"\nrequires_openai_auth=true\nenv_key="IGNORED_TOKEN"');
  assert.deepEqual((await service.models('proxy')).models, ['proxy-model']);
  assert.equal(calls[2].headers.get('Authorization'), 'Bearer test-oauth-token', 'explicit OpenAI auth ignores the provider env_key');
  await writeFile(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'saved-api-key', tokens: { access_token: 'stale-token' } }));
  await service.models('proxy');
  assert.equal(calls[3].headers.get('Authorization'), 'Bearer saved-api-key');
});
