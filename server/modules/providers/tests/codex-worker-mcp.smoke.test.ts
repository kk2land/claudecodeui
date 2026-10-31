import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { CodexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import type { AnyRecord } from '@/shared/index.js';

test('bundled app-server supplies Worker MCP without config.toml entries and isolates thread credentials', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-worker-mcp-'));
  const previousHome = process.env.CODEX_HOME;
  const observed: Array<{ method?: string; authorization?: string }> = [];
  const connections = new Set<McpServer>();
  const http = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const chunk of request) parts.push(Buffer.from(chunk));
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : undefined;
    if (request.url?.endsWith('/responses')) {
      const item = { id: 'local-message', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Local fixture completed.', annotations: [] }] };
      const frames = [
        { type: 'response.created', response: { id: 'local-response' } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'local-response', status: 'completed', output: [item],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
      ];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
      return;
    }
    observed.push({ method: body?.method, authorization: request.headers.authorization });
    const server = new McpServer({ name: 'local-worker', version: '1' });
    server.registerTool('worker_context', { inputSchema: {}, description: 'Local Worker context fixture' }, async () => ({
      content: [{ type: 'text', text: request.headers.authorization ?? 'none' }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    connections.add(server);
    response.on('close', () => {
      void transport.close(); void server.close(); connections.delete(server);
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/worker-mcp`;
  const original = `model="gpt-5.4"\nmodel_provider="local"\n[model_providers.local]\nname="local"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`;
  await writeFile(path.join(root, 'config.toml'), original);
  process.env.CODEX_HOME = root;
  const client = new CodexAppServerTransport();
  client.setWorkerMcpUrl(url);
  const completed = new Set<string>();
  client.onNotification((frame) => {
    if (frame.method === 'turn/completed') completed.add(frame.params!.threadId);
  });
  const options = { cwd: root, model: 'gpt-5.4', modelProvider: 'local', approvalPolicy: 'never' };
  try {
    for (const owner of ['owner-a', 'owner-b']) {
      const start = await client.request('thread/start', {
        ...options, historyMode: 'legacy', config: { 'mcp_servers.cloudcli_workers': {
          url, enabled: true, http_headers: { Authorization: `Bearer ${owner}` },
        } },
      });
      const status = await client.request('mcpServerStatus/list', {
        threadId: start.thread.id, serverName: 'cloudcli_workers', detail: 'toolsAndAuthOnly',
      });
      const worker = status.data.find((server: AnyRecord) => server.name === 'cloudcli_workers');
      assert(worker?.tools.worker_context);
      assert(observed.some((request) => request.method === 'tools/list' && request.authorization === `Bearer ${owner}`));
      // Codex persists the rollout on its first real turn; an empty new thread cannot resume yet.
      await client.request('turn/start', { threadId: start.thread.id,
        input: [{ type: 'text', text: 'Reply with the local fixture.' }] });
      const deadline = Date.now() + 10_000;
      while (!completed.has(start.thread.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert(completed.has(start.thread.id), 'the local model turn must complete before resume');
      const resumed = await client.request('thread/resume', {
        ...options, threadId: start.thread.id, config: { 'mcp_servers.cloudcli_workers': {
          url, enabled: true, http_headers: { Authorization: `Bearer ${owner}` },
        } },
      });
      assert.equal(resumed.thread.id, start.thread.id);
    }
    const beforeDisabled = observed.length;
    for (const config of [undefined, { 'mcp_servers.cloudcli_workers.enabled': false }]) {
      const start = await client.request('thread/start', { ...options, ...(config ? { config } : {}) });
      const status = await client.request('mcpServerStatus/list', {
        threadId: start.thread.id, serverName: 'cloudcli_workers', detail: 'toolsAndAuthOnly',
      });
      assert(status.data.every((server: AnyRecord) => Object.keys(server.tools).length === 0));
    }
    assert.equal(observed.length, beforeDisabled, 'disabled and prediction-only threads never connect to Worker MCP');
    assert.equal(await readFile(path.join(root, 'config.toml'), 'utf8'), original);
  } finally {
    await client.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    for (const server of connections) await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
