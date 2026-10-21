import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import { AppError } from '@/shared/index.js';
import type { IProvider, IProviderRuntime, LLMProvider } from '@/shared/index.js';

function createRuntime(overrides: Partial<IProviderRuntime> = {}): IProviderRuntime {
  return {
    async run() {
      return undefined;
    },
    abort() {
      return false;
    },
    ...overrides,
  };
}

function createProvider(id: LLMProvider, runtime: IProviderRuntime): IProvider {
  return {
    id,
    runtime,
    models: {
      async getSupportedModels() { return { OPTIONS: [], DEFAULT: 'default-model' }; },
      async getCurrentActiveModel() { return { model: 'default-model' }; },
    },
    auth: {
      async getStatus() {
        return {
          provider: id,
          installed: true,
          authenticated: true,
          method: 'test',
          details: {},
        };
      },
    },
    sessions: {
      normalizeMessage(raw: unknown, sessionId: string | null) {
        return [{ kind: 'assistant', content: String(raw), sessionId, provider: id }];
      },
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as IProvider;
}

function createService(providers: IProvider[]) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  return createProviderRuntimeService({
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: (sessionId) => sessionId ? `native-${sessionId}` : null,
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel?.trim() || undefined;
    },
    async getProviderModels() {
      return {
        OPTIONS: [],
        DEFAULT: 'default-model',
      };
    },
  });
}

test('providerRegistry owns one runtime for every registered provider', () => {
  const providers = providerRegistry.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), [
    'claude',
    'codex',
    'gptweb',
    'cursor',
    'opencode',
    'dsh',
  ]);
  assert.equal(providers.every((provider) => typeof provider.runtime.run === 'function'), true);
  assert.equal(providers.every((provider) => typeof provider.runtime.abort === 'function'), true);
});

test('runtime context rejects images for text-only models and preserves providers without modality metadata', async () => {
  const provider = createProvider('gptweb', createRuntime({
    async run(_command, options, _writer, context) {
      await context.validateModelInput?.(options.model, options.attachments);
      return 'sent';
    },
  }));
  provider.models.getSupportedModels = async () => ({ DEFAULT: 'chatgpt-web/manual', OPTIONS: [
    { value: 'chatgpt-web/manual', label: 'Manual', inputModalities: ['text'] },
    { value: 'chatgpt-web/automatic', label: 'Automatic', inputModalities: ['text', 'image'] },
    { value: 'legacy', label: 'Unknown metadata' },
  ] });
  const service = createProviderRuntimeService({ resolveProvider: () => provider });
  const run = (model: string, file: string) => service.run('gptweb', 'look', { model, attachments: [{ path: file }] }, { send() {} });
  await assert.rejects(run('chatgpt-web/manual', '/tmp/image.png'), error =>
    error instanceof AppError && error.code === 'MODEL_IMAGES_NOT_SUPPORTED');
  assert.equal(await run('chatgpt-web/manual', '/tmp/notes.txt'), 'sent');
  assert.equal(await run('chatgpt-web/automatic', '/tmp/image.png'), 'sent');
  assert.equal(await run('legacy', '/tmp/image.png'), 'sent');
});

test('an unavailable catalog fails image validation before dispatch and reports definite non-delivery', async () => {
  const provider = createProvider('gptweb', createRuntime({
    async run(_command, options, _writer, context) {
      await context.validateModelInput?.(options.model, options.attachments);
      assert.fail('Input must not be dispatched');
    },
  }));
  provider.models.getSupportedModels = async () => { throw new AppError('Catalog offline', { code: 'GPTWEB_MODELS_UNAVAILABLE', statusCode: 503 }); };
  const service = createProviderRuntimeService({ resolveProvider: () => provider });
  await assert.rejects(service.run('gptweb', 'look', { model: 'chatgpt-web/test', attachments: [{ path: '/tmp/image.png' }] }, { send() {} }),
    error => error instanceof AppError && error.code === 'MODEL_INPUT_VALIDATION_FAILED' && error.statusCode === 503);
});

