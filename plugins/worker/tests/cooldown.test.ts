import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { WorkerConfig } from "../shared/contracts.js";
import { WorkerService } from "../server/service.js";
import {
  codexFixture,
  createService,
  environment,
  piFixture,
  startInput,
  temporaryRoot,
  waitStatus,
} from "./helpers.js";

function config(type: "pi" | "codex" | "agy", id = type + "-default"): WorkerConfig {
  return {
    id,
    name: id,
    type,
    enabled: true,
    roles: [],
    concurrency: 3,
    hardTimeoutSeconds: 600,
    model: null,
    effort: null,
    ...(type === "codex"
      ? { codex: { modelProvider: "magpie", env: {}, legacyExtraArgs: [] } }
      : {}),
  };
}

function configure(
  service: WorkerService,
  configs: WorkerConfig[] = [config("pi"), config("codex"), config("agy")],
): void {
  service.updateSettings({ configs, defaultConfigId: configs[0]!.id });
}

function script(root: string, name: string, stderr: string, events: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.stdout.write(${JSON.stringify(events)});\nprocess.exit(1);\n`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function resetCase(root: string, duration: string, name = "agy-reset.mjs"): string {
  const init = JSON.stringify({
    event: "init",
    conversation_id: "conversation-429",
    init: { cwd: path.join(root, "project") },
  });
  return script(
    root,
    name,
    'AGY_ERROR {"error_code":429,"message":"quota exceeded"}\nResets in ' + duration + "\n",
    init + "\n",
  );
}

function deferredCase(root: string): string {
  const file = path.join(root, "agy-deferred.mjs");
  const durations = { long: "2h", short: "10s" };
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
const model = process.argv[process.argv.indexOf("--model") + 1];
const trigger = ${JSON.stringify(root)} + "/release-" + model;
const duration = ${JSON.stringify(durations)}[model];
console.log(JSON.stringify({
  event: "init",
  conversation_id: "conversation-" + model,
  init: { cwd: ${JSON.stringify(path.join(root, "project"))} },
}));
while (!fs.existsSync(trigger)) await new Promise((resolve) => setTimeout(resolve, 20));
console.error('AGY_ERROR {"error_code":429,"message":"quota exceeded"}');
console.error("Resets in " + duration);
process.exit(1);
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function modelConfig(id: string, model: string): WorkerConfig {
  return { ...config("agy", id), model };
}

function structuredCase(root: string): string {
  const events = [
    {
      event: "init",
      conversation_id: "conversation-1",
      init: { cwd: path.join(root, "project") },
    },
    {
      event: "result",
      result: {
        conversation_id: "conversation-1",
        status: "RESOURCE_EXHAUSTED",
        error: "quota exhausted: RESOURCE_EXHAUSTED (code 429)",
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  return script(root, "agy-structured.mjs", "", events + "\n");
}

test("agy stderr 429 sets the parsed global deadline and keeps the failed run resumable", async (t) => {
  const root = temporaryRoot("worker-agy-stderr-");
  const now = Date.now();
  const { service } = createService(t, root, {}, {
    executablePaths: { agy: resetCase(root, "2h2m18s") },
    now: () => now,
  });
  configure(service);
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "agy-429" }),
  );
  const failed = await waitStatus(service, started.worker.id, ["failed"]);
  assert.equal(failed.latestRun?.status, "failed");
  assert.equal(
    Date.parse(service.overview().agyCooldownUntil!) - now,
    ((2 * 60 + 2) * 60 + 18) * 1000,
  );
  const resumed = await service.resume("owner-1", {
    workerId: failed.id,
    prompt: "retry after quota",
    requestId: "agy-429-resume",
  });
  assert.equal(resumed.run.status, "queued");
});

test("agy structured RESOURCE_EXHAUSTED 429 without a reset hint falls back to 60 seconds", async (t) => {
  const root = temporaryRoot("worker-agy-structured-");
  const now = Date.now();
  const { service } = createService(t, root, {}, {
    executablePaths: { agy: structuredCase(root) },
    now: () => now,
  });
  configure(service);
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "agy-structured" }),
  );
  await waitStatus(service, started.worker.id, ["failed"]);
  assert.equal(Date.parse(service.overview().agyCooldownUntil!) - now, 60_000);
});

test("cooldown blocks every agy config while Pi dispatches, and a later shorter 429 cannot shorten an active deadline", async (t) => {
  const root = temporaryRoot("worker-agy-cross-");
  const now = Date.now();
  const { service } = createService(t, root, {}, {
    executablePaths: {
      pi: piFixture,
      codex: codexFixture,
      agy: deferredCase(root),
    },
    now: () => now,
  });
  configure(service, [
    config("pi"),
    modelConfig("agy-long", "long"),
    modelConfig("agy-short", "short"),
  ]);
  // Both agy processes are running before either settles.
  const long = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-long", requestId: "long" }),
  );
  const short = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-short", requestId: "short" }),
  );
  await waitStatus(service, long.worker.id, ["running"]);
  await waitStatus(service, short.worker.id, ["running"]);

  // The earlier-finishing process stores the longer deadline.
  fs.writeFileSync(path.join(root, "release-long"), "");
  await waitStatus(service, long.worker.id, ["failed"]);
  const firstDeadline = Date.parse(service.overview().agyCooldownUntil!);
  assert.equal(firstDeadline - now, 2 * 3600 * 1000);

  const blocked = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-short", requestId: "blocked" }),
  );
  assert.equal(blocked.run.status, "queued");

  const pi = await service.start("owner-1", startInput({ type: "pi", requestId: "pi-during" }));
  assert.equal((await waitStatus(service, pi.worker.id, ["completed"])).latestRun?.status, "completed");

  // A later failure with a shorter deadline must keep the already-active latest deadline.
  fs.writeFileSync(path.join(root, "release-short"), "");
  await waitStatus(service, short.worker.id, ["failed"]);
  assert.equal(Date.parse(service.overview().agyCooldownUntil!), firstDeadline);
});

test("a queued agy run resumes automatically when the deadline expires", async (t) => {
  const root = temporaryRoot("worker-agy-expiry-");
  const { service } = createService(t, root, {}, {
    executablePaths: { agy: resetCase(root, "1s", "agy-expiry.mjs") },
  });
  configure(service);
  const first = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "expiry-first" }),
  );
  await waitStatus(service, first.worker.id, ["failed"]);
  const queued = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "expiry-queued" }),
  );
  assert.equal(queued.run.status, "queued");
  // The timer releases the queued run; the fixture fails again, proving it was dispatched.
  await waitStatus(service, queued.worker.id, ["failed"], 10_000);
});

test("the stored deadline and queued agy run survive a real close and reopen", async (t) => {
  const root = temporaryRoot("worker-agy-restart-");
  const { service, data, project } = createService(t, root, {}, {
    executablePaths: { agy: resetCase(root, "2h", "agy-restart.mjs") },
  });
  configure(service);
  const started = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "restart-first" }),
  );
  await waitStatus(service, started.worker.id, ["failed"]);
  const deadline = service.overview().agyCooldownUntil;
  const blocked = await service.start(
    "owner-1",
    startInput({ type: "agy", configId: "agy-default", requestId: "restart-queued" }),
  );
  assert.equal(blocked.run.status, "queued");
  await service.close();

  const reopened = new WorkerService({
    dataDirectory: data,
    environment: environment(root),
    executablePaths: { agy: resetCase(root, "2h", "agy-restart.mjs") },
  });
  t.after(() => reopened.close());
  reopened.registerOwner(
    {
      id: "owner-1",
      parentSessionId: "parent-1",
      projectId: "project-1",
      projectPath: project,
      userId: 7,
      appServerInstanceId: "app-1",
      paused: false,
    },
    "owner-token",
  );
  reopened.recoverFromDisk();
  assert.deepEqual(reopened.overview().agyCooldownUntil, deadline);
  assert.equal(reopened.get(blocked.worker.id).worker.latestRun?.status, "queued");
});
