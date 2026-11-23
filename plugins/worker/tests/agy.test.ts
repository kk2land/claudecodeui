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
import { WorkerStore } from "../server/store.js";
import {
  createService,
  startInput,
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
    dshPatch: path.join(root, "patch.yml"),
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
    dshPatch: path.join(root, "patch.yml"),
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

test("agy starts and resumes through the Worker service with the real CLI event shape", async (t) => {
  const root = temporaryRoot("worker-agy-service-");
  const capture = path.join(root, "agy-capture.json");
  const { service } = createService(t, root, {
    TEST_CAPTURE_FILE: capture,
    TEST_SESSION_ID: "conversation-agy-1",
    TEST_AGY_RESULT_USAGE: JSON.stringify({
      input_tokens: 110,
      output_tokens: 55,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 165,
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
  assert.equal(firstRun.finalText, "agy answer conversation-agy-1");
  assert.equal(firstRun.usage?.inputTokens, 10);
  assert.equal(firstRun.usage?.outputTokens, 5);
  assert.equal(firstRun.usage?.totalTokens, 15);
  assert.equal(firstRun.usage?.scope, "run");
  const startCapture = JSON.parse(fs.readFileSync(capture, "utf8")) as {
    argv: string[];
    prompt: string;
    model: string | null;
    effort: string | null;
  };
  assert.equal(startCapture.prompt, "reply with OK");
  assert.equal(startCapture.model, "gemini-3.8-flash-low");
  assert.equal(startCapture.effort, "low");
  assert.ok(startCapture.argv.includes("--dangerously-skip-permissions"));
  assert.ok(startCapture.argv.includes("--print=reply with OK"));
  assert.equal(startCapture.argv.includes("--conversation"), false);
  assert.doesNotMatch(fs.readFileSync(capture, "utf8"), /CLOUDCLI_PLUGIN_TOKEN/);

  const resumed = await service.resume("owner-1", {
    workerId: first.id,
    prompt: "reply again",
    requestId: "agy-resume-1",
  });
  const second = await waitStatus(service, first.id, ["completed"]);
  assert.notEqual(resumed.run.id, firstRun.id);
  assert.equal(second.latestRun?.nativeSessionId, "conversation-agy-1");
  assert.equal(second.latestRun?.finalText, "agy answer conversation-agy-1");
  // The result usage is cumulative (110/55); the completed agent_response step is this run.
  assert.equal(second.latestRun?.usage?.inputTokens, 10);
  assert.equal(second.latestRun?.usage?.outputTokens, 5);
  assert.equal(second.latestRun?.usage?.totalTokens, 15);
  assert.equal(second.latestRun?.usage?.scope, "run");
  const resumeCapture = JSON.parse(fs.readFileSync(capture, "utf8")) as { argv: string[] };
  assert.deepEqual(
    resumeCapture.argv.slice(-2),
    ["--conversation", "conversation-agy-1"],
  );
  assert.equal(service.state().counts.agy.completed, 1);
});

test("agy surfaces denied tools and identity mismatches as failed runs", async (t) => {
  const deniedRoot = temporaryRoot("worker-agy-denied-");
  const denied = createService(t, deniedRoot, { TEST_SCENARIO: "denied" });
  denied.service.updateSettings({
    configs: [...denied.service.settings().configs, agyConfig()],
    defaultConfigId: "agy-default",
  });
  const deniedStart = await denied.service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "agy-denied" }),
  );
  const deniedWorker = await waitStatus(denied.service, deniedStart.worker.id, ["failed"]);
  assert.match(deniedWorker.latestRun?.error?.message ?? "", /write_file/);
  assert.equal(deniedWorker.latestRun?.nativeSessionId, "session-fixture-1");

  const mismatchRoot = temporaryRoot("worker-agy-mismatch-");
  const mismatch = createService(t, mismatchRoot, {
    TEST_SESSION_ID: "conversation-agy-2",
    TEST_AGY_MISSING_CONVERSATION: "1",
  });
  mismatch.service.updateSettings({
    configs: [...mismatch.service.settings().configs, agyConfig()],
    defaultConfigId: "agy-default",
  });
  const first = await mismatch.service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "agy-mismatch-start" }),
  );
  const firstDone = await waitStatus(mismatch.service, first.worker.id, ["completed"]);
  await mismatch.service.resume("owner-1", {
    workerId: first.worker.id,
    prompt: "resume",
    requestId: "agy-mismatch-resume",
  });
  const resumed = await waitStatus(mismatch.service, first.worker.id, ["failed"]);
  assert.match(resumed.latestRun?.error?.message ?? "", /不同会话 ID/);
  assert.equal(resumed.latestRun?.nativeSessionId, firstDone.latestRun?.nativeSessionId);
});

