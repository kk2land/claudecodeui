import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  AcpConfigOptionRequest,
  AcpConfigOptionSnapshot,
  AcpInitializeResult,
  AcpProcessSpec,
  AcpTransportFailure,
  AcpTurnResult,
} from "./shared/index.js";

/** Setup RPCs are bounded even when the run itself has no hard timeout. */
export const ACP_SETUP_TIMEOUT_MS = 30_000;

export type {
  AcpConfigOptionRequest,
  AcpConfigOptionSnapshot,
  AcpInitializeResult,
  AcpProcessSpec,
  AcpTransportFailure,
  AcpTurnResult,
};

/**
 * Shared, engine-agnostic stdio JSON-RPC 2.0 ACP communication layer.
 *
 * Architecture:
 * - `AcpClient`: low-level NDJSON JSON-RPC 2.0 transport over one `ChildProcess` stdio pair.
 *   Validates every inbound line once at the boundary, multiplexes concurrent RPCs by `id`,
 *   routes `session/update` notifications strictly by `sessionId`, and atomically fails every
 *   pending waiter on process exit or transport failure with zero cross-talk.
 * - `AcpConnection`: owns one initialized ACP child process (`initialize` runs once) and
 *   multiplexes any number of concurrent `AcpSessionHandle` instances (`session/new` /
 *   `session/resume` / `session/set_config_option` / `session/prompt` / `session/cancel` /
 *   `session/close`), where `session.close()` closes only that session without tearing down
 *   the shared process or affecting sibling sessions.
 * - `LazyAcpProcess`: thin on-demand slot that spawns & initializes an `AcpConnection` only
 *   when first acquired, deduplicates concurrent first callers, and reaps any broken prior
 *   process group before allowing a fresh launch—without prescribing Pi/AGY slot partitioning.
 */

export type AcpEvent =
  | {
      protocol: "acp";
      type: "acp_initialized";
      protocolVersion: number;
      agentInfo: Record<string, unknown> | null;
      agentCapabilities: Record<string, unknown> | null;
    }
  | {
      protocol: "acp";
      type: "acp_session";
      action: "new" | "resume";
      sessionId: string;
      cwd: string;
      configOptions: AcpConfigOptionSnapshot[];
      startupInfo: string | null;
    }
  | {
      protocol: "acp";
      type: "acp_config";
      configId: string;
      requestedValue: string;
      appliedValue: string | null;
      match: "exact" | "model";
    }
  | {
      protocol: "acp";
      type: "acp_update";
      sessionId: string;
      update: Record<string, unknown>;
    }
  | {
      protocol: "acp";
      type: "acp_prompt_result";
      sessionId: string;
      stopReason: string | null;
      result: Record<string, unknown>;
    }
  | {
      protocol: "acp";
      type: "acp_closed";
      sessionId: string;
    }
  | {
      protocol: "acp";
      type: "acp_error";
      stage: string;
      code: number | string | null;
      message: string;
      data?: unknown;
    };

export type AcpProgressTracker = {
  steps: number;
  phase: string | null;
  currentTool: string | null;
  active: Map<string, string | null>;
};

export type AcpParsedStream = {
  success: boolean;
  action: "new" | "resume" | null;
  sessionId: string | null;
  validatedSessionId: string | null;
  cwd: string | null;
  identityMismatch: boolean;
  stopReason: string | null;
  startupInfo: string | null;
  error: string | null;
  errorCode: string | null;
};

export type ParseAcpEventsOptions = {
  /**
   * Expected session action (`"new"` or `"resume"`). Decoupled from `expectedSessionId` so
   * handle-less post-restart recovery of a brand-new session whose `sessionId` was already
   * persisted does not falsely reject `action: "new"` as an invalid `"resume"`.
   */
  expectedAction?: "new" | "resume" | null;
};

export type AcpOpenSessionInput = {
  cwd: string;
  /** `null` creates a new session (`session/new`); non-null resumes (`session/resume`). */
  sessionId: string | null;
  configOptions?: AcpConfigOptionRequest[];
  /** Per-session event sink receiving ONLY events belonging to this session. */
  onEvent?: (event: AcpEvent) => void;
  /** Optional RPC timeout for `session/new`, `session/resume`, and `session/set_config_option`. */
  timeoutMs?: number;
  /** Optional predicate checked after session open and before each config RPC; returning true closes only this session and skips remaining config RPCs. */
  shouldAbort?: () => boolean;
};

export type AcpSessionHandle = {
  readonly action: "new" | "resume";
  readonly sessionId: string;
  readonly cwd: string;
  readonly startupInfo: string | null;
  readonly configOptions: readonly AcpConfigOptionSnapshot[];
  readonly closed: boolean;
  setConfigOption(
    option: AcpConfigOptionRequest,
    timeoutMs?: number,
  ): Promise<readonly AcpConfigOptionSnapshot[]>;
  prompt(
    prompt: string,
    options?: {
      timeoutMs?: number;
      onUpdate?: (update: Record<string, unknown>) => void;
    },
  ): Promise<AcpTurnResult>;
  /** Sends `session/cancel` ONLY for this sessionId without affecting sibling sessions or the process. */
  cancel(options?: { graceMs?: number }): Promise<void>;
  /** Sends `session/close` ONLY for this sessionId and detaches its listeners; keeps the shared process alive. */
  close(options?: { timeoutMs?: number }): Promise<void>;
};

//----------------- ERRORS ----------------

export class AcpRpcError extends Error {
  constructor(
    readonly rpcCode: number | string | null,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

export class AcpConfigError extends Error {
  readonly errorCode = "ACP_CONFIG_UNSUPPORTED";
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpConfigError";
  }
}

export class AcpProtocolError extends Error {
  readonly errorCode = "PROTOCOL_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

export class AcpTransportError extends Error {
  readonly errorCode = "ACP_TRANSPORT_CLOSED";
  constructor(readonly failure: AcpTransportFailure) {
    super(failure.message);
    this.name = "AcpTransportError";
  }
}

//----------------- SINGLE-PASS EXTERNAL BOUNDARY PARSERS ----------------

type ParsedRpcError = {
  code: number | string | null;
  message: string;
  data?: unknown;
};

type InboundRpcMessage =
  | { kind: "invalid"; message: string }
  | { kind: "request"; id: string | number; method: string; params: unknown }
  | { kind: "response_ok"; id: number; result: unknown }
  | { kind: "response_error"; id: number; error: ParsedRpcError }
  | { kind: "notification"; method: string; params: unknown };

type ParsedSessionUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
};

type OpenedSessionData = {
  sessionId: string;
  configOptions: AcpConfigOptionSnapshot[];
  startupInfo: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function samePath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

/** Formats a raw JSON-RPC error object once into a human-readable diagnostic string. */
export function formatAcpRpcError(error: {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}): string {
  const message = nonEmptyString(error.message) ?? "ACP JSON-RPC 错误";
  const data = error.data;
  if (typeof data === "string" && data.trim()) {
    return data.includes(message) ? data.trim() : `${message}: ${data.trim()}`;
  }
  const record = asRecord(data);
  if (record) {
    const details = nonEmptyString(record.details) ?? nonEmptyString(record.message);
    if (details) return details.includes(message) ? details : `${message}: ${details}`;
  }
  return message;
}

/** Parses and validates one raw NDJSON line from child stdout exactly once. */
function parseInboundMessage(raw: string): InboundRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", message: "ACP 输出包含无效 JSON 行" };
  }
  const message = asRecord(parsed);
  if (!message) {
    return { kind: "invalid", message: "ACP 输出不是 JSON 对象" };
  }
  const rawId = message.id;
  const hasId = typeof rawId === "number" || typeof rawId === "string";
  const method = typeof message.method === "string" && message.method ? message.method : null;

