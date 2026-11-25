import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { WorkerService } from "../server/service.js";
import { WorkerStore } from "../server/store.js";
import type { WorkerConfig, WorkerMcpSettings } from "../shared/contracts.js";
import {
  createService,
  owner,
  startInput,
  temporaryRoot,
  waitStatus,
} from "./helpers.js";

function piNamed(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    id: "dsh-default",
    name: "Pi default (legacy id)",
    type: "pi",
    enabled: true,
    roles: [],
    concurrency: 3,
    hardTimeoutSeconds: 300,
    model: null,
    effort: null,
    ...overrides,
  };
}

function pi(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    id: "pi-default",
    name: "Pi default",
    type: "pi",
    enabled: true,
    roles: [],
    concurrency: 3,
    hardTimeoutSeconds: 300,
    model: null,
    effort: null,
    ...overrides,
  };
}

function codex(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    id: "codex-default",
    name: "Codex default",
    type: "codex",
    enabled: true,
    roles: [],
    concurrency: 3,
    hardTimeoutSeconds: 300,
    model: null,
    effort: null,
    codex: {
      modelProvider: "magpie",
      env: { CODEX_PROXY_BYPASS: "1" },
      legacyExtraArgs: [],
    },
    ...overrides,
  };
}

test("canonical settings persist only canonical fields and project per-engine defaults", async (t) => {
  const root = temporaryRoot("worker-configs-canonical-");
  const { service, data } = createService(t, root);
  const configs = [
    piNamed({ name: "Fast DSH", concurrency: 2, roles: ["development"], model: "dsh-m", effort: "high" }),
    pi({ id: "cfg-pi-openrouter", name: "OpenRouter", concurrency: 1, model: "openrouter/fast", effort: "low" }),
    pi({ enabled: false }),
    codex(),
  ];
  const saved = service.updateSettings({
    configs,
    defaultConfigId: "dsh-default",
    retentionDays: 4,
  });
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.defaultWorkerType, "pi");
  assert.equal(saved.defaultConfigId, "dsh-default");
  assert.deepEqual(saved.concurrency, { dsh: 1, pi: 2, codex: 3, agy: 1 });
  assert.deepEqual(saved.enabled, { dsh: false, pi: true, codex: true, agy: false });
  assert.deepEqual(saved.roles, { dsh: [], pi: ["development"], codex: [], agy: [] });
  assert.deepEqual(saved.defaults, {
    dsh: { model: null, effort: null },
    // The default config is Pi, so it supplies the Pi projection.
    pi: { model: "dsh-m", effort: "high" },
    codex: { model: null, effort: null },
    agy: { model: null, effort: null },
  });
  assert.deepEqual(saved.codex, {
    env: { CODEX_PROXY_BYPASS: "1" },
    extraArgs: ["-c", "model_provider=magpie"],
  });
  assert.equal(saved.retentionDays, 4);

  const database = new Database(path.join(data, "worker.db"), { readonly: true });
  t.after(() => database.close());
  const row = database
    .prepare("SELECT body FROM settings WHERE id=1")
    .get() as { body: string };
  const persisted = JSON.parse(row.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(persisted).sort(), [
    "configs",
    "defaultConfigId",
    "retentionDays",
    "schemaVersion",
    "softReminderSeconds",
    "softReminderSteps",
  ]);

  const reopened = new WorkerStore(data);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.settings().configs, configs);
  assert.equal(reopened.settings().retentionDays, 4);
});

