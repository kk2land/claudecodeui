import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';
import { DshRuntimeProvider } from '@/modules/providers/list/dsh/dsh-runtime.provider.js';
import { DshSessionStore } from '@/modules/providers/list/dsh/dsh-session-store.provider.js';
import { DshSessionsProvider } from '@/modules/providers/list/dsh/dsh-sessions.provider.js';
import type { AnyRecord, DshRuntimeSettings, ProviderRuntimeContext } from '@/shared/types.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';

// Opt in with an independently installed @deepseek-ai/dsh@0.2.1-rc.2 binary.
// Only the real CLI is external: model requests stay on this local HTTP server,
// with a test key and isolated homes, so no account or paid service is needed.
const bin = process.env.CLOUDCLI_DSH_SMOKE_BIN;
const mcpActor = `import {createInterface} from 'node:readline';
const rl=createInterface({input:process.stdin});
rl.on('line',line=>{
  const frame=JSON.parse(line);
  if(frame.id===undefined)return;
  const result=frame.method==='initialize'
    ? {protocolVersion:frame.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local-smoke',version:'1'}}
    : frame.method==='tools/list'
      ? {tools:[{name:'ping',description:'Return a local fixture.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]}
      : {content:[{type:'text',text:process.env.CLOUDCLI_MCP_TEXT}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result})+'\\n');
});
rl.on('close',()=>process.exit(0));
`;

