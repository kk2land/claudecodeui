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

test("parent SIGKILL: shared ACP recovery settles only its confirmed generation and releases the queue", async (t) => {
  const { harness, ready, cliPid, childPid } = await startHarness(t, "pi");
  process.kill(harness.pid!, "SIGKILL");
  await waitFor(() => dead(cliPid) && dead(childPid), Boolean, 15000);

  const root = path.dirname(ready.data);
  const project = path.join(root, "project");
  const runDirectory = path.join(ready.data, "logs", ready.workerId, ready.runId);
  const finalFile = path.join(runDirectory, "final.json");
  // A shared ACP run never writes a per-run terminal guess; only its generation owns that proof.
  assert.equal(fs.existsSync(finalFile), false);
  const specFile = path.join(runDirectory, "spec.json");
  const specText = fs.readFileSync(specFile, "utf8");
  const spec = JSON.parse(specText) as { acp?: { generationId?: string } };
  const generationId = spec.acp?.generationId;
  assert.match(generationId ?? "", /^process-/);
  const generationFinal = path.join(
    ready.data,
    "pi-acp-guardian",
    generationId!,
    "final.json",
  );
  await waitFor(() => fs.existsSync(generationFinal), Boolean, 15000);
  const generationEvidence = JSON.parse(fs.readFileSync(generationFinal, "utf8"));
  assert.equal(generationEvidence.groupExited, true);
  assert.equal(generationEvidence.reason, "disconnect");

  // Reopen after the guardian proof exists on disk, but hold it back to reproduce the restart
  // window where recovery sees an unknown run and a still-confirmed-independent generation.
  const heldFinal = generationFinal + ".held";
  fs.renameSync(generationFinal, heldFinal);
  const service = new WorkerService({
    dataDirectory: ready.data,
    environment: environment(root),
    executablePaths: {
      pi: path.join(pluginRoot, "tests/fixtures/fake-pi.mjs"),
      "pi-acp": path.join(pluginRoot, "tests/fixtures/fake-pi-acp.mjs"),
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
    taskName: "after shared recovery",
    type: "pi",
    prompt: "finish after recovery",
    workspace: { mode: "existing" },
    writePaths: [],
    requestId: "after-shared-recovery",
  });
  assert.equal(service.get(queued.worker.id).worker.latestRun?.status, "queued");

  // A different generation's confirmed evidence must not release this run or its queue.
  const otherSpec = JSON.parse(specText) as { acp?: Record<string, unknown> };
  otherSpec.acp = { ...otherSpec.acp, generationId: "process-00000000-0000-4000-8000-000000000000" };
  fs.writeFileSync(specFile, JSON.stringify(otherSpec), { mode: 0o600 });
  fs.renameSync(heldFinal, generationFinal);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(service.get(ready.workerId).worker.latestRun?.status, "unknown");
  assert.equal(service.get(queued.worker.id).worker.latestRun?.status, "queued");

  // Restoring the exact generation link lets the next reminder settle as interrupted once.
  fs.writeFileSync(specFile, specText, { mode: 0o600 });
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
