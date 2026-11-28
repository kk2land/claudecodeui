import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  nativeHome,
  parseAgy,
  prepareLaunch,
  trackProgress,
  newProgress,
} from "../server/native.js";
import type { WorkerConfig, WorkerRun } from "../shared/contracts.js";
import {
  createService,
  startInput,
  waitFor,
  temporaryRoot,
  waitStatus,
} from "./helpers.js";

function run(root: string, values: Partial<WorkerRun> = {}): WorkerRun {
  const homes = nativeHome("agy", path.join(root, "data"), {});
  return {
    id: "run-agy-1",
    workerId: "worker-agy-1",
    requestId: "request-agy-1",
    status: "starting",
    startedAt: null,
    finishedAt: null,
    model: null,
    provider: null,
    effort: null,
    timeoutSeconds: null,
    home: homes.home,
    sessionsRoot: homes.sessionsRoot,
    nativeSessionId: null,
    nativeSessionFile: null,
    exitCode: null,
    finalText: null,
    error: null,
    usage: null,
    progress: {
      steps: null,
      phase: null,
      currentTool: null,
      lastEventAt: null,
      softReminderSentAt: null,
      hardTimeoutAt: null,
    },
    ...values,
  };
}

function eventFile(root: string, events: unknown[]): string {
  const file = path.join(root, "events.log");
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return file;
}

function agyConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    id: "agy-default",
    name: "agy#1",
    type: "agy",
    enabled: true,
    roles: [],
    concurrency: 3,
    hardTimeoutSeconds: 600,
    model: null,
    effort: null,
    ...overrides,
  };
}


function init(id: string, cwd = process.cwd()) {
  return { event: "init", conversation_id: id, init: { cwd } };
}

function step(index: number, usage?: unknown) {
  return {
    event: "step_update",
    step_update: {
      conversation_id: "conversation-1",
      step_index: index,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "answer",
      ...(usage ? { usage } : {}),
    },
  };
}

function result(values: Record<string, unknown> = {}) {
  return {
    event: "result",
    result: {
      conversation_id: "conversation-1",
      status: "SUCCESS",
      response: "answer\n",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 15,
      },
      ...values,
    },
  };
}

test("agy prepares print/stream-json with prompt, model, effort and native continuation", () => {
  const root = temporaryRoot("worker-agy-argv-");
  const launch = prepareLaunch({
    type: "agy",
    run: run(root, {
      model: "gemini-3.8-flash-low",
      effort: "low",
      provider: "must-not-be-used",
    }),
    cwd: path.join(root, "project"),
    prompt: "line one\nline two",
    previous: null,
    dataDirectory: path.join(root, "data"),
    runDirectory: path.join(root, "run"),
    executable: "/bin/fake-agy",
    baseEnvironment: { PATH: "/usr/bin" },
  });
  assert.deepEqual(launch.argv, [
    "/bin/fake-agy",
    "--print=line one\nline two",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--model",
    "gemini-3.8-flash-low",
    "--effort",
    "low",
  ]);
  assert.equal(launch.expectedSessionId, null);
  assert.equal(launch.sessionFile, null);
  assert.deepEqual(launch.env, { PATH: "/usr/bin" });

  const previous = run(root, {
    nativeSessionId: "conversation-1",
    model: "gemini-3.8-flash-low",
    effort: "low",
  });
  const resumed = prepareLaunch({
    type: "agy",
    run: previous,
    cwd: path.join(root, "project"),
    prompt: "again",
    previous,
    dataDirectory: path.join(root, "data"),
    runDirectory: path.join(root, "run-2"),
    executable: "/bin/fake-agy",
    baseEnvironment: {},
  });
  assert.deepEqual(resumed.argv.slice(-2), ["--conversation", "conversation-1"]);
  assert.equal(resumed.expectedSessionId, "conversation-1");
});

