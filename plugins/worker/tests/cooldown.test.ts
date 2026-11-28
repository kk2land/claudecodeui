import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { WorkerConfig, WorkerStartInput } from "../shared/contracts.js";
import { AGY_QUOTA_GROUP_LABELS, type AgyQuotaGroupKind } from "../shared/agy.js";
import { WorkerService } from "../server/service.js";
import {
  agyAcpFixture,
  createService,
  environment,
  piFixture,
  startInput,
  temporaryRoot,
  waitStatus,
} from "./helpers.js";

function config(type: "pi" | "codex" | "agy", id = type + "-default"): WorkerConfig {
  return {
    id,
    name: id,
    type,
    enabled: true,
    roles: [],
    concurrency: 3,
    hardTimeoutSeconds: 600,
    model: null,
    effort: null,
    ...(type === "codex"
      ? { codex: { modelProvider: "magpie", env: {}, legacyExtraArgs: [] } }
      : {}),
  };
}

function configure(
  service: WorkerService,
  configs: WorkerConfig[] = [config("pi"), config("codex"), config("agy")],
): void {
  service.updateSettings({ configs, defaultConfigId: configs[0]!.id });
}

function modelConfig(id: string, model: string): WorkerConfig {
  return { ...config("agy", id), model };
}

/** Input without an explicit engine, so the service routes the candidate config itself. */
function autoInput(overrides: Partial<WorkerStartInput> = {}): WorkerStartInput {
  const input = startInput(overrides) as WorkerStartInput & { type?: unknown };
  delete input.type;
  return input;
}

/** Asserts a start/resume refusal for a known-quota-exhausted pool names the pool and deadline. */
async function quotaRejection(
  promise: Promise<unknown>,
  group: AgyQuotaGroupKind,
  until?: string,
): Promise<void> {
  await assert.rejects(promise, (error: Error & { code?: string }) => {
    assert.equal(error.code, "AGY_QUOTA_REACHED");
    assert.ok(error.message.includes(AGY_QUOTA_GROUP_LABELS[group]), error.message);
    if (until) assert.ok(error.message.includes(until), error.message);
    return true;
  });
}

test("agy ACP 429 reset hint cools only the run's pool and refuses the resume", async (t) => {
  const root = temporaryRoot("worker-agy-stderr-");
  const now = Date.now();
  const { service } = createService(
    t,
    root,
    {
      TEST_SCENARIO: "rate-limit",
      TEST_AGY_RESET_TEXT: "Resets in 2h2m18s",
    },
    { now: () => now },
  );
  configure(service);
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "agy-429" }),
  );
  const failed = await waitStatus(service, started.worker.id, ["failed"]);
  assert.equal(failed.latestRun?.status, "failed");
  assert.equal(
    Date.parse(service.overview().agyCooldownUntil!) - now,
    ((2 * 60 + 2) * 60 + 18) * 1000,
  );
  const deadline = new Date(now + ((2 * 60 + 2) * 60 + 18) * 1000).toISOString();
  assert.deepEqual(service.overview().agyCooldowns, [{ group: "gemini", until: deadline }]);
  // The resume binds the failed run's pool, so it is refused before a run is allocated.
  const runs = service.get(failed.id).runs.length;
  await quotaRejection(
    service.resume("owner-1", {
      workerId: failed.id,
      prompt: "retry after quota",
      requestId: "agy-429-resume",
    }),
    "gemini",
    deadline,
  );
  assert.equal(service.get(failed.id).runs.length, runs);
});

test("agy ACP RESOURCE_EXHAUSTED 429 without a reset hint falls back to 60 seconds", async (t) => {
  const root = temporaryRoot("worker-agy-structured-");
  const now = Date.now();
  const { service } = createService(
    t,
    root,
    { TEST_SCENARIO: "rate-limit" },
    { now: () => now },
  );
  configure(service);
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "agy-structured" }),
  );
  await waitStatus(service, started.worker.id, ["failed"]);
  assert.equal(Date.parse(service.overview().agyCooldownUntil!) - now, 60_000);
});

test("a cooled pool rejects every agy config that draws from it without delaying Pi", async (t) => {
  const root = temporaryRoot("worker-agy-cross-");
  const now = Date.now();
  const { service } = createService(
    t,
    root,
    {
      TEST_SCENARIO: "quota-hold",
      TEST_AGY_RELEASE_DIR: root,
      TEST_AGY_RESET_BY_MODEL: JSON.stringify({
        long: "Resets in 2h",
        short: "Resets in 10s",
      }),
    },
    { now: () => now },
  );
  configure(service, [
    config("pi"),
    modelConfig("agy-long", "long"),
    modelConfig("agy-short", "short"),
  ]);
  const long = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-long", requestId: "long" }),
  );
  const short = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-short", requestId: "short" }),
  );
  await waitStatus(service, long.worker.id, ["running"]);
  await waitStatus(service, short.worker.id, ["running"]);

  // Pi has its own lazy ACP process and must not wait for active AGY turns.
  const pi = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "pi-during" }),
  );
  assert.equal(
    (await waitStatus(service, pi.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );

  fs.writeFileSync(path.join(root, "release-long"), "");
  await waitStatus(service, long.worker.id, ["failed"]);
  const firstDeadline = Date.parse(service.overview().agyCooldownUntil!);
  assert.equal(firstDeadline - now, 2 * 3600 * 1000);

  // The cooled pool refuses the start instead of parking it in the queue.
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-short", requestId: "blocked" }),
    ),
    "gemini",
    new Date(firstDeadline).toISOString(),
  );
  assert.equal(service.get(short.worker.id).runs.length, 1);

  fs.writeFileSync(path.join(root, "release-short"), "");
  await waitStatus(service, short.worker.id, ["failed"]);
  // Both configs draw from the Gemini pool, so the longest deadline still wins.
  assert.equal(Date.parse(service.overview().agyCooldownUntil!), firstDeadline);
});

