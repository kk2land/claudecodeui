import type Database from "better-sqlite3";
import type { SchedulerRun } from "../shared/contracts.js";

/**
 * Plugin-owned metadata for one resident task. The host owns every runtime field (status,
 * executions, terminals); this row only remembers which tasks this plugin database knows about,
 * whether alerts are wanted, and which terminal episode has already been recorded, so a
 * re-delivered snapshot cannot duplicate a run or reset its alert retry counter.
 */
export type ResidentTaskMeta = {
  taskId: string;
  sessionId: string;
  notify: boolean;
  /**
   * Host terminal id of the last recorded episode, used as a delivery cursor. Kept even after the
   * matching run row is pruned by retention, so retention cannot resurrect an old alert.
   */
  lastProcessedTerminalId: string | null;
  createdAt: string;
};

/**
 * Resident tables in the plugin database, shared with `SchedulerStore` (same connection and
 * owner). Used by `ResidentTasks` only; resident terminal rows live in the existing `runs` table
 * with `source: "resident"` so ordinary history stays unchanged.
 */
export class ResidentStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS resident_tasks (task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, notify INTEGER NOT NULL DEFAULT 1, last_processed_terminal_id TEXT, created_at TEXT NOT NULL)",
    );
  }
  private read(row: {
    task_id: string;
    session_id: string;
    notify: number;
    last_processed_terminal_id: string | null;
    created_at: string;
  }): ResidentTaskMeta {
    return {
      taskId: row.task_id,
      sessionId: row.session_id,
      notify: row.notify !== 0,
      lastProcessedTerminalId: row.last_processed_terminal_id,
      createdAt: row.created_at,
    };
  }
  tasks(): ResidentTaskMeta[] {
    return (
      this.db
        .prepare("SELECT * FROM resident_tasks ORDER BY created_at, task_id")
        .all() as Parameters<ResidentStore["read"]>[0][]
    ).map((row) => this.read(row));
  }
  task(taskId: string): ResidentTaskMeta | null {
    const row = this.db
      .prepare("SELECT * FROM resident_tasks WHERE task_id=?")
      .get(taskId) as Parameters<ResidentStore["read"]>[0] | undefined;
    return row ? this.read(row) : null;
  }
  /** Idempotent so adoption and host reconciliation can both ensure a row exists. */
  ensureTask(meta: ResidentTaskMeta): void {
    this.db
      .prepare(
        "INSERT INTO resident_tasks(task_id,session_id,notify,last_processed_terminal_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING",
      )
      .run(
        meta.taskId,
        meta.sessionId,
        meta.notify ? 1 : 0,
        meta.lastProcessedTerminalId,
        meta.createdAt,
      );
  }
  deleteTask(taskId: string): void {
    this.db.prepare("DELETE FROM resident_tasks WHERE task_id=?").run(taskId);
  }
  /** Resident terminal rows for one task, newest first; ordinary run lists never include them. */
  runs(taskId: string, limit = 100): SchedulerRun[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM runs WHERE task_id=? AND json_extract(body,'$.source')='resident' ORDER BY rowid DESC LIMIT ?",
        )
        .all(taskId, limit) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as SchedulerRun);
  }
  /**
   * Records one finished episode: the run row and the delivery cursor are written in one
   * transaction. A re-delivered terminal keeps the existing row and its alert counters, so
   * `true` means "new episode" and only then may an alert be flushed.
   */
  recordTerminal(run: SchedulerRun): boolean {
    if (run.source !== "resident" || !run.residentTaskId)
      throw new Error("只有常驻终态可以写入常驻运行记录");
    return this.db.transaction(() => {
      const inserted =
        this.db
          .prepare(
            "INSERT INTO runs(id,project_id,task_id,status,ended_at,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
          )
          .run(
            run.id,
            run.projectId,
            run.taskId,
            run.status,
            run.endedAt,
            JSON.stringify(run),
          ).changes > 0;
      this.db
        .prepare(
          "UPDATE resident_tasks SET last_processed_terminal_id=? WHERE task_id=?",
        )
        .run(run.id, run.residentTaskId);
      return inserted;
    })();
  }
}
