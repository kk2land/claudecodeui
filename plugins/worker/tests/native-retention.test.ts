import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { WorkerService } from "../server/service.js";
import { WorkerStore } from "../server/store.js";
import {
  createService,
  startInput,
  waitFor,
  waitStatus,
} from "./helpers.js";
import {
  nativeSessionRoots,
  sweepNativeSessions,
} from "../server/native-retention.js";
import type { WorkerRecord, WorkerRun, WorkerStatus } from "../shared/contracts.js";
import type { ActiveNativeSession } from "../server/native-retention.js";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 31, 12, 0, 0, 0).getTime();

function temporaryRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file: string, content = "session"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function age(file: string, milliseconds: number): void {
  const time = new Date(milliseconds);
  fs.utimesSync(file, time, time);
}

function environment(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { HOME: path.join(root, "home"), ...extra };
}

function cleanup(
  data: string,
  env: NodeJS.ProcessEnv,
  activeRuns: ActiveNativeSession[] = [],
  now = NOW,
  log?: (message: string) => void,
) {
  return sweepNativeSessions({
    dataDirectory: data,
    environment: env,
    now,
    activeRuns,
    log,
  });
}

test("native cleanup deletes only strict older-than-three-days files across every root", (t) => {
  const root = temporaryRoot("worker-native-retention-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const home = path.join(root, "home");
  const configured = path.join(root, "custom-dsh");
  const env = environment(root, { CODEX_DSH_SESSIONS_ROOT: configured });
  const old = NOW - 3 * DAY - 1;
  const boundary = NOW - 3 * DAY;

  const defaultDsh = write(
    path.join(home, "tmp", "codex-dsh-sessions", "unused", "session.jsonl"),
  );
  age(defaultDsh, old);
  const custom = path.join(configured, "session-a");
  const generations = [
    write(path.join(custom, "session.jsonl")),
    write(path.join(custom, "session.v1.jsonl")),
    write(path.join(custom, "session.v12.jsonl.zstd")),
  ];
  for (const file of generations) age(file, old);
  const boundaryFile = write(path.join(custom, "session.v2.jsonl"));
  age(boundaryFile, boundary);
  const newer = write(path.join(custom, "session.v3.jsonl"));
  age(newer, NOW - DAY);
  const lock = write(path.join(custom, "session.jsonl.lock"));
  age(lock, old);
  const unrelated = write(path.join(custom, "notes.jsonl"));
  age(unrelated, old);
  const outside = write(path.join(root, "outside.jsonl"));
  age(outside, old);
  const linked = path.join(custom, "session.v99.jsonl");
  fs.symlinkSync(outside, linked);

  const piRoot = path.join(home, ".pi", "agent", "sessions");
  const pi = write(path.join(piRoot, "pi-session.jsonl"));
  age(pi, old);
  const piLock = write(path.join(piRoot, "pi-session.jsonl.lock"));
  age(piLock, old);
  const piOther = write(path.join(piRoot, "pi-session.txt"));
  age(piOther, old);

  const workerDsh = write(path.join(data, "sessions", "dsh", "worker-a", "session.jsonl"));
  age(workerDsh, old);
  const workerPi = write(path.join(data, "sessions", "pi", "worker-pi.jsonl"));
  age(workerPi, old);

  const summary = cleanup(data, env);

  assert.deepEqual(summary, { roots: 4, deleted: 6, skipped: 2, failed: 0 });
  for (const file of [...generations, pi, workerDsh, workerPi])
    assert.equal(fs.existsSync(file), false, file);
  for (const file of [defaultDsh, boundaryFile, newer, lock, unrelated, outside, linked, piLock, piOther])
    assert.equal(fs.existsSync(file), true, file);
});

test("default roots, no roots, and duplicate roots behave as configured", (t) => {
  const root = temporaryRoot("worker-native-roots-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const home = path.join(root, "home");
  const env = environment(root);

  assert.deepEqual(
    nativeSessionRoots(data, env).map((item) => [item.type, item.directory]),
    [
      ["dsh", path.join(home, "tmp", "codex-dsh-sessions")],
      ["pi", path.join(home, ".pi", "agent", "sessions")],
      ["dsh", path.join(data, "sessions", "dsh")],
      ["pi", path.join(data, "sessions", "pi")],
    ],
  );
  const duplicate = nativeSessionRoots(data, {
    HOME: home,
    CODEX_DSH_SESSIONS_ROOT: path.join(data, "sessions", "dsh"),
  });
  assert.equal(duplicate.length, 3);
  assert.equal(new Set(duplicate.map((item) => item.directory)).size, 3);

  assert.deepEqual(cleanup(data, env), { roots: 4, deleted: 0, skipped: 0, failed: 0 });

  const defaultFile = write(
    path.join(home, "tmp", "codex-dsh-sessions", "session-default", "session.jsonl"),
  );
  age(defaultFile, NOW - 3 * DAY - 1);
  const piFile = write(path.join(home, ".pi", "agent", "sessions", "default.jsonl"));
  age(piFile, NOW - 3 * DAY - 1);
  assert.deepEqual(cleanup(data, env), { roots: 4, deleted: 2, skipped: 0, failed: 0 });
  assert.equal(fs.existsSync(defaultFile), false);
  assert.equal(fs.existsSync(piFile), false);
});

test("DSH protects the whole active session directory; Pi protects only the exact file", (t) => {
  const root = temporaryRoot("worker-native-protected-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const env = environment(root);
  const dshRoot = path.join(data, "sessions", "dsh");
  const piRoot = path.join(data, "sessions", "pi");
  const old = NOW - 3 * DAY - 1;

  const activeDsh = [
    write(path.join(dshRoot, "active", "session.jsonl")),
    write(path.join(dshRoot, "active", "session.v4.jsonl.zstd")),
  ];
  const inactiveDsh = write(path.join(dshRoot, "inactive", "session.jsonl"));
  const activePi = write(path.join(piRoot, "active.jsonl"));
  const inactivePi = write(path.join(piRoot, "inactive.jsonl"));
  for (const file of [...activeDsh, inactiveDsh, activePi, inactivePi]) age(file, old);

  const summary = cleanup(data, env, [
    {
      type: "dsh",
      sessionsRoot: dshRoot,
      nativeSessionId: null,
      nativeSessionFile: activeDsh[0]!,
    },
    {
      type: "pi",
      sessionsRoot: piRoot,
      nativeSessionId: null,
      nativeSessionFile: activePi,
    },
  ]);

  assert.deepEqual(summary, { roots: 4, deleted: 2, skipped: 3, failed: 0 });
  assert.ok(fs.existsSync(activeDsh[0]!));
  assert.ok(fs.existsSync(activeDsh[1]!));
  assert.equal(fs.existsSync(inactiveDsh), false);
  assert.ok(fs.existsSync(activePi));
  assert.equal(fs.existsSync(inactivePi), false);
});

test("all active run statuses keep their native references while terminal runs do not", (t) => {
  const root = temporaryRoot("worker-native-status-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const env = environment(root);
  const store = new WorkerStore(data);
  t.after(() => store.close());
  const old = NOW - 3 * DAY - 1;
  const dshRoot = path.join(data, "sessions", "dsh");
  const piRoot = path.join(data, "sessions", "pi");
  const statuses: WorkerStatus[] = ["queued", "starting", "running", "stopping", "unknown"];
  for (const status of statuses) {
    seedRun(store, status, status, "dsh", path.join(dshRoot, status), "session.jsonl");
    seedRun(store, "pi-" + status, status, "pi", piRoot, status + ".jsonl");
  }
  seedRun(store, "pi-terminal", "completed", "pi", piRoot, "terminal.jsonl");
  seedRun(
    store,
    "dsh-terminal",
    "completed",
    "dsh",
    path.join(dshRoot, "terminal"),
    "session.jsonl",
  );
  for (const file of walkFiles(dshRoot).concat(walkFiles(piRoot))) age(file, old);

  const activeRuns = store.activeRuns().flatMap((run) => {
    const worker = store.worker(run.workerId);
    return worker
      ? [{
          type: worker.type,
          sessionsRoot: run.sessionsRoot,
          nativeSessionId: run.nativeSessionId,
          nativeSessionFile: run.nativeSessionFile,
        }]
      : [];
  });
  const summary = cleanup(data, env, activeRuns);

  const activeReferences = [
    ...statuses.map((status) => path.join(dshRoot, status, "session.jsonl")),
    ...statuses.map((status) => path.join(piRoot, status + ".jsonl")),
  ];
  for (const file of activeReferences) assert.ok(fs.existsSync(file), file);
  assert.equal(fs.existsSync(path.join(piRoot, "terminal.jsonl")), false);
  assert.equal(fs.existsSync(path.join(dshRoot, "terminal", "session.jsonl")), false);
  assert.equal(summary.deleted, 2);
  assert.equal(summary.failed, 0);
});

test("one failing root is logged and does not abort remaining roots", (t) => {
  const root = temporaryRoot("worker-native-failure-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const broken = write(path.join(root, "broken-root"));
  const env = environment(root, { CODEX_DSH_SESSIONS_ROOT: broken });
  const file = write(path.join(data, "sessions", "dsh", "healthy", "session.jsonl"));
  age(file, NOW - 3 * DAY - 1);
  const messages: string[] = [];

  const summary = cleanup(data, env, [], NOW, (message) => messages.push(message));

  assert.equal(summary.deleted, 1);
  assert.equal(summary.failed, 1);
  assert.equal(fs.existsSync(file), false);
  assert.ok(messages.some((message) => message.includes("root is not a directory")));
  assert.ok(messages.some((message) => message.includes("deleted=1")));
});

function serviceAt(
  t: TestContext,
  root: string,
  options: { now: () => number; data?: string } = { now: () => NOW },
): { service: WorkerService; data: string } {
  const data = options.data ?? path.join(root, "data");
  const service = new WorkerService({
    dataDirectory: data,
    environment: environment(root),
    now: options.now,
  });
  t.after(async () => {
    await service.close();
  });
  return { service, data };
}

test("startup sweeps immediately and every fresh service sweeps again", async (t) => {
  const root = temporaryRoot("worker-native-startup-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const firstFile = write(
    path.join(data, "sessions", "dsh", "first-start", "session.jsonl"),
  );
  age(firstFile, NOW - 3 * DAY - 1);
  const first = serviceAt(t, root);
  first.service.recoverFromDisk();
  await waitUntil(() => !fs.existsSync(firstFile));
  await first.service.close();

  const restartFile = write(
    path.join(data, "sessions", "dsh", "second-start", "session.jsonl"),
  );
  age(restartFile, NOW - 3 * DAY - 1);
  const second = serviceAt(t, root);
  second.service.recoverFromDisk();
  await waitUntil(() => !fs.existsSync(restartFile));
});

test("the 24-hour interval is measured from startup, not calendar 03:00", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setInterval"],
    now: new Date(2026, 9, 31, 12, 0, 0, 0).getTime(),
  });
  const root = temporaryRoot("worker-native-interval-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const service = new WorkerService({
    dataDirectory: data,
    environment: environment(root),
    now: () => Date.now(),
  });
  t.after(async () => {
    await service.close();
  });
  service.recoverFromDisk();
  await flushPromises();

  const file = write(path.join(data, "sessions", "dsh", "interval", "session.jsonl"));
  age(file, Date.now() - 3 * DAY - 1);
  // The next calendar 03:00 is 15 hours after startup and must not sweep.
  t.mock.timers.tick(15 * 60 * 60 * 1000);
  await flushPromises();
  assert.ok(fs.existsSync(file));
  t.mock.timers.tick(9 * 60 * 60 * 1000 - 1);
  await flushPromises();
  assert.ok(fs.existsSync(file));
  t.mock.timers.tick(1);
  await flushPromises();
  assert.equal(fs.existsSync(file), false);
});

test("repeated recovery starts only one immediate sweep and one 24-hour timer", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setInterval"],
    now: new Date(2026, 9, 31, 12, 0, 0, 0).getTime(),
  });
  const root = temporaryRoot("worker-native-repeat-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const messages: string[] = [];
  const writeStderr = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    messages.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = writeStderr;
  });
  const service = new WorkerService({
    dataDirectory: data,
    environment: environment(root),
    now: () => Date.now(),
  });
  t.after(async () => {
    await service.close();
  });
  service.recoverFromDisk();
  await flushPromises();
  service.recoverFromDisk();
  await flushPromises();
  assert.equal(
    messages.filter((message) => message.includes("native session cleanup deleted="))
      .length,
    1,
  );

  const file = write(path.join(data, "sessions", "dsh", "repeat", "session.jsonl"));
  age(file, Date.now() - 3 * DAY - 1);
  t.mock.timers.tick(DAY);
  await flushPromises();
  assert.equal(fs.existsSync(file), false);
  assert.equal(
    messages.filter((message) => message.includes("native session cleanup deleted="))
      .length,
    2,
  );
});

