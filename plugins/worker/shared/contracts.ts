/**
 * Pure TypeScript contracts shared by the Worker plugin, the Codex host bridge, and the UI.
 *
 * This module contains types only: importing it must never pull in plugin runtime code. The
 * host re-exports the subset that it actually consumes from `server/shared/index.ts`; downstream
 * plugin modules should import from this file so the contract stays identical on both sides of
 * the process boundary.
 */

//----------------- WORKER IDENTITY AND STATUS ------------

/** Native worker runner implemented by the CloudCLI Worker plugin. */
export type WorkerType = "dsh" | "pi";

/**
 * Lifecycle of one run. `queued` waits in FIFO order; `starting`, `running`, `stopping`, and
 * `unknown` hold a concurrency slot. `unknown` also covers an unconfirmed stop failure: a run is
 * never reported `cancelled` until its process group is confirmed exited. `interrupted` is a
 * terminal outcome for a run ended by parent/host interruption or by a verified manual recovery.
 */
export type WorkerStatus =
  | "queued"
  | "starting"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

/** Statuses that hold one slot of the `(parentSessionId, projectId, workerType)` key. */
export type WorkerOccupyingStatus = Extract<
  WorkerStatus,
  "starting" | "running" | "stopping" | "unknown"
>;

/** Outcome recorded on a terminal notification; queued/in-flight states never appear here. */
export type WorkerNotificationStatus = Extract<
  WorkerStatus,
  "completed" | "failed" | "cancelled" | "interrupted" | "unknown"
>;

/** Deduplication state of an outbox notification. `batchId` is set once a host claims it. */
export type WorkerNotificationDelivery = "pending" | "delivered" | "held" | "unknown";

/** Machine-readable API/IPC failure; the message is safe to display and never contains tokens. */
export type WorkerError = {
  code: string;
  message: string;
};

//----------------- WORKSPACE AND REQUESTS ------------

/** How a worker's working directory is resolved. Existing directories are never created here. */
export type WorkerWorkspaceMode = "worktree" | "existing";

/**
 * Resolved workspace of a worker record. For `worktree`, the plugin created the directory and
 * recorded `baseCommit` when it accepted the start request; cleanup is only allowed when
 * `createdByPlugin` is true and the worktree is clean. For `existing`, only `path` is meaningful.
 */
export type WorkerWorkspace = {
  mode: WorkerWorkspaceMode;
  /** Absolute working directory used as both cwd and project path for the native runner. */
  path: string;
  /** Source repository for `worktree` mode. */
  sourcePath?: string;
  /** Commit resolved from `baseRef` when the start request was accepted. */
  baseCommit?: string;
  /** True only when this plugin created the worktree; cleanup requires it. */
  createdByPlugin?: boolean;
  /** Branch left in place by cleanup. */
  branch?: string;
};

/** Workspace selection in a start request; every start must choose a mode explicitly. */
export type WorkerStartWorkspace = {
  mode: WorkerWorkspaceMode;
  /**
   * Only for `existing` mode: an already-existing directory to run in. Defaults to the project
   * root. The plugin resolves and validates it but never creates it.
   */
  cwd?: string;
  /**
   * Only for `worktree` mode: the Git ref used as the worktree baseline. Defaults to `HEAD`,
   * resolved when the start request is accepted and persisted as `WorkerWorkspace.baseCommit`.
   */
  baseRef?: string;
  /**
   * Only for `worktree` mode: accept a dirty source checkout. Defaults to false so a dirty
   * source rejects the request instead of silently creating a worktree from it.
   */
  allowDirtySource?: boolean;
};

/**
 * A new worker request. Owner fields (`parentSessionId`, `projectId`, `projectPath`, `userId`,
 * `appServerInstanceId`) are derived from the authenticated owner and cannot be supplied here.
 */
export type WorkerStartInput = {
  /** Short user-visible label for the worker. */
  taskName: string;
  /**
   * Native runner for this worker. Omitted selects `WorkerSettings.defaultWorkerType`; an explicit
   * value always wins over the configured default.
   */
  type?: WorkerType;
  prompt: string;
  workspace: WorkerStartWorkspace;
  /**
   * Required declared modification scope, relative to the resolved cwd; `[]` means a read-only
   * task. This tells the worker what it may change and scopes review/cleanup checks; it is not an
   * additive filesystem permission beyond the workspace, and parallel workers may share a cwd.
   */
  writePaths: string[];
  /** Optional native model override; Pi may apply effort to its configured default model. */
  model?: string;
  provider?: string;
  /** Native reasoning effort; DSH requires an explicit model before effort can be applied. */
  effort?: string;
  /**
   * Hard timeout in seconds for this run. Omitted uses `WorkerSettings.hardTimeoutSeconds`;
   * null explicitly disables the hard timeout.
   */
  timeoutSeconds?: number | null;
  /**
   * Required caller-generated idempotency key. Repeating the same nonblank key returns the
   * original worker/run and must never spawn a second CLI invocation.
   */
  requestId: string;
};

