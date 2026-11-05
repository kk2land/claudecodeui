import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexEnvironment,
  nativeHome,
  parseCodex,
  parseDsh,
  parsePi,
  prepareLaunch,
  resolveExecutable,
} from "../server/native.js";
import type { WorkerRun } from "../shared/contracts.js";
import { temporaryRoot } from "./helpers.js";

function run(root: string, values: Partial<WorkerRun> = {}): WorkerRun {
  const homes = nativeHome("dsh", path.join(root, "data"), {
    DSH_HOME: path.join(root, "dsh-home"),
  });
  return {
    id: "run-1",
    workerId: "worker-1",
    requestId: "request-1",
    status: "starting",
    startedAt: null,
    finishedAt: null,
    model: null,
    provider: null,
    effort: null,
    timeoutSeconds: null,
    home: homes.home,
    sessionsRoot: homes.sessionsRoot,
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
    ...values,
  };
}

test("DSH uses headless, configured patches, persistence patch, model patch and session id", () => {
  const root = temporaryRoot("worker-native-dsh-");
  const runDirectory = path.join(root, "run");
  fs.mkdirSync(runDirectory, { recursive: true });
  const patch = path.join(root, "session.patch.yml");
  fs.writeFileSync(patch, "[]");
  const runPatch = path.join(runDirectory, "dsh-session.patch.yml");
  const custom = path.join(root, "custom.patch.yml");
  fs.writeFileSync(custom, "[]");
  const current = run(root, {
    model: "provider/model",
    provider: "legacy-provider",
    effort: "high",
  });
  const launch = prepareLaunch({
    type: "dsh",
    run: current,
    cwd: path.join(root, "project"),
    prompt: "hello",
    previous: null,
    dataDirectory: path.join(root, "data"),
    runDirectory,
    executable: "/bin/fake-dsh",
    baseEnvironment: {
      DSH_HOME: path.join(root, "dsh-home"),
      CLOUDCLI_DSH_PATCHES: JSON.stringify([custom]),
      CLOUDCLI_DSH_PROVIDER: "environment-provider",
    },
    dshPatch: patch,
  });
  assert.equal(launch.argv[0], "/bin/fake-dsh");
  assert.deepEqual(launch.argv.slice(1, 5), [
    "--profile",
    "headless",
    "--patch",
    runPatch,
  ]);
  assert.equal(launch.argv.includes(custom), false);
  assert.equal(fs.readFileSync(runPatch, "utf8"), fs.readFileSync(patch, "utf8"));
  assert.ok(launch.argv.includes("--json"));
  assert.equal(launch.argv.at(-1), "-");
  assert.equal(launch.argv.includes("--session-id"), false);
  const modelPatch = launch.argv[launch.argv.lastIndexOf("--patch") + 1]!;
  assert.deepEqual(JSON.parse(fs.readFileSync(modelPatch, "utf8")), [
    {
      id: "agent-default-model",
      config: { provider: "provider", model: "model", reasoningEffort: "high" },
    },
  ]);
  assert.equal(launch.env.DSH_HOME, path.join(root, "dsh-home"));
  assert.equal(
    launch.env.CODEX_DSH_SESSIONS_ROOT,
    path.join(root, "data", "sessions", "dsh"),
  );

  // DSH restore uses the recorded native id only; no local transcript file is required.
  const previous = run(root, {
    home: path.join(root, "dsh-home"),
    nativeSessionId: "session-abc",
    nativeSessionFile: null,
  });
  const resumedDirectory = path.join(root, "resumed-run");
  fs.mkdirSync(resumedDirectory);
  const resumed = prepareLaunch({
    type: "dsh",
    run: previous,
    cwd: path.join(root, "project"),
    prompt: "again",
    previous,
    dataDirectory: path.join(root, "data"),
    runDirectory: resumedDirectory,
    executable: "/bin/fake-dsh",
    baseEnvironment: { DSH_HOME: "/wrong-home" },
    dshPatch: patch,
  });
  const resumedPatch = path.join(resumedDirectory, "dsh-session.patch.yml");
  assert.equal(resumed.argv[resumed.argv.indexOf("--patch") + 1], resumedPatch);
  assert.equal(fs.readFileSync(resumedPatch, "utf8"), fs.readFileSync(patch, "utf8"));
  assert.deepEqual(
    resumed.argv.slice(
      resumed.argv.indexOf("--session-id"),
      resumed.argv.indexOf("--session-id") + 2,
    ),
    ["--session-id", "session-abc"],
  );
  assert.equal(resumed.env.DSH_HOME, path.join(root, "dsh-home"));
});

