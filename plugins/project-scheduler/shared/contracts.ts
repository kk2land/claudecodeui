/** Host-published project identity. Paths are never accepted from browser requests. */
export type SchedulerProject = { id: string; name: string; path: string };
// Scheduler-internal controls must never be overridden by task or global settings.
const RESERVED_ENV_NAMES = new Set([
  "AGENT_EXEC",
  "CLOUDCLI_HOST_ROOT",
  "CLOUDCLI_PROJECTS_FILE",
]);
const RESERVED_ENV_PREFIXES = ["CLOUDCLI_PLUGIN_", "CLOUDCLI_SCHEDULER_"];
/**
 * Used by the settings editor, its client tests, and server validation so both sides enforce one
 * naming policy. Returns a user-facing reason for an unacceptable variable name, or null.
 * It never receives or echoes variable values.
 */
export function environmentNameError(name: string): string | null {
  if (!name) return "变量名不能为空，请填写或删除空白行";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    return (
      "变量名 “" +
      name +
      "” 不合法：只能包含字母、数字与下划线，且不能以数字开头"
    );
  // Windows treats environment names case-insensitively; protect controls in every casing.
  const normalized = name.toUpperCase();
  if (
    RESERVED_ENV_NAMES.has(normalized) ||
    RESERVED_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  )
    return "变量名 “" + name + "” 为调度器保留变量，不能配置";
  return null;
}
/**
 * Used by the execution-environment editor; rows that repeat a name or fail the naming policy
 * are reported instead of silently collapsing into one map entry. Values are not echoed.
 */
export function environmentRowsToMap(
  rows: ReadonlyArray<{ name: string; value: string }>,
): { env?: Record<string, string>; error?: string } {
  const env = new Map<string, string>();
  for (const row of rows) {
    // A row the user added but never filled in is ignored instead of blocking an unrelated save.
    if (!row.name && !row.value) continue;
    const error = environmentNameError(row.name);
    if (error) return { error };
    if (env.has(row.name))
      return { error: "变量名 “" + row.name + "” 重复，请先修改或删除" };
    if (row.value.includes("\0"))
      return { error: "变量 “" + row.name + "” 的值不能包含 NUL 字符" };
    env.set(row.name, row.value);
  }
  return { env: Object.fromEntries(env) };
}
/**
 * A fresh CLI invocation; a DSH model may include its native provider/model route. `effort` is
 * the provider's reasoning level; an explicit `"default"` cancels inherited effort and is never
 * sent as a CLI argument, while an omitted value keeps the old behavior.
 */
export type SchedulerAgent = {
  provider: "codex" | "dsh";
  model: string;
  effort?: string;
};
/** Validated task definition, snapshotted before each invocation. */
export type SchedulerTask = {
  id: string;
  name: string;
  type: "script" | "prompt";
  enabled: boolean;
  cron: string;
  timezone: string;
  allowConcurrent: boolean;
  timeoutSeconds: number;
  cwd: string;
  env: Record<string, string>;
  agent: SchedulerAgent;
  command?: string;
  args: string[];
  prompt?: string;
  notify: boolean;
};
/**
 * Final result reported by a prompt task and validated by the agent boundary. The worker and
 * scheduler persist it for the run detail view; it describes the task outcome independently of
 * the native process exit code. A reported success does not override a process or agent failure.
 */
export type SchedulerTaskResult = {
  status: "success" | "failed";
  summary: string;
};
/**
 * Provider-reported token totals for one scheduler run, summed across every agent invocation the
 * run made (a prompt plus any script `AGENT_EXEC` calls). A metric is `null` when no invocation
 * reported it, so unknown is never displayed as zero. Cache semantics differ per provider:
 * Codex `cached_input_tokens` is a subset of `input_tokens`, while DSH `inputTokens` is uncached
 * and cache read/write tokens are reported separately. The client explains that overlap.
 */
