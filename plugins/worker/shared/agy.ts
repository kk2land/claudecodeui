/** Reasoning levels supported by AGY ACP (`thought_level`). */
export const AGY_ACP_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/**
 * Native reasoning levels accepted by the Google Antigravity CLI's `--effort` flag.
 * Includes legacy `max` for historical records; AGY ACP accepts only `AGY_ACP_EFFORT_LEVELS`.
 */
export const AGY_EFFORT_LEVELS = [
  ...AGY_ACP_EFFORT_LEVELS,
  "max",
] as const;

/**
 * Model-id suffixes that `agy models` actually exposes as fixed reasoning variants:
 * `gemini-3.8-flash-low`, `gemini-4-neon-xhigh`, and similar. `max` is not a model suffix in
 * the CLI's directory, so it is deliberately not inferred from a subjectively named model.
 *
 * A matching suffix means the variant is fixed to that effort. Omitting `--effort` remains
 * valid for it. Models without one of these suffixes are left unrestricted: the plugin cannot
 * know whether a custom or catalog model supports effort, so it must not forbid a valid bare-id
 * `--effort` pair.
 */
export const AGY_FIXED_EFFORT_SUFFIXES = ["low", "medium", "high", "xhigh"] as const;

export type AgyFixedEffort = (typeof AGY_FIXED_EFFORT_SUFFIXES)[number];

/** Returns the effort a model id fixes, or null when its effort is not encoded in the id. */
export function agyFixedModelEffort(model: string | null | undefined): AgyFixedEffort | null {
  const value = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (!value) return null;
  for (const level of AGY_FIXED_EFFORT_SUFFIXES)
    if (value.endsWith("-" + level)) return level;
  return null;
}

/**
 * Explains a known model/effort conflict. Only effort variants proven by `agy models` are
 * constrained; an unsuffixed model returns null so the CLI can validate the pair itself.
 */
export function agyEffortConflict(
  model: string | null | undefined,
  effort: string | null | undefined,
): string | null {
  const fixed = agyFixedModelEffort(model);
  if (!fixed || !effort || effort === fixed) return null;
  return (
    "agy 模型 " +
    model +
    " 固定使用 " +
    fixed +
    " reasoning；支持的 effort 为 " +
    fixed +
    " 或留空，当前为 " +
    effort
  );
}

/**
 * The AGY account's two remaining-quota pools. `agy -p /usage` reports both as model groups;
 * every Claude or GPT model shares one pool, and every other valid model id (including the
 * default selection, whose id may not contain "Gemini") shares the Gemini pool.
 */
export const AGY_QUOTA_GROUPS = ["gemini", "claude-gpt"] as const;

export type AgyQuotaGroupKind = (typeof AGY_QUOTA_GROUPS)[number];

/** The quota group names exactly as `agy -p /usage` reports them. */
export const AGY_QUOTA_GROUP_LABELS: Record<AgyQuotaGroupKind, string> = {
  gemini: "Gemini Models",
  "claude-gpt": "Claude and GPT models",
};

/**
 * The model families AGY ships. Only the first segment of the trailing path segment counts, so a
 * vendor prefix (`google/qwen3-coder-480b`) does not decide the family.
 */
export type AgyModelFamily = "gemini" | "claude" | "gpt" | "other";

const AGY_MODEL_FAMILY_PREFIXES = ["gemini", "claude", "gpt"] as const;

/** The family a native AGY model id belongs to; an unset or unknown id is "other". */
export function agyModelFamily(
  model: string | null | undefined,
): AgyModelFamily {
  const value = typeof model === "string" ? model.trim().toLowerCase() : "";
  const id = value.split("/").pop() ?? "";
  for (const family of AGY_MODEL_FAMILY_PREFIXES)
    if (id.startsWith(family)) return family;
  return "other";
}

/**
 * Maps a configured AGY model id to the quota pool it draws from. Only the Claude/GPT families
 * are recognized positively: every other valid id (Qwen, the default selection, an id without
 * "gemini") joins the Gemini pool, matching what `agy -p /usage` reports.
 */
export function agyQuotaGroupForModel(
  model: string | null | undefined,
): AgyQuotaGroupKind {
  const family = agyModelFamily(model);
  return family === "claude" || family === "gpt" ? "claude-gpt" : "gemini";
}

/** Whether an id is a real Gemini-family model, the config's preferred model row. */
export function agyIsGeminiModel(model: string | null | undefined): boolean {
  return agyModelFamily(model) === "gemini";
}

/**
 * Whether an id is a Claude model, the only family a config may keep as its second model:
 * GPT models share that quota pool but are not offered as the fallback option.
 */
export function agyIsClaudeModel(model: string | null | undefined): boolean {
  return agyModelFamily(model) === "claude";
}

/**
 * Maps a `/usage` group name to its quota pool; an unrecognized name yields null so the caller
 * never guesses exhaustion for a group whose name it cannot attribute.
 */
export function agyQuotaGroupFromName(name: string): AgyQuotaGroupKind | null {
  const value = name.trim().toLowerCase();
  if (value.includes("claude") || value.includes("gpt")) return "claude-gpt";
  if (value.includes("gemini")) return "gemini";
  return null;
}
