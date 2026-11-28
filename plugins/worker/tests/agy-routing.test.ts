import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AGY_QUOTA_GROUP_LABELS, type AgyQuotaGroupKind } from "../shared/agy.js";
import type { WorkerConfig, WorkerStartInput } from "../shared/contracts.js";
import {
  agyAcpFixture,
  createService,
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
    concurrency: 2,
    hardTimeoutSeconds: 600,
    model: null,
    effort: null,
    ...(type === "codex"
      ? { codex: { modelProvider: "magpie", env: {}, legacyExtraArgs: [] } }
      : {}),
  };
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

function quotaService(
  t: TestContext,
  root: string,
  now: number,
  payloadFile: string | null,
) {
  return createService(
    t,
    root,
    {},
    {
      now: () => now,
      executablePaths: {
        pi: piFixture,
        // A null payload models "no usable quota data at all": the probe is not executable.
        ...(payloadFile === null ? {} : { agy: quotaAgyExecutable(root, payloadFile) }),
        "agy-acp": agyAcpFixture,
      },
    },
  );
}

test("auto routing skips an exhausted pool for the next AGY candidate", async (t) => {
  const root = temporaryRoot("worker-agy-route-skip-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const reset5h = new Date(now + 2 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0, reset5h)] },
    { name: "Claude and GPT models", buckets: [quotaBucket("weekly", 1)] },
  ]);
  const { service } = quotaService(t, root, now, payloadFile);
  service.updateSettings({
    // The account's default selection is the Gemini-model config that the pool has closed.
    configs: [
      modelConfig("agy-dev", "gemini-4-neon-high"),
      modelConfig("agy-claude", "claude-sonnet-4-5"),
      config("pi"),
    ],
    defaultConfigId: "agy-dev",
  });
  await service.refreshAgyQuota();

  const started = await service.start("owner-1", autoInput({ requestId: "route-skip" }));
  assert.equal(started.worker.configId, "agy-claude");
  assert.equal(started.run.model, "claude-sonnet-4-5");
  assert.equal(
    (await waitStatus(service, started.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );

  // An explicit engine still stays inside that engine instead of falling back to Pi.
  const typed = await service.start(
    "owner-1",
    startInput({ type: "agy", requestId: "route-skip-typed" }),
  );
  assert.equal(typed.worker.configId, "agy-claude");
  await waitStatus(service, typed.worker.id, ["completed"]);
});

test("both exhausted pools send an automatic dispatch to Pi and refuse fixed AGY requests", async (t) => {
  const root = temporaryRoot("worker-agy-route-all-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const resetGemini = new Date(now + 3600 * 1000).toISOString();
  const resetClaude = new Date(now + 2 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0, resetGemini)] },
    { name: "Claude and GPT models", buckets: [quotaBucket("weekly", 0, resetClaude)] },
  ]);
  const { service } = quotaService(t, root, now, payloadFile);
  service.updateSettings({
    configs: [
      modelConfig("agy-dev", "gemini-4-neon-high"),
      modelConfig("agy-claude", "claude-sonnet-4-5"),
      config("pi"),
    ],
    defaultConfigId: "agy-dev",
  });
  await service.refreshAgyQuota();

  const routed = await service.start("owner-1", autoInput({ requestId: "route-all" }));
  assert.equal(routed.worker.configId, "pi-default");
  assert.equal(
    (await waitStatus(service, routed.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );

  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-dev", requestId: "route-all-gemini" }),
    ),
    "gemini",
    resetGemini,
  );
  // The refusal is not persisted, so even the same requestId is judged again.
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-dev", requestId: "route-all-gemini" }),
    ),
    "gemini",
    resetGemini,
  );
  // The refusals allocated no agy worker; only the completed Pi run ever existed.
  assert.equal(
    service.overview().workers.some((worker) => worker.type === "agy"),
    false,
  );
});

