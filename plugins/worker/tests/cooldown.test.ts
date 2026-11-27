import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { WorkerConfig } from "../shared/contracts.js";
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

test("agy ACP 429 reset hint sets the parsed global deadline and keeps the failed run resumable", async (t) => {
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
  const resumed = await service.resume("owner-1", {
    workerId: failed.id,
    prompt: "retry after quota",
    requestId: "agy-429-resume",
  });
  assert.equal(resumed.run.status, "queued");
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

test("cooldown blocks every agy config without delaying Pi", async (t) => {
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

  const blocked = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-short", requestId: "blocked" }),
  );
  assert.equal(blocked.run.status, "queued");

  fs.writeFileSync(path.join(root, "release-short"), "");
  await waitStatus(service, short.worker.id, ["failed"]);
  assert.equal(Date.parse(service.overview().agyCooldownUntil!), firstDeadline);
});

test("a queued agy run resumes automatically when the deadline expires", async (t) => {
  const root = temporaryRoot("worker-agy-expiry-");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "rate-limit",
    TEST_AGY_RESET_TEXT: "Resets in 1s",
  });
  configure(service);
  const first = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "expiry-first" }),
  );
  await waitStatus(service, first.worker.id, ["failed"]);
  const queued = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "expiry-queued" }),
  );
  assert.equal(queued.run.status, "queued");
  await waitStatus(service, queued.worker.id, ["failed"], 10_000);
});

test("the stored deadline and queued agy run survive a real close and reopen", async (t) => {
  const root = temporaryRoot("worker-agy-restart-");
  const { service, data, project } = createService(t, root, {
    TEST_SCENARIO: "rate-limit",
    TEST_AGY_RESET_TEXT: "Resets in 2h",
  });
  configure(service);
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "restart-first" }),
  );
  await waitStatus(service, started.worker.id, ["failed"]);
  const deadline = service.overview().agyCooldownUntil;
  const blocked = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "restart-queued" }),
  );
  assert.equal(blocked.run.status, "queued");
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
  assert.deepEqual(reopened.overview().agyCooldownUntil, deadline);
  assert.equal(reopened.get(blocked.worker.id).worker.latestRun?.status, "queued");
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
  );
  assert.equal(queued.run.status, "queued");
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

test("exhausted Gemini Models quota activates shared AGY cooldown for auto and manual polls without blocking Pi", async (t) => {
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

  // Every AGY config queues while Pi still executes and completes.
  const agyA = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-a", requestId: "quota-agy-a" }),
  );
  const agyB = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-b", requestId: "quota-agy-b" }),
  );
  assert.equal(agyA.run.status, "queued");
  assert.equal(agyB.run.status, "queued");
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
  // Queued AGY runs stay queued rather than waking prematurely in 1 ms.
  assert.equal(service.get(agyA.worker.id).worker.latestRun?.status, "queued");
});

test("quota checks keep existing runtime cooldown, fall back to 60s without future reset, and ignore sub-0.5% or non-Gemini exhaustion", async (t) => {
  const root = temporaryRoot("worker-agy-quota-preserve-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");

  // 1. Sub-0.5% positive Gemini quota (displays 0%) and exhausted Claude/GPT must not trigger cooldown.
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
  assert.equal(service.overview().agyCooldownUntil, null);

  // 2. Runtime AGY 429 cooldown (2h) is neither cleared by positive quota nor shortened by a 10m reset.
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
