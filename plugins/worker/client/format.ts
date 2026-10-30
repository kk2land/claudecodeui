import type {
  WorkerCountsByStatus,
  WorkerNotificationDelivery,
  WorkerOccupyingStatus,
  WorkerSettings,
  WorkerStateQuery,
  WorkerStatus,
  WorkerType,
  WorkerUsage,
} from "../shared/contracts.js";
import type { WorkerPluginContext } from "./api.js";

/** The three view scopes supported by the panel. */
export type WorkerScope = "session" | "project" | "all";

/** Statuses that visibly hold a concurrency slot. */
export const OCCUPYING_STATUSES: WorkerOccupyingStatus[] = [
  "starting",
  "running",
  "stopping",
  "unknown",
];

/** User-facing labels; statuses are otherwise shown verbatim in diagnostics. */
export const STATUS_LABELS: Record<WorkerStatus, string> = {
  queued: "排队中",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  unknown: "状态未知",
};

/** Short type names used in badges and count cards. */
export const TYPE_LABELS: Record<WorkerType, string> = {
  dsh: "DSH",
  pi: "Pi",
};

export const DELIVERY_LABELS: Record<WorkerNotificationDelivery, string> = {
  pending: "待领取",
  delivered: "已送达",
  held: "暂缓",
  unknown: "未知",
};

/**
 * Filters the panel to the current host session/project. A scope that cannot be satisfied is
 * coerced to `all` so a disabled tab can never issue an unfiltered-looking session query.
 */
export function effectiveScope(
  scope: WorkerScope,
  context: WorkerPluginContext,
): WorkerScope {
  if (scope === "session") return context.session && context.project ? "session" : "all";
  if (scope === "project") return context.project ? "project" : "all";
  return "all";
}

/** Builds the `GET /state` query for a scope; `all` deliberately sends no filter. */
export function scopeQuery(
  scope: WorkerScope,
  context: WorkerPluginContext,
): WorkerStateQuery {
  const effective = effectiveScope(scope, context);
  if (effective === "session")
    return {
      projectId: context.project!.name,
      parentSessionId: context.session!.id,
    };
  if (effective === "project") return { projectId: context.project!.name };
  return {};
}

/** True when two host contexts would require a different worker query or visible view. */
export function contextSignature(context: WorkerPluginContext): string {
  return (context.project?.name ?? "") + "|" + (context.session?.id ?? "");
}

/** A worker belongs to the panel when it matches the active project/session filters. */
export function matchesScope(
  worker: { projectId: string; parentSessionId: string },
  query: WorkerStateQuery,
): boolean {
  if (query.projectId && worker.projectId !== query.projectId) return false;
  if (
    query.parentSessionId &&
    worker.parentSessionId !== query.parentSessionId
  )
    return false;
  return true;
}

export function emptyCounts(): WorkerCountsByStatus {
  return {
    queued: 0,
    starting: 0,
    running: 0,
    stopping: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    unknown: 0,
  };
}

/** Counts the statuses of one type; missing serialized keys read as zero. */
export function countStatuses(
  workers: Array<{ type: WorkerType; latestRun: { status: WorkerStatus } | null }>,
  type: WorkerType,
): WorkerCountsByStatus {
  const counts = emptyCounts();
  for (const worker of workers) {
    if (worker.type !== type) continue;
    counts[worker.latestRun?.status ?? "queued"]++;
  }
  return counts;
}

/** Slots held against the per-`(parent, project, type)` concurrency limit. */
export function occupyingCount(counts: WorkerCountsByStatus): number {
  return OCCUPYING_STATUSES.reduce((sum, status) => sum + counts[status], 0);
}

/** The number of workers actually executing, separate from the slot total. */
export function runningCount(counts: WorkerCountsByStatus): number {
  return counts.starting + counts.running;
}

/** Total across both types, derived locally so a filtered list still sums correctly. */
export function totalCounts(
  dsh: WorkerCountsByStatus,
  pi: WorkerCountsByStatus,
): WorkerCountsByStatus {
  const total = emptyCounts();
  for (const status of Object.keys(total) as WorkerStatus[])
    total[status] = dsh[status] + pi[status];
  return total;
}

/** Sum of every status; used for the list footer. */
export function sumCounts(counts: WorkerCountsByStatus): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

/** Formats an elapsed duration as a compact `Hh Mm Ss` string. */
export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  if (hours) return hours + "小时" + minutes + "分";
  if (minutes) return minutes + "分" + rest + "秒";
  return rest + "秒";
}

/** Elapsed seconds from a start timestamp until now or a finish timestamp. */
export function elapsedSeconds(
  startedAt: string | null,
  finishedAt: string | null,
  now = Date.now(),
): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

/**
 * Reminder state for one run. The soft reminder is a nudge only; it never cancels work. The
 * hard deadline is shown only when the run was admitted with one.
 */
export function budgetState(
  startedAt: string | null,
  finishedAt: string | null,
  settings: WorkerSettings,
  progress: { softReminderSentAt: string | null; hardTimeoutAt: string | null },
  now = Date.now(),
): {
  elapsed: number | null;
  softDue: boolean;
  softSent: boolean;
  hardDeadline: string | null;
  hardOverdue: boolean;
} {
  const elapsed = elapsedSeconds(startedAt, finishedAt, now);
  const softDue =
    elapsed !== null &&
    !finishedAt &&
    elapsed >= settings.softReminderSeconds;
  return {
    elapsed,
    softDue,
    softSent: progress.softReminderSentAt !== null,
    hardDeadline: progress.hardTimeoutAt,
    hardOverdue:
      progress.hardTimeoutAt !== null &&
      !finishedAt &&
      Date.parse(progress.hardTimeoutAt) <= now,
  };
}

/** Token values stay `—` when the runner never reported them. */
export function formatTokens(usage: WorkerUsage | null): string {
  if (!usage) return "用量未知";
  const value = (input: number | null) =>
    typeof input === "number" && Number.isFinite(input)
      ? input.toLocaleString("zh-CN")
      : "—";
  return (
    "输入 " +
    value(usage.inputTokens) +
    " · 输出 " +
    value(usage.outputTokens) +
    " · 合计 " +
    value(usage.totalTokens)
  );
}

/** Shortens long identifiers while keeping both ends recognizable. */
export function shortId(value: string | null | undefined, keep = 10): string {
  if (!value) return "—";
  if (value.length <= keep * 2 + 1) return value;
  return value.slice(0, keep) + "…" + value.slice(-keep);
}

/** A worktree is cleanable only when the plugin created it and nothing is running. */
export function canCleanup(worker: {
  workspace: { mode: string; createdByPlugin?: boolean };
  latestRun: { status: WorkerStatus } | null;
}): boolean {
  const status = worker.latestRun?.status ?? "queued";
  return (
    worker.workspace.mode === "worktree" &&
    worker.workspace.createdByPlugin === true &&
    !(
      OCCUPYING_STATUSES as readonly string[]
    ).includes(status) &&
    status !== "queued"
  );
}

/** Recovery is offered only for a run whose stop could not be confirmed. */
export function canRecover(worker: {
  latestRun: { status: WorkerStatus } | null;
}): boolean {
  return worker.latestRun?.status === "unknown";
}

/** Notification retry is only meaningful before the host has delivered the event. */
export function canRetryNotification(delivery: WorkerNotificationDelivery): boolean {
  return delivery !== "delivered";
}

/** Cancellation applies to queued work and to runs that still hold a slot. */
export function canCancel(status: WorkerStatus): boolean {
  return status === "queued" || (OCCUPYING_STATUSES as readonly string[]).includes(status);
}
