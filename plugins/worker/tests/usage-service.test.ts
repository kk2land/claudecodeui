import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { WorkerService } from "../server/service.js";
import { WorkerStore } from "../server/store.js";
import type { WorkerRecord, WorkerRun } from "../shared/contracts.js";
import {
  codexFixture,
  createService,
  environment,
  startInput,
  temporaryRoot,
  waitStatus,
} from "./helpers.js";

function rolloutLine(total: Record<string, number>): string {
  const withTotal = {
    ...total,
    total_tokens: total.total_tokens ?? total.input_tokens! + total.output_tokens!,
  };
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: withTotal, last_token_usage: withTotal },
    },
  }) + "\n";
}

const DIFF = {
  inputTokens: 11,
  outputTokens: 5,
  cacheReadTokens: 4,
  cacheWriteTokens: 2,
  totalTokens: 16,
  scope: "run" as const,
  partial: false,
};

test("new Codex thread starts from known zero, persists usage, and replay does not duplicate", async (t) => {
  const root = temporaryRoot("worker-usage-service-new-");
  const { service, data } = createService(t, root);
  const input = startInput({ type: "codex", requestId: "usage-new" });
  const started = await service.start("owner-1", input);
  const worker = await waitStatus(service, started.worker.id, ["completed"]);
  const run = worker.latestRun!;
  assert.deepEqual(run.codexUsageBaseline, {
    counters: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    offset: 0,
  });
  assert.deepEqual(run.usage, DIFF);
  assert.ok(run.nativeSessionFile?.endsWith("session-fixture-1.jsonl"));
  assert.equal(fs.existsSync(run.nativeSessionFile!), true);

  const replay = await service.start("owner-1", input);
  assert.equal(replay.run.id, run.id);
  assert.deepEqual(replay.run.usage, DIFF);
  assert.equal(service.get(worker.id).runs.length, 1);

  const reopened = new WorkerStore(data);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.run(run.id)?.usage, DIFF);
});

test("Codex resume reads the launch-time baseline, including changes while queued", async (t) => {
  const root = temporaryRoot("worker-usage-service-resume-");
  const { service, env } = createService(t, root);
  service.updateSettings({ concurrency: { dsh: 3, pi: 3, codex: 1 } });
  const started = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "usage-baseline-start" }),
  );
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  const rollout = first.latestRun!.nativeSessionFile!;
  fs.appendFileSync(
    rollout,
    rolloutLine({ input_tokens: 100, output_tokens: 50, cached_input_tokens: 20, cache_write_input_tokens: 10 }),
  );
  const firstBaselineOffset = fs.statSync(rollout).size;
  env.TEST_CODEX_COMPLETION_USAGE = JSON.stringify({
    input_tokens: 111,
    output_tokens: 55,
    cached_input_tokens: 24,
    cache_write_input_tokens: 12,
  });
  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "resume after external session usage",
    requestId: "usage-baseline-resume",
  });
  const resumed = await waitStatus(service, first.id, ["completed"]);
  assert.deepEqual(resumed.latestRun?.usage, DIFF);
  assert.deepEqual(resumed.latestRun?.codexUsageBaseline, {
    counters: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 150,
    },
    offset: firstBaselineOffset,
  });

  // Hold the only Codex slot with a hanging run, queue a resume, advance the native session,
  // then free the slot. The queued run must read its baseline only when it actually launches.
  env.TEST_SCENARIO = "hang";
  const blocker = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "usage-blocker" }),
  );
  await waitStatus(service, blocker.worker.id, ["running"]);
  env.TEST_SCENARIO = "ok";
  const queued = await service.resume("owner-1", {
    workerId: first.id,
    prompt: "queued resume",
    requestId: "usage-queued-resume",
  });
  assert.equal(service.get(first.id).worker.latestRun?.id, queued.run.id);
  assert.equal(service.get(first.id).worker.latestRun?.status, "queued");
  fs.appendFileSync(
    rollout,
    rolloutLine({ input_tokens: 300, output_tokens: 120, cached_input_tokens: 60, cache_write_input_tokens: 30 }),
  );
  env.TEST_CODEX_COMPLETION_USAGE = JSON.stringify({
    input_tokens: 311,
    output_tokens: 125,
    cached_input_tokens: 64,
    cache_write_input_tokens: 32,
  });
  await service.cancel({ workerIds: [blocker.worker.id] });
  await waitStatus(service, blocker.worker.id, ["cancelled"]);
  const completed = await waitStatus(service, first.id, ["completed"]);
  assert.deepEqual(completed.latestRun?.usage, DIFF);
  assert.deepEqual(completed.latestRun?.codexUsageBaseline?.counters, {
    inputTokens: 300,
    outputTokens: 120,
    cacheReadTokens: 60,
    cacheWriteTokens: 30,
    totalTokens: 420,
  });
});

