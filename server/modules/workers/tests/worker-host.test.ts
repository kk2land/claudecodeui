import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkerNotification } from '@/shared/index.js';

import { createWorkerHostService } from '../worker-host.service.js';
import type { WorkerIpcClient } from '../worker-ipc.client.js';

type FakeRequest = { action: string; payload: Record<string, unknown> };

function notification(overrides: Partial<WorkerNotification> = {}): WorkerNotification {
  return {
    id: 'notification-1',
    ownerId: 'instance-1:session-1',
    workerId: 'worker-1',
    runId: 'run-1',
    summary: 'The worker finished its review.',
    status: 'completed',
    createdAt: '2026-10-30T00:00:00.000Z',
    delivery: 'pending',
    batchId: null,
    ...overrides,
  };
}

function harness(options: {
  sessions?: Record<string, string>;
  claim?: (ids: string[], outbox: Map<string, WorkerNotification>) => Promise<unknown>;
} = {}) {
  const outbox = new Map<string, WorkerNotification>();
  const requests: FakeRequest[] = [];
  const claims: string[][] = [];
  const settlements: Array<{ batchId: string; delivery: string }> = [];
  const events = new Set<(event: never) => void>();
  const ready = new Set<() => void>();
  const disconnects = new Set<() => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 1;
  const activeRuns = new Set<string>();
  const queueHeld = new Set<string>();
  const drafts = new Set<string>();
  const background = new Set<string>();
  const goals = new Set<string>();
  const blocked = new Set<string>();
  const phases = new Map<string, string>();
  const sessions = new Map<string, { project_path: string; provider: string; projectId: string }>();
  for (const [sessionId, projectPath] of Object.entries(options.sessions ?? { 'session-1': '/repo' })) {
    sessions.set(sessionId, { project_path: projectPath, provider: 'codex', projectId: `project-${projectPath.split('/').at(-1)}` });
  }
  const wakeCalls: Array<Record<string, unknown>> = [];
  const logs: Array<{ message: string; detail: unknown }> = [];
  let ensureReadyImpl: () => Promise<boolean> = async () => true;
  let ensureReadyCalls = 0;
  let failPause = false;
  let closeAllImpl: (() => Promise<unknown>) | null = null;
  let disposed = false;
  let runTurnImpl: (input: Record<string, unknown>) => Promise<{ started: boolean; error: string | null }> =
    async (input) => { wakeCalls.push(input); return { started: true, error: null }; };

  const ipc = {
    requests,
    running: true,
    async ensureReady() { ensureReadyCalls++; return await ensureReadyImpl(); },
    isRunning() { return this.running; },
    isReady() { return this.running; },
    async request(action: string, payload: Record<string, unknown>) {
      const request = { action, payload };
      requests.push(request);
      if (action === 'registerOwner') return payload.owner;
      if (action === 'listNotifications') return [...outbox.values()];
      if (action === 'setOwnerPaused') {
        if (failPause) throw new Error('pause not confirmed');
        return { confirmed: true };
      }
      if (action === 'claimNotifications') {
        const ids = payload.eventIds as string[];
        claims.push(ids);
        if (options.claim) return await options.claim(ids, outbox);
        return {
          batchId: String(payload.batchId),
          notifications: ids.map((id) => outbox.get(id)).filter((value): value is WorkerNotification => Boolean(value)),
        };
      }
      if (action === 'settleNotifications') {
        settlements.push({ batchId: String(payload.batchId), delivery: String(payload.delivery) });
        return { settled: true };
      }
      if (action === 'closeAll' && closeAllImpl) return await closeAllImpl();
      return { workerIds: [], confirmed: true, settled: true };
    },
    onEvent(listener: (event: never) => void) { events.add(listener); return () => events.delete(listener); },
    onReady(listener: () => void) { ready.add(listener); return () => ready.delete(listener); },
    onDisconnect(listener: () => void) { disconnects.add(listener); return () => disconnects.delete(listener); },
    dispose() { disposed = true; },
    emit(event: unknown) { for (const listener of events) listener(event as never); },
    emitReady() { for (const listener of ready) listener(); },
    emitDisconnect() { for (const listener of disconnects) listener(); },
  };

  const service = createWorkerHostService({
    ipc: ipc as unknown as WorkerIpcClient,
    isEnabled: () => true,
    resolveMcpUrl: () => 'http://127.0.0.1:3001/api/worker-mcp',
    runtime: {
      isQueueBlocked: (sessionId) => blocked.has(sessionId) || queueHeld.has(sessionId) || goals.has(sessionId),
      getState: (_provider, sessionId) => ({
        runtime: 'app-server', mode: 'default', phase: (phases.get(sessionId) ?? 'idle') as 'idle' | 'starting' | 'running' | 'stopping' | 'failed' | 'stopFailed', turnId: null,
        goal: goals.has(sessionId) ? { threadId: 'thread', objective: 'goal', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } : null,
        questions: [], queueHeld: queueHeld.has(sessionId),
      }),
      hasBackgroundWork: (sessionId) => background.has(sessionId),
    },
    hasActiveRun: (sessionId) => activeRuns.has(sessionId),
    sessions: { getSessionById: (sessionId) => sessions.get(sessionId) ?? null },
    projects: {
      getProjectPath: (projectPath) => {
        const session = [...sessions.values()].find((candidate) => candidate.project_path === projectPath);
        return session ? { project_id: session.projectId } : null;
      },
    },
    drafts: { hasQueuedMessages: (sessionId) => drafts.has(sessionId) },
    settings: { get: (sessionId) => ({ queueHeld: queueHeld.has(sessionId) }) },
    runTurn: (input) => runTurnImpl(input as unknown as Record<string, unknown>),
    setTimeout: ((callback: () => void, delay = 0) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return { unref() {}, id };
    }) as unknown as typeof setTimeout,
    clearTimeout: ((handle: { id?: number } | number) => {
      const id = typeof handle === 'number' ? handle : handle?.id;
      if (typeof id === 'number') timers.delete(id);
    }) as typeof clearTimeout,
    randomToken: () => 'owner-token',
    randomBatchId: () => 'batch-1',
    log: (message, detail) => { logs.push({ message, detail }); },
  });
  service.initialize();

  return {
    service, ipc, outbox, requests, claims, settlements, timers, wakeCalls, logs,
    setActiveRun(sessionId: string, value: boolean) { if (value) activeRuns.add(sessionId); else activeRuns.delete(sessionId); },
    setQueueHeld(sessionId: string, value: boolean) { if (value) queueHeld.add(sessionId); else queueHeld.delete(sessionId); },
    setDrafts(sessionId: string, value: boolean) { if (value) drafts.add(sessionId); else drafts.delete(sessionId); },
    setBackground(sessionId: string, value: boolean) { if (value) background.add(sessionId); else background.delete(sessionId); },
    setGoal(sessionId: string, value: boolean) { if (value) goals.add(sessionId); else goals.delete(sessionId); },
    setPhase(sessionId: string, value: string) { phases.set(sessionId, value); },
    setRunTurn(impl: (input: Record<string, unknown>) => Promise<{ started: boolean; error: string | null }>) { runTurnImpl = impl; },
    setEnsureReady(impl: () => Promise<boolean>) { ensureReadyImpl = impl; },
    ensureReadyCalls: () => ensureReadyCalls,
    setPauseFailure(value: boolean) { failPause = value; },
    setCloseAll(impl: () => Promise<unknown>) { closeAllImpl = impl; },
    disposed: () => disposed,
    async prepare(sessionId = 'session-1', appServerInstanceId = 'instance-1', registerOwnerOverride?: () => Promise<boolean>) {
      const session = sessions.get(sessionId)!;
      if (registerOwnerOverride) {
        const original = ipc.request;
        ipc.request = async (action: string, payload: Record<string, unknown>) => {
          if (action === 'registerOwner') {
            requests.push({ action, payload });
            return await registerOwnerOverride();
          }
          return await original(action, payload);
        };
      }
      return service.bridge.prepareSession({
        sessionId, projectPath: session.project_path, userId: 7, appServerInstanceId,
      });
    },
    emitNotification(value: WorkerNotification) {
      outbox.set(value.id, value);
      ipc.emit({ channel: 'cloudcli-workers', kind: 'event', event: 'notification', value });
    },
    activate(sessionId = 'session-1') {
      return service.bridge.activateSession(sessionId);
    },
    stop(sessionId = 'session-1', reason = 'user-stop') {
      return service.bridge.stopSession(sessionId, reason);
    },
    fireTimers() {
      const callbacks = [...timers.values()].sort((left, right) => left.delay - right.delay);
      timers.clear();
      for (const timer of callbacks) timer.callback();
    },
    fireDue(maxDelay: number) {
      const due = [...timers.entries()].filter(([, timer]) => timer.delay <= maxDelay).sort((left, right) => left[1].delay - right[1].delay);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },
    timerDelays() { return [...timers.values()].map((timer) => timer.delay); },
  };
}

