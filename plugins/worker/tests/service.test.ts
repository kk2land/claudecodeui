import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { WorkerStore } from "../server/store.js";
import { WorkerService } from "../server/service.js";
import { appendLog } from "../server/logs.js";
import type { WorkerRecord, WorkerRun } from "../shared/contracts.js";
import {
  createService,
  environment,
  owner,
  startInput,
  temporaryRoot,
  waitFor,
  waitStatus,
} from "./helpers.js";

test("starts, records, logs, and deduplicates one DSH run", async (t) => {
  const root = temporaryRoot("worker-start-");
  const { service } = createService(t, root);
  const input = startInput({ requestId: "  dedupe-key  " });
  const started = await service.start("owner-1", input);
  const worker = await waitStatus(service, started.worker.id, ["completed"]);
  assert.equal(worker.latestRun?.status, "completed");
  assert.equal(worker.latestRun?.nativeSessionId, "session-fixture-1");
  assert.ok(worker.latestRun?.nativeSessionFile?.endsWith("session.v4.jsonl.zstd"));
  assert.match(worker.latestRun?.finalText ?? "", /fixture answer/);
  assert.deepEqual(worker.latestRun?.usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
  assert.equal(worker.cwd, path.join(root, "project"));
  const snapshot = service.state({ projectId: "project-1" });
  assert.equal(snapshot.counts.total.completed, 1);
  assert.equal(snapshot.notifications.length, 1);
  assert.equal(snapshot.notifications[0]?.delivery, "pending");
  const logs = service.logs(worker.id, { stream: "events" });
  assert.match(logs.text, /"type":"session"/);
  assert.equal(logs.done, true);
  assert.equal(logs.nextCursor, null);

  const duplicate = await service.start("owner-1", input);
  assert.equal(duplicate.worker.id, worker.id);
  assert.equal(duplicate.run.id, started.run.id);
  assert.equal(service.get(worker.id).runs.length, 1);
});

test("resumes the same native identity with a new run id", async (t) => {
  const root = temporaryRoot("worker-resume-");
  const { service } = createService(t, root);
  const started = await service.start("owner-1", startInput());
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  const resumed = await service.resume("owner-1", {
    workerId: first.id,
    prompt: "continue",
    requestId: "resume-1",
  });
  assert.notEqual(resumed.run.id, first.latestRun?.id);
  const second = await waitStatus(service, first.id, ["completed"]);
  assert.equal(second.latestRun?.nativeSessionId, "session-fixture-1");
  assert.equal(
    second.latestRun?.nativeSessionFile,
    first.latestRun?.nativeSessionFile,
  );
  assert.equal(service.get(first.id).runs.length, 2);
  const duplicate = await service.resume("owner-1", {
    workerId: first.id,
    prompt: "continue",
    requestId: "resume-1",
  });
  assert.equal(duplicate.run.id, resumed.run.id);
  assert.equal(service.get(first.id).runs.length, 2);
});

test("enforces per-key FIFO concurrency", async (t) => {
  const root = temporaryRoot("worker-queue-");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "400",
  });
  service.updateSettings({ concurrency: { dsh: 1, pi: 1 } });
  const first = await service.start("owner-1", startInput({ requestId: "q1" }));
  const second = await service.start("owner-1", startInput({ requestId: "q2" }));
  await waitStatus(service, first.worker.id, ["running"]);
  assert.equal(service.get(second.worker.id).worker.latestRun?.status, "queued");
  const firstDone = await waitStatus(service, first.worker.id, ["completed"]);
  const secondDone = await waitStatus(service, second.worker.id, ["completed"]);
  assert.ok(
    Date.parse(firstDone.latestRun!.finishedAt!) <=
      Date.parse(secondDone.latestRun!.startedAt!),
  );
  assert.equal(
    service.state().counts.total.completed,
    2,
  );
});

