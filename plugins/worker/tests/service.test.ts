import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { WorkerStore } from "../server/store.js";
import { WorkerService } from "../server/service.js";
import { appendLog } from "../server/logs.js";
import type {
  WorkerRecord,
  WorkerRun,
  WorkerStartInput,
} from "../shared/contracts.js";
import {
  createService,
  environment,
  owner,
  startInput,
  temporaryRoot,
  waitFor,
  waitStatus,
} from "./helpers.js";

type ConfigureSpec = {
  default: "pi" | "codex" | "agy";
  enabled?: Partial<Record<"pi" | "codex" | "agy", boolean>>;
  roles?: Partial<Record<"pi" | "codex" | "agy", NonNullable<WorkerStartInput["taskRole"]>[]>>;
  concurrency?: Partial<Record<"pi" | "codex" | "agy", number>>;
  defaults?: Partial<Record<"pi" | "codex" | "agy", { model: string | null; effort: string | null }>>;
};

function configure(
  service: ReturnType<typeof createService>["service"],
  spec: ConfigureSpec,
): void {
  const configs = (["pi", "codex", "agy"] as const).map((type) => ({
    id: type + "-default",
    name: type + " default",
    type,
    enabled: spec.enabled?.[type] ?? true,
    roles: [...(spec.roles?.[type] ?? [])],
    concurrency: spec.concurrency?.[type] ?? 3,
    hardTimeoutSeconds: 600,
    model: spec.defaults?.[type]?.model ?? null,
    effort: spec.defaults?.[type]?.effort ?? null,
    ...(type === "codex"
      ? { codex: { modelProvider: "magpie", env: { CODEX_PROXY_BYPASS: "1" }, legacyExtraArgs: [] } }
      : {}),
  }));
  service.updateSettings({
    configs,
    defaultConfigId: spec.default + "-default",
  });
}

test("starts, records, logs, and deduplicates one Pi run", async (t) => {
  const root = temporaryRoot("worker-start-");
  const { service } = createService(t, root);
  const input = startInput({ requestId: "  dedupe-key  " });
  const started = await service.start("owner-1", input);
  const worker = await waitStatus(service, started.worker.id, ["completed"]);
  assert.equal(worker.latestRun?.status, "completed");
  assert.equal(worker.latestRun?.nativeSessionId, "session-fixture-1");
  assert.equal(worker.latestRun?.timeoutSeconds, 600);
  assert.equal(
    worker.latestRun?.progress.hardTimeoutAt,
    new Date(Date.parse(worker.latestRun!.startedAt!) + 600_000).toISOString(),
  );
  assert.ok(fs.existsSync(worker.latestRun!.nativeSessionFile!));
  assert.match(worker.latestRun?.finalText ?? "", /pi answer/);
  assert.equal(worker.latestRun?.usage, null);
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
  service.updateSettings({ concurrency: { pi: 1 } });
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

test("default quotas isolate parents and projects while sharing one existing cwd", async (t) => {
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
  const pi = [];
  for (let index = 0; index < 4; index++)
    pi.push(await service.start("owner-1", startInput({ requestId: "pi-" + index })));
  const other = await service.start(
    "owner-2",
    startInput({ requestId: "other-1" }),
  );
  for (const item of [...pi.slice(0, 3), other])
    await waitStatus(service, item.worker.id, ["running"]);
  assert.equal(service.get(pi[3]!.worker.id).worker.latestRun?.status, "queued");
  assert.equal(service.get(other.worker.id).worker.cwd, fs.realpathSync(project2));
  assert.equal(service.get(pi[0]!.worker.id).worker.cwd, fs.realpathSync(project));

  // Raising the Pi quota admits only that key's queued FIFO item; the
  // separate parent/project remains on its own quota.
  service.updateSettings({ concurrency: { pi: 4 } });
  await waitStatus(service, pi[3]!.worker.id, ["running"], 1000);
  assert.equal(service.get(other.worker.id).worker.latestRun?.status, "running");

  for (const item of [...pi, other])
    await waitStatus(service, item.worker.id, ["completed"], 12000);
});

test("parents in the same project have independent quotas and request ids", async (t) => {
  const root = temporaryRoot("worker-same-project-");
  const { service, project } = createService(t, root, { TEST_SCENARIO: "sleep", TEST_DELAY_MS: "1500" });
  service.updateSettings({ concurrency: { pi: 1 } });
  service.registerOwner({ ...owner(project), id: "other-owner", parentSessionId: "other-parent" }, "other-token");
  const first = await service.start("owner-1", startInput({ requestId: "same-request" }));
  const queued = await service.start("owner-1", startInput({ requestId: "next-request" }));
  const other = await service.start("other-owner", startInput({ requestId: "same-request" }));
  assert.notEqual(first.worker.id, other.worker.id);
  await waitStatus(service, first.worker.id, ["running"]);
  await waitStatus(service, other.worker.id, ["running"]);
  assert.equal(service.get(queued.worker.id).worker.latestRun?.status, "queued");
  assert.equal(service.get(first.worker.id).worker.projectId, service.get(other.worker.id).worker.projectId);
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
  service.updateSettings({ concurrency: { pi: 1 } });
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
    timeoutSeconds: 30,
  });
  const second = await waitStatus(service, first.id, ["completed"]);
  assert.equal(second.latestRun?.effort, "high");
  assert.equal(second.latestRun?.nativeSessionFile, first.latestRun?.nativeSessionFile);
  assert.equal(
    second.latestRun?.progress.hardTimeoutAt,
    new Date(Date.parse(second.latestRun!.startedAt!) + 30_000).toISOString(),
  );
  assert.equal(service.get(first.id).runs.length, 2);
});