async function tick(count = 20): Promise<void> {
  for (let index = 0; index < count; index++) await new Promise((resolve) => setImmediate(resolve));
}

test('prepareSession returns only the per-server MCP override and registers a verified owner', async () => {
  const h = harness();
  const config = await h.prepare();
  assert.deepEqual(config, {
    'mcp_servers.cloudcli_workers': {
      url: 'http://127.0.0.1:3001/api/worker-mcp',
      http_headers: { Authorization: 'Bearer owner-token' },
      enabled: true,
    },
  });
  const register = h.requests.find((request) => request.action === 'registerOwner');
  assert.ok(register);
  assert.equal(register.payload.token, 'owner-token');
  assert.equal((register.payload.owner as { projectId: string }).projectId, 'project-repo');
});

test('prepareSession refuses a project path the app session does not own', async () => {
  const h = harness();
  const config = await h.service.bridge.prepareSession({
    sessionId: 'session-1', projectPath: '/somewhere-else', userId: 7, appServerInstanceId: 'instance-1',
  });
  assert.equal(config, null);
  assert.equal(h.requests.length, 0);
});

test('busy parent is checked every window without claiming until it becomes idle', async () => {
  const h = harness();
  await h.prepare();
  h.setActiveRun('session-1', true);
  h.emitNotification(notification());
  for (let index = 0; index < 4; index++) {
    await tick();
    h.fireTimers();
    await tick();
  }
  assert.equal(h.claims.length, 0);
  assert.equal(h.wakeCalls.length, 0);
  assert.equal(h.outbox.get('notification-1')?.id, 'notification-1');

  h.setActiveRun('session-1', false);
  h.fireTimers();
  await tick();
  assert.equal(h.claims.length, 1);
  assert.deepEqual(h.claims[0], ['notification-1']);
  assert.equal(h.wakeCalls.length, 1);
  assert.deepEqual(h.wakeCalls[0].workerSource, {
    batchId: 'batch-1',
    results: [{ workerId: 'worker-1', runId: 'run-1', status: 'completed', summary: 'The worker finished its review.' }],
  });
  assert.equal((h.wakeCalls[0].workerSource as { results: unknown[] }).results.length, 1);
  assert.equal(h.settlements.at(-1)?.delivery, 'delivered');
});

