import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parsePiAcp } from "../server/pi-acp.js";
import { resolveBundledPiAcpEntry } from "../server/native.js";
import {
  nativeSessionRoots,
  sweepNativeSessions,
} from "../server/native-retention.js";
import type { WorkerRecord, WorkerRun } from "../shared/contracts.js";
import {
  createService,
  piAcpFixture,
  piFixture,
  pluginRoot,
  startInput,
  temporaryRoot,
  waitFor,
  waitStatus,
} from "./helpers.js";

const DAY = 86_400_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

test("Pi ACP runs initialize/new/config/prompt/close and isolates multi-turn resume usage", async (t) => {
  const root = temporaryRoot("worker-pi-acp-turns-");
  const { service, env } = createService(t, root, {
    TEST_SESSION_ID: "acp-turn-session-1",
    TEST_USAGE_JSON: JSON.stringify({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
    }),
  });

  const started = await service.start(
    "owner-1",
    startInput({
      type: "pi",
      model: "provider/model-a",
      effort: "high",
      requestId: "acp-turn-1",
    }),
  );
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  const run1 = first.latestRun!;
  assert.equal(run1.nativeProtocol, "acp");
  assert.equal(run1.nativeSessionId, "acp-turn-session-1");
  assert.equal(run1.piTranscriptOffset, 0);
  assert.ok(run1.nativeSessionFile && fs.existsSync(run1.nativeSessionFile));
  assert.equal(run1.finalText, "pi answer acp-turn-session-1");
  assert.deepEqual(run1.usage, {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    totalTokens: 17,
    scope: "run",
    partial: false,
  });
  const firstEvents = service.logs(first.id, { stream: "events", runId: run1.id }).text;
  assert.match(firstEvents, /"type":"acp_initialized"/);
  assert.match(firstEvents, /"type":"acp_session","action":"new"/);
  assert.match(firstEvents, /"type":"acp_config","configId":"model"/);
  assert.match(firstEvents, /"type":"acp_config","configId":"thought_level"/);
  assert.match(firstEvents, /"type":"acp_prompt_result"/);
  assert.match(firstEvents, /"type":"acp_closed"/);

  // Second turn reports distinct usage; first turn's usage must not be double-counted.
  const offsetBeforeRun2 = fs.statSync(run1.nativeSessionFile!).size;
  env.TEST_USAGE_JSON = JSON.stringify({
    input: 25,
    output: 9,
    cacheRead: 5,
    cacheWrite: 0,
    totalTokens: 39,
  });
  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "follow-up turn",
    effort: "xhigh",
    requestId: "acp-turn-2",
  });
  const second = await waitStatus(service, first.id, ["completed"]);
  const run2 = second.latestRun!;
  assert.equal(run2.nativeProtocol, "acp");
  assert.equal(run2.nativeSessionId, "acp-turn-session-1");
  assert.equal(run2.nativeSessionFile, run1.nativeSessionFile);
  assert.equal(run2.piTranscriptOffset, offsetBeforeRun2);
  assert.deepEqual(run2.usage, {
    inputTokens: 25,
    outputTokens: 9,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    totalTokens: 39,
    scope: "run",
    partial: false,
  });
  const secondEvents = service.logs(first.id, { stream: "events", runId: run2.id }).text;
  assert.match(secondEvents, /"type":"acp_session","action":"resume"/);
});

test("legacy Pi JSON sessions stay on the original --print --mode json path on resume", async (t) => {
  const root = temporaryRoot("worker-pi-legacy-resume-");
  const { service, data, project, env } = createService(t, root, {
    TEST_SESSION_ID: "legacy-pi-session",
  });
  const legacySessionsRoot = path.join(data, "sessions", "pi");
  fs.mkdirSync(legacySessionsRoot, { recursive: true });
  const legacyFile = path.join(legacySessionsRoot, "legacy-run-1.jsonl");
  fs.writeFileSync(
    legacyFile,
    JSON.stringify({ type: "session", id: "legacy-pi-session", cwd: project }) + "\n",
  );

  const worker: WorkerRecord = {
    id: "worker-legacy-pi",
    type: "pi",
    configId: "pi-default",
    configName: "pi default",
    taskName: "legacy json pi",
    ownerId: "owner-1",
    parentSessionId: "parent-1",
    projectId: "project-1",
    projectPath: project,
    writePaths: [],
    workspace: { mode: "existing", path: project },
    cwd: project,
    createdAt: new Date().toISOString(),
    latestRun: null,
  };
  const legacyRun: WorkerRun = {
    id: "legacy-run-1",
    workerId: worker.id,
    requestId: "legacy-start-1",
    status: "completed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    model: "legacy/model",
    provider: null,
    effort: "high",
    timeoutSeconds: 600,
    home: env.PI_CODING_AGENT_DIR!,
    sessionsRoot: legacySessionsRoot,
    nativeSessionId: "legacy-pi-session",
    nativeSessionFile: legacyFile,
    exitCode: 0,
    finalText: "legacy turn 1",
    error: null,
    usage: null,
    progress: {
      steps: 1,
      phase: "completed",
      currentTool: null,
      lastEventAt: null,
      softReminderSentAt: null,
      hardTimeoutAt: null,
    },
  };
  service.store.createWorker(
    worker,
    legacyRun,
    "parent-1\u0000project-1",
    "legacy-start-1",
    "start",
    "legacy-fp",
  );

  // Legacy JSON resume still accepts legacy `max` thinking and invokes `pi` (not `pi-acp`).
  const resumed = await service.resume("owner-1", {
    workerId: worker.id,
    prompt: "continue legacy json session",
    effort: "max",
    requestId: "legacy-resume-1",
  });
  const done = await waitStatus(service, worker.id, ["completed"]);
  const run2 = done.latestRun!;
  assert.equal(run2.id, resumed.run.id);
  assert.equal(run2.nativeProtocol, undefined);
  assert.equal(run2.nativeSessionId, "legacy-pi-session");
  assert.equal(run2.nativeSessionFile, legacyFile);
  assert.equal(run2.finalText, "pi answer legacy-pi-session");
  const spec = JSON.parse(
    fs.readFileSync(path.join(data, "logs", worker.id, run2.id, "spec.json"), "utf8"),
  ) as { argv: string[]; acp?: unknown };
  assert.equal(spec.acp, undefined);
  assert.equal(spec.argv[0], path.resolve(piFixture));
  assert.ok(spec.argv.includes("--session-dir"));
  assert.ok(spec.argv.includes("--session"));
  assert.ok(spec.argv.includes("max"));
});

