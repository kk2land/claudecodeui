/**
 * Pure draft helpers for the project configuration editor.
 *
 * The editor keeps the raw JSON text as its single source of truth. Every helper here parses or
 * rewrites that text, so unknown fields, untouched tasks, omitted inheritances, and any value the
 * visual form does not understand survive a save. Nothing in this module touches the file system,
 * the scheduler database, or the network.
 */

/** A JSON object parsed from the project configuration file. */
export type ConfigObject = Record<string, unknown>;
/** One task object exactly as authored in the configuration file. */
export type ConfigTask = Record<string, unknown>;
/** Parsed document plus its task array; task entries share the raw object identities. */
export type ConfigDocument = { value: ConfigObject; tasks: ConfigTask[] };
/** Result of parsing the raw editor text. */
export type ConfigParseResult =
  | { ok: true; document: ConfigDocument }
  | { ok: false; error: string };
/** Result of atomically mutating a draft document; an error leaves the original text untouched. */
export type ConfigTextResult = { text: string } | { error: string };
/** Per-task comparison against the file that was loaded into the editor. */
export type DraftTaskStatus = "new" | "modified" | "unchanged";
/** Draft list statuses plus the baseline tasks that the draft currently omits. */
export type DraftSummary = {
  statuses: DraftTaskStatus[];
  removed: Array<{ task: ConfigTask; index: number }>;
  added: number;
  modified: number;
  removedCount: number;
};
/** Common IANA zones offered by the settings and project defaults editors. */
export const COMMON_TIMEZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Asia/Shanghai", label: "中国 · Asia/Shanghai（UTC+08）" },
  { value: "Asia/Tokyo", label: "日本 · Asia/Tokyo（UTC+09）" },
  { value: "Asia/Hong_Kong", label: "中国香港 · Asia/Hong_Kong" },
  { value: "Asia/Singapore", label: "新加坡 · Asia/Singapore" },
  { value: "Asia/Kolkata", label: "印度 · Asia/Kolkata" },
  { value: "UTC", label: "协调世界时 · UTC" },
  { value: "Europe/London", label: "英国 · Europe/London" },
  { value: "Europe/Berlin", label: "德国 · Europe/Berlin" },
  { value: "America/New_York", label: "美国东部 · America/New_York" },
  { value: "America/Los_Angeles", label: "美国西部 · America/Los_Angeles" },
  { value: "Australia/Sydney", label: "澳大利亚 · Australia/Sydney" },
];