/**
 * A follow-up run for an existing worker. The cwd, home, and native session identity stay fixed;
 * each resume creates its own `runId` and may override model/provider/effort explicitly.
 */
export type WorkerResumeInput = {
  workerId: string;
  prompt: string;
  model?: string;
  provider?: string;
  effort?: string;
  /**
   * Hard timeout in seconds for this run. Omitted retains the previous run's resolved timeout;
   * null explicitly disables the hard timeout.
   */
  timeoutSeconds?: number | null;
  /**
   * Required caller-generated idempotency key. Repeating the same nonblank key returns the
   * original run and must never spawn a second CLI invocation.
   */
  requestId: string;
};

/** Cancel request shared by the protected UI REST endpoint and host-initiated cancellation. */
export type WorkerCancelInput = {
  workerIds?: string[];
  all?: boolean;
  parentSessionId?: string;
  projectId?: string;
  /** Stop accepting new work for the matching owners while cancelling existing work. */
  pause?: boolean;
};

/** Recovery is only valid after the operator has verified the native session is stopped. */
export type WorkerRecoverInput = {
  workerId: string;
  notes: string;
  confirmedStopped: true;
};

/** Cleanup request for a plugin-created, clean, stopped worktree. */
export type WorkerCleanupInput = {
  workerId: string;
};

/** Retry of outbox notifications the host has not yet delivered. */
export type WorkerNotificationRetryInput = {
  eventIds: string[];
};

//----------------- OWNER, RUN, AND RECORD ------------

/**
 * A host-authenticated parent session. Tokens are exchanged over IPC and are intentionally not
 * part of this public shape. `paused` blocks new starts and automatic wake-ups for this owner.
 */
export type WorkerOwner = {
  id: string;
  parentSessionId: string;
  projectId: string;
  projectPath: string;
  /**
   * Host user identity; string or number because both auth backends are supported. Null means
   * there is no real user id (for example a detached turn) and must never be replaced by a guess.
   */
  userId: string | number | null;
  /** Logical parent runtime identity; preserved across idle transport recycling. */
  appServerInstanceId: string;
  paused: boolean;
  pausedReason?: string;
};

/** Token-usage data from the native runner; every unknown or unreported value is null. */
export type WorkerUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

/**
 * Observable execution progress used by reminders and the UI. `steps` is null when the native
 * runner does not report validated steps; `phase` and `currentTool` are null until the runner
 * reports an actual running phase/tool. The soft reminder defaults to 600 seconds / 20 steps;
 * `hardTimeoutAt` is null unless a hard timeout was configured.
 */
export type WorkerRunProgress = {
  steps: number | null;
  phase: string | null;
  currentTool: string | null;
  lastEventAt: string | null;
  softReminderSentAt: string | null;
  hardTimeoutAt: string | null;
};

/**
 * One native CLI invocation. `id` is the plugin-issued run id (distinct from the native session
 * id). Run success is an execution fact, not product acceptance.
 */
export type WorkerRun = {
  id: string;
  workerId: string;
  /** Idempotency key from `WorkerStartInput` / `WorkerResumeInput`, or null for internal runs. */
  requestId: string | null;
  status: WorkerStatus;
  /** ISO-8601 timestamps; both stay null until the run enters that lifecycle phase. */
  startedAt: string | null;
  finishedAt: string | null;
  model: string | null;
  provider: string | null;
  effort: string | null;
  /**
   * Resolved hard timeout snapshot in seconds, chosen when the request was accepted; null means
   * no hard timeout. Persisted so a queued run keeps the duration it was admitted with.
   */
  timeoutSeconds: number | null;
  /** Runner home used for this run, fixed on resume. */
  home: string;
  /** Native session directory used for this run, fixed on resume. */
  sessionsRoot: string;
  /** Native identity; null until it has been validated, never guessed. */
  nativeSessionId: string | null;
  nativeSessionFile: string | null;
  exitCode: number | null;
  /** Final assistant text, or null when the runner produced none. */
  finalText: string | null;
  error: WorkerError | null;
  usage: WorkerUsage | null;
  progress: WorkerRunProgress;
};