export type SchedulerTokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};
/**
 * Provenance of a run row. Scheduled-task rows (cron and manual) omit it so every run recorded
 * before resident tasks existed keeps its meaning; only resident terminal rows set `"resident"`.
 * Ordinary run lists therefore exclude a resident row with `run.source !== "resident"`.
 */
export type SchedulerRunSource = "resident";
/** A persisted execution or skipped occurrence. */
export type SchedulerRun = {
  id: string;
  projectId: string;
  projectName: string;
  taskId: string;
  taskName: string;
  status:
    | "running"
    | "success"
    | "failed"
    | "timed_out"
    | "stopped"
    | "interrupted"
    | "skipped_overlap"
    | "skipped_capacity";
  /**
   * What asked for this run. `cron`/`manual` are scheduled tasks; `resident` marks a turn the
   * host issued for a resident binding (continue, enable, or restart resume) and is written only
   * on the binding's terminal row together with `source: "resident"`.
   */
  trigger: "cron" | "manual" | "resident";
  scheduledAt: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  reason: string | null;
  workerPid: number | null;
  /** Absent on runs recorded before usage accounting, and on runs without any agent call. */
  usage?: SchedulerTokenUsage | null;
  /** Absent on legacy runs, script runs, and prompt runs without a valid final task result. */
  taskResult?: SchedulerTaskResult;
  alertStatus: "none" | "pending" | "sent" | "failed";
  alertError: string | null;
  alertAttempts: number;
  /** Present only on resident terminal rows; omitted by every scheduled-task run. */
  source?: SchedulerRunSource;
  /** Resident binding task id; see `ResidentBindingView.taskId`. */
  residentTaskId?: string;
  /** App session the resident turn ran in; the provider-native id lives in the host binding. */
  sessionId?: string;
  /**
   * The chat run's own `executionId` — the identifier the websocket gateway assigned to that
   * turn. It changes per admitted run and is never fabricated across a host restart; the stable
   * replay identity is `ResidentTerminal.id`, which is also the run row's `id`, so re-delivering
   * the same terminal keeps the existing row and its alert counters.
   */
  executionId?: string;
};
/** Browser inventory; definitions and last-result summaries survive log retention. */
export type SchedulerTaskRow = {
  projectId: string;
  projectName: string;
  projectPath: string;
  taskId: string;
  definition: SchedulerTask;
  updatedAt: string;
  nextRun: string | null;
  activeRuns: SchedulerRun[];
  lastRun: SchedulerRun | null;
};
/** Stored settings; the Telegram token is stripped before creating HTTP responses. */
export type SchedulerSettings = {
  retentionDays: number;
  timeoutSeconds: number;
  maxConcurrentRuns: number;
  timezone: string;
  /** Extra variables for every script and prompt run; task env overrides these. */
  env: Record<string, string>;
  telegram: {
    enabled: boolean;
    botToken: string;
    chatId: string;
    proxy: string;
  };
};
/** Public settings contract never includes the stored bot token. */
export type PublicSchedulerSettings = Omit<SchedulerSettings, "telegram"> & {
  telegram: Omit<SchedulerSettings["telegram"], "botToken"> & {
    botTokenConfigured: boolean;
  };
};
/** Atomic per-project import preview. */
export type SchedulerImport = {
  project: SchedulerProject;
  status: "valid" | "missing" | "invalid";
  added: number;
  updated: number;
  removed: number;
  error?: string;
};
/**
 * Raw project configuration document used by the visual/JSON editor. `text` is the unmodified
 * UTF-8 file contents so unknown fields survive a round trip, `revision` is the SHA-256 of those
 * bytes (null when the file is absent), and `exists` distinguishes an empty draft from a file.
 * Invalid JSON is returned verbatim together with `error` so the editor can repair it.
 */
