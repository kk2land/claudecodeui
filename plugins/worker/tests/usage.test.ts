import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  codexBaseline,
  parseCodex,
  parseDsh,
  parsePi,
} from "../server/native.js";
import type { WorkerCodexUsageBaseline } from "../shared/contracts.js";
import { temporaryRoot } from "./helpers.js";

function eventsFile(root: string, name: string, events: unknown[]): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return file;
}

function rolloutLine(total: Record<string, number>, last = total): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last },
    },
  }) + "\n";
}

const cwd = "/tmp/usage-project";

test("DSH accumulates cache fields per sample and uses same-sample fallback total", () => {
  const root = temporaryRoot("worker-usage-dsh-");
  const file = eventsFile(root, "events.log", [
    { type: "session", sessionId: "session-1", cwd },
    {
      type: "status",
      phase: "step_end",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 20,
      },
    },
    {
      type: "status",
      phase: "step_end",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    { type: "status", phase: "turn_end", reason: { kind: "completed" } },
    { type: "final", text: "done" },
  ]);
  assert.deepEqual(parseDsh(file, "session-1", cwd, root).usage, {
    inputTokens: 11,
    outputTokens: 6,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    totalTokens: 22,
    scope: "run",
    partial: false,
  });
});

test("DSH keeps known subtotals and marks partial when one sample lacks counters", () => {
  const root = temporaryRoot("worker-usage-dsh-partial-");
  const file = eventsFile(root, "events.log", [
    { type: "session", sessionId: "session-1", cwd },
    {
      type: "status",
      phase: "step_end",
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 },
    },
    { type: "status", phase: "step_end", usage: { inputTokens: 1, outputTokens: 1 } },
    { type: "status", phase: "turn_end", reason: { kind: "completed" } },
    { type: "final", text: "done" },
  ]);
  assert.deepEqual(parseDsh(file, "session-1", cwd, root).usage, {
    inputTokens: 5,
    outputTokens: 3,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    totalTokens: null,
    scope: "run",
    partial: true,
  });
});

test("DSH keeps a native total reported without any other counter", () => {
  const root = temporaryRoot("worker-usage-dsh-total-only-");
  const file = eventsFile(root, "events.log", [
    { type: "session", sessionId: "session-1", cwd },
    { type: "status", phase: "step_end", usage: { totalTokens: 9 } },
    { type: "status", phase: "turn_end", reason: { kind: "completed" } },
    { type: "final", text: "done" },
  ]);
  assert.deepEqual(parseDsh(file, "session-1", cwd, root).usage, {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 9,
    scope: "run",
    partial: true,
  });
});

test("Pi samples assistant message_end once and ignores turn_end usage", () => {
  const root = temporaryRoot("worker-usage-pi-");
  const file = eventsFile(root, "events.log", [
    { type: "session", id: "pi-session", cwd },
    { type: "agent_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "answer" }],
        usage: {
          input: 7,
          output: 3,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 13,
        },
      },
    },
    { type: "turn_end", message: { usage: { input: 99, output: 99, totalTokens: 198 } } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled", aborted: false },
  ]);
  const parsed = parsePi(file, "pi-session", cwd, file);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.usage, {
    inputTokens: 7,
    outputTokens: 3,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    totalTokens: 13,
    scope: "run",
    partial: false,
  });
});

test("Pi keeps completed model usage when cancelled during a later tool stage", () => {
  const root = temporaryRoot("worker-usage-pi-cancel-");
  const file = eventsFile(root, "events.log", [
    { type: "session", id: "pi-session", cwd },
    { type: "agent_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "model done" }],
        usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
      },
    },
  ]);
  const parsed = parsePi(file, "pi-session", cwd, file);
  assert.equal(parsed.success, false);
  assert.deepEqual(parsed.usage, {
    inputTokens: 5,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 7,
    scope: "run",
    partial: true,
  });
});

test("Codex takes the last cumulative snapshot and diffs a trusted baseline", () => {
  const root = temporaryRoot("worker-usage-codex-diff-");
  const usage = (input: number, output: number, read: number, write: number) => ({
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: read,
    cache_write_input_tokens: write,
  });
  const file = eventsFile(root, "events.log", [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.completed", usage: usage(100, 50, 20, 10) },
    { type: "turn.completed", usage: usage(111, 55, 24, 12) },
  ]);
  const baseline: WorkerCodexUsageBaseline = {
    counters: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 150,
    },
    offset: 0,
  };
  const parsed = parseCodex(file, "thread-1", {
    baseline,
    sessionFile: null,
    sessionsRoot: root,
  });
  assert.deepEqual(parsed.usage, {
    inputTokens: 11,
    outputTokens: 5,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
    totalTokens: 16,
    scope: "run",
    partial: false,
  });
});

