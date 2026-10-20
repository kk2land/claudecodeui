import { stat } from 'node:fs/promises';

import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import type { CodexRpcClient } from '@/shared/index.js';
import { AppError } from '@/shared/index.js';

/** Codex and GPT Web session/fork adapters bind this client to their runtime-owned transport. */
export function createCodexAppServerClient(client: CodexRpcClient = codexAppServerTransport) {
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
  async function forkThread(input: {
    threadId: string;
    lastTurnId?: string;
    cwd: string;
  }): Promise<{ threadId: string; path: string }> {

    const result = await client.request('thread/fork', {
      threadId: input.threadId,
      ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
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
  }
  return { forkThread };
}

/** Codex runtime and session adapters use the default profile client. */
export const codexAppServer = createCodexAppServerClient();
