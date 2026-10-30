import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  CircleCheck,
  Clock3,
  FileText,
  PlugZap,
  RefreshCw,
  Settings2,
  Square,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  workerApi,
  type WorkerDetail,
  type WorkerHost,
  type WorkerPluginContext,
} from "./api.js";
import {
  STATUS_LABELS,
  TYPE_LABELS,
  DELIVERY_LABELS,
  budgetState,
  canCancel,
  canCleanup,
  canRecover,
  canRetryNotification,
  contextSignature,
  countStatuses,
  effectiveScope,
  elapsedSeconds,
  emptyCounts,
  formatDuration,
  formatTokens,
  matchesScope,
  occupyingCount,
  runningCount,
  scopeQuery,
  shortId,
  sumCounts,
  totalCounts,
  type WorkerScope,
} from "./format.js";
import type {
  WorkerCountsByStatus,
  WorkerLogStream,
  WorkerNotification,
  WorkerRecord,
  WorkerRun,
  WorkerSettings,
  WorkerSettingsInput,
  WorkerStateSnapshot,
  WorkerStatus,
  WorkerType,
} from "../shared/contracts.js";
import styles from "./worker.css";

const roots = new WeakMap<HTMLElement, Root>();

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

function time(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function StatusBadge({ status }: { status: WorkerStatus }) {
  return (
    <span className={"worker-badge worker-" + STATUS_TONE[status]}>
      {status === "completed" ? (
        <CircleCheck size={12} />
      ) : status === "running" || status === "starting" ? (
        <Clock3 size={12} />
      ) : status === "unknown" || status === "stopping" ? (
        <AlertTriangle size={12} />
      ) : null}
      {STATUS_LABELS[status]}
    </span>
  );
}

function CountCell({
  label,
  counts,
  emphasize,
}: {
  label: string;
  counts: WorkerCountsByStatus;
  emphasize?: boolean;
}) {
  return (
    <div className="worker-count-cell">
      <strong className={emphasize ? "worker-count-strong" : undefined}>
        {runningCount(counts)}
      </strong>
      <span>{label} 执行中</span>
      <small>
        占额 {occupyingCount(counts)} · 排队 {counts.queued}
      </small>
      <small>
        启动 {counts.starting} · 停止 {counts.stopping} · 未知 {counts.unknown}
      </small>
      <small>
        完成 {counts.completed} · 失败 {counts.failed} · 取消 {counts.cancelled} · 中断{" "}
        {counts.interrupted}
      </small>
    </div>
  );
}

function CountsBar({ counts }: { counts: WorkerStateSnapshot["counts"] }) {
  return (
    <section className="worker-counts" aria-label="按类型统计">
      <CountCell label="DSH" counts={counts.dsh} />
      <CountCell label="Pi" counts={counts.pi} />
      <CountCell label="全部" counts={counts.total} emphasize />
    </section>
  );
}

function BudgetLine({
  worker,
  run,
  settings,
  now,
}: {
  worker: WorkerRecord;
  run: WorkerRun;
  settings: WorkerSettings;
  now: number;
}) {
  const budget = budgetState(
    run.startedAt,
    run.finishedAt,
    settings,
    run.progress,
    now,
  );
  return (
    <div className="worker-budget">
      <span>
        耗时 {budget.elapsed === null ? "—" : formatDuration(budget.elapsed)}
      </span>
      <span>
        步骤 {run.progress.steps === null ? "—" : run.progress.steps}
      </span>
      <span>
        阶段 {run.progress.phase ?? "—"}
        {run.progress.currentTool ? " · " + run.progress.currentTool : ""}
      </span>
      {budget.softSent ? (
        <span className="worker-soft">已发送 {settings.softReminderSeconds} 秒软提醒</span>
      ) : budget.softDue ? (
        <span className="worker-soft">
          超过 {settings.softReminderSeconds} 秒软提醒阈值（仅提醒，不终止）
        </span>
      ) : null}
      {run.timeoutSeconds !== null ? (
        <span className={budget.hardOverdue ? "worker-danger" : undefined}>
          硬超时 {run.progress.hardTimeoutAt ? time(run.progress.hardTimeoutAt) : `${run.timeoutSeconds} 秒`}
        </span>
      ) : (
        <span>未设置硬超时</span>
      )}
      {worker.type === "pi" && run.progress.steps === null ? (
        <span>Pi 未上报步骤</span>
      ) : null}
    </div>
  );
}

function WorkerRow({
  worker,
  now,
  settings,
  onOpen,
  onCancel,
  busy,
}: {
  worker: WorkerRecord;
  now: number;
  settings: WorkerSettings;
  onOpen(): void;
  onCancel(): void;
  busy: boolean;
}) {
  const run = worker.latestRun;
  const status = run?.status ?? "queued";
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
        <span className={"worker-type worker-type-" + worker.type}>
          {TYPE_LABELS[worker.type]}
        </span>
        <small>
          {run?.model ?? "默认模型"}
          {run?.provider ? " / " + run.provider : ""}
          {run?.effort ? " / " + run.effort : ""}
        </small>
      </td>
      <td>
        <StatusBadge status={status} />
        <small>
          {elapsed === null ? "—" : formatDuration(elapsed)}
          {run ? " · 退出码 " + (run.exitCode ?? "—") : ""}
        </small>
        {budget?.softDue && !budget.softSent ? (
          <small className="worker-soft">软提醒阈值已过</small>
        ) : null}
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
        <button
          className="worker-danger"
          disabled={busy || !canCancel(status)}
          aria-label={"取消 " + worker.taskName}
          onClick={onCancel}
        >
          <Square size={13} />
          取消
        </button>
      </td>
    </tr>
  );
}