test("unsupported ACP configs fail explicitly instead of silently downgrading", async (t) => {
  const root = temporaryRoot("worker-pi-acp-config-");
  const { service, env } = createService(t, root);

  // 1. Settings and admission reject `max` for new Pi configs/runs.
  assert.throws(
    () =>
      service.updateSettings({
        configs: service.settings().configs.map((config) =>
          config.type === "pi" ? { ...config, effort: "max" } : config,
        ),
        defaultConfigId: service.settings().defaultConfigId,
      }),
    /thinking/,
  );
  await assert.rejects(
    () =>
      service.start(
        "owner-1",
        startInput({ type: "pi", effort: "max", requestId: "reject-max-start" }),
      ),
    /max/,
  );

  // Pre-existing stored config with `effort: "max"` also fails explicitly at start.
  const current = service.settings();
  service.store.saveSettings({
    schemaVersion: 2,
    configs: current.configs.map((config) =>
      config.type === "pi" ? { ...config, effort: "max" } : config,
    ),
    defaultConfigId: current.defaultConfigId,
    retentionDays: current.retentionDays,
    softReminderSeconds: current.softReminderSeconds,
    softReminderSteps: current.softReminderSteps,
  });
  await assert.rejects(
    () => service.start("owner-1", startInput({ type: "pi", requestId: "stored-max" })),
    /max/,
  );
  service.store.saveSettings({
    schemaVersion: 2,
    configs: current.configs,
    defaultConfigId: current.defaultConfigId,
    retentionDays: current.retentionDays,
    softReminderSeconds: current.softReminderSeconds,
    softReminderSteps: current.softReminderSteps,
  });

  // 2. Runtime thought_level downgrade (xhigh -> high) fails before sending session/prompt.
  env.TEST_SCENARIO = "downgrade-effort";
  const clamped = await service.start(
    "owner-1",
    startInput({ type: "pi", effort: "xhigh", requestId: "clamped-effort" }),
  );
  const clampedDone = await waitStatus(service, clamped.worker.id, ["failed"]);
  assert.equal(clampedDone.latestRun?.error?.code, "ACP_CONFIG_UNSUPPORTED");
  assert.match(clampedDone.latestRun?.error?.message ?? "", /thought_level=xhigh/);
  assert.doesNotMatch(
    service.logs(clamped.worker.id, { stream: "events" }).text,
    /acp_prompt_result/,
  );

  // 3. Runtime model rejection and model downgrade both fail explicitly.
  env.TEST_SCENARIO = "reject-model";
  const rejectedModel = await service.start(
    "owner-1",
    startInput({ type: "pi", model: "dummy/missing", requestId: "reject-model" }),
  );
  const rejectedDone = await waitStatus(service, rejectedModel.worker.id, ["failed"]);
  assert.equal(rejectedDone.latestRun?.error?.code, "ACP_CONFIG_UNSUPPORTED");
  assert.match(rejectedDone.latestRun?.error?.message ?? "", /Model not found/);

  env.TEST_SCENARIO = "downgrade-model";
  const downgradedModel = await service.start(
    "owner-1",
    startInput({ type: "pi", model: "dummy/requested", requestId: "downgrade-model" }),
  );
  const downgradedDone = await waitStatus(service, downgradedModel.worker.id, ["failed"]);
  assert.equal(downgradedDone.latestRun?.error?.code, "ACP_CONFIG_UNSUPPORTED");
  assert.match(downgradedDone.latestRun?.error?.message ?? "", /model=dummy\/requested/);

  // 4. Auth error surfaces directly without being masked as missing transcript.
  env.TEST_SCENARIO = "auth-error";
  const auth = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "auth-error" }),
  );
  const authDone = await waitStatus(service, auth.worker.id, ["failed"]);
  assert.match(authDone.latestRun?.error?.message ?? "", /Authentication required/);
});