  if (hasId && method) {
    return { kind: "request", id: rawId, method, params: message.params };
  }
  if (hasId && !method) {
    const numericId = typeof rawId === "number" ? rawId : Number(rawId);
    if (!Number.isSafeInteger(numericId)) {
      return { kind: "invalid", message: "ACP 响应包含无效 id" };
    }
    if (message.error !== undefined) {
      const rpcErr = asRecord(message.error) ?? { message: String(message.error) };
      const code =
        typeof rpcErr.code === "number" || typeof rpcErr.code === "string"
          ? rpcErr.code
          : null;
      return {
        kind: "response_error",
        id: numericId,
        error: {
          code,
          message: formatAcpRpcError(rpcErr),
          ...(rpcErr.data !== undefined ? { data: rpcErr.data } : {}),
        },
      };
    }
    return { kind: "response_ok", id: numericId, result: message.result };
  }
  if (method) {
    return { kind: "notification", method, params: message.params };
  }
  return { kind: "invalid", message: "ACP 消息缺少有效的 id 或 method" };
}

/** Validates one `session/update` notification payload once before routing by `sessionId`. */
function parseSessionUpdateNotification(params: unknown): ParsedSessionUpdate | null {
  const record = asRecord(params);
  if (!record) return null;
  const sessionId = nonEmptyString(record.sessionId);
  const update = asRecord(record.update);
  if (!sessionId || !update || typeof update.sessionUpdate !== "string") return null;
  return { sessionId, update };
}

/** Validates `initialize` RPC result once into a strongly typed `AcpInitializeResult`. */
function parseInitializeResponse(raw: unknown): AcpInitializeResult {
  const record = asRecord(raw);
  if (!record || typeof record.protocolVersion !== "number") {
    throw new AcpProtocolError("ACP initialize 响应缺少有效 protocolVersion");
  }
  const agentInfo = asRecord(record.agentInfo);
  const agentCapabilities = asRecord(record.agentCapabilities);
  const sessionCaps =
    (agentCapabilities ? asRecord(agentCapabilities.sessionCapabilities) : null) ??
    (agentCapabilities ? asRecord(agentCapabilities.session_capabilities) : null);
  return {
    protocolVersion: record.protocolVersion,
    agentInfo,
    agentCapabilities,
    supportsResume: Boolean(
      sessionCaps && sessionCaps.resume !== undefined && sessionCaps.resume !== false,
    ),
    supportsClose: Boolean(
      sessionCaps && sessionCaps.close !== undefined && sessionCaps.close !== false,
    ),
  };
}

/** Validates raw `configOptions` array once into typed snapshots. */
function parseConfigOptions(raw: unknown): AcpConfigOptionSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const snapshots: AcpConfigOptionSnapshot[] = [];
  for (const item of raw) {
    const option = asRecord(item);
    const id = option ? nonEmptyString(option.id) : null;
    if (!option || !id) continue;
    snapshots.push({
      id,
      category: nonEmptyString(option.category),
      currentValue: nonEmptyString(option.currentValue),
    });
  }
  return snapshots;
}

/** Validates `session/new` or `session/resume` response once. */
function parseSessionResponse(
  raw: unknown,
  expectedSessionId: string | null,
): OpenedSessionData {
  const record = asRecord(raw);
  if (!record) {
    throw new AcpProtocolError(
      expectedSessionId === null
        ? "ACP session/new 响应无效"
        : "ACP session/resume 响应无效",
    );
  }
  let sessionId: string;
  if (expectedSessionId === null) {
    const createdId = nonEmptyString(record.sessionId);
    if (!createdId || path.basename(createdId) !== createdId) {
      throw new AcpProtocolError("ACP session/new 响应缺少有效 sessionId");
    }
    sessionId = createdId;
  } else {
    const returnedId = nonEmptyString(record.sessionId);
    if (returnedId && returnedId !== expectedSessionId) {
      throw new AcpProtocolError(`ACP session/resume 返回了不同会话 ID: ${returnedId}`);
    }
    sessionId = expectedSessionId;
  }
  const meta = asRecord(record._meta);
  const piAcp = meta ? asRecord(meta.piAcp) : null;
  const startupInfo =
    piAcp && typeof piAcp.startupInfo === "string" ? piAcp.startupInfo : null;
  return {
    sessionId,
    configOptions: parseConfigOptions(record.configOptions),
    startupInfo,
  };
}

/** Validates `session/set_config_option` response once. */
function parseSetConfigResponse(raw: unknown, configId: string): AcpConfigOptionSnapshot[] {
  const record = asRecord(raw);
  if (!record) {
    throw new AcpProtocolError(`ACP session/set_config_option(${configId}) 响应无效`);
  }
  return parseConfigOptions(record.configOptions);
}

/** Validates `session/prompt` response once. */
function parsePromptResponse(raw: unknown): {
  stopReason: string | null;
  result: Record<string, unknown>;
} {
  const record = asRecord(raw);
  if (!record) {
    throw new AcpProtocolError("ACP session/prompt 响应无效");
  }
  return {
    stopReason: typeof record.stopReason === "string" ? record.stopReason : null,
    result: record,
  };
}

function findAppliedConfigValue(
  options: readonly AcpConfigOptionSnapshot[],
  configId: string,
): string | null {
  const found = options.find(
    (option) => option.id === configId || option.category === configId,
  );
  return found?.currentValue ?? null;
}

/**
 * Verifies whether an ACP `configOptions` applied value satisfies the requested value without
 * allowing silent clamping or downgrade.
 */
export function configOptionMatches(
  applied: string | null,
  requested: string,
  match: "exact" | "model" = "exact",
): boolean {
  if (!applied) return false;
  if (applied === requested) return true;
  if (match === "model" && !requested.includes("/")) {
    return applied.endsWith("/" + requested);
  }
  return false;
}

//----------------- MULTIPLEXED STDIO TRANSPORT ----------------

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Runs synchronously inside stdout parsing before subsequent lines in the same chunk. */
  onResultSync?: (result: unknown) => void;
  timer?: NodeJS.Timeout;
};

