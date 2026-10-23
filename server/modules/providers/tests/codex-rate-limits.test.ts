import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import test from 'node:test';

import { CodexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { CodexRateLimitsService } from '@/modules/providers/list/codex/codex-rate-limits.service.js';
import type { CodexRateLimitSnapshot, CodexRpcClient, CodexRpcFrame } from '@/shared/index.js';

type FakeClient = CodexRpcClient & {
  requests: string[];
  emit(frame: CodexRpcFrame): void;
  exit(error?: Error): void;
  /** Resolves the next `account/rateLimits/read` with a value, or rejects it. */
  respond(value: unknown | Error): void;
};

/**
 * Scripted transport so the service's cache, race and stale behaviour can be
 * asserted without spawning a Codex process.
 */
function fakeClient(): FakeClient {
  const notifications = new Set<(frame: CodexRpcFrame) => void>();
  const exits = new Set<(error: Error) => void>();
  const pending: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  const requests: string[] = [];
  return {
    requests,
    status: { running: false, pid: null, startedAt: null, pendingRequests: 0, launcherPath: null, cliVersion: null },
    request<T>(method: string): Promise<T> {
      requests.push(method);
      return new Promise<T>((resolve, reject) => {
        pending.push({ resolve: resolve as (value: unknown) => void, reject });
      });
    },
    onNotification(listener) { notifications.add(listener); return () => notifications.delete(listener); },
    onRequest() { return () => {}; },
    onExit(listener) { exits.add(listener); return () => exits.delete(listener); },
    emit(frame) { for (const listener of notifications) listener(frame); },
    exit(error = new Error('Codex app-server exited (1).')) { for (const listener of exits) listener(error); },
    respond(value) {
      const entry = pending.shift();
      assert.ok(entry, 'no pending rate-limit read to answer');
      if (value instanceof Error) entry.reject(value);
      else entry.resolve(value);
    },
  };
}

/** One protocol bucket; `primary`/`secondary` may be swapped by Codex at any time. */
const bucket = (windows: { primary?: unknown; secondary?: unknown } = {}) => ({
  limitId: 'codex',
  primary: windows.primary ?? { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
  secondary: windows.secondary,
});

/** Lets queued notifications and promise continuations run before assertions. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function enabledService(client: FakeClient, now = () => 1_700_000_000_000) {
  return new CodexRateLimitsService(client, now, () => true);
}

test('disabled deployments advertise no quota, reject refresh and never send an RPC', async () => {
  const client = fakeClient();
  const service = new CodexRateLimitsService(client, Date.now, () => false);

  assert.deepEqual(service.getState(), { enabled: false, snapshot: null });
  await assert.rejects(service.refresh(), (error: { code?: string }) => error.code === 'CODEX_RATE_LIMITS_DISABLED');
  client.emit({ method: 'account/rateLimits/updated', params: { rateLimits: bucket() } });
  await flush();
  assert.deepEqual(service.getState(), { enabled: false, snapshot: null });
  assert.deepEqual(client.requests, []);
});

test('reading the cache never touches the transport', () => {
  const client = fakeClient();
  const service = enabledService(client);
  assert.deepEqual(service.getState(), { enabled: true, snapshot: null });
  assert.deepEqual(client.requests, []);
});

test('a refresh sends one account/rateLimits/read and caches both windows by duration', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const events: Array<{ kind: string; snapshot: CodexRateLimitSnapshot | null }> = [];
  service.subscribe((event) => events.push(event));

  const pending = service.refresh();
  assert.deepEqual(client.requests, ['account/rateLimits/read']);
  client.respond({
    rateLimits: bucket({ secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_700_000_600 } }),
  });

  const snapshot = await pending;
  assert.deepEqual(snapshot, {
    weekly: { remainingPercent: 75, resetsAt: 1_800_000_000 },
    fiveHour: { remainingPercent: 60, resetsAt: 1_700_000_600 },
    updatedAt: 1_700_000_000_000,
    stale: false,
  });
  assert.deepEqual(service.getState().snapshot, snapshot);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'codex_rate_limits_updated');
});

test('concurrent refreshes share a single in-flight RPC', async () => {
  const client = fakeClient();
  const service = enabledService(client);

  const first = service.refresh();
  const second = service.refresh();
  assert.equal(client.requests.length, 1);
  client.respond({ rateLimits: bucket() });

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  // A later explicit refresh is a new request rather than a cached answer.
  const third = service.refresh();
  assert.equal(client.requests.length, 2);
  client.respond({ rateLimits: bucket() });
  await third;
});

test('window identification follows duration, not the primary/secondary field names', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();
  // Codex may put the 5-hour window in `primary` and the weekly one in `secondary`.
  client.respond({
    rateLimitsByLimitId: {
      codex: bucket({
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_700_000_600 },
        secondary: { usedPercent: 90, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
      }),
    },
  });

  const snapshot = await pending;
  assert.deepEqual(snapshot?.weekly, { remainingPercent: 10, resetsAt: 1_800_000_000 });
  assert.deepEqual(snapshot?.fiveHour, { remainingPercent: 90, resetsAt: 1_700_000_600 });
});

test('a missing weekly window stays null instead of being invented', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();
  client.respond({ rateLimits: bucket({ primary: { usedPercent: 5, windowDurationMins: 300 } }) });

  const snapshot = await pending;
  assert.equal(snapshot?.weekly, null);
  assert.deepEqual(snapshot?.fiveHour, { remainingPercent: 95, resetsAt: null });
});

test('a well-formed bucket with no weekly or 5-hour window yields empty windows, not an error', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();
  // Both slots explicitly empty, which is a legitimate answer for an account
  // that reports neither window.
  client.respond({ rateLimits: { limitId: 'codex', primary: null, secondary: null } });

  const snapshot = await pending;
  assert.equal(snapshot?.weekly, null);
  assert.equal(snapshot?.fiveHour, null);
  assert.equal(snapshot?.stale, false);
  // The card can therefore say "no weekly quota data" instead of failing.
  assert.deepEqual(service.getState().snapshot, snapshot);
});

test('a well-formed bucket holding only a window of another duration is empty, not malformed', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();
  client.respond({ rateLimits: bucket({ primary: { usedPercent: 10, windowDurationMins: 1440 } }) });

  const snapshot = await pending;
  assert.equal(snapshot?.weekly, null);
  assert.equal(snapshot?.fiveHour, null);
});

test('a malformed window of a known duration is rejected outright', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();
  client.respond({ rateLimits: bucket({ primary: { usedPercent: '25', windowDurationMins: 10_080 } }) });

  await assert.rejects(pending, (error: { code?: string }) => error.code === 'CODEX_RATE_LIMITS_REFRESH_FAILED');
  assert.equal(service.getState().snapshot, null);
});

test('a malformed notification never replaces a good cached snapshot', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();
  client.respond({ rateLimits: bucket() });
  await pending;

  client.emit({
    method: 'account/rateLimits/updated',
    params: { rateLimits: bucket({ primary: { usedPercent: Number.NaN, windowDurationMins: 10_080 } }) },
  });
  await flush();
  assert.equal(service.getState().snapshot?.weekly?.remainingPercent, 75);
  assert.equal(service.getState().snapshot?.stale, false);
});

test('remainingPercent is clamped to 0..100 and keeps two decimals', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();
  client.respond({
    rateLimitsByLimitId: { codex: bucket({ primary: { usedPercent: 100.5, windowDurationMins: 10_080 } }) },
  });
  assert.equal((await pending)?.weekly?.remainingPercent, 0);

  const second = service.refresh();
  client.respond({ rateLimitsByLimitId: { codex: bucket({ primary: { usedPercent: -5, windowDurationMins: 10_080 } }) } });
  assert.equal((await second)?.weekly?.remainingPercent, 100);

  const third = service.refresh();
  client.respond({ rateLimitsByLimitId: { codex: bucket({ primary: { usedPercent: 33.333, windowDurationMins: 10_080 } }) } });
  assert.equal((await third)?.weekly?.remainingPercent, 66.67);
});

test('a bare rateLimits bucket naming another limit id never becomes the Codex quota', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();
  client.respond({ rateLimits: { limitId: 'review', primary: { usedPercent: 1, windowDurationMins: 10_080 } } });

  await assert.rejects(pending, (error: { code?: string }) => error.code === 'CODEX_RATE_LIMITS_REFRESH_FAILED');
  assert.equal(service.getState().snapshot, null);
});

test('rateLimitsByLimitId.codex wins over a bare bucket for another limit', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();
  client.respond({
    rateLimits: { limitId: 'review', primary: { usedPercent: 99, windowDurationMins: 10_080 } },
    rateLimitsByLimitId: { codex: bucket({ primary: { usedPercent: 20, windowDurationMins: 10_080 } }) },
  });

  assert.equal((await pending)?.weekly?.remainingPercent, 80);
});

test('account/rateLimits/updated updates the cache while other buckets are ignored', async () => {
  const client = fakeClient();
  const service = enabledService(client);

  client.emit({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { limitId: 'review', primary: { usedPercent: 1, windowDurationMins: 10_080 } } },
  });
  await flush();
  assert.equal(service.getState().snapshot, null);

  client.emit({
    method: 'account/rateLimits/updated',
    params: { rateLimitsByLimitId: { codex: bucket({ secondary: { usedPercent: 30, windowDurationMins: 300 } }) } },
  });
  await flush();
  assert.equal(service.getState().snapshot?.weekly?.remainingPercent, 75);
  assert.equal(service.getState().snapshot?.fiveHour?.remainingPercent, 70);
});

test('an app-server exit keeps the last windows and marks them stale', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();
  client.respond({ rateLimits: bucket() });
  await pending;

  client.exit();
  const snapshot = service.getState().snapshot;
  assert.equal(snapshot?.stale, true);
  // Stale values are retained, never reset to a full quota.
  assert.equal(snapshot?.weekly?.remainingPercent, 75);
});

test('a failed refresh keeps the previous values and marks them stale', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const first = service.refresh();
  client.respond({ rateLimits: bucket() });
  await first;

  const second = service.refresh();
  client.respond(new Error('initialize failed'));
  await assert.rejects(second, (error: { code?: string }) => error.code === 'CODEX_RATE_LIMITS_REFRESH_FAILED');

  const snapshot = service.getState().snapshot;
  assert.equal(snapshot?.stale, true);
  assert.equal(snapshot?.weekly?.remainingPercent, 75);
});

test('account/updated clears the cached quota so a new account cannot inherit it', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();
  client.respond({ rateLimits: bucket() });
  await pending;

  const events: Array<CodexRateLimitSnapshot | null> = [];
  service.subscribe((event) => events.push(event.snapshot));
  client.emit({ method: 'account/updated', params: { authMode: 'chatgpt' } });
  await flush();

  assert.equal(service.getState().snapshot, null);
  assert.deepEqual(events, [null]);
});

test('a read that raced a newer notification cannot overwrite it', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();

  // A notification lands while the read is outstanding.
  client.emit({
    method: 'account/rateLimits/updated',
    params: { rateLimitsByLimitId: { codex: bucket({ primary: { usedPercent: 60, windowDurationMins: 10_080 } }) } },
  });
  await flush();
  assert.equal(service.getState().snapshot?.weekly?.remainingPercent, 40);

  // The older read then answers with different values and must be discarded.
  client.respond({ rateLimitsByLimitId: { codex: bucket({ primary: { usedPercent: 10, windowDurationMins: 10_080 } }) } });
  await pending;
  assert.equal(service.getState().snapshot?.weekly?.remainingPercent, 40);
});

test('a read started for the previous account is discarded after account/updated', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();

  client.emit({ method: 'account/updated', params: {} });
  await flush();
  client.respond({ rateLimits: bucket() });
  await pending;

  assert.equal(service.getState().snapshot, null);
});

// ---------------------------------------------------------------------------
// Transport integration: the cache must work through the real shared transport,
// which is also what normal chat uses.
// ---------------------------------------------------------------------------

/** A scripted child process that acknowledges initialize and answers named RPCs. */
function fakeTransportProcess() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.defineProperty(child, 'pid', { value: 43210 });
  const frames: CodexRpcFrame[] = [];
  let answer: (frame: CodexRpcFrame) => void = (frame) => {
    if (frame.id !== undefined) queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: frame.id, result: {} })}\n`));
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const frame = JSON.parse(String(chunk)) as CodexRpcFrame;
      frames.push(frame);
      if (frame.method === 'initialize') {
        queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: frame.id, result: {} })}\n`));
      } else {
        answer(frame);
      }
      done();
    },
  });
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true; };
  return {
    child,
    frames,
    answerWith(handler: (frame: CodexRpcFrame) => void) { answer = handler; },
    notify(method: string, params: unknown) {
      child.stdout.emit('data', `${JSON.stringify({ method, params })}\n`);
    },
  };
}