test("missing PATH pi-acp falls back to bundled @geohar/pi-acp via Node and preserves PATH precedence", async (t) => {
  // 1. Local dependency resolves cleanly from both source and bundled dist/server.mjs locations,
  //    and returns null in an isolated directory without node_modules.
  const fromSource = resolveBundledPiAcpEntry();
  const fromDist = resolveBundledPiAcpEntry(
    pathToFileURL(path.join(pluginRoot, "dist", "server.mjs")).href,
  );
  assert.ok(fromSource && fs.existsSync(fromSource));
  assert.equal(fromDist, fromSource);
  assert.match(fromSource, /@geohar[\\/]+pi-acp[\\/]+dist[\\/]+index\.js$/);

  const isolated = temporaryRoot("worker-pi-acp-no-pkg-");
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  assert.equal(
    resolveBundledPiAcpEntry(pathToFileURL(path.join(isolated, "server.mjs")).href),
    null,
  );

  // 2. When PATH lacks pi-acp (and no pi-acp override is injected), WorkerService launches the
  //    real bundled @geohar/pi-acp JS entry with process.execPath instead of falling back to pi.
  const fallbackRoot = temporaryRoot("worker-pi-acp-bundled-fallback-");
  const emptyBin = path.join(fallbackRoot, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  const { service, data } = createService(
    t,
    fallbackRoot,
    { PATH: emptyBin },
    { executablePaths: { pi: piFixture } },
  );
  const started = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "bundled-pi-acp" }),
  );
  // Real @geohar/pi-acp completes ACP initialize with no model call, then fails because no
  // `pi` CLI exists on emptyBin PATH (or auth is missing); never falls back to legacy JSON pi.
  const settled = await waitStatus(service, started.worker.id, ["failed"], 15_000);
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(data, "logs", started.worker.id, settled.latestRun!.id, "spec.json"),
      "utf8",
    ),
  ) as { argv: string[]; acp?: unknown };
  assert.deepEqual(spec.argv, [process.execPath, fromSource]);
  assert.ok(spec.acp);
  const events = service.logs(started.worker.id, {
    stream: "events",
    runId: settled.latestRun!.id,
  }).text;
  assert.match(events, /"type":"acp_initialized"/);
  assert.match(events, /"@geohar\/pi-acp"/);
  assert.match(events, /"version":"0\.4\.0"/);

  // 3. A user-installed `pi-acp` on PATH takes precedence over the bundled dependency fallback.
  const pathRoot = temporaryRoot("worker-pi-acp-path-wins-");
  const userBin = path.join(pathRoot, "user-bin");
  fs.mkdirSync(userBin, { recursive: true });
  const userPiAcp = path.join(userBin, "pi-acp");
  fs.writeFileSync(
    userPiAcp,
    `#!/bin/sh\nexec "${process.execPath}" "${piAcpFixture}" "$@"\n`,
    { mode: 0o755 },
  );
  const { service: pathService, data: pathData } = createService(
    t,
    pathRoot,
    { PATH: userBin, TEST_SESSION_ID: "path-wins-session" },
    { executablePaths: { pi: piFixture } },
  );
  const pathRun = await pathService.start(
    "owner-1",
    startInput({ type: "pi", requestId: "path-wins-pi-acp" }),
  );
  const pathDone = await waitStatus(pathService, pathRun.worker.id, ["completed"], 10_000);
  const pathSpec = JSON.parse(
    fs.readFileSync(
      path.join(pathData, "logs", pathRun.worker.id, pathDone.latestRun!.id, "spec.json"),
      "utf8",
    ),
  ) as { argv: string[] };
  assert.deepEqual(pathSpec.argv, [path.resolve(userPiAcp)]);
});