test("ACP idle settings default, use the env fallback, persist explicit saves, and keep omissions", async (t) => {
  const root = temporaryRoot("worker-configs-acp-idle-");
  const { service, data } = createService(t, root, {
    CLOUDCLI_WORKER_ACP_IDLE_TIMEOUT_SECONDS: "7",
  });
  assert.equal(service.settings().acpIdleTimeoutSeconds, 7);
  const current = service.settings();
  const base = {
    configs: current.configs,
    defaultConfigId: current.defaultConfigId,
  };
  const persisted = (): Record<string, unknown> => {
    const database = new Database(path.join(data, "worker.db"), { readonly: true });
    try {
      const row = database
        .prepare("SELECT body FROM settings WHERE id=1")
        .get() as { body: string };
      return JSON.parse(row.body) as Record<string, unknown>;
    } finally {
      database.close();
    }
  };

  // An unrelated save keeps the env fallback available instead of materializing it.
  const untouched = service.updateSettings({ ...base, retentionDays: 2 });
  assert.equal(untouched.acpIdleTimeoutSeconds, 7);
  assert.equal("acpIdleTimeoutSeconds" in persisted(), false);
  const fallbackStore = new WorkerStore(data, { acpIdleTimeoutSeconds: 11 });
  t.after(() => fallbackStore.close());
  assert.equal(fallbackStore.settings().acpIdleTimeoutSeconds, 11);

  const saved = service.updateSettings({ ...base, acpIdleTimeoutSeconds: 42 });
  assert.equal(saved.acpIdleTimeoutSeconds, 42);
  assert.equal(persisted().acpIdleTimeoutSeconds, 42);
  const kept = service.updateSettings({ ...base, retentionDays: 3 });
  assert.equal(kept.acpIdleTimeoutSeconds, 42);
  const reopened = new WorkerStore(data, { acpIdleTimeoutSeconds: 5 });
  t.after(() => reopened.close());
  assert.equal(reopened.settings().acpIdleTimeoutSeconds, 42);
  const serviceWithNewEnv = new WorkerService({
    dataDirectory: data,
    environment: {
      ...process.env,
      CLOUDCLI_WORKER_ACP_IDLE_TIMEOUT_SECONDS: "5",
    },
  });
  t.after(async () => {
    await serviceWithNewEnv.close();
  });
  assert.equal(serviceWithNewEnv.settings().acpIdleTimeoutSeconds, 42);
});

test("ACP idle settings default to five minutes and reject invalid values atomically", async (t) => {
  const root = temporaryRoot("worker-configs-acp-idle-invalid-");
  const { service, data } = createService(t, root);
  assert.equal(service.settings().acpIdleTimeoutSeconds, 300);
  const current = service.settings();
  const base = {
    configs: current.configs,
    defaultConfigId: current.defaultConfigId,
  };
  for (const value of [0, -1, 1.5, 2_147_484, "5", null]) {
    assert.throws(
      () =>
        service.updateSettings({
          ...base,
          acpIdleTimeoutSeconds: value as unknown as number,
        }),
      /acpIdleTimeoutSeconds/,
    );
  }
  assert.equal(service.settings().acpIdleTimeoutSeconds, 300);
  const database = new Database(path.join(data, "worker.db"), { readonly: true });
  t.after(() => database.close());
  const row = database
    .prepare("SELECT body FROM settings WHERE id=1")
    .get() as { body: string };
  assert.equal("acpIdleTimeoutSeconds" in JSON.parse(row.body), false);
});

test("config timeouts apply independently to starts and resumes with per-run overrides", async (t) => {
  const root = temporaryRoot("worker-configs-timeout-");
  const { service, env } = createService(t, root);
  const configs = [
    piNamed({ hardTimeoutSeconds: 60 }),
    piNamed({ id: "dsh-unlimited", hardTimeoutSeconds: null }),
  ];
  service.updateSettings({ configs, defaultConfigId: "dsh-default" });
  assert.deepEqual(
    (service.context("owner-1").settings as WorkerMcpSettings).configs.map((config) => config.hardTimeoutSeconds),
    [60, null],
  );
  const first = await service.start("owner-1", startInput());
  const unlimited = await service.start("owner-1", startInput({ configId: "dsh-unlimited" }));
  const overridden = await service.start("owner-1", startInput({ timeoutSeconds: 45 }));
  const disabled = await service.start("owner-1", startInput({ timeoutSeconds: null }));
  assert.equal(first.run.timeoutSeconds, 60);
  assert.equal(unlimited.run.timeoutSeconds, null);
  assert.equal(overridden.run.timeoutSeconds, 45);
  assert.equal(disabled.run.timeoutSeconds, null);
  const completedOverridden = await waitStatus(service, overridden.worker.id, ["completed"]);

  service.updateSettings({
    configs: [piNamed({ hardTimeoutSeconds: 600 }), configs[1]!],
    defaultConfigId: "dsh-default",
  });
  assert.equal(service.get(first.worker.id).worker.latestRun?.timeoutSeconds, 60);
  env.TEST_SESSION_ID = completedOverridden.latestRun!.nativeSessionId!;
  const resumed = await service.resume("owner-1", {
    workerId: overridden.worker.id,
    prompt: "continue",
    requestId: "resume-config-timeout",
  });
  assert.equal(resumed.run.timeoutSeconds, 600);
  await waitStatus(service, resumed.worker.id, ["completed"]);
  const resumeOverride = await service.resume("owner-1", {
    workerId: resumed.worker.id,
    prompt: "continue with a per-run timeout",
    requestId: "resume-timeout-override",
    timeoutSeconds: 90,
  });
  assert.equal(resumeOverride.run.timeoutSeconds, 90);
});

