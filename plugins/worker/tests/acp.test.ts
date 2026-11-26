import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AcpConfigError,
  AcpConnection,
  AcpProtocolError,
  AcpRpcError,
  AcpTransportError,
  LazyAcpProcess,
  parseAcpEvents,
  type AcpEvent,
} from "../server/acp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_MUX_SCRIPT = path.join(HERE, "fixtures", "fake-acp-mux.mjs");

function makeMuxSpec(envOverrides: Record<string, string> = {}) {
  return {
    executable: process.execPath,
    args: [FAKE_MUX_SCRIPT],
    env: { ...process.env, ...envOverrides },
    clientInfo: { name: "cloudcli-worker-test", version: "1.0.0" },
    initializeTimeoutMs: 5000,
    closeTimeoutMs: 2000,
  };
}

function updateTexts(events: AcpEvent[]): string[] {
  const texts: string[] = [];
  for (const ev of events) {
    if (ev.type !== "acp_update") continue;
    const content = ev.update.content as { text?: unknown } | undefined;
    if (typeof content?.text === "string") texts.push(content.text);
  }
  return texts;
}

function assertAllUpdatesBelongTo(events: AcpEvent[], expectedSessionId: string): void {
  const updates = events.filter((ev): ev is Extract<AcpEvent, { type: "acp_update" }> => ev.type === "acp_update");
  assert.ok(updates.length > 0, `expected at least one acp_update for ${expectedSessionId}`);
  for (const ev of updates) {
    assert.equal(ev.sessionId, expectedSessionId, `cross-talk update detected: ${JSON.stringify(ev)}`);
  }
}

test("LazyAcpProcess starts only on first acquire, deduplicates concurrent callers, and respawns after exit", async (t) => {
  let spawnCount = 0;
  const idleLazy = new LazyAcpProcess(async () => {
    spawnCount++;
    return AcpConnection.spawn(makeMuxSpec());
  });
  assert.equal(idleLazy.isRunning, false);
  await idleLazy.close();
  assert.equal(spawnCount, 0, "close() on never-started LazyAcpProcess must not spawn");

  const lazy = new LazyAcpProcess(async () => {
    spawnCount++;
    return AcpConnection.spawn(makeMuxSpec());
  });
  t.after(async () => {
    await lazy.close();
  });

  assert.equal(lazy.isRunning, false);
  assert.equal(spawnCount, 0);

  const [c1, c2, c3] = await Promise.all([lazy.acquire(), lazy.acquire(), lazy.acquire()]);
  assert.equal(spawnCount, 1, "concurrent acquire() calls must initialize only once");
  assert.equal(c1, c2);
  assert.equal(c2, c3);
  assert.equal(lazy.isRunning, true);
  assert.equal(c1.initialized.protocolVersion, 1);
  assert.equal(c1.initialized.supportsResume, true);
  assert.equal(c1.initialized.supportsClose, true);
  const firstPid = c1.child.pid;
  assert.ok(firstPid);

  // Trigger an abrupt crash on the shared process and verify LazyAcpProcess resets cleanly.
  const crashSession = await c1.openSession({ cwd: "/tmp/crash-cwd", sessionId: null });
  await assert.rejects(() => crashSession.prompt("crash"), AcpTransportError);
  assert.equal(lazy.isRunning, false);

  const c4 = await lazy.acquire();
  assert.equal(spawnCount, 2, "next acquire() after crash should spawn a fresh process");
  assert.notEqual(c4.child.pid, firstPid);
  assert.equal(lazy.isRunning, true);

  await lazy.close();
  assert.equal(lazy.isRunning, false);
});

test("LazyAcpProcess holds a same-slot acquire until an idle drain confirms the old process exited", async () => {
  let spawns = 0;
  let releaseDrain!: (reaped: boolean) => void;
  let drainStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    drainStarted = resolve;
  });
  const drain = new Promise<boolean>((resolve) => {
    releaseDrain = resolve;
  });
  const connection = {
    alive: true,
    client: { onFailure: () => () => {} },
    shutdown: async () => {
      drainStarted();
      return drain;
    },
  } as unknown as AcpConnection;
  const lazy = new LazyAcpProcess(
    async () => {
      spawns++;
      return connection;
    },
    { idleTimeoutMs: 20 },
  );
  await lazy.beginTask();
  lazy.endTask();
  await started;

  const pending = lazy.beginTask();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(spawns, 1, "a new acquire must wait for the idle drain instead of spawning");
  releaseDrain(true);
  assert.equal(await pending, connection);
  assert.equal(spawns, 2, "the slot becomes reusable only after the drain confirms exit");
  lazy.endTask();
  await lazy.close();
});

