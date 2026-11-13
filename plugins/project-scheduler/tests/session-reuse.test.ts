import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectScheduler } from "../server/scheduler.js";
import { SchedulerStore } from "../server/store.js";
import { defaultSettings, parseTasks } from "../server/configuration.js";
import { fakeScheduledHost } from "./host-fixture.js";

// A fake DSH headless CLI: it records its argv, reports a verified session, then finishes or
// stays alive so tests can observe stop/close ordering.
const dshScript = `const fs=require("fs");
fs.appendFileSync("dsh-calls.jsonl",JSON.stringify({args:process.argv.slice(2)})+"\\n");
fs.writeFileSync("agent-spawned.txt","");
fs.readFileSync(0,"utf8");
console.log(JSON.stringify({type:"session",sessionId:process.env.FAKE_NATIVE_SESSION||"native-a"}));
if(process.env.FAKE_AGENT_HANG==="1"){setInterval(()=>{},1000);}
else{
console.log(JSON.stringify({type:"status",phase:"turn_end",reason:{kind:"completed"}}));
console.log(JSON.stringify({type:"final",text:JSON.stringify({status:"success",summary:"ok"})}));
}`;


/** Fake Codex exec under the host dependency layout the scheduler resolves. */
function fakeCodex(root: string): void {
  const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
  const suffix =
    process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
  const pkg = path.join(
    root,
    "node_modules",
    "@openai",
    "codex-" + process.platform + "-" + process.arch,
  );
  const bin = path.join(pkg, "vendor", cpu + "-" + suffix, "bin", "codex");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  fs.writeFileSync(
    bin,
    "#!/usr/bin/env node\n" +
      [
        'const fs=require("fs");',
        'fs.appendFileSync("codex-calls.jsonl",JSON.stringify({args:process.argv.slice(2)})+"\\n");',
        'fs.readFileSync(0,"utf8");',
        'console.log(JSON.stringify({type:"thread.started",thread_id:"thread-native"}));',
        'console.log(JSON.stringify({type:"item.completed",item:{id:"a",type:"agent_message",text:JSON.stringify({status:"success",summary:"ok"})}}));',
        'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:4,output_tokens:2,cached_input_tokens:1}}));',
      ].join(""),
    { mode: 0o700 },
  );
}

