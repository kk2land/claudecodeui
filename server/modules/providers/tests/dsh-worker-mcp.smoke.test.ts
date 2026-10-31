import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';
import { DshRuntimeProvider } from '@/modules/providers/list/dsh/dsh-runtime.provider.js';
import type { AnyRecord, DshWorkerBridge, ProviderRuntimeContext } from '@/shared/index.js';

const bin = process.env.CLOUDCLI_DSH_SMOKE_BIN;

test('published DSH ACP calls the injected HTTP Worker MCP and resumes after idle recycling', { skip: !bin, timeout: 45_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-worker-mcp-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
  await mkdir(home); await mkdir(cwd);
  const authorizations: Array<string | undefined> = [];
  const connections = new Set<McpServer>();
  let modelRequests = 0, workerCalls = 0;
  const http = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : undefined;
    if (request.url === '/worker-mcp') {
      authorizations.push(request.headers.authorization);
      const server = new McpServer({ name: 'worker-fixture', version: '1' });
      server.registerTool('worker_context', { description: 'Return the local Worker context', inputSchema: {},
        annotations: { readOnlyHint: true } }, async () => {
        workerCalls++;
        return { content: [{ type: 'text', text: 'WORKER_CONTEXT_OK' }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      connections.add(server);
      response.on('close', () => { void transport.close(); void server.close(); connections.delete(server); });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      return;
    }
    assert(request.url?.endsWith('/messages'), 'model traffic must stay on the local fixture');
    const useTool = modelRequests++ === 0;
    if (useTool) assert(body.tools.some((tool: AnyRecord) => tool.name === 'mcp__cloudcli_workers__worker_context'));
    const frames = [
      { type: 'message_start', message: { id: `local-${modelRequests}`, model: body.model,
        usage: { input_tokens: 12, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: useTool
        ? { type: 'tool_use', id: 'worker-context-call', name: 'mcp__cloudcli_workers__worker_context', input: {} }
        : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: useTool
        ? { type: 'input_json_delta', partial_json: '{}' }
        : { type: 'text_delta', text: 'Worker fixture accepted.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const patch = path.join(root, 'local-model.patch.yml');
  await writeFile(patch, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: `${origin}/anthropic`, models: [{ id: 'deepseek-v4-flash' }], reasoningEffort: 'off' } },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'agent-instructions', disabled: true },
  ]));
  const configuration = new DshConfigurationProvider({
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: os.tmpdir(),
    DSH_HOME: home, CLOUDCLI_DSH_BIN: bin, CLOUDCLI_DSH_RUNTIME: 'acp',
    CLOUDCLI_DSH_PATCHES: JSON.stringify([patch]), CLOUDCLI_DSH_IDLE_MS: '150',
    DEEPSEEK_API_KEY: 'local-test-key', NO_PROXY: 'localhost,127.0.0.1',
  });
  const runtime = new DshRuntimeProvider(configuration, new DshEventsProvider(), new DshMcpProvider(configuration),
    { synchronize: async () => 0 }, { getDsh: () => null, saveDsh: () => {} });
  const prepared: string[] = [], activated: string[] = [], stopped: string[] = [];
  const bridge: DshWorkerBridge = {
    isSessionEnabled: () => true,
    async prepareSession(input) {
      prepared.push(input.runtimeInstanceId);
      return { url: `${origin}/worker-mcp`, headers: { Authorization: 'Bearer local-worker-token' } };
    },
    async activateSession(id) { activated.push(id); },
    async stopSession(id) { stopped.push(id); return true; },
    async closeRuntime() {},
    async hasActiveWorkers() { return false; },
  };
  runtime.setWorkerBridge(bridge);
  let nativeId: string | null = null;
  const messages: AnyRecord[] = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => nativeId,
    resolveResumeModel: async (_id, model) => model ?? undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }),
    normalizeMessage: () => [], isProviderInstalled: async () => true,
  };
  const run = (options: AnyRecord) => runtime.run('Inspect the Worker context.', {
    sessionId: 'worker-app', projectPath: cwd, model: 'deepseek-official/deepseek-v4-flash',
    permissionMode: 'bypassPermissions', ...options,
  }, { send: (message) => messages.push(message as AnyRecord), setSessionId: (id) => { nativeId = id; } }, context);
  try {
    await run({ userTurn: true });
    assert.equal(workerCalls, 1);
    assert(messages.some((message) => message.kind === 'tool_result' && message.content?.includes('WORKER_CONTEXT_OK')));
    assert(authorizations.length > 0 && authorizations.every((value) => value === 'Bearer local-worker-token'));
    const originalId = nativeId;
    assert(originalId);
    const deadline = Date.now() + 10_000;
    while (runtime.management.getState('worker-app').diagnostics.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(runtime.management.getState('worker-app').diagnostics.running, false);
    assert.deepEqual(stopped, []);
    await run({ workerWakeup: true, deferTurn: () => true });
    assert.equal(nativeId, originalId);
    assert.equal(prepared.length, 2);
    assert.equal(prepared[0], prepared[1]);
    assert.deepEqual(activated, ['worker-app']);
    assert.equal(messages.filter((message) => message.kind === 'complete' && message.success).length, 2);
  } finally {
    await runtime.close();
    for (const server of connections) await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
