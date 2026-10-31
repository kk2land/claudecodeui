import { sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import type { SessionRetentionSummary } from '@/shared/index.js';

/** The daily maintenance service supplies known active native ids, including SDK runs. */
export async function cleanupExpiredCodexSessions(now: number, activeSessionIds: ReadonlySet<string>) {
  const summaries = {
    exec: { deleted: 0, skipped: 0, failed: 0 } satisfies SessionRetentionSummary,
    other: { deleted: 0, skipped: 0, failed: 0 } satisfies SessionRetentionSummary,
  };
  const threads: Awaited<ReturnType<typeof codexAppServer.listThreads>>['threads'] = [];
  // Finish pagination before deleting: removing rows while following cursors
  // can otherwise change which threads the later pages contain.
  for (const archived of [false, true]) {
    let cursor: string | undefined;
    do {
      const page = await codexAppServer.listThreads(archived, cursor);
      threads.push(...page.threads);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  for (const thread of threads) {
    const summary = thread.isExec ? summaries.exec : summaries.other;
    const cutoff = now - (thread.isExec ? 7 : 30) * 86_400_000;
    const indexed = sessionsDb.getSessionByProviderSessionId(thread.id, 'codex');
    // Native recency does not change when the app reads or resumes a thread.
    const lastUsedAt = Math.max(thread.lastUsedAt, indexed?.last_opened_at ? Date.parse(indexed.last_opened_at) : 0);
    if (thread.active || activeSessionIds.has(thread.id) || lastUsedAt >= cutoff) {
      summary.skipped++;
      continue;
    }
    try {
      await codexAppServer.deleteThread(thread.id);
      if (indexed) {
        sessionsDb.deleteSessionById(indexed.session_id);
        sessionHistoryCache.invalidate(indexed.session_id);
      }
      summary.deleted++;
    } catch (error) {
      summary.failed++;
      console.error('[SessionRetention] Codex cleanup failed', { threadId: thread.id, error: String(error) });
    }
  }
  return summaries;
}
