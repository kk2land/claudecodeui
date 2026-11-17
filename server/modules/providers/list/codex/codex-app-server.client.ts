import { stat } from 'node:fs/promises';

import { z } from 'zod';

import { codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import {
  AppError,
  SIDE_CONVERSATION_BOUNDARY_PROMPT,
  SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS,
} from '@/shared/index.js';
import { SIDE_QUESTION_ANSWER_SEPARATOR } from '@/shared/utils.js';
import type { CodexModelSelection, CodexRpcClient, CodexRpcFrame } from '@/shared/index.js';

/**
 * How long a side-question turn may run before it is given up on. A side
 * question is a model turn, not a handshake request, so this is a generous
 * ceiling against a turn that never completes rather than a tuned value.
 */
const SIDE_QUESTION_TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a released fork may keep the new thread loaded before we give up.
 * Matches the runtime's own thread-unload deadline: `thread/unsubscribe`
 * acknowledges detachment before the native shutdown finishes, and only
 * `thread/closed` proves it.
 */
const FORKED_THREAD_CLOSE_TIMEOUT_MS = 10_000;

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
   *
   * `modelSelection` is the inference route the copy must run with. It is sent
   * explicitly and then confirmed against the thread Codex reports back, so a
   * fork can never answer from the source's service by accident.
   *
   * The new thread is unsubscribed and awaited closed before this returns. A
   * fork loads and subscribes the copy immediately, while a loaded
   * `thread/resume` ignores thread config overrides. Leaving it open would make
   * the new app session's first turn a hot resume of this process's copy; a
   * cold resume is the path on which that session presents its own thread
   * config. The source thread is never touched; the caller only ever gets a
   * detached rollout.
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
    }) as { thread?: { id?: unknown; path?: unknown; modelProvider?: unknown; model?: unknown };
      modelProvider?: unknown; model?: unknown } | undefined;

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

    if (input.modelSelection) {
      // The response is the only proof of what the copy really runs with.
      // Reading both envelope and thread keeps this working across protocol
      // revisions that moved the field, and a missing field is a failure:
      // the caller asked for an exact route and cannot be told it was applied.
      const appliedProvider = typeof result?.modelProvider === 'string' ? result.modelProvider
        : typeof result?.thread?.modelProvider === 'string' ? result.thread.modelProvider : '';
      const appliedModel = typeof result?.model === 'string' ? result.model
        : typeof result?.thread?.model === 'string' ? result.thread.model : '';
      if (appliedProvider !== input.modelSelection.modelProvider
        || (input.modelSelection.model !== null && appliedModel !== input.modelSelection.model)) {
        throw new AppError('Codex did not apply the requested model service to the fork.', {
          code: 'FORK_MODEL_PROVIDER_MISMATCH',
          statusCode: 502,
        });
      }
    }

    // The copy loaded and subscribed itself with `thread/fork`. Detach that
    // subscription and wait for the native close notification here, so the new
    // app session's first open takes the cold-resume path and presents its own
    // thread config instead of reusing this process's loaded copy. Only the
    // copy is touched; the source thread stays loaded exactly as it was.
    let detach = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let confirmClosed!: () => void;
    const closed = new Promise<void>((resolve, reject) => {
      confirmClosed = resolve;
      detach = codexAppServerTransport.onNotification((frame) => {
        if (frame.method === 'thread/closed' && frame.params?.threadId === threadId) resolve();
      });
      timer = setTimeout(() => reject(new AppError('Codex did not confirm that the forked thread was released.', {
        code: 'FORK_FAILED',
        statusCode: 502,
      })), FORKED_THREAD_CLOSE_TIMEOUT_MS);
    });
    // A failed unsubscribe check abandons this promise; keep that from
    // surfacing as an unhandled rejection while the caller gets the real error.
    closed.catch(() => {});
    try {
      const released = await codexAppServerTransport.request('thread/unsubscribe', { threadId }) as { status?: unknown } | undefined;
      if (released?.status === 'notLoaded') confirmClosed();
      else if (!['unsubscribed', 'notSubscribed'].includes(String(released?.status))) {
        throw new AppError('Codex did not confirm that the forked thread was unsubscribed.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }
      await closed;
    } finally {
      clearTimeout(timer);
      detach();
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
  transport(): CodexRpcClient {
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
 * Cancellation is independent of the parent: settling (abort, timeout, failure
 * or a normal answer) always unloads this ephemeral fork, and an abort while
 * its turn is still running also interrupts that turn; both are fire-and-forget
 * so a turn that never acknowledges cannot keep the fork loaded. The ask rejects
 * with `CODEX_SIDE_QUESTION_ABORTED` on abort. Because the shared child also
 * serves the parent, a cancelled or failed side question never stops that
 * process — unlike a transient client, whose child died with the request.
 */
async function askSideQuestionOn(
  transport: CodexRpcClient,
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
    // Codex often writes a progress note ("I'll read notes.md.") and the answer
    // as two agentMessage items. A new item id after text already sent starts a
    // new paragraph. A delta without an item id is taken as part of the current
    // item: a seam guessed wrong would split a word.
    let currentItemId: string | null = null;
    const appendAgentText = (itemId: string | null, chunk: string) => {
      if (text && itemId !== null && currentItemId !== null && itemId !== currentItemId) {
        text += SIDE_QUESTION_ANSWER_SEPARATOR;
        onDelta(SIDE_QUESTION_ANSWER_SEPARATOR);
      }
      if (itemId !== null) {
        currentItemId = itemId;
      }
      text += chunk;
      onDelta(chunk);
    };
    let settled = false;
    let forkThreadId: string | null = null;
    let forkTurnId: string | null = null;
    // A turn that already reported turn/completed needs no interrupt.
    let forkTurnFinished = false;
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
     * Releases this question's listeners and its ephemeral fork, interrupting
     * the fork's own turn when it is still running. Fire-and-forget: the
     * outcome is already decided, and a failed interrupt or unload only leaves
     * an ephemeral thread to expire. `thread/unsubscribe` does not wait for the
     * interrupt, so a turn that never acknowledges is still released at once.
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
      if (forkThreadId) {
        if (forkTurnId && !forkTurnFinished) {
          // A running fork turn: interrupt just that turn.
          void transport.request('turn/interrupt', { threadId: forkThreadId, turnId: forkTurnId }).catch(() => {});
        }
        // The fork is ephemeral and never needed again once this question
        // settles, so unloading it is the whole cleanup: `thread/unsubscribe`
        // releases the loaded thread on the shared process (the app's own unload
        // path) without touching the parent. A normal turn/completed sent no
        // interrupt; it still needs this unload or the fork stays loaded.
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
        const typedForkResult = forkResult as { thread?: { id?: unknown } } | undefined;
        forkThreadId = typeof typedForkResult?.thread?.id === 'string' ? typedForkResult.thread.id : null;
        if (settled) {
          // Dismissed while `thread/fork` was still answered late: the fork is
          // loaded now but no turn will ever start on it, so release it here.
          if (forkThreadId) {
            void transport.request('thread/unsubscribe', { threadId: forkThreadId }).catch(() => {});
          }
          return;
        }
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
        removeExitListener = transport.onExit((error, _instanceId, threadIds) => {
          if (threadIds && !threadIds.has(forkId)) return;
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
              const itemId = typeof params.itemId === 'string' ? params.itemId : null;
              if (itemId !== null) {
                streamedItemIds.add(itemId);
              }
              appendAgentText(itemId, delta);
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
              appendAgentText(typeof item.id === 'string' ? item.id : null, item.text);
            }
            return;
          }

          if (frame.method === 'turn/completed') {
            forkTurnFinished = true;
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
