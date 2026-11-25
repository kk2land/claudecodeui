/**
 * AGY-specific ACP translation.
 *
 * AGY's ACP server models one catalog variant (`gemini-4-neon-high`, ...) as two independent
 * config options: `model` holds the base id and `thought_level` holds the reasoning suffix. The
 * shared ACP client validates every `session/set_config_option` echo literally, so a variant id
 * must be requested as its equivalent base + level pair rather than as the raw catalog id.
 *
 * Verified against agy 1.5.16 `session/new` / `session/set_config_option`:
 * - `model` options are base ids, `thought_level` options are low/medium/high/xhigh.
 * - setting `model` to a variant succeeds but echoes the base id, therefore
 *   `planAgyAcpConfig` derives the base synchronously and requests `thought_level` alongside it.
 * - `max` is a legacy `--effort` value with no ACP thought level; it is rejected explicitly
 *   instead of being clamped.
 * - one prompt result carries `usage.{inputTokens,outputTokens,cachedReadTokens,
 *   cachedWriteTokens,totalTokens}` for the run; `totalTokens` is taken verbatim.
 * - agent text streams as `session/update` with `update.sessionUpdate === "agent_message_chunk"`
 *   and a text content block; thought is already folded into that output.
 *
 * `AcpConfigOptionSnapshot` intentionally keeps only the applied value, so this module cannot
 * inspect the live option list. `AGY_ACP_LITERAL_MODEL_IDS` records the ids that AGY's model
 * option list contains even though their id ends with a reasoning word.
 */
import type { AcpParsedStream, ParseAcpEventsOptions } from "./acp.js";
import { parseAcpEvents } from "./acp.js";
import type { AcpConfigOptionRequest, WorkerUsage } from "./shared/index.js";
import {
  AGY_ACP_EFFORT_LEVELS,
  agyEffortConflict,
  agyFixedModelEffort,
} from "../shared/agy.js";

/** Reasoning levels AGY exposes through the ACP `thought_level` config option. */
export const AGY_ACP_THOUGHT_LEVELS = AGY_ACP_EFFORT_LEVELS;

export type AgyAcpThoughtLevel = (typeof AGY_ACP_THOUGHT_LEVELS)[number];

/**
 * Catalog ids that AGY lists as `model` options although they end with a reasoning word.
 * Stripping `-medium` would produce `gpt-oss-120b`, which the ACP server does not offer.
 * Callers that can read the live model option list may pass their own set instead.
 */
export const AGY_ACP_LITERAL_MODEL_IDS: readonly string[] = ["gpt-oss-120b-medium"];

export type AgyAcpSelection = {
  /** Catalog model id persisted on the worker config, for example `gemini-4-neon-high`. */
  model: string | null;
  /** Explicit effort; `max` is not available over ACP. */
  effort: string | null;
};

export type AgyAcpConfigPlan = {
  /** The trimmed catalog id the caller asked for. */
  requestedModel: string | null;
  /** The `model` config value; AGY echoes exactly this base id. */
  model: string | null;
  /** The `thought_level` value to request; null leaves AGY's default untouched. */
  thoughtLevel: AgyAcpThoughtLevel | null;
  /** Requests in protocol order: `model` first, then `thought_level`. */
  configOptions: AcpConfigOptionRequest[];
};

export type AgyAcpPlanOptions = {
  /** Overrides `AGY_ACP_LITERAL_MODEL_IDS` when the caller knows the live option list. */
  literalModelIds?: readonly string[];
};

export type AgyAcpSelectionErrorCode =
  | "AGY_ACP_EFFORT_UNSUPPORTED"
  | "AGY_ACP_EFFORT_CONFLICT";

/** Stable selection error raised before spawning; integrations map `code` to their own failure. */
export class AgyAcpSelectionError extends Error {
  constructor(
    readonly code: AgyAcpSelectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgyAcpSelectionError";
  }
}

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result ? result : null;
}

function isThoughtLevel(value: string): value is AgyAcpThoughtLevel {
  return (AGY_ACP_THOUGHT_LEVELS as readonly string[]).includes(value);
}

/**
 * Converts a persisted AGY model/effort selection into the exact ACP config requests.
 *
 * A suffixed catalog id becomes `model=<base>` plus `thought_level=<suffix>`, so the readback is
 * the real AGY state rather than a silently dropped variant. Unsupported effort, including
 * `max`, and a conflicting model/effort pair fail before the session is opened.
 */
export function planAgyAcpConfig(
  selection: AgyAcpSelection,
  options: AgyAcpPlanOptions = {},
): AgyAcpConfigPlan {
  const model = trimmed(selection.model);
  const effort = trimmed(selection.effort);

  if (effort !== null && !isThoughtLevel(effort)) {
    throw new AgyAcpSelectionError(
      "AGY_ACP_EFFORT_UNSUPPORTED",
      `AGY ACP 不支持 effort=${effort}；可用级别为 ${AGY_ACP_THOUGHT_LEVELS.join(", ")}`,
    );
  }

  if (model === null) {
    return {
      requestedModel: null,
      model: null,
      thoughtLevel: effort,
      configOptions: effort
        ? [{ configId: "thought_level", value: effort, match: "exact" }]
        : [],
    };
  }

  const conflict = agyEffortConflict(model, effort);
  if (conflict) {
    throw new AgyAcpSelectionError("AGY_ACP_EFFORT_CONFLICT", conflict);
  }

  const literal = (options.literalModelIds ?? AGY_ACP_LITERAL_MODEL_IDS).some(
    (id) => id.trim().toLowerCase() === model.toLowerCase(),
  );
  const fixed = literal ? null : agyFixedModelEffort(model);
  const modelValue = fixed
    ? model.slice(0, -(fixed.length + 1))
    : model;
  const thoughtLevel: AgyAcpThoughtLevel | null = fixed ?? effort;

  if (!modelValue) {
    throw new AgyAcpSelectionError(
      "AGY_ACP_EFFORT_CONFLICT",
      `agy 模型 ${model} 去掉固定 reasoning 后缀后为空`,
    );
  }

  const configOptions: AcpConfigOptionRequest[] = [
    { configId: "model", value: modelValue, match: "model" },
  ];
  if (thoughtLevel) {
    configOptions.push({
      configId: "thought_level",
      value: thoughtLevel,
      match: "exact",
    });
  }

  return {
    requestedModel: model,
    model: modelValue,
    thoughtLevel,
    configOptions,
  };
}