test("a queued agy run in a cooled pool starts again after the deadline expires", async (t) => {
  const root = temporaryRoot("worker-agy-expiry-");
  const { service } = createService(t, root, {
    TEST_AGY_RELEASE_DIR: root,
    TEST_AGY_RESET_TEXT: "Resets in 1s",
  });
  configure(service, [{ ...config("agy"), concurrency: 1 }]);
  const first = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-default",
      prompt: "[scenario:quota-hold] hold",
      requestId: "expiry-first",
    }),
  );
  await waitStatus(service, first.worker.id, ["running"]);
  // Admitted while the pool was still open, so it waits in the queue instead of being refused.
  const queued = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-default",
      prompt: "[scenario:rate-limit] limited",
      requestId: "expiry-queued",
    }),
  );
  assert.equal(queued.run.status, "queued");

  fs.writeFileSync(path.join(root, "release-gemini-4-neon"), "");
  await waitStatus(service, first.worker.id, ["failed"]);
  assert.equal(service.get(queued.worker.id).worker.latestRun?.status, "queued");
  assert.equal(
    (await waitStatus(service, queued.worker.id, ["failed"], 10_000)).latestRun?.status,
    "failed",
  );
  // The queued run really launched after the deadline and hit the still-exhausted pool.
  const rerun = service.get(queued.worker.id).worker.latestRun;
  assert.ok(rerun?.startedAt);
  assert.match(rerun?.error?.message ?? "", /RESOURCE_EXHAUSTED/);
});

test("the stored deadline and a queued agy run survive a real close and reopen", async (t) => {
  const root = temporaryRoot("worker-agy-restart-");
  const { service, data, project } = createService(t, root, {
    TEST_AGY_RELEASE_DIR: root,
    TEST_AGY_RESET_TEXT: "Resets in 2h",
  });
  configure(service, [{ ...config("agy"), concurrency: 1 }]);
  const started = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-default",
      prompt: "[scenario:quota-hold] hold",
      requestId: "restart-first",
    }),
  );
  await waitStatus(service, started.worker.id, ["running"]);
  const queued = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "restart-queued" }),
  );
  assert.equal(queued.run.status, "queued");
  fs.writeFileSync(path.join(root, "release-gemini-4-neon"), "");
  await waitStatus(service, started.worker.id, ["failed"]);
  const deadline = service.overview().agyCooldownUntil;
  assert.ok(deadline);
  await service.close();

  const reopened = new WorkerService({
    dataDirectory: data,
    environment: environment(root, { PATH: "" }),
    executablePaths: { "agy-acp": agyAcpFixture },
  });
  t.after(() => reopened.close());
  reopened.registerOwner(
    {
      id: "owner-1",
      parentSessionId: "parent-1",
      projectId: "project-1",
      projectPath: project,
      userId: 7,
      appServerInstanceId: "app-1",
      paused: false,
    },
    "owner-token",
  );
  reopened.recoverFromDisk();
  assert.equal(reopened.overview().agyCooldownUntil, deadline);
  assert.deepEqual(reopened.overview().agyCooldowns, [{ group: "gemini", until: deadline }]);
  assert.equal(reopened.get(queued.worker.id).worker.latestRun?.status, "queued");
});

test("agy end_turn quota warning fails the run and starts the normal cooldown", async (t) => {
  const root = temporaryRoot("worker-agy-quota-message-");
  const now = Date.now();
  const { service } = createService(
    t,
    root,
    { TEST_SCENARIO: "quota-message" },
    { now: () => now },
  );
  configure(service);
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "quota-message-first" }),
  );
  const failed = await waitStatus(service, started.worker.id, ["failed"]);
  const run = failed.latestRun!;
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "AGY_QUOTA_REACHED");
  assert.equal(
    run.error?.message,
    "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h39m16s.",
  );
  assert.equal(
    Date.parse(service.overview().agyCooldownUntil!) - now,
    ((1 * 60 + 39) * 60 + 16) * 1000,
  );

  const queued = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "quota-message-queued" }),
  ).then(
    () => assert.fail("a cooled pool must not accept a start"),
    (error: Error & { code?: string }) => error,
  );
  assert.equal(queued.code, "AGY_QUOTA_REACHED");
  assert.ok(queued.message.includes("Gemini Models"), queued.message);
  assert.ok(queued.message.includes("后恢复"), queued.message);
  const pi = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "quota-message-pi" }),
  );
  assert.equal(
    (await waitStatus(service, pi.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );
});

