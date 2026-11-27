import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  AGY_QUOTA_ARGS,
  AGY_QUOTA_POLL_INTERVAL_MS,
  parseAgyQuota,
  readAgyQuota,
} from "../server/agy-quota.js";
import { createService, temporaryRoot, waitFor } from "./helpers.js";

/** Real `agy -p /usage --output-format json` payload (plus an extra account field to prove stripping). */
const REAL_USAGE_OUTPUT = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response:
    "Gemini Models\tWeekly Limit Remaining\t92%\t2026-12-04T09:39:22Z\n" +
    "Gemini Models\tFive Hour Limit Remaining\t72%\t2026-11-27T14:39:22Z\n" +
    "Claude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z\n" +
    "Claude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z\n",
  duration_seconds: 0,
  num_turns: 0,
  account: { email: "secret-user@example.com", tier: "internal" },
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit.",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini 4 Neon",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              description: "You have used some of your weekly limit.",
              window: "weekly",
              remaining_fraction: 0.9235342741012573,
              reset_time: "2026-12-04T09:39:22Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.7226580381393433,
              reset_time: "2026-11-27T14:39:22Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
          ],
        },
      ],
    },
  },
});

function fakeAgy(
  root: string,
  body: string,
): { executable: string; capture: string } {
  const executable = path.join(root, "fake-agy-quota.mjs");
  const capture = path.join(root, "agy-quota-capture.jsonl");
  fs.writeFileSync(
    executable,
    "#!/usr/bin/env node\n" +
      "import fs from 'node:fs';\n" +
      "fs.appendFileSync(" +
      JSON.stringify(capture) +
      ", JSON.stringify({ argv: process.argv.slice(2), HOME: process.env.HOME ?? null, TOKEN: process.env.CLOUDCLI_PLUGIN_TOKEN ?? null }) + '\\n');\n" +
      body,
    { mode: 0o755 },
  );
  return { executable, capture };
}

test("parseAgyQuota keeps only display quota fields and normalizes epoch-0 resets", () => {
  assert.equal(AGY_QUOTA_POLL_INTERVAL_MS, 5 * 60 * 1000);
  const { groups, geminiExhausted } = parseAgyQuota(REAL_USAGE_OUTPUT);
  assert.equal(geminiExhausted, null);
  assert.deepEqual(groups, [
    {
      name: "Gemini Models",
      buckets: [
        {
          id: "gemini-weekly",
          window: "weekly",
          label: "Weekly Limit Remaining",
          remainingPercent: 92,
          resetAt: "2026-12-04T09:39:22Z",
        },
        {
          id: "gemini-5h",
          window: "5h",
          label: "Five Hour Limit Remaining",
          remainingPercent: 72,
          resetAt: "2026-11-27T14:39:22Z",
        },
      ],
    },
    {
      name: "Claude and GPT models",
      buckets: [
        {
          id: "3p-weekly",
          window: "weekly",
          label: "Weekly Limit Remaining",
          remainingPercent: 100,
          resetAt: null,
        },
        {
          id: "3p-5h",
          window: "5h",
          label: "Five Hour Limit Remaining",
          remainingPercent: 100,
          resetAt: null,
        },
      ],
    },
  ]);
  const serialized = JSON.stringify(groups);
  assert.equal(serialized.includes("secret-user@example.com"), false);
  assert.equal(serialized.includes("internal"), false);
});

test("parseAgyQuota evaluates Gemini Models exhaustion from raw remaining_fraction only", () => {
  const usageJson = (groups: unknown[]) =>
    JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups } } });

  // Sub-0.5% positive quota displays as 0% but must not be marked exhausted.
  const tinyPositive = parseAgyQuota(
    usageJson([
      {
        name: "Gemini Models",
        buckets: [
          { window: "5h", remaining_fraction: 0.004, reset_time: "2026-11-27T14:39:22Z" },
        ],
      },
      {
        name: "Claude and GPT models",
        buckets: [
          { window: "weekly", remaining_fraction: 0, reset_time: "2026-12-04T09:39:22Z" },
        ],
      },
    ]),
  );
  assert.equal(tinyPositive.groups[0]?.buckets[0]?.remainingPercent, 0);
  assert.equal(tinyPositive.geminiExhausted, null);

  // When two Gemini Models windows are exhausted, pick the latest valid reset_time.
  const dualExhausted = parseAgyQuota(
    usageJson([
      {
        name: "Gemini Models",
        buckets: [
          { window: "5h", remaining_fraction: 0, reset_time: "2026-11-27T14:39:22Z" },
          { window: "weekly", remaining_fraction: 0, reset_time: "2026-12-04T09:39:22Z" },
          { window: "monthly", remaining_fraction: 0.5, reset_time: "2027-01-01T00:00:00Z" },
        ],
      },
    ]),
  );
  assert.deepEqual(dualExhausted.geminiExhausted, {
    latestResetAtMs: Date.parse("2026-12-04T09:39:22Z"),
  });

  // Exhausted window with epoch-0 reset yields null so service falls back to default delay.
  const noReset = parseAgyQuota(
    usageJson([
      {
        name: "Gemini Models",
        buckets: [
          { window: "monthly", remaining_fraction: 0, reset_time: "1970-01-01T00:00:00Z" },
        ],
      },
    ]),
  );
  assert.deepEqual(noReset.geminiExhausted, { latestResetAtMs: null });
});

