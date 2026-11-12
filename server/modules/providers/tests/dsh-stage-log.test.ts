import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';
import { DshRuntimeProvider } from '@/modules/providers/list/dsh/dsh-runtime.provider.js';
import type {
  AnyRecord,
  DshRuntimeMode,
  DshRuntimeSettings,
  DshWorkerBridge,
  ProviderRuntimeContext,
  StageLogBridge,
  StageLogMcpConfig,
} from '@/shared/index.js';

/** Minimal DSH stand-in: records argv and every patch/ACP frame it receives. */
const actor = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = (value) => appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify(value) + '\\n');
const args = process.argv.slice(2);
const patchPaths = args.flatMap((value, index, all) => value === '--patch' ? [all[index + 1]] : []);
log({ args, patches: patchPaths.map((file) => JSON.parse(readFileSync(file, 'utf8'))) });
const output = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (args.includes('--json')) {
  let input = '';
  process.stdin.on('data', (chunk) => input += chunk);
  process.stdin.on('end', () => {
    output({ type: 'session', sessionId: 'native-headless' });
    output({ type: 'status', phase: 'step_start' });
    output({ type: 'final', text: 'done' });
  });
} else {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const frame = JSON.parse(line);
    log({ frame });
    if (frame.method === 'initialize') output({ id: frame.id, result: { protocolVersion: 1, agentInfo: { version: '0.2.2-fixture' } } });
    else if (frame.method === 'session/new' || frame.method === 'session/resume') {
      output({ id: frame.id, result: { sessionId: 'native-acp', configOptions: [] } });
    } else if (frame.method === 'session/prompt') output({ id: frame.id, result: { stopReason: 'end_turn' } });
    else if (frame.method === 'session/close') output({ id: frame.id, result: {} });
  });
  rl.on('close', () => process.exit(0));
}
`;

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(mode: DshRuntimeMode) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-stage-log-'));
  const bin = path.join(root, 'fake-dsh.mjs');
  const log = path.join(root, 'calls.jsonl');
  await writeFile(bin, actor, { mode: 0o755 });
  const configuration = new DshConfigurationProvider({ ...process.env, CLOUDCLI_DSH_RUNTIME: mode, CLOUDCLI_DSH_BIN: bin,
    DSH_HOME: root, CLOUDCLI_DSH_PATCHES: '[]', CLOUDCLI_DSH_TIMEOUT_MS: '10000', FAKE_DSH_LOG: log });
  const runtime = new DshRuntimeProvider(configuration, new DshEventsProvider(), new DshMcpProvider(configuration),
    { synchronize: async () => 0 }, { getDsh: () => null, saveDsh: (_id: string, _value: DshRuntimeSettings) => {} });

  const residentPrepares: AnyRecord[] = [];
  const residentClosed: string[] = [];
  let residentConnection: StageLogMcpConfig | null = {
    url: 'http://127.0.0.1:3001/api/scheduler-mcp',
    headers: { Authorization: 'Bearer resident-token' },
  };
  runtime.setStageLogBridge({
    async prepareSession(input) {
      residentPrepares.push(input as AnyRecord);
      return residentConnection;
    },
    closeRuntime(runtimeInstanceId) { residentClosed.push(runtimeInstanceId); },
  });

  const workerPrepared: AnyRecord[] = [];
  const workerBridge: DshWorkerBridge | null = {
    isSessionEnabled: () => true,
    async prepareSession(input) {
      workerPrepared.push(input as AnyRecord);
      return { url: 'http://127.0.0.1:3001/api/worker-mcp', headers: { Authorization: 'Bearer worker-token' } };
    },
    async activateSession() {},
    async stopSession() { return true; },
    async closeRuntime() {},
    async hasActiveWorkers() { return false; },
  };
  const messages: AnyRecord[] = [];
  let captured: string | null = null;
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => captured,
    resolveResumeModel: async (_id, model) => model || 'default',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  const run = (options: AnyRecord = {}) => runtime.run('Record the milestone.', {
    sessionId: 'app', cwd: root, projectPath: root, permissionMode: 'bypassPermissions', ...options,
  }, { send: (message) => messages.push(message as AnyRecord), setSessionId: (id) => { captured = id; } }, context);

  return {
    runtime, root, run, messages, workerBridge, residentPrepares, residentClosed, workerPrepared,
    setResidentConnection(value: StageLogMcpConfig | null) { residentConnection = value; },
    setWorkerBridge(value: DshWorkerBridge | null) { runtime.setWorkerBridge(value); },
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as AnyRecord),
    close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); },
  };
}

/** Every `dsh-mcp-client` server the CLI was actually launched with. */
function launchedServers(calls: AnyRecord[]): AnyRecord[] {
  return calls.flatMap((call) => Array.isArray(call.patches)
    ? call.patches.flatMap((rows: AnyRecord[]) => Array.isArray(rows) ? rows : [])
    : []).flatMap((row: AnyRecord) => Array.isArray(row.insert) ? row.insert : [])
    .filter((row: AnyRecord) => row.name === '@deepseek-ai/dsh-mcp-client');
}

test('ACP patches the stage logger next to the Worker and never as a duplicate ACP server', async () => {
  const h = await harness('acp');
  h.runtime.setWorkerBridge(h.workerBridge);
  try {
    await h.run({ userTurn: true });
    const calls = await h.calls();
    const servers = launchedServers(calls);
    assert.deepEqual(servers.map((row) => row.config.serverName).sort(), ['cloudcli_scheduler', 'cloudcli_workers']);
    const resident = servers.find((row) => row.config.serverName === 'cloudcli_scheduler')!;
    assert.equal(resident.config.transport, 'streamable-http');
    assert.equal(resident.config.url, 'http://127.0.0.1:3001/api/scheduler-mcp');
    assert.deepEqual(resident.config.headers, { Authorization: 'Bearer resident-token' });

    // The user's servers are still the only ones passed directly to the ACP session.
    const created = calls.find((call) => call.frame?.method === 'session/new')!;
    const direct = (created.frame.params.mcpServers as AnyRecord[]).map((server) => server.name);
    assert.equal(direct.includes('cloudcli_scheduler'), false);
    assert.equal(direct.includes('cloudcli_workers'), false);

    // One logical DSH runtime id backs both host capabilities.
    assert.equal(h.residentPrepares.length, 1);
    assert.equal(h.residentPrepares[0].sessionId, 'app');
    assert.equal(h.residentPrepares[0].provider, 'dsh');
    assert.equal(h.residentPrepares[0].runtimeInstanceId, h.workerPrepared[0].runtimeInstanceId);
    assert.deepEqual(h.residentClosed, []);
    assert.equal(h.messages.some((message) => message.kind === 'error'), false);
  } finally {
    await h.close();
  }
});

test('a declined resident config leaves the ACP launch patch untouched', async () => {
  const h = await harness('acp');
  h.runtime.setWorkerBridge(h.workerBridge);
  h.setResidentConnection(null);
  try {
    await h.run({ userTurn: true });
    const servers = launchedServers(await h.calls());
    assert.deepEqual(servers.map((row) => row.config.serverName), ['cloudcli_workers']);
  } finally {
    await h.close();
  }
});

test('a changed resident config is applied on the next safe input instead of interrupting the turn', async () => {
  const h = await harness('acp');
  h.runtime.setWorkerBridge(null);
  try {
    await h.run({ userTurn: true });
    h.setResidentConnection({ url: 'http://127.0.0.1:3001/api/scheduler-mcp', headers: { Authorization: 'Bearer rotated-token' } });
    await h.run({ userTurn: true });
    const calls = await h.calls();
    assert.equal(calls.filter((call) => Array.isArray(call.args)).length, 2, 'the ACP process is relaunched');
    const latest = launchedServers(calls).filter((row) => row.config.serverName === 'cloudcli_scheduler');
    assert.deepEqual(latest.at(-1)!.config.headers, { Authorization: 'Bearer rotated-token' });
    assert.equal(h.messages.filter((message) => message.kind === 'complete' && message.success).length, 2);
  } finally {
    await h.close();
  }
});

test('headless patches the stage logger on every launch even without Workers', async () => {
  const h = await harness('headless');
  h.runtime.setWorkerBridge(null);
  try {
    await h.run({ userTurn: true });
    const servers = launchedServers(await h.calls());
    assert.deepEqual(servers.map((row) => row.config.serverName), ['cloudcli_scheduler']);
    assert.deepEqual(servers[0].config.headers, { Authorization: 'Bearer resident-token' });
    assert.deepEqual(h.workerPrepared, []);
    assert.equal(h.residentPrepares[0].provider, 'dsh');
    // Same native session id is preserved across the headless run.
    assert.equal(h.messages.some((message) => message.kind === 'error'), false);
  } finally {
    await h.close();
  }
});

test('the DSH runtime releases the host token only on runtime teardown', async () => {
  const h = await harness('acp');
  h.runtime.setWorkerBridge(null);
  try {
    await h.run({ userTurn: true });
    assert.deepEqual(h.residentClosed, []);
  } finally {
    await h.close();
  }
  assert.deepEqual(h.residentClosed, [String(h.residentPrepares[0].runtimeInstanceId)]);
});