function fixture(
  t: TestContext,
  options: {
    host?: boolean;
    projects?: { id: string; name: string }[];
    onFinished?: () => void;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-session-"));
  const projects = options.projects ?? [{ id: "p1", name: "one" }];
  const entries = projects.map((project) => {
    const directory = path.join(root, project.id);
    fs.mkdirSync(path.join(directory, ".cloudcli"), { recursive: true });
    return { ...project, directory };
  });
  const catalog = path.join(root, "projects.json");
  fs.writeFileSync(
    catalog,
    JSON.stringify({
      generatedAt: Date.now(),
      projects: entries.map(({ directory, ...project }) => ({
        ...project,
        path: directory,
      })),
    }),
  );
  const dsh = path.join(root, "dsh");
  fs.writeFileSync(dsh, "#!/usr/bin/env node\n" + dshScript, { mode: 0o700 });
  const store = new SchedulerStore(path.join(root, "data"));
  const fake = fakeScheduledHost();
  const scheduler = new ProjectScheduler(
    store,
    catalog,
    options.onFinished ?? (() => {}),
    options.host === false ? undefined : fake.host,
  );
  const changes: Record<string, string | undefined> = {
    CLOUDCLI_DSH_BIN: dsh,
    CLOUDCLI_DSH_PATCHES: "[]",
    FAKE_AGENT_HANG: undefined,
    FAKE_NATIVE_SESSION: undefined,
  };
  const before = Object.fromEntries(
    Object.keys(changes).map((key) => [key, process.env[key]]),
  );
  process.env.CLOUDCLI_DSH_BIN = dsh;
  process.env.CLOUDCLI_DSH_PATCHES = "[]";
  delete process.env.FAKE_AGENT_HANG;
  delete process.env.FAKE_NATIVE_SESSION;
  t.after(async () => {
    await scheduler.close();
    store.close();
    for (const [key, value] of Object.entries(before))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = (projectId: string, tasks: unknown[]) =>
    fs.writeFileSync(
      path.join(root, projectId, ".cloudcli", "project-schedules.json"),
      JSON.stringify({ version: 1, tasks }),
    );
  return {
    root,
    entries,
    directory: entries[0]!.directory,
    catalog,
    store,
    scheduler,
    fake,
    config,
  };
}
function promptTask(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "prompt",
    cron: "0 0 0 1 1 *",
    prompt: "run",
    agent: { provider: "dsh", model: "default" },
    ...extra,
  };
}
function scriptTask(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "script",
    cron: "0 0 0 1 1 *",
    command: process.execPath,
    args: ["-e", 'console.log("script ok")'],
    ...extra,
  };
}
function dshCalls(directory: string): string[][] {
  const file = path.join(directory, "dsh-calls.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { args: string[] }).args);
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for state");
}
/** Waits for a terminal run row; a timeout is a real failure, never a nullable result. */
async function finished(
  f: ReturnType<typeof fixture>,
  runId: string,
): Promise<NonNullable<ReturnType<typeof f.store.run>>> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const run = f.store.run(runId);
    if (run?.endedAt) {
      await f.scheduler.whenIdle();
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run did not finish within 8s: " + runId);
}

test("a prompt task prepares a fresh app session for every run when reuseSession is off", async (t) => {
  const f = fixture(t);
  f.config("p1", [promptTask("agent")]);
  f.scheduler.load(undefined, false, true);
  const first = await finished(f, f.scheduler.start("p1", "agent", "manual").id);
  const second = await finished(f, f.scheduler.start("p1", "agent", "manual").id);
  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  const prepares = f.fake.requests("scheduledPrepare");
  assert.equal(prepares.length, 2);
  assert.equal(prepares[0]!.reuseSession, false);
  assert.equal(prepares[1]!.reuseSession, false);
  assert.notEqual(first.sessionId, second.sessionId);
  // Neither run resumed a native session, and the app session was recorded on the run row.
  for (const args of dshCalls(f.directory))
    assert.equal(args.includes("--session-id"), false);
  const actions = f.fake.calls
    .map((call) => call.action)
    .filter((action) => action !== "scheduledSyncTasks");
  assert.deepEqual(actions, [
    "scheduledPrepare",
    "scheduledAttachNative",
    "scheduledFinishRun",
    "scheduledPrepare",
    "scheduledAttachNative",
    "scheduledFinishRun",
  ]);
  assert.equal(f.fake.requests("scheduledAttachNative")[0]!.nativeSessionId, "native-a");
});

test("reuseSession continues the same app and native session", async (t) => {
  const f = fixture(t);
  f.config("p1", [promptTask("agent", { reuseSession: true })]);
  f.scheduler.load(undefined, false, true);
  const first = await finished(f, f.scheduler.start("p1", "agent", "manual").id);
  const second = await finished(f, f.scheduler.start("p1", "agent", "manual").id);
  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.equal(first.sessionId, second.sessionId);
  const prepares = f.fake.requests("scheduledPrepare");
  assert.equal(prepares[0]!.reuseSession, true);
  assert.equal(prepares[1]!.reuseSession, true);
  const args = dshCalls(f.directory);
  assert.equal(args[0]!.includes("--session-id"), false);
  const index = args[1]!.indexOf("--session-id");
  assert.ok(index >= 0);
  assert.equal(args[1]![index + 1], "native-a");
});

test("the same task id in two projects keeps separate sessions", async (t) => {
  const f = fixture(t, {
    projects: [
      { id: "p1", name: "one" },
      { id: "p2", name: "two" },
    ],
  });
  f.config("p1", [promptTask("agent", { reuseSession: true })]);
  f.config("p2", [promptTask("agent", { reuseSession: true })]);
  f.scheduler.load(undefined, false, true);
  const first = await finished(f, f.scheduler.start("p1", "agent", "manual").id);
  const second = await finished(f, f.scheduler.start("p2", "agent", "manual").id);
  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.notEqual(first.sessionId, second.sessionId);
  const prepares = f.fake.requests("scheduledPrepare");
  assert.deepEqual(
    prepares.map((payload) => payload.projectId),
    ["p1", "p2"],
  );
  // p2 has its own binding, so it starts a new native session instead of resuming p1's.
  const args = dshCalls(f.entries[1]!.directory);
  assert.equal(args[0]!.includes("--session-id"), false);
});

test("reuseSession is a prompt-only, non-concurrent boolean at the parse boundary", (t) => {
  const f = fixture(t);
  const parse = (tasks: unknown[]) =>
    parseTasks({ version: 1, tasks }, f.directory, defaultSettings());
  const plain = parse([promptTask("plain")])[0]!;
  assert.equal("reuseSession" in plain, false);
  assert.equal(parse([promptTask("reused", { reuseSession: true })])[0]!.reuseSession, true);
  assert.throws(
    () => parse([scriptTask("script", { reuseSession: true })]),
    /reuseSession 仅适用于 prompt 任务/,
  );
  assert.throws(
    () =>
      parse([
        promptTask("overlap", { reuseSession: true, allowConcurrent: true }),
      ]),
    /reuseSession 不能与 allowConcurrent 同时开启/,
  );
  assert.throws(
    () => parse([promptTask("typed", { reuseSession: "yes" })]),
    /reuseSession 必须是布尔值/,
  );
});

test("prepare gets the effective env's sessions root without touching the global env", async (t) => {
  const f = fixture(t);
  const home = path.join(f.root, "home");
  const dshHome = path.join(f.root, "dsh-home");
  f.store.saveSettings({
    ...f.store.settings(),
    env: { HOME: home, DSH_HOME: dshHome },
  });
  f.config("p1", [promptTask("agent")]);
  f.scheduler.load(undefined, false, true);
  await finished(f, f.scheduler.start("p1", "agent", "manual").id);
  assert.equal(
    f.fake.requests("scheduledPrepare")[0]!.sessionsRoot,
    path.join(dshHome, "sessions"),
  );

  // task.env wins over settings.env, and a relative native root resolves against the task cwd.
  const globalHome = process.env.HOME;
  const globalOverride = process.env.CLOUDCLI_DSH_SESSIONS_DIR;
  f.config("p1", [
    promptTask("agent", { env: { CLOUDCLI_DSH_SESSIONS_DIR: "session-root" } }),
  ]);
  f.scheduler.load(undefined, false, true);
  await finished(f, f.scheduler.start("p1", "agent", "manual").id);
  assert.equal(
    f.fake.requests("scheduledPrepare")[1]!.sessionsRoot,
    path.join(f.directory, "session-root"),
  );
  assert.equal(process.env.HOME, globalHome);
  assert.equal(process.env.CLOUDCLI_DSH_SESSIONS_DIR, globalOverride);
});

test("stop while waiting for prepare never spawns and releases the host slot", async (t) => {
  const f = fixture(t);
  f.fake.hooks.scheduledPrepare = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return {
      sessionId: "session-slow",
      executionId: "execution-slow",
      nativeSessionId: null,
    };
  };
  f.config("p1", [promptTask("agent")]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "agent", "manual");
  await waitFor(
    () => f.fake.requests("scheduledPrepare").length,
    (count) => count > 0,
  );
  f.scheduler.stop(run.id);
  const done = await finished(f, run.id);
  assert.equal(done.status, "stopped");
  assert.equal(done.sessionId, "session-slow");
  assert.equal(fs.existsSync(path.join(f.directory, "agent-spawned.txt")), false);
  assert.deepEqual(dshCalls(f.directory), []);
  assert.equal(f.fake.finished.has(run.id), true);
  assert.equal(f.fake.requests("scheduledFinishRun")[0]!.outcome.aborted, true);
});

test("an aborted pre-spawn cleanup is never mistaken for an interrupted run", async (t) => {
  let finishedCalls = 0;
  const f = fixture(t, { onFinished: () => finishedCalls++ });
  f.store.saveSettings({
    ...f.store.settings(),
    telegram: { ...f.store.settings().telegram, enabled: true },
  });
  let releasePrepare!: () => void;
  const pendingFinishes: (() => void)[] = [];
  f.fake.hooks.scheduledPrepare = () =>
    new Promise((resolve) => {
      releasePrepare = () =>
        resolve({
          sessionId: "session-deferred",
          executionId: "execution-deferred",
          nativeSessionId: null,
        });
    });
  f.fake.hooks.scheduledFinishRun = () =>
    new Promise((resolve) => {
      pendingFinishes.push(() => resolve({ finished: true }));
    });
  // Enabled notifications make a false interruption observable as a pending alert.
  f.config("p1", [promptTask("agent", { notify: true })]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "agent", "manual");
  await waitFor(
    () => f.fake.requests("scheduledPrepare").length,
    (count) => count > 0,
  );
  f.scheduler.stop(run.id);
  releasePrepare();
  // The abort is now waiting for the host finish while the live cleanup promise still owns it.
  await waitFor(
    () => f.fake.requests("scheduledFinishRun").length,
    (count) => count > 0,
  );
  await waitFor(
    () => pendingFinishes.length,
    (count) => count > 0,
  );
  assert.equal(f.store.run(run.id)?.status, "running");
  f.scheduler.maintenance();
  const waiting = f.store.run(run.id);
  try {
    assert.equal(waiting?.status, "running");
    assert.equal(waiting?.endedAt, null);
    assert.equal(waiting?.alertStatus, "none");
    assert.equal(finishedCalls, 0);
    assert.equal(f.fake.requests("scheduledFinishRun").length, 1);
  } finally {
    // Always release the deferred host finish so a regression fails fast instead of hanging.
    for (const release of pendingFinishes) release();
  }
  const done = await finished(f, run.id);
  assert.equal(done.status, "stopped");
  assert.equal(done.alertStatus, "none");
  assert.equal(finishedCalls, 1);
  const finishes = f.fake.requests("scheduledFinishRun");
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0]!.outcome.aborted, true);
  assert.equal(fs.existsSync(path.join(f.directory, "agent-spawned.txt")), false);
  assert.deepEqual(dshCalls(f.directory), []);
});

