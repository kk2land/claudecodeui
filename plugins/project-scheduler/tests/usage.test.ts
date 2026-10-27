import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../server/agent.js";
import { SchedulerStore } from "../server/store.js";
import {
  USAGE_DIRECTORY_ENV,
  UsageAccumulator,
  UsageSidecar,
  normalizeUsage,
  readUsageDirectory,
  sameUsage,
  sumUsage,
  tokenCount,
} from "../server/usage.js";
import type {
  SchedulerAgent,
  SchedulerRun,
  SchedulerTokenUsage,
} from "../shared/contracts.js";

function fixture(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cron-usage-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
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
/** Minimal host layout resolving the fake Codex binary, as the real host dependency would. */
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
  usageDirectory?: string,
) {
  const before = process.env[USAGE_DIRECTORY_ENV];
  if (usageDirectory) process.env[USAGE_DIRECTORY_ENV] = usageDirectory;
  try {
    const usage: Array<SchedulerTokenUsage | null> = [];
    const result = await runAgent(agent, "prompt", cwd, {
      stdout: () => {},
      stderr: () => {},
      event: () => {},
      child: () => {},
      usage: (value) => usage.push(value),
    });
    return { ...result, observed: usage };
  } finally {
    if (before === undefined) delete process.env[USAGE_DIRECTORY_ENV];
    else process.env[USAGE_DIRECTORY_ENV] = before;
  }
}

// --------------------------- Provider aggregation ---------------------------

test("Codex usage sums distinct turns and treats cached input as a reported subset", () => {
  const accumulator = new UsageAccumulator();
  // Turn 1 and turn 2 are separate model calls; their usage must be added, not replaced.
  assert.equal(
    accumulator.codex({
      type: "turn.completed",
      turn_id: "t1",
      usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 40 },
    }),
    true,
  );
  assert.equal(
    accumulator.codex({
      type: "turn.completed",
      turn_id: "t2",
      usage: { input_tokens: 50, output_tokens: 5, cached_input_tokens: 20 },
    }),
    true,
  );
  // A replayed turn id is one provider report, not another turn.
  assert.equal(
    accumulator.codex({
      type: "turn.completed",
      turn_id: "t2",
      usage: { input_tokens: 50, output_tokens: 5, cached_input_tokens: 20 },
    }),
    false,
  );
  // Non-terminal events carry no usage and must never add to the totals.
  assert.equal(
    accumulator.codex({ type: "turn.completed", usage: undefined }),
    false,
  );
  assert.equal(accumulator.codex({ type: "item.completed", item: {} }), false);
  assert.deepEqual(accumulator.usage, {
    inputTokens: 150,
    outputTokens: 15,
    cacheReadTokens: 60,
    // Codex reports no cache writes, so this stays unknown rather than a fake zero.
    cacheWriteTokens: null,
  });
});

test("Codex keeps a genuinely reported zero distinct from an unreported metric", () => {
  const accumulator = new UsageAccumulator();
  accumulator.codex({
    type: "turn.completed",
    usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
  });
  assert.deepEqual(accumulator.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: null,
  });
});

test("Codex malformed counters are unreported and never corrupted into numbers", () => {
  const accumulator = new UsageAccumulator();
  accumulator.codex({
    type: "turn.completed",
    usage: {
      input_tokens: "120",
      output_tokens: -3,
      cached_input_tokens: 1.5,
    },
  });
  // Every field was invalid, so nothing at all was reported for that turn.
  assert.equal(accumulator.usage, null);
  accumulator.codex({
    type: "turn.completed",
    usage: { input_tokens: 7, output_tokens: Number.POSITIVE_INFINITY },
  });
  assert.deepEqual(accumulator.usage, {
    inputTokens: 7,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });
  assert.equal(tokenCount(Number.NaN), null);
  assert.equal(tokenCount(Number.MAX_SAFE_INTEGER + 2), null);
  assert.equal(tokenCount(0), 0);
});

