#!/usr/bin/env node
/**
 * Multiplexed fake stdio ACP server fixture for testing shared `AcpClient` / `AcpConnection` /
 * `LazyAcpProcess` behavior: single initialize, concurrent multi-cwd sessions, same-chunk early
 * updates, split UTF-8 chunks, targeted cancel/close, config enforcement, server->client RPC
 * rejection, and abrupt exit / protocol corruption fan-out.
 */
import readline from "node:readline";

let initializeCount = 0;
let sessionSeq = 0;
const sessions = new Map();
const pendingServerRequests = new Map();

const noResume = process.env.FAKE_ACP_NO_RESUME === "1";
const noClose = process.env.FAKE_ACP_NO_CLOSE === "1";
const earlyUpdateSameChunk = process.env.FAKE_ACP_EARLY_UPDATE_SAME_CHUNK === "1";
const dupSessionId = process.env.FAKE_ACP_DUP_ID || null;

let writeChain = Promise.resolve();

function queueStdout(fn) {
  writeChain = writeChain.then(fn, fn);
  return writeChain;
}

function sendRaw(obj) {
  queueStdout(() => {
    process.stdout.write(JSON.stringify(obj) + "\n");
  });
}

function sendResult(id, result) {
  sendRaw({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  sendRaw({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

function sendUpdate(sessionId, text, extra = {}) {
  sendRaw({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        ...extra,
      },
    },
  });
}

function defaultConfigOptions() {
  return [
    { id: "model", category: "model", currentValue: "default/model-a" },
    { id: "thought_level", category: "thought_level", currentValue: "medium" },
  ];
}

function promptText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => (block && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function stopActiveTurn(session, stopReason) {
  if (!session.activeTurn) return;
  const turn = session.activeTurn;
  session.activeTurn = null;
  if (turn.interval) clearInterval(turn.interval);
  if (turn.timer) clearTimeout(turn.timer);
  if (stopReason === "cancelled") {
    sendUpdate(session.id, `cancelled:${session.id}:${turn.tag}`);
  }
  sendResult(turn.reqId, { stopReason, sessionId: session.id, cwd: session.cwd, tag: turn.tag });
}

function handleMessage(msg) {
  // Handle client response to our server->client test request.
  if (!msg.method && msg.id !== undefined && pendingServerRequests.has(msg.id)) {
    const resolve = pendingServerRequests.get(msg.id);
    pendingServerRequests.delete(msg.id);
    resolve(msg);
    return;
  }

  const { id, method, params = {} } = msg;

  if (method === "initialize") {
    initializeCount++;
    if (initializeCount > 1) {
      sendError(id, -32600, "initialize already called on this process");
      return;
    }
    const sessionCapabilities = {};
    if (!noResume) sessionCapabilities.resume = {};
    if (!noClose) sessionCapabilities.close = {};
    sendResult(id, {
      protocolVersion: 1,
      agentInfo: { name: "fake-acp-mux", version: "1.0.0", pid: process.pid },
      agentCapabilities: { sessionCapabilities },
    });
    return;
  }

  if (method === "session/new") {
    const cwd = String(params.cwd || process.cwd());
    const finishNew = () => {
      sessionSeq++;
      const sessionId = dupSessionId ?? `mux-${sessionSeq}`;
      const session = {
        id: sessionId,
        cwd,
        configOptions: defaultConfigOptions(),
        closed: false,
        activeTurn: null,
      };
      sessions.set(sessionId, session);
      const responseLine = JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          sessionId,
          configOptions: session.configOptions,
        },
      });
      if (earlyUpdateSameChunk) {
        const earlyUpdateLine = JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `early:${sessionId}:${cwd}` },
            },
          },
        });
        queueStdout(() => {
          process.stdout.write(`${responseLine}\n${earlyUpdateLine}\n`);
        });
      } else {
        queueStdout(() => {
          process.stdout.write(`${responseLine}\n`);
        });
      }
    };
    if (cwd.includes("delay-open")) {
      setTimeout(finishNew, 40);
    } else {
      finishNew();
    }
    return;
  }

  if (method === "session/resume") {
    const sessionId = String(params.sessionId || "");
    const cwd = String(params.cwd || process.cwd());
    if (!sessionId) {
      sendError(id, -32602, "missing sessionId");
      return;
    }
    const existing = sessions.get(sessionId);
    const session = {
      id: sessionId,
      cwd,
      configOptions: existing ? existing.configOptions : defaultConfigOptions(),
      closed: false,
      activeTurn: null,
    };
    sessions.set(sessionId, session);
    sendResult(id, {
      sessionId,
      configOptions: session.configOptions,
    });
    return;
  }

  if (method === "session/set_config_option") {
    const session = sessions.get(params.sessionId);
    if (!session || session.closed) {
      sendError(id, -32004, `Session not found: ${String(params.sessionId)}`);
      return;
    }
    const configId = String(params.configId || "");
    const value = String(params.value || "");
    if (value === "unsupported") {
      sendError(id, -32602, `Unsupported config value: ${configId}=${value}`);
      return;
    }
    const nextValue =
      value === "clamped"
        ? "medium"
        : configId === "model" && !value.includes("/")
          ? `openai/${value}`
          : value;
    session.configOptions = session.configOptions.map((opt) =>
      opt.id === configId || opt.category === configId
        ? { ...opt, currentValue: nextValue }
        : opt,
    );
    sendResult(id, { configOptions: session.configOptions });
    return;
  }

  if (method === "session/prompt") {
    const session = sessions.get(params.sessionId);
    if (!session || session.closed) {
      sendError(id, -32004, `Session not found or closed: ${String(params.sessionId)}`);
      return;
    }
    const text = promptText(params.prompt).trim();

    if (text === "crash") {
      sendUpdate(session.id, `before-crash:${session.id}`);
      setTimeout(() => process.exit(42), 15);
      return;
    }

    if (text === "corrupt") {
      sendUpdate(session.id, `before-corrupt:${session.id}`);
      setTimeout(() => {
        queueStdout(() => {
          process.stdout.write("not-valid-json-line\n");
        });
      }, 15);
      return;
    }

    if (text === "rpc-error") {
      sendError(id, -32000, `Prompt failed on ${session.id}`);
      return;
    }

    if (text === "server-request") {
      const srvReqId = `srv-${session.id}-${id}`;
      pendingServerRequests.set(srvReqId, (reply) => {
        sendUpdate(session.id, `srv-reply:${session.id}:${reply?.error?.code ?? "none"}`);
        sendResult(id, {
          stopReason: "end_turn",
          rejectedCode: reply?.error?.code ?? null,
          sessionId: session.id,
        });
      });
      sendRaw({
        jsonrpc: "2.0",
        id: srvReqId,
        method: "fs/read_text_file",
        params: { path: "/tmp/unused" },
      });
      return;
    }

    if (text.startsWith("slow:")) {
      const parts = text.split(":");
      const durationMs = Math.max(20, Number(parts[1]) || 200);
      const tag = parts[2] || "slow";
      let tick = 0;
      sendUpdate(session.id, `start:${session.id}:${session.cwd}:${tag}`);
      const interval = setInterval(() => {
        tick++;
        sendUpdate(session.id, `tick:${session.id}:${tag}:${tick}:中文🚀`);
      }, 15);
      const timer = setTimeout(() => {
        stopActiveTurn(session, "end_turn");
      }, durationMs);
      session.activeTurn = { reqId: id, tag, interval, timer };
      return;
    }

    // Default / fast:<tag>: test split UTF-8 multibyte boundary across stdout chunks.
    const tag = text.startsWith("fast:") ? text.slice("fast:".length) : text;
    const payloadBuf = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `fast:${session.id}:${session.cwd}:${tag}:中文🚀` },
          },
        },
      }) + "\n",
      "utf8",
    );
    const splitAt = payloadBuf.indexOf(Buffer.from("中文🚀", "utf8")) + 2;
    queueStdout(
      () =>
        new Promise((resolve) => {
          process.stdout.write(payloadBuf.subarray(0, splitAt));
          setTimeout(() => {
            process.stdout.write(payloadBuf.subarray(splitAt));
            process.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  stopReason: "end_turn",
                  sessionId: session.id,
                  cwd: session.cwd,
                  tag,
                },
              }) + "\n",
            );
            resolve();
          }, 5);
        }),
    );
    return;
  }

  if (method === "session/cancel") {
    const session = sessions.get(params.sessionId);
    if (session && !session.closed && session.activeTurn) {
      stopActiveTurn(session, "cancelled");
    }
    return;
  }

  if (method === "session/close") {
    const session = sessions.get(params.sessionId);
    if (session && !session.closed) {
      session.closed = true;
      if (session.activeTurn) {
        stopActiveTurn(session, "cancelled");
      }
    }
    sendResult(id, { closed: true, sessionId: params.sessionId });
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handleMessage(JSON.parse(trimmed));
  } catch {
    /* ignore malformed stdin */
  }
});
rl.on("close", () => {
  for (const session of sessions.values()) {
    if (session.activeTurn) {
      clearInterval(session.activeTurn.interval);
      clearTimeout(session.activeTurn.timer);
      session.activeTurn = null;
    }
  }
  process.exit(0);
});
