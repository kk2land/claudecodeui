import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import type { LLMProvider, SessionTransferRecord } from '@/shared/types.js';

type TransferRow = {
  session_id: string;
  source_session_id: string;
  source_provider: LLMProvider;
  messages_json: string;
  context: string;
  context_mode: 'full' | 'compact';
  applied: number;
};

/** Providers use this repository to atomically allocate portable forks and retain their history independently of the source's lifetime. */
export const sessionTransfersDb = {
  has(sessionId: string): boolean {
    return Boolean(getConnection().prepare('SELECT 1 FROM session_transfers WHERE session_id = ?').get(sessionId));
  },

  get(sessionId: string): SessionTransferRecord | null {
    const row = getConnection().prepare('SELECT * FROM session_transfers WHERE session_id = ?').get(sessionId) as TransferRow | undefined;
    return row ? {
      sessionId: row.session_id,
      sourceSessionId: row.source_session_id,
      sourceProvider: row.source_provider,
      messages: JSON.parse(row.messages_json) as SessionTransferRecord['messages'],
      context: row.context,
      contextMode: row.context_mode,
      applied: Boolean(row.applied),
    } : null;
  },

  create(input: SessionTransferRecord & {
    provider: LLMProvider;
    projectPath: string;
    title: string;
    model: string | null;
    effort: string | null;
  }): void {
    const db = getConnection();
    db.transaction(() => {
      sessionsDb.createAppSession(input.sessionId, input.provider, input.projectPath, input.title);
      db.prepare('UPDATE sessions SET model = ?, effort = ?, forked_from_session_id = ? WHERE session_id = ?')
        .run(input.model, input.effort, input.sourceSessionId, input.sessionId);
      db.prepare(`INSERT INTO session_transfers
        (session_id, source_session_id, source_provider, messages_json, context, context_mode, applied)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.sessionId, input.sourceSessionId, input.sourceProvider, JSON.stringify(input.messages), input.context, input.contextMode, Number(input.applied));
    })();
  },

  setApplied(sessionId: string, applied: boolean): void {
    getConnection().prepare('UPDATE session_transfers SET applied = ? WHERE session_id = ?').run(Number(applied), sessionId);
  },
};
