import { randomUUID } from 'node:crypto';

import type { SessionDraftRecord, QueuedSessionMessageRecord } from '@/shared/index.js';
import { getConnection } from '@/modules/database/connection.js';
import { AppError } from '@/shared/index.js';

type DraftRow = {
  draft_scope: string;
  draft_text: string;
  queued_message: string | null;
  updated_at: string;
  queue_status: string;
  queue_request_id: string | null;
  queue_error: string | null;
};

type QueuedMessageRow = {
  user_id: number;
  draft_scope: string;
  queued_message: string;
};

/** A queued message that no longer parses is treated as absent, not fatal. */
function parseQueuedMessage(raw: string | null): unknown | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(row: DraftRow): SessionDraftRecord {
  return {
    scope: row.draft_scope,
    text: row.draft_text,
    queuedMessage: parseQueuedMessage(row.queued_message),
    updatedAt: row.updated_at,
    queuedDelivery: { status: row.queue_status, requestId: row.queue_request_id, error: row.queue_error },
  };
}

/** Draft routes and chat scheduling share these atomic queue operations. */
export const sessionDraftsDb = {
  /**
   * Returns every draft the user has, newest first.
   *
   * The client pulls the whole set once per load: drafts are short strings, and
   * having them all up front means switching sessions restores a draft written
   * on another device without a round trip.
   */
  getDrafts(userId: number): SessionDraftRecord[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT draft_scope, draft_text, queued_message, updated_at, queue_status, queue_request_id, queue_error
         FROM session_drafts
         WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC`
      )
      .all(userId) as DraftRow[];

    return rows.map(toRecord);
  },

  /** Lists dispatchable queued turns; retired provider drafts remain stored and unclaimed. */
  listQueuedMessages(): QueuedSessionMessageRecord[] {
    const rows = getConnection()
      .prepare(
        `SELECT drafts.user_id, drafts.draft_scope, drafts.queued_message
         FROM session_drafts AS drafts
         INNER JOIN sessions ON sessions.session_id = drafts.draft_scope
         WHERE drafts.queued_message IS NOT NULL AND drafts.queue_status = 'queued'
           AND sessions.provider <> 'gptweb'`
      )
      .all() as QueuedMessageRow[];

    return rows.map((row) => ({
      userId: row.user_id,
      sessionId: row.draft_scope,
      queuedMessage: parseQueuedMessage(row.queued_message),
      claimToken: row.queued_message,
    }));
  },

  /** Atomically removes a queued turn only if it has not been edited since listing. */
  claimQueuedMessage(candidate: QueuedSessionMessageRecord): boolean {
    const result = getConnection()
      .prepare(
        `UPDATE session_drafts
         SET queued_message = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ? AND queue_status = 'queued'`
      )
      .run(candidate.userId, candidate.sessionId, candidate.claimToken);
    return result.changes > 0;
  },

  /** Restores a claim lost to the narrow race where another run starts first. */
  restoreQueuedMessage(candidate: QueuedSessionMessageRecord): void {
    getConnection()
      .prepare(
        `UPDATE session_drafts
         SET queued_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND draft_scope = ? AND queued_message IS NULL`
      )
      .run(candidate.claimToken, candidate.userId, candidate.sessionId);
  },

  /** Removes the placeholder row left after its last queued turn is claimed. */
  deleteEmptyDraft(userId: number, scope: string): void {
    getConnection()
      .prepare(
        `DELETE FROM session_drafts
         WHERE user_id = ? AND draft_scope = ? AND draft_text = '' AND queued_message IS NULL`
      )
      .run(userId, scope);
  },

  /**
   * Writes one scope's draft, or deletes the row when nothing is left to keep.
   *
   * Deleting on empty is what stops the table growing a permanent row for every
   * session the user ever opened and typed a character into.
   */
  saveDraft(
    userId: number,
    scope: string,
    draft: { text: string; queuedMessage: unknown | null }
  ): void {
    const db = getConnection();
    const existing = db.prepare('SELECT queued_message, queue_status FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
      .get(userId, scope) as { queued_message: string | null; queue_status: string } | undefined;
    let queued = draft.queuedMessage;
    const id = queued && typeof queued === 'object' && 'id' in queued ? queued.id : null;
    // A delayed draft PUT must not resurrect a message already accepted by steer.
    if (typeof id === 'string' && db.prepare(`SELECT 1 FROM queued_steer_receipts
      WHERE user_id = ? AND session_id = ? AND message_id = ? AND status = 'accepted'`).get(userId, scope, id)) queued = null;
    const serialized = queued === null ? null : JSON.stringify(queued);
    if (existing && ['steering', 'unknown'].includes(existing.queue_status) && serialized !== existing.queued_message) {
      throw new AppError('The queued message is awaiting steering confirmation.', { code: 'QUEUE_BUSY', statusCode: 409 });
    }

    if (!draft.text && queued === null) {
      db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .run(userId, scope);
      return;
    }

    db.prepare(
      `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, draft_scope) DO UPDATE SET
         draft_text = excluded.draft_text,
         queue_status = CASE WHEN session_drafts.queued_message IS excluded.queued_message THEN session_drafts.queue_status ELSE 'queued' END,
         queue_request_id = CASE WHEN session_drafts.queued_message IS excluded.queued_message THEN session_drafts.queue_request_id ELSE NULL END,
         queue_error = CASE WHEN session_drafts.queued_message IS excluded.queued_message THEN session_drafts.queue_error ELSE NULL END,
         queued_message = excluded.queued_message,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      userId,
      scope,
      draft.text,
      serialized
    );
  },

  deleteDraft(userId: number, scope: string): void {
    const db = getConnection();
    db.prepare("DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ? AND queue_status NOT IN ('steering', 'unknown')")
      .run(userId, scope);
  },

  /** WebSocket promotes exactly the queue revision the user clicked; dispatcher uses the same row lock. */
  beginSteer(userId: number, scope: string, messageId: string, requestId: string): {
    status: string; queuedMessage?: unknown; error?: string | null;
  } {
    const db = getConnection();
    return db.transaction(() => {
      const receipt = db.prepare('SELECT user_id, session_id, message_id, status, error FROM queued_steer_receipts WHERE request_id = ?')
        .get(requestId) as { user_id: number; session_id: string; message_id: string; status: string; error: string | null } | undefined;
      if (receipt) {
        if (receipt.user_id !== userId || receipt.session_id !== scope || receipt.message_id !== messageId) {
          throw new AppError('Request id belongs to a different message.', { code: 'INVALID_REQUEST_ID', statusCode: 409 });
        }
        return { status: receipt.status, error: receipt.error };
      }
      const row = db.prepare('SELECT queued_message, queue_status FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .get(userId, scope) as { queued_message: string; queue_status: string } | undefined;
      const message = parseQueuedMessage(row?.queued_message ?? null) as { id?: string } | null;
      if (!row || !message || message.id !== messageId) throw new AppError('The queued message has changed or was already sent.', { code: 'QUEUE_CHANGED', statusCode: 409 });
      if (!['queued', 'held'].includes(row.queue_status)) throw new AppError('This message is already awaiting confirmation.', { code: 'QUEUE_BUSY', statusCode: 409 });
      db.prepare("INSERT INTO queued_steer_receipts(request_id, user_id, session_id, message_id, status) VALUES (?, ?, ?, ?, 'steering')")
        .run(requestId, userId, scope, messageId);
      db.prepare("UPDATE session_drafts SET queue_status = 'steering', queue_request_id = ?, queue_error = NULL WHERE user_id = ? AND draft_scope = ?")
        .run(requestId, userId, scope);
      return { status: 'steering', queuedMessage: message };
    })();
  },

  /** Persists the RPC outcome and consumes only the message owned by this request. */
  finishSteer(userId: number, scope: string, requestId: string, status: 'accepted' | 'rejected' | 'unknown', error: string | null = null): 'accepted' | 'rejected' | 'unknown' {
    const db = getConnection();
    return db.transaction(() => {
      const previous = db.prepare('SELECT status FROM queued_steer_receipts WHERE request_id = ?').get(requestId) as { status: string } | undefined;
      if (previous?.status === 'accepted') return 'accepted' as const;
      db.prepare('UPDATE queued_steer_receipts SET status = ?, error = ? WHERE request_id = ? AND user_id = ? AND session_id = ?')
        .run(status, error, requestId, userId, scope);
      db.prepare(`UPDATE session_drafts SET
        queued_message = CASE WHEN ? = 'accepted' THEN NULL ELSE queued_message END,
        queue_status = ?, queue_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND draft_scope = ? AND queue_request_id = ?`)
        .run(status, status === 'accepted' ? 'queued' : status === 'rejected' ? 'held' : 'unknown', error, userId, scope, requestId);
      return status;
    })();
  },

  /** Native userMessage echoes prove delivery even if the steer RPC acknowledgement was lost. */
  confirmSteer(scope: string, requestId: string): void {
    const row = getConnection().prepare('SELECT user_id FROM queued_steer_receipts WHERE session_id = ? AND request_id = ?')
      .get(scope, requestId) as { user_id: number } | undefined;
    if (row) this.finishSteer(row.user_id, scope, requestId, 'accepted');
  },

  /** Explicit user resolution of an unprovable outcome; never invoked by automatic dispatch. */
  recoverUnknown(userId: number, scope: string, decision: 'queue' | 'discard'): void {
    const db = getConnection();
    db.transaction(() => {
      const row = db.prepare("SELECT queued_message, queue_request_id FROM session_drafts WHERE user_id = ? AND draft_scope = ? AND queue_status = 'unknown'")
        .get(userId, scope) as { queued_message: string; queue_request_id: string } | undefined;
      if (!row) throw new AppError('This message no longer needs delivery recovery.', { code: 'QUEUE_CHANGED', statusCode: 409 });
      const original = parseQueuedMessage(row.queued_message) as Record<string, unknown> | null;
      const queued = decision === 'queue' && original ? JSON.stringify({ ...original, id: randomUUID() }) : null;
      db.prepare("UPDATE queued_steer_receipts SET status = 'resolved' WHERE request_id = ? AND status = 'unknown'").run(row.queue_request_id);
      db.prepare("UPDATE session_drafts SET queued_message = ?, queue_status = 'queued', queue_request_id = NULL, queue_error = NULL WHERE user_id = ? AND draft_scope = ?")
        .run(queued, userId, scope);
    })();
  },

  /** Explicitly releases a held queue after a failed steer or a user-requested stop. */
  resumeQueue(userId: number, scope: string): void {
    getConnection().prepare("UPDATE session_drafts SET queue_status = 'queued', queue_error = NULL WHERE user_id = ? AND draft_scope = ? AND queue_status = 'held'")
      .run(userId, scope);
  },
};
