#!/usr/bin/env node
import fs from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * Deterministic AGY ACP fixture for `agy acp --dangerously-skip-permissions`.
 * It mimics one initialized server that can multiplex sessions across cwds, validate the
 * `model` + `thought_level` config pair, resume an existing conversation id, stream text and
 * report run-scoped usage. Scenarios are selected from `[scenario:<name>]` in the prompt.
 */

const envStateFile = process.env.TEST_ENV_STATE_FILE || null;
function readEnvState() {
  if (!envStateFile) return null;
  try {
    return JSON.parse(fs.readFileSync(envStateFile, "utf8"));
  } catch {
    return null;
  }
}
function testEnv(key) {
  const state = readEnvState();
  if (state && Object.prototype.hasOwnProperty.call(state, key)) return state[key];
  if (state) return undefined;
  return process.env[key];
}
const scenarioDefault = testEnv("TEST_SCENARIO") || "ok";

if (testEnv("TEST_AGY_PID_FILE")) {
  fs.writeFileSync(testEnv("TEST_AGY_PID_FILE"), String(process.pid));
}
if (testEnv("TEST_SPAWN_LOG_FILE")) {
  fs.appendFileSync(testEnv("TEST_SPAWN_LOG_FILE"), "agy " + String(process.pid) + "\n", "utf8");
}

let writeChain = Promise.resolve();
function writeRaw(payload) {
  writeChain = writeChain.then(
    () => process.stdout.write(JSON.stringify(payload) + "\n"),
    () => process.stdout.write(JSON.stringify(payload) + "\n"),
  );
}
function sendResult(id, result) {
  writeRaw({ jsonrpc: "2.0", id, result });
}
function sendError(id, code, message, data) {
  writeRaw({
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseScenario(prompt) {
  const match = /^\[scenario:([^\]]+)\]/.exec(prompt.trim());
  return match ? match[1] : null;
}

let initializeCount = 0;
const sessions = new Map();
const pending = new Map();

function optionsFor(state) {
  return [
    { id: "model", category: "model", currentValue: state.model },
    { id: "thought_level", category: "thought_level", currentValue: state.thought },
  ];
}
function newState(sessionId, cwd, model = "gemini-4-neon", thought = "medium") {
  return { sessionId, cwd, model, thought };
}

function promptResponse(id, state, scenario, text) {
  const partial = scenario === "partial-usage";
  const configured = testEnv("TEST_AGY_ACP_USAGE");
  let usage = {
    inputTokens: 10,
    outputTokens: 5,
    cachedReadTokens: 2,
    cachedWriteTokens: 0,
    totalTokens: 15,
  };
  if (configured) {
    try {
      usage = JSON.parse(configured);
    } catch {
      /* keep default */
    }
  }
  if (partial) delete usage.outputTokens;
  const resultText =
    text ??
    `agy ${state.sessionId} model=${state.model} thought=${state.thought} cwd=${state.cwd}`;
  const sendText = (chunk) =>
    writeRaw({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: state.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        },
      },
    });
  if (scenario === "quota-message") {
    // Mirrors agy 1.5.16: a quota warning split across text chunks, then a normal end_turn.
    sendText("⚠ Individual quota reached. Please upgrade ");
    sendText(
      "your subscription to increase your limits. Resets in 1h39m16s.",
    );
    sendResult(id, { stopReason: "end_turn", usage });
    return;
  }
  if (scenario === "quota-mention") {
    sendText(
      "The warning says: ⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h39m16s.",
    );
    sendResult(id, { stopReason: "end_turn", usage });
    return;
  }
  sendText(resultText);
  sendResult(id, { stopReason: "end_turn", usage });
}

