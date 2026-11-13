import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeSessionsRoot, runAgent } from "../server/agent.js";
import type { SchedulerAgent } from "../shared/contracts.js";

function fixture(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cron-native-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function environment(
  t: TestContext,
  changes: Record<string, string | undefined>,
): void {
  const before = Object.fromEntries(
    Object.keys(changes).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
/** The host resolves Codex from its own optional platform dependency, so mirror that layout. */
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
// A fake Codex exec: records the argv and prompt, then reports the requested thread id.
const codexScript = `const fs=require("fs");
const prompt=fs.readFileSync(0,"utf8");
fs.appendFileSync("calls.jsonl",JSON.stringify({args:process.argv.slice(2),prompt})+"\\n");
if(process.env.FAKE_CODEX_THREAD)
  console.log(JSON.stringify({type:"thread.started",thread_id:process.env.FAKE_CODEX_MISMATCH==="1"?"other-thread":process.env.FAKE_CODEX_THREAD}));
console.log(JSON.stringify({type:"item.completed",item:{id:"m",type:"agent_message",text:process.env.FAKE_CODEX_TEXT||"完成"}}));
const reports=process.env.FAKE_CODEX_USAGE?JSON.parse(process.env.FAKE_CODEX_USAGE):[{input_tokens:7,output_tokens:3,cached_input_tokens:2}];
for(const usage of reports) console.log(JSON.stringify({type:"turn.completed",usage}));`;
// The same fake, but it keeps working after a mismatch unless the run stops it.
const codexMismatchScript = `const fs=require("fs");
fs.readFileSync(0,"utf8");
fs.appendFileSync("calls.jsonl",JSON.stringify({args:process.argv.slice(2)})+"\\n");
console.log(JSON.stringify({type:"thread.started",thread_id:"other-thread"}));
setTimeout(()=>fs.writeFileSync("continued.txt",""),1000);
process.stdin.resume();`;
const dshMismatchScript = `const fs=require("fs");
fs.appendFileSync("calls.jsonl",JSON.stringify({args:process.argv.slice(2)})+"\\n");
console.log(JSON.stringify({type:"session",sessionId:"other-session"}));
setTimeout(()=>fs.writeFileSync("continued.txt",""),1000);
process.stdin.resume();`;
// A fake DSH headless: records argv plus the composed overlay and emits the session event.
const dshScript = `const fs=require("fs");
const args=process.argv.slice(2);
const prompt=fs.readFileSync(0,"utf8");
const file=args[args.lastIndexOf("--patch")+1];
fs.appendFileSync("calls.jsonl",JSON.stringify({args,prompt,patch:JSON.parse(fs.readFileSync(file,"utf8"))})+"\\n");
console.log(JSON.stringify({type:"session",sessionId:process.env.FAKE_DSH_MISMATCH==="1"?"other-session":process.env.FAKE_DSH_SESSION,cwd:process.cwd()}));
console.log(JSON.stringify({type:"status",phase:"step_end",turnId:"t1",stepId:"s1",usage:{inputTokens:5,outputTokens:2}}));
console.log(JSON.stringify({type:"status",phase:"turn_end",reason:{kind:"completed"}}));
console.log(JSON.stringify({type:"final",text:"完成"}));`;

type Call = {
  args: string[];
  prompt: string;
  patch?: Array<{ id: string; disabled?: boolean; config?: unknown }>;
};
function calls(directory: string): Call[] {
  return fs
    .readFileSync(path.join(directory, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Call);
}
async function execute(
  agent: SchedulerAgent,
  cwd: string,
  options: Parameters<typeof runAgent>[4] = {},
) {
  let stdout = "";
  const observed: Array<unknown> = [];
  const result = await runAgent(
    agent,
    "提示词",
    cwd,
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      event: () => {},
      child: () => {},
      usage: (value) => observed.push(value),
    },
    options,
  );
  return { ...result, stdout, observed };
}

test("Codex stays ephemeral by default and reports no native session", async (t) => {
  const directory = fixture(t);
  fakeCodex(directory, codexScript);
  environment(t, {
    CLOUDCLI_HOST_ROOT: directory,
    FAKE_CODEX_THREAD: "thread-a",
  });
  const sessions: string[] = [];
  const result = await execute(
    { provider: "codex", model: "gpt-x" },
    directory,
    { onNativeSession: (id) => sessions.push(id) },
  );
  assert.equal(result.success, true);
  assert.equal(result.nativeSessionId, undefined);
  assert.deepEqual(sessions, []);
  assert.deepEqual(calls(directory)[0]!.args, [
    "exec",
    "--ephemeral",
    "--json",
    "--model",
    "gpt-x",
    "-",
  ]);
});

test("a persisted Codex run drops --ephemeral, captures the thread and keeps result and usage", async (t) => {
  const directory = fixture(t);
  fakeCodex(directory, codexScript);
  environment(t, {
    CLOUDCLI_HOST_ROOT: directory,
    FAKE_CODEX_THREAD: "thread-new",
    FAKE_CODEX_TEXT: '{"status":"success","summary":"已运行"}',
  });
  const sessions: string[] = [];
  const result = await execute(
    { provider: "codex", model: "gpt-x", effort: "high" },
    directory,
    {
      persistNativeSession: true,
      requireTaskResult: true,
      onNativeSession: (id) => sessions.push(id),
    },
  );
  assert.equal(result.success, true);
  assert.equal(result.nativeSessionId, "thread-new");
  assert.deepEqual(sessions, ["thread-new"]);
  // The existing task-result and usage boundaries are unchanged by persistence.
  assert.deepEqual(result.taskResult, { status: "success", summary: "已运行" });
  assert.deepEqual(result.usage, {
    inputTokens: 7,
    outputTokens: 3,
    cacheReadTokens: 2,
    cacheWriteTokens: null,
  });
  assert.deepEqual(calls(directory)[0]!.args, [
    "exec",
    "--json",
    "--model",
    "gpt-x",
    "-c",
    'model_reasoning_effort="high"',
    "-",
  ]);
});

test("Codex resume continues the expected thread and fails on a different one", async (t) => {
  const directory = fixture(t);
  fakeCodex(directory, codexScript);
  environment(t, {
    CLOUDCLI_HOST_ROOT: directory,
    CODEX_HOME: path.join(directory, "codex-home"),
    FAKE_CODEX_THREAD: "thread-a",
  });
  const resumed = await execute(
    { provider: "codex", model: "gpt-x" },
    directory,
    {
      persistNativeSession: true,
      resumeNativeSessionId: "thread-a",
    },
  );
  assert.equal(resumed.success, true);
  assert.equal(resumed.nativeSessionId, "thread-a");
  assert.deepEqual(calls(directory)[0]!.args, [
    "exec",
    "--json",
    "--model",
    "gpt-x",
    "resume",
    "thread-a",
    "-",
  ]);

  process.env.FAKE_CODEX_MISMATCH = "1";
  t.after(() => delete process.env.FAKE_CODEX_MISMATCH);
  const sessions: string[] = [];
  const mismatched = await execute(
    { provider: "codex", model: "gpt-x" },
    directory,
    {
      persistNativeSession: true,
      resumeNativeSessionId: "thread-a",
      onNativeSession: (id) => sessions.push(id),
    },
  );
  // The run is stopped on the wrong identity, so it can never report success.
  assert.equal(mismatched.code, null);
  assert.equal(mismatched.success, false);
  assert.match(mismatched.reason ?? "", /不同 thread_id/);
  assert.equal(mismatched.nativeSessionId, undefined);
  assert.deepEqual(sessions, []);
});

test("a persisted Codex run without thread.started fails instead of losing the identity", async (t) => {
  const directory = fixture(t);
  fakeCodex(directory, codexScript);
  environment(t, { CLOUDCLI_HOST_ROOT: directory });
  const result = await execute(
    { provider: "codex", model: "gpt-x" },
    directory,
    {
      persistNativeSession: true,
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.success, false);
  assert.match(result.reason ?? "", /未报告 thread\.started/);
});

test("DSH persistence keeps the profile default root and resumes with --session-id", async (t) => {
  const directory = fixture(t);
  const bin = path.join(directory, "dsh");
  fs.writeFileSync(bin, "#!/usr/bin/env node\n" + dshScript, { mode: 0o700 });
  environment(t, {
    CLOUDCLI_DSH_BIN: bin,
    CLOUDCLI_DSH_PATCHES: "[]",
    CLOUDCLI_DSH_SESSIONS_DIR: undefined,
    DSH_HOME: undefined,
    FAKE_DSH_SESSION: "session-a",
  });
  const sessions: string[] = [];
  const created = await execute(
    { provider: "dsh", model: "gw/model" },
    directory,
    {
      persistNativeSession: true,
      onNativeSession: (id) => sessions.push(id),
    },
  );
  assert.equal(created.success, true);
  assert.equal(created.nativeSessionId, "session-a");
  assert.deepEqual(sessions, ["session-a"]);
  assert.deepEqual(created.usage, {
    inputTokens: 5,
    outputTokens: 2,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });
  const first = calls(directory)[0]!;
  // Persistence and the checkpoint policy stay at their profile defaults: only the model patch.
  assert.deepEqual(first.patch, [
    { id: "agent-default-model", config: { provider: "gw", model: "model" } },
  ]);
  assert.equal(first.args.includes("--session-id"), false);
  assert.deepEqual(first.args.slice(-2), ["--json", "-"]);

  const resumed = await execute(
    { provider: "dsh", model: "gw/model" },
    directory,
    {
      persistNativeSession: true,
      resumeNativeSessionId: "session-a",
    },
  );
  assert.equal(resumed.success, true);
  assert.equal(resumed.nativeSessionId, "session-a");
  const second = calls(directory)[1]!;
  assert.deepEqual(second.args.slice(-4), [
    "--json",
    "--session-id",
    "session-a",
    "-",
  ]);
  assert.deepEqual(second.patch, [
    { id: "agent-default-model", config: { provider: "gw", model: "model" } },
  ]);
});

test("DSH default runs still disable persistence and a wrong resume id fails", async (t) => {
  const directory = fixture(t);
  const bin = path.join(directory, "dsh");
  fs.writeFileSync(bin, "#!/usr/bin/env node\n" + dshScript, { mode: 0o700 });
  environment(t, {
    CLOUDCLI_DSH_BIN: bin,
    CLOUDCLI_DSH_PATCHES: "[]",
    CLOUDCLI_DSH_SESSIONS_DIR: undefined,
    DSH_HOME: undefined,
    FAKE_DSH_SESSION: "session-a",
  });
  const plain = await execute({ provider: "dsh", model: "default" }, directory);
  assert.equal(plain.success, true);
  assert.equal(plain.nativeSessionId, undefined);
  assert.deepEqual(calls(directory)[0]!.patch, [
    { id: "session-persistence-jsonl", disabled: true },
    { id: "session-checkpoint-policy", disabled: true },
  ]);

  process.env.FAKE_DSH_MISMATCH = "1";
  t.after(() => delete process.env.FAKE_DSH_MISMATCH);
  const mismatched = await execute(
    { provider: "dsh", model: "default" },
    directory,
    {
      persistNativeSession: true,
      resumeNativeSessionId: "session-a",
    },
  );
  assert.equal(mismatched.code, null);
  assert.equal(mismatched.success, false);
  assert.match(mismatched.reason ?? "", /不同会话 ID/);
  assert.equal(mismatched.nativeSessionId, undefined);
});

test("a resume id requires explicit persistence", async (t) => {
  const directory = fixture(t);
  await assert.rejects(
    () =>
      execute({ provider: "codex", model: "gpt-x" }, directory, {
        resumeNativeSessionId: "thread-a",
      }),
    /需要显式 persistNativeSession/,
  );
  await assert.rejects(
    () =>
      execute({ provider: "dsh", model: "default" }, directory, {
        persistNativeSession: true,
        resumeNativeSessionId: " ",
      }),
    /必须是非空字符串/,
  );
});

/** Writes a real Codex rollout shape: cumulative token_count reports for one thread. */
function codexRollout(
  home: string,
  threadId: string,
  totals: Array<{ input: number; output: number; cacheRead: number }>,
): string {
  const file = path.join(
    home,
    "sessions",
    "2024",
    "01",
    "01",
    "rollout-2024-01-01T00-00-00-" + threadId + ".jsonl",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    totals
      .map((total) =>
        JSON.stringify({
          timestamp: "2024-01-01T00:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: total.input,
                output_tokens: total.output,
                cached_input_tokens: total.cacheRead,
                total_tokens: total.input + total.output,
              },
              last_token_usage: {
                input_tokens: total.input,
                output_tokens: total.output,
                cached_input_tokens: total.cacheRead,
                total_tokens: total.input + total.output,
              },
            },
          },
        }),
      )
      .join("\n") + "\n",
  );
  return file;
}

test("nativeSessionsRoot follows the host's own provider homes", (t) => {
  environment(t, {
    CODEX_HOME: undefined,
    DSH_HOME: undefined,
    CLOUDCLI_DSH_SESSIONS_DIR: undefined,
  });
  assert.equal(
    nativeSessionsRoot("codex", process.env),
    path.join(os.homedir(), ".codex", "sessions"),
  );
  assert.equal(
    nativeSessionsRoot("dsh", process.env),
    path.join(os.homedir(), ".dsh", "sessions"),
  );
  const root = fixture(t);
  assert.equal(
    nativeSessionsRoot("codex", { CODEX_HOME: root }),
    path.join(root, "sessions"),
  );
  assert.equal(
    nativeSessionsRoot("dsh", { DSH_HOME: root }),
    path.join(root, "sessions"),
  );
  // The host's sessions-dir override wins, exactly as DshConfigurationProvider resolves it.
  assert.equal(
    nativeSessionsRoot("dsh", {
      DSH_HOME: root,
      CLOUDCLI_DSH_SESSIONS_DIR: path.join(root, "host", "sessions"),
    }),
    path.join(root, "host", "sessions"),
  );
  // The fallback home comes from the run's effective env, not this process's homedir.
  assert.equal(
    nativeSessionsRoot("codex", { HOME: path.join(root, "home") }),
    path.join(root, "home", ".codex", "sessions"),
  );
  assert.equal(
    nativeSessionsRoot("dsh", { USERPROFILE: path.join(root, "user") }),
    path.join(root, "user", ".dsh", "sessions"),
  );
  // A relative native home/root resolves against the task cwd the CLI runs in.
  assert.equal(
    nativeSessionsRoot("codex", { CODEX_HOME: "codex-rel" }, root),
    path.join(root, "codex-rel", "sessions"),
  );
  assert.equal(
    nativeSessionsRoot(
      "dsh",
      { CLOUDCLI_DSH_SESSIONS_DIR: "sessions-rel" },
      root,
    ),
    path.join(root, "sessions-rel"),
  );
  // Without a cwd it is rejected instead of being resolved against the plugin cwd.
  assert.throws(
    () => nativeSessionsRoot("codex", { CODEX_HOME: "codex-rel" }),
    /相对路径/,
  );
});

test("a persisted Codex run keeps only the last cumulative turn report", async (t) => {
  const directory = fixture(t);
  fakeCodex(directory, codexScript);
  environment(t, {
    CLOUDCLI_HOST_ROOT: directory,
    CODEX_HOME: path.join(directory, "codex-home"),
    FAKE_CODEX_THREAD: "thread-new",
    // Real format: every turn report carries the thread's cumulative totals.
    FAKE_CODEX_USAGE: JSON.stringify([
      { input_tokens: 15, output_tokens: 6, cached_input_tokens: 5 },
      { input_tokens: 18, output_tokens: 8, cached_input_tokens: 6 },
    ]),
  });
  const result = await execute(
    { provider: "codex", model: "gpt-x" },
    directory,
    { persistNativeSession: true },
  );
  assert.equal(result.success, true);
  assert.equal(result.nativeSessionId, "thread-new");
  assert.deepEqual(result.usage, {
    inputTokens: 18,
    outputTokens: 8,
    cacheReadTokens: 6,
    cacheWriteTokens: null,
  });
  // Summing cumulative snapshots would have reported 33/14/11.
  assert.deepEqual(result.observed.at(-1), result.usage);
});

test("a Codex resume subtracts the launch baseline and keeps cache distinct", async (t) => {
  const directory = fixture(t);
  fakeCodex(directory, codexScript);
  const codexHome = path.join(directory, "codex-home");
  codexRollout(codexHome, "thread-a", [
    { input: 11, output: 5, cacheRead: 4 },
  ]);
  environment(t, {
    CLOUDCLI_HOST_ROOT: directory,
    CODEX_HOME: codexHome,
    FAKE_CODEX_THREAD: "thread-a",
    FAKE_CODEX_USAGE: JSON.stringify([
      { input_tokens: 15, output_tokens: 6, cached_input_tokens: 5 },
      { input_tokens: 18, output_tokens: 8, cached_input_tokens: 6 },
    ]),
  });
  const result = await execute(
    { provider: "codex", model: "gpt-x" },
    directory,
    { persistNativeSession: true, resumeNativeSessionId: "thread-a" },
  );
  assert.equal(result.success, true);
  // This run produced 18-11 / 8-5 / 6-4, not the thread's cumulative 18/8/6.
  assert.deepEqual(result.usage, {
    inputTokens: 7,
    outputTokens: 3,
    cacheReadTokens: 2,
    cacheWriteTokens: null,
  });
  assert.deepEqual(result.observed.at(-1), result.usage);
});

test("a Codex resume without a readable baseline reports no usage instead of history", async (t) => {
  const directory = fixture(t);
  fakeCodex(directory, codexScript);
  environment(t, {
    CLOUDCLI_HOST_ROOT: directory,
    CODEX_HOME: path.join(directory, "codex-home"),
    FAKE_CODEX_THREAD: "thread-a",
    FAKE_CODEX_USAGE: JSON.stringify([
      { input_tokens: 18, output_tokens: 8, cached_input_tokens: 6 },
    ]),
  });
  const result = await execute(
    { provider: "codex", model: "gpt-x" },
    directory,
    { persistNativeSession: true, resumeNativeSessionId: "thread-a" },
  );
  assert.equal(result.success, true);
  assert.equal(result.nativeSessionId, "thread-a");
  // Without the pre-run snapshot the session total must not be reported as this run.
  assert.equal(result.usage, null);
  assert.deepEqual(result.observed, []);
});

test("DSH persistence aligns its JSONL root with CLOUDCLI_DSH_SESSIONS_DIR", async (t) => {
  const directory = fixture(t);
  const bin = path.join(directory, "dsh");
  fs.writeFileSync(bin, "#!/usr/bin/env node\n" + dshScript, { mode: 0o700 });
  const hostSessions = path.join(directory, "host", "sessions");
  environment(t, {
    CLOUDCLI_DSH_BIN: bin,
    CLOUDCLI_DSH_PATCHES: "[]",
    CLOUDCLI_DSH_SESSIONS_DIR: hostSessions,
    DSH_HOME: path.join(directory, "dsh-home"),
    FAKE_DSH_SESSION: "session-a",
  });
  const result = await execute(
    { provider: "dsh", model: "default" },
    directory,
    { persistNativeSession: true },
  );
  assert.equal(result.success, true);
  // The host already reads this override, so the native writer is pointed at the same root.
  assert.deepEqual(calls(directory)[0]!.patch, [
    {
      id: "session-persistence-jsonl",
      config: { root: path.resolve(hostSessions) },
    },
  ]);
});

/** A mismatched resume must be stopped, not left running in another session. */
async function assertStopsOnMismatch(
  t: TestContext,
  provider: "codex" | "dsh",
): Promise<void> {
  const directory = fixture(t);
  if (provider === "codex") {
    fakeCodex(directory, codexMismatchScript);
    environment(t, {
      CLOUDCLI_HOST_ROOT: directory,
      CODEX_HOME: path.join(directory, "codex-home"),
    });
  } else {
    const bin = path.join(directory, "dsh");
    fs.writeFileSync(bin, "#!/usr/bin/env node\n" + dshMismatchScript, {
      mode: 0o700,
    });
    environment(t, {
      CLOUDCLI_DSH_BIN: bin,
      CLOUDCLI_DSH_PATCHES: "[]",
      CLOUDCLI_DSH_SESSIONS_DIR: undefined,
      DSH_HOME: undefined,
    });
  }
  const started = Date.now();
  const result = await execute({ provider, model: "default" }, directory, {
    persistNativeSession: true,
    resumeNativeSessionId: provider === "codex" ? "thread-a" : "session-a",
  });
  const elapsed = Date.now() - started;
  assert.equal(result.success, false);
  assert.equal(result.nativeSessionId, undefined);
  assert.match(
    result.reason ?? "",
    provider === "codex" ? /不同 thread_id/ : /不同会话 ID/,
  );
  // The fake would keep working after 1s; a stopped run never gets there.
  assert.ok(elapsed < 900, "run must stop promptly, took " + elapsed + "ms");
  const marker = path.join(directory, "continued.txt");
  assert.equal(fs.existsSync(marker), false);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(fs.existsSync(marker), false, "a stopped agent kept working");
  assert.equal(calls(directory).length, 1);
}

test("Codex stops the agent on a wrong resume id", (t) =>
  assertStopsOnMismatch(t, "codex"));
test("DSH stops the agent on a wrong resume id", (t) =>
  assertStopsOnMismatch(t, "dsh"));
