import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTasks, defaultSettings } from "../server/configuration.js";
import { runAgent } from "../server/agent.js";

function project(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cron-effort-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function task(agent: Record<string, unknown>) {
  return {
    id: "a",
    type: "prompt",
    cron: "0 0 9 * * *",
    prompt: "hi",
    agent,
  };
}
function parse(root: string, defaults: Record<string, unknown>, tasks: unknown[]) {
  return parseTasks(
    { version: 1, defaults, tasks },
    root,
    defaultSettings(),
  );
}

test("effort is inherited only with the same provider and effective model", (t) => {
  const root = project(t);
  const tasks = parse(
    root,
    { agent: { provider: "codex", model: "gpt-x", effort: "high" } },
    [
      // Same provider and model: inherits effort.
      { id: "same", agent: { provider: "codex", model: "gpt-x" } },
      // Same provider, different model: model and effort both re-resolve.
      { id: "other-model", agent: { model: "gpt-y" } },
      // Different provider: never inherits the other provider's model or effort.
      { id: "other-provider", agent: { provider: "dsh", model: "gw/model" } },
      // No agent at all: the project defaults apply verbatim.
      { id: "inherit-all" },
    ].map((row) => ({
      ...row,
      type: "prompt",
      cron: "0 0 9 * * *",
      prompt: "hi",
    })),
  );
  const byId = Object.fromEntries(tasks.map((entry) => [entry.id, entry.agent]));
  assert.deepEqual(byId.same, { provider: "codex", model: "gpt-x", effort: "high" });
  assert.deepEqual(byId["other-model"], { provider: "codex", model: "gpt-y" });
  assert.deepEqual(byId["other-provider"], { provider: "dsh", model: "gw/model" });
  assert.deepEqual(byId["inherit-all"], {
    provider: "codex",
    model: "gpt-x",
    effort: "high",
  });
});

test("switching provider keeps no model or effort from the previous provider", (t) => {
  const root = project(t);
  const [entry] = parse(
    root,
    { agent: { provider: "codex", model: "gpt-x", effort: "high" } },
    [task({ provider: "dsh" })],
  );
  assert.deepEqual(entry!.agent, { provider: "dsh", model: "default" });
});

test("an explicit default effort cancels inheritance and is never forwarded", (t) => {
  const root = project(t);
  const [entry] = parse(
    root,
    { agent: { provider: "codex", model: "gpt-x", effort: "high" } },
    [task({ effort: "default" })],
  );
  assert.deepEqual(entry!.agent, {
    provider: "codex",
    model: "gpt-x",
    effort: "default",
  });
});

test("unknown effort strings are preserved instead of being dropped", (t) => {
  const root = project(t);
  const [entry] = parse(root, {}, [task({ provider: "codex", effort: "turbo-unknown" })]);
  assert.equal(entry!.agent.effort, "turbo-unknown");
});

test("invalid effort input is rejected with an actionable error", (t) => {
  const root = project(t);
  for (const effort of ["", "  ", 42, null]) {
    assert.throws(
      () => parse(root, {}, [task({ provider: "codex", effort })]),
      /agent\.effort/,
    );
  }
});

test("a DSH non-default effort requires an explicit non-default model", (t) => {
  const root = project(t);
  assert.throws(
    () => parse(root, { agent: { provider: "dsh", effort: "high" } }, [task({})]),
    /DSH 非默认 effort 需要显式 agent\.model/,
  );
  // An inherited effort plus an explicit model is accepted.
  const [entry] = parse(
    root,
    { agent: { provider: "dsh", model: "gw/model", effort: "high" } },
    [task({})],
  );
  assert.equal(entry!.agent.effort, "high");
  // "default" needs no explicit model.
  const [plain] = parse(root, {}, [task({ provider: "dsh", effort: "default" })]);
  assert.equal(plain!.agent.effort, "default");
});

test("Codex forwards effort as one argv item and omits default/absent effort", async (t) => {
  const root = project(t);
  const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
  const suffix =
    process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
  const binary = path.join(
    root,
    "node_modules/@openai/codex-" + process.platform + "-" + process.arch,
    "vendor",
    cpu + "-" + suffix,
    "bin/codex",
  );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(root, "node_modules/@openai/codex-" + process.platform + "-" + process.arch, "package.json"),
    "{}",
  );
  fs.writeFileSync(
    binary,
    '#!/usr/bin/env node\nconst fs=require("fs");fs.readFileSync(0,"utf8");fs.writeFileSync("call.json",JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:"turn.completed"}));',
    { mode: 0o700 },
  );
  const previous = process.env.CLOUDCLI_HOST_ROOT;
  process.env.CLOUDCLI_HOST_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CLOUDCLI_HOST_ROOT;
    else process.env.CLOUDCLI_HOST_ROOT = previous;
  });
  const output = {
    stdout: () => {},
    stderr: () => {},
    event: () => {},
    child: () => {},
  };
  await runAgent({ provider: "codex", model: "gpt-x", effort: "high" }, "hi", root, output);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, "call.json"), "utf8")),
    [
      "exec",
      "--ephemeral",
      "--json",
      "--model",
      "gpt-x",
      "-c",
      'model_reasoning_effort="high"',
      "-",
    ],
  );
  await runAgent({ provider: "codex", model: "gpt-x", effort: "default" }, "hi", root, output);
  const plain = JSON.parse(
    fs.readFileSync(path.join(root, "call.json"), "utf8"),
  ) as string[];
  assert.equal(plain.includes("-c"), false);
  assert.equal(plain.includes('model_reasoning_effort="default"'), false);
  const quotedEffort = 'custom"\\level';
  await runAgent({ provider: "codex", model: "gpt-x", effort: quotedEffort }, "hi", root, output);
  const quotedArgs = JSON.parse(fs.readFileSync(path.join(root, "call.json"), "utf8")) as string[];
  const setting = quotedArgs[quotedArgs.indexOf("-c") + 1]!;
  assert.equal(JSON.parse(setting.slice("model_reasoning_effort=".length)), quotedEffort);
  await runAgent({ provider: "codex", model: "gpt-x" }, "hi", root, output);
  assert.equal(
    (JSON.parse(fs.readFileSync(path.join(root, "call.json"), "utf8")) as string[]).includes("-c"),
    false,
  );
});

