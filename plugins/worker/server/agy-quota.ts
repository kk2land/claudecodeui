import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  AGY_QUOTA_GROUP_LABELS,
  AGY_QUOTA_GROUPS,
  agyEffortConflict,
  agyQuotaGroupForModel,
  agyQuotaGroupFromName,
} from "../shared/agy.js";
import type { AgyQuotaGroupKind } from "../shared/agy.js";
import type {
  AgyQuotaBucket,
  AgyQuotaCooldown,
  AgyQuotaGroup,
} from "./shared/index.js";
import { WorkerFailure } from "./shared/index.js";
import { AGY_QUOTA_REACHED } from "./agy-acp.js";

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
   * One entry per quota pool with at least one window whose raw `remaining_fraction <= 0`. A pool
   * absent from this record is not known to be exhausted. `latestResetAtMs` holds the latest
   * valid positive `reset_time` among that pool's exhausted windows (both windows must recover),
   * or null when none carried a valid positive timestamp. Group names this module cannot
   * attribute to a pool never appear here.
   */
  exhausted: Partial<
    Record<AgyQuotaGroupKind, { latestResetAtMs: number | null }>
  >;
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
 * Retains only display-needed quota fields in `groups` and evaluates each known pool's window
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
  const exhausted: AgyQuotaParsed["exhausted"] = {};
  for (const rawGroup of data.groups) {
    const group = asRecord(rawGroup);
    const name = typeof group?.name === "string" ? group.name.trim() : "";
    if (!group || !name || !Array.isArray(group.buckets)) {
      throw unavailable("agy 额度分组结构无效");
    }
    const kind = agyQuotaGroupFromName(name);
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
      if (kind !== null && fraction <= 0) {
        const known = exhausted[kind] ?? { latestResetAtMs: null };
        if (
          resetAtMs !== null &&
          (known.latestResetAtMs === null || resetAtMs > known.latestResetAtMs)
        ) {
          known.latestResetAtMs = resetAtMs;
        }
        exhausted[kind] = known;
      }
    }
    groups.push({ name, buckets });
  }
  return { groups, exhausted };
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

//------------------ POOL COOLDOWNS AND START SELECTION ----------------

/** Fallback cooldown for a limit that carried no reset hint. */
export const AGY_COOLDOWN_FALLBACK_MS = 60_000;

/** Cooldown rows the AGY pools read and write; `WorkerStore` already has this shape. */
export type AgyCooldownStore = {
  cooldown(engine: string): number | null;
  setCooldown(engine: string, until: number): number;
};

/** The pre-pool row key; it stays a fallback block for pools whose quota is still unknown. */
const LEGACY_COOLDOWN_KEY = "agy";

function poolKey(group: AgyQuotaGroupKind): string {
  return "agy:" + group;
}

/** What the last successful `/usage` read knows about one pool. */
export type AgyPoolStatus = "available" | "exhausted" | "unknown";

/** Per-pool knowledge from one `/usage` result; a pool the CLI did not report stays unknown. */
export function agyPoolStatuses(
  parsed: AgyQuotaParsed,
): Record<AgyQuotaGroupKind, AgyPoolStatus> {
  const statuses: Record<AgyQuotaGroupKind, AgyPoolStatus> = {
    gemini: "unknown",
    "claude-gpt": "unknown",
  };
  for (const group of parsed.groups) {
    const kind = agyQuotaGroupFromName(group.name);
    if (kind === null || !group.buckets.length) continue;
    statuses[kind] = parsed.exhausted[kind] ? "exhausted" : "available";
  }
  return statuses;
}

/** Everything the pool rules read: cooldown rows, the service clock, and per-pool knowledge. */
export type AgyLimitContext = {
  store: AgyCooldownStore;
  now: number;
  statuses: Record<AgyQuotaGroupKind, AgyPoolStatus>;
};

/**
 * Active deadline (epoch ms) for one pool, or null when it may start now. The pool's own row
 * always applies; the pre-pool global row holds back only a pool whose quota is still unknown, so
 * a legacy value from an unattributable source never overrides fresh per-pool data — including a
 * pool that reported exhaustion and has since passed its own reset.
 */
export function agyPoolDeadline(
  context: AgyLimitContext,
  group: AgyQuotaGroupKind,
): number | null {
  const { store, now } = context;
  const pool = store.cooldown(poolKey(group));
  if (pool !== null && pool > now) return pool;
  if (context.statuses[group] !== "unknown") return null;
  const legacy = store.cooldown(LEGACY_COOLDOWN_KEY);
  return legacy !== null && legacy > now ? legacy : null;
}

/** Active pool cooldowns as ISO deadlines, earliest first, for the overview snapshot. */
export function agyPoolCooldowns(context: AgyLimitContext): AgyQuotaCooldown[] {
  const active: AgyQuotaCooldown[] = [];
  for (const group of AGY_QUOTA_GROUPS) {
    const until = agyPoolDeadline(context, group);
    if (until !== null)
      active.push({ group, until: new Date(until).toISOString() });
  }
  return active.sort(
    (left, right) => Date.parse(left.until) - Date.parse(right.until),
  );
}

