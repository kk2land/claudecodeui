import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshAuthProvider } from '@/modules/providers/list/dsh/dsh-auth.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';

test('headless ignores managed credentials while ACP detects a saved DSH grant without returning its token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-credentials-'));
  try {
    await writeFile(path.join(root, '.credentials.yaml'), 'version: 1\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      version: 1\n      token: example-secret-for-test\n      issuer: https://platform.deepseek.com\n');
    const env = { DSH_HOME: root, CLOUDCLI_DSH_BIN: process.execPath };
    const acp = await new DshAuthProvider(new DshConfigurationProvider(env)).getStatus();
    assert.equal(acp.authenticated, true); assert.equal(acp.method, 'dsh_account');
    assert(!JSON.stringify(acp).includes('example-secret-for-test'));
    const headless = await new DshAuthProvider(new DshConfigurationProvider({ ...env, CLOUDCLI_DSH_RUNTIME: 'headless' })).getStatus();
    assert.equal(headless.installed, true); assert.equal(headless.authenticated, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an empty exported key shadows the home .env fallback and missing executables report not installed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-env-'));
  try {
    await writeFile(path.join(root, '.env'), 'DEEPSEEK_API_KEY=home-test-key\n');
    const env = { DSH_HOME: root, CLOUDCLI_DSH_BIN: process.execPath };
    assert.equal((await new DshAuthProvider(new DshConfigurationProvider(env)).getStatus()).authenticated, true);
    assert.equal((await new DshAuthProvider(new DshConfigurationProvider({ ...env, DEEPSEEK_API_KEY: '' })).getStatus()).authenticated, false);
    assert.equal((await new DshAuthProvider(new DshConfigurationProvider({ ...env, CLOUDCLI_DSH_BIN: path.join(root, 'missing') })).getStatus()).installed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP settings preserve other entries and do not rewrite native DSH profile files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-mcp-'));
  try {
    const provider = new DshMcpProvider(new DshConfigurationProvider({ DSH_HOME: root }));
    const native = path.join(root, 'cordis.patch.yml');
    await writeFile(native, '# native user settings\n');
    await provider.upsertServer({ name: 'first', scope: 'user', transport: 'stdio', command: process.execPath, args: ['server.mjs'] });
    await provider.upsertServer({ name: 'second', scope: 'user', transport: 'http', url: 'https://example.com/mcp' });
    assert.equal((await provider.listServers()).user.length, 2);
    await provider.removeServer({ name: 'first', scope: 'user' });
    assert.deepEqual((await provider.listServers()).user.map((server) => server.name), ['second']);
    assert.equal(await readFile(native, 'utf8'), '# native user settings\n');
    await provider.upsertServer({ name: 'from_path', scope: 'user', transport: 'stdio', command: 'node' });
    assert((await provider.listServers()).user.some((server) => server.command === 'node'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const scope of ['user', 'project'] as const) test(`concurrent DSH MCP ${scope} updates preserve every addition and removal across instances`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-mcp-concurrent-'));
  try {
    const config = new DshConfigurationProvider({ DSH_HOME: root });
    const first = new DshMcpProvider(config), second = new DshMcpProvider(config);
    const options = { scope, workspacePath: path.join(root, 'workspace'), transport: 'stdio' as const, command: process.execPath };
    await Promise.all([
      first.upsertServer({ ...options, name: 'one' }),
      second.upsertServer({ ...options, name: 'two' }),
    ]);
    assert.deepEqual((await first.listServers(options))[scope].map((server) => server.name).sort(), ['one', 'two']);
    await Promise.all([
      second.removeServer({ ...options, name: 'one' }),
      first.upsertServer({ ...options, name: 'three' }),
      second.upsertServer({ ...options, name: 'four' }),
    ]);
    assert.deepEqual((await first.listServers(options))[scope].map((server) => server.name).sort(), ['four', 'three', 'two']);
    const rejected = first.upsertServer({ ...options, name: 'invalid name' });
    const accepted = second.upsertServer({ ...options, name: 'after-error' });
    await assert.rejects(rejected, /MCP names/);
    await accepted;
    assert.equal((await second.listServers(options))[scope].length, 4, 'a rejected update must not block later writes');
  } finally { await rm(root, { recursive: true, force: true }); }
});
