import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { WorkerFailure } from "../server/shared/index.js";
import {
  createService,
  owner,
  startInput,
  temporaryRoot,
  waitStatus,
} from "./helpers.js";

test("input returns the prompt each run was launched with", async (t) => {
  const root = temporaryRoot("worker-input-");
  const { service, data } = createService(t, root);
  const started = await service.start(
    "owner-1",
    startInput({ prompt: "真实输入内容" }),
  );
  const worker = await waitStatus(service, started.worker.id, ["completed"]);
  const runId = worker.latestRun!.id;
  assert.deepEqual(service.input(worker.id, {}), { prompt: "真实输入内容" });
  assert.deepEqual(service.input(worker.id, { runId }), {
    prompt: "真实输入内容",
  });
  // The run directory is the durable source, not the in-memory prompt map.
  assert.equal(
    fs.readFileSync(
      path.join(data, "logs", worker.id, runId, "prompt.md"),
      "utf8",
    ),
    "真实输入内容",
  );

  const resumed = await service.resume("owner-1", {
    workerId: worker.id,
    prompt: "续接输入",
    requestId: "resume-input-1",
  });
  await waitStatus(service, worker.id, ["completed"]);
  assert.deepEqual(service.input(worker.id, { runId: resumed.run.id }), {
    prompt: "续接输入",
  });
  assert.deepEqual(service.input(worker.id, { runId }), {
    prompt: "真实输入内容",
  });
});

test("input is null when no prompt record survives", async (t) => {
  const root = temporaryRoot("worker-input-missing-");
  const { service, data } = createService(t, root);
  const started = await service.start("owner-1", startInput());
  const worker = await waitStatus(service, started.worker.id, ["completed"]);
  const runId = worker.latestRun!.id;
  fs.rmSync(path.join(data, "logs", worker.id, runId, "prompt.md"));
  // Finished runs drop the accepted prompt, so there is nothing left to return and nothing
  // is substituted from the task name or the current configuration.
  assert.deepEqual(service.input(worker.id, { runId }), { prompt: null });
});

test("input keeps the accepted prompt of a run that has not launched yet", async (t) => {
  const root = temporaryRoot("worker-input-queued-");
  const { service, data } = createService(t, root, { TEST_SCENARIO: "hang" });
  const settings = service.state({}).settings;
  const configs = settings.configs.map((config) => ({ ...config, concurrency: 1 }));
  service.updateSettings({ configs, defaultConfigId: settings.defaultConfigId });
  const running = await service.start("owner-1", startInput({ requestId: "queued-a" }));
  await waitStatus(service, running.worker.id, ["running"]);
  const queued = await service.start(
    "owner-1",
    startInput({ requestId: "queued-b", prompt: "排队中的输入" }),
  );
  assert.equal(queued.run.status, "queued");
  assert.equal(
    fs.existsSync(
      path.join(data, "logs", queued.worker.id, queued.run.id, "prompt.md"),
    ),
    false,
  );
  assert.deepEqual(service.input(queued.worker.id, { runId: queued.run.id }), {
    prompt: "排队中的输入",
  });
});

test("input rejects runs of another worker and other-owner reads", async (t) => {
  const root = temporaryRoot("worker-input-guard-");
  const { service } = createService(t, root);
  const first = await service.start(
    "owner-1",
    startInput({ requestId: "guard-a", prompt: "第一个" }),
  );
  await waitStatus(service, first.worker.id, ["completed"]);
  const second = await service.start(
    "owner-1",
    startInput({ requestId: "guard-b", prompt: "第二个" }),
  );
  await waitStatus(service, second.worker.id, ["completed"]);

  const wrongRun = () =>
    service.input(first.worker.id, { runId: second.run.id });
  assert.throws(wrongRun, (error: WorkerFailure) => error.code === "RUN_NOT_FOUND");
  assert.throws(
    () => service.input("worker-missing", {}),
    (error: WorkerFailure) => error.code === "WORKER_NOT_FOUND",
  );

  const other = path.join(root, "other-project");
  fs.mkdirSync(other, { recursive: true });
  service.registerOwner(
    {
      ...owner(other),
      id: "owner-2",
      parentSessionId: "parent-2",
      projectId: "project-2",
    },
    "owner-token-2",
  );
  assert.throws(
    () => service.input(first.worker.id, {}, "owner-2"),
    (error: WorkerFailure) => error.code === "WORKER_NOT_FOUND",
  );
  assert.deepEqual(service.input(first.worker.id, {}, "owner-1"), {
    prompt: "第一个",
  });
});
