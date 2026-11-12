import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  closeConnection,
  initializeDatabase,
  residentBindingsDb,
  stageLogsDb,
  sessionRuntimeDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { createProjectSchedulerModule } from '@/modules/project-scheduler/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type {
  ProviderRuntimeGateway,
  ResidentBindingView,
  StageLogEntry,
  StageLogPage,
} from '@/shared/index.js';

import {
  ResidentHost,
  type ResidentHostTransport,
} from '../../../../plugins/project-scheduler/server/resident-ipc.js';

/**
 * Cross-module acceptance for stage logs.
 *
 * These exercise the real composition root (`createProjectSchedulerModule`) over the real
 * database, registry, MCP HTTP route, plugin IPC action and plugin switch. The only fake pieces are
 * the provider process behind the runtime gateway (no model is ever started) and the scripted
 * in-process transport behind the plugin's real `ResidentHost` client, so the IPC envelope,
 * correlation id and host action are exercised without booting the whole scheduler plugin.
 *
 * Detailed log-service behavior (validation, cursor encoding, token reuse, tool schema) is covered
 * by `stage-logs.test.ts`; this file intentionally proves the wiring between modules instead.
 */

const SESSION = 'stage-logs-acceptance-session';
const TASK = 'task-logs-acceptance';
/** Keeps every row visible when a test needs to inspect physical storage, bypassing retention. */
const ALL_TIME = '1970-01-01T00:00:00.000Z';