test('refresh lazily starts the shared transport and reads quota through it', async () => {
  const h = fakeTransportProcess();
  const transport = new CodexAppServerTransport({ spawn: () => h.child, timeoutMs: 1000 });
  const service = new CodexRateLimitsService(transport, () => 1_700_000_000_000, () => true);
  h.answerWith((frame) => {
    if (frame.method !== 'account/rateLimits/read') return;
    queueMicrotask(() => h.child.stdout.emit('data', `${JSON.stringify({
      id: frame.id,
      result: { rateLimitsByLimitId: { codex: bucket({ secondary: { usedPercent: 40, windowDurationMins: 300 } }) } },
    })}\n`));
  });
  try {
    // Reading the cache must not spawn the process.
    assert.equal(service.getState().snapshot, null);
    assert.equal(transport.status.pid, null);
    assert.equal(h.frames.length, 0);

    const snapshot = await service.refresh();
    assert.equal(transport.status.pid, 43210);
    assert.equal(snapshot?.weekly?.remainingPercent, 75);
    assert.equal(snapshot?.fiveHour?.remainingPercent, 60);
    assert.ok(h.frames.some((frame) => frame.method === 'account/rateLimits/read'));
  } finally {
    await transport.close();
  }
});

test('refreshes reuse an already running transport and coalesce into one RPC', async () => {
  const h = fakeTransportProcess();
  const transport = new CodexAppServerTransport({ spawn: () => h.child, timeoutMs: 1000 });
  const service = new CodexRateLimitsService(transport, Date.now, () => true);
  const spawn = h.frames.filter((frame) => frame.method === 'initialize').length;
  h.answerWith((frame) => {
    if (frame.method === 'account/rateLimits/read') {
      // Answer asynchronously so the concurrent callers genuinely overlap.
      setTimeout(() => h.child.stdout.emit('data', `${JSON.stringify({ id: frame.id, result: { rateLimits: bucket() } })}\n`), 5);
    } else if (frame.id !== undefined) {
      queueMicrotask(() => h.child.stdout.emit('data', `${JSON.stringify({ id: frame.id, result: {} })}\n`));
    }
  });
  try {
    const [a, b] = await Promise.all([service.refresh(), service.refresh()]);
    assert.deepEqual(a, b);
    assert.equal(h.frames.filter((frame) => frame.method === 'account/rateLimits/read').length, 1);
    assert.equal(h.frames.filter((frame) => frame.method === 'initialize').length, spawn + 1);
  } finally {
    await transport.close();
  }
});

