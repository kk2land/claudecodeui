import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectScheduler } from "../server/scheduler.js";
import { SchedulerStore } from "../server/store.js";
import { appendLog, readLog } from "../server/logs.js";
import {
  parseTasks,
  defaultSettings,
  updateSettings,
} from "../server/configuration.js";
import { environmentRowsToMap } from "../shared/contracts.js";
import type { SchedulerRun, SchedulerSettings } from "../shared/contracts.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".cloudcli"), { recursive: true });
  const catalog = path.join(root, "projects.json");
  fs.writeFileSync(
    catalog,
    JSON.stringify({
      generatedAt: Date.now(),
      projects: [{ id: "p1", name: "test-project", path: project }],
    }),
  );
  const store = new SchedulerStore(path.join(root, "data"));
  const scheduler = new ProjectScheduler(store, catalog);
  const config = (tasks: unknown[]) =>
    fs.writeFileSync(
      path.join(project, ".cloudcli", "project-schedules.json"),
      JSON.stringify({ version: 1, tasks }),
    );
  t.after(async () => {
    await scheduler.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, project, catalog, store, scheduler, config };
}
function task(id: string, code = 'console.log("ok")', extra = {}) {
  return {
    id,
    type: "script",
    cron: "0 0 0 1 1 *",
    command: process.execPath,
    args: ["-e", code],
    ...extra,
  };
}
async function waitFor<T>(
  read: () => T,
  valid: (value: T) => boolean,
  timeout = 8000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = read();
    if (valid(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for execution");
}

test("imports are idempotent, atomic per project, and preserve running reservations across reload", async (t) => {
  const f = fixture(t);
  f.config([task("slow", "setTimeout(()=>{},2000)")]);
  assert.equal(f.scheduler.load(undefined, false, true)[0]!.added, 1);
  const first = f.scheduler.start("p1", "slow", "manual");
  f.scheduler.load(undefined, false, true);
  assert.equal(f.store.definitions().length, 1);
  f.config([task("slow", 'console.log("new configuration")')]);
  f.scheduler.load(undefined, false, true);
  assert.equal(
    f.scheduler.snapshot(first.id).task?.args[1],
    "setTimeout(()=>{},2000)",
  );
  assert.equal(
    f.scheduler.start("p1", "slow", "manual").status,
    "skipped_overlap",
  );
  f.config([task("other"), task("bad", "", { cron: "60 * * * * *" })]);
  assert.equal(f.scheduler.load(undefined, true, true)[0]!.status, "invalid");
  assert.equal(f.store.definitions()[0]!.taskId, "slow");
  f.scheduler.stop(first.id);
  const done = await waitFor(
    () => f.store.run(first.id),
    (run) => Boolean(run?.endedAt),
  );
  assert.equal(done?.status, "stopped");
});

test("independent project/task gates permit configured overlap and enforce global capacity", async (t) => {
  const f = fixture(t);
  f.store.saveSettings({ ...f.store.settings(), maxConcurrentRuns: 2 });
  f.config([
    task("parallel", "setTimeout(()=>{},1000)", { allowConcurrent: true }),
  ]);
  f.scheduler.load(undefined, false, true);
  const a = f.scheduler.start("p1", "parallel", "manual");
  const b = f.scheduler.start("p1", "parallel", "manual");
  assert.equal(a.status, "running");
  assert.equal(b.status, "running");
  assert.equal(
    f.scheduler.start("p1", "parallel", "manual").status,
    "skipped_capacity",
  );
  await waitFor(
    () => f.store.unfinished().length,
    (count) => count === 0,
  );
  assert.equal(f.store.run(a.id)?.status, "success");
});

test("stdout/stderr are captured separately and stderr does not imply failure", async (t) => {
  const f = fixture(t);
  f.config([
    task("output", 'console.log("中文输出");console.error("diagnostic")'),
  ]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "output", "manual");
  const done = await waitFor(
    () => f.store.run(run.id),
    (run) => Boolean(run?.endedAt),
  );
  assert.equal(done?.status, "success");
  assert.match(f.scheduler.log(run.id, "stdout", 0).text, /中文输出/);
  assert.match(f.scheduler.log(run.id, "stderr", 0).text, /diagnostic/);
});

test("agent zero exit without a final event records success and no failure alert", async (t) => {
  const f = fixture(t);
  f.store.saveSettings({
    ...f.store.settings(),
    telegram: { enabled: true, botToken: "123:test", chatId: "1", proxy: "" },
  });
  const bin = path.join(f.root, "dsh");
  fs.writeFileSync(
    bin,
    '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"text",text:"answer"})));',
    { mode: 0o700 },
  );
  const previous = process.env.CLOUDCLI_DSH_BIN,
    previousPatches = process.env.CLOUDCLI_DSH_PATCHES;
  process.env.CLOUDCLI_DSH_BIN = bin;
  process.env.CLOUDCLI_DSH_PATCHES = "[]";
  t.after(() => {
    if (previous === undefined) delete process.env.CLOUDCLI_DSH_BIN;
    else process.env.CLOUDCLI_DSH_BIN = previous;
    if (previousPatches === undefined) delete process.env.CLOUDCLI_DSH_PATCHES;
    else process.env.CLOUDCLI_DSH_PATCHES = previousPatches;
  });
  f.config([
    {
      id: "agent",
      type: "prompt",
      cron: "0 0 0 1 1 *",
      prompt: "hello",
      agent: { provider: "dsh", model: "default" },
    },
  ]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "agent", "manual");
  const done = await waitFor(
    () => f.store.run(run.id),
    (run) => Boolean(run?.endedAt),
  );
  assert.equal(done?.status, "success");
  assert.equal(done?.exitCode, 0);
  assert.equal(done?.alertStatus, "none");
  assert.match(f.scheduler.log(run.id, "stdout", 0).text, /answer/);
});

test("timeout kills an execution and records a distinct terminal result", async (t) => {
  const f = fixture(t);
  f.config([task("hang", "setInterval(()=>{},1000)", { timeoutSeconds: 1 })]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "hang", "manual");
  const done = await waitFor(
    () => f.store.run(run.id),
    (run) => Boolean(run?.endedAt),
  );
  assert.equal(done?.status, "timed_out");
  assert.equal(f.store.unfinished().length, 0);
});

test("process groups are stopped, including grandchildren", async (t) => {
  const f = fixture(t);
  const heartbeat = path.join(f.project, "heartbeat");
  const grandchild =
    'const fs=require("fs");setInterval(()=>fs.appendFileSync(' +
    JSON.stringify(heartbeat) +
    ',"x"),50)';
  f.config([
    task(
      "tree",
      'require("child_process").spawn(process.execPath,["-e",' +
        JSON.stringify(grandchild) +
        '],{stdio:"ignore"});setInterval(()=>{},1000)',
    ),
  ]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "tree", "manual");
  await waitFor(
    () => fs.existsSync(heartbeat) && fs.statSync(heartbeat).size,
    (size) => Boolean(size),
  );
  f.scheduler.stop(run.id);
  await waitFor(() => f.store.run(run.id)?.endedAt, Boolean);
  const size = fs.statSync(heartbeat).size;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fs.statSync(heartbeat).size, size);
});

test("automatic scheduling switches preserve JSON, active runs and project isolation; imports reset them", async (t) => {
  const f = fixture(t);
  f.config([task("toggle", "setTimeout(()=>{},5000)")]);
  const configFile = path.join(f.project, ".cloudcli/project-schedules.json");
  const original = fs.readFileSync(configFile, "utf8");
  f.scheduler.load(undefined, false, true);
  const definition = f.store.definitions()[0]!.definition;
  f.store.importProject("p2", [definition], false);
  const running = f.scheduler.start("p1", "toggle", "manual");
  f.scheduler.setTaskEnabled("p1", "toggle", false);
  assert.equal(fs.readFileSync(configFile, "utf8"), original);
  assert.equal(f.scheduler.inventory()[0]!.definition.enabled, false);
  assert.equal(f.scheduler.inventory()[0]!.nextRun, null);
  assert.equal(f.store.run(running.id)?.status, "running");
  assert.equal(f.store.definitions().find((row) => row.projectId === "p2")!.definition.enabled, true);
  assert.throws(() => f.scheduler.start("p1", "toggle", "cron"), /已关闭/);
  f.scheduler.stop(running.id);
  await waitFor(() => f.store.run(running.id)?.endedAt, Boolean);
  const manual = f.scheduler.start("p1", "toggle", "manual");
  assert.equal(manual.status, "running");
  f.scheduler.stop(manual.id);
  await waitFor(() => f.store.run(manual.id)?.endedAt, Boolean);
  f.scheduler.load(["p1"], false, true);
  assert.equal(f.scheduler.inventory()[0]!.definition.enabled, true);
  assert.ok(f.scheduler.inventory()[0]!.nextRun);
  f.config([task("toggle", "", { enabled: false })]);
  f.scheduler.load(["p1"], false, true);
  f.scheduler.setTaskEnabled("p1", "toggle", true);
  assert.equal(f.scheduler.inventory()[0]!.definition.enabled, true);
  f.scheduler.load(["p1"], false, true);
  assert.equal(f.scheduler.inventory()[0]!.definition.enabled, false);
  assert.throws(() => f.scheduler.setTaskEnabled("unknown", "toggle", false), /项目不存在/);
  assert.throws(() => f.scheduler.setTaskEnabled("p1", "unknown", false), /任务不存在/);
});

test("automatic scheduling switches persist across store restarts and preserve other task fields", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cron-toggle-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let store = new SchedulerStore(directory);
  try {
    const definition = parseTasks({ version: 1, tasks: [task("saved")] }, directory, defaultSettings())[0]!;
    store.importProject("p", [definition], false);
    store.setTaskEnabled("p", "saved", false);
    store.close();
    store = new SchedulerStore(directory);
    const row = store.definitions()[0]!;
    assert.deepEqual(row.definition, { ...definition, enabled: false });
    store.setTaskEnabled("p", "saved", true);
    assert.deepEqual(store.definitions()[0]!.definition, definition);
  } finally {
    store.close();
  }
});

