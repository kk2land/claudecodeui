import { getConnection } from '@/modules/database/connection.js';
import type {
  ScheduledTaskSessionLookup,
  ScheduledTaskSessionRecord,
} from '@/shared/index.js';
import { normalizeProjectPath } from '@/shared/utils.js';

type ScheduledTaskSessionRow = {
  project_id: string;
  task_id: string;
  session_id: string;
  cwd: string;
  created_at: string;
};

type ReusableSessionRow = ScheduledTaskSessionRow & {
  provider: string;
  provider_session_id: string;
};

const COLUMNS = 'project_id, task_id, session_id, cwd, created_at';

function toRecord(row: ScheduledTaskSessionRow): ScheduledTaskSessionRecord {
  return {
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    cwd: row.cwd,
    createdAt: row.created_at,
  };
}

/**
 * Persistence for scheduled prompt-task session bindings, used by the
 * project-scheduler host module and by the database module's own deletion
 * guards.
 *
 * A task may accumulate several bindings over its life: editing its cwd or
 * provider only changes which binding is reusable, it never unlocks an older
 * one. Bindings disappear only when the task is deleted; removing them leaves
 * the session itself untouched, so the user can delete it afterwards.
 */
export const scheduledTaskSessionsDb = {
  /**
   * Records one session reference for a task. Idempotent for the same
   * project/task/session; an existing row keeps its original `createdAt` and
   * `cwd`, so re-binding cannot reorder or reinterpret an earlier reference.
   */
  insert(input: {
    projectId: string;
    taskId: string;
    sessionId: string;
    cwd: string;
  }): ScheduledTaskSessionRecord {
    const cwd = normalizeProjectPath(input.cwd);
    const db = getConnection();
    db.prepare(
      `INSERT INTO scheduled_task_sessions (${COLUMNS})
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, task_id, session_id) DO NOTHING`,
    ).run(input.projectId, input.taskId, input.sessionId, cwd, new Date().toISOString());
    return toRecord(
      db
        .prepare(
          `SELECT ${COLUMNS} FROM scheduled_task_sessions
           WHERE project_id = ? AND task_id = ? AND session_id = ?`,
        )
        .get(input.projectId, input.taskId, input.sessionId) as ScheduledTaskSessionRow,
    );
  },

  /**
   * The newest binding that is still compatible with this task, its configured
   * provider, and the effective run directory. Compatibility requires a live
   * `sessions` row with a provider-native id, because nothing else can be
   * resumed natively. Returns null when the task must start a new session.
   */
  findReusable(input: {
    projectId: string;
    taskId: string;
    provider: string;
    cwd: string;
  }): ScheduledTaskSessionLookup | null {
    const row = getConnection()
      .prepare(
        `SELECT binding.session_id, binding.project_id, binding.task_id, binding.cwd,
                binding.created_at, session.provider, session.provider_session_id
         FROM scheduled_task_sessions binding
         JOIN sessions session ON session.session_id = binding.session_id
         WHERE binding.project_id = ? AND binding.task_id = ? AND binding.cwd = ?
           AND session.provider = ?
           AND session.provider_session_id IS NOT NULL
           AND session.provider_session_id <> ''
         ORDER BY binding.created_at DESC, binding.rowid DESC
         LIMIT 1`,
      )
      .get(
        input.projectId,
        input.taskId,
        normalizeProjectPath(input.cwd),
        input.provider,
      ) as ReusableSessionRow | undefined;
    if (!row) return null;
    return {
      ...toRecord(row),
      provider: row.provider,
      providerSessionId: row.provider_session_id,
    };
  },

  /** Every reference one task keeps, oldest first; used to verify retained bindings. */
  listByTask(projectId: string, taskId: string): ScheduledTaskSessionRecord[] {
    return (
      getConnection()
        .prepare(
          `SELECT ${COLUMNS} FROM scheduled_task_sessions
           WHERE project_id = ? AND task_id = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(projectId, taskId) as ScheduledTaskSessionRow[]
    ).map(toRecord);
  },

  /**
   * Reconciles one project against its current task ids, dropping bindings of
   * tasks that no longer exist in the project's configuration. Task ids are
   * only unique inside a project, so the project id always scopes the delete.
   */
  removeMissingTasks(projectId: string, taskIds: readonly string[]): number {
    const db = getConnection();
    if (taskIds.length === 0) {
      return db
        .prepare('DELETE FROM scheduled_task_sessions WHERE project_id = ?')
        .run(projectId).changes;
    }
    const placeholders = taskIds.map(() => '?').join(', ');
    return db
      .prepare(
        `DELETE FROM scheduled_task_sessions
         WHERE project_id = ? AND task_id NOT IN (${placeholders})`,
      )
      .run(projectId, ...taskIds).changes;
  },

  /**
   * True while any scheduled task still references this app session. Consulted
   * by every physical session deletion path through `sessionsDb`, so disabling
   * a task or clearing `reuseSession` does not unlock it.
   */
  isSessionProtected(sessionId: string): boolean {
    return Boolean(
      getConnection()
        .prepare(
          'SELECT 1 FROM scheduled_task_sessions WHERE session_id = ? LIMIT 1',
        )
        .get(sessionId),
    );
  },

  /**
   * Native-id form of the guard, resolved through the owning `sessions` row.
   * Retention walks provider-native ids, so a bound conversation must keep its
   * native transcript even when the binding row only names the app session.
   */
  isProviderSessionProtected(provider: string, providerSessionId: string): boolean {
    return Boolean(
      getConnection()
        .prepare(
          `SELECT 1 FROM scheduled_task_sessions binding
           JOIN sessions session ON session.session_id = binding.session_id
           WHERE session.provider = ? AND session.provider_session_id = ?
           LIMIT 1`,
        )
        .get(provider, providerSessionId),
    );
  },
};
