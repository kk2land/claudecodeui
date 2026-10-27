import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  Clock3,
  Download,
  PencilLine,
  Play,
  Settings2,
  Square,
  X,
} from "lucide-react";
import { schedulerApi, type SchedulerHost } from "./api.js";
import { ConfigurationEditor } from "./ConfigurationEditor.js";
import { COMMON_TIMEZONES } from "./configurationDraft.js";
import {
  environmentRowsToMap,
  type PublicSchedulerSettings,
  type SchedulerImport,
  type SchedulerProject,
  type SchedulerRun,
  type SchedulerTask,
  type SchedulerTaskRow,
} from "../shared/contracts.js";
import styles from "./scheduler.css";

const roots = new WeakMap<HTMLElement, Root>();
const labels: Record<SchedulerRun["status"], string> = {
  running: "正在运行",
  success: "成功",
  failed: "失败",
  timed_out: "超时",
  stopped: "已停止",
  interrupted: "意外中断",
  skipped_overlap: "并发跳过",
  skipped_capacity: "容量跳过",
};
const time = (value: string | null | undefined, zone?: string) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        hour12: false,
        ...(zone ? { timeZone: zone } : {}),
      })
    : "—";
const key = (task: SchedulerTaskRow) => task.projectId + ":" + task.taskId;
// Stable row identity keeps the focused input mounted while its name changes.
let envRowSequence = 0;
type EnvRow = { id: number; name: string; value: string };
// Settings panes: alert delivery, the shared execution environment, and runtime/log policy.
type SettingsTab = "alerts" | "environment" | "runtime";
const envRow = (name = "", value = ""): EnvRow => ({
  id: ++envRowSequence,
  name,
  value,
});
const envRowsFrom = (env: Record<string, string>): EnvRow[] =>
  Object.entries(env).map(([name, value]) => envRow(name, value));
function Badge({ run }: { run: SchedulerRun }) {
  return (
    <span className={"cron-badge cron-" + run.status}>
      {run.status === "success" ? (
        <CircleCheck size={12} />
      ) : run.status === "running" ? (
        <Clock3 size={12} />
      ) : (
        <CircleAlert size={12} />
      )}
      {labels[run.status]}
    </span>
  );
}

