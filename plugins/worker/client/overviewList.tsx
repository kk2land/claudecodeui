import React, { useCallback, useMemo, useRef } from "react";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock3,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import type { WorkerApi, WorkerHost } from "./api.js";
import { ConversationPane } from "./conversationPane.js";
import {
  STATUS_LABELS,
  TASK_ROLE_LABELS,
  TYPE_LABELS,
  DELIVERY_LABELS,
  budgetState,
  canCancel,
  canRetryNotification,
  elapsedSeconds,
  formatDuration,
  shortId,
} from "./format.js";
import {
  atScrollBottom,
  cooldownRemaining,
  isActiveWorker,
  useHistoryFeed,
  workerStatus,
  type WorkerHistoryNotification,
  type WorkerOverviewSnapshot,
} from "./overview.js";
import type {
  WorkerRecord,
  WorkerStateQuery,
  WorkerStatus,
  WorkerType,
} from "../shared/contracts.js";

const STATUS_TONE: Record<WorkerStatus, string> = {
  queued: "queued",
  starting: "active",
  running: "active",
  stopping: "warn",
  completed: "ok",
  failed: "bad",
  cancelled: "muted",
  interrupted: "bad",
  unknown: "warn",
};

function clock(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      });
}

function statusOf(worker: WorkerRecord): WorkerStatus {
  return workerStatus(worker) as WorkerStatus;
}

/** `0:07` style countdown for the global agy cooldown deadline. */
export function formatCooldown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

