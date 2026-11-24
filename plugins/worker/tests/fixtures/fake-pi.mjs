#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const scenario = process.env.TEST_SCENARIO || "ok";
if (process.env.TEST_PID_FILE) {
  const fsPid = await import("node:fs");
  fsPid.writeFileSync(process.env.TEST_PID_FILE, String(process.pid));
}
const args = process.argv.slice(2);
const file = args[args.indexOf("--session") + 1];
const root = path.dirname(file);
fs.mkdirSync(root, { recursive: true });
const explicitSessionId = process.env.TEST_SESSION_ID;
let sessionId = explicitSessionId || randomUUID();
if (fs.existsSync(file)) {
  try {
    const header = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]);
    if (!explicitSessionId && typeof header.id === "string" && header.id) sessionId = header.id;
  } catch {
    /* keep the generated id for an unreadable fixture file */
  }
} else {
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "session", id: sessionId, cwd: process.cwd() }) + "\n",
  );
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (scenario === "null-before-session") {
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "session", id: null, cwd: process.cwd() }) + "\n",
  );
  emit({ type: "session", id: null, cwd: process.cwd() });
  process.exit(0);
}
emit({ type: "session", id: sessionId, cwd: process.cwd() });
emit({ type: "agent_start" });
emit({ type: "turn_start" });
emit({ type: "tool_execution_start", toolName: "read", toolCallId: "c1" });
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
} else if (scenario === "hang") {
  await wait(60000);
} else if (scenario === "fail") {
  emit({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "fixture pi failure", content: [] },
  });
  process.exitCode = 1;
} else {
  if (scenario === "splitutf8") {
    const line = JSON.stringify({ type: "tool_execution_start", toolName: "中文工具", toolCallId: "utf8" }) + "\n";
    const bytes = Buffer.from(line);
    const cut = bytes.indexOf(Buffer.from("中")) + 1;
    process.stdout.write(bytes.subarray(0, cut));
    await wait(40);
    process.stdout.write(bytes.subarray(cut));
    await wait(300);
  }
  for (let step = 0; step < Number(process.env.TEST_STEPS_BEFORE_DELAY || 0); step++) {
    emit({ type: "turn_end" });
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
