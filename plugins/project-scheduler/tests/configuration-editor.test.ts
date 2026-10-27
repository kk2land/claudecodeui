import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectScheduler } from "../server/scheduler.js";
import { SchedulerStore } from "../server/store.js";
import type {
  SchedulerConfigurationSave,
  SchedulerProject,
} from "../shared/contracts.js";

const FILE = path.join(".cloudcli", "project-schedules.json");

function fixture(t: TestContext, withCloudcli = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-config-editor-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  if (withCloudcli)
    fs.mkdirSync(path.join(projectPath, ".cloudcli"), { recursive: true });
  const catalog = path.join(root, "projects.json");
  fs.writeFileSync(
    catalog,
    JSON.stringify({
      generatedAt: Date.now(),
      projects: [{ id: "p", name: "project", path: projectPath }],
    }),
  );
  const store = new SchedulerStore(path.join(root, "data"));
  const scheduler = new ProjectScheduler(store, catalog);
  t.after(async () => {
    await scheduler.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project: SchedulerProject = {
    id: "p",
    name: "project",
    path: projectPath,
  };
  const file = path.join(projectPath, FILE);
  const text = (tasks: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 1, ...extra, tasks }, null, 2);
  const write = (content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  return { root, project, projectPath, store, scheduler, file, text, write };
}
function scriptTask(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "script",
    cron: "0 0 0 1 1 *",
    command: process.execPath,
    args: ["-e", "1"],
    ...extra,
  };
}
function hash(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}
function assertRejected(
  result: SchedulerConfigurationSave,
  pattern: RegExp,
): void {
  assert.equal(result.saved, false);
  assert.equal(result.loaded, false);
  assert.match(result.error ?? "", pattern);
}
function timerCount(scheduler: ProjectScheduler): number {
  return (
    scheduler as unknown as { timers: Map<string, unknown> }
  ).timers.size;
}

test("an absent configuration is returned as an empty draft and is never created by reads", (t) => {
  const f = fixture(t);
  const document = f.scheduler.readConfiguration("p")!;
  assert.equal(document.exists, false);
  assert.equal(document.revision, null);
  assert.equal(document.error, undefined);
  assert.deepEqual(JSON.parse(document.text), { version: 1, tasks: [] });
  const preview = f.scheduler.previewConfiguration("p", document.text)!;
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.tasks, []);
  assert.deepEqual(preview.changes, {
    added: 0,
    updated: 0,
    removed: 0,
    reEnabled: 0,
  });
  assert.equal(fs.existsSync(path.join(f.projectPath, ".cloudcli")), false);
  assert.equal(f.store.definitions().length, 0);
});

test("the first save creates a private file and later reads report its exact revision", (t) => {
  const f = fixture(t);
  const content = f.text([scriptTask("alpha")]);
  const saved = f.scheduler.saveConfiguration("p", content, null)!;
  assert.equal(saved.saved, true);
  assert.equal(saved.loaded, true);
  assert.equal(saved.revision, hash(content));
  assert.deepEqual(saved.changes, {
    added: 1,
    updated: 0,
    removed: 0,
    reEnabled: 0,
  });
  assert.equal(fs.readFileSync(f.file, "utf8"), content);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.equal(
      fs.statSync(path.dirname(f.file)).mode & 0o777,
      0o700,
    );
  }
  const document = f.scheduler.readConfiguration("p")!;
  assert.equal(document.exists, true);
  assert.equal(document.text, content);
  assert.equal(document.revision, hash(content));
  assert.equal(document.error, undefined);
  assert.equal(timerCount(f.scheduler), 1);
  // Saving the identical text again is an idempotent update and never duplicates timers.
  const again = f.scheduler.saveConfiguration("p", content, saved.revision)!;
  assert.equal(again.saved, true);
  assert.equal(again.loaded, true);
  assert.deepEqual(again.changes, {
    added: 0,
    updated: 0,
    removed: 0,
    reEnabled: 0,
  });
  assert.equal(timerCount(f.scheduler), 1);
  assert.equal(f.store.definitions().length, 1);
});