test("retention removes completed history but keeps the last result and active records", (t) => {
  const f = fixture(t);
  f.config([task("retained")]);
  f.scheduler.load(undefined, false, true);
  const endedAt = new Date(Date.now() - 40 * 86400000).toISOString();
  const run: SchedulerRun = {
    id: "00000000-0000-4000-8000-000000000001",
    projectId: "p1",
    projectName: "test-project",
    taskId: "retained",
    taskName: "retained",
    status: "failed",
    trigger: "manual",
    scheduledAt: endedAt,
    startedAt: endedAt,
    endedAt,
    exitCode: 1,
    reason: "failed",
    workerPid: null,
    alertStatus: "none",
    alertError: null,
    alertAttempts: 0,
  };
  f.store.saveRun(run);
  const directory = path.join(f.store.directory, "runs", run.id);
  fs.mkdirSync(directory, { recursive: true });
  appendLog(directory, "stdout", Buffer.from("old"));
  assert.deepEqual(f.store.prune(0), []);
  f.scheduler.cleanup();
  assert.equal(f.store.runs("p1", "retained").length, 0);
  assert.equal(f.store.definitions()[0]!.lastRun?.status, "failed");
  assert.equal(f.scheduler.log(run.id, "stdout", 0).expired, true);
});

test("late notification updates cannot replace a more recent result", (t) => {
  const f = fixture(t);
  f.config([task("latest")]);
  f.scheduler.load(undefined, false, true);
  const make = (id: string): SchedulerRun => ({
    id,
    projectId: "p1",
    projectName: "test",
    taskId: "latest",
    taskName: "latest",
    status: "failed",
    trigger: "manual",
    scheduledAt: "2026-01-01",
    startedAt: "2026-01-01",
    endedAt: "2026-01-01",
    exitCode: 1,
    reason: "",
    workerPid: null,
    alertStatus: "pending",
    alertError: null,
    alertAttempts: 0,
  });
  const old = make("old"),
    newer = make("new");
  f.store.saveRun(old);
  f.store.saveRun(newer);
  old.alertStatus = "sent";
  f.store.saveRun(old);
  assert.equal(f.store.definitions()[0]!.lastRun?.id, "new");
});

