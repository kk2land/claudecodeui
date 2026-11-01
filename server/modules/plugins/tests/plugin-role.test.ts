import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { isPluginAllowedForRole, isSuperPluginRole } from '../plugin-access.service.js';
import {
  getPluginDir, resolvePluginAssetPath, scanPlugins,
} from '../plugin-registry.service.js';
import { createPluginsService } from '../plugins.service.js';

type Dependencies = Parameters<typeof createPluginsService>[0];

function restoreEnvironment(t: TestContext, name: string, value: string | undefined) {
  t.after(() => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
}

function setEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A plugin directory with one installed, enabled third-party plugin. */
function createPluginsDirectory(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-role-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pluginDirectory = path.join(directory, 'private-demo');
  fs.mkdirSync(pluginDirectory);
  fs.writeFileSync(path.join(pluginDirectory, 'index.js'), 'export function mount() {}\n');
  fs.writeFileSync(
    path.join(pluginDirectory, 'manifest.json'),
    JSON.stringify({
      name: 'private-demo',
      displayName: 'Private Demo',
      version: '1.0.0',
      entry: 'index.js',
      type: 'module',
      slot: 'tab',
    }),
  );
  return directory;
}

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    scanPlugins: () => [],
    readConfig: () => ({}),
    saveConfig: () => undefined,
    getPluginDirectory: () => null,
    getPluginsDirectory: () => '/plugins',
    resolveAsset: () => null,
    assetIsFile: () => false,
    contentType: () => 'text/plain',
    install: async () => assert.fail('install must not run'),
    update: async () => assert.fail('update must not run'),
    uninstall: async () => assert.fail('uninstall must not run'),
    startServer: async () => 4000,
    stopServer: async () => assert.fail('stopServer must not run'),
    getServerPort: () => undefined,
    isServerRunning: () => false,
    joinPath: (...parts) => parts.join('/'),
    logError: () => undefined,
    canManagePlugins: () => false,
    ...overrides,
  };
}

test('only an exact super role is unrestricted; unset, empty and unknown values stay normal', (t) => {
  const previousRole = process.env.CLOUDCLI_ROLE;
  const previousScheduler = process.env.CLOUDCLI_ENABLE_PROJECT_SCHEDULER;
  restoreEnvironment(t, 'CLOUDCLI_ROLE', previousRole);
  restoreEnvironment(t, 'CLOUDCLI_ENABLE_PROJECT_SCHEDULER', previousScheduler);
  process.env.CLOUDCLI_ENABLE_PROJECT_SCHEDULER = 'true';

  for (const value of [undefined, '', 'user', 'SUPER', ' super ']) {
    setEnvironment('CLOUDCLI_ROLE', value);
    assert.equal(isSuperPluginRole(), false);
    assert.equal(isPluginAllowedForRole('worker'), true);
    assert.equal(isPluginAllowedForRole('project-scheduler'), true);
    assert.equal(isPluginAllowedForRole('private-demo'), false);
  }

  process.env.CLOUDCLI_ROLE = 'super';
  assert.equal(isSuperPluginRole(), true);
  assert.equal(isPluginAllowedForRole('private-demo'), true);
});

test('normal role hides a previously enabled installed plugin; super lists it', (t) => {
  const pluginsDirectory = createPluginsDirectory(t);
  const config = { 'private-demo': { enabled: true } };
  const previousRole = process.env.CLOUDCLI_ROLE;
  const previousScheduler = process.env.CLOUDCLI_ENABLE_PROJECT_SCHEDULER;
  restoreEnvironment(t, 'CLOUDCLI_ROLE', previousRole);
  restoreEnvironment(t, 'CLOUDCLI_ENABLE_PROJECT_SCHEDULER', previousScheduler);
  delete process.env.CLOUDCLI_ENABLE_PROJECT_SCHEDULER;

  for (const value of [undefined, '', 'user', 'SUPER']) {
    setEnvironment('CLOUDCLI_ROLE', value);
    const names = scanPlugins(pluginsDirectory, config).map((plugin) => plugin.name);
    assert.deepEqual(names, ['worker']);
  }

  process.env.CLOUDCLI_ROLE = 'super';
  const superNames = scanPlugins(pluginsDirectory, config).map((plugin) => plugin.name);
  assert.deepEqual(superNames.sort(), ['private-demo', 'worker']);
});