test("timeout while waiting for prepare never spawns and releases the host slot", async (t) => {
  const f = fixture(t);
  f.fake.hooks.scheduledPrepare = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return {
      sessionId: "session-late",
      executionId: "execution-late",
      nativeSessionId: null,
    };
  };
  f.config("p1", [promptTask("agent", { timeoutSeconds: 1 })]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "agent", "manual");
  const done = await finished(f, run.id);
  assert.equal(done.status, "timed_out");
  assert.equal(fs.existsSync(path.join(f.directory, "agent-spawned.txt")), false);
  assert.deepEqual(dshCalls(f.directory), []);
  assert.equal(f.fake.requests("scheduledFinishRun")[0]!.outcome.aborted, true);
});

test("an attach failure stops the run and is reported as a failure", async (t) => {
  const f = fixture(t);
  process.env.FAKE_AGENT_HANG = "1";
  f.fake.hooks.scheduledAttachNative = () => {
    throw new Error("会话关联不可用");
  };
  f.config("p1", [promptTask("agent")]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "agent", "manual");
  const done = await finished(f, run.id);
  assert.equal(done.status, "failed");
  assert.match(done.reason ?? "", /宿主会话关联失败：会话关联不可用/);
  // The CLI did start, but an unattached session is never reported as success.
  assert.equal(fs.existsSync(path.join(f.directory, "agent-spawned.txt")), true);
  const finish = f.fake.requests("scheduledFinishRun")[0]!;
  assert.equal(finish.outcome.success, false);
  assert.match(finish.outcome.reason, /宿主会话关联失败/);
});

