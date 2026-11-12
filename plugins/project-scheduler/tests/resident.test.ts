import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ResidentHost,
  ResidentHostError,
  parseResidentMessage,
  type ResidentHostTransport,
} from "../server/resident-ipc.js";
import { ResidentTasks } from "../server/resident.js";
import { SchedulerStore } from "../server/store.js";
import { TelegramNotifier } from "../server/telegram.js";
import { defaultSettings } from "../server/configuration.js";
import type {
  ResidentBindingView,
  ResidentIpcRequest,
  StageLogEntry,
  ResidentTerminal,
  SchedulerRun,
  SchedulerSettings,
} from "../shared/contracts.js";

const CHANNEL = "cloudcli-scheduler-resident";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resident-test-"));
  const store = new SchedulerStore(path.join(root, "data"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store };
}

function binding(overrides: Partial<ResidentBindingView> = {}): ResidentBindingView {
  return {
    taskId: "task-1",
    name: "原会话标题",
    sessionId: "session-1",
    projectId: "p1",
    enabled: true,
    visible: true,
    status: "running",
    executionId: "exec-1",
    stopCause: null,
    runtime: { provider: "codex", permissionMode: "full-auto", sandboxMode: "workspace-write" },
    terminal: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function terminal(overrides: Partial<ResidentTerminal> = {}): ResidentTerminal {
  return {
    id: "terminal-1",
    taskId: "task-1",
    sessionId: "session-1",
    executionId: "exec-1",
    status: "success",
    cause: "completed",
    alert: true,
    endedAt: "2026-01-01T01:00:00.000Z",
    reason: null,
    ...overrides,
  };
}

/** Real client over a scripted in-process host, so correlation bugs are exercised for real. */
function fakeHost(t: TestContext) {
  const sent: ResidentIpcRequest[] = [];
  let listener: ((message: unknown) => void) | undefined;
  const transport: ResidentHostTransport = {
    send(message) {
      sent.push(message);
      return true;
    },
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  const host = new ResidentHost(transport, 1000);
  t.after(() => host.close());
  const respond = (message: ResidentIpcRequest, value: unknown) =>
    listener?.({ channel: CHANNEL, id: message.id, kind: "response", ok: true, value });
  const fail = (
    message: ResidentIpcRequest,
    code: string,
    messageText = "host failure",
  ) =>
    listener?.({
      channel: CHANNEL,
      id: message.id,
      kind: "response",
      ok: false,
      error: { code, message: messageText },
    });
  const emit = (event: string, value: unknown) =>
    listener?.({ channel: CHANNEL, kind: "event", event, value });
  return { host, sent, respond, fail, emit };
}

test("resident metadata is isolated from scheduled tasks, ordinary runs and recovery", (t) => {
  const { store } = fixture(t);
  const task = {
    id: "tick",
    name: "tick",
    type: "script" as const,
    enabled: true,
    cron: "0 0 0 1 1 *",
    timezone: "UTC",
    allowConcurrent: false,
    timeoutSeconds: 60,
    cwd: "/tmp",
    env: {},
    agent: { provider: "codex" as const, model: "default" },
    command: "true",
    args: [],
    notify: true,
  };
  store.importProject("p1", [task], true);
  const before = store.definitions();
  store.resident.ensureTask({
    taskId: "task-1",
    sessionId: "session-1",
    notify: true,
    lastProcessedTerminalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  // A load with removeMissing must not see resident metadata as a stale project task.
  store.importProject("p1", [task], true);
  assert.equal(store.definitions().length, before.length);
  assert.equal(store.resident.tasks().length, 1);
  const run: SchedulerRun = {
    id: "terminal-1",
    projectId: "p1",
    projectName: "project",
    taskId: "task-1",
    taskName: "原会话标题",
    status: "success",
    trigger: "resident",
    scheduledAt: "2026-01-01T01:00:00.000Z",
    startedAt: "2026-01-01T01:00:00.000Z",
    endedAt: "2026-01-01T01:00:00.000Z",
    exitCode: null,
    reason: null,
    workerPid: null,
    alertStatus: "pending",
    alertError: null,
    alertAttempts: 0,
    source: "resident",
    residentTaskId: "task-1",
    sessionId: "session-1",
    executionId: "exec-1",
  };
  assert.equal(store.resident.recordTerminal(run), true);
  assert.deepEqual(store.runs("p1", "task-1"), []);
  assert.deepEqual(store.runs(), []);
  assert.equal(store.resident.runs("task-1").length, 1);
  assert.equal(store.definitions()[0].lastRun, null);
  // A resident row that somehow carries `running` never joins crash recovery.
  store.resident.recordTerminal({ ...run, id: "legacy", status: "running" });
  assert.deepEqual(store.unfinished(), []);
});

test("re-delivered terminals keep the run row, alert counters and the delivery cursor", (t) => {
  const { store } = fixture(t);
  store.resident.ensureTask({
    taskId: "task-1",
    sessionId: "session-1",
    notify: true,
    lastProcessedTerminalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const run: SchedulerRun = {
    id: "terminal-1",
    projectId: "p1",
    projectName: "project",
    taskId: "task-1",
    taskName: "title",
    status: "failed",
    trigger: "resident",
    scheduledAt: "2026-01-01T01:00:00.000Z",
    startedAt: "2026-01-01T01:00:00.000Z",
    endedAt: "2026-01-01T01:00:00.000Z",
    exitCode: null,
    reason: "boom",
    workerPid: null,
    alertStatus: "pending",
    alertError: null,
    alertAttempts: 0,
    source: "resident",
    residentTaskId: "task-1",
    sessionId: "session-1",
    executionId: "exec-1",
  };
  assert.equal(store.resident.recordTerminal(run), true);
  const delivered = store.resident.runs("task-1")[0];
  store.saveRun({ ...delivered, alertStatus: "sent", alertAttempts: 2 });
  assert.equal(store.resident.recordTerminal({ ...run, reason: "again" }), false);
  const kept = store.resident.runs("task-1")[0];
  assert.equal(kept.alertAttempts, 2);
  assert.equal(kept.alertStatus, "sent");
  assert.equal(kept.reason, "boom");
  assert.equal(store.resident.task("task-1")?.lastProcessedTerminalId, "terminal-1");
});

test("IPC client matches responses by id, maps host errors and rejects transport gaps", async (t) => {
  const { host, sent, respond, fail } = fakeHost(t);
  const first = host.request("status", {});
  const second = host.request("status", { taskId: "a" });
  assert.equal(sent.length, 2);
  respond(sent[1], { bindings: [binding()] });
  respond(sent[0], { bindings: [] });
  assert.equal((await first).bindings.length, 0);
  assert.equal((await second).bindings.length, 1);
  const failing = host.request("stop", { taskId: "task-1" });
  fail(sent[2], "stop_failed", "无法停止");
  await assert.rejects(failing, (error: ResidentHostError) => {
    assert.equal(error.code, "stop_failed");
    assert.equal(error.message, "无法停止");
    return true;
  });
  const unavailable = new ResidentHost(
    { send: () => false, subscribe: () => () => {} },
    1000,
  );
  await assert.rejects(unavailable.request("status", {}), {
    code: "host_unavailable",
  });
  const timedOut = new ResidentHost(
    { send: () => true, subscribe: () => () => {} },
    20,
  );
  await assert.rejects(timedOut.request("status", {}), { code: "timeout" });
});

test("IPC boundary accepts only well-formed resident envelopes", () => {
  assert.equal(parseResidentMessage({ channel: CHANNEL, kind: "event" }), null);
  assert.equal(
    parseResidentMessage({ channel: CHANNEL, kind: "event", event: "sync", value: {} }),
    null,
  );
  assert.equal(
    parseResidentMessage({ channel: "cloudcli-workers", kind: "event", event: "sync", value: { bindings: [] } }),
    null,
  );
  assert.equal(parseResidentMessage({ channel: CHANNEL, kind: "event", event: "changed", value: { taskIds: [] } })?.kind, "event");
  assert.equal(parseResidentMessage({ channel: CHANNEL, kind: "event", event: "terminal", value: { id: "t" } }), null);
  assert.equal(
    parseResidentMessage({ channel: CHANNEL, kind: "response", id: "1", ok: false, error: {} }),
    null,
  );
});

function service(
  t: TestContext,
  options: { telegram?: boolean } = {},
) {
  const { store } = fixture(t);
  if (options.telegram) {
    const settings: SchedulerSettings = {
      ...defaultSettings(),
      telegram: { enabled: true, botToken: "123:secret", chatId: "1", proxy: "" },
    };
    store.saveSettings(settings);
  }
  const host = fakeHost(t);
  let flushes = 0;
  const resident = new ResidentTasks(
    store,
    host.host,
    () => {
      flushes++;
    },
    () => "project-name",
  );
  return { store, host, resident, flushes: () => flushes };
}

test("adoption stores metadata only after the host accepts the binding", async (t) => {
  const { store, host, resident } = service(t);
  const created = resident.create("session-1");
  const adopt = host.sent.at(-1)!;
  assert.equal(adopt.action, "adopt");
  assert.equal((adopt.payload as { sessionId: string }).sessionId, "session-1");
  const taskId = (adopt.payload as { taskId: string }).taskId;
  assert.match(taskId, /^[0-9a-f-]{36}$/);
  host.respond(adopt, { binding: binding({ taskId }) });
  const row = await created;
  assert.equal(row.taskId, taskId);
  assert.equal(row.notify, true);
  assert.equal(row.name, "原会话标题");
  assert.equal(store.resident.task(taskId)?.sessionId, "session-1");

  const duplicate = resident.create("session-2");
  host.fail(host.sent.at(-1)!, "already_resident", "已是常驻任务");
  await assert.rejects(duplicate, { code: "already_resident" });
  assert.equal(store.resident.tasks().length, 1);
});

test("list, detail, switches, stop and continue use the host as the runtime authority", async (t) => {
  const { store, host, resident } = service(t);
  store.resident.ensureTask({
    taskId: "task-1",
    sessionId: "session-1",
    notify: true,
    lastProcessedTerminalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const listing = resident.list();
  host.respond(host.sent.at(-1)!, { bindings: [binding()] });
  const tasks = (await listing).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].notify, true);

  const detail = resident.detail("task-1");
  host.respond(host.sent.at(-1)!, { bindings: [binding()] });
  assert.deepEqual((await detail).runs, []);

  const update = resident.update("task-1", { enabled: false, visible: false });
  const enabled = host.sent.at(-1)!;
  assert.equal(enabled.action, "setEnabled");
  assert.deepEqual(enabled.payload, { taskId: "task-1", enabled: false });
  host.respond(enabled, { binding: binding({ enabled: false, visible: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  const visible = host.sent.at(-1)!;
  assert.equal(visible.action, "setVisible");
  assert.deepEqual(visible.payload, { taskId: "task-1", visible: false });
  host.respond(visible, { binding: binding({ enabled: false, visible: false }) });
  assert.equal((await update).visible, false);

  const stopped = resident.stop("task-1");
  host.respond(host.sent.at(-1)!, { binding: binding({ status: "stopping", stopCause: "user_stopped" }) });
  assert.equal((await stopped).status, "stopping");

  const resumed = resident.resume("task-1");
  host.respond(host.sent.at(-1)!, {
    result: { accepted: true, executionId: "exec-2", reason: null },
    binding: binding({ executionId: "exec-2" }),
  });
  const continued = await resumed;
  assert.equal(continued.result.accepted, true);
  assert.equal(continued.task.executionId, "exec-2");
});

test("stage logs forward the query to the host and never mix into terminal runs", async (t) => {
  const { store, host, resident } = service(t);
  const page = resident.logs("task-1", { cursor: "opaque-1", limit: 50 });
  const request = host.sent.at(-1)!;
  assert.equal(request.action, "logs");
  assert.deepEqual(request.payload, { taskId: "task-1", cursor: "opaque-1", limit: 50 });
  const entry: StageLogEntry = {
    id: "log-1",
    taskId: "task-1",
    sessionId: "session-1",
    executionId: "exec-1",
    source: "agent",
    occurredAt: "2026-01-01T00:30:00.000Z",
    createdAt: "2026-01-01T00:30:01.000Z",
    content: "部署完成",
    status: "success",
  };
  host.respond(request, { logs: [entry], nextCursor: "opaque-0" });
  const first = await page;
  assert.equal(first.logs.length, 1);
  assert.equal(first.logs[0].content, "部署完成");
  assert.equal(first.nextCursor, "opaque-0");
  // An omitted query sends only the task id, so the host applies its own default page size.
  const defaults = resident.logs("task-1");
  assert.deepEqual(host.sent.at(-1)!.payload, { taskId: "task-1" });
  host.respond(host.sent.at(-1)!, { logs: [], nextCursor: null });
  assert.deepEqual((await defaults).logs, []);
  // Host refusals (unknown task, unavailable transport) surface unchanged.
  const unknown = resident.logs("missing");
  host.fail(host.sent.at(-1)!, "not_found", "宿主没有该常驻任务");
  await assert.rejects(unknown, { code: "not_found" });
  // Stage logs are not run rows: the resident detail history stays empty.
  assert.deepEqual(store.resident.runs("task-1"), []);
});

test("removal stops an active run first, then unbinds, then drops metadata", async (t) => {
  const { store, host, resident } = service(t);
  store.resident.ensureTask({
    taskId: "task-1",
    sessionId: "session-1",
    notify: true,
    lastProcessedTerminalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const removing = resident.remove("task-1");
  const statusRequest = host.sent.at(-1)!;
  assert.equal(statusRequest.action, "status");
  host.respond(statusRequest, { bindings: [binding()] });
  await new Promise((resolve) => setImmediate(resolve));
  const stopRequest = host.sent.at(-1)!;
  assert.equal(stopRequest.action, "stop");
  // A failed stop must leave the task, its metadata and its protection untouched.
  host.fail(stopRequest, "stop_failed", "运行未能停止");
  await assert.rejects(removing, { code: "stop_failed" });
  assert.equal(store.resident.task("task-1")?.taskId, "task-1");
  assert.equal(host.sent.some((message) => message.action === "remove"), false);

  const retry = resident.remove("task-1");
  host.respond(host.sent.at(-1)!, { bindings: [binding()] });
  await new Promise((resolve) => setImmediate(resolve));
  host.respond(host.sent.at(-1)!, { binding: binding({ status: "stopped" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const removeRequest = host.sent.at(-1)!;
  assert.equal(removeRequest.action, "remove");
  host.respond(removeRequest, { removed: true, sessionId: "session-1" });
  assert.deepEqual(await retry, { removed: true, sessionId: "session-1" });
  assert.equal(store.resident.task("task-1"), null);
});

test("a stopped binding is removed without another stop and its metadata is only dropped after unbinding", async (t) => {
  const { store, host, resident } = service(t);
  store.resident.ensureTask({
    taskId: "task-1",
    sessionId: "session-1",
    notify: true,
    lastProcessedTerminalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const removing = resident.remove("task-1");
  host.respond(host.sent.at(-1)!, { bindings: [binding({ status: "stopped" })] });
  await new Promise((resolve) => setImmediate(resolve));
  const removeRequest = host.sent.at(-1)!;
  assert.equal(removeRequest.action, "remove");
  host.fail(removeRequest, "stop_failed", "解绑失败");
  await assert.rejects(removing, { code: "stop_failed" });
  assert.equal(store.resident.task("task-1")?.taskId, "task-1");
});

test("terminals record one resident run, alert once and reconcile missed episodes", async (t) => {
  const { store, host, resident, flushes } = service(t, { telegram: true });
  store.resident.ensureTask({
    taskId: "task-1",
    sessionId: "session-1",
    notify: true,
    lastProcessedTerminalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const remembered = resident.list();
  host.respond(host.sent.at(-1)!, { bindings: [binding()] });
  await remembered;
  host.emit("terminal", terminal());
  await new Promise((resolve) => setImmediate(resolve));
  const runs = store.resident.runs("task-1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].source, "resident");
  assert.equal(runs[0].taskName, "原会话标题");
  assert.equal(runs[0].projectName, "project-name");
  assert.equal(runs[0].id, "terminal-1");
  assert.equal(runs[0].executionId, "exec-1");
  assert.equal(runs[0].alertStatus, "pending");
  assert.equal(flushes(), 1);
  // Pushing the same episode again is ignored entirely.
  host.emit("terminal", terminal());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.resident.runs("task-1").length, 1);
  assert.equal(flushes(), 1);

  // A plugin restart reconciles through `sync`, records the missed terminal and drops no data.
  const restarted = service(t, { telegram: true });
  restarted.store.resident.ensureTask({
    taskId: "task-1",
    sessionId: "session-1",
    notify: true,
    lastProcessedTerminalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  restarted.host.emit("sync", { bindings: [binding({ terminal: terminal() })] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.store.resident.runs("task-1").length, 1);
  assert.equal(restarted.flushes(), 1);
  // A snapshot that lacks a task never deletes plugin metadata; only an explicit removal does.
  const created = restarted.resident.create("session-2");
  const adopt = restarted.host.sent.at(-1)!;
  restarted.host.respond(adopt, { binding: binding({ taskId: "task-new", sessionId: "session-2" }) });
  await created;
  restarted.host.emit("sync", { bindings: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.store.resident.task("task-new")?.taskId, "task-new");
  assert.equal(restarted.store.resident.task("task-1")?.taskId, "task-1");
});

test("silent terminals never queue an alert and not materialised bindings are ignored", async (t) => {
  const { store, host } = service(t, { telegram: true });
  store.resident.ensureTask({
    taskId: "task-1",
    sessionId: "session-1",
    notify: true,
    lastProcessedTerminalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  host.emit("terminal", terminal({ alert: false, cause: "user_stopped", status: "stopped" }));
  await new Promise((resolve) => setImmediate(resolve));
  host.respond(host.sent.at(-1)!, { bindings: [binding({ status: "stopped" })] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.resident.runs("task-1")[0].alertStatus, "none");
  // notify=false on the plugin row suppresses delivery even when the host asks to alert.
  store.resident.deleteTask("task-1");
  store.resident.ensureTask({
    taskId: "task-1",
    sessionId: "session-1",
    notify: false,
    lastProcessedTerminalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  host.emit("terminal", terminal({ id: "terminal-2", alert: true }));
  await new Promise((resolve) => setImmediate(resolve));
  host.respond(host.sent.at(-1)!, { bindings: [binding({ status: "stopped" })] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.resident.runs("task-1")[0].alertStatus, "none");
  // A terminal for an unknown binding is still recorded, but no metadata is invented for it.
  host.emit("terminal", terminal({ id: "terminal-9", taskId: "task-9" }));
  await new Promise((resolve) => setImmediate(resolve));
  // The host answers the binding lookup for a task this plugin never adopted.
  host.fail(host.sent.at(-1)!, "not_found", "任务不存在");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.resident.task("task-9")?.lastProcessedTerminalId, "terminal-9");
});

test("Telegram text distinguishes resident finishes from scheduled failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resident-alert-"));
  const store = new SchedulerStore(path.join(root, "data"));
  store.saveSettings({
    ...defaultSettings(),
    telegram: { enabled: true, botToken: "1:secret", chatId: "1", proxy: "" },
  });
  const messages: string[] = [];
  const notifier = new TelegramNotifier(
    store,
    async (_settings: SchedulerSettings["telegram"], text: string) => {
      messages.push(text);
    },
  );
  const base: SchedulerRun = {
    id: "run-1",
    projectId: "p1",
    projectName: "project",
    taskId: "t1",
    taskName: "title",
    status: "success",
    trigger: "cron",
    scheduledAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    exitCode: 0,
    reason: null,
    workerPid: null,
    alertStatus: "pending",
    alertError: null,
    alertAttempts: 0,
  };
  store.saveRun({ ...base, status: "failed", exitCode: 1, reason: "exit 1" });
  store.saveRun({
    ...base,
    id: "run-2",
    trigger: "resident",
    source: "resident",
    residentTaskId: "t2",
    sessionId: "s1",
    executionId: "e1",
    exitCode: null,
    alertStatus: "pending",
  });
  await notifier.flush();
  notifier.stop();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(messages.length, 2);
  const scheduled = messages.find((message) => message.startsWith("定时任务执行失败"))!;
  assert.match(scheduled, /退出码：1/);
  const resident = messages.find((message) => message.startsWith("常驻任务"))!;
  assert.match(resident, /常驻任务已结束/);
  assert.match(resident, /原因：本轮已正常结束/);
  assert.equal(resident.includes("退出码"), false);
});
