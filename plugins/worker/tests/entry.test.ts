import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { pluginRoot, temporaryRoot, tsxLoader } from "./helpers.js";

type Reply = { ok: boolean; value?: unknown; error?: { code: string } };

test("entry registers owners over IPC and keeps UI/MCP credentials separate", async (t) => {
  const root = temporaryRoot("worker-entry-");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", tsxLoader, path.join(pluginRoot, "server/entry.ts")],
    {
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        HOME: path.join(root, "home"),
        CLOUDCLI_PLUGIN_TOKEN: "ui-token",
        CLOUDCLI_PLUGIN_DATA_DIR: path.join(root, "data"),
        CLOUDCLI_HOST_ROOT: pluginRoot,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  t.after(() => {
    try {
      process.kill(child.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
  });
  let stdout = "";
  const ready = await new Promise<{ port: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("entry did not become ready")), 15000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split("\n")) {
        if (!line.includes('"ready":true')) continue;
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("entry exited early"));
    });
  });
  const pending = new Map<string, (reply: Reply) => void>();
  child.on("message", (message: { id?: string; kind?: string; ok?: boolean }) => {
    if (message.kind !== "response" || !message.id) return;
    pending.get(message.id)?.(message as Reply);
    pending.delete(message.id);
  });
  const request = (action: string, payload: unknown): Promise<Reply> => {
    const id = "req-" + Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.send!({
        channel: "cloudcli-workers",
        id,
        kind: "request",
        action,
        payload,
      });
    });
  };
  const owner = {
    id: "entry-owner",
    parentSessionId: "entry-parent",
    projectId: "entry-project",
    projectPath: project,
    userId: null,
    appServerInstanceId: "entry-app",
    paused: false,
  };
  const registered = await request("registerOwner", { owner, token: "owner-token" });
  assert.equal(registered.ok, true);
  const listed = await request("listNotifications", {});
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.value, []);
  const claimed = await request("claimNotifications", {
    ownerId: "entry-owner",
    eventIds: [],
    batchId: "batch-1",
  });
  assert.deepEqual(claimed.value, { batchId: "batch-1", notifications: [] });
  const settled = await request("settleNotifications", {
    batchId: "batch-1",
    delivery: "delivered",
  });
  assert.deepEqual(settled.value, { settled: true });
  const paused = await request("setOwnerPaused", {
    ownerId: "entry-owner",
    paused: true,
  });
  assert.deepEqual(paused.value, { confirmed: true });

  const base = "http://127.0.0.1:" + ready.port;
  const state = await fetch(base + "/state", {
    headers: { authorization: "Bearer ui-token" },
  });
  assert.equal(state.status, 200);
  const body = await state.text();
  assert.match(body, /"workers":\[\]/);
  assert.equal(body.includes("ui-token"), false);
  assert.equal(body.includes("owner-token"), false);
  const wrong = await fetch(base + "/state", {
    headers: { authorization: "Bearer owner-token" },
  });
  assert.equal(wrong.status, 401);
  const wrongMcp = await fetch(base + "/api/worker-mcp", {
    method: "POST",
    headers: { authorization: "Bearer ui-token", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(wrongMcp.status, 401);
  const initializeBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "entry-test", version: "1.0.0" },
    },
  });
  const initialized = await fetch(base + "/api/worker-mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: initializeBody,
  });
  assert.equal(initialized.status, 200);
  const initializedBody = (await initialized.json()) as {
    result?: { serverInfo?: { name?: string } };
  };
  assert.equal(initializedBody.result?.serverInfo?.name, "cloudcli-workers");
  const oldPath = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer owner-token",
      "content-type": "application/json",
    },
    body: initializeBody,
  });
  assert.equal(oldPath.status, 404);

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.equal(stdout.trim().split("\n").length, 1);
});
