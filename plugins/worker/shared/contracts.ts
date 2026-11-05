/**
 * Pure TypeScript contracts shared by the Worker plugin, the Codex host bridge, and the UI.
 *
 * This module contains types only: importing it must never pull in plugin runtime code. The
 * host re-exports the subset that it actually consumes from `server/shared/index.ts`; downstream
 * plugin modules should import from this file so the contract stays identical on both sides of
 * the process boundary.
 */

import type { WorkerTaskRole } from "./task-roles.js";

export type { WorkerTaskRole };

//----------------- WORKER IDENTITY AND STATUS ------------

/**
 * Native worker runner implemented by the CloudCLI Worker plugin: DSH headless, Pi print/JSON, or
 * `codex exec`.
 */
export type WorkerType = "dsh" | "pi" | "codex";

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

/** Statuses that hold one slot of the `(parentSessionId, projectId, configId)` key. */
export type WorkerOccupyingStatus = Extract<
  WorkerStatus,
  "starting" | "running" | "stopping" | "unknown"
>;

/** `running` marks a soft-budget reminder; the other values describe a terminal result. */
export type WorkerNotificationStatus = Extract<
  WorkerStatus,
  "running" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown"
>;

/** Deduplication state of an outbox notification. `batchId` is set once a host claims it. */
export type WorkerNotificationDelivery = "pending" | "delivered" | "held" | "unknown";

/** Machine-readable API/IPC failure; the message is safe to display and never contains tokens. */
export type WorkerError = {
  code: string;
  message: string;
};

//----------------- COLLABORATION PLAN ------------

/**
 * The parent-maintained Markdown plan for one logical parent session and project. Dependencies,
 * acceptance evidence, and Worker/Run references are prose, not scheduler inputs. The plan
 * survives owner generation changes and run retention; updatedAt is a server-issued ISO timestamp.
 */
export type WorkerPlan = {
  content: string;
  updatedAt: string;
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
   * Configuration to use for a new worker. An explicit `configId` wins over `type`/`taskRole`,
   * must exist and be enabled, and must agree with an explicit `type`. When omitted, routing
   * considers only enabled configs: an optional explicit `type` narrows the list first, then
   * `taskRole` selects matching configs, preferring the default config and otherwise the first
   * in list order; with no role match it falls back to the type-constrained candidates. The
   * chosen config is recorded on the worker. An omitted key is left out of the replay
   * fingerprint entirely (never recorded as null), so a replay keeps its original config.
   */
  configId?: string;
  /**
   * Optional engine filter for a new worker. It only narrows which enabled configs are
   * routable; it never selects an engine independently of a config. With `configId` it must
   * agree with that config's type. With no role match the type-constrained candidates are used.
   * Ignored on resume, which keeps the worker's recorded config.
   */
  type?: WorkerType;
  /**
   * Requested task role; one of `WORKER_TASK_ROLES`. A role only narrows which enabled config an
   * omitted `configId`/`type` selects, so it applies to new workers only: a resume keeps the
   * worker's recorded config and type.
   */
  taskRole?: WorkerTaskRole;
  prompt: string;
  workspace: WorkerStartWorkspace;
  /**
   * Required declared modification scope, relative to the resolved cwd; `[]` means a read-only
   * task. This tells the worker what it may change and scopes review/cleanup checks; it is not an
   * additive filesystem permission beyond the workspace, and parallel workers may share a cwd.
   */
  writePaths: string[];
  /**
   * Optional native model override. Explicit selections win over configured defaults and over
   * Codex extra args. Pi/DSH receive one complete native model identifier (for example
   * `provider/model`) and their CLI/adapter resolves the route; they have no independent service.
   */
  model?: string;
  /** Independent model service, supported only for Codex; non-Codex requests reject it. */
  provider?: string;
  /**
   * Native reasoning effort. DSH requires an explicit model before effort can be applied; Pi
   * accepts only its native thinking levels.
   */
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
 * each resume creates its own `runId` and may override model/effort explicitly. An independent
 * provider is Codex-only. Codex resumes its recorded native session id with `codex exec resume`;
 * old non-Codex providers are folded into the full model id.
 */
export type WorkerResumeInput = {
  workerId: string;
  prompt: string;
  model?: string;
  /** Independent model service, supported only for Codex; non-Codex requests reject it. */
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

/**
 * One normalized counter snapshot. Every unknown or unreported value is null; a reported zero
 * stays zero and is never confused with an unreported field.
 */
export type WorkerTokenCounters = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
};

/**
 * Token usage reported by the native runner. The original three fields stay compatible with
 * older records; new parsers always fill `cacheReadTokens` and `cacheWriteTokens`.
 *
 * `inputTokens` keeps the native meaning per engine: DSH/Pi input excludes cache tokens while
 * Codex input already includes them. `totalTokens` prefers the native total. For DSH/Pi the
 * fallback sum is input + output + cache read + cache write, and only when one sample reports
 * all four; Codex falls back to input + output because cache is already inside input. `scope`
 * says whether the counters
 * describe this run or the whole native session, and `partial` means the visible statistics
 * have a gap (interruption, cancellation, or an incompatible counter shape). Unknown values
 * stay null and are never estimated or clipped to zero. Older records may omit the optional
 * keys; readers must treat a missing scope as unknown and a missing partial as false.
 * `cacheWriteTokens` includes the 1h cache write subset where the native source reports it.
 */
export type WorkerUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  scope?: "run" | "session" | "unknown";
  partial?: boolean;
};