/** A persisted worker. `latestRun` is null until the first run has been recorded. */
export type WorkerRecord = {
  id: string;
  type: WorkerType;
  taskName: string;
  ownerId: string;
  parentSessionId: string;
  projectId: string;
  projectPath: string;
  /**
   * Declared modification scope from the request, relative to cwd; `[]` means read-only. It
   * scopes the worker's task and review checks, not an additive filesystem permission.
   */
  writePaths: string[];
  workspace: WorkerWorkspace;
  cwd: string;
  createdAt: string;
  latestRun: WorkerRun | null;
};

/**
 * A persisted terminal result waiting for the host to wake the parent session. Notifications
 * live in the plugin outbox and never consume the user's three-message queue.
 */
export type WorkerNotification = {
  id: string;
  ownerId: string;
  workerId: string;
  runId: string;
  summary: string;
  status: WorkerNotificationStatus;
  createdAt: string;
  delivery: WorkerNotificationDelivery;
  /** Set when the host claims the notification in a batch; null before claiming. */
  batchId: string | null;
};

//----------------- SETTINGS, COUNTS, AND UI SNAPSHOTS ------------

/**
 * Configured model and native reasoning effort for one worker type. Null means the runner's
 * existing default: Pi falls back to `CODEX_PI_MODEL` / `CODEX_PI_THINKING`, while a null DSH
 * effort leaves the native model configuration untouched.
 */
export type WorkerDefault = {
  model: string | null;
  effort: string | null;
};

/** Per-type configured defaults used when a start request omits model/effort. */
export type WorkerDefaults = Record<WorkerType, WorkerDefault>;

/**
 * Effective worker settings. Concurrency applies per `(parentSessionId, projectId, workerType)`
 * key. Soft reminder defaults are 600 seconds / 20 steps; no hard timeout is applied by default.
 */
export type WorkerSettings = {
  concurrency: Record<WorkerType, number>;
  /** Type selected by a start request that omits `type`; initially `dsh`. */
  defaultWorkerType: WorkerType;
  /** Model and effort defaults for each type; initially null for both types. */
  defaults: WorkerDefaults;
  /** Days to retain finished runs and their logs, measured from finishedAt; initially 1. */
  retentionDays: number;
  softReminderSeconds: number;
  softReminderSteps: number;
  hardTimeoutSeconds: number | null;
};

/**
 * Editable subset accepted by `PUT /settings`; reminder and timeout values stay server-owned.
 * Default selection and retention fields are optional so older concurrency-only clients preserve
 * the fields they do not send. A supplied `defaults` must contain the full dsh/pi map; blank or
 * null model/effort values clear that configured default. `retentionDays` must be a positive integer.
 */
export type WorkerSettingsInput = {
  concurrency: Record<WorkerType, number>;
  defaultWorkerType?: WorkerType;
  defaults?: WorkerDefaults;
  retentionDays?: number;
};

/** Worker counts keyed by every lifecycle status; absent keys are zero only in serialized data. */
export type WorkerCountsByStatus = Record<WorkerStatus, number>;

/** Number of workers in each lifecycle status; `total` is the sum across both worker types. */
export type WorkerCounts = {
  dsh: WorkerCountsByStatus;
  pi: WorkerCountsByStatus;
  total: WorkerCountsByStatus;
};

/** `GET /state` payload. Tokens and other credentials are never present. */
export type WorkerStateSnapshot = {
  workers: WorkerRecord[];
  counts: WorkerCounts;
  settings: WorkerSettings;
  notifications: WorkerNotification[];
};

/** One page of raw run output. `nextCursor` is null when no further page exists. */
export type WorkerLogPage = {
  text: string;
  nextCursor: string | null;
  done: boolean;
};

/** Raw output stream exposed by `GET /workers/:workerId/logs`. */
export type WorkerLogStream = "events" | "stderr";

/** Query parameters for one log page; cursors are opaque plugin-issued strings. */
export type WorkerLogQuery = {
  runId?: string;
  stream: WorkerLogStream;
  cursor?: string;
  limit?: number;
};

/** Query parameters for `GET /state`. Both filters are optional and may be combined. */
export type WorkerStateQuery = {
  projectId?: string;
  parentSessionId?: string;
};

