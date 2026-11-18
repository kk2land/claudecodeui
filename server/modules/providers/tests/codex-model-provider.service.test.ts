import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexModelProviderService } from '@/modules/providers/list/codex/codex-model-provider.service.js';
import { AppError } from '@/shared/index.js';
import type { CodexRpcClient } from '@/shared/index.js';

type Call = { method: string; params?: Record<string, any> };

/**
 * A scripted RPC client: the service talks only to app-server, so these tests
 * inject the protocol instead of reading config.toml or fetching an endpoint.
 */
function scriptedClient(handler: (method: string, params: Record<string, any>) => unknown) {
  const calls: Call[] = [];
  const request: CodexRpcClient['request'] = async (method, params) => {
    calls.push({ method, params: params as Call['params'] });
    return handler(method, params as Record<string, any>) as any;
  };
  const client: CodexRpcClient = {
    request,
    onNotification: () => () => {},
    onRequest: () => () => {},
    onExit: () => () => {},
  };
  return { client, calls };
}

/** Builds the rejection the transport surfaces for a native `error` frame. */
const rejected = (message: string, data?: unknown): AppError => new AppError(message, {
  code: 'CODEX_APP_SERVER_REJECTED', statusCode: 502, details: { rpcCode: -32600, rpcData: data },
});

const openaiSummary = { id: 'openai', name: 'OpenAI', canEdit: false, baseUrl: null, settings: { type: 'openai' } };
const gatewaySummary = {
  id: 'alpha', name: 'Alpha service', canEdit: true, baseUrl: 'https://alpha.example/v1',
  settings: { type: 'customGateway', auth: { mode: 'environmentVariable', envKey: 'ALPHA_TOKEN' } },
};

/** One `modelProvider/list` result; callers override individual fields. */
const nativeDirectory = (overrides: Record<string, unknown> = {}) => ({
  defaultProviderId: 'openai', canChangeDefault: true, data: [openaiSummary, gatewaySummary], ...overrides,
});

const nativeModel = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, model: id, displayName: id.toUpperCase(), description: `${id} description`,
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high', description: 'Deep reasoning' }],
  defaultReasoningEffort: 'low', hidden: false, isDefault: false, ...overrides,
});

test('list() returns the credential-free native directory as the shared DTO', async () => {
  const bedrock = {
    id: 'amazon-bedrock', name: 'Amazon Bedrock', canEdit: true, baseUrl: null,
    settings: { type: 'bedrock', region: 'us-east-1', profile: null },
  };
  const gcp = {
    id: 'gcp', name: 'Google Cloud', canEdit: true, baseUrl: 'https://gcp.example/v1',
    settings: { type: 'gcp', location: null, projectId: 'project-a', credentialFile: '/keys/gcp.json' },
  };
  const { client, calls } = scriptedClient(() => nativeDirectory({
    defaultProviderId: 'alpha', data: [openaiSummary, gatewaySummary, bedrock, gcp],
  }));
  const service = new CodexModelProviderService(client);

  assert.deepEqual(await service.list(), {
    defaultProvider: 'alpha',
    hasCustomProviders: true,
    canChangeDefault: true,
    providers: [
      { id: 'openai', name: 'OpenAI', baseUrl: null, canEdit: false, settings: { type: 'openai' } },
      {
        id: 'alpha', name: 'Alpha service', baseUrl: 'https://alpha.example/v1', canEdit: true,
        settings: { type: 'customGateway', auth: { mode: 'environmentVariable', envKey: 'ALPHA_TOKEN' } },
      },
      {
        id: 'amazon-bedrock', name: 'Amazon Bedrock', baseUrl: null, canEdit: true,
        settings: { type: 'bedrock', region: 'us-east-1', profile: null },
      },
      {
        id: 'gcp', name: 'Google Cloud', baseUrl: 'https://gcp.example/v1', canEdit: true,
        settings: { type: 'gcp', location: null, projectId: 'project-a', credentialFile: '/keys/gcp.json' },
      },
    ],
  });
  assert.deepEqual(calls, [{ method: 'modelProvider/list', params: {} }]);
});