test("an ordinary agy reply that mentions the quota warning still succeeds", async (t) => {
  const root = temporaryRoot("worker-agy-quota-mention-");
  const { service } = createService(t, root, { TEST_SCENARIO: "quota-mention" });
  configure(service);
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "quota-mention" }),
  );
  const done = await waitStatus(service, started.worker.id, ["completed"]);
  assert.equal(done.latestRun?.status, "completed");
  assert.match(done.latestRun?.finalText ?? "", /^The warning says:/);
});

/** Writes an `agy` fixture executable that reads its `/usage` JSON response from `payloadFile`. */
function quotaAgyExecutable(root: string, payloadFile: string): string {
  const executable = path.join(root, "fake-agy-quota.mjs");
  fs.writeFileSync(
    executable,
    "#!/usr/bin/env node\n" +
      "import fs from 'node:fs';\n" +
      "process.stdout.write(fs.readFileSync(" +
      JSON.stringify(payloadFile) +
      ", 'utf8'));\n",
    { mode: 0o755 },
  );
  return executable;
}

function quotaBucket(
  window: string,
  remaining_fraction: number,
  reset_time = "1970-01-01T00:00:00Z",
) {
  return { window, remaining_fraction, reset_time };
}

function writeUsage(
  file: string,
  groups: Array<{ name: string; buckets: ReturnType<typeof quotaBucket>[] }>,
): void {
  fs.writeFileSync(
    file,
    JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups } } }),
  );
}

test("exhausted Gemini Models quota cools only that pool for auto and manual polls without blocking Pi", async (t) => {
  const root = temporaryRoot("worker-agy-quota-cooldown-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const reset5h = new Date(now + 2 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(now + 5 * 86_400_000).toISOString();
  writeUsage(payloadFile, [
    {
      name: "Gemini Models",
      buckets: [
        quotaBucket("5h", 0, reset5h),
        quotaBucket("weekly", 0, resetWeekly),
      ],
    },
    { name: "Claude and GPT models", buckets: [quotaBucket("weekly", 1)] },
  ]);

  const { service } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
      agyQuotaPollIntervalMs: 60_000,
    },
  );
  configure(service, [
    config("pi"),
    modelConfig("agy-a", "model-a"),
    modelConfig("agy-b", "model-b"),
  ]);

  // Automatic startup poll (`recoverFromDisk` -> `refreshAgyQuota`) picks the later exhausted reset.
  service.recoverFromDisk();
  await service.agyQuota();
  assert.equal(service.overview().agyCooldownUntil, resetWeekly);
  assert.deepEqual(service.overview().agyCooldowns, [{ group: "gemini", until: resetWeekly }]);

  // Every AGY config drawing from the Gemini pool is refused before anything is persisted;
  // repeating the same requestId rejects again instead of replaying a stored run.
  const workersBefore = service.overview().workers.length;
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-a", requestId: "quota-agy-a" }),
    ),
    "gemini",
    resetWeekly,
  );
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-b", requestId: "quota-agy-b" }),
    ),
    "gemini",
    resetWeekly,
  );
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-a", requestId: "quota-agy-a" }),
    ),
    "gemini",
    resetWeekly,
  );
  assert.equal(service.overview().workers.length, workersBefore);
  const pi = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "quota-pi-ok" }),
  );
  assert.equal(
    (await waitStatus(service, pi.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );

  // Manual refresh with an even later monthly reset (>25 days) extends cooldown without overflowing timer.
  const resetMonthly = new Date(now + 35 * 86_400_000).toISOString();
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("monthly", 0, resetMonthly)] },
  ]);
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => warnings.push(warning);
  process.on("warning", onWarning);
  try {
    await service.refreshAgyQuota();
    await new Promise((resolve) => setTimeout(resolve, 40));
  } finally {
    process.off("warning", onWarning);
  }
  assert.equal(service.overview().agyCooldownUntil, resetMonthly);
  assert.equal(
    warnings.some((warning) => warning.name === "TimeoutOverflowWarning"),
    false,
  );
  // The extended deadline is reported in the refusal so the caller knows when to retry.
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-a", requestId: "quota-agy-extended" }),
    ),
    "gemini",
    resetMonthly,
  );
});

