/** Host-published project identity. Paths are never accepted from browser requests. */
export type SchedulerProject = { id: string; name: string; path: string };
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
/** Private settings; credentials are stripped before creating HTTP responses. */
export type SchedulerSettings = {
  retentionDays: number;
  timeoutSeconds: number;
  maxConcurrentRuns: number;
  timezone: string;
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
