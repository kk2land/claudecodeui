import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  GripVertical,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type {
  AgyModelCatalog,
  AgyQuotaBucket,
  AgyQuotaSnapshot,
  CodexModelsDirectory,
  PiModelCatalog,
  WorkerConfig,
  WorkerConfigUsage,
  WorkerModelCatalog,
  WorkerSettings,
  WorkerSettingsUpdate,
  WorkerProjectCatalog,
  WorkerTaskRole,
  SupportedWorkerType,
} from "../shared/contracts.js";
import {
  ACP_IDLE_TIMEOUT_DEFAULT_SECONDS,
  ACP_IDLE_TIMEOUT_MAX_SECONDS,
} from "../shared/contracts.js";
import { WORKER_TASK_ROLES } from "../shared/task-roles.js";
import type { WorkerHost } from "./api.js";
import type { workerApi } from "./api.js";
import {
  DEFAULT_EFFORT_LABEL,
  effortOptionsFor,
  modelOptionsFor,
  readCodexProviderModels,
  readCodexProviders,
  readHostModels,
  type ModelSelectOption,
} from "./catalog.js";
import { TASK_ROLE_LABELS, TYPE_LABELS } from "./format.js";

const WORKER_TYPES: SupportedWorkerType[] = ["pi", "codex", "agy"];
const AGY_QUOTA_REFRESH_POLL_MS = 5 * 60 * 1000;

function quotaWindowLabel(bucket: AgyQuotaBucket): string {
  if (bucket.window === "5h") return "5 小时";
  if (bucket.window === "weekly") return "每周";
  return bucket.label || bucket.window || "剩余额度";
}

function formatQuotaTime(iso: string | null, includeDate: boolean): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  const hm = pad(date.getHours()) + ":" + pad(date.getMinutes());
  if (!includeDate) return hm;
  return pad(date.getMonth() + 1) + "/" + pad(date.getDate()) + " " + hm;
}

function quotaPercentClass(percent: number): string {
  if (percent <= 10) return "worker-danger";
  if (percent <= 30) return "worker-soft";
  return "";
}

/** Result of one optional host catalog read; a stale value stays visible while retrying. */
type Loadable<T> = {
  status: "loading" | "ready" | "error";
  value: T | null;
  error: string;
};

function loading<T>(value: T | null = null): Loadable<T> {
  return { status: "loading", value, error: "" };
}

/**
 * Generates one config id. `randomUUID` is missing on some insecure HTTP origins, so fall back
 * to a UUID v4 built from `getRandomValues` with the same byte layout as the app's own helper;
 * the plugin stays self-contained instead of importing host source.
 */
function newConfigId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

function envText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => key + "=" + value)
    .join("\n");
}

/** Parses the per-config Codex env textarea; only the first `=` separates each pair. */
function parseEnv(text: string): {
  env: Record<string, string>;
  error: string;
} {
  const env: Record<string, string> = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    if (separator < 0)
      return {
        env,
        error: "额外环境变量第 " + (index + 1) + " 行需要 KEY=VALUE。",
      };
    const key = line.slice(0, separator).trim();
    if (!key)
      return {
        env,
        error: "额外环境变量第 " + (index + 1) + " 行的 KEY 不能为空。",
      };
    env[key] = line.slice(separator + 1);
  }
  return { env, error: "" };
}

/**
 * Default name for a new config of `type`: `type#1` when no canonical name exists yet, else
 * one past the highest `type#<n>` in the current list.
 */
function nextConfigName(configs: WorkerConfig[], type: SupportedWorkerType): string {
  let highest = 0;
  for (const config of configs) {
    if (config.type !== type) continue;
    const match = new RegExp("^" + type + "#(\\d+)$").exec(config.name.trim());
    if (!match) continue;
    const index = Number(match[1]);
    if (Number.isSafeInteger(index) && index > highest) highest = index;
  }
  return type + "#" + (highest + 1);
}

/**
 * Deep-copies a config so draft edits never mutate the saved snapshot. Duplication passes a
 * fresh id and a distinct name; initialization passes the stored id and name.
 */
function cloneConfig(
  config: WorkerConfig,
  name: string,
  id: string,
): WorkerConfig {
  const { codex, ...rest } = config;
  return {
    ...rest,
    id,
    name,
    roles: [...config.roles],
    ...(codex
      ? {
          codex: {
            modelProvider: codex.modelProvider,
            env: { ...codex.env },
            legacyExtraArgs: [...codex.legacyExtraArgs],
          },
        }
      : {}),
  };
}

function blankConfig(type: SupportedWorkerType, name: string, id: string): WorkerConfig {
  return {
    id,
    name,
    type,
    enabled: true,
    roles: [],
    concurrency: 3,
    hardTimeoutSeconds: 600,
    model: null,
    effort: null,
    ...(type === "codex"
      ? { codex: { modelProvider: null, env: {}, legacyExtraArgs: [] } }
      : {}),
  };
}

type ConfigDraft = {
  configs: WorkerConfig[];
  defaultConfigId: string;
};

/** Replaces one draft config by id; every edit stays local until the user saves. */
function patchConfig(
  draft: ConfigDraft,
  id: string,
  patch: Partial<WorkerConfig>,
): ConfigDraft {
  return {
    ...draft,
    configs: draft.configs.map((config) =>
      config.id === id ? { ...config, ...patch } : config,
    ),
  };
}

/**
 * Picks another enabled config as default when the current default is removed or disabled.
 * Returns the unchanged id when nothing better exists so the form can report the error.
 */
function fallbackDefault(
  configs: WorkerConfig[],
  current: string,
): string {
  if (configs.some((config) => config.id === current && config.enabled))
    return current;
  return configs.find((config) => config.enabled)?.id ?? current;
}

/** One local catalog failure rendered on the card that depends on it, with its own retry. */
type CatalogProblem = {
  message: string;
  source: "agy" | "pi" | "codex" | "codexDirectory" | "codexProvider";
  provider?: string;
};