for (const mode of ['acp', 'headless'] as const) {
  test(`published DSH CLI ${mode} reads uploaded images, runs native/MCP tools, resumes native history, and cleans up`, { skip: !bin, timeout: 60_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-cli-smoke-'));
    const home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
    await mkdir(home); await mkdir(cwd);
    const file = path.join(cwd, 'fixture.txt'), mcpFile = path.join(root, 'local-mcp.mjs');
    await writeFile(file, 'DSH_LOCAL_TOOL_CONTENT\n');
    await writeFile(mcpFile, mcpActor);
    // Use the real upload root, outside the CLI's isolated home and workspace.
    await mkdir(getGlobalImageAssetsDir(), { recursive: true });
    const image = { path: path.join(getGlobalImageAssetsDir(), `${path.basename(root)}.png`), name: '截图.png', mimeType: 'image/png' };
    await writeFile(image.path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAABJRU5ErkJggg==', 'base64'));
    const requests: AnyRecord[] = [];
    const answer = '本地协议验证✅' + 'x'.repeat(9000);
    const http = createServer(async (request, response) => {
      try {
        if (request.method !== 'POST' || !request.url?.endsWith('/messages')) {
          response.writeHead(404); response.end('Unexpected local endpoint'); return;
        }
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
        requests.push(body);
        const tool = requests.length === 1 || body.model === 'text-only' && requests.filter((entry) => entry.model === 'text-only').length === 1;
        const events = [
          { type: 'message_start', message: { id: `local-${requests.length}`, model: body.model, usage: { input_tokens: 12, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: tool
            ? { type: 'tool_use', id: 'local-read', name: 'read', input: {} }
            : { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: tool
            ? { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: file }) }
            : { type: 'text_delta', text: answer } },
          { type: 'content_block_stop', index: 0 },
          ...(tool ? [
            { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'local-mcp', name: 'mcp__local__ping', input: {} } },
            { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'local-image', name: 'read_image', input: {} } },
            { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: image.path }) } },
            { type: 'content_block_stop', index: 2 },
          ] : []),
          { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } catch (error) { response.destroy(error as Error); }
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    assert(address && typeof address !== 'string');
    const patch = path.join(root, 'local.patch.yml');
    await writeFile(patch, JSON.stringify([
      { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${address.port}/anthropic`, models: [
        { id: 'deepseek-v4-flash', inputModalities: ['text', 'image'] }, { id: 'text-only', inputModalities: ['text'] },
      ], reasoningEffort: 'off' } },
      { id: 'llm-deepseek-account', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { id: 'agent-instructions', disabled: true },
    ]));
    const configuration = new DshConfigurationProvider({
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT,
      HOME: home, USERPROFILE: home, TMPDIR: os.tmpdir(),
      CLOUDCLI_DSH_BIN: bin, CLOUDCLI_DSH_RUNTIME: mode, DSH_HOME: home,
      CLOUDCLI_DSH_PATCHES: JSON.stringify([patch]), CLOUDCLI_DSH_TIMEOUT_MS: '15000',
      DEEPSEEK_API_KEY: 'local-test-key', NO_PROXY: '127.0.0.1,localhost',
    });
    const events = new DshEventsProvider();
    const mcp = new DshMcpProvider(configuration);
    await mcp.upsertServer({ name: 'local', scope: 'project', workspacePath: cwd, transport: 'stdio', command: process.execPath,
      args: [mcpFile], env: { CLOUDCLI_MCP_TEXT: 'DSH_LOCAL_MCP_CONTENT' } });
    const saved = new Map<string, DshRuntimeSettings>();
    const settings = { getDsh: (id: string) => saved.get(id) ?? null, saveDsh: (id: string, value: DshRuntimeSettings) => { saved.set(id, value); } };
    const createRuntime = () => new DshRuntimeProvider(configuration, events, mcp, { synchronize: async () => 0 }, settings);
    let runtime = createRuntime();
    let nativeId: string | null = null;
    const messages: AnyRecord[] = [];
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => nativeId, resolveResumeModel: async (_id, model) => model ?? undefined,
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }),
      normalizeMessage: () => [], isProviderInstalled: async () => true,
    };
    const run = (prompt: string, options: AnyRecord = {}) => runtime.run(prompt, { sessionId: 'local-app', cwd, model: 'deepseek-official/deepseek-v4-flash', ...options }, {
      send: (message) => messages.push(message as AnyRecord), setSessionId: (id) => { nativeId = id; },
    }, context);
    try {
      await run('Read fixture.txt and report its contents.', { images: [image] });
      assert(nativeId);
      const originalId = nativeId;
      assert(messages.some((message) => message.kind === 'tool_use' && message.toolName === 'read'));
      assert(messages.some((message) => message.kind === 'tool_result' && message.content?.includes('DSH_LOCAL_TOOL_CONTENT') && message.isError === false));
      assert(messages.some((message) => message.kind === 'tool_use' && message.toolName === 'mcp__local__ping'));
      assert(messages.some((message) => message.kind === 'tool_result' && message.content?.includes('DSH_LOCAL_MCP_CONTENT') && message.isError === false));
      assert(messages.some((message) => message.kind === 'tool_use' && message.toolName === 'read_image'));
      assert(messages.some((message) => message.kind === 'tool_result' && message.toolId === 'local-image' && message.isError === false),
        JSON.stringify(messages.filter((message) => message.toolId === 'local-image')));
      const hasImageBytes = (value: unknown): boolean => {
        if (!value || typeof value !== 'object') return false;
        const block = value as AnyRecord;
        return block.type === 'image' && block.source?.type === 'base64' && Boolean(block.source.data)
          || Object.values(value).some(hasImageBytes);
      };
      assert(JSON.stringify(requests[0].messages).includes(image.path), 'the uploaded image path reaches the real CLI prompt');
      assert(hasImageBytes(requests[1].messages), 'read_image must deliver image bytes to the model');
      assert(messages.some((message) => message.kind === 'text' && message.content === answer));
      await run('Continue the same conversation.');
      await runtime.close();
      runtime = createRuntime();
      await run('Resume after a process restart.');
      assert.equal(nativeId, originalId);
      assert.equal(runtime.listActiveSessions().length, 0);
      assert.equal(runtime.management.getState('local-app').diagnostics.running, mode === 'acp');
      assert.equal(messages.filter((message) => message.kind === 'complete' && message.success).length, 3);
      assert(JSON.stringify(requests.at(-1)?.messages).includes('DSH_LOCAL_TOOL_CONTENT'));
      assert(JSON.stringify(requests.at(-1)?.messages).includes('DSH_LOCAL_MCP_CONTENT'));
      const sessions = new DshSessionsProvider(new DshSessionStore(configuration), events);
      const history = await sessions.fetchHistory('local-app', { providerSessionId: originalId });
      assert.deepEqual(history.messages.filter((message) => message.role === 'user').map((message) => message.content), [
        'Read fixture.txt and report its contents.', 'Continue the same conversation.', 'Resume after a process restart.',
      ]);
      assert.deepEqual(history.messages.find((message) => message.role === 'user')?.images, [{ path: image.path, name: image.name }]);
      assert.equal(history.messages.filter((message) => message.kind === 'tool_use').length, 3);
      assert(history.messages.some((message) => message.kind === 'tool_result' && message.content?.includes('DSH_LOCAL_TOOL_CONTENT') && message.isError === false));
      // Select the other actual transport, preserving the native conversation across process handoff.
      const otherMode = mode === 'acp' ? 'headless' : 'acp';
      await runtime.management.control('local-app', { action: 'runtime', runtime: otherMode });
      assert.equal(runtime.management.getState('local-app').diagnostics.running, false, 'handoff closes the old process without starting a new one');
      await run('Continue after changing transport.');
      assert.equal(nativeId, originalId);
      assert.equal(messages.filter((message) => message.kind === 'complete' && message.success).length, 4);
      if (otherMode === 'acp') {
        assert.equal(runtime.management.getState('local-app').diagnostics.running, true);
        await runtime.management.control('local-app', { action: 'stop' });
        assert.equal(runtime.management.getState('local-app').diagnostics.running, false);
        assert.equal(runtime.isQueueBlocked('local-app'), true);
      }
      const beforeTextOnly = messages.length;
      await run('Read the attached image.', { images: [image], model: 'deepseek-official/text-only' });
      assert(messages.slice(beforeTextOnly).some((message) => message.kind === 'tool_result'
        && message.toolId === 'local-image' && message.isError && message.content.includes('does not declare image input')));
      assert(requests.filter((request) => request.model === 'text-only').every((request) => !hasImageBytes(request.messages)),
        'text-only models must never receive image bytes');
    } finally {
      await runtime.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
      await rm(image.path, { force: true });
    }
  });
}
