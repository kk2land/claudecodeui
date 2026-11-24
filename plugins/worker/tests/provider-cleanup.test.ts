import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { WorkerService } from "../server/service.js";
import { WorkerStore } from "../server/store.js";
import type { WorkerRecord, WorkerRun } from "../shared/contracts.js";
import {
  codexFixture,
  createService,
  environment,
  guardianSource,
  owner,
  pluginRoot,
  startInput,
  temporaryRoot,
  tsxLoader,
  waitStatus,
} from "./helpers.js";

function historicalRun(workerId: string, type: "pi" | "dsh"): WorkerRun {
  return {
    id: "old-run",
    workerId,
    requestId: "old-request",
    status: "completed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    model: "legacy/base",
    provider: "legacy-provider",
    effort: "low",
    timeoutSeconds: null,
    home: "/tmp/old-home",
    sessionsRoot: "/tmp/old-sessions",
    nativeSessionId: type === "pi" ? "pi-session" : "dsh-session",
    nativeSessionFile: type === "pi" ? "/tmp/old-sessions/pi.jsonl" : null,
    exitCode: 0,
    finalText: "old",
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
  };
}

function historicalWorker(id: string, type: "pi" | "dsh", project: string): WorkerRecord {
  return {
    id,
    type,
    configId: type + "-default",
    configName: type === "pi" ? "Pi default" : "DSH default",
    taskName: id,
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
}

test("non-Codex provider is rejected for new work while an old request replays", async (t) => {
  const root = temporaryRoot("worker-provider-replay-");
  const data = path.join(root, "data");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const replayInput = {
    taskName: "legacy pi provider",
    type: "pi" as const,
    prompt: "old prompt",
    workspace: { mode: "existing" as const },
    writePaths: [],
    model: "legacy/base",
    provider: "legacy-provider",
    effort: "low",
    requestId: "old-pi-request",
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        operation: "start",
        payload: {
          taskName: replayInput.taskName,
          type: replayInput.type,
          prompt: replayInput.prompt,
          workspace: {
            mode: replayInput.workspace.mode,
            cwd: null,
            baseRef: null,
            allowDirtySource: false,
          },
          writePaths: [],
          model: replayInput.model,
          provider: replayInput.provider,
          effort: replayInput.effort,
          timeoutSeconds: "default",
        },
      }),
    )
    .digest("hex");
  const store = new WorkerStore(data);
  store.saveSettings({});
  const worker = historicalWorker("old-pi-worker", "pi", project);
  store.createWorker(
    worker,
    historicalRun(worker.id, "pi"),
    "parent-1\u0000project-1",
    replayInput.requestId,
    "start",
    fingerprint,
  );
  store.close();

  const service = new WorkerService({
    dataDirectory: data,
    environment: environment(root),
    executablePaths: { pi: path.join(pluginRoot, "tests/fixtures/fake-pi.mjs"), codex: codexFixture },
    guardianCommand: [process.execPath, "--import", tsxLoader, guardianSource],
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  service.registerOwner(owner(project), "owner-token");

  const replay = await service.start("owner-1", replayInput);
  assert.equal(replay.worker.id, worker.id);
  assert.equal(replay.run.id, "old-run");
  assert.equal(replay.run.provider, "legacy-provider");

  await assert.rejects(
    () =>
      service.start("owner-1", {
        ...replayInput,
        requestId: "new-provider",
      }),
    /provider 仅 Codex 支持/,
  );
  await assert.rejects(
    () =>
      service.start(
        "owner-1",
        startInput({ type: "pi", provider: "legacy-provider", requestId: "new-pi-provider" }),
      ),
    /provider 仅 Codex 支持/,
  );
  await assert.rejects(
    () =>
      service.resume("owner-1", {
        workerId: worker.id,
        prompt: "provider on resume",
        provider: "legacy-provider",
        requestId: "resume-provider",
      }),
    /provider 仅 Codex 支持/,
  );
  assert.equal(service.get(worker.id).runs.length, 1);
});

test("resume folds historical Pi providers, while historical DSH stays readable but cannot resume", async (t) => {
  const root = temporaryRoot("worker-provider-fold-");
  const { service } = createService(t, root);

  const startPi = async (model: string, requestId: string) => {
    const started = await service.start(
      "owner-1",
      startInput({ type: "pi", model, requestId }),
    );
    return waitStatus(service, started.worker.id, ["completed"]);
  };
  const pi = await startPi("base-model", "fold-pi-1");
  const oldPi = service.store.latestRun(pi.id)!;
  oldPi.model = "base-model";
  oldPi.provider = "Provider/Sub";
  oldPi.effort = "low";
  service.store.saveRun(oldPi);
  const folded = await service.resume("owner-1", {
    workerId: pi.id,
    prompt: "fold pi provider",
    requestId: "fold-pi-2",
  });
  assert.equal(folded.run.model, "Provider/Sub/base-model");
  assert.equal(folded.run.provider, null);
  assert.equal(folded.run.effort, "low");
  await waitStatus(service, pi.id, ["completed"]);

  const already = service.store.latestRun(pi.id)!;
  already.model = "provider/sub/base";
  already.provider = "PROVIDER/SUB";
  service.store.saveRun(already);
  const deduped = await service.resume("owner-1", {
    workerId: pi.id,
    prompt: "already prefixed",
    requestId: "fold-pi-3",
  });
  assert.equal(deduped.run.model, "provider/sub/base");
  assert.equal(deduped.run.provider, null);
  await waitStatus(service, pi.id, ["completed"]);

  const explicit = await service.resume("owner-1", {
    workerId: pi.id,
    prompt: "explicit model",
    model: "new/full/model",
    requestId: "fold-pi-4",
  });
  assert.equal(explicit.run.model, "new/full/model");
  assert.equal(explicit.run.provider, null);
  await waitStatus(service, pi.id, ["completed"]);

  // Historical DSH rows stay stored and directly readable, but every list hides them.
  const project = path.join(root, "project");
  const historical = historicalWorker("old-dsh-worker", "dsh", project);
  service.store.createWorker(
    historical,
    historicalRun(historical.id, "dsh"),
    "parent-1\u0000project-1",
    "old-dsh-request",
    "start",
    "fp",
  );
  const state = service.state();
  assert.equal(state.workers.some((item) => item.id === historical.id), false);
  assert.equal(service.get(historical.id).worker.type, "dsh");
  assert.equal(
    service.history({ kind: "finished" }).items.some(
      (item) => "type" in item && item.type === "dsh",
    ),
    false,
  );
  await assert.rejects(
    () => service.start("owner-1", startInput({ type: "dsh", requestId: "new-dsh" })),
    /DSH 已停止支持/,
  );
  await assert.rejects(
    () =>
      service.resume("owner-1", {
        workerId: historical.id,
        prompt: "resume dsh",
        requestId: "resume-dsh",
      }),
    (error: { code?: string }) => error.code === "WORKER_TYPE_UNSUPPORTED",
  );
});

test("removed CLOUDCLI_DSH_* variables cannot launch DSH work", async (t) => {
  const root = temporaryRoot("worker-dsh-env-cleanup-");
  const { service } = createService(t, root);
  service.updateSettings({
    ...service.settings(),
  });
  await assert.rejects(
    () =>
      service.start(
        "owner-1",
        startInput({ type: "dsh", model: "bare-env-model", requestId: "dsh-env-cleanup" }),
      ),
    /DSH 已停止支持/,
  );
  assert.deepEqual(service.state().workers, []);
});