test("AcpConnection multiplexes concurrent multi-cwd sessions with same-chunk early updates and zero cross-talk", async (t) => {
  const conn = await AcpConnection.spawn(makeMuxSpec({ FAKE_ACP_EARLY_UPDATE_SAME_CHUNK: "1" }));
  t.after(async () => {
    await conn.shutdown();
  });

  const eventsA: AcpEvent[] = [];
  const eventsB: AcpEvent[] = [];
  const cwdA = "/tmp/acp-delay-open-alpha";
  const cwdB = "/tmp/acp-beta";

  // Open concurrently with out-of-order responses (A is delayed, B returns immediately).
  const [sessionA, sessionB] = await Promise.all([
    conn.openSession({
      cwd: cwdA,
      sessionId: null,
      configOptions: [{ configId: "model", value: "gpt-5", match: "model" }],
      onEvent: (ev) => eventsA.push(ev),
    }),
    conn.openSession({
      cwd: cwdB,
      sessionId: null,
      onEvent: (ev) => eventsB.push(ev),
    }),
  ]);

  assert.equal(conn.activeSessionCount, 2);
  assert.notEqual(sessionA.sessionId, sessionB.sessionId);
  assert.equal(sessionA.action, "new");
  assert.equal(sessionA.cwd, cwdA);
  assert.equal(sessionB.action, "new");
  assert.equal(sessionB.cwd, cwdB);
  assert.equal(
    sessionA.configOptions.find((o) => o.id === "model")?.currentValue,
    "openai/gpt-5",
  );

  // Same-chunk early updates must be captured strictly by their owning session.
  assert.ok(updateTexts(eventsA).includes(`early:${sessionA.sessionId}:${cwdA}`));
  assert.ok(updateTexts(eventsB).includes(`early:${sessionB.sessionId}:${cwdB}`));
  assert.ok(!updateTexts(eventsA).some((text) => text.includes(sessionB.sessionId)));
  assert.ok(!updateTexts(eventsB).some((text) => text.includes(sessionA.sessionId)));

  // Concurrent interleaved streaming prompts (including split UTF-8 multibyte chunk on B).
  const [turnA, turnB] = await Promise.all([
    sessionA.prompt("slow:80:alpha"),
    sessionB.prompt("fast:beta"),
  ]);

  assert.equal(turnA.stopReason, "end_turn");
  assert.equal(turnA.sessionId, sessionA.sessionId);
  assert.equal(turnA.cwd, cwdA);
  assert.equal(turnA.action, "new");
  assert.equal(turnB.stopReason, "end_turn");
  assert.equal(turnB.sessionId, sessionB.sessionId);
  assert.equal(turnB.cwd, cwdB);
  assert.equal(turnB.action, "new");

  assertAllUpdatesBelongTo(eventsA, sessionA.sessionId);
  assertAllUpdatesBelongTo(eventsB, sessionB.sessionId);
  assert.ok(updateTexts(eventsA).some((t) => t.includes("中文🚀")));
  assert.ok(updateTexts(eventsB).some((t) => t.includes(`fast:${sessionB.sessionId}:${cwdB}:beta:中文🚀`)));
  assert.ok(!updateTexts(eventsA).some((t) => t.includes(sessionB.sessionId)));
  assert.ok(!updateTexts(eventsB).some((t) => t.includes(sessionA.sessionId)));
});

