import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { WorkerStore } from "../server/store.js";
import { WorkerService } from "../server/service.js";
import type { WorkerNotification } from "../shared/contracts.js";
import { temporaryRoot } from "./helpers.js";

function notification(
  id: string,
  ownerId = "owner-1",
): WorkerNotification {
  return {
    id,
    ownerId,
    workerId: "worker-" + id,
    runId: "run-" + id,
    summary: id,
    status: "completed",
    createdAt: new Date().toISOString(),
    delivery: "pending",
    batchId: null,
  };
}

test("settling pending releases the batch for the next claim", (t) => {
  const directory = temporaryRoot("worker-outbox-settle-");
  const store = new WorkerStore(directory);
  t.after(() => store.close());
  const item = notification("a");
  store.saveNotification(item);
  assert.equal(
    store.claimNotifications("owner-1", [item.id], "batch-old").length,
    1,
  );
  store.settleBatch("batch-old", "pending");
  const released = store.notification(item.id)!;
  assert.equal(released.delivery, "pending");
  assert.equal(released.batchId, null);
  assert.equal(
    store.claimNotifications("owner-1", [item.id], "batch-next").length,
    1,
  );
  assert.equal(store.notification(item.id)?.batchId, "batch-next");
});

test("notification owner rebinding remains claimable by the new owner", (t) => {
  const directory = temporaryRoot("worker-outbox-owner-");
  const store = new WorkerStore(directory);
  t.after(() => store.close());
  const item = notification("b");
  store.saveNotification(item);
  item.ownerId = "owner-2";
  store.updateNotification(item);
  assert.equal(store.claimNotifications("owner-1", [], "old-owner").length, 0);
  assert.equal(store.claimNotifications("owner-2", [item.id], "new-owner").length, 1);
});

test("settle pending does not undo ACK, held, or unknown", (t) => {
  const directory = temporaryRoot("worker-outbox-preserve-");
  const store = new WorkerStore(directory);
  t.after(() => store.close());
  const acked = notification("acked");
  const paused = notification("paused");
  const unknown = notification("unknown");
  store.saveNotification(acked);
  store.saveNotification(paused);
  store.saveNotification(unknown);
  store.claimNotifications("owner-1", [acked.id, paused.id, unknown.id], "batch");
  acked.delivery = "delivered";
  paused.delivery = "held";
  unknown.delivery = "unknown";
  store.updateNotification(acked);
  store.updateNotification(paused);
  store.updateNotification(unknown);
  store.settleBatch("batch", "pending");
  assert.equal(store.notification(acked.id)?.delivery, "delivered");
  assert.equal(store.notification(paused.id)?.delivery, "held");
  assert.equal(store.notification(unknown.id)?.delivery, "unknown");
});

test("startup holds pending notifications for a persisted paused owner", (t) => {
  const directory = temporaryRoot("worker-outbox-startup-");
  const store = new WorkerStore(directory);
  store.saveOwner({
    id: "owner-1",
    parentSessionId: "parent-1",
    projectId: "project-1",
    projectPath: directory,
    userId: null,
    appServerInstanceId: "app-1",
    paused: true,
  });
  store.saveNotification(notification("c"));
  store.close();
  const service = new WorkerService({
    dataDirectory: directory,
    environment: { HOME: path.join(directory, "home") },
  });
  t.after(() => service.close());
  service.recoverFromDisk();
  assert.equal(service.notifications()[0]?.delivery, "held");
  service.registerOwner(
    {
      id: "owner-1",
      parentSessionId: "parent-1",
      projectId: "project-1",
      projectPath: directory,
      userId: null,
      appServerInstanceId: "app-1",
      paused: true,
    },
    "owner-token",
  );
  assert.equal(service.notifications()[0]?.delivery, "held");
  assert.throws(
    () => service.claimNotifications("owner-1", [], "paused"),
    /暂停/,
  );
});