test("default quotas isolate dsh/pi, parents, and projects while sharing one existing cwd", async (t) => {
  const root = temporaryRoot("worker-concurrency-scope-");
  const { service, project } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "2000",
  });
  const project2 = path.join(root, "project2");
  fs.mkdirSync(project2, { recursive: true });
  service.registerOwner(
    {
      id: "owner-2",
      parentSessionId: "parent-2",
      projectId: "project-2",
      projectPath: project2,
      userId: 2,
      appServerInstanceId: "app-2",
      paused: false,
    },
    "owner-2-token",
  );
  const dsh = [];
  for (let index = 0; index < 4; index++)
    dsh.push(await service.start("owner-1", startInput({ requestId: "dsh-" + index })));
  const pi = [];
  for (let index = 0; index < 4; index++)
    pi.push(
      await service.start(
        "owner-1",
        startInput({ type: "pi", requestId: "pi-" + index }),
      ),
    );
  const other = await service.start(
    "owner-2",
    startInput({ requestId: "other-1" }),
  );
  for (const item of [...dsh.slice(0, 3), ...pi.slice(0, 3), other])
    await waitStatus(service, item.worker.id, ["running"]);
  assert.equal(service.get(dsh[3]!.worker.id).worker.latestRun?.status, "queued");
  assert.equal(service.get(pi[3]!.worker.id).worker.latestRun?.status, "queued");
  assert.equal(service.get(other.worker.id).worker.cwd, fs.realpathSync(project2));
  assert.equal(service.get(dsh[0]!.worker.id).worker.cwd, fs.realpathSync(project));

  // Raising the DSH quota admits only that key's queued FIFO item; Pi and the
  // separate parent/project remain on their own quotas.
  service.updateSettings({ concurrency: { dsh: 4, pi: 3 } });
  await waitStatus(service, dsh[3]!.worker.id, ["running"], 1000);
  assert.equal(service.get(pi[3]!.worker.id).worker.latestRun?.status, "queued");

  for (const item of [...dsh, ...pi, other])
    await waitStatus(service, item.worker.id, ["completed"], 12000);
});

test("cancels a running group and holds the notification", async (t) => {
  const root = temporaryRoot("worker-cancel-");
  const pidFile = path.join(root, "pid");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "hang",
    TEST_PID_FILE: pidFile,
  });
  const started = await service.start("owner-1", startInput());
  await waitStatus(service, started.worker.id, ["running"]);
  await waitFor(() => fs.existsSync(pidFile), Boolean);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  const before = Date.now();
  const ids = await service.cancel({ workerIds: [started.worker.id] }, "host");
  assert.deepEqual(ids, [started.worker.id]);
  assert.ok(Date.now() - before < 12000);
  const worker = service.get(started.worker.id).worker;
  assert.equal(worker.latestRun?.status, "cancelled");
  assert.equal(service.notifications()[0]?.delivery, "held");
  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    Boolean,
    5000,
  );
});

test("stopping keeps the concurrency slot until the process group is confirmed gone", async (t) => {
  const root = temporaryRoot("worker-stopping-slot-");
  const { service } = createService(t, root, { TEST_SCENARIO: "hangtree" });
  service.updateSettings({ concurrency: { dsh: 1, pi: 1 } });
  const first = await service.start("owner-1", startInput({ requestId: "stopping-1" }));
  await waitStatus(service, first.worker.id, ["running"]);
  const cancelling = service.cancel({ workerIds: [first.worker.id] }, "host");
  await waitFor(
    () => service.get(first.worker.id).worker.latestRun?.status,
    (status) => status === "stopping",
  );
  const queued = await service.start(
    "owner-1",
    startInput({ requestId: "stopping-2" }),
  );
  assert.equal(service.get(queued.worker.id).worker.latestRun?.status, "queued");
  assert.deepEqual(await cancelling, [first.worker.id]);
  assert.equal(service.get(first.worker.id).worker.latestRun?.status, "cancelled");
  await waitStatus(service, queued.worker.id, ["running"]);
  await service.cancel({ workerIds: [queued.worker.id] }, "host");
});

test("kills a grandchild left behind by a normally exited CLI", async (t) => {
  const root = temporaryRoot("worker-grandchild-");
  const pidFile = path.join(root, "child");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "grandchild",
    TEST_PID_FILE: pidFile,
  });
  const started = await service.start("owner-1", startInput());
  await waitStatus(service, started.worker.id, ["completed"]);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    Boolean,
    5000,
  );
});

