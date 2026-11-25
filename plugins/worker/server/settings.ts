import type {
  LegacyWorkerType,
  WorkerCodexConfig,
  WorkerConfig,
  WorkerDefault,
  SupportedWorkerType,
  WorkerSettings,
  WorkerSettingsRecord,
  WorkerTaskRole,
  WorkerType,
} from "./shared/index.js";
import {
  ACP_IDLE_TIMEOUT_DEFAULT_SECONDS,
  ACP_IDLE_TIMEOUT_ENV,
  ACP_IDLE_TIMEOUT_MAX_SECONDS,
} from "../shared/contracts.js";
import {
  AGY_ACP_EFFORT_LEVELS,
  AGY_EFFORT_LEVELS,
  agyEffortConflict,
} from "../shared/agy.js";
import { WORKER_TASK_ROLES } from "../shared/task-roles.js";

/** Fixed ids of the executable configs the schema-2 migration creates. */
export const INITIAL_CONFIG_IDS: Record<SupportedWorkerType, string> = {
  pi: "pi-default",
  codex: "codex-default",
  agy: "agy-default",
};

/** Display names of the fixed initial configs; renaming them keeps the id unchanged. */
export const INITIAL_CONFIG_NAMES: Record<SupportedWorkerType, string> = {
  pi: "pi#1",
  codex: "codex#1",
  agy: "agy#1",
};

/** Engines the schema-2 migration and legacy settings input still cover. */
export const LEGACY_WORKER_TYPES: LegacyWorkerType[] = ["pi", "codex"];
/** Every engine a stored worker/run may name, including historical DSH records. */
export const WORKER_TYPES: WorkerType[] = ["dsh", "pi", "codex", "agy"];
/** Engines that may appear in a new executable config and accept starts/resumes. */
export const SUPPORTED_WORKER_TYPES: SupportedWorkerType[] = ["pi", "codex", "agy"];
const DEFAULT_CODEX_ENV = { CODEX_PROXY_BYPASS: "1" };
const DEFAULT_CODEX_ARGS = ["-c", "model_provider=magpie"];
const DEFAULT_CONCURRENCY = 3;

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : fallback;
}

/** Whether a value is a valid persisted/UI ACP idle window in whole seconds. */
export function validAcpIdleTimeoutSeconds(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= ACP_IDLE_TIMEOUT_MAX_SECONDS
  );
}

/**
 * Reads the ACP idle fallback once at the service boundary. Missing, malformed, or out-of-range
 * environment values keep the five-minute default; a saved UI value overrides this later.
 */
export function acpIdleTimeoutSecondsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): number {
  const raw = environment[ACP_IDLE_TIMEOUT_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return ACP_IDLE_TIMEOUT_DEFAULT_SECONDS;
  const seconds = Number(raw);
  return validAcpIdleTimeoutSeconds(seconds)
    ? seconds
    : ACP_IDLE_TIMEOUT_DEFAULT_SECONDS;
}

function parseConfigValue(value: string): string {
  const raw = value.slice("model_provider=".length).trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" ? parsed.trim() : raw;
  } catch {
    return raw.replace(/^["']|["']$/g, "").trim();
  }
}

/**
 * Splits a legacy Codex extra-args list into the canonical `modelProvider` and the remaining
 * argv entries. The provider pair is removed from the retained args so it cannot override the
 * canonical service after later edits; every other entry keeps its original order.
 */
export function extractCodexLaunch(args: string[]): {
  modelProvider: string | null;
  legacyExtraArgs: string[];
} {
  const legacyExtraArgs: string[] = [];
  let modelProvider: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-c" || arg === "--config") {
      const next = args[index + 1];
      if (typeof next === "string" && next.startsWith("model_provider=")) {
        const value = parseConfigValue(next);
        modelProvider = value || null;
        index++;
        continue;
      }
    } else if (arg.startsWith("--config=model_provider=")) {
      const value = parseConfigValue(arg.slice("--config=".length));
      modelProvider = value || null;
      continue;
    }
    legacyExtraArgs.push(arg);
  }
  return { modelProvider, legacyExtraArgs };
}

/**
 * Rebuilds a valid legacy argv view for the configured service. The canonical config never
 * stores the provider pair inside `legacyExtraArgs`; this projection restores it for older
 * clients without mutating canonical state.
 */
export function codexProjectionArgs(
  legacyExtraArgs: string[],
  modelProvider: string | null,
): string[] {
  const args = [...legacyExtraArgs];
  if (modelProvider) args.push("-c", "model_provider=" + modelProvider);
  return args;
}

function codexConfig(
  env: Record<string, string>,
  extraArgs: string[],
): WorkerCodexConfig {
  const extracted = extractCodexLaunch(extraArgs);
  return {
    modelProvider: extracted.modelProvider,
    env,
    legacyExtraArgs: extracted.legacyExtraArgs,
  };
}