async function handlePrompt(id, params, prompt) {
  const sessionId = params?.sessionId;
  const state = sessions.get(sessionId);
  if (!state) {
    sendError(id, -32602, "unknown session: " + String(sessionId));
    return;
  }
  const scenario = parseScenario(prompt) || scenarioDefault;
  if (scenario === "quota-hold") {
    const directory = testEnv("TEST_AGY_RELEASE_DIR");
    if (directory) {
      const trigger = directory + "/release-" + state.model;
      while (!fs.existsSync(trigger)) await wait(20);
    }
  }
  if (scenario === "rate-limit" || scenario === "quota-hold") {
    let reset = testEnv("TEST_AGY_RESET_TEXT") || "";
    const byModel = testEnv("TEST_AGY_RESET_BY_MODEL");
    if (byModel) {
      try {
        reset = JSON.parse(byModel)[state.model] || reset;
      } catch {
        /* keep plain reset text */
      }
    }
    if (reset) process.stderr.write(reset + "\n");
    sendError(id, 429, "RESOURCE_EXHAUSTED: agy quota exceeded" + (reset ? " " + reset : ""), {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "agy quota exceeded" + (reset ? " " + reset : ""),
    });
    return;
  }
  if (scenario === "hang" || scenario === "ignore-cancel") {
    pending.set(id, { state, scenario, timer: null });
    if (scenario === "ignore-cancel") {
      // Deliberately never answer session/cancel; the caller must settle unconfirmed.
    }
    return;
  }
  let delay = 0;
  if (scenario === "sleep" || scenario.startsWith("sleep:"))
    delay = scenario.startsWith("sleep:") ? Number(scenario.slice(6)) : 1500;
  if (delay > 0) {
    pending.set(id, { state, scenario, timer: null });
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      promptResponse(id, state, scenario);
    }, delay);
    pending.get(id).timer = timer;
    return;
  }
  promptResponse(id, state, scenario);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    void handleMessage(message);
  }
});

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    initializeCount++;
    if (initializeCount > 1) {
      sendError(id, -32600, "initialize already called on this process");
      return;
    }
    sendResult(id, {
      protocolVersion: 1,
      agentInfo: { name: "fake-agy-acp", version: "1.5.16" },
      agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } },
    });
    return;
  }
  if (method === "session/new") {
    const cwd = typeof params?.cwd === "string" ? params.cwd : process.cwd();
    const configured = testEnv("TEST_AGY_SESSION_ID");
    const sessionId = configured || "agy-" + randomUUID();
    const state = newState(sessionId, cwd);
    sessions.set(sessionId, state);
    sendResult(id, { sessionId, configOptions: optionsFor(state) });
    return;
  }
  if (method === "session/resume") {
    const requested = typeof params?.sessionId === "string" ? params.sessionId : null;
    if (!requested) {
      sendError(id, -32602, "session/resume requires sessionId");
      return;
    }
    const cwd = typeof params?.cwd === "string" ? params.cwd : process.cwd();
    const state = sessions.get(requested) ?? newState(requested, cwd);
    state.cwd = cwd;
    sessions.set(requested, state);
    sendResult(id, { sessionId: requested, configOptions: optionsFor(state) });
    return;
  }
  if (method === "session/set_config_option") {
    const sessionId = params?.sessionId;
    const state = sessions.get(sessionId);
    if (!state) {
      sendError(id, -32602, "unknown session: " + String(sessionId));
      return;
    }
    const configId = params?.configId;
    const value = params?.value;
    if (configId === "model") {
      if (typeof value !== "string" || !value) {
        sendError(id, -32602, "invalid model");
        return;
      }
      state.model = value;
    } else if (configId === "thought_level") {
      if (!["low", "medium", "high", "xhigh"].includes(value)) {
        sendError(id, -32602, "unsupported thought_level: " + String(value));
        return;
      }
      state.thought = value;
    } else {
      sendError(id, -32602, "unknown config option: " + String(configId));
      return;
    }
    sendResult(id, { configOptions: optionsFor(state) });
    return;
  }
  if (method === "session/prompt") {
    const prompt = Array.isArray(params?.prompt)
      ? params.prompt.filter((part) => part?.type === "text").map((part) => part.text).join("")
      : "";
    await handlePrompt(id, params ?? {}, prompt);
    return;
  }
  if (method === "session/cancel") {
    const sessionId = params?.sessionId;
    for (const [promptId, entry] of pending) {
      if (entry.state.sessionId !== sessionId) continue;
      if (entry.scenario === "ignore-cancel") continue;
      if (entry.timer) clearTimeout(entry.timer);
      pending.delete(promptId);
      sendResult(promptId, { stopReason: "cancelled" });
    }
    return;
  }
  if (method === "session/close") {
    if (params?.sessionId) sessions.delete(params.sessionId);
    sendResult(id, {});
    return;
  }
  sendError(id, -32601, "method not found: " + String(method));
}