test("Pi ACP catches swallowed model errors via transcript on both new and resumed turns", async (t) => {
  const root = temporaryRoot("worker-pi-acp-swallow-");
  const { service, env } = createService(t, root, {
    TEST_SESSION_ID: "swallow-session-1",
    TEST_SCENARIO: "swallow-error",
  });

  // Turn 1 swallows a 400 error as ACP end_turn -> must FAIL, never false success.
  const first = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "swallow-1" }),
  );
  const firstDone = await waitStatus(service, first.worker.id, ["failed"]);
  assert.equal(firstDone.latestRun?.exitCode, 0);
  assert.equal(firstDone.latestRun?.error?.code, "NATIVE_FAILED");
  assert.match(firstDone.latestRun?.error?.message ?? "", /swallowed upstream model error/);

  // Resume the same session when the model recovers -> succeeds with only turn 2's usage.
  env.TEST_SCENARIO = "ok";
  await service.resume("owner-1", {
    workerId: first.worker.id,
    prompt: "retry after upstream error",
    requestId: "swallow-2-ok",
  });
  const recovered = await waitStatus(service, first.worker.id, ["completed"]);
  assert.equal(recovered.latestRun?.finalText, "pi answer swallow-session-1");

  // Resume again and swallow another error -> must NOT inherit turn 2's stopReason: "stop"!
  env.TEST_SCENARIO = "swallow-error";
  await service.resume("owner-1", {
    workerId: first.worker.id,
    prompt: "fail on turn 3",
    requestId: "swallow-3-fail",
  });
  const thirdFailed = await waitStatus(service, first.worker.id, ["failed"]);
  assert.equal(thirdFailed.latestRun?.error?.code, "NATIVE_FAILED");
  assert.match(thirdFailed.latestRun?.error?.message ?? "", /swallowed upstream model error/);

  // Retries that all fail (with context_edit removing each failed assistant entry) still fail.
  env.TEST_SCENARIO = "retry-all-fail";
  await service.resume("owner-1", {
    workerId: first.worker.id,
    prompt: "fail all retries",
    requestId: "swallow-4-retry-fail",
  });
  const retryFail = await waitStatus(service, first.worker.id, ["failed"]);
  assert.match(retryFail.latestRun?.error?.message ?? "", /500: upstream unavailable/);

  // Retry that eventually recovers succeeds and uses authoritative transcript text + summed usage.
  env.TEST_SCENARIO = "retry-then-ok";
  await service.resume("owner-1", {
    workerId: first.worker.id,
    prompt: "transient retry then ok",
    requestId: "swallow-5-retry-ok",
  });
  const retryOk = await waitStatus(service, first.worker.id, ["completed"]);
  assert.equal(retryOk.latestRun?.finalText, "recovered answer swallow-session-1");
  assert.deepEqual(retryOk.latestRun?.usage, {
    inputTokens: 13,
    outputTokens: 4,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    totalTokens: 18,
    scope: "run",
    partial: false,
  });
});

test("unconfirmable transcript path or state always prevents false success", async (t) => {
  const root = temporaryRoot("worker-pi-acp-unconfirmed-");
  const { service, env } = createService(t, root);

  for (const [scenario, sessionId] of [
    ["missing-transcript", "unconf-missing"],
    ["ambiguous-transcript", "unconf-ambiguous"],
    ["corrupt-transcript", "unconf-corrupt"],
    ["no-assistant-transcript", "unconf-no-assistant"],
  ] as const) {
    env.TEST_SCENARIO = scenario;
    env.TEST_SESSION_ID = sessionId;
    const started = await service.start(
      "owner-1",
      startInput({ type: "pi", requestId: "req-" + scenario }),
    );
    const failed = await waitStatus(service, started.worker.id, ["failed"]);
    assert.equal(
      failed.latestRun?.error?.code,
      "PI_TRANSCRIPT_UNCONFIRMED",
      `${scenario} must fail with PI_TRANSCRIPT_UNCONFIRMED`,
    );
  }

  // Missing transcriptOffset on a resumed ACP run must also refuse false success.
  const eventsFile = path.join(root, "resume-events.log");
  const sessionsRoot = path.join(root, "pi-home", "sessions");
  const cwd = path.join(root, "project");
  const transcript = path.join(sessionsRoot, "dir", "2026-11-24_s-offset.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "session", version: 3, id: "s-offset", cwd }),
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({
        type: "message",
        id: "a1",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } },
      }),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    eventsFile,
    [
      JSON.stringify({ protocol: "acp", type: "acp_initialized", protocolVersion: 1, agentInfo: null, agentCapabilities: {} }),
      JSON.stringify({ protocol: "acp", type: "acp_session", action: "resume", sessionId: "s-offset", cwd, configOptions: [], startupInfo: null }),
      JSON.stringify({ protocol: "acp", type: "acp_prompt_result", sessionId: "s-offset", stopReason: "end_turn", result: { stopReason: "end_turn" } }),
    ].join("\n") + "\n",
  );
  const parsed = parsePiAcp(eventsFile, "s-offset", cwd, {
    sessionsRoot,
    sessionFile: transcript,
    transcriptOffset: null,
  });
  assert.equal(parsed.success, false);
  assert.equal(parsed.errorCode, "PI_TRANSCRIPT_UNCONFIRMED");
});