test("hard timeout fails the run with guardian evidence", async (t) => {
  const root = temporaryRoot("worker-timeout-");
  const { service } = createService(t, root, { TEST_SCENARIO: "hang" });
  const settings = service.settings();
  service.updateSettings({
    configs: settings.configs.map((config) => ({ ...config, hardTimeoutSeconds: 1 })),
    defaultConfigId: settings.defaultConfigId,
  });
  const started = await service.start(
    "owner-1",
    startInput({ requestId: "timeout-1" }),
  );
  assert.equal(
    started.run.progress.hardTimeoutAt,
    new Date(Date.parse(started.run.startedAt!) + 1000).toISOString(),
  );
  const worker = await waitStatus(service, started.worker.id, ["failed"], 12000);
  assert.equal(worker.latestRun?.error?.code, "TIMEOUT");
  assert.ok(worker.latestRun?.finishedAt);
  assert.equal(service.notifications()[0]?.status, "failed");
  assert.equal(service.notifications()[0]?.delivery, "pending");
});

for (const trigger of ["elapsed", "steps"] as const) test(`${trigger} budget deduplicates pending reviews without cancelling and preserves the result`, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = temporaryRoot("worker-reminder-");
  let now = Date.now();
  const { service } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "3000",
    TEST_STEPS_BEFORE_DELAY: trigger === "steps" ? "20" : "0",
  }, { now: () => now });
  const started = await service.start("owner-1", startInput({ requestId: "reminder-1" }));
  await waitStatus(service, started.worker.id, ["running"]);
  if (trigger === "elapsed") {
    await waitFor(
      () => service.get(started.worker.id).worker.latestRun?.progress.currentTool,
      (tool) => tool === "read",
    );
    now += 600_000;
  }
  else await waitFor(
    () => service.get(started.worker.id).worker.latestRun?.progress.steps ?? 0,
    (steps) => steps >= 20,
  );
  t.mock.timers.tick(1000);
  const reminder = service.notifications()[0]!;
  assert.equal(reminder.status, "running");
  assert.equal(reminder.delivery, "pending");
  assert.equal(reminder.workerId, started.worker.id);
  assert.equal(reminder.runId, started.run.id);
  assert.match(reminder.summary, /soft budget reached \(\d+s elapsed(?:, \d+ steps)?, phase \w+/);
  assert.match(reminder.summary, /last event \d+s ago\)$/);
  // A silent tool keeps its name; a fast step run may already be final without one.
  if (trigger === "elapsed") {
    assert.doesNotMatch(reminder.summary, / steps/);
    assert.match(reminder.summary, /, tool read,/);
  } else {
    assert.match(reminder.summary, /, \d+ steps,/);
  }
  assert.doesNotMatch(reminder.summary, /thresholds|Check actual progress|\n/);
  if (trigger === "steps")
    assert.ok((service.get(started.worker.id).worker.latestRun?.progress.steps ?? 0) >= 20);
  assert.equal(service.state().counts.total.running, 1, "a reminder still occupies its execution slot");
  t.mock.timers.tick(1000);
  assert.equal(service.notifications().length, 1, "the outstanding reminder is not duplicated");
  if (trigger === "elapsed") service.ack("owner-1", [reminder.id]);

  const completed = await waitStatus(service, started.worker.id, ["completed"]);
  assert.ok(completed.latestRun?.progress.softReminderSentAt);
  assert.equal(completed.latestRun?.status, "completed");
  assert.equal(service.notifications().length, 2, "the reminder must not consume the terminal notification");
  assert.equal(service.notifications()[0]?.delivery, trigger === "elapsed" ? "delivered" : "held");
  const claimed = service.claimNotifications("owner-1", [], "result-batch");
  assert.deepEqual(claimed.notifications.map((item) => item.status), ["completed"]);
});

