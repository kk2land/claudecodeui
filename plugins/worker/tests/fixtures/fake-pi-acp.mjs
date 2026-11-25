#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

/**
 * Deterministic multi-session stdio JSON-RPC 2.0 ACP fixture mimicking `@geohar/pi-acp` 0.4.0.
 * Supports one persistent shared process multiplexing concurrent sessions across different cwds,
 * writing real Pi v3 JSONL transcripts under `$PI_CODING_AGENT_DIR/sessions/--<encoded-cwd>--/`
 * and updating `$HOME/.pi/pi-acp/session-map.json`.
 */

const agentDir =
  process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || process.cwd(), ".pi", "agent");
const userHome = process.env.HOME || process.cwd();
const sessionsRoot = path.join(agentDir, "sessions");
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
  if (state && Object.prototype.hasOwnProperty.call(state, key)) {
    return state[key];
  }
  if (state) return undefined;
  return process.env[key];
}

function currentScenario() {
  return testEnv("TEST_SCENARIO") || "ok";
}

if (testEnv("TEST_CLI_PID_FILE")) {
  fs.writeFileSync(testEnv("TEST_CLI_PID_FILE"), String(process.pid));
}
if (testEnv("TEST_PID_FILE") && currentScenario() !== "hangtree" && currentScenario() !== "grandchild") {
  fs.writeFileSync(testEnv("TEST_PID_FILE"), String(process.pid));
}
if (testEnv("TEST_ENV_FILE")) {
  fs.writeFileSync(testEnv("TEST_ENV_FILE"), String(process.env.OPENAI_API_KEY ?? ""));
}
if (testEnv("TEST_SPAWN_LOG_FILE")) {
  fs.appendFileSync(testEnv("TEST_SPAWN_LOG_FILE"), String(process.pid) + "\n", "utf8");
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let writeChain = Promise.resolve();
function queueStdout(fn) {
  writeChain = writeChain.then(fn, fn);
  return writeChain;
}

function writeRaw(payload) {
  queueStdout(() => {
    process.stdout.write(JSON.stringify(payload) + "\n");
  });
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

function sendUpdate(sessionId, update) {
  writeRaw({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

function encodeCwd(cwd) {
  return "--" + cwd.replace(/^\/+/, "").replace(/[^a-zA-Z0-9]+/g, "-") + "--";
}

function findSessionFile(sessionId) {
  if (!fs.existsSync(sessionsRoot)) return null;
  for (const dir of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sub = path.join(sessionsRoot, dir.name);
    for (const file of fs.readdirSync(sub, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(`_${sessionId}.jsonl`)) {
        return path.join(sub, file.name);
      }
    }
  }
  return null;
}

function updateSessionMap(sessionId, cwd, sessionFile) {
  const mapDir = path.join(userHome, ".pi", "pi-acp");
  fs.mkdirSync(mapDir, { recursive: true });
  const mapFile = path.join(mapDir, "session-map.json");
  let data = { version: 1, sessions: {} };
  try {
    data = JSON.parse(fs.readFileSync(mapFile, "utf8"));
    if (!data || typeof data !== "object" || !data.sessions) {
      data = { version: 1, sessions: {} };
    }
  } catch {
    data = { version: 1, sessions: {} };
  }
  data.sessions[sessionId] = {
    sessionId,
    cwd,
    sessionFile,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(mapFile, JSON.stringify(data, null, 2));
}

function defaultUsage() {
  const raw = testEnv("TEST_USAGE_JSON");
  if (raw) {
    return JSON.parse(raw);
  }
  return {
    input: 12,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 20,
  };
}

function configOptionsFor(model, effort) {
  return [
    {
      type: "select",
      id: "model",
      category: "model",
      name: "Model",
      currentValue: model,
      options: [{ value: model, name: model, description: null }],
    },
    {
      type: "select",
      id: "thought_level",
      category: "thought_level",
      name: "Thinking",
      currentValue: effort,
      options: ["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => ({
        value: level,
        name: "Thinking: " + level,
        description: null,
      })),
    },
  ];
}

let initializeCount = 0;
let dupSeq = 0;
let serverReqSeq = 999;
const sessions = new Map();
let setupHangUsed = false;
const pendingServerRequests = new Map();

function appendTranscript(session, entry) {
  if (!session.file) return;
  fs.appendFileSync(session.file, JSON.stringify(entry) + "\n", "utf8");
}

function extractPromptText(promptBlocks) {
  if (!Array.isArray(promptBlocks)) return "";
  return promptBlocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function parsePromptScenario(promptText) {
  const match = /^\[scenario:([^\]]+)\]/.exec(promptText.trim());
  return match ? match[1] : null;
}

async function handlePrompt(id, params) {
  const sid = params?.sessionId;
  const session = sessions.get(sid);
  if (!session || session.closed) {
    sendError(id, -32004, `Session not found: ${String(sid)}`);
    return;
  }
  const promptText = extractPromptText(params?.prompt);
  const scenario = parsePromptScenario(promptText) || currentScenario();
  session.cancelRequested = false;
  session.cancelResolver = null;

  sendUpdate(sid, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "pi v1.6.0\n---\n" },
  });
  sendUpdate(sid, {
    sessionUpdate: "session_info_update",
    _meta: { piAcp: { queueDepth: 0, running: true } },
  });

  if (scenario === "stderr-noise") {
    process.stderr.write(`shared-pi-acp-stderr-noise pid=${process.pid} sid=${sid}\n`);
  }

  if (scenario === "bad-json") {
    queueStdout(() => {
      process.stdout.write("{not valid json\n");
    });
    setTimeout(() => process.exit(0), 20);
    return;
  }

  if (scenario === "corrupt-stay-alive") {
    process.on("SIGTERM", () => {});
    queueStdout(() => {
      process.stdout.write("{not valid json\n");
    });
    // Stay alive on purpose until the host's bounded group reaper kills us.
    setInterval(() => {}, 1000);
    return;
  }

  if (scenario === "close-stdout-stay-alive") {
    process.on("SIGTERM", () => {});
    queueStdout(() => {
      process.stdout.end();
    });
    setInterval(() => {}, 1000);
    return;
  }

  if (scenario === "server-request") {
    const reqId = serverReqSeq++;
    const resolved = new Promise((resolve) => {
      pendingServerRequests.set(reqId, resolve);
    });
    writeRaw({
      jsonrpc: "2.0",
      id: reqId,
      method: "fs/read_text_file",
      params: { path: "/etc/hosts" },
    });
    await Promise.race([resolved, wait(2000)]);
  }

  if (scenario === "splitutf8") {
    const msg =
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "utf8",
            title: "中文工具",
            kind: "read",
            status: "pending",
          },
        },
      }) + "\n";
    const bytes = Buffer.from(msg, "utf8");
    const cut = bytes.indexOf(Buffer.from("中", "utf8")) + 1;
    await queueStdout(
      () =>
        new Promise((resolve) => {
          process.stdout.write(bytes.subarray(0, cut));
          setTimeout(() => {
            process.stdout.write(bytes.subarray(cut));
            resolve();
          }, 40);
        }),
    );
    await wait(300);
  } else {
    sendUpdate(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "read",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "README.md" },
    });
  }

  if (scenario === "hangtree") {
    process.on("SIGTERM", () => {});
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { stdio: "inherit" },
    );
    if (testEnv("TEST_PID_FILE")) {
      fs.writeFileSync(testEnv("TEST_PID_FILE"), String(child.pid));
    }
    child.unref();
    await wait(60000);
    return;
  }

  if (scenario === "ignore-cancel") {
    // Simulates an ACP server that never answers session/cancel.
    await new Promise((resolve) => setTimeout(resolve, 60000));
  }

  if (scenario === "hang") {
    await new Promise((resolve) => {
      session.cancelResolver = resolve;
      setTimeout(resolve, 60000);
    });
    if (session.cancelRequested) {
      sendUpdate(sid, {
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: 0, running: false } },
      });
      sendResult(id, { stopReason: "cancelled" });
      return;
    }
  }

  if (scenario === "cancel-with-usage") {
    appendTranscript(session, {
      type: "message",
      id: "u-" + randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: promptText }] },
    });
    appendTranscript(session, {
      type: "message",
      id: "a-" + randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
        usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
        stopReason: "toolUse",
      },
    });
    await new Promise((resolve) => {
      session.cancelResolver = resolve;
      setTimeout(resolve, 60000);
    });
    sendUpdate(sid, {
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: 0, running: false } },
    });
    sendResult(id, { stopReason: "cancelled" });
    return;
  }

  const stepsBeforeDelay = Number(testEnv("TEST_STEPS_BEFORE_DELAY") || 0);
  for (let step = 0; step < stepsBeforeDelay; step++) {
    const callId = "step-" + step;
    sendUpdate(sid, {
      sessionUpdate: "tool_call",
      toolCallId: callId,
      title: "read",
      kind: "read",
      status: "in_progress",
    });
    sendUpdate(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: callId,
      status: "completed",
    });
  }

  if (scenario === "sleep" || scenario.startsWith("sleep:")) {
    const inlineMs = scenario.startsWith("sleep:") ? Number(scenario.slice("sleep:".length)) : 0;
    const delayMs = inlineMs > 0 ? inlineMs : Number(testEnv("TEST_DELAY_MS") || 400);
    await new Promise((resolve) => {
      session.cancelResolver = resolve;
      setTimeout(resolve, delayMs);
    });
    if (session.cancelRequested) {
      sendUpdate(sid, {
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: 0, running: false } },
      });
      sendResult(id, { stopReason: "cancelled" });
      return;
    }
  }

  if (scenario === "fail") {
    appendTranscript(session, {
      type: "message",
      id: "u-" + randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: promptText }] },
    });
    appendTranscript(session, {
      type: "message",
      id: "a-" + randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
        errorMessage: "fixture pi failure",
      },
    });
    sendError(id, -32603, "Internal error", { details: "fixture pi failure" });
    return;
  }

  if (scenario === "swallow-error") {
    appendTranscript(session, {
      type: "message",
      id: "u-" + randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: promptText }] },
    });
    appendTranscript(session, {
      type: "message",
      id: "a-" + randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "error",
        errorMessage: '400: {"message":"swallowed upstream model error"}',
      },
    });
    sendUpdate(sid, {
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: 0, running: false } },
    });
    sendResult(id, { stopReason: "end_turn" });
    return;
  }

  if (scenario === "retry-all-fail") {
    appendTranscript(session, {
      type: "message",
      id: "u-retry",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: promptText }] },
    });
    for (const attempt of ["a-fail-1", "a-fail-2"]) {
      sendUpdate(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Retrying..." },
      });
      appendTranscript(session, {
        type: "message",
        id: attempt,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "error",
          errorMessage: "500: upstream unavailable",
        },
      });
      appendTranscript(session, {
        type: "context_edit",
        id: "ce-" + attempt,
        targetId: attempt,
        replacement: null,
      });
    }
    sendUpdate(sid, {
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: 0, running: false } },
    });
    sendResult(id, { stopReason: "end_turn" });
    return;
  }

  if (scenario === "retry-then-ok") {
    appendTranscript(session, {
      type: "message",
      id: "u-retry-ok",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: promptText }] },
    });
    sendUpdate(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Retrying (attempt 1/3, waiting 2s)..." },
    });
    appendTranscript(session, {
      type: "message",
      id: "a-transient",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
        stopReason: "error",
        errorMessage: "503: transient",
      },
    });
    appendTranscript(session, {
      type: "context_edit",
      id: "ce-transient",
      targetId: "a-transient",
      replacement: null,
    });
    sendUpdate(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "recovered answer " + sid },
    });
    appendTranscript(session, {
      type: "message",
      id: "a-ok",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "recovered answer " + sid }],
        usage: { input: 10, output: 4, cacheRead: 1, cacheWrite: 0, totalTokens: 15 },
        stopReason: "stop",
      },
    });
    sendUpdate(sid, {
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: 0, running: false } },
    });
    sendResult(id, { stopReason: "end_turn" });
    return;
  }

  if (scenario === "missing-transcript") {
    if (session.file && fs.existsSync(session.file)) fs.unlinkSync(session.file);
    sendUpdate(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "phantom answer" },
    });
    sendResult(id, { stopReason: "end_turn" });
    return;
  }

  if (scenario === "ambiguous-transcript") {
    appendTranscript(session, {
      type: "message",
      id: "u-amb",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: promptText }] },
    });
    appendTranscript(session, {
      type: "message",
      id: "a-amb",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer " + sid }],
        usage: defaultUsage(),
        stopReason: "stop",
      },
    });
    const duplicate = path.join(path.dirname(session.file), `2026-11-24T00-00-01-000Z_${sid}.jsonl`);
    fs.copyFileSync(session.file, duplicate);
    sendResult(id, { stopReason: "end_turn" });
    return;
  }

  if (scenario === "corrupt-transcript") {
    fs.appendFileSync(session.file, "{broken-transcript-line\n", "utf8");
    sendResult(id, { stopReason: "end_turn" });
    return;
  }

  if (scenario === "no-assistant-transcript") {
    appendTranscript(session, {
      type: "message",
      id: "u-only",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: promptText }] },
    });
    sendResult(id, { stopReason: "end_turn" });
    return;
  }

  sendUpdate(sid, {
    sessionUpdate: "tool_call_update",
    toolCallId: "c1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "file content" } }],
  });
  sendUpdate(sid, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "thinking step" },
  });
  const answer = "pi answer " + sid;
  sendUpdate(sid, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: answer },
  });
  appendTranscript(session, {
    type: "message",
    id: "u-" + randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: promptText }] },
  });
  appendTranscript(session, {
    type: "message",
    id: "a-" + randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "thinking step" },
        { type: "text", text: answer },
      ],
      usage: defaultUsage(),
      stopReason: "stop",
    },
  });
  if (scenario === "wipe-session-map") {
    const mapFile = path.join(userHome, ".pi", "pi-acp", "session-map.json");
    fs.mkdirSync(path.dirname(mapFile), { recursive: true });
    fs.writeFileSync(mapFile, JSON.stringify({ version: 1, sessions: {} }));
  }
  sendUpdate(sid, {
    sessionUpdate: "session_info_update",
    _meta: { piAcp: { queueDepth: 0, running: false } },
  });
  sendResult(id, { stopReason: "end_turn" });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const message = JSON.parse(raw);
    void handleMessage(message);
  }
});
process.stdin.on("end", () => {
  const scenario = currentScenario();
  if (
    scenario !== "hangtree" &&
    scenario !== "corrupt-stay-alive" &&
    scenario !== "close-stdout-stay-alive"
  ) {
    process.exit(0);
  }
});