test('list() reports only the built-in service and refuses an unknown native service kind', async () => {
  const onlyBuiltIn = scriptedClient(() => nativeDirectory({ data: [openaiSummary] }));
  assert.deepEqual(await new CodexModelProviderService(onlyBuiltIn.client).list(), {
    defaultProvider: 'openai', hasCustomProviders: false, canChangeDefault: true,
    providers: [{ id: 'openai', name: 'OpenAI', baseUrl: null, canEdit: false, settings: { type: 'openai' } }],
  });

  const unknownKind = scriptedClient(() => nativeDirectory({ data: [{ ...gatewaySummary, settings: { type: 'mystery' } }] }));
  await assert.rejects(new CodexModelProviderService(unknownKind.client).list(), {
    code: 'CODEX_MODEL_PROVIDERS_INVALID', statusCode: 502,
  });

  const unreadable = scriptedClient(() => nativeDirectory({ data: undefined }));
  await assert.rejects(new CodexModelProviderService(unreadable.client).list(), {
    code: 'CODEX_MODEL_PROVIDERS_INVALID', statusCode: 502,
  });
});

test('models() aggregates every native page and keeps hidden rows out of the picker list', async () => {
  const pages: Record<string, unknown> = {
    '': { data: [nativeModel('shared'), nativeModel('reviewer', { hidden: true })], nextCursor: 'page-2' },
    'page-2': { data: [nativeModel('second', { isDefault: true })], nextCursor: null },
  };
  const { client, calls } = scriptedClient((method, params) => {
    assert.equal(method, 'model/list');
    return pages[String(params.cursor ?? '')];
  });

  assert.deepEqual(await new CodexModelProviderService(client).models('alpha'), {
    modelProvider: 'alpha',
    models: ['shared', 'second'],
    items: [
      {
        value: 'shared', label: 'SHARED', description: 'shared description',
        effort: { default: 'low', values: [{ value: 'low' }, { value: 'high', description: 'Deep reasoning' }] },
        isDefault: false, hidden: false,
      },
      {
        value: 'reviewer', label: 'REVIEWER', description: 'reviewer description',
        effort: { default: 'low', values: [{ value: 'low' }, { value: 'high', description: 'Deep reasoning' }] },
        isDefault: false, hidden: true,
      },
      {
        value: 'second', label: 'SECOND', description: 'second description',
        effort: { default: 'low', values: [{ value: 'low' }, { value: 'high', description: 'Deep reasoning' }] },
        isDefault: true, hidden: false,
      },
    ],
  });
  assert.deepEqual(calls, [
    { method: 'model/list', params: { modelProvider: 'alpha', includeHidden: true } },
    { method: 'model/list', params: { modelProvider: 'alpha', includeHidden: true, cursor: 'page-2' } },
  ]);
});

test('models() surfaces native provider and network failures without inventing a catalog', async () => {
  const notConfigured = scriptedClient(() => {
    throw rejected('This chat uses model provider “alpha”, which is no longer configured.', {
      type: 'modelProviderNotConfigured', modelProvider: 'alpha',
    });
  });
  await assert.rejects(new CodexModelProviderService(notConfigured.client).models('alpha'), {
    code: 'CODEX_MODEL_PROVIDER_NOT_FOUND', statusCode: 404,
  });

  const unknownRejection = scriptedClient(() => { throw rejected('Codex could not read this catalog.'); });
  await assert.rejects(new CodexModelProviderService(unknownRejection.client).models('alpha'), {
    code: 'CODEX_MODEL_CATALOG_FAILED', statusCode: 502, message: 'Codex could not read this catalog.',
  });

  const network = new Error('socket hang up');
  const offline = scriptedClient(() => { throw network; });
  await assert.rejects(new CodexModelProviderService(offline.client).models('alpha'), (error: unknown) => error === network);
});

test('setDefault() verifies the service, writes only model_provider and returns the effective directory', async () => {
  let directoryReads = 0;
  const { client, calls } = scriptedClient((method) => {
    if (method === 'modelProvider/list') {
      directoryReads += 1;
      return nativeDirectory({ defaultProviderId: directoryReads === 1 ? 'openai' : 'alpha' });
    }
    assert.equal(method, 'config/value/write');
    return { status: 'ok', version: 'sha256:1', filePath: '/home/u/.codex/config.toml', overriddenMetadata: null };
  });
  const service = new CodexModelProviderService(client);

  const saved = await service.setDefault('alpha');
  assert.equal(saved.defaultProvider, 'alpha');
  assert.deepEqual(calls, [
    { method: 'modelProvider/list', params: {} },
    { method: 'config/value/write', params: { keyPath: 'model_provider', value: 'alpha', mergeStrategy: 'replace' } },
    { method: 'modelProvider/list', params: {} },
  ]);
});

