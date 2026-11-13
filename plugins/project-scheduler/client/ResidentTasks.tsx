import React, { useCallback, useEffect, useState } from "react";
import { Play, ScrollText, Square, Trash2 } from "lucide-react";

import type { schedulerApi, SchedulerHost } from "./api.js";
import {
  residentCapacityNote,
  residentStatusLabel,
  residentTaskActions,
} from "./residentTaskView.js";
import { StageLogTable } from "./StageLogTable.js";
import type { ResidentTaskRow } from "../shared/contracts.js";

type ResidentApi = ReturnType<typeof schedulerApi>;

type ResidentTasksProps = {
  api: ResidentApi;
  host: SchedulerHost;
  /** Restricts the list to this project; omitted shows all projects. */
  projectId?: string;
  /** The plugin's single status area, so resident operations report failures like every other one. */
  onMessage: (message: string) => void;
};

/**
 * Resident ("常驻") task area inside the scheduler plugin: the bindings that reuse a foreground
 * session, beside the cron tasks. Creation happens only from the session menu, so there is no
 * create form, no prompt editor and no project JSON involvement here.
 */
export function ResidentTasks({ api, host, projectId, onMessage }: ResidentTasksProps) {
  const [tasks, setTasks] = useState<ResidentTaskRow[]>([]);
  const visibleTasks = projectId ? tasks.filter((task) => task.projectId === projectId) : tasks;
  // Per-binding lock while an operation is in flight, so a double click cannot send it twice.
  const [pending, setPending] = useState<Set<string>>(new Set());
  // The one task whose stage log is expanded; opening another replaces it, so at most one log
  // panel exists and its request/timer are cleaned up when it closes or switches.
  const [logTaskId, setLogTaskId] = useState<string | null>(null);
  // Opening the original conversation is an optional host capability; without it the name is a
  // disabled label rather than a button that silently does nothing.
  const canOpenSession = typeof host.openSession === "function";

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

  return (
    <section className="cron-resident" aria-label="常驻任务">
      <header className="cron-heading">
        <div>
          <h2>常驻任务</h2>
          <p>沿用正在运行的前台会话，不新建 Agent，也不改项目 JSON</p>
        </div>
        <span>{visibleTasks.length} 项</span>
      </header>
      <p className="cron-resident-note">{residentCapacityNote()}</p>
      {!canOpenSession && (
        <p className="cron-resident-note" role="status">
          当前宿主不提供打开会话能力：任务名不可点击，启用、可见、停止、继续与删除仍可用。
        </p>
      )}
      {visibleTasks.length === 0 ? (
        <p className="cron-resident-note">
          {projectId ? "当前项目还没有常驻任务。" : "还没有常驻任务。"}
          在侧边栏会话的三点菜单里对正在运行的会话选择“设为常驻”。
        </p>
      ) : (
        <ul className="cron-resident-list">
          {visibleTasks.map((task) => {
            const actions = residentTaskActions(task);
            const busy = pending.has(task.taskId);
            return (
              <li key={task.taskId} className="cron-resident-row">
                {/* The name opens the original conversation — the same session id, never the
                    plugin task id — so the user lands in the writable chat with its history. */}
                <button
                  className="cron-link cron-resident-open"
                  disabled={!canOpenSession}
                  title={canOpenSession ? "打开原会话聊天" : "当前宿主不提供打开会话能力"}
                  onClick={() => host.openSession?.(task.sessionId)}
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
                  <button
                    type="button"
                    aria-expanded={logTaskId === task.taskId}
                    onClick={() => setLogTaskId((current) => (current === task.taskId ? null : task.taskId))}
                  >
                    <ScrollText size={13} />
                    阶段日志
                  </button>
                </div>
                {actions.note && <small className="cron-resident-note">{actions.note}</small>}
                {logTaskId === task.taskId && (
                  <StageLogTable
                    key={task.taskId}
                    api={api}
                    taskId={task.taskId}
                    onClose={() => setLogTaskId(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
