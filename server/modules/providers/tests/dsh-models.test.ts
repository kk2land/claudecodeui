import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshModelsProvider } from '@/modules/providers/list/dsh/dsh-models.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';

async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-models-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'profiles', 'headless');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'cordis.patch.yml');
  const provider = new DshModelsProvider(
    { find: async () => null },
    new DshConfigurationProvider({ DSH_HOME: home }),
  );
  return { home, file, provider };
}

function modelEntry(id: string, models: string[]) {
  return {
    id,
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: { providers: { gateway: { models: models.map((model) => ({ id: model })) } } },
  };
}

test('headless patch models retain provider routes, names and effort keys without exposing credentials', async (context) => {
  const { file, provider } = await fixture(context);
  const content = `
# A user profile can configure multiple models under one gateway.
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      magpie:
        apiKey: do-not-expose-this-key
        baseUrl: https://example.invalid/private-gateway
        models:
          - id: workbuddy/deepseek-v4.1-flash
            name: Deepseek-V4.1-Flash · WorkBuddy
            contextWindow: 1000000
            reasoningEfforts:
              low: low
              high: high
              max: max
          - id: workbuddy/deepseek-v4-pro
            name: Deepseek-V4-Pro · WorkBuddy
            reasoningEfforts:
              off: none
              high: high
              xhigh: xhigh
      other:
        models:
          - id: workbuddy/deepseek-v4-pro
- id: agent-default-model
  config:
    provider: magpie
    model: workbuddy/deepseek-v4.1-flash
    reasoningEffort: max
`;
  await writeFile(file, content);

  // The requested headless catalog is readable even while ACP is selected.
  const models = await provider.getSupportedModels();
  assert.equal(models.DEFAULT, 'default');
  assert.equal(models.OPTIONS[0].value, 'default');
  assert.equal(models.OPTIONS[0].effort, undefined, 'headless effort needs an explicit model');
  assert.deepEqual(models.OPTIONS.slice(1), [
    {
      value: 'magpie/workbuddy/deepseek-v4.1-flash',
      label: 'Deepseek-V4.1-Flash · WorkBuddy',
      description: 'magpie',
      effort: { values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] },
    },
    {
      value: 'magpie/workbuddy/deepseek-v4-pro',
      label: 'Deepseek-V4-Pro · WorkBuddy',
      description: 'magpie',
      effort: { values: [{ value: 'off' }, { value: 'high' }, { value: 'xhigh' }] },
    },
    { value: 'other/workbuddy/deepseek-v4-pro', label: 'workbuddy/deepseek-v4-pro', description: 'other' },
  ]);
  assert(!JSON.stringify(models).includes('do-not-expose-this-key'));
  assert(!JSON.stringify(models).includes('private-gateway'));
  assert.equal(await readFile(file, 'utf8'), content, 'discovery must not rewrite the profile');
});

test('inserted declarations skip disabled and invalid rows, deduplicate routes and retain supported effort levels', async (context) => {
  const { file, provider } = await fixture(context);
  await writeFile(file, JSON.stringify([
    null,
    { id: 'original', config: { providers: { gateway: { models: [null, '', {}, { id: '' }, { id: 42 }, { id: 'one', name: 'Old name' }] } } } },
    { id: 'disabled', disabled: true, config: { providers: { hidden: { models: [{ id: 'hidden' }] } } } },
    { id: 'invalid', config: { providers: { invalid: { models: {} }, ' ': { models: [{ id: 'empty-provider' }] } } } },
    { insert: [{
      id: 'inserted',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          gateway: { models: [
            { id: 'one', name: 'New name', reasoningEfforts: false },
            { id: 'two', reasoningEfforts: { off: null, minimal: 'minimal', low: '', medium: 'medium', high: null, xhigh: 'max', turbo: 'fast' } },
          ] },
        },
      },
    }] },
  ]));

  const models = await provider.getSupportedModels();
  assert.deepEqual(models.OPTIONS.slice(1), [
    { value: 'gateway/one', label: 'New name', description: 'gateway' },
    {
      value: 'gateway/two',
      label: 'two',
      description: 'gateway',
      effort: { values: [{ value: 'off' }, { value: 'minimal' }, { value: 'medium' }, { value: 'xhigh' }] },
    },
  ]);
  const supported = providerCapabilitiesService.getProviderCapabilities('dsh').effortLevels;
  assert(models.OPTIONS.every((model) => model.effort?.values.every(({ value }) => supported.includes(value)) ?? true));
});

test('patches replace the entire config of an entry instead of retaining obsolete models or providers', async (context) => {
  const { file, provider } = await fixture(context);
  const original = {
    ...modelEntry('llm-pi-ai', ['old']),
    config: {
      providers: {
        gateway: { models: [{ id: 'old' }] },
        removed: { models: [{ id: 'stale' }] },
      },
    },
  };
  // Both bundle-owned entries and entries inserted in this file use the same
  // replacement semantics. A name mismatch must leave the last valid config.
  for (const first of [original, { insert: [original] }]) {
    await writeFile(file, JSON.stringify([
      first,
      modelEntry('llm-pi-ai', ['current']),
      { ...modelEntry('llm-pi-ai', ['wrong-plugin']), name: 'different-plugin' },
    ]));
    assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default', 'gateway/current']);
  }
  await writeFile(file, JSON.stringify([original, { id: 'llm-pi-ai', config: {} }]));
  assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default']);
});

