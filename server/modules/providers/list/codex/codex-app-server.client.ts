import { stat } from 'node:fs/promises';

import { z } from 'zod';

import {
  codexAppServerTransport,
  type CodexAppServerTransport,
} from '@/modules/providers/list/codex/codex-app-server.transport.js';
import {
  AppError,
  SIDE_CONVERSATION_BOUNDARY_PROMPT,
  SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS,
} from '@/shared/index.js';
import type { CodexModelSelection, CodexRpcFrame } from '@/shared/index.js';

/**
 * How long a side-question turn may run before it is given up on. A side
 * question is a model turn, not a handshake request, so this is a generous
 * ceiling against a turn that never completes rather than a tuned value.
 */
const SIDE_QUESTION_TURN_TIMEOUT_MS = 5 * 60_000;

/** One side question asked on an ephemeral fork of a Codex thread. */
export type CodexSideQuestionInput = {
  threadId: string;
  cwd: string;
  model: string;
  /** Model provider recorded on the parent, so the fork does not fall back to config defaults. */
  modelProvider?: string;
  question: string;
  signal: AbortSignal;
};

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

  /**
   * Asks one question on an ephemeral, read-only fork of `input.threadId`
   * through the runtime-owned persistent app-server connection.
   *
   * The parent thread may be running a native turn on that same connection, so
   * this never stops or blocks it: the fork is a separate ephemeral thread,
   * `ephemeral: true` keeps it off disk, `sandbox: 'read-only'` and
   * `approvalPolicy: 'never'` keep it from mutating anything or waiting on an
   * approval no one can give, and `excludeTurns: true` keeps the fork response
   * to the thread metadata alone. The turn itself is Codex's own
   * side-conversation boundary prompt followed by the question.
   *
   * `modelProvider`/`model` come from the parent so the fork is answered by the
   * same provider the parent was started with; the connection inherits this
   * process's `CODEX_HOME` and credentials, exactly as the parent's turns do.
   *
   * See `askSideQuestionOn` for the read-only overrides (MCP servers, apps,
   * web search, plugins) and the cancellation contract.
   */
  askSideQuestion(
    input: CodexSideQuestionInput,
    onDelta: (text: string) => void,
  ): Promise<string> {
    return askSideQuestionOn(codexAppServer.transport(), input, onDelta);
  },

  /**
   * The connection side questions run on. A property rather than a module-local
   * constant so the providers tests can point it at a transport built with a
   * fake `spawn`; production always uses the runtime-owned shared connection.
   */
  transport(): CodexAppServerTransport {
    return codexAppServerTransport;
  },
};

/**
 * Answers one side question on `transport`: ephemeral read-only fork plus one
 * turn, with every outbound capability switched off by name.
 *
 * Private to this module: `codexAppServer.askSideQuestion` is the only caller
 * and the `transport()` seam above is what the tests replace, so the question
 * protocol has no second public entry point.
 *
 * Cancellation is independent of the parent: an abort interrupts this fork's
 * turn (or unloads the fork when the turn id is not known yet) and rejects
 * with `CODEX_SIDE_QUESTION_ABORTED`. Because the shared child also serves the
 * parent, a cancelled or failed side question never stops that process —
 * unlike a transient client, whose child died with the request.
 */
