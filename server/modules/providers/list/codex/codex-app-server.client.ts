import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import type { AnyRecord, CodexAppServerClientOptions, CodexAppServerConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** How long a single request may take before the child is killed. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * One fork of a Codex thread.
 *
 * `path` is returned by the server rather than reconstructed: the rollout
 * lands in today's date directory, not next to the file it was copied from,
 * so deriving it from the source path would be wrong roughly every day.
 */
type CodexThreadFork = {
  threadId: string;
  path: string;
};

/**
 * Resolves the `codex` launcher shipped in node_modules.
 *
 * Deliberately not the `codex` on PATH: a machine can have a second, older
 * install, and the protocol this speaks is only guaranteed against the
 * version this package depends on.
 */
function resolveCodexLauncher(): string {
  const require_ = createRequire(import.meta.url);
  try {
    return require_.resolve('@openai/codex/bin/codex.js');
  } catch {
    throw new AppError('The Codex CLI package is not installed, so Codex app-server is unavailable.', {
      code: 'CODEX_APP_SERVER_UNAVAILABLE',
      statusCode: 501,
    });
  }
}

/** Used by the Codex fork and chat adapters; each caller owns one child process. */
export function createCodexAppServerClient(
  options: CodexAppServerClientOptions = {},
): CodexAppServerConnection {
  const child = spawn(process.execPath, [resolveCodexLauncher(), 'app-server'], {
    cwd: options.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
  let nextRequestId = 1;
  let exitError: Error | null = null;
  let closed = false;
  const pending = new Map<number, { resolve(value: AnyRecord): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (error: Error) => {
    if (exitError) return;
    exitError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    if (!closed) options.onExit?.(error);
  };
  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    if (!line.trim()) return;
    let message: AnyRecord;
    try { message = JSON.parse(line); } catch { return; }
    // Requests have both method and id; never mistake them for client RPC replies.
    if (typeof message.method === 'string') {
      try { options.onMessage?.(message); } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(new AppError(message.error.message || 'Codex app-server rejected the request.', {
        code: 'CODEX_APP_SERVER_ERROR', statusCode: 502,
        details: { rpcCode: message.error.code },
      }));
    } else request.resolve(message.result ?? {});
  });
  child.on('error', fail);
  child.on('exit', (code, signal) => fail(new AppError(
    `codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})${stderr ? ` — ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`,
    { code: 'CODEX_APP_SERVER_UNAVAILABLE', statusCode: 502 },
  )));
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('error', () => {});
  const write = (message: unknown) => {
    if (exitError) throw exitError;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const call = (method: string, params: unknown): Promise<AnyRecord> => new Promise((resolve, reject) => {
    if (exitError) { reject(exitError); return; }
    const id = nextRequestId++;
    const timer = setTimeout(() => {
      fail(new AppError(`Codex app-server did not answer "${method}" within ${REQUEST_TIMEOUT_MS}ms.`, {
        code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504,
      }));
      child.kill();
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try { write({ id, method, params }); } catch (error) { fail(error as Error); }
  });
  return {
    call,
    async initialize(experimentalApi = false) {
      await call('initialize', {
        clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
        capabilities: { experimentalApi },
      });
      write({ method: 'initialized', params: {} });
    },
    respond(id, result) { write({ id, result }); },
    respondError(id, message) { write({ id, error: { code: -32601, message } }); },
    close() {
      closed = true;
      fail(new Error('Codex app-server connection closed.'));
      reader.close();
      child.kill();
    },
  };
}

async function withAppServer<T>(
  run: (call: CodexAppServerConnection['call']) => Promise<T>,
): Promise<T> {
  const client = createCodexAppServerClient();
  try {
    await client.initialize();
    return await run(client.call);
  } finally { client.close(); }
}

/** Used by CodexForkProvider and CodexSessionsProvider to copy persisted threads. */
export const codexAppServer = {
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
  }): Promise<CodexThreadFork> {
    return withAppServer(async (call) => {
      const result = await call('thread/fork', {
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
    });
  },
};
