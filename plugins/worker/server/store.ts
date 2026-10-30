import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  WorkerNotification,
  WorkerNotificationDelivery,
  WorkerOwner,
  WorkerRecord,
  WorkerRun,
  WorkerSettings,
  WorkerStateQuery,
} from "./shared/index.js";

export const DEFAULT_SETTINGS: WorkerSettings = {
  concurrency: { dsh: 3, pi: 3 },
  softReminderSeconds: 600,
  softReminderSteps: 20,
  hardTimeoutSeconds: null,
};

type WorkerRow = { body: string; cleaned_at: string | null };
type RunRow = { body: string };
type OwnerRow = { body: string };

/** SQLite persistence for workers, runs, settings, idempotency keys, and the notification outbox. */
export class WorkerStore {
  private readonly db: Database.Database;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(directory, "worker.db"));
    fs.chmodSync(path.join(directory, "worker.db"), 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        body TEXT NOT NULL,
        cleaned_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workers_owner ON workers(owner_id);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_worker ON runs(worker_id);
      CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        delivery TEXT NOT NULL,
        batch_id TEXT,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notifications_owner ON notifications(owner_id, delivery);
      CREATE TABLE IF NOT EXISTS requests (
        owner_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        operation TEXT NOT NULL DEFAULT '',
        fingerprint TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(owner_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
    `);
    const requestColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(requests)").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    if (!requestColumns.has("operation"))
      this.db.exec(
        "ALTER TABLE requests ADD COLUMN operation TEXT NOT NULL DEFAULT ''",
      );
    if (!requestColumns.has("fingerprint"))
      this.db.exec(
        "ALTER TABLE requests ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",
      );
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  settings(): WorkerSettings {
    const row = this.db
      .prepare("SELECT body FROM settings WHERE id=1")
      .get() as { body: string } | undefined;
    return row
      ? (JSON.parse(row.body) as WorkerSettings)
      : structuredClone(DEFAULT_SETTINGS);
  }

  saveSettings(settings: WorkerSettings): void {
    this.db
      .prepare(
        "INSERT INTO settings(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(JSON.stringify(settings));
  }

  saveOwner(owner: WorkerOwner): void {
    this.db
      .prepare(
        "INSERT INTO owners(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(owner.id, JSON.stringify(owner));
  }

  owner(id: string): WorkerOwner | null {
    const row = this.db
      .prepare("SELECT body FROM owners WHERE id=?")
      .get(id) as OwnerRow | undefined;
    return row ? (JSON.parse(row.body) as WorkerOwner) : null;
  }

  owners(): WorkerOwner[] {
    return (
      this.db.prepare("SELECT body FROM owners ORDER BY id").all() as OwnerRow[]
    ).map((row) => JSON.parse(row.body) as WorkerOwner);
  }

  request(
    ownerId: string,
    requestId: string,
  ):
    | {
        workerId: string;
        runId: string;
        operation: string;
        fingerprint: string;
      }
    | null {
    const row = this.db
      .prepare(
        "SELECT worker_id,run_id,operation,fingerprint FROM requests WHERE owner_id=? AND request_id=?",
      )
      .get(ownerId, requestId) as
      | {
          worker_id: string;
          run_id: string;
          operation: string;
          fingerprint: string;
        }
      | undefined;
    return row
      ? {
          workerId: row.worker_id,
          runId: row.run_id,
          operation: row.operation,
          fingerprint: row.fingerprint,
        }
      : null;
  }

  /** Worker, first run, and idempotency key are one transaction so a retry never creates two. */
  createWorker(
    worker: WorkerRecord,
    run: WorkerRun,
    scopeKey: string,
    requestId: string,
    operation: string,
    fingerprint: string,
  ): void {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO workers(id,owner_id,parent_session_id,project_id,body) VALUES(?,?,?,?,?)",
        )
        .run(
          worker.id,
          worker.ownerId,
          worker.parentSessionId,
          worker.projectId,
          JSON.stringify(worker),
        );
      this.insertRun(run);
      this.db
        .prepare(
          "INSERT INTO requests(owner_id,request_id,worker_id,run_id,operation,fingerprint) VALUES(?,?,?,?,?,?)",
        )
        .run(scopeKey, requestId, worker.id, run.id, operation, fingerprint);
    });
  }

  addRequest(
    ownerId: string,
    requestId: string,
    workerId: string,
    runId: string,
    operation: string,
    fingerprint: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO requests(owner_id,request_id,worker_id,run_id,operation,fingerprint) VALUES(?,?,?,?,?,?)",
      )
      .run(ownerId, requestId, workerId, runId, operation, fingerprint);
  }

  insertRun(run: WorkerRun): void {
    this.db
      .prepare(
        "INSERT INTO runs(id,worker_id,status,body) VALUES(?,?,?,?)",
      )
      .run(run.id, run.workerId, run.status, JSON.stringify(run));
  }

  saveRun(run: WorkerRun): void {
    this.db
      .prepare("UPDATE runs SET status=?, body=? WHERE id=?")
      .run(run.status, JSON.stringify(run), run.id);
  }

  run(id: string): WorkerRun | null {
    const row = this.db
      .prepare("SELECT body FROM runs WHERE id=?")
      .get(id) as RunRow | undefined;
    return row ? (JSON.parse(row.body) as WorkerRun) : null;
  }

  runs(workerId: string): WorkerRun[] {
    return (
      this.db
        .prepare("SELECT body FROM runs WHERE worker_id=? ORDER BY rowid")
        .all(workerId) as RunRow[]
    ).map((row) => JSON.parse(row.body) as WorkerRun);
  }

  latestRun(workerId: string): WorkerRun | null {
    const row = this.db
      .prepare(
        "SELECT body FROM runs WHERE worker_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(workerId) as RunRow | undefined;
    return row ? (JSON.parse(row.body) as WorkerRun) : null;
  }

  worker(id: string): WorkerRecord | null {
    const row = this.db
      .prepare("SELECT body,cleaned_at FROM workers WHERE id=?")
      .get(id) as WorkerRow | undefined;
    if (!row) return null;
    return this.record(JSON.parse(row.body) as WorkerRecord);
  }

  workers(query: WorkerStateQuery = {}): WorkerRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (query.projectId) {
      clauses.push("project_id=?");
      values.push(query.projectId);
    }
    if (query.parentSessionId) {
      clauses.push("parent_session_id=?");
      values.push(query.parentSessionId);
    }
    const sql =
      "SELECT body,cleaned_at FROM workers" +
      (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
      " ORDER BY rowid";
    return (
      this.db.prepare(sql).all(...values) as WorkerRow[]
    ).map((row) => this.record(JSON.parse(row.body) as WorkerRecord));
  }

  workerCleanedAt(id: string): string | null {
    const row = this.db
      .prepare("SELECT cleaned_at FROM workers WHERE id=?")
      .get(id) as { cleaned_at: string | null } | undefined;
    return row?.cleaned_at ?? null;
  }

  markCleaned(id: string): void {
    this.db
      .prepare("UPDATE workers SET cleaned_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }

  saveWorker(worker: WorkerRecord): void {
    this.db
      .prepare("UPDATE workers SET body=? WHERE id=?")
      .run(JSON.stringify({ ...worker, latestRun: null }), worker.id);
  }

  replaceWorkspace(workerId: string, workspace: WorkerRecord["workspace"]): void {
    const worker = this.worker(workerId);
    if (!worker) return;
    worker.workspace = workspace;
    worker.cwd = workspace.path;
    this.db
      .prepare("UPDATE workers SET body=? WHERE id=?")
      .run(JSON.stringify({ ...worker, latestRun: null }), workerId);
  }

  private record(worker: WorkerRecord): WorkerRecord {
    return { ...worker, latestRun: this.latestRun(worker.id) };
  }

  /** Runs ordered by admission; `queued` rows are the FIFO selection source. */
  queuedRuns(): WorkerRun[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM runs WHERE status='queued' ORDER BY rowid",
        )
        .all() as RunRow[]
    ).map((row) => JSON.parse(row.body) as WorkerRun);
  }

  activeRuns(): WorkerRun[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM runs WHERE status IN ('queued','starting','running','stopping','unknown') ORDER BY rowid",
        )
        .all() as RunRow[]
    ).map((row) => JSON.parse(row.body) as WorkerRun);
  }

  occupyingRuns(): WorkerRun[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM runs WHERE status IN ('starting','running','stopping','unknown')",
        )
        .all() as RunRow[]
    ).map((row) => JSON.parse(row.body) as WorkerRun);
  }

  saveNotification(notification: WorkerNotification): void {
    this.db
      .prepare(
        "INSERT INTO notifications(id,owner_id,worker_id,run_id,delivery,batch_id,body) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        notification.id,
        notification.ownerId,
        notification.workerId,
        notification.runId,
        notification.delivery,
        notification.batchId,
        JSON.stringify(notification),
      );
  }

  notifications(ownerId?: string): WorkerNotification[] {
    const rows = ownerId
      ? (this.db
          .prepare(
            "SELECT body FROM notifications WHERE owner_id=? ORDER BY rowid",
          )
          .all(ownerId) as RunRow[])
      : (this.db
          .prepare("SELECT body FROM notifications ORDER BY rowid")
          .all() as RunRow[]);
    return rows.map((row) => JSON.parse(row.body) as WorkerNotification);
  }

  notification(id: string): WorkerNotification | null {
    const row = this.db
      .prepare("SELECT body FROM notifications WHERE id=?")
      .get(id) as RunRow | undefined;
    return row ? (JSON.parse(row.body) as WorkerNotification) : null;
  }

  updateNotification(notification: WorkerNotification): void {
    this.db
      .prepare(
        "UPDATE notifications SET owner_id=?, worker_id=?, run_id=?, delivery=?, batch_id=?, body=? WHERE id=?",
      )
      .run(
        notification.ownerId,
        notification.workerId,
        notification.runId,
        notification.delivery,
        notification.batchId,
        JSON.stringify(notification),
        notification.id,
      );
  }

  /** A claimed batch is stable: claiming the same batch id returns exactly the same set. */
  claimNotifications(
    ownerId: string,
    eventIds: string[],
    batchId: string,
  ): WorkerNotification[] {
    const claimed = this.transaction(() => {
      const existing = this.notifications(ownerId).filter(
        (item) => item.batchId === batchId,
      );
      if (existing.length) return existing;
      const selected = eventIds.length
        ? this.notifications(ownerId).filter(
            (item) =>
              item.delivery === "pending" &&
              item.batchId === null &&
              eventIds.includes(item.id),
          )
        : this.notifications(ownerId).filter(
            (item) => item.delivery === "pending" && item.batchId === null,
          );
      for (const item of selected) {
        item.batchId = batchId;
        this.updateNotification(item);
      }
      return selected;
    });
    return claimed;
  }

  settleBatch(
    batchId: string,
    delivery: WorkerNotificationDelivery,
  ): void {
    for (const item of this.notifications().filter(
      (candidate) => candidate.batchId === batchId,
    )) {
      // ACK and explicit pause/unknown outcomes are terminal for automatic delivery.
      if (item.delivery !== "pending") continue;
      item.delivery = delivery;
      if (delivery === "pending") item.batchId = null;
      this.updateNotification(item);
    }
  }

  close(): void {
    this.db.close();
  }
}
