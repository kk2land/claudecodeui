import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';

import { sessionsDb } from '@/modules/database/index.js';
import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';
import { DshSessionStore } from '@/modules/providers/list/dsh/dsh-session-store.provider.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult } from '@/shared/types.js';
import { sliceTailPage } from '@/shared/utils.js';

/** Native history facet used by the provider registry and conversation APIs. */
export class DshSessionsProvider implements IProviderSessions {
  constructor(private readonly store: DshSessionStore, private readonly events: DshEventsProvider) {}

  normalizeMessage(raw: unknown, sessionId: string | null) { return this.events.normalize(raw, sessionId); }

  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    const expectedId = options.providerSessionId ?? session?.provider_session_id ?? sessionId;
    // A scheduled task may run with its own DSH home, so the configured root need not contain the
    // transcript. The host's indexed path is authoritative for that session; the store still
    // verifies the native header and follows the newest generation in the directory.
    const indexedPath = session?.jsonl_path;
    // An indexed conversation must not fall back to a scan of another (host-default) root: that
    // could serve a different native file for the same id after a task's home changed.
    const log = indexedPath
      ? await this.store.readIndexed(indexedPath, expectedId).catch(() => null)
      : await this.store.find(expectedId);
    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit == null ? null : Math.max(0, options.limit);
    if (!log) return { messages: [], total: 0, hasMore: false, limit, offset };
    // The human transcript retains append-origin messages in log order.
    // Surface replacements are model-only summaries/copies: applying them
    // here would erase conversation the user already saw before compaction.
    const messages = log.events.filter((event) => isAppendSurfaceEvent(event as Parameters<typeof isAppendSurfaceEvent>[0]))
      .flatMap((event) => this.events.normalize(event, sessionId));
    const { page, hasMore } = sliceTailPage(messages, limit, offset);
    return { messages: page, total: messages.length, hasMore, limit, offset };
  }
}
