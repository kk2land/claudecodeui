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
const root = process.env.CODEX_DSH_SESSIONS_ROOT;
if (root) {
  const directory = path.join(root, sessionId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "session.v4.jsonl.zstd"), "fixture-session\n");
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

emit({ type: "session", sessionId, cwd: process.cwd() });
emit({ type: "status", phase: "step_start" });
emit({ type: "tool_call", tool: "read", callId: "c1" });
if (process.env.TEST_ENV_FILE) {
  fs.writeFileSync(process.env.TEST_ENV_FILE, String(process.env.OPENAI_API_KEY ?? ""));
}
if (process.env.TEST_CLI_PID_FILE) {
  fs.writeFileSync(process.env.TEST_CLI_PID_FILE, String(process.pid));
}
if (scenario === "hangtree") {
  process.on("SIGTERM", () => {});
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { stdio: "inherit" },
  );
  fs.writeFileSync(process.env.TEST_PID_FILE, String(child.pid));
  child.unref();
  await wait(60000);
} else if (scenario === "fail") {
  emit({ type: "error", message: "fixture failure" });
  process.exitCode = 1;
} else if (scenario === "hang") {
  await wait(60000);
} else {
  if (scenario === "splitutf8") {
    const line =
      JSON.stringify({ type: "tool_call", tool: "中文工具", callId: "utf8" }) + "\n";
    const bytes = Buffer.from(line);
    const cut = bytes.indexOf(Buffer.from("中")) + 1;
    process.stdout.write(bytes.subarray(0, cut));
    await wait(40);
    process.stdout.write(bytes.subarray(cut));
    await wait(300);
    emit({ type: "status", phase: "step_end", usage: { inputTokens: 1, outputTokens: 1 } });
    await wait(500);
  }
  if (scenario === "sleep") await wait(Number(process.env.TEST_DELAY_MS || 400));
  if (scenario === "grandchild") {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "inherit",
    });
    fs.writeFileSync(process.env.TEST_PID_FILE, String(child.pid));
    child.unref();
  }
  emit({ type: "tool_result", callId: "c1" });
  emit({ type: "status", phase: "step_end", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
  emit({ type: "status", phase: "turn_end", reason: { kind: "completed" } });
  emit({ type: "final", text: "fixture answer " + sessionId });
}