test("runs and resumes Pi through an explicit session file", async (t) => {
  const root = temporaryRoot("worker-pi-");
  const { service } = createService(t, root);
  const started = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "pi-1" }),
  );
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  assert.equal(first.latestRun?.nativeSessionId, "session-fixture-1");
  assert.ok(fs.existsSync(first.latestRun!.nativeSessionFile!));
  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "again",
    requestId: "pi-2",
    effort: "high",
  });
  const second = await waitStatus(service, first.id, ["completed"]);
  assert.equal(second.latestRun?.effort, "high");
  assert.equal(second.latestRun?.nativeSessionFile, first.latestRun?.nativeSessionFile);
  assert.equal(service.get(first.id).runs.length, 2);
});

test("hard timeout fails the run with guardian evidence", async (t) => {
  const root = temporaryRoot("worker-timeout-");
  const { service } = createService(t, root, { TEST_SCENARIO: "hang" });
  const started = await service.start(
    "owner-1",
    startInput({ timeoutSeconds: 1, requestId: "timeout-1" }),
  );
  const worker = await waitStatus(service, started.worker.id, ["failed"], 12000);
  assert.equal(worker.latestRun?.error?.code, "TIMEOUT");
  assert.ok(worker.latestRun?.finishedAt);
  assert.equal(service.notifications()[0]?.status, "failed");
  assert.equal(service.notifications()[0]?.delivery, "pending");
});

test("soft reminder is recorded without cancelling the run", async (t) => {
  const root = temporaryRoot("worker-reminder-");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "3000",
  });
  const settings = service.settings();
  service.store.saveSettings({ ...settings, softReminderSeconds: 1 });
  const started = await service.start("owner-1", startInput({ requestId: "reminder-1" }));
  await waitStatus(service, started.worker.id, ["running"]);
  await waitFor(
    () => service.get(started.worker.id).worker.latestRun?.progress.softReminderSentAt,
    Boolean,
    8000,
  );
  const completed = await waitStatus(service, started.worker.id, ["completed"]);
  assert.ok(completed.latestRun?.progress.softReminderSentAt);
  assert.equal(completed.latestRun?.status, "completed");
});

test("credentials stay in the child process and out of run records", async (t) => {
  const root = temporaryRoot("worker-secrets-");
  const envFile = path.join(root, "child-env");
  const { service } = createService(t, root, {
    OPENAI_API_KEY: "fixture-secret-value",
    TEST_ENV_FILE: envFile,
  });
  const started = await service.start("owner-1", startInput({ requestId: "secret-1" }));
  const worker = await waitStatus(service, started.worker.id, ["completed"]);
  assert.equal(fs.readFileSync(envFile, "utf8"), "fixture-secret-value");
  const directory = path.join(root, "data", "logs", worker.id, worker.latestRun!.id);
  for (const file of fs.readdirSync(directory)) {
    assert.equal(
      fs.readFileSync(path.join(directory, file), "utf8").includes("fixture-secret-value"),
      false,
      file + " must not persist credentials",
    );
  }
});

test("DSH resume needs only the recorded native identity", async (t) => {
  const root = temporaryRoot("worker-dsh-identity-");
  const { service } = createService(t, root);
  const started = await service.start("owner-1", startInput({ requestId: "identity-1" }));
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  const stored = service.store.latestRun(first.id)!;
  assert.equal(stored.nativeSessionId, "session-fixture-1");
  stored.nativeSessionFile = null;
  service.store.saveRun(stored);
  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "resume without transcript",
    requestId: "identity-2",
  });
  const resumed = await waitStatus(service, first.id, ["completed"]);
  assert.equal(resumed.latestRun?.nativeSessionId, "session-fixture-1");
  assert.equal(service.get(first.id).runs.length, 2);
});

