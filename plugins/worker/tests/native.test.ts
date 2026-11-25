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
  preparePiAcpLaunch,
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

test("DSH cannot launch; Pi keeps recorded model, effort and session arguments", () => {
  const root = temporaryRoot("worker-native-pi-");
  const runDirectory = path.join(root, "run");
  fs.mkdirSync(runDirectory, { recursive: true });
  assert.throws(
    () =>
      prepareLaunch({
        type: "dsh",
        run: run(root),
        cwd: root,
        prompt: "x",
        previous: null,
        dataDirectory: path.join(root, "data"),
        runDirectory,
        executable: "/bin/fake-dsh",
        baseEnvironment: {},
      }),
    (error: { code?: string }) => error.code === "WORKER_TYPE_UNSUPPORTED",
  );

  const pi = preparePiAcpLaunch({
    run: run(root, {
      workerId: "worker-pi",
      id: "run-pi",
      model: "provider/sub/model",
      provider: null,
      effort: "high",
      nativeProtocol: "acp",
    }),
    cwd: root,
    previous: null,
    dataDirectory: path.join(root, "data"),
    baseEnvironment: {
      CODEX_PI_MODEL: "changed-environment-model",
      CODEX_PI_THINKING: "low",
    },
  });
  assert.deepEqual(pi.configOptions, [
    { configId: "model", value: "provider/sub/model", match: "model" },
    { configId: "thought_level", value: "high", match: "exact" },
  ]);
  assert.equal(pi.sessionId, null);
  const configured = preparePiAcpLaunch({
    run: run(root, { workerId: "worker-pi", id: "run-pi-2", effort: "low", nativeProtocol: "acp" }),
    cwd: root,
    previous: null,
    dataDirectory: path.join(root, "data"),
    baseEnvironment: {},
  });
  assert.deepEqual(configured.configOptions, [
    { configId: "thought_level", value: "low", match: "exact" },
  ]);
  assert.throws(
    () =>
      preparePiAcpLaunch({
        run: run(root, { workerId: "worker-pi", id: "run-pi-3", model: null, effort: "max", nativeProtocol: "acp" }),
        cwd: root,
        previous: null,
        dataDirectory: path.join(root, "data"),
        baseEnvironment: {},
      }),
    /max/,
  );
  assert.throws(
    () =>
      preparePiAcpLaunch({
        run: run(root, { workerId: "worker-pi", id: "run-pi-4", model: null, effort: "extreme", nativeProtocol: "acp" }),
        cwd: root,
        previous: null,
        dataDirectory: path.join(root, "data"),
        baseEnvironment: {},
      }),
    /thinking/i,
  );

  // Legacy pre-ACP Pi JSON sessions keep their original `--print --mode json --session-dir --session` path on resume.
  const legacySessionsRoot = path.join(root, "data", "sessions", "pi");
  fs.mkdirSync(legacySessionsRoot, { recursive: true });
  const legacyFile = path.join(legacySessionsRoot, "legacy-run.jsonl");
  fs.writeFileSync(
    legacyFile,
    JSON.stringify({ type: "session", id: "legacy-pi-id", cwd: root }) + "\n",
  );
  const previousLegacy = run(root, {
    workerId: "worker-pi-legacy",
    id: "legacy-run",
    home: path.join(root, "pi-home"),
    sessionsRoot: legacySessionsRoot,
    nativeSessionId: "legacy-pi-id",
    nativeSessionFile: legacyFile,
    model: "provider/sub/model",
    effort: "max",
  });
  const legacyResume = prepareLaunch({
    type: "pi",
    run: previousLegacy,
    cwd: root,
    prompt: "resume legacy",
    previous: previousLegacy,
    dataDirectory: path.join(root, "data"),
    runDirectory,
    executable: "/bin/fake-pi",
    baseEnvironment: {},
  });
  assert.deepEqual(legacyResume.argv, [
    "/bin/fake-pi",
    "--print",
    "--mode",
    "json",
    "--session-dir",
    legacySessionsRoot,
    "--session",
    legacyFile,
    "--model",
    "provider/sub/model",
    "--thinking",
    "max",
  ]);
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
