/**
 * Server-local shared contracts. Pure plugin contracts come from `shared/contracts.ts`; only
 * runtime-facing helper shapes are declared here so server modules never duplicate the public API.
 */
export type * from "../../shared/contracts.js";
export type * as Contracts from "../../shared/contracts.js";

/**
 * Canonical settings row persisted by the store. The read-only per-engine projections on
 * `Contracts.WorkerSettings` are derived on read and are deliberately excluded, so the legacy
 * maps never become a second persistence source.
 */
export type WorkerSettingsRecord = Pick<
  import("../../shared/contracts.js").WorkerSettings,
  | "schemaVersion"
  | "configs"
  | "defaultConfigId"
  | "retentionDays"
  | "softReminderSeconds"
  | "softReminderSteps"
> & {
  /**
   * Optional saved idle window in whole seconds. Absence deliberately means "use the
   * environment/default fallback", so unrelated settings saves must not materialize it.
   */
  acpIdleTimeoutSeconds?: number;
  /**
   * Project ids whose sessions must not start or resume workers. Absence means no project is
   * blocked, preserving rows written before this setting existed.
   */
  blockedProjectIds?: string[];
};

/** Validated internal error raised by service boundaries; `code` is stable for API responses. */
export class WorkerFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkerFailure";
  }
}

/** Evidence written by a per-run guardian just before it exits. */
export type GuardianEvidence = {
  kind?: "guardian";
  reason: "exit" | "timeout" | "cancelled" | "disconnect" | "error";
  exitCode: number | null;
  signal: string | null;
  startedAt: string | null;
  finishedAt: string;
  groupExited: boolean;
  error: string | null;
};

/**
 * Per-turn recoverable evidence for a session hosted on a shared ACP process.
 * Never claims the shared process exited while it remains alive for sibling sessions.
 */
export type AcpSessionEvidence = {
  kind: "acp_session";
  reason: "exit" | "timeout" | "cancelled" | "disconnect" | "error";
  exitCode: number | null;
  signal: string | null;
  startedAt: string | null;
  finishedAt: string;
  sessionClosed: boolean;
  /** True when a prompt was actually sent; false proves the run never executed a turn. */
  promptStarted?: boolean;
  /** True only after this connection's guarded process group exit was confirmed. */
  groupExited?: boolean;
  error: string | null;
};

/** Discriminated union of recoverable `final.json` evidence shapes. */
export type RunEvidence = GuardianEvidence | AcpSessionEvidence;

/** Result of one native protocol parse. Invalid protocol always yields `success:false`. */
export type NativeExecution = {
  success: boolean;
  nativeSessionId: string | null;
  nativeSessionFile: string | null;
  finalText: string | null;
  usage: import("../../shared/contracts.js").WorkerUsage | null;
  error: string | null;
  /** Optional stable machine-readable failure code when process exitCode was 0. */
  errorCode?: string | null;
};

/** One ACP `session/set_config_option` assignment enforced without silent downgrade. */
export type AcpConfigOptionRequest = {
  configId: string;
  value: string;
  /** `"exact"` requires identical currentValue; `"model"` also accepts `<provider>/<value>` when value has no `/`. */
  match?: "exact" | "model";
};

/** Validated snapshot of one ACP `configOptions` entry parsed once at the protocol boundary. */
export type AcpConfigOptionSnapshot = {
  id: string;
  category: string | null;
  currentValue: string | null;
};

/** Validated `initialize` handshake result cached once per live shared ACP process. */
export type AcpInitializeResult = {
  protocolVersion: number;
  agentInfo: Record<string, unknown> | null;
  agentCapabilities: Record<string, unknown> | null;
  supportsResume: boolean;
  supportsClose: boolean;
};

/** Terminal transport failure that atomically unblocks every pending waiter on a shared ACP process. */
export type AcpTransportFailure = {
  kind: "exit" | "spawn_error" | "stdout_closed" | "protocol_error" | "shutdown";
  message: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

/** Spawn/lifecycle spec for one shared, lazily-started stdio ACP server process. */
export type AcpProcessSpec = {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientInfo: { name: string; version: string };
  onStderr?: (chunk: Buffer) => void;
  onExit?: (failure: AcpTransportFailure) => void;
  initializeTimeoutMs?: number;
  closeTimeoutMs?: number;
};

/** Validated terminal result of one `session/prompt` turn, carrying identity fields needed for recovery. */
export type AcpTurnResult = {
  action: "new" | "resume";
  sessionId: string;
  cwd: string;
  stopReason: string | null;
  result: Record<string, unknown>;
};

/** Everything needed to launch one guardian-wrapped native invocation. */
export type NativeLaunch = {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  /** Known before the run starts (Pi session file) or null when the runner assigns identity. */
  expectedSessionId: string | null;
  sessionFile: string | null;
};

export type StreamName = "events" | "stderr";
