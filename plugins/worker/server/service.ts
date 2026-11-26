import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WorkerStore } from "./store.js";
import { WorkspaceManager } from "./worktree.js";
import {
  codexBaseline,
  codexEnvironment,
  findCodexSessionFile,
  nativeHome,
  newProgress,
  parseCodex,
  parseAgy,
  parseDsh,
  parsePi,
  prepareLaunch,
  resolveExecutable,
  trackProgress,
  zeroCodexCounters,
  PI_THINKING_LEVELS,
} from "./native.js";
import type { ProgressTracker } from "./native.js";
import {
  ACP_SETUP_TIMEOUT_MS,
  AcpConfigError,
  AcpConnection,
  AcpProtocolError,
  AcpRpcError,
  AcpTransportError,
  LazyAcpProcess,
} from "./acp.js";
import type { AcpEvent, AcpSessionHandle } from "./acp.js";
import { appendLog, readEventLines, readLogPage } from "./logs.js";
import { parseHistoricalPiAcp } from "./pi-history.js";
import { readAgyCatalog } from "./agy-catalog.js";
import {
  AGY_QUOTA_REACHED,
  parseAgyAcpRun,
  planAgyAcpConfig,
  AgyAcpSelectionError,
} from "./agy-acp.js";
import { readPiCatalog } from "./pi-catalog.js";
import { sweepNativeSessions } from "./native-retention.js";
import {
  INITIAL_CONFIG_IDS,
  LEGACY_WORKER_TYPES,
  SUPPORTED_WORKER_TYPES,
  configById,
  extractCodexLaunch,
  acpIdleTimeoutSecondsFromEnvironment,
  projectSettings,
  validAcpIdleTimeoutSeconds,
  validateConfigEffort,
} from "./settings.js";
import type { WorkerHistoryCursor } from "./store.js";
import type {
  AcpSessionEvidence,
  AgyModelCatalog,
  LegacyWorkerType,
  RunEvidence,
  WorkerCancelInput,
  WorkerCleanupInput,
  WorkerCodexConfig,
  WorkerConfig,
  WorkerDefaults,
  WorkerLegacySettingsInput,
  WorkerSettingsRecord,
  WorkerSettingsUpdate,
  WorkerLogQuery,
  WorkerMcpSettings,
  WorkerNotification,
  WorkerNotificationDelivery,
  WorkerActivitySnapshot,
  WorkerHistoryNotification,
  WorkerHistoryPage,
  WorkerHistoryQuery,
  WorkerOverviewSnapshot,
  PiModelCatalog,
  SupportedWorkerType,
  WorkerOwner,
  WorkerPlan,
  WorkerRecord,
  WorkerRecoverInput,
  WorkerResumeInput,
  WorkerRun,
  WorkerRunInput,
  WorkerRunQuery,
  WorkerSettings,
  WorkerSettingsInput,
  WorkerStartInput,
  WorkerStateQuery,
  WorkerStateSnapshot,
  WorkerStatus,
  WorkerType,
} from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";
import { WORKER_TASK_ROLES } from "../shared/task-roles.js";
import type { WorkerTaskRole } from "../shared/task-roles.js";

const STATUSES: WorkerStatus[] = [
  "queued",
  "starting",
  "running",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
];
const OCCUPYING: WorkerStatus[] = ["starting", "running", "stopping", "unknown"];
const ACTIVE_REFERENCES: WorkerStatus[] = ["queued", ...OCCUPYING];

/**
 * Short built-in guidance prepended to a new role worker's prompt. Each entry states the role's
 * responsibility and the evidence it must report; the parent session already owns planning and
 * design, so the guidance never restates a task plan. A start without a role and every resume
 * keep the caller's prompt exactly as supplied.
 */
const TASK_ROLE_PROMPTS: Record<WorkerTaskRole, string> = {
  development:
    "角色：开发。职责：实现改动并自测。证据：改动文件、关键行、测试命令和结果。",
  testing:
    "角色：测试。职责：编写并运行验证。覆盖验收条件。证据：测试命令、结果和覆盖项。",
  ui_design:
    "角色：UI 设计。职责：完成界面布局、视觉样式和交互设计。证据：改动文件、界面位置和验证方式。",
  plan_research:
    "角色：方案调研。职责：调研现状和可选方案。比较取舍。证据：事实来源、选项对比和建议。",
  plan_review:
    "角色：方案审核。职责：只读审核主代理已有的整体方案。证据：问题位置、原因和可执行建议。",
  code_review:
    "角色：代码审核。职责：审查已完成代码和测试。先报高风险问题。证据：文件和行号、风险及依据。",
};

/** Shared closing line for every role prompt so acceptance evidence stays uniform. */
const TASK_ROLE_REPORT =
  "回报首句给结论或需主代理决定的具体问题。随后只给最少可核验证据。";

/** Tool activity must survive the progress-save throttle so reminders see the active tool. */
const TOOL_PROGRESS_PHASES = new Set([
  "tool_execution_start",
  "tool_execution_end",
  "tool_call",
  "tool_call_update",
  "tool_result",
  "item.started",
  "item.completed",
  "step_update",
]);

const TERMINAL: WorkerStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];
const MAX_WAIT_MS = 25_000;

type RegisteredOwner = { owner: WorkerOwner; token: string };
/** One guarded shared ACP process generation, identified without any host/database schema. */
type AcpGeneration = {
  id: string;
  directory: string;
};

type NativeSelection = {
  model: string | null;
  provider: string | null;
  effort: string | null;
};

type RunHandle = {
  runId: string;
  workerId: string;
  ownerId: string;
  requestStop: (reason?: "cancelled" | "timeout") => void;
  ended: Promise<void>;
  resolveEnded: () => void;
  finalized: boolean;
  holdNotification: boolean;
  stopRequested: boolean;
  progress: ProgressTracker;
  expectedSessionId: string | null;
  expectedAction: "new" | "resume" | null;
  lastProgressSave: number;
  stopTimer?: NodeJS.Timeout;
};

export type WorkerServiceOptions = {
  dataDirectory: string;
  environment?: NodeJS.ProcessEnv;
  /** Tests may inject fixture executables in place of PATH lookup. */
  executablePaths?: Partial<Record<WorkerType | "agy-acp", string>>;
  /** Tests inject a source guardian invocation; production uses compiled guardian.mjs. */
  guardianCommand?: string[];
  now?: () => number;
  /** Test/diagnostic hook mirroring IPC events; never exposes tokens. */
  onEvent?: (event: unknown) => void;
};

/** Typed execution service shared by MCP, protected UI REST, and host IPC. */
export class WorkerService {
  readonly store: WorkerStore;
  readonly workspace: WorkspaceManager;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly owners = new Map<string, RegisteredOwner>();
  private readonly tokens = new Map<string, string>();
  private readonly handles = new Map<string, RunHandle>();
  private readonly prompts = new Map<string, string>();
  private readonly pendingAdmissions = new Set<string>();
  private agyAcpProcess: LazyAcpProcess | null = null;
  private readonly acpGenerations = new WeakMap<AcpConnection, AcpGeneration>();
  private agyAcpBlocked: AcpTransportError | null = null;
  /**
   * Effective idle window for the AGY ACP process. A saved settings value wins;
   * absent it, this starts at the environment/default fallback and is never persisted implicitly.
   */
  private acpIdleTimeoutSeconds: number;
  private readonly reminderTimer: NodeJS.Timeout;
  private readonly retentionTimer: NodeJS.Timeout;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private nativeRetentionTimer: NodeJS.Timeout | null = null;
  private nativeRetentionSweep: Promise<void> | null = null;
  private dispatching = false;
  private closing = false;
  private recovering = false;
  private storeClosed = false;

  constructor(private readonly options: WorkerServiceOptions) {
    this.environment = options.environment ?? process.env;
    this.acpIdleTimeoutSeconds = acpIdleTimeoutSecondsFromEnvironment(
      this.environment,
    );
    this.store = new WorkerStore(options.dataDirectory, {
      acpIdleTimeoutSeconds: this.acpIdleTimeoutSeconds,
    });
    // Complete the schema-2 migration before workers read settings; a saved UI value wins over
    // the environment fallback from this point on.
    this.acpIdleTimeoutSeconds =
      this.store.settings().acpIdleTimeoutSeconds;
    this.workspace = new WorkspaceManager(options.dataDirectory);
    this.now = options.now ?? Date.now;
    // Pi and AGY each own one lazy ACP process; this constructor never spawns either.
    this.reminderTimer = setInterval(() => this.checkReminders(), 1000);
    this.reminderTimer.unref?.();
    this.retentionTimer = setInterval(() => this.pruneHistory(), 60_000);
    this.retentionTimer.unref?.();
    this.scheduleAgyWake();
  }

  //------------------ OWNERS AND SETTINGS ----------------

  registerOwner(owner: WorkerOwner, token: string): WorkerOwner {
    if (!owner || typeof owner !== "object")
      throw new WorkerFailure("INVALID_OWNER", "owner 必须为对象");
    for (const key of [
      "id",
      "parentSessionId",
      "projectId",
      "projectPath",
      "appServerInstanceId",
    ] as const) {
      if (typeof owner[key] !== "string" || !owner[key].trim())
        throw new WorkerFailure("INVALID_OWNER", "owner." + key + " 不能为空");
    }
    if (typeof token !== "string" || !token.trim())
      throw new WorkerFailure("INVALID_TOKEN", "owner token 不能为空");
    if (owner.userId !== null && !["string", "number"].includes(typeof owner.userId))
      throw new WorkerFailure("INVALID_OWNER", "owner.userId 必须是字符串、数字或 null");
    if (this.tokens.has(token) && this.tokens.get(token) !== owner.id)
      throw new WorkerFailure("TOKEN_CONFLICT", "owner token 已被占用");
    // Copy only contract fields so a stray token in the owner object is never persisted.
    const stored: WorkerOwner = {
      id: owner.id,
      parentSessionId: owner.parentSessionId,
      projectId: owner.projectId,
      projectPath: owner.projectPath,
      userId: owner.userId,
      appServerInstanceId: owner.appServerInstanceId,
      paused: Boolean(owner.paused),
      pausedReason: owner.pausedReason ?? undefined,
    };
    const previous = this.owners.get(stored.id);
    if (previous) this.tokens.delete(previous.token);
    this.owners.set(stored.id, { owner: stored, token });
    this.tokens.set(token, stored.id);
    this.store.saveOwner(stored);
    if (stored.paused) this.holdPendingNotifications(stored.id);
    return stored;
  }

  ownerForToken(token: string | undefined): WorkerOwner | null {
    if (!token) return null;
    const id = this.tokens.get(token);
    return id ? this.owners.get(id)?.owner ?? null : null;
  }

  owner(ownerId: string): WorkerOwner | null {
    return this.owners.get(ownerId)?.owner ?? null;
  }

  settings(): WorkerSettings {
    return this.store.settings();
  }

  /** Reads the Pi agent home's configured models without starting the native CLI. */
  async piCatalog(): Promise<PiModelCatalog> {
    const environment = this.guardianEnvironment(this.environment);
    const { home } = nativeHome("pi", this.options.dataDirectory, environment);
    return readPiCatalog(home);
  }

  /**
   * Reads the local Antigravity CLI's model directory. `agy models` is network-backed, so the
   * settings page only calls this route when an agy config exists; the executable is resolved
   * exactly like a Worker run's and inherits the same stripped environment.
   */
  async agyCatalog(): Promise<AgyModelCatalog> {
    const environment = this.guardianEnvironment(this.environment);
    return readAgyCatalog(this.executable("agy", environment), environment);
  }

  updateSettings(input: WorkerSettingsInput): WorkerSettings {
    if (!input || typeof input !== "object")
      throw new WorkerFailure("INVALID_SETTINGS", "设置请求体无效");
    if (
      input.acpIdleTimeoutSeconds !== undefined &&
      !validAcpIdleTimeoutSeconds(input.acpIdleTimeoutSeconds)
    )
      throw new WorkerFailure(
        "INVALID_SETTINGS",
        "acpIdleTimeoutSeconds 必须是 1 到 2147483 之间的整数秒",
      );
    const canonical =
      "configs" in input || "defaultConfigId" in input;
    return canonical
      ? this.updateCanonicalSettings(input as WorkerSettingsUpdate)
      : this.updateLegacySettings(input as WorkerLegacySettingsInput);
  }

  /** Replaces the full canonical config list atomically; legacy maps are never persisted. */
  private updateCanonicalSettings(input: WorkerSettingsUpdate): WorkerSettings {
    if (!Array.isArray(input.configs) || !input.configs.length)
      throw new WorkerFailure("INVALID_SETTINGS", "configs 必须是非空数组");
    if (
      input.retentionDays !== undefined &&
      (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < 1)
    )
      throw new WorkerFailure("INVALID_SETTINGS", "retentionDays 必须是正整数");
    const current = this.store.settingsRecord();
    const previousById = new Map(
      current.configs.map((config) => [config.id, config]),
    );
    const configs = input.configs.map((value) =>
      this.normalizeConfig(value, previousById),
    );
    const seen = new Set<string>();
    for (const config of configs) {
      if (seen.has(config.id))
        throw new WorkerFailure("INVALID_SETTINGS", "configs 的 id 不能重复");
      seen.add(config.id);
    }
    const defaultConfigId = clean(input.defaultConfigId);
    const defaultConfig = configs.find((config) => config.id === defaultConfigId);
    if (!defaultConfigId || !defaultConfig)
      throw new WorkerFailure("INVALID_SETTINGS", "defaultConfigId 必须引用已存在的配置");
    if (!defaultConfig.enabled)
      throw new WorkerFailure("INVALID_SETTINGS", "defaultConfigId 必须指向已启用的配置");
    if (!configs.some((config) => config.enabled))
      throw new WorkerFailure("INVALID_SETTINGS", "至少需要一个已启用的配置");
    this.assertConfigReferences(current.configs, configs);
    const record: WorkerSettingsRecord = {
      schemaVersion: 2,
      configs,
      defaultConfigId,
      retentionDays: input.retentionDays ?? current.retentionDays,
      softReminderSeconds: current.softReminderSeconds,
      softReminderSteps: current.softReminderSteps,
      acpIdleTimeoutSeconds:
        input.acpIdleTimeoutSeconds ?? current.acpIdleTimeoutSeconds,
    };
    this.store.saveSettings(record);
    if (input.acpIdleTimeoutSeconds !== undefined)
      this.applyAcpIdleTimeoutSeconds(input.acpIdleTimeoutSeconds);
    this.pruneHistory();
    void this.dispatch();
    return projectSettings(record, this.acpIdleTimeoutSeconds);
  }

