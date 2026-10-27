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
/** A fresh CLI invocation; a DSH model may include its native provider/model route. */
export type SchedulerAgent = { provider: "codex" | "dsh"; model: string };
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
  trigger: "cron" | "manual";
  scheduledAt: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  reason: string | null;
  workerPid: number | null;
  alertStatus: "none" | "pending" | "sent" | "failed";
  alertError: string | null;
  alertAttempts: number;
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
/** Incremental, UTF-8-safe log chunk bounded independently of total output. */
export type SchedulerLog = {
  text: string;
  offset: number;
  hasMore: boolean;
  expired: boolean;
  truncated: boolean;
};