/** Stable failure code for AGY's normal end_turn quota-warning message. */
export const AGY_QUOTA_REACHED = "AGY_QUOTA_REACHED";

/**
 * AGY 1.5.16 streams this complete warning as normal assistant text and ends the turn with
 * `end_turn` instead of returning a 429. Keep the match anchored to the whole message so an
 * ordinary answer that merely mentions quota is never reclassified.
 */
const AGY_QUOTA_TEXT =
  /^\s*⚠\s+Individual quota reached\.\s+Please upgrade your subscription to increase your limits\.\s+Resets in [^\n]+\.\s*$/;

export type AgyAcpParsedRun = AcpParsedStream & {
  /** Concatenated `agent_message_chunk` text for the validated session; null when none. */
  finalText: string | null;
  /** Run-scoped usage from the last prompt result; null when the stream reports none. */
  usage: WorkerUsage | null;
};

export type AgyAcpParseOptions = ParseAcpEventsOptions & {
  /** Forces `usage.partial`; defaults to true unless the turn ended with `end_turn`. */
  partial?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads one `usage` object from an ACP prompt result. Known zeros are preserved; absent or
 * invalid counters stay null and mark the usage partial. `totalTokens` is never recomputed.
 */
export function mapAgyAcpUsage(raw: unknown, partial = false): WorkerUsage | null {
  const record = asRecord(raw);
  if (!record) return null;

  const counter = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;

  const inputTokens = counter(record.inputTokens);
  const outputTokens = counter(record.outputTokens);
  const totalTokens = counter(record.totalTokens);
  const cacheReadTokens = counter(record.cachedReadTokens);
  const cacheWriteTokens = counter(record.cachedWriteTokens);

  if (
    inputTokens === null &&
    outputTokens === null &&
    totalTokens === null &&
    cacheReadTokens === null &&
    cacheWriteTokens === null
  ) {
    return null;
  }

  const usage: WorkerUsage = {
    inputTokens,
    outputTokens,
    totalTokens,
    scope: "run",
    partial:
      partial ||
      inputTokens === null ||
      outputTokens === null ||
      totalTokens === null,
  };
  if (cacheReadTokens !== null) usage.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== null) usage.cacheWriteTokens = cacheWriteTokens;
  return usage;
}

/** Extracts text from one `acp_update` payload when it is an agent message chunk. */
function agentMessageChunkText(update: unknown): string | null {
  const record = asRecord(update);
  if (!record || record.sessionUpdate !== "agent_message_chunk") return null;
  const content = asRecord(record.content);
  if (!content || content.type !== "text" || typeof content.text !== "string") {
    return null;
  }
  return content.text;
}

/**
 * Validates one AGY ACP run with the shared parser (identity, cwd, config echo, stop reason)
 * and adds the two AGY-specific projections: streamed agent text and run usage.
 */
export function parseAgyAcpRun(
  entries: Array<{ value: unknown; number: number }>,
  expectedSessionId: string | null,
  expectedCwd: string,
  options: AgyAcpParseOptions = {},
): AgyAcpParsedRun {
  const parsed = parseAcpEvents(entries, expectedSessionId, expectedCwd, options);
  const sessionId = parsed.validatedSessionId ?? parsed.sessionId;

  const chunks: string[] = [];
  let rawUsage: unknown = null;
  for (const { value } of entries) {
    const event = asRecord(value);
    if (!event || event.protocol !== "acp" || typeof event.type !== "string") {
      continue;
    }
    if (
      event.type === "acp_update" &&
      sessionId !== null &&
      event.sessionId === sessionId
    ) {
      const text = agentMessageChunkText(event.update);
      if (text !== null) chunks.push(text);
    } else if (
      event.type === "acp_prompt_result" &&
      (sessionId === null || event.sessionId === sessionId)
    ) {
      const result = asRecord(event.result);
      rawUsage = result?.usage ?? null;
    }
  }

  const partial =
    options.partial ?? (!parsed.success || parsed.stopReason !== "end_turn");
  const finalText = chunks.length > 0 ? chunks.join("") : null;
  const quota = parsed.success && finalText !== null && AGY_QUOTA_TEXT.test(finalText);

  return {
    ...parsed,
    // The validated session remains intact so a quota-failed run can still be resumed later.
    ...(quota
      ? {
          success: false,
          errorCode: AGY_QUOTA_REACHED,
          error: finalText.trim(),
        }
      : {}),
    finalText,
    usage: mapAgyAcpUsage(rawUsage, partial),
  };
}