test("quota checks keep runtime cooldowns per pool, fall back to 60s without future reset, and honour positive remaining quota", async (t) => {
  const root = temporaryRoot("worker-agy-quota-preserve-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");

  // 1. Sub-0.5% positive Gemini quota (displays 0%) keeps its pool open; the exhausted
  // Claude/GPT pool cools on its own and leaves the Gemini pool usable.
  writeUsage(payloadFile, [
    {
      name: "Gemini Models",
      buckets: [quotaBucket("5h", 0.004, new Date(now + 3600 * 1000).toISOString())],
    },
    {
      name: "Claude and GPT models",
      buckets: [quotaBucket("weekly", 0, new Date(now + 86_400_000).toISOString())],
    },
  ]);
  const { service } = createService(
    t,
    root,
    { TEST_SCENARIO: "rate-limit", TEST_AGY_RESET_TEXT: "Resets in 2h" },
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service);
  const tiny = await service.refreshAgyQuota();
  assert.equal(tiny.groups[0]?.buckets[0]?.remainingPercent, 0);
  assert.deepEqual(service.overview().agyCooldowns, [
    { group: "claude-gpt", until: new Date(now + 86_400_000).toISOString() },
  ]);

  // 2. Runtime AGY 429 (a model-less agy config draws from Gemini) cools Gemini for 2h and is
  // neither cleared by positive quota nor shortened by a 10m reset; the earlier pool wins the
  // legacy `agyCooldownUntil` view while the Claude/GPT deadline stays untouched.
  const failedRun = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "runtime-2h" }),
  );
  await waitStatus(service, failedRun.worker.id, ["failed"]);
  const twoHoursDeadline = new Date(now + 2 * 3600 * 1000).toISOString();
  assert.equal(service.overview().agyCooldownUntil, twoHoursDeadline);

  writeUsage(payloadFile, [
    {
      name: "Gemini Models",
      buckets: [quotaBucket("5h", 0.8, new Date(now + 3600 * 1000).toISOString())],
    },
  ]);
  await service.refreshAgyQuota();
  assert.equal(service.overview().agyCooldownUntil, twoHoursDeadline);

  writeUsage(payloadFile, [
    {
      name: "Gemini Models",
      buckets: [quotaBucket("5h", 0, new Date(now + 10 * 60 * 1000).toISOString())],
    },
  ]);
  await service.refreshAgyQuota();
  assert.equal(service.overview().agyCooldownUntil, twoHoursDeadline);

  // 3. Exhausted Gemini Models without a valid future reset_time falls back to 60s on a clean service.
  const fallbackRoot = temporaryRoot("worker-agy-quota-fallback-");
  const fallbackPayload = path.join(fallbackRoot, "usage.json");
  writeUsage(fallbackPayload, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0)] },
  ]);
  const second = createService(
    t,
    fallbackRoot,
    {},
    {
      now: () => now,
      executablePaths: {
        agy: quotaAgyExecutable(fallbackRoot, fallbackPayload),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  await second.service.refreshAgyQuota();
  assert.equal(
    Date.parse(second.service.overview().agyCooldownUntil!) - now,
    60_000,
  );
});

test("an exhausted Gemini pool keeps Claude and GPT models running in their own pool", async (t) => {
  const root = temporaryRoot("worker-agy-pool-gemini-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const reset5h = new Date(now + 2 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    {
      name: "Gemini Models",
      // Only the exhausted 5-hour window defines the deadline; the weekly 31% stays display-only.
      buckets: [quotaBucket("5h", 0, reset5h), quotaBucket("weekly", 0.31)],
    },
    {
      name: "Claude and GPT models",
      buckets: [quotaBucket("weekly", 1), quotaBucket("5h", 1)],
    },
  ]);
  const { service } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service, [
    config("pi"),
    modelConfig("agy-gemini", "gemini-4-neon-high"),
    modelConfig("agy-qwen", "qwen3-coder-480b"),
    modelConfig("agy-claude", "claude-sonnet-4-5"),
    modelConfig("agy-gpt", "gpt-oss-120b-medium"),
  ]);
  await service.refreshAgyQuota();
  assert.deepEqual(service.overview().agyCooldowns, [{ group: "gemini", until: reset5h }]);

  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-gemini", requestId: "pool-gemini-blocked" }),
    ),
    "gemini",
    reset5h,
  );
  // A valid model id that is neither Claude/GPT nor named after Gemini shares the Gemini pool.
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-qwen", requestId: "pool-qwen-blocked" }),
    ),
    "gemini",
    reset5h,
  );

  for (const configId of ["agy-claude", "agy-gpt"]) {
    const started = await service.start(
      "owner-1",
      startInput({ type: "agy", configId, requestId: "pool-open-" + configId }),
    );
    assert.equal(started.worker.configId, configId);
    assert.equal(
      (await waitStatus(service, started.worker.id, ["completed"])).latestRun?.status,
      "completed",
    );
  }
  const pi = await service.start("owner-1", startInput({ type: "pi", requestId: "pool-pi" }));
  assert.equal(
    (await waitStatus(service, pi.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );
});