test("parseAgyQuota rejects malformed, non-success, or unexpected CLI JSON", () => {
  assert.throws(() => parseAgyQuota(""), /为空/);
  assert.throws(() => parseAgyQuota("not json"), /无法解析/);
  assert.throws(
    () =>
      parseAgyQuota(
        JSON.stringify({ status: "ERROR", error: "RAW_SECRET_PATH" }),
      ),
    (error: Error) => {
      assert.match(error.message, /未成功/);
      assert.equal(error.message.includes("RAW_SECRET_PATH"), false);
      return true;
    },
  );
  assert.throws(
    () =>
      parseAgyQuota(
        JSON.stringify({ status: "SUCCESS", command: { name: "other", data: {} } }),
      ),
    /结构无效/,
  );
  assert.throws(
    () =>
      parseAgyQuota(
        JSON.stringify({
          status: "SUCCESS",
          command: {
            name: "usage",
            data: { groups: [{ name: "G", buckets: [{ remaining_fraction: "bad" }] }] },
          },
        }),
      ),
    /结构无效/,
  );
});

test("WorkerService polls AGY quota on startup and interval, supports manual refresh, and strips plugin tokens", async (t) => {
  const root = temporaryRoot("worker-agy-quota-poll-");
  const counterFile = path.join(root, "count.txt");
  const { executable, capture } = fakeAgy(
    root,
    "const count = (fs.existsSync(" +
      JSON.stringify(counterFile) +
      ") ? Number(fs.readFileSync(" +
      JSON.stringify(counterFile) +
      ", 'utf8')) : 0) + 1;\n" +
      "fs.writeFileSync(" +
      JSON.stringify(counterFile) +
      ", String(count));\n" +
      "const fraction = Math.max(0.1, 1 - count * 0.1);\n" +
      "process.stdout.write(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: fraction, reset_time: '2026-11-27T14:39:22Z' }] }] } } }));\n",
  );
  const { service, env } = createService(
    t,
    root,
    { CLOUDCLI_PLUGIN_TOKEN: "plugin-secret" },
    { executablePaths: { agy: executable }, agyQuotaPollIntervalMs: 80 },
  );

  // Startup recovery triggers the initial fetch and periodic polling.
  service.recoverFromDisk();
  const initial = await service.agyQuota();
  assert.equal(initial.status, "ready");
  assert.equal(initial.groups[0]?.buckets[0]?.remainingPercent, 90);
  assert.ok(initial.updatedAt);

  // Periodic polling updates the cached snapshot automatically without manual refresh.
  await waitFor(
    () => Number(fs.existsSync(counterFile) ? fs.readFileSync(counterFile, "utf8") : "0"),
    (count) => count >= 2,
    5000,
  );
  const polled = await service.agyQuota();
  assert.equal(polled.status, "ready");
  assert.ok((polled.groups[0]?.buckets[0]?.remainingPercent ?? 100) <= 80);

  // Manual refresh triggers the exact fixed command immediately and advances the result.
  const beforeCount = Number(fs.readFileSync(counterFile, "utf8"));
  const refreshed = await service.refreshAgyQuota();
  const afterCount = Number(fs.readFileSync(counterFile, "utf8"));
  assert.equal(refreshed.status, "ready");
  assert.ok(afterCount >= beforeCount + 1);

  const lines = fs
    .readFileSync(capture, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { argv: string[]; HOME: string | null; TOKEN: string | null });
  assert.ok(lines.length >= 2);
  for (const call of lines) {
    assert.deepEqual(call.argv, [...AGY_QUOTA_ARGS]);
    assert.equal(call.HOME, env.HOME);
    assert.equal(call.TOKEN, null);
  }
});

test("AGY quota failures preserve last known values, hide stderr, and recover on manual refresh", async (t) => {
  const root = temporaryRoot("worker-agy-quota-fail-");
  const modeFile = path.join(root, "mode.txt");
  fs.writeFileSync(modeFile, "ok");
  const { executable } = fakeAgy(
    root,
    "const mode = fs.readFileSync(" +
      JSON.stringify(modeFile) +
      ", 'utf8').trim();\n" +
      "if (mode === 'fail') { process.stderr.write('SENSITIVE_STDERR_PATH\\n'); process.exitCode = 1; }\n" +
      "else { process.stdout.write(" +
      JSON.stringify(REAL_USAGE_OUTPUT) +
      "); }\n",
  );
  const { service } = createService(
    t,
    root,
    {},
    { executablePaths: { agy: executable } },
  );

  const first = await service.refreshAgyQuota();
  assert.equal(first.status, "ready");
  assert.equal(first.groups[0]?.buckets[0]?.remainingPercent, 92);

  fs.writeFileSync(modeFile, "fail");
  const failed = await service.refreshAgyQuota();
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /查询失败/);
  assert.equal((failed.error ?? "").includes("SENSITIVE_STDERR_PATH"), false);
  // Last known values remain available alongside the error state.
  assert.equal(failed.groups[0]?.buckets[0]?.remainingPercent, 92);
  assert.equal(failed.updatedAt, first.updatedAt);

  fs.writeFileSync(modeFile, "ok");
  const recovered = await service.refreshAgyQuota();
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.error, null);
  assert.equal(recovered.groups[0]?.buckets[0]?.remainingPercent, 92);
});