test("an explicit model override decides the pool, and a locked engine never swaps to Pi", async (t) => {
  const root = temporaryRoot("worker-agy-route-model-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const reset5h = new Date(now + 2 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0, reset5h)] },
    { name: "Claude and GPT models", buckets: [quotaBucket("weekly", 1)] },
  ]);
  const { service } = quotaService(t, root, now, payloadFile);
  service.updateSettings({
    configs: [modelConfig("agy-dev", "gemini-4-neon-high"), config("pi")],
    defaultConfigId: "agy-dev",
  });
  await service.refreshAgyQuota();

  // The requested Claude model belongs to the open pool, so the same config may run it.
  const override = await service.start(
    "owner-1",
    autoInput({ model: "claude-opus-4-1-high", requestId: "route-model-open" }),
  );
  assert.equal(override.worker.configId, "agy-dev");
  assert.equal(override.run.model, "claude-opus-4-1-high");
  assert.equal(
    (await waitStatus(service, override.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );

  // A pinned native model keeps the AGY engine: no silent re-route to Pi with a different model.
  await quotaRejection(
    service.start(
      "owner-1",
      autoInput({ model: "gemini-4-neon-high", requestId: "route-model-locked" }),
    ),
    "gemini",
    reset5h,
  );
});

test("resume uses the worker's pool and accepts an override from the open pool", async (t) => {
  const root = temporaryRoot("worker-agy-route-resume-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const reset5h = new Date(now + 2 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0.9)] },
    { name: "Claude and GPT models", buckets: [quotaBucket("weekly", 1)] },
  ]);
  const { service } = quotaService(t, root, now, payloadFile);
  service.updateSettings({
    configs: [modelConfig("agy-dev", "gemini-4-neon-high"), config("pi")],
    defaultConfigId: "agy-dev",
  });
  await service.refreshAgyQuota();
  const first = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-dev", requestId: "route-resume-first" }),
  );
  await waitStatus(service, first.worker.id, ["completed"]);

  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0, reset5h)] },
    { name: "Claude and GPT models", buckets: [quotaBucket("weekly", 1)] },
  ]);
  await service.refreshAgyQuota();

  const runs = service.get(first.worker.id).runs.length;
  await quotaRejection(
    service.resume("owner-1", {
      workerId: first.worker.id,
      prompt: "resume in the closed pool",
      requestId: "route-resume-blocked",
    }),
    "gemini",
    reset5h,
  );
  assert.equal(service.get(first.worker.id).runs.length, runs);

  const override = await service.resume("owner-1", {
    workerId: first.worker.id,
    prompt: "resume with a model from the open pool",
    model: "claude-sonnet-4-5",
    requestId: "route-resume-open",
  });
  assert.equal(override.worker.id, first.worker.id);
  assert.equal(
    (await waitStatus(service, first.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );
});

test("an accepted requestId replay keeps its run after the pool closes", async (t) => {
  const root = temporaryRoot("worker-agy-route-replay-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const reset5h = new Date(now + 2 * 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0.9)] },
    { name: "Claude and GPT models", buckets: [quotaBucket("weekly", 1)] },
  ]);
  const { service } = quotaService(t, root, now, payloadFile);
  service.updateSettings({
    configs: [modelConfig("agy-dev", "gemini-4-neon-high"), config("pi")],
    defaultConfigId: "agy-dev",
  });
  await service.refreshAgyQuota();
  const first = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-dev", requestId: "route-replay" }),
  );
  await waitStatus(service, first.worker.id, ["completed"]);

  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0, reset5h)] },
    { name: "Claude and GPT models", buckets: [quotaBucket("weekly", 1)] },
  ]);
  await service.refreshAgyQuota();

  const replay = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-dev", requestId: "route-replay" }),
  );
  assert.equal(replay.worker.id, first.worker.id);
  assert.equal(replay.run.id, first.run.id);
  await quotaRejection(
    service.start(
      "owner-1",
      startInput({ type: "agy", configId: "agy-dev", requestId: "route-replay-new" }),
    ),
    "gemini",
    reset5h,
  );
});