test("parseAgy validates identity, cwd, result, denied actions and run-scoped usage", () => {
  const root = temporaryRoot("worker-agy-parse-");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });

  const ok = parseAgy(eventFile(root, [init("conversation-1", cwd), step(1, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 3,
    total_tokens: 15,
  }), result()]), null, cwd);
  assert.equal(ok.success, true);
  assert.equal(ok.nativeSessionId, "conversation-1");
  assert.equal(ok.nativeSessionFile, null);
  assert.equal(ok.finalText, "answer\n");
  assert.deepEqual(ok.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: null,
    totalTokens: 15,
    scope: "run",
    partial: true,
  });

  // A resumed run's result usage is conversation-cumulative; only step samples are run-scoped.
  const resumed = parseAgy(
    eventFile(root, [
      init("conversation-1", cwd),
      step(2, {
        input_tokens: 7,
        output_tokens: 2,
        cache_read_tokens: 0,
        total_tokens: 9,
      }),
      result({
        usage: {
          input_tokens: 17,
          output_tokens: 7,
          cache_read_tokens: 3,
          total_tokens: 24,
        },
      }),
    ]),
    "conversation-1",
    cwd,
  );
  assert.equal(resumed.success, true);
  assert.equal(resumed.nativeSessionId, "conversation-1");
  assert.equal(resumed.usage?.inputTokens, 7);
  assert.equal(resumed.usage?.totalTokens, 9);
  assert.equal(resumed.usage?.scope, "run");

  // No step samples: a new conversation's result is run scope, a resumed one is session scope.
  const fallback = parseAgy(eventFile(root, [init("conversation-2", cwd), result()]), null, cwd);
  assert.equal(fallback.usage?.scope, "run");
  assert.equal(fallback.usage?.inputTokens, 10);
  const fallbackResume = parseAgy(
    eventFile(root, [init("conversation-2", cwd), result()]),
    "conversation-2",
    cwd,
  );
  assert.equal(fallbackResume.usage?.scope, "session");

  const wrongId = parseAgy(
    eventFile(root, [init("conversation-other", cwd), result()]),
    "conversation-1",
    cwd,
  );
  assert.equal(wrongId.success, false);
  assert.equal(wrongId.nativeSessionId, null);
  assert.match(wrongId.error ?? "", /不同会话 ID/);

  const wrongCwd = parseAgy(eventFile(root, [init("conversation-1", "/") , result()]), null, cwd);
  assert.equal(wrongCwd.success, false);
  assert.match(wrongCwd.error ?? "", /工作目录/);

  const failure = parseAgy(
    eventFile(root, [init("conversation-1", cwd), result({ status: "ERROR", error: "invalid model" })]),
    null,
    cwd,
  );
  assert.equal(failure.success, false);
  assert.match(failure.error ?? "", /invalid model/);

  const denied = parseAgy(
    eventFile(root, [init("conversation-1", cwd), result({
      response: "",
      denied_actions: [{ action: "write_file" }],
    })]),
    null,
    cwd,
  );
  assert.equal(denied.success, false);
  assert.match(denied.error ?? "", /write_file/);

  const inconsistent = parseAgy(
    eventFile(root, [init("conversation-1", cwd), result({ conversation_id: "other" })]),
    null,
    cwd,
  );
  assert.equal(inconsistent.success, false);
  assert.equal(inconsistent.nativeSessionId, null);
  assert.match(inconsistent.error ?? "", /不一致/);

  const noResult = parseAgy(eventFile(root, [init("conversation-1", cwd)]), null, cwd);
  assert.equal(noResult.success, false);
  assert.match(noResult.error ?? "", /缺少 agy result/);
});

test("agy progress counts response and tool steps and tracks the active tool", () => {
  const progress = newProgress();
  const tool = (state: string) => ({
    event: "step_update",
    step_update: {
      conversation_id: "conversation-1",
      step_index: 2,
      state,
      step_type: "tool",
      tool_name: "run_command",
    },
  });
  trackProgress("agy", tool("ACTIVE"), progress);
  assert.equal(progress.currentTool, "run_command");
  trackProgress("agy", tool("DONE"), progress);
  assert.equal(progress.currentTool, null);
  assert.equal(progress.steps, 1);
  trackProgress("agy", step(3), progress);
  assert.equal(progress.steps, 2);
  trackProgress("agy", result(), progress);
  assert.equal(progress.phase, "result");
});