test('quota notifications during ordinary app-server use are cached without a refresh', async () => {
  const h = fakeTransportProcess();
  const transport = new CodexAppServerTransport({ spawn: () => h.child, timeoutMs: 1000 });
  const service = new CodexRateLimitsService(transport, () => 1_700_000_000_000, () => true);
  try {
    // Ordinary chat traffic starts the shared process; no quota page was opened.
    await transport.request('thread/read', { threadId: 't' });
    h.notify('account/rateLimits/updated', {
      rateLimitsByLimitId: { codex: bucket({ primary: { usedPercent: 40, windowDurationMins: 10_080 } }) },
    });
    await flush();
    assert.equal(service.getState().snapshot?.weekly?.remainingPercent, 60);
    assert.deepEqual(h.frames.filter((frame) => frame.method === 'account/rateLimits/read'), []);
  } finally {
    await transport.close();
  }
});

test('an app-server exit through the real transport keeps the quota but marks it stale', async () => {
  const h = fakeTransportProcess();
  const transport = new CodexAppServerTransport({ spawn: () => h.child, timeoutMs: 1000 });
  const service = new CodexRateLimitsService(transport, Date.now, () => true);
  try {
    await transport.request('thread/read', { threadId: 't' });
    h.notify('account/rateLimits/updated', { rateLimits: bucket() });
    await flush();
    assert.equal(service.getState().snapshot?.stale, false);

    h.child.emit('exit', 1, null);
    await flush();
    assert.equal(service.getState().snapshot?.stale, true);
    assert.equal(service.getState().snapshot?.weekly?.remainingPercent, 75);
  } finally {
    await transport.close();
  }
});

