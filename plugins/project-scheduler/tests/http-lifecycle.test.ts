import assert from "node:assert/strict";
import test from "node:test";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SchedulerRun } from "../shared/contracts.js";

test(
  "authenticated plugin lifecycle, real seconds cron, restart recovery, and private settings",
  { timeout: 20000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-http-")),
      project = path.join(root, "project");
    fs.mkdirSync(path.join(project, ".cloudcli"), { recursive: true });
    const catalog = path.join(root, "projects.json");
    fs.writeFileSync(
      catalog,
      JSON.stringify({
        generatedAt: Date.now(),
        projects: [{ id: "p", name: "project", path: project }],
      }),
    );
    fs.writeFileSync(
      path.join(project, ".cloudcli/project-schedules.json"),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "tick",
            type: "script",
            cron: "* * * * * *",
            command: process.execPath,
            args: [
              "-e",
              'console.log(process.env.CLOUDCLI_PLUGIN_TOKEN || "no-token")',
            ],
          },
          {
            id: "slow",
            type: "script",
            cron: "0 0 0 1 1 *",
            command: process.execPath,
            args: ["-e", "setInterval(()=>{},1000)"],
          },
        ],
      }),
    );
    const children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await once(child, "close").catch(() => {});
        }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const boot = async () => {
      const child = fork(
        fileURLToPath(new URL("../dist/server.mjs", import.meta.url)),
        [],
        {
          execArgv: [],
          env: {
            ...process.env,
            CLOUDCLI_PLUGIN_TOKEN: "private-test-token",
            CLOUDCLI_PLUGIN_DATA_DIR: path.join(root, "data"),
            CLOUDCLI_PROJECTS_FILE: catalog,
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      children.push(child);
      const port = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Plugin did not start")),
          5000,
        );
        let buffer = "",
          stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error(stderr));
        });
        child.stdout?.on("data", (chunk) => {
          buffer += String(chunk);
          for (const line of buffer.split("\n"))
            try {
              const value = JSON.parse(line) as {
                ready?: boolean;
                port: number;
              };
              if (value.ready) {
                clearTimeout(timeout);
                resolve(value.port);
              }
            } catch {
              /* wait for readiness line */
            }
        });
      });
      const request = async (route: string, method = "GET", body?: unknown) => {
        const response = await fetch("http://127.0.0.1:" + port + route, {
          method,
          headers: {
            authorization: "Bearer private-test-token",
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = (await response.json()) as any;
        assert.equal(response.status, 200, JSON.stringify(data));
        return data;
      };
      return { child, port, request };
    };
    const first = await boot();
    assert.equal(
      (await fetch("http://127.0.0.1:" + first.port + "/tasks")).status,
      401,
    );
    await first.request("/load", "POST", { apply: true });
    const configFile = path.join(project, ".cloudcli/project-schedules.json");
    const originalConfig = fs.readFileSync(configFile, "utf8");
    await first.request("/tasks/enabled", "PUT", { projectId: "p", taskId: "slow", enabled: false });
    let slow = (await first.request("/tasks")).tasks.find((task: { taskId: string }) => task.taskId === "slow");
    assert.equal(slow.definition.enabled, false);
    assert.equal(slow.nextRun, null);
    assert.equal(fs.readFileSync(configFile, "utf8"), originalConfig);
    for (const body of [
      { projectId: "p", taskId: "slow", enabled: "false" },
      { projectId: "p", taskId: "slow" },
      { projectId: "p", taskId: "unknown", enabled: true },
      { projectId: "unknown", taskId: "slow", enabled: true },
    ]) {
      const response = await fetch("http://127.0.0.1:" + first.port + "/tasks/enabled", {
        method: "PUT",
        headers: { authorization: "Bearer private-test-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    slow = (await first.request("/tasks")).tasks.find((task: { taskId: string }) => task.taskId === "slow");
    assert.equal(slow.definition.enabled, false);
    await first.request("/load", "POST", { projectIds: ["p"], apply: true });
    slow = (await first.request("/tasks")).tasks.find((task: { taskId: string }) => task.taskId === "slow");
    assert.equal(slow.definition.enabled, true);
    const until = async <T>(
      read: () => Promise<T>,
      valid: (value: T) => boolean,
    ): Promise<T> => {
      const end = Date.now() + 6000;
      while (Date.now() < end) {
        const result = await read();
        if (valid(result)) return result;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Expected plugin state not observed");
    };
    const history = await until(
      () =>
        first.request("/runs?projectId=p&taskId=tick") as Promise<{
          runs: SchedulerRun[];
        }>,
      (value) => value.runs.some((run) => run.status === "success"),
    );
    const tick = history.runs.find((run) => run.status === "success")!;
    assert.equal(
      (await first.request("/runs/" + tick.id + "/log")).text.trim(),
      "no-token",
    );
    const settings = await first.request("/settings", "PUT", {
      telegram: { enabled: false, botToken: "123:fake_secret", chatId: "456" },
    });
    assert.equal(settings.telegram.botTokenConfigured, true);
    assert.equal(JSON.stringify(settings).includes("fake_secret"), false);
    const { run } = (await first.request("/run", "POST", {
      projectId: "p",
      taskId: "slow",
    })) as { run: SchedulerRun };
    const exited = once(first.child, "close");
    first.child.kill("SIGKILL");
    await exited;
    const second = await boot();
    const recovered = await until(
      () =>
        second.request("/runs?projectId=p&taskId=slow") as Promise<{
          runs: SchedulerRun[];
        }>,
      (result) =>
        result.runs.some(
          (item) => item.id === run.id && item.status === "interrupted",
        ),
    );
    assert.equal(
      recovered.runs.filter((item) => item.taskId === "slow").length,
      1,
    );
    const reloaded = await second.request("/tasks");
    assert.equal(reloaded.tasks.length, 2);
    fs.writeFileSync(
      catalog,
      JSON.stringify({ generatedAt: Date.now(), projects: [] }),
    );
    assert.equal((await second.request("/tasks")).tasks.length, 0);
  },
);
