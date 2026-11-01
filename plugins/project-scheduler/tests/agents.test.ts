import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent, resolveCodexBinary } from "../server/agent.js";
import { TelegramNotifier } from "../server/telegram.js";
import { SchedulerStore } from "../server/store.js";
import type { SchedulerAgent, SchedulerRun, SchedulerTaskResult } from "../shared/contracts.js";

function environment(t: TestContext, changes: Record<string, string>): void {
  const before = Object.fromEntries(
    Object.keys(changes).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, changes);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cron-agent-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fakeCodex(directory: string, code: string): string {
  const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
  const suffix =
    process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
  const pkg = path.join(
    directory,
    "node_modules",
    "@openai",
    "codex-" + process.platform + "-" + process.arch,
  );
  const bin = path.join(pkg, "vendor", cpu + "-" + suffix, "bin", "codex");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), "{}");
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  fs.writeFileSync(bin, "#!/usr/bin/env node\n" + code, { mode: 0o700 });
  return bin;
}
async function execute(
  agent: SchedulerAgent,
  cwd: string,
  options: Parameters<typeof runAgent>[4] = {},
) {
  let stdout = "",
    stderr = "",
    events = "";
  const result = await runAgent(agent, '多行提示词\nquotes: " $HOME ;', cwd, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    event: (text) => {
      events += text;
    },
    child: () => {},
  }, options);
  return { ...result, stdout, stderr, events };
}

