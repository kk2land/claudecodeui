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
    environment: environment(root),
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
