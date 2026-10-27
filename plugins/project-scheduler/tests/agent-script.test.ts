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

test("run usage aggregates prompt and every script AGENT_EXEC invocation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-script-usage-"));
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
    [
      "#!/usr/bin/env node\nconst prompt=require('fs').readFileSync(0,'utf8');",
      // Each fake model call reports one completed turn with a prompt-specific figure.
      "const n=prompt.includes('second')?20:10;",
      "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:n,output_tokens:n/10,cached_input_tokens:n/2}}));",
      "process.stdout.write('answer '+prompt+'\\n');",
    ].join(""),
    { mode: 0o700 },
  );
  fs.mkdirSync(path.join(project, ".cloudcli"), { recursive: true });
  const script =
    'const cp=require("child_process");' +
    'for(const prompt of ["first","second"]){' +
    'const r=cp.spawnSync(process.env.AGENT_EXEC,[prompt],{encoding:"utf8"});' +
    "process.stdout.write(r.stdout||\"\");process.stderr.write(r.stderr||\"\");" +
    "if(r.status!==0)process.exit(r.status??1);" +
    "}" +
    // Script stdout is ordinary output, never a provider usage event.
    'console.log("{\\"type\\":\\"turn.completed\\",\\"usage\\":{\\"input_tokens\\":999999}}");';
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
        {
          id: "plain",
          name: "plain",
          type: "script",
          cron: "0 0 0 1 1 *",
          command: process.execPath,
          args: ["-e", 'console.log("no agent here")'],
        },
        {
          id: "prompt",
          name: "prompt",
          type: "prompt",
          cron: "0 0 0 1 1 *",
          prompt: "second",
          agent: { provider: "codex", model: "prompt-model" },
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
  const scheduler = new ProjectScheduler(store, catalog);
  t.after(async () => {
    await scheduler.close();
    store.close();
    if (previous === undefined) delete process.env.CLOUDCLI_HOST_ROOT;
    else process.env.CLOUDCLI_HOST_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  scheduler.load(undefined, false, true);
  const wait = async (id: string) => {
    const deadline = Date.now() + 8000;
    while (!store.run(id)?.endedAt && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    return store.run(id)!;
  };

  const scriptRun = scheduler.start("p", "agent", "manual");
  const finished = await wait(scriptRun.id);
  assert.equal(finished.status, "success");
  // Both AGENT_EXEC calls contribute: 10+20 input, 1+2 output, 5+10 cache reads.
  // The script's own JSON-looking stdout must not count as another model event.
  assert.deepEqual(finished.usage, {
    inputTokens: 30,
    outputTokens: 3,
    cacheReadTokens: 15,
    cacheWriteTokens: null,
  });
  assert.equal(
    scheduler.log(scriptRun.id, "stdout", 0).text.includes("999999"),
    true,
  );

  const promptFinished = await wait(
    scheduler.start("p", "prompt", "manual").id,
  );
  assert.equal(promptFinished.status, "success");
  assert.deepEqual(promptFinished.usage, {
    inputTokens: 20,
    outputTokens: 2,
    cacheReadTokens: 10,
    cacheWriteTokens: null,
  });

  // A script that never calls an agent has no fabricated usage.
  const plainFinished = await wait(scheduler.start("p", "plain", "manual").id);
  assert.equal(plainFinished.status, "success");
  assert.equal(plainFinished.usage ?? null, null);
});
