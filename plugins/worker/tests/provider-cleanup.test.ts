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
  dshFixture,
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
    dshPatch: path.join(pluginRoot, "patches/dsh-session.patch.yml"),
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
        startInput({ type: "dsh", provider: "legacy-provider", requestId: "new-dsh-provider" }),
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

test("resume folds historical Pi/DSH providers only without an explicit new model", async (t) => {
  const root = temporaryRoot("worker-provider-fold-");
  const { service, data } = createService(t, root);

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

  const startDsh = async (model: string, requestId: string) => {
    const started = await service.start(
      "owner-1",
      startInput({ type: "dsh", model, requestId }),
    );
    return waitStatus(service, started.worker.id, ["completed"]);
  };
  const dsh = await startDsh("bare-model", "fold-dsh-1");
  const oldDsh = service.store.latestRun(dsh.id)!;
  oldDsh.model = "bare-model";
  oldDsh.provider = "old/provider";
  service.store.saveRun(oldDsh);
  const dshFolded = await service.resume("owner-1", {
    workerId: dsh.id,
    prompt: "fold dsh provider",
    requestId: "fold-dsh-2",
  });
  assert.equal(dshFolded.run.model, "old/provider/bare-model");
  assert.equal(dshFolded.run.provider, null);
  await waitStatus(service, dsh.id, ["completed"]);

  const patchWorker = await startDsh("patch-base", "fold-dsh-patch-1");
  const patchRun = service.store.latestRun(patchWorker.id)!;
  patchRun.provider = null;
  patchRun.model = "patch-base";
  service.store.saveRun(patchRun);
  const recovered = await service.resume("owner-1", {
    workerId: patchWorker.id,
    prompt: "recover dsh patch route",
    requestId: "fold-dsh-patch-2",
  });
  assert.equal(recovered.run.model, "deepseek-official/patch-base");
  assert.equal(recovered.run.provider, null);
  await waitStatus(service, patchWorker.id, ["completed"]);

  const fullModelWorker = await startDsh(
    "provider/complete-model",
    "fold-dsh-full-1",
  );
  const fullModelRun = service.store.latestRun(fullModelWorker.id)!;
  fullModelRun.provider = null;
  service.store.saveRun(fullModelRun);
  fs.rmSync(
    path.join(data, "logs", fullModelWorker.id, fullModelRun.id, "model.patch.yml"),
  );
  const fullModelResume = await service.resume("owner-1", {
    workerId: fullModelWorker.id,
    prompt: "full model needs no old patch",
    requestId: "fold-dsh-full-2",
  });
  assert.equal(fullModelResume.run.model, "provider/complete-model");
  assert.equal(fullModelResume.run.provider, null);
  await waitStatus(service, fullModelWorker.id, ["completed"]);

  const unrouted = await startDsh("unrouted-base", "fold-dsh-missing-1");
  const unroutedRun = service.store.latestRun(unrouted.id)!;
  unroutedRun.provider = null;
  unroutedRun.model = "unrouted-base";
  service.store.saveRun(unroutedRun);
  fs.rmSync(
    path.join(data, "logs", unrouted.id, unroutedRun.id, "model.patch.yml"),
  );
  await assert.rejects(
    () =>
      service.resume("owner-1", {
        workerId: unrouted.id,
        prompt: "cannot infer route",
        requestId: "fold-dsh-missing-2",
      }),
    /显式提供完整 model/,
  );
  const explicitDsh = await service.resume("owner-1", {
    workerId: unrouted.id,
    prompt: "explicit dsh route",
    model: "explicit/provider/model",
    requestId: "fold-dsh-missing-3",
  });
  assert.equal(explicitDsh.run.model, "explicit/provider/model");
  assert.equal(explicitDsh.run.provider, null);
  await waitStatus(service, unrouted.id, ["completed"]);
});

test("removed CLOUDCLI_DSH_* variables no longer affect DSH launch", async (t) => {
  const root = temporaryRoot("worker-dsh-env-cleanup-");
  const data = path.join(root, "data");
  const project = path.join(root, "project");
  const bin = path.join(root, "bin");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const dsh = path.join(bin, "dsh");
  fs.copyFileSync(dshFixture, dsh);
  fs.chmodSync(dsh, 0o755);
  const env = environment(root, {
    PATH: bin + path.delimiter + (process.env.PATH ?? ""),
    CLOUDCLI_DSH_BIN: path.join(pluginRoot, "tests/fixtures/fake-pi.mjs"),
    CLOUDCLI_DSH_PATCHES: "not-json",
    CLOUDCLI_DSH_PROVIDER: "environment-provider",
  });
  const service = new WorkerService({
    dataDirectory: data,
    environment: env,
    guardianCommand: [process.execPath, "--import", tsxLoader, guardianSource],
    dshPatch: path.join(pluginRoot, "patches/dsh-session.patch.yml"),
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  service.registerOwner(owner(project), "owner-token");
  const started = await service.start(
    "owner-1",
    startInput({ model: "bare-env-model", requestId: "dsh-env-cleanup" }),
  );
  const worker = await waitStatus(service, started.worker.id, ["completed"]);
  assert.match(worker.latestRun?.finalText ?? "", /fixture answer/);
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(data, "logs", worker.id, worker.latestRun!.id, "spec.json"),
      "utf8",
    ),
  ) as { argv: string[] };
  const patchFile = spec.argv
    .filter((value, index) => index > 0 && spec.argv[index - 1] === "--patch")
    .find((file) => file.endsWith("model.patch.yml"))!;
  const patch = JSON.parse(fs.readFileSync(patchFile, "utf8")) as [
    { config: { provider: string; model: string } },
  ];
  assert.deepEqual(patch[0]!.config, {
    provider: "deepseek-official",
    model: "bare-env-model",
  });
});
