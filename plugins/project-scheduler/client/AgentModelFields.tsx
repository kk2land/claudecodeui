import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SchedulerHost,
  SchedulerModelCatalog,
  SchedulerModelOption,
} from "./api.js";

/** The only providers whose host model catalog the scheduler may read. */
export type AgentProvider = "codex" | "dsh";
/** One provider's catalog request state; errors keep authored values usable. */
export type AgentCatalogEntry =
  | { status: "loading" }
  | { status: "error"; error: string; unsupported: boolean }
  | { status: "ready"; catalog: SchedulerModelCatalog };
/** Catalog state for both schedulable providers, shared by the defaults and task forms. */
export type AgentModelCatalogs = Record<AgentProvider, AgentCatalogEntry>;
/** One coordinated agent edit; undefined deletes the property so the default is inherited. */
export type AgentSelectionChange = {
  provider?: string;
  model?: string;
  effort?: string;
};

const INHERIT = "";
const DEFAULT_EFFORT = "default";

const loadingCatalogs = (): AgentModelCatalogs => ({
  codex: { status: "loading" },
  dsh: { status: "loading" },
});

function isProvider(value: string): value is AgentProvider {
  return value === "codex" || value === "dsh";
}

/** Rejects malformed host responses instead of rendering a half-valid catalog. */
function readCatalog(value: unknown): SchedulerModelCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("模型目录格式无效");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.OPTIONS)) throw new Error("模型目录缺少 OPTIONS");
  const options: SchedulerModelOption[] = [];
  for (const raw of record.OPTIONS) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const option = raw as Record<string, unknown>;
    if (typeof option.value !== "string" || !option.value) continue;
    const effort = option.effort;
    let parsedEffort: SchedulerModelOption["effort"];
    if (effort && typeof effort === "object" && !Array.isArray(effort)) {
      const effortRecord = effort as Record<string, unknown>;
      const values = Array.isArray(effortRecord.values)
        ? effortRecord.values.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry))
              return [];
            const row = entry as Record<string, unknown>;
            if (typeof row.value !== "string" || !row.value) return [];
            return [
              {
                value: row.value,
                ...(typeof row.description === "string" && row.description
                  ? { description: row.description }
                  : {}),
              },
            ];
          })
        : [];
      if (values.length)
        parsedEffort = {
          values,
          ...(typeof effortRecord.default === "string" && effortRecord.default
            ? { default: effortRecord.default }
            : {}),
        };
    }
    options.push({
      value: option.value,
      label:
        typeof option.label === "string" && option.label
          ? option.label
          : option.value,
      ...(typeof option.description === "string" && option.description
        ? { description: option.description }
        : {}),
      ...(parsedEffort ? { effort: parsedEffort } : {}),
    });
  }
  return {
    DEFAULT: typeof record.DEFAULT === "string" ? record.DEFAULT : "",
    OPTIONS: options,
  };
}

/**
 * Loads both provider catalogs through the optional host method. Requests are tracked per
 * provider and invalidated on retry/unmount, so a slow older response can never replace a newer
 * one. A host without the method reports one explicit unsupported error per provider.
 */
export function useAgentModelCatalogs(
  host: SchedulerHost,
  enabled: boolean,
): { catalogs: AgentModelCatalogs; retry(): void; canRetry: boolean } {
  // Catalog results are shared state: both the defaults form and every task form read them.
  const [catalogs, setCatalogs] = useState<AgentModelCatalogs>(loadingCatalogs);
  // Bumping this counter starts a fresh pair of requests after an explicit retry.
  const [attempt, setAttempt] = useState(0);
  const requestIds = useRef<Record<AgentProvider, number>>({
    codex: 0,
    dsh: 0,
  });
  const canRetry = typeof host.models === "function";
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // Capture the mutable counter object itself so cleanup never reads a possibly new ref value.
    const ids = requestIds.current;
    const load = async (provider: AgentProvider) => {
      const requestId = ++ids[provider];
      if (typeof host.models !== "function") {
        if (live && requestId === ids[provider])
          setCatalogs((current) => ({
            ...current,
            [provider]: {
              status: "error",
              error: "当前宿主未提供模型目录接口",
              unsupported: true,
            },
          }));
        return;
      }
      setCatalogs((current) => ({
        ...current,
        [provider]: { status: "loading" },
      }));
      try {
        const catalog = readCatalog(await host.models(provider));
        if (!live || requestId !== ids[provider]) return;
        setCatalogs((current) => ({
          ...current,
          [provider]: { status: "ready", catalog },
        }));
      } catch (error) {
        if (!live || requestId !== ids[provider]) return;
        setCatalogs((current) => ({
          ...current,
          [provider]: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            unsupported: false,
          },
        }));
      }
    };
    void load("codex");
    void load("dsh");
    return () => {
      live = false;
      // Invalidate both in-flight requests so a late response cannot land after cleanup.
      ids.codex++;
      ids.dsh++;
    };
  }, [enabled, host, attempt]);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { catalogs, retry, canRetry };
}