test('custom-only model lists do not hide input limits from an existing session', async () => {
  const provider = createProvider('gptweb', createRuntime({
    async run(_command, options, _writer, context) {
      await context.validateModelInput?.(options.model, options.attachments);
      return 'sent';
    },
  }));
  provider.models.getSupportedModels = async () => ({ DEFAULT: 'chatgpt-web/text', OPTIONS: [
    { value: 'chatgpt-web/text', label: 'Text', inputModalities: ['text'] },
    { value: 'chatgpt-web/vision', label: 'Vision', inputModalities: ['text', 'image'] },
  ] });
  const service = createProviderRuntimeService({ resolveProvider: () => provider,
    getProviderModels: async () => ({ DEFAULT: 'chatgpt-web/vision', CUSTOM_MODELS_ONLY: true,
      OPTIONS: [{ value: 'chatgpt-web/vision', label: 'Custom vision', inputModalities: ['text', 'image'] }],
    }),
  });
  await assert.rejects(service.run('gptweb', 'look', {
    model: 'chatgpt-web/text', attachments: [{ path: '/tmp/image.png' }],
  }, { send() {} }), error => error instanceof AppError && error.code === 'MODEL_IMAGES_NOT_SUPPORTED');
});

test('dispatches runs and aborts through the runtime owned by providerRegistry', async () => {
  const calls: unknown[][] = [];
  const runtime = createRuntime({
    async run(command, options, writer, context) {
      calls.push(['run', command, options, writer]);
      assert.equal(context.resolveProviderSessionId('session-1'), 'native-session-1');
      assert.equal(await context.resolveResumeModel('session-1', 'sonnet'), 'sonnet');
      assert.deepEqual(await context.getProviderModels(), { OPTIONS: [], DEFAULT: 'default-model' });
      assert.equal(context.normalizeMessage('hello', 'session-1')[0]?.provider, 'claude');
      assert.equal(await context.isProviderInstalled(), true);
      return 'complete';
    },
    async abort(sessionId) {
      calls.push(['abort', sessionId]);
      return true;
    },
  });
  const service = createService([createProvider('claude', runtime)]);
  const writer = { send() {} };

  assert.equal(service.hasRuntime('claude'), true);
  assert.equal(service.hasRuntime('unknown'), false);
  assert.equal(await service.getRunner('claude')('hello', { model: 'sonnet' }, writer), 'complete');
  assert.equal(await service.abort('claude', 'session-1'), true);
  assert.deepEqual(calls, [
    ['run', 'hello', { model: 'sonnet' }, writer],
    ['abort', 'session-1'],
  ]);
});

test('routes permission decisions through provider-owned runtime capabilities', () => {
  const decisions: unknown[][] = [];
  const claudeRuntime = createRuntime({
    permissions: {
      resolve(requestId, decision) {
        decisions.push([requestId, decision]);
      },
      listPending(sessionId) {
        return [{ requestId: 'request-1', sessionId }];
      },
    },
  });
  const service = createService([
    createProvider('claude', claudeRuntime),
    createProvider('cursor', createRuntime()),
  ]);
  const decision = { allow: true, message: 'approved' };

  service.resolveToolApproval('request-1', decision);

  assert.deepEqual(decisions, [['request-1', decision]]);
  assert.deepEqual(service.getPendingApprovalsForSession('session-1'), [
    { requestId: 'request-1', sessionId: 'session-1' },
  ]);
});

test('queue blocking is optional and follows each provider-owned session policy', () => {
  let held = true;
  const service = createService([
    createProvider('claude', createRuntime()),
    createProvider('codex', createRuntime({ isQueueBlocked: (sessionId) => sessionId === 'codex-session' && held })),
  ]);

  assert.equal(service.isQueueBlocked('claude-session'), false);
  assert.equal(service.isQueueBlocked('codex-session'), true);
  held = false;
  assert.equal(service.isQueueBlocked('codex-session'), false);
});