function StatusPill({ status }: { status: WorkerStatus }) {
  return (
    <span className={"worker-status worker-tone-" + STATUS_TONE[status]}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function duration(worker: WorkerRecord, now: number): string {
  const run = worker.latestRun;
  if (!run) return "—";
  if (run.status === "queued") return "排队中";
  const seconds = elapsedSeconds(run.startedAt, run.finishedAt, now);
  return seconds === null ? "—" : formatDuration(seconds);
}

function Card({
  api,
  host,
  worker,
  now,
  busy,
  onOpen,
  onCancel,
}: {
  api: WorkerApi;
  host: WorkerHost;
  worker: WorkerRecord;
  now: number;
  busy: boolean;
  onOpen(): void;
  onCancel(): void;
}) {
  const run = worker.latestRun;
  const status = statusOf(worker);
  return (
    <article className="worker-card" aria-label={"任务卡片 " + worker.taskName}>
      <header className="worker-card-head">
        <button
          className="worker-card-title"
          title="查看详情"
          onClick={onOpen}
        >
          {worker.taskName}
        </button>
        <button
          className="worker-card-open"
          aria-label={"查看 " + worker.taskName}
          title="查看详情"
          onClick={onOpen}
        >
          <ExternalLink size={14} />
        </button>
      </header>
      <div className="worker-card-meta">
        <span>{TYPE_LABELS[worker.type as WorkerType] ?? worker.type}</span>
        <span>{worker.taskRole ? TASK_ROLE_LABELS[worker.taskRole] : "未指定"}</span>
        <span className={"worker-tone-" + STATUS_TONE[status]}>
          <i className="worker-dot" />
          {STATUS_LABELS[status]}
        </span>
        <span className="worker-card-duration">
          <Clock3 size={12} /> {duration(worker, now)}
        </span>
      </div>
      {run ? (
        <ConversationPane
          api={api}
          host={host}
          workerType={worker.type}
          workerId={worker.id}
          runId={run.id}
          finalText={run.finalText}
          compact
          footer={({ follow, setFollow }) => (
            <>
              <button
                className="worker-card-follow"
                aria-pressed={follow}
                onClick={() => setFollow(!follow)}
              >
                <CircleCheck size={13} />
                {follow ? "跟随最新" : "已暂停跟随"}
              </button>
              <button
                className="worker-card-stop"
                aria-label={"取消 " + worker.taskName}
                disabled={busy || !canCancel(statusOf(worker))}
                title="取消这个任务"
                onClick={onCancel}
              >
                取消
              </button>
            </>
          )}
        />
      ) : (
        <p className="worker-muted worker-card-empty">尚未开始运行。</p>
      )}
    </article>
  );
}

function FinishedRow({
  worker,
  now,
  settings,
  onOpen,
}: {
  worker: WorkerRecord;
  now: number;
  settings: WorkerOverviewSnapshot["settings"];
  onOpen(): void;
}) {
  const run = worker.latestRun;
  const status = statusOf(worker);
  const elapsed = run ? elapsedSeconds(run.startedAt, run.finishedAt, now) : null;
  const budget = run
    ? budgetState(run.startedAt, run.finishedAt, settings, run.progress, now)
    : null;
  return (
    <tr>
      <td>
        <button className="worker-link" onClick={onOpen}>
          {worker.taskName}
        </button>
        <small>
          {worker.projectId} · 会话 {shortId(worker.parentSessionId, 8)}
        </small>
        {run?.nativeSessionId ? (
          <small>原生 {shortId(run.nativeSessionId, 8)}</small>
        ) : (
          <small>原生会话尚未确认</small>
        )}
      </td>
      <td>
        {worker.taskRole ? (
          <span className="worker-role">
            {TASK_ROLE_LABELS[worker.taskRole]}
          </span>
        ) : (
          <span className="worker-muted">未指定</span>
        )}
      </td>
      <td>
        <span className={"worker-type worker-type-" + worker.type}>
          {TYPE_LABELS[worker.type as WorkerType] ?? worker.type}
        </span>
        <small>配置 {worker.configName || "—"}</small>
        <small>
          {run?.model ?? "默认模型"}
          {run?.provider ? " / " + run.provider : ""}
          {run?.effort ? " / " + run.effort : ""}
        </small>
      </td>
      <td>
        <StatusPill status={status} />
        <small>
          {elapsed === null ? "—" : formatDuration(elapsed)}
          {run ? " · 退出码 " + (run.exitCode ?? "—") : ""}
        </small>
        {budget?.softDue && !budget.softSent ? (
          <small className="worker-soft">软提醒阈值已过</small>
        ) : null}
        <small title={run?.finishedAt ?? undefined}>
          结束 {clock(run?.finishedAt)}
        </small>
      </td>
      <td>
        <code className="worker-path" title={worker.cwd}>
          {worker.cwd}
        </code>
        <small>
          {worker.workspace.mode === "worktree" ? "worktree" : "existing"}
          {worker.workspace.createdByPlugin ? " · 插件创建" : ""}
        </small>
        {worker.writePaths.length ? (
          <small>写入范围 {worker.writePaths.join(", ")}</small>
        ) : (
          <small>只读任务</small>
        )}
      </td>
      <td className="worker-row-actions">
        <button onClick={onOpen} aria-label={"查看 " + worker.taskName}>
          查看
        </button>
      </td>
    </tr>
  );
}

function QueuedRow({
  worker,
  now,
  busy,
  onOpen,
  onCancel,
}: {
  worker: WorkerRecord;
  now: number;
  busy: boolean;
  onOpen(): void;
  onCancel(): void;
}) {
  const status = statusOf(worker);
  return (
    <li className="worker-compact-row">
      <StatusPill status={status} />
      <span className="worker-compact-name">{worker.taskName}</span>
      <span className="worker-muted">
        {TYPE_LABELS[worker.type as WorkerType] ?? worker.type} ·{" "}
        {duration(worker, now)}
      </span>
      <span className="worker-row-actions">
        <button
          className="worker-link"
          aria-label={"查看 " + worker.taskName}
          onClick={onOpen}
        >
          详情
        </button>
        <button
          className="worker-link"
          aria-label={"停止 " + worker.taskName}
          disabled={busy || !canCancel(statusOf(worker))}
          onClick={onCancel}
        >
          停止
        </button>
      </span>
    </li>
  );
}

function TableShell({
  title,
  count,
  ready,
  error,
  loading,
  onRetry,
  onScroll,
  scrollerRef,
  children,
}: {
  title: string;
  count: number;
  ready: boolean;
  error: string;
  loading: boolean;
  onRetry(): void;
  onScroll(): void;
  scrollerRef: React.MutableRefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  return (
    <section className="worker-history">
      <h3>
        {title} <small>{count}</small>
      </h3>
      <div
        className="worker-history-scroll"
        ref={scrollerRef}
        onScroll={onScroll}
      >
        {children}
        {!ready ? (
          <p className="worker-muted worker-history-state">正在读取…</p>
        ) : null}
        {loading ? (
          <p className="worker-muted worker-history-state">读取下一页…</p>
        ) : null}
        {error ? (
          <p className="worker-error worker-history-state" role="alert">
            {error}{" "}
            <button className="worker-link" onClick={onRetry}>
              重试
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The live first screen: cooldown, worker cards, and compact queued rows. */
export function WorkerLive({
  api,
  host,
  snapshot,
  now,
  busy,
  onOpen,
  onCancel,
}: {
  api: WorkerApi;
  host: WorkerHost;
  snapshot: WorkerOverviewSnapshot;
  now: number;
  busy: boolean;
  onOpen(workerId: string): void;
  onCancel(worker: WorkerRecord): void;
}) {
  const workers = useMemo(
    () => snapshot.workers.filter(isActiveWorker),
    [snapshot.workers],
  );
  // Queued and unconfirmed work stays a compact row with its own detail/stop entries.
  const compact = workers.filter((worker) => {
    const status = statusOf(worker);
    return status === "queued" || status === "unknown";
  });
  const cards = workers.filter((worker) => !compact.includes(worker));
  const active = workers.length;

  const cardsRef = useRef<HTMLDivElement | null>(null);
  const shift = (direction: 1 | -1) => {
    const node = cardsRef.current;
    const card = node?.querySelector<HTMLElement>(".worker-card");
    if (!node || !card) return;
    const gap = Number.parseFloat(getComputedStyle(node).columnGap) || 14;
    const step = card.offsetWidth + gap;
    const column =
      direction > 0
        ? Math.floor(node.scrollLeft / step) + 1
        : Math.ceil(node.scrollLeft / step) - 1;
    node.scrollTo({
      left: Math.max(
        0,
        Math.min(column * step, node.scrollWidth - node.clientWidth),
      ),
      behavior: "smooth",
    });
  };

  const remaining = cooldownRemaining(snapshot.agyCooldownUntil, now);

  return (
    <>
      {remaining !== null ? (
        <p className="worker-cooldown" role="status">
          <Clock3 size={13} /> Antigravity 冷却中：
          <strong>{formatCooldown(remaining)}</strong> 后可启动新的 Antigravity 任务
        </p>
      ) : null}
      <section className="worker-live">
        <div className="worker-live-head">
          <h3>
            运行中的任务 <small>{active}</small>
          </h3>
          <div className="worker-carousel">
            <button
              aria-label="上一组卡片"
              disabled={!cards.length}
              onClick={() => shift(-1)}
            >
              <ChevronLeft size={15} />
            </button>
            <button
              aria-label="下一组卡片"
              disabled={!cards.length}
              onClick={() => shift(1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
        {cards.length ? (
          <div
            className="worker-cards"
            data-count={cards.length}
            ref={cardsRef}
          >
            {cards.map((worker) => (
              <Card
                key={worker.id}
                api={api}
                host={host}
                worker={worker}
                now={now}
                busy={busy}
                onOpen={() => onOpen(worker.id)}
                onCancel={() => onCancel(worker)}
              />
            ))}
          </div>
        ) : (
          <p className="worker-muted worker-empty-inline">
            当前范围没有运行中的任务。
          </p>
        )}
        {compact.length ? (
          <ul className="worker-compact" aria-label="排队与未确认任务">
            {compact.map((worker) => (
              <QueuedRow
                key={worker.id}
                worker={worker}
                now={now}
                busy={busy}
                onOpen={() => onOpen(worker.id)}
                onCancel={() => onCancel(worker)}
              />
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}

/**
 * Both paged tables. They keep their own loaded pages, request the next page only when their own
 * scroll box reaches the bottom, and fold the polled first page back in by key.
 */
export function WorkerHistory({
  api,
  snapshot,
  query,
  identity,
  settings,
  now,
  busy,
  onOpen,
  onRetry,
}: {
  api: WorkerApi;
  snapshot: WorkerOverviewSnapshot;
  query: WorkerStateQuery;
  identity: string;
  now: number;
  settings: WorkerOverviewSnapshot["settings"];
  busy: boolean;
  onOpen(workerId: string): void;
  /** Resolves the number the backend actually queued; failures resolve 0. */
  onRetry(eventIds: string[]): Promise<number>;
}) {
  const activeIds = useMemo(
    () => new Set(snapshot.workers.filter(isActiveWorker).map((worker) => worker.id)),
    [snapshot.workers],
  );
  const finished = useHistoryFeed<WorkerRecord>({
    identity: identity + "|finished",
    page: snapshot.finished,
    // Aligned with the server's history key: a legacy record without finishedAt sorts by createdAt.
    timeOf: (worker) => worker.latestRun?.finishedAt ?? worker.createdAt,
    request: (cursor) => api.history<WorkerRecord>("finished", cursor, query),
    exclude: activeIds,
  });
  const notifications = useHistoryFeed<WorkerHistoryNotification>({
    identity: identity + "|notifications",
    page: snapshot.notifications,
    timeOf: (item) => item.createdAt,
    request: (cursor) =>
      api.history<WorkerHistoryNotification>("notifications", cursor, query),
  });

  const finishedScroll = useRef<HTMLDivElement | null>(null);
  const notificationScroll = useRef<HTMLDivElement | null>(null);
  const requestFinished = useCallback(() => {
    if (finished.nextCursor && !finished.loading && finishedScroll.current &&
      atScrollBottom(finishedScroll.current))
      finished.loadMore();
  }, [finished]);
  const requestNotifications = useCallback(() => {
    if (notifications.nextCursor && !notifications.loading &&
      notificationScroll.current &&
      atScrollBottom(notificationScroll.current))
      notifications.loadMore();
  }, [notifications]);

  return (
    <>
      <TableShell
        title="已结束任务"
        count={finished.items.length}
        ready
        error={finished.error}
        loading={finished.loading}
        onRetry={() => finished.loadMore()}
        onScroll={requestFinished}
        scrollerRef={finishedScroll}
      >
        {finished.items.length ? (
          <table className="worker-table worker-history-table">
            <thead>
              <tr>
                <th>任务 / 会话</th>
                <th>任务角色</th>
                <th>引擎 / 配置</th>
                <th>状态 / 耗时</th>
                <th>工作区</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {finished.items.map((worker) => (
                <FinishedRow
                  key={worker.id}
                  worker={worker}
                  now={now}
                  settings={settings}
                  onOpen={() => onOpen(worker.id)}
                />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="worker-muted worker-history-state">暂无已结束任务。</p>
        )}
      </TableShell>

      <details className="worker-notifications" open>
        <summary>
          <Bell size={14} /> Worker 通知
          <small>{notifications.items.length}</small>
        </summary>
        <div
          className="worker-history-scroll worker-notifications-scroll"
          ref={notificationScroll}
          onScroll={requestNotifications}
        >
          {notifications.items.length ? (
            notifications.items.map((item) => (
              <div className="worker-notification" key={item.id}>
                <div className="worker-notification-head">
                  <StatusPill status={item.status as WorkerStatus} />
                  {item.workerId ? (
                    <button
                      className="worker-link worker-notification-task"
                      aria-label={"查看 " + item.taskName}
                      onClick={() => onOpen(item.workerId!)}
                    >
                      {item.taskName}
                    </button>
                  ) : (
                    <span className="worker-notification-task">
                      {item.taskName}
                    </span>
                  )}
                  <small>
                    {clock(item.createdAt)} · {DELIVERY_LABELS[item.delivery]}
                  </small>
                  {canRetryNotification(item.delivery) ? (
                    <button
                      className="worker-link worker-notification-retry"
                      aria-label={"重试通知 " + item.id}
                      disabled={busy}
                      onClick={() => {
                        void onRetry([item.id]).then((retried) => {
                          // Only a queued retry changes delivery; 0 or a failure stays retryable.
                          // If polling already refreshed the row, keep that observed delivery.
                          if (retried > 0)
                            notifications.update(item.id, (current) =>
                              canRetryNotification(current.delivery)
                                ? { ...current, delivery: "pending" }
                                : current,
                            );
                        });
                      }}
                    >
                      <RefreshCw size={12} /> 重试
                    </button>
                  ) : null}
                </div>
                <p className="worker-notification-summary">{item.summary}</p>
              </div>
            ))
          ) : (
            <p className="worker-muted worker-history-state">暂无通知。</p>
          )}
          {notifications.loading ? (
            <p className="worker-muted worker-history-state">读取下一页…</p>
          ) : null}
          {notifications.error ? (
            <p className="worker-error worker-history-state" role="alert">
              {notifications.error}{" "}
              <button
                className="worker-link"
                onClick={() => notifications.loadMore()}
              >
                重试
              </button>
            </p>
          ) : null}
        </div>
      </details>
      {settings ? (
        <p className="worker-hint">
          <Bell size={13} /> Worker 由主会话通过 CloudCLI Worker MCP 启动；此页面只读状态并执行停止、恢复、清理和通知重试。
        </p>
      ) : null}
    </>
  );
}
