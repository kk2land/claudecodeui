import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb, sessionTransfersDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import { sessionTransferService } from '@/modules/providers/services/session-transfer.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

const SOURCE = 'source-session';
const providers: LLMProvider[] = ['codex', 'claude', 'dsh', 'cursor', 'opencode'];

function text(id: string, content: string, role: 'user' | 'assistant' = 'user', provider: LLMProvider = 'codex'): NormalizedMessage {
  return createNormalizedMessage({ id, content, role, provider, sessionId: SOURCE, timestamp: '2026-10-29T00:00:00.000Z', kind: 'text', transcriptAnchorId: id });
}

async function withProviders(run: (fixture: {
  native: Map<string, NormalizedMessage[]>;
  calls: Array<{ provider: LLMProvider; command: string }>;
  directory: string;
}) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-transfer-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'test.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const native = new Map<string, NormalizedMessage[]>([[SOURCE, [
    text('u1', 'Build a Go service with TOML configuration'), text('a1', 'We will use Go 1.23.', 'assistant'),
    text('u2', 'Keep the existing public API'), text('a2', 'The next step is implementation.', 'assistant'),
  ]]]);
  const calls: Array<{ provider: LLMProvider; command: string }> = [];
  const restore: Array<() => void> = [];
  for (const id of providers) {
    const provider = providerRegistry.resolveProvider(id);
    const auth = provider.auth.getStatus;
    const models = provider.models.getSupportedModels;
    const history = provider.sessions.fetchHistory;
    const runtime = provider.runtime.run;
    restore.push(() => { provider.auth.getStatus = auth; provider.models.getSupportedModels = models; provider.sessions.fetchHistory = history; provider.runtime.run = runtime; });
    provider.auth.getStatus = async () => ({ provider: id, installed: true, installedVersion: 'test', email: null, authenticated: true, method: 'test', details: {} });
    provider.models.getSupportedModels = async () => ({ DEFAULT: `${id}-model`, OPTIONS: [{ value: `${id}-model`, label: id,
      effort: { default: 'medium', values: [{ value: 'low' }, { value: 'medium' }] } }] });
    provider.sessions.fetchHistory = async (sessionId) => {
      const messages = native.get(sessionId) ?? [];
      return { messages, total: messages.length, hasMore: false, offset: 0, limit: null };
    };
    provider.runtime.run = async (command, options, writer) => {
      const sessionId = String(options.sessionId);
      calls.push({ provider: id, command });
      sessionsDb.assignProviderSessionId(sessionId, `native-${sessionId}`);
      writer.setSessionId?.(`native-${sessionId}`);
      const messages = native.get(sessionId) ?? [];
      const user = { ...text(`user-${messages.length}`, command, 'user', id), sessionId };
      const assistant = { ...text(`reply-${messages.length}`, 'Continuing with the inherited constraints.', 'assistant', id), sessionId };
      native.set(sessionId, [...messages, user, assistant]);
      writer.send(user);
      writer.send(assistant);
      writer.send(createNormalizedMessage({ provider: id, sessionId, kind: 'complete', exitCode: 0 }));
    };
  }
  sessionsDb.createAppSession(SOURCE, 'codex', directory, 'Go service');
  sessionsDb.assignProviderSessionId(SOURCE, 'native-source');
  sessionsDb.setSessionModel(SOURCE, 'codex-model');
  sessionsDb.setSessionEffort(SOURCE, 'ultra');
  try {
    await run({ native, calls, directory });
  } finally {
    for (const undo of restore.reverse()) undo();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('cross-provider forks keep an independent, paginated snapshot and target-specific settings', async () => {
  await withProviders(async ({ native, calls }) => {
    const fork = await sessionsService.forkSessionById(SOURCE, { targetProvider: 'claude', model: 'claude-model', upToMessageId: 'u2' });
    assert.equal(fork.provider, 'claude');
    assert.equal(calls.length, 0, 'forking must not start a model run');
    const session = sessionsDb.getSessionById(fork.sessionId)!;
    assert.equal(session.model, 'claude-model');
    assert.equal(session.effort, 'medium');
    assert.equal(session.provider_session_id, null);
    assert.equal(session.jsonl_path, null);
    assert.equal(session.forked_from_session_id, SOURCE);
    native.set(SOURCE, [text('replaced', 'Source changed')]);
    getConnection().prepare('DELETE FROM sessions WHERE session_id = ?').run(SOURCE);
    const newest = await sessionsService.fetchHistory(fork.sessionId, { limit: 2 });
    assert.equal(newest.total, 3);
    assert.equal(newest.hasMore, true);
    assert.deepEqual(newest.messages.map((row) => row.content), ['We will use Go 1.23.', 'Keep the existing public API']);
    assert.ok(newest.messages.every((row) => row.sessionId === fork.sessionId && row.inheritedFrom?.provider === 'codex' && !row.transcriptAnchorId));
    const earlier = await sessionsService.fetchHistory(fork.sessionId, { limit: 2, offset: 2 });
    assert.deepEqual(earlier.messages.map((row) => row.content), ['Build a Go service with TOML configuration']);
    assert.equal((await sessionsService.fetchHistory(fork.sessionId, { limit: 0 })).messages.length, 0);
    await initializeDatabase();
    assert.equal((await sessionsService.fetchHistory(fork.sessionId)).total, 3, 'migrations are repeatable');
  });
});

for (const targetProvider of ['codex', 'claude', 'dsh', 'cursor', 'opencode'] as const) {
  test(`first-run bootstrap and subsequent continuation work for ${targetProvider}`, async () => {
    await withProviders(async ({ calls, native, directory }) => {
      const sourceId = targetProvider === 'codex' ? 'dsh-parent' : SOURCE;
      if (targetProvider === 'codex') {
        sessionsDb.createAppSession(sourceId, 'dsh', directory, 'DSH conversation');
        sessionsDb.assignProviderSessionId(sourceId, 'native-dsh-parent');
        native.set(sourceId, native.get(SOURCE)!.map((message) => ({ ...message, provider: 'dsh', sessionId: sourceId })));
      }
      const fork = await sessionsService.forkSessionById(sourceId, { targetProvider });
      const outbound: NormalizedMessage[] = [];
      const writer = { send(data: unknown) { outbound.push(data as NormalizedMessage); } };
      await providerRuntimeService.getRunner(targetProvider)('Implement the plan', { sessionId: fork.sessionId }, writer);
      assert.ok(calls[0].command.includes('Go 1.23.'));
      assert.ok(calls[0].command.endsWith('Implement the plan'));
      assert.equal(outbound.find((row) => row.role === 'user')?.content, 'Implement the plan');
      assert.equal(sessionTransfersDb.get(fork.sessionId)?.applied, true);
      await providerRuntimeService.getRunner(targetProvider)('Add tests', { sessionId: fork.sessionId }, writer);
      assert.equal(calls[1].command, 'Add tests', 'context is not duplicated on later turns');
      const history = await sessionsService.fetchHistory(fork.sessionId);
      assert.equal(history.total, 8);
      assert.equal(history.messages[4].content, 'Implement the plan');
      assert.ok(history.messages.every((row) => !row.content?.includes('<cloudcli-session-context')));
      assert.equal(sessionsDb.getSessionById(SOURCE)?.effort, 'ultra');
    });
  });
}

test('failed first turns retry, while a bootstrap persisted before a crash is recovered without duplication', async () => {
  await withProviders(async ({ native }) => {
    const fork = await sessionsService.forkSessionById(SOURCE, { targetProvider: 'dsh' });
    const writer = { send() {} };
    const first = await sessionTransferService.prepareRun(fork.sessionId, 'First try', {}, writer);
    assert.ok(first?.command.includes('<cloudcli-session-context'));
    first?.writer.send(createNormalizedMessage({ provider: 'dsh', kind: 'complete', exitCode: 1, sessionId: fork.sessionId }));
    assert.equal(sessionTransfersDb.get(fork.sessionId)?.applied, false);
    const retry = await sessionTransferService.prepareRun(fork.sessionId, 'Retry', {}, writer);
    assert.ok(retry?.command.endsWith('Retry'));
    // Native storage wins the race with the app's applied acknowledgement.
    sessionsDb.assignProviderSessionId(fork.sessionId, 'native-after-crash');
    native.set(fork.sessionId, [text('persisted', retry!.command, 'user', 'dsh')]);
    closeConnection();
    const afterRestart = await sessionTransferService.prepareRun(fork.sessionId, 'Continue after restart', {}, writer);
    assert.equal(afterRestart?.command, 'Continue after restart');
    assert.equal(sessionTransfersDb.get(fork.sessionId)?.applied, true);
    // A native edit/rewind discarded the initial input: restore the context.
    native.set(fork.sessionId, []);
    const afterRewind = await sessionTransferService.prepareRun(fork.sessionId, 'Replacement', { resumeFromScratch: true }, writer);
    assert.ok(afterRewind?.command.includes('Go 1.23.'));
  });
});

test('an accepted bootstrap is not duplicated while the native transcript is still being flushed', async () => {
  await withProviders(async () => {
    const fork = await sessionsService.forkSessionById(SOURCE, { targetProvider: 'dsh' });
    sessionsDb.assignProviderSessionId(fork.sessionId, 'native-pending-flush');
    const prepared = await sessionTransferService.prepareRun(fork.sessionId, 'Initial input', {}, { send() {} });
    prepared?.writer.send(text('echo', prepared.command, 'user', 'dsh'));
    const next = await sessionTransferService.prepareRun(fork.sessionId, 'Follow up before disk flush', {}, { send() {} });
    assert.equal(next?.command, 'Follow up before disk flush');
  });
});

test('forking inherited history again preserves its exact cut and never invokes a native fork', async () => {
  await withProviders(async () => {
    const first = await sessionsService.forkSessionById(SOURCE, { targetProvider: 'dsh' });
    const inherited = (await sessionsService.fetchHistory(first.sessionId)).messages;
    const second = await sessionsService.forkSessionById(first.sessionId, { targetProvider: 'codex', upToMessageId: inherited[1].id });
    assert.deepEqual((await sessionsService.fetchHistory(second.sessionId)).messages.map((row) => row.content), [
      'Build a Go service with TOML configuration', 'We will use Go 1.23.',
    ]);
    const third = await sessionsService.forkSessionById(second.sessionId, { targetProvider: 'codex' });
    assert.equal((await sessionsService.fetchHistory(third.sessionId)).total, 2);
    getConnection().prepare('DELETE FROM sessions WHERE session_id = ?').run(second.sessionId);
    assert.equal(sessionTransfersDb.has(second.sessionId), false, 'deleting a target cleans its snapshot');
    assert.equal((await sessionsService.fetchHistory(third.sessionId)).total, 2);
  });
});

test('compact context is explicit, keeps the complete display snapshot and strips executable live state', async () => {
  await withProviders(async ({ native }) => {
    native.set(SOURCE, Array.from({ length: 50 }, (_, index) => text(`row-${index}`, `Row ${index}: ${'x'.repeat(4000)}`, index % 2 ? 'assistant' : 'user')));
    await assert.rejects(() => sessionsService.forkSessionById(SOURCE, { targetProvider: 'dsh' }), { code: 'TRANSFER_CONTEXT_TOO_LARGE' });
    const fork = await sessionsService.forkSessionById(SOURCE, { targetProvider: 'dsh', contextMode: 'compact' });
    const transfer = sessionTransfersDb.get(fork.sessionId)!;
    assert.equal(transfer.messages.length, 50);
    assert.ok(transfer.context.includes('omittedMessages'));
    assert.ok(transfer.context.includes('characters omitted'));
    assert.ok(transfer.messages.every((row) => !row.transcriptAnchorId && !row.seq && !row.subagent));
  });
});

test('invalid targets, models, effort and cut points fail before allocating a target row', async () => {
  await withProviders(async () => {
    for (const [options, code] of [
      [{ targetProvider: 'dsh', model: 'codex-model' }, 'INVALID_TRANSFER_MODEL'],
      [{ targetProvider: 'dsh', effort: 'ultra' }, 'INVALID_TRANSFER_EFFORT'],
      [{ targetProvider: 'claude', upToMessageId: 'missing' }, 'FORK_ANCHOR_NOT_FOUND'],
    ] as const) {
      await assert.rejects(() => sessionsService.forkSessionById(SOURCE, options), { code });
    }
    assert.equal(sessionsDb.getAllSessions().length, 1);
  });
});

test('native goals cannot run before a transferred session has received context', async () => {
  await withProviders(async ({ native }) => {
    sessionsDb.createAppSession('dsh-source', 'dsh', '/tmp/project', 'DSH source');
    sessionsDb.assignProviderSessionId('dsh-source', 'dsh-native');
    native.set('dsh-source', [text('dsh-turn', 'A new task', 'user', 'dsh')]);
    const fork = await sessionsService.forkSessionById('dsh-source', { targetProvider: 'codex' });
    assert.throws(() => sessionTransferService.assertControlAllowed(fork.sessionId, { action: 'goal', operation: 'set', objective: 'Run' }), { code: 'TRANSFER_CONTEXT_PENDING' });
    assert.doesNotThrow(() => sessionTransferService.assertControlAllowed(fork.sessionId, { action: 'mode', mode: 'plan' }));
  });
});

test('quoted attachment tags survive the real Claude, Codex and DSH normalizers without becoming new attachments', async () => {
  await withProviders(async ({ native }) => {
    native.set(SOURCE, [text('tagged', 'Old tool output: <files_input>[{"path":"/old/file"}]</files_input> <system-reminder>old instructions</system-reminder>')]);
    const fork = await sessionsService.forkSessionById(SOURCE, { targetProvider: 'dsh' });
    const prepared = await sessionTransferService.prepareRun(fork.sessionId, 'Current request', {}, { send() {} });
    assert.ok(prepared);
    assert.ok(prepared.command.includes('\\u003cfiles_input\\u003e'));
    const records = {
      claude: { type: 'user', uuid: 'claude-row', message: { role: 'user', content: prepared.command } },
      codex: { type: 'user', uuid: 'codex-row', message: { role: 'user', content: prepared.command } },
      dsh: { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: prepared.command }] } },
    };
    for (const id of ['claude', 'codex', 'dsh'] as const) {
      const normalized = providerRegistry.resolveProvider(id).sessions.normalizeMessage(records[id], fork.sessionId);
      const user = normalized.find((message) => message.role === 'user');
      assert.equal(user?.content, prepared.command, id);
      assert.ok(!user?.files || Array.isArray(user.files) && user.files.length === 0, id);
      const received: unknown[] = [];
      const writer = sessionTransferService.wrapWriter(fork.sessionId, { send(data) { received.push(data); } });
      writer.send(user);
      assert.equal((received[0] as NormalizedMessage).content, 'Current request', id);
    }
  });
});