async function askSideQuestionOn(
  transport: CodexAppServerTransport,
  input: CodexSideQuestionInput,
  onDelta: (text: string) => void,
): Promise<string> {
  const abortedError = () => new AppError('The side question was aborted.', {
    code: 'CODEX_SIDE_QUESTION_ABORTED',
    statusCode: 499,
  });

  if (input.signal.aborted) {
    throw abortedError();
  }

  // Reads the same config layer stack `thread/fork` below will see — `cwd` is
  // what makes `config/read` fold in a trusted project's `.codex/config.toml` —
  // and names each MCP server and app so the fork turns them all off.
  const configOverridesOff = async (): Promise<{
    mcpServers: Record<string, unknown>;
    apps: Record<string, unknown>;
  }> => {
    const configResult = await transport.request('config/read', input.cwd ? { cwd: input.cwd } : {}) as {
      config?: { mcp_servers?: Record<string, unknown>; apps?: Record<string, unknown> };
    } | undefined;
    const mcpServerNames = Object.keys(configResult?.config?.mcp_servers ?? {});
    const appNames = Object.keys(configResult?.config?.apps ?? {});
    return {
      mcpServers: Object.fromEntries(mcpServerNames.map((name) => [name, { enabled: false }])),
      apps: Object.fromEntries(
        [...new Set([...appNames, '_default'])].map((name) => [name, { enabled: false }]),
      ),
    };
  };

  // `plugin/list` can fail offline (no auth, no network); that only means there
  // is nothing to name in `disabledPluginIds`, not a reason to refuse.
  const pluginIdsOff = async (): Promise<string[]> => {
    try {
      const result = await transport.request('plugin/list', {}) as {
        marketplaces?: Array<{ plugins?: Array<{ id?: unknown }> }>;
      } | undefined;
      const ids: string[] = [];
      for (const marketplace of result?.marketplaces ?? []) {
        for (const plugin of marketplace.plugins ?? []) {
          if (typeof plugin?.id === 'string') {
            ids.push(plugin.id);
          }
        }
      }
      return ids;
    } catch {
      return [];
    }
  };

  return new Promise<string>((resolve, reject) => {
    let text = '';
    // Deltas are optional and `item/completed` is the final item, so an agent
    // message that never streamed is taken from there instead.
    const streamedItemIds = new Set<string>();
    let settled = false;
    let forkThreadId: string | null = null;
    let forkTurnId: string | null = null;
    let removeNotificationListener: (() => void) | null = null;
    let removeExitListener: (() => void) | null = null;

    const timer = setTimeout(() => {
      settle(() => reject(new AppError(
        `Codex side question did not complete within ${SIDE_QUESTION_TURN_TIMEOUT_MS}ms.`,
        { code: 'CODEX_SIDE_QUESTION_TIMEOUT', statusCode: 504 },
      )));
    }, SIDE_QUESTION_TURN_TIMEOUT_MS);

    const onAbort = () => {
      settle(() => reject(abortedError()));
    };
    input.signal.addEventListener('abort', onAbort);

    /**
     * Releases this question's listeners and, when it is still running,
     * interrupts its own fork turn. Fire-and-forget: the outcome is already
     * decided, and a failed interrupt only leaves an ephemeral turn to expire.
     */
    function settle(action: () => void) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      removeNotificationListener?.();
      removeExitListener?.();
      if (forkThreadId && forkTurnId) {
        // A running fork turn: interrupt just that turn.
        void transport.request('turn/interrupt', { threadId: forkThreadId, turnId: forkTurnId }).catch(() => {});
      } else if (forkThreadId) {
        // Dismissed while `turn/start` was still unanswered, so there is no
        // turn id to interrupt yet. The fork is ephemeral and never listed
        // anywhere else, so unloading it is the whole cleanup: `thread/unsubscribe`
        // releases the loaded thread on the shared process (the app's own unload
        // path) without touching the parent.
        void transport.request('thread/unsubscribe', { threadId: forkThreadId }).catch(() => {});
      }
      action();
    }

    if (input.signal.aborted) {
      settle(() => reject(abortedError()));
      return;
    }

    void Promise.all([configOverridesOff(), pluginIdsOff()]).then(([{ mcpServers, apps }, pluginIds]) => {
      if (settled) {
        // Aborted or timed out while config/read or plugin/list was in flight.
        return;
      }
      return transport.request('thread/fork', {
        threadId: input.threadId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        developerInstructions: SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS,
        excludeTurns: true,
        // `thread/fork`'s `config` deep-merges, so `mcp_servers: {}` is a no-op;
        // each server needs its own `enabled: false`. `features.plugins: false`
        // is the master switch for plugin tools, skills and plugin MCP servers.
        config: {
          mcp_servers: mcpServers,
          web_search: 'disabled',
          apps,
          features: { plugins: false },
        },
      }).then((forkResult) => {
        if (settled) {
          return;
        }

        const typedForkResult = forkResult as { thread?: { id?: unknown } } | undefined;
        forkThreadId = typeof typedForkResult?.thread?.id === 'string' ? typedForkResult.thread.id : null;
        if (!forkThreadId) {
          settle(() => reject(new AppError('Codex reported a side-question fork without a thread id.', {
            code: 'FORK_FAILED',
            statusCode: 502,
          })));
          return;
        }
        const forkId = forkThreadId;

        // From here on the turn waiter sits on a notification, so a shared child
        // that exits mid-turn is noticed now instead of at the timeout.
        removeExitListener = transport.onExit((error) => {
          settle(() => reject(new AppError(
            `Codex exited before the side-question turn finished (${error.message}).`,
            { code: 'CODEX_SIDE_QUESTION_FAILED', statusCode: 502 },
          )));
        });

        removeNotificationListener = transport.onNotification((frame: CodexRpcFrame) => {
          const params = frame.params as {
            threadId?: unknown;
            itemId?: unknown;
            delta?: unknown;
            item?: { type?: unknown; id?: unknown; text?: unknown };
            turn?: { id?: unknown; status?: unknown; error?: { message?: unknown } };
          } | undefined;
          // Another thread's notifications (the parent's, or another side
          // question's) arrive on the same connection; only this fork is ours.
          if (params?.threadId !== forkId) {
            return;
          }

          if (frame.method === 'item/agentMessage/delta') {
            const delta = typeof params.delta === 'string' ? params.delta : '';
            if (delta) {
              if (typeof params.itemId === 'string') {
                streamedItemIds.add(params.itemId);
              }
              text += delta;
              onDelta(delta);
            }
            return;
          }

          if (frame.method === 'item/completed') {
            const item = params.item;
            if (
              item?.type === 'agentMessage'
              && typeof item.text === 'string' && item.text
              && !(typeof item.id === 'string' && streamedItemIds.has(item.id))
            ) {
              text += item.text;
              onDelta(item.text);
            }
            return;
          }

          if (frame.method === 'turn/completed') {
            if (typeof params.turn?.id === 'string') {
              forkTurnId = params.turn.id;
            }
            const status = params.turn?.status;
            if (status === 'completed') {
              settle(() => resolve(text));
              return;
            }
            const message = typeof params.turn?.error?.message === 'string'
              ? params.turn.error.message
              : `Codex side-question turn ${String(status)}.`;
            settle(() => reject(new AppError(message, { code: 'CODEX_SIDE_QUESTION_FAILED', statusCode: 502 })));
          }
        });

        if (settled) {
          return;
        }

        void transport.request('turn/start', {
          threadId: forkId,
          disabledPluginIds: pluginIds,
          input: [
            { type: 'text', text: SIDE_CONVERSATION_BOUNDARY_PROMPT, text_elements: [] },
            { type: 'text', text: input.question, text_elements: [] },
          ],
        }).then((turnResult) => {
          const turn = (turnResult as { turn?: { id?: unknown } } | undefined)?.turn;
          if (typeof turn?.id === 'string') {
            forkTurnId = turn.id;
          }
        }).catch((error: unknown) => {
          settle(() => reject(error));
        });
      });
    }).catch((error: unknown) => {
      settle(() => reject(error));
    });
  });
}