test("UTF-8 cursors do not split characters and output is capped", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cron-log-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const text = "中文😀".repeat(15000);
  appendLog(directory, "stdout", Buffer.from(text));
  let offset = 0,
    result = "";
  for (;;) {
    const chunk = readLog(directory, "stdout", offset);
    result += chunk.text;
    offset = chunk.offset;
    if (!chunk.hasMore) break;
  }
  assert.equal(result, text);
  appendLog(directory, "stderr", Buffer.alloc(17 * 1024 * 1024, 65));
  assert.equal(
    fs.statSync(path.join(directory, "stderr.log")).size,
    16 * 1024 * 1024,
  );
  assert.equal(readLog(directory, "stderr", 0).truncated, true);
});

test("invalid types, reserved env, and symlink cwd escapes are rejected", (t) => {
  const f = fixture(t);
  const parse = (tasks: unknown[]) =>
    parseTasks({ version: 1, tasks }, f.project, defaultSettings());
  assert.throws(() => parse([task("same"), task("same")]), /重复/);
  assert.throws(
    () => parse([task("a", "", { allowConcurrent: "false" })]),
    /布尔/,
  );
  assert.throws(
    () =>
      parse([task("a", "", { env: { CLOUDCLI_PLUGIN_TOKEN: "override" } })]),
    /env/,
  );
  fs.symlinkSync(f.root, path.join(f.project, "outside"));
  assert.throws(() => parse([task("a", "", { cwd: "outside" })]), /项目内/);
});