test("agy ACP starts and resumes an old conversation id with model, effort and run usage", async (t) => {
  const root = temporaryRoot("worker-agy-service-");
  const { service, data } = createService(t, root, {
    TEST_AGY_SESSION_ID: "conversation-agy-1",
    TEST_AGY_ACP_USAGE: JSON.stringify({
      inputTokens: 11,
      outputTokens: 6,
      cachedReadTokens: 2,
      cachedWriteTokens: 0,
      totalTokens: 17,
    }),
  });
  service.updateSettings({
    configs: [...service.settings().configs, agyConfig()],
    defaultConfigId: "agy-default",
  });
  const started = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-default",
      prompt: "reply with OK",
      model: "gemini-3.8-flash-low",
      effort: "low",
      requestId: "agy-start-1",
    }),
  );
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  const firstRun = first.latestRun!;
  assert.equal(firstRun.nativeSessionId, "conversation-agy-1");
  assert.equal(firstRun.nativeSessionFile, null);
  assert.match(firstRun.finalText ?? "", /model=gemini-3\.8-flash thought=low/);
  assert.deepEqual(firstRun.usage, {
    inputTokens: 11,
    outputTokens: 6,
    totalTokens: 17,
    scope: "run",
    partial: false,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
  });
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(data, "logs", started.worker.id, firstRun.id, "spec.json"),
      "utf8",
    ),
  ) as { argv: string[]; acp: { configOptions: unknown[] } };
  assert.ok(spec.argv.includes("acp"));
  assert.ok(spec.argv.includes("--dangerously-skip-permissions"));
  assert.deepEqual(spec.acp.configOptions, [
    { configId: "model", value: "gemini-3.8-flash", match: "model" },
    { configId: "thought_level", value: "low", match: "exact" },
  ]);

  const resumed = await service.resume("owner-1", {
    workerId: first.id,
    prompt: "reply again",
    requestId: "agy-resume-1",
  });
  const second = await waitStatus(service, first.id, ["completed"]);
  assert.notEqual(resumed.run.id, firstRun.id);
  assert.equal(second.latestRun?.nativeSessionId, "conversation-agy-1");
  assert.match(second.latestRun?.finalText ?? "", /model=gemini-3\.8-flash thought=low/);
  assert.deepEqual(second.latestRun?.usage, firstRun.usage);
  const events = fs
    .readFileSync(
      path.join(data, "logs", first.id, second.latestRun!.id, "events.log"),
      "utf8",
    )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const session = events.find((event) => event.type === "acp_session");
  assert.equal(session?.action, "resume");
  assert.equal(service.state().counts.agy.completed, 1);
});

test("two AGY projects share one ACP initialize across cwd", async (t) => {
  const root = temporaryRoot("worker-agy-shared-");
  const spawnLog = path.join(root, "spawn.log");
  const { service } = createService(t, root, {
    TEST_SPAWN_LOG_FILE: spawnLog,
  });
  service.updateSettings({
    configs: [...service.settings().configs, agyConfig({ concurrency: 2 })],
    defaultConfigId: "agy-default",
  });
  const project2 = path.join(root, "project-2");
  fs.mkdirSync(project2, { recursive: true });
  service.registerOwner(
    {
      id: "owner-2",
      parentSessionId: "parent-2",
      projectId: "project-2",
      projectPath: project2,
      userId: 8,
      appServerInstanceId: "app-2",
      paused: false,
    },
    "owner-token-2",
  );
  const first = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-default",
      prompt: "[scenario:sleep:300] first",
      model: "gemini-3.8-flash-low",
      requestId: "agy-shared-1",
    }),
  );
  const second = await service.start(
    "owner-2",
    startInput({
      type: "agy",
      configId: "agy-default",
      prompt: "[scenario:sleep:300] second",
      model: "gemini-4-neon-high",
      requestId: "agy-shared-2",
    }),
  );
  const a = await waitStatus(service, first.worker.id, ["completed"]);
  const b = await waitStatus(service, second.worker.id, ["completed"]);
  assert.match(a.latestRun?.finalText ?? "", /model=gemini-3\.8-flash thought=low/);
  assert.match(b.latestRun?.finalText ?? "", /model=gemini-4-neon thought=high/);
  assert.match(b.latestRun?.finalText ?? "", new RegExp("cwd=" + project2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const lines = fs.readFileSync(spawnLog, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "both projects must share exactly one AGY ACP PID");
  assert.match(lines[0]!, /^agy \d+$/);
});

test("cancelling one AGY ACP session leaves a sibling session running to completion", async (t) => {
  const root = temporaryRoot("worker-agy-cancel-");
  const spawnLog = path.join(root, "spawn.log");
  const { service } = createService(t, root, {
    TEST_SPAWN_LOG_FILE: spawnLog,
  });
  service.updateSettings({
    configs: [...service.settings().configs, agyConfig({ concurrency: 2 })],
    defaultConfigId: "agy-default",
  });
  const first = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-default",
      prompt: "[scenario:sleep:30000] stay",
      requestId: "agy-cancel-1",
    }),
  );
  const second = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-default",
      prompt: "[scenario:sleep:300] finish",
      requestId: "agy-cancel-2",
    }),
  );
  await waitStatus(service, second.worker.id, ["completed"]);
  await service.cancel({ workerIds: [first.worker.id] }, "ui", "owner-1");
  const cancelled = await waitStatus(service, first.worker.id, ["cancelled"]);
  assert.equal(cancelled.latestRun?.status, "cancelled");
  assert.equal(fs.readFileSync(spawnLog, "utf8").trim().split("\n").length, 1);
});

