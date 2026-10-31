import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { WorkerOwner } from "../shared/contracts.js";
import {
  createService,
  git,
  startInput,
  temporaryRoot,
  waitStatus,
} from "./helpers.js";

function secondOwner(projectPath: string): WorkerOwner {
  return {
    id: "owner-2",
    parentSessionId: "parent-2",
    projectId: "project-2",
    projectPath,
    userId: 2,
    appServerInstanceId: "app-2",
    paused: false,
  };
}

test("UI and MCP cancel honor authenticated parent+project scope", async (t) => {
  const root = temporaryRoot("worker-scope-cancel-");
  const { service, project } = createService(t, root, { TEST_SCENARIO: "hang" });
  const project2 = path.join(root, "project2");
  fs.mkdirSync(project2, { recursive: true });
  service.registerOwner(secondOwner(project2), "owner-2-token");
  const first = await service.start("owner-1", startInput({ requestId: "scope-1" }));
  const other = await service.start("owner-2", startInput({ requestId: "scope-2" }));
  await waitStatus(service, first.worker.id, ["running"]);
  await waitStatus(service, other.worker.id, ["running"]);

  // MCP all is exact generation + its logical parent/project, never another owner.
  const mcpCancelled = await service.cancel({ all: true }, "ui", "owner-2");
  assert.deepEqual(mcpCancelled, [other.worker.id]);
  assert.equal(service.get(other.worker.id).worker.latestRun?.status, "cancelled");
  assert.equal(service.get(first.worker.id).worker.latestRun?.status, "running");

  const replacement = await service.start(
    "owner-2",
    startInput({ requestId: "scope-3" }),
  );
  await waitStatus(service, replacement.worker.id, ["running"]);
  // UI all still obeys supplied parent/project filters and pauses only that scope.
  const uiCancelled = await service.cancel({
    all: true,
    parentSessionId: "parent-1",
    projectId: "project-1",
    pause: true,
  });
  assert.deepEqual(uiCancelled, [first.worker.id]);
  assert.equal(service.get(first.worker.id).worker.latestRun?.status, "cancelled");
  assert.equal(service.get(replacement.worker.id).worker.latestRun?.status, "running");
  assert.equal(service.store.owner("owner-1")?.paused, true);
  assert.equal(service.store.owner("owner-2")?.paused, false);
  const scopedNotification = service
    .notifications()
    .find((item) => item.workerId === first.worker.id);
  assert.equal(scopedNotification?.delivery, "held");

  const remaining = await service.cancel({
    all: true,
    parentSessionId: "parent-2",
    projectId: "project-2",
  });
  assert.deepEqual(remaining, [replacement.worker.id]);
  assert.equal(service.get(replacement.worker.id).worker.latestRun?.status, "cancelled");
  assert.equal(service.get(first.worker.id).worker.latestRun?.status, "cancelled");
  assert.equal(project.endsWith("project"), true);
});

test("pause holds notifications, blocks claim, and retry emits a notification event", async (t) => {
  const root = temporaryRoot("worker-notify-control-");
  const events: unknown[] = [];
  const { service } = createService(t, root, {}, { onEvent: (event) => events.push(event) });
  const started = await service.start("owner-1", startInput({ requestId: "notify-1" }));
  const completed = await waitStatus(service, started.worker.id, ["completed"]);
  const notification = service.notifications()[0]!;
  assert.equal(notification.delivery, "pending");

  await service.setOwnerPaused("owner-1", true, "test pause");
  const scopedNotification = service
    .notifications()
    .find((item) => item.workerId === started.worker.id);
  assert.equal(scopedNotification?.delivery, "held");
  assert.equal(
    events.some(
      (event) =>
        (event as { event?: string }).event === "notification" &&
        (event as { value?: { delivery?: string } }).value?.delivery === "held",
    ),
    true,
  );
  assert.throws(
    () => service.claimNotifications("owner-1", [], "paused-batch"),
    /暂停/,
  );

  await service.setOwnerPaused("owner-1", false);
  events.length = 0;
  const retried = service.retryNotifications([notification.id]);
  assert.equal(retried.retried, 1);
  const retryEvent = events.find(
    (event) =>
      (event as { event?: string }).event === "notification" &&
      (event as { value?: { id?: string } }).value?.id === notification.id,
  ) as { value: { delivery: string; ownerId: string } } | undefined;
  assert.equal(retryEvent?.value.delivery, "pending");
  assert.equal(retryEvent?.value.ownerId, "owner-1");
  const claimed = service.claimNotifications("owner-1", [notification.id], "batch-1");
  assert.equal(claimed.notifications.length, 1);
  assert.equal(claimed.notifications[0]?.delivery, "pending");
  assert.equal(completed.latestRun?.status, "completed");
});

