import type {
  CodexModelsDirectory,
  CodexServiceModelCatalog,
  DshModelCatalog,
  PiModelCatalog,
  WorkerModelCatalog,
  WorkerModelOption,
  WorkerType,
} from "../shared/contracts.js";
import type { WorkerHost } from "./api.js";

/**
 * Model/effort select rows and the pure option builders used by the Worker config editor.
 * `value: ""` always means "runner default" and is persisted as `null`, never as a string.
 */
export type SelectOption = { value: string; label: string };

/** One model row plus the effort levels the catalog reports for that model. */
export type ModelSelectOption = SelectOption & { effort: string[] };

export const DEFAULT_MODEL_LABEL = "使用默认值";
export const DEFAULT_EFFORT_LABEL = "默认（沿用执行器）";
export const SAVED_SUFFIX = "（当前已保存）";

/**
 * Reads the optional host Codex model catalog. A missing capability rejects so the editor shows a
 * local, retryable error instead of pretending the catalog is empty. DSH has no host entry: the
 * plugin serves its own directory from `DSH_HOME`.
 */
export async function readHostModels(
  host: WorkerHost,
): Promise<WorkerModelCatalog> {
  if (!host.models) throw new Error("宿主未提供 Codex 模型目录");
  return host.models("codex");
}

/** Reads the Codex inference-service directory; never carries provider credentials. */
export async function readCodexProviders(
  host: WorkerHost,
): Promise<CodexModelsDirectory> {
  if (!host.codexModelProviders)
    throw new Error("宿主未提供 Codex 模型服务目录");
  return host.codexModelProviders();
}

/** Reads the models of one Codex inference service. */
export async function readCodexProviderModels(
  host: WorkerHost,
  modelProvider: string,
): Promise<CodexServiceModelCatalog> {
  if (!host.codexModelProviderModels)
    throw new Error("宿主未提供 Codex 模型服务模型目录");
  return host.codexModelProviderModels(modelProvider);
}

function effortValues(option: WorkerModelOption | undefined): string[] {
  return option?.effort?.values.map((value) => value.value) ?? [];
}

/** Keeps an out-of-catalog stored model selectable so a load or plain save never drops it. */
function withSavedModel(
  options: ModelSelectOption[],
  model: string | null,
  effort: string | null,
): ModelSelectOption[] {
  if (!model || options.some((option) => option.value === model)) return options;
  return [
    ...options,
    { value: model, label: model + SAVED_SUFFIX, effort: effort ? [effort] : [] },
  ];
}

/**
 * DSH model rows from the plugin's own directory. The route is the exact persisted `model` value
 * (`provider/model`); DSH applies reasoning only to an explicit model, so the default row carries
 * no levels.
 */
export function dshModelOptions(
  catalog: DshModelCatalog | null,
  model: string | null,
  effort: string | null,
): ModelSelectOption[] {
  const options: ModelSelectOption[] = [
    { value: "", label: DEFAULT_MODEL_LABEL, effort: [] },
    ...(catalog?.models ?? []).map((option) => ({
      value: option.route,
      label: option.label,
      effort: option.efforts,
    })),
  ];
  return withSavedModel(options, model, effort);
}

/**
 * DSH effort levels for the current route: the levels the static directory declares for a listed
 * model, the engine's levels for a route typed outside the directory, and none while no model is
 * selected because DSH applies reasoning only to an explicit model.
 */
export function dshEffortLevels(
  catalog: DshModelCatalog | null,
  model: string | null,
): string[] {
  if (!model) return [];
  return (
    catalog?.models.find((option) => option.route === model)?.efforts ??
    catalog?.effortLevels ??
    []
  );
}

/**
 * Codex model rows. The candidates are always the models the configured inference service
 * actually returns for its effective id (`modelProvider`, or the directory's `defaultProvider`
 * when the config keeps Codex's default service); the host `models('codex')` catalog is only
 * metadata used to label those ids and expose their effort levels. While the service directory
 * or its models are unavailable `providerModels` is null and only the null default plus any
 * already stored model/effort stay selectable.
 */
export function codexModelOptions(
  metadata: WorkerModelCatalog | null,
  providerModels: string[] | null,
  model: string | null,
  effort: string | null,
): ModelSelectOption[] {
  const options: ModelSelectOption[] = (providerModels ?? []).map((id) => {
    // Service lists may namespace ids (for example `openai/gpt-6-astra`) while the host catalog
    // keys the same model without that prefix. Only labels/effort come from metadata; the
    // selectable value always remains the exact service id.
    const known =
      metadata?.OPTIONS.find((option) => option.value === id) ??
      metadata?.OPTIONS.find(
        (option) => option.value === id.slice(id.lastIndexOf("/") + 1),
      );
    return {
      value: id,
      label: known?.label ?? id,
      effort: effortValues(known),
    };
  });
  return withSavedModel(
    [{ value: "", label: DEFAULT_MODEL_LABEL, effort: [] }, ...options],
    model,
    effort,
  );
}

/**
 * Pi model rows. The persisted value is `provider/id` so equally named models from different
 * providers stay distinct; reasoning levels come from the endpoint, and a model that reports no
 * reasoning support only offers the default (plus `off` when the endpoint lists it).
 */
export function piModelOptions(
  catalog: PiModelCatalog | null,
  model: string | null,
  effort: string | null,
): ModelSelectOption[] {
  const levels = catalog?.thinkingLevels ?? [];
  const options: ModelSelectOption[] = [
    // Pi may apply effort to its configured default model, so the default row carries the
    // endpoint's thinking levels while DSH still requires an explicit model.
    { value: "", label: DEFAULT_MODEL_LABEL, effort: levels },
    ...(catalog?.models ?? []).map((option) => {
      const value = option.provider + "/" + option.id;
      return {
        value,
        label: value,
        effort: option.reasoning ? levels : levels.filter((level) => level === "off"),
      };
    }),
  ];
  return withSavedModel(options, model, effort);
}

/** Model rows for a draft config of any engine; unavailable catalogs yield only the default. */
export function modelOptionsFor(
  config: { type: WorkerType; model: string | null; effort: string | null },
  catalogs: {
    dsh: DshModelCatalog | null;
    codex: WorkerModelCatalog | null;
    codexProviderModels: string[] | null;
    pi: PiModelCatalog | null;
  },
): ModelSelectOption[] {
  if (config.type === "dsh")
    return dshModelOptions(catalogs.dsh, config.model, config.effort);
  if (config.type === "pi")
    return piModelOptions(catalogs.pi, config.model, config.effort);
  return codexModelOptions(
    catalogs.codex,
    catalogs.codexProviderModels,
    config.model,
    config.effort,
  );
}

/** Effort rows for the selected model; an unsupported stored effort stays selectable. */
export function effortOptionsFor(
  models: ModelSelectOption[],
  model: string | null,
  effort: string | null,
): SelectOption[] {
  const selected = models.find((option) => option.value === (model ?? ""));
  const levels = selected?.effort ?? [];
  const options: SelectOption[] = [
    { value: "", label: DEFAULT_EFFORT_LABEL },
    ...levels.map((level) => ({ value: level, label: level })),
  ];
  if (effort && !levels.includes(effort))
    options.push({ value: effort, label: effort + SAVED_SUFFIX });
  return options;
}