for (const busy of ['drafts', 'background', 'goal', 'running'] as const) {
  test(`a ${busy} busy parent waits and eventually receives exactly one merged delivery`, async () => {
    const h = harness();
    await h.prepare();
    if (busy === 'drafts') h.setDrafts('session-1', true);
    if (busy === 'background') h.setBackground('session-1', true);
    if (busy === 'goal') h.setGoal('session-1', true);
    if (busy === 'running') h.setPhase('session-1', 'running');
    h.emitNotification(notification());
    for (let index = 0; index < 3; index++) {
      await tick();
      h.fireTimers();
      await tick();
    }
    assert.equal(h.claims.length, 0);
    if (busy === 'drafts') h.setDrafts('session-1', false);
    if (busy === 'background') h.setBackground('session-1', false);
    if (busy === 'goal') h.setGoal('session-1', false);
    if (busy === 'running') h.setPhase('session-1', 'idle');
    await tick();
    h.fireTimers();
    await tick();
    assert.equal(h.wakeCalls.length, 1);
    assert.equal(h.claims.length, 1);
  });
}

test('a busy race after claim releases the same batch to pending and retries unchanged ids', async () => {
  let releaseClaim!: (value: unknown) => void;
  const h = harness();
  h.setRunTurn(async (input) => { h.wakeCalls.push(input); return { started: true, error: null }; });
  await h.prepare();
  // Patch the IPC claim response only for the first attempt.
  let first = true;
  const original = h.ipc.request;
  h.ipc.request = async (action: string, payload: Record<string, unknown>) => {
    if (action === 'claimNotifications' && first) {
      first = false;
      return await new Promise((resolve) => { releaseClaim = resolve; });
    }
    return await original(action, payload);
  };
  h.emitNotification(notification());
  await tick();
  h.fireTimers();
  await tick();
  assert.ok(releaseClaim);
  h.setActiveRun('session-1', true);
  releaseClaim({ batchId: 'batch-1', notifications: [notification()] });
  await tick();
  assert.equal(h.settlements.at(-1)?.delivery, 'pending');
  assert.equal(h.wakeCalls.length, 0);

  h.setActiveRun('session-1', false);
  await tick();
  h.fireTimers();
  await tick();
  assert.deepEqual(h.claims.at(-1), ['notification-1']);
  assert.equal(h.wakeCalls.length, 1);
});