test("DSH validates patches and effort; Pi uses recorded values and print/json arguments", () => {
  const root = temporaryRoot("worker-native-pi-");
  const runDirectory = path.join(root, "run");
  fs.mkdirSync(runDirectory, { recursive: true });
  assert.throws(
    () =>
      prepareLaunch({
        type: "dsh",
        run: run(root, { effort: "high" }),
        cwd: root,
        prompt: "x",
        previous: null,
        dataDirectory: path.join(root, "data"),
        runDirectory,
        executable: "/bin/fake-dsh",
        baseEnvironment: {},
        dshPatch: path.join(root, "patch.yml"),
      }),
    /effort/,
  );
  const pi = prepareLaunch({
    type: "pi",
    run: run(root, {
      workerId: "worker-pi",
      id: "run-pi",
      model: "provider/sub/model",
      provider: "recorded-provider",
      effort: "high",
    }),
    cwd: root,
    prompt: "x",
    previous: null,
    dataDirectory: path.join(root, "data"),
    runDirectory,
    executable: "/bin/fake-pi",
    baseEnvironment: {
      CODEX_PI_MODEL: "changed-environment-model",
      CODEX_PI_THINKING: "low",
    },
    dshPatch: path.join(root, "patch.yml"),
  });
  assert.deepEqual(pi.argv.slice(0, 6), [
    "/bin/fake-pi",
    "--print",
    "--mode",
    "json",
    "--session-dir",
    path.join(root, "data", "sessions", "pi"),
  ]);
  assert.deepEqual(
    pi.argv.slice(pi.argv.indexOf("--model")),
    [
      "--model",
      "provider/sub/model",
      "--thinking",
      "high",
    ],
  );
  assert.equal(pi.argv.at(-1) === "-", false);
  const configured = prepareLaunch({
    type: "pi",
    run: run(root, { workerId: "worker-pi", id: "run-pi-2", effort: "low" }),
    cwd: root,
    prompt: "x",
    previous: null,
    dataDirectory: path.join(root, "data"),
    runDirectory,
    executable: "/bin/fake-pi",
    baseEnvironment: {},
    dshPatch: path.join(root, "patch.yml"),
  });
  assert.equal(configured.argv.includes("--model"), false);
  assert.deepEqual(
    configured.argv.slice(configured.argv.indexOf("--thinking")),
    ["--thinking", "low"],
  );
});

test("resolves relative PATH entries and expands tilde homes", () => {
  const root = temporaryRoot("worker-native-path-");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, "fake-tool");
  fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    assert.equal(
      resolveExecutable("fake-tool", { PATH: "bin" }),
      path.resolve(bin, "fake-tool"),
    );
  } finally {
    process.chdir(cwd);
  }
  assert.equal(
    nativeHome("dsh", path.join(root, "data"), { DSH_HOME: "~/custom-dsh" }).home,
    path.join(os.homedir(), "custom-dsh"),
  );
  assert.equal(
    nativeHome("pi", path.join(root, "data"), {
      PI_CODING_AGENT_DIR: "~/custom-pi",
    }).home,
    path.join(os.homedir(), "custom-pi"),
  );
});

function eventsFile(root: string, lines: unknown[]): string {
  const file = path.join(root, "events.jsonl");
  fs.writeFileSync(
    file,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") +
      "\n",
  );
  return file;
}

const cwd = path.join(os.tmpdir(), "worker-native-cwd");