test("Pi ACP cancel preserves partial run usage and allows subsequent ACP resume", async (t) => {
  const root = temporaryRoot("worker-pi-acp-cancel-usage-");
  const { service, env } = createService(t, root, {
    TEST_SESSION_ID: "cancel-usage-session",
    TEST_SCENARIO: "cancel-with-usage",
  });

  const started = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "cancel-usage-1" }),
  );
  await waitStatus(service, started.worker.id, ["running"]);
  await waitFor(
    () => service.get(started.worker.id).worker.latestRun?.nativeSessionFile,
    (file) => Boolean(file && fs.existsSync(file)),
  );
  await service.cancel({ workerIds: [started.worker.id] }, "ui");
  const cancelled = service.get(started.worker.id).worker.latestRun!;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.nativeSessionId, "cancel-usage-session");
  assert.deepEqual(cancelled.usage, {
    inputTokens: 5,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 7,
    scope: "run",
    partial: true,
  });

  env.TEST_SCENARIO = "ok";
  await service.resume("owner-1", {
    workerId: started.worker.id,
    prompt: "continue after cancel",
    requestId: "cancel-usage-2",
  });
  const resumed = await waitStatus(service, started.worker.id, ["completed"]);
  assert.equal(resumed.latestRun?.nativeSessionId, "cancel-usage-session");
  assert.equal(resumed.latestRun?.finalText, "pi answer cancel-usage-session");
});

test("concurrent Pi ACP workers in the same cwd stay isolated even if session-map.json is wiped", async (t) => {
  const root = temporaryRoot("worker-pi-acp-concurrent-");
  const { service, env } = createService(t, root, {
    TEST_SCENARIO: "wipe-session-map",
  });
  // Unset fixed TEST_SESSION_ID so each concurrent worker generates its own unique UUID.
  delete env.TEST_SESSION_ID;

  const starts = await Promise.all([
    service.start("owner-1", startInput({ type: "pi", requestId: "conc-1" })),
    service.start("owner-1", startInput({ type: "pi", requestId: "conc-2" })),
    service.start("owner-1", startInput({ type: "pi", requestId: "conc-3" })),
  ]);
  const finished = await Promise.all(
    starts.map((item) => waitStatus(service, item.worker.id, ["completed"])),
  );
  const ids = new Set(finished.map((worker) => worker.latestRun?.nativeSessionId));
  const files = new Set(finished.map((worker) => worker.latestRun?.nativeSessionFile));
  assert.equal(ids.size, 3);
  assert.equal(files.size, 3);
  for (const worker of finished) {
    assert.equal(
      worker.latestRun?.finalText,
      "pi answer " + worker.latestRun?.nativeSessionId,
    );
  }

  // All 3 sessions can still resume even though session-map.json was wiped.
  env.TEST_SCENARIO = "ok";
  await Promise.all(
    finished.map((worker, index) =>
      service.resume("owner-1", {
        workerId: worker.id,
        prompt: "resume " + index,
        requestId: "conc-resume-" + index,
      }),
    ),
  );
  const resumed = await Promise.all(
    finished.map((worker) => waitStatus(service, worker.id, ["completed"])),
  );
  for (let i = 0; i < finished.length; i++) {
    assert.equal(
      resumed[i]!.latestRun?.nativeSessionId,
      finished[i]!.latestRun?.nativeSessionId,
    );
    assert.equal(
      resumed[i]!.latestRun?.nativeSessionFile,
      finished[i]!.latestRun?.nativeSessionFile,
    );
  }
});