test("missing or unknown quota data keeps routing the configured AGY model", async (t) => {
  const now = Date.parse("2026-11-27T10:00:00Z");
  // 1. No executable probe at all: the snapshot reports an error and nothing is blocked.
  const emptyRoot = temporaryRoot("worker-agy-route-nodata-");
  const empty = quotaService(t, emptyRoot, now, null);
  empty.service.updateSettings({
    configs: [modelConfig("agy-dev", "gemini-4-neon-high"), config("pi")],
    defaultConfigId: "agy-dev",
  });
  const failed = await empty.service.refreshAgyQuota();
  assert.equal(failed.status, "error");
  assert.deepEqual(empty.service.overview().agyCooldowns, []);
  const routed = await empty.service.start("owner-1", autoInput({ requestId: "route-nodata" }));
  assert.equal(routed.worker.configId, "agy-dev");
  assert.equal(
    (await waitStatus(empty.service, routed.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );

  // 2. A payload whose groups are unknown keeps the same behavior.
  const unknownRoot = temporaryRoot("worker-agy-route-unknown-");
  const payloadFile = path.join(unknownRoot, "usage.json");
  writeUsage(payloadFile, [
    { name: "Orchestrator Models", buckets: [quotaBucket("weekly", 0)] },
  ]);
  const unknown = quotaService(t, unknownRoot, now, payloadFile);
  unknown.service.updateSettings({
    configs: [modelConfig("agy-dev", "gemini-4-neon-high"), config("pi")],
    defaultConfigId: "agy-dev",
  });
  await unknown.service.refreshAgyQuota();
  assert.deepEqual(unknown.service.overview().agyCooldowns, []);
  const kept = await unknown.service.start("owner-1", autoInput({ requestId: "route-unknown" }));
  assert.equal(kept.worker.configId, "agy-dev");
  await waitStatus(unknown.service, kept.worker.id, ["completed"]);
});

test("an AGY config whose Gemini pool is spent is still routed through its Claude fallback", async (t) => {
  const root = temporaryRoot("worker-agy-route-fallback-");
  const payloadFile = path.join(root, "usage.json");
  const now = Date.parse("2026-11-27T10:00:00Z");
  const reset5h = new Date(now + 3600 * 1000).toISOString();
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0, reset5h)] },
    {
      name: "Claude and GPT models",
      buckets: [quotaBucket("5h", 0.09), quotaBucket("weekly", 0.31)],
    },
  ]);
  const { service } = quotaService(t, root, now, payloadFile);
  service.updateSettings({
    configs: [
      {
        ...modelConfig("agy-dev", "gemini-4-neon-high"),
        agy: { fallbackModel: "claude-sonnet-4-5" },
      },
      config("pi"),
    ],
    defaultConfigId: "agy-dev",
  });
  await service.refreshAgyQuota();
  const routed = await service.start("owner-1", autoInput({ requestId: "route-fallback" }));
  // The default config keeps the task instead of falling through to Pi.
  assert.equal(routed.worker.configId, "agy-dev");
  const done = (await waitStatus(service, routed.worker.id, ["completed"])).latestRun!;
  assert.equal(done.model, "claude-sonnet-4-5");
  assert.match(done.finalText ?? "", /model=claude-sonnet-4-5/);

  // With both pools closed the same config is skipped and Pi takes the request.
  writeUsage(payloadFile, [
    { name: "Gemini Models", buckets: [quotaBucket("5h", 0, reset5h)] },
    { name: "Claude and GPT models", buckets: [quotaBucket("5h", 0, reset5h)] },
  ]);
  await service.refreshAgyQuota();
  const fallen = await service.start("owner-1", autoInput({ requestId: "route-fallback-pi" }));
  assert.equal(fallen.worker.configId, "pi-default");
  assert.equal(
    (await waitStatus(service, fallen.worker.id, ["completed"])).latestRun?.status,
    "completed",
  );
});