test("DSH protocol rejects malformed, wrong id and wrong cwd", () => {
  const root = temporaryRoot("worker-native-protocol-dsh-");
  const good = [
    { type: "session", sessionId: "session-good", cwd },
    { type: "status", phase: "turn_end", reason: { kind: "completed" } },
    { type: "final", text: "ok" },
  ];
  assert.equal(parseDsh(eventsFile(root, good), "session-good", cwd, root).success, true);
  const wrongId = parseDsh(eventsFile(root, good), "session-other", cwd, root);
  assert.equal(wrongId.success, false);
  assert.equal(wrongId.nativeSessionId, null);
  assert.equal(parseDsh(eventsFile(root, good), "session-good", "/other", root).success, false);
  assert.equal(
    parseDsh(eventsFile(root, [...good.slice(0, 2), "{oops"]), "session-good", cwd, root)
      .success,
    false,
  );
  const incomplete = parseDsh(
    eventsFile(root, good.slice(0, 2)),
    "session-good",
    cwd,
    root,
  );
  assert.equal(incomplete.success, false);
  assert.equal(incomplete.nativeSessionId, "session-good");
});

test("Pi protocol accepts retry success and rejects wrong id/cwd or unfinished settle", () => {
  const root = temporaryRoot("worker-native-protocol-pi-");
  const identity = { type: "session", id: "session-pi", cwd };
  const assistant = (text: string) => ({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
    },
  });
  const retried = [
    identity,
    { type: "agent_start" },
    assistant("first attempt"),
    { type: "agent_end", willRetry: true },
    { type: "agent_start" },
    assistant("final answer"),
    { type: "turn_end", message: { usage: { input: 2, output: 1, totalTokens: 3 } } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled", aborted: false },
  ];
  const file = eventsFile(root, retried);
  const parsed = parsePi(file, "session-pi", cwd, file);
  assert.equal(parsed.success, true);
  assert.equal(parsed.finalText, "final answer");
  assert.deepEqual(parsed.usage, {
    inputTokens: 4,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 6,
    scope: "run",
    partial: false,
  });
  assert.equal(
    parsePi(eventsFile(root, retried), "session-other", cwd, file).success,
    false,
  );
  assert.equal(
    parsePi(eventsFile(root, retried), "session-pi", "/other", file).success,
    false,
  );
  assert.equal(
    parsePi(eventsFile(root, retried.slice(0, -1)), "session-pi", cwd, file).success,
    false,
  );
  const invalidContent: unknown[] = [...retried];
  invalidContent[5] = {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: 42 }] },
  };
  assert.equal(
    parsePi(eventsFile(root, invalidContent), "session-pi", cwd, file).success,
    false,
  );
});

test("Codex home and sessions root follow CODEX_HOME and stay isolated per run", () => {
  const root = temporaryRoot("worker-native-codex-home-");
  const env = { CODEX_HOME: path.join(root, "custom-home") };
  const homes = nativeHome("codex", path.join(root, "data"), env);
  assert.equal(homes.home, path.join(root, "custom-home"));
  assert.equal(homes.sessionsRoot, path.join(root, "custom-home", "sessions"));
  assert.deepEqual(nativeHome("codex", path.join(root, "data"), {}), {
    home: path.join(os.homedir(), ".codex"),
    sessionsRoot: path.join(os.homedir(), ".codex", "sessions"),
  });
});

test("Codex env merges before plugin control tokens are removed", () => {
  assert.deepEqual(
    codexEnvironment(
      {
        PATH: "/bin",
        CLOUDCLI_PLUGIN_TOKEN: "control-token",
      },
      {
        env: { CUSTOM: "value", CLOUDCLI_PLUGIN_OTHER: "control-value" },
      },
    ),
    { PATH: "/bin", CUSTOM: "value" },
  );
});

test("Codex launch uses exec json, configured args, explicit overrides, and stdin", () => {
  const root = temporaryRoot("worker-native-codex-launch-");
  const runDirectory = path.join(root, "run");
  fs.mkdirSync(runDirectory, { recursive: true });
  const home = path.join(root, "codex-home");
  const current = run(root, {
    home,
    sessionsRoot: path.join(home, "sessions"),
    model: "explicit-model",
    provider: "explicit-provider",
    effort: "high",
  });
  const launch = prepareLaunch({
    type: "codex",
    run: current,
    cwd: path.join(root, "project"),
    prompt: "hello",
    previous: null,
    dataDirectory: path.join(root, "data"),
    runDirectory,
    executable: "/bin/fake-codex",
    baseEnvironment: {
      PATH: "/bin",
      CODEX_PROXY_BYPASS: "1",
      CUSTOM: "value",
    },
    codexExtraArgs: [
      "-c",
      "model_provider=configured",
      "--model",
      "args-model",
      "-m",
      "args-short",
    ],
    dshPatch: "",
  });
  assert.deepEqual(launch.argv, [
    "/bin/fake-codex",
    "exec",
    "--json",
    "-c",
    "model_provider=configured",
    "--model",
    "explicit-model",
    "-c",
    'model_provider="explicit-provider"',
    "-c",
    'model_reasoning_effort="high"',
    "-",
  ]);
  assert.equal(launch.cwd, path.join(root, "project"));
  assert.equal(launch.prompt, "hello");
  assert.equal(launch.env.CODEX_HOME, home);
  assert.equal(launch.env.CODEX_PROXY_BYPASS, "1");
  assert.equal(launch.env.CUSTOM, "value");
  assert.equal(launch.argv.includes("args-model"), false);
  assert.equal(launch.argv.includes("args-short"), false);
  assert.equal(launch.sessionFile, null);
  assert.equal(launch.expectedSessionId, null);
});