/** Earliest active pool deadline, or null when no pool is held back. */
export function agyEarliestDeadline(context: AgyLimitContext): number | null {
  let earliest: number | null = null;
  for (const group of AGY_QUOTA_GROUPS) {
    const until = agyPoolDeadline(context, group);
    if (until !== null && (earliest === null || until < earliest))
      earliest = until;
  }
  return earliest;
}

/** Stores one pool's deadline without shortening a longer active one. */
export function applyAgyPoolCooldown(
  store: AgyCooldownStore,
  group: AgyQuotaGroupKind,
  until: number,
): void {
  store.setCooldown(poolKey(group), until);
}

/**
 * Applies a fresh `/usage` read to the pool rows and reports whether any pool was held back, so
 * the caller only has to re-arm its wake-up timer.
 */
export function applyAgyQuota(
  store: AgyCooldownStore,
  parsed: AgyQuotaParsed,
  now: number,
): boolean {
  let applied = false;
  for (const group of AGY_QUOTA_GROUPS) {
    const state = parsed.exhausted[group];
    if (!state) continue;
    const reset = state.latestResetAtMs;
    applyAgyPoolCooldown(
      store,
      group,
      reset !== null && reset > now ? reset : now + AGY_COOLDOWN_FALLBACK_MS,
    );
    applied = true;
  }
  return applied;
}

/** One pool's judgement for a start decision. */
export type AgyBlockedPool = {
  group: AgyQuotaGroupKind;
  until: number | null;
};

/** Model to run now, its pool, and the pools that block the request when none is usable. */
export type AgyStartPlan = {
  model: string | null;
  group: AgyQuotaGroupKind;
  /** Null when this plan may start; otherwise the earliest deadline among its blocked pools. */
  blockedUntil: number | null;
  blocked: AgyBlockedPool[];
};

/**
 * Models a fresh start of this config may use: its own model, then the Claude fallback the user
 * configured for it. An unset model means "the runner default", a real choice; a config without a
 * fallback is never widened to a model the user did not pick.
 */
export function agyStartCandidates(config: {
  model: string | null;
  agy?: { fallbackModel: string | null };
}): Array<string | null> {
  const model = config.model ?? null;
  const fallback = config.agy?.fallbackModel ?? null;
  if (fallback === null || fallback === model) return [model];
  return [model, fallback];
}

/**
 * Resume keeps the run's recorded model. Only when that id is one of this config's models may the
 * other pool stand in; an explicit or historical id outside the config stays bound to itself.
 */
export function agyResumeCandidates(
  config: { model: string | null; agy?: { fallbackModel: string | null } },
  previousModel: string | null,
): Array<string | null> {
  if (previousModel === null) return [null];
  const candidates = agyStartCandidates(config);
  return candidates.includes(previousModel)
    ? [previousModel, ...candidates.filter((item) => item !== previousModel)]
    : [previousModel];
}

/**
 * The other pool's model a queued run may switch to while it waits. An explicit model request
 * stays bound to that model, so it records no fallback.
 */
export function agyFallbackForRun(
  candidates: Array<string | null>,
  model: string | null,
  requestedModel: string | null,
  effort: string | null = null,
): string | null {
  if (requestedModel !== null) return null;
  return (
    agyEffortCandidates(candidates, effort).find(
      (item) => item !== null && item !== model,
    ) ?? null
  );
}

/**
 * Drops a candidate whose id fixes a reasoning level other than the requested effort: switching
 * to it would fail the ACP validation instead of using a pool that can honour the request. The
 * first candidate always survives so a genuine conflict still surfaces as its own error.
 */
export function agyEffortCandidates(
  candidates: Array<string | null>,
  effort: string | null,
): Array<string | null> {
  if (effort === null) return candidates;
  const usable = candidates.filter(
    (model) => model === null || agyEffortConflict(model, effort) === null,
  );
  return usable.length ? usable : candidates.slice(0, 1);
}

/**
 * Picks the first candidate whose pool is not cooling down. A requested model is the only
 * candidate, so an explicit choice is never rerouted to another pool or another model.
 */
export function planAgyStart(
  context: AgyLimitContext,
  options: {
    candidates: Array<string | null>;
    requestedModel?: string | null;
    /** The effort the run will use; a model that fixes a different level is not a candidate. */
    effort?: string | null;
  },
): AgyStartPlan {
  const requested = options.requestedModel ?? null;
  const candidates: Array<string | null> = [];
  for (const model of agyEffortCandidates(
    requested === null ? options.candidates : [requested],
    options.effort ?? null,
  ))
    if (!candidates.includes(model)) candidates.push(model);
  const blocked: AgyBlockedPool[] = [];
  for (const model of candidates) {
    const group = agyQuotaGroupForModel(model);
    const until = agyPoolDeadline(context, group);
    if (until === null)
      return { model, group, blockedUntil: null, blocked };
    if (!blocked.some((item) => item.group === group))
      blocked.push({ group, until });
  }
  const deadlines = blocked
    .map((item) => item.until)
    .filter((until): until is number => until !== null);
  return {
    model: candidates[0] ?? null,
    group: agyQuotaGroupForModel(candidates[0] ?? null),
    blockedUntil: deadlines.length ? Math.min(...deadlines) : null,
    blocked,
  };
}