test("Targeted session/cancel and session/close isolate one session while sibling continues", async (t) => {
  const conn = await AcpConnection.spawn(makeMuxSpec());
  t.after(async () => {
    await conn.shutdown();
  });

  const eventsA: AcpEvent[] = [];
  const eventsB: AcpEvent[] = [];
  const sessionA = await conn.openSession({
    cwd: "/tmp/cancel-a",
    sessionId: null,
    onEvent: (ev) => eventsA.push(ev),
  });
  const sessionB = await conn.openSession({
    cwd: "/tmp/cancel-b",
    sessionId: null,
    onEvent: (ev) => eventsB.push(ev),
  });

  // Start slow prompt on A and moderate prompt on B concurrently.
  const promptA = sessionA.prompt("slow:4000:a-turn");
  const promptB = sessionB.prompt("slow:120:b-turn1");

  // Overlapping prompt on the same session must fail without breaking active turn or sibling.
  await assert.rejects(() => sessionA.prompt("fast:overlap"), AcpProtocolError);

  // Cancel ONLY session A.
  await new Promise((resolve) => setTimeout(resolve, 35));
  await sessionA.cancel({ graceMs: 1000 });

  const [turnA, turnB1] = await Promise.all([promptA, promptB]);
  assert.equal(turnA.stopReason, "cancelled");
  assert.equal(turnB1.stopReason, "end_turn");
  assertAllUpdatesBelongTo(eventsA, sessionA.sessionId);
  assertAllUpdatesBelongTo(eventsB, sessionB.sessionId);
  assert.equal(conn.alive, true);

  // Close ONLY session A; shared process and session B stay alive and usable.
  await sessionA.close();
  assert.equal(sessionA.closed, true);
  assert.equal(sessionB.closed, false);
  assert.equal(conn.activeSessionCount, 1);
  assert.equal(conn.alive, true);
  assert.ok(eventsA.some((ev) => ev.type === "acp_closed" && ev.sessionId === sessionA.sessionId));
  assert.ok(!eventsB.some((ev) => ev.type === "acp_closed"));

  // Closed session rejects further prompts locally.
  await assert.rejects(() => sessionA.prompt("fast:after-close"), AcpProtocolError);

  // Sibling session B continues normally on the same initialized process.
  const turnB2 = await sessionB.prompt("fast:b-turn2");
  assert.equal(turnB2.stopReason, "end_turn");
  assert.equal(turnB2.sessionId, sessionB.sessionId);

  // Closed session can be resumed later on the same shared connection.
  const resumedA = await conn.openSession({
    cwd: "/tmp/cancel-a",
    sessionId: sessionA.sessionId,
  });
  assert.equal(resumedA.action, "resume");
  assert.equal(resumedA.sessionId, sessionA.sessionId);
  const turnResumed = await resumedA.prompt("fast:after-resume");
  assert.equal(turnResumed.stopReason, "end_turn");
  assert.equal(turnResumed.action, "resume");
  await resumedA.close();
  await sessionB.close();
  assert.equal(conn.activeSessionCount, 0);
});

test("Config rejection, silent downgrade, RPC error, and server->client request do not poison sibling sessions", async (t) => {
  const conn = await AcpConnection.spawn(makeMuxSpec());
  t.after(async () => {
    await conn.shutdown();
  });

  const healthyEvents: AcpEvent[] = [];
  const healthy = await conn.openSession({
    cwd: "/tmp/healthy",
    sessionId: null,
    onEvent: (ev) => healthyEvents.push(ev),
  });

  // Silent downgrade must fail with AcpConfigError and close ONLY the failing session.
  await assert.rejects(
    () =>
      conn.openSession({
        cwd: "/tmp/bad-clamp",
        sessionId: null,
        configOptions: [{ configId: "thought_level", value: "clamped" }],
      }),
    AcpConfigError,
  );
  // Explicit RPC config error must also close ONLY the failing session.
  await assert.rejects(
    () =>
      conn.openSession({
        cwd: "/tmp/bad-rpc",
        sessionId: null,
        configOptions: [{ configId: "thought_level", value: "unsupported" }],
      }),
    AcpConfigError,
  );
  assert.equal(conn.activeSessionCount, 1);
  assert.equal(conn.alive, true);

  // Per-session RPC error affects only that session.
  const errSession = await conn.openSession({ cwd: "/tmp/err-session", sessionId: null });
  await assert.rejects(() => errSession.prompt("rpc-error"), AcpRpcError);
  await errSession.close();

  // Unexpected server->client request is rejected with -32601 without deadlocking concurrent sessions.
  const srvReqSession = await conn.openSession({ cwd: "/tmp/srv-req", sessionId: null });
  const [srvTurn, healthyTurn] = await Promise.all([
    srvReqSession.prompt("server-request"),
    healthy.prompt("fast:still-healthy"),
  ]);
  assert.equal(srvTurn.stopReason, "end_turn");
  assert.equal(srvTurn.result.rejectedCode, -32601);
  assert.equal(healthyTurn.stopReason, "end_turn");
  assertAllUpdatesBelongTo(healthyEvents, healthy.sessionId);
});

