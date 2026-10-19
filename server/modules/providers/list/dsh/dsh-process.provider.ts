import { StringDecoder } from 'node:string_decoder';
import type { ChildProcess } from 'node:child_process';

import spawn from 'cross-spawn';

import type { AnyRecord, DshConfiguration } from '@/shared/types.js';

type PendingRequest = { resolve(value: AnyRecord): void; reject(error: Error): void; timer?: NodeJS.Timeout };

/** DSH-owned stdio transport shared by its ACP and headless runtime paths. */
export class DshProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  onFrame: (frame: AnyRecord) => void = () => {};
  onRequest: (method: string, params: AnyRecord) => Promise<unknown> = async () => { throw new Error('Unsupported ACP client request.'); };
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private failure?: Error;
  private ended = false;
  private closing?: Promise<void>;
  private stderr = '';

  constructor(config: DshConfiguration, cwd: string, args: string[]) {
    this.child = spawn(config.bin, args, { cwd, env: config.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise((resolve) => {
      this.child.once('error', (error) => { this.fail(error); });
      this.child.once('close', (code) => {
        const tail = this.buffer + this.decoder.end();
        if (tail.trim()) this.parse(tail);
        this.ended = true;
        this.fail(new Error(`DSH exited (${code ?? 'signal'}).${this.stderr ? ` ${this.stderr}` : ''}`));
        resolve(code);
      });
    });
    this.child.stdin?.on('error', (error) => this.fail(error));
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      if (this.buffer.length > 32 * 1024 * 1024) {
        this.fail(new Error('DSH stdout frame exceeded 32 MiB.'));
        this.child.kill('SIGTERM');
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (line.trim()) this.parse(line);
      }
    });
    this.child.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8192); });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear();
  }

  private parse(line: string): void {
    try {
      const frame = JSON.parse(line) as AnyRecord;
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Expected a JSON object.');
      if (typeof frame.method === 'string' && frame.id !== undefined) {
        void this.onRequest(frame.method, frame.params ?? {}).then(
          (result) => this.write({ jsonrpc: '2.0', id: frame.id, result }),
          (error: unknown) => this.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: error instanceof Error ? error.message : 'Unsupported request' } }),
        ).catch(() => {});
      } else if (frame.id !== undefined) {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.error) pending.reject(new Error(`DSH ${frame.error.code}: ${frame.error.message}`));
        else pending.resolve(frame.result ?? {});
      } else this.onFrame(frame);
    } catch (error) {
      this.fail(new Error(`Invalid DSH stdout: ${error instanceof Error ? error.message : 'invalid frame'}`));
      this.child.kill('SIGTERM');
    }
  }

  private write(frame: AnyRecord): void {
    if (this.failure || this.ended || !this.child.stdin?.writable) throw this.failure ?? new Error('DSH transport is closed.');
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<AnyRecord> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs > 0) pending.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH ${method} timed out; delivery may be unknown.`));
      }, timeoutMs);
      this.pending.set(id, pending);
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) {
        this.pending.delete(id); clearTimeout(pending.timer); reject(error);
      }
    });
  }

  notify(method: string, params: unknown): void { this.write({ jsonrpc: '2.0', method, params }); }

  get errorTail(): string { return this.stderr; }
  get isClosed(): boolean { return this.ended || Boolean(this.failure); }

  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.ended) return;
      this.child.stdin?.end();
      const term = setTimeout(() => this.child.kill('SIGTERM'), 1500);
      const kill = setTimeout(() => this.child.kill('SIGKILL'), 4000);
      try { await this.exited; } finally { clearTimeout(term); clearTimeout(kill); }
    })();
    return this.closing;
  }
}