test("Codex resume keeps the thread id and places every option before resume", () => {
  const root = temporaryRoot("worker-native-codex-resume-");
  const home = path.join(root, "codex-home");
  const current = run(root, {
    home,
    sessionsRoot: path.join(home, "sessions"),
    nativeSessionId: "thread-1",
  });
  const launch = prepareLaunch({
    type: "codex",
    run: current,
    cwd: path.join(root, "project"),
    prompt: "again",
    previous: current,
    dataDirectory: path.join(root, "data"),
    runDirectory: path.join(root, "run"),
    executable: "/bin/fake-codex",
    baseEnvironment: { PATH: "/bin" },
    codexExtraArgs: ["--sandbox", "read-only"],
    dshPatch: "",
  });
  assert.deepEqual(launch.argv.slice(1), [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "resume",
    "thread-1",
    "-",
  ]);
  assert.equal(launch.expectedSessionId, "thread-1");
  assert.equal(launch.env.CODEX_HOME, home);
});

test("Codex JSONL parser reports final text and input-plus-output usage", () => {
  const root = temporaryRoot("worker-native-codex-parse-");
  const file = path.join(root, "events.log");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "error",
        message: "Reconnecting... 1/5 (stream disconnected before completion)",
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "answer" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 11,
          cached_input_tokens: 4,
          cache_write_input_tokens: 2,
          output_tokens: 5,
          reasoning_output_tokens: 3,
        },
      }),
    ].join("\n") + "\n",
  );
  assert.deepEqual(parseCodex(file, "thread-1"), {
    success: true,
    nativeSessionId: "thread-1",
    nativeSessionFile: null,
    finalText: "answer",
    usage: {
      inputTokens: 11,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      totalTokens: 16,
      scope: "session",
      partial: false,
    },
    error: null,
  });
});

test("Codex failures retain a confirmed thread id but reject a different resume id", () => {
  const root = temporaryRoot("worker-native-codex-failure-");
  const file = path.join(root, "events.log");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
    ].join("\n") + "\n",
  );
  const failed = parseCodex(file, "thread-1");
  assert.equal(failed.success, false);
  assert.equal(failed.nativeSessionId, "thread-1");
  assert.equal(failed.error, "boom");
  const wrong = parseCodex(file, "thread-2");
  assert.equal(wrong.success, false);
  assert.equal(wrong.nativeSessionId, null);
  assert.match(wrong.error ?? "", /thread_id/);
});

test("Codex keeps a reconnect error only when no successful completion follows", () => {
  const root = temporaryRoot("worker-native-codex-recoverable-");
  const file = path.join(root, "events.log");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }),
    ].join("\n") + "\n",
  );
  const failed = parseCodex(file, "thread-1");
  assert.equal(failed.success, false);
  assert.equal(failed.error, "Reconnecting... 1/5");
  assert.equal(failed.nativeSessionId, "thread-1");
});

test("Codex protocol errors are not cleared by a later completed turn", () => {
  const root = temporaryRoot("worker-native-codex-protocol-");
  const file = path.join(root, "events.log");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      "null",
      "not-json",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "answer" },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join("\n") + "\n",
  );
  const failed = parseCodex(file, "thread-1");
  assert.equal(failed.success, false);
  assert.match(failed.error ?? "", /无效 Codex 事件/);
});
