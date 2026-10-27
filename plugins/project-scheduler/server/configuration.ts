import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import { environmentNameError } from "../shared/contracts.js";
import type {
  SchedulerAgent,
  SchedulerSettings,
  SchedulerTask,
} from "../shared/contracts.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " 必须是对象");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new Error(label + " 必须是非空且无 NUL 的字符串");
  return value;
}
function integer(
  value: unknown,
  label: string,
  fallback: number,
  min = 0,
  max = 2147483,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error(label + " 超出有效整数范围");
  return Number(value);
}
function boolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(label + " 必须是布尔值");
  return value;
}
/**
 * Used by task parsing and plugin settings so both execution entrypoints share one policy:
 * an object (never an array) of strings keyed by shell-safe, non-reserved names without NUL.
 * Error messages name only the offending key, never its value, because values may carry
 * credentials.
 */
function environment(value: unknown, label: string): Record<string, string> {
  const result: [string, string][] = [];
  for (const [name, entry] of Object.entries(object(value, label))) {
    if (
      environmentNameError(name) ||
      typeof entry !== "string" ||
      entry.includes("\0")
    )
      throw new Error(label + " 无效：" + name);
    result.push([name, entry]);
  }
  return Object.fromEntries(result);
}
function timezone(value: unknown, fallback: string): string {
  const result = text(value, "timezone", fallback);
  new Intl.DateTimeFormat("en", { timeZone: result });
  return result;
}
/**
 * Resolves one agent entry against defaults. A model is inherited only while the provider stays
 * the same; effort additionally requires the same effective model, so switching provider or model
 * never drags the previous selection's effort along. An explicit `"default"` effort is meaningful:
 * it cancels inherited effort and is not forwarded to the CLI.
 */
function agent(value: unknown, fallback?: SchedulerAgent): SchedulerAgent {
  if (value === undefined)
    return fallback ?? { provider: "codex", model: "default" };
  const input = object(value, "agent");
  const provider = input.provider ?? fallback?.provider ?? "codex";
  if (provider !== "codex" && provider !== "dsh")
    throw new Error("agent.provider 仅支持 codex、dsh");
  const inheritedModel =
    fallback && fallback.provider === provider ? fallback.model : undefined;
  const model = text(input.model, "agent.model", inheritedModel ?? "default");
  if (provider === "dsh" && (model.startsWith("/") || model.endsWith("/")))
    throw new Error("DSH 模型路由的 provider、model 不能为空");
  const effort = optionalEffort(input.effort, "agent.effort");
  const inheritedEffort =
    input.effort === undefined &&
    fallback?.effort !== undefined &&
    fallback.provider === provider &&
    fallback.model === model
      ? fallback.effort
      : undefined;
  const resolved = effort ?? inheritedEffort;
  if (
    provider === "dsh" &&
    resolved !== undefined &&
    resolved !== "default" &&
    model === "default"
  )
    throw new Error("DSH 非默认 effort 需要显式 agent.model（provider/model）");
  return {
    provider,
    model,
    ...(resolved === undefined ? {} : { effort: resolved }),
  };
}
/** Accepts only non-empty, NUL-free effort identifiers; an explicit "default" disables effort. */
function optionalEffort(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new Error(label + " 必须是非空且无 NUL 的字符串");
  return value;
}