test("Pi snapshots environment defaults and keeps them after environment changes", async (t) => {
  const root = temporaryRoot("worker-pi-env-");
  const { service, data, env } = createService(t, root, {
    CODEX_PI_MODEL: "env-model",
    CODEX_PI_PROVIDER: "env-provider",
    CODEX_PI_THINKING: "low",
  });
  const started = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "pi-env-1" }),
  );
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  assert.equal(first.latestRun?.model, "env-model");
  assert.equal(first.latestRun?.provider, "env-provider");
  assert.equal(first.latestRun?.effort, "low");
  const firstSpec = fs.readFileSync(
    path.join(data, "logs", first.id, first.latestRun!.id, "spec.json"),
    "utf8",
  );
  assert.match(firstSpec, /env-model/);
  assert.match(firstSpec, /env-provider/);
  assert.match(firstSpec, /"low"/);

  env.CODEX_PI_MODEL = "changed-model";
  env.CODEX_PI_PROVIDER = "changed-provider";
  env.CODEX_PI_THINKING = "high";
  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "resume",
    requestId: "pi-env-2",
  });
  const resumed = await waitStatus(service, first.id, ["completed"]);
  assert.equal(resumed.latestRun?.model, "env-model");
  assert.equal(resumed.latestRun?.provider, "env-provider");
  assert.equal(resumed.latestRun?.effort, "low");
  const secondSpec = fs.readFileSync(
    path.join(data, "logs", first.id, resumed.latestRun!.id, "spec.json"),
    "utf8",
  );
  assert.match(secondSpec, /env-model/);
  assert.doesNotMatch(secondSpec, /changed-model/);
  assert.doesNotMatch(secondSpec, /changed-provider/);
});

test("guardian keeps a multibyte JSON line intact across stdout chunks", async (t) => {
  const root = temporaryRoot("worker-split-utf8-");
  const { service } = createService(t, root, { TEST_SCENARIO: "splitutf8" });
  const started = await service.start("owner-1", startInput({ requestId: "utf8-1" }));
  await waitFor(
    () => service.get(started.worker.id).worker.latestRun?.progress.currentTool,
    (tool) => tool === "中文工具",
    8000,
  );
  await waitStatus(service, started.worker.id, ["completed"]);
});

test("restored unknown rejects pause as STOP_UNCONFIRMED and keeps the slot", async (t) => {
  const root = temporaryRoot("worker-stop-unknown-");
  const { project, data } = seed(root, false);
  const service = new WorkerService({
    dataDirectory: data,
    environment: environment(root),
    executablePaths: { dsh: "", pi: "" },
    guardianCommand: [process.execPath, "--import", "x", "y"],
  });
  t.after(() => service.close());
  service.registerOwner(owner(project), "owner-token");
  service.recoverFromDisk();
  await assert.rejects(
    service.setOwnerPaused("owner-1", true, "stop"),
    /STOP_UNCONFIRMED|确认/,
  );
  assert.equal(service.store.owner("owner-1")?.paused, true);
  assert.equal(service.get("worker-restart").worker.latestRun?.status, "unknown");
  assert.equal(service.state().counts.total.unknown, 1);
  await assert.rejects(
    service.closeInstance("app-1", "stop"),
    /STOP_UNCONFIRMED|确认/,
  );
  assert.equal(service.ownerForToken("owner-token"), null);
  assert.equal(service.get("worker-restart").worker.latestRun?.status, "unknown");
  await assert.rejects(service.closeAll("unconfirmed"), /STOP_UNCONFIRMED|确认/);
  assert.equal(service.get("worker-restart").worker.latestRun?.status, "unknown");
});

test("guardian final evidence with groupExited=false stays unknown and unconfirmed", async (t) => {
  const root = temporaryRoot("worker-stop-group-");
  const { project, data } = seed(root, "unconfirmed");
  const service = new WorkerService({
    dataDirectory: data,
    environment: environment(root),
    executablePaths: { dsh: "", pi: "" },
    guardianCommand: [process.execPath, "--import", "x", "y"],
  });
  t.after(() => service.close());
  service.registerOwner(owner(project), "owner-token");
  service.recoverFromDisk();
  const recovered = service.get("worker-restart").worker;
  assert.equal(recovered.latestRun?.status, "unknown");
  await assert.rejects(
    service.setOwnerPaused("owner-1", true, "stop"),
    /STOP_UNCONFIRMED|确认/,
  );
  assert.equal(service.get("worker-restart").worker.latestRun?.status, "unknown");
});

