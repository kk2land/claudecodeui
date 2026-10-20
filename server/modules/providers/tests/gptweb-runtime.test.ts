import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';

import { CodexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { createCodexSdkRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { getCodexHome, getCodexProcessEnv } from '@/shared/index.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

test('GPT Web requires its own home and never changes the parent CODEX_HOME', async (t) => {
  const previous = process.env.CODEX_GPTWEB_HOME;
  try {
    delete process.env.CODEX_GPTWEB_HOME;
    assert.throws(() => getCodexHome('gptweb'), /CODEX_GPTWEB_HOME/);
    const { GptwebProvider } = await import('@/modules/providers/list/gptweb/gptweb.provider.js');
    const provider = new GptwebProvider();
    assert.equal(provider.id, 'gptweb');
    assert.match((await provider.auth.getStatus()).error!, /CODEX_GPTWEB_HOME/);
    await provider.runtime.close?.();
    process.env.CODEX_GPTWEB_HOME = 'relative/home';
    assert.throws(() => getCodexHome('gptweb'), /absolute/);
    process.env.CODEX_GPTWEB_HOME = '/tmp/gptweb-profile';
    const parent = process.env.CODEX_HOME;
    const sdkEnvironments: Array<Record<string, string>> = [];
    t.mock.method(Codex.prototype, 'startThread', function (this: Codex) {
      sdkEnvironments.push((this as unknown as { options: { env: Record<string, string> } }).options.env);
      return { id: 'native-thread', async runStreamed() {
        return { events: (async function* () { yield { type: 'thread.started', thread_id: 'native-thread' }; })() };
      } } as unknown as Thread;
    });
    const context: ProviderRuntimeContext = { resolveProviderSessionId: () => null, resolveResumeModel: async () => 'web-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'web-model' }), normalizeMessage: () => [], isProviderInstalled: async () => true };
    for (const id of ['gptweb', 'codex'] as const) {
      const messages: Array<Record<string, unknown>> = [];
      await createCodexSdkRuntime(id).run('hello', { sessionId: `${id}-session`, cwd: '/tmp' },
        { isWebSocketWriter: true, send: data => { messages.push(data as Record<string, unknown>); } }, context);
      assert.ok(messages.some(message => message.kind === 'complete' && message.provider === id));
    }
    assert.equal(sdkEnvironments[0].CODEX_HOME, '/tmp/gptweb-profile');
    assert.equal(sdkEnvironments[0].PATH, process.env.PATH);
    assert.equal(sdkEnvironments[1].CODEX_HOME, parent);
    assert.equal(process.env.CODEX_HOME, parent);
  } finally {
    if (previous === undefined) delete process.env.CODEX_GPTWEB_HOME; else process.env.CODEX_GPTWEB_HOME = previous;
  }
});

test('app-server production spawn applies the GPT Web environment to its own child', async (t) => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const frame = JSON.parse(String(chunk));
    if (frame.id !== undefined) queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: frame.id, result: {} })}\n`));
    done();
  } });
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
  const spawn = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  const previous = process.env.CODEX_GPTWEB_HOME;
  process.env.CODEX_GPTWEB_HOME = '/tmp/another-gptweb-home';
  const transport = new CodexAppServerTransport({ env: () => getCodexProcessEnv('gptweb') });
  try {
    await transport.request('ping');
    assert.equal(spawn.mock.calls[0].arguments[2]?.env?.CODEX_HOME, '/tmp/another-gptweb-home');
    assert.ok((spawn.mock.calls[0].arguments[1] as string[]).includes('app-server'));
  } finally {
    await transport.close();
    spawn.mock.restore(); syncBuiltinESMExports();
    if (previous === undefined) delete process.env.CODEX_GPTWEB_HOME; else process.env.CODEX_GPTWEB_HOME = previous;
  }
});
