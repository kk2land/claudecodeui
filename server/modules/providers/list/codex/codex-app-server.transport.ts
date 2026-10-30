import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { CodexRpcClient, CodexRpcFrame } from '@/shared/index.js';
import { AppError, findApplicationRoot, getModuleDirectory, isCodexGoalEnabled } from '@/shared/index.js';

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

// A rollout can be observed empty for a few milliseconds while Codex flushes
// its session metadata. Only these history-reading RPCs may repeat: neither
// submits a user turn, so a retry cannot duplicate a message or a command.
const EMPTY_ROLLOUT_RETRY_METHODS = new Set(['thread/read', 'thread/resume']);
const EMPTY_ROLLOUT_RETRY_DELAYS_MS = [50, 100] as const;
const EMPTY_ROLLOUT_MAX_ATTEMPTS = EMPTY_ROLLOUT_RETRY_DELAYS_MS.length + 1;
// The app-server wraps this thread-store failure as
// `failed to read thread: thread-store internal error: ...`; that exact wrapper
// is an optional prefix here, never an arbitrary one. Full anchoring keeps
// unrelated metadata failures fatal, both paths may contain spaces, and the
// captured pair must name the same rollout file.
const EMPTY_ROLLOUT_ERROR = /^(?:failed to read thread: thread-store internal error: )?failed to read session metadata (.+\.jsonl): rollout at (.+\.jsonl) is empty$/;

/**
 * True only for the transient "rollout ... is empty" rejection that Codex
 * returns while a session file is still being flushed. Consumed by
 * `CodexAppServerTransport.request` to repeat thread/read and thread/resume.
 */
function isEmptyRolloutMetadataError(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'CODEX_APP_SERVER_REJECTED') return false;
  const match = EMPTY_ROLLOUT_ERROR.exec(error.message);
  return Boolean(match) && match![1] === match![2];
}

