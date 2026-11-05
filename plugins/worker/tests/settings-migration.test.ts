import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { WorkerStore } from "../server/store.js";
import type { WorkerRecord, WorkerRun } from "../shared/contracts.js";
import { temporaryRoot } from "./helpers.js";

function run(workerId: string, id: string, overrides: Partial<WorkerRun> = {}): WorkerRun {
  return {
    id,
    workerId,
    requestId: id,
    status: "completed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    model: null,
    provider: null,
    effort: null,
    timeoutSeconds: null,
    home: "/tmp/home",
    sessionsRoot: "/tmp/sessions",
    nativeSessionId: "native-" + id,
    nativeSessionFile: null,
    exitCode: 0,
    finalText: "done",
    error: null,
    usage: null,
    progress: {
      steps: null,
      phase: "completed",
      currentTool: null,
      lastEventAt: null,
      softReminderSentAt: null,
      hardTimeoutAt: null,
    },
    ...overrides,
  };
}

function worker(
  id: string,
  type: WorkerRecord["type"],
  overrides: Partial<WorkerRecord> = {},
): WorkerRecord {
  return {
    id,
    type,
    configId: undefined as unknown as string,
    configName: undefined as unknown as string,
    taskName: id,
    ownerId: "owner-1",
    parentSessionId: "parent-1",
    projectId: "project-1",
    projectPath: "/tmp/project",
    writePaths: [],
    workspace: { mode: "existing", path: "/tmp/project" },
    cwd: "/tmp/project",
    createdAt: new Date().toISOString(),
    latestRun: null,
    ...overrides,
  };
}

function writeSpec(
  data: string,
  workerId: string,
  runId: string,
  argv: string[],
): void {
  const directory = path.join(data, "logs", workerId, runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "spec.json"), JSON.stringify({ argv }));
}

function rawSettings(data: string): Record<string, unknown> {
  const database = new Database(path.join(data, "worker.db"), { readonly: true });
  try {
    const row = database.prepare("SELECT body FROM settings WHERE id=1").get() as {
      body: string;
    };
    return JSON.parse(row.body) as Record<string, unknown>;
  } finally {
    database.close();
  }
}

test("legacy settings migrate once into fixed initial configs and canonical storage", (t) => {
  const root = temporaryRoot("worker-settings-migration-");
  const data = path.join(root, "data");
  const store = new WorkerStore(data);
  t.after(() => store.close());
  store.saveSettings({
    concurrency: { dsh: 4, pi: 4 },
    defaultWorkerType: "codex",
    enabled: { dsh: false, pi: true, codex: true },
    roles: { dsh: ["development"], pi: [], codex: ["code_review"] },
    defaults: {
      dsh: { model: "dsh-m", effort: "high" },
      pi: { model: "provider/pi-legacy", effort: "medium" },
      codex: { model: "gpt6-astra", effort: "max" },
    },
    codex: {
      env: { CODEX_PROXY_BYPASS: "0", CUSTOM: "value" },
      extraArgs: ["-c", "model_provider=magpie", "--search"],
    },
    retentionDays: 7,
    softReminderSeconds: 42,
    softReminderSteps: 7,
    hardTimeoutSeconds: 90,
  });

  const settings = store.settings();
  assert.deepEqual(settings.configs.map((config) => config.id), [
    "dsh-default",
    "pi-default",
    "codex-default",
  ]);
  assert.equal(settings.defaultConfigId, "codex-default");
  assert.equal(settings.defaultWorkerType, "codex");
  assert.deepEqual(settings.concurrency, { dsh: 4, pi: 4, codex: 3 });
  assert.deepEqual(settings.enabled, { dsh: false, pi: true, codex: true });
  assert.deepEqual(settings.roles, {
    dsh: ["development"],
    pi: [],
    codex: ["code_review"],
  });
  assert.deepEqual(settings.defaults, {
    dsh: { model: "dsh-m", effort: "high" },
    pi: { model: "provider/pi-legacy", effort: "medium" },
    codex: { model: "gpt6-astra", effort: "max" },
  });
  const codex = settings.configs.find((config) => config.id === "codex-default")!;
  assert.deepEqual(codex.codex, {
    modelProvider: "magpie",
    env: { CODEX_PROXY_BYPASS: "0", CUSTOM: "value" },
    legacyExtraArgs: ["--search"],
  });
  assert.deepEqual(settings.codex, {
    env: { CODEX_PROXY_BYPASS: "0", CUSTOM: "value" },
    extraArgs: ["--search", "-c", "model_provider=magpie"],
  });
  assert.equal(settings.retentionDays, 7);
  assert.equal(settings.softReminderSeconds, 42);
  assert.equal(settings.softReminderSteps, 7);
  assert.equal(settings.hardTimeoutSeconds, 90);

  const persisted = rawSettings(data);
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(Object.keys(persisted).sort(), [
    "configs",
    "defaultConfigId",
    "hardTimeoutSeconds",
    "retentionDays",
    "schemaVersion",
    "softReminderSeconds",
    "softReminderSteps",
  ]);
  assert.equal("codex" in persisted, false);
  assert.equal("concurrency" in persisted, false);

  // A later read keeps a deleted config deleted instead of recreating the fixed initial one.
  store.saveSettings({
    ...(persisted as Record<string, unknown>),
    configs: (persisted.configs as unknown[]).filter(
      (config) =>
        (config as { id?: string }).id !== "pi-default",
    ),
    defaultConfigId: "codex-default",
  });
  assert.deepEqual(
    store.settings().configs.map((config) => config.id),
    ["dsh-default", "codex-default"],
  );
});