test("Codex uses the host native dependency, ephemeral mode, stdin and terminal events", async (t) => {
  const directory = fixture(t);
  fakeCodex(
    directory,
    'const fs=require("fs");const prompt=fs.readFileSync(0,"utf8");fs.writeFileSync("call.json",JSON.stringify({args:process.argv.slice(2),prompt}));console.log(JSON.stringify({type:"item.completed",item:{id:"a",type:"agent_message",text:"中文 answer"}}));console.log(JSON.stringify({type:"turn.completed"}));',
  );
  environment(t, { CLOUDCLI_HOST_ROOT: directory });
  const result = await execute(
    { provider: "codex", model: "chosen-model" },
    directory,
  );
  assert.equal(result.success, true);
  assert.equal(result.stdout, "中文 answer\n");
  const call = JSON.parse(
    fs.readFileSync(path.join(directory, "call.json"), "utf8"),
  ) as { args: string[]; prompt: string };
  assert.deepEqual(call.args, [
    "exec",
    "--ephemeral",
    "--json",
    "--model",
    "chosen-model",
    "-",
  ]);
  assert.match(call.prompt, /quotes: " \$HOME ;/);
  assert.match(resolveCodexBinary(directory), /vendor/);
});

test("native binary resolution also supports unhoisted platform dependencies", (t) => {
  const directory = fixture(t);
  const binary = fakeCodex(directory, "");
  const platformName = "codex-" + process.platform + "-" + process.arch;
  const platformRoot = path.join(
    directory,
    "node_modules/@openai",
    platformName,
  );
  const codexRoot = path.join(directory, "node_modules/@openai/codex");
  fs.mkdirSync(path.join(codexRoot, "node_modules/@openai"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(codexRoot, "package.json"), "{}");
  fs.renameSync(
    platformRoot,
    path.join(codexRoot, "node_modules/@openai", platformName),
  );
  const resolved = resolveCodexBinary(directory);
  assert.equal(path.basename(resolved), path.basename(binary));
  assert.ok(resolved.startsWith(codexRoot + path.sep));
});

test("a zero exit succeeds without a terminal event and reports no failure reason", async (t) => {
  const directory = fixture(t);
  fakeCodex(
    directory,
    'console.log(JSON.stringify({type:"item.completed",item:{id:"a",type:"agent_message",text:"partial"}}));',
  );
  environment(t, { CLOUDCLI_HOST_ROOT: directory });
  const result = await execute(
    { provider: "codex", model: "default" },
    directory,
  );
  assert.equal(result.code, 0);
  assert.equal(result.success, true);
  assert.equal(result.reason, undefined);
});

test("large incremental text is emitted exactly once when the final item repeats it", async (t) => {
  const directory = fixture(t);
  fakeCodex(
    directory,
    'const text="中".repeat(80000);for(const type of ["item.updated","item.completed"])console.log(JSON.stringify({type,item:{id:"a",type:"agent_message",text}}));console.log(JSON.stringify({type:"turn.completed"}));',
  );
  environment(t, { CLOUDCLI_HOST_ROOT: directory });
  const result = await execute(
    { provider: "codex", model: "default" },
    directory,
  );
  assert.equal(result.success, true);
  assert.equal(result.stdout, "中".repeat(80000) + "\n");
});

test("DSH receives the last overlay disabling persistence and selecting the model without modifying profiles", async (t) => {
  const directory = fixture(t),
    bin = path.join(directory, "dsh");
  fs.writeFileSync(
    bin,
    '#!/usr/bin/env node\nconst fs=require("fs");const args=process.argv.slice(2);const index=args.lastIndexOf("--patch");const file=args[index+1];fs.writeFileSync("patch.json",JSON.stringify({file,args,patch:JSON.parse(fs.readFileSync(file,"utf8")),prompt:fs.readFileSync(0,"utf8")}));console.log(JSON.stringify({type:"text",text:"answer"}));console.log(JSON.stringify({type:"final",text:"answer",reason:{kind:"completed"}}));',
    { mode: 0o700 },
  );
  environment(t, {
    CLOUDCLI_DSH_BIN: bin,
    CLOUDCLI_DSH_PATCHES: '["/user/custom.patch.yml"]',
  });
  const result = await execute(
    { provider: "dsh", model: "magpie/group-ds" },
    directory,
  );
  assert.equal(result.success, true);
  assert.equal(result.stdout, "answer\n");
  const call = JSON.parse(
    fs.readFileSync(path.join(directory, "patch.json"), "utf8"),
  ) as { file: string; args: string[]; patch: unknown[] };
  assert.deepEqual(call.patch, [
    { id: "session-persistence-jsonl", disabled: true },
    { id: "session-checkpoint-policy", disabled: true },
    {
      id: "agent-default-model",
      config: { provider: "magpie", model: "group-ds" },
    },
  ]);
  assert.ok(
    call.args.indexOf("/user/custom.patch.yml") <
      call.args.lastIndexOf("--patch"),
  );
  // The temporary overlay is the last patch, so it wins over inherited user patches.
  assert.deepEqual(call.args.slice(-4), ["--patch", call.file, "--json", "-"]);
  assert.equal(fs.existsSync(call.file), false);
});

test("DSH zero exit with an error final still succeeds", async (t) => {
  const directory = fixture(t),
    bin = path.join(directory, "dsh");
  fs.writeFileSync(
    bin,
    '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"final",text:"failed",reason:{kind:"error"}})));',
    { mode: 0o700 },
  );
  environment(t, { CLOUDCLI_DSH_BIN: bin, CLOUDCLI_DSH_PATCHES: "[]" });
  const result = await execute({ provider: "dsh", model: "default" }, directory);
  assert.equal(result.code, 0);
  assert.equal(result.success, true);
  assert.equal(result.reason, undefined);
});

test("non-zero exits fail even after a successful terminal event", async (t) => {
  const directory = fixture(t),
    bin = path.join(directory, "dsh"),
    codexRoot = path.join(directory, "codex-root");
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.writeFileSync(
    bin,
    '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify({type:"final",text:"done",reason:{kind:"completed"}}));process.exitCode=2});',
    { mode: 0o700 },
  );
  fakeCodex(
    codexRoot,
    'process.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify({type:"turn.completed"}));process.exitCode=3});',
  );
  environment(t, {
    CLOUDCLI_DSH_BIN: bin,
    CLOUDCLI_DSH_PATCHES: "[]",
    CLOUDCLI_HOST_ROOT: codexRoot,
  });
  const dsh = await execute({ provider: "dsh", model: "default" }, directory);
  assert.equal(dsh.code, 2);
  assert.equal(dsh.success, false);
  const codex = await execute(
    { provider: "codex", model: "default" },
    directory,
  );
  assert.equal(codex.code, 3);
  assert.equal(codex.success, false);
});

test("a zero exit ignores invalid JSON events and stderr warnings", async (t) => {
  const directory = fixture(t),
    bin = path.join(directory, "dsh");
  fs.writeFileSync(
    bin,
    '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>{console.error("pending checkpoint warning");console.log("not json");console.log(JSON.stringify({type:"text",text:"answer"}))});',
    { mode: 0o700 },
  );
  environment(t, { CLOUDCLI_DSH_BIN: bin, CLOUDCLI_DSH_PATCHES: "[]" });
  const result = await execute({ provider: "dsh", model: "default" }, directory);
  assert.equal(result.code, 0);
  assert.equal(result.success, true);
  assert.equal(result.reason, undefined);
  assert.match(result.stderr, /pending checkpoint warning/);
  assert.equal(result.stdout, "answer\n");
});

test("a spawn failure fails with the spawn error", async (t) => {
  const directory = fixture(t);
  environment(t, {
    CLOUDCLI_DSH_BIN: path.join(directory, "missing-dsh"),
    CLOUDCLI_DSH_PATCHES: "[]",
  });
  const result = await execute({ provider: "dsh", model: "default" }, directory);
  // cross-spawn reports ENOENT as a negative close code rather than null.
  assert.notEqual(result.code, 0);
  assert.equal(result.success, false);
  assert.ok(result.reason);
});

test("prompt outcomes require a successful terminal event and the final task report", async (t) => {
  const completed: SchedulerTaskResult = { status: "success", summary: "日报已生成并核对日期" };
  const failed: SchedulerTaskResult = { status: "failed", summary: "目标接口权限不足，日报未生成" };
  const cases: Array<{
    name: string;
    text?: string;
    terminal: "completed" | "failed" | "missing";
    code?: number;
    recovered?: boolean;
    previousReport?: boolean;
    success: boolean;
    reason?: RegExp;
    taskResult?: SchedulerTaskResult;
  }> = [
    { name: "completed", text: JSON.stringify(completed), terminal: "completed", success: true, taskResult: completed },
    { name: "task-failed", text: JSON.stringify(failed), terminal: "completed", success: false, reason: /任务未完成：目标接口权限不足/, taskResult: failed },
    { name: "agent-failed", text: JSON.stringify(completed), terminal: "failed", success: false, reason: /Agent 执行失败：request failed/, taskResult: completed },
    { name: "nonzero", text: JSON.stringify(completed), terminal: "completed", code: 3, success: false, reason: /未以退出码 0 结束/, taskResult: completed },
    { name: "missing-terminal", text: JSON.stringify(completed), terminal: "missing", success: false, reason: /结果未确认：未收到 Agent 结束状态/, taskResult: completed },
    { name: "missing-report", terminal: "completed", success: false, reason: /结果未确认：未收到 Agent 最终任务结果/ },
    { name: "invalid-json", text: "权限不足，无法完成", terminal: "completed", success: false, reason: /结果未确认：.*JSON/ },
    { name: "invalid-status", text: '{"status":"maybe","summary":"不确定"}', terminal: "completed", success: false, reason: /结果未确认：.*状态/ },
    { name: "missing-summary", text: '{"status":"success"}', terminal: "completed", success: false, reason: /结果未确认：.*summary/ },
    { name: "blank-summary", text: '{"status":"success","summary":"  "}', terminal: "completed", success: false, reason: /结果未确认：.*summary/ },
    { name: "array-report", text: '[{"status":"success","summary":"done"}]', terminal: "completed", success: false, reason: /结果未确认：/ },
    { name: "last-report-wins", previousReport: true, text: JSON.stringify(failed), terminal: "completed", success: false, reason: /任务未完成：/, taskResult: failed },
    { name: "earlier-report-is-not-final", previousReport: true, text: "最终无法完成", terminal: "completed", success: false, reason: /结果未确认：/ },
    { name: "recovered-tool-error", recovered: true, text: JSON.stringify(completed), terminal: "completed", success: true, taskResult: completed },
  ];
  for (const provider of ["codex", "dsh"] as const) {
    for (const scenario of cases) {
      await t.test(provider + ": " + scenario.name, async (t) => {
        const directory = fixture(t);
        const events: object[] = [];
        if (provider === "codex") {
          events.push({ type: "turn.started" });
          if (scenario.previousReport)
            events.push({ type: "item.completed", item: { id: "previous", type: "agent_message", text: JSON.stringify(completed) } });
          if (scenario.recovered) events.push(
            { type: "error", message: "temporary request error, recovered" },
            { type: "item.completed", item: { type: "command_execution", exit_code: 1, aggregated_output: "retry" } },
          );
          events.push({ type: "item.completed", item: { id: "final", type: "agent_message", text: scenario.text } });
          if (scenario.terminal !== "missing")
            events.push(scenario.terminal === "completed"
              ? { type: "turn.completed" }
              : { type: "turn.failed", error: { message: "request failed" } });
        } else {
          if (scenario.previousReport) events.push({ type: "text", text: JSON.stringify(completed) });
          if (scenario.recovered) events.push(
            { type: "error", message: "temporary request error, recovered" },
            { type: "tool_result", isError: true, content: "retry" },
          );
          if (scenario.terminal !== "missing")
            events.push({ type: "final", text: scenario.text, reason: scenario.terminal === "completed"
              ? { kind: "completed" }
              : { kind: "error", error: { message: "request failed", code: "REQUEST_FAILED" } } });
          else events.push({ type: "text", text: scenario.text });
        }
        const script = 'const fs=require("fs");fs.writeFileSync("prompt.txt",fs.readFileSync(0,"utf8"));' +
          "process.stdout.write(" + JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n") + "\n") + ");" +
          "process.exitCode=" + (scenario.code ?? 0);
        if (provider === "codex") {
          fakeCodex(directory, script);
          environment(t, { CLOUDCLI_HOST_ROOT: directory });
        } else {
          const bin = path.join(directory, "dsh");
          fs.writeFileSync(bin, "#!/usr/bin/env node\n" + script, { mode: 0o700 });
          environment(t, { CLOUDCLI_DSH_BIN: bin, CLOUDCLI_DSH_PATCHES: "[]" });
        }
        const result = await execute({ provider, model: "default" }, directory, { requireTaskResult: true });
        assert.equal(result.code, scenario.code ?? 0);
        assert.equal(result.success, scenario.success);
        assert.deepEqual(result.taskResult,
          provider === "dsh" && scenario.terminal === "missing" ? undefined : scenario.taskResult);
        if (scenario.reason) assert.match(result.reason ?? "", scenario.reason);
        else assert.equal(result.reason, undefined);
        const prompt = fs.readFileSync(path.join(directory, "prompt.txt"), "utf8");
        assert.match(prompt, /quotes: " \$HOME ;/);
        assert.match(prompt, /\[定时任务结果约定\]/);
      });
    }
  }
});

test("notification outbox retries only delivery and persists its terminal result", async (t) => {
  const directory = fixture(t),
    store = new SchedulerStore(directory);
  t.after(() => store.close());
  store.saveSettings({
    ...store.settings(),
    telegram: { enabled: true, botToken: "123:fake", chatId: "456", proxy: "" },
  });
  const now = new Date().toISOString();
  const run: SchedulerRun = {
    id: "alert",
    projectId: "p",
    projectName: "project-name",
    taskId: "task",
    taskName: "task-name",
    status: "failed",
    trigger: "manual",
    scheduledAt: now,
    startedAt: now,
    endedAt: now,
    exitCode: 1,
    reason: "connection refused",
    workerPid: null,
    alertStatus: "pending",
    alertError: null,
    alertAttempts: 0,
  };
  store.saveRun(run);
  let calls = 0,
    message = "";
  const notifier = new TelegramNotifier(store, async (_settings, text) => {
    calls++;
    message = text;
    if (calls === 1) throw new Error("network down");
  });
  await notifier.flush();
  assert.equal(calls, 2);
  assert.match(message, /project-name/);
  assert.match(message, /connection refused/);
  assert.equal(store.run("alert")?.alertStatus, "sent");
  await notifier.flush();
  assert.equal(calls, 2);
  assert.equal(store.runs().length, 1);
});
