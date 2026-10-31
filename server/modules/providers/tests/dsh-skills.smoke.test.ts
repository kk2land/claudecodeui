import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';
import { DshMcpProvider } from '@/modules/providers/list/dsh/dsh-mcp.provider.js';
import { DshRuntimeProvider } from '@/modules/providers/list/dsh/dsh-runtime.provider.js';
import { DshSessionStore } from '@/modules/providers/list/dsh/dsh-session-store.provider.js';
import { DshSessionsProvider } from '@/modules/providers/list/dsh/dsh-sessions.provider.js';
import { DshSkillsProvider } from '@/modules/providers/list/dsh/dsh-skills.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

const bin = process.env.CLOUDCLI_DSH_SMOKE_BIN;

// Exercise native skill expansion and persisted history with a local model
// fixture, independently of the image sandbox exercised by dsh-cli.smoke.
for (const mode of ['acp', 'headless'] as const) test(`native DSH ${mode} skill invocation preserves only human prompts in history`, { skip: !bin, timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-skills-native-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'repo');
  const skillPath = path.join(cwd, '.dsh', 'skills', 'fixture', 'SKILL.md');
  await mkdir(home); await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, '---\nname: native-skill\ndescription: Local native invocation test\n---\nNATIVE_SKILL_FIXTURE_BODY\n');
  const requests: AnyRecord[] = [];
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const frames = [
      { type: 'message_start', message: { id: `reply-${requests.length}`, model: body.model, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LOCAL_SKILL_OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); assert(address && typeof address !== 'string');
  const patch = path.join(root, 'model.patch.yml');
  await writeFile(patch, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${address.port}/anthropic`, reasoningEffort: 'off' } },
    { id: 'llm-deepseek-account', disabled: true }, { id: 'session-title-llm', disabled: true }, { id: 'agent-instructions', disabled: true },
  ]));
  const config = new DshConfigurationProvider({
    PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_AGENTS_HOME: path.join(root, 'agents'),
    CLOUDCLI_DSH_BIN: bin, CLOUDCLI_DSH_RUNTIME: mode, CLOUDCLI_DSH_PATCHES: JSON.stringify([patch]),
    DEEPSEEK_API_KEY: 'local-fixture', NO_PROXY: '127.0.0.1,localhost',
  });
  const events = new DshEventsProvider();
  const createRuntime = () => new DshRuntimeProvider(config, events, new DshMcpProvider(config), { synchronize: async () => 0 }, { getDsh: () => null, saveDsh: () => {} });
  let runtime = createRuntime(), nativeId: string | null = null;
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => nativeId, resolveResumeModel: async (_id, model) => model ?? undefined,
    getProviderModels: async () => ({ DEFAULT: 'default', OPTIONS: [] }), normalizeMessage: () => [], isProviderInstalled: async () => true,
  };
  const run = (prompt: string) => runtime.run(prompt, { sessionId: 'app-skill', cwd, model: 'deepseek-official/deepseek-v4-flash' }, {
    send: () => {}, setSessionId: (id) => { nativeId = id; },
  }, context);
  try {
    const [skill] = await new DshSkillsProvider(config).listSkills({ workspacePath: cwd });
    assert.equal(skill.command, '/native-skill');
    await run(skill.command);
    assert(JSON.stringify(requests[0].messages).includes('NATIVE_SKILL_FIXTURE_BODY'));
    const originalId = nativeId; assert(originalId);
    await runtime.close(); runtime = createRuntime();
    await run('Continue after reconnect.');
    assert.equal(nativeId, originalId);
    const history = await new DshSessionsProvider(new DshSessionStore(config), events).fetchHistory('app-skill', { providerSessionId: originalId });
    assert.deepEqual(history.messages.filter((message) => message.role === 'user').map((message) => message.content), ['/native-skill', 'Continue after reconnect.']);
    assert.equal(history.total, 4);
  } finally {
    await runtime.close(); http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