test("an exhausted Claude and GPT pool blocks both model families until the later window resets", async (t) => {
  const root = temporaryRoot("worker-agy-pool-claude-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const reset5h = new Date(now + 3600 * 1000).toISOString();
  const resetWeekly = new Date(now + 5 * 86_400_000).toISOString();
  writeUsage(payloadFile, [
    {
      name: "Gemini Models",
      buckets: [quotaBucket("weekly", 0.62), quotaBucket("5h", 0.41)],
    },
    {
      name: "Claude and GPT models",
      // Both windows are empty, so the pool recovers only when the later one resets.
      buckets: [quotaBucket("5h", 0, reset5h), quotaBucket("weekly", 0, resetWeekly)],
    },
  ]);
  const { service } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service, [
    modelConfig("agy-claude", "claude-opus-4-1-high"),
    modelConfig("agy-gpt", "gpt-oss-120b-medium"),
    modelConfig("agy-gemini", "gemini-4-neon-high"),
    modelConfig("agy-qwen", "google/qwen3-coder-480b"),
  ]);
  await service.refreshAgyQuota();
  assert.deepEqual(service.overview().agyCooldowns, [
    { group: "claude-gpt", until: resetWeekly },
  ]);

  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-claude", requestId: "pool-claude-blocked" }),
    ),
    "claude-gpt",
    resetWeekly,
  );
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-gpt", requestId: "pool-gpt-blocked" }),
    ),
    "claude-gpt",
    resetWeekly,
  );

  for (const configId of ["agy-gemini", "agy-qwen"]) {
    const started = await service.start(
      "owner-1",
      startInput({ type: "agy", configId, requestId: "pool-open-" + configId }),
    );
    assert.equal(
      (await waitStatus(service, started.worker.id, ["completed"])).latestRun?.status,
      "completed",
    );
  }
});

test("both exhausted pools keep independent deadlines and leave Pi available", async (t) => {
  const root = temporaryRoot("worker-agy-pool-both-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const resetGemini = new Date(now + 3600 * 1000).toISOString();
  const resetClaude = new Date(now + 3 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0, resetGemini)] },
    { name: "Claude and GPT models", buckets: [quotaBucket("weekly", 0, resetClaude)] },
  ]);
  const { service } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service, [
    config("pi"),
    modelConfig("agy-gemini", "gemini-4-neon-high"),
    modelConfig("agy-claude", "claude-sonnet-4-5"),
  ]);
  await service.refreshAgyQuota();
  assert.deepEqual(service.overview().agyCooldowns, [
    { group: "gemini", until: resetGemini },
    { group: "claude-gpt", until: resetClaude },
  ]);
  assert.equal(service.overview().agyCooldownUntil, resetGemini);
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-claude", requestId: "both-claude" }),
    ),
    "claude-gpt",
    resetClaude,
  );
  const pi = await service.start("owner-1", startInput({ type: "pi", requestId: "both-pi" }));
  assert.equal(
    (await waitStatus(service, pi.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );
});

test("a pre-group global cooldown row still blocks every AGY pool", async (t) => {
  const root = temporaryRoot("worker-agy-pool-legacy-");
  const { service, data } = createService(t, root, {});
  configure(service, [
    config("pi"),
    modelConfig("agy-gemini", "gemini-4-neon-high"),
    modelConfig("agy-claude", "claude-sonnet-4-5"),
  ]);
  const now = Date.now();
  const until = now + 3600 * 1000;
  const db = new Database(path.join(data, "worker.db"));
  try {
    db.prepare("INSERT OR REPLACE INTO cooldowns (engine, until) VALUES (?, ?)").run(
      "agy",
      until,
    );
  } finally {
    db.close();
  }

  // The old row carries no pool, so every pool whose quota is still unknown keeps waiting on it.
  assert.equal(service.overview().agyCooldownUntil, new Date(until).toISOString());
  assert.deepEqual(service.overview().agyCooldowns, [
    { group: "gemini", until: new Date(until).toISOString() },
    { group: "claude-gpt", until: new Date(until).toISOString() },
  ]);
  for (const configId of ["agy-gemini", "agy-claude"]) {
    await quotaRejection(
      service.start(
        "owner-1",
        startInput({ type: "agy", configId, requestId: "legacy-" + configId }),
      ),
      configId === "agy-gemini" ? "gemini" : "claude-gpt",
      new Date(until).toISOString(),
    );
  }
  const pi = await service.start("owner-1", startInput({ type: "pi", requestId: "legacy-pi" }));
  assert.equal(
    (await waitStatus(service, pi.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );
});

test("low but nonzero quota in both pools still runs the configured AGY model", async (t) => {
  const root = temporaryRoot("worker-agy-pool-low-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  writeUsage(payloadFile, [
    {
      name: "Gemini Models",
      // The reported account shape: 31% / 9% left is low, not exhausted.
      buckets: [
        quotaBucket("weekly", 0.31, new Date(now + 86_400_000).toISOString()),
        quotaBucket("5h", 0.09, new Date(now + 3600 * 1000).toISOString()),
      ],
    },
    {
      name: "Claude and GPT models",
      buckets: [
        quotaBucket("weekly", 1, new Date(now + 86_400_000).toISOString()),
        quotaBucket("5h", 1, new Date(now + 3600 * 1000).toISOString()),
      ],
    },
  ]);
  const { service } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service, [modelConfig("agy-named", "gemini-pro-orchestrator-neon")]);
  await service.refreshAgyQuota();
  assert.deepEqual(service.overview().agyCooldowns, []);
  assert.equal(service.overview().agyCooldownUntil, null);

  const started = await service.start("owner-1", autoInput({ requestId: "pool-low-run" }));
  assert.equal(started.worker.configId, "agy-named");
  assert.equal(
    (await waitStatus(service, started.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );
});

/** AGY config with a preferred Gemini model and the optional Claude fallback. */
function poolConfig(
  id: string,
  model: string | null,
  fallbackModel: string | null,
): WorkerConfig {
  return {
    ...modelConfig(id, model ?? ""),
    model,
    // One slot per config keeps a second run queued so the start-time re-judgement is visible.
    concurrency: 1,
    agy: fallbackModel ? { fallbackModel } : undefined,
  };
}

test("an exhausted Gemini pool runs the config's Claude fallback and the reset returns to Gemini", async (t) => {
  const root = temporaryRoot("worker-agy-fallback-");
  const payloadFile = path.join(root, "usage.json");
  let now = Date.parse("2026-11-27T10:00:00Z");
  const resetGemini = new Date(now + 2 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    {
      name: "Gemini Models",
      buckets: [quotaBucket("5h", 0, resetGemini), quotaBucket("weekly", 0.31)],
    },
    {
      name: "Claude and GPT models",
      buckets: [quotaBucket("5h", 1), quotaBucket("weekly", 1)],
    },
  ]);
  const { service } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service, [poolConfig("agy-dev", "gemini-4-neon-high", "claude-sonnet-4-5")]);
  await service.refreshAgyQuota();
  assert.deepEqual(service.overview().agyCooldowns, [
    { group: "gemini", until: resetGemini },
  ]);

  const first = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-dev", requestId: "fallback-claude" }),
  );
  const fallback = (await waitStatus(service, first.worker.id, ["completed"])).latestRun!;
  assert.equal(fallback.status, "completed");
  // The fallback model is recorded on the run and reaches the CLI itself.
  assert.equal(fallback.model, "claude-sonnet-4-5");
  assert.match(fallback.finalText ?? "", /model=claude-sonnet-4-5/);
  assert.equal(service.get(first.worker.id).runs.length, 1);

  // Once the Gemini window resets, a new task prefers the configured Gemini model again.
  now += 2 * 3600 * 1000;
  const second = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-dev", requestId: "fallback-gemini" }),
  );
  const preferred = (await waitStatus(service, second.worker.id, ["completed"])).latestRun!;
  assert.equal(preferred.model, "gemini-4-neon-high");
  assert.match(preferred.finalText ?? "", /model=gemini-4-neon thought=high/);
});

