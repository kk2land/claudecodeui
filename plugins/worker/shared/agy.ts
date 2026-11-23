/**
 * Native reasoning levels accepted by the Google Antigravity CLI's `--effort` flag.
 * These are the values documented by `agy --help`; the CLI remains the final validator.
 */
export const AGY_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
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