/**
 * Multiplexed NDJSON stdio JSON-RPC 2.0 client bound to one ACP child process.
 * Supports concurrent RPCs, per-session `session/update` routing by `sessionId`, and
 * atomic failure fan-out when the process exits or transport breaks.
 */
export class AcpClient {
  private nextId = 1;
  private remainder = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessionUpdateListeners = new Map<
    string,
    (update: Record<string, unknown>) => void
  >();
  private readonly failureListeners = new Set<(failure: AcpTransportFailure) => void>();
  private transportFailure: AcpTransportFailure | null = null;
  private stdoutEndTimer: NodeJS.Timeout | null = null;
  private inputEnded = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly hooks: {
      onTransportFailure?: (failure: AcpTransportFailure) => void;
    } = {},
  ) {
    child.stdin?.on("error", () => {
      /* EOF or EPIPE during shutdown is handled by process exit / close */
    });
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stdout?.on("end", () => this.onStdoutEnd());
    child.once("exit", (code, signal) => {
      if (this.stdoutEndTimer) {
        clearTimeout(this.stdoutEndTimer);
        this.stdoutEndTimer = null;
      }
      this.tripFailure({
        kind: "exit",
        message: `ACP 进程已退出 (code=${String(code)}, signal=${String(signal)})`,
        exitCode: code,
        signal,
      });
    });
    child.once("error", (error) => {
      if (this.stdoutEndTimer) {
        clearTimeout(this.stdoutEndTimer);
        this.stdoutEndTimer = null;
      }
      this.tripFailure({
        kind: "spawn_error",
        message: error.message || "ACP 进程启动失败",
        exitCode: null,
        signal: null,
      });
    });
  }

  get alive(): boolean {
    return (
      this.transportFailure === null &&
      !this.inputEnded &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  get failure(): AcpTransportFailure | null {
    return this.transportFailure;
  }

  /** Registers a per-session `session/update` listener routed strictly by `sessionId`. */
  subscribeSession(
    sessionId: string,
    listener: (update: Record<string, unknown>) => void,
  ): () => void {
    this.sessionUpdateListeners.set(sessionId, listener);
    return () => {
      if (this.sessionUpdateListeners.get(sessionId) === listener) {
        this.sessionUpdateListeners.delete(sessionId);
      }
    };
  }

  /** Subscribes to terminal transport failure/exit; invokes immediately if already failed. */
  onFailure(listener: (failure: AcpTransportFailure) => void): () => void {
    if (this.transportFailure) {
      listener(this.transportFailure);
      return () => {};
    }
    this.failureListeners.add(listener);
    return () => {
      this.failureListeners.delete(listener);
    };
  }

  private onData(chunk: Buffer): void {
    this.remainder += this.decoder.write(chunk);
    const lines = this.remainder.split("\n");
    this.remainder = lines.pop() ?? "";
    for (const line of lines) this.handleLine(line);
  }

  private onStdoutEnd(): void {
    this.remainder += this.decoder.end();
    if (this.remainder.trim()) {
      const trailing = this.remainder;
      this.remainder = "";
      this.handleLine(trailing);
    }
    if (this.transportFailure !== null) return;
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.tripFailure({
        kind: "exit",
        message: `ACP 进程已退出 (code=${String(this.child.exitCode)}, signal=${String(this.child.signalCode)})`,
        exitCode: this.child.exitCode,
        signal: this.child.signalCode,
      });
      return;
    }
    // Give Node a brief window to deliver the paired `exit` event with real exitCode/signal
    // before falling back to `stdout_closed` if the child stays alive with stdout closed.
    this.stdoutEndTimer = setTimeout(() => {
      this.stdoutEndTimer = null;
      this.tripFailure({
        kind: "stdout_closed",
        message: "ACP stdout 已关闭",
        exitCode: this.child.exitCode,
        signal: this.child.signalCode,
      });
    }, 20);
  }

  private handleLine(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const inbound = parseInboundMessage(trimmed);
    switch (inbound.kind) {
      case "invalid": {
        this.tripFailure({
          kind: "protocol_error",
          message: inbound.message,
          exitCode: this.child.exitCode,
          signal: this.child.signalCode,
        });
        return;
      }
      case "request": {
        // Reject unexpected server->client requests so the shared agent never deadlocks.
        this.write({
          jsonrpc: "2.0",
          id: inbound.id,
          error: {
            code: -32601,
            message: `Unsupported client method: ${inbound.method}`,
          },
        });
        return;
      }
      case "response_ok": {
        const entry = this.pending.get(inbound.id);
        if (!entry) return;
        this.pending.delete(inbound.id);
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.onResultSync) {
          try {
            entry.onResultSync(inbound.result);
          } catch (error) {
            entry.reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
        entry.resolve(inbound.result);
        return;
      }
      case "response_error": {
        const entry = this.pending.get(inbound.id);
        if (!entry) return;
        this.pending.delete(inbound.id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(
          new AcpRpcError(inbound.error.code, inbound.error.message, inbound.error.data),
        );
        return;
      }
      case "notification": {
        if (inbound.method === "session/update") {
          const parsed = parseSessionUpdateNotification(inbound.params);
          if (parsed) {
            // Route strictly to the matching sessionId; unknown/unregistered sessions are dropped.
            this.sessionUpdateListeners.get(parsed.sessionId)?.(parsed.update);
          }
        }
      }
    }
  }

  private write(payload: unknown): void {
    if (
      this.inputEnded ||
      this.transportFailure !== null ||
      !this.child.stdin ||
      this.child.stdin.destroyed
    ) {
      return;
    }
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n", "utf8");
    } catch {
      /* broken pipe triggers exit/close failure path */
    }
  }

  request(
    method: string,
    params: unknown,
    options?: number | { timeoutMs?: number; onResultSync?: (result: unknown) => void },
  ): Promise<unknown> {
    if (this.transportFailure) {
      return Promise.reject(new AcpTransportError(this.transportFailure));
    }
    if (this.inputEnded) {
      return Promise.reject(
        new AcpTransportError({
          kind: "shutdown",
          message: `ACP 连接已关闭，无法发送 ${method}`,
          exitCode: this.child.exitCode,
          signal: this.child.signalCode,
        }),
      );
    }
    const timeoutMs = typeof options === "number" ? options : options?.timeoutMs;
    const onResultSync = typeof options === "number" ? undefined : options?.onResultSync;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { method, resolve, reject, onResultSync };
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpProtocolError(`ACP 请求超时 (${method}, ${timeoutMs}ms)`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.inputEnded || this.transportFailure !== null) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  endInput(): void {
    this.inputEnded = true;
    try {
      this.child.stdin?.end();
    } catch {
      /* already ended */
    }
  }

  abortAll(reason: string): void {
    this.inputEnded = true;
    this.tripFailure({
      kind: "shutdown",
      message: reason,
      exitCode: this.child.exitCode,
      signal: this.child.signalCode,
    });
    try {
      this.child.stdin?.end();
    } catch {
      /* already ended */
    }
  }

  private tripFailure(failure: AcpTransportFailure): void {
    if (this.transportFailure !== null) return;
    if (this.stdoutEndTimer) {
      clearTimeout(this.stdoutEndTimer);
      this.stdoutEndTimer = null;
    }
    this.transportFailure = failure;
    const error = new AcpTransportError(failure);
    for (const [id, entry] of [...this.pending.entries()]) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.sessionUpdateListeners.clear();
    this.hooks.onTransportFailure?.(failure);
    for (const listener of [...this.failureListeners]) {
      this.failureListeners.delete(listener);
      listener(failure);
    }
  }
}

//----------------- SHARED INITIALIZED CONNECTION ----------------

type InternalSessionState = {
  readonly action: "new" | "resume";
  readonly sessionId: string;
  readonly cwd: string;
  readonly startupInfo: string | null;
  configOptions: AcpConfigOptionSnapshot[];
  readonly onEvent?: (event: AcpEvent) => void;
  unsubscribeUpdates: () => void;
  activePrompt: Promise<AcpTurnResult> | null;
  activeUpdateHook: ((update: Record<string, unknown>) => void) | null;
  closePromise: Promise<void> | null;
  closed: boolean;
  errorEmitted: boolean;
};

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function childOrGroupAlive(child: ChildProcess, detached: boolean): boolean {
  const pid = child.pid;
  if (!pid) return false;
  if (detached && process.platform !== "win32") return groupAlive(pid);
  return child.exitCode === null && child.signalCode === null;
}

function signalChildGroup(child: ChildProcess, detached: boolean, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (detached && process.platform !== "win32") process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    /* already exited */
  }
}

/** Bounded child/process-group reaper: optional stdin-EOF grace, then SIGTERM -> SIGKILL. */
async function reapChildGroup(
  child: ChildProcess,
  detached: boolean,
  options: { graceMs?: number; termMs?: number; killMs?: number } = {},
): Promise<boolean> {
  const graceMs = options.graceMs ?? 300;
  const termMs = options.termMs ?? 1500;
  const killMs = options.killMs ?? 2000;
  try {
    child.stdin?.end();
  } catch {
    /* already ended */
  }
  const waitUntilGone = async (timeoutMs: number): Promise<boolean> => {
    if (!childOrGroupAlive(child, detached)) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!childOrGroupAlive(child, detached)) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return !childOrGroupAlive(child, detached);
  };
  if (graceMs > 0 && (await waitUntilGone(graceMs))) return true;
  signalChildGroup(child, detached, "SIGTERM");
  if (await waitUntilGone(termMs)) return true;
  signalChildGroup(child, detached, "SIGKILL");
  return waitUntilGone(killMs);
}