test("a finish failure is reported instead of silently keeping a host slot", async (t) => {
  const f = fixture(t);
  f.fake.hooks.scheduledFinishRun = () => {
    throw new Error("释放失败");
  };
  f.config("p1", [promptTask("agent")]);
  f.scheduler.load(undefined, false, true);
  const done = await finished(f, f.scheduler.start("p1", "agent", "manual").id);
  assert.equal(done.status, "failed");
  assert.match(done.reason ?? "", /宿主会话收尾失败：释放失败/);
  assert.deepEqual(done.taskResult, { status: "success", summary: "ok" });
});

test("close stops the CLI before the host run is finished", async (t) => {
  const f = fixture(t);
  process.env.FAKE_AGENT_HANG = "1";
  f.config("p1", [promptTask("agent")]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "agent", "manual");
  await waitFor(
    () => f.fake.requests("scheduledAttachNative").length,
    (count) => count > 0,
  );
  await f.scheduler.close();
  const actions = f.fake.calls
    .map((call) => call.action)
    .filter((action) => action !== "scheduledSyncTasks");
  assert.deepEqual(actions, [
    "scheduledPrepare",
    "scheduledAttachNative",
    "scheduledFinishRun",
  ]);
  const finish = f.fake.requests("scheduledFinishRun")[0]!;
  assert.equal(finish.outcome.aborted, true);
  assert.equal(f.store.run(run.id)?.status, "stopped");
});

