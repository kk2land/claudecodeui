import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { WorkerService } from "../server/service.js";
import { migrateLegacySettings } from "../server/settings.js";
import type { WorkerNotification, WorkerRecord, WorkerRun, WorkerStatus } from "../shared/contracts.js";
import { createService, owner, startInput, temporaryRoot, waitStatus } from "./helpers.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-31T00:00:00.000Z");

function setup(t: TestContext): WorkerService {
  const root = temporaryRoot("worker-retention-");
  const service = new WorkerService({
    dataDirectory: root,
    environment: { HOME: path.join(root, "home") },
    now: () => NOW,
  });
  t.after(async () => {
    // These seeded active records have no real processes to stop during teardown.
    for (const run of service.store.activeRuns()) {
      run.status = "interrupted";
      service.store.saveRun(run);
    }
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  service.updateSettings(migrateLegacySettings({}));
  return service;
}

function seed(
  service: WorkerService,
  id: string,
  finishedAt: number | null,
  status: WorkerStatus = "completed",
  workerId = "worker-" + id,
) {
  const data = service.store.directory;
  const cwd = path.join(data, "worktrees", workerId);
  const sessionsRoot = path.join(data, "sessions", "pi");
  const worker: WorkerRecord = {
    id: workerId,
    type: "pi",
    configId: "pi-default",
    configName: "pi default",
    taskName: id,
    ownerId: "owner-1",
    parentSessionId: "parent-1",
    projectId: "project-1",
    projectPath: data,
    writePaths: [],
    workspace: { mode: "worktree", path: cwd, sourcePath: data, createdByPlugin: true },
    cwd,
    createdAt: new Date(NOW - 7 * DAY).toISOString(),
    latestRun: null,
  };
  const run: WorkerRun = {
    id,
    workerId,
    requestId: id,
    status,
    startedAt: new Date(NOW - 7 * DAY).toISOString(),
    finishedAt: finishedAt === null ? null : new Date(finishedAt).toISOString(),
    model: null,
    provider: null,
    effort: null,
    timeoutSeconds: null,
    home: data,
    sessionsRoot,
    nativeSessionId: workerId,
    nativeSessionFile: path.join(sessionsRoot, workerId + ".jsonl"),
    exitCode: 0,
    finalText: "result",
    error: null,
    usage: null,
    progress: {
      steps: null,
      phase: status,
      currentTool: null,
      lastEventAt: null,
      softReminderSentAt: null,
      hardTimeoutAt: null,
    },
  };
  if (service.store.worker(workerId)) {
    service.store.insertRun(run);
    service.store.addRequest("scope", id, workerId, id, "resume", id);
  } else {
    service.store.createWorker(worker, run, "scope", id, "start", id);
  }
  if (finishedAt !== null)
    service.store.saveNotification({
      id: "notification-" + id,
      ownerId: worker.ownerId,
      workerId,
      runId: id,
      summary: id,
      status: status as WorkerNotification["status"],
      createdAt: run.finishedAt!,
      delivery: "pending",
      batchId: null,
    });
  const logs = path.join(data, "logs", workerId, id);
  fs.mkdirSync(logs, { recursive: true });
  for (const name of ["events.log", "stderr.log", "events.truncated", "exit.json", "prompt.md"])
    fs.writeFileSync(path.join(logs, name), "saved data");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "uncommitted.txt"), "work");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.writeFileSync(run.nativeSessionFile!, "native session");
  return { worker, run, logs };
}