test("exclusive data lease prevents a second scheduler and is released on close", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-lease-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SchedulerStore(root);
  assert.throws(() => new SchedulerStore(root), /占用/);
  store.close();
  new SchedulerStore(root).close();
});

test("same task ID in different projects has separate concurrency reservations", async (t) => {
  const f = fixture(t);
  const second = path.join(f.root, "second");
  fs.mkdirSync(path.join(second, ".cloudcli"), { recursive: true });
  const entry = task("same", "setTimeout(()=>{},200)");
  f.config([entry]);
  fs.writeFileSync(
    path.join(second, ".cloudcli/project-schedules.json"),
    JSON.stringify({ version: 1, tasks: [entry] }),
  );
  fs.writeFileSync(
    f.catalog,
    JSON.stringify({
      generatedAt: Date.now(),
      projects: [
        { id: "p1", name: "first", path: f.project },
        { id: "p2", name: "second", path: second },
      ],
    }),
  );
  f.scheduler.load(undefined, false, true);
  const a = f.scheduler.start("p1", "same", "manual"),
    b = f.scheduler.start("p2", "same", "manual");
  assert.equal(a.status, "running");
  assert.equal(b.status, "running");
  assert.equal(
    f.scheduler.start("p1", "same", "manual").status,
    "skipped_overlap",
  );
  await waitFor(
    () => f.store.unfinished().length,
    (count) => count === 0,
  );
});

test("log deletion failures leave history available for the next cleanup attempt", (t) => {
  const f = fixture(t),
    endedAt = "2000-01-01T00:00:00.000Z";
  const run: SchedulerRun = {
    id: "retry-cleanup",
    projectId: "p",
    projectName: "project",
    taskId: "t",
    taskName: "task",
    status: "success",
    trigger: "manual",
    scheduledAt: endedAt,
    startedAt: endedAt,
    endedAt,
    exitCode: 0,
    reason: null,
    workerPid: null,
    alertStatus: "none",
    alertError: null,
    alertAttempts: 0,
  };
  f.store.saveRun(run);
  assert.throws(
    () =>
      f.store.prune(1, Date.now(), () => {
        throw new Error("disk unavailable");
      }),
    /disk unavailable/,
  );
  assert.equal(f.store.runs().length, 1);
  assert.equal(f.store.prune(1).length, 1);
});