test('a user message queued after the Worker claim sends the same batch back to pending', async () => {
  const h = harness();
  await h.prepare();
  let guarded = false;
  let firstAttempt = true;
  h.setRunTurn(async (input) => {
    // The native runtime consults this immediately before turn/start. A user
    // message queued after the claim makes it false; the batch must simply
    // wait again, not become a failed delivery.
    if (firstAttempt) {
      firstAttempt = false;
      h.setDrafts('session-1', true);
      guarded = true;
    }
    return (input.finalGuard as () => boolean)()
      ? { started: true, error: null }
      : { started: false, error: 'User message has priority.' };
  });
  h.emitNotification(notification());
  await tick();
  h.fireTimers();
  await tick();

  assert.equal(guarded, true);
  assert.equal(h.claims.length, 1);
  assert.equal(h.settlements.at(-1)?.delivery, 'pending');
  assert.equal(h.settlements.some((settle) => settle.delivery === 'held'), false);
  assert.equal(h.settlements.some((settle) => settle.delivery === 'unknown'), false);

  h.setDrafts('session-1', false);
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.claims.length, 2, 'the same batch was retried, not acknowledged away');
  assert.deepEqual(h.claims.at(-1), ['notification-1']);
  assert.equal(h.settlements.at(-1)?.delivery, 'delivered');
});

test('two simultaneous results are merged into one wake turn with batch metadata', async () => {
  const h = harness();
  await h.prepare();
  h.emitNotification(notification());
  h.emitNotification(notification({ id: 'notification-2', workerId: 'worker-2', runId: 'run-2', summary: 'Second result.' }));
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 1);
  const source = h.wakeCalls[0].workerSource as { batchId: string; results: Array<{ workerId: string }> };
  assert.equal(source.batchId, 'batch-1');
  assert.deepEqual(source.results.map((result) => result.workerId), ['worker-1', 'worker-2']);
  const content = String(h.wakeCalls[0].content);
  assert.match(content, /Automatic Worker execution result \(batch batch-1\)/);
  assert.match(content, /Review the result with Codex/);
  for (const result of source.results) {
    assert.match(content, new RegExp(`Worker: ${result.workerId}`));
  }
  assert.match(content, /Run: run-1/);
  assert.match(content, /Run: run-2/);
  assert.match(content, /Status: completed/);
  assert.match(content, /Summary: Second result\./);
  assert.equal(h.settlements.filter((settle) => settle.delivery === 'delivered').length, 1);
});

test('an ACK before send removes one result and never settles it delivered', async () => {
  const h = harness({
    claim: async (ids) => ({
      batchId: 'batch-1',
      notifications: ids.filter((id) => id === 'notification-1').map((id) => notification({ id })),
    }),
  });
  await h.prepare();
  h.emitNotification(notification());
  h.emitNotification(notification({ id: 'notification-2', workerId: 'worker-2', summary: 'Acknowledged early.' }));
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 1);
  const source = h.wakeCalls[0].workerSource as { results: Array<{ workerId: string }> };
  assert.deepEqual(source.results.map((result) => result.workerId), ['worker-1']);
  assert.equal(h.settlements.filter((settle) => settle.delivery === 'delivered').length, 1);
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 1);
});

