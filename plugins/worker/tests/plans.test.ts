import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { WorkerService } from "../server/service.js";
import { createService, owner, temporaryRoot } from "./helpers.js";

test("plans preserve Markdown and isolate parent/project scopes without execution side effects", (t) => {
  let now = Date.parse("2026-11-02T00:00:00.000Z");
  const events: unknown[] = [];
  const { service, project } = createService(t, temporaryRoot("worker-plans-"), {}, {
    now: () => now,
    onEvent: (event) => events.push(event),
  });
  const before = service.state();
  assert.equal(service.context("owner-1").plan, null);

  const content = "# 当前目标\n\n- W1: 接口待验收\n- W2: 依赖 W1，产物尚未进入工作区\n\n    保留缩进与末尾换行\n";
  const saved = service.savePlan("owner-1", content);
  assert.deepEqual(saved, { content, updatedAt: new Date(now).toISOString() });
  assert.deepEqual(service.context("owner-1").plan, saved);

  now += 1000;
  const revised = service.savePlan("owner-1", content.replace("接口待验收", "接口已验收"));
  assert.deepEqual(service.context("owner-1").plan, revised);
  assert.notEqual(revised.updatedAt, saved.updatedAt);
  assert.equal(revised.content, content.replace("接口待验收", "接口已验收"));

  service.registerOwner({ ...owner(project), id: "other-parent", parentSessionId: "parent-2" }, "parent-token");
  service.registerOwner({ ...owner(project), id: "other-project", projectId: "project-2" }, "project-token");
  for (const id of ["other-parent", "other-project"]) {
    assert.equal(service.context(id).plan, null);
    const isolated = service.savePlan(id, "# " + id);
    assert.deepEqual(service.context(id).plan, isolated);
    assert.deepEqual(service.context("owner-1").plan, revised);
  }

  assert.deepEqual(service.state(), before);
  assert.deepEqual(events, []);
  assert.deepEqual(fs.readdirSync(project), []);
});

test("existing databases gain plan storage and retain it across restart and owner replacement", async (t) => {
  const root = temporaryRoot("worker-plan-restart-");
  const options = {
    dataDirectory: path.join(root, "data"),
    environment: { HOME: path.join(root, "home") },
  };
  let service = new WorkerService(options);
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const originalOwner = owner(root);
  service.registerOwner(originalOwner, "first-token");
  service.updateSettings({ concurrency: { dsh: 2, pi: 1 } });
  await service.close();

  // An existing installation has all its previous tables, but no plans table yet.
  const legacy = new Database(path.join(options.dataDirectory, "worker.db"));
  legacy.exec("DROP TABLE plans");
  legacy.close();
  service = new WorkerService(options);
  service.recoverFromDisk();
  service.registerOwner(originalOwner, "second-token");
  assert.deepEqual(service.settings().concurrency, { dsh: 2, pi: 1, codex: 3 });
  assert.equal(service.context(originalOwner.id).plan, null);
  const saved = service.savePlan(originalOwner.id, "# 已验收\n\nW1 的验证通过；W2 仍需确认产物位置。\n");
  await service.close();

  service = new WorkerService(options);
  service.recoverFromDisk();
  service.registerOwner({ ...originalOwner, id: "new-owner", appServerInstanceId: "new-app" }, "new-token");
  assert.deepEqual(service.context("new-owner").plan, saved);
  const revised = service.savePlan("new-owner", saved.content + "\nW2 产物已进入工作区。\n");
  assert.deepEqual(service.context("new-owner").plan, revised);
  assert.deepEqual(service.settings().concurrency, { dsh: 2, pi: 1, codex: 3 });
  assert.deepEqual(service.state().workers, []);
});