test("native retention leaves a non-default PI_CODING_AGENT_DIR untouched", (t) => {
  const root = temporaryRoot("worker-pi-acp-retention-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const home = path.join(root, "home");
  const customAgentDir = path.join(root, "custom-pi-agent");
  const env = { HOME: home, PI_CODING_AGENT_DIR: customAgentDir };
  const roots = nativeSessionRoots(data, env).map((item) => item.directory);
  assert.ok(!roots.includes(path.resolve(path.join(customAgentDir, "sessions"))));
  assert.ok(roots.includes(path.resolve(path.join(home, ".pi", "agent", "sessions"))));
  assert.ok(roots.includes(path.resolve(path.join(data, "sessions", "pi"))));

  const now = Date.parse("2026-11-24T12:00:00.000Z");
  const oldTime = new Date(now - 3 * DAY - 1000);
  const encodedDir = path.join(customAgentDir, "sessions", "--tmp-project--");
  fs.mkdirSync(encodedDir, { recursive: true });
  const activeFile = path.join(encodedDir, "2026-11-20_active-sid.jsonl");
  const staleFile = path.join(encodedDir, "2026-11-20_stale-sid.jsonl");
  fs.writeFileSync(activeFile, "{}\n");
  fs.writeFileSync(staleFile, "{}\n");
  fs.utimesSync(activeFile, oldTime, oldTime);
  fs.utimesSync(staleFile, oldTime, oldTime);

  const summary = sweepNativeSessions({
    dataDirectory: data,
    environment: env,
    now,
    activeRuns: [
      {
        type: "pi",
        sessionsRoot: path.join(customAgentDir, "sessions"),
        nativeSessionId: "active-sid",
        nativeSessionFile: activeFile,
      },
    ],
  });
  // The custom directory is outside the supported default roots and is never swept.
  assert.equal(summary.deleted, 0);
  assert.equal(fs.existsSync(activeFile), true);
  assert.equal(fs.existsSync(staleFile), true);
});

test("ACP protocol handles server requests without deadlock and rejects malformed stdout or missing resume capability", async (t) => {
  const root = temporaryRoot("worker-pi-acp-proto-");
  const { service } = createService(t, root, {
    TEST_SESSION_ID: "proto-session-1",
    TEST_SCENARIO: "server-request",
  });

  const serverReq = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "proto-server-req" }),
  );
  const ok = await waitStatus(service, serverReq.worker.id, ["completed"]);
  assert.equal(ok.latestRun?.finalText, "pi answer proto-session-1");

  // Capabilities are fixed at process initialization, so exercise the missing-resume path on a
  // fresh service whose shared Pi ACP process initialized without it.
  const noResumeRoot = temporaryRoot("worker-pi-acp-no-resume-");
  const { service: noResumeService, env: noResumeEnv } = createService(t, noResumeRoot, {
    TEST_SESSION_ID: "proto-session-2",
    TEST_SCENARIO: "no-resume-cap",
  });
  const fresh = await noResumeService.start(
    "owner-1",
    startInput({ type: "pi", requestId: "proto-no-resume-start" }),
  );
  const freshDone = await waitStatus(noResumeService, fresh.worker.id, ["completed"]);
  await noResumeService.resume("owner-1", {
    workerId: freshDone.id,
    prompt: "resume without capability",
    requestId: "proto-no-resume",
  });
  const noResume = await waitStatus(noResumeService, freshDone.id, ["failed"]);
  assert.equal(noResume.latestRun?.error?.code, "ACP_CONFIG_UNSUPPORTED");
  assert.match(noResume.latestRun?.error?.message ?? "", /session\/resume/);

  noResumeEnv.TEST_SCENARIO = "bad-json";
  const badJson = await noResumeService.start(
    "owner-1",
    startInput({ type: "pi", requestId: "proto-bad-json" }),
  );
  const badDone = await waitStatus(noResumeService, badJson.worker.id, ["failed"]);
  assert.equal(badDone.latestRun?.error?.code, "PROTOCOL_INVALID");
});

test("hard timeout survives an ACP server that ignores cancel and leaves siblings running", async (t) => {
  const root = temporaryRoot("worker-pi-acp-ignore-cancel-");
  const { service } = createService(t, root);
  service.updateSettings({ concurrency: { pi: 2 } });
  const settings = service.settings();
  service.updateSettings({
    configs: settings.configs.map((config) => ({ ...config, hardTimeoutSeconds: 1 })),
    defaultConfigId: settings.defaultConfigId,
  });

  const stuck = await service.start(
    "owner-1",
    startInput({
      requestId: "ignore-cancel-stuck",
      prompt: "[scenario:ignore-cancel] never cancel",
    }),
  );
  await waitStatus(service, stuck.worker.id, ["running"]);
  const sibling = await service.start(
    "owner-1",
    startInput({ requestId: "ignore-cancel-sibling", prompt: "finish anyway" }),
  );
  const done = await waitStatus(service, sibling.worker.id, ["completed"]);
  assert.equal(done.latestRun?.status, "completed");

  const unresolved = await waitStatus(service, stuck.worker.id, ["unknown"]);
  assert.equal(unresolved.latestRun?.status, "unknown");
  assert.equal(unresolved.latestRun?.error?.code, "STOP_UNCONFIRMED");
});

test("an unanswered session/new obeys the hard timeout and leaves the shared process usable", async (t) => {
  const root = temporaryRoot("worker-pi-acp-setup-timeout-");
  const spawnLog = path.join(root, "pi-acp-setup-spawn.log");
  const { service, data } = createService(t, root, {
    TEST_SCENARIO: "setup-hang",
    TEST_SPAWN_LOG_FILE: spawnLog,
  });
  const settings = service.settings();
  service.updateSettings({
    configs: settings.configs.map((config) => ({ ...config, hardTimeoutSeconds: 1 })),
    defaultConfigId: settings.defaultConfigId,
  });

  const stuck = await service.start(
    "owner-1",
    startInput({ requestId: "setup-hang", prompt: "never opens" }),
  );
  const stopped = await waitStatus(service, stuck.worker.id, ["failed"], 10000);
  assert.equal(stopped.latestRun?.error?.code, "TIMEOUT");
  const runDirectory = path.join(data, "logs", stuck.worker.id, stopped.latestRun!.id);
  const evidence = JSON.parse(fs.readFileSync(path.join(runDirectory, "final.json"), "utf8"));
  assert.equal(evidence.promptStarted, false);
  assert.equal(evidence.sessionClosed, true);
  const events = service.logs(stuck.worker.id, {
    stream: "events",
    runId: stopped.latestRun!.id,
  }).text;
  assert.doesNotMatch(events, /"type":"acp_prompt_result"/);

  // The setup stop scoped only this session; the same shared process must serve a sibling.
  const sibling = await service.start(
    "owner-1",
    startInput({ requestId: "setup-sibling", prompt: "finish after setup timeout" }),
  );
  const done = await waitStatus(service, sibling.worker.id, ["completed"], 10000);
  assert.equal(done.latestRun?.status, "completed");
  const pids = fs.readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(pids.length, 1);
});

