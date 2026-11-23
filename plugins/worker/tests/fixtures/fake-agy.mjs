#!/usr/bin/env node
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const scenario = process.env.TEST_SCENARIO || "ok";
const args = process.argv.slice(2);
const print = args.find((arg) => arg.startsWith("--print="));
const prompt = print ? print.slice("--print=".length) : "";
const valueOf = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] ?? null : null;
};
const requested = valueOf("--conversation");
const sessionId = requested || process.env.TEST_SESSION_ID || randomUUID();
const model = valueOf("--model");
const effort = valueOf("--effort");

if (process.env.TEST_PID_FILE)
  fs.writeFileSync(process.env.TEST_PID_FILE, String(process.pid));
if (process.env.TEST_CAPTURE_FILE) {
  fs.writeFileSync(
    process.env.TEST_CAPTURE_FILE,
    JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      prompt,
      model,
      effort,
      env: {
        HOME: process.env.HOME,
        CLOUDCLI_PLUGIN_TOKEN: process.env.CLOUDCLI_PLUGIN_TOKEN,
        PATH: process.env.PATH,
      },
    }),
  );
}

const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = (input, output, cacheRead, total) => ({
  input_tokens: input,
  output_tokens: output,
  thinking_tokens: 0,
  cache_read_tokens: cacheRead,
  total_tokens: total,
});

if (requested && process.env.TEST_AGY_MISSING_CONVERSATION === "1")
  process.stderr.write('warning: conversation "' + requested + '" not found\n');

const effectiveId = process.env.TEST_AGY_MISSING_CONVERSATION === "1" && requested
  ? "different-" + (process.env.TEST_SESSION_ID || "conversation")
  : sessionId;

if (scenario !== "no-init")
  emit({
    event: "init",
    conversation_id: effectiveId,
    init: {
      cwd: scenario === "wrong-cwd" ? "/" : process.cwd(),
      tools: ["write_to_file"],
      permission_mode: "always-proceed",
    },
  });

if (scenario === "hang") {
  await wait(60000);
} else if (scenario === "fail") {
  emit({
    event: "result",
    result: {
      conversation_id: effectiveId,
      status: "ERROR",
      response: "",
      error: "fixture agy failure",
      usage: usage(0, 0, 0, 0),
    },
  });
  process.exitCode = 1;
} else if (scenario === "denied") {
  emit({
    event: "result",
    result: {
      conversation_id: effectiveId,
      status: "SUCCESS",
      response: "",
      denied_actions: [{ action: "write_file", display_name: "Edit" }],
      usage: usage(0, 0, 0, 0),
    },
  });
} else if (scenario === "no-result") {
  // Exit evidence exists, but the native result event is missing.
} else {
  emit({
    event: "step_update",
    step_update: {
      conversation_id: effectiveId,
      step_index: 0,
      state: "DONE",
      step_type: "user_input",
    },
  });
  emit({
    event: "step_update",
    step_update: {
      conversation_id: effectiveId,
      step_index: 1,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: "agy answer ",
    },
  });
  if (scenario === "sleep") await wait(Number(process.env.TEST_DELAY_MS || 300));
  emit({
    event: "step_update",
    step_update: {
      conversation_id: effectiveId,
      step_index: 1,
      state: "DONE",
      step_type: "agent_response",
      text_delta: effectiveId,
      duration_seconds: 1,
      ...(scenario === "no-step-usage" ? {} : { usage: usage(10, 5, 0, 15) }),
    },
  });
  const resultUsage = process.env.TEST_AGY_RESULT_USAGE
    ? JSON.parse(process.env.TEST_AGY_RESULT_USAGE)
    : scenario === "no-step-usage" && requested
      ? usage(110, 55, 0, 165)
      : usage(10, 5, 0, 15);
  emit({
    event: "result",
    result: {
      conversation_id: effectiveId,
      status: "SUCCESS",
      response: "agy answer " + effectiveId,
      usage: resultUsage,
    },
  });
}
