import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectScheduler } from "../server/scheduler.js";
import { SchedulerStore } from "../server/store.js";
import { appendLog, readLog } from "../server/logs.js";
import { parseTasks, defaultSettings } from "../server/configuration.js";
import type { SchedulerRun } from "../shared/contracts.js";

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
      path.join(project, ".cloudcli", "schedules.json"),
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
    path.join(second, ".cloudcli/schedules.json"),
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