test("an explicit model stays in its own pool and a config without a fallback is never widened", async (t) => {
  const root = temporaryRoot("worker-agy-explicit-model-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const resetGemini = new Date(now + 2 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0, resetGemini)] },
    {
      name: "Claude and GPT models",
      buckets: [quotaBucket("5h", 1), quotaBucket("weekly", 1)],
    },
  ]);
  const { service } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service, [
    config("pi"),
    poolConfig("agy-dev", "gemini-4-neon-high", "claude-sonnet-4-5"),
    modelConfig("agy-pinned", "gemini-3.8-flash-low"),
  ]);
  await service.refreshAgyQuota();

  // A Gemini id asked for by the caller is not swapped for the configured Claude fallback.
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({
        type: "agy",
        configId: "agy-dev",
        model: "gemini-4-neon-high",
        requestId: "explicit-gemini",
      }),
    ),
    "gemini",
    resetGemini,
  );
  // A single-model config keeps its own id and waits instead of borrowing another model.
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-pinned", requestId: "pinned-gemini" }),
    ),
    "gemini",
    resetGemini,
  );
  // A Claude id the caller picked by hand runs on its own pool even while Gemini is closed.
  const pinned = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-dev",
      model: "claude-opus-4-1-high",
      requestId: "explicit-claude",
    }),
  );
  const done = (await waitStatus(service, pinned.worker.id, ["completed"])).latestRun!;
  assert.equal(done.model, "claude-opus-4-1-high");
  assert.match(done.finalText ?? "", /model=claude-opus-4-1 thought=high/);
});