test('one unresolved parent turn does not block a second parent or its own later notifications', async () => {
  const h = harness({ sessions: { 'session-1': '/repo', 'session-2': '/other-repo' } });
  await h.prepare('session-1', 'instance-1');
  await h.prepare('session-2', 'instance-2');
  let releaseFirst!: (value: { started: boolean; error: string | null }) => void;
  let firstPending = true;
  h.setRunTurn(async (input) => {
    h.wakeCalls.push(input);
    if (input.sessionId === 'session-1' && firstPending) {
      firstPending = false;
      return await new Promise((resolve) => { releaseFirst = resolve; });
    }
    return { started: true, error: null };
  });
  h.emitNotification(notification());
  h.emitNotification(notification({ id: 'notification-2', ownerId: 'instance-2:session-2', workerId: 'worker-2', runId: 'run-2' }));
  await tick();
  h.fireTimers();
  await tick();
  // session-2 is admitted while session-1 is still awaiting its full turn.
  assert.equal(h.wakeCalls.length, 2);
  assert.deepEqual(h.wakeCalls.map((call) => call.sessionId).sort(), ['session-1', 'session-2']);
  assert.ok(h.wakeCalls.some((call) => call.sessionId === 'session-2'));
  // A new result for session-1 waits behind its current turn, then delivers.
  h.emitNotification(notification({ id: 'notification-3', workerId: 'worker-3', runId: 'run-3' }));
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.filter((call) => call.sessionId === 'session-1').length, 1);
  releaseFirst({ started: true, error: null });
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.filter((call) => call.sessionId === 'session-1').length, 2);
});

test('Stop claims the batch and settles held without waking; other parents are unaffected', async () => {
  const h = harness({ sessions: { 'session-1': '/repo', 'session-2': '/other-repo' } });
  await h.prepare('session-1', 'instance-1');
  await h.prepare('session-2', 'instance-2');
  h.emitNotification(notification());
  h.emitNotification(notification({ id: 'notification-2', ownerId: 'instance-2:session-2', workerId: 'worker-2' }));
  await tick();
  assert.equal(await h.stop('session-1'), true);
  h.fireTimers();
  await tick();
  assert.deepEqual(h.wakeCalls.map((call) => call.sessionId), ['session-2']);
  assert.equal(h.settlements.some((settle) => settle.delivery === 'delivered'), true);
});

test('scoped fenceCancel pauses only the matching owner synchronously', async () => {
  const h = harness({ sessions: { 'session-1': '/repo', 'session-2': '/other-repo' } });
  await h.prepare('session-1', 'instance-1');
  await h.prepare('session-2', 'instance-2');
  assert.equal(h.service.fenceCancel({ all: true, parentSessionId: 'session-1', pause: true }), 1);
  h.emitNotification(notification());
  h.emitNotification(notification({ id: 'notification-2', ownerId: 'instance-2:session-2', workerId: 'worker-2' }));
  await tick();
  h.fireTimers();
  await tick();
  assert.deepEqual(h.wakeCalls.map((call) => call.sessionId), ['session-2']);
});

test('a plugin disconnect and restart pause live owners and hold pre-restart notifications', async () => {
  const h = harness();
  await h.prepare();
  h.ipc.emitDisconnect();
  assert.equal(
    h.logs.filter((entry) => entry.message === '[Workers] Worker plugin disconnected; owners are locally paused until a user turn').length,
    1,
  );
  h.emitNotification(notification());
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 0);

  h.ipc.emitReady();
  await tick();
  const owners = h.requests.filter((request) => request.action === 'registerOwner');
  assert.equal(owners.length, 2);
  assert.equal((owners.at(-1)!.payload.owner as { paused: boolean }).paused, true);
  assert.equal(h.settlements.find((settle) => settle.delivery === 'held')?.delivery, 'held');
  assert.equal(h.wakeCalls.length, 0);
});

test('manual retry is discovered but never unpauses a stopped owner', async () => {
  const h = harness();
  await h.prepare();
  await h.stop('session-1');
  h.emitNotification(notification());
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 0);
  assert.equal(h.claims.length, 1);

  await h.activate('session-1');
  h.emitNotification(notification());
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 1);
});

test('a persisted-outbox retry is discovered through a changed event', async () => {
  const h = harness();
  await h.prepare();
  // Simulate a manual retry that persists the notification but emits only changed.
  h.outbox.set('notification-1', notification());
  h.ipc.emit({ channel: 'cloudcli-workers', kind: 'event', event: 'changed', value: { ownerId: 'instance-1:session-1', workerIds: ['worker-1'] } });
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 1);
});

