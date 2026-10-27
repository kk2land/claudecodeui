import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Copy,
  FileJson,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import type { SchedulerHost } from "./api.js";
import { schedulerApi, type SchedulerProjectConfig } from "./api.js";
import {
  addDraftTask,
  cloneConfig,
  COMMON_TIMEZONES,
  configTaskId,
  copyDraftTask,
  createTaskDraft,
  cronFromTemplate,
  cronTemplateOf,
  describeCron,
  getConfigValue,
  nextTaskId,
  parseConfigDocument,
  removeDraftTask,
  restoreDraftTask,
  summarizeDraft,
  updateConfigText,
  type ConfigObject,
  type ConfigTask,
  type ConfigTextResult,
  type CronTemplate,
} from "./configurationDraft.js";
import { environmentNameError } from "../shared/contracts.js";
import type { SchedulerProject } from "../shared/contracts.js";
import {
  AgentModelFields,
  useAgentModelCatalogs,
  type AgentModelCatalogs,
  type AgentSelectionChange,
} from "./AgentModelFields.js";

type ConfigurationEditorProps = {
  /** Authenticated RPC bridge; all requests go through the centralized client helpers. */
  host: SchedulerHost;
  /** The project chosen when the editor opened. It never follows host context changes. */
  project: SchedulerProject;
  /** Current host project id, used only to warn that the host moved away from this project. */
  hostProjectId: string | null;
  /** Plugin timezone, used for inherited defaults and schedule preview labels. */
  pluginTimezone: string | null;
  /** Leaves the editor without saving; the parent restores the task list. */
  onExit(): void;
  /** The file was written and loaded; the parent refreshes inventory and shows a notice. */
  onSaved(): void;
  /** Reports transport or validation messages in the plugin notice area. */
  onError(message: string): void;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready" };

type PreviewState = {
  /** Draft text the result belongs to; stale responses never authorize a save. */
  text: string;
  result: {
    valid: boolean;
    errors?: string[];
    tasks: Array<{ taskId: string; nextRuns: string[] }>;
    changes: { added: number; updated: number; removed: number; reEnabled: number };
  };
};

type RawFieldState = { text: string; error: string | null };

const EMPTY_PREVIEW = {
  valid: false,
  errors: ["等待校验"],
  tasks: [] as Array<{ taskId: string; nextRuns: string[] }>,
  changes: { added: 0, updated: 0, removed: 0, reEnabled: 0 },
};
const INHERIT = "";
const scheduleModes: Array<{ value: CronTemplate["kind"]; label: string }> = [
  { value: "seconds", label: "每隔 N 秒" },
  { value: "minutes", label: "每隔 N 分钟" },
  { value: "daily", label: "每天固定时间" },
  { value: "weekly", label: "每周固定时间" },
  { value: "custom", label: "自定义 Cron" },
];
const weekdayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const stringValue = (value: unknown) => (typeof value === "string" ? value : "");
const booleanValue = (value: unknown) =>
  typeof value === "boolean" ? value : null;
const numberInput = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const parseInteger = (value: string) =>
  /^-?\d+$/.test(value.trim()) ? Number(value) : null;
const taskKey = (task: ConfigTask, index: number) =>
  configTaskId(task) || "#" + index;

/** Used by the scheduler plugin to edit a project's configuration file without writing it early. */
export function ConfigurationEditor({
  host,
  project,
  hostProjectId,
  pluginTimezone,
  onExit,
  onSaved,
  onError,
}: ConfigurationEditorProps) {
  const api = useMemo(() => schedulerApi(host), [host]);
  // Raw JSON text is the single draft source; the visual form derives from it and writes back.
  const [text, setText] = useState("");
  // The text that was last read from or written to the file; unsaved edits differ from it.
  const [savedText, setSavedText] = useState("");
  // Baseline tasks from the loaded file, used for new/modified/removed badges.
  const [baseline, setBaseline] = useState<ConfigTask[]>([]);
  // Opaque revision required for optimistic concurrency on save.
  const [revision, setRevision] = useState<string | null>(null);
  // Whether the server found a file; a missing file is created only by an explicit save.
  const [exists, setExists] = useState(false);
  // Initial file read state; the form never renders before a successful read.
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  // Visual form or raw JSON; both always render the same `text` value.
  const [jsonMode, setJsonMode] = useState(false);
  // Selected task index inside the draft task array.
  const [selected, setSelected] = useState<number | null>(null);
  // Server preview is used for validation, future runs, and pending re-enables.
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // Preview requests are debounced; this flag only affects the status text.
  const [previewBusy, setPreviewBusy] = useState(false);
  // Save/retry is serialized so one click cannot send two writers.
  const [saving, setSaving] = useState(false);
  // A written-but-not-loaded file keeps the editor open and offers an explicit reload retry.
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  // A revision conflict preserves the draft and exposes the latest file side by side.
  const [conflict, setConflict] = useState<SchedulerProjectConfig | null>(null);
  // Cancel asks inline before discarding a dirty draft.
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Host id acknowledged after "continue editing"; a later change warns again.
  const [acknowledgedHostId, setAcknowledgedHostId] = useState<string | null>(null);
  // The host project that was active when the editor opened; only later changes are a warning.
  const [initialHostId] = useState(hostProjectId);
  // Args/env text fields are keyed by stable task index so renaming an ID keeps them visible.
  const [rawFields, setRawFields] = useState<Record<string, RawFieldState>>({});
  // Latest project identity as returned by the server, used to avoid showing a raw id.
  // The server response is authoritative; until it arrives, avoid showing an opaque project id.
  const [resolvedName, setResolvedName] = useState(project.name);
  // Host model catalogs back both agent selects; loading them never touches the draft.
  const { catalogs, retry: retryCatalogs, canRetry: canRetryCatalogs } =
    useAgentModelCatalogs(host, load.status === "ready");
  // Local schema error from parsing the raw draft; it blocks visual editing and saving.
  const parsed = useMemo(() => parseConfigDocument(text), [text]);
  const tasks = useMemo(() => parsed.ok ? parsed.document.tasks : [], [parsed]);
  const summary = useMemo(() => summarizeDraft(baseline, tasks), [baseline, tasks]);
  // Uncommitted raw-field edits (mostly invalid JSON) are dirty even when the text is unchanged.
  const fieldErrors = Object.values(rawFields).filter((field) => field.error);
  const dirty =
    load.status === "ready" && (text !== savedText || fieldErrors.length > 0);
  const currentPreview =
    preview && preview.text === text ? preview.result : EMPTY_PREVIEW;
  const previewCurrent = Boolean(preview && preview.text === text);
  const previewValid = previewCurrent && currentPreview.valid;
  // Warn only when the host project actually changed after this editor opened: opening the editor
  // from "all projects" while a different host project is active is not itself a change.
  const hostMovedAway =
    hostProjectId !== initialHostId &&
    hostProjectId !== project.id &&
    acknowledgedHostId !== hostProjectId;
  // Inputs stay locked from the click until the response decides the next state.
  const savingRef = useRef(false);
  // Any host switch after opening (including a switch back) deserves a fresh acknowledgement.
  const lastSeenHost = useRef(hostProjectId);
  useEffect(() => {
    if (lastSeenHost.current === hostProjectId) return;
    lastSeenHost.current = hostProjectId;
    setAcknowledgedHostId(null);
  }, [hostProjectId]);
  // Once the host returns to the edited project there is nothing to leave; clear the reminder.
  useEffect(() => {
    if (hostProjectId === project.id) setAcknowledgedHostId(null);
  }, [hostProjectId, project.id]);

  const report = useCallback(
    (message: string) => {
      onError(message);
    },
    [onError],
  );

  // Initial read is keyed by the fixed project id; it never follows later host context changes.
  const loadProject = useCallback(async () => {
    setLoad({ status: "loading" });
    setPreview(null);
    setConflict(null);
    setLoadFailure(null);
    setRawFields({});
    try {
      const value = await api.configuration(project.id);
      const parsedValue = parseConfigDocument(value.text);
      setText(value.text);
      setSavedText(value.text);
      setRevision(value.revision);
      setExists(value.exists);
      if (value.project?.name) setResolvedName(value.project.name);
      setBaseline(parsedValue.ok ? cloneConfig(parsedValue.document.tasks) : []);
      setJsonMode(!parsedValue.ok);
      setSelected(parsedValue.ok && parsedValue.document.tasks.length ? 0 : null);
      setLoad({ status: "ready" });
      if (value.error) report(value.error);
      if (!parsedValue.ok) report(parsedValue.error);
    } catch (error) {
      setLoad({ status: "error", error: String(error) });
    }
  }, [api, project.id, report]);
  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  // Warn browser-level navigation only while the draft differs from the file.
  useEffect(() => {
    if (!dirty) return;
    const handle = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handle);
    return () => window.removeEventListener("beforeunload", handle);
  }, [dirty]);

  // Debounced preview. Only the response for the latest text may authorize saving.
  useEffect(() => {
    if (load.status !== "ready") return;
    if (!parsed.ok) {
      setPreview(null);
      setPreviewBusy(false);
      return;
    }
    let live = true;
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      void api
        .previewConfiguration(project.id, text)
        .then((result) => {
          if (live) {
            setPreview({ text, result });
            setPreviewBusy(false);
          }
        })
        .catch((error) => {
          if (live) {
            setPreview({
              text,
              result: { ...EMPTY_PREVIEW, errors: [String(error)] },
            });
            setPreviewBusy(false);
          }
        });
    }, 450);
    return () => {
      live = false;
      clearTimeout(timer);
      setPreviewBusy(false);
    };
  }, [api, load.status, parsed.ok, project.id, text]);

  // Keep a valid selection while the draft grows, shrinks, or first loads.
  useEffect(() => {
    setSelected((current) =>
      tasks.length === 0
        ? null
        : current === null || current >= tasks.length
          ? 0
          : current,
    );
  }, [tasks.length]);

  const selectedTask = selected === null ? null : (tasks[selected] ?? null);
  // Raw field edits follow the draft position, so a rename keeps them attached to the same task.
  const rawKey = (index: number, field: "args" | "env") => index + ":" + field;
  // Only uncommittable input (invalid JSON) survives in rawFields; valid edits live in the draft.
  const hasPendingRawEdit = Object.keys(rawFields).length > 0;
  const pendingRawError = fieldErrors.length > 0;

  const taskCron = selectedTask ? stringValue(selectedTask.cron) : "";
  const template = cronTemplateOf(taskCron);
  // "Custom" can be chosen without rewriting an existing template cron immediately.
  const [forceCustom, setForceCustom] = useState(false);
  const templateKind = forceCustom ? "custom" : template.kind;
  useEffect(() => {
    setForceCustom(false);
  }, [selected]);

  const mutate = useCallback(
    (mutator: (value: ConfigObject) => void): boolean => {
      const result: ConfigTextResult = updateConfigText(text, mutator);
      if ("error" in result) {
        report(result.error);
        return false;
      }
      setText(result.text);
      setConflict(null);
      setLoadFailure(null);
      return true;
    },
    [report, text],
  );

  const writePath = useCallback(
    (path: string[], value: unknown) => {
      mutate((document) => {
        if (value === undefined) deleteConfigValueInPlace(document, path);
        else setConfigValueInPlace(document, path, value);
        pruneEmptyDefaults(document);
      });
    },
    [mutate],
  );
  const writeTaskPath = useCallback(
    (index: number, path: string[], value: unknown) => {
      mutate((document) => {
        const task = (document.tasks as ConfigTask[])[index];
        if (!task) throw new Error("任务不存在");
        if (value === undefined) deleteConfigValueInPlace(task, path);
        else setConfigValueInPlace(task, path, value);
      });
    },
    [mutate],
  );
  /**
   * Applies one coordinated agent edit. Undefined deletes the property, and the whole change is
   * skipped when nothing would differ, so opening the editor or re-picking a value never rewrites
   * unrelated JSON.
   */
  const writeAgentSelection = useCallback(
    (scope: "defaults" | "task", index: number | null, change: AgentSelectionChange) => {
      const base = scope === "defaults" ? ["defaults", "agent"] : ["agent"];
      const current = parseConfigDocument(text);
      if (!current.ok) {
        report(current.error);
        return;
      }
      const target =
        scope === "defaults"
          ? current.document.value
          : current.document.tasks[index ?? -1];
      if (!target) {
        report("任务不存在");
        return;
      }
      const changed = Object.entries(change).some(
        ([key, value]) => getConfigValue(target, [...base, key]) !== value,
      );
      if (!changed) return;
      mutate((document) => {
        const writeTarget =
          scope === "defaults"
            ? (document as ConfigObject)
            : (document.tasks as ConfigTask[])[index ?? -1];
        if (!writeTarget) throw new Error("任务不存在");
        for (const [key, value] of Object.entries(change)) {
          const path = [...base, key];
          if (value === undefined) deleteConfigValueInPlace(writeTarget, path);
          else setConfigValueInPlace(writeTarget, path, value);
        }
        if (scope === "defaults") pruneEmptyDefaults(document);
      });
    },
    [mutate, report, text],
  );

  const changeSelection = (index: number) => {
    if (savingRef.current) return;
    setSelected(index);
  };
  const toggleJson = (next: boolean) => {
    if (savingRef.current) return;
    // Invalid raw input cannot be represented in JSON text; keep it visible until fixed/discarded.
    if (next && hasPendingRawEdit) {
      report("请先修复或放弃 args / env 的无效输入，再切换到 JSON 视图");
      return;
    }
    setJsonMode(next);
  };
  const requestClose = () => {
    if (savingRef.current) return;
    if (dirty) setConfirmCancel(true);
    else onExit();
  };
  const discardAndExit = () => {
    if (savingRef.current) return;
    setConfirmCancel(false);
    setRawFields({});
    onExit();
  };

  /** Shifts index-keyed raw field edits when tasks are inserted or removed. */
  const shiftRawFields = (from: number, delta: 1 | -1) => {
    setRawFields((fields) => {
      const next: Record<string, RawFieldState> = {};
      for (const [key, value] of Object.entries(fields)) {
        const [rawIndex, field] = key.split(":");
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || !field) continue;
        if (delta === -1 && index === from) continue;
        const target = index >= from ? index + delta : index;
        if (target >= 0) next[target + ":" + field] = value;
      }
      return next;
    });
  };
  const addTask = (type: "script" | "prompt") => {
    if (savingRef.current) return;
    const id = nextTaskId(tasks.map(configTaskId).filter(Boolean), type + "-task");
    const result = addDraftTask(text, createTaskDraft(id, type));
    if ("error" in result) {
      report(result.error);
      return;
    }
    setText(result.text);
    setConflict(null);
    // Appending keeps every existing index and any pending raw-field edit attached.
    setSelected(result.index);
  };
  const copyTask = (index: number) => {
    if (savingRef.current) return;
    const result = copyDraftTask(text, index);
    if ("error" in result) {
      report(result.error);
      return;
    }
    shiftRawFields(index + 1, 1);
    setText(result.text);
    setConflict(null);
    setSelected(result.index);
  };
  const deleteTask = (index: number) => {
    if (savingRef.current) return;
    const result = removeDraftTask(text, index);
    if ("error" in result) {
      report(result.error);
      return;
    }
    shiftRawFields(index, -1);
    setText(result.text);
    setConflict(null);
    setConfirmCancel(false);
    setSelected((current) => {
      if (current === null) return null;
      if (current === index) return index > 0 ? index - 1 : 0;
      return current > index ? current - 1 : current;
    });
  };
  const restoreTask = (task: ConfigTask, index: number) => {
    if (savingRef.current) return;
    const result = restoreDraftTask(text, task, index);
    if ("error" in result) {
      report(result.error);
      return;
    }
    // Inserting shifts later tasks; pending raw edits follow their own task.
    shiftRawFields(result.index, 1);
    setText(result.text);
    setConflict(null);
    setSelected(result.index);
  };

  const updateRawField = (field: "args" | "env", value: string) => {
    if (savingRef.current || selected === null || !selectedTask) return;
    const key = rawKey(selected, field);
    const validation =
      field === "args" ? parseArgsText(value) : parseEnvText(value);
    if (validation.error) {
      // Invalid text is kept visible but never committed into the JSON draft.
      setRawFields((fields) => ({
        ...fields,
        [key]: { text: value, error: validation.error },
      }));
      return;
    }
    // Valid text goes straight into the draft and stops being a pending local edit.
    setRawFields((fields) => {
      if (!fields[key]) return fields;
      const next = { ...fields };
      delete next[key];
      return next;
    });
    writeTaskPath(
      selected,
      [field],
      validation.empty ? undefined : validation.value,
    );
  };
  /** Blur commits valid pending text; invalid text stays for the user to fix or discard. */
  const commitRawField = (field: "args" | "env") => {
    if (savingRef.current || selected === null || !selectedTask) return;
    const key = rawKey(selected, field);
    const entry = rawFields[key];
    if (!entry) return;
    const validation =
      field === "args" ? parseArgsText(entry.text) : parseEnvText(entry.text);
    if (validation.error) {
      setRawFields((fields) => ({
        ...fields,
        [key]: { text: entry.text, error: validation.error },
      }));
      return;
    }
    setRawFields((fields) => {
      const next = { ...fields };
      delete next[key];
      return next;
    });
    writeTaskPath(
      selected,
      [field],
      validation.empty ? undefined : validation.value,
    );
  };
  const resetRawField = (index: number, field: "args" | "env") => {
    const key = rawKey(index, field);
    setRawFields((fields) => {
      const next = { ...fields };
      delete next[key];
      return next;
    });
  };
  /** Discards every uncommitted args/env input; the draft text itself is kept. */
  const discardRawFields = () => {
    setRawFields({});
  };

  // A save writes exactly the text it was clicked with; later edits never ride along silently.
  const submit = async (captured: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setLoadFailure(null);
    try {
      const result = await api.saveConfiguration(project.id, captured, revision);
      if (result.conflict) {
        setConflict(result.latest ?? null);
        report("配置已被其他修改更新，草稿已保留，请先比较最新文件");
        return;
      }
      if (!result.saved) {
        report(result.error || "配置未保存");
        return;
      }
      setRevision(result.revision);
      setExists(true);
      // Only the sent text becomes the new baseline; the editor is locked while saving anyway.
      setSavedText(captured);
      if (!result.loaded) {
        setLoadFailure(result.error || "配置未装载");
        return;
      }
      onSaved();
    } catch (error) {
      report(String(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const save = () => {
    if (savingRef.current) return;
    if (hasPendingRawEdit) {
      report("请先提交或放弃 args / env 的未提交修改");
      return;
    }
    if (!previewCurrent || !previewValid) {
      report("请等待当前草稿校验通过后再保存");
      return;
    }
    void submit(text);
  };
  const retryLoad = () => {
    if (savingRef.current) return;
    if (hasPendingRawEdit) {
      report("请先修复或放弃 args / env 的未提交修改，再重试装载");
      return;
    }
    if (!previewCurrent || !previewValid) {
      report("请先让当前草稿通过校验");
      return;
    }
    void submit(text);
  };
  const adoptLatest = () => {
    if (!conflict || savingRef.current) return;
    const latest = conflict;
    const parsedLatest = parseConfigDocument(latest.text);
    setText(latest.text);
    setSavedText(latest.text);
    setRevision(latest.revision);
    setExists(latest.exists);
    setBaseline(parsedLatest.ok ? cloneConfig(parsedLatest.document.tasks) : []);
    setSelected(parsedLatest.ok && parsedLatest.document.tasks.length ? 0 : null);
    setJsonMode(!parsedLatest.ok);
    setRawFields({});
    setConflict(null);
    setLoadFailure(null);
    setPreview(null);
    if (!parsedLatest.ok) report(parsedLatest.error);
  };

  const effectiveZone = selectedTask
    ? stringValue(selectedTask.timezone) ||
      stringValue(getConfigValue(parsed.ok ? parsed.document.value : {}, ["timezone"])) ||
      pluginTimezone ||
      ""
    : "";
  const inheritedZone = selectedTask
    ? !stringValue(selectedTask.timezone)
    : false;

  // Never surface a raw UUID: the host only sends an opaque id, so wait for the server's name.
  const displayName = resolvedName || "正在读取项目…";
  if (load.status === "loading")
    return (
      <EditorShell project={{ ...project, name: displayName }} onClose={requestClose} busy={false}>
        <div className="cron-editor-loading" role="status">
          正在读取项目配置…
        </div>
      </EditorShell>
    );
  if (load.status === "error")
    return (
      <EditorShell project={{ ...project, name: displayName }} onClose={requestClose} busy={false}>
        <div className="cron-editor-loading" role="alert">
          <p>读取配置失败：{load.error}</p>
          <button onClick={() => void loadProject()}>重试读取</button>
        </div>
      </EditorShell>
    );

  const defaults = parsed.ok ? parsed.document.value : {};
  const rawTimezone = stringValue(defaults.timezone);
  const defaultAgent = isRecord(defaults.defaults)
    ? (defaults.defaults.agent as Record<string, unknown> | undefined)
    : undefined;
  const defaultAgentValue = isRecord(defaultAgent) ? defaultAgent : {};
  const defaultSettings = isRecord(defaults.defaults) ? defaults.defaults : {};
  const alerts = isRecord(defaults.alerts) ? defaults.alerts : {};
  const telegram = alerts.telegram;
  const changes = currentPreview.changes;
  const previewTasks = currentPreview.tasks;
  const nextRuns = selectedTask
    ? (previewTasks.find(
        (entry) => entry.taskId === configTaskId(selectedTask),
      )?.nextRuns ?? [])
    : [];

  return (
    <EditorShell
      project={{ ...project, name: displayName }}
      onClose={requestClose}
      busy={saving}
      headerExtra={
        <div className="cron-editor-views" role="group" aria-label="编辑视图">
          <button
            aria-pressed={!jsonMode}
            disabled={!parsed.ok || saving}
            onClick={() => toggleJson(false)}
          >
            视觉编辑
          </button>
          <button
            aria-pressed={jsonMode}
            disabled={saving}
            onClick={() => toggleJson(true)}
          >
            <FileJson size={14} />
            JSON
          </button>
        </div>
      }
    >
      {hostMovedAway && (
        <div className="cron-editor-banner" role="status">
          <AlertTriangle size={15} />
          <span>
            宿主已切换到其他项目，当前仍在编辑 {displayName}，不会悄悄改到另一个文件。
          </span>
          <button
            disabled={saving}
            onClick={() => setAcknowledgedHostId(hostProjectId)}
          >
            继续编辑本项目
          </button>
          <button className="cron-danger" disabled={saving} onClick={discardAndExit}>
            放弃修改并退出
          </button>
        </div>
      )}
      {loadFailure && (
        <div className="cron-editor-banner cron-editor-warning" role="alert">
          <AlertTriangle size={15} />
          <span>
            文件已写入，但装载失败：{loadFailure}。编辑器与草稿仍保留，可重试装载。
          </span>
          <button disabled={saving || hasPendingRawEdit || !previewValid} onClick={() => retryLoad()}>
            重试装载
          </button>
        </div>
      )}
      {conflict && (
        <div className="cron-editor-banner cron-editor-conflict" role="alert">
          <div className="cron-editor-conflict-head">
            <AlertTriangle size={15} />
            <strong>配置文件已被其他修改更新。草稿未被覆盖。</strong>
            <button className="cron-danger" disabled={saving} onClick={adoptLatest}>
              放弃草稿并读取最新文件
            </button>
            <button disabled={saving} onClick={() => setConflict(null)}>
              保留草稿继续编辑
            </button>
          </div>
          <div className="cron-editor-conflict-diff">
            <label>
              当前草稿（未保存）
              <pre>{text}</pre>
            </label>
            <label>
              磁盘上的最新文件
              <pre>{conflict.text}</pre>
            </label>
          </div>
        </div>
      )}
      {confirmCancel && (
        <div className="cron-editor-banner" role="alert">
          <span>
            {hasPendingRawEdit
              ? "有未提交的 args / env 修改和未保存的草稿。确定放弃并退出编辑？"
              : "有未保存的修改。确定放弃修改并退出编辑？"}
          </span>
          <button disabled={saving} onClick={() => setConfirmCancel(false)}>
            继续编辑
          </button>
          <button className="cron-danger" disabled={saving} onClick={discardAndExit}>
            放弃修改
          </button>
        </div>
      )}
      {!exists && (
        <div className="cron-editor-banner" role="status">
          项目还没有配置文件；保存时才会创建 .cloudcli/project-schedules.json。
        </div>
      )}
      {hasPendingRawEdit && (
        <div className="cron-editor-banner cron-editor-warning" role="alert">
          <AlertTriangle size={15} />
          <span>
            {pendingRawError
              ? "args / env 中存在无效 JSON，保存已禁用。修复后提交，或放弃这些输入。"
              : "args / env 仍有未提交的输入，保存前请先提交。"}
          </span>
          <button disabled={saving} onClick={discardRawFields}>
            放弃 args / env 输入
          </button>
        </div>
      )}
      {!parsed.ok && (
        <div className="cron-editor-banner cron-editor-warning" role="alert">
          <AlertTriangle size={15} />
          <span>{parsed.error}。请切换到 JSON 视图修复；视觉表单与保存已禁用。</span>
          <button disabled={saving} onClick={() => setJsonMode(true)}>
            前往 JSON 修复
          </button>
        </div>
      )}
      <fieldset className="cron-editor-content" disabled={saving}>
        {jsonMode || !parsed.ok ? (
          <div className="cron-editor-json">
            <textarea
              aria-label="项目配置 JSON"
              spellCheck={false}
              value={text}
              disabled={saving}
              onChange={(event) => {
                setText(event.target.value);
                setConflict(null);
                setLoadFailure(null);
              }}
            />
            <div className="cron-editor-json-meta">
              <span>
                {parsed.ok
                  ? "JSON 有效 · " + tasks.length + " 项任务"
                  : parsed.error}
              </span>
              <span>未知字段与未改任务会原样保留。</span>
            </div>
          </div>
        ) : (
          <>
          <details className="cron-editor-defaults">
            <summary>项目默认配置</summary>
            <div className="cron-editor-defaults-grid">
              <label>
                项目 IANA 时区
                <select
                  value={rawTimezone}
                  onChange={(event) =>
                    writePath(["timezone"], event.target.value || undefined)
                  }
                >
                  <option value={INHERIT}>
                    继承插件设置{pluginTimezone ? "（" + pluginTimezone + "）" : ""}
                  </option>
                  {rawTimezone &&
                    !COMMON_TIMEZONES.some((zone) => zone.value === rawTimezone) && (
                      <option value={rawTimezone}>{rawTimezone}（当前文件）</option>
                    )}
                  {COMMON_TIMEZONES.map((zone) => (
                    <option key={zone.value} value={zone.value}>
                      {zone.label}
                    </option>
                  ))}
                </select>
              </label>
              <AgentModelFields
                scope="defaults"
                provider={stringValue(defaultAgentValue.provider)}
                model={stringValue(defaultAgentValue.model)}
                effort={stringValue(defaultAgentValue.effort)}
                fallbackProvider="codex"
                fallbackModel="default"
                catalogs={catalogs}
                canRetry={canRetryCatalogs}
                onRetry={retryCatalogs}
                onChange={(change) => writeAgentSelection("defaults", null, change)}
              />
              <label>
                defaults.timeoutSeconds
                <input
                  type="number"
                  min="0"
                  value={numberInput(defaultSettings.timeoutSeconds)}
                  placeholder="继承插件设置"
                  onChange={(event) => {
                    if (!event.target.value) {
                      writePath(["defaults", "timeoutSeconds"], undefined);
                      return;
                    }
                    const value = parseInteger(event.target.value);
                    if (value !== null && value >= 0)
                      writePath(["defaults", "timeoutSeconds"], value);
                  }}
                />
              </label>
              <label>
                defaults.allowConcurrent
                <select
                  value={
                    booleanValue(defaultSettings.allowConcurrent) === null
                      ? INHERIT
                      : String(booleanValue(defaultSettings.allowConcurrent))
                  }
                  onChange={(event) =>
                    writePath(
                      ["defaults", "allowConcurrent"],
                      event.target.value === INHERIT
                        ? undefined
                        : event.target.value === "true",
                    )
                  }
                >
                  <option value={INHERIT}>继承（禁止并发）</option>
                  <option value="true">允许并发</option>
                  <option value="false">禁止并发</option>
                </select>
              </label>
              <label>
                alerts.telegram
                <select
                  value={
                    telegram === undefined
                      ? INHERIT
                      : telegram === false
                        ? "false"
                        : "default"
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    writePath(
                      ["alerts", "telegram"],
                      value === INHERIT
                        ? undefined
                        : value === "false"
                          ? false
                          : "default",
                    );
                  }}
                >
                  <option value={INHERIT}>继承（default）</option>
                  <option value="default">default（按插件告警）</option>
                  <option value="false">false（关闭本任务告警）</option>
                </select>
              </label>
            </div>
          </details>
          <div className="cron-editor-body">
            <aside className="cron-editor-side" aria-label="任务草稿列表">
              <div className="cron-editor-add">
                <button onClick={() => addTask("script")}>
                  <Plus size={14} /> 新增脚本
                </button>
                <button onClick={() => addTask("prompt")}>
                  <Plus size={14} /> 新增提示词
                </button>
              </div>
              <ul className="cron-editor-tasks">
                {tasks.map((task, index) => {
                  const status = summary.statuses[index] ?? "unchanged";
                  return (
                    <li key={taskKey(task, index)}>
                      <button
                        aria-pressed={selected === index}
                        onClick={() => changeSelection(index)}
                      >
                        <span>{stringValue(task.name) || configTaskId(task) || "未命名任务"}</span>
                        <small>
                          {configTaskId(task) || "缺少 ID"} · {stringValue(task.type) || "未知类型"}
                        </small>
                        {status !== "unchanged" && (
                          <em className={"cron-draft-" + status}>
                            {status === "new" ? "新增" : "已修改"}
                          </em>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {summary.removed.length > 0 && (
                <div className="cron-editor-removed">
                  <h3>待删除（保存后移除）</h3>
                  {summary.removed.map(({ task, index }) => (
                    <div key={configTaskId(task) || index}>
                      <span>{stringValue(task.name) || configTaskId(task)}</span>
                      <button onClick={() => restoreTask(task, index)}>
                        <RotateCcw size={13} /> 撤销
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {!tasks.length && <p className="cron-muted">草稿中还没有任务。</p>}
            </aside>
            <section className="cron-editor-form" aria-label="任务表单">
              {selectedTask && selected !== null ? (
                <TaskForm
                  index={selected}
                  task={selectedTask}
                  tasks={tasks}
                  templateKind={templateKind}
                  effectiveZone={effectiveZone}
                  inheritedZone={inheritedZone}
                  pluginTimezone={pluginTimezone}
                  nextRuns={nextRuns}
                  previewValid={previewValid}
                  rawFields={rawFields}
                  rawKey={rawKey}
                  catalogs={catalogs}
                  canRetryCatalogs={canRetryCatalogs}
                  onRetryCatalogs={retryCatalogs}
                  fallbackAgent={{
                    provider: stringValue(defaultAgentValue.provider) || "codex",
                    model: stringValue(defaultAgentValue.model) || "default",
                    effort: stringValue(defaultAgentValue.effort) || undefined,
                  }}
                  onSelectTemplateMode={(mode) => {
                    setForceCustom(false);
                    if (mode === "custom") {
                      setForceCustom(true);
                      return;
                    }
                    const next = defaultCronFor(mode, template, taskCron);
                    writeTaskPath(selected, ["cron"], next);
                  }}
                  onCron={(cron) => {
                    writeTaskPath(selected, ["cron"], cron);
                    setForceCustom(cronTemplateOf(cron).kind === "custom");
                  }}
                  onField={(path, value) => writeTaskPath(selected, path, value)}
                  onAgentChange={(change) =>
                    writeAgentSelection("task", selected, change)
                  }
                  onCopy={() => copyTask(selected)}
                  onDelete={() => deleteTask(selected)}
                  onRawField={updateRawField}
                  onCommitRawField={commitRawField}
                  onResetRawField={resetRawField}
                />
              ) : (
                <div className="cron-editor-empty">
                  从左侧选择任务，或新增一个任务。
                </div>
              )}
            </section>
          </div>
          </>
        )}
      </fieldset>
      <footer className="cron-editor-footer">
        <div className="cron-editor-summary">
          <span>
            草稿相对文件：新增 {summary.added} · 修改 {summary.modified} · 删除{" "}
            {summary.removedCount}
          </span>
          <span className="cron-editor-load">
            装载效果：新增 {changes.added} · 更新 {changes.updated} · 删除{" "}
            {changes.removed}
          </span>
          <span
            className={changes.reEnabled ? "cron-editor-reenable" : "cron-muted"}
          >
            {changes.reEnabled
              ? "临时关闭将被重新启用 " + changes.reEnabled + " 项"
              : "无临时关闭任务会被重新启用"}
          </span>
          <span
            className={
              previewValid
                ? "cron-editor-valid"
                : "cron-editor-invalid"
            }
            role="status"
          >
            {previewBusy
              ? "正在校验草稿…"
              : !parsed.ok
                ? "JSON 无效，无法保存"
                : previewValid
                  ? "校验通过（" +
                    (changes.added + changes.updated + changes.removed) +
                    " 项变化）"
                  : "校验未通过" +
                    (currentPreview.errors?.length
                      ? "：" + currentPreview.errors.length + " 个问题"
                      : "")}
          </span>
          {currentPreview.errors?.length ? (
            <details className="cron-editor-errors">
              <summary>查看校验问题</summary>
              <ul>
                {currentPreview.errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {fieldErrors.length > 0 && (
            <span className="cron-editor-invalid" role="alert">
              args / env 存在无效 JSON，保存已禁用
            </span>
          )}
          <span className="cron-muted">
            运行中的任务不会停止；保存只写文件并从下一次计划生效。
          </span>
        </div>
        <div className="cron-editor-actions">
          <button
            disabled={saving}
            onClick={() => {
              if (savingRef.current) return;
              if (dirty) setConfirmCancel(true);
              else onExit();
            }}
          >
            取消编辑
          </button>
          <button
            className="cron-primary"
            disabled={saving || !previewValid || hasPendingRawEdit}
            onClick={() => save()}
          >
            {saving ? "保存中…" : "保存并装载"}
          </button>
        </div>
      </footer>
    </EditorShell>
  );
}

function EditorShell({
  project,
  onClose,
  busy,
  headerExtra,
  children,
}: {
  project: SchedulerProject;
  onClose(): void;
  busy: boolean;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="cron-editor-backdrop">
      <section
        className="cron-editor"
        role="dialog"
        aria-modal="true"
        aria-label={"编辑任务配置 · " + project.name}
        data-project-id={project.id}
        aria-busy={busy}
      >
        <header>
          <div>
            <h2>编辑任务</h2>
            <p>
              {project.name} · <code>.cloudcli/project-schedules.json</code>
            </p>
          </div>
          <div className="cron-actions">
            {headerExtra}
            <button aria-label="退出编辑" disabled={busy} onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>
        {children}
      </section>
    </div>
  );
}

function TaskForm(props: {
  index: number;
  task: ConfigTask;
  tasks: ConfigTask[];
  templateKind: CronTemplate["kind"];
  effectiveZone: string;
  inheritedZone: boolean;
  pluginTimezone: string | null;
  nextRuns: string[];
  previewValid: boolean;
  rawFields: Record<string, RawFieldState>;
  rawKey(index: number, field: "args" | "env"): string;
  /** Host model catalogs and their retry affordance, shared with the defaults form. */
  catalogs: AgentModelCatalogs;
  canRetryCatalogs: boolean;
  onRetryCatalogs(): void;
  /** Resolved project defaults; a task agent inherits from these when a field is empty. */
  fallbackAgent: { provider: string; model: string; effort?: string };
  onSelectTemplateMode(mode: CronTemplate["kind"]): void;
  onCron(cron: string): void;
  onField(path: string[], value: unknown): void;
  onAgentChange(change: AgentSelectionChange): void;
  onCopy(): void;
  onDelete(): void;
  onRawField(field: "args" | "env", value: string): void;
  onCommitRawField(field: "args" | "env"): void;
  onResetRawField(index: number, field: "args" | "env"): void;
}) {
  const {
    task,
    index,
    templateKind,
    effectiveZone,
    inheritedZone,
    pluginTimezone,
    nextRuns,
    previewValid,
    rawFields,
    rawKey,
    catalogs,
    fallbackAgent,
  } = props;
  const type = stringValue(task.type);
  const cron = stringValue(task.cron);
  const template = cronTemplateOf(cron);
  const agent = isRecord(task.agent) ? task.agent : {};
  const argsField = rawFields[rawKey(index, "args")];
  const envField = rawFields[rawKey(index, "env")];
  const argsText = argsField?.text ?? formatJson(task.args ?? []);
  const envText = envField?.text ?? formatJson(task.env ?? {});
  const enabled = booleanValue(task.enabled);
  const allowConcurrent = booleanValue(task.allowConcurrent);
  const taskZone = stringValue(task.timezone);
  const id = configTaskId(task);
  const nextRunLabel = inheritedZone
    ? "时区继承（" +
      (effectiveZone || "未知") +
      "）" +
      (effectiveZone ? "" : "，以下按 UTC 显示")
    : "时区 " + (effectiveZone || "未知");
  return (
    <>
      <div className="cron-editor-form-head">
        <h3>{stringValue(task.name) || id || "未命名任务"}</h3>
        <div className="cron-actions">
          <button onClick={props.onCopy}>
            <Copy size={14} /> 复制
          </button>
          <button className="cron-danger" onClick={props.onDelete}>
            <Trash2 size={14} /> 删除
          </button>
        </div>
      </div>
      <div className="cron-editor-grid">
        <label>
          名称
          <input
            aria-label="任务名称"
            value={stringValue(task.name)}
            placeholder={id || "默认使用任务 ID"}
            onChange={(event) =>
              props.onField(["name"], event.target.value || undefined)
            }
          />
        </label>
        <label>
          任务 ID
          <input
            aria-label="任务 ID"
            value={id}
            spellCheck={false}
            onChange={(event) => props.onField(["id"], event.target.value || undefined)}
          />
          <small>
            允许修改；保存时视为删除旧 ID 并新增新 ID（按 ID 计算装载变更）。复制会自动分配唯一
            ID，最长 128 字符。
          </small>
        </label>
        <label>
          配置中启用
          <select
            aria-label="配置中启用"
            value={enabled === null ? INHERIT : String(enabled)}
            onChange={(event) =>
              props.onField(
                ["enabled"],
                event.target.value === INHERIT
                  ? undefined
                  : event.target.value === "true",
              )
            }
          >
            <option value={INHERIT}>继承（默认启用）</option>
            <option value="true">启用</option>
            <option value="false">禁用</option>
          </select>
          <small>只写配置文件的 enabled，不会调用任务列表的临时调度开关。</small>
        </label>
        <label>
          类型
          <select
            aria-label="任务类型"
            value={type}
            onChange={(event) =>
              props.onField(["type"], event.target.value || undefined)
            }
          >
            <option value="script">script（命令）</option>
            <option value="prompt">prompt（提示词）</option>
          </select>
        </label>
      </div>
      <fieldset className="cron-editor-section">
        <legend>执行计划</legend>
        <div className="cron-editor-grid">
          <label>
            计划模板
            <select
              aria-label="计划模板"
              value={templateKind}
              onChange={(event) =>
                props.onSelectTemplateMode(event.target.value as CronTemplate["kind"])
              }
            >
              {scheduleModes.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cron 表达式
            <input
              aria-label="Cron 表达式"
              value={cron}
              spellCheck={false}
              onChange={(event) => props.onCron(event.target.value)}
            />
            <small>
              {describeCron(cron)} ·{" "}
              {cron.trim() ? cron.trim().split(/\s+/).length + " 段" : "未填写"}
            </small>
          </label>
        </div>
        <TemplateFields
          kind={templateKind}
          template={template}
          cron={cron}
          onChange={props.onCron}
        />
      </fieldset>
      {type === "script" ? (
        <fieldset className="cron-editor-section">
          <legend>脚本命令</legend>
          <label>
            command
            <input
              aria-label="脚本 command"
              value={stringValue(task.command)}
              placeholder="例如 bash（草稿可先留空，保存前需通过校验）"
              onChange={(event) =>
                props.onField(["command"], event.target.value || undefined)
              }
            />
          </label>
          <label>
            args（JSON 字符串数组）
            <textarea
              aria-label="脚本 args JSON"
              className={argsField?.error ? "cron-invalid-input" : ""}
              spellCheck={false}
              rows={4}
              value={argsText}
              onChange={(event) => props.onRawField("args", event.target.value)}
              onBlur={() => props.onCommitRawField("args")}
            />
            {argsField?.error ? (
              <small className="cron-editor-invalid" role="alert">
                {argsField.error}
                <button type="button" onClick={() => props.onResetRawField(index, "args")}>
                  放弃此修改
                </button>
              </small>
            ) : (
              <small>准确保留字符串与多行参数，例如 ["-lc","echo 第一行\n第二行"]。</small>
            )}
          </label>
        </fieldset>
      ) : (
        <fieldset className="cron-editor-section">
          <legend>提示词与模型</legend>
          <div className="cron-editor-grid">
            <AgentModelFields
              scope="task"
              provider={stringValue(agent.provider)}
              model={stringValue(agent.model)}
              effort={stringValue(agent.effort)}
              fallbackProvider={fallbackAgent.provider}
              fallbackModel={fallbackAgent.model}
              fallbackEffort={fallbackAgent.effort}
              catalogs={catalogs}
              canRetry={props.canRetryCatalogs}
              onRetry={props.onRetryCatalogs}
              onChange={props.onAgentChange}
            />
          </div>
          <label>
            prompt
            <textarea
              aria-label="任务 prompt"
              rows={5}
              value={stringValue(task.prompt)}
              placeholder="草稿可先留空，保存前需通过校验"
              onChange={(event) =>
                props.onField(["prompt"], event.target.value || undefined)
              }
            />
          </label>
        </fieldset>
      )}
      <fieldset className="cron-editor-section">
        <legend>运行环境</legend>
        <div className="cron-editor-grid">
          <label>
            任务时区
            <select
              aria-label="任务时区"
              value={taskZone}
              onChange={(event) =>
                props.onField(["timezone"], event.target.value || undefined)
              }
            >
              <option value={INHERIT}>
                继承项目{effectiveZone ? "（" + effectiveZone + "）" : ""}
              </option>
              {taskZone &&
                !COMMON_TIMEZONES.some((zone) => zone.value === taskZone) && (
                  <option value={taskZone}>{taskZone}（当前文件）</option>
                )}
              {COMMON_TIMEZONES.map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label}
                </option>
              ))}
            </select>
            <small>留空继承项目时区；项目再留空则继承插件默认时区。</small>
          </label>
          <label>
            cwd
            <input
              aria-label="任务 cwd"
              value={stringValue(task.cwd)}
              placeholder="留空使用项目根目录"
              onChange={(event) =>
                props.onField(["cwd"], event.target.value || undefined)
              }
            />
          </label>
          <label>
            timeoutSeconds
            <input
              aria-label="任务 timeoutSeconds"
              type="number"
              min="0"
              value={numberInput(task.timeoutSeconds)}
              placeholder="留空继承项目默认配置"
              onChange={(event) => {
                if (!event.target.value) {
                  props.onField(["timeoutSeconds"], undefined);
                  return;
                }
                const value = parseInteger(event.target.value);
                if (value !== null && value >= 0)
                  props.onField(["timeoutSeconds"], value);
              }}
            />
          </label>
          <label>
            allowConcurrent
            <select
              aria-label="任务 allowConcurrent"
              value={
                allowConcurrent === null ? INHERIT : String(allowConcurrent)
              }
              onChange={(event) =>
                props.onField(
                  ["allowConcurrent"],
                  event.target.value === INHERIT
                    ? undefined
                    : event.target.value === "true",
                )
              }
            >
              <option value={INHERIT}>继承项目默认配置</option>
              <option value="true">允许并发</option>
              <option value="false">禁止并发</option>
            </select>
          </label>
        </div>
        <label>
          env（JSON 字符串对象）
          <textarea
            aria-label="任务 env JSON"
            className={envField?.error ? "cron-invalid-input" : ""}
            spellCheck={false}
            rows={4}
            value={envText}
            onChange={(event) => props.onRawField("env", event.target.value)}
            onBlur={() => props.onCommitRawField("env")}
          />
          {envField?.error ? (
            <small className="cron-editor-invalid" role="alert">
              {envField.error}
              <button type="button" onClick={() => props.onResetRawField(index, "env")}>
                放弃此修改
              </button>
            </small>
          ) : (
            <small>支持多行值；留空或 {"{}"} 表示不覆盖任何变量。</small>
          )}
        </label>
      </fieldset>
      <fieldset className="cron-editor-section">
        <legend>未来运行时间（服务端校验结果）</legend>
        <div className="cron-editor-next" role="status">
          {!previewValid ? (
            <span className="cron-muted">草稿通过校验后显示。</span>
          ) : nextRuns.length ? (
            <>
              <span className="cron-muted">{nextRunLabel}</span>
              <ol>
                {nextRuns.slice(0, 5).map((value) => (
                  <li key={value} title={value}>
                    {formatRunTime(value, effectiveZone)}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <span className="cron-muted">没有可用的未来运行时间。</span>
          )}
        </div>
        {pluginTimezone && (
          <small>
            插件默认时区 {pluginTimezone}；任务可继承项目，项目可继承插件值。
          </small>
        )}
      </fieldset>
    </>
  );
}

function TemplateFields({
  kind,
  template,
  cron,
  onChange,
}: {
  kind: CronTemplate["kind"];
  template: CronTemplate;
  cron: string;
  onChange(cron: string): void;
}) {
  const seconds = template.kind === "seconds" ? template.every : 30;
  const minutes = template.kind === "minutes" ? template.every : 5;
  const hour =
    template.kind === "daily" || template.kind === "weekly" ? template.hour : 9;
  const minute =
    template.kind === "daily" || template.kind === "weekly" ? template.minute : 0;
  const days = template.kind === "weekly" ? template.days : [1];
  const emit = (next: CronTemplate) => {
    const result = cronFromTemplate(next);
    if ("error" in result) return;
    onChange(result.cron);
  };
  if (kind === "custom")
    return (
      <small>
        原样保留自定义 Cron，不会按模板自动改写。保存前由服务端校验。
      </small>
    );
  if (kind === "seconds" || kind === "minutes")
    return (
      <div className="cron-editor-grid">
        <label>
          {kind === "seconds" ? "每 N 秒（1-59）" : "每 N 分钟（1-59）"}
          <input
            aria-label={kind === "seconds" ? "秒间隔" : "分钟间隔"}
            type="number"
            min="1"
            max="59"
            value={kind === "seconds" ? seconds : minutes}
            onChange={(event) => {
              const value = parseInteger(event.target.value);
              if (value === null) return;
              emit(
                kind === "seconds"
                  ? { kind, every: value }
                  : { kind, every: value },
              );
            }}
          />
        </label>
      </div>
    );
  return (
    <div className="cron-editor-grid">
      <label>
        时间（HH:mm）
        <input
          aria-label="运行时间"
          type="time"
          value={pad2(hour) + ":" + pad2(minute)}
          onChange={(event) => {
            const [h, m] = event.target.value.split(":").map(Number);
            if (!Number.isInteger(h) || !Number.isInteger(m)) return;
            emit(
              kind === "daily"
                ? { kind, hour: h!, minute: m! }
                : { kind: "weekly", days, hour: h!, minute: m! },
            );
          }}
        />
      </label>
      {kind === "weekly" && (
        <div className="cron-editor-weekdays" role="group" aria-label="星期选择">
          {weekdayLabels.map((label, day) => (
            <label key={day}>
              <input
                type="checkbox"
                checked={days.includes(day)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...days, day].sort((a, b) => a - b)
                    : days.filter((value) => value !== day);
                  if (!next.length) return;
                  emit({ kind: "weekly", days: next, hour, minute });
                }}
              />
              {label}
            </label>
          ))}
        </div>
      )}
      <small>将生成 6 段 Cron（首项为秒）：{cron || "—"}</small>
    </div>
  );
}

function defaultCronFor(
  mode: Exclude<CronTemplate["kind"], "custom">,
  template: CronTemplate,
  cron: string,
): string {
  const generated = cronFromTemplate(
    mode === "seconds"
      ? { kind: "seconds", every: template.kind === "seconds" ? template.every : 30 }
      : mode === "minutes"
        ? { kind: "minutes", every: template.kind === "minutes" ? template.every : 5 }
        : mode === "daily"
          ? {
              kind: "daily",
              hour:
                template.kind === "daily" || template.kind === "weekly"
                  ? template.hour
                  : 9,
              minute:
                template.kind === "daily" || template.kind === "weekly"
                  ? template.minute
                  : 0,
            }
          : {
              kind: "weekly",
              days: template.kind === "weekly" ? template.days : [1],
              hour:
                template.kind === "daily" || template.kind === "weekly"
                  ? template.hour
                  : 9,
              minute:
                template.kind === "daily" || template.kind === "weekly"
                  ? template.minute
                  : 0,
            },
  );
  return "error" in generated ? cron : generated.cron;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2) ?? "null";
  } catch {
    return "null";
  }
}
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
function formatRunTime(value: string, zone: string): string {
  try {
    if (!zone) return new Date(value).toISOString() + " UTC";
    return new Date(value).toLocaleString("zh-CN", {
      hour12: false,
      timeZone: zone,
    });
  } catch {
    return new Date(value).toISOString() + " UTC";
  }
}
function deleteConfigValueInPlace(value: ConfigObject, path: string[]): void {
  if (!path.length) return;
  let current: unknown = value;
  for (const part of path.slice(0, -1)) {
    if (!isRecord(current)) return;
    current = current[part];
  }
  if (isRecord(current)) delete current[path[path.length - 1]!];
}
function setConfigValueInPlace(
  value: ConfigObject,
  path: string[],
  next: unknown,
): void {
  if (!path.length) throw new Error("配置字段路径不能为空");
  let current = value;
  for (const part of path.slice(0, -1)) {
    const child = current[part];
    if (!isRecord(child)) {
      const created: ConfigObject = {};
      current[part] = created;
      current = created;
      continue;
    }
    current = child;
  }
  current[path[path.length - 1]!] = next;
}
/** Empty defaults/alerts objects are omitted so an inherited value stays inherited. */
function pruneEmptyDefaults(value: ConfigObject): void {
  if (isRecord(value.defaults) && !Object.keys(value.defaults).length)
    delete value.defaults;
  if (isRecord(value.alerts) && !Object.keys(value.alerts).length)
    delete value.alerts;
}
function parseArgsText(
  text: string,
): { value?: unknown; error: string | null; empty: boolean } {
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : [];
  } catch (error) {
    return { error: "args 不是有效 JSON：" + messageOf(error), empty: false };
  }
  if (!Array.isArray(value)) return { error: "args 必须是字符串数组", empty: false };
  if (!value.every((item) => typeof item === "string"))
    return { error: "args 的每一项都必须是字符串", empty: false };
  if (value.some((item) => (item as string).includes("\0")))
    return { error: "args 不能包含 NUL 字符", empty: false };
  return { value, error: null, empty: value.length === 0 };
}
function parseEnvText(
  text: string,
): { value?: unknown; error: string | null; empty: boolean } {
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    return { error: "env 不是有效 JSON：" + messageOf(error), empty: false };
  }
  if (!isRecord(value)) return { error: "env 必须是字符串对象", empty: false };
  for (const [name, entry] of Object.entries(value)) {
    const nameError = environmentNameError(name);
    if (nameError) return { error: nameError, empty: false };
    if (typeof entry !== "string")
      return { error: "变量 “" + name + "” 的值必须是字符串", empty: false };
    if (entry.includes("\0"))
      return { error: "变量 “" + name + "” 不能包含 NUL 字符", empty: false };
  }
  return {
    value,
    error: null,
    empty: Object.keys(value).length === 0,
  };
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { ConfigurationEditorProps };
