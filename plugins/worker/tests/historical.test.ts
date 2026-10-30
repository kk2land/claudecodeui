import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { WorkerService } from "../server/service.js";
import type { WorkerOwner } from "../shared/contracts.js";
import {
  dshFixture,
  environment,
  guardianSource,
  piFixture,
  pluginRoot,
  startInput,
  temporaryRoot,
  tsxLoader,
  waitStatus,
} from "./helpers.js";

function generation(
  root: string,
  project: string,
  id: string,
  parent = "parent-1",
): WorkerOwner {
  return {
    id,
    parentSessionId: parent,
    projectId: "project-1",
    projectPath: project,
    userId: 1,
    appServerInstanceId: "app-" + id,
    paused: false,
  };
}

test("historical parent+project keeps read and resume after owner generation changes", async (t) => {
  const root = temporaryRoot("worker-history-");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const data = path.join(root, "data");
  const events: unknown[] = [];
  const options = {
    dataDirectory: data,
    environment: environment(root),
    executablePaths: { dsh: dshFixture, pi: piFixture },
    guardianCommand: [process.execPath, "--import", tsxLoader, guardianSource],
    dshPatch: path.join(pluginRoot, "patches/dsh-session.patch.yml"),
  };
  const first = new WorkerService(options);
  first.registerOwner(generation(root, project, "generation-1"), "token-1");
  const original = await first.start("generation-1", startInput({ requestId: "shared-request" }));
  const done = await waitStatus(first, original.worker.id, ["completed"]);
  await first.close();

  const second = new WorkerService({ ...options, onEvent: (event) => events.push(event) });
  t.after(() => second.close());
  // A persisted owner is not a live claim target until this host generation registers it.
  assert.throws(
    () => second.claimNotifications("generation-1", [], "not-live"),
    /当前宿主进程/,
  );
  second.registerOwner(generation(root, project, "generation-2"), "token-2");
  // Historical read is authorized by the logical parent+project, not the old owner id.
  const historical = second.get(done.id, "generation-2").worker;
  assert.equal(historical.ownerId, "generation-1");
  assert.equal(historical.latestRun?.status, "completed");
  // A replay of the same start request deduplicates across the generation change.
  const replay = await second.start(
    "generation-2",
    startInput({ requestId: "shared-request", type: "dsh" }),
  );
  assert.equal(replay.worker.id, done.id);
  assert.equal(second.state().workers.length, 1);

  const resumed = await second.resume("generation-2", {
    workerId: done.id,
    prompt: "continue after restart",
    requestId: "resume-after-restart",
  });
  const rebound = await waitStatus(second, done.id, ["completed"]);
  assert.equal(rebound.ownerId, "generation-2");
  assert.equal(resumed.run.nativeSessionId, "session-fixture-1");
  assert.equal(second.get(done.id).runs.length, 2);
  // New notifications belong to the current generation; the old outbox item is untouched.
  const notifications = second.notifications();
  assert.equal(notifications.filter((item) => item.runId === resumed.run.id)[0]?.ownerId, "generation-2");
  const oldNotification = notifications.find((item) => item.runId === done.latestRun?.id)!;
  assert.equal(oldNotification.ownerId, "generation-1");

  // Explicit retry rebinds the historical event to the live same-scope owner and emits it.
  events.length = 0;
  second.retryNotifications([oldNotification.id]);
  const retryEvent = events.find(
    (event) =>
      (event as { event?: string }).event === "notification" &&
      (event as { value?: { id?: string } }).value?.id === oldNotification.id,
  ) as { value: { ownerId: string; delivery: string } } | undefined;
  assert.equal(retryEvent?.value.ownerId, "generation-2");
  assert.equal(retryEvent?.value.delivery, "pending");
  assert.equal(second.notifications().find((item) => item.id === oldNotification.id)?.ownerId, "generation-2");
  const claimed = second.claimNotifications("generation-2", [oldNotification.id], "historical-batch");
  assert.equal(claimed.notifications.length, 1);

  const cross = generation(root, project, "generation-3", "another-parent");
  second.registerOwner(cross, "token-3");
  assert.throws(() => second.get(done.id, "generation-3"), /不存在/);
  await assert.rejects(
    second.resume("generation-3", {
      workerId: done.id,
      prompt: "nope",
      requestId: "cross-resume",
    }),
    /不存在/,
  );
});