test('setDefault() rejects a missing service, a locked default and a skipped redundant write', async () => {
  const missing = scriptedClient(() => nativeDirectory());
  await assert.rejects(new CodexModelProviderService(missing.client).setDefault('missing'), {
    code: 'CODEX_MODEL_PROVIDER_NOT_FOUND', statusCode: 404,
  });
  assert.deepEqual(missing.calls.map((call) => call.method), ['modelProvider/list']);

  const locked = scriptedClient(() => nativeDirectory({ canChangeDefault: false }));
  await assert.rejects(new CodexModelProviderService(locked.client).setDefault('alpha'), {
    code: 'CODEX_MODEL_PROVIDER_DEFAULT_READONLY', statusCode: 409,
  });
  assert.deepEqual(locked.calls.map((call) => call.method), ['modelProvider/list']);

  const unchanged = scriptedClient(() => nativeDirectory({ defaultProviderId: 'alpha' }));
  assert.equal((await new CodexModelProviderService(unchanged.client).setDefault('alpha')).defaultProvider, 'alpha');
  assert.deepEqual(unchanged.calls.map((call) => call.method), ['modelProvider/list']);
});

test('setDefault() reports a write that a managed layer overrides as written but not in effect', async () => {
  const { client, calls } = scriptedClient((method) => {
    if (method === 'modelProvider/list') return nativeDirectory({ defaultProviderId: 'openai' });
    return {
      status: 'okOverridden',
      version: 'sha256:1',
      filePath: '/home/u/.codex/config.toml',
      overriddenMetadata: {
        effectiveValue: 'openai',
        message: 'Managed by the workspace administrator.',
        overridingLayer: { name: { type: 'mdm', domain: 'com.example', key: 'codex' }, version: 'sha256:2' },
      },
    };
  });
  await assert.rejects(new CodexModelProviderService(client).setDefault('alpha'), (error: any) => {
    assert.equal(error.code, 'CODEX_MODEL_PROVIDER_DEFAULT_OVERRIDDEN');
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /wrote model_provider = "alpha" to config\.toml, but it is not in effect/);
    assert.match(error.message, /effective default is "openai"/);
    assert.match(error.message, /mdm configuration layer/);
    assert.match(error.message, /Managed by the workspace administrator\./);
    return true;
  });
  // The directory is re-read so the reported effective default is real.
  assert.deepEqual(calls.map((call) => call.method), ['modelProvider/list', 'config/value/write', 'modelProvider/list']);
});

test('create() forwards only an identity-less custom gateway and returns the native summary', async () => {
  const { client, calls } = scriptedClient((method) => {
    assert.equal(method, 'modelProvider/config/write');
    return { provider: { ...gatewaySummary, id: 'allocated-id' } };
  });
  const service = new CodexModelProviderService(client);

  assert.deepEqual(await service.create({ type: 'customGateway', name: 'Alpha service',
    baseUrl: 'https://alpha.example/v1', envKey: 'ALPHA_TOKEN' }), {
    id: 'allocated-id', name: 'Alpha service', baseUrl: 'https://alpha.example/v1', canEdit: true,
    settings: { type: 'customGateway', auth: { mode: 'environmentVariable', envKey: 'ALPHA_TOKEN' } },
  });
  assert.deepEqual(calls, [{
    method: 'modelProvider/config/write',
    params: { settings: {
      type: 'customGateway', providerId: null, name: 'Alpha service',
      baseUrl: 'https://alpha.example/v1', envKey: 'ALPHA_TOKEN',
    } },
  }]);

  const withId = scriptedClient(() => ({}));
  await assert.rejects(new CodexModelProviderService(withId.client).create({
    type: 'customGateway', providerId: 'chosen-id', name: 'Alpha',
  }), { code: 'CODEX_MODEL_PROVIDER_CREATE_UNSUPPORTED', statusCode: 400 });
  assert.deepEqual(withId.calls, []);
  await assert.rejects(new CodexModelProviderService(withId.client).create({
    type: 'bedrock', providerId: 'amazon-bedrock', region: 'us-east-1',
  }), { code: 'CODEX_MODEL_PROVIDER_CREATE_UNSUPPORTED', statusCode: 400 });
});

