#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const scenario = process.env.TEST_SCENARIO || "ok";
const args = process.argv.slice(2);
const resumeAt = args.indexOf("resume");
const resumedId = resumeAt >= 0 ? args[resumeAt + 1] : null;
const sessionId =
  resumedId || process.env.TEST_SESSION_ID || randomUUID();
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const sessions = path.join(codexHome, "sessions");
const sessionFile = path.join(sessions, sessionId + ".jsonl");
fs.mkdirSync(sessions, { recursive: true });

const prompt = fs.readFileSync(0, "utf8");
if (process.env.TEST_PID_FILE)
  fs.writeFileSync(process.env.TEST_PID_FILE, String(process.pid));
if (process.env.TEST_CAPTURE_FILE) {
  fs.writeFileSync(
    process.env.TEST_CAPTURE_FILE,
    JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      prompt,
      env: {
        CODEX_HOME: process.env.CODEX_HOME,
        CODEX_PROXY_BYPASS: process.env.CODEX_PROXY_BYPASS,
        TEST_CODEX_CUSTOM: process.env.TEST_CODEX_CUSTOM,
        SECRET_TOKEN: process.env.SECRET_TOKEN,
        CLOUDCLI_PLUGIN_TOKEN: process.env.CLOUDCLI_PLUGIN_TOKEN,
        PATH: process.env.PATH,
      },
    }),
  );
}

const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (resumeAt >= 0 && !fs.existsSync(sessionFile)) {
  process.stderr.write("fixture missing session " + sessionId + "\n");
  process.exit(1);
}
if (resumeAt < 0)
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({ thread_id: sessionId, cwd: process.cwd() }) + "\n",
  );

const readUsage = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  return JSON.parse(raw);
};
const appendRolloutUsage = (usage) => {
  fs.appendFileSync(
    sessionFile,
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: usage, last_token_usage: usage },
      },
    }) + "\n",
  );
};
if (process.env.TEST_CODEX_ROLLOUT_USAGE)
  appendRolloutUsage(readUsage("TEST_CODEX_ROLLOUT_USAGE", null));

emit({
  type: "thread.started",
  thread_id: scenario === "wrong-thread" ? "wrong-" + sessionId : sessionId,
});
if (scenario === "hang") {
  await wait(60000);
} else if (scenario === "fail") {
  emit({ type: "turn.failed", error: { message: "fixture codex failure" } });
  process.exitCode = 1;
} else if (scenario === "error-event") {
  emit({ type: "error", message: "fixture codex error event" });
  process.exitCode = 1;
} else {
  emit({ type: "turn.started" });
  if (scenario === "sleep") await wait(Number(process.env.TEST_DELAY_MS || 300));
  if (scenario !== "no-message")
    emit({
      type: "item.completed",
      item: { type: "agent_message", text: "codex answer " + sessionId },
    });
  const completionUsage = readUsage("TEST_CODEX_COMPLETION_USAGE", {
    input_tokens: 11,
    cached_input_tokens: 4,
    cache_write_input_tokens: 2,
    output_tokens: 5,
    reasoning_output_tokens: 3,
  });
  emit({ type: "turn.completed", usage: completionUsage });
  appendRolloutUsage(completionUsage);
}