export type SchedulerConfigurationDocument = {
  project: SchedulerProject;
  text: string;
  revision: string | null;
  exists: boolean;
  error?: string;
};
/** Change counters shared by the configuration preview and save result. */
export type SchedulerConfigurationChanges = {
  added: number;
  updated: number;
  removed: number;
  reEnabled: number;
};
/** One validated task with up to five upcoming ISO timestamps; disabled tasks have none. */
export type SchedulerConfigurationTaskPreview = {
  taskId: string;
  nextRuns: string[];
};
/**
 * Non-mutating validation of a draft. `changes` compares the draft with the currently loaded
 * normalized definitions; `reEnabled` counts tasks the draft turns back on after a temporary
 * database-only disable.
 */
export type SchedulerConfigurationPreview = {
  valid: boolean;
  errors?: string[];
  tasks: SchedulerConfigurationTaskPreview[];
  changes: SchedulerConfigurationChanges;
};
/**
 * Result of saving and loading a draft. A conflict never overwrites the file and carries the
 * current document in `latest`. A write can succeed while loading fails; then `saved` is true,
 * `loaded` is false, and `revision` identifies the new file for a same-revision retry.
 */
export type SchedulerConfigurationSave = {
  saved: boolean;
  loaded: boolean;
  revision: string | null;
  changes: SchedulerConfigurationChanges;
  error?: string;
  conflict?: boolean;
  latest?: SchedulerConfigurationDocument;
};
/** Incremental, UTF-8-safe log chunk bounded independently of total output. */
export type SchedulerLog = {
  text: string;
  offset: number;
  hasMore: boolean;
  expired: boolean;
  truncated: boolean;
};

//----------------- RESIDENT BINDINGS ------------

/**
 * Resident ("常驻") tasks reuse an already-running foreground Codex session (whichever
 * runtime that session already uses — app-server or the exec/SDK adapter) or a DSH session
 * instead of launching a scheduler process. The host owns every piece of run state in its single
 * `resident` binding table; the plugin only owns task metadata, alert preferences and the
 * terminal cursor. This section is the only shared definition of that protocol: the host module,
 * the plugin server/client, and the browser view all import it, so nothing here may be duplicated
 * downstream.
 *
 * Not here on purpose: provider options, credentials, prompts, model/effort/runtime selection
 * (those follow the existing session), and the plugin's own `resident_tasks` columns.
 */

/** Providers whose foreground sessions can become resident; matches `SchedulerAgent["provider"]`. */
export type ResidentProvider = "codex" | "dsh";

/**
 * Lifecycle of one binding as the host reports it. `idle` never started, `running` has an active
 * provider run, `stopping` is waiting for that run to exit, and `stopped` holds a terminal
 * episode; a stopped binding resumes only on an explicit continue or enable.
 */
export type ResidentTaskStatus = "idle" | "running" | "stopping" | "stopped";

/**
 * Why the last execution ended. `completed` is a natural finish and `failed` a provider error;
 * `recovery_failed` means the host could not resume a binding that was running across a restart.
 * Those three alert. `user_stopped` (foreground or plugin stop), `disabled`, and `deleted` are
 * deliberate user actions and stay silent, but they still record a terminal episode.
 */
export type ResidentStopCause =
  | "completed"
  | "failed"
  | "recovery_failed"
  | "user_stopped"
  | "disabled"
  | "deleted";

/**
 * Read-only permission context captured at adoption so a restart can resume the same native
 * session. `permissionMode` is the provider's approval/permission setting and `sandboxMode` the
 * Codex sandbox (null for providers without a separate axis). Never carries credentials or a
 * full provider-options blob.
 */
export type ResidentRuntimeSnapshot = {
  provider: ResidentProvider;
  permissionMode: string | null;
  sandboxMode: string | null;
};

/**
 * One finished resident episode, delivered to the plugin by the `terminal` event and kept as the
 * binding's `terminal`. `id` is stable for that episode and becomes the plugin's `SchedulerRun.id`
 * (`source: "resident"`), so a re-delivered snapshot cannot create a second run or reset
 * `alertAttempts`; `executionId` is the actual chat run id and is only informational there. `alert` is host-computed: only unexpected ends alert, and the plugin still
 * reuses its existing Telegram pending/retry delivery for those.
 */
