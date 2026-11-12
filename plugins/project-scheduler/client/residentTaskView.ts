import type {
  ResidentStopCause,
  ResidentTaskRow,
  ResidentTaskStatus,
} from "../shared/contracts.js";

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

const CAUSE_LABELS: Record<ResidentStopCause, string> = {
  completed: "正常结束",
  failed: "运行失败",
  recovery_failed: "恢复失败",
  user_stopped: "手动停止",
  disabled: "因禁用而停止",
  deleted: "因删除而停止",
};

/** Chinese label for the host-reported lifecycle status; unknown values say so instead of guessing. */
export function residentStatusLabel(status: ResidentTaskStatus | null): string {
  return status ? (STATUS_LABELS[status] ?? "未知状态") : "未知状态";
}

/** Chinese label for why the last execution ended; null before any terminal episode. */
export function residentStopCauseLabel(cause: ResidentStopCause | null): string {
  return cause ? (CAUSE_LABELS[cause] ?? "未知原因") : "—";
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

/** The alert policy the host applied to the latest terminal, as one line of text. */
export function residentTerminalSummary(task: ResidentTaskRow): string {
  const terminal = task.terminal;
  if (!terminal) return "还没有结束记录";
  const when = new Date(terminal.endedAt).toLocaleString("zh-CN", { hour12: false });
  // `alert` is the host's alert *policy* for this episode, not a Telegram delivery result.
  const alert = terminal.alert ? "需告警" : "不告警";
  return `${residentStopCauseLabel(terminal.cause)} · ${alert} · ${when}`;
}

/**
 * Copy that states the parallelism rule the host actually applies: resident turns run in their
 * own sessions, so they never consume the scheduled tasks' worker slots.
 */
export function residentCapacityNote(): string {
  return "常驻任务在原有会话中运行，不占用定时任务的并发上限（maxConcurrentRuns）。";
}

/** Why the live output cannot be shown, or null when the host exposes the capability. */
export function residentOutputUnavailableReason(host: {
  mountSessionOutput?: unknown;
  openSession?: unknown;
}): string | null {
  if (typeof host.mountSessionOutput === "function" && typeof host.openSession === "function") {
    return null;
  }
  return "当前宿主不提供会话输出能力，无法显示实时输出。";
}