test("an unconfirmed prompt stays unknown until its guardian generation exits, then queued work starts", async (t) => {
  const root = temporaryRoot("worker-pi-acp-unconfirmed-queue-");
  const spawnLog = path.join(root, "pi-acp-unconfirmed-spawn.log");
  const { service } = createService(t, root, {
    TEST_SPAWN_LOG_FILE: spawnLog,
    CLOUDCLI_WORKER_ACP_IDLE_TIMEOUT_SECONDS: "1",
  });
  const settings = service.settings();
  service.updateSettings({
    configs: settings.configs.map((config) => ({
      ...config,
      hardTimeoutSeconds: 1,
      concurrency: 1,
    })),
    defaultConfigId: settings.defaultConfigId,
  });

  const stuck = await service.start(
    "owner-1",
    startInput({
      requestId: "unconfirmed-stuck",
      prompt: "[scenario:ignore-cancel] never cancel",
    }),
  );
  const queued = await service.start(
    "owner-1",
    startInput({ requestId: "unconfirmed-queued", prompt: "start after group exit" }),
  );
  const unknown = await waitStatus(service, stuck.worker.id, ["unknown"], 12000);
  assert.equal(unknown.latestRun?.error?.code, "STOP_UNCONFIRMED");
  assert.equal(service.get(queued.worker.id).worker.latestRun?.status, "queued");

  // The exact provider generation is confirmed gone, so the unknown turn settles as a timeout
  // and only then may the concurrency-1 queue launch replacement work.
  const confirmed = await waitStatus(service, stuck.worker.id, ["failed"], 15000);
  assert.equal(confirmed.latestRun?.error?.code, "TIMEOUT");
  const done = await waitStatus(service, queued.worker.id, ["completed"], 15000);
  assert.equal(done.latestRun?.status, "completed");
  const pids = fs.readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(pids.length, 2);
  assert.equal(processAlive(Number(pids[0])), false);
});

test("shared Pi ACP process stays lazy and serves separate projects with one PID", async (t) => {
  const root = temporaryRoot("worker-pi-acp-shared-");
  const spawnLog = path.join(root, "pi-acp-spawn.log");
  const { service } = createService(t, root, {
    TEST_SPAWN_LOG_FILE: spawnLog,
    TEST_DELAY_MS: "1500",
  });
  const secondProject = path.join(root, "project-2");
  fs.mkdirSync(secondProject, { recursive: true });
  service.updateSettings({ concurrency: { pi: 2 } });
  service.registerOwner(
    {
      id: "owner-2",
      parentSessionId: "parent-2",
      projectId: "project-2",
      projectPath: secondProject,
      userId: 7,
      appServerInstanceId: "app-1",
      paused: false,
    },
    "owner-2-token",
  );

  // No task accepted yet, so the shared process must not be spawned.
  assert.equal(fs.existsSync(spawnLog), false);

  const blocked = await service.start(
    "owner-1",
    startInput({ requestId: "shared-hang", prompt: "[scenario:hang] hold the slot" }),
  );
  await waitStatus(service, blocked.worker.id, ["running"]);
  const finishing = await service.start(
    "owner-2",
    startInput({ requestId: "shared-ok", prompt: "[scenario:sleep] finish" }),
  );
  await waitStatus(service, finishing.worker.id, ["running"]);

  const pids = fs
    .readFileSync(spawnLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(pids.length, 1, "two projects must share exactly one Pi ACP process");

  // Cancel A while B is still running; B must finish on the same shared PID.
  await service.cancel({ workerIds: [blocked.worker.id] }, "host");
  await waitStatus(service, blocked.worker.id, ["cancelled"]);
  const done = await waitStatus(service, finishing.worker.id, ["completed"]);
  assert.equal(done.latestRun?.status, "completed");
  assert.equal(fs.readFileSync(spawnLog, "utf8").trim(), pids[0]);
});

test("service shutdown reaps a TERM-resistant shared ACP agent and its tool tree", async (t) => {
  const root = temporaryRoot("worker-pi-acp-shutdown-group-");
  const agentPidFile = path.join(root, "pi-acp-agent.pid");
  const toolPidFile = path.join(root, "pi-acp-tool.pid");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "hangtree",
    TEST_CLI_PID_FILE: agentPidFile,
    TEST_PID_FILE: toolPidFile,
  });

  await service.start("owner-1", startInput({ requestId: "shutdown-group", prompt: "hang" }));
  const pids = await waitFor(
    () => {
      if (!fs.existsSync(agentPidFile) || !fs.existsSync(toolPidFile)) return null;
      return [
        Number(fs.readFileSync(agentPidFile, "utf8")),
        Number(fs.readFileSync(toolPidFile, "utf8")),
      ];
    },
    (value) => Array.isArray(value) && value.every((pid) => Number.isInteger(pid) && pid > 0),
  );
  assert.ok(pids!.every(processAlive), "agent and tool should be running before shutdown");

  await service.close();
  await waitFor(
    () => pids!.every((pid) => !processAlive(pid)),
    (dead) => dead,
    15_000,
  );
});