test("worktree and explicit existing cwd actually launch in the selected directory", async (t) => {
  const root = temporaryRoot("worker-cwd-e2e-");
  const { service, project } = createService(t, root);
  git(project, ["init", "-b", "main"]);
  git(project, ["config", "user.email", "worker@example.test"]);
  git(project, ["config", "user.name", "Worker Test"]);
  fs.mkdirSync(path.join(project, "sub"));
  fs.writeFileSync(path.join(project, "sub", "tracked.txt"), "one\n");
  git(project, ["add", "."]);
  git(project, ["commit", "-m", "initial"]);

  const sessionCwd = (workerId: string, runId: string): string => {
    const file = path.join(root, "data", "logs", workerId, runId, "events.log");
    const first = fs.readFileSync(file, "utf8").split("\n")[0]!;
    return (JSON.parse(first) as { cwd: string }).cwd;
  };

  const created = await service.start(
    "owner-1",
    startInput({
      taskName: "worktree cwd",
      workspace: { mode: "worktree" },
      requestId: "cwd-worktree",
    }),
  );
  const worktree = await waitStatus(service, created.worker.id, ["completed"]);
  const worktreePath = worktree.workspace.path;
  assert.notEqual(worktreePath, project);
  assert.equal(worktree.cwd, worktreePath);
  assert.equal(sessionCwd(worktree.id, worktree.latestRun!.id), worktreePath);
  assert.equal(git(project, ["status", "--porcelain"]).trim(), "");

  const existing = await service.start(
    "owner-1",
    startInput({
      taskName: "existing subdir",
      workspace: { mode: "existing", cwd: path.join(project, "sub") },
      requestId: "cwd-existing",
    }),
  );
  const selected = await waitStatus(service, existing.worker.id, ["completed"]);
  assert.equal(selected.cwd, fs.realpathSync(path.join(project, "sub")));
  assert.equal(sessionCwd(selected.id, selected.latestRun!.id), selected.cwd);
  assert.equal(git(project, ["status", "--porcelain"]).trim(), "");
});

test("pausing an empty owner scope fences admission before the first start", async (t) => {
  const root = temporaryRoot("worker-empty-pause-");
  const { service } = createService(t, root);
  const project2 = path.join(root, "project2");
  fs.mkdirSync(project2, { recursive: true });
  service.registerOwner(secondOwner(project2), "owner-2-token");
  const cancelled = await service.cancel({
    all: true,
    parentSessionId: "parent-1",
    projectId: "project-1",
    pause: true,
  });
  assert.deepEqual(cancelled, []);
  assert.equal(service.store.owner("owner-1")?.paused, true);
  assert.equal(service.store.owner("owner-2")?.paused, false);
  await assert.rejects(
    service.start("owner-1", startInput({ requestId: "empty-pause" })),
    /暂停/,
  );
  const other = await service.start("owner-2", startInput({ requestId: "empty-pause-2" }));
  await waitStatus(service, other.worker.id, ["running"]);
  await service.cancel({ all: true, parentSessionId: "parent-2", projectId: "project-2" });
});