for (const action of ["stop", "timeout", "close"] as const) {
  test(`${action} kills a TERM-resistant descendant before releasing the run`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const f = fixture(t);
    const heartbeat = path.join(f.project, "resistant-heartbeat");
    const pidFile = path.join(f.project, "resistant-pid");
    const descendant = `const fs = require("fs");
      process.on("SIGTERM", () => {});
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, "x"), 25);`;
    let descendantPid: number | undefined;
    t.after(() => {
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
    });
    f.config([task("resistant", `require("child_process").spawn(process.execPath,
      ["-e", ${JSON.stringify(descendant)}], {stdio: "ignore"});
      setInterval(() => {}, 1000);`, { timeoutSeconds: action === "timeout" ? 2 : 0 })]);
    f.scheduler.load(undefined, false, true);
    const run = f.scheduler.start("p1", "resistant", "manual");
    await waitFor(() => fs.existsSync(heartbeat), Boolean);
    descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
    let closing: Promise<void> | undefined;
    if (action === "stop") f.scheduler.stop(run.id);
    else if (action === "close") closing = f.scheduler.close();
    else await waitFor(() => Date.now() - Date.parse(run.startedAt) >= 2100, Boolean);
    // The direct parent is gone, but its TERM-resistant child still holds the reservation.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(f.store.run(run.id)?.status, "running");
    if (action !== "close")
      assert.equal(f.scheduler.start("p1", "resistant", "manual").status, "skipped_overlap");
    await waitFor(() => f.store.run(run.id)?.endedAt, Boolean);
    await closing;
    assert.equal(f.store.run(run.id)?.status, action === "timeout" ? "timed_out" : "stopped");
    const size = fs.statSync(heartbeat).size;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fs.statSync(heartbeat).size, size);
  });
}

test("interrupted alerts honor the original run snapshot during recovery and maintenance", (t) => {
  const f = fixture(t);
  f.store.saveSettings({ ...f.store.settings(), telegram: {
    enabled: true, botToken: "123:test", chatId: "1", proxy: "",
  } });
  f.config([task("changed", "")]);
  f.scheduler.load(undefined, false, true);
  const definition = f.store.definitions()[0]!.definition;
  f.store.importProject("p1", [definition, {
    ...definition, id: "disabled", notify: false,
  }], true);
  // Current definitions contradict snapshots, or are absent entirely.
  for (const [index, entry] of [
    { notify: false, taskId: "changed" },
    { notify: true, taskId: "deleted" },
    { notify: true, taskId: "disabled" },
    { notify: undefined, taskId: "missing" },
    { notify: "corrupt", taskId: "broken" },
  ].entries()) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const run: SchedulerRun = {
      id, projectId: "p1", projectName: "test", taskId: entry.taskId,
      taskName: entry.taskId, status: "running", trigger: "manual",
      scheduledAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      endedAt: null, exitCode: null, reason: null, workerPid: index % 2 ? process.pid : null,
      alertStatus: "none", alertError: null, alertAttempts: 0,
    };
    f.store.saveRun(run);
    const directory = path.join(f.store.directory, "runs", id);
    fs.mkdirSync(directory, { recursive: true });
    if (entry.notify !== undefined)
      fs.writeFileSync(path.join(directory, "task.json"), entry.notify === "corrupt"
        ? "invalid json" : JSON.stringify({ ...definition, notify: entry.notify }));
  }
  f.scheduler.recover();
  // Simulate recovered workers exiting without spawning unrelated real processes.
  const kill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid === process.pid && signal === 0)
      throw Object.assign(new Error("worker exited"), { code: "ESRCH" });
    return kill(pid, signal);
  });
  f.scheduler.maintenance();
  const runs = f.store.runs();
  assert.equal(runs.length, 5);
  for (const run of runs) {
    assert.equal(run.status, "interrupted");
    assert.equal(run.alertStatus, ["deleted", "disabled"].includes(run.taskId) ? "pending" : "none");
  }
});

test("historical settings without env read back as an empty map and saveSettings keeps it", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cron-env-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SchedulerStore(directory);
  try {
    // Simulate a row written before the execution environment existed.
    const legacy = { ...defaultSettings() } as Partial<SchedulerSettings>;
    delete legacy.env;
    store.saveSettings(legacy as SchedulerSettings);
    assert.deepEqual(store.settings().env, {});
    const saved = store.settings();
    store.saveSettings({ ...saved, env: { SHARED: "one" } });
    assert.deepEqual(store.settings().env, { SHARED: "one" });
  } finally {
    store.close();
  }
});