export type ResidentTerminal = {
  id: string;
  taskId: string;
  sessionId: string;
  executionId: string;
  /** Outcome recorded on the plugin run row; independent of `cause` for alert policy. */
  status: "success" | "failed" | "stopped" | "interrupted";
  cause: ResidentStopCause;
  alert: boolean;
  /** ISO-8601 UTC timestamp of the terminal boundary. */
  endedAt: string;
  /** User-facing failure detail; null for a normal end. Never contains credentials. */
  reason: string | null;
  /** Token totals for this execution when the provider reported them; null when unknown. */
  usage?: SchedulerTokenUsage | null;
};

/**
 * Host-authoritative view of one binding. Returned by every IPC action, and extended by the
 * plugin with its own metadata to form `ResidentTaskRow`. Fields are deliberately read-only for
 * the plugin: writing them back would create a second state authority.
 */
export type ResidentBindingView = {
  /** Plugin-generated task id; unique per binding and never reused after removal. */
  taskId: string;
  /**
   * The linked session's current title (its custom name, trimmed like every other session
   * surface), so a sidebar rename is reflected on the next read. The title captured at adoption
   * remains the fallback when the session has no usable title or no longer exists; it is never
   * rewritten by this projection.
   */
  name: string;
  sessionId: string;
  projectId: string;
  enabled: boolean;
  /** Foreground visibility of the session; true at adoption unless the user hides it later. */
  visible: boolean;
  /** Protection is implied by the binding's existence, not by `enabled` or `visible`. */
  status: ResidentTaskStatus;
  /** Current chat run's execution id while `running`/`stopping`; the last one after a terminal. */
  executionId: string | null;
  stopCause: ResidentStopCause | null;
  runtime: ResidentRuntimeSnapshot;
  /**
   * Latest terminal episode; null before the first end. Retained independently of later runs: a
   * new admission clears `stopCause` only, so an episode the plugin has not processed yet can
   * still be delivered.
   */
  terminal: ResidentTerminal | null;
  /** ISO-8601 UTC timestamps issued by the host. */
  createdAt: string;
  updatedAt: string;
};

/** Why a session cannot become resident right now; the UI uses it to explain a greyed menu item. */
export type ResidentAdoptBlockedReason =
  | "already_resident"
  | "not_running"
  | "unsupported_provider"
  | "plugin_unavailable";

/**
 * Resident metadata the server attaches as `resident` to its existing session projections (list,
 * detail, and the REST lookup-by-id used to open a hidden resident session). `taskId` is null
 * when the session is not bound, and a non-null value is the session's protection marker: it
 * survives disabled/hidden bindings and a stopped or disabled plugin. `adoptable` is only true
 * for a running foreground turn of a supported provider with the plugin available and no
 * existing binding, so the three-dot menu never needs to re-derive those rules.
 */
export type ResidentSessionInfo = {
  taskId: string | null;
  status: ResidentTaskStatus | null;
  enabled: boolean;
  visible: boolean;
  adoptable: boolean;
  blockedReason: ResidentAdoptBlockedReason | null;
};

/** Why an explicit continue was not accepted. An active binding is reported, not interrupted. */
export type ResidentContinueBlockReason = "already_running" | "disabled";

/**
 * Result of an explicit continue (plugin button or re-enable). `accepted` means the host admitted
 * one provider turn in the binding's original native session; `executionId` identifies it and is
 * awaited by the host, never by the caller. A non-accepted continue is a normal answer, not an
 * error.
 */
export type ResidentContinueResult = {
  accepted: boolean;
  executionId: string | null;
  reason: ResidentContinueBlockReason | null;
};

/** Result of removing a task after its stop succeeded; the session itself is always kept. */
export type ResidentRemoveResult = {
  removed: true;
  sessionId: string;
};

//----------------- RESIDENT HTTP DTOs ------------