function RunsPanel({
  detail,
  selectedRunId,
  onSelect,
}: {
  detail: WorkerDetail;
  selectedRunId: string | null;
  onSelect(runId: string): void;
}) {
  const runs = [...detail.runs].reverse();
  return (
    <aside className="worker-runs">
      <h3>运行记录</h3>
      {runs.length ? (
        runs.map((run) => (
          <button
            key={run.id}
            aria-pressed={selectedRunId === run.id}
            onClick={() => onSelect(run.id)}
          >
            <StatusBadge status={run.status} />
            <small>{time(run.startedAt)}</small>
            <small>
              {run.model ?? "默认模型"}
              {run.effort ? " / " + run.effort : ""}
            </small>
          </button>
        ))
      ) : (
        <p className="worker-muted">尚无运行记录</p>
      )}
    </aside>
  );
}

function LogPanel({
  api,
  workerId,
  runId,
  onError,
}: {
  api: ReturnType<typeof workerApi>;
  workerId: string;
  runId: string;
  onError(message: string): void;
}) {
  const [stream, setStream] = useState<WorkerLogStream>("events");
  const key = workerId + ":" + runId + ":" + stream;
  const [logs, setLogs] = useState({
    key: "",
    text: "",
    cursor: null as string | null,
    done: false,
    loading: false,
    error: "",
  });
  // Only a bounded tail remains in browser memory; older pages stay on the server.
  const collected = useRef("");
  useEffect(() => {
    let live = true;
    collected.current = "";
    void api
      .logs(workerId, runId, stream, null)
      .then((page) => {
        if (!live) return;
        collected.current = page.text;
        setLogs({
          key,
          text: page.text,
          cursor: page.nextCursor,
          done: page.done || page.nextCursor === null,
          loading: false,
          error: "",
        });
      })
      .catch((error) => {
        if (!live) return;
        setLogs({
          key,
          text: "",
          cursor: null,
          done: false,
          loading: false,
          error: String(error),
        });
      });
    return () => {
      live = false;
    };
  }, [api, key, workerId, runId, stream]);
  const current =
    logs.key === key
      ? logs
      : { key, text: "", cursor: null, done: false, loading: true, error: "" };
  const loadMore = async () => {
    if (!current?.cursor || current.loading) return;
    setLogs((value) => ({ ...value, loading: true, error: "" }));
    try {
      const page = await api.logs(workerId, runId, stream, current.cursor);
      collected.current += page.text;
      // Keep the most recent million characters; the stream remains paged server-side.
      if (collected.current.length > 1_000_000)
        collected.current = collected.current.slice(-1_000_000);
      setLogs((value) =>
        value.key !== key
          ? value
          : {
              key,
              text: collected.current,
              cursor: page.nextCursor,
              done: page.done || page.nextCursor === null,
              loading: false,
              error: "",
            },
      );
    } catch (error) {
      setLogs((value) =>
        value.key === key
          ? { ...value, loading: false, error: String(error) }
          : value,
      );
      onError(String(error));
    }
  };
  return (
    <section className="worker-console">
      <div className="worker-console-head">
        <div className="worker-segment">
          {(["events", "stderr"] as WorkerLogStream[]).map((value) => (
            <button
              key={value}
              aria-pressed={stream === value}
              onClick={() => setStream(value)}
            >
              {value === "events" ? "原始事件" : "stderr"}
            </button>
          ))}
        </div>
        <span className="worker-muted">
          每页 64 KiB
          {current.done ? " · 已到末尾" : ""}
        </span>
      </div>
      <pre className="worker-log" aria-label={stream === "events" ? "原始事件日志" : "stderr 日志"}>
        {current.text || (current.loading ? "正在读取日志…" : "暂无输出")}
      </pre>
      {current.error ? (
        <p className="worker-error" role="alert">
          {current.error}
        </p>
      ) : null}
      <div className="worker-console-foot">
        <button
          disabled={!current.cursor || current.loading}
          onClick={() => void loadMore()}
        >
          <FileText size={13} />
          {current.loading ? "读取中…" : "加载更多"}
        </button>
        <span className="worker-muted">日志原文来自原生事件与 stderr，可能包含敏感内容</span>
      </div>
    </section>
  );
}