test("Abrupt process exit and malformed stdout JSON unblock all concurrent sessions with zero cross-talk", async (t) => {
  // 1) Abrupt exit mid-flight
  const exitConn = await AcpConnection.spawn(makeMuxSpec());
  t.after(async () => {
    await exitConn.shutdown();
  });

  const evWait: AcpEvent[] = [];
  const evCrash: AcpEvent[] = [];
  const evIdle: AcpEvent[] = [];

  const waitSession = await exitConn.openSession({
    cwd: "/tmp/wait-exit",
    sessionId: null,
    onEvent: (ev) => evWait.push(ev),
  });
  const crashSession = await exitConn.openSession({
    cwd: "/tmp/do-crash",
    sessionId: null,
    onEvent: (ev) => evCrash.push(ev),
  });
  const idleSession = await exitConn.openSession({
    cwd: "/tmp/idle-exit",
    sessionId: null,
    onEvent: (ev) => evIdle.push(ev),
  });

  const settledExit = await Promise.allSettled([
    waitSession.prompt("slow:5000:waiting"),
    crashSession.prompt("crash"),
  ]);
  assert.equal(settledExit[0].status, "rejected");
  assert.equal(settledExit[1].status, "rejected");
  assert.ok(settledExit[0].reason instanceof AcpTransportError);
  assert.ok(settledExit[1].reason instanceof AcpTransportError);
  assert.equal(settledExit[0].reason.failure.kind, "exit");
  assert.equal(settledExit[0].reason.failure.exitCode, 42);
  assert.equal(exitConn.alive, false);
  assert.equal(exitConn.activeSessionCount, 0);
  assert.equal(waitSession.closed, true);
  assert.equal(crashSession.closed, true);
  assert.equal(idleSession.closed, true);
  assert.equal(evWait.filter((e) => e.type === "acp_error").length, 1);
  assert.equal(evCrash.filter((e) => e.type === "acp_error").length, 1);
  assert.equal(evIdle.filter((e) => e.type === "acp_error").length, 1);
  assertAllUpdatesBelongTo(evWait, waitSession.sessionId);
  assertAllUpdatesBelongTo(evCrash, crashSession.sessionId);

  // 2) Malformed stdout JSON mid-flight
  const corruptConn = await AcpConnection.spawn(makeMuxSpec());
  t.after(async () => {
    await corruptConn.shutdown();
  });

  const s1 = await corruptConn.openSession({ cwd: "/tmp/corrupt-1", sessionId: null });
  const s2 = await corruptConn.openSession({ cwd: "/tmp/corrupt-2", sessionId: null });

  const settledCorrupt = await Promise.allSettled([
    s1.prompt("slow:5000:c1"),
    s2.prompt("corrupt"),
  ]);
  assert.equal(settledCorrupt[0].status, "rejected");
  assert.equal(settledCorrupt[1].status, "rejected");
  assert.ok(settledCorrupt[0].reason instanceof AcpTransportError);
  assert.ok(settledCorrupt[1].reason instanceof AcpTransportError);
  assert.equal(settledCorrupt[0].reason.failure.kind, "protocol_error");
  assert.equal(corruptConn.activeSessionCount, 0);
  assert.equal(corruptConn.alive, false);
});

test("parseAcpEvents preserves recovery action/cwd and does not misclassify recovered new sessions as resume", () => {
  const cwd = "/tmp/acp-recovery-cwd";
  const newSessionEvents = [
    { number: 1, value: { protocol: "acp", type: "acp_initialized", protocolVersion: 1 } },
    {
      number: 2,
      value: {
        protocol: "acp",
        type: "acp_session",
        action: "new",
        sessionId: "sess-recovered-1",
        cwd,
      },
    },
    {
      number: 3,
      value: {
        protocol: "acp",
        type: "acp_prompt_result",
        sessionId: "sess-recovered-1",
        stopReason: "end_turn",
      },
    },
  ];

  // Handle-less recovery knows persisted sessionId, without knowing action was "resume".
  const recovered = parseAcpEvents(newSessionEvents, "sess-recovered-1", cwd);
  assert.equal(recovered.success, true);
  assert.equal(recovered.action, "new");
  assert.equal(recovered.sessionId, "sess-recovered-1");
  assert.equal(recovered.validatedSessionId, "sess-recovered-1");
  assert.equal(recovered.cwd, cwd);
  assert.equal(recovered.identityMismatch, false);

  // Explicit expectedAction: "resume" still rejects action: "new".
  const strictResume = parseAcpEvents(newSessionEvents, "sess-recovered-1", cwd, {
    expectedAction: "resume",
  });
  assert.equal(strictResume.success, false);
  assert.equal(strictResume.errorCode, "PROTOCOL_INVALID");

  // Brand-new run (expectedSessionId: null) still rejects unexpected action: "resume".
  const badResumeOnNew = parseAcpEvents(
    [
      newSessionEvents[0],
      {
        number: 2,
        value: {
          protocol: "acp",
          type: "acp_session",
          action: "resume",
          sessionId: "sess-recovered-1",
          cwd,
        },
      },
      newSessionEvents[2],
    ],
    null,
    cwd,
  );
  assert.equal(badResumeOnNew.success, false);
  assert.equal(badResumeOnNew.errorCode, "PROTOCOL_INVALID");

  // Session ID mismatch still sets identityMismatch and clears validatedSessionId.
  const mismatch = parseAcpEvents(newSessionEvents, "different-id", cwd);
  assert.equal(mismatch.success, false);
  assert.equal(mismatch.identityMismatch, true);
  assert.equal(mismatch.validatedSessionId, null);
});