test("AGY quota retries manually and on its timer after startup cannot find agy", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = temporaryRoot("worker-agy-quota-missing-");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const { service } = createService(t, root, { PATH: bin }, { executablePaths: {} });

  service.recoverFromDisk();
  const missing = await service.agyQuota();
  assert.equal(missing.status, "error");
  assert.match(missing.error ?? "", /PATH 中找不到可执行文件: agy/);

  const { executable, capture } = fakeAgy(
    root,
    "process.stdout.write(" + JSON.stringify(REAL_USAGE_OUTPUT) + ");\n",
  );
  fs.writeFileSync(
    path.join(bin, "agy"),
    `#!/bin/sh\nexec "${process.execPath}" "${executable}" "$@"\n`,
    { mode: 0o755 },
  );

  const manual = await service.refreshAgyQuota();
  assert.equal(manual.status, "ready");
  assert.equal(manual.groups[0]?.buckets[0]?.remainingPercent, 92);
  assert.equal(fs.readFileSync(capture, "utf8").trim().split("\n").length, 1);

  t.mock.timers.tick(AGY_QUOTA_POLL_INTERVAL_MS);
  assert.equal((await service.agyQuota()).status, "ready");
  assert.equal(fs.readFileSync(capture, "utf8").trim().split("\n").length, 2);
});

test("agyQuota awaits an in-flight refresh even when an older cached snapshot exists", async (t) => {
  const root = temporaryRoot("worker-agy-quota-overlap-");
  const counterFile = path.join(root, "count.txt");
  const releaseFile = path.join(root, "release.txt");
  const startedSecond = path.join(root, "second-started.txt");
  const { executable } = fakeAgy(
    root,
    "const count = (fs.existsSync(" +
      JSON.stringify(counterFile) +
      ") ? Number(fs.readFileSync(" +
      JSON.stringify(counterFile) +
      ", 'utf8')) : 0) + 1;\n" +
      "fs.writeFileSync(" +
      JSON.stringify(counterFile) +
      ", String(count));\n" +
      "const emit = (fraction) => process.stdout.write(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: fraction, reset_time: '2026-11-27T14:39:22Z' }] }] } } }));\n" +
      "if (count === 1) { emit(0.9); }\n" +
      "else {\n" +
      "  fs.writeFileSync(" +
      JSON.stringify(startedSecond) +
      ", '1');\n" +
      "  const timer = setInterval(() => {\n" +
      "    if (fs.existsSync(" +
      JSON.stringify(releaseFile) +
      ")) { clearInterval(timer); emit(0.55); }\n" +
      "  }, 15);\n" +
      "}\n",
  );
  const { service } = createService(
    t,
    root,
    {},
    { executablePaths: { agy: executable } },
  );

  // Populate an initial cached `ready` snapshot.
  const first = await service.refreshAgyQuota();
  assert.equal(first.status, "ready");
  assert.equal(first.groups[0]?.buckets[0]?.remainingPercent, 90);

  // Start a second refresh that stays in-flight; concurrent `agyQuota()` must await the same result.
  const refreshPromise = service.refreshAgyQuota();
  await waitFor(() => fs.existsSync(startedSecond), (ok) => ok, 5000);
  const readPromise = service.agyQuota();
  fs.writeFileSync(releaseFile, "go");

  const [refreshed, read] = await Promise.all([refreshPromise, readPromise]);
  assert.equal(refreshed.groups[0]?.buckets[0]?.remainingPercent, 55);
  assert.equal(read.groups[0]?.buckets[0]?.remainingPercent, 55);
  assert.equal(Number(fs.readFileSync(counterFile, "utf8")), 2);
});

test("readAgyQuota aborts promptly when signalled on shutdown", async () => {
  const root = temporaryRoot("worker-agy-quota-abort-");
  const { executable } = fakeAgy(root, "setTimeout(() => {}, 30000);\n");
  const controller = new AbortController();
  const started = Date.now();
  const promise = readAgyQuota(executable, { PATH: process.env.PATH }, {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(() => promise, /超时/);
  assert.ok(Date.now() - started < 5000);
  fs.rmSync(root, { recursive: true, force: true });
});