test("settings env validation rejects arrays, non-strings, NUL, reserved names and duplicate editor rows", () => {
  const previous = { ...defaultSettings(), env: { KEEP: "old" } };
  for (const env of [
    [],
    { OK: 1 },
    { OK: null },
    { OK: "a\0b" },
    { "1BAD": "x" },
    { "BAD-NAME": "x" },
    { AGENT_EXEC: "x" },
    { CLOUDCLI_HOST_ROOT: "x" },
    { CLOUDCLI_PROJECTS_FILE: "x" },
    { CLOUDCLI_PLUGIN_TOKEN: "x" },
    { CLOUDCLI_SCHEDULER_AGENT: "x" },
    { cloudcli_plugin_token: "x" },
    { Cloudcli_Host_Root: "x" },
  ])
    assert.throws(() => updateSettings({ env }, previous), /env|设置/);
  // A rejected value must not leak into the error message.
  assert.throws(
    () => updateSettings({ env: { SECRET: 42 } }, previous),
    (error: Error) => !error.message.includes("42"),
  );
  assert.deepEqual(
    environmentRowsToMap([
      { name: "A", value: "1" },
      { name: "A", value: "2" },
    ]).error,
    "变量名 “A” 重复，请先修改或删除",
  );
  assert.match(
    environmentRowsToMap([{ name: "A", value: "1" }, { name: "BAD-NAME", value: "2" }])
      .error ?? "",
    /不合法/,
  );
  assert.match(
    environmentRowsToMap([{ name: "CLOUDCLI_PLUGIN_TOKEN", value: "2" }]).error ?? "",
    /保留/,
  );
  // A row added but left completely blank is ignored rather than blocking a save.
  assert.deepEqual(
    environmentRowsToMap([
      { name: "", value: "" },
      { name: "OK", value: "1" },
    ]).env,
    { OK: "1" },
  );
  // A value without a name is still an error.
  assert.match(
    environmentRowsToMap([{ name: "", value: "orphan" }]).error ?? "",
    /变量名不能为空/,
  );
  // Values may be multi-line; they are preserved verbatim.
  assert.deepEqual(
    environmentRowsToMap([{ name: "MULTI", value: "line1\nline2" }]).env,
    { MULTI: "line1\nline2" },
  );
});

test("settings env is preserved when omitted and cleared by an empty object", () => {
  const previous = { ...defaultSettings(), env: { DB: "postgres://local" } };
  assert.deepEqual(updateSettings({}, previous).env, { DB: "postgres://local" });
  assert.deepEqual(updateSettings({ env: {} }, previous).env, {});
  assert.deepEqual(updateSettings({ env: { A: "b" } }, previous).env, { A: "b" });
  // Valid names must not collide with Object.prototype or disappear during conversion.
  const special = Object.fromEntries([["__proto__", "literal"], ["constructor", "value"]]);
  assert.deepEqual(updateSettings({ env: special }, previous).env, special);
  assert.deepEqual(environmentRowsToMap(
    Object.entries(special).map(([name, value]) => ({ name, value })),
  ).env, special);
});