test('the scheduler environment switch still overrides role visibility', (t) => {
  const pluginsDirectory = createPluginsDirectory(t);
  const previousRole = process.env.CLOUDCLI_ROLE;
  const previousScheduler = process.env.CLOUDCLI_ENABLE_PROJECT_SCHEDULER;
  restoreEnvironment(t, 'CLOUDCLI_ROLE', previousRole);
  restoreEnvironment(t, 'CLOUDCLI_ENABLE_PROJECT_SCHEDULER', previousScheduler);
  process.env.CLOUDCLI_ROLE = 'super';

  for (const value of [undefined, '1', 'false']) {
    setEnvironment('CLOUDCLI_ENABLE_PROJECT_SCHEDULER', value);
    const names = scanPlugins(pluginsDirectory, {}).map((plugin) => plugin.name);
    assert.deepEqual(names, ['worker', 'private-demo']);
  }

  process.env.CLOUDCLI_ENABLE_PROJECT_SCHEDULER = 'true';
  const names = scanPlugins(pluginsDirectory, {}).map((plugin) => plugin.name);
  assert.deepEqual(names, ['project-scheduler', 'worker', 'private-demo']);
});

test('an installed scheduler copy stays unavailable unless the scheduler switch is exactly true', async (t) => {
  const pluginsDirectory = createPluginsDirectory(t);
  const schedulerDirectory = path.join(pluginsDirectory, 'project-scheduler');
  fs.mkdirSync(schedulerDirectory);
  fs.writeFileSync(path.join(schedulerDirectory, 'index.js'), 'export function mount() {}\n');
  fs.writeFileSync(path.join(schedulerDirectory, 'server.mjs'), 'console.log("{}");\n');
  fs.writeFileSync(
    path.join(schedulerDirectory, 'manifest.json'),
    JSON.stringify({
      name: 'project-scheduler',
      displayName: 'Installed Scheduler Copy',
      version: '0.0.1',
      entry: 'index.js',
      server: 'server.mjs',
      type: 'module',
      slot: 'tab',
    }),
  );
  const config = {
    'project-scheduler': { enabled: true },
    'private-demo': { enabled: true },
  };
  const previousRole = process.env.CLOUDCLI_ROLE;
  const previousScheduler = process.env.CLOUDCLI_ENABLE_PROJECT_SCHEDULER;
  restoreEnvironment(t, 'CLOUDCLI_ROLE', previousRole);
  restoreEnvironment(t, 'CLOUDCLI_ENABLE_PROJECT_SCHEDULER', previousScheduler);

  // The installed copy cannot bypass the switch for normal or super roles.
  for (const role of [undefined, 'user', 'super']) {
    for (const scheduler of [undefined, 'false']) {
      setEnvironment('CLOUDCLI_ROLE', role);
      setEnvironment('CLOUDCLI_ENABLE_PROJECT_SCHEDULER', scheduler);
      const names = scanPlugins(pluginsDirectory, config).map((plugin) => plugin.name);
      assert.equal(names.includes('project-scheduler'), false);
      assert.ok(names.includes('worker'));
      assert.equal(names.includes('private-demo'), role === 'super');
    }
  }

  // Exactly true opens the bundled scheduler once even when a copy is installed.
  process.env.CLOUDCLI_ENABLE_PROJECT_SCHEDULER = 'true';
  for (const role of [undefined, 'user', 'super']) {
    setEnvironment('CLOUDCLI_ROLE', role);
    const names = scanPlugins(pluginsDirectory, config).map((plugin) => plugin.name);
    assert.equal(names.filter((name) => name === 'project-scheduler').length, 1);
    assert.ok(names.includes('worker'));
    assert.equal(names.includes('private-demo'), role === 'super');
  }

  // Directory and asset resolution follow the same availability rule.
  process.env.CLOUDCLI_ROLE = 'user';
  delete process.env.CLOUDCLI_ENABLE_PROJECT_SCHEDULER;
  assert.equal(getPluginDir('project-scheduler'), null);
  assert.equal(resolvePluginAssetPath('project-scheduler', 'icon.svg'), null);

  const operations: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => scanPlugins(pluginsDirectory, config),
    saveConfig: () => { operations.push('save'); },
    startServer: async () => {
      operations.push('start');
      return 4000;
    },
    resolveAsset: resolvePluginAssetPath,
    assetIsFile: (assetPath) => {
      try { return fs.statSync(assetPath).isFile(); } catch { return false; }
    },
  }));

  for (const role of ['user', 'super']) {
    process.env.CLOUDCLI_ROLE = role;
    assert.throws(() => service.getManifest('project-scheduler'), { code: 'PLUGIN_NOT_FOUND' });
    await assert.rejects(service.setEnabled('project-scheduler', true), { code: 'PLUGIN_NOT_FOUND' });
    await assert.rejects(service.prepareRpc('project-scheduler'), { code: 'PLUGIN_NOT_FOUND' });
    assert.throws(
      () => service.resolveAsset('project-scheduler', 'icon.svg'),
      { code: 'PLUGIN_ASSET_NOT_FOUND' },
    );
  }
  assert.deepEqual(operations, []);

  // Exactly true restores the normal bundled scheduler behavior and dedupe.
  process.env.CLOUDCLI_ENABLE_PROJECT_SCHEDULER = 'true';
  process.env.CLOUDCLI_ROLE = 'user';
  const asset = service.resolveAsset('project-scheduler', 'icon.svg');
  assert.ok(asset.path.endsWith(`${path.sep}icon.svg`));
  assert.deepEqual(
    service.list().plugins.map((plugin) => plugin.name),
    ['project-scheduler', 'worker'],
  );
});