async function handleMessage(message) {
  if (!message.method && message.id !== undefined && pendingServerRequests.has(message.id)) {
    const resolve = pendingServerRequests.get(message.id);
    pendingServerRequests.delete(message.id);
    resolve(message);
    return;
  }
  const { id, method, params } = message;
  const rpcLogFile = testEnv("TEST_RPC_LOG_FILE");
  if (rpcLogFile && method) {
    fs.appendFileSync(
      rpcLogFile,
      JSON.stringify({ method, sessionId: params?.sessionId ?? null, configId: params?.configId ?? null }) + "\n",
      "utf8",
    );
  }
  const scenario = currentScenario();

  if (method === "initialize") {
    initializeCount++;
    if (initializeCount > 1) {
      sendError(id, -32600, "initialize already called on this process");
      return;
    }
    const sessionCapabilities =
      scenario === "no-resume-cap"
        ? { list: {}, close: {} }
        : { list: {}, delete: {}, resume: {}, close: {} };
    sendResult(id, {
      protocolVersion: 1,
      agentInfo: {
        name: "@geohar/pi-acp",
        title: "pi ACP adapter",
        version: "0.4.0",
        pid: process.pid,
        initializeCount,
      },
      agentCapabilities: { loadSession: true, sessionCapabilities },
    });
    return;
  }

  if (method === "session/new") {
    if (scenario === "setup-hang" && !setupHangUsed) {
      setupHangUsed = true;
      return;
    }
    if (scenario === "setup-delay" && !setupHangUsed) {
      setupHangUsed = true;
      await wait(Number(testEnv("TEST_DELAY_MS") || 1500));
    }
    if (scenario === "auth-error") {
      sendError(
        id,
        -32000,
        "Authentication required: Configure an API key or log in with an OAuth provider.",
      );
      return;
    }
    if (scenario === "null-before-session") {
      sendResult(id, { sessionId: null });
      return;
    }
    const cwd = params?.cwd || process.cwd();
    const forcedId = testEnv("TEST_SESSION_ID");
    // When two concurrent sessions share one fixture process with a default TEST_SESSION_ID,
    // disambiguate the second live session so concurrent workers do not collide on sessionId.
    const sid = forcedId
      ? sessions.has(forcedId)
        ? `${forcedId}-${++dupSeq}`
        : forcedId
      : randomUUID();
    const dir = path.join(sessionsRoot, encodeCwd(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const ts = forcedId
      ? "2026-11-24T00-00-00-000Z"
      : new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${ts}_${sid}.jsonl`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          type: "session",
          version: 3,
          id: sid,
          timestamp: new Date().toISOString(),
          cwd,
        }) + "\n",
        "utf8",
      );
    }
    updateSessionMap(sid, cwd, file);
    const session = {
      id: sid,
      cwd,
      file,
      model: "fixture/default-model",
      effort: "medium",
      closed: false,
      cancelRequested: false,
      cancelResolver: null,
    };
    sessions.set(sid, session);
    sendResult(id, {
      sessionId: sid,
      configOptions: configOptionsFor(session.model, session.effort),
      _meta: { piAcp: { startupInfo: "pi v1.6.0\n---\n" } },
    });
    return;
  }

  if (method === "session/resume") {
    if (scenario === "setup-hang" && !setupHangUsed) {
      setupHangUsed = true;
      return;
    }
    const cwd = params?.cwd || process.cwd();
    const requestedId = params?.sessionId;
    if (scenario === "wrong-resume-id") {
      sendResult(id, {
        sessionId: "wrong-session-id",
        configOptions: configOptionsFor("fixture/default-model", "medium"),
      });
      return;
    }
    const forcedId = testEnv("TEST_SESSION_ID");
    if (forcedId && forcedId !== requestedId) {
      sendResult(id, {
        sessionId: forcedId,
        configOptions: configOptionsFor("fixture/default-model", "medium"),
      });
      return;
    }
    const file = findSessionFile(requestedId);
    if (!file) {
      sendError(id, -32002, `Session not found: ${requestedId}`);
      return;
    }
    const session = {
      id: requestedId,
      cwd,
      file,
      model: "fixture/default-model",
      effort: "medium",
      closed: false,
      cancelRequested: false,
      cancelResolver: null,
    };
    sessions.set(requestedId, session);
    sendResult(id, {
      configOptions: configOptionsFor(session.model, session.effort),
      _meta: { piAcp: { startupInfo: null } },
    });
    return;
  }

  if (method === "session/set_config_option") {
    const session = sessions.get(params?.sessionId);
    if (!session || session.closed) {
      sendError(id, -32004, `Session not found: ${String(params?.sessionId)}`);
      return;
    }
    const configId = params?.configId;
    const value = params?.value;
    if (configId === "thought_level") {
      if (
        value === "max" ||
        !["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)
      ) {
        sendError(id, -32602, "Invalid params", `Unknown thinking level: ${value}`);
        return;
      }
      if (scenario === "downgrade-effort") {
        session.effort = value === "xhigh" ? "high" : "off";
      } else {
        session.effort = value;
      }
      sendResult(id, { configOptions: configOptionsFor(session.model, session.effort) });
      return;
    }
    if (configId === "model") {
      if (scenario === "reject-model") {
        sendError(id, -32603, "Internal error", {
          details: `pi set_model failed: Model not found: ${value}`,
        });
        return;
      }
      if (scenario === "downgrade-model") {
        session.model = "fallback/other-model";
      } else {
        session.model = value.includes("/") ? value : "fixture/" + value;
      }
      sendResult(id, { configOptions: configOptionsFor(session.model, session.effort) });
      return;
    }
    sendError(id, -32602, "Invalid params", `Unknown configId: ${configId}`);
    return;
  }

  if (method === "session/prompt") {
    void handlePrompt(id, params);
    return;
  }

  if (method === "session/cancel") {
    const session = sessions.get(params?.sessionId);
    if (session && !session.closed) {
      session.cancelRequested = true;
      if (session.cancelResolver) session.cancelResolver();
    }
    return;
  }

  if (method === "session/close") {
    const session = sessions.get(params?.sessionId);
    if (session) {
      session.closed = true;
      sessions.delete(params?.sessionId);
    }
    sendResult(id, {});
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}