/** Error envelope returned by every protected UI REST endpoint. */
export type WorkerApiError = {
  error: WorkerError;
};

//----------------- HOST IPC PROTOCOL ------------

/** Fixed IPC channel between the Codex host and the Worker plugin. */
export type WorkerIpcChannel = "cloudcli-workers";

/** Payload of each host-to-plugin request, keyed by the fixed action name. */
export type WorkerIpcRequestPayloads = {
  registerOwner: { owner: WorkerOwner; token: string };
  setOwnerPaused: { ownerId: string; paused: boolean; reason?: string };
  closeInstance: { appServerInstanceId: string; reason: string };
  closeAll: { reason: string };
  listNotifications: Record<string, never>;
  claimNotifications: { ownerId: string; eventIds: string[]; batchId: string };
  settleNotifications: { batchId: string; delivery: WorkerNotificationDelivery };
};

/** Fixed IPC action names. */
export type WorkerIpcAction = keyof WorkerIpcRequestPayloads;

/** Value of a successful response, keyed by action. */
export type WorkerIpcResponseValues = {
  registerOwner: WorkerOwner;
  setOwnerPaused: { confirmed: true };
  closeInstance: { workerIds: string[] };
  closeAll: { workerIds: string[] };
  listNotifications: WorkerNotification[];
  claimNotifications: { batchId: string; notifications: WorkerNotification[] };
  settleNotifications: { settled: true };
};

/**
 * Inbound host request. `id` is echoed by the response so concurrent requests can be matched.
 * The payload only carries values the host is trusted to assert; ownership is established by
 * `registerOwner` and the plugin's token binding.
 */
export type WorkerIpcRequest = {
  [Action in WorkerIpcAction]: {
    channel: WorkerIpcChannel;
    id: string;
    kind: "request";
    action: Action;
    payload: WorkerIpcRequestPayloads[Action];
  };
}[WorkerIpcAction];

/** Successful IPC response; `value` depends on the request action. */
export type WorkerIpcSuccessResponse = {
  channel: WorkerIpcChannel;
  id: string;
  kind: "response";
  ok: true;
  value: WorkerIpcResponseValues[WorkerIpcAction];
};

/** Failed IPC response; `error` never contains owner tokens or credentials. */
export type WorkerIpcErrorResponse = {
  channel: WorkerIpcChannel;
  id: string;
  kind: "response";
  ok: false;
  error: WorkerError;
};

/** Complete IPC response union. */
export type WorkerIpcResponse = WorkerIpcSuccessResponse | WorkerIpcErrorResponse;

/** Value of a `changed` event: the affected owner and the worker records that changed. */
export type WorkerChangedEventValue = {
  ownerId: string;
  workerIds: string[];
};

/** Event pushed by the plugin; `changed` invalidates state and `notification` is new outbox data. */
export type WorkerIpcEvent =
  | {
      channel: WorkerIpcChannel;
      kind: "event";
      event: "changed";
      value: WorkerChangedEventValue;
    }
  | {
      channel: WorkerIpcChannel;
      kind: "event";
      event: "notification";
      value: WorkerNotification;
    };

//----------------- CODEX HOST BRIDGE ------------

/** Arguments the host passes when registering a Codex thread's temporary Worker MCP config. */
export type CodexWorkerPrepareSessionInput = {
  sessionId: string;
  projectPath: string;
  /** Null is a valid detached-turn identity and must not be replaced with a guessed user id. */
  userId: string | number | null;
  /** Logical Codex runtime identity, independent of the current proxy process. */
  appServerInstanceId: string;
};

/**
 * Callbacks the Codex adapter injects into the Worker plugin instead of importing the Worker
 * module directly. `prepareSession` registers the temporary MCP thread config and never injects
 * the user's Codex skill; `activateSession` runs only for an explicit user turn; `stopSession`
 * and `closeAppServer` forward explicit host lifecycle cleanup. Idle transport exits never
 * close the logical owner. A null `prepareSession` result means no override is needed.
 */
export type CodexWorkerBridge = {
  prepareSession: (
    input: CodexWorkerPrepareSessionInput,
  ) => Promise<Record<string, unknown> | null>;
  activateSession: (sessionId: string) => Promise<void>;
  stopSession: (sessionId: string, reason: string) => Promise<boolean>;
  closeAppServer: (appServerInstanceId: string, reason: string) => Promise<void>;
};
