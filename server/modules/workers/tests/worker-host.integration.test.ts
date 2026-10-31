import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';

import type {
  WorkerIpcTransport,
  WorkerNotification,
  WorkerOwner,
} from '@/shared/index.js';

import { createWorkerHostService } from '../worker-host.service.js';
import { WorkerIpcClient } from '../worker-ipc.client.js';
import { createWorkerMcpRouter } from '../worker-mcp.routes.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const pluginRoot = path.join(repositoryRoot, 'plugins/worker');
const builtEntry = path.join(pluginRoot, 'dist/server.mjs');

/** Rebuilds the bundled Worker entry when its sources are newer than the output. */
function ensureBuiltEntry(): void {
  const sources = [
    'server/entry.ts',
    'server/service.ts',
    'server/mcp.ts',
    'server/store.ts',
    'server/native.ts',
    'server/guardian.ts',
    'server/worktree.ts',
    'server/logs.ts',
    'shared/contracts.ts',
  ];
  const newest = Math.max(
    ...sources.map((source) => fs.statSync(path.join(pluginRoot, source)).mtimeMs),
  );
  const built = fs.existsSync(builtEntry) ? fs.statSync(builtEntry).mtimeMs : 0;
  if (built >= newest) return;
  const result = spawnSync(process.execPath, ['scripts/build-builtin-plugins.mjs'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
  assert.equal(result.status, 0, 'the bundled Worker entry failed to build');
}

function childTransport(child: ReturnType<typeof spawn>): WorkerIpcTransport {
  let running = true;
  child.once('exit', () => { running = false; });
  return {
    isRunning: () => running,
    ensureReady: async () => true,
    send: (message) => {
      if (!child.connected) return false;
      child.send(message);
      return true;
    },
    onMessage: (listener) => {
      child.on('message', listener as (message: unknown) => void);
      return () => child.off('message', listener as (message: unknown) => void);
    },
    onExit: (listener) => {
      child.on('exit', listener);
      return () => child.off('exit', listener);
    },
    onReady: () => () => {},
  };
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function toolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  const text = content?.find((item) => item.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * End-to-end Worker path: built plugin entry subprocess, real child-process IPC,
 * host service, host MCP proxy, SDK MCP client and fixture CLI. No model or
 * user configuration is touched.
 */
for (const provider of ['codex', 'dsh'] as const) {
test(`worker entry, host IPC and MCP proxy deliver and hold real results for ${provider} parents`, { timeout: 90_000 }, async (t) => {
  ensureBuiltEntry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-e2e-'));
  const project = path.join(root, 'project');
  const data = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  for (const [name, fixture] of [
    ['dsh', path.join(pluginRoot, 'tests/fixtures/fake-dsh.mjs')],
    ['pi', path.join(pluginRoot, 'tests/fixtures/fake-pi.mjs')],
  ] as const) {
    const wrapper = path.join(bin, name);
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, { mode: 0o755 });
  }

  const child = spawn(process.execPath, [builtEntry], {
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: path.join(root, 'home'),
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      DSH_HOME: path.join(root, 'dsh-home'),
      PI_CODING_AGENT_DIR: path.join(root, 'pi-home'),
      TEST_SCENARIO: 'sleep',
      TEST_DELAY_MS: '2500',
      CLOUDCLI_PLUGIN_TOKEN: 'plugin-ui-token',
      CLOUDCLI_PLUGIN_DATA_DIR: data,
      CLOUDCLI_HOST_ROOT: pluginRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  t.after(() => {
    try { process.kill(child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ready = await new Promise<number>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('Worker entry did not become ready')), 20_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      for (const line of stdout.split('\n')) {
        if (!line.includes('"ready":true')) continue;
        clearTimeout(timer);
        resolve((JSON.parse(line) as { port: number }).port);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`Worker entry exited early: ${stderr}`));
    });
  });

  const ipc = new WorkerIpcClient(childTransport(child), 20_000);
  const owner: WorkerOwner = {
    id: 'instance-1:session-1',
    parentSessionId: 'session-1',
    projectId: 'project-1',
    projectPath: project,
    userId: 7,
    appServerInstanceId: 'instance-1',
    paused: false,
  };
  const sessions = new Map([
    ['session-1', { project_path: project, provider }],
  ]);
  const wakeCalls: Record<string, unknown>[] = [];
  let parentBusy = true;
  let proxyPort = 0;
  const host = createWorkerHostService({
    ipc,
    isEnabled: () => true,
    resolveMcpUrl: () => `http://127.0.0.1:${proxyPort}/api/worker-mcp`,
    runtime: {
      isQueueBlocked: () => false,
      hasBackgroundWork: () => false,
      getState: () => ({ runtime: provider === 'dsh' ? 'acp' : 'app-server', phase: 'idle', queueHeld: false }),
    },
    hasActiveRun: () => parentBusy,
    sessions: { getSessionById: (sessionId) => sessions.get(sessionId) ?? null },
    projects: {
      getProjectPath: (candidate) =>
        path.resolve(candidate) === path.resolve(project) ? { project_id: 'project-1' } : null,
    },
    drafts: { hasQueuedMessages: () => false },
    settings: { get: () => ({ queueHeld: false }) },
    runTurn: async (input) => {
      wakeCalls.push(input as unknown as Record<string, unknown>);
      return { started: true, error: null };
    },
    log: () => {},
  });
  host.initialize();

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/worker-mcp', createWorkerMcpRouter({
    host,
    isEnabled: () => true,
    getPort: () => ready,
  }));
  const proxy = http.createServer(app);
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  proxyPort = address.port;
  t.after(() => new Promise<void>((resolve) => {
    proxy.closeAllConnections();
    proxy.close(() => resolve());
  }));

  const config = provider === 'dsh' ? null : await host.bridge.prepareSession({
    sessionId: 'session-1',
    projectPath: project,
    userId: 7,
    appServerInstanceId: 'instance-1',
  });
  const codexMcp = config ? (config as {
    'mcp_servers.cloudcli_workers': { url: string; http_headers: { Authorization: string } };
  })['mcp_servers.cloudcli_workers'] : null;
  const dshInput = { sessionId: 'session-1', projectPath: project, userId: 7, runtimeInstanceId: 'instance-1' };
  const dshMcp = provider === 'dsh' ? await host.dshBridge.prepareSession(dshInput) : null;
  const mcp = codexMcp ?? { url: dshMcp!.url, http_headers: { Authorization: dshMcp!.headers.Authorization } };
  const lifecycle = provider === 'dsh' ? host.dshBridge : host.bridge;
  assert.equal(mcp.url, `http://127.0.0.1:${proxyPort}/api/worker-mcp`);
  assert.match(mcp.http_headers.Authorization, /^Bearer /);

  const client = new Client({ name: 'worker-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers: { authorization: mcp.http_headers.Authorization } },
  });
  await client.connect(transport);
  t.after(async () => { await client.close(); });

  const started = toolResult(await client.callTool({
    name: 'worker_start',
    arguments: {
      taskName: 'e2e dsh',
      type: 'dsh',
      prompt: 'fixture e2e',
      workspace: { mode: 'existing' },
      writePaths: [],
      requestId: 'e2e-dsh-1',
    },
  })) as { worker: { id: string }; run: { id: string } };
  const waited = toolResult(await client.callTool({
    name: 'worker_wait',
    arguments: { workerId: started.worker.id, timeoutSeconds: 20 },
  })) as { run: { status: string }; notifications: WorkerNotification[] };
  assert.equal(waited.run.status, 'completed');
  assert.equal(waited.notifications.length, 1);
  const firstNotification = waited.notifications[0]!;
  if (provider === 'dsh') {
    assert.deepEqual(await host.dshBridge.prepareSession(dshInput), dshMcp, 'ACP recycling preserves the authenticated owner');
    const context = toolResult(await client.callTool({ name: 'worker_context', arguments: {} })) as { owner: WorkerOwner };
    assert.equal(context.owner.parentSessionId, 'session-1', 'the original MCP token remains valid after ACP recycling');
  }

  // The real SQLite outbox keeps the result pending while the parent is busy.
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(wakeCalls.length, 0);
  let state = await (await fetch(`http://127.0.0.1:${ready}/state`, {
    headers: { authorization: 'Bearer plugin-ui-token' },
  })).json() as { notifications: WorkerNotification[] };
  assert.equal(state.notifications.find((item) => item.id === firstNotification.id)?.delivery, 'pending');

  parentBusy = false;
  await waitFor(() => wakeCalls.length, (count) => count === 1, 8_000);
  const firstWake = wakeCalls[0]!;
  const firstSource = firstWake.workerSource as { batchId: string; results: Array<Record<string, string>> };
  assert.match(String(firstWake.content), new RegExp(`Worker: ${started.worker.id}`));
  assert.match(String(firstWake.content), new RegExp(`Run: ${started.run.id}`));
  assert.match(String(firstWake.content), /Status: completed/);
  assert.match(String(firstWake.content), new RegExp(`batch ${firstSource.batchId}`));

  const acked = toolResult(await client.callTool({
    name: 'worker_ack',
    arguments: { eventIds: [firstNotification.id] },
  })) as { acknowledged: number };
  assert.equal(acked.acknowledged, 1);
  state = await (await fetch(`http://127.0.0.1:${ready}/state`, {
    headers: { authorization: 'Bearer plugin-ui-token' },
  })).json() as { notifications: WorkerNotification[] };
  assert.equal(state.notifications.find((item) => item.id === firstNotification.id)?.delivery, 'delivered');

  // An explicit Stop pauses the live owner and cancels the active Pi run.
  const stoppedWorker = toolResult(await client.callTool({
    name: 'worker_start',
    arguments: {
      taskName: 'e2e pi',
      type: 'pi',
      prompt: 'fixture pi e2e',
      workspace: { mode: 'existing' },
      writePaths: [],
      requestId: 'e2e-pi-1',
    },
  })) as { worker: { id: string }; run: { id: string } };
  await waitFor(async () => {
    const current = await (await fetch(`http://127.0.0.1:${ready}/state`, {
      headers: { authorization: 'Bearer plugin-ui-token' },
    })).json() as { workers: Array<{ id: string; latestRun: { status: string } | null }> };
    return current.workers.find((item) => item.id === stoppedWorker.worker.id)?.latestRun?.status;
  }, (status) => status === 'running', 10_000);
  assert.equal(await lifecycle.stopSession('session-1', 'user-stop'), true);
  const pausedStart = await client.callTool({
    name: 'worker_start',
    arguments: {
      taskName: 'blocked while paused',
      type: 'pi',
      prompt: 'must not run',
      workspace: { mode: 'existing' },
      writePaths: [],
      requestId: 'e2e-pi-paused',
    },
  });
  assert.equal(pausedStart.isError, true);
  await waitFor(async () => {
    const current = await (await fetch(`http://127.0.0.1:${ready}/state`, {
      headers: { authorization: 'Bearer plugin-ui-token' },
    })).json() as { notifications: WorkerNotification[] };
    return current.notifications.find((item) => item.workerId === stoppedWorker.worker.id);
  }, (notification) => notification?.delivery === 'held', 10_000);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(wakeCalls.length, 1);

  // Manual retry is the only path from held to a new automatic delivery.
  await lifecycle.activateSession('session-1');
  state = await (await fetch(`http://127.0.0.1:${ready}/state`, {
    headers: { authorization: 'Bearer plugin-ui-token' },
  })).json() as { notifications: WorkerNotification[] };
  const stoppedNotification = state.notifications
    .find((item) => item.workerId === stoppedWorker.worker.id)!;
  assert.equal(stoppedNotification.delivery, 'held');
  const retried = await fetch(`http://127.0.0.1:${ready}/notifications/retry`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer plugin-ui-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ eventIds: [stoppedNotification.id] }),
  });
  assert.equal(retried.status, 200);
  await waitFor(() => wakeCalls.length, (count) => count === 2, 8_000);
  assert.match(String(wakeCalls[1]!.content), new RegExp(`Worker: ${stoppedWorker.worker.id}`));
  assert.match(String(wakeCalls[1]!.content), /Status: cancelled/);

  await host.shutdown();
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
});
}
