import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  WorkerConfigUsage,
  WorkerHistoryNotification,
  WorkerNotification,
  WorkerNotificationDelivery,
  WorkerOwner,
  WorkerPlan,
  WorkerRecord,
  WorkerRun,
  WorkerSettings,
  WorkerSettingsRecord,
  WorkerStateQuery,
} from "./shared/index.js";
import {
  INITIAL_CONFIG_IDS,
  INITIAL_CONFIG_NAMES,
  defaultSettingsRecord,
  isCanonicalSettings,
  migrateLegacySettings,
  normalizeSettingsRecord,
  projectSettings,
} from "./settings.js";

/** Read-only schema-2 defaults plus their compatibility projections. */
export const DEFAULT_SETTINGS = projectSettings(defaultSettingsRecord());

type WorkerRow = { body: string; cleaned_at: string | null };
type RunRow = { body: string };
type OwnerRow = { body: string };
type HistoryRow = { worker_body: string; run_body: string };
type NotificationHistoryRow = { body: string; worker_body: string | null };
type ActiveWorkerRow = { worker_body: string; run_body: string };
type ConfigUsageRow = {
  configId: string;
  referenced: number;
  activeRuns: number | null;
};

/** Keyset position for Worker history pages; serialized opaquely by the service. */
export type WorkerHistoryCursor = { time: string; id: string };
export type WorkerHistoryPageResult<T> = { items: T[]; hasMore: boolean };

