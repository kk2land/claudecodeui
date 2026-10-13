import { spawn } from 'node:child_process';
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

/** Providers' runtime and fork adapter share this lazy, bidirectional stdio connection. */
export class CodexAppServerTransport implements CodexRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startedAt: number | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<string | number, PendingRequest>();
  private notifications = new Set<(frame: CodexRpcFrame) => void>();
  private requests = new Set<(frame: CodexRpcFrame) => Promise<unknown>>();
  private exits = new Set<(error: Error) => void>();
  private stderr = '';
  private closed = false;
  private launcherPath: string | null = null;
  private cliVersion: string | null = null;

  constructor(private readonly options: {
    spawn?: () => ChildProcessWithoutNullStreams;
    timeoutMs?: number;
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
    return this.call(method, params) as Promise<T>;
  }

  get status() {
    return {
      running: this.child !== null,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      pendingRequests: this.pending.size,
      launcherPath: this.launcherPath,
      cliVersion: this.cliVersion,
    };
  }

  private ensureReady(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is shutting down.'));
    if (this.ready) return this.ready;
    const ready = this.start();
    this.ready = ready;
    void ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return ready;
  }

  private async start(): Promise<void> {
    const require = createRequire(import.meta.url);
    let child: ChildProcessWithoutNullStreams;
    if (this.options.spawn) {
      child = this.options.spawn();
    } else {
      let launcher: string;
      try {
        launcher = require.resolve('@openai/codex/bin/codex.js');
        this.launcherPath = launcher;
        this.cliVersion = (require('@openai/codex/package.json') as { version: string }).version;
      } catch {
        throw new AppError('The bundled Codex CLI is not installed.', { code: 'CODEX_APP_SERVER_UNAVAILABLE', statusCode: 503 });
      }
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
    const fail = (error: Error) => {
      if (this.child !== child) return;
      reader.close();
      // A broken pipe does not prove the child has exited; release the process too.
      if (!child.killed) child.kill('SIGTERM');
      this.child = null;
      this.startedAt = null;
      this.ready = null;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      for (const listener of this.exits) listener(error);
    };
    child.on('error', fail);
    child.on('exit', (code, signal) => fail(new Error(`Codex app-server exited (${code ?? signal}). ${this.stderr.trim().split('\n').at(-1) ?? ''}`)));
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
      this.cliVersion = initialized?.userAgent?.match(/codex[^/]*\/v?(\d+\.\d+\.\d+)/)?.[1] ?? this.cliVersion;
      await this.write({ method: 'initialized', params: {} }, child);
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    }
  }

  private call(method: string, params?: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Codex app-server is disconnected.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(`Codex app-server did not confirm ${method}.`, {
          code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504, details: { method, resultUnknown: true },
        }));
      }, this.options.timeoutMs ?? 30_000);
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

  async restart(): Promise<void> {
    if (this.pending.size) throw new AppError('Codex app-server is busy.', { code: 'CODEX_APP_SERVER_BUSY', statusCode: 409 });
    await this.close();
    this.closed = false;
    await this.ensureReady();
  }
}

/** Shared by the Codex runtime and fork adapter; construction never starts a child. */
export const codexAppServerTransport = new CodexAppServerTransport();
