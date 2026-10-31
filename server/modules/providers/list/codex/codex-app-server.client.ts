import { stat } from 'node:fs/promises';

import { z } from 'zod';

import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { AppError } from '@/shared/index.js';
import type { CodexModelSelection } from '@/shared/index.js';

const threadListResponse = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    source: z.union([z.string(), z.record(z.string(), z.unknown())]),
    recencyAt: z.number().nullable().optional(),
    updatedAt: z.number(),
    status: z.object({ type: z.string() }),
  })),
  nextCursor: z.string().nullable().optional(),
});

/** Session branching and retention use the runtime-owned persistent transport. */
export const codexAppServer = {
  /** Retention explicitly includes exec, subagents, and every model provider on each page. */
  async listThreads(archived: boolean, cursor?: string) {
    const result = threadListResponse.parse(await codexAppServerTransport.request('thread/list', {
      archived, cursor, limit: 100, modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
        'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'],
      sortKey: 'recency_at', sortDirection: 'asc',
    }));
    return {
      threads: result.data.map((thread) => ({
        id: thread.id,
        isExec: thread.source === 'exec',
        lastUsedAt: (thread.recencyAt ?? thread.updatedAt) * 1000,
        active: thread.status.type === 'active',
      })),
      nextCursor: result.nextCursor ?? null,
    };
  },

  /** Retention delegates native storage and fork bookkeeping to Codex itself. */
  async deleteThread(threadId: string): Promise<void> {
    await codexAppServerTransport.request('thread/delete', { threadId });
  },

  /**
   * Copies a thread into a new one that ends at `lastTurnId`, or copies the
   * whole thread when it is omitted.
   *
   * `lastTurnId` is inclusive of the turn it names, which is the same
   * convention the app's edit anchor uses ("the last row to keep").
   *
   * `cwd` decides the working directory recorded in the copy's `session_meta`,
   * and that field is what the session indexer keys a session's project off —
   * omitting it would file every fork under whatever directory this server
   * happens to be running from.
   */
  async forkThread(input: {
    threadId: string;
    lastTurnId?: string;
    cwd: string;
    modelSelection?: CodexModelSelection;
  }): Promise<{ threadId: string; path: string }> {

    const result = await codexAppServerTransport.request('thread/fork', {
      threadId: input.threadId,
      ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      // A native fork loads immediately and otherwise uses config defaults,
      // even when its parent was resumed with a different model provider.
      ...(input.modelSelection ? { modelProvider: input.modelSelection.modelProvider,
        ...(input.modelSelection.model ? { model: input.modelSelection.model } : {}) } : {}),
    }) as { thread?: { id?: unknown; path?: unknown } } | undefined;

    const threadId = typeof result?.thread?.id === 'string' ? result.thread.id : '';
    const path = typeof result?.thread?.path === 'string' ? result.thread.path : '';
    if (!threadId || !path) {
      throw new AppError('Codex reported a fork without a thread id or transcript path.', {
        code: 'FORK_FAILED',
        statusCode: 502,
      });
    }

    // Confirmed rather than trusted: both callers are about to point a
    // database row at this file, and a row naming a transcript that is not
    // there is a session that can never be opened.
    try {
      await stat(path);
    } catch {
      throw new AppError('Codex reported a fork but wrote no transcript for it.', {
        code: 'FORK_FAILED',
        statusCode: 502,
      });
    }

    return { threadId, path };
  },
};