test('a read that raced an app-server exit cannot populate a fresh snapshot', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();

  // The process dies while its read is still outstanding.
  client.exit();
  await flush();
  client.respond({ rateLimits: bucket() });
  await pending;

  // Nothing was cached from the dead generation, so no quota is invented.
  assert.equal(service.getState().snapshot, null);
});

// ---------------------------------------------------------------------------
// Expiry (item 4) and failure-race staleness (item 5).
// ---------------------------------------------------------------------------

test('an already expired window is reported stale and keeps its value', async () => {
  const client = fakeClient();
  // `now` is past the weekly reset (1_800_000_000s), so the snapshot is stale.
  const service = enabledService(client, () => 1_900_000_000_000);
  const pending = service.refresh();
  client.respond({ rateLimits: bucket() });

  const snapshot = await pending;
  assert.equal(snapshot?.stale, true);
  // The reported remaining quota is retained; nothing is recalculated to 100%.
  assert.equal(snapshot?.weekly?.remainingPercent, 75);
});

test('GET reports an expired cached snapshot as stale without any RPC', async () => {
  const client = fakeClient();
  let now = 1_700_000_000_000;
  const service = new CodexRateLimitsService(client, () => now, () => true);
  const pending = service.refresh();
  client.respond({ rateLimits: bucket({ primary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_700_000_100 } }) });
  await pending;
  assert.equal(service.getState().snapshot?.stale, false);

  // Time passes beyond the reset while the page stays open.
  now = 1_700_000_101_000;
  assert.equal(service.getState().snapshot?.stale, true);
  assert.equal(service.getState().snapshot?.weekly?.remainingPercent, 75);
  assert.deepEqual(client.requests, ['account/rateLimits/read']);
});