test('create() reports native field validation with the app-server explanation', async () => {
  const { client } = scriptedClient(() => {
    throw rejected('Enter an HTTP(S) base URL without credentials, a query, or a fragment.', {
      config_write_error_code: 'configValidationError',
    });
  });
  await assert.rejects(new CodexModelProviderService(client).create({
    type: 'customGateway', name: 'Alpha', baseUrl: 'not-a-url',
  }), {
    code: 'CODEX_MODEL_PROVIDER_INVALID',
    statusCode: 400,
    message: 'Enter an HTTP(S) base URL without credentials, a query, or a fragment.',
  });
});

test('update() authorizes by the path id and rechecks native editability before writing', async () => {
  const mismatch = scriptedClient(() => { throw new Error('must not be called'); });
  await assert.rejects(new CodexModelProviderService(mismatch.client).update('alpha', {
    type: 'customGateway', providerId: 'beta', name: 'Renamed',
  }), { code: 'CODEX_MODEL_PROVIDER_ID_MISMATCH', statusCode: 400 });
  assert.deepEqual(mismatch.calls, []);

  const missing = scriptedClient(() => nativeDirectory());
  await assert.rejects(new CodexModelProviderService(missing.client).update('missing', {
    type: 'customGateway', name: 'Renamed',
  }), { code: 'CODEX_MODEL_PROVIDER_NOT_FOUND', statusCode: 404 });
  assert.deepEqual(missing.calls.map((call) => call.method), ['modelProvider/list']);

  const readOnly = scriptedClient(() => nativeDirectory());
  await assert.rejects(new CodexModelProviderService(readOnly.client).update('openai', {
    type: 'customGateway', name: 'Renamed',
  }), { code: 'CODEX_MODEL_PROVIDER_READONLY', statusCode: 409 });
  assert.deepEqual(readOnly.calls.map((call) => call.method), ['modelProvider/list']);
});

test('update() writes with the path id as identity and maps config-write rejections', async () => {
  const { client, calls } = scriptedClient((method, params) => {
    if (method === 'modelProvider/list') return nativeDirectory();
    assert.deepEqual(params, { settings: { type: 'customGateway', providerId: 'alpha', name: 'Renamed' } });
    return { provider: { ...gatewaySummary, name: 'Renamed' } };
  });
  assert.equal((await new CodexModelProviderService(client).update('alpha', {
    type: 'customGateway', name: 'Renamed',
  })).name, 'Renamed');
  assert.deepEqual(calls.map((call) => call.method), ['modelProvider/list', 'modelProvider/config/write']);

  const layerReadOnly = scriptedClient((method) => {
    if (method === 'modelProvider/list') return nativeDirectory();
    throw rejected('The user layer is read-only.', { config_write_error_code: 'configLayerReadonly' });
  });
  await assert.rejects(new CodexModelProviderService(layerReadOnly.client).update('alpha', {
    type: 'customGateway', name: 'Renamed',
  }), { code: 'CODEX_MODEL_PROVIDER_READONLY', statusCode: 409 });

  const requirement = scriptedClient((method) => {
    if (method === 'modelProvider/list') return nativeDirectory();
    throw rejected('Requirements forbid this.', { config_write_error_code: 'RequirementReadonly' });
  });
  await assert.rejects(new CodexModelProviderService(requirement.client).update('alpha', {
    type: 'customGateway', name: 'Renamed',
  }), { code: 'CODEX_MODEL_PROVIDER_READONLY', statusCode: 409 });

  const conflict = scriptedClient((method) => {
    if (method === 'modelProvider/list') return nativeDirectory();
    throw rejected('The file changed.', { config_write_error_code: 'configVersionConflict' });
  });
  await assert.rejects(new CodexModelProviderService(conflict.client).update('alpha', {
    type: 'customGateway', name: 'Renamed',
  }), { code: 'CODEX_MODEL_PROVIDER_VERSION_CONFLICT', statusCode: 409 });

  const unknown = scriptedClient((method) => {
    if (method === 'modelProvider/list') return nativeDirectory();
    throw rejected('Codex refused this provider for another reason.', { config_write_error_code: 'somethingNew' });
  });
  await assert.rejects(new CodexModelProviderService(unknown.client).update('alpha', {
    type: 'customGateway', name: 'Renamed',
  }), {
    code: 'CODEX_MODEL_PROVIDER_WRITE_REJECTED',
    statusCode: 502,
    message: 'Codex refused this provider for another reason.',
  });
});