/**
 * One row of `GET /resident-tasks`: the host binding plus `notify`, the plugin-owned alert
 * preference. `terminal` is the host's latest episode; the plugin's run history is separate.
 */
export type ResidentTaskRow = ResidentBindingView & {
  /** Master alert switch for this task, set at creation and stored only in the plugin database. */
  notify: boolean;
};

/** `GET /resident-tasks` body. */
export type ResidentTaskListResponse = {
  tasks: ResidentTaskRow[];
};

/**
 * `GET /resident-tasks/:id` body. History and live output are read from the original session
 * (host session APIs plus `SessionOutput`), not embedded here; `runs` only lists the plugin's
 * recorded terminal rows, newest first.
 */
export type ResidentTaskDetail = ResidentTaskRow & {
  runs: SchedulerRun[];
};

/** `POST /resident-tasks/:id/continue`: `task` is the binding's current state after the attempt. */
export type ResidentContinueResponse = {
  task: ResidentTaskRow;
  result: ResidentContinueResult;
};

//----------------- STAGE LOGS ------------

/**
 * Stage logs an agent reports for one resident task: short business checkpoints ("deployed staging",
 * "test suite failed"), not terminal run rows. The host stores them for seven days and derives the
 * task, session and execution ids on the server, so a tool caller only supplies content/status.
 * `source` distinguishes agent reports from host lifecycle entries.
 */
export type StageLogSource = "agent" | "system";

/**
 * One stored stage log. `occurredAt` is what the agent reported (the host substitutes its own now
 * when omitted) and `createdAt` is host-issued and is the only retention/pagination basis.
 * `executionId` is the chat run the entry belongs to, or null for an entry recorded while the
 * binding had no execution. `status` is free text chosen by the caller (success/failed/skipped/...).
 */
export type StageLogEntry = {
  id: string;
  taskId: string;
  sessionId: string;
  executionId: string | null;
  source: StageLogSource;
  occurredAt: string;
  createdAt: string;
  content: string;
  status: string;
  phase?: string;
  data?: Record<string, unknown>;
};

/**
 * MCP `stage_log` input. The server derives the owning task/session/execution from the MCP
 * token; no id, source, timestamp or status vocabulary is trusted from the caller beyond these
 * fields.
 */
export type StageLogInput = {
  content: string;
  status: string;
  /**
   * ISO-8601 timestamp of the event itself. Only an omitted value defaults to the host's now; an
   * invalid value is rejected at the MCP boundary (callers cannot forge `createdAt`, which is
   * always server-issued and is the sole retention/pagination basis).
   */
  occurredAt?: string;
  phase?: string;
  /** Small JSON object for structured detail; the host stores it as reported. */
  data?: Record<string, unknown>;
};

/**
 * `stage_log` result. `recorded: false` with `not_resident` means this session has no resident
 * binding yet (for example a plain foreground chat that injected the tool), so the agent should
 * not retry this entry but may keep calling the tool for later nodes once adopted. A disabled
 * plugin is reported by the MCP route as unavailable instead of this value.
 */
export type StageLogRecorded =
  | { recorded: true; log: StageLogEntry }
  | { recorded: false; reason: "not_resident" };

/** Newest-first page size for `logs`; the host applies these defaults and bounds. */
export const STAGE_LOG_DEFAULT_LIMIT = 50;
export const STAGE_LOG_MAX_LIMIT = 100;

/**
 * `logs` request payload. `cursor` is an opaque host-issued token (never parsed by the caller) and
 * orders by `createdAt` then `id`.
 */
export type StageLogQuery = {
  taskId: string;
  cursor?: string;
  limit?: number;
};

/** `logs` response value: one newest-first page plus the opaque cursor for the next older page. */
export type StageLogPage = {
  logs: StageLogEntry[];
  nextCursor: string | null;
};

//----------------- RESIDENT HOST IPC PROTOCOL ------------

/** Fixed IPC channel between the host resident module and the bundled scheduler plugin. */
export type ResidentIpcChannel = "cloudcli-scheduler-resident";

