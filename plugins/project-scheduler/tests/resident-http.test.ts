import assert from "node:assert/strict";
import test from "node:test";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ResidentBindingView,
  ResidentIpcRequest,
  ResidentTaskRow,
  ResidentTerminal,
} from "../shared/contracts.js";

const CHANNEL = "cloudcli-scheduler-resident";

function binding(taskId: string, sessionId: string): ResidentBindingView {
  return {
    taskId,
    name: "原会话标题",
    sessionId,
    projectId: "p",
    enabled: true,
    visible: true,
    status: "running",
    executionId: "exec-1",
    stopCause: null,
    runtime: { provider: "codex", permissionMode: "full-auto", sandboxMode: null },
    terminal: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function terminal(taskId: string, sessionId: string): ResidentTerminal {
  return {
    id: "terminal-1",
    taskId,
    sessionId,
    executionId: "exec-1",
    status: "success",
    cause: "completed",
    alert: true,
    endedAt: "2026-01-01T01:00:00.000Z",
    reason: null,
  };
}

/**
 * The real plugin server is forked and this test plays the host side of the resident IPC
 * channel, so the HTTP routes, IPC client, process boundary and metadata store are exercised
 * together. `failStop` makes the host reject a stop to prove deletion never unbinds early.
 */
test(
  "resident HTTP routes drive the typed host IPC channel and never simulate host state",
  { timeout: 30000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resident-http-"));
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const catalog = path.join(root, "projects.json");
    fs.writeFileSync(
      catalog,
      JSON.stringify({
        generatedAt: Date.now(),
        projects: [{ id: "p", name: "project", path: project }],
      }),
    );
    let child: ChildProcess | undefined;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "close").catch(() => {});
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    child = fork(
      fileURLToPath(new URL("../dist/server.mjs", import.meta.url)),
      [],
      {
        execArgv: [],
        env: {
          ...process.env,
          CLOUDCLI_PLUGIN_TOKEN: "resident-test-token",
          CLOUDCLI_PLUGIN_DATA_DIR: path.join(root, "data"),
          CLOUDCLI_PROJECTS_FILE: catalog,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const bindings = new Map<string, ResidentBindingView>();
    const requests: ResidentIpcRequest[] = [];
    let failStop = false;
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("plugin did not start")), 5000);
      let stderr = "";
      child!.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child!.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(stderr));
      });
      let buffer = "";
      child!.stdout?.on("data", (chunk) => {
        buffer += String(chunk);
        for (const line of buffer.split("\n")) {
          try {
            const value = JSON.parse(line) as { ready?: boolean; port: number };
            if (value.ready) {
              clearTimeout(timeout);
              resolve(value.port);
            }
          } catch {
            /* wait for the readiness line */
          }
        }
      });
    });
    child.on("message", (raw: unknown) => {
      const message = raw as ResidentIpcRequest;
      if (!message || message.channel !== CHANNEL || message.kind !== "request") return;
      requests.push(message);
      const reply = (value: unknown) =>
        child!.send({ channel: CHANNEL, id: message.id, kind: "response", ok: true, value });
      const fail = (code: string, text: string) =>
        child!.send({
          channel: CHANNEL,
          id: message.id,
          kind: "response",
          ok: false,
          error: { code, message: text },
        });
      const payload = message.payload as Record<string, unknown>;
      const taskId = String(payload.taskId ?? "");
      switch (message.action) {
        case "adopt": {
          const existing = [...bindings.values()].find(
            (item) => item.sessionId === payload.sessionId,
          );
          if (existing) {
            fail("already_resident", "会话已是常驻任务");
            return;
          }
          if (payload.sessionId !== "session-1") {
            fail("not_running", "前台会话当前没有运行中的轮次");
            return;
          }
          const created = binding(String(payload.taskId), "session-1");
          bindings.set(created.taskId, created);
          reply({ binding: created });
          return;
        }
        case "status": {
          if (payload.taskId === undefined) {
            reply({ bindings: [...bindings.values()] });
            return;
          }
          const found = bindings.get(taskId);
          if (!found) {
            fail("not_found", "宿主没有该常驻任务");
            return;
          }
          reply({ bindings: [found] });
          return;
        }
        case "setEnabled":
        case "setVisible": {
          const found = bindings.get(taskId);
          if (!found) {
            fail("not_found", "宿主没有该常驻任务");
            return;
          }
          const updated =
            message.action === "setEnabled"
              ? { ...found, enabled: Boolean(payload.enabled) }
              : { ...found, visible: Boolean(payload.visible) };
          bindings.set(taskId, updated);
          reply({ binding: updated });
          return;
        }
        case "stop": {
          const found = bindings.get(taskId);
          if (!found) {
            fail("not_running", "任务未在运行");
            return;
          }
          if (failStop) {
            fail("stop_failed", "当前轮次未能停止");
            return;
          }
          const updated: ResidentBindingView = {
            ...found,
            status: "stopping",
            stopCause: "user_stopped",
            updatedAt: "2026-01-01T02:00:00.000Z",
          };
          bindings.set(taskId, updated);
          reply({ binding: updated });
          return;
        }
        case "continue": {
          const found = bindings.get(taskId);
          if (!found) {
            fail("not_found", "宿主没有该常驻任务");
            return;
          }
          const updated = { ...found, status: "running" as const, executionId: "exec-2" };
          bindings.set(taskId, updated);
          reply({
            result: { accepted: true, executionId: "exec-2", reason: null },
            binding: updated,
          });
          return;
        }
        case "remove": {
          const found = bindings.get(taskId);
          if (!found) {
            fail("not_found", "宿主没有该常驻任务");
            return;
          }
          bindings.delete(taskId);
          reply({ removed: true, sessionId: found.sessionId });
          return;
        }
      }
    });
    const request = async (
      route: string,
      method = "GET",
      body?: unknown,
      token = "resident-test-token",
    ) => {
      const response = await fetch("http://127.0.0.1:" + port + route, {
        method,
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: response.status, data };
    };

    // Startup reconciliation is a plain status query: it never resumes a run.
    const bootstrapped = await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (requests.some((message) => message.action === "status")) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    assert.equal(bootstrapped, undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.some((message) => message.action === "continue"), false);

    assert.equal((await request("/resident-tasks", "GET", undefined, "wrong")).status, 401);
    const adopted = await request("/resident-tasks", "POST", { sessionId: "session-1" });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.data));
    const created = (adopted.data as unknown as { task: ResidentTaskRow }).task;
    assert.match(created.taskId, /^[0-9a-f-]{36}$/);
    assert.equal(created.notify, true);
    assert.equal(created.name, "原会话标题");
    assert.equal(created.sessionId, "session-1");
    assert.equal(bindings.size, 1);

    // Host state decisions are reported, not re-derived by the plugin.
    const idle = await request("/resident-tasks", "POST", { sessionId: "session-2" });
    assert.equal(idle.status, 409);
    assert.equal(idle.data.code, "not_running");
    const duplicate = await request("/resident-tasks", "POST", { sessionId: "session-1" });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, "already_resident");
    assert.equal((await request("/resident-tasks", "POST", {})).status, 400);

    const listed = await request("/resident-tasks");
    assert.equal(listed.status, 200);
    assert.equal((listed.data.tasks as ResidentTaskRow[]).length, 1);

    const patched = await request("/resident-tasks/" + created.taskId, "PATCH", {
      enabled: false,
    });
    assert.equal(patched.status, 200);
    assert.equal((patched.data as unknown as ResidentTaskRow).enabled, false);
    assert.equal(
      requests.filter((message) => message.action === "setEnabled").length,
      1,
    );
    const toggled = await request("/resident-tasks/" + created.taskId, "PATCH", {
      visible: false,
    });
    assert.equal((toggled.data as unknown as ResidentTaskRow).visible, false);
    assert.equal((await request("/resident-tasks/" + created.taskId, "PATCH", {})).status, 400);

    const stopped = await request("/resident-tasks/" + created.taskId + "/stop", "POST");
    assert.equal(stopped.status, 200);
    assert.equal((stopped.data as unknown as ResidentTaskRow).status, "stopping");

    // Continue is accepted, answered immediately and reported with the host's binding state.
    const continued = await request("/resident-tasks/" + created.taskId + "/continue", "POST");
    assert.equal(continued.status, 200, JSON.stringify(continued.data));
    const continueBody = continued.data as unknown as {
      task: ResidentTaskRow;
      result: { accepted: boolean; executionId: string };
    };
    assert.equal(continueBody.result.accepted, true);
    assert.equal(continueBody.task.executionId, "exec-2");

    // One terminal episodes becomes exactly one resident run row, even when re-delivered.
    const push = (value: ResidentTerminal) =>
      child!.send({ channel: CHANNEL, kind: "event", event: "terminal", value });
    push(terminal(created.taskId, "session-1"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    push(terminal(created.taskId, "session-1"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const detail = await request("/resident-tasks/" + created.taskId);
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    const detailBody = detail.data as unknown as {
      runs: { id: string; source: string; taskId: string; executionId: string }[];
    };
    assert.equal(detailBody.runs.length, 1);
    assert.equal(detailBody.runs[0].id, "terminal-1");
    assert.equal(detailBody.runs[0].source, "resident");
    assert.equal(detailBody.runs[0].executionId, "exec-1");
    // Resident terminal rows never leak into the scheduled task history.
    const ordinary = await request("/runs");
    assert.deepEqual(ordinary.data.runs, []);

    // A failed stop keeps the task, its metadata and the binding.
    const running = bindings.get(created.taskId)!;
    bindings.set(created.taskId, { ...running, status: "running" });
    failStop = true;
    const blocked = await request("/resident-tasks/" + created.taskId, "DELETE");
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, "stop_failed");
    assert.equal(bindings.size, 1);
    assert.equal((await request("/resident-tasks/" + created.taskId)).status, 200);

    // A successful delete stops first, then unbinds, then drops plugin metadata.
    failStop = false;
    const order: string[] = [];
    const before = requests.length;
    const removed = await request("/resident-tasks/" + created.taskId, "DELETE");
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.deepEqual(removed.data, { removed: true, sessionId: "session-1" });
    for (const message of requests.slice(before))
      if (message.action === "stop" || message.action === "remove")
        order.push(message.action);
    assert.deepEqual(order, ["stop", "remove"]);
    assert.equal(bindings.size, 0);
    assert.deepEqual((await request("/resident-tasks")).data.tasks, []);
    const gone = await request("/resident-tasks/" + created.taskId);
    assert.equal(gone.status, 404);
    assert.equal(gone.data.code, "not_found");
  },
);