test("instance close retires live authority and retry binds the current generation", async (t) => {
  const root = temporaryRoot("worker-generation-retire-");
  const { service, project } = createService(t, root);
  const started = await service.start("owner-1", startInput({ requestId: "generation-1" }));
  const completed = await waitStatus(service, started.worker.id, ["completed"]);
  const notification = service.notifications()[0]!;
  assert.equal(notification.ownerId, "owner-1");

  const closed = await service.closeInstance("app-1", "app-server restart");
  assert.deepEqual(closed.workerIds, []);
  assert.equal(service.ownerForToken("owner-token"), null);
  assert.equal(service.store.owner("owner-1")?.paused, true);
  assert.equal(service.get(completed.id).worker.ownerId, "owner-1");

  const nextOwner: WorkerOwner = {
    id: "owner-2",
    parentSessionId: "parent-1",
    projectId: "project-1",
    projectPath: project,
    userId: 1,
    appServerInstanceId: "app-2",
    paused: false,
  };
  service.registerOwner(nextOwner, "owner-2-token");
  assert.equal(service.ownerForToken("owner-2-token")?.id, "owner-2");
  assert.equal(service.ownerForToken("owner-token"), null);

  service.retryNotifications([notification.id]);
  const rebound = service.notifications().find((item) => item.id === notification.id)!;
  assert.equal(rebound.ownerId, "owner-2");
  assert.equal(rebound.delivery, "pending");
  assert.equal(service.ownerForToken("owner-2-token")?.paused, false);
  const claimed = service.claimNotifications("owner-2", [notification.id], "generation-batch");
  assert.equal(claimed.notifications.length, 1);
  assert.throws(
    () => service.claimNotifications("owner-1", [], "old-generation"),
    /当前宿主进程/,
  );

  const unrelated: WorkerOwner = {
    id: "owner-3",
    parentSessionId: "other-parent",
    projectId: "other-project",
    projectPath: project,
    userId: 3,
    appServerInstanceId: "app-3",
    paused: false,
  };
  service.registerOwner(unrelated, "owner-3-token");
  assert.throws(() => service.get(completed.id, "owner-3"), /不存在/);
  assert.deepEqual(
    await service.cancel({ all: true }, "ui", "owner-3"),
    [],
  );
  assert.equal(
    service.claimNotifications("owner-3", [notification.id], "unrelated").notifications.length,
    0,
  );
});

test("closeAll retires every live owner/token but keeps persisted records", async (t) => {
  const root = temporaryRoot("worker-generation-close-all-");
  const { service, project } = createService(t, root);
  const project2 = path.join(root, "project2");
  fs.mkdirSync(project2, { recursive: true });
  service.registerOwner(secondOwner(project2), "owner-2-token");
  const result = await service.closeAll("host exit");
  assert.deepEqual(result.workerIds, []);
  assert.equal(service.ownerForToken("owner-token"), null);
  assert.equal(service.ownerForToken("owner-2-token"), null);
  assert.equal(service.owner("owner-1"), null);
  assert.equal(service.owner("owner-2"), null);
  assert.equal(service.store.owner("owner-1")?.paused, true);
  assert.equal(service.store.owner("owner-2")?.paused, true);
  assert.equal(project.endsWith("project"), true);
});

test("late close of the old instance leaves an explicitly resumed run untouched", async (t) => {
  const root = temporaryRoot("worker-generation-late-close-");
  const { service, project } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "900",
  });
  const started = await service.start("owner-1", startInput({ requestId: "late-1" }));
  const first = await waitStatus(service, started.worker.id, ["completed"]);
  const nextOwner: WorkerOwner = {
    id: "owner-2",
    parentSessionId: "parent-1",
    projectId: "project-1",
    projectPath: project,
    userId: 1,
    appServerInstanceId: "app-2",
    paused: false,
  };
  service.registerOwner(nextOwner, "owner-2-token");
  await service.resume("owner-2", {
    workerId: first.id,
    prompt: "resume on new generation",
    requestId: "late-2",
  });
  await waitStatus(service, first.id, ["running"]);
  const closed = await service.closeInstance("app-1", "late old close");
  assert.deepEqual(closed.workerIds, []);
  assert.equal(service.ownerForToken("owner-token"), null);
  assert.equal(service.ownerForToken("owner-2-token")?.id, "owner-2");
  assert.equal(service.get(first.id).worker.ownerId, "owner-2");
  assert.equal(service.get(first.id).worker.latestRun?.status, "running");
  const replacement = await waitStatus(service, first.id, ["completed"]);
  assert.equal(replacement.ownerId, "owner-2");
});