test("an early step reminder keeps timed reviews active while a tool is silent", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = temporaryRoot("worker-recurring-reminder-");
  let now = Date.now();
  const { service } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "3000",
    TEST_STEPS_BEFORE_DELAY: "20",
  }, { now: () => now });
  const started = await service.start("owner-1", startInput());
  await waitFor(() => service.logs(started.worker.id, { stream: "events" }).text,
    (log) => (log.match(/"type":"turn_end"/g) ?? []).length === 20);
  // The guardian appends the event log before the parent consumes the same lines over IPC, and
  // step counting for reminders happens in the parent. Fire the one-second review interval until
  // a reminder exists instead of assuming the parent already consumed all 20 step_end lines; the
  // injected clock stays fixed, so extra interval fires cannot make a timed review due early.
  await waitFor(
    () => {
      t.mock.timers.tick(1000);
      return service.notifications().length;
    },
    (count) => count >= 1,
  );
  assert.equal(service.notifications().length, 1, "a due step budget produces exactly one reminder");
  const first = service.notifications()[0]!;
  service.ack("owner-1", [first.id]);

  now += 599_999;
  t.mock.timers.tick(1000);
  assert.equal(service.notifications().length, 1, "step count must not cause repeated wakeups");
  now += 1;
  t.mock.timers.tick(1000);
  const second = service.notifications()[1]!;
  assert.equal(service.notifications().length, 2, "a silent tool must not suppress the next timed review");
  assert.equal(second.runId, started.run.id);
  assert.equal(second.status, "running");
  assert.equal(service.get(started.worker.id).worker.latestRun?.status, "running");
  assert.equal(service.get(started.worker.id).worker.latestRun?.progress.steps, 20);

  service.claimNotifications("owner-1", [second.id], "reminder-batch");
  now += 600_000;
  t.mock.timers.tick(1000);
  assert.equal(service.notifications().length, 2, "pending or claimed reminders must not accumulate");
  service.settleNotifications("reminder-batch", "delivered");
  t.mock.timers.tick(1000);
  const third = service.notifications()[2]!;
  assert.equal(third.status, "running");
  assert.notEqual(third.id, second.id);

  await waitStatus(service, started.worker.id, ["completed"]);
  assert.deepEqual(service.notifications().map((item) => item.status), ["running", "running", "running", "completed"]);
  assert.equal(service.notifications()[2]?.delivery, "held", "the result supersedes the outstanding reminder");
  now += 600_000;
  t.mock.timers.tick(1000);
  assert.equal(service.notifications().length, 4, "finished runs stop producing reminders");
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