test("Codex failure, cancellation, and timeout read rollout usage after launch", async (t) => {
  const root = temporaryRoot("worker-usage-service-terminal-");
  const { service, env } = createService(t, root, {
    TEST_SCENARIO: "fail",
    TEST_CODEX_ROLLOUT_USAGE: JSON.stringify({
      input_tokens: 7,
      output_tokens: 2,
      cached_input_tokens: 1,
      cache_write_input_tokens: 1,
    }),
  });
  const failed = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "usage-failed" }),
  );
  const failedWorker = await waitStatus(service, failed.worker.id, ["failed"]);
  assert.deepEqual(failedWorker.latestRun?.usage, {
    inputTokens: 7,
    outputTokens: 2,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    totalTokens: 9,
    scope: "run",
    partial: true,
  });

  env.TEST_SCENARIO = "hang";
  env.TEST_CODEX_ROLLOUT_USAGE = JSON.stringify({
    input_tokens: 3,
    output_tokens: 1,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
  });
  const cancelled = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "usage-cancelled" }),
  );
  await waitStatus(service, cancelled.worker.id, ["running"]);
  await service.cancel({ workerIds: [cancelled.worker.id] });
  const cancelledWorker = await waitStatus(service, cancelled.worker.id, ["cancelled"]);
  assert.deepEqual(cancelledWorker.latestRun?.usage, {
    inputTokens: 3,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 4,
    scope: "run",
    partial: true,
  });

  const timedOut = await service.start(
    "owner-1",
    startInput({
      type: "codex",
      requestId: "usage-timeout",
      timeoutSeconds: 1,
    }),
  );
  const timeoutWorker = await waitStatus(service, timedOut.worker.id, ["failed"], 15_000);
  assert.deepEqual(timeoutWorker.latestRun?.usage, {
    inputTokens: 3,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 4,
    scope: "run",
    partial: true,
  });
});

function run(workerId: string, home: string): WorkerRun {
  return {
    id: "unknown-run",
    workerId,
    requestId: "unknown-request",
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    model: null,
    provider: null,
    effort: null,
    timeoutSeconds: null,
    home,
    sessionsRoot: path.join(home, "sessions"),
    nativeSessionId: "thread-unknown",
    nativeSessionFile: null,
    codexUsageBaseline: {
      counters: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      },
      offset: 0,
    },
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
  };
}

test("recovery saves parsed rollout usage for unknown runs even with a known session id", async (t) => {
  const root = temporaryRoot("worker-usage-service-recovery-");
  const data = path.join(root, "data");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const env = environment(root);
  const workerId = "worker-unknown";
  const worker: WorkerRecord = {
    id: workerId,
    type: "codex",
    configId: "codex-default",
    configName: "Codex default",
    taskName: "unknown",
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
  const storedRun = run(workerId, env.CODEX_HOME!);
  const store = new WorkerStore(data);
  store.createWorker(worker, storedRun, "parent-1", "unknown-request", "start", "fp");
  store.close();

  const runDirectory = path.join(data, "logs", workerId, storedRun.id);
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(runDirectory, "events.log"),
    JSON.stringify({ type: "thread.started", thread_id: "thread-unknown" }) + "\n",
  );
  fs.mkdirSync(path.join(env.CODEX_HOME!, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(env.CODEX_HOME!, "sessions", "thread-unknown.jsonl"),
    rolloutLine({
      input_tokens: 7,
      output_tokens: 2,
      cached_input_tokens: 1,
      cache_write_input_tokens: 1,
    }),
  );

  const service = new WorkerService({
    dataDirectory: data,
    environment: env,
    executablePaths: { codex: codexFixture },
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  service.recoverFromDisk();
  const recovered = service.get(workerId).worker.latestRun!;
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.nativeSessionId, "thread-unknown");
  assert.deepEqual(recovered.usage, {
    inputTokens: 7,
    outputTokens: 2,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    totalTokens: 9,
    scope: "run",
    partial: true,
  });
});