test("request ids reject a different payload or operation", async (t) => {
  const root = temporaryRoot("worker-request-conflict-");
  const { service } = createService(t, root);
  const input = startInput({ requestId: "conflict-key" });
  const first = await service.start("owner-1", input);
  await waitStatus(service, first.worker.id, ["completed"]);
  await assert.rejects(
    service.start("owner-1", { ...input, prompt: "different work" }),
    (error: { code?: string }) => error.code === "REQUEST_ID_CONFLICT",
  );
  assert.equal(service.get(first.worker.id).runs.length, 1);
  await assert.rejects(
    service.resume("owner-1", {
      workerId: first.worker.id,
      prompt: "same key different operation",
      requestId: "conflict-key",
    }),
    (error: { code?: string }) => error.code === "REQUEST_ID_CONFLICT",
  );
  assert.equal(service.get(first.worker.id).runs.length, 1);
  const replay = await service.start("owner-1", input);
  assert.equal(replay.worker.id, first.worker.id);
  assert.equal(replay.run.id, first.run.id);
});

test("raising concurrency immediately dispatches queued work", async (t) => {
  const root = temporaryRoot("worker-settings-dispatch-");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "1500",
  });
  service.updateSettings({ concurrency: { dsh: 1, pi: 1 } });
  const first = await service.start("owner-1", startInput({ requestId: "limit-1" }));
  const second = await service.start("owner-1", startInput({ requestId: "limit-2" }));
  await waitStatus(service, first.worker.id, ["running"]);
  assert.equal(service.get(second.worker.id).worker.latestRun?.status, "queued");
  service.updateSettings({ concurrency: { dsh: 2, pi: 1 } });
  const started = Date.now();
  await waitStatus(service, second.worker.id, ["running"], 1000);
  assert.ok(Date.now() - started < 1000);
  assert.equal(service.get(first.worker.id).worker.latestRun?.status, "running");
  await waitStatus(service, first.worker.id, ["completed"]);
  await waitStatus(service, second.worker.id, ["completed"]);
});

test("rejected DSH resume identity never replaces the trusted session", async (t) => {
  const root = temporaryRoot("worker-dsh-wrong-id-");
  const { service, env } = createService(t, root);
  const started = await service.start("owner-1", startInput({ requestId: "trusted-1" }));
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  const trustedId = first.latestRun!.nativeSessionId;
  const trustedFile = first.latestRun!.nativeSessionFile;
  assert.equal(trustedId, "session-fixture-1");
  env.TEST_SESSION_ID = "session-other";
  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "wrong identity",
    requestId: "wrong-id-1",
  });
  const failed = await waitStatus(service, first.id, ["failed"]);
  assert.equal(failed.latestRun?.nativeSessionId, trustedId);
  assert.equal(failed.latestRun?.nativeSessionFile, trustedFile);
  env.TEST_SESSION_ID = "session-fixture-1";
  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "trusted identity again",
    requestId: "wrong-id-2",
  });
  const resumed = await waitStatus(service, first.id, ["completed"]);
  assert.equal(resumed.latestRun?.nativeSessionId, trustedId);
});

