import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  nativeHome,
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
  const current = run(root, { model: "provider/model", effort: "high" });
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
    },
    dshPatch: patch,
  });
  assert.equal(launch.argv[0], "/bin/fake-dsh");
  assert.deepEqual(launch.argv.slice(1, 7), [
    "--profile",
    "headless",
    "--patch",
    custom,
    "--patch",
    runPatch,
  ]);
  assert.equal(fs.readFileSync(runPatch, "utf8"), fs.readFileSync(patch, "utf8"));
  assert.ok(launch.argv.includes("--json"));
  assert.equal(launch.argv.at(-1), "-");
  assert.equal(launch.argv.includes("--session-id"), false);
  const modelPatch = launch.argv[launch.argv.indexOf("--patch", 6) + 1]!;
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
        baseEnvironment: { CLOUDCLI_DSH_PATCHES: "not-json" },
        dshPatch: path.join(root, "patch.yml"),
      }),
    /CLOUDCLI_DSH_PATCHES/,
  );
  const pi = prepareLaunch({
    type: "pi",
    run: run(root, {
      workerId: "worker-pi",
      id: "run-pi",
      model: "recorded-model",
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
      "recorded-model",
      "--provider",
      "recorded-provider",
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
  assert.equal(parsed.usage?.totalTokens, 3);
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