test("migration preserves explicit empty Codex env/args", (t) => {
  const root = temporaryRoot("worker-settings-migration-empty-");
  const data = path.join(root, "data");
  const store = new WorkerStore(data);
  t.after(() => store.close());
  store.saveSettings({
    concurrency: { dsh: 3, pi: 3 },
    codex: { env: {}, extraArgs: [] },
  });
  const settings = store.settings();
  assert.deepEqual(settings.codex, { env: {}, extraArgs: [] });
  assert.equal(
    settings.configs.find((config) => config.id === "codex-default")?.codex
      ?.modelProvider,
    null,
  );
});

test("migration backfills worker config identity and run selection from spec argv", (t) => {
  const root = temporaryRoot("worker-settings-history-");
  const data = path.join(root, "data");
  const store = new WorkerStore(data);
  t.after(() => store.close());
  store.saveSettings({
    concurrency: { dsh: 3, pi: 3 },
    defaultWorkerType: "dsh",
  });
  const legacyWorker = worker("worker-legacy", "codex");
  const legacyRun = run("worker-legacy", "run-legacy");
  store.createWorker(legacyWorker, legacyRun, "owner-1", "request-legacy", "start", "fp");
  writeSpec(data, "worker-legacy", "run-legacy", [
    "codex",
    "exec",
    "--json",
    "--model",
    "argv-model",
    "-c",
    "model_provider=magpie",
    "-c",
    'model_reasoning_effort="high"',
    "-",
  ]);

  const explicitWorker = worker("worker-explicit", "codex");
  const explicitRun = run("worker-explicit", "run-explicit", {
    model: "explicit-model",
    provider: "explicit-provider",
    effort: "low",
  });
  store.createWorker(explicitWorker, explicitRun, "owner-1", "request-explicit", "start", "fp");
  writeSpec(data, "worker-explicit", "run-explicit", [
    "codex",
    "exec",
    "-c",
    "model_provider=argv-provider",
    "--model",
    "argv-model",
  ]);

  const noEvidenceWorker = worker("worker-no-spec", "dsh");
  store.createWorker(
    noEvidenceWorker,
    run("worker-no-spec", "run-no-spec"),
    "owner-1",
    "request-no-spec",
    "start",
    "fp",
  );

  // DSH selection lives in the model patch file, never in argv; unrelated argv text must not
  // be misread as a Codex/Pi selection.
  const dshWorker = worker("worker-dsh-spec", "dsh");
  store.createWorker(
    dshWorker,
    run("worker-dsh-spec", "run-dsh-spec"),
    "owner-1",
    "request-dsh-spec",
    "start",
    "fp",
  );
  writeSpec(data, "worker-dsh-spec", "run-dsh-spec", [
    "dsh",
    "--profile",
    "headless",
    "--patch",
    "/tmp/model.patch.yml",
    "--json",
    "-",
  ]);

  const settings = store.settings();
  assert.equal(store.worker("worker-legacy")?.configId, "codex-default");
  assert.equal(store.worker("worker-legacy")?.configName, "codex#1");
  const migrated = store.run("run-legacy")!;
  assert.equal(migrated.model, "argv-model");
  assert.equal(migrated.provider, "magpie");
  assert.equal(migrated.effort, "high");

  const explicit = store.run("run-explicit")!;
  assert.equal(explicit.model, "explicit-model");
  assert.equal(explicit.provider, "explicit-provider");
  assert.equal(explicit.effort, "low");

  const noEvidence = store.run("run-no-spec")!;
  assert.equal(noEvidence.model, null);
  assert.equal(noEvidence.provider, null);
  assert.equal(noEvidence.effort, null);
  const dshSpec = store.run("run-dsh-spec")!;
  assert.equal(dshSpec.model, null);
  assert.equal(dshSpec.provider, null);
  assert.equal(dshSpec.effort, null);
  assert.equal(store.worker("worker-no-spec")?.configId, "dsh-default");
  assert.equal(settings.configs.length, 3);
});

test("a store without a settings row persists defaults and backfills legacy workers", (t) => {
  const root = temporaryRoot("worker-settings-backfill-");
  const data = path.join(root, "data");
  const store = new WorkerStore(data);
  t.after(() => store.close());
  store.createWorker(
    worker("worker-defaults", "dsh"),
    run("worker-defaults", "run-defaults"),
    "owner-1",
    "request-defaults",
    "start",
    "fp",
  );
  const settings = store.settings();
  assert.equal(settings.defaultConfigId, "dsh-default");
  assert.equal(store.worker("worker-defaults")?.configId, "dsh-default");
  assert.equal(
    rawSettings(data).schemaVersion,
    2,
    "canonical defaults are persisted once so later reads stay canonical",
  );
});