/**
 * Validates agy effort levels and known fixed-suffix conflicts. New ACP settings and runs accept
 * only `AGY_ACP_EFFORT_LEVELS`; historical configs keeping an unchanged legacy value and legacy
 * CLI runs opt into `allowLegacy` so `max` stays accepted there without permitting new ACP `max`.
 */
export function validateConfigEffort(
  type: SupportedWorkerType,
  model: string | null,
  effort: string | null,
  options: { allowLegacy?: boolean } = {},
): string | null {
  if (type === "agy" && effort) {
    const allowed: readonly string[] = options.allowLegacy
      ? AGY_EFFORT_LEVELS
      : AGY_ACP_EFFORT_LEVELS;
    if (!allowed.includes(effort))
      return options.allowLegacy
        ? "agy 配置的 effort 必须是 low、medium、high、xhigh 或 max"
        : effort === "max"
          ? "AGY ACP 不支持 effort=max；可用级别为 low、medium、high、xhigh"
          : "agy 配置的 effort 必须是 low、medium、high 或 xhigh";
  }
  if (type === "agy") {
    const conflict = agyEffortConflict(model, effort);
    if (conflict) return conflict;
  }
  return null;
}

/** Fresh-install settings used by WorkerStore; only Pi is configured by default. */
export function defaultSettingsRecord(): WorkerSettingsRecord {
  return {
    schemaVersion: 2,
    configs: [{
      id: INITIAL_CONFIG_IDS.pi,
      name: "pi default",
      type: "pi",
      enabled: true,
      roles: [],
      concurrency: DEFAULT_CONCURRENCY,
      hardTimeoutSeconds: 600,
      model: null,
      effort: null,
    }],
    defaultConfigId: INITIAL_CONFIG_IDS.pi,
    retentionDays: 1,
    softReminderSeconds: 600,
    softReminderSteps: 20,
  };
}

function roleList(value: unknown, fallback: WorkerTaskRole[]): WorkerTaskRole[] {
  if (!Array.isArray(value)) return fallback;
  const roles = value.filter(
    (role): role is WorkerTaskRole =>
      typeof role === "string" &&
      WORKER_TASK_ROLES.some((item) => item.value === role),
  );
  return roles.length === value.length ? roles : fallback;
}

function defaultEntry(value: unknown): WorkerDefault {
  const entry = isRecord(value) ? value : {};
  return { model: clean(entry.model), effort: clean(entry.effort) };
}

function stringMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    output[key] = item;
  }
  return output;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    return null;
  return [...value];
}

/**
 * One-time mapping of the pre-schema-2 settings row. Missing maps and individual entries keep
 * their historical defaults; explicit empty Codex env/args stay empty. The result is canonical
 * and never re-creates a config that a later canonical update deletes.
 */
export function migrateLegacySettings(
  stored: Record<string, unknown>,
): WorkerSettingsRecord {
  const concurrency = isRecord(stored.concurrency) ? stored.concurrency : {};
  const enabled = isRecord(stored.enabled) ? stored.enabled : {};
  const roles = isRecord(stored.roles) ? stored.roles : {};
  const defaults = isRecord(stored.defaults) ? stored.defaults : {};
  const legacyCodex = isRecord(stored.codex) ? stored.codex : {};
  const codexEnv = stringMap(legacyCodex.env) ?? { ...DEFAULT_CODEX_ENV };
  const codexArgs =
    stringList(legacyCodex.extraArgs) ?? [...DEFAULT_CODEX_ARGS];

  const configs = LEGACY_WORKER_TYPES.map((type): WorkerConfig => {
    const config: WorkerConfig = {
      id: INITIAL_CONFIG_IDS[type],
      name: INITIAL_CONFIG_NAMES[type],
      type,
      enabled:
        typeof enabled[type] === "boolean" ? (enabled[type] as boolean) : true,
      roles: roleList(roles[type], []),
      concurrency: positiveInteger(concurrency[type], DEFAULT_CONCURRENCY),
      hardTimeoutSeconds: positiveInteger(stored.hardTimeoutSeconds, 600),
      model: defaultEntry(defaults[type]).model,
      effort: defaultEntry(defaults[type]).effort,
    };
    if (type === "codex") config.codex = codexConfig({ ...codexEnv }, [...codexArgs]);
    return config;
  });

  const requested = SUPPORTED_WORKER_TYPES.includes(
    stored.defaultWorkerType as SupportedWorkerType,
  )
    ? (stored.defaultWorkerType as SupportedWorkerType)
    : null;
  // A stored DSH (or unknown) default, or an all-disabled map, falls back to the first enabled
  // supported config; when none is enabled the usable Pi default is restored.
  let chosen =
    (requested
      ? configs.find((config) => config.type === requested && config.enabled)
      : undefined) ?? configs.find((config) => config.enabled);
  if (!chosen) {
    const pi = configs.find((config) => config.type === "pi")!;
    pi.enabled = true;
    chosen = pi;
  }

  return {
    schemaVersion: 2,
    configs,
    defaultConfigId: chosen.id,
    retentionDays: positiveInteger(stored.retentionDays, 1),
    softReminderSeconds: positiveInteger(stored.softReminderSeconds, 600),
    softReminderSteps: positiveInteger(stored.softReminderSteps, 20),
  };
}