/**
 * One initialized, shared ACP server process multiplexing multiple concurrent sessions.
 * Process initialization happens once; each session has isolated events, cancel, and close.
 */
export class AcpConnection {
  private readonly sessions = new Map<string, InternalSessionState>();
  private readonly openingSessionIds = new Set<string>();
  private readonly closeTimeoutMs: number;
  private readonly detached: boolean;
  private readonly reaper: ((options?: { graceMs?: number; termMs?: number; killMs?: number }) => Promise<boolean>) | null;
  private shuttingDown = false;
  private reapPromise: Promise<boolean> | null = null;
  private reapResult: boolean | null = null;
  private readonly reapWaiters = new Set<(result: boolean) => void>();

  private constructor(
    readonly child: ChildProcess,
    readonly client: AcpClient,
    readonly initialized: AcpInitializeResult,
    options: {
      closeTimeoutMs?: number;
      detached?: boolean;
      reaper?: (options?: { graceMs?: number; termMs?: number; killMs?: number }) => Promise<boolean>;
    } = {},
  ) {
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2000;
    this.detached = options.detached ?? false;
    this.reaper = options.reaper ?? null;

    client.onFailure((failure) => {
      for (const session of [...this.sessions.values()]) {
        this.detachSession(session);
        if (!session.errorEmitted && !this.shuttingDown) {
          session.errorEmitted = true;
          session.onEvent?.({
            protocol: "acp",
            type: "acp_error",
            stage: failure.kind === "protocol_error" ? "protocol" : "transport",
            code: failure.kind === "protocol_error" ? "PROTOCOL_INVALID" : "ACP_TRANSPORT_CLOSED",
            message: failure.message,
          });
        }
      }
    });
  }