function RecoverForm({
  api,
  worker,
  onRecovered,
  onError,
}: {
  api: ReturnType<typeof workerApi>;
  worker: WorkerRecord;
  onRecovered(message: string): void;
  onError(message: string): void;
}) {
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section className="worker-recover">
      <h3>
        <Wrench size={14} /> 异常恢复
      </h3>
      <p>
        只有在已核实原生 CLI 与其进程组完全停止后才能恢复。恢复会写入一条人工核实记录，不会自动重跑任务。
      </p>
      <label>
        已核实停止的证据与说明
        <textarea
          aria-label="已核实停止的说明"
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="例如：ps 未发现 dsh 进程；原生会话文件最后一条事件为 turn_end/cancelled"
        />
      </label>
      <label className="worker-checkbox">
        <input
          type="checkbox"
          aria-label="已核实原生会话已停止"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        我已核实 {worker.type === "dsh" ? "DSH" : "Pi"} 会话及子进程已停止
      </label>
      <button
        className="worker-danger"
        disabled={busy || !confirmed || !notes.trim()}
        onClick={() => {
          setBusy(true);
          void api
            .recover({
              workerId: worker.id,
              notes: notes.trim(),
              confirmedStopped: true,
            })
            .then(() => {
              onRecovered("已记录人工核实停止");
              setNotes("");
              setConfirmed(false);
            })
            .catch((error) => onError(String(error)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "提交中…" : "确认停止并恢复"}
      </button>
    </section>
  );
}

function DetailView({
  api,
  detail,
  settings,
  now,
  onBack,
  onCancel,
  onCleanup,
  onError,
  onNotice,
  busy,
}: {
  api: ReturnType<typeof workerApi>;
  detail: WorkerDetail;
  settings: WorkerSettings;
  now: number;
  onBack(): void;
  onCancel(): void;
  onCleanup(): void;
  onError(message: string): void;
  onNotice(message: string): void;
  busy: boolean;
}) {
  const worker = detail.worker;
  const [runId, setRunId] = useState<string | null>(null);
  const runs = detail.runs;
  const run =
    runs.find((item) => item.id === runId) ??
    runs.find((item) => item.id === worker.latestRun?.id) ??
    runs[runs.length - 1] ??
    null;
  const status = run?.status ?? "queued";
  return (
    <>
      <button className="worker-back" onClick={onBack}>
        <ArrowLeft size={14} /> 返回列表
      </button>
      <header className="worker-heading">
        <div>
          <h2>{worker.taskName}</h2>
          <p>
            {worker.projectId} · 父会话 {worker.parentSessionId}
          </p>
        </div>
        <div className="worker-actions">
          <StatusBadge status={status} />
          <button
            className="worker-danger"
            disabled={busy || !canCancel(status)}
            onClick={onCancel}
          >
            <Square size={14} /> 取消任务
          </button>
          {canCleanup(worker) ? (
            <button
              disabled={busy}
              title="仅插件创建、已停止且工作区干净的 worktree 会被清理；分支、会话与日志保留"
              onClick={onCleanup}
            >
              <Trash2 size={14} /> 清理 worktree
            </button>
          ) : null}
        </div>
      </header>
      <div className="worker-detail-grid">
        <section>
          <h3>任务</h3>
          <dl>
            <dt>类型</dt>
            <dd>{TYPE_LABELS[worker.type]}</dd>
            <dt>模型 / 推理强度</dt>
            <dd>
              {run?.model ?? "默认模型"}
              {run?.provider ? " / " + run.provider : ""}
              {run?.effort ? " / " + run.effort : ""}
            </dd>
            <dt>工作目录</dt>
            <dd>
              <code>{worker.cwd}</code>
            </dd>
            <dt>工作区</dt>
            <dd>
              {worker.workspace.mode} · {worker.workspace.path}
              {worker.workspace.sourcePath ? "（源 " + worker.workspace.sourcePath + "）" : ""}
            </dd>
            <dt>基线 / 分支</dt>
            <dd>
              {worker.workspace.baseCommit ?? "—"} / {worker.workspace.branch ?? "—"}
            </dd>
            <dt>写入范围</dt>
            <dd>{worker.writePaths.length ? worker.writePaths.join(", ") : "只读任务"}</dd>
            <dt>创建时间</dt>
            <dd>{time(worker.createdAt)}</dd>
          </dl>
        </section>
        <section>
          <h3>本次运行</h3>
          <dl>
            <dt>运行 ID</dt>
            <dd>
              <code>{run?.id ?? "—"}</code>
            </dd>
            <dt>原生会话 ID</dt>
            <dd>
              <code>{run?.nativeSessionId ?? "尚未确认"}</code>
            </dd>
            <dt>原生会话文件</dt>
            <dd>
              <code>{run?.nativeSessionFile ?? "尚未确认"}</code>
            </dd>
            <dt>HOME / 会话目录</dt>
            <dd>
              <code>{run ? run.home : "—"}</code> /{" "}
              <code>{run ? run.sessionsRoot : "—"}</code>
            </dd>
            <dt>Token</dt>
            <dd>{formatTokens(run?.usage ?? null)}</dd>
            <dt>退出码</dt>
            <dd>{run?.exitCode ?? "—"}</dd>
            <dt>执行与验收</dt>
            <dd>执行成功不等于验收；请检查实际 diff 与测试结果。</dd>
          </dl>
        </section>
      </div>
      {run ? (
        <section className="worker-progress">
          <h3>进度与预算</h3>
          <BudgetLine worker={worker} run={run} settings={settings} now={now} />
          {run.error ? (
            <p className="worker-error" role="alert">
              {run.error.code}: {run.error.message}
            </p>
          ) : null}
        </section>
      ) : null}
      <div className="worker-run-layout">
        <RunsPanel detail={detail} selectedRunId={run?.id ?? null} onSelect={setRunId} />
        {run ? (
          <LogPanel api={api} workerId={worker.id} runId={run.id} onError={onError} />
        ) : (
          <section className="worker-console">
            <p className="worker-muted">尚无运行，暂无日志。</p>
          </section>
        )}
      </div>
      {run?.finalText ? (
        <section className="worker-result">
          <h3>最终输出</h3>
          <pre>{run.finalText}</pre>
        </section>
      ) : null}
      {canRecover(worker) ? (
        <RecoverForm
          api={api}
          worker={worker}
          onRecovered={onNotice}
          onError={onError}
        />
      ) : null}
    </>
  );
}

function NotificationList({
  notifications,
  onRetry,
  busy,
}: {
  notifications: WorkerNotification[];
  onRetry(eventIds: string[]): void;
  busy: boolean;
}) {
  if (!notifications.length) return null;
  return (
    <details className="worker-notifications" open>
      <summary>
        <Bell size={14} /> 停用通知（{notifications.length}）
      </summary>
      <p className="worker-muted">
        终态通知不占用用户消息队列；手动重试只重新投递通知，不重跑任务。
      </p>
      {notifications.map((item) => (
        <div className="worker-notification" key={item.id}>
          <StatusBadge status={item.status} />
          <span className="worker-notification-summary">{item.summary}</span>
          <small>
            {time(item.createdAt)} · {DELIVERY_LABELS[item.delivery]}
            {item.batchId ? " · 批次 " + shortId(item.batchId, 6) : ""}
          </small>
          <button
            disabled={busy || !canRetryNotification(item.delivery)}
            aria-label={"重试通知 " + item.id}
            onClick={() => onRetry([item.id])}
          >
            <RefreshCw size={13} /> 重试通知
          </button>
        </div>
      ))}
    </details>
  );
}

function SettingsView({
  settings,
  api,
  onBack,
  onSaved,
  onError,
}: {
  settings: WorkerSettings;
  api: ReturnType<typeof workerApi>;
  onBack(): void;
  onSaved(settings: WorkerSettings): void;
  onError(message: string): void;
}) {
  const [dsh, setDsh] = useState(String(settings.concurrency.dsh));
  const [pi, setPi] = useState(String(settings.concurrency.pi));
  const [defaultType, setDefaultType] = useState<WorkerType>(
    settings.defaultWorkerType,
  );
  const [dshModel, setDshModel] = useState(settings.defaults.dsh.model ?? "");
  const [dshEffort, setDshEffort] = useState(
    settings.defaults.dsh.effort ?? "",
  );
  const [piModel, setPiModel] = useState(settings.defaults.pi.model ?? "");
  const [piEffort, setPiEffort] = useState(settings.defaults.pi.effort ?? "");
  const [retentionDays, setRetentionDays] = useState(String(settings.retentionDays));
  const [busy, setBusy] = useState(false);
  const validNumber = (value: string) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0;
  };
  const dshModelValue = dshModel.trim();
  const valid = validNumber(dsh) && validNumber(pi) && validNumber(retentionDays) &&
    (!dshEffort.trim() || !!dshModelValue);
  const save = async () => {
    if (!valid) return;
    const body: WorkerSettingsInput = {
      concurrency: { dsh: Number(dsh), pi: Number(pi) },
      retentionDays: Number(retentionDays),
      defaultWorkerType: defaultType,
      defaults: {
        dsh: {
          model: dshModelValue || null,
          effort: dshEffort.trim() || null,
        },
        pi: {
          model: piModel.trim() || null,
          effort: piEffort.trim() || null,
        },
      },
    };
    setBusy(true);
    try {
      const value = await api.saveSettings(body);
      onSaved(value);
      setDsh(String(value.concurrency.dsh));
      setPi(String(value.concurrency.pi));
      setDefaultType(value.defaultWorkerType);
      setDshModel(value.defaults.dsh.model ?? "");
      setDshEffort(value.defaults.dsh.effort ?? "");
      setPiModel(value.defaults.pi.model ?? "");
      setPiEffort(value.defaults.pi.effort ?? "");
      setRetentionDays(String(value.retentionDays));
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="worker-back" onClick={onBack}>
        <ArrowLeft size={14} /> 返回列表
      </button>
      <header className="worker-heading">
        <div>
          <h2>Worker 设置</h2>
          <p>
            并发额度修改会立即影响排队调度；默认类型、模型和 reasoning 仅用于之后的新
            worker 启动请求
          </p>
        </div>
      </header>
      <div className="worker-form">
        <label className="worker-form-wide">
          默认 Worker 类型
          <select
            aria-label="默认 Worker 类型"
            value={defaultType}
            onChange={(event) =>
              setDefaultType(event.target.value as WorkerType)
            }
          >
            <option value="dsh">DSH</option>
            <option value="pi">Pi</option>
          </select>
        </label>
        <fieldset className="worker-fieldset">
          <legend>DSH</legend>
          <label>
            默认模型
            <input
              type="text"
              aria-label="DSH 默认模型"
              placeholder="留空沿用执行器现有配置"
              value={dshModel}
              onChange={(event) => setDshModel(event.target.value)}
            />
          </label>
          <label>
            Reasoning
            <input
              type="text"
              aria-label="DSH 默认 reasoning"
              placeholder="留空沿用执行器现有配置；填写时需同时配置模型"
              value={dshEffort}
              onChange={(event) => setDshEffort(event.target.value)}
            />
          </label>
          <label>
            并发
            <input
              type="number"
              min="1"
              step="1"
              aria-label="DSH 并发"
              value={dsh}
              onChange={(event) => setDsh(event.target.value)}
            />
          </label>
        </fieldset>
        <fieldset className="worker-fieldset">
          <legend>Pi</legend>
          <label>
            默认模型
            <input
              type="text"
              aria-label="Pi 默认模型"
              placeholder="留空沿用执行器现有配置"
              value={piModel}
              onChange={(event) => setPiModel(event.target.value)}
            />
          </label>
          <label>
            Reasoning
            <input
              type="text"
              aria-label="Pi 默认 reasoning"
              placeholder="留空沿用执行器现有配置"
              value={piEffort}
              onChange={(event) => setPiEffort(event.target.value)}
            />
          </label>
          <label>
            并发
            <input
              type="number"
              min="1"
              step="1"
              aria-label="Pi 并发"
              value={pi}
              onChange={(event) => setPi(event.target.value)}
            />
          </label>
        </fieldset>
        <label className="worker-form-wide">
          日志和运行记录保留天数
          <input
            type="number"
            min="1"
            step="1"
            aria-label="日志和运行记录保留天数"
            value={retentionDays}
            onChange={(event) => setRetentionDays(event.target.value)}
          />
          <small>
            默认 1 天，从每次运行结束起计算，到期自动删除日志和运行记录。
            运行中或状态未知的任务、原生会话和工作目录保留。
          </small>
        </label>
        <p>
          并发为正整数，按类型独立计算；启动中、运行中、停止中和状态未知的 run 都占用额度；
          超过额度的请求按 FIFO 排队。模型或 reasoning 留空表示沿用执行器现有配置。
          DSH reasoning 需要同时配置模型。同一原生会话只允许一个调用。软提醒默认{" "}
          {settings.softReminderSeconds} 秒 / {settings.softReminderSteps} 步，硬超时
          {settings.hardTimeoutSeconds === null
            ? "默认关闭"
            : "默认 " + settings.hardTimeoutSeconds + " 秒"}
          。
        </p>
        {!valid ? (
          <p className="worker-error" role="alert">
            {!validNumber(dsh) || !validNumber(pi)
              ? "并发必须是大于 0 的整数。"
              : !validNumber(retentionDays)
                ? "保留天数必须是大于 0 的整数。"
                : "DSH reasoning 需要同时配置 DSH 默认模型。"}
          </p>
        ) : null}
        <button
          className="worker-primary worker-form-wide"
          disabled={busy || !valid}
          onClick={() => void save()}
        >
          {busy ? "保存中…" : "保存设置"}
        </button>
      </div>
    </>
  );
}

function WorkerPanel({ host }: { host: WorkerHost }) {
  const api = useMemo(() => workerApi(host), [host]);
  const [context, setContext] = useState<WorkerPluginContext>(host.context);
  const [scope, setScope] = useState<WorkerScope>(() =>
    host.context.session && host.context.project
      ? "session"
      : host.context.project
        ? "project"
        : "all",
  );
  const [snapshot, setSnapshot] = useState<WorkerStateSnapshot | null>(null);
  // Snapshots are tagged with the query they answered; a response for a superseded query can
  // never show its rows, even for the one render before the polling effect is cleaned up.
  const [snapshotKey, setSnapshotKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [view, setView] = useState<"list" | "detail" | "settings">("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkerDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const signature = contextSignature(context);

  const activeScope = effectiveScope(scope, context);
  const query = useMemo(
    () => scopeQuery(activeScope, context),
    [activeScope, context],
  );
  const queryKey = (query.projectId ?? "") + "|" + (query.parentSessionId ?? "");

  // A context switch abandons the old selection and any in-flight detail/log request.
  const previousSignature = useRef(signature);
  useEffect(() => {
    if (previousSignature.current === signature) return;
    previousSignature.current = signature;
    setSelectedId(null);
    setDetail(null);
    setDetailError("");
    setView("list");
    setSnapshot(null);
    setSnapshotKey("");
    setError("");
    setMessage("");
  }, [signature]);

  useEffect(
    () =>
      host.onContextChange((next) => {
        setContext(next);
      }),
    [host],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // State polling is owned by the mounted panel and tied to the exact scope query. Hiding the
  // page pauses it; unmounting or switching context clears the pending timer and rejects stale
  // responses using the effect-local `live` flag.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    const schedule = () => {
      if (!live || document.visibilityState === "hidden") return;
      timer = setTimeout(() => void poll(), 2000);
    };
    const poll = async () => {
      if (!live || inFlight) return;
      inFlight = true;
      try {
        const data = await api.state(query);
        if (live) {
          setSnapshot(data);
          setSnapshotKey(queryKey);
          setError("");
        }
      } catch (caught) {
        if (live) setError(String(caught));
      } finally {
        inFlight = false;
        schedule();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        timer = null;
        void poll();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, queryKey]);

  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      if (!live || inFlight) return;
      inFlight = true;
      try {
        const data = await api.worker(selectedId);
        if (live) {
          setDetail(data);
          setDetailError("");
        }
      } catch (caught) {
        if (live) setDetailError(String(caught));
      } finally {
        inFlight = false;
        if (live && document.visibilityState !== "hidden")
          timer = setTimeout(() => void load(), 2000);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      timer = null;
      void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api, selectedId]);

  const liveSnapshot = snapshotKey === queryKey ? snapshot : null;
  const workers = useMemo(
    () =>
      liveSnapshot
        ? liveSnapshot.workers.filter((worker) => matchesScope(worker, query))
        : [],
    [liveSnapshot, query],
  );
  const dshCounts = useMemo(
    () => (liveSnapshot ? countStatuses(liveSnapshot.workers, "dsh") : emptyCounts()),
    [liveSnapshot],
  );
  const piCounts = useMemo(
    () => (liveSnapshot ? countStatuses(liveSnapshot.workers, "pi") : emptyCounts()),
    [liveSnapshot],
  );
  const counts = useMemo(
    () => totalCounts(dshCounts, piCounts),
    [dshCounts, piCounts],
  );
  const settings = liveSnapshot?.settings ?? null;
  const loading = !liveSnapshot && !error;

  const operate = async (operation: () => Promise<unknown>, notice: string) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      setMessage(notice);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const refreshDetail = async (workerId: string) => {
    try {
      setDetail(await api.worker(workerId));
    } catch (caught) {
      setDetailError(String(caught));
    }
  };

  const cancelWorker = (worker: WorkerRecord) =>
    void operate(async () => {
      await api.cancel({ workerIds: [worker.id] });
      if (selectedId === worker.id) await refreshDetail(worker.id);
    }, "已请求取消 " + worker.taskName);

  const stopSession = () => {
    if (!context.session || !context.project) return;
    void operate(
      () =>
        api.cancel({
          all: true,
          parentSessionId: context.session!.id,
          projectId: context.project!.name,
          pause: true,
        }),
      "已停止本会话的排队与运行任务，并暂停自动唤醒",
    );
  };

  const selectedWorker =
    (detail && detail.worker.id === selectedId ? detail.worker : null) ??
    workers.find((worker) => worker.id === selectedId) ??
    null;

  return (
    <div className="worker-plugin" data-theme={context.theme}>
      <style>{styles}</style>
      {error ? (
        <div className="worker-notice worker-notice-error" role="alert">
          <span>{error}</span>
          <button aria-label="关闭错误" onClick={() => setError("")}>
            ×
          </button>
        </div>
      ) : null}
      {message ? (
        <div className="worker-notice" role="status">
          <span>{message}</span>
          <button aria-label="关闭提示" onClick={() => setMessage("")}>
            ×
          </button>
        </div>
      ) : null}
      {view === "settings" && settings ? (
        <SettingsView
          settings={settings}
          api={api}
          onBack={() => setView("list")}
          onSaved={(value) => {
            setSnapshot((current) =>
              current ? { ...current, settings: value } : current,
            );
            setMessage("Worker 设置已保存");
          }}
          onError={setError}
        />
      ) : view === "detail" && selectedWorker ? (
        detail && detail.worker.id === selectedId ? (
          <DetailView
            api={api}
            detail={detail}
            settings={settings!}
            now={now}
            busy={busy}
            onBack={() => {
              setView("list");
              setSelectedId(null);
              setDetail(null);
            }}
            onCancel={() => cancelWorker(selectedWorker)}
            onCleanup={() =>
              void operate(async () => {
                await api.cleanup(selectedWorker.id);
                await refreshDetail(selectedWorker.id);
              }, "worktree 已清理；分支、会话与日志保留")
            }
            onError={setError}
            onNotice={setMessage}
          />
        ) : (
          <p className="worker-muted">
            {detailError || "正在读取任务详情…"}
          </p>
        )
      ) : (
        <>
          <header className="worker-heading">
            <div>
              <h2>子任务 Worker</h2>
              <p>DSH 与 Pi 子任务由插件执行并记录；执行成功不等于验收。</p>
            </div>
            <div className="worker-actions">
              <button
                disabled={!settings}
                onClick={() => setView("settings")}
              >
                <Settings2 size={15} /> Worker 设置
              </button>
              <button
                className="worker-danger"
                disabled={busy || !context.session || !context.project}
                title={
                  context.session
                    ? "取消本会话排队与运行中的任务，并暂停自动唤醒"
                    : "当前没有打开会话"
                }
                onClick={stopSession}
              >
                <Square size={15} /> 停止本会话全部
              </button>
            </div>
          </header>
          <div className="worker-toolbar">
            <div className="worker-segment" aria-label="任务范围">
              <button
                aria-label="范围：当前会话"
                aria-pressed={activeScope === "session"}
                disabled={!context.session || !context.project}
                title={
                  context.session
                    ? undefined
                    : "当前没有打开的会话"
                }
                onClick={() => setScope("session")}
              >
                当前会话
              </button>
              <button
                aria-label="范围：当前项目"
                aria-pressed={activeScope === "project"}
                disabled={!context.project}
                title={context.project ? undefined : "当前没有打开的项目"}
                onClick={() => setScope("project")}
              >
                当前项目
              </button>
              <button
                aria-label="范围：全部"
                aria-pressed={activeScope === "all"}
                onClick={() => setScope("all")}
              >
                全部
              </button>
            </div>
            <span className="worker-muted">
              {loading
                ? "正在读取…"
                : workers.length +
                  " 个 worker · " +
                  sumCounts(counts) +
                  " 个状态记录 · 每 2 秒刷新"}
            </span>
          </div>
          <CountsBar counts={liveSnapshot?.counts ?? {
            dsh: dshCounts,
            pi: piCounts,
            total: counts,
          }} />
          {!context.project ? (
            <p className="worker-hint">
              当前没有打开的项目，仅显示全部视图。打开项目后可查看本项目或会话的任务。
            </p>
          ) : !context.session ? (
            <p className="worker-hint">
              当前没有打开的会话，会话视图已禁用；项目视图仍可用。
            </p>
          ) : null}
          <table className="worker-table">
            <thead>
              <tr>
                <th>任务 / 会话</th>
                <th>类型 / 模型</th>
                <th>状态 / 耗时</th>
                <th>工作区</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((worker) => (
                <WorkerRow
                  key={worker.id}
                  worker={worker}
                  now={now}
                  settings={settings!}
                  busy={busy}
                  onOpen={() => {
                    setSelectedId(worker.id);
                    setDetail(null);
                    setView("detail");
                  }}
                  onCancel={() => cancelWorker(worker)}
                />
              ))}
            </tbody>
          </table>
          {!loading && !workers.length ? (
            <div className="worker-empty">
              当前范围没有 Worker 任务。Worker 由主会话通过 CloudCLI Worker MCP 启动；此页面只读状态并执行取消、恢复、清理和通知重试。
            </div>
          ) : null}
          {liveSnapshot ? (
            <NotificationList
              notifications={liveSnapshot.notifications}
              busy={busy}
              onRetry={(eventIds) =>
                void operate(
                  () => api.retryNotifications({ eventIds }),
                  "已请求重试通知",
                )
              }
            />
          ) : null}
          <footer className="worker-footer">
            <span>
              <PlugZap size={13} /> 并发键 (父会话, 项目, 类型)：DSH{" "}
              {settings?.concurrency.dsh ?? "—"} / Pi{" "}
              {settings?.concurrency.pi ?? "—"}
            </span>
            <span>
              排队按 FIFO；同一原生会话只允许一个调用；清理仅限插件创建且干净、已停止的
              worktree。
            </span>
          </footer>
        </>
      )}
    </div>
  );
}

/** CloudCLI loads this module through the standard plugin mount contract. */
export function mount(container: HTMLElement, host: WorkerHost): void {
  const root = createRoot(container);
  roots.set(container, root);
  root.render(<WorkerPanel host={host} />);
}

/** Plugin host invokes this when changing tabs, disabling, or unloading the plugin. */
export function unmount(container: HTMLElement): void {
  roots.get(container)?.unmount();
  roots.delete(container);
}
