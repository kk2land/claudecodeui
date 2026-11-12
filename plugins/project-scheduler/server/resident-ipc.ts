import type {
  ResidentError,
  ResidentIpcAction,
  ResidentIpcEvent,
  ResidentIpcRequest,
  ResidentIpcRequestPayloads,
  ResidentIpcResponse,
  ResidentIpcResponseValues,
} from "../shared/contracts.js";

/** Failure codes surfaced to HTTP; `host_unavailable`/`timeout` mean the host never answered. */
export type ResidentHostErrorCode =
  | ResidentError["code"]
  | "host_unavailable"
  | "timeout";

/** Typed resident failure. Messages are host-provided and never contain credentials. */
export class ResidentHostError extends Error {
  constructor(
    readonly code: ResidentHostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResidentHostError";
  }
}

/** The process IPC channel the plugin uses; injectable so tests need no subprocess. */
export type ResidentHostTransport = {
  send(message: ResidentIpcRequest): boolean;
  subscribe(listener: (message: unknown) => void): () => void;
};

const CHANNEL = "cloudcli-scheduler-resident";
const EVENT_NAMES = new Set(["sync", "terminal", "changed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Single boundary check for everything arriving from the host. Validates the envelope and the
 * discriminating fields each variant needs; values are host-authoritative and typed downstream.
 * Returns null for unrelated or malformed messages instead of throwing.
 */
export function parseResidentMessage(
  raw: unknown,
): ResidentIpcResponse | ResidentIpcEvent | null {
  if (!isRecord(raw) || raw.channel !== CHANNEL) return null;
  if (raw.kind === "response") {
    if (typeof raw.id !== "string" || typeof raw.ok !== "boolean") return null;
    if (!raw.ok) {
      const error = raw.error;
      if (!isRecord(error) || typeof error.code !== "string") return null;
      return raw as ResidentIpcResponse;
    }
    return raw as ResidentIpcResponse;
  }
  if (raw.kind !== "event" || typeof raw.event !== "string") return null;
  if (!EVENT_NAMES.has(raw.event)) return null;
  const value = raw.value;
  if (!isRecord(value)) return null;
  if (raw.event === "sync" && !Array.isArray(value.bindings)) return null;
  if (raw.event === "changed" && !Array.isArray(value.taskIds)) return null;
  if (
    raw.event === "terminal" &&
    (typeof value.id !== "string" || typeof value.taskId !== "string")
  )
    return null;
  return raw as ResidentIpcEvent;
}

/**
 * Requests/responses over the plugin↔host IPC channel. Used by `ResidentTasks`: the plugin is
 * always the requester and the host always the authoritative responder, so a pending entry is
 * settled by the echoed request id. The host may be gone at any time; callers get
 * `host_unavailable`/`timeout` rather than a simulated success.
 */
export class ResidentHost {
  private nextId = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: ResidentIpcResponseValues[ResidentIpcAction]) => void;
      reject: (error: ResidentHostError) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly listeners = new Set<(event: ResidentIpcEvent) => void>();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly transport: ResidentHostTransport,
    private readonly timeoutMs = 20000,
  ) {
    this.unsubscribe = transport.subscribe((message) => this.receive(message));
  }
  request<Action extends ResidentIpcAction>(
    action: Action,
    payload: ResidentIpcRequestPayloads[Action],
  ): Promise<ResidentIpcResponseValues[Action]> {
    const id = String(++this.nextId);
    return new Promise<ResidentIpcResponseValues[Action]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ResidentHostError("timeout", "宿主常驻任务通道超时"));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (
          value: ResidentIpcResponseValues[ResidentIpcAction],
        ) => void,
        reject,
        timer,
      });
      const message = {
        channel: CHANNEL,
        id,
        kind: "request",
        action,
        payload,
      } as ResidentIpcRequest;
      if (this.transport.send(message)) return;
      clearTimeout(timer);
      this.pending.delete(id);
      reject(
        new ResidentHostError(
          "host_unavailable",
          "宿主常驻任务通道不可用，请确认宿主正在运行",
        ),
      );
    });
  }
  /** Subscribes to host lifecycle events; returns an unsubscribe function. */
  onEvent(listener: (event: ResidentIpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.unsubscribe();
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new ResidentHostError("host_unavailable", "插件正在停止"));
      this.pending.delete(id);
    }
  }
  private receive(raw: unknown): void {
    const message = parseResidentMessage(raw);
    if (!message) return;
    if (message.kind === "event") {
      for (const listener of this.listeners) {
        try {
          listener(message);
        } catch (error) {
          console.error("[Resident]", String(error));
        }
      }
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.value);
    else
      entry.reject(new ResidentHostError(message.error.code, message.error.message));
  }
}

/** Real host channel: the plugin subprocess IPC provided by the host plugin runner. */
export function processResidentTransport(): ResidentHostTransport {
  const listeners = new Set<(message: unknown) => void>();
  let attached = false;
  return {
    send(message) {
      if (!process.connected) return false;
      try {
        process.send?.(message);
        return true;
      } catch {
        return false;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!attached) {
        attached = true;
        process.on("message", (message: unknown) => {
          for (const current of listeners) current(message);
        });
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