/** SQLite persistence for workers, runs, plans, settings, idempotency keys, and the notification outbox. */
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
      CREATE TABLE IF NOT EXISTS plans (
        parent_session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(parent_session_id, project_id)
      );
      CREATE TABLE IF NOT EXISTS cooldowns (
        engine TEXT PRIMARY KEY,
        until INTEGER NOT NULL
      );
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

  /** Reads the logical session's plan for WorkerService.context, independently of run history. */
  plan(parentSessionId: string, projectId: string): WorkerPlan | null {
    const row = this.db
      .prepare("SELECT content, updated_at AS updatedAt FROM plans WHERE parent_session_id=? AND project_id=?")
      .get(parentSessionId, projectId) as WorkerPlan | undefined;
    return row ?? null;
  }

  /** Replaces the complete plan accepted by WorkerService without touching execution records. */
  savePlan(parentSessionId: string, projectId: string, plan: WorkerPlan): void {
    this.db
      .prepare(`
        INSERT INTO plans(parent_session_id,project_id,content,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(parent_session_id,project_id)
        DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at
      `)
      .run(parentSessionId, projectId, plan.content, plan.updatedAt);
  }

  /**
   * Loads canonical settings, migrating a pre-schema-2 row (and legacy workers/runs) exactly
   * once in a single transaction. After that every read returns the canonical row and never
   * recreates a config deleted by a later update.
   */
  settings(): WorkerSettings {
    const row = this.db
      .prepare("SELECT body FROM settings WHERE id=1")
      .get() as { body: string } | undefined;
    if (!row) {
      const record = defaultSettingsRecord();
      this.transaction(() => {
        this.saveSettings(record);
        this.backfillLegacyRecords(record);
      });
      return projectSettings(record);
    }
    const stored = JSON.parse(row.body) as Record<string, unknown>;
    if (isCanonicalSettings(stored)) {
      const { hardTimeoutSeconds, ...record } = stored as unknown as WorkerSettingsRecord & {
        hardTimeoutSeconds?: number | null;
      };
      let changed = false;
      if (
        hardTimeoutSeconds !== undefined ||
        record.configs.some((config) => config.hardTimeoutSeconds === undefined)
      ) {
        record.configs = record.configs.map((config) => ({
          ...config,
          hardTimeoutSeconds: config.hardTimeoutSeconds === undefined
            ? hardTimeoutSeconds ?? 600
            : config.hardTimeoutSeconds,
        }));
        changed = true;
      }
      // Persist only independent schema/timeout repairs. DSH removal is a read-only projection.
      if (changed) this.saveSettings(record);
      return projectSettings(normalizeSettingsRecord(record));
    }
    const record = migrateLegacySettings(stored);
    this.transaction(() => {
      this.saveSettings(record);
      this.backfillLegacyRecords(record);
    });
    return projectSettings(record);
  }

  /** Persists exactly the supplied body; callers only pass a canonical record in production. */
  saveSettings(settings: WorkerSettingsRecord | Record<string, unknown>): void {
    this.db
      .prepare(
        "INSERT INTO settings(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(JSON.stringify(settings));
  }

  /**
   * Whole-store reference counts keyed by config id, including ids of deleted configs that
   * worker history still references. `referenced` locks the engine and id reuse; `activeRuns`
   * blocks deletion until every accepted run reaches a terminal state.
   */
  configUsage(): Record<string, WorkerConfigUsage> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(w.body,'$.configId') AS configId,
                COUNT(DISTINCT w.id) AS referenced,
                SUM(CASE WHEN r.status IN ('queued','starting','running','stopping','unknown')
                         THEN 1 ELSE 0 END) AS activeRuns
           FROM workers w
           LEFT JOIN runs r ON r.worker_id=w.id
          WHERE json_extract(w.body,'$.configId') IS NOT NULL
          GROUP BY configId`,
      )
      .all() as ConfigUsageRow[];
    const usage: Record<string, WorkerConfigUsage> = {};
    for (const row of rows) {
      usage[row.configId] = {
        referenced: row.referenced > 0,
        activeRuns: row.activeRuns ?? 0,
      };
    }
    return usage;
  }

  /**
   * Backfills config identity on legacy workers and missing run selections from the run's own
   * recorded `spec.json` argv. Explicit selections always win; absent spec evidence leaves the
   * historical legacy selection untouched rather than guessing from current settings.
   */
  private backfillLegacyRecords(record: WorkerSettingsRecord): void {
    for (const worker of this.workers()) {
      // Retired DSH rows stay byte-for-byte as stored; no config or run backfill.
      if (worker.type === "dsh") continue;
      let workerChanged = false;
      if (!worker.configId || !worker.configName) {
        const config =
          record.configs.find(
            (candidate) =>
              candidate.id === INITIAL_CONFIG_IDS[worker.type as keyof typeof INITIAL_CONFIG_IDS] &&
              candidate.type === worker.type,
          ) ?? record.configs.find((candidate) => candidate.type === worker.type);
        // Historical DSH workers keep a readable config identity even though no config exists.
        const fallbackId =
          INITIAL_CONFIG_IDS[worker.type as keyof typeof INITIAL_CONFIG_IDS] ??
          worker.type + "-default";
        const fallbackName =
          INITIAL_CONFIG_NAMES[worker.type as keyof typeof INITIAL_CONFIG_NAMES] ??
          worker.type + "#1";
        worker.configId = config?.id ?? fallbackId;
        worker.configName = config?.name ?? fallbackName;
        workerChanged = true;
      }
      for (const run of this.runs(worker.id)) {
        if (this.backfillRunSelection(run, worker.type)) this.saveRun(run);
      }
      if (workerChanged) this.saveWorker(worker);
    }
  }

  private backfillRunSelection(run: WorkerRun, type: WorkerRecord["type"]): boolean {
    let changed = false;
    if (run.model === null || run.provider === null || run.effort === null) {
      const spec = path.join(
        this.directory,
        "logs",
        run.workerId,
        run.id,
        "spec.json",
      );
      let argv: unknown;
      try {
        argv = (JSON.parse(fs.readFileSync(spec, "utf8")) as { argv?: unknown })
          .argv;
      } catch {
        argv = null;
      }
      if (Array.isArray(argv) && argv.every((item) => typeof item === "string")) {
        const selection = parseSpecSelection(argv as string[], type);
        for (const key of ["model", "provider", "effort"] as const) {
          if (run[key] === null && selection[key] !== null) {
            run[key] = selection[key];
            changed = true;
          }
        }
      }
    }
    // Codex had no config service before schema 2; a run without provider evidence keeps the
    // old resume behavior through an explicit flag rather than a fabricated historical value.
    if (
      type === "codex" &&
      run.provider === null &&
      run.legacyCodexProvider !== true
    ) {
      run.legacyCodexProvider = true;
      changed = true;
    }
    return changed;
  }

  /** Global cooldown deadline in epoch milliseconds; null when this engine has none. */
  cooldown(engine: string): number | null {
    const row = this.db
      .prepare("SELECT until FROM cooldowns WHERE engine=?")
      .get(engine) as { until: number } | undefined;
    return row?.until ?? null;
  }

  /** Stores the latest known deadline; an older deadline never shortens an active cooldown. */
  setCooldown(engine: string, until: number): number {
    const current = this.cooldown(engine);
    const next = Math.max(until, current ?? 0);
    this.db
      .prepare(`
        INSERT INTO cooldowns(engine,until) VALUES(?,?)
        ON CONFLICT(engine) DO UPDATE SET until=excluded.until
      `)
      .run(engine, next);
    return next;
  }

  /**
   * One page of terminal workers ordered by the latest run's finish time (created time for old
   * rows without one) and id. The query applies the keyset bound and LIMIT in SQLite; one extra
   * row only signals that another page exists.
   */
  finishedPage(
    query: WorkerStateQuery,
    cursor: WorkerHistoryCursor | null,
    limit: number,
  ): WorkerHistoryPageResult<WorkerRecord> {
    const clauses = [
      "r.status IN ('completed','failed','cancelled','interrupted')",
      "json_extract(w.body,'$.type') <> 'dsh'",
    ];
    const values: Array<string | number> = [];
    if (query.projectId) {
      clauses.push("w.project_id=?");
      values.push(query.projectId);
    }
    if (query.parentSessionId) {
      clauses.push("w.parent_session_id=?");
      values.push(query.parentSessionId);
    }
    const sort =
      "COALESCE(NULLIF(json_extract(r.body,'$.finishedAt'),''), json_extract(w.body,'$.createdAt'), '')";
    if (cursor) {
      clauses.push(`(${sort} < ? OR (${sort} = ? AND w.id < ?))`);
      values.push(cursor.time, cursor.time, cursor.id);
    }
    values.push(limit + 1);
    const rows = this.db
      .prepare(`
        SELECT w.body AS worker_body, r.body AS run_body
        FROM workers w
        JOIN runs r ON r.rowid = (
          SELECT rowid FROM runs WHERE worker_id=w.id ORDER BY rowid DESC LIMIT 1
        )
        WHERE ${clauses.join(" AND ")}
        ORDER BY ${sort} DESC, w.id DESC
        LIMIT ?
      `)
      .all(...values) as HistoryRow[];
    const items = rows.slice(0, limit).map((row) => {
      const worker = JSON.parse(row.worker_body) as WorkerRecord;
      return { ...worker, latestRun: JSON.parse(row.run_body) as WorkerRun };
    });
    return { items, hasMore: rows.length > limit };
  }

  /**
   * One page of notifications ordered by generation time and id. Task names are resolved from the
   * same page's worker join so a page needs no follow-up queries; historical notifications whose
   * worker is gone stay readable with an empty task name.
   */
  notificationsPage(
    query: WorkerStateQuery,
    cursor: WorkerHistoryCursor | null,
    limit: number,
  ): WorkerHistoryPageResult<WorkerHistoryNotification> {
    const clauses = [
      "COALESCE(json_extract(w.body,'$.type'),'') <> 'dsh'",
    ];
    const values: Array<string | number> = [];
    if (query.projectId) {
      clauses.push("w.project_id=?");
      values.push(query.projectId);
    }
    if (query.parentSessionId) {
      clauses.push("w.parent_session_id=?");
      values.push(query.parentSessionId);
    }
    const sort =
      "COALESCE(NULLIF(json_extract(n.body,'$.createdAt'),''),'')";
    if (cursor) {
      clauses.push(`(${sort} < ? OR (${sort} = ? AND n.id < ?))`);
      values.push(cursor.time, cursor.time, cursor.id);
    }
    values.push(limit + 1);
    const rows = this.db
      .prepare(`
        SELECT n.body AS body, w.body AS worker_body
        FROM notifications n
        LEFT JOIN workers w ON w.id = n.worker_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY ${sort} DESC, n.id DESC
        LIMIT ?
      `)
      .all(...values) as NotificationHistoryRow[];
    const items = rows.slice(0, limit).map((row) => {
      const notification = JSON.parse(row.body) as WorkerHistoryNotification;
      const worker = row.worker_body
        ? (JSON.parse(row.worker_body) as WorkerRecord)
        : null;
      return { ...notification, taskName: worker?.taskName ?? "" };
    });
    return { items, hasMore: rows.length > limit };
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

  /**
   * Workers whose latest run is still referenced by admission or activity, in one query.
   * Retired DSH rows are filtered in SQL before any body is deserialized.
   */
  activeWorkers(query: WorkerStateQuery = {}): WorkerRecord[] {
    const clauses = ["json_extract(w.body,'$.type') <> 'dsh'"];
    const values: string[] = [];
    if (query.projectId) {
      clauses.push("w.project_id=?");
      values.push(query.projectId);
    }
    if (query.parentSessionId) {
      clauses.push("w.parent_session_id=?");
      values.push(query.parentSessionId);
    }
    const rows = this.db
      .prepare(
        `SELECT w.body AS worker_body, r.body AS run_body
           FROM workers w
           JOIN runs r ON r.rowid=(
             SELECT rowid FROM runs WHERE worker_id=w.id ORDER BY rowid DESC LIMIT 1
           )
          WHERE r.status IN ('queued','starting','running','stopping','unknown')
            AND ${clauses.join(" AND ")}
          ORDER BY w.rowid`,
      )
      .all(...values) as ActiveWorkerRow[];
    return rows.map((row) => ({
      ...(JSON.parse(row.worker_body) as WorkerRecord),
      latestRun: JSON.parse(row.run_body) as WorkerRun,
    }));
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

  expiredRuns(before: number): WorkerRun[] {
    const rows = this.db
      .prepare(
        "SELECT body FROM runs WHERE status IN ('completed','failed','cancelled','interrupted')",
      )
      .all() as RunRow[];
    return rows
      .map((row) => JSON.parse(row.body) as WorkerRun)
      .filter((run) => run.finishedAt !== null && Date.parse(run.finishedAt) <= before);
  }

  /** Deletes expired history together with references, retaining workers with any remaining run. */
  deleteRun(run: WorkerRun): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM notifications WHERE run_id=?").run(run.id);
      this.db.prepare("DELETE FROM requests WHERE run_id=?").run(run.id);
      this.db.prepare("DELETE FROM runs WHERE id=?").run(run.id);
      this.db
        .prepare(
          "DELETE FROM workers WHERE id=? AND NOT EXISTS (SELECT 1 FROM runs WHERE worker_id=?)",
        )
        .run(run.workerId, run.workerId);
    });
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
            `SELECT n.body FROM notifications n
               LEFT JOIN workers w ON w.id=n.worker_id
              WHERE n.owner_id=?
                AND COALESCE(json_extract(w.body,'$.type'),'') <> 'dsh'
              ORDER BY n.rowid`,
          )
          .all(ownerId) as RunRow[])
      : (this.db
          .prepare(
            `SELECT n.body FROM notifications n
               LEFT JOIN workers w ON w.id=n.worker_id
              WHERE COALESCE(json_extract(w.body,'$.type'),'') <> 'dsh'
              ORDER BY n.rowid`,
          )
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

type SpecSelection = {
  model: string | null;
  provider: string | null;
  effort: string | null;
};

/**
 * Extracts the last effective selection option from a recorded native argv, using only the
 * syntax of the run's actual engine. DSH stores selection in a patch file, not argv, so it is
 * never inferred from unrelated arguments or text.
 */
function parseSpecSelection(
  argv: string[],
  type: WorkerRecord["type"],
): SpecSelection {
  const selection: SpecSelection = { model: null, provider: null, effort: null };
  if (type === "dsh") return selection;
  const configValue = (value: string): string | null => {
    const raw = value.slice(value.indexOf("=") + 1).trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
    } catch {
      return raw.replace(/^["']|["']$/g, "").trim() || null;
    }
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const next = argv[index + 1];
    if (arg === "--model" || arg === "-m") {
      if (typeof next === "string" && next.trim()) selection.model = next.trim();
      index++;
    } else if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length).trim();
      if (value) selection.model = value;
    } else if (arg.startsWith("-m") && arg.length > 2) {
      const value = arg.slice(2).trim();
      if (value) selection.model = value;
    } else if (type === "pi" && arg === "--provider") {
      if (typeof next === "string" && next.trim()) selection.provider = next.trim();
      index++;
    } else if (type === "pi" && arg === "--thinking") {
      if (typeof next === "string" && next.trim()) selection.effort = next.trim();
      index++;
    } else if (type === "agy" && arg === "--effort") {
      if (typeof next === "string" && next.trim()) selection.effort = next.trim();
      index++;
    } else if (type === "codex" && (arg === "-c" || arg === "--config")) {
      if (typeof next !== "string") continue;
      if (next.startsWith("model_provider="))
        selection.provider = configValue(next);
      else if (next.startsWith("model_reasoning_effort="))
        selection.effort = configValue(next);
      index++;
    } else if (type === "codex" && arg.startsWith("--config=model_provider=")) {
      selection.provider = configValue(arg.slice("--config=".length));
    } else if (
      type === "codex" &&
      arg.startsWith("--config=model_reasoning_effort=")
    ) {
      selection.effort = configValue(arg.slice("--config=".length));
    }
  }
  return selection;
}
