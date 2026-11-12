import type { ResidentTaskRow, ResidentTaskStatus } from "../shared/contracts.js";

/**
 * Presentation rules for resident ("常驻") tasks. Kept free of React and of the host API so the
 * plugin's test suite can pin which actions are offered for each real host state — the UI must
 * never invent a running state, and must never offer a continue that the host would refuse.
 */

const STATUS_LABELS: Record<ResidentTaskStatus, string> = {
  idle: "未启动",
  running: "运行中",
  stopping: "正在停止",
  stopped: "已停止",
};


/** Chinese label for the host-reported lifecycle status; unknown values say so instead of guessing. */
export function residentStatusLabel(status: ResidentTaskStatus | null): string {
  return status ? (STATUS_LABELS[status] ?? "未知状态") : "未知状态";
}

/** Which host actions the row may offer. `taskId` non-null means the binding is protected. */
export type ResidentTaskActions = {
  /** A running execution can be stopped; a stopped one has nothing to stop. */
  canStop: boolean;
  /** Only a stopped binding resumes, and only on an explicit continue — never on plugin ready. */
  canContinue: boolean;
  /** Unbinding stops first, so it is offered unless a stop is already settling. */
  canRemove: boolean;
  /** Explanation shown beside a withheld action, or null when the row explains itself. */
  note: string | null;
};

/** Actions available for one binding, derived only from the host's reported status. */
export function residentTaskActions(task: Pick<ResidentTaskRow, "status" | "enabled">): ResidentTaskActions {
  const running = task.status === "running";
  const stopping = task.status === "stopping";
  const stopped = task.status === "stopped";
  const canContinue = stopped && task.enabled;
  return {
    canStop: running,
    canContinue,
    canRemove: !stopping,
    note: !task.enabled
      ? "已禁用：不会自动恢复，也仍保持保护状态"
      : running
        ? "在前台聊天继续输入不会打断常驻运行"
        : null,
  };
}

/**
 * Copy that states the parallelism rule the host actually applies: resident turns run in their
 * own sessions, so they never consume the scheduled tasks' worker slots.
 */
export function residentCapacityNote(): string {
  return "常驻任务在原有会话中运行，不占用定时任务的并发上限（maxConcurrentRuns）。";
}