test("Codex marks session scope for missing or incompatible baselines", () => {
  const root = temporaryRoot("worker-usage-codex-session-");
  const emit = (usage: Record<string, number>) =>
    eventsFile(root, "events.log", [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.completed", usage },
    ]);
  const usage = {
    input_tokens: 11,
    output_tokens: 5,
    cached_input_tokens: 4,
    cache_write_input_tokens: 2,
  };
  assert.deepEqual(
    parseCodex(emit(usage), "thread-1", {
      baseline: { counters: null, offset: 0 },
      sessionFile: null,
      sessionsRoot: root,
    }).usage,
    {
      inputTokens: 11,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      totalTokens: 16,
      scope: "session",
      partial: true,
    },
  );
  // A negative diff is incompatible, so the whole session snapshot is preserved.
  assert.deepEqual(
    parseCodex(emit(usage), "thread-1", {
      baseline: {
        counters: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          totalTokens: 150,
        },
        offset: 0,
      },
      sessionFile: null,
      sessionsRoot: root,
    }).usage,
    {
      inputTokens: 11,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      totalTokens: 16,
      scope: "session",
      partial: true,
    },
  );
  // Known fields still diff individually; a missing field stays unknown instead of taking the
  // session cumulative value.
  assert.deepEqual(
    parseCodex(emit({ input_tokens: 11, output_tokens: 5 }), "thread-1", {
      baseline: {
        counters: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        },
        offset: 0,
      },
      sessionFile: null,
      sessionsRoot: root,
    }).usage,
    {
      inputTokens: 11,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 16,
      scope: "run",
      partial: true,
    },
  );
});

test("Codex diffs each known field independently and leaves unknown fields null", () => {
  const root = temporaryRoot("worker-usage-codex-partial-diff-");
  const file = eventsFile(root, "events.log", [
    { type: "thread.started", thread_id: "thread-1" },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 130,
        output_tokens: 30,
        cached_input_tokens: 60,
      },
    },
  ]);
  const parsed = parseCodex(file, "thread-1", {
    baseline: {
      counters: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: null,
        totalTokens: 120,
      },
      offset: 0,
    },
    sessionFile: null,
    sessionsRoot: root,
  });
  assert.deepEqual(parsed.usage, {
    inputTokens: 30,
    outputTokens: 10,
    cacheReadTokens: 10,
    cacheWriteTokens: null,
    totalTokens: 40,
    scope: "run",
    partial: true,
  });
});

test("Codex ignores empty snapshots after a valid cumulative report", () => {
  const root = temporaryRoot("worker-usage-codex-empty-");
  const file = eventsFile(root, "events.log", [
    { type: "thread.started", thread_id: "thread-1" },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 11,
        output_tokens: 5,
        cached_input_tokens: 4,
        cache_write_input_tokens: 2,
      },
    },
    { type: "turn.completed", usage: {} },
    { type: "turn.completed", usage: { input_tokens: "bad", output_tokens: -1 } },
  ]);
  assert.deepEqual(
    parseCodex(file, "thread-1", {
      baseline: {
        counters: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        },
        offset: 0,
      },
      sessionFile: null,
      sessionsRoot: root,
    }).usage,
    {
      inputTokens: 11,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      totalTokens: 16,
      scope: "run",
      partial: false,
    },
  );
});

test("Codex accepts a snapshot with only a cache counter known", () => {
  const root = temporaryRoot("worker-usage-codex-cache-only-");
  const file = eventsFile(root, "events.log", [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.completed", usage: { cached_input_tokens: 4 } },
  ]);
  assert.deepEqual(
    parseCodex(file, "thread-1", {
      baseline: {
        counters: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        },
        offset: 0,
      },
      sessionFile: null,
      sessionsRoot: root,
    }).usage,
    {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: 4,
      cacheWriteTokens: null,
      totalTokens: null,
      scope: "run",
      partial: true,
    },
  );
});