test("Pi ignores removed environment model settings", async (t) => {
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
  assert.equal(first.latestRun?.model, null);
  assert.equal(first.latestRun?.provider, null);
  assert.equal(first.latestRun?.effort, null);
  const firstSpec = fs.readFileSync(
    path.join(data, "logs", first.id, first.latestRun!.id, "spec.json"),
    "utf8",
  );
  assert.doesNotMatch(firstSpec, /env-model/);
  assert.doesNotMatch(firstSpec, /env-provider/);
  assert.doesNotMatch(firstSpec, /"low"/);

  env.CODEX_PI_MODEL = "changed-model";
  env.CODEX_PI_PROVIDER = "changed-provider";
  env.CODEX_PI_THINKING = "high";
  await service.resume("owner-1", {
    workerId: first.id,
    prompt: "resume",
    requestId: "pi-env-2",
  });
  const resumed = await waitStatus(service, first.id, ["completed"]);
  assert.equal(resumed.latestRun?.model, null);
  assert.equal(resumed.latestRun?.provider, null);
  assert.equal(resumed.latestRun?.effort, null);
  const secondSpec = fs.readFileSync(
    path.join(data, "logs", first.id, resumed.latestRun!.id, "spec.json"),
    "utf8",
  );
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
    executablePaths: { pi: "" },
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
    executablePaths: { pi: "" },
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
  service.updateSettings({ concurrency: { pi: 1 } });
  const first = await service.start("owner-1", startInput({ requestId: "limit-1" }));
  const second = await service.start("owner-1", startInput({ requestId: "limit-2" }));
  await waitStatus(service, first.worker.id, ["running"]);
  assert.equal(service.get(second.worker.id).worker.latestRun?.status, "queued");
  service.updateSettings({ concurrency: { pi: 2 } });
  const started = Date.now();
  await waitStatus(service, second.worker.id, ["running"], 1000);
  assert.ok(Date.now() - started < 1000);
  assert.equal(service.get(first.worker.id).worker.latestRun?.status, "running");
  await waitStatus(service, first.worker.id, ["completed"]);
  await waitStatus(service, second.worker.id, ["completed"]);
});

test("rejected Pi resume identity never replaces the trusted session", async (t) => {
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

function emptyWorker(project: string, type: "dsh" | "pi" = "pi"): WorkerRecord {
  return {
    id: "worker-restart",
    type,
    configId: type + "-default",
    configName: type + " default",
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
          JSON.stringify({ type: "session", id: "session-fixture-1", cwd: project }),
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "recovered answer" }],
            },
          }),
          JSON.stringify({ type: "turn_end" }),
          JSON.stringify({ type: "agent_end", willRetry: false }),
          JSON.stringify({ type: "agent_settled", aborted: false }),
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
    executablePaths: { pi: "" },
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
    executablePaths: { pi: "" },
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