/** Used by import and tests to validate an entire project before any storage or timer changes. */
export function parseTasks(
  value: unknown,
  projectRoot: string,
  settings: SchedulerSettings,
): SchedulerTask[] {
  const config = object(value, "配置");
  if (config.version !== 1) throw new Error("version 必须为 1");
  if (!Array.isArray(config.tasks) || config.tasks.length > 500)
    throw new Error("tasks 必须是数组，且最多 500 项");
  const defaults =
    config.defaults === undefined ? {} : object(config.defaults, "defaults");
  const zone = timezone(config.timezone, settings.timezone);
  const defaultAgent = agent(defaults.agent);
  const defaultTimeout = integer(
    defaults.timeoutSeconds,
    "defaults.timeoutSeconds",
    settings.timeoutSeconds,
  );
  const defaultConcurrency = boolean(
    defaults.allowConcurrent,
    "defaults.allowConcurrent",
    false,
  );
  const alerts =
    config.alerts === undefined ? {} : object(config.alerts, "alerts");
  if (
    alerts.telegram !== undefined &&
    alerts.telegram !== false &&
    alerts.telegram !== "default"
  )
    throw new Error("alerts.telegram 仅支持 default 或 false");
  const ids = new Set<string>();
  return config.tasks.map((raw, index) => {
    const row = object(raw, "tasks[" + index + "]");
    const id = text(row.id, "task.id");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || ids.has(id))
      throw new Error("任务 ID 无效或重复：" + id);
    ids.add(id);
    if (row.type !== "script" && row.type !== "prompt")
      throw new Error(id + ": type 必须是 script 或 prompt");
    const cron = text(row.cron, id + ".cron");
    if (![5, 6].includes(cron.trim().split(/\s+/).length))
      throw new Error(id + ": cron 必须是五或六段");
    const taskTimezone = timezone(row.timezone, zone);
    const schedule = new Cron(cron, { timezone: taskTimezone, paused: true });
    schedule.stop();
    const cwd = path.resolve(projectRoot, text(row.cwd, id + ".cwd", "."));
    const realRoot = fs.realpathSync(projectRoot);
    const realCwd = fs.realpathSync(cwd);
    if (realCwd !== realRoot && !realCwd.startsWith(realRoot + path.sep))
      throw new Error(id + ": cwd 必须在项目内");
    if (!fs.statSync(realCwd).isDirectory())
      throw new Error(id + ": cwd 必须是目录");
    const env = row.env === undefined ? {} : environment(row.env, id + ": env");
    const args = row.args === undefined ? [] : row.args;
    if (
      !Array.isArray(args) ||
      !args.every((arg) => typeof arg === "string" && !arg.includes("\0"))
    )
      throw new Error(id + ": args 必须是字符串数组");
    const result: SchedulerTask = {
      id,
      name: text(row.name, id + ".name", id),
      type: row.type,
      enabled: boolean(row.enabled, id + ".enabled", true),
      cron,
      timezone: taskTimezone,
      allowConcurrent: boolean(
        row.allowConcurrent,
        id + ".allowConcurrent",
        defaultConcurrency,
      ),
      timeoutSeconds: integer(
        row.timeoutSeconds,
        id + ".timeoutSeconds",
        defaultTimeout,
      ),
      cwd: realCwd,
      env,
      agent: agent(row.agent, defaultAgent),
      args,
      notify: alerts.telegram !== false,
    };
    if (row.type === "script")
      result.command = text(row.command, id + ".command");
    else result.prompt = text(row.prompt, id + ".prompt");
    return result;
  });
}

/** Used by storage initialization to supply defaults, including an empty execution environment. */
export function defaultSettings(): SchedulerSettings {
  return {
    retentionDays: 30,
    timeoutSeconds: 3600,
    maxConcurrentRuns: 4,
    timezone: "Asia/Shanghai",
    env: {},
    telegram: { enabled: false, botToken: "", chatId: "", proxy: "" },
  };
}

/**
 * Used by the settings API; empty token input preserves the stored credential and an omitted
 * env keeps the stored map, while an explicit empty object clears it.
 */
export function updateSettings(
  value: unknown,
  previous: SchedulerSettings,
): SchedulerSettings {
  const input = object(value, "设置");
  const tg =
    input.telegram === undefined ? {} : object(input.telegram, "telegram");
  const result: SchedulerSettings = {
    retentionDays: integer(
      input.retentionDays,
      "retentionDays",
      previous.retentionDays,
      0,
      36500,
    ),
    timeoutSeconds: integer(
      input.timeoutSeconds,
      "timeoutSeconds",
      previous.timeoutSeconds,
    ),
    maxConcurrentRuns: integer(
      input.maxConcurrentRuns,
      "maxConcurrentRuns",
      previous.maxConcurrentRuns,
      1,
      100,
    ),
    timezone: timezone(input.timezone, previous.timezone),
    env:
      input.env === undefined ? { ...previous.env } : environment(input.env, "env"),
    telegram: {
      enabled: boolean(
        tg.enabled,
        "telegram.enabled",
        previous.telegram.enabled,
      ),
      botToken:
        typeof tg.botToken === "string" && tg.botToken.trim()
          ? tg.botToken.trim()
          : previous.telegram.botToken,
      chatId:
        tg.chatId === undefined
          ? previous.telegram.chatId
          : String(tg.chatId).trim(),
      proxy:
        tg.proxy === undefined
          ? previous.telegram.proxy
          : String(tg.proxy).trim(),
    },
  };
  if (
    result.telegram.botToken &&
    !/^\d+:[A-Za-z0-9_-]+$/.test(result.telegram.botToken)
  )
    throw new Error("Telegram bot token 格式无效");
  if (result.telegram.proxy) {
    const url = new URL(result.telegram.proxy);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("告警代理仅支持 HTTP/HTTPS");
  }
  if (
    result.telegram.enabled &&
    (!result.telegram.botToken || !result.telegram.chatId)
  )
    throw new Error("启用 Telegram 需配置 bot token 和 chat ID");
  return result;
}