/** Providers' runtime and fork adapter share this lazy, bidirectional stdio connection. */
export class CodexAppServerTransport implements CodexRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startedAt: number | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<string | number, PendingRequest>();
  private notifications = new Set<(frame: CodexRpcFrame) => void>();
  private requests = new Set<(frame: CodexRpcFrame) => Promise<unknown>>();
  private exits = new Set<(error: Error, appServerInstanceId?: string) => void>();
  private stderr = '';
  private closed = false;
  private stopping: Promise<void> | null = null;
  // Keep a timed-out SIGTERM target blocked until its exit is confirmed.
  private stopTarget: ChildProcessWithoutNullStreams | null = null;
  private launcherPath: string | null = null;
  private cliVersion: string | null = null;
  // Stable for one child generation, reserved before spawn so thread config can
  // name the instance it belongs to. Cleared when that child exits.
  private connectionInstanceId: string | null = null;

  constructor(private readonly options: {
    spawn?: () => ChildProcessWithoutNullStreams;
    timeoutMs?: number;
    stopTimeoutMs?: number;
  } = {}) {}

  onNotification(listener: (frame: CodexRpcFrame) => void) {
    this.notifications.add(listener);
    return () => { this.notifications.delete(listener); };
  }

  onRequest(listener: (frame: CodexRpcFrame) => Promise<unknown>) {
    this.requests.add(listener);
    return () => { this.requests.delete(listener); };
  }

  onExit(listener: (error: Error) => void) {
    this.exits.add(listener);
    return () => { this.exits.delete(listener); };
  }

  async request<T = Record<string, any>>(method: string, params?: unknown): Promise<T> {
    await this.ensureReady();
    const canRetry = EMPTY_ROLLOUT_RETRY_METHODS.has(method);
    // Bind the request to the connection it started on. A retry may only repeat
    // on that same child, so a replacement process can never receive a replayed
    // read/resume (not even before its own initialize completes).
    const boundChild = this.child;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.call(method, params) as T;
      } catch (error) {
        const retryable = canRetry && isEmptyRolloutMetadataError(error) && attempt < EMPTY_ROLLOUT_MAX_ATTEMPTS
          && this.isCurrentConnection(boundChild);
        if (!retryable || !await this.waitToRetry(boundChild!, EMPTY_ROLLOUT_RETRY_DELAYS_MS[attempt - 1])) throw error;
        // The timer fired on the live connection, but this continuation can run
        // after a later stop/exit and an explicit request already replaced the
        // process. Re-check here, immediately before the next send.
        if (!this.isCurrentConnection(boundChild)) throw error;
      }
    }
  }

  /** A retry target is usable only while it is still the current, live child. */
  private isCurrentConnection(child: ChildProcessWithoutNullStreams | null): boolean {
    return child !== null && this.child === child && !this.closed && !this.isStopping;
  }

  /**
   * Waits out one retry delay without spawning, resuming or re-initializing.
   * Resolves false when the bound child is no longer the live connection, so
   * the caller rethrows the original error instead of targeting a replacement.
   */
  private waitToRetry(child: ChildProcessWithoutNullStreams, delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.isCurrentConnection(child)) return resolve(false);
      const stopped = () => { child.off('exit', onStop); child.off('close', onStop); clearTimeout(timer); resolve(false); };
      const onStop = () => stopped();
      const timer = setTimeout(() => {
        child.off('exit', onStop); child.off('close', onStop);
        resolve(this.isCurrentConnection(child));
      }, delayMs);
      child.once('exit', onStop);
      child.once('close', onStop);
    });
  }

  get status() {
    // Before the first spawn, the bundled launcher identity is read lazily from
    // package metadata (never by spawning), so a mounted session can decide
    // whether predictions are supported without a handshake. A custom spawn has
    // no bundled identity and reports null until its real init echo arrives.
    if (!this.options.spawn && (!this.launcherPath || !this.cliVersion)) this.readBundledIdentity();
    return {
      running: this.child !== null,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      pendingRequests: this.pending.size,
      launcherPath: this.launcherPath,
      cliVersion: this.cliVersion,
    };
  }

  /**
   * Resolves the packaged launcher path and its package version without
   * starting a process. Missing metadata leaves both null; `start()` still
   * throws the AppError that the runtime relies on.
   */
  private readBundledIdentity(): void {
    try {
      const require = createRequire(import.meta.url);
      const launcher = require.resolve('@openai/codex/bin/codex.js');
      const version = (require('@openai/codex/package.json') as { version: string }).version;
      if (!this.launcherPath) this.launcherPath = launcher;
      if (!this.cliVersion) this.cliVersion = version;
    } catch {
      // Absent bundle stays unknown; only an actual send fails with the AppError.
    }
  }

  /** The router excludes native queues and sends until a SIGTERM target has actually exited. */
  get isStopping(): boolean {
    return Boolean(this.stopping || this.stopTarget);
  }

  /** The runtime reserves this before requesting thread config from the Worker bridge. */
  get instanceId(): string | null {
    return this.connectionInstanceId;
  }

  /** Reuses the reserved id so `prepareSession` and the spawned child name one generation. */
  ensureInstanceId(): string {
    return this.connectionInstanceId ??= randomUUID();
  }

  private ensureReady(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is shutting down.'));
    if (this.isStopping) return Promise.reject(new AppError('Codex app-server is stopping.', { code: 'CODEX_APP_SERVER_STOPPING', statusCode: 409 }));
    if (this.ready) return this.ready;
    const ready = this.start();
    this.ready = ready;
    void ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return ready;
  }

  private async start(): Promise<void> {
    this.ensureInstanceId();
    const require = createRequire(import.meta.url);
    let child: ChildProcessWithoutNullStreams;
    if (this.options.spawn) {
      child = this.options.spawn();
    } else {
      this.readBundledIdentity();
      if (!this.launcherPath || !this.cliVersion) {
        throw new AppError('The bundled Codex CLI is not installed.', { code: 'CODEX_APP_SERVER_UNAVAILABLE', statusCode: 503 });
      }
      const launcher = this.launcherPath;
      // This private connection owns every subscription. Release unsubscribed
      // threads promptly so SDK compatibility can resume their latest rollout.
      child = spawn(process.execPath, [launcher, 'app-server', '--listen', 'stdio://', '-c', 'thread_unload_delay_secs=0',
        '-c', `features.goals=${isCodexGoalEnabled()}`], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    this.child = child;
    this.startedAt = child.pid != null ? Date.now() : null;
    this.stderr = '';
    const reader = createInterface({ input: child.stdout });
    reader.on('line', (line) => {
      if (this.child !== child || !line.trim()) return;
      try {
        const frame = JSON.parse(line) as CodexRpcFrame;
        if (!frame || typeof frame !== 'object') return;
        this.receive(frame, child);
      } catch {
        // Ignore banners without treating stderr or non-JSON stdout as RPC replies.
      }
    });
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + String(chunk)).slice(-2000); });
    const fail = (error: Error, exited = false) => {
      if (this.child !== child) return;
      // Pipe errors during SIGTERM are not proof that the process has exited.
      if (this.stopTarget === child && !exited) return;
      reader.close();
      // A broken pipe does not prove the child has exited; release the process too.
      if (!exited && !child.killed) child.kill('SIGTERM');
      this.child = null;
      if (this.stopTarget === child) this.stopTarget = null;
      this.startedAt = null;
      this.ready = null;
      // Capture the generation before clearing it so exit consumers close only
      // the workers that belonged to this exact process.
      const instanceId = this.connectionInstanceId;
      this.connectionInstanceId = null;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      for (const listener of this.exits) listener(error, instanceId ?? undefined);
    };
    child.on('error', fail);
    child.on('exit', (code, signal) => fail(this.stopTarget === child
      ? new AppError('Codex app-server was stopped.', { code: 'CODEX_APP_SERVER_STOPPED', statusCode: 409 })
      : new Error(`Codex app-server exited (${code ?? signal}). ${this.stderr.trim().split('\n').at(-1) ?? ''}`), true));
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', () => {});
    try {
      const version = (require(path.join(findApplicationRoot(getModuleDirectory(import.meta.url)), 'package.json')) as { version: string }).version;
      const initialized = await this.call('initialize', {
        clientInfo: { name: 'cloudcli', title: 'CloudCLI', version },
        capabilities: { experimentalApi: true },
      }) as { userAgent?: string };
      // Prefer the running executable's identity over its npm package metadata.
      // The initialize echo is `<clientName>/<cliVersion> ...`, so the CLI
      // version is the first segment after that name; the prerelease suffix is
      // preserved so the runtime's protocol gate can tell a public stable build
      // apart from an internal/alpha identity.
      this.cliVersion = initialized?.userAgent?.match(/^[^/\s]+\/([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? this.cliVersion;
      await this.write({ method: 'initialized', params: {} }, child);
    } catch (error) {
      if (this.child === child && this.stopTarget !== child && !child.killed) child.kill('SIGTERM');
      throw error;
    }
  }

  private call(method: string, params?: unknown): Promise<unknown> {
    if (this.isStopping) return Promise.reject(new AppError('Codex app-server is stopping.', { code: 'CODEX_APP_SERVER_STOPPING', statusCode: 409 }));
    const child = this.child;
    if (!child) return Promise.reject(new Error('Codex app-server is disconnected.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      // A proxy may hold turn/start for minutes while it waits for a shared
      // concurrency slot and submit interval; acknowledge after that queue
      // instead of declaring the turn unknown at the ordinary RPC deadline.
      const timeoutMs = this.options.timeoutMs ?? (method === 'turn/start' ? 15 * 60_000 : 30_000);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(`Codex app-server did not confirm ${method}.`, {
          code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504, details: { method, resultUnknown: true },
        }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }, child).catch((error: Error) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private write(frame: unknown, child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.child !== child || child.stdin.destroyed) return reject(new Error('Codex app-server connection changed.'));
      // The stream callback observes backpressure and write failures without busy polling.
      child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  private receive(frame: CodexRpcFrame, child: ChildProcessWithoutNullStreams): void {
    if (frame.method) {
      if (frame.id !== undefined) {
        const handler = this.requests.values().next().value;
        void (handler ? handler(frame) : Promise.reject(new Error(`Unsupported request: ${frame.method}`)))
          .then((result) => this.write({ id: frame.id, result }, child))
          .catch((error: Error) => this.write({ id: frame.id, error: { code: -32603, message: error.message } }, child).catch(() => {}));
      } else {
        for (const listener of this.notifications) listener(frame);
      }
      return;
    }
    if (frame.id === undefined) return;
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error) {
      entry.reject(new AppError(frame.error.message, {
        code: 'CODEX_APP_SERVER_REJECTED', statusCode: 502, details: { rpcCode: frame.error.code },
      }));
    } else {
      entry.resolve(frame.result);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }

  /** The runtime router stops the managed PID without eagerly launching a replacement. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return;
    this.stopTarget = child;
    const stopping = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      const onExit = () => { cleanup(); resolve(); };
      const onError = (error: Error) => {
        cleanup();
        if (!child.killed && this.stopTarget === child) this.stopTarget = null;
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new AppError('Codex app-server has not exited after SIGTERM. Retry stopping it.', { code: 'CODEX_APP_SERVER_STOP_TIMEOUT', statusCode: 504 }));
      }, this.options.stopTimeoutMs ?? 5000);
      child.once('exit', onExit);
      child.once('error', onError);
      try {
        if (!child.kill('SIGTERM')) onError(new Error('Could not send SIGTERM to Codex app-server.'));
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.stopping = stopping;
    try { await stopping; }
    finally { if (this.stopping === stopping) this.stopping = null; }
  }
}

/** Shared by the Codex runtime and fork adapter; construction never starts a child. */
export const codexAppServerTransport = new CodexAppServerTransport();