test("default daily retention expires terminal history at the boundary and protects active runs", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const service = setup(t);
  assert.equal(service.settings().retentionDays, 1);
  const expired = (["completed", "failed", "cancelled", "interrupted"] as const).map(
    (status) => seed(service, status, NOW - DAY, status),
  );
  const recent = seed(service, "recent", NOW - DAY + 1);
  const undated = seed(service, "undated", null);
  const active = (["queued", "starting", "running", "stopping", "unknown"] as const).map(
    (status) => seed(service, status, null, status),
  );
  service.registerOwner(owner(service.store.directory), "plan-token");
  const beforePlan = service.state();
  const plan = service.savePlan("owner-1", "# 验收记录\n\n已完成任务的结论独立于运行日志保留。\n");
  assert.deepEqual(service.state(), beforePlan, "saving a plan leaves existing runs and notifications untouched");
  t.mock.timers.tick(59_999);
  assert.ok(service.store.run(expired[0]!.run.id));
  t.mock.timers.tick(1);

  for (const { worker, run, logs } of expired) {
    assert.equal(service.store.run(run.id), null);
    assert.equal(service.store.worker(worker.id), null);
    assert.equal(service.store.request("scope", run.id), null);
    assert.equal(service.store.notification("notification-" + run.id), null);
    assert.equal(fs.existsSync(logs), false);
    assert.equal(fs.existsSync(path.dirname(logs)), false);
    assert.equal(fs.readFileSync(path.join(worker.cwd, "uncommitted.txt"), "utf8"), "work");
    assert.equal(fs.readFileSync(run.nativeSessionFile!, "utf8"), "native session");
  }
  for (const { worker, run, logs } of [recent, undated, ...active]) {
    assert.equal(service.store.run(run.id)?.status, run.status);
    assert.ok(service.store.worker(worker.id));
    assert.ok(fs.existsSync(logs));
    assert.ok(service.store.request("scope", run.id));
  }
  assert.equal(service.notifications().length, 1);
  assert.deepEqual(service.context("owner-1").plan, plan);
});

test("shortening retention prunes immediately while preserving a worker's newer run", (t) => {
  const service = setup(t);
  service.updateSettings({ concurrency: { pi: 3 }, retentionDays: 7 });
  const old = seed(service, "old", NOW - 3 * DAY, "completed", "shared-worker");
  const recent = seed(service, "new", NOW - DAY / 2, "completed", "shared-worker");
  service.updateSettings({ concurrency: { pi: 2 } });
  assert.equal(service.settings().retentionDays, 7);
  assert.equal(service.get(old.worker.id).runs.length, 2);

  service.updateSettings({ concurrency: { pi: 2 }, retentionDays: 1 });
  assert.equal(service.get(old.worker.id).worker.latestRun?.id, recent.run.id);
  assert.deepEqual(service.get(old.worker.id).runs.map((run) => run.id), [recent.run.id]);
  assert.equal(fs.existsSync(old.logs), false);
  assert.ok(fs.existsSync(recent.logs));
  assert.equal(service.store.request("scope", old.run.id), null);
  assert.ok(service.store.request("scope", recent.run.id));
  assert.deepEqual(service.notifications().map((item) => item.runId), [recent.run.id]);
});

test("startup recovery applies retention to existing history using the persisted setting", (t) => {
  const service = setup(t);
  service.updateSettings({ concurrency: { pi: 3 }, retentionDays: 2 });
  const expired = seed(service, "expired", NOW - 2 * DAY);
  const kept = seed(service, "kept", NOW - DAY);
  const unknown = seed(service, "unknown", null, "unknown");
  service.recoverFromDisk();
  assert.equal(service.store.worker(expired.worker.id), null);
  assert.equal(fs.existsSync(expired.logs), false);
  assert.ok(service.store.run(kept.run.id));
  assert.ok(fs.existsSync(kept.logs));
  assert.equal(service.store.run(unknown.run.id)?.status, "unknown");
  assert.ok(fs.existsSync(unknown.logs));
});