/**
 * Measurement start for Codex session-cumulative counters. A new thread stores a known
 * all-zero `WorkerTokenCounters` baseline (not null); null only means a resume had no trusted
 * baseline. `counters` is the last `total_token_usage` snapshot before launch when trusted;
 * `offset` is the rollout EOF read at launch (0 for a new thread, or the later usable start).
 * The run's native rollout file is `WorkerRun.nativeSessionFile`. The baseline only marks
 * where this run starts: it never fabricates native history, is never derived from a previous
 * run's `usage`, and contains no sensitive data. Runtime must capture it before launch, not
 * while queued; a resume reuses the matching session rollout.
 */
export type WorkerCodexUsageBaseline = {
  counters: WorkerTokenCounters | null;
  offset: number;
};

/**
 * Observable execution progress used by reminders and the UI. `steps` is null when the native
 * runner does not report validated steps; `phase` and `currentTool` are null until the runner
 * reports an actual running phase/tool. The first soft reminder defaults to 600 seconds / 20
 * steps; subsequent reviews use `WorkerSettings.softReminderSeconds` since the latest reminder.
 * `hardTimeoutAt` is null unless a hard timeout was configured.
 */
export type WorkerRunProgress = {
  steps: number | null;
  phase: string | null;
  currentTool: string | null;
  lastEventAt: string | null;
  /** Most recent reminder creation time, or null before the first budget review. */
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
  /**
   * Selection snapshotted at admission. Historical runs migrated from before configs existed
   * keep any recorded value; only a missing value is filled from the run's own reliable
   * `spec.json` argv. Without spec evidence the legacy null is preserved instead of guessing
   * from current settings.
   */
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
  /**
   * Codex-only measurement start for session-cumulative token counters; absent for other
   * engines and for older records. See `WorkerCodexUsageBaseline`.
   */
  codexUsageBaseline?: WorkerCodexUsageBaseline;
  /**
   * Set only by the schema-2 migration on a Codex run that had no reliable recorded provider
   * (no run value and no spec argv evidence). It preserves the old resume behavior by letting
   * the launch use the worker's current config `modelProvider` as a fallback without ever
   * pretending that provider was the run's historical value. Kept across resumes until an
   * explicit provider is supplied; new runs never set it.
   */
  legacyCodexProvider?: true;
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
  /**
   * Configuration that created this worker; fixed for the worker's lifetime, including every
   * resume. Workers recorded before configs existed are backfilled by the schema-2 migration
   * with the initial config of their `type` in one transaction.
   */
  configId: string;
  /** Snapshot of the config's name at creation, kept for display after later renames. */
  configName: string;
  taskName: string;
  /** Task role recorded at creation; absent on workers created before roles existed. */
  taskRole?: WorkerTaskRole;
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
 * A persisted soft-budget reminder (`status: running`) or terminal result waiting for the host
 * to wake the parent session. A running task can produce periodic reminders, with at most one
 * undelivered reminder at a time and one terminal result per run. Notifications live in the
 * plugin outbox and never consume the user's three-message queue.
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

//----------------- WORKER CONFIGS, SETTINGS, COUNTS, AND UI SNAPSHOTS ------------

/**
 * One named, reusable execution configuration. `id` is a stable client-generated UUID chosen
 * when the config is created; renaming keeps it, deletion never allows reuse while worker
 * history still references it, and a config's `type` cannot change while any worker or run
 * history still references it (see `WorkerConfigUsage.referenced`). `configs` is the single
 * canonical source of per-engine settings; there is no separate `engine` field copying `type`.
 *
 * `model`/`effort` are the configured defaults used only when a request omits explicit
 * selections; null means the runner's own default. Pi stores the complete native model id,
 * which is often `provider/model`.
 * `codex` is present for `type: "codex"` configs only: `modelProvider` is the Codex inference
 * service (null keeps Codex's own default), `env` is merged over the inherited environment for
 * the run, and `legacyExtraArgs` are separate `codex exec` argv entries that were originally
 * configured as extra args. Codex env values never enter `WorkerRun` or MCP-visible output.
 */
export type WorkerConfig = {
  id: string;
  name: string;
  type: WorkerType;
  enabled: boolean;
  roles: WorkerTaskRole[];
  concurrency: number;
  model: string | null;
  effort: string | null;
  codex?: WorkerCodexConfig;
};

/** Codex-only part of a `WorkerConfig`; see `WorkerConfig.codex`. */
export type WorkerCodexConfig = {
  modelProvider: string | null;
  env: Record<string, string>;
  legacyExtraArgs: string[];
};

/**
 * Configured model and native reasoning effort projected for one worker type. Null means the
 * runner's existing native default; no plugin environment variable overrides Pi/DSH selection.
 * Codex uses its config plus configured extra args. Explicit start/resume selections take
 * precedence over these defaults.
 */
export type WorkerDefault = {
  model: string | null;
  effort: string | null;
};

/** Per-type configured defaults, projected from `WorkerConfig` for legacy readers only. */
export type WorkerDefaults = Record<WorkerType, WorkerDefault>;

/**
 * Legacy read-only projection of the Codex config selected by `WorkerSettings`'s per-engine
 * projection rule. It is never persisted on its own and is replaced as a whole only by the
 * legacy settings input. `env` is merged over the inherited environment, with a same-named key
 * replacing the inherited value; `extraArgs` are separate argv entries and are never joined into
 * a shell command. Settings are re-read for each start/resume, while the run's recorded home,
 * cwd, and native session identity stay fixed; explicit model/provider/effort selections win over
 * extra args. Environment values are settings-only and are never copied into `WorkerRun`.
 */
export type WorkerCodexSettings = {
  env: Record<string, string>;
  extraArgs: string[];
};

/**
 * Effective worker settings: the canonical read shape of `GET /state` and `PUT /settings`.
 *
 * Persisted canonical state is `schemaVersion`, `configs`, `defaultConfigId`, and the global
 * retention/reminder/timeout values. `schemaVersion` is server-managed and is never supplied by
 * clients. `defaultConfigId` must reference an enabled entry in `configs`.
 *
 * `concurrency`, `enabled`, `roles`, `defaults`, `codex`, and `defaultWorkerType` are READ-ONLY
 * compatibility projections, never a second persistence source. Per engine they project the
 * engine's default config when `defaultConfigId` belongs to that engine, otherwise the first
 * config of that engine in list order; when an engine has no config, `enabled` is false, `roles`
 * is `[]`, `concurrency` is 1, `defaults` is null model/effort, and `codex` is empty env/args.
 * `defaultWorkerType` projects the type of `defaultConfigId`. Writers must update `configs`.
 *
 * Concurrency applies per `(parentSessionId, projectId, configId)` key. The first soft reminder
 * defaults to 600 seconds / 20 steps, followed by timed reviews every `softReminderSeconds`; no
 * hard timeout is applied by default.
 *
 * A config's `enabled` gates both newly accepted starts and newly accepted resumes; a run that
 * was already accepted, including queued work, is unchanged. `roles` only routes the config of a
 * new worker and never changes an existing worker or resume. A replayed request returns its
 * original record instead of reading these settings again.
 *
 * The schema-2 migration creates the initial fixed configs `dsh-default`, `pi-default`, and
 * `codex-default` (names "DSH default", "Pi default", "Codex default") from the previous
 * per-type maps and defaults, and sets `defaultConfigId` to the initial config matching the
 * previous `defaultWorkerType` (initially `dsh-default`).
 */
export type WorkerSettings = {
  schemaVersion: 2;
  configs: WorkerConfig[];
  defaultConfigId: string;
  /** Read-only projection; see the type comment. */
  readonly concurrency: Record<WorkerType, number>;
  /** Read-only projection of the `defaultConfigId` config's type. */
  readonly defaultWorkerType: WorkerType;
  /** Read-only projection; an engine with no config is false. */
  readonly enabled: Record<WorkerType, boolean>;
  /** Read-only projection; an engine with no config is `[]`. */
  readonly roles: Record<WorkerType, WorkerTaskRole[]>;
  /** Read-only projection; an engine with no config is null model/effort. */
  readonly defaults: WorkerDefaults;
  /** Read-only projection; an engine with no config is empty env/args. */
  readonly codex: WorkerCodexSettings;
  /** Days to retain finished runs and their logs, measured from finishedAt; initially 1. */
  retentionDays: number;
  softReminderSeconds: number;
  softReminderSteps: number;
  hardTimeoutSeconds: number | null;
};

/**
 * Canonical `PUT /settings` input. `configs` is replaced as a whole and validated atomically
 * before anything is persisted: ids are unique, `defaultConfigId` references an enabled config,
 * and an existing config keeps its `type` while referenced. Deployment-owned reminder and
 * timeout values stay server-owned. An omitted `retentionDays` keeps the stored value.
 */
export type WorkerSettingsUpdate = {
  configs: WorkerConfig[];
  defaultConfigId: string;
  retentionDays?: number;
};

/**
 * Legacy `PUT /settings` input, still accepted for older clients. It can only edit the initial
 * fixed configs `dsh-default` / `pi-default` / `codex-default`, matched by id even after they are
 * renamed: each supplied map entry updates the matching initial config, and a supplied
 * `defaultWorkerType` selects its initial config as `defaultConfigId`. If an initial config has
 * since been deleted the whole update is rejected; user-added configs are never editable through
 * this input.
 *
 * Concurrency and defaults stay compatible with older clients: `dsh`/`pi` are required while
 * `codex` is optional and keeps its existing value when omitted. A supplied `defaults` must
 * contain both `dsh` and `pi`; a supplied `codex` object must include both `env` and `extraArgs`
 * and replaces the whole Codex launch block: `modelProvider` is re-extracted from the new
 * `extraArgs` and cleared when they no longer name one. Blank or null model/effort values clear
 * that configured default. `retentionDays` must be a positive integer.
 *
 * `enabled` and `roles` are whole-setting optional: when a map is supplied it must contain all
 * three of `dsh`, `pi`, and `codex`; when omitted the stored value is kept. A supplied
 * `defaultWorkerType` must reference an initial config that is enabled afterwards.
 */
export type WorkerLegacySettingsInput = {
  concurrency: { dsh: number; pi: number } & { codex?: number };
  defaultWorkerType?: WorkerType;
  enabled?: Record<WorkerType, boolean>;
  roles?: Record<WorkerType, WorkerTaskRole[]>;
  defaults?: { dsh: WorkerDefault; pi: WorkerDefault } & { codex?: WorkerDefault };
  codex?: WorkerCodexSettings;
  retentionDays?: number;
};

/** `PUT /settings` accepts either the canonical shape or the mapped legacy shape. */
export type WorkerSettingsInput = WorkerSettingsUpdate | WorkerLegacySettingsInput;

/**
 * Credential-free config view exposed to MCP/model-visible context. Codex configs carry only
 * `modelProvider`; `env` and `legacyExtraArgs` remain in the authenticated UI REST/state view.
 */
export type WorkerConfigMcpView = Omit<WorkerConfig, "codex"> & {
  codex?: { modelProvider: string | null };
};

/**
 * MCP-safe settings view: canonical configs without Codex env/args plus the same read-only
 * per-engine projections as `WorkerSettings`, so older MCP guidance and tools keep working.
 */
export type WorkerMcpSettings = {
  configs: WorkerConfigMcpView[];
  defaultConfigId: string;
  defaultWorkerType: WorkerType;
  enabled: Record<WorkerType, boolean>;
  roles: Record<WorkerType, WorkerTaskRole[]>;
  concurrency: Record<WorkerType, number>;
  defaults: WorkerDefaults;
  retentionDays: number;
  softReminderSeconds: number;
  softReminderSteps: number;
  hardTimeoutSeconds: number | null;
};

//----------------- MODEL CATALOGS ------------

/**
 * One selectable model row. It mirrors the host provider catalog; additional host fields are
 * ignored by the Worker config editor. `effort` lists the real configured levels for this model.
 */
export type WorkerModelOption = {
  value: string;
  label: string;
  description?: string;
  effort?: {
    default?: string;
    values: Array<{ value: string; description?: string }>;
  };
};

/** Read-only provider model catalog used by the config editor. */
export type WorkerModelCatalog = {
  DEFAULT: string;
  OPTIONS: WorkerModelOption[];
  EFFORT_LEVELS?: string[];
};

/** Credential-free Codex inference-service directory from the host provider API. */
export type CodexModelsDirectory = {
  defaultProvider: string;
  providers: Array<{ id: string; name: string }>;
  hasCustomProviders?: boolean;
};

/** Models exposed by one Codex inference service; never carries provider credentials. */
export type CodexServiceModelCatalog = {
  modelProvider: string;
  models: string[];
};

/** One Pi model from the plugin's `GET /catalog/pi` response. */
export type PiModelOption = {
  provider: string;
  id: string;
  reasoning: boolean;
};

/**
 * `GET /catalog/pi` response. Pi stays a Worker execution engine and is not added to the host's
 * global `LLMProvider`; `thinkingLevels` are the native levels accepted as `effort`.
 */
export type PiModelCatalog = {
  models: PiModelOption[];
  thinkingLevels: string[];
};

/**
 * Optional authenticated host catalog capabilities. The Worker client adds these as optional
 * `models` / `codexModelProviders` / `codexModelProviderModels` members of `WorkerHost` in
 * `client/api.ts`; a missing capability must read as "catalog unavailable".
 */
export type WorkerHostCatalogCapabilities = {
  models?(provider: "codex" | "dsh"): Promise<WorkerModelCatalog>;
  codexModelProviders?(): Promise<CodexModelsDirectory>;
  codexModelProviderModels?(modelProvider: string): Promise<CodexServiceModelCatalog>;
};

/** Worker counts keyed by every lifecycle status; absent keys are zero only in serialized data. */
export type WorkerCountsByStatus = Record<WorkerStatus, number>;

/** Number of workers in each lifecycle status; `total` is the sum across all worker types. */
export type WorkerCounts = {
  dsh: WorkerCountsByStatus;
  pi: WorkerCountsByStatus;
  codex: WorkerCountsByStatus;
  total: WorkerCountsByStatus;
};

/**
 * Reference usage of one config across the WHOLE store, never narrowed by a `GET /state`
 * project/session filter, so the UI can forbid deletion and engine changes reliably.
 * `referenced` is true when any worker record or run history uses the config, which locks its
 * engine and forbids reusing a deleted id. `activeRuns` counts non-terminal runs
 * (queued/starting/running/stopping/unknown) and is what blocks deletion; after a config is
 * deleted, terminal workers keep its name snapshot. Configs with no usage are absent from the
 * map, and ids referenced only by deleted-config history remain present.
 */
export type WorkerConfigUsage = {
  referenced: boolean;
  activeRuns: number;
};

/**
 * `GET /state` payload. Host/MCP control tokens are never present. This authenticated view
 * returns real stored settings including Codex env; the MCP/model-visible view uses
 * `WorkerMcpSettings`, which omits Codex env and extra args.
 */
export type WorkerStateSnapshot = {
  workers: WorkerRecord[];
  counts: WorkerCounts;
  settings: WorkerSettings;
  /** Per-config usage for `settings.configs`, computed from the whole store. */
  configUsage: Record<string, WorkerConfigUsage>;
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
  hasActiveWorkers: { ownerId: string };
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
  hasActiveWorkers: boolean;
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
  /**
   * True while this runtime's owner has at least one non-terminal Worker run.
   * Idle transport/proxy recycling consults it without changing Worker state.
   */
  hasActiveWorkers: (sessionId: string) => Promise<boolean>;
  /**
   * True while this parent still has a non-terminal Worker run or a pending
   * result/reminder notification that this turn is not already handling.
   * `handlingBatchId` is the trusted outbox batch of the automatic result turn
   * asking; only that batch's claimed notifications are ignored. A user turn
   * passes none, so every pending notification still blocks its prediction.
   */
  hasUnsettledWorkers?: (sessionId: string, handlingBatchId?: string) => Promise<boolean>;
};
