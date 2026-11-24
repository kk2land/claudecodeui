import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type {
  WorkerNotification,
  WorkerRecord,
  WorkerRun,
} from "../shared/contracts.js";
import { WorkerStore } from "../server/store.js";
import {
  createService,
  startInput,
  temporaryRoot,
  waitStatus,
} from "./helpers.js";

function dshRecord(id: string, project: string): WorkerRecord {
  return {
    id,
    type: "dsh",
    configId: "dsh-default",
    configName: "dsh#1",
    taskName: id,
    ownerId: "owner-1",
    parentSessionId: "parent-1",
    projectId: "project-1",
    projectPath: project,
    writePaths: [],
    workspace: { mode: "existing", path: project },
    cwd: project,
    createdAt: new Date().toISOString(),
    latestRun: null,
  };
}

function dshRun(
  workerId: string,
  id: string,
  status: WorkerRun["status"],
  finishedAt: string | null = null,
): WorkerRun {
  return {
    id,
    workerId,
    requestId: id,
    status,
    startedAt: null,
    finishedAt,
    model: null,
    provider: null,
    effort: null,
    timeoutSeconds: 600,
    home: "/tmp/dsh-home",
    sessionsRoot: "/tmp/dsh-sessions",
    nativeSessionId: null,
    nativeSessionFile: null,
    exitCode: null,
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

test("retired DSH workers and notifications stay out of every list without rewriting rows", async (t) => {
  const root = temporaryRoot("worker-dsh-hidden-");
  const { service } = createService(t, root);
  const project = path.join(root, "project");
  const queuedWorker = dshRecord("dsh-queued", project);
  const queued = dshRun(queuedWorker.id, "dsh-queued-run", "queued");
  service.store.createWorker(
    queuedWorker,
    queued,
    "parent-1\u0000project-1",
    "queued-request",
    "start",
    "fp",
  );
  const finishedWorker = dshRecord("dsh-finished", project);
  const finished = dshRun(
    finishedWorker.id,
    "dsh-finished-run",
    "completed",
    new Date().toISOString(),
  );
  service.store.createWorker(
    finishedWorker,
    finished,
    "parent-1\u0000project-1",
    "finished-request",
    "start",
    "fp",
  );
  const notification: WorkerNotification = {
    id: "dsh-notification",
    ownerId: finishedWorker.ownerId,
    workerId: finishedWorker.id,
    runId: finished.id,
    summary: "historical DSH notice",
    status: "completed",
    createdAt: new Date().toISOString(),
    delivery: "pending",
    batchId: null,
  };
  service.store.saveNotification(notification);

  const raw = new Database(path.join(root, "data", "worker.db"), { readonly: true });
  const snapshots = () => ({
    workers: raw
      .prepare("SELECT id,body FROM workers WHERE id LIKE 'dsh-%' ORDER BY id")
      .all(),
    runs: raw
      .prepare("SELECT id,status,body FROM runs WHERE id LIKE 'dsh-%' ORDER BY id")
      .all(),
    notifications: raw
      .prepare("SELECT id,delivery,body FROM notifications WHERE id LIKE 'dsh-%' ORDER BY id")
      .all(),
  });
  const before = snapshots();
  try {
    service.recoverFromDisk();
    assert.deepEqual(snapshots(), before);
  } finally {
    raw.close();
  }

  assert.deepEqual(service.state().workers, []);
  assert.deepEqual(service.state().notifications, []);
  assert.deepEqual(service.overview().workers, []);
  assert.deepEqual(service.overview().finished.items, []);
  assert.deepEqual(service.overview().notifications.items, []);
  assert.deepEqual(service.activity().workers, []);
  assert.deepEqual(service.history({ kind: "finished" }).items, []);
  assert.deepEqual(service.history({ kind: "notifications" }).items, []);
  assert.deepEqual(service.notifications(), []);
  // Stored rows remain queued, unnotified, and otherwise untouched.
  assert.equal(service.store.run(queued.id)?.status, "queued");
  assert.equal(service.store.run(queued.id)?.error, null);
  assert.equal(service.store.notification(notification.id)?.delivery, "pending");
  // The hidden queued DSH row never occupies admission for a supported engine.
  const pi = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "pi-beside-dsh" }),
  );
  assert.equal((await waitStatus(service, pi.worker.id, ["completed"])).latestRun?.status, "completed");
});

test("settings with a removed DSH default project the first enabled supported config", (t) => {
  const root = temporaryRoot("worker-dsh-settings-");
  const store = new WorkerStore(path.join(root, "data"));
  t.after(() => store.close());
  const legacyDsh = {
    id: "dsh-default",
    name: "dsh#1",
    type: "dsh",
    enabled: true,
    roles: [],
    concurrency: 3,
    hardTimeoutSeconds: 600,
    model: null,
    effort: null,
  };
  const piDisabled = {
    ...legacyDsh,
    id: "pi-default",
    name: "pi#1",
    type: "pi",
    enabled: false,
  };
  const codex = {
    ...legacyDsh,
    id: "codex-default",
    name: "codex#1",
    type: "codex",
  };
  store.saveSettings({
    schemaVersion: 2,
    configs: [legacyDsh, piDisabled, codex],
    defaultConfigId: "dsh-default",
    retentionDays: 1,
    softReminderSeconds: 600,
    softReminderSteps: 20,
  });
  const settings = store.settings();
  assert.deepEqual(settings.configs.map((config) => config.type), ["pi", "codex"]);
  assert.equal(settings.defaultConfigId, "codex-default");
  const rawSettings = () => {
    const database = new Database(path.join(root, "data", "worker.db"), { readonly: true });
    try {
      const row = database.prepare("SELECT body FROM settings WHERE id=1").get() as {
        body: string;
      };
      return row.body;
    } finally {
      database.close();
    }
  };
  const before = rawSettings();
  store.settings();
  store.settings();
  assert.equal(rawSettings(), before, "hidden DSH projection is not written back");
});

test("settings with no enabled supported config restore the fixed Pi default", (t) => {
  const root = temporaryRoot("worker-dsh-only-");
  const store = new WorkerStore(path.join(root, "data"));
  t.after(() => store.close());
  store.saveSettings({
    schemaVersion: 2,
    configs: [
      {
        id: "custom-pi",
        name: "custom disabled",
        type: "pi",
        enabled: false,
        roles: [],
        concurrency: 1,
        hardTimeoutSeconds: 600,
        model: null,
        effort: null,
      },
      {
        id: "dsh-default",
        name: "dsh#1",
        type: "dsh",
        enabled: true,
        roles: [],
        concurrency: 3,
        hardTimeoutSeconds: 600,
        model: null,
        effort: null,
      },
    ],
    defaultConfigId: "dsh-default",
    retentionDays: 1,
    softReminderSeconds: 600,
    softReminderSteps: 20,
  });
  const settings = store.settings();
  assert.equal(settings.defaultConfigId, "pi-default");
  assert.equal(settings.configs.find((config) => config.id === "pi-default")?.enabled, true);
  assert.equal(settings.configs.find((config) => config.id === "custom-pi")?.enabled, false);
  assert.equal(settings.defaultWorkerType, "pi");
});