test("agy ACP raw JSON-RPC 429 cools the run's pool", async (t) => {
  const root = temporaryRoot("worker-agy-429-");
  const { service } = createService(t, root, { TEST_AGY_SESSION_ID: "agy-429" });
  service.updateSettings({
    configs: [...service.settings().configs, agyConfig()],
    defaultConfigId: "agy-default",
  });
  const started = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-default",
      prompt: "[scenario:rate-limit] limited",
      requestId: "agy-429-start",
    }),
  );
  const failed = await waitStatus(service, started.worker.id, ["failed"]);
  assert.equal(failed.latestRun?.status, "failed");
  assert.ok(service.agyCooldownUntil());
  assert.deepEqual(
    service.overview().agyCooldowns?.map((cooldown) => cooldown.group),
    ["gemini"],
  );
  // A cooled pool refuses the next start before it allocates a worker or a run.
  await assert.rejects(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-default", requestId: "agy-429-next" }),
    ),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "AGY_QUOTA_REACHED");
      return true;
    },
  );
});

test("Pi CLI and AGY ACP can run at the same time", async (t) => {
  const root = temporaryRoot("worker-agy-pi-parallel-");
  const spawnLog = path.join(root, "agy-spawn.log");
  const piPidFile = path.join(root, "pi.pid");
  const { service, env } = createService(t, root, {
    TEST_SCENARIO: "hang",
    TEST_CLI_PID_FILE: piPidFile,
    TEST_SPAWN_LOG_FILE: spawnLog,
  });
  service.updateSettings({
    configs: [...service.settings().configs, agyConfig({ concurrency: 2 })],
    defaultConfigId: "agy-default",
  });
  assert.equal(fs.existsSync(spawnLog), false);

  const pi = await service.start("owner-1", startInput({ type: "pi", requestId: "parallel-pi" }));
  await waitFor(() => fs.existsSync(piPidFile), Boolean);
  const piPid = Number(fs.readFileSync(piPidFile, "utf8"));
  env.TEST_SCENARIO = "ok";
  const agy = await service.start("owner-1", startInput({
    type: "agy",
    configId: "agy-default",
    prompt: "[scenario:sleep:1500] agy",
    requestId: "parallel-agy",
  }));
  await waitStatus(service, agy.worker.id, ["running"]);
  const agyPid = Number(fs.readFileSync(spawnLog, "utf8").trim().split(" ")[1]);
  assert.notEqual(piPid, agyPid);
  assert.equal(service.get(pi.worker.id).worker.latestRun?.status, "running");

  await service.cancel({ workerIds: [pi.worker.id] }, "ui", "owner-1");
  await waitStatus(service, pi.worker.id, ["cancelled"]);
  await waitStatus(service, agy.worker.id, ["completed"]);
  const agyAgain = await service.start("owner-1", startInput({
    type: "agy",
    configId: "agy-default",
    requestId: "parallel-agy-again",
  }));
  await waitStatus(service, agyAgain.worker.id, ["completed"]);
  assert.equal(fs.readFileSync(spawnLog, "utf8").trim(), "agy " + agyPid);
});

test("agy falls back to partial run usage when the ACP result omits a counter", async (t) => {
  const root = temporaryRoot("worker-agy-partial-usage-");
  const { service } = createService(t, root, {
    TEST_AGY_SESSION_ID: "agy-partial",
    TEST_SCENARIO: "partial-usage",
  });
  service.updateSettings({
    configs: [...service.settings().configs, agyConfig()],
    defaultConfigId: "agy-default",
  });
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "agy-partial-start" }),
  );
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  assert.equal(first.latestRun?.usage?.partial, true);
  assert.equal(first.latestRun?.usage?.outputTokens, null);
  assert.equal(first.latestRun?.usage?.totalTokens, 15);
});