test("unknown top-level and task fields survive a save unchanged", (t) => {
  const f = fixture(t);
  const content = f.text(
    [
      scriptTask("alpha", {
        labels: ["ops", "nightly"],
        "x-plugin": { retries: 2 },
      }),
    ],
    {
      timezone: "Asia/Shanghai",
      defaults: { timeoutSeconds: 120 },
      "x-meta": { owner: "team", notes: ["keep", { nested: true }] },
    },
  );
  const saved = f.scheduler.saveConfiguration("p", content, null)!;
  assert.equal(saved.saved, true);
  assert.equal(fs.readFileSync(f.file, "utf8"), content);
  const stored = JSON.parse(fs.readFileSync(f.file, "utf8")) as Record<
    string,
    any
  >;
  assert.deepEqual(stored["x-meta"], {
    owner: "team",
    notes: ["keep", { nested: true }],
  });
  assert.deepEqual(stored.tasks[0]["x-plugin"], { retries: 2 });
  const document = f.scheduler.readConfiguration("p")!;
  assert.equal(document.revision, hash(content));
  assert.equal(document.text, content);
});

test("removed tasks are deleted from the store and from other projects only for this project", (t) => {
  const f = fixture(t);
  const first = f.text([scriptTask("alpha"), scriptTask("beta")]);
  const saved = f.scheduler.saveConfiguration("p", first, null)!;
  const other = f.scheduler.previewConfiguration("p", f.text([scriptTask("alpha")]))!;
  assert.equal(other.valid, true);
  // Import an independent project through the store; the editor must not touch it.
  const loaded = f.store.definitions()[0]!.definition;
  f.store.importProject("other", [{ ...loaded, id: "beta" }], false);
  const second = f.text([scriptTask("alpha")]);
  const removed = f.scheduler.saveConfiguration("p", second, saved.revision)!;
  assert.equal(removed.saved, true);
  assert.equal(removed.loaded, true);
  assert.equal(removed.changes.removed, 1);
  assert.deepEqual(
    f.store
      .definitions()
      .filter((row) => row.projectId === "p")
      .map((row) => row.taskId),
    ["alpha"],
  );
  assert.deepEqual(
    f.store
      .definitions()
      .filter((row) => row.projectId === "other")
      .map((row) => row.taskId),
    ["beta"],
  );
  assert.equal(timerCount(f.scheduler), 1);
});

test("invalid drafts are rejected without changing the file, the store, or timers", (t) => {
  const f = fixture(t);
  const original = f.text([scriptTask("alpha")]);
  const saved = f.scheduler.saveConfiguration("p", original, null)!;
  assert.equal(saved.saved, true);
  const definitions = JSON.stringify(f.store.definitions());
  const invalid = {
    "broken JSON": ["{ version: 1, tasks: ["],
    "invalid cron": [f.text([scriptTask("bad", { cron: "61 * * * *" })])],
    "invalid timezone": [
      f.text([scriptTask("bad")], { timezone: "Mars/Olympus" }),
    ],
    "duplicate ID": [
      f.text([scriptTask("same"), scriptTask("same")]),
    ],
    "bad version": [JSON.stringify({ version: 2, tasks: [] })],
    "oversized text": [
      f.text([scriptTask("huge", { note: "x".repeat(1024 * 1024) })]),
    ],
  };
  for (const [label, [text]] of Object.entries(invalid)) {
    const preview = f.scheduler.previewConfiguration("p", text!)!;
    assert.equal(preview.valid, false, label);
    assert.ok((preview.errors?.length ?? 0) > 0, label);
    const result = f.scheduler.saveConfiguration("p", text!, saved.revision)!;
    assert.equal(result.saved, false, label);
    assert.equal(result.loaded, false, label);
    assert.ok((result.error?.length ?? 0) > 0, label);
    assert.equal(fs.readFileSync(f.file, "utf8"), original, label);
    assert.equal(JSON.stringify(f.store.definitions()), definitions, label);
  }
  assert.deepEqual(
    f.store.definitions().map((row) => row.taskId),
    ["alpha"],
  );
  assert.equal(timerCount(f.scheduler), 1);
  assert.equal(f.scheduler.readConfiguration("p")!.revision, saved.revision);
});

