import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WorkerStore } from "../server/store.js";
import { pluginRoot, temporaryRoot } from "./helpers.js";

const builtEntry = path.join(pluginRoot, "dist/server.mjs");

function ensureBuiltEntry(): void {
  const sources = [
    "server/entry.ts",
    "server/service.ts",
    "server/guardian.ts",
    "server/store.ts",
    "server/native.ts",
    "shared/contracts.ts",
  ];
  const newest = Math.max(
    ...sources.map((source) => fs.statSync(path.join(pluginRoot, source)).mtimeMs),
  );
  const built = fs.existsSync(builtEntry) ? fs.statSync(builtEntry).mtimeMs : 0;
  if (built >= newest) return;
  const result = spawnSync(process.execPath, ["scripts/build-builtin-plugins.mjs"], {
    cwd: path.resolve(pluginRoot, "../.."),
    stdio: "inherit",
  });
  assert.equal(result.status, 0, "the bundled Worker entry failed to build");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("losing the host IPC channel stops active DSH and its TERM-resistant tree", { timeout: 60_000 }, async (t) => {
  ensureBuiltEntry();
  const root = temporaryRoot("worker-entry-disconnect-");
  const project = path.join(root, "project");
  const data = path.join(root, "data");
  const bin = path.join(root, "bin");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const cliPidFile = path.join(root, "cli.pid");
  const groupPidFile = path.join(root, "group.pid");
  fs.writeFileSync(
    path.join(bin, "dsh"),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(pluginRoot, "tests/fixtures/fake-dsh.mjs")}" "$@"\n`,
    { mode: 0o755 },
  );

  const child = spawn(process.execPath, [builtEntry], {
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: path.join(root, "home"),
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      DSH_HOME: path.join(root, "dsh-home"),
      TEST_SCENARIO: "hangtree",
      TEST_SESSION_ID: "disconnect-session",
      TEST_CLI_PID_FILE: cliPidFile,
      TEST_PID_FILE: groupPidFile,
      CLOUDCLI_PLUGIN_TOKEN: "disconnect-ui-token",
      CLOUDCLI_PLUGIN_DATA_DIR: data,
      CLOUDCLI_HOST_ROOT: pluginRoot,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  let workerId = "";
  let runId = "";
  t.after(() => {
    try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ }
    for (const file of [cliPidFile, groupPidFile]) {
      try { process.kill(Number(fs.readFileSync(file, "utf8")), "SIGKILL"); } catch { /* gone */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error("Worker entry did not become ready")), 20_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split("\n")) {
        if (!line.includes('"ready":true')) continue;
        clearTimeout(timer);
        resolve((JSON.parse(line) as { port: number }).port);
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Worker entry exited early: ${stderr}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const registered = await new Promise<{ ok: boolean }>((resolve) => {
    child.once("message", (message: { kind?: string; ok?: boolean }) => {
      if (message.kind === "response") resolve(message as { ok: boolean });
    });
    child.send!({
      channel: "cloudcli-workers",
      id: "register-1",
      kind: "request",
      action: "registerOwner",
      payload: {
        owner: {
          id: "disconnect-owner",
          parentSessionId: "disconnect-parent",
          projectId: "disconnect-project",
          projectPath: project,
          userId: 1,
          appServerInstanceId: "disconnect-app",
          paused: false,
        },
        token: "disconnect-owner-token",
      },
    });
  });
  assert.equal(registered.ok, true);

  const client = new Client({ name: "entry-disconnect", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/api/worker-mcp`), {
    requestInit: { headers: { authorization: "Bearer disconnect-owner-token" } },
  });
  await client.connect(transport);
  const result = await client.callTool({
    name: "worker_start",
    arguments: {
      taskName: "disconnect cleanup",
      type: "dsh",
      prompt: "run until the host disconnects",
      workspace: { mode: "existing" },
      writePaths: [],
      requestId: "disconnect-run",
    },
  });
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  const started = JSON.parse(content?.find((item) => item.type === "text")?.text ?? "{}") as {
    worker: { id: string };
    run: { id: string };
  };
  workerId = started.worker.id;
  runId = started.run.id;

  const deadline = Date.now() + 15_000;
  while (
    (!fs.existsSync(cliPidFile) || !fs.existsSync(groupPidFile)) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(fs.existsSync(cliPidFile) && fs.existsSync(groupPidFile), "fixture process tree did not start");
  const cliPid = Number(fs.readFileSync(cliPidFile, "utf8"));
  const groupPid = Number(fs.readFileSync(groupPidFile, "utf8"));
  assert.equal(alive(cliPid), true);
  assert.equal(alive(groupPid), true);

  await client.close();
  child.disconnect();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.equal(child.exitCode, 0, stderr);

  assert.equal(alive(cliPid), false, "the CLI must be gone after host IPC disconnect");
  assert.equal(alive(groupPid), false, "the TERM-resistant grandchild must be killed");

  const store = new WorkerStore(data);
  try {
    const run = store.latestRun(workerId);
    assert.equal(run?.id, runId);
    assert.equal(run?.status, "cancelled");
    assert.equal(store.notifications().find((item) => item.runId === runId)?.delivery, "held");
  } finally {
    store.close();
  }
  const evidence = JSON.parse(
    fs.readFileSync(path.join(data, "logs", workerId, runId, "final.json"), "utf8"),
  ) as { groupExited: boolean; reason: string };
  assert.equal(evidence.groupExited, true);
  assert.ok(["cancelled", "disconnect"].includes(evidence.reason));
});
