import { randomUUID } from 'node:crypto';

import type { SessionDraftRecord, QueuedSessionMessageRecord, QueuedChatMessage } from '@/shared/index.js';
import { getConnection } from '@/modules/database/connection.js';
import { AppError, MAX_QUEUED_MESSAGES, readQueuedMessages, serializeQueuedMessages } from '@/shared/index.js';

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

type SavedDraft = {
  /** Composer text; omitted means "leave it empty". */
  text?: string;
  /** Legacy single-slot value; used only when `queuedMessages` is omitted. */
  queuedMessage?: unknown | null;
  /** The whole pending queue, oldest first. Preferred by every current caller. */
  queuedMessages?: unknown[];
};

/** The durable ticket of a stored entry, when it has one. */
function queuedMessageId(value: unknown): string | null {
  return value && typeof value === 'object' && 'id' in value && typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id
    : null;
}

function toRecord(row: DraftRow): SessionDraftRecord {
  const queuedMessages = readQueuedMessages(row.queued_message);
  return {
    scope: row.draft_scope,
    text: row.draft_text,
    // Head-first mirror so a single-message consumer sees the same turn the
    // next dispatcher pass will claim.
    queuedMessage: queuedMessages[0] ?? null,
    queuedMessages,
    updatedAt: row.updated_at,
    queuedDelivery: { status: row.queue_status, requestId: row.queue_request_id, error: row.queue_error },
  };
}