test("cleanup is refused while another worker uses the same cwd", async (t) => {
  const root = temporaryRoot("worker-cleanup-users-");
  const { service, project } = createService(t, root, {
    TEST_SCENARIO: "sleep",
    TEST_DELAY_MS: "900",
  });
  git(project, ["init", "-b", "main"]);
  git(project, ["config", "user.email", "worker@example.test"]);
  git(project, ["config", "user.name", "Worker Test"]);
  fs.writeFileSync(path.join(project, "file.txt"), "one\n");
  git(project, ["add", "."]);
  git(project, ["commit", "-m", "initial"]);

  const creator = await service.start(
    "owner-1",
    startInput({
      taskName: "creator",
      workspace: { mode: "worktree" },
      requestId: "cleanup-1",
    }),
  );
  const created = await waitStatus(service, creator.worker.id, ["completed"]);
  const worktreePath = created.workspace.path;
  const user = await service.start(
    "owner-1",
    startInput({
      taskName: "user",
      workspace: { mode: "existing", cwd: worktreePath },
      requestId: "cleanup-2",
    }),
  );
  await waitStatus(service, user.worker.id, ["running"]);
  await assert.rejects(
    service.cleanup({ workerId: creator.worker.id }),
    /仍有活动 worker/,
  );
  await service.cancel({ workerIds: [user.worker.id] }, "host");
  await service.cleanup({ workerId: creator.worker.id });
  assert.equal(fs.existsSync(worktreePath), false);
  assert.match(
    git(project, ["branch", "--list", created.workspace.branch!]),
    /cloudcli-worker\//,
  );
});

test("a merged worktree is removed while native history stays and new resumes are rejected", async (t) => {
  const root = temporaryRoot("worker-merged-cleanup-");
  const { service, project } = createService(t, root);
  git(project, ["init", "-b", "main"]);
  git(project, ["config", "user.email", "worker@example.test"]);
  git(project, ["config", "user.name", "Worker Test"]);
  fs.writeFileSync(path.join(project, "file.txt"), "initial\n");
  git(project, ["add", "."]);
  git(project, ["commit", "-m", "initial"]);
  const start = await service.start("owner-1", startInput({
    workspace: { mode: "worktree" }, requestId: "merged-cleanup-start",
  }));
  const done = await waitStatus(service, start.worker.id, ["completed"]);
  // Integration is the parent's responsibility; only the test parent commits and merges.
  fs.writeFileSync(path.join(done.cwd, "file.txt"), "integrated\n");
  git(done.cwd, ["add", "."]);
  git(done.cwd, ["commit", "-m", "worker result"]);
  git(project, ["merge", "--ff-only", done.workspace.branch!]);
  await service.cleanup({ workerId: done.id });
  assert.equal(fs.existsSync(done.cwd), false);
  assert.equal(fs.readFileSync(path.join(project, "file.txt"), "utf8"), "integrated\n");
  assert.match(git(project, ["branch", "--list", done.workspace.branch!]), /cloudcli-worker\//);
  assert.equal(fs.existsSync(done.latestRun!.nativeSessionFile!), true);
  assert.equal(service.get(done.id).runs.length, 1);
  await assert.rejects(service.resume("owner-1", {
    workerId: done.id, requestId: "after-cleanup", prompt: "new work",
  }), (error: unknown) => (error as { code: string }).code === "WORKSPACE_CLEANED");
  assert.equal(service.get(done.id).runs.length, 1);
  const replay = await service.start("owner-1", startInput({
    workspace: { mode: "worktree" }, requestId: "merged-cleanup-start",
  }));
  assert.equal(replay.run.id, start.run.id);
});