test("Codex mismatch keeps only actual stdout session scope", () => {
  const root = temporaryRoot("worker-usage-codex-mismatch-");
  const file = eventsFile(root, "events.log", [
    { type: "thread.started", thread_id: "thread-actual" },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 11,
        output_tokens: 5,
        cached_input_tokens: 4,
        cache_write_input_tokens: 2,
      },
    },
  ]);
  const parsed = parseCodex(file, "thread-requested", {
    baseline: {
      counters: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      },
      offset: 0,
    },
    sessionFile: null,
    sessionsRoot: root,
  });
  assert.equal(parsed.success, false);
  assert.equal(parsed.nativeSessionId, null);
  assert.equal(parsed.nativeSessionFile, null);
  assert.deepEqual(parsed.usage, {
    inputTokens: 11,
    outputTokens: 5,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
    totalTokens: 16,
    scope: "session",
    partial: true,
  });
  const noSnapshot = eventsFile(root, "no-snapshot.log", [
    { type: "thread.started", thread_id: "thread-actual" },
    { type: "turn.failed", error: { message: "boom" } },
  ]);
  assert.equal(
    parseCodex(noSnapshot, "thread-requested", {
      baseline: { counters: null, offset: 0 },
      sessionFile: path.join(root, "other-thread.jsonl"),
      sessionsRoot: root,
    }).usage,
    null,
  );
});

test("Codex failure reads only token reports after the launch offset", () => {
  const root = temporaryRoot("worker-usage-codex-failure-");
  const events = eventsFile(root, "events.log", [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.failed", error: { message: "boom" } },
  ]);
  const rollout = path.join(root, "thread-1.jsonl");
  fs.writeFileSync(
    rollout,
    rolloutLine({ input_tokens: 100, output_tokens: 50, cached_input_tokens: 20, cache_write_input_tokens: 10, total_tokens: 200 }),
  );
  const offset = fs.statSync(rollout).size;
  fs.appendFileSync(
    rollout,
    rolloutLine({ input_tokens: 107, output_tokens: 52, cached_input_tokens: 21, cache_write_input_tokens: 11, total_tokens: 209 }),
  );
  const baseline: WorkerCodexUsageBaseline = {
    counters: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 200,
    },
    offset,
  };
  const parsed = parseCodex(events, "thread-1", {
    baseline,
    sessionFile: rollout,
    sessionsRoot: root,
  });
  assert.deepEqual(parsed.usage, {
    inputTokens: 7,
    outputTokens: 2,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    totalTokens: 9,
    scope: "run",
    partial: true,
  });
  const noReport = eventsFile(root, "no-report.log", [
    { type: "thread.started", thread_id: "thread-2" },
    { type: "turn.failed", error: { message: "boom" } },
  ]);
  assert.equal(
    parseCodex(noReport, "thread-2", {
      baseline: { counters: null, offset: 0 },
      sessionFile: path.join(root, "missing.jsonl"),
      sessionsRoot: root,
    }).usage,
    null,
  );
  // Legacy/no-baseline failures must not claim the old session rollout as this run's usage.
  assert.equal(
    parseCodex(noReport, "thread-2", {
      baseline: null,
      sessionFile: rollout,
      sessionsRoot: root,
    }).usage,
    null,
  );
});

test("Codex prefers a reported native total over input plus output", () => {
  const root = temporaryRoot("worker-usage-codex-native-total-");
  const context = {
    baseline: { counters: null, offset: 0 },
    sessionFile: null,
    sessionsRoot: root,
  };
  const parsed = parseCodex(
    eventsFile(root, "native-total.log", [
      { type: "thread.started", thread_id: "thread-1" },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 2,
          cache_write_input_tokens: 1,
          total_tokens: 999,
        },
      },
    ]),
    "thread-1",
    context,
  );
  assert.equal(parsed.usage?.totalTokens, 999);
  const totalOnly = parseCodex(
    eventsFile(root, "total-only.log", [
      { type: "thread.started", thread_id: "thread-2" },
      { type: "turn.completed", usage: { total_tokens: 42 } },
    ]),
    "thread-2",
    context,
  );
  assert.equal(totalOnly.usage?.inputTokens, null);
  assert.equal(totalOnly.usage?.totalTokens, 42);
});