/**
 * Payload of each plugin-to-host request. Only ids and booleans cross the wire: the host resolves
 * the session, approval context, provider and owner itself, and the plugin never sends provider
 * options, prompts, or credentials.
 */
export type ResidentIpcRequestPayloads = {
  /** Binds an already-running foreground session. The plugin generates `taskId`; the host rejects a duplicate session binding. */
  adopt: { taskId: string; sessionId: string };
  /** One binding, or every binding when `taskId` is omitted. Also used for plugin-ready reconciliation. */
  status: { taskId?: string };
  setEnabled: { taskId: string; enabled: boolean };
  setVisible: { taskId: string; visible: boolean };
  stop: { taskId: string };
  continue: { taskId: string };
  /** Unbinds after a confirmed stop and keeps the session; the task metadata row is the plugin's. */
  remove: { taskId: string };
  /** Newest-first page of the host's seven-day stage logs for one task. */
  logs: StageLogQuery;
};

/** Fixed IPC action names. */
export type ResidentIpcAction = keyof ResidentIpcRequestPayloads;

/** Value of a successful response, keyed by action. */
export type ResidentIpcResponseValues = {
  adopt: { binding: ResidentBindingView };
  status: { bindings: ResidentBindingView[] };
  setEnabled: { binding: ResidentBindingView };
  setVisible: { binding: ResidentBindingView };
  stop: { binding: ResidentBindingView };
  continue: { result: ResidentContinueResult; binding: ResidentBindingView };
  remove: ResidentRemoveResult;
  logs: StageLogPage;
};

/**
 * Machine-readable IPC failure. Unlike the plugin's HTTP error envelope this is typed so the
 * plugin can distinguish "retry later" (`stop_failed`, `continue_failed`) from a permanent state
 * answer. `message` is safe to display and never contains credentials.
 */
export type ResidentError = {
  code:
    | "invalid_request"
    | "not_found"
    | "already_resident"
    | "unsupported_provider"
    | "not_running"
    | "session_unavailable"
    | "active_execution"
    | "stop_failed"
    | "continue_failed";
  message: string;
};

/**
 * Response direction differs from the Worker channel: the plugin initiates every request (its
 * HTTP handlers) and the host answers, while lifecycle events flow host-to-plugin.
 */
export type ResidentIpcRequest = {
  [Action in ResidentIpcAction]: {
    channel: ResidentIpcChannel;
    id: string;
    kind: "request";
    action: Action;
    payload: ResidentIpcRequestPayloads[Action];
  };
}[ResidentIpcAction];

/** Successful response; `value` depends on the request action. */
export type ResidentIpcSuccessResponse = {
  channel: ResidentIpcChannel;
  id: string;
  kind: "response";
  ok: true;
  value: ResidentIpcResponseValues[ResidentIpcAction];
};

/** Failed response; the request id is echoed so concurrent requests can be matched. */
export type ResidentIpcErrorResponse = {
  channel: ResidentIpcChannel;
  id: string;
  kind: "response";
  ok: false;
  error: ResidentError;
};

/** Complete IPC response union. */
export type ResidentIpcResponse = ResidentIpcSuccessResponse | ResidentIpcErrorResponse;

/**
 * Events pushed by the host. `sync` follows every plugin (re)start with the complete binding
 * snapshot so the plugin reconciles its stored tasks without prompting a continue; the plugin
 * ignores terminals it already processed via its stored cursor. `terminal` announces one new
 * episode, and `changed` is the cheap invalidation for enabled/visible/adopt/remove.
 */
export type ResidentIpcEvent =
  | {
      channel: ResidentIpcChannel;
      kind: "event";
      event: "sync";
      value: { bindings: ResidentBindingView[] };
    }
  | {
      channel: ResidentIpcChannel;
      kind: "event";
      event: "terminal";
      value: ResidentTerminal;
    }
  | {
      channel: ResidentIpcChannel;
      kind: "event";
      event: "changed";
      value: { taskIds: string[] };
    };