test("config timeout defaults to 600 and rejects invalid values atomically", (t) => {
  const root = temporaryRoot("worker-configs-timeout-validation-");
  const { service } = createService(t, root);
  const config = piNamed();
  delete (config as Partial<WorkerConfig>).hardTimeoutSeconds;
  const saved = service.updateSettings({ configs: [config], defaultConfigId: config.id });
  assert.equal(saved.configs[0]!.hardTimeoutSeconds, 600);
  for (const hardTimeoutSeconds of [0, -1, 1.5, "300", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => service.updateSettings({
        configs: [piNamed({ hardTimeoutSeconds: hardTimeoutSeconds as number })],
        defaultConfigId: config.id,
      }),
      /hardTimeoutSeconds 必须是正整数或 null/,
    );
    assert.deepEqual(service.settings(), saved);
  }
});

test("config routing filters by enabled configs, type, role, then default and list order", async (t) => {
  const root = temporaryRoot("worker-configs-routing-");
  const { service } = createService(t, root);
  const configs = [
    piNamed({ roles: ["testing"], concurrency: 1 }),
    pi({ roles: ["testing"], concurrency: 1 }),
    codex(),
    pi({ id: "pi-plan", name: "Pi plan", roles: ["plan_review"], concurrency: 1 }),
  ];
  service.updateSettings({ configs, defaultConfigId: "dsh-default" });
  const started: string[] = [];
  const start = async (overrides: Parameters<typeof startInput>[0]) => {
    const result = await service.start("owner-1", startInput(overrides));
    started.push(result.worker.id);
    return result.worker;
  };

  // Both Pi configs accept `testing`; the first list entry is selected, which here is also the
  // default config.
  assert.equal((await start({ type: undefined, taskRole: "testing" })).configId, "dsh-default");
  // Only the matching config for the role.
  assert.equal((await start({ type: undefined, taskRole: "plan_review" })).configId, "pi-plan");
  // No role match falls back to the default, not to the first list entry.
  assert.equal((await start({ type: undefined, taskRole: "code_review" })).configId, "dsh-default");
  // Explicit type constrains candidates; no role match returns that type's config.
  assert.equal((await start({ type: "codex", taskRole: "testing" })).configId, "codex-default");
  // Explicit configId is authoritative.
  assert.equal((await start({ configId: "pi-plan", type: undefined })).configId, "pi-plan");

  await assert.rejects(
    () => start({ configId: "pi-plan", type: "codex" }),
    /configId 与 type 不一致/,
  );
  await assert.rejects(
    () => start({ configId: "missing-config", type: undefined }),
    /worker 配置不存在/,
  );

  service.updateSettings({
    configs: configs.map((config) =>
      config.type === "pi" ? { ...config, enabled: false } : config,
    ),
    defaultConfigId: "codex-default",
  });
  await assert.rejects(
    () => start({ configId: "pi-plan", type: undefined }),
    /该 worker 配置已停用/,
  );
  await assert.rejects(
    () => start({ type: "pi" }),
    /该 worker 类型已禁用/,
  );

  for (const workerId of started)
    await waitStatus(service, workerId, ["completed"]);
});