function emptyWorker(project: string, type: "dsh" | "pi" = "dsh"): WorkerRecord {
  return {
    id: "worker-restart",
    type,
    taskName: "restart",
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

function emptyRun(workerId: string, home: string, sessions: string): WorkerRun {
  return {
    id: "run-restart",
    workerId,
    requestId: "restart-request",
    status: "starting",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    model: null,
    provider: null,
    effort: null,
    timeoutSeconds: null,
    home,
    sessionsRoot: sessions,
    nativeSessionId: null,
    nativeSessionFile: null,
    exitCode: null,
    finalText: null,
    error: null,
    usage: null,
    progress: {
      steps: null,
      phase: null,
      currentTool: null,
      lastEventAt: null,
      softReminderSentAt: null,
      hardTimeoutAt: null,
    },
  };
}

function seed(
  root: string,
  finalEvidence: boolean | "unconfirmed",
): { project: string; data: string } {
  const project = path.join(root, "project");
  const data = path.join(root, "data");
  fs.mkdirSync(project, { recursive: true });
  const store = new WorkerStore(data);
  store.saveOwner(owner(project));
  const worker = emptyWorker(project);
  const run = emptyRun(worker.id, path.join(root, "dsh-home"), path.join(data, "sessions", "dsh"));
  store.createWorker(
    worker,
    run,
    "parent-1\u0000project-1",
    "restart-request",
    "start",
    "seed",
  );
  if (finalEvidence) {
    const queuedWorker = { ...emptyWorker(project), id: "worker-queued", taskName: "queued restart" };
    const queuedRun = {
      ...emptyRun(queuedWorker.id, path.join(root, "dsh-home"), path.join(data, "sessions", "dsh")),
      id: "run-queued",
      status: "queued" as const,
    };
    store.createWorker(
      queuedWorker,
      queuedRun,
      "parent-1\u0000project-1",
      "queued-request",
      "start",
      "seed-queued",
    );
    const directory = path.join(data, "logs", worker.id, run.id);
    fs.mkdirSync(directory, { recursive: true });
    appendLog(
      directory,
      "events",
      Buffer.from(
        [
          JSON.stringify({ type: "session", sessionId: "session-fixture-1", cwd: project }),
          JSON.stringify({ type: "status", phase: "turn_end", reason: { kind: "completed" } }),
          JSON.stringify({ type: "final", text: "recovered answer" }),
        ].join("\n") + "\n",
      ),
    );
    fs.writeFileSync(
      path.join(directory, "final.json"),
      JSON.stringify({
        reason: "exit",
        exitCode: 0,
        signal: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        groupExited: finalEvidence !== "unconfirmed",
        error: finalEvidence === "unconfirmed" ? "group still alive" : null,
      }),
    );
  }
  store.close();
  return { project, data };
}

test("restart keeps an unconfirmed run unknown and recover releases it", async (t) => {
  const root = temporaryRoot("worker-restart-unknown-");
  const { project, data } = seed(root, false);
  const service = new WorkerService({
    dataDirectory: data,
    environment: environment(root),
    executablePaths: { dsh: "", pi: "" },
    guardianCommand: [process.execPath, "--import", "x", "y"],
  });
  t.after(() => service.close());
  service.registerOwner(owner(project), "owner-token");
  service.recoverFromDisk();
  const unknown = service.get("worker-restart");
  assert.equal(unknown.worker.latestRun?.status, "unknown");
  assert.ok(unknown.worker.latestRun?.error);
  assert.equal(service.state().notifications.length, 0);
  const recovered = service.recover({
    workerId: "worker-restart",
    notes: "verified stopped by operator",
    confirmedStopped: true,
  });
  assert.equal(recovered.latestRun?.status, "interrupted");
  assert.equal(service.state().notifications[0]?.delivery, "held");
});

test("restart finalizes from guardian evidence without re-running", async (t) => {
  const root = temporaryRoot("worker-restart-final-");
  const { project, data } = seed(root, true);
  const service = new WorkerService({
    dataDirectory: data,
    environment: environment(root),
    executablePaths: { dsh: "", pi: "" },
    guardianCommand: [process.execPath, "--import", "x", "y"],
  });
  t.after(() => service.close());
  service.registerOwner(owner(project), "owner-token");
  service.recoverFromDisk();
  const worker = service.get("worker-restart").worker;
  assert.equal(worker.latestRun?.status, "completed");
  assert.equal(worker.latestRun?.finalText, "recovered answer");
  // An old queued task is never launched by restart recovery.
  const queued = service.get("worker-queued").worker;
  assert.equal(queued.latestRun?.status, "cancelled");
  assert.equal(service.get("worker-queued").runs.length, 1);
  const notification = service
    .notifications()
    .find((item) => item.runId === worker.latestRun?.id);
  assert.equal(notification?.delivery, "pending");
});