/** True for a non-array, non-null object usable as a raw JSON object. */
export function isConfigObject(value: unknown): value is ConfigObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
/** Parses draft text and requires a top-level object with an array of object tasks. */
export function parseConfigDocument(text: string): ConfigParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: "JSON 语法错误：" + (error instanceof Error ? error.message : String(error)),
    };
  }
  if (!isConfigObject(value)) return { ok: false, error: "配置必须是 JSON 对象" };
  if (!Array.isArray(value.tasks))
    return { ok: false, error: "配置缺少 tasks 数组" };
  if (!value.tasks.every(isConfigObject))
    return { ok: false, error: "tasks 中的每一项都必须是对象" };
  return { ok: true, document: { value, tasks: value.tasks as ConfigTask[] } };
}
/** Serializes a document with stable, review-friendly formatting. */
export function stringifyConfigDocument(value: ConfigObject): string {
  return JSON.stringify(value, null, 2) + "\n";
}
/** Structural clone for JSON values; drafts never share mutable objects with their baseline. */
export function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
/** Order-insensitive comparison for JSON values, ignoring formatting differences. */
export function configEquals(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (isConfigObject(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => JSON.stringify(key) + ":" + stableJson(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "undefined";
}
/** Reads a nested raw value without assuming intermediate objects exist. */
export function getConfigValue(value: ConfigObject, path: string[]): unknown {
  let current: unknown = value;
  for (const part of path) {
    if (!isConfigObject(current)) return undefined;
    current = current[part];
  }
  return current;
}
/** Clones a document and writes (or deletes, for undefined) one nested raw property. */
export function withConfigValue(
  value: ConfigObject,
  path: string[],
  next: unknown,
): ConfigObject {
  const clone = cloneConfig(value);
  writeConfigValue(clone, path, next);
  return clone;
}
/** Deletes one nested raw property so the value falls back to inherited defaults. */
export function deleteConfigValue(value: ConfigObject, path: string[]): ConfigObject {
  return withConfigValue(value, path, undefined);
}
/**
 * Writes one nested property in place. Intermediate objects are created only when absent; an
 * existing non-object intermediate is reported instead of being silently replaced.
 */
export function writeConfigValue(
  value: ConfigObject,
  path: string[],
  next: unknown,
): void {
  if (!path.length) throw new Error("配置字段路径不能为空");
  let current = value;
  for (const part of path.slice(0, -1)) {
    const child = current[part];
    if (child === undefined) {
      const created: ConfigObject = {};
      current[part] = created;
      current = created;
      continue;
    }
    if (!isConfigObject(child))
      throw new Error("配置字段类型冲突：" + path.join("."));
    current = child;
  }
  const last = path[path.length - 1]!;
  if (next === undefined) delete current[last];
  else current[last] = next;
}
/** Parses, clones, mutates, and re-serializes the draft atomically. */
export function updateConfigText(
  text: string,
  mutate: (document: ConfigObject) => void,
): ConfigTextResult {
  const parsed = parseConfigDocument(text);
  if (!parsed.ok) return { error: parsed.error };
  const value = cloneConfig(parsed.document.value);
  try {
    mutate(value);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { text: stringifyConfigDocument(value) };
}
/** The authored task id, or an empty string when the task has none. */
export function configTaskId(task: ConfigTask): string {
  return typeof task.id === "string" ? task.id : "";
}
/** The server rejects task ids outside this shape; the client must never generate one. */
export const MAX_TASK_ID_LENGTH = 128;
/** Produces an id matching the server's accepted charset and guaranteed unique in `existing`. */
export function nextTaskId(existing: Iterable<string>, base: string): string {
  const used = new Set(existing);
  const normalized =
    base
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, MAX_TASK_ID_LENGTH) || "task";
  if (!used.has(normalized)) return normalized;
  // The numeric suffix must fit inside the same 128-character server limit.
  let suffix = 2;
  for (;;) {
    const tail = "-" + suffix;
    const candidate =
      normalized.slice(0, MAX_TASK_ID_LENGTH - tail.length) + tail;
    if (!used.has(candidate)) return candidate;
    suffix++;
  }
}
/** Creates the minimal task object shown for a brand new draft entry. */
export function createTaskDraft(id: string, type: "script" | "prompt" = "prompt"): ConfigTask {
  return {
    id,
    name: type === "script" ? "新脚本任务" : "新提示词任务",
    type,
    cron: "0 0 9 * * *",
    enabled: true,
  };
}
/** Appends a task and returns its new index. */
export function addDraftTask(
  text: string,
  task: ConfigTask,
): { text: string; index: number } | { error: string } {
  const parsed = parseConfigDocument(text);
  if (!parsed.ok) return { error: parsed.error };
  if (
    configTaskId(task) &&
    parsed.document.tasks.some((row) => configTaskId(row) === configTaskId(task))
  )
    return { error: "任务 ID “" + configTaskId(task) + "” 已存在" };
  return {
    text: stringifyConfigDocument({
      ...parsed.document.value,
      tasks: [...parsed.document.tasks, cloneConfig(task)],
    }),
    index: parsed.document.tasks.length,
  };
}
/** Duplicates a task after its source with a fresh unique id. */
export function copyDraftTask(
  text: string,
  index: number,
  reservedIds: string[] = [],
): { text: string; index: number } | { error: string } {
  const parsed = parseConfigDocument(text);
  if (!parsed.ok) return { error: parsed.error };
  const source = parsed.document.tasks[index];
  if (!source) return { error: "要复制的任务不存在" };
  const ids = [
    ...parsed.document.tasks.map(configTaskId),
    ...reservedIds,
  ].filter(Boolean);
  const id = nextTaskId(ids, configTaskId(source) + "-copy");
  const copy = cloneConfig(source);
  copy.id = id;
  copy.name =
    typeof copy.name === "string" && copy.name.trim()
      ? copy.name + "（副本）"
      : id;
  const tasks = [...parsed.document.tasks];
  tasks.splice(index + 1, 0, copy);
  return {
    text: stringifyConfigDocument({ ...parsed.document.value, tasks }),
    index: index + 1,
  };
}
/** Removes one task from the draft. */
export function removeDraftTask(text: string, index: number): ConfigTextResult {
  return updateConfigText(text, (value) => {
    const tasks = value.tasks as ConfigTask[];
    if (!tasks[index]) throw new Error("要删除的任务不存在");
    tasks.splice(index, 1);
  });
}
/** Restores an omitted baseline task, refusing to duplicate an id already in the draft. */
export function restoreDraftTask(
  text: string,
  task: ConfigTask,
  index?: number,
): { text: string; index: number } | { error: string } {
  const parsed = parseConfigDocument(text);
  if (!parsed.ok) return { error: parsed.error };
  const id = configTaskId(task);
  if (id && parsed.document.tasks.some((row) => configTaskId(row) === id))
    return { error: "任务 ID “" + id + "” 已存在，无法撤销删除" };
  const tasks = [...parsed.document.tasks];
  const at = Math.max(0, Math.min(index ?? tasks.length, tasks.length));
  tasks.splice(at, 0, cloneConfig(task));
  return {
    text: stringifyConfigDocument({ ...parsed.document.value, tasks }),
    index: at,
  };
}
/** Compares the draft against the loaded file for list badges and footer counts. */
export function summarizeDraft(
  baseline: ConfigTask[],
  draft: ConfigTask[],
): DraftSummary {
  const baselineById = new Map<string, { task: ConfigTask; index: number }>();
  baseline.forEach((task, index) => {
    const id = configTaskId(task);
    if (id && !baselineById.has(id)) baselineById.set(id, { task, index });
  });
  const seen = new Set<string>();
  const statuses = draft.map<DraftTaskStatus>((task) => {
    const id = configTaskId(task);
    const base = id ? baselineById.get(id) : undefined;
    if (!base || seen.has(id)) return "new";
    seen.add(id);
    return configEquals(base.task, task) ? "unchanged" : "modified";
  });
  const draftIds = new Set(draft.map(configTaskId).filter(Boolean));
  const removed = baseline
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => {
      const id = configTaskId(task);
      return !id || !draftIds.has(id);
    });
  return {
    statuses,
    removed,
    added: statuses.filter((status) => status === "new").length,
    modified: statuses.filter((status) => status === "modified").length,
    removedCount: removed.length,
  };
}

/** Visual schedule presets offered for a task. */
export type CronTemplate =
  | { kind: "custom"; cron: string }
  | { kind: "seconds"; every: number }
  | { kind: "minutes"; every: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; days: number[]; hour: number; minute: number };

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;
function integerIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max
    ? number
    : null;
}
function parseDays(value: string): number[] | null {
  const days: number[] = [];
  for (const part of value.split(",")) {
    const day = integerIn(part, 0, 7);
    if (day === null) return null;
    const normalized = day === 7 ? 0 : day;
    if (!days.includes(normalized)) days.push(normalized);
  }
  return days.length ? days.sort((a, b) => a - b) : null;
}
/**
 * Recognizes only schedules this editor generated. Any other cron keeps its exact text in a
 * custom preset; opening the editor or changing an unrelated field never rewrites it.
 */
export function cronTemplateOf(cron: string): CronTemplate {
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 6) {
    const [second, minute, hour, day, month, weekday] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const everySecond = /^\*\/(\d+)$/.exec(second);
    if (
      minute === "*" &&
      hour === "*" &&
      day === "*" &&
      month === "*" &&
      weekday === "*"
    ) {
      // "* * * * * *" is the canonical "every second" form produced for every: 1.
      if (second === "*") return { kind: "seconds", every: 1 };
      if (everySecond) {
        const every = integerIn(everySecond[1]!, 1, 59);
        if (every !== null) return { kind: "seconds", every };
      }
      // "0 * * * * *" is the canonical "every minute" form produced for every: 1.
      if (second === "0") return { kind: "minutes", every: 1 };
    }
    const everyMinute = /^\*\/(\d+)$/.exec(minute);
    if (
      second === "0" &&
      everyMinute &&
      hour === "*" &&
      day === "*" &&
      month === "*" &&
      weekday === "*"
    ) {
      const every = integerIn(everyMinute[1]!, 1, 59);
      if (every !== null) return { kind: "minutes", every };
    }
    if (
      second === "0" &&
      day === "*" &&
      month === "*" &&
      /^\d+$/.test(minute) &&
      /^\d+$/.test(hour)
    ) {
      const h = integerIn(hour, 0, 23);
      const m = integerIn(minute, 0, 59);
      if (h !== null && m !== null) {
        if (weekday === "*") return { kind: "daily", hour: h, minute: m };
        const days = parseDays(weekday);
        if (days) return { kind: "weekly", days, hour: h, minute: m };
      }
    }
  } else if (parts.length === 5) {
    const [minute, hour, day, month, weekday] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (
      minute === "*" &&
      hour === "*" &&
      day === "*" &&
      month === "*" &&
      weekday === "*"
    )
      return { kind: "minutes", every: 1 };
    const everyMinute = /^\*\/(\d+)$/.exec(minute);
    if (
      everyMinute &&
      hour === "*" &&
      day === "*" &&
      month === "*" &&
      weekday === "*"
    ) {
      const every = integerIn(everyMinute[1]!, 1, 59);
      if (every !== null) return { kind: "minutes", every };
    }
    if (
      day === "*" &&
      month === "*" &&
      /^\d+$/.test(minute) &&
      /^\d+$/.test(hour)
    ) {
      const h = integerIn(hour, 0, 23);
      const m = integerIn(minute, 0, 59);
      if (h !== null && m !== null) {
        if (weekday === "*") return { kind: "daily", hour: h, minute: m };
        const days = parseDays(weekday);
        if (days) return { kind: "weekly", days, hour: h, minute: m };
      }
    }
  }
  return { kind: "custom", cron };
}
function pad(value: number): string {
  return String(value).padStart(2, "0");
}
/** Builds a five/six-field cron expression, validating every preset value. */
export function cronFromTemplate(
  template: CronTemplate,
): { cron: string } | { error: string } {
  switch (template.kind) {
    case "seconds":
      if (!Number.isInteger(template.every) || template.every < 1 || template.every > 59)
        return { error: "秒间隔必须是 1 到 59 的整数" };
      return { cron: template.every === 1 ? "* * * * * *" : "*/" + template.every + " * * * * *" };
    case "minutes":
      if (!Number.isInteger(template.every) || template.every < 1 || template.every > 59)
        return { error: "分钟间隔必须是 1 到 59 的整数" };
      return { cron: template.every === 1 ? "0 * * * * *" : "0 */" + template.every + " * * * *" };
    case "daily":
      if (
        !Number.isInteger(template.hour) ||
        template.hour < 0 ||
        template.hour > 23 ||
        !Number.isInteger(template.minute) ||
        template.minute < 0 ||
        template.minute > 59
      )
        return { error: "时间必须是 00:00 到 23:59" };
      return { cron: "0 " + template.minute + " " + template.hour + " * * *" };
    case "weekly": {
      const days = [...new Set(template.days)].sort((a, b) => a - b);
      if (
        !days.length ||
        days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
      )
        return { error: "请至少选择一个星期" };
      if (
        !Number.isInteger(template.hour) ||
        template.hour < 0 ||
        template.hour > 23 ||
        !Number.isInteger(template.minute) ||
        template.minute < 0 ||
        template.minute > 59
      )
        return { error: "时间必须是 00:00 到 23:59" };
      return {
        cron:
          "0 " + template.minute + " " + template.hour + " * * " + days.join(","),
      };
    }
    case "custom": {
      const segments = template.cron.trim().split(/\s+/).filter(Boolean);
      if (!template.cron.trim()) return { error: "请填写 Cron 表达式" };
      if (segments.length !== 5 && segments.length !== 6)
        return { error: "Cron 必须是 5 段或 6 段（6 段首项为秒）" };
      return { cron: template.cron };
    }
  }
}
/** Human-readable schedule explanation for presets and unrecognized custom cron. */
export function describeCron(cron: string): string {
  const template = cronTemplateOf(cron);
  switch (template.kind) {
    case "seconds":
      return "每 " + template.every + " 秒";
    case "minutes":
      return "每 " + template.every + " 分钟";
    case "daily":
      return "每天 " + pad(template.hour) + ":" + pad(template.minute);
    case "weekly":
      return (
        "每周" +
        template.days.map((day) => WEEKDAYS[day] ?? String(day)).join("、") +
        " " +
        pad(template.hour) +
        ":" +
        pad(template.minute)
      );
    case "custom": {
      const segments = template.cron.trim() ? template.cron.trim().split(/\s+/).length : 0;
      return segments === 5 || segments === 6
        ? "自定义 Cron（" + segments + " 段）"
        : "自定义 Cron（格式待校验）";
    }
  }
}