test("role routing follows persisted config order instead of the default config", async (t) => {
  const root = temporaryRoot("worker-configs-order-");
  const { service, data } = createService(t, root);
  const piA = pi({ id: "pi-a", name: "Pi A", roles: ["testing"], concurrency: 1 });
  const dshDefault = piNamed({ roles: ["testing"], concurrency: 1 });
  // The default config is deliberately after another config that accepts the same role.
  service.updateSettings({
    configs: [piA, dshDefault],
    defaultConfigId: "dsh-default",
  });
  const started: string[] = [];
  const start = async (overrides: Parameters<typeof startInput>[0] = {}) => {
    const result = await service.start(
      "owner-1",
      startInput({ type: undefined, ...overrides }),
    );
    started.push(result.worker.id);
    return result;
  };

  // First matching config in list order wins; the default does not override it.
  assert.equal((await start({ taskRole: "testing" })).worker.configId, "pi-a");
  // Without a role the default still wins over the first list entry.
  assert.equal((await start()).worker.configId, "dsh-default");
  // An unmatched role falls back to the default, not to the first candidate.
  assert.equal((await start({ taskRole: "code_review" })).worker.configId, "dsh-default");
  // Explicit type narrows the candidates before the role match.
  assert.equal((await start({ type: "pi", taskRole: "testing" })).worker.configId, "pi-a");

  // A disabled earlier entry is skipped in favour of the next match.
  service.updateSettings({
    configs: [{ ...piA, enabled: false }, dshDefault],
    defaultConfigId: "dsh-default",
  });
  assert.equal((await start({ taskRole: "testing" })).worker.configId, "dsh-default");

  // Reordering through the canonical settings save changes selection, and the new order persists.
  service.updateSettings({
    configs: [dshDefault, piA],
    defaultConfigId: "dsh-default",
  });
  assert.equal((await start({ taskRole: "testing" })).worker.configId, "dsh-default");
  const reopened = new WorkerStore(data).settings();
  assert.deepEqual(
    reopened.configs.map((config) => config.id),
    ["dsh-default", "pi-a"],
  );
  assert.equal(reopened.defaultConfigId, "dsh-default");

  // Replaying an accepted request keeps its original config after the order changes.
  const request = startInput({
    type: undefined,
    taskRole: "testing",
    requestId: "config-order-replay",
  });
  const original = await service.start("owner-1", request);
  started.push(original.worker.id);
  service.updateSettings({
    configs: [piA, dshDefault],
    defaultConfigId: "dsh-default",
  });
  const replayed = await service.start("owner-1", request);
  assert.equal(replayed.run.id, original.run.id);
  assert.equal(replayed.worker.configId, "dsh-default");

  for (const workerId of started)
    await waitStatus(service, workerId, ["completed"]);
});

test("worker records snapshot config identity and rename keeps the id", async (t) => {
  const root = temporaryRoot("worker-configs-identity-");
  const { service } = createService(t, root);
  const configs = [piNamed({ name: "Before rename" }), pi(), codex()];
  service.updateSettings({ configs, defaultConfigId: "dsh-default" });
  const started = await service.start(
    "owner-1",
    startInput({ configId: "dsh-default" }),
  );
  assert.equal(started.worker.configId, "dsh-default");
  assert.equal(started.worker.configName, "Before rename");
  await waitStatus(service, started.worker.id, ["completed"]);

  service.updateSettings({
    configs: configs.map((config) =>
      config.id === "dsh-default"
        ? { ...config, name: "After rename", concurrency: 2 }
        : config,
    ),
    defaultConfigId: "dsh-default",
  });
  assert.equal(service.get(started.worker.id).worker.configName, "Before rename");
  const next = await service.start(
    "owner-1",
    startInput({ configId: "dsh-default" }),
  );
  assert.equal(next.worker.configId, "dsh-default");
  assert.equal(next.worker.configName, "After rename");
  await waitStatus(service, next.worker.id, ["completed"]);
});

