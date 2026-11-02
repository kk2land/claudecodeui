import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  codexFixture,
  createService,
  dshFixture,
  piFixture,
  startInput,
  temporaryRoot,
  waitStatus,
} from "./helpers.js";
import type { WorkerRun } from "../shared/contracts.js";

function specFor(data: string, workerId: string, run: WorkerRun): {
  argv: string[];
  cwd: string;
  prompt: string;
} {
  return JSON.parse(
    fs.readFileSync(path.join(data, "logs", workerId, run.id, "spec.json"), "utf8"),
  ) as { argv: string[]; cwd: string; prompt: string };
}

function capture(file: string): {
  argv: string[];
  cwd: string;
  prompt: string;
  env: Record<string, string | undefined>;
} {
  return JSON.parse(fs.readFileSync(file, "utf8")) as {
    argv: string[];
    cwd: string;
    prompt: string;
    env: Record<string, string | undefined>;
  };
}

test("Codex starts with default settings, confirmed thread, usage, and counts", async (t) => {
  const root = temporaryRoot("worker-codex-default-");
  const captureFile = path.join(root, "capture.json");
  const { service, project, data } = createService(t, root, {
    TEST_CAPTURE_FILE: captureFile,
    CLOUDCLI_PLUGIN_TOKEN: "plugin-control-token",
  });
  const started = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "codex-default" }),
  );
  const worker = await waitStatus(service, started.worker.id, ["completed"], 15000);
  const run = worker.latestRun!;
  assert.equal(worker.type, "codex");
  assert.equal(run.model, null);
  assert.equal(run.provider, null);
  assert.equal(run.effort, null);
  assert.equal(run.nativeSessionId, "session-fixture-1");
  assert.equal(run.finalText, "codex answer session-fixture-1");
  assert.deepEqual(run.usage, {
    inputTokens: 11,
    outputTokens: 5,
    totalTokens: 16,
  });
  assert.equal(run.home, path.join(root, "codex-home"));
  assert.equal(run.sessionsRoot, path.join(root, "codex-home", "sessions"));
  assert.equal(service.state().counts.codex.completed, 1);
  assert.equal(service.state().counts.total.completed, 1);

  const spec = specFor(data, worker.id, run);
  assert.deepEqual(spec.argv, [
    codexFixture,
    "exec",
    "--json",
    "-c",
    "model_provider=magpie",
    "-",
  ]);
  assert.equal(spec.cwd, project);
  assert.equal(spec.prompt, "do the fixture work");
  const observed = capture(captureFile);
  assert.equal(observed.env.CODEX_PROXY_BYPASS, "1");
  assert.equal(observed.env.CODEX_HOME, path.join(root, "codex-home"));
  assert.equal(observed.env.CLOUDCLI_PLUGIN_TOKEN, undefined);
});

test("Codex settings replace env/args, explicit selection wins, and secrets stay out of run files", async (t) => {
  const root = temporaryRoot("worker-codex-settings-");
  const captureFile = path.join(root, "capture.json");
  const secret = "codex-env-secret-never-written";
  const { service, project, data } = createService(t, root, {
    TEST_CAPTURE_FILE: captureFile,
  });
  service.updateSettings({
    concurrency: { dsh: 3, pi: 3, codex: 3 },
    codex: {
      env: {
        CODEX_PROXY_BYPASS: "0",
        TEST_CODEX_CUSTOM: "custom-value",
        SECRET_TOKEN: secret,
      },
      extraArgs: [
        "--sandbox",
        "read-only",
        "--model",
        "args-model",
        "-c",
        "model_provider=args-provider",
        "-c",
        "model_reasoning_effort=low",
      ],
    },
  });
  const started = await service.start(
    "owner-1",
    startInput({
      type: "codex",
      model: "explicit-model",
      provider: "explicit-provider",
      effort: "high",
      requestId: "codex-settings",
    }),
  );
  const worker = await waitStatus(service, started.worker.id, ["completed"], 15000);
  const run = worker.latestRun!;
  assert.equal(run.model, "explicit-model");
  assert.equal(run.provider, "explicit-provider");
  assert.equal(run.effort, "high");
  assert.equal(run.finalText, "codex answer session-fixture-1");

  const spec = specFor(data, worker.id, run);
  assert.equal(spec.argv[0], codexFixture);
  assert.equal(spec.argv[1], "exec");
  assert.equal(spec.argv[2], "--json");
  assert.ok(!spec.argv.includes("model_provider=magpie"));
  assert.equal(spec.argv.includes("args-model"), false);
  const explicitModel = spec.argv.indexOf("explicit-model");
  const configuredProvider = spec.argv.indexOf("model_provider=args-provider");
  const explicitProvider = spec.argv.indexOf('model_provider="explicit-provider"');
  const explicitEffort = spec.argv.indexOf('model_reasoning_effort="high"');
  assert.ok(explicitModel > 0);
  assert.ok(configuredProvider > 0 && explicitProvider > configuredProvider);
  assert.ok(explicitEffort > configuredProvider);

  const observed = capture(captureFile);
  assert.equal(observed.cwd, project);
  assert.equal(observed.env.CODEX_PROXY_BYPASS, "0");
  assert.equal(observed.env.TEST_CODEX_CUSTOM, "custom-value");
  assert.equal(observed.env.SECRET_TOKEN, secret);

  const runDirectory = path.join(data, "logs", worker.id, run.id);
  for (const file of ["spec.json", "events.log", "stderr.log", "final.json"]) {
    const target = path.join(runDirectory, file);
    if (!fs.existsSync(target)) continue;
    assert.equal(
      fs.readFileSync(target, "utf8").includes(secret),
      false,
      file + " must not contain Codex env values",
    );
  }
  assert.equal(JSON.stringify(service.state().workers).includes(secret), false);
});

