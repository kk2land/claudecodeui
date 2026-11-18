import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-plan-history-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * The approved plan exactly as the native handoff records it: the full markdown
 * arrives in a `function_call_output` with a namespace/name pair and no call id.
 */
const PLAN_OUTPUT = [
  '',
  '# 已批准计划 / Approved Plan',
  '',
  '## 背景',
  '本计划用于验证原生 approved plan 注入不会截断中文内容，并且保留完整的多段结构。',
  '',
  '```ts',
  'const answer = 42; // 保留首尾空白与代码块',
  '```',
  '',
  '最后一句带尾随空格。   ',
  '',
].join('\n');

test('native approved-plan output becomes the plan card with its stable id', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-plan-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '11', '18');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  const providerSessionId = 'codex-plan-history-1';
  try {
    await writeFile(path.join(sessionsDir, `rollout-${providerSessionId}.jsonl`), `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'read_file', call_id: 'call-ordinary-1', arguments: '{"path":"README.md"}' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-ordinary-1', name: 'read_file', output: 'plain tool output' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          id: 'fco_01a1ecf1-a96c-7273-86e3-ca97f1f1e2ba',
          name: 'proposed_plan',
          namespace: 'agent',
          output: PLAN_OUTPUT,
        },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-plan-history-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-plan-history-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-plan-history-1');
      const plans = history.messages.filter((message) => message.toolName === 'ExitPlanMode');
      assert.equal(plans.length, 1, 'the native plan output renders one plan card');
      const plan = plans[0];
      assert.equal(plan.toolId, 'fco_01a1ecf1-a96c-7273-86e3-ca97f1f1e2ba');
      assert.equal(JSON.parse(String(plan.toolInput)).plan, PLAN_OUTPUT, 'the markdown is kept verbatim');

      // A named result renders through its call, so the plan card owns the
      // completed pairing instead of leaving a separate orphan row.
      assert.deepEqual(plan.toolResult, { content: '', isError: false });
      assert.ok(!history.messages.some((message) => message.kind === 'tool_result'),
        'no orphan tool result with an empty call id');

      // An ordinary tool output keeps its own pairing and is never a plan card.
      const ordinary = history.messages.find((message) => message.kind === 'tool_use' && message.toolId === 'call-ordinary-1');
      assert.equal(ordinary?.toolName, 'read_file');
      assert.deepEqual(ordinary?.toolResult, { content: 'plain tool output', isError: false });
      assert.equal(plans.length, 1, 'the ordinary output is not a plan card');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