test("DSH sums each reported step once and ignores final summary totals", () => {
  const accumulator = new UsageAccumulator();
  const step = (
    stepId: string,
    usage: Record<string, number>,
    type = "status",
  ) =>
    accumulator.dsh({
      type,
      phase: "step_end",
      stepId,
      usage,
    });
  assert.equal(
    step("s1", {
      inputTokens: 20,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 2,
    }),
    true,
  );
  assert.equal(
    step("s2", {
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    }),
    true,
  );
  // A duplicate status frame for the same step must not be counted twice.
  assert.equal(
    step("s1", {
      inputTokens: 20,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 2,
    }),
    false,
  );
  // `final` carries a cumulative summary; adding it would double count the steps above.
  assert.equal(
    accumulator.dsh({
      type: "final",
      reason: { kind: "completed" },
      usage: {
        inputTokens: 30,
        outputTokens: 5,
        cacheReadTokens: 9,
        cacheWriteTokens: 2,
      },
    }),
    false,
  );
  assert.equal(accumulator.dsh({ type: "status", phase: "step_start" }), false);
  assert.deepEqual(accumulator.usage, {
    inputTokens: 30,
    outputTokens: 5,
    cacheReadTokens: 9,
    cacheWriteTokens: 2,
  });
});

test("DSH steps without ids are still counted once each, and absent metrics stay null", () => {
  const accumulator = new UsageAccumulator();
  const frame = { type: "status", phase: "step_end", usage: { inputTokens: 4 } };
  assert.equal(accumulator.dsh(frame), true);
  assert.equal(accumulator.dsh(frame), true);
  assert.deepEqual(accumulator.usage, {
    inputTokens: 8,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });
  // A step report with only one side of the cache remains a partial cache total.
  accumulator.dsh({
    type: "status",
    phase: "step_end",
    stepId: "s3",
    usage: { cacheReadTokens: 5 },
  });
  assert.deepEqual(accumulator.usage, {
    inputTokens: 8,
    outputTokens: null,
    cacheReadTokens: 5,
    cacheWriteTokens: null,
  });
});

test("usage snapshots combine without inventing missing metrics", () => {
  assert.equal(sumUsage(null, null), null);
  assert.deepEqual(
    sumUsage(
      { inputTokens: 3, outputTokens: null, cacheReadTokens: 1, cacheWriteTokens: null },
      { inputTokens: 4, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: 6 },
    ),
    { inputTokens: 7, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 6 },
  );
  assert.equal(
    sameUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 },
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 },
    ),
    true,
  );
  assert.equal(
    sameUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: null },
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 },
    ),
    false,
  );
  // Rejected foreign values normalize to null instead of entering a persisted record.
  assert.equal(normalizeUsage({ inputTokens: "1" }), null);
  assert.equal(normalizeUsage(null), null);
});

// --------------------------- Sidecar files ---------------------------

test("per-invocation sidecars sum without lost concurrent updates and skip damage", (t) => {
  const root = fixture(t);
  const directory = path.join(root, "usage");
  const first = new UsageSidecar(directory);
  const second = new UsageSidecar(directory);
  first.write({
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 4,
    cacheWriteTokens: null,
  });
  // A concurrent invocation writes its own file; neither update replaces the other.
  second.write({
    inputTokens: 5,
    outputTokens: 1,
    cacheReadTokens: null,
    cacheWriteTokens: 3,
  });
  assert.deepEqual(readUsageDirectory(directory), {
    inputTokens: 15,
    outputTokens: 3,
    cacheReadTokens: 4,
    cacheWriteTokens: 3,
  });
  fs.writeFileSync(path.join(directory, "broken.json"), "{not json");
  fs.writeFileSync(
    path.join(directory, "foreign.json"),
    JSON.stringify({ inputTokens: "many" }),
  );
  assert.deepEqual(readUsageDirectory(directory), {
    inputTokens: 15,
    outputTokens: 3,
    cacheReadTokens: 4,
    cacheWriteTokens: 3,
  });
  // Rewriting one invocation's snapshot is idempotent: files are snapshots, never deltas.
  first.write({
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 4,
    cacheWriteTokens: null,
  });
  assert.equal(readUsageDirectory(directory)?.inputTokens, 15);
  assert.equal(readUsageDirectory(path.join(root, "missing")), null);
});

// --------------------------- Streamed providers ---------------------------

test("runAgent reports and sidecars real Codex streamed usage across turns", async (t) => {
  const root = fixture(t);
  fakeCodex(
    root,
    [
      "const fs=require('fs');fs.readFileSync(0,'utf8');",
      "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:3,cached_input_tokens:5}}));",
      "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:8,output_tokens:2,cached_input_tokens:1}}));",
      "console.log(JSON.stringify({type:'final',text:'unrelated script text 9999',usage:{input_tokens:9999}}));",
    ].join(""),
  );
  environment(t, { CLOUDCLI_HOST_ROOT: root });
  const directory = path.join(root, "usage");
  const result = await execute(
    { provider: "codex", model: "default" },
    root,
    directory,
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.usage, {
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 6,
    cacheWriteTokens: null,
  });
  assert.deepEqual(result.observed.at(-1), result.usage);
  assert.deepEqual(readUsageDirectory(directory), result.usage);
});