test("recovery releases an interrupted run only after its worker is confirmed gone", async (t) => {
  const f = fixture(t);
  f.store.saveRun({
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "p1",
    projectName: "one",
    taskId: "agent",
    taskName: "agent",
    status: "running",
    trigger: "manual",
    scheduledAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    reason: null,
    workerPid: null,
    alertStatus: "none",
    alertError: null,
    alertAttempts: 0,
    sessionId: "session-old",
    executionId: "execution-old",
  });
  f.scheduler.recover();
  await f.scheduler.whenIdle();
  const finishes = f.fake.requests("scheduledFinishRun");
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0]!.executionId, "execution-old");
  assert.equal(finishes[0]!.outcome.aborted, true);
  assert.equal(
    f.store.run("11111111-1111-4111-8111-111111111111")?.status,
    "interrupted",
  );
  // A second recovery has nothing running: it never releases the slot twice.
  f.scheduler.recover();
  await f.scheduler.whenIdle();
  assert.equal(f.fake.requests("scheduledFinishRun").length, 1);
});

test("task sync follows the committed set and never treats edits or invalid files as removals", async (t) => {
  const f = fixture(t);
  const configFile = path.join(
    f.directory,
    ".cloudcli",
    "project-schedules.json",
  );
  f.config("p1", [promptTask("agent"), promptTask("disabled", { enabled: false })]);
  f.scheduler.load(undefined, false, true);
  await f.scheduler.whenIdle();
  const latest = () => f.fake.requests("scheduledSyncTasks").at(-1)!;
  assert.deepEqual([...latest().taskIds].sort(), ["agent", "disabled"]);

  // Removing a task from the file without removeMissing keeps it committed and protected.
  f.config("p1", [promptTask("agent")]);
  f.scheduler.load(undefined, false, true);
  await f.scheduler.whenIdle();
  assert.deepEqual([...latest().taskIds].sort(), ["agent", "disabled"]);

  // An invalid file releases nothing.
  const before = f.fake.requests("scheduledSyncTasks").length;
  fs.writeFileSync(configFile, "{ not json");
  assert.equal(f.scheduler.load(undefined, false, true)[0]!.status, "invalid");
  await f.scheduler.whenIdle();
  assert.equal(f.fake.requests("scheduledSyncTasks").length, before);

  // A saved revision is the committed set: the removed task may release its binding.
  fs.writeFileSync(
    configFile,
    JSON.stringify({ version: 1, tasks: [promptTask("agent"), promptTask("removed")] }),
  );
  f.scheduler.load(undefined, false, true);
  await f.scheduler.whenIdle();
  const revision = f.scheduler.readConfiguration("p1")!.revision;
  const saved = f.scheduler.saveConfiguration(
    "p1",
    JSON.stringify({ version: 1, tasks: [promptTask("agent")] }),
    revision,
  );
  await f.scheduler.whenIdle();
  assert.equal(saved?.loaded, true);
  assert.deepEqual(latest().taskIds, ["agent"]);
});

test("without a host, prompt runs fail explicitly while scripts keep working", async (t) => {
  const f = fixture(t, { host: false });
  f.config("p1", [promptTask("agent"), scriptTask("shell")]);
  f.scheduler.load(undefined, false, true);
  const prompt = await finished(f, f.scheduler.start("p1", "agent", "manual").id);
  assert.equal(prompt.status, "failed");
  assert.match(prompt.reason ?? "", /宿主常驻任务通道不可用/);
  assert.equal(prompt.sessionId, undefined);
  const script = await finished(f, f.scheduler.start("p1", "shell", "manual").id);
  assert.equal(script.status, "success");
});

test("a prepare failure is explicit and never spawns an agent process", async (t) => {
  const f = fixture(t);
  f.fake.hooks.scheduledPrepare = () => {
    throw new Error("宿主忙碌");
  };
  f.config("p1", [promptTask("agent")]);
  f.scheduler.load(undefined, false, true);
  const done = await finished(f, f.scheduler.start("p1", "agent", "manual").id);
  assert.equal(done.status, "failed");
  assert.match(done.reason ?? "", /宿主会话准备失败：宿主忙碌/);
  assert.equal(done.sessionId, undefined);
  assert.equal(fs.existsSync(path.join(f.directory, "agent-spawned.txt")), false);
  assert.deepEqual(dshCalls(f.directory), []);
});