/** Draft routes and chat scheduling share these atomic queue operations. */
export const sessionDraftsDb = {
  /** User's debounced composer edits leave the dispatcher-owned queue untouched. */
  saveDraftText(userId: number, scope: string, text: string): void {
    const db = getConnection();
    db.prepare(`INSERT INTO session_drafts (user_id, draft_scope, draft_text, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, draft_scope) DO UPDATE SET
        draft_text = excluded.draft_text, updated_at = CURRENT_TIMESTAMP`).run(userId, scope, text);
    sessionDraftsDb.deleteEmptyDraft(userId, scope);
  },

  /** User's append endpoint adds an independent FIFO turn, preserving each turn's options and ticket. */
  appendQueuedMessage(userId: number, scope: string, message: QueuedChatMessage): { queuedMessage: QueuedChatMessage; appended: boolean } {
    const db = getConnection();
    return db.transaction(() => {
      const existing = db.prepare('SELECT draft_text, queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .get(userId, scope) as { draft_text: string; queued_message: string | null } | undefined;
      const queue = readQueuedMessages(existing?.queued_message ?? null);
      const queuedMessage = { ...message, id: randomUUID() };
      sessionDraftsDb.saveDraft(userId, scope, {
        text: existing?.draft_text ?? '',
        queuedMessages: [...queue, queuedMessage],
      });
      return { queuedMessage, appended: queue.length > 0 };
    })();
  },

  /** User's explicit cancellation clears the pending queue while retaining composer text and delivery guards. */
  clearQueuedMessage(userId: number, scope: string): void {
    const db = getConnection();
    db.transaction(() => {
      const existing = db.prepare('SELECT draft_text FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .get(userId, scope) as { draft_text: string } | undefined;
      sessionDraftsDb.saveDraft(userId, scope, { text: existing?.draft_text ?? '', queuedMessages: [] });
    })();
  },

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

  /**
   * Lists dispatchable queued turns, one per scope: only the queue head is a
   * dispatch candidate, so a later entry can never overtake it.
   *
   * The claim token is the whole stored value, which makes a claim fail when
   * any part of the queue changed between listing and claiming. Retired
   * provider drafts remain stored and unclaimed.
   */
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

    return rows.flatMap((row) => {
      const head = readQueuedMessages(row.queued_message)[0];
      return head === undefined
        ? []
        : [{
            userId: row.user_id,
            sessionId: row.draft_scope,
            queuedMessage: head,
            claimToken: row.queued_message,
          }];
    });
  },

  /**
   * Atomically reserves and removes the queue head, leaving the tail queued.
   *
   * The claimed turn gets a `dispatching` receipt before it leaves the queue.
   * `saveDraft` treats that ticket as already consumed, so a delayed browser
   * PUT carrying an older snapshot cannot resurrect a turn that is already
   * running. The receipt also reserves the slot, so a concurrent append cannot
   * push the pending count past the cap while dispatch is in flight.
   */
  claimQueuedMessage(candidate: QueuedSessionMessageRecord): boolean {
    const db = getConnection();
    return db.transaction(() => {
      const row = db.prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .get(candidate.userId, candidate.sessionId) as { queued_message: string | null } | undefined;
      if (!row || row.queued_message !== candidate.claimToken) {
        return false;
      }
      const queue = readQueuedMessages(row.queued_message);
      const head = queue[0];
      if (!head) {
        return false;
      }
      // A legacy entry without a ticket is stamped first so the receipt can
      // refer to it by a stable id.
      const messageId = queuedMessageId(head) ?? randomUUID();
      const stampedHead = queuedMessageId(head) ? head : { ...(head as Record<string, unknown>), id: messageId };
      const dispatchRequestId = `dispatch:${randomUUID()}`;
      const result = db.prepare(
        `UPDATE session_drafts
         SET queued_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ? AND queue_status = 'queued'`
      ).run(
        serializeQueuedMessages(queue.slice(1)),
        candidate.userId,
        candidate.sessionId,
        row.queued_message,
      );
      if (result.changes === 0) {
        return false;
      }
      db.prepare("INSERT INTO queued_steer_receipts(request_id, user_id, session_id, message_id, status) VALUES (?, ?, ?, ?, 'dispatching')")
        .run(dispatchRequestId, candidate.userId, candidate.sessionId, messageId);
      candidate.dispatchRequestId = dispatchRequestId;
      candidate.queuedMessage = stampedHead;
      return true;
    })();
  },

  /** Marks a claimed dispatch as accepted so a stale snapshot can never revive it. */
  confirmQueuedMessageDispatch(candidate: QueuedSessionMessageRecord): void {
    if (!candidate.dispatchRequestId) return;
    getConnection().prepare("UPDATE queued_steer_receipts SET status = 'accepted' WHERE request_id = ? AND status = 'dispatching'")
      .run(candidate.dispatchRequestId);
  },

  /**
   * Restores a claim lost to the narrow race where another run starts first.
   *
   * The dispatch receipt is deleted and the turn goes back at the head in one
   * transaction, so a concurrent save either sees the receipt (and drops that
   * ticket) or the restored head, never both. The tail is preserved and the
   * result can never exceed the cap.
   */
  restoreQueuedMessage(candidate: QueuedSessionMessageRecord): void {
    const db = getConnection();
    db.transaction(() => {
      if (candidate.dispatchRequestId) {
        db.prepare("DELETE FROM queued_steer_receipts WHERE request_id = ? AND status = 'dispatching'")
          .run(candidate.dispatchRequestId);
      }
      const existing = db.prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .get(candidate.userId, candidate.sessionId) as { queued_message: string | null } | undefined;
      const queue = readQueuedMessages(existing?.queued_message ?? null);
      const restoredId = queuedMessageId(candidate.queuedMessage);
      if (restoredId && queue.some((entry) => queuedMessageId(entry) === restoredId)) {
        return;
      }
      const restored = [candidate.queuedMessage, ...queue];
      if (restored.length > MAX_QUEUED_MESSAGES) {
        throw new AppError('The queue changed before the claimed message could be restored.', {
          code: 'QUEUE_LIMIT_REACHED', statusCode: 409,
        });
      }
      // A text-only save can remove the empty placeholder while the claim is
      // in flight. Restore its row as well as its message, retaining any tail.
      db.prepare(
        `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
         VALUES (?, ?, '', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, draft_scope) DO UPDATE SET
           queued_message = excluded.queued_message, updated_at = CURRENT_TIMESTAMP`
      ).run(candidate.userId, candidate.sessionId, serializeQueuedMessages(restored));
    })();
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
   *
   * Callers that understand the FIFO queue pass `queuedMessages`; the legacy
   * `queuedMessage` field still works and becomes a one-entry queue.
   */
  saveDraft(
    userId: number,
    scope: string,
    draft: SavedDraft
  ): void {
    const db = getConnection();
    const existing = db.prepare('SELECT queued_message, queue_status FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
      .get(userId, scope) as { queued_message: string | null; queue_status: string } | undefined;
    let queuedMessages = draft.queuedMessages ?? (draft.queuedMessage == null ? [] : [draft.queuedMessage]);
    if (queuedMessages.length > MAX_QUEUED_MESSAGES) {
      throw new AppError(`At most ${MAX_QUEUED_MESSAGES} messages can be queued for one chat.`, {
        code: 'QUEUE_LIMIT_REACHED',
        statusCode: 409,
      });
    }
    // A delayed draft PUT must not resurrect a message already accepted by a
    // steer or by the dispatcher, which holds a receipt while the turn runs.
    const receiptIds = (statuses: string) => (db.prepare(`SELECT message_id FROM queued_steer_receipts
      WHERE user_id = ? AND session_id = ? AND status IN (${statuses})`)
      .all(userId, scope) as { message_id: string }[]).map(({ message_id }) => message_id);
    const consumedIds = new Set(receiptIds("'dispatching', 'accepted'"));
    const dispatchingIds = receiptIds("'dispatching'");
    queuedMessages = queuedMessages.filter((message) => {
      const id = queuedMessageId(message);
      return !(id && consumedIds.has(id));
    });
    // A dispatching turn still occupies a queue slot until it is accepted or
    // put back, so an append here cannot push the pending count past the cap.
    const reserving = dispatchingIds.filter(
      (id) => !queuedMessages.some((message) => queuedMessageId(message) === id),
    ).length;
    if (queuedMessages.length + reserving > MAX_QUEUED_MESSAGES) {
      throw new AppError(`At most ${MAX_QUEUED_MESSAGES} messages can be queued for one chat.`, {
        code: 'QUEUE_LIMIT_REACHED',
        statusCode: 409,
      });
    }
    const serialized = serializeQueuedMessages(queuedMessages);
    if (existing && ['steering', 'unknown'].includes(existing.queue_status) && serialized !== existing.queued_message) {
      throw new AppError('The queued message is awaiting steering confirmation.', { code: 'QUEUE_BUSY', statusCode: 409 });
    }

    const text = draft.text ?? '';
    if (!text && serialized === null) {
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
      text,
      serialized
    );
  },

  deleteDraft(userId: number, scope: string): void {
    const db = getConnection();
    db.prepare("DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ? AND queue_status NOT IN ('steering', 'unknown')")
      .run(userId, scope);
  },

  /**
   * WebSocket promotes the queue head the user clicked; dispatcher uses the
   * same row lock. Only the head may be steered — promoting a later entry would
   * deliver the user's messages out of the order they queued them.
   */
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
      const queue = readQueuedMessages(row?.queued_message ?? null);
      const head = queue[0];
      const message = head && queuedMessageId(head) === messageId
        ? head as { id?: string }
        : undefined;
      if (!row || !message) {
        // A later entry is still queued; it simply cannot be steered ahead of
        // the head.
        const inQueue = queue.some((entry) => queuedMessageId(entry) === messageId);
        throw new AppError(
          inQueue
            ? 'Only the next queued message can be steered.'
            : 'The queued message has changed or was already sent.',
          { code: inQueue ? 'QUEUE_NOT_HEAD' : 'QUEUE_CHANGED', statusCode: 409 },
        );
      }
      if (!['queued', 'held'].includes(row.queue_status)) throw new AppError('This message is already awaiting confirmation.', { code: 'QUEUE_BUSY', statusCode: 409 });
      db.prepare("INSERT INTO queued_steer_receipts(request_id, user_id, session_id, message_id, status) VALUES (?, ?, ?, ?, 'steering')")
        .run(requestId, userId, scope, messageId);
      db.prepare("UPDATE session_drafts SET queue_status = 'steering', queue_request_id = ?, queue_error = NULL WHERE user_id = ? AND draft_scope = ?")
        .run(requestId, userId, scope);
      return { status: 'steering', queuedMessage: message };
    })();
  },

  /**
   * Persists the RPC outcome and consumes only the message owned by this
   * request, leaving every other entry queued in place.
   */
  finishSteer(userId: number, scope: string, requestId: string, status: 'accepted' | 'rejected' | 'unknown', error: string | null = null): 'accepted' | 'rejected' | 'unknown' {
    const db = getConnection();
    return db.transaction(() => {
      const previous = db.prepare('SELECT status, message_id FROM queued_steer_receipts WHERE request_id = ?')
        .get(requestId) as { status: string; message_id: string } | undefined;
      if (previous?.status === 'accepted') return 'accepted' as const;
      db.prepare('UPDATE queued_steer_receipts SET status = ?, error = ? WHERE request_id = ? AND user_id = ? AND session_id = ?')
        .run(status, error, requestId, userId, scope);
      const row = db.prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ? AND queue_request_id = ?')
        .get(userId, scope, requestId) as { queued_message: string | null } | undefined;
      const queue = readQueuedMessages(row?.queued_message ?? null);
      // Accepted means the provider took that exact turn: drop only its entry.
      const remaining = status === 'accepted' && previous
        ? queue.filter((entry) => queuedMessageId(entry) !== previous.message_id)
        : queue;
      db.prepare(`UPDATE session_drafts SET
        queued_message = ?,
        queue_status = ?, queue_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND draft_scope = ? AND queue_request_id = ?`)
        .run(serializeQueuedMessages(remaining), status === 'accepted' ? 'queued' : status === 'rejected' ? 'held' : 'unknown', error, userId, scope, requestId);
      return status;
    })();
  },

  /** Native userMessage echoes prove delivery even if the steer RPC acknowledgement was lost. */
  confirmSteer(scope: string, requestId: string): void {
    const row = getConnection().prepare('SELECT user_id FROM queued_steer_receipts WHERE session_id = ? AND request_id = ?')
      .get(scope, requestId) as { user_id: number } | undefined;
    if (row) this.finishSteer(row.user_id, scope, requestId, 'accepted');
  },

  /**
   * Explicit user resolution of an unprovable outcome; never invoked by
   * automatic dispatch. Either decision preserves the rest of the queue.
   */
  recoverUnknown(userId: number, scope: string, decision: 'queue' | 'discard'): void {
    const db = getConnection();
    db.transaction(() => {
      const row = db.prepare("SELECT queued_message, queue_request_id FROM session_drafts WHERE user_id = ? AND draft_scope = ? AND queue_status = 'unknown'")
        .get(userId, scope) as { queued_message: string | null; queue_request_id: string } | undefined;
      if (!row) throw new AppError('This message no longer needs delivery recovery.', { code: 'QUEUE_CHANGED', statusCode: 409 });
      const receipt = db.prepare('SELECT message_id FROM queued_steer_receipts WHERE request_id = ?')
        .get(row.queue_request_id) as { message_id: string } | undefined;
      const recovered = readQueuedMessages(row.queued_message).flatMap((entry) => {
        if (queuedMessageId(entry) !== receipt?.message_id) return [entry];
        if (decision === 'discard') return [];
        const original = entry as Record<string, unknown> | null;
        return original ? [{ ...original, id: randomUUID() }] : [];
      });
      db.prepare("UPDATE queued_steer_receipts SET status = 'resolved' WHERE request_id = ? AND status = 'unknown'").run(row.queue_request_id);
      db.prepare("UPDATE session_drafts SET queued_message = ?, queue_status = 'queued', queue_request_id = NULL, queue_error = NULL WHERE user_id = ? AND draft_scope = ?")
        .run(serializeQueuedMessages(recovered), userId, scope);
    })();
  },

  /** Explicitly releases a held queue after a failed steer or a user-requested stop. */
  resumeQueue(userId: number, scope: string): void {
    getConnection().prepare("UPDATE session_drafts SET queue_status = 'queued', queue_error = NULL WHERE user_id = ? AND draft_scope = ? AND queue_status = 'held'")
      .run(userId, scope);
  },
};