test("settings persist configured defaults, normalize legacy rows, and validate atomically", async (t) => {
  const root = temporaryRoot("worker-settings-");
  const { service, data } = createService(t, root);
  // Simulate a row written before defaultWorkerType/defaults existed.
  service.store.saveSettings({
    concurrency: { pi: 5, codex: 2 },
    softReminderSeconds: 42,
    softReminderSteps: 7,
    hardTimeoutSeconds: 90,
  } as never);
  const normalized = service.settings();
  assert.equal(normalized.defaultWorkerType, "pi");
  assert.deepEqual(normalized.enabled, { dsh: false, pi: true, codex: true, agy: false });
  assert.deepEqual(normalized.roles, { dsh: [], pi: [], codex: [], agy: [] });
  assert.deepEqual(normalized.defaults, {
    dsh: { model: null, effort: null },
    pi: { model: null, effort: null },
    codex: { model: null, effort: null },
    agy: { model: null, effort: null },
  });
  assert.deepEqual(normalized.concurrency, { dsh: 1, pi: 5, codex: 2, agy: 1 });
  assert.deepEqual(normalized.codex, {
    env: { CODEX_PROXY_BYPASS: "1" },
    extraArgs: ["-c", "model_provider=magpie"],
  });
  assert.equal(normalized.softReminderSeconds, 42);
  assert.equal(normalized.softReminderSteps, 7);
  assert.equal(normalized.hardTimeoutSeconds, 90);
  assert.equal(normalized.retentionDays, 1);

  const saved = service.updateSettings({
    concurrency: { pi: 6, codex: 1 },
    retentionDays: 7,
    defaultWorkerType: "pi",
    enabled: { pi: true, codex: false },
    roles: { pi: ["plan_review"], codex: ["code_review"] },
    defaults: {
      pi: { model: "  pi-model  ", effort: "low" },
      codex: { model: "codex-model", effort: "xhigh" },
    },
    codex: {
      env: { TEST_CODEX_CUSTOM: "custom-value" },
      extraArgs: ["--sandbox", "workspace-write"],
    },
  });
  assert.equal(saved.defaultWorkerType, "pi");
  assert.deepEqual(saved.enabled, { dsh: false, pi: true, codex: false, agy: false });
  assert.deepEqual(saved.roles, {
    dsh: [],
    pi: ["plan_review"],
    codex: ["code_review"],
    agy: [],
  });
  assert.deepEqual(saved.defaults, {
    dsh: { model: null, effort: null },
    pi: { model: "pi-model", effort: "low" },
    codex: { model: "codex-model", effort: "xhigh" },
    agy: { model: null, effort: null },
  });
  assert.deepEqual(saved.codex, {
    env: { TEST_CODEX_CUSTOM: "custom-value" },
    extraArgs: ["--sandbox", "workspace-write"],
  });
  assert.equal(saved.softReminderSeconds, 42);
  assert.equal(saved.hardTimeoutSeconds, 90);
  assert.equal(saved.retentionDays, 7);

  for (const retentionDays of [0, -1, 1.5, null, "2", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => service.updateSettings({ concurrency: { pi: 9 }, retentionDays } as never),
      /retentionDays 必须是正整数/,
    );
    assert.deepEqual(service.settings(), saved);
  }

  assert.throws(
    () =>
      service.updateSettings({
        concurrency: { pi: 9 },
        defaultWorkerType: "pi",
        defaults: { pi: { model: null, effort: "extreme" } },
      }),
    /defaults\.pi\.effort/,
  );
  assert.deepEqual(service.settings(), saved);
  assert.throws(
    () => service.updateSettings({ concurrency: { pi: 0 } }),
    /正整数/,
  );
  assert.deepEqual(service.settings(), saved);

  const secret = "settings-secret-never-echoed";
  for (const codex of [
    { env: { SECRET: secret, BAD: 7 }, extraArgs: [] },
    { env: {}, extraArgs: [secret, 7] },
    { env: ["not-a-map"], extraArgs: [] },
  ]) {
    assert.throws(
      () => service.updateSettings({ concurrency: { pi: 9 }, codex: codex as never }),
      (error: unknown) =>
        /codex\.(env|extraArgs)/.test(String(error)) &&
        !String(error).includes(secret),
    );
    assert.deepEqual(service.settings(), saved);
  }
  assert.throws(
    () => service.updateSettings({ concurrency: { pi: 9, codex: 0 } }),
    /concurrency\.codex 必须是正整数/,
  );
  assert.deepEqual(service.settings(), saved);

  for (const invalid of [
    { enabled: { pi: true } },
    { enabled: { pi: true, codex: "false" } },
    { roles: { pi: [] } },
    { roles: { pi: ["unknown-role"], codex: [] } },
    { roles: { pi: [7], codex: [] } },
    { enabled: { pi: false, codex: false } },
  ]) {
    assert.throws(
      () => service.updateSettings({ concurrency: { pi: 9 }, ...invalid } as never),
      /enabled|roles|defaultWorkerType/,
    );
    assert.deepEqual(service.settings(), saved);
  }

  const alternate = path.join(root, "alternate-workspace");
  for (const extraArgs of [
    ["-C", alternate],
    ["--cd", alternate],
    ["--cd=" + alternate],
    ["-C" + alternate],
  ]) {
    assert.throws(
      () =>
        service.updateSettings({
          concurrency: { pi: 9 },
          defaultWorkerType: "pi",
          defaults: {
            pi: { model: "changed", effort: null },
            codex: { model: "changed", effort: null },
          },
          codex: { env: { SECRET: secret }, extraArgs },
        }),
      (error: unknown) => {
        const message = String(error);
        return (
          /工作目录由任务工作区控制/.test(message) &&
          !message.includes(alternate) &&
          !message.includes(secret)
        );
      },
    );
    assert.deepEqual(service.settings(), saved);
  }

  const reopened = new WorkerStore(data);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.settings(), saved);

  const updated = service.updateSettings({ concurrency: { pi: 4 } });
  assert.equal(updated.defaultWorkerType, "pi");
  assert.deepEqual(updated.enabled, saved.enabled);
  assert.deepEqual(updated.roles, saved.roles);
  assert.deepEqual(updated.defaults, saved.defaults);
  assert.deepEqual(updated.codex, saved.codex);
  assert.equal(updated.concurrency.codex, 1);
  assert.equal(updated.retentionDays, 7);

  const cleared = service.updateSettings({
    concurrency: { pi: 4 },
    codex: { env: {}, extraArgs: [] },
  });
  assert.deepEqual(cleared.codex, { env: {}, extraArgs: [] });
  assert.deepEqual(service.updateSettings({ concurrency: { pi: 4 } }).codex, {
    env: {},
    extraArgs: [],
  });
});
test("omitted type uses configured defaults ahead of Pi environment, and replay ignores later changes", async (t) => {
  const root = temporaryRoot("worker-default-selection-");
  const { service, data } = createService(t, root, {
    CODEX_PI_MODEL: "env-model",
    CODEX_PI_PROVIDER: "env-provider",
    CODEX_PI_THINKING: "low",
  });
  configure(service, {
    default: "pi",
    defaults: { pi: { model: "pi-default", effort: "medium" } },
  });
  const input = startInput({ type: undefined, requestId: "default-pi-1" });
  const started = await service.start("owner-1", input);
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  assert.equal(first.type, "pi");
  assert.equal(first.latestRun?.model, "pi-default");
  assert.equal(first.latestRun?.provider, null);
  assert.equal(first.latestRun?.effort, "medium");
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(data, "logs", first.id, first.latestRun!.id, "spec.json"),
      "utf8",
    ),
  ) as { argv: string[] };
  assert.deepEqual(
    spec.argv.slice(spec.argv.indexOf("--model")),
    ["--model", "pi-default", "--thinking", "medium"],
  );

  const explicit = await service.start(
    "owner-1",
    startInput({ type: "pi", model: "explicit-pi", effort: "low", requestId: "explicit-pi-1" }),
  );
  const explicitWorker = await waitStatus(service, explicit.worker.id, ["completed"]);
  assert.equal(explicitWorker.type, "pi");
  assert.equal(explicitWorker.latestRun?.model, "explicit-pi");
  assert.equal(explicitWorker.latestRun?.effort, "low");
  const explicitSpec = JSON.parse(
    fs.readFileSync(
      path.join(data, "logs", explicitWorker.id, explicitWorker.latestRun!.id, "spec.json"),
      "utf8",
    ),
  ) as { argv: string[] };
  assert.deepEqual(
    explicitSpec.argv.slice(explicitSpec.argv.indexOf("--model")),
    ["--model", "explicit-pi", "--thinking", "low"],
  );

  // The same raw request replay returns the original Pi run even though the default changed.
  configure(service, {
    default: "codex",
    defaults: { pi: { model: "changed-pi", effort: null } },
  });
  const replayed = await service.start("owner-1", input);
  assert.equal(replayed.worker.id, first.id);
  assert.equal(replayed.run.id, first.latestRun?.id);
  assert.equal(service.get(first.id).runs.length, 1);
});
test("task roles route omitted types through enabled matches, config order, and default fallback", async (t) => {
  const root = temporaryRoot("worker-role-selection-");
  const { service } = createService(t, root);
  const started: string[] = [];
  const start = async (taskRole?: WorkerStartInput["taskRole"], type?: WorkerStartInput["type"]) => {
    const result = await service.start(
      "owner-1",
      startInput({ type, taskRole, requestId: "role-" + started.length }),
    );
    started.push(result.worker.id);
    return result.worker.type;
  };

  // The only matching enabled type wins even when it is not the configured default.
  configure(service, {
    default: "agy",
    roles: { pi: ["plan_review"], codex: ["testing"], agy: ["testing"] },
  });
  assert.equal(await start("plan_review"), "pi");
  assert.equal(await start(undefined), "agy");

  // Multiple role matches follow config order, including when a later match is the default.
  configure(service, {
    default: "pi",
    roles: { pi: ["testing"], codex: ["testing"] },
  });
  assert.equal(await start("testing"), "pi");
  assert.equal(await start(), "pi");

  // A default without a role match also leaves the config order unchanged.
  configure(service, {
    default: "codex",
    roles: { pi: ["testing"], codex: ["testing"] },
  });
  assert.equal(await start("testing"), "pi");

  // Disabled matches are excluded before default/order selection.
  configure(service, {
    default: "pi",
    enabled: { agy: false },
    roles: { pi: ["testing"], agy: ["testing"] },
  });
  assert.equal(await start("testing"), "pi");
  await assert.rejects(() => start("testing", "agy"), /该 worker 类型已禁用/);

  assert.equal(await start("code_review"), "pi");
  assert.equal(await start("testing", "codex"), "codex");

  for (const workerId of started) await waitStatus(service, workerId, ["completed"]);
  assert.equal(service.state().workers.length, started.length);
});
test("disabling a type keeps accepted queued work but rejects new starts and resumes", async (t) => {
  const root = temporaryRoot("worker-role-disable-");
  const { service } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "300",
  });
  configure(service, {
    default: "agy",
    concurrency: { agy: 1 },
    roles: { agy: ["testing"] },
  });
  const running = await service.start(
    "owner-1",
    startInput({ type: "agy", requestId: "disable-running" }),
  );
  await waitStatus(service, running.worker.id, ["running"]);
  const queued = await service.start(
    "owner-1",
    startInput({ type: "agy", requestId: "disable-queued" }),
  );
  assert.equal(service.get(queued.worker.id).worker.latestRun?.status, "queued");

  configure(service, {
    default: "pi",
    concurrency: { agy: 1 },
    enabled: { agy: false },
  });
  // Work accepted before the change still runs and completes.
  await waitStatus(service, running.worker.id, ["completed"]);
  await waitStatus(service, queued.worker.id, ["completed"]);

  await assert.rejects(
    () => service.start("owner-1", startInput({ type: "agy", requestId: "disable-new" })),
    /该 worker 类型已禁用/,
  );
  // An omitted type no longer matches the disabled role type and falls back to the default.
  const fallback = await service.start(
    "owner-1",
    startInput({ type: undefined, taskRole: "testing", requestId: "disable-fallback" }),
  );
  assert.equal(fallback.worker.type, "pi");
  const resumeInput = {
    workerId: running.worker.id,
    prompt: "continue",
    requestId: "disable-resume",
  };
  await assert.rejects(() => service.resume("owner-1", resumeInput), /该 worker 类型已禁用/);
  assert.equal(service.get(running.worker.id).runs.length, 1);

  configure(service, {
    default: "agy",
    concurrency: { agy: 1 },
    roles: { agy: ["testing"] },
  });
  const resumed = await service.resume("owner-1", resumeInput);
  assert.equal(resumed.worker.type, "agy");
  await waitStatus(service, resumed.worker.id, ["completed"]);
  assert.equal(service.get(running.worker.id).runs.length, 2);

  // A replay of the already accepted resume returns its original run even while disabled.
  configure(service, {
    default: "pi",
    concurrency: { agy: 1 },
    enabled: { agy: false },
  });
  const replayedResume = await service.resume("owner-1", resumeInput);
  assert.equal(replayedResume.run.id, resumed.run.id);
  assert.equal(service.get(running.worker.id).runs.length, 2);
});
test("task roles are part of start replay identity and settings changes keep replayed work", async (t) => {
  const root = temporaryRoot("worker-role-replay-");
  const { service } = createService(t, root);
  configure(service, {
    default: "agy",
    roles: { agy: ["code_review"] },
  });
  const input = startInput({ type: undefined, taskRole: "code_review", requestId: "role-replay" });
  const started = await service.start("owner-1", input);
  assert.equal(started.worker.type, "agy");
  assert.equal(started.worker.taskRole, "code_review");

  // Later configuration changes, including disabling the original type, never reinterpret the
  // accepted request.
  configure(service, {
    default: "pi",
    enabled: { agy: false },
    roles: { pi: ["code_review"] },
  });
  const replayed = await service.start("owner-1", input);
  assert.equal(replayed.worker.id, started.worker.id);
  assert.equal(replayed.run.id, started.run.id);
  assert.equal(replayed.worker.type, "agy");

  await assert.rejects(
    () => service.start("owner-1", startInput({ type: undefined, taskRole: "testing", requestId: "role-replay" })),
    /requestId 已用于不同的请求内容或操作/,
  );
  assert.equal(service.get(started.worker.id).runs.length, 1);

  const legacy = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "legacy-without-role" }),
  );
  assert.equal(legacy.worker.taskRole, undefined);
  assert.equal("taskRole" in (service.store.worker(legacy.worker.id) as object), false);
  const legacyReplay = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "legacy-without-role" }),
  );
  assert.equal(legacyReplay.worker.id, legacy.worker.id);
  assert.equal(service.get(legacy.worker.id).runs.length, 1);
});
test("queued runs keep accepted defaults and resume retains recorded selection", async (t) => {
  const root = temporaryRoot("worker-default-queue-");
  const { service, data } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "300",
  });
  configure(service, {
    default: "pi",
    concurrency: { pi: 1 },
    defaults: { pi: { model: "accepted-model", effort: "high" } },
  });
  const blocker = await service.start("owner-1", startInput({ requestId: "queue-blocker" }));
  await waitStatus(service, blocker.worker.id, ["running"]);
  const queued = await service.start(
    "owner-1",
    startInput({ type: undefined, requestId: "queue-defaulted" }),
  );
  assert.equal(service.get(queued.worker.id).worker.latestRun?.status, "queued");
  assert.equal(queued.run.model, "accepted-model");
  configure(service, {
    default: "pi",
    concurrency: { pi: 1 },
    defaults: { pi: { model: "changed-model", effort: "low" } },
  });
  const retained = service.get(queued.worker.id).worker.latestRun!;
  assert.equal(retained.model, "accepted-model");
  assert.equal(retained.effort, "high");
  const finished = await waitStatus(service, queued.worker.id, ["completed"]);
  const spec = JSON.parse(
    fs.readFileSync(
      path.join(data, "logs", finished.id, finished.latestRun!.id, "spec.json"),
      "utf8",
    ),
  ) as { argv: string[] };
  assert.deepEqual(
    spec.argv.slice(spec.argv.indexOf("--model")),
    ["--model", "accepted-model", "--thinking", "high"],
  );

  const resumed = await service.resume("owner-1", {
    workerId: finished.id,
    prompt: "resume with recorded defaults",
    requestId: "resume-defaulted",
  });
  assert.equal(resumed.run.model, "accepted-model");
  assert.equal(resumed.run.provider, null);
  assert.equal(resumed.run.effort, "high");
  await waitStatus(service, finished.id, ["completed"]);
  const overridden = await service.resume("owner-1", {
    workerId: finished.id,
    prompt: "resume with explicit override",
    requestId: "resume-override",
    model: "explicit-resume",
    effort: "medium",
  });
  assert.equal(overridden.run.model, "explicit-resume");
  assert.equal(overridden.run.effort, "medium");
});
test("active Worker queries are scoped to one runtime owner and ignore terminal runs", async (t) => {
  const root = temporaryRoot("worker-active-owner-");
  const { service, project } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "300",
  });
  service.updateSettings({ concurrency: { pi: 1 } });
  service.registerOwner({ ...owner(project), id: "owner-2", parentSessionId: "parent-2", appServerInstanceId: "app-2" }, "owner-2-token");
  const first = await service.start("owner-1", startInput({ requestId: "active-1" }));
  const queued = await service.start("owner-1", startInput({ requestId: "active-2" }));
  assert.equal(service.hasActiveWorkers("owner-1"), true, "queued work is active too");
  assert.equal(service.hasActiveWorkers("owner-2"), false, "another owner is never counted");
  await waitStatus(service, first.worker.id, ["running"]);
  assert.equal(service.hasActiveWorkers("owner-1"), true);
  await waitStatus(service, queued.worker.id, ["completed"], 5000);
  assert.equal(service.hasActiveWorkers("owner-1"), false);
});
