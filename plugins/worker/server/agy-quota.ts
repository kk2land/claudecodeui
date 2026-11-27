import { execFile } from "node:child_process";
import type { AgyQuotaBucket, AgyQuotaGroup } from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";

/** Fixed CLI arguments for reading AGY account remaining quota without a shell. */
export const AGY_QUOTA_ARGS = ["-p", "/usage", "--output-format", "json"] as const;

/** Bounded timeout for `agy -p /usage --output-format json`. */
export const AGY_QUOTA_TIMEOUT_MS = 30_000;

/** Background refresh interval while the Worker plugin service is running (5 minutes). */
export const AGY_QUOTA_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Server-side parsed quota result produced once at the CLI boundary.
 * Keeps `groups` minimal for UI serialization while passing raw-fraction exhaustion info to
 * `WorkerService` without expanding public API contracts.
 */
export type AgyQuotaParsed = {
  groups: AgyQuotaGroup[];
  /**
   * Non-null when at least one `Gemini Models` limit window has raw `remaining_fraction <= 0`.
   * `latestResetAtMs` holds the latest valid positive `reset_time` among exhausted windows, or
   * null when none carried a valid positive timestamp.
   */
  geminiExhausted: { latestResetAtMs: number | null } | null;
};

function unavailable(message: string): WorkerFailure {
  return new WorkerFailure("AGY_QUOTA_UNAVAILABLE", message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeResetAt(value: unknown): {
  resetAt: string | null;
  resetAtMs: number | null;
} {
  if (typeof value !== "string") return { resetAt: null, resetAtMs: null };
  const trimmed = value.trim();
  if (!trimmed) return { resetAt: null, resetAtMs: null };
  const timestamp = Date.parse(trimmed);
  // `agy` reports `1970-01-01T00:00:00Z` when a bucket is at 100% and has no active countdown.
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { resetAt: null, resetAtMs: null };
  }
  return { resetAt: trimmed, resetAtMs: timestamp };
}

/**
 * Parses the JSON output of `agy -p /usage --output-format json` once at the CLI boundary.
 * Retains only display-needed quota fields in `groups` and evaluates `Gemini Models` window
 * exhaustion directly from raw `remaining_fraction` so positive sub-0.5% values (display `0%`)
 * never trigger a false cooldown.
 */
export function parseAgyQuota(stdout: string): AgyQuotaParsed {
  const trimmed = stdout.trim();
  if (!trimmed) throw unavailable("agy 额度输出为空");
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw unavailable("agy 额度输出无法解析");
  }
  const root = asRecord(raw);
  if (!root) throw unavailable("agy 额度结构无效");
  if (typeof root.status === "string" && root.status !== "SUCCESS") {
    throw unavailable("agy 额度查询未成功");
  }
  const command = asRecord(root.command);
  const data = asRecord(command?.data);
  if (command?.name !== "usage" || !Array.isArray(data?.groups)) {
    throw unavailable("agy 额度结构无效");
  }

  const groups: AgyQuotaGroup[] = [];
  let hasGeminiExhausted = false;
  let latestGeminiResetAtMs: number | null = null;
  for (const rawGroup of data.groups) {
    const group = asRecord(rawGroup);
    const name = typeof group?.name === "string" ? group.name.trim() : "";
    if (!group || !name || !Array.isArray(group.buckets)) {
      throw unavailable("agy 额度分组结构无效");
    }
    const isGeminiModels = name.toLowerCase() === "gemini models";
    const buckets: AgyQuotaBucket[] = [];
    for (const rawBucket of group.buckets) {
      const bucket = asRecord(rawBucket);
      const fraction = bucket?.remaining_fraction;
      if (
        !bucket ||
        typeof fraction !== "number" ||
        !Number.isFinite(fraction)
      ) {
        throw unavailable("agy 额度项结构无效");
      }
      const window = typeof bucket.window === "string" ? bucket.window.trim() : "";
      const label =
        (typeof bucket.name === "string" ? bucket.name.trim() : "") ||
        window ||
        "剩余额度";
      const id =
        (typeof bucket.id === "string" ? bucket.id.trim() : "") ||
        `${name}:${window || label}`;
      const { resetAt, resetAtMs } = normalizeResetAt(bucket.reset_time);
      buckets.push({
        id,
        window,
        label,
        remainingPercent: Math.min(100, Math.max(0, Math.round(fraction * 100))),
        resetAt,
      });
      if (isGeminiModels && fraction <= 0) {
        hasGeminiExhausted = true;
        if (resetAtMs !== null) {
          latestGeminiResetAtMs =
            latestGeminiResetAtMs === null
              ? resetAtMs
              : Math.max(latestGeminiResetAtMs, resetAtMs);
        }
      }
    }
    groups.push({ name, buckets });
  }
  return {
    groups,
    geminiExhausted: hasGeminiExhausted
      ? { latestResetAtMs: latestGeminiResetAtMs }
      : null,
  };
}

/**
 * Executes the resolved `agy` executable with fixed `/usage` JSON arguments in the Worker
 * environment. Stderr and raw stdout are never surfaced to callers.
 */
export function readAgyQuota(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AgyQuotaParsed> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      [...AGY_QUOTA_ARGS],
      {
        env: environment,
        encoding: "utf8",
        timeout: options.timeoutMs ?? AGY_QUOTA_TIMEOUT_MS,
        signal: options.signal,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          const killed =
            Boolean((error as NodeJS.ErrnoException & { killed?: boolean }).killed) ||
            error.name === "AbortError";
          reject(
            unavailable(killed ? "agy 额度查询超时" : "agy 额度查询失败"),
          );
          return;
        }
        try {
          resolve(parseAgyQuota(stdout));
        } catch (failure) {
          reject(failure);
        }
      },
    );
    // Close stdin immediately so `agy -p` never waits for piped stdin EOF.
    child.stdin?.end();
  });
}