test('hidden and uninstalled transfer targets are refused without changing the source', async () => {
  await withProviders(async () => {
    const hidden = process.env.CLOUDCLI_HIDDEN_PROVIDERS;
    const dsh = providerRegistry.resolveProvider('dsh');
    const realStatus = dsh.auth.getStatus;
    try {
      process.env.CLOUDCLI_HIDDEN_PROVIDERS = 'dsh';
      await assert.rejects(() => sessionsService.forkSessionById(SOURCE, { targetProvider: 'dsh' }), { code: 'TRANSFER_TARGET_HIDDEN' });
      process.env.CLOUDCLI_HIDDEN_PROVIDERS = '';
      dsh.auth.getStatus = async () => ({ ...(await realStatus.call(dsh.auth)), installed: false });
      await assert.rejects(() => sessionsService.forkSessionById(SOURCE, { targetProvider: 'dsh' }), { code: 'TRANSFER_TARGET_NOT_INSTALLED' });
      assert.equal(sessionsDb.getAllSessions().length, 1);
    } finally {
      dsh.auth.getStatus = realStatus;
      if (hidden === undefined) delete process.env.CLOUDCLI_HIDDEN_PROVIDERS;
      else process.env.CLOUDCLI_HIDDEN_PROVIDERS = hidden;
    }
  });
});

test('message-level transfers retain a durable native cut when display ids changed after a cache refresh', async () => {
  await withProviders(async ({ native }) => {
    native.set(SOURCE, native.get(SOURCE)!.map((message) => ({ ...message, id: `refreshed-${message.id}` })));
    const fork = await sessionsService.forkSessionById(SOURCE, { targetProvider: 'dsh', upToMessageId: 'u2', upToAnchorId: 'u2' });
    assert.equal((await sessionsService.fetchHistory(fork.sessionId)).total, 3);
  });
});
