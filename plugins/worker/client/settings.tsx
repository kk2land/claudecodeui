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
  CodexModelsDirectory,
  PiModelCatalog,
  WorkerConfig,
  WorkerConfigUsage,
  WorkerModelCatalog,
  WorkerSettings,
  WorkerSettingsUpdate,
  WorkerTaskRole,
  WorkerType,
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

const WORKER_TYPES: WorkerType[] = ["dsh", "pi", "codex"];

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
function nextConfigName(configs: WorkerConfig[], type: WorkerType): string {
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

function blankConfig(type: WorkerType, name: string, id: string): WorkerConfig {
  return {
    id,
    name,
    type,
    enabled: true,
    roles: [],
    concurrency: 3,
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
  source: "dsh" | "pi" | "codex" | "codexDirectory" | "codexProvider";
  provider?: string;
};

type CatalogView = {
  dsh: WorkerModelCatalog | null;
  codex: WorkerModelCatalog | null;
  pi: PiModelCatalog | null;
  codexDirectory: CodexModelsDirectory | null;
  codexModels: Record<string, Loadable<string[]>>;
  errors: {
    dsh?: string;
    pi?: string;
    codex?: string;
    codexDirectory?: string;
  };
  loading: {
    dsh: boolean;
    pi: boolean;
    codex: boolean;
    codexDirectory: boolean;
  };
  retry(
    source: "dsh" | "pi" | "codex" | "codexDirectory" | "codexProvider",
    provider?: string,
  ): void;
};

type SettingsViewProps = {
  settings: WorkerSettings;
  usage: Record<string, WorkerConfigUsage>;
  host: WorkerHost;
  api: ReturnType<typeof workerApi>;
  onBack(): void;
  onSaved(settings: WorkerSettings): void;
  onError(message: string): void;
};

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

  const [dshCatalog, setDshCatalog] = useState<Loadable<WorkerModelCatalog>>(loading());
  const [codexCatalog, setCodexCatalog] = useState<Loadable<WorkerModelCatalog>>(loading());
  const [piCatalog, setPiCatalog] = useState<Loadable<PiModelCatalog>>(loading());
  const [codexDirectory, setCodexDirectory] = useState<Loadable<CodexModelsDirectory>>(loading());
  const [codexModels, setCodexModels] = useState<Record<string, Loadable<string[]>>>({});
  // Mirrors codexModels so the fetch effect can decide from the latest cache without
  // re-running on every response, and request tokens stop a stale response from overwriting
  // the result of a later explicit retry.
  const codexModelsRef = useRef<Record<string, Loadable<string[]>>>({});
  const providerRequestTokens = useRef<Record<string, number>>({});
  const [dshAttempt, setDshAttempt] = useState(0);
  const [codexAttempt, setCodexAttempt] = useState(0);
  const [piAttempt, setPiAttempt] = useState(0);
  const [directoryAttempt, setDirectoryAttempt] = useState(0);
  const [providerAttempt, setProviderAttempt] = useState(0);
  const inFlightProviders = useRef(new Set<string>());

  // Catalogs are optional host capabilities: a failure only affects that engine's selects.
  useEffect(() => {
    let live = true;
    setDshCatalog((current) => loading(current.value));
    readHostModels(host, "dsh")
      .then((value) => live && setDshCatalog({ status: "ready", value, error: "" }))
      .catch((error) => live && setDshCatalog({ status: "error", value: null, error: String(error) }));
    return () => {
      live = false;
    };
  }, [host, dshAttempt]);

  useEffect(() => {
    let live = true;
    setCodexCatalog((current) => loading(current.value));
    readHostModels(host, "codex")
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
    dsh: dshCatalog.value,
    codex: codexCatalog.value,
    pi: piCatalog.value,
    codexDirectory: codexDirectory.value,
    codexModels,
    errors: {
      dsh: dshCatalog.status === "error" ? dshCatalog.error : undefined,
      pi: piCatalog.status === "error" ? piCatalog.error : undefined,
      codex: codexCatalog.status === "error" ? codexCatalog.error : undefined,
      codexDirectory:
        codexDirectory.status === "error" ? codexDirectory.error : undefined,
    },
    loading: {
      dsh: dshCatalog.status === "loading",
      pi: piCatalog.status === "loading",
      codex: codexCatalog.status === "loading",
      codexDirectory: codexDirectory.status === "loading",
    },
    retry(source, provider) {
      if (source === "dsh") setDshAttempt((value) => value + 1);
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
        : draft.configs.find(
              (config) =>
                config.type === "dsh" && config.effort && !config.model,
            )
          ? "DSH reasoning 需要同时配置 DSH 模型。"
          : codexNameWithEnvError
          ? "配置 " +
            codexNameWithEnvError.name +
            "：" +
            envResults[codexNameWithEnvError.id]!.error
          : !validNumber(retentionDays)
            ? "保留天数必须是大于 0 的整数。"
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

  const addConfig = (type: WorkerType) => {
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
    // A model change drops an effort the newly selected model does not support.
    const models = modelOptionsFor(
      { ...config, model: value || null },
      {
        dsh: catalogView.dsh,
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
    const body: WorkerSettingsUpdate = {
      configs: draft.configs.map((config) => {
        const name = config.name.trim();
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
    };
    setBusy(true);
    try {
      const value = await api.saveSettings(body);
      onSaved(value);
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
          if (config.type === "dsh") {
            if (catalogView.errors.dsh)
              catalogProblems.push({ message: catalogView.errors.dsh, source: "dsh" });
            catalogLoading = catalogView.loading.dsh;
          } else if (config.type === "pi") {
            if (catalogView.errors.pi)
              catalogProblems.push({ message: catalogView.errors.pi, source: "pi" });
            catalogLoading = catalogView.loading.pi;
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
            dsh: catalogView.dsh,
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
                      const type = event.target.value as WorkerType;
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
                </label>
                <label>
                  Reasoning
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
        </section>
        <footer className="worker-settings-footer">
          <p>
            每个配置的并发按 (父会话, 项目, 配置) 独立计算；启动中、运行中、停止中和状态未知的
            run 都占用额度，超过额度按 FIFO 排队。角色只影响新任务选择哪个配置，按列表顺序取第一个命中项；
            没有匹配时使用默认配置。
            模型或 reasoning 留空表示沿用执行器现有配置；未知或目录外已保存的值会显示为“当前已保存”，
            普通保存不会清掉它们。软提醒默认 {settings.softReminderSeconds} 秒 /{" "}
            {settings.softReminderSteps} 步，硬超时
            {settings.hardTimeoutSeconds === null
              ? "默认关闭"
              : "默认 " + settings.hardTimeoutSeconds + " 秒"}
            。
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
