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
  { timeout: 30000 },
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
              'console.log((process.env.CLOUDCLI_PLUGIN_TOKEN || "no-token") + ":" + (process.env.GLOBAL_TEST || "none"))',
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
      "no-token:none",
    );
    const settings = await first.request("/settings", "PUT", {
      telegram: { enabled: false, botToken: "123:fake_secret", chatId: "456" },
    });
    assert.equal(settings.telegram.botTokenConfigured, true);
    assert.equal(JSON.stringify(settings).includes("fake_secret"), false);
    const saved = await first.request("/settings", "PUT", {
      env: { GLOBAL_TEST: "v1" },
    });
    assert.deepEqual(saved.env, { GLOBAL_TEST: "v1" });
    // The next cron tick reads the saved environment without a plugin reload.
    const nextTick = await until(
      async () => {
        const data = (await first.request("/runs?projectId=p&taskId=tick")) as {
          runs: SchedulerRun[];
        };
        const fresh = data.runs.find(
          (item) =>
            item.status === "success" && item.startedAt > tick.startedAt,
        );
        if (!fresh) return "";
        return ((await first.request("/runs/" + fresh.id + "/log")) as {
          text: string;
        }).text.trim();
      },
      (text) => text === "no-token:v1",
    );
    assert.equal(nextTick, "no-token:v1");
    // Reserved names fail the request and never echo the submitted value.
    for (const env of [
      { AGENT_EXEC: "/tmp/evil" },
      { CLOUDCLI_PLUGIN_TOKEN: "stolen" },
      { BAD: 1 },
      [],
    ]) {
      const response = await fetch("http://127.0.0.1:" + first.port + "/settings", {
        method: "PUT",
        headers: {
          authorization: "Bearer private-test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ env }),
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error.includes("stolen"), false);
      assert.equal(body.error.includes("/tmp/evil"), false);
    }
    assert.deepEqual((await first.request("/settings")).env, { GLOBAL_TEST: "v1" });
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

test(
  "configuration endpoints read, preview, save, reject unsafe requests, and report conflicts over HTTP",
  { timeout: 30000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-config-http-")),
      project = path.join(root, "project"),
      outside = path.join(root, "outside");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(outside);
    const catalog = path.join(root, "projects.json");
    fs.writeFileSync(
      catalog,
      JSON.stringify({
        generatedAt: Date.now(),
        projects: [{ id: "p", name: "project", path: project }],
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
            CLOUDCLI_PLUGIN_TOKEN: "configuration-token",
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
      const raw = (route: string, method = "GET", body?: unknown) =>
        fetch("http://127.0.0.1:" + port + route, {
          method,
          headers: {
            authorization: "Bearer configuration-token",
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const request = async (route: string, method = "GET", body?: unknown) => {
        const response = await raw(route, method, body);
        const data = (await response.json()) as any;
        assert.equal(response.status, 200, JSON.stringify(data));
        return data;
      };
      return { child, port, raw, request };
    };
    const server = await boot();
    const file = path.join(project, ".cloudcli/project-schedules.json");
    assert.equal(
      (await fetch("http://127.0.0.1:" + server.port + "/configuration?projectId=p"))
        .status,
      401,
    );
    // Reading a missing file returns an empty draft and never creates the directory.
    const empty = await server.request("/configuration?projectId=p");
    assert.equal(empty.exists, false);
    assert.equal(empty.revision, null);
    assert.deepEqual(JSON.parse(empty.text), { version: 1, tasks: [] });
    assert.equal(empty.project.id, "p");
    assert.equal(empty.project.path, project);
    assert.equal(fs.existsSync(path.join(project, ".cloudcli")), false);

    const text = JSON.stringify(
      {
        version: 1,
        "x-keep": { owner: "ops" },
        tasks: [
          {
            id: "nightly",
            type: "script",
            cron: "0 0 0 1 1 *",
            command: process.execPath,
            args: ["-e", "1"],
            "x-task": "keep",
          },
        ],
      },
      null,
      2,
    );
    // Preview validates without writing; the task list carries real upcoming timestamps.
    const preview = await server.request("/configuration/preview", "POST", {
      projectId: "p",
      text,
    });
    assert.equal(preview.valid, true);
    assert.deepEqual(preview.changes, {
      added: 1,
      updated: 0,
      removed: 0,
      reEnabled: 0,
    });
    assert.equal(preview.tasks[0].taskId, "nightly");
    assert.equal(preview.tasks[0].nextRuns.length, 5);
    assert.ok(
      preview.tasks[0].nextRuns.every((run: string) =>
        Number.isFinite(Date.parse(run)),
      ),
    );
    assert.equal(fs.existsSync(file), false);
    const invalidPreview = await server.request(
      "/configuration/preview",
      "POST",
      { projectId: "p", text: '{"version":1,"tasks":[{"id":"x"' },
    );
    assert.equal(invalidPreview.valid, false);
    assert.ok(invalidPreview.errors.length > 0);
    assert.equal(fs.existsSync(file), false);

    const saved = await server.request("/configuration/save", "POST", {
      projectId: "p",
      text,
      revision: null,
    });
    assert.equal(saved.saved, true);
    assert.equal(saved.loaded, true);
    assert.equal(saved.conflict, undefined);
    assert.equal(saved.revision.length, 64);
    assert.equal(fs.readFileSync(file, "utf8"), text);
    const document = await server.request("/configuration?projectId=p");
    assert.equal(document.exists, true);
    assert.equal(document.revision, saved.revision);
    assert.equal(document.text, text);
    assert.equal(document.error, undefined);
    // The saved task is loaded and scheduled without a separate /load call.
    const tasks = (await server.request("/tasks")).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].taskId, "nightly");
    assert.ok(tasks[0].nextRun);
    assert.equal((await server.request("/projects")).projects[0].id, "p");

    // A stale revision is reported as a 200 conflict with the current document.
    const external = text.replace('"owner": "ops"', '"owner": "external"');
    fs.writeFileSync(file, external);
    const conflict = await server.request("/configuration/save", "POST", {
      projectId: "p",
      text,
      revision: saved.revision,
    });
    assert.equal(conflict.saved, false);
    assert.equal(conflict.loaded, false);
    assert.equal(conflict.conflict, true);
    assert.match(conflict.latest.text, /external/);
    assert.equal(conflict.revision, conflict.latest.revision);
    assert.equal(fs.readFileSync(file, "utf8"), conflict.latest.text);
    assert.equal(fs.readFileSync(file, "utf8"), external);

    // Invalid JSON stays readable with its revision and error so the client can repair it.
    const broken = '{ "version": 1, "tasks": [ }';
    fs.writeFileSync(file, broken);
    const damaged = await server.request("/configuration?projectId=p");
    assert.equal(damaged.exists, true);
    assert.equal(damaged.text, broken);
    assert.equal(damaged.revision.length, 64);
    assert.match(damaged.error, /JSON 无效/);

    // Transport and allowlist violations are 400s; the project path is never accepted.
    for (const [route, method, body] of [
      ["/configuration?projectId=missing", "GET", undefined],
      ["/configuration", "GET", undefined],
      ["/configuration/preview", "POST", { projectId: "missing", text }],
      ["/configuration/preview", "POST", { projectId: "p" }],
      ["/configuration/preview", "POST", { projectId: "", text }],
      ["/configuration/save", "POST", { projectId: "p", text, revision: 7 }],
      // An omitted revision must be rejected instead of silently creating the file.
      ["/configuration/save", "POST", { projectId: "p", text }],
      ["/configuration/save", "POST", { projectId: "p", text, revision: undefined }],
      ["/configuration/save", "POST", { projectId: outside, text, revision: null }],
      ["/configuration/save", "POST", { text, revision: null }],
    ] as const) {
      const response = await server.raw(route, method, body);
      assert.equal(response.status, 400, route + " " + method);
    }
    assert.equal(fs.readFileSync(file, "utf8"), broken);
    // A symlinked configuration directory is refused without touching the outside file.
    const outsideFile = path.join(outside, "project-schedules.json");
    fs.writeFileSync(outsideFile, text);
    fs.rmSync(path.join(project, ".cloudcli"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(project, ".cloudcli"));
    const escaped = await server.request("/configuration?projectId=p");
    assert.match(escaped.error, /项目外/);
    const blocked = await server.request("/configuration/save", "POST", {
      projectId: "p",
      text,
      revision: null,
    });
    assert.equal(blocked.saved, false);
    assert.equal(blocked.loaded, false);
    assert.match(blocked.error, /项目外/);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), text);
    // Removing the project from the allowlist invalidates further configuration requests.
    fs.writeFileSync(
      catalog,
      JSON.stringify({ generatedAt: Date.now(), projects: [] }),
    );
    const archived = await server.raw("/configuration?projectId=p");
    assert.equal(archived.status, 400);
  },
);
