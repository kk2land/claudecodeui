import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext, StageLogBridge } from '@/shared/index.js';

type CapturedConfig = { features?: { goals?: boolean }; mcp_servers?: AnyRecord };

/** Stands in for the Codex CLI: records the argv the SDK actually spawns. */
const fakeCodex = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
});
`;

function context(): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
}

/** Captures the options the provider hands to the real Codex constructor. */
async function runWithConfig(t: TestContext, bridge: StageLogBridge | null): Promise<CapturedConfig | undefined> {
  const thread = {
    id: 'native-thread',
    async runStreamed() {
      return {
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'native-thread' };
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
        })(),
      };
    },
  } as unknown as Thread;
  let captured: CapturedConfig | undefined;
  t.mock.method(Codex.prototype, 'startThread', function (this: { options?: { config?: CapturedConfig } }) {
    captured = this.options?.config;
    return thread;
  } as never);
  codexRuntime.setStageLogBridge(bridge);
  try {
    await codexRuntime.run('hello', {
      sessionId: 'app-session',
      cwd: process.cwd(),
      projectPath: process.cwd(),
    }, { send: () => {}, userId: null }, context());
  } finally {
    codexRuntime.setStageLogBridge(null);
    // The fixture below constructs a real Codex instance, so the constructor
    // spy must be gone before it runs.
    t.mock.restoreAll();
  }
  return captured;
}

function residentBridge(connection: { url: string; headers: Record<string, string> } | null) {
  const prepares: Array<AnyRecord> = [];
  const closed: string[] = [];
  const bridge: StageLogBridge & { prepares: Array<AnyRecord>; closed: string[] } = {
    prepares,
    closed,
    async prepareSession(input) {
      prepares.push(input as AnyRecord);
      return connection;
    },
    closeRuntime(runtimeInstanceId) { closed.push(runtimeInstanceId); },
  };
  return bridge;
}

test('exec passes the stage-log server through the existing SDK constructor config', async (t) => {
  const bridge = residentBridge({ url: 'http://127.0.0.1:3001/api/scheduler-mcp', headers: { Authorization: 'Bearer resident-token' } });
  const config = await runWithConfig(t, bridge);
  assert.deepEqual(config, {
    features: { goals: false },
    mcp_servers: {
      cloudcli_scheduler: {
        url: 'http://127.0.0.1:3001/api/scheduler-mcp',
        http_headers: { Authorization: 'Bearer resident-token' },
        enabled: true,
      },
    },
  });
  assert.equal(bridge.prepares.length, 1);
  assert.equal(bridge.prepares[0].sessionId, 'app-session');
  assert.equal(bridge.prepares[0].provider, 'codex');
  assert.equal(bridge.prepares[0].projectPath, process.cwd());
  assert.equal(bridge.prepares[0].userId, null);
  assert.match(String(bridge.prepares[0].runtimeInstanceId), /^codex-exec:[^:]+$/);
  // The per-run CLI process is gone, so its temporary token is released.
  assert.deepEqual(bridge.closed, [String(bridge.prepares[0].runtimeInstanceId)]);
});

test('exec keeps the goals-only constructor config when the host declines logging', async (t) => {
  const bridge = residentBridge(null);
  const config = await runWithConfig(t, bridge);
  assert.deepEqual(config, { features: { goals: false } });
  assert.deepEqual(bridge.closed, [String(bridge.prepares[0].runtimeInstanceId)]);
});

test('exec without a stage-log bridge is unchanged', async (t) => {
  const config = await runWithConfig(t, null);
  assert.deepEqual(config, { features: { goals: false } });
});

test('a failing resident bridge never blocks the run', async (t) => {
  const prepares: Array<AnyRecord> = [];
  const bridge: StageLogBridge = {
    async prepareSession(input) { prepares.push(input as AnyRecord); throw new Error('host unavailable'); },
    closeRuntime() { throw new Error('host unavailable'); },
  };
  const config = await runWithConfig(t, bridge);
  assert.deepEqual(config, { features: { goals: false } });
  assert.equal(prepares.length, 1);
});

test('the captured config serializes into the --config overrides a real Codex CLI reads', { timeout: 30_000 }, async (t) => {
  const bridge = residentBridge({ url: 'http://127.0.0.1:3001/api/scheduler-mcp', headers: { Authorization: 'Bearer resident-token' } });
  const config = await runWithConfig(t, bridge);
  assert.ok(config);

  // Offline fixture: the real SDK spawns this stand-in CLI and passes the same
  // structured config, so the argv proves what the real CLI consumes.
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-exec-config-'));
  const bin = path.join(root, 'fake-codex.mjs');
  const log = path.join(root, 'argv.jsonl');
  await writeFile(bin, fakeCodex, { mode: 0o755 });
  process.env.FAKE_CODEX_LOG = log;
  try {
    const codex = new Codex({ config: config as never, codexPathOverride: bin });
    const streamed = await codex.startThread({ workingDirectory: process.cwd(), skipGitRepoCheck: true }).runStreamed('hello');
    for await (const _event of streamed.events) { /* drain the fixture stream */ }
    const [argv] = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    const configs = argv.reduce((values: string[], argument: string, index: number) =>
      argument === '--config' ? [...values, argv[index + 1]] : values, []);
    assert.ok(configs.includes('mcp_servers.cloudcli_scheduler.url="http://127.0.0.1:3001/api/scheduler-mcp"'), configs.join('\n'));
    assert.ok(configs.includes('mcp_servers.cloudcli_scheduler.http_headers.Authorization="Bearer resident-token"'), configs.join('\n'));
    assert.ok(configs.includes('mcp_servers.cloudcli_scheduler.enabled=true'), configs.join('\n'));
    assert.ok(configs.includes('features.goals=false'), configs.join('\n'));
  } finally {
    delete process.env.FAKE_CODEX_LOG;
    await rm(root, { recursive: true, force: true });
  }
});

test('the injected connection discovers stage_log over the real MCP protocol', { timeout: 30_000 }, async (t) => {
  const authorizations: Array<string | undefined> = [];
  const connections = new Set<McpServer>();
  const http = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : undefined;
    authorizations.push(request.headers.authorization);
    const server = new McpServer({ name: 'cloudcli-stage-log', version: 'fixture' });
    server.registerTool('stage_log', {
      description: 'Record one resident task milestone.',
      inputSchema: {},
      annotations: { readOnlyHint: false },
    }, async () => ({ content: [{ type: 'text' as const, text: '{"recorded":true}' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    connections.add(server);
    response.on('close', () => { void transport.close(); void server.close(); connections.delete(server); });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const server of connections) await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  assert(address && typeof address !== 'string');

  const bridge = residentBridge({
    url: `http://127.0.0.1:${address.port}/api/scheduler-mcp`,
    headers: { Authorization: 'Bearer resident-token' },
  });
  const config = await runWithConfig(t, bridge);
  const injected = config?.mcp_servers?.cloudcli_scheduler as { url: string; http_headers: Record<string, string> };
  assert(injected);

  const client = new Client({ name: 'stage-log-discovery', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(injected.url), {
    requestInit: { headers: injected.http_headers },
  });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === 'stage_log'), JSON.stringify(listed.tools.map((tool) => tool.name)));
  assert.ok(authorizations.length > 0);
  assert.ok(authorizations.every((value) => value === 'Bearer resident-token'));
});
