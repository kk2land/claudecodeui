import { getConnection } from '@/modules/database/connection.js';
import type { ResidentBindingView, ResidentStopCause, ResidentTerminal } from '@/shared/index.js';

/**
 * Stored binding state. The repository speaks the host's persisted shape; the
 * project-scheduler module maps it to `ResidentBindingView`.
 */
export type ResidentBindingRecord = {
  taskId: string;
  sessionId: string;
  projectId: string;
  name: string;
  provider: string;
  providerSessionId: string;
  enabled: boolean;
  visible: boolean;
  status: ResidentBindingView['status'];
  executionId: string | null;
  stopCause: ResidentStopCause | null;
  terminal: ResidentTerminal | null;
  permissionMode: string | null;
  sandboxMode: string | null;
  model: string | null;
  effort: string | null;
  runtime: string | null;
  createdAt: string;
  updatedAt: string;
};

type ResidentBindingRow = {
  task_id: string;
  session_id: string;
  project_id: string;
  name: string;
  provider: string;
  provider_session_id: string;
  enabled: number;
  visible: number;
  status: ResidentBindingView['status'];
  execution_id: string | null;
  stop_cause: ResidentStopCause | null;
  terminal_json: string | null;
  permission_mode: string | null;
  sandbox_mode: string | null;
  model: string | null;
  effort: string | null;
  runtime: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = `task_id, session_id, project_id, name, provider, provider_session_id,
  enabled, visible, status, execution_id, stop_cause, terminal_json, permission_mode,
  sandbox_mode, model, effort, runtime, created_at, updated_at`;

function toRecord(row: ResidentBindingRow): ResidentBindingRecord {
  return {
    taskId: row.task_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    name: row.name,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    enabled: Boolean(row.enabled),
    visible: Boolean(row.visible),
    status: row.status,
    executionId: row.execution_id,
    stopCause: row.stop_cause,
    terminal: row.terminal_json ? JSON.parse(row.terminal_json) as ResidentTerminal : null,
    permissionMode: row.permission_mode,
    sandboxMode: row.sandbox_mode,
    model: row.model,
    effort: row.effort,
    runtime: row.runtime,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The single persistence surface for resident bindings.
 *
 * Used by the project-scheduler host module (state authority) and by the
 * database module's own deletion guards; every other consumer reads protection
 * through `sessionsDb` helpers. Nothing here runs provider work, so the table
 * never becomes a second run lifecycle.
 */
export const residentBindingsDb = {
  insert(record: Omit<ResidentBindingRecord, 'createdAt' | 'updatedAt'>): ResidentBindingRecord {
    const db = getConnection();
    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO resident_bindings (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.taskId,
      record.sessionId,
      record.projectId,
      record.name,
      record.provider,
      record.providerSessionId,
      Number(record.enabled),
      Number(record.visible),
      record.status,
      record.executionId,
      record.stopCause,
      record.terminal ? JSON.stringify(record.terminal) : null,
      record.permissionMode,
      record.sandboxMode,
      record.model,
      record.effort,
      record.runtime,
      timestamp,
      timestamp,
    );
    return residentBindingsDb.getByTaskId(record.taskId)!;
  },

  getByTaskId(taskId: string): ResidentBindingRecord | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM resident_bindings WHERE task_id = ?`)
      .get(taskId) as ResidentBindingRow | undefined;
    return row ? toRecord(row) : null;
  },

  getBySessionId(sessionId: string): ResidentBindingRecord | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM resident_bindings WHERE session_id = ?`)
      .get(sessionId) as ResidentBindingRow | undefined;
    return row ? toRecord(row) : null;
  },

  list(): ResidentBindingRecord[] {
    const rows = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM resident_bindings ORDER BY created_at ASC`)
      .all() as ResidentBindingRow[];
    return rows.map(toRecord);
  },

  /**
   * True while the app session is bound, whatever its enabled/visible state or
   * whether the plugin is running. Every physical session deletion consults it.
   */
  isSessionProtected(sessionId: string): boolean {
    return Boolean(
      getConnection()
        .prepare('SELECT 1 FROM resident_bindings WHERE session_id = ? LIMIT 1')
        .get(sessionId),
    );
  },

  /**
   * Protects every generation of a provider-native conversation: a resident
   * binding keeps the native id it was adopted with, so retention that walks
   * native transcript files must ask by native id as well.
   */
  isProviderSessionProtected(provider: string, providerSessionId: string): boolean {
    return Boolean(
      getConnection()
        .prepare(
          'SELECT 1 FROM resident_bindings WHERE provider = ? AND provider_session_id = ? LIMIT 1',
        )
        .get(provider, providerSessionId),
    );
  },

  /** True when the bound session is hidden from the foreground lists. */
  isSessionHidden(sessionId: string): boolean {
    const row = getConnection()
      .prepare('SELECT visible FROM resident_bindings WHERE session_id = ?')
      .get(sessionId) as { visible: number } | undefined;
    return Boolean(row) && Number(row!.visible) === 0;
  },

  /** Applies a partial update and returns the fresh record, or null when the task is gone. */
  update(
    taskId: string,
    patch: Partial<
      Pick<
        ResidentBindingRecord,
        | 'enabled'
        | 'visible'
        | 'status'
        | 'executionId'
        | 'stopCause'
        | 'terminal'
        | 'permissionMode'
        | 'sandboxMode'
        | 'model'
        | 'effort'
        | 'runtime'
        | 'name'
      >
    >,
  ): ResidentBindingRecord | null {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const columns: Array<[keyof typeof patch, string]> = [
      ['enabled', 'enabled'],
      ['visible', 'visible'],
      ['status', 'status'],
      ['executionId', 'execution_id'],
      ['stopCause', 'stop_cause'],
      ['terminal', 'terminal_json'],
      ['permissionMode', 'permission_mode'],
      ['sandboxMode', 'sandbox_mode'],
      ['model', 'model'],
      ['effort', 'effort'],
      ['runtime', 'runtime'],
      ['name', 'name'],
    ];
    for (const [key, column] of columns) {
      if (!(key in patch)) continue;
      const value = patch[key];
      assignments.push(`${column} = ?`);
      values.push(
        key === 'enabled' || key === 'visible'
          ? Number(value)
          : key === 'terminal'
            ? value ? JSON.stringify(value) : null
            : value ?? null,
      );
    }
    if (assignments.length === 0) return residentBindingsDb.getByTaskId(taskId);
    assignments.push('updated_at = ?');
    values.push(nowIso(), taskId);
    const db = getConnection();
    db.prepare(`UPDATE resident_bindings SET ${assignments.join(', ')} WHERE task_id = ?`).run(
      ...values,
    );
    return residentBindingsDb.getByTaskId(taskId);
  },

  remove(taskId: string): boolean {
    return (
      getConnection().prepare('DELETE FROM resident_bindings WHERE task_id = ?').run(taskId)
        .changes > 0
    );
  },

  /** Bindings a host restart found in `running`, i.e. the ones that were live when it stopped. */
  listRunning(): ResidentBindingRecord[] {
    return residentBindingsDb.list().filter((record) => record.status === 'running');
  },
};