test("DSH patch carries reasoningEffort only with an explicit model route", async (t) => {
  const root = project(t);
  const bin = path.join(root, "dsh");
  fs.writeFileSync(
    bin,
    '#!/usr/bin/env node\nconst fs=require("fs");const args=process.argv.slice(2);const file=args[args.lastIndexOf("--patch")+1];fs.writeFileSync("patch.json",JSON.stringify(JSON.parse(fs.readFileSync(file,"utf8"))));process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"final",text:"ok",reason:{kind:"completed"}})));',
    { mode: 0o700 },
  );
  const previousBin = process.env.CLOUDCLI_DSH_BIN;
  const previousPatches = process.env.CLOUDCLI_DSH_PATCHES;
  process.env.CLOUDCLI_DSH_BIN = bin;
  process.env.CLOUDCLI_DSH_PATCHES = "[]";
  t.after(() => {
    if (previousBin === undefined) delete process.env.CLOUDCLI_DSH_BIN;
    else process.env.CLOUDCLI_DSH_BIN = previousBin;
    if (previousPatches === undefined) delete process.env.CLOUDCLI_DSH_PATCHES;
    else process.env.CLOUDCLI_DSH_PATCHES = previousPatches;
  });
  const output = {
    stdout: () => {},
    stderr: () => {},
    event: () => {},
    child: () => {},
  };
  await runAgent(
    { provider: "dsh", model: "gw/model", effort: "high" },
    "hi",
    root,
    output,
  );
  const patch = JSON.parse(
    fs.readFileSync(path.join(root, "patch.json"), "utf8"),
  ) as Array<{ id: string; config?: Record<string, unknown> }>;
  assert.deepEqual(
    patch.find((row) => row.id === "agent-default-model")?.config,
    { provider: "gw", model: "model", reasoningEffort: "high" },
  );
  // Persistence and checkpoint disabling stay untouched and first.
  assert.deepEqual(patch.slice(0, 2), [
    { id: "session-persistence-jsonl", disabled: true },
    { id: "session-checkpoint-policy", disabled: true },
  ]);
  await runAgent(
    { provider: "dsh", model: "gw/model", effort: "default" },
    "hi",
    root,
    output,
  );
  const plain = JSON.parse(
    fs.readFileSync(path.join(root, "patch.json"), "utf8"),
  ) as Array<{ id: string; config?: Record<string, unknown> }>;
  assert.deepEqual(plain.find((row) => row.id === "agent-default-model")?.config, {
    provider: "gw",
    model: "model",
  });
  // Headless effort without a model is rejected before spawn.
  await assert.rejects(
    () =>
      runAgent(
        { provider: "dsh", model: "default", effort: "high" },
        "hi",
        root,
        output,
      ),
    /显式 agent\.model/,
  );
});
