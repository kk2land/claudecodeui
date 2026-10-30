import { randomUUID } from 'node:crypto';

import type {
  WorkerIpcAction,
  WorkerIpcEvent,
  WorkerIpcRequest,
  WorkerIpcRequestPayloads,
  WorkerIpcResponse,
  WorkerIpcResponseValues,
  WorkerIpcTransport,
} from '@/shared/index.js';
import { AppError } from '@/shared/index.js';

type Pending = {
  resolve(value: WorkerIpcResponseValues[WorkerIpcAction]): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Request/response and event client for the fixed `cloudcli-workers` IPC
 * channel. A disconnect fails every in-flight request instead of replaying it:
 * the host cannot know whether the plugin admitted a request before it died.
 */
export class WorkerIpcClient {
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<(event: WorkerIpcEvent) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private disposed = false;

  constructor(
    private readonly transport: WorkerIpcTransport,
    private readonly timeoutMs = 10_000,
  ) {
    this.unsubscribe.push(
      transport.onMessage((message) => this.receive(message)),
      transport.onExit(() => this.disconnect()),
    );
  }

  /** Coalesces plugin startup; used before owner registration, never by the MCP proxy. */
  ensureReady(): Promise<boolean> {
    return this.transport.ensureReady();
  }

  isReady(): boolean {
    return this.transport.isRunning();
  }

  onEvent(listener: (event: WorkerIpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  onReady(listener: () => void): () => void {
    return this.transport.onReady(listener);
  }

  async request<Action extends WorkerIpcAction>(
    action: Action,
    payload: WorkerIpcRequestPayloads[Action],
  ): Promise<WorkerIpcResponseValues[Action]> {
    if (this.disposed) throw new AppError('The Worker plugin is not available.', { code: 'WORKER_PLUGIN_UNAVAILABLE', statusCode: 503 });
    if (!this.transport.isRunning()) throw new AppError('The Worker plugin is not running.', { code: 'WORKER_PLUGIN_UNAVAILABLE', statusCode: 503 });
    const id = randomUUID();
    const message = { channel: 'cloudcli-workers', id, kind: 'request', action, payload } as WorkerIpcRequest;
    const response = new Promise<WorkerIpcResponseValues[Action]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(`The Worker plugin did not answer ${action}.`, {
          code: 'WORKER_PLUGIN_TIMEOUT', statusCode: 504, details: { resultUnknown: true },
        }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer });
    });
    if (!this.transport.send(message)) {
      this.rejectPending(id, new AppError('The Worker plugin is not running.', { code: 'WORKER_PLUGIN_UNAVAILABLE', statusCode: 503 }));
    }
    return response;
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe.length = 0;
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const frame = message as WorkerIpcResponse | WorkerIpcEvent;
    if (frame.channel !== 'cloudcli-workers') return;
    if (frame.kind === 'event') {
      for (const listener of this.eventListeners) listener(frame);
      return;
    }
    if (frame.kind !== 'response' || typeof frame.id !== 'string') return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) pending.resolve(frame.value);
    else pending.reject(new AppError(frame.error.message, {
      code: frame.error.code, statusCode: 502, details: { workerIpc: true },
    }));
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private disconnect(): void {
    for (const id of [...this.pending.keys()]) {
      this.rejectPending(id, new AppError('The Worker plugin disconnected before answering.', {
        code: 'WORKER_PLUGIN_DISCONNECTED', statusCode: 503, details: { resultUnknown: true },
      }));
    }
    for (const listener of this.disconnectListeners) listener();
  }
}