test("runAgent reports DSH step usage and never counts its final summary twice", async (t) => {
  const root = fixture(t),
    bin = path.join(root, "dsh");
  fs.writeFileSync(
    bin,
    [
      "#!/usr/bin/env node\nprocess.stdin.resume();",
      "process.stdin.on('end',()=>{",
      "console.log(JSON.stringify({type:'status',phase:'step_end',stepId:'a',usage:{inputTokens:6,outputTokens:1,cacheReadTokens:2,cacheWriteTokens:3}}));",
      "console.log(JSON.stringify({type:'status',phase:'step_end',stepId:'b',usage:{inputTokens:4,outputTokens:2,cacheReadTokens:1,cacheWriteTokens:0}}));",
      "console.log(JSON.stringify({type:'status',phase:'step_end',stepId:'a',usage:{inputTokens:6,outputTokens:1,cacheReadTokens:2,cacheWriteTokens:3}}));",
      "console.log(JSON.stringify({type:'final',text:'done',reason:{kind:'completed'},usage:{inputTokens:10,outputTokens:3,cacheReadTokens:3,cacheWriteTokens:3}}));",
      "});",
    ].join(""),
    { mode: 0o700 },
  );
  environment(t, { CLOUDCLI_DSH_BIN: bin, CLOUDCLI_DSH_PATCHES: "[]" });
  const directory = path.join(root, "usage");
  const result = await execute(
    { provider: "dsh", model: "default" },
    root,
    directory,
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    outputTokens: 3,
    cacheReadTokens: 3,
    cacheWriteTokens: 3,
  });
  assert.deepEqual(readUsageDirectory(directory), result.usage);
});

test("runAgent keeps observed usage on a non-zero exit and reports null when unreported", async (t) => {
  const root = fixture(t),
    bin = path.join(root, "dsh");
  fs.writeFileSync(
    bin,
    "#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'status',phase:'step_end',stepId:'x',usage:{inputTokens:9,outputTokens:1}}));process.exitCode=2});",
    { mode: 0o700 },
  );
  environment(t, { CLOUDCLI_DSH_BIN: bin, CLOUDCLI_DSH_PATCHES: "[]" });
  const failed = await execute(
    { provider: "dsh", model: "default" },
    root,
    path.join(root, "usage"),
  );
  assert.equal(failed.success, false);
  assert.equal(failed.usage?.inputTokens, 9);

  fs.writeFileSync(
    bin,
    "#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'text',text:'no accounting'})));",
    { mode: 0o700 },
  );
  const unreported = await execute(
    { provider: "dsh", model: "default" },
    root,
    path.join(root, "usage-2"),
  );
  assert.equal(unreported.success, true);
  assert.equal(unreported.usage, null);
  assert.deepEqual(unreported.observed, []);
  assert.equal(readUsageDirectory(path.join(root, "usage-2")), null);
});

// --------------------------- Persistence ---------------------------

test("usage persists through the existing run JSON body and old runs stay absent", (t) => {
  const directory = fixture(t),
    store = new SchedulerStore(directory);
  t.after(() => store.close());
  const now = new Date().toISOString();
  const base = {
    projectId: "p",
    projectName: "project",
    taskId: "task",
    taskName: "task",
    status: "success" as const,
    trigger: "manual" as const,
    scheduledAt: now,
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    reason: null,
    workerPid: null,
    alertStatus: "none" as const,
    alertError: null,
    alertAttempts: 0,
  };
  const usage: SchedulerTokenUsage = {
    inputTokens: 1234,
    outputTokens: 56,
    cacheReadTokens: 700,
    cacheWriteTokens: null,
  };
  store.saveRun({ ...base, id: "with-usage", usage });
  // A run recorded before usage accounting has no field at all; the UI must render "—".
  store.saveRun({ ...(base as Omit<SchedulerRun, "id">), id: "legacy" });
  assert.deepEqual(store.run("with-usage")?.usage, usage);
  assert.equal(store.run("legacy")?.usage, undefined);
  assert.deepEqual(
    store.runs().find((run) => run.id === "with-usage")?.usage,
    usage,
  );
});