test("agy rejects known model/effort conflicts at config, start and resume boundaries", async (t) => {
  const root = temporaryRoot("worker-agy-settings-");
  const { service, data } = createService(t, root);
  const saved = service.updateSettings({
    configs: [
      ...service.settings().configs,
      agyConfig({ model: "gemini-3.8-flash-low", effort: "low" }),
    ],
    defaultConfigId: "agy-default",
  });
  assert.equal(saved.defaultWorkerType, "agy");
  assert.equal(saved.enabled.agy, true);
  assert.deepEqual(saved.defaults.agy, {
    model: "gemini-3.8-flash-low",
    effort: "low",
  });
  assert.deepEqual(saved.roles.agy, []);
  assert.equal(saved.concurrency.agy, 3);

  // Legacy updates keep editing only dsh/pi/codex and never remove the agy config.
  const legacy = service.updateSettings({ concurrency: { dsh: 2, pi: 2 } });
  assert.equal(legacy.configs.some((config) => config.id === "agy-default"), true);
  assert.equal(legacy.defaultWorkerType, "agy");

  assert.throws(
    () =>
      service.updateSettings({
        configs: [agyConfig({ effort: "maximal" })],
        defaultConfigId: "agy-default",
      }),
    /agy 配置的 effort/,
  );
  await assert.rejects(
    service.start(
      "owner-1",
      startInput({
        type: "agy",
        configId: "agy-default",
        effort: "maximal",
        requestId: "agy-invalid-effort",
      }),
    ),
    /agy 配置的 effort/,
  );

  // A known variant conflict is rejected before persistence and leaves the saved config intact.
  assert.throws(
    () =>
      service.updateSettings({
        configs: [
          agyConfig({ model: "gemini-3.8-flash-low", effort: "high" }),
        ],
        defaultConfigId: "agy-default",
      }),
    /gemini-3\.8-flash-low 固定使用 low reasoning；支持的 effort 为 low 或留空/,
  );
  assert.deepEqual(service.settings().defaults.agy, {
    model: "gemini-3.8-flash-low",
    effort: "low",
  });
  await assert.rejects(
    service.start(
      "owner-1",
      startInput({
        type: "agy",
        configId: "agy-default",
        model: "gemini-3.8-flash-low",
        effort: "high",
        requestId: "agy-conflict-start",
      }),
    ),
    /gemini-3\.8-flash-low 固定使用 low reasoning；支持的 effort 为 low 或留空/,
  );

  // The valid inherited effort is applied, while an explicit resume conflict is rejected.
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "agy-inherit-low" }),
  );
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  assert.equal(first.latestRun?.model, "gemini-3.8-flash-low");
  assert.equal(first.latestRun?.effort, "low");
  await assert.rejects(
    service.resume("owner-1", {
      workerId: first.id,
      prompt: "invalid resume effort",
      effort: "high",
      requestId: "agy-conflict-resume",
    }),
    /gemini-3\.8-flash-low 固定使用 low reasoning；支持的 effort 为 low 或留空/,
  );
  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "valid inherited resume",
    requestId: "agy-inherit-resume",
  });
  const second = await waitStatus(service, first.id, ["completed"]);
  assert.equal(second.latestRun?.effort, "low");

  // An unsuffixed id is not constrained by a guessed suffix rule; the CLI stays the validator.
  service.updateSettings({
    configs: [
      ...service.settings().configs.filter((config) => config.id !== "agy-default"),
      agyConfig({ model: "custom/vendor-model", effort: "high" }),
    ],
    defaultConfigId: "agy-default",
  });
  const bare = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-default",
      requestId: "agy-bare-model",
    }),
  );
  const bareDone = await waitStatus(service, bare.worker.id, ["completed"]);
  assert.equal(bareDone.latestRun?.model, "custom/vendor-model");
  assert.equal(bareDone.latestRun?.effort, "high");

  // A conflict already persisted before this validation is still rejected at start, not
  // silently rewritten or launched with a mismatched pair.
  const current = service.settings();
  const store = new WorkerStore(data);
  store.saveSettings({
    schemaVersion: 2,
    configs: current.configs.map((config) =>
      config.id === "agy-default"
        ? { ...config, model: "gemini-3.8-flash-low", effort: "high" }
        : config,
    ),
    defaultConfigId: current.defaultConfigId,
    retentionDays: current.retentionDays,
    softReminderSeconds: current.softReminderSeconds,
    softReminderSteps: current.softReminderSteps,
  });
  store.close();
  await assert.rejects(
    service.start(
      "owner-1",
      startInput({
        type: "agy",
        configId: "agy-default",
        requestId: "agy-stored-conflict",
      }),
    ),
    /gemini-3\.8-flash-low 固定使用 low reasoning；支持的 effort 为 low 或留空/,
  );
});

test("agy falls back to result-only usage as run scope first and session scope on resume", async (t) => {
  const root = temporaryRoot("worker-agy-result-usage-");
  const { service } = createService(t, root, { TEST_SCENARIO: "no-step-usage" });
  service.updateSettings({
    configs: [...service.settings().configs, agyConfig()],
    defaultConfigId: "agy-default",
  });
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "agy-usage-start" }),
  );
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  assert.deepEqual(first.latestRun?.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: null,
    totalTokens: 15,
    scope: "run",
    partial: true,
  });

  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "resume without step usage",
    requestId: "agy-usage-resume",
  });
  const second = await waitStatus(service, first.id, ["completed"]);
  // The resumed result is conversation-cumulative, so it must not be reported as this run.
  assert.deepEqual(second.latestRun?.usage, {
    inputTokens: 110,
    outputTokens: 55,
    cacheReadTokens: 0,
    cacheWriteTokens: null,
    totalTokens: 165,
    scope: "session",
    partial: true,
  });
});
