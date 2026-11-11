import { getConnection } from '@/modules/database/connection.js';

/**
 * Private attachment descriptor stored with a todo. `storedName` is the file
 * inside that todo's folder and never leaves the backend; the public DTO keeps
 * only `id`, `name`, `mimeType`, and `size`.
 */
export type ProjectTodoAttachmentRecord = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storedName: string;
};

export type ProjectTodoRecord = {
  id: string;
  userId: number;
  projectId: string;
  content: string;
  attachments: ProjectTodoAttachmentRecord[];
  status: 'pending' | 'submitted' | 'deleted';
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
  submittedSessionId: string | null;
};

type ProjectTodoRow = {
  id: string;
  user_id: number;
  project_id: string;
  content: string;
  attachments_json: string;
  status: ProjectTodoRecord['status'];
  created_at: string;
  updated_at: string;
  state_changed_at: string;
  submitted_session_id: string | null;
};

const COLUMNS = 'id, user_id, project_id, content, attachments_json, status, created_at, updated_at, state_changed_at, submitted_session_id';

function toRecord(row: ProjectTodoRow): ProjectTodoRecord {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    content: row.content,
    attachments: JSON.parse(row.attachments_json) as ProjectTodoAttachmentRecord[],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stateChangedAt: row.state_changed_at,
    submittedSessionId: row.submitted_session_id,
  };
}

/** Persistence for per-user project todos and their private attachment metadata. */
export const projectTodosDb = {
  listForUserProject(userId: number, projectId: string): ProjectTodoRecord[] {
    return (getConnection()
      .prepare(`SELECT ${COLUMNS} FROM project_todos WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC`)
      .all(userId, projectId) as ProjectTodoRow[]).map(toRecord);
  },

  listByProject(projectId: string): ProjectTodoRecord[] {
    return (getConnection()
      .prepare(`SELECT ${COLUMNS} FROM project_todos WHERE project_id = ?`)
      .all(projectId) as ProjectTodoRow[]).map(toRecord);
  },

  get(userId: number, projectId: string, id: string): ProjectTodoRecord | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM project_todos WHERE user_id = ? AND project_id = ? AND id = ?`)
      .get(userId, projectId, id) as ProjectTodoRow | undefined;
    return row ? toRecord(row) : null;
  },

  create(input: {
    id: string;
    userId: number;
    projectId: string;
    content: string;
    attachments: ProjectTodoAttachmentRecord[];
    createdAt: string;
  }): ProjectTodoRecord {
    const { id } = input;
    getConnection().prepare(
      `INSERT INTO project_todos (id, user_id, project_id, content, attachments_json, status, created_at, updated_at, state_changed_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(
      id,
      input.userId,
      input.projectId,
      input.content,
      JSON.stringify(input.attachments),
      input.createdAt,
      input.createdAt,
      input.createdAt,
    );
    return projectTodosDb.get(input.userId, input.projectId, id) as ProjectTodoRecord;
  },

  updatePendingContent(input: {
    userId: number;
    projectId: string;
    id: string;
    content: string;
    attachments: ProjectTodoAttachmentRecord[];
    updatedAt: string;
  }): boolean {
    const result = getConnection().prepare(
      `UPDATE project_todos
       SET content = ?, attachments_json = ?, updated_at = ?
       WHERE user_id = ? AND project_id = ? AND id = ? AND status = 'pending'`,
    ).run(
      input.content,
      JSON.stringify(input.attachments),
      input.updatedAt,
      input.userId,
      input.projectId,
      input.id,
    );
    return result.changes > 0;
  },

  setStatus(input: {
    userId: number;
    projectId: string;
    id: string;
    status: ProjectTodoRecord['status'];
    submittedSessionId: string | null;
    stateChangedAt: string;
  }): boolean {
    const result = getConnection().prepare(
      `UPDATE project_todos
       SET status = ?, submitted_session_id = ?, state_changed_at = ?, updated_at = ?
       WHERE user_id = ? AND project_id = ? AND id = ? AND status = 'pending'`,
    ).run(
      input.status,
      input.submittedSessionId,
      input.stateChangedAt,
      input.stateChangedAt,
      input.userId,
      input.projectId,
      input.id,
    );
    return result.changes > 0;
  },

  restore(input: {
    userId: number;
    projectId: string;
    id: string;
    restoredAt: string;
  }): boolean {
    const result = getConnection().prepare(
      `UPDATE project_todos
       SET status = 'pending', submitted_session_id = NULL, state_changed_at = ?, updated_at = ?
       WHERE user_id = ? AND project_id = ? AND id = ? AND status IN ('submitted', 'deleted')`,
    ).run(input.restoredAt, input.restoredAt, input.userId, input.projectId, input.id);
    return result.changes > 0;
  },

  delete(id: string): void {
    getConnection().prepare('DELETE FROM project_todos WHERE id = ?').run(id);
  },

  listExpired(cutoffIso: string): ProjectTodoRecord[] {
    return (getConnection()
      .prepare(`SELECT ${COLUMNS} FROM project_todos WHERE status <> 'pending' AND state_changed_at <= ?`)
      .all(cutoffIso) as ProjectTodoRow[]).map(toRecord);
  },

  /** Marks this user's pending todos in one project; already submitted rows keep their original time. */
  markSubmitted(input: {
    userId: number;
    projectId: string;
    todoIds: string[];
    sessionId: string;
    submittedAt: string;
  }): number {
    if (input.todoIds.length === 0) return 0;
    const db = getConnection();
    return db.transaction(() => {
      const update = db.prepare(
        `UPDATE project_todos
         SET status = 'submitted', submitted_session_id = ?, state_changed_at = ?, updated_at = ?
         WHERE user_id = ? AND project_id = ? AND id = ? AND status = 'pending'`,
      );
      let changed = 0;
      for (const id of input.todoIds) {
        changed += update.run(
          input.sessionId,
          input.submittedAt,
          input.submittedAt,
          input.userId,
          input.projectId,
          id,
        ).changes;
      }
      return changed;
    })();
  },
};

export type ProjectTodosRepository = typeof projectTodosDb;