test("close awaits the in-flight sweep and clears the 24-hour timer", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setInterval"],
    now: new Date(2026, 9, 31, 12, 0, 0, 0).getTime(),
  });
  const root = temporaryRoot("worker-native-close-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const file = write(path.join(data, "sessions", "dsh", "closing", "session.jsonl"));
  age(file, Date.now() - 3 * DAY - 1);
  const service = new WorkerService({
    dataDirectory: data,
    environment: environment(root),
    now: () => Date.now(),
  });
  service.recoverFromDisk();
  await service.close();
  assert.equal(fs.existsSync(file), false);

  const afterClose = write(
    path.join(data, "sessions", "dsh", "closed", "session.jsonl"),
  );
  age(afterClose, Date.now() - 3 * DAY - 1);
  t.mock.timers.tick(DAY);
  await flushPromises();
  assert.ok(fs.existsSync(afterClose));
});


test("known DSH IDs protect encoded-cwd session directories without a file path", (t) => {
  const root = temporaryRoot("worker-native-dsh-id-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const env = environment(root);
  const dshRoot = path.join(data, "sessions", "dsh");
  const queued = write(
    path.join(dshRoot, "encoded-project", "queued-session", "session.jsonl"),
  );
  const unknown = write(
    path.join(dshRoot, "encoded-project", "unknown-session", "session.v4.jsonl.zstd"),
  );
  age(queued, NOW - 3 * DAY - 1);
  age(unknown, NOW - 3 * DAY - 1);

  const summary = cleanup(data, env, [
    {
      type: "dsh",
      sessionsRoot: dshRoot,
      nativeSessionId: "queued-session",
      nativeSessionFile: null,
    },
    {
      type: "dsh",
      sessionsRoot: dshRoot,
      nativeSessionId: "unknown-session",
      nativeSessionFile: null,
    },
  ]);

  assert.equal(summary.deleted, 0);
  assert.equal(summary.skipped, 2);
  assert.ok(fs.existsSync(queued));
  assert.ok(fs.existsSync(unknown));
});

test("recovery protects a known DSH session id when nativeSessionFile is null", async (t) => {
  const root = temporaryRoot("worker-native-recover-id-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const env = environment(root);
  const dshRoot = path.join(data, "sessions", "dsh");
  const service = new WorkerService({
    dataDirectory: data,
    environment: env,
    now: () => NOW,
  });
  t.after(async () => {
    finishActive(service);
    await service.close();
  });
  const sessionFile = write(
    path.join(dshRoot, "encoded-project", "old-session", "session.v4.jsonl.zstd"),
  );
  age(sessionFile, NOW - 3 * DAY - 1);
  seedRun(
    service.store,
    "recovered-id",
    "unknown",
    "dsh",
    dshRoot,
    null,
    "old-session",
  );
  const messages = captureCleanupLogs(t);

  service.recoverFromDisk();
  await waitUntil(() => messages.some((message) => message.includes("deleted=")));

  assert.ok(fs.existsSync(sessionFile));
  const run = service.store.run("recovered-id")!;
  assert.equal(run.status, "unknown");
  assert.equal(run.nativeSessionId, "old-session");
});

test("recovery without identity protects its sessionsRoot but not unrelated roots", async (t) => {
  const root = temporaryRoot("worker-native-recover-root-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const env = environment(root);
  const dshRoot = path.join(data, "sessions", "dsh");
  const piRoot = path.join(data, "sessions", "pi");
  const service = new WorkerService({
    dataDirectory: data,
    environment: env,
    now: () => NOW,
  });
  t.after(async () => {
    finishActive(service);
    await service.close();
  });
  const dshFile = write(
    path.join(dshRoot, "encoded-project", "unknown-session", "session.jsonl"),
  );
  const piFile = write(path.join(piRoot, "unrelated.jsonl"));
  age(dshFile, NOW - 3 * DAY - 1);
  age(piFile, NOW - 3 * DAY - 1);
  seedRun(service.store, "no-identity", "unknown", "dsh", dshRoot, null, null);
  const messages = captureCleanupLogs(t);

  service.recoverFromDisk();
  await waitUntil(() => messages.some((message) => message.includes("deleted=")));

  assert.ok(fs.existsSync(dshFile));
  assert.equal(fs.existsSync(piFile), false);
});

test("DSH session events persist the native identity before finalize", async (t) => {
  const root = temporaryRoot("worker-native-dsh-live-");
  const { service } = createService(
    t,
    root,
    { TEST_SCENARIO: "sleep", TEST_DELAY_MS: "2000" },
    { now: () => NOW },
  );
  const started = await service.start(
    "owner-1",
    startInput({ type: "dsh", requestId: "dsh-live-retention" }),
  );
  const running = await waitStatus(service, started.worker.id, [
    "starting",
    "running",
  ]);
  const run = await waitFor(
    () => service.store.run(running.latestRun!.id),
    (value) => value?.nativeSessionId === "session-fixture-1",
  );
  assert.equal(run?.nativeSessionId, "session-fixture-1");
  assert.ok(run?.nativeSessionFile === null);
  await waitStatus(service, started.worker.id, ["completed"]);
});

test("Pi launch persists its session file before finalize and cleanup protects it", async (t) => {
  const root = temporaryRoot("worker-native-pi-launch-");
  const { service, data, env } = createService(
    t,
    root,
    { TEST_SCENARIO: "sleep", TEST_DELAY_MS: "2000" },
    { now: () => NOW },
  );
  const started = await service.start(
    "owner-1",
    startInput({ type: "pi", requestId: "pi-launch-retention" }),
  );
  const running = await waitStatus(service, started.worker.id, [
    "starting",
    "running",
  ]);
  const run = await waitFor(
    () => service.store.run(running.latestRun!.id),
    (value) => value?.nativeSessionFile !== null && value !== null,
  );
  assert.ok(run);
  assert.equal(
    run.nativeSessionFile,
    path.join(data, "sessions", "pi", run.id + ".jsonl"),
  );
  await waitFor(() => fs.existsSync(run.nativeSessionFile!), Boolean);
  age(run.nativeSessionFile!, NOW - 3 * DAY - 1);

  const summary = cleanup(data, env, [
    {
      type: "pi",
      sessionsRoot: run.sessionsRoot,
      nativeSessionId: run.nativeSessionId,
      nativeSessionFile: run.nativeSessionFile,
    },
  ]);
  assert.equal(summary.deleted, 0);
  assert.ok(fs.existsSync(run.nativeSessionFile!));
  await waitStatus(service, started.worker.id, ["completed"]);
});

test("invalid DSH event values do not crash live identity tracking", async (t) => {
  const root = temporaryRoot("worker-native-invalid-event-");
  const { service, env } = createService(t, root, { TEST_SCENARIO: "null-before-session" });
  const started = await service.start("owner-1", startInput({ requestId: "invalid-event" }));
  const failed = await waitStatus(service, started.worker.id, ["failed"]);
  assert.equal(failed.latestRun?.exitCode, 0, "invalid protocol is rejected despite a successful process exit");

  env.TEST_SCENARIO = "ok";
  const next = await service.start("owner-1", startInput({ requestId: "after-invalid-event" }));
  const completed = await waitStatus(service, next.worker.id, ["completed"]);
  assert.equal(completed.latestRun?.nativeSessionId, "session-fixture-1");
});

test("native roots fall back from HOME to USERPROFILE and OS home", (t) => {
  const root = temporaryRoot("worker-native-home-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const osHome = path.join(root, "os-home");
  const profileHome = path.join(root, "profile-home");
  const envHome = path.join(root, "env-home");
  t.mock.method(os, "homedir", () => osHome);

  assert.deepEqual(
    nativeSessionRoots(data, {}).map((item) => item.directory).slice(0, 2),
    [
      path.join(osHome, "tmp", "codex-dsh-sessions"),
      path.join(osHome, ".pi", "agent", "sessions"),
    ],
  );
  assert.deepEqual(
    nativeSessionRoots(data, { USERPROFILE: profileHome })
      .map((item) => item.directory)
      .slice(0, 2),
    [
      path.join(profileHome, "tmp", "codex-dsh-sessions"),
      path.join(profileHome, ".pi", "agent", "sessions"),
    ],
  );
  assert.deepEqual(
    nativeSessionRoots(data, { HOME: envHome, USERPROFILE: profileHome })
      .map((item) => item.directory)
      .slice(0, 2),
    [
      path.join(envHome, "tmp", "codex-dsh-sessions"),
      path.join(envHome, ".pi", "agent", "sessions"),
    ],
  );
});

function seedRun(
  store: WorkerStore,
  id: string,
  status: WorkerStatus,
  type: WorkerRecord["type"],
  sessionsRoot: string,
  sessionFile: string | null,
  sessionId: string | null = id,
): void {
  const workerId = "worker-" + id;
  const worker: WorkerRecord = {
    id: workerId,
    type,
    taskName: id,
    ownerId: "owner-1",
    parentSessionId: "parent-1",
    projectId: "project-1",
    projectPath: store.directory,
    writePaths: [],
    workspace: { mode: "existing", path: store.directory },
    cwd: store.directory,
    createdAt: new Date(NOW - 7 * DAY).toISOString(),
    latestRun: null,
  };
  const run: WorkerRun = {
    id,
    workerId,
    requestId: id,
    status,
    startedAt: new Date(NOW - 7 * DAY).toISOString(),
    finishedAt: status === "completed" ? new Date(NOW - 7 * DAY).toISOString() : null,
    model: null,
    provider: null,
    effort: null,
    timeoutSeconds: null,
    home: store.directory,
    sessionsRoot,
    nativeSessionId: sessionId,
    nativeSessionFile:
      sessionFile === null ? null : path.join(sessionsRoot, sessionFile),
    exitCode: 0,
    finalText: null,
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
  if (run.nativeSessionFile) write(run.nativeSessionFile);
  store.createWorker(worker, run, "scope", id, "start", id);
}

function finishActive(service: WorkerService): void {
  for (const run of service.store.activeRuns()) {
    run.status = "interrupted";
    service.store.saveRun(run);
  }
}

function captureCleanupLogs(t: TestContext): string[] {
  const messages: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    messages.push(String(chunk));
    return true;
  });
  return messages;
}

function walkFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index++) await Promise.resolve();
}

async function waitUntil(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for native cleanup");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