test("ACP idle timeout waits for the last task and reuses the process inside the window", async (t) => {
  const root = temporaryRoot("worker-acp-idle-window-");
  const spawnLog = path.join(root, "spawn.log");
  const { service } = createService(t, root, {
    CLOUDCLI_WORKER_ACP_IDLE_TIMEOUT_SECONDS: "2",
    TEST_SPAWN_LOG_FILE: spawnLog,
  });
  service.updateSettings({
    configs: [...service.settings().configs, agyConfig({ concurrency: 2 })],
    defaultConfigId: "agy-default",
  });
  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const spawnLines = (): string[] =>
    fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, "utf8").trim().split("\n") : [];
  assert.equal(fs.existsSync(spawnLog), false, "an idle slot must not launch before a task");

  const held = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", prompt: "[scenario:hang] hold", requestId: "idle-window-1" }),
  );
  await waitStatus(service, held.worker.id, ["running"]);
  await waitFor(spawnLines, (lines) => lines.length === 1);
  const pid = Number(spawnLines()[0]!.split(" ")[1]);
  const quick = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", prompt: "finish first", requestId: "idle-window-2" }),
  );
  await waitStatus(service, quick.worker.id, ["completed"]);
  assert.equal(spawnLines().length, 1);

  await new Promise((resolve) => setTimeout(resolve, 2300));
  await waitStatus(service, held.worker.id, ["running"]);
  assert.equal(pidAlive(pid), true, "an active task must keep the process past the idle window");
  assert.equal(spawnLines().length, 1);

  await service.cancel({ workerIds: [held.worker.id] }, "ui", "owner-1");
  await waitStatus(service, held.worker.id, ["cancelled"]);
  const reused = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", prompt: "reuse", requestId: "idle-window-3" }),
  );
  await waitStatus(service, reused.worker.id, ["completed"]);
  assert.equal(spawnLines().length, 1, "a task inside the idle window must reuse the PID");
  assert.equal(pidAlive(pid), true);

  await waitFor(() => pidAlive(pid), (alive) => alive === false, 5000);
});

test("saving a shorter ACP idle window recycles an already idle slot promptly", async (t) => {
  const root = temporaryRoot("worker-acp-idle-shorten-");
  const spawnLog = path.join(root, "spawn.log");
  const { service } = createService(t, root, {
    CLOUDCLI_WORKER_ACP_IDLE_TIMEOUT_SECONDS: "10",
    TEST_AGY_SESSION_ID: "agy-idle-shorten",
    TEST_SPAWN_LOG_FILE: spawnLog,
  });
  service.updateSettings({
    configs: [...service.settings().configs, agyConfig()],
    defaultConfigId: "agy-default",
  });
  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const spawnLines = (): string[] =>
    fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, "utf8").trim().split("\n") : [];

  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", prompt: "idle shorten", requestId: "idle-shorten-1" }),
  );
  await waitStatus(service, started.worker.id, ["completed"]);
  const pid = Number((await waitFor(spawnLines, (lines) => lines.length === 1))[0]!.split(" ")[1]);

  // Keep the slot idle past the new one-second window, but well inside the old ten seconds.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const current = service.settings();
  const saved = service.updateSettings({
    configs: current.configs,
    defaultConfigId: current.defaultConfigId,
    acpIdleTimeoutSeconds: 1,
  });
  assert.equal(saved.acpIdleTimeoutSeconds, 1);
  await waitFor(() => pidAlive(pid), (alive) => alive === false, 3000);
});

test("AGY ACP resumes the same session after its idle process exits", async (t) => {
  const root = temporaryRoot("worker-acp-idle-resume-");
  const spawnLog = path.join(root, "spawn.log");
  const { service, data } = createService(t, root, {
    CLOUDCLI_WORKER_ACP_IDLE_TIMEOUT_SECONDS: "1",
    TEST_AGY_SESSION_ID: "agy-idle-resume",
    TEST_SPAWN_LOG_FILE: spawnLog,
  });
  service.updateSettings({
    configs: [...service.settings().configs, agyConfig()],
    defaultConfigId: "agy-default",
  });
  const started = await service.start("owner-1", startInput({
    type: "agy",
    configId: "agy-default",
    requestId: "idle-resume-agy-start",
  }));
  const first = (await waitStatus(service, started.worker.id, ["completed"])).latestRun!;
  const firstPid = Number(fs.readFileSync(spawnLog, "utf8").trim().split(" ")[1]);
  await waitFor(() => {
    try {
      process.kill(firstPid, 0);
      return false;
    } catch {
      return true;
    }
  }, Boolean, 5000);

  const resumed = await service.resume("owner-1", {
    workerId: started.worker.id,
    prompt: "Continue AGY",
    requestId: "idle-resume-agy-next",
  });
  const latest = (await waitStatus(service, started.worker.id, ["completed"])).latestRun!;
  const pids = fs.readFileSync(spawnLog, "utf8").trim().split("\n").map((line) => Number(line.split(" ")[1]));
  assert.equal(pids.length, 2);
  assert.notEqual(pids[0], pids[1]);
  assert.equal(latest.id, resumed.run.id);
  assert.equal(latest.nativeSessionId, first.nativeSessionId);
  const events = fs.readFileSync(
    path.join(data, "logs", started.worker.id, resumed.run.id, "events.log"),
    "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.find((event) => event.type === "acp_session")?.action, "resume");
});