test("a failed shared ACP connection reaps a TERM-resistant agent before returning", async (t) => {
  const root = temporaryRoot("worker-pi-acp-bad-handshake-");
  const agentPidFile = path.join(root, "pi-acp-agent.pid");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "corrupt-stay-alive",
    TEST_CLI_PID_FILE: agentPidFile,
  });

  await service.start("owner-1", startInput({ type: "pi", requestId: "bad-handshake" }));
  const pid = (await waitFor(
    () => (fs.existsSync(agentPidFile) ? Number(fs.readFileSync(agentPidFile, "utf8")) : null),
    (value) => typeof value === "number" && value > 0,
  ))!;
  await waitFor(() => !processAlive(pid), (dead) => dead, 15_000);
});

test("a late session/new after setup settles skips config RPCs and closes only its own session", async (t) => {
  const root = temporaryRoot("worker-pi-acp-late-setup-");
  const rpcLog = path.join(root, "rpc.jsonl");
  const spawnLog = path.join(root, "spawn.log");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "setup-delay",
    TEST_DELAY_MS: "1500",
    TEST_SESSION_ID: "late-setup-session",
    TEST_RPC_LOG_FILE: rpcLog,
    TEST_SPAWN_LOG_FILE: spawnLog,
  });
  const settings = service.settings();
  service.updateSettings({
    configs: settings.configs.map((config) => ({ ...config, hardTimeoutSeconds: 1 })),
    defaultConfigId: settings.defaultConfigId,
  });

  const timedOut = await service.start(
    "owner-1",
    startInput({
      type: "pi",
      model: "provider/model-a",
      effort: "high",
      requestId: "late-setup-timeout",
    }),
  );
  const settled = await waitStatus(service, timedOut.worker.id, ["failed"], 10_000);
  assert.equal(settled.latestRun?.error?.code, "TIMEOUT");

  // Wait for the late session/new response to arrive and trigger session/close.
  await waitFor(
    () =>
      fs.existsSync(rpcLog)
        ? fs
            .readFileSync(rpcLog, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { method: string; sessionId: string | null })
        : [],
    (entries) =>
      entries.some(
        (entry) => entry.method === "session/close" && entry.sessionId === "late-setup-session",
      ),
    10_000,
  );
  const rpcs = fs
    .readFileSync(rpcLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; sessionId: string | null });
  assert.equal(
    rpcs.some(
      (entry) =>
        entry.method === "session/set_config_option" &&
        entry.sessionId === "late-setup-session",
    ),
    false,
    "settled setup must not issue config RPCs after late session/new resolves",
  );
  assert.equal(
    rpcs.some(
      (entry) => entry.method === "session/prompt" && entry.sessionId === "late-setup-session",
    ),
    false,
  );

  // The same shared process stays healthy for a follow-up run.
  const followUp = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "late-setup-followup" }),
  );
  const done = await waitStatus(service, followUp.worker.id, ["completed"], 10_000);
  assert.equal(done.latestRun?.status, "completed");
  assert.equal(
    fs.readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).length,
    1,
  );
});

test("two consecutive idle recycles clean up shared ACP guardian directories without accumulating", async (t) => {
  const root = temporaryRoot("worker-pi-acp-guardian-cleanup-");
  const spawnLog = path.join(root, "spawn.log");
  const { service, data } = createService(t, root, {
    CLOUDCLI_WORKER_ACP_IDLE_TIMEOUT_SECONDS: "1",
    TEST_SPAWN_LOG_FILE: spawnLog,
  });
  const guardianRoot = path.join(data, "pi-acp-guardian");
  const guardianEntries = (): string[] =>
    fs.existsSync(guardianRoot) ? fs.readdirSync(guardianRoot) : [];
  const spawnPids = (): number[] =>
    fs.existsSync(spawnLog)
      ? fs
          .readFileSync(spawnLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(Number)
      : [];

  const first = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "idle-cleanup-1" }),
  );
  await waitStatus(service, first.worker.id, ["completed"], 10_000);
  const pid1 = (await waitFor(spawnPids, (pids) => pids.length === 1))[0]!;
  await waitFor(() => !processAlive(pid1), Boolean, 10_000);
  await waitFor(() => guardianEntries().length, (count) => count === 0, 5_000);

  const second = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "idle-cleanup-2" }),
  );
  await waitStatus(service, second.worker.id, ["completed"], 10_000);
  const pid2 = (await waitFor(spawnPids, (pids) => pids.length === 2))[1]!;
  assert.notEqual(pid2, pid1);
  await waitFor(() => !processAlive(pid2), Boolean, 10_000);
  await waitFor(() => guardianEntries().length, (count) => count === 0, 5_000);
});