test('the trusted final guard observes a synchronous UI cancel fence after claim', async () => {
  const h = harness();
  await h.prepare();
  const captured: { guard: (() => boolean) | null } = { guard: null };
  h.setRunTurn(async (input) => {
    captured.guard = input.finalGuard as () => boolean;
    h.wakeCalls.push(input);
    return { started: true, error: null };
  });
  h.emitNotification(notification());
  await tick();
  h.fireTimers();
  await tick();
  assert.ok(captured.guard);
  assert.equal(captured.guard(), true);
  h.service.fenceCancel({ all: true, parentSessionId: 'session-1', pause: true });
  assert.equal(captured.guard(), false);
});


test('one busy owner timer never postpones another owner idle merge window', async () => {
  const h = harness({ sessions: { 'session-1': '/repo', 'session-2': '/other-repo' } });
  await h.prepare('session-1', 'instance-1');
  await h.prepare('session-2', 'instance-2');
  h.setActiveRun('session-1', true);
  // B (idle) schedules its 500ms window first; A (busy) later schedules 2s.
  h.emitNotification(notification({ id: 'notification-b', ownerId: 'instance-2:session-2', workerId: 'worker-b' }));
  h.emitNotification(notification());
  assert.ok(h.timerDelays().includes(500));
  assert.ok(h.timerDelays().includes(2000));
  h.fireDue(500);
  await tick();
  assert.deepEqual(h.wakeCalls.map((call) => call.sessionId), ['session-2']);
  assert.deepEqual(h.claims, [['notification-b']]);
  // A remains busy and pending, and still has its own later timer.
  assert.equal(h.wakeCalls.length, 1);
  assert.ok(h.timerDelays().includes(2000));
});

test('a session Stop during deferred owner registration preserves the local fence', async () => {
  const h = harness();
  let release!: (value: boolean) => void;
  let registering = 0;
  const preparing = h.prepare('session-1', 'instance-1', async () => {
    registering++;
    return await new Promise<boolean>((resolve) => { release = resolve; });
  });
  for (let index = 0; index < 100 && registering === 0; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registering, 1);
  assert.equal(await h.stop('session-1'), true);
  release(true);
  await preparing;

  h.emitNotification(notification());
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 0);
  // The preserved pause is re-asserted after registration, then activation
  // explicitly clears it only for a genuine user turn.
  const pauses = h.requests.filter((request) => request.action === 'setOwnerPaused');
  assert.equal((pauses.at(-1)?.payload as { paused: boolean }).paused, true);
  await h.activate('session-1');
  assert.equal((h.requests.filter((request) => request.action === 'setOwnerPaused').at(-1)?.payload as { paused: boolean }).paused, false);
});

test('a UI fence during deferred owner registration still blocks the first notification', async () => {
  const h = harness();
  let release!: (value: boolean) => void;
  let registering = 0;
  const preparing = h.prepare('session-1', 'instance-1', async () => {
    registering++;
    return await new Promise<boolean>((resolve) => { release = resolve; });
  });
  for (let index = 0; index < 100 && registering === 0; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.service.fenceCancel({ all: true, parentSessionId: 'session-1', pause: true }), 1);
  release(true);
  await preparing;
  h.emitNotification(notification());
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 0);
  assert.equal((h.requests.filter((request) => request.action === 'setOwnerPaused').at(-1)?.payload as { paused: boolean }).paused, true);
});


test('a native Stop during deferred plugin startup registers a paused owner', async () => {
  const h = harness();
  let release!: (value: boolean) => void;
  h.setEnsureReady(async () => await new Promise<boolean>((resolve) => { release = resolve; }));
  const preparing = h.prepare();
  for (let index = 0; index < 100 && h.ensureReadyCalls() === 0; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.ensureReadyCalls(), 1);
  assert.equal(await h.stop('session-1'), true);
  release(true);
  await preparing;
  const register = h.requests.find((request) => request.action === 'registerOwner');
  assert.equal((register?.payload.owner as { paused: boolean }).paused, true);

  h.emitNotification(notification());
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 0);

  await h.activate('session-1');
  assert.equal((h.requests.filter((request) => request.action === 'setOwnerPaused').at(-1)?.payload as { paused: boolean }).paused, false);
});