async function withDatabase(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-logs-acceptance-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  chatRunRegistry.clearAll();
  await initializeDatabase();
  try {
    await run(root);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function seedCodexSession(root: string): void {
  sessionsDb.createAppSession(SESSION, 'codex', root, 'Resident logs acceptance');
  sessionsDb.assignProviderSessionId(SESSION, 'native-stage-logs');
  sessionRuntimeDb.update(SESSION, { runtime: 'app-server', queueHeld: false });
}

/** The provider seam only; every run is admitted through the real chat-run registry. */
function createRuntime(): ProviderRuntimeGateway {
  return {
    hasRuntime: () => true,
    abort: async () => true,
    getState: () => undefined,
    getManagedState: () => undefined,
    hasBackgroundWork: () => false,
    isQueueBlocked: () => false,
  } as unknown as ProviderRuntimeGateway;
}

/** Admits a real foreground app-session run exactly as `dispatchRun` does synchronously. */
function admitRun() {
  const run = chatRunRegistry.startRun({
    appSessionId: SESSION,
    provider: 'codex',
    providerSessionId: 'native-stage-logs',
    connection: null,
    userId: null,
    dispatch: {
      origin: 'foreground',
      permissionMode: 'acceptEdits',
      sandboxMode: 'workspace-write',
      model: 'gpt-5',
      effort: 'high',
      runtimeMode: 'app-server',
    },
  });
  assert.ok(run, 'the registry admits the run');
  return run;
}

function storedLogs(taskId = TASK): StageLogEntry[] {
  return stageLogsDb.listPage({ taskId, keepFrom: ALL_TIME, limit: 100 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads one page through the plugin's real IPC client (`ResidentHost`) over a scripted in-process
 * transport. The server half dispatches the genuine `logs` action through the host service, so the
 * request envelope, correlation id and response shape are exercised without booting a plugin
 * process. This mirrors the plugin's `ResidentTasks.logs`, which sends exactly this request.
 */
async function readLogsOverPluginIpc(
  host: ReturnType<typeof createProjectSchedulerModule>['host'],
  payload: { taskId: string; limit?: number },
): Promise<StageLogPage> {
  let listener: ((message: unknown) => void) | null = null;
  const transport: ResidentHostTransport = {
    send(message) {
      void host.handleRequest(message.action, message.payload as Record<string, unknown>)
        .then((value) => listener?.({
          channel: 'cloudcli-scheduler-resident',
          id: message.id,
          kind: 'response',
          ok: true,
          value,
        }))
        .catch((error: unknown) => listener?.({
          channel: 'cloudcli-scheduler-resident',
          id: message.id,
          kind: 'response',
          ok: false,
          error: {
            code: 'invalid_request',
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      return true;
    },
    subscribe(next) {
      listener = next;
      return () => { listener = null; };
    },
  };
  const client = new ResidentHost(transport, 2000);
  try {
    return await client.request('logs', payload);
  } finally {
    client.close();
  }
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * The external agent path end to end: a token is issued while the foreground session is ordinary,
 * the MCP HTTP route refuses to log before adoption, a real host adoption enables the same token,
 * and the plugin IPC channel reads exactly what was written without touching the run.
 */
test('an ordinary session token logs nothing until a real adoption, then the plugin IPC reads the page', async () => {
  await withDatabase(async (root) => {
    seedCodexSession(root);
    let pluginEnabled = true;
    const runtime = createRuntime();

    const app = express();
    app.use(express.json());
    const httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => httpServer.once('listening', () => resolve()));
    const address = httpServer.address();
    const port = typeof address === 'string' ? 0 : address?.port ?? 0;
    assert.ok(port > 0, 'the test MCP endpoint is listening');
    const mcpUrl = `http://127.0.0.1:${port}/api/scheduler-mcp`;

    const scheduler = createProjectSchedulerModule({
      runtime,
      mcpUrl,
      // The gate is the plugin switch, not a running plugin process.
      isPluginEnabled: () => pluginEnabled,
    });
    app.use('/api/scheduler-mcp', scheduler.mcpRouter);
    scheduler.initialize();

    let client: { close(): Promise<void> } | null = null;
    try {
      const run = admitRun();
      const prepared = await scheduler.logBridge.prepareSession({
        sessionId: SESSION,
        projectPath: root,
        provider: 'codex',
        runtimeInstanceId: 'acceptance-runtime',
      });
      assert.ok(prepared, 'the bridge issues a temporary MCP token for an ordinary session');
      assert.equal(prepared.url, mcpUrl);

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      const mcpClient = new Client({ name: 'stage-logs-acceptance', version: '1.0.0' });
      client = mcpClient;
      const transport = new StreamableHTTPClientTransport(new URL(prepared.url), {
        requestInit: { headers: { authorization: prepared.headers.Authorization } },
      });
      await mcpClient.connect(transport);

      const callTool = async <T>(args: Record<string, unknown>): Promise<T> => {
        const result = await mcpClient.callTool({
          name: 'stage_log',
          arguments: args,
        }) as { content: Array<{ type: string; text?: string }> };
        const block = result.content[0];
        assert.equal(block?.type, 'text');
        return JSON.parse(block?.text ?? '{}') as T;
      };

      // Ordinary foreground chat: the tool answers, writes nothing and never retries.
      assert.deepEqual(
        await callTool({ content: 'before adoption', status: 'running' }),
        { recorded: false, reason: 'not_resident' },
      );
      assert.deepEqual(storedLogs(), []);

      // Real adoption through the host service (not a direct binding insert).
      const adopted = await scheduler.host.handleRequest('adopt', {
        taskId: TASK,
        sessionId: SESSION,
      }) as { binding: ResidentBindingView };
      assert.equal(adopted.binding.status, 'running');
      assert.equal(adopted.binding.executionId, run.executionId);
      const adoptionEntries = storedLogs();
      assert.equal(adoptionEntries.length, 1);
      assert.equal(adoptionEntries[0]?.source, 'system');
      assert.equal(adoptionEntries[0]?.phase, 'adopt');
      assert.equal(adoptionEntries[0]?.status, 'adopted');
      assert.equal(adoptionEntries[0]?.executionId, run.executionId);

      // The token issued before adoption keeps working and is bound to the real identity.
      const written = await callTool<{ recorded: boolean; log: StageLogEntry }>({
        content: '部署失败：凭据已过期',
        status: 'failed',
        phase: 'deploy',
        data: { attempt: 2, retriesLeft: 0, detail: { region: 'eu', exitCode: 1 } },
        // Identity-looking keys are not part of the schema; the host owns them.
        taskId: 'forged-task',
        sessionId: 'forged-session',
        executionId: 'forged-execution',
        source: 'system',
      });
      assert.equal(written.recorded, true);
      assert.equal(written.log.taskId, TASK);
      assert.equal(written.log.sessionId, SESSION);
      assert.equal(written.log.executionId, run.executionId);
      assert.equal(written.log.source, 'agent');
      assert.equal(written.log.status, 'failed');
      assert.equal(written.log.phase, 'deploy');
      assert.deepEqual(written.log.data, {
        attempt: 2,
        retriesLeft: 0,
        detail: { region: 'eu', exitCode: 1 },
      });
      assert.equal(written.log.occurredAt, written.log.createdAt);

      // The plugin's own read action, over the real host↔plugin IPC channel.
      const page = await readLogsOverPluginIpc(scheduler.host, { taskId: TASK });
      assert.equal(page.nextCursor, null);
      assert.equal(page.logs.length, 2);
      const agentEntry = page.logs.find((entry) => entry.id === written.log.id);
      assert.ok(agentEntry);
      assert.equal(agentEntry?.source, 'agent');
      assert.deepEqual(agentEntry?.data, written.log.data);
      assert.equal(page.logs.some((entry) => entry.source === 'system'), true);

      // Writing a stage log is not a run transition: still running, same execution, no terminal.
      const row = residentBindingsDb.getByTaskId(TASK);
      assert.equal(row?.status, 'running');
      assert.equal(row?.executionId, run.executionId);
      assert.equal(row?.stopCause, null);
      assert.equal(row?.terminal, null);
      assert.equal(chatRunRegistry.isProcessing(SESSION), true);
      const status = await scheduler.host.handleRequest('status', { taskId: TASK }) as {
        bindings: ResidentBindingView[];
      };
      assert.equal(status.bindings[0]?.status, 'running');
      assert.equal(status.bindings[0]?.executionId, run.executionId);
      assert.equal(status.bindings[0]?.terminal, null);
      assert.equal(storedLogs().length, 2, 'status reads never write');

      // Plugin switch off: the route is unavailable even with no plugin process and no restart.
      pluginEnabled = false;
      const disabled = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: prepared.headers.Authorization,
        },
        body: JSON.stringify({}),
      });
      assert.equal(disabled.status, 503);
      assert.equal(storedLogs().length, 2);
      pluginEnabled = true;
    } finally {
      if (client) await client.close().catch(() => undefined);
      await scheduler.shutdown();
      await closeHttpServer(httpServer);
    }
  });
});

/**
 * Host lifecycle entries must name the execution they actually belong to, and the reconciliation
 * traffic the plugin generates (status/list/snapshot sync) must never add a second copy.
 */
test('run-start and run-end system logs carry the real execution and reconciliation never duplicates them', async () => {
  await withDatabase(async (root) => {
    seedCodexSession(root);
    const scheduler = createProjectSchedulerModule({ runtime: createRuntime() });
    scheduler.initialize();
    try {
      const readLogs = async () => (await scheduler.host.handleRequest('logs', {
        taskId: TASK,
      })) as StageLogPage;

      // First real foreground run: adoption captures it, then it settles into one terminal log.
      const first = admitRun();
      const adopted = await scheduler.host.handleRequest('adopt', {
        taskId: TASK,
        sessionId: SESSION,
      }) as { binding: ResidentBindingView };
      assert.equal(adopted.binding.executionId, first.executionId);
      chatRunRegistry.completeRun(SESSION, { exitCode: 0 });
      scheduler.host.onSessionSettled(SESSION);

      const afterFirst = await readLogs();
      const firstTerminal = afterFirst.logs.find(
        (entry) => entry.phase === 'success' && entry.executionId === first.executionId,
      );
      assert.ok(firstTerminal, 'the terminal log belongs to the adopted execution');
      assert.equal(firstTerminal?.status, 'completed');
      assert.equal(firstTerminal?.phase, 'success');
      assert.equal(firstTerminal?.source, 'system');

      // Second real run on the same binding: one start log, one terminal log, same execution.
      const second = admitRun();
      assert.notEqual(second.executionId, first.executionId);
      const running = residentBindingsDb.getByTaskId(TASK);
      assert.equal(running?.status, 'running');
      assert.equal(running?.executionId, second.executionId);
      const afterStart = await readLogs();
      const startEntry = afterStart.logs.find(
        (entry) => entry.phase === 'run' && entry.executionId === second.executionId,
      );
      assert.ok(startEntry, 'the run-start log names the new execution');
      assert.equal(startEntry?.status, 'running');
      assert.equal(startEntry?.phase, 'run');

      chatRunRegistry.completeRun(SESSION, { exitCode: 0 });
      scheduler.host.onSessionSettled(SESSION);
      const settled = await readLogs();
      const startEntries = settled.logs.filter(
        (entry) => entry.phase === 'run' && entry.executionId === second.executionId,
      );
      const terminalEntries = settled.logs.filter(
        (entry) => entry.phase === 'success' && entry.executionId === second.executionId,
      );
      assert.equal(startEntries.length, 1);
      assert.equal(terminalEntries.length, 1);
      assert.equal(terminalEntries[0]?.status, 'completed');
      assert.equal(terminalEntries[0]?.phase, 'success');
      const count = settled.logs.length;

      // Reconciliation only: plugin status/list/sync payloads and a repeated initialize/store read.
      await scheduler.host.handleRequest('status', {});
      await scheduler.host.handleRequest('status', { taskId: TASK });
      // `snapshot()` is exactly the payload the IPC `sync` event pushes on plugin ready.
      assert.equal(scheduler.host.snapshot().bindings.length, 1);
      scheduler.initialize();
      await sleep(20);
      const reconciled = await readLogs();
      assert.equal(reconciled.logs.length, count);
      assert.equal(
        reconciled.logs.filter((entry) => entry.phase === 'run').length,
        startEntries.length,
      );
      assert.equal(reconciled.logs.filter((entry) => entry.phase === 'success').length, 2);
    } finally {
      await scheduler.shutdown();
    }
  });
});

/**
 * A host restart must not lose logs, and retention is anchored to the server-issued `createdAt`
 * (not the agent-reported `occurredAt`). The expired row is seeded directly so no product clock is
 * mocked or changed.
 */
test('logs persist across a module reopen and expire by server createdAt, not occurredAt', async () => {
  await withDatabase(async (root) => {
    seedCodexSession(root);
    const runtime = createRuntime();
    const first = createProjectSchedulerModule({ runtime });
    first.initialize();
    let firstOpen = true;
    let reopened: ReturnType<typeof createProjectSchedulerModule> | null = null;
    let reopenedOpen = false;
    try {
      admitRun();
      await first.host.handleRequest('adopt', { taskId: TASK, sessionId: SESSION });
      const original = await first.host.handleRequest('logs', {
        taskId: TASK,
      }) as StageLogPage;
      assert.equal(original.logs.length, 1);
      const adoptionLog = original.logs[0]!;
      assert.equal(adoptionLog.source, 'system');

      // Close the host module and read the same row from a fresh composition root.
      await first.shutdown();
      firstOpen = false;
      reopened = createProjectSchedulerModule({ runtime });
      reopenedOpen = true;
      const persisted = await reopened.host.handleRequest('logs', {
        taskId: TASK,
      }) as StageLogPage;
      assert.deepEqual(persisted.logs.map((entry) => entry.id), [adoptionLog.id]);
      assert.equal(persisted.logs[0]?.createdAt, adoptionLog.createdAt);
      assert.equal(persisted.logs[0]?.content, adoptionLog.content);

      const now = Date.now();
      const serverNow = new Date(now).toISOString();
      // Reported ten days ago but written now: still inside the seven-day creation window.
      stageLogsDb.insert({
        id: 'log-old-occurred-at',
        taskId: TASK,
        sessionId: SESSION,
        executionId: null,
        source: 'agent',
        occurredAt: new Date(now - 10 * 86_400_000).toISOString(),
        createdAt: serverNow,
        content: 'reported ten days ago, written now',
        status: 'ok',
      });
      // Created eight days ago: outside the window even though occurredAt is current.
      stageLogsDb.insert({
        id: 'log-old-created-at',
        taskId: TASK,
        sessionId: SESSION,
        executionId: null,
        source: 'agent',
        occurredAt: serverNow,
        createdAt: new Date(now - 8 * 86_400_000).toISOString(),
        content: 'written eight days ago',
        status: 'ok',
      });

      // Physically present before the startup prune runs.
      assert.equal(
        storedLogs().some((entry) => entry.id === 'log-old-created-at'),
        true,
      );
      const window = await reopened.host.handleRequest('logs', {
        taskId: TASK,
      }) as StageLogPage;
      const visibleIds = window.logs.map((entry) => entry.id);
      assert.equal(visibleIds.includes('log-old-occurred-at'), true);
      assert.equal(visibleIds.includes('log-old-created-at'), false);
      assert.equal(visibleIds.includes(adoptionLog.id), true);

      // Module startup prunes expired rows and keeps everything inside the window.
      reopened.initialize();
      await reopened.shutdown();
      reopenedOpen = false;
      const remaining = storedLogs().map((entry) => entry.id);
      assert.equal(remaining.includes('log-old-created-at'), false);
      assert.equal(remaining.includes('log-old-occurred-at'), true);
      assert.equal(remaining.includes(adoptionLog.id), true);
    } finally {
      if (reopenedOpen && reopened) await reopened.shutdown();
      if (firstOpen) await first.shutdown();
    }
  });
});
