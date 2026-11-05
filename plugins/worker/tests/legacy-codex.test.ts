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
  environment,
  guardianSource,
  owner,
  pluginRoot,
  temporaryRoot,
  tsxLoader,
  waitStatus,
} from "./helpers.js";

function legacyRun(workerId: string, home: string): WorkerRun {
  return {
    id: "legacy-run",
    workerId,
    requestId: "legacy-start",
    status: "completed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    model: null,
    provider: null,
    effort: null,
    timeoutSeconds: null,
    home,
    sessionsRoot: path.join(home, "sessions"),
    nativeSessionId: "legacy-thread",
    nativeSessionFile: null,
    exitCode: 0,
    finalText: "legacy answer",
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

function legacyWorker(project: string): WorkerRecord {
  return {
    id: "worker-legacy-codex",
    type: "codex",
    configId: undefined as unknown as string,
    configName: undefined as unknown as string,
    taskName: "legacy codex",
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

function specProvider(data: string, workerId: string, runId: string): string | null {
  const spec = JSON.parse(
    fs.readFileSync(path.join(data, "logs", workerId, runId, "spec.json"), "utf8"),
  ) as { argv: string[] };
  for (const value of spec.argv)
    if (value.startsWith("model_provider=")) return value;
  return null;
}

test("legacy Codex resume keeps its old provider fallback without fabricating history", async (t) => {
  const root = temporaryRoot("worker-legacy-codex-");
  const data = path.join(root, "data");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const env = environment(root);
  fs.mkdirSync(path.join(env.CODEX_HOME!, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(env.CODEX_HOME!, "sessions", "legacy-thread.jsonl"),
    JSON.stringify({ thread_id: "legacy-thread", cwd: project }) + "\n",
  );

  const store = new WorkerStore(data);
  store.saveSettings({
    concurrency: { dsh: 3, pi: 3 },
    defaultWorkerType: "dsh",
    codex: {
      env: { CODEX_PROXY_BYPASS: "1" },
      extraArgs: ["-c", "model_provider=magpie"],
    },
  });
  const legacy = legacyWorker(project);
  store.createWorker(
    legacy,
    legacyRun(legacy.id, env.CODEX_HOME!),
    "parent-1",
    "legacy-start",
    "start",
    "legacy-fingerprint",
  );
  // A replay written before schema 2 must still return the migrated worker on the first call.
  const replayInput = {
    taskName: "legacy replay",
    type: "codex" as const,
    prompt: "legacy replay prompt",
    workspace: { mode: "existing" as const },
    writePaths: [],
    requestId: "legacy-replay",
  };
  const replayFingerprint = createHash("sha256")
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
          model: null,
          provider: null,
          effort: null,
          timeoutSeconds: "default",
        },
      }),
    )
    .digest("hex");
  store.addRequest(
    "parent-1\u0000project-1",
    replayInput.requestId,
    legacy.id,
    "legacy-run",
    "start",
    replayFingerprint,
  );
  store.close();

  const service = new WorkerService({
    dataDirectory: data,
    environment: env,
    executablePaths: { codex: codexFixture },
    guardianCommand: [process.execPath, "--import", tsxLoader, guardianSource],
    dshPatch: path.join(pluginRoot, "patches/dsh-session.patch.yml"),
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  service.registerOwner(owner(project), "owner-token");

  // The constructor migration has already run, so the very first state read is consistent.
  const first = service.state().workers.find((worker) => worker.id === legacy.id)!;
  assert.equal(first.configId, "codex-default");
  assert.equal(first.configName, "codex#1");
  assert.equal(first.latestRun?.provider, null);
  assert.equal(first.latestRun?.legacyCodexProvider, true);

  const replay = await service.start("owner-1", replayInput);
  assert.equal(replay.worker.id, legacy.id);
  assert.equal(replay.worker.configId, "codex-default");
  assert.equal(replay.run.id, "legacy-run");

  await service.resume("owner-1", {
    workerId: legacy.id,
    prompt: "continue legacy",
    requestId: "legacy-resume-1",
  });
  const firstResume = await waitStatus(service, legacy.id, ["completed"]);
  assert.equal(firstResume.latestRun?.provider, null);
  assert.equal(firstResume.latestRun?.legacyCodexProvider, true);
  assert.equal(
    specProvider(data, legacy.id, firstResume.latestRun!.id),
    'model_provider="magpie"',
  );

  // A changed config service is read at launch, not written into run history.
  const current = service.settings();
  service.updateSettings({
    configs: current.configs.map((config) =>
      config.id === "codex-default"
        ? {
            ...config,
            codex: {
              ...config.codex!,
              modelProvider: "changed-provider",
            },
          }
        : config,
    ),
    defaultConfigId: current.defaultConfigId,
  });
  await service.resume("owner-1", {
    workerId: legacy.id,
    prompt: "continue after service change",
    requestId: "legacy-resume-2",
  });
  const secondResume = await waitStatus(service, legacy.id, ["completed"]);
  assert.equal(secondResume.latestRun?.provider, null);
  assert.equal(secondResume.latestRun?.legacyCodexProvider, true);
  assert.equal(
    specProvider(data, legacy.id, secondResume.latestRun!.id),
    'model_provider="changed-provider"',
  );

  // An explicit provider wins and stops the legacy fallback for later resumes.
  const explicit = await service.resume("owner-1", {
    workerId: legacy.id,
    prompt: "explicit provider",
    provider: "explicit-provider",
    requestId: "legacy-resume-3",
  });
  const explicitRun = await waitStatus(service, legacy.id, ["completed"]);
  assert.equal(explicitRun.latestRun?.provider, "explicit-provider");
  assert.equal(explicitRun.latestRun?.legacyCodexProvider, undefined);
  assert.equal(
    specProvider(data, legacy.id, explicit.run.id),
    'model_provider="explicit-provider"',
  );
  await service.resume("owner-1", {
    workerId: legacy.id,
    prompt: "keep explicit",
    requestId: "legacy-resume-4",
  });
  const kept = await waitStatus(service, legacy.id, ["completed"]);
  assert.equal(kept.latestRun?.provider, "explicit-provider");
  assert.equal(kept.latestRun?.legacyCodexProvider, undefined);
  assert.equal(
    specProvider(data, legacy.id, kept.latestRun!.id),
    'model_provider="explicit-provider"',
  );

  // A newly started native-default run has no legacy flag and no provider fallback.
  service.updateSettings({
    configs: service.settings().configs.map((config) =>
      config.id === "codex-default"
        ? { ...config, codex: { ...config.codex!, modelProvider: null } }
        : config,
    ),
    defaultConfigId: service.settings().defaultConfigId,
  });
  const fresh = await service.start("owner-1", {
    taskName: "fresh codex",
    type: "codex",
    prompt: "fresh native default",
    workspace: { mode: "existing" },
    writePaths: [],
    requestId: "legacy-new-default",
  });
  const freshRun = await waitStatus(service, fresh.worker.id, ["completed"]);
  assert.equal(freshRun.latestRun?.provider, null);
  assert.equal(freshRun.latestRun?.legacyCodexProvider, undefined);
  assert.equal(specProvider(data, fresh.worker.id, fresh.run.id), null);
});