test("Codex admission resolves CODEX_HOME from the merged settings environment", async (t) => {
  const root = temporaryRoot("worker-codex-home-setting-");
  const { service } = createService(t, root);
  const home = path.join(root, "settings-codex-home");
  service.updateSettings({
    concurrency: { dsh: 3, pi: 3 },
    codex: {
      env: { CODEX_HOME: home },
      extraArgs: ["-c", "model_provider=magpie"],
    },
  });
  const started = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "codex-home-setting" }),
  );
  const finished = await waitStatus(service, started.worker.id, ["completed"], 15000);
  assert.equal(finished.latestRun?.home, home);
  assert.equal(finished.latestRun?.sessionsRoot, path.join(home, "sessions"));
  assert.ok(
    fs.existsSync(path.join(home, "sessions", "session-fixture-1.jsonl")),
  );
});

test("Codex is selectable as the default and accepts provider without a model", async (t) => {
  const root = temporaryRoot("worker-codex-default-selection-");
  const { service } = createService(t, root);
  service.updateSettings({
    concurrency: { dsh: 3, pi: 3 },
    defaultWorkerType: "codex",
    defaults: {
      dsh: { model: null, effort: null },
      pi: { model: null, effort: null },
      codex: { model: "codex-default-model", effort: "high" },
    },
  });
  const started = await service.start(
    "owner-1",
    startInput({
      type: undefined,
      provider: "provider-without-model",
      requestId: "codex-default-selection",
    }),
  );
  const finished = await waitStatus(service, started.worker.id, ["completed"], 15000);
  assert.equal(finished.type, "codex");
  assert.equal(finished.latestRun?.model, "codex-default-model");
  assert.equal(finished.latestRun?.provider, "provider-without-model");
  assert.equal(finished.latestRun?.effort, "high");
});

test("Codex resume keeps the recorded thread, home, cwd, and re-reads settings", async (t) => {
  const root = temporaryRoot("worker-codex-resume-");
  const captureFile = path.join(root, "capture.json");
  const { service, data } = createService(t, root, {
    TEST_CAPTURE_FILE: captureFile,
  });
  const started = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "codex-resume-1" }),
  );
  const first = await waitStatus(service, started.worker.id, ["completed"], 15000);
  const firstRun = first.latestRun!;
  service.updateSettings({
    concurrency: { dsh: 3, pi: 3, codex: 3 },
    codex: {
      env: { CODEX_PROXY_BYPASS: "1", TEST_CODEX_CUSTOM: "resume-value" },
      extraArgs: ["--sandbox", "read-only"],
    },
  });
  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "continue",
    requestId: "codex-resume-2",
  });
  const resumed = await waitStatus(service, first.id, ["completed"], 15000);
  const run = resumed.latestRun!;
  assert.notEqual(run.id, firstRun.id);
  assert.equal(run.nativeSessionId, firstRun.nativeSessionId);
  assert.equal(run.home, firstRun.home);
  assert.equal(run.sessionsRoot, firstRun.sessionsRoot);
  assert.equal(run.finalText, "codex answer session-fixture-1");
  const spec = specFor(data, first.id, run);
  assert.deepEqual(spec.argv.slice(0, 5), [
    codexFixture,
    "exec",
    "--json",
    "--sandbox",
    "read-only",
  ]);
  assert.deepEqual(spec.argv.slice(-3), [
    "resume",
    "session-fixture-1",
    "-",
  ]);
  assert.equal(capture(captureFile).env.TEST_CODEX_CUSTOM, "resume-value");
  assert.ok(
    fs.existsSync(
      path.join(root, "codex-home", "sessions", "session-fixture-1.jsonl"),
    ),
  );
});