test('later disable and re-enable patches control the final entry state independently of config', async (context) => {
  const { file, provider } = await fixture(context);
  const patches: unknown[] = [
    modelEntry('llm-pi-ai', ['original']),
    { id: 'llm-pi-ai', disabled: true },
    modelEntry('llm-pi-ai', ['replacement']),
  ];
  await writeFile(file, JSON.stringify(patches));
  assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default']);

  patches.push({ id: 'llm-pi-ai', disabled: false });
  await writeFile(file, JSON.stringify(patches));
  assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default', 'gateway/replacement']);
});

test('nested groups support targeted insertions and overrides while disabled ancestors hide descendants', async (context) => {
  const { file, provider } = await fixture(context);
  const patches: unknown[] = [
    { insert: [{
      id: 'outer',
      group: true,
      config: [
        { id: 'inner', group: true, config: [modelEntry('nested-llm', ['old'])] },
        { id: 'hidden', group: true, disabled: true, config: [modelEntry('hidden-llm', ['hidden'])] },
      ],
    }] },
    { id: 'inner', insert: [modelEntry('inserted-llm', ['added'])] },
    modelEntry('nested-llm', ['current']),
    { id: 'missing-group', insert: [modelEntry('orphan-llm', ['orphan'])] },
    { id: 'nested-llm', insert: [modelEntry('non-group-child', ['invalid'])] },
  ];
  await writeFile(file, JSON.stringify(patches));
  assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default', 'gateway/current', 'gateway/added']);

  patches.push({ id: 'outer', disabled: true });
  await writeFile(file, JSON.stringify(patches));
  assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default']);

  patches.push({ id: 'outer', disabled: false }, { id: 'nested-llm', disabled: true });
  await writeFile(file, JSON.stringify(patches));
  assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default', 'gateway/added']);
});

test('replacing group config removes detached descendants from the catalog', async (context) => {
  const { file, provider } = await fixture(context);
  await writeFile(file, JSON.stringify([
    { insert: [{ id: 'group', group: true, config: [modelEntry('old-llm', ['old'])] }] },
    { id: 'group', config: [modelEntry('new-llm', ['new'])] },
    modelEntry('old-llm', ['detached']),
    // Cordis does not index replacement children as new patch targets.
    modelEntry('new-llm', ['not-a-target']),
  ]));
  assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default', 'gateway/new']);
});

test('patches before an insertion and patches without an entry ID do not become declarations', async (context) => {
  const { file, provider } = await fixture(context);
  await writeFile(file, JSON.stringify([
    { id: 'inserted-llm', disabled: true },
    { insert: [modelEntry('inserted-llm', ['inserted'])] },
    { config: modelEntry('unused', ['no-id']).config },
  ]));
  assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default', 'gateway/inserted']);
});

test('a missing, empty, unreadable or invalid patch retains the default and never logs source excerpts', async (context) => {
  const { file, provider } = await fixture(context);
  const warning = context.mock.method(console, 'warn', () => {});
  assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default']);
  assert.equal(warning.mock.callCount(), 0);

  for (const content of ['', '[]', 'config: {}', '- config: [do-not-log-this-secret', '- config: !js process.exit(1)']) {
    await writeFile(file, content);
    assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default']);
  }
  await rm(file);
  await mkdir(file);
  assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default']);
  assert(warning.mock.callCount() >= 3);
  assert(!JSON.stringify(warning.mock.calls).includes('do-not-log-this-secret'));
});

test('profile edits, additions and removals are reflected on the next catalog request', async (context) => {
  const { file, provider } = await fixture(context);
  for (const ids of [['first'], ['first', 'second'], ['second'], []]) {
    await writeFile(file, JSON.stringify([{ id: 'llm-pi-ai', config: { providers: { local: { models: ids.map((id) => ({ id })) } } } }]));
    assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default', ...ids.map((id) => `local/${id}`)]);
  }
  await rm(file);
  assert.deepEqual((await provider.getSupportedModels()).OPTIONS.map(({ value }) => value), ['default']);
});

test('current model still follows native session selections independently of catalog discovery', async (context) => {
  const { home } = await fixture(context);
  const log = {
    filePath: 'unused',
    header: { id: 'session', createdAt: 0 },
    events: [
      { type: 'model/selection', data: { provider: 'gateway', model: 'old' } },
      { type: 'model/selection', data: { provider: 'gateway', model: 'nested/current' } },
    ],
  };
  const provider = new DshModelsProvider(
    { find: async (id) => id === 'session' ? log : null },
    new DshConfigurationProvider({ DSH_HOME: home }),
  );
  assert.deepEqual(await provider.getCurrentActiveModel('session'), { model: 'gateway/nested/current' });
  assert.deepEqual(await provider.getCurrentActiveModel('missing'), { model: 'default' });
  assert.deepEqual(await provider.getCurrentActiveModel(), { model: 'default' });
});