export function isCanonicalSettings(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    Array.isArray(value.configs)
  );
}

/**
 * Repairs a canonical record read from storage. DSH configs are dropped because the engine is no
 * longer executable; a default that no longer names an enabled supported config falls back to the
 * first enabled supported config, and when none is enabled a usable Pi default is restored.
 * This is an in-memory projection only: hidden DSH rows are never migrated or persisted by reads.
 */
export function normalizeSettingsRecord(record: WorkerSettingsRecord): WorkerSettingsRecord {
  let configs = record.configs.filter((config) =>
    SUPPORTED_WORKER_TYPES.includes(config.type),
  );
  let chosen = configs.find(
    (config) => config.id === record.defaultConfigId && config.enabled,
  ) ?? configs.find((config) => config.enabled);
  if (!chosen) {
    // Restore the fixed Pi default rather than enabling an arbitrary custom Pi config.
    const existing = configs.find(
      (config) => config.id === INITIAL_CONFIG_IDS.pi && config.type === "pi",
    );
    const pi: WorkerConfig = existing
      ? { ...existing, enabled: true }
      : {
          id: INITIAL_CONFIG_IDS.pi,
          name: INITIAL_CONFIG_NAMES.pi,
          type: "pi",
          enabled: true,
          roles: [],
          concurrency: DEFAULT_CONCURRENCY,
          hardTimeoutSeconds: 600,
          model: null,
          effort: null,
        };
    configs = existing
      ? configs.map((config) => (config.id === pi.id ? pi : config))
      : [pi, ...configs];
    chosen = pi;
  }
  const next: WorkerSettingsRecord = {
    ...record,
    configs,
    defaultConfigId: chosen.id,
  };
  return next;
}

function configForType(
  configs: WorkerConfig[],
  defaultConfigId: string,
  type: WorkerType,
): WorkerConfig | null {
  const preferred = configs.find(
    (config) => config.type === type && config.id === defaultConfigId,
  );
  return preferred ?? configs.find((config) => config.type === type) ?? null;
}

/**
 * Derives the read-only per-engine compatibility maps and Codex launch view. These values are
 * never persisted; the canonical `configs` list remains the only source of truth.
 */
export function projectSettings(
  record: WorkerSettingsRecord,
  acpIdleFallbackSeconds: number = ACP_IDLE_TIMEOUT_DEFAULT_SECONDS,
): WorkerSettings {
  const configs = record.configs;
  const defaultConfig =
    configs.find((config) => config.id === record.defaultConfigId) ?? configs[0]!;
  const concurrency = {} as Record<WorkerType, number>;
  const enabled = {} as Record<WorkerType, boolean>;
  const roles = {} as Record<WorkerType, WorkerTaskRole[]>;
  const defaults = {} as Record<WorkerType, WorkerDefault>;
  for (const type of WORKER_TYPES) {
    const config = configForType(configs, record.defaultConfigId, type);
    concurrency[type] = config?.concurrency ?? 1;
    enabled[type] = config?.enabled ?? false;
    roles[type] = config ? [...config.roles] : [];
    defaults[type] = {
      model: config?.model ?? null,
      effort: config?.effort ?? null,
    };
  }
  const codexConfig = configForType(configs, record.defaultConfigId, "codex");
  return {
    schemaVersion: 2,
    configs,
    defaultConfigId: record.defaultConfigId,
    defaultWorkerType: defaultConfig.type,
    concurrency,
    enabled,
    roles,
    defaults,
    codex: codexConfig?.codex
      ? {
          env: { ...codexConfig.codex.env },
          extraArgs: codexProjectionArgs(
            codexConfig.codex.legacyExtraArgs,
            codexConfig.codex.modelProvider,
          ),
        }
      : { env: {}, extraArgs: [] },
    retentionDays: record.retentionDays,
    acpIdleTimeoutSeconds:
      record.acpIdleTimeoutSeconds ?? acpIdleFallbackSeconds,
    softReminderSeconds: record.softReminderSeconds,
    softReminderSteps: record.softReminderSteps,
    hardTimeoutSeconds: defaultConfig.hardTimeoutSeconds,
  };
}

/** Finds a canonical config by the id recorded on a worker. */
export function configById(
  settings: WorkerSettings,
  configId: string,
): WorkerConfig | null {
  return settings.configs.find((config) => config.id === configId) ?? null;
}