type CatalogView = {
  agy: AgyModelCatalog | null;
  codex: WorkerModelCatalog | null;
  pi: PiModelCatalog | null;
  codexDirectory: CodexModelsDirectory | null;
  codexModels: Record<string, Loadable<string[]>>;
  errors: {
    agy?: string;
    pi?: string;
    codex?: string;
    codexDirectory?: string;
  };
  loading: {
    agy: boolean;
    pi: boolean;
    codex: boolean;
    codexDirectory: boolean;
  };
  retry(
    source: "agy" | "pi" | "codex" | "codexDirectory" | "codexProvider",
    provider?: string,
  ): void;
};

type SettingsViewProps = {
  settings: WorkerSettings;
  usage: Record<string, WorkerConfigUsage>;
  host: WorkerHost;
  api: ReturnType<typeof workerApi>;
  onBack(): void;
  onSaved(settings: WorkerSettings, notice?: string): void;
  onError(message: string): void;
};

/** Detects whether the active Worker backend supports `acpIdleTimeoutSeconds`. */
function supportsAcpIdleTimeout(value: WorkerSettings): boolean {
  return (
    typeof value.acpIdleTimeoutSeconds === "number" &&
    Number.isSafeInteger(value.acpIdleTimeoutSeconds) &&
    value.acpIdleTimeoutSeconds >= 1
  );
}

/**
 * Named Worker config editor used by the Worker plugin settings view. Drafts are saved as the
 * whole `configs`/`defaultConfigId` document in one atomic request.
 */