function modelOptionFor(
  catalog: SchedulerModelCatalog,
  model: string,
): SchedulerModelOption | undefined {
  // Config "default" means the host's default catalog entry, whose real effort levels apply.
  if (model === "default" || !model)
    return catalog.OPTIONS.find((option) => option.value === catalog.DEFAULT);
  return catalog.OPTIONS.find((option) => option.value === model);
}
function modelLabel(catalog: SchedulerModelCatalog | null, value: string): string {
  if (!catalog || !value) return value;
  const option = modelOptionFor(catalog, value);
  return option?.label ?? value;
}

type AgentModelFieldsProps = {
  /** Defaults edit the project fallback; tasks may inherit that fallback. */
  scope: "defaults" | "task";
  /** Raw authored provider; empty means inherit. */
  provider: string;
  /** Raw authored model; empty means inherit. */
  model: string;
  /** Raw authored effort; empty means inherit, "default" means no CLI effort. */
  effort: string;
  /** Resolved project defaults used to label and resolve task inheritance. */
  fallbackProvider: string;
  fallbackModel: string;
  fallbackEffort?: string;
  catalogs: AgentModelCatalogs;
  canRetry: boolean;
  onRetry(): void;
  onChange(change: AgentSelectionChange): void;
};

/**
 * Used by the scheduler configuration editor's defaults and task forms to choose a provider,
 * model, and that model's real effort levels from the host catalog. Authored values stay intact
 * when a catalog is unavailable, and provider/model edits reset incompatible explicit values.
 */
