import { foldSurface } from '@deepseek-ai/dsh-session/surface';

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
    const log = await this.store.find(options.providerSessionId ?? sessionId);
    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit == null ? null : Math.max(0, options.limit);
    if (!log) return { messages: [], total: 0, hasMore: false, limit, offset };
    // The official fold removes compacted/replaced nodes rather than showing
    // both their old contents and their replacement as duplicate history.
    const surface = foldSurface(log.events as unknown as Parameters<typeof foldSurface>[0]);
    const visible = new Set<number>(surface.nodes);
    const messages = log.events.filter((event) => visible.has(event.seq)).flatMap((event) => this.events.normalize(event, sessionId));
    const { page, hasMore } = sliceTailPage(messages, limit, offset);
    return { messages: page, total: messages.length, hasMore, limit, offset };
  }
}