for (const type of ["pi"] as const) {
  test(`queued ${type} resume preserves its native session after previous history expires`, async (t) => {
    let now = Date.now();
    const root = temporaryRoot("worker-retention-resume-");
    const { service, env } = createService(t, root, {}, { now: () => now });
    service.updateSettings({ concurrency: { pi: 1 } });
    const original = await service.start("owner-1", startInput({ type }));
    const first = (await waitStatus(service, original.worker.id, ["completed"])).latestRun!;

    env.TEST_SESSION_ID = "blocking-session";
    env.TEST_SCENARIO = "sleep";
    env.TEST_DELAY_MS = "1000";
    const blocker = await service.start("owner-1", startInput({ type }));
    await waitStatus(service, blocker.worker.id, ["running"]);
    const resumed = await service.resume("owner-1", {
      workerId: original.worker.id,
      prompt: "continue in the same native session",
      requestId: "resume-before-expiry",
    });
    assert.equal(resumed.run.status, "queued");
    env.TEST_SESSION_ID = first.nativeSessionId!;
    delete env.TEST_SCENARIO;
    delete env.TEST_DELAY_MS;
    now += DAY;
    service.updateSettings({ concurrency: { pi: 1 } });
    assert.equal(service.store.run(first.id), null);

    await waitStatus(service, original.worker.id, ["running", "completed", "failed"]);
    const completed = await waitStatus(service, original.worker.id, ["completed"]);
    const events = service
      .logs(original.worker.id, { stream: "events", runId: resumed.run.id })
      .text.split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { type?: string; action?: string; sessionId?: string });
    const sessionEvent = events.find((event) => event.type === "acp_session");
    assert.equal(sessionEvent?.action, "resume");
    assert.equal(sessionEvent?.sessionId, first.nativeSessionId);
    assert.equal(completed.latestRun?.id, resumed.run.id);
    assert.equal(completed.latestRun?.nativeSessionId, first.nativeSessionId);
    assert.equal(completed.latestRun?.nativeSessionFile, first.nativeSessionFile);
  });
}

test("retention prunes only expired confirmed shared ACP guardian directories", (t) => {
  const service = setup(t);
  const data = service.store.directory;
  const piRoot = path.join(data, "pi-acp-guardian");
  const agyRoot = path.join(data, "agy-acp-guardian");
  const makeDir = (rootDir: string, name: string, finalJson: unknown | null): string => {
    const dir = path.join(rootDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spec-1.json"), "{}");
    if (finalJson !== null) {
      fs.writeFileSync(path.join(dir, "final.json"), JSON.stringify(finalJson));
    }
    return dir;
  };
  const expiredConfirmedPi = makeDir(piRoot, "process-expired-ok", {
    reason: "disconnect",
    groupExited: true,
    finishedAt: new Date(NOW - DAY).toISOString(),
  });
  const expiredConfirmedAgy = makeDir(agyRoot, "process-expired-agy", {
    reason: "exit",
    groupExited: true,
    finishedAt: new Date(NOW - 2 * DAY).toISOString(),
  });
  const recentConfirmed = makeDir(piRoot, "process-recent-ok", {
    reason: "exit",
    groupExited: true,
    finishedAt: new Date(NOW - DAY + 1000).toISOString(),
  });
  const expiredUnconfirmed = makeDir(piRoot, "process-expired-unconfirmed", {
    reason: "timeout",
    groupExited: false,
    finishedAt: new Date(NOW - 5 * DAY).toISOString(),
  });
  const missingFinal = makeDir(piRoot, "process-live-no-final", null);
  const nativeSession = path.join(data, "sessions", "pi", "keep-me.jsonl");
  fs.mkdirSync(path.dirname(nativeSession), { recursive: true });
  fs.writeFileSync(nativeSession, "native session");

  service.recoverFromDisk();

  assert.equal(fs.existsSync(expiredConfirmedPi), false);
  assert.equal(fs.existsSync(expiredConfirmedAgy), false);
  assert.equal(fs.existsSync(recentConfirmed), true);
  assert.equal(fs.existsSync(expiredUnconfirmed), true);
  assert.equal(fs.existsSync(missingFinal), true);
  assert.equal(fs.readFileSync(nativeSession, "utf8"), "native session");
});
