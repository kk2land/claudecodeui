import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { pluginRoot, temporaryRoot, tsxLoader, waitFor } from "./helpers.js";

test("parent SIGKILL: guardian kills a TERM-resistant CLI tree and writes evidence", async (t) => {
  const root = temporaryRoot("worker-kill-");
  const harness = spawn(
    process.execPath,
    ["--import", tsxLoader, path.join(pluginRoot, "tests/fixtures/plugin-harness.ts"), root],
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
  process.kill(harness.pid!, "SIGKILL");
  const dead = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
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