test("Codex cancellation keeps the thread id and allows resume", async (t) => {
  const root = temporaryRoot("worker-codex-cancel-");
  const { service, env } = createService(t, root, { TEST_SCENARIO: "hang" });
  const started = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "codex-cancel-1" }),
  );
  await waitStatus(service, started.worker.id, ["running"], 15000);
  await service.cancel({ workerIds: [started.worker.id] });
  const cancelled = await waitStatus(service, started.worker.id, ["cancelled"], 15000);
  assert.equal(cancelled.latestRun?.nativeSessionId, "session-fixture-1");
  env.TEST_SCENARIO = "ok";
  await service.resume("owner-1", {
    workerId: cancelled.id,
    prompt: "recover",
    requestId: "codex-cancel-2",
  });
  const completed = await waitStatus(service, cancelled.id, ["completed"], 15000);
  assert.equal(completed.latestRun?.nativeSessionId, "session-fixture-1");
});

test("Codex timeout is terminal and preserves a confirmed thread id", async (t) => {
  const root = temporaryRoot("worker-codex-timeout-");
  const { service } = createService(t, root, { TEST_SCENARIO: "hang" });
  const started = await service.start(
    "owner-1",
    startInput({
      type: "codex",
      timeoutSeconds: 1,
      requestId: "codex-timeout-1",
    }),
  );
  const failed = await waitStatus(service, started.worker.id, ["failed"], 15000);
  assert.equal(failed.latestRun?.error?.code, "TIMEOUT");
  assert.equal(failed.latestRun?.nativeSessionId, "session-fixture-1");
});

test("Codex wrong resume thread id fails without replacing the trusted identity", async (t) => {
  const root = temporaryRoot("worker-codex-wrong-id-");
  const { service, env } = createService(t, root);
  const started = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "codex-wrong-1" }),
  );
  const first = await waitStatus(service, started.worker.id, ["completed"], 15000);
  env.TEST_SCENARIO = "wrong-thread";
  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "wrong id",
    requestId: "codex-wrong-2",
  });
  const failed = await waitStatus(service, first.id, ["failed"], 15000);
  assert.equal(failed.latestRun?.nativeSessionId, "session-fixture-1");
  assert.match(failed.latestRun?.error?.message ?? "", /thread_id/);
});

test("Codex concurrency is isolated and PATH from settings is used for the executable", async (t) => {
  const root = temporaryRoot("worker-codex-concurrency-");
  const pathDir = path.join(root, "bin");
  fs.mkdirSync(pathDir, { recursive: true });
  fs.symlinkSync(codexFixture, path.join(pathDir, "codex"));
  const { service } = createService(
    t,
    root,
    { TEST_SCENARIO: "sleep", TEST_DELAY_MS: "300" },
    { executablePaths: { dsh: dshFixture, pi: piFixture } },
  );
  service.updateSettings({
    concurrency: { dsh: 3, pi: 3, codex: 1 },
    codex: {
      env: {
        PATH: pathDir + path.delimiter + path.dirname(process.execPath),
      },
      extraArgs: ["-c", "model_provider=magpie"],
    },
  });
  const first = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "codex-concurrency-1" }),
  );
  await waitStatus(service, first.worker.id, ["running"], 15000);
  const second = await service.start(
    "owner-1",
    startInput({ type: "codex", requestId: "codex-concurrency-2" }),
  );
  assert.equal(
    service.get(second.worker.id).worker.latestRun?.status,
    "queued",
  );
  await waitStatus(service, first.worker.id, ["completed"], 15000);
  await waitStatus(service, second.worker.id, ["completed"], 15000);
});
