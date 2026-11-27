import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test, { type TestContext } from "node:test";
import { environment, pluginRoot, temporaryRoot, tsxLoader, waitFor } from "./helpers.js";
import { WorkerService } from "../server/service.js";

const dead = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

async function startHarness(t: TestContext, type: "pi" | "codex") {
  const root = temporaryRoot(`worker-kill-${type}-`);
  const harness = spawn(
    process.execPath,
    [
      "--import",
      tsxLoader,
      path.join(pluginRoot, "tests/fixtures/plugin-harness.ts"),
      root,
      type,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => {
    try {
      process.kill(harness.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
  });
  let output = "";
  const ready = await new Promise<{ workerId: string; runId: string; data: string }>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("harness did not report ready")), 20000);
      harness.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const line = output.split("\n")[0];
        if (!line?.includes('"ready":true')) return;
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
      harness.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("harness exited before ready: " + output));
      });
    },
  );
  const cliPid = Number(fs.readFileSync(path.join(root, "cli.pid"), "utf8"));
  const childPid = Number(fs.readFileSync(path.join(root, "child.pid"), "utf8"));
  return { harness, ready, cliPid, childPid };
}

test("parent SIGKILL: per-run guardian kills a TERM-resistant CLI tree and writes evidence", async (t) => {
  const { harness, ready, cliPid, childPid } = await startHarness(t, "codex");
  process.kill(harness.pid!, "SIGKILL");
  // TERM is ignored by both fixture processes, so only the 2s SIGKILL escalation can settle this.
  await waitFor(() => dead(cliPid) && dead(childPid), Boolean, 15000);
  const finalFile = path.join(
    ready.data,
    "logs",
    ready.workerId,
    ready.runId,
    "final.json",
  );
  await waitFor(() => fs.existsSync(finalFile), Boolean, 5000);
  const evidence = JSON.parse(fs.readFileSync(finalFile, "utf8"));
  assert.equal(evidence.reason, "disconnect");
  assert.equal(evidence.groupExited, true);
});

test("parent SIGKILL: Pi CLI recovery settles from its guardian evidence and releases the queue", async (t) => {
  const { harness, ready, cliPid, childPid } = await startHarness(t, "pi");
  process.kill(harness.pid!, "SIGKILL");
  await waitFor(() => dead(cliPid) && dead(childPid), Boolean, 15000);

  const root = path.dirname(ready.data);
  const project = path.join(root, "project");
  const runDirectory = path.join(ready.data, "logs", ready.workerId, ready.runId);
  const finalFile = path.join(runDirectory, "final.json");
  await waitFor(() => fs.existsSync(finalFile), Boolean, 5000);
  const evidence = JSON.parse(fs.readFileSync(finalFile, "utf8"));
  assert.equal(evidence.groupExited, true);
  assert.equal(evidence.reason, "disconnect");

  // Hold back the proof to reproduce a restart before the guardian has recorded its exit.
  const heldFinal = finalFile + ".held";
  fs.renameSync(finalFile, heldFinal);
  const service = new WorkerService({
    dataDirectory: ready.data,
    environment: environment(root),
    executablePaths: {
      pi: path.join(pluginRoot, "tests/fixtures/fake-pi.mjs"),
      agy: path.join(root, "missing-agy"),
    },
    guardianCommand: [
      process.execPath,
      "--import",
      tsxLoader,
      path.join(pluginRoot, "server/guardian.ts"),
    ],
  });
  t.after(() => service.close());
  service.registerOwner(
    {
      id: "harness-owner",
      parentSessionId: "harness-parent",
      projectId: "harness-project",
      projectPath: project,
      userId: 1,
      appServerInstanceId: "harness-app",
      paused: false,
    },
    "harness-token",
  );
  service.recoverFromDisk();
  await waitFor(
    () => service.get(ready.workerId).worker.latestRun?.status,
    (status) => status === "unknown",
    5000,
  );
  assert.equal(service.get(ready.workerId).worker.latestRun?.error?.code, "RESTART_UNKNOWN");
  assert.equal(fs.existsSync(finalFile), false);

  const settings = service.settings();
  service.updateSettings({
    configs: settings.configs.map((config) =>
      config.type === "pi" ? { ...config, concurrency: 1 } : config,
    ),
    defaultConfigId: settings.defaultConfigId,
  });
  const queued = await service.start("harness-owner", {
    taskName: "after Pi recovery",
    type: "pi",
    prompt: "finish after recovery",
    workspace: { mode: "existing" },
    writePaths: [],
    requestId: "after-pi-recovery",
  });
  assert.equal(service.get(queued.worker.id).worker.latestRun?.status, "queued");

  fs.renameSync(heldFinal, finalFile);
  const interrupted = await waitFor(
    () => service.get(ready.workerId).worker.latestRun,
    (run) => run?.status === "interrupted",
    5000,
  );
  assert.equal(interrupted?.error?.code, "INTERRUPTED");
  const completed = await waitFor(
    () => service.get(queued.worker.id).worker.latestRun,
    (run) => run?.status === "completed",
    10000,
  );
  assert.equal(completed?.status, "completed");
  assert.equal(service.get(ready.workerId).runs.length, 1);
});