test('a notification whose window is already expired is stored stale', async () => {
  const client = fakeClient();
  const service = enabledService(client, () => 1_900_000_000_000);
  client.emit({
    method: 'account/rateLimits/updated',
    params: { rateLimits: bucket({ primary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: 1_800_000_000 } }) },
  });
  await flush();
  assert.equal(service.getState().snapshot?.stale, true);
  assert.equal(service.getState().snapshot?.weekly?.remainingPercent, 70);
});

test('a failed read does not mark a snapshot that a newer notification installed', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();

  // A fresh notification lands while the read is outstanding.
  client.emit({
    method: 'account/rateLimits/updated',
    params: { rateLimits: bucket({ primary: { usedPercent: 40, windowDurationMins: 10_080 } }) },
  });
  await flush();

  // The older read then fails; it must not taint the newer, fresh snapshot.
  client.respond(new Error('read interrupted'));
  await assert.rejects(pending, (error: { code?: string }) => error.code === 'CODEX_RATE_LIMITS_REFRESH_FAILED');

  assert.equal(service.getState().snapshot?.weekly?.remainingPercent, 60);
  assert.equal(service.getState().snapshot?.stale, false);
});

test('a failed read after an account change does not mark any snapshot stale', async () => {
  const client = fakeClient();
  const service = enabledService(client);
  const pending = service.refresh();

  client.emit({ method: 'account/updated', params: {} });
  await flush();
  client.respond(new Error('read interrupted'));
  await assert.rejects(pending, (error: { code?: string }) => error.code === 'CODEX_RATE_LIMITS_REFRESH_FAILED');

  assert.equal(service.getState().snapshot, null);
});

test('getState reports no snapshot while the deployment is disabled', () => {
  const client = fakeClient();
  let enabled = true;
  const service = new CodexRateLimitsService(client, () => 1_700_000_000_000, () => enabled);
  // Seed a cache while enabled.
  const pending = service.refresh();
  client.respond({ rateLimits: bucket() });
  return pending.then(() => {
    assert.equal(service.getState().enabled, true);
    enabled = false;
    assert.deepEqual(service.getState(), { enabled: false, snapshot: null });
  });
});