test("an invalid existing file stays readable and can be repaired in place", (t) => {
  const f = fixture(t, true);
  const broken = '{ "version": 1, "tasks": [ }';
  f.write(broken);
  const document = f.scheduler.readConfiguration("p")!;
  assert.equal(document.exists, true);
  assert.equal(document.text, broken);
  assert.equal(document.revision, hash(broken));
  assert.match(document.error ?? "", /JSON 无效/);
  const preview = f.scheduler.previewConfiguration("p", broken)!;
  assert.equal(preview.valid, false);
  const repaired = f.text([scriptTask("repaired")]);
  const result = f.scheduler.saveConfiguration("p", repaired, document.revision)!;
  assert.equal(result.saved, true);
  assert.equal(result.loaded, true);
  assert.equal(f.scheduler.readConfiguration("p")!.text, repaired);
});

test("external edits, creations, and deletions are conflicts that never overwrite the file", async (t) => {
  const f = fixture(t);
  const original = f.text([scriptTask("alpha")]);
  const saved = f.scheduler.saveConfiguration("p", original, null)!;
  assert.equal(saved.saved, true);
  const draft = f.text([scriptTask("alpha"), scriptTask("beta")]);
  const external = f.text([scriptTask("external")]);
  fs.writeFileSync(f.file, external);
  const edited = f.scheduler.saveConfiguration("p", draft, saved.revision)!;
  assert.equal(edited.saved, false);
  assert.equal(edited.loaded, false);
  assert.equal(edited.conflict, true);
  assert.equal(edited.revision, hash(external));
  assert.equal(edited.latest?.text, external);
  assert.equal(edited.latest?.revision, hash(external));
  assert.equal(fs.readFileSync(f.file, "utf8"), external);
  assert.deepEqual(
    f.store.definitions().map((row) => row.taskId),
    ["alpha"],
  );

  // A file created after the editor read an empty draft is a conflict too.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "cron-config-fresh-"));
  const freshProject = path.join(fresh, "project");
  fs.mkdirSync(freshProject);
  const freshCatalog = path.join(fresh, "projects.json");
  fs.writeFileSync(
    freshCatalog,
    JSON.stringify({
      generatedAt: Date.now(),
      projects: [{ id: "fresh", name: "fresh", path: freshProject }],
    }),
  );
  const freshStore = new SchedulerStore(path.join(fresh, "data"));
  const freshScheduler = new ProjectScheduler(freshStore, freshCatalog);
  t.after(async () => {
    await freshScheduler.close();
    freshStore.close();
    fs.rmSync(fresh, { recursive: true, force: true });
  });
  const empty = freshScheduler.readConfiguration("fresh")!;
  assert.equal(empty.exists, false);
  assert.equal(empty.revision, null);
  const createdLater = f.text([scriptTask("created")]);
  fs.mkdirSync(path.join(freshProject, ".cloudcli"));
  fs.writeFileSync(path.join(freshProject, FILE), createdLater);
  const created = freshScheduler.saveConfiguration(
    "fresh",
    f.text([scriptTask("draft")]),
    null,
  )!;
  assert.equal(created.saved, false);
  assert.equal(created.conflict, true);
  assert.equal(created.latest?.text, createdLater);
  assert.equal(
    fs.readFileSync(path.join(freshProject, FILE), "utf8"),
    createdLater,
  );
  assert.equal(freshStore.definitions().length, 0);

  // Deleting the file after a read is a conflict and the failed save does not recreate it.
  fs.unlinkSync(path.join(freshProject, FILE));
  const deleted = freshScheduler.saveConfiguration(
    "fresh",
    f.text([scriptTask("draft")]),
    created.revision,
  )!;
  assert.equal(deleted.saved, false);
  assert.equal(deleted.conflict, true);
  assert.equal(deleted.latest?.exists, false);
  assert.equal(fs.existsSync(path.join(freshProject, FILE)), false);
  assert.equal(freshStore.definitions().length, 0);
});