export function AgentModelFields({
  scope,
  provider,
  model,
  effort,
  fallbackProvider,
  fallbackModel,
  fallbackEffort,
  catalogs,
  canRetry,
  onRetry,
  onChange,
}: AgentModelFieldsProps) {
  const inheritedProvider = isProvider(fallbackProvider)
    ? fallbackProvider
    : "codex";
  const effectiveProvider = isProvider(provider) ? provider : inheritedProvider;
  const entry = catalogs[effectiveProvider];
  const catalog = entry.status === "ready" ? entry.catalog : null;

  // A task inherits the project model only while it keeps the project's provider.
  const inheritedModel =
    (scope === "task" && fallbackProvider === effectiveProvider
      ? fallbackModel
      : "") ||
    "default";
  const effectiveModel = model || inheritedModel;
  const modelOption = catalog
    ? modelOptionFor(catalog, effectiveModel)
    : undefined;
  const effortValues = modelOption?.effort?.values ?? [];
  const modelEffortDefault = modelOption?.effort?.default;

  // Inherited effort requires the same provider and the same effective model, mirroring parseTasks.
  const inheritedEffort =
    scope === "task" &&
    fallbackEffort &&
    fallbackEffort !== "" &&
    fallbackProvider === effectiveProvider &&
    fallbackModel === effectiveModel
      ? fallbackEffort
      : undefined;
  const effectiveEffort = effort || inheritedEffort || "";
  const unknownEffort =
    effort !== "" &&
    effort !== DEFAULT_EFFORT &&
    !effortValues.some((level) => level.value === effort);
  const unknownModel =
    model !== "" && Boolean(catalog) && !modelOption;
  const modelLoading = entry.status === "loading";
  const catalogError = entry.status === "error" ? entry.error : null;
  const unsupportedHost = entry.status === "error" && entry.unsupported;

  const changeProvider = (next: string) => {
    if (next === provider) return;
    // Switching provider drops the previous model and pins effort to default, so neither a model
    // nor an effort from another provider can be inherited by accident.
    onChange({ provider: next || undefined, model: undefined, effort: DEFAULT_EFFORT });
  };
  const changeModel = (next: string) => {
    if (next === model) return;
    // An explicit effort belongs to one model; reset it instead of forwarding an unknown level.
    onChange({ model: next || undefined, effort: DEFAULT_EFFORT });
  };
  const changeEffort = (next: string) => {
    if (next === effort) return;
    onChange({ effort: next || undefined });
  };

  const modelInheritLabel =
    scope === "defaults"
      ? "继承/默认" +
        (catalog?.DEFAULT ? "（" + modelLabel(catalog, catalog.DEFAULT) + "）" : "")
      : "继承项目默认" +
        "（" + modelLabel(catalog, inheritedModel) + "）";
  const effortInheritLabel =
    scope === "defaults"
      ? "继承/未设置（使用模型默认）"
      : "继承项目默认" +
        (inheritedEffort ? "（" + inheritedEffort + "）" : "（无有效继承，使用模型默认）");

  return (
    <>
      <label>
        {scope === "defaults" ? "defaults.agent.provider" : "provider"}
        <select
          aria-label={scope === "defaults" ? "默认 agent provider" : "任务 provider"}
          value={provider}
          onChange={(event) => changeProvider(event.target.value)}
        >
          <option value={INHERIT}>
            {scope === "defaults"
              ? "继承（codex）"
              : "继承项目默认（" + inheritedProvider + "）"}
          </option>
          <option value="codex">codex</option>
          <option value="dsh">dsh</option>
        </select>
      </label>
      <label>
        {scope === "defaults" ? "defaults.agent.model" : "model"}
        <select
          aria-label={scope === "defaults" ? "默认 agent model" : "任务 model"}
          value={model}
          onChange={(event) => changeModel(event.target.value)}
        >
          <option value={INHERIT}>{modelInheritLabel}</option>
          {model &&
            model !== "default" &&
            (!catalog ||
              !catalog.OPTIONS.some((option) => option.value === model)) && (
              <option value={model}>{model}（当前文件，未在目录中）</option>
            )}
          {!catalog?.OPTIONS.some((option) => option.value === "default") && (
            <option value="default">default（显式使用宿主默认）</option>
          )}
          {catalog?.OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
              {option.description ? " · " + option.description : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        {scope === "defaults" ? "defaults.agent.effort" : "effort"}
        <select
          aria-label={scope === "defaults" ? "默认 agent effort" : "任务 effort"}
          value={effort}
          // Without catalog levels only inherited/default choices are real; keep the select usable
          // when the file already has an explicit level so it can be cleared.
          disabled={!effortValues.length && !effort && !inheritedEffort}
          onChange={(event) => changeEffort(event.target.value)}
        >
          <option value={INHERIT}>{effortInheritLabel}</option>
          <option value={DEFAULT_EFFORT}>default（不向 CLI 传 effort）</option>
          {effortValues.map((level) => (
            <option key={level.value} value={level.value}>
              {level.value}
              {level.description ? " · " + level.description : ""}
              {level.value === modelEffortDefault ? "（模型默认）" : ""}
            </option>
          ))}
          {unknownEffort && (
            <option value={effort}>{effort}（当前文件，未在目录中）</option>
          )}
        </select>
        <small>
          {!effort && inheritedEffort
            ? "生效：继承项目默认 " + inheritedEffort
            : !effort && !inheritedEffort
              ? effectiveEffort === DEFAULT_EFFORT
                ? "生效：default，不传 effort"
                : "未显式设置；使用模型默认" +
                  (modelEffortDefault ? "（" + modelEffortDefault + "）" : "")
              : "显式 " + effort}
        </small>
      </label>
      <div className="cron-agent-status" role="status">
        {modelLoading && <small>正在加载 {effectiveProvider} 模型目录…</small>}
        {catalogError && (
          <small className="cron-editor-invalid" role="alert">
            {unsupportedHost
              ? "当前宿主未提供模型目录接口，无法加载模型/effort 列表；文件中的已有值会保留，可继续使用继承/default。"
              : "模型目录加载失败：" + catalogError + "。文件中的已有值会保留。"}
            {canRetry && (
              <button type="button" onClick={onRetry}>
                重试加载
              </button>
            )}
          </small>
        )}
        {catalog && !catalog.OPTIONS.length && (
          <small>模型目录为空；只能使用继承/default，不会伪造可选模型。</small>
        )}
        {unknownModel && (
          <small>
            当前模型 “{model}” 不在目录中；已保留原值，不会自动改写。
          </small>
        )}
        {unknownEffort && (
          <small>
            当前 effort “{effort}” 不在该模型的目录中；已保留原值，不会自动改写。
          </small>
        )}
        {effortValues.length === 0 && !modelLoading && !catalogError && (
          <small>
            当前模型没有声明 effort 级别，无法提供 effort 选项；不会伪造支持。
            {effort && effort !== DEFAULT_EFFORT
              ? "文件中的 “" + effort + "” 会保留，可改为继承或 default。"
              : ""}
          </small>
        )}
        {effectiveProvider === "dsh" &&
          effectiveModel === "default" &&
          effectiveEffort !== "" &&
          effectiveEffort !== DEFAULT_EFFORT && (
            <small className="cron-editor-invalid">
              DSH headless 只有显式 model（provider/model）才能使用 effort；当前继承的 effort
              会在保存预览时被拒绝。
            </small>
          )}
      </div>
    </>
  );
}