test('a UI fence during deferred plugin startup blocks the first automatic wake', async () => {
  const h = harness();
  let release!: (value: boolean) => void;
  h.setEnsureReady(async () => await new Promise<boolean>((resolve) => { release = resolve; }));
  const preparing = h.prepare();
  for (let index = 0; index < 100 && h.ensureReadyCalls() === 0; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.ensureReadyCalls(), 1);
  assert.equal(h.service.fenceCancel({ all: true, parentSessionId: 'session-1', pause: true }), 1);
  release(true);
  await preparing;
  const register = h.requests.find((request) => request.action === 'registerOwner');
  assert.equal((register?.payload.owner as { paused: boolean }).paused, true);

  h.emitNotification(notification());
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 0);
});

test('startup failure rolls back the provisional owner', async () => {
  const h = harness();
  let release!: (value: boolean) => void;
  h.setEnsureReady(async () => await new Promise<boolean>((resolve) => { release = resolve; }));
  const preparing = h.prepare();
  for (let index = 0; index < 100 && h.ensureReadyCalls() === 0; index++) await new Promise((resolve) => setImmediate(resolve));
  release(false);
  assert.equal(await preparing, null);
  h.emitNotification(notification());
  await tick();
  h.fireTimers();
  await tick();
  assert.equal(h.wakeCalls.length, 0);
  assert.equal(h.requests.some((request) => request.action === 'registerOwner'), false);
});

test('shutdown waits for closeAll confirmation before disposing the Worker IPC', async () => {
  const h = harness();
  await h.prepare();
  let release!: (value: unknown) => void;
  h.setCloseAll(async () => await new Promise((resolve) => { release = resolve; }));
  let settled = false;
  const shuttingDown = h.service.shutdown().then(() => { settled = true; });
  await tick();
  assert.equal(h.requests.filter((request) => request.action === 'closeAll').length, 1);
  assert.equal(settled, false);
  assert.equal(h.disposed(), false);

  release({ confirmed: true });
  await shuttingDown;
  assert.equal(settled, true);
  assert.equal(h.disposed(), true);
  assert.equal(h.logs.some((entry) => entry.message === '[Workers] Could not confirm Worker cleanup during shutdown'), false);
});

test('a disconnect during shutdown is silent but failed closeAll still reports unconfirmed cleanup', async () => {
  const h = harness();
  await h.prepare();
  let rejectCloseAll!: (error: Error) => void;
  h.setCloseAll(async () => await new Promise((_resolve, reject) => { rejectCloseAll = reject; }));
  const shuttingDown = h.service.shutdown();
  await tick();
  h.ipc.emitDisconnect();
  // Shutdown already paused owners itself; the generic disconnect warning must
  // not claim that a user turn is required.
  assert.equal(
    h.logs.some((entry) => entry.message === '[Workers] Worker plugin disconnected; owners are locally paused until a user turn'),
    false,
  );

  rejectCloseAll(new Error('worker did not confirm cleanup'));
  await shuttingDown;
  const failure = h.logs.find((entry) => entry.message === '[Workers] Could not confirm Worker cleanup during shutdown');
  assert.ok(failure);
  assert.equal((failure.detail as Error).message, 'worker did not confirm cleanup');
  assert.equal(h.disposed(), true);
});

test('an earlier registered owner keeps Stop honest when pause is unconfirmed during startup', async () => {
  const h = harness();
  await h.prepare('session-1', 'instance-1');
  let release!: (value: boolean) => void;
  h.setEnsureReady(async () => await new Promise<boolean>((resolve) => { release = resolve; }));
  h.setPauseFailure(true);
  const preparing = h.prepare('session-1', 'instance-2');
  for (let index = 0; index < 100 && h.ensureReadyCalls() < 2; index++) await new Promise((resolve) => setImmediate(resolve));
  // The provisional owner is local, but the earlier registered owner's remote
  // pause failed, so Stop must report false rather than silently confirming.
  assert.equal(await h.stop('session-1'), false);
  release(true);
  await preparing;
  const register = h.requests.filter((request) => request.action === 'registerOwner').at(-1);
  assert.equal((register?.payload.owner as { paused: boolean }).paused, true);
});