export function SettingsView({
  settings,
  usage,
  host,
  api,
  onBack,
  onSaved,
  onError,
}: SettingsViewProps) {
  const [draft, setDraft] = useState<ConfigDraft>(() => ({
    configs: settings.configs.map((config) => cloneConfig(config, config.name, config.id)),
    defaultConfigId: settings.defaultConfigId,
  }));
  const [retentionDays, setRetentionDays] = useState(String(settings.retentionDays));
  const [blockedProjectIds, setBlockedProjectIds] = useState<string[]>(() => [
    ...(settings.blockedProjectIds ?? []),
  ]);
  const acpIdleSupported = supportsAcpIdleTimeout(settings);
  const [acpIdleTimeoutSeconds, setAcpIdleTimeoutSeconds] = useState(() =>
    supportsAcpIdleTimeout(settings)
      ? String(settings.acpIdleTimeoutSeconds)
      : "",
  );
  // Only an explicit edit on a capable backend submits the idle field; saving other fields keeps the env fallback.
  const [acpIdleTimeoutDirty, setAcpIdleTimeoutDirty] = useState(false);

  useEffect(() => {
    if (acpIdleSupported && !acpIdleTimeoutDirty) {
      setAcpIdleTimeoutSeconds(String(settings.acpIdleTimeoutSeconds));
    } else if (!acpIdleSupported) {
      setAcpIdleTimeoutSeconds("");
      setAcpIdleTimeoutDirty(false);
    }
  }, [acpIdleSupported, settings.acpIdleTimeoutSeconds, acpIdleTimeoutDirty]);
  const [envDraft, setEnvDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      settings.configs
        .filter((config) => config.type === "codex")
        .map((config) => [config.id, envText(config.codex?.env ?? {})]),
    ),
  );
  const [busy, setBusy] = useState(false);
  // Native HTML5 drag feedback: the config being dragged and the card currently under the
  // pointer. Only the drag handle is draggable; the order only changes on drop (or a move button).
  const [dragState, setDragState] = useState<{ id: string; overId: string | null } | null>(null);

  const [agyCatalog, setAgyCatalog] = useState<Loadable<AgyModelCatalog>>(loading());
  const [agyQuota, setAgyQuota] = useState<AgyQuotaSnapshot>({
    status: "loading",
    groups: [],
    updatedAt: null,
    error: null,
  });
  const [agyQuotaRefreshing, setAgyQuotaRefreshing] = useState(false);
  const agyQuotaMounted = useRef(true);
  const agyQuotaSeq = useRef(0);
  const agyQuotaManualInFlight = useRef(false);
  const [projectCatalog, setProjectCatalog] = useState<Loadable<WorkerProjectCatalog>>(loading());
  const [codexCatalog, setCodexCatalog] = useState<Loadable<WorkerModelCatalog>>(loading());
  const [piCatalog, setPiCatalog] = useState<Loadable<PiModelCatalog>>(loading());
  const [codexDirectory, setCodexDirectory] = useState<Loadable<CodexModelsDirectory>>(loading());
  const [codexModels, setCodexModels] = useState<Record<string, Loadable<string[]>>>({});
  // Mirrors codexModels so the fetch effect can decide from the latest cache without
  // re-running on every response, and request tokens stop a stale response from overwriting
  // the result of a later explicit retry.
  const codexModelsRef = useRef<Record<string, Loadable<string[]>>>({});
  const providerRequestTokens = useRef<Record<string, number>>({});
  const [agyAttempt, setAgyAttempt] = useState(0);
  const [projectAttempt, setProjectAttempt] = useState(0);
  const [codexAttempt, setCodexAttempt] = useState(0);
  const [piAttempt, setPiAttempt] = useState(0);
  const [directoryAttempt, setDirectoryAttempt] = useState(0);
  const [providerAttempt, setProviderAttempt] = useState(0);
  const inFlightProviders = useRef(new Set<string>());

  // Catalogs are optional capabilities: a failure only affects that engine's selects. Pi is
  // served by this plugin; Codex metadata and its service directory come from the host.
  // `agy models` hits the network, so the directory is only requested once the draft actually
  // uses agy: opening settings that contain an agy config, or adding/retargeting one. Collapsing
  // away the last agy config performs no request.
  const needsAgyCatalog = draft.configs.some(
    (config) => config.type === "agy",
  );
  useEffect(() => {
    if (!needsAgyCatalog) return;
    let live = true;
    setAgyCatalog((current) => loading(current.value));
    api
      .agyCatalog()
      .then((value) => live && setAgyCatalog({ status: "ready", value, error: "" }))
      .catch(
        (error) => live && setAgyCatalog({ status: "error", value: null, error: String(error) }),
      );
    return () => {
      live = false;
    };
  }, [api, needsAgyCatalog, agyAttempt]);

  const loadAgyQuota = (mode: "read" | "refresh") => {
    if (agyQuotaManualInFlight.current) return;
    const isManual = mode === "refresh";
    if (isManual) {
      agyQuotaManualInFlight.current = true;
      setAgyQuotaRefreshing(true);
    }
    const seq = ++agyQuotaSeq.current;
    const request = isManual ? api.refreshAgyQuota() : api.agyQuota();
    void request
      .then((value) => {
        if (!agyQuotaMounted.current || agyQuotaSeq.current !== seq) return;
        setAgyQuota(value);
      })
      .catch(() => {
        if (!agyQuotaMounted.current || agyQuotaSeq.current !== seq) return;
        setAgyQuota((current) => ({
          status: "error",
          groups: current.groups,
          updatedAt: current.updatedAt,
          error: isManual ? "AGY 额度刷新失败" : "AGY 额度获取失败",
        }));
      })
      .finally(() => {
        if (!isManual) return;
        agyQuotaManualInFlight.current = false;
        if (agyQuotaMounted.current) setAgyQuotaRefreshing(false);
      });
  };

  useEffect(() => {
    agyQuotaMounted.current = true;
    loadAgyQuota("read");
    const timer = window.setInterval(
      () => loadAgyQuota("read"),
      AGY_QUOTA_REFRESH_POLL_MS,
    );
    return () => {
      agyQuotaMounted.current = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    let live = true;
    setProjectCatalog((current) => loading(current.value));
    api
      .projects()
      .then((value) => live && setProjectCatalog({ status: "ready", value, error: "" }))
      .catch(
        (error) =>
          live &&
          setProjectCatalog({ status: "error", value: null, error: String(error) }),
      );
    return () => {
      live = false;
    };
  }, [api, projectAttempt]);

  useEffect(() => {
    let live = true;
    setCodexCatalog((current) => loading(current.value));
    readHostModels(host)
      .then((value) => live && setCodexCatalog({ status: "ready", value, error: "" }))
      .catch((error) => live && setCodexCatalog({ status: "error", value: null, error: String(error) }));
    return () => {
      live = false;
    };
  }, [host, codexAttempt]);

  useEffect(() => {
    let live = true;
    setPiCatalog((current) => loading(current.value));
    api
      .piCatalog()
      .then((value) => live && setPiCatalog({ status: "ready", value, error: "" }))
      .catch((error) => live && setPiCatalog({ status: "error", value: null, error: String(error) }));
    return () => {
      live = false;
    };
  }, [api, piAttempt]);

  useEffect(() => {
    let live = true;
    setCodexDirectory((current) => loading(current.value));
    readCodexProviders(host)
      .then((value) => live && setCodexDirectory({ status: "ready", value, error: "" }))
      .catch((error) =>
        live && setCodexDirectory({ status: "error", value: null, error: String(error) }),
      );
    return () => {
      live = false;
    };
  }, [host, directoryAttempt]);

  /** The service Codex actually asks: the explicit id, or the directory's default service. */
  const effectiveCodexProvider = (config: WorkerConfig): string | null =>
    config.type === "codex"
      ? config.codex?.modelProvider ?? codexDirectory.value?.defaultProvider ?? null
      : null;

  // Every effective service id used by the draft is fetched once and cached by that id, so the
  // default service and an explicit service share the same request/error/retry path.
  const providerKey = useMemo(
    () =>
      [
        ...new Set(
          draft.configs
            .map((config) => effectiveCodexProvider(config))
            .filter((id): id is string => Boolean(id)),
        ),
      ]
        .sort()
        .join("\n"),
    // effectiveCodexProvider reads the directory, so its value is a real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft.configs, codexDirectory.value],
  );
  useEffect(() => {
    const inFlight = inFlightProviders.current;
    const write = (id: string, entry: Loadable<string[]>, token: number) => {
      if (providerRequestTokens.current[id] !== token) return;
      const next = { ...codexModelsRef.current, [id]: entry };
      codexModelsRef.current = next;
      setCodexModels(next);
    };
    for (const id of providerKey ? providerKey.split("\n") : []) {
      // A cached result or an in-flight request for this id is reused; switching providers or
      // retrying never duplicates or cancels a still-valid request.
      if (inFlight.has(id) || codexModelsRef.current[id]) continue;
      const token = (providerRequestTokens.current[id] ?? 0) + 1;
      providerRequestTokens.current[id] = token;
      inFlight.add(id);
      write(id, { status: "loading", value: null, error: "" }, token);
      readCodexProviderModels(host, id)
        .then((value) => write(id, { status: "ready", value: value.models, error: "" }, token))
        .catch((error) =>
          write(id, { status: "error", value: null, error: String(error) }, token),
        )
        .finally(() => inFlight.delete(id));
    }
  }, [host, providerKey, providerAttempt]);

  const catalogView: CatalogView = {
    agy: agyCatalog.value,
    codex: codexCatalog.value,
    pi: piCatalog.value,
    codexDirectory: codexDirectory.value,
    codexModels,
    errors: {
      agy: agyCatalog.status === "error" ? agyCatalog.error : undefined,
      pi: piCatalog.status === "error" ? piCatalog.error : undefined,
      codex: codexCatalog.status === "error" ? codexCatalog.error : undefined,
      codexDirectory:
        codexDirectory.status === "error" ? codexDirectory.error : undefined,
    },
    loading: {
      agy: agyCatalog.status === "loading",
      pi: piCatalog.status === "loading",
      codex: codexCatalog.status === "loading",
      codexDirectory: codexDirectory.status === "loading",
    },
    retry(source, provider) {
      if (source === "agy") setAgyAttempt((value) => value + 1);
      else if (source === "pi") setPiAttempt((value) => value + 1);
      else if (source === "codex") setCodexAttempt((value) => value + 1);
      else if (source === "codexDirectory") setDirectoryAttempt((value) => value + 1);
      else if (provider) {
        const next = { ...codexModelsRef.current };
        delete next[provider];
        codexModelsRef.current = next;
        setCodexModels(next);
        setProviderAttempt((value) => value + 1);
      }
    },
  };

  const projectOptions = useMemo(() => {
    const options = [...(projectCatalog.value?.projects ?? [])];
    // A project can disappear from the host catalog while still blocked; keep it removable.
    for (const id of blockedProjectIds)
      if (!options.some((project) => project.id === id))
        options.push({ id, name: "未知项目 (" + id + ")", path: "" });
    return options;
  }, [blockedProjectIds, projectCatalog.value]);

  const envResults = useMemo(() => {
    const results: Record<string, { env: Record<string, string>; error: string }> = {};
    for (const config of draft.configs) {
      if (config.type !== "codex") continue;
      results[config.id] = parseEnv(envDraft[config.id] ?? "");
    }
    return results;
  }, [draft.configs, envDraft]);

  const validNumber = (value: string): boolean => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0;
  };
  const validAcpIdleTimeout = (value: string): boolean => {
    const parsed = Number(value);
    return (
      Number.isSafeInteger(parsed) &&
      parsed >= 1 &&
      parsed <= ACP_IDLE_TIMEOUT_MAX_SECONDS
    );
  };
  const defaultConfig = draft.configs.find(
    (config) => config.id === draft.defaultConfigId,
  );
  const enabledCount = draft.configs.filter((config) => config.enabled).length;
  const codexNameWithEnvError = draft.configs.find(
    (config) =>
      config.type === "codex" && envResults[config.id]?.error,
  );
  const validationMessage = !draft.configs.length
    ? "至少需要一个 Worker 配置。"
    : draft.configs.some((config) => !config.name.trim())
      ? "配置名称不能为空。"
      : draft.configs.some(
            (config) =>
              !Number.isSafeInteger(config.concurrency) || config.concurrency < 1,
          )
        ? "并发必须是大于 0 的整数。"
        : draft.configs.some(
              (config) => config.hardTimeoutSeconds !== null &&
                (!Number.isSafeInteger(config.hardTimeoutSeconds) || config.hardTimeoutSeconds < 1),
            )
          ? "硬超时必须是大于 0 的整数，留空表示不限时。"
        : codexNameWithEnvError
          ? "配置 " +
            codexNameWithEnvError.name +
            "：" +
            envResults[codexNameWithEnvError.id]!.error
          : !validNumber(retentionDays)
            ? "保留天数必须是大于 0 的整数。"
            : acpIdleSupported && !validAcpIdleTimeout(acpIdleTimeoutSeconds)
              ? "ACP 空闲关闭时间必须是 1 到 2147483 之间的整数秒。"
              : !enabledCount
              ? "至少需要启用一个 Worker 配置。"
              : !defaultConfig
                ? "请选择默认 Worker 配置。"
                : !defaultConfig.enabled
                  ? "默认配置 " +
                    defaultConfig.name +
                    " 已停用，请选择其他已启用的配置。"
                  : "";

  const update = (id: string, patch: Partial<WorkerConfig>) =>
    setDraft((current) => patchConfig(current, id, patch));

  /**
   * Moves one draft config to an absolute position. Every per-config draft (env text, default
   * id, selections) is keyed by config id, so reordering only changes the array order.
   */
  const moveConfig = (id: string, toIndex: number) =>
    setDraft((current) => {
      const fromIndex = current.configs.findIndex((config) => config.id === id);
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        toIndex >= current.configs.length ||
        fromIndex === toIndex
      )
        return current;
      const configs = [...current.configs];
      const [moved] = configs.splice(fromIndex, 1);
      configs.splice(toIndex, 0, moved!);
      return { ...current, configs };
    });

  const addConfig = (type: SupportedWorkerType) => {
    const id = newConfigId();
    if (type === "codex") setEnvDraft((current) => ({ ...current, [id]: "" }));
    setDraft((current) => ({
      configs: [
        ...current.configs,
        blankConfig(type, nextConfigName(current.configs, type), id),
      ],
      defaultConfigId: current.defaultConfigId || id,
    }));
  };

  const duplicate = (config: WorkerConfig) => {
    const id = newConfigId();
    // Copy the raw draft text of the source config, including an emptied or still-invalid
    // textarea, so the copy saves exactly what the user currently sees.
    if (config.type === "codex")
      setEnvDraft((current) => ({ ...current, [id]: current[config.id] ?? "" }));
    setDraft((current) => ({
      configs: [
        ...current.configs,
        cloneConfig(config, nextConfigName(current.configs, config.type), id),
      ],
      defaultConfigId: current.defaultConfigId,
    }));
  };

  const remove = (config: WorkerConfig) => {
    setDraft((current) => {
      const configs = current.configs.filter((item) => item.id !== config.id);
      return {
        configs,
        defaultConfigId:
          current.defaultConfigId === config.id
            ? fallbackDefault(configs, "")
            : current.defaultConfigId,
      };
    });
    setEnvDraft((current) => {
      const next = { ...current };
      delete next[config.id];
      return next;
    });
  };

  const setEnabled = (config: WorkerConfig, enabled: boolean) =>
    setDraft((current) => {
      const configs = current.configs.map((item) =>
        item.id === config.id ? { ...item, enabled } : item,
      );
      return {
        configs,
        defaultConfigId: enabled
          ? current.defaultConfigId
          : fallbackDefault(configs, current.defaultConfigId),
      };
    });

  const setModel = (config: WorkerConfig, value: string) => {
    // agy models carry their own effort, so the editor never keeps an explicit level for them.
    if (config.type === "agy") {
      update(config.id, { model: value || null, effort: null });
      return;
    }
    // A model change drops an effort the newly selected model does not support.
    const models = modelOptionsFor(
      { ...config, model: value || null },
      {
        agy: catalogView.agy,
        codex: catalogView.codex,
        pi: catalogView.pi,
        codexProviderModels:
          catalogView.codexModels[effectiveCodexProvider(config) ?? ""]?.value ?? null,
      },
    );
    const supported = effortOptionsFor(models, value || null, null).map(
      (option) => option.value,
    );
    update(config.id, {
      model: value || null,
      effort: supported.includes(config.effort ?? "") ? config.effort : null,
    });
  };

  const setProvider = (config: WorkerConfig, value: string) => {
    if (!config.codex) return;
    // Switching Codex inference service always clears model and effort.
    update(config.id, {
      model: null,
      effort: null,
      codex: { ...config.codex, modelProvider: value || null },
    });
  };

  const save = async () => {
    if (validationMessage) return;
    const submittedAcpIdle = acpIdleSupported && acpIdleTimeoutDirty;
    const body: WorkerSettingsUpdate = {
      configs: draft.configs.map((config) => {
        const name = config.name.trim();
        // agy effort always follows the selected model; a stale saved level is dropped here.
        if (config.type === "agy")
          return { ...config, name, roles: [...config.roles], effort: null };
        if (config.type !== "codex" || !config.codex)
          return { ...config, name, roles: [...config.roles] };
        return {
          ...config,
          name,
          roles: [...config.roles],
          codex: {
            ...config.codex,
            env: envResults[config.id]?.env ?? {},
          },
        };
      }),
      defaultConfigId: draft.defaultConfigId,
      retentionDays: Number(retentionDays),
      blockedProjectIds,
      ...(submittedAcpIdle
        ? { acpIdleTimeoutSeconds: Number(acpIdleTimeoutSeconds) }
        : {}),
    };
    setBusy(true);
    try {
      const value = await api.saveSettings(body);
      const responseSupportsAcpIdle = supportsAcpIdleTimeout(value);
      if (submittedAcpIdle && !responseSupportsAcpIdle) {
        onSaved(value, "");
        onError(
          "其他设置已保存，但当前 Worker 插件服务版本较旧，不支持保存 ACP 空闲关闭时间；请重启当前 CloudCLI 服务后重试。",
        );
      } else {
        onSaved(value);
      }
      const next = {
        configs: value.configs.map((config) => cloneConfig(config, config.name, config.id)),
        defaultConfigId: value.defaultConfigId,
      };
      setDraft(next);
      setEnvDraft(
        Object.fromEntries(
          value.configs
            .filter((config) => config.type === "codex")
            .map((config) => [config.id, envText(config.codex?.env ?? {})]),
        ),
      );
      setRetentionDays(String(value.retentionDays));
      setBlockedProjectIds([...(value.blockedProjectIds ?? [])]);
      setAcpIdleTimeoutSeconds(
        responseSupportsAcpIdle ? String(value.acpIdleTimeoutSeconds) : "",
      );
      setAcpIdleTimeoutDirty(false);
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
          <h2>Worker 配置</h2>
          <p>
            每个配置是一个可复用的执行引擎组合：启用开关、角色、并发、默认模型与
            reasoning。启用开关只阻止之后新建和续接；已接受的任务继续。
          </p>
        </div>
      </header>
      <div className="worker-form worker-settings-form">
        <section className="worker-settings-block">
          <label>
            默认 Worker 配置
            <select
              aria-label="默认 Worker 配置"
              value={draft.defaultConfigId}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  defaultConfigId: event.target.value,
                }))
              }
            >
              {!defaultConfig ? <option value="">请选择默认配置</option> : null}
              {draft.configs.map((config) => (
                <option key={config.id} value={config.id} disabled={!config.enabled}>
                  {config.name + " · " + TYPE_LABELS[config.type]}
                  {config.enabled ? "" : "（已停用）"}
                </option>
              ))}
            </select>
            <small>
              默认配置必须已启用；没有匹配角色的新任务使用它。满载仍按原有 FIFO 排队。
            </small>
          </label>
        </section>

        <p className="worker-sort-note">
          配置顺序决定角色匹配：任务角色命中时，从上到下使用第一个已启用且类型匹配的配置；
          排序在保存后生效。拖动左侧手柄，或用上移/下移按钮调整。
        </p>

        <div
          className="worker-settings-configs"
          onDragLeave={(event) => {
            const next = event.relatedTarget as Node | null;
            // Crossing between cards (or their children) keeps the target outline; only leaving
            // the whole list clears it. The functional update avoids a stale overId write-back.
            if (!next || event.currentTarget.contains(next)) return;
            setDragState((current) =>
              current ? { ...current, overId: null } : current,
            );
          }}
        >
        {draft.configs.map((config, index) => {
          const position = index + 1;
          const configUsage = usage[config.id];
          const engineLocked = Boolean(configUsage?.referenced);
          const active = (configUsage?.activeRuns ?? 0) > 0;
          const providerId =
            config.type === "codex" ? effectiveCodexProvider(config) : null;
          const modelsEntry = providerId
            ? catalogView.codexModels[providerId]
            : undefined;
          // Each card reports only the catalog sources it actually depends on, so a failure
          // for a provider this card has left can never surface here.
          const catalogProblems: CatalogProblem[] = [];
          let catalogLoading = false;
          if (config.type === "pi") {
            if (catalogView.errors.pi)
              catalogProblems.push({ message: catalogView.errors.pi, source: "pi" });
            catalogLoading = catalogView.loading.pi;
          } else if (config.type === "agy") {
            if (catalogView.errors.agy)
              catalogProblems.push({ message: catalogView.errors.agy, source: "agy" });
            catalogLoading = catalogView.loading.agy;
          } else {
            if (catalogView.errors.codex)
              catalogProblems.push({ message: catalogView.errors.codex, source: "codex" });
            if (catalogView.errors.codexDirectory)
              catalogProblems.push({
                message: catalogView.errors.codexDirectory,
                source: "codexDirectory",
              });
            if (providerId && modelsEntry?.status === "error")
              catalogProblems.push({
                message: modelsEntry.error,
                source: "codexProvider",
                provider: providerId,
              });
            catalogLoading =
              catalogView.loading.codex ||
              modelsEntry?.status === "loading" ||
              catalogView.loading.codexDirectory;
          }
          const models: ModelSelectOption[] = modelOptionsFor(config, {
            agy: catalogView.agy,
            codex: catalogView.codex,
            pi: catalogView.pi,
            codexProviderModels: modelsEntry?.value ?? null,
          });
          const efforts = effortOptionsFor(models, config.model, config.effort);
          const isDefault = draft.defaultConfigId === config.id;
          // Highlight this card as soon as a drag enters it (dragenter fires before the first
          // dragover); dragover then keeps the highlight and allows the drop.
          const markDropTarget = () => {
            if (!dragState || dragState.id === config.id || dragState.overId === config.id)
              return;
            setDragState({ ...dragState, overId: config.id });
          };
          return (
            <details
              className="worker-type-settings worker-form-wide"
              key={config.id}
              data-dragging={dragState?.id === config.id ? "true" : undefined}
              data-drop-target={
                dragState && dragState.id !== config.id && dragState.overId === config.id
                  ? "true"
                  : undefined
              }
              onDragEnter={markDropTarget}
              onDragOver={(event) => {
                if (!dragState || dragState.id === config.id) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                markDropTarget();
              }}
              onDrop={(event) => {
                if (!dragState) return;
                event.preventDefault();
                moveConfig(dragState.id, index);
                setDragState(null);
              }}
            >
              <summary aria-label={"配置 " + position + " " + config.name}>
                <span className="worker-sort">
                  <span
                    className="worker-drag-handle"
                    draggable
                    aria-hidden="true"
                    title="拖动调整配置顺序"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onDragStart={(event) => {
                      event.stopPropagation();
                      if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", config.id);
                      }
                      setDragState({ id: config.id, overId: null });
                    }}
                    onDragEnd={() => setDragState(null)}
                  >
                    <GripVertical size={14} />
                  </span>
                  <button
                    type="button"
                    className="worker-sort-button"
                    aria-label={"配置 " + position + " 上移 " + config.name}
                    disabled={index === 0}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      moveConfig(config.id, index - 1);
                    }}
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="worker-sort-button"
                    aria-label={"配置 " + position + " 下移 " + config.name}
                    disabled={index === draft.configs.length - 1}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      moveConfig(config.id, index + 1);
                    }}
                  >
                    <ChevronDown size={14} />
                  </button>
                </span>
                <span className="worker-type-identity">
                  <strong>{config.name || "未命名配置"}</strong>
                  <span className="worker-badge worker-muted">
                    {TYPE_LABELS[config.type]}
                  </span>
                  <span
                    className={"worker-badge " + (config.enabled ? "worker-ok" : "worker-muted")}
                  >
                    {config.enabled ? "已启用" : "已停用"}
                  </span>
                  {isDefault ? <span className="worker-badge worker-active">默认</span> : null}
                  <span className="worker-type-roles">
                    {config.roles.length
                      ? WORKER_TASK_ROLES.filter((role) => config.roles.includes(role.value))
                          .map((role) => TASK_ROLE_LABELS[role.value])
                          .join("、")
                      : "未设置角色"}
                  </span>
                </span>
                <span className="worker-type-overview">
                  <span className="worker-type-model" title={config.model ?? "沿用执行器模型"}>
                    {config.model ?? "沿用执行器模型"}
                  </span>
                  <span>并发 {config.concurrency}</span>
                  <span>硬超时 {config.hardTimeoutSeconds === null ? "不限时" : `${config.hardTimeoutSeconds} 秒`}</span>
                  {active ? <span>运行中 {configUsage!.activeRuns}</span> : null}
                </span>
                <ChevronRight size={16} className="worker-type-chevron" aria-hidden="true" />
              </summary>
              <div className="worker-type-fields">
                <div className="worker-config-main">
                <div className="worker-config-row worker-config-identity">
                <label>
                  配置名称
                  <input
                    type="text"
                    aria-label={"配置 " + position + " 名称"}
                    value={config.name}
                    onChange={(event) => update(config.id, { name: event.target.value })}
                  />
                </label>
                <label>
                  执行引擎
                  <select
                    aria-label={"配置 " + position + " 执行引擎"}
                    value={config.type}
                    disabled={engineLocked}
                    title={engineLocked ? "该配置已被任务历史引用，执行引擎不可更改。" : undefined}
                    onChange={(event) => {
                      const type = event.target.value as SupportedWorkerType;
                      update(config.id, {
                        type,
                        model: null,
                        effort: null,
                        ...(type === "codex"
                          ? {
                              codex: {
                                modelProvider: null,
                                env: {},
                                legacyExtraArgs: [],
                              },
                            }
                          : { codex: undefined }),
                      });
                      if (type === "codex")
                        setEnvDraft((current) => ({ ...current, [config.id]: "" }));
                    }}
                  >
                    {WORKER_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                  {engineLocked ? (
                    <small>该配置已被任务历史引用，执行引擎不可更改。</small>
                  ) : null}
                </label>
                <label>
                  并发
                  <input
                    type="number"
                    min="1"
                    step="1"
                    aria-label={"配置 " + position + " 并发"}
                    value={String(config.concurrency)}
                    onChange={(event) =>
                      update(config.id, { concurrency: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  硬超时（秒）
                  <input
                    type="number"
                    min="1"
                    step="1"
                    aria-label={"配置 " + position + " 硬超时（秒）"}
                    value={config.hardTimeoutSeconds ?? ""}
                    placeholder="不限时"
                    onChange={(event) => update(config.id, {
                      hardTimeoutSeconds: event.target.value === "" ? null : Number(event.target.value),
                    })}
                  />
                  <small>默认 600 秒；到时终止本轮运行，留空表示不限时。</small>
                </label>
                </div>
                <label className="worker-checkbox worker-form-wide">
                  <input
                    type="checkbox"
                    aria-label={"配置 " + position + " 启用"}
                    checked={config.enabled}
                    onChange={(event) => setEnabled(config, event.target.checked)}
                  />
                  <span>
                    启用 {config.name || "该配置"}
                    <small>
                      {active
                        ? "该配置仍有排队或运行中的任务；停用只阻止之后的新建和续接，已接受的任务继续。"
                        : "停用后仅阻止之后新建和续接；配置内容保留，可随时重新启用。"}
                    </small>
                  </span>
                </label>
                <div className="worker-config-row">
                {config.type === "codex" ? (
                  <label>
                    Codex 模型服务
                    <select
                      aria-label={"配置 " + position + " Codex 模型服务"}
                      value={config.codex?.modelProvider ?? ""}
                      onChange={(event) => setProvider(config, event.target.value)}
                    >
                      <option value="">使用默认模型服务</option>
                      {(catalogView.codexDirectory?.providers ?? []).map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name || provider.id}
                        </option>
                      ))}
                      {config.codex?.modelProvider &&
                      !catalogView.codexDirectory?.providers.some(
                        (provider) => provider.id === config.codex!.modelProvider,
                      ) ? (
                        <option value={config.codex.modelProvider}>
                          {config.codex.modelProvider + "（当前已保存）"}
                        </option>
                      ) : null}
                    </select>
                  </label>
                ) : null}
                <label>
                  模型
                  <select
                    aria-label={"配置 " + position + " 模型"}
                    value={config.model ?? ""}
                    onChange={(event) => setModel(config, event.target.value)}
                  >
                    {models.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {config.type === "agy" ? (
                    <small>
                      模型列表来自本机 agy models；留空沿用执行器自身默认。
                    </small>
                  ) : null}
                </label>
                <label>
                  Reasoning
                  {config.type === "agy" ? (
                    <>
                      <select
                        aria-label={"配置 " + position + " reasoning"}
                        value=""
                        disabled
                      >
                        <option value="">默认（随模型）</option>
                      </select>
                      <small>agy 模型自带 effort，保存时沿用所选模型默认。</small>
                    </>
                  ) : (
                    <select
                      aria-label={"配置 " + position + " reasoning"}
                      value={config.effort ?? ""}
                      onChange={(event) =>
                        update(config.id, { effort: event.target.value || null })
                      }
                    >
                      {efforts.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label || DEFAULT_EFFORT_LABEL}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
                </div>
                {catalogProblems.length ? (
                  catalogProblems.map((problem) => (
                    <div
                      className="worker-form-wide worker-error"
                      role="alert"
                      key={problem.source + (problem.provider ?? "")}
                    >
                      <span>
                        模型目录读取失败，已保留当前配置值：{problem.message}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          catalogView.retry(problem.source, problem.provider)
                        }
                      >
                        <RefreshCw size={13} /> 重试
                      </button>
                    </div>
                  ))
                ) : catalogLoading ? (
                  <small className="worker-form-wide worker-muted">正在读取模型目录…</small>
                ) : null}
                {config.type === "codex" ? (
                  <label className="worker-form-wide">
                    额外环境变量（每行一个 KEY=VALUE）
                    <textarea
                      rows={3}
                      spellCheck={false}
                      aria-label={"配置 " + position + " Codex 环境变量"}
                      placeholder={"EXAMPLE_KEY=example value\nHTTPS_PROXY=http://127.0.0.1:7890"}
                      value={envDraft[config.id] ?? ""}
                      onChange={(event) =>
                        setEnvDraft((current) => ({
                          ...current,
                          [config.id]: event.target.value,
                        }))
                      }
                    />
                    <small>
                      覆盖继承环境中的同名变量；按首个 = 分割，值中的空格和后续 = 保留。
                      留空表示不注入额外变量。
                    </small>
                  </label>
                ) : null}
                <div className="worker-form-wide worker-config-actions">
                  <button
                    type="button"
                    aria-label={"配置 " + position + " 设为默认"}
                    disabled={!config.enabled || isDefault}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        defaultConfigId: config.id,
                      }))
                    }
                  >
                    设为默认
                  </button>
                  <button
                    type="button"
                    aria-label={"配置 " + position + " 复制"}
                    onClick={() => duplicate(config)}
                  >
                    <Copy size={13} /> 复制
                  </button>
                  <button
                    type="button"
                    className="worker-danger"
                    aria-label={"配置 " + position + " 删除"}
                    disabled={active}
                    title={
                      active
                        ? "该配置仍有排队或运行中的任务，全部进入终态后才能删除。"
                        : "删除只移除配置；历史任务与日志保留，但之后无法用该配置续接。"
                    }
                    onClick={() => remove(config)}
                  >
                    <Trash2 size={13} /> 删除
                  </button>
                  {active ? (
                    <small>运行中或排队中的任务结束后才能删除。</small>
                  ) : configUsage?.referenced ? (
                    <small>删除只移除配置；历史任务与日志保留，但之后无法用该配置续接。</small>
                  ) : null}
                </div>
                </div>
                <div className="worker-config-side">
                  <div
                    className="worker-roles"
                    role="group"
                    aria-label={"配置 " + position + " 倾向任务（可多选）"}
                  >
                    <span className="worker-roles-label">倾向任务（可多选）</span>
                    {WORKER_TASK_ROLES.map((role) => (
                      <label className="worker-checkbox" key={role.value}>
                        <input
                          type="checkbox"
                          aria-label={
                            "配置 " + position + " 任务角色 " + role.label
                          }
                          checked={config.roles.includes(role.value as WorkerTaskRole)}
                          onChange={() =>
                            update(config.id, {
                              roles: config.roles.includes(role.value as WorkerTaskRole)
                                ? config.roles.filter((item) => item !== role.value)
                                : [...config.roles, role.value as WorkerTaskRole],
                            })
                          }
                        />
                        <span>
                          {TASK_ROLE_LABELS[role.value as WorkerTaskRole]}
                          <small>{role.description}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </details>
          );
        })}
        </div>
        <div className="worker-form-wide worker-config-add">
          <span className="worker-muted">新增配置</span>
          <div className="worker-config-add-actions">
            {WORKER_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                aria-label={"新增 " + TYPE_LABELS[type] + " 配置"}
                onClick={() => addConfig(type)}
              >
                <Plus size={13} /> {TYPE_LABELS[type]}
              </button>
            ))}
          </div>
        </div>

        <section className="worker-settings-block">
          <div className="worker-roles worker-project-list">
            <span className="worker-roles-label">关闭 Worker 的项目（可多选）</span>
            <p>
              勾选并保存后，该项目的新旧会话从下一条提示词起由主会话直接处理。已派发的
              Worker 任务可以继续运行。取消勾选并保存后即可恢复 Worker。
            </p>
            {projectOptions.map((project) => {
              const checked = blockedProjectIds.includes(project.id);
              return (
                <label className="worker-checkbox" key={project.id}>
                  <input
                    type="checkbox"
                    aria-label={"关闭项目 " + project.name + " 的 Worker"}
                    checked={checked}
                    onChange={() =>
                      setBlockedProjectIds((current) =>
                        current.includes(project.id)
                          ? current.filter((id) => id !== project.id)
                          : [...current, project.id],
                      )
                    }
                  />
                  <span>
                    {project.name}
                    {project.path ? <small>{project.path}</small> : null}
                  </span>
                </label>
              );
            })}
            {projectCatalog.status === "loading" && !projectCatalog.value ? (
              <small>正在加载项目列表…</small>
            ) : null}
            {projectCatalog.status === "error" ? (
              <small className="worker-error" role="alert">
                项目列表加载失败：{projectCatalog.error}{" "}
                <button
                  type="button"
                  className="worker-soft"
                  onClick={() => setProjectAttempt((value) => value + 1)}
                >
                  重试
                </button>
              </small>
            ) : null}
            {projectCatalog.status === "ready" && !projectOptions.length ? (
              <small>暂无可选项目。</small>
            ) : null}
          </div>
        </section>
        <section className="worker-settings-block">
          <label>
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
          <div className="worker-settings-split">
            <label>
              ACP 空闲关闭时间（秒）
              {acpIdleSupported ? (
                <>
                  <input
                    type="number"
                    min="1"
                    max={ACP_IDLE_TIMEOUT_MAX_SECONDS}
                    step="1"
                    aria-label="ACP 空闲关闭时间（秒）"
                    value={acpIdleTimeoutSeconds}
                    onChange={(event) => {
                      setAcpIdleTimeoutSeconds(event.target.value);
                      setAcpIdleTimeoutDirty(true);
                    }}
                  />
                  <small>
                    默认 {ACP_IDLE_TIMEOUT_DEFAULT_SECONDS} 秒（5 分钟）。AGY
                    在最后一个任务结束后开始计时。
                  </small>
                </>
              ) : (
                <>
                  <input
                    type="text"
                    aria-label="ACP 空闲关闭时间（秒）"
                    value=""
                    placeholder="当前后端版本暂不支持"
                    disabled
                  />
                  <small>
                    当前 Worker 插件服务版本较旧，暂不支持配置 ACP 空闲关闭时间；重启当前
                    CloudCLI 服务后即可修改，其他设置仍可正常保存。
                  </small>
                </>
              )}
            </label>
            <div className="worker-agy-quota" aria-label="AGY 账号剩余额度">
              <div className="worker-agy-quota-head">
                <strong>AGY 账号剩余额度</strong>
                <button
                  type="button"
                  className="worker-agy-quota-refresh"
                  aria-label="刷新 AGY 账号剩余额度"
                  disabled={agyQuotaRefreshing || agyQuota.status === "loading"}
                  onClick={() => loadAgyQuota("refresh")}
                >
                  <RefreshCw
                    size={12}
                    className={
                      agyQuotaRefreshing || agyQuota.status === "loading"
                        ? "worker-spin"
                        : undefined
                    }
                  />
                  {agyQuotaRefreshing ? "刷新中…" : "刷新"}
                </button>
              </div>
              {agyQuota.status === "loading" && !agyQuota.groups.length ? (
                <small>正在获取 AGY 账号剩余额度…</small>
              ) : null}
              {agyQuota.status === "error" ? (
                <div className="worker-error" role="alert">
                  获取失败：{agyQuota.error || "AGY 额度查询失败"}
                </div>
              ) : null}
              {agyQuota.groups.length ? (
                <div className="worker-agy-quota-groups">
                  {agyQuota.groups.map((group) => (
                    <div className="worker-agy-quota-group" key={group.name}>
                      <small>{group.name}</small>
                      <div className="worker-agy-quota-buckets">
                        {group.buckets.map((bucket) => {
                          const resetLabel = formatQuotaTime(bucket.resetAt, true);
                          return (
                            <span
                              className="worker-agy-quota-bucket"
                              key={bucket.id}
                            >
                              <span className="worker-muted">
                                {quotaWindowLabel(bucket)}
                              </span>
                              <strong
                                className={
                                  "worker-agy-quota-percent " +
                                  quotaPercentClass(bucket.remainingPercent)
                                }
                              >
                                {bucket.remainingPercent}%
                              </strong>
                              {resetLabel ? (
                                <span className="worker-muted">
                                  ({resetLabel} 重置)
                                </span>
                              ) : null}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : agyQuota.status === "ready" ? (
                <small>暂无可用额度数据。</small>
              ) : null}
              {agyQuota.updatedAt ? (
                <small>
                  更新于 {formatQuotaTime(agyQuota.updatedAt, false)} · 每 5 分钟自动更新
                </small>
              ) : null}
            </div>
          </div>
        </section>
        <footer className="worker-settings-footer">
          <p>
            每个配置的并发按 (父会话, 项目, 配置) 独立计算；启动中、运行中、停止中和状态未知的
            run 都占用额度，超过额度按 FIFO 排队。角色只影响新任务选择哪个配置，按列表顺序取第一个命中项；
            没有匹配时使用默认配置。
            模型或 reasoning 留空表示沿用执行器现有配置；未知或目录外已保存的值会显示为“当前已保存”，
            普通保存不会清掉它们。软提醒默认 {settings.softReminderSeconds} 秒 /{" "}
            {settings.softReminderSteps} 步。硬超时按各配置设置，默认 600 秒，新建和续接均适用；
            单次任务显式指定的超时优先，修改配置不影响已接受的运行。
          </p>
          {validationMessage ? (
            <p className="worker-error" role="alert">
              {validationMessage}
            </p>
          ) : null}
          <button
            className="worker-primary worker-settings-save"
            disabled={busy || Boolean(validationMessage)}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存设置"}
          </button>
        </footer>
      </div>
    </>
  );
}