  /**
   * Maps the legacy full-map update onto the fixed initial config ids. Renamed initial configs
   * keep their id and stay editable; a missing initial config rejects the update instead of
   * silently creating a replacement.
   */
  private updateLegacySettings(input: WorkerLegacySettingsInput): WorkerSettings {
    const pi = input.concurrency?.pi;
    const codexConcurrency = input.concurrency?.codex;
    if (!Number.isSafeInteger(pi) || (pi as number) < 1)
      throw new WorkerFailure(
        "INVALID_SETTINGS",
        "concurrency.pi 必须是正整数",
      );
    if (
      codexConcurrency !== undefined &&
      (!Number.isSafeInteger(codexConcurrency) || codexConcurrency < 1)
    )
      throw new WorkerFailure(
        "INVALID_SETTINGS",
        "concurrency.codex 必须是正整数",
      );
    if (
      input.defaultWorkerType !== undefined &&
      !LEGACY_WORKER_TYPES.includes(input.defaultWorkerType)
    )
      throw new WorkerFailure(
        "INVALID_SETTINGS",
        "defaultWorkerType 必须是 pi 或 codex",
      );
    if (
      input.retentionDays !== undefined &&
      (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < 1)
    )
      throw new WorkerFailure("INVALID_SETTINGS", "retentionDays 必须是正整数");
    if (input.enabled !== undefined) {
      const value = input.enabled;
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new WorkerFailure("INVALID_SETTINGS", "enabled 必须包含 pi、codex 的布尔值");
      if (LEGACY_WORKER_TYPES.some((type) => typeof value[type] !== "boolean"))
        throw new WorkerFailure("INVALID_SETTINGS", "enabled 必须包含 pi、codex 的布尔值");
    }
    if (input.roles !== undefined) {
      const value = input.roles;
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new WorkerFailure("INVALID_SETTINGS", "roles 必须包含 pi、codex 的 role 数组");
      for (const type of LEGACY_WORKER_TYPES) {
        const entries = value[type];
        if (
          !Array.isArray(entries) ||
          entries.some(
            (role) =>
              typeof role !== "string" ||
              !WORKER_TASK_ROLES.some((item) => item.value === role),
          )
        )
          throw new WorkerFailure("INVALID_SETTINGS", "roles 必须包含 pi、codex 的 role 数组");
      }
    }
    const current = this.store.settingsRecord();
    const configs = current.configs.map((config): WorkerConfig => {
      const copy: WorkerConfig = {
        id: config.id,
        name: config.name,
        type: config.type,
        enabled: config.enabled,
        roles: [...config.roles],
        concurrency: config.concurrency,
        hardTimeoutSeconds: config.hardTimeoutSeconds,
        model: config.model,
        effort: config.effort,
      };
      if (config.codex)
        copy.codex = {
          modelProvider: config.codex.modelProvider,
          env: { ...config.codex.env },
          legacyExtraArgs: [...config.codex.legacyExtraArgs],
        };
      return copy;
    });
    const byId = new Map(configs.map((config) => [config.id, config]));
    const initial = (type: SupportedWorkerType): WorkerConfig => {
      const config = byId.get(INITIAL_CONFIG_IDS[type]);
      if (!config)
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "初始配置 " + INITIAL_CONFIG_IDS[type] + " 已不存在，旧版设置无法更新",
        );
      return config;
    };
    initial("pi").concurrency = pi as number;
    if (codexConcurrency !== undefined)
      initial("codex").concurrency = codexConcurrency;
    if (input.enabled)
      for (const type of LEGACY_WORKER_TYPES)
        initial(type).enabled = input.enabled[type];
    if (input.roles)
      for (const type of LEGACY_WORKER_TYPES)
        initial(type).roles = [...input.roles[type]];
    if (input.defaults !== undefined) {
      const currentCodex: WorkerDefaults["codex"] = {
        model: initial("codex").model,
        effort: initial("codex").effort,
      };
      const defaults = this.validateDefaults(input.defaults, currentCodex);
      for (const type of LEGACY_WORKER_TYPES) {
        if (type === "codex" && input.defaults.codex === undefined) continue;
        initial(type).model = defaults[type].model;
        initial(type).effort = defaults[type].effort;
      }
    }
    if (input.codex !== undefined) {
      const value = input.codex;
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new WorkerFailure("INVALID_SETTINGS", "codex 必须是配置对象");
      const env = value.env;
      if (!env || typeof env !== "object" || Array.isArray(env))
        throw new WorkerFailure("INVALID_SETTINGS", "codex.env 必须是字符串映射");
      const normalizedEnv: Record<string, string> = {};
      for (const [key, item] of Object.entries(env))
        if (typeof item !== "string")
          throw new WorkerFailure("INVALID_SETTINGS", "codex.env 必须是字符串映射");
        else normalizedEnv[key] = item;
      const extraArgs = value.extraArgs;
      if (!Array.isArray(extraArgs) || extraArgs.some((item) => typeof item !== "string"))
        throw new WorkerFailure("INVALID_SETTINGS", "codex.extraArgs 必须是字符串数组");
      if (
        extraArgs.some(
          (item) =>
            item === "--cd" || item.startsWith("--cd=") || item.startsWith("-C"),
        )
      )
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "工作目录由任务工作区控制，额外参数不支持 -C/--cd",
        );
      // The legacy Codex block replaces the whole launch view: the service is re-extracted from
      // the new args and cleared when they no longer name one, so stale providers never win.
      const extracted = extractCodexLaunch([...extraArgs]);
      initial("codex").codex = {
        modelProvider: extracted.modelProvider,
        env: normalizedEnv,
        legacyExtraArgs: extracted.legacyExtraArgs,
      };
    }
    const defaultConfigId =
      input.defaultWorkerType === undefined
        ? current.defaultConfigId
        : initial(input.defaultWorkerType).id;
    const defaultConfig = configs.find((config) => config.id === defaultConfigId);
    if (!defaultConfig || !defaultConfig.enabled)
      throw new WorkerFailure("INVALID_SETTINGS", "defaultWorkerType 必须为已启用的类型");
    if (!configs.some((config) => config.enabled))
      throw new WorkerFailure("INVALID_SETTINGS", "至少需要一个已启用的配置");
    const record: WorkerSettingsRecord = {
      schemaVersion: 2,
      configs,
      defaultConfigId,
      retentionDays: input.retentionDays ?? current.retentionDays,
      softReminderSeconds: current.softReminderSeconds,
      softReminderSteps: current.softReminderSteps,
      acpIdleTimeoutSeconds:
        input.acpIdleTimeoutSeconds ?? current.acpIdleTimeoutSeconds,
    };
    this.store.saveSettings(record);
    if (input.acpIdleTimeoutSeconds !== undefined)
      this.applyAcpIdleTimeoutSeconds(input.acpIdleTimeoutSeconds);
    this.pruneHistory();
    void this.dispatch();
    return projectSettings(record, this.acpIdleTimeoutSeconds);
  }

  /** Updates the AGY idle window without resetting the current idle start. */
  private applyAcpIdleTimeoutSeconds(seconds: number): void {
    this.acpIdleTimeoutSeconds = seconds;
    this.agyAcpProcess?.setIdleTimeoutMs(seconds * 1000);
  }

  /** Validates one canonical config and normalizes its Codex launch view. */
  private normalizeConfig(
    value: unknown,
    previousById?: Map<string, WorkerConfig>,
  ): WorkerConfig {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new WorkerFailure("INVALID_SETTINGS", "configs 的每一项必须是配置对象");
    const entry = value as Record<string, unknown>;
    const id = clean(entry.id as string | undefined);
    const name = clean(entry.name as string | undefined);
    if (!id) throw new WorkerFailure("INVALID_SETTINGS", "配置 id 不能为空");
    if (!name) throw new WorkerFailure("INVALID_SETTINGS", "配置 name 不能为空");
    const type = entry.type as SupportedWorkerType;
    if (!SUPPORTED_WORKER_TYPES.includes(type))
      throw new WorkerFailure(
        "INVALID_SETTINGS",
        "配置 type 必须是 pi、codex 或 agy；DSH 已停止支持",
      );
    if (typeof entry.enabled !== "boolean")
      throw new WorkerFailure("INVALID_SETTINGS", "配置 enabled 必须是布尔值");
    if (!Array.isArray(entry.roles) || entry.roles.some(
      (role) =>
        typeof role !== "string" ||
        !WORKER_TASK_ROLES.some((item) => item.value === role),
    ))
      throw new WorkerFailure("INVALID_SETTINGS", "配置 roles 必须是合法任务角色数组");
    if (!Number.isSafeInteger(entry.concurrency) || (entry.concurrency as number) < 1)
      throw new WorkerFailure("INVALID_SETTINGS", "配置 concurrency 必须是正整数");
    if (
      entry.hardTimeoutSeconds !== undefined &&
      entry.hardTimeoutSeconds !== null &&
      (!Number.isSafeInteger(entry.hardTimeoutSeconds) || (entry.hardTimeoutSeconds as number) < 1)
    )
      throw new WorkerFailure("INVALID_SETTINGS", "配置 hardTimeoutSeconds 必须是正整数或 null");
    if (entry.model !== undefined && entry.model !== null && typeof entry.model !== "string")
      throw new WorkerFailure("INVALID_SETTINGS", "配置 model 必须是字符串或 null");
    if (entry.effort !== undefined && entry.effort !== null && typeof entry.effort !== "string")
      throw new WorkerFailure("INVALID_SETTINGS", "配置 effort 必须是字符串或 null");
    const model = clean(entry.model as string | null | undefined);
    const effort = clean(entry.effort as string | null | undefined);
    const config: WorkerConfig = {
      id,
      name,
      type,
      enabled: entry.enabled,
      roles: [...(entry.roles as WorkerConfig["roles"])],
      concurrency: entry.concurrency as number,
      hardTimeoutSeconds: entry.hardTimeoutSeconds === undefined
        ? 600
        : entry.hardTimeoutSeconds as number | null,
      model,
      effort,
    };
    const before = previousById?.get(id);
    const preservesLegacyEffort =
      effort !== null &&
      before !== undefined &&
      before.type === type &&
      before.effort === effort;
    if (type === "pi" && effort && !(PI_THINKING_LEVELS as readonly string[]).includes(effort))
      throw new WorkerFailure(
        "INVALID_SETTINGS",
        "Pi 配置的 effort 必须是受支持的 thinking 级别",
      );
    const effortProblem = validateConfigEffort(type, model, effort, {
      allowLegacy: preservesLegacyEffort,
    });
    if (effortProblem)
      throw new WorkerFailure("INVALID_SETTINGS", effortProblem);
    if (type === "codex") {
      if (!entry.codex || typeof entry.codex !== "object" || Array.isArray(entry.codex))
        throw new WorkerFailure("INVALID_SETTINGS", "Codex 配置必须包含 codex 对象");
      config.codex = this.normalizeCodexConfig(entry.codex as Record<string, unknown>);
    }
    return config;
  }

  private normalizeCodexConfig(value: Record<string, unknown>): WorkerCodexConfig {
    const env = value.env;
    if (!env || typeof env !== "object" || Array.isArray(env))
      throw new WorkerFailure("INVALID_SETTINGS", "codex.env 必须是字符串映射");
    const normalizedEnv: Record<string, string> = {};
    for (const [key, item] of Object.entries(env))
      if (typeof item !== "string")
        throw new WorkerFailure("INVALID_SETTINGS", "codex.env 必须是字符串映射");
      else normalizedEnv[key] = item;
    const extraArgs = value.legacyExtraArgs;
    if (!Array.isArray(extraArgs) || extraArgs.some((item) => typeof item !== "string"))
      throw new WorkerFailure("INVALID_SETTINGS", "codex.legacyExtraArgs 必须是字符串数组");
    if (
      extraArgs.some(
        (item) =>
          item === "--cd" || item.startsWith("--cd=") || item.startsWith("-C"),
      )
    )
      throw new WorkerFailure(
        "INVALID_SETTINGS",
        "工作目录由任务工作区控制，额外参数不支持 -C/--cd",
      );
    if (
      value.modelProvider !== undefined &&
      value.modelProvider !== null &&
      typeof value.modelProvider !== "string"
    )
      throw new WorkerFailure("INVALID_SETTINGS", "codex.modelProvider 必须是字符串或 null");
    const extracted = extractCodexLaunch([...extraArgs]);
    return {
      modelProvider:
        clean(value.modelProvider as string | null | undefined) ??
        extracted.modelProvider,
      env: normalizedEnv,
      legacyExtraArgs: extracted.legacyExtraArgs,
    };
  }

  /**
   * Workers lock a config's engine and id against reuse; active runs block deletion. Terminal
   * history may outlive a deleted config because the worker keeps its name snapshot.
   */
  private assertConfigReferences(
    previous: WorkerConfig[],
    next: WorkerConfig[],
  ): void {
    const usage = this.store.configUsage();
    const previousById = new Map(previous.map((config) => [config.id, config]));
    const nextIds = new Set(next.map((config) => config.id));
    for (const config of next) {
      const before = previousById.get(config.id);
      if (!before && usage[config.id]?.referenced)
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "配置 id 已被历史记录引用，不能复用",
        );
      if (before && before.type !== config.type && usage[config.id]?.referenced)
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "已引用的配置不能修改执行引擎",
        );
    }
    for (const config of previous)
      if (!nextIds.has(config.id) && (usage[config.id]?.activeRuns ?? 0) > 0)
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "配置仍有活动运行，不能删除",
        );
  }

  /** Validates the legacy pi/codex defaults and normalizes blank strings to null. */
  private validateDefaults(
    value: NonNullable<WorkerLegacySettingsInput["defaults"]>,
    currentCodex: WorkerDefaults["codex"],
  ): Record<LegacyWorkerType, WorkerDefaults["codex"]> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new WorkerFailure(
        "INVALID_SETTINGS",
        "defaults 必须包含 pi 和 codex 配置对象",
      );
    const result = {} as Record<LegacyWorkerType, WorkerDefaults["codex"]>;
    for (const type of LEGACY_WORKER_TYPES) {
      if (type === "codex" && value.codex === undefined) {
        result.codex = currentCodex;
        continue;
      }
      const entry = value[type];
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "defaults." + type + " 必须是配置对象",
        );
      const model = entry.model;
      const effort = entry.effort;
      if (model !== undefined && model !== null && typeof model !== "string")
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "defaults." + type + ".model 必须是字符串或 null",
        );
      if (effort !== undefined && effort !== null && typeof effort !== "string")
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "defaults." + type + ".effort 必须是字符串或 null",
        );
      const normalizedModel = clean(model);
      const normalizedEffort = clean(effort);
      if (
        type === "pi" &&
        normalizedEffort &&
        !(PI_THINKING_LEVELS as readonly string[]).includes(normalizedEffort)
      )
        throw new WorkerFailure(
          "INVALID_SETTINGS",
          "defaults.pi.effort 必须是受支持的 Pi thinking 级别",
        );
      result[type] = { model: normalizedModel, effort: normalizedEffort };
    }
    return result;
  }

  //------------------ START AND RESUME ----------------

  async start(
    ownerId: string,
    input: WorkerStartInput,
  ): Promise<{ worker: WorkerRecord; run: WorkerRun }> {
    const owner = this.requireOwner(ownerId);
    if (owner.paused)
      throw new WorkerFailure("OWNER_PAUSED", "owner 已暂停，不接受新任务");
    this.validateStart(input);
    const requestId = input.requestId.trim();
    const requestKey = this.requestKey(owner);
    const fingerprint = this.fingerprint("start", this.startFingerprint(input));
    const existing = this.store.request(requestKey, requestId);
    if (existing) {
      this.assertReplay(existing, "start", fingerprint);
      return this.resultOf(existing.workerId, existing.runId);
    }
    // Resolve mutable settings only after replay lookup: an omitted config must not reinterpret a
    // request whose original run already exists.
    const settings = this.store.settings();
    const config = this.resolveStartConfig(input, settings);
    const type = config.type;
    this.rejectNonCodexProvider(type, input.provider);
    const selection = this.startSelection(type, input, config);
    this.validateSelection(type, selection);
    const timeoutSeconds = this.timeoutFor(input.timeoutSeconds, config);
    const id = randomUUID();
    const runId = randomUUID();
    const createdAt = new Date(this.now()).toISOString();
    const homes = nativeHome(
      type,
      this.options.dataDirectory,
      this.nativeEnvironment(type, config),
    );
    const run: WorkerRun = {
      id: runId,
      workerId: id,
      taskName: input.taskName.trim(),
      requestId,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      model: selection.model,
      provider: selection.provider,
      effort: selection.effort,
      timeoutSeconds,
      home: homes.home,
      sessionsRoot: homes.sessionsRoot,
      nativeSessionId: null,
      nativeSessionFile: null,
      ...(type === "agy" ? { nativeProtocol: "acp" as const } : {}),
      exitCode: null,
      finalText: null,
      error: null,
      usage: null,
      progress: {
        steps: null,
        phase: null,
        currentTool: null,
        lastEventAt: null,
        softReminderSentAt: null,
        hardTimeoutAt: null,
      },
    };
    const worker: WorkerRecord = {
      id,
      type,
      configId: config.id,
      configName: config.name,
      taskName: input.taskName.trim(),
      taskRole: input.taskRole,
      ownerId,
      parentSessionId: owner.parentSessionId,
      projectId: owner.projectId,
      projectPath: owner.projectPath,
      writePaths: [...input.writePaths],
      workspace: {
        mode: input.workspace.mode,
        path: owner.projectPath,
      },
      cwd: owner.projectPath,
      createdAt,
      latestRun: null,
    };
    // Admission is synchronous so a concurrent duplicate cannot observe a half-created worker.
    this.store.createWorker(
      worker,
      run,
      requestKey,
      requestId,
      "start",
      fingerprint,
    );
    this.prompts.set(
      runId,
      // Computed only after the replay check above, so an accepted request always launches with
      // the role guidance while its original prompt remains the replay identity.
      input.taskRole
        ? `${TASK_ROLE_PROMPTS[input.taskRole]}\n${TASK_ROLE_REPORT}\n\n${input.prompt}`
        : input.prompt,
    );
    this.pendingAdmissions.add(runId);
    try {
      const workspace = await this.workspace.resolve(
        id,
        owner.projectPath,
        input.workspace,
      );
      worker.workspace = workspace;
      worker.cwd = workspace.path;
      this.store.replaceWorkspace(id, workspace);
    } catch (error) {
      this.finishAdmissionFailure(run, error);
      return this.resultOf(id, runId);
    } finally {
      this.pendingAdmissions.delete(runId);
    }
    void this.dispatch();
    return this.resultOf(id, runId);
  }

  async resume(
    ownerId: string,
    input: WorkerResumeInput,
  ): Promise<{ worker: WorkerRecord; run: WorkerRun }> {
    const owner = this.requireOwner(ownerId);
    if (owner.paused)
      throw new WorkerFailure("OWNER_PAUSED", "owner 已暂停，不接受新任务");
    this.validateResume(input);
    const requestId = input.requestId.trim();
    const requestKey = this.requestKey(owner);
    const fingerprint = this.fingerprint("resume", this.resumeFingerprint(input));
    const existing = this.store.request(requestKey, requestId);
    if (existing) {
      this.assertReplay(existing, "resume", fingerprint);
      return this.resultOf(existing.workerId, existing.runId);
    }
    const worker = this.ownedWorker(ownerId, input.workerId);
    if (worker.type === "dsh")
      throw new WorkerFailure(
        "WORKER_TYPE_UNSUPPORTED",
        "DSH Worker 已停止支持；历史记录仍可读取，但不能续接",
      );
    const settings = this.store.settings();
    const config = configById(settings, worker.configId);
    if (!config || !config.enabled)
      throw new WorkerFailure("WORKER_TYPE_DISABLED", "该 worker 类型已禁用或配置不存在，不能续接");
    this.rejectNonCodexProvider(worker.type, input.provider);
    if (this.store.workerCleanedAt(worker.id))
      throw new WorkerFailure("WORKSPACE_CLEANED", "worktree 已清理，请为后续任务创建新的 worker");
    const previous = this.store.latestRun(worker.id);
    if (!previous)
      throw new WorkerFailure("RUN_NOT_FOUND", "worker 尚无运行记录");
    if (!TERMINAL.includes(previous.status))
      throw new WorkerFailure("ACTIVE_RUN", "worker 仍有活动运行，不能续接");
    if (!previous.nativeSessionId)
      throw new WorkerFailure(
        "NATIVE_SESSION_UNKNOWN",
        "上一次运行没有可核实的原生会话身份，不能续接",
      );
    const selection = this.resumeSelection(worker.type, input, previous);
    this.validateSelection(worker.type, selection);
    const runId = randomUUID();
    const timeoutSeconds = this.timeoutFor(input.timeoutSeconds, config);
    // Each resumed requirement gets its own title; the worker's original name stays the fallback
    // so earlier runs and the native session identity are never renamed.
    const taskName = input.taskName?.trim() ?? taskTitleFromPrompt(input.prompt);
    const run: WorkerRun = {
      id: runId,
      workerId: worker.id,
      taskName,
      requestId,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      model: selection.model,
      provider: selection.provider,
      effort: selection.effort,
      timeoutSeconds,
      home: previous.home,
      sessionsRoot: previous.sessionsRoot,
      nativeSessionId: previous.nativeSessionId,
      nativeSessionFile: previous.nativeSessionFile,
      ...(worker.type === "agy" ? { nativeProtocol: "acp" as const } : {}),
      legacyCodexProvider:
        worker.type === "codex" &&
        previous.legacyCodexProvider === true &&
        selection.provider === null
          ? true
          : undefined,
      exitCode: null,
      finalText: null,
      error: null,
      usage: null,
      progress: {
        steps: null,
        phase: null,
        currentTool: null,
        lastEventAt: null,
        softReminderSentAt: null,
        hardTimeoutAt: null,
      },
    };
    const rebound: WorkerRecord = {
      ...worker,
      ownerId: owner.id,
      parentSessionId: owner.parentSessionId,
      projectId: owner.projectId,
    };
    this.store.transaction(() => {
      // An explicit resume rebinds only this stopped worker to the current generation.
      this.store.saveWorker(rebound);
      this.store.insertRun(run);
      this.store.addRequest(
        requestKey,
        requestId,
        worker.id,
        run.id,
        "resume",
        fingerprint,
      );
    });
    this.prompts.set(runId, input.prompt);
    void this.dispatch();
    return this.resultOf(worker.id, runId);
  }

  private validateStart(input: WorkerStartInput): void {
    if (!input || typeof input !== "object")
      throw new WorkerFailure("INVALID_INPUT", "请求体无效");
    if (typeof input.taskName !== "string" || !input.taskName.trim())
      throw new WorkerFailure("INVALID_INPUT", "taskName 不能为空");
    if (
      input.type !== undefined &&
      !SUPPORTED_WORKER_TYPES.includes(input.type as SupportedWorkerType)
    )
      throw new WorkerFailure(
        "INVALID_INPUT",
        "type 必须是 pi、codex 或 agy；DSH 已停止支持",
      );
    if (typeof input.prompt !== "string" || !input.prompt.trim())
      throw new WorkerFailure("INVALID_INPUT", "prompt 不能为空");
    if (typeof input.requestId !== "string" || !input.requestId.trim())
      throw new WorkerFailure("INVALID_INPUT", "requestId 不能为空");
    if (!input.workspace || typeof input.workspace !== "object")
      throw new WorkerFailure("INVALID_INPUT", "workspace 不能为空");
    if (input.workspace.mode !== "worktree" && input.workspace.mode !== "existing")
      throw new WorkerFailure(
        "INVALID_INPUT",
        "workspace.mode 必须显式选择 worktree 或 existing",
      );
    if (!Array.isArray(input.writePaths) || input.writePaths.some((item) => typeof item !== "string"))
      throw new WorkerFailure("INVALID_INPUT", "writePaths 必须是字符串数组");
    if (input.workspace.cwd !== undefined && typeof input.workspace.cwd !== "string")
      throw new WorkerFailure("INVALID_INPUT", "workspace.cwd 必须是字符串");
    if (input.workspace.baseRef !== undefined && typeof input.workspace.baseRef !== "string")
      throw new WorkerFailure("INVALID_INPUT", "workspace.baseRef 必须是字符串");
    if (
      input.workspace.allowDirtySource !== undefined &&
      typeof input.workspace.allowDirtySource !== "boolean"
    )
      throw new WorkerFailure("INVALID_INPUT", "allowDirtySource 必须是布尔值");
    if (input.timeoutSeconds !== undefined && input.timeoutSeconds !== null) {
      if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds <= 0)
        throw new WorkerFailure("INVALID_INPUT", "timeoutSeconds 必须是正整数或 null");
    }
    if (input.configId !== undefined && typeof input.configId !== "string")
      throw new WorkerFailure("INVALID_INPUT", "configId 必须是字符串");
    this.validateOptionalSelection(input);
  }

  private validateResume(input: WorkerResumeInput): void {
    if (!input || typeof input !== "object")
      throw new WorkerFailure("INVALID_INPUT", "请求体无效");
    if (typeof input.workerId !== "string" || !input.workerId.trim())
      throw new WorkerFailure("INVALID_INPUT", "workerId 不能为空");
    if (typeof input.prompt !== "string" || !input.prompt.trim())
      throw new WorkerFailure("INVALID_INPUT", "prompt 不能为空");
    if (typeof input.requestId !== "string" || !input.requestId.trim())
      throw new WorkerFailure("INVALID_INPUT", "requestId 不能为空");
    if (
      input.taskName !== undefined &&
      (typeof input.taskName !== "string" || !input.taskName.trim())
    )
      throw new WorkerFailure("INVALID_INPUT", "taskName 不能为空");
    if (input.timeoutSeconds !== undefined && input.timeoutSeconds !== null) {
      if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds <= 0)
        throw new WorkerFailure("INVALID_INPUT", "timeoutSeconds 必须是正整数或 null");
    }
    this.validateOptionalSelection(input);
  }

  private validateOptionalSelection(input: {
    model?: string;
    provider?: string;
    effort?: string;
  }): void {
    for (const key of ["model", "provider", "effort"] as const)
      if (input[key] !== undefined && typeof input[key] !== "string")
        throw new WorkerFailure("INVALID_INPUT", key + " 必须是字符串");
  }

  private fingerprint(operation: string, payload: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify({ operation, payload }))
      .digest("hex");
  }

  private startFingerprint(input: WorkerStartInput): unknown {
    return {
      taskName: input.taskName.trim(),
      type: input.type,
      taskRole: input.taskRole,
      prompt: input.prompt,
      workspace: {
        mode: input.workspace.mode,
        cwd: clean(input.workspace.cwd),
        baseRef: clean(input.workspace.baseRef),
        allowDirtySource: input.workspace.allowDirtySource === true,
      },
      writePaths: [...input.writePaths],
      model: clean(input.model),
      provider: clean(input.provider),
      effort: clean(input.effort),
      timeoutSeconds:
        input.timeoutSeconds === undefined ? "default" : input.timeoutSeconds,
      // Omitted configId stays absent so pre-config replay hashes remain identical.
      ...(input.configId !== undefined ? { configId: input.configId } : {}),
    };
  }

  private resumeFingerprint(input: WorkerResumeInput): unknown {
    return {
      workerId: input.workerId.trim(),
      prompt: input.prompt,
      // JSON.stringify drops an undefined value, so an omitted taskName keeps legacy hashes.
      taskName: input.taskName?.trim(),
      model: clean(input.model),
      provider: clean(input.provider),
      effort: clean(input.effort),
      timeoutSeconds:
        input.timeoutSeconds === undefined ? "default" : input.timeoutSeconds,
    };
  }

  private assertReplay(
    existing: {
      operation: string;
      fingerprint: string;
      workerId: string;
      runId: string;
    },
    operation: string,
    fingerprint: string,
  ): void {
    if (
      existing.operation !== operation ||
      existing.fingerprint !== fingerprint
    )
      throw new WorkerFailure(
        "REQUEST_ID_CONFLICT",
        "requestId 已用于不同的请求内容或操作",
      );
  }

  /**
   * Chooses the config for a new worker. An explicit `configId` is authoritative; otherwise only
   * enabled configs route, optionally narrowed by an explicit `type`, then by `taskRole`. A role
   * match takes the first matching config in persisted list order (the list order the settings UI
   * maintains); no role match, or no `taskRole`, falls back to the default config when it is in
   * the candidate set, otherwise to the first candidate.
   */
  private resolveStartConfig(
    input: WorkerStartInput,
    settings: WorkerSettings,
  ): WorkerConfig {
    const configs = settings.configs;
    if (input.configId !== undefined) {
      const configId = input.configId.trim();
      const config = configs.find((candidate) => candidate.id === configId);
      if (!config)
        throw new WorkerFailure("CONFIG_NOT_FOUND", "worker 配置不存在");
      if (input.type !== undefined && input.type !== config.type)
        throw new WorkerFailure("INVALID_INPUT", "configId 与 type 不一致");
      if (!config.enabled)
        throw new WorkerFailure("WORKER_TYPE_DISABLED", "该 worker 配置已停用");
      return config;
    }
    let candidates = configs.filter((config) => config.enabled);
    if (input.type !== undefined) {
      candidates = candidates.filter((config) => config.type === input.type);
      if (!candidates.length)
        throw new WorkerFailure("WORKER_TYPE_DISABLED", "该 worker 类型已禁用");
    }
    if (!candidates.length)
      throw new WorkerFailure("WORKER_TYPE_DISABLED", "没有可用的 worker 配置");
    const preferred = candidates.find(
      (config) => config.id === settings.defaultConfigId,
    );
    if (input.taskRole !== undefined) {
      const matches = candidates.filter((config) =>
        config.roles.includes(input.taskRole!),
      );
      // The persisted configs order is the routing priority, so the default config does not
      // override an earlier role match.
      if (matches.length) return matches[0]!;
    }
    return preferred ?? candidates[0]!;
  }

  /** New runs snapshot the explicit request first, then the selected config's defaults. */
  private startSelection(
    type: WorkerType,
    input: {
      model?: string;
      provider?: string;
      effort?: string;
    },
    config: WorkerConfig,
  ): NativeSelection {
    return {
      model: clean(input.model) ?? clean(config.model),
      // Only Codex has an independent service; Pi receives its full model id and DSH routes from
      // the model patch.
      provider: type === "codex" ? clean(input.provider) ?? config.codex?.modelProvider ?? null : null,
      effort: clean(input.effort) ?? clean(config.effort),
    };
  }

  /**
   * Resume uses the recorded run plus explicit overrides; it never re-applies current config
   * models. Old Pi independent providers are folded into a full model id for this new run.
   */
  private resumeSelection(
    type: WorkerType,
    input: { model?: string; provider?: string; effort?: string },
    previous: WorkerRun,
  ): NativeSelection {
    const explicitModel = clean(input.model);
    const effort = clean(input.effort) ?? previous.effort;
    if (type === "codex") {
      return {
        model: explicitModel ?? previous.model,
        provider: clean(input.provider) ?? previous.provider,
        effort,
      };
    }
    if (explicitModel)
      return { model: explicitModel, provider: null, effort };
    let model = previous.model;
    if (type === "pi") {
      if (model && previous.provider) {
        const prefix = previous.provider + "/";
        if (!model.toLowerCase().startsWith(prefix.toLowerCase()))
          model = prefix + model;
      }
      return { model, provider: null, effort };
    }
    // agy model ids are native CLI ids (for example `gemini-3.8-flash-low`) and never carry an
    // independent provider.
    return { model, provider: null, effort };
  }

  /** Rejects a non-empty independent provider for engines that do not support one. */
  private rejectNonCodexProvider(
    type: WorkerType,
    provider: string | undefined,
  ): void {
    if (type !== "codex" && clean(provider))
      throw new WorkerFailure(
        "PROVIDER_UNSUPPORTED",
        "provider 仅 Codex 支持；Pi/agy 请使用完整 model",
      );
  }

  private validateSelection(
    type: SupportedWorkerType,
    selection: NativeSelection,
  ): void {
    if (
      type === "pi" && selection.effort &&
      !(PI_THINKING_LEVELS as readonly string[]).includes(selection.effort)
    ) {
      throw new WorkerFailure("INVALID_INPUT", "不支持的 Pi thinking 级别");
    }
    const effortProblem = validateConfigEffort(type, selection.model, selection.effort);
    if (effortProblem) throw new WorkerFailure("INVALID_INPUT", effortProblem);
    if (type === "agy") {
      try {
        planAgyAcpConfig({
          model: selection.model,
          effort: selection.effort,
        });
      } catch (error) {
        throw new WorkerFailure(
          "INVALID_INPUT",
          error instanceof AgyAcpSelectionError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
    }
  }

  private timeoutFor(
    value: number | null | undefined,
    config: WorkerConfig,
  ): number | null {
    return value === undefined ? config.hardTimeoutSeconds : value;
  }

  //------------------ DISPATCH AND GUARDIAN ----------------

  private async dispatch(): Promise<void> {
    if (this.dispatching || this.closing || this.recovering) return;
    this.dispatching = true;
    try {
      const skipped = new Set<string>();
      for (;;) {
        const queued = this.store.queuedRuns().filter((run) => !skipped.has(run.id));
        if (!queued.length) return;
        const settings = this.store.settings();
        const configs = new Map(
          settings.configs.map((config) => [config.id, config]),
        );
        const occupied = this.store.occupyingRuns();
        const counts = new Map<string, number>();
        for (const run of occupied) {
          const worker = this.store.worker(run.workerId);
          if (!worker) continue;
          const key = [worker.parentSessionId, worker.projectId, worker.configId].join("\u0000");
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const agyBlocked = this.agyCooldownActive();
        let selected: WorkerRun | null = null;
        for (const run of queued) {
          // Worktree admission is still resolving; never spawn from a placeholder cwd.
          if (this.pendingAdmissions.has(run.id)) continue;
          const worker = this.store.worker(run.workerId);
          if (!worker) {
            skipped.add(run.id);
            continue;
          }
          if (worker.type === "dsh") {
            // Retired DSH rows stay untouched and never occupy admission.
            skipped.add(run.id);
            continue;
          }
          // A global agy cooldown blocks every agy config; other engines keep their own queues.
          if (worker.type === "agy" && agyBlocked) {
            skipped.add(run.id);
            continue;
          }
          const registered = this.owners.get(worker.ownerId);
          if (!registered || registered.owner.paused) {
            skipped.add(run.id);
            continue;
          }
          const key = [worker.parentSessionId, worker.projectId, worker.configId].join("\u0000");
          const limit = configs.get(worker.configId)?.concurrency ?? 1;
          if ((counts.get(key) ?? 0) >= limit) continue;
          selected = run;
          break;
        }
        if (!selected) return;
        const worker = this.store.worker(selected.workerId);
        const owner = worker ? this.owners.get(worker.ownerId)?.owner : null;
        if (!worker || !owner) {
          skipped.add(selected.id);
          continue;
        }
        // Queued Pi runs created by an older plugin also launch through the CLI.
        if (worker.type === "pi") delete selected.nativeProtocol;
        selected.status = "starting";
        selected.startedAt = new Date(this.now()).toISOString();
        selected.progress.hardTimeoutAt = selected.timeoutSeconds === null
          ? null
          : new Date(Date.parse(selected.startedAt) + selected.timeoutSeconds * 1000).toISOString();
        this.store.saveRun(selected);
        try {
          this.launch(worker, owner, selected);
        } catch (error) {
          this.finishAdmissionFailure(selected, error);
        }
      }
    } finally {
      this.dispatching = false;
    }
  }

  private launch(worker: WorkerRecord, owner: WorkerOwner, run: WorkerRun): void {
    const runDirectory = this.runDirectory(worker.id, run.id);
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const prompt = this.prompts.get(run.id) ?? "";
    if (!prompt) throw new WorkerFailure("PROMPT_MISSING", "运行 prompt 已丢失");
    fs.writeFileSync(path.join(runDirectory, "prompt.md"), prompt, { mode: 0o600 });
    // Admission snapshots the native identity so queued resumes survive history expiration.
    const previous = run.nativeSessionId ? run : null;
    // Read settings for every native invocation so PATH, Codex env, and extra args stay current.
    const settings = this.store.settings();
    const config = configById(settings, worker.configId);
    const safeEnvironment = this.nativeEnvironment(worker.type, config);
    if (worker.type === "agy" && run.nativeProtocol === "acp") {
      this.launchAgyAcp(worker, run, runDirectory, prompt, previous, safeEnvironment);
      return;
    }
    const executable = this.executable(worker.type, safeEnvironment);
    if (worker.type === "codex") {
      // Baseline is captured at actual launch, never while queued: a resumed thread reads the
      // last cumulative snapshot and the rollout EOF, while a new thread uses known zero.
      const file =
        run.nativeSessionFile && fs.existsSync(run.nativeSessionFile)
          ? run.nativeSessionFile
          : findCodexSessionFile(run.sessionsRoot, run.nativeSessionId);
      if (file) run.nativeSessionFile = file;
      run.codexUsageBaseline = run.nativeSessionId
        ? codexBaseline(file)
        : { counters: zeroCodexCounters(), offset: 0 };
      this.store.saveRun(run);
    }
    const launch = prepareLaunch({
      type: worker.type,
      run,
      cwd: worker.cwd,
      prompt,
      previous,
      dataDirectory: this.options.dataDirectory,
      runDirectory,
      executable,
      baseEnvironment: safeEnvironment,
      codexExtraArgs:
        worker.type === "codex" ? config?.codex?.legacyExtraArgs ?? [] : null,
      codexLegacyProvider:
        worker.type === "codex" &&
        run.legacyCodexProvider === true &&
        run.provider === null
          ? config?.codex?.modelProvider ?? null
          : null,
    });
    if (!run.nativeSessionFile && launch.sessionFile) {
      // Persist the explicit Pi session file before spawning so retention protects it.
      run.nativeSessionFile = launch.sessionFile;
      this.store.saveRun(run);
    }
    const specPath = path.join(runDirectory, "spec.json");
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        argv: launch.argv,
        cwd: launch.cwd,
        prompt,
        timeoutSeconds: run.timeoutSeconds,
        runDirectory,
        executable: launch.argv[0],
      }),
      { mode: 0o600 },
    );
    const [command, ...prefix] = this.guardianCommand();
    const child = spawn(command!, [...prefix, specPath], {
      cwd: runDirectory,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: true,
    });
    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
    const handle: RunHandle = {
      runId: run.id,
      workerId: worker.id,
      ownerId: worker.ownerId,
      requestStop: () => {
        try {
          child.send?.({ type: "stop" });
        } catch {
          // A closed IPC channel already triggers guardian disconnect cleanup.
        }
      },
      ended,
      resolveEnded,
      finalized: false,
      holdNotification: false,
      stopRequested: false,
      progress: newProgress(),
      expectedSessionId: launch.expectedSessionId,
      expectedAction: null,
      lastProgressSave: 0,
    };
    this.handles.set(run.id, handle);
    child.stderr?.on("data", (chunk: Buffer) => {
      // Guardian diagnostics stay in the plugin stderr, never in the user-facing event log.
      process.stderr.write(chunk);
    });
    child.on("message", (message: { type?: string; line?: string }) => {
      if (message?.type === "line" && typeof message.line === "string")
        this.onEventLine(handle, message.line);
    });
    child.once("error", (error) => {
      if (this.storeClosed) return;
      this.finalizeRun(run.id, null, "无法启动监护进程: " + error.message);
    });
    child.once("exit", () => {
      if (this.storeClosed) return;
      const evidence = this.readEvidence(run.id);
      this.finalizeRun(run.id, evidence, null);
    });
  }

  private agyAcpCommand(environment: NodeJS.ProcessEnv): { executable: string; args: string[] } {
    const injected = this.options.executablePaths?.["agy-acp"];
    return {
      executable: injected ? path.resolve(injected) : resolveExecutable("agy", environment),
      args: ["acp", "--dangerously-skip-permissions"],
    };
  }

  /** Spawns the shared AGY agent under its own process-group guardian. */
  private spawnAgyAcpProcess(): Promise<AcpConnection> {
    const safeEnvironment = this.guardianEnvironment(this.environment);
    const command = this.agyAcpCommand(safeEnvironment);
    const guardianDirectory = path.join(
      this.options.dataDirectory,
      "agy-acp-guardian",
      `process-${randomUUID()}`,
    );
    fs.mkdirSync(guardianDirectory, { recursive: true, mode: 0o700 });
    const finalPath = path.join(guardianDirectory, "final.json");
    const generation: AcpGeneration = {
      id: path.basename(guardianDirectory),
      directory: guardianDirectory,
    };
    const specPath = path.join(guardianDirectory, `spec-${randomUUID()}.json`);
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        mode: "acp",
        argv: [command.executable, ...command.args],
        cwd: this.options.dataDirectory,
        timeoutSeconds: null,
        runDirectory: guardianDirectory,
        executable: command.executable,
      }),
      { mode: 0o600 },
    );
    const [guardian, ...prefix] = this.guardianCommand();
    const child = spawn(guardian!, [...prefix, specPath], {
      cwd: guardianDirectory,
      env: safeEnvironment,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    // The guardian owns the agent's process group, so a fork-bomb of tools cannot outlive it.
    // Its stderr stays service-level; it is never mixed into a run's logs.
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    let stopPromise: Promise<boolean> | null = null;
    // Stop through the guardian's IPC channel and wait for its final group evidence. This stays
    // separate from AcpConnection's direct-child reaper: the agent is in the guardian's group.
    const stopGuardian = (): Promise<boolean> =>
      (stopPromise ??= (async () => {
        try {
          child.stdin?.end();
        } catch {
          /* already closed */
        }
        try {
          if (child.connected) child.send({ type: "stop" });
        } catch {
          /* already exited */
        }
        const exited = await new Promise<boolean>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve(true);
            return;
          }
          const timer = setTimeout(() => {
            child.off("exit", onExit);
            resolve(false);
          }, 15_000);
          const onExit = () => {
            clearTimeout(timer);
            resolve(true);
          };
          child.once("exit", onExit);
        });
        if (!exited) {
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          await new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            const timer = setTimeout(resolve, 2_000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        let confirmed = false;
        try {
          const value = JSON.parse(fs.readFileSync(finalPath, "utf8")) as {
            groupExited?: unknown;
          };
          confirmed = value.groupExited === true;
        } catch {
          return false;
        }
        if (confirmed && !this.acpGenerationInUse(generation.id)) {
          try {
            fs.rmSync(guardianDirectory, { recursive: true, force: true });
          } catch (error) {
            process.stderr.write(
              "worker acp guardian directory cleanup failed: " + String(error) + "\n",
            );
          }
        }
        return confirmed;
      })());
    return AcpConnection.connect(child, {
      clientInfo: { name: "cloudcli-worker", version: "1.0.0" },
      initializeTimeoutMs: 15_000,
      closeTimeoutMs: 2_000,
      detached: process.platform !== "win32",
      reaper: stopGuardian,
    }).then((connection) => {
      this.acpGenerations.set(connection, generation);
      return connection;
    }).catch(async (error) => {
      // A failed handshake must reclaim the whole guarded group, not just signal the guardian.
      const reaped = await stopGuardian();
      if (!reaped) {
        this.agyAcpBlocked = new AcpTransportError({
          kind: "shutdown",
          message: "上一个 AGY ACP 进程未能确认退出，拒绝启动新进程",
          exitCode: null,
          signal: null,
        });
      }
      throw error;
    });
  }

  private agyAcpSlot(): LazyAcpProcess {
    if (this.agyAcpBlocked) throw this.agyAcpBlocked;
    this.agyAcpProcess ??= new LazyAcpProcess(() => this.spawnAgyAcpProcess(), {
      idleTimeoutMs: this.acpIdleTimeoutSeconds * 1000,
    });
    return this.agyAcpProcess;
  }

  /** Executes an AGY turn on the shared ACP process, with session-scoped cancellation. */
  private launchAgyAcp(
    worker: WorkerRecord,
    run: WorkerRun,
    runDirectory: string,
    prompt: string,
    previous: WorkerRun | null,
    safeEnvironment: NodeJS.ProcessEnv,
  ): void {
    const command = this.agyAcpCommand(safeEnvironment);
    const { configOptions } = planAgyAcpConfig({ model: run.model, effort: run.effort });
    const sessionId = previous?.nativeSessionId ?? null;

    // Persist the launch spec (same observability contract as native guardians); the ACP agent
    // runs in the shared process, so this is the only per-run record of the prompt and choices.
    fs.writeFileSync(
      path.join(runDirectory, "spec.json"),
      JSON.stringify({
        argv: [command.executable, ...command.args],
        cwd: worker.cwd,
        prompt,
        timeoutSeconds: run.timeoutSeconds,
        runDirectory,
        acp: { sessionId, configOptions },
      }),
      { mode: 0o600 },
    );

    let session: AcpSessionHandle | null = null;
    let stopReason: AcpSessionEvidence["reason"] | null = null;
    let stopError: string | null = null;
    let cancelTriggered = false;
    let promptStarted = false;
    let leaseReleased = false;
    let exitWatch: Promise<boolean> | null = null;
    let hardTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let forceSettle!: () => void;
    // Hard timeout/cancel is bounded: an ACP server that ignores session/cancel must not keep a
    // run "running" forever. The race below settles it unconfirmed (unknown), never as stopped.
    const settled = new Promise<void>((resolve) => (forceSettle = resolve));

    const triggerStop = (reason: "cancelled" | "timeout", error?: string): void => {
      if (stopReason === null) {
        stopReason = reason;
        if (error) stopError = error;
      }
      if (cancelTriggered) return;
      cancelTriggered = true;
      if (session && !session.closed) {
        void session.cancel({ graceMs: 1500 }).catch(() => {});
      }
      if (!promptStarted) {
        // No turn exists yet: setup is interrupted, not an unconfirmable prompt. Settle now and
        // let its late acquire/open result close only its own session when it eventually arrives.
        forceSettle();
      } else {
        settleTimer = setTimeout(() => forceSettle(), 4000);
        settleTimer.unref?.();
      }
    };

    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
    const handle: RunHandle = {
      runId: run.id,
      workerId: worker.id,
      ownerId: worker.ownerId,
      requestStop: (reason = "cancelled") => triggerStop(reason),
      ended,
      resolveEnded,
      finalized: false,
      holdNotification: false,
      stopRequested: false,
      progress: newProgress(),
      expectedSessionId: sessionId,
      expectedAction: previous ? "resume" : "new",
      lastProgressSave: 0,
    };
    this.handles.set(run.id, handle);

    if (run.timeoutSeconds && run.timeoutSeconds > 0) {
      hardTimer = setTimeout(
        () => triggerStop("timeout", "超过硬超时 " + run.timeoutSeconds + " 秒"),
        run.timeoutSeconds * 1000,
      );
      hardTimer.unref?.();
    }

    let acceptingEvents = true;
    const emitAcpEvent = (event: AcpEvent): void => {
      // Late setup/close results after terminal evidence must not append to an ended run.
      if (!acceptingEvents) return;
      try {
        appendLog(runDirectory, "events", Buffer.from(JSON.stringify(event) + "\n", "utf8"));
      } catch (error) {
        if (stopReason === null) {
          stopReason = "error";
          stopError = "日志写入失败: " + String(error);
        }
        triggerStop("cancelled", stopError ?? undefined);
        return;
      }
      this.onAcpEvent(handle, event);
    };

    const emitInitFailure = (error: unknown): void => {
      emitAcpEvent({
        protocol: "acp",
        type: "acp_error",
        stage:
          error instanceof AcpTransportError && error.failure.kind === "protocol_error"
            ? "protocol"
            : "initialize",
        code:
          error instanceof AcpTransportError
            ? error.failure.kind === "protocol_error"
              ? "PROTOCOL_INVALID"
              : error.errorCode
            : error instanceof AcpProtocolError || error instanceof AcpConfigError
              ? error.errorCode
              : error instanceof AcpRpcError
                ? error.rpcCode
                : null,
        message: acpErrorText(error),
      });
    };

    void (async () => {
      let slot: LazyAcpProcess | null = null;
      let conn: AcpConnection | null = null;
      let sessionClosed = false;
      let exitCode: number | null = 0;
      let signal: string | null = null;
      let setupAbandoned = false;
      const acquired: { conn: AcpConnection | null } = { conn: null };
      const releaseLease = (): void => {
        if (leaseReleased) return;
        leaseReleased = true;
        slot?.endTask();
      };
      try {
        slot = this.agyAcpSlot();
        const setup = (async (): Promise<AcpSessionHandle | null> => {
          acquired.conn = await slot!.beginTask();
          const generation = this.acpGenerations.get(acquired.conn);
          if (generation) this.recordAcpGeneration(runDirectory, generation);
          if (cancelTriggered) return null;
          const opened = await acquired.conn.openSession({
            cwd: worker.cwd,
            sessionId,
            configOptions,
            onEvent: emitAcpEvent,
            timeoutMs: ACP_SETUP_TIMEOUT_MS,
            shouldAbort: () => cancelTriggered,
          });
          if (cancelTriggered) {
            if (!opened.closed) await opened.close().catch(() => {});
            return null;
          }
          return opened;
        })();
        const setupOutcome = await Promise.race([
          setup.then((value) => ({ kind: "ready" as const, value })),
          settled.then(() => ({ kind: "settled" as const })),
        ]);
        if (setupOutcome.kind === "settled") {
          // The run stops now without a prompt. The late acquire/open still owns its lease and
          // may only close its own session; it must never start the prompt or touch siblings.
          setupAbandoned = true;
          sessionClosed = true;
          exitCode = 0;
          void setup
            .then(async (late) => {
              if (late && !late.closed) await late.close().catch(() => {});
            })
            .catch(() => {})
            .finally(releaseLease);
          return;
        }
        conn = acquired.conn;
        session = setupOutcome.value;
        if (!session || !conn) {
          sessionClosed = true;
          exitCode = 0;
          return;
        }
        if (cancelTriggered) {
          await session.close().catch(() => {});
          sessionClosed = true;
          return;
        }
        promptStarted = true;
        const outcome = await Promise.race([
          session.prompt(prompt).then(() => "prompt" as const),
          settled.then(() => "settled" as const),
        ]);
        if (outcome === "settled") {
          // Best-effort detach; the prompt was never confirmed finished, so evidence stays false
          // until this exact shared process generation's guardian confirms group exit.
          await session.close().catch(() => {});
          sessionClosed = false;
          exitCode = 0;
          exitWatch = conn.whenReaped();
          return;
        }
        await session.close();
        sessionClosed = true;
        exitCode = 0;
      } catch (error) {
        const activeConn = acquired.conn;
        if (error instanceof AcpTransportError) {
          exitCode = error.failure.exitCode;
          signal = error.failure.signal;
          stopError = stopError ?? error.message;
          if (!activeConn) emitInitFailure(error);
          // Reap/confirm the broken process group exited before finalizing so replacement runs never race it.
          sessionClosed = activeConn ? await activeConn.reap() : true;
        } else {
          exitCode = 0;
          stopError = stopError ?? acpErrorText(error);
          if (!activeConn) emitInitFailure(error);
          if (session && !session.closed) {
            await session.close().catch(() => {});
          }
          sessionClosed = true;
        }
      } finally {
        acceptingEvents = false;
        clearTimeout(hardTimer);
        clearTimeout(settleTimer);
        // Session cleanup is complete here; the last task starts the AGY idle clock.
        if (!setupAbandoned) releaseLease();
        const evidence: AcpSessionEvidence = {
          kind: "acp_session",
          reason: stopReason ?? "exit",
          exitCode,
          signal,
          startedAt: run.startedAt,
          finishedAt: new Date(this.now()).toISOString(),
          sessionClosed,
          promptStarted,
          error: stopError,
        };
        try {
          this.writeRunEvidence(runDirectory, evidence);
        } catch (writeError) {
          process.stderr.write(
            "worker acp final evidence write failed: " + String(writeError) + "\n",
          );
        }
        if (!this.storeClosed) {
          this.finalizeRun(run.id, evidence, null);
        }
        if (exitWatch) {
          const watch = exitWatch;
          void watch
            .then((reaped) => {
              if (!reaped || this.storeClosed) return;
              const current = this.store.run(run.id);
              if (!current || current.status !== "unknown") return;
              const confirmed: AcpSessionEvidence = {
                ...evidence,
                sessionClosed: true,
                groupExited: true,
              };
              this.writeRunEvidence(runDirectory, confirmed);
              this.finalizeRun(run.id, confirmed, null);
            })
            .catch(() => {});
        }
      }
    })();
  }

  private writeRunEvidence(runDirectory: string, evidence: RunEvidence): void {
    const target = path.join(runDirectory, "final.json");
    const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(evidence), { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  private guardianCommand(): string[] {
    if (this.options.guardianCommand?.length) return [...this.options.guardianCommand];
    const override = clean(this.environment.CLOUDCLI_WORKER_GUARDIAN);
    if (override) return [process.execPath, override];
    return [
      process.execPath,
      fileURLToPath(new URL("./guardian.mjs", import.meta.url)),
    ];
  }

  /**
   * Merges the selected config's Codex env first, then strips control tokens from the final
   * native environment. A config deleted after a terminal run falls back to the inherited env.
   */
  private nativeEnvironment(
    type: WorkerType,
    config: WorkerConfig | null,
  ): NodeJS.ProcessEnv {
    if (type === "codex")
      return codexEnvironment(this.environment, {
        env: config?.codex?.env ?? {},
      });
    return this.guardianEnvironment(this.environment);
  }

  /** Removes every plugin control token before the native CLI or guardian can inherit it. */
  private guardianEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...base };
    for (const key of Object.keys(environment))
      if (key.startsWith("CLOUDCLI_PLUGIN_")) delete environment[key];
    return environment;
  }

  private executable(
    type: WorkerType,
    environment: NodeJS.ProcessEnv = this.environment,
  ): string {
    const injected = this.options.executablePaths?.[type];
    if (injected) return path.resolve(injected);
    return resolveExecutable(type, environment);
  }

  private userHome(): string {
    return (
      clean(this.environment.HOME) ??
      clean(this.environment.USERPROFILE) ??
      os.homedir()
    );
  }

  /** Consumes an already-validated in-process `AcpEvent` without JSON round-tripping or re-validation. */
  private onAcpEvent(handle: RunHandle, event: AcpEvent): void {
    if (this.storeClosed) return;
    const run = this.store.run(handle.runId);
    if (!run || TERMINAL.includes(run.status)) return;
    trackProgress("agy", event, handle.progress);
    const identityChanged = event.type === "acp_session" && !run.nativeSessionId;
    if (identityChanged) run.nativeSessionId = event.sessionId;
    this.recordProgress(handle, run, identityChanged);
  }

  private onEventLine(handle: RunHandle, line: string): void {
    if (this.storeClosed) return;
    const run = this.store.run(handle.runId);
    if (!run || TERMINAL.includes(run.status)) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const worker = this.store.worker(handle.workerId);
    trackProgress(worker?.type ?? "dsh", event, handle.progress);
    let identityChanged = false;
    const value = event as Record<string, unknown> | null;
    if (worker && !run.nativeSessionId) {
      if (worker.type === "dsh" || worker.type === "pi") {
        const id = value?.type === "session"
          ? (worker.type === "pi" ? value.id : value.sessionId)
          : null;
        const cwd = value?.type === "session" ? value.cwd : null;
        if (
          typeof id === "string" &&
          id.trim() &&
          path.basename(id) === id &&
          typeof cwd === "string" &&
          path.isAbsolute(cwd) &&
          path.resolve(cwd) === path.resolve(worker.cwd)
        ) {
          run.nativeSessionId = id;
          identityChanged = true;
        }
      } else if (
        worker.type === "codex" &&
        value?.type === "thread.started" &&
        typeof value.thread_id === "string" &&
        value.thread_id.trim()
      ) {
        run.nativeSessionId = value.thread_id.trim();
        identityChanged = true;
      } else if (worker.type === "agy" && value?.event === "init") {
        const init =
          value.init && typeof value.init === "object" && !Array.isArray(value.init)
            ? (value.init as Record<string, unknown>)
            : null;
        const id = value.conversation_id;
        const cwd = init?.cwd;
        if (
          typeof id === "string" &&
          id.trim() &&
          path.basename(id) === id &&
          typeof cwd === "string" &&
          path.isAbsolute(cwd) &&
          path.resolve(cwd) === path.resolve(worker.cwd)
        ) {
          run.nativeSessionId = id;
          identityChanged = true;
        }
      }
    }
    this.recordProgress(handle, run, identityChanged);
  }

  private recordProgress(
    handle: RunHandle,
    run: WorkerRun,
    identityChanged: boolean,
  ): void {
    run.progress.steps = handle.progress.steps ? handle.progress.steps : null;
    run.progress.phase = handle.progress.phase;
    run.progress.currentTool = handle.progress.currentTool;
    run.progress.lastEventAt = new Date(this.now()).toISOString();
    if (run.status === "starting") run.status = "running";
    const timestamp = this.now();
    const important =
      identityChanged ||
      TOOL_PROGRESS_PHASES.has(handle.progress.phase ?? "") ||
      handle.progress.phase === "acp_session" ||
      handle.progress.phase === "acp_prompt_result" ||
      handle.progress.phase === "turn_end" ||
      handle.progress.phase === "turn.completed" ||
      handle.progress.phase === "turn.failed" ||
      handle.progress.phase === "final" ||
      handle.progress.phase === "result" ||
      handle.progress.phase === "error";
    if (important || timestamp - handle.lastProgressSave >= 250) {
      handle.lastProgressSave = timestamp;
      this.store.saveRun(run);
      this.emitChanged(run.workerId);
    }
  }

  /** Persists the exact shared ACP generation in the run's existing spec before any session RPC. */
  private recordAcpGeneration(runDirectory: string, generation: AcpGeneration): void {
    const specPath = path.join(runDirectory, "spec.json");
    const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as Record<string, unknown>;
    const acp =
      spec.acp && typeof spec.acp === "object" && !Array.isArray(spec.acp)
        ? (spec.acp as Record<string, unknown>)
        : {};
    spec.acp = { ...acp, generationId: generation.id };
    const temporary = `${specPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(spec), { mode: 0o600 });
    fs.renameSync(temporary, specPath);
  }

  /** Reads a run's persisted generation link; malformed or historical specs have none. */
  private acpGenerationForRun(run: WorkerRun): AcpGeneration | null {
    const worker = this.store.worker(run.workerId);
    if (
      !worker ||
      run.nativeProtocol !== "acp" ||
      (worker.type !== "pi" && worker.type !== "agy")
    )
      return null;
    try {
      const spec = JSON.parse(
        fs.readFileSync(path.join(this.runDirectory(run.workerId, run.id), "spec.json"), "utf8"),
      ) as Record<string, unknown> | null;
      const acp =
        spec?.acp && typeof spec.acp === "object" && !Array.isArray(spec.acp)
          ? (spec.acp as Record<string, unknown>)
          : null;
      const id = acp?.generationId;
      if (
        typeof id !== "string" ||
        !id.startsWith("process-") ||
        path.basename(id) !== id
      )
        return null;
      return {
        id,
        directory: path.join(this.options.dataDirectory, `${worker.type}-acp-guardian`, id),
      };
    } catch {
      return null;
    }
  }

  private readAcpGenerationEvidence(run: WorkerRun): RunEvidence | null {
    const generation = this.acpGenerationForRun(run);
    if (!generation) return null;
    try {
      const finalFile = path.join(generation.directory, "final.json");
      if (fs.lstatSync(finalFile).isSymbolicLink()) return null;
      const value = JSON.parse(fs.readFileSync(finalFile, "utf8")) as Record<string, unknown> | null;
      if (
        !value ||
        value.groupExited !== true ||
        !["exit", "timeout", "cancelled", "disconnect", "error"].includes(String(value.reason))
      )
        return null;
      return value as RunEvidence;
    } catch {
      return null;
    }
  }

  /** True while an occupying run still needs this generation's confirmed guardian evidence. */
  private acpGenerationInUse(generationId: string): boolean {
    for (const run of this.store.activeRuns()) {
      if (!OCCUPYING.includes(run.status)) continue;
      if (this.acpGenerationForRun(run)?.id === generationId) return true;
    }
    return false;
  }

  private readEvidence(runId: string): RunEvidence | null {
    if (this.storeClosed) return null;
    const run = this.store.run(runId);
    if (!run) return null;
    let perRun: RunEvidence | null = null;
    try {
      const value = JSON.parse(
        fs.readFileSync(path.join(this.runDirectory(run.workerId, runId), "final.json"), "utf8"),
      ) as Record<string, unknown> | null;
      if (value && typeof value === "object") {
        if (value.kind === "acp_session" && typeof value.sessionClosed === "boolean")
          perRun = value as AcpSessionEvidence;
        else if (
          (value.kind === undefined || value.kind === "guardian") &&
          typeof value.groupExited === "boolean"
        )
          perRun = value as RunEvidence;
      }
    } catch {
      /* Missing per-run evidence may still be recoverable from its persisted generation. */
    }
    if (perRun?.kind === "acp_session") {
      if (perRun.sessionClosed) return perRun;
      const generation = this.readAcpGenerationEvidence(run);
      return generation
        ? { ...perRun, sessionClosed: true, groupExited: true }
        : perRun;
    }
    if (perRun) return perRun;
    // A service killed during an active turn has no per-run final; its exact generation's
    // confirmed guardian evidence supplies the existing disconnect/interrupted outcome.
    const generation = this.readAcpGenerationEvidence(run);
    if (!generation) return null;
    return {
      kind: "acp_session",
      reason: generation.reason,
      exitCode: generation.exitCode,
      signal: generation.signal,
      startedAt: generation.startedAt ?? run.startedAt,
      finishedAt: generation.finishedAt,
      sessionClosed: true,
      groupExited: true,
      error: generation.error,
    };
  }

  //------------------ TERMINAL STATE ----------------

  /**
   * Applies one terminal outcome. Unknown evidence keeps the slot and leaves the record open so
   * a later guardian exit or verified recovery can settle it.
   */
  private finalizeRun(
    runId: string,
    evidence: RunEvidence | null,
    spawnError: string | null,
  ): void {
    if (this.storeClosed) return;
    const run = this.store.run(runId);
    if (!run || TERMINAL.includes(run.status)) return;
    const worker = this.store.worker(run.workerId);
    if (!worker) return;
    const handle = this.handles.get(runId);
    if (handle?.finalized) return;
    if (handle) handle.finalized = true;
    // A live handle carries the exact expected identity and action for this launch, including
    // explicit null / "new" for a first run. Handle-less recovery passes expectedAction: null so
    // a recovered brand-new ACP session with a persisted sessionId is never misclassified as resume.
    const expectedSessionId = handle ? handle.expectedSessionId : run.nativeSessionId;
    const expectedAction = handle ? handle.expectedAction : null;
    const parsed =
      run.status === "queued"
        ? null
        : this.parseRun(worker, run, expectedSessionId, expectedAction);
    let status: WorkerStatus;
    let error: WorkerFailure | null = null;
    let hold = handle?.holdNotification ?? false;
    if (this.owners.get(worker.ownerId)?.owner.paused) hold = true;
    const evidenceConfirmed = evidence ? isEvidenceConfirmed(evidence) : false;
    if (!evidence) {
      if (spawnError) {
        status = "failed";
        error = new WorkerFailure("GUARDIAN_SPAWN_FAILED", spawnError);
      } else {
        status = "unknown";
        error = new WorkerFailure(
          "EVIDENCE_MISSING",
          "未找到监护进程的最终退出证据，运行状态未知",
        );
      }
    } else if (!evidenceConfirmed) {
      status = "unknown";
      error = new WorkerFailure(
        "STOP_UNCONFIRMED",
        evidence.kind === "acp_session"
          ? "无法确认 ACP 会话已经结束"
          : "无法确认原生进程组已经退出",
      );
    } else if (evidence.reason === "cancelled") {
      status = "cancelled";
      error = new WorkerFailure("CANCELLED", "运行已取消");
    } else if (evidence.reason === "timeout") {
      status = "failed";
      error = new WorkerFailure("TIMEOUT", evidence.error || "运行超过硬超时");
    } else if (evidence.reason === "error") {
      status = "failed";
      error = new WorkerFailure(
        "GUARDIAN_ERROR",
        evidence.error || "监护进程报告执行错误",
      );
    } else if (evidence.reason === "disconnect") {
      if (evidence.exitCode === 0 && parsed?.success) status = "completed";
      else {
        status = "interrupted";
        hold = true;
        error = new WorkerFailure(
          "INTERRUPTED",
          parsed?.error || evidence.error || "插件断开时运行尚未成功完成",
        );
      }
    } else if (evidence.exitCode === 0 && parsed?.success) {
      status = "completed";
    } else {
      status = "failed";
      const code =
        parsed?.errorCode === "PROTOCOL_INVALID" ||
        parsed?.errorCode === "ACP_CONFIG_UNSUPPORTED" ||
        parsed?.errorCode === "PI_TRANSCRIPT_UNCONFIRMED" ||
        parsed?.errorCode === "ACP_TRANSPORT_CLOSED"
          ? parsed.errorCode
          : evidence.exitCode === 0
            ? (parsed?.errorCode ?? "PROTOCOL_INVALID")
            : "NATIVE_FAILED";
      error = new WorkerFailure(
        code,
        parsed?.error ||
          evidence.error ||
          "原生执行器退出码 " + String(evidence.exitCode),
      );
    }
    if (parsed) {
      run.nativeSessionId = parsed.nativeSessionId ?? run.nativeSessionId;
      run.nativeSessionFile = parsed.nativeSessionFile ?? run.nativeSessionFile;
      run.finalText = parsed.finalText;
      run.usage = parsed.usage;
    }
    run.exitCode = evidence?.exitCode ?? run.exitCode;
    if (!handle && (status === "cancelled" || status === "interrupted")) hold = true;
    run.status = status;
    if (status !== "completed" && run.usage)
      run.usage = { ...run.usage, partial: true };
    if (status !== "unknown") run.finishedAt = new Date(this.now()).toISOString();
    run.error =
      error && status !== "completed" ? { code: error.code, message: error.message } : null;
    run.progress.phase = status;
    run.progress.currentTool = null;
    this.store.saveRun(run);
    // Settle a rate-limit cooldown before dispatch can release the next queued item.
    if (worker.type === "agy" && status === "failed")
      this.registerAgyCooldown(
        worker,
        run,
        parsed?.errorCode === AGY_QUOTA_REACHED ? parsed.error : null,
      );
    if (handle) {
      clearTimeout(handle.stopTimer);
      this.handles.delete(runId);
      this.prompts.delete(runId);
      handle.resolveEnded();
    }
    if (status !== "unknown")
      this.notify(worker, run, status, hold);
    this.emitChanged(worker.id);
    if (status !== "unknown") void this.dispatch();
  }

  private parseRun(
    worker: WorkerRecord,
    run: WorkerRun,
    expectedSessionId: string | null,
    expectedAction: "new" | "resume" | null = null,
  ): ReturnType<typeof parseDsh> | null {
    const events = path.join(this.runDirectory(worker.id, run.id), "events.log");
    if (!fs.existsSync(events)) return null;
    try {
      if (run.nativeProtocol === "acp") {
        if (worker.type === "agy") {
          const parsed = parseAgyAcpRun(
            readEventLines(events),
            expectedSessionId,
            worker.cwd,
            { expectedAction: expectedAction ?? undefined },
          );
          return {
            success: parsed.success,
            nativeSessionId: parsed.validatedSessionId,
            nativeSessionFile: null,
            finalText: parsed.finalText,
            usage: parsed.usage,
            error: parsed.error,
            errorCode: parsed.errorCode,
          };
        }
        return parseHistoricalPiAcp(events, expectedSessionId, worker.cwd, {
          sessionsRoot: run.sessionsRoot,
          sessionFile: run.nativeSessionFile,
          transcriptOffset: run.piTranscriptOffset ?? null,
          userHome: this.userHome(),
          expectedAction,
        });
      }
      if (worker.type === "dsh")
        return parseDsh(events, expectedSessionId, worker.cwd, run.sessionsRoot);
      if (worker.type === "codex")
        return parseCodex(events, expectedSessionId, {
          baseline: run.codexUsageBaseline ?? null,
          sessionFile: run.nativeSessionFile,
          sessionsRoot: run.sessionsRoot,
        });
      if (worker.type === "agy")
        return parseAgy(events, expectedSessionId, worker.cwd);
      return parsePi(
        events,
        expectedSessionId,
        worker.cwd,
        run.nativeSessionFile ??
          path.join(run.sessionsRoot, run.id + ".jsonl"),
      );
    } catch {
      return null;
    }
  }

  private finishAdmissionFailure(run: WorkerRun, failure: unknown): void {
    const current = this.store.run(run.id);
    if (!current || TERMINAL.includes(current.status)) return;
    const message = failure instanceof Error ? failure.message : String(failure);
    const code = failure instanceof WorkerFailure ? failure.code : "WORKSPACE_FAILED";
    current.status = "failed";
    current.finishedAt = new Date(this.now()).toISOString();
    current.error = { code, message };
    current.progress.phase = "failed";
    this.store.saveRun(current);
    const worker = this.store.worker(current.workerId);
    if (worker) {
      this.notify(worker, current, "failed", false);
      this.emitChanged(worker.id);
    }
    this.prompts.delete(current.id);
    void this.dispatch();
  }

  private notify(
    worker: WorkerRecord,
    run: WorkerRun,
    status: WorkerNotification["status"],
    hold: boolean,
    reminderSummary?: string,
  ): void {
    const notifications = this.store.notifications().filter((item) => item.runId === run.id);
    const reminder = status === "running";
    // Timed reviews may repeat; each run still has only one terminal result.
    if (!reminder && notifications.some((item) => item.status !== "running")) return;
    // A result supersedes a reminder still waiting behind the parent's user queue.
    // Keep its history, but only the result should automatically wake that parent.
    if (!reminder) for (const item of notifications) {
      if (item.status !== "running" || item.delivery !== "pending") continue;
      item.delivery = "held";
      this.store.updateNotification(item);
    }
    const summary = reminderSummary ?? (
      runTaskName(worker, run) +
      " " +
      status +
      (run.finalText
        ? ": " + run.finalText.replace(/\s+/g, " ").slice(0, 240)
        : run.error
          ? ": " + run.error.message
          : ""));
    const notification: WorkerNotification = {
      id: randomUUID(),
      ownerId: worker.ownerId,
      workerId: worker.id,
      runId: run.id,
      summary,
      status,
      createdAt: new Date(this.now()).toISOString(),
      delivery: hold ? "held" : "pending",
      batchId: null,
    };
    this.store.saveNotification(notification);
    this.emitNotification(notification);
  }

  //------------------ QUERIES ----------------

  state(query: WorkerStateQuery = {}): WorkerStateSnapshot {
    const workers = this.store
      .workers(query)
      .filter((worker) => worker.type !== "dsh");
    const counts = {
      dsh: Object.fromEntries(STATUSES.map((status) => [status, 0])),
      pi: Object.fromEntries(STATUSES.map((status) => [status, 0])),
      codex: Object.fromEntries(STATUSES.map((status) => [status, 0])),
      agy: Object.fromEntries(STATUSES.map((status) => [status, 0])),
      total: Object.fromEntries(STATUSES.map((status) => [status, 0])),
    } as WorkerStateSnapshot["counts"];
    for (const worker of workers) {
      const status = worker.latestRun?.status;
      if (!status) continue;
      (counts[worker.type] as Record<WorkerStatus, number>)[status]++;
      counts.total[status]++;
    }
    const ids = new Set(workers.map((worker) => worker.id));
    const notifications =
      query.projectId || query.parentSessionId
        ? this.store.notifications().filter((item) => ids.has(item.workerId))
        : this.store.notifications();
    return {
      workers,
      counts,
      settings: this.store.settings(),
      configUsage: this.store.configUsage(),
      notifications,
    };
  }

  /**
   * Active overview: occupied and queued workers plus the first page of terminal history and
   * notifications. Terminal workers move out of `workers` so callers never have to filter the
   * two lists themselves.
   */
  overview(query: WorkerStateQuery = {}): WorkerOverviewSnapshot {
    const workers = this.store.activeWorkers(query);
    return {
      workers,
      settings: this.store.settings(),
      configUsage: this.store.configUsage(),
      agyCooldownUntil: this.agyCooldownUntil(),
      finished: this.finishedHistory(query),
      notifications: this.notificationHistory(query),
    };
  }

  /** Minimal activity rows used by the existing UI; `queued` stays visible for client checks. */
  activity(query: WorkerStateQuery = {}): WorkerActivitySnapshot {
    const workers = this.store.activeWorkers(query).map((worker) => ({
      id: worker.id,
      projectId: worker.projectId,
      parentSessionId: worker.parentSessionId,
      latestRun: { status: worker.latestRun!.status },
    }));
    return { workers };
  }

  /** One history page; cursors are opaque and pages hold at most 20 items. */
  history(
    query: WorkerHistoryQuery,
  ): WorkerHistoryPage<WorkerRecord | WorkerHistoryNotification> {
    const cursor = this.decodeCursor(query.cursor);
    if (query.kind === "finished") {
      const page = this.store.finishedPage(query, cursor, 20);
      const last = page.items[page.items.length - 1];
      return {
        items: page.items,
        nextCursor:
          page.hasMore && last
            ? this.encodeCursor(
                last.latestRun?.finishedAt ?? last.createdAt ?? "",
                last.id,
              )
            : null,
      };
    }
    if (query.kind === "notifications") {
      const page = this.store.notificationsPage(query, cursor, 20);
      const last = page.items[page.items.length - 1];
      return {
        items: page.items,
        nextCursor:
          page.hasMore && last
            ? this.encodeCursor(last.createdAt ?? "", last.id)
            : null,
      };
    }
    throw new WorkerFailure(
      "INVALID_INPUT",
      "kind 必须是 finished 或 notifications",
    );
  }

  private finishedHistory(
    query: WorkerStateQuery,
  ): WorkerHistoryPage<WorkerRecord> {
    return this.history({ ...query, kind: "finished" }) as WorkerHistoryPage<WorkerRecord>;
  }

  private notificationHistory(
    query: WorkerStateQuery,
  ): WorkerHistoryPage<WorkerHistoryNotification> {
    return this.history({
      ...query,
      kind: "notifications",
    }) as WorkerHistoryPage<WorkerHistoryNotification>;
  }

  private decodeCursor(cursor?: string): WorkerHistoryCursor | null {
    if (!cursor) return null;
    try {
      const value = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      ) as { t?: unknown; i?: unknown };
      if (typeof value.t === "string" && value.t && typeof value.i === "string" && value.i)
        return { time: value.t, id: value.i };
    } catch {
      /* fall through to the validation failure */
    }
    throw new WorkerFailure("INVALID_CURSOR", "cursor 无效");
  }

  private encodeCursor(time: string, id: string): string {
    return Buffer.from(JSON.stringify({ t: time, i: id })).toString("base64url");
  }

  //------------------ AGY COOLDOWN ----------------

  /** Active global agy cooldown as an ISO deadline, or null when new agy starts may proceed. */
  agyCooldownUntil(): string | null {
    const until = this.store.cooldown("agy");
    return until !== null && until > this.now()
      ? new Date(until).toISOString()
      : null;
  }

  private agyCooldownActive(): boolean {
    return this.agyCooldownUntil() !== null;
  }

  /** Wakes dispatch exactly when the stored deadline expires so queued agy runs resume. */
  private scheduleAgyWake(): void {
    if (this.closing || this.storeClosed) return;
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    const until = this.store.cooldown("agy");
    if (until === null || until <= this.now()) return;
    const timer = setTimeout(() => {
      this.cooldownTimer = null;
      if (!this.closing && !this.storeClosed) void this.dispatch();
    }, until - this.now());
    timer.unref?.();
    this.cooldownTimer = timer;
  }

  /**
   * Detects the two agy rate-limit shapes in the failed run's own logs and extends the global
   * SQLite deadline. The run itself stays failed and resumable; the stored maximum survives
   * restarts and is shared by every CloudCLI instance using this data directory.
   */
  private registerAgyCooldown(
    worker: WorkerRecord,
    run: WorkerRun,
    classifiedQuotaText: string | null = null,
  ): void {
    const text = classifiedQuotaText ?? this.agyFailureText(worker, run);
    if (classifiedQuotaText === null && !agyRateLimited(text)) return;
    const delay = agyResetDelay(text) ?? 60_000;
    this.store.setCooldown("agy", this.now() + delay);
    this.scheduleAgyWake();
    this.emitChanged(worker.id);
  }

  private agyFailureText(worker: WorkerRecord, run: WorkerRun): string {
    const directory = this.runDirectory(worker.id, run.id);
    let text = "";
    for (const name of ["stderr.log", "events.log", "final.json"]) {
      try {
        text += "\n" + fs.readFileSync(path.join(directory, name), "utf8").slice(-200_000);
      } catch {
        /* a missing stream is not rate-limit evidence */
      }
    }
    return text;
  }

  get(workerId: string, ownerId?: string): { worker: WorkerRecord; runs: WorkerRun[] } {
    const worker = this.ownedWorker(ownerId, workerId);
    return { worker, runs: this.store.runs(worker.id) };
  }

  // The inferred return type stays the single description of this shape: the MCP boundary
  // projects it without declaring a second public contract.
  context(ownerId: string) {
    const owner = this.requireOwner(ownerId);
    const snapshot = this.state({
      projectId: owner.projectId,
      parentSessionId: owner.parentSessionId,
    });
    return {
      owner,
      plan: this.store.plan(owner.parentSessionId, owner.projectId),
      // MCP context is model-visible; configs are projected without Codex env/extra args.
      settings: this.mcpSettings(snapshot.settings),
      counts: snapshot.counts,
      activeWorkers: snapshot.workers.filter((worker) =>
        worker.latestRun ? OCCUPYING.includes(worker.latestRun.status) : false,
      ),
      notifications: snapshot.notifications,
    };
  }

  /** Credential-free settings view: Codex configs expose only the selected service. */
  private mcpSettings(settings: WorkerSettings): WorkerMcpSettings {
    return {
      configs: settings.configs.map((config) => ({
        id: config.id,
        name: config.name,
        type: config.type,
        enabled: config.enabled,
        roles: [...config.roles],
        concurrency: config.concurrency,
        hardTimeoutSeconds: config.hardTimeoutSeconds,
        model: config.model,
        effort: config.effort,
        ...(config.type === "codex"
          ? { codex: { modelProvider: config.codex?.modelProvider ?? null } }
          : {}),
      })),
      defaultConfigId: settings.defaultConfigId,
      defaultWorkerType: settings.defaultWorkerType,
      enabled: settings.enabled,
      roles: settings.roles,
      concurrency: settings.concurrency,
      defaults: settings.defaults,
      retentionDays: settings.retentionDays,
      softReminderSeconds: settings.softReminderSeconds,
      softReminderSteps: settings.softReminderSteps,
      hardTimeoutSeconds: settings.hardTimeoutSeconds,
    };
  }

  /** Saves Markdown validated by the MCP boundary; ownership comes from the authenticated caller. */
  savePlan(ownerId: string, content: string): WorkerPlan {
    const owner = this.requireOwner(ownerId);
    const plan: WorkerPlan = { content, updatedAt: new Date(this.now()).toISOString() };
    this.store.savePlan(owner.parentSessionId, owner.projectId, plan);
    return plan;
  }

  notificationsForWorker(
    workerId: string,
    ownerId: string,
  ): WorkerNotification[] {
    const worker = this.ownedWorker(ownerId, workerId);
    return this.store
      .notifications()
      .filter((item) => item.workerId === worker.id);
  }

  notificationsForScope(ownerId: string): WorkerNotification[] {
    const owner = this.requireOwner(ownerId);
    return this.store.notifications().filter((item) => {
      const worker = this.store.worker(item.workerId);
      return (
        worker !== null &&
        worker.parentSessionId === owner.parentSessionId &&
        worker.projectId === owner.projectId
      );
    });
  }

  logs(workerId: string, query: WorkerLogQuery, ownerId?: string) {
    const worker = this.ownedWorker(ownerId, workerId);
    if (query.stream !== "events" && query.stream !== "stderr")
      throw new WorkerFailure("INVALID_STREAM", "stream 必须是 events 或 stderr");
    const run = query.runId
      ? this.store.run(query.runId)
      : this.store.latestRun(worker.id);
    if (!run || run.workerId !== worker.id)
      throw new WorkerFailure("RUN_NOT_FOUND", "运行记录不存在");
    return readLogPage(this.runDirectory(worker.id, run.id), query.stream, {
      cursor: query.cursor,
      before: query.before,
      limit: query.limit,
      done: TERMINAL.includes(run.status),
      tail: query.tail === true,
    });
  }

  /**
   * The prompt one run was launched with. `prompt.md` in the run directory is the durable
   * record; a run that is still queued has not written it yet and falls back to the accepted
   * prompt held in memory. No record means null, never the task name or a current config value.
   */
  input(workerId: string, query: WorkerRunQuery, ownerId?: string): WorkerRunInput {
    const worker = this.ownedWorker(ownerId, workerId);
    const run = query.runId
      ? this.store.run(query.runId)
      : this.store.latestRun(worker.id);
    if (!run || run.workerId !== worker.id)
      throw new WorkerFailure("RUN_NOT_FOUND", "运行记录不存在");
    const file = path.join(this.runDirectory(worker.id, run.id), "prompt.md");
    if (fs.existsSync(file)) return { prompt: fs.readFileSync(file, "utf8") };
    return { prompt: this.prompts.get(run.id) ?? null };
  }

  async wait(
    workerId: string,
    timeoutSeconds: number,
    ownerId?: string,
  ): Promise<{ worker: WorkerRecord; run: WorkerRun }> {
    const worker = this.ownedWorker(ownerId, workerId);
    const deadline =
      this.now() + Math.min(MAX_WAIT_MS, Math.max(1, timeoutSeconds) * 1000);
    for (;;) {
      const current = this.store.worker(worker.id);
      const run = this.store.latestRun(worker.id);
      if (!current || !run)
        throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
      if (TERMINAL.includes(run.status) || this.now() >= deadline)
        return { worker: current, run };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  //------------------ CANCEL, PAUSE, RECOVER, CLEANUP ----------------

  async cancel(
    input: WorkerCancelInput,
    source: "ui" | "host" = "ui",
    scopeOwnerId?: string,
  ): Promise<string[]> {
    if (!input || typeof input !== "object")
      throw new WorkerFailure("INVALID_INPUT", "取消请求无效");
    const workers = this.cancelTargets(input, scopeOwnerId);
    if (input.pause) {
      const ownerIds = new Set(workers.map((worker) => worker.ownerId));
      for (const candidate of this.store.owners()) {
        if (scopeOwnerId && candidate.id !== scopeOwnerId) continue;
        if (input.parentSessionId && candidate.parentSessionId !== input.parentSessionId)
          continue;
        if (input.projectId && candidate.projectId !== input.projectId) continue;
        if (
          !input.parentSessionId &&
          !input.projectId &&
          scopeOwnerId === undefined
        )
          continue;
        ownerIds.add(candidate.id);
      }
      if (scopeOwnerId) ownerIds.add(scopeOwnerId);
      for (const ownerId of ownerIds)
        this.setPaused(ownerId, true, "取消并暂停新任务");
    }
    const ids: string[] = [];
    const hold = source === "host" || input.pause === true;
    const stops: Promise<void>[] = [];
    let unconfirmed = false;
    for (const worker of workers) {
      const run = this.store.latestRun(worker.id);
      if (!run || TERMINAL.includes(run.status)) continue;
      ids.push(worker.id);
      if (run.status === "queued") {
        this.finalizeQueued(run, hold);
        continue;
      }
      const handle = this.handles.get(run.id);
      if (!handle) {
        // No live guardian (for example after a restart): cancellation cannot confirm exit.
        run.status = "unknown";
        run.error = {
          code: "STOP_UNCONFIRMED",
          message: "没有可用的监护进程证据，无法确认停止",
        };
        this.store.saveRun(run);
        this.emitChanged(worker.id);
        unconfirmed = true;
        continue;
      }
      handle.holdNotification = hold || handle.holdNotification;
      handle.stopRequested = true;
      run.status = "stopping";
      run.progress.phase = "stopping";
      this.store.saveRun(run);
      this.emitChanged(worker.id);
      handle.requestStop("cancelled");
      stops.push(
        (async () => {
          const settled = await this.settleHandle(handle);
          const current = this.store.run(run.id);
          if (!settled) {
            if (current && !TERMINAL.includes(current.status)) {
              current.status = "unknown";
              current.error = {
                code: "STOP_UNCONFIRMED",
                message: "取消请求已发出，但未确认进程组退出",
              };
              this.store.saveRun(current);
              this.emitChanged(worker.id);
            }
            unconfirmed = true;
            return;
          }
          if (!current || !TERMINAL.includes(current.status)) unconfirmed = true;
        })(),
      );
    }
    await Promise.all(stops);
    if (unconfirmed)
      throw new WorkerFailure(
        "STOP_UNCONFIRMED",
        "至少一个原生进程组尚未确认停止",
      );
    return [...new Set(ids)];
  }

  private cancelTargets(
    input: WorkerCancelInput,
    scopeOwnerId?: string,
  ): WorkerRecord[] {
    const owner = scopeOwnerId
      ? this.owners.get(scopeOwnerId)?.owner ?? this.store.owner(scopeOwnerId)
      : null;
    const inAuthenticatedScope = (worker: WorkerRecord) =>
      !scopeOwnerId ||
      (worker.ownerId === scopeOwnerId &&
        (owner === null ||
          (worker.parentSessionId === owner.parentSessionId &&
            worker.projectId === owner.projectId)));
    const matches = (worker: WorkerRecord) =>
      inAuthenticatedScope(worker) &&
      (!input.projectId || worker.projectId === input.projectId) &&
      (!input.parentSessionId ||
        worker.parentSessionId === input.parentSessionId);
    const workers = this.store.workers().filter((worker) => worker.type !== "dsh");
    if (input.all) return workers.filter(matches);
    if (input.workerIds !== undefined) {
      if (!Array.isArray(input.workerIds) || input.workerIds.some((id) => typeof id !== "string"))
        throw new WorkerFailure("INVALID_INPUT", "workerIds 必须是字符串数组");
      const wanted = new Set(input.workerIds);
      return workers.filter((worker) => wanted.has(worker.id) && matches(worker));
    }
    if (input.projectId === undefined && input.parentSessionId === undefined)
      throw new WorkerFailure(
        "INVALID_CANCEL",
        "取消必须指定 workerIds、all、parentSessionId 或 projectId",
      );
    return workers.filter(matches);
  }

  private finalizeQueued(
    run: WorkerRun,
    hold: boolean,
    reason: { code: string; message: string } = {
      code: "CANCELLED",
      message: "排队中的运行已取消",
    },
  ): void {
    const worker = this.store.worker(run.workerId);
    run.status = "cancelled";
    run.finishedAt = new Date(this.now()).toISOString();
    run.error = { ...reason };
    run.progress.phase = "cancelled";
    this.store.saveRun(run);
    this.prompts.delete(run.id);
    const queuedHandle = this.handles.get(run.id);
    this.handles.delete(run.id);
    queuedHandle?.resolveEnded();
    if (worker) {
      this.notify(worker, run, "cancelled", hold);
      this.emitChanged(worker.id);
    }
  }

  private setPaused(ownerId: string, paused: boolean, reason?: string): void {
    const stored = this.store.owner(ownerId);
    const registered = this.owners.get(ownerId);
    const owner = registered?.owner ?? stored;
    if (!owner) return;
    const value: WorkerOwner = {
      ...owner,
      paused,
      pausedReason: paused ? reason ?? owner.pausedReason : undefined,
    };
    this.store.saveOwner(value);
    if (registered) registered.owner = value;
    if (paused) this.holdPendingNotifications(ownerId);
  }

  private holdPendingNotifications(ownerId: string): void {
    for (const notification of this.store.notifications(ownerId)) {
      if (notification.delivery !== "pending") continue;
      notification.delivery = "held";
      this.store.updateNotification(notification);
      this.emitNotification(notification);
    }
  }

  async setOwnerPaused(
    ownerId: string,
    paused: boolean,
    reason?: string,
  ): Promise<{ confirmed: true }> {
    if (!this.owners.has(ownerId) && !this.store.owner(ownerId))
      throw new WorkerFailure("OWNER_NOT_FOUND", "owner 未注册");
    this.setPaused(ownerId, paused, reason);
    if (paused) {
      const workers = this.store.workers().filter((worker) => worker.ownerId === ownerId);
      const stops: Promise<void>[] = [];
      for (const worker of workers) {
        if (worker.type === "dsh") continue;
        const run = this.store.latestRun(worker.id);
        if (!run || TERMINAL.includes(run.status)) continue;
        if (run.status === "queued") {
          this.finalizeQueued(run, true);
          continue;
        }
        stops.push(this.stopForHost(worker.id, run));
      }
      const outcomes = await Promise.allSettled(stops);
      const failed = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (failed) throw failed.reason;
    } else {
      void this.dispatch();
    }
    return { confirmed: true };
  }

  private settleHandle(handle: RunHandle): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 12_500);
      void handle.ended.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async stopForHost(workerId: string, run: WorkerRun): Promise<void> {
    const handle = this.handles.get(run.id);
    if (!handle) {
      run.status = "unknown";
      run.error = {
        code: "STOP_UNCONFIRMED",
        message: "没有可用的监护进程证据，无法确认停止",
      };
      this.store.saveRun(run);
      this.emitChanged(workerId);
      throw new WorkerFailure(
        "STOP_UNCONFIRMED",
        "没有可用的监护进程证据，无法确认停止",
      );
    }
    handle.holdNotification = true;
    handle.stopRequested = true;
    run.status = "stopping";
    run.progress.phase = "stopping";
    this.store.saveRun(run);
    this.emitChanged(workerId);
    handle.requestStop("cancelled");
    const settled = await this.settleHandle(handle);
    if (!settled) {
      const current = this.store.run(run.id);
      if (current && !TERMINAL.includes(current.status)) {
        current.status = "unknown";
        current.error = {
          code: "STOP_UNCONFIRMED",
          message: "停止请求已发出，但未确认进程组退出",
        };
        this.store.saveRun(current);
        this.emitChanged(workerId);
      }
      throw new WorkerFailure(
        "STOP_UNCONFIRMED",
        "停止请求已发出，但未确认进程组退出",
      );
    }
    const current = this.store.run(run.id);
    if (!current || !TERMINAL.includes(current.status))
      throw new WorkerFailure(
        "STOP_UNCONFIRMED",
        "监护进程已退出，但运行结果仍为未知",
      );
  }

  async closeInstance(
    appServerInstanceId: string,
    reason: string,
  ): Promise<{ workerIds: string[] }> {
    const owners = this.store
      .owners()
      .filter((owner) => owner.appServerInstanceId === appServerInstanceId);
    for (const owner of owners) this.setPaused(owner.id, true, reason);
    // Authority is gone synchronously even if process cleanup later fails.
    for (const owner of owners) this.retireOwner(owner.id);
    return {
      workerIds: await this.cancelOwners(
        owners.map((owner) => owner.id),
        reason,
      ),
    };
  }

  async closeAll(reason: string): Promise<{ workerIds: string[] }> {
    const ids = new Set(this.store.owners().map((owner) => owner.id));
    for (const worker of this.store.workers()) ids.add(worker.ownerId);
    for (const id of ids) this.setPaused(id, true, reason);
    for (const id of [...this.owners.keys()]) this.retireOwner(id);
    return { workerIds: await this.cancelOwners([...ids], reason) };
  }

  private async cancelOwners(ownerIds: string[], reason: string): Promise<string[]> {
    const ids: string[] = [];
    const stops: Promise<void>[] = [];
    for (const ownerId of ownerIds) {
      const workers = this.store
        .workers()
        .filter((worker) => worker.ownerId === ownerId);
      for (const worker of workers) {
        if (worker.type === "dsh") continue;
        const run = this.store.latestRun(worker.id);
        if (!run || TERMINAL.includes(run.status)) continue;
        // Shutdown and instance retirement leave an unstarted agy run for its cooldown.
        if (run.status === "queued" && worker.type === "agy") continue;
        ids.push(worker.id);
        if (run.status === "queued") this.finalizeQueued(run, true);
        else stops.push(this.stopForHost(worker.id, run));
      }
    }
    void reason;
    const outcomes = await Promise.allSettled(stops);
    if (outcomes.some((outcome) => outcome.status === "rejected"))
      throw new WorkerFailure(
        "STOP_UNCONFIRMED",
        "至少一个原生进程组尚未确认停止",
      );
    return [...new Set(ids)];
  }

  recover(input: WorkerRecoverInput): WorkerRecord {
    this.validateRecover(input);
    const worker = this.store.worker(input.workerId);
    if (!worker) throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
    const run = this.store.latestRun(worker.id);
    if (!run) throw new WorkerFailure("RUN_NOT_FOUND", "worker 尚无运行记录");
    if (run.status !== "unknown")
      throw new WorkerFailure("RECOVER_NOT_ALLOWED", "只有 unknown 运行可以人工恢复");
    if (this.handles.has(run.id))
      throw new WorkerFailure("PROCESS_ALIVE", "监护进程尚未确认退出，不能恢复");
    run.status = "interrupted";
    run.finishedAt = new Date(this.now()).toISOString();
    run.error = {
      code: "RECOVERED",
      message: input.notes.trim().slice(0, 2000),
    };
    run.progress.phase = "interrupted";
    this.store.saveRun(run);
    this.notify(worker, run, "interrupted", true);
    this.emitChanged(worker.id);
    void this.dispatch();
    return this.store.worker(worker.id)!;
  }

  private validateRecover(input: WorkerRecoverInput): void {
    if (!input || typeof input !== "object")
      throw new WorkerFailure("INVALID_INPUT", "恢复请求无效");
    if (typeof input.workerId !== "string" || !input.workerId.trim())
      throw new WorkerFailure("INVALID_INPUT", "workerId 不能为空");
    if (typeof input.notes !== "string" || !input.notes.trim())
      throw new WorkerFailure("INVALID_INPUT", "notes 不能为空");
    if (input.confirmedStopped !== true)
      throw new WorkerFailure("NOT_CONFIRMED", "必须确认原生会话已停止");
  }

  async cleanup(input: WorkerCleanupInput): Promise<WorkerRecord> {
    if (!input || typeof input.workerId !== "string" || !input.workerId.trim())
      throw new WorkerFailure("INVALID_INPUT", "workerId 不能为空");
    const worker = this.store.worker(input.workerId);
    if (!worker) throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
    const run = this.store.latestRun(worker.id);
    if (run && !TERMINAL.includes(run.status))
      throw new WorkerFailure("ACTIVE_RUN", "worker 尚未停止，不能清理");
    if (this.store.workerCleanedAt(worker.id))
      throw new WorkerFailure("ALREADY_CLEANED", "worktree 已清理");
    const target = realPath(worker.cwd);
    for (const other of this.store.workers()) {
      if (other.type === "dsh") continue;
      if (other.id === worker.id || realPath(other.cwd) !== target) continue;
      const otherRun = this.store.latestRun(other.id);
      if (
        otherRun &&
        ACTIVE_REFERENCES.includes(otherRun.status)
      )
        throw new WorkerFailure(
          "WORKSPACE_IN_USE",
          "同一工作目录仍有活动 worker，拒绝清理",
        );
    }
    await this.workspace.cleanup(worker);
    this.store.markCleaned(worker.id);
    this.emitChanged(worker.id);
    return this.store.worker(worker.id)!;
  }

  //------------------ NOTIFICATIONS ----------------

  /** Keepalive/close policy consults only this exact runtime owner, never another parent's work. */
  hasActiveWorkers(ownerId: string): boolean {
    const owner = this.requireOwner(ownerId);
    return this.store
      .workers({ projectId: owner.projectId, parentSessionId: owner.parentSessionId })
      .filter((worker) => worker.type !== "dsh")
      .some((worker) => worker.ownerId === ownerId
        && Boolean(worker.latestRun && ACTIVE_REFERENCES.includes(worker.latestRun.status)));
  }

  notifications(ownerId?: string): WorkerNotification[] {
    return this.store.notifications(ownerId);
  }

  claimNotifications(
    ownerId: string,
    eventIds: string[],
    batchId: string,
  ): { batchId: string; notifications: WorkerNotification[] } {
    if (typeof ownerId !== "string" || !ownerId)
      throw new WorkerFailure("INVALID_OWNER", "ownerId 不能为空");
    const registered = this.owners.get(ownerId);
    if (!registered)
      throw new WorkerFailure("OWNER_NOT_LIVE", "owner 不在当前宿主进程");
    if (registered.owner.paused)
      throw new WorkerFailure("OWNER_PAUSED", "owner 已暂停，不能领取通知");
    if (typeof batchId !== "string" || !batchId.trim())
      throw new WorkerFailure("INVALID_BATCH", "batchId 不能为空");
    if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== "string"))
      throw new WorkerFailure("INVALID_INPUT", "eventIds 必须是字符串数组");
    return {
      batchId,
      notifications: this.store.claimNotifications(ownerId, eventIds, batchId),
    };
  }

  settleNotifications(
    batchId: string,
    delivery: WorkerNotificationDelivery,
  ): { settled: true } {
    if (!["delivered", "pending", "held", "unknown"].includes(delivery))
      throw new WorkerFailure("INVALID_DELIVERY", "delivery 值无效");
    this.store.settleBatch(batchId, delivery);
    return { settled: true };
  }

  ack(ownerId: string, eventIds: string[]): { acknowledged: number } {
    if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== "string"))
      throw new WorkerFailure("INVALID_INPUT", "eventIds 必须是字符串数组");
    let acknowledged = 0;
    const owner = this.owners.get(ownerId)?.owner ?? this.store.owner(ownerId);
    for (const id of eventIds) {
      const item = this.store.notification(id);
      if (!item) continue;
      const worker = this.store.worker(item.workerId);
      const allowed =
        item.ownerId === ownerId ||
        (owner !== null && worker !== null && this.inScope(worker, ownerId, owner));
      if (!allowed) continue;
      item.delivery = "delivered";
      this.store.updateNotification(item);
      acknowledged++;
    }
    return { acknowledged };
  }

  retryNotifications(eventIds: string[]): { retried: number } {
    if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== "string"))
      throw new WorkerFailure("INVALID_INPUT", "eventIds 必须是字符串数组");
    let retried = 0;
    for (const id of eventIds) {
      const notification = this.store.notification(id);
      if (!notification) continue;
      const worker = this.store.worker(notification.workerId);
      // Explicit retry may move a historical event to the live generation of the same scope.
      const live = worker ? this.liveOwnerForWorker(worker) : null;
      if (live) notification.ownerId = live.id;
      notification.delivery = "pending";
      notification.batchId = null;
      this.store.updateNotification(notification);
      this.emitNotification(notification);
      retried++;
    }
    return { retried };
  }

  //------------------ RECOVERY, SHUTDOWN, EVENTS ----------------

  /** Restores persisted records without ever re-running an old task. */
  recoverFromDisk(): void {
    this.recovering = true;
    try {
      for (const run of this.store.activeRuns()) {
        const activeWorker = this.store.worker(run.workerId);
        // Retired DSH rows are never recovered, finalized, or rewritten.
        if (!activeWorker || activeWorker.type === "dsh") continue;
        if (run.status === "queued") {
          // An unstarted agy run waits for its persisted cooldown instead of being cancelled.
          if (activeWorker.type === "agy") continue;
          this.finalizeQueued(run, true);
          continue;
        }
        const evidence = this.readEvidence(run.id);
        if (evidence) {
          this.finalizeRun(run.id, evidence, null);
          continue;
        }
        const worker = activeWorker;
        // Recovery always re-reads statistics, even when the native identity is already known.
        const parsed = this.parseRun(worker, run, run.nativeSessionId);
        run.nativeSessionId = parsed?.nativeSessionId ?? run.nativeSessionId;
        run.nativeSessionFile = parsed?.nativeSessionFile ?? run.nativeSessionFile;
        if (parsed?.usage) run.usage = parsed.usage;
        if (run.usage) run.usage = { ...run.usage, partial: true };
        run.status = "unknown";
        run.error = {
          code: "RESTART_UNKNOWN",
          message: "插件重启且没有可核实的进程退出证据",
        };
        run.progress.phase = "unknown";
        this.store.saveRun(run);
        this.emitChanged(worker.id);
      }
      // Historical pending/claimed events for a paused owner stay held across restart.
      for (const owner of this.store.owners())
        if (owner.paused) this.holdPendingNotifications(owner.id);
    } finally {
      this.recovering = false;
    }
    this.pruneHistory();
    this.startNativeSessionCleanup();
    // A persisted agy queue may become runnable immediately when its deadline already passed.
    void this.dispatch();
  }

  /** Starts one immediate sweep and a per-instance 24-hour timer, once per service. */
  private startNativeSessionCleanup(): void {
    if (this.closing || this.storeClosed || this.nativeRetentionTimer) return;
    this.nativeRetentionTimer = setInterval(
      () => void this.runNativeSessionCleanup(),
      24 * 60 * 60 * 1000,
    );
    this.nativeRetentionTimer.unref?.();
    void this.runNativeSessionCleanup();
  }

  private runNativeSessionCleanup(): Promise<void> {
    if (this.closing || this.storeClosed) return Promise.resolve();
    if (this.nativeRetentionSweep) return this.nativeRetentionSweep;
    const sweep = (async () => {
      // Yield once so a concurrent trigger observes the in-flight sweep.
      await Promise.resolve();
      try {
        sweepNativeSessions({
          dataDirectory: this.options.dataDirectory,
          environment: this.environment,
          now: this.now(),
          activeRuns: this.store.activeRuns().flatMap((run) => {
            const worker = this.store.worker(run.workerId);
            return worker
              ? [{
                  type: worker.type,
                  sessionsRoot: run.sessionsRoot,
                  nativeSessionId: run.nativeSessionId,
                  nativeSessionFile: run.nativeSessionFile,
                }]
              : [];
          }),
          log: (message) => this.logNativeSessionCleanup(message),
        });
      } catch (error) {
        this.logNativeSessionCleanup(
          "native session cleanup failed: " + String(error),
        );
      } finally {
        this.nativeRetentionSweep = null;
      }
    })();
    this.nativeRetentionSweep = sweep;
    return sweep;
  }

  private logNativeSessionCleanup(message: string): void {
    process.stderr.write("worker " + message + "\n");
  }

  private pruneHistory(): void {
    try {
      const cutoff = this.now() - this.store.settings().retentionDays * 86_400_000;
      for (const run of this.store.expiredRuns(cutoff)) {
        const worker = this.store.worker(run.workerId)!;
        const directory = this.runDirectory(worker.id, run.id);
        fs.rmSync(directory, { recursive: true, force: true });
        this.store.deleteRun(run);
        if (!this.store.worker(worker.id))
          fs.rmSync(path.dirname(directory), { recursive: true, force: true });
        this.send({
          channel: "cloudcli-workers",
          kind: "event",
          event: "changed",
          value: { ownerId: worker.ownerId, workerIds: [worker.id] },
        });
      }
      this.pruneAcpGuardianDirectories(cutoff);
    } catch (error) {
      // Keep failed deletions eligible for the next sweep without breaking the plugin timer/API.
      process.stderr.write("worker history cleanup failed: " + String(error) + "\n");
    }
  }

  /**
   * Cleans up leftover shared ACP guardian directories whose own final.json confirms
   * `groupExited === true` and `finishedAt <= cutoff`. Live or unconfirmed directories stay intact.
   */
  private pruneAcpGuardianDirectories(cutoff: number): void {
    for (const engine of ["pi", "agy"] as const) {
      const root = path.join(this.options.dataDirectory, `${engine}-acp-guardian`);
      let entries: fs.Dirent[];
      try {
        if (fs.lstatSync(root).isSymbolicLink()) continue;
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
        if (!entry.name.startsWith("process-")) continue;
        if (this.acpGenerationInUse(entry.name)) continue;
        const directory = path.join(root, entry.name);
        const finalFile = path.join(directory, "final.json");
        try {
          if (fs.lstatSync(finalFile).isSymbolicLink()) continue;
          const evidence = JSON.parse(fs.readFileSync(finalFile, "utf8")) as {
            groupExited?: unknown;
            finishedAt?: unknown;
          };
          if (evidence.groupExited !== true) continue;
          if (typeof evidence.finishedAt !== "string") continue;
          const finishedAt = Date.parse(evidence.finishedAt);
          if (!Number.isFinite(finishedAt) || finishedAt > cutoff) continue;
          fs.rmSync(directory, { recursive: true, force: true });
        } catch {
          /* missing, unreadable, or unconfirmed evidence keeps the directory intact */
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    clearInterval(this.reminderTimer);
    clearInterval(this.retentionTimer);
    if (this.nativeRetentionTimer) {
      clearInterval(this.nativeRetentionTimer);
      this.nativeRetentionTimer = null;
    }
    let failure: unknown;
    try {
      await this.nativeRetentionSweep;
      const stopPromise = this.closeAll("插件进程退出");
      const acp = this.agyAcpProcess;
      if (acp?.isActive) {
        // Let cooperative ACP sessions finish targeted cancel briefly; then reap each shared
        // process group so even a cancel-resistant turn/grandchild cannot hang shutdown.
        await Promise.race([
          stopPromise.then(
            () => undefined,
            () => undefined,
          ),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
        if (!(await acp.close())) {
          failure = new WorkerFailure("STOP_UNCONFIRMED", "ACP 进程组尚未确认退出");
        }
      }
      await stopPromise;
      if (acp && !(await acp.close()) && !failure) {
        failure = new WorkerFailure("STOP_UNCONFIRMED", "ACP 进程组尚未确认退出");
      }
    } catch (error) {
      failure = error;
      await this.agyAcpProcess?.close().catch(() => false);
    } finally {
      this.storeClosed = true;
      this.store.close();
    }
    if (failure)
      process.stderr.write(
        "worker shutdown cleanup unconfirmed: " +
          (failure instanceof Error ? failure.message : String(failure)) +
          "\n",
      );
  }

  private checkReminders(): void {
    if (this.closing || this.storeClosed) return;
    // A guardian from the previous plugin generation may finish writing evidence after restart.
    for (const unknown of this.store.activeRuns()) {
      if (unknown.status !== "unknown" || this.handles.has(unknown.id)) continue;
      const unknownWorker = this.store.worker(unknown.workerId);
      if (!unknownWorker || unknownWorker.type === "dsh") continue;
      const evidence = this.readEvidence(unknown.id);
      // Only re-finalize once final.json proves the run or process group actually ended;
      // unconfirmed evidence (guardian groupExited=false or open ACP session) stays unknown.
      if (evidence && isEvidenceConfirmed(evidence))
        this.finalizeRun(unknown.id, evidence, null);
    }
    const settings = this.store.settings();
    for (const handle of this.handles.values()) {
      const run = this.store.run(handle.runId);
      if (!run || run.status !== "running") continue;
      const reviewStartedAt = run.progress.softReminderSentAt ?? run.startedAt;
      const dueTime =
        reviewStartedAt !== null &&
        this.now() - Date.parse(reviewStartedAt) >= settings.softReminderSeconds * 1000;
      // Progress writes are throttled; use validated live steps so a long tool
      // call after the threshold does not postpone its reminder until completion.
      const steps = handle.progress.steps || null;
      const dueSteps =
        run.progress.softReminderSentAt === null && steps !== null && steps >= settings.softReminderSteps;
      if (!dueTime && !dueSteps) continue;
      // Wait for delivery of the previous review instead of piling up wakeups
      // behind a busy, paused, or unconfirmed parent session.
      if (this.store.notifications().some((item) => item.runId === run.id
        && item.status === "running" && item.delivery !== "delivered")) continue;
      run.progress.steps = steps;
      run.progress.softReminderSentAt = new Date(this.now()).toISOString();
      this.store.saveRun(run);
      const worker = this.store.worker(run.workerId)!;
      const elapsed = run.startedAt === null ? 0 : Math.floor((this.now() - Date.parse(run.startedAt)) / 1000);
      // Live phase/tool locate the current step without waiting for a throttled progress save.
      const phase = handle.progress.phase?.slice(0, 40);
      const tool = handle.progress.currentTool?.slice(0, 40);
      const since = run.progress.lastEventAt === null
        ? null
        : Math.floor((this.now() - Date.parse(run.progress.lastEventAt)) / 1000);
      this.notify(worker, run, "running", this.owners.get(worker.ownerId)?.owner.paused === true,
        `${runTaskName(worker, run)}: soft budget reached (${elapsed}s elapsed`
        + (steps === null ? "" : `, ${steps} steps`)
        + (phase ? `, phase ${phase}` : "")
        + (tool ? `, tool ${tool}` : "")
        + (since === null ? "" : `, last event ${since}s ago`)
        + ")");
      // The reminder wakes an idle parent for review; it never cancels the run.
      this.emitChanged(run.workerId);
    }
  }

  private emitChanged(workerId: string): void {
    const worker = this.store.worker(workerId);
    if (!worker) return;
    this.send({
      channel: "cloudcli-workers",
      kind: "event",
      event: "changed",
      value: { ownerId: worker.ownerId, workerIds: [worker.id] },
    });
  }

  private emitNotification(notification: WorkerNotification): void {
    this.send({
      channel: "cloudcli-workers",
      kind: "event",
      event: "notification",
      value: notification,
    });
  }

  private send(message: unknown): void {
    this.options.onEvent?.(message);
    if (!process.connected) return;
    try {
      process.send?.(message);
    } catch {
      /* host restarting; persisted state remains authoritative */
    }
  }

  //------------------ HELPERS ----------------

  private requireOwner(ownerId: string): WorkerOwner {
    const owner = this.owners.get(ownerId)?.owner ?? this.store.owner(ownerId);
    if (!owner) throw new WorkerFailure("OWNER_NOT_FOUND", "owner 未注册");
    return owner;
  }

  private ownedWorker(ownerId: string | undefined, workerId: string): WorkerRecord {
    const worker = this.store.worker(workerId);
    if (!worker) throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
    if (ownerId) {
      const owner = this.owners.get(ownerId)?.owner ?? this.store.owner(ownerId);
      if (!this.inScope(worker, ownerId, owner))
        throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
    }
    return worker;
  }

  /** Historical access follows the logical parent+project; destructive live control does not. */
  private inScope(
    worker: WorkerRecord,
    ownerId: string,
    owner: WorkerOwner | null,
  ): boolean {
    if (worker.ownerId === ownerId) return true;
    return (
      owner !== null &&
      worker.parentSessionId === owner.parentSessionId &&
      worker.projectId === owner.projectId
    );
  }

  /** Removes live authority only; persisted owner/worker/run records stay untouched. */
  private retireOwner(ownerId: string): void {
    const registered = this.owners.get(ownerId);
    if (!registered) return;
    this.tokens.delete(registered.token);
    this.owners.delete(ownerId);
  }

  private liveOwnerForWorker(worker: WorkerRecord): WorkerOwner | null {
    // Prefer the most recently registered generation in the same logical scope.
    for (const registered of [...this.owners.values()].reverse()) {
      if (
        registered.owner.parentSessionId === worker.parentSessionId &&
        registered.owner.projectId === worker.projectId
      )
        return registered.owner;
    }
    return null;
  }

  private requestKey(owner: WorkerOwner): string {
    return owner.parentSessionId + "\u0000" + owner.projectId;
  }

  private resultOf(
    workerId: string,
    runId: string,
  ): { worker: WorkerRecord; run: WorkerRun } {
    const worker = this.store.worker(workerId);
    const run = this.store.run(runId);
    if (!worker || !run) throw new WorkerFailure("WORKER_NOT_FOUND", "worker 不存在");
    return { worker, run };
  }

  private runDirectory(workerId: string, runId: string): string {
    return path.join(this.options.dataDirectory, "logs", workerId, runId);
  }
}


function isEvidenceConfirmed(evidence: RunEvidence): boolean {
  return evidence.kind === "acp_session"
    ? evidence.sessionClosed
    : evidence.groupExited;
}

function realPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function clean(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Title shown for one run: its own recorded title, else the worker's original task name. */
function runTaskName(worker: WorkerRecord, run: WorkerRun): string {
  return run.taskName ?? worker.taskName;
}

/**
 * Short title for a resume that supplied none: the prompt's first non-blank line, whitespace
 * collapsed and capped at 80 Unicode characters. The prompt itself is never rewritten.
 */
function taskTitleFromPrompt(prompt: string): string {
  const line =
    prompt.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? "";
  return Array.from(line.replace(/\s+/g, " ")).slice(0, 80).join("");
}

/** Keeps raw JSON-RPC error data (for example a 429 RESOURCE_EXHAUSTED envelope) in evidence. */
function acpErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof AcpRpcError) || error.data === undefined) return message;
  let data = error.data;
  // ACP often repeats the same message in the error and its data envelope. Keep one copy so
  // evidence scanners do not read a reset hint twice and double the cooldown.
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (typeof record.message === "string" && message.includes(record.message)) {
      const { message: _duplicate, ...rest } = record;
      data = rest;
    }
  }
  if (data && typeof data === "object" && Object.keys(data).length === 0)
    return message;
  return message + " " + JSON.stringify(data);
}

/**
 * agy reports rate limiting either as a stderr `AGY_ERROR` object with `error_code: 429` or as a
 * structured failure result whose status is `RESOURCE_EXHAUSTED` with `code: 429`.
 */
function agyRateLimited(text: string): boolean {
  if (
    text
      .split("\n")
      .some(
        (line) =>
          line.includes("AGY_ERROR") &&
          /"error_code"\s*:\s*"?429"?(?!\d)/.test(line),
      )
  )
    return true;
  return (
    text.includes("RESOURCE_EXHAUSTED") &&
    /\bcode"?\s*[:=]?\s*\(?\s*"?429"?(?!\d)/i.test(text)
  );
}

/** Reads `Resets in 2h2m18s` (or a colon duration) into milliseconds. */
function agyResetDelay(text: string): number | null {
  const match = /resets?\s+in\s+([^\n,;]+)/i.exec(text);
  if (!match) return null;
  // Evidence may repeat the same error message (event + final evidence) on one JSON line;
  // only the first reset phrase describes this failure.
  const value = match[1]!.split(/resets?\s+in/i)[0]!;
  const colon = /(\d+):(\d+):(\d+)/.exec(value);
  if (colon)
    return (
      (Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3])) *
      1000
    );
  let seconds = 0;
  let found = false;
  const unit = /(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)/gi;
  for (let part = unit.exec(value); part; part = unit.exec(value)) {
    found = true;
    const amount = Number(part[1]);
    const scale = part[2]!.toLowerCase();
    if (scale.startsWith("h")) seconds += amount * 3600;
    else if (scale.startsWith("m")) seconds += amount * 60;
    else seconds += amount;
  }
  return found && seconds > 0 ? seconds * 1000 : null;
}
