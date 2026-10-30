import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { WorkspaceManager } from "../server/worktree.js";
import type { WorkerRecord } from "../shared/contracts.js";
import { git, temporaryRoot } from "./helpers.js";

function repository(root: string): string {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "worker@example.test"]);
  git(repo, ["config", "user.name", "Worker Test"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

test("validates existing paths and creates clean plugin worktrees", async () => {
  const root = temporaryRoot("worker-worktree-");
  const repo = repository(root);
  const manager = new WorkspaceManager(path.join(root, "data"));
  const existing = await manager.resolve("w1", repo, { mode: "existing" });
  assert.deepEqual(existing, { mode: "existing", path: repo });
  const nested = path.join(repo, "nested");
  fs.mkdirSync(nested);
  const subdirectory = await manager.resolve("w1b", repo, {
    mode: "existing",
    cwd: nested,
  });
  assert.equal(subdirectory.path, fs.realpathSync(nested));

  fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
  await assert.rejects(
    manager.resolve("w2", repo, { mode: "worktree" }),
    /未提交改动/,
  );
  const created = await manager.resolve("w2", repo, {
    mode: "worktree",
    allowDirtySource: true,
  });
  assert.equal(created.createdByPlugin, true);
  assert.equal(created.mode, "worktree");
  assert.equal(created.baseCommit, git(repo, ["rev-parse", "HEAD"]).trim());
  assert.ok(fs.existsSync(created.path));
  assert.equal(git(created.path, ["status", "--porcelain"]).trim(), "");

  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  await assert.rejects(
    manager.resolve("w3", repo, { mode: "existing", cwd: outside }),
    /不属于项目/,
  );

  const extra = path.join(root, "extra");
  git(repo, ["worktree", "add", extra, "HEAD"]);
  const existingWorktree = await manager.resolve("w4", repo, {
    mode: "existing",
    cwd: extra,
  });
  assert.equal(existingWorktree.path, fs.realpathSync(extra));
});

test("cleanup refuses dirty worktrees and keeps the branch", async () => {
  const root = temporaryRoot("worker-cleanup-");
  const repo = repository(root);
  const manager = new WorkspaceManager(path.join(root, "data"));
  const workspace = await manager.resolve("w5", repo, { mode: "worktree" });
  const worker = {
    id: "w5",
    workspace,
    type: "dsh" as const,
  } as WorkerRecord;
  fs.writeFileSync(path.join(workspace.path, "tracked.txt"), "changed\n");
  await assert.rejects(manager.cleanup(worker), /未提交改动/);
  fs.writeFileSync(path.join(workspace.path, "tracked.txt"), "one\n");
  await manager.cleanup(worker);
  assert.equal(fs.existsSync(workspace.path), false);
  assert.match(
    git(repo, ["branch", "--list", workspace.branch!]),
    /cloudcli-worker\/w5/,
  );
  await assert.rejects(manager.cleanup(worker), /已不存在/);
});