function Scheduler({ host }: { host: SchedulerHost }) {
  const api = useMemo(() => schedulerApi(host), [host]);
  // Host context is independent of task state and changes when the active project/theme changes.
  const [context, setContext] = useState(host.context);
  const previousProject = useRef(host.context.project?.name);
  // Inventory is polled while the plugin is mounted; scheduling continues without this component.
  const [tasks, setTasks] = useState<SchedulerTaskRow[]>([]);
  // Each task is locked while its saved automatic-scheduling state is changing.
  const [pendingToggles, setPendingToggles] = useState<Set<string>>(new Set());
  // Ignore poll responses captured before a switch update so they cannot undo its display.
  const taskRevision = useRef(0);
  // The chosen scope only affects presentation and import defaults; no project means "all".
  const [scope, setScope] = useState<"current" | "all">(
    host.context.project ? "current" : "all",
  );
  // "current" is only meaningful while a host project is open; without one every row shows.
  const effectiveScope: "current" | "all" =
    scope === "current" && context.project ? "current" : "all";
  // Stable identity keeps an open detail view attached to its project across polling updates.
  const [selected, setSelected] = useState<string | null>(null);
  // Settings come from the authenticated API; editing stays local to the settings panel.
  const [settings, setSettings] = useState<PublicSchedulerSettings | null>(
    null,
  );
  // A view switch preserves task identity while the user inspects plugin settings.
  const [view, setView] = useState<"tasks" | "detail" | "settings">("tasks");
  // Log retention links open the runtime pane directly; the regular settings entry opens alerts.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("alerts");
  // Import previews are shown in a separate, dismissible dialog.
  const [loadingConfig, setLoadingConfig] = useState(false);
  // The configuration editor is pinned to the project chosen at entry, not to host context.
  const [editor, setEditor] = useState<SchedulerProject | null>(null);
  // Projects are fetched only when the editor entry needs a single project choice.
  const [projectChoices, setProjectChoices] = useState<SchedulerProject[] | null>(
    null,
  );
  // Prevents double-opening while the project inventory is read.
  const [openingEditor, setOpeningEditor] = useState(false);
  // The context listener needs the current editor state without resubscribing to the host.
  const editorOpen = useRef(false);
  // Operations report errors/results in one accessible status area.
  const [message, setMessage] = useState("");
  useEffect(() => {
    editorOpen.current = editor !== null;
  }, [editor]);
  useEffect(
    () =>
      host.onContextChange((next) => {
        setContext(next);
        if (previousProject.current !== next.project?.name) {
          previousProject.current = next.project?.name;
          // An open editor keeps its own project and shows a leave reminder instead.
          if (!editorOpen.current) {
            setSelected(null);
            setView("tasks");
          }
        }
      }),
    [host],
  );
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 5000;
      try {
        const revision = taskRevision.current;
        const data = await api.tasks();
        if (live && revision === taskRevision.current) setTasks(data.tasks);
        if (data.tasks.some((task) => task.activeRuns.length)) delay = 1000;
      } catch (error) {
        if (live) setMessage(String(error));
      }
      if (live) timer = setTimeout(poll, delay);
    };
    void poll();
    void api
      .settings()
      .then((value) => {
        if (live) setSettings(value);
      })
      .catch((error) => {
        if (live) setMessage(String(error));
      });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api]);
  const currentTask = tasks.find((task) => key(task) === selected);
  const visible = tasks.filter(
    (task) =>
      effectiveScope === "all" || task.projectId === context.project?.name,
  );
  const operate = async (
    operation: () => Promise<unknown>,
    success?: string,
  ) => {
    try {
      await operation();
      if (success) setMessage(success);
      const data = await api.tasks();
      setTasks(data.tasks);
    } catch (error) {
      setMessage(String(error));
    }
  };
  const toggleTask = async (task: SchedulerTaskRow) => {
    const id = key(task);
    setPendingToggles((previous) => new Set(previous).add(id));
    taskRevision.current++;
    try {
      await api.setEnabled(task, !task.definition.enabled);
      const revision = ++taskRevision.current;
      const data = await api.tasks();
      if (revision === taskRevision.current) setTasks(data.tasks);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setPendingToggles((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };
  // Only the "current project" scope with an open host project opens the editor directly.
  // "All projects" always asks for one explicit project, even when a host project exists.
  const openEditor = async () => {
    if (openingEditor) return;
    const current =
      effectiveScope === "current" ? context.project?.name : undefined;
    if (current) {
      // The host only exposes the opaque project id; reuse a loaded row's display name when known.
      const known = tasks.find((task) => task.projectId === current);
      setEditor({
        id: current,
        name: known?.projectName ?? "",
        path: known?.projectPath ?? context.project?.path ?? "",
      });
      setProjectChoices(null);
      return;
    }
    setOpeningEditor(true);
    try {
      const data = await api.projects();
      if (!data.projects.length) {
        setMessage("没有可编辑的项目");
        return;
      }
      // A single project needs no further choice; multiple projects require an explicit pick.
      if (data.projects.length === 1) {
        setEditor(data.projects[0]!);
        setProjectChoices(null);
        return;
      }
      setProjectChoices(data.projects);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setOpeningEditor(false);
    }
  };
  if (editor)
    return (
      <div className="cron-plugin" data-theme={context.theme}>
        <style>{styles}</style>
        {message && (
          <div className="cron-notice" role="status">
            <span>{message}</span>
            <button aria-label="关闭提示" onClick={() => setMessage("")}>
              <X size={14} />
            </button>
          </div>
        )}
        <ConfigurationEditor
          host={host}
          project={editor}
          hostProjectId={context.project?.name ?? null}
          pluginTimezone={settings?.timezone ?? null}
          onExit={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            // Keep showing the project that was actually edited instead of hiding it.
            if (context.project?.name !== editor.id) setScope("all");
            setSelected(null);
            setView("tasks");
            void operate(async () => {}, "配置已保存并装载");
          }}
          onError={setMessage}
        />
      </div>
    );
  return (
    <div className="cron-plugin" data-theme={context.theme}>
      <style>{styles}</style>
      {message && (
        <div className="cron-notice" role="status">
          <span>{message}</span>
          <button aria-label="关闭提示" onClick={() => setMessage("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {view === "settings" && settings ? (
        <SettingsPanel
          settings={settings}
          initialTab={settingsTab}
          api={api}
          onBack={() => setView("tasks")}
          onSave={(value) => {
            setSettings(value);
            setMessage("设置已保存");
          }}
          onError={setMessage}
        />
      ) : view === "detail" && currentTask ? (
        <RunDetail
          task={currentTask}
          api={api}
          retention={settings?.retentionDays ?? 30}
          onBack={() => setView("tasks")}
          onSettings={(tab) => {
            setSettingsTab(tab);
            setView("settings");
          }}
          onError={setMessage}
          onRun={() =>
            void operate(async () => {
              const { run } = await api.run(currentTask);
              setMessage(
                labels[run.status] + (run.reason ? "：" + run.reason : ""),
              );
            })
          }
        />
      ) : (
        <>
          <header className="cron-heading">
            <div>
              <h2>定时任务</h2>
              <p>由项目配置管理，任务在后台独立执行</p>
            </div>
            <div className="cron-actions">
              <button
                disabled={!settings}
                onClick={() => {
                  setSettingsTab("alerts");
                  setView("settings");
                }}
              >
                <Settings2 size={15} />
                插件设置
              </button>
              <button
                className="cron-primary"
                disabled={openingEditor}
                onClick={() => void openEditor()}
              >
                <PencilLine size={15} />
                编辑任务
              </button>
              <button
                onClick={() =>
                  setLoadingConfig(true)
                }
              >
                <Download size={15} />
                从文件重新装载
              </button>
            </div>
          </header>
          <div className="cron-toolbar">
            <div className="cron-segment">
              <button
                aria-pressed={effectiveScope === "current"}
                disabled={!context.project}
                title={context.project ? undefined : "当前没有打开的项目"}
                onClick={() => setScope("current")}
              >
                当前项目
              </button>
              <button
                aria-pressed={effectiveScope === "all"}
                onClick={() => setScope("all")}
              >
                全部项目
              </button>
            </div>
            <span>
              {visible.length} 项任务 ·{" "}
              {visible.reduce((sum, task) => sum + task.activeRuns.length, 0)}{" "}
              项运行中
            </span>
          </div>
          <table className="cron-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>执行计划 / 下次运行</th>
                <th>执行方式</th>
                <th>临时自动调度</th>
                <th>运行状态</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => (
                <tr key={key(task)}>
                  <td>
                    <button
                      className="cron-link"
                      onClick={() => {
                        setSelected(key(task));
                        setView("detail");
                      }}
                    >
                      {task.definition.name}
                    </button>
                    <small>
                      {effectiveScope === "all" ? task.projectName + " · " : ""}
                      {task.taskId}
                    </small>
                  </td>
                  <td>
                    <code>{task.definition.cron}</code>
                    <small>
                      {time(task.nextRun, task.definition.timezone)}
                      <br />
                      {task.definition.timezone}
                    </small>
                  </td>
                  <td>
                    {task.definition.type === "script"
                      ? task.definition.command?.split(/[\\/]/).pop() +
                        " / 脚本"
                      : task.definition.agent.provider + " / 提示词"}
                    <small className="cron-command-preview">
                      <code>
                        {task.definition.type === "script"
                          ? task.definition.args.join(" ")
                          : task.definition.agent.model}
                      </code>
                    </small>
                  </td>
                  <td className="cron-toggle-cell">
                    <button
                      type="button"
                      role="switch"
                      className="cron-task-switch"
                      aria-label={`${task.projectName} / ${task.definition.name} 临时自动调度`}
                      aria-checked={task.definition.enabled}
                      disabled={pendingToggles.has(key(task))}
                      onClick={() => void toggleTask(task)}
                    >
                      <span className="cron-switch-track" aria-hidden="true"><span /></span>
                      {task.definition.enabled ? "已开启" : "已关闭"}
                    </button>
                  </td>
                  <td>
                    {task.activeRuns.length ? (
                      <>
                        <Badge run={task.activeRuns[0]!} />
                        <small>
                          {task.activeRuns.length} 个运行 ·{" "}
                          {task.lastRun
                            ? "上次" + labels[task.lastRun.status]
                            : "尚无完成记录"}
                        </small>
                      </>
                    ) : task.lastRun ? (
                      <>
                        <Badge run={task.lastRun} />
                        <small>
                          {time(task.lastRun.endedAt, task.definition.timezone)}
                        </small>
                      </>
                    ) : (
                      <span className="cron-muted">尚未运行</span>
                    )}
                    {!task.definition.enabled && <small>计划已禁用</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && (
            <div className="cron-empty">
              尚未装载定时任务。点击“编辑任务”创建或修改项目配置，或点击“从文件重新装载”读取已有
              .cloudcli/project-schedules.json。
            </div>
          )}
          <footer className="cron-footer">
            <code>.cloudcli/project-schedules.json</code>
            <span>默认禁止同一任务并发</span>
            <span>
              “临时自动调度”开关只改插件数据库，不中断运行，也不修改 JSON；“编辑任务”保存后写入文件并装载。
            </span>
          </footer>
        </>
      )}
      {loadingConfig && (
        <ImportDialog
          api={api}
          projectId={
            effectiveScope === "current" && context.project
              ? context.project.name
              : undefined
          }
          onClose={() => setLoadingConfig(false)}
          onLoaded={(results) => {
            setLoadingConfig(false);
            const errors = results
              .filter((result) => result.status === "invalid")
              .map((result) => result.project.name + ": " + result.error);
            void operate(
              async () => {},
              "装载完成" +
                (errors.length
                  ? "；以下项目保持原配置：\n" + errors.join("\n")
                  : ""),
            );
          }}
          onError={setMessage}
        />
      )}
      {projectChoices && (
        <ProjectPicker
          projects={projectChoices}
          onClose={() => setProjectChoices(null)}
          onPick={(project) => {
            setProjectChoices(null);
            setEditor(project);
          }}
        />
      )}
    </div>
  );
}

function ProjectPicker({
  projects,
  onClose,
  onPick,
}: {
  projects: SchedulerProject[];
  onClose(): void;
  onPick(project: SchedulerProject): void;
}) {
  return (
    <div className="cron-modal-backdrop">
      <section
        className="cron-modal"
        role="dialog"
        aria-modal="true"
        aria-label="选择要编辑的项目"
      >
        <header>
          <div>
            <h2>选择要编辑的项目</h2>
            <p>没有当前打开的项目，请先选择唯一项目；编辑期间不会跟随宿主切换。</p>
          </div>
          <button aria-label="关闭项目选择" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="cron-modal-content cron-project-picker">
          {projects.map((project) => (
            <button key={project.id} onClick={() => onPick(project)}>
              <strong>{project.name}</strong>
              <small>{project.path}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function RunDetail({
  task,
  api,
  retention,
  onBack,
  onSettings,
  onError,
  onRun,
}: {
  task: SchedulerTaskRow;
  api: ReturnType<typeof schedulerApi>;
  retention: number;
  onBack(): void;
  onSettings(tab: SettingsTab): void;
  onError(message: string): void;
  onRun(): void;
}) {
  // History is fetched independently from the inventory, including skipped trigger records.
  const [runs, setRuns] = useState<SchedulerRun[]>([]);
  // A null selection follows the newest active/latest run; clicking history pins a specific run.
  const [selected, setSelected] = useState<string | null>(null);
  // Output streams have independent cursors and reset when a different stream/run is selected.
  const [stream, setStream] = useState("stdout");
  // Only a bounded text tail stays in browser memory.
  const [logState, setLogState] = useState({
    key: "",
    text: "",
    expired: false,
    truncated: false,
    clipped: false,
  });
  // The selected run's immutable configuration is distinct from a subsequently reloaded task.
  const [snapshot, setSnapshot] = useState<{
    id: string;
    task: SchedulerTask | null;
  } | null>(null);
  // Follow mode lets the user inspect earlier output while new chunks arrive.
  const [follow, setFollow] = useState(true);
  const output = useRef<HTMLPreElement>(null);
  const active = task.activeRuns[0];
  const liveRun = active
    ? (runs.find((item) => item.id === active.id) ?? active)
    : null;
  const run =
    (selected
      ? (runs.find((run) => run.id === selected) ??
        task.activeRuns.find((run) => run.id === selected))
      : (liveRun ??
        task.lastRun ??
        runs.find((item) => !item.status.startsWith("skipped_")) ??
        runs[0])) ?? task.lastRun;
  const projectId = task.projectId,
    taskId = task.taskId,
    runId = run?.id,
    runStatus = run?.status;
  const logKey = runId + ":" + stream;
  const logInfo =
    logState.key === logKey
      ? logState
      : { expired: false, truncated: false, clipped: false };
  const text = logState.key === logKey ? logState.text : "";
  const runTask = snapshot && snapshot.id === runId ? snapshot.task : null;
  const definition = runTask ?? task.definition;
  const duration = run
    ? Math.max(
        0,
        Math.floor(
          ((run.endedAt ? Date.parse(run.endedAt) : Date.now()) -
            Date.parse(run.startedAt)) /
            1000,
        ),
      )
    : 0;
  useEffect(() => {
    let live = true;
    if (runId)
      void api
        .snapshot(runId)
        .then((value) => {
          if (live) setSnapshot({ id: runId, task: value.task });
        })
        .catch((error) => {
          if (live) onError(String(error));
        });
    return () => {
      live = false;
    };
  }, [api, runId, onError]);
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await api.runs({ projectId, taskId });
        if (live) setRuns(data.runs);
      } catch (error) {
        if (live) onError(String(error));
      }
      if (live) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, projectId, taskId, onError]);
  useEffect(() => {
    let live = true,
      offset = 0,
      collected = "",
      clipped = false,
      timer: ReturnType<typeof setTimeout>;
    if (!runId || runStatus?.startsWith("skipped_")) return;
    const poll = async () => {
      try {
        const data = await api.log(runId, stream, offset);
        if (!live) return;
        offset = data.offset;
        collected += data.text;
        clipped ||= collected.length > 1000000;
        collected = collected.slice(-1000000);
        setLogState({
          key: logKey,
          text: collected,
          expired: data.expired,
          truncated: data.truncated,
          clipped,
        });
        if (!data.expired)
          timer = setTimeout(
            poll,
            data.hasMore && data.text
              ? 10
              : runStatus === "running"
                ? 1000
                : 5000,
          );
      } catch (error) {
        if (live) onError(String(error));
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, runId, runStatus, stream, logKey, onError]);
  useEffect(() => {
    if (follow && output.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [text, follow]);
  return (
    <>
      <button className="cron-back" onClick={onBack}>
        <ArrowLeft size={14} />
        返回任务列表
      </button>
      <header className="cron-heading">
        <div>
          <h2>{run?.taskName ?? task.definition.name}</h2>
          <p>
            {task.projectName} / {task.taskId}
          </p>
        </div>
        <div className="cron-actions">
          <button onClick={() => onSettings("alerts")}>
            <Settings2 size={14} />
            插件设置
          </button>
          {run?.status === "running" ? (
            <button
              className="cron-danger"
              onClick={() =>
                void api.stop(run.id).catch((error) => onError(String(error)))
              }
            >
              <Square size={14} />
              停止本次
            </button>
          ) : (
            <button onClick={onRun}>
              <Play size={14} />
              立即运行
            </button>
          )}
        </div>
      </header>
      <div className="cron-definition">
        <span>
          {definition.type === "prompt"
            ? definition.agent.provider + " · " + definition.agent.model
            : definition.command}
        </span>
        <code>{definition.cron}</code>
        <span>{definition.allowConcurrent ? "允许并发" : "禁止并发"}</span>
      </div>
      <div className="cron-run-layout">
        <aside>
          <h3>运行记录</h3>
          <div className="cron-history">
            {runs.map((item) => (
              <button
                key={item.id}
                aria-pressed={run?.id === item.id}
                onClick={() => setSelected(item.id)}
              >
                <Badge run={item} />
                <small>{time(item.startedAt, definition.timezone)}</small>
              </button>
            ))}
          </div>
        </aside>
        <section className="cron-console">
          <div className="cron-console-header">
            <div className="cron-log-tabs">
              {["stdout", "stderr", "events"].map((value) => (
                <button
                  key={value}
                  aria-pressed={stream === value}
                  onClick={() => setStream(value)}
                >
                  {value === "events" ? "原始事件" : value}
                </button>
              ))}
            </div>
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              自动滚动
            </label>
          </div>
          <div className="cron-meta">
            {run ? (
              <>
                <Badge run={run} />
                <span>开始 {time(run.startedAt, definition.timezone)}</span>
                <span>
                  耗时 {Math.floor(duration / 60)}分{duration % 60}秒
                </span>
                <span>退出码 {run.exitCode ?? "—"}</span>
              </>
            ) : (
              "尚无运行记录"
            )}
          </div>
          <pre ref={output} className="cron-output">
            {logInfo.expired
              ? "日志已超过保留期限并被清理，最近一次结果摘要仍保留。"
              : run?.status.startsWith("skipped_")
                ? run.reason
                : text || "暂无输出"}
          </pre>
          {run?.reason && <div className="cron-log-note">{run.reason}</div>}
          {(logInfo.truncated || logInfo.clipped) && (
            <div className="cron-log-note">
              输出已截断：
              {logInfo.truncated
                ? "日志文件达到 16 MiB 上限。"
                : "界面仅显示最近 100 万字符。"}
            </div>
          )}
          <footer className="cron-log-footer">
            <span>
              {retention
                ? "日志保留 " + retention + " 天，从运行结束起计算"
                : "日志永久保留"}
            </span>
            <button className="cron-link" onClick={() => onSettings("runtime")}>
              保留设置
            </button>
          </footer>
          {run && (
            <div className="cron-log-note">
              告警：
              {
                (
                  {
                    none: "未发送",
                    pending: "待发送",
                    sent: "已发送",
                    failed: "发送失败",
                  } as const
                )[run.alertStatus]
              }
              {run.alertError ? " · " + run.alertError : ""}
            </div>
          )}
        </section>
      </div>
      <details className="cron-prompt">
        <summary>
          {runTask
            ? definition.type === "prompt"
              ? "本次运行提示词"
              : "本次运行命令"
            : "当前任务配置"}
        </summary>
        <pre>
          {definition.prompt ??
            [definition.command, ...definition.args].join(" ")}
        </pre>
      </details>
    </>
  );
}

function ImportDialog({
  api,
  projectId,
  onClose,
  onLoaded,
  onError,
}: {
  api: ReturnType<typeof schedulerApi>;
  projectId?: string;
  onClose(): void;
  onLoaded(results: SchedulerImport[]): void;
  onError(message: string): void;
}) {
  // The dialog scope and deletion policy determine both preview and the final fresh read.
  const [all, setAll] = useState(!projectId);
  // Missing task IDs are kept unless the user explicitly chooses synchronization.
  const [removeMissing, setRemoveMissing] = useState(false);
  // Per-project validation results are preserved if other projects cannot be read.
  const [preview, setPreview] = useState<{
    key: string;
    results: SchedulerImport[];
    error?: string;
  }>({ key: "", results: [] });
  // Import controls stay disabled while preview/application is in progress.
  const [applying, setApplying] = useState(false);
  const importKey =
    String(all) + ":" + String(projectId) + ":" + String(removeMissing);
  const results = preview.key === importKey ? preview.results : [];
  const busy = applying || preview.key !== importKey;
  useEffect(() => {
    let live = true;
    void api
      .load(all ? undefined : [projectId!], removeMissing, false)
      .then((data) => {
        if (live) setPreview({ key: importKey, results: data.results });
      })
      .catch((error) => {
        if (live) {
          setPreview({ key: importKey, results: [], error: String(error) });
          onError(String(error));
        }
      });
    return () => {
      live = false;
    };
  }, [api, all, projectId, removeMissing, importKey, onError]);
  const changes = results
    .filter((result) => result.status === "valid")
    .reduce(
      (sum, result) => sum + result.added + result.updated + result.removed,
      0,
    );
  return (
    <div className="cron-modal-backdrop">
      <section
        className="cron-modal"
        role="dialog"
        aria-modal="true"
        aria-label="装载项目任务"
      >
        <header>
          <div>
            <h2>装载项目任务</h2>
            <p>读取项目下的 .cloudcli/project-schedules.json</p>
          </div>
          <button aria-label="关闭装载面板" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="cron-modal-content">
          <div className="cron-toolbar">
            <div className="cron-segment">
              <button
                disabled={!projectId}
                aria-pressed={!all}
                onClick={() => setAll(false)}
              >
                当前项目
              </button>
              <button aria-pressed={all} onClick={() => setAll(true)}>
                全部项目
              </button>
            </div>
            <label>
              <input
                type="checkbox"
                checked={removeMissing}
                onChange={(event) => setRemoveMissing(event.target.checked)}
              />
              同步删除已移除任务
            </label>
          </div>
          {preview.key === importKey && preview.error && (
            <p role="alert">{preview.error}</p>
          )}
          {busy ? (
            <p>正在读取配置…</p>
          ) : (
            results.map((result) => (
              <div className="cron-import-row" key={result.project.id}>
                <strong>{result.project.name}</strong>
                <span>
                  {result.status === "valid"
                    ? "新增 " +
                      result.added +
                      " · 更新 " +
                      result.updated +
                      " · 删除 " +
                      result.removed
                    : result.status === "missing"
                      ? "没有配置文件，已跳过"
                      : "校验失败，保留原配置"}
                </span>
                {result.error && <p role="alert">{result.error}</p>}
              </div>
            ))
          )}
          <p className="cron-muted">
            正在执行的任务继续运行，新配置从下一次执行开始生效。
          </p>
        </div>
        <footer>
          <button disabled={applying} onClick={onClose}>
            取消
          </button>
          <button
            className="cron-primary"
            disabled={
              busy || !results.some((result) => result.status === "valid")
            }
            onClick={() => {
              setApplying(true);
              void api
                .load(all ? undefined : [projectId!], removeMissing, true)
                .then((data) => {
                  setPreview({ key: importKey, results: data.results });
                  if (data.results.some((result) => result.status === "valid"))
                    onLoaded(data.results);
                  else onError("没有项目通过校验，原有配置保持不变");
                })
                .catch((error) => onError(String(error)))
                .finally(() => setApplying(false));
            }}
          >
            装载 {changes} 项变更
          </button>
        </footer>
      </section>
    </div>
  );
}

function SettingsPanel({
  settings,
  initialTab,
  api,
  onBack,
  onSave,
  onError,
}: {
  settings: PublicSchedulerSettings;
  initialTab: SettingsTab;
  api: ReturnType<typeof schedulerApi>;
  onBack(): void;
  onSave(settings: PublicSchedulerSettings): void;
  onError(message: string): void;
}) {
  // Settings editing is kept local until save; no stored token is fetched back into an input.
  const [draft, setDraft] = useState(settings);
  // The execution-environment tab edits the global env map; alerts and runtime keep their forms.
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  // Env rows carry stable ids so renaming a variable does not remount or blur its input.
  const [envRows, setEnvRows] = useState<EnvRow[]>(() =>
    envRowsFrom(settings.env),
  );
  // Empty token input means retain the existing secret.
  const [token, setToken] = useState("");
  // Prevent duplicate settings writes and test messages.
  const [busy, setBusy] = useState(false);
  const updateEnvRow = (id: number, change: Partial<Omit<EnvRow, "id">>) =>
    setEnvRows((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...change } : row)),
    );
  const save = async (test: boolean) => {
    // Duplicate or invalid names fail here; never let the map silently collapse rows.
    const environment = environmentRowsToMap(envRows);
    if (environment.error) {
      onError(environment.error);
      setTab("environment");
      return;
    }
    setBusy(true);
    try {
      const value = await api.saveSettings({
        ...draft,
        env: environment.env,
        telegram: { ...draft.telegram, botToken: token },
      });
      setDraft(value);
      setEnvRows(envRowsFrom(value.env));
      setToken("");
      onSave(value);
      if (test) {
        await api.testAlert();
        onError("测试告警已发送");
      }
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="cron-back" onClick={onBack}>
        <ArrowLeft size={14} />
        返回任务列表
      </button>
      <header className="cron-heading">
        <div>
          <h2>插件设置</h2>
          <p>所有项目共用</p>
        </div>
      </header>
      <div className="cron-settings-tabs">
        <button
          aria-pressed={tab === "alerts"}
          onClick={() => setTab("alerts")}
        >
          告警渠道
        </button>
        <button
          aria-pressed={tab === "environment"}
          onClick={() => setTab("environment")}
        >
          执行环境
        </button>
        <button
          aria-pressed={tab === "runtime"}
          onClick={() => setTab("runtime")}
        >
          运行与日志
        </button>
      </div>
      {tab === "alerts" ? (
        <div className="cron-form">
          <h3>Telegram · default</h3>
          <label className="cron-checkbox">
            <input
              type="checkbox"
              checked={draft.telegram.enabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  telegram: {
                    ...draft.telegram,
                    enabled: event.target.checked,
                  },
                })
              }
            />
            启用失败告警
          </label>
          <label>
            Bot token
            <input
              type="password"
              autoComplete="new-password"
              value={token}
              placeholder={
                draft.telegram.botTokenConfigured
                  ? "已配置，留空保持原 token"
                  : "输入 Telegram bot token"
              }
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label>
            Chat ID
            <input
              value={draft.telegram.chatId}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  telegram: { ...draft.telegram, chatId: event.target.value },
                })
              }
            />
          </label>
          <label>
            HTTP/HTTPS 代理（可选）
            <input
              value={draft.telegram.proxy}
              placeholder="http://127.0.0.1:7890"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  telegram: { ...draft.telegram, proxy: event.target.value },
                })
              }
            />
          </label>
          <p>
            失败、启动失败、超时及意外中断发送告警。告警发送失败不会重新执行任务。
          </p>
        </div>
      ) : null}
      {tab === "runtime" && (
        <div className="cron-form cron-form-grid">
          <label>
            默认时区
            <select
              value={draft.timezone}
              onChange={(event) =>
                setDraft({ ...draft, timezone: event.target.value })
              }
            >
              {draft.timezone &&
                !COMMON_TIMEZONES.some((zone) => zone.value === draft.timezone) && (
                  <option value={draft.timezone}>
                    {draft.timezone}（当前已保存）
                  </option>
                )}
              {COMMON_TIMEZONES.map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            默认执行超时（秒，0 为不限）
            <input
              type="number"
              min="0"
              value={draft.timeoutSeconds}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  timeoutSeconds: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            全局最大并发数
            <input
              type="number"
              min="1"
              max="100"
              value={draft.maxConcurrentRuns}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  maxConcurrentRuns: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            日志保留天数
            <input
              type="number"
              min="0"
              value={draft.retentionDays}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  retentionDays: Number(event.target.value),
                })
              }
            />
            <small>默认 30 天，0 表示永久保留。</small>
          </label>
          <p className="cron-wide">
            运行历史、stdout、stderr
            和原始事件从运行结束起计算。正在运行的日志不清理，最近一次结果摘要仍保留。缩短天数会影响已有数据，已清理日志不可恢复。
          </p>
          <p className="cron-wide">
            重启恢复已装载任务；停机期间的时间点直接跳过。
          </p>
          <p className="cron-wide">
            默认时区和超时用于下次装载；并发上限、日志保留及告警设置保存后生效。
          </p>
        </div>
      )}
      {tab === "environment" && (
        <div className="cron-form cron-env-form">
          <h3>所有项目共用</h3>
          <p className="cron-env-intro">
            这些变量会附加到所有项目的脚本任务和提示词任务（包括脚本调用的
            AGENT_EXEC）。任务 <code>env</code> 中的同名变量优先；宿主已有变量被这里的值覆盖。
          </p>
          <div className="cron-env-rows">
            {envRows.map((row, index) => (
              <div className="cron-env-row" key={row.id}>
                <label>
                  变量名
                  <input
                    className="cron-env-name"
                    value={row.name}
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="例如 DATABASE_URL"
                    onChange={(event) =>
                      updateEnvRow(row.id, { name: event.target.value })
                    }
                  />
                </label>
                <label>
                  变量值
                  <textarea
                    className="cron-env-value"
                    value={row.value}
                    disabled={busy}
                    rows={2}
                    spellCheck={false}
                    placeholder="支持多行"
                    onChange={(event) =>
                      updateEnvRow(row.id, { value: event.target.value })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="cron-danger cron-env-remove"
                  aria-label={"删除变量 " + (row.name || index + 1)}
                  disabled={busy}
                  onClick={() =>
                    setEnvRows((rows) =>
                      rows.filter((item) => item.id !== row.id),
                    )
                  }
                >
                  删除
                </button>
              </div>
            ))}
            {!envRows.length && (
              <p className="cron-muted">尚未配置额外环境变量。</p>
            )}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEnvRows((rows) => [...rows, envRow()])}
          >
            添加变量
          </button>
          <p>
            保存后下一次执行直接生效，正在运行的任务保持启动时的环境。变量名只能包含字母、数字与下划线且不能以数字开头；
            AGENT_EXEC、CLOUDCLI_HOST_ROOT、CLOUDCLI_PROJECTS_FILE 及
            CLOUDCLI_PLUGIN_、CLOUDCLI_SCHEDULER_ 前缀为调度器保留。所有项目脚本与提示词共用此配置，任务
            <code>env</code> 可覆盖同名变量。
          </p>
        </div>
      )}
      <footer className="cron-settings-footer">
        {tab === "alerts" && (
          <button disabled={busy} onClick={() => void save(true)}>
            保存并发送测试告警
          </button>
        )}
        <button
          className="cron-primary"
          disabled={busy}
          onClick={() => void save(false)}
        >
          {busy ? "处理中…" : "保存设置"}
        </button>
      </footer>
    </>
  );
}

/** CloudCLI loads this module through the standard plugin mount contract. */
export function mount(container: HTMLElement, host: SchedulerHost): void {
  const root = createRoot(container);
  roots.set(container, root);
  root.render(<Scheduler host={host} />);
}
/** Plugin host invokes this when changing tabs, disabling, or unloading the plugin. */
export function unmount(container: HTMLElement): void {
  roots.get(container)?.unmount();
  roots.delete(container);
}
