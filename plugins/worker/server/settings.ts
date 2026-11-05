import type {
  WorkerCodexConfig,
  WorkerConfig,
  WorkerDefault,
  WorkerSettings,
  WorkerSettingsRecord,
  WorkerTaskRole,
  WorkerType,
} from "./shared/index.js";
import { WORKER_TASK_ROLES } from "../shared/task-roles.js";

/** Fixed ids of the three configs the schema-2 migration always creates. */
export const INITIAL_CONFIG_IDS: Record<WorkerType, string> = {
  dsh: "dsh-default",
  pi: "pi-default",
  codex: "codex-default",
};

/** Display names of the fixed initial configs; renaming them keeps the id unchanged. */
export const INITIAL_CONFIG_NAMES: Record<WorkerType, string> = {
  dsh: "dsh#1",
  pi: "pi#1",
  codex: "codex#1",
};

const TYPES: WorkerType[] = ["dsh", "pi", "codex"];
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

function initialConfig(type: WorkerType): WorkerConfig {
  const config: WorkerConfig = {
    id: INITIAL_CONFIG_IDS[type],
    name: INITIAL_CONFIG_NAMES[type],
    type,
    enabled: true,
    roles: [],
    concurrency: DEFAULT_CONCURRENCY,
    model: null,
    effort: null,
  };
  if (type === "codex")
    config.codex = codexConfig({ ...DEFAULT_CODEX_ENV }, [...DEFAULT_CODEX_ARGS]);
  return config;
}

/** The canonical schema-2 defaults before any user update. */
export function defaultSettingsRecord(): WorkerSettingsRecord {
  return {
    schemaVersion: 2,
    configs: TYPES.map(initialConfig),
    defaultConfigId: INITIAL_CONFIG_IDS.dsh,
    retentionDays: 1,
    softReminderSeconds: 600,
    softReminderSteps: 20,
    hardTimeoutSeconds: null,
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

  const configs = TYPES.map((type): WorkerConfig => {
    const config: WorkerConfig = {
      id: INITIAL_CONFIG_IDS[type],
      name: INITIAL_CONFIG_NAMES[type],
      type,
      enabled:
        typeof enabled[type] === "boolean" ? (enabled[type] as boolean) : true,
      roles: roleList(roles[type], []),
      concurrency: positiveInteger(concurrency[type], DEFAULT_CONCURRENCY),
      model: defaultEntry(defaults[type]).model,
      effort: defaultEntry(defaults[type]).effort,
    };
    if (type === "codex") config.codex = codexConfig({ ...codexEnv }, [...codexArgs]);
    return config;
  });

  const configuredDefault = stored.defaultWorkerType;
  const defaultType: WorkerType = TYPES.includes(configuredDefault as WorkerType)
    ? (configuredDefault as WorkerType)
    : "dsh";
  const defaultConfig =
    configs.find((config) => config.type === defaultType) ?? configs[0]!;
  // The stored row may predate validation; keep the invariant the service guarantees.
  if (!configs.some((config) => config.enabled)) defaultConfig.enabled = true;
  const chosen = defaultConfig.enabled
    ? defaultConfig
    : configs.find((config) => config.enabled) ?? defaultConfig;

  return {
    schemaVersion: 2,
    configs,
    defaultConfigId: chosen.id,
    retentionDays: positiveInteger(stored.retentionDays, 1),
    softReminderSeconds: positiveInteger(stored.softReminderSeconds, 600),
    softReminderSteps: positiveInteger(stored.softReminderSteps, 20),
    hardTimeoutSeconds:
      typeof stored.hardTimeoutSeconds === "number" &&
      Number.isSafeInteger(stored.hardTimeoutSeconds) &&
      stored.hardTimeoutSeconds > 0
        ? stored.hardTimeoutSeconds
        : null,
  };
}

export function isCanonicalSettings(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    Array.isArray(value.configs)
  );
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
export function projectSettings(record: WorkerSettingsRecord): WorkerSettings {
  const configs = record.configs;
  const defaultConfig =
    configs.find((config) => config.id === record.defaultConfigId) ?? configs[0]!;
  const concurrency = {} as Record<WorkerType, number>;
  const enabled = {} as Record<WorkerType, boolean>;
  const roles = {} as Record<WorkerType, WorkerTaskRole[]>;
  const defaults = {} as Record<WorkerType, WorkerDefault>;
  for (const type of TYPES) {
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
    softReminderSeconds: record.softReminderSeconds,
    softReminderSteps: record.softReminderSteps,
    hardTimeoutSeconds: record.hardTimeoutSeconds,
  };
}

/** Finds a canonical config by the id recorded on a worker. */
export function configById(
  settings: WorkerSettings,
  configId: string,
): WorkerConfig | null {
  return settings.configs.find((config) => config.id === configId) ?? null;
}