test("symlinked configuration directories and files outside the project are rejected", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  const outsideFile = path.join(outside, "project-schedules.json");
  const external = f.text([scriptTask("outside")]);
  fs.writeFileSync(outsideFile, external);
  // A symlinked .cloudcli directory must not escape the project.
  fs.symlinkSync(outside, path.join(f.projectPath, ".cloudcli"));
  const document = f.scheduler.readConfiguration("p")!;
  assert.match(document.error ?? "", /项目外/);
  const preview = f.scheduler.previewConfiguration("p", external)!;
  assert.equal(preview.valid, false);
  const rejected = f.scheduler.saveConfiguration("p", external, null)!;
  assertRejected(rejected, /项目外/);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), external);
  assert.equal(f.store.definitions().length, 0);
  // A symlinked configuration file inside a real .cloudcli must also stay inside the project.
  fs.unlinkSync(path.join(f.projectPath, ".cloudcli"));
  fs.mkdirSync(path.join(f.projectPath, ".cloudcli"));
  fs.symlinkSync(outsideFile, path.join(f.projectPath, FILE));
  const fileDocument = f.scheduler.readConfiguration("p")!;
  assert.match(fileDocument.error ?? "", /项目外/);
  const fileSave = f.scheduler.saveConfiguration(
    "p",
    f.text([scriptTask("draft")]),
    fileDocument.revision,
  )!;
  assertRejected(fileSave, /项目外/);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), external);
  assert.equal(f.store.definitions().length, 0);
});

test("a temporary disable is re-enabled from JSON and reported as reEnabled, not updated", (t) => {
  const f = fixture(t);
  const content = f.text([scriptTask("toggle")]);
  const saved = f.scheduler.saveConfiguration("p", content, null)!;
  assert.equal(saved.saved, true);
  f.scheduler.setTaskEnabled("p", "toggle", false);
  assert.equal(f.scheduler.inventory()[0]!.definition.enabled, false);
  assert.equal(f.scheduler.inventory()[0]!.nextRun, null);
  assert.equal(fs.readFileSync(f.file, "utf8"), content);
  const preview = f.scheduler.previewConfiguration("p", content)!;
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.changes, {
    added: 0,
    updated: 0,
    removed: 0,
    reEnabled: 1,
  });
  assert.equal(preview.tasks[0]!.nextRuns.length, 5);
  const result = f.scheduler.saveConfiguration("p", content, saved.revision)!;
  assert.equal(result.saved, true);
  assert.equal(result.loaded, true);
  assert.equal(result.changes.reEnabled, 1);
  assert.equal(result.changes.updated, 0);
  assert.equal(f.scheduler.inventory()[0]!.definition.enabled, true);
  assert.ok(f.scheduler.inventory()[0]!.nextRun);
  assert.equal(timerCount(f.scheduler), 1);
});

test("disabled tasks keep an empty next-run preview while enabled tasks are capped at five", (t) => {
  const f = fixture(t);
  const content = f.text([
    scriptTask("enabled"),
    scriptTask("disabled", { enabled: false }),
  ]);
  const preview = f.scheduler.previewConfiguration("p", content)!;
  assert.equal(preview.valid, true);
  const enabled = preview.tasks.find((item) => item.taskId === "enabled")!;
  const disabled = preview.tasks.find((item) => item.taskId === "disabled")!;
  assert.equal(enabled.nextRuns.length, 5);
  assert.ok(enabled.nextRuns.every((value) => !Number.isNaN(Date.parse(value))));
  assert.deepEqual(disabled.nextRuns, []);
});

test("active runs and their snapshots survive a configuration save", async (t) => {
  const f = fixture(t);
  const content = f.text([
    scriptTask("slow", { args: ["-e", "setTimeout(()=>{},4000)"] }),
  ]);
  const saved = f.scheduler.saveConfiguration("p", content, null)!;
  assert.equal(saved.saved, true);
  const run = f.scheduler.start("p", "slow", "manual");
  assert.equal(run.status, "running");
  const changed = f.text([
    scriptTask("slow", { cron: "0 0 0 1 2 *", args: ["-e", "1"] }),
  ]);
  const result = f.scheduler.saveConfiguration("p", changed, saved.revision)!;
  assert.equal(result.saved, true);
  assert.equal(result.loaded, true);
  assert.equal(result.changes.updated, 1);
  assert.equal(f.store.run(run.id)?.status, "running");
  assert.deepEqual(f.scheduler.snapshot(run.id).task?.args, [
    "-e",
    "setTimeout(()=>{},4000)",
  ]);
  f.scheduler.stop(run.id);
  const deadline = Date.now() + 8000;
  while (!f.store.run(run.id)?.endedAt && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.store.run(run.id)?.status, "stopped");
});

