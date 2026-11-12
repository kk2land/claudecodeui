import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, CircleCheck, Play, Square, Trash2 } from "lucide-react";

import type { schedulerApi, SchedulerHost } from "./api.js";
import {
  residentCapacityNote,
  residentOutputUnavailableReason,
  residentStatusLabel,
  residentStopCauseLabel,
  residentTaskActions,
  residentTerminalSummary,
} from "./residentTaskView.js";
import type {
  ResidentTaskDetail,
  ResidentTaskRow,
} from "../shared/contracts.js";

type ResidentApi = ReturnType<typeof schedulerApi>;

type ResidentTasksProps = {
  api: ResidentApi;
  host: SchedulerHost;
  /** The plugin's single status area, so resident operations report failures like every other one. */
  onMessage: (message: string) => void;
};

/**
 * Resident ("常驻") task area inside the scheduler plugin: the bindings that reuse a foreground
 * session, beside the cron tasks. Creation happens only from the session menu, so there is no
 * create form, no prompt editor and no project JSON involvement here.
 */
export function ResidentTasks({ api, host, onMessage }: ResidentTasksProps) {
  const [tasks, setTasks] = useState<ResidentTaskRow[]>([]);
  // Which binding's detail is open; kept here so switching does not touch the cron view state.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Per-binding lock while an operation is in flight, so a double click cannot send it twice.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const outputUnavailable = residentOutputUnavailableReason(host);

  const load = useCallback(async () => {
    try {
      const data = await api.residentTasks();
      setTasks(data.tasks);
    } catch (error) {
      onMessage(String(error));
    }
  }, [api, onMessage]);

  useEffect(() => {
    void load();
    // The list is refreshed on an interval because the host is the only authority on run state and
    // the plugin has no push channel for it in this build.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const operate = async (task: ResidentTaskRow, operation: () => Promise<unknown>, success: string) => {
    setPending((previous) => new Set(previous).add(task.taskId));
    try {
      await operation();
      onMessage(success);
      await load();
    } catch (error) {
      // A refusal is reported, never converted into a fake running/stopped display.
      onMessage(String(error));
    } finally {
      setPending((previous) => {
        const next = new Set(previous);
        next.delete(task.taskId);
        return next;
      });
    }
  };

  const selected = tasks.find((task) => task.taskId === selectedId) ?? null;

  if (selected) {
    return (
      <ResidentTaskPanel
        api={api}
        host={host}
        task={selected}
        pending={pending.has(selected.taskId)}
        outputUnavailable={outputUnavailable}
        onBack={() => setSelectedId(null)}
        onMessage={onMessage}
        onOperate={operate}
      />
    );
  }

  return (
    <section className="cron-resident" aria-label="常驻任务">
      <header className="cron-heading">
        <div>
          <h2>常驻任务</h2>
          <p>沿用正在运行的前台会话，不新建 Agent，也不改项目 JSON</p>
        </div>
        <span>{tasks.length} 项</span>
      </header>
      <p className="cron-resident-note">{residentCapacityNote()}</p>
      {tasks.length === 0 ? (
        <p className="cron-resident-note">
          还没有常驻任务。在侧边栏会话的三点菜单里对正在运行的会话选择“设为常驻”。
        </p>
      ) : (
        <ul className="cron-resident-list">
          {tasks.map((task) => {
            const actions = residentTaskActions(task);
            const busy = pending.has(task.taskId);
            return (
              <li key={task.taskId} className="cron-resident-row">
                <button
                  className="cron-link cron-resident-open"
                  onClick={() => setSelectedId(task.taskId)}
                >
                  {task.name}
                </button>
                <small>
                  {task.projectId} · {task.runtime.provider} · {residentStatusLabel(task.status)}
                  {task.enabled ? "" : " · 已禁用"}
                  {task.visible ? "" : " · 前台隐藏"}
                </small>
                <div className="cron-resident-actions">
                  <label>
                    <input
                      type="checkbox"
                      checked={task.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        void operate(
                          task,
                          () => api.setResidentEnabled(task.taskId, event.target.checked),
                          event.target.checked ? "已启用常驻任务" : "已禁用常驻任务",
                        )
                      }
                    />
                    启用
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={task.visible}
                      disabled={busy}
                      onChange={(event) =>
                        void operate(
                          task,
                          () => api.setResidentVisible(task.taskId, event.target.checked),
                          event.target.checked ? "已在前台显示该会话" : "已从前台隐藏该会话",
                        )
                      }
                    />
                    前台可见
                  </label>
                  {actions.canStop && (
                    <button
                      disabled={busy}
                      onClick={() => void operate(task, () => api.stopResident(task.taskId), "已停止常驻任务")}
                    >
                      <Square size={13} />
                      停止
                    </button>
                  )}
                  {actions.canContinue && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void operate(
                          task,
                          async () => {
                            const response = await api.continueResident(task.taskId);
                            if (!response.result.accepted) {
                              throw new Error(
                                response.result.reason === "already_running"
                                  ? "任务已在运行，未重复发送继续"
                                  : "任务已禁用，未发送继续",
                              );
                            }
                            return response;
                          },
                          "已在原会话中发送继续",
                        )
                      }
                    >
                      <Play size={13} />
                      继续
                    </button>
                  )}
                  {actions.canRemove && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm("删除常驻任务？会先静默停止并保留原会话。")) return;
                        void operate(task, () => api.removeResident(task.taskId), "已删除常驻任务，会话已保留");
                      }}
                    >
                      <Trash2 size={13} />
                      删除
                    </button>
                  )}
                </div>
                {actions.note && <small className="cron-resident-note">{actions.note}</small>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

type ResidentTaskPanelProps = {
  api: ResidentApi;
  host: SchedulerHost;
  task: ResidentTaskRow;
  pending: boolean;
  outputUnavailable: string | null;
  onBack: () => void;
  onMessage: (message: string) => void;
  onOperate: (task: ResidentTaskRow, operation: () => Promise<unknown>, success: string) => Promise<void>;
};

/** One binding's detail: host state, its terminal history, and the session's read-only output. */
function ResidentTaskPanel({
  api,
  host,
  task,
  pending,
  outputUnavailable,
  onBack,
  onMessage,
  onOperate,
}: ResidentTaskPanelProps) {
  // The plugin's own recorded terminal rows, newest first.
  const [detail, setDetail] = useState<ResidentTaskDetail | null>(null);
  // Container the host renders the read-only transcript into; the plugin only mounts and disposes.
  const outputRef = useRef<HTMLDivElement | null>(null);
  const actions = residentTaskActions(task);

  useEffect(() => {
    let live = true;
    void api
      .residentTask(task.taskId)
      .then((value) => {
        if (live) setDetail(value);
      })
      .catch((error) => {
        if (live) onMessage(String(error));
      });
    return () => {
      live = false;
    };
  }, [api, onMessage, task.taskId, task.status, task.executionId]);

  useEffect(() => {
    const container = outputRef.current;
    if (!container || !host.mountSessionOutput) return;
    // The host owns the viewer's lifecycle; this effect only unmounts it when the detail closes or
    // switches to another binding, so switching never leaks a socket listener.
    const dispose = host.mountSessionOutput(container, { sessionId: task.sessionId });
    return () => dispose();
  }, [host, task.sessionId]);

  const runs = useMemo(() => detail?.runs ?? [], [detail]);

  return (
    <section className="cron-resident-detail" aria-label={`常驻任务 ${task.name}`}>
      <header className="cron-heading">
        <div>
          <button onClick={onBack}>
            <ArrowLeft size={14} />
            常驻任务
          </button>
          <h2>{task.name}</h2>
          <p>
            {task.projectId} · {task.runtime.provider} · {residentStatusLabel(task.status)}
            {task.terminal ? ` · ${residentStopCauseLabel(task.terminal.cause)}` : ""}
          </p>
        </div>
        <div className="cron-actions">
          {host.openSession && (
            <button onClick={() => host.openSession?.(task.sessionId)}>打开会话</button>
          )}
          {actions.canStop && (
            <button disabled={pending} onClick={() => void onOperate(task, () => api.stopResident(task.taskId), "已停止常驻任务")}>
              <Square size={13} />
              停止
            </button>
          )}
          {actions.canContinue && (
            <button
              disabled={pending}
              onClick={() =>
                void onOperate(
                  task,
                  async () => {
                    const response = await api.continueResident(task.taskId);
                    if (!response.result.accepted) {
                      throw new Error(
                        response.result.reason === "already_running"
                          ? "任务已在运行，未重复发送继续"
                          : "任务已禁用，未发送继续",
                      );
                    }
                    return response;
                  },
                  "已在原会话中发送继续",
                )
              }
            >
              <Play size={13} />
              继续
            </button>
          )}
        </div>
      </header>

      <p className="cron-resident-note">
        {residentTerminalSummary(task)}
        {task.terminal?.reason ? ` · ${task.terminal.reason}` : ""}
      </p>

      <div className="cron-resident-output">
        {outputUnavailable ? (
          <p role="alert" className="cron-resident-note">
            {outputUnavailable}
          </p>
        ) : (
          <div ref={outputRef} className="cron-resident-output-host" />
        )}
      </div>

      <h3>常驻结束记录</h3>
      {runs.length === 0 ? (
        <p className="cron-resident-note">还没有结束记录；运行结果只在结束时写入这里。</p>
      ) : (
        <table className="cron-table">
          <thead>
            <tr>
              <th>结束时间</th>
              <th>结果</th>
              <th>原因</th>
              <th>告警</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{run.endedAt ? new Date(run.endedAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</td>
                <td>
                  <span className={"cron-badge cron-" + run.status}>
                    {run.status === "success" ? <CircleCheck size={12} /> : <CircleAlert size={12} />}
                    {run.status}
                  </span>
                </td>
                <td>{run.reason ?? "—"}</td>
                <td>{run.alertStatus === "none" ? "未发送" : run.alertStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