test('normal role can toggle an allowed plugin', async () => {
  const operations: string[] = [];
  const savedConfig: Record<string, { enabled?: boolean }> = {};
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'worker', dirName: 'worker', entry: 'index.js', server: 'server.js' }],
    readConfig: () => savedConfig,
    saveConfig: (config) => {
      operations.push('save');
      Object.assign(savedConfig, config);
    },
    getPluginDirectory: () => '/plugins/worker',
    startServer: async () => {
      operations.push('start');
      return 4000;
    },
  }));

  const listed = service.list();
  assert.equal(listed.canManagePlugins, false);
  assert.deepEqual(listed.plugins.map((plugin) => plugin.name), ['worker']);

  assert.deepEqual(await service.setEnabled('worker', true), {
    success: true,
    name: 'worker',
    enabled: true,
  });
  assert.deepEqual(operations, ['save', 'start']);
  assert.deepEqual(savedConfig, { worker: { enabled: true } });
});

test('normal role cannot toggle a plugin outside the visible set or manage plugins', async () => {
  let saved = false;
  let started = false;
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'worker', dirName: 'worker', entry: 'index.js' }],
    saveConfig: () => { saved = true; },
    startServer: async () => {
      started = true;
      return 4000;
    },
  }));

  await assert.rejects(service.setEnabled('private-demo', true), { code: 'PLUGIN_NOT_FOUND' });
  assert.equal(saved, false);
  assert.equal(started, false);

  for (const operation of [
    () => service.install('https://example.test/plugin'),
    () => service.update('worker'),
    () => service.uninstall('worker'),
  ]) {
    await assert.rejects(operation(), { code: 'PLUGIN_MANAGEMENT_FORBIDDEN' });
  }
});

test('super role keeps plugin management', async () => {
  const service = createPluginsService(dependencies({
    canManagePlugins: () => true,
    install: async () => ({ name: 'demo', displayName: 'Demo', entry: 'index.js' }),
  }));

  assert.equal(service.list().canManagePlugins, true);
  const installed = await service.install('https://example.test/demo');
  assert.equal(installed.success, true);
});