test("Codex prompt runs persist, attach and resume the same thread", async (t) => {
  const f = fixture(t);
  fakeCodex(f.root);
  const previousRoot = process.env.CLOUDCLI_HOST_ROOT;
  process.env.CLOUDCLI_HOST_ROOT = f.root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.CLOUDCLI_HOST_ROOT;
    else process.env.CLOUDCLI_HOST_ROOT = previousRoot;
  });
  f.config("p1", [
    promptTask("agent", {
      reuseSession: true,
      agent: { provider: "codex", model: "gpt-x" },
    }),
  ]);
  f.scheduler.load(undefined, false, true);
  const started = f.scheduler.start("p1", "agent", "manual");
  // The API still answers synchronously with a running reservation.
  assert.equal(started.status, "running");
  const first = await finished(f, started.id);
  const second = await finished(f, f.scheduler.start("p1", "agent", "manual").id);
  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.equal(first.sessionId, second.sessionId);
  const calls = fs
    .readFileSync(path.join(f.directory, "codex-calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { args: string[] }).args);
  assert.deepEqual(calls[0], ["exec", "--json", "--model", "gpt-x", "-"]);
  assert.deepEqual(calls[1], [
    "exec",
    "--json",
    "--model",
    "gpt-x",
    "resume",
    "thread-native",
    "-",
  ]);
  assert.equal(f.fake.requests("scheduledAttachNative")[1]!.nativeSessionId, "thread-native");
});

test("maintenance never treats a slow prepare as a crashed run", async (t) => {
  const f = fixture(t);
  f.fake.hooks.scheduledPrepare = async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return {
      sessionId: "session-slow",
      executionId: "execution-slow",
      nativeSessionId: null,
    };
  };
  f.config("p1", [promptTask("agent")]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "agent", "manual");
  await waitFor(
    () => f.fake.requests("scheduledPrepare").length,
    (count) => count > 0,
  );
  f.scheduler.maintenance();
  assert.equal(f.store.run(run.id)?.status, "running");
  const done = await finished(f, run.id);
  assert.equal(done.status, "success", done.reason ?? "");
  assert.equal(done.sessionId, "session-slow");
});

test("closing while preparing aborts without spawning and still releases the slot", async (t) => {
  const f = fixture(t);
  f.fake.hooks.scheduledPrepare = async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      sessionId: "session-close",
      executionId: "execution-close",
      nativeSessionId: null,
    };
  };
  f.config("p1", [promptTask("agent")]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "agent", "manual");
  await f.scheduler.close();
  assert.equal(f.store.run(run.id)?.status, "stopped");
  assert.equal(fs.existsSync(path.join(f.directory, "agent-spawned.txt")), false);
  assert.equal(f.fake.requests("scheduledFinishRun")[0]!.outcome.aborted, true);
});

test("an internal stop while preparing also prevents the spawn", async (t) => {
  const f = fixture(t);
  f.fake.hooks.scheduledPrepare = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return {
      sessionId: "session-internal",
      executionId: "execution-internal",
      nativeSessionId: null,
    };
  };
  f.config("p1", [promptTask("agent")]);
  f.scheduler.load(undefined, false, true);
  const run = f.scheduler.start("p1", "agent", "manual");
  await waitFor(
    () => f.fake.requests("scheduledPrepare").length,
    (count) => count > 0,
  );
  // Internal stops preserve an existing cause but must still mark the run as stopped.
  f.scheduler.stop(run.id, true);
  const done = await finished(f, run.id);
  assert.equal(done.status, "stopped");
  assert.equal(fs.existsSync(path.join(f.directory, "agent-spawned.txt")), false);
  assert.equal(f.fake.requests("scheduledFinishRun")[0]!.outcome.aborted, true);
});

test("startup reconciliation never deletes bindings for a project with no local definitions", async (t) => {
  const f = fixture(t);
  // Fresh plugin database while the host may still own bindings from an earlier install.
  f.scheduler.recover();
  await f.scheduler.whenIdle();
  assert.equal(f.fake.requests("scheduledSyncTasks").length, 0);

  // An explicitly loaded empty task set is a real deletion and does sync the empty set.
  f.config("p1", []);
  const results = f.scheduler.load(undefined, false, true);
  assert.equal(results[0]!.status, "valid");
  await f.scheduler.whenIdle();
  const syncs = f.fake.requests("scheduledSyncTasks");
  assert.equal(syncs.length, 1);
  assert.deepEqual(syncs[0]!.taskIds, []);
});
