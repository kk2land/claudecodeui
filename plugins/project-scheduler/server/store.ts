import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { defaultSettings } from "./configuration.js";
import type {
  SchedulerRun,
  SchedulerSettings,
  SchedulerTask,
  SchedulerTaskRow,
  SchedulerProject,
} from "../shared/contracts.js";

/** Plugin-owned database, separate from the host auth/session schema. Used by the scheduler and HTTP services. */
export class SchedulerStore {
  private readonly db: Database.Database;
  private readonly leader: Database.Database;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.leader = new Database(path.join(directory, "leader.db"), {
      timeout: 100,
    });
    try {
      this.leader.exec(
        "CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE",
      );
    } catch {
      this.leader.close();
      throw new Error("定时任务数据目录已被另一个调度进程占用");
    }
    this.db = new Database(path.join(directory, "scheduler.db"));
    fs.chmodSync(path.join(directory, "scheduler.db"), 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS tasks (project_id TEXT NOT NULL, task_id TEXT NOT NULL, definition TEXT NOT NULL, updated_at TEXT NOT NULL, last_run TEXT, PRIMARY KEY(project_id,task_id)); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, ended_at TEXT, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS runs_task ON runs(project_id,task_id); CREATE INDEX IF NOT EXISTS runs_expiry ON runs(ended_at); CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)",
    );
  }
  settings(): SchedulerSettings {
    const row = this.db
      .prepare("SELECT body FROM settings WHERE id=1")
      .get() as { body: string } | undefined;
    if (!row) return defaultSettings();
    const stored = JSON.parse(row.body) as SchedulerSettings;
    // Rows written before the global execution environment existed have no env field.
    return {
      ...stored,
      env:
        stored.env && typeof stored.env === "object" && !Array.isArray(stored.env)
          ? stored.env
          : {},
    };
  }
  saveSettings(settings: SchedulerSettings): void {
    this.db
      .prepare(
        "INSERT INTO settings(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(JSON.stringify(settings));
  }
  definitions(): {
    projectId: string;
    taskId: string;
    definition: SchedulerTask;
    updatedAt: string;
    lastRun: SchedulerRun | null;
  }[] {
    return (
      this.db
        .prepare("SELECT * FROM tasks ORDER BY project_id,task_id")
        .all() as {
        project_id: string;
        task_id: string;
        definition: string;
        updated_at: string;
        last_run: string | null;
      }[]
    ).map((row) => ({
      projectId: row.project_id,
      taskId: row.task_id,
      definition: JSON.parse(row.definition) as SchedulerTask,
      updatedAt: row.updated_at,
      lastRun: row.last_run ? (JSON.parse(row.last_run) as SchedulerRun) : null,
    }));
  }
  importProject(
    projectId: string,
    tasks: SchedulerTask[],
    removeMissing: boolean,
  ): void {
    this.db.transaction(() => {
      if (removeMissing) {
        const keep = new Set(tasks.map((task) => task.id));
        for (const task of this.definitions().filter(
          (task) => task.projectId === projectId,
        ))
          if (!keep.has(task.taskId))
            this.db
              .prepare("DELETE FROM tasks WHERE project_id=? AND task_id=?")
              .run(projectId, task.taskId);
      }
      const upsert = this.db.prepare(
        "INSERT INTO tasks(project_id,task_id,definition,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id,task_id) DO UPDATE SET definition=excluded.definition,updated_at=excluded.updated_at",
      );
      for (const task of tasks)
        upsert.run(
          projectId,
          task.id,
          JSON.stringify(task),
          new Date().toISOString(),
        );
    })();
  }
  setTaskEnabled(projectId: string, taskId: string, enabled: boolean): void {
    const result = this.db.prepare(
      "UPDATE tasks SET definition=json_set(definition,'$.enabled',json(?)), updated_at=? WHERE project_id=? AND task_id=?",
    ).run(JSON.stringify(enabled), new Date().toISOString(), projectId, taskId);
    if (!result.changes) throw new Error("任务不存在");
  }
  saveRun(run: SchedulerRun): void {
    this.db.transaction(() => {
      const previous = this.db
        .prepare("SELECT ended_at FROM runs WHERE id=?")
        .get(run.id) as { ended_at: string | null } | undefined;
      const newlyCompleted = !previous?.ended_at;
      this.db
        .prepare(
          "INSERT INTO runs(id,project_id,task_id,status,ended_at,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,ended_at=excluded.ended_at,body=excluded.body",
        )
        .run(
          run.id,
          run.projectId,
          run.taskId,
          run.status,
          run.endedAt,
          JSON.stringify(run),
        );
      if (run.endedAt && !run.status.startsWith("skipped_")) {
        // Completion order defines the latest result when a task permits concurrent executions.
        this.db
          .prepare(
            "UPDATE tasks SET last_run=? WHERE project_id=? AND task_id=? AND (? OR json_extract(last_run,'$.id')=?)",
          )
          .run(
            JSON.stringify(run),
            run.projectId,
            run.taskId,
            newlyCompleted ? 1 : 0,
            run.id,
          );
      }
    })();
  }
  run(id: string): SchedulerRun | null {
    const row = this.db.prepare("SELECT body FROM runs WHERE id=?").get(id) as
      | { body: string }
      | undefined;
    if (row) return JSON.parse(row.body) as SchedulerRun;
    return (
      this.definitions()
        .map((task) => task.lastRun)
        .find((run) => run?.id === id) ?? null
    );
  }
  runs(projectId?: string, taskId?: string, limit = 100): SchedulerRun[] {
    const rows =
      projectId && taskId
        ? this.db
            .prepare(
              "SELECT body FROM runs WHERE project_id=? AND task_id=? ORDER BY rowid DESC LIMIT ?",
            )
            .all(projectId, taskId, limit)
        : this.db
            .prepare("SELECT body FROM runs ORDER BY rowid DESC LIMIT ?")
            .all(limit);
    return (rows as { body: string }[]).map(
      (row) => JSON.parse(row.body) as SchedulerRun,
    );
  }
  pendingAlerts(): SchedulerRun[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM runs WHERE json_extract(body,'$.alertStatus')='pending' LIMIT 100",
        )
        .all() as { body: string }[]
    ).map((row) => JSON.parse(row.body) as SchedulerRun);
  }
  unfinished(): SchedulerRun[] {
    return (
      this.db.prepare("SELECT body FROM runs WHERE status='running'").all() as {
        body: string;
      }[]
    ).map((row) => JSON.parse(row.body) as SchedulerRun);
  }
  inventory(
    projects: SchedulerProject[],
    active: SchedulerRun[],
    nextRun: (projectId: string, taskId: string) => string | null,
  ): SchedulerTaskRow[] {
    const catalog = new Map(projects.map((project) => [project.id, project]));
    return this.definitions()
      .filter((task) => catalog.has(task.projectId))
      .map((task) => ({
        ...task,
        projectName: catalog.get(task.projectId)!.name,
        projectPath: catalog.get(task.projectId)!.path,
        activeRuns: active.filter(
          (run) =>
            run.projectId === task.projectId && run.taskId === task.taskId,
        ),
        nextRun: nextRun(task.projectId, task.taskId),
      }));
  }
  prune(
    days: number,
    now = Date.now(),
    removeLogs: (id: string) => void = () => {},
  ): string[] {
    if (!days) return [];
    const cutoff = new Date(now - days * 86400000).toISOString();
    // Pending alerts retain their record until delivery has reached a terminal state.
    const ids = (
      this.db
        .prepare(
          "SELECT id FROM runs WHERE ended_at < ? AND json_extract(body,'$.alertStatus') != 'pending'",
        )
        .all(cutoff) as { id: string }[]
    ).map((row) => row.id);
    // Keep the row if filesystem cleanup fails so the next maintenance pass can retry.
    this.db.transaction(() => {
      for (const id of ids) {
        removeLogs(id);
        this.db.prepare("DELETE FROM runs WHERE id=?").run(id);
      }
    })();
    return ids;
  }
  close(): void {
    this.db.close();
    this.leader.close();
  }
}