test("global env reaches scripts and prompts, task env wins, and saves apply without reload", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-env-run-"));
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".cloudcli"), { recursive: true });
  const catalog = path.join(root, "projects.json");
  fs.writeFileSync(
    catalog,
    JSON.stringify({
      generatedAt: Date.now(),
      projects: [{ id: "p", name: "project", path: project }],
    }),
  );
  // Fake Codex binary so AGENT_EXEC and the prompt task print the inherited environment.
  const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
  const suffix =
    process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
  const pkg = path.join(
    root,
    "node_modules",
    "@openai",
    "codex-" + process.platform + "-" + process.arch,
  );
  const binary = path.join(pkg, "vendor", cpu + "-" + suffix, "bin", "codex");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  fs.writeFileSync(
    binary,
    '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"item.completed",item:{id:"a",type:"agent_message",text:"agent:"+process.env.GLOBAL_ONLY+"/"+process.env.BOTH}})));',
    { mode: 0o700 },
  );
  const dsh = path.join(root, "dsh");
  fs.writeFileSync(
    dsh,
    '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"final",text:"dsh:"+process.env.GLOBAL_ONLY+"/"+process.env.BOTH,reason:{kind:"completed"}})));',
    { mode: 0o700 },
  );
  const script =
    'console.log("script:"+process.env.GLOBAL_ONLY+"/"+process.env.BOTH);' +
    'const r=require("child_process").spawnSync(process.env.AGENT_EXEC,["hi"],{encoding:"utf8"});' +
    'process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");' +
    "process.exit(r.status??1)";
  const configFile = path.join(project, ".cloudcli/project-schedules.json");
  const config = JSON.stringify({
    version: 1,
    tasks: [
      {
        id: "script",
        type: "script",
        cron: "0 0 0 1 1 *",
        command: process.execPath,
        args: ["-e", script],
        env: { BOTH: "task" },
      },
      {
        id: "prompt",
        type: "prompt",
        cron: "0 0 0 1 1 *",
        prompt: "run",
        agent: { provider: "dsh", model: "default" },
        env: { BOTH: "task-prompt" },
      },
    ],
  });
  fs.writeFileSync(configFile, config);
  const originalConfig = fs.readFileSync(configFile, "utf8");
  const previousRoot = process.env.CLOUDCLI_HOST_ROOT;
  const previousDsh = process.env.CLOUDCLI_DSH_BIN;
  const previousToken = process.env.CLOUDCLI_PLUGIN_TOKEN;
  process.env.CLOUDCLI_HOST_ROOT = root;
  process.env.CLOUDCLI_DSH_BIN = dsh;
  process.env.CLOUDCLI_PLUGIN_TOKEN = "host-token";
  const store = new SchedulerStore(path.join(root, "data"));
  const scheduler = new ProjectScheduler(store, catalog);
  t.after(async () => {
    await scheduler.close();
    store.close();
    if (previousRoot === undefined) delete process.env.CLOUDCLI_HOST_ROOT;
    else process.env.CLOUDCLI_HOST_ROOT = previousRoot;
    if (previousDsh === undefined) delete process.env.CLOUDCLI_DSH_BIN;
    else process.env.CLOUDCLI_DSH_BIN = previousDsh;
    if (previousToken === undefined) delete process.env.CLOUDCLI_PLUGIN_TOKEN;
    else process.env.CLOUDCLI_PLUGIN_TOKEN = previousToken;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const wait = (id: string) =>
    waitFor(() => store.run(id), (run) => Boolean(run?.endedAt));
  store.saveSettings({
    ...store.settings(),
    env: { GLOBAL_ONLY: "global-1", BOTH: "global" },
  });
  scheduler.load(undefined, false, true);
  const scriptRun = scheduler.start("p", "script", "manual");
  await wait(scriptRun.id);
  // Script, its AGENT_EXEC child, and the prompt all see the global value; task.env wins for BOTH.
  assert.match(
    scheduler.log(scriptRun.id, "stdout", 0).text,
    /script:global-1\/task[\s\S]*agent:global-1\/task/,
  );
  // DSH prompt tasks receive the same global variables, and their task env wins.
  const promptRun = scheduler.start("p", "prompt", "manual");
  await wait(promptRun.id);
  assert.match(
    scheduler.log(promptRun.id, "stdout", 0).text,
    /dsh:global-1\/task-prompt/,
  );
  // No reload: the next run reads the newly saved settings.
  store.saveSettings({
    ...store.settings(),
    env: { GLOBAL_ONLY: "global-2", BOTH: "global" },
  });
  const next = scheduler.start("p", "prompt", "manual");
  await wait(next.id);
  assert.match(
    scheduler.log(next.id, "stdout", 0).text,
    /dsh:global-2\/task-prompt/,
  );
  // The token stays stripped and neither project JSON nor run snapshots carry the global env.
  assert.equal(fs.readFileSync(configFile, "utf8"), originalConfig);
  for (const id of [scriptRun.id, promptRun.id, next.id]) {
    const snapshot = scheduler.snapshot(id).task!;
    assert.equal(snapshot.env.GLOBAL_ONLY, undefined);
  }
  // Stored definitions and snapshots keep only task-level env.
  assert.deepEqual(
    Object.fromEntries(
      store.definitions().map((row) => [row.taskId, row.definition.env]),
    ),
    { prompt: { BOTH: "task-prompt" }, script: { BOTH: "task" } },
  );
});
