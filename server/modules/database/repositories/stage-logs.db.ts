import { getConnection } from '@/modules/database/connection.js';
import type { StageLogEntry, StageLogSource } from '@/shared/index.js';

type StageLogRow = {
  id: string;
  task_id: string;
  session_id: string;
  execution_id: string | null;
  source: StageLogSource;
  occurred_at: string;
  created_at: string;
  content: string;
  status: string;
  phase: string | null;
  data_json: string | null;
};

const COLUMNS = `id, task_id, session_id, execution_id, source, occurred_at, created_at,
  content, status, phase, data_json`;

function toEntry(row: StageLogRow): StageLogEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    source: row.source,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    content: row.content,
    status: row.status,
    phase: row.phase ?? undefined,
    data: row.data_json ? JSON.parse(row.data_json) as Record<string, unknown> : undefined,
  };
}

/**
 * Persistence for stage logs. Used only by the project-scheduler host module: retention
 * (seven days by `created_at`) and newest-first keyset paging live here, while identity, input
 * validation and system lifecycle entries stay in the service above it.
 */
export const stageLogsDb = {
  insert(entry: StageLogEntry): StageLogEntry {
    getConnection()
      .prepare(`INSERT INTO stage_logs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.id,
        entry.taskId,
        entry.sessionId,
        entry.executionId,
        entry.source,
        entry.occurredAt,
        entry.createdAt,
        entry.content,
        entry.status,
        entry.phase ?? null,
        entry.data ? JSON.stringify(entry.data) : null,
      );
    return entry;
  },

  /**
   * One newest-first page newer than the retention cutoff. `after` is the decoded keyset position
   * (`createdAt`, `id`); the caller decodes the opaque cursor once.
   */
  listPage(input: {
    taskId: string;
    keepFrom: string;
    after?: { createdAt: string; id: string };
    limit: number;
  }): StageLogEntry[] {
    const afterClause = input.after
      ? 'AND (created_at < ? OR (created_at = ? AND id < ?))'
      : '';
    const params: unknown[] = [input.taskId, input.keepFrom];
    if (input.after) params.push(input.after.createdAt, input.after.createdAt, input.after.id);
    params.push(input.limit + 1);
    const rows = getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM stage_logs
         WHERE task_id = ? AND created_at >= ? ${afterClause}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as StageLogRow[];
    return rows.map(toEntry);
  },

  /** Deletes everything older than the retention cutoff; returns how many rows were removed. */
  prune(beforeIso: string): number {
    return getConnection()
      .prepare('DELETE FROM stage_logs WHERE created_at < ?')
      .run(beforeIso).changes;
  },
};