/** Models an admitted run may still launch with: the one it recorded, then a recorded fallback. */
export function agyRunCandidates(run: {
  model: string | null;
  agyFallbackModel?: string | null;
}): Array<string | null> {
  const fallback = run.agyFallbackModel ?? null;
  if (fallback === null || fallback === run.model) return [run.model];
  return [run.model, fallback];
}

/** Model a queued run may launch with now, or the deadline that still holds it back. */
export function planAgyDispatch(
  context: AgyLimitContext,
  run: { model: string | null; effort: string | null; agyFallbackModel?: string | null },
): AgyStartPlan {
  return planAgyStart(context, {
    candidates: agyRunCandidates(run),
    effort: run.effort,
  });
}

/** Stable, retryable quota error naming every blocked pool and the deadline it knows. */
export function agyQuotaFailure(blocked: AgyBlockedPool[]): WorkerFailure {
  const parts = poolsOf(blocked).map(({ group, until }) =>
    until === null
      ? AGY_QUOTA_GROUP_LABELS[group]
      : AGY_QUOTA_GROUP_LABELS[group] +
        "（" +
        new Date(until).toISOString() +
        " 后恢复）",
  );
  return new WorkerFailure(
    AGY_QUOTA_REACHED,
    "AGY 额度已用尽：" + parts.join("、") + "；额度恢复后可重试",
  );
}

/** One entry per pool, earliest deadline kept, so several candidates cannot repeat a pool. */
function poolsOf(blocked: AgyBlockedPool[]): AgyBlockedPool[] {
  const pools: AgyBlockedPool[] = [];
  for (const item of blocked) {
    const known = pools.find((pool) => pool.group === item.group);
    if (!known) {
      pools.push({ ...item });
      continue;
    }
    if (item.until !== null && (known.until === null || item.until < known.until))
      known.until = item.until;
  }
  return pools;
}

/**
 * agy reports rate limiting either as a stderr `AGY_ERROR` object with `error_code: 429` or as a
 * structured failure result whose status is `RESOURCE_EXHAUSTED` with `code: 429`.
 */
export function agyRateLimited(text: string): boolean {
  if (
    text
      .split("\n")
      .some(
        (line) =>
          line.includes("AGY_ERROR") &&
          /"error_code"\s*:\s*"?429"?(?!\d)/.test(line),
      )
  )
    return true;
  return (
    text.includes("RESOURCE_EXHAUSTED") &&
    /\bcode"?\s*[:=]?\s*\(?\s*"?429"?(?!\d)/i.test(text)
  );
}

/** Reads `Resets in 2h2m18s` (or a colon duration) into milliseconds. */
export function agyResetDelay(text: string): number | null {
  const match = /resets?\s+in\s+([^\n,;]+)/i.exec(text);
  if (!match) return null;
  // Evidence may repeat the same error message (event + final evidence) on one JSON line;
  // only the first reset phrase describes this failure.
  const value = match[1]!.split(/resets?\s+in/i)[0]!;
  const colon = /(\d+):(\d+):(\d+)/.exec(value);
  if (colon)
    return (
      (Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3])) *
      1000
    );
  let seconds = 0;
  let found = false;
  const unit = /(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)/gi;
  for (let part = unit.exec(value); part; part = unit.exec(value)) {
    found = true;
    const amount = Number(part[1]);
    const scale = part[2]!.toLowerCase();
    if (scale.startsWith("h")) seconds += amount * 3600;
    else if (scale.startsWith("m")) seconds += amount * 60;
    else seconds += amount;
  }
  return found && seconds > 0 ? seconds * 1000 : null;
}

/** Reads a finished run's retained streams; a missing stream is not rate-limit evidence. */
export function readAgyFailureText(directory: string): string {
  let text = "";
  for (const name of ["stderr.log", "events.log", "final.json"]) {
    try {
      text +=
        "\n" + fs.readFileSync(path.join(directory, name), "utf8").slice(-200_000);
    } catch {
      /* a missing stream is not rate-limit evidence */
    }
  }
  return text;
}

/**
 * Extends the failed run's own pool deadline from a classified quota message or from the run's
 * streams. Returns the applied pool and deadline, or null when the run carries no limit evidence.
 */
export function registerAgyFailure(input: {
  store: AgyCooldownStore;
  now: number;
  model: string | null;
  /** A classified `AGY_QUOTA_REACHED` message, or the run's retained evidence. */
  text: string;
  classified: boolean;
}): { group: AgyQuotaGroupKind; until: number } | null {
  if (!input.classified && !agyRateLimited(input.text)) return null;
  const delay = agyResetDelay(input.text) ?? AGY_COOLDOWN_FALLBACK_MS;
  const group = agyQuotaGroupForModel(input.model);
  const until = input.now + delay;
  applyAgyPoolCooldown(input.store, group, until);
  return { group, until };
}