test("configUsage is global, active runs block deletion, history locks engine and id reuse", async (t) => {
  const root = temporaryRoot("worker-configs-usage-");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "400",
  });
  const configs = [
    piNamed({ concurrency: 1 }),
    piNamed({ id: "dsh-alt", name: "Alt DSH", concurrency: 1 }),
    piNamed({ id: "dsh-unused", name: "Unused DSH", concurrency: 1 }),
    pi(),
    codex(),
  ];
  service.updateSettings({ configs, defaultConfigId: "dsh-default" });
  service.registerOwner(
    { ...owner(path.join(root, "project")), id: "owner-2", projectId: "project-2" },
    "owner-token-2",
  );
  const referenced = await service.start(
    "owner-1",
    startInput({ configId: "dsh-default", requestId: "usage-terminal" }),
  );
  await waitStatus(service, referenced.worker.id, ["completed"]);
  const started = await service.start(
    "owner-1",
    startInput({ configId: "dsh-alt", requestId: "usage-active" }),
  );
  await waitStatus(service, started.worker.id, ["running"]);
  // A different project's filtered state still reports whole-store usage.
  const filtered = service.state({ projectId: "project-2" });
  assert.deepEqual(filtered.configUsage["dsh-alt"], {
    referenced: true,
    activeRuns: 1,
  });
  assert.throws(
    () =>
      service.updateSettings({
        configs: configs.filter((config) => config.id !== "dsh-alt"),
        defaultConfigId: "dsh-default",
      }),
    /活动运行/,
  );
  await waitStatus(service, started.worker.id, ["completed"]);

  // Terminal history no longer blocks deletion, but keeps the id referenced.
  service.updateSettings({
    configs: configs.filter((config) => config.id !== "dsh-alt"),
    defaultConfigId: "dsh-default",
  });
  assert.deepEqual(service.state().configUsage["dsh-alt"], {
    referenced: true,
    activeRuns: 0,
  });
  assert.throws(
    () =>
      service.updateSettings({
        configs: [
          ...configs.filter((config) => config.id !== "dsh-alt"),
          piNamed({ id: "dsh-alt", name: "Reused" }),
        ],
        defaultConfigId: "dsh-default",
      }),
    /历史记录引用/,
  );
  assert.throws(
    () =>
      service.updateSettings({
        configs: configs.map((config) =>
          config.id === "dsh-default" ? codex({ id: "dsh-default" }) : config,
        ),
        defaultConfigId: "dsh-default",
      }),
    /不能修改执行引擎/,
  );
  // An unreferenced config may change engines.
  const changedEngine = service.updateSettings({
    configs: configs
      .filter((config) => config.id !== "dsh-alt")
      .map((config) =>
        config.id === "dsh-unused" ? codex({ id: "dsh-unused", name: "Unused" }) : config,
      ),
    defaultConfigId: "dsh-default",
  });
  assert.equal(
    changedEngine.configs.find((config) => config.id === "dsh-unused")?.type,
    "codex",
  );
});

test("legacy PUT edits renamed initial configs by id and rejects missing ones", async (t) => {
  const root = temporaryRoot("worker-configs-legacy-");
  const { service } = createService(t, root);
  service.updateSettings({
    configs: [piNamed({ name: "Renamed DSH" }), pi(), codex()],
    defaultConfigId: "dsh-default",
  });
  const updated = service.updateSettings({
    concurrency: { pi: 2 },
    roles: { pi: [], codex: [] },
  });
  assert.equal(updated.configs.find((config) => config.id === "dsh-default")?.name, "Renamed DSH");
  assert.equal(updated.concurrency.pi, 3);

  service.updateSettings({
    configs: [piNamed(), pi(), codex()].filter((config) => config.id !== "codex-default"),
    defaultConfigId: "dsh-default",
  });
  assert.throws(
    () =>
      service.updateSettings({
        concurrency: { pi: 1 },
        codex: { env: {}, extraArgs: [] },
      }),
    /初始配置 codex-default 已不存在/,
  );
});