test("resume keeps the recorded model and only switches between this config's pools", async (t) => {
  const root = temporaryRoot("worker-agy-resume-pools-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const resetGemini = new Date(now + 2 * 3600 * 1000).toISOString();
  const bucket = (fraction: number, reset?: string) =>
    quotaBucket("5h", fraction, reset);
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [bucket(1)] },
    {
      name: "Claude and GPT models",
      buckets: [bucket(1), quotaBucket("weekly", 1)],
    },
  ]);
  const { service } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service, [
    poolConfig("agy-dev", "gemini-4-neon-high", "claude-sonnet-4-5"),
    poolConfig("agy-narrow", "gemini-4-neon-high", null),
  ]);
  await service.refreshAgyQuota();
  const first = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-dev", requestId: "resume-first" }),
  );
  const recorded = (await waitStatus(service, first.worker.id, ["completed"])).latestRun!;
  assert.equal(recorded.model, "gemini-4-neon-high");

  // A single-model config records its own Gemini turn before that pool closes.
  const narrow = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-narrow", requestId: "resume-narrow-start" }),
  );
  await waitStatus(service, narrow.worker.id, ["completed"]);

  // Gemini closes after the first turn: the resume falls back to this config's Claude model.
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [bucket(0, resetGemini)] },
    {
      name: "Claude and GPT models",
      buckets: [bucket(1), quotaBucket("weekly", 1)],
    },
  ]);
  await service.refreshAgyQuota();
  const resumed = await service.resume("owner-1", {
    workerId: first.worker.id,
    prompt: "continue",
    requestId: "resume-claude",
  });
  const switched = (await waitStatus(service, first.worker.id, ["completed"])).latestRun!;
  assert.ok(["queued", "starting", "running"].includes(resumed.run.status));
  assert.equal(switched.model, "claude-sonnet-4-5");
  assert.equal(switched.nativeSessionId, recorded.nativeSessionId);

  // The same worker with an explicit model keeps that choice even though another pool is open.
  const pinned = await service.resume("owner-1", {
    workerId: first.worker.id,
    prompt: "continue",
    model: "claude-opus-4-1-high",
    requestId: "resume-pinned",
  });
  assert.equal(pinned.run.model, "claude-opus-4-1-high");
  await waitStatus(service, first.worker.id, ["completed"]);

  // A config without a fallback cannot resume while its only pool is closed.
  await quotaRejection(
    service.resume("owner-1", {
      workerId: narrow.worker.id,
      prompt: "continue",
      requestId: "resume-narrow",
    }),
    "gemini",
    resetGemini,
  );
  assert.equal(service.get(narrow.worker.id).runs.length, 1);
});

test("a queued run is served by the config's other pool once its own pool closes", async (t) => {
  const root = temporaryRoot("worker-agy-queued-pools-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const resetGemini = new Date(now + 2 * 3600 * 1000).toISOString();
  const open = [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 1), quotaBucket("weekly", 1)] },
    {
      name: "Claude and GPT models",
      buckets: [quotaBucket("5h", 1), quotaBucket("weekly", 1)],
    },
  ];
  writeUsage(payloadFile, open);
  const { service } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service, [
    poolConfig("agy-dev", "gemini-4-neon-high", "claude-sonnet-4-5"),
  ]);
  await service.refreshAgyQuota();
  // The first run occupies the config's only slot, so the second one stays queued.
  const occupying = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-dev",
      prompt: "[scenario:sleep:1500] hold the slot",
      requestId: "queued-hold",
    }),
  );
  const queued = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-dev", requestId: "queued-waiting" }),
  );
  assert.equal(queued.run.status, "queued");
  assert.equal(queued.run.model, "gemini-4-neon-high");

  // Gemini closes while the second run waits; the shared judgement at start sends it to Claude.
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0, resetGemini)] },
    {
      name: "Claude and GPT models",
      buckets: [quotaBucket("5h", 1), quotaBucket("weekly", 1)],
    },
  ]);
  await service.refreshAgyQuota();
  await waitStatus(service, occupying.worker.id, ["completed"]);
  const served = (await waitStatus(service, queued.worker.id, ["completed"])).latestRun!;
  assert.equal(served.model, "claude-sonnet-4-5");
  assert.match(served.finalText ?? "", /model=claude-sonnet-4-5/);
});

test("a legacy global row never blocks a pool whose quota is known to have room", async (t) => {
  const root = temporaryRoot("worker-agy-legacy-known-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const resetClaude = new Date(now + 3 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0.4), quotaBucket("weekly", 0.9)] },
    { name: "Claude and GPT models", buckets: [quotaBucket("5h", 0, resetClaude)] },
  ]);
  const { service, data } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service, [
    modelConfig("agy-gemini", "gemini-4-neon-high"),
    modelConfig("agy-claude", "claude-sonnet-4-5"),
  ]);
  await service.refreshAgyQuota();
  // An unattributable old row with a far deadline must not outlive what the pools now report.
  const legacy = now + 5 * 86_400_000;
  const db = new Database(path.join(data, "worker.db"));
  try {
    db.prepare("INSERT OR REPLACE INTO cooldowns (engine, until) VALUES (?, ?)").run(
      "agy",
      legacy,
    );
  } finally {
    db.close();
  }
  assert.deepEqual(service.overview().agyCooldowns, [
    { group: "claude-gpt", until: resetClaude },
  ]);
  assert.equal(service.overview().agyCooldownUntil, resetClaude);

  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-gemini", requestId: "legacy-known-open" }),
  );
  assert.equal(
    (await waitStatus(service, started.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-claude", requestId: "legacy-known-closed" }),
    ),
    "claude-gpt",
    resetClaude,
  );
});

