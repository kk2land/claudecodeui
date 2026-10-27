import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent, resolveCodexBinary } from "../server/agent.js";
import { TelegramNotifier } from "../server/telegram.js";
import { SchedulerStore } from "../server/store.js";
import type { SchedulerAgent, SchedulerRun } from "../shared/contracts.js";

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
async function execute(agent: SchedulerAgent, cwd: string) {
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
  });
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

test("a zero exit without a successful terminal event is not accepted as success", async (t) => {
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
  assert.equal(result.success, false);
  assert.match(result.reason!, /结束事件/);
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
    {
      id: "agent-default-model",
      config: { provider: "magpie", model: "group-ds" },
    },
  ]);
  assert.ok(
    call.args.indexOf("/user/custom.patch.yml") <
      call.args.lastIndexOf("--patch"),
  );
  assert.equal(fs.existsSync(call.file), false);
});

test("DSH final error cannot be hidden by a normal process exit", async (t) => {
  const directory = fixture(t),
    bin = path.join(directory, "dsh");
  fs.writeFileSync(
    bin,
    '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"final",text:"failed",reason:{kind:"error"}})));',
    { mode: 0o700 },
  );
  environment(t, { CLOUDCLI_DSH_BIN: bin, CLOUDCLI_DSH_PATCHES: "[]" });
  assert.equal(
    (await execute({ provider: "dsh", model: "default" }, directory)).success,
    false,
  );
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