test("legacy Codex launch blocks extract the service and keep a consistent projection", async (t) => {
  const root = temporaryRoot("worker-configs-codex-launch-");
  const { service, data } = createService(t, root);
  const saved = service.updateSettings({
    concurrency: { pi: 3 },
    codex: {
      env: { CUSTOM: "value" },
      extraArgs: ["--sandbox", "read-only", "-c", "model_provider=args-provider", "--search"],
    },
  });
  assert.deepEqual(
    saved.configs.find((config) => config.id === "codex-default")?.codex,
    {
      modelProvider: "args-provider",
      env: { CUSTOM: "value" },
      legacyExtraArgs: ["--sandbox", "read-only", "--search"],
    },
  );
  assert.deepEqual(saved.codex, {
    env: { CUSTOM: "value" },
    extraArgs: ["--sandbox", "read-only", "--search", "-c", "model_provider=args-provider"],
  });
  const started = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "codex-launch-extracted" }),
  );
  const worker = await waitStatus(service, started.worker.id, ["completed"]);
  assert.equal(worker.latestRun?.provider, "args-provider");
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(data, "logs", worker.id, worker.latestRun!.id, "spec.json"),
      "utf8",
    ),
  ) as { argv: string[] };
  assert.equal(
    spec.argv.filter((value) => value.includes("model_provider=")).length,
    1,
  );
  assert.ok(spec.argv.includes('model_provider="args-provider"'));

  const cleared = service.updateSettings({
    concurrency: { pi: 3 },
    codex: { env: {}, extraArgs: [] },
  });
  assert.equal(
    cleared.configs.find((config) => config.id === "codex-default")?.codex
      ?.modelProvider,
    null,
  );
  assert.deepEqual(cleared.codex, { env: {}, extraArgs: [] });
});

test("replays survive config disable and deletion while new requests still route", async (t) => {
  const root = temporaryRoot("worker-configs-replay-");
  const { service } = createService(t, root);
  const configs = [
    piNamed({ roles: ["testing"] }),
    pi({ id: "pi-alt", name: "Pi alt", roles: ["testing"] }),
    codex(),
  ];
  service.updateSettings({ configs, defaultConfigId: "dsh-default" });
  const implicit = startInput({
    type: undefined,
    taskRole: "testing",
    requestId: "config-replay-implicit",
  });
  const first = await service.start("owner-1", implicit);
  assert.equal(first.worker.configId, "dsh-default");
  await waitStatus(service, first.worker.id, ["completed"]);

  // Changing the default config must not reinterpret the already accepted payload.
  service.updateSettings({ configs, defaultConfigId: "pi-alt" });
  const replayed = await service.start("owner-1", implicit);
  assert.equal(replayed.worker.id, first.worker.id);
  assert.equal(replayed.run.id, first.run.id);

  const explicit = await service.start(
    "owner-1",
    startInput({ configId: "pi-alt", type: undefined, requestId: "config-replay-explicit" }),
  );
  await waitStatus(service, explicit.worker.id, ["completed"]);
  service.updateSettings({
    configs: configs.filter((config) => config.id !== "pi-alt"),
    defaultConfigId: "dsh-default",
  });
  const replayedExplicit = await service.start(
    "owner-1",
    startInput({ configId: "pi-alt", type: undefined, requestId: "config-replay-explicit" }),
  );
  assert.equal(replayedExplicit.run.id, explicit.run.id);
  await assert.rejects(
    () =>
      service.start(
        "owner-1",
        startInput({ configId: "pi-alt", type: undefined, requestId: "config-deleted-new" }),
      ),
    /worker 配置不存在/,
  );
});

test("concurrency is keyed by config id, not by worker type", async (t) => {
  const root = temporaryRoot("worker-configs-concurrency-");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "500",
  });
  const configs = [
    piNamed({ concurrency: 1 }),
    piNamed({ id: "dsh-b", name: "DSH B", concurrency: 1 }),
    pi(),
    codex(),
  ];
  service.updateSettings({ configs, defaultConfigId: "dsh-default" });
  const first = await service.start(
    "owner-1",
    startInput({ configId: "dsh-default", requestId: "concurrent-a" }),
  );
  const second = await service.start(
    "owner-1",
    startInput({ configId: "dsh-b", requestId: "concurrent-b" }),
  );
  await waitStatus(service, first.worker.id, ["running"]);
  await waitStatus(service, second.worker.id, ["running"]);
  await waitStatus(service, first.worker.id, ["completed"]);
  await waitStatus(service, second.worker.id, ["completed"]);
});