test("Codex baseline takes the last total snapshot and the EOF offset", () => {
  const root = temporaryRoot("worker-usage-codex-baseline-");
  const rollout = path.join(root, "rollout.jsonl");
  fs.writeFileSync(
    rollout,
    rolloutLine({ input_tokens: 10, output_tokens: 2, cached_input_tokens: 1, cache_write_input_tokens: 0, total_tokens: 20 }) +
      rolloutLine({ input_tokens: 30, output_tokens: 5, cached_input_tokens: 4, cache_write_input_tokens: 1, total_tokens: 40 }),
  );
  const baseline = codexBaseline(rollout);
  assert.deepEqual(baseline, {
    counters: {
      inputTokens: 30,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      totalTokens: 40,
    },
    offset: fs.statSync(rollout).size,
  });
  assert.deepEqual(codexBaseline(path.join(root, "missing.jsonl")), {
    counters: null,
    offset: 0,
  });
});

test("Pi preserves zero counters and uses same-sample fallback totals", () => {
  const root = temporaryRoot("worker-usage-pi-zero-");
  const file = eventsFile(root, "events.log", [
    { type: "session", id: "pi-session", cwd },
    { type: "agent_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "first" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "second" }],
        usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      },
    },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled", aborted: false },
  ]);
  assert.deepEqual(parsePi(file, "pi-session", cwd, file).usage, {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    totalTokens: 4,
    scope: "run",
    partial: false,
  });
});

test("Pi keeps known counters and marks partial when cache fields are absent", () => {
  const root = temporaryRoot("worker-usage-pi-missing-");
  const file = eventsFile(root, "events.log", [
    { type: "session", id: "pi-session", cwd },
    { type: "agent_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "answer" }],
        usage: { input: 3, output: 2 },
      },
    },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled", aborted: false },
  ]);
  assert.deepEqual(parsePi(file, "pi-session", cwd, file).usage, {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    scope: "run",
    partial: true,
  });
});

test("Codex supplements missing stdout total from aligned same-run rollout evidence", () => {
  const root = temporaryRoot("worker-usage-codex-supplement-");
  const rollout = path.join(root, "thread-1.jsonl");
  fs.writeFileSync(
    rollout,
    rolloutLine({ input_tokens: 11, output_tokens: 50, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 70 }),
  );
  const offset = fs.statSync(rollout).size;
  fs.appendFileSync(
    rollout,
    rolloutLine({ input_tokens: 18, output_tokens: 80, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 110 }),
  );
  const file = eventsFile(root, "events.log", [
    { type: "thread.started", thread_id: "thread-1" },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 18,
        output_tokens: 80,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
      },
    },
  ]);
  const parsed = parseCodex(file, "thread-1", {
    baseline: {
      counters: {
        inputTokens: 11,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 70,
      },
      offset,
    },
    sessionFile: rollout,
    sessionsRoot: root,
  });
  assert.deepEqual(parsed.usage, {
    inputTokens: 7,
    outputTokens: 30,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 40,
    scope: "run",
    partial: false,
  });
});

test("Codex does not use mismatched, stale, or cache-conflicting rollout totals", () => {
  const root = temporaryRoot("worker-usage-codex-mismatch-total-");
  const baseline = {
    counters: {
      inputTokens: 11,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 70,
    },
    offset: 0,
  };
  const make = (name: string, rolloutTotal: Record<string, number>) => {
    const rollout = path.join(root, name + ".jsonl");
    fs.writeFileSync(
      rollout,
      rolloutLine({ input_tokens: 11, output_tokens: 50, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 70 }),
    );
    const offset = fs.statSync(rollout).size;
    fs.appendFileSync(rollout, rolloutLine(rolloutTotal));
    const events = eventsFile(root, name + ".log", [
      { type: "thread.started", thread_id: "thread-1" },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 18,
          output_tokens: 80,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
        },
      },
    ]);
    return parseCodex(events, "thread-1", {
      baseline: { ...baseline, offset },
      sessionFile: rollout,
      sessionsRoot: root,
    }).usage;
  };
  // Input/output mismatch: the older rollout total must not be attached to this stdout.
  assert.deepEqual(
    make("stale", { input_tokens: 18, output_tokens: 79, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 110 }),
    {
      inputTokens: 7,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 37,
      scope: "run",
      partial: false,
    },
  );
  // Common cache fields disagree, so the total is not aligned evidence.
  assert.deepEqual(
    make("cache-conflict", { input_tokens: 18, output_tokens: 80, cached_input_tokens: 5, cache_write_input_tokens: 0, total_tokens: 110 }),
    {
      inputTokens: 7,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 37,
      scope: "run",
      partial: false,
    },
  );
});