test("an atomic rename failure preserves the old file and loaded definitions", (t) => {
  const f = fixture(t);
  const original = f.text([scriptTask("alpha")]);
  const saved = f.scheduler.saveConfiguration("p", original, null)!;
  assert.equal(saved.saved, true);
  const before = JSON.stringify(f.store.definitions());
  const draft = f.text([scriptTask("alpha"), scriptTask("beta")]);
  t.mock.method(fs, "renameSync", () => {
    throw new Error("rename blocked");
  });
  const failed = f.scheduler.saveConfiguration("p", draft, saved.revision)!;
  assert.equal(failed.saved, false);
  assert.equal(failed.loaded, false);
  assert.match(failed.error ?? "", /写入配置失败/);
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
  assert.equal(JSON.stringify(f.store.definitions()), before);
  assert.deepEqual(
    fs.readdirSync(path.dirname(f.file)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  assert.equal(timerCount(f.scheduler), 1);
  t.mock.restoreAll();
  const retried = f.scheduler.saveConfiguration("p", draft, saved.revision)!;
  assert.equal(retried.saved, true);
  assert.equal(retried.loaded, true);
  assert.equal(fs.readFileSync(f.file, "utf8"), draft);
  assert.deepEqual(
    f.store.definitions().map((row) => row.taskId),
    ["alpha", "beta"],
  );
});

test("a conflict detected after the temporary write reports the fresh external revision", (t) => {
  const f = fixture(t);
  const original = f.text([scriptTask("alpha")]);
  const saved = f.scheduler.saveConfiguration("p", original, null)!;
  assert.equal(saved.saved, true);
  const definitions = JSON.stringify(f.store.definitions());
  const draft = f.text([scriptTask("alpha"), scriptTask("beta")]);
  const external = f.text([scriptTask("external")]);
  const originalWrite = fs.writeFileSync;
  // Simulate a writer racing in: after the temporary file exists, replace the real file.
  t.mock.method(
    fs,
    "writeFileSync",
    (target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      originalWrite(target, data, options);
      if (String(target).endsWith(".tmp")) originalWrite(f.file, external);
    },
  );
  const conflict = f.scheduler.saveConfiguration("p", draft, saved.revision)!;
  t.mock.restoreAll();
  assert.equal(conflict.saved, false);
  assert.equal(conflict.loaded, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.revision, hash(external));
  assert.equal(conflict.latest?.revision, hash(external));
  assert.equal(conflict.revision, conflict.latest?.revision);
  assert.equal(conflict.latest?.text, external);
  assert.equal(fs.readFileSync(f.file, "utf8"), external);
  assert.equal(JSON.stringify(f.store.definitions()), definitions);
  assert.deepEqual(
    fs.readdirSync(path.dirname(f.file)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  assert.equal(timerCount(f.scheduler), 1);
});

test("a load failure returns saved with the new revision so the same revision can retry", (t) => {
  const f = fixture(t);
  const original = f.text([scriptTask("alpha")]);
  const saved = f.scheduler.saveConfiguration("p", original, null)!;
  assert.equal(saved.saved, true);
  const draft = f.text([scriptTask("alpha"), scriptTask("beta")]);
  t.mock.method(f.store, "importProject", () => {
    throw new Error("database unavailable");
  });
  const partial = f.scheduler.saveConfiguration("p", draft, saved.revision)!;
  assert.equal(partial.saved, true);
  assert.equal(partial.loaded, false);
  assert.match(partial.error ?? "", /装载失败/);
  assert.equal(partial.revision, hash(draft));
  assert.equal(fs.readFileSync(f.file, "utf8"), draft);
  assert.deepEqual(
    f.store.definitions().map((row) => row.taskId),
    ["alpha"],
  );
  t.mock.restoreAll();
  const retried = f.scheduler.saveConfiguration("p", draft, partial.revision)!;
  assert.equal(retried.saved, true);
  assert.equal(retried.loaded, true);
  assert.equal(retried.revision, hash(draft));
  assert.deepEqual(
    f.store.definitions().map((row) => row.taskId),
    ["alpha", "beta"],
  );
});

test("invalid project IDs are rejected before any filesystem access", (t) => {
  const f = fixture(t);
  assert.equal(f.scheduler.readConfiguration("missing"), undefined);
  assert.equal(f.scheduler.previewConfiguration("missing", "{}"), undefined);
  assert.equal(
    f.scheduler.saveConfiguration("missing", "{}", null),
    undefined,
  );
  assert.equal(f.scheduler.readConfiguration(""), undefined);
  assert.equal(fs.existsSync(path.join(f.projectPath, ".cloudcli")), false);
});