test("Pi passes the full configured model id through and ignores env services", async (t) => {
  const root = temporaryRoot("worker-configs-pi-selection-");
  const { service, data } = createService(t, root, {
    CODEX_PI_MODEL: "env-model",
    CODEX_PI_PROVIDER: "env-provider",
  });
  const configs = [
    piNamed(),
    pi({ model: "config-provider/sub/config-model", effort: "medium" }),
    codex(),
  ];
  service.updateSettings({ configs, defaultConfigId: "pi-default" });
  const configured = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "pi-config-selection" }),
  );
  const configuredWorker = await waitStatus(service, configured.worker.id, ["completed"]);
  assert.equal(configuredWorker.latestRun?.model, "config-provider/sub/config-model");
  assert.equal(configuredWorker.latestRun?.provider, null);
  assert.equal(configuredWorker.latestRun?.effort, "medium");
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(data, "logs", configuredWorker.id, configuredWorker.latestRun!.id, "spec.json"),
      "utf8",
    ),
  ) as { argv: string[]; acp?: { configOptions: unknown[] } };
  assert.deepEqual(spec.acp?.configOptions, [
    { configId: "model", value: "config-provider/sub/config-model", match: "model" },
    { configId: "thought_level", value: "medium", match: "exact" },
  ]);
  assert.equal(spec.argv.includes("--session-dir"), false);
  assert.equal(spec.argv.includes("--provider"), false);
  assert.equal(spec.argv.includes("env-provider"), false);

  const explicit = await service.start(
    "owner-1",
    startInput({
      type: "pi",
      model: "explicit-provider/sub/model",
      requestId: "pi-explicit-selection",
    }),
  );
  const explicitWorker = await waitStatus(service, explicit.worker.id, ["completed"]);
  assert.equal(explicitWorker.latestRun?.model, "explicit-provider/sub/model");
  assert.equal(explicitWorker.latestRun?.provider, null);

  // Resume keeps the previous full model and only folds an old independent provider when no new
  // model is supplied.
  service.updateSettings({
    configs: configs.map((config) =>
      config.id === "pi-default"
        ? { ...config, model: "other-provider/sub/other-model" }
        : config,
    ),
    defaultConfigId: "pi-default",
  });
  await service.resume("owner-1", {
    workerId: explicitWorker.id,
    prompt: "continue without new selection",
    requestId: "pi-resume-selection",
  });
  const resumed = await waitStatus(service, explicitWorker.id, ["completed"]);
  assert.equal(resumed.latestRun?.model, "explicit-provider/sub/model");
  assert.equal(resumed.latestRun?.provider, null);
});

test("canonical settings reject invalid configs atomically", async (t) => {
  const root = temporaryRoot("worker-configs-validation-");
  const { service } = createService(t, root);
  const base = [piNamed(), pi(), codex()];
  service.updateSettings({ configs: base, defaultConfigId: "dsh-default" });
  const before = service.settings();

  assert.throws(
    () =>
      service.updateSettings({
        configs: [piNamed({ id: "same" }), piNamed({ id: "same" })],
        defaultConfigId: "same",
      }),
    /不能重复/,
  );
  assert.throws(
    () =>
      service.updateSettings({
        configs: base.map((config) =>
          config.id === "dsh-default" ? { ...config, enabled: false } : config,
        ),
        defaultConfigId: "dsh-default",
      }),
    /defaultConfigId 必须指向已启用的配置/,
  );
  assert.throws(
    () =>
      service.updateSettings({
        configs: base.map((config) => ({ ...config, enabled: false })),
        defaultConfigId: "dsh-default",
      }),
    /defaultConfigId 必须指向已启用的配置|至少需要一个已启用的配置/,
  );
  assert.throws(
    () =>
      service.updateSettings({
        configs: base.map((config) =>
          config.id === "codex-default"
            ? { ...config, codex: undefined }
            : config,
        ),
        defaultConfigId: "dsh-default",
      }),
    /Codex 配置必须包含 codex/,
  );
  assert.throws(
    () =>
      service.updateSettings({
        configs: base.map((config) =>
          config.id === "pi-default"
            ? { ...config, model: "provider/model", effort: "impossible" }
            : config,
        ),
        defaultConfigId: "dsh-default",
      }),
    /thinking/,
  );
  assert.deepEqual(service.settings(), before);
});