test("a known pool reopens at its own reset even while a legacy row is still active", async (t) => {
  const root = temporaryRoot("worker-agy-legacy-expired-");
  const payloadFile = path.join(root, "usage.json");
  let now = Date.parse("2026-11-27T10:00:00Z");
  const resetGemini = new Date(now + 2 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    // Both windows are spent, so the later reset is the one that reopens the pool.
    {
      name: "Gemini Models",
      buckets: [
        quotaBucket("weekly", 0, new Date(now + 6 * 3600 * 1000).toISOString()),
        quotaBucket("5h", 0, resetGemini),
      ],
    },
    {
      name: "Claude and GPT models",
      buckets: [quotaBucket("5h", 1), quotaBucket("weekly", 1)],
    },
  ]);
  const { service, data } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service, [
    modelConfig("agy-gemini", "gemini-4-neon-high"),
    modelConfig("agy-claude", "claude-sonnet-4-5"),
  ]);
  await service.refreshAgyQuota();
  const db = new Database(path.join(data, "worker.db"));
  try {
    db.prepare("INSERT OR REPLACE INTO cooldowns (engine, until) VALUES (?, ?)").run(
      "agy",
      now + 7 * 86_400_000,
    );
  } finally {
    db.close();
  }
  // The pool is known to be spent, so its own deadline is the answer, not the old row.
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-gemini", requestId: "legacy-before-reset" }),
    ),
    "gemini",
    new Date(now + 6 * 3600 * 1000).toISOString(),
  );
  // Once that deadline passes the pool starts again while the legacy row still points at next week.
  now += 6 * 3600 * 1000 + 1000;
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-gemini", requestId: "legacy-after-reset" }),
  );
  assert.equal(
    (await waitStatus(service, started.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );
});

test("a config's fixed reasoning level decides which of its two models a start may use", async (t) => {
  const root = temporaryRoot("worker-agy-effort-pool-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const resetGemini = new Date(now + 2 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    {
      name: "Gemini Models",
      buckets: [
        quotaBucket("weekly", 0, new Date(now + 6 * 3600 * 1000).toISOString()),
        quotaBucket("5h", 0, resetGemini),
      ],
    },
    {
      name: "Claude and GPT models",
      buckets: [quotaBucket("5h", 1), quotaBucket("weekly", 1)],
    },
  ]);
  const { service } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  // The preferred model leaves the level open, the fallback fixes "high".
  configure(service, [
    poolConfig("agy-flex", "gemini-4-neon", "claude-opus-4-1-high"),
    poolConfig("agy-fixed", "gemini-4-neon-high", "claude-opus-4-1-high"),
  ]);
  await service.refreshAgyQuota();

  // With Gemini spent the flexible config falls back and the fallback's own level applies.
  const flexed = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-flex", requestId: "effort-flex" }),
  );
  const flexRun = (await waitStatus(service, flexed.worker.id, ["completed"])).latestRun!;
  assert.equal(flexRun.model, "claude-opus-4-1-high");
  assert.match(flexRun.finalText ?? "", /model=claude-opus-4-1 thought=high/);

  // An explicit "low" cannot be served by a fallback that fixes "high", so the request is held
  // by the Gemini pool instead of launching a conflicting pair.
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({
        type: "agy",
        configId: "agy-flex",
        effort: "low",
        requestId: "effort-conflict",
      }),
    ),
    "gemini",
    new Date(now + 6 * 3600 * 1000).toISOString(),
  );
  // An explicit "high" matches both rows, so the fallback serves it with that level.
  const matched = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-flex",
      effort: "high",
      requestId: "effort-match",
    }),
  );
  const matchedRun = (await waitStatus(service, matched.worker.id, ["completed"])).latestRun!;
  assert.equal(matchedRun.model, "claude-opus-4-1-high");
  assert.equal(matchedRun.effort, "high");
  assert.match(matchedRun.finalText ?? "", /thought=high/);
});

test("resume keeps the run's effort, so only a matching pool may stand in", async (t) => {
  const root = temporaryRoot("worker-agy-effort-resume-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const resetGemini = new Date(now + 2 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 1), quotaBucket("weekly", 1)] },
    {
      name: "Claude and GPT models",
      buckets: [quotaBucket("5h", 1), quotaBucket("weekly", 1)],
    },
  ]);
  const { service } = createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        agy: quotaAgyExecutable(root, payloadFile),
        "agy-acp": agyAcpFixture,
      },
    },
  );
  configure(service, [
    poolConfig("agy-flex", "gemini-4-neon", "claude-opus-4-1-high"),
  ]);
  await service.refreshAgyQuota();
  const started = await service.start(
    "owner-1",
    startInput({
      type: "agy",
      configId: "agy-flex",
      effort: "low",
      prompt: "[scenario:rate-limit] limited",
      requestId: "effort-resume-first",
    }),
  );
  await waitStatus(service, started.worker.id, ["failed"]);
  // The failed run cooled its own Gemini pool; resume would have to use the fallback, which fixes
  // "high" while the run's effort is "low", so the resume is refused instead of switching.
  await quotaRejection(
    service.resume("owner-1", {
      workerId: started.worker.id,
      prompt: "again",
      requestId: "effort-resume-low",
    }),
    "gemini",
  );
  await service.refreshAgyQuota();
  // A "high" resume may use the fallback, and it keeps that level.
  const switched = await service.resume("owner-1", {
    workerId: started.worker.id,
    effort: "high",
    prompt: "[scenario:ok] again",
    requestId: "effort-resume-high",
  });
  const resumed = (await waitStatus(service, started.worker.id, ["running", "completed", "failed"]))
    .latestRun!;
  assert.equal(resumed.id, switched.run.id);
  assert.equal(resumed.model, "claude-opus-4-1-high");
  assert.equal(resumed.effort, "high");
});
