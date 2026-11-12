import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  residentBindingsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { createStageLogMcpService } from '../stage-log-mcp.service.js';
import { createStageLogService } from '../stage-log.service.js';

const SESSION = 'stage-log-session';
const TASK = 'task-logs';

async function withDatabase(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-logs-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  try {
    await initializeDatabase();
    sessionsDb.createAppSession(SESSION, 'codex', root, 'Logs');
    sessionsDb.assignProviderSessionId(SESSION, 'native-logs');
    await run(root);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function bind(status: 'running' | 'stopped' = 'running') {
  residentBindingsDb.insert({
    taskId: TASK,
    sessionId: SESSION,
    projectId: '',
    name: 'Logs',
    provider: 'codex',
    providerSessionId: 'native-logs',
    enabled: true,
    visible: true,
    status,
    executionId: 'exec-1',
    stopCause: null,
    terminal: null,
    permissionMode: null,
    sandboxMode: null,
    model: null,
    effort: null,
    runtime: 'app-server',
  });
}

test('an unbound session writes nothing and reports not_resident; a later binding is recognized', async () => {
  await withDatabase(async () => {
    const logs = createStageLogService();
    assert.deepEqual(logs.recordAgent(SESSION, { content: 'before binding', status: 'running' }), {
      recorded: false,
      reason: 'not_resident',
    });
    // No task exists yet, so there is nothing to list and nothing was written.
    assert.throws(
      () => logs.list({ taskId: TASK }),
      (error: unknown) => error instanceof AppError && error.code === 'not_found',
    );

    bind();
    const recorded = logs.recordAgent(SESSION, {
      content: 'deployed',
      status: 'success',
      phase: 'deploy',
      data: { region: 'eu' },
    });
    assert.equal(recorded.recorded, true);
    if (!recorded.recorded) return;
    // Identity, execution and source are derived; createdAt is the server's.
    assert.equal(recorded.log.taskId, TASK);
    assert.equal(recorded.log.sessionId, SESSION);
    assert.equal(recorded.log.executionId, 'exec-1');
    assert.equal(recorded.log.source, 'agent');
    assert.equal(recorded.log.phase, 'deploy');
    assert.deepEqual(recorded.log.data, { region: 'eu' });
    assert.ok(recorded.log.createdAt);
    assert.equal(logs.list({ taskId: TASK }).logs[0].id, recorded.log.id);
  });
});

test('occurredAt defaults only when omitted; an invalid value is rejected at the boundary', async () => {
  await withDatabase(async () => {
    bind();
    const logs = createStageLogService();
    const byDefault = logs.recordAgent(SESSION, { content: 'now', status: 'ok' });
    assert.equal(byDefault.recorded, true);
    if (!byDefault.recorded) return;
    assert.ok(Math.abs(Date.parse(byDefault.log.occurredAt) - Date.now()) < 5_000);

    const reported = logs.recordAgent(SESSION, {
      content: 'explicit',
      status: 'ok',
      occurredAt: '2026-01-02T03:04:05+02:00',
    });
    assert.equal(reported.recorded, true);
    if (!reported.recorded) return;
    assert.equal(reported.log.occurredAt, '2026-01-02T01:04:05.000Z');

    for (const invalid of ['not-a-date', '1', '2026-13-99T00:00:00Z']) {
      assert.throws(
        () => logs.recordAgent(SESSION, { content: 'bad time', status: 'ok', occurredAt: invalid }),
        (error: unknown) => error instanceof AppError && error.code === 'invalid_request',
      );
    }
    // The rejected call wrote no row: only the two valid entries exist.
    assert.equal(logs.list({ taskId: TASK }).logs.length, 2);
  });
});

test('paging is newest-first with an opaque cursor and bounded limit; expired rows disappear and prune', async () => {
  await withDatabase(async () => {
    bind();
    let clock = Date.parse('2026-05-01T00:00:00Z');
    const logs = createStageLogService({ now: () => clock });
    for (let index = 0; index < 6; index += 1) {
      clock += 1_000;
      logs.recordAgent(SESSION, { content: `node ${index}`, status: 'ok' });
    }
    const page = logs.list({ taskId: TASK, limit: 2 });
    assert.deepEqual(page.logs.map((entry) => entry.content), ['node 5', 'node 4']);
    assert.ok(page.nextCursor);
    const next = logs.list({ taskId: TASK, limit: 2, cursor: page.nextCursor! });
    assert.deepEqual(next.logs.map((entry) => entry.content), ['node 3', 'node 2']);
    assert.throws(
      () => logs.list({ taskId: TASK, cursor: 'not-a-cursor' }),
      (error: unknown) => error instanceof AppError && error.code === 'invalid_request',
    );
    assert.throws(
      () => logs.list({ taskId: 'missing-task' }),
      (error: unknown) => error instanceof AppError && error.code === 'not_found',
    );

    // Seven days pass: reads exclude everything and prune removes it.
    clock += 8 * 86_400_000;
    assert.deepEqual(logs.list({ taskId: TASK }).logs, []);
    assert.equal(logs.pruneExpired(), 6);
  });
});

test('system entries and repeated reads do not create duplicate logs', async () => {
  await withDatabase(async () => {
    bind();
    const logs = createStageLogService();
    const entry = logs.recordSystem({ sessionId: SESSION, content: '已设为常驻任务', status: 'adopted', phase: 'adopt' });
    assert.equal(entry?.source, 'system');
    // Plugin sync/poll style reads must not write anything.
    logs.list({ taskId: TASK });
    logs.list({ taskId: TASK });
    assert.equal(logs.list({ taskId: TASK }).logs.length, 1);
    // Unbound system entries are ignored, not queued.
    assert.equal(logs.recordSystem({ sessionId: 'unbound', content: 'x', status: 'y' }), null);
  });
});

test('MCP tokens bind the real session/provider/project and are reused per runtime instance', async () => {
  await withDatabase(async (root) => {
    bind();
    const logs = createStageLogService();
    let enabled = true;
    const mcp = createStageLogMcpService({
      logs,
      resolveMcpUrl: () => 'http://127.0.0.1:9/api/scheduler-mcp',
      isEnabled: () => enabled,
    });
    const prepared = await mcp.prepareSession({
      sessionId: SESSION,
      projectPath: root,
      provider: 'codex',
      userId: 7,
      runtimeInstanceId: 'runtime-1',
    });
    assert.ok(prepared);
    const repeated = await mcp.prepareSession({
      sessionId: SESSION,
      projectPath: root,
      provider: 'codex',
      userId: 7,
      runtimeInstanceId: 'runtime-1',
    });
    assert.deepEqual(repeated, prepared);
    const owner = mcp.authorize(prepared!.headers.Authorization);
    assert.equal(owner?.sessionId, SESSION);

    // Wrong provider/project/session is refused, so a token cannot claim another target.
    assert.equal(await mcp.prepareSession({ sessionId: SESSION, projectPath: root, provider: 'dsh' }), null);
    assert.equal(await mcp.prepareSession({ sessionId: 'other', projectPath: root, provider: 'codex' }), null);
    assert.equal(mcp.authorize('Bearer nope'), null);

    // The plugin switch is the gate: an issued token cannot write while it is off.
    enabled = false;
    assert.equal(mcp.authorize(prepared!.headers.Authorization), null);
    assert.equal(await mcp.prepareSession({ sessionId: SESSION, projectPath: root, provider: 'codex' }), null);
  });
});

test('a real MCP client lists the default rules, records only after adoption, and cannot forge identity', async () => {
  await withDatabase(async (root) => {
    // A second resident task exists to prove a forged taskId cannot redirect a write.
    sessionsDb.createAppSession('other-log-session', 'codex', root, 'Other logs');
    residentBindingsDb.insert({
      taskId: 'other-task',
      sessionId: 'other-log-session',
      projectId: '',
      name: 'Other',
      provider: 'codex',
      providerSessionId: 'native-other',
      enabled: true,
      visible: true,
      status: 'stopped',
      executionId: 'exec-other',
      stopCause: null,
      terminal: null,
      permissionMode: null,
      sandboxMode: null,
      model: null,
      effort: null,
      runtime: 'app-server',
    });

    const logs = createStageLogService();
    let enabled = true;
    const mcp = createStageLogMcpService({
      logs,
      resolveMcpUrl: () => 'http://127.0.0.1/api/scheduler-mcp',
      isEnabled: () => enabled,
    });
    const { createStageLogMcpRouter } = await import('../stage-log-mcp.routes.js');
    const express = (await import('express')).default;
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

    const app = express();
    app.use(express.json());
    app.use('/api/scheduler-mcp', createStageLogMcpRouter({
      service: mcp,
      isEnabled: () => enabled,
      isReady: () => true,
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === 'string' ? 0 : address!.port}/api/scheduler-mcp`;
    const prepared = await mcp.prepareSession({
      sessionId: SESSION,
      projectPath: root,
      provider: 'codex',
      runtimeInstanceId: 'mcp-protocol-runtime',
    });
    assert.ok(prepared);
    const bearer = prepared!.headers.Authorization;
    const client = new Client({ name: 'stage-log-test', version: '1.0.0' });
    try {
      // Unauthenticated HTTP is refused before any MCP exchange.
      const unauthorized = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(unauthorized.status, 401);

      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: bearer } },
      });
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), ['stage_log']);
      const description = tools.tools[0]?.description ?? '';
      assert.match(description, /not_resident/);
      assert.match(description, /阶段/);

      const call = async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: 'stage_log', arguments: args }) as {
          content: Array<{ text: string }>;
        };
        return JSON.parse(result.content[0].text) as Record<string, unknown>;
      };

      // Ordinary foreground chat before adoption: no write, no retry.
      assert.deepEqual(await call({ content: 'before adopt', status: 'ok' }), {
        recorded: false,
        reason: 'not_resident',
      });
      assert.equal(logs.list({ taskId: 'other-task' }).logs.length, 0);

      // The same token keeps working after a real binding exists.
      bind();
      const first = await call({
        content: '节点 A',
        status: 'success',
        phase: 'deploy',
        data: { attempt: 1 },
      }) as { recorded: boolean; log: Record<string, unknown> };
      assert.equal(first.recorded, true);
      assert.equal(first.log.taskId, TASK);
      assert.equal(first.log.sessionId, SESSION);
      assert.equal(first.log.executionId, 'exec-1');
      assert.equal(first.log.source, 'agent');
      assert.equal(first.log.content, '节点 A');
      assert.equal(first.log.status, 'success');
      assert.deepEqual(first.log.data, { attempt: 1 });
      assert.equal(first.log.occurredAt, first.log.createdAt);

      const second = await call({ content: '节点 B', status: 'failed' }) as {
        recorded: boolean; log: Record<string, unknown>;
      };
      assert.equal(second.recorded, true);
      assert.notEqual(second.log.id, first.log.id);
      const page = logs.list({ taskId: TASK });
      assert.deepEqual(page.logs.map((entry) => entry.content), ['节点 B', '节点 A']);

      // Extra identity-looking keys are stripped: the write still targets the token's binding.
      const forged = await call({
        content: '伪造目标',
        status: 'ok',
        taskId: 'other-task',
        sessionId: 'other-log-session',
        source: 'system',
        executionId: 'exec-other',
      }) as { recorded: boolean; log: Record<string, unknown> };
      assert.equal(forged.recorded, true);
      assert.equal(forged.log.taskId, TASK);
      assert.equal(forged.log.sessionId, SESSION);
      assert.equal(forged.log.executionId, 'exec-1');
      assert.equal(forged.log.source, 'agent');
      assert.equal(logs.list({ taskId: 'other-task' }).logs.length, 0);

      // The plugin switch is the gate: the issued token cannot write while it is off.
      enabled = false;
      await assert.rejects(call({ content: 'gate off', status: 'ok' }));
      assert.equal(logs.list({ taskId: TASK }).logs.length, 3);
    } finally {
      await client.close().catch(() => undefined);
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
