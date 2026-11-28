import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkerNotification,
  WorkerRecord,
  WorkerRun,
} from "../shared/contracts.js";
import { createService, temporaryRoot } from "./helpers.js";

function worker(
  id: string,
  createdAt: string,
  overrides: Partial<WorkerRecord> = {},
): WorkerRecord {
  return {
    id,
    type: "pi",
    configId: "pi-default",
    configName: "pi#1",
    taskName: "task-" + id,
    ownerId: "owner-1",
    parentSessionId: "parent-1",
    projectId: "project-1",
    projectPath: "/tmp/project",
    writePaths: [],
    workspace: { mode: "existing", path: "/tmp/project" },
    cwd: "/tmp/project",
    createdAt,
    latestRun: null,
    ...overrides,
  };
}

function run(
  workerId: string,
  id: string,
  status: WorkerRun["status"],
  finishedAt: string | null,
): WorkerRun {
  return {
    id,
    workerId,
    requestId: id,
    status,
    startedAt: finishedAt,
    finishedAt,
    model: null,
    provider: null,
    effort: null,
    timeoutSeconds: null,
    home: "/tmp/home",
    sessionsRoot: "/tmp/sessions",
    nativeSessionId: null,
    nativeSessionFile: null,
    exitCode: status === "completed" ? 0 : 1,
    finalText: null,
    error: null,
    usage: null,
    progress: {
      steps: null,
      phase: null,
      currentTool: null,
      lastEventAt: null,
      softReminderSentAt: null,
      hardTimeoutAt: null,
    },
  };
}

function seed(
  service: ReturnType<typeof createService>["service"],
  record: WorkerRecord,
  latest: WorkerRun,
): void {
  service.store.createWorker(
    record,
    latest,
    "parent-1\u0000project-1",
    "request-" + record.id,
    "start",
    "fp-" + record.id,
  );
}

test("finished history pages 20 rows by finish time then id, with an opaque cursor", async (t) => {
  const root = temporaryRoot("worker-history-finished-");
  const { service } = createService(t, root);
  for (let index = 0; index < 25; index++) {
    const id = "w-" + String(index).padStart(2, "0");
    const time = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    seed(service, worker(id, time), run(id, "run-" + id, "completed", time));
  }
  const first = service.history({ kind: "finished" });
  assert.equal(first.items.length, 20);
  assert.deepEqual(
    first.items.slice(0, 3).map((item) => item.id),
    ["w-24", "w-23", "w-22"],
  );
  assert.equal(typeof first.nextCursor, "string");
  assert.equal(first.nextCursor!.includes("w-"), false, "cursor is opaque");
  const second = service.history({ kind: "finished", cursor: first.nextCursor! });
  assert.deepEqual(
    second.items.map((item) => item.id),
    ["w-04", "w-03", "w-02", "w-01", "w-00"],
  );
  assert.equal(second.nextCursor, null);
  const ids = new Set([...first.items, ...second.items].map((item) => item.id));
  assert.equal(ids.size, 25);

  // Ties break by id descending and survive the page boundary.
  const tie = "2026-02-01T00:00:00.000Z";
  for (const id of ["tie-a", "tie-c", "tie-b"]) {
    seed(service, worker(id, tie), run(id, "run-" + id, "failed", tie));
  }
  const tied = service.history({ kind: "finished" });
  assert.deepEqual(
    tied.items.slice(0, 3).map((item) => item.id),
    ["tie-c", "tie-b", "tie-a"],
  );

  // Scoping filters both workers and the page cursor.
  seed(
    service,
    worker("other-project", "2026-03-01T00:00:00.000Z", {
      projectId: "project-2",
      parentSessionId: "parent-2",
    }),
    run("other-project", "run-other", "completed", "2026-03-01T00:00:00.000Z"),
  );
  const scoped = service.history({ kind: "finished", projectId: "project-2" });
  assert.deepEqual(scoped.items.map((item) => item.id), ["other-project"]);
  assert.equal(
    service.history({ kind: "finished", parentSessionId: "parent-2" }).items.length,
    1,
  );
});

test("notification history pages with task names and keeps legacy rows readable", async (t) => {
  const root = temporaryRoot("worker-history-notifications-");
  const { service } = createService(t, root);
  const record = worker("notify-worker", "2026-01-01T00:00:00.000Z");
  seed(service, record, run(record.id, "run-notify", "completed", record.createdAt));
  for (let index = 0; index < 22; index++) {
    const time = new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString();
    const notification: WorkerNotification = {
      id: "n-" + String(index).padStart(2, "0"),
      ownerId: "owner-1",
      workerId: record.id,
      runId: "run-notify",
      summary: "done " + index,
      status: "completed",
      createdAt: time,
      delivery: "pending",
      batchId: null,
    };
    service.store.saveNotification(notification);
  }
  const legacy = {
    id: "n-legacy",
    ownerId: "owner-1",
    workerId: record.id,
    runId: "run-notify",
    summary: "legacy without time",
    status: "completed",
    delivery: "pending",
    batchId: null,
  } as WorkerNotification;
  service.store.saveNotification(legacy);

  const first = service.history({ kind: "notifications" });
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0]!.id, "n-21");
  assert.equal(first.items[0]!.taskName, record.taskName);
  const second = service.history({ kind: "notifications", cursor: first.nextCursor! });
  assert.deepEqual(
    second.items.map((item) => item.id),
    ["n-01", "n-00", "n-legacy"],
  );
  assert.equal(second.items.at(-1)!.taskName, record.taskName);
  assert.equal(second.nextCursor, null);
});

test("overview reports active workers, settings, usage, cooldown and both history pages", async (t) => {
  const root = temporaryRoot("worker-history-overview-");
  const { service } = createService(t, root);
  const active = worker("active", "2026-01-01T00:00:00.000Z");
  seed(service, active, run(active.id, "run-active", "queued", null));
  const done = worker("done", "2026-01-02T00:00:00.000Z");
  seed(service, done, run(done.id, "run-done", "completed", "2026-01-02T00:00:00.000Z"));
  const snapshot = service.overview();
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "agyCooldownUntil",
    "agyCooldowns",
    "configUsage",
    "finished",
    "notifications",
    "settings",
    "workers",
  ]);
  assert.deepEqual(snapshot.workers.map((item) => item.id), [active.id]);
  assert.equal(snapshot.workers[0]!.type, "pi");
  assert.equal(snapshot.agyCooldownUntil, null);
  assert.deepEqual(snapshot.agyCooldowns, []);
  assert.deepEqual(snapshot.finished.items.map((item) => item.id), [done.id]);
  assert.deepEqual(snapshot.notifications, { items: [], nextCursor: null });
  assert.deepEqual(service.activity().workers, [
    {
      id: active.id,
      projectId: "project-1",
      parentSessionId: "parent-1",
      latestRun: { status: "queued" },
    },
  ]);
});