test("stored legacy Pi/AGY max effort is preserved on unrelated saves while new max is rejected", async (t) => {
  const root = temporaryRoot("worker-configs-legacy-max-");
  const { service } = createService(t, root);
  const agyLegacy: WorkerConfig = {
    id: "agy-legacy",
    name: "Legacy AGY",
    type: "agy",
    enabled: true,
    roles: [],
    concurrency: 2,
    hardTimeoutSeconds: 600,
    model: null,
    effort: "max",
  };
  const persistedPi = pi({ effort: "max" });
  // Seed pre-existing persisted configs with legacy `max` effort for both Pi and AGY.
  service.store.saveSettings({
    schemaVersion: 2,
    configs: [persistedPi, agyLegacy, codex()],
    defaultConfigId: "pi-default",
    retentionDays: 1,
    softReminderSeconds: 600,
    softReminderSteps: 20,
  });

  // Changing only acpIdleTimeoutSeconds via full canonical PUT preserves both stored `max` values.
  const current = service.settings();
  const saved = service.updateSettings({
    configs: current.configs,
    defaultConfigId: current.defaultConfigId,
    acpIdleTimeoutSeconds: 120,
  });
  assert.equal(saved.acpIdleTimeoutSeconds, 120);
  assert.equal(saved.configs.find((c) => c.id === "pi-default")?.effort, "max");
  assert.equal(saved.configs.find((c) => c.id === "agy-legacy")?.effort, "max");

  // Legacy PUT also preserves the stored Pi/AGY `max` without mutating or failing.
  const legacySaved = service.updateSettings({
    concurrency: { pi: 2 },
    defaults: { pi: { model: null, effort: "max" } },
  });
  assert.equal(legacySaved.configs.find((c) => c.id === "pi-default")?.effort, "max");
  assert.equal(legacySaved.configs.find((c) => c.id === "agy-legacy")?.effort, "max");

  // Starting a new ACP run against those legacy `max` configs still fails explicitly.
  await assert.rejects(
    () => service.start("owner-1", startInput({ configId: "pi-default", type: "pi", requestId: "pi-stored-max" })),
    /max/,
  );
  await assert.rejects(
    () => service.start("owner-1", startInput({ configId: "agy-legacy", type: "agy", requestId: "agy-stored-max" })),
    /max/,
  );

  // Adding a new AGY config with `effort: "max"` or switching an existing config to `max` is rejected.
  assert.throws(
    () =>
      service.updateSettings({
        configs: [
          ...saved.configs,
          { ...agyLegacy, id: "agy-new", name: "New AGY", effort: "max" },
        ],
        defaultConfigId: saved.defaultConfigId,
      }),
    /AGY ACP 不支持 effort=max/,
  );
  assert.throws(
    () =>
      service.updateSettings({
        configs: [
          ...saved.configs,
          pi({ id: "pi-new", name: "New Pi", effort: "max" }),
        ],
        defaultConfigId: saved.defaultConfigId,
      }),
    /thinking/,
  );
  // Once cleared, setting AGY back to `max` is also rejected.
  const cleared = service.updateSettings({
    configs: saved.configs.map((c) =>
      c.id === "agy-legacy" ? { ...c, effort: "high" } : c,
    ),
    defaultConfigId: saved.defaultConfigId,
  });
  assert.throws(
    () =>
      service.updateSettings({
        configs: cleared.configs.map((c) =>
          c.id === "agy-legacy" ? { ...c, effort: "max" } : c,
        ),
        defaultConfigId: cleared.defaultConfigId,
      }),
    /AGY ACP 不支持 effort=max/,
  );
});