  /** Attaches to an already-spawned ACP child process and executes `initialize` once. */
  static async connect(
    child: ChildProcess,
    options: {
      clientInfo: { name: string; version: string };
      initializeTimeoutMs?: number;
      closeTimeoutMs?: number;
      detached?: boolean;
      onExit?: (failure: AcpTransportFailure) => void;
      reaper?: (options?: { graceMs?: number; termMs?: number; killMs?: number }) => Promise<boolean>;
    },
  ): Promise<AcpConnection> {
    const client = new AcpClient(child, {
      onTransportFailure: options.onExit,
    });
    const rawInit = await client.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: options.clientInfo,
      },
      options.initializeTimeoutMs,
    );
    const initialized = parseInitializeResponse(rawInit);
    return new AcpConnection(child, client, initialized, {
      closeTimeoutMs: options.closeTimeoutMs,
      detached: options.detached,
      reaper: options.reaper,
    });
  }

  /** Spawns one shared ACP server process and completes its single `initialize` handshake. */
  static async spawn(spec: AcpProcessSpec): Promise<AcpConnection> {
    const detached = process.platform !== "win32";
    const child = spawn(spec.executable, spec.args ?? [], {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      detached,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (spec.onStderr) {
      child.stderr?.on("data", spec.onStderr);
    }
    try {
      return await AcpConnection.connect(child, {
        clientInfo: spec.clientInfo,
        initializeTimeoutMs: spec.initializeTimeoutMs,
        closeTimeoutMs: spec.closeTimeoutMs,
        detached,
        onExit: spec.onExit,
      });
    } catch (error) {
      await reapChildGroup(child, detached, { graceMs: 100, termMs: 1500, killMs: 1500 });
      throw error;
    }
  }

  get alive(): boolean {
    return this.client.alive && !this.shuttingDown;
  }

  get failure(): AcpTransportFailure | null {
    return this.client.failure;
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Opens a new or resumed session on this shared initialized process. Multiple sessions with
   * different cwds and concurrent prompts coexist without cross-talk.
   */
  async openSession(input: AcpOpenSessionInput): Promise<AcpSessionHandle> {
    if (this.shuttingDown) {
      throw new AcpTransportError({
        kind: "shutdown",
        message: "ACP 共享进程正在关闭，无法打开新会话",
        exitCode: this.child.exitCode,
        signal: this.child.signalCode,
      });
    }
    if (this.client.failure) {
      throw new AcpTransportError(this.client.failure);
    }
    const action: "new" | "resume" = input.sessionId === null ? "new" : "resume";
    input.onEvent?.({
      protocol: "acp",
      type: "acp_initialized",
      protocolVersion: this.initialized.protocolVersion,
      agentInfo: this.initialized.agentInfo,
      agentCapabilities: this.initialized.agentCapabilities,
    });
    if (action === "resume") {
      if (!this.initialized.supportsResume) {
        const error = new AcpConfigError("ACP 服务端未声明 session/resume 能力");
        this.emitSessionError(input.onEvent, "session/resume", error);
        throw error;
      }
      if (this.sessions.has(input.sessionId!) || this.openingSessionIds.has(input.sessionId!)) {
        const error = new AcpProtocolError(`ACP 会话已在当前连接中打开: ${input.sessionId}`);
        this.emitSessionError(input.onEvent, "session/resume", error);
        throw error;
      }
    }

    let state: InternalSessionState | null = null;
    const bufferedEarlyUpdates: Record<string, unknown>[] = [];
    let preSubscribedUnsub: (() => void) | null = null;
    let reservedSessionId: string | null = null;

    const dispatchUpdate = (update: Record<string, unknown>): void => {
      if (!state) {
        bufferedEarlyUpdates.push(update);
        return;
      }
      if (state.closed) return;
      state.onEvent?.({
        protocol: "acp",
        type: "acp_update",
        sessionId: state.sessionId,
        update,
      });
      state.activeUpdateHook?.(update);
    };

    if (action === "resume") {
      // Reserve and subscribe before sending `session/resume` so early updates never miss this session.
      reservedSessionId = input.sessionId!;
      this.openingSessionIds.add(reservedSessionId);
      preSubscribedUnsub = this.client.subscribeSession(reservedSessionId, dispatchUpdate);
    }

    const openedBox: { value: OpenedSessionData | null } = { value: null };
    try {
      await this.client.request(
        action === "new" ? "session/new" : "session/resume",
        action === "new"
          ? { cwd: input.cwd, mcpServers: [] }
          : {
              sessionId: input.sessionId,
              cwd: input.cwd,
              mcpServers: [],
            },
        {
          timeoutMs: input.timeoutMs,
          onResultSync: (result) => {
            // Validate once and subscribe synchronously before the next line in the same stdout
            // chunk is parsed so `startupInfo` or immediate `session/update` notifications route cleanly.
            const parsed = parseSessionResponse(result, input.sessionId);
            if (action === "new") {
              if (
                this.sessions.has(parsed.sessionId) ||
                this.openingSessionIds.has(parsed.sessionId)
              ) {
                throw new AcpProtocolError(`ACP 返回了重复会话 ID: ${parsed.sessionId}`);
              }
              reservedSessionId = parsed.sessionId;
              this.openingSessionIds.add(reservedSessionId);
              preSubscribedUnsub = this.client.subscribeSession(
                parsed.sessionId,
                dispatchUpdate,
              );
            }
            openedBox.value = parsed;
          },
        },
      );
      if (!openedBox.value) {
        throw new AcpProtocolError(
          action === "new" ? "ACP session/new 响应无效" : "ACP session/resume 响应无效",
        );
      }
      if (this.client.failure) {
        throw new AcpTransportError(this.client.failure);
      }
      if (this.shuttingDown) {
        throw new AcpTransportError({
          kind: "shutdown",
          message: "ACP 共享进程正在关闭，无法完成会话打开",
          exitCode: this.child.exitCode,
          signal: this.child.signalCode,
        });
      }
    } catch (error) {
      if (reservedSessionId) this.openingSessionIds.delete(reservedSessionId);
      preSubscribedUnsub?.();
      this.emitSessionError(input.onEvent, action === "new" ? "session/new" : "session/resume", error);
      throw error;
    }

    const opened = openedBox.value;
    state = {
      action,
      sessionId: opened.sessionId,
      cwd: input.cwd,
      startupInfo: opened.startupInfo,
      configOptions: opened.configOptions,
      onEvent: input.onEvent,
      unsubscribeUpdates: preSubscribedUnsub ?? (() => {}),
      activePrompt: null,
      activeUpdateHook: null,
      closePromise: null,
      closed: false,
      errorEmitted: false,
    };
    this.sessions.set(state.sessionId, state);
    if (reservedSessionId) this.openingSessionIds.delete(reservedSessionId);

    const handle = this.createHandle(state);

    if (input.shouldAbort?.()) {
      await handle.close().catch(() => {});
      return handle;
    }

    state.onEvent?.({
      protocol: "acp",
      type: "acp_session",
      action: state.action,
      sessionId: state.sessionId,
      cwd: state.cwd,
      configOptions: state.configOptions,
      startupInfo: state.startupInfo,
    });
    for (const early of bufferedEarlyUpdates) dispatchUpdate(early);

    if (input.configOptions?.length) {
      try {
        for (const option of input.configOptions) {
          if (input.shouldAbort?.()) {
            await handle.close().catch(() => {});
            return handle;
          }
          await handle.setConfigOption(option, input.timeoutMs);
        }
      } catch (error) {
        // Config failure closes ONLY this session; the shared process & sibling sessions stay up.
        await handle.close().catch(() => {});
        throw error;
      }
    }

    if (input.shouldAbort?.()) {
      await handle.close().catch(() => {});
      return handle;
    }

    return handle;
  }

  /** Idempotently reaps the child process group with bounded EOF grace -> SIGTERM -> SIGKILL. */
  reap(options?: { graceMs?: number; termMs?: number; killMs?: number }): Promise<boolean> {
    if (!this.reapPromise) {
      this.reapPromise = (this.reaper
        ? this.reaper(options)
        : reapChildGroup(this.child, this.detached, options)
      ).then(
        (result) => {
          this.reapResult = result;
          for (const resolve of this.reapWaiters) resolve(result);
          this.reapWaiters.clear();
          return result;
        },
        () => {
          this.reapResult = false;
          for (const resolve of this.reapWaiters) resolve(false);
          this.reapWaiters.clear();
          return false;
        },
      );
    }
    return this.reapPromise;
  }

  /**
   * Resolves once this exact process generation's guardian reports its final group evidence.
   * It never initiates a reap; idle recycle, shutdown, or a transport failure still owns that.
   */
  whenReaped(): Promise<boolean> {
    if (this.reapResult !== null) return Promise.resolve(this.reapResult);
    return new Promise((resolve) => this.reapWaiters.add(resolve));
  }

  /**
   * Gracefully shuts down the shared ACP process: cancels/closes active sessions (bounded),
   * closes stdin, waits for clean exit, and escalates SIGTERM -> SIGKILL if needed.
   */
  async shutdown(options?: { timeoutMs?: number }): Promise<boolean> {
    if (this.shuttingDown) return this.reap();
    this.shuttingDown = true;
    const timeoutMs = options?.timeoutMs ?? this.closeTimeoutMs;
    const active = [...this.sessions.values()];
    if (this.client.alive) {
      await Promise.allSettled(
        active.map(async (session) => {
          if (session.activePrompt) {
            this.client.notify("session/cancel", { sessionId: session.sessionId });
          }
          await this.closeSessionState(session, Math.min(timeoutMs, 1000));
        }),
      );
    } else {
      for (const session of active) this.detachSession(session);
    }
    this.client.abortAll("ACP 共享进程已关闭");
    return this.reap({
      graceMs: Math.min(timeoutMs, 1000),
      termMs: 1500,
      killMs: 2000,
    });
  }

  private createHandle(state: InternalSessionState): AcpSessionHandle {
    return {
      get action() {
        return state.action;
      },
      get sessionId() {
        return state.sessionId;
      },
      get cwd() {
        return state.cwd;
      },
      get startupInfo() {
        return state.startupInfo;
      },
      get configOptions() {
        return state.configOptions;
      },
      get closed() {
        return state.closed;
      },
      setConfigOption: async (option, timeoutMs) => {
        this.assertSessionOpen(state);
        const match = option.match ?? "exact";
        let snapshots: AcpConfigOptionSnapshot[];
        try {
          const raw = await this.client.request(
            "session/set_config_option",
            {
              sessionId: state.sessionId,
              configId: option.configId,
              value: option.value,
            },
            timeoutMs,
          );
          snapshots = parseSetConfigResponse(raw, option.configId);
        } catch (error) {
          const wrapped =
            error instanceof AcpRpcError
              ? new AcpConfigError(
                  `ACP 不支持配置 ${option.configId}=${option.value}: ${error.message}`,
                  error.data,
                )
              : error;
          this.emitSessionError(state.onEvent, "session/set_config_option", wrapped, state);
          throw wrapped;
        }
        state.configOptions = snapshots;
        const appliedValue = findAppliedConfigValue(snapshots, option.configId);
        state.onEvent?.({
          protocol: "acp",
          type: "acp_config",
          configId: option.configId,
          requestedValue: option.value,
          appliedValue,
          match,
        });
        if (!configOptionMatches(appliedValue, option.value, match)) {
          const mismatch = new AcpConfigError(
            `ACP 不支持配置 ${option.configId}=${option.value}（实际生效值: ${appliedValue ?? "未知"}）`,
            { configId: option.configId, requestedValue: option.value, appliedValue },
          );
          this.emitSessionError(state.onEvent, "session/set_config_option", mismatch, state);
          throw mismatch;
        }
        return state.configOptions;
      },
      prompt: async (prompt, options) => {
        this.assertSessionOpen(state);
        if (state.activePrompt) {
          throw new AcpProtocolError(
            `ACP 会话 ${state.sessionId} 已有进行中的 prompt，不能并发重叠`,
          );
        }
        const blocks = [{ type: "text", text: prompt }];
        state.activeUpdateHook = options?.onUpdate ?? null;
        const turnPromise = (async (): Promise<AcpTurnResult> => {
          try {
            const raw = await this.client.request(
              "session/prompt",
              { sessionId: state.sessionId, prompt: blocks },
              options?.timeoutMs,
            );
            const parsed = parsePromptResponse(raw);
            state.onEvent?.({
              protocol: "acp",
              type: "acp_prompt_result",
              sessionId: state.sessionId,
              stopReason: parsed.stopReason,
              result: parsed.result,
            });
            return {
              action: state.action,
              sessionId: state.sessionId,
              cwd: state.cwd,
              stopReason: parsed.stopReason,
              result: parsed.result,
            };
          } catch (error) {
            this.emitSessionError(state.onEvent, "session/prompt", error, state);
            throw error;
          } finally {
            state.activePrompt = null;
            state.activeUpdateHook = null;
          }
        })();
        state.activePrompt = turnPromise;
        return turnPromise;
      },
      cancel: async (options) => {
        if (state.closed || !this.client.alive) return;
        this.client.notify("session/cancel", { sessionId: state.sessionId });
        const graceMs = options?.graceMs ?? 0;
        if (graceMs > 0 && state.activePrompt) {
          await Promise.race([
            state.activePrompt.then(
              () => undefined,
              () => undefined,
            ),
            new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
          ]);
        }
      },
      close: async (options) => {
        await this.closeSessionState(state, options?.timeoutMs ?? this.closeTimeoutMs);
      },
    };
  }

  private assertSessionOpen(state: InternalSessionState): void {
    if (this.client.failure) throw new AcpTransportError(this.client.failure);
    if (state.closed) {
      throw new AcpProtocolError(`ACP 会话已关闭: ${state.sessionId}`);
    }
  }

  private detachSession(state: InternalSessionState): void {
    state.closed = true;
    state.activeUpdateHook = null;
    state.unsubscribeUpdates();
    this.sessions.delete(state.sessionId);
  }

  private closeSessionState(
    state: InternalSessionState,
    timeoutMs: number,
  ): Promise<void> {
    if (state.closePromise) return state.closePromise;
    if (state.closed) return Promise.resolve();
    const canCloseRpc = this.client.alive && this.initialized.supportsClose;
    this.detachSession(state);
    if (!canCloseRpc) return Promise.resolve();
    state.closePromise = (async () => {
      try {
        await this.client.request("session/close", { sessionId: state.sessionId }, timeoutMs);
        state.onEvent?.({
          protocol: "acp",
          type: "acp_closed",
          sessionId: state.sessionId,
        });
      } catch {
        /* best-effort session/close; session is already detached */
      }
    })();
    return state.closePromise;
  }

  private emitSessionError(
    onEvent: ((event: AcpEvent) => void) | undefined,
    stage: string,
    error: unknown,
    state?: InternalSessionState,
  ): void {
    if (state?.errorEmitted) return;
    if (state) state.errorEmitted = true;
    if (!onEvent) return;
    if (error instanceof AcpConfigError) {
      onEvent({
        protocol: "acp",
        type: "acp_error",
        stage,
        code: error.errorCode,
        message: error.message,
        ...(error.data !== undefined ? { data: error.data } : {}),
      });
    } else if (error instanceof AcpRpcError) {
      onEvent({
        protocol: "acp",
        type: "acp_error",
        stage,
        code: error.rpcCode,
        message: error.message,
        ...(error.data !== undefined ? { data: error.data } : {}),
      });
    } else if (error instanceof AcpTransportError) {
      onEvent({
        protocol: "acp",
        type: "acp_error",
        stage: error.failure.kind === "protocol_error" ? "protocol" : stage,
        code:
          error.failure.kind === "protocol_error"
            ? "PROTOCOL_INVALID"
            : error.errorCode,
        message: error.message,
      });
    } else if (error instanceof AcpProtocolError) {
      onEvent({
        protocol: "acp",
        type: "acp_error",
        stage,
        code: error.errorCode,
        message: error.message,
      });
    } else {
      onEvent({
        protocol: "acp",
        type: "acp_error",
        stage,
        code: null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

//----------------- LAZY ON-DEMAND PROCESS SLOT ----------------

/**
 * Lazily starts and initializes one shared `AcpConnection` on first `acquire()`, deduplicates
 * concurrent initializers, and reaps any broken prior process group before starting a fresh
 * process. Imposes no policy on how upper layers partition slots.
 */
export class LazyAcpProcess {
  private connection: AcpConnection | null = null;
  private starting: Promise<AcpConnection> | null = null;
  private draining: Promise<boolean> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** When the current idle window began; null while occupied, starting, or draining. */
  private idleSince: number | null = null;
  private activeTasks = 0;
  private idleTimeoutMs: number;
  private closed = false;

  constructor(
    private readonly factory: () => Promise<AcpConnection>,
    options: { idleTimeoutMs?: number } = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
  }

  /** True only when an initialized connection is currently alive (never spawns on read). */
  get isRunning(): boolean {
    return this.connection !== null && this.connection.alive;
  }

  /** True when a connection is live, starting, or draining a prior failed process. */
  get isActive(): boolean {
    return this.connection !== null || this.starting !== null || this.draining !== null;
  }

  /** Returns the live initialized connection, waiting for any prior broken process to exit first. */
  acquire(): Promise<AcpConnection> {
    if (this.closed) {
      return Promise.reject(
        new AcpTransportError({
          kind: "shutdown",
          message: "LazyAcpProcess 已关闭",
          exitCode: null,
          signal: null,
        }),
      );
    }
    if (this.connection?.alive) return Promise.resolve(this.connection);
    if (this.starting) return this.starting;
    const starting = (async () => {
      if (this.draining) {
        const drained = await this.draining;
        if (this.closed) {
          throw new AcpTransportError({
            kind: "shutdown",
            message: "LazyAcpProcess 已关闭",
            exitCode: null,
            signal: null,
          });
        }
        if (!drained) {
          throw new AcpTransportError({
            kind: "shutdown",
            message: "上一个 ACP 进程未能确认退出，拒绝启动新进程",
            exitCode: null,
            signal: null,
          });
        }
      }
      const conn = await this.factory();
      if (this.closed) {
        await conn.shutdown().catch(() => {});
        throw new AcpTransportError({
          kind: "shutdown",
          message: "LazyAcpProcess 在初始化期间已关闭",
          exitCode: null,
          signal: null,
        });
      }
      this.connection = conn;
      conn.client.onFailure(() => {
        // Idle recycle and close() detach the connection before shutdown; their own drain owns
        // the reaper evidence. Only a genuine connection failure needs this listener to drain.
        if (this.connection !== conn) return;
        this.connection = null;
        // Reap the failed process group (critical for stdout_closed/protocol_error where the
        // old PID may still be alive) before any subsequent acquire() spawns a replacement.
        const drain = (this.draining ?? Promise.resolve(true)).then(async (prev) => {
          const reaped = await conn.reap({ graceMs: 150, termMs: 1500, killMs: 2000 });
          return prev && reaped;
        });
        this.draining = drain;
        void drain.then((reaped) => {
          // Keep an unconfirmed drain visible so acquire() refuses to spawn over a live old PID.
          if (this.draining === drain && reaped) this.draining = null;
        });
      });
      return conn;
    })().finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  /**
   * Marks one task as using the slot. The idle clock cannot start until every task has called
   * `endTask()` after closing its session.
   */
  async beginTask(): Promise<AcpConnection> {
    this.cancelIdle();
    this.activeTasks++;
    return this.acquire();
  }

  /** Releases one task and starts the idle clock when it was the last occupying task. */
  endTask(): void {
    this.activeTasks--;
    if (this.activeTasks === 0) {
      this.idleSince = Date.now();
      this.scheduleIdle();
    }
  }

  /**
   * Applies a new saved duration. An already-idle slot keeps its original idle start, so a
   * shortened window that has already elapsed recycles on the next timer turn; occupied slots
   * simply store the duration for the window that begins when their last task ends.
   */
  setIdleTimeoutMs(milliseconds: number): void {
    this.idleTimeoutMs = milliseconds;
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.scheduleIdle();
  }

  private cancelIdle(): void {
    this.idleSince = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdle(): void {
    if (this.closed || this.activeTasks > 0 || this.idleTimer || !this.connection) return;
    this.idleSince ??= Date.now();
    const remaining = Math.max(0, this.idleTimeoutMs - (Date.now() - this.idleSince));
    const timer = setTimeout(() => {
      this.idleTimer = null;
      this.recycleIdle();
    }, remaining);
    timer.unref?.();
    this.idleTimer = timer;
  }

  /**
   * Reaps an idle shared process through the existing guardian shutdown/reaper. The slot stays
   * open: the resulting drain must confirm group exit before a later acquire may spawn.
   */
  private recycleIdle(): void {
    if (this.closed || this.activeTasks > 0) return;
    const conn = this.connection;
    if (!conn) return;
    this.connection = null;
    this.idleSince = null;
    const drain = (this.draining ?? Promise.resolve(true)).then(async (prev) => {
      const reaped = await conn.shutdown();
      return prev && reaped;
    });
    this.draining = drain;
    void drain.then((reaped) => {
      if (this.draining === drain && reaped) this.draining = null;
    });
  }

  /** Shuts down the shared process and waits for any draining cleanup; safe no-op if never acquired. */
  async close(options?: { timeoutMs?: number }): Promise<boolean> {
    this.closed = true;
    this.cancelIdle();
    const inflight = this.starting;
    const live = this.connection;
    this.connection = null;
    let reaped = true;
    if (live) {
      reaped = await live.shutdown(options);
    } else if (inflight) {
      try {
        const started = await inflight;
        reaped = await started.shutdown(options);
      } catch {
        /* failed startup already reaped in AcpConnection.spawn */
      }
    }
    if (this.draining) {
      reaped = (await this.draining) && reaped;
    }
    return reaped;
  }
}

//----------------- PROGRESS TRACKING & EVENT-LOG PARSING ----------------

/** Updates live run progress from one `protocol: "acp"` event line. */
export function trackAcpProgress(
  event: Record<string, unknown>,
  progress: AcpProgressTracker,
): void {
  const kind = typeof event.type === "string" ? event.type : null;
  if (!kind) return;
  if (kind === "acp_session" || kind === "acp_config" || kind === "acp_initialized") {
    progress.phase = kind;
    return;
  }
  if (kind === "acp_prompt_result" || kind === "acp_closed" || kind === "acp_error") {
    progress.phase = kind === "acp_error" ? "error" : kind;
    progress.active.clear();
    progress.currentTool = null;
    return;
  }
  if (kind !== "acp_update") return;
  const update = asRecord(event.update);
  const updateKind =
    update && typeof update.sessionUpdate === "string" ? update.sessionUpdate : null;
  if (!update || !updateKind) return;
  if (updateKind === "tool_call" || updateKind === "tool_call_update") {
    progress.phase = updateKind;
    const callId = nonEmptyString(update.toolCallId);
    const label = nonEmptyString(update.title) ?? nonEmptyString(update.kind);
    const status = typeof update.status === "string" ? update.status : null;
    const done =
      status === "completed" || status === "failed" || status === "cancelled";
    if (done) {
      if (callId) progress.active.delete(callId);
      progress.steps++;
      progress.currentTool =
        [...progress.active.values()].reverse().find((tool) => tool) ?? null;
    } else if (callId) {
      const existing = progress.active.get(callId) ?? null;
      const resolved = label ?? existing;
      progress.active.set(callId, resolved);
      if (progress.active.size > 64) {
        progress.active.delete(progress.active.keys().next().value!);
      }
      progress.currentTool = resolved;
    } else if (label) {
      progress.currentTool = label;
    }
    return;
  }
  if (updateKind === "session_info_update") {
    const meta = asRecord(update._meta);
    const piAcp = meta ? asRecord(meta.piAcp) : null;
    if (piAcp?.running === false) {
      progress.phase = "turn_end";
      progress.steps++;
      progress.active.clear();
      progress.currentTool = null;
    } else if (piAcp?.running === true) {
      progress.phase = "turn_start";
    }
    return;
  }
  if (
    updateKind === "agent_message_chunk" ||
    updateKind === "agent_thought_chunk"
  ) {
    progress.phase = updateKind;
  }
}

/**
 * Parses and validates one run's `protocol: "acp"` event lines.
 * Preserves `action` and `cwd` for recovery and decouples `expectedAction` from
 * `expectedSessionId` so handle-less recovery of a new session never misclassifies it as resume.
 */
export function parseAcpEvents(
  entries: Array<{ value: unknown; number: number }>,
  expectedSessionId: string | null,
  expectedCwd: string,
  options: ParseAcpEventsOptions = {},
): AcpParsedStream {
  let initializedEvents = 0;
  let sessionEvents = 0;
  let sessionAction: "new" | "resume" | null = null;
  let sessionId: string | null = null;
  let validatedSessionId: string | null = null;
  let sessionCwd: string | null = null;
  let identityMismatch = false;
  let promptResultSeen = false;
  let stopReason: string | null = null;
  let startupInfo: string | null = null;
  let error: string | null = null;
  let errorCode: string | null = null;

  const fail = (message: string, code = "PROTOCOL_INVALID"): void => {
    if (error === null) {
      error = message;
      errorCode = code;
    }
  };

  for (const { value, number } of entries) {
    const event = asRecord(value);
    if (!event || event.protocol !== "acp" || typeof event.type !== "string") {
      fail(`无效 ACP 事件 (line ${number})`);
      continue;
    }
    switch (event.type) {
      case "acp_initialized": {
        initializedEvents++;
        if (typeof event.protocolVersion !== "number") {
          fail("ACP initialize 缺少有效 protocolVersion");
        }
        break;
      }
      case "acp_session": {
        sessionEvents++;
        const id = event.sessionId;
        const action =
          event.action === "new" || event.action === "resume" ? event.action : null;
        let identityValid = false;
        if (typeof id !== "string" || !id.trim() || path.basename(id) !== id) {
          fail("ACP session 事件缺少有效会话 ID");
        } else if (sessionId !== null) {
          fail("出现多个 ACP session 事件");
        } else {
          sessionId = id;
          if (expectedSessionId !== null && id !== expectedSessionId) {
            identityMismatch = true;
            fail("ACP resume 返回了不同会话 ID");
          } else {
            identityValid = true;
          }
        }
        if (action === null) {
          fail("ACP session 事件缺少有效 action");
        } else {
          sessionAction = action;
          if (
            options.expectedAction === "new" ||
            options.expectedAction === "resume"
          ) {
            if (action !== options.expectedAction) {
              fail(`ACP action 必须为 ${options.expectedAction}`);
            }
          } else if (options.expectedAction === undefined && expectedSessionId === null) {
            if (action !== "new") fail("新会话 ACP action 必须为 new");
          }
        }
        const cwdValid =
          typeof event.cwd === "string" &&
          path.isAbsolute(event.cwd) &&
          samePath(event.cwd, expectedCwd);
        if (!cwdValid) {
          fail("ACP session 工作目录不匹配");
        } else {
          sessionCwd = event.cwd as string;
        }
        if (typeof event.startupInfo === "string") {
          startupInfo = event.startupInfo;
        }
        if (identityValid && cwdValid && sessionId !== null) {
          validatedSessionId = sessionId;
        }
        break;
      }
      case "acp_config": {
        const configId = nonEmptyString(event.configId) ?? "unknown";
        const requested = nonEmptyString(event.requestedValue);
        const applied = nonEmptyString(event.appliedValue);
        const match = event.match === "model" ? "model" : "exact";
        if (!requested || !configOptionMatches(applied, requested, match)) {
          fail(
            `ACP 配置未按预期生效 (${configId}=${String(requested)} -> ${String(applied)})`,
            "ACP_CONFIG_UNSUPPORTED",
          );
        }
        break;
      }
      case "acp_update": {
        if (
          typeof event.sessionId === "string" &&
          sessionId !== null &&
          event.sessionId !== sessionId
        ) {
          fail("ACP session/update 会话 ID 不匹配");
        }
        break;
      }
      case "acp_prompt_result": {
        promptResultSeen = true;
        if (
          typeof event.sessionId === "string" &&
          sessionId !== null &&
          event.sessionId !== sessionId
        ) {
          identityMismatch = true;
          fail("ACP prompt 结果会话 ID 不一致");
        }
        stopReason = typeof event.stopReason === "string" ? event.stopReason : null;
        if (stopReason !== "end_turn") {
          fail(`ACP 轮次未正常完成: ${String(stopReason)}`, "NATIVE_FAILED");
        }
        break;
      }
      case "acp_error": {
        const stage = nonEmptyString(event.stage) ?? "acp";
        const message = nonEmptyString(event.message) ?? `ACP 报告错误 (${stage})`;
        const code =
          event.code === "ACP_CONFIG_UNSUPPORTED" ||
          stage === "session/set_config_option"
            ? "ACP_CONFIG_UNSUPPORTED"
            : event.code === "PROTOCOL_INVALID" || stage === "protocol"
              ? "PROTOCOL_INVALID"
              : event.code === "ACP_TRANSPORT_CLOSED" || stage === "transport"
                ? "ACP_TRANSPORT_CLOSED"
                : "NATIVE_FAILED";
        fail(message, code);
        break;
      }
      case "acp_closed":
        break;
      default:
        break;
    }
  }

  if (initializedEvents !== 1) fail("缺少有效的 ACP initialize 事件");
  if (sessionEvents !== 1) {
    validatedSessionId = null;
    fail("缺少有效的 ACP session 事件");
  }
  if (!promptResultSeen) fail("缺少 ACP prompt 完成结果");

  return {
    success: error === null,
    action: sessionAction,
    sessionId,
    validatedSessionId: identityMismatch ? null : validatedSessionId,
    cwd: sessionCwd,
    identityMismatch,
    stopReason,
    startupInfo,
    error,
    errorCode,
  };
}
