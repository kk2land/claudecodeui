#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const scenario = process.env.TEST_SCENARIO || "ok";
if (process.env.TEST_PID_FILE) {
  const fsPid = await import("node:fs");
  fsPid.writeFileSync(process.env.TEST_PID_FILE, String(process.pid));
}
const sessionId = process.env.TEST_SESSION_ID || randomUUID();
const args = process.argv.slice(2);
const file = args[args.indexOf("--session") + 1];
const root = path.dirname(file);
fs.mkdirSync(root, { recursive: true });
if (!fs.existsSync(file)) {
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "session", id: sessionId, cwd: process.cwd() }) + "\n",
  );
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
emit({ type: "session", id: sessionId, cwd: process.cwd() });
emit({ type: "agent_start" });
emit({ type: "turn_start" });
if (scenario === "fail") {
  emit({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "fixture pi failure", content: [] },
  });
  process.exitCode = 1;
} else {
  if (scenario === "sleep") await wait(Number(process.env.TEST_DELAY_MS || 400));
  emit({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "pi answer " + sessionId }] },
  });
  emit({
    type: "turn_end",
    message: { usage: { input: 7, output: 3, totalTokens: 10 } },
  });
  emit({ type: "agent_end", willRetry: false });
  emit({ type: "agent_settled", aborted: false });
}
