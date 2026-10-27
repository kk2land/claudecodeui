import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SchedulerStore } from "../server/store.js";
import { ProjectScheduler } from "../server/scheduler.js";

test("script AGENT_EXEC invokes the configured provider and model and returns readable stdout", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-script-agent-"));
  const project = path.join(root, "project");
  const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
  const suffix =
    process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
  const pkg = path.join(
    root,
    "node_modules/@openai/codex-" + process.platform + "-" + process.arch,
  );
  const binary = path.join(pkg, "vendor", cpu + "-" + suffix, "bin/codex");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    binary,
    // No turn.completed event: AGENT_EXEC must still succeed on a normal zero exit.
    '#!/usr/bin/env node\nconst prompt=require("fs").readFileSync(0,"utf8");console.log(JSON.stringify({type:"item.completed",item:{id:"answer",type:"agent_message",text:process.argv.join("|")+"\\n"+prompt+"\\nGLOBAL="+(process.env.GLOBAL_AGENT_EXEC||"none")}}));',
    { mode: 0o700 },
  );
  fs.mkdirSync(path.join(project, ".cloudcli"), { recursive: true });
  const script =
    'const r=require("child_process").spawnSync(process.env.AGENT_EXEC,["literal $HOME; quote \\" and\\n多行"],{encoding:"utf8"});process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");process.exit(r.status??1)';
  fs.writeFileSync(
    path.join(project, ".cloudcli/project-schedules.json"),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: "agent",
          type: "script",
          cron: "0 0 0 1 1 *",
          command: process.execPath,
          args: ["-e", script],
          agent: { provider: "codex", model: "script-model" },
        },
      ],
    }),
  );
  const catalog = path.join(root, "projects.json");
  fs.writeFileSync(
    catalog,
    JSON.stringify({
      generatedAt: Date.now(),
      projects: [{ id: "p", name: "project", path: project }],
    }),
  );
  const previous = process.env.CLOUDCLI_HOST_ROOT;
  process.env.CLOUDCLI_HOST_ROOT = root;
  const store = new SchedulerStore(path.join(root, "data"));
  // Saved settings must reach the script and the AGENT_EXEC child it spawns.
  store.saveSettings({ ...store.settings(), env: { GLOBAL_AGENT_EXEC: "shared" } });
  const scheduler = new ProjectScheduler(store, catalog);
  t.after(async () => {
    await scheduler.close();
    store.close();
    if (previous === undefined) delete process.env.CLOUDCLI_HOST_ROOT;
    else process.env.CLOUDCLI_HOST_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  scheduler.load(undefined, false, true);
  const run = scheduler.start("p", "agent", "manual");
  const deadline = Date.now() + 8000;
  while (!store.run(run.id)?.endedAt && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(store.run(run.id)?.status, "success");
  const output = scheduler.log(run.id, "stdout", 0).text;
  assert.match(output, /--ephemeral\|--json\|--model\|script-model/);
  assert.match(output, /literal \$HOME; quote " and\n多行/);
  assert.match(output, /GLOBAL=shared/);
});