test("Codex trusts a persisted baseline total only when raw rollout evidence confirms it", () => {
  const root = temporaryRoot("worker-usage-codex-old-baseline-");
  const baselineCounters = {
    inputTokens: 11,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 70,
  };
  const run = (name: string, evidenceTotal: number | null, storedTotal = 70) => {
    const rollout = path.join(root, name + ".jsonl");
    const raw = {
      input_tokens: 11,
      output_tokens: 50,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      ...(evidenceTotal === null ? {} : { total_tokens: evidenceTotal }),
    };
    fs.writeFileSync(rollout, rolloutLine(raw));
    const offset = fs.statSync(rollout).size;
    fs.appendFileSync(
      rollout,
      rolloutLine({ input_tokens: 18, output_tokens: 80, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 110 }),
    );
    const events = eventsFile(root, name + ".log", [
      { type: "thread.started", thread_id: "thread-1" },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 18,
          output_tokens: 80,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
        },
      },
    ]);
    return parseCodex(events, "thread-1", {
      baseline: {
        counters: { ...baselineCounters, totalTokens: storedTotal },
        offset,
      },
      sessionFile: rollout,
      sessionsRoot: root,
    }).usage;
  };
  assert.equal(run("confirmed", 70)?.totalTokens, 40);
  assert.equal(run("unconfirmed", null)?.totalTokens, 37);
  // A stored baseline total that the raw pre-offset rollout does not confirm is not derived
  // evidence: the run total must still come from this run's input/output, never 110 - 61.
  assert.equal(run("derived", null, 61)?.totalTokens, 37);
});

test("Codex keeps a native total-only snapshot and derives only confirmed run totals", () => {
  const root = temporaryRoot("worker-usage-codex-total-only-");
  const zeroBaseline = {
    counters: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    offset: 0,
  };
  const parsed = (usage: Record<string, unknown>) =>
    parseCodex(
      eventsFile(root, "events.log", [
        { type: "thread.started", thread_id: "thread-1" },
        { type: "turn.completed", usage },
      ]),
      "thread-1",
      { baseline: zeroBaseline, sessionFile: null, sessionsRoot: root },
    ).usage;
  assert.deepEqual(parsed({ total_tokens: 9 }), {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 9,
    scope: "run",
    partial: true,
  });
  assert.deepEqual(parsed({ input_tokens: 5, total_tokens: 9 }), {
    inputTokens: 5,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 9,
    scope: "run",
    partial: true,
  });
  assert.deepEqual(parsed({ total_tokens: 0 }), {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 0,
    scope: "run",
    partial: true,
  });
});

test("Codex failure increments never mix partial native totals with derived totals", () => {
  const root = temporaryRoot("worker-usage-codex-increments-");
  const increment = (last: Record<string, number>) =>
    JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: last } },
    }) + "\n";
  const run = (name: string, rollout: string) => {
    const events = eventsFile(root, name + ".log", [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.failed", error: { message: "boom" } },
    ]);
    return parseCodex(events, "thread-1", {
      baseline: {
        counters: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        },
        offset: 0,
      },
      sessionFile: rollout,
      sessionsRoot: root,
    }).usage;
  };
  const mixed = path.join(root, "mixed.jsonl");
  // The first sample reports a native total (70) and the second does not. The aggregate must
  // stay on a single basis: all input/output increments (9), never 70 mixed with derived increments.
  fs.writeFileSync(
    mixed,
    increment({ input_tokens: 5, output_tokens: 2, total_tokens: 70 }) +
      increment({ input_tokens: 1, output_tokens: 1 }),
  );
  assert.deepEqual(run("mixed", mixed), {
    inputTokens: 6,
    outputTokens: 3,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 9,
    scope: "run",
    partial: true,
  });
  const nativeOnly = path.join(root, "native-only.jsonl");
  fs.writeFileSync(
    nativeOnly,
    increment({ input_tokens: 1, output_tokens: 1, total_tokens: 5 }) +
      increment({ input_tokens: 2, output_tokens: 1, total_tokens: 7 }),
  );
  assert.deepEqual(run("native-only", nativeOnly), {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 12,
    scope: "run",
    partial: true,
  });
  const incomparable = path.join(root, "incomparable.jsonl");
  fs.writeFileSync(
    incomparable,
    increment({ input_tokens: 5, output_tokens: 2, total_tokens: 7 }) +
      increment({ input_tokens: 1 }),
  );
  assert.deepEqual(run("incomparable", incomparable), {
    inputTokens: 6,
    outputTokens: 2,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    scope: "run",
    partial: true,
  });
});
